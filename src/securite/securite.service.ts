import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { IsNull, Not, Repository } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { JournalService, ParametresService } from '../core/core.service';
import { EvenementSecurite, Utilisateur } from '../entities';
import {
  classer,
  type Classe,
  type CodeRegle,
  estPiege,
  etatVide,
  type EtatCompte,
  type Gain,
  observerAppel,
  observerReponse,
  parametresImpossibles,
  REGLES,
  regleNavigateur,
  scoreDecru,
} from './regles';

/** Message affiché au compte suspendu (à l'écran, et à chaque requête refusée). */
export const MESSAGE_COMPTE_SIGNALE =
  'Votre compte a été signalé par nos outils de détection. Veuillez patienter pendant qu’un humain vérifie votre compte.';

export const compteSignale = () =>
  new ForbiddenException({
    statusCode: 403,
    code: 'COMPTE_SIGNALE',
    message: MESSAGE_COMPTE_SIGNALE,
  });

/** La requête en cours (pour les contrôles faits plus loin, comme celui des champs inconnus). */
export const requeteEnCours = new AsyncLocalStorage<{ req: Request }>();

/** Plafond de points par heure pour les règles comptées à chaque appel. */
const PLAFONDS: Partial<Record<CodeRegle, number>> = {
  A3_HORS_INTERFACE: 40,
  A6_REFUS: 50,
};

interface Compte extends EtatCompte {
  score: number;
  maj: number;
  palier: number;
  plafonds: Map<string, { heure: number; points: number }>;
  /** Dernières requêtes, gardées pour le DG quand le compte est surveillé. */
  recentes: { t: number; m: string; chemin: string }[];
}

/** Contexte discret ajouté par l'interface à chaque appel (page, activité, onglet visible). */
const ENTETE_CONTEXTE = 'x-app-state';

@Injectable()
export class SecuriteService {
  private readonly log = new Logger('Sécurité');
  private readonly comptes = new Map<string, Compte>();
  /** Comptes suspendus pendant ce démarrage (évite de relire la base à chaque refus). */
  private readonly origines: (o: string) => boolean;

