import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';

/**
 * Un calcul lourd (tout le registre, toute la base du personnel…) gardé en mémoire tant que les
 * données qu'il lit n'ont pas changé (DG, 16/11/2026 : « ne pas tout recalculer à chaque
 * actualisation »).
 *
 * - Les données ont-elles changé ? Une seule requête très légère : les compteurs d'écritures
 *   (ajouts, modifications, suppressions) que PostgreSQL tient pour chaque table lue.
 * - Rien n'a changé : le résultat gardé est rendu tout de suite.
 * - Quelque chose a changé : le dernier résultat est rendu tout de suite (marqué « mise à jour en
 *   cours ») et le nouveau calcul se fait en arrière-plan, une seule fois à la fois.
 * - Au démarrage du serveur, le calcul est préparé en arrière-plan : le premier visiteur n'attend pas.
 * - `oublier()` : après une décision prise sur la page même, le prochain appel attend le nouveau
 *   calcul (la personne doit voir sa décision appliquée).
 */
export class CalculMemorise<T> {
  private readonly log = new Logger(CalculMemorise.name);
  private valeur: { donnees: T; le: number; signature: string } | null = null;
  private enCours: Promise<{ donnees: T; le: number }> | null = null;
  private derniereVerification = 0;

  constructor(
    private readonly ds: DataSource,
    /** Les tables lues par le calcul : une écriture dans l'une d'elles le rend périmé. */
    private readonly tables: string[],
    private readonly calculer: () => Promise<T>,
    private readonly nom: string,
    /** Délai minimum entre deux vérifications des données (millisecondes). */
    private readonly intervalle = 10_000,
  ) {}

  /** Une empreinte des écritures sur les tables lues (change dès qu'une ligne change). */
  private async signature(): Promise<string> {
    try {
      const [r] = await this.ds.query<{ s: string | null }[]>(
        `SELECT string_agg(relname || ':' || (n_tup_ins + n_tup_upd + n_tup_del), ',' ORDER BY relname) AS s
           FROM pg_stat_user_tables WHERE relname = ANY($1)`,
        [this.tables],
      );
      if (r?.s) return r.s;
    } catch {
      // Statistiques indisponibles : on retombe sur une durée de vie de deux minutes
    }
    return `temps:${Math.floor(Date.now() / 120_000)}`;
  }

  private lancer() {
    if (this.enCours) return this.enCours;
    const debut = Date.now();
    this.enCours = (async () => {
      try {
        const signature = await this.signature();
        const donnees = await this.calculer();
        this.valeur = { donnees, le: Date.now(), signature };
        this.log.log(`${this.nom} : calculé en ${Date.now() - debut} ms`);
        return { donnees, le: this.valeur.le };
      } finally {
        this.enCours = null;
      }
    })();
    return this.enCours;
  }

  /** Le résultat, et s'il est à jour (sinon : une mise à jour est en cours en arrière-plan). */
  async lire(): Promise<{ donnees: T; le: number; aJour: boolean }> {
    if (!this.valeur) return { ...(await this.lancer()), aJour: true };
    if (
      !this.enCours &&
      Date.now() - this.derniereVerification > this.intervalle
    ) {
      this.derniereVerification = Date.now();
      if ((await this.signature()) !== this.valeur.signature)
        void this.lancer().catch((e: Error) =>
          this.log.error(`${this.nom} : ${e.message}`),
        );
    }
    return {
      donnees: this.valeur.donnees,
      le: this.valeur.le,
      aJour: !this.enCours,
    };
  }

  /** Après une décision prise sur la page : le prochain appel attend le nouveau calcul. */
  oublier() {
    this.valeur = null;
  }

  /** Préparer le calcul en arrière-plan (démarrage du serveur). */
  prechauffer(delai = 20_000) {
    if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) return;
    setTimeout(() => {
      if (!this.valeur)
        void this.lancer().catch((e: Error) =>
          this.log.warn(`${this.nom} : préparation impossible (${e.message})`),
        );
    }, delai).unref();
  }
}
