import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { lireClasseur } from '../common/excel';
import { codeDepartement } from '../common/referentiels';
import { motsDuNom, ressemblance } from '../common/ressemblance';
import { lireDate, nettoyer, normaliser } from '../common/texte';
import { ConfigEnrolementService } from './configuration';
import { JournalService } from '../core/core.service';
import {
  Agent,
  AncienRecrute,
  CampagneEnrolement,
  Departement,
  Enrole,
  MembreEnrolement,
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
  LICENCE: { libelle: 'Licence d’enseignement', cycle: 'Collège' },
  MASTER: { libelle: 'Master d’enseignement (ENS) / langue', cycle: 'Lycée' },
  AUTRE: { libelle: 'Autre diplôme', cycle: '' },
};

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
export class EnrolementService {
  constructor(
    @InjectRepository(CampagneEnrolement)
    private readonly campagnes: Repository<CampagneEnrolement>,
    @InjectRepository(MembreEnrolement)
    private readonly membres: Repository<MembreEnrolement>,
    @InjectRepository(Enrole) private readonly enroles: Repository<Enrole>,
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
    @InjectRepository(AncienRecrute)
    private readonly anciens: Repository<AncienRecrute>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    private readonly journal: JournalService,
    private readonly config: ConfigEnrolementService,
  ) {}

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
    const membres = new Map(
      (await this.membres.find({ where: { campagneId: f.campagneId } })).map(
        (m) => [m.id, m.nom],
      ),
    );
    return liste.map((e) => ({
      ...e,
      diplomeLibelle: DIPLOMES_ENROLEMENT[e.diplome]?.libelle ?? e.diplome,
      departementRetenu: e.departementRetenuId
        ? (deps.get(e.departementRetenuId) ?? null)
        : null,
      departementsSouhaitesNoms: (e.departementsSouhaites ?? []).map(
        (d) => deps.get(d) ?? '?',
      ),
      membre: e.membreId ? (membres.get(e.membreId) ?? null) : null,
    }));
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
    for (const e of liste)
      await this.enroles.update(
        e.id,
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
    for (const e of liste)
      await this.enroles.update(e.id, {
        etat: decision,
        decidePar: u.nom,
        decideLe: new Date(),
        motifDecision: decision === 'NON_RETENU' ? motif?.trim() || null : null,
      });
    await this.journal.log(
      u,
      decision === 'RETENU' ? 'ENROLES_RETENUS' : 'ENROLES_NON_RETENUS',
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
   * Liste Excel des dossiers déposés (compilation) : chaque ligne devient un dossier
   * « à contrôler » de la campagne. `essai` : rapport sans rien enregistrer.
   */
  async importer(
    u: UtilisateurConnecte,
    campagneId: number,
    contenu: Buffer,
    essai: boolean,
  ) {
    const c = await this.campagne(campagneId);
    const feuilles = await lireClasseur(contenu, [
      'NOMSETPRENOMS|NOMETPRENOMS|NOMSPRENOMS',
      'DIPLOME',
    ]);
    if (!feuilles.length)
      throw new BadRequestException(
        'Aucune feuille avec les colonnes « Noms et prénoms » et « Diplôme ».',
      );
    const deps = await this.deps.find();
    const depDe = (brut: unknown) => {
      const code = codeDepartement((nettoyer(brut) ?? '').split(/[/(]/)[0]);
      return code ? (deps.find((d) => d.code === code)?.id ?? null) : null;
    };
    const existants = new Set(
      (
        await this.enroles.find({
          where: { campagneId },
          select: ['nomNormalise', 'dateNaissance'],
        })
      ).map((e) => `${e.nomNormalise}|${e.dateNaissance ?? ''}`),
    );
    const rapport = {
      feuilles: feuilles.map((f) => f.nom),
      lues: 0,
      ajoutes: 0,
      dejaLa: 0,
      sansDiplome: 0,
    };
    const nouveaux: Partial<Enrole>[] = [];
    for (const f of feuilles)
      for (const l of f.lignes) {
        const cle = (p: string) => Object.keys(l).find((k) => k.startsWith(p));
        const nom = nettoyer(
          l[
            cle('NOMSETPRENOMS') ??
              cle('NOMETPRENOMS') ??
              cle('NOMSPRENOMS') ??
              ''
          ],
        );
        if (!nom || motsDuNom(nom).length < 2) continue;
        rapport.lues++;
        const naissance = lireDate(l[cle('DATEDENAIS') ?? '']);
        const k = `${normaliser(nom)}|${naissance ?? ''}`;
        if (existants.has(k)) {
          rapport.dejaLa++;
          continue;
        }
        existants.add(k);
        const diplome = codeDiplomeEnrolement(l[cle('DIPLOME') ?? '']);
        if (!diplome) rapport.sansDiplome++;
        const departs = Object.keys(l).filter(
          (x) => /^DEPART/.test(x) && !x.startsWith('DEPARTEMENTRETENU'),
        );
        nouveaux.push({
          campagneId: c.id,
          nomComplet: nom,
          nomNormalise: normaliser(nom),
          dateNaissance: naissance,
          lieuNaissance: nettoyer(l[cle('LIEUDENAIS') ?? '']),
          diplome: diplome ?? 'AUTRE',
          diplomePrecision: nettoyer(l[cle('DIPLOME') ?? '']),
          promotion: nettoyer(l[cle('PROMO') ?? '']),
          cycle:
            DIPLOMES_ENROLEMENT[diplome ?? 'AUTRE'].cycle ||
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
      }
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
    return rapport;
  }
}
