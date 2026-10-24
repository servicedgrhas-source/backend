import { Controller, ForbiddenException, Get, Post } from '@nestjs/common';
import { Roles, Utilisateur, type UtilisateurConnecte } from '../auth/auth';
import { JournalService } from '../core/core.service';
import { AmorcageService } from './amorcage.service';

/** Export de la configuration (Administration) : à recharger sur une autre base. */
@Roles('DG')
@Controller('amorcage')
export class AmorcageController {
  constructor(
    private readonly amorcage: AmorcageService,
    private readonly journal: JournalService,
  ) {}

  /** La configuration actuelle, en JSON (téléchargement). */
  @Get('export')
  async exporter(@Utilisateur() u: UtilisateurConnecte) {
    await this.journal.log(u, 'EXPORT_CONFIGURATION', 'parametre', null);
    return this.amorcage.exporter();
  }

  /**
   * Écrit l'export dans `amorcage/configuration.json`, le fichier versionné avec le code et
   * chargé au premier démarrage d'une nouvelle base. Poste de développement seulement.
   */
  @Roles('ADMIN')
  @Post('export/fichier')
  async exporterVersFichier(@Utilisateur() u: UtilisateurConnecte) {
    if (process.env.NODE_ENV === 'production')
      throw new ForbiddenException(
        'Réservé au poste de développement : en ligne, utilisez « Exporter ».',
      );
    const r = await this.amorcage.exporterVersFichier();
    await this.journal.log(
      u,
      'EXPORT_CONFIGURATION_FICHIER',
      'parametre',
      null,
      r,
    );
    return r;
  }
}
