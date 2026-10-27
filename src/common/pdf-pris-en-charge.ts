/**
 * Lecture du PDF « Liste des agents pris en charge » de la Solde (réunion DG du 26/10/2026) :
 * les agents qui touchent leur salaire pour la première fois. Chaque page a une ligne de titres
 * (NOM, PRENOM, MATRI., DATE NAIS., MDR, REF. TEXTE, GRADE, INDICE, OP. SAISIE, OP. VALIDATION,
 * NET A PAY) ; chaque agent est une ligne qui porte un matricule, rangée sous un « Service : … ».
 * Les colonnes sont retrouvées d'après la position des titres, page par page.
 */
export interface LignePriseEnCharge {
  nom: string;
  prenom: string;
  matricule: string;
  dateNaissance: string | null;
  mdr: string | null;
  referenceTexte: string | null;
  grade: string | null;
  indice: number | null;
  net: number | null;
  service: string | null;
  page: number;
}

type Colonne =
  | 'nom'
  | 'prenom'
  | 'matricule'
  | 'naissance'
  | 'mdr'
  | 'reference'
  | 'grade'
  | 'indice'
  | 'opSaisie'
  | 'opValidation'
  | 'net';

interface Morceau {
  texte: string;
  x: number;
  y: number;
}

const MOIS: Record<string, number> = {
  JAN: 1,
  JANV: 1,
  FEB: 2,
  FEV: 2,
  FEVR: 2,
  MAR: 3,
  MARS: 3,
  APR: 4,
  AVR: 4,
  AVRI: 4,
  MAY: 5,
  MAI: 5,
  JUN: 6,
  JUIN: 6,
  JUL: 7,
  JUIL: 7,
  AUG: 8,
  AOU: 8,
  AOUT: 8,
  SEP: 9,
  SEPT: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

/** « 08-JAN-89 », « 08/01/1989 » → « 1989-01-08 » (année à deux chiffres : 19xx sauf un âge de moins de 15 ans). */
export function dateSolde(t: string, annee = new Date().getFullYear()) {
  const s = t.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
  const m = /^(\d{1,2})[-/. ]([A-Z]{3,5}|\d{1,2})[-/. ](\d{2}|\d{4})$/.exec(s);
  if (!m) return null;
  const j = Number(m[1]);
  const mois = /^\d+$/.test(m[2]) ? Number(m[2]) : MOIS[m[2]];
  let a = Number(m[3]);
  if (m[3].length === 2) a += a + 2000 > annee - 15 ? 1900 : 2000;
  if (!mois || mois > 12 || j < 1 || j > 31) return null;
  const d = new Date(Date.UTC(a, mois - 1, j));
  if (d.getUTCMonth() !== mois - 1) return null;
  return `${a}-${String(mois).padStart(2, '0')}-${String(j).padStart(2, '0')}`;
}

const entier = (t: string) => {
  const n = Number(t.replace(/[^\d]/g, ''));
  return t && Number.isFinite(n) && n > 0 ? n : null;
};

/** Titres de colonne (« DATE NAIS. », « OP. SAISIE » sont chacun un seul morceau du PDF). */
function colonnesDe(ligne: Morceau[]): { col: Colonne; x: number }[] | null {
  const x = (re: RegExp) =>
    ligne.find((m) => re.test(m.texte.trim().toUpperCase()))?.x;
  const cols: [Colonne, number | undefined][] = [
    ['nom', x(/^NOMS?$/)],
    ['prenom', x(/^PRENOMS?$/)],
    ['matricule', x(/^MATRI/)],
    ['naissance', x(/^DATE/)],
    ['mdr', x(/^MDR/)],
    ['reference', x(/^REF/)],
    ['grade', x(/^GRADE/)],
    ['indice', x(/^INDICE/)],
    ['opSaisie', x(/^OP\.?\s*SAISIE/)],
    ['opValidation', x(/^OP\.?\s*VALID/)],
    ['net', x(/^NET/)],
  ];
  // Les colonnes indispensables ; les autres manquent parfois
  for (const c of ['nom', 'matricule', 'naissance'] as Colonne[])
    if (cols.find(([k]) => k === c)?.[1] === undefined) return null;
  return cols
    .filter((c): c is [Colonne, number] => c[1] !== undefined)
    .map(([col, v]) => ({ col, x: v }))
    .sort((a, b) => a.x - b.x);
}

/** Ce qui sert de pdfjs (module ESM chargé à la demande ; ses types ne sont pas relus ici). */
interface PdfJs {
  getDocument(o: {
    data: Uint8Array;
    useSystemFonts: boolean;
    verbosity: number;
  }): {
    promise: Promise<{
      numPages: number;
      getPage(n: number): Promise<{
        getTextContent(): Promise<{ items: unknown[] }>;
      }>;
      cleanup(): Promise<void>;
    }>;
  };
}
interface MorceauPdf {
  str: string;
  transform: number[];
}
const estMorceau = (it: unknown): it is MorceauPdf =>
  !!it &&
  typeof (it as MorceauPdf).str === 'string' &&
  !!(it as MorceauPdf).str.trim() &&
  Array.isArray((it as MorceauPdf).transform);

/** Lignes du PDF (texte et position). */
async function morceauxParPage(contenu: Buffer): Promise<Morceau[][]> {
  const pdfjs =
    (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfJs;
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(contenu),
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  const pages: Morceau[][] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const t = await page.getTextContent();
    pages.push(
      t.items.filter(estMorceau).map((it) => ({
        texte: it.str,
        x: it.transform[4],
        y: it.transform[5],
      })),
    );
  }
  await doc.cleanup();
  return pages;
}

export const estPdf = (contenu: Buffer) =>
  contenu.subarray(0, 5).toString('latin1') === '%PDF-';

/** Lignes hors tableau : séparateurs, « Ministère », « Service », totaux, titres. */
const HORS_TABLEAU =
  /^(-{5,}|={5,}|MINIST|SERVICE\s*:|TOTAL|EFFECTIF|PAGE\s+\d|LISTE DES AGENTS|EDITE LE|DIRECTION)/i;

/**
 * Un agent par matricule. Le nom et le prénom tiennent souvent sur deux ou trois lignes, au-dessus
 * et au-dessous de la ligne du matricule : chaque morceau va à l'agent dont le matricule est le
 * plus proche en hauteur. Les autres colonnes sont sur la ligne du matricule.
 */
export async function lireListePriseEnCharge(contenu: Buffer): Promise<{
  lignes: LignePriseEnCharge[];
  pages: number;
  pagesSansTitres: number;
}> {
  const pages = await morceauxParPage(contenu);
  const sortie: LignePriseEnCharge[] = [];
  let sansTitres = 0;
  let cols: { col: Colonne; x: number }[] | null = null;
  pages.forEach((morceaux, p) => {
    const titres = morceaux.filter((m) => /^PRENOMS?$/i.test(m.texte.trim()));
    if (titres.length) {
      const y = titres[0].y;
      cols = colonnesDe(morceaux.filter((m) => Math.abs(m.y - y) <= 2)) ?? cols;
    } else sansTitres++;
    if (!cols) return;
    const colonnes = cols;
    const colDe = (m: Morceau) => {
      let c = colonnes[0].col;
      for (const k of colonnes) if (m.x >= k.x - 3) c = k.col;
      return c;
    };
    const titresY = new Set(titres.map((t) => Math.round(t.y)));
    // Services (« Service : 1700--… ») de haut en bas, pour ranger chaque agent
    const services = morceaux
      .filter((m) => /^Service\s*:/i.test(m.texte.trim()))
      .map((m) => ({
        y: m.y,
        nom: m.texte.trim().replace(/^Service\s*:\s*/i, ''),
      }))
      .sort((a, b) => b.y - a.y);
    const utiles = morceaux.filter(
      (m) =>
        !HORS_TABLEAU.test(m.texte.trim()) &&
        ![...titresY].some((y) => Math.abs(y - m.y) <= 2),
    );
    const ancres = utiles.filter(
      (m) =>
        colDe(m) === 'matricule' && /^\d{3,8}\s*[A-Z]?$/i.test(m.texte.trim()),
    );
    if (!ancres.length) return;
    const agents = ancres.map(
      (a): { a: Morceau; parCol: Partial<Record<Colonne, Morceau[]>> } => ({
        a,
        parCol: {},
      }),
    );
    for (const m of utiles) {
      const c = colDe(m);
      if (c === 'matricule' && ancres.includes(m)) continue;
      // Agent le plus proche en hauteur (à 14 points au plus)
      let meilleur: (typeof agents)[number] | null = null;
      for (const g of agents)
        if (!meilleur || Math.abs(g.a.y - m.y) < Math.abs(meilleur.a.y - m.y))
          meilleur = g;
      if (!meilleur || Math.abs(meilleur.a.y - m.y) > 14) continue;
      // Hors nom et prénom, seule la ligne du matricule compte
      if (
        !['nom', 'prenom', 'opSaisie', 'opValidation'].includes(c) &&
        Math.abs(meilleur.a.y - m.y) > 2
      )
        continue;
      (meilleur.parCol[c] ??= []).push(m);
    }
    for (const g of agents) {
      const v = (c: Colonne) =>
        (g.parCol[c] ?? [])
          .sort((a, b) => b.y - a.y || a.x - b.x)
          .map((m) => m.texte.trim())
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
      const nom = v('nom');
      if (!nom) continue;
      const service = services.filter((x) => x.y > g.a.y).pop()?.nom ?? null;
      sortie.push({
        nom,
        prenom: v('prenom'),
        matricule: g.a.texte.replace(/\s/g, '').toUpperCase(),
        dateNaissance: dateSolde(v('naissance')),
        mdr: v('mdr') || null,
        referenceTexte: v('reference') || null,
        grade: v('grade') || null,
        indice: entier(v('indice')),
        net: entier(v('net')),
        service,
        page: p + 1,
      });
    }
  });
  return { lignes: sortie, pages: pages.length, pagesSansTitres: sansTitres };
}
