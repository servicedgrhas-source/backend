import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import {
  type FamilleLot,
  libelleLot,
  libellePaquet,
  TYPES_LOT,
  typeLotDe,
} from '../common/lots';
import { JournalService } from '../core/core.service';
import {
  Agent,
  LotPublication,
  PaquetReception,
  RegleDiplome,
} from '../entities';

/** Annule la transaction d'un essai à blanc en gardant son rapport. */
class EssaiAnnule extends Error {
  constructor(readonly rapport: unknown) {
    super('essai');
  }
}

/**
 * Range chaque texte reçu dans son paquet (date de réception) et dans le lot de son quota
 * et de son type (Arrêtés, Décrets PM, Décrets PR), créés au besoin.
 */
@Injectable()
export class LotsReceptionService {
  constructor(
    @InjectRepository(LotPublication)
    private readonly lots: Repository<LotPublication>,
    @InjectRepository(PaquetReception)
    private readonly paquets: Repository<PaquetReception>,
    private readonly journal: JournalService,
  ) {}

  /**
   * Range des personnes dans le lot de publication écrit dans la base (DG, 30/10/2026) :
   * « Arrêtés — lot VIII », « Décrets — lot III » ; tous les quotas d'un même lot ensemble. Le lot
   * est créé au besoin. Une personne déjà affectée y figure aussi (« déjà affectée ») : sa note,
   * figée, ne change pas. Renvoie le nombre de personnes rangées par lot.
   */
  async rangerParFichier(
    items: { id: string; famille: FamilleLot; numero: number }[],
    m: EntityManager = this.lots.manager,
  ) {
    if (!items.length) return [];
    const L = m.getRepository(LotPublication);
    const lots = await L.find();
    let maxLot = Math.max(0, ...lots.map((l) => l.numero));
    const parId = new Map(lots.map((l) => [l.id, l]));
    // Lot actuel de chaque personne : la date de signature qu'il lui donnait la suit
    const actuels = new Map<
      string,
      {
        lot: number | null;
        date: string | null;
        typeTexte: string | null;
      }
    >();
    const tous = items.map((i) => i.id);
    for (let i = 0; i < tous.length; i += 1000)
      for (const a of await m.query<
        {
          id: string;
          lot: number | null;
          date: string | null;
          typeTexte: string | null;
        }[]
      >(
        `SELECT id, "lotPublicationId" AS lot, "dateSignatureTexte"::text AS date, "typeTexte"
         FROM agent WHERE id = ANY($1)`,
        [tous.slice(i, i + 1000)],
      ))
        actuels.set(a.id, a);
    const datesPropres: { id: string; date: string }[] = [];
    const parLot = new Map<number, string[]>();
    for (const it of items) {
      let l = lots.find(
        (x) => x.numeroFichier === it.numero && x.typeTexte === it.famille,
      );
      if (!l) {
        l = await L.save(
          L.create({
            numero: ++maxLot,
            paquetId: null,
            typeTexte: it.famille,
            quota: null,
            autres: false,
            // rang renseigné : la réorganisation par date ne touche pas ces lots
            rang: it.numero,
            numeroFichier: it.numero,
          }),
        );
        lots.push(l);
      }
      (parLot.get(l.id) ?? parLot.set(l.id, []).get(l.id)!).push(it.id);
      // Date de signature donnée par l'ancien lot : gardée sur la fiche (le fichier n'en a pas)
      const a = actuels.get(it.id);
      const ancien = a?.lot && a.lot !== l.id ? parId.get(a.lot) : undefined;
      if (ancien && !a?.date) {
        const d =
          a?.typeTexte === 'DECRET'
            ? ancien.dateSignatureDecrets
            : ancien.dateSignatureArretes;
        if (d) datesPropres.push({ id: it.id, date: d });
      }
    }
    for (const x of datesPropres)
      await m.query(
        `UPDATE agent SET "dateSignatureTexte" = $2 WHERE id = $1 AND "dateSignatureTexte" IS NULL`,
        [x.id, x.date],
      );
    for (const [lotId, liste] of parLot)
      for (let i = 0; i < liste.length; i += 1000) {
        const ids = liste.slice(i, i + 1000);
        await m
          .getRepository(Agent)
          .update({ id: In(ids) }, { lotPublicationId: lotId });
        await m.query(
          `UPDATE affectation SET "lotPublicationId" = $1 WHERE "agentId" = ANY($2)`,
          [lotId, ids],
        );
      }
    return [...parLot].map(([id, liste]) => ({
      lot: lots.find((x) => x.id === id)!,
      n: liste.length,
    }));
  }

