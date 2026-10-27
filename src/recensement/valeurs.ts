import { codeDepartement } from '../common/referentiels';
import { cleCompacte, enTexte, lireDate, normaliser } from '../common/texte';
import type {
  ChampFiche,
  ColonneTableau,
  Condition,
  ConfigRecensement,
  StatutAgent,
} from './configuration';

/** Cellule « vide » des extractions (NULL, N/A, -, néant…). */
const VIDES = new Set([
  '',
  'NULL',
  'NA',
  'NEANT',
  'AUCUN',
  'AUCUNE',
  'NONRENSEIGNE',
  'NR',
]);
export const estVide = (v: unknown) =>
  v === null ||
  v === undefined ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'string' &&
    VIDES.has(cleCompacte(v)) &&
    !/^-?\d/.test(v.trim()));

const MOIS_EN: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
  FEV: 2,
  AVR: 4,
  MAI: 5,
  JUI: 6,
  AOU: 8,
};

/** Date d'un fichier : JJ/MM/AAAA, AAAA-MM-JJ, date Excel, ou « 22-MAY-76 » (extractions de la solde). */
export function lireDateFichier(v: unknown): string | null {
  const d = lireDate(v);
  if (d) return d;
  const m = normaliser(v).match(
    /^(\d{1,2})[-/ ]([A-Z]{3})[A-Z]*[-/ ](\d{2}|\d{4})$/,
  );
  if (!m || !MOIS_EN[m[2]]) return null;
  // « JUILLET » et « JUIN » commencent tous deux par JUI
  const mois = /^\d{1,2}[-/ ]JUIL/.test(normaliser(v)) ? 7 : MOIS_EN[m[2]];
  let an = Number(m[3]);
  if (m[3].length === 2) {
    const siecle = new Date().getFullYear() % 100;
    an += an > siecle ? 1900 : 2000;
  }
  const j = Number(m[1]);
  const mo = mois;
  const dt = new Date(Date.UTC(an, mo - 1, j));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== j) return null;
  return `${an}-${String(mo).padStart(2, '0')}-${String(j).padStart(2, '0')}`;
}

export interface ValeurLue {
  valeur: unknown;
  /** Deuxième valeur trouvée dans la même case (deux téléphones). */
  suite?: unknown;
  /** Valeur refusée (format faux, hors liste) : expliquée. */
  erreur?: string;
}

/** Plusieurs valeurs dans une cellule : « a ; b », « a, b », une par ligne. */
const morceaux = (v: unknown, virgule = true): string[] =>
  (Array.isArray(v)
    ? v.map((x) => enTexte(x))
    : enTexte(v).split(virgule ? /[;\n\r]+|,(?=\s*\D)/ : /[;\n\r]+/)
  )
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s && !estVide(s));

function option(ch: ChampFiche, brut: unknown) {
  const trouver = (k: string) =>
    ch.options.find((o) =>
      [o.code, o.libelle, ...o.synonymes].some((x) => cleCompacte(x) === k),
    ) ?? null;
  const k = cleCompacte(brut);
  if (!k) return null;
  // « 2-PRIMAIRE », « 4-COLLÈGE » : numéro d'ordre devant le libellé
  const sansNumero = cleCompacte(
    enTexte(brut).replace(/^\s*\d{1,2}\s*-\s*(?=\D)/, ''),
  );
  return (
    trouver(k) ?? (sansNumero && sansNumero !== k ? trouver(sansNumero) : null)
  );
}

/**
 * Valeur d'une rubrique, mise au format du système : texte nettoyé, nombre, date ISO, code de la
 * valeur de liste (ou le texte tel quel si la rubrique accepte une autre valeur), lignes…
 */
