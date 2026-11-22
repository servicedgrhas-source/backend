import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { posteResponsable } from '../circuit/catalogue';
import {
  chercher,
  noter,
  type Prepare,
  preparer,
} from '../common/recherche-souple';
import { JournalService } from '../core/core.service';
import { EtablissementsService } from '../etablissements/etablissements.service';
import { auteurDe, RecensementService } from './recensement.service';

/**
 * Recensement sur le terrain (DG, 21/11/2026) : les équipes partent avec des tablettes ou des
 * smartphones, école par école. Elles téléchargent le « paquet » d'une école (ses agents, ce qui
 * manque), complètent et corrigent sur une grille rapide (une ligne par agent, comme dans Excel),
 * même sans connexion, puis envoient. Rien n'est saisi deux fois : on part de nos bases.
 */

/** Les colonnes de la grille, dans l'ordre de la saisie (celles que la configuration a actives). */
/**
 * Les agents envoyés aux tablettes (DG, 22/11/2026 : le travail des recenseurs est effectif tout de
 * suite, le contrôle valide ou défait) : tous sauf les rejetés. Un agent ajouté par une équipe est
 * dans son école dès l'envoi, marqué « en contrôle » jusqu'à la décision du DG ; rejeté, il disparaît.
 */
/** Ce que garde l'index de recherche pour chaque agent (nom, école, naissance, genre, grade). */
const SELECT_INDEX = `SELECT a.id, a."nomComplet", a.statut, a.matricule, a."structureId", a."departementId", s.nom AS "structureNom",
              to_char(a."dateNaissance", 'YYYY-MM-DD') AS "dateNaissance",
              a.donnees->>'GENRE' AS genre, a.donnees->>'GRADE' AS grade
           FROM agent_recense a LEFT JOIN structure s ON s.id = a."structureId"`;
const SUR_LES_TABLETTES = `coalesce(contentieux->>'etat', 'CONFIRME') <> 'REJETE'`;
const EN_CONTROLE = `coalesce(contentieux->>'etat', 'CONFIRME') IN ('EN_COURS', 'CONTROLE')`;

export const COLONNES_TERRAIN = [
  'NOMS_PRENOMS',
  'GENRE',
  'DATE_NAISSANCE',
  'MATRICULE_SOLDE',
  'GRADE',
  'ECHELON',
  'FONCTION',
  'FONCTION_STRUCTURE',
  'DIPLOME_PRO',
  'CYCLE',
  'SPECIALITE',
  'DATE_PRISE_SERVICE',
  'PRESENCE_POSTE',
  'TELEPHONE_1',
  'NOMBRE_ENFANTS',
  'ENFANTS',
];

export interface ModificationTerrain {
  /** Clé de la ligne sur la tablette (pour dire ce qui est passé). */
  cle: string;
  agentId?: number | null;
  statut?: string;
  donnees?: Record<string, unknown>;
  /** L'agent travaille dans cette école (rattachement). */
  structureId?: number | null;
  /** Ce que l'équipe constate : présent, absent ce jour, parti, inconnu ici. */
  presence?: 'PRESENT' | 'ABSENT' | 'PARTI' | 'INCONNU' | 'DOUBLON' | null;
  /** L'école où l'équipe travaille (pour un signalement). */
  ecoleId?: number | null;
  observation?: string | null;
  /** « Ce n'est pas lui » : créer quand même, malgré un agent qui lui ressemble. */
  forcer?: boolean;
}

/** Un agent de la base qui ressemble à celui que l'équipe veut créer. */
export interface Semblable {
  id: number;
  nomComplet: string;
  ecole: string | null;
  dateNaissance: string | null;
  matricule: string | null;
}

/**
 * Ce que l'équipe constate devant un agent. DOUBLON : la même personne écrite deux fois dans la base
 * (deux lignes au même nom dans l'école) ; un signalement que la DGRHAS règle dans « Doublons probables ».
 */
export const PRESENCES = [
  'PRESENT',
  'ABSENT',
  'PARTI',
  'INCONNU',
  'DOUBLON',
] as const;

@Injectable()
export class TerrainService implements OnApplicationBootstrap {
  /** L'index de recherche des agents se prépare peu après le démarrage (la première recherche n'attend pas). */
  onApplicationBootstrap() {
    setTimeout(() => {
      this.reconstruction ??= this.construireIndex()
        .catch(() => undefined)
        .finally(() => (this.reconstruction = null));
    }, 20_000).unref?.();
  }

  constructor(
    private readonly ds: DataSource,
    private readonly rec: RecensementService,
    private readonly ecoles: EtablissementsService,
    private readonly journal: JournalService,
  ) {}

  /** Index de recherche des agents (noms préparés), gardé deux minutes. */
  private index: {
    le: number;
    lignes: {
      id: number;
      nomComplet: string;
      statut: string;
      matricule: string | null;
      structureId: number | null;
      departementId: number | null;
      structureNom: string | null;
      dateNaissance: string | null;
      genre: string | null;
      grade: string | null;
      prepare: Prepare;
    }[];
    /** Première lettre (du son) de chaque mot → les fiches qui ont un mot qui commence ainsi. */
    parLettre: Map<string, number[]>;
  } | null = null;

  private reconstruction: Promise<void> | null = null;

