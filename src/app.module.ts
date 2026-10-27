import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AffectationController } from './affectation/affectation.controller';
import { AffectationService } from './affectation/affectation.service';
import { ControleAffectationsService } from './affectation/controle.service';
import { StatistiquesService } from './affectation/statistiques.service';
import { ImportBaseService } from './affectation/import.service';
import { LotsReceptionService } from './affectation/lots-reception.service';
import { DossiersController } from './dossiers/dossiers.controller';
import { DossiersService } from './dossiers/dossiers.service';
import { RapprochementService } from './dossiers/rapprochement.service';
import { EnrolementController } from './enrolement/enrolement.controller';
import { EnrolementService } from './enrolement/enrolement.service';
import { BourseService } from './enrolement/bourse.service';
import { ConfigEnrolementService } from './enrolement/configuration';
import { VolontairesController } from './enrolement/volontaires.controller';
import { GestionEnrolementController } from './enrolement/gestion-enrolement.controller';
import { MiseEnRouteService } from './enrolement/mise-en-route.service';
import { PilotageEnrolementService } from './enrolement/pilotage-enrolement.service';
import { RegularisationsService } from './enrolement/regularisations.service';
import { VolontairesService } from './enrolement/volontaires.service';
import { ComplementsService } from './dossiers/complements.service';
import { CircuitController } from './circuit/circuit.controller';
import { CircuitService } from './circuit/circuit.service';
import { BeneficiairesService } from './pilotage/beneficiaires.service';
import { PortailController } from './circuit/portail.controller';
import { AuthGuard } from './auth/auth';
import { AnomaliesService } from './common/anomalies';
import { StockageService } from './common/stockage';
import { ConfigurationController } from './configuration/configuration.controller';
import { ConfigurationService } from './configuration/configuration.service';
import { CoreController } from './core/core.controller';
import {
  InitialisationService,
  JournalService,
  ParametresService,
} from './core/core.service';
import { DashboardController } from './dashboard.controller';
import { MenuController } from './menu.controller';
import { DroitsController } from './auth/droits.controller';
import { ENTITES } from './entities';
import { optionsBase } from './base-de-donnees';
import { SessionService } from './auth/session.service';
import { AmorcageService } from './amorcage/amorcage.service';
import { AmorcageController } from './amorcage/amorcage.controller';
import { MutationController } from './mutation/mutation.controller';
import { MutationService } from './mutation/mutation.service';
import { NotesController } from './notes/notes.controller';
import { NotesService } from './notes/notes.service';
import { PilotageController } from './pilotage/pilotage.controller';
import { PilotageService } from './pilotage/pilotage.service';
import { CandidatsService } from './recrutement/candidats.service';
import { ReceptionService } from './recrutement/reception.service';
import { RecrutementController } from './recrutement/recrutement.controller';
import { ConfigRecensementService } from './recensement/configuration';
import { ExcelRecensementService } from './recensement/excel-recensement.service';
import { RecensementController } from './recensement/recensement.controller';
import { RecensementService } from './recensement/recensement.service';
import { CarriereService } from './recensement/carriere.service';
import {
  EtablissementsController,
  StructuresController,
} from './etablissements/etablissements.controller';
import { EtablissementsService } from './etablissements/etablissements.service';
import { EmploisDuTempsService } from './etablissements/emplois-du-temps.service';
import { SuiviController } from './etablissements/suivi.controller';
import { SuiviService } from './etablissements/suivi.service';
import { DemandesController } from './circuit/demandes.controller';
import { DemandesService } from './circuit/demandes.service';
import { LiaisonVolontairesService } from './recensement/liaison-volontaires.service';
import { AffectationsPersonnelService } from './recensement/affectations-personnel.service';
import { BottinService } from './enrolement/bottin.service';
import { ImportStructuresService } from './circuit/structures-import.service';
import { RecommandationsController } from './recommandations/recommandations.controller';
import { RecommandationsService } from './recommandations/recommandations.service';
import { ReferentielsController } from './referentiels/referentiels.controller';
import { ReferentielsService } from './referentiels/referentiels.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Connexion (Supabase en ligne, PostgreSQL local sur le poste) : voir base-de-donnees.ts
    TypeOrmModule.forRootAsync({ useFactory: () => optionsBase() }),
    TypeOrmModule.forFeature(ENTITES),
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (c: ConfigService) => {
        const secret = c.get<string>('JWT_SECRET');
        if (!secret || secret.length < 32)
          throw new Error(
            'JWT_SECRET manquant ou trop court (32 caractères minimum)',
          );
        return { secret, signOptions: { expiresIn: '10h' } };
      },
    }),
  ],
  controllers: [
    DemandesController,
    EtablissementsController,
    StructuresController,
    SuiviController,
    CoreController,
    ConfigurationController,
    AffectationController,
    RecrutementController,
    PilotageController,
    NotesController,
    MutationController,
    DashboardController,
    MenuController,
    DroitsController,
    DossiersController,
    CircuitController,
    PortailController,
    EnrolementController,
    VolontairesController,
    GestionEnrolementController,
    AmorcageController,
    RecensementController,
    RecommandationsController,
    ReferentielsController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    SessionService,
    JournalService,
    ParametresService,
    InitialisationService,
    AffectationService,
    ImportBaseService,
    LotsReceptionService,
    DossiersService,
    ComplementsService,
    CircuitService,
    ImportStructuresService,
    RecommandationsService,
    ReferentielsService,
    BeneficiairesService,
    ConfigurationService,
    NotesService,
    MutationService,
    CandidatsService,
    ReceptionService,
    PilotageService,
    AnomaliesService,
    StockageService,
    AmorcageService,
    ControleAffectationsService,
    StatistiquesService,
    RapprochementService,
    EnrolementService,
    ConfigEnrolementService,
    VolontairesService,
    BourseService,
    BottinService,
    RegularisationsService,
    MiseEnRouteService,
    PilotageEnrolementService,
    ConfigRecensementService,
    RecensementService,
    CarriereService,
    EtablissementsService,
    EmploisDuTempsService,
    SuiviService,
    DemandesService,
    ExcelRecensementService,
    LiaisonVolontairesService,
    AffectationsPersonnelService,
  ],
})
export class AppModule {}
