import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { normaliser } from '../common/texte';
import { JournalService } from '../core/core.service';
import { rapprocherLieux, type StructureSansEcole } from './sans-ecole';

interface FicheLieu {
  id: number;
  statut: string;
  departementId: number | null;
  lieu: string;
  cycle: string | null;
}

interface FicheRattachee {
  id: number;
  structureId: number;
  departementId: number | null;
  lieu: string;
}

const cleLieu = (dep: number | null, lieu: string, cycle: string | null) =>
  `${dep ?? ''}|${normaliser(lieu)
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()}|${cycle ?? ''}`;

/**
 * Agents sans école (DG, 21/11/2026) : les fiches dont le lieu de service est écrit mais qui ne
 * sont rattachées à aucune structure (aucune page d'école ne les compte), et les fiches rattachées
 * dont le lieu écrit dit autre chose que leur école.
 */
@Injectable()
export class SansEcoleService {
  constructor(
    private readonly ds: DataSource,
    private readonly journal: JournalService,
  ) {}

  private async structures(): Promise<StructureSansEcole[]> {
    return this.ds.query(
      `SELECT id, type, nom, coalesce(sigle, nom) AS sigle, cycle, "departementId", "anciensNoms", localite
         FROM structure WHERE actif`,
    );
  }

  private async donnees() {
    const [structures, sans, avec, deps] = await Promise.all([
      this.structures(),
      this.ds.query<FicheLieu[]>(
        `SELECT id, statut, "departementId", trim(donnees->>'LIEU_SERVICE') AS lieu, donnees->>'CYCLE' AS cycle
           FROM agent_recense
          WHERE "structureId" IS NULL AND coalesce(contentieux->>'etat', 'CONFIRME') = 'CONFIRME' AND retrait IS NULL
            AND coalesce(trim(donnees->>'LIEU_SERVICE'), '') <> ''`,
      ),
      this.ds.query<FicheRattachee[]>(
        `SELECT id, "structureId", "departementId", trim(donnees->>'LIEU_SERVICE') AS lieu
           FROM agent_recense
          WHERE "structureId" IS NOT NULL AND coalesce(contentieux->>'etat', 'CONFIRME') = 'CONFIRME' AND retrait IS NULL
            AND coalesce(trim(donnees->>'LIEU_SERVICE'), '') <> ''`,
      ),
      this.ds.query<{ id: number; nom: string }[]>(
        `SELECT id, nom FROM departement`,
      ),
    ]);
    return { structures, sans, avec, deps };
  }

  /** Les lieux écrits des fiches sans école, regroupés, avec l'école proposée. */
  private groupes(sans: FicheLieu[], structures: StructureSansEcole[]) {
    const groupes = new Map<
      string,
      {
        cle: string;
        lieu: string;
        departementId: number | null;
        cycle: string | null;
        ids: number[];
        statuts: Record<string, number>;
      }
    >();
    for (const f of sans) {
      const cle = cleLieu(f.departementId, f.lieu, f.cycle);
      const g = groupes.get(cle) ?? {
        cle,
        lieu: f.lieu,
        departementId: f.departementId,
        cycle: f.cycle,
        ids: [],
        statuts: {},
      };
      g.ids.push(f.id);
      g.statuts[f.statut] = (g.statuts[f.statut] ?? 0) + 1;
      groupes.set(cle, g);
    }
    const props = rapprocherLieux(
      [...groupes.values()].map((g) => ({
        cle: g.cle,
        texte: g.lieu,
        departementId: g.departementId,
        cycleFiche: g.cycle,
      })),
      structures,
    );
    return { groupes, props };
  }

  /** Les fiches rattachées dont le lieu écrit ne dit pas leur école, regroupées. */
  private ecarts(avec: FicheRattachee[], structures: StructureSansEcole[]) {
    const parId = new Map(structures.map((s) => [s.id, s]));
    const ecarts = new Map<
      string,
      { cle: string; lieu: string; structureId: number; ids: number[] }
    >();
    const lieuxAVerifier: {
      cle: string;
      texte: string;
      departementId: number | null;
      cycleFiche: string | null;
    }[] = [];
    for (const f of avec) {
      const s = parId.get(f.structureId);
      if (!s) continue;
      const noms = [s.nom, s.sigle, ...(s.anciensNoms ?? [])]
        .filter(Boolean)
        .map((x) => normaliser(x).replace(/[^A-Z0-9]+/g, ''));
      if (noms.includes(normaliser(f.lieu).replace(/[^A-Z0-9]+/g, '')))
        continue;
      const cle = `${f.structureId}|${normaliser(f.lieu)
        .replace(/[^A-Z0-9]+/g, ' ')
        .trim()}`;
      const e = ecarts.get(cle) ?? {
        cle,
        lieu: f.lieu,
        structureId: f.structureId,
        ids: [],
      };
      if (!e.ids.length)
        lieuxAVerifier.push({
          cle,
          texte: f.lieu,
          departementId: s.departementId,
          cycleFiche: s.cycle,
        });
      e.ids.push(f.id);
      ecarts.set(cle, e);
    }
    // Le lieu écrit désigne-t-il la même école (écrite autrement) ou une autre ?
    const props = rapprocherLieux(lieuxAVerifier, structures);
    for (const [cle, e] of ecarts) {
      const p = props.get(cle);
      if (p?.structureId === e.structureId) ecarts.delete(cle);
    }
    return { ecarts, props };
  }

