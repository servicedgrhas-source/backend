import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import {
  Roles,
  ROLES_TRAITEMENT,
  Utilisateur,
  type UtilisateurConnecte,
} from '../auth/auth';
import { PropositionsBmService } from './propositions-bm.service';

/** Ceux qui contrôlent les modifications du recensement (comme « modifications/controle »). */
const CONTROLE = ['CHEF_SERVICE', 'DIRECTEUR', 'BUREAU_ETUDES', 'DG'] as const;

/**
 * Propositions d'ajout du volet Banque mondiale (18/11/2026) : les personnes sont validées au
 * contrôle des modifications (Recensement), les écoles par le DG (Administration › Organigramme).
 */
@Roles(...ROLES_TRAITEMENT)
@Controller()
export class PropositionsBmController {
  constructor(private readonly prop: PropositionsBmService) {}

  @Get('propositions-ajout')
  agents() {
    return this.prop.liste('AGENT');
  }

  @Roles(...CONTROLE)
  @Post('propositions-ajout/:id/valider')
  validerAgent(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body() b: { forcer?: boolean },
  ) {
    return this.prop.valider(u, id, b?.forcer === true, 'AGENT');
  }

  @Roles(...CONTROLE)
  @Post('propositions-ajout/:id/rejeter')
  rejeterAgent(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body() b: { note?: string },
  ) {
    return this.prop.rejeter(u, id, String(b?.note ?? ''), 'AGENT');
  }

  @Get('propositions-ecoles')
  ecoles() {
    return this.prop.liste('ECOLE');
  }

  @Roles('DG')
  @Post('propositions-ecoles/:id/valider')
  validerEcole(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.prop.valider(u, id, false, 'ECOLE');
  }

  @Roles('DG')
  @Post('propositions-ecoles/:id/rejeter')
  rejeterEcole(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body() b: { note?: string },
  ) {
    return this.prop.rejeter(u, id, String(b?.note ?? ''), 'ECOLE');
  }
}
