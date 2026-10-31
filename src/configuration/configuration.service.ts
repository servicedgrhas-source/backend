import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ImportBaseService } from '../affectation/import.service';
import type { UtilisateurConnecte } from '../auth/auth';
import {
  codeCycle,
  CYCLES,
  ECRITURES_DEFAUT,
  GRADE_DU_DIPLOME_DEFAUT,
  GRADES_DEFAUT,
  NOTES_AFFECTATION,
  reconnaitreDiplome,
  REGLES_DIPLOMES,
} from '../common/referentiels';
import { cleCompacte, nettoyer } from '../common/texte';
import { JournalService } from '../core/core.service';
import { Affectation, Agent, Grade, RegleDiplome } from '../entities';

const ANOMALIE_DIPLOME = 'Diplôme non reconnu';
const ANOMALIE_CYCLE = 'Cycle de la base différent de celui du diplôme';

export interface GradeDto {
  /** Diplômes pour lesquels ce grade est aussi possible (en plus de leur grade par défaut). */
  diplomesAutres?: string[];
  abreviation: string;
  libelle: string;
  categorie: string | null;
  echelle: number | null;
  echelon: number | null;
  indice?: number | null;
}

export interface RegleDto {
  libelle: string;
  ecritures: string[];
  cycle: string;
  typeNote: string;
  gradeCode: string | null;
}

function codeDepuis(texte: string) {
  return cleCompacte(texte).slice(0, 30) || 'X';
}

@Injectable()
export class ConfigurationService implements OnApplicationBootstrap {
  constructor(
    @InjectRepository(Grade) private readonly grades: Repository<Grade>,
    @InjectRepository(RegleDiplome)
    private readonly regles: Repository<RegleDiplome>,
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
    @InjectRepository(Affectation)
    private readonly affectations: Repository<Affectation>,
    private readonly importation: ImportBaseService,
    private readonly journal: JournalService,
  ) {}

  /* --------------------------- Mise en place --------------------------- */

  onApplicationBootstrap() {
    return this.initialiser();
  }

  /**
   * Au démarrage : crée les grades et les diplômes de départ si les listes sont vides,
   * et rattache les diplômes existants à leur grade (base créée avant cette version).
   */
  async initialiser() {
    if ((await this.grades.count()) === 0)
      await this.grades.insert(GRADES_DEFAUT);
    if ((await this.regles.count()) === 0)
      await this.regles.insert(
        REGLES_DIPLOMES.map((r) => ({
          ...r,
          gradeCode: GRADE_DU_DIPLOME_DEFAUT[r.code] ?? null,
          ecritures: ECRITURES_DEFAUT[r.code] ?? [r.libelle],
        })),
      );
    for (const r of await this.regles.find()) {
      const maj: Partial<RegleDiplome> = {};
      if (!r.gradeCode && GRADE_DU_DIPLOME_DEFAUT[r.code])
        maj.gradeCode = GRADE_DU_DIPLOME_DEFAUT[r.code];
      if (!r.ecritures?.length)
        maj.ecritures = ECRITURES_DEFAUT[r.code] ?? [r.libelle];
      if (Object.keys(maj).length) await this.regles.update(r.code, maj);
    }
    await this.synchroniserCopies();
    await this.miseAJourDuDG();
  }

