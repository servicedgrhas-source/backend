import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Put,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { JournalService, ParametresService } from '../core/core.service';
import {
  CLE_DROITS,
  Roles,
  Utilisateur,
  type UtilisateurConnecte,
} from './auth';
import {
  BASES_INTERDITES,
  RUBRIQUES_API,
  RUBRIQUES_NON_OUVRABLES,
  ROLES_LIBRES,
  validerDroits,
  type ConfigDroits,
} from './droits';

/** Administration › Droits : qui voit quoi, qui fait quoi (réunion DG du 26/10/2026). */
@Controller('droits')
export class DroitsController {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly params: ParametresService,
    private readonly journal: JournalService,
  ) {}

  private lire(): ConfigDroits {
    try {
      return validerDroits(JSON.parse(this.params.get(CLE_DROITS) || '{}'));
    } catch {
      return { roles: {}, utilisateurs: {}, rolesPerso: {}, attributions: {} };
    }
  }

  @Roles('ADMIN', 'DG')
  @Get()
  configuration() {
    return {
      ...this.lire(),
      rubriques: Object.keys(RUBRIQUES_API),
      nonOuvrables: [...RUBRIQUES_NON_OUVRABLES],
      rolesLibres: ROLES_LIBRES,
    };
  }

  @Roles('ADMIN', 'DG')
  @Put()
  async enregistrer(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() body: unknown,
  ) {
    const c = validerDroits(body);
    // Rôle personnalisé donné à un compte : le compte prend son rôle de départ (ses actions)
    const attribues = Object.entries(c.attributions ?? {});
    if (attribues.length) {
      const comptes = await this.db.query<
        { id: string; role: string; nom: string }[]
      >(`SELECT id, role, nom FROM utilisateur WHERE id = ANY($1)`, [
        attribues.map(([id]) => id),
      ]);
      for (const k of comptes)
        if (BASES_INTERDITES.includes(k.role as never))
          throw new BadRequestException(
            `${k.nom} : un compte administrateur, DG ou de structure ne reçoit pas de rôle personnalisé.`,
          );
    }
    await this.db.transaction(async (m) => {
      for (const [id, code] of attribues)
        await m.query(
          `UPDATE utilisateur SET role = $2 WHERE id = $1 AND role <> $2`,
          [id, c.rolesPerso![code].base],
        );
    });
    await this.db.query(
      `INSERT INTO parametre (cle, valeur, description) VALUES ($1, $2, $3)
       ON CONFLICT (cle) DO UPDATE SET valeur = EXCLUDED.valeur`,
      [
        CLE_DROITS,
        JSON.stringify(c),
        'Droits par rubrique, par rôle et par personne (Administration › Droits)',
      ],
    );
    await this.params.charger();
    await this.journal.log(u, 'DROITS_RUBRIQUES', 'parametre', CLE_DROITS, {
      roles: Object.keys(c.roles).length,
      personnes: Object.keys(c.utilisateurs).length,
      rolesPerso: Object.keys(c.rolesPerso ?? {}).length,
      attributions: Object.keys(c.attributions ?? {}).length,
    });
    return this.configuration();
  }
}
