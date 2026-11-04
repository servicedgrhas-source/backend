import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { In, Repository } from 'typeorm';
import { ROLES_TRAITEMENT, type UtilisateurConnecte } from '../auth/auth';
import { posteResponsable } from '../circuit/catalogue';
import { CircuitService } from '../circuit/circuit.service';
import { StockageService } from '../common/stockage';
import { cleCompacte, nettoyer, normaliser } from '../common/texte';
import { JournalService, ParametresService } from '../core/core.service';
import {
  AgentRecense,
  DemandeMutation,
  DemandePrestation,
  Departement,
  InstructionDemande,
  PiecePrestation,
  Structure,
  TypePrestation,
  type EtapeCircuit,
} from '../entities';
import { RecensementService } from '../recensement/recensement.service';
import { type ContexteActe, rendre } from './moteur';
import {
  definition,
  PRESTATIONS,
  type DefinitionPrestation,
} from './definitions';

export interface DepotPrestation {
  type: string;
  objet?: string | null;
  precisions?: string | null;
  details?: Record<string, unknown>;
}

export interface FiltresPrestations {
  onglet?: 'aTraiter' | 'aSuivre' | 'toutes';
  type?: string;
  etat?: string;
  recherche?: string;
}

type Fichier = { libelle: string; f: Express.Multer.File };

const maintenant = () => new Date().toISOString();
/** « P-12 » : le n° des demandes de prestation, distinct de celui des mutations. */
export const reference = (n: number) => `P-${n}`;
const dateFr = (d: string | Date | null) =>
  d
    ? (d instanceof Date ? d.toISOString() : d)
        .slice(0, 10)
        .split('-')
        .reverse()
        .join('/')
    : '';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** Jeton du portail (agent reconnu) : valable 2 heures. */
const DUREE_JETON_MS = 2 * 60 * 60 * 1000;

/** État d'une demande, pour les listes et le portail. */
export function etatDe(d: {
  retiree: boolean;
  decision: string | null;
  circuit: EtapeCircuit[];
  etapeCourante: number | null;
}) {
  if (d.retiree) return 'RETIREE';
  if (d.decision === 'ACCORDEE') return 'ACCORDEE';
  if (d.decision === 'REJETEE') return 'REJETEE';
  if (d.decision === 'EN_INSTANCE') return 'EN_INSTANCE';
  return 'EN_COURS';
}

/**
 * Demandes de prestations, à part des mutations (DG, 02/11/2026) : l'agent doit être dans la base
 * du personnel ; la demande part de sa structure (ou du portail), suit la voie hiérarchique puis
 * le circuit interne de la DGRHAS, avec un avis motivé à chaque niveau (la rétention est
 * proscrite : favorable ou non, le dossier monte), jusqu'à la décision et l'acte.
 */
@Injectable()
export class PrestationsService {
  constructor(
    @InjectRepository(DemandePrestation)
    private readonly demandes: Repository<DemandePrestation>,
    @InjectRepository(PiecePrestation)
    private readonly pieces: Repository<PiecePrestation>,
    @InjectRepository(AgentRecense)
    private readonly agents: Repository<AgentRecense>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    @InjectRepository(Structure)
    private readonly structures: Repository<Structure>,
    @InjectRepository(TypePrestation)
    private readonly types: Repository<TypePrestation>,
    @InjectRepository(InstructionDemande)
    private readonly instructions: Repository<InstructionDemande>,
    private readonly circuit: CircuitService,
    private readonly rec: RecensementService,
    private readonly stockage: StockageService,
    private readonly journal: JournalService,
    private readonly params: ParametresService,
    private readonly config: ConfigService,
  ) {}

  /* ------------------------------ Catalogue ------------------------------ */

  /** Les prestations du module, avec leur circuit lu dans le catalogue (en clair). */
  async catalogue() {
    const reglages = new Map(
      (
        await this.types.find({
          where: { code: In(PRESTATIONS.map((p) => p.code)) },
        })
      ).map((t) => [t.code, t]),
    );
    // Noms des structures de la DGRHAS (« BMP » : Bureau des mouvements du personnel…)
    const noms = new Map(
      (
        await this.structures.find({
          where: {
            type: In([
              'BUREAU_DGRHAS',
              'SERVICE_DGRHAS',
              'DIRECTION_DGRHAS',
              'DGRHAS',
            ]),
          },
          select: ['sigle', 'nom'],
        })
      ).map((s) => [s.sigle, s.nom]),
    );
    return PRESTATIONS.map((p) => ({
      ...p,
      // Signé par le responsable du lieu de service : dit en clair avant le dépôt
      signataire: p.signataire.replace(
        '{decideur.poste}',
        'responsable du lieu de service (chef d’établissement, chef de service…)',
      ),
      circuit: this.circuitEnClair(reglages.get(p.code)).map((e) => ({
        ...e,
        nom: e.phase === 'INTERNE' ? (noms.get(e.libelle) ?? null) : null,
      })),
    }));
  }

  /** « Lieu de service → Inspection (ou direction centrale) → … → DGRHAS » */
  private circuitEnClair(t: TypePrestation | undefined) {
    if (!t) return [];
    const etapes: { phase: 'EXTERNE' | 'INTERNE'; libelle: string }[] = [];
    // Décidée sur place (certificats, attestation de présence) : le lieu de service seul
    if (t.decision === 'LIEU_SERVICE')
      return [{ phase: 'EXTERNE' as const, libelle: 'Lieu de service' }];
    if (t.circuitExterne) {
      etapes.push(
        { phase: 'EXTERNE', libelle: 'Lieu de service' },
        { phase: 'EXTERNE', libelle: 'Inspection (ou direction centrale)' },
        {
          phase: 'EXTERNE',
          libelle:
            t.decision === 'DDEPPSA'
              ? 'Direction départementale (DDEPPSA)'
              : 'DDEPPSA (ou direction générale)',
        },
      );
    }
    if (t.decision === 'DGRHAS')
      for (const s of t.etapesInternes)
        etapes.push({ phase: 'INTERNE', libelle: s });
    return etapes;
  }

