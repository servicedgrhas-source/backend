import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { JournalService } from '../core/core.service';

/**
 * Base des retraits (DG, 23/11/2026 : « les retraits ne doivent plus apparaître parmi les
 * effectifs… ils auront leur base, on peut la consulter ; on ne les supprime pas, il y a encore des
 * contrôles à faire »).
 *
 * Volontaires et communautaires qui ne sont pas payés en bourse : sortis du registre (retirés par
 * la DDEPPSA, doublons), en double d'un boursier qui a déjà sa fiche, ou absents du registre. La
 * fiche n'est ni supprimée ni déplacée : elle est marquée (`retrait`), garde son numéro, son
 * historique et ses liens (nominations, rapports), et ne compte plus dans les effectifs, les listes
 * ni les statistiques. Réintégrer efface la marque.
 *
 * Gardés dans la base (comptés), même non payés en bourse, parce qu'un signe dit qu'ils sont réels :
 * une nomination, un matricule solde, ou un passage par le contrôle du recensement.
 */
export const MOTIFS_RETRAIT: Record<string, string> = {
  RETIRE_DDEPPSA: 'Sorti de la bourse : retiré par la DDEPPSA',
  DOUBLON_REGISTRE: 'Sorti de la bourse : en double dans le registre',
  SORTI_AUTRE: 'Sorti de la bourse (autre motif)',
  DOUBLON_BOURSIER: 'En double d’un boursier qui a déjà sa fiche',
  ABSENT_REGISTRE: 'Absent du registre de la bourse (pas payé en bourse)',
};

/** Le motif de chaque fiche candidate (volontaire ou communautaire non payé en bourse). */
const CANDIDATS = `
  SELECT a.id,
         CASE
           WHEN v.id IS NOT NULL AND v."motifSortie" = 'RETIRE_DDEPPSA' THEN 'RETIRE_DDEPPSA'
           WHEN v.id IS NOT NULL AND v."motifSortie" = 'DOUBLON' THEN 'DOUBLON_REGISTRE'
           WHEN v.id IS NOT NULL THEN 'SORTI_AUTRE'
           WHEN EXISTS (SELECT 1 FROM volontaire r
                         WHERE r."nomNormalise" = a."nomNormalise"
                           AND EXISTS (SELECT 1 FROM agent_recense x WHERE x."volontaireId" = r.id AND x.id <> a.id))
             THEN 'DOUBLON_BOURSIER'
           ELSE 'ABSENT_REGISTRE'
         END AS motif,
         EXISTS (SELECT 1 FROM nomination n WHERE n."agentId" = a.id) AS nomination,
         coalesce(nullif(trim(a.matricule), ''), nullif(trim(a.donnees->>'MATRICULE_SOLDE'), '')) IS NOT NULL AS matricule,
         a.contentieux IS NOT NULL AS recensement
    FROM agent_recense a
    LEFT JOIN volontaire v ON v.id = a."volontaireId"
   WHERE a.statut IN ('VOLONTAIRE', 'COMMUNAUTAIRE')
     AND a.retrait IS NULL
     AND (a."volontaireId" IS NULL OR v.statut = 'SORTI')`;

@Injectable()
export class RetraitsService {
  constructor(
    private readonly ds: DataSource,
    private readonly journal: JournalService,
  ) {}

  /** Ce qui partirait dans la base des retraits, groupe par groupe, et ce qui reste gardé. */
  async apercu() {
    const lignes = await this.ds.query<
      {
        motif: string;
        garde: boolean;
        nomination: number;
        matricule: number;
        recensement: number;
        n: number;
      }[]
    >(
      `SELECT motif, (nomination OR matricule OR recensement) AS garde,
              count(*) FILTER (WHERE nomination)::int AS nomination,
              count(*) FILTER (WHERE matricule)::int AS matricule,
              count(*) FILTER (WHERE recensement)::int AS recensement,
              count(*)::int AS n
         FROM (${CANDIDATS}) c GROUP BY 1, 2`,
    );
    const groupes = Object.entries(MOTIFS_RETRAIT)
      .map(([code, libelle]) => ({
        code,
        libelle,
        aRetirer: lignes
          .filter((l) => l.motif === code && !l.garde)
          .reduce((s, l) => s + l.n, 0),
        gardes: lignes
          .filter((l) => l.motif === code && l.garde)
          .reduce((s, l) => s + l.n, 0),
      }))
      .filter((g) => g.aRetirer || g.gardes);
    const gardes = lignes.filter((l) => l.garde);
    const [{ deja }] = await this.ds.query<{ deja: number }[]>(
      `SELECT count(*)::int AS deja FROM agent_recense WHERE retrait IS NOT NULL`,
    );
    return {
      groupes,
      aRetirer: groupes.reduce((s, g) => s + g.aRetirer, 0),
      gardes: {
        total: gardes.reduce((s, l) => s + l.n, 0),
        nomination: gardes.reduce((s, l) => s + l.nomination, 0),
        matricule: gardes.reduce((s, l) => s + l.matricule, 0),
        recensement: gardes.reduce((s, l) => s + l.recensement, 0),
      },
      dejaRetires: deja,
    };
  }

