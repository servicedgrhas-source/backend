import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { chiffrerCode, nouveauCode } from '../common/code-personnel';
import { JournalService } from '../core/core.service';
import {
  Alerte,
  AlerteLue,
  DemandeMutation,
  Departement,
  InstructionDemande,
  Structure,
  TypePrestation,
  Utilisateur,
  type EtapeCircuit,
} from '../entities';
import {
  CATALOGUE,
  CYCLES_STRUCTURE,
  STRUCTURES_DGRHAS,
  TYPES_LOCALITE,
  NIVEAU_FIN_CIRCUIT,
  posteResponsable,
  TYPES_STRUCTURE,
} from './catalogue';
import { joursDepuis, SQL_AUJOURDHUI, sqlJourLocal } from '../common/jours';

/* --------- Requêtes du travail de chacun ($1 : structures du compte) --------- */

/** Étape en cours d'une demande (objet JSON). */
const SQL_ETAPE = `(d.circuit -> d."etapeCourante")`;
/** Arrivée à l'étape en cours. */
const SQL_ARRIVEE = `(${SQL_ETAPE} ->> 'arriveeLe')::timestamptz`;
/** Demande en route dans son circuit (ni décidée, ni retirée, ni déjà dans une note). */
const SQL_EN_CIRCUIT = `d."etapeCourante" IS NOT NULL AND d.circuit IS NOT NULL AND NOT d.retiree AND d."noteId" IS NULL`;
/** L'étape en cours est chez le compte. */
const SQL_CHEZ_MOI = `(${SQL_ETAPE} ->> 'structureId')::int = ANY($1)`;
const SQL_A_TRAITER = `(${SQL_EN_CIRCUIT} AND ${SQL_CHEZ_MOI})`;
/** Le compte intervient plus loin dans le circuit (et le dossier n'est pas déjà chez lui). */
const SQL_A_SUIVRE = `(${SQL_EN_CIRCUIT} AND NOT coalesce(${SQL_CHEZ_MOI}, false) AND EXISTS (
  SELECT 1 FROM jsonb_array_elements(d.circuit) WITH ORDINALITY e(x, n)
   WHERE e.n - 1 > d."etapeCourante" AND (e.x ->> 'structureId')::int = ANY($1)))`;
/** Plus de 7 jours (du calendrier) à l'étape en cours. */
const SQL_EN_RETARD = `${sqlJourLocal(`${SQL_ETAPE} ->> 'arriveeLe'`)} < ${SQL_AUJOURDHUI} - 7`;
/** Alerte adressée à une des structures du compte. */
const SQL_ALERTE_A_MOI = `EXISTS (SELECT 1 FROM jsonb_array_elements(a.structures) x WHERE (x)::int = ANY($1))`;
/** État d'une demande : décision du circuit, sinon instruction reprise des anciens dossiers. */
// IS NOT DISTINCT FROM : toujours vrai ou faux, jamais « inconnu » (NULL) avec des champs vides,
// sinon NOT (…) écarterait la demande de tous les comptes
const SQL_ETAT_ACCORDEE = `(d.decision IS NOT DISTINCT FROM 'ACCORDEE' OR (d.decision IS NULL AND d."instructionMinistre" IS NOT DISTINCT FROM 'ACCORDEE'))`;
const SQL_ETAT_REFUSEE = `(d.decision IS NOT DISTINCT FROM 'REJETEE' OR (d.decision IS NULL AND d."instructionMinistre" IS NOT DISTINCT FROM 'REFUSEE'))`;

export interface FiltresDossiers {
  onglet?: 'aTraiter' | 'aSuivre';
  recherche?: string;
  type?: string;
  etape?: string;
  retard?: boolean;
  page?: number;
  taille?: number;
}

interface LigneDossier {
  id: string;
  numero: number;
  nomComplet: string;
  objet: string | null;
  typePrestation: string | null;
  canal: string;
  decision: string | null;
  etapeCourante: number;
  etapes: number;
  etape: EtapeCircuit | null;
}

const maintenant = () => new Date().toISOString();

/** Rôle qui agit à une étape interne quand le compte n'est rattaché à aucune structure. */
const ROLE_PAR_TYPE: Record<string, string[]> = {
  BUREAU_DGRHAS: ['AGENT'],
  SERVICE_DGRHAS: ['CHEF_SERVICE'],
  DIRECTION_DGRHAS: ['DIRECTEUR', 'BUREAU_ETUDES'],
  DGRHAS: ['DG'],
};

/** Type de mutation selon le motif (demandes saisies ou importées avant le catalogue). */
const TYPE_PAR_MOTIF: Record<string, string> = {
  ANCIENNETE: 'MUTATION_ANCIENNETE',
  RAISONS_SANTE: 'MUTATION_SANTE',
  RAISONS_SOCIALES: 'MUTATION_SOCIALE',
  RAPPROCHEMENT_CONJOINT: 'MUTATION_CONJOINT',
  PERMUTATION: 'PERMUTATION',
};

export interface OrigineCircuit {
  structureId: number | null;
  departementOrigineId: number | null;
  departementSolliciteId: number | null;
}

/**
 * Circuit d'approbation des demandes : voie hiérarchique (externe), circuit interne de la
 * DGRHAS, avis motivés, décision, alertes et instructions.
 */
@Injectable()
export class CircuitService implements OnModuleInit {
  private readonly log = new Logger('Circuit');

  constructor(
    @InjectRepository(Structure)
    private readonly structures: Repository<Structure>,
    @InjectRepository(TypePrestation)
    private readonly types: Repository<TypePrestation>,
    @InjectRepository(DemandeMutation)
    private readonly demandes: Repository<DemandeMutation>,
    @InjectRepository(Alerte) private readonly alertes: Repository<Alerte>,
    @InjectRepository(AlerteLue) private readonly lues: Repository<AlerteLue>,
    @InjectRepository(InstructionDemande)
    private readonly instructions: Repository<InstructionDemande>,
    @InjectRepository(Utilisateur)
    private readonly users: Repository<Utilisateur>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    private readonly journal: JournalService,
  ) {}

  /* ---------------------- Mise en place au démarrage ---------------------- */

