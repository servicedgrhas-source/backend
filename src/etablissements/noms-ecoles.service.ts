import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { nomEcole, sansTypeEcole } from '../common/nom-ecole';
import { normaliser } from '../common/texte';
import { JournalService } from '../core/core.service';
import { cleEcole } from '../nominations/placement';

interface Ecole {
  id: number;
  nom: string;
  sigle: string | null;
  cycle: string | null;
  departementId: number | null;
  departement: string | null;
  localite: string | null;
  parentId: number | null;
  inspection: string | null;
  anciensNoms: string[] | null;
  agents: number;
}

/**
 * Clé d'un nom d'école pour trouver les doublons (21/11/2026) : sans le type, chiffres romains en
 * chiffres et lettre de groupe détachée (« II-B » = « 2B » = « 2 B »), lettres doublées réduites
 * (« KINSSOUNDI » = « KINSOUNDI »), l'ordre des mots sans importance (« JOSEPH NKEOUA »).
 */
export const cleDoublon = (nom: string) =>
  cleEcole(normaliser(sansTypeEcole(nom)).replace(/(\d)([A-D])\b/g, '$1 $2'))
    .split(' ')
    .filter(Boolean)
    // Lettres doublées réduites après les chiffres romains (« II » est déjà devenu « 2 »)
    .map((m) => m.replace(/([A-Z])\1+/g, '$1'))
    .sort()
    .join(' ');

const cle = (s: string) =>
  normaliser(s)
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();

/**
 * Noms des écoles (DG, 21/11/2026) : mettre toutes les écoles déjà enregistrées au nom normé
 * (préfixe du cycle + nom propre), en gardant l'ancien nom reconnu ; montrer les écoles en double
 * une fois le type retiré, et celles sans cycle.
 */
@Injectable()
export class NomsEcolesService {
  constructor(
    private readonly ds: DataSource,
    private readonly journal: JournalService,
  ) {}

  private ecoles(): Promise<Ecole[]> {
    return this.ds.query(
      `SELECT s.id, s.nom, s.sigle, s.cycle, s."departementId", d.nom AS departement, s.localite, s."parentId", p.nom AS inspection, s."anciensNoms",
              (SELECT count(*)::int FROM agent_recense a WHERE a."structureId" = s.id) AS agents
         FROM structure s LEFT JOIN departement d ON d.id = s."departementId"
                    LEFT JOIN structure p ON p.id = s."parentId"
        WHERE s.type = 'ETABLISSEMENT' AND s.actif
        ORDER BY d.nom NULLS LAST, s.nom`,
    );
  }

  async analyse() {
    const ecoles = await this.ecoles();
    const changements = ecoles
      .map((s) => ({
        id: s.id,
        avant: s.nom,
        apres: nomEcole(s.cycle, s.nom),
        cycle: s.cycle,
        departement: s.departement,
        localite: s.localite,
      }))
      .filter((x) => x.cycle && x.apres !== x.avant);
    // Doublon : même nom, même cycle, au même endroit (DG, 21/11/2026). Le même nom à Pointe-Noire et
    // dans la Cuvette, ou dans deux localités d'un département, ce sont deux écoles.
    const groupes = new Map<string, Ecole[]>();
    for (const s of ecoles) {
      if (!s.cycle) continue;
      // L'ordre des mots ne compte pas (« CA JOSEPH NKEOUA » = « CA NKEOUA JOSEPH », 21/11/2026)
      const mots = cleDoublon(s.nom);
      const k = `${s.departementId}|${s.cycle}|${mots}`;
      groupes.set(k, [...(groupes.get(k) ?? []), s]);
    }
    // Au même endroit : même localité ; sans localité écrite, même inspection
    const memeEndroit = (a: Ecole, b: Ecole) =>
      a.localite && b.localite
        ? cle(a.localite) === cle(b.localite)
        : a.parentId !== null && a.parentId === b.parentId;
    const parEndroit: Ecole[][] = [];
    for (const g of groupes.values()) {
      if (g.length < 2) continue;
      const vus = new Set<number>();
      for (const a of g) {
        if (vus.has(a.id)) continue;
        const l = g.filter(
          (b) => b === a || (!vus.has(b.id) && memeEndroit(a, b)),
        );
        l.forEach((b) => vus.add(b.id));
        if (l.length > 1) parEndroit.push(l);
      }
    }
    const doublons = parEndroit.map((g) => ({
      nom: nomEcole(g[0].cycle, g[0].nom),
      departement: g[0].departement,
      ecoles: g.map((s) => ({
        id: s.id,
        nom: s.nom,
        localite:
          [s.localite, s.inspection].filter(Boolean).join(' · ') || null,
        agents: s.agents,
      })),
    }));
    const sansCycle = ecoles
      .filter((s) => !s.cycle)
      .map((s) => ({
        id: s.id,
        nom: s.nom,
        departement: s.departement,
        localite: s.localite,
      }));
    return {
      ecoles: ecoles.length,
      changements,
      doublons,
      sansCycle,
    };
  }

