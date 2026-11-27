import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { parPreseance, posteResponsable } from '../circuit/catalogue';
import {
  ABREVIATIONS_CYCLE,
  nomAbrege,
  parCycleEtNom,
} from '../common/etablissement-nom';
import { matiereEnseignant, reconnaitreMatiere } from './matieres';
import type { ListeExportee } from '../common/export-liste';
import { normaliser } from '../common/texte';
import {
  gradeAbrege,
  OBSERVATIONS,
  type Observation,
} from '../nominations/categories';
import { JournalService, ParametresService } from '../core/core.service';
import { Batiment, Classe, Referentiel, Salle, Structure } from '../entities';
import { RecensementService } from '../recensement/recensement.service';

/**
 * Écoles (DG, réunion de cadrage du 21/10/2026) : les bâtiments, les salles et les classes ouvertes
 * de chaque établissement, puis le besoin en enseignants qui s'en déduit.
 *
 * Calcul du besoin :
 * - préscolaire, primaire, alphabétisation (un maître par classe) : autant d'enseignants que de
 *   classes ;
 * - collège et lycée : pour chaque matière, les heures du programme de chaque classe ouverte
 *   (référentiel PROGRAMME) sont additionnées, puis divisées par les heures d'un enseignant
 *   (paramètre HEURES_ENSEIGNANT, 20 h par défaut). On compare aux enseignants de la matière
 *   rattachés à l'école : il en manque (déficit) ou il y en a trop (pléthore).
 */

export const ETATS = {
  BON: 'Bon état',
  MOYEN: 'État moyen',
  MAUVAIS: 'Mauvais état',
};
/** Cycles où un maître tient toute sa classe. */
const POLYVALENTS = ['PRESCOLAIRE', 'PRIMAIRE', 'ALPHABETISATION'];
const ENSEIGNANT = /ENSEIGN|INSTITUT|PROFESS|MAITRE/;
const HORS_POSTE_POSITION = [
  'DETACHEMENT',
  'DISPONIBILITE',
  'RETRAITE',
  'DECEDE',
];
/**
 * En activité mais pas à son poste (DG, 24/10/2026) : en stage ou en formation (l'instituteur à
 * l'ENS), suspendu, absent de son poste ; il ne compte pas parmi les enseignants existants.
 */
const HORS_POSTE_ACTIVITE = ['RETRAITE', 'SUSPENDU', 'STAGE', 'ABSENT'];

export interface AgentEcole {
  id: number;
  nomComplet: string;
  statut: string;
  /** Qualification (« Fonction / profession » de la fiche). */
  fonction: string | null;
  /** Ce qu'il fait dans la structure (chef de bureau, secrétaire…). */
  fonctionStructure: string | null;
  specialite: string | null;
  /** Diplôme professionnel (sert à reconnaître l'EPS sans spécialité écrite). */
  diplome?: string | null;
  enseignant: boolean;
  enPoste: boolean;
  /** « Disponibilité » de la fiche : TEMPS_PLEIN, TEMPS_PARTIEL (null : non renseigné). */
  tempsTravail?: string | null;
  matricule?: string | null;
  grade?: string | null;
  sexe?: string | null;
}

export interface LigneBesoin {
  matiere: string;
  libelle: string;
  heures: number;
  besoin: number;
  enPlace: number;
  /** En enseignants : négatif = déficit, positif = pléthore. */
  ecart: number;
  etat: 'DEFICIT' | 'EQUILIBRE' | 'PLETHORE';
}

const arrondi = (n: number) => Math.round(n * 10) / 10;

/**
 * Nom court d'un niveau pour nommer ses classes (DG, 24/10/2026) : le niveau reste écrit en
 * toutes lettres (« Troisième »), la classe en chiffres (« 3ème 1 ») ; « 2nde C 1 », « Tle D 2 »
 * au lycée, « CM2 1 » au primaire.
 */
export function nomCourtNiveau(code: string, libelle: string) {
  const c = /^(\d)\s*E?ME$/i.exec(code.trim());
  if (c) return c[1] === '1' ? '1ère' : `${c[1]}ème`;
  const l = libelle.replace(/\s+/g, ' ').trim();
  const lycee = l
    .replace(/^seconde\b/i, '2nde')
    .replace(/^premi[eè]re\b/i, '1ère')
    .replace(/^terminale\b/i, 'Tle');
  if (lycee !== l) return lycee;
  // « Cours Préparatoire 1 » : son code (« CP1 ») est le nom en usage
  if (l.length > 12 && /^[A-Z]{1,4}\d?$/i.test(code.trim())) return code.trim();
  return l;
}
const etat = (ecart: number): LigneBesoin['etat'] =>
  ecart <= -0.5 ? 'DEFICIT' : ecart >= 1 ? 'PLETHORE' : 'EQUILIBRE';
const texte = (v: unknown, n = 120) =>
  typeof v === 'string' || typeof v === 'number'
    ? String(v).replace(/\s+/g, ' ').trim().slice(0, n) || null
    : null;
const entier = (v: unknown, min: number, max: number) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new BadRequestException(`Nombre attendu entre ${min} et ${max}.`);
  return n;
};

/** Cycles et types de structure en clair, pour les listes exportées. */
const LIBELLE_CYCLE_ECOLE: Record<string, string> = {
  PRESCOLAIRE: 'Préscolaire',
  PRIMAIRE: 'Primaire',
  COLLEGE: 'Collège',
  LYCEE: 'Lycée',
  ALPHABETISATION: 'Alphabétisation',
};
const LIBELLE_TYPE_STRUCTURE: Record<string, string> = {
  MINISTERE: 'Ministère',
  CABINET: 'Cabinet',
  INSPECTION_GENERALE: 'Inspection générale',
  DIRECTION_GENERALE: 'Direction générale',
  ORGANISME_TUTELLE: 'Organisme sous tutelle',
  DGRHAS: 'Direction générale',
  DIRECTION_CENTRALE: 'Direction centrale',
  DIRECTION_DGRHAS: 'Direction',
  SERVICE: 'Service',
  SERVICE_DGRHAS: 'Service',
  BUREAU: 'Bureau',
  BUREAU_DGRHAS: 'Bureau',
  DDEPPSA: 'Direction départementale',
  INSPECTION: 'Inspection',
};

@Injectable()
export class EtablissementsService {
  constructor(
    @InjectRepository(Structure)
    private readonly structures: Repository<Structure>,
    @InjectRepository(Batiment)
    private readonly batiments: Repository<Batiment>,
    @InjectRepository(Salle) private readonly salles: Repository<Salle>,
    @InjectRepository(Classe) private readonly classes: Repository<Classe>,
    @InjectRepository(Referentiel)
    private readonly refs: Repository<Referentiel>,
    private readonly rec: RecensementService,
    private readonly params: ParametresService,
    private readonly journal: JournalService,
  ) {}

  /** Nom d'une école tel qu'affiché : l'abréviation du cycle devant (« EP Moungali 3 »), réglée dans les paramètres. */
  nomEcole(nom: string, cycle: string | null) {
    return nomAbrege(nom, cycle, (c) => {
      const [cle, defaut] = ABREVIATIONS_CYCLE[c] ?? [];
      if (!cle) return null;
      return (this.params.get(cle) || defaut || '').trim() || null;
    });
  }

  /** Heures de cours par semaine d'un enseignant : 20 h au collège, 15 h au lycée (paramètres). */
  heuresEnseignant(cycle?: string | null) {
    return cycle === 'LYCEE'
      ? Number(this.params.get('HEURES_ENSEIGNANT_LYCEE')) || 15
      : Number(this.params.get('HEURES_ENSEIGNANT')) || 20;
  }

  annee(a?: string) {
    return a && /^\d{4}-\d{4}$/.test(a) ? a : this.params.get('ANNEE_SCOLAIRE');
  }

  /* ------------------------------ Structures administratives ------------------------------ */

