import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import ExcelJS from 'exceljs';
import {
  AlignmentType,
  BorderStyle,
  Document,
  Packer,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from 'docx';
import { CalculMemorise } from '../common/calcul-memorise';
import { IndexNoms } from '../common/index-noms';
import { moisEnClair } from '../common/mois';
import { Volontaire } from '../entities';
import { BourseService } from './bourse.service';
import { ConfigEnrolementService } from './configuration';

/**
 * Suivi de l'intégration des enseignants volontaires et communautaires (document demandé par la
 * Banque mondiale, 16/11/2026) : pour chaque personne du registre de la bourse, le texte
 * d'intégration (arrêté ou décret), la note d'affectation, la prise en charge de la solde
 * (salaire) et la fin de la bourse ; une situation par personne et ce qui est à régler.
 * Lecture seule : rien n'est modifié.
 *
 * Règles (DGRHAS, 16/11/2026) :
 * - recruté : fonctionnaire ou contractuel dans la base du personnel (le statut suffit, même sans
 *   texte), ou un texte d'intégration retrouvé, ou la sortie « Recruté à la FP » ;
 * - payé : un matricule solde (c'est la Solde qui paie le salaire) ; un fonctionnaire ou contractuel
 *   sans matricule est recruté, « en attente de matricule » ;
 * - affecté : fonctionnaire ou contractuel qui travaille dans une structure (lieu de service ou
 *   rattachement à l'organigramme dans la base du personnel) ; à défaut, une note d'affectation
 *   retrouvée (recrue des textes pas encore dans la base du personnel).
 */

export type CodeSituation =
  | 'PAYE_AFFECTE'
  | 'PAYE_SANS_NOTE'
  | 'ATTENTE_MATRICULE'
  | 'ATTENTE_SALAIRE'
  | 'ATTENTE_NOTE'
  | 'RECRUTE_SANS_PIECE'
  | 'NON_RECRUTE'
  | 'A_VERIFIER'
  | 'SORTI_AUTRE'
  | 'ABSENT_REGISTRE';

export const SITUATIONS: Record<CodeSituation, string> = {
  PAYE_AFFECTE: 'Payé (matricule solde), en poste dans une structure',
  PAYE_SANS_NOTE: 'Payé (matricule solde), structure à compléter dans sa fiche',
  ATTENTE_MATRICULE:
    'Fonctionnaire ou contractuel, en attente de matricule solde',
  ATTENTE_SALAIRE:
    'Texte reçu et affecté, pas encore dans la base du personnel',
  ATTENTE_NOTE: 'Texte reçu, pas encore affecté ni dans la base du personnel',
  RECRUTE_SANS_PIECE:
    'Sorti « recruté », introuvable dans la base du personnel',
  A_VERIFIER:
    'Peut-être déjà recruté : même nom qu’un fonctionnaire (à vérifier)',
  NON_RECRUTE: 'Pas encore recruté (toujours payé en bourse)',
  SORTI_AUTRE: 'Sorti de la bourse pour un autre motif (désertion, décès…)',
  ABSENT_REGISTRE: 'Recruté par texte, absent du registre de la bourse',
};

/** Les mots du suivi, expliqués pour un lecteur qui découvre le document (DG, 16/11/2026). */
export const DEFINITIONS: [string, string][] = [
  [
    'Registre de la bourse',
    'toutes les personnes payées un jour en bourse : les volontaires (finalistes enrôlés) et les communautaires (recrutés autrefois par les écoles), encore en poste ou déjà sortis.',
  ],
  [
    'Recruté',
    'devenu fonctionnaire ou contractuel ; son statut dans la base du personnel suffit, même si le texte manque. Comptent aussi : un arrêté ou un décret d’intégration reçu, ou une sortie de la bourse avec le motif « recruté à la Fonction publique ».',
  ],
  [
    'Affecté',
    'un fonctionnaire ou un contractuel est affecté : il travaille dans un département et une structure (école, inspection, direction…), indiquée dans sa fiche du personnel. Pour une recrue pas encore dans la base du personnel : une note d’affectation retrouvée.',
  ],
  ['Payé (salaire)', 'a un matricule solde : la Solde lui paie son salaire.'],
  [
    'En attente de matricule',
    'fonctionnaire ou contractuel sans matricule solde : recruté, mais son salaire n’est pas encore confirmé par la Solde.',
  ],
  [
    'Reste à intégrer',
    'encore en poste et payés en bourse, pas encore recrutés.',
  ],
  [
    'À vérifier',
    'même nom qu’un fonctionnaire ou un contractuel, sans date de naissance pour être sûr que c’est la même personne ; pas compté.',
  ],
];

/** L'ordre du parcours, pour trier la liste nominative. */
const ORDRE_SITUATIONS = Object.keys(SITUATIONS) as CodeSituation[];

export interface LigneSuivi {
  id: string;
  nom: string;
  naissance: string | null;
  population: 'VOLONTAIRE' | 'COMMUNAUTAIRE';
  registre: 'EN_POSTE' | 'SORTI' | 'ABSENT';
  motifSortie: string | null;
  dernierMoisBourse: string | null;
  vague: number | null;
  departementId: number | null;
  departement: string;
  categorie: string | null;
  cycle: string;
  texte: {
    nature: string;
    numero: string;
    date: string | null;
    source: string;
  } | null;
  anneeTexte: string | null;
  /** L'affectation : la structure où il travaille (base du personnel), sinon une note retrouvée. */
  note: {
    numero: string | null;
    date: string | null;
    lieu: string | null;
    departement?: string | null;
    source: string;
  } | null;
  salaire: {
    statut: string | null;
    matricule: string | null;
    indice: string | null;
    premierMois: string | null;
  } | null;
  rapprochement: 'LIEN' | 'SUR' | 'A_VERIFIER' | null;
  /** La piste à vérifier (même nom sans date) : qui, avec quel matricule. */
  piste: string | null;
  situation: CodeSituation;
  aRegler: string[];
}

export interface FiltresSuivi {
  population?: string;
  departementId?: number;
  categorie?: string;
  vague?: number;
  annee?: string;
  situation?: string;
  recherche?: string;
  aRegler?: boolean;
}

type Groupe = {
  libelle: string;
  base: number;
  recrutes: number;
  affectes: number;
  payes: number;
  /** Fonctionnaires ou contractuels sans matricule solde : salaire pas encore confirmé. */
  attente: number;
  reste: number;
  aVerifier: number;
};

@Injectable()
export class SuiviIntegrationService {
  /**
   * Le calcul est lourd (tout le registre et toute la base du personnel) : il est gardé tant que
   * les tables qu'il lit n'ont pas changé, refait en arrière-plan quand elles changent, et préparé
   * au démarrage du serveur (voir CalculMemorise).
   */
  private readonly memoire: CalculMemorise<{
    lignes: LigneSuivi[];
    personnel: {
      contractuel: boolean;
      departementId: number | null;
      matricule: boolean;
      structure: boolean;
    }[];
    sources: Record<string, number>;
    choix: { vagues: number[]; annees: string[] };
  }>;

  constructor(
    private readonly ds: DataSource,
    private readonly config: ConfigEnrolementService,
  ) {
    this.memoire = new CalculMemorise(
      ds,
      [
        'volontaire',
        'agent_recense',
        'agent',
        'affectation',
        'note_service',
        'reference_note',
        'ligne_bottin',
        'structure',
        'departement',
        'parametre',
      ],
      () => this.calculer(),
      'Suivi de l’intégration',
    );
    this.memoire.prechauffer();
  }

  private async toutes() {
    const r = await this.memoire.lire();
    return { ...r.donnees, le: r.le, aJour: r.aJour };
  }

  private async calculer() {
    const c = this.config.get();
    const q = <T>(sql: string, p: unknown[] = []) => this.ds.query<T[]>(sql, p);
    const deps = new Map(
      (
        await q<{ id: number; nom: string }>(`SELECT id, nom FROM departement`)
      ).map((d) => [d.id, d.nom]),
    );
    const vols = await this.ds.getRepository(Volontaire).find({
      select: [
        'id',
        'nomComplet',
        'dateNaissance',
        'population',
        'statut',
        'motifSortie',
        'dateSortie',
        'premierMois',
        'datePriseService',
        'dateNote',
        'vagueNumero',
        'departementId',
        'categorie',
        'cycleBrut',
      ],
    });
    // Les recrues des textes reçus de la Fonction Publique, leur affectation et leur note
    const agents = await q<{
      id: string;
      nomComplet: string;
      naissance: string | null;
      origine: string | null;
      typeTexte: string | null;
      numeroTexte: string | null;
      dateTexte: string | null;
      departementId: number | null;
      cycleBrut: string | null;
      agentRecenseId: number | null;
      noteNumero: string | null;
      noteDate: string | null;
      noteStatut: string | null;
      lieu: string | null;
      refNumero: string | null;
      refDate: string | null;
      refLieu: string | null;
    }>(
      `SELECT a.id, a."nomComplet", to_char(a."dateNaissance", 'YYYY-MM-DD') AS naissance,
              a.statut AS origine, a."typeTexte", a."numeroTexte",
              to_char(a."dateSignatureTexte", 'YYYY-MM-DD') AS "dateTexte",
              a."departementId", a."cycleBrut", a."agentRecenseId",
              n.numero AS "noteNumero", to_char(n."dateSignature", 'YYYY-MM-DD') AS "noteDate",
              n.statut AS "noteStatut", coalesce(af.etablissement, af.structure) AS lieu,
              r.numero AS "refNumero", r.date AS "refDate", r."lieuAffectation" AS "refLieu"
         FROM agent a
         LEFT JOIN affectation af ON af."agentId" = a.id
         LEFT JOIN note_service n ON n.id::text = af."noteId"::text
         LEFT JOIN LATERAL (SELECT numero, date, "lieuAffectation" FROM reference_note x
                             WHERE x."agentId" = a.id ORDER BY x."creeLe" DESC LIMIT 1) r ON true`,
    );
    // La base du personnel : statut, matricule, pièces de recrutement et d'affectation
    const personnel = await q<{
      id: number;
      nomComplet: string;
      naissance: string | null;
      statut: string;
      matricule: string | null;
      volontaireId: string | null;
      matriculeSolde: string | null;
      indice: string | null;
      dateRecrutement: string | null;
      texte: string | null;
      nature: string | null;
      note: string | null;
      lieu: string | null;
      structure: string | null;
      departementId: number | null;
    }>(
      `SELECT a.id, a."nomComplet", to_char(a."dateNaissance", 'YYYY-MM-DD') AS naissance, a.statut,
              a.matricule, a."volontaireId",
              a.donnees->>'MATRICULE_SOLDE' AS "matriculeSolde", a.donnees->>'INDICE_SOLDE' AS indice,
              a.donnees->>'DATE_RECRUTEMENT' AS "dateRecrutement",
              a.donnees->>'TEXTE_RECRUTEMENT' AS texte,
              a.donnees->>'NATURE_TEXTE_RECRUTEMENT' AS nature,
              a.donnees->>'NOTE_AFFECTATION' AS note,
              nullif(trim(a.donnees->>'LIEU_SERVICE'), '') AS lieu,
              s.nom AS structure, coalesce(s."departementId", a."departementId") AS "departementId"
         FROM agent_recense a LEFT JOIN structure s ON s.id = a."structureId"
        WHERE coalesce(a.contentieux->>'etat', 'CONFIRME') = 'CONFIRME'
          AND a.statut IN ('FONCTIONNAIRE', 'CONTRACTUEL')`,
    );
    // Le premier mois de salaire, d'après les fichiers de la Solde déjà chargés (bottin)
    const bottinMatricule = new Map<string, string>();
    const bottinNom = new IndexNoms<string>();
    for (const b of await q<{
      matricule: string | null;
      nom: string;
      naissance: string | null;
      mois: string;
    }>(
      `SELECT upper(matricule) AS matricule, min("nomComplet") AS nom,
              to_char(min("dateNaissance"), 'YYYY-MM-DD') AS naissance, min(mois) AS mois
         FROM ligne_bottin GROUP BY upper(matricule), "nomNormalise"`,
    )) {
      if (b.matricule) bottinMatricule.set(b.matricule, b.mois);
      bottinNom.ajouter(b.nom, b.naissance, b.mois);
    }

    const fc = (s: string | null) =>
      s === 'FONCTIONNAIRE' || s === 'CONTRACTUEL';
    const parVolontaire = new Map(
      personnel.filter((p) => p.volontaireId).map((p) => [p.volontaireId!, p]),
    );
    const indexFC = new IndexNoms<(typeof personnel)[number]>();
    for (const p of personnel)
      if (fc(p.statut)) indexFC.ajouter(p.nomComplet, p.naissance, p);
    const indexAgents = new IndexNoms<(typeof agents)[number]>();
    for (const a of agents) indexAgents.ajouter(a.nomComplet, a.naissance, a);
    const agentsPris = new Set<string>();
    const agentParFiche = new Map(
      agents
        .filter((x) => x.agentRecenseId !== null)
        .map((x) => [x.agentRecenseId!, x]),
    );
    const categories = [
      ...this.config.categoriesDe('VOLONTAIRE'),
      ...this.config.categoriesDe('COMMUNAUTAIRE'),
    ];
    const libelleCat = (code: string | null) =>
      categories.find((x) => x.code === code)?.libelle ?? null;
    const motif = (code: string | null) =>
      c.motifsSortie.find((m) => m.code === code)?.libelle ?? code;
    const dateFr = (d: string | null) =>
      d ? d.slice(0, 10).split('-').reverse().join('/') : null;

    const texteDeAgent = (a: (typeof agents)[number] | undefined) =>
      a?.numeroTexte
        ? {
            nature:
              a.typeTexte === 'DECRET'
                ? 'Décret'
                : a.typeTexte === 'ARRETE'
                  ? 'Arrêté'
                  : (a.typeTexte ?? 'Texte'),
            numero: a.numeroTexte,
            date: a.dateTexte,
            source: 'Textes reçus de la Fonction Publique',
          }
        : null;
    const noteDeAgent = (a: (typeof agents)[number] | undefined) =>
      a &&
      a.noteNumero &&
      (a.noteStatut === 'SIGNEE' || a.noteStatut === 'VALIDEE')
        ? {
            numero: a.noteNumero,
            date: a.noteDate,
            lieu: a.lieu,
            source: 'Note signée dans le système',
          }
        : a?.refNumero
          ? {
              numero: a.refNumero,
              date: a.refDate,
              lieu: a.refLieu,
              source: 'Référence de note importée',
            }
          : null;

    const lignes: LigneSuivi[] = [];
    for (const v of vols) {
      // 1. La fiche du personnel. Sûre : le lien enregistré vers une fiche de fonctionnaire ou de
      // contractuel, ou le même nom et la même date de naissance. Le même nom sans date (la plupart
      // des volontaires n'ont pas de date) n'est qu'une piste : « à vérifier », jamais compté.
      // (le personnel lu ne contient que les fonctionnaires et les contractuels)
      let p: (typeof personnel)[number] | null =
        parVolontaire.get(v.id) ?? null;
      let rapprochement: LigneSuivi['rapprochement'] = p ? 'LIEN' : null;
      let piste: (typeof personnel)[number] | null = null;
      if (!p) {
        const cand = indexFC.probables(v.nomComplet, v.dateNaissance)[0];
        if (cand && v.dateNaissance && cand.naissance) {
          p = cand;
          rapprochement = 'SUR';
        } else if (cand) {
          piste = cand;
          rapprochement = 'A_VERIFIER';
        }
      }
      // 2. Le texte d'intégration : recrue des textes (lien, puis même nom et même date ; le même
      // nom sans date est une piste), sinon le texte de recrutement de la fiche du fonctionnaire
      let a = p ? agentParFiche.get(p.id) : undefined;
      let texteIncertain = false;
      if (!a) {
        const cand = indexAgents
          .probables(v.nomComplet, v.dateNaissance)
          .find((x) => !agentsPris.has(x.id));
        if (cand && v.dateNaissance && cand.naissance) a = cand;
        else if (cand) texteIncertain = true;
      }
      if (a) agentsPris.add(a.id);
      const texte =
        texteDeAgent(a) ??
        (p?.texte
          ? {
              nature: p.nature ?? 'Texte de recrutement',
              numero: p.texte,
              date: p.dateRecrutement,
              source: 'Base du personnel',
            }
          : null);
      // La note d'affectation : celle de la recrue, sinon celle de la fiche du fonctionnaire (la
      // « note » d'une fiche de volontaire est sa note de volontariat, pas une affectation)
      // L'affectation (DG, 16/11/2026) : un fonctionnaire ou un contractuel est affecté — on l'a
      // envoyé travailler dans un département et une structure. La structure vient de sa fiche
      // (organigramme, sinon lieu de service) ; sans fiche du personnel, une note retrouvée
      const estFC = !!p && fc(p.statut);
      const enStructure = estFC ? (p?.structure ?? p?.lieu ?? null) : null;
      const noteTrouvee = noteDeAgent(a);
      const note = estFC
        ? {
            numero: noteTrouvee?.numero ?? p?.note ?? null,
            date: noteTrouvee?.date ?? null,
            lieu: enStructure,
            departement: p?.departementId
              ? (deps.get(p.departementId) ?? null)
              : null,
            source: enStructure
              ? 'Base du personnel (lieu de service)'
              : 'Base du personnel (structure à compléter)',
          }
        : (noteTrouvee ??
          (p?.note
            ? {
                numero: p.note,
                date: null,
                lieu: null,
                source: 'Base du personnel (note d’affectation)',
              }
            : null));
      // 3. Le salaire : un matricule solde (DG, 16/11/2026) ; un fonctionnaire ou contractuel sans
      // matricule est recruté, en attente de matricule
      const matricule = p
        ? p.matricule?.trim() || p.matriculeSolde?.trim() || null
        : null;
      const paye = estFC && !!matricule;
      const premierMois = paye
        ? ((matricule && bottinMatricule.get(matricule.toUpperCase())) ??
          bottinNom.probables(v.nomComplet, v.dateNaissance)[0] ??
          null)
        : null;
      const salaire =
        estFC && p
          ? { statut: p.statut, matricule, indice: p.indice, premierMois }
          : null;
      // 4. La fin de la bourse
      const debut = BourseService.premierMois(v, c);
      const fin = BourseService.dernierMois(v, c, debut);
      const recrute = !!texte || estFC || v.motifSortie === 'RECRUTE_FP';
      const situation: CodeSituation = paye
        ? note?.lieu
          ? 'PAYE_AFFECTE'
          : 'PAYE_SANS_NOTE'
        : estFC
          ? 'ATTENTE_MATRICULE'
          : texte
            ? note
              ? 'ATTENTE_SALAIRE'
              : 'ATTENTE_NOTE'
            : recrute
              ? 'RECRUTE_SANS_PIECE'
              : piste || texteIncertain
                ? 'A_VERIFIER'
                : v.statut === 'EN_POSTE'
                  ? 'NON_RECRUTE'
                  : 'SORTI_AUTRE';
      const aRegler: string[] = [];
      if (v.statut === 'EN_POSTE' && paye)
        aRegler.push('Payé en salaire et encore payé en bourse');
      else if (v.statut === 'EN_POSTE' && estFC)
        aRegler.push('Fonctionnaire ou contractuel et encore payé en bourse');
      else if (v.statut === 'EN_POSTE' && texte)
        aRegler.push(
          'Texte d’intégration reçu, encore payé en bourse (jusqu’au premier salaire ?)',
        );
      if (estFC && !matricule)
        aRegler.push(
          'En attente de matricule solde (salaire pas encore confirmé par la Solde)',
        );
      if (estFC && !enStructure)
        aRegler.push(
          'Structure (lieu de service) à compléter dans sa fiche du personnel',
        );
      if (situation === 'RECRUTE_SANS_PIECE')
        aRegler.push('Sorti comme recruté : aucun texte ni salaire retrouvé');
      if (situation === 'A_VERIFIER')
        aRegler.push(
          piste
            ? 'Même nom qu’un fonctionnaire ou contractuel de la base du personnel, sans date de naissance pour confirmer : à vérifier'
            : 'Même nom qu’une recrue des textes, sans date de naissance pour confirmer : à vérifier',
        );
      const pisteTexte = piste
        ? `${piste.nomComplet} — ${piste.statut === 'CONTRACTUEL' ? 'contractuel' : 'fonctionnaire'}${piste.matricule ? `, matricule ${piste.matricule}` : ''}`
        : texteIncertain
          ? 'Recrue des textes du même nom'
          : null;
      lignes.push({
        id: v.id,
        nom: v.nomComplet,
        naissance: v.dateNaissance,
        population:
          v.population === 'COMMUNAUTAIRE' ? 'COMMUNAUTAIRE' : 'VOLONTAIRE',
        registre: v.statut === 'SORTI' ? 'SORTI' : 'EN_POSTE',
        motifSortie: v.statut === 'SORTI' ? motif(v.motifSortie) : null,
        dernierMoisBourse:
          v.statut !== 'SORTI'
            ? 'en cours'
            : fin === '0000-01' || !fin
              ? 'arrêtée (sans date)'
              : moisEnClair(fin),
        vague: v.vagueNumero ?? null,
        departementId: v.departementId ?? null,
        departement: v.departementId
          ? (deps.get(v.departementId) ?? '')
          : 'Non renseigné',
        categorie: v.categorie ?? null,
        cycle:
          libelleCat(v.categorie ?? null) ?? v.cycleBrut ?? 'Non renseigné',
        texte: texte ? { ...texte, date: dateFr(texte.date) } : null,
        anneeTexte: texte?.date ? texte.date.slice(0, 4) : null,
        note: note ? { ...note, date: dateFr(note.date) } : null,
        salaire: salaire
          ? {
              ...salaire,
              premierMois: salaire.premierMois
                ? moisEnClair(salaire.premierMois)
                : null,
            }
          : null,
        rapprochement,
        piste: pisteTexte,
        situation,
        aRegler,
      });
    }
    // Les recrues des textes d'origine volontaire ou communautaire absentes du registre
    for (const a of agents) {
      if (agentsPris.has(a.id)) continue;
      const o = (a.origine ?? '').toLowerCase();
      if (!o.startsWith('volont') && !o.startsWith('communaut')) continue;
      const t = texteDeAgent(a);
      lignes.push({
        id: `A:${a.id}`,
        nom: a.nomComplet,
        naissance: a.naissance,
        population: o.startsWith('communaut') ? 'COMMUNAUTAIRE' : 'VOLONTAIRE',
        registre: 'ABSENT',
        motifSortie: null,
        dernierMoisBourse: null,
        vague: null,
        departementId: a.departementId,
        departement: a.departementId
          ? (deps.get(a.departementId) ?? '')
          : 'Non renseigné',
        categorie: null,
        cycle: a.cycleBrut ?? 'Non renseigné',
        texte: t ? { ...t, date: dateFr(t.date) } : null,
        anneeTexte: t?.date ? t.date.slice(0, 4) : null,
        note: (() => {
          const n = noteDeAgent(a);
          return n ? { ...n, date: dateFr(n.date) } : null;
        })(),
        salaire: null,
        rapprochement: null,
        piste: null,
        situation: 'ABSENT_REGISTRE',
        aRegler: [
          'Recrue des textes d’origine volontaire ou communautaire, absente du registre de la bourse',
        ],
      });
    }
    // Triée une fois pour toutes (les filtres gardent l'ordre) : les situations les plus parlantes
    // d'abord (recrutés, affectés, payés), dans l'ordre du parcours
    const fr = new Intl.Collator('fr');
    const rang = new Map(ORDRE_SITUATIONS.map((s, i) => [s, i]));
    lignes.sort(
      (a, b) =>
        rang.get(a.situation)! - rang.get(b.situation)! ||
        a.population.localeCompare(b.population) ||
        fr.compare(a.departement, b.departement) ||
        fr.compare(a.nom, b.nom),
    );
    return {
      lignes,
      // Toute la base du personnel (fonctionnaires et contractuels), pour le bloc d'ensemble
      personnel: personnel.map((x) => ({
        contractuel: x.statut === 'CONTRACTUEL',
        departementId: x.departementId,
        matricule: !!(x.matricule?.trim() || x.matriculeSolde?.trim()),
        structure: !!(x.structure ?? x.lieu),
      })),
      choix: {
        vagues: [
          ...new Set(
            lignes.map((l) => l.vague).filter((x): x is number => x !== null),
          ),
        ].sort((a, b) => a - b),
        annees: [
          ...new Set(
            lignes.map((l) => l.anneeTexte).filter((x): x is string => !!x),
          ),
        ].sort(),
      },
      sources: {
        registre: vols.length,
        textes: agents.length,
        notesSignees: agents.filter(
          (x) => x.noteStatut === 'SIGNEE' || x.noteStatut === 'VALIDEE',
        ).length,
        referencesNotes: agents.filter((x) => x.refNumero).length,
        personnelPaye: personnel.filter((x) => fc(x.statut)).length,
        personnelSansMatricule: personnel.filter(
          (x) => fc(x.statut) && !x.matricule && !x.matriculeSolde,
        ).length,
        moisSolde:
          (
            await q<{ n: number }>(
              `SELECT count(DISTINCT mois)::int AS n FROM ligne_bottin`,
            )
          )[0]?.n ?? 0,
      },
    };
  }

  private filtrer(lignes: LigneSuivi[], f: FiltresSuivi) {
    const q = (f.recherche ?? '').trim().toLowerCase();
    return lignes.filter(
      (l) =>
        (!f.population || l.population === f.population) &&
        (!f.departementId || l.departementId === f.departementId) &&
        (!f.categorie || l.categorie === f.categorie) &&
        (!f.vague || l.vague === f.vague) &&
        (!f.annee || l.anneeTexte === f.annee) &&
        (!f.situation || l.situation === f.situation) &&
        (!f.aRegler || l.aRegler.length > 0) &&
        (!q ||
          `${l.nom} ${l.departement} ${l.texte?.numero ?? ''} ${l.note?.numero ?? ''} ${l.salaire?.matricule ?? ''}`
            .toLowerCase()
            .includes(q)),
    );
  }

  /** La synthèse : le parcours en chiffres, les taux, les délais et les regroupements. */
  private synthese(lignes: LigneSuivi[]) {
    const registre = lignes.filter((l) => l.registre !== 'ABSENT');
    const estRecrute = (l: LigneSuivi) =>
      [
        'PAYE_AFFECTE',
        'PAYE_SANS_NOTE',
        'ATTENTE_MATRICULE',
        'ATTENTE_SALAIRE',
        'ATTENTE_NOTE',
        'RECRUTE_SANS_PIECE',
      ].includes(l.situation);
    const compter = (liste: LigneSuivi[]): Omit<Groupe, 'libelle'> => ({
      base: liste.length,
      recrutes: liste.filter(estRecrute).length,
      affectes: liste.filter((l) => estRecrute(l) && !!l.note).length,
      payes: liste.filter((l) => !!l.salaire?.matricule).length,
      attente: liste.filter((l) => !!l.salaire && !l.salaire.matricule).length,
      reste: liste.filter((l) => l.situation === 'NON_RECRUTE').length,
      aVerifier: liste.filter((l) => l.situation === 'A_VERIFIER').length,
    });
    const regrouper = (cle: (l: LigneSuivi) => string): Groupe[] => {
      const m = new Map<string, LigneSuivi[]>();
      for (const l of registre) {
        const k = cle(l);
        const liste = m.get(k);
        if (liste) liste.push(l);
        else m.set(k, [l]);
      }
      return [...m.entries()]
        .map(([libelle, liste]) => ({ libelle, ...compter(liste) }))
        .sort((a, b) => a.libelle.localeCompare(b.libelle, 'fr'));
    };
    const total = compter(registre);
    const taux = (a: number, b: number) =>
      b ? Math.round((a / b) * 1000) / 10 : 0;
    const parSituation = (Object.keys(SITUATIONS) as CodeSituation[]).map(
      (code) => ({
        code,
        libelle: SITUATIONS[code],
        n: lignes.filter((l) => l.situation === code).length,
      }),
    );
    const aRegler = new Map<string, number>();
    for (const l of lignes)
      for (const r of l.aRegler) aRegler.set(r, (aRegler.get(r) ?? 0) + 1);
    // Délai moyen entre le texte et la note (jours), quand les deux dates sont connues
    const jours = (d: string) => {
      const [j, m, a] = d.split('/').map(Number);
      return Date.UTC(a, m - 1, j) / 86_400_000;
    };
    const delais = registre
      .filter((l) => l.texte?.date && l.note?.date)
      .map((l) => jours(l.note!.date!) - jours(l.texte!.date!))
      .filter((x) => x >= 0);
    return {
      total,
      taux: {
        integration: taux(total.recrutes, total.base),
        affectation: taux(total.affectes, total.recrutes),
        priseEnCharge: taux(total.payes, total.recrutes),
      },
      delaiTexteNote: delais.length
        ? {
            jours: Math.round(
              delais.reduce((s, x) => s + x, 0) / delais.length,
            ),
            n: delais.length,
          }
        : null,
      absentsRegistre: lignes.filter((l) => l.registre === 'ABSENT').length,
      parSituation,
      parPopulation: regrouper((l) =>
        l.population === 'COMMUNAUTAIRE' ? 'Communautaires' : 'Volontaires',
      ),
      parDepartement: regrouper((l) => l.departement || 'Non renseigné'),
      parCycle: regrouper((l) => l.cycle),
      parAnnee: regrouper((l) => l.anneeTexte ?? 'Sans texte'),
      aRegler: [...aRegler.entries()]
        .map(([libelle, n]) => ({ libelle, n }))
        .sort((a, b) => b.n - a.n),
    };
  }

  /** Toute la base du personnel : effectifs, payés (matricule), en attente, affectés. */
  private basePersonnel(
    base: { contractuel: boolean; matricule: boolean; structure: boolean }[],
  ) {
    return {
      total: base.length,
      fonctionnaires: base.filter((x) => !x.contractuel).length,
      contractuels: base.filter((x) => x.contractuel).length,
      payes: base.filter((x) => x.matricule).length,
      attente: base.filter((x) => !x.matricule).length,
      avecStructure: base.filter((x) => x.structure).length,
      sansStructure: base.filter((x) => !x.structure).length,
    };
  }

  /** La page : synthèse, une page de la liste, et de quoi remplir les filtres. */
  async suivi(f: FiltresSuivi, page = 1, taille = 50) {
    const {
      lignes: toutes,
      sources,
      choix,
      le,
      aJour,
      personnel,
    } = await this.toutes();
    const base = personnel.filter(
      (x) => !f.departementId || x.departementId === f.departementId,
    );
    const lignes = this.filtrer(toutes, f);
    const debut = (Math.max(1, page) - 1) * taille;
    return {
      synthese: this.synthese(lignes),
      sources,
      total: lignes.length,
      page: Math.max(1, page),
      taille,
      // Déjà triée au calcul : situations les plus parlantes d'abord, dans l'ordre du parcours
      lignes: lignes.slice(debut, debut + taille),
      choix,
      situations: SITUATIONS,
      calculeLe: new Date(le).toISOString(),
      /** Toute la base du personnel (fonctionnaires et contractuels), au-delà du registre. */
      basePersonnel: this.basePersonnel(base),
      /** Faux : des données ont changé, une mise à jour se fait en arrière-plan. */
      aJour,
    };
  }

  /** Ce que disent les filtres, en clair (en tête des fichiers). */
  private libelleFiltres(f: FiltresSuivi, deps: Map<number, string>) {
    return [
      f.population === 'VOLONTAIRE'
        ? 'volontaires'
        : f.population === 'COMMUNAUTAIRE'
          ? 'communautaires'
          : 'volontaires et communautaires',
      f.departementId
        ? `département : ${deps.get(f.departementId) ?? f.departementId}`
        : null,
      f.categorie ? `cycle : ${f.categorie}` : null,
      f.vague ? `vague ${f.vague}` : null,
      f.annee ? `textes de ${f.annee}` : null,
      f.situation
        ? `situation : ${SITUATIONS[f.situation as CodeSituation] ?? f.situation}`
        : null,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  /** L'Excel : synthèse, liste nominative, à régler (en-tête officiel). */
  async excel(f: FiltresSuivi): Promise<{ nom: string; contenu: Buffer }> {
    const { lignes: toutes, sources, personnel } = await this.toutes();
    const B = this.basePersonnel(
      personnel.filter(
        (x) => !f.departementId || x.departementId === f.departementId,
      ),
    );
    const lignes = this.filtrer(toutes, f);
    const s = this.synthese(lignes);
    const deps = new Map(
      (
        await this.ds.query<{ id: number; nom: string }[]>(
          `SELECT id, nom FROM departement`,
        )
      ).map((d) => [d.id, d.nom]),
    );
    const wb = new ExcelJS.Workbook();
    wb.creator = 'SIGRHAS-MEPPSA';
    const VERT = 'FF0F5132';
    const fin: Partial<ExcelJS.Border> = {
      style: 'thin',
      color: { argb: 'FFBDBDBD' },
    };
    const bords = { top: fin, bottom: fin, left: fin, right: fin };
    const titreDoc =
      'SUIVI DE L’INTÉGRATION DES ENSEIGNANTS VOLONTAIRES ET COMMUNAUTAIRES';
    const sous = `${this.libelleFiltres(f, deps)} · situation au ${new Date().toLocaleDateString('fr-FR')}`;
    const entete = (ws: ExcelJS.Worksheet, nbCol: number, t: string) => {
      const ecrire = (
        l: number,
        c1: number,
        c2: number,
        v: string,
        font: Partial<ExcelJS.Font>,
      ) => {
        if (c2 > c1) ws.mergeCells(l, c1, l, c2);
        const x = ws.getCell(l, c1);
        x.value = v;
        x.font = { name: 'Calibri', ...font };
        x.alignment = {
          horizontal: 'center',
          vertical: 'middle',
          wrapText: true,
        };
      };
      const g = { size: 11, bold: true };
      const gauche = Math.min(4, nbCol - 2);
      const d1 = nbCol - 1;
      ecrire(1, 1, gauche, "MINISTERE DE L'ENSEIGNEMENT PRESCOLAIRE,", g);
      ecrire(1, d1, nbCol, 'REPUBLIQUE DU CONGO', g);
      ecrire(2, 1, gauche, "PRIMAIRE, SECONDAIRE ET DE L'ALPHABETISATION", g);
      ecrire(2, d1, nbCol, 'Unité - Travail - Progrès', g);
      ecrire(3, 1, gauche, '-----------', g);
      ecrire(3, d1, nbCol, '-----------', g);
      ecrire(4, 1, gauche, 'CABINET', g);
      ecrire(5, 1, gauche, '-----------', g);
      ecrire(6, 1, gauche, 'DIRECTION GENERALE DES RESSOURCES HUMAINES', g);
      ecrire(7, 1, gauche, "ET DE L'ADMINISTRATION SCOLAIRE", g);
      ecrire(8, 1, gauche, '-----------', g);
      ecrire(10, 1, nbCol, t, { size: 14, bold: true, color: { argb: VERT } });
      ecrire(11, 1, nbCol, sous, { size: 11, italic: true });
      ws.getRow(10).height = 22;
      ws.getRow(11).height = 30;
    };
    const titres = (ws: ExcelJS.Worksheet, l: number, noms: string[]) => {
      const r = ws.getRow(l);
      noms.forEach((t, i) => {
        const x = r.getCell(i + 1);
        x.value = t;
        x.font = {
          name: 'Calibri',
          size: 10,
          bold: true,
          color: { argb: 'FFFFFFFF' },
        };
        x.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: VERT } };
        x.alignment = {
          horizontal: 'center',
          vertical: 'middle',
          wrapText: true,
        };
        x.border = bords;
      });
      r.height = 32;
    };
    const ligne = (
      ws: ExcelJS.Worksheet,
      l: number,
      valeurs: ExcelJS.CellValue[],
      gras = false,
      fond?: string,
    ) => {
      const r = ws.getRow(l);
      valeurs.forEach((v, i) => {
        const x = r.getCell(i + 1);
        x.value = v;
        x.border = bords;
        x.font = { name: 'Calibri', size: 10, bold: gras };
        x.alignment = { vertical: 'middle', wrapText: true };
        if (typeof v === 'number') x.numFmt = '#,##0';
        if (fond)
          x.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: fond },
          };
      });
    };

    // 1. Synthèse
    const syn = wb.addWorksheet('Synthèse', {
      pageSetup: {
        paperSize: 9,
        orientation: 'portrait',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
      },
    });
    entete(syn, 6, titreDoc);
    let l = 13;
    const bloc = (t: string) => {
      syn.mergeCells(l, 1, l, 6);
      const x = syn.getCell(l, 1);
      x.value = t;
      x.font = { name: 'Calibri', size: 12, bold: true, color: { argb: VERT } };
      l++;
    };
    bloc('1. Toute la base du personnel (fonctionnaires et contractuels)');
    titres(syn, l, ['', 'Personnes', '', '', '', '']);
    l++;
    for (const [lib, n] of [
      [
        `Fonctionnaires et contractuels (${B.fonctionnaires} + ${B.contractuels})`,
        B.total,
      ],
      ['Payés (matricule solde)', B.payes],
      [
        'En attente de matricule (recrutés, salaire pas encore confirmé)',
        B.attente,
      ],
      ['Affectés, structure connue dans la fiche', B.avecStructure],
      ['Structure à compléter dans la fiche', B.sansStructure],
    ] as [string, number][]) {
      ligne(syn, l, [lib, n, '', '', '', '']);
      syn.mergeCells(l, 3, l, 6);
      l++;
    }
    l++;
    bloc('2. Volontaires et communautaires : où en sont-ils ?');
    titres(syn, l, ['', 'Personnes', 'Taux', '', '', '']);
    l++;
    const T = s.total;
    for (const [lib, n, tx] of [
      ['Payés en bourse un jour (registre de la bourse)', T.base, ''],
      [
        'Recrutés (fonctionnaire ou contractuel, texte reçu, ou sortie « recruté »)',
        T.recrutes,
        `${s.taux.integration} % du registre`,
      ],
      [
        'Affectés (fonctionnaires ou contractuels : département et structure)',
        T.affectes,
        `${s.taux.affectation} % des recrutés`,
      ],
      [
        'Payés (matricule solde)',
        T.payes,
        `${s.taux.priseEnCharge} % des recrutés`,
      ],
      ['En attente de matricule (salaire pas encore confirmé)', T.attente, ''],
      [
        'Peut-être déjà recrutés (même nom, sans date de naissance : à vérifier)',
        T.aVerifier,
        '',
      ],
      ['Reste à intégrer (en poste, pas encore recrutés)', T.reste, ''],
    ] as [string, number, string][]) {
      ligne(syn, l, [lib, n, tx, '', '', '']);
      syn.mergeCells(l, 3, l, 6);
      l++;
    }
    if (s.absentsRegistre) {
      ligne(syn, l, [
        'Recrues des textes d’origine volontaire ou communautaire absentes du registre',
        s.absentsRegistre,
        '',
        '',
        '',
        '',
      ]);
      syn.mergeCells(l, 3, l, 6);
      l++;
    }
    l++;
    bloc('Par situation');
    titres(syn, l, ['Situation', 'Personnes', '', '', '', '']);
    l++;
    for (const x of s.parSituation.filter((y) => y.n)) {
      ligne(syn, l, [x.libelle, x.n, '', '', '', '']);
      l++;
    }
    l++;
    const tableau = (t: string, groupes: Groupe[], colonne: string) => {
      bloc(t);
      titres(syn, l, [
        colonne,
        'Registre',
        'Recrutés',
        'Affectés',
        'Payés (matricule)',
        'En attente de matricule',
        'Reste à intégrer',
        'À vérifier',
      ]);
      l++;
      for (const [i, g] of groupes.entries()) {
        ligne(
          syn,
          l,
          [
            g.libelle,
            g.base,
            g.recrutes,
            g.affectes,
            g.payes,
            g.attente,
            g.reste,
            g.aVerifier,
          ],
          false,
          i % 2 ? 'FFF4F4F5' : undefined,
        );
        l++;
      }
      ligne(
        syn,
        l,
        [
          'TOTAL',
          T.base,
          T.recrutes,
          T.affectes,
          T.payes,
          T.attente,
          T.reste,
          T.aVerifier,
        ],
        true,
        'FFE8F3EC',
      );
      l += 2;
    };
    tableau('Par liste', s.parPopulation, 'Liste');
    tableau('Par département', s.parDepartement, 'Département');
    tableau('Par cycle', s.parCycle, 'Cycle');
    tableau('Par année du texte d’intégration', s.parAnnee, 'Année du texte');
    bloc('Ce qui est à régler');
    titres(syn, l, ['Point à régler', 'Personnes', '', '', '', '']);
    l++;
    for (const x of s.aRegler) {
      ligne(syn, l, [x.libelle, x.n, '', '', '', '']);
      l++;
    }
    l++;
    bloc('Comment lire ce document');
    for (const [mot, explication] of DEFINITIONS) {
      syn.mergeCells(l, 1, l, 6);
      const x = syn.getCell(l, 1);
      x.value = {
        richText: [
          {
            text: `${mot} : `,
            font: { name: 'Calibri', size: 10, bold: true },
          },
          { text: explication, font: { name: 'Calibri', size: 10 } },
        ],
      };
      x.alignment = { wrapText: true, vertical: 'top' };
      syn.getRow(l).height = Math.max(
        15,
        Math.ceil(explication.length / 95) * 14,
      );
      l++;
    }
    l++;
    bloc('Sources utilisées');
    for (const t of [
      `Registre de la bourse : ${sources.registre} fiches · textes reçus de la Fonction Publique : ${sources.textes} recrues`,
      `Affectation : la structure où travaille chaque fonctionnaire ou contractuel (base du personnel) ; à défaut, les notes signées dans le système (${sources.notesSignees}) ou importées (${sources.referencesNotes})`,
      `Base du personnel : ${sources.personnelPaye} fonctionnaires et contractuels, dont ${sources.personnelSansMatricule} sans matricule`,
      `Fichiers de la Solde chargés : ${sources.moisSolde} mois`,
    ]) {
      syn.mergeCells(l, 1, l, 6);
      const x = syn.getCell(l, 1);
      x.value = `• ${t}`;
      x.font = { name: 'Calibri', size: 10 };
      l++;
    }
    [52, 13, 13, 13, 13, 14, 16, 13].forEach(
      (w, i) => (syn.getColumn(i + 1).width = w),
    );

    // 2. Liste nominative, 3. À régler
    const COLS: [string, number][] = [
      ['N°', 6],
      ['Nom et prénoms', 30],
      ['Liste', 13],
      ['Vague', 7],
      ['Département', 15],
      ['Cycle', 16],
      ['Registre de la bourse', 14],
      ['Dernier mois de bourse', 14],
      ['Texte d’intégration', 26],
      ['Date du texte', 12],
      ['Structure où il travaille (affectation)', 26],
      ['Département de la structure', 15],
      ['Note d’affectation (si retrouvée)', 18],
      ['Statut (personnel)', 15],
      ['Matricule solde', 14],
      ['Indice', 9],
      ['Premier mois de salaire', 15],
      ['Situation', 30],
      ['À régler', 44],
      ['Piste à vérifier', 34],
    ];
    const feuille = (nom: string, t: string, liste: LigneSuivi[]) => {
      const ws = wb.addWorksheet(nom, {
        pageSetup: {
          paperSize: 9,
          orientation: 'landscape',
          fitToPage: true,
          fitToWidth: 1,
          fitToHeight: 0,
          printTitlesRow: '13:13',
        },
      });
      entete(ws, COLS.length, t);
      titres(
        ws,
        13,
        COLS.map((x) => x[0]),
      );
      liste.forEach((x, i) => {
        ligne(
          ws,
          14 + i,
          [
            i + 1,
            x.nom,
            x.population === 'COMMUNAUTAIRE' ? 'Communautaire' : 'Volontaire',
            x.vague,
            x.departement,
            x.cycle,
            x.registre === 'EN_POSTE'
              ? 'En poste'
              : x.registre === 'SORTI'
                ? `Sorti (${x.motifSortie ?? ''})`
                : 'Absent',
            x.dernierMoisBourse ?? '',
            x.texte ? `${x.texte.nature} n° ${x.texte.numero}` : '',
            x.texte?.date ?? '',
            x.note?.lieu ?? '',
            x.note?.departement ?? '',
            x.note?.numero
              ? `n° ${x.note.numero}${x.note.date ? ` du ${x.note.date}` : ''}`
              : '',
            x.salaire?.statut ?? '',
            x.salaire?.matricule ?? '',
            x.salaire?.indice ?? '',
            x.salaire?.premierMois ?? '',
            SITUATIONS[x.situation],
            x.aRegler.join(' · '),
            x.piste ?? '',
          ],
          false,
          i % 2 ? 'FFF4F4F5' : undefined,
        );
      });
      COLS.forEach(([, w], i) => (ws.getColumn(i + 1).width = w));
      if (liste.length)
        ws.autoFilter = {
          from: { row: 13, column: 1 },
          to: { row: 13 + liste.length, column: COLS.length },
        };
    };
    const tri = (a: LigneSuivi, b: LigneSuivi) =>
      a.population.localeCompare(b.population) ||
      a.departement.localeCompare(b.departement, 'fr') ||
      a.nom.localeCompare(b.nom, 'fr');
    feuille(
      'Liste nominative',
      `${titreDoc} — LISTE NOMINATIVE`,
      [...lignes].sort(tri),
    );
    feuille(
      'À régler',
      `${titreDoc} — À RÉGLER`,
      lignes.filter((x) => x.aRegler.length).sort(tri),
    );
    return {
      nom: `Suivi de l'intégration des volontaires et communautaires (${new Date().toLocaleDateString('fr-FR').replace(/\//g, '-')}).xlsx`,
      contenu: Buffer.from(await wb.xlsx.writeBuffer()),
    };
  }

  /** Le Word de la synthèse (en-tête officiel, paysage), pour la Banque mondiale. */
  async word(f: FiltresSuivi): Promise<{ nom: string; contenu: Buffer }> {
    const { lignes: toutes, sources, personnel } = await this.toutes();
    const B = this.basePersonnel(
      personnel.filter(
        (x) => !f.departementId || x.departementId === f.departementId,
      ),
    );
    const lignes = this.filtrer(toutes, f);
    const s = this.synthese(lignes);
    const deps = new Map(
      (
        await this.ds.query<{ id: number; nom: string }[]>(
          `SELECT id, nom FROM departement`,
        )
      ).map((d) => [d.id, d.nom]),
    );
    const t = (
      x: string,
      o: {
        gras?: boolean;
        taille?: number;
        couleur?: string;
        ital?: boolean;
      } = {},
    ) =>
      new TextRun({
        text: x,
        bold: o.gras,
        size: o.taille ?? 20,
        color: o.couleur,
        italics: o.ital,
        font: 'Calibri',
      });
    const p = (
      x: string,
      o: {
        gras?: boolean;
        taille?: number;
        centre?: boolean;
        avant?: number;
        couleur?: string;
        ital?: boolean;
      } = {},
    ) =>
      new Paragraph({
        alignment: o.centre ? AlignmentType.CENTER : AlignmentType.LEFT,
        spacing: { before: o.avant ?? 0, after: 80 },
        children: [t(x, o)],
      });
    const sansBord = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
    const aucun = {
      top: sansBord,
      bottom: sansBord,
      left: sansBord,
      right: sansBord,
    };
    const bloc = (ls: string[], w: number) =>
      new TableCell({
        borders: aucun,
        width: { size: w, type: WidthType.PERCENTAGE },
        children: ls.map(
          (x) =>
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [t(x, { gras: true, taille: 19 })],
            }),
        ),
      });
    const entete = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        ...aucun,
        insideHorizontal: sansBord,
        insideVertical: sansBord,
      },
      rows: [
        new TableRow({
          children: [
            bloc(
              [
                "MINISTERE DE L'ENSEIGNEMENT PRESCOLAIRE, PRIMAIRE,",
                "SECONDAIRE ET DE L'ALPHABETISATION",
                '-----------',
                'CABINET',
                '-----------',
                'DIRECTION GENERALE DES RESSOURCES HUMAINES',
                "ET DE L'ADMINISTRATION SCOLAIRE",
                '-----------',
              ],
              50,
            ),
            bloc([''], 20),
            bloc(
              [
                'REPUBLIQUE DU CONGO',
                'Unité - Travail - Progrès',
                '-----------',
              ],
              30,
            ),
          ],
        }),
      ],
    });
    const fin = { style: BorderStyle.SINGLE, size: 4, color: 'A1A1AA' };
    const bords = { top: fin, bottom: fin, left: fin, right: fin };
    const tab = (
      entetes: string[],
      rangs: (string | number)[][],
      largeurs: number[],
    ) => {
      const tot = largeurs.reduce((a, b) => a + b, 0);
      const w = largeurs.map((x) => Math.round((x / tot) * 14800));
      const cel = (
        x: string | number,
        k: number,
        o: { tete?: boolean; gris?: boolean; gras?: boolean } = {},
      ) =>
        new TableCell({
          borders: bords,
          width: { size: w[k], type: WidthType.DXA },
          verticalAlign: VerticalAlign.CENTER,
          shading: o.tete
            ? { fill: '0F5132', type: ShadingType.CLEAR, color: 'auto' }
            : o.gris
              ? { fill: 'E8F3EC', type: ShadingType.CLEAR, color: 'auto' }
              : undefined,
          children: [
            new Paragraph({
              alignment:
                typeof x === 'number'
                  ? AlignmentType.RIGHT
                  : AlignmentType.LEFT,
              children: [
                t(
                  typeof x === 'number'
                    ? x.toLocaleString('fr-FR').replace(/\s/g, ' ')
                    : x,
                  {
                    taille: 18,
                    gras: o.tete || o.gras,
                    couleur: o.tete ? 'FFFFFF' : undefined,
                  },
                ),
              ],
            }),
          ],
        });
      return new Table({
        width: { size: 14800, type: WidthType.DXA },
        columnWidths: w,
        rows: [
          new TableRow({
            tableHeader: true,
            children: entetes.map((x, k) => cel(x, k, { tete: true })),
          }),
          ...rangs.map(
            (r, i) =>
              new TableRow({
                cantSplit: true,
                children: r.map((x, k) =>
                  cel(x, k, {
                    gras: i === rangs.length - 1 && r[0] === 'TOTAL',
                    gris: i === rangs.length - 1 && r[0] === 'TOTAL',
                  }),
                ),
              }),
          ),
        ],
      });
    };
    const T = s.total;
    const groupe = (g: Groupe[]) => [
      ...g.map((x) => [
        x.libelle,
        x.base,
        x.recrutes,
        x.affectes,
        x.payes,
        x.attente,
        x.reste,
        x.aVerifier,
      ]),
      [
        'TOTAL',
        T.base,
        T.recrutes,
        T.affectes,
        T.payes,
        T.attente,
        T.reste,
        T.aVerifier,
      ],
    ];
    const doc = new Document({
      sections: [
        {
          properties: {
            page: {
              size: { orientation: PageOrientation.LANDSCAPE },
              margin: { top: 700, bottom: 700, left: 1000, right: 1000 },
            },
          },
          children: [
            entete,
            p(
              'SUIVI DE L’INTÉGRATION DES ENSEIGNANTS VOLONTAIRES ET COMMUNAUTAIRES',
              {
                gras: true,
                taille: 28,
                centre: true,
                avant: 240,
                couleur: '0F5132',
              },
            ),
            p(
              'Toute la base du personnel, puis le parcours des volontaires et communautaires : recrutement, affectation, salaire (matricule solde)',
              { ital: true, centre: true },
            ),
            p(
              `${this.libelleFiltres(f, deps)} · situation au ${new Date().toLocaleDateString('fr-FR')}`,
              { ital: true, centre: true, taille: 18 },
            ),
            p(
              '1. Toute la base du personnel (fonctionnaires et contractuels)',
              {
                gras: true,
                taille: 24,
                avant: 240,
                couleur: '0F5132',
              },
            ),
            tab(
              ['', 'Personnes'],
              [
                [
                  `Fonctionnaires et contractuels (${B.fonctionnaires} + ${B.contractuels})`,
                  B.total,
                ],
                ['Payés (matricule solde)', B.payes],
                [
                  'En attente de matricule (salaire pas encore confirmé)',
                  B.attente,
                ],
                ['Affectés, structure connue dans la fiche', B.avecStructure],
                ['Structure à compléter dans la fiche', B.sansStructure],
              ],
              [75, 25],
            ),
            p('Volontaires et communautaires : où en sont-ils ?', {
              gras: true,
              taille: 24,
              avant: 240,
              couleur: '0F5132',
            }),
            tab(
              ['Étape', 'Personnes', 'Taux'],
              [
                ['Payés en bourse un jour (registre de la bourse)', T.base, ''],
                [
                  'Recrutés (fonctionnaire ou contractuel, texte reçu, ou sortie « recruté »)',
                  T.recrutes,
                  `${s.taux.integration} % du registre`,
                ],
                [
                  'Affectés (fonctionnaires ou contractuels : département et structure)',
                  T.affectes,
                  `${s.taux.affectation} % des recrutés`,
                ],
                [
                  'Payés (matricule solde)',
                  T.payes,
                  `${s.taux.priseEnCharge} % des recrutés`,
                ],
                [
                  'En attente de matricule (salaire pas encore confirmé)',
                  T.attente,
                  '',
                ],
                [
                  'Reste à intégrer (en poste, pas encore recrutés)',
                  T.reste,
                  '',
                ],
              ],
              [60, 15, 25],
            ),
            p('2. Par liste', {
              gras: true,
              taille: 24,
              avant: 240,
              couleur: '0F5132',
            }),
            tab(
              [
                'Liste',
                'Registre',
                'Recrutés',
                'Affectés',
                'Payés (matricule)',
                'Attente de matricule',
                'Reste à intégrer',
                'À vérifier',
              ],
              groupe(s.parPopulation),
              [23, 11, 11, 11, 11, 11, 11, 11],
            ),
            p('3. Par département', {
              gras: true,
              taille: 24,
              avant: 240,
              couleur: '0F5132',
            }),
            tab(
              [
                'Département',
                'Registre',
                'Recrutés',
                'Affectés',
                'Payés (matricule)',
                'Attente de matricule',
                'Reste à intégrer',
                'À vérifier',
              ],
              groupe(s.parDepartement),
              [23, 11, 11, 11, 11, 11, 11, 11],
            ),
            p('4. Par cycle', {
              gras: true,
              taille: 24,
              avant: 240,
              couleur: '0F5132',
            }),
            tab(
              [
                'Cycle',
                'Registre',
                'Recrutés',
                'Affectés',
                'Payés (matricule)',
                'Attente de matricule',
                'Reste à intégrer',
                'À vérifier',
              ],
              groupe(s.parCycle),
              [23, 11, 11, 11, 11, 11, 11, 11],
            ),
            p('5. Ce qui est à régler', {
              gras: true,
              taille: 24,
              avant: 240,
              couleur: '0F5132',
            }),
            tab(
              ['Point à régler', 'Personnes'],
              s.aRegler.map((x) => [x.libelle, x.n]),
              [80, 20],
            ),
            p('Sources', { gras: true, taille: 22, avant: 240 }),
            p(
              `Registre de la bourse : ${sources.registre} fiches · textes reçus : ${sources.textes} recrues · notes signées dans le système : ${sources.notesSignees} · base du personnel : ${sources.personnelPaye} fonctionnaires et contractuels (dont ${sources.personnelSansMatricule} sans matricule) · fichiers de la Solde chargés : ${sources.moisSolde} mois.`,
              { taille: 18 },
            ),
            p('Comment lire ce document', {
              gras: true,
              taille: 22,
              avant: 240,
            }),
            ...DEFINITIONS.map(
              ([mot, explication]) =>
                new Paragraph({
                  spacing: { after: 60 },
                  children: [
                    t(`${mot} : `, { gras: true, taille: 18 }),
                    t(explication, { taille: 18 }),
                  ],
                }),
            ),
          ],
        },
      ],
    });
    return {
      nom: `Suivi de l'intégration - synthèse (${new Date().toLocaleDateString('fr-FR').replace(/\//g, '-')}).docx`,
      contenu: await Packer.toBuffer(doc),
    };
  }
}
