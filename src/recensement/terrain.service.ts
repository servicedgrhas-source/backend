import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { posteResponsable } from '../circuit/catalogue';
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
}

@Injectable()
export class TerrainService {
  constructor(
    private readonly ds: DataSource,
    private readonly rec: RecensementService,
    private readonly ecoles: EtablissementsService,
    private readonly journal: JournalService,
  ) {}

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
        const donnees =
          m.donnees && typeof m.donnees === 'object' ? m.donnees : undefined;
        if (m.agentId) {
          await this.rec.modifier(u, Number(m.agentId), {
            ...(donnees ? { donnees } : {}),
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
            donnees: donnees ?? {},
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
