import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { nomEcole, sansTypeEcole } from '../common/nom-ecole';
import { normaliser } from '../common/texte';
import { JournalService } from '../core/core.service';

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
      const k = `${s.departementId}|${s.cycle}|${cle(sansTypeEcole(s.nom))}`;
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
}
