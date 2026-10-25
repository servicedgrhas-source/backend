import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import type { Readable } from 'node:stream';

/**
 * Dossiers des fichiers gardés par le système (tous des scans) :
 * - pieces : scans des textes de la FP et autres pièces des dossiers de recrutement ;
 * - justificatifs : pièces des demandes de mutation (portail, saisie, ancien justificatif unique) ;
 * - notes-signees : scans PDF des notes signées par le ministre (archives).
 */
export type DossierStockage =
  'pieces' | 'justificatifs' | 'notes-signees' | 'recensement';

/** Fichiers envoyés en même temps au stockage : plus vite qu'un à un, sans saturer le lien. */
export const ENVOIS_SIMULTANES = 4;

/**
 * Applique `f` à chaque élément, au plus `n` à la fois ; les résultats gardent l'ordre
 * des éléments, et un échec n'arrête pas les autres.
 */
export async function parallele<T, R>(
  elements: T[],
  n: number,
  f: (x: T, i: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const issues: PromiseSettledResult<R>[] = [];
  let suivant = 0;
  const ouvrier = async () => {
    while (suivant < elements.length) {
      const i = suivant++;
      try {
        issues[i] = { status: 'fulfilled', value: await f(elements[i], i) };
      } catch (e: unknown) {
        issues[i] = { status: 'rejected', reason: e };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(n, elements.length) }, () => ouvrier()),
  );
  return issues;
}

/** Nom neutre (uuid + extension) : jamais le nom d'origine, qui reste en base. */
const NOM_SUR = /^[0-9a-f-]{36}\.[a-z0-9]{1,5}$/;

/**
 * Stockage des fichiers : Cloudflare R2 (API compatible S3) quand il est configuré,
 * sinon le disque local (UPLOAD_DIR), comme avant.
 *
 * En base, on ne garde que le nom du fichier (« 3f2a….pdf ») : la clé R2 est
 * « [préfixe/]dossier/nom ». Un fichier d'avant le passage à R2, pas encore recopié,
 * est encore lu sur le disque local : rien ne se perd pendant la migration.
 */
@Injectable()
export class StockageService implements OnModuleInit {
  private readonly log = new Logger('Stockage');
  private readonly racineLocale = resolve(
    process.env.UPLOAD_DIR ?? './uploads',
  );
  private readonly bucket = process.env.R2_BUCKET ?? '';
  /** « essai » pour le serveur d'essai : ses fichiers ne se mêlent pas aux vrais. */
  private readonly prefixe = (process.env.R2_PREFIXE ?? '').replace(
    /^\/+|\/+$/g,
    '',
  );
  private readonly client: S3Client | null = creerClient();

  /** true : les nouveaux fichiers partent dans R2. */
  get distant() {
    return !!this.client;
  }

  onModuleInit() {
    if (!this.client) {
      this.log.log(
        `Fichiers gardés sur le disque local : ${this.racineLocale}`,
      );
      return;
    }
    // Vérification en arrière-plan : un R2 lent ou injoignable ne retarde pas le démarrage
    void this.verifierBucket();
  }

  private async verifierBucket() {
    if (!this.client) return;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      this.log.log(
        `Fichiers gardés dans Cloudflare R2 (bucket « ${this.bucket} »${this.prefixe ? `, dossier « ${this.prefixe}/ »` : ''})`,
      );
    } catch (e) {
      // Le serveur démarre quand même : l'erreur reviendra, lisible, au premier envoi
      this.log.error(
        `Cloudflare R2 injoignable ou bucket « ${this.bucket} » absent : ${messageErreur(e)}`,
      );
    }
  }

  private cle(dossier: DossierStockage, nom: string) {
    return [this.prefixe, dossier, nom].filter(Boolean).join('/');
  }

  private cheminLocal(dossier: DossierStockage, nom: string) {
    return resolve(this.racineLocale, dossier, nom);
  }

  /**
   * Garde un fichier reçu (multer en mémoire) et renvoie son nom neutre. Le nom est aussi
   * écrit dans `f.filename`, là où les services le lisaient quand multer écrivait sur le disque.
   */
  async enregistrer(
    dossier: DossierStockage,
    f: Express.Multer.File,
  ): Promise<string> {
    const ext = extname(f.originalname)
      .toLowerCase()
      .replace(/[^.a-z0-9]/g, '');
    const nom = `${randomUUID()}${ext || '.bin'}`;
    if (this.client) {
      try {
        await this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: this.cle(dossier, nom),
            Body: f.buffer,
            ContentType: f.mimetype || 'application/octet-stream',
            ContentLength: f.buffer.length,
          }),
        );
      } catch (e) {
        this.log.error(`Envoi vers R2 refusé : ${messageErreur(e)}`);
        throw new ServiceUnavailableException(
          "Le fichier n'a pas pu être enregistré (stockage en ligne injoignable). Réessayez dans un instant.",
        );
      }
    } else {
      await mkdir(resolve(this.racineLocale, dossier), { recursive: true });
      await writeFile(this.cheminLocal(dossier, nom), f.buffer);
    }
    f.filename = nom;
    return nom;
  }

  /** Garde plusieurs fichiers (quelques-uns à la fois) ; si l'un échoue, ceux déjà gardés sont retirés. */
  async enregistrerTous(
    dossier: DossierStockage,
    fichiers: Express.Multer.File[],
  ) {
    const issues = await parallele(fichiers, ENVOIS_SIMULTANES, (f) =>
      this.enregistrer(dossier, f),
    );
    const echec = issues.find((r) => r.status === 'rejected');
    if (!echec)
      return issues.map((r) => (r as PromiseFulfilledResult<string>).value);
    await Promise.all(
      issues.flatMap((r) =>
        r.status === 'fulfilled' ? [this.supprimer(dossier, r.value)] : [],
      ),
    );
    throw echec.reason;
  }

  /** Retire un fichier (sans erreur s'il n'existe plus). Les deux emplacements sont nettoyés. */
  async supprimer(dossier: DossierStockage, nom: string | null | undefined) {
    if (!nom || !NOM_SUR.test(nom)) return;
    if (this.client)
      await this.client
        .send(
          new DeleteObjectCommand({
            Bucket: this.bucket,
            Key: this.cle(dossier, nom),
          }),
        )
        .catch((e) =>
          this.log.warn(`Suppression R2 de ${nom} : ${messageErreur(e)}`),
        );
    await unlink(this.cheminLocal(dossier, nom)).catch(() => undefined);
  }

  /** Envoie le fichier au navigateur (après les contrôles d'accès faits par l'appelant). */
  async servir(
    res: Response,
    dossier: DossierStockage,
    nom: string,
    o: { mime?: string | null; nomAffiche?: string | null } = {},
  ) {
    if (!NOM_SUR.test(nom)) throw new NotFoundException('Fichier introuvable');
    const entetes = (type: string | undefined, taille?: number) => {
      res.setHeader(
        'Content-Type',
        o.mime || type || 'application/octet-stream',
      );
      if (taille !== undefined) res.setHeader('Content-Length', String(taille));
      if (o.nomAffiche)
        res.setHeader(
          'Content-Disposition',
          `inline; filename*=UTF-8''${encodeURIComponent(o.nomAffiche)}`,
        );
      res.setHeader('Cache-Control', 'private, no-store');
    };

    // Fichier encore sur le disque (d'avant le passage à R2) : lu tout de suite, sans réseau
    const chemin = this.cheminLocal(dossier, nom);
    if (existsSync(chemin)) {
      entetes(undefined, (await stat(chemin)).size);
      await envoyerFlux(createReadStream(chemin), res);
      return;
    }

    if (this.client) {
      try {
        const r = await this.client.send(
          new GetObjectCommand({
            Bucket: this.bucket,
            Key: this.cle(dossier, nom),
          }),
        );
        entetes(r.ContentType, r.ContentLength);
        await envoyerFlux(r.Body as Readable, res);
        return;
      } catch (e) {
        if (!estAbsent(e)) {
          this.log.error(`Lecture R2 de ${nom} : ${messageErreur(e)}`);
          throw new ServiceUnavailableException(
            'Fichier momentanément indisponible (stockage en ligne injoignable).',
          );
        }
      }
    }
    throw new NotFoundException('Fichier introuvable');
  }
}

