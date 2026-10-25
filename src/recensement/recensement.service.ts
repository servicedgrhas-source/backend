import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ROLES_TRAITEMENT, type UtilisateurConnecte } from '../auth/auth';
import {
  ENVOIS_SIMULTANES,
  parallele,
  StockageService,
} from '../common/stockage';
import {
  ageRevolu,
  cleCompacte,
  codeCategorie,
  enTexte,
  normaliser,
} from '../common/texte';
import { JournalService, ParametresService } from '../core/core.service';
import {
  AgentRecense,
  Departement,
  type EtapeStatut,
  EvenementCarriere,
  PieceRecensement,
  Structure,
} from '../entities';
import { motsDuNom, ressemblance } from '../common/ressemblance';
import { AffectationService } from '../affectation/affectation.service';
import {
  ConfigRecensementService,
  type ConfigRecensement,
} from './configuration';
import {
  deduire,
  estVide,
  evaluer,
  formaterNom,
  lireValeur,
  prochainAvancement,
} from './valeurs';
import { IndexNoms } from '../common/index-noms';
import { IndexStructures } from './rattachement';

/** Périmètre d'un compte : tout (DGRHAS), un département (DDEPPSA), des structures (chef d'établissement, inspection…). */
export type Perimetre =
  | { tous: true }
  | { departementId: number }
  | { structures: number[]; principale: number };

export interface FiltresAgents {
  recherche?: string;
  statut?: string;
  departement?: number;
  structure?: number;
  complet?: 'oui' | 'non';
  manque?: string;
  controle?: string;
  /** Agents ajoutés au recensement : A_CONTROLER, A_DECIDER, ACCEPTES ou REJETES. */
  ajout?: string;
  page?: number;
}

export interface FicheDto {
  statut?: string;
  structureId?: number | null;
  donnees?: Record<string, unknown>;
  forcer?: boolean;
  /** Agent rencontré au recensement, absent des bases : la fiche est mise en contentieux. */
  contentieux?: boolean;
}

export interface ChangementStatutDto {
  statut: string;
  /** Date d'effet (texte d'intégration…). */
  date?: string | null;
  texte?: string | null;
  matricule?: string | null;
}

const PAR_PAGE = 50;
/** Bottin imprimé en une fois : au-delà, on filtre (par département, par type d'agent). */
const BOTTIN_MAX = 20000;
const jourIso = () => new Date().toISOString().slice(0, 10);
/** 24 → « 2 ans », 28 → « 2 ans et 4 mois ». */
export const duree = (mois: number) => {
  const a = Math.floor(mois / 12);
  const m = mois % 12;
  return [a && `${a} an${a > 1 ? 's' : ''}`, m && `${m} mois`]
    .filter(Boolean)
    .join(' et ');
};
export const numeroFiche = (id: number) => `REC-${String(id).padStart(6, '0')}`;

/** Étape du parcours d'un agent (statut, date d'effet, texte). */
export function etape(
  statut: string,
  par: string | null,
  depuis: string | null = null,
  texte: string | null = null,
): EtapeStatut {
  return { statut, depuis, texte, par, le: new Date().toISOString() };
}

/** Parcours d'une fiche, avec le statut actuel en dernier (fiches antérieures à l'historique). */
export function parcoursDe(a: Pick<AgentRecense, 'parcours' | 'statut'>) {
  const p = [...(a.parcours ?? [])];
  if (!p.length || p[p.length - 1].statut !== a.statut)
    p.push({ statut: a.statut, depuis: null, texte: null, par: null, le: '' });
  return p;
}

const STATUTS_ETAT = ['FONCTIONNAIRE', 'CONTRACTUEL'];

/** Fiche ajoutée au recensement qui attend encore le contrôle ou la décision du DG. */
export const enAttente = (c: { etat: string } | null | undefined) =>
  c?.etat === 'EN_COURS' || c?.etat === 'CONTROLE';

@Injectable()
export class RecensementService {
  constructor(
    @InjectRepository(AgentRecense) readonly agents: Repository<AgentRecense>,
    @InjectRepository(PieceRecensement)
    readonly pieces: Repository<PieceRecensement>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    @InjectRepository(Structure)
    private readonly structures: Repository<Structure>,
    readonly config: ConfigRecensementService,
    private readonly journal: JournalService,
    private readonly stockage: StockageService,
    private readonly affectation: AffectationService,
    private readonly params: ParametresService,
  ) {}

  /* ------------------------------ Périmètre ------------------------------ */

  async perimetre(u: UtilisateurConnecte): Promise<Perimetre> {
    if (u.role === 'ADMIN' || ROLES_TRAITEMENT.includes(u.role))
      return { tous: true };
    if (u.role === 'DDEPPSA') {
      if (!u.departementId)
        throw new ForbiddenException(
          'Compte DDEPPSA sans département : l’administrateur doit indiquer son département.',
        );
      return { departementId: u.departementId };
    }
    if (u.role === 'STRUCTURE') {
      if (!u.structureId)
        throw new ForbiddenException(
          'Compte de structure sans établissement : l’administrateur doit indiquer sa structure (Administration › Utilisateurs).',
        );
      // L'établissement du compte et ce qui est rattaché en dessous (une inspection voit ses écoles)
      const lignes = await this.structures.query<{ id: number }[]>(
        `WITH RECURSIVE s AS (SELECT id FROM structure WHERE id = $1
           UNION SELECT t.id FROM structure t JOIN s ON t."parentId" = s.id)
         SELECT id FROM s`,
        [u.structureId],
      );
      return { structures: lignes.map((l) => l.id), principale: u.structureId };
    }
    throw new ForbiddenException(
      'Vous n’avez pas les droits pour cette action',
    );
  }

  dansPerimetre(
    p: Perimetre,
    a: Pick<AgentRecense, 'departementId' | 'structureId'>,
  ) {
    if ('tous' in p) return true;
    if ('departementId' in p) return a.departementId === p.departementId;
    return a.structureId !== null && p.structures.includes(a.structureId);
  }

  private filtrePerimetre(
    p: Perimetre,
    alias = 'a',
  ): { sql: string; params: unknown[] } {
    if ('tous' in p) return { sql: 'TRUE', params: [] };
    if ('departementId' in p)
      return {
        sql: `${alias}."departementId" = $X`,
        params: [p.departementId],
      };
    return { sql: `${alias}."structureId" = ANY($X)`, params: [p.structures] };
  }

  /** Structures où le compte peut rattacher un agent (pour la liste du formulaire). */
  async structuresPermises(u: UtilisateurConnecte) {
    const p = await this.perimetre(u);
    const toutes = await this.structures.find({
      where: { actif: true },
      order: { ordre: 'ASC', nom: 'ASC' },
    });
    // Toutes les structures, DGRHAS comprise : son personnel se rattache comme celui des autres
    // directions (DG, 24/10/2026 : « le personnel du cabinet, des directions… »)
    return toutes
      .filter((s) =>
        'tous' in p
          ? true
          : 'departementId' in p
            ? s.departementId === p.departementId
            : p.structures.includes(s.id),
      )
      .map((s) => ({
        id: s.id,
        nom: s.nom,
        sigle: s.sigle,
        type: s.type,
        departementId: s.departementId,
        parentId: s.parentId,
        cycle: s.cycle,
        localite: s.localite,
      }));
  }

  /* ------------------------------ Rattachement automatique ------------------------------ */

  /**
   * Fiches sans structure : rattachées à l'école, l'inspection ou la DDEPPSA de leur lieu de service
   * quand une seule correspond (rattachement.ts). Un rattachement choisi à la main n'est jamais
   * touché. Renvoie le nombre de fiches rattachées.
   */
  async rattacherAutomatiquement(ids?: number[]) {
    const fiches = await this.agents.query<
      { id: number; lieu: string; departementId: number | null }[]
    >(
      `SELECT id, donnees->>'LIEU_SERVICE' AS lieu, "departementId" FROM agent_recense
        WHERE "structureId" IS NULL AND coalesce(donnees->>'LIEU_SERVICE', '') <> ''
          ${ids ? 'AND id = ANY($1)' : ''}`,
      ids ? [ids] : [],
    );
    if (!fiches.length) return 0;
    const index = new IndexStructures(
      await this.structures.find({
        where: {
          actif: true,
          type: In(['ETABLISSEMENT', 'INSPECTION', 'DDEPPSA']),
        },
        select: ['id', 'type', 'nom', 'sigle', 'cycle', 'departementId'],
      }),
    );
    const paires = fiches
      .map((f) => [f.id, index.trouver(f.lieu, f.departementId)?.id] as const)
      .filter((p): p is readonly [number, number] => !!p[1]);
    for (let i = 0; i < paires.length; i += 1000) {
      const lot = paires.slice(i, i + 1000);
      await this.agents.query(
        `UPDATE agent_recense a SET "structureId" = v.s,
                liaison = coalesce(a.liaison, '{}'::jsonb) || '{"rattachementAuto": true}'::jsonb
           FROM unnest($1::int[], $2::int[]) AS v(id, s)
          WHERE a.id = v.id AND a."structureId" IS NULL`,
        [lot.map((p) => p[0]), lot.map((p) => p[1])],
      );
    }
    return paires.length;
  }