  /**
   * Corrections demandées par le DG le 17/10/2026, appliquées une seule fois
   * à une base existante (les modifications faites ensuite à l'écran sont respectées).
   */
  private async miseAJourDuDG() {
    const CLE = 'MIGRATION_REGLES_DG_20261017';
    const [deja] = await this.regles.query<unknown[]>(
      'SELECT 1 FROM parametre WHERE cle = $1',
      [CLE],
    );
    if (deja) return;
    const sql = (q: string, p: unknown[] = []) => this.regles.query(q, p);
    // Indices et classification du tableau du DG
    for (const g of GRADES_DEFAUT)
      await sql(
        'UPDATE grade SET indice = $2 WHERE code = $1 AND indice IS NULL',
        [g.code, g.indice],
      );
    await sql(
      "UPDATE grade SET echelle = 1 WHERE code = 'COM_SAF' AND echelle = 2",
    );
    // Écriture des grades sur les notes : « Inst. », « Inst.C. »
    for (const [code, avant, apres] of [
      ['INST', 'Inst', 'Inst.'],
      ['INST_A', 'Inst.A', 'Inst.A.'],
      ['ECON', 'Econ', 'Econ.'],
    ])
      await sql(
        'UPDATE grade SET abreviation = $3 WHERE code = $1 AND abreviation = $2',
        [code, avant, apres],
      );
    // Le BEP est traité comme le BAC (catégorie II, échelle 1, primaire)
    await sql(`UPDATE regle_diplome SET cycle = 'PRIMAIRE', "typeNote" = 'PRIMAIRE', "gradeCode" = 'INST'
      WHERE code = 'BEP' AND cycle = 'PRESCOLAIRE'`);
    // Le CFEEN préscolaire devient un diplôme à part (même niveau que le CFEEN primaire)
    await sql(
      `UPDATE regle_diplome SET ecritures = ecritures - 'CFEEN-Préscolaire' WHERE code = 'BET'`,
    );
    await sql(`UPDATE regle_diplome SET ecritures = ecritures || '["DCAS"]'::jsonb
      WHERE code = 'DECS' AND NOT ecritures ? 'DCAS'`);
    const existants = new Set((await this.regles.find()).map((r) => r.code));
    const ecrituresPrises = new Set(
      (await this.regles.find()).flatMap((r) => r.ecritures.map(cleCompacte)),
    );
    for (const code of ['CFEEN_PRESCO', 'DUT', 'DEUG']) {
      const r = REGLES_DIPLOMES.find((x) => x.code === code);
      if (!r || existants.has(code)) continue;
      await this.regles.insert({
        ...r,
        gradeCode: GRADE_DU_DIPLOME_DEFAUT[code] ?? null,
        ecritures: (ECRITURES_DEFAUT[code] ?? [r.libelle]).filter(
          (e) => !ecrituresPrises.has(cleCompacte(e)),
        ),
      });
    }
    await sql(
      'INSERT INTO parametre (cle, valeur, description) VALUES ($1, $2, $3)',
      [
        CLE,
        new Date().toISOString(),
        'Corrections des règles demandées par le DG (appliquées une fois)',
      ],
    );
    await this.synchroniserCopies();
    await this.appliquer();
  }

  /**
   * Grade choisi pour une personne : sa classification suit celle du grade ; un choix qui n'est plus
   * possible (diplôme retiré du grade, devenu le grade par défaut, autre diplôme) est retiré. Les
   * personnes déjà dans une note validée gardent tout. Renvoie le nombre de choix retirés.
   */
  private async synchroniserGradesChoisis(): Promise<number> {
    const modifiables = `NOT EXISTS (SELECT 1 FROM affectation f WHERE f."agentId" = a.id AND f.statut = 'AFFECTE')`;
    await this.agents.query(`
      UPDATE agent a SET "gradeChoisi" = a."gradeChoisi" || jsonb_build_object('abreviation', g.abreviation,
        'libelle', g.libelle, 'categorie', g.categorie, 'echelle', g.echelle, 'echelon', g.echelon, 'indice', g.indice)
      FROM grade g WHERE g.code = a."gradeChoisi"->>'code' AND ${modifiables}`);
    const r = await this.agents.query<unknown[]>(`
      UPDATE agent a SET "gradeChoisi" = NULL
      WHERE a."gradeChoisi" IS NOT NULL AND ${modifiables} AND NOT EXISTS (
        SELECT 1 FROM regle_diplome r WHERE r.code = a."diplomeCode"
          AND r."gradeCode" IS DISTINCT FROM a."gradeChoisi"->>'code'
          AND r."gradesAutres" ? (a."gradeChoisi"->>'code'))
      RETURNING a.id`);
    return Array.isArray(r[0]) ? (r[0] as unknown[]).length : r.length;
  }

