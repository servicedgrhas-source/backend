import {
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { In, Repository } from 'typeorm';
import { codeValide } from '../common/code-personnel';
import { JournalService } from '../core/core.service';
import { Utilisateur } from '../entities';
import type { UtilisateurConnecte } from './auth';

/** Ce que porte le jeton : le compte et la version de ses sessions, rien d'autre. */
interface ContenuJeton {
  id: string;
  /** Version des sessions du compte au moment de la connexion (absent : 0). */
  v?: number;
}

/* -------- Règles de connexion (une seule source pour les messages et les contrôles) -------- */

/** Essais ratés tolérés pour un compte, sur la fenêtre ci-dessous. */
export const ESSAIS_MAX = 10;
/** Fenêtre de comptage des échecs et durée du blocage. */
export const BLOCAGE_MS = 15 * 60_000;
/** Échecs tolérés depuis une même adresse IP (tous comptes confondus), sur la même fenêtre. */
export const ESSAIS_MAX_IP = 60;

const IDENTIFIANTS_INCORRECTS =
  'E-mail, mot de passe ou code personnel incorrect.';

/** Hachage factice : un e-mail inconnu prend le même temps qu'un e-mail existant. */
const HACHAGE_FACTICE = bcrypt.hashSync('compte-inexistant', 10);

/**
 * Compteur d'échecs en mémoire, sur une fenêtre glissante, avec blocage.
 * Sert pour les adresses IP et pour les e-mails inconnus (qui doivent se comporter
 * exactement comme les vrais comptes, sans quoi le blocage révélerait qui existe).
 */
class CompteurEchecs {
  private readonly m = new Map<
    string,
    { n: number; dernier: number; jusqua: number }
  >();

  constructor(
    private readonly max: number,
    private readonly fenetre: number,
  ) {}

  /** Millisecondes de blocage restantes (0 : libre). */
  bloque(cle: string): number {
    const e = this.m.get(cle);
    return e ? Math.max(0, e.jusqua - Date.now()) : 0;
  }

  /** Enregistre un échec ; retourne le nombre d'échecs dans la fenêtre et le blocage éventuel. */
  echec(cle: string): { n: number; bloqueMs: number } {
    const maintenant = Date.now();
    this.nettoyer(maintenant);
    const e = this.m.get(cle);
    const n = e && maintenant - e.dernier < this.fenetre ? e.n + 1 : 1;
    const bloque = n >= this.max;
    this.m.set(cle, {
      n: bloque ? 0 : n,
      dernier: maintenant,
      jusqua: bloque ? maintenant + this.fenetre : 0,
    });
    return { n, bloqueMs: bloque ? this.fenetre : 0 };
  }

  effacer(cle: string) {
    this.m.delete(cle);
  }

  /** Les entrées périmées sont retirées (la mémoire ne grossit pas sous une attaque). */
  private nettoyer(maintenant: number) {
    if (this.m.size < 5_000) return;
    for (const [k, e] of this.m)
      if (maintenant - e.dernier > this.fenetre && e.jusqua < maintenant)
        this.m.delete(k);
  }
}

const minutes = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));

