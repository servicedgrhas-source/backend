import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import ExcelJS from 'exceljs';
import { DataSource } from 'typeorm';
import { Structure } from '../entities';
import type { UtilisateurConnecte } from '../auth/auth';
import { JournalService } from '../core/core.service';
import { auteurDe, RecensementService } from './recensement.service';

/*
 * Le terrain, pour de vrai (22/11/2026). Ce que l'équipe constate est GARDÉ, par recensement :
 * - pour chaque agent, dans chaque école : présent, absent (et pourquoi), parti, inconnu, décédé,
 *   même personne qu'une autre ligne, vient aussi ici (deux écoles) ;
 * - pour chaque école : elle fonctionne, fermée, introuvable, a déménagé ; son nom sur place, le
 *   responsable trouvé ; « école terminée » ; et les écoles absentes de la liste.
 * Le BILAN du recensement en tire, département par département : écoles visitées et terminées,
 * agents vus, et ceux qu'aucune équipe n'a vus (la liste à vérifier : agents fictifs, partis…).
 */

/** Le recensement ouvert (0 : aucun), en SQL. */
export const CAMPAGNE_OUVERTE_SQL = `coalesce((SELECT id FROM campagne_recensement WHERE "clotureLe" IS NULL ORDER BY debut DESC, id DESC LIMIT 1), 0)`;

export const PRESENCES_CONSTAT = [
  'PRESENT',
  'ABSENT',
  'PARTI',
  'INCONNU',
  'DECEDE',
  'DOUBLON',
  'AUSSI_ICI',
] as const;

export const ETATS_ECOLE: Record<string, string> = {
  FONCTIONNE: 'L’école fonctionne',
  FERMEE: 'Fermée (plus de classes)',
  INTROUVABLE: 'Introuvable à cet endroit',
  DEMENAGEE: 'A déménagé',
  AUTRE: 'Autre (voir l’observation)',
};

const LIBELLES_PRESENCE: Record<string, string> = {
  PRESENT: 'Présent',
  ABSENT: 'Absent ce jour',
  PARTI: 'Parti de l’école',
  INCONNU: 'Inconnu ici',
  DECEDE: 'Décédé',
  DOUBLON: 'Même personne qu’une autre ligne',
  AUSSI_ICI: 'Vient aussi dans cette école',
};

const texte = (v: unknown, max: number) =>
  typeof v === 'string' || typeof v === 'number'
    ? String(v).replace(/\s+/g, ' ').trim().slice(0, max) || null
    : null;
const nombreOuNull = (v: unknown) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

export interface SaisieConstatEcole {
  etat?: string | null;
  nomSurPlace?: string | null;
  responsable?: string | null;
  telephone?: string | null;
  observation?: string | null;
  /** L'équipe a fini cette école (true), ou la rouvre (false). */
  terminee?: boolean;
  /**
   * La base se trompe sur l'école : ce qui est vu sur place (localité, département, inspection,
   * cycle), et la position de l'équipe. Proposé au contrôle, jamais appliqué directement.
   */
  correction?: {
    localite?: string | null;
    departementId?: number | null;
    inspectionId?: number | null;
    cycle?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    precision?: number | null;
  } | null;
}

/** Cycles d'une école (ceux de l'organigramme). */
const CYCLES_ECOLE_TERRAIN: Record<string, string> = {
  PRESCOLAIRE: 'Préscolaire',
  PRIMAIRE: 'Primaire',
  COLLEGE: 'Collège',
  LYCEE: 'Lycée',
  ALPHABETISATION: 'Alphabétisation',
};

export interface SaisiePropositionEcole {
  nom?: string;
  cycle?: string | null;
  localite?: string | null;
  departementId?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  precision?: number | null;
  agentsSurPlace?: number | null;
  responsable?: string | null;
  telephone?: string | null;
  observation?: string | null;
  /** Clé de la proposition sur l'appareil (un renvoi ne la crée pas deux fois). */
  cle?: string;
}

/** Échecs du mot de passe de secours, par compte (5, puis 15 minutes d'attente). */
const echecsSecours = new Map<string, { n: number; jusqua: number }>();

@Injectable()
export class ConstatsTerrainService {
  constructor(
    private readonly ds: DataSource,
    private readonly rec: RecensementService,
    private readonly journal: JournalService,
  ) {}

  /* ------------------------------ Agents ------------------------------ */

  /** Le constat d'un agent dans une école (le dernier remplace le précédent, pour ce recensement). */
  async noterAgent(
    u: UtilisateurConnecte,
    agentId: number,
    structureId: number,
    presence: string,
    observation: string | null,
    constateLe?: string | null,
  ) {
    if (!PRESENCES_CONSTAT.includes(presence as never)) return;
    // L'heure du constat sur l'appareil (il peut partir des jours après) ; une heure impossible
    // (horloge fausse : dans le futur, ou de plus de 60 jours) : l'heure de l'envoi
    const t = constateLe ? new Date(constateLe).getTime() : NaN;
    const le =
      Number.isFinite(t) &&
      t <= Date.now() + 3_600_000 &&
      t >= Date.now() - 60 * 86_400_000
        ? new Date(t).toISOString()
        : new Date().toISOString();
    await this.ds.query(
      `INSERT INTO constat_agent ("campagneId", "agentId", "structureId", presence, observation, par, "utilisateurId", le)
       VALUES (${CAMPAGNE_OUVERTE_SQL}, $1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT ("campagneId", "agentId", "structureId")
       DO UPDATE SET presence = EXCLUDED.presence, observation = EXCLUDED.observation,
                     par = EXCLUDED.par, "utilisateurId" = EXCLUDED."utilisateurId", le = EXCLUDED.le`,
      [agentId, structureId, presence, observation, auteurDe(u), u.id, le],
    );
  }

