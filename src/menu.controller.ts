import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Put,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Roles, Utilisateur, type UtilisateurConnecte } from './auth/auth';
import { JournalService, ParametresService } from './core/core.service';

const CLE = 'MENU_CONFIG';

/**
 * Le menu tel que le DG le veut (réunion du 24/10/2026) : le nom des grandes rubriques, des
 * domaines et des rubriques, et leur ordre. Réglé par l'administrateur ou le DG, il vaut pour tout
 * le monde. Seuls les écarts avec le menu d'origine sont gardés.
 */
export interface ConfigMenu {
  /** Nouveau nom, par clé : « pole:rh », « espace:recrutement », « rubrique:/pilotage ». */
  noms: Record<string, string>;
  /** Ordre, par liste : « menu » (les rubriques du menu), « pole:rh » (ses domaines), « espace:… » (ses rubriques). */
  ordres: Record<string, string[]>;
}

const CLE_VALIDE = /^(pole|espace|rubrique):[\w/?=&.-]{1,80}$/;
const LISTE_VALIDE = /^(menu|pole:[\w-]{1,40}|espace:[\w-]{1,40})$/;

function valider(brut: unknown): ConfigMenu {
  const b = (brut && typeof brut === 'object' ? brut : {}) as Record<
    string,
    unknown
  >;
  const noms: Record<string, string> = {};
  for (const [k, v] of Object.entries(
    (b.noms && typeof b.noms === 'object' ? b.noms : {}) as Record<
      string,
      unknown
    >,
  )) {
    if (!CLE_VALIDE.test(k)) continue;
    const t = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
    if (!t) continue;
    if (t.length > 60)
      throw new BadRequestException(
        `« ${t.slice(0, 30)}… » : 60 caractères au plus pour un nom du menu.`,
      );
    noms[k] = t;
  }
  const ordres: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(
    (b.ordres && typeof b.ordres === 'object' ? b.ordres : {}) as Record<
      string,
      unknown
    >,
  )) {
    if (!LISTE_VALIDE.test(k) || !Array.isArray(v)) continue;
    ordres[k] = [
      ...new Set(
        v
          .filter((x): x is string => typeof x === 'string')
          .map((x) => x.slice(0, 120)),
      ),
    ].slice(0, 60);
  }
  return { noms, ordres };
}

@Controller('menu')
export class MenuController {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly params: ParametresService,
    private readonly journal: JournalService,
  ) {}

  /** Pour tous les comptes : le menu s'affiche avec ces noms. */
  @Get('configuration')
  configuration(): ConfigMenu {
    try {
      return valider(JSON.parse(this.params.get(CLE) || '{}'));
    } catch {
      return { noms: {}, ordres: {} };
    }
  }

  @Roles('ADMIN', 'DG')
  @Put('configuration')
  async enregistrer(
    @Utilisateur() u: UtilisateurConnecte,
    @Body() body: unknown,
  ) {
    const c = valider(body);
    await this.db.query(
      `INSERT INTO parametre (cle, valeur, description) VALUES ($1, $2, $3)
       ON CONFLICT (cle) DO UPDATE SET valeur = EXCLUDED.valeur`,
      [CLE, JSON.stringify(c), 'Noms et ordre du menu (Administration › Menu)'],
    );
    await this.params.charger();
    await this.journal.log(u, 'MENU_CONFIGURATION', 'parametre', CLE, {
      noms: Object.keys(c.noms).length,
      ordres: Object.keys(c.ordres).length,
    });
    return c;
  }
}
