import ExcelJS from 'exceljs';
import {
  AlignmentType,
  Document,
  Footer,
  Packer,
  PageNumber,
  PageOrientation,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';

/**
 * Liste des volontaires ou des communautaires (06/11/2026) : toutes les informations de chaque
 * personne, en Excel ou en Word, en paysage, avec au pied de chaque page la mention du système.
 * Le PDF passe par la page d'impression de l'écran (même liste, mêmes colonnes).
 */
export const GENERE_PAR =
  'Généré par le Système d’Information de Gestion des Ressources Humaines et de l’Administration Scolaire (SIGRHAS-MEPPSA)';

/** Une personne de la liste, avec les libellés déjà écrits. */
export interface LigneVolontaire {
  nomComplet: string;
  naissance: string;
  telephone: string;
  diplome: string;
  specialite: string;
  categorie: string;
  departement: string;
  etablissement: string;
  vague: string;
  note: string;
  priseService: string;
  payeDepuis: string;
  statut: string;
  observation: string;
}

/** Colonnes : titre, largeur Excel, largeur Word (%), valeur. Communautaires : sans vague. */
export function colonnesVolontaires(population: string) {
  const c: [string, number, number, keyof LigneVolontaire][] = [
    ['Noms et prénoms', 34, 14, 'nomComplet'],
    ['Date et lieu de naissance', 24, 9, 'naissance'],
    ['Téléphone', 15, 6, 'telephone'],
    ['Diplôme', 18, 7, 'diplome'],
    ['Spécialité', 18, 7, 'specialite'],
    [
      population === 'COMMUNAUTAIRE' ? 'Cycle' : 'Catégorie',
      22,
      8,
      'categorie',
    ],
    ['Département', 18, 7, 'departement'],
    ['Établissement', 30, 10, 'etablissement'],
    ['Vague', 12, 5, 'vague'],
    ['Note de service', 24, 8, 'note'],
    ['Prise de service', 13, 5, 'priseService'],
    ['Payé depuis', 13, 5, 'payeDepuis'],
    ['Situation', 22, 6, 'statut'],
    ['Observation', 26, 0, 'observation'],
  ];
  return population === 'COMMUNAUTAIRE'
    ? c.filter(([, , , cle]) => cle !== 'vague')
    : c;
}

const edite = (n: number) =>
  `${n} personne(s) — édité le ${new Date().toLocaleDateString('fr-FR')} à ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;

export async function volontairesExcel(
  lignes: LigneVolontaire[],
  titre: string,
  population: string,
): Promise<Buffer> {
  const cols = colonnesVolontaires(population);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SIGRHAS-MEPPSA';
  const ws = wb.addWorksheet('Liste', {
    pageSetup: {
      orientation: 'landscape',
      paperSize: 9,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      printTitlesRow: '4:4',
    },
    headerFooter: {
      oddFooter: `&L&7${GENERE_PAR}&R&8Page &P sur &N`,
    },
    views: [{ state: 'frozen', ySplit: 4 }],
  });
  const n = cols.length + 1;
  ws.mergeCells(1, 1, 1, n);
  ws.getCell(1, 1).value = titre.toUpperCase();
  ws.getCell(1, 1).font = { bold: true, size: 14, color: { argb: 'FF07311D' } };
  ws.getCell(1, 1).alignment = { horizontal: 'center' };
  ws.mergeCells(2, 1, 2, n);
  ws.getCell(2, 1).value = edite(lignes.length);
  ws.getCell(2, 1).font = {
    italic: true,
    size: 9,
    color: { argb: 'FF71717A' },
  };
  ws.getCell(2, 1).alignment = { horizontal: 'center' };
  const entete = ws.getRow(4);
  ['N°', ...cols.map(([t]) => t)].forEach((t, i) => {
    const c = entete.getCell(i + 1);
    c.value = t;
    c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    c.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF007F39' },
    };
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    c.border = { bottom: { style: 'thin', color: { argb: 'FF00692F' } } };
  });
  entete.height = 30;
  ws.getColumn(1).width = 6;
  cols.forEach(([, l], i) => (ws.getColumn(i + 2).width = l));
  lignes.forEach((x, i) => {
    const r = ws.addRow([i + 1, ...cols.map(([, , , cle]) => x[cle] || '')]);
    r.alignment = { vertical: 'top', wrapText: true };
    r.font = { size: 10 };
    if (i % 2)
      r.eachCell((c) => {
        c.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF4FAF6' },
        };
      });
    r.eachCell((c) => {
      c.border = { bottom: { style: 'hair', color: { argb: 'FFD4D4D8' } } };
    });
  });
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: n } };
  const pied = ws.addRow([]);
  pied.getCell(1).value = GENERE_PAR;
  pied.getCell(1).font = { italic: true, size: 8, color: { argb: 'FF71717A' } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const run = (
  t: string,
  o: {
    gras?: boolean;
    taille?: number;
    couleur?: string;
    italique?: boolean;
  } = {},
) =>
  new TextRun({
    text: t,
    bold: o.gras,
    italics: o.italique,
    size: Math.round((o.taille ?? 8) * 2),
    color: o.couleur,
    font: 'Calibri',
  });

const cellule = (t: string, entete = false, largeur?: number) =>
  new TableCell({
    width: largeur ? { size: largeur, type: WidthType.PERCENTAGE } : undefined,
    shading: entete
      ? { fill: '007F39', color: 'auto', type: 'clear' }
      : undefined,
    margins: { top: 40, bottom: 40, left: 60, right: 60 },
    children: [
      new Paragraph({
        alignment: entete ? AlignmentType.CENTER : AlignmentType.LEFT,
        children: [
          run(t, {
            gras: entete,
            taille: entete ? 7.5 : 7.5,
            couleur: entete ? 'FFFFFF' : undefined,
          }),
        ],
      }),
    ],
  });

export async function volontairesWord(
  lignes: LigneVolontaire[],
  titre: string,
  population: string,
): Promise<Buffer> {
  // Word : l'observation reste dans Excel (la page serait trop serrée)
  const cols = colonnesVolontaires(population).filter(([, , w]) => w > 0);
  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            size: { orientation: PageOrientation.LANDSCAPE },
            margin: {
              top: 600,
              bottom: 700,
              left: 500,
              right: 500,
              footer: 300,
            },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  run('Page ', { taille: 7 }),
                  new TextRun({
                    children: [PageNumber.CURRENT],
                    size: 14,
                    font: 'Calibri',
                  }),
                  run(' sur ', { taille: 7 }),
                  new TextRun({
                    children: [PageNumber.TOTAL_PAGES],
                    size: 14,
                    font: 'Calibri',
                  }),
                ],
              }),
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  run(GENERE_PAR, {
                    taille: 6.5,
                    italique: true,
                    couleur: '71717A',
                  }),
                ],
              }),
            ],
          }),
        },
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              run(titre.toUpperCase(), {
                gras: true,
                taille: 13,
                couleur: '07311D',
              }),
            ],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 160 },
            children: [
              run(edite(lignes.length), {
                taille: 8,
                italique: true,
                couleur: '71717A',
              }),
            ],
          }),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({
                tableHeader: true,
                children: [
                  cellule('N°', true, 3),
                  ...cols.map(([t, , w]) => cellule(t, true, w)),
                ],
              }),
              ...lignes.map(
                (x, i) =>
                  new TableRow({
                    cantSplit: true,
                    children: [
                      cellule(String(i + 1), false, 3),
                      ...cols.map(([, , w, cle]) =>
                        cellule(x[cle] || '—', false, w),
                      ),
                    ],
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
