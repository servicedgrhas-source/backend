import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { StockageService } from '../common/stockage';
import { cleCompacte } from '../common/texte';
import { JournalService, ParametresService } from '../core/core.service';
import { AgentRecense, EvenementCarriere, Referentiel } from '../entities';
import type { ChampFiche } from './configuration';
import { parcoursDe, RecensementService } from './recensement.service';
import {
  estVide,
  lireValeur,
  prochainAvancement,
  valeurLisible,
  echellesDe,
  promotionsAttendues,
  trouverEchelle,
} from './valeurs';

/**
 * Dossier de carrière d'un agent (DG, réunion de cadrage du 21/10/2026) : tout ce qui lui est
 * arrivé depuis son entrée, chaque fois avec son acte, pour que le bureau du fichier puisse
 * reconstituer son dossier. Il réunit :
 * - ses statuts successifs (volontaire, puis fonctionnaire au texte d'intégration…) ;
 * - ses affectations (notes d'enrôlement et d'affectation, affectations anciennes de la fiche) ;
 * - ses mutations et prestations accordées (note signée) ;
 * - les événements saisis ici : avancements, reclassement, nomination, position, sortie…
 */

/** Rubriques de la fiche qu'un type d'événement peut changer. */
const SITUATION = ['GRADE', 'CATEGORIE', 'ECHELLE', 'ECHELON', 'INDICE_SOLDE'];
export const TYPES_CARRIERE: Record<
  string,
  {
    libelle: string;
    champs: string[];
    aide?: string;
    /** Ancien type : il s'affiche encore, mais ne se choisit plus pour un nouvel événement. */
    ancien?: boolean;
  }
> = {
  ENTREE: {
    libelle: 'Intégration ou engagement (situation à l’entrée)',
    champs: SITUATION,
    aide: 'Fonctionnaire : arrêté ou décret d’intégration (et de titularisation). Contractuel : arrêté ou décret d’engagement. Grade, échelle et échelon à l’entrée.',
  },
  PROMOTION: {
    libelle: 'Promotion (fonctionnaire)',
    champs: SITUATION,
    aide: 'Ordinaire tous les 2 ans ; arrêté de promotion.',
  },
  AVANCEMENT: {
    libelle: 'Avancement (contractuel)',
    champs: SITUATION,
    aide: 'Ordinaire tous les 2 ans et 4 mois ; arrêté d’avancement.',
  },
  EXCEPTIONNEL: {
    libelle: 'Promotion ou avancement exceptionnel',
    champs: SITUATION,
    aide: 'Agent excellent promu avant le délai (ex. 1 an et 8 mois), selon le décret.',
  },
  RECLASSEMENT: {
    libelle: 'Reclassement',
    champs: SITUATION,
    aide: 'Grade supérieur grâce à un diplôme supérieur, avant ou après l’intégration ; arrêté de reclassement.',
  },
  RCA: {
    libelle: 'Révision de la carrière administrative (fonctionnaire)',
    champs: SITUATION,
    aide: 'Changement de grade après 3 ans d’ancienneté et une formation sanctionnée par un diplôme supérieur ; arrêté.',
  },
  TITULARISATION: {
    libelle: 'Titularisation (contractuel devenu fonctionnaire)',
    champs: SITUATION,
    aide: 'Au premier échelon, à la demande de l’agent ; arrêté de titularisation.',
  },
  RSA: {
    libelle: 'Révision de la situation administrative (contractuel)',
    champs: SITUATION,
    aide: 'Contractuel titularisé : prise en compte de son ancienneté et, le cas échéant, de sa nouvelle qualification ; arrêté.',
  },
  REINTEGRATION: {
    libelle: 'Réintégration',
    champs: SITUATION,
    aide: 'Agent radié, déserteur… repris avec la situation qu’il avait.',
  },
  AVANCEMENT_ECHELON: {
    libelle: 'Avancement d’échelon',
    champs: ['ECHELON', 'INDICE_SOLDE'],
    ancien: true,
  },
  AVANCEMENT_GRADE: {
    libelle: 'Avancement de grade',
    champs: SITUATION,
    ancien: true,
  },
  AFFECTATION: {
    libelle: 'Affectation (antérieure au système)',
    champs: ['LIEU_SERVICE'],
    aide: 'Les notes d’affectation signées dans le système s’ajoutent seules.',
  },
  MUTATION: {
    libelle: 'Mutation (antérieure au système)',
    champs: ['LIEU_SERVICE'],
    aide: 'Les mutations accordées dans le système s’ajoutent seules.',
  },
  NOMINATION: {
    libelle: 'Nomination à une fonction',
    champs: ['FONCTION', 'LIEU_SERVICE'],
  },
  FIN_FONCTION: { libelle: 'Fin de fonction', champs: ['FONCTION'] },
  POSITION: {
    libelle: 'Changement de position',
    champs: ['POSITION'],
    aide: 'Détachement, disponibilité, congé de longue durée, retour en activité…',
  },
  DISTINCTION: { libelle: 'Distinction, félicitations', champs: [] },
  SANCTION: { libelle: 'Sanction disciplinaire', champs: [] },
  SORTIE: {
    libelle: 'Sortie (retraite, décès, démission…)',
    champs: ['POSITION', 'STATUT_ACTIVITE'],
  },
  AUTRE: { libelle: 'Autre événement', champs: [] },
};

