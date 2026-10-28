import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import ExcelJS from 'exceljs';
import { In, IsNull, Repository } from 'typeorm';
import { ROLES_TRAITEMENT, type UtilisateurConnecte } from '../auth/auth';
import { champ, lireClasseur } from '../common/excel';
import { IndexNoms } from '../common/index-noms';
import { codeDepartement } from '../common/referentiels';
import { enTexte, normaliser } from '../common/texte';
import { JournalService, ParametresService } from '../core/core.service';
import { AgentRecense, Departement, Nomination } from '../entities';
import { RecensementService } from '../recensement/recensement.service';
import {
  CATEGORIE,
  CATEGORIES_NOMINATION,
  categorieDe,
  gradeEchelon,
  OBSERVATIONS,
  type Observation,
  observationDe,
} from './categories';

const STATUTS = ['PROPOSEE', 'VALIDEE', 'REJETEE'];
const ANNEE = /^\d{4}-\d{4}$/;
const texte = (v: unknown) => {
  const t = enTexte(v).replace(/\s+/g, ' ').trim();
  return t && t !== '-' && t !== '/' ? t : null;
};

export interface FiltresNominations {
  annee?: string;
  departement?: number;
  categorie?: string;
  groupe?: string;
  statut?: string;
  observation?: string;
  recherche?: string;
  modifiees?: boolean;
  doublons?: boolean;
}

/**
 * Nominations des cadres de gestion des établissements et des inspections (DGRHAS, 26/10/2026).
 *
 * 1. La base de l'année précédente (importée, puis tenue ici) est reprise pour la nouvelle année :
 *    chacun est proposé « à reconduire » à son poste.
 * 2. Chaque DDEPPSA traite son département : reconduire, muter, promouvoir, permuter ou relever,
 *    avec le motif ; elle ajoute les nouveaux, pris dans la base du personnel.
 * 3. La DGRHAS (commission, ministre) valide ou rejette ; un même agent proposé deux fois doit être
 *    tranché avant.
 * 4. Les nominations validées vont dans la note de service de leur catégorie (Notes de service).
 */
@Injectable()
export class NominationsService {
  constructor(
    @InjectRepository(Nomination)
    private readonly noms: Repository<Nomination>,
    @InjectRepository(AgentRecense)
    private readonly agents: Repository<AgentRecense>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    private readonly rec: RecensementService,
    private readonly params: ParametresService,
    private readonly journal: JournalService,
  ) {}

  private dgrhas(u: UtilisateurConnecte) {
    return u.role === 'ADMIN' || ROLES_TRAITEMENT.includes(u.role);
  }

  /** Année en cours des nominations : la plus récente, sinon l'année scolaire des paramètres. */
  async anneeCourante() {
    const [r] = await this.noms.query<{ annee: string }[]>(
      `SELECT max(annee) AS annee FROM nomination`,
    );
    return r?.annee ?? this.params.get('ANNEE_SCOLAIRE');
  }

  /** Département que le compte peut traiter : tous (DGRHAS) ou le sien (DDEPPSA). */
  private perimetre(u: UtilisateurConnecte) {
    if (this.dgrhas(u)) return null;
    if (u.role === 'DDEPPSA' && u.departementId) return u.departementId;
    throw new ForbiddenException(
      'Les nominations se traitent à la DGRHAS et dans les directions départementales.',
    );
  }

  private async charger(u: UtilisateurConnecte, id: number) {
    const n = await this.noms.findOne({ where: { id } });
    if (!n) throw new NotFoundException('Nomination introuvable');
    const dep = this.perimetre(u);
    if (dep && n.departementId !== dep)
      throw new ForbiddenException(
        'Cette nomination n’est pas dans votre département.',
      );
    return n;
  }

  /* ------------------------------ Lecture ------------------------------ */

