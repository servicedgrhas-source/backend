/**
 * Outils Cloudflare R2 (stockage des scans).
 *
 *   npm run r2:tester            vérifie la connexion : bucket, envoi, lecture, suppression d'un fichier test
 *   npm run r2:migrer            recopie dans R2 les fichiers déjà gardés sur le disque (uploads/)
 *   npm run r2:migrer -- --essai même chose pour le serveur d'essai (uploads-essai/ -> dossier « essai/ »)
 *
 * La migration ne supprime rien sur le disque : une fois tout vérifié, le dossier uploads/
 * peut être archivé. Elle peut être relancée sans risque (les fichiers déjà dans R2 sont sautés).
 */
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

process.chdir(path.join(__dirname, '..')); // le fichier .env et uploads/ sont dans backend/
require('dotenv').config({ quiet: true });

const {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');

const essai = process.argv.includes('--essai');
const UPLOAD_DIR = path.resolve(essai ? './uploads-essai' : (process.env.UPLOAD_DIR ?? './uploads'));
const PREFIXE = (essai ? 'essai' : (process.env.R2_PREFIXE ?? '')).replace(/^\/+|\/+$/g, '');
const BUCKET = process.env.R2_BUCKET;
const DOSSIERS = ['pieces', 'justificatifs', 'notes-signees'];
const NOM_SUR = /^[0-9a-f-]{36}\.[a-z0-9]{1,5}$/;
const TYPES = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

function client() {
  const manque = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'].filter((k) => !process.env[k]);
  if (!process.env.R2_ENDPOINT && !process.env.R2_ACCOUNT_ID) manque.push('R2_ACCOUNT_ID (ou R2_ENDPOINT)');
  if (manque.length) {
    console.error(`Variables manquantes dans backend/.env : ${manque.join(', ')}`);
    process.exit(1);
  }
  return new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
    forcePathStyle: true,
    requestHandler: { connectionTimeout: 5000, requestTimeout: 30000 },
    maxAttempts: 2,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

const cle = (dossier, nom) => [PREFIXE, dossier, nom].filter(Boolean).join('/');
const statut = (e) => e?.$metadata?.httpStatusCode;

async function bucketPret(s3) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
    console.log(`✔ Bucket « ${BUCKET} » trouvé`);
  } catch (e) {
    if (statut(e) !== 404) throw e;
    console.log(`… Bucket « ${BUCKET} » absent : création`);
    try {
      await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
      console.log(`✔ Bucket « ${BUCKET} » créé`);
    } catch (e2) {
      console.error(
        `✘ Impossible de créer le bucket (${e2.name}). Créez « ${BUCKET} » dans Cloudflare (R2 > Create bucket), ` +
          'ou donnez au jeton les droits « Admin Read & Write », puis relancez.',
      );
      process.exit(1);
    }
  }
}

async function tester() {
  const s3 = client();
  console.log(`Connexion à ${process.env.R2_ENDPOINT || process.env.R2_ACCOUNT_ID + '.r2.cloudflarestorage.com'}`);
  await bucketPret(s3);
  const Key = cle('test', `${randomUUID()}.txt`);
  const contenu = `Test DGRHAS ${new Date().toISOString()}`;
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key, Body: contenu, ContentType: 'text/plain' }));
  console.log(`✔ Envoi d'un fichier test (${Key})`);
  const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key }));
  const lu = await r.Body.transformToString();
  if (lu !== contenu) throw new Error('Le fichier relu ne correspond pas au fichier envoyé');
  console.log('✔ Relecture identique');
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key }));
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key }));
    throw new Error('Le fichier test existe encore après suppression');
  } catch (e) {
    if (statut(e) !== 404) throw e;
  }
  console.log('✔ Suppression');
  console.log('\nCloudflare R2 est prêt : redémarrez le backend, les nouveaux scans y seront envoyés.');
}

async function migrer() {
  const s3 = client();
  await bucketPret(s3);
  console.log(`Disque : ${UPLOAD_DIR}${PREFIXE ? `  ->  R2 : ${BUCKET}/${PREFIXE}/` : `  ->  R2 : ${BUCKET}/`}\n`);
  const bilan = { envoyes: 0, dejaLa: 0, ignores: 0, erreurs: 0, octets: 0 };
  for (const dossier of DOSSIERS) {
    const rep = path.join(UPLOAD_DIR, dossier);
    if (!fs.existsSync(rep)) {
      console.log(`- ${dossier} : aucun dossier sur le disque`);
      continue;
    }
    const noms = fs.readdirSync(rep).filter((n) => fs.statSync(path.join(rep, n)).isFile());
    let n = 0;
    for (const nom of noms) {
      if (!NOM_SUR.test(nom)) {
        bilan.ignores++;
        console.log(`  ignoré (nom inattendu) : ${dossier}/${nom}`);
        continue;
      }
      const Key = cle(dossier, nom);
      try {
        await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key }));
        bilan.dejaLa++;
        continue;
      } catch (e) {
        if (statut(e) !== 404) {
          bilan.erreurs++;
          console.error(`  ✘ ${Key} : ${e.name}`);
          continue;
        }
      }
      try {
        const corps = fs.readFileSync(path.join(rep, nom));
        await s3.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key,
            Body: corps,
            ContentType: TYPES[path.extname(nom)] ?? 'application/octet-stream',
          }),
        );
        bilan.envoyes++;
        bilan.octets += corps.length;
        n++;
      } catch (e) {
        bilan.erreurs++;
        console.error(`  ✘ ${Key} : ${e.name} — ${e.message}`);
      }
    }
    console.log(`- ${dossier} : ${noms.length} fichier(s) sur le disque, ${n} envoyé(s)`);
  }
  console.log(
    `\nBilan : ${bilan.envoyes} envoyé(s) (${(bilan.octets / 1048576).toFixed(1)} Mo), ` +
      `${bilan.dejaLa} déjà dans R2, ${bilan.ignores} ignoré(s), ${bilan.erreurs} erreur(s).`,
  );
  if (bilan.erreurs) process.exit(1);
  console.log('Rien n’a été supprimé du disque : gardez uploads/ en sauvegarde tant que tout n’est pas vérifié.');
}

const action = process.argv[2];
(action === 'migrer' ? migrer : action === 'tester' ? tester : null)?.()
  .catch((e) => {
    console.error(`\n✘ Échec : ${e.name} — ${e.message}`);
    if (['TimeoutError', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(e.name) || /timeout|ETIMEDOUT|ENOTFOUND/i.test(e.message))
      console.error('  R2 ne répond pas depuis ce réseau : vérifiez la connexion, le DNS, le pare-feu ou l’antivirus.');
    if (statut(e) === 403 || e.name === 'InvalidAccessKeyId' || e.name === 'SignatureDoesNotMatch')
      console.error('  Vérifiez R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY et les droits du jeton sur ce bucket.');
    process.exit(1);
  }) ?? (console.log('Usage : node scripts/r2.js tester | migrer [--essai]'), process.exit(1));
