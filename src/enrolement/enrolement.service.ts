import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { lireClasseur } from '../common/excel';
import { codeDepartement } from '../common/referentiels';
import { motsDuNom, ressemblance } from '../common/ressemblance';
import { lireDate, nettoyer, normaliser } from '../common/texte';
import { ConfigEnrolementService } from './configuration';
import { JournalService } from '../core/core.service';
import {
  Agent,
  AgentRecense,
  AncienRecrute,
  CampagneEnrolement,
  Departement,
  Enrole,
  MembreEnrolement,
  Volontaire,
} from '../entities';

/** Diplômes des finalistes (écoles professionnelles) et leur cycle. */
export const DIPLOMES_ENROLEMENT: Record<
  string,
  { libelle: string; cycle: string }
> = {
  BET: { libelle: 'BET / CFEEN préscolaire', cycle: 'Préscolaire' },
  CFEEN: { libelle: 'CFEEN', cycle: 'Primaire' },
  DEMA: { libelle: 'DEMA', cycle: 'Collège' },
  DCAF: { libelle: 'DCAF', cycle: 'Administration' },
  LICENCE: { libelle: 'Licence d’enseignement / CAP-CEG', cycle: 'Collège' },
  MASTER: {
    libelle: 'Master d’enseignement / CAPES / maîtrise',
    cycle: 'Lycée',
  },
  AUTRE: { libelle: 'Autre diplôme', cycle: '' },
};

/**
 * Matières qui ne s'enseignent qu'au lycée : une licence en russe, chinois, arabe, espagnol ou
 * allemand (DG, 05/11/2026), ou en philosophie (06/11/2026), va par défaut dans la note du lycée
 * (on peut la remettre au collège).
 */
export const LANGUES_LYCEE = [
  'RUSSE',
  'CHINOIS',
  'ARABE',
  'ESPAGNOL',
  'ALLEMAND',
  'PHILO',
];
export const estLangueLycee = (specialite: unknown) => {
  const s = normaliser(specialite);
  return LANGUES_LYCEE.some((l) => s.includes(l));
};

/**
 * Règle des diplômes de l'enrôlement (audio du 05/11/2026) : sont retenus le master et la licence
 * d'enseignement, le DEMA, le DCAF, le CFEEN (primaire, préscolaire) et le BET préscolaire. Le Bac,
 * le Bac pédagogique et les autres diplômes sont non conformes ; un BET qui n'est pas du préscolaire
 * aussi. DCAF hors administration scolaire, licence ou master hors matière d'enseignement : à vérifier.
 */
export function regleDiplome(
  code: string,
  brut: string | null,
  specialite: string | null,
): { nonConforme?: string; aVerifier?: string } {
  const sp = normaliser(specialite).replace(/[^A-Z]/g, '');
  if (code === 'AUTRE')
    return { nonConforme: brut?.trim() || 'diplôme absent' };
  if (code === 'BET') {
    if (/PRES?CO|PRECOLAIRE/.test(sp)) return {};
    if (!sp || sp === 'PRIMAIRE')
      return {
        aVerifier: `BET ${sp ? 'primaire' : 'sans spécialité'} : seul le BET préscolaire est retenu`,
      };
    return {
      nonConforme: `BET ${String(specialite).trim().toLowerCase()} (seul le BET préscolaire est retenu)`,
    };
  }
  // DCAF : administration ou gestion scolaire (« Adm. scolaire », « Administration générale »…)
  if (
    code === 'DCAF' &&
    sp &&
    !/SCOLAIRE|GESTION/.test(sp) &&
    !/^(ADM|ADMINI?S?T+RATION)(GENERALE)?$/.test(sp)
  )
    return {
      aVerifier: `DCAF « ${String(specialite).trim()} », hors administration scolaire`,
    };
  if (
    (code === 'LICENCE' || code === 'MASTER') &&
    sp &&
    /DROIT|ECONOMI|GESTION|LOGISTIQUE|TRANSPORT|COMPTAB|COMMERCE|FINANCE|JOURNAL/.test(
      sp,
    )
  )
    return {
      aVerifier: `${code === 'LICENCE' ? 'Licence' : 'Master'} « ${String(specialite).trim()} » : est-ce un diplôme d'enseignement ?`,
    };
  return {};
}

/**
 * Spécialité écrite de mille façons (« H.G », « HG », « Histoire-Géographie »…) ramenée à un seul
 * libellé pour les statistiques.
 */