  async liste(u: UtilisateurConnecte, f: FiltresNominations) {
    const dep = this.perimetre(u);
    const annee =
      f.annee && ANNEE.test(f.annee) ? f.annee : await this.anneeCourante();
    const qb = this.noms
      .createQueryBuilder('n')
      .where('n.annee = :annee', { annee });
    if (dep) qb.andWhere('n."departementId" = :dep', { dep });
    else if (f.departement)
      qb.andWhere('n."departementId" = :d', { d: f.departement });
    if (f.categorie) qb.andWhere('n.categorie = :c', { c: f.categorie });
    if (f.groupe)
      qb.andWhere('n.categorie IN (:...g)', {
        g: CATEGORIES_NOMINATION.filter((c) => c.groupe === f.groupe)
          .map((c) => c.code)
          .concat('—'),
      });
    if (f.statut && STATUTS.includes(f.statut))
      qb.andWhere('n.statut = :s', { s: f.statut });
    if (f.observation && f.observation in OBSERVATIONS)
      qb.andWhere('n.observation = :o', { o: f.observation });
    if (f.modifiees) qb.andWhere('n.modifie');
    const mots = normaliser(f.recherche ?? '')
      .split(/\s+/)
      .filter(Boolean);
    mots.forEach((m, i) =>
      qb.andWhere(
        `(n."nomNormalise" LIKE :m${i} OR upper(coalesce(n."nouveauPoste", '') || ' ' || coalesce(n."ancienPoste", '') || ' ' || coalesce(n.circonscription, '')) LIKE :m${i})`,
        { [`m${i}`]: `%${m}%` },
      ),
    );
    const lignes = await qb.getMany();
    const doublons = await this.doublonsDe(annee);
    const deps = new Map((await this.deps.find()).map((d) => [d.id, d]));
    const ordreDep = (id: number | null) =>
      id ? (deps.get(id)?.ordre ?? 99) : 999;
    const rangCat = new Map(CATEGORIES_NOMINATION.map((c, i) => [c.code, i]));
    lignes.sort(
      (a, b) =>
        ordreDep(a.departementId) - ordreDep(b.departementId) ||
        (rangCat.get(a.categorie) ?? 99) - (rangCat.get(b.categorie) ?? 99) ||
        (a.circonscription ?? '').localeCompare(b.circonscription ?? '', 'fr', {
          numeric: true,
        }) ||
        a.nomComplet.localeCompare(b.nomComplet, 'fr'),
    );
    const vues = lignes
      .map((n) => ({
        ...n,
        departement: n.departementId
          ? (deps.get(n.departementId)?.nom ?? null)
          : null,
        categorieLibelle: CATEGORIE.get(n.categorie)?.libelle ?? n.categorie,
        groupe: CATEGORIE.get(n.categorie)?.groupe ?? null,
        doublon: doublons.get(n.id) ?? null,
      }))
      .filter((n) => !f.doublons || n.doublon);
    // Compteurs sur toutes les lignes du périmètre et de l'année, quels que soient les filtres
    const tous = await this.noms.find({
      where: { annee, ...(dep ? { departementId: dep } : {}) },
      select: {
        id: true,
        statut: true,
        observation: true,
        modifie: true,
        noteId: true,
      },
    });
    const compter = (p: (n: (typeof tous)[number]) => boolean) =>
      tous.filter(p).length;
    return {
      annee,
      annees: (
        await this.noms.query<{ annee: string }[]>(
          `SELECT DISTINCT annee FROM nomination ORDER BY annee DESC`,
        )
      ).map((x) => x.annee),
      departement: dep,
      peutDecider: this.dgrhas(u),
      total: vues.length,
      lignes: vues.slice(0, 1500),
      tronque: vues.length > 1500,
      compteurs: {
        tous: tous.length,
        proposees: compter((n) => n.statut === 'PROPOSEE'),
        validees: compter((n) => n.statut === 'VALIDEE'),
        rejetees: compter((n) => n.statut === 'REJETEE'),
        modifiees: compter((n) => n.modifie),
        relevees: compter((n) => n.observation === 'RELEVE'),
        enNote: compter((n) => !!n.noteId),
        doublons: [...doublons.keys()].filter((id) =>
          tous.some((n) => n.id === id),
        ).length,
      },
      categories: CATEGORIES_NOMINATION.map((c) => ({
        code: c.code,
        libelle: c.libelle,
        groupe: c.groupe,
        gabarit: c.gabarit,
      })),
      observations: Object.entries(OBSERVATIONS).map(([code, o]) => ({
        code,
        ...o,
      })),
    };
  }

  /**
   * Une même personne proposée deux fois la même année (deux départements qui se la disputent,
   * deux postes) : à trancher avant de valider. Les lignes relevées ou rejetées ne comptent pas.
   */
  async doublonsDe(annee: string) {
    const lignes = await this.noms.find({
      where: { annee },
      select: {
        id: true,
        agentId: true,
        nomNormalise: true,
        observation: true,
        statut: true,
        nouveauPoste: true,
        departementId: true,
      },
    });
    const actives = lignes.filter(
      (n) => n.observation !== 'RELEVE' && n.statut !== 'REJETEE',
    );
    const groupes = new Map<string, typeof actives>();
    for (const n of actives) {
      const k = n.agentId ? `A${n.agentId}` : `N${n.nomNormalise}`;
      groupes.set(k, [...(groupes.get(k) ?? []), n]);
    }
    const res = new Map<number, string>();
    for (const g of groupes.values())
      if (g.length > 1)
        for (const n of g)
          res.set(
            n.id,
            `Proposé(e) ${g.length} fois : ${g
              .filter((x) => x.id !== n.id)
              .map((x) => x.nouveauPoste ?? '?')
              .join(', ')}`,
          );
    return res;
  }