  constructor(
    @InjectRepository(EvenementSecurite)
    private readonly evenements: Repository<EvenementSecurite>,
    @InjectRepository(Utilisateur)
    private readonly users: Repository<Utilisateur>,
    private readonly params: ParametresService,
    private readonly journal: JournalService,
  ) {
    const permises = (process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000')
      .split(',')
      .map((o) => o.trim().replace(/\/+$/, ''))
      .filter(Boolean)
      .map((o) =>
        o.includes('*')
          ? new RegExp(
              `^${o.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]+')}$`,
            )
          : o,
      );
    this.origines = (o) =>
      permises.some((p) => (typeof p === 'string' ? p === o : p.test(o)));
  }

  /* ------------------------------ Réglages ------------------------------ */

  reglages() {
    const n = (cle: string, d: number) => Number(this.params.get(cle)) || d;
    return {
      mode:
        this.params.get('SECURITE_MODE') === 'ACTIF' ? 'ACTIF' : 'OBSERVATION',
      surveillance: n('SECURITE_SEUIL_SURVEILLANCE', 40),
      alerte: n('SECURITE_SEUIL_ALERTE', 70),
      suspension: n('SECURITE_SEUIL_SUSPENSION', 100),
      demiVie: n('SECURITE_DEMI_VIE', 30),
    };
  }

  /* ------------------------------ État d'un compte ------------------------------ */

  private compte(id: string, t = Date.now()): Compte {
    let c = this.comptes.get(id);
    if (!c) {
      c = {
        ...etatVide(t),
        score: 0,
        maj: t,
        palier: 0,
        plafonds: new Map(),
        recentes: [],
      };
      this.comptes.set(id, c);
    }
    c.score = scoreDecru(c.score, t - c.maj, this.reglages().demiVie);
    c.maj = t;
    if (c.score < 1) c.score = 0;
    // Redescendu sous un palier : il pourra de nouveau être franchi (et signalé)
    const r = this.reglages();
    if (c.score < r.surveillance) c.palier = 0;
    else if (c.score < r.alerte && c.palier > r.surveillance)
      c.palier = r.surveillance;
    return c;
  }

  /** Score actuel d'un compte (pour la page du DG). */
  scoreDe(id: string) {
    return this.comptes.has(id) ? Math.round(this.compte(id).score) : 0;
  }

  /* ------------------------------ Observation ------------------------------ */

  private contexte(req: Request) {
    const brut = req.headers[ENTETE_CONTEXTE];
    if (typeof brut !== 'string' || !brut) return null;
    try {
      const o = JSON.parse(Buffer.from(brut, 'base64').toString('utf8')) as {
        p?: unknown;
        i?: unknown;
        v?: unknown;
      };
      return {
        page: typeof o.p === 'string' ? o.p.slice(0, 200) : '',
        interactions: Number(o.i) || 0,
        visible: o.v !== 0 && o.v !== false,
      };
    } catch {
      return null;
    }
  }

  private session(req: Request) {
    const a = req.headers.authorization ?? '';
    return createHash('sha256').update(a).digest('hex').slice(0, 16);
  }

  /**
   * Avant le traitement d'une requête authentifiée : règles du navigateur, de l'interface et du
   * comportement. Retourne vrai si le compte doit être suspendu maintenant.
   */
  async avant(
    req: Request,
    u: UtilisateurConnecte,
    autorises: Set<string> | null,
  ): Promise<boolean> {
    const t = Date.now();
    const classe = classer(req.path, req.method);
    (
      req as Request & { securite?: { u: UtilisateurConnecte; classe: Classe } }
    ).securite = { u, classe };
    const c = this.compte(u.id, t);
    c.recentes.push({ t, m: req.method, chemin: classe.chemin });
    if (c.recentes.length > 100) c.recentes.shift();
    const gains: Gain[] = [
      ...regleNavigateur(
        {
          origin: req.headers.origin,
          secFetchSite: req.headers['sec-fetch-site'],
          userAgent: req.headers['user-agent'],
        },
        this.origines,
      ).filter(
        (g) => g.regle !== 'A2_OUTIL' || this.unePar(c, 'A2', 3_600_000, t),
      ),
      ...observerAppel(c, {
        t,
        classe,
        query: req.query,
        ip: req.ip ?? '',
        ua: req.headers['user-agent'] ?? '',
        session: this.session(req),
        contexte: this.contexte(req),
      }),
    ];
    const fautes = parametresImpossibles(req.query, autorises);
    if (fautes.length)
      gains.push({ regle: 'A5_PARAMETRES', details: { fautes } });
    return this.appliquer(u, c, gains, req, t);
  }

  /** Après la réponse : refus en série, fiches inexistantes en série. */
  async apres(req: Request, statut: number) {
    const s = (
      req as Request & { securite?: { u: UtilisateurConnecte; classe: Classe } }
    ).securite;
    if (!s) return;
    const t = Date.now();
    const c = this.compte(s.u.id, t);
    const gains = observerReponse(c, t, s.classe, statut);
    if (gains.length) await this.appliquer(s.u, c, gains, req, t);
  }

  /** Champs inconnus dans le corps d'une requête (signalés par la validation). */
  async champsInconnus(champs: string[]) {
    const req = requeteEnCours.getStore()?.req;
    const s = (
      req as (Request & { securite?: { u: UtilisateurConnecte } }) | undefined
    )?.securite;
    if (!req || !s || !champs.length) return;
    const t = Date.now();
    await this.appliquer(
      s.u,
      this.compte(s.u.id, t),
      [{ regle: 'A5_PARAMETRES', details: { champsInconnus: champs } }],
      req,
      t,
    );
  }

  /**
   * Adresse qui n'existe pas (réponse « introuvable » d'une route inconnue), appelée avec une
   * session : tâtonnement, ou adresse piège.
   */
  async adresseInconnue(req: Request, u: UtilisateurConnecte) {
    const t = Date.now();
    const c = this.compte(u.id, t);
    const regle: CodeRegle = estPiege(req.path)
      ? 'B1_PIEGE'
      : 'A4_ADRESSE_INCONNUE';
    await this.appliquer(
      u,
      c,
      [{ regle, details: { adresse: req.path.slice(0, 200) } }],
      req,
      t,
    );
  }

  /** Connexion réussie après plusieurs essais ratés. */
  async connexionApresEchecs(
    u: UtilisateurConnecte,
    echecs: number,
    ip: string,
  ) {
    const t = Date.now();
    await this.appliquer(
      u,
      this.compte(u.id, t),
      [{ regle: 'E3_ECHECS', details: { echecs } }],
      { ip, headers: {} } as Request,
      t,
    );
  }

  private unePar(c: Compte, cle: string, periode: number, t: number) {
    const d = c.donnees.get(cle);
    if (d !== undefined && t - d < periode) return false;
    c.donnees.set(cle, t);
    return true;
  }

  /* ------------------------------ Score, paliers, suspension ------------------------------ */

  private async appliquer(
    u: UtilisateurConnecte,
    c: Compte,
    gains: Gain[],
    req: Request,
    t: number,
  ): Promise<boolean> {
    if (!gains.length) return false;
    const r = this.reglages();
    let immediate = false;
    for (const g of gains) {
      const def = REGLES[g.regle];
      let points = def.points;
      const plafond = PLAFONDS[g.regle];
      if (plafond) {
        const heure = Math.floor(t / 3_600_000);
        const p = c.plafonds.get(g.regle);
        const deja = p && p.heure === heure ? p.points : 0;
        points = Math.max(0, Math.min(points, plafond - deja));
        c.plafonds.set(g.regle, { heure, points: deja + points });
        if (!points) continue;
      }
      if ('immediate' in def && def.immediate) immediate = true;
      c.score += points;
      await this.noter(
        u.id,
        g.regle,
        points,
        Math.round(c.score),
        req,
        g.details,
      );
    }
    const score = Math.round(c.score);
    // Paliers : surveillance, puis alerte (le DG et l'administrateur sont prévenus)
    if (score >= r.alerte && c.palier < r.alerte) {
      c.palier = r.alerte;
      await this.noter(u.id, 'ALERTE', 0, score, req, {
        recentes: c.recentes.slice(-30),
      });
      await this.journal.log(u, 'SECURITE_ALERTE', 'utilisateur', u.id, {
        score,
      });
    } else if (score >= r.surveillance && c.palier < r.surveillance) {
      c.palier = r.surveillance;
      await this.noter(u.id, 'SURVEILLANCE', 0, score, req);
    }
    const suspendre =
      immediate || (score >= r.suspension && r.mode === 'ACTIF');
    if (
      !suspendre &&
      score >= r.suspension &&
      this.unePar(c, 'SIMULEE', 3_600_000, t)
    )
      // Mode observation : ce qui se serait passé, pour régler les seuils
      await this.noter(u.id, 'SUSPENSION_SIMULEE', 0, score, req, {
        recentes: c.recentes.slice(-30),
      });
    if (suspendre) await this.suspendre(u, c, req, gains);
    return suspendre;
  }

  private async noter(
    utilisateurId: string,
    regle: string,
    points: number,
    score: number,
    req: Request,
    details?: Record<string, unknown>,
  ) {
    try {
      await this.evenements.insert({
        utilisateurId,
        regle,
        points,
        score,
        chemin: req.path
          ? `${req.method ?? ''} ${req.path}`.slice(0, 250)
          : null,
        ip: req.ip ?? null,
        navigateur: (req.headers?.['user-agent'] ?? '').slice(0, 250) || null,
        details: (details ?? null) as never,
      });
    } catch (e) {
      this.log.error(`Journal de sécurité : ${(e as Error).message}`);
    }
  }

  private async suspendre(
    u: UtilisateurConnecte,
    c: Compte,
    req: Request,
    gains: Gain[],
  ) {
    const motif = gains.map((g) => REGLES[g.regle].libelle).join(' ; ');
    await this.users.update(
      { id: u.id, suspenduLe: IsNull() },
      { suspenduLe: new Date(), suspensionMotif: motif },
    );
    await this.noter(u.id, 'SUSPENSION', 0, Math.round(c.score), req, {
      motif,
      recentes: c.recentes.slice(-50),
    });
    await this.journal.log(u, 'SECURITE_SUSPENSION', 'utilisateur', u.id, {
      motif,
    });
  }

  /* ------------------------------ Pour le DG et l'administrateur ------------------------------ */

  /** Comptes signalés : suspendus, ou avec des événements depuis 7 jours. */
  async comptesSignales() {
    const lignes = await this.evenements.query<
      {
        utilisateurId: string;
        evenements: number;
        dernier: Date;
        scoreMax: number;
        regles: string[];
      }[]
    >(
      `SELECT "utilisateurId", count(*)::int AS evenements, max("creeLe") AS dernier, max(score)::int AS "scoreMax",
              array_agg(DISTINCT regle) AS regles
         FROM evenement_securite WHERE "creeLe" > now() - interval '7 days' GROUP BY 1`,
    );
    const suspendus = await this.users.find({
      where: { suspenduLe: Not(IsNull()) },
    });
    const ids = [
      ...new Set([
        ...lignes.map((l) => l.utilisateurId),
        ...suspendus.map((s) => s.id),
      ]),
    ];
    const users = ids.length
      ? await this.users
          .createQueryBuilder('u')
          .addSelect('u.suspensionMotif')
          .where('u.id IN (:...ids)', { ids })
          .getMany()
      : [];
    return users
      .map((x) => {
        const l = lignes.find((y) => y.utilisateurId === x.id);
        return {
          id: x.id,
          nom: x.nom,
          email: x.email,
          role: x.role,
          actif: x.actif,
          score: this.scoreDe(x.id),
          scoreMax: l?.scoreMax ?? 0,
          evenements: l?.evenements ?? 0,
          dernier: l?.dernier ?? null,
          regles: (l?.regles ?? []).filter((g) => g in REGLES),
          suspenduLe: x.suspenduLe,
          suspensionMotif: x.suspensionMotif ?? null,
        };
      })
      .sort(
        (a, b) =>
          Number(!!b.suspenduLe) - Number(!!a.suspenduLe) ||
          b.scoreMax - a.scoreMax,
      );
  }

  /** Nombre de comptes à vérifier (suspendus) : pour le compteur du menu. */
  async aVerifier() {
    return this.users.count({ where: { suspenduLe: Not(IsNull()) } });
  }

  async evenementsDe(id: string) {
    return this.evenements.find({
      where: { utilisateurId: id },
      order: { creeLe: 'DESC' },
      take: 300,
    });
  }

  /** Rétablir un compte après vérification humaine : score remis à zéro. */
  async retablir(moi: UtilisateurConnecte, id: string, motif: string) {
    await this.users.update(id, { suspenduLe: null, suspensionMotif: null });
    this.comptes.delete(id);
    await this.evenements.insert({
      utilisateurId: id,
      regle: 'RETABLI',
      points: 0,
      score: 0,
      details: { par: moi.nom, motif },
    });
    await this.journal.log(moi, 'SECURITE_RETABLISSEMENT', 'utilisateur', id, {
      motif,
    });
  }

  /** Suspendre un compte à la main (vérification en cours). */
  async suspendreManuellement(
    moi: UtilisateurConnecte,
    id: string,
    motif: string,
  ) {
    await this.users.update(id, {
      suspenduLe: new Date(),
      suspensionMotif: `Suspendu par ${moi.nom} : ${motif}`,
    });
    await this.evenements.insert({
      utilisateurId: id,
      regle: 'SUSPENSION',
      points: 0,
      score: this.scoreDe(id),
      details: { par: moi.nom, motif },
    });
    await this.journal.log(moi, 'SECURITE_SUSPENSION', 'utilisateur', id, {
      motif,
      manuelle: true,
    });
  }

  libelles() {
    return Object.fromEntries(
      Object.entries(REGLES).map(([k, v]) => [
        k,
        {
          libelle: v.libelle,
          points: v.points,
          immediate: 'immediate' in v && !!v.immediate,
        },
      ]),
    );
  }
}
