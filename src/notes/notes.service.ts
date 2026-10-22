import { joursDepuis } from '../common/jours';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import ExcelJS from 'exceljs';
import { In, IsNull, Repository } from 'typeorm';
import { AffectationService } from '../affectation/affectation.service';
import type { UtilisateurConnecte } from '../auth/auth';
import {
  codeCycle,
  GROUPES_MUTATION,
  LIBELLE_CYCLE,
  LIBELLE_GROUPE,
  MOTIFS,
  MOTIFS_MUTATION,
  NOTES_AFFECTATION,
  TYPES_NOTE_AFFECTATION,
  titreDepartement,
  type GroupeMutation,
  type MotifMutation,
  type TypeNoteAffectation,
} from '../common/referentiels';
import { entierVersRomain } from '../common/texte';
import { JournalService, ParametresService } from '../core/core.service';
import { libelleLot, repereLot } from '../common/lots';
import {
  Affectation,
  DemandeMutation,
  Departement,
  LotPublication,
  NoteService,
  CampagneEnrolement,
  Enrole,
  Structure,
  type AvisConformite,
} from '../entities';
import { MutationService } from '../mutation/mutation.service';
import { DIPLOMES_ENROLEMENT } from '../enrolement/enrolement.service';

export interface Colonne {
  cle: string;
  libelle: string;
}

export interface LigneNote {
  id: string;
  n: number;
  [cle: string]: string | number | null;
}

export interface SectionNote {
  /** Titre du département (« I- DEPARTEMENT DE LA BOUENZA »), sur le premier tableau du département. */
  titre: string | null;
  /** Établissement (« Lycée de Bouansa ») quand les personnes du département en ont un. */
  sousTitre?: string | null;
  lignes: LigneNote[];
}

export interface ContenuNote {
  titre: string;
  introduction: string;
  colonnes: Colonne[];
  classification: boolean;
  sections: SectionNote[];
  total: number;
  departements: number;
  ampliations: { libelle: string; nombre: string }[];
  mentions: string[];
  piedDePage: string;
  repere: string;
}

/** « conformément aux tableaux ci-après » devient « au tableau » s'il n'y en a qu'un. */
export function accordTableaux(texte: string, nbTableaux: number) {
  return nbTableaux > 1
    ? texte.replace(/au tableau ci-après/g, 'aux tableaux ci-après')
    : texte.replace(/aux tableaux ci-après/g, 'au tableau ci-après');
}

/** Abréviations du repère imprimé en haut des notes de mutation. */
const ABREGE_MOTIF: Record<MotifMutation, string> = {
  RAPPROCHEMENT_CONJOINT: 'Rapp.Conj.',
  RAISONS_SOCIALES: 'Rais.Soc.',
  RAISONS_SANTE: 'Rais.Santé',
  PERMUTATION: 'Permut.',
  ANCIENNETE: 'Ancien.',
};

const GROUPE_COURT: Record<GroupeMutation, string> = {
  PRESCO_PRIMAIRE: 'Préscolaire-Primaire',
  COLLEGE_LYCEE_ADMIN: 'Collège-Lycée-Administration',
};

/** Objet de la note imprimé en bas à gauche : « Mutations Rapprochement de Conjoints ». */
const OBJET_MUTATION: Record<MotifMutation, string> = {
  RAPPROCHEMENT_CONJOINT: 'Mutations Rapprochement de Conjoints',
  RAISONS_SOCIALES: 'Mutations Raisons Sociales',
  RAISONS_SANTE: 'Mutations Raisons de Santé',
  PERMUTATION: 'Permutations',
  ANCIENNETE: 'Mutations Ancienneté',
};

const COLONNES_LIBELLES: Record<string, string> = {
  CYCLE: 'Cycle',
  SPECIALITE: 'Spécialité',
  ETABLISSEMENT: 'Etablissements',
  OBS: 'Obs',
  STRUCTURE: 'Structure',
};

export interface Entete {
  reference: string;
  signataireTitre: string;
  signataireNom: string;
  lieu: string;
  piedDroite: string;
  piedDroiteModele?: string;
  adresse: string;
}

/** Notes d'enrôlement : introduction (modifiable par le DG) et repère par diplôme. */
const INTRO_ENROLEMENT = (titulaires: string) =>
  `Les enseignants finalistes dont les noms et prénoms suivent, titulaires ${titulaires}, reçoivent les affectations ci-dessous, au titre de l'année scolaire {annee}, en qualité d'enseignants volontaires. Il s'agit de :`;
const NOTES_ENROLEMENT: Record<
  string,
  { court: string; introduction: string }
> = {
  MASTER: {
    court: 'ENS/Master',
    introduction: INTRO_ENROLEMENT(
      "du master d'enseignement de l'Ecole Normale Supérieure (ENS) ou d'un diplôme de langue vivante étrangère",
    ),
  },
  LICENCE: {
    court: 'Licence',
    introduction: INTRO_ENROLEMENT("de la licence d'enseignement"),
  },
  DEMA: { court: 'DEMA', introduction: INTRO_ENROLEMENT('du DEMA') },
  DCAF: { court: 'DCAF', introduction: INTRO_ENROLEMENT('du DCAF') },
  CFEEN: {
    court: 'CFEEN',
    introduction: INTRO_ENROLEMENT(
      "du Certificat de Fin d'Etudes des Ecoles Normales (CFEEN)",
    ),
  },
  BET: {
    court: 'BET',
    introduction: INTRO_ENROLEMENT('du BET ou du CFEEN option préscolaire'),
  },
  AUTRE: {
    court: 'Volontaires',
    introduction: INTRO_ENROLEMENT(
      "d'un diplôme professionnel de l'enseignement",
    ),
  },
};

type Niveau = AvisConformite['niveau'];

const LIBELLE_NIVEAU: Record<Niveau, string> = {
  BUREAU: 'le chef de bureau',
  SERVICE: 'le chef de service',
  DIRECTION: 'le directeur',
};
const NIVEAU_PAR_ROLE: Record<string, Niveau> = {
  AGENT: 'BUREAU',
  CHEF_SERVICE: 'SERVICE',
  DIRECTEUR: 'DIRECTION',
  BUREAU_ETUDES: 'DIRECTION',
};
const NIVEAU_PAR_STRUCTURE: Record<string, Niveau> = {
  BUREAU_DGRHAS: 'BUREAU',
  SERVICE_DGRHAS: 'SERVICE',
  DIRECTION_DGRHAS: 'DIRECTION',
};