  async analyse() {
    const { structures, sans, avec, deps } = await this.donnees();
    const parId = new Map(structures.map((s) => [s.id, s]));
    const nomDep = new Map(deps.map((d) => [d.id, d.nom]));
    const inspection = (s?: StructureSansEcole) => s?.localite ?? null;
    const resume = (id: number | null | undefined) => {
      const s = id ? parId.get(id) : undefined;
      return s
        ? {
            id: s.id,
            nom: s.nom,
            type: s.type,
            cycle: s.cycle,
            localite: inspection(s),
          }
        : null;
    };
    const { groupes, props } = this.groupes(sans, structures);
    const lieux = [...groupes.values()]
      .map((g) => {
        const p = props.get(g.cle)!;
        return {
          cle: g.cle,
          lieu: g.lieu,
          departementId: g.departementId,
          departement: g.departementId
            ? (nomDep.get(g.departementId) ?? null)
            : null,
          cycle: g.cycle,
          fiches: g.ids.length,
          statuts: g.statuts,
          etat: p.etat,
          ressemblance: p.ressemblance,
          proposee: resume(p.structureId),
          autres: p.autres.map(resume).filter(Boolean),
          cochee: p.etat === 'SUR',
        };
      })
      .sort(
        (a, b) => b.fiches - a.fiches || a.lieu.localeCompare(b.lieu, 'fr'),
      );
    const { ecarts, props: pe } = this.ecarts(avec, structures);
    const listeEcarts = [...ecarts.values()]
      .map((e) => {
        const s = parId.get(e.structureId);
        const p = pe.get(e.cle);
        return {
          cle: e.cle,
          lieu: e.lieu,
          fiches: e.ids.length,
          departement: s?.departementId
            ? (nomDep.get(s.departementId) ?? null)
            : null,
          rattachee: resume(e.structureId),
          // Le lieu écrit désigne sûrement une autre structure : à vérifier fiche par fiche
          autre: p?.etat === 'SUR' ? resume(p.structureId) : null,
        };
      })
      .sort((a, b) => b.fiches - a.fiches);
    const somme = (l: { fiches: number }[]) =>
      l.reduce((n, x) => n + x.fiches, 0);
    const [{ n: sansLieu }] = await this.ds.query<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM agent_recense
        WHERE "structureId" IS NULL AND coalesce(contentieux->>'etat', 'CONFIRME') = 'CONFIRME' AND retrait IS NULL
          AND coalesce(trim(donnees->>'LIEU_SERVICE'), '') = ''`,
    );
    return {
      compteurs: {
        sansEcole: sans.length,
        sansLieu,
        sur: somme(lieux.filter((l) => l.etat === 'SUR')),
        probable: somme(lieux.filter((l) => l.etat === 'PROBABLE')),
        introuvable: somme(lieux.filter((l) => l.etat === 'INTROUVABLE')),
        ecarts: somme(listeEcarts),
      },
      lieux,
      ecarts: listeEcarts,
    };
  }

  /**
   * Rattache les fiches des lieux choisis à leur école ; pour un écart, écrit le nom de l'école de
   * rattachement dans le lieu de service. Seules les fiches encore dans le même cas changent.
   */
  async appliquer(
    u: UtilisateurConnecte,
    choix: {
      rattacher: { cle: string; structureId: number }[];
      aligner: string[];
    },
  ) {
    const { structures, sans, avec } = await this.donnees();
    const parId = new Map(structures.map((s) => [s.id, s]));
    const { groupes } = this.groupes(sans, structures);
    const res = { rattachees: 0, alignees: 0, refus: [] as string[] };
    const traces: { lieu: string; structureId: number; fiches: number }[] = [];
    await this.ds.transaction(async (m) => {
      for (const c of choix.rattacher) {
        const g = groupes.get(c.cle);
        const s = parId.get(c.structureId);
        if (!g) {
          res.refus.push(`${c.cle} : plus de fiche sans école pour ce lieu.`);
          continue;
        }
        if (!s) {
          res.refus.push(`« ${g.lieu} » : structure introuvable ou fermée.`);
          continue;
        }
        if (
          g.departementId &&
          s.departementId &&
          s.departementId !== g.departementId
        ) {
          res.refus.push(
            `« ${g.lieu} » : choisissez une structure de son département.`,
          );
          continue;
        }
        const r = await m.query<unknown[]>(
          `UPDATE agent_recense
              SET "structureId" = $2,
                  "departementId" = coalesce("departementId", $3),
                  liaison = coalesce(liaison, '{}'::jsonb) || jsonb_build_object('rattachementLieu', $4::text)
            WHERE id = ANY($1) AND "structureId" IS NULL
            RETURNING id`,
          [
            g.ids,
            s.id,
            s.departementId,
            `${u.nom} ${new Date().toISOString().slice(0, 10)}`,
          ],
        );
        const n = Array.isArray(r[0]) ? (r[0] as unknown[]).length : r.length;
        res.rattachees += n;
        traces.push({ lieu: g.lieu, structureId: s.id, fiches: n });
      }
      if (choix.aligner.length) {
        const { ecarts } = this.ecarts(avec, structures);
        for (const cle of choix.aligner) {
          const e = ecarts.get(cle);
          const s = e ? parId.get(e.structureId) : undefined;
          if (!e || !s) continue;
          const r = await m.query<unknown[]>(
            `UPDATE agent_recense SET donnees = jsonb_set(donnees, '{LIEU_SERVICE}', to_jsonb($3::text))
              WHERE id = ANY($1) AND "structureId" = $2 RETURNING id`,
            [e.ids, e.structureId, s.nom],
          );
          res.alignees += Array.isArray(r[0])
            ? (r[0] as unknown[]).length
            : r.length;
        }
      }
    });
    if (!res.rattachees && !res.alignees && res.refus.length)
      throw new BadRequestException(res.refus.slice(0, 3).join(' '));
    await this.journal.log(u, 'AGENTS_SANS_ECOLE', 'agent_recense', null, {
      ...res,
      lieux: traces,
    });
    return res;
  }
}
