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

/**
 * Liste exportée (écoles, structures administratives…) : en Excel mis en forme ou en Word, avec
 * l'en-tête habituel du ministère et la date d'édition. Les colonnes et les lignes sont données
 * par l'appelant ; l'impression (PDF) se fait par la page « /impression/… » du site.
 */
export interface ListeExportee {
  titre: string;
  sousTitre?: string;
  entetes: string[];
  lignes: (string | number | null)[][];
  /** Largeur de chaque colonne (caractères Excel ; proportions pour Word). */
  largeurs: number[];
  /** Colonnes chiffrées (alignées à droite). */
  nombres?: number[];
  /** Colonne dont le texte est en retrait selon `niveaux` (arbre des structures). */
  retrait?: { colonne: number; niveaux: number[] };
  nomFeuille?: string;
}

const MINISTERE = [
  'MINISTERE DE L’ENSEIGNEMENT PRESCOLAIRE, PRIMAIRE, SECONDAIRE ET DE L’ALPHABETISATION',
  'CABINET',
  'DIRECTION GENERALE DES RESSOURCES HUMAINES ET DE L’ADMINISTRATION SCOLAIRE',
];
const VERT = 'FF0F5132';
const editeLe = () =>
  `Édité le ${new Date().toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Brazzaville' }).replace(' ', ' à ')}`;

export async function excelListe(l: ListeExportee) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SIGRHAS-MEPPSA';
  const ws = wb.addWorksheet((l.nomFeuille ?? 'Liste').slice(0, 31), {
    pageSetup: {
      paperSize: 9,
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    },
  });
  const n = l.entetes.length;
  const ligneFusionnee = (texte: string, font: Partial<ExcelJS.Font>) => {
    const r = ws.addRow([texte]);
    ws.mergeCells(r.number, 1, r.number, n);
    r.getCell(1).font = font;
    r.getCell(1).alignment = { horizontal: 'center', wrapText: true };
    return r;
  };
  ligneFusionnee('REPUBLIQUE DU CONGO — Unité-Travail-Progrès', {
    bold: true,
    size: 10,
  });
  for (const t of MINISTERE) ligneFusionnee(t, { bold: true, size: 10 });
  ws.addRow([]);
  ligneFusionnee(l.titre, { bold: true, size: 14, color: { argb: VERT } });
  if (l.sousTitre) ligneFusionnee(l.sousTitre, { size: 10 });
  ligneFusionnee(editeLe(), {
    size: 9,
    italic: true,
    color: { argb: 'FF52525B' },
  });
  ws.addRow([]);
  const t = ws.addRow(l.entetes);
  t.height = 30;
  t.eachCell((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: VERT } };
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    c.border = { bottom: { style: 'thin', color: { argb: 'FF0A3622' } } };
  });
  l.lignes.forEach((valeurs, i) => {
    const r = ws.addRow(valeurs);
    r.eachCell({ includeEmpty: true }, (c, col) => {
      const nombre = l.nombres?.includes(col - 1);
      c.alignment = {
        vertical: 'middle',
        wrapText: true,
        horizontal: nombre ? 'right' : 'left',
        indent:
          l.retrait && l.retrait.colonne === col - 1
            ? Math.min(10, (l.retrait.niveaux[i] ?? 0) * 2)
            : undefined,
      };
      c.border = { bottom: { style: 'hair', color: { argb: 'FFD4D4D8' } } };
      if (i % 2)
        c.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF4F4F5' },
        };
    });
    if (l.retrait && (l.retrait.niveaux[i] ?? 0) === 0)
      r.getCell(l.retrait.colonne + 1).font = { bold: true };
  });
  ws.columns = l.largeurs.map((width) => ({ width }));
  ws.views = [{ state: 'frozen', ySplit: t.number }];
  ws.autoFilter = {
    from: { row: t.number, column: 1 },
    to: { row: t.number, column: n },
  };
  ws.pageSetup.printTitlesRow = `${t.number}:${t.number}`;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function wordListe(l: ListeExportee) {
  const run = (text: string, o: { gras?: boolean; taille?: number } = {}) =>
    new TextRun({
      text,
      bold: o.gras,
      size: o.taille ?? 18,
      font: 'Times New Roman',
    });
  const para = (
    text: string,
    o: { gras?: boolean; taille?: number; avant?: number } = {},
  ) =>
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: o.avant ?? 0, after: 0 },
      children: [run(text, o)],
    });
  const sansBord = {
    top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  };
  const SEP = '-------------------';
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
            children: MINISTERE.flatMap((t) => [
              para(t, { gras: true }),
              para(SEP),
            ]),
          }),
          new TableCell({
            width: { size: 40, type: WidthType.PERCENTAGE },
            borders: sansBord,
            children: [
              para('REPUBLIQUE DU CONGO', { gras: true }),
              para('Unité-Travail-Progrès'),
              para(SEP),
            ],
          }),
        ],
      }),
    ],
  });
  const total = l.largeurs.reduce((s, x) => s + x, 0);
  const cellule = (
    t: string | number | null,
    col: number,
    o: { gras?: boolean; fond?: string; niveau?: number } = {},
  ) =>
    new TableCell({
      width: {
        size: Math.round((l.largeurs[col] / total) * 100),
        type: WidthType.PERCENTAGE,
      },
      shading: o.fond ? { fill: o.fond } : undefined,
      children: [
        new Paragraph({
          alignment: o.gras
            ? AlignmentType.CENTER
            : l.nombres?.includes(col)
              ? AlignmentType.RIGHT
              : AlignmentType.LEFT,
          indent: o.niveau ? { left: o.niveau * 240 } : undefined,
          children: [
            run(t === null || t === undefined ? '' : String(t), {
              gras: o.gras,
              taille: 16,
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
            margin: { top: 700, bottom: 700, left: 700, right: 700 },
          },
        },
        children: [
          entete,
          para(l.titre, { gras: true, taille: 26, avant: 300 }),
          ...(l.sousTitre
            ? [para(l.sousTitre, { taille: 20, avant: 60 })]
            : []),
          para(editeLe(), { taille: 16, avant: 40 }),
          new Paragraph({ children: [] }),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({
                tableHeader: true,
                children: l.entetes.map((x, col) =>
                  cellule(x, col, { gras: true, fond: 'E4E4E7' }),
                ),
              }),
              ...l.lignes.map(
                (valeurs, i) =>
                  new TableRow({
                    cantSplit: true,
                    children: valeurs.map((x, col) =>
                      cellule(x, col, {
                        niveau:
                          l.retrait && l.retrait.colonne === col
                            ? l.retrait.niveaux[i]
                            : undefined,
                      }),
                    ),
                  }),
              ),
            ],
          }),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}
