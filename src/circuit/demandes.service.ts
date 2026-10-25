import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ROLES_TRAITEMENT, type UtilisateurConnecte } from '../auth/auth';
import { StockageService } from '../common/stockage';
import { normaliser } from '../common/texte';
import { ParametresService } from '../core/core.service';
import { DemandeMutation } from '../entities';
import {
  MOTIF_PRESTATION,
  MutationService,
  type DemandeDto,
} from '../mutation/mutation.service';
import { RecensementService } from '../recensement/recensement.service';
import { CircuitService } from './circuit.service';

/**
 * Demandes de prestations (DG, réunion de cadrage du 21/10/2026) : l'agent fait sa demande depuis
 * son poste (portail, ou par son chef depuis son compte), elle suit la voie hiérarchique avec la
 * position visible à chaque instant, et se termine par l'acte remis à l'intéressé (autorisation,
 * attestation, certificat…), qu'il peut imprimer lui-même depuis le portail.
 */

export interface DepotDto {
  typePrestation: string;
  objet?: string | null;
  dateDebut?: string | null;
  dateFin?: string | null;
  observation?: string | null;
  /** Mutations seulement. */
  departementSolliciteId?: number | null;
  lieuSollicite?: string | null;
  motif?: string | null;
}

const texte = (v: unknown) =>
  typeof v === 'string' || typeof v === 'number'
    ? String(v).replace(/\s+/g, ' ').trim() || null
    : null;

@Injectable()
export class DemandesService {
  constructor(
    @InjectRepository(DemandeMutation)
    private readonly demandes: Repository<DemandeMutation>,
    private readonly circuit: CircuitService,
    private readonly mutations: MutationService,
    private readonly rec: RecensementService,
    private readonly stockage: StockageService,
    private readonly params: ParametresService,
  ) {}

  /** Types ouverts aux demandes, séparés en mutations et autres prestations. */
  async types() {
    const types = await this.circuit.listeTypes(true);
    return Promise.all(
      types.map(async (t) => ({
        code: t.code,
        libelle: t.libelle,
        acte: t.acte,
        pieces: t.pieces,
        decision: t.decisionTexte ?? t.decision,
        mutation: await this.mutations.estMutation(t.code),
        motif: t.motifMutation,
      })),
    );
  }

  /**
   * Le chef de structure (ou la DGRHAS, la DDEPPSA) dépose la demande d'un de ses agents : la fiche
   * du personnel donne l'identité, le grade et le poste ; le circuit part de sa structure.
   */
  async deposerPourAgent(
    u: UtilisateurConnecte,
    agentId: number,
    dto: DepotDto,
    fichiers: { libelle: string; f: Express.Multer.File }[],
  ) {
    const a = await this.rec.trouver(u, agentId);
    // Agent ajouté au recensement : pas de demande avant son acceptation dans la base
    if (a.contentieux && a.contentieux.etat !== 'CONFIRME')
      throw new BadRequestException(
        a.contentieux.etat === 'REJETE'
          ? 'Cet agent a été rejeté par le DG lors du recensement : il ne peut pas déposer de demande.'
          : 'Cet agent a été ajouté au recensement et n’est pas encore accepté dans la base (contrôle, puis décision du DG) : il ne peut pas encore déposer de demande.',
      );
    const types = await this.types();
    const type = types.find((t) => t.code === dto.typePrestation);
    if (!type)
      throw new BadRequestException('Choisissez le type de la demande.');
    if (!a.structureId && !a.departementId)
      throw new BadRequestException(
        'La fiche de l’agent n’a ni structure ni département : rattachez-le d’abord à sa structure.',
      );
    if (!fichiers.length)
      throw new BadRequestException(
        'Joignez au moins la demande manuscrite de l’agent, scannée ou photographiée.',
      );
    const d = a.donnees;
    const fonction = normaliser(d.FONCTION);
    const demande: DemandeDto = {
      typePrestation: type.code,
      nomComplet: a.nomComplet,
      genre: /^F/.test(normaliser(d.GENRE)) ? 'F' : 'M',
      grade: texte(d.GRADE),
      echelon: Number(texte(d.ECHELON)) || null,
      matricule: a.matricule ?? texte(d.MATRICULE_SOLDE),
      typeAgent: 'FONCTIONNAIRE',
      statutAgent:
        /ENSEIGN|INSTITUT|PROFESS|MAITRE/.test(fonction) || !fonction
          ? 'ENSEIGNANT'
          : 'PERSONNEL_ADMINISTRATIF',
      departementOrigineId: a.departementId,
      structureOrigineId: a.structureId,
      lieuService: texte(d.LIEU_SERVICE),
      cycle: texte(d.CYCLE),
      specialite: texte(d.SPECIALITE),
      datePriseService: texte(d.DATE_PRISE_SERVICE),
      telephone: a.telephone,
      motif: type.mutation
        ? (type.motif ?? texte(dto.motif) ?? '')
        : MOTIF_PRESTATION,
      objet: texte(dto.objet) ?? (type.mutation ? `${type.libelle}` : null),
      dateDebut: texte(dto.dateDebut),
      dateFin: texte(dto.dateFin),
      observation: texte(dto.observation),
      departementSolliciteId: dto.departementSolliciteId ?? null,
      lieuSollicite: texte(dto.lieuSollicite),
      agentId: a.id,
    };
    await this.stockage.enregistrerTous(
      'justificatifs',
      fichiers.map((x) => x.f),
    );
    try {
      return await this.mutations.creerDepuisPortail(demande, fichiers, u);
    } catch (e) {
      await Promise.all(
        fichiers.map((x) =>
          this.stockage.supprimer('justificatifs', x.f.filename),
        ),
      );
      throw e;
    }
  }