  /** Les noms de tous les agents, préparés pour la recherche (sons, mots collés, première lettre). */
  private async construireIndex() {
    const lignes = await this.ds.query<
      {
        id: number;
        nomComplet: string;
        statut: string;
        matricule: string | null;
        structureId: number | null;
        departementId: number | null;
        structureNom: string | null;
        dateNaissance: string | null;
        genre: string | null;
        grade: string | null;
      }[]
    >(
      `${SELECT_INDEX} WHERE coalesce(a.contentieux->>'etat', 'CONFIRME') IN ('CONFIRME', 'EN_COURS', 'CONTROLE')`,
    );
    const prepares = lignes.map((l) => ({
      ...l,
      prepare: preparer(l.nomComplet),
    }));
    const parLettre = new Map<string, number[]>();
    prepares.forEach((l, i) => {
      for (const lettre of new Set(l.prepare.sons.map((m) => m[0]))) {
        // (jamais [...ancien, i] dans une boucle : beaucoup trop lent sur 70 000 fiches)
        const l = parLettre.get(lettre);
        if (l) l.push(i);
        else parLettre.set(lettre, [i]);
      }
    });
    this.index = { le: Date.now(), lignes: prepares, parLettre };
  }

  /**
   * Un agent vient d'être créé par une équipe : il entre TOUT DE SUITE dans l'index (sinon il n'y
   * serait qu'à la reconstruction suivante, jusqu'à 10 minutes : un 2e recenseur qui tape la même
   * personne entre-temps créerait un doublon).
   */
  private async ajouterALIndex(id: number) {
    if (!this.index) return;
    const [l] = await this.ds.query<
      {
        id: number;
        nomComplet: string;
        statut: string;
        matricule: string | null;
        structureId: number | null;
        departementId: number | null;
        structureNom: string | null;
        dateNaissance: string | null;
        genre: string | null;
        grade: string | null;
      }[]
    >(`${SELECT_INDEX} WHERE a.id = $1`, [id]);
    const index = this.index;
    if (!l || index.lignes.some((x) => x.id === id)) return;
    const i = index.lignes.length;
    const ligne = { ...l, prepare: preparer(l.nomComplet) };
    index.lignes.push(ligne);
    for (const lettre of new Set(ligne.prepare.sons.map((m) => m[0]))) {
      const g = index.parLettre.get(lettre);
      if (g) g.push(i);
      else index.parLettre.set(lettre, [i]);
    }
  }

  /**
   * Recherche intelligente d'un agent (DG, 22/11/2026) : on tape le nom comme on l'entend, dans
   * n'importe quel ordre, avec des fautes ; ou le début du matricule. Dans le périmètre du compte.
   */
  async rechercherAgents(u: UtilisateurConnecte, texte: string) {
    const q = (texte ?? '').trim().slice(0, 120);
    if (q.length < 2) return { lignes: [] };
    // L'index se refait en arrière-plan toutes les 10 minutes : une recherche n'attend jamais
    if (
      this.index &&
      Date.now() - this.index.le > 600_000 &&
      !this.reconstruction
    )
      this.reconstruction = this.construireIndex().finally(
        () => (this.reconstruction = null),
      );
    if (!this.index)
      await (this.reconstruction ??= this.construireIndex().finally(
        () => (this.reconstruction = null),
      ));
    const index = this.index!;
    const p = await this.rec.perimetre(u);
    const dedans = (l: {
      departementId: number | null;
      structureId: number | null;
    }) =>
      'tous' in p ||
      ('departementId' in p
        ? l.departementId === p.departementId
        : l.structureId !== null && p.structures.includes(l.structureId));
    // On ne compare que les fiches qui ont un mot commençant par la même lettre (en son) que le
    // mot tapé le plus rare : la première lettre est presque toujours juste ; 50 fois plus rapide
    const sons = preparer(q).sons.filter(
      (m) => m.length >= 2 && !/^\d+$/.test(m),
    );
    const listes = sons
      .map((m) => index.parLettre.get(m[0]) ?? [])
      .sort((a, b) => a.length - b.length);
    const candidates = listes.length
      ? listes[0].map((i) => index.lignes[i])
      : index.lignes;
    const permis = candidates.filter(dedans);
    const tousPermis = /\d/.test(q) ? index.lignes.filter(dedans) : permis;
    // Un matricule (ou son début) : la correspondance exacte d'abord
    const code = q.toUpperCase().replace(/\s+/g, '');
    const parMatricule =
      /\d/.test(code) && code.length >= 3
        ? tousPermis
            .filter((l) =>
              (l.matricule ?? '')
                .toUpperCase()
                .replace(/\s+/g, '')
                .startsWith(code),
            )
            .slice(0, 5)
            .map((l) => ({ item: l, note: 1 }))
        : [];
    const parNom = chercher(
      q,
      permis.map((l) => ({ item: l, prepare: l.prepare })),
      12,
    );
    const vus = new Set<number>();
    const trouves = [...parMatricule, ...parNom]
      .filter((x) => !vus.has(x.item.id) && !!vus.add(x.item.id))
      .slice(0, 12);
    // L'index peut avoir jusqu'à 10 minutes : une fiche supprimée ou fusionnée depuis n'est plus proposée
    const encore = await this.existent(trouves.map((x) => x.item.id));
    return {
      lignes: trouves
        .filter((x) => encore.has(x.item.id))
        .map(({ item, note }) => ({
          id: item.id,
          nomComplet: item.nomComplet,
          statut: item.statut,
          matricule: item.matricule,
          structureId: item.structureId,
          structureNom: item.structureNom,
          note: Math.round(note * 100),
        })),
    };
  }

