import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DEPARTEMENTS } from '../common/referentiels';
import { normaliser } from '../common/texte';
import { ParametresService } from '../core/core.service';
import { Parametre } from '../entities';

/**
 * Configuration de l'enrôlement : tout ce qui peut changer d'une année à l'autre ou d'une
 * décision à l'autre (barèmes, règles de début et de fin de bourse, motifs de sortie…).
 * Réglée par le DG dans l'application, rien n'est figé dans le code.
 *
 * Valeurs par défaut : celles des documents signés de 2026 (bourse de septembre, fiche de
 * mise en route de la note n° 1006, devis de la note n° 1038).
 */

/** Catégorie de bourse : montant mensuel et mise d'équipement, reconnue dans les fichiers par mots-clés. */
export interface CategorieBourse {
  code: string;
  libelle: string;
  /** Bourse mensuelle (FCFA). */
  bourse: number;
  /** Mise d'équipement versée une fois à la mise en route (FCFA). */
  equipement: number;
  /** Mots reconnus dans la colonne « Cycle » des fichiers (sans accents, en majuscules). */
  motsCles: string[];
  actif: boolean;
}

/** Frais de transport de la mise en route vers un département (vides : pas encore fixés). */
export interface TransportDepartement {
  billet: number | null;
  bagages: number | null;
}

/** Motif de sortie d'un volontaire (recruté à la Fonction Publique, déserteur…). */
export interface MotifSortie {
  code: string;
  libelle: string;
  /** La sortie arrête la bourse. */
  arreteBourse: boolean;
  /** Le volontaire peut être réintégré (« à rétablir »). */
  reintegrable: boolean;
  /** Le mois de la sortie est-il encore payé ? */
  dernierMoisPaye: 'MOIS_PRECEDENT' | 'MOIS_DE_SORTIE';
  actif: boolean;
}

export type DebutBourse =
  | 'MOIS_NOTE'
  | 'MOIS_SUIVANT_NOTE'
  | 'MOIS_PRISE_SERVICE'
  | 'MOIS_SUIVANT_PRISE_SERVICE';

export interface ConfigEnrolement {
  version: 1;
  categories: CategorieBourse[];
  /**
   * Barème des communautaires (liste payée chaque mois, par département et par cycle). Montant à 0 :
   * pas encore fixé par le DG, la liste est bloquée tant qu'il ne l'est pas.
   */
  categoriesCommunautaires: CategorieBourse[];
  /** Année d'enrôlement de la 1re vague de volontaires (2019 : 1re vague 2019-2020, 2026 : 8e). */
  premiereVague: number;
  /** Par code de département (BOUENZA, BRAZZAVILLE…). */
  transport: Record<string, TransportDepartement>;
  /** Premier mois payé d'un nouveau volontaire. */
  debutBourse: DebutBourse;
  /** Durée maximale du volontariat en mois (0 : sans limite). */
  dureeMaxMois: number;
  /** Au-delà de la durée : on le signale seulement, ou la bourse s'arrête. */
  depassementDuree: 'SIGNALER' | 'ARRETER';
  motifsSortie: MotifSortie[];
  /** Contrôles des dossiers : âges improbables et téléphone partagé. */
  ageMinimum: number;
  ageMaximum: number;
  telephonePartage: number;
  /** Signataire des états de paiement (bourse, mise en route). */
  signatairePaiementTitre: string;
  signatairePaiementNom: string;
}

export const LIBELLES_DEBUT: Record<DebutBourse, string> = {
  MOIS_NOTE: 'Le mois de la note de service',
  MOIS_SUIVANT_NOTE: 'Le mois qui suit la note de service',
  MOIS_PRISE_SERVICE: 'Le mois de la prise de service',
  MOIS_SUIVANT_PRISE_SERVICE: 'Le mois qui suit la prise de service',
};

const CLE = 'ENROLEMENT_CONFIG';

