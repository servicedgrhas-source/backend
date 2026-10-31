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
  /** Avis de conformité (bureau, service, direction) et validation du DG : les visas de l'en-tête. */
  conformite?: { niveau: string; par: string; le: string; conforme: boolean }[];
  valideePar?: string | null;
}

/** « Jean Paul MOUKOKO » → « JPM » */
const initiales = (nom: string) =>
  nom
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((m) => m[0].toUpperCase())
    .join('')
    .slice(0, 3);

/**
 * Spécimen de visa à droite d'une ligne de l'en-tête (DG, 30/10/2026), un tracé par responsable :
 * le service (initiales soulignées d'une vague), la direction (initiales et flèche), la direction
 * générale (trait, initiales et point). Provisoire, en attendant les vrais spécimens.
 */
function runVisa(style: 'SERVICE' | 'DIRECTION' | 'DG', nom: string) {
  const ini = initiales(nom);
  const encre = '1E3A8A';
  const ecriture = (t: string) =>
    new TextRun({
      text: t,
      font: 'Segoe Script',
      size: 22,
      color: encre,
      italics: true,
    });
  const signe = (t: string) =>
    new TextRun({ text: t, font: POLICE, size: 22, color: encre, bold: true });
  if (style === 'SERVICE') return [signe('   '), ecriture(ini), signe(' ~~')];
  if (style === 'DIRECTION') return [signe('   '), ecriture(ini), signe(' ↗')];
  return [signe('   / '), ecriture(ini), signe(' •')];
}

/** Largeur des colonnes (mm), comme la version imprimée ; le nom prend la place restante. */
const LARGEUR: Record<string, number> = {
  n: 7,
  grade: 16,
  cat: 8,
  ech: 9,
  echl: 10,
  reference: 31,
  cycle: 19,
  specialite: 21,
  etablissement: 26,
  structure: 26,
  obs: 16,
  ge: 13,
  matricule: 18,
  ancienPoste: 34,
  nouveauPoste: 34,
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
/**
 * « Fait à », le titre et le nom du signataire poussés de deux tabulations vers la droite
 * (DG, 31/10/2026), moins si la plus longue des trois lignes ne tiendrait plus avant la marge.
 */
const SIGNATURE_RETRAIT = 25;
/** Marges intérieures d'une cellule de tableau Word (mm, gauche + droite). */
const MARGES_CELLULE = 3.8;

/** Largeurs des caractères de Times New Roman (millièmes de corps), pour estimer une ligne. */
const LARGEURS_TIMES: Record<string, number> = {
  ' ': 250,
  ',': 250,
  '.': 250,
  '-': 333,
  "'": 333,
  '’': 333,
  a: 444,
  b: 500,
  c: 444,
  d: 500,
  e: 444,
  f: 333,
  g: 500,
  h: 500,
  i: 278,
  j: 278,
  k: 500,
  l: 278,
  m: 778,
  n: 500,
  o: 500,
  p: 500,
  q: 500,
  r: 333,
  s: 389,
  t: 278,
  u: 500,
  v: 500,
  w: 722,
  x: 500,
  y: 500,
  z: 444,
  A: 722,
  B: 667,
  C: 667,
  D: 722,
  E: 611,
  F: 556,
  G: 722,
  H: 722,
  I: 333,
  J: 389,
  K: 722,
  L: 611,
  M: 889,
  N: 722,
  O: 722,
  P: 556,
  Q: 722,
  R: 667,
  S: 556,
  T: 611,
  U: 722,
  V: 722,
  W: 944,
  X: 722,
  Y: 722,
  Z: 611,
};

/** Largeur estimée d'une ligne en Times New Roman (mm). */
function largeurLigne(texte: string, taille = 11, gras = false) {
  let unites = 0;
  for (const ch of texte) {
    const base = ch.normalize('NFD')[0];
    unites += LARGEURS_TIMES[base] ?? (/\d/.test(base) ? 500 : 556);
  }
  // Le gras est un peu plus large
  return ((unites / 1000) * taille * (gras ? 1.06 : 1) * 25.4) / 72;
}
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
    /** Retrait à gauche (mm). */
    retrait?: number;
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
    indent: o.retrait ? { left: Math.round(o.retrait * MM) } : undefined,
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
    /** Marges réduites : « Ech », « Echl » tiennent sur une ligne (DG, 31/10/2026). */
    serre?: boolean;
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
    margins: o.serre
      ? { left: 15, right: 15, top: 20, bottom: 20 }
      : { left: 60, right: 60, top: 20, bottom: 20 },
  });

