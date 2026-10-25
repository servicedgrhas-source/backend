import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { posteResponsable } from '../circuit/catalogue';
import { normaliser } from '../common/texte';
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
  fonction: string | null;
  specialite: string | null;
  enseignant: boolean;
  enPoste: boolean;
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
    return this.structures.query<
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
                 AND coalesce(a.contentieux->>'etat', 'CONFIRME') = 'CONFIRME') AS agents,
              (SELECT count(*)::int FROM structure e WHERE e."parentId" = s.id AND e.type = 'ETABLISSEMENT' AND e.actif) AS ecoles
         FROM structure s WHERE ${conds.join(' AND ')}
        ORDER BY s.ordre, s.nom`,
      params,
    );
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
        { id: number; nom: string; sigle: string; type: string }[]
      >(
        `SELECT id, nom, sigle, type FROM structure WHERE "parentId" = $1 AND actif ORDER BY ordre, nom`,
        [id],
      ),
    ]);
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
      dessous,
      agents: agents.get(id) ?? [],
    };
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
    f: { q?: string; departement?: number; cycle?: string; annee?: string },
  ) {
    const p = await this.rec.perimetre(u);
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
        `translate(upper(s.nom || ' ' || coalesce(s.localite, '')), 'ÀÁÂÄÃÉÈÊËÍÌÎÏÓÒÔÖÕÚÙÛÜÇ', 'AAAAAEEEEIIIIOOOOOUUUUC') LIKE $X`,
        `%${m}%`,
      );
    const lignes = await this.structures.query<
      {
        id: number;
        nom: string;
        cycle: string | null;
        localite: string | null;
        departement: string | null;
        inspection: string | null;
        classes: number;
        salles: number;
        agents: number;
      }[]
    >(
      `SELECT s.id, s.nom, s.cycle, s.localite, d.nom AS departement, i.sigle AS inspection,
              (SELECT count(*)::int FROM classe c WHERE c."structureId" = s.id AND c."anneeScolaire" = $1) AS classes,
              (SELECT count(*)::int FROM salle x WHERE x."structureId" = s.id) AS salles,
              (SELECT count(*)::int FROM agent_recense a WHERE a."structureId" = s.id AND coalesce(a.contentieux->>'etat', 'CONFIRME') = 'CONFIRME') AS agents
         FROM structure s
         LEFT JOIN departement d ON d.id = s."departementId"
         LEFT JOIN structure i ON i.id = s."parentId"
        WHERE ${conds.join(' AND ')}
        ORDER BY (SELECT count(*) FROM classe c WHERE c."structureId" = s.id AND c."anneeScolaire" = $1) DESC, s.nom
        LIMIT 200`,
      params,
    );
    return { annee, lignes };
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
          ? this.structures.query<{ id: number; nom: string }[]>(
              `SELECT id, "nomComplet" AS nom FROM agent_recense WHERE id = $1`,
              [s.responsableId],
            )
          : [],
      ]);
    return {
      structure: {
        id: s.id,
        nom: s.nom,
        sigle: s.sigle,
        cycle: s.cycle,
        localite: s.localite,
        departementId: s.departementId,
        inspection: parent ? { id: parent.id, nom: parent.nom } : null,
        posteResponsable: posteResponsable(s),
        responsable: responsable[0] ?? null,
        responsableInterim: s.responsableInterim,
      },
      annee,
      batiments,
      salles,
      classes,
      agents: agents.get(id) ?? [],
      niveaux: await this.refs.find({
        where: { type: 'NIVEAU', parent: s.cycle ?? '', actif: true },
        order: { ordre: 'ASC', libelle: 'ASC' },
        select: ['code', 'libelle'],
      }),
      besoins: await this.besoins(s, classes, agents.get(id) ?? []),
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
        specialite: string | null;
        position: string | null;
        activite: string | null;
      }[]
    >(
      `SELECT id, "structureId", "nomComplet", statut, donnees->>'FONCTION' AS fonction,
              donnees->>'SPECIALITE' AS specialite, donnees->>'POSITION' AS position,
              donnees->>'STATUT_ACTIVITE' AS activite
         FROM agent_recense WHERE "structureId" = ANY($1) AND coalesce(contentieux->>'etat', 'CONFIRME') = 'CONFIRME' ORDER BY "nomComplet"`,
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
        specialite: l.specialite,
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

  /** Matière enseignée d'après la spécialité écrite dans la fiche (même nom, accents et casse mis à part). */
  matiereDe(specialite: string | null, matieres: Map<string, string>) {
    const sp = normaliser(specialite).replace(/[^A-Z0-9]+/g, '');
    if (!sp) return null;
    for (const [code, lib] of matieres) {
      const l = normaliser(lib).replace(/[^A-Z0-9]+/g, '');
      if (
        l &&
        (l === sp || (sp.length >= 4 && (l.startsWith(sp) || sp.startsWith(l))))
      )
        return code;
    }
    return null;
  }

  /** Besoin en enseignants d'une école pour ses classes ouvertes. */
  async besoins(
    s: Pick<Structure, 'cycle'>,
    classes: Pick<Classe, 'niveau'>[],
    agents: AgentEcole[],
    prog?: Awaited<ReturnType<EtablissementsService['programmes']>>,
  ) {
    const H = Number(this.params.get('HEURES_ENSEIGNANT')) || 20;
    const enseignants = agents.filter((a) => a.enseignant && a.enPoste);
    const base = {
      heuresEnseignant: H,
      classes: classes.length,
      enseignants: enseignants.length,
    };
    if (!s.cycle)
      return {
        ...base,
        mode: 'INCONNU' as const,
        lignes: [],
        total: null,
        alertes: ['Cycle de l’école à indiquer dans l’organigramme.'],
      };
    if (POLYVALENTS.includes(s.cycle)) {
      const ecart = enseignants.length - classes.length;
      return {
        ...base,
        mode: 'CLASSE' as const,
        lignes: [],
        total: {
          heures: null,
          besoin: classes.length,
          enPlace: enseignants.length,
          ecart,
          etat: etat(ecart),
        },
        alertes: classes.length
          ? []
          : ['Aucune classe saisie pour cette année.'],
      };
    }
    const p = prog ?? (await this.programmes(s.cycle));
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
      const m = this.matiereDe(a.specialite, p.matieres);
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
        `SELECT DISTINCT c."structureId" AS id FROM classe c WHERE c."anneeScolaire" = $1`,
        [annee],
      )
    ).map((x) => x.id);
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
      heuresEnseignant: Number(this.params.get('HEURES_ENSEIGNANT')) || 20,
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