  /**
   * Structures du ministère hors écoles (DG, 24/10/2026), du cabinet aux services et des DDEPPSA aux
   * inspections, avec leur personnel et leurs écoles ; l'écran les range en arbre (chaque structure
   * dans celle qui est au-dessus).
   */
  async arbreStructures(u: UtilisateurConnecte) {
    const p = await this.rec.perimetre(u);
    const conds = [`s.type <> 'ETABLISSEMENT'`, 's.actif'];
    const params: unknown[] = [];
    if ('departementId' in p) {
      params.push(p.departementId);
      conds.push(`s."departementId" = $${params.length}`);
    }
    if ('structures' in p) {
      params.push(p.structures);
      conds.push(`s.id = ANY($${params.length})`);
    }
    // Même ordre que l'organigramme (rang du DG, préséance, sigle)
    const lignes = await this.structures.query<
      {
        id: number;
        nom: string;
        sigle: string;
        type: string;
        parentId: number | null;
        departementId: number | null;
        ordre: number;
        agents: number;
        ecoles: number;
      }[]
    >(
      `SELECT s.id, s.nom, s.sigle, s.type, s."parentId", s."departementId", s.ordre,
              (SELECT count(*)::int FROM agent_recense a WHERE a."structureId" = s.id
                 AND coalesce(a.contentieux->>'etat', 'CONFIRME') = 'CONFIRME' AND a.retrait IS NULL) AS agents,
              (SELECT count(*)::int FROM structure e WHERE e."parentId" = s.id AND e.type = 'ETABLISSEMENT' AND e.actif) AS ecoles
         FROM structure s WHERE ${conds.join(' AND ')}`,
      params,
    );
    return lignes.sort(parPreseance);
  }

  /** Une structure administrative : où elle se trouve, son responsable et son personnel. */
  async personnelStructure(u: UtilisateurConnecte, id: number) {
    const s = await this.structure(u, id);
    const chemin: { id: number; nom: string; sigle: string }[] = [];
    for (let x = s.parentId, i = 0; x && i < 10; i++) {
      const parent = await this.structures.findOne({ where: { id: x } });
      if (!parent) break;
      chemin.unshift({ id: parent.id, nom: parent.nom, sigle: parent.sigle });
      x = parent.parentId;
    }
    const [agents, responsable, dessous] = await Promise.all([
      this.agentsDe([id]),
      s.responsableId
        ? this.structures.query<{ id: number; nomComplet: string }[]>(
            `SELECT id, "nomComplet" FROM agent_recense WHERE id = $1`,
            [s.responsableId],
          )
        : Promise.resolve([]),
      this.structures.query<
        {
          id: number;
          nom: string;
          sigle: string;
          type: string;
          ordre: number;
          cycle: string | null;
        }[]
      >(
        `SELECT id, nom, sigle, type, ordre, cycle FROM structure WHERE "parentId" = $1 AND actif`,
        [id],
      ),
    ]);
    // Les écoles sous une structure : par cycle, puis l'ordre alphabétique (DG, 06/11/2026)
    const etabs = dessous
      .filter((x) => x.type === 'ETABLISSEMENT')
      .map((x) => ({ ...x, nom: this.nomEcole(x.nom, x.cycle) }))
      .sort(parCycleEtNom);
    const autres = dessous.filter((x) => x.type !== 'ETABLISSEMENT');
    return {
      structure: {
        id: s.id,
        nom: s.nom,
        sigle: s.sigle,
        type: s.type,
        departementId: s.departementId,
        posteResponsable: posteResponsable(s),
        responsable: responsable[0] ?? null,
        responsableInterim: s.responsableInterim,
      },
      chemin,
      dessous: [...autres.sort(parPreseance), ...etabs],
      // Le responsable en poste : sa fonction est celle de la structure (chef de service, inspecteur…)
      agents: (agents.get(id) ?? []).map((a) => ({
        ...a,
        fonctionStructure:
          a.id === s.responsableId
            ? `${posteResponsable(s)}${s.responsableInterim ? ' (intérim)' : ''}`
            : a.fonctionStructure,
      })),
    };
  }

  /**
   * « Inst. A. 1/Promu (e) » : grade abrégé et échelon, puis l'observation de sa nomination validée
   * (au féminin pour une femme, « (e) » si le genre n'est pas connu), comme dans les nominations.
   */
  ligneGrade(
    a: {
      grade: string | null;
      echelon: string | null;
      statut: string | null;
      genre: string | null;
      fonction: string | null;
      /** Le grade vient de la nomination : déjà écrit en abrégé (« Inst C »), gardé tel quel. */
      gradeNomination?: boolean;
    },
    observation: string | null,
  ): string | null {
    const genre = a.genre;
    // Un contractuel prend sa qualification (« Instituteur » → « Inst. C. »)
    const g = a.gradeNomination
      ? a.grade?.trim() || null
      : gradeAbrege(a.grade, {
          statut: a.statut,
          // « Directeur », « Directrice » : un poste, pas un métier
          qualification: /^(DIRECT|PROVISEUR|CHEF|RESPONSABLE|CENSEUR)/i.test(
            a.fonction ?? '',
          )
            ? null
            : a.fonction,
        });
    const ge = [g, a.echelon?.trim()].filter(Boolean).join(' ');
    const o = observation ? OBSERVATIONS[observation as Observation] : null;
    const obs = o
      ? /^F/i.test(genre ?? '')
        ? o.feminin
        : /^M/i.test(genre ?? '')
          ? o.libelle
          : `${o.libelle} (e)`
      : null;
    return [ge, obs].filter(Boolean).join('/') || null;
  }

  /* ------------------------------ Localisation (GPS) ------------------------------ */

  /**
   * Position GPS d'une école ou d'un de ses bâtiments (DG, 21/11/2026), prélevée sur place par la
   * mission de terrain (bouton « Prélever la localisation ») ou saisie à la main. Une position hors du
   * Congo est refusée (erreur de saisie) ; null efface la position.
   */
  async localiser(
    u: UtilisateurConnecte,
    id: number,
    dto: { latitude?: unknown; longitude?: unknown; precision?: unknown },
    batimentId?: number,
  ) {
    const s = await this.structure(u, id);
    const efface = dto.latitude === null && dto.longitude === null;
    const lat = Number(dto.latitude);
    const lng = Number(dto.longitude);
    if (!efface) {
      if (!Number.isFinite(lat) || !Number.isFinite(lng))
        throw new BadRequestException('Position GPS illisible.');
      // Le Congo et ses abords : latitude −5,5 à 4, longitude 10,5 à 19,5
      if (lat < -5.5 || lat > 4 || lng < 10.5 || lng > 19.5)
        throw new BadRequestException(
          `Cette position (${lat.toFixed(5)}, ${lng.toFixed(5)}) n’est pas au Congo : vérifiez les chiffres (latitude puis longitude).`,
        );
    }
    const prec = Number(dto.precision);
    const valeurs = efface
      ? {
          latitude: null,
          longitude: null,
          precisionGps: null,
          localiseLe: null,
          localisePar: null,
        }
      : {
          latitude: lat,
          longitude: lng,
          precisionGps: Number.isFinite(prec) ? Math.round(prec) : null,
          localiseLe: new Date(),
          localisePar: u.nom,
        };
    if (batimentId) {
      const b = await this.batiments.findOne({
        where: { id: batimentId, structureId: s.id },
      });
      if (!b) throw new NotFoundException('Bâtiment introuvable.');
      await this.batiments.update(b.id, valeurs);
    } else await this.structures.update(s.id, valeurs);
    await this.journal.log(u, 'ECOLE_LOCALISEE', 'structure', String(s.id), {
      batimentId: batimentId ?? null,
      ...valeurs,
    });
    return valeurs;
  }

  /* ------------------------------ Accès ------------------------------ */

