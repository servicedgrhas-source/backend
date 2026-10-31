import {
  AnomaliesService,
  cleTexte,
  dateFr,
  NAISSANCE_IMPROBABLE,
  naissanceImprobable,
  RESSEMBLE,
  TEXTE_PARTAGE,
} from '../common/anomalies';
import { IndexNoms } from '../common/index-noms';
import { motsDuNom, ressemblance } from '../common/ressemblance';
import {
  type FamilleLot,
  libelleLot,
  romain,
  sqlGroupeQuota,
  sqlLibelleLot,
} from '../common/lots';
import { LotsReceptionService } from './lots-reception.service';
import { SPECIALITE_DU_CYCLE } from './doublons.service';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import {
  champ,
  type FeuilleLue,
  lireClasseur,
  type Ligne,
} from '../common/excel';
import {
  type Cycle,
  codeCycle,
  codeDepartement,
  LIBELLE_CYCLE,
  NOTES_AFFECTATION,
  reconnaitreDiplome,
  type TypeNoteAffectation,
} from '../common/referentiels';
import {
  cleCompacte,
  lireDate,
  nettoyer,
  normaliser,
  romainVersEntier,
} from '../common/texte';
import {
  Affectation,
  Agent,
  Departement,
  Grade,
  RegleDiplome,
} from '../entities';
import { copieGrade, MOTIF_OUBLI_DEJA_AFFECTE } from './calcul';

export interface RapportImport {
  feuilles: { nom: string; lignes: number }[];
  lignesLues: number;
  crees: number;
  misAJour: number;
  ignorees: number;
  /** Lignes d'une personne déjà lue dans une autre feuille : réunies en une seule fiche. */
  fusionnees: number;
  /** Doutes tranchés « même personne » à l'aperçu : fiches mises à jour au lieu d'en créer. */
  memesConfirmees: number;
  /** Fiches déjà enregistrées dont le fichier a rempli des cases vides (spécialité, date…). */
  fichesCompletees: number;
  /** Nombre de cases remplies ainsi, par champ (« Spécialité » : 12…). */
  champsCompletes: Record<string, number>;
  /** Bloc choisi à l'import : quota MEPPSA ou quota « Autres ». */
  groupe: 'MEPPSA' | 'AUTRES' | null;
  /** Textes enregistrés dans le système et gardés malgré le fichier. */
  textesConserves: number;
  affectationsCreees: number;
  /** Lots touchés par l'import, avec leurs personnes par groupe de quota. */
  lots: {
    numero: number;
    libelle: string;
    agents: number;
    meppsa: number;
    autresAvec: number;
    autresSans: number;
  }[];
  anomalies: Record<string, number>;
  /** Même personne deux fois (nom et date de naissance), dans la base ou entre les feuilles. */
  doublons: number;
  /** Numéros de texte écrits pour plusieurs personnes. */
  textesPartages: number;
  /** Anciennes fiches en double (même personne sans date de naissance) écartées. */
  anciennesFichesEcartees: number;
}

