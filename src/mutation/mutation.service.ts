import { joursDepuis } from '../common/jours';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, IsNull, Repository } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { champ, lireClasseur, type Ligne } from '../common/excel';
import {
  codeCycle,
  codeDepartement,
  codeMotif,
  groupeDuCycle,
  lireGradeEchelon,
  MOTIFS_MUTATION,
  SEUIL_ANCIENNETE_ANS,
  SPECIALITES_STAT,
  specialiteStat,
  type GroupeMutation,
  type MotifMutation,
} from '../common/referentiels';
import {
  cleCompacte,
  lireDate,
  nettoyer,
  normaliser,
  sansPrefixeNumero,
} from '../common/texte';
import { JournalService } from '../core/core.service';
import { CircuitService } from '../circuit/circuit.service';
import { DemandeMutation, Departement, PieceDemande } from '../entities';

export type EtatMutation =
  | 'EN_CIRCUIT'
  | 'EN_INSTANCE'
  | 'EN_ATTENTE_DDEPPSA'
  | 'EN_ATTENTE_DGRHAS'
  | 'EN_ATTENTE_MINISTRE'
  | 'ACCORDEE'
  | 'REFUSEE'
  | 'RETIREE';

export function etatMutation(d: DemandeMutation): EtatMutation {
  if (d.retiree) return 'RETIREE';
  // Circuit d'approbation : la décision est prise à la dernière étape
  if (d.circuit) {
    if (d.decision === 'ACCORDEE') return 'ACCORDEE';
    if (d.decision === 'REJETEE') return 'REFUSEE';
    if (d.decision === 'EN_INSTANCE') return 'EN_INSTANCE';
    return 'EN_CIRCUIT';
  }
  if (d.instructionMinistre === 'ACCORDEE') return 'ACCORDEE';
  if (d.instructionMinistre === 'REFUSEE') return 'REFUSEE';
  if (d.avisDgrhas) return 'EN_ATTENTE_MINISTRE';
  if (d.avisDdeppsa) return 'EN_ATTENTE_DGRHAS';
  return 'EN_ATTENTE_DDEPPSA';
}

/** Durée dans le poste, en mois, calculée depuis la prise de service si connue. */
export function dureeMois(
  d: Pick<DemandeMutation, 'datePriseService' | 'dureeMois'>,
  aujourdhui = new Date(),
): number | null {
  if (d.datePriseService) {
    const [a, m, j] = d.datePriseService.split('-').map(Number);
    let mois =
      (aujourdhui.getFullYear() - a) * 12 + (aujourdhui.getMonth() + 1 - m);
    if (aujourdhui.getDate() < j) mois--;
    return Math.max(mois, 0);
  }
  return d.dureeMois ?? null;
}

function lireDuree(brut: unknown): number | null {
  const s = normaliser(brut);
  const m = s.match(/(\d+)\s*(ANS?|MOIS)?/);
  if (!m) return null;
  return m[2] === 'MOIS' ? Number(m[1]) : Number(m[1]) * 12;
}

/**
 * N° d'enregistrement écrit dans le fichier : « 1218 », « N° 1218 », « OO57 » (lettre O tapée
 * au lieu du zéro) → 57. Null s'il n'y a pas de numéro lisible.
 */
