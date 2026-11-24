import { BadRequestException, Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
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

/** L'analyse gardée 2 minutes (voir calcul()). */
let memoireAnalyse: { le: number; calcul: Promise<unknown> } | null = null;

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
    // (la page ouverte : toujours le calcul du moment)
    memoireAnalyse = null;
    const { lieux, ecarts, compteurs } = await this.calcul();
    return {
      compteurs,
      lieux: lieux.map(({ ids: _i, ...l }) => (void _i, l)),
      ecarts: ecarts.map(({ ids: _i, ...e }) => (void _i, e)),
    };
  }

  /**
   * L'analyse, avec les fiches de chaque groupe (gardées côté serveur). Longue (plusieurs secondes) :
   * gardée 2 minutes, pour qu'un clic sur un groupe ou l'Excel répondent tout de suite ; refaite
   * après chaque enregistrement.
   */
  private calcul() {
    // (gardée hors de l'instance : le service peut être recréé à chaque demande)
    if (!memoireAnalyse || Date.now() - memoireAnalyse.le > 120_000)
      memoireAnalyse = { le: Date.now(), calcul: this.calculer() };
    const m = memoireAnalyse;
    // (un calcul qui échoue n'est pas gardé)
    m.calcul.catch(() => {
      if (memoireAnalyse === m) memoireAnalyse = null;
    });
    return m.calcul as ReturnType<SansEcoleService['calculer']>;
  }

  private async calculer() {
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
          ids: g.ids,
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
          ids: e.ids,
          departementId: s?.departementId ?? null,
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

  /** Les fiches d'un groupe (un lieu écrit, ou un écart lieu écrit ≠ école) : exactement celles-là. */
  async fichesDe(sorte: string, cle: string) {
    const { lieux, ecarts } = await this.calcul();
    const g =
      sorte === 'ecart'
        ? ecarts.find((e) => e.cle === cle)
        : lieux.find((l) => l.cle === cle);
    if (!g)
      throw new BadRequestException(
        'Ce groupe n’existe plus (déjà rattaché ou corrigé) : rechargez la page.',
      );
    return this.details(g.ids);
  }

  /** Ce qu'une DDEPPSA a besoin de voir pour reconnaître chaque personne. */
  private async details(ids: number[]) {
    if (!ids.length) return [];
    return this.ds.query<
      {
        id: number;
        nom: string;
        statut: string;
        naissance: string | null;
        matricule: string | null;
        telephone: string | null;
        lieu: string | null;
        inspection: string | null;
        cycle: string | null;
        ecole: string | null;
      }[]
    >(
      `SELECT a.id, a."nomComplet" AS nom, a.statut, to_char(a."dateNaissance", 'DD/MM/YYYY') AS naissance,
              coalesce(nullif(trim(a.matricule), ''), nullif(trim(a.donnees->>'MATRICULE_SOLDE'), '')) AS matricule,
              nullif(trim(coalesce(a.donnees->>'TELEPHONE_1', a.telephone, '')), '') AS telephone,
              trim(a.donnees->>'LIEU_SERVICE') AS lieu, nullif(trim(a.donnees->>'INSPECTION'), '') AS inspection,
              a.donnees->>'CYCLE' AS cycle, s.nom AS ecole
         FROM agent_recense a LEFT JOIN structure s ON s.id = a."structureId"
        WHERE a.id = ANY($1) ORDER BY a."nomComplet"`,
      [ids],
    );
  }

  /**
   * L'Excel à envoyer aux DDEPPSA (DG, 23/11/2026 : « générer la liste, l'envoyer au chef, le chef
   * l'envoie aux DD pour qu'ils répondent ») : une ligne par personne dont l'école est douteuse
   * (probable, introuvable, ou lieu écrit ≠ école), avec ce que le système propose, et deux colonnes
   * vides pour la réponse de la DDEPPSA. Une DDEPPSA, ou toutes (une synthèse en tête).
   */
  async excel(departementId: number | null, tout: boolean) {
    const { lieux, ecarts } = await this.calcul();
    const SITUATIONS: Record<string, string> = {
      SUR: 'École trouvée (sûre)',
      PROBABLE: 'École probable : à confirmer',
      INTROUVABLE: 'École introuvable dans l’organigramme',
      ECART: 'Lieu écrit ≠ école de rattachement',
    };
    const CYCLES: Record<string, string> = {
      PRESCOLAIRE: 'Préscolaire',
      PRIMAIRE: 'Primaire',
      COLLEGE: 'Collège',
      LYCEE: 'Lycée',
      ALPHABETISATION: 'Alphabétisation',
    };
    const groupes = [
      ...lieux
        .filter((l) => tout || l.etat !== 'SUR')
        .map((l) => ({
          situation: l.etat,
          departementId: l.departementId,
          departement: l.departement,
          lieu: l.lieu,
          proposee: l.proposee?.nom ?? null,
          autres: l.autres
            .map((a) => a?.nom)
            .filter(Boolean)
            .join(' ; '),
          rattachee: null as string | null,
          ids: l.ids,
        })),
      ...ecarts.map((e) => ({
        situation: 'ECART',
        departementId: e.departementId,
        departement: e.departement,
        lieu: e.lieu,
        proposee: e.autre?.nom ?? null,
        autres: '',
        rattachee: e.rattachee?.nom ?? null,
        ids: e.ids,
      })),
    ].filter(
      (g) => departementId === null || g.departementId === departementId,
    );
    const details = new Map(
      (await this.details(groupes.flatMap((g) => g.ids))).map((d) => [d.id, d]),
    );
    const ordre = ['INTROUVABLE', 'PROBABLE', 'ECART', 'SUR'];
    groupes.sort(
      (a, b) =>
        (a.departement ?? 'zz').localeCompare(b.departement ?? 'zz', 'fr') ||
        ordre.indexOf(a.situation) - ordre.indexOf(b.situation) ||
        a.lieu.localeCompare(b.lieu, 'fr'),
    );

    const wb = new ExcelJS.Workbook();
    wb.creator = 'SIGRHAS-MEPPSA';
    const entete = (f: ExcelJS.Worksheet) => {
      const r = f.getRow(1);
      r.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      r.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF0F5132' },
      };
      r.alignment = { vertical: 'middle', wrapText: true };
      r.height = 32;
      f.views = [{ state: 'frozen', ySplit: 1 }];
    };
    // Synthèse : par DDEPPSA, combien de personnes dans chaque situation
    const syn = wb.addWorksheet('Synthèse');
    syn.columns = [
      { header: 'DDEPPSA (département)', width: 28 },
      ...ordre
        .filter((o) => tout || o !== 'SUR')
        .map((o) => ({ header: SITUATIONS[o], width: 24 })),
      { header: 'Total à vérifier', width: 16 },
    ];
    const parDep = new Map<string, Record<string, number>>();
    for (const g of groupes) {
      const d = g.departement ?? 'Département non indiqué';
      const x = parDep.get(d) ?? {};
      x[g.situation] = (x[g.situation] ?? 0) + g.ids.length;
      parDep.set(d, x);
    }
    for (const [d, x] of parDep)
      syn.addRow([
        d,
        ...ordre.filter((o) => tout || o !== 'SUR').map((o) => x[o] ?? 0),
        Object.values(x).reduce((s, n) => s + n, 0),
      ]);
    entete(syn);

    const f = wb.addWorksheet('À vérifier');
    f.columns = [
      { header: 'N°', width: 7 },
      { header: 'DDEPPSA (département)', width: 22 },
      { header: 'Situation', width: 30 },
      { header: 'Lieu de service écrit sur la fiche', width: 34 },
      { header: 'École proposée par le système', width: 34 },
      { header: 'Autres écoles possibles', width: 34 },
      { header: 'École de rattachement actuelle', width: 30 },
      { header: 'Nom et prénoms', width: 34 },
      { header: 'Date de naissance', width: 13 },
      { header: 'Statut', width: 15 },
      { header: 'Matricule solde', width: 15 },
      { header: 'Téléphone', width: 14 },
      { header: 'Cycle (fiche)', width: 14 },
      { header: 'Inspection écrite', width: 26 },
      {
        header: 'RÉPONSE DE LA DDEPPSA : école où l’agent travaille réellement',
        width: 40,
      },
      { header: 'Observation de la DDEPPSA', width: 34 },
    ];
    let n = 0;
    for (const g of groupes)
      for (const id of g.ids) {
        const d = details.get(id);
        if (!d) continue;
        f.addRow([
          ++n,
          g.departement ?? '',
          SITUATIONS[g.situation] ?? g.situation,
          g.lieu,
          g.proposee ?? '',
          g.autres,
          g.rattachee ?? '',
          d.nom,
          d.naissance ?? '',
          d.statut.charAt(0) + d.statut.slice(1).toLowerCase(),
          d.matricule ?? '',
          d.telephone ?? '',
          d.cycle ? (CYCLES[d.cycle] ?? d.cycle) : '',
          d.inspection ?? '',
          '',
          '',
        ]);
      }
    entete(f);
    f.autoFilter = { from: 'A1', to: 'P1' };
    // Les deux colonnes de réponse, en jaune : c'est là que la DDEPPSA écrit
    for (const c of ['O', 'P'])
      f.getColumn(c).eachCell((cell, r) => {
        if (r > 1)
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFFF4CC' },
          };
      });
    const tampon = Buffer.from(await wb.xlsx.writeBuffer());
    return { tampon, lignes: n };
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
    // (les fiches vont changer : l'analyse gardée ne vaut plus)
    memoireAnalyse = null;
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