/** Transport : fiche de la note n° 1006 (sept. 2026), devis n° 1038 et ancien devis (Niari, Pool, Pointe-Noire). */
const TRANSPORT_DEFAUT: Record<string, TransportDepartement> = {
  BOUENZA: { billet: 10000, bagages: 10000 },
  BRAZZAVILLE: { billet: 0, bagages: 0 },
  CONGO_OUBANGUI: { billet: null, bagages: null },
  CUVETTE: { billet: 10000, bagages: 10000 },
  CUVETTE_OUEST: { billet: 25000, bagages: 10000 },
  DJOUE_LEFINI: { billet: 5000, bagages: 10000 },
  KOUILOU: { billet: 20000, bagages: 15000 },
  LEKOUMOU: { billet: 20000, bagages: 10000 },
  LIKOUALA: { billet: 50000, bagages: 20000 },
  NIARI: { billet: 10000, bagages: 10000 },
  NKENI_ALIMA: { billet: 10000, bagages: 10000 },
  PLATEAUX: { billet: 10000, bagages: 10000 },
  POINTE_NOIRE: { billet: 10000, bagages: 10000 },
  POOL: { billet: 10000, bagages: 10000 },
  SANGHA: { billet: null, bagages: null },
};

const MOTIFS_DEFAUT: MotifSortie[] = [
  m('RECRUTE_FP', 'Recruté à la Fonction Publique (salarié)', true, false),
  m('DESERTEUR', 'Déserteur (a quitté son poste)', true, true),
  m('NON_PARTANT', 'Non partant (n’a pas rejoint son poste)', true, true),
  m('ABSENT', 'Absent', true, true),
  m('RETIRE_DDEPPSA', 'Retiré par la DDEPPSA', true, true),
  m('DOUBLON', 'Doublon (inscrit deux fois)', true, false),
  m('DEMISSION', 'Démission', true, false),
  m('DECES', 'Décès', true, false),
  m('FIN_VOLONTARIAT', 'Fin du volontariat (durée atteinte)', true, false),
];

function m(
  code: string,
  libelle: string,
  arreteBourse: boolean,
  reintegrable: boolean,
): MotifSortie {
  return {
    code,
    libelle,
    arreteBourse,
    reintegrable,
    dernierMoisPaye: 'MOIS_PRECEDENT',
    actif: true,
  };
}

@Injectable()
export class ConfigEnrolementService {
  private cache: ConfigEnrolement | null = null;

  constructor(
    @InjectRepository(Parametre) private readonly repo: Repository<Parametre>,
    private readonly params: ParametresService,
  ) {}

  /** Valeurs par défaut ; les bourses reprennent les anciens paramètres BOURSE_* s'ils avaient été réglés. */
  defaut(): ConfigEnrolement {
    const ancien = (cle: string, sinon: number) =>
      Number(this.params.get(cle)) || sinon;
    const cat = (
      code: string,
      libelle: string,
      bourse: number,
      equipement: number,
      motsCles: string[],
    ): CategorieBourse => ({
      code,
      libelle,
      bourse,
      equipement,
      motsCles,
      actif: true,
    });
    return {
      version: 1,
      categories: [
        cat(
          'PRESCOLAIRE',
          'Préscolaire',
          ancien('BOURSE_PRESCOLAIRE', 50000),
          50000,
          ['PRESCO', 'PERESCO', 'BET'],
        ),
        cat('PRIMAIRE', 'Primaire', ancien('BOURSE_PRIMAIRE', 50000), 50000, [
          'PRIMAIRE',
          'PRIM',
          'ALPH',
          'CFEEN',
        ]),
        cat(
          'BEAUX_ARTS',
          'Beaux-Arts (DEMA, arts plastiques, musique)',
          50000,
          50000,
          ['BEAUX', 'DEMA', 'ENBA', 'ARTS', 'MUSIQUE'],
        ),
        // Bourse de septembre 2026 et récapitulatif signé : l'administration scolaire est à 50 000
        cat('ADMINISTRATION', 'Administration scolaire', 50000, 50000, [
          'ADM',
          'GESTION',
          'DCAF',
        ]),
        cat('COLLEGE', 'Collège', ancien('BOURSE_COLLEGE', 60000), 60000, [
          'COLL',
          'CEG',
        ]),
        cat('LYCEE', 'Lycée', ancien('BOURSE_LYCEE', 75000), 75000, ['LYC']),
      ],
      categoriesCommunautaires: [
        cat('COM_PRESCOLAIRE', 'Préscolaire', 0, 0, [
          'PRESCO',
          'PERESCO',
          'MATERNEL',
        ]),
        cat('COM_PRIMAIRE', 'Primaire', 0, 0, [
          'PRIMAIRE',
          'PRIM',
          'ALPH',
          'EPP',
        ]),
        cat('COM_COLLEGE', 'Collège', 0, 0, ['COLL', 'CEG']),
        cat('COM_LYCEE', 'Lycée', 0, 0, ['LYC']),
        cat('COM_ADMINISTRATION', 'Administration scolaire', 0, 0, [
          'ADM',
          'GESTION',
        ]),
      ],
      premiereVague: 2019,
      transport: { ...TRANSPORT_DEFAUT },
      debutBourse: 'MOIS_SUIVANT_NOTE',
      dureeMaxMois: 0,
      depassementDuree: 'SIGNALER',
      motifsSortie: MOTIFS_DEFAUT,
      ageMinimum: 18,
      ageMaximum: 45,
      telephonePartage: 3,
      signatairePaiementTitre:
        this.params.get('SIGNATAIRE_LISTE_TITRE') ||
        'La Directrice de Cabinet,',
      signatairePaiementNom:
        this.params.get('SIGNATAIRE_LISTE_NOM') || 'Régine TCHICAYA-OBOA',
    };
  }

