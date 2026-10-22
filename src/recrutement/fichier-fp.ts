import { repereLot } from '../common/lots';
import ExcelJS from 'exceljs';
import {
  estContractuel,
  salaireBrut,
  type ParametresCalcul,
} from '../affectation/calcul';
import type { Agent, RegleDiplome } from '../entities';

/**
 * Base au format de la « Fiche de suivi Recrutement » : bloc COMMISSION,
 * bloc RETOUR F.P (rempli par la Fonction Publique), bloc INCIDENCE FINANCIÈRE
 * et, pour la DGRHAS seulement, les informations internes. Le fichier peut être
 * réimporté dans la base des recrutés (mêmes intitulés de colonnes).
 */
interface Colonne {
  titre: string;
  largeur: number;
  valeur: (a: Agent, x: Calculs) => ExcelJS.CellValue;
  format?: string;
}

interface Calculs {
  regle: RegleDiplome | undefined;
  contractuel: boolean | null;
  salaire: number | null;
  point: number;
}

interface Bloc {
  titre: string;
  couleur: string;
  colonnes: Colonne[];
}

const MONTANT = '#,##0';

function dateExcel(iso: string | null) {
  if (!iso) return null;
  const [a, m, j] = iso.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, j));
}

function blocs(interne: boolean, budget: boolean): Bloc[] {
  const liste: Bloc[] = [
    {
      titre: 'COMMISSION ',
      couleur: 'FFE2EFDA',
      colonnes: [
        { titre: 'Quota', largeur: 7, valeur: (a) => a.quota },
        { titre: "N° d'ordre", largeur: 8, valeur: (a) => a.numeroOrdre },
        { titre: 'N°/ Liste', largeur: 7, valeur: (a) => a.numeroListe },
        { titre: ' Noms et prénoms', largeur: 32, valeur: (a) => a.nomComplet },
        {
          titre: 'Date de nais.',
          largeur: 11,
          valeur: (a) => dateExcel(a.dateNaissance) ?? a.dateNaissanceBrute,
          format: 'dd/mm/yyyy',
        },
        { titre: 'Lieu de nais.', largeur: 14, valeur: (a) => a.lieuNaissance },
        {
          titre: 'Diplôme',
          largeur: 13,
          valeur: (a, x) => x.regle?.libelle ?? a.diplomeBrut,
        },
        {
          titre: 'Département',
          largeur: 14,
          valeur: (a) => a.departement?.nom ?? a.departementBrut,
        },
        { titre: 'Source', largeur: 9, valeur: (a) => a.source },
        { titre: 'Cycle', largeur: 12, valeur: (a) => a.cycleBrut },
        { titre: 'Lot', largeur: 9, valeur: (a) => a.lotCommission },
        { titre: 'Statut', largeur: 13, valeur: (a) => a.statut },
        { titre: 'Transmission', largeur: 15, valeur: (a) => a.transmission },
        {
          titre: 'Lieu de service',
          largeur: 18,
          valeur: (a) => a.lieuServiceBrut,
        },
      ],
    },
  ];
  // Budget (salaires, incidences) : réservé au DG
  if (budget)
    liste.push({
      titre: 'INCIDENCE FINANCIÈRE',
      couleur: 'FFDDEBF7',
      colonnes: [
        {
          titre: 'Situation',
          largeur: 12,
          valeur: (_, x) =>
            x.contractuel === null
              ? null
              : x.contractuel
                ? 'Contractuel'
                : 'Fonctionnaire',
        },
        {
          titre: 'Catégorie',
          largeur: 8,
          valeur: (_, x) => x.regle?.categorie ?? null,
        },
        {
          titre: 'Échelle',
          largeur: 7,
          valeur: (_, x) => x.regle?.echelle ?? null,
        },
        {
          titre: 'Échelon',
          largeur: 7,
          valeur: (_, x) => x.regle?.echelon ?? null,
        },
        {
          titre: 'Indice',
          largeur: 7,
          valeur: (_, x) => x.regle?.indice ?? null,
        },
        { titre: 'Point indiciaire', largeur: 9, valeur: (_, x) => x.point },
        {
          titre: 'Salaire brut (mensuel)',
          largeur: 13,
          valeur: (_, x) => x.salaire,
          format: MONTANT,
        },
        {
          titre: 'Incidence annuelle',
          largeur: 14,
          valeur: (_, x) => (x.salaire === null ? null : x.salaire * 12),
          format: MONTANT,
        },
      ],
    });
  // Ordre demandé par le DG : commission, incidence financière, retour FP, puis DGRHAS (interne)
  liste.push({
    titre: 'RETOUR FONCTION PUBLIQUE',
    couleur: 'FFFFF2CC',
    colonnes: [
      { titre: 'N° Para-pheur', largeur: 9, valeur: (a) => a.parapheur },
      {
        titre: 'Type de texte',
        largeur: 9,
        valeur: (a) =>
          a.typeTexte === 'DECRET'
            ? 'Décret'
            : a.typeTexte === 'ARRETE'
              ? 'Arrêté'
              : null,
      },
      { titre: 'N° Texte', largeur: 10, valeur: (a) => a.numeroTexte },
      {
        titre: 'Date de réception',
        largeur: 11,
        valeur: (a) => dateExcel(a.dateReception),
        format: 'dd/mm/yyyy',
      },
      {
        titre: 'Lot de réception',
        largeur: 14,
        valeur: (a) => (a.lotPublication ? repereLot(a.lotPublication) : null),
      },
    ],
  });
  if (interne)
    liste.push({
      titre: 'DGRHAS (interne)',
      couleur: 'FFEDEDED',
      colonnes: [
        {
          titre: 'Origine du dossier',
          largeur: 22,
          valeur: (a) => a.origineBrute,
        },
        { titre: 'Observation', largeur: 22, valeur: (a) => a.observation },
        {
          titre: 'Fiche corrigée après envoi',
          largeur: 10,
          valeur: (a) => (a.rectifiee ? 'Oui' : null),
        },
      ],
    });
  return liste;
}