  /* ------------------------------ Référentiels ------------------------------ */

  private depsCache: {
    parCode: Map<string, number>;
    parId: Map<number, Departement>;
  } | null = null;
  async departements() {
    if (!this.depsCache) {
      const deps = await this.deps.find();
      this.depsCache = {
        parCode: new Map(deps.map((d) => [d.code, d.id])),
        parId: new Map(deps.map((d) => [d.id, d])),
      };
    }
    return this.depsCache;
  }

  /* ------------------------------ Lecture ------------------------------ */

  /** Conditions SQL des filtres de la base du personnel (liste, bottin, export). */
  private async filtres(u: UtilisateurConnecte, f: FiltresAgents) {
    const p = await this.perimetre(u);
    const conds: string[] = [];
    const params: unknown[] = [];
    const ajouter = (sql: string, ...vals: unknown[]) => {
      let s = sql;
      for (const v of vals) {
        params.push(v);
        s = s.replace('$X', `$${params.length}`);
      }
      conds.push(s);
    };
    const fp = this.filtrePerimetre(p);
    ajouter(fp.sql, ...fp.params);
    if (f.recherche?.trim()) {
      const brut = f.recherche.trim();
      // Date de naissance : « 05/03/1990 » ou « 1990-03-05 »
      const fr = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(brut);
      const iso = /^\d{4}-\d{2}-\d{2}$/.test(brut);
      if (fr || iso)
        ajouter(
          'a."dateNaissance" = $X::date',
          fr
            ? `${fr[3]}-${fr[2].padStart(2, '0')}-${fr[1].padStart(2, '0')}`
            : brut,
        );
      else {
        const t = `%${normaliser(brut)}%`;
        const chiffres = brut.replace(/\D/g, '');
        // Chaque mot du nom, dans n'importe quel ordre : « Jean Paul MOUANDA » trouve « MOUANDA Jean Paul »
        const mots = normaliser(brut)
          .split(/[\s,;-]+/)
          .filter((m) => m.length >= 2)
          .slice(0, 6);
        const parMots = mots.length
          ? `(${mots.map(() => `a."nomNormalise" LIKE $X`).join(' AND ')})`
          : 'false';
        ajouter(
          `(${parMots} OR a."nomNormalise" LIKE $X OR upper(coalesce(a."numeroFiche",'')) LIKE $X OR upper(coalesce(a.matricule,'')) LIKE $X OR upper(coalesce(a.donnees->>'LIEU_SERVICE','')) LIKE $X${chiffres.length >= 4 ? ` OR regexp_replace(coalesce(a.telephone,''),'\\D','','g') LIKE $X` : ''})`,
          ...mots.map((m) => `%${m}%`),
          t,
          t,
          t,
          t,
          ...(chiffres.length >= 4 ? [`%${chiffres}%`] : []),
        );
      }
    }
    // Agents ajoutés au recensement : à contrôler, à décider par le DG, acceptés, rejetés
    const etatAjout: Record<string, string> = {
      A_CONTROLER: 'EN_COURS',
      A_DECIDER: 'CONTROLE',
      ACCEPTES: 'CONFIRME',
      REJETES: 'REJETE',
    };
    if (f.ajout && etatAjout[f.ajout])
      ajouter(`a.contentieux->>'etat' = $X`, etatAjout[f.ajout]);
    if (f.statut) ajouter('a.statut = $X', f.statut);
    if (f.departement) ajouter('a."departementId" = $X', f.departement);
    if (f.structure) ajouter('a."structureId" = $X', f.structure);
    if (f.complet === 'oui') conds.push('a.complet');
    if (f.complet === 'non') conds.push('NOT a.complet');
    if (f.manque) {
      if (f.manque.startsWith('piece:'))
        ajouter(
          `a.manques->'pieces' @> $X::jsonb`,
          JSON.stringify([{ code: f.manque.slice(6) }]),
        );
      else ajouter(`a.manques->'champs' ? $X`, f.manque);
    }
    if (f.controle) {
      const ids =
        (await this.controles(u)).ids.get(f.controle) ?? new Set<number>();
      ajouter('a.id = ANY($X)', [...ids]);
    }
    return { where: conds.join(' AND ') || 'TRUE', params };
  }