export function lireValeur(ch: ChampFiche, brut: unknown): ValeurLue {
  if (estVide(brut)) return { valeur: null };
  const texte = enTexte(brut).replace(/\s+/g, ' ').trim();
  switch (ch.type) {
    case 'TEXTE': {
      // « 103231--INSTITUTEUR » (code de la solde devant le libellé)
      const t =
        typeof brut === 'number'
          ? String(brut)
          : texte.replace(/^\d{3,}\s*-{1,2}\s*/, '');
      return { valeur: t.slice(0, 500) };
    }
    case 'NOMBRE': {
      const n = Number(texte.replace(/\s/g, '').replace(',', '.'));
      if (!Number.isFinite(n) || n < 0)
        return { valeur: null, erreur: `« ${texte} » n’est pas un nombre` };
      return { valeur: n };
    }
    case 'DATE': {
      const d = lireDateFichier(brut);
      if (!d)
        return {
          valeur: null,
          erreur: `« ${texte} » n’est pas une date (JJ/MM/AAAA)`,
        };
      return { valeur: d };
    }
    case 'TELEPHONE': {
      // « 066491252 / 040146150 » : deux numéros dans la case, le second est gardé à part
      const numeros = texte
        .split(/\s*[/;|]\s*|\s+(?:ou|et)\s+/i)
        .map((t) =>
          t
            .replace(/[^\d+]/g, '')
            .replace(/^\+?242/, '')
            .replace(/\D/g, ''),
        )
        .filter(Boolean);
      const joli = (n: string) =>
        n.length === 9
          ? `${n.slice(0, 2)} ${n.slice(2, 5)} ${n.slice(5, 7)} ${n.slice(7)}`
          : n;
      if (!numeros.length || numeros.some((n) => n.length < 8 || n.length > 15))
        return {
          valeur: null,
          erreur: `« ${texte} » n’est pas un numéro de téléphone`,
        };
      return {
        valeur: joli(numeros[0]),
        suite: numeros[1] ? joli(numeros[1]) : undefined,
      };
    }
    case 'EMAIL': {
      const t = texte.toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(t))
        return {
          valeur: null,
          erreur: `« ${texte} » n’est pas une adresse e-mail`,
        };
      return { valeur: t };
    }
    case 'LISTE': {
      const o = option(ch, texte);
      if (o) return { valeur: o.code };
      if (ch.autreValeur) return { valeur: texte.slice(0, 200) };
      return {
        valeur: null,
        erreur: `« ${texte} » n’est pas dans la liste (${ch.options.map((x) => x.libelle).join(', ')})`,
      };
    }
    case 'LISTE_MULTIPLE': {
      const vals: string[] = [];
      for (const m of morceaux(brut)) {
        const o = option(ch, m);
        if (o) vals.push(o.code);
        else if (ch.autreValeur) vals.push(m.slice(0, 200));
        else
          return { valeur: null, erreur: `« ${m} » n’est pas dans la liste` };
      }
      return { valeur: [...new Set(vals)] };
    }
    case 'LIGNES':
      return {
        valeur: morceaux(brut, false)
          .map((s) => s.slice(0, 300))
          .slice(0, 50),
      };
    case 'TABLEAU':
      return lireTableau(ch, brut);
    case 'DEPARTEMENT': {
      const code = codeDepartement(texte);
      if (!code)
        return {
          valeur: null,
          erreur: `« ${texte} » n’est pas un département`,
        };
      return { valeur: code };
    }
  }
}

/** Valeur reconnue d'une case « liste » (code, libellé ou autre écriture), sinon null. */
function lireCaseListe(c: ColonneTableau, brut: unknown) {
  const k = cleCompacte(brut);
  if (!k) return null;
  return (
    c.options.find((x) =>
      [x.code, x.libelle, ...x.synonymes].some((y) => cleCompacte(y) === k),
    ) ?? null
  );
}

/** Case d'une ligne de tableau. */
function lireCase(c: ColonneTableau, brut: unknown): ValeurLue {
  if (estVide(brut)) return { valeur: null };
  const t = enTexte(brut).replace(/\s+/g, ' ').trim();
  switch (c.type) {
    case 'DATE': {
      const d = lireDateFichier(brut);
      return d
        ? { valeur: d }
        : { valeur: null, erreur: `« ${t} » n’est pas une date (JJ/MM/AAAA)` };
    }
    case 'NOMBRE': {
      const n = Number(t.replace(/\s/g, '').replace(',', '.'));
      return Number.isFinite(n)
        ? { valeur: n }
        : { valeur: null, erreur: `« ${t} » n’est pas un nombre` };
    }
    case 'LISTE': {
      const o = lireCaseListe(c, t);
      return { valeur: o ? o.code : t.slice(0, 200) };
    }
    default:
      return { valeur: t.slice(0, 300) };
  }
}