@Injectable()
export class NotesService {
  constructor(
    @InjectRepository(NoteService)
    private readonly notes: Repository<NoteService>,
    @InjectRepository(Affectation)
    private readonly affectations: Repository<Affectation>,
    @InjectRepository(DemandeMutation)
    private readonly demandes: Repository<DemandeMutation>,
    @InjectRepository(LotPublication)
    private readonly lots: Repository<LotPublication>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    private readonly affSvc: AffectationService,
    private readonly mutSvc: MutationService,
    private readonly params: ParametresService,
    private readonly journal: JournalService,
    @InjectRepository(Enrole) private readonly enroles: Repository<Enrole>,
    @InjectRepository(CampagneEnrolement)
    private readonly campagnes: Repository<CampagneEnrolement>,
    @InjectRepository(Structure)
    private readonly structures: Repository<Structure>,
  ) {}

  private annee(
    module: 'AFFECTATION' | 'MUTATION' | 'ENROLEMENT' = 'AFFECTATION',
  ) {
    return (
      (module === 'MUTATION' && this.params.get('ANNEE_SCOLAIRE_MUTATION')) ||
      this.params.get('ANNEE_SCOLAIRE')
    );
  }

  /**
   * Une note encore ouverte (pas validée) suit l'année scolaire réglée dans les paramètres ;
   * une note validée garde la sienne.
   */
  private async suivreAnnee(n: NoteService) {
    if (n.contenu || !['BROUILLON', 'SOUMISE'].includes(n.statut)) return n;
    if (n.module === 'ENROLEMENT') return n;
    const annee = this.annee(n.module);
    if (annee && annee !== n.anneeScolaire) {
      await this.notes.update(n.id, { anneeScolaire: annee });
      n.anneeScolaire = annee;
    }
    return n;
  }

  private ampliations(dg: string, nbDeps: number, total: number) {
    const fixes: [string, number][] = [
      ['MEPPSA-CAB', 2],
      ['IGEPSA', 2],
      ['DGRHAS-DRSC', 2],
      [dg, 2],
      ['DGFP', 1],
      ['DGB-DGBCB-D/SOLDE', 3],
      ['DDEPPSA', nbDeps],
      ['Intéressés', total],
      ['Dossiers', total],
    ];
    const somme = fixes.reduce((s, [, n]) => s + n, 0) + 2;
    return [
      ...fixes.map(([libelle, n]) => ({ libelle, nombre: String(n) })),
      { libelle: 'Archives', nombre: `2/${somme}` },
    ];
  }

  /* ======================== Notes d'affectation ======================== */

  /** Lignes éligibles : non exclues, sans blocage, pas encore dans une note validée. */
  private async lignesAffectation(lotNumero: number, typeNote: string) {
    const liste = await this.affSvc.listeAffectations({
      lot: lotNumero,
      typeNote,
      statut: 'A_TRAITER',
    });
    return {
      prets: liste.filter((x) => !x.derive.bloquants.length),
      bloques: liste.filter((x) => x.derive.bloquants.length),
    };
  }

  private async contenuAffectation(
    note: NoteService,
  ): Promise<ContenuNote & { bloques: unknown[] }> {
    const lot = await this.lots.findOne({
      where: { id: note.lotPublicationId! },
    });
    const def = NOTES_AFFECTATION[note.typeNote as TypeNoteAffectation];
    const { prets, bloques } = await this.lignesAffectation(
      lot!.numero,
      note.typeNote,
    );
    const deps = await this.deps.find({ order: { ordre: 'ASC' } });

    const colonnes: Colonne[] = [
      { cle: 'nom', libelle: 'Noms et prénoms' },
      { cle: 'grade', libelle: 'Grade' },
      { cle: 'reference', libelle: def.libelleRef },
      ...def.colonnes.map((c) => ({
        cle: c.toLowerCase(),
        libelle: COLONNES_LIBELLES[c],
      })),
    ];
    const ligne = (x: (typeof prets)[number], n: number): LigneNote => ({
      id: x.id,
      n,
      nom: x.agent.nomComplet,
      grade: x.derive.grade,
      cat: x.derive.categorie,
      ech: x.derive.echelle,
      echl: x.derive.echelon,
      reference: x.derive.reference,
      cycle: x.derive.cycleLibelle,
      specialite: x.specialite,
      etablissement: x.etablissement,
      obs: x.obs ?? 'Ens. actif',
      structure: x.structure,
      origine: x.origine,
    });

    const tri = (a: (typeof prets)[number], b: (typeof prets)[number]) =>
      a.agent.nomNormalise.localeCompare(b.agent.nomNormalise);
    let sections: SectionNote[];
    if (def.parDepartement) {
      sections = deps
        .map((d) => ({
          d,
          items: prets.filter((x) => x.departementId === d.id).sort(tri),
        }))
        .filter((s) => s.items.length)
        .flatMap((s, i): SectionNote[] => {
          const titre = `${entierVersRomain(i + 1)}- ${titreDepartement(s.d)}`;
          // Sans établissement : un seul tableau par département (présentation habituelle)
          if (!s.items.some((x) => x.etablissement))
            return [{ titre, lignes: s.items.map((x, j) => ligne(x, j + 1)) }];
          // Avec établissements : les personnes sans établissement (à la disposition de la
          // DDEPPSA) d'abord, puis un tableau par établissement, chacun numéroté à partir de 1
          const groupes = new Map<string, typeof s.items>();
          for (const x of s.items) {
            const k = x.etablissement?.trim() ?? '';
            groupes.set(k, [...(groupes.get(k) ?? []), x]);
          }
          return [...groupes.entries()]
            .sort(([a], [b]) =>
              a === '' ? -1 : b === '' ? 1 : a.localeCompare(b, 'fr'),
            )
            .map(([etab, items], k) => ({
              titre: k === 0 ? titre : null,
              sousTitre: etab || null,
              lignes: items.map((x, j) => ligne(x, j + 1)),
            }));
        });
    } else {
      sections = [
        {
          titre: null,
          lignes: [...prets].sort(tri).map((x, j) => ligne(x, j + 1)),
        },
      ];
    }
    const nbDeps = new Set(prets.map((x) => x.departementId).filter(Boolean))
      .size;
    const annee = note.anneeScolaire;
    const typeTexte = note.typeNote.startsWith('DECRET') ? 'Déc' : 'Arr';
    const tableaux = sections.filter((s) => s.lignes.length).length;
    return {
      titre: 'NOTE DE SERVICE',
      introduction: accordTableaux(
        note.introduction.replaceAll('{annee}', annee),
        tableaux,
      ),
      colonnes,
      classification: true,
      sections: sections.filter((s) => s.lignes.length),
      total: prets.length,
      departements: nbDeps,
      ampliations: this.ampliations(
        def.directionGenerale,
        nbDeps,
        prets.length,
      ),
      mentions: [
        ...(def.fraisVoyage
          ? [
              'Les frais de voyage et de transport des bagages sont à la charge des intéressés.',
            ]
          : []),
        'La présente note de service prend effet à compter de la date de signature.',
      ],
      piedDePage: def.piedDePage.replaceAll('{annee}', annee),
      repere: lot!.rang ? repereLot(lot!) : `${typeTexte}/Lot${lot!.numero}`,
      bloques: bloques.map((x) => ({
        id: x.id,
        nom: x.agent.nomComplet,
        raisons: x.derive.bloquants,
      })),
    };
  }

