import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';
import { inflateRawSync } from 'node:zlib';
import { cleCompacte } from './texte';

export type Ligne = Record<string, unknown> & { _ligne: number };

export interface FeuilleLue {
  nom: string;
  lignes: Ligne[];
  entetes: string[];
}

/** Valeur exploitable d'une cellule ExcelJS (texte riche, formule, lien…). */
export function valeurCellule(v: ExcelJS.CellValue): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('result' in v) return valeurCellule(v.result);
    if ('text' in v) return (v as { text: string }).text;
    if ('error' in v) return null;
  }
  return v;
}

/**
 * Lit les feuilles visibles d'un classeur (lecture en flux : certains classeurs
 * déclarent des feuilles d'un million de lignes) et repère la ligne d'en-tête
 * (première ligne contenant toutes les colonnes `requises` ; « A|B » : l'une ou l'autre).
 * Les clés des lignes sont les en-têtes compactés (ex. "NOMSETPRENOMS").
 * Une même clé rencontrée deux fois reçoit un suffixe "_2".
 */
export async function lireClasseur(
  contenu: Buffer,
  requises: string[],
  options: { inclureMasquees?: boolean } = {},
): Promise<FeuilleLue[]> {
  try {
    const lues = await lireEnFlux(contenu, requises, options);
    // Certains logiciels (ExcelJS, openpyxl…) rangent « workbook.xml » après les feuilles ou
    // écrivent des chemins absolus : la lecture en flux ne connaît alors ni le nom ni l'état
    // des feuilles (« Sheet1 »…). Ils sont relus dans le classeur lui-même.
    if (!lues.some((f) => /^Sheet\d+$/.test(f.nom))) return lues;
    const feuilles = feuillesDuClasseur(contenu);
    return lues
      .map((f) => {
        const n = /^Sheet(\d+)$/.exec(f.nom)?.[1];
        const vraie = n ? feuilles.get(n) : undefined;
        return vraie
          ? { ...f, nom: vraie.nom, masquee: vraie.masquee }
          : { ...f, masquee: false };
      })
      .filter((f) => options.inclureMasquees || !f.masquee)
      .map((f) => ({ nom: f.nom, lignes: f.lignes, entetes: f.entetes }));
  } catch {
    // La lecture en flux échoue quand le fichier range « workbook.xml » après
    // les feuilles (fichiers produits par certains logiciels) : lecture complète.
    return lireEnEntier(contenu, requises, options);
  }
}

interface FeuilleSource {
  name: string;
  state?: string;
  lignes: AsyncIterable<ExcelJS.Row> | Iterable<ExcelJS.Row>;
}

async function lireEnFlux(
  contenu: Buffer,
  requises: string[],
  options: { inclureMasquees?: boolean },
): Promise<FeuilleLue[]> {
  const lecteur = new ExcelJS.stream.xlsx.WorkbookReader(
    Readable.from(contenu),
    {
      sharedStrings: 'cache',
      hyperlinks: 'ignore',
      styles: 'cache',
      worksheets: 'emit',
      entries: 'emit',
    },
  );
  const resultat: FeuilleLue[] = [];
  for await (const ws of lecteur) {
    const feuille = ws as unknown as AsyncIterable<ExcelJS.Row> & {
      name: string;
      state?: string;
    };
    const lue = await lireFeuille(
      { name: feuille.name, state: feuille.state, lignes: feuille },
      requises,
      options,
    );
    if (lue) resultat.push(lue);
  }
  return resultat;
}

async function lireEnEntier(
  contenu: Buffer,
  requises: string[],
  options: { inclureMasquees?: boolean },
): Promise<FeuilleLue[]> {
  const classeur = new ExcelJS.Workbook();
  await classeur.xlsx.load(contenu as unknown as ArrayBuffer);
  const resultat: FeuilleLue[] = [];
  for (const ws of classeur.worksheets) {
    const lignes: ExcelJS.Row[] = [];
    ws.eachRow((row) => lignes.push(row));
    const lue = await lireFeuille(
      { name: ws.name, state: ws.state, lignes },
      requises,
      options,
    );
    if (lue) resultat.push(lue);
  }
  return resultat;
}

