import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import type { Response } from 'express';
import {
  Roles,
  ROLES_TRAITEMENT,
  Utilisateur,
  type UtilisateurConnecte,
} from '../auth/auth';
import { RapprochementRapportsService } from './rapprochement-rapports.service';

class DecisionBody {
  @IsOptional() @IsIn(['CONFIRME', 'AUTRE_FICHE', 'ABSENT', null])
  decision: string | null;
  @IsOptional() @IsInt() @Min(1) agentId?: number;
  @IsOptional() @IsUUID() volontaireId?: string;
}

const EXCEL =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Rapprochement des rapports de fin d'année des DDEPPSA avec la base (Banque mondiale,
 * 17/11/2026) : import d'un état nominatif (Excel), rapprochement avec toute la base du personnel
 * et tout le registre, décisions gardées, export Excel des champs demandés.
 */
@Roles(...ROLES_TRAITEMENT)
@Controller('enrolement/rapprochement-rapports')
export class RapprochementRapportsController {
  constructor(private readonly rap: RapprochementRapportsService) {}

  @Get()
  liste() {
    return this.rap.liste();
  }

  /** Le modèle Excel à remplir. */
  @Get('modele')
  async modele(@Res() res: Response) {
    res.setHeader('Content-Type', EXCEL);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent('Modèle - état nominatif du personnel.xlsx')}`,
    );
    res.send(await this.rap.modele());
  }

  /** Chercher une autre fiche (personnel et registre) par le nom. */
  @Get('fiches')
  fiches(@Query('q') q?: string) {
    return this.rap.chercherFiche(String(q ?? '').slice(0, 120));
  }

  @Post('import')
  @UseInterceptors(
    FileInterceptor('fichier', { limits: { fileSize: 20 * 1024 * 1024 } }),
  )
  importer(
    @Utilisateur() u: UtilisateurConnecte,
    @UploadedFile() fichier?: Express.Multer.File,
    @Body() b: Record<string, string | undefined> = {},
  ) {
    if (!fichier || !/\.xlsx$/i.test(fichier.originalname))
      throw new BadRequestException(
        'Choisissez l’état nominatif en Excel (.xlsx).',
      );
    const dep = Number(b.departementId);
    // Les noms de fichiers accentués arrivent en latin1
    const nom = Buffer.from(fichier.originalname, 'latin1').toString('utf8');
    return this.rap.importer(u, fichier.buffer, nom, {
      departementId: Number.isInteger(dep) && dep > 0 ? dep : undefined,
      anneeScolaire: b.anneeScolaire,
    });
  }

  @Get(':id')
  detail(@Param('id', ParseIntPipe) id: number) {
    return this.rap.detail(id);
  }

  /** Refaire le rapprochement (après des corrections dans la base) ; les décisions restent. */
  @Post(':id/recalculer')
  recalculer(@Param('id', ParseIntPipe) id: number) {
    return this.rap.rapprocher(id);
  }

  @Get(':id/excel')
  async excel(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const { nom, contenu } = await this.rap.excel(id);
    res.setHeader('Content-Type', EXCEL);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(nom)}`,
    );
    res.send(contenu);
  }

  @Delete(':id')
  supprimer(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.rap.supprimer(u, id);
  }

  /** Recopier dans la fiche du personnel les rubriques choisies du rapport. */
  @Post('lignes/:id/appliquer')
  appliquer(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body() b: { champs?: Record<string, unknown>; forcer?: boolean },
  ) {
    return this.rap.appliquer(u, id, b?.champs ?? {}, b?.forcer === true);
  }

  @Post('lignes/:id/decision')
  decider(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body() d: DecisionBody,
  ) {
    return this.rap.decider(u, id, d);
  }
}
