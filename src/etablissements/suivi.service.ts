import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { normaliser } from '../common/texte';
import { JournalService, ParametresService } from '../core/core.service';
import {
  EvaluationAgent,
  HoraireAgent,
  Presence,
  SemainePresence,
} from '../entities';
import { RecensementService } from '../recensement/recensement.service';
import { EtablissementsService } from './etablissements.service';

/**
 * Suivi du personnel par les chefs de structure (DG, réunion de cadrage du 21/10/2026) :
 * - la présence : chaque agent a ses jours et heures attendus ; le chef pointe depuis son
 *   téléphone, chaque jour ou en fin de semaine, puis valide la semaine. Une semaine non validée
 *   se voit : on sait quel chef n'a pas pointé ;
 * - l'évaluation annuelle par le chef immédiat : compétence professionnelle et compétence sociale
 *   de 1 à 5, la globale est leur moyenne, le détail reste visible.
 */

export const STATUTS_PRESENCE: Record<string, string> = {
  PRESENT: 'Présent',
  RETARD: 'En retard',
  ABSENT_JUSTIFIE: 'Absent (justifié)',
  ABSENT: 'Absent (non justifié)',
};
const JOURS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
/** Sans horaire saisi : attendu du lundi au vendredi. */
const JOURS_DEFAUT = [1, 2, 3, 4, 5];

export const APPRECIATIONS = [
  '',
  'Très faible',
  'Faible',
  'Bon',
  'Très bon',
  'Excellent',
];
/** Décisions proposées selon l'appréciation globale (le chef peut en écrire une autre). */
export const DECISIONS: Record<string, string[]> = {
  'Très faible': [
    'Formation urgente',
    'Mise en observation avec accompagnement',
    'Réaffectation avec formation',
  ],
  Faible: [
    'Formation continue recommandée',
    'Suivi régulier par un tuteur',
    'Plan d’amélioration personnalisé',
  ],
  Bon: [
    'Maintien au poste',
    'Formation complémentaire encouragée',
    'Développement professionnel',
  ],
  'Très bon': [
    'Éligible à une promotion',
    'Félicitations et encouragements',
    'Responsabilités supplémentaires',
  ],
  Excellent: [
    'Promotion recommandée',
    'Responsabilités stratégiques',
    'Reconnaissance exceptionnelle',
  ],
};

/** Appréciation de la note globale : 3,5 reste « bon », 4 et 4,5 « très bon », 5 « excellent ». */
export const appreciation = (globale: number) =>
  APPRECIATIONS[Math.min(5, Math.max(1, Math.floor(globale)))];

/** Ce que dit l'écart entre les deux compétences (2 en professionnel et 4 en social ≠ l'inverse). */
export function lecture(pro: number, social: number) {
  if (pro >= 3 && social >= 3)
    return 'Compétent dans son métier et à l’aise avec les autres.';
  if (pro >= 3)
    return 'Compétent dans son métier, mais relations difficiles avec son entourage.';
  if (social >= 3)
    return 'Bonnes relations avec son entourage, mais compétences professionnelles à renforcer.';
  return 'Compétences professionnelles et relations à renforcer.';
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HEURE = /^([01]\d|2[0-3]):[0-5]\d$/;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const plusJours = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};
const aujourdhui = () => iso(new Date(Date.now() + 3600_000)); // heure de Brazzaville (UTC+1)
const lundiDe = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  return plusJours(date, -((d.getUTCDay() + 6) % 7));
};
const texte = (v: unknown, n: number) =>
  typeof v === 'string'
    ? v.replace(/\s+/g, ' ').trim().slice(0, n) || null
    : null;

@Injectable()
export class SuiviService {
  constructor(
    @InjectRepository(HoraireAgent)
    private readonly horaires: Repository<HoraireAgent>,
    @InjectRepository(Presence)
    private readonly presences: Repository<Presence>,
    @InjectRepository(SemainePresence)
    private readonly semaines: Repository<SemainePresence>,
    @InjectRepository(EvaluationAgent)
    private readonly evaluations: Repository<EvaluationAgent>,
    private readonly etab: EtablissementsService,
    private readonly rec: RecensementService,
    private readonly params: ParametresService,
    private readonly journal: JournalService,
  ) {}

