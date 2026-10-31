import {
  anomaliesAJour,
  dateFr,
  NAISSANCE_IMPROBABLE,
  naissanceImprobable,
} from '../common/anomalies';
import {
  LIBELLE_CYCLE,
  NOTES_AFFECTATION,
  type Cycle,
  type TypeNoteAffectation,
} from '../common/referentiels';
import { ageRevolu, dateEnLettres } from '../common/texte';
import type {
  Affectation,
  Agent,
  Grade,
  GradeChoisi,
  RegleDiplome,
} from '../entities';

export interface ParametresCalcul {
  /** Catégories II et III : contractuel au-delà de cet âge. */
  ageLimite: number;
  /** Catégorie I : contractuel au-delà de cet âge. */
  ageLimiteCatI: number;
  /**
   * L'âge se compte de la date de naissance à la date de signature du texte de la FP
   * (décision du DG, 2026-10-18). Sans texte signé : à cette date (aujourd'hui), à
   * titre de prévision seulement.
   */
  dateReference: string;
  pointIndiciaire: number;
}

export interface Derive {
  cycle: Cycle | null;
  cycleLibelle: string | null;
  grade: string | null;
  categorie: string | null;
  echelle: number | null;
  echelon: number | null;
  indice: number | null;
  /** Salaire brut mensuel = indice × point indiciaire (incidence mensuelle). */
  salaireBrut: number | null;
  contractuel: boolean | null;
  /** true si le statut vient de l'arrêté (saisi), false si calculé par l'âge. */
  contractuelImpose: boolean;
  age: number | null;
  dateSignature: string | null;
  reference: string | null;
  /** Problèmes qui empêchent de mettre la ligne dans une note. */
  bloquants: string[];
  /** Avertissements (n'empêchent pas la note). */
  avertissements: string[];
}

/** Âge au-delà duquel l'agent est contractuel : 35 ans en catégorie I, 30 ans sinon. */
export function ageLimiteContractuel(
  categorie: string | null | undefined,
  p: ParametresCalcul,
) {
  return categorie?.trim().toUpperCase() === 'I'
    ? p.ageLimiteCatI
    : p.ageLimite;
}

type AgentAge = Pick<Agent, 'dateNaissance' | 'contractuelForce'> &
  Partial<Pick<Agent, 'dateSignatureTexte' | 'typeTexte' | 'lotPublication'>>;

/** Date de signature du texte de la FP : celle du texte, sinon celle du lot. */
export function dateSignatureTexte(agent: AgentAge): string | null {
  const lot = agent.lotPublication;
  return (
    agent.dateSignatureTexte ??
    (agent.typeTexte === 'DECRET'
      ? lot?.dateSignatureDecrets
      : lot?.dateSignatureArretes) ??
    null
  );
}

export function estContractuel(
  agent: AgentAge,
  p: ParametresCalcul,
  categorie?: string | null,
): {
  contractuel: boolean | null;
  age: number | null;
  impose: boolean;
  /** Date à laquelle l'âge est compté. */
  dateAge: string;
  /** true tant que le texte n'est pas signé : le statut n'est qu'une prévision. */
  provisoire: boolean;
} {
  const signature = dateSignatureTexte(agent);
  const dateAge = signature ?? p.dateReference;
  const provisoire = !signature;
  const age = agent.dateNaissance
    ? ageRevolu(agent.dateNaissance, dateAge)
    : null;
  if (agent.contractuelForce !== null && agent.contractuelForce !== undefined)
    return {
      contractuel: agent.contractuelForce,
      age,
      impose: true,
      dateAge,
      provisoire: false,
    };
  if (age === null)
    return { contractuel: null, age, impose: false, dateAge, provisoire };
  return {
    contractuel: age > ageLimiteContractuel(categorie, p),
    age,
    impose: false,
    dateAge,
    provisoire,
  };
}

/**
 * Règle du diplôme d'une personne, avec le grade choisi pour elle à la place du grade par défaut
 * (DG, 31/10/2026) : grade, catégorie, échelle, échelon et indice sont alors ceux du grade choisi.
 */
export function regleDeLAgent(
  a: Pick<Agent, 'diplomeCode'> & { gradeChoisi?: Agent['gradeChoisi'] },
  regles: Map<string, RegleDiplome>,
): RegleDiplome | undefined {
  const r = a.diplomeCode ? regles.get(a.diplomeCode) : undefined;
  const g = a.gradeChoisi;
  if (!r || !g) return r;
  return {
    ...r,
    gradeCode: g.code,
    grade: g.abreviation,
    gradeLibelle: g.libelle,
    categorie: g.categorie,
    echelle: g.echelle,
    echelon: g.echelon,
    indice: g.indice,
  };
}

/** Motif posé sur l'affectation d'un oublié déclaré déjà affecté (liste des oubliés). */
export const MOTIF_OUBLI_DEJA_AFFECTE = 'Déjà affecté (contrôle des oubliés)';

