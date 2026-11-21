import { normaliser } from '../common/texte';
import {
  cleNomEcole,
  ressemblanceEcoles,
} from '../etablissements/repertoire-ecoles.service';
import { CATEGORIE } from './categories';

/**
 * Placer les nommés dans l'organigramme (DGRHAS, 21/11/2026 : « les nominations servent à placer
 * dans les écoles » ; toutes les écoles disaient « poste vacant »). Chaque nomination validée est
 * reliée à sa structure d'après le poste écrit dans la note (« EP Mankala », « B/ville 3 »,
 * « Zone 4 : Kouilou/Pointe-Noire ») : le chef devient le responsable de la structure, la fiche
 * du nommé y est rattachée avec sa fonction.
 */

/** Fonctions qui dirigent la structure : le nommé en devient le responsable. */
export const CHEFS_DE_STRUCTURE = new Set([
  'PRESCO_DIRECTEUR',
  'PRIMAIRE_DIRECTEUR',
  'COLLEGE_DIRECTEUR',
  'LYCEE_PROVISEUR',
  'ALPHA_DIRECTEUR',
  'PRESCO_ICCS',
  'PRIMAIRE_ICCS',
  'COLLEGE_ICOORD',
  'LYCEE_ICOORD',
]);

/** Fonctions exercées dans une inspection (les autres, dans un établissement). */
const DANS_INSPECTION = new Set([
  'PRESCO_ICCS',
  'PRESCO_ICAP',
  'PRESCO_CP',
  'PRESCO_ECONOME_INSP',
  'PRIMAIRE_ICCS',
  'PRIMAIRE_ICAP',
  'PRIMAIRE_CP',
  'PRIMAIRE_ECONOME_INSP',
  'COLLEGE_ICOORD',
  'COLLEGE_ICAP',
  'COLLEGE_IDCAP',
  'COLLEGE_ECONOME_INSP',
  'LYCEE_ICOORD',
  'LYCEE_IDELEGUE',
  'LYCEE_ECONOME_INSP',
  'ALPHA_CTAR',
]);

/** Inspecteurs itinérants : leur structure centrale, par son sigle. */
const ITINERANTS: Record<string, string> = {
  ITIN_IPA: 'IPA',
  ITIN_IAFP: 'IAFP',
  ITIN_DFC: 'DFC',
  ITIN_INRAP: 'INRAP',
};

export interface StructurePlacable {
  id: number;
  type: string;
  nom: string;
  sigle: string | null;
  parentId: number | null;
  departementId: number | null;
  cycle: string | null;
  anciensNoms?: string[] | null;
  actif: boolean;
}

export interface NominationAPlacer {
  id: number;
  categorie: string;
  departementId: number | null;
  circonscription: string | null;
  nouveauPoste: string | null;
}

export type EtatPlacement =
  'SUR' | 'PROBABLE' | 'INTROUVABLE' | 'SANS_STRUCTURE';

export interface Placement {
  structureId: number | null;
  etat: EtatPlacement;
  /** Ressemblance du poste écrit et du nom de la structure (0-100). */
  ressemblance: number | null;
  pourquoi: string | null;
  /** École introuvable : l'inspection de la circonscription écrite dans la note (pour l'ajouter). */
  inspectionAjoutId?: number | null;
}

/** Abréviations des notes : « B/ville 3 », « P/N 2 », « ICEG LEK 1 », « B. Songho 1 », « IPB 1 ». */
const ABREVIATIONS: [RegExp, string][] = [
  [/\bB\s*\/\s*VILLE\b|\bBZV\b|\bBRAZZA\b(?!VILLE)/g, 'BRAZZAVILLE'],
  [
    /\bP\s*\/\s*(NOIRE|N)\b|\bPTE\s*NOIRE\b|\bPN(?=\s*\d|\s*$)/g,
    'POINTE NOIRE',
  ],
  [/\bLEK\b/g, 'LEKOUMOU'],
  [/\bB\s*\.?\s*SONGHO\b/g, 'BOKO SONGHO'],
  // Inspections du préscolaire de Brazzaville et de Pointe-Noire
  [/\bIPB\s*(\d)/g, 'BRAZZAVILLE $1'],
  [/\bIPPN\s*(\d)/g, 'POINTE NOIRE $1'],
];

