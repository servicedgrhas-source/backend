import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  AlignmentType,
  BorderStyle,
  Document,
  Packer,
  PageOrientation,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import ExcelJS from 'exceljs';
import { Repository } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { codeCategorie, enTexte, normaliser } from '../common/texte';
import { AgentRecense } from '../entities';
import { ParametresService } from '../core/core.service';
import { RecensementService } from './recensement.service';
import { echellesDe, echelonsDus } from './valeurs';

/**
 * Échelons en retard (réunion DG du 27/10/2026) : pour chaque fonctionnaire ou contractuel en
 * activité, les promotions (ou avancements) qu'il aurait dû avoir jusqu'à la date choisie, d'après
 * sa dernière promotion, son échelon et son échelle. Sert à préparer la commission administrative
 * paritaire (révision de carrière) sans demander de dossier aux agents, et à chiffrer ses moyens.
 */
export interface FiltresRetards {
  departement?: number;
  categorie?: string;
  cycle?: string;
  structure?: number;
  /** Nombre exact d'échelons dus ; « 5+ » : 5 ou plus. */
  dus?: string;
  /** Situation au 31/12 de cette année (sinon aujourd'hui). */
  annee?: number;
  statut?: string;
  recherche?: string;
}

export interface LigneRetard {
  id: number;
  numeroFiche: string | null;
  nomComplet: string;
  matricule: string | null;
  statut: string;
  categorie: string | null;
  echelle: string | null;
  grade: string | null;
  departement: string | null;
  structure: string | null;
  cycle: string | null;
  /** Échelon actuel (celui de l'arrêté), et date de la dernière promotion (ou de l'entrée). */
  echelon: number | null;
  depuis: string;
  origine: 'DERNIER' | 'ENTREE';
  /** Échelons dus à la date de référence, l'échelon qu'il devrait avoir, et les dates. */
  dus: number;
  echelonTheorique: number | null;
  echeances: string[];
  /** Échelon au-delà du 1er sans date de dernière promotion : à renseigner, rien n'est calculé. */
  dateManquante: boolean;
}

/** En-tête des documents imprimés de la DGRHAS (comme EnteteOfficielle à l'écran). */
const ENTETE_MINISTERE: [string, boolean][] = [
  ['REPUBLIQUE DU CONGO — Unité-Travail-Progrès', true],
  ['', false],
  [
    'MINISTERE DE L’ENSEIGNEMENT PRESCOLAIRE, PRIMAIRE, SECONDAIRE ET DE L’ALPHABETISATION',
    true,
  ],
  ['-------------------', false],
  ['CABINET', true],
  ['-------------------', false],
  [
    'DIRECTION GENERALE DES RESSOURCES HUMAINES ET DE L’ADMINISTRATION SCOLAIRE',
    true,
  ],
  ['-------------------', false],
];

const LIBELLE_CYCLE: Record<string, string> = {
  PRESCOLAIRE: 'Préscolaire',
  PRIMAIRE: 'Primaire',
  COLLEGE: 'Collège',
  LYCEE: 'Lycée',
  ALPHABETISATION: 'Alphabétisation',
};

@Injectable()
export class RetardsEchelonsService {
  constructor(
    @InjectRepository(AgentRecense)
    private readonly agents: Repository<AgentRecense>,
    private readonly rec: RecensementService,
    private readonly params: ParametresService,
  ) {}