  /* ------------------------------ Import ------------------------------ */

  /**
   * Import de la base de nominations de la DGRHAS (classeur « MEPPSA_Nominations … Base de
   * données ») : la feuille choisie (par défaut « COMPILATION »), une ligne par personne.
   * « Reconduit / Promu / Muté » : validée ; « À reconduire… » : proposée ; « À pourvoir » : ignorée.
   * `essai` : rien n'est enregistré, le rapport dit ce qui serait fait.
   */
  async importer(
    u: UtilisateurConnecte,
    contenu: Buffer,
    o: { annee: string; feuille?: string; essai: boolean },
  ) {
    if (!this.dgrhas(u))
      throw new ForbiddenException(
        'Seule la DGRHAS importe la base des nominations.',
      );
    if (!ANNEE.test(o.annee ?? ''))
      throw new BadRequestException(
        'Indiquez l’année scolaire (ex. 2025-2026).',
      );
    const feuilles = await lireClasseur(contenu, ['NOMSETPRENOMS', 'FONCTION']);
    if (!feuilles.length)
      throw new BadRequestException(
        'Aucune feuille avec les colonnes « NOMS ET PRENOMS » et « FONCTION ».',
      );
    const choisie =
      feuilles.find((f) => normaliser(f.nom) === normaliser(o.feuille ?? '')) ??
      // La compilation visible (« COMPIL ») ; « COMPILATION » dans les anciens classeurs
      feuilles.find((f) => /^COMPIL(ATION)?$/i.test(f.nom.trim())) ??
      [...feuilles].sort((a, b) => b.lignes.length - a.lignes.length)[0];
    const deps = await this.deps.find();
    const depParCode = new Map(deps.map((d) => [d.code, d.id]));
    const depFeuille = codeDepartement(choisie.nom.replace(/^COMPIL\s*/i, ''));
    // Base du personnel : pour relier chaque nommé à sa fiche (nom identique, une seule fiche)
    const index = new IndexNoms<number>();
    for (const a of await this.agents.find({
      select: { id: true, nomComplet: true },
      where: { statut: In(['FONCTIONNAIRE', 'CONTRACTUEL']) },
    }))
      index.ajouter(a.nomComplet, null, a.id);
    const existants = new Set(
      (
        await this.noms.find({
          where: { annee: o.annee },
          select: { nomNormalise: true, categorie: true, nouveauPoste: true },
        })
      ).map(
        (n) => `${n.nomNormalise}|${n.categorie}|${normaliser(n.nouveauPoste)}`,
      ),
    );
    const rapport = {
      feuille: choisie.nom,
      feuilles: feuilles.map((f) => ({ nom: f.nom, lignes: f.lignes.length })),
      lues: 0,
      creees: 0,
      validees: 0,
      proposees: 0,
      relevees: 0,
      reliees: 0,
      dejaLa: 0,
      vacants: 0,
      sansCategorie: 0,
      sansDepartement: 0,
      fonctionsInconnues: [] as {
        cycle: string;
        fonction: string;
        n: number;
      }[],
    };
    const inconnues = new Map<
      string,
      { cycle: string; fonction: string; n: number }
    >();
    const nouvelles: Partial<Nomination>[] = [];
    for (const l of choisie.lignes) {
      const nom = texte(champ(l, 'NOMSETPRENOMS', 'NOMS'));
      const fonction = texte(champ(l, 'FONCTION'));
      if (!nom && !fonction) continue;
      rapport.lues++;
      const obsBrute = champ(l, 'OBS');
      const obs = observationDe(obsBrute);
      if (!nom || !obs) {
        rapport.vacants++;
        continue;
      }
      const cycle = texte(champ(l, 'CYCLE'));
      const categorie = categorieDe(cycle, fonction);
      if (!categorie) {
        rapport.sansCategorie++;
        const k = `${cycle}|${fonction}`;
        inconnues.set(k, {
          cycle: cycle ?? '',
          fonction: fonction ?? '',
          n: (inconnues.get(k)?.n ?? 0) + 1,
        });
        continue;
      }
      const code =
        codeDepartement(champ(l, 'DEPARTEMENT', 'DEPART')) ?? depFeuille;
      const departementId = code ? (depParCode.get(code) ?? null) : null;
      if (!departementId) rapport.sansDepartement++;
      const nouveauPoste = texte(champ(l, 'NOUVEAUPOSTE'));
      const cle = `${normaliser(nom)}|${categorie}|${normaliser(nouveauPoste)}`;
      if (existants.has(cle)) {
        rapport.dejaLa++;
        continue;
      }
      existants.add(cle);
      const ge = gradeEchelon(
        champ(l, 'GRADEECHELON', 'GRADECHLON', 'GRADECHELON', 'GRAD', 'GE'),
      );
      const trouves = index.probables(nom, null);
      const agentId = trouves.length === 1 ? trouves[0] : null;
      if (agentId) rapport.reliees++;
      const avisDd = texte(champ(l, 'AVISDIRPED', 'AVISDDEPPSA', 'AVISDD'));
      const avisDg = texte(champ(l, 'AVISDUDGRHAS', 'AVISDGRHAS'));
      const decisionMin = texte(champ(l, 'DECISIONDUMINISTRE', 'DECISION'));
      const statut = obs.proposee ? 'PROPOSEE' : 'VALIDEE';
      if (statut === 'VALIDEE') rapport.validees++;
      else rapport.proposees++;
      if (obs.obs === 'RELEVE') rapport.relevees++;
      nouvelles.push({
        annee: o.annee,
        categorie,
        departementId,
        circonscription: texte(champ(l, 'CIRCONSC')),
        agentId,
        nomComplet: nom,
        nomNormalise: normaliser(nom),
        genre: /^F/.test(normaliser(champ(l, 'GENRE')))
          ? 'F'
          : /^M/.test(normaliser(champ(l, 'GENRE')))
            ? 'M'
            : null,
        grade: ge.grade,
        echelon: ge.echelon,
        vague: texte(champ(l, 'VAGUE')),
        ancienPoste: texte(champ(l, 'ANCIENPOSTE')),
        nouveauPoste,
        observation: obs.obs,
        motif: texte(champ(l, 'MOTIF')),
        statut,
        avisDdeppsa: avisDd,
        avisDgrhas:
          [avisDg, decisionMin ? `Décision du ministre : ${decisionMin}` : null]
            .filter(Boolean)
            .join(' ; ') || null,
        decidePar:
          statut === 'VALIDEE' ? 'Base des nominations (import)' : null,
        source: 'IMPORT',
        creePar: u.nom,
      });
    }
    rapport.fonctionsInconnues = [...inconnues.values()]
      .sort((a, b) => b.n - a.n)
      .slice(0, 30);
    rapport.creees = nouvelles.length;
    if (!o.essai && nouvelles.length) {
      for (let i = 0; i < nouvelles.length; i += 500)
        await this.noms.save(nouvelles.slice(i, i + 500));
      await this.journal.log(u, 'NOMINATIONS_IMPORT', 'nomination', null, {
        annee: o.annee,
        feuille: choisie.nom,
        creees: nouvelles.length,
      });
    }
    return { ...rapport, essai: o.essai };
  }