  /* ------------------------------ Présence ------------------------------ */

  private lundi(date?: string) {
    return lundiDe(date && DATE.test(date) ? date : aujourdhui());
  }

  /** Jours attendus d'un agent (1 = lundi … 6 = samedi). */
  private attendus(h: HoraireAgent | undefined) {
    if (!h || !Object.keys(h.jours ?? {}).length) return JOURS_DEFAUT;
    return Object.keys(h.jours)
      .map(Number)
      .filter((j) => j >= 1 && j <= 6);
  }

  /** Grille d'une semaine : agents en poste de la structure, jours attendus et pointages. */
  async semaine(u: UtilisateurConnecte, structureId: number, date?: string) {
    const s = await this.etab.structure(u, structureId);
    const lundi = this.lundi(date);
    const dates = JOURS.map((_, i) => plusJours(lundi, i));
    const agents = (
      (await this.etab.agentsDe([structureId])).get(structureId) ?? []
    ).filter((a) => a.enPoste);
    const ids = agents.map((a) => a.id);
    const [horaires, saisies, validee] = await Promise.all([
      this.horaires.find({ where: { agentId: In(ids.length ? ids : [-1]) } }),
      this.presences.query<
        {
          agentId: number;
          date: string;
          statut: string;
          motif: string | null;
        }[]
      >(
        `SELECT "agentId", to_char(date, 'YYYY-MM-DD') AS date, statut, motif FROM presence
          WHERE "agentId" = ANY($1) AND date BETWEEN $2 AND $3`,
        [ids, dates[0], dates[5]],
      ),
      this.semaines.findOne({ where: { structureId, lundi } }),
    ]);
    const hParAgent = new Map(horaires.map((h) => [h.agentId, h]));
    const auj = aujourdhui();
    const lignes = agents.map((a) => {
      const h = hParAgent.get(a.id);
      const jours = this.attendus(h);
      return {
        id: a.id,
        nomComplet: a.nomComplet,
        fonction: a.fonction,
        horaire: h?.jours ?? null,
        attendus: dates.map((_, i) => jours.includes(i + 1)),
        saisies: Object.fromEntries(
          saisies
            .filter((x) => x.agentId === a.id)
            .map((x) => [x.date, { statut: x.statut, motif: x.motif }]),
        ),
      };
    });
    // Cases attendues jusqu'à aujourd'hui encore vides
    const manquantes = lignes.reduce(
      (n, l) =>
        n +
        dates.filter((d, i) => l.attendus[i] && d <= auj && !l.saisies[d])
          .length,
      0,
    );
    return {
      structure: { id: s.id, nom: s.nom },
      lundi,
      dates,
      jours: JOURS,
      aujourdhui: auj,
      agents: lignes,
      manquantes,
      validee: validee
        ? { par: validee.valideePar, le: validee.valideeLe }
        : null,
      statuts: STATUTS_PRESENCE,
    };
  }

