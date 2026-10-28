import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Packer,
  PageNumber,
  Paragraph,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  Tab,
  TabStopType,
  VerticalAlign,
  VerticalMergeType,
  WidthType,
  type ParagraphChild,
} from 'docx';
import { dateEnLettres } from '../common/texte';
import type { ContenuNote, Entete } from './notes.service';

/**
 * La note de service au format Word (réunion DG du 26/10/2026) : la même mise en page que la
 * version imprimée, mais modifiable (espacer, faire descendre un tableau, retoucher un mot).
 * Le bloc de signature est lié à la dernière ligne du tableau : Word ne le laisse jamais seul
 * sur une page.
 */
export interface NoteWord {
  numero: string | null;
  dateSignature: string | null;
  anneeScolaire: string;
  contenu: ContenuNote;
  entete: Entete;
}

/** Largeur des colonnes (mm), comme la version imprimée ; le nom prend la place restante. */
const LARGEUR: Record<string, number> = {
  n: 7,
  grade: 16,
  cat: 8,
  ech: 8,
  echl: 9,
  reference: 31,
  cycle: 19,
  specialite: 21,
  etablissement: 26,
  structure: 26,
  obs: 16,
  ge: 13,
  matricule: 18,
  ancienPoste: 25,
  nouveauPoste: 25,
  vague: 11,
  origine: 19,
  naissance: 20,
  lieu: 22,
  promotion: 15,
  accueil: 19,
};
const MM = 56.7; // twips par millimètre
const MARGE = 16; // mm, comme la version imprimée
const LARGEUR_UTILE = 210 - 2 * MARGE;
const POLICE = 'Times New Roman';
const SANS_BORD = {
  top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  insideVertical: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
};

/** Texte en points (Word compte en demi-points). */
const t = (
  texte: string,
  o: { gras?: boolean; taille?: number; souligne?: boolean } = {},
) =>
  new TextRun({
    text: texte,
    bold: o.gras,
    size: Math.round((o.taille ?? 11) * 2),
    font: POLICE,
    underline: o.souligne ? {} : undefined,
  });

const p = (
  enfants: ParagraphChild[] | string,
  o: {
    centre?: boolean;
    droite?: boolean;
    justifie?: boolean;
    avant?: number;
    apres?: number;
    garderAvecSuivant?: boolean;
    gras?: boolean;
    taille?: number;
    /** Taquet de tabulation (mm) : aligne la deuxième colonne (ampliations). */
    taquet?: number;
  } = {},
) =>
  new Paragraph({
    children:
      typeof enfants === 'string'
        ? [t(enfants, { gras: o.gras, taille: o.taille })]
        : enfants,
    alignment: o.centre
      ? AlignmentType.CENTER
      : o.droite
        ? AlignmentType.RIGHT
        : o.justifie
          ? AlignmentType.JUSTIFIED
          : AlignmentType.LEFT,
    spacing: { before: (o.avant ?? 0) * 20, after: (o.apres ?? 0) * 20 },
    keepNext: o.garderAvecSuivant,
    tabStops: o.taquet
      ? [{ type: TabStopType.LEFT, position: Math.round(o.taquet * MM) }]
      : undefined,
  });

const cellule = (
  texte: string,
  o: {
    gras?: boolean;
    centre?: boolean;
    /** Cellule sur deux lignes d'en-tête : « debut » en haut, « suite » dessous. */
    fusion?: 'debut' | 'suite';
    colonnes?: number;
    garder?: boolean;
  } = {},
) =>
  new TableCell({
    children: [
      p(texte, {
        gras: o.gras,
        taille: 10,
        centre: o.centre,
        garderAvecSuivant: o.garder,
      }),
    ],
    verticalMerge:
      o.fusion === 'debut'
        ? VerticalMergeType.RESTART
        : o.fusion === 'suite'
          ? VerticalMergeType.CONTINUE
          : undefined,
    columnSpan: o.colonnes,
    verticalAlign: VerticalAlign.CENTER,
    margins: { left: 60, right: 60, top: 20, bottom: 20 },
  });

