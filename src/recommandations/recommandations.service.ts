import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import {
  AffectationService,
  etapeInitiale,
} from '../affectation/affectation.service';
import { JournalService } from '../core/core.service';
import {
  DemandeMutation,
  Departement,
  Enrole,
  NoteService,
  Recommandation,
} from '../entities';

/**
 * Recommandations de toutes les opérations (DG, 23/10/2026) : elles modifient ce que la règle donne
 * naturellement (autre département, autre établissement ou lieu). Le chef de service propose, le
 * directeur donne son avis, le DG décide ; une recommandation validée s'applique au dossier et
 * ressort donc sur la note.
 */
export const OPERATIONS: Record<string, string> = {
  AFFECTATION: 'Affectation',
  MUTATION: 'Mutation',
  ENROLEMENT: 'Enrôlement',
};

export interface PropositionDto {
  departementId?: number | null;
  /** Établissement (enrôlement) ou lieu sollicité (mutation). */
  etablissement?: string | null;
  origine: string;
  motif?: string | null;
}

@Injectable()
export class RecommandationsService {
  constructor(
    @InjectRepository(Recommandation)
    private readonly recos: Repository<Recommandation>,
    @InjectRepository(DemandeMutation)
    private readonly demandes: Repository<DemandeMutation>,
    @InjectRepository(Enrole) private readonly enroles: Repository<Enrole>,
    @InjectRepository(NoteService)
    private readonly notes: Repository<NoteService>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    private readonly affectation: AffectationService,
    private readonly journal: JournalService,
  ) {}

  private verifierProposition(dto: PropositionDto) {
    if (!dto.origine?.trim())
      throw new BadRequestException(
        'Dites qui recommande (l’intéressé, une autorité…).',
      );
    if (!dto.departementId && !dto.etablissement?.trim())
      throw new BadRequestException(
        'La recommandation ne change rien : indiquez le département ou le lieu demandé.',
      );
  }

  private async dejaEnAttente(champ: 'demandeId' | 'enroleId', id: string) {
    if (
      await this.recos.exist({ where: { [champ]: id, statut: 'EN_ATTENTE' } })
    )
      throw new BadRequestException(
        'Une recommandation est déjà en attente pour cette personne.',
      );
  }

  /** Mutation : autre département ou autre lieu que ceux demandés. */
  async proposerMutation(
    u: UtilisateurConnecte,
    demandeId: string,
    dto: PropositionDto,
  ) {
    const d = await this.demandes.findOne({ where: { id: demandeId } });
    if (!d) throw new NotFoundException('Demande de mutation introuvable');
    if (d.noteId)
      throw new BadRequestException(
        'Cette mutation est déjà dans une note de service.',
      );
    this.verifierProposition(dto);
    await this.dejaEnAttente('demandeId', demandeId);
    return this.enregistrer(u, {
      operation: 'MUTATION',
      demandeId,
      personne: d.nomComplet,
      departementId: dto.departementId ?? null,
      etablissement: dto.etablissement?.trim() || null,
      origine: dto.origine.trim(),
      motif: dto.motif?.trim() || null,
      avant: {
        departementId: d.departementSolliciteId,
        etablissement: d.lieuSollicite,
      },
    });
  }

  /** Enrôlement : autre département retenu ou autre établissement. */
  async proposerEnrolement(
    u: UtilisateurConnecte,
    enroleId: string,
    dto: PropositionDto,
  ) {
    const e = await this.enroles.findOne({ where: { id: enroleId } });
    if (!e) throw new NotFoundException('Dossier d’enrôlement introuvable');
    await this.verifierNoteOuverte(e);
    this.verifierProposition(dto);
    await this.dejaEnAttente('enroleId', enroleId);
    return this.enregistrer(u, {
      operation: 'ENROLEMENT',
      enroleId,
      personne: e.nomComplet,
      departementId: dto.departementId ?? null,
      etablissement: dto.etablissement?.trim() || null,
      origine: dto.origine.trim(),
      motif: dto.motif?.trim() || null,
      avant: {
        departementId: e.departementRetenuId,
        etablissement: e.etablissement,
      },
    });
  }

  private async verifierNoteOuverte(e: Enrole) {
    if (!e.noteId) return;
    const n = await this.notes.findOne({ where: { id: e.noteId } });
    if (n && ['VALIDEE', 'SIGNEE'].includes(n.statut))
      throw new BadRequestException(
        'Ce volontaire est dans une note déjà validée : le DG doit d’abord la rouvrir.',
      );
  }

  private async enregistrer(
    u: UtilisateurConnecte,
    r: Partial<Recommandation>,
  ) {
    const enr = await this.recos.save({
      ...r,
      statut: 'EN_ATTENTE',
      etape: etapeInitiale(u.role),
      soumisPar: u.nom,
    } as Recommandation);
    await this.journal.log(
      u,
      'RECOMMANDATION_PROPOSEE',
      r.operation === 'MUTATION' ? 'demande_mutation' : 'enrole',
      r.demandeId ?? r.enroleId ?? null,
      { origine: r.origine, motif: r.motif },
    );
    return enr;
  }

