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
import { ENTITES } from './entities';
import { optionsBase } from './base-de-donnees';
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
    CoreController,
    ConfigurationController,
    AffectationController,
    RecrutementController,
    PilotageController,
    NotesController,
    MutationController,
    DashboardController,
    DossiersController,
    CircuitController,
    PortailController,
    EnrolementController,
    AmorcageController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    JournalService,
    ParametresService,
    InitialisationService,
    AffectationService,
    ImportBaseService,
    LotsReceptionService,
    DossiersService,
    ComplementsService,
    CircuitService,
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
  ],
})
export class AppModule {}