  /* ------------------------------ Nouvelle année ------------------------------ */

  /**
   * Nouvelle année : les nominations validées de l'année précédente (sauf les relevés) sont reprises,
   * chacun proposé « à reconduire » à son poste (le nouveau poste devient l'ancien). La DDEPPSA ne
   * touche qu'à ce qui change (DGRHAS, 26/10/2026 : « s'il n'y a pas de modification, on garde »).
   */
  async preparerAnnee(u: UtilisateurConnecte, annee: string) {
    if (!this.dgrhas(u))
      throw new ForbiddenException(
        'Seule la DGRHAS ouvre une nouvelle année de nominations.',
      );
    if (!ANNEE.test(annee ?? ''))
      throw new BadRequestException(
        'Indiquez l’année scolaire (ex. 2026-2027).',
      );
    const precedente = `${Number(annee.slice(0, 4)) - 1}-${annee.slice(0, 4)}`;
    if (await this.noms.count({ where: { annee } }))
      throw new BadRequestException(`L’année ${annee} est déjà ouverte.`);
    const base = await this.noms.find({
      where: { annee: precedente, statut: 'VALIDEE' },
    });
    const reprises = base.filter((n) => n.observation !== 'RELEVE');
    if (!reprises.length)
      throw new BadRequestException(
        `Aucune nomination validée en ${precedente} à reprendre : importez d’abord la base de cette année-là.`,
      );
    for (let i = 0; i < reprises.length; i += 500)
      await this.noms.save(
        reprises.slice(i, i + 500).map((n) => ({
          annee,
          categorie: n.categorie,
          departementId: n.departementId,
          circonscription: n.circonscription,
          agentId: n.agentId,
          nomComplet: n.nomComplet,
          nomNormalise: n.nomNormalise,
          genre: n.genre,
          grade: n.grade,
          echelon: n.echelon,
          categorieAgent: n.categorieAgent,
          echelle: n.echelle,
          specialite: n.specialite,
          vague: n.vague,
          ancienPoste: n.nouveauPoste ?? n.ancienPoste,
          nouveauPoste: n.nouveauPoste ?? n.ancienPoste,
          observation: 'RECONDUIT',
          motif: null,
          statut: 'PROPOSEE',
          modifie: false,
          origineId: n.id,
          source: 'REPRISE',
          creePar: u.nom,
        })),
      );
    await this.journal.log(
      u,
      'NOMINATIONS_NOUVELLE_ANNEE',
      'nomination',
      null,
      {
        annee,
        precedente,
        reprises: reprises.length,
        relevees: base.length - reprises.length,
      },
    );
    return {
      annee,
      reprises: reprises.length,
      relevees: base.length - reprises.length,
    };
  }

