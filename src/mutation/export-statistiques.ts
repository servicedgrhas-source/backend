import ExcelJS from 'exceljs';

/**
 * Statistiques des mutations en Excel (07/11/2026) : la fiche officielle (cycle et spécialité ×
 * département, M = muté, R = reçu, E = écart) et une feuille par département (départs, arrivées,
 * solde), bien présentées.
 */

interface Stat {
  base: string;
  total: number;
  departements: { code: string; nom: string }[];
  lignes: {
    cycle: string;
    specialite: string | null;
    valeurs: Record<string, { M: number; R: number; E: number }>;
  }[];
}

const VERT = 'FF0B5D3B';
const VERT_CLAIR = 'FFE9F7EF';
const ROUGE_CLAIR = 'FFFDECEC';
const GRIS = 'FFF4F4F5';
const CYCLES: Record<string, string> = {
  ADMINISTRATION: 'ADMINISTRATION',
  PRESCOLAIRE: 'PRÉSCOLAIRE',
  PRIMAIRE: 'PRIMAIRE',
  ALPHABETISATION: 'ALPHABÉTISATION',
  COLLEGE: 'COLLÈGE',
  LYCEE: 'LYCÉE',
};
const SPECIALITES: Record<string, string> = {
  FRANCAIS: 'Français',
  ANGLAIS: 'Anglais',
  'HISTOIRE-GEO': 'Histoire-géographie',
  MATHS: 'Mathématiques',
  'PHYS-CHIMIE': 'Physique-chimie',
  SVT: 'SVT',
  DESSIN: 'Dessin / arts plastiques',
  MUSIQUE: 'Musique',
  EPS: 'EPS',
  PHILO: 'Philosophie',
  ESPAGNOL: 'Espagnol',
  RUSSE: 'Russe',
  CHINOIS: 'Chinois',
  ALLEMAND: 'Allemand',
  LATIN: 'Latin',
  AUTRES: 'Autres spécialités',
};

const bord = { style: 'thin' as const, color: { argb: 'FF9CA3AF' } };
const cadre = { top: bord, left: bord, bottom: bord, right: bord };

