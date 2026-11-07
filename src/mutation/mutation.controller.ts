import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
  UploadedFiles,
  Delete,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import type { Response } from 'express';
import {
  Roles,
  ROLES_TRAITEMENT,
  Utilisateur,
  type UtilisateurConnecte,
} from '../auth/auth';
import { MOTIFS_MUTATION } from '../common/referentiels';
import { StockageService } from '../common/stockage';
import { type CorrectionAnomalies, MutationService } from './mutation.service';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

class DemandeDto {
  @IsOptional() @IsString() @MaxLength(60) typePrestation?: string | null;
  @IsOptional() @IsString() @MaxLength(200) objet?: string | null;
  @IsOptional() @IsInt() structureOrigineId?: number | null;
  @IsOptional() @IsString() @MaxLength(200) structureOrigineTexte?:
    string | null;
  @IsOptional() @IsString() @MaxLength(30) telephone?: string | null;
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(DATE)
  dateEnregistrement?: string | null;
  @IsString() @MaxLength(200) nomComplet: string;
  @IsOptional() @IsIn(['M', 'F']) genre?: 'M' | 'F';
  @IsOptional() @IsString() grade?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() echelon?:
    number | null;
  @IsOptional() @IsString() matricule?: string | null;
  @IsOptional() @IsIn(['FONCTIONNAIRE', 'FINALISTE']) typeAgent?:
    'FONCTIONNAIRE' | 'FINALISTE';
  @IsOptional() @IsIn(['ENSEIGNANT', 'PERSONNEL_ADMINISTRATIF']) statutAgent?:
    'ENSEIGNANT' | 'PERSONNEL_ADMINISTRATIF';
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  departementOrigineId?: number | null;
  @IsOptional() @IsString() lieuService?: string | null;
  @IsOptional() @IsString() cycle?: string | null;
  @IsOptional() @IsString() specialite?: string | null;
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(DATE)
  datePriseService?: string | null;
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  departementSolliciteId?: number | null;
  @IsOptional() @IsString() lieuSollicite?: string | null;
  @IsIn(MOTIFS_MUTATION) motif: string;
  @IsOptional() @IsString() justificatif?: string | null;
  @IsOptional() @IsString() permutationAvecId?: string | null;
  @IsOptional() @IsString() origine?: string | null;
  @IsOptional() @IsString() observation?: string | null;
}

class AvisDto {
  @IsString() valeur: string;
  @IsOptional() @IsString() commentaire?: string;
}

class RetraitDto {
  @IsBoolean() retirer: boolean;
  @IsOptional() @IsString() motif?: string;
}

const optInt = (v?: string) => (v ? Number(v) : undefined);

@Controller('mutations')
export class MutationController {
  constructor(
    private readonly service: MutationService,
    private readonly stockage: StockageService,
  ) {}

  @Roles(...ROLES_TRAITEMENT, 'DDEPPSA', 'CABINET', 'SECRETARIAT', 'STRUCTURE')
  @Get()
  liste(
    @Utilisateur() u: UtilisateurConnecte,
    @Query('motif') motif?: string,
    @Query('etat') etat?: string,
    @Query('departementId') departementId?: string,
    @Query('recherche') recherche?: string,
    @Query('groupe') groupe?: string,
  ) {
    return this.service.liste({
      motif,
      etat,
      departementId: optInt(departementId),
      recherche,
      groupe,
      u,
    });
  }

  /**
   * Retrouver l'agent dans la base du personnel avant de taper sa demande (07/11/2026) : matricule
   * ou nom (dans n'importe quel ordre). Ses informations remplissent le formulaire.
   */
  @Roles(...ROLES_TRAITEMENT, 'DDEPPSA', 'SECRETARIAT')
  @Get('agents')
  rechercherAgents(@Query('q') q?: string) {
    return this.service.rechercherAgents(q ?? '');
  }

  @Get('doublons')
  doublons(
    @Query('nom') nom?: string,
    @Query('matricule') matricule?: string,
    @Query('exclure') exclure?: string,
  ) {
    return this.service.doublons(nom, matricule, exclure);
  }

  @Get('statistiques')
  statistiques(@Query('base') base?: 'accordees' | 'toutes') {
    return this.service.statistiques(
      base === 'toutes' ? 'toutes' : 'accordees',
    );
  }

