import { normaliser } from '../common/texte';

/**
 * Matière enseignée d'après ce qui est écrit dans la fiche (spécialité), quelle que soit la façon de
 * l'écrire (DG, 26/10/2026 : « SVT, Science… chacun l'écrit à sa façon »). Le résultat est le code
 * d'une matière du programme du cycle (Référentiels › Matières), ou rien si l'on ne sait pas.
 */

const compact = (t: unknown) => normaliser(t).replace(/[^A-Z0-9]+/g, '');

/** Écritures courantes → libellés possibles de la matière (compactés, sans accents). */
const ALIAS: Record<string, string[]> = {
  MATH: ['MATHEMATIQUES'],
  MATHS: ['MATHEMATIQUES'],
  MATHEMATIQUE: ['MATHEMATIQUES'],
  SVT: ['SVT'],
  SCIENCESDELAVIEETDELATERRE: ['SVT'],
  SCIENCEDELAVIEETDELATERRE: ['SVT'],
  SCIENCESNATURELLES: ['SVT'],
  SCIENCESNAT: ['SVT'],
  BIOLOGIE: ['SVT'],
  PC: ['PHYSIQUECHIMIE', 'SCIENCESPHYSIQUES'],
  PCT: ['PHYSIQUECHIMIE', 'SCIENCESPHYSIQUES'],
  PHYSIQUE: ['PHYSIQUECHIMIE', 'SCIENCESPHYSIQUES'],
  CHIMIE: ['PHYSIQUECHIMIE', 'SCIENCESPHYSIQUES'],
  SCIENCESPHYSIQUES: ['PHYSIQUECHIMIE', 'SCIENCESPHYSIQUES'],
  SP: ['SCIENCESPHYSIQUES', 'PHYSIQUECHIMIE'],
  HG: ['HISTOIREGEOGRAPHIE'],
  HISTOGEO: ['HISTOIREGEOGRAPHIE'],
  HISTOIRE: ['HISTOIREGEOGRAPHIE'],
  GEOGRAPHIE: ['HISTOIREGEOGRAPHIE'],
  EPS: ['EPS'],
  SPORT: ['EPS'],
  EDUCATIONPHYSIQUE: ['EPS'],
  EDUCATIONPHYSIQUEETSPORTIVE: ['EPS'],
  FR: ['FRANCAIS'],
  LETTRES: ['FRANCAIS'],
  LETTRESMODERNES: ['FRANCAIS'],
  ANG: ['ANGLAIS'],
  ESPAGNOL: ['LANGUEVIVANTEETRANGERE'],
  ALLEMAND: ['LANGUEVIVANTEETRANGERE'],
  PORTUGAIS: ['LANGUEVIVANTEETRANGERE'],
  ARABE: ['LANGUEVIVANTEETRANGERE'],
  RUSSE: ['LANGUEVIVANTEETRANGERE'],
  LVE: ['LANGUEVIVANTEETRANGERE'],
  LV2: ['LANGUEVIVANTEETRANGERE'],
  PHILO: ['PHILOSOPHIE'],
  DESSIN: ['ARTPLASTIQUE', 'ARTSPLASTIQUES'],
  ARTS: ['ARTPLASTIQUE', 'ARTSPLASTIQUES'],
  ARTPLASTIQUES: ['ARTPLASTIQUE', 'ARTSPLASTIQUES'],
};

export function reconnaitreMatiere(
  texte: unknown,
  matieres: Map<string, string>,
): string | null {
  const k = compact(texte);
  if (!k) return null;
  const liste = [...matieres].map(([code, lib]) => ({ code, l: compact(lib) }));
  // 1. Écrit comme au programme
  const exacte = liste.find((m) => m.l === k);
  if (exacte) return exacte.code;
  // 2. Écriture courante (abréviation, autre nom)
  for (const cible of ALIAS[k] ?? []) {
    const m = liste.find((x) => x.l === cible);
    if (m) return m.code;
  }
  // 3. Début du nom (« Anglais LV1 », « Histoire-Géo ») : seulement s'il n'y a qu'une matière possible
  if (k.length < 4) return null;
  const debut = liste.filter(
    (m) => m.l && (m.l.startsWith(k) || k.startsWith(m.l)),
  );
  if (debut.length === 1) return debut[0].code;
  for (const [alias, cibles] of Object.entries(ALIAS))
    if (alias.length >= 4 && k.startsWith(alias))
      for (const cible of cibles) {
        const m = liste.find((x) => x.l === cible);
        if (m) return m.code;
      }
  return null;
}

/** Diplômes et fonctions d'éducation physique : l'enseignant fait l'EPS même sans spécialité écrite. */
const EPS =
  /(^|[^A-Z])(EPS|E P S)([^A-Z]|$)|EDUCATION PHYSIQUE|CAPAEPS|CAPEPS|DEMEPS|DMEPS|^MEPS$/;

/**
 * Matière d'un enseignant : sa spécialité d'abord ; sinon, l'EPS d'après son diplôme ou sa
 * fonction (CAPA EPS, professeur adjoint d'EPS…). Rien sinon : à écrire dans sa fiche.
 */
export function matiereEnseignant(
  a: {
    specialite: string | null;
    fonction?: string | null;
    diplome?: string | null;
  },
  matieres: Map<string, string>,
): string | null {
  const m = reconnaitreMatiere(a.specialite, matieres);
  if (m) return m;
  const indices = [a.diplome, a.fonction].map((x) => normaliser(x));
  if (indices.some((x) => EPS.test(x)))
    return reconnaitreMatiere('EPS', matieres);
  return null;
}