  /** Structure du périmètre du compte (DGRHAS : toutes ; DDEPPSA : son département ; chef : la sienne). */
  async structure(u: UtilisateurConnecte, id: number) {
    const s = await this.structures.findOne({ where: { id } });
    if (!s) throw new NotFoundException('Structure introuvable');
    const p = await this.rec.perimetre(u);
    const ok =
      'tous' in p ||
      ('departementId' in p
        ? s.departementId === p.departementId
        : p.structures.includes(s.id));
    if (!ok)
      throw new ForbiddenException(
        'Cette structure n’est pas dans votre périmètre.',
      );
    return s;
  }

  /** Écoles du périmètre, avec leurs chiffres (classes, salles, agents rattachés). */
  async liste(
    u: UtilisateurConnecte,
    f: {
      q?: string;
      departement?: number;
      cycle?: string;
      annee?: string;
      page?: number;
      taille?: number;
      /** Toutes les écoles d'un coup (export, impression) : pas de page. */
      tout?: boolean;
    },
  ) {
    const p = await this.rec.perimetre(u);
    // Une page à la fois (08/11/2026 : toutes les écoles, page après page)
    const taille = Math.min(200, Math.max(10, f.taille ?? 50));
    const page = Math.max(1, f.page ?? 1);
    const annee = this.annee(f.annee);
    const conds = [`s.type = 'ETABLISSEMENT'`, 's.actif'];
    const params: unknown[] = [annee];
    const ajouter = (sql: string, v: unknown) => {
      params.push(v);
      conds.push(sql.replace('$X', `$${params.length}`));
    };
    if ('departementId' in p)
      ajouter('s."departementId" = $X', p.departementId);
    if ('structures' in p) ajouter('s.id = ANY($X)', p.structures);
    if (f.departement) ajouter('s."departementId" = $X', f.departement);
    if (f.cycle) ajouter('s.cycle = $X', f.cycle);
    for (const m of normaliser(f.q ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 5))
      ajouter(
        // Les anciens noms (avant le répertoire officiel) restent cherchables
        `translate(upper(s.nom || ' ' || coalesce(s.localite, '') || ' ' || coalesce(s.code, '') || ' ' || s."anciensNoms"::text), 'ÀÁÂÄÃÉÈÊËÍÌÎÏÓÒÔÖÕÚÙÛÜÇ', 'AAAAAEEEEIIIIOOOOOUUUUC') LIKE $X`,
        `%${m}%`,
      );
    const lignes = await this.structures.query<
      {
        id: number;
        nom: string;
        code: string | null;
        cycle: string | null;
        localite: string | null;
        departement: string | null;
        inspection: string | null;
        classes: number;
        salles: number;
        agents: number;
        total: number;
      }[]
    >(
      `SELECT s.id, s.nom, s.code, s.cycle, s.localite, d.nom AS departement, i.sigle AS inspection,
              coalesce(nullif((SELECT count(*)::int FROM classe c WHERE c."structureId" = s.id AND c."anneeScolaire" = $1), 0),
                       (SELECT k.nombre FROM classes_declarees k WHERE k."structureId" = s.id AND k."anneeScolaire" = $1), 0) AS classes,
              (SELECT count(*)::int FROM salle x WHERE x."structureId" = s.id) AS salles,
              (SELECT count(*)::int FROM agent_recense a WHERE a."structureId" = s.id AND coalesce(a.contentieux->>'etat', 'CONFIRME') = 'CONFIRME' AND a.retrait IS NULL) AS agents,
              count(*) OVER ()::int AS total
         FROM structure s
         LEFT JOIN departement d ON d.id = s."departementId"
         LEFT JOIN structure i ON i.id = s."parentId"
        WHERE ${conds.join(' AND ')}
        ORDER BY CASE s.cycle WHEN 'PRESCOLAIRE' THEN 1 WHEN 'PRIMAIRE' THEN 2 WHEN 'COLLEGE' THEN 3 WHEN 'LYCEE' THEN 4 ELSE 9 END,
                 -- le nom sans l'abréviation du cycle : le même ordre d'une page à l'autre
                 regexp_replace(upper(s.nom), '^(CEP|EP|CEG|LYCEE|LYCÉE|ECOLE|ÉCOLE)\\s+', ''), s.id
        ${f.tout ? '' : `LIMIT ${taille} OFFSET ${(page - 1) * taille}`}`,
      params,
    );
    // Par cycle (préscolaire, primaire, collège, lycée), puis l'ordre alphabétique du nom abrégé
    // (« EP Moungali 3 ») : DG, 06/11/2026
    const total = lignes[0]?.total ?? 0;
    return {
      annee,
      page,
      taille,
      total,
      pages: Math.max(1, Math.ceil(total / taille)),
      lignes: lignes
        .map((l) => ({
          id: l.id,
          nom: this.nomEcole(l.nom, l.cycle),
          code: l.code,
          cycle: l.cycle,
          localite: l.localite,
          departement: l.departement,
          inspection: l.inspection,
          classes: l.classes,
          salles: l.salles,
          agents: l.agents,
        }))
        .sort(parCycleEtNom),
    };
  }

  /* ------------------------------ Listes à exporter ------------------------------ */

  /** Nom d'un département (pour rappeler le filtre dans le titre d'une liste). */
  private async nomDepartement(id?: number) {
    if (!id) return null;
    const [d] = await this.structures.query<{ nom: string }[]>(
      `SELECT nom FROM departement WHERE id = $1`,
      [id],
    );
    return d?.nom ?? null;
  }

  /**
   * Liste des écoles à imprimer ou exporter (DG, 08/11/2026) : toutes celles du filtre choisi à
   * l'écran (recherche, département, cycle), sans page.
   */
  async exportEcoles(
    u: UtilisateurConnecte,
    f: { q?: string; departement?: number; cycle?: string; annee?: string },
  ) {
    const r = await this.liste(u, { ...f, tout: true });
    const dep = await this.nomDepartement(f.departement);
    const filtres = [
      dep && `Département : ${dep}`,
      f.cycle && `Cycle : ${LIBELLE_CYCLE_ECOLE[f.cycle] ?? f.cycle}`,
      f.q?.trim() && `Recherche : « ${f.q.trim()} »`,
    ].filter(Boolean);
    const liste: ListeExportee = {
      titre: 'LISTE DES ÉCOLES',
      sousTitre: `Année scolaire ${r.annee} · ${r.total.toLocaleString('fr-FR')} école(s)${filtres.length ? ` · ${filtres.join(' · ')}` : ''}`,
      nomFeuille: 'Écoles',
      entetes: [
        'N°',
        'Code',
        'École',
        'Cycle',
        'Inspection',
        'Localité',
        'Département',
        'Classes',
        'Salles',
        'Agents rattachés',
      ],
      // Le code de l'école dans le référentiel (« PRI-LEP »), demandé le 18/11/2026
      largeurs: [6, 12, 38, 13, 17, 20, 17, 8, 8, 11],
      nombres: [0, 7, 8, 9],
      lignes: r.lignes.map((l, i) => [
        i + 1,
        l.code ?? '',
        l.nom,
        l.cycle ? (LIBELLE_CYCLE_ECOLE[l.cycle] ?? l.cycle) : '',
        l.inspection ?? '',
        l.localite ?? '',
        l.departement ?? '',
        l.classes,
        l.salles,
        l.agents,
      ]),
    };
    return { annee: r.annee, total: r.total, lignes: r.lignes, liste };
  }