  /* ------------------------------ Écoles ------------------------------ */

  /** Ce que l'équipe constate sur l'école (et « terminée ») ; à vérifier par la DGRHAS si besoin. */
  async ecole(u: UtilisateurConnecte, ecoleId: number, s: SaisieConstatEcole) {
    const p = await this.rec.perimetre(u);
    const [e] = await this.ds.query<
      { id: number; departementId: number | null; type: string }[]
    >(`SELECT id, "departementId", type FROM structure WHERE id = $1`, [
      ecoleId,
    ]);
    if (!e || e.type !== 'ETABLISSEMENT')
      throw new NotFoundException('École introuvable.');
    const correction = await this.lireCorrection(s.correction, ecoleId);
    if (
      !('tous' in p) &&
      ('departementId' in p
        ? p.departementId !== e.departementId
        : !p.structures.includes(ecoleId))
    ) {
      // La base la met ailleurs, mais l'équipe est devant, dans un département de sa mission
      const ici =
        u.role === 'RECENSEUR' &&
        typeof correction?.departementId === 'number' &&
        (await this.missionDe(u)).includes(correction.departementId);
      if (!ici)
        throw new ForbiddenException(
          'Cette école n’est pas dans votre mission.',
        );
    }
    const etat = s.etat ? String(s.etat) : null;
    if (etat && !(etat in ETATS_ECOLE))
      throw new BadRequestException('État de l’école inconnu.');
    const nomSurPlace = texte(s.nomSurPlace, 200);
    const responsable = texte(s.responsable, 200);
    const telephone = texte(s.telephone, 40);
    const observation = texte(s.observation, 1000);
    // À vérifier par la DGRHAS : tout ce qui n'est pas « elle fonctionne, rien à signaler »
    const aVerifier =
      (!!etat && etat !== 'FONCTIONNE') ||
      !!nomSurPlace ||
      !!responsable ||
      !!telephone ||
      !!observation ||
      !!correction;
    const terminee =
      s.terminee === undefined ? null : s.terminee ? 'now()' : 'NULL';
    await this.ds.query(
      `INSERT INTO constat_ecole ("campagneId", "structureId", etat, "nomSurPlace", responsable, telephone, observation, "termineeLe", par, "utilisateurId", le, traite, correction)
       VALUES (${CAMPAGNE_OUVERTE_SQL}, $1, $2, $3, $4, $5, $6, ${terminee ?? 'NULL'}, $7, $8, now(), $9, $10::jsonb)
       ON CONFLICT ("campagneId", "structureId") WHERE "structureId" IS NOT NULL
       DO UPDATE SET etat = coalesce(EXCLUDED.etat, constat_ecole.etat),
                     "nomSurPlace" = coalesce(EXCLUDED."nomSurPlace", constat_ecole."nomSurPlace"),
                     responsable = coalesce(EXCLUDED.responsable, constat_ecole.responsable),
                     telephone = coalesce(EXCLUDED.telephone, constat_ecole.telephone),
                     observation = coalesce(EXCLUDED.observation, constat_ecole.observation),
                     "termineeLe" = ${terminee === null ? 'constat_ecole."termineeLe"' : terminee},
                     par = EXCLUDED.par, "utilisateurId" = EXCLUDED."utilisateurId", le = now(),
                     correction = coalesce(EXCLUDED.correction, constat_ecole.correction),
                     decision = CASE WHEN EXCLUDED.correction IS NOT NULL THEN NULL ELSE constat_ecole.decision END,
                     traite = CASE WHEN $9 THEN constat_ecole.traite ELSE false END`,
      [
        ecoleId,
        etat,
        nomSurPlace,
        responsable,
        telephone,
        observation,
        auteurDe(u),
        u.id,
        !aVerifier,
        correction ? JSON.stringify(correction) : null,
      ],
    );
    return { ok: true };
  }

  /** Les départements de la mission d'un recenseur. */
  private async missionDe(u: UtilisateurConnecte): Promise<number[]> {
    const [r] = await this.ds.query<{ departements: number[] }[]>(
      `SELECT departements FROM recenseur WHERE "utilisateurId" = $1`,
      [u.id],
    );
    return r?.departements ?? [];
  }