export const NATURES_ACTE: Record<string, string> = {
  DECRET: 'Décret',
  ARRETE: 'Arrêté',
  NOTE_SERVICE: 'Note de service',
  DECISION: 'Décision',
  AUTRE: 'Autre acte',
};

export interface EvenementDto {
  type: string;
  dateEffet: string;
  acteNature?: string | null;
  acteNumero?: string | null;
  acteDate?: string | null;
  nouveau?: Record<string, unknown>;
  commentaire?: string | null;
  /** Mettre la fiche à jour (non : événement ancien, pour l'historique seulement). */
  reporter?: boolean;
  /** Modification d'un événement déjà saisi avec un ancien type : gardé tel quel. */
  ancienAccepte?: boolean;
}

export interface ElementCarriere {
  genre:
    | 'STATUT'
    | 'GRADE'
    | 'AFFECTATION'
    | 'MUTATION'
    | 'PRESTATION'
    | 'EVENEMENT'
    | 'EVALUATION';
  id: string;
  date: string | null;
  type: string | null;
  /** Colonne « Nature » : intégration, engagement, promotion, affectation… */
  nature: string;
  intitule: string;
  acte: string | null;
  lieu: string | null;
  changements: {
    champ: string;
    libelle: string;
    de: string | null;
    vers: string;
  }[];
  commentaire: string | null;
  fichier: boolean;
  /** D'où vient l'élément : « Saisi par X », « Note de service »… */
  origine: string | null;
  /** Événement saisi ici (modifiable et annulable). */
  modifiable: boolean;
  /** Ses valeurs sont celles de la fiche (sinon un événement plus récent les a remplacées). */
  reporte?: boolean;
  /** Pour modifier l'événement saisi. */
  saisie?: Pick<
    EvenementCarriere,
    | 'type'
    | 'dateEffet'
    | 'acteNature'
    | 'acteNumero'
    | 'acteDate'
    | 'nouveau'
    | 'commentaire'
  >;
}

/** Même valeur (texte, nombre ou absente). */
const egal = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const dateFr = (d: string | null | undefined) =>
  d ? d.slice(0, 10).split('-').reverse().join('/') : '';
const texte = (v: unknown) => (estVide(v) ? null : String(v).trim());
const court = (v: unknown, n: number) =>
  texte(v)?.replace(/\s+/g, ' ').slice(0, n) ?? null;
/** Ordre chronologique ; à date égale, l'ordre de saisie. */
const ordre = (a: EvenementCarriere, b: EvenementCarriere) =>
  (a.dateEffet ?? '').localeCompare(b.dateEffet ?? '') ||
  a.creeLe.getTime() - b.creeLe.getTime();

/** Acte d'entrée selon le statut : le fonctionnaire est intégré, le contractuel engagé. */
const ENTREE: Record<
  string,
  { nature: string; premier: string; suite: string }
> = {
  FONCTIONNAIRE: {
    nature: 'Intégration',
    premier: 'Intégration comme fonctionnaire',
    suite: 'Intégration : devient fonctionnaire',
  },
  CONTRACTUEL: {
    nature: 'Engagement',
    premier: 'Engagement comme contractuel',
    suite: 'Engagement : devient contractuel',
  },
};

/**
 * Lieu de service lisible : « À la disposition de la DDEPPSA Pool » devient « DDEPPSA Pool », le
 * nom développé d'une direction départementale devient « DDEPPSA » (DG, 24/10/2026).
 */