export async function noteWord(n: NoteWord): Promise<Buffer> {
  const c = n.contenu;
  const e = n.entete;
  const avecGrade = c.colonnes.some((x) => x.cle === 'grade');
  const refCol = c.colonnes.find((x) => x.cle === 'reference');
  const autres = c.colonnes.filter(
    (x) => !['nom', 'grade', 'reference'].includes(x.cle),
  );
  const colsMutation = c.colonnes.filter((x) => x.cle !== 'nom');
  const cles = c.classification
    ? [
        'n',
        'nom',
        ...(avecGrade ? ['grade'] : []),
        'cat',
        'ech',
        'echl',
        ...(refCol ? ['reference'] : []),
        ...autres.map((x) => x.cle),
      ]
    : ['n', 'nom', ...colsMutation.map((x) => x.cle)];
  const fixes = cles
    .filter((k) => k !== 'nom')
    .reduce((s, k) => s + (LARGEUR[k] ?? 20), 0);
  const largeurs = cles.map((k) =>
    Math.round(
      (k === 'nom' ? Math.max(30, LARGEUR_UTILE - fixes) : (LARGEUR[k] ?? 20)) *
        MM,
    ),
  );

  /** En-tête du tableau, répété en haut de chaque page par Word. */
  const entete: TableRow[] = c.classification
    ? [
        new TableRow({
          tableHeader: true,
          cantSplit: true,
          children: [
            cellule('N°', { gras: true, centre: true, fusion: 'debut' }),
            cellule('Noms et prénoms', {
              gras: true,
              centre: true,
              fusion: 'debut',
            }),
            ...(avecGrade
              ? [
                  cellule('Grade', {
                    gras: true,
                    centre: true,
                    fusion: 'debut',
                  }),
                ]
              : []),
            cellule('Classification', {
              gras: true,
              centre: true,
              colonnes: 3,
            }),
            ...(refCol
              ? [
                  cellule(refCol.libelle, {
                    gras: true,
                    centre: true,
                    fusion: 'debut',
                  }),
                ]
              : []),
            ...autres.map((x) =>
              cellule(x.libelle, { gras: true, centre: true, fusion: 'debut' }),
            ),
          ],
        }),
        new TableRow({
          tableHeader: true,
          cantSplit: true,
          children: [
            cellule('', { fusion: 'suite' }),
            cellule('', { fusion: 'suite' }),
            ...(avecGrade ? [cellule('', { fusion: 'suite' })] : []),
            ...['Cat', 'Ech', 'Echl'].map((x) =>
              cellule(x, { gras: true, centre: true }),
            ),
            ...(refCol ? [cellule('', { fusion: 'suite' })] : []),
            ...autres.map(() => cellule('', { fusion: 'suite' })),
          ],
        }),
      ]
    : [
        new TableRow({
          tableHeader: true,
          cantSplit: true,
          children: [
            cellule('N°', { gras: true, centre: true }),
            cellule('Noms et prénoms', { gras: true, centre: true }),
            ...colsMutation.map((x) =>
              cellule(x.libelle, { gras: true, centre: true }),
            ),
          ],
        }),
      ];

  const corps: (Paragraph | Table)[] = [];
  const sep = () => p('-----------------', { centre: true, taille: 10 });
  // En-tête officiel : le ministère à gauche, la République à droite
  corps.push(
    p(`${new Date().toLocaleDateString('fr-FR')}/${c.repere}`, {
      centre: true,
      taille: 8,
    }),
    new Table({
      layout: TableLayoutType.FIXED,
      width: { size: Math.round(LARGEUR_UTILE * MM), type: WidthType.DXA },
      columnWidths: [
        Math.round(LARGEUR_UTILE * 0.6 * MM),
        Math.round(LARGEUR_UTILE * 0.4 * MM),
      ],
      borders: SANS_BORD,
      rows: [
        new TableRow({
          children: [
            new TableCell({
              children: [
                p('MINISTERE DE L’ENSEIGNEMENT PRESCOLAIRE,', {
                  centre: true,
                  gras: true,
                  taille: 10,
                }),
                p('PRIMAIRE, SECONDAIRE ET DE L’ALPHABETISATION', {
                  centre: true,
                  gras: true,
                  taille: 10,
                }),
                sep(),
                p('CABINET', { centre: true, gras: true, taille: 10 }),
                sep(),
                p('DIRECTION GENERALE DES RESSOURCES HUMAINES', {
                  centre: true,
                  gras: true,
                  taille: 10,
                }),
                p('ET DE L’ADMINISTRATION SCOLAIRE', {
                  centre: true,
                  gras: true,
                  taille: 10,
                }),
                sep(),
                p('DIRECTION DES RECRUTEMENTS', {
                  centre: true,
                  gras: true,
                  taille: 10,
                }),
                p('ET DU SUIVI DES CARRIERES', {
                  centre: true,
                  gras: true,
                  taille: 10,
                }),
                sep(),
                p(
                  `N°${n.numero ? ` ${n.numero}` : '__________'}/${e.reference}`,
                  {
                    centre: true,
                    gras: true,
                    taille: 10,
                  },
                ),
              ],
            }),
            new TableCell({
              children: [
                p('REPUBLIQUE DU CONGO', {
                  centre: true,
                  gras: true,
                  taille: 10,
                }),
                p('Unité-Travail-Progrès', { centre: true, taille: 9.5 }),
                sep(),
              ],
            }),
          ],
        }),
      ],
    }),
    p(c.titre, { centre: true, gras: true, taille: 16, avant: 14, apres: 8 }),
  );
  // Introduction : l'année scolaire en gras, comme la version imprimée
  const morceaux = c.introduction.split(n.anneeScolaire);
  corps.push(
    p(
      morceaux.flatMap((m, i) =>
        i > 0 ? [t(n.anneeScolaire, { gras: true }), t(m)] : [t(m)],
      ),
      { justifie: true, apres: 6, garderAvecSuivant: true },
    ),
  );

  c.sections.forEach((s, i) => {
    const derniere = i === c.sections.length - 1;
    if (s.titre)
      corps.push(
        p(s.titre, {
          gras: true,
          avant: 10,
          apres: 2,
          garderAvecSuivant: true,
        }),
      );
    if (s.sousTitre)
      corps.push(
        p(`      ${s.sousTitre}`, {
          gras: true,
          apres: 2,
          garderAvecSuivant: true,
        }),
      );
    corps.push(
      new Table({
        layout: TableLayoutType.FIXED,
        width: {
          size: largeurs.reduce((a, b) => a + b, 0),
          type: WidthType.DXA,
        },
        columnWidths: largeurs,
        rows: [
          ...entete,
          ...s.lignes.map(
            (l, k) =>
              new TableRow({
                cantSplit: true,
                children: cles.map((cle) =>
                  cellule(String(l[cle] ?? ''), {
                    centre: cle !== 'nom' && cle !== 'ancienPoste',
                    // La dernière ligne de la note reste avec la signature
                    garder: derniere && k === s.lignes.length - 1,
                  }),
                ),
              }),
          ),
        ],
      }),
    );
  });

  // Mentions et signature : liées entre elles (et à la dernière ligne du tableau)
  for (const m of c.mentions)
    corps.push(p(m, { justifie: true, avant: 6, garderAvecSuivant: true }));
  const moitie = Math.round(LARGEUR_UTILE * 0.5 * MM);
  corps.push(
    new Table({
      layout: TableLayoutType.FIXED,
      width: { size: moitie * 2, type: WidthType.DXA },
      columnWidths: [moitie, moitie],
      borders: SANS_BORD,
      rows: [
        new TableRow({
          cantSplit: true,
          children: [
            new TableCell({ children: [p('')] }),
            new TableCell({
              children: [
                p(
                  `Fait à ${e.lieu}, le ${dateEnLettres(n.dateSignature) ?? '________________'}`,
                  { avant: 14, garderAvecSuivant: true },
                ),
                p(e.signataireTitre, {
                  avant: 4,
                  apres: 60,
                  garderAvecSuivant: true,
                }),
              ],
            }),
          ],
        }),
        new TableRow({
          cantSplit: true,
          children: [
            new TableCell({
              children: [
                p([
                  t('Ampliations :', {
                    gras: true,
                    souligne: true,
                    taille: 10,
                  }),
                ]),
                ...c.ampliations.map((a) =>
                  p(
                    [
                      t(a.libelle, { taille: 9 }),
                      new TextRun({
                        children: [new Tab(), a.nombre],
                        size: 18,
                        font: POLICE,
                      }),
                    ],
                    { taquet: 42 },
                  ),
                ),
              ],
            }),
            new TableCell({
              children: [p(e.signataireNom, { gras: true })],
              verticalAlign: VerticalAlign.TOP,
            }),
          ],
        }),
      ],
    }),
  );

  const doc = new Document({
    creator: 'DGRHAS',
    title: c.titre,
    styles: {
      default: { document: { run: { font: POLICE, size: 22 } } },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: Math.round(210 * MM), height: Math.round(297 * MM) },
            margin: {
              top: Math.round(12 * MM),
              bottom: Math.round(20 * MM),
              left: Math.round(MARGE * MM),
              right: Math.round(MARGE * MM),
            },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Table({
                layout: TableLayoutType.FIXED,
                width: {
                  size: Math.round(LARGEUR_UTILE * MM),
                  type: WidthType.DXA,
                },
                columnWidths: [1, 1, 1].map(() =>
                  Math.round((LARGEUR_UTILE / 3) * MM),
                ),
                borders: SANS_BORD,
                rows: [
                  new TableRow({
                    children: [
                      new TableCell({
                        children: [p(c.piedDePage, { taille: 8 })],
                      }),
                      new TableCell({
                        children: [
                          p(
                            [
                              new TextRun({
                                children: [
                                  'Page ',
                                  PageNumber.CURRENT,
                                  ' sur ',
                                  PageNumber.TOTAL_PAGES,
                                ],
                                size: 16,
                                font: POLICE,
                              }),
                            ],
                            { centre: true },
                          ),
                        ],
                      }),
                      new TableCell({
                        children: [
                          p(e.piedDroite, { droite: true, taille: 8 }),
                        ],
                      }),
                    ],
                  }),
                ],
              }),
            ],
          }),
        },
        children: corps,
      },
    ],
  });
  return Packer.toBuffer(doc);
}