  /**
   * Les agents de la base qui ressemblent à un nouvel agent (même recherche intelligente) : le nom
   * presque pareil, et la même date de naissance quand on la connaît des deux côtés.
   */
  async semblables(
    nom: string,
    naissance: string | null,
  ): Promise<Semblable[]> {
    if (nom.trim().length < 3) return [];
    if (!this.index) await this.construireIndex();
    const q = preparer(nom);
    const r: Semblable[] = [];
    for (const l of this.index!.lignes) {
      const note = noter(q, l.prepare);
      if (note < 0.85) continue;
      const memeDate =
        naissance && l.dateNaissance
          ? naissance.slice(0, 10) === l.dateNaissance
          : null;
      // Une date différente : une autre personne ; sans date, il faut un nom presque identique
      if (memeDate === false) continue;
      if (memeDate === null && note < 0.95) continue;
      r.push({
        id: l.id,
        nomComplet: l.nomComplet,
        ecole: l.structureNom,
        dateNaissance: l.dateNaissance,
        matricule: l.matricule,
      });
      if (r.length >= 10) break;
    }
    if (!r.length) return r;
    // L'index peut avoir jusqu'à 10 minutes : un agent rejeté (ou supprimé) depuis ne compte plus
    const encore = await this.existent(r.map((x) => x.id));
    return r.filter((x) => encore.has(x.id)).slice(0, 5);
  }

  /** Parmi ces fiches, celles qui existent encore (ni supprimées, ni fusionnées, ni rejetées). */
  private async existent(ids?: number[]): Promise<Set<number>> {
    if (ids && !ids.length) return new Set();
    return new Set(
      (
        await this.ds.query<{ id: number }[]>(
          `SELECT id FROM agent_recense WHERE ${ids ? 'id = ANY($1) AND ' : ''}${SUR_LES_TABLETTES}`,
          ids ? [ids] : [],
        )
      ).map((x) => x.id),
    );
  }

  /**
   * L'annuaire d'un département, pour chercher un agent SANS réseau (DG, 22/11/2026 : un agent
   * enregistré dans une école mais qui travaille dans une autre) : nom, école, matricule, naissance.
   */
  async annuaire(u: UtilisateurConnecte, departementId: number) {
    if (!this.index) await this.construireIndex();
    const p = await this.rec.perimetre(u);
    if ('departementId' in p && p.departementId !== departementId)
      throw new ForbiddenException(
        'Ce département n’est pas dans votre périmètre.',
      );
    const permis = (l: { structureId: number | null }) =>
      !('structures' in p) ||
      (l.structureId !== null && p.structures.includes(l.structureId));
    return {
      departementId,
      le: new Date().toISOString(),
      // Lignes compactes : [id, nom, école, matricule, naissance, statut]
      lignes: this.index!.lignes.filter(
        (l) => l.departementId === departementId && permis(l),
      ).map((l) => [
        l.id,
        l.nomComplet,
        l.structureNom,
        l.matricule,
        l.dateNaissance,
        l.statut,
      ]),
    };
  }

  /**
   * Qui modifie la fiche : le compte lui-même, sauf pour un agent hors de son périmètre rattaché
   * à une école de son périmètre (il est alors modifié comme par la DGRHAS, au nom du compte).
   */
  private async auteurDuRattachement(
    u: UtilisateurConnecte,
    agentId: number,
    ecoleId: number | null,
  ): Promise<UtilisateurConnecte> {
    if (!ecoleId) return u;
    const p = await this.rec.perimetre(u);
    if ('tous' in p) return u;
    const [a] = await this.ds.query<
      { departementId: number | null; structureId: number | null }[]
    >(
      `SELECT "departementId", "structureId" FROM agent_recense WHERE id = $1`,
      [agentId],
    );
    if (!a || this.rec.dansPerimetre(p, a)) return u;
    // L'école doit être dans le périmètre du compte (sinon : refus ordinaire)
    await this.ecoles.structure(u, ecoleId);
    return { ...u, role: 'AGENT' };
  }

  /**
   * La liste nationale très courte (DG, 22/11/2026 : « l'annuaire est-il suffisant ? ») : chaque
   * agent du pays avec de quoi le reconnaître (nom, naissance, genre, grade, école, département),
   * pour retrouver SANS réseau un agent venu d'un autre département. Pas le reste de sa fiche.
   */
  /**
   * La fiche d'un agent pour le formulaire du terrain (colonnes du formulaire seulement) : celui
   * qu'une équipe retrouve dans une de ses écoles alors qu'il est enregistré ailleurs (autre
   * département). Un compte d'école ou un visiteur : seulement dans son périmètre.
   */
  async agent(u: UtilisateurConnecte, id: number) {
    const [a] = await this.ds.query<
      {
        id: number;
        nomComplet: string;
        statut: string;
        matricule: string | null;
        departementId: number | null;
        structureId: number | null;
        donnees: Record<string, unknown>;
      }[]
    >(
      `SELECT id, "nomComplet", statut, matricule, "departementId", "structureId", (
              SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb) FROM jsonb_each(donnees) AS e(k, v) WHERE k = ANY($2)
            ) AS donnees
         FROM agent_recense WHERE id = $1`,
      [id, [...COLONNES_TERRAIN]],
    );
    if (!a) throw new NotFoundException('Agent introuvable.');
    if (
      (u.role === 'STRUCTURE' || u.role === 'VISITEUR') &&
      !this.rec.dansPerimetre(await this.rec.perimetre(u), a)
    )
      throw new ForbiddenException('Cet agent n’est pas dans votre périmètre.');
    const { departementId: _d, structureId: _s, ...agent } = a;
    void _d;
    void _s;
    return { agent };
  }