/** Copie d'un grade choisi pour une personne (sa classification suit ensuite le grade). */
export function copieGrade(g: Grade, par: string): GradeChoisi {
  return {
    code: g.code,
    abreviation: g.abreviation,
    libelle: g.libelle,
    categorie: g.categorie,
    echelle: g.echelle,
    echelon: g.echelon,
    indice: g.indice,
    par,
    le: new Date().toISOString(),
  };
}

/** Grade affiché : « Inst. » -> « Inst.C. » pour un contractuel. */
export function gradeAffiche(
  grade: string | null,
  contractuel: boolean | null,
): string | null {
  if (!grade) return null;
  return contractuel ? `${grade.replace(/\.+$/, '')}.C.` : grade;
}

/** Salaire brut mensuel au recrutement (FCFA). */
export function salaireBrut(
  indice: number | null | undefined,
  p: ParametresCalcul,
): number | null {
  return indice ? indice * p.pointIndiciaire : null;
}

export function referenceTexte(agent: Agent): {
  date: string | null;
  reference: string | null;
} {
  const date = dateSignatureTexte(agent);
  if (!agent.numeroTexte) return { date, reference: null };
  const lettres = dateEnLettres(date);
  return {
    date,
    reference: lettres
      ? `${agent.numeroTexte} du ${lettres}`
      : agent.numeroTexte,
  };
}

export function deriver(
  aff: Affectation,
  regles: Map<string, RegleDiplome>,
  p: ParametresCalcul,
): Derive {
  const agent = aff.agent;
  const regle = regleDeLAgent(agent, regles);
  const { contractuel, age, impose, dateAge } = estContractuel(
    agent,
    p,
    regle?.categorie,
  );
  const { date, reference } = referenceTexte(agent);
  const def = NOTES_AFFECTATION[aff.typeNote as TypeNoteAffectation];

  const bloquants: string[] = [];
  const avertissements: string[] = [];
  if (!regle)
    bloquants.push(`Diplôme non reconnu (« ${agent.diplomeBrut ?? '—'} »)`);
  else if (!regle.grade)
    bloquants.push(
      regle.code === 'SANS_DIPLOME'
        ? 'Sans diplôme : grade à choisir (Détails de la note)'
        : `Grade non défini pour le diplôme ${regle.libelle}`,
    );
  if (!def) bloquants.push('Type de note à définir');
  // Ajoutée à la main : elle attend le contrôle des oubliés (DG, 31/10/2026)
  if (agent.oubli === 'A_CONTROLER')
    bloquants.push(
      'Ajoutée à la main : à contrôler (Base des recrutés › Oubliés à contrôler)',
    );
  if (def?.parDepartement && !aff.departementId)
    bloquants.push('Département retenu manquant');
  if (aff.typeNote === 'PERS_ADM' && !aff.structure)
    bloquants.push('Structure manquante');
  if (aff.typeNote === 'ETS' && !aff.etablissement)
    bloquants.push('Établissement manquant');
  if (!agent.numeroTexte) bloquants.push('Numéro du texte manquant');
  if (!date)
    bloquants.push(
      'Date de signature du texte manquante (à renseigner sur le lot)',
    );
  if (contractuel === null)
    bloquants.push(
      'Date de naissance illisible : statut contractuel à préciser',
    );
  // Âge impossible (« 2018 » pour « 1988 ») : le statut calculé serait faux. Le statut écrit
  // sur le texte de la FP (contractuelForce) suffit à lever le blocage.
  else if (
    !impose &&
    agent.dateNaissance &&
    naissanceImprobable(agent.dateNaissance, dateAge)
  )
    bloquants.push(
      `${NAISSANCE_IMPROBABLE} (${dateFr(agent.dateNaissance)} : ${age} ans au ${dateFr(dateAge)}) : statut contractuel à préciser`,
    );
  // Spécialité absente : elle ne bloque pas la note, mais se signale à tous les cycles
  // (DG, 28/10/2026), avec insistance au collège et au lycée où elle dit la matière enseignée
  if (!aff.specialite)
    avertissements.push(
      regle?.cycle === 'COLLEGE' || regle?.cycle === 'LYCEE'
        ? `Spécialité non renseignée (obligatoire au ${regle.cycle === 'LYCEE' ? 'lycée' : 'collège'} : la matière enseignée)`
        : 'Spécialité non renseignée',
    );
  // Seulement les anomalies encore vraies d'après la fiche telle qu'elle est
  for (const a of anomaliesAJour(agent)) avertissements.push(a);

  return {
    cycle: (regle?.cycle as Cycle) ?? null,
    cycleLibelle: regle ? LIBELLE_CYCLE[regle.cycle as Cycle] : null,
    grade: gradeAffiche(regle?.grade ?? null, contractuel),
    categorie: regle?.categorie ?? null,
    echelle: regle?.echelle ?? null,
    echelon: regle?.echelon ?? null,
    indice: regle?.indice ?? null,
    salaireBrut: salaireBrut(regle?.indice, p),
    contractuel,
    contractuelImpose: impose,
    age,
    dateSignature: date,
    reference,
    bloquants,
    avertissements,
  };
}