  /* ------------------------------ Propositions ------------------------------ */

  private proposer(
    n: Partial<Nomination>,
    dto: Record<string, unknown>,
  ): string[] {
    const changes: string[] = [];
    const set = <K extends keyof Nomination>(k: K, v: Nomination[K]) => {
      if ((n[k] ?? null) !== (v ?? null)) changes.push(k);
      n[k] = v;
    };
    if ('observation' in dto) {
      const o = String(dto.observation);
      if (!(o in OBSERVATIONS))
        throw new BadRequestException(
          'Choisissez ce que l’on fait : reconduire, muter, promouvoir, permuter ou relever.',
        );
      set('observation', o);
    }
    if ('categorie' in dto) {
      const c = String(dto.categorie);
      if (!CATEGORIE.has(c))
        throw new BadRequestException(
          'Choisissez la fonction (catégorie de nomination).',
        );
      set('categorie', c);
    }
    for (const k of [
      'nouveauPoste',
      'ancienPoste',
      'circonscription',
      'motif',
      'vague',
      'specialite',
      'grade',
      'echelon',
      'categorieAgent',
      'echelle',
      'avisDdeppsa',
    ] as const)
      if (k in dto) set(k, texte(dto[k]));
    if ('departementId' in dto) {
      const d = Number(dto.departementId) || null;
      set('departementId', d);
    }
    if ('genre' in dto)
      set('genre', dto.genre === 'F' ? 'F' : dto.genre === 'M' ? 'M' : null);
    return changes;
  }

  /** La DDEPPSA (ou la DGRHAS) change une proposition : ce qu'on fait, le nouveau poste, le motif… */
  async modifier(
    u: UtilisateurConnecte,
    id: number,
    dto: Record<string, unknown>,
  ) {
    const n = await this.charger(u, id);
    if (n.statut !== 'PROPOSEE')
      throw new BadRequestException(
        n.statut === 'VALIDEE'
          ? 'Cette nomination est validée : demandez à la DGRHAS de la remettre en proposition pour la changer.'
          : 'Cette proposition a été rejetée : demandez à la DGRHAS de la remettre en proposition.',
      );
    const dep = this.perimetre(u);
    if (dep && 'departementId' in dto && Number(dto.departementId) !== dep)
      throw new ForbiddenException(
        'Vous ne proposez que dans votre département.',
      );
    const changes = this.proposer(n, dto);
    if (!changes.length) return n;
    // Ce qui n'est pas « reconduit au même poste » se justifie (DGRHAS, 26/10/2026)
    if (n.observation !== 'RECONDUIT' && !n.motif)
      throw new BadRequestException(
        'Écrivez le motif : pourquoi le muter, le promouvoir, le permuter ou le relever ?',
      );
    if (['MUTE', 'PROMU', 'PERMUTE'].includes(n.observation) && !n.nouveauPoste)
      throw new BadRequestException('Indiquez le nouveau poste.');
    if (
      n.observation === 'RECONDUIT' &&
      n.ancienPoste &&
      changes.includes('observation')
    )
      n.nouveauPoste = n.ancienPoste;
    n.modifie = true;
    await this.noms.save(n);
    await this.journal.log(
      u,
      'NOMINATION_PROPOSITION',
      'nomination',
      String(id),
      {
        changes,
        observation: n.observation,
      },
    );
    return n;
  }