  @Roles(...ROLES_TRAITEMENT, 'DDEPPSA', 'CABINET', 'SECRETARIAT', 'STRUCTURE')
  @Get(':id')
  obtenir(@Utilisateur() u: UtilisateurConnecte, @Param('id') id: string) {
    return this.service.obtenir(id, u);
  }

  /* ---------- Pièces jointes (plusieurs fichiers : demande scannée, justificatifs) ---------- */

  @Roles(...ROLES_TRAITEMENT, 'DDEPPSA', 'CABINET', 'SECRETARIAT', 'STRUCTURE')
  @Get(':id/pieces')
  async pieces(@Utilisateur() u: UtilisateurConnecte, @Param('id') id: string) {
    await this.service.obtenir(id, u);
    return this.service.piecesDe(id);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Post(':id/pieces')
  @UseInterceptors(
    FilesInterceptor('fichiers', 12, {
      limits: { fileSize: 10 * 1024 * 1024 },
      fileFilter: (_req, f, cb) =>
        cb(null, /\.(pdf|jpe?g|png)$/i.test(f.originalname)),
      // Fichiers gardés en mémoire, puis envoyés au stockage (Cloudflare R2 ou disque local)
    }),
  )
  async ajouterPieces(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @UploadedFiles() fichiers: Express.Multer.File[] = [],
    @Body('libelles') libelles?: string | string[],
  ) {
    if (!fichiers.length)
      throw new BadRequestException(
        'Fichiers PDF, JPG ou PNG requis (10 Mo maximum chacun).',
      );
    const libs = Array.isArray(libelles)
      ? libelles
      : libelles
        ? [libelles]
        : [];
    // La demande doit encore être modifiable avant d'envoyer quoi que ce soit au stockage
    await this.service.verifierModifiable(id);
    await this.stockage.enregistrerTous('justificatifs', fichiers);
    try {
      return await this.service.ajouterPieces(
        u,
        id,
        fichiers.map((f, i) => ({
          f,
          libelle: libs[i]?.slice(0, 200) || 'Pièce jointe',
        })),
      );
    } catch (e) {
      await Promise.all(
        fichiers.map((f) =>
          this.stockage.supprimer('justificatifs', f.filename),
        ),
      );
      throw e;
    }
  }

  @Roles(...ROLES_TRAITEMENT, 'DDEPPSA', 'CABINET', 'SECRETARIAT', 'STRUCTURE')
  @Get(':id/pieces/:piece')
  async piece(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Param('piece') piece: string,
    @Res() res: Response,
  ) {
    await this.service.obtenir(id, u);
    const p = await this.service.piece(id, piece);
    await this.stockage.servir(res, 'justificatifs', p.fichier, {
      mime: p.mime,
      nomAffiche: p.nomOrigine,
    });
  }

  @Roles(...ROLES_TRAITEMENT)
  @Delete(':id/pieces/:piece')
  async supprimerPiece(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Param('piece') piece: string,
  ) {
    const p = await this.service.supprimerPiece(u, id, piece);
    await this.stockage.supprimer('justificatifs', p.fichier);
    return { ok: true };
  }

  @Roles(...ROLES_TRAITEMENT)
  @Post()
  creer(@Utilisateur() u: UtilisateurConnecte, @Body() dto: DemandeDto) {
    return this.service.creer(u, dto);
  }

  /**
   * Compléter les cases vides des demandes depuis la base du personnel (fiches sûres seulement).
   * `?essai=1` : ce qui serait rempli, sans rien enregistrer.
   */
  @Roles(...ROLES_TRAITEMENT)
  @Post('completer-personnel')
  completerDepuisPersonnel(
    @Utilisateur() u: UtilisateurConnecte,
    @Query('essai') essai?: string,
  ) {
    return this.service.completerDepuisPersonnel(u, essai === '1');
  }

  /** Corriger les points à vérifier d'une demande (depuis la liste), ou les déclarer vérifiés. */
  @Roles(...ROLES_TRAITEMENT)
  @Patch(':id/anomalies')
  corrigerAnomalies(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() corps: CorrectionAnomalies,
  ) {
    return this.service.corrigerAnomalies(u, id, corps ?? {});
  }

  @Roles(...ROLES_TRAITEMENT)
  @Put(':id')
  modifier(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() dto: DemandeDto,
  ) {
    return this.service.modifier(u, id, dto);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Post('import')
  @UseInterceptors(
    FileInterceptor('fichier', { limits: { fileSize: 60 * 1024 * 1024 } }),
  )
  importer(
    @Utilisateur() u: UtilisateurConnecte,
    @UploadedFile() fichier?: Express.Multer.File,
    // Essai, feuilles choisies et décisions (06/11/2026), comme l'import de l'enrôlement
    @Query('essai') essai?: string,
    @Body()
    corps?: {
      feuilles?: string;
      decisions?: string;
      personnel?: string;
      completer?: string;
    },
  ) {
    if (!fichier) throw new BadRequestException('Fichier Excel manquant');
    if (!/\.xlsx$/i.test(fichier.originalname))
      throw new BadRequestException('Seuls les fichiers .xlsx sont acceptés');
    const lire = <T>(v: string | undefined, defaut: T): T => {
      try {
        return v ? (JSON.parse(v) as T) : defaut;
      } catch {
        throw new BadRequestException('Décisions de l’import illisibles.');
      }
    };
    const feuilles = lire<string[] | null>(corps?.feuilles, null);
    const decisions = lire<Record<string, string>>(corps?.decisions, {});
    return this.service.importer(
      u,
      fichier.buffer,
      essai === '1',
      Array.isArray(feuilles) ? feuilles.map(String) : null,
      decisions && typeof decisions === 'object' ? decisions : {},
      {
        personnel: lire<Record<string, string>>(corps?.personnel, {}),
        completer: corps?.completer !== '0',
      },
    );
  }

  @Roles(...ROLES_TRAITEMENT, 'DDEPPSA')
  @Post(':id/justificatif')
  @UseInterceptors(
    FileInterceptor('fichier', {
      limits: { fileSize: 10 * 1024 * 1024 },
      fileFilter: (_req, f, cb) =>
        cb(null, /\.(pdf|jpe?g|png)$/i.test(f.originalname)),
      // Fichiers gardés en mémoire, puis envoyés au stockage (Cloudflare R2 ou disque local)
    }),
  )
  async justificatif(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @UploadedFile() fichier?: Express.Multer.File,
  ) {
    if (!fichier)
      throw new BadRequestException(
        'Fichier PDF, JPG ou PNG requis (10 Mo maximum)',
      );
    await this.service.verifierModifiable(id);
    const ancien = await this.service.justificatifActuel(id);
    const nom = await this.stockage.enregistrer('justificatifs', fichier);
    try {
      await this.service.enregistrerFichier(u, id, nom);
    } catch (e) {
      await this.stockage.supprimer('justificatifs', nom);
      throw e;
    }
    // L'ancien justificatif unique est remplacé : son fichier ne sert plus
    if (ancien && ancien !== nom)
      await this.stockage.supprimer('justificatifs', ancien);
    return this.service.obtenir(id);
  }

  @Roles(...ROLES_TRAITEMENT, 'DDEPPSA', 'CABINET', 'SECRETARIAT', 'STRUCTURE')
  @Get(':id/justificatif')
  async telecharger(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    // Même contrôle que pour les pièces : la demande doit passer par la structure du compte
    await this.service.obtenir(id, u);
    const nom = await this.service.cheminFichier(id);
    await this.stockage.servir(res, 'justificatifs', nom);
  }

  @Roles('DDEPPSA')
  @Post(':id/avis-ddeppsa')
  avisDdeppsa(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() dto: AvisDto,
  ) {
    return this.service.avis(u, id, 'DDEPPSA', dto.valeur, dto.commentaire);
  }

  @Roles('DG', 'DIRECTEUR')
  @Post(':id/avis-dgrhas')
  avisDgrhas(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() dto: AvisDto,
  ) {
    return this.service.avis(u, id, 'DGRHAS', dto.valeur, dto.commentaire);
  }

  @Roles('CABINET', 'DG')
  @Post(':id/instruction')
  instruction(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() dto: AvisDto,
  ) {
    return this.service.avis(u, id, 'MINISTRE', dto.valeur, dto.commentaire);
  }

  /** Le DG confie un dossier accordé à son secrétariat (fiche individuelle, pièces jointes, note à imprimer). */
  @Roles('DG')
  @Post(':id/secretariat')
  envoyerSecretariat(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
  ) {
    return this.service.envoyerSecretariat(u, id);
  }

  @Roles(...ROLES_TRAITEMENT)
  @Post(':id/retrait')
  retrait(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id') id: string,
    @Body() dto: RetraitDto,
  ) {
    return this.service.retirer(u, id, dto.motif ?? '', dto.retirer);
  }
}