async function lireFeuille(
  feuille: FeuilleSource,
  requises: string[],
  options: { inclureMasquees?: boolean },
): Promise<FeuilleLue | null> {
  const masquee = feuille.state === 'hidden' || feuille.state === 'veryHidden';
  let colonnes: Map<number, string> | null = null;
  const lignes: Ligne[] = [];
  let vides = 0;

  for await (const row of feuille.lignes) {
    if (masquee && !options.inclureMasquees) break;
    const valeurs = (row.values as ExcelJS.CellValue[]) ?? [];
    if (!colonnes) {
      if (row.number > 60) break;
      const cles = new Map<number, string>();
      valeurs.forEach((v, col) => {
        const k = cleCompacte(valeurCellule(v));
        if (k) cles.set(col, k);
      });
      const presentes = [...cles.values()];
      // « A|B » : l'une ou l'autre écriture de la colonne suffit
      if (
        requises.every((q) =>
          q.split('|').some((alt) => presentes.some((v) => v.startsWith(alt))),
        )
      ) {
        const vus = new Map<string, number>();
        colonnes = new Map();
        for (const [col, k] of cles) {
          const n = (vus.get(k) ?? 0) + 1;
          vus.set(k, n);
          colonnes.set(col, n === 1 ? k : `${k}_${n}`);
        }
      }
      continue;
    }
    const ligne: Ligne = { _ligne: row.number };
    let rempli = false;
    for (const [col, k] of colonnes) {
      const v = valeurCellule(valeurs[col]);
      if (
        v !== null &&
        v !== '' &&
        !(typeof v === 'string' && v.trim() === '')
      ) {
        ligne[k] = v;
        rempli = true;
      }
    }
    if (rempli) {
      lignes.push(ligne);
      vides = 0;
    } else if (++vides > 200) break;
  }
  if (!colonnes || (masquee && !options.inclureMasquees)) return null;
  return { nom: feuille.name, lignes, entetes: [...colonnes.values()] };
}

/** Contenu d'un fichier du classeur (archive zip), sans dépendance : répertoire central puis inflate. */
function entreeZip(zip: Buffer, chemin: string): string | null {
  let fin = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--)
    if (zip.readUInt32LE(i) === 0x06054b50) {
      fin = i;
      break;
    }
  if (fin < 0) return null;
  const nombre = zip.readUInt16LE(fin + 10);
  let p = zip.readUInt32LE(fin + 16);
  for (let k = 0; k < nombre && p + 46 <= zip.length; k++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) return null;
    const methode = zip.readUInt16LE(p + 10);
    const taille = zip.readUInt32LE(p + 20);
    const lNom = zip.readUInt16LE(p + 28);
    const lExtra = zip.readUInt16LE(p + 30);
    const lCom = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const nom = zip.toString('utf8', p + 46, p + 46 + lNom);
    if (nom === chemin) {
      const debut =
        local +
        30 +
        zip.readUInt16LE(local + 26) +
        zip.readUInt16LE(local + 28);
      const donnees = zip.subarray(debut, debut + taille);
      return (methode === 8 ? inflateRawSync(donnees) : donnees).toString(
        'utf8',
      );
    }
    p += 46 + lNom + lExtra + lCom;
  }
  return null;
}

/** Nom et état (masquée) de chaque feuille, par numéro de fichier (« sheet3.xml » → 3). */
function feuillesDuClasseur(
  zip: Buffer,
): Map<string, { nom: string; masquee: boolean }> {
  const res = new Map<string, { nom: string; masquee: boolean }>();
  const wb = entreeZip(zip, 'xl/workbook.xml');
  const rels = entreeZip(zip, 'xl/_rels/workbook.xml.rels');
  if (!wb || !rels) return res;
  const cible = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
    const n = /\bTarget="[^"]*sheet(\d+)\.xml"/.exec(m[0])?.[1];
    if (id && n) cible.set(id, n);
  }
  const xml = (s: string) =>
    s.replace(
      /&(amp|lt|gt|quot|apos);/g,
      (_t, e: string) =>
        ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e] ?? '',
    );
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const nom = /\bname="([^"]*)"/.exec(m[0])?.[1];
    const rid =
      /\br:id="([^"]+)"/.exec(m[0])?.[1] ?? /\bid="([^"]+)"/.exec(m[0])?.[1];
    const n = rid ? cible.get(rid) : undefined;
    if (nom !== undefined && n)
      res.set(n, {
        nom: xml(nom),
        masquee: /\bstate="(hidden|veryHidden)"/.test(m[0]),
      });
  }
  return res;
}

/** Première valeur trouvée parmi plusieurs préfixes d'en-tête possibles. */
export function champ(l: Ligne, ...prefixes: string[]): unknown {
  for (const p of prefixes) {
    if (l[p] !== undefined) return l[p];
    const k = Object.keys(l).find((c) => c.startsWith(p) && !c.includes('_'));
    if (k) return l[k];
  }
  return null;
}

/**
 * Toutes les lignes d'une feuille, telles quelles (valeurs simples, par numéro de colonne).
 * Pour les documents mis en page (notes de service) : titres de sections, tableaux répétés…
 */
export async function lireFeuilleBrute(
  contenu: Buffer,
  nomFeuille: string,
): Promise<{ numero: number; valeurs: unknown[] }[] | null> {
  const classeur = new ExcelJS.Workbook();
  await classeur.xlsx.load(contenu as unknown as ArrayBuffer);
  const ws = classeur.getWorksheet(nomFeuille);
  if (!ws) return null;
  const lignes: { numero: number; valeurs: unknown[] }[] = [];
  ws.eachRow((row) => {
    const brutes = (row.values as ExcelJS.CellValue[]) ?? [];
    lignes.push({
      numero: row.number,
      valeurs: brutes.map((v) => valeurCellule(v)),
    });
  });
  return lignes;
}