function creerClient(): S3Client | null {
  const mode = (process.env.STOCKAGE ?? '').toLowerCase();
  const id = process.env.R2_ACCESS_KEY_ID;
  const secret = process.env.R2_SECRET_ACCESS_KEY;
  const compte = process.env.R2_ACCOUNT_ID;
  const adresse =
    process.env.R2_ENDPOINT ||
    (compte ? `https://${compte}.r2.cloudflarestorage.com` : '');
  if (mode === 'local') return null;
  if (!id || !secret || !adresse || !process.env.R2_BUCKET) {
    if (mode === 'r2')
      throw new Error(
        'STOCKAGE=r2 : renseignez R2_ACCOUNT_ID (ou R2_ENDPOINT), R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY et R2_BUCKET.',
      );
    return null;
  }
  return new S3Client({
    region: 'auto',
    endpoint: adresse,
    credentials: { accessKeyId: id, secretAccessKey: secret },
    forcePathStyle: true,
    // Réseau qui ne joint pas R2 : échouer vite avec un message clair, sans bloquer la requête
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 },
    maxAttempts: 2,
    // R2 n'accepte pas toutes les sommes de contrôle ajoutées par défaut par le SDK récent
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

function estAbsent(e: unknown) {
  return (
    e instanceof S3ServiceException &&
    (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404)
  );
}

function messageErreur(e: unknown) {
  return e instanceof Error ? `${e.name} — ${e.message}` : String(e);
}

function envoyerFlux(source: Readable, res: Response) {
  return new Promise<void>((ok, ko) => {
    source.on('error', (e) => {
      // Coupure en cours d'envoi : les en-têtes sont partis, on ferme simplement
      if (res.headersSent) {
        res.destroy();
        ok();
      } else ko(e);
    });
    res.on('finish', ok);
    res.on('close', ok);
    source.pipe(res);
  });
}