  async onModuleInit() {
    // Structures internes de la DGRHAS
    const existantes = new Map(
      (await this.structures.find()).map((s) => [`${s.type}|${s.sigle}`, s]),
    );
    const parSigle = new Map<string, Structure>();
    for (const d of STRUCTURES_DGRHAS) {
      let s = existantes.get(`${d.type}|${d.sigle}`);
      if (!s) {
        s = await this.structures.save({
          type: d.type,
          sigle: d.sigle,
          nom: d.nom,
          parentId: d.parent ? (parSigle.get(d.parent)?.id ?? null) : null,
        });
      }
      parSigle.set(d.sigle, s);
    }
    // Intitulés corrigés à la demande du DG (« SR » → « Service de recrutement ») : aussi dans les
    // circuits déjà enregistrés, qui gardent une copie du nom de chaque étape
    for (const [ancien, nouveau] of [
      ['Service SR (intitulé à compléter)', 'Service de recrutement'],
    ]) {
      await this.structures.update({ nom: ancien }, { nom: nouveau });
      await this.demandes.query(
        `UPDATE demande_mutation SET circuit = replace(circuit::text, $1, $2)::jsonb WHERE circuit::text LIKE '%' || $1 || '%'`,
        [ancien, nouveau],
      );
    }
    await this.demandes.query(
      `UPDATE demande_mutation SET objet = regexp_replace(objet, '(rapprochement de conjoint)($|[^s])', '\\1s\\2', 'gi') WHERE objet ~* 'rapprochement de conjoint($|[^s])'`,
    );
    await this.demandes.query(
      `UPDATE type_prestation SET libelle = 'Mutation pour rapprochement de conjoints' WHERE libelle ~* 'rapprochement de conjoint$'`,
    );
    // Une DDEPPSA par département
    for (const dep of await this.deps.find()) {
      if (
        !(await this.structures.exist({
          where: { type: 'DDEPPSA', departementId: dep.id },
        }))
      )
        await this.structures.save({
          type: 'DDEPPSA',
          sigle: `DDEPPSA ${dep.nom}`,
          nom: `Direction départementale de l’enseignement préscolaire, primaire, secondaire et de l’alphabétisation (${dep.nom})`,
          departementId: dep.id,
        });
    }
    // Catalogue des prestations (les types déjà là gardent les réglages du DG)
    const codes = new Set(
      (await this.types.find({ select: ['code'] })).map((t) => t.code),
    );
    const manquants = CATALOGUE.filter((t) => !codes.has(t.code));
    if (manquants.length) await this.types.save(manquants);
    // Demandes enregistrées avant les circuits : elles entrent au bureau de la DGRHAS
    await this.mettreEnCircuit();
  }

  /** Demandes sans circuit (enregistrées avant, ou importées d'Excel) : entrée au bureau de la DGRHAS. */
  async mettreEnCircuit() {
    const anciennes = await this.demandes
      .createQueryBuilder('d')
      .where('d.circuit IS NULL')
      .getMany();
    if (!anciennes.length) return;
    const types = new Map((await this.types.find()).map((t) => [t.code, t]));
    for (const d of anciennes) {
      const code =
        d.typePrestation ?? TYPE_PAR_MOTIF[d.motif] ?? 'MUTATION_SOCIALE';
      const type = types.get(code)!;
      const circuit: EtapeCircuit[] = [];
      const date = d.dateEnregistrement ?? d.creeLe.toISOString().slice(0, 10);
      const ddeppsa = d.departementOrigineId
        ? await this.structures.findOne({
            where: { type: 'DDEPPSA', departementId: d.departementOrigineId },
          })
        : null;
      if (d.avisDdeppsa && ddeppsa)
        circuit.push({
          ...this.etape('EXTERNE', ddeppsa, date),
          visaPar: d.avisDdeppsaPar ?? 'DDEPPSA',
          visaLe: date,
          avis: d.avisDdeppsa === 'FAVORABLE' ? 'FAVORABLE' : 'REJET',
          motivation:
            d.avisDdeppsaCommentaire ??
            'Avis repris de l’ancien enregistrement',
          surPapier: true,
        });
      for (const sigle of type.etapesInternes) {
        const s = await this.structures.findOne({
          where: {
            sigle,
            type: In([
              'BUREAU_DGRHAS',
              'SERVICE_DGRHAS',
              'DIRECTION_DGRHAS',
              'DGRHAS',
            ]),
          },
        });
        if (s) circuit.push(this.etape('INTERNE', s, null));
      }
      const premierInterne = circuit.findIndex((e) => e.phase === 'INTERNE');
      if (premierInterne >= 0) circuit[premierInterne].arriveeLe = date;
      let courante: number | null = premierInterne >= 0 ? premierInterne : null;
      // Avis DGRHAS ou instruction déjà donnés : on reprend où on en était
      if (d.avisDgrhas || d.instructionMinistre) {
        const dernier = circuit.length - 1;
        for (let i = premierInterne; i < dernier; i++)
          circuit[i].sautee = 'Enregistrée avant les circuits d’approbation';
        circuit[dernier] = {
          ...circuit[dernier],
          arriveeLe: date,
          visaPar: d.avisDgrhasPar ?? d.instructionPar,
          visaLe: date,
          avis:
            (d.avisDgrhas ??
              (d.instructionMinistre === 'ACCORDEE'
                ? 'FAVORABLE'
                : 'DEFAVORABLE')) === 'FAVORABLE'
              ? 'FAVORABLE'
              : 'REJET',
          motivation:
            d.avisDgrhasCommentaire ??
            d.instructionCommentaire ??
            'Avis repris de l’ancien enregistrement',
        };
        courante = d.instructionMinistre ? null : dernier;
      }
      await this.demandes.update(d.id, {
        typePrestation: code,
        canal: d.canal ?? 'IMPORT',
        circuit,
        etapeCourante: courante,
        decideur: 'DGRHAS',
        decision:
          d.instructionMinistre === 'ACCORDEE'
            ? 'ACCORDEE'
            : d.instructionMinistre === 'REFUSEE'
              ? 'REJETEE'
              : null,
        decisionMotivation: d.instructionCommentaire,
        decisionPar: d.instructionPar,
      });
    }
    this.log.log(
      `${anciennes.length} demande(s) existante(s) mises dans le circuit (bureau de la DGRHAS).`,
    );
  }

  private etape(
    phase: 'EXTERNE' | 'INTERNE',
    s: Structure,
    arriveeLe: string | null,
  ): EtapeCircuit {
    return {
      phase,
      structureId: s.id,
      type: s.type,
      sigle: s.sigle,
      nom: s.nom,
      arriveeLe,
      visaPar: null,
      visaLe: null,
      avis: null,
      motivation: null,
    };
  }

  /* ------------------------------ Organigramme ------------------------------ */

