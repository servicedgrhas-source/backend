import { normaliser } from '../common/texte';
import { ressemblanceEcoles } from '../etablissements/repertoire-ecoles.service';
import { cleEcole } from '../nominations/placement';
import { IndexStructures, type StructureRattachable } from './rattachement';

/**
 * Agents « qui flottent » (DG, 21/11/2026 : un agent dont la fiche dit qu'il travaille dans une
 * école, mais que la page de l'école ne compte pas). La page d'une école compte les fiches
 * rattachées à l'école (`structureId`) ; le lieu de service écrit (`LIEU_SERVICE`) n'est qu'un
 * texte. Ici, chaque lieu écrit (par département et cycle) est rapproché d'une école : une
 * décision rattache toutes les fiches qui l'écrivent pareil.
 */

export interface StructureSansEcole extends StructureRattachable {
  localite?: string | null;
}

export type EtatLieu = 'SUR' | 'PROBABLE' | 'INTROUVABLE';

export interface PropositionLieu {
  structureId: number | null;
  etat: EtatLieu;
  ressemblance: number | null;
  /** Autres écoles possibles (nom proche) : pour choisir sans chercher. */
  autres: number[];
}

/** Cycle que dit le lieu écrit (« EP … », « CEG … », « Lycée … », « CEP … »), sinon null. */
export function cycleDuLieu(texte: string): string | null {
  const t = ` ${normaliser(texte).replace(/[^A-Z0-9]+/g, ' ')} `;
  if (/ (ALPHA|ALPHABETISATION|RESCOL|RESCOLARISATION|CAR|CA) /.test(t))
    return 'ALPHABETISATION';
  if (/ (CEP|PRESCOLAIRE|PRESCO|JARDIN|MATERNELLE|CS) /.test(t))
    return 'PRESCOLAIRE';
  if (/ (LYCEE|LEG|LTP|LYC) /.test(t)) return 'LYCEE';
  if (/ (CEG|COLLEGE) /.test(t)) return 'COLLEGE';
  if (/ (EP|EPP|ECOLE|PRIMAIRE) /.test(t)) return 'PRIMAIRE';
  return null;
}

/**
 * Ce que désigne un lieu écrit : une école (avec son cycle), une inspection, une direction
 * départementale, une administration (direction, service, cabinet…), ou rien de précis (un nom
 * seul : « POINTE-NOIRE 2 »).
 */
export function natureDuLieu(
  texte: string,
): 'ECOLE' | 'INSPECTION' | 'DDEPPSA' | 'ADMINISTRATION' | null {
  const t = ` ${normaliser(texte).replace(/[^A-Z0-9]+/g, ' ')} `;
  if (/ (DDEPPSA|DISPOSITION|DIRECTION DEPARTEMENTALE|DDEP|DDENS) /.test(t))
    return 'DDEPPSA';
  if (
    / (INSPECTION|INSPECTEUR|IEP|IEPA|IP|IDP|ICEG|ICGE|ILZ|CIRCONSCRIPTION) /.test(
      t,
    )
  )
    return 'INSPECTION';
  if (cycleDuLieu(texte)) return 'ECOLE';
  if (
    / (DIRECTION|DIRECTEUR|DGRHAS|DGEPPSA|SERVICE|BUREAU|CABINET|MINISTERE|SECRETARIAT|INRAP|DIRECTION GENERALE|ADMINISTRATION) /.test(
      t,
    )
  )
    return 'ADMINISTRATION';
  return null;
}

const CYCLES_ECOLE = new Set([
  'PRESCOLAIRE',
  'PRIMAIRE',
  'COLLEGE',
  'LYCEE',
  'ALPHABETISATION',
]);

/**
 * Rapproche des lieux écrits des structures actives. Sûr : la reconnaissance exacte du système
 * (nom, sigle, anciens noms), ou une école du même cycle dont le nom ressemble beaucoup et
 * nettement plus qu'aucune autre ; probable : à confirmer ; introuvable : rien d'assez proche.
 */
export function rapprocherLieux(
  lieux: {
    cle: string;
    texte: string;
    departementId: number | null;
    cycleFiche: string | null;
  }[],
  structures: StructureSansEcole[],
): Map<string, PropositionLieu> {
  const index = new IndexStructures(structures);
  const ecoles = structures.filter((s) => s.type === 'ETABLISSEMENT');
  const parDep = new Map<number | null, StructureSansEcole[]>();
  for (const s of ecoles)
    parDep.set(s.departementId, [...(parDep.get(s.departementId) ?? []), s]);
  const cles = new Map(
    ecoles.map((s) => [
      s.id,
      [s.nom, s.sigle, ...(s.anciensNoms ?? [])]
        .filter((x): x is string => !!x)
        .map(cleEcole),
    ]),
  );
  const res = new Map<string, PropositionLieu>();
  for (const l of lieux) {
    const exact = index.trouver(l.texte, l.departementId, l.cycleFiche);
    if (exact) {
      res.set(l.cle, {
        structureId: exact.id,
        etat: 'SUR',
        ressemblance: 100,
        autres: [],
      });
      continue;
    }
    // Le cycle écrit dans le lieu d'abord, sinon celui de la fiche
    const cycle =
      cycleDuLieu(l.texte) ??
      (l.cycleFiche && CYCLES_ECOLE.has(l.cycleFiche) ? l.cycleFiche : null);
    const candidats = (
      l.departementId ? (parDep.get(l.departementId) ?? []) : ecoles
    ).filter((s) => !cycle || s.cycle === cycle);
    const a = cleEcole(l.texte);
    const notes = a
      ? candidats
          .map((s) => ({
            s,
            r: Math.max(
              0,
              ...(cles.get(s.id) ?? []).map((b) => ressemblanceEcoles(a, b)),
            ),
          }))
          .filter((x) => x.r >= 0.78)
          .sort((x, y) => y.r - x.r)
      : [];
    const [m, deux] = notes;
    if (!m) {
      res.set(l.cle, {
        structureId: null,
        etat: 'INTROUVABLE',
        ressemblance: null,
        autres: [],
      });
      continue;
    }
    // Un nom seul (« POINTE-NOIRE 2 » : ni école, ni inspection écrite) n'est jamais sûr : c'est
    // souvent un quartier ou une circonscription (DG, 24/11/2026)
    const sur =
      !!cycle &&
      natureDuLieu(l.texte) !== null &&
      !!l.departementId &&
      m.r >= 0.95 &&
      (!deux || m.r - deux.r >= 0.05);
    res.set(l.cle, {
      structureId: m.s.id,
      etat: sur ? 'SUR' : 'PROBABLE',
      ressemblance: Math.round(m.r * 100),
      autres: notes.slice(1, 4).map((x) => x.s.id),
    });
  }
  return res;
}
