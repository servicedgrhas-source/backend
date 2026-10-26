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
 * Le menu tel que le DG le veut (réunions du 24 et du 26/10/2026), réglé par l'administrateur ou le
 * DG et valable pour tout le monde : noms, place de chaque rubrique, sous-sections, domaines et
 * grandes rubriques créés. Le serveur ne garde que ce qui a une forme valide ; c'est l'écran qui,
 * en partant du menu d'origine, place ce qui manque (rien ne peut se perdre).
 */
export interface ConfigMenu {
  version?: number;
  /** Nouveau nom, par clé : « pole:rh », « espace:recrutement », « rubrique:<domaine><adresse> ». */
  noms: Record<string, string>;
  /** Ancien format : ordre, par liste (« menu », « pole:rh », « espace:… »). */
  ordres?: Record<string, string[]>;
  descriptions?: Record<string, string>;
  icones?: Record<string, string>;
  nouveaux?: { poles: string[]; espaces: string[] };
  structure?: {
    menu: string[];
    poles: Record<string, string[]>;
    espaces: Record<string, { r: string; g?: string }[]>;
  };
}

const CLE_VALIDE = /^(pole|espace|rubrique):[\w/?=&.-]{1,120}$/;
const LISTE_VALIDE = /^(menu|pole:[\w-]{1,50}|espace:[\w-]{1,50})$/;
const CLE_ENTREE = /^[\w-]{1,50}$/;
const CLE_PERSO = /^perso-[a-z0-9-]{1,40}$/;
const RUBRIQUE = /^[\w-]{1,50}\/[\w/?=&.-]{0,120}$/;
const ICONE = /^[A-Za-z0-9]{1,30}$/;

const objet = (v: unknown) =>
  (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<
    string,
    unknown
  >;
const texte = (v: unknown) =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';

export function valider(brut: unknown): ConfigMenu {
  const b = objet(brut);
  const noms: Record<string, string> = {};
  for (const [k, v] of Object.entries(objet(b.noms))) {
    if (!CLE_VALIDE.test(k)) continue;
    const t = texte(v);
    if (!t) continue;
    if (t.length > 60)
      throw new BadRequestException(
        `« ${t.slice(0, 30)}… » : 60 caractères au plus pour un nom du menu.`,
      );
    noms[k] = t;
  }
  const ordres: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(objet(b.ordres))) {
    if (!LISTE_VALIDE.test(k) || !Array.isArray(v)) continue;
    ordres[k] = [
      ...new Set(
        v
          .filter((x): x is string => typeof x === 'string')
          .map((x) => x.slice(0, 120)),
      ),
    ].slice(0, 80);
  }
  const descriptions: Record<string, string> = {};
  for (const [k, v] of Object.entries(objet(b.descriptions))) {
    if (!/^(pole|espace):[\w-]{1,50}$/.test(k)) continue;
    const t = texte(v);
    if (!t) continue;
    if (t.length > 400)
      throw new BadRequestException(
        '400 caractères au plus pour le texte de présentation d’un domaine.',
      );
    descriptions[k] = t;
  }
  const icones: Record<string, string> = {};
  for (const [k, v] of Object.entries(objet(b.icones)))
    if (
      /^(pole|espace):perso-[a-z0-9-]{1,40}$/.test(k) &&
      typeof v === 'string' &&
      ICONE.test(v)
    )
      icones[k] = v;
  const nouveaux = objet(b.nouveaux);
  const liste = (v: unknown, re: RegExp, max: number) =>
    Array.isArray(v)
      ? [
          ...new Set(
            v.filter((x): x is string => typeof x === 'string' && re.test(x)),
          ),
        ].slice(0, max)
      : [];
  const c: ConfigMenu = {
    noms,
    ...(Object.keys(ordres).length ? { ordres } : {}),
    ...(Object.keys(descriptions).length ? { descriptions } : {}),
    ...(Object.keys(icones).length ? { icones } : {}),
  };
  if (b.version === 2) {
    c.version = 2;
    c.nouveaux = {
      poles: liste(nouveaux.poles, CLE_PERSO, 30),
      espaces: liste(nouveaux.espaces, CLE_PERSO, 60),
    };
    const s = objet(b.structure);
    if (Object.keys(s).length) {
      const poles: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(objet(s.poles)).slice(0, 60))
        if (CLE_ENTREE.test(k)) poles[k] = liste(v, CLE_ENTREE, 80);
      const espaces: Record<string, { r: string; g?: string }[]> = {};
      for (const [k, v] of Object.entries(objet(s.espaces)).slice(0, 120)) {
        if (!CLE_ENTREE.test(k) || !Array.isArray(v)) continue;
        espaces[k] = v
          .map((x) => objet(x))
          .filter((x) => typeof x.r === 'string' && RUBRIQUE.test(x.r))
          .slice(0, 120)
          .map((x) => {
            const g = texte(x.g);
            if (g.length > 60)
              throw new BadRequestException(
                '60 caractères au plus pour le nom d’une sous-section.',
              );
            return { r: x.r as string, ...(g ? { g } : {}) };
          });
      }
      c.structure = {
        menu: liste(s.menu, /^(pole|espace):[\w-]{1,50}$/, 80),
        poles,
        espaces,
      };
    }
  }
  return c;
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
      return { noms: {} };
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
      [
        CLE,
        JSON.stringify(c),
        'Menu : noms, places, sous-sections (Administration › Menu)',
      ],
    );
    await this.params.charger();
    await this.journal.log(u, 'MENU_CONFIGURATION', 'parametre', CLE, {
      noms: Object.keys(c.noms).length,
      domainesCrees: c.nouveaux?.espaces.length ?? 0,
      rubriquesCreees: c.nouveaux?.poles.length ?? 0,
    });
    return c;
  }
}
