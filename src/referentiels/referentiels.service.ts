import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { In, Like, Repository } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { TYPES_STRUCTURE } from '../circuit/catalogue';
import { codeDepartement } from '../common/referentiels';
import { cleCompacte, normaliser } from '../common/texte';
import { JournalService } from '../core/core.service';
import { RecensementService } from '../recensement/recensement.service';
import { Departement, Referentiel, Structure } from '../entities';

/**
 * Référentiels de l'application (Administration › Référentiels) et leur reprise depuis l'ancien
 * système de test du ministère (SGRH – MEPPSA), lu le 24/10/2026 : écoles et inspections, localités,
 * cycles, niveaux, matières, programmes (heures et coefficient par niveau et matière), postes…
 *
 * Partout où l'on saisit une école, une inspection, une localité, une matière ou un poste, la valeur
 * se choisit dans ces listes avec une recherche ; si elle n'y est pas, on peut toujours la taper.
 */

export const TYPES_REFERENTIEL: Record<
  string,
  { libelle: string; aide: string; parent?: string }
> = {
  LOCALITE: {
    libelle: 'Districts, communes et arrondissements',
    aide: 'Localisation physique des écoles : district en zone rurale, commune ou arrondissement en ville (pas de village ni de quartier).',
  },
  VILLE: { libelle: 'Villes', aide: 'Villes principales, par département.' },
  CYCLE: {
    libelle: 'Cycles',
    aide: 'Préscolaire, primaire, collège, lycée, alphabétisation…',
  },
  NIVEAU: {
    libelle: 'Niveaux',
    aide: 'Les années d’études de chaque cycle (CP1, 6e, seconde C…).',
    parent: 'CYCLE',
  },
  MATIERE: {
    libelle: 'Matières',
    aide: 'Les matières enseignées dans chaque cycle, avec leur type et l’exigence d’un enseignant spécialisé.',
    parent: 'CYCLE',
  },
  TYPE_MATIERE: {
    libelle: 'Types de matières',
    aide: 'Générale, littéraire, scientifique, technique, sport, beaux-arts : le type se choisit sur chaque matière.',
  },
  PROGRAMME: {
    libelle: 'Programmes (heures par semaine)',
    aide: 'Pour chaque niveau et chaque matière : les heures par semaine et le coefficient. Ils servent au calcul de la masse horaire et du déficit d’enseignants.',
    parent: 'CYCLE',
  },
  POSTE: {
    libelle: 'Postes et fonctions',
    aide: 'Fonctions occupées (chef d’établissement, directeur des études, surveillant général, économe…), utiles aux nominations.',
  },
  TYPE_BATIMENT: {
    libelle: 'Types de bâtiments',
    aide: 'Administratif, pédagogique, sanitaire, sportif…',
  },
  TYPE_SALLE: {
    libelle: 'Types de salles',
    aide: 'Salle de classe, bureau, laboratoire, bibliothèque…',
  },
  TYPE_PERSONNEL: {
    libelle: 'Types de personnel',
    aide: 'Enseignant, administratif, technique, politique.',
  },
  CATEGORIE_AGENT: {
    libelle: 'Catégories d’agents',
    aide: 'Catégories de la Fonction Publique et leur âge de retraite (à confirmer par le DG).',
  },
  ECHELLE: {
    libelle: 'Échelles',
    aide: 'Échelles de la grille indiciaire : nombre d’échelons et durée d’un échelon.',
  },
};

/** Listes où l'on choisit une valeur (champ avec recherche) : référentiels et organigramme. */
export const LISTES_CHOIX: Record<string, string> = {
  ETABLISSEMENT: 'Écoles (organigramme)',
  INSPECTION: 'Inspections (organigramme)',
  STRUCTURE: 'Structures administratives (organigramme)',
  LOCALITE: 'Districts, communes, arrondissements et villes',
  MATIERE: 'Matières',
  TYPE_MATIERE: 'Types de matières',
  POSTE: 'Postes et fonctions',
  NIVEAU: 'Niveaux',
  CYCLE: 'Cycles',
  TYPE_BATIMENT: 'Types de bâtiments',
  TYPE_SALLE: 'Types de salles',
};

const DOSSIER = resolve(process.cwd(), 'amorcage', 'referentiels');

/** Corrections des données de l'ancien système : même lieu écrit de deux façons. */
const LOCALITE_CANONIQUE: Record<string, string> = {
  KAKAMOEKA: 'Kakamouéka',
  MONGOPOUKOU: 'Mongo-Mpoukou',
  MONGOMPOUKOU: 'Mongo-Mpoukou',
  TIETIE: 'Tié-Tié',
  MADINGOKAYES: 'Madingou-Kayes',
  MADINGOUKAYES: 'Madingou-Kayes',
  ONGONI: 'Ongogni',
  ONGOGNI: 'Ongogni',
  NKAYES: 'Nkayi',
  TSIAKA: 'Tsiaki',
};
/** Rattachements faux ou manquants dans l'ancien système. */
const DEPARTEMENT_CORRIGE: Record<string, string> = {
  LOUKOLELA: 'CONGO_OUBANGUI',
  MOSSAKA: 'CONGO_OUBANGUI',
  MOSSENDJO: 'NIARI',
  OUESSO: 'SANGHA',
};
/** Type d'école de l'ancien système → cycle de l'organigramme. */
const CYCLE_ECOLE: Record<string, string> = {
  PRI: 'PRIMAIRE',
  COL: 'COLLEGE',
  LYC: 'LYCEE',
  PRE: 'PRESCOLAIRE',
  ALP: 'ALPHABETISATION',
};
/** Types de matières de l'ancien système, avec l'orthographe corrigée (« Scitientifique », « Litteraire »). */
const TYPES_MATIERE_ANCIENS: {
  code: string;
  libelle: string;
  description: string;
}[] = [
  { code: 'G', libelle: 'Générale', description: 'Matière générale' },
  {
    code: 'L',
    libelle: 'Littéraire',
    description: 'Matière de langue, de littérature',
  },
  { code: 'S', libelle: 'Scientifique', description: 'Matière scientifique' },
  { code: 'T', libelle: 'Technique', description: 'Matière technique' },
  { code: 'E', libelle: 'Sport', description: 'Matière sportive' },
  { code: 'B', libelle: 'Beaux-Arts', description: 'Création artistique' },
];
const TYPE_MATIERE_CORRIGE: Record<string, string> = {
  Litteraire: 'Littéraire',
  Scitientifique: 'Scientifique',
};
const VILLES_ARRONDISSEMENTS = ['BRAZZAVILLE', 'POINTE_NOIRE'];