/** Mots qui ne distinguent pas une inspection. */
const GENERIQUES_INSPECTION = new Set([
  'INSPECTION',
  'INSPECTIONS',
  'ICEG',
  'ICGE',
  'IEP',
  'IEPP',
  'CEG',
  'IEPA',
  'IP',
  'IPS',
  'ICS',
  'CIRCONSCRIPTION',
  'CIRCONSCRIPTIONS',
  'SCOLAIRE',
  'PRESCOLAIRE',
  'PRIMAIRE',
  'COORDINATION',
  'SECTORIELLE',
  'ALPHABETISATION',
  'EDUCATION',
  'NON',
  'FORMELLE',
  'ENSEIGNEMENT',
  'DES',
  'DE',
  'DU',
  'D',
  'LA',
  'LE',
  'LES',
  'L',
  'ET',
]);

/** Le nom propre d'une inspection : « Inspection des CEG Bouenza 1 (Madingou) » → « BOUENZA 1 ». */
export function cleInspection(texte: string | null | undefined): string {
  let t = ` ${normaliser(texte ?? '')} `;
  for (const [re, par] of ABREVIATIONS) t = t.replace(re, par);
  // Le lieu entre parenthèses ou après « : » / « - » précise seulement
  t = t.split(/\(|\s:\s|\s-\s/)[0];
  t = t
    .replace(/\bIII\b/g, '3')
    .replace(/\bII\b/g, '2')
    .replace(/\bI\b/g, '1');
  return t
    .replace(/[^A-Z0-9]+/g, ' ')
    .split(' ')
    .filter((m) => m && !GENERIQUES_INSPECTION.has(m))
    .join(' ');
}

/** Cycle d'une inspection : le sien, ou celui que dit son nom (ICEG, ILZ, IEPA). */
function cycleInspection(s: StructurePlacable): string | null {
  if (s.cycle) return s.cycle;
  const n = normaliser(s.nom);
  if (/\bILZ\b|LYCEE/.test(n)) return 'LYCEE';
  if (/\bICEG\b|\bCEG\b/.test(n)) return 'COLLEGE';
  if (/\bIEPA\b|ALPHA/.test(n)) return 'ALPHABETISATION';
  if (/PRESCO/.test(n)) return 'PRESCOLAIRE';
  return null;
}

const NOMBRES: Record<string, string> = {
  UN: '1',
  DEUX: '2',
  TROIS: '3',
  QUATRE: '4',
  CINQ: '5',
  SIX: '6',
  HUIT: '8',
  NEUF: '9',
  DIX: '10',
};

/**
 * Les écritures d'une même école rapprochées : « St » = « Saint », « Trois Martyrs » =
 * « 3 Martyrs », « Kinsoundi II-B » = « Kinsoundi 2 B », « Imm. Conception » = « Immaculée… ».
 */
export function cleEcole(nom: string): string {
  const mots = normaliser(nom)
    .replace(/[^A-Z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .flatMap((m) => {
      if (m === 'ST') return ['SAINT'];
      if (m === 'STE') return ['SAINTE'];
      if (m === 'IMM') return ['IMMACULEE'];
      // « Centre d'Alphab. et Rescol. », « Lycée Interdép. » : le type, pas le nom
      if (/^(ALPHAB|ALPHABET|INTERDEP|INTERDEPARTEMENTAL|RESCOL)$/.test(m))
        return [];
      if (NOMBRES[m]) return [NOMBRES[m]];
      const r = /^(IV|I{1,3})([A-D])?$/.exec(m);
      if (r) {
        const n = { I: '1', II: '2', III: '3', IV: '4' }[r[1]] ?? r[1];
        return r[2] ? [n, r[2]] : [n];
      }
      return [m];
    });
  return cleNomEcole(mots.join(' '));
}

const nomsDe = (s: StructurePlacable) =>
  [...new Set([s.nom, s.sigle, ...(s.anciensNoms ?? [])])].filter(
    (x): x is string => !!x,
  );

/**
 * Relie chaque nomination à sa structure. Sûr : le nom ressemble beaucoup et nettement mieux que
 * toute autre structure (l'inspection de la circonscription départage les homonymes) ; probable :
 * à confirmer ; introuvable : la structure n'est pas dans l'organigramme (ou s'écrit autrement).
 */
export function placerNominations(
  nominations: NominationAPlacer[],
  structures: StructurePlacable[],
  departements: { id: number; nom: string }[] = [],
): Map<number, Placement> {
  // Les mêmes postes reviennent (directeur, économe… d'une même école) : chaque comparaison une fois
  const memo = new Map<string, number>();
  const ressemblance = (x: string, y: string) => {
    const k = `${x}\u0001${y}`;
    let v = memo.get(k);
    if (v === undefined) {
      v = ressemblanceEcoles(x, y);
      memo.set(k, v);
    }
    return v;
  };
  const depCle = new Map(departements.map((d) => [d.id, cleInspection(d.nom)]));
  const actives = structures.filter((s) => s.actif);
  const parId = new Map(actives.map((s) => [s.id, s]));
  const ecoles = new Map<string, StructurePlacable[]>();
  const inspections = new Map<string, StructurePlacable[]>();
  const tri = (
    m: Map<string, StructurePlacable[]>,
    k: string,
    s: StructurePlacable,
  ) => m.set(k, [...(m.get(k) ?? []), s]);
  for (const s of actives) {
    if (s.type === 'ETABLISSEMENT')
      tri(ecoles, `${s.departementId}|${s.cycle}`, s);
    if (s.type === 'INSPECTION') {
      tri(inspections, `${s.departementId}|${cycleInspection(s) ?? '*'}`, s);
      tri(inspections, `*|${cycleInspection(s) ?? '*'}`, s);
    }
  }
  const clesEcole = new Map(
    actives.map((s) => [s.id, nomsDe(s).map((n) => cleEcole(n))]),
  );
  const clesInsp = new Map(
    actives
      .filter((s) => s.type === 'INSPECTION')
      .map((s) => [s.id, nomsDe(s).map((n) => cleInspection(n))]),
  );
  const parSigle = new Map<string, StructurePlacable>();
  for (const s of actives) if (s.sigle) parSigle.set(normaliser(s.sigle), s);

  const res = new Map<number, Placement>();
  const garder = (id: number, p: Placement) => res.set(id, p);

  for (const n of nominations) {
    const cat = CATEGORIE.get(n.categorie);
    const poste = n.nouveauPoste ?? '';
    // Inspecteurs itinérants : la structure centrale
    const sigle = ITINERANTS[n.categorie];
    if (sigle) {
      const s = parSigle.get(sigle);
      garder(n.id, {
        structureId: s?.id ?? null,
        etat: s ? 'SUR' : 'INTROUVABLE',
        ressemblance: s ? 100 : null,
        pourquoi: s
          ? null
          : `aucune structure « ${sigle} » dans l’organigramme`,
      });
      continue;
    }
    if (
      !cat ||
      cat.cycle === 'ADMINISTRATION' ||
      n.categorie === 'ALPHA_CDAR'
    ) {
      garder(n.id, {
        structureId: null,
        etat: 'SANS_STRUCTURE',
        ressemblance: null,
        pourquoi:
          'fonction départementale sans structure dans l’organigramme : la fiche n’est pas déplacée',
      });
      continue;
    }

    // Lycées par zone : « Zone 4 : Kouilou/Pointe-Noire » → ILZ 4
    const zone = /\bZONE\s*(\d+)/.exec(
      normaliser(`${poste} ${n.circonscription ?? ''}`),
    );
    if (zone && DANS_INSPECTION.has(n.categorie)) {
      const ilz = (inspections.get('*|LYCEE') ?? []).filter((s) =>
        new RegExp(`\\bILZ\\s*${zone[1]}\\b`).test(normaliser(s.nom)),
      );
      garder(n.id, {
        structureId: ilz.length === 1 ? ilz[0].id : null,
        etat: ilz.length === 1 ? 'SUR' : 'INTROUVABLE',
        ressemblance: ilz.length === 1 ? 100 : null,
        pourquoi:
          ilz.length === 1
            ? null
            : `inspection des lycées de la zone ${zone[1]} (ILZ ${zone[1]}) ${ilz.length ? 'en double' : 'absente'} dans l’organigramme`,
      });
      continue;
    }

    const textes = [poste, n.circonscription].filter((x): x is string => !!x);
    let candidats: StructurePlacable[];
    let score: (s: StructurePlacable) => { r: number; insp: boolean };
    if (DANS_INSPECTION.has(n.categorie)) {
      const k = (dep: number | null | string) => [
        ...(inspections.get(`${dep}|${cat.cycle}`) ?? []),
        // Une inspection sans cycle écrit (« Inspection Bouansa ») : son nom décide
        ...(inspections.get(`${dep}|*`) ?? []),
      ];
      candidats = n.departementId ? k(n.departementId) : k('*');
      const cles = textes.map(cleInspection).filter(Boolean);
      score = (s) => ({
        r: Math.max(
          0,
          ...cles.flatMap((a) =>
            (clesInsp.get(s.id) ?? []).map((b) => ressemblance(a, b)),
          ),
        ),
        insp: false,
      });
    } else {
      candidats = n.departementId
        ? (ecoles.get(`${n.departementId}|${cat.cycle}`) ?? [])
        : actives.filter(
            (s) => s.type === 'ETABLISSEMENT' && s.cycle === cat.cycle,
          );
      const a = cleEcole(poste);
      const circ = cleInspection(n.circonscription);
      score = (s) => {
        const parent = s.parentId ? parId.get(s.parentId) : undefined;
        return {
          r: Math.max(
            0,
            ...(clesEcole.get(s.id) ?? []).map((b) => ressemblance(a, b)),
          ),
          // L'inspection de la circonscription écrite dans la note départage les homonymes
          insp:
            !!circ &&
            !!parent &&
            (clesInsp.get(parent.id) ?? []).some(
              (b) => ressemblance(circ, b) >= 0.88,
            ),
        };
      };
    }
    const notes = candidats
      .map((s) => ({ s, ...score(s) }))
      .filter((x) => x.r >= 0.78)
      .map((x) => ({ ...x, sc: x.r + (x.insp ? 0.08 : 0) }))
      .sort((a, b) => b.sc - a.sc);
    const [m, deux] = notes;
    // Préscolaire : le poste est souvent le département (« Pool », « Sangha », « P/N 2 ») ; une
    // seule inspection du préscolaire dans le département, c'est elle
    if (!m && DANS_INSPECTION.has(n.categorie) && cat.cycle === 'PRESCOLAIRE') {
      const presco = (
        inspections.get(`${n.departementId}|PRESCOLAIRE`) ?? []
      ).filter((s) => s.cycle === 'PRESCOLAIRE');
      if (presco.length === 1) {
        const dep = n.departementId ? depCle.get(n.departementId) : undefined;
        const estDep =
          !!dep &&
          textes.some((t) => ressemblance(cleInspection(t), dep) >= 0.78);
        garder(n.id, {
          structureId: presco[0].id,
          etat: estDep ? 'SUR' : 'PROBABLE',
          ressemblance: null,
          pourquoi: `la seule inspection du préscolaire du département : « ${presco[0].nom} »`,
        });
        continue;
      }
    }
    if (!m) {
      // L'école manque à l'organigramme : l'inspection de la circonscription pourra la recevoir
      let inspectionAjoutId: number | null = null;
      if (!DANS_INSPECTION.has(n.categorie) && n.circonscription) {
        const circ = cleInspection(n.circonscription);
        const insp = [
          ...(inspections.get(`${n.departementId}|${cat.cycle}`) ?? []),
          ...(inspections.get(`${n.departementId}|*`) ?? []),
        ]
          .map((s) => ({
            s,
            r: Math.max(
              0,
              ...(clesInsp.get(s.id) ?? []).map((b) => ressemblance(circ, b)),
            ),
          }))
          .filter((x) => x.r >= 0.88)
          .sort((a, b) => b.r - a.r);
        if (insp.length && (insp.length === 1 || insp[0].r > insp[1].r))
          inspectionAjoutId = insp[0].s.id;
      }
      garder(n.id, {
        inspectionAjoutId,
        structureId: null,
        etat: 'INTROUVABLE',
        ressemblance: null,
        pourquoi: `« ${poste || n.circonscription || '—'} » : aucune ${DANS_INSPECTION.has(n.categorie) ? 'inspection' : 'école'} de ce nom dans le département`,
      });
      continue;
    }
    const net = !deux || m.sc - deux.sc >= 0.05;
    const sur = net && (m.r >= 0.95 || (m.r >= 0.88 && m.insp));
    garder(n.id, {
      structureId: m.s.id,
      etat: sur ? 'SUR' : 'PROBABLE',
      ressemblance: Math.round(m.r * 100),
      pourquoi: sur
        ? null
        : !net
          ? `plusieurs structures possibles : « ${m.s.nom} », « ${deux.s.nom} »…`
          : `nom proche : « ${m.s.nom} »`,
    });
  }
  return res;
}