  /** Recopie la classification du grade dans chaque règle (lecture rapide par les calculs). */
  private async synchroniserCopies() {
    await this.regles.query(`
      UPDATE regle_diplome r SET grade = g.abreviation, "gradeLibelle" = g.libelle,
        categorie = g.categorie, echelle = g.echelle, echelon = g.echelon, indice = g.indice
      FROM grade g WHERE g.code = r."gradeCode"`);
    await this.regles.query(`
      UPDATE regle_diplome SET grade = NULL, "gradeLibelle" = NULL, categorie = NULL, echelle = NULL, echelon = NULL, indice = NULL
      WHERE "gradeCode" IS NULL OR "gradeCode" NOT IN (SELECT code FROM grade)`);
    // Le grade par défaut n'est pas aussi un « autre grade » ; un grade supprimé disparaît
    await this.regles.query(`
      UPDATE regle_diplome r SET "gradesAutres" = coalesce((
        SELECT jsonb_agg(x) FROM jsonb_array_elements_text(r."gradesAutres") x
        WHERE x IS DISTINCT FROM r."gradeCode" AND x IN (SELECT code FROM grade)), '[]')
      WHERE jsonb_array_length(r."gradesAutres") > 0`);
    return this.synchroniserGradesChoisis();
  }

  /* ------------------------------ Lecture ------------------------------ */

  async etat() {
    const grades = await this.grades.find({ order: { libelle: 'ASC' } });
    const regles = await this.regles.find({ order: { libelle: 'ASC' } });
    const parDiplome = await this.agents.query<{ code: string; n: number }[]>(
      `SELECT "diplomeCode" AS code, count(*)::int AS n FROM agent WHERE "diplomeCode" IS NOT NULL GROUP BY 1`,
    );
    const nonReconnus = await this.agents.query<
      { libelle: string | null; n: number }[]
    >(`
      SELECT NULLIF(trim("diplomeBrut"), '') AS libelle, count(*)::int AS n FROM agent
      WHERE "diplomeCode" IS NULL GROUP BY 1 ORDER BY 2 DESC, 1`);
    const n = (code: string) => parDiplome.find((x) => x.code === code)?.n ?? 0;
    // Personnes à qui ce grade a été donné à la demande
    const choisis = await this.agents.query<{ code: string; n: number }[]>(
      `SELECT "gradeChoisi"->>'code' AS code, count(*)::int AS n FROM agent WHERE "gradeChoisi" IS NOT NULL GROUP BY 1`,
    );
    return {
      grades: grades.map((g) => ({
        ...g,
        diplomes: regles
          .filter((r) => r.gradeCode === g.code)
          .map((r) => r.libelle),
        diplomesAutres: regles
          .filter((r) => (r.gradesAutres ?? []).includes(g.code))
          .map((r) => ({ code: r.code, libelle: r.libelle })),
        personnes: choisis.find((x) => x.code === g.code)?.n ?? 0,
      })),
      regles: regles.map((r) => ({ ...r, agents: n(r.code) })),
      nonReconnus,
      cycles: CYCLES,
      notes: Object.entries(NOTES_AFFECTATION).map(([code, d]) => ({
        code,
        libelle: d.libelle,
      })),
    };
  }

  /** Nombre d'agents (pas encore dans une note validée) que la règle proposée concernerait. */
  async apercu(code: string | null, dto: RegleDto) {
    const autres = (await this.regles.find()).filter((r) => r.code !== code);
    const simulees = [
      ...autres,
      { code: '__NOUVELLE__', ecritures: dto.ecritures },
    ];
    const liste = await this.agentsModifiables();
    const concernes = liste.filter(
      (a) => reconnaitreDiplome(a.diplomeBrut, simulees) === '__NOUVELLE__',
    );
    return {
      agents: concernes.length,
      exemples: [
        ...new Set(concernes.map((a) => a.diplomeBrut).filter(Boolean)),
      ].slice(0, 8),
    };
  }