/**
 * Tableau (promotions, affectations successives, enfants…) : une liste de lignes à plusieurs cases.
 * À l'écran, chaque ligne arrive déjà découpée. Dans Excel, tout tient dans la case de l'agent :
 * lignes séparées par « ; » (ou un retour à la ligne), cases par « | ». Une ligne d'une seule case
 * (ancien historique en texte, « Arrêté n° 1234 du 12/05/2018 ») va dans la première case de texte,
 * et la date qu'elle contient remplit la case de date.
 */
function lireTableau(ch: ChampFiche, brut: unknown): ValeurLue {
  const cols = ch.colonnes ?? [];
  if (!cols.length) return { valeur: null };
  const lignes: unknown[] = Array.isArray(brut)
    ? brut
    : enTexte(brut)
        .split(/[;\n\r]+/)
        .map((x) => x.trim())
        .filter(Boolean);
  const res: Record<string, unknown>[] = [];
  for (const l of lignes.slice(0, 50)) {
    let cases: Record<string, unknown>;
    if (l && typeof l === 'object' && !Array.isArray(l))
      cases = l as Record<string, unknown>;
    else {
      const parts = enTexte(l)
        .split('|')
        .map((x) => x.trim());
      cases = {};
      if (parts.length === 1) {
        // Une seule case : la valeur d'une liste (« CEPE » d'une ancienne liste de diplômes) va dans
        // cette liste, un texte (« Arrêté n° 12 du… ») dans la première case de texte
        const liste = cols.find(
          (c) => c.type === 'LISTE' && lireCaseListe(c, parts[0]),
        );
        const texte = cols.find((c) => c.type === 'TEXTE');
        cases[(liste ?? texte ?? cols[0]).code] = parts[0];
      } else cols.forEach((c, i) => (cases[c.code] = parts[i] ?? null));
    }
    // Date vide mais écrite dans le texte (« Arrêté n° 12 du 12/05/2018 ») : elle remplit la case de date
    const texte = cols.find((c) => c.type === 'TEXTE');
    const date = cols.find((c) => c.type === 'DATE');
    if (texte && date && estVide(cases[date.code])) {
      const m = enTexte(cases[texte.code]).match(
        /(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})/,
      );
      if (m) cases = { ...cases, [date.code]: m[1].replace(/[.-]/g, '/') };
    }
    const ligne: Record<string, unknown> = {};
    for (const c of cols) {
      const lu = lireCase(c, cases[c.code]);
      if (lu.erreur)
        return { valeur: null, erreur: `${c.libelle} : ${lu.erreur}` };
      if (!estVide(lu.valeur)) ligne[c.code] = lu.valeur;
    }
    if (Object.keys(ligne).length) res.push(ligne);
  }
  return { valeur: res };
}

/** Texte d'une ligne de tableau : « 12/05/2018 | Arrêté n° 1234 | Avancement d’échelon ». */
export function ligneLisible(ch: ChampFiche, l: unknown): string {
  if (!l || typeof l !== 'object') {
    const liste = (ch.colonnes ?? []).find((c) => c.type === 'LISTE');
    return (liste && lireCaseListe(liste, l)?.libelle) || enTexte(l);
  }
  const x = l as Record<string, unknown>;
  return (ch.colonnes ?? [])
    .map((c) => {
      const v = x[c.code];
      if (estVide(v)) return '';
      if (c.type === 'DATE' && /^\d{4}-\d{2}-\d{2}$/.test(String(v)))
        return String(v).split('-').reverse().join('/');
      if (c.type === 'LISTE')
        return c.options.find((o) => o.code === v)?.libelle ?? String(v);
      return String(v);
    })
    .join(' | ')
    .replace(/(\s\|\s)+$/, '');
}

/** La valeur d'une liste est-elle hors liste (texte libre accepté, à vérifier) ? */
export function horsListe(ch: ChampFiche, v: unknown): boolean {
  if (ch.type === 'LISTE')
    return typeof v === 'string' && !ch.options.some((o) => o.code === v);
  if (ch.type === 'LISTE_MULTIPLE')
    return (
      Array.isArray(v) && v.some((x) => !ch.options.some((o) => o.code === x))
    );
  return false;
}