  /** Pointages de la semaine (un ou plusieurs jours) ; un jour à venir ne se pointe pas. */
  async pointer(
    u: UtilisateurConnecte,
    structureId: number,
    saisies: {
      agentId: number;
      date: string;
      statut: string | null;
      motif?: string | null;
    }[],
  ) {
    await this.etab.structure(u, structureId);
    if (!Array.isArray(saisies) || !saisies.length) return { enregistres: 0 };
    const agents = new Set(
      ((await this.etab.agentsDe([structureId])).get(structureId) ?? []).map(
        (a) => a.id,
      ),
    );
    const auj = aujourdhui();
    let n = 0;
    for (const x of saisies.slice(0, 2000)) {
      if (!agents.has(Number(x.agentId)))
        throw new BadRequestException(
          'Un agent pointé n’est pas rattaché à cette structure.',
        );
      if (!DATE.test(x.date ?? '') || x.date > auj)
        throw new BadRequestException('On ne pointe pas un jour à venir.');
      if (!x.statut) {
        await this.presences.delete({
          agentId: Number(x.agentId),
          date: x.date,
        });
        n++;
        continue;
      }
      if (!STATUTS_PRESENCE[x.statut])
        throw new BadRequestException('Statut de présence inconnu.');
      await this.presences.query(
        `INSERT INTO presence ("agentId", "structureId", date, statut, motif, "saisiPar", "saisiLe")
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT ("agentId", date) DO UPDATE SET statut = EXCLUDED.statut, motif = EXCLUDED.motif,
           "structureId" = EXCLUDED."structureId", "saisiPar" = EXCLUDED."saisiPar", "saisiLe" = now()`,
        [
          Number(x.agentId),
          structureId,
          x.date,
          x.statut,
          texte(x.motif, 200),
          u.nom,
        ],
      );
      n++;
    }
    return { enregistres: n };
  }

  /** Le chef valide sa semaine : toutes les cases attendues jusqu'à aujourd'hui doivent être pointées. */
  async valider(u: UtilisateurConnecte, structureId: number, date?: string) {
    const g = await this.semaine(u, structureId, date);
    if (g.manquantes)
      throw new BadRequestException(
        `${g.manquantes} journée(s) attendue(s) ne sont pas encore pointées : pointez-les avant de valider la semaine.`,
      );
    await this.semaines.query(
      `INSERT INTO semaine_presence ("structureId", lundi, "valideePar", "valideeLe") VALUES ($1, $2, $3, now())
       ON CONFLICT ("structureId", lundi) DO UPDATE SET "valideePar" = EXCLUDED."valideePar", "valideeLe" = now()`,
      [structureId, g.lundi, u.nom],
    );
    await this.journal.log(u, 'PRESENCE_SEMAINE', 'structure', structureId, {
      lundi: g.lundi,
      agents: g.agents.length,
    });
    return { valide: true };
  }

  /** Jours et heures attendus d'un agent ; vide : du lundi au vendredi. */
  async horaire(
    u: UtilisateurConnecte,
    structureId: number,
    agentId: number,
    jours: Record<string, { debut?: string | null; fin?: string | null }>,
  ) {
    await this.etab.structure(u, structureId);
    const agents =
      (await this.etab.agentsDe([structureId])).get(structureId) ?? [];
    if (!agents.some((a) => a.id === agentId))
      throw new BadRequestException(
        'Cet agent n’est pas rattaché à cette structure.',
      );
    const propre: HoraireAgent['jours'] = {};
    for (const [j, h] of Object.entries(jours ?? {})) {
      const n = Number(j);
      if (!(n >= 1 && n <= 6)) continue;
      const debut = h?.debut || null;
      const fin = h?.fin || null;
      if (
        (debut && !HEURE.test(debut)) ||
        (fin && !HEURE.test(fin)) ||
        (debut && fin && fin <= debut)
      )
        throw new BadRequestException(
          `${JOURS[n - 1]} : heures invalides (ex. 07:30 à 12:30).`,
        );
      propre[String(n)] = { debut, fin };
    }
    await this.horaires.save({
      agentId,
      structureId,
      jours: propre,
      modifiePar: u.nom,
    });
    return { ok: true };
  }