  /* ------------------------------ Agent ------------------------------ */

  /** Ce que la fiche du personnel dit de l'agent au moment du dépôt. */
  private async instantane(
    a: AgentRecense,
  ): Promise<DemandePrestation['agent']> {
    const d = a.donnees ?? {};
    const t = (k: string) => nettoyer(d[k]);
    const dep = a.departementId
      ? await this.deps.findOne({ where: { id: a.departementId } })
      : null;
    return {
      nomComplet: a.nomComplet,
      genre: /^F/.test(normaliser(d.GENRE)) ? 'F' : 'M',
      matricule: a.matricule ?? t('MATRICULE_SOLDE'),
      numeroFiche: a.numeroFiche,
      statut: a.statut,
      grade: t('GRADE'),
      categorie: t('CATEGORIE'),
      echelle: t('ECHELLE'),
      echelon: t('ECHELON'),
      fonction: t('FONCTION'),
      lieuService: t('LIEU_SERVICE'),
      ville: t('VILLE'),
      departementId: a.departementId,
      departement: dep?.nom ?? null,
      structureId: a.structureId,
      telephone: a.telephone,
    };
  }

  /** Agent ajouté au recensement mais pas encore accepté (ou rejeté) : pas de demande. */
  private verifierAgent(a: AgentRecense) {
    if (a.contentieux && a.contentieux.etat !== 'CONFIRME')
      throw new BadRequestException(
        a.contentieux.etat === 'REJETE'
          ? 'Cet agent a été rejeté par le DG lors du recensement : il ne peut pas déposer de demande.'
          : 'Cet agent a été ajouté au recensement et n’est pas encore accepté dans la base du personnel (contrôle, puis décision du DG) : il ne peut pas encore déposer de demande.',
      );
  }

  /* ------------------------------ Dépôt ------------------------------ */

