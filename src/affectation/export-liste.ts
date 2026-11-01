import ExcelJS from 'exceljs';
import {
  AlignmentType,
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
import {
  NOTES_AFFECTATION,
  type TypeNoteAffectation,
} from '../common/referentiels';
import { groupeQuota, libelleLot, NOM_GROUPE } from '../common/lots';

/**
 * Liste des personnes de « Traitement des affectations », exportée avec les filtres choisis
 * (type de texte, lots, quotas, sans département, cycle, département…) en Excel ou en Word
 * (DG, 01/11/2026). Le PDF passe par la page d'impression de l'écran.
 */

/** Cycle de chaque type de note (comme la colonne « Cycle » des notes). */
export const CYCLE_DU_TYPE: Record<string, string> = {
  PRESCOLAIRE: 'PRESCOLAIRE',
  PRIMAIRE: 'PRIMAIRE',
  ETS: 'PRIMAIRE',
  DEMA: 'COLLEGE',
  DECRET_COLLEGE: 'COLLEGE',
  DECRET_LYCEE: 'LYCEE',
  PERS_ADM: 'ADMINISTRATION',
};

const STATUTS: Record<string, string> = {
  A_TRAITER: 'À traiter',
  AFFECTE: 'Affecté',
  EXCLU: 'Exclu',
};

/** Ce qu'il faut d'une personne de la liste (affectation enrichie). */
export interface PersonneListe {
  typeNote: string;
  statut: string;
  specialite: string | null;
  departement: { nom: string } | null;
  agent: {
    nomComplet: string;
    dateNaissance: string | null;
    lieuNaissance: string | null;
    diplomeBrut: string | null;
    feuille: string;
    departementId: number | null;
    repartitionId?: string | null;
    lotPublication: Parameters<typeof libelleLot>[0] | null;
  };
  derive: {
    grade: string | null;
    categorie: string | null;
    cycleLibelle: string | null;
    reference: string | null;
  };
}

const dateFr = (d: string | null) => d?.split('-').reverse().join('/') ?? '';

const COLONNES: [string, number, (p: PersonneListe) => string][] = [
  ['Noms et prénoms', 34, (p) => p.agent.nomComplet],
  ['Date de naissance', 12, (p) => dateFr(p.agent.dateNaissance)],
  ['Lieu de naissance', 16, (p) => p.agent.lieuNaissance ?? ''],
  ['Diplôme', 16, (p) => p.agent.diplomeBrut ?? ''],
  ['Grade', 14, (p) => p.derive.grade ?? ''],
  ['Cat.', 6, (p) => p.derive.categorie ?? ''],
  ['Cycle', 12, (p) => p.derive.cycleLibelle ?? ''],
  ['Spécialité', 16, (p) => p.specialite ?? ''],
  ['Département', 16, (p) => p.departement?.nom ?? 'Sans département'],
  [
    'Lot',
    16,
    (p) =>
      p.agent.lotPublication ? libelleLot(p.agent.lotPublication) : 'Sans lot',
  ],
  ['Quota', 18, (p) => NOM_GROUPE[groupeQuota(p.agent)].replace('Quota ', '')],
  ['Réf. du texte', 22, (p) => p.derive.reference ?? ''],
  [
    'Note de service',
    22,
    (p) =>
      NOTES_AFFECTATION[p.typeNote as TypeNoteAffectation]?.libelle ??
      p.typeNote,
  ],
  ['Statut', 10, (p) => STATUTS[p.statut] ?? p.statut],
];

const editeLe = (n: number) =>
  `${n} personne(s) · édité le ${new Date().toLocaleDateString('fr-FR')}`;

export async function listeExcel(
  personnes: PersonneListe[],
  titre: string,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Liste', {
    pageSetup: {
      paperSize: 9,
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    },
    views: [{ state: 'frozen', ySplit: 3 }],
  });
  ws.columns = [
    { width: 6 },
    ...COLONNES.map(([, largeur]) => ({ width: largeur })),
  ];
  ws.addRow([titre]).font = { bold: true, size: 13 };
  ws.addRow([editeLe(personnes.length)]).font = {
    italic: true,
    size: 9,
    color: { argb: 'FF555555' },
  };
  const entete = ws.addRow(['N°', ...COLONNES.map(([nom]) => nom)]);
  entete.font = { bold: true };
  entete.eachCell((c) => {
    c.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE6F0EA' },
    };
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    c.border = { bottom: { style: 'thin' } };
  });
  personnes.forEach((p, i) =>
    ws.addRow([i + 1, ...COLONNES.map(([, , valeur]) => valeur(p))]),
  );
  // Filtres d'Excel sur l'en-tête, pour trier ou affiner encore
  ws.autoFilter = {
    from: { row: 3, column: 1 },
    to: { row: 3, column: COLONNES.length + 1 },
  };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const POLICE = 'Times New Roman';
const texte = (t: string, o: { gras?: boolean; taille?: number } = {}) =>
  new TextRun({
    text: t,
    font: POLICE,
    bold: o.gras,
    size: Math.round((o.taille ?? 8) * 2),
  });
const cellule = (t: string, gras = false) =>
  new TableCell({
    children: [new Paragraph({ children: [texte(t, { gras })] })],
  });

/** Colonnes gardées dans Word et le PDF (en paysage, une page de large). */
export const COLONNES_COURTES = [
  'Noms et prénoms',
  'Date de naissance',
  'Diplôme',
  'Grade',
  'Cycle',
  'Spécialité',
  'Département',
  'Lot',
  'Quota',
  'Réf. du texte',
];

export async function listeWord(
  personnes: PersonneListe[],
  titre: string,
): Promise<Buffer> {
  const cols = COLONNES.filter(([nom]) => COLONNES_COURTES.includes(nom));
  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            size: { orientation: PageOrientation.LANDSCAPE },
            margin: { top: 720, bottom: 720, left: 720, right: 720 },
          },
        },
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [texte(titre.toUpperCase(), { gras: true, taille: 13 })],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 160 },
            children: [texte(editeLe(personnes.length), { taille: 9 })],
          }),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              // En-tête repris en haut de chaque page
              new TableRow({
                tableHeader: true,
                children: [
                  cellule('N°', true),
                  ...cols.map(([nom]) => cellule(nom, true)),
                ],
              }),
              ...personnes.map(
                (p, i) =>
                  new TableRow({
                    cantSplit: true,
                    children: [
                      cellule(String(i + 1)),
                      ...cols.map(([, , valeur]) => cellule(valeur(p))),
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