  /**
   * Rapport de présence d'une période : par structure (taux de présence, absences) et les
   * semaines que les chefs n'ont pas validées.
   */
  async rapport(
    u: UtilisateurConnecte,
    f: { departement?: number; structure?: number; du?: string; au?: string },
  ) {
    const p = await this.rec.perimetre(u);
    const au = f.au && DATE.test(f.au) ? f.au : aujourdhui();
    const du = f.du && DATE.test(f.du) ? f.du : plusJours(au, -27);
    if (du > au) throw new BadRequestException('La période est inversée.');
    const conds = ['TRUE'];
    const params: unknown[] = [du, au];
    const ajouter = (sql: string, v: unknown) => {
      params.push(v);
      conds.push(sql.replace('$X', `$${params.length}`));
    };
    if ('departementId' in p)
      ajouter('s."departementId" = $X', p.departementId);
    if ('structures' in p) ajouter('s.id = ANY($X)', p.structures);
    if (f.departement) ajouter('s."departementId" = $X', f.departement);
    if (f.structure) ajouter('s.id = $X', f.structure);
    // Structures qui ont des agents rattachés : ce sont elles qui doivent pointer
    const structures = await this.presences.query<
      {
        id: number;
        nom: string;
        type: string;
        departement: string | null;
        agents: number;
        presents: number;
        retards: number;
        justifies: number;
        absents: number;
        pointages: number;
      }[]
    >(
      `SELECT s.id, s.nom, s.type, d.nom AS departement,
              (SELECT count(*)::int FROM agent_recense a WHERE a."structureId" = s.id AND coalesce(a.contentieux->>'etat', 'CONFIRME') = 'CONFIRME') AS agents,
              count(p.*) FILTER (WHERE p.statut = 'PRESENT')::int AS presents,
              count(p.*) FILTER (WHERE p.statut = 'RETARD')::int AS retards,
              count(p.*) FILTER (WHERE p.statut = 'ABSENT_JUSTIFIE')::int AS justifies,
              count(p.*) FILTER (WHERE p.statut = 'ABSENT')::int AS absents,
              count(p.*)::int AS pointages
         FROM structure s
         LEFT JOIN departement d ON d.id = s."departementId"
         LEFT JOIN presence p ON p."structureId" = s.id AND p.date BETWEEN $1 AND $2
        WHERE ${conds.join(' AND ')} AND EXISTS (SELECT 1 FROM agent_recense a WHERE a."structureId" = s.id AND coalesce(a.contentieux->>'etat', 'CONFIRME') = 'CONFIRME')
        GROUP BY s.id, d.nom ORDER BY s.nom`,
      params,
    );
    // Semaines entières de la période (jusqu'à la dernière semaine terminée ou en cours)
    const lundis: string[] = [];
    for (let l = lundiDe(du); l <= au; l = plusJours(l, 7)) lundis.push(l);
    const validees = structures.length
      ? await this.semaines.query<{ structureId: number; lundi: string }[]>(
          `SELECT "structureId", to_char(lundi, 'YYYY-MM-DD') AS lundi FROM semaine_presence
            WHERE "structureId" = ANY($1) AND lundi BETWEEN $2 AND $3`,
          [structures.map((s) => s.id), lundis[0], lundis[lundis.length - 1]],
        )
      : [];
    const vu = new Set(validees.map((v) => `${v.structureId}|${v.lundi}`));
    // Une semaine est due une fois terminée (à partir du lundi suivant)
    const dues = lundis.filter((l) => plusJours(l, 7) <= aujourdhui());
    const lignes = structures.map((s) => {
      const nonValidees = dues.filter((l) => !vu.has(`${s.id}|${l}`));
      return {
        ...s,
        taux: s.pointages
          ? Math.round((100 * (s.presents + s.retards)) / s.pointages)
          : null,
        semainesDues: dues.length,
        semainesNonValidees: nonValidees,
      };
    });
    const absents = await this.presences.query<
      {
        agentId: number;
        nomComplet: string;
        structure: string;
        absences: number;
      }[]
    >(
      `SELECT p."agentId", a."nomComplet", s.nom AS structure, count(*)::int AS absences
         FROM presence p JOIN agent_recense a ON a.id = p."agentId" JOIN structure s ON s.id = p."structureId"
        WHERE p.statut = 'ABSENT' AND p.date BETWEEN $1 AND $2 AND p."structureId" = ANY($3)
        GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 20`,
      [du, au, structures.map((s) => s.id)],
    );
    const tot = lignes.reduce(
      (t, l) => ({
        pointages: t.pointages + l.pointages,
        presents: t.presents + l.presents + l.retards,
      }),
      { pointages: 0, presents: 0 },
    );
    return {
      du,
      au,
      semainesDues: dues,
      taux: tot.pointages
        ? Math.round((100 * tot.presents) / tot.pointages)
        : null,
      structures: lignes.sort(
        (a, b) =>
          b.semainesNonValidees.length - a.semainesNonValidees.length ||
          (a.taux ?? 101) - (b.taux ?? 101),
      ),
      sansPointage: lignes.filter((l) => l.semainesNonValidees.length).length,
      absents,
    };
  }

