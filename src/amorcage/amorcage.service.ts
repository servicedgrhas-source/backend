import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DataSource, type EntityManager } from 'typeorm';
import { ParametresService } from '../core/core.service';
import {
  Agent,
  Beneficiaire,
  DemandeMutation,
  Departement,
  Enrole,
  Grade,
  OrigineDossier,
  Parametre,
  RegleDiplome,
  Structure,
  TypePrestation,
  Utilisateur,
} from '../entities';

/**
 * Amorçage de la configuration : ce qui se règle dans « Administration » et qu'il ne faut pas
 * refaire à la main sur une nouvelle base (mise en ligne, nouveau poste) :
 * paramètres, grades, règles des diplômes, organigramme, catalogue des prestations,
 * bénéficiaires du quota et origines des dossiers.
 *
 * Jamais les données de travail (recrutés, affectations, notes, demandes, enrôlés…),
 * ni les comptes : le premier administrateur vient de ADMIN_EMAIL / ADMIN_PASSWORD.
 *
 * Le fichier `amorcage/configuration.json` (à la racine du backend) est produit par
 * « Exporter la configuration » sur une base déjà réglée, puis versionné avec le code.
 * Au démarrage, il est chargé une seule fois, et seulement sur une base sans données de travail.
 */
export const FICHIER_AMORCAGE = resolve(
  process.cwd(),
  'amorcage',
  'configuration.json',
);
/** Paramètre témoin : l'amorçage a déjà eu lieu sur cette base. */
const TEMOIN = 'AMORCAGE_CONFIGURATION';

export interface ConfigurationExportee {
  version: 1;
  exporteLe: string;
  departements: { id: number; code: string }[];
  parametres: Parametre[];
  grades: Grade[];
  regles: RegleDiplome[];
  structures: Structure[];
  prestations: TypePrestation[];
  beneficiaires: Beneficiaire[];
  origines: OrigineDossier[];
}

@Injectable()
export class AmorcageService {
  private readonly log = new Logger('Amorçage');

  constructor(
    @InjectDataSource() private readonly base: DataSource,
    private readonly params: ParametresService,
  ) {}

  /** Configuration actuelle, lue telle qu'elle est en base. */
  async exporter(): Promise<ConfigurationExportee> {
    const m = this.base.manager;
    const sansDate = <T extends object>(lignes: T[]) =>
      lignes.map((l) => {
        const { creeLe: _c, ...reste } = l as T & { creeLe?: unknown };
        return reste as T;
      });
    return {
      version: 1,
      exporteLe: new Date().toISOString(),
      departements: (await m.find(Departement, { order: { id: 'ASC' } })).map(
        (d) => ({ id: d.id, code: d.code }),
      ),
      // Le témoin d'amorçage n'est pas exporté : il est propre à chaque base
      parametres: (
        await m.find(Parametre, { order: { cle: 'ASC' } })
      ).filter((p) => p.cle !== TEMOIN),
      grades: await m.find(Grade, { order: { code: 'ASC' } }),
      regles: await m.find(RegleDiplome, { order: { code: 'ASC' } }),
      structures: sansDate(await m.find(Structure, { order: { id: 'ASC' } })),
      prestations: await m.find(TypePrestation, { order: { ordre: 'ASC' } }),
      beneficiaires: await m.find(Beneficiaire, { order: { id: 'ASC' } }),
      origines: await m.find(OrigineDossier, { order: { id: 'ASC' } }),
    };
  }

  /** Écrit l'export dans le fichier d'amorçage (sur le poste de développement). */
  async exporterVersFichier() {
    const c = await this.exporter();
    mkdirSync(dirname(FICHIER_AMORCAGE), { recursive: true });
    writeFileSync(FICHIER_AMORCAGE, JSON.stringify(c, null, 2) + '\n', 'utf8');
    return { fichier: FICHIER_AMORCAGE, ...this.comptes(c) };
  }

  private comptes(c: ConfigurationExportee) {
    return {
      parametres: c.parametres.length,
      grades: c.grades.length,
      regles: c.regles.length,
      structures: c.structures.length,
      prestations: c.prestations.length,
      beneficiaires: c.beneficiaires.length,
      origines: c.origines.length,
    };
  }