  /**
   * Personnel d'une école à imprimer ou exporter (DG, 27/11/2026) : dans l'ordre de l'écran (les
   * enseignants à temps plein d'abord), avec le filtre « Temps de travail » choisi.
   */
  async exportPersonnelEcole(
    u: UtilisateurConnecte,
    id: number,
    temps?: string,
  ) {
    const s = await this.structure(u, id);
    const [agents, parent, dep, prog] = await Promise.all([
      this.agentsDe([id]),
      s.parentId
        ? this.structures.findOne({ where: { id: s.parentId } })
        : null,
      this.nomDepartement(s.departementId ?? undefined),
      ['COLLEGE', 'LYCEE'].includes(s.cycle ?? '')
        ? this.programmes(s.cycle!)
        : null,
    ]);
    const rang = (a: AgentEcole) =>
      (a.enseignant ? 0 : 3) +
      (a.tempsTravail === 'TEMPS_PLEIN'
        ? 0
        : a.tempsTravail === 'TEMPS_PARTIEL'
          ? 1
          : 2);
    const tous = agents.get(id) ?? [];
    const choisis = tous
      .filter((a) =>
        !temps
          ? true
          : temps === 'AUCUN'
            ? !a.tempsTravail
            : a.tempsTravail === temps,
      )
      .map((a, i) => ({ a, i }))
      .sort((x, y) => rang(x.a) - rang(y.a) || x.i - y.i)
      .map((x) => x.a);
    const enseignants = choisis.filter((a) => a.enseignant).length;
    const enPoste = choisis.filter((a) => a.enPoste).length;
    const TEMPS: Record<string, string> = {
      TEMPS_PLEIN: 'Temps plein',
      TEMPS_PARTIEL: 'Temps partiel',
      AUCUN: 'Temps de travail non renseigné',
    };
    const STATUT: Record<string, string> = {
      FONCTIONNAIRE: 'Fonctionnaire',
      CONTRACTUEL: 'Contractuel',
      VOLONTAIRE: 'Volontaire',
      COMMUNAUTAIRE: 'Communautaire',
    };
    const matiere = (a: AgentEcole) => {
      const m = prog ? this.matiereAgent(a, prog.matieres) : null;
      return (m && prog?.matieres.get(m)) || a.specialite || '';
    };
    const liste: ListeExportee = {
      titre: `PERSONNEL DE L’ÉCOLE ${s.nom.toUpperCase()}`,
      sousTitre: [
        s.cycle ? (LIBELLE_CYCLE_ECOLE[s.cycle] ?? s.cycle) : null,
        parent?.nom,
        dep && `Département : ${dep}`,
        temps && TEMPS[temps],
        `${choisis.length.toLocaleString('fr-FR')} agent(s), dont ${enseignants.toLocaleString('fr-FR')} enseignant(s)`,
      ]
        .filter(Boolean)
        .join(' · '),
      nomFeuille: 'Personnel',
      figer: false,
      entetes: [
        'N°',
        'Matricule',
        'Nom et prénoms',
        'Sexe',
        'Statut',
        'Grade',
        'Qualification',
        'Fonction dans l’école',
        prog ? 'Matière' : 'Spécialité',
        'Temps de travail',
        'En poste',
      ],
      largeurs: [5, 11, 28, 6, 13, 12, 18, 18, 16, 12, 8],
      nombres: [0],
      lignes: choisis.map((a, i) => [
        i + 1,
        a.matricule ?? '',
        a.nomComplet,
        (a.sexe ?? '').slice(0, 1).toUpperCase(),
        STATUT[a.statut] ?? a.statut ?? '',
        a.grade ?? '',
        a.fonction ?? '',
        a.fonctionStructure ?? (a.enseignant ? 'Enseignant' : ''),
        matiere(a),
        a.tempsTravail ? (TEMPS[a.tempsTravail] ?? a.tempsTravail) : '',
        a.enPoste ? 'Oui' : 'Non',
      ]),
      fin: `Arrêtée la présente liste à ${choisis.length.toLocaleString('fr-FR')} agent(s), dont ${enseignants.toLocaleString('fr-FR')} enseignant(s) ; ${enPoste.toLocaleString('fr-FR')} en poste.`,
    };
    return {
      ecole: s.nom,
      total: choisis.length,
      enseignants,
      enPoste,
      lignes: liste.lignes,
      liste,
    };
  }

  /**
   * Liste des structures administratives à imprimer ou exporter (DG, 08/11/2026), dans l'ordre de
   * l'organigramme, chacune en retrait sous celle dont elle dépend. Filtres : recherche (sigle ou
   * nom), type, département.
   */
  async exportStructures(
    u: UtilisateurConnecte,
    f: { q?: string; type?: string; departement?: number },
  ) {
    const toutes = await this.arbreStructures(u);
    const ids = new Set(toutes.map((x) => x.id));
    const enfants = new Map<number, typeof toutes>();
    const racines: typeof toutes = [];
    const ministere = toutes.find((x) => x.type === 'MINISTERE' && !x.parentId);
    for (const x of toutes) {
      // Les DDEPPSA sans structure au-dessus : sous le ministère, après les directions générales
      const parent =
        x.parentId && ids.has(x.parentId)
          ? x.parentId
          : x.type === 'DDEPPSA' && ministere
            ? ministere.id
            : null;
      if (parent === null) racines.push(x);
      else enfants.set(parent, [...(enfants.get(parent) ?? []), x]);
    }
    const parId = new Map(toutes.map((x) => [x.id, x]));
    // Personnel avec tout ce qui en dépend
    const totalDe = new Map<number, number>();
    const compter = (id: number): number => {
      if (totalDe.has(id)) return totalDe.get(id)!;
      const t =
        (parId.get(id)?.agents ?? 0) +
        (enfants.get(id) ?? []).reduce((s, x) => s + compter(x.id), 0);
      totalDe.set(id, t);
      return t;
    };
    const ordre: { s: (typeof toutes)[number]; niveau: number }[] = [];
    const parcourir = (x: (typeof toutes)[number], niveau: number) => {
      ordre.push({ s: x, niveau });
      for (const e of enfants.get(x.id) ?? []) parcourir(e, niveau + 1);
    };
    for (const r of racines) parcourir(r, 0);
    const mots = normaliser(f.q ?? '')
      .split(/\s+/)
      .filter(Boolean);
    const garde = ordre.filter(
      ({ s }) =>
        (!f.type || s.type === f.type) &&
        (!f.departement || s.departementId === f.departement) &&
        mots.every((m) => normaliser(`${s.sigle} ${s.nom}`).includes(m)),
    );
    const filtre = !!(f.type || f.departement || mots.length);
    // Filtrée, la liste n'a plus d'arbre : pas de retrait
    const base = filtre ? Math.min(...garde.map((x) => x.niveau), 0) : 0;
    const lignes = garde.map(({ s, niveau }) => ({
      id: s.id,
      niveau: filtre ? 0 : niveau - base,
      sigle: s.sigle,
      nom: s.nom,
      type: LIBELLE_TYPE_STRUCTURE[s.type] ?? s.type,
      superieure: s.parentId ? (parId.get(s.parentId)?.sigle ?? '') : '',
      departement: s.departementId,
      agents: s.agents,
      agentsTotal: compter(s.id),
      dessous: (enfants.get(s.id) ?? []).length,
      ecoles: s.ecoles,
    }));
    const deps = new Map(
      (
        await this.structures.query<{ id: number; nom: string }[]>(
          `SELECT id, nom FROM departement`,
        )
      ).map((d) => [d.id, d.nom]),
    );
    const filtres = [
      f.type && `Type : ${LIBELLE_TYPE_STRUCTURE[f.type] ?? f.type}`,
      f.departement && `Département : ${deps.get(f.departement) ?? ''}`,
      mots.length && `Recherche : « ${f.q!.trim()} »`,
    ].filter(Boolean);
    const liste: ListeExportee = {
      titre: 'LISTE DES STRUCTURES ADMINISTRATIVES',
      sousTitre: `${lignes.length.toLocaleString('fr-FR')} structure(s), dans l’ordre de l’organigramme${filtres.length ? ` · ${filtres.join(' · ')}` : ''}`,
      nomFeuille: 'Structures',
      entetes: [
        'N°',
        'Sigle',
        'Nom',
        'Type',
        'Dépend de',
        'Département',
        'Agents de la structure',
        'Agents avec ce qui en dépend',
        'Structures en dessous',
        'Écoles rattachées',
      ],
      largeurs: [6, 20, 52, 20, 16, 16, 12, 14, 12, 11],
      nombres: [0, 6, 7, 8, 9],
      retrait: filtre
        ? undefined
        : { colonne: 1, niveaux: lignes.map((l) => l.niveau) },
      lignes: lignes.map((l, i) => [
        i + 1,
        l.sigle,
        l.nom,
        l.type,
        l.superieure,
        l.departement ? (deps.get(l.departement) ?? '') : '',
        l.agents,
        l.agentsTotal,
        l.dessous,
        l.ecoles,
      ]),
    };
    return {
      total: lignes.length,
      lignes: lignes.map((l) => ({
        ...l,
        departement: l.departement ? (deps.get(l.departement) ?? null) : null,
      })),
      liste,
    };
  }