  /** Renseignements propres à la prestation, contrôlés et nettoyés. */
  private async details(def: DefinitionPrestation, brut: unknown) {
    const entree = (brut && typeof brut === 'object' ? brut : {}) as Record<
      string,
      unknown
    >;
    const res: Record<string, unknown> = {};
    for (const c of def.champs) {
      const v = entree[c.cle];
      if (c.type === 'departement') {
        const id = Number(v);
        const dep =
          Number.isInteger(id) && id > 0
            ? await this.deps.findOne({ where: { id } })
            : null;
        if (dep) {
          res[c.cle] = dep.id;
          res[`${c.cle}Nom`] = dep.nom;
        }
      } else if (c.type === 'liste') {
        const o = c.options?.find((x) => x.valeur === v);
        if (o) {
          res[c.cle] = o.valeur;
          res[`${c.cle}Libelle`] = o.libelle;
        }
      } else if (c.type === 'date') {
        if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v))
          res[c.cle] = v;
      } else {
        const s = nettoyer(v);
        if (s) res[c.cle] = s.slice(0, c.type === 'zone' ? 1000 : 200);
      }
      if (c.obligatoire && res[c.cle] === undefined)
        throw new BadRequestException(`Renseignez : ${c.libelle}.`);
    }
    // Dates dans l'ordre (AAAA-MM-JJ : l'ordre alphabétique est celui du calendrier)
    for (const o of def.ordreDates ?? []) {
      const avant = res[o.avant] as string | undefined;
      const apres = res[o.apres] as string | undefined;
      if (avant && apres && apres < avant) {
        const lib = (cle: string) =>
          def.champs.find((c) => c.cle === cle)?.libelle ?? cle;
        throw new BadRequestException(
          `Les dates ne sont pas dans l’ordre : « ${lib(o.apres)} » (${apres.split('-').reverse().join('/')}) est avant « ${lib(o.avant)} » (${avant.split('-').reverse().join('/')}).`,
        );
      }
    }
    return res;
  }

  /** Dépôt depuis un compte : la structure de l'agent, la DDEPPSA ou la DGRHAS. */
  async deposerPourAgent(
    u: UtilisateurConnecte,
    agentId: number,
    dto: DepotPrestation,
    fichiers: Fichier[],
  ) {
    const a = await this.rec.trouver(u, agentId);
    return this.creer(u, a, dto, fichiers);
  }

  private async creer(
    par: UtilisateurConnecte | null,
    a: AgentRecense,
    dto: DepotPrestation,
    fichiers: Fichier[],
  ) {
    this.verifierAgent(a);
    const def = definition(dto.type);
    if (!def) throw new BadRequestException('Choisissez la démarche.');
    const details = await this.details(def, dto.details);
    if (!fichiers.some((x) => x.libelle === def.pieces[0].libelle))
      throw new BadRequestException(
        `Joignez au moins « ${def.pieces[0].libelle} » (scan ou photo).`,
      );
    // Une seule demande en cours par agent et par prestation
    const enCours = await this.demandes
      .createQueryBuilder('d')
      .where('d."agentId" = :a AND d.type = :t AND NOT d.retiree', {
        a: a.id,
        t: def.code,
      })
      .andWhere(`(d.decision IS NULL OR d.decision = 'EN_INSTANCE')`)
      .getOne();
    if (enCours)
      throw new BadRequestException(
        `Cet agent a déjà une demande « ${def.libelle} » en cours (n° ${reference(enCours.numero)}) : suivez-la plutôt que d’en déposer une autre.`,
      );
    const agent = await this.instantane(a);
    // Congé de maternité (femmes), de paternité (hommes) : d'après le genre de la fiche
    if (def.pour && agent.genre !== def.pour)
      throw new BadRequestException(
        `« ${def.libelle} » est réservé aux ${def.pour === 'F' ? 'femmes' : 'hommes'}, or la fiche du personnel de cet agent indique ${agent.genre === 'F' ? 'une femme' : 'un homme'}. Si la fiche est fausse, corrigez d’abord le genre dans la fiche.`,
      );
    if (!agent.departementId && !agent.structureId)
      throw new BadRequestException(
        'La fiche de l’agent n’a ni structure ni département : rattachez-le d’abord à sa structure (fiche du personnel), sinon la demande ne sait pas par où passer.',
      );
    // Certificat, attestation de présence : c'est le lieu de service qui décide et signe
    if (!agent.structureId && def.niveauDecision === 'Lieu de service')
      throw new BadRequestException(
        `« ${def.libelle} » est délivré par le lieu de service de l’agent, mais sa fiche n’est rattachée à aucune structure (école, service…). Rattachez-le d’abord à sa structure dans la fiche du personnel.`,
      );
    const c = await this.circuit.construire(def.code, {
      structureId: a.structureId,
      departementOrigineId: a.departementId,
      departementSolliciteId: null,
    });
    await this.stockage.enregistrerTous(
      'justificatifs',
      fichiers.map((x) => x.f),
    );
    try {
      const code = Array.from(
        { length: 6 },
        () => ALPHABET[randomInt(ALPHABET.length)],
      ).join('');
      let d: DemandePrestation | null = null;
      // N° suivant ; deux dépôts au même instant : le second reprend le n° d'après
      for (let essai = 0; !d && essai < 3; essai++) {
        const [r] = await this.demandes.query<{ n: number }[]>(
          `SELECT coalesce(max(numero), 0) + 1 AS n FROM demande_prestation`,
        );
        try {
          d = await this.demandes.save({
            numero: Number(r.n),
            type: def.code,
            agentId: a.id,
            agent,
            objet: nettoyer(dto.objet)?.slice(0, 300) ?? def.objet,
            precisions: nettoyer(dto.precisions)?.slice(0, 2000) ?? null,
            details,
            canal: par ? 'STRUCTURE' : 'PORTAIL',
            codeSuivi: code,
            circuit: c.circuit,
            etapeCourante: c.etapeCourante,
            decideur: c.decideur,
            creePar: par ? par.nom : `${a.nomComplet} (portail)`,
          });
        } catch (e) {
          if (essai === 2) throw e;
        }
      }
      for (const { libelle, f } of fichiers)
        await this.pieces.save({
          demandeId: d!.id,
          libelle: libelle.slice(0, 200),
          nomOrigine: f.originalname.slice(0, 200),
          fichier: f.filename,
          mime: f.mimetype,
          taille: f.size,
          ajoutePar: par ? par.nom : 'Demandeur (portail)',
        });
      await this.circuit.alerter(
        d!.id,
        'NOUVELLE',
        `Nouvelle demande de prestation n° ${reference(d!.numero)} : ${agent.nomComplet} (${def.libelle}). Elle est chez ${c.circuit[0].sigle}.`,
        c.circuit.map((e) => e.structureId).filter((x): x is number => !!x),
      );
      await this.journal.log(
        par,
        par ? 'PRESTATION_DEPOSEE' : 'PRESTATION_PORTAIL',
        'demande_prestation',
        d!.id,
        { type: def.code, pieces: fichiers.length },
      );
      return {
        id: d!.id,
        numero: reference(d!.numero),
        code,
        etape: c.circuit[0].sigle,
      };
    } catch (e) {
      await Promise.all(
        fichiers.map((x) =>
          this.stockage.supprimer('justificatifs', x.f.filename),
        ),
      );
      throw e;
    }
  }

  /* ------------------------------ Accès ------------------------------ */

  private toutVoir(u: UtilisateurConnecte) {
    return u.role === 'ADMIN' || ROLES_TRAITEMENT.includes(u.role);
  }

  /** Voit la demande : DGRHAS, sa structure, une structure du circuit, sa DDEPPSA. */
  private async peutVoir(u: UtilisateurConnecte, d: DemandePrestation) {
    if (this.toutVoir(u)) return true;
    if (u.role === 'DDEPPSA' && u.departementId === d.agent.departementId)
      return true;
    const mes = await this.circuit.structuresDe(u);
    return (
      (!!d.agent.structureId && mes.includes(d.agent.structureId)) ||
      d.circuit.some((e) => !!e.structureId && mes.includes(e.structureId))
    );
  }

  async obtenir(u: UtilisateurConnecte, id: string) {
    const d = /^[0-9a-f-]{36}$/i.test(id)
      ? await this.demandes.findOne({ where: { id } })
      : null;
    if (!d) throw new NotFoundException('Demande introuvable');
    if (!(await this.peutVoir(u, d)))
      throw new ForbiddenException(
        'Cette demande n’est pas passée par votre structure.',
      );
    return d;
  }

  /* ------------------------------ Listes ------------------------------ */

  async liste(u: UtilisateurConnecte, f: FiltresPrestations) {
    const mes = await this.circuit.structuresDe(u);
    const enCircuit = `d."etapeCourante" IS NOT NULL AND NOT d.retiree AND (d.decision IS NULL OR d.decision = 'EN_INSTANCE')`;
    const chezMoi = `(d.circuit -> d."etapeCourante" ->> 'structureId')::int = ANY(:mes)`;
    const perimetre = this.toutVoir(u)
      ? 'TRUE'
      : `((d.agent ->> 'structureId')::int = ANY(:mes)
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(d.circuit) x WHERE (x ->> 'structureId')::int = ANY(:mes))
          ${u.role === 'DDEPPSA' && u.departementId ? `OR (d.agent ->> 'departementId')::int = :dep` : ''})`;
    const conditions: Record<string, string> = {
      aTraiter: `${enCircuit} AND ${chezMoi}`,
      aSuivre: `${perimetre} AND ${enCircuit} AND NOT coalesce(${chezMoi}, false)`,
      toutes: perimetre,
    };
    const valeurs = { mes, dep: u.departementId ?? -1 };
    const compte = async (cond: string) =>
      this.demandes.createQueryBuilder('d').where(cond, valeurs).getCount();
    const onglet = f.onglet ?? 'aTraiter';
    const q = this.demandes
      .createQueryBuilder('d')
      .where(conditions[onglet] ?? conditions.aTraiter, valeurs);
    if (f.type) q.andWhere('d.type = :type', { type: f.type });
    if (f.etat === 'EN_COURS')
      q.andWhere('d.decision IS NULL AND NOT d.retiree');
    else if (f.etat === 'RETIREE') q.andWhere('d.retiree');
    else if (f.etat)
      q.andWhere('d.decision = :etat AND NOT d.retiree', { etat: f.etat });
    const r = normaliser(f.recherche ?? '').replace(/^P-?/, '');
    if (r) {
      if (/^\d+$/.test(r)) q.andWhere('d.numero = :n', { n: Number(r) });
      else
        q.andWhere(
          `translate(upper(d.agent ->> 'nomComplet'), 'ÀÂÄÇÉÈÊËÎÏÔÖÙÛÜ', 'AAACEEEEIIOOUUU') LIKE :r`,
          { r: `%${r}%` },
        );
    }
    const lignes = await q
      .orderBy('d.numero', onglet === 'toutes' ? 'DESC' : 'ASC')
      .take(300)
      .getMany();
    const comptes = {
      aTraiter: await compte(conditions.aTraiter),
      aSuivre: await compte(conditions.aSuivre),
      toutes: await compte(conditions.toutes),
    };
    return {
      onglet,
      compte: comptes,
      lignes: lignes.map((d) => this.ligne(d)),
    };
  }

  private ligne(d: DemandePrestation) {
    const e =
      d.etapeCourante !== null ? (d.circuit[d.etapeCourante] ?? null) : null;
    const depuis = e?.arriveeLe
      ? Math.max(
          0,
          Math.floor((Date.now() - new Date(e.arriveeLe).getTime()) / 864e5),
        )
      : null;
    return {
      id: d.id,
      numero: reference(d.numero),
      type: d.type,
      libelle: definition(d.type)?.libelle ?? d.type,
      nomComplet: d.agent.nomComplet,
      lieuService: d.agent.lieuService,
      departement: d.agent.departement,
      objet: d.objet,
      canal: d.canal,
      etat: etatDe(d),
      etape:
        e && etatDe(d) !== 'ACCORDEE' ? { sigle: e.sigle, nom: e.nom } : null,
      rang: d.etapeCourante,
      etapes: d.circuit.length,
      depuis,
      creeLe: d.creeLe,
    };
  }

  /** Nombre de demandes à traiter par le compte (menu, tableau de bord). */
  async compteur(u: UtilisateurConnecte) {
    const mes = await this.circuit.structuresDe(u);
    if (!mes.length) return { aTraiter: 0 };
    const aTraiter = await this.demandes
      .createQueryBuilder('d')
      .where(
        `d."etapeCourante" IS NOT NULL AND NOT d.retiree AND (d.decision IS NULL OR d.decision = 'EN_INSTANCE')
         AND (d.circuit -> d."etapeCourante" ->> 'structureId')::int = ANY(:mes)`,
        { mes },
      )
      .getCount();
    return { aTraiter };
  }

  /* ------------------------------ Fiche ------------------------------ */

  async fiche(u: UtilisateurConnecte, id: string) {
    const d = await this.obtenir(u, id);
    const def = definition(d.type);
    const pieces = await this.piecesDe(id);
    const fournies = new Set(pieces.map((p) => p.libelle));
    const enCours = etatDe(d) === 'EN_COURS' || etatDe(d) === 'EN_INSTANCE';
    const premiereVisee = !!d.circuit[0]?.visaLe;
    return {
      id: d.id,
      numero: reference(d.numero),
      type: d.type,
      // Avec le circuit en clair (comme dans le catalogue)
      definition:
        (await this.catalogue()).find((p) => p.code === d.type) ?? null,
      agentId: d.agentId,
      agent: d.agent,
      objet: d.objet,
      precisions: d.precisions,
      details: d.details,
      canal: d.canal,
      creePar: d.creePar,
      creeLe: d.creeLe,
      etat: etatDe(d),
      decision: d.decision,
      decisionMotivation: d.decisionMotivation,
      decisionPar: d.decisionPar,
      decisionLe: d.decisionLe,
      motifRetrait: d.motifRetrait,
      circuit: d.circuit,
      etapeCourante: d.etapeCourante,
      pieces,
      manquantes: (def?.pieces ?? [])
        .filter((p) => !fournies.has(p.libelle))
        .map((p) => p.libelle),
      peutAjouterPiece: enCours,
      peutRetirer:
        enCours &&
        (this.toutVoir(u) || (!premiereVisee && (await this.peutAgir(u, d)))),
    };
  }

  /* ------------------------------ Circuit ------------------------------ */

  private async peutAgir(u: UtilisateurConnecte, d: DemandePrestation) {
    if (d.etapeCourante === null || d.retiree) return false;
    if (d.decision && d.decision !== 'EN_INSTANCE') return false;
    const e = d.circuit[d.etapeCourante];
    if (u.role === 'ADMIN') return true;
    const mes = await this.circuit.structuresDe(u);
    return !!e?.structureId && mes.includes(e.structureId);
  }

  /** Avis papier recopié : étape externe sans compte, ou dossier déposé depuis un compte. */
  private async peutRecopier(u: UtilisateurConnecte, d: DemandePrestation) {
    if (d.etapeCourante === null || d.retiree) return false;
    if (d.decision && d.decision !== 'EN_INSTANCE') return false;
    const e = d.circuit[d.etapeCourante];
    if (
      e?.phase !== 'EXTERNE' ||
      !['ADMIN', ...ROLES_TRAITEMENT, 'DG'].includes(u.role)
    )
      return false;
    if (d.canal !== 'PORTAIL') return true;
    return (await this.responsables(d)).mode === 'AUCUN';
  }

  private responsables(d: DemandePrestation) {
    // Le moteur du circuit ne lit que le circuit et l'étape en cours
    return this.circuit.responsables(d as unknown as DemandeMutation);
  }

  /** État du circuit, sous la même forme que pour les mutations (même affichage). */
  async etatCircuit(u: UtilisateurConnecte, id: string) {
    const d = await this.obtenir(u, id);
    const mes = await this.circuit.structuresDe(u);
    const enCours =
      d.etapeCourante !== null &&
      !d.retiree &&
      (!d.decision || d.decision === 'EN_INSTANCE');
    return {
      circuit: d.circuit,
      etapeCourante: d.retiree ? null : d.etapeCourante,
      decideur: d.decideur,
      decision: d.decision,
      decisionMotivation: d.decisionMotivation,
      decisionPar: d.decisionPar,
      decisionLe: d.decisionLe,
      canal: d.canal,
      peutAgir: await this.peutAgir(u, d),
      peutRecopier: await this.peutRecopier(u, d),
      peutSauter:
        enCours &&
        ['DG', 'ADMIN'].includes(u.role) &&
        d.etapeCourante! < d.circuit.length - 1,
      peutInstruire:
        enCours &&
        (['DG', 'ADMIN'].includes(u.role) ||
          d.circuit.some(
            (e, i) =>
              i > d.etapeCourante! &&
              !!e.structureId &&
              mes.includes(e.structureId),
          )),
      responsables: enCours
        ? await this.responsables(d)
        : { mode: 'AUCUN', noms: [], delegations: [] },
      instructions: await this.instructions.find({
        where: { demandeId: id },
        order: { creeLe: 'DESC' },
      }),
    };
  }

  /**
   * Visa et avis motivé à l'étape en cours ; à la dernière, la décision. Favorable ou non, le
   * dossier monte toujours (la rétention est proscrite, N.B. du formulaire).
   */
  async agir(
    u: UtilisateurConnecte,
    id: string,
    dto: {
      avis?: 'FAVORABLE' | 'REJET';
      decision?: 'ACCORDEE' | 'REJETEE' | 'EN_INSTANCE';
      motivation?: string;
      surPapier?: boolean;
    },
  ) {
    const d = await this.obtenir(u, id);
    if (d.retiree) throw new BadRequestException('Demande retirée.');
    if (
      d.etapeCourante === null ||
      (d.decision && d.decision !== 'EN_INSTANCE')
    )
      throw new BadRequestException('La décision est déjà prise.');
    const papier = !!dto.surPapier;
    if (
      papier ? !(await this.peutRecopier(u, d)) : !(await this.peutAgir(u, d))
    )
      throw new ForbiddenException(
        'Ce n’est pas encore à vous de traiter ce dossier : il attend l’avis d’une autre structure.',
      );
    const motivation = dto.motivation?.trim();
    if (!motivation || motivation.length < 3)
      throw new BadRequestException(
        'La motivation est obligatoire, que l’avis soit favorable ou non.',
      );
    const circuit = [...d.circuit];
    const i = d.etapeCourante;
    const derniere = i === circuit.length - 1;
    if (derniere) {
      if (
        !dto.decision ||
        !['ACCORDEE', 'REJETEE', 'EN_INSTANCE'].includes(dto.decision)
      )
        throw new BadRequestException(
          'Choisissez la décision : accordée, rejetée ou en instance.',
        );
    } else if (!dto.avis || !['FAVORABLE', 'REJET'].includes(dto.avis))
      throw new BadRequestException('Choisissez un avis : favorable ou rejet.');
    const e = { ...circuit[i] };
    const par = papier
      ? u.nom
      : await this.circuit.nomDuVisa(u, e.structureId ?? null);
    e.visaPar = papier ? `${u.nom} (recopié du formulaire papier)` : par;
    e.visaLe = maintenant();
    e.avis = derniere
      ? dto.decision === 'ACCORDEE'
        ? 'FAVORABLE'
        : dto.decision === 'REJETEE'
          ? 'REJET'
          : null
      : dto.avis!;
    e.motivation = motivation;
    e.surPapier = papier || undefined;
    circuit[i] = e;
    const maj: Partial<
      Pick<
        DemandePrestation,
        | 'circuit'
        | 'etapeCourante'
        | 'decision'
        | 'decisionMotivation'
        | 'decisionPar'
        | 'decisionLe'
      >
    > = { circuit };
    const def = definition(d.type);
    const ref = `Demande de prestation n° ${reference(d.numero)} (${d.agent.nomComplet}, ${def?.libelle ?? d.type})`;
    if (derniere) {
      Object.assign(maj, {
        decision: dto.decision,
        decisionMotivation: motivation,
        decisionPar: par,
        decisionLe: new Date(),
        etapeCourante: dto.decision === 'EN_INSTANCE' ? i : null,
      });
    } else {
      circuit[i + 1] = { ...circuit[i + 1], arriveeLe: maintenant() };
      maj.etapeCourante = i + 1;
    }
    await this.demandes.update(id, maj);
    if (derniere) {
      await this.circuit.alerter(
        id,
        'DECISION',
        `${ref} : ${dto.decision === 'ACCORDEE' ? 'accordée' : dto.decision === 'REJETEE' ? 'rejetée' : 'mise en instance'} par ${e.sigle}.`,
        circuit.map((x) => x.structureId).filter((x): x is number => !!x),
      );
      // La réponse revient à la structure de l'agent, qui la lui remet
      const origine = [d.agent.structureId, circuit[0]?.structureId].filter(
        (x): x is number => !!x,
      );
      if (origine.length && dto.decision !== 'EN_INSTANCE')
        await this.circuit.alerter(
          id,
          'CLOTURE',
          dto.decision === 'ACCORDEE'
            ? `${ref} : accordée. L’acte (${(def?.acte ?? 'acte').toLowerCase()}) est prêt à imprimer depuis la demande, pour signature puis remise à l’agent.`
            : `${ref} : rejetée. Informez l’agent de la décision et de son motif : « ${motivation} ».`,
          origine,
        );
    } else
      await this.circuit.alerter(
        id,
        'A_TRAITER',
        `${ref} : ${e.sigle} a donné un avis ${e.avis === 'FAVORABLE' ? 'favorable' : 'de rejet'}. C’est à ${circuit[i + 1].sigle} de traiter.`,
        [circuit[i + 1].structureId].filter((x): x is number => !!x),
      );
    await this.journal.log(
      u,
      derniere ? 'DECISION_PRESTATION' : 'AVIS_PRESTATION',
      'demande_prestation',
      id,
      {
        etape: e.sigle,
        avis: e.avis,
        decision: dto.decision ?? null,
        surPapier: papier,
      },
    );
    return { ok: true };
  }

  /** Étape sans responsable (structure fermée…) : le DG la franchit en écrivant pourquoi. */
  async franchir(u: UtilisateurConnecte, id: string, motif: string) {
    if (!['ADMIN', 'DG'].includes(u.role))
      throw new ForbiddenException('Réservé au DG.');
    const d = await this.obtenir(u, id);
    if (d.etapeCourante === null || d.retiree || d.decision)
      throw new BadRequestException('Rien à franchir.');
    const i = d.etapeCourante;
    if (i === d.circuit.length - 1)
      throw new BadRequestException(
        'La dernière étape est la décision : elle ne se franchit pas.',
      );
    if (!motif?.trim())
      throw new BadRequestException(
        'Écrivez pourquoi l’étape est franchie sans avis.',
      );
    const circuit = [...d.circuit];
    circuit[i] = {
      ...circuit[i],
      sautee: motif.trim(),
      visaLe: maintenant(),
      visaPar: u.nom,
    };
    circuit[i + 1] = { ...circuit[i + 1], arriveeLe: maintenant() };
    await this.demandes.update(id, { circuit, etapeCourante: i + 1 });
    await this.circuit.alerter(
      id,
      'A_TRAITER',
      `Demande de prestation n° ${reference(d.numero)} (${d.agent.nomComplet}) : c’est à ${circuit[i + 1].sigle} de traiter.`,
      [circuit[i + 1].structureId].filter((x): x is number => !!x),
    );
    await this.journal.log(u, 'ETAPE_FRANCHIE', 'demande_prestation', id, {
      etape: circuit[i].sigle,
      motif,
    });
    return { ok: true };
  }

  /** Instruction d'un niveau supérieur du circuit (ou du DG) à l'étape en cours. */
  async instruire(
    u: UtilisateurConnecte,
    id: string,
    texte: string,
    echeance: string | null,
  ) {
    const d = await this.obtenir(u, id);
    if (d.etapeCourante === null || d.retiree || d.decision === 'ACCORDEE')
      throw new BadRequestException('Cette demande n’est plus en cours.');
    if (!texte?.trim()) throw new BadRequestException('Écrivez l’instruction.');
    const mes = await this.circuit.structuresDe(u);
    const rang = d.circuit.findIndex(
      (e, i) =>
        i > d.etapeCourante! && !!e.structureId && mes.includes(e.structureId),
    );
    if (rang < 0 && !['DG', 'ADMIN'].includes(u.role))
      throw new ForbiddenException(
        'Seul un supérieur dans le circuit peut donner une instruction.',
      );
    const de =
      rang >= 0
        ? d.circuit[rang].sigle
        : u.role === 'DG'
          ? 'DGRHAS'
          : 'Administration';
    const e = d.circuit[d.etapeCourante];
    const jour =
      echeance && /^\d{4}-\d{2}-\d{2}$/.test(echeance) ? echeance : null;
    await this.instructions.save({
      demandeId: id,
      etape: d.etapeCourante,
      texte: texte.trim().slice(0, 1000),
      echeance: jour,
      par: u.nom,
      parStructure: de,
    });
    await this.circuit.alerter(
      id,
      'INSTRUCTION',
      `Instruction de ${de} pour ${e.sigle} : « ${texte.trim()} »${jour ? ` (pour le ${dateFr(jour)})` : ''} — demande de prestation n° ${reference(d.numero)} (${d.agent.nomComplet}).`,
      [e.structureId].filter((x): x is number => !!x),
    );
    return { ok: true };
  }

  /** Déposée par erreur : retirée du circuit (gardée pour l'historique). */
  async retirer(u: UtilisateurConnecte, id: string, motif: string) {
    const f = await this.fiche(u, id);
    if (!f.peutRetirer)
      throw new ForbiddenException(
        'Seule la DGRHAS, ou la structure qui l’a déposée tant qu’elle ne l’a pas visée, peut retirer cette demande.',
      );
    if (!motif?.trim())
      throw new BadRequestException('Écrivez pourquoi la demande est retirée.');
    await this.demandes.update(id, {
      retiree: true,
      motifRetrait: motif.trim().slice(0, 500),
    });
    await this.journal.log(u, 'PRESTATION_RETIREE', 'demande_prestation', id, {
      motif,
    });
    return { ok: true };
  }

  /* ------------------------------ Pièces ------------------------------ */

  piecesDe(id: string) {
    return this.pieces.find({
      where: { demandeId: id },
      order: { creeLe: 'ASC' },
      select: [
        'id',
        'libelle',
        'nomOrigine',
        'taille',
        'mime',
        'ajoutePar',
        'creeLe',
      ],
    });
  }

  async ajouterPieces(u: UtilisateurConnecte, id: string, fichiers: Fichier[]) {
    const d = await this.obtenir(u, id);
    if (d.retiree || d.decision === 'ACCORDEE' || d.decision === 'REJETEE')
      throw new BadRequestException(
        'La demande est close : on n’y ajoute plus de pièce.',
      );
    if (!fichiers.length) throw new BadRequestException('Aucun fichier reçu.');
    await this.stockage.enregistrerTous(
      'justificatifs',
      fichiers.map((x) => x.f),
    );
    for (const { libelle, f } of fichiers)
      await this.pieces.save({
        demandeId: id,
        libelle: libelle.slice(0, 200),
        nomOrigine: f.originalname.slice(0, 200),
        fichier: f.filename,
        mime: f.mimetype,
        taille: f.size,
        ajoutePar: u.nom,
      });
    await this.journal.log(u, 'PRESTATION_PIECES', 'demande_prestation', id, {
      pieces: fichiers.length,
    });
    return { ok: true };
  }

  async piece(u: UtilisateurConnecte, id: string, pieceId: string) {
    await this.obtenir(u, id);
    const p = /^[0-9a-f-]{36}$/i.test(pieceId)
      ? await this.pieces.findOne({ where: { id: pieceId, demandeId: id } })
      : null;
    if (!p) throw new NotFoundException('Pièce introuvable');
    return p;
  }

  async supprimerPiece(u: UtilisateurConnecte, id: string, pieceId: string) {
    if (!this.toutVoir(u)) throw new ForbiddenException('Réservé à la DGRHAS.');
    const p = await this.piece(u, id, pieceId);
    await this.pieces.delete(p.id);
    await this.stockage.supprimer('justificatifs', p.fichier);
    await this.journal.log(
      u,
      'PRESTATION_PIECE_RETIREE',
      'demande_prestation',
      id,
      {
        libelle: p.libelle,
      },
    );
    return { ok: true };
  }

  /* ------------------------------ Acte ------------------------------ */

  /**
   * Acte proposé (modèle provisoire, en attendant les modèles officiels) : en-tête du ministère,
   * visas, articles, signataire, ampliations. Disponible une fois la demande accordée.
   */
  private async contenuActe(d: DemandePrestation) {
    if (d.decision !== 'ACCORDEE' || d.retiree)
      throw new BadRequestException(
        'L’acte n’est préparé qu’une fois la demande accordée.',
      );
    const def = definition(d.type)!;
    const m = def.acteModele;
    const decideur =
      [...d.circuit].reverse().find((x) => x.visaLe && !x.sautee) ?? null;
    // Structure qui a décidé : son responsable signe (« Directeur d'école », « Proviseur »…)
    const structure = decideur?.structureId
      ? await this.structures.findOne({ where: { id: decideur.structureId } })
      : null;
    const ctx: ContexteActe = {
      agent: d.agent as unknown as ContexteActe['agent'],
      details: d.details,
      champs: def.champs,
      param: (cle) => this.params.get(cle) || null,
      decideur: decideur
        ? {
            sigle: decideur.sigle,
            nom: structure?.nom ?? decideur.nom,
            poste: structure
              ? posteResponsable(structure)
              : 'Responsable de la structure',
          }
        : null,
    };
    const ecrire = (liste: string[]) =>
      liste.map((t) => rendre(t, ctx)).filter((t) => t.length > 0);
    return {
      reference: reference(d.numero),
      acte: def.acte,
      titre: m.titre,
      entete: m.entete,
      prestation: def.libelle,
      objet: d.objet,
      preambule: ecrire(m.preambule),
      formule: m.formule,
      forme: m.forme,
      articles: ecrire(m.articles),
      // Lettre (soit-transmis) : destinataire, objet, appel, et le tableau des pièces du dossier
      lettre: m.lettre
        ? {
            destinataire: rendre(m.lettre.destinataire, ctx),
            objet: rendre(m.lettre.objet, ctx),
            appel: rendre(m.lettre.appel, ctx),
          }
        : null,
      piecesJointes:
        m.forme === 'LETTRE'
          ? [
              ...(await this.piecesDe(d.id)).reduce(
                (n, p) => n.set(p.libelle, (n.get(p.libelle) ?? 0) + 1),
                new Map<string, number>(),
              ),
            ].map(([libelle, nombre]) => ({ libelle, nombre }))
          : [],
      signataire: rendre(def.signataire, ctx)
        .replace(/,$/, '')
        .replace(/^Le ([a-z])/, (_, c: string) => `Le ${c.toUpperCase()}`),
      structure: m.entete === 'STRUCTURE' ? (ctx.decideur?.nom ?? null) : null,
      decideur: decideur
        ? {
            sigle: decideur.sigle,
            nom: decideur.nom,
            par: decideur.visaPar?.replace(/ \(recopié.*\)$/, '') ?? null,
          }
        : null,
      ampliations: ecrire(m.ampliations),
      // Certificat du lieu de service : fait dans la ville de l'agent
      lieu:
        (m.entete === 'STRUCTURE' ? d.agent.ville : null) ||
        this.params.get('LIEU_SIGNATURE') ||
        'Brazzaville',
      decisionLe: d.decisionLe,
      demande: { date: d.creeLe },
    };
  }

  async acte(u: UtilisateurConnecte, id: string) {
    return this.contenuActe(await this.obtenir(u, id));
  }

  /* ------------------------------ Portail ------------------------------ */

  private signer(texte: string) {
    return createHmac(
      'sha256',
      `${this.config.get<string>('JWT_SECRET') ?? ''}:portail-prestations`,
    )
      .update(texte)
      .digest('base64url');
  }

  /**
   * L'agent se fait reconnaître avec un seul champ : son matricule solde OU ses nom et prénoms
   * (le système reconnaît lequel, sans le faire choisir : retour du 03/11/2026, un nom tapé dans la
   * case du matricule n'était pas trouvé), et sa date de naissance. Le nom s'écrit dans n'importe
   * quel ordre, avec ou sans accents ; tous ses mots doivent être dans le nom de la fiche. Il faut
   * une seule fiche, avec cette date de naissance : rien n'est deviné, rien n'est dit de plus.
   */
  async identifier(dto: {
    identifiant?: string;
    matricule?: string;
    nomComplet?: string;
    dateNaissance?: string;
  }) {
    const naissance =
      typeof dto.dateNaissance === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(dto.dateNaissance)
        ? dto.dateNaissance
        : null;
    if (!naissance)
      throw new BadRequestException('Écrivez votre date de naissance.');
    const saisie =
      [dto.identifiant, dto.matricule, dto.nomComplet]
        .map((v) => (typeof v === 'string' ? v : ''))
        .find((v) => v.trim()) ?? '';
    const mat = cleCompacte(saisie);
    const mots = (t: string | null) =>
      normaliser(t ?? '')
        .replace(/[^A-Z0-9]+/g, ' ')
        .split(' ')
        .filter(Boolean);
    const motsSaisis = mots(saisie);
    if (mat.length < 3)
      throw new BadRequestException(
        'Écrivez votre matricule solde, ou vos nom et prénoms.',
      );
    const candidats = await this.agents.find({
      where: { dateNaissance: naissance },
    });
    // D'abord comme un matricule ; sinon comme des nom et prénoms (au moins deux mots)
    const parMatricule = candidats.filter(
      (a) => !!a.matricule && cleCompacte(a.matricule) === mat,
    );
    const parNom =
      motsSaisis.length >= 2
        ? candidats.filter((a) => {
            const m = mots(a.nomComplet);
            return motsSaisis.every((x) => m.includes(x));
          })
        : [];
    const trouves = parMatricule.length ? parMatricule : parNom;
    if (trouves.length !== 1)
      throw new NotFoundException(
        trouves.length
          ? 'Plusieurs fiches correspondent à ce nom et à cette date de naissance : écrivez plutôt votre matricule solde, ou tous vos noms et prénoms.'
          : motsSaisis.length < 2 && !/\d/.test(saisie)
            ? 'Aucune fiche trouvée. Écrivez votre matricule solde, ou au moins deux de vos noms et prénoms (ex. nom et prénom), avec votre date de naissance.'
            : 'Aucune fiche de la base du personnel ne correspond à ce matricule (ou à ce nom) et à cette date de naissance. Vérifiez-les ; sinon, demandez à votre établissement de vérifier votre fiche (recensement).',
      );
    const a = trouves[0];
    this.verifierAgent(a);
    const agent = await this.instantane(a);
    const exp = Date.now() + DUREE_JETON_MS;
    const corps = `${a.id}.${exp}`;
    return {
      jeton: `${corps}.${this.signer(corps)}`,
      agent: {
        nomComplet: agent.nomComplet,
        grade: agent.grade,
        lieuService: agent.lieuService,
        departement: agent.departement,
      },
    };
  }

  private async agentDuJeton(jeton: string) {
    const [id, exp, sig] = (jeton ?? '').split('.');
    const attendu = this.signer(`${id}.${exp}`);
    if (
      !sig ||
      sig.length !== attendu.length ||
      !timingSafeEqual(Buffer.from(sig), Buffer.from(attendu)) ||
      Number(exp) < Date.now()
    )
      throw new BadRequestException(
        'Votre session a expiré : faites-vous reconnaître à nouveau (étape 1).',
      );
    const a = await this.agents.findOne({ where: { id: Number(id) } });
    if (!a) throw new NotFoundException('Fiche introuvable.');
    return a;
  }

  async deposerPortail(
    jeton: string,
    dto: DepotPrestation,
    fichiers: Fichier[],
  ) {
    const a = await this.agentDuJeton(jeton);
    const r = await this.creer(null, a, dto, fichiers);
    return { numero: r.numero, code: r.code, etape: r.etape };
  }

  private async parNumeroCode(numero: string, code: string) {
    const n = Number(normaliser(numero).replace(/^P-?/, ''));
    const d = Number.isInteger(n)
      ? await this.demandes
          .createQueryBuilder('d')
          .addSelect('d.codeSuivi')
          .where('d.numero = :n', { n })
          .getOne()
      : null;
    if (!d || !d.codeSuivi || d.codeSuivi !== (code ?? '').trim().toUpperCase())
      throw new NotFoundException(
        'Aucune demande avec ce numéro et ce code. Vérifiez-les.',
      );
    return d;
  }

  /** Suivi public : les étapes franchies et la décision, sans les avis internes. */
  async suivi(numero: string, code: string) {
    const d = await this.parNumeroCode(numero, code);
    const def = definition(d.type);
    const etat = etatDe(d);
    return {
      numero: reference(d.numero),
      prestation: def?.libelle ?? d.type,
      acte: def?.acte ?? null,
      objet: d.objet,
      date: d.creeLe,
      nomComplet: d.agent.nomComplet,
      etat,
      decisionMotivation:
        etat === 'REJETEE' || etat === 'EN_INSTANCE'
          ? d.decisionMotivation
          : null,
      motifRetrait: d.retiree ? d.motifRetrait : null,
      acteDisponible: etat === 'ACCORDEE',
      etapes: d.circuit.map((e, i) => ({
        sigle: e.sigle,
        nom: e.nom,
        etat: e.visaLe
          ? 'FAITE'
          : i === d.etapeCourante && etat === 'EN_COURS'
            ? 'EN_COURS'
            : 'A_VENIR',
        le: e.visaLe,
      })),
    };
  }

  async actePublic(numero: string, code: string) {
    return this.contenuActe(await this.parNumeroCode(numero, code));
  }
}