  /** Configuration en vigueur (complétée par les valeurs par défaut pour ce qui manque). */
  get(): ConfigEnrolement {
    if (this.cache) return this.cache;
    const defaut = this.defaut();
    let enregistree: Partial<ConfigEnrolement> = {};
    try {
      const brut = this.params.get(CLE);
      if (brut) enregistree = JSON.parse(brut) as Partial<ConfigEnrolement>;
    } catch {
      enregistree = {};
    }
    this.cache = {
      ...defaut,
      ...enregistree,
      transport: { ...defaut.transport, ...(enregistree.transport ?? {}) },
      version: 1,
    };
    return this.cache;
  }

  /** Enregistre une nouvelle configuration, après contrôle de chaque valeur. */
  async enregistrer(brut: unknown): Promise<ConfigEnrolement> {
    const c = valider(brut);
    await this.repo.save({
      cle: CLE,
      valeur: JSON.stringify(c),
      description:
        'Configuration de l’enrôlement (barèmes, règles de la bourse, motifs de sortie)',
    });
    await this.params.charger();
    this.cache = null;
    return this.get();
  }

  /* ------------------------------ Usages ------------------------------ */

  /** Barème d'une population : volontaires (bourse) ou communautaires. */
  categoriesDe(population: string | null | undefined) {
    const c = this.get();
    return population === 'COMMUNAUTAIRE'
      ? c.categoriesCommunautaires
      : c.categories;
  }

  categorie(
    code: string | null | undefined,
    population: string | null | undefined = 'VOLONTAIRE',
  ) {
    return this.categoriesDe(population).find((c) => c.code === code) ?? null;
  }

  /**
   * Numéro de la vague d'un volontaire : écrit (« 7e vague », « vague 3 »), ou tiré de l'année
   * d'enrôlement (« 2026 », « 2019-2020 », « Enrôlement 2026 ») : 1re vague = premiereVague.
   */
  numeroVague(texte: unknown): number | null {
    const t = normaliser(texte);
    if (!t) return null;
    const n = t.match(
      /(\d{1,2})\s*(?:E|EME|ERE|IEME|ER)?\s*VAGUE|VAGUE\s*(?:N\D{0,3})?(\d{1,2})\b/,
    );
    if (n) return Number(n[1] ?? n[2]) || null;
    const a = t.match(/(19|20)\d{2}/);
    if (!a) return null;
    const k = Number(a[0]) - this.get().premiereVague + 1;
    return k >= 1 ? k : 0;
  }