  /** Donne le nom normé à toutes les écoles qui ne l'ont pas encore ; l'ancien nom reste reconnu. */
  async appliquer(u: UtilisateurConnecte) {
    const ecoles = await this.ecoles();
    const lots = ecoles
      .map((s) => ({ s, apres: nomEcole(s.cycle, s.nom) }))
      .filter(({ s, apres }) => s.cycle && apres !== s.nom);
    await this.ds.transaction(async (m) => {
      for (let i = 0; i < lots.length; i += 500) {
        const l = lots.slice(i, i + 500);
        await m.query(
          `UPDATE structure s
              SET nom = v.apres,
                  sigle = CASE WHEN s.sigle IS NULL OR s.sigle = s.nom THEN left(v.apres, 80) ELSE s.sigle END,
                  "anciensNoms" = CASE WHEN coalesce(s."anciensNoms", '[]'::jsonb) ? s.nom
                                       THEN coalesce(s."anciensNoms", '[]'::jsonb)
                                       ELSE coalesce(s."anciensNoms", '[]'::jsonb) || to_jsonb(s.nom) END
             FROM unnest($1::int[], $2::text[], $3::text[]) AS v(id, avant, apres)
            WHERE s.id = v.id AND s.nom = v.avant`,
          [l.map((x) => x.s.id), l.map((x) => x.s.nom), l.map((x) => x.apres)],
        );
      }
    });
    await this.journal.log(u, 'NOMS_ECOLES', 'structure', null, {
      renommees: lots.length,
      exemples: lots
        .slice(0, 20)
        .map((x) => ({ avant: x.s.nom, apres: x.apres })),
    });
    return { renommees: lots.length };
  }

  /**
   * Fusionner deux écoles enregistrées deux fois (DG, 21/11/2026) : on garde « garder », tout ce qui
   * pointait vers « fermer » passe à « garder » (agents, classes, salles, bâtiments, présence,
   * emplois du temps, besoins, comptes, demandes…), puis « fermer » est fermée ; son nom reste
   * reconnu (anciens noms). Ce qui existe déjà des deux côtés (même semaine de présence, même année
   * d'emploi du temps, même poste du cadre organique) reste à l'école fermée et est compté.
   */
  async fusionner(u: UtilisateurConnecte, garderId: number, fermerId: number) {
    if (!garderId || !fermerId || garderId === fermerId)
      throw new BadRequestException('Choisissez deux écoles différentes.');
    const [g, f] = await Promise.all(
      [garderId, fermerId].map(async (id) => {
        const [s] = await this.ds.query<
          {
            id: number;
            nom: string;
            type: string;
            cycle: string | null;
            departementId: number | null;
            actif: boolean;
            responsableId: number | null;
            anciensNoms: string[] | null;
          }[]
        >(
          `SELECT id, nom, type, cycle, "departementId", actif, "responsableId", "anciensNoms" FROM structure WHERE id = $1`,
          [id],
        );
        return s;
      }),
    );
    if (!g || !f) throw new BadRequestException('École introuvable.');
    if (g.type !== 'ETABLISSEMENT' || f.type !== 'ETABLISSEMENT')
      throw new BadRequestException('Seules deux écoles se fusionnent.');
    if (!g.actif || !f.actif)
      throw new BadRequestException('L’une des deux écoles est déjà fermée.');
    if (g.cycle !== f.cycle || g.departementId !== f.departementId)
      throw new BadRequestException(
        'Les deux écoles n’ont pas le même cycle ou le même département : ce ne sont pas des doublons.',
      );
    const res: Record<string, number> = {};
    await this.ds.transaction(async (m) => {
      const deplacer = async (table: string, colonne: string, cle?: string) => {
        const sql = cle
          ? `UPDATE ${table} t SET "${colonne}" = $1 WHERE t."${colonne}" = $2
               AND NOT EXISTS (SELECT 1 FROM ${table} x WHERE x."${colonne}" = $1 AND x.${cle} = t.${cle})`
          : `UPDATE ${table} SET "${colonne}" = $1 WHERE "${colonne}" = $2`;
        const r = await m.query<[unknown[], number]>(sql, [g.id, f.id]);
        const n = Array.isArray(r) ? Number(r[1] ?? 0) : 0;
        if (n) res[table] = (res[table] ?? 0) + n;
      };
      // Les tables qui citent une structure (relevé du 21/11/2026)
      for (const t of [
        'agent_recense',
        'batiment',
        'salle',
        'classe',
        'besoin_personnel',
        'evaluation_agent',
        'horaire_agent',
        'presence',
        'utilisateur',
      ])
        await deplacer(t, 'structureId');
      await deplacer('demande_mutation', 'structureOrigineId');
      await deplacer('structure', 'parentId');
      // Une seule ligne par école : on ne déplace que ce que l'école gardée n'a pas déjà
      await deplacer('semaine_presence', 'structureId', 'lundi');
      await deplacer('emploi_du_temps', 'structureId', '"anneeScolaire"');
      await deplacer('cadre_organique', 'structureId', 'poste');
      const restes = await m.query<{ n: number }[]>(
        `SELECT (SELECT count(*) FROM semaine_presence WHERE "structureId" = $1)
              + (SELECT count(*) FROM emploi_du_temps WHERE "structureId" = $1)
              + (SELECT count(*) FROM cadre_organique WHERE "structureId" = $1) AS n`,
        [f.id],
      );
      const anciens = [
        ...new Set([...(g.anciensNoms ?? []), f.nom, ...(f.anciensNoms ?? [])]),
      ].filter((x) => x && x !== g.nom);
      await m.query(
        `UPDATE structure SET "anciensNoms" = $2::jsonb,
                "responsableId" = coalesce("responsableId", $3)
          WHERE id = $1`,
        [g.id, JSON.stringify(anciens), f.responsableId],
      );
      await m.query(
        `UPDATE structure SET actif = false, "responsableId" = NULL WHERE id = $1`,
        [f.id],
      );
      res.restes = Number(restes[0]?.n ?? 0);
    });
    await this.journal.log(u, 'ECOLES_FUSION', 'structure', String(g.id), {
      gardee: { id: g.id, nom: g.nom },
      fermee: { id: f.id, nom: f.nom },
      ...res,
    });
    return {
      gardee: g.nom,
      fermee: f.nom,
      agents: res.agent_recense ?? 0,
      deplaces: res,
      restes: res.restes ?? 0,
    };
  }
}
