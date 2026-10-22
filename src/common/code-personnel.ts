import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

/**
 * Code personnel de 12 caractères (ex. « T3G8-GH6J-FG3U »), demandé à la connexion en plus de
 * l'e-mail et du mot de passe. Il est gardé chiffré (et non haché) parce que l'administrateur et
 * le DG doivent pouvoir le relire pour le remettre à la personne.
 */

/** Sans caractère ambigu (ni 0/O, ni 1/I/L) : le code est recopié à la main. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function nouveauCode(): string {
  const lettres = Array.from(
    randomBytes(12),
    (o) => ALPHABET[o % ALPHABET.length],
  ).join('');
  return `${lettres.slice(0, 4)}-${lettres.slice(4, 8)}-${lettres.slice(8)}`;
}

/** « t3g8 gh6j-fg3u » → « T3G8GH6JFG3U » (tirets, espaces et minuscules acceptés). */
export const normaliserCode = (c: string | null | undefined) =>
  (c ?? '').replace(/[\s-]/g, '').toUpperCase();

function cle() {
  const secret = process.env.JWT_SECRET;
  if (!secret)
    throw new Error('JWT_SECRET manquant : impossible de chiffrer les codes.');
  return createHash('sha256').update(`${secret}:code-personnel`).digest();
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

export function dechiffrerCode(chiffre: string): string | null {
  try {
    const [iv, tag, donnees] = chiffre
      .split('.')
      .map((x) => Buffer.from(x, 'base64'));
    const d = createDecipheriv('aes-256-gcm', cle(), iv);
    d.setAuthTag(tag);
    const brut = Buffer.concat([d.update(donnees), d.final()]).toString('utf8');
    return `${brut.slice(0, 4)}-${brut.slice(4, 8)}-${brut.slice(8)}`;
  } catch {
    return null;
  }
}

/** Le code saisi correspond-il au code gardé ? */
export function codeValide(saisi: string | null | undefined, chiffre: string) {
  const vrai = dechiffrerCode(chiffre);
  return !!vrai && normaliserCode(saisi) === normaliserCode(vrai);
}