  /* ------------------------------ Acte délivré ------------------------------ */

  /** Ce qui s'imprime sur l'acte d'une prestation accordée (les mutations ont leur note de service). */
  private async contenuActe(d: DemandeMutation) {
    if (d.decision !== 'ACCORDEE')
      throw new BadRequestException(
        'L’acte n’est délivré qu’une fois la demande accordée.',
      );
    const type = (await this.types()).find((t) => t.code === d.typePrestation);
    if (!type || type.mutation)
      throw new BadRequestException(
        'Une mutation fait l’objet d’une note de service, pas d’un acte individuel.',
      );
    const circuit = d.circuit ?? [];
    const decideur = [...circuit].reverse().find((e) => e.visaLe) ?? null;
    return {
      numero: `${String(d.numeroEnregistrement).padStart(4, '0')}/${decideur?.sigle ?? 'DGRHAS'}`,
      acte: type.acte ?? 'Attestation',
      prestation: type.libelle,
      agent: {
        nomComplet: d.nomComplet,
        genre: d.genre,
        grade: d.grade,
        echelon: d.echelon,
        matricule: d.matricule,
        lieuService: d.lieuService,
        statut:
          d.statutAgent === 'PERSONNEL_ADMINISTRATIF'
            ? 'Personnel administratif'
            : 'Enseignant',
      },
      objet: d.objet,
      dateDebut: d.dateDebut,
      dateFin: d.dateFin,
      decisionLe: d.decisionLe,
      motivation: d.decisionMotivation,
      decideur: decideur
        ? {
            sigle: decideur.sigle,
            nom: decideur.nom,
            par: decideur.visaPar?.replace(/ \(recopié.*\)$/, '') ?? null,
          }
        : null,
      lieu: this.params.get('LIEU_SIGNATURE'),
      demande: {
        numero: d.numeroEnregistrement,
        date: d.dateEnregistrement,
      },
    };
  }

  /** Acte vu depuis l'application : DGRHAS, et les structures du circuit (ou du département). */
  async acte(u: UtilisateurConnecte, id: string) {
    const d = await this.demandes.findOne({ where: { id } });
    if (!d) throw new NotFoundException('Demande introuvable');
    const toutVoir = u.role === 'ADMIN' || ROLES_TRAITEMENT.includes(u.role);
    if (!toutVoir) {
      const mes = await this.circuit.structuresDe(u);
      const dansCircuit = (d.circuit ?? []).some(
        (e) => !!e.structureId && mes.includes(e.structureId),
      );
      const departement =
        u.role === 'DDEPPSA' && u.departementId === d.departementOrigineId;
      if (!dansCircuit && !departement)
        throw new ForbiddenException(
          'Cette demande n’est pas passée par votre structure.',
        );
    }
    return this.contenuActe(d);
  }

  /** Acte vu par l'agent sur le portail, avec le numéro et le code de sa demande. */
  async actePublic(numero: number, code: string) {
    const d = await this.demandes
      .createQueryBuilder('d')
      .addSelect('d.codeSuivi')
      .where('d.numeroEnregistrement = :numero', { numero })
      .getOne();
    if (!d || !d.codeSuivi || d.codeSuivi !== code.trim().toUpperCase())
      throw new NotFoundException(
        'Aucune demande avec ce numéro et ce code. Vérifiez-les.',
      );
    return this.contenuActe(d);
  }
}
