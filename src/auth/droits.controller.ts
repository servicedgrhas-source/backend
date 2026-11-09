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

  /**
   * Ce qui a changé dans les droits : pour chaque rôle ou personne, chaque rubrique dont le niveau
   * a changé (« Chef de service · /mutations : comme d'origine → lecture seule »).
   */
  private async changementsDroits(avant: ConfigDroits, apres: ConfigDroits) {
    const NIVEAU: Record<string, string> = {
      MASQUE: 'masquée',
      LECTURE: 'lecture seule',
      MODIFICATION: 'ouverte',
    };
    const ROLE: Record<string, string> = {
      AGENT: 'Chef de bureau',
      CHEF_SERVICE: 'Chef de service',
      DIRECTEUR: 'Directeur',
      BUREAU_ETUDES: 'Bureau d’études',
      DG: 'DG',
      DDEPPSA: 'DDEPPSA',
      CABINET: 'Cabinet',
      SECRETARIAT: 'Secrétariat',
      STRUCTURE: 'Structure',
      VISITEUR: 'Visiteur',
      INFORMATIQUE: 'Informatique',
    };
    const ids = [
      ...new Set([
        ...Object.keys(avant.utilisateurs ?? {}),
        ...Object.keys(apres.utilisateurs ?? {}),
        ...Object.keys(avant.attributions ?? {}),
        ...Object.keys(apres.attributions ?? {}),
      ]),
    ];
    const noms = new Map(
      ids.length
        ? (
            await this.db.query<{ id: string; nom: string }[]>(
              `SELECT id::text, nom FROM utilisateur WHERE id::text = ANY($1)`,
              [ids],
            )
          ).map((x) => [x.id, x.nom])
        : [],
    );
    const libelleRole = (k: string) =>
      apres.rolesPerso?.[k]?.libelle ??
      avant.rolesPerso?.[k]?.libelle ??
      ROLE[k] ??
      k;
    const res: { champ: string; avant: string; apres: string }[] = [];
    const comparer = (
      qui: string,
      a: Record<string, string> = {},
      b: Record<string, string> = {},
    ) => {
      for (const rub of [...new Set([...Object.keys(a), ...Object.keys(b)])])
        if (a[rub] !== b[rub])
          res.push({
            champ: `${qui} · ${rub}`,
            avant: a[rub] ? (NIVEAU[a[rub]] ?? a[rub]) : 'comme d’origine',
            apres: b[rub] ? (NIVEAU[b[rub]] ?? b[rub]) : 'comme d’origine',
          });
    };
    for (const k of new Set([
      ...Object.keys(avant.roles ?? {}),
      ...Object.keys(apres.roles ?? {}),
    ]))
      comparer(
        `Rôle ${libelleRole(k)}`,
        (avant.roles as Record<string, Record<string, string>>)[k],
        (apres.roles as Record<string, Record<string, string>>)[k],
      );
    for (const k of new Set([
      ...Object.keys(avant.utilisateurs ?? {}),
      ...Object.keys(apres.utilisateurs ?? {}),
    ]))
      comparer(
        noms.get(k) ?? k,
        avant.utilisateurs?.[k],
        apres.utilisateurs?.[k],
      );
    for (const k of new Set([
      ...Object.keys(avant.rolesPerso ?? {}),
      ...Object.keys(apres.rolesPerso ?? {}),
    ]))
      if (!avant.rolesPerso?.[k] || !apres.rolesPerso?.[k])
        res.push({
          champ: 'Rôle personnalisé',
          avant: avant.rolesPerso?.[k]?.libelle ?? '',
          apres: apres.rolesPerso?.[k]?.libelle ?? '',
        });
    for (const k of new Set([
      ...Object.keys(avant.attributions ?? {}),
      ...Object.keys(apres.attributions ?? {}),
    ]))
      if (avant.attributions?.[k] !== apres.attributions?.[k])
        res.push({
          champ: `Rôle personnalisé de ${noms.get(k) ?? k}`,
          avant: avant.attributions?.[k]
            ? libelleRole(avant.attributions[k])
            : '',
          apres: apres.attributions?.[k]
            ? libelleRole(apres.attributions[k])
            : '',
        });
    return res.slice(0, 200);
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
    // L'état d'avant, pour dire dans le journal ce qui a changé (DG, 09/11/2026)
    const avant = this.lire();
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
      changements: await this.changementsDroits(avant, c),
    });
    return this.configuration();
  }
}