  async preparerAffectation(u: UtilisateurConnecte, lotNumero: number) {
    const lot = await this.lots.findOne({ where: { numero: lotNumero } });
    if (!lot) throw new NotFoundException('Lot introuvable');
    const creees: NoteService[] = [];
    for (const type of TYPES_NOTE_AFFECTATION) {
      const ouverte = await this.notes.findOne({
        where: {
          module: 'AFFECTATION',
          lotPublicationId: lot.id,
          typeNote: type,
          statut: In(['BROUILLON', 'SOUMISE']),
        },
      });
      if (ouverte) continue;
      const { prets } = await this.lignesAffectation(lotNumero, type);
      if (!prets.length) continue;
      const rang =
        (await this.notes.count({
          where: {
            module: 'AFFECTATION',
            lotPublicationId: lot.id,
            typeNote: type,
          },
        })) + 1;
      creees.push(
        await this.notes.save({
          module: 'AFFECTATION',
          typeNote: type,
          lotPublicationId: lot.id,
          anneeScolaire: this.annee(),
          rang,
          introduction: NOTES_AFFECTATION[type].introduction,
          statut: 'BROUILLON',
          creePar: u.nom,
        }),
      );
    }
    await this.journal.log(
      u,
      'PREPARATION_NOTES_AFFECTATION',
      'lot_publication',
      lot.id,
      { notes: creees.map((n) => n.typeNote) },
    );
    return creees;
  }

  /* ========================= Notes de mutation ========================= */

  private async contenuMutation(
    note: NoteService,
  ): Promise<ContenuNote & { bloques: unknown[] }> {
    const motif = note.motif as MotifMutation;
    const groupe = note.typeNote as GroupeMutation;
    const liste = await this.mutSvc.eligiblesPourNote(motif, groupe);
    const deps = await this.deps.find({ order: { ordre: 'ASC' } });
    const permutation = motif === 'PERMUTATION';
    const colonnes: Colonne[] = [
      { cle: 'nom', libelle: 'Noms et prénoms' },
      { cle: 'ge', libelle: 'G/E' },
      { cle: 'matricule', libelle: 'Matricule Solde' },
      { cle: 'cycle', libelle: 'Cycle' },
      { cle: 'specialite', libelle: 'Spécialité' },
      { cle: 'ancienPoste', libelle: 'Ancien Poste' },
      { cle: 'origine', libelle: "Dépar-tement d'origine" },
      ...(permutation
        ? [{ cle: 'accueil', libelle: "Dépar-tement d'accueil" }]
        : []),
      { cle: 'obs', libelle: 'Obs' },
    ];
    const ligne = (d: DemandeMutation, n: number): LigneNote => ({
      id: d.id,
      n,
      nom: d.nomComplet,
      ge: [d.grade, d.echelon]
        .filter((x) => x !== null && x !== undefined)
        .join(' '),
      matricule: d.matricule ?? 'X',
      ...(() => {
        // Au préscolaire et au primaire, la spécialité est le cycle lui-même
        const c = codeCycle(d.cycle);
        const cycle = c ? LIBELLE_CYCLE[c] : d.cycle;
        const memeQueCycle = c === 'PRESCOLAIRE' || c === 'PRIMAIRE';
        return {
          cycle,
          specialite: d.specialite || (memeQueCycle ? cycle : null),
        };
      })(),
      ancienPoste: d.lieuService,
      origine: d.departementOrigine?.nom ?? null,
      accueil: d.departementSollicite?.nom ?? null,
      obs:
        d.typeAgent === 'FINALISTE'
          ? 'Finaliste'
          : d.statutAgent === 'PERSONNEL_ADMINISTRATIF'
            ? 'Pers. adm.'
            : d.genre === 'F'
              ? 'Ens. active'
              : 'Ens. actif',
    });
    const tri = (a: DemandeMutation, b: DemandeMutation) =>
      a.nomComplet.localeCompare(b.nomComplet, 'fr');
    const sections: SectionNote[] = permutation
      ? [
          {
            titre: null,
            lignes: [...liste].sort(tri).map((d, j) => ligne(d, j + 1)),
          },
        ]
      : deps
          .map((dep) => ({
            dep,
            items: liste
              .filter((d) => d.departementSolliciteId === dep.id)
              .sort(tri),
          }))
          .filter((s) => s.items.length)
          .map((s, i) => ({
            titre: `${entierVersRomain(i + 1)}- ${titreDepartement(s.dep)}`,
            lignes: s.items.map((d, j) => ligne(d, j + 1)),
          }));
    const nbDeps = new Set(
      liste
        .flatMap((d) => [d.departementOrigineId, d.departementSolliciteId])
        .filter(Boolean),
    ).size;
    return {
      titre: 'NOTE DE SERVICE',
      introduction: accordTableaux(
        note.introduction.replaceAll('{annee}', note.anneeScolaire),
        sections.length,
      ),
      colonnes,
      classification: false,
      sections,
      total: liste.length,
      departements: nbDeps,
      ampliations: this.ampliations(
        groupe === 'PRESCO_PRIMAIRE' ? 'DGEB' : 'DGES-DC',
        nbDeps,
        liste.length,
      ),
      mentions: [
        'Les frais de voyage et de transport des bagages sont à la charge des intéressés.',
        'La présente note de service prend effet à compter de la date de signature.',
      ],
      piedDePage: `${OBJET_MUTATION[motif]}/${GROUPE_COURT[groupe]}/${note.anneeScolaire}`,
      repere: `Mut./${ABREGE_MOTIF[motif]}`,
      bloques: [],
    };
  }

  introductionMutation(motif: MotifMutation, groupe: GroupeMutation) {
    const qui =
      groupe === 'PRESCO_PRIMAIRE'
        ? 'Les enseignants du préscolaire et du primaire'
        : 'Les agents du collège, du lycée et de l’administration';
    return `${qui} dont les noms et prénoms suivent, sont mutés ${MOTIFS[motif].formule}, au titre de l’année scolaire {annee}, conformément aux tableaux ci-après :`;
  }

