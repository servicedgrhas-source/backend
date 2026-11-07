import ExcelJS from 'exceljs';

/**
 * La base des mutations en Excel (07/11/2026) : une ligne par demande, bien présentée ; les demandes
 * qui ont encore des points à vérifier sont en orange, avec la liste des points dans la dernière
 * colonne. Une deuxième feuille compte les points par nature.
 */

export interface LigneExport {
  numero: number;
  dateEnregistrement: string | null;
  nom: string;
  genre: string;
  grade: string | null;
  matricule: string | null;
  type: string;
  statut: string;
  origine: string | null;
  lieuService: string | null;
  cycle: string | null;
  specialite: string | null;
  datePriseService: string | null;
  duree: string | null;
  sollicite: string | null;
  lieuSollicite: string | null;
  motif: string;
  justificatif: string | null;
  etat: string;
  note: string | null;
  anomalies: string[];
}

const VERT = 'FF0B5D3B';
const ORANGE = 'FFFFE0B2';
const ORANGE_FONCE = 'FFB45309';
const GRIS = 'FFF4F4F5';

const COLONNES: { titre: string; cle: keyof LigneExport; largeur: number }[] = [
  { titre: 'N°', cle: 'numero', largeur: 8 },
  { titre: 'Date d’enreg.', cle: 'dateEnregistrement', largeur: 12 },
  { titre: 'Noms et prénoms', cle: 'nom', largeur: 32 },
  { titre: 'Genre', cle: 'genre', largeur: 7 },
  { titre: 'Grade / échelon', cle: 'grade', largeur: 13 },
  { titre: 'Matricule solde', cle: 'matricule', largeur: 14 },
  { titre: 'Type', cle: 'type', largeur: 13 },
  { titre: 'Statut', cle: 'statut', largeur: 14 },
  { titre: 'Département d’origine', cle: 'origine', largeur: 16 },
  { titre: 'Lieu de service', cle: 'lieuService', largeur: 26 },
  { titre: 'Cycle', cle: 'cycle', largeur: 12 },
  { titre: 'Spécialité', cle: 'specialite', largeur: 16 },
  { titre: 'Prise de service', cle: 'datePriseService', largeur: 12 },
  { titre: 'Durée dans le poste', cle: 'duree', largeur: 13 },
  { titre: 'Département sollicité', cle: 'sollicite', largeur: 16 },
  { titre: 'Lieu sollicité', cle: 'lieuSollicite', largeur: 22 },
  { titre: 'Motif', cle: 'motif', largeur: 20 },
  { titre: 'Justificatif', cle: 'justificatif', largeur: 26 },
  { titre: 'Étape', cle: 'etat', largeur: 20 },
  { titre: 'Note de service', cle: 'note', largeur: 14 },
  { titre: 'Points à vérifier', cle: 'anomalies', largeur: 44 },
];

const dateFr = (d: string | null) =>
  d && /^\d{4}-\d{2}-\d{2}/.test(d)
    ? d.slice(0, 10).split('-').reverse().join('/')
    : (d ?? '');

