import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';
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
    return await lireEnFlux(contenu, requises, options);
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

/** Première valeur trouvée parmi plusieurs préfixes d'en-tête possibles. */
export function champ(l: Ligne, ...prefixes: string[]): unknown {
  for (const p of prefixes) {
    if (l[p] !== undefined) return l[p];
    const k = Object.keys(l).find((c) => c.startsWith(p) && !c.includes('_'));
    if (k) return l[k];
  }
  return null;
}
