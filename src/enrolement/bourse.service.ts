import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeightRule,
  Packer,
  PageOrientation,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  VerticalMergeType,
  WidthType,
} from 'docx';
import ExcelJS from 'exceljs';
import { DataSource, In, LessThan, Not, Repository } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { IndexNoms } from '../common/index-noms';
import { montantArrete } from '../common/lettres';
import {
  ajouterMois,
  ecartMois,
  MOIS_RE,
  moisDe,
  moisEnClair,
} from '../common/mois';
import { ageRevolu } from '../common/texte';
import { JournalService } from '../core/core.service';
import {
  Agent,
  AncienRecrute,
  Departement,
  EtatBourse,
  LigneBourse,
  Regularisation,
  Volontaire,
} from '../entities';
import {
  ConfigEnrolementService,
  type ConfigEnrolement,
} from './configuration';

/** 50000 → « 50.000 » (comme dans les états signés). */
/**
 * Police des documents de la bourse (13/11/2026) : la police actuelle (celle des modèles du DG)
 * ou « Gill Sans MT », au choix de l'utilisateur au moment de télécharger ou d'imprimer.
 */
export type PoliceDocument = 'actuelle' | 'gill';
export const policeDocument = (v: unknown): PoliceDocument =>
  v === 'gill' ? 'gill' : 'actuelle';
/** Orientation des états en Word et en PDF (13/11/2026) : paysage (habituel) ou portrait. */
export type OrientationDocument = 'paysage' | 'portrait';
export const orientationDocument = (v: unknown): OrientationDocument =>
  v === 'portrait' ? 'portrait' : 'paysage';
const GILL = 'Gill Sans MT';
/** Passe tout le classeur en Gill Sans MT (le « Gill Sans MT Condensed » du DG reste tel quel). */
const appliquerPolice = (wb: ExcelJS.Workbook, police: PoliceDocument) => {
  if (police !== 'gill') return;
  for (const ws of wb.worksheets)
    ws.eachRow({ includeEmpty: true }, (row) =>
      row.eachCell({ includeEmpty: true }, (cell) => {
        if (cell.font?.name?.startsWith(GILL)) return;
        cell.font = { ...(cell.font ?? {}), name: GILL };
      }),
    );
};