  /** Mettre en retrait les groupes choisis (fiches non gardées). */
  async appliquer(u: UtilisateurConnecte, motifs: string[]) {
    const choisis = motifs.filter((m) => m in MOTIFS_RETRAIT);
    if (!choisis.length)
      throw new BadRequestException('Choisissez au moins un groupe à retirer.');
    const r = await this.ds.query<unknown[]>(
      `UPDATE agent_recense a
          SET retrait = jsonb_build_object('motif', c.motif, 'le', now(), 'par', $2::text)
         FROM (${CANDIDATS}) c
        WHERE a.id = c.id AND c.motif = ANY($1)
          AND NOT (c.nomination OR c.matricule OR c.recensement)
        RETURNING a.id`,
      [choisis, u.nom],
    );
    const n = Array.isArray(r[0]) ? (r[0] as unknown[]).length : r.length;
    await this.journal.log(u, 'PERSONNEL_RETRAITS', 'agent_recense', null, {
      groupes: choisis,
      fiches: n,
    });
    return { retires: n };
  }

  /** La base des retraits : par groupe, avec recherche (100 par page). */
  async liste(f: {
    motif?: string;
    statut?: string;
    recherche?: string;
    page?: number;
  }) {
    const conds = ['a.retrait IS NOT NULL'];
    const params: unknown[] = [];
    if (f.motif && f.motif in MOTIFS_RETRAIT) {
      params.push(f.motif);
      conds.push(`a.retrait->>'motif' = $${params.length}`);
    }
    if (f.statut === 'VOLONTAIRE' || f.statut === 'COMMUNAUTAIRE') {
      params.push(f.statut);
      conds.push(`a.statut = $${params.length}`);
    }
    if (f.recherche?.trim()) {
      params.push(`%${f.recherche.trim().toUpperCase()}%`);
      conds.push(
        `(a."nomNormalise" LIKE $${params.length} OR a.matricule ILIKE $${params.length})`,
      );
    }
    const page = Math.max(1, Number(f.page) || 1);
    const where = conds.join(' AND ');
    const [lignes, [{ total }], compte] = await Promise.all([
      this.ds.query<unknown[]>(
        `SELECT a.id, a."nomComplet" AS nom, a.statut, to_char(a."dateNaissance", 'YYYY-MM-DD') AS naissance,
                a.retrait->>'motif' AS motif, a.retrait->>'le' AS le, a.retrait->>'par' AS par,
                d.nom AS departement, coalesce(s.nom, nullif(trim(a.donnees->>'LIEU_SERVICE'), '')) AS lieu
           FROM agent_recense a
           LEFT JOIN departement d ON d.id = a."departementId"
           LEFT JOIN structure s ON s.id = a."structureId"
          WHERE ${where}
          ORDER BY a."nomComplet" LIMIT 100 OFFSET ${(page - 1) * 100}`,
        params,
      ),
      this.ds.query<{ total: number }[]>(
        `SELECT count(*)::int AS total FROM agent_recense a WHERE ${where}`,
        params,
      ),
      this.ds.query<{ motif: string; statut: string; n: number }[]>(
        `SELECT retrait->>'motif' AS motif, statut, count(*)::int AS n FROM agent_recense
          WHERE retrait IS NOT NULL GROUP BY 1, 2`,
      ),
    ]);
    return {
      total,
      page,
      lignes: (lignes as Record<string, unknown>[]).map((l) => ({
        ...l,
        motifLibelle: MOTIFS_RETRAIT[String(l.motif)] ?? String(l.motif),
      })),
      parMotif: Object.entries(MOTIFS_RETRAIT)
        .map(([code, libelle]) => ({
          code,
          libelle,
          n: compte
            .filter((c) => c.motif === code)
            .reduce((s, c) => s + c.n, 0),
        }))
        .filter((x) => x.n),
      parStatut: ['VOLONTAIRE', 'COMMUNAUTAIRE'].map((s) => ({
        statut: s,
        n: compte.filter((c) => c.statut === s).reduce((t, c) => t + c.n, 0),
      })),
      totalRetraits: compte.reduce((s, c) => s + c.n, 0),
    };
  }

  /** Réintégrer des fiches : elles reviennent dans la base et les effectifs. */
  async reintegrer(u: UtilisateurConnecte, ids: number[]) {
    const liste = ids.filter((x) => Number.isInteger(x)).slice(0, 20000);
    if (!liste.length)
      throw new BadRequestException('Cochez au moins une fiche à réintégrer.');
    const r = await this.ds.query<unknown[]>(
      `UPDATE agent_recense SET retrait = NULL WHERE id = ANY($1) AND retrait IS NOT NULL RETURNING id`,
      [liste],
    );
    const n = Array.isArray(r[0]) ? (r[0] as unknown[]).length : r.length;
    await this.journal.log(
      u,
      'PERSONNEL_REINTEGRATION',
      'agent_recense',
      null,
      {
        fiches: n,
      },
    );
    return { reintegres: n };
  }
}
