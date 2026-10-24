import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  Roles,
  ROLES_TRAITEMENT,
  Utilisateur,
  type UtilisateurConnecte,
} from '../auth/auth';
import { EtablissementsService } from './etablissements.service';

const nombre = (v?: string) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
const QUOI = {
  batiments: 'batiment',
  salles: 'salle',
  classes: 'classe',
} as const;

/** Écoles : bâtiments, salles, classes et besoin en enseignants (DGRHAS, DDEPPSA, chefs d'établissement). */
@Roles(...ROLES_TRAITEMENT, 'DDEPPSA', 'STRUCTURE')
@Controller('etablissements')
export class EtablissementsController {
  constructor(private readonly service: EtablissementsService) {}

  @Get()
  liste(
    @Utilisateur() u: UtilisateurConnecte,
    @Query() q: Record<string, string | undefined>,
  ) {
    return this.service.liste(u, {
      q: q.q,
      departement: nombre(q.departement),
      cycle: q.cycle || undefined,
      annee: q.annee,
    });
  }

  /** Besoins en enseignants de toutes les écoles du périmètre (déficit, pléthore). */
  @Get('besoins')
  besoins(
    @Utilisateur() u: UtilisateurConnecte,
    @Query() q: Record<string, string | undefined>,
  ) {
    return this.service.consolidation(u, {
      departement: nombre(q.departement),
      cycle: q.cycle || undefined,
      annee: q.annee,
    });
  }

  @Get(':id')
  fiche(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Query('annee') annee?: string,
  ) {
    return this.service.fiche(u, id, annee);
  }

  @Post(':id/classes/ouvrir')
  ouvrir(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: Record<string, unknown>,
  ) {
    return this.service.ouvrirClasses(u, id, dto);
  }

  @Post(':id/:quoi')
  ajouter(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Param('quoi') quoi: string,
    @Body() dto: Record<string, unknown>,
  ) {
    return this.enregistrer(u, id, quoi, null, dto);
  }

  @Put(':id/:quoi/:x')
  modifier(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Param('quoi') quoi: string,
    @Param('x', ParseIntPipe) x: number,
    @Body() dto: Record<string, unknown>,
  ) {
    return this.enregistrer(u, id, quoi, x, dto);
  }

  @Delete(':id/:quoi/:x')
  supprimer(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Param('quoi') quoi: string,
    @Param('x', ParseIntPipe) x: number,
  ) {
    return this.service.supprimer(u, id, this.quoi(quoi), x);
  }

  private quoi(quoi: string) {
    const q = QUOI[quoi as keyof typeof QUOI];
    if (!q) throw new NotFoundException('Élément inconnu');
    return q;
  }

  private enregistrer(
    u: UtilisateurConnecte,
    id: number,
    quoi: string,
    x: number | null,
    dto: Record<string, unknown>,
  ) {
    const q = this.quoi(quoi);
    return q === 'batiment'
      ? this.service.enregistrerBatiment(u, id, x, dto)
      : q === 'salle'
        ? this.service.enregistrerSalle(u, id, x, dto)
        : this.service.enregistrerClasse(u, id, x, dto);
  }
}