export async function classeurStatistiques(
  s: Stat,
  par: string,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SIGRHAS-MEPPSA';
  const libelleBase =
    s.base === 'accordees'
      ? 'Mutations accordées'
      : 'Toutes les demandes de mutation';
  const deps = s.departements;
  const nbCol = 2 + 3 * (deps.length + 1);

  /* ------------------------- Feuille 1 : fiche officielle ------------------------- */
  const ws = wb.addWorksheet('Fiche statistique', {
    pageSetup: {
      paperSize: 9,
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    },
    views: [{ state: 'frozen', xSplit: 2, ySplit: 6 }],
  });
  ws.mergeCells(1, 1, 1, nbCol);
  ws.getCell(1, 1).value = 'FICHE STATISTIQUE DES MUTATIONS';
  ws.getCell(1, 1).font = { bold: true, size: 15, color: { argb: VERT } };
  ws.getCell(1, 1).alignment = { horizontal: 'center' };
  ws.mergeCells(2, 1, 2, nbCol);
  ws.getCell(2, 1).value =
    `${libelleBase} : ${s.total} · éditée le ${new Date().toLocaleDateString('fr-FR')} par ${par}`;
  ws.getCell(2, 1).alignment = { horizontal: 'center' };
  ws.getCell(2, 1).font = { size: 10, color: { argb: 'FF52525B' } };
  ws.mergeCells(3, 1, 3, nbCol);
  ws.getCell(3, 1).value =
    'Légende : M = muté (départ) ; R = reçu (arrivée) ; E = écart (M − R)';
  ws.getCell(3, 1).alignment = { horizontal: 'center' };
  ws.getCell(3, 1).font = { size: 10, italic: true };

  // Titres sur deux lignes : département puis M / R / E
  const r5 = ws.getRow(5);
  const r6 = ws.getRow(6);
  const titre = (cell: ExcelJS.Cell, v: string) => {
    cell.value = v;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 9 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: VERT } };
    cell.alignment = {
      horizontal: 'center',
      vertical: 'middle',
      wrapText: true,
    };
    cell.border = cadre;
  };
  ws.mergeCells(5, 1, 6, 1);
  ws.mergeCells(5, 2, 6, 2);
  titre(r5.getCell(1), 'CYCLE');
  titre(r5.getCell(2), 'SPÉCIALITÉ');
  [...deps, { code: 'T', nom: 'TOTAL' }].forEach((d, i) => {
    const c = 3 + i * 3;
    ws.mergeCells(5, c, 5, c + 2);
    titre(r5.getCell(c), d.nom.toUpperCase());
    ['M', 'R', 'E'].forEach((k, j) => titre(r6.getCell(c + j), k));
  });
  r5.height = 30;

  const total = (l: Stat['lignes'][number], k: 'M' | 'R' | 'E') =>
    deps.reduce((t, d) => t + l.valeurs[d.code][k], 0);
  const somme = (ls: Stat['lignes'], code: string, k: 'M' | 'R' | 'E') =>
    ls.reduce(
      (t, l) => t + (code === 'T' ? total(l, k) : l.valeurs[code][k]),
      0,
    );
  const ecrireValeurs = (
    row: ExcelJS.Row,
    f: (code: string, k: 'M' | 'R' | 'E') => number,
    gras = false,
    fond?: string,
  ) => {
    [...deps.map((d) => d.code), 'T'].forEach((code, i) => {
      (['M', 'R', 'E'] as const).forEach((k, j) => {
        const cell = row.getCell(3 + i * 3 + j);
        const v = f(code, k);
        cell.value = v || (gras ? 0 : null);
        cell.alignment = { horizontal: 'center' };
        cell.border = cadre;
        cell.font = {
          size: 9,
          bold: gras || code === 'T',
          ...(k === 'E' && v > 0
            ? { color: { argb: 'FFB91C1C' } }
            : k === 'E' && v < 0
              ? { color: { argb: 'FF047857' } }
              : {}),
        };
        const couleur =
          fond ??
          (k === 'M' && v
            ? ROUGE_CLAIR
            : k === 'R' && v
              ? VERT_CLAIR
              : undefined);
        if (couleur)
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: couleur },
          };
      });
    });
  };
  let n = 7;
  const groupes: {
    titre: string;
    cycle?: string;
    lignes: Stat['lignes'];
    sousTotal?: string;
  }[] = [
    { titre: '', lignes: s.lignes.filter((l) => !l.specialite) },
    {
      titre: 'COLLÈGE',
      lignes: s.lignes.filter((l) => l.cycle === 'COLLEGE'),
      sousTotal: 'SOUS-TOTAL COLLÈGE',
    },
    {
      titre: 'LYCÉE',
      lignes: s.lignes.filter((l) => l.cycle === 'LYCEE'),
      sousTotal: 'SOUS-TOTAL LYCÉE',
    },
  ];
  for (const g of groupes) {
    const debut = n;
    for (const l of g.lignes) {
      const row = ws.getRow(n);
      const c1 = row.getCell(1);
      c1.value = g.titre || CYCLES[l.cycle] || l.cycle;
      c1.font = { bold: true, size: 9 };
      c1.alignment = { vertical: 'middle', horizontal: 'center' };
      c1.border = cadre;
      const c2 = row.getCell(2);
      c2.value = l.specialite
        ? (SPECIALITES[l.specialite] ?? l.specialite)
        : '';
      c2.font = { size: 9 };
      c2.border = cadre;
      ecrireValeurs(row, (code, k) =>
        code === 'T' ? total(l, k) : l.valeurs[code][k],
      );
      n++;
    }
    if (g.titre && g.lignes.length > 1) ws.mergeCells(debut, 1, n - 1, 1);
    if (g.sousTotal) {
      const row = ws.getRow(n);
      ws.mergeCells(n, 1, n, 2);
      row.getCell(1).value = g.sousTotal;
      row.getCell(1).font = { bold: true, size: 9 };
      row.getCell(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: GRIS },
      };
      row.getCell(1).border = cadre;
      ecrireValeurs(row, (code, k) => somme(g.lignes, code, k), true, GRIS);
      n++;
    }
  }
  const tg = ws.getRow(n);
  ws.mergeCells(n, 1, n, 2);
  tg.getCell(1).value = 'TOTAL GÉNÉRAL';
  tg.getCell(1).font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
  tg.getCell(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: VERT },
  };
  tg.getCell(1).border = cadre;
  ecrireValeurs(tg, (code, k) => somme(s.lignes, code, k), true, 'FFD1FAE5');
  ws.columns = [
    { width: 15 },
    { width: 22 },
    ...Array.from({ length: 3 * (deps.length + 1) }, () => ({ width: 5 })),
  ];

  /* ------------------------- Feuille 2 : par département ------------------------- */
  const ws2 = wb.addWorksheet('Par département', {
    views: [{ state: 'frozen', ySplit: 4 }],
  });
  ws2.columns = [{ width: 26 }, { width: 14 }, { width: 14 }, { width: 14 }];
  ws2.mergeCells(1, 1, 1, 4);
  ws2.getCell(1, 1).value = 'MOUVEMENTS PAR DÉPARTEMENT';
  ws2.getCell(1, 1).font = { bold: true, size: 14, color: { argb: VERT } };
  ws2.mergeCells(2, 1, 2, 4);
  ws2.getCell(2, 1).value =
    `${libelleBase} · solde = arrivées − départs (+ le département gagne des agents, − il en perd)`;
  ws2.getCell(2, 1).font = { size: 10, color: { argb: 'FF52525B' } };
  ws2.getCell(2, 1).alignment = { wrapText: true, vertical: 'top' };
  ws2.getRow(2).height = 30;
  const h = ws2.getRow(4);
  ['Département', 'Départs (M)', 'Arrivées (R)', 'Solde'].forEach((t, i) =>
    titre(h.getCell(i + 1), t),
  );
  const parDep = deps.map((d) => {
    const M = s.lignes.reduce((t, l) => t + l.valeurs[d.code].M, 0);
    const R = s.lignes.reduce((t, l) => t + l.valeurs[d.code].R, 0);
    return { nom: d.nom, M, R, solde: R - M };
  });
  const plusDemande = [...parDep].sort((a, b) => b.R - a.R)[0];
  const plusQuitte = [...parDep].sort((a, b) => b.M - a.M)[0];
  parDep.forEach((d, i) => {
    const row = ws2.getRow(5 + i);
    row.values = [d.nom, d.M, d.R, d.solde];
    row.eachCell((c, j) => {
      c.border = cadre;
      c.alignment = { horizontal: j === 1 ? 'left' : 'center' };
      if (i % 2)
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRIS } };
    });
    row.getCell(4).font = {
      bold: true,
      color: {
        argb: d.solde > 0 ? 'FF047857' : d.solde < 0 ? 'FFB91C1C' : 'FF71717A',
      },
    };
    if (d === plusDemande && d.R)
      row.getCell(3).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: VERT_CLAIR },
      };
    if (d === plusQuitte && d.M)
      row.getCell(2).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: ROUGE_CLAIR },
      };
  });
  const fin = ws2.getRow(5 + parDep.length);
  fin.values = [
    'TOTAL',
    parDep.reduce((t, d) => t + d.M, 0),
    parDep.reduce((t, d) => t + d.R, 0),
    '',
  ];
  fin.eachCell((c, j) => {
    c.font = { bold: true };
    c.border = cadre;
    c.alignment = { horizontal: j === 1 ? 'left' : 'center' };
  });
  const n2 = 7 + parDep.length;
  if (plusDemande?.R)
    ws2.getCell(n2, 1).value =
      `Le plus demandé : ${plusDemande.nom} (${plusDemande.R} arrivées)`;
  if (plusQuitte?.M)
    ws2.getCell(n2 + 1, 1).value =
      `Le plus quitté : ${plusQuitte.nom} (${plusQuitte.M} départs)`;

  return Buffer.from(await wb.xlsx.writeBuffer());
}