  /**
   * Agents de la base du personnel à nommer (DGRHAS, 26/10/2026 : on ne nomme qu'un agent qui est
   * sur le terrain, enseignant à la base, du cycle). Avec ce qui pose question pour la fonction.
   */
  async candidats(u: UtilisateurConnecte, q: string, categorie?: string) {
    this.perimetre(u);
    const mots = normaliser(q)
      .split(/\s+/)
      .filter((m) => m.length >= 2);
    if (!mots.length) return [];
    const dep = this.dgrhas(u) ? null : u.departementId;
    const lignes = await this.agents.query<
      {
        id: number;
        nomComplet: string;
        statut: string;
        matricule: string | null;
        departementId: number | null;
        departement: string | null;
        structure: string | null;
        cycle: string | null;
        donnees: Record<string, unknown>;
      }[]
    >(
      `SELECT a.id, a."nomComplet", a.statut, a.matricule, a."departementId", d.nom AS departement,
              s.nom AS structure, s.cycle,
              jsonb_build_object('FONCTION', a.donnees->'FONCTION', 'GRADE', a.donnees->'GRADE', 'ECHELON', a.donnees->'ECHELON',
                                 'CATEGORIE', a.donnees->'CATEGORIE', 'ECHELLE', a.donnees->'ECHELLE', 'SPECIALITE', a.donnees->'SPECIALITE',
                                 'GENRE', a.donnees->'GENRE', 'CYCLE', a.donnees->'CYCLE') AS donnees
         FROM agent_recense a
         LEFT JOIN departement d ON d.id = a."departementId"
         LEFT JOIN structure s ON s.id = a."structureId"
        WHERE ${mots.map((_, i) => `(a."nomNormalise" LIKE $${i + 1} OR coalesce(a.matricule, '') LIKE $${i + 1})`).join(' AND ')}
          ${dep ? `AND a."departementId" = ${Number(dep)}` : ''}
          AND coalesce(a.contentieux->>'etat', 'CONFIRME') = 'CONFIRME'
        ORDER BY a."nomComplet" LIMIT 30`,
      mots.map((m) => `%${m}%`),
    );
    const cat = categorie ? CATEGORIE.get(categorie) : null;
    return lignes.map((a) => {
      const d = a.donnees ?? {};
      const fonction = enTexte(d.FONCTION);
      const cycleAgent =
        a.cycle ??
        normaliser(d.CYCLE).match(/PRESCO|PRIMAIRE|COLLEGE|LYCEE|ALPHA/)?.[0] ??
        null;
      const remarques: string[] = [];
      if (!['FONCTIONNAIRE', 'CONTRACTUEL'].includes(a.statut))
        remarques.push(
          `${a.statut.toLowerCase()} : seuls les fonctionnaires et contractuels sont nommés`,
        );
      if (
        fonction &&
        !/ENSEIGN|INSTITUT|PROFESS|MAITRE|INSPECT|CONSEILL|DIRECT|ECONOM|SURVEILL|PROVISEUR|CENSEUR|INTENDANT/.test(
          normaliser(fonction),
        )
      )
        remarques.push(
          `fonction « ${fonction} » : un cadre de gestion est d’abord un enseignant`,
        );
      if (
        cat &&
        cat.cycle !== 'ADMINISTRATION' &&
        cycleAgent &&
        !normaliser(cycleAgent).startsWith(cat.cycle.slice(0, 5))
      )
        remarques.push(
          `travaille au ${String(cycleAgent).toLowerCase()} : la fonction est au ${cat.cycle.toLowerCase()}`,
        );
      const ge = {
        grade: enTexte(d.GRADE) || null,
        echelon: enTexte(d.ECHELON) || null,
      };
      return {
        id: a.id,
        nomComplet: a.nomComplet,
        statut: a.statut,
        matricule: a.matricule,
        departementId: a.departementId,
        departement: a.departement,
        structure: a.structure,
        fonction: fonction || null,
        grade: ge.grade,
        echelon: ge.echelon,
        categorieAgent: enTexte(d.CATEGORIE) || null,
        echelle: enTexte(d.ECHELLE) || null,
        specialite: enTexte(d.SPECIALITE) || null,
        genre: /^F/.test(normaliser(d.GENRE))
          ? 'F'
          : /^M/.test(normaliser(d.GENRE))
            ? 'M'
            : null,
        remarques,
      };
    });
  }