  /**
   * Range des personnes (dont le texte est déjà enregistré sur la fiche) : paquet de la
   * date donnée, puis lot de leur quota et de leur type de texte. Sans effet si elles y sont.
   */
  async ranger(
    items: { id: string; date: string | null }[],
    m: EntityManager = this.lots.manager,
  ) {
    if (!items.length) return [];
    const L = m.getRepository(LotPublication);
    const P = m.getRepository(PaquetReception);
    const A = m.getRepository(Agent);
    const regles = new Map(
      (await m.getRepository(RegleDiplome).find()).map((r) => [
        r.code,
        r.typeNote,
      ]),
    );
    const agents = new Map<string, Agent>();
    const ids = items.map((i) => i.id);
    for (let i = 0; i < ids.length; i += 1000)
      for (const a of await A.find({
        where: { id: In(ids.slice(i, i + 1000)) },
        select: ['id', 'feuille', 'quota', 'typeTexte', 'diplomeCode'],
        loadEagerRelations: false,
      }))
        agents.set(a.id, a);
    const paquets = await P.find();
    const lots = await L.find();
    let maxPaquet = Math.max(0, ...paquets.map((p) => p.numero));
    let maxLot = Math.max(0, ...lots.map((l) => l.numero));

    const paquetDu = async (date: string | null) => {
      let p = paquets.find((x) => x.dateReception === date);
      if (!p) {
        p = await P.save(
          P.create({ numero: ++maxPaquet, dateReception: date }),
        );
        paquets.push(p);
      }
      return p;
    };

    const parLot = new Map<number, string[]>();
    // Les paquets les plus anciens d'abord : les lots se numérotent dans l'ordre d'arrivée
    const tri = [...items].sort((a, b) =>
      (a.date ?? '9999').localeCompare(b.date ?? '9999'),
    );
    for (const it of tri) {
      const a = agents.get(it.id);
      if (!a) continue;
      const p = await paquetDu(it.date);
      const autres = a.feuille === 'QUOTA_AUTRES';
      const quota = autres ? null : (a.quota ?? null);
      const type = typeLotDe(
        a.typeTexte,
        a.diplomeCode ? regles.get(a.diplomeCode) : null,
      );
      const meme = (x: LotPublication) =>
        x.typeTexte === type &&
        (x.quota ?? null) === quota &&
        !!x.autres === autres;
      let l = lots.find((x) => x.paquetId === p.id && meme(x));
      if (!l) {
        const rang =
          Math.max(0, ...lots.filter(meme).map((x) => x.rang ?? 0)) + 1;
        l = await L.save(
          L.create({
            numero: ++maxLot,
            paquetId: p.id,
            typeTexte: type,
            quota,
            autres,
            rang,
            dateReception: p.dateReception,
          }),
        );
        lots.push(l);
      }
      const liste = parLot.get(l.id) ?? [];
      liste.push(a.id);
      parLot.set(l.id, liste);
    }
    for (const [lotId, liste] of parLot) {
      await A.update({ id: In(liste) }, { lotPublicationId: lotId });
      // Pas encore dans une note : l'affectation suit le lot
      await m.query(
        `UPDATE affectation SET "lotPublicationId" = $1
         WHERE "agentId" = ANY($2) AND statut = 'A_TRAITER'`,
        [lotId, liste],
      );
    }
    return [...parLot].map(([id, liste]) => {
      const l = lots.find((x) => x.id === id)!;
      const p = paquets.find((x) => x.id === l.paquetId)!;
      return {
        lot: l,
        libelle: libelleLot(l),
        paquet: libellePaquet(p),
        n: liste.length,
      };
    });
  }

  /**
   * Date de paquet de chaque personne. Les dates isolées d'un même groupe (même ancien
   * lot, faute de frappe ou date tirée dans Excel) sont rapprochées de la date la plus
   * proche qui regroupe au moins 5 personnes.
   */
  datesDePaquet(
    lignes: { id: string; groupe: number | string; date: string | null }[],
    defaut: (groupe: number | string) => string | null = () => null,
  ) {
    const parGroupe = new Map<number | string, Map<string, number>>();
    for (const a of lignes) {
      if (!a.date) continue;
      const c = parGroupe.get(a.groupe) ?? new Map<string, number>();
      c.set(a.date, (c.get(a.date) ?? 0) + 1);
      parGroupe.set(a.groupe, c);
    }
    const jour = (d: string) => new Date(d).getTime();
    let rapprochees = 0;
    const items = lignes.map((a) => {
      const c = parGroupe.get(a.groupe) ?? new Map<string, number>();
      let grandes = [...c].filter(([, n]) => n >= 5).map(([d]) => d);
      if (!grandes.length) grandes = [...c.keys()];
      if (!grandes.length) return { id: a.id, date: defaut(a.groupe) };
      if (a.date && grandes.includes(a.date)) return { id: a.id, date: a.date };
      const ref = a.date ?? defaut(a.groupe) ?? grandes[0];
      // Écart en jours, en pardonnant une erreur d'année (04/03/2025 tapé pour 04/03/2026)
      const ecart = (g: string) =>
        Math.min(
          Math.abs(jour(g) - jour(ref)),
          Math.abs(jour(g) - jour(`${g.slice(0, 4)}${ref.slice(4)}`)),
        );
      const proche = [...grandes].sort((x, y) => ecart(x) - ecart(y))[0];
      rapprochees++;
      return { id: a.id, date: proche };
    });
    return { items, rapprochees };
  }

