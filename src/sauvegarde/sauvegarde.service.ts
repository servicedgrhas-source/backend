import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Writable } from 'stream';
import { DataSource } from 'typeorm';

/** Action du journal posée à chaque sauvegarde téléchargée. */
export const ACTION_SAUVEGARDE = 'SAUVEGARDE_TELECHARGEE';
/** … et à chaque sauvegarde envoyée chez Cloudinary. */
export const ACTION_CLOUDINARY = 'SAUVEGARDE_CLOUDINARY';

/** Lignes lues par paquet : la mémoire du serveur reste petite, même pour le journal. */
const PAQUET = 2000;

interface Colonne {
  nom: string;
  /** Identité « GENERATED ALWAYS » : l'insertion doit forcer la valeur. */
  identiteForcee: boolean;
}

const id = (nom: string) => `"${nom.replace(/"/g, '""')}"`;

/**
 * Sauvegarde de la base (DG, 31/10/2026) : toutes les données de toutes les tables, écrites en SQL
 * (fichier .sql, compressé par l'appelant). Produite par le serveur lui-même, sans pg_dump (absent
 * de l'hébergement) : chaque valeur est écrite par PostgreSQL (quote_nullable), donc exacte.
 * Restauration : sur une base créée par le serveur (mêmes migrations), exécuter le fichier.
 */
@Injectable()
export class SauvegardeService {
  constructor(@InjectDataSource() private readonly base: DataSource) {}

  /** Tables de la base, les tables référencées avant celles qui les référencent. */
  private async tables(): Promise<string[]> {
    const toutes = (
      await this.base.query<{ t: string }[]>(
        `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1`,
      )
    ).map((x) => x.t);
    const liens = await this.base.query<{ enfant: string; parent: string }[]>(
      `SELECT e.relname AS enfant, p.relname AS parent FROM pg_constraint k
       JOIN pg_class e ON e.oid = k.conrelid JOIN pg_class p ON p.oid = k.confrelid
       JOIN pg_namespace n ON n.oid = k.connamespace
       WHERE k.contype = 'f' AND n.nspname = 'public' AND e.relname <> p.relname`,
    );
    const ordre: string[] = [];
    const fait = new Set<string>();
    const visiter = (t: string, chemin: Set<string>) => {
      if (fait.has(t) || chemin.has(t)) return;
      chemin.add(t);
      for (const l of liens) if (l.enfant === t) visiter(l.parent, chemin);
      chemin.delete(t);
      fait.add(t);
      ordre.push(t);
    };
    for (const t of toutes) visiter(t, new Set());
    return ordre;
  }

  private async colonnes(table: string): Promise<Colonne[]> {
    return (
      await this.base.query<
        { nom: string; identite: string | null; genere: string }[]
      >(
        `SELECT column_name AS nom, identity_generation AS identite, is_generated AS genere
         FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1
         ORDER BY ordinal_position`,
        [table],
      )
    )
      .filter((c) => c.genere !== 'ALWAYS')
      .map((c) => ({ nom: c.nom, identiteForcee: c.identite === 'ALWAYS' }));
  }