  async preparerMutation(u: UtilisateurConnecte) {
    const creees: NoteService[] = [];
    for (const motif of MOTIFS_MUTATION)
      for (const groupe of GROUPES_MUTATION) {
        const ouverte = await this.notes.findOne({
          where: {
            module: 'MUTATION',
            motif,
            typeNote: groupe,
            statut: In(['BROUILLON', 'SOUMISE']),
          },
        });
        if (ouverte) continue;
        const liste = await this.mutSvc.eligiblesPourNote(motif, groupe);
        if (!liste.length) continue;
        const rang =
          (await this.notes.count({
            where: { module: 'MUTATION', motif, typeNote: groupe },
          })) + 1;
        creees.push(
          await this.notes.save({
            module: 'MUTATION',
            typeNote: groupe,
            motif,
            lotPublicationId: null,
            anneeScolaire: this.annee('MUTATION'),
            rang,
            introduction: this.introductionMutation(motif, groupe),
            statut: 'BROUILLON',
            creePar: u.nom,
          }),
        );
      }
    await this.journal.log(
      u,
      'PREPARATION_NOTES_MUTATION',
      'note_service',
      null,
      {
        notes: creees.map((n) => `${n.motif}/${n.typeNote}`),
      },
    );
    return creees;
  }

  /* ======================== Notes d'enrôlement ======================== */

  /** Volontaires retenus d'une campagne et d'un diplôme, pas encore dans une autre note validée. */
  private async lignesEnrolement(note: NoteService) {
    const liste = await this.enroles
      .createQueryBuilder('e')
      .where('e.campagneId = :c', { c: note.campagneId })
      .andWhere('e.diplome = :d', { d: note.typeNote })
      .andWhere("e.etat = 'RETENU'")
      .andWhere('(e.noteId IS NULL OR e.noteId = :n)', { n: note.id })
      .orderBy('e.nomNormalise', 'ASC')
      .getMany();
    return {
      prets: liste.filter((e) => e.departementRetenuId),
      bloques: liste.filter((e) => !e.departementRetenuId),
    };
  }

  private async contenuEnrolement(
    note: NoteService,
  ): Promise<ContenuNote & { bloques: unknown[] }> {
    const { prets, bloques } = await this.lignesEnrolement(note);
    const deps = await this.deps.find({ order: { ordre: 'ASC' } });
    const jour = (d: string | null) =>
      d ? d.split('-').reverse().join('/') : '';
    const ligne = (e: Enrole, n: number): LigneNote => ({
      id: e.id,
      n,
      nom: e.nomComplet,
      naissance: jour(e.dateNaissance),
      lieu: e.lieuNaissance,
      promotion: e.promotion,
      specialite: e.specialite ?? DIPLOMES_ENROLEMENT[e.diplome]?.cycle ?? null,
    });
    // Par département, puis par établissement (comme les notes signées n° 1006 et 1038)
    const sections: SectionNote[] = deps
      .map((d) => ({
        d,
        items: prets.filter((e) => e.departementRetenuId === d.id),
      }))
      .filter((x) => x.items.length)
      .flatMap((x, i): SectionNote[] => {
        const titre = `${entierVersRomain(i + 1)}- DEPARTEMENT ${x.d.article} ${x.d.nom.toUpperCase()}`;
        const groupes = new Map<string, Enrole[]>();
        for (const e of x.items) {
          const k = e.etablissement?.trim() ?? '';
          groupes.set(k, [...(groupes.get(k) ?? []), e]);
        }
        return [...groupes.entries()]
          .sort(([a], [b]) =>
            a === '' ? -1 : b === '' ? 1 : a.localeCompare(b, 'fr'),
          )
          .map(([etab, items], k) => ({
            titre: k === 0 ? titre : null,
            sousTitre: etab || null,
            lignes: items.map((e, j) => ligne(e, j + 1)),
          }));
      });
    const nbDeps = new Set(prets.map((e) => e.departementRetenuId)).size;
    const def = NOTES_ENROLEMENT[note.typeNote] ?? NOTES_ENROLEMENT.AUTRE;
    const total = prets.length;
    const fixes: [string, number][] = [
      ['MEPPSA-CAB', 2],
      ['IGEPSA', 2],
      ['DGRHAS', 2],
      ['DGES', 2],
      ['DGB-DGCB', 2],
      ['DDEPPSA', nbDeps],
      ['Intéressés', total],
      ['Dossiers', total],
    ];
    const somme = fixes.reduce((t, [, n]) => t + n, 0) + 2;
    return {
      titre: 'NOTE DE SERVICE',
      introduction: note.introduction.replaceAll('{annee}', note.anneeScolaire),
      colonnes: [
        { cle: 'nom', libelle: 'Noms et prénoms' },
        { cle: 'naissance', libelle: 'Date de nais.' },
        { cle: 'lieu', libelle: 'Lieu de nais.' },
        { cle: 'promotion', libelle: 'Promotion' },
        { cle: 'specialite', libelle: 'Spécialité' },
      ],
      classification: false,
      sections,
      total,
      departements: nbDeps,
      ampliations: [
        ...fixes.map(([libelle, n]) => ({ libelle, nombre: String(n) })),
        { libelle: 'Archives', nombre: `2/${somme}` },
      ],
      mentions: [
        this.params.get('MENTION_BOURSE_ENROLEMENT'),
        'La présente note de service prend effet à compter de la date de signature./-',
      ].filter(Boolean),
      piedDePage: `Affectation des enseignants finalistes/${def.court}/${note.anneeScolaire}`,
      repere: `Enr./${def.court}`,
      bloques: bloques.map((e) => ({
        id: e.id,
        nom: e.nomComplet,
        raisons: ['Département retenu pas encore choisi'],
      })),
    };
  }

  /**
   * Une note par diplôme pour les volontaires retenus d'une campagne (pas encore dans une note),
   * pour l'année scolaire choisie.
   */
  async preparerEnrolement(
    u: UtilisateurConnecte,
    campagneId: number,
    anneeScolaire: string,
  ) {
    const c = await this.campagnes.findOne({ where: { id: campagneId } });
    if (!c) throw new NotFoundException('Campagne introuvable');
    const an = /^(\d{4})-(\d{4})$/.exec(anneeScolaire ?? '');
    if (!an || Number(an[2]) !== Number(an[1]) + 1)
      throw new BadRequestException(
        'Choisissez l’année scolaire (ex. « 2026-2027 »).',
      );
    const parDiplome = await this.enroles.query<
      { diplome: string; n: number }[]
    >(
      `SELECT diplome, count(*)::int AS n FROM enrole WHERE "campagneId" = $1 AND etat = 'RETENU' AND "noteId" IS NULL GROUP BY 1`,
      [campagneId],
    );
    if (!parDiplome.length)
      throw new BadRequestException(
        `Aucun volontaire retenu en attente de note dans la campagne ${c.annee} : la DGRHAS doit d’abord retenir des dossiers.`,
      );
    const creees: NoteService[] = [];
    for (const { diplome } of parDiplome) {
      const ouverte = await this.notes.findOne({
        where: {
          module: 'ENROLEMENT',
          campagneId,
          typeNote: diplome,
          statut: In(['BROUILLON', 'SOUMISE']),
        },
      });
      if (ouverte) {
        // La note ouverte se met à jour toute seule ; on lui donne l'année choisie
        if (ouverte.anneeScolaire !== anneeScolaire)
          await this.notes.update(ouverte.id, { anneeScolaire });
        continue;
      }
      const rang =
        (await this.notes.count({
          where: { module: 'ENROLEMENT', campagneId, typeNote: diplome },
        })) + 1;
      creees.push(
        await this.notes.save({
          module: 'ENROLEMENT',
          typeNote: diplome,
          campagneId,
          anneeScolaire,
          rang,
          introduction: (NOTES_ENROLEMENT[diplome] ?? NOTES_ENROLEMENT.AUTRE)
            .introduction,
          statut: 'BROUILLON',
          creePar: u.nom,
        }),
      );
    }
    await this.journal.log(
      u,
      'PREPARATION_NOTES_ENROLEMENT',
      'campagne_enrolement',
      String(campagneId),
      {
        notes: creees.map((n) => n.typeNote),
        anneeScolaire,
      },
    );
    return creees;
  }