  /** Supprime les lots et paquets restés vides (texte annulé, lots réorganisés). */
  async nettoyer(m: EntityManager = this.lots.manager) {
    await m.query(`
      DELETE FROM lot_publication l
      WHERE NOT EXISTS (SELECT 1 FROM agent a WHERE a."lotPublicationId" = l.id)
        AND NOT EXISTS (SELECT 1 FROM affectation f WHERE f."lotPublicationId" = l.id)
        AND NOT EXISTS (SELECT 1 FROM note_service n WHERE n."lotPublicationId" = l.id)`);
    await m.query(`
      DELETE FROM paquet_reception p
      WHERE NOT EXISTS (SELECT 1 FROM lot_publication l WHERE l."paquetId" = p.id)`);
  }

  /** Paquets et leurs lots, du plus récent au plus ancien. */
  async listePaquets() {
    const paquets = await this.paquets.find({ order: { numero: 'DESC' } });
    const lots = await this.lots.query<
      {
        id: number;
        numero: number;
        paquetId: number;
        typeTexte: string;
        quota: number | null;
        autres: boolean;
        rang: number;
        n: number;
      }[]
    >(`
      SELECT l.id, l.numero, l."paquetId", l."typeTexte", l.quota, l.autres, l.rang,
        count(a.id)::int AS n
      FROM lot_publication l LEFT JOIN agent a ON a."lotPublicationId" = l.id
      WHERE l."paquetId" IS NOT NULL
      GROUP BY l.id ORDER BY l.autres, l.quota, l."typeTexte", l.rang`);
    return paquets
      .map((p) => {
        const ls = lots
          .filter((l) => l.paquetId === p.id)
          .map((l) => ({ ...l, libelle: libelleLot(l) }));
        return {
          ...p,
          libelle: libellePaquet(p),
          textes: ls.reduce((n, l) => n + l.n, 0),
          lots: ls,
        };
      })
      .sort((a, b) =>
        (b.dateReception ?? '').localeCompare(a.dateReception ?? ''),
      );
  }