export function specialiteStat(brut: unknown): string {
  const s = normaliser(brut).replace(/[^A-Z]/g, '');
  if (!s) return 'Non précisée';
  const regles: [RegExp, string][] = [
    [/^ANGL/, 'Anglais'],
    [/^FRAN/, 'Français'],
    [/^(HG|HISTGEO|HISTOIRE|GEOGRAPHIE|HISTGEOG)/, 'Histoire-Géographie'],
    [/^MATH/, 'Mathématiques'],
    [/^(PC|SCIENCESPHYSIQUE|SCIENCEPHYSIQUE|PHYSIQUE)/, 'Physique-Chimie'],
    [/^(SVT|SCIENCESDELAVIE|SCIENCESNATURELLES)/, 'SVT'],
    [/^PHILO/, 'Philosophie'],
    [/^(EPS|EDUCATIONPHYSIQUE)/, 'EPS'],
    [/^ESPAGN/, 'Espagnol'],
    [/^ALLEM/, 'Allemand'],
    [/^RUSS/, 'Russe'],
    [/^CHIN/, 'Chinois'],
    [/^ARAB/, 'Arabe'],
    [/^MUSIQ/, 'Musique'],
    [/^ARTS?PLAST/, 'Arts plastiques'],
    [/^INFORMAT/, 'Informatique'],
    [/^ECONOM/, 'Économie'],
  ];
  const r = regles.find(([re]) => re.test(s));
  if (r) return r[1];
  const t = String(brut).trim();
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

/**
 * Note de service où va un volontaire retenu (DG, 05/11/2026) : le CFEEN préscolaire avec le BET
 * (une seule note du préscolaire) ; une licence placée au lycée avec les masters (note du lycée) ;
 * sinon la note de son diplôme. Les codes de note restent ceux des diplômes (BET, MASTER…).
 */
export function noteEnrolementDe(e: {
  diplome: string;
  cycle?: string | null;
  specialite?: string | null;
  noteForcee?: string | null;
}) {
  // Choix fait à la main (un dossier ou plusieurs cochés) : il l'emporte sur la règle
  if (e.noteForcee) return e.noteForcee;
  const presco = /PRES?CO|PRECOLAIRE/.test(
    normaliser(`${e.cycle ?? ''} ${e.specialite ?? ''}`).replace(/\s/g, ''),
  );
  if (e.diplome === 'CFEEN' && presco) return 'BET';
  if (e.diplome === 'LICENCE' && normaliser(e.cycle).startsWith('LYC'))
    return 'MASTER';
  return e.diplome;
}

/**
 * Notes où un dossier peut être envoyé à la main (06/11/2026) : n'importe laquelle, comme une
 * recommandation (un instituteur peut aller dans la note du collège). Cycle de la bourse qui va
 * avec, et spécialité par défaut quand la note n'en demande pas d'autre.
 */
export const NOTES_CIBLES: {
  note: string;
  libelle: string;
  cycle: string;
  /** Spécialité donnée d'office (préscolaire, primaire) ; null : à préciser (collège, lycée). */
  specialite: string | null;
}[] = [
  {
    note: 'BET',
    libelle: 'Note du préscolaire',
    cycle: 'Préscolaire',
    specialite: 'Préscolaire',
  },
  {
    note: 'CFEEN',
    libelle: 'Note du primaire',
    cycle: 'Primaire',
    specialite: 'Primaire',
  },
  {
    note: 'DEMA',
    libelle: 'Note du collège (DEMA)',
    cycle: 'Collège',
    specialite: null,
  },
  {
    note: 'LICENCE',
    libelle: 'Note du collège (licence, CAP-CEG)',
    cycle: 'Collège',
    specialite: null,
  },
  {
    note: 'MASTER',
    libelle: 'Note du lycée',
    cycle: 'Lycée',
    specialite: null,
  },
  {
    note: 'DCAF',
    libelle: 'Note de l’administration (DCAF)',
    cycle: 'Administration',
    specialite: null,
  },
];
export const NOTE_CIBLE = (note: string | null | undefined) =>
  NOTES_CIBLES.find((c) => c.note === note) ?? null;

/** Spécialité absente ou qui ne dit rien de la matière (« primaire » dans une note du collège). */
const specialiteVide = (sp: unknown) => {
  const t = normaliser(sp).replace(/[^A-Z]/g, '');
  return !t || /^(PRES?CO|PRECOLAIRE|PRIMAIRE|NEANT|AUCUNE?|RAS|ND)/.test(t);
};

/**
 * Spécialité d'un dossier au regard de sa note : « regle » (préscolaire ou primaire sans
 * spécialité : la règle la donne), « aPreciser » (collège ou lycée sans matière), ou null.
 */
export function etatSpecialite(e: {
  diplome: string;
  cycle?: string | null;
  specialite?: string | null;
  noteForcee?: string | null;
}): { etat: 'regle'; valeur: string } | { etat: 'aPreciser' } | null {
  const c = NOTE_CIBLE(noteEnrolementDe(e));
  if (!c) return null;
  if (c.specialite)
    return normaliser(e.specialite).replace(/[^A-Z]/g, '')
      ? null
      : { etat: 'regle', valeur: c.specialite };
  return specialiteVide(e.specialite) ? { etat: 'aPreciser' } : null;
}

/** Cycles de l'enrôlement : le budget (places et bourse) se calcule cycle par cycle. */
export const CYCLES_ENROLEMENT = [
  'Préscolaire',
  'Primaire',
  'Collège',
  'Lycée',
  'Administration',
] as const;

/** Spécialités proposées au collège et au lycée (liste déroulante de la saisie). */
export const SPECIALITES_ENROLEMENT = [
  'Français',
  'Anglais',
  'Espagnol',
  'Allemand',
  'Mathématiques',
  'Physique-Chimie',
  'Sciences de la vie et de la terre',
  'Histoire-Géographie',
  'Philosophie',
  'Éducation physique et sportive',
  'Informatique',
  'Économie',
  'Comptabilité',
  'Arts plastiques',
  'Éducation musicale',
  'Lettres modernes',
];

/** Cycles où le diplôme ne dit pas tout : une licence peut servir au collège comme au lycée. */
const DIPLOMES_A_CYCLE_LIBRE = ['LICENCE', 'MASTER', 'AUTRE'];

/** L'enveloppe est annuelle, la bourse mensuelle : un volontaire coûte 12 bourses par an. */
const MOIS = 12;

const entierPositif = (v: unknown) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const fcfa = (n: number) =>
  `${new Intl.NumberFormat('fr-FR').format(n).replace(/\s/g, ' ')} FCFA`;

/** Le diplôme écrit dans un fichier → code (« Master d'enseignement » → MASTER). */
export function codeDiplomeEnrolement(brut: unknown): string | null {
  const k = normaliser(brut).replace(/[^A-Z]/g, '');
  if (!k) return null;
  if (k.startsWith('BET') || k.includes('PRESCO')) return 'BET';
  if (k.startsWith('CFEEN') || k.startsWith('CEFEN')) return 'CFEEN';
  if (k.startsWith('DEMA')) return 'DEMA';
  if (k.startsWith('DCAF')) return 'DCAF';
  if (k.startsWith('LICENCE') || k.startsWith('LIC')) return 'LICENCE';
  // CAP-CEG : avec la licence (note du collège) ; CAPES et maîtrise : avec le master
  if (k.startsWith('CAPCEG')) return 'LICENCE';
  if (
    k.startsWith('MASTER') ||
    k.startsWith('MAITRISE') ||
    k.startsWith('CAPES')
  )
    return 'MASTER';
  return 'AUTRE';
}

export const ETATS_ENROLE = [
  'A_CONTROLER',
  'CONTROLE',
  'RETENU',
  'NON_RETENU',
] as const;

export interface EnroleDto {
  campagneId: number;
  nomComplet: string;
  dateNaissance?: string | null;
  lieuNaissance?: string | null;
  diplome: string;
  diplomePrecision?: string | null;
  promotion?: string | null;
  /** Cycle où le volontaire sera affecté (obligatoire pour une licence, un master ou un autre diplôme). */
  cycle?: string | null;
  specialite?: string | null;
  departementsSouhaites?: number[];
  departementRetenuId?: number | null;
  etablissement?: string | null;
  telephone?: string | null;
  origineBrute?: string | null;
  membreId?: string | null;
  observation?: string | null;
  /** Enregistrer malgré un doublon signalé. */
  forcerDoublon?: boolean;
}

@Injectable()
export class EnrolementService implements OnApplicationBootstrap {
  constructor(
    @InjectRepository(CampagneEnrolement)
    private readonly campagnes: Repository<CampagneEnrolement>,
    @InjectRepository(MembreEnrolement)
    private readonly membres: Repository<MembreEnrolement>,
    @InjectRepository(Enrole) private readonly enroles: Repository<Enrole>,
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
    @InjectRepository(AgentRecense)
    private readonly personnel: Repository<AgentRecense>,
    @InjectRepository(AncienRecrute)
    private readonly anciens: Repository<AncienRecrute>,
    @InjectRepository(Volontaire)
    private readonly volontaires: Repository<Volontaire>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    private readonly journal: JournalService,
    private readonly config: ConfigEnrolementService,
  ) {}

  async onApplicationBootstrap() {
    await this.licencesAuLycee(
      'MIGRATION_LICENCES_LANGUES_20261105',
      estLangueLycee,
    ).catch(() => undefined);
    // Puis la philosophie (06/11/2026), une seule fois aussi
    await this.licencesAuLycee('MIGRATION_LICENCES_PHILO_20261106', (s) =>
      normaliser(s).includes('PHILO'),
    ).catch(() => undefined);
  }

  /**
   * Une seule fois (DG, 05/11/2026) : les licences de langue (russe, chinois, arabe, espagnol,
   * allemand) déjà enregistrées au collège passent au lycée, pas encore dans une note. Un choix fait
   * ensuite à la main (remettre au collège) n'est plus touché.
   */
  private async licencesAuLycee(
    MARQUE: string,
    auLycee: (specialite: unknown) => boolean,
  ) {
    const [deja] = await this.enroles.query<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM parametre WHERE cle = $1`,
      [MARQUE],
    );
    if (deja.n) return;
    const liste = await this.enroles.find({
      where: { diplome: 'LICENCE', noteId: IsNull() },
    });
    const ids = liste
      .filter(
        (e) => auLycee(e.specialite) && !normaliser(e.cycle).startsWith('LYC'),
      )
      .map((e) => e.id);
    if (ids.length)
      await this.enroles.update({ id: In(ids) }, { cycle: 'Lycée' });
    await this.enroles.query(
      `INSERT INTO parametre (cle, valeur, description) VALUES ($1, $2, $3) ON CONFLICT (cle) DO NOTHING`,
      [
        MARQUE,
        new Date().toISOString(),
        `Licences passées au lycée : ${ids.length}`,
      ],
    );
  }

  /** Bourse mensuelle d'un cycle : celle de la campagne, sinon celle de la configuration de l'enrôlement. */
  private bourse(c: Partial<CampagneEnrolement> | null, cycle: string) {
    return (
      c?.montantsParCycle?.[cycle] ||
      this.config.categorieDepuisTexte(cycle)?.bourse ||
      0
    );
  }

  /* ------------------------------ Campagnes ------------------------------ */

  async listeCampagnes() {
    const liste = await this.campagnes.find({ order: { annee: 'DESC' } });
    const comptes = await this.enroles.query<
      { campagne: number; etat: string; n: number }[]
    >(
      `SELECT "campagneId" AS campagne, etat, count(*)::int AS n FROM enrole GROUP BY 1, 2`,
    );
    return liste.map((c) => {
      const n = (e: string) =>
        comptes.find((x) => x.campagne === c.id && x.etat === e)?.n ?? 0;
      return {
        ...c,
        aControler: n('A_CONTROLER'),
        aDecider: n('CONTROLE'),
        retenus: n('RETENU'),
        nonRetenus: n('NON_RETENU'),
        total: comptes
          .filter((x) => x.campagne === c.id)
          .reduce((t, x) => t + x.n, 0),
      };
    });
  }

  async campagne(id: number) {
    const c = await this.campagnes.findOne({ where: { id } });
    if (!c) throw new NotFoundException('Campagne introuvable');
    return c;
  }

  async enregistrerCampagne(
    u: UtilisateurConnecte,
    id: number | null,
    dto: {
      annee: number;
      anneeScolaire?: string;
      quota?: number;
      enveloppe?: number;
      placesParCycle?: Record<string, number>;
      montantsParCycle?: Record<string, number>;
      ouverte?: boolean;
      observation?: string | null;
    },
  ) {
    const annee = Math.round(Number(dto.annee));
    if (!(annee >= 2015 && annee <= new Date().getFullYear() + 3))
      throw new BadRequestException(
        'Indiquez l’année de la campagne (ex. 2026).',
      );
    const anneeScolaire = dto.anneeScolaire?.trim() || `${annee}-${annee + 1}`;
    const an = /^(\d{4})-(\d{4})$/.exec(anneeScolaire);
    if (!an || Number(an[2]) !== Number(an[1]) + 1)
      throw new BadRequestException(
        'Année scolaire attendue sous la forme « 2026-2027 ».',
      );
    // Budget : places et bourse par cycle, dans la limite de l'enveloppe (comme au recrutement)
    const placesParCycle: Record<string, number> = {};
    const montantsParCycle: Record<string, number> = {};
    for (const cy of CYCLES_ENROLEMENT) {
      const p = entierPositif(dto.placesParCycle?.[cy]);
      // La bourse vient des paramètres du cycle (figée dans la campagne à l'enregistrement)
      const m =
        entierPositif(dto.montantsParCycle?.[cy]) || this.bourse(null, cy);
      if (p) placesParCycle[cy] = p;
      if (m) montantsParCycle[cy] = m;
    }
    const enveloppe = entierPositif(dto.enveloppe);
    const totalPlaces = Object.values(placesParCycle).reduce(
      (t, n) => t + n,
      0,
    );
    // Dès que les places sont données par cycle, le quota est leur somme
    const quota = totalPlaces || Math.round(Number(dto.quota ?? 0));
    if (!(quota >= 0))
      throw new BadRequestException(
        'Le quota est un nombre de volontaires (0 si pas encore fixé).',
      );
    const cout = CYCLES_ENROLEMENT.reduce(
      (t, cy) =>
        t + (placesParCycle[cy] ?? 0) * (montantsParCycle[cy] ?? 0) * MOIS,
      0,
    );
    if (enveloppe > 0 && cout > enveloppe)
      throw new BadRequestException(
        `Les places prévues coûtent ${fcfa(cout)} par an (places × bourse × 12 mois) : c’est plus que l’enveloppe de ${fcfa(enveloppe)}. Réduisez les places d’un cycle.`,
      );
    const meme = await this.campagnes.findOne({ where: { annee } });
    if (meme && meme.id !== id)
      throw new BadRequestException(`La campagne ${annee} existe déjà.`);
    if (id) {
      for (const cy of CYCLES_ENROLEMENT) {
        const p = placesParCycle[cy] ?? 0;
        if (!p) continue;
        const r = await this.enroles.count({
          where: { campagneId: id, etat: 'RETENU', cycle: cy },
        });
        if (r > p)
          throw new BadRequestException(
            `${r} volontaire(s) du cycle ${cy} sont déjà retenus : les places de ce cycle ne peuvent pas être inférieures.`,
          );
      }
      // L'enveloppe ne peut pas passer sous ce qui est déjà engagé par les volontaires retenus
      if (enveloppe > 0) {
        let engage = 0;
        for (const cy of CYCLES_ENROLEMENT)
          engage +=
            (montantsParCycle[cy] ?? 0) *
            MOIS *
            (await this.enroles.count({
              where: { campagneId: id, etat: 'RETENU', cycle: cy },
            }));
        if (engage > enveloppe)
          throw new BadRequestException(
            `Les volontaires déjà retenus coûtent ${fcfa(engage)} : l’enveloppe ne peut pas être inférieure (${fcfa(enveloppe)} demandés).`,
          );
      }
      const retenus = await this.enroles.count({
        where: { campagneId: id, etat: 'RETENU' },
      });
      if (quota > 0 && retenus > quota)
        throw new BadRequestException(
          `${retenus} volontaire(s) sont déjà retenus : le quota ne peut pas être inférieur.`,
        );
      const places = (
        await this.membres.find({ where: { campagneId: id } })
      ).reduce((t, m) => t + m.places, 0);
      if (quota > 0 && places > quota)
        throw new BadRequestException(
          `${places} place(s) sont déjà données aux membres de la commission : le quota ne peut pas être inférieur.`,
        );
    }
    const valeurs = {
      annee,
      anneeScolaire,
      quota,
      enveloppe: String(enveloppe),
      placesParCycle,
      montantsParCycle,
      ouverte: dto.ouverte ?? true,
      observation: dto.observation?.trim() || null,
    };
    const c = id
      ? await this.campagnes.save({ ...(await this.campagne(id)), ...valeurs })
      : await this.campagnes.save(valeurs);
    await this.journal.log(
      u,
      id ? 'CAMPAGNE_ENROLEMENT_MODIFIEE' : 'CAMPAGNE_ENROLEMENT_OUVERTE',
      'campagne_enrolement',
      String(c.id),
      {
        annee,
        quota,
      },
    );
    return c;
  }

  /* ------------------------------ Commission ------------------------------ */

  async listeMembres(campagneId: number) {
    const liste = await this.membres.find({
      where: { campagneId },
      order: { nom: 'ASC' },
    });
    const usage = await this.enroles.query<
      { id: string; saisis: number; retenus: number }[]
    >(
      `SELECT "membreId" AS id, count(*) FILTER (WHERE etat <> 'NON_RETENU')::int AS saisis, count(*) FILTER (WHERE etat = 'RETENU')::int AS retenus
         FROM enrole WHERE "membreId" IS NOT NULL AND "campagneId" = $1 GROUP BY 1`,
      [campagneId],
    );
    return liste.map((m) => {
      const x = usage.find((y) => y.id === m.id);
      return {
        ...m,
        saisis: x?.saisis ?? 0,
        retenus: x?.retenus ?? 0,
        depasse: (x?.saisis ?? 0) > m.places,
      };
    });
  }

  async enregistrerMembre(
    u: UtilisateurConnecte,
    id: string | null,
    dto: {
      campagneId: number;
      nom: string;
      fonction?: string | null;
      places: number;
    },
  ) {
    const c = await this.campagne(dto.campagneId);
    const nom = dto.nom?.replace(/\s+/g, ' ').trim();
    if (!nom) throw new BadRequestException('Écrivez le nom du membre.');
    const places = Math.round(Number(dto.places));
    if (!(places >= 0))
      throw new BadRequestException('Indiquez le nombre de places.');
    if (c.quota > 0) {
      const autres = (await this.membres.find({ where: { campagneId: c.id } }))
        .filter((m) => m.id !== id)
        .reduce((t, m) => t + m.places, 0);
      if (autres + places > c.quota)
        throw new BadRequestException(
          `Le quota de la campagne ${c.annee} est de ${c.quota} volontaire(s). ${autres} place(s) sont déjà données aux autres membres : il en reste ${Math.max(0, c.quota - autres)}.`,
        );
    }
    const m = id
      ? await this.membres.save({
          ...(await this.membres.findOneOrFail({ where: { id } })),
          nom,
          fonction: dto.fonction?.trim() || null,
          places,
        })
      : await this.membres.save(
          this.membres.create({
            campagneId: c.id,
            nom,
            fonction: dto.fonction?.trim() || null,
            places,
          }),
        );
    await this.journal.log(
      u,
      'MEMBRE_COMMISSION_ENROLEMENT',
      'membre_enrolement',
      m.id,
      { campagne: c.annee, places },
    );
    return m;
  }

  async supprimerMembre(u: UtilisateurConnecte, id: string) {
    const n = await this.enroles.count({ where: { membreId: id } });
    if (n)
      throw new BadRequestException(
        `Ce membre a déjà apporté ${n} dossier(s) : mettez plutôt ses places à 0.`,
      );
    await this.membres.delete(id);
    await this.journal.log(
      u,
      'MEMBRE_COMMISSION_ENROLEMENT_RETIRE',
      'membre_enrolement',
      id,
    );
    return { ok: true };
  }

  /* ------------------------------- Dossiers ------------------------------- */

  /** Un dossier, tel que la liste le montre (ouvert depuis une recommandation). */
  async fiche(id: string) {
    const e = await this.enroles.findOne({ where: { id } });
    if (!e) throw new NotFoundException('Dossier introuvable');
    return (await this.liste({ campagneId: e.campagneId })).find(
      (x) => x.id === id,
    );
  }

  async liste(f: {
    campagneId: number;
    etat?: string;
    recherche?: string;
    diplome?: string;
    departementId?: number;
  }) {
    const q = this.enroles
      .createQueryBuilder('e')
      .where('e.campagneId = :c', { c: f.campagneId });
    if (f.etat) q.andWhere('e.etat = :etat', { etat: f.etat });
    if (f.diplome) q.andWhere('e.diplome = :d', { d: f.diplome });
    if (f.departementId)
      q.andWhere('e.departementRetenuId = :dep', { dep: f.departementId });
    if (f.recherche?.trim()) {
      const mots = normaliser(f.recherche)
        .split(' ')
        .filter((m) => m.length >= 2);
      mots.forEach((m, i) =>
        q.andWhere(`e.nomNormalise LIKE :m${i}`, { [`m${i}`]: `%${m}%` }),
      );
    }
    const liste = await q.orderBy('e.nomNormalise', 'ASC').getMany();
    const deps = new Map((await this.deps.find()).map((d) => [d.id, d.nom]));
    // Recommandation en attente (avis du directeur ou décision du DG), comme aux affectations
    const enAttente = new Set(
      (
        await this.enroles.query<{ id: string }[]>(
          `SELECT "enroleId" AS id FROM recommandation WHERE statut = 'EN_ATTENTE' AND "enroleId" IS NOT NULL`,
        )
      ).map((x) => x.id),
    );
    const membres = new Map(
      (await this.membres.find({ where: { campagneId: f.campagneId } })).map(
        (m) => [m.id, m.nom],
      ),
    );
    return liste.map((e) => ({
      ...e,
      diplomeLibelle: DIPLOMES_ENROLEMENT[e.diplome]?.libelle ?? e.diplome,
      // Quand la note n'est pas celle du diplôme, on le dit (06/11/2026) : licence de langue ou de
      // philosophie → note du lycée ; CFEEN préscolaire → note du préscolaire
      noteAutre:
        noteEnrolementDe(e) !== e.diplome
          ? `${NOTE_CIBLE(noteEnrolementDe(e))?.libelle ?? noteEnrolementDe(e)} (${
              e.noteForcee
                ? 'choisie à la main'
                : noteEnrolementDe(e) === 'MASTER'
                  ? 'langue ou philosophie : enseignée au lycée'
                  : 'avec les BET'
            })`
          : e.noteForcee
            ? 'Note de son diplôme (choisie à la main)'
            : null,
      // La note où il ira, et l'état de sa spécialité (à préciser, ou donnée par la règle)
      noteActuelle: noteEnrolementDe(e),
      specialiteEtat: etatSpecialite(e),
      // Notes où on peut l'envoyer à la main (licence : collège ou lycée ; CFEEN : primaire ou préscolaire)
      notesPossibles: NOTES_CIBLES,
      departementRetenu: e.departementRetenuId
        ? (deps.get(e.departementRetenuId) ?? null)
        : null,
      departementsSouhaitesNoms: (e.departementsSouhaites ?? []).map(
        (d) => deps.get(d) ?? '?',
      ),
      membre: e.membreId ? (membres.get(e.membreId) ?? null) : null,
      recommandationEnAttente: enAttente.has(e.id),
    }));
  }

  /**
   * Statistiques de l'enrôlement (cadrage du 05/11/2026) : par cycle et diplôme, l'effectif de la
   * base générale (tous les dossiers de la campagne), les affectés (dans une note validée ou
   * signée), les non retenus et le reste à affecter ; puis les spécialités du collège (DEMA,
   * licence, cumul) et du lycée (master, licences de langues, cumul). `parmi` : compter les
   * spécialités sur tous les dossiers ou sur le reste à affecter.
   */
  async statistiques(campagneId: number, parmi: 'tous' | 'reste' = 'tous') {
    const c = await this.campagne(campagneId);
    const liste = await this.enroles.find({ where: { campagneId } });
    const affecte = (e: Enrole) => !!e.noteId;
    const reste = (e: Enrole) => !e.noteId && e.etat !== 'NON_RETENU';
    // Cycle et diplôme, dans l'ordre de la note où va la personne
    const LIGNES: [string, string, (e: Enrole) => boolean][] = [
      [
        'Préscolaire',
        'BET',
        (e) =>
          e.diplome === 'BET' &&
          !/^CFEEN|^CEFEN/.test(normaliser(e.diplomePrecision)),
      ],
      [
        'Préscolaire',
        'CFEEN préscolaire',
        (e) =>
          noteEnrolementDe(e) === 'BET' &&
          !(
            e.diplome === 'BET' &&
            !/^CFEEN|^CEFEN/.test(normaliser(e.diplomePrecision))
          ),
      ],
      ['Primaire', 'CFEEN', (e) => noteEnrolementDe(e) === 'CFEEN'],
      ['Collège', 'DEMA', (e) => e.diplome === 'DEMA'],
      ['Collège', 'Licence', (e) => noteEnrolementDe(e) === 'LICENCE'],
      ['Administration', 'DCAF', (e) => e.diplome === 'DCAF'],
      ['Lycée', 'Master (CAPES, maîtrise)', (e) => e.diplome === 'MASTER'],
      [
        'Lycée',
        'Licence (langues, philosophie)',
        (e) => e.diplome === 'LICENCE' && noteEnrolementDe(e) === 'MASTER',
      ],
      [
        'Autres',
        'Autre diplôme',
        (e) =>
          !['BET', 'CFEEN', 'DEMA', 'DCAF', 'LICENCE', 'MASTER'].includes(
            e.diplome,
          ),
      ],
    ];
    const compter = (l: Enrole[]) => ({
      total: l.length,
      affectes: l.filter(affecte).length,
      nonRetenus: l.filter((e) => e.etat === 'NON_RETENU' && !e.noteId).length,
      reste: l.filter(reste).length,
    });
    const parDiplome = LIGNES.map(([cycle, diplome, f]) => ({
      cycle,
      diplome,
      ...compter(liste.filter(f)),
    })).filter((x) => x.total || x.cycle !== 'Autres');
    // Spécialités : collège (DEMA, licence) et lycée (master, licences de langues)
    const base = parmi === 'reste' ? liste.filter(reste) : liste;
    const tableau = (
      colonnes: [string, (e: Enrole) => boolean][],
    ): { specialite: string; valeurs: number[]; cumul: number }[] => {
      const m = new Map<string, number[]>();
      colonnes.forEach(([, f], i) => {
        for (const e of base.filter(f)) {
          const s = specialiteStat(e.specialite);
          const v = m.get(s) ?? colonnes.map(() => 0);
          v[i]++;
          m.set(s, v);
        }
      });
      return [...m.entries()]
        .map(([specialite, valeurs]) => ({
          specialite,
          valeurs,
          cumul: valeurs.reduce((a, b) => a + b, 0),
        }))
        .sort(
          (a, b) =>
            b.cumul - a.cumul || a.specialite.localeCompare(b.specialite, 'fr'),
        );
    };
    const collegeCols: [string, (e: Enrole) => boolean][] = [
      ['DEMA', (e) => e.diplome === 'DEMA'],
      ['Licence', (e) => noteEnrolementDe(e) === 'LICENCE'],
    ];
    const lyceeCols: [string, (e: Enrole) => boolean][] = [
      ['Master (CAPES, maîtrise)', (e) => e.diplome === 'MASTER'],
      [
        'Licence (langues, philosophie)',
        (e) => e.diplome === 'LICENCE' && noteEnrolementDe(e) === 'MASTER',
      ],
    ];
    // Face à l'enveloppe (DG, 06/11/2026 : « si je prends tout le monde, combien ? ») : par cycle,
    // les dossiers de la base, la bourse, ce que coûterait de tous les prendre (12 mois)
    const enveloppe = Number(c.enveloppe ?? 0);
    const parCycle = CYCLES_ENROLEMENT.map((cycle) => {
      const n = base.filter(
        (e) => e.cycle === cycle && e.etat !== 'NON_RETENU',
      ).length;
      const montant = this.bourse(c, cycle);
      return {
        cycle,
        dossiers: n,
        places: c.placesParCycle?.[cycle] ?? 0,
        bourse: montant,
        coutTous: n * montant * MOIS,
      };
    });
    const coutTous = parCycle.reduce((t, x) => t + x.coutTous, 0);
    return {
      campagne: { id: c.id, annee: c.annee, anneeScolaire: c.anneeScolaire },
      parmi,
      budget: {
        enveloppe,
        mois: MOIS,
        parCycle,
        coutTous,
        ecart: enveloppe > 0 ? enveloppe - coutTous : null,
      },
      parDiplome,
      total: compter(liste),
      college: {
        colonnes: collegeCols.map(([l]) => l),
        lignes: tableau(collegeCols),
      },
      lycee: {
        colonnes: lyceeCols.map(([l]) => l),
        lignes: tableau(lyceeCols),
      },
    };
  }

  async compteurs(campagneId: number) {
    const c = await this.campagne(campagneId);
    const r = await this.enroles.query<{ etat: string; n: number }[]>(
      `SELECT etat, count(*)::int AS n FROM enrole WHERE "campagneId" = $1 GROUP BY 1`,
      [campagneId],
    );
    const n = (e: string) => r.find((x) => x.etat === e)?.n ?? 0;
    const dansNote = (
      await this.enroles.query<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM enrole WHERE "campagneId" = $1 AND "noteId" IS NOT NULL`,
        [campagneId],
      )
    )[0].n;
    const budget = await this.budget(c);
    return {
      quota: c.quota,
      aControler: n('A_CONTROLER'),
      aDecider: n('CONTROLE'),
      retenus: n('RETENU'),
      nonRetenus: n('NON_RETENU'),
      dansNote,
      resteQuota: c.quota > 0 ? c.quota - n('RETENU') : null,
      ...budget,
    };
  }

  /** Places, bourse et coût par cycle, et ce qu'il reste de l'enveloppe. */
  private async budget(c: CampagneEnrolement) {
    const retenus = await this.enroles.query<
      { cycle: string | null; n: number }[]
    >(
      `SELECT cycle, count(*)::int AS n FROM enrole WHERE "campagneId" = $1 AND etat = 'RETENU' GROUP BY 1`,
      [c.id],
    );
    const cycles = CYCLES_ENROLEMENT.map((cycle) => {
      const places = c.placesParCycle?.[cycle] ?? 0;
      const montant = this.bourse(c, cycle);
      const r = retenus.find((x) => x.cycle === cycle)?.n ?? 0;
      return {
        cycle,
        places,
        montant,
        retenus: r,
        reste: places > 0 ? places - r : null,
        consomme: r * montant * MOIS,
        prevu: places * montant * MOIS,
      };
    });
    const enveloppe = Number(c.enveloppe ?? 0);
    const consomme = cycles.reduce((t, x) => t + x.consomme, 0);
    return {
      enveloppe,
      consomme,
      resteEnveloppe: enveloppe > 0 ? enveloppe - consomme : null,
      cycles,
    };
  }

  /**
   * Même personne déjà enregistrée : dans une campagne d'enrôlement, dans la base des recrutés
   * (déjà recrutée par la FP), ou dans les listes des années passées.
   */
  async doublons(nom: string, naissance: string | null, exclure?: string) {
    const mots = motsDuNom(nom);
    if (mots.length < 2) return [];
    const long = [...mots].sort((a, b) => b.length - a.length)[0];
    const motif = `%${long}%`;
    const res: {
      source: string;
      nom: string;
      naissance: string | null;
      detail: string;
      probable: boolean;
    }[] = [];
    const voir = (
      source: string,
      n: string,
      d: string | null,
      detail: string,
    ) => {
      const r = ressemblance(mots, naissance, motsDuNom(n), d);
      if (r)
        res.push({
          source,
          nom: n,
          naissance: d,
          detail,
          probable: r === 'PROBABLE',
        });
    };
    const campagnes = new Map(
      (await this.campagnes.find()).map((c) => [c.id, c.annee]),
    );
    for (const e of await this.enroles
      .createQueryBuilder('e')
      .where('e.nomNormalise LIKE :m', { m: motif })
      .getMany())
      if (e.id !== exclure)
        voir(
          'Enrôlement',
          e.nomComplet,
          e.dateNaissance,
          `campagne ${campagnes.get(e.campagneId) ?? '?'} · ${e.etat === 'RETENU' ? 'retenu' : e.etat === 'NON_RETENU' ? 'non retenu' : 'en cours'}`,
        );
    for (const a of await this.agents
      .createQueryBuilder('a')
      .where('a.nomNormalise LIKE :m', { m: motif })
      .getMany())
      voir(
        'Recrutement (Fonction Publique)',
        a.nomComplet,
        a.dateNaissance,
        a.feuille === 'QUOTA_AUTRES'
          ? 'quota « Autres »'
          : `quota ${a.quota ?? '?'}`,
      );
    for (const a of await this.anciens
      .createQueryBuilder('x')
      .where('x.nomNormalise LIKE :m', { m: motif })
      .getMany())
      voir(
        'Années passées',
        a.nomComplet,
        a.dateNaissance,
        `${a.annee ?? 'année ?'} · ${a.source}`,
      );
    return res
      .sort((a, b) => Number(b.probable) - Number(a.probable))
      .slice(0, 10);
  }

  private async valeurs(dto: EnroleDto, existant?: Enrole) {
    const c = await this.campagne(dto.campagneId);
    if (!c.ouverte && !existant)
      throw new BadRequestException(
        `La campagne ${c.annee} est fermée : rouvrez-la pour saisir de nouveaux dossiers.`,
      );
    const nomComplet = dto.nomComplet?.replace(/\s+/g, ' ').trim();
    if (!nomComplet || motsDuNom(nomComplet).length < 2)
      throw new BadRequestException('Écrivez le nom et au moins un prénom.');
    if (!DIPLOMES_ENROLEMENT[dto.diplome])
      throw new BadRequestException('Choisissez le diplôme dans la liste.');
    // Cycle : fixé par le diplôme (CFEEN → primaire…), à choisir pour une licence ou un master
    const cycleDiplome = DIPLOMES_ENROLEMENT[dto.diplome].cycle;
    const cycleChoisi = (CYCLES_ENROLEMENT as readonly string[]).includes(
      dto.cycle ?? '',
    )
      ? dto.cycle!
      : null;
    const cycle = DIPLOMES_A_CYCLE_LIBRE.includes(dto.diplome)
      ? (cycleChoisi ?? (existant?.cycle || cycleDiplome || null))
      : cycleDiplome;
    if (!cycle)
      throw new BadRequestException(
        'Choisissez le cycle (préscolaire, primaire, collège, lycée ou administration) : le budget se calcule cycle par cycle.',
      );
    const souhaites = (dto.departementsSouhaites ?? [])
      .filter((d) => Number.isInteger(d))
      .slice(0, 3);
    if (dto.membreId) {
      const m = await this.membres.findOne({ where: { id: dto.membreId } });
      if (!m || m.campagneId !== c.id)
        throw new BadRequestException(
          'Membre de la commission inconnu pour cette campagne.',
        );
      if (existant?.membreId !== m.id) {
        // Les places du membre : dossiers apportés, hors non retenus
        const pris = await this.enroles.count({
          where: { membreId: m.id, etat: Not('NON_RETENU') },
        });
        if (pris >= m.places)
          throw new BadRequestException(
            `${m.nom} a déjà apporté ${pris} dossier(s) pour ${m.places} place(s) : toutes ses places sont prises. Le DG peut lui en donner plus (Campagne, quota et commission).`,
          );
      }
    }
    return {
      campagneId: c.id,
      nomComplet,
      nomNormalise: normaliser(nomComplet),
      dateNaissance: dto.dateNaissance || null,
      lieuNaissance: dto.lieuNaissance?.trim() || null,
      diplome: dto.diplome,
      diplomePrecision: dto.diplomePrecision?.trim() || null,
      promotion: dto.promotion?.trim() || null,
      cycle,
      specialite: dto.specialite?.trim() || null,
      departementsSouhaites: souhaites,
      departementRetenuId: dto.departementRetenuId ?? null,
      etablissement: dto.etablissement?.trim() || null,
      telephone: dto.telephone?.trim() || null,
      origineBrute: dto.origineBrute?.trim() || null,
      membreId: dto.membreId || null,
      observation: dto.observation?.trim() || null,
    };
  }

  async creer(u: UtilisateurConnecte, dto: EnroleDto) {
    const v = await this.valeurs(dto);
    if (!dto.forcerDoublon) {
      const d = (await this.doublons(v.nomComplet, v.dateNaissance)).filter(
        (x) => x.probable,
      );
      if (d.length)
        throw new BadRequestException(
          `${d[0].nom} est déjà enregistré(e) (${d[0].source} : ${d[0].detail}). Vérifiez le dossier ; si c’est une autre personne, enregistrez quand même.`,
        );
    }
    const e = await this.enroles.save(
      this.enroles.create({ ...v, etat: 'A_CONTROLER', saisiePar: u.nom }),
    );
    await this.journal.log(u, 'ENROLE_SAISI', 'enrole', e.id, {
      nom: e.nomComplet,
    });
    return e;
  }

  async modifier(u: UtilisateurConnecte, id: string, dto: EnroleDto) {
    const e = await this.enroles.findOne({ where: { id } });
    if (!e) throw new NotFoundException('Dossier introuvable');
    if (e.noteId)
      throw new BadRequestException(
        'Ce volontaire est dans une note validée : rouvrez d’abord la note.',
      );
    const v = await this.valeurs({ ...dto, campagneId: e.campagneId }, e);
    // Un dossier corrigé avant la décision repart au contrôle ; un retenu reste retenu
    await this.enroles.update(id, {
      ...v,
      ...(e.etat === 'CONTROLE'
        ? { etat: 'A_CONTROLER', controlePar: null }
        : {}),
      remarqueControle: null,
    });
    await this.journal.log(u, 'ENROLE_MODIFIE', 'enrole', id, {
      nom: v.nomComplet,
    });
    return this.enroles.findOneOrFail({ where: { id } });
  }

  /** Département retenu et établissement d'un volontaire (sans repasser par le contrôle). */
  async placer(
    u: UtilisateurConnecte,
    id: string,
    dto: { departementRetenuId?: number | null; etablissement?: string | null },
  ) {
    const e = await this.enroles.findOne({ where: { id } });
    if (!e) throw new NotFoundException('Dossier introuvable');
    if (e.noteId)
      throw new BadRequestException(
        'Ce volontaire est dans une note validée : rouvrez d’abord la note.',
      );
    const departementRetenuId = dto.departementRetenuId ?? null;
    const etablissement = departementRetenuId
      ? dto.etablissement?.trim() || null
      : null;
    await this.enroles.update(id, { departementRetenuId, etablissement });
    await this.journal.log(u, 'ENROLE_PLACE', 'enrole', id, {
      nom: e.nomComplet,
      departementRetenuId,
      etablissement,
    });
    return this.enroles.findOneOrFail({ where: { id } });
  }

  async supprimer(u: UtilisateurConnecte, id: string) {
    const e = await this.enroles.findOne({ where: { id } });
    if (!e) throw new NotFoundException('Dossier introuvable');
    if (e.etat === 'RETENU')
      throw new BadRequestException(
        'Volontaire déjà retenu par la DGRHAS : annulez d’abord la décision.',
      );
    await this.enroles.delete(id);
    await this.journal.log(u, 'ENROLE_SUPPRIME', 'enrole', id, {
      nom: e.nomComplet,
    });
    return { ok: true };
  }

  /** Contrôle d'un ou plusieurs dossiers : conformes (vers la DGRHAS) ou renvoyés avec une remarque. */
  async controler(
    u: UtilisateurConnecte,
    ids: string[],
    conforme: boolean,
    remarque?: string,
  ) {
    if (!ids.length) throw new BadRequestException('Aucun dossier choisi.');
    if (!conforme && !remarque?.trim())
      throw new BadRequestException('Écrivez ce qu’il faut corriger.');
    const liste = await this.enroles.find({
      where: { id: In(ids), etat: 'A_CONTROLER' },
    });
    // En une fois, par paquets (5 000 dossiers déclarés conformes d'un coup)
    for (let i = 0; i < liste.length; i += 1000)
      await this.enroles.update(
        { id: In(liste.slice(i, i + 1000).map((e) => e.id)) },
        conforme
          ? { etat: 'CONTROLE', controlePar: u.nom, remarqueControle: null }
          : { remarqueControle: remarque!.trim() },
      );
    await this.journal.log(
      u,
      conforme ? 'ENROLES_CONTROLES' : 'ENROLE_RENVOYE',
      'enrole',
      null,
      { dossiers: liste.length },
    );
    return { traites: liste.length };
  }

  /**
   * Décision de la DGRHAS, un par un ou pour tous : retenu (dans la limite du quota) ou non
   * retenu. Un volontaire retenu entre dans la note de service à la préparation des notes.
   */
  async decider(
    u: UtilisateurConnecte,
    ids: string[],
    decision: 'RETENU' | 'NON_RETENU',
    motif?: string,
  ) {
    if (!ids.length) throw new BadRequestException('Aucun dossier choisi.');
    const liste = await this.enroles.find({
      where: { id: In(ids), etat: 'CONTROLE' },
    });
    if (!liste.length)
      throw new BadRequestException(
        'Ces dossiers ne sont pas « à décider » (ils doivent d’abord être contrôlés).',
      );
    if (decision === 'RETENU') {
      const c = await this.campagne(liste[0].campagneId);
      const deja = await this.enroles.count({
        where: { campagneId: c.id, etat: 'RETENU' },
      });
      if (c.quota > 0 && deja + liste.length > c.quota)
        throw new BadRequestException(
          `Quota de la campagne ${c.annee} : ${c.quota} volontaire(s). ${deja} déjà retenu(s) : vous pouvez encore en retenir ${Math.max(0, c.quota - deja)}, pas ${liste.length}.`,
        );
      const b = await this.budget(c);
      // Places de chaque cycle
      for (const x of b.cycles) {
        const voulus = liste.filter((e) => e.cycle === x.cycle).length;
        if (voulus && x.places > 0 && x.retenus + voulus > x.places)
          throw new BadRequestException(
            `Cycle ${x.cycle} : ${x.places} place(s) prévues, ${x.retenus} déjà retenu(s). Vous pouvez encore en retenir ${Math.max(0, x.places - x.retenus)}, pas ${voulus}.`,
          );
      }
      // Enveloppe de bourses : on ne la dépasse pas
      const cout = liste.reduce(
        (t, e) => t + this.bourse(c, e.cycle ?? '') * MOIS,
        0,
      );
      if (b.enveloppe > 0 && b.consomme + cout > b.enveloppe)
        throw new BadRequestException(
          `Enveloppe de ${fcfa(b.enveloppe)} : ${fcfa(b.consomme)} sont déjà engagés, ces ${liste.length} volontaire(s) coûtent ${fcfa(cout)}. Il ne reste que ${fcfa(Math.max(0, b.enveloppe - b.consomme))} : on ne peut pas dépasser l’enveloppe.`,
        );
    }
    for (let i = 0; i < liste.length; i += 1000)
      await this.enroles.update(
        { id: In(liste.slice(i, i + 1000).map((e) => e.id)) },
        {
          etat: decision,
          decidePar: u.nom,
          decideLe: new Date(),
          motifDecision:
            decision === 'NON_RETENU' ? motif?.trim() || null : null,
        },
      );
    await this.journal.log(
      u,
      decision === 'RETENU' ? 'ENROLES_RETENUS' : 'ENROLES_NON_RETENUS',
      'enrole',
      null,
      { dossiers: liste.length },
    );
    return { traites: liste.length };
  }

  /**
   * Comparateur des « déjà connus » : recrutés de la Fonction publique, recrutés des années passées,
   * registre des volontaires et communautaires, retenus des autres campagnes. Rend, pour un nom et
   * une date, les fiches qui lui ressemblent fortement (règle commune des doublons).
   */
  private async comparateurConnus(campagneId: number) {
    type Ref = {
      source: string;
      nom: string;
      naissance: string | null;
      detail: string;
      mots: string[];
    };
    const refs: Ref[] = [];
    const ajouter = (
      source: string,
      nom: string,
      naissance: string | null,
      detail: string,
    ) => {
      const mots = motsDuNom(nom);
      if (mots.length >= 2) refs.push({ source, nom, naissance, detail, mots });
    };
    for (const a of await this.agents.find({
      select: ['nomComplet', 'dateNaissance', 'quota', 'feuille'],
    }))
      ajouter(
        'Recrutement (Fonction publique)',
        a.nomComplet,
        a.dateNaissance,
        a.feuille === 'QUOTA_AUTRES'
          ? 'quota « Autres »'
          : `quota ${a.quota ?? '?'}`,
      );
    // La base du personnel (agents recensés) : un enrôlé y figure peut-être déjà (06/11/2026)
    for (const a of await this.personnel.find({
      select: ['nomComplet', 'dateNaissance', 'statut'],
    }))
      ajouter('Base du personnel', a.nomComplet, a.dateNaissance, a.statut);
    for (const a of await this.anciens.find({
      select: ['nomComplet', 'dateNaissance', 'annee', 'source'],
    }))
      ajouter(
        'Recrutés des années passées',
        a.nomComplet,
        a.dateNaissance,
        `${a.annee ?? 'année ?'}`,
      );
    for (const v of await this.volontaires.find({
      select: ['nomComplet', 'dateNaissance', 'population', 'vague', 'statut'],
    }))
      ajouter(
        v.population === 'COMMUNAUTAIRE'
          ? 'Communautaires'
          : 'Volontaires (bourse)',
        v.nomComplet,
        v.dateNaissance,
        [v.vague, v.statut === 'SORTI' ? 'sorti' : 'en poste']
          .filter(Boolean)
          .join(' · '),
      );
    const annees = new Map(
      (await this.campagnes.find()).map((c) => [c.id, c.annee]),
    );
    for (const e of await this.enroles.find({
      where: { campagneId: Not(campagneId), etat: 'RETENU' },
      select: ['nomComplet', 'dateNaissance', 'campagneId'],
    }))
      ajouter(
        'Enrôlement d’une autre année',
        e.nomComplet,
        e.dateNaissance,
        `campagne ${annees.get(e.campagneId) ?? '?'}`,
      );
    // Index par mot du nom : on ne compare qu'aux noms qui partagent un des deux mots les plus longs
    const index = new Map<string, number[]>();
    refs.forEach((r, i) => {
      for (const m of new Set(r.mots))
        index.set(m, [...(index.get(m) ?? []), i]);
    });
    return (nom: string, naissance: string | null) => {
      const mots = motsDuNom(nom);
      if (mots.length < 2) return [];
      const cles = [...mots].sort((a, b) => b.length - a.length).slice(0, 2);
      const vus = new Set<number>();
      const trouves: {
        source: string;
        nom: string;
        naissance: string | null;
        detail: string;
      }[] = [];
      for (const k of cles)
        for (const i of index.get(k) ?? []) {
          if (vus.has(i)) continue;
          vus.add(i);
          const r = refs[i];
          if (ressemblance(mots, naissance, r.mots, r.naissance) === 'PROBABLE')
            trouves.push({
              source: r.source,
              nom: r.nom,
              naissance: r.naissance,
              detail: r.detail,
            });
        }
      return trouves;
    };
  }

  /**
   * Déjà connus (06/11/2026) : dossiers de la campagne (pas encore non retenus ni dans une note) qui
   * ressemblent fortement (même date et noms proches, ou mêmes mots sans date) à un recruté de la
   * Fonction publique, à une personne des années passées, à un volontaire ou communautaire du
   * registre, ou à un retenu d'une autre campagne. La DGRHAS tranche : écarter, ou autre personne.
   */
  async dejaConnus(campagneId: number) {
    await this.campagne(campagneId);
    const dossiers = await this.enroles.find({
      where: {
        campagneId,
        etat: In(['A_CONTROLER', 'CONTROLE', 'RETENU']),
        noteId: IsNull(),
        dejaConnuVerifie: false,
      },
    });
    const res: {
      id: string;
      nom: string;
      naissance: string | null;
      diplome: string;
      etat: string;
      trouves: {
        source: string;
        nom: string;
        naissance: string | null;
        detail: string;
      }[];
    }[] = [];
    const connus = await this.comparateurConnus(campagneId);
    for (const e of dossiers) {
      const trouves = connus(e.nomComplet, e.dateNaissance);
      if (trouves.length)
        res.push({
          id: e.id,
          nom: e.nomComplet,
          naissance: e.dateNaissance,
          diplome: DIPLOMES_ENROLEMENT[e.diplome]?.libelle ?? e.diplome,
          etat: e.etat,
          trouves: trouves.slice(0, 5),
        });
    }
    return res.sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
  }

  /** Cycle d'un dossier quand il suit la règle (licence de langue ou de philosophie : lycée). */
  private cycleDeLaRegle(e: Enrole) {
    if (e.diplome === 'LICENCE')
      return estLangueLycee(e.specialite) ? 'Lycée' : 'Collège';
    if (e.diplome === 'CFEEN')
      return /PRES?CO|PRECOLAIRE/.test(
        normaliser(e.specialite).replace(/\s/g, ''),
      )
        ? 'Préscolaire'
        : 'Primaire';
    return DIPLOMES_ENROLEMENT[e.diplome]?.cycle || e.cycle;
  }

  /**
   * Changer la note d'un ou de plusieurs dossiers (06/11/2026) : n'importe quelle note (préscolaire,
   * primaire, collège, lycée, administration). `cible` null : revenir à la règle automatique. La
   * spécialité, si elle est donnée, est écrite pour tous ; sinon le préscolaire et le primaire
   * reçoivent la leur, et ceux du collège ou du lycée sans matière sont signalés (sans bloquer).
   * Un dossier déjà dans une note validée ne bouge pas.
   */
  async changerNote(
    u: UtilisateurConnecte,
    ids: string[],
    cible: string | null,
    specialite: string | null = null,
  ) {
    if (!ids.length) throw new BadRequestException('Aucun dossier choisi.');
    const choix = cible ? NOTE_CIBLE(cible) : null;
    if (cible && !choix)
      throw new BadRequestException(`Note inconnue : ${cible}.`);
    const liste = await this.enroles.find({ where: { id: In(ids) } });
    let changes = 0;
    let dansUneNote = 0;
    let specialitesDonnees = 0;
    let sansSpecialite = 0;
    for (const e of liste) {
      if (e.noteId) {
        dansUneNote++;
        continue;
      }
      const maj: Partial<Enrole> = {};
      if (!choix) {
        maj.noteForcee = null;
        maj.cycle = this.cycleDeLaRegle(e);
      } else {
        // La note de la règle n'a pas besoin d'être « forcée »
        const regle = noteEnrolementDe({
          ...e,
          noteForcee: null,
          cycle: this.cycleDeLaRegle(e),
        });
        maj.noteForcee = regle === choix.note ? null : choix.note;
        maj.cycle = regle === choix.note ? this.cycleDeLaRegle(e) : choix.cycle;
      }
      if (specialite?.trim()) maj.specialite = specialite.trim();
      const apres = { ...e, ...maj };
      const sp = etatSpecialite(apres);
      if (sp?.etat === 'regle') {
        maj.specialite = sp.valeur;
        specialitesDonnees++;
      } else if (sp?.etat === 'aPreciser') sansSpecialite++;
      await this.enroles.update(e.id, maj);
      changes++;
    }
    await this.journal.log(u, 'ENROLES_NOTE_CHANGEE', 'enrole', null, {
      cible,
      specialite,
      changes,
    });
    return { changes, dansUneNote, specialitesDonnees, sansSpecialite };
  }

  /**
   * Spécialité d'un ou de plusieurs dossiers (06/11/2026). `specialite` null : la règle
   * (« Préscolaire », « Primaire ») pour ceux de ces notes qui n'en ont pas.
   */
  async ecrireSpecialite(
    u: UtilisateurConnecte,
    ids: string[],
    specialite: string | null,
  ) {
    if (!ids.length) throw new BadRequestException('Aucun dossier choisi.');
    const liste = await this.enroles.find({ where: { id: In(ids) } });
    let changes = 0;
    let ignores = 0;
    for (const e of liste) {
      const sp = etatSpecialite(e);
      const valeur = specialite?.trim()
        ? specialite.trim()
        : sp?.etat === 'regle'
          ? sp.valeur
          : null;
      if (!valeur || e.noteId) {
        ignores++;
        continue;
      }
      // Une licence de langue ou de philosophie part au lycée ; la règle suit la spécialité
      const maj: Partial<Enrole> = { specialite: valeur };
      if (!e.noteForcee)
        maj.cycle = this.cycleDeLaRegle({ ...e, specialite: valeur } as Enrole);
      await this.enroles.update(e.id, maj);
      changes++;
    }
    await this.journal.log(u, 'ENROLES_SPECIALITE', 'enrole', null, {
      specialite,
      changes,
    });
    return { changes, ignores };
  }

  /** Spécialités déjà écrites dans la campagne (collège et lycée), les plus fréquentes d'abord. */
  async specialitesConnues(campagneId: number) {
    const lignes: { specialite: string; n: number }[] =
      await this.enroles.query(
        `SELECT specialite, count(*)::int n FROM enrole WHERE "campagneId" = $1 AND specialite IS NOT NULL AND trim(specialite) <> '' GROUP BY 1 ORDER BY 2 DESC LIMIT 300`,
        [campagneId],
      );
    const vues = new Set<string>();
    const res: string[] = [];
    for (const x of [
      ...SPECIALITES_ENROLEMENT,
      ...lignes.map((l) => l.specialite),
    ]) {
      const cle = normaliser(x);
      if (specialiteVide(x) || vues.has(cle)) continue;
      vues.add(cle);
      res.push(x.trim());
    }
    return res;
  }

  /** Déjà connu : l'écarter (non retenu) ou dire que c'est une autre personne. */
  async trancherDejaConnu(
    u: UtilisateurConnecte,
    ids: string[],
    decision: 'ECARTER' | 'DIFFERENT',
    motif?: string,
  ) {
    if (!ids.length) throw new BadRequestException('Aucun dossier choisi.');
    const liste = await this.enroles.find({
      where: { id: In(ids), noteId: IsNull() },
    });
    for (let i = 0; i < liste.length; i += 1000) {
      const paquet = { id: In(liste.slice(i, i + 1000).map((e) => e.id)) };
      if (decision === 'ECARTER')
        await this.enroles.update(paquet, {
          etat: 'NON_RETENU',
          decidePar: u.nom,
          decideLe: new Date(),
          motifDecision: `Déjà connu${motif?.trim() ? ` : ${motif.trim()}` : ' (recruté, volontaire ou enrôlé)'}`,
        });
      else await this.enroles.update(paquet, { dejaConnuVerifie: true });
    }
    await this.journal.log(
      u,
      decision === 'ECARTER'
        ? 'ENROLES_DEJA_CONNUS_ECARTES'
        : 'ENROLES_DEJA_CONNUS_DIFFERENTS',
      'enrole',
      null,
      { dossiers: liste.length },
    );
    return { traites: liste.length };
  }

  /** Revenir sur une décision (avant la note validée). */
  async annulerDecision(u: UtilisateurConnecte, id: string) {
    const e = await this.enroles.findOne({ where: { id } });
    if (!e || !['RETENU', 'NON_RETENU'].includes(e.etat))
      throw new BadRequestException('Aucune décision à annuler.');
    if (e.noteId)
      throw new BadRequestException(
        'Ce volontaire est dans une note validée : rouvrez d’abord la note.',
      );
    await this.enroles.update(id, {
      etat: 'CONTROLE',
      decidePar: null,
      decideLe: null,
      motifDecision: null,
    });
    await this.journal.log(u, 'ENROLE_DECISION_ANNULEE', 'enrole', id, {
      nom: e.nomComplet,
    });
    return { ok: true };
  }

  /* -------------------------------- Import -------------------------------- */

  /**
   * Importer une liste Excel des dossiers déposés (refait le 06/11/2026), en trois temps :
   * 1. le fichier est lu et ses feuilles proposées : l'utilisateur choisit la ou les feuilles ;
   * 2. essai : chaque ligne est comparée à la campagne (même personne : mise à jour proposée ;
   *    doublon probable), au fichier lui-même, et aux bases du système (recrutés de la Fonction
   *    publique, base du personnel, volontaires et communautaires, enrôlés des autres années) ;
   * 3. import, avec les décisions prises ligne par ligne ou par groupe (\`decisions\` : clé de la
   *    ligne → MAJ, FUSION, AJOUTER ou IGNORER). Sans décision, le choix le plus prudent.
   */
  async importer(
    u: UtilisateurConnecte,
    campagneId: number,
    contenu: Buffer,
    essai: boolean,
    feuillesChoisies: string[] | null = null,
    decisions: Record<string, string> = {},
  ) {
    const c = await this.campagne(campagneId);
    const toutes = await lireClasseur(contenu, [
      'NOMSETPRENOMS|NOMETPRENOMS|NOMSPRENOMS',
      'DIPLOME',
    ]);
    if (!toutes.length)
      throw new BadRequestException(
        'Aucune feuille avec les colonnes « Noms et prénoms » et « Diplôme ».',
      );
    const feuillesDispo = toutes.map((f) => ({
      nom: f.nom,
      lignes: f.lignes.length,
    }));
    // Plusieurs feuilles et aucune choisie : on demande laquelle envoyer
    if (!feuillesChoisies?.length && toutes.length > 1)
      return { choisirFeuille: true as const, feuillesDispo };
    const feuilles = feuillesChoisies?.length
      ? toutes.filter((f) => feuillesChoisies.includes(f.nom))
      : toutes;
    if (!feuilles.length)
      throw new BadRequestException(
        'La feuille choisie n’est pas dans ce fichier (ou n’a pas les colonnes attendues).',
      );
    const deps = await this.deps.find();
    const depDe = (brut: unknown) => {
      const code = codeDepartement((nettoyer(brut) ?? '').split(/[/(]/)[0]);
      return code ? (deps.find((d) => d.code === code)?.id ?? null) : null;
    };
    const nomDep = new Map(deps.map((d) => [d.id, d.nom] as const));
    const campagneDossiers = await this.enroles.find({ where: { campagneId } });
    const parCle = new Map<string, Enrole>(
      campagneDossiers.map(
        (e) => [`${e.nomNormalise}|${e.dateNaissance ?? ''}`, e] as const,
      ),
    );
    const rapport = {
      feuillesDispo,
      feuilles: feuilles.map((f) => f.nom),
      lues: 0,
      ajoutes: 0,
      dejaLa: 0,
      sansDiplome: 0,
      nonConformes: 0,
      aVerifier: 0,
      doublonsProbables: 0,
      dejaConnus: 0,
      misAJour: 0,
      fusionnes: 0,
      ignores: 0,
    };
    type Ligne = Partial<Enrole> & { cle: string };
    type Ecart = {
      champ: string;
      libelle: string;
      base: string;
      fichier: string;
    };
    const details = {
      aMettreAJour: [] as {
        cle: string;
        nom: string;
        naissance: string | null;
        existant: {
          id: string;
          nom: string;
          etat: string;
          dansUneNote: boolean;
        };
        ecarts: Ecart[];
      }[],
      doublonsFichier: [] as {
        cle: string;
        nom: string;
        naissance: string | null;
        avec: { cle: string; nom: string; naissance: string | null };
        exact: boolean;
      }[],
      doublonsBase: [] as {
        cle: string;
        nom: string;
        naissance: string | null;
        existant: {
          id: string;
          nom: string;
          naissance: string | null;
          etat: string;
        };
      }[],
      connus: [] as {
        cle: string;
        nom: string;
        naissance: string | null;
        sources: {
          source: string;
          nom: string;
          naissance: string | null;
          detail: string;
        }[];
      }[],
    };

    // 1. Lecture des lignes
    const lignes: Ligne[] = [];
    for (const f of feuilles)
      f.lignes.forEach((l, i) => {
        const cle = (p: string) => Object.keys(l).find((k) => k.startsWith(p));
        const nom = nettoyer(
          l[
            cle('NOMSETPRENOMS') ??
              cle('NOMETPRENOMS') ??
              cle('NOMSPRENOMS') ??
              ''
          ],
        );
        if (!nom || motsDuNom(nom).length < 2) return;
        rapport.lues++;
        const diplome = codeDiplomeEnrolement(l[cle('DIPLOME') ?? '']);
        if (!diplome) rapport.sansDiplome++;
        const departs = Object.keys(l).filter(
          (x) => /^DEPART/.test(x) && !x.startsWith('DEPARTEMENTRETENU'),
        );
        lignes.push({
          // Feuille et ligne Excel (la ligne 1 est celle des titres)
          cle: `${f.nom}#${i + 2}`,
          campagneId: c.id,
          nomComplet: nom,
          nomNormalise: normaliser(nom),
          dateNaissance: lireDate(l[cle('DATEDENAIS') ?? '']),
          lieuNaissance: nettoyer(l[cle('LIEUDENAIS') ?? '']),
          diplome: diplome ?? 'AUTRE',
          diplomePrecision: nettoyer(l[cle('DIPLOME') ?? '']),
          promotion: nettoyer(l[cle('PROMO') ?? '']),
          // Licence de langue enseignée au lycée seulement : au lycée par défaut (DG, 05/11/2026)
          cycle:
            diplome === 'LICENCE' &&
            (estLangueLycee(l[cle('SPECIALITE') ?? '']) ||
              normaliser(l[cle('CYCLE') ?? '']).startsWith('LYC'))
              ? 'Lycée'
              : DIPLOMES_ENROLEMENT[diplome ?? 'AUTRE'].cycle ||
                nettoyer(l[cle('CYCLE') ?? '']),
          specialite: nettoyer(l[cle('SPECIALITE') ?? '']),
          departementsSouhaites: departs
            .map((x) => depDe(l[x]))
            .filter((x): x is number => !!x)
            .slice(0, 3),
          departementRetenuId: depDe(l[cle('DEPARTEMENTRETENU') ?? '']),
          etablissement: nettoyer(l[cle('ETABLISSEMENT') ?? '']),
          telephone: nettoyer(l[cle('TEL') ?? '']),
          origineBrute: nettoyer(l[cle('ORIGINE') ?? '']),
          observation: nettoyer(l[cle('OBS') ?? '']),
          etat: 'A_CONTROLER',
          saisiePar: u.nom,
        });
      });

    // Ce qui diffère entre le dossier de la base et la ligne du fichier (valeurs du fichier non vides)
    const CHAMPS: [keyof Enrole, string][] = [
      ['lieuNaissance', 'Lieu de naissance'],
      ['diplomePrecision', 'Diplôme'],
      ['promotion', 'Promotion'],
      ['specialite', 'Spécialité'],
      ['departementsSouhaites', 'Départements souhaités'],
      ['departementRetenuId', 'Département retenu'],
      ['etablissement', 'Établissement'],
      ['telephone', 'Téléphone'],
      ['origineBrute', 'Origine'],
      ['observation', 'Observation'],
    ];
    const lisible = (champ: keyof Enrole, v: unknown) =>
      champ === 'departementsSouhaites'
        ? ((v as number[] | null) ?? [])
            .map((d) => nomDep.get(d) ?? d)
            .join(', ')
        : champ === 'departementRetenuId'
          ? v
            ? String(nomDep.get(v as number) ?? v)
            : ''
          : String(v ?? '');
    const ecarts = (e: Partial<Enrole>, x: Ligne): Ecart[] =>
      CHAMPS.flatMap(([champ, libelle]) => {
        const f = lisible(champ, x[champ]);
        const b = lisible(champ, e[champ]);
        return f.trim() && normaliser(f) !== normaliser(b)
          ? [{ champ: String(champ), libelle, base: b, fichier: f }]
          : [];
      });
    const valeursDuFichier = (x: Ligne) => {
      const maj: Partial<Enrole> = {};
      for (const [champ] of CHAMPS) {
        const v = x[champ];
        if (
          Array.isArray(v)
            ? v.length
            : v !== null && v !== undefined && String(v).trim()
        )
          (maj as Record<string, unknown>)[champ] = v;
      }
      if (maj.diplomePrecision) {
        maj.diplome = x.diplome;
        maj.cycle = x.cycle;
      }
      return maj;
    };

    // 2. Comparaisons : la campagne (même personne, puis doublon probable), le fichier, les bases
    const connus = await this.comparateurConnus(campagneId);
    const parMot = new Map<
      string,
      {
        mots: string[];
        naissance: string | null;
        base?: Enrole;
        ligne?: Ligne;
      }[]
    >();
    const indexer = (
      nom: string,
      naissance: string | null,
      ref: { base?: Enrole; ligne?: Ligne },
    ) => {
      const mots = motsDuNom(nom);
      for (const m of new Set(mots))
        parMot.set(m, [...(parMot.get(m) ?? []), { mots, naissance, ...ref }]);
    };
    for (const e of campagneDossiers)
      indexer(e.nomComplet, e.dateNaissance, { base: e });
    const exactsFichier = new Map<string, Ligne>();
    const garder: Ligne[] = [];
    for (const x of lignes) {
      const k = `${x.nomNormalise}|${x.dateNaissance ?? ''}`;
      const ident = {
        cle: x.cle,
        nom: x.nomComplet!,
        naissance: x.dateNaissance ?? null,
      };
      // a. Déjà dans la campagne (même nom, même date) : mise à jour proposée s'il y a du nouveau
      const existant = parCle.get(k);
      if (existant) {
        const diff = ecarts(existant, x);
        if (!diff.length) {
          rapport.dejaLa++;
          continue;
        }
        details.aMettreAJour.push({
          ...ident,
          existant: {
            id: existant.id,
            nom: existant.nomComplet,
            etat: existant.etat,
            dansUneNote: !!existant.noteId,
          },
          ecarts: diff,
        });
        const d = decisions[x.cle] ?? 'IGNORER';
        if (d === 'MAJ' && !existant.noteId) {
          if (!essai)
            await this.enroles.update(existant.id, valeursDuFichier(x));
          rapport.misAJour++;
        } else {
          rapport.dejaLa++;
        }
        continue;
      }
      // b. Deux fois dans le fichier (même nom, même date) : fusionnés par défaut
      const jumeau = exactsFichier.get(k);
      if (jumeau) {
        details.doublonsFichier.push({
          ...ident,
          avec: {
            cle: jumeau.cle,
            nom: jumeau.nomComplet!,
            naissance: jumeau.dateNaissance ?? null,
          },
          exact: true,
        });
        if ((decisions[x.cle] ?? 'FUSION') === 'FUSION') {
          for (const [champ, v] of Object.entries(valeursDuFichier(x)))
            if (
              !(jumeau as Record<string, unknown>)[champ] ||
              (Array.isArray((jumeau as Record<string, unknown>)[champ]) &&
                !((jumeau as Record<string, unknown>)[champ] as unknown[])
                  .length)
            )
              (jumeau as Record<string, unknown>)[champ] = v;
          rapport.fusionnes++;
          continue;
        }
      } else exactsFichier.set(k, x);
      // c. Doublon probable (noms proches, même date) avec la campagne ou une autre ligne
      const mots = motsDuNom(x.nomComplet!);
      const motCle = [...mots].sort((a, b) => b.length - a.length)[0];
      // Le plus proche d'abord : celui qui partage le plus de mots du nom
      const communs = (y: { mots: string[] }) =>
        y.mots.filter((m) => mots.includes(m)).length;
      const proche = (parMot.get(motCle) ?? [])
        .filter(
          (y) =>
            ressemblance(mots, x.dateNaissance ?? null, y.mots, y.naissance) ===
              'PROBABLE' &&
            (!jumeau || y.ligne !== jumeau),
        )
        .sort((a, b) => communs(b) - communs(a))[0];
      let decision = decisions[x.cle] ?? 'AJOUTER';
      if (proche) {
        rapport.doublonsProbables++;
        if (proche.base)
          details.doublonsBase.push({
            ...ident,
            existant: {
              id: proche.base.id,
              nom: proche.base.nomComplet,
              naissance: proche.base.dateNaissance,
              etat: proche.base.etat,
            },
          });
        else if (proche.ligne)
          details.doublonsFichier.push({
            ...ident,
            avec: {
              cle: proche.ligne.cle,
              nom: proche.ligne.nomComplet!,
              naissance: proche.ligne.dateNaissance ?? null,
            },
            exact: false,
          });
        if (decision === 'MAJ' && proche.base && !proche.base.noteId) {
          if (!essai)
            await this.enroles.update(proche.base.id, valeursDuFichier(x));
          rapport.misAJour++;
          continue;
        }
        if (decision === 'FUSION' && proche.ligne) {
          for (const [champ, v] of Object.entries(valeursDuFichier(x)))
            if (!(proche.ligne as Record<string, unknown>)[champ])
              (proche.ligne as Record<string, unknown>)[champ] = v;
          rapport.fusionnes++;
          continue;
        }
      }
      // d. Déjà connu ailleurs : recruté, personnel, volontaire, enrôlé d'une autre année
      const sources = connus(x.nomComplet!, x.dateNaissance ?? null);
      if (sources.length) {
        rapport.dejaConnus++;
        details.connus.push({ ...ident, sources: sources.slice(0, 5) });
      }
      if (decision === 'MAJ' || decision === 'FUSION') decision = 'AJOUTER';
      if (decision === 'IGNORER') {
        rapport.ignores++;
        continue;
      }
      indexer(x.nomComplet!, x.dateNaissance ?? null, { ligne: x });
      garder.push(x);
    }

    // 3. Règle des diplômes : un diplôme non conforme est mis de côté (non retenu, motif écrit,
    // décision annulable) ; un cas douteux est signalé sur le dossier
    const nouveaux: Partial<Enrole>[] = garder.map(({ cle: _cle, ...x }) => {
      const regle = regleDiplome(
        x.diplome!,
        x.diplomePrecision ?? null,
        x.specialite ?? null,
      );
      if (regle.nonConforme) {
        rapport.nonConformes++;
        Object.assign(x, {
          etat: 'NON_RETENU',
          motifDecision: `Diplôme non conforme : ${regle.nonConforme}`,
          decidePar: `${u.nom} (import)`,
          decideLe: new Date(),
        });
      } else if (regle.aVerifier) {
        rapport.aVerifier++;
        x.remarqueControle = `Diplôme à vérifier : ${regle.aVerifier}`;
      }
      return x;
    });
    rapport.ajoutes = nouveaux.length;
    if (!essai) {
      for (let i = 0; i < nouveaux.length; i += 500)
        await this.enroles.insert(nouveaux.slice(i, i + 500));
      await this.journal.log(
        u,
        'ENROLES_IMPORTES',
        'campagne_enrolement',
        String(c.id),
        rapport,
      );
    }
    // Les listes sont longues : on en renvoie 2 000 de chaque au plus
    const MAX = 2000;
    const tronque = Object.values(details).some((l) => l.length > MAX);
    return {
      ...rapport,
      details: {
        aMettreAJour: details.aMettreAJour.slice(0, MAX),
        doublonsFichier: details.doublonsFichier.slice(0, MAX),
        doublonsBase: details.doublonsBase.slice(0, MAX),
        connus: details.connus.slice(0, MAX),
      },
      tronque,
    };
  }
}