export function lieuCourt(lieu: string | null | undefined): string | null {
  const t = (lieu ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const dispo = /^[àa] la disposition de (la |l[’'])?(.+)$/i.exec(t);
  if (dispo) return dispo[2];
  const ddep =
    /^direction d[ée]partementale de l[’']enseignement pr[ée]scolaire.*?(?:\(([^)]+)\))?$/i.exec(
      t,
    );
  if (ddep) return `DDEPPSA${ddep[1] ? ` ${ddep[1]}` : ''}`;
  return t;
}

@Injectable()
export class CarriereService {
  constructor(
    @InjectRepository(EvenementCarriere)
    private readonly evenements: Repository<EvenementCarriere>,
    @InjectRepository(AgentRecense)
    private readonly agents: Repository<AgentRecense>,
    @InjectRepository(Referentiel)
    private readonly refs: Repository<Referentiel>,
    private readonly rec: RecensementService,
    private readonly journal: JournalService,
    private readonly stockage: StockageService,
    private readonly params: ParametresService,
  ) {}

  /** Rubriques actives de la fiche, par code. */
  private champs() {
    return new Map(
      this.rec.config
        .get()
        .champs.filter((c) => c.actif)
        .map((c) => [c.code, c] as const),
    );
  }

  /** Types d'événement et rubriques qu'ils changent (seulement celles de la fiche). */
  catalogue() {
    const ch = this.champs();
    const rubrique = (c: ChampFiche) => ({
      code: c.code,
      libelle: c.libelle,
      type: c.type,
      referentiel: c.referentiel ?? null,
      options: (c.options ?? []).map((o) => ({
        code: o.code,
        libelle: o.libelle,
      })),
    });
    return {
      types: Object.entries(TYPES_CARRIERE).map(([code, t]) => ({
        code,
        libelle: t.libelle,
        aide: t.aide ?? null,
        ancien: !!t.ancien,
        rubriques: t.champs
          .map((c) => ch.get(c))
          .filter((c): c is ChampFiche => !!c)
          .map(rubrique),
      })),
      actes: Object.entries(NATURES_ACTE).map(([code, libelle]) => ({
        code,
        libelle,
      })),
    };
  }

  /** Valeur lisible d'une rubrique (code d'une liste → son libellé). */
  private lisible(ch: ChampFiche | undefined, v: unknown) {
    if (estVide(v)) return null;
    const o = ch?.options?.find((x) => x.code === v);
    return o?.libelle ?? texte(v);
  }

  /* ------------------------------ Lecture ------------------------------ */

  async dossier(u: UtilisateurConnecte, id: number) {
    const a = await this.rec.trouver(u, id);
    const ch = this.champs();
    const c = this.rec.config.get();
    const libelleStatut = (s: string) =>
      c.statuts.find((x) => x.code === s)?.libelle ?? s;
    const elements: ElementCarriere[] = [];

    // 1. Statuts successifs
    const parcours = parcoursDe(a);
    parcours.forEach((e, i) => {
      const entree = ENTREE[e.statut];
      elements.push({
        genre: 'STATUT',
        id: `statut-${i}`,
        // Un seul statut connu : sa date est celle du recrutement (ou de l'intégration) de la fiche
        date:
          e.depuis ??
          (parcours.length === 1 ? texte(a.donnees.DATE_RECRUTEMENT) : null),
        type: e.statut,
        nature: entree?.nature ?? 'Recrutement',
        intitule: entree
          ? i === 0
            ? entree.premier
            : entree.suite
          : i === 0
            ? `Recrutement comme ${libelleStatut(e.statut).toLowerCase()}`
            : `Devient ${libelleStatut(e.statut).toLowerCase()}`,
        // Un seul statut : son texte est celui de la fiche (nature et référence)
        acte:
          e.texte ??
          (parcours.length === 1 ? this.texteEntree(a.donnees, ch) : null),
        lieu: null,
        changements: [],
        commentaire: null,
        fichier: false,
        origine: e.par,
        modifiable: false,
      });
    });

    // Grade et échelon successifs saisis dans la fiche
    const grades = (
      Array.isArray(a.donnees.PROMOTIONS) ? a.donnees.PROMOTIONS : []
    ) as Record<string, unknown>[];
    const colNature = ch
      .get('PROMOTIONS')
      ?.colonnes.find((x) => x.code === 'NATURE');
    grades.forEach((l, i) => {
      if (!l || typeof l !== 'object') return;
      const nature =
        colNature?.options.find((o) => o.code === l.NATURE)?.libelle ??
        texte(l.NATURE) ??
        'Changement de grade ou d’échelon';
      elements.push({
        genre: 'GRADE',
        id: `grade-${i}`,
        date: texte(l.DATE),
        type: texte(l.NATURE),
        nature: nature.replace(/\s*\((fonctionnaire|contractuel)\)$/, ''),
        intitule: nature,
        acte: texte(l.TEXTE),
        lieu: null,
        changements: (
          [
            ['GRADE', 'Grade'],
            ['ECHELON', 'Échelon'],
          ] as const
        ).flatMap(([champ, libelle]) => {
          const vers = texte(l[champ]);
          return vers ? [{ champ, libelle, de: null, vers }] : [];
        }),
        commentaire: null,
        fichier: false,
        origine: 'Fiche (grade et échelon successifs)',
        modifiable: false,
      });
    });

    // 2. Affectations de la fiche (notes signées, affectations anciennes)
    const lignes = (
      Array.isArray(a.donnees.AFFECTATIONS_SUCCESSIVES)
        ? a.donnees.AFFECTATIONS_SUCCESSIVES
        : []
    ) as { NOTE?: string; DATE?: string; LIEU?: string }[];
    lignes.forEach((l, i) =>
      elements.push({
        genre: 'AFFECTATION',
        id: `affectation-${i}`,
        date: l.DATE ?? this.dateDansNote(l.NOTE),
        type: null,
        nature: 'Affectation',
        intitule: /enr[ôo]lement/i.test(l.NOTE ?? '')
          ? 'Affectation comme volontaire'
          : i === 0
            ? 'Première affectation'
            : 'Affectation',
        acte: l.NOTE ?? null,
        lieu: lieuCourt(l.LIEU),
        changements: [],
        commentaire: l.DATE ? `Prise de service le ${dateFr(l.DATE)}` : null,
        fichier: false,
        origine: 'Fiche (affectations successives)',
        modifiable: false,
      }),
    );

    // 3. Mutations et prestations accordées (note signée)
    for (const m of await this.mutations(a))
      elements.push({
        genre: m.prestation ? 'PRESTATION' : 'MUTATION',
        id: `demande-${m.id}`,
        date: m.dateSignature,
        type: m.typePrestation,
        nature: m.prestation ? 'Prestation' : 'Mutation',
        intitule: m.prestation ?? 'Mutation',
        acte: m.numero
          ? `Note n° ${m.numero}${m.dateSignature ? ` du ${dateFr(m.dateSignature)}` : ''}`
          : `${m.acte ?? 'Acte'} n° ${String(m.numeroDemande).padStart(4, '0')}/${m.decideur ?? 'DGRHAS'}`,
        lieu: m.prestation
          ? null
          : [m.lieuSollicite, m.departement].filter(Boolean).join(', ') || null,
        changements: [],
        commentaire: m.prestation ? m.objet : m.motif,
        fichier: false,
        origine: 'Demande accordée',
        modifiable: false,
      });

    // Évaluations annuelles (compétence professionnelle et sociale, sur 5)
    const evaluations = await this.agents.query<
      {
        id: string;
        annee: string;
        date: string;
        pro: number;
        social: number;
        globale: number;
        appreciation: string;
        decision: string | null;
        evaluateur: string | null;
      }[]
    >(
      `SELECT id, annee, to_char(date, 'YYYY-MM-DD') AS date, "competenceProfessionnelle" AS pro,
              "competenceSociale" AS social, globale, appreciation, decision, evaluateur
         FROM evaluation_agent WHERE "agentId" = $1 AND "valideeLe" IS NOT NULL`,
      [id],
    );
    for (const e of evaluations)
      elements.push({
        genre: 'EVALUATION',
        id: `evaluation-${e.id}`,
        date: e.date,
        type: null,
        nature: 'Évaluation',
        intitule: `Évaluation ${e.annee} : ${e.appreciation.toLowerCase()} (${String(e.globale).replace('.', ',')}/5)`,
        acte: null,
        lieu: null,
        changements: [],
        commentaire: [
          `Compétence professionnelle ${e.pro}/5, compétence sociale ${e.social}/5`,
          e.decision,
        ]
          .filter(Boolean)
          .join(' · '),
        fichier: false,
        origine: e.evaluateur ? `Évalué par ${e.evaluateur}` : null,
        modifiable: false,
      });

    // 4. Événements saisis
    const evs = (await this.evenements.find({ where: { agentId: id } })).sort(
      ordre,
    );
    const precedent: Record<string, unknown> = {};
    for (const e of evs) {
      const t = TYPES_CARRIERE[e.type];
      elements.push({
        genre: 'EVENEMENT',
        id: e.id,
        date: e.dateEffet,
        type: e.type,
        nature: (t?.libelle ?? 'Carrière').replace(
          /\s*\((fonctionnaire|contractuel|contractuel devenu fonctionnaire|situation à l’entrée)\)$/,
          '',
        ),
        intitule: t?.libelle ?? e.type,
        acte: this.acte(e),
        lieu: texte(e.nouveau.LIEU_SERVICE),
        changements: Object.entries(e.nouveau)
          .filter(([k]) => k !== 'LIEU_SERVICE' || e.type === 'NOMINATION')
          .map(([k, v]) => {
            const de = e.reporte && k in e.avant ? e.avant[k] : precedent[k];
            return {
              champ: k,
              // « Grade actuel » : dans l'historique, c'est le grade de ce moment-là
              libelle: (ch.get(k)?.libelle ?? k).replace(
                /\s+actuel(le)?$/i,
                '',
              ),
              de: this.lisible(ch.get(k), de),
              vers: this.lisible(ch.get(k), v) ?? '',
            };
          }),
        commentaire: e.commentaire,
        fichier: !!e.fichier,
        origine: e.creePar ? `Saisi par ${e.creePar}` : null,
        modifiable: true,
        reporte: e.reporte,
        saisie: {
          type: e.type,
          dateEffet: e.dateEffet,
          acteNature: e.acteNature,
          acteNumero: e.acteNumero,
          acteDate: e.acteDate,
          nouveau: e.nouveau,
          commentaire: e.commentaire,
        },
      });
      Object.assign(precedent, e.nouveau);
    }

    // Ordre chronologique ; un élément sans date reste après le précédent de même nature
    const rang = new Map(elements.map((e, i) => [e, i]));
    const cle = (e: ElementCarriere) => e.date ?? '';
    elements.sort((x, y) => {
      if (x.date && y.date)
        return cle(x).localeCompare(cle(y)) || rang.get(x)! - rang.get(y)!;
      return rang.get(x)! - rang.get(y)!;
    });

    const lisible = (k: string) => {
      const x = ch.get(k);
      return x ? valeurLisible(x, a.donnees[k]) || null : null;
    };
    const enfants = (
      Array.isArray(a.donnees.ENFANTS) ? a.donnees.ENFANTS : []
    ) as Record<string, unknown>[];
    return {
      agent: {
        id: a.id,
        numeroFiche: a.numeroFiche,
        nomComplet: a.nomComplet,
        dateNaissance: a.dateNaissance,
        lieuNaissance: lisible('LIEU_NAISSANCE'),
        genre: lisible('GENRE'),
        nationalite: lisible('NATIONALITE'),
        matricule: a.matricule,
        statut: a.statut,
        libelleStatut: libelleStatut(a.statut),
      },
      famille: {
        situationMatrimoniale: lisible('SITUATION_MATRIMONIALE'),
        nombreEnfants: texte(a.donnees.NOMBRE_ENFANTS),
        enfants: enfants
          .filter((x) => x && typeof x === 'object')
          .map((x) => ({
            nom: texte(x.NOM),
            naissance: texte(x.NAISSANCE),
            pere: texte(x.PERE),
            mere: texte(x.MERE),
          })),
      },
      signature: {
        titre: this.params.get('DG_TITRE'),
        nom: this.params.get('DG_NOM') || null,
        lieu: this.params.get('LIEU_SIGNATURE'),
      },
      situation: await this.situation(a, evs),
      elements,
      ...this.catalogue(),
    };
  }

  /** « Arrêté n° 21996/MFPTSS/DGFP du 31/12/2025 » : nature et référence du texte d'entrée. */
  private texteEntree(d: Record<string, unknown>, ch: Map<string, ChampFiche>) {
    const ref = texte(d.TEXTE_RECRUTEMENT);
    if (!ref) return null;
    const c = ch.get('NATURE_TEXTE_RECRUTEMENT');
    const nature = c ? valeurLisible(c, d.NATURE_TEXTE_RECRUTEMENT) : '';
    return nature && !cleCompacte(ref).startsWith(cleCompacte(nature))
      ? `${nature} ${ref}`
      : ref;
  }

  private acte(e: EvenementCarriere) {
    if (!e.acteNature && !e.acteNumero) return null;
    return [
      e.acteNature ? (NATURES_ACTE[e.acteNature] ?? e.acteNature) : 'Acte',
      e.acteNumero ? `n° ${e.acteNumero}` : null,
      e.acteDate ? `du ${dateFr(e.acteDate)}` : null,
    ]
      .filter(Boolean)
      .join(' ');
  }

  /** « Note n° 12 du 05/09/2026 » → 2026-09-05. */
  private dateDansNote(note?: string) {
    const m = /du (\d{2})\/(\d{2})\/(\d{4})/.exec(note ?? '');
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
  }

  /** Mutations et prestations accordées de la même personne (matricule, sinon nom identique). */
  private async mutations(a: AgentRecense) {
    const lignes = await this.agents.query<
      {
        id: string;
        nomComplet: string;
        matricule: string | null;
        numero: string | null;
        dateSignature: string | null;
        lieuSollicite: string | null;
        departement: string | null;
        motif: string;
        objet: string | null;
        typePrestation: string | null;
        prestation: string | null;
        acte: string | null;
        decideur: string | null;
        numeroDemande: number;
        agentId: number | null;
      }[]
    >(
      `SELECT d.id, d."nomComplet", d.matricule, n.numero,
              to_char(coalesce(n."dateSignature", d."decisionLe"::date), 'YYYY-MM-DD') AS "dateSignature",
              d."lieuSollicite", dep.nom AS departement, d.motif, d.objet, d."typePrestation",
              CASE WHEN t."motifMutation" IS NULL AND d."typePrestation" IS NOT NULL THEN t.libelle END AS prestation,
              t.acte, d.circuit->-1->>'sigle' AS decideur, d."numeroEnregistrement" AS "numeroDemande", d."agentId"
         FROM demande_mutation d
         LEFT JOIN note_service n ON n.id = d."noteId" AND n.statut = 'SIGNEE'
         LEFT JOIN departement dep ON dep.id = d."departementSolliciteId"
         LEFT JOIN type_prestation t ON t.code = d."typePrestation"
        WHERE d.decision = 'ACCORDEE' AND NOT d.retiree
          -- Une mutation compte à la signature de sa note ; une autre prestation dès qu'elle est accordée (acte)
          AND (n.id IS NOT NULL OR d.motif = 'PRESTATION')
          AND (d."agentId" = $3 OR ($1::text IS NOT NULL AND upper(d.matricule) = upper($1)) OR d."nomComplet" ILIKE $2)`,
      [a.matricule, `%${a.nomComplet.split(/\s+/)[0] ?? ''}%`, a.id],
    );
    const nom = cleCompacte(a.nomComplet);
    return lignes.filter(
      (l) =>
        l.agentId === a.id ||
        (!!a.matricule &&
          cleCompacte(l.matricule) === cleCompacte(a.matricule)) ||
        (!l.matricule && cleCompacte(l.nomComplet) === nom),
    );
  }

  /** Situation actuelle : statut, grade, dernière promotion (ou dernier avancement) et le prochain. */
  private async situation(a: AgentRecense, evs: EvenementCarriere[]) {
    const ch = this.champs();
    const d = a.donnees;
    const valeurs = Object.fromEntries(
      [
        ...SITUATION,
        'DATE_GRADE',
        'FONCTION',
        'LIEU_SERVICE',
        'POSITION',
        'STATUT_ACTIVITE',
      ]
        .filter((k) => ch.has(k))
        .map((k) => [
          k,
          {
            libelle: ch.get(k)!.libelle,
            valeur: this.lisible(ch.get(k), d[k]),
          },
        ]),
    );
    if (valeurs.LIEU_SERVICE?.valeur)
      valeurs.LIEU_SERVICE.valeur = lieuCourt(valeurs.LIEU_SERVICE.valeur);
    // Dernière promotion (fonctionnaire) ou dernier avancement (contractuel), puis le prochain dû
    const dernier = [...evs]
      .reverse()
      .find(
        (e) => ('ECHELON' in e.nouveau || 'GRADE' in e.nouveau) && e.dateEffet,
      );
    // Échelles de la grille (Administration › Référentiels › Échelles)
    const echelles = echellesDe(
      await this.refs.find({ where: { type: 'ECHELLE', actif: true } }),
    );
    const conf = this.rec.config.get();
    const av = prochainAvancement(
      conf,
      a.statut,
      {
        ...d,
        DATE_GRADE:
          [texte(d.DATE_GRADE), dernier?.dateEffet]
            .filter((x): x is string => !!x)
            .sort()
            .at(-1) ?? null,
      },
      echelles,
    );
    const ech = trouverEchelle(echelles, d.ECHELLE);
    const duree = ech?.dureeEchelonMois ?? null;
    const nombre = ech?.nombreEchelons ?? null;
    const echelon = Number(texte(d.ECHELON)) || null;
    const dernierEchelon = !!av?.fin;
    // Promotions (ou avancements) attendues depuis la dernière, échelon par échelon, en respectant
    // l'échelle de l'agent (durée d'un échelon, dernier échelon, échelle suivante)
    const attendues = av
      ? promotionsAttendues({
          depuis: av.depuis,
          delaiMois:
            av.nature === 'PROMOTION'
              ? conf.delaiPromotionMois
              : conf.delaiAvancementMois,
          dureeEchelle: av.nature === 'PROMOTION',
          echelon,
          echelle: ech,
          echelles,
          aujourdhui: new Date().toISOString().slice(0, 10),
        })
      : [];
    const echelle = ech;
    return {
      valeurs,
      // Fonctionnaire : « date de dernière promotion » ; contractuel : « date du dernier avancement »
      avancement: av
        ? {
            ...av,
            libelle:
              av.nature === 'PROMOTION'
                ? 'Date de dernière promotion'
                : 'Date du dernier avancement',
          }
        : null,
      echelonDepuis: av?.origine === 'DERNIER' ? av.depuis : null,
      echelle: echelle
        ? {
            libelle: echelle.libelle,
            dureeEchelonMois: duree,
            nombreEchelons: nombre,
          }
        : null,
      prochainEchelon: av && !dernierEchelon ? av.prochain : null,
      attendues,
      dernierEchelon,
    };
  }

  /* ------------------------------ Écriture ------------------------------ */

  /** Contrôle d'un événement : type, date, acte, nouvelles valeurs lues comme dans la fiche. */
  private lire(dto: EvenementDto) {
    const t = TYPES_CARRIERE[dto.type];
    if (!t) throw new BadRequestException('Choisissez le type d’événement.');
    if (t.ancien && !dto.ancienAccepte)
      throw new BadRequestException(
        `« ${t.libelle} » n’est plus proposé : choisissez promotion (fonctionnaire) ou avancement (contractuel).`,
      );
    const dateEffet = dto.dateEffet?.trim();
    if (!dateEffet || !DATE.test(dateEffet))
      throw new BadRequestException('Indiquez la date d’effet.');
    const acteDate = dto.acteDate?.trim() || null;
    if (acteDate && !DATE.test(acteDate))
      throw new BadRequestException('Date de l’acte invalide.');
    const acteNature = dto.acteNature?.trim() || null;
    if (acteNature && !NATURES_ACTE[acteNature])
      throw new BadRequestException('Nature de l’acte inconnue.');
    const ch = this.champs();
    const nouveau: Record<string, unknown> = {};
    for (const k of t.champs) {
      const c = ch.get(k);
      const brut = dto.nouveau?.[k];
      if (!c || estVide(brut)) continue;
      const lu = lireValeur(c, brut);
      if (lu.erreur)
        throw new BadRequestException(`${c.libelle} : ${lu.erreur}.`);
      if (!estVide(lu.valeur)) nouveau[k] = lu.valeur;
    }
    if (t.champs.length && !Object.keys(nouveau).length && !dto.commentaire)
      throw new BadRequestException(
        `Indiquez ce qui change (${t.champs
          .map((k) => ch.get(k)?.libelle)
          .filter(Boolean)
          .join(', ')}) ou un commentaire.`,
      );
    return {
      type: dto.type,
      dateEffet,
      acteNature,
      acteNumero: court(dto.acteNumero, 80),
      acteDate,
      nouveau,
      commentaire: court(dto.commentaire, 1000),
    };
  }

  /**
   * Reporte l'événement dans la fiche s'il est le plus récent pour ces rubriques ; un événement plus
   * ancien (dossier reconstitué) ne fait que compléter l'historique.
   */
  private reporter(
    a: AgentRecense,
    e: EvenementCarriere,
    autres: EvenementCarriere[],
    demande = true,
  ) {
    const d = { ...a.donnees };
    const avant: Record<string, unknown> = {};
    // Le classement de la fiche date de son grade : un événement antérieur ne le remplace pas
    const dateGrade = texte(d.DATE_GRADE);
    const ancien = !!dateGrade && !!e.dateEffet && e.dateEffet < dateGrade;
    const champs = !demande
      ? []
      : Object.keys(e.nouveau).filter(
          (k) =>
            !(ancien && SITUATION.includes(k)) &&
            !autres.some(
              (x) => x.id !== e.id && k in x.nouveau && ordre(x, e) > 0,
            ),
        );
    for (const k of champs) {
      avant[k] = d[k] ?? null;
      d[k] = e.nouveau[k];
    }
    // Nouveau grade ou nouvel échelon : la date de la dernière promotion (ou du dernier avancement) suit
    if (
      (champs.includes('GRADE') || champs.includes('ECHELON')) &&
      this.champs().has('DATE_GRADE') &&
      e.dateEffet
    ) {
      avant.DATE_GRADE = d.DATE_GRADE ?? null;
      d.DATE_GRADE = e.dateEffet;
    }
    e.avant = avant;
    e.reporte = Object.keys(avant).length > 0;
    a.donnees = d;
    return e.reporte;
  }

  /**
   * Retire l'effet d'un événement sur la fiche : chaque rubrique qu'il a changée et qui n'a pas
   * bougé depuis reprend sa valeur d'avant ; un événement plus récent qui partait de lui part
   * désormais de cette valeur.
   */
  private defaire(
    a: AgentRecense,
    e: EvenementCarriere,
    autres: EvenementCarriere[],
  ) {
    if (!e.reporte) return [];
    const d = { ...a.donnees };
    const valeurs = { ...e.nouveau, DATE_GRADE: e.dateEffet };
    for (const [k, v] of Object.entries(e.avant))
      if (egal(d[k], valeurs[k])) {
        if (estVide(v)) delete d[k];
        else d[k] = v;
      }
    a.donnees = d;
    const touches: EvenementCarriere[] = [];
    for (const x of autres)
      if (x.id !== e.id && x.reporte && ordre(x, e) > 0) {
        let change = false;
        for (const k of Object.keys(e.avant))
          if (k in x.avant && egal(x.avant[k], valeurs[k])) {
            x.avant = { ...x.avant, [k]: e.avant[k] };
            change = true;
          }
        if (change) touches.push(x);
      }
    e.reporte = false;
    e.avant = {};
    return touches;
  }

  /** Enregistre la fiche changée par un événement (colonnes, complétude), puis les événements. */
  private async enregistrer(
    a: AgentRecense,
    u: UtilisateurConnecte,
    evs: EvenementCarriere[],
  ) {
    Object.assign(a, await this.rec.colonnes(a.donnees), { modifiePar: u.nom });
    this.rec.appliquerEvaluation(
      a,
      (await this.rec.piecesFournies([a.id])).get(a.id) ?? {},
    );
    await this.agents.manager.transaction(async (m) => {
      await m.save(a);
      if (evs.length) await m.save(evs);
    });
  }

  async ajouter(u: UtilisateurConnecte, id: number, dto: EvenementDto) {
    const a = await this.rec.trouver(u, id);
    const v = this.lire(dto);
    const autres = await this.evenements.find({ where: { agentId: id } });
    const e = this.evenements.create({
      ...v,
      agentId: id,
      creePar: u.nom,
      creeLe: new Date(),
    });
    this.reporter(a, e, autres, dto.reporter !== false);
    await this.enregistrer(a, u, [e]);
    await this.journal.log(u, 'PERSONNEL_CARRIERE', 'agent_recense', id, {
      evenement: TYPES_CARRIERE[e.type].libelle,
      date: e.dateEffet,
      champs: Object.keys(e.nouveau),
    });
    return e;
  }

  private async evenement(id: number, evId: string) {
    const e = await this.evenements.findOne({
      where: { id: evId, agentId: id },
    });
    if (!e) throw new NotFoundException('Événement introuvable');
    return e;
  }

  async modifier(
    u: UtilisateurConnecte,
    id: number,
    evId: string,
    dto: EvenementDto,
  ) {
    const a = await this.rec.trouver(u, id);
    const e = await this.evenement(id, evId);
    const v = this.lire(dto);
    const autres = await this.evenements.find({ where: { agentId: id } });
    const touches = this.defaire(a, e, autres);
    Object.assign(e, v);
    this.reporter(a, e, autres, dto.reporter !== false);
    await this.enregistrer(a, u, [...touches, e]);
    await this.journal.log(
      u,
      'PERSONNEL_CARRIERE_MODIFIE',
      'agent_recense',
      id,
      {
        evenement: TYPES_CARRIERE[e.type].libelle,
        date: e.dateEffet,
      },
    );
    return e;
  }

  /** Annule un événement : la fiche reprend les valeurs d'avant (si personne ne les a changées depuis). */
  async supprimer(u: UtilisateurConnecte, id: number, evId: string) {
    const a = await this.rec.trouver(u, id);
    const e = await this.evenement(id, evId);
    const autres = await this.evenements.find({ where: { agentId: id } });
    const touches = this.defaire(a, e, autres);
    await this.enregistrer(a, u, touches);
    await this.evenements.delete(e.id);
    await this.stockage.supprimer('recensement', e.fichier);
    await this.journal.log(
      u,
      'PERSONNEL_CARRIERE_ANNULE',
      'agent_recense',
      id,
      {
        evenement: TYPES_CARRIERE[e.type]?.libelle ?? e.type,
        date: e.dateEffet,
      },
    );
    return { supprime: true };
  }

  async joindreActe(
    u: UtilisateurConnecte,
    id: number,
    evId: string,
    f: Express.Multer.File,
  ) {
    await this.rec.trouver(u, id);
    const e = await this.evenement(id, evId);
    const ancien = e.fichier;
    e.fichier = await this.stockage.enregistrer('recensement', f);
    e.nomOrigine = f.originalname;
    e.mime = f.mimetype;
    await this.evenements.save(e);
    await this.stockage.supprimer('recensement', ancien);
    await this.journal.log(u, 'PERSONNEL_CARRIERE_ACTE', 'agent_recense', id, {
      evenement: TYPES_CARRIERE[e.type]?.libelle ?? e.type,
      fichier: f.originalname,
    });
    return { fichier: true };
  }

  async acteFichier(u: UtilisateurConnecte, id: number, evId: string) {
    await this.rec.trouver(u, id);
    const e = await this.evenement(id, evId);
    if (!e.fichier) throw new NotFoundException('Aucun acte joint');
    return e;
  }
}