export function lireNumeroEnregistrement(brut: unknown): number | null {
  if (typeof brut === 'number')
    return Number.isInteger(brut) && brut > 0 ? brut : null;
  if (typeof brut !== 'string') return null;
  const s = brut
    .replace(/^\s*n\s*[°o]\s*/i, '')
    .replace(/[oO]/g, '0')
    .replace(/[\s.]/g, '');
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

export function anomaliesMutation(d: Partial<DemandeMutation>): string[] {
  const a: string[] = [];
  if (!d.departementOrigineId) a.push("Département d'origine non reconnu");
  if (!d.departementSolliciteId) a.push('Département sollicité non reconnu');
  if (
    d.departementOrigineId &&
    d.departementOrigineId === d.departementSolliciteId
  )
    a.push("Département sollicité identique au département d'origine");
  if (d.typeAgent === 'FONCTIONNAIRE' && !d.matricule)
    a.push('Matricule solde non communiqué');
  if (!d.grade) a.push('Grade non renseigné');
  if (!d.cycle) a.push('Cycle non renseigné');
  const duree = dureeMois(d as DemandeMutation);
  if (
    d.motif === 'ANCIENNETE' &&
    (duree === null || duree < SEUIL_ANCIENNETE_ANS * 12)
  )
    a.push(
      `Ancienneté inférieure à ${SEUIL_ANCIENNETE_ANS} ans (ou non renseignée)`,
    );
  if (
    d.motif === 'RAPPROCHEMENT_CONJOINT' &&
    !d.justificatif &&
    !d.justificatifFichier
  )
    a.push('Acte de mariage non fourni');
  if (d.motif === 'PERMUTATION' && !d.permutationAvecId)
    a.push('Agent permutant non désigné');
  return a;
}

export interface DemandeDto {
  dateEnregistrement?: string | null;
  nomComplet: string;
  genre?: 'M' | 'F';
  grade?: string | null;
  echelon?: number | null;
  matricule?: string | null;
  typeAgent?: 'FONCTIONNAIRE' | 'FINALISTE';
  typePrestation?: string | null;
  objet?: string | null;
  structureOrigineId?: number | null;
  structureOrigineTexte?: string | null;
  telephone?: string | null;
  statutAgent?: 'ENSEIGNANT' | 'PERSONNEL_ADMINISTRATIF';
  departementOrigineId?: number | null;
  lieuService?: string | null;
  cycle?: string | null;
  specialite?: string | null;
  datePriseService?: string | null;
  departementSolliciteId?: number | null;
  lieuSollicite?: string | null;
  motif: string;
  justificatif?: string | null;
  permutationAvecId?: string | null;
  origine?: string | null;
  observation?: string | null;
}

@Injectable()
export class MutationService {
  constructor(
    @InjectRepository(DemandeMutation)
    private readonly repo: Repository<DemandeMutation>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    private readonly journal: JournalService,
    private readonly circuit: CircuitService,
    @InjectRepository(PieceDemande)
    private readonly pieces: Repository<PieceDemande>,
  ) {}

  private presenter(d: DemandeMutation) {
    const e =
      d.circuit && d.etapeCourante !== null ? d.circuit[d.etapeCourante] : null;
    return {
      ...d,
      etat: etatMutation(d),
      dureeMoisCalculee: dureeMois(d),
      // Où se trouve le dossier, et depuis combien de jours
      etapeEnCours: e
        ? {
            sigle: e.sigle,
            nom: e.nom,
            rang: d.etapeCourante! + 1,
            etapes: d.circuit!.length,
            depuis: joursDepuis(e.arriveeLe),
          }
        : null,
    };
  }

  /** Comptes des structures (écoles, inspections, DDEPPSA) : seulement les dossiers de leur circuit. */
  private async visibles(
    u: UtilisateurConnecte | undefined,
    liste: DemandeMutation[],
  ) {
    if (!u || !['STRUCTURE', 'DDEPPSA'].includes(u.role)) return liste;
    const mes = await this.circuit.structuresDe(u);
    return liste.filter((d) =>
      d.circuit?.some((e) => !!e.structureId && mes.includes(e.structureId)),
    );
  }

  async liste(f: {
    motif?: string;
    etat?: string;
    departementId?: number;
    recherche?: string;
    groupe?: string;
    u?: UtilisateurConnecte;
  }) {
    const q = this.repo
      .createQueryBuilder('m')
      .leftJoinAndSelect('m.departementOrigine', 'o')
      .leftJoinAndSelect('m.departementSollicite', 's')
      .orderBy('m.numeroEnregistrement', 'DESC');
    if (f.motif) q.andWhere('m.motif = :motif', { motif: f.motif });
    if (f.departementId)
      q.andWhere(
        new Brackets((w) =>
          w
            .where('m.departementOrigineId = :d')
            .orWhere('m.departementSolliciteId = :d'),
        ),
        {
          d: f.departementId,
        },
      );
    if (f.recherche) {
      const r = `%${f.recherche.trim()}%`;
      q.andWhere(
        new Brackets((w) =>
          w
            .where('m.nomComplet ILIKE :r', { r })
            .orWhere('m.matricule ILIKE :r', { r }),
        ),
      );
    }
    let liste = (await this.visibles(f.u, await q.getMany())).map((d) =>
      this.presenter(d),
    );
    if (f.etat) liste = liste.filter((d) => d.etat === f.etat);
    if (f.groupe)
      liste = liste.filter(
        (d) => groupeDuCycle(codeCycle(d.cycle)) === f.groupe,
      );
    return liste;
  }

  async obtenir(id: string, u?: UtilisateurConnecte) {
    const d = await this.repo.findOne({ where: { id } });
    if (!d) throw new NotFoundException('Demande introuvable');
    if (u && !(await this.visibles(u, [d])).length)
      throw new ForbiddenException(
        'Cette demande ne passe pas par votre structure.',
      );
    const permutant = d.permutationAvecId
      ? await this.repo.findOne({ where: { id: d.permutationAvecId } })
      : null;
    return {
      ...this.presenter(d),
      permutant: permutant
        ? { id: permutant.id, nomComplet: permutant.nomComplet }
        : null,
    };
  }

  private async prochainNumero() {
    const [r] = await this.repo.query<{ n: number }[]>(
      `SELECT coalesce(max("numeroEnregistrement"), 0) + 1 AS n FROM demande_mutation`,
    );
    return Number(r.n);
  }

  private normaliserDto(dto: DemandeDto): Partial<DemandeMutation> {
    if (!dto.nomComplet?.trim())
      throw new BadRequestException('Nom et prénoms obligatoires');
    if (!MOTIFS_MUTATION.includes(dto.motif as MotifMutation))
      throw new BadRequestException('Choisissez le motif de la mutation.');
    const t = (v?: string | null) => nettoyer(v);
    const champs: Partial<DemandeMutation> = {
      dateEnregistrement: dto.dateEnregistrement || null,
      nomComplet: dto.nomComplet.trim(),
      genre: dto.genre === 'F' ? 'F' : 'M',
      grade: t(dto.grade),
      echelon: dto.echelon ?? null,
      matricule: t(dto.matricule),
      typeAgent: dto.typeAgent === 'FINALISTE' ? 'FINALISTE' : 'FONCTIONNAIRE',
      statutAgent:
        dto.statutAgent === 'PERSONNEL_ADMINISTRATIF'
          ? 'PERSONNEL_ADMINISTRATIF'
          : 'ENSEIGNANT',
      departementOrigineId: dto.departementOrigineId ?? null,
      lieuService: t(dto.lieuService),
      cycle: codeCycle(dto.cycle) ?? null,
      specialite: t(dto.specialite),
      datePriseService: dto.datePriseService || null,
      departementSolliciteId: dto.departementSolliciteId ?? null,
      lieuSollicite: t(dto.lieuSollicite),
      motif: dto.motif,
      justificatif: t(dto.justificatif),
      permutationAvecId: dto.permutationAvecId || null,
      origine: t(dto.origine),
      observation: t(dto.observation),
      objet: t(dto.objet),
      structureOrigineId: dto.structureOrigineId ?? null,
      structureOrigineTexte: t(dto.structureOrigineTexte),
      telephone: t(dto.telephone),
    };
    return champs;
  }

  /** Type de prestation d'une demande de mutation (choisi, sinon déduit du motif). */
  private typeDe(dto: DemandeDto) {
    const parMotif: Record<string, string> = {
      ANCIENNETE: 'MUTATION_ANCIENNETE',
      RAISONS_SANTE: 'MUTATION_SANTE',
      RAISONS_SOCIALES: 'MUTATION_SOCIALE',
      RAPPROCHEMENT_CONJOINT: 'MUTATION_CONJOINT',
      PERMUTATION: 'PERMUTATION',
    };
    return dto.typePrestation || parMotif[dto.motif] || 'MUTATION_SOCIALE';
  }

  /**
   * Dossier papier reçu à la DGRHAS et saisi ici : il entre au bureau de la DGRHAS (la voie
   * hiérarchique a eu lieu sur papier).
   */
  async creer(u: UtilisateurConnecte, dto: DemandeDto) {
    const champs = this.normaliserDto(dto);
    const numero = await this.prochainNumero();
    const typePrestation = this.typeDe(dto);
    const c = await this.circuit.construire(
      typePrestation,
      {
        structureId: champs.structureOrigineId ?? null,
        departementOrigineId: champs.departementOrigineId ?? null,
        departementSolliciteId: champs.departementSolliciteId ?? null,
      },
      true,
    );
    const d = await this.repo.save({
      ...champs,
      numeroEnregistrement: numero,
      dateEnregistrement:
        champs.dateEnregistrement ?? new Date().toISOString().slice(0, 10),
      cle: `S|${numero}`,
      saisiePar: u.nom,
      anomalies: anomaliesMutation(champs),
      typePrestation,
      canal: 'SAISIE',
      circuit: c.circuit,
      etapeCourante: c.etapeCourante,
      decideur: c.decideur,
    });
    await this.circuit.alerterNouvelle(d);
    await this.lierPermutation(d);
    await this.journal.log(
      u,
      'DEMANDE_MUTATION_CREEE',
      'demande_mutation',
      d.id,
      { motif: d.motif },
    );
    return this.obtenir(d.id);
  }

  private async lierPermutation(d: DemandeMutation) {
    if (d.motif === 'PERMUTATION' && d.permutationAvecId) {
      const autre = await this.repo.findOne({
        where: { id: d.permutationAvecId },
      });
      if (autre && !autre.permutationAvecId) {
        await this.repo.update(autre.id, {
          permutationAvecId: d.id,
          anomalies: anomaliesMutation({ ...autre, permutationAvecId: d.id }),
        });
      }
    }
  }

  private async modifiable(id: string) {
    const d = await this.repo.findOne({ where: { id } });
    if (!d) throw new NotFoundException('Demande introuvable');
    if (d.noteId)
      throw new BadRequestException('Demande déjà dans une note validée');
    return d;
  }

  /** Contrôle avant d'envoyer un fichier au stockage (rien n'est envoyé pour une demande figée). */
  async verifierModifiable(id: string) {
    await this.modifiable(id);
  }

  /** Nom du fichier du justificatif unique actuel (null s'il n'y en a pas). */
  async justificatifActuel(id: string) {
    const d = await this.repo.findOne({ where: { id } });
    const nom = d?.justificatifFichier;
    return nom && nom !== 'pieces' ? nom : null;
  }

  async modifier(u: UtilisateurConnecte, id: string, dto: DemandeDto) {
    const d = await this.modifiable(id);
    if (d.instructionMinistre)
      throw new BadRequestException('Demande déjà tranchée par le Ministre');
    const champs = this.normaliserDto(dto);
    await this.repo.update(id, {
      ...champs,
      anomalies: anomaliesMutation({ ...d, ...champs }),
    });
    await this.lierPermutation({ ...d, ...champs });
    await this.journal.log(
      u,
      'DEMANDE_MUTATION_MODIFIEE',
      'demande_mutation',
      id,
    );
    return this.obtenir(id);
  }

  /**
   * Demande faite par l'agent lui-même sur le portail : elle part de sa structure et suit
   * toute la voie hiérarchique. Renvoie le n° et le code de suivi.
   */
  async creerDepuisPortail(
    dto: DemandeDto,
    fichiers: { libelle: string; f: Express.Multer.File }[],
  ) {
    const champs = this.normaliserDto(dto);
    if (!champs.departementOrigineId)
      throw new BadRequestException('Choisissez votre département actuel.');
    if (!champs.departementSolliciteId)
      throw new BadRequestException('Choisissez le département demandé.');
    if (!fichiers.length)
      throw new BadRequestException(
        'Joignez au moins votre demande manuscrite scannée.',
      );
    const numero = await this.prochainNumero();
    const typePrestation = this.typeDe(dto);
    const c = await this.circuit.construire(typePrestation, {
      structureId: champs.structureOrigineId ?? null,
      departementOrigineId: champs.departementOrigineId,
      departementSolliciteId: champs.departementSolliciteId,
    });
    const code = Array.from(
      { length: 6 },
      () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)],
    ).join('');
    const d = await this.repo.save({
      ...champs,
      numeroEnregistrement: numero,
      dateEnregistrement: new Date().toISOString().slice(0, 10),
      cle: `P|${numero}`,
      saisiePar: `${champs.nomComplet} (portail)`,
      anomalies: anomaliesMutation({
        ...champs,
        justificatifFichier: 'pieces',
      }),
      typePrestation,
      canal: 'PORTAIL',
      codeSuivi: code,
      circuit: c.circuit,
      etapeCourante: c.etapeCourante,
      decideur: c.decideur,
    });
    for (const { libelle, f } of fichiers)
      await this.pieces.save({
        demandeId: d.id,
        libelle,
        nomOrigine: f.originalname.slice(0, 200),
        fichier: f.filename,
        mime: f.mimetype,
        taille: f.size,
        ajoutePar: 'Demandeur (portail)',
      });
    await this.circuit.alerterNouvelle(d);
    await this.journal.log(null, 'DEMANDE_PORTAIL', 'demande_mutation', d.id, {
      type: typePrestation,
      pieces: fichiers.length,
    });
    return { numero, code, etape: c.circuit[0].sigle };
  }

  /** Suivi public : n° + code. Montre les étapes franchies et la décision, sans les avis internes. */
  async suivi(numero: number, code: string) {
    const d = await this.repo
      .createQueryBuilder('d')
      .addSelect('d.codeSuivi')
      .where('d.numeroEnregistrement = :numero', { numero })
      .getOne();
    if (!d || !d.codeSuivi || d.codeSuivi !== code.trim().toUpperCase())
      throw new NotFoundException(
        'Aucune demande avec ce numéro et ce code. Vérifiez-les.',
      );
    return {
      numero: d.numeroEnregistrement,
      date: d.dateEnregistrement,
      objet: d.objet,
      typePrestation: d.typePrestation,
      decision: d.decision,
      decisionMotivation: d.decision ? d.decisionMotivation : null,
      etapes: (d.circuit ?? []).map((e, i) => ({
        sigle: e.sigle,
        nom: e.nom,
        etat:
          i === d.etapeCourante && !d.decision
            ? 'EN_COURS'
            : e.visaLe
              ? 'FAIT'
              : 'A_VENIR',
        date: e.visaLe ?? e.arriveeLe,
      })),
    };
  }

  /* ------------------------- Pièces jointes de la demande ------------------------- */

  async piecesDe(id: string) {
    return this.pieces.find({
      where: { demandeId: id },
      order: { creeLe: 'ASC' },
    });
  }

  async ajouterPieces(
    u: UtilisateurConnecte,
    id: string,
    fichiers: { libelle: string; f: Express.Multer.File }[],
  ) {
    const d = await this.modifiable(id);
    for (const { libelle, f } of fichiers)
      await this.pieces.save({
        demandeId: id,
        libelle,
        nomOrigine: f.originalname.slice(0, 200),
        fichier: f.filename,
        mime: f.mimetype,
        taille: f.size,
        ajoutePar: u.nom,
      });
    await this.repo.update(id, {
      anomalies: anomaliesMutation({
        ...d,
        justificatifFichier: d.justificatifFichier ?? 'pieces',
      }),
    });
    await this.journal.log(u, 'PIECES_AJOUTEES', 'demande_mutation', id, {
      n: fichiers.length,
    });
    return this.piecesDe(id);
  }

  async piece(id: string, pieceId: string) {
    const p = await this.pieces.findOne({
      where: { id: pieceId, demandeId: id },
    });
    if (!p) throw new NotFoundException('Pièce introuvable');
    return p;
  }

  async supprimerPiece(u: UtilisateurConnecte, id: string, pieceId: string) {
    await this.modifiable(id);
    const p = await this.piece(id, pieceId);
    await this.pieces.delete(p.id);
    await this.journal.log(u, 'PIECE_RETIREE', 'demande_mutation', id, {
      libelle: p.libelle,
    });
    return p;
  }

  async enregistrerFichier(u: UtilisateurConnecte, id: string, chemin: string) {
    const d = await this.modifiable(id);
    await this.repo.update(id, {
      justificatifFichier: chemin,
      anomalies: anomaliesMutation({ ...d, justificatifFichier: chemin }),
    });
    await this.journal.log(u, 'JUSTIFICATIF_AJOUTE', 'demande_mutation', id);
  }

  async cheminFichier(id: string) {
    const d = await this.repo.findOne({ where: { id } });
    // « pieces » : la demande a des pièces jointes (liste des pièces), pas de justificatif unique
    if (!d?.justificatifFichier || d.justificatifFichier === 'pieces')
      throw new NotFoundException('Aucun justificatif');
    return d.justificatifFichier;
  }

  async avis(
    u: UtilisateurConnecte,
    id: string,
    niveau: 'DDEPPSA' | 'DGRHAS' | 'MINISTRE',
    valeur: string,
    commentaire?: string,
  ) {
    const d = await this.modifiable(id);
    if (d.circuit)
      throw new BadRequestException(
        'Cette demande suit le circuit d’approbation : donnez votre avis à votre étape du circuit.',
      );
    if (d.retiree) throw new BadRequestException('Demande retirée');
    const c = commentaire?.trim() || null;
    if (niveau === 'DDEPPSA') {
      if (!['FAVORABLE', 'DEFAVORABLE'].includes(valeur))
        throw new BadRequestException('Avis invalide');
      if (u.role === 'DDEPPSA' && u.departementId !== d.departementOrigineId)
        throw new ForbiddenException(
          'Vous ne pouvez donner un avis que pour les agents de votre département',
        );
      if (d.instructionMinistre)
        throw new BadRequestException('Demande déjà tranchée');
      await this.repo.update(id, {
        avisDdeppsa: valeur as 'FAVORABLE',
        avisDdeppsaCommentaire: c,
        avisDdeppsaPar: u.nom,
      });
    } else if (niveau === 'DGRHAS') {
      if (!['FAVORABLE', 'DEFAVORABLE'].includes(valeur))
        throw new BadRequestException('Avis invalide');
      if (d.instructionMinistre)
        throw new BadRequestException('Demande déjà tranchée');
      await this.repo.update(id, {
        avisDgrhas: valeur as 'FAVORABLE',
        avisDgrhasCommentaire: c,
        avisDgrhasPar: u.nom,
      });
    } else {
      if (!['ACCORDEE', 'REFUSEE'].includes(valeur))
        throw new BadRequestException('Instruction invalide');
      if (!d.avisDgrhas)
        throw new BadRequestException(
          "L'avis de la DGRHAS est requis avant l'instruction du Ministre",
        );
      await this.repo.update(id, {
        instructionMinistre: valeur as 'ACCORDEE',
        instructionCommentaire: c,
        instructionPar: u.nom,
      });
    }
    await this.journal.log(u, `AVIS_${niveau}`, 'demande_mutation', id, {
      valeur,
      commentaire: c,
    });
    return this.obtenir(id);
  }

  /**
   * Après la décision du DG, le dossier part au secrétariat du DG, qui imprime la fiche individuelle
   * et les pièces jointes pour les annexer à la note envoyée à la signature du ministre.
   */
  async envoyerSecretariat(u: UtilisateurConnecte, id: string) {
    const d = await this.repo.findOne({ where: { id } });
    if (!d) throw new NotFoundException('Demande introuvable');
    if (d.retiree) throw new BadRequestException('Demande retirée');
    if (d.decision !== 'ACCORDEE' && d.instructionMinistre !== 'ACCORDEE')
      throw new BadRequestException(
        'Seul un dossier accordé peut être envoyé au secrétariat : donnez d’abord la décision.',
      );
    await this.repo.update(id, {
      envoyeSecretariatLe: new Date(),
      envoyeSecretariatPar: u.nom,
    });
    await this.journal.log(
      u,
      'DEMANDE_ENVOYEE_SECRETARIAT',
      'demande_mutation',
      id,
      { numero: d.numeroEnregistrement },
    );
    return this.obtenir(id);
  }

  async retirer(
    u: UtilisateurConnecte,
    id: string,
    motif: string,
    retirer: boolean,
  ) {
    await this.modifiable(id);
    if (retirer && !motif?.trim())
      throw new BadRequestException('Motif du retrait obligatoire');
    await this.repo.update(id, {
      retiree: retirer,
      motifRetrait: retirer ? motif.trim() : null,
    });
    await this.journal.log(
      u,
      retirer ? 'DEMANDE_RETIREE' : 'DEMANDE_REINTEGREE',
      'demande_mutation',
      id,
      { motif },
    );
    return this.obtenir(id);
  }

  /** Demandes accordées, non retirées, pas encore dans une note validée. */
  async eligiblesPourNote(motif: MotifMutation, groupe: GroupeMutation) {
    const liste = await this.repo.find({
      where: {
        motif,
        instructionMinistre: 'ACCORDEE',
        retiree: false,
        noteId: IsNull(),
      },
    });
    return liste.filter(
      (d) =>
        // Mutation dans le département : décidée et notée par le DDEPPSA
        d.decideur !== 'DDEPPSA' &&
        groupeDuCycle(codeCycle(d.cycle)) === groupe &&
        d.departementSolliciteId,
    );
  }

  /* --------------------------- Statistiques --------------------------- */

  /**
   * Demandes déjà enregistrées pour la même personne : même matricule,
   * ou tous les mots du nom saisi présents dans le nom (« X née Y » compris).
   */
  async doublons(nom?: string, matricule?: string, exclure?: string) {
    const mots = normaliser(nom)
      .split(/[^A-Z0-9]+/)
      .filter((m) => m.length >= 2 && m !== 'NEE');
    const mat = cleCompacte(matricule);
    if (mots.length < 2 && mat.length < 4) return [];
    const liste = await this.repo.find({
      order: { numeroEnregistrement: 'DESC' },
    });
    return liste
      .filter((d) => d.id !== exclure)
      .filter((d) => {
        if (mat.length >= 4 && cleCompacte(d.matricule) === mat) return true;
        if (mots.length < 2) return false;
        const cible = normaliser(d.nomComplet).split(/[^A-Z0-9]+/);
        return mots.every((m) => cible.includes(m));
      })
      .slice(0, 5)
      .map((d) => ({
        ...this.presenter(d),
        memeMatricule: mat.length >= 4 && cleCompacte(d.matricule) === mat,
      }));
  }

  async statistiques(base: 'accordees' | 'toutes') {
    const deps = await this.deps.find({ order: { ordre: 'ASC' } });
    let liste = await this.repo.find({ where: { retiree: false } });
    if (base === 'accordees')
      liste = liste.filter((d) => d.instructionMinistre === 'ACCORDEE');

    const lignes: { cycle: string; specialite: string | null }[] = [
      { cycle: 'ADMINISTRATION', specialite: null },
      { cycle: 'PRESCOLAIRE', specialite: null },
      { cycle: 'PRIMAIRE', specialite: null },
      ...SPECIALITES_STAT.COLLEGE.map((s) => ({
        cycle: 'COLLEGE',
        specialite: s,
      })),
      { cycle: 'COLLEGE', specialite: 'AUTRES' },
      ...SPECIALITES_STAT.LYCEE.map((s) => ({ cycle: 'LYCEE', specialite: s })),
      { cycle: 'LYCEE', specialite: 'AUTRES' },
    ];
    const cleLigne = (d: DemandeMutation) => {
      const c =
        d.statutAgent === 'PERSONNEL_ADMINISTRATIF'
          ? 'ADMINISTRATION'
          : (codeCycle(d.cycle) ?? 'ADMINISTRATION');
      if (c === 'COLLEGE' || c === 'LYCEE')
        return `${c}|${specialiteStat(d.specialite)}`;
      return `${c}|`;
    };
    const vide = () =>
      Object.fromEntries(deps.map((dep) => [dep.code, { M: 0, R: 0, E: 0 }]));
    const table = new Map(
      lignes.map((l) => [`${l.cycle}|${l.specialite ?? ''}`, vide()]),
    );
    for (const d of liste) {
      const t = table.get(cleLigne(d));
      if (!t) continue;
      const o = deps.find((x) => x.id === d.departementOrigineId);
      const s = deps.find((x) => x.id === d.departementSolliciteId);
      if (o) t[o.code].M++;
      if (s) t[s.code].R++;
    }
    for (const t of table.values())
      for (const v of Object.values(t)) v.E = v.M - v.R;
    return {
      base,
      total: liste.length,
      departements: deps.map((d) => ({ code: d.code, nom: d.nom })),
      lignes: lignes.map((l) => ({
        ...l,
        valeurs: table.get(`${l.cycle}|${l.specialite ?? ''}`)!,
      })),
    };
  }

  /* ------------------------------ Import ------------------------------ */

  async importer(u: UtilisateurConnecte, contenu: Buffer) {
    const feuilles = await lireClasseur(contenu, ['NOMSETPRENOMS', 'MOTIF']);
    if (!feuilles.length)
      throw new BadRequestException(
        'Aucune feuille visible avec les colonnes « Noms et prénoms » et « Motif évoqué ».',
      );
    // La compilation passe d'abord : elle fait foi. Les feuilles visibles par motif sont lues
    // ensuite pour ne pas perdre les demandes que la compilation n'a pas reprises (fichier du
    // 13/10/2025 : 60 demandes d'ancienneté absentes de COMPIL). Une demande déjà vue (même
    // personne, même motif) n'est jamais lue deux fois ni écrasée.
    const choisies = [...feuilles].sort(
      (a, b) =>
        Number(cleCompacte(b.nom).startsWith('COMPIL')) -
        Number(cleCompacte(a.nom).startsWith('COMPIL')),
    );
    const deps = new Map((await this.deps.find()).map((d) => [d.code, d.id]));
    const existants = new Map((await this.repo.find()).map((d) => [d.cle, d]));

    // Lignes retenues : une par demande (personne + motif), dans l'ordre des feuilles
    const retenues: {
      l: Ligne;
      feuille: string;
      nom: string;
      motif: MotifMutation;
      cle: string;
    }[] = [];
    const parFeuille = new Map(
      choisies.map((f) => [f.nom, { nom: f.nom, lues: 0, retenues: 0 }]),
    );
    const doublonsFichier: string[] = [];
    let ignorees = 0;
    let dejaVues = 0;
    /** Feuille où chaque demande a été retenue. */
    const feuilleDe = new Map<string, string>();
    /**
     * Personnes de la compilation, par département demandé : une feuille par motif peut
     * garder sous « Ancienneté » une demande que la compilation a classée sous un autre
     * motif (même personne, même destination) — ce n'est pas une nouvelle demande.
     */
    const dansCompil = new Set<string>();
    const personne = (nom: string, l: Ligne) =>
      `${normaliser(nom)}|${codeDepartement(champ(l, 'DEPARTEMENTSOLLICITE')) ?? ''}`;
    for (const f of choisies) {
      const compte = parFeuille.get(f.nom)!;
      const estCompil = cleCompacte(f.nom).startsWith('COMPIL');
      for (const l of f.lignes) {
        const nom = nettoyer(champ(l, 'NOMSETPRENOMS'));
        const motif = codeMotif(champ(l, 'MOTIF'));
        if (!nom || !motif) {
          ignorees++;
          continue;
        }
        compte.lues++;
        const cle = `I|${normaliser(nom)}|${motif}`;
        if (feuilleDe.has(cle)) {
          // Même feuille : vraie ligne en double ; autre feuille : demande déjà reprise
          if (feuilleDe.get(cle) === f.nom)
            doublonsFichier.push(`${nom} (${f.nom}, ligne ${l._ligne})`);
          else dejaVues++;
          continue;
        }
        if (estCompil) dansCompil.add(personne(nom, l));
        else if (dansCompil.has(personne(nom, l))) {
          dejaVues++;
          continue;
        }
        feuilleDe.set(cle, f.nom);
        compte.retenues++;
        retenues.push({ l, feuille: f.nom, nom, motif, cle });
      }
    }

    // Numéros : celui du registre quand il est écrit ; sinon le suivant du plus grand
    // numéro connu (base ou fichier), pour ne jamais reprendre un numéro existant.
    const numerosFichier = retenues.map((r) =>
      lireNumeroEnregistrement(champ(r.l, 'NDENREG')),
    );
    let numero =
      Math.max(
        (await this.prochainNumero()) - 1,
        ...numerosFichier.map((n) => n ?? 0),
      ) + 1;
    /** Numéros écrits dans le registre (fichier) : un numéro donné par le système ne doit pas les reprendre. */
    const numerosEcrits = new Set(
      numerosFichier.filter((n): n is number => n !== null),
    );
    const utilises = new Map<number, number>();
    for (const d of existants.values())
      utilises.set(
        d.numeroEnregistrement,
        (utilises.get(d.numeroEnregistrement) ?? 0) + 1,
      );

    const rapport = {
      feuilles: choisies.map((f) => f.nom),
      parFeuille: [...parFeuille.values()],
      lues: retenues.length,
      creees: 0,
      misesAJour: 0,
      ignorees,
      /** Demandes des feuilles par motif déjà présentes dans la compilation. */
      dejaDansCompilation: dejaVues,
      /** Même personne et même motif deux fois dans une feuille : la première ligne est gardée. */
      doublonsFichier,
      numerosAttribues: 0,
      /** Demandes déjà en base dont le numéro a été remis d'accord avec le registre. */
      numerosCorriges: 0,
      /** N° d'enregistrement écrits deux fois (registre papier) : à vérifier. */
      numerosEnDouble: [] as number[],
      anomalies: {} as Record<string, number>,
    };

    for (const [i, { l, nom, motif, cle }] of retenues.entries()) {
      const statutBrut = cleCompacte(sansPrefixeNumero(champ(l, 'STATUT')));
      const obs = nettoyer(champ(l, 'OBS'));
      const { grade, echelon } = lireGradeEchelon(
        champ(l, 'GRADEECHELLON', 'GRADE'),
      );
      const codeO = codeDepartement(champ(l, 'DEPARTEMENTDORIGINE'));
      const codeS = codeDepartement(champ(l, 'DEPARTEMENTSOLLICITE'));
      const matricule = nettoyer(champ(l, 'MATRICULESOLDE', 'MATRICULE'));
      const lieuSollicite = nettoyer(champ(l, 'LIEUSOLLICITE', 'PERMUTATION'));
      const champs: Partial<DemandeMutation> = {
        dateEnregistrement: lireDate(champ(l, 'DATEDENREG')),
        nomComplet: nom,
        genre:
          /\bNEE\b/.test(normaliser(nom)) || statutBrut.includes('ACTIVE')
            ? 'F'
            : 'M',
        grade,
        echelon,
        gradeBrut: nettoyer(champ(l, 'GRADEECHELLON', 'GRADE')),
        matricule:
          matricule && cleCompacte(matricule) !== 'X' ? matricule : null,
        typeAgent: cleCompacte(obs).includes('FINALISTE')
          ? 'FINALISTE'
          : 'FONCTIONNAIRE',
        statutAgent:
          statutBrut.startsWith('PERSONNEL') || statutBrut === 'PA'
            ? 'PERSONNEL_ADMINISTRATIF'
            : 'ENSEIGNANT',
        departementOrigineId: codeO ? deps.get(codeO)! : null,
        lieuService: nettoyer(champ(l, 'LIEUDESERVICE')),
        cycle: codeCycle(champ(l, 'CYCLE')),
        specialite: nettoyer(champ(l, 'SPECIALITE')),
        dureeMois: lireDuree(champ(l, 'DUREE')),
        departementSolliciteId: codeS ? deps.get(codeS)! : null,
        lieuSollicite:
          cleCompacte(lieuSollicite) === 'PERMUTE' ? null : lieuSollicite,
        motif,
        justificatif: nettoyer(champ(l, 'JUSTIFICATIF', 'REFACTEDEMARIAGE')),
        origine: nettoyer(champ(l, 'ORIGINE')),
        observation: obs,
      };
      champs.anomalies = anomaliesMutation(champs);
      for (const a of champs.anomalies)
        rapport.anomalies[a] = (rapport.anomalies[a] ?? 0) + 1;
      const ex = existants.get(cle);
      if (ex) {
        if (ex.noteId || ex.instructionMinistre) continue;
        // Demande importée avant cette version : son numéro peut venir de l'ancienne
        // numérotation (1, 2, 3…), qui reprenait des numéros du registre. Le registre fait foi ;
        // sinon, un numéro repris par erreur est remplacé par un numéro libre.
        const ecrit = numerosFichier[i];
        const ancien = ex.numeroEnregistrement;
        let nouveau: number | null = null;
        if (ecrit !== null && ecrit !== ancien) nouveau = ecrit;
        else if (
          ecrit === null &&
          ex.canal !== 'PORTAIL' &&
          numerosEcrits.has(ancien)
        )
          nouveau = numero++;
        if (nouveau !== null) {
          utilises.set(ancien, (utilises.get(ancien) ?? 1) - 1);
          utilises.set(nouveau, (utilises.get(nouveau) ?? 0) + 1);
          champs.numeroEnregistrement = nouveau;
          ex.numeroEnregistrement = nouveau;
          rapport.numerosCorriges++;
        }
        await this.repo.update(ex.id, champs);
        rapport.misesAJour++;
      } else {
        let n = numerosFichier[i];
        if (n === null) {
          n = numero++;
          rapport.numerosAttribues++;
        }
        utilises.set(n, (utilises.get(n) ?? 0) + 1);
        const nouvelle = await this.repo.save({
          ...champs,
          cle,
          numeroEnregistrement: n,
          saisiePar: u.nom,
        });
        existants.set(cle, nouvelle);
        rapport.creees++;
      }
    }
    rapport.numerosEnDouble = [...utilises]
      .filter(([, fois]) => fois > 1)
      .map(([n]) => n)
      .sort((a, b) => a - b);
    await this.journal.log(
      u,
      'IMPORT_MUTATIONS',
      'demande_mutation',
      null,
      rapport,
    );
    await this.circuit.mettreEnCircuit();
    return rapport;
  }
}