  /* ============================ Commun =============================== */

  private libelle(n: NoteService, lot?: LotPublication | null) {
    if (n.module === 'ENROLEMENT')
      return `Enrôlement – ${DIPLOMES_ENROLEMENT[n.typeNote]?.libelle ?? n.typeNote} – ${n.anneeScolaire}${n.rang > 1 ? ` (suite ${n.rang - 1})` : ''}`;
    if (n.module === 'AFFECTATION')
      return `Affectation – ${NOTES_AFFECTATION[n.typeNote as TypeNoteAffectation]?.libelle ?? n.typeNote} – ${lot ? libelleLot(lot) : 'lot ?'}${n.rang > 1 ? ` (suite ${n.rang - 1})` : ''}`;
    return `Mutation – ${MOTIFS[n.motif as MotifMutation]?.libelle} – ${LIBELLE_GROUPE[n.typeNote as GroupeMutation]}${n.rang > 1 ? ` (suite ${n.rang - 1})` : ''}`;
  }

  async liste(module?: string, lot?: number) {
    const where: Record<string, unknown> = {};
    if (module) where.module = module;
    if (lot) {
      const l = await this.lots.findOne({ where: { numero: lot } });
      where.lotPublicationId = l?.id ?? -1;
    }
    const notes = await this.notes.find({ where, order: { creeLe: 'DESC' } });
    for (const n of notes) await this.suivreAnnee(n);
    const lots = new Map((await this.lots.find()).map((l) => [l.id, l]));
    const res: unknown[] = [];
    for (const n of notes) {
      const lot = n.lotPublicationId ? lots.get(n.lotPublicationId) : null;
      const lotNumero = lot?.numero ?? null;
      const total = n.contenu
        ? (n.contenu as ContenuNote).total
        : n.module === 'ENROLEMENT'
          ? (await this.lignesEnrolement(n)).prets.length
          : n.module === 'AFFECTATION'
            ? (await this.lignesAffectation(lotNumero!, n.typeNote)).prets
                .length
            : (
                await this.mutSvc.eligiblesPourNote(
                  n.motif as MotifMutation,
                  n.typeNote as GroupeMutation,
                )
              ).length;
      res.push({
        ...n,
        contenu: undefined,
        lotNumero,
        lotLibelle: lot ? libelleLot(lot) : null,
        libelle: this.libelle(n, lot),
        total,
      });
    }
    return res;
  }

  async obtenir(id: string) {
    const trouvee = await this.notes.findOne({ where: { id } });
    if (!trouvee) throw new NotFoundException('Note introuvable');
    const n = await this.suivreAnnee(trouvee);
    const lot = n.lotPublicationId
      ? await this.lots.findOne({ where: { id: n.lotPublicationId } })
      : null;
    const contenu =
      (n.contenu as ContenuNote | null) ??
      (n.module === 'AFFECTATION'
        ? await this.contenuAffectation(n)
        : n.module === 'ENROLEMENT'
          ? await this.contenuEnrolement(n)
          : await this.contenuMutation(n));
    // Bas de page et repère : simple mise en page, recalculés même pour une note figée
    if (n.module === 'AFFECTATION') {
      const def = NOTES_AFFECTATION[n.typeNote as TypeNoteAffectation];
      if (def)
        contenu.piedDePage = def.piedDePage.replaceAll(
          '{annee}',
          n.anneeScolaire,
        );
    } else if (n.module === 'ENROLEMENT') {
      const def = NOTES_ENROLEMENT[n.typeNote] ?? NOTES_ENROLEMENT.AUTRE;
      contenu.piedDePage = `Affectation des enseignants finalistes/${def.court}/${n.anneeScolaire}`;
    } else if (n.motif) {
      const motif = n.motif as MotifMutation;
      contenu.piedDePage = `${OBJET_MUTATION[motif]}/${GROUPE_COURT[n.typeNote as GroupeMutation]}/${n.anneeScolaire}`;
      contenu.repere = `Mut./${ABREGE_MOTIF[motif]}`;
    }
    return {
      ...n,
      contenu,
      lotNumero: lot?.numero ?? null,
      lotLibelle: lot ? libelleLot(lot) : null,
      libelle: this.libelle(n, lot),
      entete: this.entete(n, contenu),
    };
  }

  /**
   * En-tête de la note : figé à la validation (signataire, référence, lieu), sinon lu dans
   * les paramètres. Le bas de page droit prend l'année de la signature.
   */
  private entete(n: NoteService, contenu: unknown): Entete {
    const fige = (
      contenu as { entete?: Entete & { piedDroiteModele?: string } }
    ).entete;
    const modele =
      fige?.piedDroiteModele ?? this.params.get('PIED_PAGE_DROITE');
    const an = (n.dateSignature ?? new Date().toISOString()).slice(0, 4);
    return {
      reference: fige?.reference ?? this.params.get('REFERENCE_NOTE'),
      signataireTitre:
        fige?.signataireTitre ?? this.params.get('SIGNATAIRE_TITRE'),
      signataireNom: fige?.signataireNom ?? this.params.get('SIGNATAIRE_NOM'),
      lieu: fige?.lieu ?? this.params.get('LIEU_SIGNATURE'),
      piedDroite: modele.replaceAll('{an}', an),
      piedDroiteModele: modele,
      adresse: fige?.adresse ?? this.params.get('ADRESSE_PIED'),
    };
  }

  private async charger(id: string) {
    const n = await this.notes.findOne({ where: { id } });
    if (!n) throw new NotFoundException('Note introuvable');
    return n;
  }