  /**
   * Réorganise les lots existants selon la règle (une seule fois) :
   * paquet = date de réception de la personne ; lot = quota + type, numéroté dans l'ordre
   * d'arrivée. Les notes et affectations suivent. `essai` : rapport sans rien écrire.
   */
  async reorganiser(u: UtilisateurConnecte, essai: boolean) {
    try {
      return await this.lots.manager.transaction(async (m) => {
        const anciens = await m.getRepository(LotPublication).find();
        const aRanger = anciens.filter((l) => !l.rang);
        if (!aRanger.length)
          return { dejaFait: true, message: 'Les lots suivent déjà la règle.' };
        const parId = new Map(anciens.map((l) => [l.id, l]));
        const ag = await m.query<
          { id: string; lot: number; date: string | null }[]
        >(
          `SELECT id, "lotPublicationId" AS lot, "dateReception"::text AS date
           FROM agent WHERE "lotPublicationId" = ANY($1)`,
          [aRanger.map((l) => l.id)],
        );

        const { items, rapprochees } = this.datesDePaquet(
          ag.map((a) => ({ id: a.id, groupe: a.lot, date: a.date })),
          (g) => parId.get(g as number)?.dateReception ?? null,
        );

        // Les anciens n° sont libérés : les nouveaux lots se numérotent 1, 2, 3…
        await m.query(
          `UPDATE lot_publication SET numero = -numero WHERE id = ANY($1) AND numero > 0`,
          [aRanger.map((l) => l.id)],
        );
        await this.ranger(items, m);

        // Dates de signature et observation reprises de l'ancien lot (le plus représenté)
        const repris = await m.query<
          { nouveau: number; ancien: number; n: number }[]
        >(
          `SELECT a."lotPublicationId" AS nouveau, x.lot AS ancien, count(*)::int AS n
           FROM agent a JOIN json_to_recordset($1::json) AS x(id uuid, lot int) ON x.id = a.id
           GROUP BY 1, 2 ORDER BY 1, 3 DESC`,
          [JSON.stringify(ag.map((a) => ({ id: a.id, lot: a.lot })))],
        );
        const vus = new Set<number>();
        for (const r of repris) {
          if (vus.has(r.nouveau)) continue;
          vus.add(r.nouveau);
          const o = parId.get(r.ancien)!;
          await m.update(LotPublication, r.nouveau, {
            dateSignatureArretes: o.dateSignatureArretes,
            dateSignatureDecrets: o.dateSignatureDecrets,
            observation: o.observation,
          });
        }

        // Toutes les affectations suivent leur personne (même celles déjà dans une note)
        await m.query(`
          UPDATE affectation f SET "lotPublicationId" = a."lotPublicationId"
          FROM agent a WHERE a.id = f."agentId" AND a."lotPublicationId" IS NOT NULL
            AND f."lotPublicationId" <> a."lotPublicationId"`);

        // Notes : rattachées au nouveau lot où se trouvent leurs personnes
        const notes = await m.query<
          { id: string; lot: number; typeNote: string }[]
        >(
          `SELECT id, "lotPublicationId" AS lot, "typeNote" FROM note_service
           WHERE module = 'AFFECTATION' AND "lotPublicationId" = ANY($1)`,
          [aRanger.map((l) => l.id)],
        );
        let notesDeplacees = 0;
        for (const n of notes) {
          const [dansNote] = await m.query<{ lot: number }[]>(
            `SELECT "lotPublicationId" AS lot FROM affectation WHERE "noteId" = $1
             GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`,
            [n.id],
          );
          const anciensAgents = ag
            .filter((a) => a.lot === n.lot)
            .map((a) => a.id);
          const [memeType] = dansNote
            ? [dansNote]
            : await m.query<{ lot: number }[]>(
                `SELECT f."lotPublicationId" AS lot FROM affectation f
                 WHERE f."agentId" = ANY($1) AND f."typeNote" = $2
                 GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`,
                [anciensAgents, n.typeNote],
              );
          const [plusGrand] = memeType
            ? [memeType]
            : await m.query<{ lot: number }[]>(
                `SELECT "lotPublicationId" AS lot FROM agent WHERE id = ANY($1)
                 GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`,
                [anciensAgents],
              );
          if (plusGrand) {
            await m.query(
              `UPDATE note_service SET "lotPublicationId" = $1 WHERE id = $2`,
              [plusGrand.lot, n.id],
            );
            notesDeplacees++;
          }
        }
        await this.nettoyer(m);

        const paquets = await m.getRepository(PaquetReception).find({
          order: { numero: 'ASC' },
        });
        const nouveaux = await m.query<
          {
            numero: number;
            paquetId: number;
            typeTexte: string;
            quota: number | null;
            autres: boolean;
            rang: number;
            n: number;
          }[]
        >(`
          SELECT l.numero, l."paquetId", l."typeTexte", l.quota, l.autres, l.rang,
            count(a.id)::int AS n
          FROM lot_publication l LEFT JOIN agent a ON a."lotPublicationId" = l.id
          GROUP BY l.id ORDER BY l.numero`);
        const rapport = {
          essai,
          anciensLots: aRanger.length,
          personnes: ag.length,
          datesRapprochees: rapprochees,
          notesDeplacees,
          paquets: paquets.map((p) => ({
            libelle: libellePaquet(p),
            lots: nouveaux
              .filter((l) => l.paquetId === p.id)
              .sort(
                (x, y) =>
                  TYPES_LOT.indexOf(x.typeTexte as never) -
                    TYPES_LOT.indexOf(y.typeTexte as never) ||
                  Number(x.autres) - Number(y.autres) ||
                  (x.quota ?? 0) - (y.quota ?? 0),
              )
              .map((l) => ({ libelle: libelleLot(l), n: l.n })),
          })),
        };
        if (essai) throw new EssaiAnnule(rapport);
        await this.journal.log(
          u,
          'REORGANISATION_LOTS',
          'lot_publication',
          null,
          {
            anciensLots: aRanger.length,
            nouveauxLots: nouveaux.length,
            paquets: paquets.length,
            personnes: ag.length,
          },
        );
        return rapport;
      });
    } catch (e) {
      if (e instanceof EssaiAnnule) return e.rapport;
      throw e;
    }
  }
}