  /**
   * Ce que l'équipe dit de faux dans la base sur l'école, vérifié : seulement ce qui diffère de la
   * base, avec ce que disait la base (« avant »). Rien de différent : pas de correction.
   */
  private async lireCorrection(
    c: SaisieConstatEcole['correction'],
    ecoleId: number,
  ) {
    if (!c || typeof c !== 'object') return null;
    const [s] = await this.ds.query<
      {
        localite: string | null;
        departementId: number | null;
        parentId: number | null;
        cycle: string | null;
      }[]
    >(
      `SELECT localite, "departementId", "parentId", cycle FROM structure WHERE id = $1`,
      [ecoleId],
    );
    if (!s) return null;
    const out: {
      localite?: string;
      departementId?: number;
      inspectionId?: number;
      cycle?: string;
      latitude?: number;
      longitude?: number;
      precision?: number;
      avant: Record<string, unknown>;
    } = {
      avant: {
        localite: s.localite,
        departementId: s.departementId,
        inspectionId: s.parentId,
        cycle: s.cycle,
      },
    };
    const meme = (a: string | null | undefined, b: string | null | undefined) =>
      (a ?? '').trim().toUpperCase() === (b ?? '').trim().toUpperCase();
    const localite = texte(c.localite, 120);
    if (localite && !meme(localite, s.localite)) out.localite = localite;
    const dep = nombreOuNull(c.departementId);
    if (dep !== null && dep !== s.departementId) {
      const [d] = await this.ds.query<{ id: number }[]>(
        `SELECT id FROM departement WHERE id = $1`,
        [dep],
      );
      if (!d) throw new BadRequestException('Département inconnu.');
      out.departementId = dep;
    }
    const insp = nombreOuNull(c.inspectionId);
    if (insp !== null && insp !== s.parentId) {
      const [i] = await this.ds.query<{ departementId: number | null }[]>(
        `SELECT "departementId" FROM structure WHERE id = $1 AND type = 'INSPECTION'`,
        [insp],
      );
      if (!i) throw new BadRequestException('Inspection inconnue.');
      if (i.departementId !== (out.departementId ?? s.departementId))
        throw new BadRequestException(
          'Cette inspection n’est pas dans le département de l’école.',
        );
      out.inspectionId = insp;
    }
    const cycle = c.cycle ? String(c.cycle) : null;
    if (cycle && cycle !== s.cycle) {
      if (!(cycle in CYCLES_ECOLE_TERRAIN))
        throw new BadRequestException('Cycle inconnu.');
      out.cycle = cycle;
    }
    if (
      out.localite === undefined &&
      out.departementId === undefined &&
      out.inspectionId === undefined &&
      out.cycle === undefined
    )
      return null;
    const lat = nombreOuNull(c.latitude);
    const lng = nombreOuNull(c.longitude);
    if (
      lat !== null &&
      lng !== null &&
      Math.abs(lat) <= 90 &&
      Math.abs(lng) <= 180
    ) {
      out.latitude = lat;
      out.longitude = lng;
      const pr = nombreOuNull(c.precision);
      if (pr !== null) out.precision = pr;
    }
    return out;
  }