/** Condition remplie par les valeurs d'une fiche. */
export function conditionRemplie(
  cd: Condition | null,
  donnees: Record<string, unknown>,
): boolean {
  if (!cd) return true;
  const v = donnees[cd.champ];
  if (estVide(v)) return false;
  if (!cd.valeurs.length) return true;
  const vals = Array.isArray(v) ? v.map(String) : [String(v)];
  return vals.some((x) => cd.valeurs.includes(x));
}

/** Nombre d'unités d'une rubrique (nombre d'enfants, lignes d'un historique, diplômes cochés). */
export function nombreDe(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 30) : 0;
}

export interface Evaluation {
  champs: string[];
  pieces: { code: string; manque: number }[];
  aVerifier: string[];
  taux: number;
  complet: boolean;
}

/**
 * Ce qui manque à une fiche, pour son type d'agent : rubriques obligatoires vides, pièces exigées
 * absentes (une par enfant, une par promotion…), valeurs à vérifier et règles de cohérence.
 */
export function evaluer(
  config: ConfigRecensement,
  statut: string,
  donnees: Record<string, unknown>,
  piecesFournies: Record<string, number>,
): Evaluation {
  let exiges = 0;
  let fournis = 0;
  const champs: string[] = [];
  const aVerifier: string[] = [];
  for (const ch of config.champs) {
    if (!ch.actif) continue;
    const v = donnees[ch.code];
    if (!estVide(v) && horsListe(ch, v)) aVerifier.push(ch.code);
    if (
      !ch.obligatoirePour.includes(statut) ||
      !conditionRemplie(ch.si, donnees)
    )
      continue;
    exiges++;
    if (estVide(v)) champs.push(ch.code);
    else fournis++;
  }
  const pieces: { code: string; manque: number }[] = [];
  for (const p of config.pieces) {
    if (
      !p.actif ||
      !p.exigeePour.includes(statut) ||
      !conditionRemplie(p.si, donnees)
    )
      continue;
    const nombre = p.nombreSelon ? nombreDe(donnees[p.nombreSelon]) : 1;
    if (!nombre) continue;
    const ok = Math.min(nombre, piecesFournies[p.code] ?? 0);
    exiges += nombre;
    fournis += ok;
    if (ok < nombre) pieces.push({ code: p.code, manque: nombre - ok });
  }
  for (const r of config.regles)
    if (
      r.actif &&
      conditionRemplie(r.si, donnees) &&
      !estVide(donnees[r.alors.champ]) &&
      !conditionRemplie(r.alors, donnees)
    )
      aVerifier.push(`REGLE:${r.code}`);
  // Un fonctionnaire n'entre que par un arrêté ou un décret d'intégration (DG, 24/10/2026)
  if (
    statut === 'FONCTIONNAIRE' &&
    donnees.NATURE_TEXTE_RECRUTEMENT === 'NOTE_SERVICE'
  )
    aVerifier.push(`REGLE:${REGLE_INTEGRATION}`);
  return {
    champs,
    pieces,
    aVerifier,
    taux: exiges ? Math.round((fournis / exiges) * 100) : 100,
    complet: !champs.length && !pieces.length,
  };
}

