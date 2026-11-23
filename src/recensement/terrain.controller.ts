import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  Roles,
  ROLES_TRAITEMENT,
  Utilisateur,
  type UtilisateurConnecte,
} from '../auth/auth';
import {
  ConstatsTerrainService,
  type SaisieConstatEcole,
  type SaisiePropositionEcole,
} from './constats-terrain.service';
import { RecenseursService } from './recenseurs.service';
import { type ModificationTerrain, TerrainService } from './terrain.service';

/** Recensement sur le terrain : paquet d'une école, puis envoi de ce qui a été complété. */
@Roles(...ROLES_TRAITEMENT, 'DDEPPSA', 'STRUCTURE', 'RECENSEUR')
@Controller('recensement/terrain')
export class TerrainController {
  constructor(
    private readonly service: TerrainService,
    private readonly recenseurs: RecenseursService,
    private readonly constats: ConstatsTerrainService,
  ) {}

  /** La mission du compte (recenseur) : départements, fin, jour de l'effacement de l'appareil. */
  @Get('mission')
  mission(@Utilisateur() u: UtilisateurConnecte) {
    return this.recenseurs.mission(u);
  }

  /** Positions relevées par la tablette du recenseur (envoyées par lots, gardées sans réseau). */
  @Post('positions')
  @HttpCode(200)
  positions(
    @Utilisateur() u: UtilisateurConnecte,
    @Body()
    corps: {
      positions?: Parameters<RecenseursService['recevoirPositions']>[1];
    },
  ) {
    return this.recenseurs.recevoirPositions(u, corps?.positions ?? []);
  }

  /** L'appareil a effacé ce qu'il gardait (effacement à distance demandé). */
  @Post('mission/efface')
  @HttpCode(200)
  efface(@Utilisateur() u: UtilisateurConnecte) {
    return this.recenseurs.accuseEfface(u);
  }

  /** Tout un département : ses écoles et leurs agents, d'un seul téléchargement. */
  @Get('departement/:id')
  departement(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.departement(u, id);
  }

  /** Base complète : le plan (départements, écoles, agents) pour la barre de progression. */
  @Get('base/plan')
  planBase(@Utilisateur() u: UtilisateurConnecte) {
    return this.service.planBase(u);
  }

  /** Base complète : l'empreinte de chaque école du pays (synchronisation). */
  @Get('base/empreintes')
  empreintesBase(@Utilisateur() u: UtilisateurConnecte) {
    return this.service.empreintesBase(u);
  }

  /** Base complète : les paquets des écoles qui ont changé. */
  @Post('base/ecoles')
  @HttpCode(200)
  ecolesBase(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() corps: { ids?: number[] },
  ) {
    return this.service.ecolesBase(u, corps?.ids ?? []);
  }

  /** La liste nationale très courte (reconnaître un agent venu d'un autre département). */
  @Get('annuaire-national')
  annuaireNational(@Utilisateur() u: UtilisateurConnecte) {
    return this.service.annuaireNational(u);
  }

  @Get('colonnes')
  async colonnes() {
    return {
      ...this.service.colonnes(),
      referentiels: await this.service.referentielsEcole(),
    };
  }

  /** Recherche intelligente d'un agent (nom tapé comme on l'entend, ou matricule). */
  @Get('agents')
  agents(@Utilisateur() u: UtilisateurConnecte, @Query('q') q?: string) {
    return this.service.rechercherAgents(u, String(q ?? ''));
  }

  /** La fiche d'un agent (colonnes du formulaire), même enregistré dans un autre département. */
  @Get('agent/:id')
  agent(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.agent(u, id);
  }

  /** Un bâtiment ou une annexe découvert sur place (nom, et sa position si prélevée). */
  @Post('ecole/:id/batiments')
  @HttpCode(200)
  ajouterBatiment(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body()
    corps: {
      nom?: unknown;
      type?: unknown;
      latitude?: unknown;
      longitude?: unknown;
      precision?: unknown;
    },
  ) {
    return this.service.ajouterBatiment(u, id, corps ?? {});
  }

  /** L'annuaire d'un département (recherche d'un agent sans réseau). */
  @Get('annuaire/:departement')
  annuaire(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('departement', ParseIntPipe) departement: number,
  ) {
    return this.service.annuaire(u, departement);
  }

  @Get('ecole/:id')
  paquet(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.paquet(u, id);
  }

  /** Signalements du terrain (absent, parti, inconnu ici) : à traiter, ou déjà traités (?traites=1). */
  @Get('signalements')
  signalements(
    @Utilisateur() u: UtilisateurConnecte,
    @Query('traites') traites?: string,
  ) {
    return this.service.signalements(u, traites === '1');
  }

  @Roles(...ROLES_TRAITEMENT)
  @Post('signalements/:id/traite')
  @HttpCode(200)
  traiter(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.traiter(u, id);
  }

  /** Une salle vue sur place. */
  @Post('ecole/:id/salles')
  @HttpCode(200)
  ajouterSalle(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body() corps: Record<string, unknown>,
  ) {
    return this.service.ajouterSalle(u, id, corps ?? {});
  }

  /** Une classe ouverte cette année, vue sur place. */
  @Post('ecole/:id/classes')
  @HttpCode(200)
  ajouterClasse(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body() corps: Record<string, unknown>,
  ) {
    return this.service.ajouterClasse(u, id, corps ?? {});
  }

  /** Ce que l'équipe constate sur l'école (fermée, introuvable, autre nom…), « école terminée ». */
  @Post('ecole/:id/constat')
  @HttpCode(200)
  constatEcole(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body() corps: SaisieConstatEcole,
  ) {
    return this.constats.ecole(u, id, corps ?? {});
  }

  /** Une école trouvée sur place mais absente de la liste : signalée à la DGRHAS. */
  @Post('ecoles-signalees')
  @HttpCode(200)
  proposerEcole(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() corps: SaisiePropositionEcole,
  ) {
    return this.constats.proposer(u, corps ?? {});
  }

  /** À la DGRHAS : les constats sur les écoles à vérifier, et les écoles signalées. */
  @Roles(...ROLES_TRAITEMENT, 'DDEPPSA')
  @Get('constats-ecoles')
  constatsEcoles(
    @Utilisateur() u: UtilisateurConnecte,
    @Query('traites') traites?: string,
  ) {
    return this.constats.liste(u, traites === '1');
  }

  @Roles(...ROLES_TRAITEMENT)
  @Post('constats-ecoles/:id/traite')
  @HttpCode(200)
  traiterConstatEcole(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.constats.traiter(u, id);
  }

  /** Premier usage d'un appareil : sa clé de secours (une seule fois). */
  @Post('cle-secours')
  @HttpCode(200)
  creerCleSecours(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() corps: { appareil?: string },
  ) {
    return this.constats.creerCleSecours(u, String(corps?.appareil ?? ''));
  }

  /** Code de l'appareil oublié : le mot de passe du compte rend la clé de secours. */
  @Post('cle-secours/recuperer')
  @HttpCode(200)
  recupererCleSecours(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() corps: { appareil?: string; motDePasse?: string },
  ) {
    return this.constats.recupererCleSecours(
      u,
      String(corps?.appareil ?? ''),
      String(corps?.motDePasse ?? ''),
    );
  }

  @Post('envoyer')
  @HttpCode(200)
  envoyer(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() corps: { modifications?: ModificationTerrain[] },
  ) {
    return this.service.envoyer(u, corps?.modifications ?? []);
  }
}