  async annuaireNational(u: UtilisateurConnecte) {
    if (u.role === 'STRUCTURE' || u.role === 'VISITEUR')
      throw new ForbiddenException(
        'La liste nationale est réservée aux recenseurs et à la DGRHAS.',
      );
    if (!this.index) await this.construireIndex();
    // (sans les fiches supprimées ou fusionnées depuis la dernière préparation de l'index)
    const encore = await this.existent();
    return {
      le: new Date().toISOString(),
      // [id, nom, école, matricule, naissance, statut, genre, grade, département]
      lignes: this.index!.lignes.filter((l) => encore.has(l.id)).map((l) => [
        l.id,
        l.nomComplet,
        l.structureNom,
        l.matricule,
        l.dateNaissance,
        l.statut,
        l.genre,
        l.grade,
        l.departementId,
      ]),
    };
  }

  /**
   * Un recenseur part avec la base de TOUT le pays sur sa tablette (DG, 22/11/2026) : il lit tout
   * (reconnaître un agent venu d'ailleurs, voir sa fiche sans réseau), mais n'écrit que dans les
   * écoles de sa mission (vérifié à l'envoi). Un compte d'école ne lit que son école.
   */
  private lectureNationale(u: UtilisateurConnecte) {
    return u.role !== 'STRUCTURE' && u.role !== 'VISITEUR';
  }

  /**
   * L'empreinte de chaque école : elle change dès qu'un de ses agents, un de ses bâtiments ou
   * l'école elle-même change (xmin de Postgres : toute écriture, même faite en série). La tablette
   * compare et ne reprend que les écoles qui ont changé.
   */
  private async empreintes(ids?: number[]): Promise<Map<number, string>> {
    const r = await this.ds.query<{ id: number; e: string }[]>(
      `SELECT s.id, md5(s.xmin::text || '|' ||
              coalesce((SELECT string_agg(a.id || ':' || a.xmin::text, ',' ORDER BY a.id) FROM agent_recense a
                         WHERE a."structureId" = s.id AND coalesce(a.contentieux->>'etat', 'CONFIRME') <> 'REJETE'), '') || '|' ||
              coalesce((SELECT string_agg(b.id || ':' || b.xmin::text, ',' ORDER BY b.id) FROM batiment b WHERE b."structureId" = s.id), '')) AS e
         FROM structure s
        WHERE s.actif AND s.type = 'ETABLISSEMENT' ${ids ? 'AND s.id = ANY($1)' : ''}`,
      ids ? [ids] : [],
    );
    return new Map(r.map((x) => [x.id, x.e]));
  }