  /* ------------------------------ Fiche d'une école ------------------------------ */

  async fiche(u: UtilisateurConnecte, id: number, anneeDemandee?: string) {
    const s = await this.structure(u, id);
    const annee = this.annee(anneeDemandee);
    const [batiments, salles, classes, agents, parent, responsable] =
      await Promise.all([
        this.batiments.find({
          where: { structureId: id },
          order: { nom: 'ASC' },
        }),
        this.salles.find({ where: { structureId: id }, order: { nom: 'ASC' } }),
        this.classes.find({
          where: { structureId: id, anneeScolaire: annee },
          order: { niveau: 'ASC', nom: 'ASC' },
        }),
        this.agentsDe([id]),
        s.parentId
          ? this.structures.findOne({ where: { id: s.parentId } })
          : null,
        s.responsableId
          ? this.structures.query<
              {
                id: number;
                nom: string;
                statut: string | null;
                grade: string | null;
                echelon: string | null;
                genre: string | null;
                fonction: string | null;
                gradeNomination: boolean;
                observation: string | null;
              }[]
            >(
              // Grade, échelon et observation de la nomination (« Inst. A. 1/Promu (e) », DG 21/11/2026)
              // Le grade et l'échelon de la nomination d'abord (ceux de la note), sinon ceux de la fiche
              `SELECT a.id, a."nomComplet" AS nom, a.statut,
                      coalesce(nullif(n.grade, ''), a.donnees->>'GRADE') AS grade,
                      nullif(n.grade, '') IS NOT NULL AS "gradeNomination",
                      coalesce(nullif(n.echelon, ''), a.donnees->>'ECHELON') AS echelon,
                      a.donnees->>'FONCTION' AS fonction, coalesce(n.genre, a.donnees->>'GENRE') AS genre,
                      n.observation
                 FROM agent_recense a
                 LEFT JOIN LATERAL (
                   SELECT observation, genre, grade, echelon FROM nomination
                    WHERE "agentId" = a.id AND statut = 'VALIDEE'
                    ORDER BY annee DESC, id DESC LIMIT 1
                 ) n ON true
                WHERE a.id = $1`,
              [s.responsableId],
            )
          : [],
      ]);
    const r = responsable[0];
    const ligneResponsable = r ? this.ligneGrade(r, r.observation) : null;
    const matieresCycle = ['COLLEGE', 'LYCEE'].includes(s.cycle ?? '')
      ? (await this.programmes(s.cycle!)).matieres
      : null;
    return {
      structure: {
        id: s.id,
        nom: s.nom,
        sigle: s.sigle,
        cycle: s.cycle,
        localite: s.localite,
        departementId: s.departementId,
        inspection: parent ? { id: parent.id, nom: parent.nom } : null,
        // Position GPS de l'école (mission de terrain)
        latitude: s.latitude,
        longitude: s.longitude,
        precisionGps: s.precisionGps,
        localiseLe: s.localiseLe,
        localisePar: s.localisePar,
        // « Directeur(trice) d'école » (DG, 21/11/2026)
        posteResponsable: posteResponsable(s).replace(
          /^Directeur\b/,
          'Directeur(trice)',
        ),
        responsable: r
          ? { id: r.id, nom: r.nom, grade: ligneResponsable }
          : null,
        responsableInterim: s.responsableInterim,
      },
      annee,
      batiments,
      salles,
      classes,
      agents: (agents.get(id) ?? []).map((a) => ({
        ...a,
        // Matière reconnue (collège, lycée) : celle qui compte pour les besoins et l'emploi du temps
        matiere: matieresCycle ? this.matiereAgent(a, matieresCycle) : null,
      })),
      // Matières du cycle, pour choisir celle d'un enseignant depuis la page de l'école
      matieres: matieresCycle
        ? [...matieresCycle].map(([code, libelle]) => ({ code, libelle }))
        : [],
      niveaux: await this.refs.find({
        where: { type: 'NIVEAU', parent: s.cycle ?? '', actif: true },
        order: { ordre: 'ASC', libelle: 'ASC' },
        select: ['code', 'libelle'],
      }),
      besoins: await this.besoins(
        s,
        classes,
        agents.get(id) ?? [],
        undefined,
        await this.classesDeclarees(id, annee),
      ),
    };
  }

  /** Agents rattachés aux structures, avec ce qu'il faut pour le calcul (enseignant, matière, en poste). */
  async agentsDe(ids: number[]) {
    const lignes = await this.structures.query<
      {
        id: number;
        structureId: number;
        nomComplet: string;
        statut: string;
        fonction: string | null;
        fonctionStructure: string | null;
        specialite: string | null;
        diplome: string | null;
        position: string | null;
        activite: string | null;
        tempsTravail: string | null;
        matricule: string | null;
        grade: string | null;
        sexe: string | null;
      }[]
    >(
      `SELECT id, "structureId", "nomComplet", statut, matricule, donnees->>'GRADE' AS grade,
              coalesce(donnees->>'GENRE', donnees->>'SEXE') AS sexe, donnees->>'FONCTION' AS fonction,
              donnees->>'FONCTION_STRUCTURE' AS "fonctionStructure",
              donnees->>'SPECIALITE' AS specialite, donnees->>'DIPLOME_PRO' AS diplome,
              donnees->>'POSITION' AS position,
              donnees->>'STATUT_ACTIVITE' AS activite,
              donnees->>'DISPONIBILITE' AS "tempsTravail"
         FROM agent_recense WHERE "structureId" = ANY($1) AND coalesce(contentieux->>'etat', 'CONFIRME') = 'CONFIRME' AND retrait IS NULL ORDER BY "nomComplet"`,
      [ids],
    );
    const m = new Map<number, AgentEcole[]>();
    for (const l of lignes) {
      const f = normaliser(l.fonction);
      const a: AgentEcole = {
        id: l.id,
        nomComplet: l.nomComplet,
        statut: l.statut,
        fonction: l.fonction,
        fonctionStructure: l.fonctionStructure,
        specialite: l.specialite,
        diplome: l.diplome,
        tempsTravail: l.tempsTravail || null,
        matricule: l.matricule,
        grade: l.grade,
        sexe: l.sexe,
        // Volontaires et communautaires sans fonction écrite : ce sont des enseignants
        enseignant:
          ENSEIGNANT.test(f) ||
          (!f && ['VOLONTAIRE', 'COMMUNAUTAIRE'].includes(l.statut)),
        enPoste:
          !HORS_POSTE_POSITION.includes(l.position ?? '') &&
          !HORS_POSTE_ACTIVITE.includes(l.activite ?? ''),
      };
      m.set(l.structureId, [...(m.get(l.structureId) ?? []), a]);
    }
    return m;
  }

  /** Programmes (heures par niveau et matière) et libellés des matières d'un cycle. */
  async programmes(cycle: string) {
    const [prog, mat] = await Promise.all([
      this.refs.find({
        where: { type: 'PROGRAMME', parent: cycle, actif: true },
      }),
      this.refs.find({ where: { type: 'MATIERE', parent: cycle } }),
    ]);
    const parNiveau = new Map<string, { matiere: string; heures: number }[]>();
    for (const p of prog) {
      const d = p.donnees as {
        niveau?: string;
        matiere?: string;
        heures?: number;
      };
      if (!d.niveau || !d.matiere) continue;
      parNiveau.set(d.niveau, [
        ...(parNiveau.get(d.niveau) ?? []),
        { matiere: d.matiere, heures: Number(d.heures) || 0 },
      ]);
    }
    return {
      parNiveau,
      matieres: new Map(mat.map((x) => [x.code, x.libelle])),
    };
  }