  /** Avis du directeur (favorable ou défavorable, motivé) : la recommandation passe au DG. */
  async avis(u: UtilisateurConnecte, id: string, avis: string, motif?: string) {
    if (!['DIRECTEUR', 'ADMIN'].includes(u.role))
      throw new ForbiddenException('L’avis est donné par le directeur.');
    const r = await this.recos.findOne({ where: { id } });
    if (!r) throw new NotFoundException('Recommandation introuvable');
    if (r.statut !== 'EN_ATTENTE' || r.etape !== 'AVIS_DIRECTEUR')
      throw new BadRequestException(
        'Cette recommandation n’attend pas l’avis du directeur.',
      );
    if (!['FAVORABLE', 'DEFAVORABLE'].includes(avis))
      throw new BadRequestException('Avis attendu : favorable ou défavorable.');
    const m = motif?.replace(/\s+/g, ' ').trim();
    if (!m || m.length < 3)
      throw new BadRequestException('Motivez votre avis.');
    await this.recos.update(id, {
      etape: 'DECISION_DG',
      avisDirecteur: {
        avis: avis as 'FAVORABLE' | 'DEFAVORABLE',
        motif: m,
        par: u.nom,
        le: new Date().toISOString(),
      },
    });
    await this.journal.log(u, 'RECOMMANDATION_AVIS', 'recommandation', id, {
      avis,
      motif: m,
    });
    return { ok: true };
  }

  /**
   * Décision du DG. Avant l'avis du directeur, le DG peut décider seul, en le motivant (il en
   * garde la trace) : un dossier ne reste pas bloqué.
   */
  async decider(
    u: UtilisateurConnecte,
    id: string,
    decision: 'VALIDEE' | 'REJETEE',
    commentaire?: string,
  ) {
    const r = await this.recos.findOne({ where: { id } });
    if (!r) throw new NotFoundException('Recommandation introuvable');
    if (r.statut !== 'EN_ATTENTE')
      throw new BadRequestException('Recommandation déjà traitée');
    const c = commentaire?.replace(/\s+/g, ' ').trim() || '';
    if (r.etape === 'AVIS_DIRECTEUR' && c.length < 3)
      throw new BadRequestException(
        'Le directeur n’a pas encore donné son avis : écrivez pourquoi vous décidez sans lui.',
      );
    const note =
      r.etape === 'AVIS_DIRECTEUR'
        ? `${c} (décidé sans l’avis du directeur)`
        : c;
    if (r.operation === 'AFFECTATION')
      return this.affectation.deciderRecommandation(u, id, decision, note);

    if (decision === 'VALIDEE') {
      const ajout = `Recommandation : ${r.origine}`;
      if (r.operation === 'MUTATION') {
        const d = await this.demandes.findOne({ where: { id: r.demandeId! } });
        if (!d) throw new NotFoundException('Demande de mutation introuvable');
        if (d.noteId)
          throw new BadRequestException(
            'Cette mutation est déjà dans une note de service.',
          );
        await this.demandes.update(d.id, {
          ...(r.departementId
            ? { departementSolliciteId: r.departementId }
            : {}),
          ...(r.etablissement ? { lieuSollicite: r.etablissement } : {}),
          origine: [d.origine, ajout].filter(Boolean).join(' ; '),
        });
      } else {
        const e = await this.enroles.findOne({ where: { id: r.enroleId! } });
        if (!e) throw new NotFoundException('Dossier d’enrôlement introuvable');
        await this.verifierNoteOuverte(e);
        await this.enroles.update(e.id, {
          ...(r.departementId ? { departementRetenuId: r.departementId } : {}),
          // Autre département sans établissement précisé : l'ancien établissement ne vaut plus
          ...(r.etablissement
            ? { etablissement: r.etablissement }
            : r.departementId && r.departementId !== e.departementRetenuId
              ? { etablissement: null }
              : {}),
          observation: [e.observation, ajout].filter(Boolean).join(' ; '),
        });
      }
    }
    await this.recos.update(id, {
      statut: decision,
      decidePar: u.nom,
      dateDecision: new Date(),
      commentaireDecision: note || null,
    });
    await this.journal.log(
      u,
      decision === 'VALIDEE'
        ? 'RECOMMANDATION_VALIDEE'
        : 'RECOMMANDATION_REJETEE',
      'recommandation',
      id,
      { operation: r.operation, commentaire: note },
    );
    return { ok: true };
  }

  /** Toutes les recommandations, avec ce qu'elles changent, pour la page et le tableau de bord. */
  async liste(statut?: string, operation?: string, etape?: string) {
    const affectations =
      !operation || operation === 'AFFECTATION'
        ? await this.affectation.listeRecommandations(statut)
        : [];
    const autres = await this.recos.find({
      where: {
        operation:
          operation && operation !== 'AFFECTATION'
            ? operation
            : In(['MUTATION', 'ENROLEMENT']),
        ...(statut ? { statut: statut as Recommandation['statut'] } : {}),
      },
      order: { creeLe: 'DESC' },
      loadEagerRelations: false,
    });
    const deps = new Map((await this.deps.find()).map((d) => [d.id, d.nom]));
    const tout = [
      ...affectations,
      ...(!operation || operation !== 'AFFECTATION'
        ? autres.map((r) => ({
            ...r,
            affectation: null,
            departementPropose: r.departementId
              ? (deps.get(r.departementId) ?? null)
              : null,
            departementAvant: r.avant?.departementId
              ? (deps.get(r.avant.departementId as number) ?? null)
              : null,
          }))
        : []),
    ].filter((r) => !etape || (r.statut === 'EN_ATTENTE' && r.etape === etape));
    return tout.sort(
      (a, b) => new Date(b.creeLe).getTime() - new Date(a.creeLe).getTime(),
    );
  }
}