/** Texte lisible d'une valeur (libellé de la liste, date JJ/MM/AAAA, lignes séparées par « ; »). */
export function valeurLisible(
  ch: ChampFiche,
  v: unknown,
  nomDepartement?: (code: string) => string | undefined,
): string {
  if (estVide(v)) return '';
  const lib = (x: unknown) =>
    ch.options.find((o) => o.code === x)?.libelle ?? String(x);
  switch (ch.type) {
    case 'LISTE':
      return lib(v);
    case 'TABLEAU':
      return (Array.isArray(v) ? v : [v])
        .map((l) => ligneLisible(ch, l))
        .join(' ; ');
    case 'LISTE_MULTIPLE':
    case 'LIGNES':
      return (Array.isArray(v) ? v : [v])
        .map((x) => (ch.type === 'LIGNES' ? String(x) : lib(x)))
        .join(' ; ');
    case 'DATE': {
      const s = String(v);
      return /^\d{4}-\d{2}-\d{2}$/.test(s)
        ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`
        : s;
    }
    case 'DEPARTEMENT':
      return nomDepartement?.(String(v)) ?? String(v);
    default:
      return String(v);
  }
}

export const libelleStatut = (statuts: StatutAgent[], code: string) =>
  statuts.find((s) => s.code === code)?.libelle ?? code;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
/** Date ISO + n mois (fin de mois respectée). */
export const ajouterMoisDate = (date: string, mois: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  const jour = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + mois);
  // 31 août + 6 mois : fin février, pas début mars
  const dernier = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(jour, dernier));
  return d.toISOString().slice(0, 10);
};

/**
 * Une échelle de la grille (Administration › Référentiels › Échelles) : son nombre d'échelons, la
 * durée d'un échelon, et l'échelle où l'on passe après le dernier échelon (sinon : on s'arrête).
 */
export interface EchelleGrille {
  code: string;
  libelle: string;
  nombreEchelons: number | null;
  dureeEchelonMois: number | null;
  echelleSuivante: string | null;
}

/** L'échelle écrite dans la fiche (« 2 », « Échelle 2 », « ECHELLE 2 ») parmi celles de la grille. */
export function trouverEchelle(echelles: EchelleGrille[], valeur: unknown) {
  const k = cleCompacte(valeur);
  if (!k) return null;
  const chiffres = k.replace(/\D/g, '');
  return (
    echelles.find(
      (e) => cleCompacte(e.code) === k || cleCompacte(e.libelle) === k,
    ) ??
    (chiffres
      ? (echelles.find((e) => e.code.replace(/\D/g, '') === chiffres) ?? null)
      : null)
  );
}

/** Lit les échelles du référentiel (valeurs `donnees` de chaque ligne ECHELLE). */
export function echellesDe(
  lignes: {
    code: string;
    libelle: string;
    donnees: Record<string, unknown> | null;
  }[],
): EchelleGrille[] {
  return lignes.map((r) => ({
    code: r.code,
    libelle: r.libelle,
    nombreEchelons: Number(r.donnees?.nombreEchelons) || null,
    dureeEchelonMois: Number(r.donnees?.dureeEchelonMois) || null,
    echelleSuivante: enTexte(r.donnees?.echelleSuivante) || null,
  }));
}

/**
 * Promotions (ou avancements) attendues depuis la dernière : à chaque fois l'échelon suivant, après la
 * durée d'un échelon de l'échelle (sinon le délai général) ; après le dernier échelon, le 1er échelon
 * de l'échelle suivante si elle est réglée, sinon on s'arrête. Jusqu'à aujourd'hui, plus la prochaine.
 */
export function promotionsAttendues(o: {
  depuis: string;
  delaiMois: number;
  /** La durée d'un échelon de l'échelle compte (fonctionnaires) ; sinon le délai général seul. */
  dureeEchelle: boolean;
  echelon: number | null;
  echelle: EchelleGrille | null;
  echelles: EchelleGrille[];
  aujourdhui: string;
}) {
  const res: {
    date: string;
    echelon: number | null;
    echelle: string | null;
  }[] = [];
  let e = o.echelon;
  let ech = o.echelle;
  let date = o.depuis;
  for (let k = 0; k < 40; k++) {
    let changement: string | null = null;
    // Le temps passé dans l'échelon actuel : la durée de l'échelle où l'on est encore
    const mois = (o.dureeEchelle ? ech?.dureeEchelonMois : null) || o.delaiMois;
    if (e !== null) {
      e++;
      if (ech?.nombreEchelons && e > ech.nombreEchelons) {
        const suivante = ech.echelleSuivante
          ? (trouverEchelle(o.echelles, ech.echelleSuivante) ?? null)
          : null;
        if (!suivante || suivante.code === ech.code) break;
        ech = suivante;
        e = 1;
        changement = suivante.libelle;
      }
    }
    date = ajouterMoisDate(date, mois);
    res.push({ date, echelon: e, echelle: changement });
    if (date > o.aujourdhui) break;
  }
  return res;
}

export interface Avancement {
  /** « promotion » (fonctionnaire) ou « avancement » (contractuel). */
  nature: 'PROMOTION' | 'AVANCEMENT';
  /** Date de la dernière promotion ou du dernier avancement (sinon de l'entrée). */
  depuis: string;
  /** « dernière promotion » ou « entrée » : d'où vient la date de départ. */
  origine: 'DERNIER' | 'ENTREE';
  /** Date à laquelle le prochain est dû. */
  prochain: string;
  /** Dernier échelon de sa dernière échelle atteint : plus de promotion d'échelon attendue. */
  fin?: boolean;
}

/**
 * Prochaine promotion (fonctionnaire, tous les 2 ans) ou prochain avancement (contractuel, tous les
 * 2 ans et 4 mois) : à compter de la date la plus récente entre « date de la dernière promotion ou du
 * dernier avancement » et les lignes « grade et échelon successifs » ; sans elles, de l'entrée
 * (intégration ou engagement). Les délais se règlent dans la configuration du personnel.
 */
export function prochainAvancement(
  c: Pick<ConfigRecensement, 'delaiPromotionMois' | 'delaiAvancementMois'>,
  statut: string,
  donnees: Record<string, unknown>,
  /** Échelles de la grille : durée d'un échelon et dernier échelon (sinon, délais généraux). */
  echelles: EchelleGrille[] = [],
): Avancement | null {
  // Fiche de gestion de la carrière administrative (DG) : après sa titularisation ou la révision
  // de sa situation administrative, le contractuel est géré comme un fonctionnaire
  const lignes = Array.isArray(donnees.PROMOTIONS)
    ? (donnees.PROMOTIONS as Record<string, unknown>[])
    : [];
  const gereCommeFonctionnaire = lignes.some(
    (l) =>
      l &&
      typeof l === 'object' &&
      ['TITULARISATION', 'RSA'].includes(enTexte(l.NATURE)),
  );
  const nature =
    statut === 'FONCTIONNAIRE' ||
    (statut === 'CONTRACTUEL' && gereCommeFonctionnaire)
      ? 'PROMOTION'
      : statut === 'CONTRACTUEL'
        ? 'AVANCEMENT'
        : null;
  if (!nature) return null;
  const mois =
    nature === 'PROMOTION' ? c.delaiPromotionMois : c.delaiAvancementMois;
  if (!mois) return null;
  const dates = [
    donnees.DATE_GRADE,
    ...(Array.isArray(donnees.PROMOTIONS)
      ? (donnees.PROMOTIONS as Record<string, unknown>[]).map((l) =>
          l && typeof l === 'object' ? l.DATE : null,
        )
      : []),
  ]
    .map((x) => enTexte(x))
    .filter((x) => ISO.test(x))
    .sort();
  const dernier = dates.at(-1);
  const entree = enTexte(donnees.DATE_RECRUTEMENT);
  const depuis = dernier ?? (ISO.test(entree) ? entree : null);
  if (!depuis) return null;
  // Échelle de l'agent : la durée de son échelon (fonctionnaires), et rien après le dernier échelon
  const [suivant] = promotionsAttendues({
    depuis,
    delaiMois: mois,
    dureeEchelle: nature === 'PROMOTION',
    echelon: Number(enTexte(donnees.ECHELON)) || null,
    echelle: trouverEchelle(echelles, donnees.ECHELLE),
    echelles,
    aujourdhui: depuis,
  });
  return {
    nature,
    depuis,
    origine: dernier ? 'DERNIER' : 'ENTREE',
    prochain: suivant?.date ?? ajouterMoisDate(depuis, mois),
    ...(suivant ? {} : { fin: true }),
  };
}

/** Contrôle fixe : texte d'entrée d'un fonctionnaire qui n'est ni un arrêté ni un décret. */
export const REGLE_INTEGRATION = 'INTEGRATION_PAR_ARRETE';
export const LIBELLE_REGLE_INTEGRATION =
  'Fonctionnaire entré par une note de service : son texte d’intégration est un arrêté ou un décret';

const motNom = (m: string) =>
  m
    .toLowerCase()
    .replace(
      /(^|[-'’])(\p{L})/gu,
      (_, sep: string, l: string) => sep + l.toUpperCase(),
    );

/**
 * « NOM Prénoms » (DG, 24/10/2026) : les mots du début écrits en majuscules sont le nom, le reste
 * les prénoms, avec une majuscule au début. Un nom tout en majuscules (fichier Excel) reste tel
 * quel : on ne peut pas savoir où commencent les prénoms ; tout en minuscules, le premier mot est
 * pris pour le nom.
 */
export function formaterNom(brut: string): string {
  const mots = brut.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!mots.length) return '';
  const lettres = (m: string) => m.replace(/[^\p{L}]/gu, '');
  const majuscule = (m: string) =>
    !!lettres(m) && lettres(m) === lettres(m).toUpperCase();
  if (mots.every(majuscule)) return mots.join(' ');
  let n = 0;
  while (n < mots.length && majuscule(mots[n])) n++;
  if (!n) n = 1;
  return [
    ...mots.slice(0, n).map((m) => m.toUpperCase()),
    ...mots.slice(n).map(motNom),
  ].join(' ');
}

/**
 * Rubriques qui se déduisent d'une autre : la nature du texte de recrutement (arrêté, décret, note
 * de service) d'après le début de sa référence, quand elle n'est pas choisie.
 */
export function deduire(
  c: ConfigRecensement,
  donnees: Record<string, unknown>,
) {
  const nature = c.champs.find(
    (x) => x.code === 'NATURE_TEXTE_RECRUTEMENT' && x.actif,
  );
  if (nature && estVide(donnees.NATURE_TEXTE_RECRUTEMENT)) {
    const t = normaliser(donnees.TEXTE_RECRUTEMENT);
    const code = /^ARRETE/.test(t)
      ? 'ARRETE'
      : /^DECRET/.test(t)
        ? 'DECRET'
        : /^NOTE/.test(t)
          ? 'NOTE_SERVICE'
          : null;
    if (code && nature.options.some((o) => o.code === code))
      donnees.NATURE_TEXTE_RECRUTEMENT = code;
  }
  const ref = completerReference(donnees);
  if (ref) donnees.TEXTE_RECRUTEMENT = ref;
}

/**
 * Référence complète du texte d'entrée, telle qu'elle est signée (DG, 26/10/2026) :
 * « Arrêté n° 6805 du 17/10/2022 ». S'ils manquent, le système ajoute la nature du texte
 * (celle choisie ; sinon d'après la catégorie : I → décret, II et III → arrêté) et la date
 * de signature (la date de recrutement / d'intégration de la fiche). Rien n'est changé si la
 * référence est vide, ou déjà complète.
 */
export function completerReference(
  donnees: Record<string, unknown>,
): string | null {
  const ref = enTexte(donnees.TEXTE_RECRUTEMENT).replace(/\s+/g, ' ').trim();
  if (!ref) return null;
  let r = ref;
  const t = normaliser(ref);
  if (!/^(ARRETE|DECRET|NOTE|CONTRAT|DECISION|LETTRE)/.test(t)) {
    const choisie = enTexte(donnees.NATURE_TEXTE_RECRUTEMENT);
    const cat = normaliser(donnees.CATEGORIE).replace(/^CAT(EGORIE)?\s*/, '');
    const nature =
      choisie === 'ARRETE'
        ? 'Arrêté'
        : choisie === 'DECRET'
          ? 'Décret'
          : choisie === 'NOTE_SERVICE'
            ? 'Note de service'
            : /^(I|1)$/.test(cat)
              ? 'Décret'
              : /^(II|III|2|3)$/.test(cat)
                ? 'Arrêté'
                : null;
    if (nature) r = `${nature} ${/^N\s*[°O]/i.test(ref) ? ref : `n° ${ref}`}`;
  }
  const date = lireDate(donnees.DATE_RECRUTEMENT);
  const datee =
    /\bDU\s+\d/.test(normaliser(r)) ||
    /\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}/.test(r) ||
    /(JANVIER|FEVRIER|MARS|AVRIL|MAI|JUIN|JUILLET|AOUT|SEPTEMBRE|OCTOBRE|NOVEMBRE|DECEMBRE)\s+\d{4}/.test(
      normaliser(r),
    );
  if (date && !datee) {
    const [a, m, j] = date.split('-');
    r = `${r} du ${j}/${m}/${a}`;
  }
  return r === ref ? null : r;
}