  /**
   * Catégorie de bourse d'après le texte d'un fichier (« 3-Beaux-Arts/DEMA », « 5-Collège »,
   * « Lycée/HG »…). Les mots les plus précis passent d'abord (Beaux-Arts avant Collège).
   */
  categorieDepuisTexte(
    texte: unknown,
    population: string | null | undefined = 'VOLONTAIRE',
  ): CategorieBourse | null {
    const t = normaliser(texte).replace(/[^A-Z]/g, '');
    if (!t) return null;
    const actives = this.categoriesDe(population).filter((c) => c.actif);
    let meilleure: { c: CategorieBourse; pos: number; long: number } | null =
      null;
    for (const c of actives)
      for (const mot of c.motsCles) {
        const k = normaliser(mot).replace(/[^A-Z]/g, '');
        const pos = k ? t.indexOf(k) : -1;
        // Le mot le plus tôt dans le texte, puis le plus long (« BEAUX » avant « ARTS »)
        if (
          pos >= 0 &&
          (!meilleure ||
            pos < meilleure.pos ||
            (pos === meilleure.pos && k.length > meilleure.long))
        )
          meilleure = { c, pos, long: k.length };
      }
    return meilleure?.c ?? null;
  }

  motif(code: string | null | undefined) {
    return this.get().motifsSortie.find((x) => x.code === code) ?? null;
  }
}

/* ------------------------------ Contrôle ------------------------------ */

const entier = (v: unknown, nom: string, min: number, max: number) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new BadRequestException(
      `${nom} : nombre entier entre ${min} et ${max} attendu.`,
    );
  return n;
};
const montant = (v: unknown, nom: string) => entier(v, nom, 0, 10_000_000);
const texte = (v: unknown, nom: string, max = 200) => {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  if (!s) throw new BadRequestException(`${nom} : ne peut pas rester vide.`);
  if (s.length > max)
    throw new BadRequestException(`${nom} : ${max} caractères au plus.`);
  return s;
};
const code = (v: unknown, nom: string) => {
  const s = normaliser(v)
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  if (!s || s.length > 40)
    throw new BadRequestException(`${nom} : code manquant ou trop long.`);
  return s;
};

