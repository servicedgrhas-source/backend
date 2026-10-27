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
import { EmploisDuTempsService } from './emplois-du-temps.service';

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
  constructor(
    private readonly service: EtablissementsService,
    private readonly edt: EmploisDuTempsService,
  ) {}

  /** Emploi du temps de l'année (général et par enseignant). */
  @Get(':id/emploi-du-temps')
  emploiDuTemps(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Query('annee') annee?: string,
  ) {
    return this.edt.lire(u, id, annee);
  }

  @Post(':id/emploi-du-temps/generer')
  genererEmploiDuTemps(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { anneeScolaire?: string },
  ) {
    return this.edt.generer(u, id, body?.anneeScolaire);
  }

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

  /** Matière enseignée par un enseignant de l'école (rubrique « Spécialité » de sa fiche). */
  @Put(':id/enseignants/:agent/matiere')
  definirMatiere(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Param('agent', ParseIntPipe) agent: number,
    @Body() body: { matiere?: string | null },
  ) {
    return this.service.definirMatiere(
      u,
      id,
      agent,
      typeof body?.matiere === 'string' && body.matiere ? body.matiere : null,
    );
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

/**
 * Structures administratives (DG, 24/10/2026) : du cabinet aux services, des DDEPPSA aux
 * inspections, chacune avec son personnel.
 */
@Roles(...ROLES_TRAITEMENT, 'DDEPPSA')
@Controller('structures')
export class StructuresController {
  constructor(private readonly service: EtablissementsService) {}

  @Get('arbre')
  arbre(@Utilisateur() u: UtilisateurConnecte) {
    return this.service.arbreStructures(u);
  }

  @Get(':id/personnel')
  personnel(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.personnelStructure(u, id);
  }
}
