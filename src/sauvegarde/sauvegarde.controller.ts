import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { createGzip } from 'zlib';
import { Roles, Utilisateur, type UtilisateurConnecte } from '../auth/auth';
import { JournalService } from '../core/core.service';
import {
  DOSSIER,
  envoyer,
  identifiants,
  lienTelechargement,
  lister,
} from './cloudinary';
import {
  ACTION_CLOUDINARY,
  ACTION_SAUVEGARDE,
  SauvegardeService,
} from './sauvegarde.service';

/** « sauvegarde-sigrhas-20261031-2145.sql.gz » */
function nomFichier() {
  const d = new Date();
  const deux = (n: number) => String(n).padStart(2, '0');
  return `sauvegarde-sigrhas-${d.getFullYear()}${deux(d.getMonth() + 1)}${deux(d.getDate())}-${deux(d.getHours())}${deux(d.getMinutes())}.sql.gz`;
}

/**
 * Sauvegarde de la base (Administration › Sauvegarde) : réservée au DG et à l'administrateur,
 * jamais ouverte par les droits par rubrique (toutes les données nominatives sont dedans).
 */
@Controller('sauvegarde')
export class SauvegardeController {
  constructor(
    private readonly service: SauvegardeService,
    private readonly journal: JournalService,
  ) {}

  @Roles('DG', 'ADMIN')
  @Get('apercu')
  apercu() {
    return this.service.apercu();
  }

  /** Le fichier .sql.gz, écrit au fur et à mesure (la mémoire du serveur reste petite). */
  @Roles('DG', 'ADMIN')
  @Get('telecharger')
  async telecharger(
    @Utilisateur() u: UtilisateurConnecte,
    @Res() res: Response,
  ) {
    const nom = nomFichier();
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${nom}"`);
    res.setHeader('Cache-Control', 'no-store');
    const gzip = createGzip({ level: 9 });
    gzip.pipe(res);
    try {
      const r = await this.service.ecrire(gzip, u.nom);
      gzip.end();
      await this.journal.log(u, ACTION_SAUVEGARDE, 'base', null, {
        fichier: nom,
        ...r,
      });
    } catch (e) {
      // Fichier incomplet : il se termine par une erreur au lieu de « COMMIT » (rien ne serait restauré)
      gzip.end(
        `\n-- ERREUR : sauvegarde incomplète (${(e as Error).message})\nROLLBACK;\n`,
      );
    }
  }

  /** Cloudinary : réglé ou non, et les sauvegardes qui y sont déjà. */
  @Roles('DG', 'ADMIN')
  @Get('cloudinary')
  async cloudinary() {
    const id = identifiants();
    if (!id)
      return { configure: false, cloud: null, fichiers: [], erreur: null };
    try {
      return {
        configure: true,
        cloud: id.cloud,
        fichiers: await lister(id),
        erreur: null,
      };
    } catch (e) {
      return {
        configure: true,
        cloud: id.cloud,
        fichiers: [],
        erreur: (e as Error).message,
      };
    }
  }

  /** Prépare la sauvegarde et l'envoie chez Cloudinary (fichier privé). */
  @Roles('DG', 'ADMIN')
  @Post('cloudinary')
  async envoyerCloudinary(@Utilisateur() u: UtilisateurConnecte) {
    const id = identifiants();
    if (!id)
      throw new BadRequestException(
        "Cloudinary n'est pas réglé sur le serveur (CLOUDINARY_URL).",
      );
    const nom = nomFichier();
    const gzip = createGzip({ level: 9 });
    const morceaux: Buffer[] = [];
    gzip.on('data', (m: Buffer) => morceaux.push(m));
    const fini = new Promise<void>((ok, ko) => {
      gzip.on('end', ok);
      gzip.on('error', ko);
    });
    const r = await this.service.ecrire(gzip, u.nom);
    gzip.end();
    await fini;
    const envoi = await envoyer(id, Buffer.concat(morceaux), nom);
    await this.journal.log(u, ACTION_CLOUDINARY, 'base', null, {
      fichier: nom,
      ...r,
      ...envoi,
    });
    return { fichier: nom, ...r, ...envoi };
  }

  /** Lien signé (5 minutes) pour récupérer une sauvegarde gardée chez Cloudinary. */
  @Roles('DG', 'ADMIN')
  @Get('cloudinary/lien')
  async lienCloudinary(
    @Utilisateur() u: UtilisateurConnecte,
    @Query('publicId') publicId?: string,
  ) {
    const id = identifiants();
    if (!id)
      throw new BadRequestException(
        "Cloudinary n'est pas réglé sur le serveur (CLOUDINARY_URL).",
      );
    if (!publicId?.startsWith(`${DOSSIER}/`))
      throw new BadRequestException('Sauvegarde inconnue');
    await this.journal.log(u, 'SAUVEGARDE_CLOUDINARY_RECUPEREE', 'base', null, {
      publicId,
    });
    return { url: lienTelechargement(id, publicId) };
  }
}