  /** Une école que l'équipe a trouvée mais qui n'est pas dans la liste : la DGRHAS la crée. */
  async proposer(u: UtilisateurConnecte, s: SaisiePropositionEcole) {
    const nom = texte(s.nom, 200);
    if (!nom || nom.length < 3)
      throw new BadRequestException(
        'Donnez le nom de l’école tel qu’écrit sur place.',
      );
    const cle = texte(s.cle, 64);
    // (renvoyée après une coupure : déjà reçue)
    if (cle) {
      const [deja] = await this.ds.query<{ id: number }[]>(
        `SELECT id FROM constat_ecole WHERE "structureId" IS NULL AND "utilisateurId" = $1 AND proposition->>'cle' = $2`,
        [u.id, cle],
      );
      if (deja) return { ok: true, id: deja.id };
    }
    const lat = nombreOuNull(s.latitude);
    const lng = nombreOuNull(s.longitude);
    const proposition = {
      cle,
      nom,
      cycle: texte(s.cycle, 20),
      localite: texte(s.localite, 200),
      departementId: nombreOuNull(s.departementId),
      latitude: lat !== null && lat >= -90 && lat <= 90 ? lat : null,
      longitude: lng !== null && lng >= -180 && lng <= 180 ? lng : null,
      precision: nombreOuNull(s.precision),
      agentsSurPlace: nombreOuNull(s.agentsSurPlace),
    };
    const [r] = await this.ds.query<{ id: number }[]>(
      `INSERT INTO constat_ecole ("campagneId", "structureId", proposition, responsable, telephone, observation, par, "utilisateurId")
       VALUES (${CAMPAGNE_OUVERTE_SQL}, NULL, $1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        JSON.stringify(proposition),
        texte(s.responsable, 200),
        texte(s.telephone, 40),
        texte(s.observation, 1000),
        auteurDe(u),
        u.id,
      ],
    );
    await this.journal.log(
      u,
      'ECOLE_SIGNALEE_TERRAIN',
      'constat_ecole',
      String(r.id),
      {
        nom,
      },
    );
    return { ok: true, id: r.id };
  }

  /** Les constats sur les écoles à vérifier (et les écoles signalées absentes de la liste). */
  async liste(u: UtilisateurConnecte, traites = false) {
    const p = await this.rec.perimetre(u);
    const lignes = await this.ds.query<
      {
        id: number;
        structureId: number | null;
        ecole: string | null;
        departementId: number | null;
        etat: string | null;
        nomSurPlace: string | null;
        responsable: string | null;
        telephone: string | null;
        observation: string | null;
        proposition: Record<string, unknown> | null;
        termineeLe: string | null;
        par: string | null;
        le: string;
        campagne: string | null;
        correction: Record<string, unknown> | null;
        decision: string | null;
        motif: string | null;
        ecoleLat: number | null;
        ecoleLng: number | null;
      }[]
    >(
      `SELECT c.id, c."structureId", s.nom AS ecole,
              coalesce(s."departementId", (c.proposition->>'departementId')::int) AS "departementId",
              c.etat, c."nomSurPlace", c.responsable, c.telephone, c.observation, c.proposition,
              c."termineeLe", c.par, c.le, k.nom AS campagne, c.correction, c.decision, c.motif,
              s.latitude AS "ecoleLat", s.longitude AS "ecoleLng"
         FROM constat_ecole c
         LEFT JOIN structure s ON s.id = c."structureId"
         LEFT JOIN campagne_recensement k ON k.id = c."campagneId"
        WHERE c.traite = $1
        ORDER BY c.le DESC LIMIT 500`,
      [traites],
    );
    // Les noms lisibles (départements, inspections) de ce que disent la base et l'équipe
    const deps = new Map(
      (
        await this.ds.query<{ id: number; nom: string }[]>(
          `SELECT id, nom FROM departement`,
        )
      ).map((d) => [d.id, d.nom]),
    );
    const idsInsp = [
      ...new Set(
        lignes.flatMap((l) => [
          Number(l.correction?.inspectionId),
          Number(
            (l.correction?.avant as Record<string, unknown> | undefined)
              ?.inspectionId,
          ),
        ]),
      ),
    ].filter((x) => Number.isInteger(x) && x > 0);
    const insps = new Map(
      (idsInsp.length
        ? await this.ds.query<{ id: number; nom: string }[]>(
            `SELECT id, nom FROM structure WHERE id = ANY($1)`,
            [idsInsp],
          )
        : []
      ).map((x) => [x.id, x.nom]),
    );
    const distanceKm = (a: number, b: number, c: number, d: number) => {
      const r = (x: number) => (x * Math.PI) / 180;
      const h =
        Math.sin(r(c - a) / 2) ** 2 +
        Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2;
      return 6371 * 2 * Math.asin(Math.sqrt(h));
    };
    const lisible = (k: string, v: unknown): string => {
      if (v === null || v === undefined || v === '') return '';
      const t =
        typeof v === 'string' || typeof v === 'number'
          ? String(v)
          : JSON.stringify(v);
      if (k === 'departementId') return deps.get(Number(v)) ?? `n° ${t}`;
      if (k === 'inspectionId') return insps.get(Number(v)) ?? `n° ${t}`;
      if (k === 'cycle') return CYCLES_ECOLE_TERRAIN[t] ?? t;
      return t;
    };
    const LIBELLES: Record<string, string> = {
      localite: 'Localité',
      departementId: 'Département',
      inspectionId: 'Inspection',
      cycle: 'Cycle',
    };
    return lignes
      .filter(
        (l) =>
          'tous' in p ||
          ('departementId' in p
            ? l.departementId === p.departementId ||
              Number(l.correction?.departementId) === p.departementId
            : l.structureId !== null && p.structures.includes(l.structureId)),
      )
      .map(({ correction, ecoleLat, ecoleLng, ...l }) => {
        const avant = (correction?.avant ?? {}) as Record<string, unknown>;
        const lat = Number(correction?.latitude);
        const lng = Number(correction?.longitude);
        return {
          ...l,
          etatLibelle: l.etat ? (ETATS_ECOLE[l.etat] ?? l.etat) : null,
          // Ce que l'équipe propose de corriger : rubrique, base, vu sur place
          corrections: correction
            ? Object.keys(LIBELLES)
                .filter((k) => correction[k] !== undefined)
                .map((k) => ({
                  code: k,
                  libelle: LIBELLES[k],
                  avant: lisible(k, avant[k]),
                  apres: lisible(k, correction[k]),
                }))
            : [],
          // Où était l'équipe : à combien de l'école (position connue dans la base)
          distanceKm:
            correction &&
            Number.isFinite(lat) &&
            Number.isFinite(lng) &&
            ecoleLat !== null &&
            ecoleLng !== null
              ? Math.round(distanceKm(lat, lng, ecoleLat, ecoleLng) * 10) / 10
              : null,
          positionEquipe:
            correction && Number.isFinite(lat) && Number.isFinite(lng)
              ? { latitude: lat, longitude: lng }
              : null,
        };
      });
  }

  /**
   * Décision du contrôle sur ce qu'une équipe a dit d'une école :
   * - APPLIQUER : la correction (localité, département, inspection, cycle) et le nom vu sur place
   *   passent dans l'organigramme ; les fiches rattachées à l'école suivent ;
   * - REFUSER : rien ne change, le motif est gardé (l'équipe le lit) ;
   * - VU : rien à changer (école qui fonctionne, responsable noté…).
   */
  async decider(
    u: UtilisateurConnecte,
    id: number,
    decision: string,
    motif?: string,
  ) {
    if (!['APPLIQUER', 'REFUSER', 'VU'].includes(decision))
      throw new BadRequestException(
        'Décision attendue : appliquer, refuser ou vu.',
      );
    const [c] = await this.ds.query<
      {
        id: number;
        structureId: number | null;
        correction: Record<string, unknown> | null;
        nomSurPlace: string | null;
      }[]
    >(
      `SELECT id, "structureId", correction, "nomSurPlace" FROM constat_ecole WHERE id = $1 AND NOT traite`,
      [id],
    );
    if (!c) throw new NotFoundException('Constat introuvable ou déjà traité.');
    const m = texte(motif, 500);
    if (decision === 'REFUSER' && !m)
      throw new BadRequestException(
        'Dites pourquoi vous refusez : l’équipe le lira.',
      );
    let fiches = 0;
    if (decision === 'APPLIQUER') {
      if (!c.structureId)
        throw new BadRequestException(
          'Une école absente de la liste se crée dans Structures › Écoles ; marquez ensuite « Vu ».',
        );
      const k = c.correction ?? {};
      const repo = this.ds.getRepository(Structure);
      const s = await repo.findOne({ where: { id: c.structureId } });
      if (!s) throw new NotFoundException('École introuvable.');
      const changes: string[] = [];
      if (typeof k.localite === 'string') {
        s.localite = k.localite;
        changes.push('localité');
      }
      if (typeof k.departementId === 'number') {
        s.departementId = k.departementId;
        changes.push('département');
      }
      if (typeof k.inspectionId === 'number') {
        s.parentId = k.inspectionId;
        changes.push('inspection');
      }
      if (typeof k.cycle === 'string') {
        s.cycle = k.cycle;
        changes.push('cycle');
      }
      if (
        c.nomSurPlace &&
        c.nomSurPlace.trim().toUpperCase() !== s.nom.trim().toUpperCase()
      ) {
        s.anciensNoms = [...new Set([...(s.anciensNoms ?? []), s.nom])];
        s.nom = c.nomSurPlace.trim();
        changes.push('nom');
      }
      if (!changes.length)
        throw new BadRequestException(
          'Rien à appliquer sur cette école : marquez-la « Vu ».',
        );
      // (enregistrée normalement : le nom reprend le préfixe de son cycle, EP, CEG…)
      await repo.save(s);
      fiches = await this.rec.realignerSurEcole(c.structureId, u.nom);
      await this.journal.log(
        u,
        'ECOLE_CORRIGEE_RECENSEMENT',
        'structure',
        String(c.structureId),
        {
          constat: id,
          changes,
          fiches,
        },
      );
    }
    await this.ds.query(
      `UPDATE constat_ecole SET traite = true, "traitePar" = $2, "traiteLe" = now(), decision = $3, motif = $4 WHERE id = $1`,
      [
        id,
        u.nom,
        decision === 'APPLIQUER'
          ? 'APPLIQUEE'
          : decision === 'REFUSER'
            ? 'REFUSEE'
            : 'VUE',
        decision === 'REFUSER' ? m : null,
      ],
    );
    if (decision !== 'APPLIQUER')
      await this.journal.log(
        u,
        'CONSTAT_ECOLE_TRAITE',
        'constat_ecole',
        String(id),
        { decision },
      );
    return { ok: true, fiches };
  }

  async traiter(u: UtilisateurConnecte, id: number) {
    const r = await this.ds.query<unknown[]>(
      `UPDATE constat_ecole SET traite = true, "traitePar" = $2, "traiteLe" = now() WHERE id = $1 AND NOT traite RETURNING id`,
      [id, u.nom],
    );
    if (!(Array.isArray(r[0]) ? r[0] : r).length)
      throw new NotFoundException('Constat introuvable ou déjà traité.');
    await this.journal.log(
      u,
      'CONSTAT_ECOLE_TRAITE',
      'constat_ecole',
      String(id),
    );
    return { ok: true };
  }

  /* ------------------------------ Bilan du recensement ------------------------------ */

  /**
   * Le bilan d'un recensement, département par département : écoles (visitées, terminées, fermées
   * ou introuvables), agents de la base (vus, et comment), agents ajoutés, et ceux qu'aucune équipe
   * n'a vus. Les agents comptés : ceux rattachés à une école en service.
   */
  async bilan(campagneId: number) {
    const [c] = await this.ds.query<{ id: number; nom: string }[]>(
      `SELECT id, nom FROM campagne_recensement WHERE id = $1`,
      [campagneId],
    );
    if (!c) throw new NotFoundException('Recensement introuvable.');
    const agents = await this.ds.query<
      {
        departementId: number;
        agents: number;
        vus: number;
        presents: number;
        absents: number;
        partis: number;
        inconnus: number;
        decedes: number;
        doublons: number;
        aussi: number;
      }[]
    >(
      `WITH base AS (
         SELECT a.id, s."departementId" FROM agent_recense a JOIN structure s ON s.id = a."structureId"
          WHERE s.actif AND s.type = 'ETABLISSEMENT' AND coalesce(a.contentieux->>'etat', 'CONFIRME') <> 'REJETE'
       ), dernier AS (
         SELECT DISTINCT ON ("agentId") "agentId", presence FROM constat_agent
          WHERE "campagneId" = $1 ORDER BY "agentId", (presence = 'PRESENT') DESC, le DESC
       )
       SELECT b."departementId", count(*)::int AS agents, count(d."agentId")::int AS vus,
              count(*) FILTER (WHERE d.presence = 'PRESENT')::int AS presents,
              count(*) FILTER (WHERE d.presence = 'ABSENT')::int AS absents,
              count(*) FILTER (WHERE d.presence = 'PARTI')::int AS partis,
              count(*) FILTER (WHERE d.presence = 'INCONNU')::int AS inconnus,
              count(*) FILTER (WHERE d.presence = 'DECEDE')::int AS decedes,
              count(*) FILTER (WHERE d.presence = 'DOUBLON')::int AS doublons,
              count(*) FILTER (WHERE d.presence = 'AUSSI_ICI')::int AS aussi
         FROM base b LEFT JOIN dernier d ON d."agentId" = b.id
        GROUP BY b."departementId"`,
      [campagneId],
    );
    const ecoles = await this.ds.query<
      {
        departementId: number;
        ecoles: number;
        visitees: number;
        terminees: number;
        fermees: number;
      }[]
    >(
      `SELECT s."departementId", count(*)::int AS ecoles,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM constat_agent k WHERE k."structureId" = s.id AND k."campagneId" = $1)
                                  OR EXISTS (SELECT 1 FROM constat_ecole e WHERE e."structureId" = s.id AND e."campagneId" = $1))::int AS visitees,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM constat_ecole e WHERE e."structureId" = s.id AND e."campagneId" = $1 AND e."termineeLe" IS NOT NULL))::int AS terminees,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM constat_ecole e WHERE e."structureId" = s.id AND e."campagneId" = $1 AND e.etat IN ('FERMEE', 'INTROUVABLE')))::int AS fermees
         FROM structure s
        WHERE s.actif AND s.type = 'ETABLISSEMENT'
        GROUP BY s."departementId"`,
      [campagneId],
    );
    const nouveaux = await this.ds.query<
      { departementId: number; n: number }[]
    >(
      `SELECT "departementId", count(*)::int AS n FROM agent_recense
        WHERE "campagneRecensementId" = $1 AND coalesce(contentieux->>'etat', 'CONFIRME') <> 'REJETE'
        GROUP BY 1`,
      [campagneId],
    );
    const signalees = await this.ds.query<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM constat_ecole WHERE "campagneId" = $1 AND "structureId" IS NULL`,
      [campagneId],
    );
    const deps = await this.ds.query<
      { id: number; nom: string; ordre: number }[]
    >(`SELECT id, nom, ordre FROM departement ORDER BY ordre, nom`);
    const parA = new Map(agents.map((x) => [x.departementId, x]));
    const parE = new Map(ecoles.map((x) => [x.departementId, x]));
    const parN = new Map(nouveaux.map((x) => [x.departementId, x.n]));
    const vide = {
      agents: 0,
      vus: 0,
      presents: 0,
      absents: 0,
      partis: 0,
      inconnus: 0,
      decedes: 0,
      doublons: 0,
      aussi: 0,
    };
    const lignes = deps
      .map((d) => {
        const a = parA.get(d.id) ?? { ...vide, departementId: d.id };
        const e = parE.get(d.id) ?? {
          ecoles: 0,
          visitees: 0,
          terminees: 0,
          fermees: 0,
        };
        return {
          departementId: d.id,
          departement: d.nom,
          ecoles: e.ecoles,
          visitees: e.visitees,
          terminees: e.terminees,
          fermees: e.fermees,
          agents: a.agents,
          vus: a.vus,
          presents: a.presents,
          absents: a.absents,
          partis: a.partis,
          inconnus: a.inconnus,
          decedes: a.decedes,
          doublons: a.doublons,
          aussi: a.aussi,
          nonVus: a.agents - a.vus,
          nouveaux: parN.get(d.id) ?? 0,
        };
      })
      .filter((l) => l.ecoles || l.agents || l.nouveaux);
    const somme = (k: keyof (typeof lignes)[number]) =>
      lignes.reduce((n, l) => n + (typeof l[k] === 'number' ? l[k] : 0), 0);
    return {
      campagne: c,
      lignes,
      total: {
        ecoles: somme('ecoles'),
        visitees: somme('visitees'),
        terminees: somme('terminees'),
        fermees: somme('fermees'),
        agents: somme('agents'),
        vus: somme('vus'),
        presents: somme('presents'),
        absents: somme('absents'),
        partis: somme('partis'),
        inconnus: somme('inconnus'),
        decedes: somme('decedes'),
        doublons: somme('doublons'),
        aussi: somme('aussi'),
        nonVus: somme('nonVus'),
        nouveaux: somme('nouveaux'),
        ecolesSignalees: signalees[0]?.n ?? 0,
      },
    };
  }

  /**
   * L'Excel du bilan : la synthèse par département, les agents qu'aucune équipe n'a vus (à
   * vérifier), et tous les constats (absent et pourquoi, parti, décédé…, avec la distance du recenseur à l’école : un constat fait loin est à vérifier).
   */
  async bilanExcel(campagneId: number, departementId?: number) {
    const b = await this.bilan(campagneId);
    const filtreDep = departementId ? 'AND s."departementId" = $2' : '';
    const params: unknown[] = departementId
      ? [campagneId, departementId]
      : [campagneId];
    const nonVus = await this.ds.query<
      {
        departement: string;
        inspection: string | null;
        ecole: string;
        numeroFiche: string | null;
        nomComplet: string;
        statut: string;
        matricule: string | null;
      }[]
    >(
      `SELECT d.nom AS departement, i.nom AS inspection, s.nom AS ecole, a."numeroFiche", a."nomComplet", a.statut, a.matricule
         FROM agent_recense a
         JOIN structure s ON s.id = a."structureId"
         LEFT JOIN structure i ON i.id = s."parentId"
         LEFT JOIN departement d ON d.id = s."departementId"
        WHERE s.actif AND s.type = 'ETABLISSEMENT' AND coalesce(a.contentieux->>'etat', 'CONFIRME') <> 'REJETE' ${filtreDep}
          AND NOT EXISTS (SELECT 1 FROM constat_agent k WHERE k."agentId" = a.id AND k."campagneId" = $1)
        ORDER BY d.ordre, s.nom, a."nomComplet"`,
      params,
    );
    const constats = await this.ds.query<
      {
        departement: string;
        ecole: string;
        nomComplet: string;
        numeroFiche: string | null;
        matricule: string | null;
        presence: string;
        observation: string | null;
        par: string | null;
        le: Date;
        distance: number | null;
      }[]
    >(
      `SELECT d.nom AS departement, s.nom AS ecole, a."nomComplet", a."numeroFiche", a.matricule,
              k.presence, k.observation, k.par, k.le,
              CASE WHEN s.latitude IS NOT NULL AND p.latitude IS NOT NULL THEN round((6371 * 2 * asin(sqrt(
                power(sin(radians(p.latitude - s.latitude) / 2), 2) +
                cos(radians(s.latitude)) * cos(radians(p.latitude)) * power(sin(radians(p.longitude - s.longitude) / 2), 2))))::numeric, 1)::float END AS distance
         FROM constat_agent k
         JOIN agent_recense a ON a.id = k."agentId"
         JOIN structure s ON s.id = k."structureId"
         LEFT JOIN departement d ON d.id = s."departementId"
         LEFT JOIN LATERAL (
           SELECT x.latitude, x.longitude FROM position_recenseur x
            WHERE x."utilisateurId" = k."utilisateurId" AND x.etat = 'OK'
              AND x.le BETWEEN k.le - interval '45 minutes' AND k.le + interval '15 minutes'
            ORDER BY abs(extract(epoch FROM x.le - k.le)) LIMIT 1
         ) p ON true
        WHERE k."campagneId" = $1 ${filtreDep}
        ORDER BY d.ordre, s.nom, a."nomComplet"`,
      params,
    );
    const wb = new ExcelJS.Workbook();
    const feuille = (
      nom: string,
      colonnes: { titre: string; cle: string; largeur: number }[],
      lignes: Record<string, unknown>[],
    ) => {
      const f = wb.addWorksheet(nom, {
        views: [{ state: 'frozen', ySplit: 1 }],
      });
      f.columns = colonnes.map((c) => ({
        header: c.titre,
        key: c.cle,
        width: c.largeur,
      }));
      f.getRow(1).font = { bold: true };
      f.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE9F7EF' },
      };
      for (const l of lignes) f.addRow(l);
      f.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: colonnes.length },
      };
    };
    const lignesBilan = departementId
      ? b.lignes.filter((l) => l.departementId === departementId)
      : [...b.lignes, { departement: 'TOTAL', ...b.total }];
    feuille(
      'Synthèse',
      [
        { titre: 'Département', cle: 'departement', largeur: 22 },
        { titre: 'Écoles', cle: 'ecoles', largeur: 9 },
        { titre: 'Visitées', cle: 'visitees', largeur: 9 },
        { titre: 'Terminées', cle: 'terminees', largeur: 10 },
        { titre: 'Fermées ou introuvables', cle: 'fermees', largeur: 12 },
        { titre: 'Agents de la base', cle: 'agents', largeur: 11 },
        { titre: 'Vus', cle: 'vus', largeur: 8 },
        { titre: 'Présents', cle: 'presents', largeur: 9 },
        { titre: 'Absents ce jour', cle: 'absents', largeur: 9 },
        { titre: 'Partis', cle: 'partis', largeur: 8 },
        { titre: 'Inconnus ici', cle: 'inconnus', largeur: 9 },
        { titre: 'Décédés', cle: 'decedes', largeur: 9 },
        { titre: 'Doublons', cle: 'doublons', largeur: 9 },
        { titre: 'Non vus', cle: 'nonVus', largeur: 9 },
        { titre: 'Agents ajoutés', cle: 'nouveaux', largeur: 9 },
      ],
      lignesBilan,
    );
    feuille(
      'Non vus',
      [
        { titre: 'Département', cle: 'departement', largeur: 18 },
        { titre: 'Inspection', cle: 'inspection', largeur: 24 },
        { titre: 'École', cle: 'ecole', largeur: 32 },
        { titre: 'N° fiche', cle: 'numeroFiche', largeur: 12 },
        { titre: 'Noms et prénoms', cle: 'nomComplet', largeur: 34 },
        { titre: 'Statut', cle: 'statut', largeur: 16 },
        { titre: 'Matricule', cle: 'matricule', largeur: 14 },
      ],
      nonVus.map((x) => ({
        ...x,
        statut: this.rec.config.statut(x.statut)?.libelle ?? x.statut,
      })),
    );
    feuille(
      'Constats',
      [
        { titre: 'Département', cle: 'departement', largeur: 18 },
        { titre: 'École', cle: 'ecole', largeur: 32 },
        { titre: 'N° fiche', cle: 'numeroFiche', largeur: 12 },
        { titre: 'Noms et prénoms', cle: 'nomComplet', largeur: 34 },
        { titre: 'Matricule', cle: 'matricule', largeur: 14 },
        { titre: 'Constat', cle: 'presence', largeur: 22 },
        { titre: 'Précision', cle: 'observation', largeur: 30 },
        { titre: 'Par', cle: 'par', largeur: 30 },
        { titre: 'Le', cle: 'le', largeur: 12 },
        {
          titre: 'Recenseur à (km) de l’école',
          cle: 'distance',
          largeur: 14,
        },
        { titre: 'À vérifier', cle: 'loin', largeur: 26 },
      ],
      constats.map((x) => ({
        ...x,
        // Constat fait à plus de 3 km de l'école (position du recenseur à ce moment) : à vérifier
        loin:
          x.distance !== null && x.distance > 3
            ? 'Constat fait loin de l’école'
            : '',
        presence: LIBELLES_PRESENCE[x.presence] ?? x.presence,
        le: new Date(x.le).toLocaleDateString('fr-FR', {
          timeZone: 'Africa/Brazzaville',
        }),
      })),
    );
    return {
      nom: `Bilan ${b.campagne.nom}${departementId ? ` - ${b.lignes.find((l) => l.departementId === departementId)?.departement ?? ''}` : ''}.xlsx`,
      contenu: Buffer.from(await wb.xlsx.writeBuffer()),
    };
  }

  /* ------------------------------ Clé de secours ------------------------------ */

  /**
   * Premier usage de l'appareil : sa clé de secours (32 octets au hasard), créée une seule fois.
   * Elle enferme aussi les données : code oublié, le mot de passe du compte les rouvre.
   */
  async creerCleSecours(u: UtilisateurConnecte, appareil: string) {
    const id = texte(appareil, 64);
    if (!id || id.length < 16)
      throw new BadRequestException('Appareil inconnu.');
    const cle = randomBytes(32).toString('base64');
    const r = await this.ds.query<{ cle: string }[]>(
      `INSERT INTO cle_terrain ("utilisateurId", appareil, cle) VALUES ($1, $2, $3)
       ON CONFLICT ("utilisateurId", appareil) DO NOTHING RETURNING cle`,
      [u.id, id, cle],
    );
    if (!r.length)
      throw new HttpException(
        'La clé de secours de cet appareil existe déjà : elle ne se donne qu’avec le mot de passe du compte.',
        HttpStatus.CONFLICT,
      );
    return { cle };
  }

  /** Code de l'appareil oublié : le mot de passe du compte rend la clé de secours. */
  async recupererCleSecours(
    u: UtilisateurConnecte,
    appareil: string,
    motDePasse: string,
  ) {
    const e = echecsSecours.get(u.id);
    if (e && e.n >= 5 && Date.now() < e.jusqua)
      throw new HttpException(
        `Trop d’essais : réessayez dans ${Math.ceil((e.jusqua - Date.now()) / 60_000)} minute(s), ou appelez la DGRHAS.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    const [x] = await this.ds.query<{ h: string | null }[]>(
      `SELECT "motDePasseHash" AS h FROM utilisateur WHERE id = $1`,
      [u.id],
    );
    const bon =
      !!x?.h && !!motDePasse && (await bcrypt.compare(String(motDePasse), x.h));
    if (!bon) {
      const n = (e && Date.now() < e.jusqua ? e.n : 0) + 1;
      echecsSecours.set(u.id, { n, jusqua: Date.now() + 15 * 60_000 });
      await this.journal.log(u, 'CLE_SECOURS_REFUSEE', 'cle_terrain', null);
      throw new BadRequestException(
        n >= 5
          ? 'Mot de passe faux, 5 fois : attendez 15 minutes, ou appelez la DGRHAS.'
          : `Mot de passe faux (${5 - n} essai(s) avant une attente de 15 minutes). C’est le mot de passe de connexion du compte, pas le code de l’appareil.`,
      );
    }
    echecsSecours.delete(u.id);
    const [k] = await this.ds.query<{ cle: string }[]>(
      `SELECT cle FROM cle_terrain WHERE "utilisateurId" = $1 AND appareil = $2`,
      [u.id, texte(appareil, 64)],
    );
    if (!k)
      throw new NotFoundException(
        'Pas de clé de secours pour cet appareil (il n’avait pas de réseau à son premier usage). Les données ne peuvent pas être rouvertes sans le code.',
      );
    await this.journal.log(u, 'CLE_SECOURS_DONNEE', 'cle_terrain', null);
    return { cle: k.cle };
  }
}