  async modifierIntroduction(
    u: UtilisateurConnecte,
    id: string,
    introduction: string,
  ) {
    const n = await this.charger(id);
    if (n.statut !== 'BROUILLON')
      throw new BadRequestException(
        'Seule une note « à soumettre au DG » peut être modifiée',
      );
    if (!introduction?.trim())
      throw new BadRequestException('Introduction vide');
    await this.notes.update(id, { introduction: introduction.trim() });
    await this.journal.log(u, 'MODIFICATION_NOTE', 'note_service', id);
    return { ok: true };
  }

  async soumettre(u: UtilisateurConnecte, id: string) {
    const n = await this.charger(id);
    if (n.statut !== 'BROUILLON')
      throw new BadRequestException('La note doit être « à soumettre au DG »');
    const { contenu } = await this.obtenir(id);
    if (!contenu.total)
      throw new BadRequestException('La note ne contient aucun agent');
    await this.notes.update(id, {
      statut: 'SOUMISE',
      soumisePar: u.nom,
      commentaire: null,
    });
    await this.journal.log(u, 'NOTE_SOUMISE_DG', 'note_service', id);
    return { ok: true };
  }

  async renvoyer(u: UtilisateurConnecte, id: string, commentaire: string) {
    const n = await this.charger(id);
    if (n.statut !== 'SOUMISE')
      throw new BadRequestException(
        'Seule une note soumise peut être renvoyée',
      );
    await this.notes.update(id, {
      statut: 'BROUILLON',
      commentaire: commentaire?.trim() || null,
    });
    await this.journal.log(u, 'NOTE_RENVOYEE', 'note_service', id, {
      commentaire,
    });
    return { ok: true };
  }

  /** Validation par le DG : le contenu est figé et les agents sont marqués comme traités. */
  async valider(u: UtilisateurConnecte, id: string) {
    const n = await this.charger(id);
    if (n.statut !== 'SOUMISE')
      throw new BadRequestException('La note doit avoir été soumise au DG');
    const { contenu, entete } = await this.obtenir(id);
    if (!contenu.total)
      throw new BadRequestException('La note ne contient aucun agent');
    const ids = contenu.sections.flatMap((s) => s.lignes.map((l) => l.id));
    // L'en-tête (signataire, référence, lieu) est figé avec le contenu : changer de
    // ministre plus tard ne modifie pas une note déjà validée ou signée
    const fige = { ...contenu, bloques: undefined, entete };
    await this.notes.manager.transaction(async (m) => {
      if (n.module === 'AFFECTATION')
        await m.update(
          Affectation,
          { id: In(ids), statut: 'A_TRAITER' },
          { statut: 'AFFECTE', noteId: id },
        );
      else if (n.module === 'ENROLEMENT')
        await m.update(
          Enrole,
          { id: In(ids), noteId: IsNull() },
          { noteId: id },
        );
      else
        await m.update(
          DemandeMutation,
          { id: In(ids), noteId: IsNull() },
          { noteId: id },
        );
      await m.update(NoteService, id, {
        statut: 'VALIDEE',
        contenu: fige,
        valideePar: u.nom,
        valideeLe: new Date(),
      });
    });
    await this.journal.log(u, 'NOTE_VALIDEE_DG', 'note_service', id, {
      agents: ids.length,
    });
    return { ok: true };
  }

  /**
   * Une note validée reste modifiable tant que le ministre ne l'a pas signée :
   * elle redevient un brouillon, ses agents redeviennent « à traiter ».
   */
  async rouvrir(u: UtilisateurConnecte, id: string) {
    const n = await this.charger(id);
    if (n.statut === 'SIGNEE')
      throw new BadRequestException(
        'Cette note est signée par le ministre : elle ne peut plus être modifiée.',
      );
    if (n.statut !== 'VALIDEE')
      throw new BadRequestException(
        'Seule une note validée peut être rouverte.',
      );
    await this.notes.manager.transaction(async (m) => {
      if (n.module === 'AFFECTATION')
        await m.update(
          Affectation,
          { noteId: id, statut: 'AFFECTE' },
          { statut: 'A_TRAITER', noteId: null },
        );
      else if (n.module === 'ENROLEMENT')
        await m.update(Enrole, { noteId: id }, { noteId: null });
      else await m.update(DemandeMutation, { noteId: id }, { noteId: null });
      await m.update(NoteService, id, {
        statut: 'BROUILLON',
        contenu: () => 'NULL',
        valideePar: null,
        valideeLe: null,
        // La note va changer : les avis déjà donnés et l'ordre d'impression ne valent plus
        conformite: [],
        impressionPour: null,
        impressionOrdonneePar: null,
        impressionOrdonneeLe: null,
      });
    });
    await this.journal.log(u, 'NOTE_ROUVERTE', 'note_service', id);
    return { ok: true };
  }

  async signer(
    u: UtilisateurConnecte,
    id: string,
    numero: string,
    dateSignature: string,
  ) {
    const n = await this.charger(id);
    if (!['VALIDEE', 'SIGNEE'].includes(n.statut))
      throw new BadRequestException('La note doit être validée par le DG');
    if (!numero?.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(dateSignature ?? ''))
      throw new BadRequestException('Numéro et date de signature obligatoires');
    await this.notes.update(id, {
      statut: 'SIGNEE',
      numero: numero.trim(),
      dateSignature,
    });
    await this.journal.log(u, 'NOTE_SIGNEE', 'note_service', id, {
      numero,
      dateSignature,
    });
    return { ok: true };
  }

  /* ---------- Avis de conformité, ordre d'impression, scan de la note signée ---------- */

  /** Niveau (bureau, service, direction) où la personne donne son avis de conformité. */
  private async niveauDe(
    u: UtilisateurConnecte,
    force?: string,
  ): Promise<Niveau | null> {
    if (u.role === 'ADMIN' && force && force in LIBELLE_NIVEAU)
      return force as Niveau;
    if (u.structureId) {
      const s = await this.structures.findOne({ where: { id: u.structureId } });
      const n = s ? NIVEAU_PAR_STRUCTURE[s.type] : undefined;
      if (n) return n;
    }
    return NIVEAU_PAR_ROLE[u.role] ?? null;
  }

