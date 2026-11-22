import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { randomInt } from 'crypto';
import { DataSource } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { SessionService } from '../auth/session.service';
import { JournalService } from '../core/core.service';

/**
 * Recenseurs de la mission de terrain (DG, 22/11/2026). On les planifie à l'avance : un compte par
 * personne, avec un identifiant RG-<numéro>-<initiales du département> (RG-001-CO, RG-037-BZ), les
 * départements où il est envoyé et les dates de la mission. Il se connecte avec cet identifiant
 * et un mot de passe simple, et ne voit que le formulaire du recensement.
 *
 * Un recenseur mis dans plusieurs départements est permis, mais signalé en rouge.
 */

/** Initiales des départements dans l'identifiant (à changer ici si la DGRHAS en préfère d'autres). */
export const INITIALES_DEPARTEMENT: Record<string, string> = {
  BOUENZA: 'BO',
  BRAZZAVILLE: 'BZ',
  CONGO_OUBANGUI: 'OU',
  CUVETTE: 'CU',
  CUVETTE_OUEST: 'CO',
  DJOUE_LEFINI: 'DL',
  KOUILOU: 'KL',
  LEKOUMOU: 'LK',
  LIKOUALA: 'LI',
  NIARI: 'NI',
  NKENI_ALIMA: 'NA',
  PLATEAUX: 'PL',
  POINTE_NOIRE: 'PN',
  POOL: 'PO',
  SANGHA: 'SA',
};

/** Jours laissés après la fin de la mission pour envoyer le reste ; ensuite l'appareil efface tout. */
export const JOURS_APRES_MISSION = 2;

const FORME_CODE = /^RG-\d{3,4}-[A-Z]{2,3}$/;

/** Un mot de passe facile à dicter et à taper sur une tablette : « kato-4821 ». */
function motDePasseSimple() {
  const c = 'bdfgklmnprstvz';
  const v = 'aeiou';
  let m = '';
  for (let i = 0; i < 2; i++)
    m += c[randomInt(c.length)] + v[randomInt(v.length)];
  return `${m}-${String(randomInt(10000)).padStart(4, '0')}`;
}