  /** Matière enseignée d'après la spécialité écrite dans la fiche, quelle que soit son écriture. */
  matiereDe(specialite: string | null, matieres: Map<string, string>) {
    return reconnaitreMatiere(specialite, matieres);
  }

  /** Matière d'un enseignant : sa spécialité, sinon l'EPS d'après son diplôme ou sa fonction. */
  matiereAgent(a: AgentEcole, matieres: Map<string, string>) {
    return matiereEnseignant(a, matieres);
  }

  /**
   * Matière enseignée par un enseignant de l'école, choisie depuis la page de l'école (DG, 26/10/2026 :
   * les fiches venues de l'enrôlement n'ont presque jamais la spécialité). Elle va dans la rubrique
   * « Spécialité » de sa fiche ; vide : la spécialité est effacée.
   */
  async definirMatiere(
    u: UtilisateurConnecte,
    structureId: number,
    agentId: number,
    code: string | null,
  ) {
    const s = await this.structure(u, structureId);
    if (!['COLLEGE', 'LYCEE'].includes(s.cycle ?? ''))
      throw new BadRequestException(
        'La matière se choisit dans les collèges et les lycées (au primaire, un maître fait toutes les matières).',
      );
    const libelle = code
      ? ((await this.programmes(s.cycle!)).matieres.get(code) ?? null)
      : null;
    if (code && !libelle)
      throw new BadRequestException('Matière inconnue pour ce cycle.');
    const [a] = await this.structures.query<{ id: number }[]>(
      `SELECT id FROM agent_recense WHERE id = $1 AND "structureId" = $2`,
      [agentId, structureId],
    );
    if (!a)
      throw new NotFoundException(
        'Cet agent n’est pas rattaché à cette école.',
      );
    await this.structures.query(
      `UPDATE agent_recense
          SET donnees = CASE WHEN $2::text IS NULL THEN donnees - 'SPECIALITE'
                             ELSE jsonb_set(donnees, '{SPECIALITE}', to_jsonb($2::text)) END,
              "modifiePar" = $3, "modifieLe" = now()
        WHERE id = $1`,
      [agentId, libelle, u.nom],
    );
    await this.journal.log(
      u,
      'ECOLE_MATIERE_ENSEIGNANT',
      'agent_recense',
      agentId,
      {
        structureId,
        matiere: libelle,
      },
    );
    return { ok: true, specialite: libelle };
  }

  /** Nombre de classes du fichier des allocations budgétaires, pour une école et une année. */
  async classesDeclarees(id: number, annee: string) {
    const r = await this.classes.query<{ nombre: number }[]>(
      `SELECT nombre FROM classes_declarees WHERE "structureId" = $1 AND "anneeScolaire" = $2`,
      [id, annee],
    );
    return r[0]?.nombre ?? null;
  }

  async classesDeclareesDe(annee: string) {
    const r = await this.classes.query<{ id: number; nombre: number }[]>(
      `SELECT "structureId" AS id, nombre FROM classes_declarees WHERE "anneeScolaire" = $1`,
      [annee],
    );
    return new Map(r.map((x) => [x.id, x.nombre]));
  }

  /** Besoin en enseignants d'une école pour ses classes ouvertes. */
  async besoins(
    s: Pick<Structure, 'cycle'>,
    classes: Pick<Classe, 'niveau'>[],
    agents: AgentEcole[],
    prog?: Awaited<ReturnType<EtablissementsService['programmes']>>,
    declarees?: number | null,
  ) {
    const H = this.heuresEnseignant(s.cycle);
    const enseignants = agents.filter((a) => a.enseignant && a.enPoste);
    // Nombre de classes du fichier des allocations budgétaires : seulement quand aucune classe
    // n'est saisie une par une pour l'année (DG, 26/11/2026)
    const nDeclarees = !classes.length && declarees ? declarees : 0;
    const base = {
      heuresEnseignant: H,
      classes: classes.length || nDeclarees,
      classesDeclarees: nDeclarees > 0,
      enseignants: enseignants.length,
    };
    const avisDeclarees =
      'Nombre de classes du fichier des allocations budgétaires (classes non saisies une par une).';
    if (!s.cycle)
      return {
        ...base,
        mode: 'INCONNU' as const,
        lignes: [],
        total: null,
        alertes: ['Cycle de l’école à indiquer dans l’organigramme.'],
      };
    if (POLYVALENTS.includes(s.cycle)) {
      const nClasses = classes.length || nDeclarees;
      const ecart = enseignants.length - nClasses;
      return {
        ...base,
        mode: 'CLASSE' as const,
        lignes: [],
        total: {
          heures: null,
          besoin: nClasses,
          enPlace: enseignants.length,
          ecart,
          etat: etat(ecart),
        },
        alertes: classes.length
          ? []
          : nDeclarees
            ? [avisDeclarees]
            : ['Aucune classe saisie pour cette année.'],
      };
    }
    const p = prog ?? (await this.programmes(s.cycle));
    if (nDeclarees) {
      // Les niveaux ne sont pas connus : heures moyennes d'une classe du cycle, sans détail par matière
      const parClasse = [...p.parNiveau.values()]
        .map((l) => l.reduce((n, x) => n + x.heures, 0))
        .filter((h) => h > 0);
      const moyenne = parClasse.length
        ? parClasse.reduce((x, y) => x + y, 0) / parClasse.length
        : 0;
      const totalH = arrondi(nDeclarees * moyenne);
      const besoin = arrondi(totalH / H);
      const ecart = arrondi(enseignants.length - besoin);
      return {
        ...base,
        mode: 'MATIERE' as const,
        sansMatiere: 0,
        lignes: [],
        total: moyenne
          ? {
              heures: totalH,
              besoin,
              enPlace: enseignants.length,
              ecart,
              etat: etat(ecart),
            }
          : null,
        alertes: [
          `${avisDeclarees} Besoin estimé avec les heures moyennes d’une classe du cycle ; le détail par matière demande les classes saisies une par une.`,
          ...(moyenne
            ? []
            : [
                'Programme (heures par matière) manquant : à compléter dans Administration › Référentiels › Programmes.',
              ]),
        ],
      };
    }
    const heures = new Map<string, number>();
    const sansProgramme = new Set<string>();
    for (const c of classes) {
      const l = p.parNiveau.get(c.niveau);
      if (!l?.length) sansProgramme.add(c.niveau);
      for (const x of l ?? [])
        heures.set(x.matiere, (heures.get(x.matiere) ?? 0) + x.heures);
    }
    const enPlace = new Map<string, number>();
    let sansMatiere = 0;
    for (const a of enseignants) {
      const m = this.matiereAgent(a, p.matieres);
      if (m) enPlace.set(m, (enPlace.get(m) ?? 0) + 1);
      else sansMatiere++;
    }
    const lignes: LigneBesoin[] = [
      ...new Set([...heures.keys(), ...enPlace.keys()]),
    ]
      .map((m) => {
        const h = heures.get(m) ?? 0;
        // Écart calculé sur le besoin affiché (arrondi au dixième) : les chiffres se recoupent
        const besoin = arrondi(h / H);
        const n = enPlace.get(m) ?? 0;
        const ecart = arrondi(n - besoin);
        return {
          matiere: m,
          libelle: p.matieres.get(m) ?? m,
          heures: h,
          besoin,
          enPlace: n,
          ecart,
          etat: etat(ecart),
        };
      })
      .sort((a, b) => a.ecart - b.ecart || a.libelle.localeCompare(b.libelle));
    const totalH = [...heures.values()].reduce((x, y) => x + y, 0);
    const ecartTotal = arrondi(enseignants.length - arrondi(totalH / H));
    const alertes: string[] = [];
    if (!classes.length) alertes.push('Aucune classe saisie pour cette année.');
    if (sansProgramme.size)
      alertes.push(
        `Programme (heures par matière) manquant pour : ${[...sansProgramme].join(', ')}. À compléter dans Administration › Référentiels › Programmes.`,
      );
    if (sansMatiere)
      alertes.push(
        `${sansMatiere} enseignant(s) sans spécialité reconnue : renseignez la spécialité dans leur fiche pour les compter dans leur matière.`,
      );
    return {
      ...base,
      mode: 'MATIERE' as const,
      sansMatiere,
      lignes,
      total: {
        heures: totalH,
        besoin: arrondi(totalH / H),
        enPlace: enseignants.length,
        ecart: ecartTotal,
        etat: etat(ecartTotal),
      },
      alertes,
    };
  }