  async calculer(u: UtilisateurConnecte, f: FiltresRetards) {
    const c = this.rec.config.get();
    const p = await this.rec.perimetre(u);
    const fp = this.rec.filtrePerimetre(p);
    const reference =
      f.annee && f.annee >= 1990 && f.annee <= 2100
        ? `${f.annee}-12-31`
        : new Date().toISOString().slice(0, 10);
    const echelles = echellesDe(
      await this.agents.query(
        `SELECT code, libelle, donnees FROM referentiel WHERE type = 'ECHELLE' AND actif`,
      ),
    );
    const brut = await this.agents.query<
      {
        id: number;
        numeroFiche: string | null;
        nomComplet: string;
        matricule: string | null;
        statut: string;
        departementId: number | null;
        departement: string | null;
        structureId: number | null;
        structure: string | null;
        cycle: string | null;
        position: string | null;
        donnees: Record<string, unknown>;
      }[]
    >(
      `SELECT a.id, a."numeroFiche", a."nomComplet", a.matricule, a.statut, a."departementId",
              d.nom AS departement, a."structureId", s.nom AS structure, s.cycle,
              a.donnees->>'POSITION' AS position,
              jsonb_build_object('DATE_GRADE', a.donnees->'DATE_GRADE', 'PROMOTIONS', a.donnees->'PROMOTIONS',
                                 'DATE_RECRUTEMENT', a.donnees->'DATE_RECRUTEMENT', 'ECHELON', a.donnees->'ECHELON',
                                 'ECHELLE', a.donnees->'ECHELLE', 'CATEGORIE', a.donnees->'CATEGORIE',
                                 'GRADE', a.donnees->'GRADE') AS donnees
         FROM agent_recense a
         LEFT JOIN departement d ON d.id = a."departementId"
         LEFT JOIN structure s ON s.id = a."structureId"
        WHERE ${fp.sql.replace('$X', '$1')}
          AND a.statut IN ('FONCTIONNAIRE', 'CONTRACTUEL')
          AND coalesce(a.contentieux->>'etat', 'CONFIRME') = 'CONFIRME'`,
      fp.params,
    );
    const mots = normaliser(f.recherche ?? '')
      .split(/\s+/)
      .filter(Boolean);
    const lignes: LigneRetard[] = [];
    for (const a of brut) {
      if (a.position && a.position !== 'ACTIVITE') continue;
      if (f.statut && a.statut !== f.statut) continue;
      if (f.departement && a.departementId !== f.departement) continue;
      if (f.structure && a.structureId !== f.structure) continue;
      if (f.cycle && a.cycle !== f.cycle) continue;
      const d = a.donnees ?? {};
      const categorie = codeCategorie(d.CATEGORIE);
      if (f.categorie && categorie !== f.categorie) continue;
      if (
        mots.length &&
        !mots.every((m) =>
          normaliser(
            `${a.nomComplet} ${a.matricule ?? ''} ${a.numeroFiche ?? ''}`,
          ).includes(m),
        )
      )
        continue;
      const r = echelonsDus(c, a.statut, d, echelles, reference);
      if (!r) continue;
      const { av, echelon, dateManquante, attendues } = r;
      if (!attendues.length && !dateManquante) continue;
      lignes.push({
        id: a.id,
        numeroFiche: a.numeroFiche,
        nomComplet: a.nomComplet,
        matricule: a.matricule,
        statut: a.statut,
        categorie,
        echelle: enTexte(d.ECHELLE) || null,
        grade: enTexte(d.GRADE) || null,
        departement: a.departement,
        structure: a.structure,
        cycle: a.cycle ? (LIBELLE_CYCLE[a.cycle] ?? a.cycle) : null,
        echelon,
        depuis: av.depuis,
        origine: av.origine,
        dus: attendues.length,
        echelonTheorique: attendues.at(-1)?.echelon ?? echelon,
        echeances: attendues.map((x) => x.date),
        dateManquante,
      });
    }
    // Filtre sur le nombre d'échelons dus (« 2 », ou « 5+ »)
    const m = /^(\d+)(\+)?$/.exec(f.dus ?? '');
    const retenues = m
      ? lignes.filter((l) =>
          m[2] ? l.dus >= Number(m[1]) : l.dus === Number(m[1]),
        )
      : f.dus === 'date'
        ? lignes.filter((l) => l.dateManquante)
        : lignes;
    retenues.sort(
      (a, b) =>
        b.dus - a.dus ||
        (a.departement ?? '').localeCompare(b.departement ?? '') ||
        a.nomComplet.localeCompare(b.nomComplet),
    );
    const compter = (cle: (l: LigneRetard) => string) => {
      const r = new Map<string, number>();
      for (const l of lignes) r.set(cle(l), (r.get(cle(l)) ?? 0) + 1);
      return [...r].map(([k, n]) => ({ k, n })).sort((x, y) => y.n - x.n);
    };
    return {
      reference,
      total: retenues.length,
      echelonsDus: retenues.reduce((s, l) => s + l.dus, 0),
      dateManquante: lignes.filter((l) => l.dateManquante).length,
      // Répartitions (sur tous les agents en retard du périmètre) : préparer la commission
      parDus: compter((l) => (l.dateManquante ? 'date' : String(l.dus))).sort(
        (x, y) =>
          x.k === 'date' ? 1 : y.k === 'date' ? -1 : Number(x.k) - Number(y.k),
      ),
      parCategorie: compter((l) => l.categorie ?? 'Inconnue'),
      parDepartement: compter((l) => l.departement ?? 'Inconnu'),
      lignes: retenues,
      // Signature du Directeur général, comme sur le bottin et le dossier de carrière
      signature: {
        titre: this.params.get('DG_TITRE'),
        nom: this.params.get('DG_NOM') || null,
        lieu: this.params.get('LIEU_SIGNATURE') || 'Brazzaville',
      },
    };
  }