  /* ------------------------------ Évaluation ------------------------------ */

  annee(a?: string) {
    return a && /^\d{4}-\d{4}$/.test(a) ? a : this.params.get('ANNEE_SCOLAIRE');
  }

  private presenter(e: EvaluationAgent) {
    return {
      ...e,
      lecture: lecture(e.competenceProfessionnelle, e.competenceSociale),
    };
  }

  async evaluationsAgent(u: UtilisateurConnecte, agentId: number) {
    await this.rec.trouver(u, agentId);
    const liste = await this.evaluations.find({
      where: { agentId },
      order: { annee: 'DESC' },
    });
    return {
      evaluations: liste.map((e) => this.presenter(e)),
      anneeCourante: this.annee(),
      decisions: DECISIONS,
      appreciations: APPRECIATIONS.slice(1),
    };
  }

  /** Évaluation d'une année (une par agent et par année : la refaire la remplace). */
  async evaluer(
    u: UtilisateurConnecte,
    agentId: number,
    dto: {
      annee?: string;
      date?: string;
      competenceProfessionnelle?: number;
      competenceSociale?: number;
      decision?: string | null;
      commentaireProfessionnel?: string | null;
      commentaireSocial?: string | null;
    },
  ) {
    const a = await this.rec.trouver(u, agentId);
    const pro = Number(dto.competenceProfessionnelle);
    const social = Number(dto.competenceSociale);
    for (const [n, l] of [
      [pro, 'professionnelle'],
      [social, 'sociale'],
    ] as const)
      if (!Number.isInteger(n) || n < 1 || n > 5)
        throw new BadRequestException(
          `Notez la compétence ${l} de 1 (très faible) à 5 (excellent).`,
        );
    const annee = this.annee(dto.annee);
    const date = dto.date && DATE.test(dto.date) ? dto.date : aujourdhui();
    const globale = (pro + social) / 2;
    const e =
      (await this.evaluations.findOne({ where: { agentId, annee } })) ??
      this.evaluations.create({ agentId, annee });
    Object.assign(e, {
      date,
      competenceProfessionnelle: pro,
      competenceSociale: social,
      globale,
      appreciation: appreciation(globale),
      decision: texte(dto.decision, 200),
      commentaireProfessionnel: texte(dto.commentaireProfessionnel, 1000),
      commentaireSocial: texte(dto.commentaireSocial, 1000),
      structureId: a.structureId,
      evaluateur: u.nom,
    });
    const r = await this.evaluations.save(e);
    await this.journal.log(
      u,
      'PERSONNEL_EVALUATION',
      'agent_recense',
      agentId,
      { annee, professionnelle: pro, sociale: social, globale },
    );
    return this.presenter(r);
  }

  async supprimerEvaluation(
    u: UtilisateurConnecte,
    agentId: number,
    id: string,
  ) {
    await this.rec.trouver(u, agentId);
    const e = await this.evaluations.findOne({ where: { id, agentId } });
    if (!e) throw new NotFoundException('Évaluation introuvable');
    await this.evaluations.delete(e.id);
    await this.journal.log(
      u,
      'PERSONNEL_EVALUATION_RETIREE',
      'agent_recense',
      agentId,
      { annee: e.annee },
    );
    return { supprime: true };
  }

