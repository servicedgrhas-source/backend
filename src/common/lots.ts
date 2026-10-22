/**
 * Lots de réception des textes de la FP (règle du DG, 19/10/2026) :
 * - un **paquet** = un envoi de la FP, reconnu à sa date de réception (45, 57, 104 textes…,
 *   quotas et types mélangés) ;
 * - dans un paquet, la DGRHAS range les textes en **lots**, un par quota et par type de texte :
 *   Arrêtés, Décrets PM (licence, signés par le Premier ministre), Décrets PR (master, signés
 *   par le Président de la République) ;
 * - chaque couple (quota, type) a sa propre numérotation : « Arrêtés quota 2024 — lot 3 ».
 */

export type TypeLot = 'ARRETE' | 'DECRET_PM' | 'DECRET_PR';
export const TYPES_LOT: TypeLot[] = ['ARRETE', 'DECRET_PM', 'DECRET_PR'];

export const NOM_TYPE_LOT: Record<TypeLot, string> = {
  ARRETE: 'Arrêtés',
  DECRET_PM: 'Décrets PM',
  DECRET_PR: 'Décrets PR',
};

/** Type de lot d'un texte : un décret est PR pour un master (note « lycée »), PM sinon. */
export function typeLotDe(
  typeTexte: string | null | undefined,
  typeNoteDiplome: string | null | undefined,
): TypeLot {
  if (typeTexte !== 'DECRET') return 'ARRETE';
  return typeNoteDiplome === 'DECRET_LYCEE' ? 'DECRET_PR' : 'DECRET_PM';
}

export function libelleQuota(l: { quota: number | null; autres: boolean }) {
  return l.autres
    ? 'quota « Autres »'
    : l.quota
      ? `quota ${l.quota}`
      : 'sans quota';
}

/** « Arrêtés quota 2024 — lot 3 » (ancien lot pas encore rangé : « Lot 3 »). */
export function libelleLot(l: {
  numero: number;
  typeTexte?: string | null;
  quota?: number | null;
  autres?: boolean | null;
  rang?: number | null;
}) {
  if (!l.typeTexte || !l.rang) return `Lot ${l.numero}`;
  return `${NOM_TYPE_LOT[l.typeTexte as TypeLot]} ${libelleQuota({
    quota: l.quota ?? null,
    autres: !!l.autres,
  })} — lot ${l.rang}`;
}

/** Abréviation imprimée en repère sur les notes : « Arr/2024/L3 ». */
export function repereLot(l: {
  numero: number;
  typeTexte?: string | null;
  quota?: number | null;
  autres?: boolean | null;
  rang?: number | null;
}) {
  if (!l.typeTexte || !l.rang) return `Lot${l.numero}`;
  const t = { ARRETE: 'Arr', DECRET_PM: 'DécPM', DECRET_PR: 'DécPR' }[
    l.typeTexte as TypeLot
  ];
  return `${t}/${l.autres ? 'Autres' : (l.quota ?? 'SQ')}/L${l.rang}`;
}

export function libellePaquet(p: {
  numero: number;
  dateReception: string | null;
}) {
  if (!p.dateReception) return `Paquet n° ${p.numero} (date inconnue)`;
  const [a, m, j] = p.dateReception.split('-');
  return `Paquet du ${j}/${m}/${a}`;
}

/** Même libellé que libelleLot, en SQL (alias de la table lot_publication). */
export const sqlLibelleLot = (
  l: string,
) => `CASE WHEN ${l}.rang IS NULL THEN 'Lot ' || ${l}.numero
  ELSE (CASE ${l}."typeTexte" WHEN 'ARRETE' THEN 'Arrêtés' WHEN 'DECRET_PM' THEN 'Décrets PM' ELSE 'Décrets PR' END)
    || ' ' || (CASE WHEN ${l}.autres THEN 'quota « Autres »' WHEN ${l}.quota IS NULL THEN 'sans quota' ELSE 'quota ' || ${l}.quota END)
    || ' — lot ' || ${l}.rang END`;
