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
import { RecenseursService } from './recenseurs.service';
import { type ModificationTerrain, TerrainService } from './terrain.service';

/** Recensement sur le terrain : paquet d'une école, puis envoi de ce qui a été complété. */
@Roles(...ROLES_TRAITEMENT, 'DDEPPSA', 'STRUCTURE', 'RECENSEUR')
@Controller('recensement/terrain')
export class TerrainController {
  constructor(
    private readonly service: TerrainService,
    private readonly recenseurs: RecenseursService,
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
    @Body() corps: { positions?: Parameters<RecenseursService['recevoirPositions']>[1] },
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
  colonnes() {
    return this.service.colonnes();
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

  @Post('envoyer')
  @HttpCode(200)
  envoyer(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() corps: { modifications?: ModificationTerrain[] },
  ) {
    return this.service.envoyer(u, corps?.modifications ?? []);
  }
}
