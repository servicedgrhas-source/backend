/**
 * Montant en toutes lettres, comme sur les états signés :
 * 8 205 000 → « huit millions deux cent cinq mille ».
 * Orthographe traditionnelle (« vingt et un », « quatre-vingts », « cent » invariable devant un nombre).
 */
const UNITES = [
  'zéro',
  'un',
  'deux',
  'trois',
  'quatre',
  'cinq',
  'six',
  'sept',
  'huit',
  'neuf',
  'dix',
  'onze',
  'douze',
  'treize',
  'quatorze',
  'quinze',
  'seize',
  'dix-sept',
  'dix-huit',
  'dix-neuf',
];
const DIZAINES = [
  '',
  '',
  'vingt',
  'trente',
  'quarante',
  'cinquante',
  'soixante',
];

function moinsDeCent(n: number): string {
  if (n < 20) return UNITES[n];
  const d = Math.floor(n / 10);
  const u = n % 10;
  if (d === 7 || d === 9) {
    // 70-79 : soixante-dix… ; 90-99 : quatre-vingt-dix…
    const base = d === 7 ? 'soixante' : 'quatre-vingt';
    const reste = 10 + u;
    if (d === 7 && u === 1) return 'soixante et onze';
    return `${base}-${UNITES[reste]}`;
  }
  if (d === 8) return u === 0 ? 'quatre-vingts' : `quatre-vingt-${UNITES[u]}`;
  if (u === 0) return DIZAINES[d];
  if (u === 1) return `${DIZAINES[d]} et un`;
  return `${DIZAINES[d]}-${UNITES[u]}`;
}

function moinsDeMille(n: number): string {
  const c = Math.floor(n / 100);
  const r = n % 100;
  if (c === 0) return moinsDeCent(r);
  const cent = c === 1 ? 'cent' : `${UNITES[c]} cent${r === 0 ? 's' : ''}`;
  return r === 0 ? cent : `${cent} ${moinsDeCent(r)}`;
}

export function nombreEnLettres(n: number): string {
  n = Math.round(Math.abs(n));
  if (n === 0) return 'zéro';
  const parties: string[] = [];
  const milliards = Math.floor(n / 1e9);
  const millions = Math.floor((n % 1e9) / 1e6);
  const milliers = Math.floor((n % 1e6) / 1e3);
  const reste = n % 1e3;
  if (milliards)
    parties.push(
      `${moinsDeMille(milliards)} milliard${milliards > 1 ? 's' : ''}`,
    );
  if (millions)
    parties.push(`${moinsDeMille(millions)} million${millions > 1 ? 's' : ''}`);
  // « mille » invariable ; « cent » et « quatre-vingt » ne prennent pas de s devant « mille »
  if (milliers)
    parties.push(
      milliers === 1
        ? 'mille'
        : `${moinsDeMille(milliers).replace(/(cent|vingt)s$/, '$1')} mille`,
    );
  if (reste) parties.push(moinsDeMille(reste));
  return parties.join(' ');
}

/** « HUIT MILLIONS DEUX CENT CINQ MILLE (8.205.000) FCFA » */
export function montantArrete(n: number): string {
  const chiffres = Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${nombreEnLettres(n).toUpperCase()} (${chiffres}) FCFA`;
}
