import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { normaliser } from '../common/texte';
import { JournalService, ParametresService } from '../core/core.service';
import {
  EmploiDuTemps,
  EvaluationAgent,
  HoraireAgent,
  Presence,
  SemainePresence,
} from '../entities';
import { RecensementService } from '../recensement/recensement.service';
import { valeurLisible } from '../recensement/valeurs';
import { EtablissementsService } from './etablissements.service';
import {
  ABSENCES,
  analyseJour,
  bilanSemaine,
  type Cours,
  type CoursSemaine,
  heures as heuresLisibles,
  horaireEffectif,
  joursAttendus,
  type Pointage,
  type ReglagesPresence,
  retard,
} from './presence-regles';
import type { Seance } from './emploi-du-temps-regles';

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
    'Renforcement de capacités urgent',
    'Mise en observation avec accompagnement',
    'Réaffectation avec renforcement de capacités',
  ],
  Faible: [
    'Renforcement de capacités recommandé',
    'Suivi régulier par un tuteur',
    'Plan d’amélioration personnalisé',
  ],
  Bon: [
    'Maintien au poste',
    'Renforcement de capacités encouragé',
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

/**
 * La moyenne de l'échelle de 1 à 5 (DG, 24/10/2026) : à 2,5, l'agent a la moyenne ; en dessous,
 * il est dans la zone des faibles.
 */
export const MOYENNE = 2.5;

/**
 * L'appréciation d'une évaluation lue sur sa note globale (et non sur le texte enregistré) : 2,5,
 * la moyenne, est « Bon » (DG, 30/10/2026 : des évaluations à 2,5 étaient restées « Faible »).
 */
const APPRECIATION_SQL = `CASE WHEN e.globale >= 5 THEN 'Excellent' WHEN e.globale >= 4 THEN 'Très bon' WHEN e.globale >= ${MOYENNE} THEN 'Bon' WHEN e.globale >= 2 THEN 'Faible' ELSE 'Très faible' END`;

/**
 * Appréciation de la note globale : 2,5 (la moyenne) et 3,5 restent « bon », 4 et 4,5 « très bon »,
 * 5 « excellent » ; 2 « faible », 1 et 1,5 « très faible ».
 */
export const appreciation = (globale: number) =>
  APPRECIATIONS[
    globale >= 5
      ? 5
      : globale >= 4
        ? 4
        : globale >= MOYENNE
          ? 3
          : globale >= 2
            ? 2
            : 1
  ];

/** Ce que dit l'écart entre les deux compétences (2 en professionnel et 4 en social ≠ l'inverse). */
export function lecture(pro: number, social: number) {
  if (pro >= MOYENNE && social >= MOYENNE)
    return 'Compétent dans son métier et à l’aise avec les autres.';
  if (pro >= MOYENNE)
    return 'Compétent dans son métier, mais relations difficiles avec son entourage.';
  if (social >= MOYENNE)
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
const anneeCivile = () => aujourdhui().slice(0, 4);
const lundiDe = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  return plusJours(date, -((d.getUTCDay() + 6) % 7));
};
const texte = (v: unknown, n: number) =>
  typeof v === 'string'
    ? v.replace(/\s+/g, ' ').trim().slice(0, n) || null
    : null;

@Injectable()
export class SuiviService implements OnApplicationBootstrap {
  private readonly log = new Logger('Suivi');

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

  /**
   * Évaluations faites avant le passage à l'année civile (DG, 24/10/2026) : « 2026-2027 » devient
   * l'année de leur date (« 2026 »), sauf si l'agent a déjà une évaluation cette année-là.
   */
  async onApplicationBootstrap() {
    // Appréciations enregistrées avec l'ancien seuil (3) : remises d'accord avec la note globale
    try {
      const r = await this.evaluations.query<unknown[]>(
        `UPDATE evaluation_agent e SET appreciation = ${APPRECIATION_SQL}
          WHERE e.appreciation IS DISTINCT FROM ${APPRECIATION_SQL} RETURNING e.id`,
      );
      const n = Array.isArray(r[0]) ? r[0].length : r.length;
      if (n)
        this.log.log(
          `${n} appréciation(s) remise(s) d’accord avec la note globale`,
        );
    } catch (e) {
      this.log.error(`Appréciations : ${(e as Error).message}`);
    }
    try {
      const r = await this.evaluations.query<unknown[]>(
        `UPDATE evaluation_agent e SET annee = to_char(e.date, 'YYYY')
          WHERE e.annee ~ '^[0-9]{4}-[0-9]{4}$'
            AND NOT EXISTS (SELECT 1 FROM evaluation_agent x
                             WHERE x."agentId" = e."agentId" AND x.annee = to_char(e.date, 'YYYY'))
          RETURNING e.id`,
      );
      const n = Array.isArray(r[0]) ? r[0].length : r.length;
      if (n)
        this.log.log(
          `${n} évaluation(s) passée(s) de l’année scolaire à l’année civile`,
        );
    } catch (e) {
      this.log.error(`Évaluations (année civile) : ${(e as Error).message}`);
    }
  }

  /* ------------------------------ Présence ------------------------------ */

  /** Marges et seuils de la présence (Paramètres : PRESENCE_…). */
  reglages(): ReglagesPresence {
    const n = (k: string, d: number) => {
      const v = Number(this.params.get(k));
      return Number.isFinite(v) && v >= 0 ? v : d;
    };
    const [debutDefaut, finDefaut] = (
      this.params.get('PRESENCE_HORAIRE_DEFAUT') || '07:30-14:00'
    )
      .split('-')
      .map((x) => x.trim());
    return {
      toleranceArrivee: n('PRESENCE_TOLERANCE_ARRIVEE', 10),
      toleranceDepart: n('PRESENCE_TOLERANCE_DEPART', 10),
      retardGrave: n('PRESENCE_RETARD_GRAVE', 60),
      retardsFrequents: n('PRESENCE_RETARDS_FREQUENTS', 3),
      absencesFrequentes: n('PRESENCE_ABSENCES_FREQUENTES', 3),
      debutDefaut: debutDefaut || '07:30',
      finDefaut: finDefaut || '14:00',
    };
  }

  /**
   * Cours de chaque enseignant, jour par jour, d'après l'emploi du temps de l'année des structures
   * (le plus récent) : c'est à eux que se comparent ses heures d'arrivée et de départ.
   */
  private async coursParAgent(structureIds: number[]) {
    const res = new Map<number, CoursSemaine>();
    if (!structureIds.length) return res;
    const annee = this.params.get('ANNEE_SCOLAIRE');
    const edts = await this.presences.manager.find(EmploiDuTemps, {
      where: { structureId: In(structureIds), anneeScolaire: annee },
      order: { genereLe: 'DESC' },
    });
    const vus = new Set<number>();
    for (const e of edts) {
      if (vus.has(e.structureId)) continue;
      vus.add(e.structureId);
      for (const x of e.seances as unknown as Seance[]) {
        // Une plage saisie à ses propres heures (07:00-08:00) garde ses heures, sinon celles du créneau
        const c =
          x.debut && x.fin
            ? { debut: x.debut, fin: x.fin }
            : e.creneaux[x.creneau];
        if (!x.agentId || !c) continue;
        const m = res.get(x.agentId) ?? {};
        const j = String(x.jour);
        const cours: Cours = {
          debut: c.debut,
          fin: c.fin,
          libelle: [x.classe, x.matiereLibelle].filter(Boolean).join(' · '),
        };
        m[j] = [...(m[j] ?? []), cours].sort((a, b) =>
          a.debut.localeCompare(b.debut),
        );
        res.set(x.agentId, m);
      }
    }
    return res;
  }

  private lundi(date?: string) {
    return lundiDe(date && DATE.test(date) ? date : aujourdhui());
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
    const avant = dates.map((d) => plusJours(d, -7));
    const [horaires, saisies, validee] = await Promise.all([
      this.horaires.find({ where: { agentId: In(ids.length ? ids : [-1]) } }),
      this.presences.query<
        {
          agentId: number;
          date: string;
          statut: string;
          motif: string | null;
          arrivee: string | null;
          depart: string | null;
        }[]
      >(
        // Avec la semaine d'avant : « deux semaines d'affilée sans travailler »
        `SELECT "agentId", to_char(date, 'YYYY-MM-DD') AS date, statut, motif, arrivee, depart FROM presence
          WHERE "agentId" = ANY($1) AND date BETWEEN $2 AND $3`,
        [ids, avant[0], dates[5]],
      ),
      this.semaines.findOne({ where: { structureId, lundi } }),
    ]);
    const hParAgent = new Map(horaires.map((h) => [h.agentId, h]));
    const r = this.reglages();
    const coursDe = await this.coursParAgent([structureId]);
    const auj = aujourdhui();
    // Les alertes tombent en fin de semaine : semaine validée ou terminée
    const finie = !!validee || dates[5] < auj;
    const lignes = agents.map((a) => {
      const h = hParAgent.get(a.id);
      // Heures attendues : emploi du temps, sinon horaire saisi, sinon heures par défaut
      const cours = coursDe.get(a.id) ?? {};
      const eff = horaireEffectif(h?.jours, cours, r);
      const jours = joursAttendus(eff.jours);
      const pts: Record<
        string,
        Pointage & {
          motif: string | null;
          retard: number | null;
          analyse: ReturnType<typeof analyseJour>;
        }
      > = {};
      const precedents: Record<string, Pointage> = {};
      for (const x of saisies) {
        if (x.agentId !== a.id) continue;
        if (x.date < dates[0]) precedents[x.date] = x;
        else {
          const jour = dates.indexOf(x.date) + 1;
          pts[x.date] = {
            statut: x.statut,
            motif: x.motif,
            arrivee: x.arrivee,
            depart: x.depart,
            retard: retard(eff.jours, jour, x.arrivee, r.toleranceArrivee),
            analyse: analyseJour(
              eff.jours[String(jour)],
              cours[String(jour)] ?? [],
              x,
              r,
            ),
          };
        }
      }
      const bilan = bilanSemaine(
        eff.jours,
        dates,
        pts,
        { dates: avant, pointages: precedents },
        r.toleranceArrivee,
      );
      return {
        id: a.id,
        nomComplet: a.nomComplet,
        fonction: a.fonction,
        horaire: h?.jours ?? null,
        // Ce qui est attendu chaque jour, et d'où cela vient
        prevu: eff.jours,
        source: eff.source,
        cours,
        attendus: dates.map((_, i) => jours.includes(i + 1)),
        saisies: pts,
        bilan: { ...bilan, alertes: finie ? bilan.alertes : [] },
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
      finie,
      alertes: lignes.reduce((n, l) => n + l.bilan.alertes.length, 0),
      validee: validee
        ? { par: validee.valideePar, le: validee.valideeLe }
        : null,
      statuts: STATUTS_PRESENCE,
      reglages: r,
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
      arrivee?: string | null;
      depart?: string | null;
    }[],
  ) {
    await this.etab.structure(u, structureId);
    if (!Array.isArray(saisies) || !saisies.length) return { enregistres: 0 };
    const agents = new Set(
      ((await this.etab.agentsDe([structureId])).get(structureId) ?? []).map(
        (a) => a.id,
      ),
    );
    const horaires = new Map(
      (
        await this.horaires.find({
          where: { agentId: In([...agents].length ? [...agents] : [-1]) },
        })
      ).map((h) => [h.agentId, h.jours]),
    );
    const r = this.reglages();
    const coursDe = await this.coursParAgent([structureId]);
    const auj = aujourdhui();
    // Une semaine validée par le chef est close : plus aucun pointage n'y change
    const lundis = [
      ...new Set(
        saisies
          .filter((x) => DATE.test(x.date ?? ''))
          .map((x) => lundiDe(x.date)),
      ),
    ];
    const closes = lundis.length
      ? await this.semaines.find({ where: { structureId, lundi: In(lundis) } })
      : [];
    if (closes.length)
      throw new BadRequestException(
        `Semaine du ${closes.map((s) => s.lundi.split('-').reverse().join('/')).join(', ')} déjà validée : elle n’est plus modifiable.`,
      );
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
      // Heures d'arrivée et de départ : facultatives, seulement pour un agent venu
      const absent = x.statut.startsWith('ABSENT');
      const arrivee = !absent && x.arrivee ? x.arrivee : null;
      const depart = !absent && x.depart ? x.depart : null;
      if ((arrivee && !HEURE.test(arrivee)) || (depart && !HEURE.test(depart)))
        throw new BadRequestException(
          'Heure invalide : écrivez-la comme 07:30 (heures:minutes).',
        );
      if (arrivee && depart && depart <= arrivee)
        throw new BadRequestException(
          'L’heure de départ est avant l’heure d’arrivée.',
        );
      // Arrivé après l'heure prévue de ce jour, au-delà de la marge : en retard ; revenu dans la marge : présent
      const jour = ((new Date(`${x.date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
      const eff = horaireEffectif(
        horaires.get(Number(x.agentId)),
        coursDe.get(Number(x.agentId)),
        r,
      );
      const minutesRetard = retard(
        eff.jours,
        jour,
        arrivee,
        r.toleranceArrivee,
      );
      const statut =
        ['PRESENT', 'RETARD'].includes(x.statut) && minutesRetard !== null
          ? minutesRetard > 0
            ? 'RETARD'
            : 'PRESENT'
          : x.statut;
      await this.presences.query(
        `INSERT INTO presence ("agentId", "structureId", date, statut, motif, arrivee, depart, "saisiPar", "saisiLe")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT ("agentId", date) DO UPDATE SET statut = EXCLUDED.statut, motif = EXCLUDED.motif,
           arrivee = EXCLUDED.arrivee, depart = EXCLUDED.depart,
           "structureId" = EXCLUDED."structureId", "saisiPar" = EXCLUDED."saisiPar", "saisiLe" = now()`,
        [
          Number(x.agentId),
          structureId,
          x.date,
          statut,
          texte(x.motif, 200),
          arrivee,
          depart,
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
    if (g.validee)
      throw new BadRequestException(
        'Cette semaine est déjà validée : elle n’est plus modifiable.',
      );
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
    // Les alertes de fin de semaine, tout de suite visibles par le chef
    const apres = await this.semaine(u, structureId, g.lundi);
    return {
      valide: true,
      alertes: apres.agents
        .filter((a) => a.bilan.alertes.length)
        .map((a) => ({ agent: a.nomComplet, alertes: a.bilan.alertes })),
    };
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
   * Rapport de présence d'une période : par structure (agents en poste, journées attendues et
   * pointées, présence, absences) et les semaines que les chefs n'ont pas validées.
   * Revu le 30/10/2026 (DG : « relève les incohérences ») :
   * - les agents comptés sont ceux en poste, les seuls que l'on pointe ;
   * - le taux de pointage (journées pointées sur journées attendues) dit si le chef pointe vraiment :
   *   un taux de présence de 100 % sur un seul jour pointé ne veut rien dire seul ;
   * - les semaines dues commencent à la mise en service de la présence (premier pointage du
   *   système), pas avant ; la fin de période ne dépasse pas aujourd'hui (heure de Brazzaville).
   */
  async rapport(
    u: UtilisateurConnecte,
    f: { departement?: number; structure?: number; du?: string; au?: string },
  ) {
    const p = await this.rec.perimetre(u);
    const auj = aujourdhui();
    const au = f.au && DATE.test(f.au) && f.au <= auj ? f.au : auj;
    const du = f.du && DATE.test(f.du) ? f.du : plusJours(au, -27);
    if (du > au) throw new BadRequestException('La période est inversée.');
    if (plusJours(du, 186) < au)
      throw new BadRequestException(
        'Six mois au plus : choisissez une période plus courte.',
      );
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
    // Mise en service de la présence : le premier pointage enregistré dans le système
    const [{ lancement }] = await this.presences.query<
      { lancement: string | null }[]
    >(`SELECT to_char(min(date), 'YYYY-MM-DD') AS lancement FROM presence`);
    // Agents en poste et journées attendues de chaque structure (emploi du temps, horaire ou défaut),
    // à partir de la mise en service et de la fiche de l'agent
    const ids = structures.map((s) => s.id);
    const parStructure = await this.etab.agentsDe(ids);
    const enPoste = [...parStructure.values()].flat().filter((a) => a.enPoste);
    const idsAgents = enPoste.map((a) => a.id);
    const r = this.reglages();
    const [horaires, coursDe, crees] = await Promise.all([
      idsAgents.length
        ? this.horaires.find({ where: { agentId: In(idsAgents) } })
        : Promise.resolve([] as HoraireAgent[]),
      this.coursParAgent(ids),
      idsAgents.length
        ? this.presences.query<{ id: number; d: string }[]>(
            `SELECT id, to_char("creeLe", 'YYYY-MM-DD') AS d FROM agent_recense WHERE id = ANY($1)`,
            [idsAgents],
          )
        : Promise.resolve([] as { id: number; d: string }[]),
    ]);
    const hDe = new Map(horaires.map((h) => [h.agentId, h.jours]));
    const creeLe = new Map(crees.map((x) => [x.id, x.d]));
    const jours: { d: string; j: number }[] = [];
    if (lancement)
      for (
        let d = du > lancement ? du : lancement;
        d <= au;
        d = plusJours(d, 1)
      ) {
        const j = ((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
        if (j <= 6) jours.push({ d, j });
      }
    const attendues = new Map<number, { agents: number; journees: number }>();
    for (const [sid, l] of parStructure) {
      let journees = 0;
      const poste = l.filter((a) => a.enPoste);
      for (const a of poste) {
        const att = joursAttendus(
          horaireEffectif(hDe.get(a.id), coursDe.get(a.id), r).jours,
        );
        const depuis = creeLe.get(a.id) ?? '';
        journees += jours.filter(
          (x) => x.d >= depuis && att.includes(x.j),
        ).length;
      }
      attendues.set(sid, { agents: poste.length, journees });
    }
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
    // Une semaine est due une fois terminée (à partir du lundi suivant), depuis la mise en service
    const dues = lancement
      ? lundis.filter(
          (l) => plusJours(l, 7) <= auj && plusJours(l, 5) >= lancement,
        )
      : [];
    const lignes = structures.map((s) => {
      const nonValidees = dues.filter((l) => !vu.has(`${s.id}|${l}`));
      const att = attendues.get(s.id) ?? { agents: 0, journees: 0 };
      return {
        ...s,
        agents: att.agents,
        journeesAttendues: att.journees,
        // Journées pointées sur journées attendues (plafonné : un jour hors horaire peut être pointé)
        tauxPointage: att.journees
          ? Math.min(100, Math.round((100 * s.pointages) / att.journees))
          : null,
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
    const alertes = await this.alertesPeriode(
      validees,
      dues.length ? dues : lundis,
    );
    const tot = lignes.reduce(
      (t, l) => ({
        pointages: t.pointages + l.pointages,
        presents: t.presents + l.presents + l.retards,
        attendues: t.attendues + l.journeesAttendues,
      }),
      { pointages: 0, presents: 0, attendues: 0 },
    );
    return {
      du,
      au,
      semainesDues: dues,
      lancement,
      taux: tot.pointages
        ? Math.round((100 * tot.presents) / tot.pointages)
        : null,
      journeesAttendues: tot.attendues,
      journeesPointees: tot.pointages,
      tauxPointage: tot.attendues
        ? Math.min(100, Math.round((100 * tot.pointages) / tot.attendues))
        : null,
      // Les structures qui pointent le moins d'abord, puis celles qui ont le plus de semaines en retard
      structures: lignes.sort(
        (a, b) =>
          b.semainesNonValidees.length - a.semainesNonValidees.length ||
          (a.tauxPointage ?? -1) - (b.tauxPointage ?? -1) ||
          (a.taux ?? 101) - (b.taux ?? 101),
      ),
      sansPointage: lignes.filter((l) => l.semainesNonValidees.length).length,
      absents,
      alertes,
    };
  }

  /**
   * Retards et absences « comme une vraie école » (DG, 30/10/2026) : pour chaque agent de la période,
   * ses jours attendus (emploi du temps, horaire ou défaut), ses présences, ses retards (nombre, total,
   * moyenne, retards d'une heure ou plus), ses départs anticipés, les cours qu'il a manqués et ses
   * absences ; ceux qui sont souvent en retard ou souvent absents d'après les seuils réglés. Et la
   * journée d'aujourd'hui : qui est en retard, de combien, qui est absent, qui n'est pas pointé.
   */
  async analyse(
    u: UtilisateurConnecte,
    f: { departement?: number; structure?: number; du?: string; au?: string },
  ) {
    const auj = aujourdhui();
    const au = f.au && DATE.test(f.au) && f.au <= auj ? f.au : auj;
    const du = f.du && DATE.test(f.du) ? f.du : plusJours(au, -29);
    if (du > au) throw new BadRequestException('La période est inversée.');
    if (plusJours(du, 186) < au)
      throw new BadRequestException(
        'Six mois au plus : choisissez une période plus courte.',
      );
    const r = this.reglages();
    // Structures : celle choisie (contrôle d'accès), sinon celles du périmètre qui ont pointé
    let structures: number[];
    if (f.structure) {
      await this.etab.structure(u, f.structure);
      structures = [f.structure];
    } else {
      const p = await this.rec.perimetre(u);
      const conds = ['p.date BETWEEN $1 AND $2'];
      const params: unknown[] = [du, au];
      const ajouter = (sql: string, v: unknown) => {
        params.push(v);
        conds.push(sql.replace('$X', `$${params.length}`));
      };
      if ('departementId' in p)
        ajouter('s."departementId" = $X', p.departementId);
      if ('structures' in p) ajouter('s.id = ANY($X)', p.structures);
      if (f.departement) ajouter('s."departementId" = $X', f.departement);
      structures = (
        await this.presences.query<{ id: number }[]>(
          `SELECT DISTINCT s.id FROM presence p JOIN structure s ON s.id = p."structureId" WHERE ${conds.join(' AND ')} LIMIT 400`,
          params,
        )
      ).map((x) => x.id);
    }
    const parStructure = await this.etab.agentsDe(structures);
    const nomsStructures = new Map(
      (structures.length
        ? await this.presences.query<{ id: number; nom: string }[]>(
            `SELECT id, nom FROM structure WHERE id = ANY($1)`,
            [structures],
          )
        : []
      ).map((x) => [x.id, x.nom]),
    );
    const agents = [...parStructure.entries()]
      .flatMap(([sid, l]) =>
        l.filter((a) => a.enPoste).map((a) => ({ ...a, structureId: sid })),
      )
      .slice(0, 3000);
    const ids = agents.map((a) => a.id);
    const [horaires, pts, coursDe] = await Promise.all([
      ids.length
        ? this.horaires.find({ where: { agentId: In(ids) } })
        : Promise.resolve([] as HoraireAgent[]),
      ids.length
        ? this.presences.query<
            {
              agentId: number;
              date: string;
              statut: string;
              motif: string | null;
              arrivee: string | null;
              depart: string | null;
            }[]
          >(
            `SELECT "agentId", to_char(date, 'YYYY-MM-DD') AS date, statut, motif, arrivee, depart FROM presence
              WHERE "agentId" = ANY($1) AND date BETWEEN $2 AND $3`,
            [ids, du, au],
          )
        : Promise.resolve([]),
      this.coursParAgent(structures),
    ]);
    const hDe = new Map(horaires.map((h) => [h.agentId, h.jours]));
    // On compte à partir de la fiche de l'agent et du premier pointage de sa structure : avant,
    // il n'y avait rien à pointer (agent pas encore enregistré, école qui ne pointait pas encore)
    const [crees, premiers] = ids.length
      ? await Promise.all([
          this.presences.query<{ id: number; d: string }[]>(
            `SELECT id, to_char("creeLe", 'YYYY-MM-DD') AS d FROM agent_recense WHERE id = ANY($1)`,
            [ids],
          ),
          this.presences.query<{ id: number; d: string }[]>(
            `SELECT "structureId" AS id, to_char(min(date), 'YYYY-MM-DD') AS d FROM presence WHERE "structureId" = ANY($1) GROUP BY 1`,
            [structures],
          ),
        ])
      : [[], []];
    const creeLe = new Map(crees.map((x) => [x.id, x.d]));
    const premierPointage = new Map(premiers.map((x) => [x.id, x.d]));
    const ptsDe = new Map<number, Map<string, (typeof pts)[number]>>();
    for (const x of pts) {
      const m = ptsDe.get(x.agentId) ?? new Map<string, (typeof pts)[number]>();
      m.set(x.date, x);
      ptsDe.set(x.agentId, m);
    }
    // Jours de la période (lundi à samedi)
    const dates: string[] = [];
    for (let d = du; d <= au; d = plusJours(d, 1)) {
      const j = (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7;
      if (j < 6) dates.push(d);
    }
    const jourDe = (d: string) =>
      ((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
    const SOURCES = {
      EDT: 'emploi du temps',
      HORAIRE: 'horaire saisi',
      DEFAUT: 'heures par défaut',
    };
    const aujourdhuiListe: {
      agentId: number;
      nomComplet: string;
      structure: string;
      prevu: string | null;
      arrivee: string | null;
      depart: string | null;
      cas:
        | 'RETARD'
        | 'DEPART_ANTICIPE'
        | 'ABSENT'
        | 'ABSENT_JUSTIFIE'
        | 'NON_POINTE';
      minutes: number;
      grave: boolean;
      coursManques: string[];
      motif: string | null;
    }[] = [];
    const lignes = agents.map((a) => {
      const cours = coursDe.get(a.id) ?? {};
      const eff = horaireEffectif(hDe.get(a.id), cours, r);
      const attendusJ = joursAttendus(eff.jours);
      const m: Map<string, (typeof pts)[number]> =
        ptsDe.get(a.id) ?? new Map<string, (typeof pts)[number]>();
      const st = {
        attendus: 0,
        pointes: 0,
        presents: 0,
        aLHeure: 0,
        retards: 0,
        minutesRetard: 0,
        retardsGraves: 0,
        departsAnticipes: 0,
        minutesDepartAnticipe: 0,
        coursManques: 0,
        minutesCoursPerdues: 0,
        absencesJustifiees: 0,
        absencesNonJustifiees: 0,
        nonPointes: 0,
        dernierRetard: null as string | null,
      };
      const debut = [creeLe.get(a.id), premierPointage.get(a.structureId)]
        .filter((x): x is string => !!x)
        .sort()
        .at(-1);
      for (const d of dates) {
        const j = jourDe(d);
        if (!attendusJ.includes(j)) continue;
        // Un jour pointé compte toujours ; un jour vide, seulement après le début du suivi
        if (!m.has(d) && debut && d < debut) continue;
        st.attendus++;
        const p = m.get(d);
        const prevu = eff.jours[String(j)];
        const base = {
          agentId: a.id,
          nomComplet: a.nomComplet,
          structure: nomsStructures.get(a.structureId) ?? '',
          prevu: prevu?.debut ? `${prevu.debut}–${prevu.fin ?? '?'}` : null,
          arrivee: p?.arrivee ?? null,
          depart: p?.depart ?? null,
          motif: p?.motif ?? null,
        };
        if (!p) {
          st.nonPointes++;
          if (d === auj)
            aujourdhuiListe.push({
              ...base,
              cas: 'NON_POINTE',
              minutes: 0,
              grave: false,
              coursManques: [],
            });
          continue;
        }
        st.pointes++;
        if (ABSENCES.includes(p.statut)) {
          if (p.statut === 'ABSENT') st.absencesNonJustifiees++;
          else st.absencesJustifiees++;
          if (d === auj)
            aujourdhuiListe.push({
              ...base,
              cas: p.statut === 'ABSENT' ? 'ABSENT' : 'ABSENT_JUSTIFIE',
              minutes: 0,
              grave: false,
              coursManques: (cours[String(j)] ?? []).map(
                (c) => `${c.debut} ${c.libelle}`,
              ),
            });
          continue;
        }
        st.presents++;
        const x = analyseJour(prevu, cours[String(j)] ?? [], p, r);
        if (x.retard) {
          st.retards++;
          st.minutesRetard += x.retard;
          st.dernierRetard = d;
          if (x.retardGrave) st.retardsGraves++;
        } else st.aLHeure++;
        if (x.departAnticipe) {
          st.departsAnticipes++;
          st.minutesDepartAnticipe += x.departAnticipe;
        }
        st.coursManques += x.coursManques.length;
        st.minutesCoursPerdues += x.minutesCoursPerdues;
        if (d === auj && x.retard)
          aujourdhuiListe.push({
            ...base,
            cas: 'RETARD',
            minutes: x.retard,
            grave: x.retardGrave,
            coursManques: x.coursManques.map((c) => `${c.debut} ${c.libelle}`),
          });
        if (d === auj && x.departAnticipe)
          aujourdhuiListe.push({
            ...base,
            cas: 'DEPART_ANTICIPE',
            minutes: x.departAnticipe,
            grave: false,
            coursManques: x.coursManques.map((c) => `${c.debut} ${c.libelle}`),
          });
      }
      return {
        agentId: a.id,
        nomComplet: a.nomComplet,
        fonction: a.fonction,
        enseignant: a.enseignant,
        structureId: a.structureId,
        structure: nomsStructures.get(a.structureId) ?? '',
        source: eff.source,
        sourceLibelle: SOURCES[eff.source],
        ...st,
        retardMoyen: st.retards ? Math.round(st.minutesRetard / st.retards) : 0,
        // Ponctualité : jours venus à l'heure sur les jours venus
        ponctualite: st.presents
          ? Math.round((100 * st.aLHeure) / st.presents)
          : null,
        souventEnRetard: st.retards >= r.retardsFrequents,
        souventAbsent: st.absencesNonJustifiees >= r.absencesFrequentes,
      };
    });
    const somme = (k: keyof (typeof lignes)[number]) =>
      lignes.reduce((s, l) => s + (Number(l[k]) || 0), 0);
    const parCas = (c: string) => aujourdhuiListe.filter((x) => x.cas === c);
    return {
      du,
      au,
      aujourdhui: auj,
      reglages: r,
      structures: structures.length,
      totaux: {
        agents: lignes.length,
        retards: somme('retards'),
        minutesRetard: somme('minutesRetard'),
        retardsGraves: somme('retardsGraves'),
        departsAnticipes: somme('departsAnticipes'),
        minutesCoursPerdues: somme('minutesCoursPerdues'),
        absencesNonJustifiees: somme('absencesNonJustifiees'),
        absencesJustifiees: somme('absencesJustifiees'),
        souventEnRetard: lignes.filter((l) => l.souventEnRetard).length,
        souventAbsent: lignes.filter((l) => l.souventAbsent).length,
        heuresCoursPerdues: heuresLisibles(somme('minutesCoursPerdues')),
      },
      jour: {
        // Retards du jour, du plus long au plus court
        retards: parCas('RETARD').sort((a, b) => b.minutes - a.minutes),
        departs: parCas('DEPART_ANTICIPE').sort(
          (a, b) => b.minutes - a.minutes,
        ),
        absents: parCas('ABSENT'),
        justifies: parCas('ABSENT_JUSTIFIE'),
        nonPointes: parCas('NON_POINTE'),
      },
      agents: lignes.sort(
        (a, b) =>
          b.minutesRetard - a.minutesRetard ||
          b.absencesNonJustifiees - a.absencesNonJustifiees ||
          a.nomComplet.localeCompare(b.nomComplet),
      ),
    };
  }

  /**
   * Alertes de présence de la période (4 dernières semaines par défaut), pour le panneau « Alertes » :
   * en premier, les agents restés deux semaines d'affilée sans travailler.
   */
  async alertesPresence(
    u: UtilisateurConnecte,
    periode: { du?: string; au?: string } = {},
  ) {
    const r = await this.rapport(u, periode);
    const rang = (x: { alertes: { code: string }[] }) =>
      x.alertes.some((a) => a.code === 'DEUX_SEMAINES') ? 0 : 1;
    return [...r.alertes].sort(
      (a, b) => rang(a) - rang(b) || b.lundi.localeCompare(a.lundi),
    );
  }

  /**
   * Alertes de fin de semaine de la période (semaines validées par les chefs) : absent plus de la
   * moitié des jours, moins de la moitié des heures, deux semaines d'affilée sans travailler.
   */
  private async alertesPeriode(
    validees: { structureId: number; lundi: string }[],
    lundis: string[],
  ) {
    const semaines = validees.filter((v) => lundis.includes(v.lundi));
    if (!semaines.length) return [];
    const structures = [...new Set(semaines.map((v) => v.structureId))];
    const parStructure = await this.etab.agentsDe(structures);
    const ids = [...parStructure.values()].flat().map((a) => a.id);
    if (!ids.length) return [];
    const debut = plusJours([...lundis].sort()[0], -7);
    const fin = plusJours([...lundis].sort().at(-1)!, 5);
    const [horaires, pts, noms] = await Promise.all([
      this.horaires.find({ where: { agentId: In(ids) } }),
      this.presences.query<
        {
          agentId: number;
          date: string;
          statut: string;
          arrivee: string | null;
          depart: string | null;
        }[]
      >(
        `SELECT "agentId", to_char(date, 'YYYY-MM-DD') AS date, statut, arrivee, depart FROM presence
          WHERE "agentId" = ANY($1) AND date BETWEEN $2 AND $3`,
        [ids, debut, fin],
      ),
      this.presences.query<
        { id: number; nomComplet: string; structure: string }[]
      >(
        `SELECT a.id, a."nomComplet", s.nom AS structure FROM agent_recense a JOIN structure s ON s.id = a."structureId" WHERE a.id = ANY($1)`,
        [ids],
      ),
    ]);
    const h = new Map(horaires.map((x) => [x.agentId, x.jours]));
    const r = this.reglages();
    const coursDe = await this.coursParAgent(structures);
    const nom = new Map(noms.map((x) => [x.id, x]));
    const parAgent = new Map<number, Record<string, Pointage>>();
    for (const p of pts) {
      const m = parAgent.get(p.agentId) ?? {};
      m[p.date] = p;
      parAgent.set(p.agentId, m);
    }
    const res: {
      agentId: number;
      nomComplet: string;
      structureId: number;
      structure: string;
      lundi: string;
      alertes: { code: string; texte: string }[];
    }[] = [];
    for (const v of semaines)
      for (const a of (parStructure.get(v.structureId) ?? []).filter(
        (x) => x.enPoste,
      )) {
        const dates = JOURS.map((_, i) => plusJours(v.lundi, i));
        const avant = dates.map((d) => plusJours(d, -7));
        const tout = parAgent.get(a.id) ?? {};
        const b = bilanSemaine(
          horaireEffectif(h.get(a.id), coursDe.get(a.id), r).jours,
          dates,
          tout,
          { dates: avant, pointages: tout },
          r.toleranceArrivee,
        );
        if (b.alertes.length)
          res.push({
            agentId: a.id,
            nomComplet: a.nomComplet,
            structureId: v.structureId,
            structure: nom.get(a.id)?.structure ?? '',
            lundi: v.lundi,
            alertes: b.alertes,
          });
      }
    return res
      .sort(
        (x, y) =>
          y.lundi.localeCompare(x.lundi) || y.alertes.length - x.alertes.length,
      )
      .slice(0, 300);
  }

  /* ------------------------------ Évaluation ------------------------------ */

  /** Année évaluée (« 2026 ») : l'évaluation est annuelle, la DGRHAS en fixe la période. */
  annee(a?: string) {
    return a && /^\d{4}$/.test(a) ? a : anneeCivile();
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

  /**
   * Évaluation d'une année (une par agent et par année). Enregistrée, c'est un brouillon qui se
   * reprend ; validée (`valider`), elle est close et ne se modifie plus.
   */
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
      valider?: boolean;
    },
  ) {
    const a = await this.rec.trouver(u, agentId);
    const annee = this.annee(dto.annee);
    const existante = await this.evaluations.findOne({
      where: { agentId, annee },
    });
    if (existante?.valideeLe)
      throw new BadRequestException(
        `L’évaluation ${annee} est validée : elle n’est plus modifiable.`,
      );
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
    const date = dto.date && DATE.test(dto.date) ? dto.date : aujourdhui();
    const globale = (pro + social) / 2;
    const e = existante ?? this.evaluations.create({ agentId, annee });
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
      valideeLe: dto.valider ? new Date() : null,
      valideePar: dto.valider ? u.nom : null,
    });
    const r = await this.evaluations.save(e);
    await this.journal.log(
      u,
      dto.valider ? 'PERSONNEL_EVALUATION_VALIDEE' : 'PERSONNEL_EVALUATION',
      'agent_recense',
      agentId,
      { annee, professionnelle: pro, sociale: social, globale },
    );
    return this.presenter(r);
  }

  /**
   * Fiche d'évaluation à imprimer et à signer (DG, 24/10/2026) : l'agent, les deux notes avec ce
   * qui les justifie, la globale, la lecture et la décision proposée.
   */
  async ficheEvaluation(u: UtilisateurConnecte, agentId: number, id: string) {
    const a = await this.rec.trouver(u, agentId);
    const e = await this.evaluations.findOne({ where: { id, agentId } });
    if (!e) throw new NotFoundException('Évaluation introuvable');
    const c = this.rec.config.get();
    const structure = e.structureId
      ? ((
          await this.evaluations.query<{ nom: string }[]>(
            `SELECT nom FROM structure WHERE id = $1`,
            [e.structureId],
          )
        )[0]?.nom ?? null)
      : null;
    const d = a.donnees ?? {};
    const lib = (k: string) => {
      const ch = c.champs.find((x) => x.code === k);
      return ch ? valeurLisible(ch, d[k]) || null : null;
    };
    return {
      agent: {
        nomComplet: a.nomComplet,
        numeroFiche: a.numeroFiche,
        matricule: a.matricule,
        statut: c.statuts.find((x) => x.code === a.statut)?.libelle ?? a.statut,
        grade: lib('GRADE'),
        fonction: lib('FONCTION'),
        lieuService: structure ?? lib('LIEU_SERVICE'),
      },
      evaluation: this.presenter(e),
      lieu: this.params.get('LIEU_SIGNATURE'),
    };
  }

  async supprimerEvaluation(
    u: UtilisateurConnecte,
    agentId: number,
    id: string,
  ) {
    await this.rec.trouver(u, agentId);
    const e = await this.evaluations.findOne({ where: { id, agentId } });
    if (!e) throw new NotFoundException('Évaluation introuvable');
    if (e.valideeLe)
      throw new BadRequestException(
        `L’évaluation ${e.annee} est validée : elle ne se retire plus.`,
      );
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
      /** Une barre de la répartition : « Faible », « Bon »… (validées seulement). */
      appreciation?: string;
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
    const V = 'e."valideeLe" IS NOT NULL';
    const [stats] = await this.evaluations.query<
      {
        total: number;
        evalues: number;
        brouillons: number;
        moyennePro: number | null;
        moyenneSociale: number | null;
        tf: number;
        f: number;
        b: number;
        tb: number;
        ex: number;
        relations: number;
        metier: number;
        aSuivre: number;
      }[]
    >(
      // Seules les évaluations validées comptent ; les brouillons sont comptés à part
      `SELECT count(*)::int AS total, count(e."valideeLe")::int AS evalues,
              (count(e.id) - count(e."valideeLe"))::int AS brouillons,
              round((avg(e."competenceProfessionnelle") FILTER (WHERE ${V}))::numeric, 1)::float AS "moyennePro",
              round((avg(e."competenceSociale") FILTER (WHERE ${V}))::numeric, 1)::float AS "moyenneSociale",
              count(*) FILTER (WHERE ${V} AND ${APPRECIATION_SQL} = 'Très faible')::int AS tf,
              count(*) FILTER (WHERE ${V} AND ${APPRECIATION_SQL} = 'Faible')::int AS f,
              count(*) FILTER (WHERE ${V} AND ${APPRECIATION_SQL} = 'Bon')::int AS b,
              count(*) FILTER (WHERE ${V} AND ${APPRECIATION_SQL} = 'Très bon')::int AS tb,
              count(*) FILTER (WHERE ${V} AND ${APPRECIATION_SQL} = 'Excellent')::int AS ex,
              count(*) FILTER (WHERE ${V} AND e."competenceProfessionnelle" >= ${MOYENNE} AND e."competenceSociale" < ${MOYENNE})::int AS relations,
              count(*) FILTER (WHERE ${V} AND e."competenceProfessionnelle" < ${MOYENNE} AND e."competenceSociale" >= ${MOYENNE})::int AS metier,
              count(*) FILTER (WHERE ${V} AND e.globale < ${MOYENNE})::int AS "aSuivre"
         ${base}`,
      params,
    );
    const filtreEtat =
      (f.etat === 'NON_EVALUE'
        ? ' AND e.id IS NULL'
        : f.etat === 'BROUILLON'
          ? ` AND e.id IS NOT NULL AND NOT (${V})`
          : f.etat === 'EVALUE'
            ? ` AND ${V}`
            : f.etat === 'A_SUIVRE'
              ? ` AND ${V} AND e.globale < ${MOYENNE}`
              : '') +
      // Barre de la répartition cliquée : les agents de cette appréciation (valeur connue seulement)
      (APPRECIATIONS.includes(f.appreciation ?? '') && f.appreciation
        ? ` AND ${V} AND ${APPRECIATION_SQL} = '${f.appreciation.replace(/'/g, "''")}'`
        : '');
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
        valideeLe: Date | null;
        valideePar: string | null;
      }[]
    >(
      `SELECT a.id, a."nomComplet", a.statut, a.donnees->>'FONCTION' AS fonction, s.nom AS structure,
              e.id AS "evaluationId", e."competenceProfessionnelle", e."competenceSociale", e.globale, e.appreciation, e.decision, e.evaluateur,
              to_char(e.date, 'YYYY-MM-DD') AS date, e."commentaireProfessionnel", e."commentaireSocial", e."valideeLe", e."valideePar"
         ${base}${filtreEtat} ORDER BY e.globale ASC NULLS FIRST, a."nomComplet" LIMIT 50 OFFSET ${(page - 1) * 50}`,
      params,
    );
    return { annee, stats, page, lignes, decisions: DECISIONS };
  }
}
