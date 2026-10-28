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
import { BesoinsAdministratifsService } from './besoins-administratifs.service';
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
  @Put(':id/emploi-du-temps/reglages')
  reglagesEdt(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body()
    dto: {
      jours?: number[];
      creneaux?: string;
      heuresEnseignant?: number;
      general?: boolean;
    },
  ) {
    return this.edt.enregistrerReglages(u, id, dto?.general ? null : dto);
  }

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

/**
 * Besoins en personnel des structures administratives (DG, 28/10/2026) : cadre organique (effectif
 * normal de chaque poste) et demandes, auxquelles la DGRHAS répond.
 */
@Roles(...ROLES_TRAITEMENT, 'DDEPPSA', 'STRUCTURE')
@Controller('besoins-administratifs')
export class BesoinsAdministratifsController {
  constructor(private readonly service: BesoinsAdministratifsService) {}

  @Get()
  liste(
    @Utilisateur() u: UtilisateurConnecte,
    @Query('statut') statut?: string,
    @Query('departement') departement?: string,
  ) {
    return this.service.liste(u, { statut, departement: nombre(departement) });
  }

  @Get('postes')
  postes() {
    return this.service.postes();
  }

  @Get('structures/:id')
  situation(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.situation(u, id);
  }

  @Put('structures/:id/cadre')
  cadre(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { lignes: { poste: string; effectif: number }[] },
  ) {
    return this.service.fixerCadre(u, id, dto?.lignes);
  }

  @Post('structures/:id/demandes')
  exprimer(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { poste: string; nombre: number; motif: string },
  ) {
    return this.service.exprimer(u, id, dto);
  }

  @Post('demandes/:id/decision')
  decider(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
    @Body()
    dto: { decision: string; nombreAccorde?: number; commentaire?: string },
  ) {
    return this.service.decider(u, id, dto);
  }

  @Delete('demandes/:id')
  retirer(
    @Utilisateur() u: UtilisateurConnecte,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.retirer(u, id);
  }
}