  /** Toutes les structures, avec leur niveau, le poste de responsable et qui l'occupe. */
  async listeStructures() {
    const [liste, responsables] = await Promise.all([
      this.structures.find({
        order: { ordre: 'ASC', type: 'ASC', sigle: 'ASC' },
      }),
      this.structures.query<{ id: number; nom: string }[]>(
        `SELECT a.id, a."nomComplet" AS nom FROM agent_recense a WHERE a.id IN (SELECT "responsableId" FROM structure WHERE "responsableId" IS NOT NULL)`,
      ),
    ]);
    const noms = new Map(responsables.map((r) => [r.id, r.nom]));
    // Seulement ce que lisent l'organigramme et les listes de choix (3 000 structures et plus)
    return liste.map((s) => ({
      id: s.id,
      type: s.type,
      sigle: s.sigle,
      nom: s.nom,
      parentId: s.parentId,
      departementId: s.departementId,
      cycle: s.cycle,
      typeLocalite: s.typeLocalite,
      localite: s.localite,
      actif: s.actif,
      responsableInterim: s.responsableInterim,
      niveau: TYPES_STRUCTURE[s.type]?.niveau ?? null,
      posteResponsable: posteResponsable(s),
      responsable: s.responsableId
        ? { id: s.responsableId, nom: noms.get(s.responsableId) ?? '?' }
        : null,
    }));
  }

