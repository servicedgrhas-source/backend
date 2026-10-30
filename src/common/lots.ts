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

/** Chiffres romains des lots de la base (« VIII ») ; au-delà, le nombre. */
export function romain(n: number) {
  const t: [number, string][] = [
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ];
  if (n <= 0 || n >= 40) return String(n);
  let r = '';
  for (const [v, x] of t)
    while (n >= v) {
      r += x;
      n -= v;
    }
  return r;
}

/** Famille d'un lot du fichier : arrêtés ou décrets, chacun sa numérotation. */
export type FamilleLot = 'ARRETE' | 'DECRET';
export const NOM_FAMILLE: Record<FamilleLot, string> = {
  ARRETE: 'Arrêtés',
  DECRET: 'Décrets',
};

/**
 * Groupe de quota d'une personne, tel que la DGRHAS compte un lot (DG, 30/10/2026) : quota MEPPSA,
 * quota « Autres » arrivé avec son département, quota « Autres » sans département (donné ensuite
 * par la DGRHAS : il reste « sans département » d'origine).
 */
export type GroupeQuota = 'MEPPSA' | 'AUTRES_AVEC' | 'AUTRES_SANS';
export const GROUPES_QUOTA: GroupeQuota[] = [
  'MEPPSA',
  'AUTRES_AVEC',
  'AUTRES_SANS',
];
export const NOM_GROUPE: Record<GroupeQuota, string> = {
  MEPPSA: 'Quota MEPPSA',
  AUTRES_AVEC: 'Quota Autres avec département',
  AUTRES_SANS: 'Quota Autres sans département',
};
export function groupeQuota(a: {
  feuille: string;
  departementId: number | null;
  repartitionId?: string | null;
}): GroupeQuota {
  if (a.feuille !== 'QUOTA_AUTRES') return 'MEPPSA';
  return a.departementId && !a.repartitionId ? 'AUTRES_AVEC' : 'AUTRES_SANS';
}
/** Même règle en SQL (alias de la table agent). */
export const sqlGroupeQuota = (a: string) =>
  `CASE WHEN ${a}.feuille <> 'QUOTA_AUTRES' THEN 'MEPPSA'
    WHEN ${a}."departementId" IS NOT NULL AND ${a}."repartitionId" IS NULL THEN 'AUTRES_AVEC'
    ELSE 'AUTRES_SANS' END`;

/**
 * « Arrêtés — lot VIII » (lot du fichier), « Arrêtés quota 2024 — lot 3 » (lot rangé par date),
 * « Lot 3 » (ancien lot pas encore rangé).
 */
export function libelleLot(l: {
  numero: number;
  typeTexte?: string | null;
  quota?: number | null;
  autres?: boolean | null;
  rang?: number | null;
  numeroFichier?: number | null;
}) {
  if (l.numeroFichier)
    return `${NOM_FAMILLE[l.typeTexte as FamilleLot] ?? 'Textes'} — lot ${romain(l.numeroFichier)}`;
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
  numeroFichier?: number | null;
}) {
  if (l.numeroFichier)
    return `${l.typeTexte === 'DECRET' ? 'Déc' : 'Arr'}/L${romain(l.numeroFichier)}`;
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
) => `CASE WHEN ${l}."numeroFichier" IS NOT NULL THEN
    (CASE ${l}."typeTexte" WHEN 'DECRET' THEN 'Décrets' ELSE 'Arrêtés' END) || ' — lot '
    || (CASE ${l}."numeroFichier" ${Array.from({ length: 39 }, (_, i) => `WHEN ${i + 1} THEN '${romain(i + 1)}'`).join(' ')} ELSE ${l}."numeroFichier"::text END)
  WHEN ${l}.rang IS NULL THEN 'Lot ' || ${l}.numero
  ELSE (CASE ${l}."typeTexte" WHEN 'ARRETE' THEN 'Arrêtés' WHEN 'DECRET_PM' THEN 'Décrets PM' ELSE 'Décrets PR' END)
    || ' ' || (CASE WHEN ${l}.autres THEN 'quota « Autres »' WHEN ${l}.quota IS NULL THEN 'sans quota' ELSE 'quota ' || ${l}.quota END)
    || ' — lot ' || ${l}.rang END`;
