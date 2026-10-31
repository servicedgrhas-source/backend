import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import {
  AnomaliesService,
  dateFr,
  nomRessemblant,
  RESSEMBLE,
} from '../common/anomalies';
import { libelleLot } from '../common/lots';
import { motsDuNom, ressemblance } from '../common/ressemblance';
import { normaliser } from '../common/texte';
import { JournalService } from '../core/core.service';
import { Affectation, Agent } from '../entities';

/** Champs d'une fiche complétés par la fiche supprimée quand ils sont vides (fusion des doublons). */
const CHAMPS_FUSION = [
  'dateNaissance',
  'dateNaissanceBrute',
  'lieuNaissance',
  'diplomeBrut',
  'diplomeCode',
  'departementBrut',
  'departementId',
  'source',
  'cycleBrut',
  'qualification',
  'specialite',
  'lotCommission',
  'statut',
  'observation',
  'typeTexte',
  'numeroTexte',
  'dateSignatureTexte',
  'dateReception',
  'lieuServiceBrut',
  'origineBrute',
  'agentRecenseId',
] as const;

const vide = (v: unknown) => v === null || v === undefined || v === '';

/** Spécialité d'une note du primaire ou du préscolaire : le cycle lui-même (DG, 31/10/2026). */
export const SPECIALITE_DU_CYCLE: Record<string, string> = {
  PRIMAIRE: 'Primaire',
  PRESCOLAIRE: 'Préscolaire',
};

/**
 * Doublons probables de la base des recrutés (DG, 31/10/2026) : on compare les deux fiches, puis on
 * supprime définitivement l'une (ses informations complètent l'autre) ou on déclare que ce sont
 * deux personnes différentes. Spécialité du primaire et du préscolaire : le cycle.
 */
@Injectable()
export class DoublonsService {
  constructor(
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
    @InjectRepository(Affectation)
    private readonly affectations: Repository<Affectation>,
    private readonly anomalies: AnomaliesService,
    private readonly journal: JournalService,
  ) {}

  /** Une fiche, telle qu'on la compare à son doublon. */
  private async resume(a: Agent) {
    const f = await this.affectations.findOne({
      where: { agentId: a.id },
      loadEagerRelations: false,
    });
    const [note] = f?.noteId
      ? await this.agents.query<{ numero: string | null; statut: string }[]>(
          `SELECT numero, statut FROM note_service WHERE id = $1`,
          [f.noteId],
        )
      : [];
    return {
      id: a.id,
      nomComplet: a.nomComplet,
      dateNaissance: a.dateNaissance,
      dateNaissanceBrute: a.dateNaissanceBrute,
      lieuNaissance: a.lieuNaissance,
      diplome: a.diplomeBrut,
      departement: a.departement?.nom ?? a.departementBrut,
      quota:
        a.feuille === 'QUOTA_AUTRES'
          ? 'Quota « Autres »'
          : `Quota ${a.quota ?? '?'}`,
      lot: a.lotPublication ? libelleLot(a.lotPublication) : null,
      texte: a.numeroTexte
        ? `${a.typeTexte === 'DECRET' ? 'Décret' : 'Arrêté'} n° ${a.numeroTexte}`
        : null,
      specialite: a.specialite,
      qualification: a.qualification,
      source: a.source,
      observation: a.observation,
      creeLe: a.creeLe,
      affectation: f
        ? {
            statut: f.statut,
            motifExclusion: f.motifExclusion,
            note: note
              ? `Note n° ${note.numero ?? '?'} (${note.statut.toLowerCase()})`
              : null,
          }
        : null,
      /** Peut être supprimée : pas dans une note validée ou signée. */
      supprimable: !f || (f.statut !== 'AFFECTE' && !f.noteId),
    };
  }

  /** Les fiches qui ressemblent à celle-ci (nom proche et même date, ou « Ressemble à » relevé). */
  async candidats(id: string) {
    const a = await this.agents.findOne({ where: { id } });
    if (!a) throw new NotFoundException('Fiche introuvable');
    const noms = (a.anomalies ?? [])
      .filter((x) => x.startsWith(RESSEMBLE))
      .map((x) => normaliser(nomRessemblant(x)));
    const mots = motsDuNom(a.nomNormalise);
    const proches = await this.agents
      .createQueryBuilder('b')
      .leftJoinAndSelect('b.lotPublication', 'l')
      .leftJoinAndSelect('b.departement', 'd')
      .where('b.id <> :id', { id })
      .andWhere(
        noms.length
          ? '(b.nomNormalise IN (:...noms) OR b.nomNormalise = :nom)'
          : 'b.nomNormalise = :nom',
        { noms, nom: a.nomNormalise },
      )
      .getMany();
    // Même date et un nom proche (« Ressemble à » sans le même nom écrit pareil)
    const memeDate = a.dateNaissance
      ? (
          await this.agents
            .createQueryBuilder('b')
            .leftJoinAndSelect('b.lotPublication', 'l')
            .leftJoinAndSelect('b.departement', 'd')
            .where('b.id <> :id AND b.dateNaissance = :d', {
              id,
              d: a.dateNaissance,
            })
            .getMany()
        ).filter(
          (b) =>
            ressemblance(
              mots,
              a.dateNaissance,
              motsDuNom(b.nomNormalise),
              b.dateNaissance,
            ) === 'PROBABLE',
        )
      : [];
    const verifiees = new Set(a.anomaliesVerifiees ?? []);
    const tous = [
      ...new Map([...proches, ...memeDate].map((b) => [b.id, b])).values(),
    ].filter((b) => !verifiees.has(`${RESSEMBLE}${b.nomComplet}`));
    return {
      fiche: await this.resume(a),
      candidats: await Promise.all(
        tous.slice(0, 10).map((b) => this.resume(b)),
      ),
    };
  }

