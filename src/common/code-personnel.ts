import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Code personnel de 12 caractères (ex. « T3G8-GH6J-FG3U »), demandé à la connexion en plus de
 * l'e-mail et du mot de passe. Il est gardé chiffré (et non haché) parce que l'administrateur et
 * le DG doivent pouvoir le relire pour le remettre à la personne.
 *
 * Clé : CODE_SECRET (à part de JWT_SECRET, pour pouvoir changer l'un sans perdre l'autre).
 * Sans CODE_SECRET, la clé vient de JWT_SECRET, comme au début : les codes déjà créés restent
 * lisibles. Quand CODE_SECRET est ajouté, les codes sont re-chiffrés avec lui au démarrage
 * (voir `rechiffrerCode`) ; ensuite seulement, JWT_SECRET peut être changé.
 */

/** Sans caractère ambigu (ni 0/O, ni 1/I/L) : le code est recopié à la main. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function nouveauCode(): string {
  // Tirage sans biais : on rejette les octets au-delà du dernier multiple de 31
  const limite = 256 - (256 % ALPHABET.length);
  let lettres = '';
  while (lettres.length < 12)
    for (const o of randomBytes(16))
      if (o < limite && lettres.length < 12)
        lettres += ALPHABET[o % ALPHABET.length];
  return `${lettres.slice(0, 4)}-${lettres.slice(4, 8)}-${lettres.slice(8)}`;
}

/** « t3g8 gh6j-fg3u » → « T3G8GH6JFG3U » (tirets, espaces et minuscules acceptés). */
export const normaliserCode = (c: string | null | undefined) =>
  (c ?? '').replace(/[\s-]/g, '').toUpperCase();

const derive = (secret: string) =>
  createHash('sha256').update(`${secret}:code-personnel`).digest();

/** Clé de chiffrement actuelle. */
function cle(): Buffer {
  const secret = process.env.CODE_SECRET || process.env.JWT_SECRET;
  if (!secret)
    throw new Error(
      'CODE_SECRET / JWT_SECRET manquant : impossible de chiffrer les codes.',
    );
  return derive(secret);
}

/** Ancienne clé (tirée de JWT_SECRET), encore acceptée en lecture quand CODE_SECRET existe. */
function ancienneCle(): Buffer | null {
  return process.env.CODE_SECRET && process.env.JWT_SECRET
    ? derive(process.env.JWT_SECRET)
    : null;
}

export function chiffrerCode(code: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', cle(), iv);
  const donnees = Buffer.concat([
    c.update(normaliserCode(code), 'utf8'),
    c.final(),
  ]);
  return [iv, c.getAuthTag(), donnees]
    .map((b) => b.toString('base64'))
    .join('.');
}

function dechiffrerAvec(chiffre: string, k: Buffer): string | null {
  try {
    const [iv, tag, donnees] = chiffre
      .split('.')
      .map((x) => Buffer.from(x, 'base64'));
    const d = createDecipheriv('aes-256-gcm', k, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(donnees), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Code en clair (« XXXX-XXXX-XXXX »), ou null s'il est illisible. */
export function dechiffrerCode(chiffre: string): string | null {
  const ancienne = ancienneCle();
  const brut =
    dechiffrerAvec(chiffre, cle()) ??
    (ancienne ? dechiffrerAvec(chiffre, ancienne) : null);
  return brut
    ? `${brut.slice(0, 4)}-${brut.slice(4, 8)}-${brut.slice(8)}`
    : null;
}

/**
 * Code chiffré avec l'ancienne clé : le re-chiffre avec la clé actuelle.
 * Retourne null s'il n'y a rien à faire (déjà à jour, ou illisible).
 */
export function rechiffrerCode(chiffre: string): string | null {
  const ancienne = ancienneCle();
  if (!ancienne || dechiffrerAvec(chiffre, cle())) return null;
  const brut = dechiffrerAvec(chiffre, ancienne);
  return brut ? chiffrerCode(brut) : null;
}

/** Le code saisi correspond-il au code gardé ? (comparaison à temps constant) */
export function codeValide(saisi: string | null | undefined, chiffre: string) {
  const vrai = dechiffrerCode(chiffre);
  if (!vrai) return false;
  const a = Buffer.from(normaliserCode(saisi).padEnd(12).slice(0, 32));
  const b = Buffer.from(normaliserCode(vrai).padEnd(12).slice(0, 32));
  return a.length === b.length && timingSafeEqual(a, b);
}
