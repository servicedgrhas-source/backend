import ExcelJS from 'exceljs';

/**
 * La base des enrôlés en Excel, bien présentée (07/11/2026) : une ligne par enrôlé, en-tête vert,
 * lignes alternées, filtres et volets figés ; les retenus sans département retenu (à placer) en
 * orange. Une deuxième feuille croise le département retenu et le diplôme.
 */

export interface LigneEnrole {
  nom: string;
  dateNaissance: string | null;
  /** Âge au 31 décembre de l'année de la campagne, et s'il sort des limites (12/11/2026). */
  age: number | null;
  horsLimite: boolean;
  lieuNaissance: string | null;
  diplome: string;
  promotion: string | null;
  cycle: string | null;
  specialite: string | null;
  souhaites: string;
  retenu: string | null;
  etablissement: string | null;
  telephone: string | null;
  origine: string | null;
  membre: string | null;
  etat: string;
  observation: string | null;
}

const VERT = 'FF0B5D3B';
const VERT_CLAIR = 'FFE8F3EC';
const ORANGE = 'FFFFE0B2';
const ORANGE_FONCE = 'FFB45309';
const GRIS = 'FFF4F4F5';
const GRIS_TEXTE = 'FF52525B';

/** Étapes d'un dossier, dans les mots de l'application. */
export const ETAPES_ENROLE: Record<string, string> = {
  A_CONTROLER: 'À contrôler',
  CONTROLE: 'À décider par la DGRHAS',
  RETENU: 'Retenu',
  NON_RETENU: 'Non retenu',
};

const COLONNES: {
  titre: string;
  cle: keyof LigneEnrole | 'n';
  largeur: number;
  aLaLigne?: boolean;
  centre?: boolean;
}[] = [
  { titre: 'N°', cle: 'n', largeur: 7, centre: true },
  { titre: 'Noms et prénoms', cle: 'nom', largeur: 34 },
  {
    titre: 'Date de naissance',
    cle: 'dateNaissance',
    largeur: 12,
    centre: true,
  },
  { titre: 'Âge', cle: 'age', largeur: 7, centre: true },
  { titre: 'Lieu de naissance', cle: 'lieuNaissance', largeur: 18 },
  { titre: 'Diplôme', cle: 'diplome', largeur: 22, aLaLigne: true },
  { titre: 'Promotion', cle: 'promotion', largeur: 11, centre: true },
  { titre: 'Cycle', cle: 'cycle', largeur: 13 },
  { titre: 'Spécialité', cle: 'specialite', largeur: 18, aLaLigne: true },
  {
    titre: 'Départements souhaités',
    cle: 'souhaites',
    largeur: 24,
    aLaLigne: true,
  },
  { titre: 'Département retenu', cle: 'retenu', largeur: 18 },
  { titre: 'Établissement', cle: 'etablissement', largeur: 24, aLaLigne: true },
  { titre: 'Téléphone', cle: 'telephone', largeur: 14 },
  { titre: 'Origine', cle: 'origine', largeur: 16, aLaLigne: true },
  {
    titre: 'Membre de la commission',
    cle: 'membre',
    largeur: 20,
    aLaLigne: true,
  },
  { titre: 'Étape', cle: 'etat', largeur: 16 },
  { titre: 'Observation', cle: 'observation', largeur: 30, aLaLigne: true },
];

const dateFr = (d: string | null) =>
  d && /^\d{4}-\d{2}-\d{2}/.test(d)
    ? d.slice(0, 10).split('-').reverse().join('/')
    : (d ?? '');

const plein = (argb: string): ExcelJS.Fill => ({
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb },
});

/** Un retenu qui n'a pas encore de département retenu : à placer avant la note. */
const aPlacer = (l: LigneEnrole) => l.etat === 'RETENU' && !l.retenu;