  /** Ce que contient la base : tables, lignes, taille ; dernières sauvegardes. */
  async apercu() {
    const tables = await this.tables();
    const lignes: { table: string; lignes: number }[] = [];
    for (const t of tables) {
      const [{ n }] = await this.base.query<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM ${id(t)}`,
      );
      lignes.push({ table: t, lignes: n });
    }
    const [{ taille }] = await this.base.query<{ taille: string }[]>(
      `SELECT pg_database_size(current_database())::text AS taille`,
    );
    const dernieres = await this.base.query<
      { date: string; par: string | null; action: string; details: unknown }[]
    >(
      `SELECT date, "utilisateurNom" AS par, action, details FROM journal WHERE action IN ($1, $2)
       ORDER BY date DESC LIMIT 10`,
      [ACTION_SAUVEGARDE, ACTION_CLOUDINARY],
    );
    return {
      tables: lignes.sort((a, b) => b.lignes - a.lignes),
      totalLignes: lignes.reduce((s, x) => s + x.lignes, 0),
      tailleOctets: Number(taille),
      dernieres,
    };
  }

  /**
   * Écrit la sauvegarde dans `sortie` (un flux gzip vers le navigateur). Renvoie le nombre de
   * tables et de lignes écrites.
   */
  async ecrire(sortie: Writable, auteur: string) {
    const ecrire = (texte: string) =>
      new Promise<void>((ok) => {
        if (sortie.write(texte)) ok();
        else sortie.once('drain', ok);
      });
    const tables = await this.tables();
    const [{ version }] = await this.base.query<{ version: string }[]>(
      `SELECT current_setting('server_version') AS version`,
    );
    const migrations = await this.base
      .query<{ name: string }[]>(
        `SELECT name FROM migrations ORDER BY id DESC LIMIT 1`,
      )
      .catch(() => [] as { name: string }[]);
    await ecrire(
      [
        `-- Sauvegarde de la base SIGRHAS-MEPPSA (DGRHAS)`,
        `-- Faite le ${new Date().toISOString()} par ${auteur.replace(/\n/g, ' ')}`,
        `-- PostgreSQL ${version} · ${tables.length} tables · dernière migration : ${migrations[0]?.name ?? 'inconnue'}`,
        `-- DONNÉES PERSONNELLES : à garder en lieu sûr, ne jamais envoyer par messagerie.`,
        `--`,
        `-- Restaurer : sur une base PostgreSQL vide, démarrer une fois le serveur (il crée les tables`,
        `-- par ses migrations), puis exécuter ce fichier, par exemple : psql "<adresse>" -f fichier.sql`,
        `-- Les données présentes dans la base sont remplacées par celles de la sauvegarde.`,
        ``,
        `SET client_encoding = 'UTF8';`,
        `SET standard_conforming_strings = on;`,
        `BEGIN;`,
        `TRUNCATE TABLE ${tables.map(id).join(', ')} RESTART IDENTITY CASCADE;`,
        ``,
      ].join('\n'),
    );
    let total = 0;
    for (const t of tables) {
      const cols = await this.colonnes(t);
      if (!cols.length) continue;
      const liste = cols.map((c) => id(c.nom)).join(', ');
      const forcee = cols.some((c) => c.identiteForcee)
        ? ' OVERRIDING SYSTEM VALUE'
        : '';
      // PostgreSQL écrit chaque valeur en littéral SQL (texte, JSON, dates, tableaux…)
      const valeurs = cols
        .map((c) => `quote_nullable(${id(c.nom)}::text)`)
        .join(` || ', ' || `);
      await ecrire(`-- ${t}\n`);
      for (let debut = 0; ; debut += PAQUET) {
        const rangs = await this.base.query<{ v: string }[]>(
          `SELECT ${valeurs} AS v FROM ${id(t)} ORDER BY ctid LIMIT ${PAQUET} OFFSET ${debut}`,
        );
        for (const r of rangs)
          await ecrire(
            `INSERT INTO ${id(t)} (${liste})${forcee} VALUES (${r.v});\n`,
          );
        total += rangs.length;
        if (rangs.length < PAQUET) break;
      }
    }
    // Compteurs des numéros automatiques : repris après le plus grand numéro restauré
    const sequences = await this.base.query<
      { t: string; c: string; s: string }[]
    >(
      `SELECT table_name AS t, column_name AS c,
              pg_get_serial_sequence(quote_ident(table_name), column_name) AS s
       FROM information_schema.columns
       WHERE table_schema = 'public' AND column_default LIKE 'nextval(%'`,
    );
    await ecrire('\n');
    for (const q of sequences.filter((x) => x.s))
      await ecrire(
        `SELECT setval('${q.s.replace(/'/g, "''")}', COALESCE((SELECT max(${id(q.c)}) FROM ${id(q.t)}), 0) + 1, false);\n`,
      );
    await ecrire(`COMMIT;\n-- Fin de la sauvegarde : ${total} lignes.\n`);
    return { tables: tables.length, lignes: total };
  }
}