  /** Les paquets de ces écoles (agents avec les colonnes du formulaire, bâtiments, GPS, chiffres). */
  private async paquetsDe(
    ecoles: {
      id: number;
      parentId: number | null;
      nom: string;
      cycle: string | null;
      localite: string | null;
      departementId: number | null;
      responsableId: number | null;
      latitude: number | null;
      longitude: number | null;
      precisionGps: number | null;
      localiseLe: string | null;
    }[],
    nomStruct: Map<number, string>,
  ) {
    const codes = this.colonnes().colonnes.map((c) => c.code);
    const ids = ecoles.map((e) => e.id);
    const [agents, batiments, salles, classes, responsables, empreintes] =
      await Promise.all([
        this.ds.query<
          {
            id: number;
            structureId: number;
            nomComplet: string;
            statut: string;
            matricule: string | null;
            donnees: Record<string, unknown>;
            aControler: boolean;
          }[]
        >(
          `SELECT id, "structureId", "nomComplet", statut, matricule, (
                  SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb) FROM jsonb_each(donnees) AS e(k, v) WHERE k = ANY($2)
                ) AS donnees, ${EN_CONTROLE} AS "aControler"
             FROM agent_recense
            WHERE "structureId" = ANY($1) AND ${SUR_LES_TABLETTES}
            ORDER BY "nomComplet"`,
          [ids, codes],
        ),
        this.ds.query<
          {
            id: number;
            structureId: number;
            nom: string;
            latitude: number | null;
            longitude: number | null;
            precisionGps: number | null;
            localiseLe: string | null;
          }[]
        >(
          `SELECT id, "structureId", nom, latitude, longitude, "precisionGps", "localiseLe" FROM batiment WHERE "structureId" = ANY($1) ORDER BY nom`,
          [ids],
        ),
        this.ds.query<{ s: number; n: number }[]>(
          `SELECT "structureId" AS s, count(*)::int AS n FROM salle WHERE "structureId" = ANY($1) GROUP BY 1`,
          [ids],
        ),
        this.ds.query<{ s: number; n: number }[]>(
          `SELECT "structureId" AS s, count(*)::int AS n FROM classe WHERE "structureId" = ANY($1) GROUP BY 1`,
          [ids],
        ),
        this.ds.query<{ id: number; nom: string }[]>(
          `SELECT id, "nomComplet" AS nom FROM agent_recense WHERE id = ANY($1)`,
          [ecoles.map((e) => e.responsableId).filter((x) => x !== null)],
        ),
        this.empreintes(ids),
      ]);
    const grouper = <T extends { structureId: number }>(l: T[]) => {
      const m = new Map<number, Omit<T, 'structureId'>[]>();
      for (const { structureId, ...x } of l) {
        const g = m.get(structureId);
        if (g) g.push(x);
        else m.set(structureId, [x]);
      }
      return m;
    };
    const parEcole = grouper(agents);
    const batParEcole = grouper(batiments);
    const nSalles = new Map(salles.map((x) => [x.s, x.n]));
    const nClasses = new Map(classes.map((x) => [x.s, x.n]));
    const nomResp = new Map(responsables.map((x) => [x.id, x.nom]));
    const telechargeLe = new Date().toISOString();
    return ecoles.map((s) => ({
      telechargeLe,
      empreinte: empreintes.get(s.id) ?? '',
      ecole: {
        id: s.id,
        nom: s.nom,
        cycle: s.cycle,
        localite: s.localite,
        departementId: s.departementId,
        inspection: s.parentId ? (nomStruct.get(s.parentId) ?? null) : null,
        posteResponsable: posteResponsable(s as never),
        responsable: s.responsableId
          ? (nomResp.get(s.responsableId) ?? null)
          : null,
        latitude: s.latitude,
        longitude: s.longitude,
        precisionGps: s.precisionGps,
        localiseLe: s.localiseLe,
        salles: nSalles.get(s.id) ?? 0,
        classes: nClasses.get(s.id) ?? 0,
      },
      batiments: batParEcole.get(s.id) ?? [],
      agents: parEcole.get(s.id) ?? [],
    }));
  }

  /**
   * Tout un département d'un coup : ses écoles et inspections, et le paquet de chaque école. Les
   * colonnes et les statuts ne viennent qu'une fois. Un recenseur peut prendre tous les
   * départements du pays (la base complète sur sa tablette).
   */
  async departement(u: UtilisateurConnecte, departementId: number) {
    const p = await this.rec.perimetre(u);
    const national = u.role === 'RECENSEUR';
    if (!national && 'departementId' in p && p.departementId !== departementId)
      throw new ForbiddenException(
        'Ce département n’est pas dans votre périmètre.',
      );
    if (!national && 'structures' in p)
      throw new ForbiddenException(
        'Un compte d’école télécharge son école, pas tout le département.',
      );
    const champs = this.colonnes();
    const structures = await this.ds.query<
      {
        id: number;
        parentId: number | null;
        type: string;
        nom: string;
        cycle: string | null;
        localite: string | null;
        departementId: number | null;
        responsableId: number | null;
        latitude: number | null;
        longitude: number | null;
        precisionGps: number | null;
        localiseLe: string | null;
      }[]
    >(
      `SELECT * FROM structure WHERE actif AND "departementId" = $1 AND type IN ('ETABLISSEMENT', 'INSPECTION')
        ORDER BY nom`,
      [departementId],
    );
    const nomStruct = new Map(structures.map((x) => [x.id, x.nom]));
    const paquets = await this.paquetsDe(
      structures.filter((s) => s.type === 'ETABLISSEMENT'),
      nomStruct,
    );
    return {
      telechargeLe: new Date().toISOString(),
      departementId,
      ...champs,
      structures: structures.map((s) => ({
        id: s.id,
        parentId: s.parentId,
        type: s.type,
        nom: s.nom,
        cycle: s.cycle,
        localite: s.localite,
        departementId: s.departementId,
        actif: true,
      })),
      paquets,
    };
  }

  /**
   * Le plan du téléchargement de la base complète : chaque département avec ses écoles et ses
   * agents (la barre de progression compte les agents), les départements de la mission d'abord.
   */
  async planBase(u: UtilisateurConnecte) {
    if (!this.lectureNationale(u))
      throw new ForbiddenException(
        'La base complète est réservée aux recenseurs et à la DGRHAS.',
      );
    const deps = await this.ds.query<
      {
        id: number;
        nom: string;
        ecoles: number;
        agents: number;
        ids: number[];
      }[]
    >(
      `SELECT d.id, d.nom,
              (SELECT coalesce(array_agg(s.id ORDER BY s.nom), '{}') FROM structure s WHERE s."departementId" = d.id AND s.actif AND s.type = 'ETABLISSEMENT') AS ids,
              (SELECT count(*)::int FROM structure s WHERE s."departementId" = d.id AND s.actif AND s.type = 'ETABLISSEMENT') AS ecoles,
              (SELECT count(*)::int FROM agent_recense a JOIN structure s ON s.id = a."structureId"
                WHERE s."departementId" = d.id AND s.actif AND s.type = 'ETABLISSEMENT'
                  AND coalesce(a.contentieux->>'etat', 'CONFIRME') <> 'REJETE') AS agents
         FROM departement d ORDER BY d.ordre`,
    );
    const mission =
      u.role === 'RECENSEUR'
        ? ((
            await this.ds.query<{ departements: number[] }[]>(
              `SELECT departements FROM recenseur WHERE "utilisateurId" = $1`,
              [u.id],
            )
          )[0]?.departements ?? [])
        : [];
    return {
      le: new Date().toISOString(),
      mission,
      departements: [
        ...deps.filter((d) => mission.includes(d.id)),
        ...deps.filter((d) => !mission.includes(d.id)),
      ],
    };
  }