export async function noteWord(n: NoteWord, avecVisas = true): Promise<Buffer> {
  const c = n.contenu;
  const e = n.entete;
  // Visas de l'en-tête : service (chef de service, sinon de bureau), direction, direction générale
  const avis = (niv: string) =>
    (n.conformite ?? []).find((x) => x.niveau === niv && x.conforme)?.par ??
    null;
  const visa = {
    SERVICE: avecVisas ? (avis('SERVICE') ?? avis('BUREAU')) : null,
    DIRECTION: avecVisas ? avis('DIRECTION') : null,
    DG: avecVisas ? (n.valideePar ?? null) : null,
  };
  /** Une ligne de l'en-tête, avec le visa de son responsable juste à droite. */
  const ligneVisa = (
    t: string,
    style: 'SERVICE' | 'DIRECTION' | 'DG',
  ): Paragraph =>
    visa[style]
      ? p(
          [
            new TextRun({ text: t, font: POLICE, size: 20, bold: true }),
            ...runVisa(style, visa[style]),
          ],
          { centre: true },
        )
      : p(t, { centre: true, gras: true, taille: 10 });
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
  // Spécialité : assez large pour son plus long mot, jamais coupé au milieu (« Mathématiques »,
  // DG 31/10/2026) ; « Histoire-Géographie » passe à la ligne après le trait d'union
  let motSpecialite = 0;
  for (const s of c.sections)
    for (const l of s.lignes)
      for (const mot of String(l.specialite ?? '').split(/\s+/))
        for (const morceau of mot.match(/[^-]+-?|-/g) ?? [])
          motSpecialite = Math.max(motSpecialite, largeurLigne(morceau, 10));
  const largeur = (k: string) =>
    k === 'specialite'
      ? Math.min(36, Math.max(LARGEUR.specialite, Math.ceil(motSpecialite + 3)))
      : (LARGEUR[k] ?? 20);
  const fixes = cles
    .filter((k) => k !== 'nom')
    .reduce((s, k) => s + largeur(k), 0);
  const largeurs = cles.map((k) =>
    Math.round(
      (k === 'nom' ? Math.max(30, LARGEUR_UTILE - fixes) : largeur(k)) * MM,
    ),
  );

  /**
   * En-tête du tableau, écrit une seule fois au début : quand le tableau continue sur la page
   * suivante, la liste reprend directement au numéro suivant (DG, 31/10/2026).
   */
  const entete: TableRow[] = c.classification
    ? [
        new TableRow({
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
          cantSplit: true,
          children: [
            cellule('', { fusion: 'suite' }),
            cellule('', { fusion: 'suite' }),
            ...(avecGrade ? [cellule('', { fusion: 'suite' })] : []),
            ...['Cat', 'Ech', 'Echl'].map((x) =>
              cellule(x, { gras: true, centre: true, serre: true }),
            ),
            ...(refCol ? [cellule('', { fusion: 'suite' })] : []),
            ...autres.map(() => cellule('', { fusion: 'suite' })),
          ],
        }),
      ]
    : [
        new TableRow({
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
      // Pas collé à l'en-tête (DG, 31/10/2026)
      apres: 10,
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
                ligneVisa('ET DE L’ADMINISTRATION SCOLAIRE', 'DG'),
                sep(),
                p('DIRECTION DES RECRUTEMENTS', {
                  centre: true,
                  gras: true,
                  taille: 10,
                }),
                ligneVisa('ET DU SUIVI DES CARRIERES', 'DIRECTION'),
                sep(),
                // Le service suit le numéro : « …-DRSC-SR » (une note signée avant garde son en-tête)
                ...(/-SR$/.test(e.reference)
                  ? [ligneVisa('SERVICE DES RECRUTEMENTS', 'SERVICE'), sep()]
                  : []),
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
  // Une ligne vide entre la fin du tableau et les mentions (DG, 31/10/2026)
  c.mentions.forEach((m, i) =>
    corps.push(
      p(m, { justifie: true, avant: i ? 6 : 20, garderAvecSuivant: true }),
    ),
  );
  const moitie = Math.round(LARGEUR_UTILE * 0.5 * MM);
  const faitA = `Fait à ${e.lieu}, le${n.dateSignature ? ` ${dateEnLettres(n.dateSignature) ?? ''}` : ''}`;
  // Aussi à droite que possible, sans que la plus longue ligne passe à la ligne
  const plusLongue = Math.max(
    largeurLigne(faitA),
    largeurLigne(e.signataireTitre),
    largeurLigne(e.signataireNom, 11, true),
  );
  const retrait = Math.max(
    0,
    Math.min(
      SIGNATURE_RETRAIT,
      LARGEUR_UTILE * 0.5 - MARGES_CELLULE - plusLongue - 2,
    ),
  );
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
                // Sans date : « le » seul, la date est écrite à la main (DG, 31/10/2026)
                p(faitA, { avant: 14, garderAvecSuivant: true, retrait }),
                p(e.signataireTitre, {
                  retrait,
                  // Un peu d'espace sous « Fait à » (DG, 31/10/2026)
                  avant: 10,
                  // Deux lignes de plus avant le nom du signataire (DG, 31/10/2026)
                  apres: 88,
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
              children: [p(e.signataireNom, { gras: true, retrait })],
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