  /** Campagne d'une année : agents du périmètre, leur évaluation, et la répartition. */
  async campagne(
    u: UtilisateurConnecte,
    f: {
      annee?: string;
      structure?: number;
      departement?: number;
      q?: string;
      etat?: string;
      page?: number;
    },
  ) {
    const p = await this.rec.perimetre(u);
    const annee = this.annee(f.annee);
    const conds = ['TRUE'];
    const params: unknown[] = [annee];
    const ajouter = (sql: string, v: unknown) => {
      params.push(v);
      conds.push(sql.replace('$X', `$${params.length}`));
    };
    if ('departementId' in p)
      ajouter('a."departementId" = $X', p.departementId);
    if ('structures' in p) ajouter('a."structureId" = ANY($X)', p.structures);
    if (f.structure) ajouter('a."structureId" = $X', f.structure);
    if (f.departement) ajouter('a."departementId" = $X', f.departement);
    for (const m of normaliser(f.q ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 4))
      ajouter('a."nomNormalise" LIKE $X', `%${m}%`);
    const base = `FROM agent_recense a LEFT JOIN evaluation_agent e ON e."agentId" = a.id AND e.annee = $1
                  LEFT JOIN structure s ON s.id = a."structureId" WHERE ${conds.join(' AND ')}`;
    const [stats] = await this.evaluations.query<
      {
        total: number;
        evalues: number;
        moyennePro: number | null;
        moyenneSociale: number | null;
        tf: number;
        f: number;
        b: number;
        tb: number;
        ex: number;
        relations: number;
        metier: number;
      }[]
    >(
      `SELECT count(*)::int AS total, count(e.id)::int AS evalues,
              round(avg(e."competenceProfessionnelle")::numeric, 1)::float AS "moyennePro",
              round(avg(e."competenceSociale")::numeric, 1)::float AS "moyenneSociale",
              count(*) FILTER (WHERE e.appreciation = 'Très faible')::int AS tf,
              count(*) FILTER (WHERE e.appreciation = 'Faible')::int AS f,
              count(*) FILTER (WHERE e.appreciation = 'Bon')::int AS b,
              count(*) FILTER (WHERE e.appreciation = 'Très bon')::int AS tb,
              count(*) FILTER (WHERE e.appreciation = 'Excellent')::int AS ex,
              count(*) FILTER (WHERE e."competenceProfessionnelle" >= 3 AND e."competenceSociale" < 3)::int AS relations,
              count(*) FILTER (WHERE e."competenceProfessionnelle" < 3 AND e."competenceSociale" >= 3)::int AS metier
         ${base}`,
      params,
    );
    const filtreEtat =
      f.etat === 'NON_EVALUE'
        ? ' AND e.id IS NULL'
        : f.etat === 'EVALUE'
          ? ' AND e.id IS NOT NULL'
          : f.etat === 'A_SUIVRE'
            ? ' AND e.globale < 3'
            : '';
    const page = Math.max(1, f.page ?? 1);
    const lignes = await this.evaluations.query<
      {
        id: number;
        nomComplet: string;
        statut: string;
        fonction: string | null;
        structure: string | null;
        evaluationId: string | null;
        competenceProfessionnelle: number | null;
        competenceSociale: number | null;
        globale: number | null;
        appreciation: string | null;
        decision: string | null;
        evaluateur: string | null;
        date: string | null;
        commentaireProfessionnel: string | null;
        commentaireSocial: string | null;
      }[]
    >(
      `SELECT a.id, a."nomComplet", a.statut, a.donnees->>'FONCTION' AS fonction, s.nom AS structure,
              e.id AS "evaluationId", e."competenceProfessionnelle", e."competenceSociale", e.globale, e.appreciation, e.decision, e.evaluateur,
              to_char(e.date, 'YYYY-MM-DD') AS date, e."commentaireProfessionnel", e."commentaireSocial"
         ${base}${filtreEtat} ORDER BY e.globale ASC NULLS FIRST, a."nomComplet" LIMIT 50 OFFSET ${(page - 1) * 50}`,
      params,
    );
    return { annee, stats, page, lignes, decisions: DECISIONS };
  }
}