  /** Les empreintes de toutes les écoles du pays (la tablette compare avec les siennes). */
  async empreintesBase(u: UtilisateurConnecte) {
    if (!this.lectureNationale(u))
      throw new ForbiddenException(
        'La base complète est réservée aux recenseurs et à la DGRHAS.',
      );
    return {
      le: new Date().toISOString(),
      ecoles: Object.fromEntries(await this.empreintes()),
    };
  }

  /** Les paquets des écoles qui ont changé (400 au plus d'un coup). */
  async ecolesBase(u: UtilisateurConnecte, ids: number[]) {
    if (!this.lectureNationale(u))
      throw new ForbiddenException(
        'La base complète est réservée aux recenseurs et à la DGRHAS.',
      );
    const liste = [
      ...new Set((ids ?? []).map(Number).filter(Number.isInteger)),
    ].slice(0, 400);
    if (!liste.length) return { paquets: [] };
    const ecoles = await this.ds.query<
      {
        id: number;
        parentId: number | null;
        nom: string;
        cycle: string | null;
        localite: string | null;
        departementId: number | null;
        responsableId: number | null;
        latitude: number | null;
        longitude: number | null;
        precisionGps: number | null;
        localiseLe: string | null;
      }[]
    >(
      `SELECT * FROM structure WHERE actif AND type = 'ETABLISSEMENT' AND id = ANY($1)`,
      [liste],
    );
    const parents = await this.ds.query<{ id: number; nom: string }[]>(
      `SELECT id, nom FROM structure WHERE id = ANY($1)`,
      [ecoles.map((e) => e.parentId).filter((x) => x !== null)],
    );
    return {
      paquets: await this.paquetsDe(
        ecoles,
        new Map(parents.map((x) => [x.id, x.nom])),
      ),
    };
  }

  /**
   * Un bâtiment ou une annexe découvert sur place (DG, 22/11/2026 : les écoles, leurs bâtiments et
   * leurs annexes géolocalisés) : créé depuis le terrain, avec sa position si elle a été prélevée.
   * Seulement dans une école du périmètre du compte (la mission, pour un recenseur).
   */
  async ajouterBatiment(
    u: UtilisateurConnecte,
    ecoleId: number,
    d: {
      nom?: unknown;
      type?: unknown;
      latitude?: unknown;
      longitude?: unknown;
      precision?: unknown;
    },
  ) {
    const b = await this.ecoles.enregistrerBatiment(u, ecoleId, null, {
      nom: d.nom,
      type: d.type,
    });
    if (
      d.latitude !== undefined &&
      d.latitude !== null &&
      d.longitude !== undefined &&
      d.longitude !== null
    )
      await this.ecoles.localiser(
        u,
        ecoleId,
        {
          latitude: d.latitude,
          longitude: d.longitude,
          precision: d.precision,
        },
        b.id,
      );
    return { id: b.id, nom: b.nom };
  }

  /** Les signalements du terrain (absent, parti, inconnu ici), à traiter par la DGRHAS. */
  async signalements(u: UtilisateurConnecte, traites = false) {
    const p = await this.rec.perimetre(u);
    const lignes = await this.ds.query<
      {
        id: number;
        agentId: number;
        nomComplet: string;
        statut: string;
        structureId: number;
        ecole: string;
        departementId: number | null;
        etat: string;
        observation: string | null;
        par: string | null;
        le: string;
        traitePar: string | null;
        traiteLe: string | null;
      }[]
    >(
      `SELECT g.id, g."agentId", a."nomComplet", a.statut, g."structureId", s.nom AS ecole, s."departementId",
              g.etat, g.observation, g.par, g.le, g."traitePar", g."traiteLe"
         FROM signalement_terrain g
         JOIN agent_recense a ON a.id = g."agentId"
         JOIN structure s ON s.id = g."structureId"
        WHERE g.traite = $1
        ORDER BY g.le DESC
        LIMIT 500`,
      [traites],
    );
    return lignes.filter(
      (l) =>
        'tous' in p ||
        ('departementId' in p
          ? l.departementId === p.departementId
          : p.structures.includes(l.structureId)),
    );
  }

  /** Signalement vérifié et traité (la fiche a été corrigée, ou l'agent est bien à sa place). */
  async traiter(u: UtilisateurConnecte, id: number) {
    const r = await this.ds.query<unknown[]>(
      `UPDATE signalement_terrain SET traite = true, "traitePar" = $2, "traiteLe" = now() WHERE id = $1 AND NOT traite RETURNING id`,
      [id, u.nom],
    );
    if (!(Array.isArray(r[0]) ? r[0] : r).length)
      throw new NotFoundException('Signalement introuvable ou déjà traité.');
    await this.journal.log(
      u,
      'SIGNALEMENT_TERRAIN_TRAITE',
      'signalement_terrain',
      String(id),
    );
    return { ok: true };
  }