function entier(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(typeof v === 'string' ? v.trim() : v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function lotCommission(v: unknown): string | null {
  const s = nettoyer(v);
  if (!s) return null;
  const k = cleCompacte(s);
  if (k.includes('UNIQUE')) return 'Lot unique';
  const m = k.match(/^L(?:OT)?([IVX]+|\d+)$/);
  if (m) return `Lot ${romainVersEntier(m[1]) ?? m[1]}`;
  return s;
}

/** Feuille du quota « Autres » d'après son nom (« Quota Autres », « QA arrêtés… »). */
export function feuilleAutres(nom: string) {
  const k = cleCompacte(nom);
  return k.includes('AUTRE') || /^QA/.test(k);
}

export type LigneLue = Partial<Agent> & {
  lotPublicationNumero: number | null;
  anomalies: string[];
};

const vide = (v: unknown) => v === null || v === undefined || v === '';

/** Champs de la fiche que l'import peut compléter, avec leur nom pour le rapport. */
const CHAMPS_FICHE: Record<string, string> = {
  dateNaissance: 'Date de naissance',
  lieuNaissance: 'Lieu de naissance',
  diplomeCode: 'Diplôme',
  departementId: 'Département',
  source: 'Source',
  cycleBrut: 'Cycle',
  specialite: 'Spécialité',
  qualification: 'Qualification',
  lotCommission: 'Lot de la commission',
  statut: 'Statut',
  observation: 'Observation',
  numeroTexte: 'N° du texte',
  typeTexte: 'Type de texte',
  dateReception: 'Date de réception',
  dateSignatureTexte: 'Date de signature',
  lieuServiceBrut: 'Lieu de service',
  origineBrute: 'Origine',
  parapheur: 'N° parapheur',
};

/**
 * Même personne dans plusieurs feuilles (QA arrêtés avec et sans département : 686 personnes dans
 * le lot 8) : une seule fiche, qui garde ce que chaque ligne apporte (le département surtout).
 */
export function fusionner(a: LigneLue, b: LigneLue) {
  const la = a.lotPublicationNumero;
  const lb = b.lotPublicationNumero;
  if (la !== null && lb !== null && (la !== lb || a.typeTexte !== b.typeTexte))
    a.anomalies.push(
      `Lot de publication différent d'une feuille à l'autre (${romain(la)} et ${romain(lb)})`,
    );
  if (
    a.numeroTexte &&
    b.numeroTexte &&
    cleTexte(a.numeroTexte) !== cleTexte(b.numeroTexte)
  )
    a.anomalies.push(
      `N° de texte différent d'une feuille à l'autre (${a.numeroTexte} et ${b.numeroTexte})`,
    );
  // Valeur reconnue d'une autre ligne : prise avec sa valeur brute
  if (!a.departementId && b.departementId) {
    a.departementId = b.departementId;
    a.departementBrut = b.departementBrut;
  }
  if (!a.diplomeCode && b.diplomeCode) {
    a.diplomeCode = b.diplomeCode;
    a.diplomeBrut = b.diplomeBrut;
  }
  if (!a.dateNaissance && b.dateNaissance) {
    a.dateNaissance = b.dateNaissance;
    a.dateNaissanceBrute = b.dateNaissanceBrute;
  }
  for (const [k, v] of Object.entries(b))
    if (
      k !== 'anomalies' &&
      vide((a as Record<string, unknown>)[k]) &&
      !vide(v)
    )
      (a as Record<string, unknown>)[k] = v;
  a.anomalies = [...new Set([...a.anomalies, ...b.anomalies])].filter((x) => {
    if (x.startsWith('Département')) return !a.departementId;
    if (x.startsWith('Date de naissance')) return !a.dateNaissance;
    if (x.startsWith('Diplôme')) return !a.diplomeCode;
    if (x.startsWith('Lot de publication sans')) return !a.numeroTexte;
    return true;
  });
}

/**
 * Personne ajoutée à la main dans la base des recrutés, sans fichier Excel (DG, 31/10/2026) : elle
 * passe par la même lecture et les mêmes vérifications qu'une ligne du fichier.
 */
export interface FicheManuelle {
  nomComplet: string;
  dateNaissance: string;
  lieuNaissance?: string | null;
  diplomeCode: string;
  departement?: string | null;
  source?: string | null;
  cycle?: string | null;
  specialite?: string | null;
  qualification?: string | null;
  statut?: string | null;
  typeTexte?: 'ARRETE' | 'DECRET' | null;
  numeroTexte?: string | null;
  /** Lot de publication, en chiffres romains (« VIII ») ou arabes. */
  lot?: string | null;
  dateSignatureTexte?: string | null;
  quota?: number | null;
  numeroOrdre?: number | null;
  observation?: string | null;
  /** Grade à la demande (un des autres grades du diplôme, ou celui d'une personne sans diplôme). */
  gradeCode?: string | null;
}

/** Nom de la « feuille » d'une saisie manuelle (journal, doutes). */
export const FEUILLE_MANUELLE = 'Saisie manuelle';

function typeTexte(v: unknown): 'ARRETE' | 'DECRET' | null {
  const k = cleCompacte(v);
  if (k.startsWith('ARRET')) return 'ARRETE';
  if (k.startsWith('DECR')) return 'DECRET';
  return null;
}

@Injectable()
export class ImportBaseService {
  constructor(
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
    @InjectRepository(Affectation)
    private readonly affectations: Repository<Affectation>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    @InjectRepository(RegleDiplome)
    private readonly regles: Repository<RegleDiplome>,
    private readonly anomalies: AnomaliesService,
    private readonly lotsReception: LotsReceptionService,
  ) {}

  /**
   * Ce que contient le classeur, avant l'import : chaque feuille visible, ses lignes, ses lots de
   * publication (« Arrêtés VIII : 53 ») et les personnes déjà vues dans une feuille précédente.
   * Aucun nom n'est renvoyé.
   */
  async apercu(contenu: Buffer | FeuilleLue[], groupe?: 'MEPPSA' | 'AUTRES') {
    const feuilles = await this.feuillesDe(contenu);
    if (!feuilles.length)
      throw new BadRequestException(
        "Aucune feuille visible avec les colonnes « Noms et prénoms » et « Diplôme » n'a été trouvée.",
      );
    // Ce que l'import fera de chaque ligne : fiche retrouvée (mise à jour), nouvelle, ou doute
    const ctx = await this.contexte();
    const fiche = (a: Agent) => this.resume(a);
    const doutes: {
      cle: string;
      feuille: string;
      ligne: number;
      nomComplet: string;
      dateNaissance: string | null;
      diplome: string | null;
      departement: string | null;
      texte: string | null;
      candidats: ReturnType<typeof fiche>[];
    }[] = [];
    const etat = new Map<
      string,
      { retrouvees: number; nouvelles: number; doutes: number }
    >();
    for (const f of feuilles) {
      const quotaAutres = groupe ? groupe === 'AUTRES' : feuilleAutres(f.nom);
      const e = { retrouvees: 0, nouvelles: 0, doutes: 0 };
      etat.set(f.nom, e);
      for (const l of f.lignes) {
        if (!nettoyer(champ(l, 'NOMSETPRENOMS'))) continue;
        const data = this.lireLigne(l, quotaAutres, ctx.deps, ctx.regles);
        if (this.ficheSure(data, ctx)) {
          e.retrouvees++;
          continue;
        }
        const c = this.fichesDouteuses(data, ctx);
        if (!c.length) {
          e.nouvelles++;
          continue;
        }
        e.doutes++;
        doutes.push({
          cle: `${f.nom}|${l._ligne}`,
          feuille: f.nom,
          ligne: l._ligne,
          nomComplet: data.nomComplet!,
          dateNaissance: data.dateNaissance ?? null,
          diplome: data.diplomeBrut ?? null,
          departement: data.departementBrut ?? null,
          texte: data.numeroTexte ?? null,
          candidats: c.slice(0, 4).map(fiche),
        });
      }
    }
    const vues = new Set<string>();
    const res = feuilles.map((f) => {
      const lots: Record<string, number> = {};
      let lignes = 0;
      let avecDepartement = 0;
      let dejaVues = 0;
      let sansLot = 0;
      const ici = new Set<string>();
      for (const l of f.lignes) {
        const nom = nettoyer(champ(l, 'NOMSETPRENOMS'));
        if (!nom) continue;
        lignes++;
        const naissance = lireDate(champ(l, 'DATEDENAIS'));
        const k = `${normaliser(nom)}|${naissance ?? ''}`;
        if (vues.has(k)) dejaVues++;
        ici.add(k);
        let dep = nettoyer(champ(l, 'DEPARTEMENT', 'DEPART'));
        const source = nettoyer(champ(l, 'SOURCE'));
        if (cleCompacte(dep) === 'MEPPSA' && codeDepartement(source))
          dep = source;
        if (codeDepartement(dep)) avecDepartement++;
        const n = romainVersEntier(
          nettoyer(champ(l, 'LOTDEPUBLICAT', 'LOTDEPUBLICATION')),
        );
        if (n === null) {
          sansLot++;
          continue;
        }
        const t =
          typeTexte(champ(l, 'TYPEDETEXTE')) === 'DECRET'
            ? 'Décrets'
            : 'Arrêtés';
        const cle = `${t} — lot ${romain(n)}`;
        lots[cle] = (lots[cle] ?? 0) + 1;
      }
      for (const k of ici) vues.add(k);
      return {
        nom: f.nom,
        lignes,
        ...etat.get(f.nom),
        groupe: feuilleAutres(f.nom) ? 'AUTRES' : 'MEPPSA',
        avecDepartement,
        dejaVues,
        sansLot,
        lots: Object.entries(lots)
          .sort(([a], [b]) => a.localeCompare(b, 'fr', { numeric: true }))
          .map(([libelle, n]) => ({ libelle, n })),
      };
    });
    return { feuilles: res, personnes: vues.size, doutes };
  }

  /**
   * Import de la base d'affectation (DG, 30/10/2026) : un bloc pour le quota MEPPSA, un pour le
   * quota « Autres » (avec ou sans département) ; on peut ne prendre que certaines feuilles. Chaque
   * personne est rangée dans le lot de publication écrit dans le fichier (« Arrêtés — lot VIII »).
   */
  /** Les fiches déjà enregistrées, rangées pour retrouver une personne du fichier. */
  private async feuillesDe(contenu: Buffer | FeuilleLue[]) {
    return Array.isArray(contenu)
      ? contenu
      : lireClasseur(contenu, ['NOMSETPRENOMS', 'DIPLOME']);
  }

  /** Une fiche existante, telle que montrée pour trancher un doute. */
  private resume(a: Agent) {
    return {
      id: a.id,
      nomComplet: a.nomComplet,
      dateNaissance: a.dateNaissance,
      liste:
        a.feuille === 'QUOTA_AUTRES'
          ? 'Quota « Autres »'
          : `Quota ${a.quota ?? '?'}`,
      diplome: a.diplomeBrut,
      departement: a.departement?.nom ?? a.departementBrut,
      texte: a.numeroTexte,
      lot: a.lotPublication ? libelleLot(a.lotPublication) : null,
    };
  }

  /** La saisie manuelle écrite comme une ligne du fichier Excel (mêmes colonnes). */
  private async ligneManuelle(f: FicheManuelle): Promise<FeuilleLue[]> {
    const nom = nettoyer(f.nomComplet);
    if (!nom) throw new BadRequestException('Noms et prénoms obligatoires');
    if (!lireDate(f.dateNaissance))
      throw new BadRequestException('Date de naissance obligatoire');
    const regle = await this.regles.findOne({ where: { code: f.diplomeCode } });
    if (!regle) throw new BadRequestException('Diplôme inconnu');
    const ligne: Ligne = {
      _ligne: 1,
      NOMSETPRENOMS: nom,
      DATEDENAIS: f.dateNaissance,
      LIEUDENAIS: f.lieuNaissance ?? null,
      // Écrit comme dans le fichier : la reconnaissance du diplôme est la même
      DIPLOME: regle.ecritures?.[0] ?? regle.libelle,
      DEPARTEMENT: f.departement ?? null,
      SOURCE: f.source ?? null,
      CYCLE: f.cycle ?? null,
      SPECIALITE: f.specialite ?? null,
      QUALIFICATION: f.qualification ?? null,
      STATUT: f.statut ?? null,
      TYPEDETEXTE:
        f.typeTexte === 'DECRET'
          ? 'Décret'
          : f.typeTexte === 'ARRETE'
            ? 'Arrêté'
            : null,
      NTEXTE: f.numeroTexte ?? null,
      LOTDEPUBLICAT: f.lot ?? null,
      DATEDESIGNATURE: f.dateSignatureTexte ?? null,
      QUOTA: f.quota ?? null,
      NDORDRE: f.numeroOrdre ?? null,
      OBS: f.observation ?? null,
    };
    return [{ nom: FEUILLE_MANUELLE, lignes: [ligne], entetes: [] }];
  }

  /**
   * Avant l'ajout manuel : ce que le système fera de la personne. Fiche déjà enregistrée (mise à
   * jour), fiches qui lui ressemblent (à trancher), anomalies, cycle, note et lot qu'elle rejoindra.
   */
  async verifierManuelle(f: FicheManuelle, groupe: 'MEPPSA' | 'AUTRES') {
    const feuilles = await this.ligneManuelle(f);
    const ctx = await this.contexte();
    const data = this.lireLigne(
      feuilles[0].lignes[0],
      groupe === 'AUTRES',
      ctx.deps,
      ctx.regles,
    );
    const sure = this.ficheSure(data, ctx);
    const existante = sure ? ctx.existants.get(sure) : undefined;
    const regle = data.diplomeCode
      ? ctx.regles.get(data.diplomeCode)
      : undefined;
    const typeNote = regle?.typeNote as TypeNoteAffectation | undefined;
    const n = data.lotPublicationNumero;
    return {
      existante: existante ? this.resume(existante) : null,
      doutes: existante
        ? []
        : this.fichesDouteuses(data, ctx)
            .slice(0, 4)
            .map((a) => this.resume(a)),
      anomalies: data.anomalies ?? [],
      cycle: regle
        ? (LIBELLE_CYCLE[regle.cycle as Cycle] ?? regle.cycle)
        : null,
      note: typeNote
        ? (NOTES_AFFECTATION[typeNote]?.libelle ?? typeNote)
        : null,
      grade: regle?.grade ?? null,
      lot:
        n !== null && n !== undefined
          ? `${data.typeTexte === 'DECRET' ? 'Décrets' : 'Arrêtés'} — lot ${romain(n)}`
          : null,
    };
  }

  /**
   * Ajout manuel : la personne est enregistrée comme une ligne du fichier (même clé, mêmes
   * contrôles, rangée dans son lot, affectation créée pour la note de son diplôme). Si elle
   * ressemble à une fiche, il faut dire laquelle (« même personne ») ou que c'en est une autre.
   */
  async ajouterManuelle(
    f: FicheManuelle,
    groupe: 'MEPPSA' | 'AUTRES',
    choix: { meme?: string | null; autrePersonne?: boolean } = {},
    par = '',
  ) {
    const v = await this.verifierManuelle(f, groupe);
    // Grade à la demande : permis par le diplôme (vérifié avant tout enregistrement)
    const regle = await this.regles.findOne({ where: { code: f.diplomeCode } });
    let grade: Grade | null = null;
    if (f.gradeCode && f.gradeCode !== regle?.gradeCode) {
      if (!regle?.gradesAutres?.includes(f.gradeCode))
        throw new BadRequestException(
          'Ce grade n’est pas permis pour ce diplôme (Règles des diplômes et grades)',
        );
      grade = await this.regles.manager.findOne(Grade, {
        where: { code: f.gradeCode },
      });
      if (!grade) throw new NotFoundException('Grade introuvable');
    }
    if (choix.meme && !v.doutes.some((d) => d.id === choix.meme))
      throw new BadRequestException(
        'La fiche choisie ne fait pas partie des fiches qui ressemblent',
      );
    if (v.doutes.length && !choix.meme && !choix.autrePersonne)
      throw new BadRequestException(
        'Cette personne ressemble à une fiche déjà enregistrée : dites si c’est la même personne ou une autre.',
      );
    const feuilles = await this.ligneManuelle(f);
    const rapport = await this.importer(feuilles, {
      groupe,
      memes: choix.meme ? { [`${FEUILLE_MANUELLE}|1`]: choix.meme } : undefined,
    });
    // La fiche enregistrée : celle choisie, celle retrouvée, ou la nouvelle (même clé que l'import)
    const ctx = await this.contexte();
    const data = this.lireLigne(
      feuilles[0].lignes[0],
      groupe === 'AUTRES',
      ctx.deps,
      ctx.regles,
    );
    const cle =
      (choix.meme ? ctx.parId.get(choix.meme)?.cle : null) ??
      this.ficheSure(data, ctx) ??
      data.cle!;
    const agent = ctx.existants.get(cle);
    if (!agent) throw new NotFoundException('Fiche introuvable après l’ajout');
    if (grade) {
      agent.gradeChoisi = copieGrade(grade, par);
      await this.agents.update(agent.id, { gradeChoisi: agent.gradeChoisi });
    }
    // Nouvelle fiche : dans la liste des oubliés, contrôlée avant d'entrer dans une note
    const cree = rapport.crees > 0;
    if (cree)
      await this.agents.update(agent.id, {
        oubli: 'A_CONTROLER',
        saisiePar: par || null,
      });
    const affectation = await this.affectations.findOne({
      where: { agentId: agent.id },
      loadEagerRelations: false,
    });
    return {
      id: agent.id,
      nomComplet: agent.nomComplet,
      cree,
      anomalies: agent.anomalies ?? [],
      lot: agent.lotPublication ? libelleLot(agent.lotPublication) : null,
      affectation: affectation
        ? { typeNote: affectation.typeNote, statut: affectation.statut }
        : null,
    };
  }

  private async contexte() {
    const deps = new Map((await this.deps.find()).map((d) => [d.code, d]));
    const regles = new Map((await this.regles.find()).map((r) => [r.code, r]));
    const tous = await this.agents.find();
    const existants = new Map(tous.map((a) => [a.cle, a]));
    const parId = new Map(tous.map((a) => [a.id, a]));
    const parNom = new Map<string, Agent[]>();
    const index = new IndexNoms<Agent>();
    for (const a of tous) {
      const k = `${a.feuille}|${a.nomNormalise}`;
      (parNom.get(k) ?? parNom.set(k, []).get(k)!).push(a);
      index.ajouter(a.nomComplet, a.dateNaissance, a);
    }
    // Fiches saisies dans le système, retrouvées par nom + date de naissance
    const saisies = new Map(
      tous
        .filter((a) => a.origineFiche === 'SAISIE')
        .map((a) => [`${a.nomNormalise}|${a.dateNaissance}`, a]),
    );
    return { deps, regles, existants, parId, parNom, index, saisies };
  }

  /**
   * La fiche existante d'une ligne du fichier, quand on est sûr : même clé ; fiche saisie au même
   * nom et à la même date ; même nom et même feuille avec la même date ou le même n° de texte.
   */
  private ficheSure(
    data: LigneLue,
    ctx: Awaited<ReturnType<ImportBaseService['contexte']>>,
  ): string | null {
    if (ctx.existants.has(data.cle!)) return data.cle!;
    const s = ctx.saisies.get(`${data.nomNormalise}|${data.dateNaissance}`);
    if (s) return s.cle;
    const t = cleTexte(data.numeroTexte);
    const c = (
      ctx.parNom.get(`${data.feuille}|${data.nomNormalise}`) ?? []
    ).filter(
      (x) =>
        (!!data.dateNaissance && x.dateNaissance === data.dateNaissance) ||
        (!!t && cleTexte(x.numeroTexte) === t),
    );
    return c.length === 1 ? c[0].cle : null;
  }

  /**
   * Doute (DG, 31/10/2026) : pas de fiche sûre, mais des fiches qui ressemblent (nom proche et même
   * date, même nom sans date, ou même nom écrit pareil avec une autre date). À la personne qui
   * importe de dire « même personne : mettre à jour » ; sinon une nouvelle fiche est créée.
   */
  private fichesDouteuses(
    data: LigneLue,
    ctx: Awaited<ReturnType<ImportBaseService['contexte']>>,
  ) {
    const vus = new Set<string>();
    return [
      ...ctx.index.probables(data.nomComplet!, data.dateNaissance ?? null),
      ...ctx.index.memesNoms(data.nomComplet!),
    ].filter((a) => !vus.has(a.id) && !!vus.add(a.id));
  }

  async importer(
    contenu: Buffer | FeuilleLue[],
    options: {
      groupe?: 'MEPPSA' | 'AUTRES';
      feuilles?: string[];
      /** Doutes tranchés à l'aperçu : « feuille|n° de ligne » → fiche à mettre à jour. */
      memes?: Record<string, string>;
    } = {},
  ): Promise<RapportImport> {
    const toutes = await this.feuillesDe(contenu);
    if (!toutes.length)
      throw new BadRequestException(
        "Aucune feuille visible avec les colonnes « Noms et prénoms » et « Diplôme » n'a été trouvée.",
      );
    const feuilles = options.feuilles?.length
      ? toutes.filter((f) => options.feuilles!.includes(f.nom))
      : toutes;
    if (!feuilles.length)
      throw new BadRequestException('Aucune des feuilles choisies.');

    const ctx = await this.contexte();
    const { deps, regles, existants } = ctx;
    // Personnes à ranger dans le lot de publication du fichier
    const aRanger: { agent: Agent; famille: FamilleLot; numero: number }[] = [];

    const rapport: RapportImport = {
      feuilles: feuilles.map((f) => ({ nom: f.nom, lignes: f.lignes.length })),
      lignesLues: 0,
      crees: 0,
      misAJour: 0,
      ignorees: 0,
      fusionnees: 0,
      memesConfirmees: 0,
      fichesCompletees: 0,
      champsCompletes: {},
      groupe: options.groupe ?? null,
      textesConserves: 0,
      affectationsCreees: 0,
      lots: [],
      anomalies: {},
      doublons: 0,
      textesPartages: 0,
      anciennesFichesEcartees: 0,
    };
    const aSauver: Agent[] = [];

    // 1. Lecture : une personne présente dans plusieurs feuilles n'a qu'une fiche
    const lues = new Map<string, LigneLue>();
    for (const f of feuilles) {
      const quotaAutres = options.groupe
        ? options.groupe === 'AUTRES'
        : feuilleAutres(f.nom);
      for (const l of f.lignes) {
        const nom = nettoyer(champ(l, 'NOMSETPRENOMS'));
        if (!nom) {
          rapport.ignorees++;
          continue;
        }
        rapport.lignesLues++;
        const data = this.lireLigne(l, quotaAutres, deps, regles);
        // « Même personne » coché à l'aperçu : la fiche choisie est mise à jour
        const choisie = options.memes?.[`${f.nom}|${l._ligne}`];
        const cle =
          (choisie ? ctx.parId.get(choisie)?.cle : null) ??
          this.ficheSure(data, ctx) ??
          data.cle!;
        const confirmee = choisie ? ctx.parId.get(choisie) : undefined;
        if (confirmee) {
          rapport.memesConfirmees++;
          // Même personne : ses informations sont complétées, sa liste (quota) ne change pas
          data.feuille = confirmee.feuille;
          data.quota = confirmee.quota;
          data.numeroOrdre = confirmee.numeroOrdre ?? data.numeroOrdre;
        }
        data.cle = cle;
        const deja = lues.get(cle);
        if (deja) {
          fusionner(deja, data);
          rapport.fusionnees++;
        } else lues.set(cle, data);
      }
    }

    // 2. Enregistrement de chaque personne
    {
      for (const data of lues.values()) {
        const cle = data.cle!;
        // Lot de publication du fichier (« VIII ») : la personne y est rangée
        const lotNum = data.lotPublicationNumero;
        delete (data as { lotPublicationNumero?: unknown })
          .lotPublicationNumero;
        for (const a of data.anomalies ?? [])
          rapport.anomalies[a.split(' (')[0]] =
            (rapport.anomalies[a.split(' (')[0]] ?? 0) + 1;

        const ex = existants.get(cle);
        // Texte de la FP enregistré dans le système : le système fait foi
        if (ex?.textePointeLe) {
          data.typeTexte = ex.typeTexte;
          data.numeroTexte = ex.numeroTexte;
          data.dateReception = ex.dateReception;
          data.dateSignatureTexte = ex.dateSignatureTexte;
          rapport.textesConserves++;
        }
        if (ex?.transmissionNumero && !data.transmissionNumero)
          data.transmissionNumero = ex.transmissionNumero;
        // Dossier mis de côté (ou déjà corrigé) dans le système : le système fait foi
        if (ex?.misDeCoteLe) {
          data.transmissionNumero = ex.transmissionNumero;
          data.transmission = ex.transmission;
          for (const k of [
            'nomComplet',
            'dateNaissance',
            'lieuNaissance',
            'diplomeCode',
            'diplomeBrut',
            'departementId',
            'lotCommission',
          ] as const)
            (data as Record<string, unknown>)[k] = ex[k];
        }
        // Case lot vide au réimport : le lot déjà connu est gardé (une case vide n'efface rien)
        const avecTexte =
          !!ex?.textePointeLe || lotNum !== null || !!ex?.lotPublicationId;
        // Valeurs de la fiche avant la mise à jour : Object.assign écrit dans `ex` lui-même,
        // il faut donc les lire avant, sinon les corrections faites dans le système sont perdues
        const avant = ex
          ? {
              dateNaissance: ex.dateNaissance,
              departementId: ex.departementId,
              diplomeCode: ex.diplomeCode,
            }
          : null;
        // Fiche déjà enregistrée : le fichier complète et met à jour, une case vide n'efface rien
        let apport: Partial<Agent> = data;
        if (ex) {
          apport = Object.fromEntries(
            Object.entries(data).filter(
              ([k, v]) => k === 'anomalies' || !vide(v),
            ),
          );
          let complete = false;
          for (const [k, nom] of Object.entries(CHAMPS_FICHE))
            if (
              vide((ex as unknown as Record<string, unknown>)[k]) &&
              !vide((apport as Record<string, unknown>)[k])
            ) {
              rapport.champsCompletes[nom] =
                (rapport.champsCompletes[nom] ?? 0) + 1;
              complete = true;
            }
          if (complete) rapport.fichesCompletees++;
        }
        const agent = Object.assign(ex ?? new Agent(), apport, {
          cle,
          // Rangé plus bas dans le lot de son paquet, de son quota et de son type
          lotPublicationId: avecTexte ? (ex?.lotPublicationId ?? null) : null,
          // Valeurs saisies dans le système conservées si absentes du fichier
          dateSignatureTexte:
            data.dateSignatureTexte ?? ex?.dateSignatureTexte ?? null,
          contractuelForce: ex?.contractuelForce ?? null,
        });
        if (ex && avant) {
          // Une correction faite dans le système (date de naissance, département donné par la
          // répartition du quota « Autres », diplôme) n'est pas écrasée par une case vide du fichier
          if (!data.dateNaissance && avant.dateNaissance)
            agent.dateNaissance = avant.dateNaissance;
          // …ni par une date impossible du fichier (« 2018 » corrigé en « 1988 »)
          const aujourdhui = new Date().toISOString().slice(0, 10);
          if (
            data.dateNaissance &&
            avant.dateNaissance &&
            naissanceImprobable(data.dateNaissance, aujourdhui) &&
            !naissanceImprobable(avant.dateNaissance, aujourdhui)
          ) {
            agent.dateNaissance = avant.dateNaissance;
            data.anomalies = (data.anomalies ?? []).filter(
              (x) => !x.startsWith(NAISSANCE_IMPROBABLE),
            );
          }
          if (!data.departementId && avant.departementId)
            agent.departementId = avant.departementId;
          if (!data.diplomeCode && avant.diplomeCode)
            agent.diplomeCode = avant.diplomeCode;
          // Anomalies déjà corrigées ou vérifiées à la main : on ne les remet pas
          const verifiees = new Set(ex.anomaliesVerifiees ?? []);
          agent.anomaliesVerifiees = ex.anomaliesVerifiees ?? [];
          agent.anomalies = (data.anomalies ?? []).filter((x) => {
            if (verifiees.has(x.split(' (')[0])) return false;
            if (x.startsWith(NAISSANCE_IMPROBABLE)) return true;
            if (x.startsWith('Date de naissance')) return !agent.dateNaissance;
            if (x.startsWith('Département')) return !agent.departementId;
            if (x.startsWith('Diplôme')) return !agent.diplomeCode;
            return true;
          });
          rapport.misAJour++;
        } else rapport.crees++;
        // Les colonnes *Id font foi : on retire les relations chargées
        delete (agent as Partial<Agent>).lotPublication;
        delete (agent as Partial<Agent>).departement;
        aSauver.push(agent);
        // Le lot écrit dans la base fait foi, même pour un texte enregistré à la réception
        if (lotNum !== null)
          aRanger.push({
            agent,
            famille: agent.typeTexte === 'DECRET' ? 'DECRET' : 'ARRETE',
            numero: lotNum,
          });
      }
    }

    for (let i = 0; i < aSauver.length; i += 500)
      await this.agents.save(aSauver.slice(i, i + 500));

    // Rangement : lot de publication écrit dans le fichier (arrêtés et décrets à part)
    await this.lotsReception.rangerParFichier(
      aRanger.map((x) => ({
        id: x.agent.id,
        famille: x.famille,
        numero: x.numero,
      })),
    );
    await this.lotsReception.nettoyer();

    rapport.affectationsCreees = await this.creerAffectations(deps, regles);
    rapport.lots = await this.agents.query<RapportImport['lots']>(
      `SELECT l.numero, ${sqlLibelleLot('l')} AS libelle, count(*)::int AS agents,
         count(*) FILTER (WHERE g = 'MEPPSA')::int AS meppsa,
         count(*) FILTER (WHERE g = 'AUTRES_AVEC')::int AS "autresAvec",
         count(*) FILTER (WHERE g = 'AUTRES_SANS')::int AS "autresSans"
       FROM (SELECT a."lotPublicationId", ${sqlGroupeQuota('a')} AS g FROM agent a
             WHERE a.id = ANY($1)) x
       JOIN lot_publication l ON l.id = x."lotPublicationId"
       GROUP BY l.id ORDER BY l."typeTexte", l."numeroFichier", l.numero`,
      [aSauver.map((a) => a.id)],
    );
    rapport.anciennesFichesEcartees = await this.ecarterAnciennesFiches();
    const signalements = await this.signalerDoublons();
    rapport.doublons = signalements.doublons;
    rapport.textesPartages = signalements.textesPartages;
    for (const [k, n] of [
      ['Ressemble à une autre fiche', signalements.doublons],
      [TEXTE_PARTAGE, signalements.textesPartages],
    ] as const)
      if (n) rapport.anomalies[k] = n;
    await this.anomalies.reconcilier();
    return rapport;
  }

  /**
   * Même personne enregistrée deux fois par une base précédente (DG, 30/10/2026) : même feuille,
   * même nom, même n° de texte, l'une des fiches sans date de naissance (illisible dans l'ancien
   * fichier). Si celle-ci n'est dans aucune note, son affectation est écartée (motif écrit, on peut
   * la réintégrer) et la ressemblance est déclarée vérifiée : la fiche complète n'est pas bloquée.
   */
  async ecarterAnciennesFiches(): Promise<number> {
    const paires = await this.agents.query<
      {
        garde: string;
        gardeNom: string;
        ecarte: string;
        ecarteNom: string;
        affectation: string | null;
      }[]
    >(`
      SELECT DISTINCT ON (b.id) a.id AS garde, a."nomComplet" AS "gardeNom",
        b.id AS ecarte, b."nomComplet" AS "ecarteNom", fb.id AS affectation
      FROM agent a
      JOIN agent b ON b.feuille = a.feuille AND b."nomNormalise" = a."nomNormalise" AND b.id <> a.id
      LEFT JOIN affectation fa ON fa."agentId" = a.id
      LEFT JOIN affectation fb ON fb."agentId" = b.id
      WHERE a."dateNaissance" IS NOT NULL AND b."dateNaissance" IS NULL
        AND a."numeroTexte" IS NOT NULL
        AND upper(replace(a."numeroTexte", ' ', '')) = upper(replace(b."numeroTexte", ' ', ''))
        AND (fa.statut IS NULL OR fa.statut <> 'EXCLU')
        AND (fb.id IS NULL OR (fb.statut = 'A_TRAITER' AND fb."noteId" IS NULL))
      ORDER BY b.id, a."lotPublicationId" DESC NULLS LAST`);
    if (!paires.length) return 0;
    const ids = paires
      .map((p) => p.affectation)
      .filter((x): x is string => !!x);
    for (let i = 0; i < ids.length; i += 500)
      await this.affectations.update(
        { id: In(ids.slice(i, i + 500)) },
        {
          statut: 'EXCLU',
          motifExclusion:
            "Fiche en double d'une base précédente (même nom, même texte, sans date de naissance) : la personne est suivie sur sa fiche complète",
          traitePar: 'Import de la base',
        },
      );
    // « Ressemble à … » vérifiée sur les deux fiches : la fiche complète n'est plus bloquée
    for (const p of paires)
      for (const [id, autre] of [
        [p.garde, p.ecarteNom],
        [p.ecarte, p.gardeNom],
      ])
        await this.agents.query(
          `UPDATE agent SET "anomaliesVerifiees" = "anomaliesVerifiees" || to_jsonb($2::text),
             anomalies = (SELECT coalesce(jsonb_agg(x), '[]'::jsonb) FROM jsonb_array_elements_text(anomalies) x
                          WHERE x NOT LIKE $3)
           WHERE id = $1 AND NOT "anomaliesVerifiees" ? $2`,
          [id, `${RESSEMBLE}${autre}`, `${RESSEMBLE}${autre}%`],
        );
    return paires.length;
  }

  /**
   * Après l'import, toute la base est comparée (pas seulement le fichier ; les fiches écartées non) :
   * - même personne enregistrée deux fois : « Ressemble à NOM (né(e) le …) », avec la même
   *   règle que la saisie (même date de naissance et nom concordant, ou nom complet repris) ;
   * - même n° de texte pour plusieurs personnes : « N° de texte partagé (6758, avec NOM) ».
   * Une anomalie déjà déclarée vérifiée n'est pas remise. Renvoie le nombre de fiches signalées.
   */
  async signalerDoublons(): Promise<{
    doublons: number;
    textesPartages: number;
  }> {
    // Fiches écartées (affectation exclue : doublon d'une base précédente…) : hors comparaison
    const ecartees = new Set(
      (
        await this.affectations.find({
          where: { statut: 'EXCLU' },
          select: ['agentId'],
          loadEagerRelations: false,
        })
      ).map((f) => f.agentId),
    );
    const fiches = (
      await this.agents.find({
        select: [
          'id',
          'nomComplet',
          'nomNormalise',
          'dateNaissance',
          'numeroTexte',
          'anomalies',
          'anomaliesVerifiees',
        ],
        loadEagerRelations: false,
      })
    ).filter((f) => !ecartees.has(f.id));
    const mots = new Map(fiches.map((f) => [f.id, motsDuNom(f.nomNormalise)]));
    const ajouts = new Map<string, Set<string>>();
    const ajouter = (id: string, anomalie: string) =>
      (ajouts.get(id) ?? ajouts.set(id, new Set()).get(id)!).add(anomalie);

    // Personnes : on ne compare que les fiches qui ont au moins un mot du nom en commun
    const parMot = new Map<string, number[]>();
    fiches.forEach((f, i) => {
      for (const m of new Set(mots.get(f.id)))
        (parMot.get(m) ?? parMot.set(m, []).get(m)!).push(i);
    });
    const vus = new Set<string>();
    const signalees = new Set<string>();
    for (const groupe of parMot.values())
      for (let x = 0; x < groupe.length; x++)
        for (let y = x + 1; y < groupe.length; y++) {
          const a = fiches[groupe[x]];
          const b = fiches[groupe[y]];
          const paire = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
          if (vus.has(paire)) continue;
          vus.add(paire);
          if (
            ressemblance(
              mots.get(a.id)!,
              a.dateNaissance,
              mots.get(b.id)!,
              b.dateNaissance,
            ) !== 'PROBABLE'
          )
            continue;
          const libelle = (f: Agent) =>
            `${RESSEMBLE}${f.nomComplet}${f.dateNaissance ? ` (né(e) le ${dateFr(f.dateNaissance)})` : ''}`;
          ajouter(a.id, libelle(b));
          ajouter(b.id, libelle(a));
          signalees.add(a.id).add(b.id);
        }

    // Textes : même numéro pour plusieurs personnes
    const parTexte = new Map<string, Agent[]>();
    for (const f of fiches) {
      const k = cleTexte(f.numeroTexte);
      if (k) (parTexte.get(k) ?? parTexte.set(k, []).get(k)!).push(f);
    }
    for (const liste of parTexte.values()) {
      if (liste.length < 2) continue;
      for (const f of liste) {
        const autres = liste
          .filter((o) => o.id !== f.id)
          .map((o) => o.nomComplet);
        ajouter(
          f.id,
          `${TEXTE_PARTAGE} (${f.numeroTexte}, avec ${autres.slice(0, 2).join(', ')}${autres.length > 2 ? '…' : ''})`,
        );
      }
    }

    // Écriture : seulement les fiches dont les anomalies changent
    const motif = (x: string) => x.split(' (')[0];
    for (const f of fiches) {
      const nouvelles = ajouts.get(f.id);
      if (!nouvelles) continue;
      const verifiees = new Set(f.anomaliesVerifiees ?? []);
      const actuelles = f.anomalies ?? [];
      const manquantes = [...nouvelles].filter(
        (x) => !actuelles.includes(x) && !verifiees.has(motif(x)),
      );
      if (manquantes.length)
        await this.agents.update(f.id, {
          anomalies: [...actuelles, ...manquantes],
        });
    }
    // Seules les ressemblances qui restent à vérifier sont comptées
    const aVerifier = (f: Agent, debut: string) =>
      [...(ajouts.get(f.id) ?? [])].some(
        (x) =>
          x.startsWith(debut) &&
          !(f.anomaliesVerifiees ?? []).includes(motif(x)),
      );
    return {
      doublons: fiches.filter(
        (f) => signalees.has(f.id) && aVerifier(f, RESSEMBLE),
      ).length,
      textesPartages: fiches.filter((f) => aVerifier(f, TEXTE_PARTAGE)).length,
    };
  }

  private lireLigne(
    l: Ligne,
    quotaAutres: boolean,
    deps: Map<string, Departement>,
    regles: Map<string, RegleDiplome>,
  ): LigneLue {
    const anomalies: string[] = [];
    const nomComplet = nettoyer(champ(l, 'NOMSETPRENOMS'))!;
    const nomNormalise = normaliser(nomComplet);

    const naissanceBrute = champ(l, 'DATEDENAIS');
    const dateNaissance = lireDate(naissanceBrute);
    if (!dateNaissance)
      anomalies.push(
        naissanceBrute
          ? 'Date de naissance illisible'
          : 'Date de naissance absente',
      );
    else if (
      naissanceImprobable(dateNaissance, new Date().toISOString().slice(0, 10))
    )
      anomalies.push(`${NAISSANCE_IMPROBABLE} (${dateFr(dateNaissance)})`);

    let departementBrut = nettoyer(champ(l, 'DEPARTEMENT', 'DEPART'));
    let source = nettoyer(champ(l, 'SOURCE'));
    // Colonnes Département / Source inversées dans certaines lignes
    if (cleCompacte(departementBrut) === 'MEPPSA' && codeDepartement(source)) {
      [departementBrut, source] = [source, departementBrut];
      anomalies.push('Colonnes Département/Source inversées (corrigé)');
    }
    const codeDep = codeDepartement(departementBrut);
    if (!codeDep)
      anomalies.push(
        departementBrut ? 'Département non reconnu' : 'Département absent',
      );

    const diplomeBrut = nettoyer(champ(l, 'DIPLOME'));
    const diplomeCode = reconnaitreDiplome(diplomeBrut, [...regles.values()]);
    if (!diplomeCode) anomalies.push('Diplôme non reconnu');

    const cycleBrut = nettoyer(champ(l, 'CYCLE'));
    const regle = diplomeCode ? regles.get(diplomeCode) : undefined;
    const cb = codeCycle(cycleBrut);
    if (regle && cb && cb !== regle.cycle)
      anomalies.push('Cycle de la base différent de celui du diplôme');

    const lotBrut = nettoyer(champ(l, 'LOTDEPUBLICAT', 'LOTDEPUBLICATION'));
    const lotPublicationNumero = lotBrut ? romainVersEntier(lotBrut) : null;
    if (lotBrut && lotPublicationNumero === null)
      anomalies.push(`Lot de publication invalide (${lotBrut})`);

    const tt = typeTexte(champ(l, 'TYPEDETEXTE'));
    const numeroTexte = nettoyer(champ(l, 'NTEXTE', 'NDUTEXTE'));
    const receptionBrute = champ(l, 'DATEDERECEPTION');
    if (
      cleCompacte(receptionBrute) === 'DOUBLON' ||
      cleCompacte(lotBrut) === 'DOUBLON'
    )
      anomalies.push('Signalé comme doublon dans la base');
    if (lotPublicationNumero !== null && !numeroTexte)
      anomalies.push('Lot de publication sans numéro de texte');

    const quota = entier(champ(l, 'QUOTA'));
    const numeroOrdre = entier(champ(l, 'NDORDRE'));
    // Quota MEPPSA : quota + n° d'ordre + nom ; sans ces colonnes (fichier nettoyé du 31/10/2026),
    // la date de naissance, sinon deux homonymes seraient réunis en une seule fiche
    const naissanceCle = dateNaissance ?? normaliser(naissanceBrute);
    const cle = quotaAutres
      ? `QA|${nomNormalise}|${naissanceCle}`
      : quota !== null && numeroOrdre !== null
        ? `M|${quota}|${numeroOrdre}|${nomNormalise}`
        : `M|${nomNormalise}|${naissanceCle}`;

    return {
      cle,
      feuille: quotaAutres ? 'QUOTA_AUTRES' : 'MEPPSA',
      quota,
      numeroOrdre,
      numeroListe: entier(champ(l, 'NLISTE')),
      nomComplet,
      nomNormalise,
      dateNaissance,
      dateNaissanceBrute:
        naissanceBrute instanceof Date ? null : nettoyer(naissanceBrute),
      lieuNaissance: nettoyer(champ(l, 'LIEUDENAIS')),
      diplomeBrut,
      diplomeCode,
      departementBrut,
      departementId: codeDep ? deps.get(codeDep)!.id : null,
      source,
      cycleBrut,
      lotCommission: lotCommission(champ(l, 'LOT')),
      statut: nettoyer(champ(l, 'STATUT')),
      transmission: nettoyer(champ(l, 'TRANSMISSION')),
      transmissionNumero: entier(
        nettoyer(champ(l, 'TRANSMISSION'))?.match(/^\d+/)?.[0],
      ),
      parapheur: nettoyer(champ(l, 'NPARAPHEUR')),
      lieuServiceBrut: nettoyer(champ(l, 'LIEUDESERVICE')),
      origineBrute: nettoyer(champ(l, 'ORIGINE')),
      observation: nettoyer(champ(l, 'OBS', 'OBSERVATION')),
      qualification: nettoyer(champ(l, 'QUALIFICATION')),
      specialite: nettoyer(champ(l, 'SPECIALITE')),
      typeTexte: tt,
      numeroTexte,
      dateSignatureTexte: lireDate(
        champ(l, 'DATEDESIGNATURE', 'DATESIGNATURE'),
      ),
      dateReception: lireDate(receptionBrute),
      lotPublicationNumero,
      anomalies,
    };
  }

  /**
   * Personnes sans lot de publication (DG, 31/10/2026) : texte de la FP pas encore reçu, ou lot
   * illisible dans le fichier. Elles n'ont pas d'affectation et n'entrent dans aucune note.
   */
  async sansLot() {
    const fiches = await this.agents.find({
      where: { lotPublicationId: IsNull() },
      order: { nomComplet: 'ASC' },
    });
    const regles = new Map((await this.regles.find()).map((r) => [r.code, r]));
    const illisible = (a: Agent) =>
      (a.anomalies ?? []).find((x) =>
        x.startsWith('Lot de publication invalide'),
      );
    return {
      total: fiches.length,
      meppsa: fiches.filter((a) => a.feuille !== 'QUOTA_AUTRES').length,
      autres: fiches.filter((a) => a.feuille === 'QUOTA_AUTRES').length,
      illisibles: fiches.filter((a) => illisible(a)).length,
      personnes: fiches.map((a) => ({
        id: a.id,
        nomComplet: a.nomComplet,
        dateNaissance: a.dateNaissance,
        liste:
          a.feuille === 'QUOTA_AUTRES'
            ? 'Quota « Autres »'
            : `Quota ${a.quota ?? 'MEPPSA'}`,
        diplome:
          (a.diplomeCode ? regles.get(a.diplomeCode)?.libelle : null) ??
          a.diplomeBrut,
        departement: a.departement?.nom ?? null,
        typeTexte: a.typeTexte,
        numeroTexte: a.numeroTexte,
        // « Lot de publication invalide (VIIII) » : ce qui était écrit dans le fichier
        lotIllisible: illisible(a)?.match(/\((.*)\)/)?.[1] ?? null,
        oubli: a.oubli,
      })),
    };
  }

  /**
   * Range les personnes choisies dans un lot du fichier (« Arrêtés — lot VIII »), créé au besoin,
   * comme l'import : leur affectation est créée pour la note de leur diplôme.
   */
  async rangerDansLot(ids: string[], famille: FamilleLot, numero: number) {
    if (!Number.isInteger(numero) || numero < 1 || numero > 200)
      throw new BadRequestException('Numéro de lot invalide (de I à CC)');
    const libres = await this.agents.find({
      where: { id: In(ids), lotPublicationId: IsNull() },
      select: ['id'],
      loadEagerRelations: false,
    });
    if (!libres.length)
      throw new BadRequestException(
        'Ces personnes ont déjà un lot : rien à ranger.',
      );
    const liste = libres.map((a) => a.id);
    // Le type de texte suit le lot choisi (arrêté ou décret)
    await this.agents.update({ id: In(liste) }, { typeTexte: famille });
    await this.lotsReception.rangerParFichier(
      liste.map((id) => ({ id, famille, numero })),
    );
    const affectationsCreees = await this.creerAffectations();
    // « Lot de publication invalide » n'a plus lieu d'être
    await this.anomalies.reconcilier(liste);
    return {
      ranges: liste.length,
      lot: `${famille === 'DECRET' ? 'Décrets' : 'Arrêtés'} — lot ${romain(numero)}`,
      affectationsCreees,
    };
  }

  /** Crée l'affectation par défaut de chaque agent dont le texte est reçu. */
  async creerAffectations(
    deps?: Map<string, Departement>,
    regles?: Map<string, RegleDiplome>,
  ): Promise<number> {
    deps ??= new Map((await this.deps.find()).map((d) => [d.code, d]));
    regles ??= new Map((await this.regles.find()).map((r) => [r.code, r]));
    const depsParId = new Map([...deps.values()].map((d) => [d.id, d]));

    // Département et spécialité arrivés avec un nouveau fichier : repris par l'affectation qui
    // n'en avait pas encore (et pas encore dans une note)
    await this.affectations.query(`
      UPDATE affectation f SET "departementId" = a."departementId"
      FROM agent a WHERE a.id = f."agentId" AND f."departementId" IS NULL
        AND a."departementId" IS NOT NULL AND f.statut = 'A_TRAITER' AND f."noteId" IS NULL`);
    await this.affectations.query(`
      UPDATE affectation f SET specialite = a.specialite
      FROM agent a WHERE a.id = f."agentId" AND coalesce(trim(f.specialite), '') = ''
        AND coalesce(trim(a.specialite), '') <> '' AND f.statut = 'A_TRAITER' AND f."noteId" IS NULL`);

    // Lot modifié dans le fichier pour une affectation pas encore dans une note
    await this.affectations.query(`
      UPDATE affectation f SET "lotPublicationId" = a."lotPublicationId"
      FROM agent a WHERE a.id = f."agentId" AND a."lotPublicationId" IS NOT NULL
        AND a."lotPublicationId" <> f."lotPublicationId" AND f.statut = 'A_TRAITER'`);

    const sans = await this.agents.find({
      where: { lotPublicationId: Not(IsNull()) },
      select: [
        'id',
        'diplomeCode',
        'departementId',
        'lotPublicationId',
        'specialite',
        'oubli',
      ],
      loadEagerRelations: false,
    });
    const avec = new Set(
      (
        await this.affectations.find({
          select: ['agentId'],
          loadEagerRelations: false,
        })
      ).map((a) => a.agentId),
    );
    const nouvelles = sans
      .filter((a) => !avec.has(a.id))
      .map((a) => {
        const regle = a.diplomeCode ? regles.get(a.diplomeCode) : undefined;
        const typeNote = regle?.typeNote ?? 'A_DEFINIR';
        const dep = a.departementId
          ? depsParId.get(a.departementId)
          : undefined;
        return this.affectations.create({
          agentId: a.id,
          lotPublicationId: a.lotPublicationId!,
          typeNote,
          departementId: a.departementId,
          structure:
            typeNote === 'PERS_ADM' && dep ? `DDEPPSA ${dep.nom}` : null,
          // Primaire, préscolaire : la spécialité est le cycle (DG, 31/10/2026)
          specialite: a.specialite || SPECIALITE_DU_CYCLE[typeNote] || null,
          // Oublié déclaré déjà affecté : hors des notes dès que son texte arrive
          ...(a.oubli === 'DEJA_AFFECTE'
            ? { statut: 'EXCLU', motifExclusion: MOTIF_OUBLI_DEJA_AFFECTE }
            : { statut: 'A_TRAITER' }),
        });
      });
    for (let i = 0; i < nouvelles.length; i += 500)
      await this.affectations.insert(nouvelles.slice(i, i + 500));
    return nouvelles.length;
  }
}
