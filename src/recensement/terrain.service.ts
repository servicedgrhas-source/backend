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
import { chercher, type Prepare, preparer } from '../common/recherche-souple';
import { JournalService } from '../core/core.service';
import { EtablissementsService } from '../etablissements/etablissements.service';
import { RecensementService } from './recensement.service';

/**
 * Recensement sur le terrain (DG, 21/11/2026) : les équipes partent avec des tablettes ou des
 * smartphones, école par école. Elles téléchargent le « paquet » d'une école (ses agents, ce qui
 * manque), complètent et corrigent sur une grille rapide (une ligne par agent, comme dans Excel),
 * même sans connexion, puis envoient. Rien n'est saisi deux fois : on part de nos bases.
 */

/** Les colonnes de la grille, dans l'ordre de la saisie (celles que la configuration a actives). */
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
  presence?: 'PRESENT' | 'ABSENT' | 'PARTI' | 'INCONNU' | null;
  /** L'école où l'équipe travaille (pour un signalement). */
  ecoleId?: number | null;
  observation?: string | null;
}

export const PRESENCES = ['PRESENT', 'ABSENT', 'PARTI', 'INCONNU'] as const;

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
      }[]
    >(
      `SELECT a.id, a."nomComplet", a.statut, a.matricule, a."structureId", a."departementId", s.nom AS "structureNom"
           FROM agent_recense a LEFT JOIN structure s ON s.id = a."structureId"
          WHERE coalesce(a.contentieux->>'etat', 'CONFIRME') IN ('CONFIRME', 'EN_COURS', 'CONTROLE')`,
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
    return {
      lignes: [...parMatricule, ...parNom]
        .filter((x) => !vus.has(x.item.id) && !!vus.add(x.item.id))
        .slice(0, 12)
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
          }[]
        >(
          `SELECT id, "nomComplet", statut, matricule, (
                  SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb) FROM jsonb_each(donnees) AS e(k, v) WHERE k = ANY($2)
                ) AS donnees, "modifieLe"
             FROM agent_recense
            WHERE "structureId" = $1 AND coalesce(contentieux->>'etat', 'CONFIRME') = 'CONFIRME'
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
        // Présent : « Présence au poste : Oui » ; absent, parti, inconnu : un signalement à traiter
        if (presence === 'PRESENT' && m.agentId)
          Object.assign(donnees ?? (m.donnees = {}), { PRESENCE_POSTE: 'OUI' });
        if (presence && presence !== 'PRESENT' && m.agentId) {
          const ecole = Number(m.ecoleId ?? m.structureId);
          if (!ecole)
            throw new BadRequestException('École du signalement inconnue.');
          await this.ds.query(
            `INSERT INTO signalement_terrain ("agentId", "structureId", etat, observation, par) VALUES ($1, $2, $3, $4, $5)`,
            [
              Number(m.agentId),
              ecole,
              presence,
              m.observation ? String(m.observation).slice(0, 500) : null,
              u.nom,
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
          await this.rec.modifier(u, Number(m.agentId), {
            ...(aEcrire ? { donnees: aEcrire } : {}),
            ...(m.structureId ? { structureId: Number(m.structureId) } : {}),
            ...(m.statut ? { statut: m.statut } : {}),
            recensement: true,
          });
          resultats.push({ cle, ok: true, id: Number(m.agentId) });
        } else {
          if (!m.statut)
            throw new BadRequestException(
              'Nouvel agent : choisissez son statut.',
            );
          const r = (await this.rec.creer(u, {
            statut: m.statut,
            structureId: m.structureId ? Number(m.structureId) : null,
            donnees: aEcrire ?? {},
            contentieux: 'Ajouté par la mission de recensement sur le terrain',
            recensement: true,
          })) as { id?: number } | undefined;
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