/** « Septembre 2026 » : le mois avec sa majuscule, comme dans les noms des fichiers du DG. */
const moisMajuscule = (mois: string) => {
  const s = moisEnClair(mois);
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const fcfa = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

export type Gravite = 'BLOQUANT' | 'SIGNALE';

export interface Anomalie {
  code: string;
  gravite: Gravite;
  volontaireId: string;
  nomComplet: string;
  message: string;
  /** Doublon, payé sur l'autre liste : l'autre fiche, pour les comparer et choisir (DG, 28/10/2026). */
  autreId?: string;
}

/** Libellés des contrôles (affichés dans l'état et dans la fiche). */
export const CONTROLES: Record<string, { libelle: string; gravite: Gravite }> =
  {
    DOUBLON: { libelle: 'Inscrit deux fois', gravite: 'BLOQUANT' },
    AUTRE_LISTE: {
      libelle: 'Payé aussi sur l’autre liste (volontaires et communautaires)',
      gravite: 'BLOQUANT',
    },
    MONTANT: {
      libelle: 'Montant de la catégorie non fixé',
      gravite: 'BLOQUANT',
    },
    RECRUTE_FP: {
      libelle: 'Déjà recruté à la Fonction Publique',
      gravite: 'BLOQUANT',
    },
    CATEGORIE: { libelle: 'Catégorie de bourse inconnue', gravite: 'BLOQUANT' },
    DEPARTEMENT: { libelle: 'Département inconnu', gravite: 'BLOQUANT' },
    DEBUT: { libelle: 'Premier mois de bourse inconnu', gravite: 'BLOQUANT' },
    EN_RECRUTEMENT: {
      libelle: 'Présent dans la base des recrutés',
      gravite: 'SIGNALE',
    },
    TEXTE_FP: {
      libelle:
        'Texte de la FP reçu : bourse maintenue jusqu’au premier salaire',
      gravite: 'SIGNALE',
    },
    TELEPHONE: { libelle: 'Téléphone partagé', gravite: 'SIGNALE' },
    AGE: { libelle: 'Âge improbable', gravite: 'SIGNALE' },
    DUREE: { libelle: 'Durée du volontariat dépassée', gravite: 'SIGNALE' },
    RAPPEL: { libelle: 'Rappel de mois non payés', gravite: 'SIGNALE' },
  };

/** Les deux listes payées chaque mois. */
export const LISTES: Record<string, string> = {
  VOLONTAIRE: 'volontaires',
  COMMUNAUTAIRE: 'communautaires',
};
export const populationDe = (p: unknown) =>
  p === 'COMMUNAUTAIRE' ? 'COMMUNAUTAIRE' : 'VOLONTAIRE';

interface Calcul {
  v: Volontaire;
  /** Mois couverts par la ligne (vides : ligne de régularisation seule). */
  du: string | null;
  au: string | null;
  /** Régularisations imputées (compléments +, retenues −). */
  regs: { id: number; montant: number; libelle: string }[];
  /** Mois payés dans cet état (le mois de l'état et les rappels). */
  nbMois: number;
  montant: number;
  observation: string | null;
}

/**
 * Les feuilles par département de l'état de paiement des communautaires, comme celles du cabinet
 * (« ETATS DE PAIEMENT DES ENSEIGNANTS COMMUNAUTAIRES SEPTEMBRE 2026 » : « ETAT DE PAIEMENT
 * BOUENZA », « … BZV », « … CUVETTE » avec le Congo-Oubangui, « … PLATEAUX-NKENI », « … PN »…).
 */
const FEUILLES_COMMUNAUTAIRES: {
  feuille: string;
  titre: string;
  codes: string[];
}[] = [
  {
    feuille: 'BOUENZA',
    titre: 'DÉPARTEMENT DE LA BOUENZA',
    codes: ['BOUENZA'],
  },
  {
    feuille: 'BZV',
    titre: 'DÉPARTEMENT DE BRAZZAVILLE',
    codes: ['BRAZZAVILLE'],
  },
  {
    feuille: 'CUVETTE',
    titre: 'DÉPARTEMENTS : CUVETTE/CONGO-OUBANGUI',
    codes: ['CUVETTE', 'CONGO_OUBANGUI'],
  },
  {
    feuille: 'CUVETTE-OUEST',
    titre: 'DÉPARTEMENT DE LA CUVETTE-OUEST',
    codes: ['CUVETTE_OUEST'],
  },
  {
    feuille: 'DJOUE-LEFINI',
    titre: 'DÉPARTEMENT : DJOUÉ-LÉFINI',
    codes: ['DJOUE_LEFINI'],
  },
  { feuille: 'KOUILOU', titre: 'DÉPARTEMENT DU KOUILOU', codes: ['KOUILOU'] },
  {
    feuille: 'LEKOUMOU',
    titre: 'DÉPARTEMENT DE LA LÉKOUMOU',
    codes: ['LEKOUMOU'],
  },
  {
    feuille: 'LIKOUALA',
    titre: 'DÉPARTEMENTS : LIKOUALA/CONGO-OUBANGUI',
    codes: ['LIKOUALA'],
  },
  { feuille: 'NIARI', titre: 'DÉPARTEMENT DU NIARI', codes: ['NIARI'] },
  {
    feuille: 'PLATEAUX-NKENI',
    titre: 'DÉPARTEMENTS : PLATEAUX/NKÉNI-ALIMA',
    codes: ['PLATEAUX', 'NKENI_ALIMA'],
  },
  {
    feuille: 'PN',
    titre: 'DÉPARTEMENT DE POINTE-NOIRE',
    codes: ['POINTE_NOIRE'],
  },
  { feuille: 'POOL', titre: 'DÉPARTEMENT DU POOL', codes: ['POOL'] },
  { feuille: 'SANGHA', titre: 'DÉPARTEMENT DE LA SANGHA', codes: ['SANGHA'] },
];

@Injectable()
export class BourseService {
  constructor(
    private readonly ds: DataSource,
    @InjectRepository(EtatBourse)
    private readonly etats: Repository<EtatBourse>,
    @InjectRepository(LigneBourse)
    private readonly lignes: Repository<LigneBourse>,
    @InjectRepository(Volontaire)
    private readonly volontaires: Repository<Volontaire>,
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
    @InjectRepository(AncienRecrute)
    private readonly anciens: Repository<AncienRecrute>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    @InjectRepository(Regularisation)
    private readonly regs: Repository<Regularisation>,
    private readonly config: ConfigEnrolementService,
    private readonly journal: JournalService,
  ) {}

  /* ------------------------------- Règles ------------------------------- */

  /** Premier mois payé : celui de la fiche, sinon la règle de la configuration. */
  static premierMois(v: Volontaire, c: ConfigEnrolement): string | null {
    if (v.premierMois) return v.premierMois;
    const note = moisDe(v.dateNote);
    const ps = moisDe(v.datePriseService);
    switch (c.debutBourse) {
      case 'MOIS_NOTE':
        return note;
      case 'MOIS_SUIVANT_NOTE':
        return note ? ajouterMois(note, 1) : null;
      case 'MOIS_PRISE_SERVICE':
        return ps;
      case 'MOIS_SUIVANT_PRISE_SERVICE':
        return ps ? ajouterMois(ps, 1) : null;
    }
  }

  /** Dernier mois payé (null : sans fin), d'après le motif de sortie et la durée maximale. */
  static dernierMois(
    v: Volontaire,
    c: ConfigEnrolement,
    debut: string | null,
  ): string | null {
    let fin: string | null = null;
    if (v.statut === 'SORTI') {
      const motif = c.motifsSortie.find((x) => x.code === v.motifSortie);
      if (!motif || motif.arreteBourse) {
        const sortie = moisDe(v.dateSortie);
        // Sortie sans date : la bourse est arrêtée (on ne paie pas « au hasard »)
        if (!sortie) return '0000-01';
        fin =
          motif?.dernierMoisPaye === 'MOIS_DE_SORTIE'
            ? sortie
            : ajouterMois(sortie, -1);
      }
    }
    if (debut && c.dureeMaxMois > 0 && c.depassementDuree === 'ARRETER') {
      const finDuree = ajouterMois(debut, c.dureeMaxMois - 1);
      if (!fin || finDuree < fin) fin = finDuree;
    }
    return fin;
  }

  /* ------------------------------ Lecture ------------------------------ */

  async liste(population?: string) {
    return this.etats.find({
      where: population ? { population: populationDe(population) } : {},
      order: { mois: 'DESC' },
    });
  }

  async detail(
    id: number,
    f: {
      recherche?: string;
      departementId?: number;
      categorie?: string;
      page?: number;
      taille?: number;
    },
  ) {
    const etat = await this.etats.findOne({ where: { id } });
    if (!etat) throw new NotFoundException('État de bourse introuvable');
    const taille = Math.min(Math.max(f.taille ?? 50, 1), 500);
    const page = Math.max(f.page ?? 1, 1);
    const q = this.lignes
      .createQueryBuilder('l')
      .where('l.etatId = :id', { id });
    if (f.recherche?.trim())
      q.andWhere('l.nomComplet ILIKE :r', {
        r: `%${f.recherche.trim().replace(/[\\%_]/g, '\\$&')}%`,
      });
    if (f.departementId)
      q.andWhere('l.departementId = :d', { d: f.departementId });
    if (f.categorie) q.andWhere('l.categorie = :c', { c: f.categorie });
    const [lignes, total] = await q
      .orderBy('l.departementId', 'ASC', 'NULLS LAST')
      .addOrderBy('l.nomComplet', 'ASC')
      .skip((page - 1) * taille)
      .take(taille)
      .getManyAndCount();
    const resume = await this.lignes.query<
      {
        departementId: number | null;
        categorie: string | null;
        effectif: number;
        total: string;
        rappels: number;
      }[]
    >(
      `SELECT "departementId", categorie, count(*)::int AS effectif, sum(total)::bigint AS total,
              count(*) FILTER (WHERE mois > 1)::int AS rappels
         FROM ligne_bourse WHERE "etatId" = $1 GROUP BY 1, 2 ORDER BY 1, 2`,
      [id],
    );
    return { etat, lignes, total, page, taille, resume, controles: CONTROLES };
  }

  /* ------------------------------ Calcul ------------------------------ */

  /** Prépare (ou recalcule) l'état d'un mois : qui est payé, combien, et les contrôles. */
  async preparer(u: UtilisateurConnecte, mois: string, pop?: string) {
    if (!MOIS_RE.test(mois ?? ''))
      throw new BadRequestException('Mois attendu (AAAA-MM).');
    const population = populationDe(pop);
    const liste = LISTES[population];
    let etat = await this.etats.findOne({ where: { mois, population } });
    if (etat?.statut === 'VALIDE')
      throw new BadRequestException(
        `L’état de ${moisEnClair(mois)} (${liste}) est validé : le DG doit le rouvrir avant tout nouveau calcul.`,
      );
    const plusRecent = await this.etats.findOne({
      where: { statut: 'VALIDE', population },
      order: { mois: 'DESC' },
    });
    if (plusRecent && plusRecent.mois > mois)
      throw new BadRequestException(
        `L’état de ${moisEnClair(plusRecent.mois)} est déjà validé : ${moisEnClair(mois)} y a été payé en rappel s’il était dû.`,
      );
    const c = this.config.get();
    const categories = this.config.categoriesDe(population);
    const tous = await this.volontaires.find({ where: { population } });

    // Mois déjà payés par des états validés (pour les rappels)
    const payes = new Map<string, string>();
    for (const r of await this.lignes.query<{ v: string; m: string }[]>(
      `SELECT l."volontaireId" AS v, max(coalesce(l.au, e.mois)) AS m
         FROM ligne_bourse l JOIN etat_bourse e ON e.id = l."etatId"
        WHERE e.statut = 'VALIDE' AND e.mois < $1 AND e.population = $2 GROUP BY 1`,
      [mois, population],
    ))
      payes.set(r.v, r.m);
    // Avant le premier état validé, le système ne sait pas ce qui a été payé : pas de rappel
    const [{ premier }] = await this.etats.query<{ premier: string | null }[]>(
      `SELECT min(mois) AS premier FROM etat_bourse WHERE statut = 'VALIDE' AND population = $1`,
      [population],
    );
    const debutSysteme = premier && premier < mois ? premier : mois;

    const anomalies: Anomalie[] = [];
    const signaler = (
      v: Volontaire,
      code: string,
      message: string,
      autreId?: string,
    ) => {
      if (v.verifications?.[code]) return; // vérifié à la main
      anomalies.push({
        code,
        gravite: CONTROLES[code].gravite,
        volontaireId: v.id,
        nomComplet: v.nomComplet,
        message,
        ...(autreId ? { autreId } : {}),
      });
    };

    const calculs: Calcul[] = [];
    for (const v of tous) {
      const debut = BourseService.premierMois(v, c);
      if (!debut) {
        if (v.statut === 'EN_POSTE')
          signaler(
            v,
            'DEBUT',
            'Ni premier mois, ni date de note ou de prise de service : la bourse ne peut pas être calculée.',
          );
        continue;
      }
      const fin = BourseService.dernierMois(v, c, debut);
      if (debut > mois) continue;
      // Mois dus : du premier mois non payé jusqu'au mois de l'état, ou jusqu'au dernier
      // mois payable d'un sortant (un mois dû avant sa sortie lui reste dû en rappel)
      const jusqua = fin && fin < mois ? fin : mois;
      const dejaPaye = payes.get(v.id);
      let depuis = dejaPaye ? ajouterMois(dejaPaye, 1) : debut;
      if (depuis < debutSysteme) depuis = debutSysteme;
      if (depuis < debut) depuis = debut;
      if (depuis > jusqua) continue;
      const nbMois = ecartMois(depuis, jusqua) + 1;
      const cat = categories.find((x) => x.code === v.categorie && x.actif);
      calculs.push({
        v,
        du: depuis,
        au: jusqua,
        regs: [],
        nbMois,
        montant: cat?.bourse ?? 0,
        observation:
          jusqua < mois
            ? `Dû avant la fin de sa bourse : ${nbMois > 1 ? `${moisEnClair(depuis)} à ` : ''}${moisEnClair(jusqua)}`
            : nbMois > 1
              ? `Rappel : ${moisEnClair(depuis)} à ${moisEnClair(mois)}`
              : null,
      });
      if (!cat)
        signaler(
          v,
          'CATEGORIE',
          `Catégorie « ${v.categorie ?? v.cycleBrut ?? 'vide'} » inconnue ou désactivée : choisissez-la dans la fiche.`,
        );
      else if (!cat.bourse)
        signaler(
          v,
          'MONTANT',
          `Le montant mensuel « ${cat.libelle} » des ${liste} n’est pas encore fixé (Enrôlement › Configuration).`,
        );
      if (!v.departementId)
        signaler(
          v,
          'DEPARTEMENT',
          `Département « ${v.departementBrut ?? 'vide'} » non reconnu : corrigez la fiche.`,
        );
      if (nbMois > 1 || jusqua < mois)
        signaler(
          v,
          'RAPPEL',
          `${nbMois} mois payés (${moisEnClair(depuis)} à ${moisEnClair(jusqua)}).`,
        );
      if (
        c.dureeMaxMois > 0 &&
        ecartMois(debut, mois) + 1 > c.dureeMaxMois &&
        c.depassementDuree === 'SIGNALER'
      )
        signaler(
          v,
          'DUREE',
          `Volontaire depuis ${moisEnClair(debut)} : plus de ${c.dureeMaxMois} mois.`,
        );
      if (v.dateNaissance) {
        const age = ageRevolu(v.dateNaissance, `${mois}-01`);
        const [ageMin, ageMax] =
          population === 'COMMUNAUTAIRE'
            ? [c.ageMinimumCommunautaires, c.ageMaximumCommunautaires]
            : [c.ageMinimum, c.ageMaximum];
        if (age < ageMin || age > ageMax)
          signaler(v, 'AGE', `${age} ans (limites ${ageMin}–${ageMax}).`);
      }
    }

    // Doublons parmi les payés
    const index = new IndexNoms<Calcul>();
    for (const x of calculs) {
      for (const autre of index.probables(x.v.nomComplet, x.v.dateNaissance)) {
        signaler(
          x.v,
          'DOUBLON',
          `Même personne probable que ${autre.v.nomComplet} (${autre.v.etablissement ?? 'établissement inconnu'}).`,
          autre.v.id,
        );
        signaler(
          autre.v,
          'DOUBLON',
          `Même personne probable que ${x.v.nomComplet} (${x.v.etablissement ?? 'établissement inconnu'}).`,
          x.v.id,
        );
      }
      index.ajouter(x.v.nomComplet, x.v.dateNaissance, x);
    }
    // Sur les deux listes à la fois (volontaire et communautaire) : payé deux fois, seulement si
    // les deux fiches couvrent un même mois. Ex. (13/11/2026) : communautaire sorti le 01/10 (payé
    // en septembre) et volontaire payé à partir d'octobre : un passage d'une liste à l'autre, pas
    // un double paiement. L'autre fiche peut être sortie et encore payée ce mois-là.
    const autres = new IndexNoms<{
      v: Volontaire;
      du: string | null;
      au: string | null;
    }>();
    for (const v of await this.volontaires.find({
      where: { statut: In(['EN_POSTE', 'SORTI']), population: Not(population) },
    })) {
      const du = BourseService.premierMois(v, c);
      const au = BourseService.dernierMois(v, c, du);
      if (au === '0000-01' || (du && au && au < du)) continue;
      if (v.statut === 'SORTI' && !au) continue;
      autres.ajouter(v.nomComplet, v.dateNaissance, { v, du, au });
    }
    for (const x of calculs) {
      // Les mois payés ici (le mois de l'état et les rappels)
      const debut = x.du ?? mois;
      const fin = x.au ?? mois;
      const a = autres
        .probables(x.v.nomComplet, x.v.dateNaissance)
        .find((o) => (!o.du || o.du <= fin) && (!o.au || o.au >= debut))?.v;
      if (a)
        signaler(
          x.v,
          'AUTRE_LISTE',
          `Aussi sur la liste des ${LISTES[populationDe(a.population)]} : ${a.nomComplet} (${a.etablissement ?? 'établissement inconnu'}).`,
          a.id,
        );
    }

    // Recrutés à la Fonction Publique : sortants « RECRUTE_FP », anciens recrutés, base des recrutés
    const recrutes = new IndexNoms<string>();
    const payesIds = new Set(calculs.map((x) => x.v.id));
    for (const v of tous)
      if (
        v.statut === 'SORTI' &&
        v.motifSortie === 'RECRUTE_FP' &&
        !payesIds.has(v.id)
      )
        recrutes.ajouter(
          v.nomComplet,
          v.dateNaissance,
          `sorti du registre comme recruté (${v.source ?? 'fiche'})`,
        );
    for (const a of await this.anciens.find({
      select: {
        nomComplet: true,
        dateNaissance: true,
        annee: true,
        source: true,
      },
    }))
      recrutes.ajouter(
        a.nomComplet,
        a.dateNaissance,
        `ancien recruté ${a.annee ?? ''} (${a.source})`.replace('  ', ' '),
      );
    // Base du personnel : fonctionnaires et contractuels (recensement, liste de la solde)
    for (const a of await this.volontaires.query<
      {
        nomComplet: string;
        dateNaissance: string | null;
        statut: string;
        numeroFiche: string;
        matricule: string | null;
      }[]
    >(
      `SELECT "nomComplet", to_char("dateNaissance", 'YYYY-MM-DD') AS "dateNaissance", statut, "numeroFiche", matricule
         FROM agent_recense WHERE statut IN ('FONCTIONNAIRE', 'CONTRACTUEL') AND "volontaireId" IS NULL AND coalesce(contentieux->>'etat', 'CONFIRME') = 'CONFIRME'`,
    ))
      recrutes.ajouter(
        a.nomComplet,
        a.dateNaissance,
        `${a.statut === 'CONTRACTUEL' ? 'contractuel' : 'fonctionnaire'} dans la base du personnel (fiche ${a.numeroFiche}${a.matricule ? `, matricule ${a.matricule}` : ''})`,
      );
    // Bottin de la solde : le premier salaire arrête la bourse
    for (const b of await this.volontaires.query<
      {
        nomComplet: string;
        dateNaissance: string | null;
        mois: string;
        matricule: string | null;
      }[]
    >(
      `SELECT DISTINCT ON ("nomNormalise", "dateNaissance") "nomComplet", to_char("dateNaissance", 'YYYY-MM-DD') AS "dateNaissance", mois, matricule
         FROM ligne_bottin WHERE mois <= $1 ORDER BY "nomNormalise", "dateNaissance", mois`,
      [mois],
    ))
      recrutes.ajouter(
        b.nomComplet,
        b.dateNaissance,
        `payé à la solde depuis ${moisEnClair(b.mois)} (bottin${b.matricule ? `, matricule ${b.matricule}` : ''})`,
      );
    // Texte de la FP reçu : la bourse continue jusqu'au premier salaire (DG, 23/10/2026)
    const textes = new IndexNoms<string>();
    const enBase = new IndexNoms<string>();
    for (const a of await this.agents.find({
      select: {
        nomComplet: true,
        dateNaissance: true,
        lotPublicationId: true,
        feuille: true,
      },
    }))
      (a.lotPublicationId ? textes : enBase).ajouter(
        a.nomComplet,
        a.dateNaissance,
        a.lotPublicationId
          ? 'liste envoyée à la Fonction Publique'
          : `base des recrutés, feuille « ${a.feuille} »`,
      );
    for (const x of calculs) {
      const r = recrutes.probables(x.v.nomComplet, x.v.dateNaissance);
      if (r.length)
        signaler(
          x.v,
          'RECRUTE_FP',
          `Retrouvé : ${r[0]}. S’il est recruté, sortez-le du registre ; sinon marquez le contrôle comme vérifié.`,
        );
      else if (textes.probables(x.v.nomComplet, x.v.dateNaissance).length)
        signaler(
          x.v,
          'TEXTE_FP',
          'Texte de la Fonction Publique reçu. La bourse continue jusqu’à son premier salaire : le pointage du bottin le dira.',
        );
      else {
        const b = enBase.probables(x.v.nomComplet, x.v.dateNaissance);
        if (b.length)
          signaler(x.v, 'EN_RECRUTEMENT', `Retrouvé dans la ${b[0]}.`);
      }
    }

    // Téléphone partagé par plusieurs volontaires payés
    const parTel = new Map<string, Calcul[]>();
    for (const x of calculs) {
      const t = (x.v.telephone ?? '').replace(/\D/g, '').slice(-9);
      if (t.length >= 8) parTel.set(t, [...(parTel.get(t) ?? []), x]);
    }
    for (const [t, liste] of parTel)
      if (liste.length >= c.telephonePartage)
        for (const x of liste)
          signaler(
            x.v,
            'TELEPHONE',
            `Numéro …${t.slice(-4)} partagé par ${liste.length} volontaires payés.`,
          );

    // Régularisations en attente : compléments versés, retenues imputées sur la bourse
    // (dans la limite de ce qui est payé ; le reste attend les mois suivants)
    const regs = await this.regs.find({
      where: { statut: 'EN_ATTENTE' },
      order: { id: 'ASC' },
    });
    if (regs.length) {
      const parV = new Map(calculs.map((x) => [x.v.id, x] as const));
      const parId = new Map(tous.map((v) => [v.id, v] as const));
      for (const r of regs.filter((x) => x.type === 'COMPLEMENT')) {
        let x = parV.get(r.volontaireId);
        const v = parId.get(r.volontaireId);
        if (!x && v) {
          // Un complément est versé même à un volontaire qui n'est plus payé ce mois-ci
          x = {
            v,
            du: null,
            au: null,
            regs: [],
            nbMois: 0,
            montant: 0,
            observation: null,
          };
          calculs.push(x);
          parV.set(v.id, x);
        }
        if (x)
          x.regs.push({
            id: r.id,
            montant: r.reste,
            libelle: `complément ${fcfa(r.reste)} (${r.motif})`,
          });
      }
      for (const r of regs.filter((x) => x.type === 'RETENUE')) {
        const x = parV.get(r.volontaireId);
        if (!x) continue; // pas payé ce mois-ci : la retenue attend (ou reste à recouvrer)
        const dispo =
          x.montant * x.nbMois + x.regs.reduce((t, y) => t + y.montant, 0);
        const m = Math.min(r.reste, dispo);
        if (m > 0)
          x.regs.push({
            id: r.id,
            montant: -m,
            libelle: `retenue ${fcfa(m)} (${r.motif})`,
          });
      }
    }
    const totalLigne = (x: Calcul) =>
      x.montant * x.nbMois + x.regs.reduce((t, y) => t + y.montant, 0);

    // Une ligne par volontaire payé (les montants de l'instant sont figés)
    const total = calculs.reduce((t, x) => t + totalLigne(x), 0);
    await this.ds.transaction(async (m) => {
      if (!etat)
        etat = await m.save(EtatBourse, {
          mois,
          population,
          statut: 'BROUILLON',
        });
      await m.delete(LigneBourse, { etatId: etat.id });
      const lignes = calculs.map((x) => ({
        etatId: etat!.id,
        volontaireId: x.v.id,
        nomComplet: x.v.nomComplet,
        categorie: x.v.categorie,
        departementId: x.v.departementId,
        etablissement: x.v.etablissement,
        vague: x.v.vague,
        telephone: x.v.telephone,
        montant: x.montant,
        mois: x.nbMois,
        du: x.du,
        au: x.au,
        regularisation: x.regs.reduce((t, y) => t + y.montant, 0),
        regularisations: x.regs.length
          ? x.regs.map((y) => ({ id: y.id, montant: y.montant }))
          : null,
        total: totalLigne(x),
        observation:
          [x.observation, ...x.regs.map((y) => y.libelle)]
            .filter(Boolean)
            .join(' ; ') || null,
      }));
      for (let i = 0; i < lignes.length; i += 1000)
        await m.insert(LigneBourse, lignes.slice(i, i + 1000));
      await m.update(EtatBourse, etat.id, {
        effectif: calculs.length,
        total: String(total),
        anomalies,
        preparePar: u.nom,
        calculeLe: new Date(),
      });
    });
    await this.journal.log(u, 'BOURSE_CALCULEE', 'etat_bourse', etat!.id, {
      mois,
      liste,
      effectif: calculs.length,
      total,
      bloquants: anomalies.filter((a) => a.gravite === 'BLOQUANT').length,
    });
    return this.etats.findOneOrFail({ where: { id: etat!.id } });
  }

  /** Validation par le DG : seulement après un calcul à jour et sans contrôle bloquant. */
  async valider(u: UtilisateurConnecte, id: number) {
    if (u.role !== 'DG' && u.role !== 'ADMIN')
      throw new ForbiddenException('Seul le DG valide un état de bourse.');
    const avant = await this.etats.findOne({ where: { id } });
    if (!avant) throw new NotFoundException('État de bourse introuvable');
    if (avant.statut === 'VALIDE')
      throw new BadRequestException('Cet état est déjà validé.');
    // Un mois antérieur resté en projet serait payé deux fois (son mois revient en rappel ici)
    const enProjet = await this.etats.findOne({
      where: {
        statut: 'BROUILLON',
        mois: LessThan(avant.mois),
        population: avant.population,
      },
      order: { mois: 'ASC' },
    });
    if (enProjet)
      throw new BadRequestException(
        `L’état de ${moisEnClair(enProjet.mois)} n’est pas validé : validez-le d’abord, ou supprimez-le (ses mois seront alors payés en rappel ici).`,
      );
    // On recalcule d'abord : la fiche d'un volontaire a pu changer depuis
    const etat = await this.preparer(u, avant.mois, avant.population);
    const bloquants = (etat.anomalies as Anomalie[]).filter(
      (a) => a.gravite === 'BLOQUANT',
    );
    if (bloquants.length)
      throw new BadRequestException(
        `${bloquants.length} contrôle(s) bloquant(s) restent à régler (doublons, recrutés, catégorie ou département manquant). Corrigez les fiches ou marquez-les comme vérifiés.`,
      );
    if (!etat.effectif)
      throw new BadRequestException(
        `Aucun ${avant.population === 'COMMUNAUTAIRE' ? 'communautaire' : 'volontaire'} à payer ce mois-ci.`,
      );
    await this.ds.transaction(async (m) => {
      await m.update(EtatBourse, id, {
        statut: 'VALIDE',
        validePar: u.nom,
        valideLe: new Date(),
      });
      // Les régularisations imputées sur cet état sont soldées (ou diminuées)
      const lignes = await m.find(LigneBourse, { where: { etatId: id } });
      for (const l of lignes)
        for (const a of l.regularisations ?? []) {
          const r = await m.findOne(Regularisation, { where: { id: a.id } });
          if (!r) continue;
          const reste = r.reste - Math.abs(a.montant);
          await m.update(Regularisation, r.id, {
            reste,
            statut: reste <= 0 ? 'SOLDEE' : 'EN_ATTENTE',
            applications: [
              ...r.applications,
              { etatId: id, mois: etat.mois, montant: a.montant },
            ],
          });
        }
    });
    await this.journal.log(u, 'BOURSE_VALIDEE', 'etat_bourse', id, {
      mois: etat.mois,
      total: etat.total,
    });
    return this.etats.findOneOrFail({ where: { id } });
  }

  async rouvrir(u: UtilisateurConnecte, id: number, motif: string) {
    if (u.role !== 'DG' && u.role !== 'ADMIN')
      throw new ForbiddenException('Seul le DG rouvre un état de bourse.');
    const etat = await this.etats.findOne({ where: { id } });
    if (!etat) throw new NotFoundException('État de bourse introuvable');
    if (etat.statut !== 'VALIDE')
      throw new BadRequestException('Cet état n’est pas validé.');
    if (!motif?.trim() || motif.trim().length < 5)
      throw new BadRequestException('Indiquez pourquoi l’état est rouvert.');
    const suivant = await this.etats.findOne({
      where: { statut: 'VALIDE', population: etat.population },
      order: { mois: 'DESC' },
    });
    if (suivant && suivant.mois > etat.mois)
      throw new BadRequestException(
        `L’état de ${moisEnClair(suivant.mois)} est validé après celui-ci : rouvrez d’abord le plus récent (les rappels en dépendent).`,
      );
    await this.ds.transaction(async (m) => {
      await m.update(EtatBourse, id, {
        statut: 'BROUILLON',
        validePar: null,
        valideLe: null,
      });
      // Les régularisations imputées sur cet état redeviennent à faire
      const touchees = await m
        .createQueryBuilder(Regularisation, 'r')
        .where(`r.applications @> CAST(:a AS jsonb)`, {
          a: JSON.stringify([{ etatId: id }]),
        })
        .getMany();
      for (const r of touchees) {
        const ici = r.applications.filter((a) => a.etatId === id);
        await m.update(Regularisation, r.id, {
          reste: r.reste + ici.reduce((t, a) => t + Math.abs(a.montant), 0),
          statut: r.statut === 'ANNULEE' ? 'ANNULEE' : 'EN_ATTENTE',
          applications: r.applications.filter((a) => a.etatId !== id),
        });
      }
    });
    await this.journal.log(u, 'BOURSE_ROUVERTE', 'etat_bourse', id, {
      mois: etat.mois,
      motif: motif.trim(),
    });
    return this.etats.findOneOrFail({ where: { id } });
  }

  async supprimer(u: UtilisateurConnecte, id: number) {
    const etat = await this.etats.findOne({ where: { id } });
    if (!etat) throw new NotFoundException('État de bourse introuvable');
    if (etat.statut === 'VALIDE')
      throw new BadRequestException('Un état validé ne se supprime pas.');
    await this.ds.transaction(async (m) => {
      await m.delete(LigneBourse, { etatId: id });
      await m.delete(EtatBourse, id);
    });
    await this.journal.log(u, 'BOURSE_SUPPRIMEE', 'etat_bourse', id, {
      mois: etat.mois,
    });
    return { ok: true };
  }

  /* ------------------------------ Excel ------------------------------ */

  /**
   * État de paiement comme ceux de la DGRHAS : liste générale, une feuille par département,
   * récapitulatif par montant, total arrêté en lettres et signataire.
   */
  /**
   * État de paiement au modèle officiel (réunion DG du 27/10/2026) : c'est ce qu'on envoie au
   * Trésor et que les bénéficiaires signent en touchant leur bourse. Colonnes N°, Nom et prénoms,
   * Cycle, Département, Établissement, Vague, Mois, Montant, N° CNI et Émargement (remplis à la
   * main), Téléphone, Observation ; le total ; une liste générale puis une par département (les
   * communautaires : une liste unique) ; la signature de la Directrice de cabinet, le nom en gras.
   */
  async etatPaiement(id: number) {
    const etat = await this.etats.findOne({ where: { id } });
    if (!etat) throw new NotFoundException('État de bourse introuvable');
    const c = this.config.get();
    const deps = new Map((await this.deps.find()).map((d) => [d.id, d.nom]));
    const lignes = await this.lignes.find({ where: { etatId: id } });
    const communautaires = etat.population === 'COMMUNAUTAIRE';
    const libCat = (code: string | null) =>
      this.config.categoriesDe(etat.population).find((x) => x.code === code)
        ?.libelle ??
      code ??
      '';
    const nomDep = (d: number | null) =>
      d ? (deps.get(d) ?? '') : 'Non renseigné';
    lignes.sort(
      (a, b) =>
        nomDep(a.departementId).localeCompare(nomDep(b.departementId), 'fr') ||
        a.nomComplet.localeCompare(b.nomComplet, 'fr'),
    );
    const brouillon = etat.statut !== 'VALIDE';
    const versLigne = (l: LigneBourse) => ({
      nomComplet: l.nomComplet,
      cycle: libCat(l.categorie),
      departementId: l.departementId,
      departement: nomDep(l.departementId),
      etablissement: l.etablissement ?? '',
      vague: l.vague ?? '',
      mois: l.mois,
      montant: l.total,
      telephone: l.telephone ?? '',
      // Sans colonne « Mois » (DG, 28/10/2026) : un rappel se lit dans l'observation
      observation: [
        l.mois > 1 ? `${l.mois} mois payés (rappel)` : null,
        l.observation,
      ]
        .filter(Boolean)
        .join(' ; '),
    });
    const section = (titre: string, liste: LigneBourse[]) => {
      const total = liste.reduce((t, l) => t + l.total, 0);
      return {
        titre,
        lignes: liste.map(versLigne),
        total,
        arrete: montantArrete(total),
      };
    };
    const sections = [
      section(communautaires ? 'LISTE UNIQUE' : 'LISTE GÉNÉRALE', lignes),
    ];
    if (!communautaires) {
      const parDep = new Map<string, LigneBourse[]>();
      for (const l of lignes)
        parDep.set(nomDep(l.departementId), [
          ...(parDep.get(nomDep(l.departementId)) ?? []),
          l,
        ]);
      for (const [d, liste] of parDep)
        sections.push(section(`DÉPARTEMENT : ${d.toUpperCase()}`, liste));
    }
    return {
      etat: {
        id: etat.id,
        mois: etat.mois,
        statut: etat.statut,
        population: populationDe(etat.population),
      },
      titre: communautaires
        ? 'ÉTAT DE PAIEMENT DES ENSEIGNANTS COMMUNAUTAIRES'
        : 'ÉTAT DE PAIEMENT DES ENSEIGNANTS VOLONTAIRES',
      // « DU MOIS D’OCTOBRE 2026 », « DU MOIS DE SEPTEMBRE 2026 »
      sousTitre: `${communautaires ? 'PAIEMENT' : 'BOURSE'} DU MOIS ${/^[aeiou]/i.test(moisEnClair(etat.mois).normalize('NFD')) ? 'D’' : 'DE '}${moisEnClair(etat.mois).toUpperCase()}${brouillon ? ' (PROJET NON VALIDÉ)' : ''}`,
      brouillon,
      sections,
      signature: {
        titre: c.signatairePaiementTitre,
        nom: c.signatairePaiementNom,
      },
      // Les noms des fichiers du DG (dossier « new », 13/11/2026) : « Fiche de répartition Bourse
      // Volontaire_Septembre 2026 », « ETATS DE PAIEMENT DES ENSEIGNANTS COMMUNAUTAIRES SEPTEMBRE 2026 »
      nomFichier: `${communautaires ? `ETATS DE PAIEMENT DES ENSEIGNANTS COMMUNAUTAIRES ${moisEnClair(etat.mois).toUpperCase()}` : `Fiche de répartition Bourse Volontaire_${moisMajuscule(etat.mois)}`}${brouillon ? ' (projet)' : ''}`,
    };
  }

  /**
   * Fiche de prise en charge, copiée sur le modèle du cabinet (« FICHE DE PRISE EN CHARGE DES
   * ENSEIGNANTS COMMUNAUTAIRES AOUT 2026 », feuille « Version 3 F (3) ») : en-tête du ministère à
   * gauche et de la République à droite, titre, mesure gouvernementale, année scolaire, période ;
   * par département (les regroupements du cabinet : Cuvette/Congo-Oubangui, Plateaux/Nkéni-Alima…),
   * l'effectif, le taux et le montant de chaque cycle (Préscolaire, Primaire, Collège, Lycée,
   * Alph/Resco/ORA, Post-Alphabétisation), le total mensuel (effectif, montant) et le total
   * trimestriel et annuel ; le texte « Au mois de … l'effectif … est évalué à … » ; la signature.
   * Les montants sont des formules (effectif × taux) : la fiche se corrige dans Excel comme le
   * modèle. Une ligne par personne payée, sans les rappels (la prise en charge d'un mois).
   */
  async priseEnChargeExcel(
    id: number,
    police: PoliceDocument = 'actuelle',
  ): Promise<{ nom: string; contenu: Buffer }> {
    const etat = await this.etats.findOne({ where: { id } });
    if (!etat) throw new NotFoundException('État de bourse introuvable');
    const c = this.config.get();
    const communautaires = etat.population === 'COMMUNAUTAIRE';
    const depsListe = await this.deps.find();
    const lignes = await this.lignes.query<
      {
        departementId: number | null;
        categorie: string | null;
        effectif: number;
      }[]
    >(
      `SELECT "departementId", categorie, count(*)::int AS effectif
         FROM ligne_bourse WHERE "etatId" = $1 GROUP BY 1, 2`,
      [id],
    );

    // Les colonnes : l'ordre et les mots du modèle pour les communautaires ; les autres cycles
    // (administration scolaire…) seulement s'ils ont du monde, et « Cycle non renseigné » au besoin
    const cats = this.config.categoriesDe(etat.population);
    const ORDRE_COM: [string, string][] = [
      ['COM_PRESCOLAIRE', 'Préscolaire'],
      ['COM_PRIMAIRE', 'Primaire'],
      ['COM_COLLEGE', 'Collège'],
      ['COM_LYCEE', 'Lycée'],
      ['COM_ALPHABETISATION', 'Alph/Resco/ORA'],
      ['COM_POST_ALPHA', 'Post-Alphabétisation'],
    ];
    const aDuMonde = (code: string) =>
      lignes.some((l) => l.categorie === code && l.effectif > 0);
    const colonnes: { code: string; libelle: string; taux: number }[] =
      communautaires
        ? [
            ...ORDRE_COM.filter(([code]) =>
              cats.some((x) => x.code === code),
            ).map(([code, libelle]) => ({
              code,
              libelle,
              taux: cats.find((x) => x.code === code)!.bourse,
            })),
            ...cats
              .filter(
                (x) =>
                  !ORDRE_COM.some(([k]) => k === x.code) && aDuMonde(x.code),
              )
              .map((x) => ({
                code: x.code,
                libelle: x.libelle,
                taux: x.bourse,
              })),
          ]
        : cats
            .filter((x) => x.actif || aDuMonde(x.code))
            .map((x) => ({ code: x.code, libelle: x.libelle, taux: x.bourse }));
    if (lignes.some((l) => !colonnes.some((x) => x.code === l.categorie)))
      colonnes.push({ code: '', libelle: 'Cycle non renseigné', taux: 0 });

    // Les lignes : les regroupements du cabinet pour les communautaires (une ligne même vide) ;
    // un département par ligne pour les volontaires
    const GROUPES_COM: [string, string[]][] = [
      ['Bouenza', ['BOUENZA']],
      ['Brazzaville', ['BRAZZAVILLE']],
      ['Cuvette/Congo-Oubangui', ['CUVETTE', 'CONGO_OUBANGUI']],
      ['Cuv-Ouest', ['CUVETTE_OUEST']],
      ['Djoué-Léfini', ['DJOUE_LEFINI']],
      ['Kouilou', ['KOUILOU']],
      ['Lékoumou', ['LEKOUMOU']],
      ['Likouala/Congo-Oubangui', ['LIKOUALA']],
      ['Niari', ['NIARI']],
      ['Plateaux/Nkéni-Alima', ['PLATEAUX', 'NKENI_ALIMA']],
      ['Pointe-Noire', ['POINTE_NOIRE']],
      ['Pool', ['POOL']],
      ['Sangha', ['SANGHA']],
    ];
    const groupes: { libelle: string; ids: (number | null)[] }[] =
      communautaires
        ? GROUPES_COM.map(([libelle, codes]) => ({
            libelle,
            ids: depsListe
              .filter((d) => codes.includes(d.code))
              .map((d) => d.id),
          }))
        : depsListe
            .filter((d) => lignes.some((l) => l.departementId === d.id))
            .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'))
            .map((d) => ({ libelle: d.nom, ids: [d.id] }));
    // Département absent des regroupements (ou non renseigné) : une ligne à part, pour ne rien perdre
    const pris = new Set(groupes.flatMap((g) => g.ids));
    const autres = [
      ...new Set(
        lignes
          .filter((l) => !pris.has(l.departementId))
          .map((l) => l.departementId),
      ),
    ];
    for (const d of autres)
      groupes.push({
        libelle: d
          ? (depsListe.find((x) => x.id === d)?.nom ?? '?')
          : 'Département non renseigné',
        ids: [d],
      });
    const effectif = (ids: (number | null)[], code: string) =>
      lignes
        .filter(
          (l) =>
            ids.includes(l.departementId) &&
            (code === ''
              ? !colonnes.some((x) => x.code && x.code === l.categorie)
              : l.categorie === code),
        )
        .reduce((t, l) => t + l.effectif, 0);

    // Le classeur
    const wb = new ExcelJS.Workbook();
    wb.creator = 'SIGRHAS-MEPPSA';
    // Les formules (montants à 0 compris) sont recalculées à l'ouverture, comme dans le modèle
    wb.calcProperties.fullCalcOnLoad = true;
    const ws = wb.addWorksheet('Prise en charge', {
      pageSetup: {
        paperSize: 9,
        orientation: 'landscape',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        // Les marges du modèle du DG (« Fiche de prise en charge Communautaires Septembre 2026 »)
        margins: {
          left: 0.39,
          right: 0.3,
          top: 0.4,
          bottom: 0.4,
          header: 0.2,
          footer: 0.2,
        },
      },
    });
    const nbCycles = colonnes.length;
    // Deux colonnes par cycle (Eff., Montant) : le taux est dans le titre du cycle
    const cEff = 2 + nbCycles * 2; // TOTAL MENSUEL : Eff.
    const cMens = cEff + 1; // Montant
    const cTrim = cEff + 2; // TOTAL : Montant trimestriel
    const cAnn = cEff + 3; // Montant annuel
    const nbCol = cAnn;
    const col = (n: number) => ws.getColumn(n).letter;
    const fusion = (l: number, c1: number, c2: number) => {
      if (c2 > c1) ws.mergeCells(l, c1, l, c2);
    };
    const texte = (
      l: number,
      c1: number,
      c2: number,
      valeur: string,
      font: Partial<ExcelJS.Font>,
      horizontal: 'left' | 'center' | 'right' = 'center',
    ) => {
      fusion(l, c1, c2);
      const cell = ws.getCell(l, c1);
      cell.value = valeur;
      cell.font = { name: 'Times New Roman', ...font };
      cell.alignment = { horizontal, vertical: 'middle', wrapText: true };
    };
    // En-tête officiel, celui du modèle du DG (« Fiche de prise en charge Communautaires
    // Septembre 2026 », 13/11/2026) : le ministère, le cabinet et la DGRHAS sur les cinq premières
    // colonnes, la République sur les deux dernières, en Calibri 12 gras
    const gauche = Math.min(5, nbCol - 2);
    const droite = nbCol - 1;
    const officiel = (l: number, c1: number, c2: number, v: string) => {
      texte(l, c1, c2, v, { bold: true, size: 12 });
      ws.getCell(l, c1).font = { name: 'Calibri', bold: true, size: 12 };
    };
    officiel(1, 1, gauche, "MINISTERE DE L'ENSEIGNEMENT PRESCOLAIRE,");
    officiel(1, droite, nbCol, 'REPUBLIQUE DU CONGO');
    officiel(2, 1, gauche, "PRIMAIRE, SECONDAIRE ET DE L'ALPHABETISATION");
    officiel(2, droite, nbCol, 'Unité - Travail - Progrès');
    officiel(3, 1, gauche, '-----------');
    officiel(3, droite, nbCol, '-----------');
    officiel(4, 1, gauche, 'CABINET');
    officiel(5, 1, gauche, '-----------');
    officiel(6, 1, gauche, 'DIRECTION GENERALE DES RESSOURCES HUMAINES');
    officiel(7, 1, gauche, "ET DE L'ADMINISTRATION SCOLAIRE");
    officiel(8, 1, gauche, '-----------');
    for (const [l, h] of [
      [1, 15.75],
      [2, 15.75],
      [3, 9],
      [4, 9],
      [5, 9],
      [6, 12],
      [7, 12],
      [8, 12],
      [9, 18.75],
      [10, 12],
    ])
      ws.getRow(l).height = h;
    texte(
      9,
      1,
      nbCol,
      `FICHE DE PRISE EN CHARGE DES ENSEIGNANTS ${communautaires ? 'COMMUNAUTAIRES' : 'VOLONTAIRES'}`,
      { bold: true, size: 14 },
    );
    if (communautaires && c.ficheMentionCommunautaires)
      texte(11, 1, nbCol, c.ficheMentionCommunautaires, {
        bold: true,
        size: 11,
      });
    // Année scolaire : de septembre à août (août 2026 → 2025-2026)
    const [an, m] = etat.mois.split('-').map(Number);
    const debutAnnee = m >= 9 ? an : an - 1;
    texte(13, 1, nbCol, `ANNEE SCOLAIRE ${debutAnnee}-${debutAnnee + 1}`, {
      bold: true,
      size: 11,
    });
    const sansAccents = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
    texte(
      15,
      1,
      nbCol,
      `PERIODE : ${sansAccents(moisEnClair(etat.mois)).toUpperCase()}`,
      { bold: true, size: 11 },
    );
    if (etat.statut !== 'VALIDE')
      texte(16, 1, nbCol, 'Projet : état de paiement pas encore validé', {
        italic: true,
        size: 9,
        color: { argb: 'FFB91C1C' },
      });

    // Les titres du tableau (lignes 17 et 18)
    const L1 = 17;
    const L2 = 18;
    const bord = {
      top: { style: 'thin' as const },
      bottom: { style: 'thin' as const },
      left: { style: 'thin' as const },
      right: { style: 'thin' as const },
    };
    const titre = (l: number, c1: number, c2: number, v: string) => {
      texte(l, c1, c2, v, { bold: true, size: 10 });
      for (let k = c1; k <= c2; k++) ws.getCell(l, k).border = bord;
    };
    ws.mergeCells(L1, 1, L2, 1);
    titre(L1, 1, 1, 'DEPARTEMENT');
    ws.getCell(L2, 1).border = bord;
    colonnes.forEach((x, i) => {
      // « Préscolaire (50.000) » : le taux une fois, dans le titre
      titre(
        L1,
        2 + i * 2,
        3 + i * 2,
        x.taux ? `${x.libelle}\n(${fcfa(x.taux)})` : x.libelle,
      );
      titre(L2, 2 + i * 2, 2 + i * 2, 'Eff.');
      titre(L2, 3 + i * 2, 3 + i * 2, 'Montant');
    });
    titre(L1, cEff, cMens, 'TOTAL MENSUEL');
    titre(L1, cTrim, cAnn, 'TOTAL');
    titre(L2, cEff, cEff, 'Eff.');
    titre(L2, cMens, cMens, 'Montant');
    titre(L2, cTrim, cTrim, 'Montant trimestriel');
    titre(L2, cAnn, cAnn, 'Montant annuel');
    // Deux lignes dans le titre du cycle : le libellé, puis le taux
    ws.getRow(L1).height = 24.75;
    ws.getRow(L2).height = 30;

    // Une ligne par département (ou regroupement), avec les formules du modèle
    const premiere = L2 + 1;
    let l = premiere;
    let effTotal = 0;
    let montantTotal = 0;
    const cellule = (
      ligne: number,
      colonne: number,
      valeur: ExcelJS.CellValue,
      gras = false,
    ) => {
      const cell = ws.getCell(ligne, colonne);
      cell.value = valeur;
      cell.font = { name: 'Times New Roman', size: 10, bold: gras };
      cell.border = bord;
      if (colonne > 1) {
        cell.numFmt = '#,##0';
        cell.alignment = { horizontal: 'right', vertical: 'middle' };
      } else cell.alignment = { vertical: 'middle' };
    };
    for (const g of groupes) {
      cellule(l, 1, g.libelle);
      let eff = 0;
      let mont = 0;
      colonnes.forEach((x, i) => {
        const n = effectif(g.ids, x.code);
        const ce = 2 + i * 2;
        eff += n;
        mont += n * x.taux;
        cellule(l, ce, n);
        // Le montant : effectif × taux (le taux est écrit dans la formule et dans le titre)
        cellule(l, ce + 1, {
          formula: `PRODUCT(${col(ce)}${l},${x.taux})`,
          result: n * x.taux,
        });
      });
      effTotal += eff;
      montantTotal += mont;
      cellule(l, cEff, {
        formula: colonnes.map((_, i) => `${col(2 + i * 2)}${l}`).join('+'),
        result: eff,
      });
      cellule(l, cMens, {
        formula: `SUM(${colonnes.map((_, i) => `${col(3 + i * 2)}${l}`).join(',')})`,
        result: mont,
      });
      cellule(l, cTrim, { formula: `${col(cMens)}${l}*3`, result: mont * 3 });
      cellule(l, cAnn, {
        formula: `PRODUCT(${col(cMens)}${l},12)`,
        result: mont * 12,
      });
      l++;
    }
    const derniere = l - 1;
    const somme = (colonne: number, resultat: number) => ({
      formula: `SUM(${col(colonne)}${premiere}:${col(colonne)}${derniere})`,
      result: resultat,
    });
    cellule(l, 1, 'TOTAL', true);
    colonnes.forEach((x, i) => {
      const n = effectif(
        groupes.flatMap((g) => g.ids),
        x.code,
      );
      cellule(l, 2 + i * 2, somme(2 + i * 2, n), true);
      cellule(l, 3 + i * 2, somme(3 + i * 2, n * x.taux), true);
    });
    cellule(l, cEff, somme(cEff, effTotal), true);
    cellule(l, cMens, somme(cMens, montantTotal), true);
    cellule(l, cTrim, somme(cTrim, montantTotal * 3), true);
    cellule(l, cAnn, somme(cAnn, montantTotal * 12), true);
    for (let k = 1; k <= nbCol; k++)
      ws.getCell(l, k).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE4E4E7' },
      };

    // Le texte du modèle, puis la signature à droite
    const nomMois = moisEnClair(etat.mois).toLowerCase();
    const espaces = (n: number) =>
      n.toLocaleString('fr-FR').replace(/\s/g, ' ');
    const points = (n: number) =>
      String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    const lt = l + 2;
    texte(
      lt,
      1,
      nbCol,
      `Au mois ${/^[aeiouh]/i.test(sansAccents(nomMois)) ? "d'" : 'de '}${nomMois}, l'effectif des enseignants ${communautaires ? 'communautaires' : 'volontaires'} est évalué à ${espaces(effTotal)}. Leur prise en charge nécessite un montant de ${points(montantTotal)} FCFA.`,
      { size: 11 },
      'left',
    );
    texte(
      lt + 1,
      1,
      nbCol,
      "A ce montant, il faut ajouter les frais de la prise en charge de l'organisation de la paie et de l'acheminement des fonds dans les différents sites départementaux.",
      { size: 11 },
      'left',
    );
    ws.getRow(lt).height = 18;
    ws.getRow(lt + 1).height = 30;
    // La signature sur les six dernières colonnes, comme le modèle du DG
    const sig = Math.max(1, nbCol - 5);
    texte(lt + 2, sig, nbCol, 'Fait à Brazzaville, le', { size: 11 }, 'left');
    texte(
      lt + 4,
      sig,
      nbCol,
      c.signatairePaiementTitre,
      { bold: true, size: 11 },
      'left',
    );
    texte(
      lt + 9,
      sig,
      nbCol,
      c.signatairePaiementNom,
      { bold: true, size: 11 },
      'left',
    );

    // Largeurs : celles du modèle du DG (département, puis Eff. étroit et Montant)
    ws.getColumn(1).width = 22;
    colonnes.forEach((_, i) => {
      ws.getColumn(2 + i * 2).width = 6;
      ws.getColumn(3 + i * 2).width = 12;
    });
    ws.getColumn(cEff).width = 7.3;
    ws.getColumn(cMens).width = 13;
    ws.getColumn(cTrim).width = 13.3;
    ws.getColumn(cAnn).width = 12.9;
    // Pas de volets figés : vue « Mise en page », comme le DG laisse la fiche (13/11/2026)
    ws.views = [{ style: 'pageLayout' }];
    appliquerPolice(wb, police);
    return {
      // « Fiche de prise en charge Communautaires Septembre 2026 » (le nom du DG, 13/11/2026)
      nom: `Fiche de prise en charge ${communautaires ? 'Communautaires' : 'Volontaires'} ${moisMajuscule(etat.mois)}${etat.statut === 'VALIDE' ? '' : ' (projet)'}.xlsx`,
      contenu: Buffer.from(await wb.xlsx.writeBuffer()),
    };
  }

  /** Colonnes de l'état de paiement (Excel, Word et impression). */
  static readonly COLONNES_PAIEMENT = [
    'N°',
    'Nom et prénoms',
    'Cycle',
    'Départ.',
    'Établissement',
    'Vague',
    'Montant (FCFA)',
    'N° CNI',
    'Émargement',
    'Téléphone',
    'Observation',
  ];

  /** État de paiement en Word (paysage ou portrait, au choix) : chaque liste sur ses pages, signée. */
  async word(
    id: number,
    choix: PoliceDocument = 'actuelle',
    orientation: OrientationDocument = 'paysage',
    seulRecap = false,
  ): Promise<{ nom: string; contenu: Buffer }> {
    const e = await this.etatPaiement(id);
    // Times New Roman (la police actuelle) ou Gill Sans MT, au choix (13/11/2026)
    const police = choix === 'gill' ? GILL : 'Times New Roman';
    const texte = (
      t: string,
      o: {
        gras?: boolean;
        taille?: number;
        souligne?: boolean;
        italique?: boolean;
      } = {},
    ) =>
      new TextRun({
        text: t,
        bold: o.gras,
        italics: o.italique,
        size: o.taille ?? 16,
        font: police,
        underline: o.souligne ? {} : undefined,
      });
    const para = (
      t: string,
      o: {
        gras?: boolean;
        taille?: number;
        centre?: boolean;
        souligne?: boolean;
        italique?: boolean;
        droite?: boolean;
        avant?: number;
      } = {},
    ) =>
      new Paragraph({
        alignment: o.centre
          ? AlignmentType.CENTER
          : o.droite
            ? AlignmentType.RIGHT
            : AlignmentType.LEFT,
        spacing: { before: o.avant ?? 0, after: 0 },
        children: [texte(t, o)],
      });
    const cellule = (
      t: string | number,
      o: { gras?: boolean; droite?: boolean; fond?: boolean } = {},
    ) =>
      new TableCell({
        verticalAlign: VerticalAlign.CENTER,
        shading: o.fond ? { fill: 'E5E7EB' } : undefined,
        children: [
          new Paragraph({
            alignment: o.droite ? AlignmentType.RIGHT : AlignmentType.LEFT,
            // En portrait, la page est plus étroite : le tableau un peu plus petit
            children: [
              texte(String(t), {
                gras: o.gras,
                taille: orientation === 'portrait' ? 13 : 15,
              }),
            ],
          }),
        ],
      });
    // L'en-tête officiel (celui du récapitulatif mis en forme par le DG, 13/11/2026) : le ministère,
    // le cabinet et la DGRHAS à gauche, la République à droite
    const sansBord = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
    const aucunBord = {
      top: sansBord,
      bottom: sansBord,
      left: sansBord,
      right: sansBord,
    };
    const blocEntete = (lignes: string[], largeur: number) =>
      new TableCell({
        width: { size: largeur, type: WidthType.PERCENTAGE },
        borders: aucunBord,
        children: lignes.map((x) =>
          para(x, { gras: true, taille: 22, centre: true }),
        ),
      });
    const entete = () =>
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: {
          ...aucunBord,
          insideHorizontal: sansBord,
          insideVertical: sansBord,
        },
        rows: [
          new TableRow({
            children: [
              blocEntete(
                [
                  "MINISTERE DE L'ENSEIGNEMENT PRESCOLAIRE,",
                  "PRIMAIRE, SECONDAIRE ET DE L'ALPHABETISATION",
                  '-----------',
                  'CABINET',
                  '-----------',
                  'DIRECTION GENERALE DES RESSOURCES HUMAINES',
                  "ET DE L'ADMINISTRATION SCOLAIRE",
                  '-----------',
                ],
                55,
              ),
              blocEntete([''], 15),
              blocEntete(
                [
                  'REPUBLIQUE DU CONGO',
                  'Unité - Travail - Progrès',
                  '-----------',
                ],
                30,
              ),
            ],
          }),
        ],
      });
    // Le RECAP seul (13/11/2026) : la « FICHE DE REPARTITION PAR DEPARTEMENT ET PAR CYCLE » de
    // l'Excel, en Word : en-tête, titre, période, tableau par département et par montant de
    // bourse, total, arrêté en lettres et signature
    if (seulRecap) {
      const lignesEtat = await this.lignes.find({ where: { etatId: id } });
      const noms = new Map((await this.deps.find()).map((d) => [d.id, d.nom]));
      const R = this.calculRecap(e.etat.population, lignesEtat, (d) =>
        d ? (noms.get(d) ?? '') : 'Non renseigné',
      );
      const nombre = (n: number) => fcfa(n).replace(/\./g, ' ');
      const montant = (n: number) => (n ? nombre(n) : '-');
      const fin = { style: BorderStyle.SINGLE, size: 4, color: '000000' };
      const tousBords = { top: fin, bottom: fin, left: fin, right: fin };
      const cr = (
        t: string | number,
        o: {
          gras?: boolean;
          droite?: boolean;
          gauche?: boolean;
          span?: number;
          fusion?: 'debut' | 'suite';
        } = {},
      ) =>
        new TableCell({
          verticalAlign: VerticalAlign.CENTER,
          borders: tousBords,
          columnSpan: o.span,
          verticalMerge:
            o.fusion === 'debut'
              ? VerticalMergeType.RESTART
              : o.fusion === 'suite'
                ? VerticalMergeType.CONTINUE
                : undefined,
          children: String(t)
            .split('\n')
            .map(
              (x) =>
                new Paragraph({
                  alignment: o.droite
                    ? AlignmentType.RIGHT
                    : o.gauche
                      ? AlignmentType.LEFT
                      : AlignmentType.CENTER,
                  children: [texte(x, { gras: o.gras, taille: 20 })],
                }),
            ),
        });
      // Les largeurs du RECAP de l'Excel (N°, département, chaque groupe, total), à l'échelle
      // de la page
      const largeursR = [
        5,
        22,
        ...R.groupes.flatMap((_, k) =>
          k === 0 ? [10.7, 13.2] : k === 1 ? [13.7, 13.7] : [11.2, 11.2],
        ),
        13,
        13,
      ];
      const utile = orientation === 'portrait' ? 10466 : 15398;
      const somme = largeursR.reduce((s, x) => s + x, 0);
      const tableau = new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        columnWidths: largeursR.map((x) => Math.round((x / somme) * utile)),
        rows: [
          new TableRow({
            tableHeader: true,
            children: [
              cr('N°', { fusion: 'debut' }),
              cr('Département', { fusion: 'debut' }),
              ...R.groupes.map((g) => cr(g.libelle, { gras: true, span: 2 })),
              cr('Total', { gras: true, span: 2 }),
            ],
          }),
          new TableRow({
            tableHeader: true,
            children: [
              cr('', { fusion: 'suite' }),
              cr('', { fusion: 'suite' }),
              ...[...R.groupes, null].flatMap(() => [
                cr('Effectif', { gras: true }),
                cr('Montant', { gras: true }),
              ]),
            ],
          }),
          ...R.lignes.map(
            (l, i) =>
              new TableRow({
                cantSplit: true,
                children: [
                  cr(i + 1),
                  cr(l.departement, { gauche: true }),
                  ...l.cellules.flatMap((x) => [
                    cr(nombre(x.eff)),
                    cr(montant(x.mont), { droite: true }),
                  ]),
                  cr(nombre(l.eff)),
                  cr(montant(l.mont), { droite: true }),
                ],
              }),
          ),
          new TableRow({
            cantSplit: true,
            children: [
              cr(''),
              cr('TOTAL', { gras: true, gauche: true }),
              ...R.totaux.flatMap((x) => [
                cr(nombre(x.eff), { gras: true }),
                cr(montant(x.mont), { gras: true, droite: true }),
              ]),
              cr(nombre(R.effT), { gras: true }),
              cr(montant(R.montT), { gras: true, droite: true }),
            ],
          }),
        ],
      });
      const communautaires = e.etat.population === 'COMMUNAUTAIRE';
      const periode = `PERIODE : ${moisEnClair(e.etat.mois)
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toUpperCase()} (1 MOIS${R.avecRappels ? ' ET RAPPELS' : ''})`;
      const docRecap = new Document({
        sections: [
          {
            properties: {
              page: {
                size: {
                  orientation:
                    orientation === 'portrait'
                      ? PageOrientation.PORTRAIT
                      : PageOrientation.LANDSCAPE,
                },
                margin: { top: 600, bottom: 500, left: 880, right: 560 },
              },
            },
            children: [
              entete(),
              para(
                communautaires
                  ? 'PAIEMENT DES ENSEIGNANTS COMMUNAUTAIRES'
                  : 'BOURSES DES ENSEIGNANTS VOLONTAIRES',
                { gras: true, taille: 28, centre: true, avant: 200 },
              ),
              para(periode, {
                gras: true,
                taille: 24,
                centre: true,
                avant: 120,
              }),
              para('FICHE DE REPARTITION PAR DEPARTEMENT ET PAR CYCLE', {
                gras: true,
                taille: 28,
                centre: true,
                avant: 160,
              }),
              new Paragraph({ children: [] }),
              tableau,
              para(
                `Arrêté le présent récapitulatif à la somme de : ${montantArrete(R.montT)}`,
                { taille: 22, avant: 240, italique: true },
              ),
              para(e.signature.titre, { taille: 22, droite: true, avant: 360 }),
              para('', { taille: 22 }),
              para('', { taille: 22 }),
              para('', { taille: 22 }),
              para('', { taille: 22 }),
              para(e.signature.nom, { gras: true, taille: 22, droite: true }),
              ...(e.brouillon
                ? [
                    para(
                      'Projet non validé : à faire valider par le Directeur général avant paiement.',
                      { taille: 16, avant: 200 },
                    ),
                  ]
                : []),
            ],
          },
        ],
        ...(choix === 'gill'
          ? { styles: { default: { document: { run: { font: GILL } } } } }
          : {}),
      });
      return {
        nom: `RECAP - ${e.nomFichier}.docx`,
        contenu: await Packer.toBuffer(docRecap),
      };
    }
    // Largeurs en pourcentage : la place de l'émargement et de la CNI, remplis à la main
    // La CNI s'écrit à la main : une colonne large (DG, 28/10/2026)
    // En portrait, N°, cycle, téléphone et observation un peu plus larges (13/11/2026)
    const largeurs =
      orientation === 'portrait'
        ? [5, 18, 9, 7, 12, 4, 8, 11, 10, 8, 8]
        : [3, 19, 7, 7, 14, 4, 7, 14, 11, 7, 7];
    const sections = e.sections.map((s, k) => ({
      properties: {
        page: {
          size: {
            orientation:
              orientation === 'portrait'
                ? PageOrientation.PORTRAIT
                : PageOrientation.LANDSCAPE,
          },
          margin: { top: 700, bottom: 700, left: 700, right: 700 },
        },
      },
      children: [
        entete(),
        para(e.titre, { gras: true, taille: 28, centre: true, avant: 240 }),
        para(`${e.sousTitre} — ${s.titre}`, {
          gras: true,
          taille: 20,
          centre: true,
          avant: 60,
        }),
        new Paragraph({ children: [] }),
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          // La largeur utile de la page (en vingtièmes de point) : A4 moins les marges
          columnWidths: largeurs.map(
            (x) => x * (orientation === 'portrait' ? 105 : 150),
          ),
          rows: [
            new TableRow({
              tableHeader: true,
              children: BourseService.COLONNES_PAIEMENT.map((x) =>
                cellule(x, { gras: true, fond: true }),
              ),
            }),
            ...s.lignes.map(
              (l, i) =>
                new TableRow({
                  cantSplit: true,
                  height: { value: 420, rule: HeightRule.ATLEAST },
                  children: [
                    cellule(i + 1),
                    cellule(l.nomComplet),
                    cellule(l.cycle),
                    cellule(l.departement),
                    cellule(l.etablissement),
                    cellule(l.vague),
                    cellule(fcfa(l.montant), { droite: true }),
                    cellule(''),
                    cellule(''),
                    cellule(l.telephone),
                    cellule(l.observation),
                  ],
                }),
            ),
            new TableRow({
              cantSplit: true,
              children: [
                cellule(''),
                cellule('TOTAL', { gras: true }),
                ...Array.from({ length: 4 }, () => cellule('')),
                cellule(fcfa(s.total), { gras: true, droite: true }),
                ...Array.from({ length: 4 }, () => cellule('')),
              ],
            }),
          ],
        }),
        para(
          `Arrêté le présent état à ${s.lignes.length} bénéficiaire(s) et à la somme de : ${s.arrete}`,
          { taille: 18, avant: 200 },
        ),
        para(
          `Fait à Brazzaville, le ${new Date().toLocaleDateString('fr-FR')}`,
          {
            taille: 20,
            droite: true,
            avant: 240,
          },
        ),
        // Une ligne entre « Fait à… » et le titre, comme dans l'Excel (13/11/2026)
        para(e.signature.titre, { taille: 22, droite: true, avant: 300 }),
        // Au moins deux lignes pour la signature (DG, 27/10/2026)
        para('', { taille: 22 }),
        para('', { taille: 22 }),
        para('', { taille: 22 }),
        para(e.signature.nom, {
          gras: true,
          taille: 22,
          droite: true,
        }),
        ...(k === 0 && e.brouillon
          ? [
              para(
                'Projet non validé : à faire valider par le Directeur général avant paiement.',
                { taille: 16, avant: 200 },
              ),
            ]
          : []),
      ],
    }));
    // La police choisie vaut aussi pour les passages qui ne fixent pas la leur (tableaux…)
    const doc = new Document({
      sections,
      ...(choix === 'gill'
        ? { styles: { default: { document: { run: { font: GILL } } } } }
        : {}),
    });
    return {
      nom: `${e.nomFichier}.docx`,
      contenu: await Packer.toBuffer(doc),
    };
  }

  /**
   * Payés deux fois (DG, 28/10/2026 : « il faut les identifier, les lister ») : les personnes
   * inscrites deux fois sur la liste, ou payées aussi sur l'autre liste (volontaires et
   * communautaires), une ligne par paire, pour les retirer à la prochaine bourse.
   */
  async payesDeuxFois(id: number) {
    const etat = await this.etats.findOne({ where: { id } });
    if (!etat) throw new NotFoundException('État de bourse introuvable');
    const doubles = (etat.anomalies as Anomalie[]).filter(
      (a) => a.code === 'DOUBLON' || a.code === 'AUTRE_LISTE',
    );
    const ids = [
      ...new Set(
        doubles
          .flatMap((a) => [a.volontaireId, a.autreId ?? ''])
          .filter(Boolean),
      ),
    ];
    const lignes = new Map(
      (ids.length
        ? await this.lignes.find({
            where: { etatId: id, volontaireId: In(ids) },
          })
        : []
      ).map((l) => [l.volontaireId, l]),
    );
    const fiches = new Map(
      (ids.length
        ? await this.volontaires.find({ where: { id: In(ids) } })
        : []
      ).map((v) => [v.id, v]),
    );
    const deps = new Map((await this.deps.find()).map((d) => [d.id, d.nom]));
    // L'autre liste du même mois (volontaires ↔ communautaires) : y est-il payé, et combien ?
    const [autreEtat] = await this.etats.query<
      { id: number; statut: string }[]
    >(
      `SELECT id, statut FROM etat_bourse WHERE mois = $1 AND population <> $2 LIMIT 1`,
      [etat.mois, etat.population],
    );
    const ailleurs = new Map<string, number>(
      autreEtat && ids.length
        ? (
            await this.lignes.query<{ v: string; total: number }[]>(
              `SELECT "volontaireId" AS v, total FROM ligne_bourse WHERE "etatId" = $1 AND "volontaireId" = ANY($2)`,
              [autreEtat.id, ids],
            )
          ).map((x) => [x.v, Number(x.total)])
        : [],
    );
    const fcfa = (n: number) =>
      `${n.toLocaleString('fr-FR').replace(/\s/g, ' ')} FCFA`;
    const mois = moisEnClair(etat.mois);
    // « d'octobre 2026 », « de septembre 2026 »
    const deMois = /^[aeiou]/i.test(mois.normalize('NFD').replace(/[̀-ͯ]/g, ''))
      ? `d’${mois}`
      : `de ${mois}`;
    /** Où et combien la fiche est payée ce mois, en clair (DG, 13/11/2026). */
    const paiementDe = (v: Volontaire | undefined, paye: number | null) => {
      const listeV = LISTES[populationDe(v?.population ?? etat.population)];
      const qui =
        v?.population === 'COMMUNAUTAIRE' ? 'communautaire' : 'volontaire';
      if (paye !== null)
        return `payé(e) ${fcfa(paye)} dans cet état (${listeV})`;
      if (!v) return 'fiche introuvable';
      if (v.population === etat.population)
        return v.statut === 'SORTI'
          ? `sorti(e) des ${listeV} : pas payé(e) dans cet état`
          : `${qui} en poste, mais pas payé(e) dans cet état (pas encore payable ce mois)`;
      // Fiche de l'autre liste
      const total = ailleurs.get(v.id);
      if (total !== undefined)
        return `payé(e) ${fcfa(total)} sur la liste des ${listeV} ${deMois} (état ${autreEtat.statut === 'VALIDE' ? 'validé' : 'en projet'})`;
      if (v.statut === 'SORTI')
        return `sorti(e) des ${listeV} : pas payé(e) de ce côté`;
      return autreEtat
        ? `${qui} en poste, mais pas dans l'état ${deMois} des ${listeV}`
        : `${qui} en poste : sera payé(e) sur la liste des ${listeV} quand l'état ${deMois} sera préparé`;
    };
    const personne = (vid: string) => {
      const l = lignes.get(vid);
      const v = fiches.get(vid);
      return {
        id: vid,
        nomComplet: l?.nomComplet ?? v?.nomComplet ?? '—',
        liste: LISTES[populationDe(v?.population ?? etat.population)],
        etablissement: l?.etablissement ?? v?.etablissement ?? null,
        departement: l?.departementId
          ? (deps.get(l.departementId) ?? null)
          : null,
        // Le nom du cycle, pas son code (« Collège », pas « COM_COLLEGE »)
        categorie: (() => {
          const code = l?.categorie ?? v?.categorie ?? null;
          return code
            ? (this.config.categorie(code, v?.population ?? etat.population)
                ?.libelle ?? code)
            : null;
        })(),
        // Montant de cet état (null : pas payé sur cette liste ce mois-ci)
        paye: l ? l.total : null,
        // Où et combien elle est payée ce mois (cette liste, l'autre liste, ou pas du tout)
        paiement: paiementDe(v, l ? l.total : null),
        // Pour décider : quelle liste, en poste ou non, entrée quand, née quand
        population: v?.population ?? etat.population,
        statut: v?.statut ?? null,
        entree: v?.creeLe
          ? new Date(v.creeLe).toISOString().slice(0, 10)
          : null,
        naissance: v?.dateNaissance ?? null,
        telephone: v?.telephone ?? null,
      };
    };
    const vues = new Set<string>();
    const paires: {
      code: string;
      controle: string;
      a: ReturnType<typeof personne>;
      b: ReturnType<typeof personne> | null;
    }[] = [];
    for (const d of doubles) {
      // Le doublon est signalé des deux côtés (A ressemble à B, B à A) : une seule ligne
      const cle = `${d.code}|${[d.volontaireId, d.autreId ?? ''].sort().join('|')}`;
      if (vues.has(cle)) continue;
      vues.add(cle);
      paires.push({
        code: d.code,
        controle: CONTROLES[d.code].libelle,
        a: personne(d.volontaireId),
        b: d.autreId ? personne(d.autreId) : null,
      });
    }
    paires.sort((x, y) => x.a.nomComplet.localeCompare(y.a.nomComplet));
    return {
      etat: { id: etat.id, mois: etat.mois, population: etat.population },
      personnes: new Set(
        paires.flatMap((x) => [x.a.id, ...(x.b ? [x.b.id] : [])]),
      ).size,
      paires,
    };
  }

  async payesDeuxFoisExcel(
    id: number,
    police: PoliceDocument = 'actuelle',
  ): Promise<{ nom: string; contenu: Buffer }> {
    const r = await this.payesDeuxFois(id);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Payés deux fois', {
      pageSetup: {
        paperSize: 9,
        orientation: 'landscape',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
      },
    });
    ws.addRow([
      `BOURSE DES ${LISTES[populationDe(r.etat.population)].toUpperCase()} — ${moisEnClair(r.etat.mois).toUpperCase()} : PAYÉS DEUX FOIS`,
    ]).font = { bold: true, size: 13 };
    ws.addRow([
      `${r.paires.length} cas, ${r.personnes} personne(s) : à vérifier, puis à retirer de la prochaine bourse`,
    ]);
    ws.addRow([]);
    const t = ws.addRow([
      'N°',
      'Contrôle',
      'Nom et prénoms',
      'Liste',
      'Établissement',
      'Département',
      'Catégorie',
      'Paiement ce mois',
      'Même personne probable',
      'Liste',
      'Établissement',
      'Département',
      'Catégorie',
      'Paiement ce mois',
    ]);
    t.font = { bold: true };
    t.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    t.eachCell((c) => {
      c.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE4E4E7' },
      };
    });
    const cote = (
      p:
        | Awaited<
            ReturnType<BourseService['payesDeuxFois']>
          >['paires'][number]['a']
        | null,
    ) =>
      p
        ? [
            p.nomComplet,
            p.liste,
            p.etablissement ?? '',
            p.departement ?? '',
            p.categorie ?? '',
            p.paiement,
          ]
        : ['', '', '', '', '', ''];
    r.paires.forEach((x, i) => {
      ws.addRow([i + 1, x.controle, ...cote(x.a), ...cote(x.b)]).alignment = {
        horizontal: 'center',
        vertical: 'middle',
        wrapText: true,
      };
    });
    ws.columns = [6, 26, 30, 14, 26, 16, 10, 12, 30, 14, 26, 16, 10, 12].map(
      (width) => ({ width }),
    );
    ws.views = [{ state: 'frozen', ySplit: t.number }];
    appliquerPolice(wb, police);
    return {
      nom: `Payés deux fois - ${moisEnClair(r.etat.mois)}.xlsx`,
      contenu: Buffer.from(await wb.xlsx.writeBuffer()),
    };
  }

  /**
   * Les chiffres du récapitulatif (« FICHE DE REPARTITION PAR DEPARTEMENT ET PAR CYCLE »), partagés
   * par l'Excel et le Word : un groupe de colonnes par montant de bourse, avec les mots du DG
   * (« Préscolaire-Primaire-Adm. scolaire-DEMA (50.000) »…), une ligne par département (effectif
   * et montant de chaque groupe, puis le total) et les totaux.
   */
  private calculRecap(
    population: string,
    lignes: LigneBourse[],
    nomDep: (d: number | null) => string,
  ) {
    const COURTS: Record<string, string> = {
      PRESCOLAIRE: 'Préscolaire',
      PRIMAIRE: 'Primaire',
      ADMINISTRATION: 'Adm. scolaire',
      BEAUX_ARTS: 'DEMA',
      COLLEGE: 'Collège',
      LYCEE: 'Lycée',
      COM_PRESCOLAIRE: 'Préscolaire',
      COM_PRIMAIRE: 'Primaire',
      COM_ALPHABETISATION: 'Alpha/Resco/ORA',
      COM_ADMINISTRATION: 'Adm. scolaire',
      COM_POST_ALPHA: 'Post-Alpha',
      COM_COLLEGE: 'Collège',
      COM_LYCEE: 'Lycée',
    };
    const ORDRE = Object.keys(COURTS);
    const cats = this.config.categoriesDe(population);
    const tauxDe = (code: string | null) =>
      cats.find((x) => x.code === code)?.bourse ?? 0;
    // Le montant de bourse d'une ligne ; une ligne à 0 (complément seul) prend celui de son cycle
    const tauxLigne = (l: LigneBourse) => l.montant || tauxDe(l.categorie);
    const montantsGroupes = [
      ...new Set([
        ...cats.filter((x) => x.actif && x.bourse > 0).map((x) => x.bourse),
        ...lignes.map(tauxLigne).filter((m) => m > 0),
      ]),
    ].sort((a, b) => a - b);
    // « Sans barème » seulement s'il le faut, et en dernier
    if (lignes.some((l) => !tauxLigne(l))) montantsGroupes.push(0);
    const groupes = montantsGroupes.map((mt) => {
      const noms = [
        ...new Set(
          cats
            .filter(
              (x) =>
                x.bourse === mt &&
                (x.actif || lignes.some((l) => l.categorie === x.code)),
            )
            // L'ordre du DG : Préscolaire-Primaire-Adm. scolaire-DEMA
            .sort(
              (a, b) =>
                (ORDRE.indexOf(a.code) + 1 || 99) -
                (ORDRE.indexOf(b.code) + 1 || 99),
            )
            .map((x) => COURTS[x.code] ?? x.libelle),
        ),
      ];
      return {
        montant: mt,
        libelle: mt
          ? `${noms.join('-') || 'Autres'}\n(${fcfa(mt)})`
          : 'Sans barème\n(compléments, à vérifier)',
      };
    });
    // Une ligne par département, dans l'ordre alphabétique
    const parDep = new Map<string, LigneBourse[]>();
    for (const l of lignes) {
      const d = nomDep(l.departementId);
      parDep.set(d, [...(parDep.get(d) ?? []), l]);
    }
    const totaux = groupes.map(() => ({ eff: 0, mont: 0 }));
    const lignesRecap = [...parDep.entries()]
      .sort(([a], [b]) => a.localeCompare(b, 'fr'))
      .map(([departement, liste]) => {
        const cellules = groupes.map((g, k) => {
          const x = liste.filter((y) => tauxLigne(y) === g.montant);
          const c = {
            eff: x.length,
            mont: x.reduce((s, y) => s + y.total, 0),
          };
          totaux[k].eff += c.eff;
          totaux[k].mont += c.mont;
          return c;
        });
        return {
          departement,
          cellules,
          eff: cellules.reduce((s, c) => s + c.eff, 0),
          mont: cellules.reduce((s, c) => s + c.mont, 0),
        };
      });
    return {
      groupes,
      lignes: lignesRecap,
      totaux,
      effT: totaux.reduce((s, x) => s + x.eff, 0),
      montT: totaux.reduce((s, x) => s + x.mont, 0),
      avecRappels: lignes.some((l) => l.mois > 1),
    };
  }

  async excel(
    id: number,
    police: PoliceDocument = 'actuelle',
    seulRecap = false,
  ): Promise<{ nom: string; contenu: Buffer }> {
    const ep = await this.etatPaiement(id);
    const lignes = await this.lignes.find({ where: { etatId: id } });
    const communautaires = ep.etat.population === 'COMMUNAUTAIRE';
    const deps = new Map((await this.deps.find()).map((d) => [d.id, d.nom]));
    const nomDep = (d: number | null) =>
      d ? (deps.get(d) ?? '') : 'Non renseigné';
    const c = this.config.get();

    const wb = new ExcelJS.Workbook();
    wb.creator = 'SIRHAS';
    const bord: Partial<ExcelJS.Borders> = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' },
    };
    const fmt = '#,##0';
    const nbCol = BourseService.COLONNES_PAIEMENT.length;

    // Les communautaires : la liste unique, puis une feuille par département comme l'état du
    // cabinet (DG, 13/11/2026) ; les volontaires : la liste générale et ses départements
    type Section = (typeof ep.sections)[number] & { feuille?: string };
    const feuilles: Section[] = [...ep.sections];
    if (communautaires) {
      const codes = new Map(
        (await this.deps.find()).map((d) => [d.id, d.code]),
      );
      const tous = ep.sections[0]?.lignes ?? [];
      const pris = new Set<(typeof tous)[number]>();
      const ajouter = (feuille: string, titre: string, liste: typeof tous) => {
        if (!liste.length) return;
        liste.forEach((l) => pris.add(l));
        const total = liste.reduce((t, l) => t + l.montant, 0);
        feuilles.push({
          titre,
          feuille,
          lignes: liste,
          total,
          arrete: montantArrete(total),
        });
      };
      for (const g of FEUILLES_COMMUNAUTAIRES)
        ajouter(
          `ETAT DE PAIEMENT ${g.feuille}`,
          g.titre,
          tous.filter(
            (l) =>
              !!l.departementId &&
              g.codes.includes(codes.get(l.departementId) ?? ''),
          ),
        );
      // Ce qui ne rentre dans aucune feuille (département non renseigné) : une feuille à part
      ajouter(
        'ETAT DE PAIEMENT AUTRES',
        'DÉPARTEMENT NON RENSEIGNÉ',
        tous.filter((l) => !pris.has(l)),
      );
    }

    // Le RECAP seul : pas de listes à écrire
    for (const s of seulRecap ? [] : feuilles) {
      const nom =
        s.feuille ??
        (s.titre === 'LISTE GÉNÉRALE' || s.titre === 'LISTE UNIQUE'
          ? s.titre === 'LISTE UNIQUE'
            ? 'Liste unique'
            : 'Liste générale'
          : s.titre.replace('DÉPARTEMENT : ', ''));
      // La liste générale en portrait sur la largeur (comme le DG l'a réglée), les départements
      // en paysage ; chaque feuille s'imprime telle quelle depuis Excel (DG, 13/11/2026)
      const principale = s === feuilles[0];
      const LIGNE_TITRES = 14;
      const ws = wb.addWorksheet(
        nom.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '),
        {
          pageSetup: {
            orientation: principale ? 'portrait' : 'landscape',
            fitToPage: true,
            fitToWidth: 1,
            fitToHeight: 0,
            paperSize: 9,
            printTitlesRow: `${LIGNE_TITRES}:${LIGNE_TITRES}`,
            margins: principale
              ? {
                  left: 0.2484375,
                  right: 0.21,
                  top: 0.365625,
                  bottom: 0.75,
                  header: 0.3,
                  footer: 0.3,
                }
              : {
                  left: 0.7,
                  right: 0.7,
                  top: 0.75,
                  bottom: 0.75,
                  header: 0.3,
                  footer: 0.3,
                },
          },
        },
      );
      // L'en-tête officiel, celui du récapitulatif mis en forme par le DG : le ministère, le
      // cabinet et la DGRHAS à gauche, la République à droite ; puis le titre et la période
      const ecrire = (
        l: number,
        c1: number,
        c2: number,
        v: string,
        font: Partial<ExcelJS.Font>,
      ) => {
        if (c2 > c1) ws.mergeCells(l, c1, l, c2);
        const cell = ws.getCell(l, c1);
        cell.value = v;
        cell.font = { name: 'Calibri', ...font };
        cell.alignment = {
          horizontal: 'center',
          vertical: 'middle',
          wrapText: true,
        };
      };
      const g12 = { size: 12, bold: true };
      const [g1, g2] = [1, 5];
      const [d1, d2] = [9, nbCol];
      ecrire(1, g1, g2, "MINISTERE DE L'ENSEIGNEMENT PRESCOLAIRE,", g12);
      ecrire(1, d1, d2, 'REPUBLIQUE DU CONGO', g12);
      ecrire(2, g1, g2, "PRIMAIRE, SECONDAIRE ET DE L'ALPHABETISATION", g12);
      ecrire(2, d1, d2, 'Unité - Travail - Progrès', g12);
      ecrire(3, g1, g2, '-----------', g12);
      ecrire(3, d1, d2, '-----------', g12);
      ecrire(4, g1, g2, 'CABINET', g12);
      ecrire(5, g1, g2, '-----------', g12);
      ecrire(6, g1, g2, 'DIRECTION GENERALE DES RESSOURCES HUMAINES', g12);
      ecrire(7, g1, g2, "ET DE L'ADMINISTRATION SCOLAIRE", g12);
      ecrire(8, g1, g2, '-----------', g12);
      ecrire(10, 1, nbCol, ep.titre, { size: 14, bold: true });
      ecrire(12, 1, nbCol, `${ep.sousTitre} — ${s.titre}`, g12);
      for (const [l, h] of [
        [1, 15.75],
        [2, 15.75],
        [3, 9],
        [4, 15],
        [5, 9],
        [6, 15],
        [7, 15],
        [8, 9],
        [9, 9],
        [10, 18.5],
        [11, 7.5],
        [12, 15.75],
        [13, 9],
      ])
        ws.getRow(l).height = h;
      const en = ws.getRow(LIGNE_TITRES);
      en.values = BourseService.COLONNES_PAIEMENT;
      en.height = 29;
      en.font = { bold: true };
      en.eachCell((cell) => {
        cell.border = bord;
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFE5E7EB' },
        };
        cell.alignment = {
          vertical: 'middle',
          horizontal: 'center',
          wrapText: true,
        };
      });
      s.lignes.forEach((l, i) => {
        const r = ws.addRow([
          i + 1,
          l.nomComplet,
          l.cycle,
          l.departement,
          l.etablissement,
          l.vague,
          l.montant,
          '',
          '',
          l.telephone,
          l.observation,
        ]);
        // De la hauteur pour signer
        r.height = 24;
        r.alignment = { vertical: 'middle', wrapText: true };
        r.eachCell({ includeEmpty: true }, (cell) => (cell.border = bord));
        r.getCell(7).numFmt = fmt;
      });
      const tot = ws.addRow(['', 'TOTAL', '', '', '', '', s.total]);
      tot.font = { bold: true };
      tot.getCell(7).numFmt = fmt;
      for (let k = 1; k <= nbCol; k++) tot.getCell(k).border = bord;
      ws.addRow([]);
      ws.addRow([
        `Arrêté le présent état à ${s.lignes.length} bénéficiaire(s) et à la somme de : ${s.arrete}`,
      ]).font = { italic: true };
      ws.addRow([]);
      ws.addRow([
        ...Array<string>(7).fill(''),
        `Fait à Brazzaville, le ${new Date().toLocaleDateString('fr-FR')}`,
      ]);
      // Une ligne entre « Fait à… » et le titre (13/11/2026) ; le titre sans gras, au moins
      // deux lignes, puis le nom en gras (DG, 27/10/2026)
      ws.addRow([]);
      ws.addRow([...Array<string>(7).fill(''), ep.signature.titre]);
      ws.addRow([]);
      ws.addRow([]);
      ws.addRow([]);
      ws.addRow([...Array<string>(7).fill(''), ep.signature.nom]).font = {
        bold: true,
      };
      [5, 32, 13, 12, 28, 7, 13, 26, 18, 14, 24].forEach(
        (w, i) => (ws.getColumn(i + 1).width = w),
      );
      // Pas de volets figés : la feuille défile librement ; les titres des colonnes se répètent
      // à l'impression (printTitlesRow) (13/11/2026)
      ws.views = [{ state: 'normal' }];
    }
    const R = this.calculRecap(ep.etat.population, lignes, nomDep);

    // Récapitulatif, copié sur celui que le DG a mis en forme (« Récapitulatif Bourse Volontaire_
    // Septembre 2026.xlsx », feuille RECAP, 13/11/2026) : en-tête du ministère à gauche et de la
    // République à droite, titre, période, « RÉCAPITULATIF PAR DEPARTEMENT ET PAR CYCLE », un groupe
    // de colonnes par montant de bourse (« Préscolaire-Primaire-Adm. scolaire-DEMA (50.000) »,
    // « Collège (60.000) », « Lycée (75.000) »), le total, l'arrêté en lettres et la signature.
    const ws = wb.addWorksheet('RECAP', {
      pageSetup: {
        orientation: 'landscape',
        paperSize: 9,
        // Toujours sur la largeur d'une page, même avec les colonnes de montants élargies
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        margins: {
          left: 0.6145833333333334,
          right: 0.3854166666666667,
          top: 0.375,
          bottom: 0.2708333333333333,
          header: 0.3,
          footer: 0.3,
        },
      },
    });
    // Vue « Mise en page », comme le DG l'a laissée
    ws.views = [{ style: 'pageLayout' }];
    const groupes = R.groupes;
    const nbColR = 2 + groupes.length * 2 + 2;
    const G = (n: number) => ws.getColumn(n).letter;
    const fusion = (l: number, c1: number, c2: number) => {
      if (c2 > c1) ws.mergeCells(l, c1, l, c2);
    };
    const ecrire = (
      l: number,
      c1: number,
      c2: number,
      v: string,
      font: Partial<ExcelJS.Font>,
      horizontal: 'center' | 'left' = 'center',
    ) => {
      fusion(l, c1, c2);
      const cell = ws.getCell(l, c1);
      cell.value = v;
      cell.font = { name: 'Calibri', ...font };
      cell.alignment = { horizontal, vertical: 'middle' };
    };
    const gauche = Math.min(5, nbColR - 2);
    const dr1 = nbColR - 1;
    const hauteurs: [number, number][] = [
      [1, 15.75],
      [2, 15.75],
      [3, 9],
      [4, 9],
      [5, 9],
      [6, 12],
      [7, 12],
      [8, 12],
      [9, 12],
      [10, 12],
      [11, 9],
      [12, 13.5],
      [13, 13.5],
      [14, 18.75],
      [15, 13.5],
      [17, 29.25],
      [18, 16.5],
    ];
    for (const [l, h] of hauteurs) ws.getRow(l).height = h;
    const g12 = { size: 12, bold: true };
    ecrire(1, 1, gauche, "MINISTERE DE L'ENSEIGNEMENT PRESCOLAIRE,", g12);
    ecrire(1, dr1, nbColR, 'REPUBLIQUE DU CONGO', g12);
    ecrire(2, 1, gauche, "PRIMAIRE, SECONDAIRE ET DE L'ALPHABETISATION", g12);
    ecrire(2, dr1, nbColR, 'Unité - Travail - Progrès', g12);
    ecrire(3, 1, gauche, '-----------', g12);
    ecrire(3, dr1, nbColR, '-----------', g12);
    ecrire(4, 1, gauche, 'CABINET', g12);
    ecrire(5, 1, gauche, '-----------', g12);
    ecrire(6, 1, gauche, 'DIRECTION GENERALE DES RESSOURCES HUMAINES', g12);
    ecrire(7, 1, gauche, "ET DE L'ADMINISTRATION SCOLAIRE", g12);
    ecrire(8, 1, gauche, '-----------', g12);
    ecrire(
      10,
      1,
      nbColR,
      communautaires
        ? 'PAIEMENT DES ENSEIGNANTS COMMUNAUTAIRES'
        : 'BOURSES DES ENSEIGNANTS VOLONTAIRES',
      { size: 14, bold: true },
    );
    const avecRappels = R.avecRappels;
    ecrire(
      12,
      1,
      nbColR,
      `PERIODE : ${moisEnClair(ep.etat.mois)
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toUpperCase()} (1 MOIS${avecRappels ? ' ET RAPPELS' : ''})`,
      g12,
    );
    // Le titre et la ligne vide de plus du modèle « Fiche de répartition » (DG, 13/11/2026)
    ecrire(14, 1, nbColR, 'FICHE DE REPARTITION PAR DEPARTEMENT ET PAR CYCLE', {
      size: 14,
      bold: true,
    });
    // Les titres du tableau (lignes 17 et 18)
    const T = 17;
    const fin: Partial<ExcelJS.Border> = { style: 'thin' };
    const titre = (
      l: number,
      c1: number,
      c2: number,
      v: string,
      font: Partial<ExcelJS.Font>,
      haut = true,
    ) => {
      if (l === T && !haut) ws.mergeCells(T, c1, T + 1, c1);
      else fusion(l, c1, c2);
      for (let k = c1; k <= c2; k++) {
        const cell = ws.getCell(l, k);
        cell.value = v;
        cell.font = { name: 'Calibri', size: 11, ...font };
        cell.alignment = {
          horizontal: 'center',
          vertical: 'middle',
          wrapText: true,
        };
        cell.border = { top: fin, bottom: fin, left: fin, right: fin };
      }
      if (l === T && !haut) {
        const bas = ws.getCell(T + 1, c1);
        bas.border = { top: fin, bottom: fin, left: fin, right: fin };
      }
    };
    titre(T, 1, 1, 'N°', {}, false);
    titre(T, 2, 2, 'Département', {}, false);
    groupes.forEach((g, i) => {
      const c = 3 + i * 2;
      titre(T, c, c + 1, g.libelle, { bold: true });
      titre(T + 1, c, c, 'Effectif', {
        name: 'Gill Sans MT Condensed',
        bold: true,
      });
      titre(T + 1, c + 1, c + 1, 'Montant', {
        name: 'Gill Sans MT Condensed',
        bold: true,
      });
    });
    const cT = nbColR - 1;
    titre(T, cT, nbColR, 'Total', { bold: true });
    titre(T + 1, cT, cT, 'Effectif', {
      name: 'Gill Sans MT Condensed',
      bold: true,
    });
    titre(T + 1, nbColR, nbColR, 'Montant', {
      name: 'Gill Sans MT Condensed',
      bold: true,
    });
    // Une ligne par département (formules : la feuille se corrige dans Excel)
    const compta = '_-* #,##0_-;-* #,##0_-;_-* "-"??_-;_-@_-';
    const premiere = T + 2;
    const deps2 = R.lignes;
    const ecrireCellule = (
      l: number,
      c: number,
      v: ExcelJS.CellValue,
      o: {
        gras?: boolean;
        centre?: boolean;
        fmt?: string;
        taille?: number;
      } = {},
    ) => {
      const cell = ws.getCell(l, c);
      cell.value = v;
      cell.font = { name: 'Calibri', size: o.taille ?? 11, bold: o.gras };
      if (o.centre) cell.alignment = { horizontal: 'center' };
      if (o.fmt) cell.numFmt = o.fmt;
      cell.border = { top: fin, bottom: fin, left: fin, right: fin };
    };
    deps2.forEach((ligne, i) => {
      const l = premiere + i;
      ws.getRow(l).height = 12.75;
      ecrireCellule(l, 1, i + 1, { centre: true, fmt: '#,##0' });
      ecrireCellule(l, 2, ligne.departement);
      const { eff, mont } = ligne;
      groupes.forEach((_, k) => {
        const { eff: e, mont: m } = ligne.cellules[k];
        const c = 3 + k * 2;
        ecrireCellule(l, c, e, { centre: true, fmt: '#,##0' });
        // Le DG a mis le premier montant en petit (9) : on garde sa mise en forme
        ecrireCellule(l, c + 1, m, {
          centre: k < 2,
          fmt: compta,
          taille: k === 0 ? 9 : 11,
        });
      });
      ecrireCellule(
        l,
        cT,
        {
          formula: groupes.map((_, k) => `${G(3 + k * 2)}${l}`).join('+'),
          result: eff,
        },
        { centre: true, fmt: '#,##0' },
      );
      ecrireCellule(
        l,
        nbColR,
        {
          formula: groupes.map((_, k) => `${G(4 + k * 2)}${l}`).join('+'),
          result: mont,
        },
        { fmt: compta },
      );
    });
    const lt = premiere + deps2.length;
    const derniere = lt - 1;
    ws.getRow(lt).height = 12.75;
    ecrireCellule(lt, 1, null, { gras: true, centre: true });
    ecrireCellule(lt, 2, 'TOTAL', { gras: true });
    const somme = (c: number, r: number) => ({
      formula: `SUM(${G(c)}${premiere}:${G(c)}${derniere})`,
      result: r,
    });
    const { totaux, effT, montT } = R;
    groupes.forEach((_, k) => {
      const c = 3 + k * 2;
      ecrireCellule(lt, c, somme(c, totaux[k].eff), {
        gras: true,
        centre: true,
        fmt: '#,##0',
      });
      ecrireCellule(lt, c + 1, somme(c + 1, totaux[k].mont), {
        gras: true,
        centre: k < 2,
        fmt: compta,
        taille: k === 0 ? 9 : 11,
      });
    });
    ecrireCellule(lt, cT, somme(cT, effT), {
      gras: true,
      centre: true,
      fmt: '#,##0',
    });
    ecrireCellule(lt, nbColR, somme(nbColR, montT), {
      gras: true,
      fmt: compta,
    });
    // L'arrêté en lettres, puis la signature à droite (titre, quatre lignes, nom en gras)
    const la = ws.getCell(lt + 2, 1);
    la.value = `Arrêté le présent récapitulatif à la somme de : ${montantArrete(montT)}`;
    la.font = { name: 'Calibri', size: 11, italic: true };
    la.alignment = { horizontal: 'left' };
    const colSig = Math.max(3, nbColR - 2);
    const sig1 = ws.getCell(lt + 4, colSig);
    sig1.value = c.signatairePaiementTitre;
    sig1.font = { name: 'Calibri', size: 11 };
    sig1.alignment = { horizontal: 'left' };
    const sig2 = ws.getCell(lt + 9, colSig);
    sig2.value = c.signatairePaiementNom;
    sig2.font = { name: 'Calibri', size: 11, bold: true };
    sig2.alignment = { horizontal: 'left' };
    // Les largeurs du DG (5 ; 22 ; puis les groupes ; puis le total)
    const LARGEURS_GROUPES = [
      [10.7, 13.2],
      [13.7, 13.7],
      [11.2, 11.2],
    ];
    ws.getColumn(1).width = 5;
    ws.getColumn(2).width = 22;
    // Jamais de « ##### » (13/11/2026) : une colonne de montants est au moins aussi large que son
    // plus grand montant (format comptable, total en gras), un peu plus en Gill Sans MT (plus large)
    const assez = (largeur: number, plusGrand: number) =>
      Math.max(
        largeur,
        (fcfa(plusGrand).length + 4) * (police === 'gill' ? 1.2 : 1.05),
      );
    groupes.forEach((_, k) => {
      const [we, wm] = LARGEURS_GROUPES[k] ?? [11.2, 12.5];
      ws.getColumn(3 + k * 2).width = we;
      ws.getColumn(4 + k * 2).width = assez(wm, R.totaux[k].mont);
    });
    ws.getColumn(cT).width = 13;
    ws.getColumn(nbColR).width = assez(13, R.montT);
    wb.calcProperties.fullCalcOnLoad = true;

    // Le RECAP seul (13/11/2026) : le classeur sans les listes
    if (seulRecap)
      for (const w of wb.worksheets.filter((x) => x.name !== 'RECAP'))
        wb.removeWorksheet(w.id);
    appliquerPolice(wb, police);
    const contenu = Buffer.from(await wb.xlsx.writeBuffer());
    return {
      nom: `${seulRecap ? 'RECAP - ' : ''}${ep.nomFichier}.xlsx`,
      contenu,
    };
  }
}