  /**
   * Après la validation du DG, le chef de bureau, le chef de service et le directeur lisent la note
   * et donnent chacun leur avis de conformité : une erreur ne doit pas arriver jusqu'au ministre.
   */
  async donnerConformite(
    u: UtilisateurConnecte,
    id: string,
    dto: { conforme: boolean; remarque?: string; niveau?: string },
  ) {
    const n = await this.charger(id);
    if (n.statut === 'SIGNEE')
      throw new BadRequestException(
        'Cette note est déjà signée par le ministre : l’avis de conformité ne se donne plus.',
      );
    if (n.statut !== 'VALIDEE')
      throw new BadRequestException(
        'L’avis de conformité se donne sur une note validée par le DG : celle-ci ne l’est pas encore.',
      );
    const niveau = await this.niveauDe(u, dto.niveau);
    if (!niveau)
      throw new BadRequestException(
        'Seuls le chef de bureau, le chef de service et le directeur donnent l’avis de conformité.',
      );
    const remarque = dto.remarque?.trim() || null;
    if (!dto.conforme && !remarque)
      throw new BadRequestException(
        'Dites ce qui n’est pas conforme (une phrase suffit) : le DG pourra rouvrir la note pour la corriger.',
      );
    const avis: AvisConformite = {
      niveau,
      par: u.nom,
      le: new Date().toISOString(),
      conforme: !!dto.conforme,
      remarque,
    };
    const autres = (n.conformite ?? []).filter((a) => a.niveau !== niveau);
    await this.notes.update(id, {
      conformite: [...autres, avis],
      // Un avis « non conforme » annule l'ordre d'impression déjà donné
      ...(avis.conforme
        ? {}
        : {
            impressionPour: null,
            impressionOrdonneePar: null,
            impressionOrdonneeLe: null,
          }),
    });
    await this.journal.log(u, 'NOTE_CONFORMITE', 'note_service', id, {
      niveau,
      conforme: avis.conforme,
      remarque,
    });
    return { ok: true };
  }

  /** Le DG ordonne l'impression de la version qui part à la signature, quand les trois avis sont « conforme ». */
  async ordonnerImpression(u: UtilisateurConnecte, id: string, pour: string) {
    const n = await this.charger(id);
    if (n.statut !== 'VALIDEE')
      throw new BadRequestException(
        n.statut === 'SIGNEE'
          ? 'Cette note est déjà signée par le ministre.'
          : 'La note doit d’abord être validée.',
      );
    if (!['DIRECTEUR', 'SECRETARIAT'].includes(pour))
      throw new BadRequestException(
        'Choisissez à qui demander d’imprimer : le directeur ou le secrétariat.',
      );
    const manque = (['BUREAU', 'SERVICE', 'DIRECTION'] as Niveau[]).filter(
      (v) => !(n.conformite ?? []).some((a) => a.niveau === v && a.conforme),
    );
    if (manque.length)
      throw new BadRequestException(
        `Il manque l’avis de conformité de : ${manque.map((v) => LIBELLE_NIVEAU[v]).join(', ')}. L’impression ne s’ordonne que lorsque les trois ont déclaré la note conforme.`,
      );
    await this.notes.update(id, {
      impressionPour: pour,
      impressionOrdonneePar: u.nom,
      impressionOrdonneeLe: new Date(),
    });
    await this.journal.log(u, 'NOTE_IMPRESSION_ORDONNEE', 'note_service', id, {
      pour,
    });
    return { ok: true };
  }

  /** Le scan ne se joint qu'à une note signée : contrôlé avant d'envoyer le fichier. */
  async verifierScanPossible(id: string) {
    const n = await this.charger(id);
    if (n.statut !== 'SIGNEE')
      throw new BadRequestException(
        'Enregistrez d’abord le numéro et la date de signature, puis joignez le scan de la note signée.',
      );
  }

  /** Scan PDF de la note signée : il clôture l'opération et part aux archives. */
  async enregistrerScan(
    u: UtilisateurConnecte,
    id: string,
    fichier: string,
    nomOrigine: string,
  ) {
    const n = await this.charger(id);
    if (n.statut !== 'SIGNEE')
      throw new BadRequestException(
        'Enregistrez d’abord le numéro et la date de signature, puis joignez le scan de la note signée.',
      );
    await this.notes.update(id, {
      scanFichier: fichier,
      scanNom: nomOrigine,
      scanLe: new Date(),
      scanPar: u.nom,
    });
    await this.journal.log(u, 'NOTE_SCAN_AJOUTE', 'note_service', id, {
      numero: n.numero,
    });
    return { ok: true, ancien: n.scanFichier };
  }

  async cheminScan(id: string) {
    const n = await this.charger(id);
    if (!n.scanFichier)
      throw new NotFoundException('Aucun scan pour cette note.');
    return { fichier: n.scanFichier, nom: n.scanNom ?? 'note-signee.pdf' };
  }

