import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  AlignmentType,
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
  WidthType,
} from 'docx';
import ExcelJS from 'exceljs';
import { DataSource, LessThan, Not, Repository } from 'typeorm';
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
const fcfa = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

export type Gravite = 'BLOQUANT' | 'SIGNALE';

export interface Anomalie {
  code: string;
  gravite: Gravite;
  volontaireId: string;
  nomComplet: string;
  message: string;
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
    const signaler = (v: Volontaire, code: string, message: string) => {
      if (v.verifications?.[code]) return; // vérifié à la main
      anomalies.push({
        code,
        gravite: CONTROLES[code].gravite,
        volontaireId: v.id,
        nomComplet: v.nomComplet,
        message,
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
        if (age < c.ageMinimum || age > c.ageMaximum)
          signaler(v, 'AGE', `${age} ans.`);
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
        );
        signaler(
          autre.v,
          'DOUBLON',
          `Même personne probable que ${x.v.nomComplet} (${x.v.etablissement ?? 'établissement inconnu'}).`,
        );
      }
      index.ajouter(x.v.nomComplet, x.v.dateNaissance, x);
    }
    // Sur les deux listes à la fois (volontaire et communautaire) : payé deux fois
    const autres = new IndexNoms<Volontaire>();
    for (const v of await this.volontaires.find({
      where: { statut: 'EN_POSTE', population: Not(population) },
    }))
      autres.ajouter(v.nomComplet, v.dateNaissance, v);
    for (const x of calculs) {
      const a = autres.probables(x.v.nomComplet, x.v.dateNaissance)[0];
      if (a)
        signaler(
          x.v,
          'AUTRE_LISTE',
          `Aussi sur la liste des ${LISTES[populationDe(a.population)]} : ${a.nomComplet} (${a.etablissement ?? 'établissement inconnu'}).`,
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
      sousTitre: `${communautaires ? 'PAIEMENT' : 'BOURSE'} DU MOIS DE ${moisEnClair(etat.mois).toUpperCase()}${brouillon ? ' (PROJET NON VALIDÉ)' : ''}`,
      brouillon,
      sections,
      signature: {
        titre: c.signatairePaiementTitre,
        nom: c.signatairePaiementNom,
      },
      nomFichier: `${communautaires ? 'Communautaires' : 'Bourse'} ${etat.mois}${brouillon ? ' (projet)' : ''}`,
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

  /** État de paiement en Word (paysage) : chaque liste sur ses pages, signée. */
  async word(id: number): Promise<{ nom: string; contenu: Buffer }> {
    const e = await this.etatPaiement(id);
    const police = 'Times New Roman';
    const texte = (
      t: string,
      o: { gras?: boolean; taille?: number; souligne?: boolean } = {},
    ) =>
      new TextRun({
        text: t,
        bold: o.gras,
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
            children: [texte(String(t), { gras: o.gras, taille: 15 })],
          }),
        ],
      });
    // Largeurs en pourcentage : la place de l'émargement et de la CNI, remplis à la main
    // La CNI s'écrit à la main : une colonne large (DG, 28/10/2026)
    const largeurs = [3, 19, 7, 7, 14, 4, 7, 14, 11, 7, 7];
    const sections = e.sections.map((s, k) => ({
      properties: {
        page: {
          size: { orientation: PageOrientation.LANDSCAPE },
          margin: { top: 700, bottom: 700, left: 700, right: 700 },
        },
      },
      children: [
        para('RÉPUBLIQUE DU CONGO', { gras: true, taille: 18, centre: true }),
        para('Unité * Travail * Progrès', { taille: 16, centre: true }),
        para(
          'MINISTÈRE DE L’ENSEIGNEMENT PRÉSCOLAIRE, PRIMAIRE, SECONDAIRE ET DE L’ALPHABÉTISATION',
          { gras: true, taille: 18, centre: true, avant: 120 },
        ),
        para(
          'DIRECTION GÉNÉRALE DES RESSOURCES HUMAINES ET DE L’ADMINISTRATION SCOLAIRE',
          { gras: true, taille: 16, centre: true },
        ),
        para(e.titre, { gras: true, taille: 24, centre: true, avant: 240 }),
        para(`${e.sousTitre} — ${s.titre}`, {
          gras: true,
          taille: 20,
          centre: true,
          avant: 60,
        }),
        new Paragraph({ children: [] }),
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          columnWidths: largeurs.map((x) => x * 150),
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
        para(e.signature.titre, { taille: 22, droite: true, avant: 120 }),
        // Au moins deux lignes pour la signature (DG, 27/10/2026)
        para('', { taille: 22 }),
        para('', { taille: 22 }),
        para('', { taille: 22 }),
        para(e.signature.nom, {
          gras: true,
          souligne: true,
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
    const doc = new Document({ sections });
    return {
      nom: `${e.nomFichier}.docx`,
      contenu: await Packer.toBuffer(doc),
    };
  }

  async excel(id: number): Promise<{ nom: string; contenu: Buffer }> {
    const ep = await this.etatPaiement(id);
    const lignes = await this.lignes.find({ where: { etatId: id } });
    const communautaires = ep.etat.population === 'COMMUNAUTAIRE';
    const deps = new Map((await this.deps.find()).map((d) => [d.id, d.nom]));
    const nomDep = (d: number | null) =>
      d ? (deps.get(d) ?? '') : 'Non renseigné';
    const enClair = moisEnClair(ep.etat.mois).toUpperCase();
    const brouillon = ep.brouillon;
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

    for (const s of ep.sections) {
      const nom =
        s.titre === 'LISTE GÉNÉRALE' || s.titre === 'LISTE UNIQUE'
          ? s.titre === 'LISTE UNIQUE'
            ? 'Liste unique'
            : 'Liste générale'
          : s.titre.replace('DÉPARTEMENT : ', '');
      const ws = wb.addWorksheet(
        nom.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '),
        {
          pageSetup: {
            orientation: 'landscape',
            fitToPage: true,
            fitToWidth: 1,
            fitToHeight: 0,
            paperSize: 9,
            printTitlesRow: '8:8',
          },
        },
      );
      const centre = (t: string, gras = true, taille = 11) => {
        const r = ws.addRow([t]);
        ws.mergeCells(r.number, 1, r.number, nbCol);
        r.alignment = { horizontal: 'center' };
        r.font = { bold: gras, size: taille };
      };
      centre('RÉPUBLIQUE DU CONGO');
      centre('Unité * Travail * Progrès', false, 9);
      centre(
        'MINISTÈRE DE L’ENSEIGNEMENT PRÉSCOLAIRE, PRIMAIRE, SECONDAIRE ET DE L’ALPHABÉTISATION',
      );
      centre(
        'DIRECTION GÉNÉRALE DES RESSOURCES HUMAINES ET DE L’ADMINISTRATION SCOLAIRE',
      );
      centre(ep.titre, true, 13);
      centre(`${ep.sousTitre} — ${s.titre}`, true, 11);
      ws.addRow([]);
      const en = ws.addRow(BourseService.COLONNES_PAIEMENT);
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
      // Le titre sans gras, au moins deux lignes, puis le nom en gras (DG, 27/10/2026)
      ws.addRow([...Array<string>(7).fill(''), ep.signature.titre]);
      ws.addRow([]);
      ws.addRow([]);
      ws.addRow([]);
      ws.addRow([...Array<string>(7).fill(''), ep.signature.nom]).font = {
        bold: true,
        underline: true,
      };
      [5, 32, 13, 12, 28, 7, 13, 26, 18, 14, 24].forEach(
        (w, i) => (ws.getColumn(i + 1).width = w),
      );
      ws.views = [{ state: 'frozen', ySplit: en.number }];
    }
    lignes.sort((a, b) =>
      nomDep(a.departementId).localeCompare(nomDep(b.departementId), 'fr'),
    );
    const parDep = new Map<string, LigneBourse[]>();
    for (const l of lignes)
      parDep.set(nomDep(l.departementId), [
        ...(parDep.get(nomDep(l.departementId)) ?? []),
        l,
      ]);
    [...parDep.values()].forEach((x) =>
      x.sort((a, b) => a.nomComplet.localeCompare(b.nomComplet, 'fr')),
    );

    // Récapitulatif : effectif et montant par département et par montant de bourse
    const montants = [...new Set(lignes.map((l) => l.montant))].sort(
      (a, b) => a - b,
    );
    const ws = wb.addWorksheet('RECAP');
    const t = ws.addRow([
      `RÉCAPITULATIF ${communautaires ? 'DU PAIEMENT DES COMMUNAUTAIRES' : 'DE LA BOURSE'} DU MOIS DE ${enClair}${brouillon ? ' (PROJET NON VALIDÉ)' : ''}`,
    ]);
    t.font = { bold: true, size: 12 };
    ws.addRow([]);
    const e = ws.addRow([
      'N°',
      'Département',
      ...montants.flatMap((mt) =>
        mt
          ? [`Effectif à ${fcfa(mt)}`, `Montant à ${fcfa(mt)}`]
          : ['Sans barème (à corriger)', 'Montant'],
      ),
      'Rappels',
      'Effectif total',
      'Montant total (FCFA)',
    ]);
    e.font = { bold: true };
    e.eachCell((cell) => {
      cell.border = bord;
      cell.alignment = {
        wrapText: true,
        horizontal: 'center',
        vertical: 'middle',
      };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE5E7EB' },
      };
    });
    const totaux = new Array<number>(montants.length * 2 + 3).fill(0);
    [...parDep.entries()].forEach(([d, liste], i) => {
      const val = montants.flatMap((mt) => {
        const x = liste.filter((l) => l.montant === mt);
        return [x.length, x.reduce((s, l) => s + l.total, 0)];
      });
      val.push(
        liste.filter((l) => l.mois > 1).length,
        liste.length,
        liste.reduce((s, l) => s + l.total, 0),
      );
      val.forEach((n, k) => (totaux[k] += n));
      const r = ws.addRow([i + 1, d, ...val]);
      r.eachCell({ includeEmpty: true }, (cell) => {
        cell.border = bord;
        if (typeof cell.value === 'number') cell.numFmt = fmt;
      });
    });
    const rt = ws.addRow(['', 'TOTAL', ...totaux]);
    rt.font = { bold: true };
    rt.eachCell({ includeEmpty: true }, (cell) => {
      cell.border = bord;
      if (typeof cell.value === 'number') cell.numFmt = fmt;
    });
    ws.addRow([]);
    ws.addRow([
      `Arrêté le présent récapitulatif à la somme de : ${montantArrete(totaux[totaux.length - 1])}`,
    ]).font = { italic: true };
    ws.addRow([]);
    ws.addRow(['', '', '', '', c.signatairePaiementTitre]);
    ws.addRow([]);
    ws.addRow([]);
    ws.addRow([]);
    ws.addRow(['', '', '', '', c.signatairePaiementNom]).font = {
      bold: true,
      underline: true,
    };
    ws.getColumn(1).width = 5;
    ws.getColumn(2).width = 22;
    for (let k = 3; k <= totaux.length + 2; k++) ws.getColumn(k).width = 15;

    const contenu = Buffer.from(await wb.xlsx.writeBuffer());
    return { nom: `${ep.nomFichier}.xlsx`, contenu };
  }
}