  async liste(u: UtilisateurConnecte, f: FiltresAgents) {
    const { where, params } = await this.filtres(u, f);
    const page = Math.max(1, f.page ?? 1);
    const [{ n }] = await this.agents.query<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM agent_recense a WHERE ${where}`,
      params,
    );
    const lignes = await this.agents.query<Record<string, unknown>[]>(
      `SELECT a.id, a."numeroFiche", a.statut, a."nomComplet", a."dateNaissance", a.matricule, a.telephone,
              a."departementId", a."structureId", s.nom AS "structureNom", a.donnees->>'LIEU_SERVICE' AS "lieuService",
              a.donnees->>'GENRE' AS genre, a.donnees->>'LIEU_NAISSANCE' AS "lieuNaissance",
              a.taux, a.complet, a.manques, a.source, a."modifieLe", a.contentieux->>'etat' AS contentieux,
              a.contentieux->>'ouvertLe' AS "ajouteLe", a.contentieux->>'ouvertPar' AS "ajoutePar",
              a.contentieux->>'motif' AS "motifAjout", a.contentieux->>'avisControle' AS "avisControle",
              a.contentieux->>'controlePar' AS "controlePar"
         FROM agent_recense a LEFT JOIN structure s ON s.id = a."structureId"
        WHERE ${where}
        ORDER BY a."nomNormalise", a.id
        LIMIT ${PAR_PAGE} OFFSET ${(page - 1) * PAR_PAGE}`,
      params,
    );
    return { total: n, page, parPage: PAR_PAGE, lignes };
  }

  /**
   * Bottin du personnel à imprimer (DG, 24/10/2026) : la liste entière, par ordre alphabétique, avec
   * les filtres de la base (type d'agent, département…). Seules les fiches acceptées y figurent.
   */
  async bottin(u: UtilisateurConnecte, f: FiltresAgents) {
    const { where, params } = await this.filtres(u, { ...f, page: undefined });
    const lignes = await this.agents.query<
      {
        numeroFiche: string;
        nomComplet: string;
        genre: string | null;
        statut: string;
        dateNaissance: string | null;
        lieuNaissance: string | null;
        matricule: string | null;
        lieuService: string | null;
        departement: string | null;
      }[]
    >(
      `SELECT a."numeroFiche", a."nomComplet", a.donnees->>'GENRE' AS genre, a.statut,
              to_char(a."dateNaissance", 'YYYY-MM-DD') AS "dateNaissance", a.donnees->>'LIEU_NAISSANCE' AS "lieuNaissance",
              a.matricule, coalesce(s.nom, a.donnees->>'LIEU_SERVICE') AS "lieuService", d.nom AS departement
         FROM agent_recense a
         LEFT JOIN structure s ON s.id = a."structureId"
         LEFT JOIN departement d ON d.id = a."departementId"
        WHERE ${where} AND coalesce(a.contentieux->>'etat', 'CONFIRME') = 'CONFIRME'
        ORDER BY a."nomNormalise", a.id
        LIMIT ${BOTTIN_MAX + 1}`,
      params,
    );
    const c = this.config.get();
    const statut = f.statut ? c.statuts.find((x) => x.code === f.statut) : null;
    const dep = f.departement
      ? (await this.departements()).parId.get(f.departement)
      : null;
    // Ce que la liste contient, écrit sous le titre du bottin
    const portee = [
      statut ? `${statut.libelle}s` : 'Tout le personnel',
      dep && `département : ${dep.nom}`,
      f.recherche?.trim() && `recherche « ${f.recherche.trim()} »`,
    ]
      .filter(Boolean)
      .join(' · ');
    return {
      portee,
      trop: lignes.length > BOTTIN_MAX,
      max: BOTTIN_MAX,
      lignes: lignes.slice(0, BOTTIN_MAX).map((l) => ({
        ...l,
        genre: l.genre === 'F' ? 'F' : l.genre === 'M' ? 'M' : null,
        statut: c.statuts.find((x) => x.code === l.statut)?.libelle ?? l.statut,
      })),
      signature: {
        titre: this.params.get('DG_TITRE'),
        nom: this.params.get('DG_NOM') || null,
        lieu: this.params.get('LIEU_SIGNATURE'),
      },
    };
  }

  async trouver(u: UtilisateurConnecte, id: number) {
    const a = await this.agents.findOne({ where: { id } });
    if (!a) throw new NotFoundException('Agent recensé introuvable');
    if (!this.dansPerimetre(await this.perimetre(u), a))
      throw new ForbiddenException(
        'Cet agent n’est pas rattaché à votre établissement ou à votre département.',
      );
    return a;
  }

  async fiche(u: UtilisateurConnecte, id: number) {
    const a = await this.trouver(u, id);
    const [pieces, historique, structure] = await Promise.all([
      this.pieces.find({
        where: { agentId: id },
        order: { type: 'ASC', creeLe: 'ASC' },
      }),
      this.journal.liste(50, 'agent_recense', String(id)),
      a.structureId
        ? this.structures.findOne({ where: { id: a.structureId } })
        : null,
    ]);
    const volontaire = a.volontaireId
      ? ((
          await this.agents.query<
            {
              id: string;
              statut: string;
              motifSortie: string | null;
              dateSortie: string | null;
              categorie: string | null;
              etablissement: string | null;
            }[]
          >(
            `SELECT id, statut, "motifSortie", to_char("dateSortie", 'YYYY-MM-DD') AS "dateSortie", categorie, etablissement FROM volontaire WHERE id = $1`,
            [a.volontaireId],
          )
        )[0] ?? null)
      : null;
    return {
      agent: a,
      parcours: parcoursDe(a),
      volontaire,
      structure: structure
        ? { id: structure.id, nom: structure.nom, sigle: structure.sigle }
        : null,
      pieces: pieces.map((p) => ({
        id: p.id,
        type: p.type,
        nomOrigine: p.nomOrigine,
        mime: p.mime,
        taille: p.taille,
        ligne: p.ligne,
        ajoutePar: p.ajoutePar,
        creeLe: p.creeLe,
      })),
      historique: historique.map((h) => ({
        date: h.date,
        utilisateurNom: h.utilisateurNom,
        action: h.action,
        details: h.details,
      })),
    };
  }

  /* ------------------------------ Écriture ------------------------------ */

  /** Valeurs d'un formulaire, contrôlées une à une. Une valeur mal écrite est refusée avec son explication. */
  lireDonnees(c: ConfigRecensement, brutes: Record<string, unknown>) {
    const donnees: Record<string, unknown> = {};
    for (const ch of c.champs) {
      if (!(ch.code in brutes)) continue;
      const lu = lireValeur(ch, brutes[ch.code]);
      if (lu.erreur)
        throw new BadRequestException(`${ch.libelle} : ${lu.erreur}.`);
      if (!estVide(lu.valeur))
        donnees[ch.code] =
          ch.code === 'NOMS_PRENOMS'
            ? formaterNom(String(lu.valeur))
            : lu.valeur;
    }
    return donnees;
  }

  /**
   * Colonnes recopiées des rubriques (recherche, doublons, périmètre). Les rubriques qui se
   * déduisent d'une autre sont remplies au passage (nature du texte de recrutement d'après sa
   * référence), pour toutes les fiches : saisie, import, notes de service.
   */
  async colonnes(donnees: Record<string, unknown>) {
    deduire(this.config.get(), donnees);
    const nom = enTexte(donnees.NOMS_PRENOMS).replace(/\s+/g, ' ').trim();
    const dep = donnees.DEPARTEMENT
      ? ((await this.departements()).parCode.get(
          enTexte(donnees.DEPARTEMENT),
        ) ?? null)
      : null;
    return {
      nomComplet: nom,
      nomNormalise: normaliser(nom),
      dateNaissance: (donnees.DATE_NAISSANCE as string) ?? null,
      matricule: donnees.MATRICULE_SOLDE
        ? normaliser(donnees.MATRICULE_SOLDE)
        : null,
      telephone: (donnees.TELEPHONE_1 as string) ?? null,
      departementId: dep,
    };
  }

  async piecesFournies(ids: number[]) {
    const m = new Map<number, Record<string, number>>();
    if (!ids.length) return m;
    const lignes = await this.pieces.query<
      { agentId: number; type: string; n: number }[]
    >(
      `SELECT "agentId", type, count(*)::int AS n FROM piece_recensement WHERE "agentId" = ANY($1) GROUP BY 1, 2`,
      [ids],
    );
    for (const l of lignes) {
      const x = m.get(l.agentId) ?? {};
      x[l.type] = l.n;
      m.set(l.agentId, x);
    }
    return m;
  }

  appliquerEvaluation(a: AgentRecense, fournies: Record<string, number>) {
    const e = evaluer(this.config.get(), a.statut, a.donnees ?? {}, fournies);
    a.manques = { champs: e.champs, pieces: e.pieces, aVerifier: e.aVerifier };
    a.taux = e.taux;
    a.complet = e.complet;
  }

  private async rattachement(
    u: UtilisateurConnecte,
    p: Perimetre,
    structureId: number | null | undefined,
    depId: number | null,
  ) {
    let sid = structureId ?? null;
    if ('structures' in p) {
      if (sid === null) sid = p.principale;
      if (!p.structures.includes(sid))
        throw new ForbiddenException(
          'Vous ne pouvez rattacher un agent qu’à votre établissement (ou à ce qui en dépend).',
        );
    }
    let s: Structure | null = null;
    if (sid !== null) {
      s = await this.structures.findOne({ where: { id: sid } });
      if (!s) throw new BadRequestException('Structure inconnue.');
    }
    const dep = s?.departementId ?? depId ?? null;
    if ('departementId' in p && dep !== p.departementId)
      throw new ForbiddenException(
        'Vous ne gérez que les agents de votre département.',
      );
    return { structureId: sid, departementId: dep, structure: s };
  }

  /**
   * Rubriques tirées de l'organigramme quand l'agent est rattaché à une structure : lieu de service,
   * inspection, département, localité et cycle viennent de la liste, pas d'une saisie libre.
   */
  async completerDepuisStructure(
    d: Record<string, unknown>,
    s: Structure | null,
  ) {
    if (!s) return;
    const c = this.config.get();
    const existe = (code: string) =>
      c.champs.some((x) => x.code === code && x.actif);
    // « DDEPPSA Pool » plutôt que le nom développé de la direction départementale (DG, 24/10/2026)
    if (s.type === 'DDEPPSA') d.LIEU_SERVICE = s.sigle || s.nom;
    else if (
      ['ETABLISSEMENT', 'INSPECTION', 'SERVICE', 'DIRECTION_CENTRALE'].includes(
        s.type,
      )
    )
      d.LIEU_SERVICE = s.nom;
    let insp: Structure | null = s.type === 'INSPECTION' ? s : null;
    if (!insp && s.parentId) {
      const parent = await this.structures.findOne({
        where: { id: s.parentId },
      });
      if (parent?.type === 'INSPECTION') insp = parent;
    }
    if (insp && existe('INSPECTION')) d.INSPECTION = insp.nom;
    if (s.localite && existe('VILLE')) d.VILLE = s.localite;
    if (s.departementId) {
      const dep = (await this.departements()).parId.get(s.departementId);
      if (dep) d.DEPARTEMENT = dep.code;
    }
    const cycle = c.champs.find((x) => x.code === 'CYCLE' && x.actif);
    if (
      s.cycle &&
      cycle?.options.some((o) => o.code === s.cycle) &&
      estVide(d.CYCLE)
    )
      d.CYCLE = s.cycle;
  }

  async creer(u: UtilisateurConnecte, dto: FicheDto) {
    const c = this.config.get();
    const p = await this.perimetre(u);
    const statut = this.config.statut(dto.statut);
    if (!statut?.actif)
      throw new BadRequestException(
        'Choisissez le type d’agent (fonctionnaire, contractuel, volontaire…).',
      );
    const donnees = this.lireDonnees(c, dto.donnees ?? {});
    const col = await this.colonnes(donnees);
    if (!col.nomComplet)
      throw new BadRequestException('Écrivez les noms et prénoms de l’agent.');
    const r = await this.rattachement(u, p, dto.structureId, col.departementId);
    await this.completerDepuisStructure(donnees, r.structure);
    if (r.departementId && !donnees.DEPARTEMENT) {
      const d = (await this.departements()).parId.get(r.departementId);
      if (d) donnees.DEPARTEMENT = d.code;
    }
    Object.assign(col, await this.colonnes(donnees));
    if (!dto.forcer) {
      const deja = await this.semblables(
        col.nomNormalise,
        col.dateNaissance,
        col.matricule,
      );
      if (deja.length)
        throw new BadRequestException(
          `Déjà recensé : ${deja.map((d) => `${d.nomComplet} (${d.numeroFiche})`).join(', ')}. Ouvrez sa fiche, ou confirmez s’il s’agit d’une autre personne.`,
        );
    }
    const a = this.agents.create({
      ...col,
      departementId: r.departementId,
      structureId: r.structureId,
      statut: statut.code,
      donnees,
      parcours: [etape(statut.code, u.nom)],
      contentieux: this.contentieuxPour(p, dto.contentieux, u.nom),
      source: 'SAISIE',
      creePar: u.nom,
      modifiePar: u.nom,
    });
    this.appliquerEvaluation(a, {});
    const enr = await this.agents.save(a);
    enr.numeroFiche = numeroFiche(enr.id);
    await this.agents.update(enr.id, { numeroFiche: enr.numeroFiche });
    if (!enr.structureId) await this.rattacherAutomatiquement([enr.id]);
    await this.journal.log(u, 'RECENSEMENT_CREATION', 'agent_recense', enr.id, {
      nom: enr.nomComplet,
      numero: enr.numeroFiche,
    });
    return enr;
  }

  /**
   * Contentieux d'une nouvelle fiche : demandé à la saisie, ou automatique pour un DDEPPSA ou un
   * établissement (recensement sur le terrain d'un agent absent des bases de la DGRHAS).
   */
  contentieuxPour(
    p: Perimetre,
    demande: boolean | string | undefined,
    par: string,
  ) {
    const auto = !('tous' in p) && this.config.get().contentieuxHorsBase;
    if (!demande && !auto) return null;
    return {
      etat: 'EN_COURS' as const,
      motif:
        typeof demande === 'string'
          ? demande
          : demande
            ? 'Rencontré au recensement, absent de la base : à vérifier'
            : 'Fiche créée sur le terrain (DDEPPSA ou établissement), absente des bases de la DGRHAS : à vérifier',
      ouvertPar: par,
      ouvertLe: new Date().toISOString(),
    };
  }

  async semblables(
    nomNormalise: string,
    dateNaissance: string | null,
    matricule: string | null,
    sauf?: number,
  ) {
    const lignes = await this.agents.query<
      { id: number; nomComplet: string; numeroFiche: string }[]
    >(
      `SELECT id, "nomComplet", "numeroFiche" FROM agent_recense
        WHERE id <> $4 AND (("nomNormalise" = $1 AND ($2::date IS NULL OR "dateNaissance" IS NULL OR "dateNaissance" = $2::date))
           OR ($3::text IS NOT NULL AND matricule = $3))
        LIMIT 3`,
      [nomNormalise, dateNaissance, matricule, sauf ?? 0],
    );
    return lignes;
  }

  async modifier(u: UtilisateurConnecte, id: number, dto: FicheDto) {
    const c = this.config.get();
    const p = await this.perimetre(u);
    const a = await this.trouver(u, id);
    const avant = {
      ...a.donnees,
      _statut: a.statut,
      _structure: a.structureId,
    };
    const identite = `${a.nomNormalise}|${a.dateNaissance}|${a.matricule}`;
    if (dto.statut !== undefined) {
      const s = this.config.statut(dto.statut);
      if (!s) throw new BadRequestException('Type d’agent inconnu.');
      if (s.code !== a.statut) {
        a.parcours = [...parcoursDe(a), etape(s.code, u.nom, jourIso())];
        a.statut = s.code;
      }
    }
    if (dto.donnees) {
      const donnees = this.lireDonnees(c, dto.donnees);
      // Les rubriques envoyées vides sont effacées ; celles qui ne sont pas envoyées restent
      for (const k of Object.keys(dto.donnees))
        if (!(k in donnees)) delete a.donnees[k];
      a.donnees = { ...a.donnees, ...donnees };
    }
    let col = await this.colonnes(a.donnees);
    if (!col.nomComplet)
      throw new BadRequestException('Écrivez les noms et prénoms de l’agent.');
    const r = await this.rattachement(
      u,
      p,
      dto.structureId !== undefined ? dto.structureId : a.structureId,
      col.departementId,
    );
    // Structure choisie ou changée : ses rubriques (lieu, inspection, département…) suivent
    if (r.structureId !== avant._structure && r.structure) {
      await this.completerDepuisStructure(a.donnees, r.structure);
      col = await this.colonnes(a.donnees);
    }
    Object.assign(a, col, {
      departementId: r.departementId,
      structureId: r.structureId,
      modifiePar: u.nom,
    });
    // Doublon vérifié seulement si l'identité change (un homonyme confirmé ne bloque pas chaque correction)
    if (
      !dto.forcer &&
      identite !== `${col.nomNormalise}|${col.dateNaissance}|${col.matricule}`
    ) {
      const deja = await this.semblables(
        col.nomNormalise,
        col.dateNaissance,
        col.matricule,
        a.id,
      );
      if (deja.length)
        throw new BadRequestException(
          `Déjà recensé : ${deja.map((d) => `${d.nomComplet} (${d.numeroFiche})`).join(', ')}. Ouvrez sa fiche, ou confirmez s’il s’agit d’une autre personne.`,
        );
    }
    this.appliquerEvaluation(
      a,
      (await this.piecesFournies([a.id])).get(a.id) ?? {},
    );
    await this.agents.save(a);
    if (!a.structureId && (await this.rattacherAutomatiquement([a.id])))
      a.structureId =
        (await this.agents.findOne({ where: { id: a.id } }))?.structureId ??
        null;
    const changes = Object.keys({ ...avant, ...a.donnees }).filter(
      (k) =>
        !k.startsWith('_') &&
        JSON.stringify(avant[k]) !== JSON.stringify(a.donnees[k]),
    );
    if (avant._statut !== a.statut) changes.unshift('TYPE_AGENT');
    if (avant._structure !== a.structureId) changes.push('STRUCTURE');
    await this.journal.log(
      u,
      'RECENSEMENT_MODIFICATION',
      'agent_recense',
      a.id,
      {
        champs: changes.map(
          (k) =>
            c.champs.find((x) => x.code === k)?.libelle ??
            (k === 'TYPE_AGENT'
              ? 'Type d’agent'
              : k === 'STRUCTURE'
                ? 'Établissement de rattachement'
                : k),
        ),
      },
    );
    return a;
  }

  async supprimer(u: UtilisateurConnecte, id: number) {
    const a = await this.trouver(u, id);
    if (a.volontaireId)
      throw new BadRequestException(
        'Cette fiche est celle d’un volontaire du registre (enrôlement) : elle suit le registre et ne se supprime pas ici. Pour un doublon, sortez-le du registre avec le motif « Doublon ».',
      );
    const pieces = await this.pieces.find({ where: { agentId: id } });
    // Le dossier de carrière part avec la fiche (actes scannés compris)
    const actes = await this.agents.manager.find(EvenementCarriere, {
      where: { agentId: id },
    });
    await this.pieces.delete({ agentId: id });
    await this.agents.manager.delete(EvenementCarriere, { agentId: id });
    // Présences, horaire et évaluations partent aussi ; un poste de responsable redevient vacant
    for (const t of ['presence', 'horaire_agent', 'evaluation_agent'])
      await this.agents.query(`DELETE FROM ${t} WHERE "agentId" = $1`, [id]);
    await this.agents.query(
      `UPDATE structure SET "responsableId" = NULL, "responsableInterim" = false WHERE "responsableId" = $1`,
      [id],
    );
    await this.agents.delete(id);
    await Promise.all([
      ...pieces.map((p) => this.stockage.supprimer('recensement', p.fichier)),
      ...actes.map((e) => this.stockage.supprimer('recensement', e.fichier)),
    ]);
    await this.journal.log(u, 'RECENSEMENT_SUPPRESSION', 'agent_recense', id, {
      nom: a.nomComplet,
      numero: a.numeroFiche,
    });
    return { supprime: true };
  }

  /* ------------------------------ Statut, contentieux, mêmes personnes ------------------------------ */

  /**
   * Changement de statut de la même personne (intégration d'un volontaire ou d'un communautaire
   * comme fonctionnaire ou contractuel…) : la fiche reste la même, le parcours garde l'ancien statut.
   */
  async changerStatut(
    u: UtilisateurConnecte,
    id: number,
    dto: ChangementStatutDto,
  ) {
    const a = await this.trouver(u, id);
    const s = this.config.statut(dto.statut);
    if (!s?.actif)
      throw new BadRequestException('Choisissez le nouveau statut.');
    if (s.code === a.statut)
      throw new BadRequestException(
        `L’agent est déjà ${s.libelle.toLowerCase()}.`,
      );
    const date = dto.date?.trim() || null;
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date))
      throw new BadRequestException('Date d’effet invalide.');
    const texte = dto.texte?.replace(/\s+/g, ' ').trim().slice(0, 200) || null;
    const ancien = a.statut;
    a.parcours = [...parcoursDe(a), etape(s.code, u.nom, date, texte)];
    a.statut = s.code;
    const d = { ...a.donnees };
    if (texte && STATUTS_ETAT.includes(s.code)) {
      if (this.config.get().champs.some((x) => x.code === 'TEXTE_RECRUTEMENT'))
        d.TEXTE_RECRUTEMENT = texte;
    }
    if (dto.matricule?.trim()) d.MATRICULE_SOLDE = dto.matricule.trim();
    a.donnees = d;
    Object.assign(a, await this.colonnes(d), { modifiePar: u.nom });
    if (a.matricule) {
      const deja = await this.semblables('', null, a.matricule, a.id);
      if (deja.length)
        throw new BadRequestException(
          `Ce matricule est déjà celui de ${deja[0].nomComplet} (${deja[0].numeroFiche}).`,
        );
    }
    this.appliquerEvaluation(
      a,
      (await this.piecesFournies([a.id])).get(a.id) ?? {},
    );
    await this.agents.save(a);
    await this.journal.log(u, 'PERSONNEL_STATUT', 'agent_recense', a.id, {
      nom: a.nomComplet,
      de: ancien,
      vers: s.code,
      date,
      texte,
    });
    return a;
  }

  /**
   * Statut d'un agent intégré par la Fonction Publique, d'après les règles des paramètres : au-delà
   * de l'âge limite (30 ans en catégories II et III, du CEPE au BAC ; 35 ans en catégorie I : BTS,
   * licence, master), âge révolu compté à la date du texte, l'agent est contractuel. L'arrêté fait foi
   * s'il dit autre chose : ce n'est qu'une proposition.
   */
  async statutPrevu(u: UtilisateurConnecte, id: number, date?: string) {
    const a = await this.trouver(u, id);
    const p = this.affectation.parametresCalcul();
    const jour = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : jourIso();
    // Catégorie : celle de la fiche, sinon celle du diplôme (règles des diplômes)
    const romain = (v: unknown) =>
      /\b(III|II|I)\b/.exec(normaliser(v))?.[1] ?? null;
    let categorie = romain(a.donnees.CATEGORIE);
    let diplome: string | null = null;
    if (!categorie && !estVide(a.donnees.DIPLOME_PRO)) {
      const k = cleCompacte(a.donnees.DIPLOME_PRO);
      const regles = [...(await this.affectation.reglesParCode()).values()];
      const r =
        regles.find((x) => cleCompacte(x.code) === k) ??
        regles.find((x) => cleCompacte(x.libelle) === k) ??
        regles.find(
          (x) =>
            cleCompacte(x.code).startsWith(k) ||
            cleCompacte(x.libelle).startsWith(k),
        );
      categorie = romain(r?.categorie);
      diplome = r?.libelle ?? null;
    }
    const limite = categorie === 'I' ? p.ageLimiteCatI : p.ageLimite;
    if (!a.dateNaissance)
      return {
        statut: null,
        explication:
          'Date de naissance inconnue : le statut ne peut pas être calculé. Choisissez-le d’après l’arrêté.',
      };
    const age = ageRevolu(a.dateNaissance, jour);
    if (!categorie)
      return {
        statut: null,
        age,
        explication: `${age} ans au ${jour.split('-').reverse().join('/')}, mais catégorie inconnue (ni catégorie ni diplôme reconnu sur la fiche) : limite ${p.ageLimite} ans (cat. II et III) ou ${p.ageLimiteCatI} ans (cat. I).`,
      };
    const contractuel = age > limite;
    return {
      statut: contractuel ? 'CONTRACTUEL' : 'FONCTIONNAIRE',
      age,
      categorie,
      limite,
      explication: `${age} ans révolus au ${jour.split('-').reverse().join('/')}, catégorie ${categorie}${diplome ? ` (${diplome})` : ''} : limite ${limite} ans, donc ${contractuel ? 'contractuel' : 'fonctionnaire'}. L’arrêté fait foi s’il dit autre chose.`,
    };
  }

  /**
   * Contrôle d'un agent ajouté au recensement (absent de la base) par le bureau du contrôle :
   * il vérifie les pièces et qu'il n'est pas déjà dans la base, puis transmet au DG avec son avis.
   */
  async controlerContentieux(
    u: UtilisateurConnecte,
    id: number,
    avis: string,
    note?: string,
  ) {
    const a = await this.trouver(u, id);
    if (a.contentieux?.etat !== 'EN_COURS')
      throw new BadRequestException(
        a.contentieux?.etat === 'CONTROLE'
          ? 'Cette fiche est déjà contrôlée : elle attend la décision du DG.'
          : 'Cette fiche n’est pas à contrôler.',
      );
    if (!['FAVORABLE', 'DEFAVORABLE'].includes(avis))
      throw new BadRequestException('Avis attendu : favorable ou défavorable.');
    const n = note?.replace(/\s+/g, ' ').trim().slice(0, 500) || null;
    if (avis === 'DEFAVORABLE' && !n)
      throw new BadRequestException(
        'Dites pourquoi l’avis est défavorable : le DG le lira avant de décider.',
      );
    a.contentieux = {
      ...a.contentieux,
      etat: 'CONTROLE',
      avisControle: avis as 'FAVORABLE' | 'DEFAVORABLE',
      noteControle: n,
      controlePar: u.nom,
      controleLe: new Date().toISOString(),
    };
    await this.agents.save(a);
    await this.journal.log(
      u,
      'PERSONNEL_CONTENTIEUX_CONTROLE',
      'agent_recense',
      a.id,
      { nom: a.nomComplet, avis, note: n },
    );
    return a;
  }

  /**
   * Décision du DG sur un agent ajouté au recensement : il existe (il entre dans la base) ou il est
   * rejeté. Normalement après le contrôle ; avant, le DG doit écrire pourquoi il décide seul.
   */
  async deciderContentieux(
    u: UtilisateurConnecte,
    id: number,
    decision: string,
    note?: string,
  ) {
    const a = await this.trouver(u, id);
    if (!enAttente(a.contentieux))
      throw new BadRequestException(
        'Cette fiche n’attend pas de décision (déjà acceptée ou rejetée).',
      );
    if (!['CONFIRMER', 'REJETER'].includes(decision))
      throw new BadRequestException(
        'Décision attendue : confirmer ou rejeter.',
      );
    const n = note?.replace(/\s+/g, ' ').trim().slice(0, 500) || null;
    if (decision === 'REJETER' && !n)
      throw new BadRequestException('Donnez le motif du rejet.');
    if (a.contentieux!.etat === 'EN_COURS' && !n)
      throw new BadRequestException(
        'Cette fiche n’a pas encore été contrôlée : pour décider sans le contrôle, écrivez pourquoi.',
      );
    a.contentieux = {
      ...a.contentieux!,
      etat: decision === 'CONFIRMER' ? 'CONFIRME' : 'REJETE',
      decidePar: u.nom,
      decideLe: new Date().toISOString(),
      note: n,
    };
    await this.agents.save(a);
    await this.journal.log(u, 'PERSONNEL_CONTENTIEUX', 'agent_recense', a.id, {
      nom: a.nomComplet,
      decision,
      note: n,
      sansControle: !a.contentieux.controleLe,
    });
    return a;
  }

  /** Fiches qui sont peut-être la même personne (nom proche ; date de naissance égale ou inconnue). */
  async memesPersonnes(u: UtilisateurConnecte, id: number) {
    const a = await this.trouver(u, id);
    const mots = motsDuNom(a.nomComplet).filter((m) => m.length >= 4);
    if (!mots.length) return [];
    const lignes = await this.agents.query<
      {
        id: number;
        numeroFiche: string;
        statut: string;
        nomComplet: string;
        dateNaissance: string | null;
        matricule: string | null;
        departementId: number | null;
        lieuService: string | null;
        volontaireId: string | null;
      }[]
    >(
      `SELECT id, "numeroFiche", statut, "nomComplet", to_char("dateNaissance", 'YYYY-MM-DD') AS "dateNaissance",
              matricule, "departementId", donnees->>'LIEU_SERVICE' AS "lieuService", "volontaireId"
         FROM agent_recense
        WHERE id <> $1 AND "nomNormalise" ~ $2 AND NOT (id = ANY($3::int[]))
        LIMIT 500`,
      [a.id, `\\m(${mots.join('|')})\\M`, a.distinctes ?? []],
    );
    const p = await this.perimetre(u);
    const motsA = motsDuNom(a.nomComplet);
    return lignes
      .map((l) => ({
        ...l,
        ressemblance: ressemblance(
          motsA,
          a.dateNaissance,
          motsDuNom(l.nomComplet),
          l.dateNaissance,
        ),
        visible: this.dansPerimetre(p, l as unknown as AgentRecense),
      }))
      .filter((l) => l.ressemblance)
      .sort((x, y) =>
        x.ressemblance === y.ressemblance
          ? x.nomComplet.localeCompare(y.nomComplet)
          : x.ressemblance === 'PROBABLE'
            ? -1
            : 1,
      )
      .slice(0, 20);
  }

  /** Deux fiches de personnes différentes (homonymes vérifiés) : on ne les propose plus à la fusion. */
  async distinguer(u: UtilisateurConnecte, id: number, autreId: number) {
    const a = await this.trouver(u, id);
    const b = await this.trouver(u, autreId);
    a.distinctes = [...new Set([...(a.distinctes ?? []), b.id])];
    b.distinctes = [...new Set([...(b.distinctes ?? []), a.id])];
    await this.agents.save([a, b]);
    await this.journal.log(u, 'PERSONNEL_DISTINCTS', 'agent_recense', a.id, {
      nom: a.nomComplet,
      autre: `${b.nomComplet} (${b.numeroFiche})`,
    });
    return { ok: true };
  }

  /**
   * Fusion de deux fiches de la même personne (venue de deux bases : volontaire puis fonctionnaire…).
   * La fiche gardée prend ce qui lui manque dans l'autre ; pièces et parcours sont réunis ; un statut
   * d'agent de l'État l'emporte sur volontaire ou communautaire. L'autre fiche disparaît.
   */
  async fusionner(u: UtilisateurConnecte, id: number, autreId: number) {
    if (id === autreId)
      throw new BadRequestException('Choisissez deux fiches différentes.');
    const a = await this.trouver(u, id);
    const b = await this.trouver(u, autreId);
    if (a.volontaireId && b.volontaireId)
      throw new BadRequestException(
        'Les deux fiches sont liées au registre des volontaires : la personne y est inscrite deux fois. Sortez le doublon du registre (motif « Doublon ») : sa fiche suivra.',
      );
    const c = this.config.get();
    const d: Record<string, unknown> = { ...a.donnees };
    for (const [k, v] of Object.entries(b.donnees ?? {})) {
      if (estVide(v)) continue;
      const ch = c.champs.find((x) => x.code === k);
      if (estVide(d[k])) d[k] = v;
      else if (
        ch &&
        ['LIGNES', 'LISTE_MULTIPLE', 'TABLEAU'].includes(ch.type) &&
        Array.isArray(d[k]) &&
        Array.isArray(v)
      ) {
        const vus = new Set((d[k] as unknown[]).map((x) => JSON.stringify(x)));
        d[k] = [
          ...(d[k] as unknown[]),
          ...(v as unknown[]).filter((x) => !vus.has(JSON.stringify(x))),
        ];
      }
    }
    // Parcours réunis, dans l'ordre des dates ; le statut d'agent de l'État l'emporte
    const etat =
      [a, b].find((x) => STATUTS_ETAT.includes(x.statut)) ??
      (a.statut === b.statut ? a : null);
    const statut = etat?.statut ?? a.statut;
    const cle = (e: EtapeStatut) => e.depuis ?? e.le ?? '';
    const parcours = [...parcoursDe(b), ...parcoursDe(a)]
      .sort((x, y) => cle(x).localeCompare(cle(y)))
      .filter((e, i, t) => i === 0 || t[i - 1].statut !== e.statut);
    if (parcours[parcours.length - 1]?.statut !== statut)
      parcours.push(etape(statut, u.nom, jourIso(), 'Fusion de deux fiches'));
    const volontaireId = a.volontaireId ?? b.volontaireId;
    const contentieux =
      enAttente(a.contentieux) && !enAttente(b.contentieux)
        ? {
            ...a.contentieux,
            etat: 'CONFIRME' as const,
            decidePar: u.nom,
            decideLe: new Date().toISOString(),
            note: `Retrouvé dans la base (fiche ${b.numeroFiche})`,
          }
        : a.contentieux;
    // Pièces des deux fiches, comptées avant de les réunir
    const f = await this.piecesFournies([a.id, b.id]);
    const fournies: Record<string, number> = { ...(f.get(a.id) ?? {}) };
    for (const [k, n] of Object.entries(f.get(b.id) ?? {}))
      fournies[k] = (fournies[k] ?? 0) + n;
    await this.agents.manager.transaction(async (m) => {
      await m.update(PieceRecensement, { agentId: b.id }, { agentId: a.id });
      await m.update(EvenementCarriere, { agentId: b.id }, { agentId: a.id });
      // Suivi de la fiche absorbée : gardé sauf doublon (même jour, même année)
      await m.query(
        `UPDATE presence p SET "agentId" = $2 WHERE "agentId" = $1
           AND NOT EXISTS (SELECT 1 FROM presence q WHERE q."agentId" = $2 AND q.date = p.date)`,
        [b.id, a.id],
      );
      await m.query(
        `UPDATE evaluation_agent e SET "agentId" = $2 WHERE "agentId" = $1
           AND NOT EXISTS (SELECT 1 FROM evaluation_agent x WHERE x."agentId" = $2 AND x.annee = e.annee)`,
        [b.id, a.id],
      );
      for (const t of ['presence', 'horaire_agent', 'evaluation_agent'])
        await m.query(`DELETE FROM ${t} WHERE "agentId" = $1`, [b.id]);
      await m.query(
        `UPDATE structure SET "responsableId" = $2 WHERE "responsableId" = $1`,
        [b.id, a.id],
      );
      await m.delete(AgentRecense, b.id);
      Object.assign(a, await this.colonnes(d), {
        donnees: d,
        statut,
        parcours,
        volontaireId,
        liaison: { ...(b.liaison ?? {}), ...(a.liaison ?? {}) },
        structureId: a.structureId ?? b.structureId,
        contentieux,
        distinctes: [
          ...new Set([...(a.distinctes ?? []), ...(b.distinctes ?? [])]),
        ].filter((x) => x !== a.id && x !== b.id),
        modifiePar: u.nom,
      });
      a.departementId = a.departementId ?? b.departementId;
      this.appliquerEvaluation(a, fournies);
      await m.save(a);
    });
    await this.journal.log(u, 'PERSONNEL_FUSION', 'agent_recense', a.id, {
      nom: a.nomComplet,
      fusionnee: `${b.nomComplet} (${b.numeroFiche}, ${b.statut})`,
    });
    return a;
  }

  /* ------------------------------ Pièces ------------------------------ */

  typePiece(code: string) {
    const p = this.config.get().pieces.find((x) => x.code === code);
    if (!p)
      throw new BadRequestException(
        'Choisissez le type de pièce dans la liste.',
      );
    return p;
  }

  async ajouterPiece(
    u: UtilisateurConnecte,
    id: number,
    type: string,
    f: Express.Multer.File,
    /** Pièce d'une ligne de tableau (l'acte de naissance du 2ᵉ enfant : 2). */
    ligne: number | null = null,
  ) {
    const a = await this.trouver(u, id);
    const tp = this.typePiece(type);
    // Un enfant n'a qu'un acte de naissance : le nouveau scan remplace l'ancien
    const ancienne = ligne
      ? await this.pieces.findOne({
          where: { agentId: id, type: tp.code, ligne },
        })
      : null;
    const nom = await this.stockage.enregistrer('recensement', f);
    const p = await this.pieces.save(
      this.pieces.create({
        agentId: id,
        type: tp.code,
        nomOrigine: f.originalname,
        fichier: nom,
        mime: f.mimetype,
        taille: f.size,
        ligne,
        ajoutePar: u.nom,
      }),
    );
    if (ancienne) {
      await this.pieces.delete(ancienne.id);
      await this.stockage.supprimer('recensement', ancienne.fichier);
    }
    await this.reevaluer([a.id]);
    await this.journal.log(u, 'RECENSEMENT_PIECE', 'agent_recense', id, {
      piece: tp.libelle,
      fichier: f.originalname,
    });
    return p;
  }

  async piece(u: UtilisateurConnecte, id: number, pieceId: string) {
    await this.trouver(u, id);
    const p = await this.pieces.findOne({
      where: { id: pieceId, agentId: id },
    });
    if (!p) throw new NotFoundException('Pièce introuvable');
    return p;
  }

  async supprimerPiece(u: UtilisateurConnecte, id: number, pieceId: string) {
    const p = await this.piece(u, id, pieceId);
    await this.pieces.delete(p.id);
    await this.stockage.supprimer('recensement', p.fichier);
    await this.reevaluer([id]);
    await this.journal.log(
      u,
      'RECENSEMENT_PIECE_RETIREE',
      'agent_recense',
      id,
      { piece: p.type, fichier: p.nomOrigine },
    );
    return { supprime: true };
  }

  /**
   * Pièces déposées en masse : chaque fichier est nommé « N° de fiche (ou matricule)_TYPE »,
   * ex. « REC-000123_CNI.pdf », « 179407Z_ACTE_NAISSANCE.jpg », « REC-000123_ACTE_NAISSANCE_ENFANT_2.pdf ».
   */
  async piecesEnMasse(u: UtilisateurConnecte, fichiers: Express.Multer.File[]) {
    const c = this.config.get();
    const p = await this.perimetre(u);
    const types = [...c.pieces].sort((x, y) => y.code.length - x.code.length);
    const resultats: { fichier: string; ok: boolean; message: string }[] = [];
    const refuser = (f: Express.Multer.File, message: string) =>
      resultats.push({ fichier: f.originalname, ok: false, message });
    // Un même agent a souvent plusieurs scans dans le lot : il n'est cherché qu'une fois
    const agentsParRef = new Map<string, AgentRecense | null>();
    const aDeposer: {
      i: number;
      f: Express.Multer.File;
      a: AgentRecense;
      tp: (typeof c.pieces)[number];
      ligne: number | null;
    }[] = [];

    // 1. Reconnaître chaque fichier (nom, type de pièce, agent, périmètre)
    for (const f of fichiers) {
      const base = f.originalname.replace(/\.[a-z0-9]{1,5}$/i, '');
      const k = normaliser(base).replace(/[^A-Z0-9]+/g, '_');
      const m = k.match(/^(REC_?\d+|\d+[A-Z]?|[A-Z0-9]+?)_(.+)$/);
      if (!m) {
        refuser(
          f,
          'Nom non reconnu : « N° de fiche_TYPE » attendu (ex. REC-000123_CNI.pdf).',
        );
        continue;
      }
      const ref = m[1].replace('_', '');
      const reste = m[2].replace(/_\d+$/, '');
      // « …_ACTE_NAISSANCE_ENFANT_2 » : l'acte du 2ᵉ enfant
      const rang = Number(/_(\d{1,2})$/.exec(m[2])?.[1]) || null;
      const tp = types.find(
        (t) =>
          reste === t.code ||
          cleCompacte(reste) === cleCompacte(t.libelle) ||
          cleCompacte(reste) === cleCompacte(t.code),
      );
      if (!tp) {
        refuser(
          f,
          `Type de pièce « ${m[2]} » inconnu (codes : ${c.pieces.map((x) => x.code).join(', ')}).`,
        );
        continue;
      }
      if (!agentsParRef.has(ref)) {
        const num = /^REC\d+$/.test(ref)
          ? numeroFiche(Number(ref.slice(3)))
          : /^\d{1,6}$/.test(ref)
            ? numeroFiche(Number(ref))
            : null;
        agentsParRef.set(
          ref,
          (num
            ? await this.agents.findOne({ where: { numeroFiche: num } })
            : null) ??
            (await this.agents.findOne({ where: { matricule: ref } })),
        );
      }
      const a = agentsParRef.get(ref);
      if (!a) {
        refuser(
          f,
          `Aucun agent avec le n° de fiche ou le matricule « ${ref} ».`,
        );
        continue;
      }
      if (!this.dansPerimetre(p, a)) {
        refuser(f, `${a.nomComplet} n’est pas dans votre établissement.`);
        continue;
      }
      if (!/\.(pdf|jpe?g|png)$/i.test(f.originalname)) {
        refuser(f, 'Seuls les PDF, JPG et PNG sont acceptés.');
        continue;
      }
      aDeposer.push({ i: resultats.length, f, a, tp, ligne: rang });
      resultats.push({ fichier: f.originalname, ok: false, message: '' });
    }

    // 2. Écarter les doublons : même agent, même type, même nom de fichier et même taille
    // (dossier de scans redéposé), déjà dans la base ou deux fois dans ce lot
    const cle = (agentId: number, type: string, nom: string, taille: number) =>
      `${agentId}|${type}|${nom}|${taille}`;
    const dejaLa = new Set(
      aDeposer.length
        ? (
            await this.pieces.find({
              where: { agentId: In([...new Set(aDeposer.map((x) => x.a.id))]) },
              select: {
                agentId: true,
                type: true,
                nomOrigine: true,
                taille: true,
              },
            })
          ).map((x) => cle(x.agentId, x.type, x.nomOrigine, x.taille))
        : [],
    );
    const nouveaux = aDeposer.filter(({ i, f, a, tp }) => {
      const k = cle(a.id, tp.code, f.originalname, f.size);
      if (!dejaLa.has(k)) return dejaLa.add(k);
      resultats[i] = {
        fichier: f.originalname,
        ok: false,
        message: `Déjà déposé : ${tp.libelle} de ${a.nomComplet} (${a.numeroFiche}).`,
      };
      return false;
    });

    // 3. Garder les fichiers, quelques-uns à la fois
    const touches = new Set<number>();
    await parallele(
      nouveaux,
      ENVOIS_SIMULTANES,
      async ({ i, f, a, tp, ligne }) => {
        try {
          const nom = await this.stockage.enregistrer('recensement', f);
          await this.pieces.save(
            this.pieces.create({
              agentId: a.id,
              type: tp.code,
              nomOrigine: f.originalname,
              fichier: nom,
              mime: f.mimetype,
              taille: f.size,
              ligne,
              ajoutePar: u.nom,
            }),
          );
          touches.add(a.id);
          resultats[i] = {
            fichier: f.originalname,
            ok: true,
            message: `${tp.libelle} de ${a.nomComplet} (${a.numeroFiche})`,
          };
        } catch (e) {
          resultats[i] = {
            fichier: f.originalname,
            ok: false,
            message: e instanceof Error ? e.message : 'Fichier non enregistré.',
          };
        }
      },
    );
    await this.reevaluer([...touches]);
    if (touches.size)
      await this.journal.log(
        u,
        'RECENSEMENT_PIECES_MASSE',
        'agent_recense',
        null,
        {
          fichiers: resultats.filter((r) => r.ok).length,
          agents: touches.size,
        },
      );
    return {
      resultats,
      deposees: resultats.filter((r) => r.ok).length,
      refusees: resultats.filter((r) => !r.ok).length,
    };
  }

  /** Recalcule ce qui manque (après une pièce, un import ou un changement de la configuration). */
  async reevaluer(ids?: number[]) {
    const pas = 500;
    let dernier = 0;
    for (;;) {
      const lot = ids
        ? await this.agents.find({
            where: { id: In(ids.slice(dernier, dernier + pas)) },
          })
        : await this.agents.query<AgentRecense[]>(
            `SELECT * FROM agent_recense WHERE id > $1 ORDER BY id LIMIT ${pas}`,
            [dernier],
          );
      if (!lot.length) break;
      const fournies = await this.piecesFournies(lot.map((a) => a.id));
      for (const a of lot) {
        this.appliquerEvaluation(a, fournies.get(a.id) ?? {});
        await this.agents.update(a.id, {
          manques: a.manques,
          taux: a.taux,
          complet: a.complet,
        });
      }
      if (ids) {
        dernier += pas;
        if (dernier >= ids.length) break;
      } else dernier = lot[lot.length - 1].id;
    }
  }

  /* ------------------------------ Contrôles et tableau de bord ------------------------------ */

  /** Contrôles sur les agents du périmètre : doublons, âges, téléphone partagé, valeurs et règles à vérifier. */
  async controles(u: UtilisateurConnecte) {
    const c = this.config.get();
    const p = await this.perimetre(u);
    const fp = this.filtrePerimetre(p);
    const lignes = await this.agents.query<
      {
        id: number;
        nomNormalise: string;
        dateNaissance: string | null;
        matricule: string | null;
        telephone: string | null;
        position: string | null;
        categorie: string | null;
        statut: string;
        carriere: Record<string, unknown>;
        manques: AgentRecense['manques'];
        nomComplet: string;
        registre: string | null;
        contentieux: string | null;
        distinctes: number[];
      }[]
    >(
      `SELECT a.id, a."nomNormalise", to_char(a."dateNaissance", 'YYYY-MM-DD') AS "dateNaissance", a.matricule, a.telephone,
              a.donnees->>'POSITION' AS position, a.donnees->>'CATEGORIE' AS categorie, a.statut,
              jsonb_build_object('DATE_GRADE', a.donnees->'DATE_GRADE', 'PROMOTIONS', a.donnees->'PROMOTIONS',
                                 'DATE_RECRUTEMENT', a.donnees->'DATE_RECRUTEMENT') AS carriere, a.manques, a."nomComplet", v.statut AS registre,
              a.contentieux->>'etat' AS contentieux, a.distinctes
         FROM agent_recense a LEFT JOIN volontaire v ON v.id = a."volontaireId"
        WHERE ${fp.sql.replace('$X', '$1')}`,
      fp.params,
    );
    const ids = new Map<string, Set<number>>();
    const ajouter = (code: string, id: number) => {
      const s = ids.get(code) ?? new Set<number>();
      s.add(id);
      ids.set(code, s);
    };
    const groupes = (
      cle: (l: (typeof lignes)[number]) => string | null,
      min: number,
      code: string,
    ) => {
      const m = new Map<string, number[]>();
      for (const l of lignes) {
        const k = cle(l);
        if (k) m.set(k, [...(m.get(k) ?? []), l.id]);
      }
      for (const g of m.values())
        if (g.length >= min) g.forEach((id) => ajouter(code, id));
    };
    groupes(
      (l) => (l.dateNaissance ? `${l.nomNormalise}|${l.dateNaissance}` : null),
      2,
      'DOUBLON',
    );
    groupes((l) => l.matricule, 2, 'MATRICULE_DOUBLE');
    // Même personne probable sous deux fiches (deux bases : volontaire puis fonctionnaire, nom écrit autrement…)
    const index = new IndexNoms<(typeof lignes)[number]>();
    for (const l of lignes) {
      for (const x of index.probables(l.nomComplet, l.dateNaissance))
        if (
          !(l.distinctes ?? []).includes(x.id) &&
          !(x.distinctes ?? []).includes(l.id) &&
          // Même nom écrit pareil et même date : déjà « DOUBLON »
          !(
            x.nomNormalise === l.nomNormalise &&
            x.dateNaissance &&
            x.dateNaissance === l.dateNaissance
          )
        ) {
          ajouter('MEME_PERSONNE', l.id);
          ajouter('MEME_PERSONNE', x.id);
        }
      index.ajouter(l.nomComplet, l.dateNaissance, l);
    }
    for (const l of lignes) {
      if (l.contentieux === 'EN_COURS') ajouter('CONTENTIEUX', l.id);
      if (l.contentieux === 'CONTROLE') ajouter('CONTENTIEUX_DG', l.id);
    }
    groupes(
      (l) => {
        const t = (l.telephone ?? '').replace(/\D/g, '');
        return t && !/^0+$/.test(t.slice(2)) ? t : null;
      },
      c.telephonePartage,
      'TELEPHONE_PARTAGE',
    );
    // Volontaire encore payé (en poste dans le registre) qui figure aussi comme agent de l'État
    const enPoste = lignes.filter((l) => l.registre === 'EN_POSTE');
    if (enPoste.length) {
      const etat = new IndexNoms<string>();
      for (const x of await this.agents.query<
        {
          nomComplet: string;
          dateNaissance: string | null;
          numeroFiche: string;
        }[]
      >(
        `SELECT "nomComplet", to_char("dateNaissance", 'YYYY-MM-DD') AS "dateNaissance", "numeroFiche"
           FROM agent_recense WHERE statut IN ('FONCTIONNAIRE', 'CONTRACTUEL') AND "volontaireId" IS NULL AND coalesce(contentieux->>'etat', 'CONFIRME') = 'CONFIRME'`,
      ))
        etat.ajouter(x.nomComplet, x.dateNaissance, x.numeroFiche);
      for (const l of enPoste)
        if (etat.probables(l.nomComplet, l.dateNaissance).length)
          ajouter('VOLONTAIRE_AGENT_ETAT', l.id);
    }
    const aujourdhui = jourIso();
    // Âge de la retraite de chaque catégorie (Administration › Référentiels › Catégories d'agents) ;
    // l'âge unique de la configuration sert quand la catégorie de l'agent est inconnue
    const ageCategorie = new Map(
      (
        await this.agents.query<{ code: string; age: string | null }[]>(
          `SELECT code, donnees->>'ageRetraite' AS age FROM referentiel WHERE type = 'CATEGORIE_AGENT' AND actif`,
        )
      )
        .filter((x) => Number(x.age) > 0)
        .map((x) => [x.code, Number(x.age)]),
    );
    for (const l of lignes) {
      if (l.dateNaissance) {
        const age = ageRevolu(l.dateNaissance, aujourdhui);
        if (age < c.ageMinimum) ajouter('AGE_MINIMUM', l.id);
        const cat = codeCategorie(l.categorie);
        // Catégorie inconnue et aucun âge réglé : on ne suppose rien (la catégorie est signalée manquante)
        const limite = (cat && ageCategorie.get(cat)) || c.ageRetraite;
        if (
          limite &&
          age >= limite &&
          (!l.position || l.position === 'ACTIVITE')
        )
          ajouter('AGE_RETRAITE', l.id);
      }
      // Promotion ou avancement dû (DG, 24/10/2026) : agent en activité, accepté dans la base
      const av =
        (!l.position || l.position === 'ACTIVITE') &&
        (!l.contentieux || l.contentieux === 'CONFIRME')
          ? prochainAvancement(c, l.statut, l.carriere ?? {})
          : null;
      if (av && av.prochain <= aujourdhui) ajouter('AVANCEMENT_DU', l.id);
      for (const v of l.manques?.aVerifier ?? [])
        ajouter(v.startsWith('REGLE:') ? v : 'VALEUR_HORS_LISTE', l.id);
    }
    const libelles: Record<string, string> = {
      DOUBLON: 'Même nom et même date de naissance (recensé deux fois ?)',
      MATRICULE_DOUBLE: 'Même matricule pour plusieurs agents',
      TELEPHONE_PARTAGE: `Même téléphone pour ${c.telephonePartage} agents ou plus`,
      AGE_MINIMUM: `Moins de ${c.ageMinimum} ans (date de naissance à vérifier)`,
      AGE_RETRAITE: c.ageRetraite
        ? `Âge de la retraite atteint et encore en activité (âge de sa catégorie, sinon ${c.ageRetraite} ans)`
        : 'Âge de la retraite de sa catégorie atteint et encore en activité',
      AVANCEMENT_DU: `Promotion (fonctionnaire, tous les ${duree(c.delaiPromotionMois)}) ou avancement (contractuel, tous les ${duree(c.delaiAvancementMois)}) dû`,
      VALEUR_HORS_LISTE: 'Valeur hors des listes de la fiche (à vérifier)',
      VOLONTAIRE_AGENT_ETAT:
        'Volontaire encore payé qui figure aussi comme fonctionnaire ou contractuel',
      MEME_PERSONNE:
        'Même personne probable sous deux fiches (à fusionner, ou à déclarer différentes)',
      CONTENTIEUX:
        'Ajouté au recensement, absent de la base : à contrôler par le bureau du contrôle',
      CONTENTIEUX_DG:
        'Ajouté au recensement et contrôlé : à décider par le DG (accepter ou rejeter)',
    };
    for (const r of c.regles)
      libelles[`REGLE:${r.code}`] = `Incohérence : ${r.libelle}`;
    return { ids, libelles, total: lignes.length };
  }

  async tableau(u: UtilisateurConnecte) {
    const c = this.config.get();
    const p = await this.perimetre(u);
    const fp = this.filtrePerimetre(p);
    const w = fp.sql.replace('$X', '$1');
    const q = <T>(sql: string) => this.agents.query<T[]>(sql, fp.params);
    const [totaux] = await q<{
      total: number;
      complets: number;
      taux: number | null;
    }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE complet)::int AS complets, round(avg(taux))::int AS taux FROM agent_recense a WHERE ${w}`,
    );
    const parStatut = await q<{ statut: string; n: number; complets: number }>(
      `SELECT statut, count(*)::int AS n, count(*) FILTER (WHERE complet)::int AS complets FROM agent_recense a WHERE ${w} GROUP BY 1 ORDER BY 2 DESC`,
    );
    const parDepartement = await q<{
      departementId: number | null;
      n: number;
      complets: number;
    }>(
      `SELECT "departementId", count(*)::int AS n, count(*) FILTER (WHERE complet)::int AS complets FROM agent_recense a WHERE ${w} GROUP BY 1 ORDER BY 2 DESC`,
    );
    const champs = await q<{ code: string; n: number }>(
      `SELECT x AS code, count(*)::int AS n FROM agent_recense a, jsonb_array_elements_text(coalesce(a.manques->'champs','[]'::jsonb)) x WHERE ${w} GROUP BY 1 ORDER BY 2 DESC`,
    );
    const pieces = await q<{ code: string; n: number; total: number }>(
      `SELECT x->>'code' AS code, count(*)::int AS n, sum((x->>'manque')::int)::int AS total FROM agent_recense a, jsonb_array_elements(coalesce(a.manques->'pieces','[]'::jsonb)) x WHERE ${w} GROUP BY 1 ORDER BY 2 DESC`,
    );
    const ctl = await this.controles(u);
    return {
      total: totaux.total,
      complets: totaux.complets,
      tauxMoyen: totaux.taux ?? 0,
      parStatut,
      parDepartement,
      champsManquants: champs.map((x) => ({
        ...x,
        libelle: c.champs.find((ch) => ch.code === x.code)?.libelle ?? x.code,
      })),
      piecesManquantes: pieces.map((x) => ({
        ...x,
        libelle: c.pieces.find((pc) => pc.code === x.code)?.libelle ?? x.code,
      })),
      controles: [...ctl.ids.entries()]
        .map(([code, s]) => ({
          code,
          libelle: ctl.libelles[code] ?? code,
          n: s.size,
        }))
        .sort((a, b) => b.n - a.n),
    };
  }
}