  /**
   * Besoins de toutes les écoles du périmètre qui ont des classes saisies : par école, par
   * département et par matière (collège et lycée).
   */
  async consolidation(
    u: UtilisateurConnecte,
    f: { departement?: number; cycle?: string; annee?: string },
  ) {
    const p = await this.rec.perimetre(u);
    const annee = this.annee(f.annee);
    const ids = (
      await this.classes.query<{ id: number }[]>(
        `SELECT DISTINCT c."structureId" AS id FROM classe c WHERE c."anneeScolaire" = $1
         UNION SELECT k."structureId" FROM classes_declarees k WHERE k."anneeScolaire" = $1`,
        [annee],
      )
    ).map((x) => x.id);
    const declarees = await this.classesDeclareesDe(annee);
    let ecoles = ids.length
      ? await this.structures.find({
          where: { id: In(ids), type: 'ETABLISSEMENT' },
        })
      : [];
    ecoles = ecoles.filter(
      (s) =>
        ('tous' in p ||
          ('departementId' in p
            ? s.departementId === p.departementId
            : p.structures.includes(s.id))) &&
        (!f.departement || s.departementId === f.departement) &&
        (!f.cycle || s.cycle === f.cycle),
    );
    // Aucune école avec des classes : rien à calculer
    const ids2 = ecoles.length ? ecoles.map((e) => e.id) : [-1];
    const [classes, agents, deps] = await Promise.all([
      this.classes.find({
        where: {
          structureId: In(ids2),
          anneeScolaire: annee,
        },
        select: ['structureId', 'niveau'],
      }),
      this.agentsDe(ecoles.map((e) => e.id)),
      this.structures.query<{ id: number; nom: string }[]>(
        `SELECT id, nom FROM departement`,
      ),
    ]);
    const nomDep = new Map(deps.map((d) => [d.id, d.nom]));
    const progs = new Map<
      string,
      Awaited<ReturnType<EtablissementsService['programmes']>>
    >();
    const parEcole: {
      id: number;
      nom: string;
      cycle: string | null;
      departement: string | null;
      classes: number;
      besoin: number;
      enPlace: number;
      ecart: number;
      etat: string;
      alertes: number;
    }[] = [];
    const parMatiere = new Map<
      string,
      { libelle: string; heures: number; besoin: number; enPlace: number }
    >();
    for (const e of ecoles) {
      if (e.cycle && !POLYVALENTS.includes(e.cycle) && !progs.has(e.cycle))
        progs.set(e.cycle, await this.programmes(e.cycle));
      const b = await this.besoins(
        e,
        classes.filter((c) => c.structureId === e.id),
        agents.get(e.id) ?? [],
        e.cycle ? progs.get(e.cycle) : undefined,
        declarees.get(e.id),
      );
      if (!b.total) continue;
      parEcole.push({
        id: e.id,
        nom: e.nom,
        cycle: e.cycle,
        departement: e.departementId
          ? (nomDep.get(e.departementId) ?? null)
          : null,
        classes: b.classes,
        besoin: b.total.besoin,
        enPlace: b.total.enPlace,
        ecart: b.total.ecart,
        etat: b.total.etat,
        alertes: b.alertes.length,
      });
      for (const l of b.lignes) {
        const x = parMatiere.get(`${e.cycle}|${l.libelle}`) ?? {
          libelle: `${l.libelle}`,
          heures: 0,
          besoin: 0,
          enPlace: 0,
        };
        x.heures += l.heures;
        x.besoin += l.besoin;
        x.enPlace += l.enPlace;
        parMatiere.set(`${e.cycle}|${l.libelle}`, x);
      }
    }
    const parDepartement = new Map<
      string,
      {
        departement: string;
        ecoles: number;
        besoin: number;
        enPlace: number;
        deficit: number;
        plethore: number;
      }
    >();
    for (const e of parEcole) {
      const k = e.departement ?? '—';
      const x = parDepartement.get(k) ?? {
        departement: k,
        ecoles: 0,
        besoin: 0,
        enPlace: 0,
        deficit: 0,
        plethore: 0,
      };
      x.ecoles++;
      x.besoin = arrondi(x.besoin + e.besoin);
      x.enPlace += e.enPlace;
      if (e.ecart < 0) x.deficit = arrondi(x.deficit - e.ecart);
      else x.plethore = arrondi(x.plethore + e.ecart);
      parDepartement.set(k, x);
    }
    // Par cycle (DG, 24/10/2026) : « au primaire on a tel besoin, au collège tel besoin… »
    const parCycle = new Map<
      string,
      {
        cycle: string;
        ecoles: number;
        classes: number;
        besoin: number;
        enPlace: number;
        deficit: number;
        plethore: number;
      }
    >();
    for (const e of parEcole) {
      const k = e.cycle ?? '—';
      const x = parCycle.get(k) ?? {
        cycle: k,
        ecoles: 0,
        classes: 0,
        besoin: 0,
        enPlace: 0,
        deficit: 0,
        plethore: 0,
      };
      x.ecoles++;
      x.classes += e.classes;
      x.besoin = arrondi(x.besoin + e.besoin);
      x.enPlace += e.enPlace;
      if (e.ecart < 0) x.deficit = arrondi(x.deficit - e.ecart);
      else x.plethore = arrondi(x.plethore + e.ecart);
      parCycle.set(k, x);
    }
    const ORDRE = [
      'PRESCOLAIRE',
      'PRIMAIRE',
      'COLLEGE',
      'LYCEE',
      'ALPHABETISATION',
    ];
    return {
      annee,
      heuresEnseignant: this.heuresEnseignant('COLLEGE'),
      heuresLycee: this.heuresEnseignant('LYCEE'),
      cycles: [...parCycle.values()]
        .map((x) => ({ ...x, ecart: arrondi(x.enPlace - x.besoin) }))
        .sort(
          (a, b) =>
            ((ORDRE.indexOf(a.cycle) + 99) % 99) -
            ((ORDRE.indexOf(b.cycle) + 99) % 99),
        ),
      ecoles: parEcole.sort((a, b) => a.ecart - b.ecart),
      departements: [...parDepartement.values()].sort(
        (a, b) => b.deficit - a.deficit,
      ),
      matieres: [...parMatiere.entries()]
        .map(([k, x]) => ({
          cycle: k.split('|')[0],
          libelle: x.libelle,
          heures: x.heures,
          besoin: arrondi(x.besoin),
          enPlace: x.enPlace,
          ecart: arrondi(x.enPlace - x.besoin),
        }))
        .sort((a, b) => a.ecart - b.ecart),
    };
  }

  /* ------------------------------ Saisie ------------------------------ */

  private async verifierSalle(structureId: number, salleId: unknown) {
    if (!salleId) return null;
    const s = await this.salles.findOne({
      where: { id: Number(salleId), structureId },
    });
    if (!s) throw new BadRequestException('Salle inconnue dans cette école.');
    return s.id;
  }