  /** Nouveau nommé (promu, ou venu d'ailleurs) : pris dans la base du personnel, sinon saisi. */
  async ajouter(u: UtilisateurConnecte, dto: Record<string, unknown>) {
    const dep = this.perimetre(u);
    const annee = ANNEE.test(enTexte(dto.annee))
      ? String(dto.annee)
      : await this.anneeCourante();
    const n: Partial<Nomination> = {
      annee,
      statut: 'PROPOSEE',
      observation: 'PROMU',
      source: 'SAISIE',
      modifie: true,
      creePar: u.nom,
    };
    const agentId = Number(dto.agentId) || null;
    if (agentId) {
      const a = await this.agents.findOne({ where: { id: agentId } });
      if (!a)
        throw new BadRequestException(
          'Agent introuvable dans la base du personnel.',
        );
      const d = a.donnees ?? {};
      Object.assign(n, {
        agentId,
        nomComplet: a.nomComplet,
        nomNormalise: normaliser(a.nomComplet),
        grade: enTexte(d.GRADE) || null,
        echelon: enTexte(d.ECHELON) || null,
        categorieAgent: enTexte(d.CATEGORIE) || null,
        echelle: enTexte(d.ECHELLE) || null,
        specialite: enTexte(d.SPECIALITE) || null,
        genre: /^F/.test(normaliser(d.GENRE))
          ? 'F'
          : /^M/.test(normaliser(d.GENRE))
            ? 'M'
            : null,
        departementId: a.departementId,
      });
    } else {
      const nom = texte(dto.nomComplet);
      if (!nom || nom.length < 4)
        throw new BadRequestException(
          'Choisissez l’agent dans la base du personnel (ou écrivez son nom).',
        );
      Object.assign(n, { nomComplet: nom, nomNormalise: normaliser(nom) });
    }
    this.proposer(n, { ...dto, agentId: undefined });
    if (!n.categorie)
      throw new BadRequestException(
        'Choisissez la fonction (catégorie de nomination).',
      );
    if (dep) n.departementId = dep;
    if (!n.departementId)
      throw new BadRequestException('Choisissez le département.');
    if (!n.nouveauPoste)
      throw new BadRequestException('Indiquez le poste (école, inspection…).');
    if (!n.motif)
      throw new BadRequestException('Écrivez le motif de la proposition.');
    const cree = await this.noms.save(n);
    await this.journal.log(
      u,
      'NOMINATION_AJOUT',
      'nomination',
      String(cree.id),
      {
        categorie: n.categorie,
        agentId,
      },
    );
    return cree;
  }

  /** Une proposition saisie par erreur (pas une reprise) s'efface ; une reprise se relève. */
  async supprimer(u: UtilisateurConnecte, id: number) {
    const n = await this.charger(u, id);
    if (
      n.statut !== 'PROPOSEE' ||
      n.source === 'REPRISE' ||
      n.source === 'IMPORT'
    )
      throw new BadRequestException(
        'Seule une proposition ajoutée à la main se retire. Pour enlever quelqu’un de la base, choisissez « Relever ».',
      );
    await this.noms.delete(id);
    await this.journal.log(
      u,
      'NOMINATION_RETIREE',
      'nomination',
      String(id),
      {},
    );
    return { ok: true };
  }

  /* ------------------------------ Décisions ------------------------------ */

  /** Décision de la DGRHAS (après la commission et l'avis du ministre) sur des propositions. */
  async decider(
    u: UtilisateurConnecte,
    dto: { ids: number[]; decision: string; avis?: string },
  ) {
    if (!this.dgrhas(u))
      throw new ForbiddenException('Seule la DGRHAS valide les nominations.');
    const ids = Array.isArray(dto?.ids)
      ? dto.ids.map(Number).filter(Boolean)
      : [];
    if (!ids.length) throw new BadRequestException('Cochez les nominations.');
    const decision = dto.decision;
    if (!['VALIDEE', 'REJETEE', 'PROPOSEE'].includes(decision))
      throw new BadRequestException(
        'Choisissez : valider, rejeter, ou remettre en proposition.',
      );
    const lignes = await this.noms.find({ where: { id: In(ids) } });
    const res = { faites: 0, erreurs: [] as string[] };
    const doublons = lignes.length
      ? await this.doublonsDe(lignes[0].annee)
      : new Map<number, string>();
    for (const n of lignes) {
      if (n.noteId) {
        res.erreurs.push(
          `${n.nomComplet} : déjà dans une note de service validée.`,
        );
        continue;
      }
      if (decision === 'VALIDEE' && doublons.has(n.id)) {
        res.erreurs.push(
          `${n.nomComplet} : ${doublons.get(n.id)} ; tranchez d’abord (relever ou rejeter l’une des lignes).`,
        );
        continue;
      }
      if (decision === 'VALIDEE' && !n.departementId) {
        res.erreurs.push(`${n.nomComplet} : département inconnu.`);
        continue;
      }
      Object.assign(n, {
        statut: decision,
        avisDgrhas: texte(dto.avis) ?? n.avisDgrhas,
        decidePar: decision === 'PROPOSEE' ? null : u.nom,
        decideLe: decision === 'PROPOSEE' ? null : new Date(),
      });
      await this.noms.save(n);
      res.faites++;
    }
    await this.journal.log(u, 'NOMINATIONS_DECISION', 'nomination', null, {
      decision,
      faites: res.faites,
      erreurs: res.erreurs.length,
    });
    return res;
  }