export function valider(brut: unknown): ConfigEnrolement {
  if (!brut || typeof brut !== 'object')
    throw new BadRequestException('Configuration attendue.');
  const b = brut as Record<string, unknown>;

  const lireCategorie = (
    x: Record<string, unknown>,
    i: number,
  ): CategorieBourse => {
    const lib = texte(x?.libelle, `Catégorie n° ${i + 1}`, 80);
    return {
      code: code(x?.code || lib, `Catégorie « ${lib} »`),
      libelle: lib,
      bourse: montant(x?.bourse, `Bourse « ${lib} »`),
      equipement: montant(x?.equipement ?? 0, `Mise d’équipement « ${lib} »`),
      motsCles: (Array.isArray(x?.motsCles) ? x.motsCles : [])
        .map((s: unknown) => normaliser(s).replace(/[^A-Z]/g, ''))
        .filter(Boolean)
        .slice(0, 20),
      actif: x?.actif !== false,
    };
  };
  const categories = (Array.isArray(b.categories) ? b.categories : []).map(
    (x: Record<string, unknown>, i: number): CategorieBourse => {
      const lib = texte(x?.libelle, `Catégorie n° ${i + 1}`, 80);
      return {
        code: code(x?.code || lib, `Catégorie « ${lib} »`),
        libelle: lib,
        bourse: montant(x?.bourse, `Bourse « ${lib} »`),
        equipement: montant(x?.equipement, `Mise d’équipement « ${lib} »`),
        motsCles: (Array.isArray(x?.motsCles) ? x.motsCles : [])
          .map((s: unknown) => normaliser(s).replace(/[^A-Z]/g, ''))
          .filter(Boolean)
          .slice(0, 20),
        actif: x?.actif !== false,
      };
    },
  );
  if (!categories.some((c) => c.actif))
    throw new BadRequestException(
      'Il faut au moins une catégorie de bourse active.',
    );
  const codes = new Set<string>();
  for (const c of categories) {
    if (codes.has(c.code))
      throw new BadRequestException(
        `Deux catégories ont le même code « ${c.code} ».`,
      );
    codes.add(c.code);
    if (c.actif && !c.motsCles.length)
      throw new BadRequestException(
        `Catégorie « ${c.libelle} » : donnez au moins un mot-clé (il sert à reconnaître la catégorie dans les fichiers).`,
      );
  }

  const categoriesCommunautaires = (
    Array.isArray(b.categoriesCommunautaires) ? b.categoriesCommunautaires : []
  ).map(lireCategorie);
  for (const c of categoriesCommunautaires) {
    if (codes.has(c.code))
      throw new BadRequestException(
        `Deux catégories ont le même code « ${c.code} » (volontaires et communautaires doivent avoir des codes différents).`,
      );
    codes.add(c.code);
  }

  const tb = (b.transport ?? {}) as Record<string, Record<string, unknown>>;
  const transport: Record<string, TransportDepartement> = {};
  for (const d of DEPARTEMENTS) {
    const x = tb[d.code] ?? {};
    const lire = (v: unknown, nom: string) =>
      v === null || v === undefined || v === ''
        ? null
        : montant(v, `${nom} vers ${d.nom}`);
    transport[d.code] = {
      billet: lire(x.billet, 'Billet'),
      bagages: lire(x.bagages, 'Bagages'),
    };
  }

  if (!Object.keys(LIBELLES_DEBUT).includes(String(b.debutBourse)))
    throw new BadRequestException(
      'Début de la bourse : choisissez une règle de la liste.',
    );
  if (!['SIGNALER', 'ARRETER'].includes(String(b.depassementDuree)))
    throw new BadRequestException(
      'Durée dépassée : « signaler » ou « arrêter ».',
    );

  const motifs = (Array.isArray(b.motifsSortie) ? b.motifsSortie : []).map(
    (x: Record<string, unknown>, i: number): MotifSortie => {
      const lib = texte(x?.libelle, `Motif de sortie n° ${i + 1}`, 100);
      const dernier = String(x?.dernierMoisPaye);
      return {
        code: code(x?.code || lib, `Motif « ${lib} »`),
        libelle: lib,
        arreteBourse: x?.arreteBourse !== false,
        reintegrable: x?.reintegrable === true,
        dernierMoisPaye:
          dernier === 'MOIS_DE_SORTIE' ? 'MOIS_DE_SORTIE' : 'MOIS_PRECEDENT',
        actif: x?.actif !== false,
      };
    },
  );
  const codesMotifs = new Set<string>();
  for (const x of motifs) {
    if (codesMotifs.has(x.code))
      throw new BadRequestException(
        `Deux motifs de sortie ont le même code « ${x.code} ».`,
      );
    codesMotifs.add(x.code);
  }
  // Le contrôle automatique « recruté à la Fonction Publique » s'appuie sur ce motif
  if (!codesMotifs.has('RECRUTE_FP'))
    throw new BadRequestException(
      'Le motif « Recruté à la Fonction Publique » (code RECRUTE_FP) est utilisé par les contrôles : il ne peut pas être supprimé (désactivez-le si besoin).',
    );

  const ageMinimum = entier(b.ageMinimum, 'Âge minimum', 14, 40);
  const ageMaximum = entier(b.ageMaximum, 'Âge maximum', 20, 70);
  if (ageMinimum >= ageMaximum)
    throw new BadRequestException(
      'L’âge minimum doit rester inférieur à l’âge maximum.',
    );

  return {
    version: 1,
    categories,
    categoriesCommunautaires,
    premiereVague: entier(
      b.premiereVague ?? 2019,
      'Année de la 1re vague',
      2000,
      2100,
    ),
    transport,
    debutBourse: b.debutBourse as DebutBourse,
    dureeMaxMois: entier(b.dureeMaxMois ?? 0, 'Durée maximale (mois)', 0, 240),
    depassementDuree: b.depassementDuree as 'SIGNALER' | 'ARRETER',
    motifsSortie: motifs,
    ageMinimum,
    ageMaximum,
    telephonePartage: entier(
      b.telephonePartage ?? 3,
      'Téléphone partagé',
      2,
      50,
    ),
    signatairePaiementTitre: texte(
      b.signatairePaiementTitre,
      'Titre du signataire',
      120,
    ),
    signatairePaiementNom: texte(
      b.signatairePaiementNom,
      'Nom du signataire',
      120,
    ),
  };
}