  /* ------------------------------- Grades ------------------------------ */

  private verifierGrade(dto: GradeDto) {
    if (!nettoyer(dto.abreviation))
      throw new BadRequestException(
        "L'abréviation du grade est obligatoire (ex. Inst)",
      );
    if (!nettoyer(dto.libelle))
      throw new BadRequestException('Le nom complet du grade est obligatoire');
  }

  async creerGrade(u: UtilisateurConnecte, dto: GradeDto) {
    this.verifierGrade(dto);
    let code = codeDepuis(dto.abreviation);
    while (await this.grades.findOne({ where: { code } })) code = `${code}_2`;
    const g = await this.grades.save({ ...this.nettoyerGrade(dto), code });
    await this.rattacherDiplomes(code, dto.diplomesAutres);
    await this.journal.log(u, 'CREATION_GRADE', 'grade', code, {
      ...this.nettoyerGrade(dto),
      diplomesAutres: dto.diplomesAutres ?? [],
    });
    return g;
  }

  /**
   * Diplômes rattachés à un grade (en plus de leur grade par défaut) : le grade s'ajoute à leurs
   * « autres grades » et se retire de ceux qui ne sont plus cochés. Rien si la liste n'est pas donnée.
   */
  private async rattacherDiplomes(code: string, diplomes?: string[]) {
    if (!diplomes) return 0;
    const voulus = new Set(diplomes);
    for (const r of await this.regles.find()) {
      const avant = r.gradesAutres ?? [];
      const apres =
        voulus.has(r.code) && r.gradeCode !== code
          ? [...new Set([...avant, code])]
          : avant.filter((x) => x !== code);
      if (apres.length !== avant.length)
        await this.regles.update(r.code, { gradesAutres: apres });
    }
    return this.synchroniserCopies();
  }

  async modifierGrade(u: UtilisateurConnecte, code: string, dto: GradeDto) {
    this.verifierGrade(dto);
    const g = await this.grades.findOne({ where: { code } });
    if (!g) throw new NotFoundException('Grade introuvable');
    await this.grades.update(code, this.nettoyerGrade(dto));
    await this.synchroniserCopies();
    const retires = await this.rattacherDiplomes(code, dto.diplomesAutres);
    await this.journal.log(u, 'MODIFICATION_GRADE', 'grade', code, {
      avant: {
        abreviation: g.abreviation,
        categorie: g.categorie,
        echelle: g.echelle,
        echelon: g.echelon,
      },
      apres: this.nettoyerGrade(dto),
      diplomesAutres: dto.diplomesAutres,
      choixRetires: retires,
    });
    // Personnes remises au grade par défaut de leur diplôme (diplôme décoché)
    return { ...(await this.grades.findOne({ where: { code } })), retires };
  }