/**
 * Nom d'une école de l'ancien système, qui préfixait le cycle : « Lycee LYCEE VICTOR AUGAGNEUR »
 * → « LYCEE VICTOR AUGAGNEUR », « College CEG DE NKAYI » → « CEG DE NKAYI », « Primaire Solidarité A »
 * → « École primaire Solidarité A ».
 */
export function nomEcole(brut: string) {
  const nom = brut.replace(/\s+/g, ' ').trim();
  const m = /^(Primaire|Pr[ée]scolaire|Coll[èe]ge|Lyc[ée]e)\s+(.+)$/i.exec(nom);
  if (!m) return nom;
  const reste = m[2];
  // « Lycee LYCCE D'ENYELLE » : le lycée répété, faute de frappe comprise
  if (/^lyc/i.test(m[1]) && normaliser(reste).startsWith('LYC')) return reste;
  if (
    /^(LYCEE|CEG|COLLEGE|EP\b|ECOLE|CEP\b|CENTRE|JARDIN|GROUPE|COMPLEXE|INSTITUT)/.test(
      normaliser(reste),
    )
  )
    return reste;
  return /^prim/i.test(m[1]) ? `École primaire ${reste}` : nom;
}

/** Types de l'ancien système pour l'administration centrale. */
const TYPE_CENTRAL: Record<string, string> = {
  MIN: 'MINISTERE',
  CAB: 'CABINET',
  DG: 'DIRECTION_GENERALE',
  IG: 'INSPECTION_GENERALE',
  DC: 'DIRECTION_CENTRALE',
  SD: 'SERVICE',
  '': 'DIRECTION_CENTRALE',
};
/** La même structure dans la DGRHAS (types du circuit interne). */
const TYPE_DGRHAS: Record<string, string> = {
  DIRECTION_CENTRALE: 'DIRECTION_DGRHAS',
  SERVICE: 'SERVICE_DGRHAS',
  BUREAU: 'BUREAU_DGRHAS',
};
/** Niveau des types de l'administration centrale (pour créer les supérieures d'abord). */
const TYPES_STRUCTURE_NIVEAU: Record<string, number> = Object.fromEntries(
  Object.entries(TYPES_STRUCTURE)
    .filter(([, t]) => t.perimetre === 'CENTRAL' || t.perimetre === 'POLITIQUE')
    .map(([k, t]) => [k, t.niveau]),
);
/** Structure supérieure mal écrite dans l'ancien système. */
const CODE_CORRIGE: Record<string, string> = { MEPSA: 'MEPPSA' };

/** Texte SQL en majuscules sans accents (comme `normaliser` côté serveur). */
const SQL_SANS_ACCENTS = (expr: string) =>
  `translate(upper(${expr}), 'ÀÁÂÄÃÉÈÊËÍÌÎÏÓÒÔÖÕÚÙÛÜÇŸ’', 'AAAAAEEEEIIIIOOOOOUUUUCY''')`;

const majuscule = (s: string) =>
  s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;

export interface OptionChoix {
  valeur: string;
  libelle: string;
  detail?: string;
}

@Injectable()
export class ReferentielsService implements OnApplicationBootstrap {
  private readonly log = new Logger('Référentiels');

  constructor(
    @InjectRepository(Referentiel)
    private readonly refs: Repository<Referentiel>,
    @InjectRepository(Structure)
    private readonly structures: Repository<Structure>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    private readonly journal: JournalService,
    private readonly rec: RecensementService,
  ) {}

  /**
   * Première mise en service : les référentiels de l'ancien système sont chargés une fois ; une
   * base déjà chargée reçoit ensuite l'administration centrale et les noms d'écoles corrigés.
   */
  async onApplicationBootstrap() {
    try {
      // Orthographe reprise de l'ancien système : corrigée partout, même sans ses fichiers
      await this.corrigerNiveaux();
      await this.corrigerPostes();
      if (!existsSync(DOSSIER)) return;
      const aFaire =
        (await this.refs.count()) === 0 ||
        !(await this.structures.exist({ where: { type: 'MINISTERE' } })) ||
        (await this.structures.exist({
          where: [
            { type: 'ETABLISSEMENT', nom: Like('Lycee LYC%') },
            { type: 'ETABLISSEMENT', nom: Like('College CEG%') },
          ],
        }));
      if (aFaire) {
        const r = await this.importerAncien(null);
        this.log.log(
          `Référentiels de l'ancien système chargés : ${r.valeurs} valeur(s) ; organigramme : ${r.inspections.creees} inspection(s), ${r.ecoles.creees} école(s), ${r.centrale.creees} structure(s) de l'administration centrale ajoutées, ${r.ecoles.renommees} nom(s) d'école corrigé(s)`,
        );
      }
      await this.assurerTypesMatiere();
      // Un rechargement de l'ancien système remet son orthographe : corrigée à nouveau
      await this.corrigerNiveaux();
      await this.corrigerPostes();
      // Fiches du personnel sans établissement : rattachées d'après leur lieu de service
      const n = await this.rec.rattacherAutomatiquement();
      if (n)
        this.log.log(
          `${n} fiche(s) du personnel rattachée(s) à leur structure d'après le lieu de service`,
        );
    } catch (e) {
      this.log.error(`Chargement des référentiels : ${(e as Error).message}`);
    }
  }