const plus = (jour: string, n: number) => {
  const d = new Date(`${jour}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export interface SaisieRecenseurs {
  /** Un nom par recenseur (une ligne par personne). */
  noms: string[];
  departements: number[];
  debut?: string | null;
  fin?: string | null;
}

/** Numéros de téléphone : chiffres, espaces, « + » ; 5 au plus, sans doublon. */
export function telephonesPropres(l: unknown): string[] {
  const liste = (Array.isArray(l) ? l : [])
    .map((t) =>
      String(t ?? '')
        .replace(/[^\d+ ]/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((t) => t.replace(/\D/g, '').length >= 6);
  const vus = new Set<string>();
  const r = liste.filter((t) => {
    const k = t.replace(/\D/g, '');
    if (vus.has(k)) return false;
    vus.add(k);
    return true;
  });
  if (r.length > 5) throw new BadRequestException('Cinq numéros au plus.');
  return r;
}

@Injectable()
export class RecenseursService {
  constructor(
    private readonly ds: DataSource,
    private readonly sessions: SessionService,
    private readonly journal: JournalService,
  ) {}

  private async departements() {
    return this.ds.query<{ id: number; code: string; nom: string }[]>(
      `SELECT id, code, nom FROM departement ORDER BY ordre`,
    );
  }

  private verifierDates(debut?: string | null, fin?: string | null) {
    const jour = /^\d{4}-\d{2}-\d{2}$/;
    if (debut && !jour.test(debut))
      throw new BadRequestException('Date de début invalide.');
    if (fin && !jour.test(fin))
      throw new BadRequestException('Date de fin invalide.');
    if (debut && fin && fin < debut)
      throw new BadRequestException(
        'La fin de la mission est avant son début.',
      );
  }

  private async verifierDepartements(ids: number[]) {
    const tous = await this.departements();
    const liste = [...new Set((ids ?? []).map(Number))];
    if (!liste.length)
      throw new BadRequestException(
        'Choisissez au moins un département pour la mission.',
      );
    for (const id of liste)
      if (!tous.some((d) => d.id === id))
        throw new BadRequestException('Département inconnu.');
    return { liste, tous };
  }

  /** Tous les recenseurs, avec ce qu'il faut voir d'un coup d'œil (plusieurs départements en rouge). */
  async liste() {
    const deps = await this.departements();
    const lignes = await this.ds.query<
      {
        id: string;
        code: string;
        nom: string;
        actif: boolean;
        departements: number[];
        telephones: string[];
        debut: string | null;
        fin: string | null;
        effacerLe: string | null;
        effaceLe: string | null;
        bloqueLe: string | null;
        bloquePar: string | null;
        derniereConnexion: string | null;
        envois: number;
        lignesEnvoyees: number;
      }[]
    >(
      `SELECT u.id, r.code, u.nom, u.actif, r.departements, r.telephones, r."bloqueLe", r."bloquePar",
              to_char(r.debut, 'YYYY-MM-DD') AS debut, to_char(r.fin, 'YYYY-MM-DD') AS fin,
              r."campagneId", (SELECT c.nom FROM campagne_recensement c WHERE c.id = r."campagneId") AS campagne,
              r."effacerLe", r."effaceLe",
              (SELECT max(j.date) FROM journal j WHERE j."utilisateurId" = u.id AND j.action = 'CONNEXION') AS "derniereConnexion",
              (SELECT count(*)::int FROM journal j WHERE j."utilisateurId" = u.id AND j.action = 'RECENSEMENT_TERRAIN') AS envois,
              (SELECT coalesce(sum((j.details->>'faites')::int), 0)::int FROM journal j WHERE j."utilisateurId" = u.id AND j.action = 'RECENSEMENT_TERRAIN') AS "lignesEnvoyees"
         FROM recenseur r JOIN utilisateur u ON u.id = r."utilisateurId"
        ORDER BY r.code`,
    );
    const nomDep = new Map(deps.map((d) => [d.id, d.nom]));
    return {
      departements: deps.map((d) => ({
        id: d.id,
        nom: d.nom,
        initiales: INITIALES_DEPARTEMENT[d.code] ?? d.code.slice(0, 2),
      })),
      joursApresMission: JOURS_APRES_MISSION,
      recenseurs: lignes.map((l) => ({
        ...l,
        departementsNoms: l.departements.map((d) => nomDep.get(d) ?? '?'),
        plusieursDepartements: l.departements.length > 1,
      })),
    };
  }

  /** Le prochain numéro libre (RG-001, RG-002…), pour tous les départements. */
  private async prochainNumero() {
    const r = await this.ds.query<{ n: number | null }[]>(
      `SELECT max(substring(code from '^RG-(\\d+)-')::int) AS n FROM recenseur`,
    );
    return (r[0]?.n ?? 0) + 1;
  }

  /**
   * Planifier : un compte par nom, tous envoyés dans les mêmes départements et aux mêmes dates.
   * Les mots de passe ne sont montrés qu'ici (à remettre à chacun) ; on peut en refaire un.
   */
  async creer(moi: UtilisateurConnecte, s: SaisieRecenseurs) {
    const noms = (s.noms ?? [])
      .map((n) =>
        String(n ?? '')
          .trim()
          .replace(/\s+/g, ' '),
      )
      .filter((n) => n.length >= 2);
    if (!noms.length)
      throw new BadRequestException(
        'Écrivez le nom d’au moins un recenseur (un nom par ligne).',
      );
    if (noms.length > 300)
      throw new BadRequestException('300 recenseurs au plus d’un coup.');
    this.verifierDates(s.debut, s.fin);
    // Un recenseur travaille pour un recensement : il faut qu'un recensement soit ouvert
    const [campagne] = await this.ds.query<{ id: number }[]>(
      `SELECT id FROM campagne_recensement WHERE "clotureLe" IS NULL ORDER BY debut DESC, id DESC LIMIT 1`,
    );
    if (!campagne)
      throw new BadRequestException(
        'Aucun recensement ouvert : ouvrez d’abord le recensement (Base du personnel › Recensement › Recensements), puis créez ses recenseurs.',
      );
    const { liste, tous } = await this.verifierDepartements(s.departements);
    const premier = tous.find((d) => d.id === liste[0])!;
    const initiales =
      INITIALES_DEPARTEMENT[premier.code] ?? premier.code.slice(0, 2);
    const crees: {
      id: string;
      code: string;
      nom: string;
      motDePasse: string;
    }[] = [];
    await this.ds.transaction(async (m) => {
      let n = await this.prochainNumero();
      for (const nom of noms) {
        let code = '';
        // (un identifiant déjà pris comme adresse d'un autre compte : on passe au suivant)
        for (;;) {
          code = `RG-${String(n++).padStart(3, '0')}-${initiales}`;
          const pris = await m.query<unknown[]>(
            `SELECT 1 FROM utilisateur WHERE lower(email) = $1`,
            [code.toLowerCase()],
          );
          if (!pris.length) break;
        }
        const motDePasse = motDePasseSimple();
        const [u] = await m.query<{ id: string }[]>(
          `INSERT INTO utilisateur (email, nom, role, "departementId", "finAcces", actif, "motDePasseHash")
           VALUES ($1, $2, 'RECENSEUR', $3, $4, true, $5) RETURNING id`,
          [
            code.toLowerCase(),
            nom.toUpperCase(),
            liste[0],
            s.fin ? plus(s.fin, JOURS_APRES_MISSION) : null,
            await bcrypt.hash(motDePasse, 10),
          ],
        );
        await m.query(
          `INSERT INTO recenseur ("utilisateurId", code, departements, debut, fin, "creePar", "campagneId")
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            u.id,
            code,
            liste,
            s.debut || null,
            s.fin || null,
            moi.nom,
            campagne.id,
          ],
        );
        crees.push({ id: u.id, code, nom: nom.toUpperCase(), motDePasse });
      }
    });
    await this.journal.log(moi, 'RECENSEURS_CREES', 'recenseur', null, {
      nombre: crees.length,
      codes: crees.map((c) => c.code),
      departements: liste,
    });
    return { crees };
  }

  private async un(id: string) {
    const r = await this.ds.query<
      { code: string; departements: number[]; fin: string | null }[]
    >(
      `SELECT code, departements, to_char(fin, 'YYYY-MM-DD') AS fin FROM recenseur WHERE "utilisateurId" = $1`,
      [id],
    );
    if (!r[0]) throw new NotFoundException('Recenseur introuvable.');
    return r[0];
  }

  /** Changer le nom, les départements, les dates, le téléphone ou l'identifiant. */
  async modifier(
    moi: UtilisateurConnecte,
    id: string,
    s: {
      nom?: string;
      code?: string;
      departements?: number[];
      debut?: string | null;
      fin?: string | null;
      telephones?: string[];
    },
  ) {
    const avant = await this.un(id);
    this.verifierDates(s.debut, s.fin);
    if (s.departements !== undefined) {
      const { liste } = await this.verifierDepartements(s.departements);
      await this.ds.query(
        `UPDATE recenseur SET departements = $2 WHERE "utilisateurId" = $1`,
        [id, liste],
      );
      await this.ds.query(
        `UPDATE utilisateur SET "departementId" = $2 WHERE id = $1`,
        [id, liste[0]],
      );
    }
    if (s.code !== undefined && s.code.trim().toUpperCase() !== avant.code) {
      const code = s.code.trim().toUpperCase();
      if (!FORME_CODE.test(code))
        throw new BadRequestException(
          'Identifiant de la forme RG-001-BZ (RG, un numéro, les initiales du département).',
        );
      const pris = await this.ds.query<unknown[]>(
        `SELECT 1 FROM utilisateur WHERE lower(email) = $1 AND id <> $2`,
        [code.toLowerCase(), id],
      );
      if (pris.length)
        throw new BadRequestException(`L’identifiant ${code} est déjà pris.`);
      await this.ds.query(
        `UPDATE recenseur SET code = $2 WHERE "utilisateurId" = $1`,
        [id, code],
      );
      await this.ds.query(`UPDATE utilisateur SET email = $2 WHERE id = $1`, [
        id,
        code.toLowerCase(),
      ]);
    }
    if (s.nom !== undefined) {
      const nom = s.nom.trim().replace(/\s+/g, ' ').toUpperCase();
      if (nom.length < 2) throw new BadRequestException('Nom trop court.');
      await this.ds.query(`UPDATE utilisateur SET nom = $2 WHERE id = $1`, [
        id,
        nom,
      ]);
    }
    if (s.telephones !== undefined)
      await this.ds.query(
        `UPDATE recenseur SET telephones = $2 WHERE "utilisateurId" = $1`,
        [id, telephonesPropres(s.telephones)],
      );
    if (s.debut !== undefined)
      await this.ds.query(
        `UPDATE recenseur SET debut = $2 WHERE "utilisateurId" = $1`,
        [id, s.debut || null],
      );
    if (s.fin !== undefined) {
      await this.ds.query(
        `UPDATE recenseur SET fin = $2 WHERE "utilisateurId" = $1`,
        [id, s.fin || null],
      );
      await this.ds.query(
        `UPDATE utilisateur SET "finAcces" = $2 WHERE id = $1`,
        [id, s.fin ? plus(s.fin, JOURS_APRES_MISSION) : null],
      );
    }
    await this.journal.log(moi, 'RECENSEUR_MODIFIE', 'recenseur', id, {
      code: avant.code,
      ...s,
    });
    return { ok: true };
  }

  /** Un nouveau mot de passe (oublié, ou remis à quelqu'un d'autre) : les sessions ouvertes se ferment. */
  async nouveauMotDePasse(moi: UtilisateurConnecte, id: string) {
    const r = await this.un(id);
    const motDePasse = motDePasseSimple();
    await this.ds.query(
      `UPDATE utilisateur SET "motDePasseHash" = $2, "echecsConnexion" = 0, "bloqueJusqua" = NULL WHERE id = $1`,
      [id, await bcrypt.hash(motDePasse, 10)],
    );
    await this.sessions.fermerSessions([id]);
    await this.journal.log(moi, 'RECENSEUR_MOT_DE_PASSE', 'recenseur', id, {
      code: r.code,
    });
    return { code: r.code, motDePasse };
  }

  /**
   * Arrêter la mission de ce recenseur et effacer son appareil (perdu, volé, recenseur retiré) :
   * à sa prochaine connexion, l'appareil efface tout ce qu'il garde, puis le compte se ferme.
   */
  async effacer(moi: UtilisateurConnecte, id: string) {
    const r = await this.un(id);
    await this.ds.query(
      `UPDATE recenseur SET "effacerLe" = now(), "effaceLe" = NULL WHERE "utilisateurId" = $1`,
      [id],
    );
    await this.journal.log(
      moi,
      'RECENSEUR_EFFACEMENT_DEMANDE',
      'recenseur',
      id,
      {
        code: r.code,
      },
    );
    return { ok: true };
  }

  /**
   * Bloquer (DG, 22/11/2026) : le compte est suspendu tout de suite (sessions fermées), mais les
   * données restent sur sa tablette ; débloquer le rouvre. Pour tout effacer : « Effacer l'appareil ».
   */
  async bloquer(moi: UtilisateurConnecte, id: string) {
    const r = await this.un(id);
    await this.ds.query(
      `UPDATE recenseur SET "bloqueLe" = now(), "bloquePar" = $2 WHERE "utilisateurId" = $1`,
      [id, moi.nom],
    );
    await this.ds.query(`UPDATE utilisateur SET actif = false WHERE id = $1`, [
      id,
    ]);
    await this.sessions.fermerSessions([id]);
    await this.journal.log(moi, 'RECENSEUR_BLOQUE', 'recenseur', id, {
      code: r.code,
    });
    return { ok: true };
  }

  async debloquer(moi: UtilisateurConnecte, id: string) {
    const r = await this.un(id);
    await this.ds.query(
      `UPDATE recenseur SET "bloqueLe" = NULL, "bloquePar" = NULL WHERE "utilisateurId" = $1`,
      [id],
    );
    // (un appareil déjà effacé reste fermé : « Reprendre » le rouvre)
    await this.ds.query(
      `UPDATE utilisateur u SET actif = true FROM recenseur r
        WHERE u.id = $1 AND r."utilisateurId" = u.id AND r."effaceLe" IS NULL AND r."effacerLe" IS NULL`,
      [id],
    );
    await this.journal.log(moi, 'RECENSEUR_DEBLOQUE', 'recenseur', id, {
      code: r.code,
    });
    return { ok: true };
  }

  /** Reprendre la mission (effacement annulé, compte rouvert). */
  async reprendre(moi: UtilisateurConnecte, id: string) {
    const r = await this.un(id);
    await this.ds.query(
      `UPDATE recenseur SET "effacerLe" = NULL, "effaceLe" = NULL, "bloqueLe" = NULL, "bloquePar" = NULL WHERE "utilisateurId" = $1`,
      [id],
    );
    await this.ds.query(`UPDATE utilisateur SET actif = true WHERE id = $1`, [
      id,
    ]);
    await this.journal.log(moi, 'RECENSEUR_REPRIS', 'recenseur', id, {
      code: r.code,
    });
    return { ok: true };
  }

  /** Ce que l'appareil du recenseur doit savoir : ses départements, les dates, l'effacement prévu. */
  async mission(u: UtilisateurConnecte) {
    if (u.role !== 'RECENSEUR') return { recenseur: false as const };
    const r = await this.un(u.id);
    const deps = await this.departements();
    return {
      recenseur: true as const,
      code: r.code,
      nom: u.nom,
      departements: r.departements.map((id) => ({
        id,
        nom: deps.find((d) => d.id === id)?.nom ?? '?',
      })),
      fin: r.fin,
      // Le jour à Brazzaville (la date d'une tablette peut être fausse)
      aujourdhui: new Date().toLocaleDateString('en-CA', {
        timeZone: 'Africa/Brazzaville',
      }),
      // Le recensement pour lequel il travaille (affiché sur sa tablette)
      campagne:
        (
          await this.ds.query<{ nom: string }[]>(
            `SELECT c.nom FROM recenseur r JOIN campagne_recensement c ON c.id = r."campagneId" WHERE r."utilisateurId" = $1`,
            [u.id],
          )
        )[0]?.nom ?? null,
      // Le jour où l'appareil efface tout (le reste doit être envoyé avant)
      effacerApres: r.fin ? plus(r.fin, JOURS_APRES_MISSION) : null,
    };
  }

  /** L'appareil a tout effacé : on le note et le compte se ferme. */
  async accuseEfface(u: UtilisateurConnecte) {
    if (u.role !== 'RECENSEUR') return { ok: true };
    await this.ds.query(
      `UPDATE recenseur SET "effaceLe" = now() WHERE "utilisateurId" = $1`,
      [u.id],
    );
    await this.ds.query(`UPDATE utilisateur SET actif = false WHERE id = $1`, [
      u.id,
    ]);
    await this.journal.log(u, 'RECENSEUR_APPAREIL_EFFACE', 'recenseur', u.id);
    return { ok: true };
  }

  /**
   * Positions relevées par la tablette d'un recenseur (gardées sans réseau, envoyées par lots).
   * « COUPEE » : la tablette ne donne plus sa position (autorisation retirée, GPS éteint).
   */
  async recevoirPositions(
    u: UtilisateurConnecte,
    liste: {
      latitude?: unknown;
      longitude?: unknown;
      precision?: unknown;
      etat?: unknown;
      le?: unknown;
    }[],
  ) {
    if (u.role !== 'RECENSEUR') return { recues: 0 };
    const nombre = (v: unknown) => {
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const lignes = (Array.isArray(liste) ? liste : [])
      .slice(0, 1000)
      .map((p) => {
        const etat = ['OK', 'COUPEE', 'INDISPONIBLE'].includes(String(p.etat))
          ? String(p.etat)
          : 'OK';
        const lat = nombre(p.latitude);
        const lng = nombre(p.longitude);
        const le = new Date(
          typeof p.le === 'string' || typeof p.le === 'number' ? p.le : '',
        );
        return {
          etat,
          lat: lat !== null && lat >= -90 && lat <= 90 ? lat : null,
          lng: lng !== null && lng >= -180 && lng <= 180 ? lng : null,
          precision: nombre(p.precision),
          // Heure de la tablette : pas dans le futur, pas plus vieille qu'un mois
          le:
            Number.isNaN(le.getTime()) ||
            le.getTime() > Date.now() + 5 * 60_000 ||
            le.getTime() < Date.now() - 31 * 86_400_000
              ? new Date()
              : le,
        };
      })
      .filter((p) => p.etat !== 'OK' || (p.lat !== null && p.lng !== null));
    if (!lignes.length) return { recues: 0 };
    await this.ds.query(
      `INSERT INTO position_recenseur ("utilisateurId", latitude, longitude, precision, etat, le)
       SELECT $1, x.lat, x.lng, x.prec, x.etat, x.le
         FROM jsonb_to_recordset($2::jsonb) AS x(lat double precision, lng double precision, prec real, etat text, le timestamptz)`,
      [
        u.id,
        JSON.stringify(
          lignes.map((p) => ({
            lat: p.lat,
            lng: p.lng,
            prec: p.precision,
            etat: p.etat,
            le: p.le.toISOString(),
          })),
        ),
      ],
    );
    return { recues: lignes.length };
  }

  /**
   * Le suivi des recenseurs depuis Brazzaville (DG et administrateur) : dernière position de chacun,
   * position coupée ou trop ancienne, trajet du jour, envois du jour, téléphones.
   */
  async suivi(jour?: string) {
    const j = /^\d{4}-\d{2}-\d{2}$/.test(jour ?? '')
      ? jour!
      : new Date().toLocaleDateString('fr-CA', {
          timeZone: 'Africa/Brazzaville',
        });
    const { recenseurs } = await this.liste();
    const dernieres = await this.ds.query<
      {
        u: string;
        etat: string;
        le: string;
        latitude: number | null;
        longitude: number | null;
        precision: number | null;
      }[]
    >(
      `SELECT DISTINCT ON ("utilisateurId") "utilisateurId" AS u, etat, le, latitude, longitude, precision
         FROM position_recenseur ORDER BY "utilisateurId", le DESC`,
    );
    const dernieresOk = await this.ds.query<
      {
        u: string;
        le: string;
        latitude: number;
        longitude: number;
        precision: number | null;
      }[]
    >(
      `SELECT DISTINCT ON ("utilisateurId") "utilisateurId" AS u, le, latitude, longitude, precision
         FROM position_recenseur WHERE etat = 'OK' ORDER BY "utilisateurId", le DESC`,
    );
    const trajets = await this.ds.query<
      { u: string; points: [number, number, string][] }[]
    >(
      `SELECT "utilisateurId" AS u,
              json_agg(json_build_array(latitude, longitude, le) ORDER BY le) AS points
         FROM position_recenseur
        WHERE etat = 'OK' AND (le AT TIME ZONE 'Africa/Brazzaville')::date = $1::date
        GROUP BY 1`,
      [j],
    );
    const envois = await this.ds.query<
      { u: string; n: number; lignes: number }[]
    >(
      `SELECT "utilisateurId"::text AS u, count(*)::int AS n,
              coalesce(sum((details->>'faites')::int), 0)::int AS lignes
         FROM journal
        WHERE action = 'RECENSEMENT_TERRAIN' AND date::date = $1::date
        GROUP BY 1`,
      [j],
    );
    const parU = <T extends { u: string }>(l: T[]) =>
      new Map(l.map((x) => [x.u, x]));
    const d = parU(dernieres);
    const ok = parU(dernieresOk);
    const t = parU(trajets);
    const e = parU(envois);
    const maintenant = Date.now();
    // Au-delà d'une heure sans signal pendant la mission : orange ; trois heures : rouge
    const lignes = recenseurs.map((r) => {
      const der = d.get(r.id);
      const pos = ok.get(r.id);
      const minutes = der
        ? Math.round((maintenant - new Date(der.le).getTime()) / 60_000)
        : null;
      const signal: 'AUCUN' | 'COUPEE' | 'ANCIEN' | 'TRES_ANCIEN' | 'RECENT' =
        !der
          ? 'AUCUN'
          : der.etat === 'COUPEE'
            ? 'COUPEE'
            : minutes! > 180
              ? 'TRES_ANCIEN'
              : minutes! > 60
                ? 'ANCIEN'
                : 'RECENT';
      // Trajet allégé : 300 points au plus
      const pts = t.get(r.id)?.points ?? [];
      const pas = Math.max(1, Math.ceil(pts.length / 300));
      return {
        ...r,
        signal,
        minutesDepuis: minutes,
        dernierEtat: der?.etat ?? null,
        dernierSignal: der?.le ?? null,
        position: pos
          ? {
              latitude: pos.latitude,
              longitude: pos.longitude,
              precision: pos.precision,
              le: pos.le,
            }
          : null,
        trajet: pts.filter((_, i) => i % pas === 0 || i === pts.length - 1),
        envoisJour: e.get(r.id)?.n ?? 0,
        lignesJour: e.get(r.id)?.lignes ?? 0,
      };
    });
    return {
      jour: j,
      le: new Date().toISOString(),
      lignes,
      alertes: lignes
        .filter(
          (x) =>
            x.actif &&
            !x.effacerLe &&
            (x.signal === 'COUPEE' || x.signal === 'TRES_ANCIEN'),
        )
        .map((x) => ({
          id: x.id,
          code: x.code,
          nom: x.nom,
          signal: x.signal,
          depuis: x.dernierSignal,
          telephones: x.telephones,
        })),
    };
  }

  /** Les départements de la mission d'un recenseur (pour son périmètre). */
  async departementsDe(id: string): Promise<number[]> {
    const r = await this.ds.query<{ departements: number[] }[]>(
      `SELECT departements FROM recenseur WHERE "utilisateurId" = $1`,
      [id],
    );
    return r[0]?.departements ?? [];
  }
}