  /**
   * Compte du responsable d'une structure (chef d'établissement, inspecteur, chef de service…) :
   * rôle « Responsable de structure », rattaché à sa structure. Le mot de passe provisoire et le
   * code personnel ne sont montrés qu'ici, à remettre à la personne.
   */
  async compteResponsable(
    u: UtilisateurConnecte,
    id: number,
    emailDonne?: string | null,
  ) {
    const s = await this.structures.findOne({ where: { id } });
    if (!s) throw new NotFoundException('Structure introuvable');
    if (!s.responsableId)
      throw new BadRequestException(
        'Désignez d’abord le responsable en poste.',
      );
    const [a] = await this.structures.query<
      { nom: string; mail: string | null }[]
    >(
      `SELECT "nomComplet" AS nom, donnees->>'MAIL' AS mail FROM agent_recense WHERE id = $1`,
      [s.responsableId],
    );
    if (!a) throw new BadRequestException('Fiche du responsable introuvable.');
    const email = (emailDonne || a.mail || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      throw new BadRequestException(
        'Indiquez l’adresse e-mail du responsable (elle sert d’identifiant).',
      );
    if (await this.users.exist({ where: { email } }))
      throw new BadRequestException(
        'Un compte existe déjà avec cette adresse : modifiez-le dans Administration › Utilisateurs.',
      );
    const motDePasse = `${randomBytes(6).toString('base64url')}-${Math.floor(100 + Math.random() * 900)}`;
    const code = nouveauCode();
    const compte = await this.users.save({
      email,
      nom: a.nom,
      initiales: null,
      role: 'STRUCTURE',
      departementId: s.departementId,
      structureId: s.id,
      actif: true,
      motDePasseHash: await bcrypt.hash(motDePasse, 10),
      codeChiffre: chiffrerCode(code),
      codeCreeLe: new Date(),
    });
    await this.journal.log(
      u,
      'CREATION_UTILISATEUR',
      'utilisateur',
      compte.id,
      {
        email,
        role: 'STRUCTURE',
        structure: s.sigle,
      },
    );
    return { email, nom: a.nom, motDePasse, code, structure: s.nom };
  }

  /** Responsable en poste (ou intérim) ; vide : poste vacant. */
  async nommerResponsable(
    u: UtilisateurConnecte,
    id: number,
    agentId: number | null,
    interim: boolean,
  ) {
    const s = await this.structures.findOne({ where: { id } });
    if (!s) throw new NotFoundException('Structure introuvable');
    let nom: string | null = null;
    if (agentId) {
      const [a] = await this.structures.query<{ nom: string }[]>(
        `SELECT "nomComplet" AS nom FROM agent_recense WHERE id = $1`,
        [agentId],
      );
      if (!a)
        throw new BadRequestException(
          'Agent introuvable dans la base du personnel.',
        );
      nom = a.nom;
    }
    s.responsableId = agentId || null;
    s.responsableInterim = !!agentId && interim;
    await this.structures.save(s);
    await this.journal.log(
      u,
      'STRUCTURE_RESPONSABLE',
      'structure',
      String(id),
      {
        sigle: s.sigle,
        poste: posteResponsable(s),
        responsable: nom,
        interim: s.responsableInterim,
      },
    );
    return { ok: true };
  }

  /** Structures du même niveau : même structure supérieure (ou, à la racine, même type et département). */
  private async freres(s: Structure) {
    const tous = await this.structures.find({
      where: s.parentId
        ? { parentId: s.parentId }
        : {
            parentId: IsNull(),
            type: s.type,
            departementId: s.departementId ?? IsNull(),
          },
      order: { ordre: 'ASC', type: 'ASC', sigle: 'ASC' },
    });
    return tous;
  }

  /** Monte ou descend une structure d'un rang parmi celles du même niveau. */
  async deplacerStructure(
    u: UtilisateurConnecte,
    id: number,
    sens: 'haut' | 'bas',
  ) {
    const s = await this.structures.findOne({ where: { id } });
    if (!s) throw new NotFoundException('Structure introuvable');
    const freres = await this.freres(s);
    const i = freres.findIndex((x) => x.id === id);
    const j = sens === 'haut' ? i - 1 : i + 1;
    if (j < 0 || j >= freres.length)
      throw new BadRequestException(
        sens === 'haut'
          ? 'Elle est déjà en premier.'
          : 'Elle est déjà en dernier.',
      );
    [freres[i], freres[j]] = [freres[j], freres[i]];
    // Rangs renumérotés 1, 2, 3… : l'ordre affiché reste stable
    for (const [k, x] of freres.entries())
      if (x.ordre !== k + 1)
        await this.structures.update(x.id, { ordre: k + 1 });
    await this.journal.log(u, 'STRUCTURE_DEPLACEE', 'structure', String(id), {
      sigle: s.sigle,
      sens,
    });
    return { ok: true };
  }

  /** Structures proposées sur le portail (voie hiérarchique seulement). */
  structuresPubliques() {
    return this.structures.find({
      where: {
        actif: true,
        type: In([
          'ETABLISSEMENT',
          'INSPECTION',
          'DDEPPSA',
          'SERVICE',
          'BUREAU',
          'DIRECTION_CENTRALE',
          'DIRECTION_GENERALE',
          'INSPECTION_GENERALE',
          'CABINET',
        ]),
      },
      select: ['id', 'type', 'sigle', 'nom', 'parentId', 'departementId'],
      order: { nom: 'ASC' },
    });
  }

  async enregistrerStructure(
    u: UtilisateurConnecte,
    id: number | null,
    dto: {
      type: string;
      nom: string;
      sigle?: string | null;
      parentId?: number | null;
      departementId?: number | null;
      cycle?: string | null;
      typeLocalite?: string | null;
      localite?: string | null;
      actif?: boolean;
    },
  ) {
    if (!TYPES_STRUCTURE[dto.type])
      throw new BadRequestException('Type de structure inconnu.');
    const nom = dto.nom?.replace(/\s+/g, ' ').trim();
    if (!nom) throw new BadRequestException('Écrivez le nom de la structure.');
    if (dto.parentId && dto.parentId === id)
      throw new BadRequestException(
        'Une structure ne peut pas être sa propre structure supérieure.',
      );
    const parent = dto.parentId
      ? await this.structures.findOne({ where: { id: dto.parentId } })
      : null;
    const valeurs = {
      type: dto.type,
      nom,
      sigle: dto.sigle?.trim() || nom,
      parentId: parent?.id ?? null,
      // Le département se reprend de la structure supérieure s'il n'est pas donné
      departementId: dto.departementId ?? parent?.departementId ?? null,
      cycle: CYCLES_STRUCTURE[dto.cycle ?? ''] ? dto.cycle! : null,
      typeLocalite: TYPES_LOCALITE[dto.typeLocalite ?? '']
        ? dto.typeLocalite!
        : null,
      localite: dto.localite?.replace(/\s+/g, ' ').trim() || null,
      actif: dto.actif ?? true,
    };
    const s = id
      ? await this.structures.save({
          ...(await this.structures.findOneOrFail({ where: { id } })),
          ...valeurs,
        })
      : await this.structures.save({
          ...valeurs,
          // Nouvelle structure : à la fin de son niveau
          ordre:
            (await this.freres({ ...valeurs, id: 0 } as Structure)).reduce(
              (m, x) => Math.max(m, x.ordre),
              0,
            ) + 1,
        });
    await this.journal.log(
      u,
      id ? 'STRUCTURE_MODIFIEE' : 'STRUCTURE_AJOUTEE',
      'structure',
      String(s.id),
      { type: s.type, sigle: s.sigle },
    );
    return s;
  }

  async supprimerStructure(u: UtilisateurConnecte, id: number) {
    if (await this.structures.exist({ where: { parentId: id } }))
      throw new BadRequestException(
        'Cette structure a des structures rattachées : déplacez-les ou désactivez-la.',
      );
    const [{ n }] = await this.structures.query<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM agent_recense WHERE "structureId" = $1`,
      [id],
    );
    if (n)
      throw new BadRequestException(
        `${n} agent(s) de la base du personnel y sont rattachés : désactivez-la plutôt.`,
      );
    if (await this.users.exist({ where: { structureId: id } }))
      throw new BadRequestException(
        'Des comptes sont rattachés à cette structure : désactivez-la plutôt.',
      );
    const s = await this.structures.findOne({ where: { id } });
    if (!s) throw new NotFoundException('Structure introuvable');
    await this.structures.delete(id);
    await this.journal.log(u, 'STRUCTURE_SUPPRIMEE', 'structure', String(id), {
      sigle: s.sigle,
    });
    return { ok: true };
  }

  /* ------------------------------- Catalogue ------------------------------- */

  listeTypes(actifs = false) {
    return this.types.find({
      where: actifs ? { actif: true } : {},
      order: { ordre: 'ASC' },
    });
  }

  async modifierType(
    u: UtilisateurConnecte,
    code: string,
    dto: Partial<
      Pick<
        TypePrestation,
        | 'libelle'
        | 'pieces'
        | 'circuitExterne'
        | 'etapesInternes'
        | 'decision'
        | 'actif'
      >
    >,
  ) {
    const t = await this.types.findOne({ where: { code } });
    if (!t) throw new NotFoundException('Type de prestation introuvable');
    if (
      dto.decision &&
      !['LIEU_SERVICE', 'DDEPPSA', 'DGRHAS'].includes(dto.decision)
    )
      throw new BadRequestException('Niveau de décision invalide.');
    if (dto.actif && !t.code.startsWith('MUTATION') && t.code !== 'PERMUTATION')
      throw new BadRequestException(
        'Pour l’instant, seules les demandes de mutation sont ouvertes.',
      );
    if (dto.etapesInternes) {
      const connues = new Set(
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
          })
        ).map((s) => s.sigle),
      );
      const inconnues = dto.etapesInternes.filter((x) => !connues.has(x));
      if (inconnues.length)
        throw new BadRequestException(
          `Sigle(s) absent(s) de l’organigramme : ${inconnues.join(', ')}.`,
        );
    }
    Object.assign(t, {
      ...dto,
      pieces: dto.pieces?.map((p) => p.trim()).filter(Boolean) ?? t.pieces,
    });
    await this.types.save(t);
    await this.journal.log(
      u,
      'TYPE_PRESTATION_MODIFIE',
      'type_prestation',
      code,
      { actif: t.actif, decision: t.decision },
    );
    return t;
  }

  /* ------------------------- Construction du circuit ------------------------- */

  /**
   * Circuit d'une demande : la voie hiérarchique depuis la structure de l'agent, puis, si
   * la DGRHAS décide, ses étapes internes. Une mutation à l'intérieur du département est
   * décidée par le DDEPPSA.
   */
  async construire(codeType: string, o: OrigineCircuit, papier = false) {
    const type = await this.types.findOne({ where: { code: codeType } });
    if (!type) throw new BadRequestException('Type de demande inconnu.');
    const memeDepartement =
      !!o.departementOrigineId &&
      o.departementOrigineId === o.departementSolliciteId;
    const decideur =
      type.decision === 'DGRHAS' &&
      memeDepartement &&
      type.code !== 'PERMUTATION'
        ? 'DDEPPSA'
        : type.decision === 'LIEU_SERVICE'
          ? 'LIEU_SERVICE'
          : type.decision;
    const arrivee = maintenant();
    const circuit: EtapeCircuit[] = [];

    // Voie hiérarchique : de la structure de l'agent jusqu'au DDEPPSA ou à la direction générale
    if (type.circuitExterne && !papier) {
      const vus = new Set<number>();
      let s = o.structureId
        ? await this.structures.findOne({ where: { id: o.structureId } })
        : null;
      while (s && !vus.has(s.id)) {
        vus.add(s.id);
        circuit.push(this.etape('EXTERNE', s, null));
        // Jusqu'au DDEPPSA ou à la direction générale (pas au cabinet ni au ministère)
        if (
          s.type === 'DDEPPSA' ||
          (TYPES_STRUCTURE[s.type]?.niveau ?? 9) <= NIVEAU_FIN_CIRCUIT
        )
          break;
        if (decideur === 'LIEU_SERVICE') break;
        s = s.parentId
          ? await this.structures.findOne({ where: { id: s.parentId } })
          : null;
      }
      const centrale = circuit.some(
        (e) =>
          TYPES_STRUCTURE[e.type]?.perimetre === 'CENTRAL' ||
          TYPES_STRUCTURE[e.type]?.perimetre === 'POLITIQUE',
      );
      if (
        !centrale &&
        decideur !== 'LIEU_SERVICE' &&
        !circuit.some((e) => e.type === 'DDEPPSA')
      ) {
        const dd = o.departementOrigineId
          ? await this.structures.findOne({
              where: { type: 'DDEPPSA', departementId: o.departementOrigineId },
            })
          : null;
        if (dd) circuit.push(this.etape('EXTERNE', dd, null));
      }
    }
    if (decideur === 'DDEPPSA' && !circuit.some((e) => e.type === 'DDEPPSA')) {
      const dd = o.departementOrigineId
        ? await this.structures.findOne({
            where: { type: 'DDEPPSA', departementId: o.departementOrigineId },
          })
        : null;
      if (!dd)
        throw new BadRequestException('Indiquez le département d’origine.');
      circuit.push(this.etape('EXTERNE', dd, null));
    }
    if (decideur === 'DGRHAS')
      for (const sigle of type.etapesInternes) {
        const s = await this.structures.findOne({
          where: {
            sigle,
            type: In([
              'BUREAU_DGRHAS',
              'SERVICE_DGRHAS',
              'DIRECTION_DGRHAS',
              'DGRHAS',
            ]),
          },
        });
        if (s) circuit.push(this.etape('INTERNE', s, null));
      }
    if (!circuit.length)
      throw new BadRequestException(
        'Le circuit de cette demande est vide : vérifiez l’organigramme.',
      );
    circuit[0].arriveeLe = arrivee;
    return { circuit, decideur, etapeCourante: 0 };
  }

  /* ---------------------------- Qui peut agir ? ---------------------------- */

  /** Structures dont le compte voit les dossiers (la sienne, ou celles de son rôle). */
  /**
   * Structures dont le compte voit et traite les dossiers : les siennes, plus celles des
   * collègues absents qui lui ont donné délégation (jusqu'à la date de fin).
   */
  async structuresDe(u: UtilisateurConnecte): Promise<number[]> {
    const propres = await this.structuresPropres(u);
    const titulaires = await this.delegationsRecues(u.id);
    const autres: number[] = [];
    for (const t of titulaires)
      autres.push(...(await this.structuresPropres(this.profil(t))));
    return [...new Set([...propres, ...autres])];
  }

  /** Comptes absents qui ont donné délégation à ce compte, encore valable aujourd'hui. */
  async delegationsRecues(id: string) {
    const aujourdhui = new Date().toISOString().slice(0, 10);
    return (
      await this.users.find({ where: { delegueId: id, actif: true } })
    ).filter((t) => !!t.delegationFin && t.delegationFin >= aujourdhui);
  }

  private profil(t: Utilisateur): UtilisateurConnecte {
    return {
      id: t.id,
      email: t.email,
      nom: t.nom,
      initiales: t.initiales,
      role: t.role,
      departementId: t.departementId,
      structureId: t.structureId,
    };
  }

  private async structuresPropres(u: UtilisateurConnecte): Promise<number[]> {
    const compte = await this.users.findOne({ where: { id: u.id } });
    if (compte?.structureId) return [compte.structureId];
    if (u.role === 'DDEPPSA' && u.departementId)
      return (
        await this.structures.find({
          where: { type: 'DDEPPSA', departementId: u.departementId },
        })
      ).map((s) => s.id);
    const types = Object.entries(ROLE_PAR_TYPE)
      .filter(([, roles]) => roles.includes(u.role))
      .map(([t]) => t);
    if (u.role === 'ADMIN')
      return (await this.structures.find({ select: ['id'] })).map((s) => s.id);
    if (!types.length) return [];
    return (
      await this.structures.find({ where: { type: In(types) }, select: ['id'] })
    ).map((s) => s.id);
  }

  /** Le compte peut-il viser et donner son avis à l'étape en cours ? */
  async peutAgir(u: UtilisateurConnecte, d: DemandeMutation) {
    if (d.etapeCourante === null || !d.circuit || d.retiree || d.noteId)
      return false;
    const e = d.circuit[d.etapeCourante];
    if (u.role === 'ADMIN') return true;
    const mes = await this.structuresDe(u);
    return !!e.structureId && mes.includes(e.structureId);
  }

  /**
   * Avis porté sur papier (cachet et visa du formulaire) recopié par la DGRHAS : seulement
   * pour une étape externe dont la structure n'a pas de compte, ou un dossier papier.
   */
  async peutRecopier(u: UtilisateurConnecte, d: DemandeMutation) {
    if (d.etapeCourante === null || !d.circuit || d.retiree) return false;
    const e = d.circuit[d.etapeCourante];
    if (
      e.phase !== 'EXTERNE' ||
      ![
        'ADMIN',
        'AGENT',
        'CHEF_SERVICE',
        'DIRECTEUR',
        'BUREAU_ETUDES',
        'DG',
      ].includes(u.role)
    )
      return false;
    if (d.canal !== 'PORTAIL') return true;
    // Demande en ligne : seulement si personne ne peut viser à cette étape (aucun compte)
    return (await this.responsables(d)).mode === 'AUCUN';
  }

  /* --------------------------------- Agir --------------------------------- */

  /**
   * Visa et avis motivé à l'étape en cours. Favorable ou non, le dossier monte toujours :
   * la rétention est proscrite. À la dernière étape, c'est la décision.
   */
  async agir(
    u: UtilisateurConnecte,
    id: string,
    dto: {
      avis?: 'FAVORABLE' | 'REJET';
      decision?: 'ACCORDEE' | 'REJETEE' | 'EN_INSTANCE';
      motivation: string;
      surPapier?: boolean;
    },
  ) {
    const d = await this.demandes.findOne({ where: { id } });
    if (!d) throw new NotFoundException('Demande introuvable');
    if (d.noteId)
      throw new BadRequestException('Demande déjà dans une note validée.');
    if (d.retiree) throw new BadRequestException('Demande retirée.');
    if (d.etapeCourante === null || !d.circuit)
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
    const e = { ...circuit[i] };
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

    // Visé par délégation : on le note (« X, par délégation de Y »)
    let par = u.nom;
    if (
      !papier &&
      u.role !== 'ADMIN' &&
      e.structureId &&
      !(await this.structuresPropres(u)).includes(e.structureId)
    )
      for (const t of await this.delegationsRecues(u.id))
        if (
          (await this.structuresPropres(this.profil(t))).includes(e.structureId)
        ) {
          par = `${u.nom}, par délégation de ${t.nom}`;
          break;
        }
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

    const maj: Partial<DemandeMutation> = { circuit };
    // Compatibilité : avis DDEPPSA et DGRHAS (statistiques, fiche, notes)
    if (e.type === 'DDEPPSA' && e.avis)
      Object.assign(maj, {
        avisDdeppsa: e.avis === 'FAVORABLE' ? 'FAVORABLE' : 'DEFAVORABLE',
        avisDdeppsaCommentaire: motivation,
        avisDdeppsaPar: e.visaPar,
      });
    if (e.type === 'DGRHAS' && e.avis)
      Object.assign(maj, {
        avisDgrhas: e.avis === 'FAVORABLE' ? 'FAVORABLE' : 'DEFAVORABLE',
        avisDgrhasCommentaire: motivation,
        avisDgrhasPar: e.visaPar,
      });

    let texteAlerte: string;
    let destinataires: number[];
    if (derniere) {
      Object.assign(maj, {
        decision: dto.decision,
        decisionMotivation: motivation,
        decisionPar: par,
        decisionLe: new Date(),
        etapeCourante: dto.decision === 'EN_INSTANCE' ? i : null,
        instructionMinistre:
          dto.decision === 'ACCORDEE'
            ? 'ACCORDEE'
            : dto.decision === 'REJETEE'
              ? 'REFUSEE'
              : null,
        instructionCommentaire: motivation,
        instructionPar: u.nom,
      });
      texteAlerte = `Demande n° ${d.numeroEnregistrement} (${d.nomComplet}) : ${dto.decision === 'ACCORDEE' ? 'accordée' : dto.decision === 'REJETEE' ? 'rejetée' : 'mise en instance'} par ${e.sigle}.`;
      destinataires = circuit
        .map((x) => x.structureId)
        .filter((x): x is number => !!x);
    } else {
      circuit[i + 1] = { ...circuit[i + 1], arriveeLe: maintenant() };
      maj.etapeCourante = i + 1;
      texteAlerte = `Demande n° ${d.numeroEnregistrement} (${d.nomComplet}) : ${e.sigle} a donné un avis ${e.avis === 'FAVORABLE' ? 'favorable' : 'de rejet'}. C’est à ${circuit[i + 1].sigle} de traiter.`;
      destinataires = [circuit[i + 1].structureId].filter(
        (x): x is number => !!x,
      );
    }
    await this.demandes.update(id, maj);
    await this.alerter(
      id,
      derniere ? 'DECISION' : 'A_TRAITER',
      texteAlerte,
      destinataires,
    );
    await this.journal.log(
      u,
      derniere ? 'DECISION_DEMANDE' : 'AVIS_CIRCUIT',
      'demande_mutation',
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

  /** Une étape sans responsable (structure fermée…) : la DGRHAS la franchit en le justifiant. */
  async sauter(u: UtilisateurConnecte, id: string, motif: string) {
    const d = await this.demandes.findOne({ where: { id } });
    if (!d?.circuit || d.etapeCourante === null)
      throw new BadRequestException('Rien à franchir.');
    if (!['ADMIN', 'DG'].includes(u.role))
      throw new ForbiddenException('Réservé au DG.');
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
    await this.alerter(
      id,
      'A_TRAITER',
      `Demande n° ${d.numeroEnregistrement} (${d.nomComplet}) : c’est à ${circuit[i + 1].sigle} de traiter.`,
      [circuit[i + 1].structureId!].filter(Boolean),
    );
    await this.journal.log(u, 'ETAPE_FRANCHIE', 'demande_mutation', id, {
      etape: circuit[i].sigle,
      motif,
    });
    return { ok: true };
  }

  /* -------------------------- Alertes et instructions -------------------------- */

  async alerter(
    demandeId: string,
    type: string,
    texte: string,
    structures: number[],
  ) {
    await this.alertes.save({
      demandeId,
      type,
      texte,
      structures: [...new Set(structures)],
    });
  }

  /** À l'arrivée d'une demande : tout le circuit est prévenu, et la première étape doit traiter. */
  async alerterNouvelle(d: DemandeMutation) {
    const tous = (d.circuit ?? [])
      .map((e) => e.structureId)
      .filter((x): x is number => !!x);
    await this.alerter(
      d.id,
      'NOUVELLE',
      `Nouvelle demande n° ${d.numeroEnregistrement} : ${d.nomComplet} (${d.objet ?? 'mutation'}). Elle est chez ${d.circuit?.[0]?.sigle}.`,
      tous,
    );
  }

  async instruire(
    u: UtilisateurConnecte,
    id: string,
    texte: string,
    echeance: string | null,
  ) {
    const d = await this.demandes.findOne({ where: { id } });
    if (!d?.circuit || d.etapeCourante === null)
      throw new BadRequestException('Cette demande n’est plus en cours.');
    if (!texte?.trim()) throw new BadRequestException('Écrivez l’instruction.');
    // Seul un niveau au-dessus de l'étape en cours (ou le DG) donne une instruction
    const mes = await this.structuresDe(u);
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
    await this.instructions.save({
      demandeId: id,
      etape: d.etapeCourante,
      texte: texte.trim(),
      echeance: echeance || null,
      par: u.nom,
      parStructure: de,
    });
    await this.alerter(
      id,
      'INSTRUCTION',
      `Instruction de ${de} pour ${e.sigle} : « ${texte.trim()} »${echeance ? ` (pour le ${echeance.split('-').reverse().join('/')})` : ''} — demande n° ${d.numeroEnregistrement} (${d.nomComplet}).`,
      [e.structureId!].filter(Boolean),
    );
    await this.journal.log(u, 'INSTRUCTION_DEMANDE', 'demande_mutation', id, {
      pour: e.sigle,
      echeance,
    });
    return { ok: true };
  }

  instructionsDe(id: string) {
    return this.instructions.find({
      where: { demandeId: id },
      order: { creeLe: 'DESC' },
    });
  }

  /* ------------------------------ Alertes ------------------------------ */

  /**
   * Alertes du compte : celles de ses structures (et de ses délégations). Une alerte plus
   * ancienne que le compte compte comme lue : un nouvel arrivant ne trouve pas des
   * centaines d'alertes passées « non lues ».
   * Liste par pages de 50 (de la plus récente à la plus ancienne) ; `avant` : suite.
   */
  async mesAlertes(u: UtilisateurConnecte, avant?: number) {
    const mes = await this.structuresDe(u);
    if (!mes.length) return { nonLues: 0, alertes: [], suite: false };
    const PAGE = 50;
    const lignes: (Alerte & { lue: boolean })[] = await this.alertes.query(
      `SELECT a.id, a."demandeId", a.type, a.texte, a.structures, a."creeLe",
              (l."alerteId" IS NOT NULL OR a."creeLe" < u."creeLe") AS lue
         FROM alerte a
         JOIN utilisateur u ON u.id = $2
    LEFT JOIN alerte_lue l ON l."alerteId" = a.id AND l."utilisateurId" = $2
        WHERE ${SQL_ALERTE_A_MOI}
          AND ($3::int IS NULL OR a.id < $3)
     ORDER BY a.id DESC
        LIMIT ${PAGE + 1}`,
      [mes, u.id, avant ?? null],
    );
    const suite = lignes.length > PAGE;
    const page = lignes.slice(0, PAGE);
    // Une alerte raconte ce qui s'est passé ; on y joint où en est la demande aujourd'hui
    const demandes = new Map(
      (page.length
        ? await this.demandes.find({
            where: { id: In([...new Set(page.map((a) => a.demandeId))]) },
            select: ['id', 'retiree', 'decision', 'circuit', 'etapeCourante'],
          })
        : []
      ).map((d) => [d.id, d]),
    );
    const aujourdhui = (id: string) => {
      const d = demandes.get(id);
      if (!d) return 'Demande supprimée';
      if (d.retiree) return 'Demande retirée';
      if (d.decision === 'ACCORDEE') return 'Accordée';
      if (d.decision === 'REJETEE') return 'Rejetée';
      if (d.decision === 'EN_INSTANCE') return 'Mise en instance';
      if (d.circuit && d.etapeCourante !== null)
        return `En cours : chez ${d.circuit[d.etapeCourante]?.sigle ?? '?'}`;
      return null;
    };
    return {
      nonLues: await this.nombreAlertesNonLues(u, mes),
      alertes: page.map((a) => ({
        ...a,
        lue: !!a.lue,
        aujourdhui: aujourdhui(a.demandeId),
      })),
      suite,
    };
  }

  /** Alertes non lues du compte (toutes, pas seulement la première page). */
  private async nombreAlertesNonLues(u: UtilisateurConnecte, mes: number[]) {
    if (!mes.length) return 0;
    const [r] = await this.alertes.query<{ n: number }[]>(
      `SELECT count(*)::int AS n
         FROM alerte a
         JOIN utilisateur u ON u.id = $2
        WHERE ${SQL_ALERTE_A_MOI}
          AND a."creeLe" >= u."creeLe"
          AND NOT EXISTS (SELECT 1 FROM alerte_lue l
                           WHERE l."alerteId" = a.id AND l."utilisateurId" = $2)`,
      [mes, u.id],
    );
    return r?.n ?? 0;
  }

  /** Marque comme lues ces alertes, ou toutes celles du compte (`tout`). */
  async marquerLues(u: UtilisateurConnecte, ids: number[], tout = false) {
    const mes = await this.structuresDe(u);
    if (!mes.length || (!tout && !ids.length)) return { ok: true };
    // Seulement ses propres alertes, en une requête ; déjà lues : rien ne change
    await this.lues.query(
      `INSERT INTO alerte_lue ("alerteId", "utilisateurId")
       SELECT a.id, $2 FROM alerte a
        WHERE ${SQL_ALERTE_A_MOI} AND ($3::bool OR a.id = ANY($4::int[]))
       ON CONFLICT DO NOTHING`,
      [mes, u.id, tout, ids],
    );
    return { ok: true };
  }

  /* ------------------------- Dossiers à traiter ------------------------- */

  /**
   * Dossiers du compte, page par page : « à traiter » (l'étape en cours est chez lui) ou
   * « à suivre » (il intervient plus loin dans le circuit ; un dossier à traiter n'y est pas
   * répété). Du plus ancien au plus récent. Recherche (nom, n°, objet), filtres par type de
   * demande, par étape en cours et « en retard » (plus de 7 jours à l'étape).
   */
  async aTraiter(u: UtilisateurConnecte, f: FiltresDossiers = {}) {
    const mes = await this.structuresDe(u);
    const onglet = f.onglet === 'aSuivre' ? 'aSuivre' : 'aTraiter';
    const taille = Math.min(Math.max(f.taille ?? 50, 1), 100);
    const page = Math.max(f.page ?? 1, 1);
    const vide = {
      onglet,
      page,
      taille,
      total: 0,
      lignes: [],
      compte: { aTraiter: 0, aSuivre: 0, enRetard: 0 },
      filtres: { types: [], etapes: [] },
    };
    if (!mes.length) return vide;

    const params: unknown[] = [mes];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const conditions = [onglet === 'aTraiter' ? SQL_A_TRAITER : SQL_A_SUIVRE];
    const mots = (f.recherche ?? '')
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 6);
    for (const m of mots)
      conditions.push(
        `lower(d."nomComplet" || ' ' || coalesce(d.objet, '') || ' ' || d."numeroEnregistrement") LIKE ${p(`%${m.replace(/[\\%_]/g, '\\$&')}%`)}`,
      );
    // Choix des filtres : sur l'onglet et la recherche, sans les filtres eux-mêmes
    const filtresSeuls = [...conditions];
    const paramsFiltres = [...params];
    if (f.type) conditions.push(`d."typePrestation" = ${p(f.type)}`);
    if (f.etape) conditions.push(`${SQL_ETAPE} ->> 'sigle' = ${p(f.etape)}`);
    if (f.retard) conditions.push(SQL_EN_RETARD);
    const ou = conditions.join(' AND ');

    const [{ total }] = await this.demandes.query<{ total: number }[]>(
      `SELECT count(*)::int AS total FROM demande_mutation d WHERE ${ou}`,
      params,
    );
    const lignes = await this.demandes.query<LigneDossier[]>(
      `SELECT d.id, d."numeroEnregistrement" AS numero, d."nomComplet", d.objet,
              d."typePrestation", d.canal, d.decision, d."etapeCourante",
              jsonb_array_length(d.circuit) AS etapes, ${SQL_ETAPE} AS etape
         FROM demande_mutation d
        WHERE ${ou}
     ORDER BY ${SQL_ARRIVEE} ASC NULLS LAST, d."numeroEnregistrement" ASC
        LIMIT ${taille} OFFSET ${(page - 1) * taille}`,
      params,
    );

    // Compteurs des onglets et choix des filtres (sur l'onglet, recherche comprise)
    const [compte] = await this.demandes.query<
      { aTraiter: number; aSuivre: number; enRetard: number }[]
    >(
      `SELECT count(*) FILTER (WHERE ${SQL_A_TRAITER})::int AS "aTraiter",
              count(*) FILTER (WHERE ${SQL_A_SUIVRE})::int AS "aSuivre",
              count(*) FILTER (WHERE ${SQL_A_TRAITER} AND ${SQL_EN_RETARD})::int AS "enRetard"
         FROM demande_mutation d WHERE ${SQL_EN_CIRCUIT}`,
      [mes],
    );
    const ouFiltres = filtresSeuls.join(' AND ');
    const types = await this.demandes.query<
      { code: string; libelle: string; n: number }[]
    >(
      `SELECT d."typePrestation" AS code, coalesce(t.libelle, d."typePrestation") AS libelle, count(*)::int AS n
         FROM demande_mutation d LEFT JOIN type_prestation t ON t.code = d."typePrestation"
        WHERE ${ouFiltres} AND d."typePrestation" IS NOT NULL
     GROUP BY 1, 2 ORDER BY 3 DESC`,
      paramsFiltres,
    );
    const etapes = await this.demandes.query<{ sigle: string; n: number }[]>(
      `SELECT ${SQL_ETAPE} ->> 'sigle' AS sigle, count(*)::int AS n
         FROM demande_mutation d WHERE ${ouFiltres}
     GROUP BY 1 ORDER BY 2 DESC`,
      paramsFiltres,
    );

    // Instructions en cours (la dernière donnée à l'étape actuelle), pour la page seulement
    const instr = lignes.length
      ? await this.instructions.find({
          where: { demandeId: In(lignes.map((d) => d.id)) },
          order: { creeLe: 'DESC' },
        })
      : [];
    return {
      onglet,
      page,
      taille,
      total,
      compte,
      filtres: { types, etapes: etapes.filter((e) => e.sigle) },
      lignes: lignes.map((d) => ({
        id: d.id,
        numero: d.numero,
        nomComplet: d.nomComplet,
        objet: d.objet,
        typePrestation: d.typePrestation,
        canal: d.canal,
        etape: {
          sigle: d.etape?.sigle,
          nom: d.etape?.nom,
          phase: d.etape?.phase,
        },
        rang: d.etapeCourante + 1,
        etapes: d.etapes,
        arriveeLe: d.etape?.arriveeLe ?? null,
        depuis: joursDepuis(d.etape?.arriveeLe),
        decision: d.decision,
        instruction:
          instr.find(
            (x) => x.demandeId === d.id && x.etape === d.etapeCourante,
          ) ?? null,
      })),
    };
  }

  /** Compteurs du menu : dossiers à traiter et alertes non lues (calculés en base). */
  async compteur(u: UtilisateurConnecte) {
    const mes = await this.structuresDe(u);
    if (!mes.length) return { aTraiter: 0, alertes: 0 };
    const [r] = await this.demandes.query<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM demande_mutation d WHERE ${SQL_A_TRAITER}`,
      [mes],
    );
    return {
      aTraiter: r?.n ?? 0,
      alertes: await this.nombreAlertesNonLues(u, mes),
    };
  }

