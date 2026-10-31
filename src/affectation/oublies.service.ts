import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { AnomaliesService } from '../common/anomalies';
import { libelleLot } from '../common/lots';
import { JournalService } from '../core/core.service';
import { Affectation, Agent } from '../entities';
import { AffectationService } from './affectation.service';
import { MOTIF_OUBLI_DEJA_AFFECTE, regleDeLAgent } from './calcul';

/** État d'une personne ajoutée à la main, dans la liste des oubliés. */
export type EtatOubli = 'A_CONTROLER' | 'DEJA_AFFECTE' | 'PAS_AFFECTE';

/**
 * Liste des oubliés (DG, 31/10/2026) : une personne ajoutée à la main dans la base des recrutés
 * (« Ajouter une personne ») est contrôlée avant d'entrer dans une note. Déjà affectée : elle ne
 * rentre dans aucune note ; pas encore affectée : elle rentre dans les notes de son lot ; ou elle
 * est supprimée (ajoutée par erreur).
 */
@Injectable()
export class OubliesService {
  constructor(
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
    @InjectRepository(Affectation)
    private readonly affectations: Repository<Affectation>,
    private readonly affSvc: AffectationService,
    private readonly anomalies: AnomaliesService,
    private readonly journal: JournalService,
  ) {}

  async liste() {
    const fiches = await this.agents.find({
      where: { oubli: Not(IsNull()) },
      order: { creeLe: 'DESC' },
    });
    const regles = await this.affSvc.reglesParCode();
    const affs = new Map(
      (
        await this.affectations.find({
          where: fiches.map((a) => ({ agentId: a.id })),
          loadEagerRelations: false,
        })
      ).map((f) => [f.agentId, f]),
    );
    const ordre: Record<string, number> = {
      A_CONTROLER: 0,
      PAS_AFFECTE: 1,
      DEJA_AFFECTE: 2,
    };
    return fiches
      .map((a) => {
        const r = regleDeLAgent(a, regles);
        const f = affs.get(a.id);
        return {
          id: a.id,
          nomComplet: a.nomComplet,
          dateNaissance: a.dateNaissance,
          liste: a.feuille === 'QUOTA_AUTRES' ? 'Quota « Autres »' : 'MEPPSA',
          diplome: r?.libelle ?? a.diplomeBrut,
          grade: r?.grade ?? null,
          specialite: a.specialite,
          departement: a.departement?.nom ?? null,
          texte: a.numeroTexte,
          typeTexte: a.typeTexte,
          lot: a.lotPublication ? libelleLot(a.lotPublication) : null,
          etat: a.oubli as EtatOubli,
          ajouteLe: a.creeLe,
          ajoutePar: a.saisiePar,
          decidePar: a.oubliPar,
          decideLe: a.oubliLe,
          affectation: f
            ? {
                statut: f.statut,
                dansUneNote: !!f.noteId,
                motif: f.motifExclusion,
              }
            : null,
        };
      })
      .sort((x, y) => ordre[x.etat] - ordre[y.etat]);
  }

  /** Nombre de personnes encore à contrôler (menu, bandeau). */
  async aControler() {
    return this.agents.count({ where: { oubli: 'A_CONTROLER' } });
  }

  private async fiche(id: string) {
    const a = await this.agents.findOne({ where: { id } });
    if (!a || !a.oubli)
      throw new NotFoundException(
        'Personne introuvable dans la liste des oubliés',
      );
    const f = await this.affectations.findOne({
      where: { agentId: id },
      loadEagerRelations: false,
    });
    if (f && (f.statut === 'AFFECTE' || f.noteId))
      throw new BadRequestException(
        `${a.nomComplet} est déjà dans une note validée ou signée : la décision ne peut plus changer. Rouvrez d'abord la note.`,
      );
    return { a, f };
  }

  /** Déjà affectée : hors des notes ; pas encore affectée : dans les notes de son lot. */
  async decider(
    u: UtilisateurConnecte,
    id: string,
    etat: 'DEJA_AFFECTE' | 'PAS_AFFECTE',
    precision?: string,
  ) {
    const { a, f } = await this.fiche(id);
    await this.agents.update(id, {
      oubli: etat,
      oubliPar: u.nom,
      oubliLe: new Date(),
    });
    const texte = precision?.trim();
    if (f) {
      if (etat === 'DEJA_AFFECTE')
        await this.affectations.update(f.id, {
          statut: 'EXCLU',
          motifExclusion: texte
            ? `${MOTIF_OUBLI_DEJA_AFFECTE} : ${texte}`
            : MOTIF_OUBLI_DEJA_AFFECTE,
          traitePar: u.initiales ?? u.nom,
        });
      // Retirée seulement par ce contrôle : elle revient dans les notes
      else if (f.motifExclusion?.startsWith(MOTIF_OUBLI_DEJA_AFFECTE))
        await this.affectations.update(f.id, {
          statut: 'A_TRAITER',
          motifExclusion: null,
        });
    }
    await this.journal.log(
      u,
      etat === 'DEJA_AFFECTE' ? 'OUBLI_DEJA_AFFECTE' : 'OUBLI_PAS_AFFECTE',
      'agent',
      id,
      { nom: a.nomComplet, precision: texte ?? null },
    );
    return { ok: true, etat };
  }

  /** Ajoutée par erreur : la fiche est supprimée définitivement. */
  async supprimer(u: UtilisateurConnecte, id: string) {
    const { a, f } = await this.fiche(id);
    await this.agents.manager.transaction(async (m) => {
      if (f) {
        await m.query(`DELETE FROM recommandation WHERE "affectationId" = $1`, [
          f.id,
        ]);
        await m.delete(Affectation, f.id);
      }
      await m.query(`DELETE FROM reference_note WHERE "agentId" = $1`, [id]);
      await m.query(`DELETE FROM piece_jointe WHERE "agentId" = $1`, [id]);
      await m.query(
        `DELETE FROM doublon_distinct WHERE base = 'RECRUTES' AND (a = $1 OR b = $1)`,
        [id],
      );
      await m.delete(Agent, id);
    });
    // Les fiches qui lui « ressemblaient » ne ressemblent plus à une fiche qui n'existe plus
    await this.anomalies.reconcilier();
    await this.journal.log(u, 'OUBLI_SUPPRIME', 'agent', id, {
      nom: a.nomComplet,
      dateNaissance: a.dateNaissance,
    });
    return { ok: true };
  }
}
