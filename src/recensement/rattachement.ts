import { normaliser } from '../common/texte';

/**
 * Rattachement d'une fiche du personnel à sa structure d'après le lieu de service écrit dans la
 * fiche (« LYCEE DE LOUDIMA », « Inspection primaire de Sibiti », « À la disposition de la DDEPPSA
 * Pool »). Sans ce lien, impossible de compter les enseignants d'une école ni de faire pointer
 * leur présence. On ne rattache que si une seule structure correspond (même nature, même nom une
 * fois les mots « lycée », « école primaire »… retirés, même département) : en cas de doute, rien.
 */

export interface StructureRattachable {
  id: number;
  type: string;
  nom: string;
  sigle: string;
  cycle: string | null;
  departementId: number | null;
}

type Nature = 'DD' | 'INS' | 'LYC' | 'COL' | 'PRE' | 'ALP' | 'PRI';

const VIDES = new Set([
  'DE',
  'DU',
  'D',
  'DES',
  'LA',
  'LE',
  'L',
  'LES',
  'ET',
  'A',
  'AU',
]);
const MOTS_TYPE =
  /\b(LYCEE|CEG|COLLEGE|EP|ECOLE|PRIMAIRE|PUBLIQUE|CEP|PRESCOLAIRE|MATERNELLE|JARDIN|ENFANTS|CENTRE|ALPHABETISATION|INSPECTION|IEP|IEPA|IP|IDP|ICEG|ICGE|ENSEIGNEMENT|GENERAL|TECHNIQUE|PROFESSIONNEL|SECONDAIRE|DEPARTEMENTALE|CIRCONSCRIPTION|SCOLAIRE|ETABLISSEMENT)\b/g;
const NATURE_CYCLE: Record<string, Nature> = {
  LYCEE: 'LYC',
  COLLEGE: 'COL',
  PRESCOLAIRE: 'PRE',
  PRIMAIRE: 'PRI',
  ALPHABETISATION: 'ALP',
};

const texte = (s: unknown) =>
  normaliser(s)
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();

/** Nature du lieu écrit : direction départementale, inspection, lycée, CEG, école… */
function nature(n: string): Nature | null {
  if (/DISPOSITION|DDEPPSA|DIRECTION DEPARTEMENTALE/.test(n)) return 'DD';
  if (
    /^(INSPECTION|IEPA?\b|ID?P\b|ICEG\b|ICGE\b|ILZ\b|CIRCONSCRIPTION)/.test(n)
  )
    return 'INS';
  if (/\bLYCEE\b/.test(n)) return 'LYC';
  if (/\b(CEG|COLLEGE)\b/.test(n)) return 'COL';
  if (/\b(CEP|PRESCOLAIRE|MATERNELLE|JARDIN)\b/.test(n)) return 'PRE';
  if (/\bALPHABETISATION\b/.test(n)) return 'ALP';
  if (/\b(EP|ECOLE|PRIMAIRE)\b/.test(n)) return 'PRI';
  return null;
}

/** Le nom propre du lieu : « LYCEE D'ENSEIGNEMENT GENERAL DE MADINGOU » → « MADINGOU ». */
function coeur(n: string) {
  return n
    .replace(MOTS_TYPE, ' ')
    .split(' ')
    .filter((m) => m && !VIDES.has(m))
    .join('');
}

/** Cycle qu'indique le texte d'une inspection (« Inspection primaire de… »). */
function cycleIndique(n: string) {
  if (/PRESCOLAIRE|\bID?P\b/.test(n)) return 'PRESCOLAIRE';
  if (/PRIMAIRE|\bIEPA?\b/.test(n)) return 'PRIMAIRE';
  // Préfixes des inspections (DG, 26/10/2026) : ICEG pour les collèges, ILZ pour les lycées
  if (/\bIC[EG]{2}\b/.test(n)) return 'COLLEGE';
  if (/\bILZ\b/.test(n)) return 'LYCEE';
  if (/ALPHABETISATION/.test(n)) return 'ALPHABETISATION';
  return null;
}

export class IndexStructures {
  private readonly cles = new Map<string, StructureRattachable[]>();
  private readonly ddeppsa = new Map<number, StructureRattachable>();

  constructor(structures: StructureRattachable[]) {
    for (const s of structures) {
      if (s.type === 'DDEPPSA') {
        if (s.departementId && !this.ddeppsa.has(s.departementId))
          this.ddeppsa.set(s.departementId, s);
        continue;
      }
      const nat: Nature | null =
        s.type === 'INSPECTION'
          ? 'INS'
          : s.type === 'ETABLISSEMENT'
            ? (NATURE_CYCLE[s.cycle ?? ''] ?? nature(texte(s.nom)))
            : null;
      if (!nat) continue;
      for (const t of new Set([s.nom, s.sigle])) {
        const k = coeur(texte(t));
        if (!k) continue;
        const cle = `${nat}|${k}`;
        const l = this.cles.get(cle) ?? [];
        if (!l.includes(s)) l.push(s);
        this.cles.set(cle, l);
      }
    }
  }

  /** Structure du lieu de service, si une seule correspond ; sinon null. */
  trouver(lieu: unknown, departementId: number | null) {
    const n = texte(lieu);
    if (!n) return null;
    const nat = nature(n);
    if (!nat) return null;
    if (nat === 'DD')
      return departementId ? (this.ddeppsa.get(departementId) ?? null) : null;
    let c = this.cles.get(`${nat}|${coeur(n)}`) ?? [];
    if (departementId) c = c.filter((s) => s.departementId === departementId);
    // Deux inspections au même endroit (primaire, alphabétisation) : celle du cycle écrit
    const cycle = nat === 'INS' ? cycleIndique(n) : null;
    if (cycle && c.length > 1) c = c.filter((s) => s.cycle === cycle);
    if (c.length !== 1) return null;
    if (cycle && c[0].cycle && c[0].cycle !== cycle) return null;
    return c[0];
  }
}
