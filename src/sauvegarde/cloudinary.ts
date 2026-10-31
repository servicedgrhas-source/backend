import { createHash } from 'crypto';

/**
 * Envoi des sauvegardes chez Cloudinary (DG, 31/10/2026), sans bibliothèque : l'API d'envoi et
 * d'administration de Cloudinary, appelée directement. Les fichiers sont « raw » et privés
 * (type « authenticated ») : aucune adresse publique ; on les récupère par un lien signé qui expire.
 *
 * Réglage : CLOUDINARY_URL=cloudinary://CLE:SECRET@NOM_DU_CLOUD (tableau de bord Cloudinary),
 * ou CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY et CLOUDINARY_API_SECRET.
 */
export interface Identifiants {
  cloud: string;
  cle: string;
  secret: string;
}

/** Dossier Cloudinary des sauvegardes. */
export const DOSSIER = 'sauvegardes-sigrhas';
/** Morceaux de l'envoi (Cloudinary demande au moins 5 Mo par morceau, sauf le dernier). */
const MORCEAU = 6 * 1024 * 1024;

const api = () =>
  (process.env.CLOUDINARY_API ?? 'https://api.cloudinary.com').replace(
    /\/$/,
    '',
  );

export function identifiants(): Identifiants | null {
  const url = process.env.CLOUDINARY_URL?.trim();
  if (url) {
    const m = /^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/.exec(url);
    if (m) return { cle: m[1], secret: m[2], cloud: m[3] };
  }
  const cloud = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  const cle = process.env.CLOUDINARY_API_KEY?.trim();
  const secret = process.env.CLOUDINARY_API_SECRET?.trim();
  return cloud && cle && secret ? { cloud, cle, secret } : null;
}

/** Signature Cloudinary : paramètres triés « a=1&b=2 » suivis du secret, en SHA-1. */
export function signer(
  params: Record<string, string | number>,
  secret: string,
) {
  const chaine = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return createHash('sha1')
    .update(chaine + secret)
    .digest('hex');
}

async function lireReponse(r: Response) {
  const texte = await r.text();
  let corps: { error?: { message?: string } } & Record<string, unknown> = {};
  try {
    corps = JSON.parse(texte) as typeof corps;
  } catch {
    // réponse non JSON : on garde le texte pour le message d'erreur
  }
  if (!r.ok)
    throw new Error(
      `Cloudinary a refusé l'envoi (${r.status}) : ${corps.error?.message ?? texte.slice(0, 200)}`,
    );
  return corps;
}

/** Envoie le fichier (privé), en morceaux. Renvoie ce que Cloudinary a enregistré. */
export async function envoyer(
  id: Identifiants,
  contenu: Buffer,
  nomFichier: string,
) {
  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = `${DOSSIER}/${nomFichier}`;
  const params = {
    public_id: publicId,
    timestamp,
    type: 'authenticated',
  };
  const signature = signer(params, id.secret);
  const unique = `sigrhas-${timestamp}-${Math.random().toString(36).slice(2, 10)}`;
  let dernier: { public_id?: string; bytes?: number; created_at?: string } = {};
  for (let debut = 0; debut < contenu.length || debut === 0; debut += MORCEAU) {
    const fin = Math.min(contenu.length, debut + MORCEAU);
    const corps = new FormData();
    corps.append(
      'file',
      new Blob([new Uint8Array(contenu.subarray(debut, fin))]),
      nomFichier,
    );
    corps.append('public_id', publicId);
    corps.append('timestamp', String(timestamp));
    corps.append('type', 'authenticated');
    corps.append('api_key', id.cle);
    corps.append('signature', signature);
    const r = await fetch(`${api()}/v1_1/${id.cloud}/raw/upload`, {
      method: 'POST',
      headers: {
        'X-Unique-Upload-Id': unique,
        'Content-Range': `bytes ${debut}-${Math.max(fin - 1, 0)}/${contenu.length}`,
      },
      body: corps,
    });
    dernier = (await lireReponse(r)) as typeof dernier;
    if (fin >= contenu.length) break;
  }
  return {
    publicId: dernier.public_id ?? publicId,
    octets: Number(dernier.bytes ?? contenu.length),
    creeLe: dernier.created_at ?? new Date().toISOString(),
  };
}

/** Les sauvegardes déjà chez Cloudinary, les plus récentes d'abord. */
export async function lister(id: Identifiants) {
  const auth = Buffer.from(`${id.cle}:${id.secret}`).toString('base64');
  const r = await fetch(
    `${api()}/v1_1/${id.cloud}/resources/raw/authenticated?prefix=${encodeURIComponent(`${DOSSIER}/`)}&max_results=50`,
    { headers: { Authorization: `Basic ${auth}` } },
  );
  const corps = (await lireReponse(r)) as {
    resources?: { public_id: string; bytes: number; created_at: string }[];
  };
  return (corps.resources ?? [])
    .map((x) => ({
      publicId: x.public_id,
      nom: x.public_id.slice(DOSSIER.length + 1),
      octets: x.bytes,
      creeLe: x.created_at,
    }))
    .sort((a, b) => b.creeLe.localeCompare(a.creeLe));
}

/** Lien signé qui télécharge une sauvegarde privée ; il expire au bout de quelques minutes. */
export function lienTelechargement(id: Identifiants, publicId: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  const params = {
    public_id: publicId,
    timestamp,
    type: 'authenticated',
    expires_at: timestamp + 300,
    attachment: 'true',
  };
  const q = new URLSearchParams({
    ...Object.fromEntries(
      Object.entries(params).map(([k, v]) => [k, String(v)]),
    ),
    api_key: id.cle,
    signature: signer(params, id.secret),
  });
  return `${api()}/v1_1/${id.cloud}/raw/download?${q.toString()}`;
}