function tropDEssais(ms: number): HttpException {
  return new HttpException(
    `Trop d’essais de connexion : réessayez dans ${minutes(ms)} minute(s).`,
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

@Injectable()
export class SessionService {
  private readonly parIp = new CompteurEchecs(ESSAIS_MAX_IP, BLOCAGE_MS);
  private readonly inconnus = new CompteurEchecs(ESSAIS_MAX, BLOCAGE_MS);

  constructor(
    @InjectRepository(Utilisateur)
    private readonly users: Repository<Utilisateur>,
    private readonly jwt: JwtService,
    private readonly journal: JournalService,
  ) {}

  /* ------------------------------ Jetons ------------------------------ */

  /** Jeton pour ce compte, à sa version de session actuelle. */
  async jetonPour(id: string): Promise<string> {
    const u = await this.users
      .createQueryBuilder('u')
      .select(['u.id', 'u.versionSession'])
      .where('u.id = :id', { id })
      .getOne();
    if (!u) throw new UnauthorizedException('Compte introuvable');
    return this.jwt.signAsync({
      id: u.id,
      v: u.versionSession,
    } satisfies ContenuJeton);
  }

  /**
   * Profil du titulaire du jeton, relu en base à chaque requête : un compte désactivé,
   * un rôle changé ou des sessions fermées prennent effet tout de suite.
   */
  async profilDuJeton(jeton: string): Promise<UtilisateurConnecte> {
    let contenu: ContenuJeton;
    try {
      contenu = await this.jwt.verifyAsync<ContenuJeton>(jeton);
    } catch {
      throw new UnauthorizedException('Session expirée, reconnectez-vous.');
    }
    if (typeof contenu?.id !== 'string')
      throw new UnauthorizedException('Session invalide, reconnectez-vous.');
    const u = await this.users
      .createQueryBuilder('u')
      .select([
        'u.id',
        'u.email',
        'u.nom',
        'u.initiales',
        'u.role',
        'u.departementId',
        'u.structureId',
        'u.actif',
        'u.codeCreeLe',
        'u.versionSession',
      ])
      .where('u.id = :id', { id: contenu.id })
      .getOne();
    if (!u || !u.actif)
      throw new UnauthorizedException(
        'Ce compte est désactivé ou n’existe plus.',
      );
    if ((contenu.v ?? 0) !== u.versionSession)
      throw new UnauthorizedException(
        'Votre session a été fermée (mot de passe ou code changé, ou déconnexion demandée). Reconnectez-vous.',
      );
    return {
      id: u.id,
      email: u.email,
      nom: u.nom,
      initiales: u.initiales,
      role: u.role,
      departementId: u.departementId,
      structureId: u.structureId,
      aCode: !!u.codeCreeLe,
    };
  }

  /** Ferme toutes les sessions ouvertes de ces comptes (les jetons déjà donnés ne valent plus). */
  async fermerSessions(ids: string[]) {
    if (!ids.length) return;
    await this.users.increment({ id: In(ids) }, 'versionSession', 1);
  }

  /** Lève le blocage d'un compte (trop d'essais ratés). */
  async debloquer(id: string) {
    await this.users.update(id, {
      echecsConnexion: 0,
      dernierEchec: null,
      bloqueJusqua: null,
    });
  }

  /* ----------------------------- Connexion ---------------------------- */

  /**
   * Connexion par e-mail, mot de passe et code personnel (si le compte en a un).
   *
   * - Même réponse et même durée qu'un compte existe ou non (pas de liste des e-mails).
   * - 10 échecs en 15 minutes : le compte est bloqué 15 minutes, même avec le bon mot de passe.
   * - 60 échecs en 15 minutes depuis une même adresse : elle est bloquée 15 minutes.
   * - Chaque refus et chaque blocage vont au journal (jamais le mot de passe ni le code).
   */
  async connexion(
    saisie: { email: string; motDePasse: string; code?: string },
    ip: string,
  ): Promise<{ jeton: string; utilisateur: UtilisateurConnecte }> {
    const email = saisie.email.trim().toLowerCase();
    const ipBloquee = this.parIp.bloque(ip);
    if (ipBloquee) throw tropDEssais(ipBloquee);

    const u = await this.users
      .createQueryBuilder('u')
      .addSelect(['u.motDePasseHash', 'u.codeChiffre'])
      .where('lower(u.email) = :e', { e: email })
      .getOne();

    // Compte bloqué : on ne regarde même pas le mot de passe
    const bloqueMs = u
      ? Math.max(0, (u.bloqueJusqua?.getTime() ?? 0) - Date.now())
      : this.inconnus.bloque(email);
    if (bloqueMs) throw tropDEssais(bloqueMs);

    // Toujours un calcul bcrypt, et le code vérifié en même temps que le mot de passe
    const motOk = await bcrypt.compare(
      saisie.motDePasse,
      u?.motDePasseHash ?? HACHAGE_FACTICE,
    );
    const codeOk = !u?.codeChiffre || codeValide(saisie.code, u.codeChiffre);

    if (!u || !u.actif || !motOk || !codeOk) {
      const motif = !u
        ? 'compte inconnu'
        : !motOk
          ? 'mot de passe'
          : !codeOk
            ? 'code personnel'
            : 'compte désactivé';
      return this.refuser(u, email, ip, motif);
    }

    if (u.bloqueJusqua) await this.debloquer(u.id);
    else
      await this.users.update(u.id, { echecsConnexion: 0, dernierEchec: null });
    const jeton = await this.jetonPour(u.id);
    const utilisateur: UtilisateurConnecte = {
      id: u.id,
      email: u.email,
      nom: u.nom,
      initiales: u.initiales,
      role: u.role,
      departementId: u.departementId,
      structureId: u.structureId,
      aCode: !!u.codeCreeLe,
    };
    await this.journal.log(utilisateur, 'CONNEXION', 'utilisateur', u.id, {
      ip,
    });
    return { jeton, utilisateur };
  }

  /** Compte l'échec (compte et adresse), le journalise, bloque au 10ᵉ, puis refuse. */
  private async refuser(
    u: Utilisateur | null,
    email: string,
    ip: string,
    motif: string,
  ): Promise<never> {
    this.parIp.echec(ip);
    let n: number;
    let bloque: boolean;
    if (u) {
      // Incrément atomique : deux essais simultanés comptent bien pour deux
      const r: unknown = await this.users.query(
        `UPDATE utilisateur
            SET "echecsConnexion" = CASE
                  WHEN "dernierEchec" IS NULL OR "dernierEchec" < now() - ($2 || ' milliseconds')::interval
                  THEN 1 ELSE "echecsConnexion" + 1 END,
                "dernierEchec" = now()
          WHERE id = $1
      RETURNING "echecsConnexion" AS n`,
        [u.id, String(BLOCAGE_MS)],
      );
      const lignes = (Array.isArray(r) && Array.isArray(r[0]) ? r[0] : r) as {
        n: number;
      }[];
      n = Number(lignes[0]?.n ?? 1);
      bloque = n >= ESSAIS_MAX;
      if (bloque)
        await this.users.update(u.id, {
          echecsConnexion: 0,
          dernierEchec: null,
          bloqueJusqua: new Date(Date.now() + BLOCAGE_MS),
        });
    } else {
      const r = this.inconnus.echec(email);
      n = r.n;
      bloque = r.bloqueMs > 0;
    }

    const qui = u ? ({ id: u.id, nom: u.nom } as UtilisateurConnecte) : null;
    await this.journal.log(qui, 'CONNEXION_REFUSEE', 'utilisateur', u?.id, {
      email,
      ip,
      motif,
      essai: n,
    });
    if (bloque) {
      await this.journal.log(qui, 'CONNEXION_BLOQUEE', 'utilisateur', u?.id, {
        email,
        ip,
        minutes: minutes(BLOCAGE_MS),
      });
      throw tropDEssais(BLOCAGE_MS);
    }
    const restants = ESSAIS_MAX - n;
    throw new UnauthorizedException(
      restants <= 3
        ? `${IDENTIFIANTS_INCORRECTS} Encore ${restants} essai(s) avant un blocage de ${minutes(BLOCAGE_MS)} minutes.`
        : IDENTIFIANTS_INCORRECTS,
    );
  }
}