export async function classeurMutations(
  lignes: LigneExport[],
  o: { filtres: string; par: string },
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SIGRHAS-MEPPSA';
  const ws = wb.addWorksheet('Demandes de mutation', {
    pageSetup: {
      paperSize: 9,
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    },
    views: [{ state: 'frozen', ySplit: 5, xSplit: 3 }],
  });
  const nbCol = COLONNES.length;
  const avecPoints = lignes.filter((l) => l.anomalies.length).length;

  // En-tête du document
  ws.mergeCells(1, 1, 1, nbCol);
  const t = ws.getCell(1, 1);
  t.value = 'BASE DES DEMANDES DE MUTATION';
  t.font = { bold: true, size: 15, color: { argb: VERT } };
  ws.mergeCells(2, 1, 2, nbCol);
  ws.getCell(2, 1).value =
    `${lignes.length} demande(s)${o.filtres ? ` · ${o.filtres}` : ''} · éditée le ${new Date().toLocaleDateString('fr-FR')} par ${o.par}`;
  ws.getCell(2, 1).font = { size: 10, color: { argb: 'FF52525B' } };
  ws.mergeCells(3, 1, 3, nbCol);
  const legende = ws.getCell(3, 1);
  legende.value = avecPoints
    ? `Lignes en orange : ${avecPoints} demande(s) avec des points à vérifier (voir la dernière colonne et la feuille « Points à vérifier »).`
    : 'Aucune demande n’a de point à vérifier.';
  legende.font = {
    size: 10,
    bold: true,
    color: { argb: avecPoints ? ORANGE_FONCE : VERT },
  };
  if (avecPoints)
    legende.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: ORANGE },
    };
  ws.getRow(4).height = 6;

  // Titres des colonnes
  const entete = ws.getRow(5);
  COLONNES.forEach((c, i) => {
    const cell = entete.getCell(i + 1);
    cell.value = c.titre;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: VERT } };
    cell.alignment = {
      vertical: 'middle',
      horizontal: 'center',
      wrapText: true,
    };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF064E3B' } } };
  });
  entete.height = 32;
  ws.columns = COLONNES.map((c) => ({ width: c.largeur }));

  // Une ligne par demande
  lignes.forEach((l, i) => {
    const row = ws.getRow(6 + i);
    COLONNES.forEach((c, j) => {
      const v = l[c.cle];
      const cell = row.getCell(j + 1);
      cell.value =
        c.cle === 'anomalies'
          ? l.anomalies.join(' ; ')
          : c.cle === 'dateEnregistrement' || c.cle === 'datePriseService'
            ? dateFr(v as string | null)
            : ((v as string | number | null) ?? '');
      cell.font = {
        size: 10,
        ...(c.cle === 'nom' ? { bold: true } : {}),
        ...(c.cle === 'anomalies' && l.anomalies.length
          ? { color: { argb: ORANGE_FONCE }, bold: true }
          : {}),
      };
      cell.alignment = {
        vertical: 'top',
        wrapText:
          c.cle === 'anomalies' ||
          c.cle === 'justificatif' ||
          c.cle === 'lieuService',
      };
      cell.border = { bottom: { style: 'hair', color: { argb: 'FFD4D4D8' } } };
      if (l.anomalies.length)
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: ORANGE },
        };
      else if (i % 2)
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: GRIS },
        };
    });
  });
  ws.autoFilter = {
    from: { row: 5, column: 1 },
    to: { row: 5 + lignes.length, column: nbCol },
  };

  // Feuille 2 : les points à vérifier, par nature
  const ws2 = wb.addWorksheet('Points à vérifier');
  ws2.columns = [{ width: 70 }, { width: 14 }];
  ws2.addRow(['Points à vérifier dans les demandes encore dans la base']).font =
    { bold: true, size: 13, color: { argb: VERT } };
  ws2.addRow([
    `Ils se corrigent dans l’application : Mutations › Demandes, filtre « Points à vérifier », bouton « Corriger ».`,
  ]).font = { size: 10, color: { argb: 'FF52525B' } };
  ws2.addRow([]);
  const t2 = ws2.addRow(['Point', 'Demandes']);
  t2.eachCell((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: VERT } };
  });
  const compte = new Map<string, number>();
  for (const l of lignes)
    for (const a of l.anomalies) compte.set(a, (compte.get(a) ?? 0) + 1);
  for (const [a, n] of [...compte].sort((x, y) => y[1] - x[1])) {
    const r = ws2.addRow([a, n]);
    r.getCell(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: ORANGE },
    };
  }
  ws2.addRow(['Demandes concernées', avecPoints]).font = { bold: true };

  return Buffer.from(await wb.xlsx.writeBuffer());
}