  /**
   * Base chargée avant l'arrivée des types de matières (24/10/2026) : la liste est ajoutée une fois,
   * et le type des matières reprises est écrit avec la bonne orthographe.
   */
  /** Orthographe des niveaux repris de l'ancien système (« Sixiéme » : les classes en prennent le nom). */
  private async corrigerNiveaux() {
    for (const [code, faux, juste] of [
      ['6EME', 'Sixiéme', 'Sixième'],
      ['5EME', 'Cinquiéme', 'Cinquième'],
    ])
      await this.refs.query(
        `UPDATE referentiel SET libelle = $3, "libelleNormalise" = $4 WHERE type = 'NIVEAU' AND code = $1 AND libelle = $2`,
        [code, faux, juste, normaliser(juste)],
      );
  }

  /**
   * Postes repris de l'ancien système (DG, 28/10/2026) : « Chef de Sécratariat … » s'écrit
   * « Chef de Secrétariat … ». Le code ne change pas : ce qui le cite reste valable.
   */
  private async corrigerPostes() {
    for (const [code, juste] of [
      ['CHEFDESECRATARIATDEPARTEMENTAL', 'Chef de Secrétariat départemental'],
      [
        'CHEFDESECRATARIATDIRECTIONCENTRALE',
        'Chef de Secrétariat de Direction centrale',
      ],
      [
        'CHEFDESECRATARIATDIRECTIONGENERALE',
        'Chef de Secrétariat de Direction générale',
      ],
    ])
      await this.refs.query(
        `UPDATE referentiel SET libelle = $2, "libelleNormalise" = $3
          WHERE type = 'POSTE' AND code = $1 AND libelle <> $2`,
        [code, juste, normaliser(juste)],
      );
  }

  private async assurerTypesMatiere() {
    if (await this.refs.exist({ where: { type: 'TYPE_MATIERE' } })) return;
    await this.refs.save(
      TYPES_MATIERE_ANCIENS.map((t, i) =>
        this.refs.create({
          type: 'TYPE_MATIERE',
          code: t.code,
          libelle: t.libelle,
          libelleNormalise: normaliser(t.libelle),
          donnees: { description: t.description },
          source: 'ANCIEN_SYSTEME',
          ordre: i,
        }),
      ),
    );
    for (const [faux, juste] of Object.entries(TYPE_MATIERE_CORRIGE))
      await this.refs.query(
        `UPDATE referentiel SET donnees = jsonb_set(donnees, '{type}', to_jsonb($2::text))
          WHERE type = 'MATIERE' AND donnees->>'type' = $1`,
        [faux, juste],
      );
    this.log.log('Types de matières ajoutés aux référentiels');
  }

  /* ------------------------------ Choix dans une liste ------------------------------ */

  private suggestionsCache = new Map<string, { a: number; l: OptionChoix[] }>();

  /**
   * Suggestions des rubriques de la fiche du personnel (DG, 30/10/2026) : on propose, on n'oblige pas.
   * Grades : ceux des règles (grades de départ) et ceux écrits sur au moins 3 fiches ; catégories et
   * échelles : les référentiels ; échelons : 1 à 16 puis HC 1 à HC 4 ; lieux de naissance : villes,
   * communes et districts du Congo ; spécialités : séries du baccalauréat et celles déjà écrites.
   * `null` : pas une liste de la fiche.
   */
  private async suggestionsFiche(liste: string): Promise<OptionChoix[] | null> {
    const LISTES = [
      'GRADE',
      'CATEGORIE',
      'ECHELLE',
      'ECHELON',
      'LIEU_NAISSANCE',
      'NATIONALITE',
      'SPECIALITE',
    ];
    if (!LISTES.includes(liste)) return null;
    const deja = this.suggestionsCache.get(liste);
    if (deja && Date.now() - deja.a < 10 * 60_000) return deja.l;
    const uniques = (l: OptionChoix[]) =>
      l.filter(
        (o, i) =>
          o.libelle.trim() &&
          l.findIndex(
            (x) => cleCompacte(x.libelle) === cleCompacte(o.libelle),
          ) === i,
      );
    let l: OptionChoix[] = [];
    if (liste === 'NATIONALITE')
      l = [{ valeur: 'Congolaise', libelle: 'Congolaise' }];
    else if (liste === 'ECHELON')
      l = [
        ...Array.from({ length: 16 }, (_, i) => String(i + 1)),
        ...Array.from({ length: 4 }, (_, i) => `HC ${i + 1}`),
      ].map((v) => ({
        valeur: v,
        libelle: v,
        detail: v.startsWith('HC') ? 'hors classe' : undefined,
      }));
    else if (liste === 'CATEGORIE' || liste === 'ECHELLE')
      l = (
        await this.refs.find({
          where: {
            type: liste === 'CATEGORIE' ? 'CATEGORIE_AGENT' : 'ECHELLE',
            actif: true,
          },
          order: { ordre: 'ASC', code: 'ASC' },
        })
      ).map((r) => ({ valeur: r.code, libelle: r.libelle }));
    else if (liste === 'LIEU_NAISSANCE')
      l = uniques(
        (
          await this.refs.query<{ libelle: string; t: string | null }[]>(
            `SELECT libelle, donnees->>'typeLocalite' AS t FROM referentiel
              WHERE type IN ('VILLE', 'LOCALITE') AND actif
                AND coalesce(donnees->>'typeLocalite', '') <> 'ARRONDISSEMENT'
              ORDER BY (type = 'VILLE') DESC, libelle`,
          )
        ).map((r) => ({
          valeur: r.libelle,
          libelle: r.libelle,
          detail:
            r.t === 'DISTRICT'
              ? 'district'
              : r.t === 'COMMUNE'
                ? 'commune'
                : 'ville',
        })),
      );
    else if (liste === 'GRADE')
      l = uniques([
        ...(
          await this.refs.query<{ g: string }[]>(
            `SELECT DISTINCT "gradeLibelle" AS g FROM regle_diplome WHERE "gradeLibelle" IS NOT NULL`,
          )
        ).map((r) => ({ valeur: r.g, libelle: r.g })),
        ...(
          await this.refs.query<{ g: string }[]>(
            `SELECT donnees->>'GRADE' AS g FROM agent_recense
              WHERE coalesce(donnees->>'GRADE', '') <> ''
              GROUP BY 1 HAVING count(*) >= 3 ORDER BY count(*) DESC`,
          )
        ).map((r) => ({ valeur: r.g, libelle: r.g })),
      ]);
    else if (liste === 'SPECIALITE')
      l = uniques([
        ...[
          'A',
          'A4',
          'B',
          'C',
          'D',
          'E',
          'F1',
          'F2',
          'F3',
          'F4',
          'G1',
          'G2',
          'G3',
          'H',
        ].map((x) => ({ valeur: `Série ${x}`, libelle: `Série ${x}` })),
        ...(
          await this.refs.query<{ g: string }[]>(
            `SELECT x->>'SPECIALITE' AS g FROM agent_recense a,
                    jsonb_array_elements(CASE WHEN jsonb_typeof(a.donnees->'AUTRES_DIPLOMES') = 'array' THEN a.donnees->'AUTRES_DIPLOMES' ELSE '[]'::jsonb END) x
              WHERE jsonb_typeof(x) = 'object' AND coalesce(x->>'SPECIALITE', '') <> ''
              GROUP BY 1 HAVING count(*) >= 3 ORDER BY count(*) DESC LIMIT 200`,
          )
        ).map((r) => ({ valeur: r.g, libelle: r.g })),
      ]);
    this.suggestionsCache.set(liste, { a: Date.now(), l });
    return l;
  }