  /** Ce qui attend la personne : avis à donner, impressions, signatures à clôturer, dossiers à confier. */
  async aFaire(u: UtilisateurConnecte) {
    const niveau = await this.niveauDe(u);
    const lots = new Map((await this.lots.find()).map((l) => [l.id, l]));
    const lib = (n: NoteService) =>
      this.libelle(n, n.lotPublicationId ? lots.get(n.lotPublicationId) : null);
    const jours = (d: Date | null) => joursDepuis(d);
    const notes: {
      id: string;
      libelle: string;
      module: string;
      action: string;
      detail: string;
      depuis: number | null;
    }[] = [];
    const validees = await this.notes.find({ where: { statut: 'VALIDEE' } });
    for (const n of validees) {
      const avis = n.conformite ?? [];
      const base = { id: n.id, libelle: lib(n), module: n.module };
      const depuis = jours(n.valideeLe);
      if (niveau && u.role !== 'DG' && !avis.some((a) => a.niveau === niveau))
        notes.push({
          ...base,
          action: 'CONFORMITE',
          detail:
            'Lisez la note, puis dites si elle est conforme (votre visa y est engagé).',
          depuis,
        });
      if (u.role === 'DG' || u.role === 'ADMIN') {
        const tous = (['BUREAU', 'SERVICE', 'DIRECTION'] as Niveau[]).every(
          (v) => avis.some((a) => a.niveau === v && a.conforme),
        );
        const refus = avis.find((a) => !a.conforme);
        if (refus)
          notes.push({
            ...base,
            action: 'NON_CONFORME',
            detail: `${refus.par} : « ${refus.remarque} ». Rouvrez la note pour la corriger.`,
            depuis,
          });
        else if (tous && !n.impressionPour)
          notes.push({
            ...base,
            action: 'ORDONNER',
            detail:
              'Les trois avis sont conformes : ordonnez l’impression (directeur ou secrétariat).',
            depuis,
          });
        else if (!tous)
          notes.push({
            ...base,
            action: 'EN_ATTENTE',
            detail: `Avis reçus : ${avis.length}/3.`,
            depuis,
          });
      }
      if (n.impressionPour && u.role === n.impressionPour)
        notes.push({
          ...base,
          action: 'IMPRIMER',
          detail: `Le DG vous demande d’imprimer la note pour la signature du ministre (ordre de ${n.impressionOrdonneePar}).`,
          depuis: jours(n.impressionOrdonneeLe),
        });
    }
    if (
      u.role !== 'STRUCTURE' &&
      u.role !== 'DDEPPSA' &&
      u.role !== 'CABINET'
    ) {
      // Notes signées récemment : les anciennes (avant ce circuit) ne réclament pas leur scan
      const asigner = await this.notes
        .createQueryBuilder('n')
        .where("n.statut = 'SIGNEE'")
        .andWhere('n.scanFichier IS NULL')
        .andWhere("n.valideeLe > now() - interval '90 days'")
        .getMany();
      for (const n of asigner)
        notes.push({
          id: n.id,
          libelle: lib(n),
          module: n.module,
          action: 'SCANNER',
          detail: `Note n° ${n.numero} signée : joignez le scan PDF pour clôturer et archiver.`,
          depuis: jours(n.modifieLe),
        });
    }
    const dossiers: {
      id: string;
      numero: number;
      nomComplet: string;
      action: string;
      detail: string;
      depuis: number | null;
    }[] = [];
    const accordes = await this.demandes
      .createQueryBuilder('d')
      .where("(d.decision = 'ACCORDEE' OR d.instructionMinistre = 'ACCORDEE')")
      .andWhere('d.retiree = false')
      .getMany();
    for (const d of accordes) {
      const base = {
        id: d.id,
        numero: d.numeroEnregistrement,
        nomComplet: d.nomComplet,
      };
      // Seulement les décisions récentes, pas encore dans une note : les anciennes ne sont pas à renvoyer
      if (
        u.role === 'DG' &&
        !d.envoyeSecretariatLe &&
        !d.noteId &&
        d.canal !== 'IMPORT' &&
        d.decisionLe &&
        (jours(d.decisionLe) ?? 999) <= 60
      )
        dossiers.push({
          ...base,
          action: 'ENVOYER',
          detail:
            'Dossier accordé, pas encore envoyé au secrétariat : sans cela, la fiche et les pièces jointes ne seront pas imprimées.',
          depuis: jours(d.decisionLe),
        });
      if (
        u.role === 'SECRETARIAT' &&
        d.envoyeSecretariatLe &&
        (jours(d.envoyeSecretariatLe) ?? 0) <= 45
      )
        dossiers.push({
          ...base,
          action: 'IMPRIMER_DOSSIER',
          detail: 'Imprimez la fiche individuelle et les pièces jointes.',
          depuis: jours(d.envoyeSecretariatLe),
        });
    }
    return { notes, dossiers, total: notes.length + dossiers.length };
  }

  async supprimer(u: UtilisateurConnecte, id: string) {
    const n = await this.charger(id);
    if (n.statut !== 'BROUILLON')
      throw new BadRequestException(
        'Seule une note « à soumettre au DG » peut être supprimée',
      );
    await this.notes.delete(id);
    await this.journal.log(u, 'NOTE_SUPPRIMEE', 'note_service', id);
    return { ok: true };
  }

  /** La note au format Excel (mêmes informations que la version imprimée). */
  async excel(id: string): Promise<{ nom: string; contenu: Buffer }> {
    const n = await this.obtenir(id);
    const c = n.contenu;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Note de service', {
      pageSetup: {
        paperSize: 9,
        orientation: 'portrait',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
      },
    });
    const colonnes = c.classification
      ? [
          'N°',
          'Noms et prénoms',
          ...(c.colonnes.some((x) => x.cle === 'grade') ? ['Grade'] : []),
          'Cat',
          'Ech',
          'Echl',
          ...c.colonnes
            .filter((x) => !['nom', 'grade'].includes(x.cle))
            .map((x) => x.libelle),
        ]
      : ['N°', ...c.colonnes.map((x) => x.libelle.replace('-', ''))];
    const cles = c.classification
      ? [
          'n',
          'nom',
          ...(c.colonnes.some((x) => x.cle === 'grade') ? ['grade'] : []),
          'cat',
          'ech',
          'echl',
          ...c.colonnes
            .filter((x) => !['nom', 'grade'].includes(x.cle))
            .map((x) => x.cle),
        ]
      : ['n', ...c.colonnes.map((x) => x.cle)];
    ws.columns = cles.map((k) => ({
      width:
        k === 'nom'
          ? 34
          : k === 'n'
            ? 5
            : [
                  'reference',
                  'ancienPoste',
                  'structure',
                  'etablissement',
                ].includes(k)
              ? 24
              : 11,
    }));
    const texte = (v: string, gras = false, taille = 10) => {
      const r = ws.addRow([v]);
      ws.mergeCells(r.number, 1, r.number, cles.length);
      r.getCell(1).font = { bold: gras, size: taille };
      r.getCell(1).alignment = { wrapText: true, vertical: 'top' };
      return r;
    };
    texte(
      "MINISTERE DE L'ENSEIGNEMENT PRESCOLAIRE, PRIMAIRE, SECONDAIRE ET DE L'ALPHABETISATION — CABINET — DGRHAS — DRSC",
      true,
      9,
    );
    texte(`N° ${n.numero ?? '________'}/${n.entete.reference}`, true);
    texte('');
    const t = texte(c.titre, true, 14);
    t.getCell(1).alignment = { horizontal: 'center' };
    const intro = texte(c.introduction);
    intro.height = 60;
    const bord: Partial<ExcelJS.Borders> = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' },
    };
    for (const sec of c.sections) {
      texte('');
      if (sec.titre) texte(sec.titre, true);
      if (sec.sousTitre) texte(`      ${sec.sousTitre}`, true);
      const e = ws.addRow(colonnes);
      e.eachCell((cell) => {
        cell.font = { bold: true, size: 9 };
        cell.border = bord;
        cell.alignment = {
          horizontal: 'center',
          vertical: 'middle',
          wrapText: true,
        };
      });
      for (const l of sec.lignes) {
        const r = ws.addRow(cles.map((k) => l[k] ?? null));
        r.eachCell({ includeEmpty: true }, (cell, i) => {
          if (i > cles.length) return;
          cell.font = { size: 9 };
          cell.border = bord;
        });
      }
    }
    texte('');
    for (const m of c.mentions) texte(m);
    texte('');
    texte(`Fait à ${n.entete.lieu}, le ${n.dateSignature ?? ''}`);
    texte(n.entete.signataireTitre);
    texte(n.entete.signataireNom, true);
    texte('');
    texte('Ampliations :', true);
    for (const a of c.ampliations) {
      const r = ws.addRow([a.libelle, null, a.nombre]);
      r.font = { size: 9 };
    }
    return {
      nom: `${n.libelle
        .replace(/[^\p{L}\p{N} ()-]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()}.xlsx`,
      contenu: Buffer.from(await wb.xlsx.writeBuffer()),
    };
  }
}
