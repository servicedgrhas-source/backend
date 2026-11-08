import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { Roles, Utilisateur, type UtilisateurConnecte } from '../auth/auth';
import { ParametresService } from '../core/core.service';
import { SecuriteService } from './securite.service';
import { TEXTES_SECURITE } from './textes';

/**
 * Sécurité › Comptes signalés (08/11/2026) : réservé au DG et à l'administrateur (le compte
 * Informatique ne la voit pas). Les comptes suspendus par l'outil de détection, la chronologie des
 * règles franchies, rétablir ou suspendre, et les réglages de l'outil.
 */
@Roles('DG')
@Controller('securite')
export class SecuriteController {
  constructor(
    private readonly securite: SecuriteService,
    private readonly params: ParametresService,
  ) {}

  @Get('comptes')
  async comptes() {
    return {
      textes: TEXTES_SECURITE,
      exemptes: this.securite.listeExemptes(),
      reglages: this.securite.reglages(),
      regles: this.securite.libelles(),
      comptes: await this.securite.comptesSignales(),
    };
  }

  @Get('comptes/:id')
  evenements(@Param('id', ParseUUIDPipe) id: string) {
    return this.securite.evenementsDe(id);
  }

  @Post('comptes/:id/retablir')
  async retablir(
    @Utilisateur() moi: UtilisateurConnecte,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() corps: { motif?: string },
  ) {
    const motif = String(corps?.motif ?? '').trim();
    if (motif.length < 5)
      throw new BadRequestException(
        'Dites ce qui a été vérifié avant de rétablir le compte.',
      );
    await this.securite.retablir(moi, id, motif);
    return { ok: true };
  }

  @Post('comptes/:id/suspendre')
  async suspendre(
    @Utilisateur() moi: UtilisateurConnecte,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() corps: { motif?: string },
  ) {
    if (id === moi.id)
      throw new BadRequestException(
        'Vous ne pouvez pas suspendre votre propre compte.',
      );
    const motif = String(corps?.motif ?? '').trim();
    if (motif.length < 5)
      throw new BadRequestException('Dites pourquoi le compte est suspendu.');
    await this.securite.suspendreManuellement(moi, id, motif);
    return { ok: true };
  }

  @Put('reglages')
  async reglages(
    @Body()
    corps: {
      mode?: string;
      surveillance?: number;
      alerte?: number;
      suspension?: number;
      demiVie?: number;
    },
  ) {
    const valeurs: [string, string | number | undefined][] = [
      ['SECURITE_MODE', corps?.mode],
      ['SECURITE_SEUIL_SURVEILLANCE', corps?.surveillance],
      ['SECURITE_SEUIL_ALERTE', corps?.alerte],
      ['SECURITE_SEUIL_SUSPENSION', corps?.suspension],
      ['SECURITE_DEMI_VIE', corps?.demiVie],
    ];
    const s = Number(corps?.surveillance),
      a = Number(corps?.alerte),
      p = Number(corps?.suspension);
    if (!(s < a && a <= p))
      throw new BadRequestException(
        'Les seuils doivent monter : surveillance, puis alerte, puis suspension.',
      );
    for (const [cle, v] of valeurs) {
      if (v === undefined || v === null) continue;
      this.params.verifier(cle, String(v));
      await this.params.definir(cle, String(v));
    }
    return this.securite.reglages();
  }
}