  /** Colonnes communes aux exports. */
  private colonnes(l: LigneRetard) {
    return [
      l.nomComplet,
      l.matricule ?? '',
      l.statut === 'CONTRACTUEL' ? 'Contractuel' : 'Fonctionnaire',
      [l.categorie, l.echelle ? `éch. ${l.echelle}` : null]
        .filter(Boolean)
        .join(' · '),
      l.departement ?? '',
      l.structure ?? '',
      l.echelon ?? '',
      l.dateManquante
        ? 'à renseigner'
        : `${l.depuis.split('-').reverse().join('/')}${l.origine === 'ENTREE' ? ' (entrée)' : ''}`,
      l.dateManquante ? '' : l.dus,
      l.dateManquante ? '' : (l.echelonTheorique ?? ''),
    ];
  }

  private static ENTETES = [
    'Nom et prénoms',
    'Matricule',
    'Statut',
    'Catégorie · échelle',
    'Département',
    'Structure',
    'Échelon actuel',
    'Dernière promotion',
    'Échelons dus',
    'Échelon attendu',
  ];

  async excel(u: UtilisateurConnecte, f: FiltresRetards) {
    const r = await this.calculer(u, f);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Échelons en retard', {
      pageSetup: {
        paperSize: 9,
        orientation: 'landscape',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
      },
    });
    for (const [t, gras] of ENTETE_MINISTERE)
      ws.addRow([t]).font = { bold: gras };
    ws.addRow([]);
    ws.addRow([
      `ÉCHELONS EN RETARD AU ${r.reference.split('-').reverse().join('/')}`,
    ]).font = { bold: true, size: 13 };
    ws.addRow([
      `${r.total} agent(s), ${r.echelonsDus} échelon(s) dus${r.dateManquante ? ` ; ${r.dateManquante} agent(s) sans date de dernière promotion` : ''}`,
    ]);
    ws.addRow([]);
    const t = ws.addRow(['N°', ...RetardsEchelonsService.ENTETES]);
    t.font = { bold: true };
    t.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE4E4E7' },
      };
      cell.border = { bottom: { style: 'thin' } };
    });
    r.lignes.forEach((l, i) => ws.addRow([i + 1, ...this.colonnes(l)]));
    ws.addRow([]);
    ws.addRow([
      ...Array<string>(7).fill(''),
      `Fait à ${r.signature.lieu}, le ${new Date().toLocaleDateString('fr-FR')}`,
    ]);
    ws.addRow([...Array<string>(7).fill(''), r.signature.titre]);
    ws.addRow([]);
    ws.addRow([]);
    ws.addRow([]);
    ws.addRow([...Array<string>(7).fill(''), r.signature.nom ?? '']).font = {
      bold: true,
      underline: true,
    };
    ws.columns = [6, 34, 14, 14, 18, 18, 30, 10, 18, 10, 10].map((width) => ({
      width,
    }));
    ws.views = [{ state: 'frozen', ySplit: t.number }];
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  async word(u: UtilisateurConnecte, f: FiltresRetards) {
    const r = await this.calculer(u, f);
    const run = (
      text: string,
      o: { gras?: boolean; taille?: number; souligne?: boolean } = {},
    ) =>
      new TextRun({
        text,
        bold: o.gras,
        size: o.taille ?? 20,
        font: 'Times New Roman',
        underline: o.souligne ? {} : undefined,
      });
    const para = (
      text: string,
      o: {
        gras?: boolean;
        taille?: number;
        souligne?: boolean;
        centre?: boolean;
        avant?: number;
      } = {},
    ) =>
      new Paragraph({
        alignment: o.centre ? AlignmentType.CENTER : AlignmentType.LEFT,
        spacing: { before: o.avant ?? 0, after: 0 },
        children: [run(text, o)],
      });
    const cellule = (t: string | number, gras = false) =>
      new TableCell({
        children: [
          new Paragraph({ children: [run(String(t), { gras, taille: 16 })] }),
        ],
      });
    const sansBord = {
      top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    };
    // En-tête habituel : le ministère à gauche, la République à droite
    const entete = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        ...sansBord,
        insideHorizontal: sansBord.top,
        insideVertical: sansBord.top,
      },
      rows: [
        new TableRow({
          children: [
            new TableCell({
              width: { size: 60, type: WidthType.PERCENTAGE },
              borders: sansBord,
              children: ENTETE_MINISTERE.slice(2).map(([t]) =>
                para(t, { gras: !/^-+$/.test(t), taille: 18, centre: true }),
              ),
            }),
            new TableCell({
              width: { size: 40, type: WidthType.PERCENTAGE },
              borders: sansBord,
              children: [
                para('REPUBLIQUE DU CONGO', {
                  gras: true,
                  taille: 18,
                  centre: true,
                }),
                para('Unité-Travail-Progrès', { taille: 18, centre: true }),
                para('-------------------', { taille: 18, centre: true }),
              ],
            }),
          ],
        }),
      ],
    });
    const doc = new Document({
      sections: [
        {
          properties: {
            page: {
              size: { orientation: PageOrientation.LANDSCAPE },
              margin: { top: 700, bottom: 700, left: 800, right: 800 },
            },
          },
          children: [
            entete,
            para(
              `ÉCHELONS EN RETARD AU ${r.reference.split('-').reverse().join('/')}`,
              {
                gras: true,
                taille: 26,
                centre: true,
                avant: 300,
              },
            ),
            para(
              `${r.total} agent(s), ${r.echelonsDus} échelon(s) dus${r.dateManquante ? ` ; ${r.dateManquante} agent(s) sans date de dernière promotion` : ''}`,
              { taille: 20, centre: true, avant: 60 },
            ),
            new Paragraph({ children: [] }),
            new Table({
              width: { size: 100, type: WidthType.PERCENTAGE },
              rows: [
                new TableRow({
                  tableHeader: true,
                  children: ['N°', ...RetardsEchelonsService.ENTETES].map((x) =>
                    cellule(x, true),
                  ),
                }),
                ...r.lignes.map(
                  (l, i) =>
                    new TableRow({
                      cantSplit: true,
                      children: [i + 1, ...this.colonnes(l)].map((x) =>
                        cellule(x),
                      ),
                    }),
                ),
              ],
            }),
            // Signature du Directeur général, à droite
            new Paragraph({
              alignment: AlignmentType.RIGHT,
              spacing: { before: 400 },
              keepNext: true,
              children: [
                run(
                  `Fait à ${r.signature.lieu}, le ${new Date().toLocaleDateString('fr-FR')}`,
                ),
              ],
            }),
            new Paragraph({
              alignment: AlignmentType.RIGHT,
              spacing: { before: 200 },
              keepNext: true,
              children: [run(r.signature.titre, { gras: true })],
            }),
            ...[0, 1, 2].map(
              () => new Paragraph({ keepNext: true, children: [run('')] }),
            ),
            new Paragraph({
              alignment: AlignmentType.RIGHT,
              children: [
                run(r.signature.nom ?? '', { gras: true, souligne: true }),
              ],
            }),
          ],
        },
      ],
    });
    return Packer.toBuffer(doc);
  }
}