  /**
   * Décision sur un doublon :
   * - SUPPRIMER : la fiche `id` est supprimée définitivement ; ses informations complètent
   *   `autreId` (cases vides seulement), ses pièces et sa fiche du personnel y passent ;
   * - DIFFERENTES : ce sont deux personnes ; la ressemblance n'est plus signalée, ni bloquante.
   */
  async trancher(
    u: UtilisateurConnecte,
    id: string,
    autreId: string,
    decision: 'SUPPRIMER' | 'DIFFERENTES',
  ) {
    if (id === autreId)
      throw new BadRequestException('Choisissez deux fiches différentes.');
    const [a, b] = await Promise.all([
      this.agents.findOne({ where: { id } }),
      this.agents.findOne({ where: { id: autreId } }),
    ]);
    if (!a || !b) throw new NotFoundException('Fiche introuvable');

    if (decision === 'DIFFERENTES') {
      for (const [x, autre] of [
        [a, b],
        [b, a],
      ] as const) {
        const motif = `${RESSEMBLE}${autre.nomComplet}`;
        await this.agents.update(x.id, {
          anomaliesVerifiees: [
            ...new Set([...(x.anomaliesVerifiees ?? []), motif]),
          ],
          anomalies: (x.anomalies ?? []).filter((y) => !y.startsWith(motif)),
        });
      }
      await this.journal.log(u, 'DOUBLON_PERSONNES_DIFFERENTES', 'agent', id, {
        autre: autreId,
      });
      return { ok: true, decision };
    }

    // Suppression définitive de `a`, gardée : `b`
    const fa = await this.affectations.findOne({
      where: { agentId: a.id },
      loadEagerRelations: false,
    });
    if (fa && (fa.statut === 'AFFECTE' || fa.noteId))
      throw new BadRequestException(
        `${a.nomComplet} est déjà dans une note validée ou signée : cette fiche ne peut pas être supprimée. Supprimez plutôt l'autre fiche, ou rouvrez la note.`,
      );
    const completes: string[] = [];
    await this.agents.manager.transaction(async (m) => {
      const maj: Record<string, unknown> = {};
      for (const k of CHAMPS_FUSION)
        if (vide(b[k]) && !vide(a[k])) {
          maj[k] = a[k];
          completes.push(k);
        }
      if (Object.keys(maj).length) await m.update(Agent, b.id, maj);
      // Pièces du dossier et références de notes : elles suivent la personne
      await m.query(
        `UPDATE piece_jointe SET "agentId" = $2 WHERE "agentId" = $1`,
        [a.id, b.id],
      );
      await m.query(
        `UPDATE reference_note SET "agentId" = $2 WHERE "agentId" = $1`,
        [a.id, b.id],
      );
      if (fa) {
        await m.query(`DELETE FROM recommandation WHERE "affectationId" = $1`, [
          fa.id,
        ]);
        await m.delete(Affectation, fa.id);
      }
      await m.delete(Agent, a.id);
    });
    // L'autre fiche ne « ressemble » plus à une fiche qui n'existe plus
    await this.anomalies.reconcilier([b.id]);
    await this.journal.log(u, 'DOUBLON_FICHE_SUPPRIMEE', 'agent', b.id, {
      supprimee: a.nomComplet,
      neeLe: a.dateNaissance ? dateFr(a.dateNaissance) : null,
      completes,
    });
    return { ok: true, decision, completes };
  }

  /**
   * Spécialité des notes du primaire et du préscolaire : le cycle lui-même. Donnée à chaque
   * personne pas encore dans une note validée qui n'en a pas ; une spécialité écrite est gardée.
   */
  async completerSpecialites(u?: UtilisateurConnecte) {
    let n = 0;
    for (const [type, specialite] of Object.entries(SPECIALITE_DU_CYCLE)) {
      const r = await this.affectations.query<unknown[]>(
        `UPDATE affectation f SET specialite = $2
         FROM agent a LEFT JOIN regle_diplome r ON r.code = a."diplomeCode"
         WHERE a.id = f."agentId" AND f.statut = 'A_TRAITER' AND f."noteId" IS NULL
           AND coalesce(trim(f.specialite), '') = ''
           AND (f."typeNote" = $1 OR (f."typeNote" = 'A_DEFINIR' AND r.cycle = $1))
         RETURNING f.id`,
        [type, specialite],
      );
      n += Array.isArray(r[0]) ? (r[0] as unknown[]).length : r.length;
      await this.affectations.query(
        `UPDATE agent a SET specialite = $2
         FROM affectation f WHERE f."agentId" = a.id AND f."typeNote" = $1
           AND coalesce(trim(a.specialite), '') = ''`,
        [type, specialite],
      );
    }
    if (u && n)
      await this.journal.log(u, 'SPECIALITES_PRIMAIRE', 'affectation', null, {
        affectations: n,
      });
    return { affectations: n };
  }

  /** Personnes du primaire et du préscolaire encore sans spécialité (lots choisis, sinon tous). */
  async sansSpecialite(lotsIds?: number[]) {
    const [r] = await this.affectations.query<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM affectation f
       WHERE f.statut = 'A_TRAITER' AND f."noteId" IS NULL AND f."typeNote" IN ('PRIMAIRE', 'PRESCOLAIRE')
         AND coalesce(trim(f.specialite), '') = ''
         ${lotsIds ? 'AND f."lotPublicationId" = ANY($1)' : ''}`,
      lotsIds ? [lotsIds] : [],
    );
    return r.n;
  }
}