  /**
   * Au démarrage (après les créations automatiques des valeurs par défaut) : charge le
   * fichier d'amorçage s'il existe, si la base ne l'a pas déjà reçu et si elle ne contient
   * aucune donnée de travail. AMORCAGE=non le désactive.
   */
  async amorcerAuDemarrage() {
    if ((process.env.AMORCAGE ?? '').toLowerCase() === 'non') return;
    if (!existsSync(FICHIER_AMORCAGE)) {
      this.log.log('Pas de fichier d’amorçage : configuration par défaut.');
      return;
    }
    const m = this.base.manager;
    if (await m.exists(Parametre, { where: { cle: TEMOIN } })) return;
    const travail =
      (await m.count(Agent)) +
      (await m.count(DemandeMutation)) +
      (await m.count(Enrole)) +
      (await m.count(Utilisateur, { where: { role: 'STRUCTURE' } }));
    if (travail > 0) {
      this.log.warn(
        'Base déjà utilisée (données de travail présentes) : amorçage non appliqué.',
      );
      return;
    }
    const c = JSON.parse(
      readFileSync(FICHIER_AMORCAGE, 'utf8'),
    ) as ConfigurationExportee;
    await this.appliquer(c);
    await this.params.charger();
    this.log.log(
      `Configuration chargée (export du ${c.exporteLe}) : ${JSON.stringify(this.comptes(c))}`,
    );
  }

  /** Remplace la configuration de la base par celle de l'export, en une seule transaction. */
  async appliquer(c: ConfigurationExportee) {
    if (c.version !== 1) throw new Error('Fichier d’amorçage : version inconnue');
    await this.base.transaction(async (m) => {
      // Les départements sont créés au démarrage : on fait correspondre leurs n° par le code
      const parCode = new Map(
        (await m.find(Departement)).map((d) => [d.code, d.id]),
      );
      const dep = new Map(
        c.departements.map((d) => [d.id, parCode.get(d.code) ?? null]),
      );
      const depDe = (id: number | null) => (id == null ? null : (dep.get(id) ?? null));

      for (const p of c.parametres) await m.save(Parametre, p);

      // Grades puis diplômes (un diplôme renvoie à son grade)
      await this.remplacerParCode(m, RegleDiplome, c.regles, 'code', false);
      await this.remplacerParCode(m, Grade, c.grades, 'code', true);
      await this.remplacerParCode(m, RegleDiplome, c.regles, 'code', true);
      await this.remplacerParCode(m, TypePrestation, c.prestations, 'code', true);

      // Organigramme, bénéficiaires, origines : mêmes n° qu'à l'export (liens parent, bénéficiaire)
      await m.query('DELETE FROM structure');
      await this.insererAvecIds(
        m,
        Structure,
        c.structures.map((s) => ({ ...s, departementId: depDe(s.departementId) })),
      );
      await m.query('DELETE FROM origine_dossier');
      await m.query('DELETE FROM beneficiaire');
      await this.insererAvecIds(m, Beneficiaire, c.beneficiaires);
      await this.insererAvecIds(m, OrigineDossier, c.origines);
      for (const table of ['structure', 'beneficiaire', 'origine_dossier'])
        await m.query(
          `SELECT setval(pg_get_serial_sequence('${table}', 'id'), coalesce((SELECT max(id) FROM ${table}), 0) + 1, false)`,
        );

      await m.save(Parametre, {
        cle: TEMOIN,
        valeur: c.exporteLe,
        description: 'Configuration chargée au premier démarrage (date de l’export)',
      });
    });
  }

  /**
   * Insère les lignes en gardant leur n° (`id`) : `insert()` de TypeORM l'ignore sur une
   * colonne auto-incrémentée, ce qui casserait les liens (parent, bénéficiaire d'une origine).
   * Ordre des lignes : un parent avant ses enfants (export trié par n°).
   */
  private async insererAvecIds<T extends object>(
    m: EntityManager,
    cible: new () => T,
    lignes: T[],
  ) {
    if (!lignes.length) return;
    const meta = m.getRepository(cible).metadata;
    const colonnes = meta.columns.filter((col) =>
      lignes.some((l) => col.propertyName in l),
    );
    const noms = colonnes.map((col) => `"${col.databaseName}"`).join(', ');
    for (const l of lignes) {
      const valeurs = colonnes.map((col) => {
        const v = (l as Record<string, unknown>)[col.propertyName];
        return v === undefined ? null : v;
      });
      await m.query(
        `INSERT INTO "${meta.tableName}" (${noms}) VALUES (${valeurs.map((_, i) => `$${i + 1}`).join(', ')})`,
        valeurs,
      );
    }
  }

  /**
   * Met la table à l'image de l'export (clé : `code`). `ecrire=false` : retire seulement ce
   * qui n'est pas dans l'export.
   */
  private async remplacerParCode<T extends { code: string }>(
    m: EntityManager,
    cible: new () => T,
    lignes: T[],
    cle: 'code',
    ecrire: boolean,
  ) {
    const codes = lignes.map((l) => l[cle]);
    const table = m.getRepository(cible).metadata.tableName;
    if (!ecrire) {
      await m.query(`DELETE FROM ${table} WHERE NOT (code = ANY($1))`, [codes]);
      return;
    }
    await m.query(`DELETE FROM ${table} WHERE NOT (code = ANY($1))`, [codes]);
    for (const l of lignes) await m.save(cible, l as never);
  }
}
