import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import {
  Public,
  Roles,
  ROLES_TRAITEMENT,
  Utilisateur,
  type UtilisateurConnecte,
} from '../auth/auth';
import { StockageService } from '../common/stockage';
import {
  type DepotPrestation,
  type FiltresPrestations,
  PrestationsService,
} from './prestations.service';

const FICHIERS = FilesInterceptor('fichiers', 15, {
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, f, cb) =>
    cb(null, /\.(pdf|jpe?g|png)$/i.test(f.originalname)),
});

/** Formulaire envoyé en multipart : `donnees` (JSON) et un libellé par fichier. */
function lire(
  donnees: string | undefined,
  libelles: string | string[] | undefined,
  fichiers: Express.Multer.File[],
) {
  let dto: DepotPrestation;
  try {
    dto = JSON.parse(donnees ?? '{}') as DepotPrestation;
  } catch {
    throw new BadRequestException('Formulaire illisible.');
  }
  const libs = Array.isArray(libelles) ? libelles : libelles ? [libelles] : [];
  return {
    dto,
    fichiers: fichiers.map((f, i) => ({
      f,
      libelle: libs[i]?.slice(0, 200) || 'Pièce jointe',
    })),
  };
}

/** Demandes de prestations (module à part des mutations), depuis les comptes. */
@Roles(...ROLES_TRAITEMENT, 'DDEPPSA', 'STRUCTURE')
@Controller('demandes-prestation')
export class PrestationsController {
  constructor(
    private readonly service: PrestationsService,
    private readonly stockage: StockageService,
  ) {}

  @Get('catalogue')
  catalogue() {
    return this.service.catalogue();
  }

  @Get()
  liste(
    @Utilisateur() u: UtilisateurConnecte,
    @Query() q: Record<string, string | undefined>,
  ) {
    return this.service.liste(u, {
      onglet: ['aTraiter', 'aSuivre', 'toutes'].includes(q.onglet ?? '')
        ? (q.onglet as FiltresPrestations['onglet'])
        : 'aTraiter',
      type: q.type || undefined,
      etat: q.etat || undefined,
      recherche: q.recherche || undefined,
    });
  }

  @Get('compteur')
  compteur(@Utilisateur() u: UtilisateurConnecte) {
    return this.service.compteur(u);
  }

  /** Dépôt pour un agent de la base du personnel (pièces scannées jointes). */
  @Post('agents/:agentId')
  @UseInterceptors(FICHIERS)
  deposer(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('agentId', ParseIntPipe) agentId: number,
    @UploadedFiles() fichiers: Express.Multer.File[] = [],
    @Body('donnees') donnees?: string,
    @Body('libelles') libelles?: string | string[],
  ) {
    const l = lire(donnees, libelles, fichiers);
    return this.service.deposerPourAgent(u, agentId, l.dto, l.fichiers);
  }

  @Get(':id')
  fiche(@Utilisateur() u: UtilisateurConnecte, @Param('id') id: string) {
    return this.service.fiche(u, id);
  }

  @Get(':id/circuit')
  circuit(@Utilisateur() u: UtilisateurConnecte, @Param('id') id: string) {
    return this.service.etatCircuit(u, id);
  }

  @Post(':id/circuit/agir')
  agir(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body()
    dto: {
      avis?: 'FAVORABLE' | 'REJET';
      decision?: 'ACCORDEE' | 'REJETEE' | 'EN_INSTANCE';
      motivation?: string;
      surPapier?: boolean;
    },
  ) {
    return this.service.agir(u, id, dto ?? {});
  }

  @Roles('DG')
  @Post(':id/circuit/franchir')
  franchir(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body('motif') motif: string,
  ) {
    return this.service.franchir(u, id, motif);
  }

  @Post(':id/circuit/instruction')
  instruction(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() dto: { texte?: string; echeance?: string | null },
  ) {
    return this.service.instruire(
      u,
      id,
      dto?.texte ?? '',
      dto?.echeance ?? null,
    );
  }

  @Post(':id/retirer')
  retirer(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body('motif') motif: string,
  ) {
    return this.service.retirer(u, id, motif);
  }

  @Get(':id/acte')
  acte(@Utilisateur() u: UtilisateurConnecte, @Param('id') id: string) {
    return this.service.acte(u, id);
  }

  @Post(':id/pieces')
  @UseInterceptors(FICHIERS)
  ajouterPieces(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @UploadedFiles() fichiers: Express.Multer.File[] = [],
    @Body('libelles') libelles?: string | string[],
  ) {
    return this.service.ajouterPieces(
      u,
      id,
      lire('{}', libelles, fichiers).fichiers,
    );
  }

  @Get(':id/pieces/:piece')
  async piece(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Param('piece') piece: string,
    @Res() res: Response,
  ) {
    const p = await this.service.piece(u, id, piece);
    await this.stockage.servir(res, 'justificatifs', p.fichier, {
      mime: p.mime,
      nomAffiche: p.nomOrigine,
    });
  }

  @Delete(':id/pieces/:piece')
  supprimerPiece(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Param('piece') piece: string,
  ) {
    return this.service.supprimerPiece(u, id, piece);
  }
}

/** Essais par adresse IP (contre les envois en masse et la recherche de fiches au hasard). */
const essais = new Map<string, number[]>();
const FENETRE_MS = 60 * 60 * 1000;
function limiter(req: Request, cle: string, limite: number) {
  const k = `${cle}|${req.ip ?? 'inconnue'}`;
  const recents = (essais.get(k) ?? []).filter(
    (t) => Date.now() - t < FENETRE_MS,
  );
  if (recents.length >= limite)
    throw new HttpException(
      'Trop d’essais depuis cet appareil. Réessayez dans une heure.',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  essais.set(k, [...recents, Date.now()]);
}

/** Portail (sans compte) : l'agent se fait reconnaître, dépose, suit et imprime son acte. */
@Public()
@Controller('portail/prestations')
export class PortailPrestationsController {
  constructor(private readonly service: PrestationsService) {}

  @Get('catalogue')
  catalogue() {
    return this.service.catalogue();
  }

  @Post('identifier')
  identifier(
    @Req() req: Request,
    @Body()
    dto: { matricule?: string; nomComplet?: string; dateNaissance?: string },
  ) {
    limiter(req, 'identifier', 20);
    return this.service.identifier(dto ?? {});
  }

  @Post()
  @UseInterceptors(FICHIERS)
  deposer(
    @Req() req: Request,
    @UploadedFiles() fichiers: Express.Multer.File[] = [],
    @Body('jeton') jeton?: string,
    @Body('donnees') donnees?: string,
    @Body('libelles') libelles?: string | string[],
    @Body('site') piege?: string,
  ) {
    // Champ invisible rempli : envoi automatique (robot)
    if (piege) throw new BadRequestException('Envoi refusé.');
    limiter(req, 'deposer', 6);
    const l = lire(donnees, libelles, fichiers);
    return this.service.deposerPortail(jeton ?? '', l.dto, l.fichiers);
  }

  @Get('suivi')
  suivi(@Query('numero') numero: string, @Query('code') code: string) {
    if (!numero?.trim() || !code?.trim())
      throw new BadRequestException(
        'Écrivez le numéro et le code de votre demande.',
      );
    return this.service.suivi(numero, code);
  }

  @Get('acte')
  acte(@Query('numero') numero: string, @Query('code') code: string) {
    return this.service.actePublic(numero ?? '', code ?? '');
  }
}