export async function classeurEnroles(
  lignes: LigneEnrole[],
  o: { titre: string; filtres: string; par: string },
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SIGRHAS-MEPPSA';
  const ws = wb.addWorksheet('Base des enrôlés', {
    pageSetup: {
      paperSize: 9,
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      printTitlesRow: '5:5',
      margins: {
        left: 0.4,
        right: 0.4,
        top: 0.5,
        bottom: 0.5,
        header: 0.2,
        footer: 0.2,
      },
    },
    headerFooter: {
      oddFooter: `&L${o.titre}&RPage &P sur &N`,
    },
    views: [{ state: 'frozen', ySplit: 5, xSplit: 2 }],
  });
  const nbCol = COLONNES.length;
  const nbAPlacer = lignes.filter(aPlacer).length;

  // En-tête du document
  ws.mergeCells(1, 1, 1, nbCol);
  const t = ws.getCell(1, 1);
  t.value = o.titre;
  t.font = { bold: true, size: 15, color: { argb: VERT } };
  ws.getRow(1).height = 22;
  ws.mergeCells(2, 1, 2, nbCol);
  ws.getCell(2, 1).value =
    `${lignes.length} enrôlé(s)${o.filtres ? ` · ${o.filtres}` : ''} · édité le ${new Date().toLocaleDateString('fr-FR')} par ${o.par}`;
  ws.getCell(2, 1).font = { size: 10, color: { argb: GRIS_TEXTE } };
  ws.mergeCells(3, 1, 3, nbCol);
  const legende = ws.getCell(3, 1);
  legende.value = nbAPlacer
    ? `Lignes en orange : ${nbAPlacer} retenu(s) sans département retenu, à placer avant la note de service (Enrôlement › Base des enrôlés).`
    : 'Tous les retenus ont leur département retenu.';
  const horsAge = lignes.filter((l) => l.horsLimite).length;
  if (horsAge)
    legende.value += ` Âge (au 31 décembre de l’année de la campagne) en rouge : ${horsAge} hors des limites d’âge.`;
  legende.font = {
    size: 10,
    bold: true,
    color: { argb: nbAPlacer ? ORANGE_FONCE : VERT },
  };
  if (nbAPlacer) legende.fill = plein(ORANGE);
  ws.getRow(4).height = 6;

  // Titres des colonnes
  const entete = ws.getRow(5);
  COLONNES.forEach((c, i) => {
    const cell = entete.getCell(i + 1);
    cell.value = c.titre;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.fill = plein(VERT);
    cell.alignment = {
      vertical: 'middle',
      horizontal: 'center',
      wrapText: true,
    };
    cell.border = {
      left: { style: 'thin', color: { argb: 'FF2F7A55' } },
      right: { style: 'thin', color: { argb: 'FF2F7A55' } },
    };
  });
  entete.height = 32;
  ws.columns = COLONNES.map((c) => ({ width: c.largeur }));

  // Une ligne par enrôlé
  lignes.forEach((l, i) => {
    const row = ws.getRow(6 + i);
    const orange = aPlacer(l);
    COLONNES.forEach((c, j) => {
      const cell = row.getCell(j + 1);
      cell.value =
        c.cle === 'n'
          ? i + 1
          : c.cle === 'dateNaissance'
            ? dateFr(l.dateNaissance)
            : c.cle === 'etat'
              ? (ETAPES_ENROLE[l.etat] ?? l.etat)
              : c.cle === 'retenu' && orange
                ? 'À placer'
                : (l[c.cle] ?? '');
      cell.font = {
        size: 10,
        ...(c.cle === 'nom' ? { bold: true } : {}),
        ...(c.cle === 'age' && l.horsLimite
          ? { bold: true, color: { argb: 'FFB91C1C' } }
          : {}),
        ...(c.cle === 'retenu' && orange
          ? { bold: true, italic: true, color: { argb: ORANGE_FONCE } }
          : {}),
        ...(c.cle === 'etat'
          ? {
              bold: true,
              color: {
                argb:
                  l.etat === 'RETENU'
                    ? VERT
                    : l.etat === 'NON_RETENU'
                      ? 'FFB91C1C'
                      : GRIS_TEXTE,
              },
            }
          : {}),
      };
      cell.alignment = {
        vertical: 'top',
        horizontal: c.centre ? 'center' : 'left',
        wrapText: !!c.aLaLigne,
      };
      cell.border = { bottom: { style: 'hair', color: { argb: 'FFD4D4D8' } } };
      if (orange) cell.fill = plein(ORANGE);
      else if (i % 2) cell.fill = plein(GRIS);
    });
  });
  if (lignes.length)
    ws.autoFilter = {
      from: { row: 5, column: 1 },
      to: { row: 5 + lignes.length, column: nbCol },
    };

  // Feuille 2 : département retenu × diplôme
  const ws2 = wb.addWorksheet('Récapitulatif', {
    pageSetup: {
      paperSize: 9,
      orientation: 'portrait',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    },
  });
  const diplomes = [...new Set(lignes.map((l) => l.diplome))].sort((a, b) =>
    a.localeCompare(b, 'fr'),
  );
  const deps = [...new Set(lignes.map((l) => l.retenu ?? ''))].sort((a, b) =>
    a ? (b ? a.localeCompare(b, 'fr') : -1) : 1,
  );
  const nb2 = diplomes.length + 2;
  ws2.columns = [
    { width: 30 },
    ...diplomes.map(() => ({ width: 16 })),
    { width: 12 },
  ];
  ws2.mergeCells(1, 1, 1, nb2);
  ws2.getCell(1, 1).value = `${o.titre} — récapitulatif`;
  ws2.getCell(1, 1).font = { bold: true, size: 13, color: { argb: VERT } };
  ws2.mergeCells(2, 1, 2, nb2);
  ws2.getCell(2, 1).value =
    'Nombre d’enrôlés par département retenu et par diplôme (mêmes filtres que la première feuille).';
  ws2.getCell(2, 1).font = { size: 10, color: { argb: GRIS_TEXTE } };
  const t2 = ws2.getRow(4);
  ['Département retenu', ...diplomes, 'Total'].forEach((v, i) => {
    const c = t2.getCell(i + 1);
    c.value = v;
    c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    c.fill = plein(VERT);
    c.alignment = {
      vertical: 'middle',
      horizontal: i ? 'center' : 'left',
      wrapText: true,
    };
  });
  t2.height = 30;
  const compte = (dep: string | null, dip: string | null) =>
    lignes.filter(
      (l) =>
        (dep === null || (l.retenu ?? '') === dep) &&
        (dip === null || l.diplome === dip),
    ).length;
  deps.forEach((d, i) => {
    const r = ws2.getRow(5 + i);
    r.getCell(1).value = d || 'Sans département retenu';
    diplomes.forEach((dip, j) => {
      const n = compte(d, dip);
      r.getCell(j + 2).value = n || '';
    });
    r.getCell(nb2).value = compte(d, null);
    r.eachCell({ includeEmpty: true }, (c, k) => {
      c.font = {
        size: 10,
        bold: k === 1 || k === nb2,
        ...(d ? {} : { italic: true, color: { argb: ORANGE_FONCE } }),
      };
      c.alignment = { horizontal: k === 1 ? 'left' : 'center' };
      c.border = { bottom: { style: 'hair', color: { argb: 'FFD4D4D8' } } };
      if (!d) c.fill = plein(ORANGE);
      else if (i % 2) c.fill = plein(GRIS);
    });
  });
  const tot = ws2.getRow(5 + deps.length);
  tot.getCell(1).value = 'Total';
  diplomes.forEach((dip, j) => (tot.getCell(j + 2).value = compte(null, dip)));
  tot.getCell(nb2).value = lignes.length;
  tot.eachCell({ includeEmpty: true }, (c, k) => {
    c.font = { bold: true, size: 10, color: { argb: VERT } };
    c.fill = plein(VERT_CLAIR);
    c.alignment = { horizontal: k === 1 ? 'left' : 'center' };
    c.border = { top: { style: 'thin', color: { argb: VERT } } };
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}
