import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { Roles, Utilisateur, type UtilisateurConnecte } from '../auth/auth';
import { BeneficiairesService } from './beneficiaires.service';
import { PilotageService } from './pilotage.service';

class BeneficiaireDto {
  @IsString() @MaxLength(150) nom: string;
  @IsOptional() @IsBoolean() actif?: boolean;
}

class RepartitionQuotaDto {
  @IsArray() @ArrayMaxSize(2000) lignes: {
    beneficiaireId: number;
    cycle: string;
    places: number;
  }[];
}

class EnveloppeDto {
  @IsNumber() @Min(0) montantAnnuel: number;
  @IsOptional() @IsInt() @Min(0) placesCatI?: number | null;
  @IsOptional() @IsInt() @Min(0) placesCatII?: number | null;
  @IsOptional() @IsInt() @Min(0) placesCatIII?: number | null;
}

class PropositionDto {
  @IsObject() quotas: Record<string, number>;
  @IsOptional() @IsBoolean() texteRecu?: boolean;
  @IsOptional() @IsInt() lot?: number;
  @IsOptional() @IsArray() @IsInt({ each: true }) lots?: number[];
}

class ApplicationDto {
  @IsObject() quotas: Record<string, number>;
  @IsArray() @ArrayMaxSize(20000) lignes: {
    agentId: string;
    departementId: number;
  }[];
}

/** Module de pilotage : réservé au DG (et à l'administrateur). */
@Roles('DG')
@Controller('pilotage')
export class PilotageController {
  constructor(
    private readonly service: PilotageService,
    private readonly beneficiaires: BeneficiairesService,
  ) {}

  /* ------------- Bénéficiaires du quota et quota réajusté par cycle ------------- */

  @Get('beneficiaires')
  listeBeneficiaires() {
    return this.beneficiaires.liste();
  }

  @Post('beneficiaires')
  ajouterBeneficiaire(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() dto: BeneficiaireDto,
  ) {
    return this.beneficiaires.enregistrer(u, null, dto);
  }

  @Put('beneficiaires/:id')
  modifierBeneficiaire(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: BeneficiaireDto,
  ) {
    return this.beneficiaires.enregistrer(u, id, dto);
  }

  @Delete('beneficiaires/:id')
  supprimerBeneficiaire(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.beneficiaires.supprimer(u, id);
  }

  /** Rattache une origine des dossiers à un bénéficiaire du quota (null : la détacher). */
  @Put('origines/:id/beneficiaire')
  rattacherOrigine(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { beneficiaireId: number | null },
  ) {
    return this.beneficiaires.rattacherOrigine(
      u,
      id,
      body?.beneficiaireId ?? null,
    );
  }

  @Get('planification/:perimetre')
  planification(@Param('perimetre') perimetre: string) {
    return this.beneficiaires.planification(perimetre);
  }

  @Put('planification/:perimetre')
  repartir(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('perimetre') perimetre: string,
    @Body() dto: RepartitionQuotaDto,
  ) {
    return this.beneficiaires.repartir(u, perimetre, dto.lignes);
  }

  @Get('perimetres')
  perimetres() {
    return this.service.perimetres();
  }

  /** Budget d'un quota, en bref : pour qui prépare l'envoi à la FP. */
  @Roles('DG')
  @Get('budget/:perimetre')
  async budget(@Param('perimetre') perimetre: string) {
    const t = await this.service.tableau(perimetre);
    return {
      perimetre,
      libelle: t.libelle,
      enveloppe: t.enveloppe?.montantAnnuel ?? null,
      engage: t.total.annuel,
      effectif: t.total.effectif,
      pretes: t.pretes,
      reste: t.reste,
      taux: t.taux,
      etapes: t.etapes,
    };
  }

  @Get('alertes')
  alertes() {
    return this.service.alertes();
  }

  @Get('tableau/:perimetre')
  tableau(@Param('perimetre') perimetre: string) {
    return this.service.tableau(perimetre);
  }

  @Put('enveloppe/:perimetre')
  enveloppe(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('perimetre') perimetre: string,
    @Body() dto: EnveloppeDto,
  ) {
    return this.service.definirEnveloppe(u, perimetre, dto);
  }

  @Get('repartition')
  etat(
    @Query('texteRecu') texteRecu?: string,
    @Query('lot') lot?: string,
    @Query('lots') lots?: string,
  ) {
    return this.service.etatRepartition(
      texteRecu !== '0',
      lots ? lots.split(',').map(Number) : lot ? Number(lot) : undefined,
    );
  }

  @Post('repartition/proposer')
  proposer(@Body() dto: PropositionDto) {
    return this.service.proposer(
      dto.quotas,
      dto.texteRecu !== false,
      dto.lots ?? dto.lot,
    );
  }

  @Post('repartition/appliquer')
  appliquer(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() dto: ApplicationDto,
  ) {
    return this.service.appliquer(u, dto.quotas, dto.lignes);
  }

  @Get('repartition/:id/bilan')
  bilan(@Param('id') id: string) {
    return this.service.bilan(id);
  }

  @Post('repartition/:id/annuler')
  annuler(@Utilisateur() u: UtilisateurConnecte, @Param('id') id: string) {
    return this.service.annuler(u, id);
  }
}