  async enregistrerBatiment(
    u: UtilisateurConnecte,
    structureId: number,
    id: number | null,
    dto: Record<string, unknown>,
  ) {
    await this.structure(u, structureId);
    const nom = texte(dto.nom, 120);
    if (!nom)
      throw new BadRequestException(
        'Donnez un nom au bâtiment (ex. Bâtiment A).',
      );
    const b = id
      ? await this.batiments.findOne({ where: { id, structureId } })
      : this.batiments.create({ structureId });
    if (!b) throw new NotFoundException('Bâtiment introuvable');
    Object.assign(b, {
      nom,
      type: texte(dto.type, 80),
      niveaux: entier(dto.niveaux, 1, 20) ?? 1,
      anneeConstruction: entier(
        dto.anneeConstruction,
        1900,
        new Date().getFullYear(),
      ),
      etat:
        typeof dto.etat === 'string' && dto.etat in ETATS ? dto.etat : 'BON',
      observation: texte(dto.observation, 500),
    });
    const r = await this.batiments.save(b);
    await this.journal.log(u, 'ECOLE_BATIMENT', 'structure', structureId, {
      nom,
    });
    return r;
  }

  async enregistrerSalle(
    u: UtilisateurConnecte,
    structureId: number,
    id: number | null,
    dto: Record<string, unknown>,
  ) {
    await this.structure(u, structureId);
    const nom = texte(dto.nom, 80);
    if (!nom)
      throw new BadRequestException('Donnez un nom à la salle (ex. Salle 3).');
    let batimentId: number | null = null;
    if (dto.batimentId) {
      const b = await this.batiments.findOne({
        where: { id: Number(dto.batimentId), structureId },
      });
      if (!b)
        throw new BadRequestException('Bâtiment inconnu dans cette école.');
      batimentId = b.id;
    }
    const x = id
      ? await this.salles.findOne({ where: { id, structureId } })
      : this.salles.create({ structureId });
    if (!x) throw new NotFoundException('Salle introuvable');
    Object.assign(x, {
      nom,
      batimentId,
      type: texte(dto.type, 80),
      capacite: entier(dto.capacite, 1, 500),
      etat:
        typeof dto.etat === 'string' && dto.etat in ETATS ? dto.etat : 'BON',
    });
    const r = await this.salles.save(x);
    await this.journal.log(u, 'ECOLE_SALLE', 'structure', structureId, { nom });
    return r;
  }

  async enregistrerClasse(
    u: UtilisateurConnecte,
    structureId: number,
    id: number | null,
    dto: Record<string, unknown>,
  ) {
    const s = await this.structure(u, structureId);
    const niveau = texte(dto.niveau, 40);
    if (
      !niveau ||
      !(await this.refs.exist({
        where: { type: 'NIVEAU', code: niveau, parent: s.cycle ?? '' },
      }))
    )
      throw new BadRequestException(
        'Choisissez le niveau de la classe (ceux du cycle de l’école).',
      );
    const nom = texte(dto.nom, 40);
    if (!nom)
      throw new BadRequestException(
        'Donnez un nom à la classe (ex. 6ème 1, ou 6ème 1A avec deux vagues).',
      );
    const annee = this.annee(texte(dto.anneeScolaire, 9) ?? undefined);
    const x = id
      ? await this.classes.findOne({ where: { id, structureId } })
      : this.classes.create({ structureId, anneeScolaire: annee });
    if (!x) throw new NotFoundException('Classe introuvable');
    const doublon = await this.classes.findOne({
      where: { structureId, anneeScolaire: x.anneeScolaire, nom },
    });
    if (doublon && doublon.id !== x.id)
      throw new BadRequestException(
        `La classe « ${nom} » existe déjà cette année.`,
      );
    const effectif = entier(dto.effectif, 0, 300);
    const filles = entier(dto.effectifFilles, 0, 300);
    if (effectif !== null && filles !== null && filles > effectif)
      throw new BadRequestException(
        'Plus de filles que d’élèves : vérifiez les effectifs.',
      );
    Object.assign(x, {
      niveau,
      nom,
      salleId: await this.verifierSalle(structureId, dto.salleId),
      effectif,
      effectifFilles: filles,
    });
    const r = await this.classes.save(x);
    await this.journal.log(u, 'ECOLE_CLASSE', 'structure', structureId, {
      nom,
      niveau,
    });
    return r;
  }

  /**
   * Ouvre en une fois plusieurs classes d'un niveau (« 6e » × 3 → 6e 1, 6e 2, 6e 3), ou reprend
   * les classes de l'année précédente.
   */
  async ouvrirClasses(
    u: UtilisateurConnecte,
    structureId: number,
    dto: {
      niveau?: string;
      nombre?: number;
      prefixe?: string;
      /** Deux vagues (matin, après-midi) : « 6ème 1A », « 6ème 1B ». */
      vague?: string;
      reprendre?: boolean;
      anneeScolaire?: string;
    },
  ) {
    const s = await this.structure(u, structureId);
    const annee = this.annee(dto.anneeScolaire);
    const existantes = await this.classes.find({
      where: { structureId, anneeScolaire: annee },
    });
    const noms = new Set(existantes.map((c) => c.nom));
    const nouvelles: Classe[] = [];
    if (dto.reprendre) {
      const [a] = annee.split('-').map(Number);
      const avant = await this.classes.find({
        where: { structureId, anneeScolaire: `${a - 1}-${a}` },
      });
      if (!avant.length)
        throw new BadRequestException(
          `Aucune classe en ${a - 1}-${a} à reprendre.`,
        );
      for (const c of avant)
        if (!noms.has(c.nom))
          nouvelles.push(
            this.classes.create({
              structureId,
              anneeScolaire: annee,
              niveau: c.niveau,
              nom: c.nom,
              salleId: c.salleId,
            }),
          );
    } else {
      const niveau = texte(dto.niveau, 40);
      const n = entier(dto.nombre, 1, 30);
      if (!niveau || !n)
        throw new BadRequestException(
          'Choisissez le niveau et le nombre de classes.',
        );
      const ref = await this.refs.findOne({
        where: { type: 'NIVEAU', code: niveau, parent: s.cycle ?? '' },
      });
      if (!ref)
        throw new BadRequestException(
          'Niveau inconnu pour le cycle de l’école.',
        );
      const prefixe =
        texte(dto.prefixe, 30) ?? nomCourtNiveau(ref.code, ref.libelle);
      const vague = /^[A-Z]$/i.test(dto.vague?.trim() ?? '')
        ? dto.vague!.trim().toUpperCase()
        : '';
      for (let i = 1, k = 0; k < n; i++) {
        const nom = `${prefixe} ${i}${vague}`;
        if (noms.has(nom)) continue;
        noms.add(nom);
        nouvelles.push(
          this.classes.create({
            structureId,
            anneeScolaire: annee,
            niveau,
            nom,
          }),
        );
        k++;
      }
    }
    await this.classes.save(nouvelles);
    await this.journal.log(u, 'ECOLE_CLASSES', 'structure', structureId, {
      annee,
      ouvertes: nouvelles.length,
    });
    return { ouvertes: nouvelles.length };
  }

  async supprimer(
    u: UtilisateurConnecte,
    structureId: number,
    quoi: 'batiment' | 'salle' | 'classe',
    id: number,
  ) {
    await this.structure(u, structureId);
    if (quoi === 'batiment') {
      if (await this.salles.exist({ where: { batimentId: id } }))
        throw new BadRequestException(
          'Des salles sont dans ce bâtiment : déplacez-les ou supprimez-les d’abord.',
        );
      await this.batiments.delete({ id, structureId });
    } else if (quoi === 'salle') {
      await this.classes.update(
        { salleId: id, structureId },
        { salleId: null },
      );
      await this.salles.delete({ id, structureId });
    } else await this.classes.delete({ id, structureId });
    await this.journal.log(u, 'ECOLE_SUPPRESSION', 'structure', structureId, {
      quoi,
      id,
    });
    return { supprime: true };
  }
}
