import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import {
  Public,
  Roles,
  ROLES_TRAITEMENT,
  Utilisateur,
  type UtilisateurConnecte,
} from '../auth/auth';
import { DemandesService, type DepotDto } from './demandes.service';

const FICHIERS = FilesInterceptor('fichiers', 12, {
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, f, cb) =>
    cb(null, /\.(pdf|jpe?g|png)$/i.test(f.originalname)),
});

/** Demandes de prestations : dépôt par le chef pour son agent, et acte délivré. */
@Roles(...ROLES_TRAITEMENT, 'DDEPPSA', 'STRUCTURE')
@Controller()
export class DemandesController {
  constructor(private readonly service: DemandesService) {}

  @Get('demandes/types')
  types() {
    return this.service.types();
  }

  /** Demande d'un agent de la base du personnel, déposée par son chef (pièces scannées jointes). */
  @Post('demandes/agents/:agentId')
  @UseInterceptors(FICHIERS)
  deposer(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('agentId', ParseIntPipe) agentId: number,
    @UploadedFiles() fichiers: Express.Multer.File[] = [],
    @Body('donnees') donnees?: string,
    @Body('libelles') libelles?: string | string[],
  ) {
    let dto: DepotDto;
    try {
      dto = JSON.parse(donnees ?? '{}') as DepotDto;
    } catch {
      throw new BadRequestException('Formulaire illisible.');
    }
    const libs = Array.isArray(libelles)
      ? libelles
      : libelles
        ? [libelles]
        : [];
    return this.service.deposerPourAgent(
      u,
      agentId,
      dto,
      fichiers.map((f, i) => ({
        f,
        libelle: libs[i]?.slice(0, 200) || 'Pièce jointe',
      })),
    );
  }

  @Get('demandes/:id/acte')
  acte(@Utilisateur() u: UtilisateurConnecte, @Param('id') id: string) {
    return this.service.acte(u, id);
  }

  /** Portail : l'agent imprime lui-même l'acte de sa demande accordée. */
  @Public()
  @Get('portail/acte')
  actePublic(@Query('numero') numero: string, @Query('code') code: string) {
    if (!/^\d+$/.test(numero ?? '') || !code?.trim())
      throw new BadRequestException(
        'Écrivez le numéro et le code de votre demande.',
      );
    return this.service.actePublic(Number(numero), code);
  }

  @Public()
  @Get('portail/types')
  typesPublics() {
    return this.service.types();
  }
}
