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
import { DetectionDoublonsService } from './dossiers/detection-doublons.service';
import { EnrolementController } from './enrolement/enrolement.controller';
import { EnrolementService } from './enrolement/enrolement.service';
import { BourseService } from './enrolement/bourse.service';
import { ControleEffectifsService } from './recensement/controle-effectifs.service';
import { SansEcoleController } from './recensement/sans-ecole.controller';
import { RetraitsController } from './recensement/retraits.controller';
import { CampagnesRecensementController } from './recensement/campagnes-recensement.controller';
import { CampagnesRecensementService } from './recensement/campagnes-recensement.service';
import { ConstatsTerrainService } from './recensement/constats-terrain.service';
import { RecenseursController } from './recensement/recenseurs.controller';
import { RecenseursService } from './recensement/recenseurs.service';
import { TerrainController } from './recensement/terrain.controller';
import { TerrainService } from './recensement/terrain.service';
import { NomEcoleSubscriber } from './common/nom-ecole.subscriber';
import { NomsEcolesController } from './etablissements/noms-ecoles.controller';
import { NomsEcolesService } from './etablissements/noms-ecoles.service';
import { SansEcoleService } from './recensement/sans-ecole.service';
import { RetraitsService } from './recensement/retraits.service';
import { OriginesEnrolementController } from './enrolement/origines-enrolement.controller';
import { OriginesEnrolementService } from './enrolement/origines-enrolement.service';
import { ComparaisonFichierController } from './enrolement/comparaison-fichier.controller';
import { ComparaisonFichierService } from './enrolement/comparaison-fichier.service';
import {
  ControleEcolesController,
  EffectifsEcolesController,
} from './enrolement/effectifs-ecoles.controller';
import { EffectifsEcolesService } from './enrolement/effectifs-ecoles.service';
import { RapprochementRapportsController } from './enrolement/rapprochement-rapports.controller';
import { PropositionsBmController } from './enrolement/propositions-bm.controller';
import { PropositionsBmService } from './enrolement/propositions-bm.service';
import { RapprochementRapportsService } from './enrolement/rapprochement-rapports.service';
import { SuiviIntegrationController } from './enrolement/suivi-integration.controller';
import { SuiviIntegrationService } from './enrolement/suivi-integration.service';
import { ConfigEnrolementService } from './enrolement/configuration';
import { VolontairesController } from './enrolement/volontaires.controller';
import { GestionEnrolementController } from './enrolement/gestion-enrolement.controller';
import { RepartitionController } from './enrolement/repartition.controller';
import { RepartitionService } from './enrolement/repartition.service';
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
import { SecuriteController } from './securite/securite.controller';
import { SecuriteService } from './securite/securite.service';
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
  BesoinsAdministratifsController,
  EtablissementsController,
  StructuresController,
} from './etablissements/etablissements.controller';
import { EtablissementsService } from './etablissements/etablissements.service';
import { EmploisDuTempsService } from './etablissements/emplois-du-temps.service';
import { BesoinsAdministratifsService } from './etablissements/besoins-administratifs.service';
import { NominationsController } from './nominations/nominations.controller';
import { NominationsService } from './nominations/nominations.service';
import { PlacementNominationsController } from './nominations/placement.controller';
import { PlacementNominationsService } from './nominations/placement.service';
import { SuiviController } from './etablissements/suivi.controller';
import { ClassesDeclareesController } from './etablissements/classes-declarees.controller';
import { ClassesDeclareesService } from './etablissements/classes-declarees.service';
import { RepertoireEcolesController } from './etablissements/repertoire-ecoles.controller';
import { RepertoireEcolesService } from './etablissements/repertoire-ecoles.service';
import { SuiviService } from './etablissements/suivi.service';
import { DemandesController } from './circuit/demandes.controller';
import { DemandesService } from './circuit/demandes.service';
import {
  PortailPrestationsController,
  PrestationsController,
} from './prestations/prestations.controller';
import { PrestationsService } from './prestations/prestations.service';
import { LiaisonVolontairesService } from './recensement/liaison-volontaires.service';
import { EcartsVolontairesService } from './recensement/ecarts-volontaires.service';
import { AffectationsPersonnelService } from './recensement/affectations-personnel.service';
import { DoublonsService } from './affectation/doublons.service';
import { OubliesService } from './affectation/oublies.service';
import { SauvegardeController } from './sauvegarde/sauvegarde.controller';
import { SauvegardeService } from './sauvegarde/sauvegarde.service';
import { DoublonsCentralService } from './doublons/doublons-central.service';
import { DoublonsController } from './doublons/doublons.controller';
import { RattachementService } from './rattachement/rattachement.service';
import { RattachementController } from './rattachement/rattachement.controller';
import { BottinService } from './enrolement/bottin.service';
import { RetardsEchelonsService } from './recensement/retards-echelons.service';
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
    SecuriteController,
    SauvegardeController,
    DemandesController,
    PrestationsController,
    PortailPrestationsController,
    DoublonsController,
    RattachementController,
    EtablissementsController,
    StructuresController,
    BesoinsAdministratifsController,
    NominationsController,
    PlacementNominationsController,
    SuiviController,
    RepertoireEcolesController,
    ClassesDeclareesController,
    SansEcoleController,
    RetraitsController,
    TerrainController,
    RecenseursController,
    CampagnesRecensementController,
    NomsEcolesController,
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
    SuiviIntegrationController,
    RapprochementRapportsController,
    PropositionsBmController,
    EffectifsEcolesController,
    ControleEcolesController,
    ComparaisonFichierController,
    OriginesEnrolementController,
    GestionEnrolementController,
    RepartitionController,
    AmorcageController,
    RecensementController,
    RecommandationsController,
    ReferentielsController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    SecuriteService,
    SessionService,
    JournalService,
    ParametresService,
    InitialisationService,
    AffectationService,
    ImportBaseService,
    DoublonsService,
    OubliesService,
    SauvegardeService,
    DoublonsCentralService,
    RattachementService,
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
    DetectionDoublonsService,
    EnrolementService,
    ConfigEnrolementService,
    VolontairesService,
    BourseService,
    SuiviIntegrationService,
    RapprochementRapportsService,
    PropositionsBmService,
    EffectifsEcolesService,
    ComparaisonFichierService,
    OriginesEnrolementService,
    ControleEffectifsService,
    SansEcoleService,
    RetraitsService,
    TerrainService,
    RecenseursService,
    CampagnesRecensementService,
    ConstatsTerrainService,
    NomsEcolesService,
    NomEcoleSubscriber,
    BottinService,
    RegularisationsService,
    MiseEnRouteService,
    PilotageEnrolementService,
    ConfigRecensementService,
    RecensementService,
    CarriereService,
    RetardsEchelonsService,
    EtablissementsService,
    EmploisDuTempsService,
    BesoinsAdministratifsService,
    NominationsService,
    PlacementNominationsService,
    SuiviService,
    RepertoireEcolesService,
    ClassesDeclareesService,
    DemandesService,
    PrestationsService,
    ExcelRecensementService,
    LiaisonVolontairesService,
    RepartitionService,
    EcartsVolontairesService,
    AffectationsPersonnelService,
  ],
})
export class AppModule {}
