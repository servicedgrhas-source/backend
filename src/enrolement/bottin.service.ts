import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { lireClasseur } from '../common/excel';
import { estPdf, lireListePriseEnCharge } from '../common/pdf-pris-en-charge';
import { IndexNoms } from '../common/index-noms';
import { MOIS_RE, moisEnClair } from '../common/mois';
import { motsDuNom, ressemblance } from '../common/ressemblance';
import {
  memeDepartementLarge,
  reconnaitreDiplome,
} from '../common/referentiels';
import { ageRevolu, enTexte, lireDate, normaliser } from '../common/texte';
import { JournalService, ParametresService } from '../core/core.service';
import {
  AgentRecense,
  Departement,
  LigneBottin,
  RegleDiplome,
  Volontaire,
} from '../entities';
import { etape, parcoursDe } from '../recensement/recensement.service';
import { VolontairesService } from './volontaires.service';

/**
 * Bottin de la solde : la liste des agents payés chaque mois (nom, matricule, département, indice,
 * brut, banque). Le DG l'a demandé le 23/10/2026 : la bourse d'un volontaire ne s'arrête pas au texte
 * de la Fonction Publique mais à son premier salaire, que l'on voit dans le bottin. Le pointage, fait
 * jusqu'ici à la main, compare les volontaires en poste au bottin et propose leur sortie du registre.
 */

/** Colonnes reconnues (titres sans accents ni espaces). */
const COLONNES = {
  nom: [
    'NOMSETPRENOMS',
    'NOMETPRENOMS',
    'NOMSPRENOMS',
    'NOMPRENOMS',
    'NOMS',
    'NOM',
  ],
  prenom: ['PRENOMS', 'PRENOM'],
  matricule: [
    'MATRICULESOLDE',
    'MATRICULE',
    'MLE',
    'NUMEROMATRICULE',
    'NMATRICULE',
  ],
  naissance: ['DATEDENAISSANCE', 'DATENAISSANCE', 'NELE', 'NEELE'],
  departement: ['DEPARTEMENT', 'DEPT', 'LOCALITE'],
  grade: ['GRADE', 'EMPLOI'],
  indice: ['INDICESOLDE', 'INDICE'],
  brut: [
    'SALAIREBRUT',
    'BRUT',
    'MONTANTBRUT',
    'TOTALBRUT',
    'NETAPAYER',
    'NET',
    'MONTANT',
  ],
  banque: [
    'BANQUE',
    'DOMICILIATION',
    'ETABLISSEMENTBANCAIRE',
    'MDR',
    'MODEDEREGLEMENT',
  ],
};