  /* ------------------------------ Notes de service ------------------------------ */

  /** Nominations validées d'une catégorie, pas encore dans une note : elles paraissent (sauf relevés). */
  pourNote(annee: string, categorie: string) {
    return this.noms.find({
      where: {
        annee,
        categorie,
        statut: 'VALIDEE',
        noteId: IsNull(),
        observation: In(['RECONDUIT', 'PROMU', 'MUTE', 'PERMUTE']),
      },
    });
  }

  /** Catégories qui ont des nominations validées hors note, pour l'année. */
  async categoriesAPublier(annee: string) {
    const r = await this.noms.query<{ categorie: string; n: number }[]>(
      `SELECT categorie, count(*)::int AS n FROM nomination
        WHERE annee = $1 AND statut = 'VALIDEE' AND "noteId" IS NULL AND observation <> 'RELEVE'
        GROUP BY categorie`,
      [annee],
    );
    return r;
  }

  /** « Reconduite » pour une femme : l'observation imprimée dans la note. */
  static obsImprimee(n: Pick<Nomination, 'observation' | 'genre'>) {
    const o = OBSERVATIONS[n.observation as Observation];
    if (!o) return n.observation;
    return n.genre === 'F' ? o.feminin : o.libelle;
  }

  /* ------------------------------ Export ------------------------------ */

  /** Fiche de validation (Excel) : celle que l'on envoie aux DDEPPSA et à la commission. */
  async excel(u: UtilisateurConnecte, f: FiltresNominations) {
    const r = await this.liste(u, f);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'SIRHAS';
    const ws = wb.addWorksheet('Nominations', {
      pageSetup: {
        orientation: 'landscape',
        paperSize: 9,
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
      },
    });
    for (const t of [
      'MINISTERE DE L’ENSEIGNEMENT PRESCOLAIRE, PRIMAIRE, SECONDAIRE ET DE L’ALPHABETISATION',
      'DIRECTION GENERALE DES RESSOURCES HUMAINES ET DE L’ADMINISTRATION SCOLAIRE',
      '',
      `FICHE DE VALIDATION DES NOMINATIONS ${r.annee}`,
      'CONSIGNE : pour chaque ligne, dites ce que l’on fait (reconduire, muter, promouvoir, permuter, relever), avec le motif.',
      '',
    ])
      ws.addRow([t]).font = { bold: !!t && !t.startsWith('CONSIGNE') };
    const entetes = [
      'N°',
      'DEPARTEMENT',
      'CIRCONSC.',
      'GROUPE',
      'FONCTION',
      'NOMS ET PRENOMS',
      'GENRE',
      'GRADE/ECHELON',
      'VAGUE',
      'ANCIEN POSTE',
      'NOUVEAU POSTE',
      'OBS.',
      'MOTIF',
      'AVIS DDEPPSA',
      'AVIS DU DGRHAS',
      'DECISION',
    ];
    const e = ws.addRow(entetes);
    e.font = { bold: true };
    e.eachCell((c) => {
      c.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE5E7EB' },
      };
      c.border = {
        top: { style: 'thin' },
        bottom: { style: 'thin' },
        left: { style: 'thin' },
        right: { style: 'thin' },
      };
      c.alignment = { wrapText: true, vertical: 'middle' };
    });
    r.lignes.forEach((n, i) => {
      const row = ws.addRow([
        i + 1,
        n.departement,
        n.circonscription,
        n.groupe,
        n.categorieLibelle,
        n.nomComplet,
        n.genre,
        [n.grade, n.echelon].filter(Boolean).join(' '),
        n.vague,
        n.ancienPoste,
        n.nouveauPoste,
        n.statut === 'PROPOSEE'
          ? OBSERVATIONS[n.observation as Observation]?.proposer
          : NominationsService.obsImprimee(n),
        n.motif,
        n.avisDdeppsa,
        n.avisDgrhas,
        n.statut === 'VALIDEE'
          ? 'Validée'
          : n.statut === 'REJETEE'
            ? 'Rejetée'
            : 'Proposée',
      ]);
      // Ce que la DDEPPSA a changé : en jaune, comme dans la consigne
      if (n.modifie)
        row.eachCell(
          (c) =>
            (c.fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: 'FFFEF3C7' },
            }),
        );
    });
    [5, 14, 16, 14, 30, 30, 6, 12, 8, 24, 24, 14, 28, 18, 18, 11].forEach(
      (w, i) => (ws.getColumn(i + 1).width = w),
    );
    ws.views = [{ state: 'frozen', ySplit: e.number }];
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
}