  /**
   * Tableau de bord des comptes du circuit (DDEPPSA, cabinet, secrétariat…) : leurs dossiers
   * et les demandes où leurs structures interviennent. Sans structure : toutes les demandes.
   */
  async tableau(u: UtilisateurConnecte) {
    const mes = await this.structuresDe(u);
    const sigles = mes.length
      ? (await this.structures.find({ where: { id: In(mes) } }))
          .map((s) => s.sigle || s.nom)
          .sort()
      : [];
    const perimetre = mes.length
      ? `EXISTS (SELECT 1 FROM jsonb_array_elements(d.circuit) x WHERE (x ->> 'structureId')::int = ANY($1))`
      : 'TRUE';
    const [m] = await this.demandes.query<Record<string, number>[]>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE ${SQL_ETAT_ACCORDEE})::int AS accordees,
              count(*) FILTER (WHERE ${SQL_ETAT_REFUSEE})::int AS refusees,
              count(*) FILTER (WHERE d.decision = 'EN_INSTANCE')::int AS "enInstance",
              count(*) FILTER (WHERE NOT (${SQL_ETAT_ACCORDEE}) AND NOT (${SQL_ETAT_REFUSEE})
                                 AND d.decision IS DISTINCT FROM 'EN_INSTANCE')::int AS "enCours"
         FROM demande_mutation d WHERE NOT d.retiree AND ${perimetre}`,
      mes.length ? [mes] : [],
    );
    const dossiers = mes.length
      ? await this.aTraiter(u, { onglet: 'aTraiter', taille: 5 })
      : null;
    return {
      perimetre: mes.length
        ? { national: false, structures: sigles }
        : { national: true, structures: [] },
      dossiers: dossiers?.compte ?? { aTraiter: 0, aSuivre: 0, enRetard: 0 },
      plusAnciens: dossiers?.lignes ?? [],
      alertesNonLues: await this.nombreAlertesNonLues(u, mes),
      mutations: m,
    };
  }

  /** Comptes qui peuvent agir à l'étape en cours (pour l'afficher). */
  /**
   * Qui peut agir à l'étape en cours, et comment : comptes rattachés à la structure
   * (STRUCTURE), comptes du rôle sans structure (ROLE : ils peuvent agir à toutes les étapes
   * de ce type), ou personne (AUCUN : le dossier attend). Avec les délégations en cours.
   */
  async responsables(d: DemandeMutation): Promise<{
    mode: 'STRUCTURE' | 'ROLE' | 'AUCUN';
    noms: string[];
    delegations: string[];
  }> {
    const vide = { mode: 'AUCUN' as const, noms: [], delegations: [] };
    if (d.etapeCourante === null || !d.circuit) return vide;
    const e = d.circuit[d.etapeCourante];
    if (!e.structureId) return vide;
    const aujourdhui = new Date().toISOString().slice(0, 10);
    const delegations = async (liste: Utilisateur[]) => {
      const res: string[] = [];
      for (const x of liste)
        if (x.delegueId && x.delegationFin && x.delegationFin >= aujourdhui) {
          const dl = await this.users.findOne({ where: { id: x.delegueId } });
          if (dl)
            res.push(
              `${x.nom} est absent(e) : ${dl.nom} le (la) remplace jusqu’au ${x.delegationFin.split('-').reverse().join('/')}`,
            );
        }
      return res;
    };
    const direct = await this.users.find({
      where: { structureId: e.structureId, actif: true },
    });
    if (direct.length)
      return {
        mode: 'STRUCTURE',
        noms: direct.map((x) => x.nom),
        delegations: await delegations(direct),
      };
    if (e.type === 'DDEPPSA') {
      const s = await this.structures.findOne({ where: { id: e.structureId } });
      const dd = (
        await this.users.find({
          where: {
            role: 'DDEPPSA',
            departementId: s?.departementId ?? -1,
            actif: true,
          },
        })
      ).filter((x) => !x.structureId);
      return dd.length
        ? {
            mode: 'STRUCTURE',
            noms: dd.map((x) => x.nom),
            delegations: await delegations(dd),
          }
        : vide;
    }
    const roles = ROLE_PAR_TYPE[e.type];
    const parRole = roles
      ? (
          await this.users.find({ where: { role: In(roles), actif: true } })
        ).filter((x) => !x.structureId)
      : [];
    return parRole.length
      ? {
          mode: 'ROLE',
          noms: parRole.map((x) => x.nom),
          delegations: await delegations(parRole),
        }
      : vide;
  }
}