  async supprimerGrade(u: UtilisateurConnecte, code: string) {
    const utilises = await this.regles.count({ where: { gradeCode: code } });
    if (utilises)
      throw new BadRequestException(
        `Ce grade est utilisé par ${utilises} diplôme(s) : changez d'abord leur grade.`,
      );
    const [{ n: choisi }] = await this.agents.query<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM agent WHERE "gradeChoisi"->>'code' = $1`,
      [code],
    );
    if (choisi)
      throw new BadRequestException(
        `Ce grade a été choisi pour ${choisi} personne(s) : remettez-les d'abord au grade par défaut de leur diplôme.`,
      );
    await this.grades.delete(code);
    await this.synchroniserCopies();
    await this.journal.log(u, 'SUPPRESSION_GRADE', 'grade', code);
    return { ok: true };
  }

  private nettoyerGrade(dto: GradeDto) {
    return {
      abreviation: dto.abreviation.trim(),
      libelle: dto.libelle.trim(),
      categorie: nettoyer(dto.categorie),
      echelle: dto.echelle ?? null,
      echelon: dto.echelon ?? null,
      indice: dto.indice ?? null,
    };
  }

  /* ------------------------------ Diplômes ----------------------------- */

  private async verifierRegle(code: string | null, dto: RegleDto) {
    if (!nettoyer(dto.libelle))
      throw new BadRequestException('Le nom du diplôme est obligatoire');
    if (!(CYCLES as readonly string[]).includes(dto.cycle))
      throw new BadRequestException('Choisissez un cycle');
    if (!(dto.typeNote in NOTES_AFFECTATION))
      throw new BadRequestException('Choisissez une note de service');
    if (
      dto.gradeCode &&
      !(await this.grades.findOne({ where: { code: dto.gradeCode } }))
    )
      throw new BadRequestException('Grade introuvable');
    const ecritures = [
      ...new Set(
        [dto.libelle, ...(dto.ecritures ?? [])]
          .map((e) => nettoyer(e))
          .filter(Boolean),
      ),
    ] as string[];
    // Une même écriture ne peut pas désigner deux diplômes
    for (const r of await this.regles.find())
      if (r.code !== code)
        for (const e of ecritures)
          if (r.ecritures.some((x) => cleCompacte(x) === cleCompacte(e)))
            throw new BadRequestException(
              `L'écriture « ${e} » est déjà utilisée par le diplôme ${r.libelle}.`,
            );
    return ecritures;
  }

  async creerRegle(u: UtilisateurConnecte, dto: RegleDto) {
    const ecritures = await this.verifierRegle(null, dto);
    let code = codeDepuis(dto.libelle);
    while (await this.regles.findOne({ where: { code } })) code = `${code}_2`;
    await this.regles.insert({
      code,
      libelle: dto.libelle.trim(),
      ecritures,
      cycle: dto.cycle,
      typeNote: dto.typeNote,
      gradeCode: dto.gradeCode,
    });
    await this.synchroniserCopies();
    const bilan = await this.appliquer();
    await this.journal.log(u, 'CREATION_REGLE_DIPLOME', 'regle_diplome', code, {
      libelle: dto.libelle,
      ...bilan,
    });
    return { code, ...bilan };
  }

  async modifierRegle(u: UtilisateurConnecte, code: string, dto: RegleDto) {
    const r = await this.regles.findOne({ where: { code } });
    if (!r) throw new NotFoundException('Diplôme introuvable');
    const ecritures = await this.verifierRegle(code, dto);
    await this.regles.update(code, {
      libelle: dto.libelle.trim(),
      ecritures,
      cycle: dto.cycle,
      typeNote: dto.typeNote,
      gradeCode: dto.gradeCode,
    });
    await this.synchroniserCopies();
    const bilan = await this.appliquer();
    await this.journal.log(
      u,
      'MODIFICATION_REGLE_DIPLOME',
      'regle_diplome',
      code,
      {
        libelle: dto.libelle,
        cycle: dto.cycle,
        typeNote: dto.typeNote,
        ...bilan,
      },
    );
    return bilan;
  }

  async supprimerRegle(u: UtilisateurConnecte, code: string) {
    const r = await this.regles.findOne({ where: { code } });
    if (!r) throw new NotFoundException('Diplôme introuvable');
    await this.regles.delete(code);
    const bilan = await this.appliquer();
    await this.journal.log(
      u,
      'SUPPRESSION_REGLE_DIPLOME',
      'regle_diplome',
      code,
      { libelle: r.libelle, ...bilan },
    );
    return bilan;
  }

  /** Remet les grades et les diplômes d'origine. */
  async reinitialiser(u: UtilisateurConnecte) {
    await this.regles.clear();
    await this.grades.clear();
    await this.grades.insert(GRADES_DEFAUT);
    await this.regles.insert(
      REGLES_DIPLOMES.map((r) => ({
        ...r,
        gradeCode: GRADE_DU_DIPLOME_DEFAUT[r.code] ?? null,
        ecritures: ECRITURES_DEFAUT[r.code] ?? [r.libelle],
      })),
    );
    await this.synchroniserCopies();
    const bilan = await this.appliquer();
    await this.journal.log(
      u,
      'REINITIALISATION_REGLES',
      'regle_diplome',
      null,
      bilan,
    );
    return bilan;
  }

  /* ----------------------- Application aux agents ---------------------- */

  /** Agents dont l'affectation n'est pas encore dans une note validée. */
  private async agentsModifiables() {
    return this.agents.query<
      {
        id: string;
        diplomeBrut: string | null;
        diplomeCode: string | null;
        cycleBrut: string | null;
        anomalies: string[];
        anomaliesVerifiees: string[] | null;
      }[]
    >(`
      SELECT a.id, a."diplomeBrut", a."diplomeCode", a."cycleBrut", a.anomalies, a."anomaliesVerifiees" FROM agent a
      LEFT JOIN affectation f ON f."agentId" = a.id
      WHERE f.id IS NULL OR f.statut <> 'AFFECTE'`);
  }

  /**
   * Recalcule le diplôme reconnu de chaque agent pas encore affecté, puis la note
   * de son affectation (sauf si une recommandation validée l'a déjà changée).
   */
  async appliquer() {
    const regles = await this.regles.find();
    const parCode = new Map(regles.map((r) => [r.code, r]));
    const liste = await this.agentsModifiables();
    let diplomesChanges = 0;
    for (const a of liste) {
      const code = reconnaitreDiplome(a.diplomeBrut, regles);
      const regle = code ? parCode.get(code) : undefined;
      let anomalies = (a.anomalies ?? []).filter(
        (x) => x !== ANOMALIE_DIPLOME && x !== ANOMALIE_CYCLE,
      );
      if (!code) anomalies = [...anomalies, ANOMALIE_DIPLOME];
      const cb = codeCycle(a.cycleBrut);
      // Avertissement masqué (« j'ai vérifié ») : il ne revient pas
      if (
        regle &&
        cb &&
        cb !== regle.cycle &&
        !(a.anomaliesVerifiees ?? []).includes(ANOMALIE_CYCLE)
      )
        anomalies = [...anomalies, ANOMALIE_CYCLE];
      const memeAnomalies =
        anomalies.length === (a.anomalies ?? []).length &&
        anomalies.every((x) => a.anomalies.includes(x));
      if (code !== a.diplomeCode || !memeAnomalies) {
        if (code !== a.diplomeCode) diplomesChanges++;
        await this.agents.update(a.id, { diplomeCode: code, anomalies });
      }
    }
    // Note de service par défaut (les affectations déplacées par une recommandation gardent la leur)
    const notesChangees = await this.affectations.query<unknown[]>(`
      UPDATE affectation f SET "typeNote" = COALESCE(r."typeNote", 'A_DEFINIR')
      FROM agent a LEFT JOIN regle_diplome r ON r.code = a."diplomeCode"
      WHERE a.id = f."agentId" AND f.statut = 'A_TRAITER' AND f.origine IS NULL
        AND f."typeNote" IS DISTINCT FROM COALESCE(r."typeNote", 'A_DEFINIR')
      RETURNING f.id`);
    // Structure par défaut pour le personnel administratif
    await this.affectations.query(`
      UPDATE affectation f SET structure = 'DDEPPSA ' || d.nom FROM departement d
      WHERE d.id = f."departementId" AND f."typeNote" = 'PERS_ADM' AND f.structure IS NULL AND f.statut = 'A_TRAITER'`);
    await this.importation.creerAffectations();
    const n = Array.isArray(notesChangees[0])
      ? (notesChangees[0] as unknown[]).length
      : notesChangees.length;
    return { diplomesChanges, notesChangees: n };
  }
}