  /**
   * Valeurs proposées dans un champ « à choisir » : les écoles, inspections et structures viennent
   * de l'organigramme, le reste des référentiels. Recherche sur tous les mots tapés.
   */
  async options(
    liste: string,
    q?: string,
    departementId?: number,
    limite = 30,
  ): Promise<OptionChoix[]> {
    const mots = normaliser(q ?? '')
      .split(/[\s'’-]+/)
      .filter((m) => m.length >= 1)
      .slice(0, 6);
    const n = Math.min(Math.max(limite, 1), 100);
    const suggestions = await this.suggestionsFiche(liste);
    if (suggestions) {
      // Le début d'un mot suffit (« Dol » → Dolisie) ; les échelons, du début seulement (« 1 » → 1, 10…)
      const debut = (t: string) =>
        liste === 'ECHELON'
          ? normaliser(t).startsWith(mots.join(' '))
          : mots.every((m) =>
              normaliser(t)
                .split(/[\s'’().-]+/)
                .some((x) => x.startsWith(m)),
            );
      return suggestions
        .filter((o) => !mots.length || debut(`${o.libelle} ${o.valeur}`))
        .slice(0, n);
    }
    if (['ETABLISSEMENT', 'INSPECTION', 'STRUCTURE'].includes(liste)) {
      const types =
        liste === 'ETABLISSEMENT'
          ? ['ETABLISSEMENT']
          : liste === 'INSPECTION'
            ? ['INSPECTION']
            : [
                'DDEPPSA',
                'INSPECTION',
                'SERVICE',
                'DIRECTION_CENTRALE',
                'DIRECTION_GENERALE',
              ];
      const params: unknown[] = [types];
      const conds = [`s.type = ANY($1)`, `s.actif`];
      for (const m of mots) {
        params.push(`%${m}%`);
        conds.push(
          `${SQL_SANS_ACCENTS("s.nom || ' ' || s.sigle || ' ' || coalesce(s.localite, '')")} LIKE $${params.length}`,
        );
      }
      if (departementId) {
        params.push(departementId);
        conds.push(`s."departementId" = $${params.length}`);
      }
      const lignes = await this.structures.query<
        {
          nom: string;
          cycle: string | null;
          localite: string | null;
          parent: string | null;
          dep: string | null;
        }[]
      >(
        `SELECT s.nom, s.cycle, s.localite, p.sigle AS parent, d.nom AS dep
           FROM structure s
           LEFT JOIN structure p ON p.id = s."parentId"
           LEFT JOIN departement d ON d.id = s."departementId"
          WHERE ${conds.join(' AND ')}
          ORDER BY s.nom LIMIT ${n}`,
        params,
      );
      return lignes.map((l) => ({
        valeur: l.nom,
        libelle: l.nom,
        detail: [majuscule(l.cycle ?? ''), l.parent, l.localite, l.dep]
          .filter(Boolean)
          .join(' · '),
      }));
    }
    const types = liste === 'LOCALITE' ? ['LOCALITE', 'VILLE'] : [liste];
    const params: unknown[] = [types];
    const conds = [`r.type = ANY($1)`, `r.actif`];
    for (const m of mots) {
      params.push(`%${m}%`);
      conds.push(`r."libelleNormalise" LIKE $${params.length}`);
    }
    if (departementId && liste === 'LOCALITE') {
      params.push(departementId);
      conds.push(
        `(r."departementId" = $${params.length} OR r."departementId" IS NULL)`,
      );
    }
    const lignes = await this.refs.query<
      { libelle: string; parents: string[]; dep: string | null }[]
    >(
      // Une matière enseignée dans plusieurs cycles n'est proposée qu'une fois
      `SELECT r.libelle, array_agg(DISTINCT coalesce(r.parent, '')) AS parents, max(d.nom) AS dep
         FROM referentiel r LEFT JOIN departement d ON d.id = r."departementId"
        WHERE ${conds.join(' AND ')}
        GROUP BY r.libelle ORDER BY min(r.ordre), r.libelle LIMIT ${n}`,
      params,
    );
    return lignes.map((l) => ({
      valeur: l.libelle,
      libelle: l.libelle,
      detail:
        // Le rattachement d'une localité est son département : ne pas l'afficher deux fois
        [
          l.dep,
          ...l.parents
            .filter((p) => p && cleCompacte(p) !== cleCompacte(l.dep ?? ''))
            .map(majuscule),
        ]
          .filter(Boolean)
          .join(' · ') || undefined,
    }));
  }

  /* ------------------------------ Administration ------------------------------ */

  async resume() {
    const parType = await this.refs.query<
      { type: string; n: number; actifs: number }[]
    >(
      `SELECT type, count(*)::int AS n, count(*) FILTER (WHERE actif)::int AS actifs FROM referentiel GROUP BY 1`,
    );
    const [org] = await this.structures.query<
      { ecoles: number; inspections: number; anciens: number }[]
    >(
      `SELECT count(*) FILTER (WHERE type = 'ETABLISSEMENT')::int AS ecoles,
              count(*) FILTER (WHERE type = 'INSPECTION')::int AS inspections,
              count(*) FILTER (WHERE code IS NOT NULL)::int AS anciens
         FROM structure`,
    );
    return {
      types: Object.entries(TYPES_REFERENTIEL).map(([code, t]) => ({
        code,
        ...t,
        n: parType.find((x) => x.type === code)?.n ?? 0,
        actifs: parType.find((x) => x.type === code)?.actifs ?? 0,
      })),
      organigramme: org,
      listes: LISTES_CHOIX,
    };
  }

  async liste(type: string, q?: string, parent?: string) {
    if (!TYPES_REFERENTIEL[type])
      throw new BadRequestException('Référentiel inconnu.');
    const qb = this.refs
      .createQueryBuilder('r')
      .where('r.type = :type', { type });
    for (const [i, m] of normaliser(q ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 6)
      .entries())
      qb.andWhere(
        `(r.libelleNormalise LIKE :m${i} OR upper(r.code) LIKE :m${i})`,
        {
          [`m${i}`]: `%${m}%`,
        },
      );
    if (parent) qb.andWhere('r.parent = :parent', { parent });
    return qb
      .orderBy('r.parent', 'ASC', 'NULLS FIRST')
      .addOrderBy('r.ordre', 'ASC')
      .addOrderBy('r.libelle', 'ASC')
      .take(2000)
      .getMany();
  }

  async enregistrer(
    u: UtilisateurConnecte,
    id: number | null,
    dto: {
      type: string;
      code?: string;
      libelle: string;
      parent?: string | null;
      departementId?: number | null;
      donnees?: Record<string, unknown>;
      actif?: boolean;
      ordre?: number;
    },
  ) {
    if (!TYPES_REFERENTIEL[dto.type])
      throw new BadRequestException('Référentiel inconnu.');
    const libelle = dto.libelle?.replace(/\s+/g, ' ').trim();
    if (!libelle) throw new BadRequestException('Écrivez le libellé.');
    const code =
      (dto.code?.trim() || cleCompacte(libelle)).toUpperCase().slice(0, 60) ||
      String(Date.now());
    const deja = await this.refs.findOne({ where: { type: dto.type, code } });
    if (deja && deja.id !== id)
      throw new BadRequestException(
        `Le code « ${code} » existe déjà dans ce référentiel (${deja.libelle}).`,
      );
    const valeurs = {
      type: dto.type,
      code,
      libelle,
      libelleNormalise: normaliser(libelle),
      parent: dto.parent?.trim() || null,
      departementId: dto.departementId ?? null,
      donnees: dto.donnees ?? {},
      actif: dto.actif ?? true,
      ordre: Number.isFinite(dto.ordre) ? Number(dto.ordre) : 0,
    };
    let r: Referentiel;
    if (id) {
      const ex = await this.refs.findOne({ where: { id } });
      if (!ex) throw new NotFoundException('Valeur introuvable');
      r = await this.refs.save({ ...ex, ...valeurs });
    } else r = await this.refs.save({ ...valeurs, source: 'SAISIE' });
    await this.journal.log(
      u,
      id ? 'REFERENTIEL_MODIFIE' : 'REFERENTIEL_AJOUTE',
      'referentiel',
      String(r.id),
      { type: r.type, libelle: r.libelle },
    );
    return r;
  }

  /* ------------------------------ Reprise de l'ancien système ------------------------------ */

  private lireFichiers() {
    const json = resolve(DOSSIER, 'referentiels.json');
    const csv = resolve(DOSSIER, 'structures.csv');
    if (!existsSync(json) || !existsSync(csv))
      throw new BadRequestException(
        'Les fichiers des référentiels de l’ancien système ne sont pas sur le serveur (dossier amorcage/referentiels).',
      );
    const ref = JSON.parse(readFileSync(json, 'utf8')) as Record<
      string,
      Record<string, unknown>[]
    >;
    const lignes = readFileSync(csv, 'utf8')
      .split(/\r?\n/)
      .slice(1)
      .filter(Boolean)
      .map((l) => {
        const [code, type, nom, superieure, departement, district, inspection] =
          l.split('|');
        return {
          code,
          type,
          nom,
          superieure,
          departement,
          district,
          inspection,
        };
      });
    return { ref, lignes };
  }

  /** Nom d'une localité, corrigé quand l'ancien système l'écrit de deux façons. */
  private localite(nom: string | null | undefined) {
    const t = (nom ?? '').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    return LOCALITE_CANONIQUE[cleCompacte(t)] ?? t;
  }

  /**
   * Reprise des référentiels de l'ancien système. Ne fait qu'ajouter : une valeur déjà présente
   * (même code) n'est pas modifiée, une école déjà dans l'organigramme reçoit seulement son code,
   * son cycle, son inspection et sa localité s'ils lui manquent.
   */
  async importerAncien(u: UtilisateurConnecte | null) {
    const { ref, lignes } = this.lireFichiers();
    const deps = await this.deps.find();
    const depParCode = new Map(deps.map((d) => [d.code, d]));
    const depDe = (nom: unknown, lieu?: string | null) => {
      const corrige = lieu ? DEPARTEMENT_CORRIGE[cleCompacte(lieu)] : undefined;
      const code = corrige ?? codeDepartement(nom);
      return code ? (depParCode.get(code) ?? null) : null;
    };
    const s = (v: unknown) =>
      typeof v === 'string'
        ? v.replace(/\s+/g, ' ').trim()
        : typeof v === 'number' || typeof v === 'boolean'
          ? String(v)
          : '';

    // 1. Valeurs des référentiels
    const valeurs: Partial<Referentiel>[] = [];
    const ajouter = (
      type: string,
      code: string,
      libelle: string,
      autres: Partial<Referentiel> = {},
    ) => {
      if (!libelle) return;
      valeurs.push({
        type,
        code: code.toUpperCase().slice(0, 60),
        libelle,
        libelleNormalise: normaliser(libelle),
        source: 'ANCIEN_SYSTEME',
        actif: true,
        ordre: 0,
        donnees: {},
        parent: null,
        departementId: null,
        ...autres,
      });
    };
    const vusLoc = new Set<string>();
    for (const d of ref.districts ?? []) {
      const nom = this.localite(s(d.name));
      if (!nom || vusLoc.has(cleCompacte(nom))) continue;
      vusLoc.add(cleCompacte(nom));
      const dep = depDe(d.department_name, nom);
      ajouter('LOCALITE', cleCompacte(nom), nom, {
        departementId: dep?.id ?? null,
        parent: dep?.code ?? null,
        donnees: {
          typeLocalite: /^COMMUN/i.test(nom)
            ? 'COMMUNE'
            : dep && VILLES_ARRONDISSEMENTS.includes(dep.code)
              ? 'ARRONDISSEMENT'
              : 'DISTRICT',
        },
      });
    }
    for (const v of ref.villes ?? []) {
      const nom = s(v.name);
      const dep = depDe(v.department_name, nom);
      ajouter('VILLE', cleCompacte(nom), nom, {
        departementId: dep?.id ?? null,
        parent: dep?.code ?? null,
      });
    }
    for (const c of ref.cycles ?? [])
      ajouter('CYCLE', s(c.designation), majuscule(s(c.designation)), {
        ordre: Number(c.level_min) || 0,
        donnees: {
          code: c.code,
          description: c.description,
          niveauMin: c.level_min,
          niveauMax: c.level_max,
          quotaDefaut: c.default_quota,
          plusieursMatieres: c.allows_multi_subject,
        },
      });
    for (const n of ref.niveaux ?? [])
      ajouter('NIVEAU', s(n.code), s(n.designation), {
        parent: s(n.cycle_designation),
        ordre: Number(n.display_order) || 0,
        donnees: { description: s(n.description) },
      });
    for (const m of ref.matieres ?? [])
      ajouter('MATIERE', s(m.code), s(m.designation), {
        parent: s(m.cycle_designation),
        donnees: {
          type:
            TYPE_MATIERE_CORRIGE[s(m.subject_type_designation)] ??
            s(m.subject_type_designation),
          specialiste: m.requires_specialist === true,
          description: s(m.description),
        },
      });
    const libMatiere = new Map(
      (ref.matieres ?? []).map((m) => [s(m.code), s(m.designation)]),
    );
    const libNiveau = new Map(
      (ref.niveaux ?? []).map((n) => [s(n.code), s(n.designation)]),
    );
    for (const p of ref.programmes ?? [])
      ajouter(
        'PROGRAMME',
        `${s(p.niveau_code)}|${s(p.matiere_code)}`,
        `${libNiveau.get(s(p.niveau_code)) ?? s(p.niveau_code)} · ${libMatiere.get(s(p.matiere_code)) ?? s(p.matiere_code)}`,
        {
          parent: s(p.cycle_designation),
          donnees: {
            niveau: s(p.niveau_code),
            matiere: s(p.matiere_code),
            heures: Number(p.quota_hour) || 0,
            coefficient: Number(p.coef) || 0,
          },
        },
      );
    for (const [i, t] of TYPES_MATIERE_ANCIENS.entries())
      ajouter('TYPE_MATIERE', t.code, t.libelle, {
        ordre: i,
        donnees: { description: t.description },
      });
    for (const [i, p] of (ref.postes ?? []).entries())
      ajouter('POSTE', cleCompacte(s(p.designation)), s(p.designation), {
        ordre: i,
      });
    for (const b of ref.types_batiments ?? [])
      ajouter('TYPE_BATIMENT', cleCompacte(s(b.designation)), s(b.designation));
    for (const b of ref.types_salles ?? [])
      ajouter('TYPE_SALLE', cleCompacte(s(b.designation)), s(b.designation));
    for (const t of ref.types_personnel ?? [])
      ajouter('TYPE_PERSONNEL', cleCompacte(s(t.libelle)), s(t.libelle), {
        donnees: { specialiteExigee: t.requires_speciality === true },
      });
    for (const c of ref.categories_agent ?? [])
      ajouter('CATEGORIE_AGENT', s(c.code), s(c.libelle), {
        donnees: { ageRetraite: c.age_retraite },
      });
    for (const e of ref.echelles ?? [])
      ajouter('ECHELLE', s(e.code), s(e.libelle), {
        donnees: {
          nombreEchelons: e.nombre_echelons,
          dureeEchelonMois: e.duree_echelon_mois,
        },
      });
    const existants = new Set(
      (await this.refs.find({ select: { type: true, code: true } })).map(
        (r) => `${r.type}|${r.code}`,
      ),
    );
    const nouvelles = valeurs.filter((v, i, t) => {
      const k = `${v.type}|${v.code}`;
      return (
        !existants.has(k) &&
        t.findIndex((x) => `${x.type}|${x.code}` === k) === i
      );
    });
    for (let i = 0; i < nouvelles.length; i += 500)
      await this.refs.save(
        nouvelles.slice(i, i + 500).map((v) => this.refs.create(v)),
      );

    // 2. Inspections et écoles dans l'organigramme
    const bilan = await this.importerStructures(lignes, depDe);
    const r = { valeurs: nouvelles.length, ...bilan };
    await this.journal.log(u, 'REFERENTIELS_IMPORT', 'referentiel', null, r);
    await this.rec.rattacherAutomatiquement();
    return r;
  }

  private async importerStructures(
    lignes: {
      code: string;
      type: string;
      nom: string;
      superieure: string;
      departement: string;
      district: string;
      inspection: string;
    }[],
    depDe: (nom: unknown, lieu?: string | null) => Departement | null,
  ) {
    const bilan = {
      inspections: { creees: 0, completees: 0 },
      ecoles: { creees: 0, completees: 0, renommees: 0 },
      centrale: { creees: 0, completees: 0 },
      ignorees: 0,
    };
    const tout = await this.structures.find();
    const parCode = new Map(
      tout.filter((x) => x.code).map((x) => [x.code!, x]),
    );
    const ddeppsa = new Map<number, Structure>();
    for (const x of tout)
      if (
        x.type === 'DDEPPSA' &&
        x.departementId &&
        !ddeppsa.has(x.departementId)
      )
        ddeppsa.set(x.departementId, x);
    const parNom = new Map<string, Structure>();
    for (const x of tout)
      parNom.set(`${x.type}|${x.departementId}|${cleCompacte(x.nom)}`, x);

    const typeLocalite = (dep: Departement | null, lieu: string | null) =>
      !lieu
        ? null
        : /^COMMUN/i.test(lieu)
          ? 'COMMUNE'
          : dep && VILLES_ARRONDISSEMENTS.includes(dep.code)
            ? 'ARRONDISSEMENT'
            : 'DISTRICT';
    const ecoles = lignes.filter((l) => CYCLE_ECOLE[l.type]);
    // Cycle d'une inspection : celui de toutes ses écoles s'il est unique
    const cyclesInsp = new Map<string, Set<string>>();
    for (const e of ecoles)
      cyclesInsp.set(
        e.superieure,
        new Set([...(cyclesInsp.get(e.superieure) ?? []), CYCLE_ECOLE[e.type]]),
      );

    const assurerDdeppsa = async (dep: Departement) => {
      let dd = ddeppsa.get(dep.id);
      if (!dd) {
        dd = await this.structures.save({
          type: 'DDEPPSA',
          nom: `Direction départementale de l’enseignement préscolaire, primaire, secondaire et de l’alphabétisation (${dep.nom})`,
          sigle: `DDEPPSA ${dep.nom}`,
          departementId: dep.id,
          actif: true,
          ordre: 0,
        });
        ddeppsa.set(dep.id, dd);
      }
      return dd;
    };

    // Inspections d'abord (les écoles s'y rattachent)
    const aSauver: Structure[] = [];
    // Département d'une inspection qui n'en a pas : celui de ses écoles
    const depEcoles = new Map<string, string>();
    for (const e of ecoles)
      if (e.departement && !depEcoles.has(e.superieure))
        depEcoles.set(e.superieure, e.departement);
    for (const l of lignes.filter((x) => x.type === 'INS')) {
      const lieu = this.localite(l.district);
      const dep = depDe(l.departement || depEcoles.get(l.code), lieu);
      if (!dep) {
        bilan.ignorees++;
        continue;
      }
      const cycles = cyclesInsp.get(l.code);
      const cycle = cycles?.size === 1 ? [...cycles][0] : null;
      const nom = l.nom.replace(/\s+/g, ' ').trim();
      let x =
        parCode.get(l.code) ??
        parNom.get(`INSPECTION|${dep.id}|${cleCompacte(nom)}`) ??
        parNom.get(`INSPECTION|${dep.id}|${cleCompacte(l.inspection)}`);
      if (!x) {
        const dd = await assurerDdeppsa(dep);
        x = this.structures.create({
          type: 'INSPECTION',
          nom,
          sigle: (l.inspection || nom).slice(0, 80),
          code: l.code,
          parentId: dd.id,
          departementId: dep.id,
          cycle,
          localite: lieu,
          typeLocalite: typeLocalite(dep, lieu),
          actif: true,
          ordre: 0,
        });
        bilan.inspections.creees++;
      } else {
        const avant = JSON.stringify([x.code, x.cycle, x.localite]);
        x.code ??= l.code;
        x.cycle ??= cycle;
        x.localite ??= lieu;
        x.typeLocalite ??= typeLocalite(dep, lieu);
        if (avant === JSON.stringify([x.code, x.cycle, x.localite])) continue;
        bilan.inspections.completees++;
      }
      aSauver.push(x);
    }
    for (const x of await this.structures.save(aSauver)) {
      parCode.set(x.code!, x);
      parNom.set(`INSPECTION|${x.departementId}|${cleCompacte(x.nom)}`, x);
    }

    const ecolesASauver: Structure[] = [];
    for (const l of ecoles) {
      const lieu = this.localite(l.district);
      const dep = depDe(l.departement, lieu);
      if (!dep) {
        bilan.ignorees++;
        continue;
      }
      const insp = parCode.get(l.superieure);
      const parent = insp ?? (await assurerDdeppsa(dep));
      const brut = l.nom.replace(/\s+/g, ' ').trim();
      const nom = nomEcole(brut);
      const cycle = CYCLE_ECOLE[l.type];
      let x =
        parCode.get(l.code) ??
        parNom.get(`ETABLISSEMENT|${dep.id}|${cleCompacte(nom)}`) ??
        parNom.get(`ETABLISSEMENT|${dep.id}|${cleCompacte(brut)}`);
      if (!x) {
        x = this.structures.create({
          type: 'ETABLISSEMENT',
          nom,
          sigle: nom.slice(0, 80),
          code: l.code,
          parentId: parent.id,
          departementId: dep.id,
          cycle,
          localite: lieu,
          typeLocalite: typeLocalite(dep, lieu),
          actif: true,
          ordre: 0,
        });
        bilan.ecoles.creees++;
      } else {
        const avant = JSON.stringify([
          x.code,
          x.cycle,
          x.localite,
          x.parentId,
          x.nom,
        ]);
        // Nom repris tel quel de l'ancien système : corrigé (une école renommée à la main ne bouge pas)
        if (x.nom === brut && nom !== brut) {
          if (x.sigle === brut.slice(0, 80)) x.sigle = nom.slice(0, 80);
          x.nom = nom;
          bilan.ecoles.renommees++;
        }
        x.code ??= l.code;
        x.cycle ??= cycle;
        x.localite ??= lieu;
        x.typeLocalite ??= typeLocalite(dep, lieu);
        if (!x.parentId || (insp && x.parentId === ddeppsa.get(dep.id)?.id))
          x.parentId = parent.id;
        if (
          avant ===
          JSON.stringify([x.code, x.cycle, x.localite, x.parentId, x.nom])
        )
          continue;
        bilan.ecoles.completees++;
      }
      parCode.set(l.code, x);
      ecolesASauver.push(x);
    }
    for (let i = 0; i < ecolesASauver.length; i += 500)
      await this.structures.save(ecolesASauver.slice(i, i + 500));
    bilan.centrale = await this.importerCentrale(lignes, parCode);
    return bilan;
  }

  /**
   * Administration centrale (organigramme du ministère) : ministère, cabinet, directions générales,
   * inspection générale, directions centrales, services et bureaux, chacun sous sa structure
   * supérieure. Sous la DGRHAS, ce sont les types du circuit interne. Une structure qui existe déjà
   * (même code, même sigle ou même nom) n'est que complétée.
   */
  private async importerCentrale(
    lignes: { code: string; type: string; nom: string; superieure: string }[],
    parCode: Map<string, Structure>,
  ) {
    const bilan = { creees: 0, completees: 0 };
    const centrales = lignes.filter(
      (l) =>
        l.type in TYPE_CENTRAL &&
        l.code &&
        // « Centre d'Alphabétisation 1977-03-18 » : une école mal rangée
        !/^(ALP|PRI|COL|LYC|PRE)-/.test(l.code),
    );
    const parLigne = new Map(centrales.map((l) => [l.code, l]));
    const superieure = (l: { superieure: string }) =>
      CODE_CORRIGE[l.superieure] ?? l.superieure;
    const sousDgrhas = (l: (typeof centrales)[number]) => {
      const vus = new Set<string>();
      for (let x = l; x && !vus.has(x.code); x = parLigne.get(superieure(x))!) {
        vus.add(x.code);
        if (x.code === 'DGRHAS') return x !== l;
      }
      return false;
    };
    const typeDe = (l: (typeof centrales)[number]) => {
      let t = TYPE_CENTRAL[l.type];
      if (l.code === 'DGRHAS') return 'DGRHAS';
      if (['DC', ''].includes(l.type))
        t = /^bureau/i.test(l.nom)
          ? 'BUREAU'
          : /^service/i.test(l.nom)
            ? 'SERVICE'
            : 'DIRECTION_CENTRALE';
      return sousDgrhas(l) ? (TYPE_DGRHAS[t] ?? t) : t;
    };
    const niveau = (l: (typeof centrales)[number]) =>
      TYPES_STRUCTURE_NIVEAU[typeDe(l)] ?? 9;
    const tout = await this.structures.find({
      where: { type: In(Object.keys(TYPES_STRUCTURE_NIVEAU)) },
    });
    const trouver = (l: (typeof centrales)[number], type: string) =>
      parCode.get(l.code) ??
      tout.find(
        (x) =>
          x.type === type &&
          (cleCompacte(x.sigle) === cleCompacte(l.code) ||
            cleCompacte(x.nom) === cleCompacte(l.nom)),
      );
    // Les supérieures d'abord
    for (const l of [...centrales].sort((a, b) => niveau(a) - niveau(b))) {
      const type = typeDe(l);
      const nom = l.nom.replace(/\s+/g, ' ').replace(/\.$/, '').trim();
      const parent = parCode.get(superieure(l)) ?? null;
      let x = trouver(l, type);
      if (!x) {
        x = await this.structures.save(
          this.structures.create({
            type,
            nom,
            sigle: l.code.slice(0, 80),
            code: l.code,
            parentId: parent?.id ?? null,
            actif: true,
            ordre: 0,
          }),
        );
        bilan.creees++;
      } else {
        const provisoire = /intitulé à compléter/i.test(x.nom);
        if (
          !x.code ||
          provisoire ||
          (!x.parentId && parent && parent.id !== x.id)
        ) {
          x.code ??= l.code;
          // « Direction DFC (intitulé à compléter) » → le vrai nom de l'ancien système
          if (provisoire) x.nom = nom;
          if (!x.parentId && parent && parent.id !== x.id)
            x.parentId = parent.id;
          x = await this.structures.save(x);
          bilan.completees++;
        }
      }
      parCode.set(l.code, x);
    }
    return bilan;
  }
}