export async function fichierBase(o: {
  fiches: Agent[];
  regles: Map<string, RegleDiplome>;
  parametres: ParametresCalcul;
  campagne: string;
  titre: string;
  interne: boolean;
  /** Bloc INCIDENCE FINANCIÈRE et ligne TOTAL (réservés au DG). */
  budget: boolean;
}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'DGRHAS';
  const ws = wb.addWorksheet(
    o.titre.slice(0, 31).replace(/[\\/?*[\]:]/g, '-'),
    {
      pageSetup: {
        orientation: 'landscape',
        paperSize: 9,
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        margins: {
          left: 0.3,
          right: 0.3,
          top: 0.4,
          bottom: 0.4,
          header: 0.2,
          footer: 0.2,
        },
        printTitlesRow: '17:17',
      },
    },
  );
  const bs = blocs(o.interne, o.budget);
  const colonnes: Colonne[] = [
    { titre: 'N°', largeur: 6, valeur: () => null },
    ...bs.flatMap((b) => b.colonnes),
  ];
  ws.columns = colonnes.map((c) => ({ width: c.largeur }));

  const gauche = [
    "MINISTERE DE L'ENSEIGNEMENT PRESCOLAIRE, PRIMAIRE,",
    "   SECONDAIRE ET DE L'ALPHABETISATION",
    '-------------------',
    'CABINET',
    '-------------------',
    'DIRECTION GENERALE DES RESSOURCES HUMAINES',
    "ET DE L'ADMINISTRATION SCOLAIRE",
    '-------------------',
    'DIRECTION DES RECRUTEMENTS ET DU SUIVI DES CARRIERES',
    '-------------------',
  ];
  gauche.forEach((t, i) => {
    const c = ws.getCell(i + 1, 1);
    c.value = t;
    c.font = { bold: true, size: 9 };
  });
  ['REPUBLIQUE DU CONGO', 'Unité-Travail-Progrès', '---------'].forEach(
    (t, i) => {
      const c = ws.getCell(i + 1, 16);
      c.value = t;
      c.font = { bold: i === 0, italic: i === 1, size: 9 };
    },
  );
  const titre = (ligne: number, texte: string, taille: number) => {
    ws.mergeCells(ligne, 2, ligne, 15);
    const c = ws.getCell(ligne, 2);
    c.value = texte;
    c.font = { bold: true, size: taille, underline: ligne === 14 };
    c.alignment = { horizontal: 'center' };
  };
  titre(12, `RECRUTEMENT ${o.campagne}`, 12);
  titre(
    14,
    `LISTE GENERALE DES CANDIDATS SELECTIONNES DU MEPPSA — ${o.titre.toUpperCase()}`,
    11,
  );

  let col = 2;
  for (const [i, b] of bs.entries()) {
    const de = i === 0 ? 1 : col;
    const a = col + b.colonnes.length - 1;
    ws.mergeCells(16, de, 16, a);
    const c = ws.getCell(16, de);
    c.value = b.titre;
    c.font = { bold: true, size: 10 };
    c.alignment = { horizontal: 'center' };
    c.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: b.couleur },
    };
    col = a + 1;
  }
  // Toutes les cases de la ligne des blocs encadrées (y compris la ligne supérieure)
  for (let n = 1; n < col; n++)
    ws.getCell(16, n).border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' },
    };

  const bord: Partial<ExcelJS.Borders> = {
    top: { style: 'thin' },
    left: { style: 'thin' },
    bottom: { style: 'thin' },
    right: { style: 'thin' },
  };
  const couleurColonne = colonnes.map((_, i) => {
    if (i === 0) return bs[0].couleur;
    let n = 1;
    for (const b of bs) {
      if (i < n + b.colonnes.length) return b.couleur;
      n += b.colonnes.length;
    }
    return 'FFFFFFFF';
  });
  const entete = ws.getRow(17);
  colonnes.forEach((c, i) => {
    const cell = entete.getCell(i + 1);
    cell.value = c.titre;
    cell.font = { bold: true, size: 9 };
    cell.alignment = {
      horizontal: 'center',
      vertical: 'middle',
      wrapText: true,
    };
    cell.border = bord;
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: couleurColonne[i] },
    };
  });
  entete.height = 32;

  let total = 0;
  o.fiches.forEach((a, i) => {
    const regle = a.diplomeCode ? o.regles.get(a.diplomeCode) : undefined;
    const { contractuel } = estContractuel(a, o.parametres, regle?.categorie);
    const salaire = salaireBrut(regle?.indice, o.parametres);
    if (salaire) total += salaire * 12;
    const x: Calculs = {
      regle,
      contractuel,
      salaire,
      point: o.parametres.pointIndiciaire,
    };
    const ligne = ws.addRow(
      colonnes.map((c, k) => (k === 0 ? i + 1 : c.valeur(a, x))),
    );
    ligne.eachCell({ includeEmpty: true }, (cell, n) => {
      if (n > colonnes.length) return;
      cell.border = bord;
      cell.font = { size: 9 };
      cell.alignment = { vertical: 'middle', wrapText: n === 5 };
      const f = colonnes[n - 1].format;
      if (f) cell.numFmt = f;
    });
  });
  // Total des incidences annuelles : c'est lui qui doit rester dans l'enveloppe
  const ligneTotal = ws.addRow([]);
  if (o.budget) {
    const iTotal =
      colonnes.findIndex((c) => c.titre === 'Incidence annuelle') + 1;
    ligneTotal.getCell(iTotal - 1).value = 'TOTAL';
    ligneTotal.getCell(iTotal).value = total;
    ligneTotal.getCell(iTotal).numFmt = MONTANT;
    [iTotal - 1, iTotal].forEach((n) => {
      const c = ligneTotal.getCell(n);
      c.font = { bold: true, size: 10 };
      c.border = bord;
    });
  }
  ligneTotal.getCell(5).value = `${o.fiches.length} candidat(s)`;
  ligneTotal.getCell(5).font = { bold: true, size: 10 };

  return Buffer.from(await wb.xlsx.writeBuffer());
}