  /** Les colonnes de la grille et les statuts possibles, d'après la configuration de la fiche. */
  colonnes() {
    const c = this.rec.config.get();
    return {
      colonnes: COLONNES_TERRAIN.map((code) =>
        c.champs.find((ch) => ch.code === code && ch.actif),
      )
        .filter((ch): ch is NonNullable<typeof ch> => !!ch)
        .map((ch) => ({
          code: ch.code,
          libelle: ch.libelle,
          type: ch.type,
          options: (ch.options ?? []).map((o) => ({
            code: o.code,
            libelle: o.libelle,
          })),
          colonnes: (ch.colonnes ?? []).map((x) => ({
            code: x.code,
            libelle: x.libelle,
          })),
          obligatoirePour: ch.obligatoirePour ?? [],
          aide: ch.aide ?? '',
        })),
      statuts: c.statuts
        .filter((s) => s.actif)
        .map((s) => ({ code: s.code, libelle: s.libelle })),
    };
  }

  /** Le paquet d'une école : de quoi travailler sur place, même sans connexion. */
  async paquet(u: UtilisateurConnecte, id: number) {
    const s = await this.ecoles.structure(u, id);
    if (s.type !== 'ETABLISSEMENT')
      throw new BadRequestException(
        'Le recensement sur le terrain se fait école par école.',
      );
    const champs = this.colonnes();
    const codes = champs.colonnes.map((c) => c.code);
    const [inspection, responsable, batiments, salles, classes, agents] =
      await Promise.all([
        s.parentId
          ? this.ds.query<{ nom: string }[]>(
              `SELECT nom FROM structure WHERE id = $1`,
              [s.parentId],
            )
          : [],
        s.responsableId
          ? this.ds.query<{ nom: string }[]>(
              `SELECT "nomComplet" AS nom FROM agent_recense WHERE id = $1`,
              [s.responsableId],
            )
          : [],
        this.ds.query<
          {
            id: number;
            nom: string;
            latitude: number | null;
            longitude: number | null;
            precisionGps: number | null;
            localiseLe: string | null;
          }[]
        >(
          `SELECT id, nom, latitude, longitude, "precisionGps", "localiseLe" FROM batiment WHERE "structureId" = $1 ORDER BY nom`,
          [id],
        ),
        this.ds.query<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM salle WHERE "structureId" = $1`,
          [id],
        ),
        this.ds.query<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM classe WHERE "structureId" = $1`,
          [id],
        ),
        this.ds.query<
          {
            id: number;
            nomComplet: string;
            statut: string;
            matricule: string | null;
            donnees: Record<string, unknown>;
            modifieLe: string;
            aControler: boolean;
          }[]
        >(
          `SELECT id, "nomComplet", statut, matricule, (
                  SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb) FROM jsonb_each(donnees) AS e(k, v) WHERE k = ANY($2)
                ) AS donnees, "modifieLe", ${EN_CONTROLE} AS "aControler"
             FROM agent_recense
            WHERE "structureId" = $1 AND ${SUR_LES_TABLETTES}
            ORDER BY "nomComplet"`,
          [id, codes],
        ),
      ]);
    return {
      telechargeLe: new Date().toISOString(),
      ecole: {
        id: s.id,
        nom: s.nom,
        cycle: s.cycle,
        localite: s.localite,
        departementId: s.departementId,
        inspection: inspection[0]?.nom ?? null,
        posteResponsable: posteResponsable(s),
        responsable: responsable[0]?.nom ?? null,
        latitude: s.latitude,
        longitude: s.longitude,
        precisionGps: s.precisionGps,
        localiseLe: s.localiseLe,
        salles: salles[0]?.n ?? 0,
        classes: classes[0]?.n ?? 0,
      },
      batiments,
      ...champs,
      agents,
    };
  }

  /**
   * Ce que l'équipe envoie : chaque ligne passe par les mêmes règles que la fiche du personnel
   * (valeurs vérifiées, modifications au contrôle comme au recensement) ; un agent absent de nos
   * bases part au contrôle puis à la décision du DG. Une ligne refusée n'empêche pas les autres.
   */
  async envoyer(u: UtilisateurConnecte, liste: ModificationTerrain[]) {
    if (!Array.isArray(liste) || !liste.length)
      throw new BadRequestException('Rien à envoyer.');
    if (liste.length > 500)
      throw new BadRequestException('Trop de lignes d’un coup (500 au plus).');
    const resultats: {
      cle: string;
      ok: boolean;
      id?: number;
      erreur?: string;
      semblables?: Semblable[];
    }[] = [];
    for (const m of liste) {
      const cle = String(m?.cle ?? '');
      try {
        const donnees: Record<string, unknown> | undefined =
          m.donnees && typeof m.donnees === 'object'
            ? { ...m.donnees }
            : undefined;
        const presence = PRESENCES.includes(m.presence as never)
          ? m.presence
          : null;
        if (m.agentId && !(await this.existent([Number(m.agentId)])).size)
          throw new BadRequestException(
            'Cette fiche n’existe plus dans la base (fusionnée avec une autre ou supprimée par la DGRHAS). Retirez cette ligne, puis cherchez l’agent à nouveau.',
          );
        // Présent : « Présence au poste : Oui » ; absent, parti, inconnu : un signalement à traiter
        if (presence === 'PRESENT' && m.agentId)
          Object.assign(donnees ?? (m.donnees = {}), { PRESENCE_POSTE: 'OUI' });
        if (presence && presence !== 'PRESENT' && m.agentId) {
          const ecole = Number(m.ecoleId ?? m.structureId);
          if (!ecole)
            throw new BadRequestException('École du signalement inconnue.');
          await this.ds.query(
            `INSERT INTO signalement_terrain ("agentId", "structureId", etat, observation, par, "campagneId")
             VALUES ($1, $2, $3, $4, $5, (SELECT id FROM campagne_recensement WHERE "clotureLe" IS NULL ORDER BY debut DESC, id DESC LIMIT 1))`,
            [
              Number(m.agentId),
              ecole,
              presence,
              m.observation ? String(m.observation).slice(0, 500) : null,
              auteurDe(u),
            ],
          );
          if (!donnees || !Object.keys(donnees).length) {
            resultats.push({ cle, ok: true, id: Number(m.agentId) });
            continue;
          }
        }
        const aEcrire =
          presence === 'PRESENT' && m.agentId
            ? { ...(donnees ?? {}), PRESENCE_POSTE: 'OUI' }
            : donnees;
        if (m.agentId) {
          // Un agent enregistré ailleurs (autre département, ou sans école) que l'équipe trouve
          // dans une de SES écoles : le rattachement est permis (DG, 22/11/2026), puis il passe au
          // contrôle comme toute modification du recensement
          const qui = await this.auteurDuRattachement(
            u,
            Number(m.agentId),
            m.structureId ? Number(m.structureId) : null,
          );
          await this.rec.modifier(qui, Number(m.agentId), {
            ...(aEcrire ? { donnees: aEcrire } : {}),
            ...(m.structureId ? { structureId: Number(m.structureId) } : {}),
            ...(m.statut ? { statut: m.statut } : {}),
            recensement: true,
          });
          // Trouvé ici alors qu'une autre équipe l'avait dit « parti » ou « inconnu » ailleurs : réglé
          if (m.structureId)
            await this.ds.query(
              `UPDATE signalement_terrain SET traite = true, "traitePar" = $3, "traiteLe" = now()
                WHERE "agentId" = $1 AND NOT traite AND etat IN ('PARTI', 'INCONNU') AND "structureId" <> $2`,
              [
                Number(m.agentId),
                Number(m.structureId),
                `${u.nom} (retrouvé dans une autre école par la mission)`,
              ],
            );
          resultats.push({ cle, ok: true, id: Number(m.agentId) });
        } else {
          if (!m.statut)
            throw new BadRequestException(
              'Nouvel agent : choisissez son statut.',
            );
          // Déjà dans la base sous une autre école (ou un nom mal écrit) : on ne le recrée pas
          if (!m.forcer) {
            const texte = (v: unknown) =>
              typeof v === 'string' || typeof v === 'number' ? String(v) : '';
            const deja = await this.semblables(
              texte(aEcrire?.NOMS_PRENOMS),
              texte(aEcrire?.DATE_NAISSANCE) || null,
            );
            if (deja.length) {
              resultats.push({
                cle,
                ok: false,
                erreur: `Déjà dans la base : ${deja
                  .map(
                    (d) =>
                      `${d.nomComplet}${d.dateNaissance ? `, né(e) le ${d.dateNaissance.split('-').reverse().join('/')}` : ''} (${d.ecole ?? 'sans école'})`,
                  )
                  .join(' ; ')}. Si c'est lui : « Il travaille ici ».`,
                semblables: deja,
              });
              continue;
            }
          }
          const r = (await this.rec.creer(u, {
            statut: m.statut,
            structureId: m.structureId ? Number(m.structureId) : null,
            donnees: aEcrire ?? {},
            contentieux: 'Ajouté par la mission de recensement sur le terrain',
            recensement: true,
            forcer: !!m.forcer,
            // Une fiche rejetée par le DG n'existe plus pour les équipes (elle ne bloque pas)
            ignorerRejetes: true,
          })) as { id?: number } | undefined;
          // Tout de suite reconnu par les autres équipes (pas de doublon dans les minutes qui suivent)
          if (r?.id) await this.ajouterALIndex(r.id);
          resultats.push({ cle, ok: true, id: r?.id });
        }
      } catch (e) {
        const message =
          e instanceof HttpException ||
          e instanceof NotFoundException ||
          e instanceof ForbiddenException
            ? ((e.getResponse() as { message?: string | string[] })?.message ??
              e.message)
            : (e as Error).message;
        resultats.push({
          cle,
          ok: false,
          erreur: Array.isArray(message) ? message.join(' ; ') : message,
        });
      }
    }
    await this.journal.log(u, 'RECENSEMENT_TERRAIN', 'agent_recense', null, {
      envoyees: liste.length,
      faites: resultats.filter((r) => r.ok).length,
      refusees: resultats.filter((r) => !r.ok).length,
    });
    return { resultats };
  }
}