function colonne(entetes: string[], noms: string[]) {
  for (const n of noms) {
    const e = entetes.find((x) => x.replace(/_\d+$/, '') === n);
    if (e) return e;
  }
  return null;
}
const entier = (v: unknown) => {
  // Espaces des milliers (y compris l'espace fine insécable) et points retirés
  const t = enTexte(v)
    .split('')
    .filter((c) => !/[\s.]/.test(c) && c.charCodeAt(0) !== 0x202f)
    .join('')
    .replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

export interface PointageBottin {
  volontaire: {
    id: string;
    nomComplet: string;
    dateNaissance: string | null;
    departement: string | null;
    etablissement: string | null;
    categorie: string | null;
    vague: string | null;
    population: string;
  };
  ligne: {
    id: number;
    mois: string;
    matricule: string | null;
    nomComplet: string;
    dateNaissance: string | null;
    departement: string | null;
    grade: string | null;
    indice: number | null;
    brut: number | null;
  };
  /** PROBABLE (même nom et date compatible) ou POSSIBLE (à regarder de près). */
  certitude: 'PROBABLE' | 'POSSIBLE';
  memeDepartement: boolean;
  memeNaissance: boolean;
  /** Autres lignes du bottin qui ressemblent aussi à ce volontaire (homonymes). */
  autres: number;
  /**
   * Statut proposé dans la base du personnel au premier salaire (réglages d'Administration ›
   * Paramètres) : contractuel au-delà de l'âge limite de sa catégorie, sinon fonctionnaire.
   */
  proposition: PropositionStatut;
}

export interface PropositionStatut {
  statut: 'FONCTIONNAIRE' | 'CONTRACTUEL';
  categorie: string | null;
  age: number | null;
  /** Date où l'âge est compté : intégration de la fiche, sinon le mois du premier salaire. */
  dateAge: string;
  ageLimite: number;
  explication: string;
}

@Injectable()
export class BottinService {
  constructor(
    @InjectRepository(LigneBottin)
    private readonly lignes: Repository<LigneBottin>,
    @InjectRepository(Volontaire)
    private readonly volontaires: Repository<Volontaire>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    @InjectRepository(AgentRecense)
    private readonly agents: Repository<AgentRecense>,
    @InjectRepository(RegleDiplome)
    private readonly regles: Repository<RegleDiplome>,
    private readonly registre: VolontairesService,
    private readonly journal: JournalService,
    private readonly params: ParametresService,
  ) {}

  /**
   * Fonctionnaire ou contractuel au premier salaire (règle du DG, réglée dans les Paramètres) :
   * l'âge à l'entrée comparé à l'âge limite de la catégorie (catégorie I : sa propre limite).
   * La catégorie vient de la fiche, sinon du diplôme, sinon de l'indice du bottin.
   */
  private proposer(
    v: Pick<Volontaire, 'dateNaissance' | 'diplome'>,
    ligne: {
      mois: string;
      dateNaissance: string | null;
      indice: number | null;
    },
    fiche: { donnees: Record<string, unknown> } | undefined,
    regles: RegleDiplome[],
  ): PropositionStatut {
    const d = fiche?.donnees ?? {};
    const parDiplome = reconnaitreDiplome(d.DIPLOME_PRO ?? v.diplome, regles);
    const parIndice = ligne.indice
      ? [
          ...new Set(
            regles
              .filter((r) => r.indice === ligne.indice && r.categorie)
              .map((r) => r.categorie!),
          ),
        ]
      : [];
    const categorie =
      enTexte(d.CATEGORIE).trim().toUpperCase() ||
      regles.find((r) => r.code === parDiplome)?.categorie ||
      (parIndice.length === 1 ? parIndice[0] : null);
    const dateAge = lireDate(d.DATE_RECRUTEMENT) ?? `${ligne.mois}-01`;
    const naissance = v.dateNaissance ?? ligne.dateNaissance;
    const age = naissance ? ageRevolu(naissance, dateAge) : null;
    const catI = categorie === 'I';
    const ageLimite = catI
      ? Number(this.params.get('CONTRACTUEL_AGE_LIMITE_CAT_I')) || 35
      : Number(this.params.get('CONTRACTUEL_AGE_LIMITE')) || 30;
    const statut =
      age !== null && age > ageLimite ? 'CONTRACTUEL' : 'FONCTIONNAIRE';
    const quand = dateAge.split('-').reverse().join('/');
    return {
      statut,
      categorie,
      age,
      dateAge,
      ageLimite,
      explication:
        age === null
          ? 'Date de naissance inconnue : fonctionnaire par défaut, à vérifier.'
          : `${age} ans au ${quand} ; ${statut === 'CONTRACTUEL' ? 'au-delà de' : 'pas au-delà de'} ${ageLimite} ans (${catI ? 'catégorie I' : categorie ? `catégorie ${categorie}` : 'catégorie inconnue : règle des catégories II et III'}).`,
    };
  }

  /** Mois déjà importés, avec leur nombre de lignes. */
  async mois() {
    return this.lignes.query<
      { mois: string; n: number; sources: string[]; le: string }[]
    >(
      `SELECT mois, count(*)::int AS n, array_agg(DISTINCT split_part(source, ' · ', 1)) AS sources, max("creeLe") AS le
         FROM ligne_bottin GROUP BY mois ORDER BY mois DESC`,
    );
  }

  /**
   * Import d'un bottin (Excel) pour un mois. Plusieurs fichiers peuvent compléter le même mois
   * (un par département) : une personne déjà importée ce mois (même matricule, ou même nom et
   * même date de naissance) est remplacée, pas doublée.
   */
  async importer(
    u: UtilisateurConnecte,
    contenu: Buffer,
    nomFichier: string,
    o: { mois: string; essai: boolean },
  ) {
    if (!MOIS_RE.test(o.mois ?? ''))
      throw new BadRequestException('Choisissez le mois payé par ce bottin.');
    // PDF de la Solde « Liste des agents pris en charge » (premiers salaires), lu tel quel
    const pdf = estPdf(contenu) ? await lireListePriseEnCharge(contenu) : null;
    if (pdf && !pdf.lignes.length)
      throw new BadRequestException(
        'Ce PDF ne ressemble pas à la « Liste des agents pris en charge » de la Solde : aucune ligne avec un matricule sous les titres NOM, PRENOM, MATRI., DATE NAIS.',
      );
    const feuilles = pdf
      ? []
      : await lireClasseur(contenu, [COLONNES.nom.join('|')]);
    if (!pdf && !feuilles.length)
      throw new BadRequestException(
        'Aucune feuille avec une colonne « Nom » ou « Noms et prénoms ». Un PDF n’est lu que s’il s’agit de la « Liste des agents pris en charge » de la Solde ; un autre PDF se convertit d’abord en Excel.',
      );
    const lues: LigneBottin[] = [];
    const ignorees: string[] = [];
    const colonnesVues = new Set<string>();
    if (pdf) {
      for (const k of [
        'nom',
        'matricule',
        'naissance',
        'grade',
        'indice',
        'brut',
      ])
        colonnesVues.add(k);
      for (const l of pdf.lignes) {
        const nom = `${l.nom} ${l.prenom}`.replace(/\s+/g, ' ').trim();
        lues.push(
          this.lignes.create({
            mois: o.mois,
            matricule: normaliser(l.matricule),
            nomComplet: nom,
            nomNormalise: normaliser(nom),
            dateNaissance: l.dateNaissance,
            departement: l.service?.slice(0, 200) ?? null,
            grade: l.grade?.slice(0, 120) ?? null,
            indice: l.indice,
            brut: l.net,
            banque: l.mdr ? `MDR ${l.mdr}`.slice(0, 120) : null,
            source:
              `${nomFichier} · page ${l.page}${l.referenceTexte ? ` · texte ${l.referenceTexte}` : ''}`.slice(
                0,
                250,
              ),
            importePar: u.nom,
          }),
        );
      }
    }
    for (const f of feuilles) {
      const col = Object.fromEntries(
        Object.entries(COLONNES).map(([k, noms]) => [
          k,
          colonne(f.entetes, noms),
        ]),
      ) as Record<keyof typeof COLONNES, string | null>;
      if (col.prenom === col.nom) col.prenom = null;
      for (const [k, v] of Object.entries(col)) if (v) colonnesVues.add(k);
      for (const l of f.lignes) {
        const nom = [l[col.nom!], col.prenom ? l[col.prenom] : null]
          .map((x) => enTexte(x).trim())
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/g, ' ');
        if (!nom || nom.length < 4 || /^(TOTAL|SOUS[- ]?TOTAL)/i.test(nom)) {
          if (nom)
            ignorees.push(
              `${f.nom}, ligne ${l._ligne} : « ${nom.slice(0, 40)} »`,
            );
          continue;
        }
        const mat = col.matricule
          ? enTexte(l[col.matricule]).replace(/\s/g, '')
          : '';
        lues.push(
          this.lignes.create({
            mois: o.mois,
            matricule: mat ? normaliser(mat) : null,
            nomComplet: nom,
            nomNormalise: normaliser(nom),
            dateNaissance: col.naissance ? lireDate(l[col.naissance]) : null,
            departement: col.departement
              ? enTexte(l[col.departement]).trim() || null
              : null,
            grade: col.grade
              ? enTexte(l[col.grade]).trim().slice(0, 120) || null
              : null,
            indice: col.indice ? entier(l[col.indice]) : null,
            brut: col.brut ? entier(l[col.brut]) : null,
            banque: col.banque
              ? enTexte(l[col.banque]).trim().slice(0, 120) || null
              : null,
            source: `${nomFichier} · ${f.nom} · ligne ${l._ligne}`,
            importePar: u.nom,
          }),
        );
      }
    }
    if (!lues.length)
      throw new BadRequestException('Aucune personne lue dans ce fichier.');
    const cle = (x: {
      matricule: string | null;
      nomNormalise: string;
      dateNaissance: string | null;
    }) => x.matricule ?? `${x.nomNormalise}|${x.dateNaissance ?? ''}`;
    const uniques = new Map<string, LigneBottin>();
    for (const x of lues) uniques.set(cle(x), x);
    const existantes = await this.lignes.query<
      {
        id: number;
        matricule: string | null;
        nomNormalise: string;
        dateNaissance: string | null;
      }[]
    >(
      `SELECT id, matricule, "nomNormalise", to_char("dateNaissance", 'YYYY-MM-DD') AS "dateNaissance" FROM ligne_bottin WHERE mois = $1`,
      [o.mois],
    );
    const remplacees = existantes.filter((x) => uniques.has(cle(x)));
    const rapport = {
      essai: o.essai,
      mois: o.mois,
      // PDF de la Solde : sa date d'édition, pour vérifier le mois choisi
      editeLe: pdf?.editeLe ?? null,
      lues: lues.length,
      enDoubleDansLeFichier: lues.length - uniques.size,
      nouvelles: uniques.size - remplacees.length,
      remplacees: remplacees.length,
      dejaCeMois: existantes.length,
      colonnes: [...colonnesVues],
      sansMatricule: [...uniques.values()].filter((x) => !x.matricule).length,
      ignorees: ignorees.slice(0, 10),
    };
    if (
      !rapport.colonnes.includes('matricule') &&
      !rapport.colonnes.includes('naissance')
    )
      throw new BadRequestException(
        'Ni matricule ni date de naissance dans ce fichier : impossible de distinguer les homonymes. Vérifiez les titres des colonnes.',
      );
    if (o.essai) return rapport;
    await this.lignes.manager.transaction(async (m) => {
      if (remplacees.length)
        await m.delete(
          LigneBottin,
          remplacees.map((x) => x.id),
        );
      const t = [...uniques.values()];
      for (let i = 0; i < t.length; i += 1000)
        await m.save(t.slice(i, i + 1000));
    });
    await this.journal.log(u, 'BOTTIN_IMPORT', 'ligne_bottin', o.mois, {
      fichier: nomFichier,
      lignes: uniques.size,
      remplacees: remplacees.length,
    });
    return rapport;
  }

  async supprimerMois(u: UtilisateurConnecte, mois: string) {
    if (!MOIS_RE.test(mois)) throw new BadRequestException('Mois invalide.');
    const r = await this.lignes.delete({ mois });
    await this.journal.log(u, 'BOTTIN_SUPPRESSION', 'ligne_bottin', mois, {
      lignes: r.affected ?? 0,
    });
    return { supprimees: r.affected ?? 0 };
  }

  /**
   * Pointage : chaque volontaire en poste comparé au bottin (tous les mois importés). Pour chacun
   * retrouvé, le premier mois où il apparaît : c'est son premier salaire, la bourse s'arrête là.
   */
  async pointage(): Promise<{
    resultats: PointageBottin[];
    enPoste: number;
    lignes: number;
  }> {
    const deps = new Map((await this.deps.find()).map((d) => [d.id, d.nom]));
    const vols = await this.volontaires.find({ where: { statut: 'EN_POSTE' } });
    const lignes = await this.lignes.query<
      (PointageBottin['ligne'] & { creeLe: string })[]
    >(
      `SELECT DISTINCT ON (coalesce(matricule, "nomNormalise" || coalesce("dateNaissance"::text, '')))
              id, mois, matricule, "nomComplet", to_char("dateNaissance", 'YYYY-MM-DD') AS "dateNaissance",
              departement, grade, indice, brut, "creeLe"
         FROM ligne_bottin
        ORDER BY coalesce(matricule, "nomNormalise" || coalesce("dateNaissance"::text, '')), mois`,
    );
    const index = new IndexNoms<(typeof lignes)[number]>();
    for (const l of lignes) index.ajouter(l.nomComplet, l.dateNaissance, l);
    const regles = await this.regles.find();
    const fiches = new Map(
      (
        await this.agents.find({
          where: { volontaireId: In(vols.map((v) => v.id)) },
          select: { id: true, volontaireId: true, donnees: true },
        })
      ).map((a) => [a.volontaireId, a]),
    );
    const resultats: PointageBottin[] = [];
    for (const v of vols) {
      const mots = motsDuNom(v.nomComplet);
      const dep = v.departementId ? (deps.get(v.departementId) ?? null) : null;
      const verif = v.verifications?.BOTTIN;
      const candidats = index
        .probables(v.nomComplet, v.dateNaissance)
        // Une ligne déjà écartée (« pas la même personne ») ne revient qu'avec un nouveau bottin
        .filter((l) => !verif || new Date(l.creeLe) > new Date(verif.le));
      if (!candidats.length) continue;
      // La Solde garde les anciens découpages (« Kouilou » pour Pointe-Noire, « BZ/VILLE »)
      const memeDep = (l: (typeof lignes)[number]) =>
        !!dep &&
        !!l.departement &&
        (normaliser(l.departement).includes(normaliser(dep)) ||
          memeDepartementLarge(l.departement, dep));
      candidats.sort(
        (a, b) =>
          Number(memeDep(b)) - Number(memeDep(a)) ||
          a.mois.localeCompare(b.mois),
      );
      const l = candidats[0];
      const ligne: PointageBottin['ligne'] = { ...l };
      delete (ligne as Partial<typeof l>).creeLe;
      resultats.push({
        volontaire: {
          id: v.id,
          nomComplet: v.nomComplet,
          dateNaissance: v.dateNaissance,
          departement: dep,
          etablissement: v.etablissement,
          categorie: v.categorie,
          vague: v.vague,
          population: v.population,
        },
        ligne,
        certitude:
          ressemblance(
            mots,
            v.dateNaissance,
            motsDuNom(l.nomComplet),
            l.dateNaissance,
          ) === 'PROBABLE' &&
          ((!!v.dateNaissance && v.dateNaissance === l.dateNaissance) ||
            memeDep(l))
            ? 'PROBABLE'
            : 'POSSIBLE',
        memeDepartement: memeDep(l),
        memeNaissance: !!v.dateNaissance && v.dateNaissance === l.dateNaissance,
        autres: candidats.length - 1,
        proposition: this.proposer(v, l, fiches.get(v.id), regles),
      });
    }
    resultats.sort(
      (a, b) =>
        a.certitude.localeCompare(b.certitude) * -1 ||
        a.ligne.mois.localeCompare(b.ligne.mois) ||
        a.volontaire.nomComplet.localeCompare(b.volontaire.nomComplet),
    );
    return { resultats, enPoste: vols.length, lignes: lignes.length };
  }

  /**
   * Sortie du registre des volontaires pointés : motif « Recruté à la Fonction Publique », à la
   * date de leur premier salaire. Leur fiche du personnel reçoit le matricule et passe fonctionnaire.
   */
  async sortir(
    u: UtilisateurConnecte,
    choix: { volontaireId: string; ligneId: number; statut?: string }[],
  ) {
    if (!Array.isArray(choix) || !choix.length)
      throw new BadRequestException(
        'Cochez les volontaires à sortir du registre.',
      );
    const res = { sortis: 0, erreurs: [] as string[] };
    for (const c of choix.slice(0, 500)) {
      const l = await this.lignes.findOne({ where: { id: Number(c.ligneId) } });
      if (!l) {
        res.erreurs.push(`Ligne du bottin ${c.ligneId} introuvable`);
        continue;
      }
      try {
        await this.registre.sortir(u, c.volontaireId, {
          motif: 'RECRUTE_FP',
          date: `${l.mois}-01`,
          observation: `Premier salaire au bottin de ${moisEnClair(l.mois)}${l.matricule ? ` (matricule ${l.matricule})` : ''}`,
        });
        if (l.matricule)
          await this.lignes.query(
            `UPDATE agent_recense
                SET donnees = jsonb_set(donnees, '{MATRICULE_SOLDE}', to_jsonb($2::text)), matricule = $2
              WHERE "volontaireId" = $1 AND coalesce(donnees->>'MATRICULE_SOLDE', '') = ''
                AND NOT EXISTS (SELECT 1 FROM agent_recense x WHERE x.matricule = $2)`,
            [c.volontaireId, l.matricule],
          );
        await this.statutAuPremierSalaire(
          c.volontaireId,
          c.statut === 'CONTRACTUEL' ? 'CONTRACTUEL' : 'FONCTIONNAIRE',
          `${l.mois}-01`,
          `Premier salaire au bottin de ${moisEnClair(l.mois)}`,
        );
        res.sortis++;
      } catch (e) {
        res.erreurs.push(`${(e as Error).message}`);
      }
    }
    await this.journal.log(u, 'BOTTIN_POINTAGE', 'volontaire', null, {
      sortis: res.sortis,
      erreurs: res.erreurs.length,
    });
    return res;
  }

  /**
   * La fiche du personnel du volontaire sorti prend le statut choisi (fonctionnaire ou contractuel).
   * La liaison avec le registre la passe déjà « fonctionnaire » ; un contractuel est corrigé ici,
   * et l'étape de son parcours aussi.
   */
  private async statutAuPremierSalaire(
    volontaireId: string,
    statut: 'FONCTIONNAIRE' | 'CONTRACTUEL',
    date: string,
    texte: string,
  ) {
    const a = await this.agents.findOne({ where: { volontaireId } });
    if (!a) return;
    const parcours = parcoursDe(a);
    if (['VOLONTAIRE', 'COMMUNAUTAIRE'].includes(a.statut))
      parcours.push(etape(statut, 'Bottin de la solde', date, texte));
    else if (a.statut === 'FONCTIONNAIRE' && statut === 'CONTRACTUEL') {
      const der = parcours[parcours.length - 1];
      if (der?.statut === 'FONCTIONNAIRE') der.statut = 'CONTRACTUEL';
      else parcours.push(etape(statut, 'Bottin de la solde', date, texte));
    } else return;
    await this.agents.update(a.id, { statut, parcours });
  }

  /** « Pas la même personne » : le volontaire n'est plus proposé tant qu'un nouveau bottin ne le retrouve pas. */
  async ecarter(u: UtilisateurConnecte, volontaireId: string, note: string) {
    return this.registre.verifier(u, volontaireId, {
      controle: 'BOTTIN',
      note,
    });
  }
}
