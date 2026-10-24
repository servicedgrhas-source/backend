import { BeneficiairesService } from '../pilotage/beneficiaires.service';
import { AnomaliesService } from '../common/anomalies';
import { ComplementsService } from '../dossiers/complements.service';
import { libelleLot } from '../common/lots';
import ExcelJS from 'exceljs';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, IsNull, Not, Repository } from 'typeorm';
import { estContractuel, salaireBrut } from '../affectation/calcul';
import { AffectationService } from '../affectation/affectation.service';
import type { UtilisateurConnecte } from '../auth/auth';
import { champ, lireClasseur } from '../common/excel';
import {
  codeDepartement,
  LIBELLE_CYCLE,
  reconnaitreDiplome,
  type Cycle,
} from '../common/referentiels';
import {
  ageRevolu,
  cleCompacte,
  lireDate,
  nettoyer,
  normaliser,
  romainVersEntier,
} from '../common/texte';
import { motsDuNom, ressemblance } from '../common/ressemblance';
import { JournalService, ParametresService } from '../core/core.service';
import {
  Agent,
  Departement,
  MembreCommission,
  RegleDiplome,
} from '../entities';

export interface CandidatDto {
  feuille: 'MEPPSA' | 'QUOTA_AUTRES';
  quota?: number | null;
  numeroOrdre?: number | null;
  nomComplet: string;
  dateNaissance: string;
  dateDepot?: string | null;
  lieuNaissance?: string | null;
  diplomeCode: string;
  departementId?: number | null;
  source?: string | null;
  lotCommission?: string | null;
  lotNature?: 'VOLONTAIRE' | 'COMMUNAUTAIRE' | 'MIXTE' | null;
  membreCommissionId?: string | null;
  statut?: string | null;
  lieuServiceBrut?: string | null;
  origineBrute?: string | null;
  observation?: string | null;
  forcerDoublon?: boolean;
  /** Fiche de la base du personnel choisie (volontaire ou communautaire). */
  agentRecenseId?: number | null;
}

export type EtatListe =
  'A_CONTROLER' | 'CONTROLEE' | 'VALIDEE' | 'TRANSMISE' | 'CONTENTIEUX';

/** Rôles qui saisissent seulement (ils ne modifient plus une fiche contrôlée). */
const ROLES_SAISIE_SEULE = ['AGENT'];
/** Première année de quota acceptée (reprise des anciens recrutements). */
const PREMIER_QUOTA = 2015;
/**
 * Dernière année de quota acceptée : l'année prochaine, plus une (un dossier « mis à part
 * pour le quota suivant » peut partir deux ans plus loin).
 */
const dernierQuota = () => new Date().getUTCFullYear() + 2;

function nomPropre(v: string) {
  return v.replace(/\s+/g, ' ').trim();
}

function texteOuNull(v?: string | null) {
  const t = v?.replace(/\s+/g, ' ').trim();
  return t ? t : null;
}

function entier(v: unknown): number | null {
  const n = Number(typeof v === 'string' ? v.trim() : v);
  return v !== null && v !== '' && Number.isFinite(n) ? Math.trunc(n) : null;
}

/** « L2 », « lot 2 », « LII » -> « Lot 2 » ; « unique » -> « Lot unique ». */
export function lotCommissionNormalise(v: unknown): string | null {
  const s = nettoyer(v);
  if (!s) return null;
  const k = cleCompacte(s);
  if (k.includes('UNIQUE')) return 'Lot unique';
  const m = k.match(/^L(?:OT)?(?:N)?([IVX]+|\d+)$/);
  if (m) return `Lot ${romainVersEntier(m[1]) ?? Number(m[1])}`;
  return s;
}

export type NatureLot = 'VOLONTAIRE' | 'COMMUNAUTAIRE' | 'MIXTE';

/** Nature du lot d'une fiche (les fiches anciennes : d'après le statut). */
export function natureLot(a: Pick<Agent, 'lotNature' | 'statut'>): NatureLot {
  if (a.lotNature) return a.lotNature;
  return /^volon/i.test(a.statut ?? '') ? 'VOLONTAIRE' : 'COMMUNAUTAIRE';
}

/** Cycle d'une fiche, en clé (« PRIMAIRE », « COLLEGE »…). */
function cleCycle(
  a: Pick<Agent, 'cycleBrut'>,
  regle?: { cycle: string } | null,
) {
  return regle?.cycle ?? cleCompacte(a.cycleBrut ?? '');
}

/** « 1ère transmission », « 2ème transmission »… */
export function libelleTransmission(n: number) {
  return `${n === 1 ? '1ère' : `${n}ème`} transmission`;
}

const aujourdhui = () => new Date().toISOString().slice(0, 10);

@Injectable()
export class CandidatsService implements OnApplicationBootstrap {
  constructor(
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
    @InjectRepository(RegleDiplome)
    private readonly regles: Repository<RegleDiplome>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    @InjectRepository(MembreCommission)
    private readonly membres: Repository<MembreCommission>,
    private readonly affectation: AffectationService,
    private readonly params: ParametresService,
    private readonly complements: ComplementsService,
    private readonly anomalies: AnomaliesService,
    private readonly journal: JournalService,
    private readonly beneficiaires: BeneficiairesService,
  ) {}

  /** N° de transmission des lignes importées avant cette version (« 2ème transmission » -> 2). */
  async onApplicationBootstrap() {
    await this.agents.query(`
      UPDATE agent SET "transmissionNumero" = substring(transmission from '^[0-9]+')::int
      WHERE "transmissionNumero" IS NULL AND transmission ~ '^[0-9]+'`);
    // Fiches envoyées avant l'étape de validation du DG : elles sont considérées validées
    await this.agents.query(`
      UPDATE agent SET "etatFiche" = 'VALIDEE'
      WHERE "origineFiche" = 'SAISIE' AND "etatFiche" = 'CONTROLEE'
        AND "transmissionNumero" IS NOT NULL AND NOT rectifiee`);
  }

  private nombre(cle: string, defaut: number) {
    return Number(this.params.get(cle)) || defaut;
  }

  /* ------------------------------ Lecture ----------------------------- */

  async liste(etat: EtatListe, recherche?: string, quota?: number) {
    const q = this.agents
      .createQueryBuilder('a')
      .leftJoinAndSelect('a.departement', 'd')
      .leftJoinAndSelect('a.lotPublication', 'l')
      .where("a.origineFiche = 'SAISIE'")
      // Le quota « Autres » n'est pas saisi ici : il vient des textes de la FP
      .andWhere("a.feuille = 'MEPPSA'")
      .orderBy('a.creeLe', 'DESC')
      // Un quota précis (choix des dossiers à mettre à part) : toutes ses fiches
      .take(quota ? 10000 : 500);
    if (quota) q.andWhere('a.quota = :quota', { quota });
    if (etat === 'CONTENTIEUX')
      q.andWhere("a.contentieuxAge IN ('EN_ATTENTE', 'REJETE')");
    else {
      q.andWhere("(a.contentieuxAge IS NULL OR a.contentieuxAge = 'APPROUVE')");
      if (etat === 'TRANSMISE') q.andWhere('a.transmissionNumero IS NOT NULL');
      else {
        q.andWhere('a.etatFiche = :e', { e: etat });
        // Une fiche validée qui est déjà partie apparaît dans « Envoyées »
        if (etat === 'VALIDEE') q.andWhere('a.transmissionNumero IS NULL');
      }
    }
    if (recherche?.trim())
      q.andWhere('a.nomNormalise LIKE :r', {
        r: `%${normaliser(recherche)}%`,
      });
    return this.enrichir(await q.getMany());
  }

  async compteurs() {
    const [r] = await this.agents.query<Record<string, number>[]>(`
      SELECT
        count(*) FILTER (WHERE "etatFiche" = 'A_CONTROLER' AND ok)::int AS "aControler",
        count(*) FILTER (WHERE "etatFiche" = 'CONTROLEE' AND ok)::int AS "controlees",
        count(*) FILTER (WHERE "etatFiche" = 'VALIDEE' AND "transmissionNumero" IS NULL AND ok)::int AS "validees",
        count(*) FILTER (WHERE "transmissionNumero" IS NOT NULL AND ok)::int AS "transmises",
        count(*) FILTER (WHERE "contentieuxAge" = 'EN_ATTENTE')::int AS "contentieux"
      FROM (SELECT *, ("contentieuxAge" IS NULL OR "contentieuxAge" = 'APPROUVE') AS ok
            FROM agent WHERE "origineFiche" = 'SAISIE' AND feuille = 'MEPPSA') a`);
    return r;
  }

  private async enrichir(liste: Agent[]) {
    const regles = await this.affectation.reglesParCode();
    const p = this.affectation.parametresCalcul();
    return liste.map((a) => {
      const r = a.diplomeCode ? regles.get(a.diplomeCode) : undefined;
      return {
        ...a,
        ...estContractuel(a, p, r?.categorie),
        cycle: r ? LIBELLE_CYCLE[r.cycle as Cycle] : null,
        grade: r?.grade ?? null,
        categorie: r?.categorie ?? null,
        echelle: r?.echelle ?? null,
        indice: r?.indice ?? null,
        salaireBrut: salaireBrut(r?.indice, p),
        ageAuDepot:
          a.dateNaissance && a.dateDepot
            ? ageRevolu(a.dateNaissance, a.dateDepot)
            : null,
      };
    });
  }

  /* ---------------------- Base du personnel et vagues ---------------------- */

  /**
   * Recherche dans la base du personnel des volontaires et communautaires à présenter : la commission
   * choisit la personne au lieu de la ressaisir (nom, naissance, diplôme, département, vague).
   */
  async personnel(recherche?: string) {
    const mots = normaliser(recherche ?? '')
      .split(/\s+/)
      .filter((m) => m.length >= 2)
      .slice(0, 5);
    if (!mots.length) return [];
    const lignes = await this.agents.query<
      {
        id: number;
        numeroFiche: string;
        statut: string;
        nomComplet: string;
        dateNaissance: string | null;
        lieuNaissance: string | null;
        diplome: string | null;
        departementId: number | null;
        lieuService: string | null;
        vague: number | null;
        registre: string | null;
        candidat: string | null;
      }[]
    >(
      `SELECT a.id, a."numeroFiche", a.statut, a."nomComplet", to_char(a."dateNaissance", 'YYYY-MM-DD') AS "dateNaissance",
              a.donnees->>'LIEU_NAISSANCE' AS "lieuNaissance", coalesce(a.donnees->>'DIPLOME_PRO', v.diplome) AS diplome,
              a."departementId", a.donnees->>'LIEU_SERVICE' AS "lieuService", v."vagueNumero" AS vague, v.statut AS registre,
              (SELECT g."nomComplet" || ' (quota ' || coalesce(g.quota::text, '?') || ')' FROM agent g WHERE g."agentRecenseId" = a.id LIMIT 1) AS candidat
         FROM agent_recense a LEFT JOIN volontaire v ON v.id = a."volontaireId"
        WHERE ${mots.map((_, i) => `a."nomNormalise" LIKE $${i + 1}`).join(' AND ')}
          AND (a.contentieux IS NULL OR a.contentieux->>'etat' <> 'REJETE')
        ORDER BY a."nomNormalise" LIMIT 30`,
      mots.map((m) => `%${m}%`),
    );
    const regles = await this.regles.find();
    const diplomeCode = (d: string | null) => {
      const k = cleCompacte(d);
      if (!k) return null;
      return (
        (
          regles.find((r) => cleCompacte(r.code) === k) ??
          regles.find((r) => cleCompacte(r.libelle) === k) ??
          regles.find((r) => k.startsWith(cleCompacte(r.code)))
        )?.code ?? null
      );
    };
    return lignes.map((l) => ({
      ...l,
      diplomeCode: diplomeCode(l.diplome),
      // Seuls les volontaires et communautaires passent par la commission
      presentable: ['VOLONTAIRE', 'COMMUNAUTAIRE'].includes(l.statut),
    }));
  }

  /** Fiche du personnel liée au candidat : statut (Volontaire / Communautaire) et vague. */
  private async liaisonPersonnel(dto: CandidatDto, ex?: Agent) {
    const id =
      dto.agentRecenseId === undefined
        ? ex?.agentRecenseId
        : dto.agentRecenseId;
    if (!id) {
      // Un volontaire est forcément dans la base dès qu'elle contient des volontaires
      // (seulement pour une nouvelle fiche ou un statut changé : les fiches déjà saisies restent modifiables)
      if (
        /^volon/i.test(dto.statut ?? '') &&
        (!ex || !/^volon/i.test(ex.statut ?? ''))
      ) {
        const [{ n }] = await this.agents.query<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM agent_recense WHERE statut = 'VOLONTAIRE'`,
        );
        if (n > 0)
          throw new BadRequestException(
            'Un volontaire est déjà dans la base du personnel : cherchez-le et choisissez-le (« Chercher dans la base »). Une personne absente de la base est enregistrée comme communautaire.',
          );
      }
      return null;
    }
    const [f] = await this.agents.query<
      {
        id: number;
        statut: string;
        nomComplet: string;
        numeroFiche: string;
        vague: number | null;
      }[]
    >(
      `SELECT a.id, a.statut, a."nomComplet", a."numeroFiche", v."vagueNumero" AS vague
         FROM agent_recense a LEFT JOIN volontaire v ON v.id = a."volontaireId" WHERE a.id = $1`,
      [id],
    );
    if (!f) throw new BadRequestException('Fiche du personnel introuvable.');
    if (!['VOLONTAIRE', 'COMMUNAUTAIRE'].includes(f.statut))
      throw new BadRequestException(
        `${f.nomComplet} (${f.numeroFiche}) est déjà agent de l’État (${f.statut.toLowerCase()}) : il ne passe plus par la commission.`,
      );
    const autre = await this.agents.findOne({
      where: { agentRecenseId: f.id },
      loadEagerRelations: false,
    });
    if (autre && autre.id !== ex?.id)
      throw new BadRequestException(
        `${f.nomComplet} a déjà un dossier de candidat (quota ${autre.quota ?? '?'}, n° ${autre.numeroOrdre ?? '?'}).`,
      );
    return {
      id: f.id,
      statut: f.statut === 'VOLONTAIRE' ? 'Volontaire' : 'Communautaire',
      vague: f.vague,
    };
  }

  /**
   * Volontaires en poste par vague, et ceux déjà présentés : on recrute d'abord les anciennes
   * vagues (DG, 23/10/2026).
   */
  async vagues(quota: number | null) {
    return this.agents.query<
      {
        vague: number | null;
        enPoste: number;
        presentes: number;
        presentesQuota: number;
      }[]
    >(
      `SELECT v."vagueNumero" AS vague,
              count(*) FILTER (WHERE v.statut = 'EN_POSTE')::int AS "enPoste",
              count(g.id)::int AS presentes,
              count(g.id) FILTER (WHERE g.quota = $1)::int AS "presentesQuota"
         FROM volontaire v
         LEFT JOIN agent_recense a ON a."volontaireId" = v.id
         LEFT JOIN agent g ON g."agentRecenseId" = a.id
        WHERE v.population = 'VOLONTAIRE' AND (v.statut = 'EN_POSTE' OR g.id IS NOT NULL)
        GROUP BY 1 ORDER BY 1 NULLS LAST`,
      [quota],
    );
  }

  /** Avertissement : un volontaire d'une vague récente passe avant des volontaires de vagues plus anciennes. */
  private async avertissementVague(vague: number | null, quota: number | null) {
    if (!vague) return null;
    const [{ n, plusAncienne }] = await this.agents.query<
      { n: number; plusAncienne: number | null }[]
    >(
      `SELECT count(*)::int AS n, min(v."vagueNumero") AS "plusAncienne"
         FROM volontaire v LEFT JOIN agent_recense a ON a."volontaireId" = v.id
        WHERE v.population = 'VOLONTAIRE' AND v.statut = 'EN_POSTE' AND v."vagueNumero" BETWEEN 1 AND $1 - 1
          AND NOT EXISTS (SELECT 1 FROM agent g WHERE g."agentRecenseId" = a.id)`,
      [vague],
    );
    if (!n) return null;
    return `Volontaire de la ${vague}e vague : ${n} volontaire(s) en poste de vagues plus anciennes (dès la ${plusAncienne === 1 ? '1re' : `${plusAncienne}e`}) ne sont pas encore présentés${quota ? ` (quota ${quota})` : ''}. Les anciennes vagues passent d’abord.`;
  }

  /** Prochain n° d'ordre libre dans un quota (liste du MEPPSA). */
  async prochainNumero(feuille: string, quota: number | null) {
    const [r] = await this.agents.query<{ n: number | null }[]>(
      `SELECT max("numeroOrdre")::int AS n FROM agent
       WHERE feuille = $1 AND ($2::int IS NULL OR quota = $2)`,
      [feuille, quota],
    );
    return (r?.n ?? 0) + 1;
  }

  /**
   * Lots de la commission où ce candidat peut aller, avec leur remplissage.
   * - Lot de volontaires : un seul diplôme (quota + diplôme), numérotation propre.
   * - Lot de communautaires : tous les diplômes du cycle (quota + cycle).
   * - Lot mixte : volontaires et communautaires du cycle ; il partage la numérotation
   *   des communautaires du même cycle.
   */
  async lots(
    quota: number | null,
    statut: string | null,
    diplomeCode: string | null,
    exclure?: string,
    feuille = 'MEPPSA',
  ) {
    const taille = this.nombre('TAILLE_LOT_COMMISSION', 50);
    const regle = diplomeCode
      ? await this.regles.findOne({ where: { code: diplomeCode } })
      : null;
    const cycle = regle?.cycle ?? null;
    const volontaire = /^volon/i.test(statut ?? '');
    const rangs = await this.agents.query<
      {
        lot: string;
        nature: string | null;
        statut: string | null;
        diplome: string | null;
        cycle: string | null;
        n: number;
      }[]
    >(
      `SELECT a."lotCommission" AS lot, a."lotNature" AS nature, a.statut,
         a."diplomeCode" AS diplome, coalesce(r.cycle, upper(a."cycleBrut")) AS cycle,
         count(*)::int AS n
       FROM agent a LEFT JOIN regle_diplome r ON r.code = a."diplomeCode"
       WHERE a.feuille = $2 AND a.quota IS NOT DISTINCT FROM $1
         AND a."lotCommission" IS NOT NULL AND ($3::uuid IS NULL OR a.id <> $3)
       GROUP BY 1, 2, 3, 4, 5`,
      [quota, feuille, exclure ?? null],
    );
    const num = (l: string) => Number(l.match(/^Lot (\d+)$/)?.[1] ?? 0);
    // Regroupement par lot réel
    const parLot = new Map<
      string,
      {
        lot: string;
        nature: NatureLot;
        n: number;
        volontaires: number;
        communautaires: number;
      }
    >();
    const groupeVolontaire = (r: (typeof rangs)[number]) =>
      natureLot({
        lotNature: r.nature as NatureLot | null,
        statut: r.statut,
      }) === 'VOLONTAIRE';
    for (const r of rangs) {
      if (!num(r.lot)) continue;
      const nature = natureLot({
        lotNature: r.nature as NatureLot | null,
        statut: r.statut,
      });
      // Lots de volontaires de CE diplôme ; lots communautaires et mixtes de CE cycle
      const concerne = groupeVolontaire(r)
        ? r.diplome === diplomeCode
        : !!cycle &&
          (r.cycle === cycle ||
            cleCompacte(r.cycle ?? '') === cleCompacte(cycle));
      if (!concerne) continue;
      const cle = `${nature === 'VOLONTAIRE' ? 'V' : 'C'}|${r.lot}`;
      const e = parLot.get(cle) ?? {
        lot: r.lot,
        nature,
        n: 0,
        volontaires: 0,
        communautaires: 0,
      };
      // Un lot qui reçoit des deux statuts est mixte
      if (nature === 'MIXTE') e.nature = 'MIXTE';
      e.n += r.n;
      if (/^volon/i.test(r.statut ?? '')) e.volontaires += r.n;
      else e.communautaires += r.n;
      parLot.set(cle, e);
    }
    const tous = [...parLot.values()].sort((a, b) => num(a.lot) - num(b.lot));
    // Lots où CE candidat peut aller
    const possibles = tous.filter((l) =>
      l.nature === 'MIXTE'
        ? true
        : volontaire
          ? l.nature === 'VOLONTAIRE'
          : l.nature === 'COMMUNAUTAIRE',
    );
    const suivant = (pred: (l: (typeof tous)[number]) => boolean) =>
      `Lot ${Math.max(0, ...tous.filter(pred).map((l) => num(l.lot))) + 1}`;
    const propre = volontaire ? 'VOLONTAIRE' : 'COMMUNAUTAIRE';
    const libre =
      possibles.find((l) => l.n < taille && l.nature === propre) ??
      possibles.find((l) => l.n < taille);
    const suivantSepare = volontaire
      ? suivant((l) => l.nature === 'VOLONTAIRE')
      : suivant((l) => l.nature !== 'VOLONTAIRE');
    const suivantMixte = suivant((l) => l.nature !== 'VOLONTAIRE');
    return {
      taille,
      lots: possibles.map((l) => ({ ...l, plein: l.n >= taille })),
      conseille: libre
        ? { lot: libre.lot, nature: libre.nature }
        : { lot: suivantSepare, nature: propre as NatureLot },
      suivants: {
        separe: { lot: suivantSepare, nature: propre as NatureLot },
        mixte: { lot: suivantMixte, nature: 'MIXTE' as NatureLot },
      },
      // compatibilité
      suivant: suivantSepare,
    };
  }

  /**
   * Personnes déjà dans la base qui ressemblent à celle qu'on saisit, mot par mot :
   * un prénom de plus ou de moins, un autre ordre, une faute de frappe (voir ressemblance.ts).
   */
  async doublons(nom?: string, dateNaissance?: string, exclure?: string) {
    const mots = motsDuNom(nom ?? '');
    if (!mots.length) return [];
    const base = await this.agents.find({
      select: ['id', 'nomNormalise', 'dateNaissance'],
      loadEagerRelations: false,
    });
    const trouves = base
      .filter((a) => a.id !== exclure)
      .map((a) => ({
        a,
        niveau: ressemblance(
          mots,
          dateNaissance,
          motsDuNom(a.nomNormalise),
          a.dateNaissance,
        ),
      }))
      .filter((x) => x.niveau)
      .sort(
        (x, y) =>
          Number(y.a.dateNaissance === dateNaissance) -
            Number(x.a.dateNaissance === dateNaissance) ||
          Number(y.niveau === 'PROBABLE') - Number(x.niveau === 'PROBABLE'),
      )
      .slice(0, 8);
    // Personnes recrutées les années précédentes (fichiers importés)
    const anciens = (
      await this.complements.anciensProches(normaliser(nom ?? ''))
    )
      .map((x) => ({
        x,
        niveau: ressemblance(
          mots,
          dateNaissance,
          motsDuNom(x.nomNormalise),
          x.dateNaissance,
        ),
      }))
      .filter((y) => y.niveau)
      .slice(0, 5)
      .map(({ x, niveau }) => ({
        id: `ancien-${x.id}`,
        nomComplet: x.nomComplet,
        dateNaissance: x.dateNaissance,
        diplome: x.diplome,
        departement: null,
        feuille: 'ANCIEN',
        lot: null,
        ancien: { annee: x.annee, source: x.source },
        niveau,
        memeNaissance: !!dateNaissance && x.dateNaissance === dateNaissance,
        bloquant:
          !!dateNaissance &&
          x.dateNaissance === dateNaissance &&
          niveau === 'PROBABLE',
      }));
    if (!trouves.length) return anciens;
    const details = new Map(
      (
        await this.agents.find({
          where: { id: In(trouves.map((x) => x.a.id)) },
        })
      ).map((a) => [a.id, a]),
    );
    const dansLaBase = trouves.map(({ a: x, niveau }) => {
      const a = details.get(x.id)!;
      return {
        id: a.id,
        nomComplet: a.nomComplet,
        dateNaissance: a.dateNaissance,
        diplome: a.diplomeBrut,
        departement: a.departement?.nom ?? null,
        feuille: a.feuille,
        lot: a.lotPublication ? libelleLot(a.lotPublication) : null,
        niveau,
        memeNaissance: !!dateNaissance && a.dateNaissance === dateNaissance,
        // Bloquant à l'enregistrement : même date de naissance et nom très proche
        bloquant:
          !!dateNaissance &&
          a.dateNaissance === dateNaissance &&
          niveau === 'PROBABLE',
        ancien: null as { annee: number | null; source: string } | null,
      };
    });
    return [...dansLaBase, ...anciens];
  }

  /* ------------------------------ Écriture ---------------------------- */

  private async preparer(dto: CandidatDto, ex?: Agent) {
    const nomComplet = nomPropre(dto.nomComplet ?? '');
    if (!nomComplet)
      throw new BadRequestException('Écrivez le nom du candidat.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dto.dateNaissance ?? ''))
      throw new BadRequestException('La date de naissance est obligatoire.');
    const dateDepot = dto.dateDepot || ex?.dateDepot || aujourdhui();
    if (isNaN(new Date(`${dto.dateNaissance}T00:00:00Z`).getTime()))
      throw new BadRequestException('Date de naissance invalide.');
    const age = ageRevolu(dto.dateNaissance, dateDepot);
    const ageMin = this.nombre('AGE_MINIMUM', 18);
    if (age < ageMin)
      throw new BadRequestException(
        `Le candidat a ${Math.max(age, 0)} ans au dépôt du dossier : il faut ${ageMin} ans révolus. Le dossier ne peut pas être enregistré, mettez-le de côté.`,
      );
    // Au-delà de l'âge maximum : enregistré, mais en attente de la décision du DG
    const ageMax = this.nombre('AGE_MAXIMUM', 45);
    const memeNaissance = ex?.dateNaissance === dto.dateNaissance;
    const contentieuxAge =
      age > ageMax
        ? memeNaissance && ex?.contentieuxAge
          ? ex.contentieuxAge
          : 'EN_ATTENTE'
        : null;

    const regle = await this.regles.findOne({
      where: { code: dto.diplomeCode },
    });
    if (!regle) throw new BadRequestException('Choisissez le diplôme.');

    if (dto.feuille === 'QUOTA_AUTRES')
      throw new BadRequestException(
        'Le quota « Autres » ne se saisit pas ici : ce sont les personnes trouvées sur les textes de la FP sans avoir été envoyées par nous. Enregistrez-les dans « Réception des textes ».',
      );
    const meppsa = true;
    let dep: Departement | null = null;
    if (dto.departementId)
      dep = await this.deps.findOne({ where: { id: dto.departementId } });
    if (meppsa && !dep)
      throw new BadRequestException("Choisissez le département d'affectation.");

    // Mêmes champs pour les deux listes ; pour le quota « Autres », quota, n° d'ordre,
    // statut et lot sont facultatifs
    const quota = dto.quota ?? null;
    const anneeMax = dernierQuota();
    if (
      (meppsa && !quota) ||
      (quota !== null && (quota < PREMIER_QUOTA || quota > anneeMax))
    )
      throw new BadRequestException(
        `Indiquez le quota (année entre ${PREMIER_QUOTA} et ${anneeMax}).`,
      );
    let numeroOrdre = dto.numeroOrdre ?? null;
    if (!meppsa && numeroOrdre !== null && quota !== null) {
      const pris = await this.agents.findOne({
        where: { feuille: 'QUOTA_AUTRES', quota, numeroOrdre },
        loadEagerRelations: false,
      });
      if (pris && pris.id !== ex?.id)
        throw new BadRequestException(
          `Le n° d'ordre ${numeroOrdre} du quota « Autres » ${quota} est déjà utilisé (${pris.nomComplet}).`,
        );
    }
    if (meppsa) {
      numeroOrdre ??=
        ex?.quota === quota && ex?.numeroOrdre
          ? ex.numeroOrdre
          : await this.prochainNumero('MEPPSA', quota);
      const pris = await this.agents.findOne({
        where: { feuille: 'MEPPSA', quota: quota!, numeroOrdre },
        loadEagerRelations: false,
      });
      if (pris && pris.id !== ex?.id)
        throw new BadRequestException(
          `Le n° d'ordre ${numeroOrdre} du quota ${quota} est déjà utilisé (${pris.nomComplet}).`,
        );
    }

    // Personne choisie dans la base du personnel : son statut vient de sa fiche ; une personne
    // absente de la base ne peut être que communautaire (DG, 23/10/2026)
    const lien = await this.liaisonPersonnel(dto, ex);
    const statut = lien
      ? lien.statut
      : (texteOuNull(dto.statut) ?? (meppsa ? null : 'Autres'));
    // Lot de la commission : au plus N dossiers ; volontaires (un diplôme),
    // communautaires (diplômes du cycle) ou mixte (les deux statuts du cycle)
    const lotCommission = lotCommissionNormalise(dto.lotCommission);
    const volontaire = /^volon/i.test(statut ?? '');
    let lotNature: NatureLot | null = lotCommission
      ? dto.lotNature === 'MIXTE'
        ? 'MIXTE'
        : volontaire
          ? 'VOLONTAIRE'
          : 'COMMUNAUTAIRE'
      : null;
    if (lotCommission) {
      const etat = await this.lots(
        quota,
        statut,
        regle.code,
        ex?.id,
        meppsa ? 'MEPPSA' : 'QUOTA_AUTRES',
      );
      const lot = etat.lots.find(
        (l) =>
          l.lot === lotCommission &&
          (l.nature === 'MIXTE') === (lotNature === 'MIXTE'),
      );
      // Un lot existant garde sa nature
      if (lot) lotNature = lot.nature;
      const change =
        lotCommission !== ex?.lotCommission || lotNature !== ex?.lotNature;
      if (change && lot?.plein)
        throw new BadRequestException(
          `Le ${lotCommission} (${lot.nature === 'MIXTE' ? 'lot mixte' : volontaire ? `volontaires ${regle.libelle}` : 'communautaires'}, quota ${quota}) contient déjà ${lot.n} dossiers sur ${etat.taille}. Enregistrez ce dossier dans le ${etat.conseille.lot}.`,
        );
    }

    // Dossier apporté par un membre de la commission (sur ses places)
    const membre = dto.membreCommissionId
      ? await this.membres.findOne({ where: { id: dto.membreCommissionId } })
      : null;
    if (dto.membreCommissionId && !membre)
      throw new BadRequestException('Membre de la commission introuvable.');
    if (membre && quota && membre.quota !== quota)
      throw new BadRequestException(
        `${membre.nom} est membre de la commission du quota ${membre.quota}, pas du quota ${quota}.`,
      );

    const nomNormalise = normaliser(nomComplet);
    if (!dto.forcerDoublon) {
      const proches = (
        await this.doublons(nomComplet, dto.dateNaissance, ex?.id)
      ).filter((d) => d.bloquant);
      if (proches.length)
        throw new BadRequestException(
          proches[0].ancien
            ? `${proches[0].nomComplet}, né(e) le même jour, a déjà été recruté(e)${proches[0].ancien.annee ? ` en ${proches[0].ancien.annee}` : ' une année précédente'} (${proches[0].ancien.source}). Vérifiez le dossier.`
            : `${proches[0].nomComplet}, né(e) le même jour, est déjà dans la base. Vérifiez le dossier.`,
        );
    }

    return {
      cle: meppsa
        ? `M|${quota}|${numeroOrdre}|${nomNormalise}`
        : `QA|${nomNormalise}|${dto.dateNaissance}`,
      feuille: meppsa ? 'MEPPSA' : 'QUOTA_AUTRES',
      quota,
      numeroOrdre,
      nomComplet,
      nomNormalise,
      dateNaissance: dto.dateNaissance,
      dateNaissanceBrute: null,
      dateDepot,
      lieuNaissance: texteOuNull(dto.lieuNaissance),
      diplomeBrut: regle.libelle,
      diplomeCode: regle.code,
      departementBrut: dep?.nom ?? null,
      departementId: dep?.id ?? null,
      source: texteOuNull(dto.source) ?? (meppsa ? 'MEPPSA' : 'FP'),
      cycleBrut: LIBELLE_CYCLE[regle.cycle as Cycle] ?? null,
      lotCommission,
      lotNature,
      statut,
      lieuServiceBrut: texteOuNull(dto.lieuServiceBrut),
      origineBrute:
        texteOuNull(dto.origineBrute) ??
        (membre ? `Membre de la commission : ${membre.nom}` : null),
      membreCommissionId: membre?.id ?? null,
      agentRecenseId: lien?.id ?? null,
      vagueNumero: lien?.vague ?? null,
      observation: texteOuNull(dto.observation),
      contentieuxAge,
      anomalies: [],
    } satisfies Partial<Agent>;
  }

  private async fiche(id: string) {
    const a = await this.agents.findOne({ where: { id } });
    if (!a || a.origineFiche !== 'SAISIE')
      throw new NotFoundException('Fiche introuvable');
    return a;
  }

  private async rendu(id: string) {
    return (await this.enrichir([await this.fiche(id)]))[0];
  }

  async creer(u: UtilisateurConnecte, dto: CandidatDto) {
    const data = await this.preparer(dto);
    const avertissement = await this.avertissementVague(
      data.vagueNumero,
      data.quota,
    );
    const a = await this.agents.save(
      this.agents.create({
        ...data,
        origineFiche: 'SAISIE',
        etatFiche: 'A_CONTROLER',
        saisiePar: u.nom,
      }),
    );
    await this.journal.log(u, 'SAISIE_CANDIDAT', 'agent', a.id, {
      diplome: data.diplomeBrut,
      departementId: data.departementId,
      ...(data.contentieuxAge ? { contentieux: 'âge' } : {}),
    });
    return { ...(await this.rendu(a.id)), avertissementVague: avertissement };
  }

  async modifier(u: UtilisateurConnecte, id: string, dto: CandidatDto) {
    const a = await this.fiche(id);
    if (ROLES_SAISIE_SEULE.includes(u.role) && a.etatFiche !== 'A_CONTROLER')
      throw new ForbiddenException(
        'Cette fiche a déjà été contrôlée : seul un contrôleur peut la modifier.',
      );
    if (a.lotPublicationId)
      throw new BadRequestException(
        'Le texte de la Fonction Publique est déjà arrivé : corrigez la fiche dans « Base des recrutés ».',
      );
    const data = await this.preparer(dto, a);
    // Toute modification repart au contrôle, puis à la validation du DG
    await this.agents.update(id, {
      ...data,
      etatFiche: 'A_CONTROLER',
      controleePar: null,
      valideePar: null,
      remarqueControle: null,
      rectifiee: !!a.transmissionNumero,
    });
    await this.anomalies.reconcilier();
    await this.journal.log(u, 'MODIFICATION_CANDIDAT', 'agent', id, {
      diplome: data.diplomeBrut,
      departementId: data.departementId,
      ...(a.transmissionNumero ? { apresEnvoi: a.transmission } : {}),
    });
    return this.rendu(id);
  }

  /** Contrôle d'une fiche : conforme au dossier, ou renvoyée avec une remarque. */
  async controler(
    u: UtilisateurConnecte,
    id: string,
    conforme: boolean,
    remarque?: string,
  ) {
    const a = await this.fiche(id);
    if (a.contentieuxAge === 'EN_ATTENTE' || a.contentieuxAge === 'REJETE')
      throw new BadRequestException(
        'Dossier en contentieux (âge) : il attend la décision du DG.',
      );
    if (!conforme) {
      if (!remarque?.trim())
        throw new BadRequestException(
          'Écrivez ce qu’il faut corriger dans la fiche.',
        );
      await this.agents.update(id, {
        etatFiche: 'A_CONTROLER',
        controleePar: null,
        valideePar: null,
        remarqueControle: remarque.trim(),
      });
      await this.journal.log(u, 'RETOUR_CANDIDAT', 'agent', id, { remarque });
      return { ok: true };
    }
    if (a.etatFiche !== 'A_CONTROLER')
      throw new BadRequestException('Cette fiche est déjà contrôlée.');
    const manque = [
      !a.dateNaissance && 'date de naissance',
      !a.diplomeCode && 'diplôme',
      a.feuille === 'MEPPSA' && !a.departementId && 'département',
    ].filter(Boolean);
    if (manque.length)
      throw new BadRequestException(
        `Fiche incomplète (${manque.join(', ')}) : faites-la compléter avant de la déclarer conforme.`,
      );
    await this.agents.update(id, {
      etatFiche: 'CONTROLEE',
      controleePar: u.nom,
      remarqueControle: null,
      anomalies: (a.anomalies ?? []).filter(
        (x) => !x.startsWith('Ressemble à'),
      ),
    });
    await this.journal.log(u, 'CONTROLE_CANDIDAT', 'agent', id);
    return { ok: true };
  }

  /**
   * « Tout contrôler » : toutes les fiches à contrôler (ou une liste) passent
   * contrôlées, sauf celles qui sont incomplètes, en contentieux ou signalées
   * comme ressemblant à une autre personne (elles restent à contrôler une par une).
   */
  async controlerTout(u: UtilisateurConnecte, ids?: string[]) {
    const fiches = await this.agents.find({
      where: {
        origineFiche: 'SAISIE',
        etatFiche: 'A_CONTROLER',
        ...(ids?.length ? { id: In(ids) } : {}),
      },
      loadEagerRelations: false,
    });
    const aVoir = (f: Agent) =>
      !f.dateNaissance ||
      !f.diplomeCode ||
      (f.feuille === 'MEPPSA' && !f.departementId) ||
      f.contentieuxAge === 'EN_ATTENTE' ||
      f.contentieuxAge === 'REJETE' ||
      (f.anomalies ?? []).some((x) => x.startsWith('Ressemble à'));
    const ok = fiches.filter((f) => !aVoir(f));
    if (ok.length)
      await this.agents.update(
        { id: In(ok.map((f) => f.id)) },
        { etatFiche: 'CONTROLEE', controleePar: u.nom, remarqueControle: null },
      );
    await this.journal.log(u, 'CONTROLE_CANDIDATS', undefined, null, {
      fiches: ok.length,
      laissees: fiches.length - ok.length,
    });
    return { controlees: ok.length, laissees: fiches.length - ok.length };
  }

  /** Validation par le DG : une fiche, une liste, ou toutes les fiches contrôlées. */
  async valider(u: UtilisateurConnecte, ids?: string[]) {
    const fiches = await this.agents.find({
      where: {
        origineFiche: 'SAISIE',
        etatFiche: 'CONTROLEE',
        ...(ids?.length ? { id: In(ids) } : {}),
      },
      loadEagerRelations: false,
    });
    const ok = fiches.filter(
      (f) => !f.contentieuxAge || f.contentieuxAge === 'APPROUVE',
    );
    if (!ok.length)
      throw new BadRequestException('Aucune fiche contrôlée à valider.');
    await this.agents.update(
      { id: In(ok.map((f) => f.id)) },
      { etatFiche: 'VALIDEE', valideePar: u.nom },
    );
    await this.journal.log(u, 'VALIDATION_CANDIDATS', undefined, null, {
      fiches: ok.length,
    });
    return { validees: ok.length };
  }

  /** Décision du DG sur un dossier qui dépasse l'âge maximum. */
  async deciderContentieux(
    u: UtilisateurConnecte,
    id: string,
    decision: 'APPROUVE' | 'REJETE',
  ) {
    const a = await this.fiche(id);
    if (!a.contentieuxAge)
      throw new BadRequestException("Ce dossier n'est pas en contentieux.");
    await this.agents.update(id, {
      contentieuxAge: decision,
      contentieuxPar: u.nom,
    });
    await this.journal.log(u, 'CONTENTIEUX_AGE', 'agent', id, { decision });
    return { ok: true };
  }

  async supprimer(u: UtilisateurConnecte, id: string) {
    const a = await this.fiche(id);
    if (a.transmissionNumero || a.lotPublicationId)
      throw new BadRequestException(
        'Fiche déjà envoyée à la Fonction Publique : suppression impossible.',
      );
    if (ROLES_SAISIE_SEULE.includes(u.role) && a.etatFiche !== 'A_CONTROLER')
      throw new ForbiddenException(
        'Cette fiche a déjà été contrôlée : seul un contrôleur peut la supprimer.',
      );
    await this.agents.delete(id);
    await this.journal.log(u, 'SUPPRESSION_CANDIDAT', 'agent', null, {
      nom: a.nomComplet,
    });
    // Les autres fiches qui disaient « Ressemble à » cette personne ne le disent plus
    await this.anomalies.reconcilier();
    return { ok: true };
  }

  /* ----------------------- Import d'un fichier Excel ------------------ */

  /**
   * Liste Excel (directions départementales, travail déjà fait sur Excel…) :
   * chaque ligne devient une fiche « à contrôler », comme une saisie.
   */
  /**
   * mode « analyse » : rien n'est créé, on compte seulement (dont les personnes dont
   * le texte de la FP est déjà noté dans le fichier) ; « sansTexte » : on ne crée que
   * celles qui n'ont pas encore d'arrêté ou de décret ; « tout » : on crée tout.
   */
  async importer(
    u: UtilisateurConnecte,
    contenu: Buffer,
    nomFichier: string,
    mode: 'analyse' | 'sansTexte' | 'tout' = 'tout',
    options: {
      /** Institution qui envoie la liste, pour les lignes sans « Origine ». */
      origine?: string | null;
    } = {},
  ) {
    const feuilles = await lireClasseur(contenu, ['NOMSETPRENOMS', 'DIPLOME']);
    if (!feuilles.length)
      throw new BadRequestException(
        'Aucune feuille avec les colonnes « Noms et prénoms » et « Diplôme » n’a été trouvée.',
      );
    const regles = await this.regles.find();
    const deps = new Map((await this.deps.find()).map((d) => [d.code, d]));
    const cles = new Set(
      (
        await this.agents.find({ select: ['cle'], loadEagerRelations: false })
      ).map((a) => a.cle),
    );
    const personnes = new Set(
      (
        await this.agents.find({
          select: ['nomNormalise', 'dateNaissance'],
          loadEagerRelations: false,
        })
      ).map((a) => `${a.nomNormalise}|${a.dateNaissance}`),
    );
    // Noms déjà connus, pour signaler les personnes qui se ressemblent
    const connus = (
      await this.agents.find({
        select: ['nomComplet', 'nomNormalise', 'dateNaissance'],
        loadEagerRelations: false,
      })
    ).map((a) => ({
      nom: a.nomComplet,
      mots: motsDuNom(a.nomNormalise),
      naissance: a.dateNaissance,
    }));
    const ageMin = this.nombre('AGE_MINIMUM', 18);
    const ageMax = this.nombre('AGE_MAXIMUM', 45);
    const rapport = {
      lues: 0,
      creees: 0,
      dejaPresentes: 0,
      tropJeunes: 0,
      contentieux: 0,
      aCompleter: 0,
      ressemblances: 0,
      /** Lignes dont le retour FP (type, n° de texte ou lot de publication) est rempli. */
      avecTexte: 0,
      ignoreesAvecTexte: 0,
    };
    const exemplesTexte: { nom: string; texte: string; lot: string | null }[] =
      [];
    /** Feuilles « Quota Autres » : non lues ici (le quota Autres vient des textes de la FP). */
    const feuillesIgnorees: string[] = [];
    const nouvelles: Partial<Agent>[] = [];
    let nouvellesSansTexte = 0;
    const numeros = new Map<number, number>();

    for (const f of feuilles) {
      if (cleCompacte(f.nom).includes('AUTRE')) {
        feuillesIgnorees.push(f.nom);
        continue;
      }
      const quotaAutres = false;
      for (const l of f.lignes) {
        const nomComplet = nettoyer(champ(l, 'NOMSETPRENOMS'));
        if (!nomComplet) continue;
        rapport.lues++;
        // Retour de la FP déjà noté : la personne a son arrêté ou son décret
        const type = nettoyer(champ(l, 'TYPEDETEXTE'));
        const numero = nettoyer(champ(l, 'NTEXTE', 'NDUTEXTE'));
        const lotFP = nettoyer(champ(l, 'LOTDEPUBLICAT', 'LOTDEPUBLICATION'));
        const aUnTexte = !!(type || numero || lotFP);
        if (aUnTexte) {
          rapport.avecTexte++;
          if (exemplesTexte.length < 10)
            exemplesTexte.push({
              nom: nomComplet,
              texte:
                [type, numero ? `n° ${numero}` : null]
                  .filter(Boolean)
                  .join(' ') || 'texte',
              lot: lotFP,
            });
          if (mode === 'sansTexte') {
            rapport.ignoreesAvecTexte++;
            continue;
          }
        }
        const nomNormalise = normaliser(nomComplet);
        const dateNaissance = lireDate(champ(l, 'DATEDENAIS'));
        if (personnes.has(`${nomNormalise}|${dateNaissance}`)) {
          rapport.dejaPresentes++;
          continue;
        }
        const dateDepot =
          lireDate(champ(l, 'DATEDEDEPOT', 'DATEDEPOT')) ?? aujourdhui();
        const age = dateNaissance ? ageRevolu(dateNaissance, dateDepot) : null;
        if (age !== null && age < ageMin) {
          rapport.tropJeunes++;
          continue;
        }
        const anomalies: string[] = [];
        if (!dateNaissance) anomalies.push('Date de naissance illisible');
        const diplomeBrut = nettoyer(champ(l, 'DIPLOME'));
        const diplomeCode = reconnaitreDiplome(diplomeBrut, regles);
        if (!diplomeCode) anomalies.push('Diplôme non reconnu');
        const regle = regles.find((r) => r.code === diplomeCode);
        const departementBrut = nettoyer(champ(l, 'DEPARTEMENT', 'DEPART'));
        const codeDep = codeDepartement(departementBrut);
        if (!codeDep && !quotaAutres) anomalies.push('Département non reconnu');
        const mots = motsDuNom(nomComplet);
        const proche = connus.find(
          (c) =>
            ressemblance(mots, dateNaissance, c.mots, c.naissance) ===
            'PROBABLE',
        );
        if (proche) {
          const [an, mo, jo] = (proche.naissance ?? '').split('-');
          anomalies.push(
            `Ressemble à ${proche.nom}${an ? ` (né(e) le ${jo}/${mo}/${an})` : ''}`,
          );
          rapport.ressemblances++;
        }
        connus.push({ nom: nomComplet, mots, naissance: dateNaissance });
        // Le quota « Autres » garde aussi l'année du quota, si elle est écrite
        const quotaLu = entier(champ(l, 'QUOTA'));
        // Même règle que le formulaire : un quota hors des années possibles est signalé
        const quota =
          quotaLu && (quotaLu < PREMIER_QUOTA || quotaLu > dernierQuota())
            ? null
            : quotaLu;
        if (quotaLu && quota === null)
          anomalies.push(
            `Quota invalide (${quotaLu}) : année entre ${PREMIER_QUOTA} et ${dernierQuota()}`,
          );
        let numeroOrdre = quotaAutres ? null : entier(champ(l, 'NDORDRE'));
        if (!quotaAutres && quota && !numeroOrdre) {
          const n =
            numeros.get(quota) ?? (await this.prochainNumero('MEPPSA', quota));
          numeroOrdre = n;
          numeros.set(quota, n + 1);
        }
        let cle = quotaAutres
          ? `QA|${nomNormalise}|${dateNaissance ?? ''}`
          : `M|${quota ?? ''}|${numeroOrdre ?? ''}|${nomNormalise}`;
        if (cles.has(cle)) cle = `${cle}#${f.nom}#${l._ligne}`;
        cles.add(cle);
        personnes.add(`${nomNormalise}|${dateNaissance}`);
        const contentieuxAge =
          age !== null && age > ageMax ? 'EN_ATTENTE' : null;
        if (contentieuxAge) rapport.contentieux++;
        if (anomalies.length) rapport.aCompleter++;
        if (!aUnTexte) nouvellesSansTexte++;
        nouvelles.push({
          cle,
          feuille: quotaAutres ? 'QUOTA_AUTRES' : 'MEPPSA',
          quota,
          numeroOrdre,
          nomComplet,
          nomNormalise,
          dateNaissance,
          dateNaissanceBrute: dateNaissance
            ? null
            : nettoyer(champ(l, 'DATEDENAIS')),
          dateDepot,
          lieuNaissance: nettoyer(champ(l, 'LIEUDENAIS')),
          diplomeBrut: regle?.libelle ?? diplomeBrut,
          diplomeCode,
          departementBrut,
          departementId: codeDep ? (deps.get(codeDep)?.id ?? null) : null,
          source:
            nettoyer(champ(l, 'SOURCE')) ?? (quotaAutres ? 'FP' : 'MEPPSA'),
          cycleBrut: regle ? LIBELLE_CYCLE[regle.cycle as Cycle] : null,
          lotCommission: quotaAutres
            ? null
            : lotCommissionNormalise(champ(l, 'LOT')),
          statut:
            nettoyer(champ(l, 'STATUT')) ?? (quotaAutres ? 'Autres' : null),
          lieuServiceBrut: nettoyer(champ(l, 'LIEUDESERVICE')),
          origineBrute:
            nettoyer(champ(l, 'ORIGINE')) ??
            (nettoyer(options.origine) || null),
          observation: nettoyer(champ(l, 'OBS', 'OBSERVATION')),
          origineFiche: 'SAISIE',
          etatFiche: 'A_CONTROLER',
          saisiePar: u.nom,
          contentieuxAge,
          anomalies,
        });
      }
    }
    if (mode === 'analyse')
      return {
        ...rapport,
        aCreer: nouvelles.length,
        feuillesIgnorees,
        aCreerSansTexte: nouvellesSansTexte,
        exemplesTexte,
        analyse: true,
      };
    for (let i = 0; i < nouvelles.length; i += 500)
      await this.agents.insert(nouvelles.slice(i, i + 500));
    rapport.creees = nouvelles.length;
    await this.anomalies.reconcilier();
    await this.journal.log(u, 'IMPORT_CANDIDATS', 'agent', null, {
      fichier: nomFichier,
      mode,
      ...rapport,
    });
    return { ...rapport, exemplesTexte, feuillesIgnorees };
  }

  /* --------------------- Transmission à la Fonction Publique ---------- */

  /**
   * Transmissions groupées par quota : chaque quota (année de recrutement) a ses
   * propres 1ère, 2ème, 3ème transmissions. Une transmission contient plusieurs lots.
   */
  async transmissions() {
    const lignes = await this.agents.query<
      {
        quota: number;
        numero: number;
        n: number;
        lots: number;
        saisies: number;
        rectifiees: number;
        textes: number;
        date: string | null;
      }[]
    >(`
      SELECT quota, "transmissionNumero" AS numero, count(*)::int AS n,
        -- Un lot = son numéro + sa nature (volontaires : par diplôme ; sinon par cycle)
        count(DISTINCT CASE WHEN "lotCommission" IS NULL THEN NULL
          WHEN coalesce("lotNature", CASE WHEN statut ILIKE 'volon%' THEN 'VOLONTAIRE' ELSE 'COMMUNAUTAIRE' END) = 'VOLONTAIRE'
            THEN 'V|' || coalesce("diplomeCode", '') || '|' || "lotCommission"
          ELSE 'C|' || coalesce(upper("cycleBrut"), '') || '|' || "lotCommission" END)::int AS lots,
        count(*) FILTER (WHERE "origineFiche" = 'SAISIE')::int AS saisies,
        count(*) FILTER (WHERE rectifiee)::int AS rectifiees,
        count(*) FILTER (WHERE "lotPublicationId" IS NOT NULL)::int AS textes,
        max("transmisLe")::text AS date
      FROM agent WHERE "transmissionNumero" IS NOT NULL AND quota IS NOT NULL
      GROUP BY 1, 2 ORDER BY 1 DESC, 2 DESC`);
    const pretes = await this.agents.query<{ quota: number; n: number }[]>(`
      SELECT quota, count(*)::int AS n FROM agent
      WHERE "origineFiche" = 'SAISIE' AND feuille = 'MEPPSA' AND "etatFiche" = 'VALIDEE'
        AND "transmissionNumero" IS NULL AND quota IS NOT NULL
        AND ("contentieuxAge" IS NULL OR "contentieuxAge" = 'APPROUVE')
      GROUP BY 1`);
    const misesDeCote = await this.agents.query<
      { quota: number; numero: number; n: number }[]
    >(`
      SELECT quota, "transmissionOrigine" AS numero, count(*)::int AS n FROM agent
      WHERE "transmissionOrigine" IS NOT NULL AND "transmissionNumero" IS NULL
      GROUP BY 1, 2`);
    const quotas = [
      ...new Set([
        ...lignes.map((l) => l.quota),
        ...pretes.map((p) => p.quota),
      ]),
    ].sort((a, b) => b - a);
    const c = await this.compteurs();
    return {
      aControler: c.aControler,
      aValider: c.controlees,
      pretes: c.validees,
      contentieux: c.contentieux,
      quotas: quotas.map((quota) => {
        const liste = lignes.filter((l) => l.quota === quota);
        const prochaine = Math.max(0, ...liste.map((t) => t.numero)) + 1;
        return {
          quota,
          pretes: pretes.find((p) => p.quota === quota)?.n ?? 0,
          prochaine,
          libelleProchaine: libelleTransmission(prochaine),
          liste: liste.map((t) => ({
            ...t,
            libelle: libelleTransmission(t.numero),
            misesDeCote:
              misesDeCote.find(
                (m) => m.quota === quota && m.numero === t.numero,
              )?.n ?? 0,
          })),
        };
      }),
    };
  }

  private async prochaineTransmission(quota: number) {
    const [r] = await this.agents.query<{ n: number | null }[]>(
      `SELECT max("transmissionNumero")::int AS n FROM agent WHERE quota = $1`,
      [quota],
    );
    return (r?.n ?? 0) + 1;
  }

  /**
   * Clé d'une liste imprimée = un lot de la commission : volontaires (quota + diplôme),
   * communautaires ou mixte (quota + cycle).
   */
  private cleListe(a: Agent) {
    const nature = natureLot(a);
    return [
      a.quota ?? '',
      nature === 'VOLONTAIRE' ? 'V' : 'C',
      nature === 'VOLONTAIRE' ? (a.diplomeCode ?? '') : cleCycle(a),
      a.lotCommission ?? '',
    ].join('|');
  }

  /** Regroupe les fiches validées par le DG d'un quota dans sa prochaine transmission. */
  async transmettre(u: UtilisateurConnecte, quota: number, ids?: string[]) {
    if (!quota) throw new BadRequestException('Choisissez le quota à envoyer.');
    if (ids && !ids.length)
      throw new BadRequestException('Cochez au moins un dossier à envoyer.');
    const prochaine = await this.prochaineTransmission(quota);
    const pretes = (
      await this.agents.find({
        where: {
          origineFiche: 'SAISIE',
          etatFiche: 'VALIDEE',
          transmissionNumero: IsNull(),
          feuille: 'MEPPSA',
          quota,
        },
        loadEagerRelations: false,
      })
    ).filter((f) => !f.contentieuxAge || f.contentieuxAge === 'APPROUVE');
    // Dossiers cochés : seulement ceux-là (tous doivent être prêts à partir)
    const fiches = ids ? pretes.filter((f) => ids.includes(f.id)) : pretes;
    if (ids && fiches.length !== new Set(ids).size)
      throw new BadRequestException(
        'Certains dossiers cochés ne sont plus prêts à partir (déjà envoyés ou modifiés) : rechargez la liste.',
      );
    if (!fiches.length)
      throw new BadRequestException(
        `Aucune fiche du quota ${quota} validée par le DG à envoyer.`,
      );
    // N°/Liste : rang dans la liste imprimée de son lot (ordre alphabétique)
    fiches.sort(
      (a, b) =>
        this.cleListe(a).localeCompare(this.cleListe(b)) ||
        a.nomNormalise.localeCompare(b.nomNormalise),
    );
    const rang = new Map<string, number>();
    const libelle = libelleTransmission(prochaine);
    for (const f of fiches) {
      const k = this.cleListe(f);
      const n = (rang.get(k) ?? 0) + 1;
      rang.set(k, n);
      await this.agents.update(f.id, {
        transmissionNumero: prochaine,
        transmission: libelle,
        transmisLe: aujourdhui(),
        numeroListe: n,
        // Dossier mis de côté puis corrigé : il part dans cette nouvelle transmission
        transmissionOrigine: null,
      });
    }
    await this.journal.log(u, 'TRANSMISSION_FP', undefined, null, {
      quota,
      numero: prochaine,
      fiches: fiches.length,
    });
    return { quota, numero: prochaine, fiches: fiches.length };
  }

  /**
   * La FP dit un dossier incomplet : il sort de sa transmission et revient « à
   * contrôler » pour être corrigé, contrôlé et validé de nouveau.
   */
  async mettreDeCote(u: UtilisateurConnecte, id: string, motif: string) {
    const a = await this.agents.findOne({ where: { id } });
    if (!a) throw new NotFoundException('Fiche introuvable');
    if (!a.transmissionNumero)
      throw new BadRequestException(
        'Ce dossier n’est pas dans une transmission.',
      );
    if (a.lotPublicationId)
      throw new BadRequestException(
        'Le texte de la FP est déjà revenu pour ce dossier : corrigez-le dans « Base des recrutés ».',
      );
    if (!motif?.trim())
      throw new BadRequestException(
        'Écrivez pourquoi le dossier est mis de côté.',
      );
    await this.agents.update(id, {
      transmissionOrigine: a.transmissionNumero,
      transmissionNumero: null,
      transmission: null,
      transmisLe: null,
      // Le dossier entre (ou revient) dans le circuit du système
      origineFiche: 'SAISIE',
      etatFiche: 'A_CONTROLER',
      controleePar: null,
      valideePar: null,
      misDeCoteMotif: motif.trim(),
      misDeCotePar: u.nom,
      misDeCoteLe: new Date(),
      remarqueControle: `Mis de côté : ${motif.trim()}`,
    });
    await this.journal.log(u, 'MISE_DE_COTE', 'agent', id, {
      quota: a.quota,
      transmission: a.transmissionNumero,
      motif: motif.trim(),
    });
    return { ok: true };
  }

  /** Dossier corrigé et validé : il reprend sa place dans la transmission d'origine. */
  async rattacher(u: UtilisateurConnecte, id: string) {
    const a = await this.agents.findOne({ where: { id } });
    if (!a) throw new NotFoundException('Fiche introuvable');
    if (!a.transmissionOrigine || a.transmissionNumero)
      throw new BadRequestException(
        'Ce dossier n’a pas été mis de côté d’une transmission.',
      );
    if (a.etatFiche !== 'VALIDEE')
      throw new BadRequestException(
        'Le dossier doit d’abord être contrôlé puis validé par le DG.',
      );
    await this.agents.update(id, {
      transmissionNumero: a.transmissionOrigine,
      transmission: libelleTransmission(a.transmissionOrigine),
      transmisLe: aujourdhui(),
      transmissionOrigine: null,
      rectifiee: true,
    });
    await this.journal.log(u, 'RATTACHEMENT_TRANSMISSION', 'agent', id, {
      quota: a.quota,
      transmission: a.transmissionOrigine,
    });
    return { quota: a.quota, numero: a.transmissionOrigine };
  }

  /** Annule la dernière transmission tant qu'aucun texte n'est revenu. */
  async annulerTransmission(
    u: UtilisateurConnecte,
    quota: number,
    numero: number,
  ) {
    const prochaine = await this.prochaineTransmission(quota);
    if (numero !== prochaine - 1)
      throw new BadRequestException(
        `Seule la dernière transmission du quota ${quota} peut être annulée.`,
      );
    const fiches = await this.agents.find({
      where: { transmissionNumero: numero, quota },
      loadEagerRelations: false,
    });
    if (fiches.some((f) => f.origineFiche !== 'SAISIE'))
      throw new BadRequestException(
        'Cette transmission vient du fichier Excel : elle ne peut pas être annulée ici.',
      );
    if (fiches.some((f) => f.lotPublicationId))
      throw new BadRequestException(
        'Des textes de la Fonction Publique sont déjà revenus pour cette transmission.',
      );
    await this.agents.update(
      { transmissionNumero: numero, quota },
      {
        transmissionNumero: null,
        transmission: null,
        transmisLe: null,
        numeroListe: null,
        rectifiee: false,
      },
    );
    await this.journal.log(u, 'ANNULATION_TRANSMISSION', undefined, null, {
      quota,
      numero,
      fiches: fiches.length,
    });
    return { ok: true };
  }

  /** Fiches d'une transmission, ou de toutes (base compilée), dans l'ordre des listes. */
  async fichesTransmission(
    quota: number | null,
    numero: number | null,
    de: number | null = null,
    a: number | null = null,
  ) {
    const fiches = await this.agents.find({
      where: {
        ...(quota ? { quota } : {}),
        transmissionNumero:
          numero ??
          (de || a ? Between(de ?? 1, a ?? 1_000_000) : Not(IsNull())),
      },
    });
    if (!fiches.length) throw new NotFoundException('Transmission introuvable');
    return fiches.sort(
      (a, b) =>
        (b.quota ?? 0) - (a.quota ?? 0) ||
        (a.transmissionNumero ?? 0) - (b.transmissionNumero ?? 0) ||
        this.cleListe(a).localeCompare(this.cleListe(b)) ||
        (a.numeroListe ?? 1e9) - (b.numeroListe ?? 1e9) ||
        a.nomNormalise.localeCompare(b.nomNormalise),
    );
  }

  /** Listes imprimées qui accompagnent les dossiers : une par lot de la commission. */
  /**
   * Soit-transmis d'une transmission : tableau type de dossiers × cycle × catégorie/échelle,
   * avec le nombre de lots et de dossiers (comme la lettre du Cabinet à la FP).
   */
  async soitTransmis(quota: number, numero: number) {
    const l = await this.listesTransmission(quota, numero);
    const TYPES = {
      VOLONTAIRE: 'Enseignants volontaires',
      COMMUNAUTAIRE: 'Enseignants communautaires',
      MIXTE: 'Enseignants volontaires et communautaires (lots mixtes)',
    } as const;
    const ORDRE = ['Lycée', 'Collège', 'Primaire', 'Préscolaire'];
    const lignes = new Map<
      string,
      {
        type: string;
        cycle: string;
        classe: string;
        lots: number;
        dossiers: number;
      }
    >();
    for (const x of l.listes) {
      const type = TYPES[x.nature ?? 'COMMUNAUTAIRE'];
      const cycle = x.cycle ?? 'Autre';
      const classe =
        x.categorie && x.echelle
          ? `${x.categorie}-${x.echelle}`
          : x.categories.join(', ') || '—';
      const k = `${type}|${cycle}|${classe}`;
      const g = lignes.get(k) ?? { type, cycle, classe, lots: 0, dossiers: 0 };
      g.lots++;
      g.dossiers += x.lignes.length;
      lignes.set(k, g);
    }
    const rang = (c: string) => {
      const i = ORDRE.indexOf(c);
      return i < 0 ? 99 : i;
    };
    const types = Object.values(TYPES);
    const tableau = [...lignes.values()].sort(
      (a, b) =>
        types.indexOf(a.type as never) - types.indexOf(b.type as never) ||
        rang(a.cycle) - rang(b.cycle) ||
        a.cycle.localeCompare(b.cycle),
    );
    return {
      quota,
      numero,
      libelle: l.libelle,
      lots: tableau.reduce((n, x) => n + x.lots, 0),
      dossiers: tableau.reduce((n, x) => n + x.dossiers, 0),
      lignes: tableau,
      destinataire: this.params.get('SOIT_TRANSMIS_DESTINATAIRE'),
      reference: this.params.get('SOIT_TRANSMIS_REFERENCE'),
      appel: this.params.get('SOIT_TRANSMIS_APPEL'),
      signataireTitre: l.signataireTitre,
      signataireNom: l.signataireNom,
      lieu: l.lieu,
    };
  }

  async listesTransmission(quota: number, numero: number) {
    const fiches = await this.fichesTransmission(quota, numero);
    const regles = await this.affectation.reglesParCode();
    const groupes = new Map<string, Agent[]>();
    for (const f of fiches) {
      const k = this.cleListe(f);
      groupes.set(k, [...(groupes.get(k) ?? []), f]);
    }
    return {
      quota,
      numero,
      libelle: libelleTransmission(numero),
      signataireTitre: this.params.get('SIGNATAIRE_LISTE_TITRE'),
      signataireNom: this.params.get('SIGNATAIRE_LISTE_NOM'),
      lieu: this.params.get('LIEU_SIGNATURE'),
      listes: [...groupes.values()].map((g) => {
        const a = g[0];
        const r = a.diplomeCode ? regles.get(a.diplomeCode) : undefined;
        const regleDe = (f: Agent) =>
          f.diplomeCode ? regles.get(f.diplomeCode) : undefined;
        // Diplômes du lot, du plus fréquent au moins fréquent (« CFEEN-BAC »)
        const compte = new Map<string, number>();
        for (const f of g) {
          const d = regleDe(f)?.libelle ?? f.diplomeBrut ?? '?';
          compte.set(d, (compte.get(d) ?? 0) + 1);
        }
        const diplomes = [...compte.entries()]
          .sort((x, y) => y[1] - x[1])
          .map(([d]) => d);
        const classes = [
          ...new Set(
            g.map(
              (f) =>
                `${regleDe(f)?.categorie ?? ''}|${regleDe(f)?.echelle ?? ''}`,
            ),
          ),
        ];
        const nature =
          g.some((f) => natureLot(f) === 'MIXTE') ||
          (g.some((f) => /^volon/i.test(f.statut ?? '')) &&
            g.some((f) => !/^volon/i.test(f.statut ?? '')))
            ? 'MIXTE'
            : natureLot(a);
        return {
          quota: a.quota,
          statut: a.statut,
          nature,
          diplome: diplomes.join('-'),
          diplomes,
          cycle: r ? LIBELLE_CYCLE[r.cycle as Cycle] : a.cycleBrut,
          administratif: r?.cycle === 'ADMINISTRATION',
          // Catégorie et échelle seulement si elles sont les mêmes pour tout le lot
          categorie: classes.length === 1 ? (r?.categorie ?? null) : null,
          echelle: classes.length === 1 ? (r?.echelle ?? null) : null,
          categories: [
            ...new Set(g.map((f) => regleDe(f)?.categorie).filter(Boolean)),
          ],
          lot: a.lotCommission,
          lignes: g.map((f, i) => ({
            n: i + 1,
            nomComplet: f.nomComplet,
            dateNaissance: f.dateNaissance ?? f.dateNaissanceBrute,
            lieuNaissance: f.lieuNaissance,
            diplome: regleDe(f)?.libelle ?? f.diplomeBrut,
            departement: f.departement?.nom ?? f.departementBrut,
            source: f.source,
          })),
        };
      }),
    };
  }

  /**
   * Modèle Excel à remettre à une institution : mêmes intitulés que l'import, listes
   * déroulantes pour le diplôme et le département (feuilles masquées, non lues).
   */
  async modeleListe(): Promise<Buffer> {
    const regles = (await this.regles.find()).sort((a, b) =>
      a.libelle.localeCompare(b.libelle, 'fr'),
    );
    const deps = (await this.deps.find()).sort((a, b) =>
      a.nom.localeCompare(b.nom, 'fr'),
    );
    const wb = new ExcelJS.Workbook();
    wb.creator = 'DGRHAS';
    const colonnes: [string, number, string][] = [
      ['Quota', 9, 'Obligatoire — année de recrutement, ex. 2026'],
      ["N° d'ordre", 9, 'Facultatif — donné automatiquement si vide'],
      [
        'Noms et prénoms',
        34,
        'Obligatoire — NOM en majuscules, puis les prénoms',
      ],
      ['Date de nais.', 14, 'Obligatoire — jj/mm/aaaa'],
      ['Lieu de nais.', 18, 'Facultatif'],
      ['Diplôme', 22, 'Obligatoire — choisir dans la liste'],
      ['Département', 18, "Obligatoire — département d'affectation"],
      ['Statut', 14, 'Ex. Volontaire, Communautaire'],
      ['Lot', 10, 'Lot de la commission, ex. Lot 1'],
      ['Lieu de service', 22, 'Facultatif'],
      ['Origine', 24, 'Institution ou service qui envoie la liste'],
      ['Date de dépôt', 14, 'Facultatif — jj/mm/aaaa'],
      ['Observation', 28, 'Facultatif'],
    ];
    const ws = wb.addWorksheet('Liste des candidats', {
      views: [{ showGridLines: true }],
    });
    ws.columns = colonnes.map(([, largeur]) => ({ width: largeur }));
    ws.addRow(['LISTE DES CANDIDATS À ENVOYER À LA FONCTION PUBLIQUE']).font = {
      bold: true,
      size: 12,
    };
    ws.addRow([
      'Une ligne par personne. Ne pas modifier les intitulés de la ligne 4. La ligne 3 explique chaque colonne.',
    ]).font = { italic: true, size: 9, color: { argb: 'FF666666' } };
    const aide = ws.addRow(colonnes.map(([, , a]) => a));
    aide.font = { italic: true, size: 8, color: { argb: 'FF666666' } };
    aide.alignment = { wrapText: true, vertical: 'top' };
    aide.height = 36;
    const entete = ws.addRow(colonnes.map(([t]) => t));
    entete.eachCell((c, n) => {
      c.font = { bold: true, size: 10 };
      c.alignment = {
        horizontal: 'center',
        vertical: 'middle',
        wrapText: true,
      };
      c.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: {
          argb: [1, 3, 4, 6, 7].includes(n) ? 'FFFDE68A' : 'FFE2EFDA',
        },
      };
      c.border = {
        top: { style: 'thin' },
        bottom: { style: 'thin' },
        left: { style: 'thin' },
        right: { style: 'thin' },
      };
    });
    // Listes déroulantes
    const listes = wb.addWorksheet('Listes', { state: 'veryHidden' });
    regles.forEach((r, k) => (listes.getCell(k + 1, 1).value = r.libelle));
    deps.forEach((d, k) => (listes.getCell(k + 1, 2).value = d.nom));
    for (let ligne = 5; ligne <= 1004; ligne++) {
      ws.getCell(ligne, 6).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [`Listes!$A$1:$A$${Math.max(regles.length, 1)}`],
        showErrorMessage: true,
        errorTitle: 'Diplôme',
        error: 'Choisissez un diplôme de la liste.',
      };
      ws.getCell(ligne, 7).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [`Listes!$B$1:$B$${Math.max(deps.length, 1)}`],
      };
      ws.getCell(ligne, 4).numFmt = 'dd/mm/yyyy';
      ws.getCell(ligne, 12).numFmt = 'dd/mm/yyyy';
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  /* --------------- Budget dépassé : mettre à part pour le quota suivant --------------- */

  /**
   * Dossiers validés mais pas encore envoyés, mis à part par le DG (budget ou quota
   * dépassé) : ils passent au quota suivant, où ils partiront en priorité.
   */
  async reporter(u: UtilisateurConnecte, ids: string[], motif: string) {
    if (!ids?.length)
      throw new BadRequestException('Choisissez au moins un dossier.');
    if (!motif?.trim())
      throw new BadRequestException(
        'Écrivez pourquoi ces dossiers sont mis à part.',
      );
    const fiches = await this.agents.find({
      where: { id: In(ids) },
      loadEagerRelations: false,
    });
    for (const f of fiches) {
      if (f.transmissionNumero)
        throw new BadRequestException(
          `${f.nomComplet} est déjà envoyé à la FP : mettez-le de côté depuis l’onglet 4.`,
        );
      if (!f.quota)
        throw new BadRequestException(`${f.nomComplet} n’a pas de quota.`);
    }
    fiches.sort((a, b) => a.nomNormalise.localeCompare(b.nomNormalise));
    for (const f of fiches)
      await this.agents.update(f.id, {
        reporteDe: f.reporteDe ?? f.quota,
        ...(await this.placeDansQuota(f, f.quota! + 1)),
        reportMotif: motif.trim(),
        reportePar: u.nom,
        reporteLe: new Date(),
      });
    await this.journal.log(u, 'REPORT_QUOTA', undefined, null, {
      fiches: fiches.length,
      de: fiches[0]?.quota,
      vers: (fiches[0]?.quota ?? 0) + 1,
      motif: motif.trim(),
    });
    return { fiches: fiches.length };
  }

  /**
   * Quota, lot de la commission et n° d'ordre d'un dossier qui change de quota : le lot
   * conseillé (premier lot compatible pas plein, sinon un nouveau) et le n° suivant.
   */
  private async placeDansQuota(f: Agent, quota: number) {
    const l = await this.lots(quota, f.statut, f.diplomeCode, f.id, f.feuille);
    return {
      quota,
      lotCommission: l.conseille.lot,
      lotNature: l.conseille.nature,
      numeroOrdre: await this.prochainNumero(f.feuille, quota),
    };
  }

  /** Annule le report : le dossier revient dans son quota d'origine. */
  async annulerReport(u: UtilisateurConnecte, id: string) {
    const f = await this.agents.findOne({
      where: { id },
      loadEagerRelations: false,
    });
    if (!f?.reporteDe)
      throw new BadRequestException('Ce dossier n’a pas été reporté.');
    if (f.transmissionNumero)
      throw new BadRequestException(
        'Ce dossier est déjà parti avec le nouveau quota.',
      );
    await this.agents.update(id, {
      ...(await this.placeDansQuota(f, f.reporteDe)),
      reporteDe: null,
      reportMotif: null,
      reportePar: null,
      reporteLe: null,
    });
    await this.journal.log(u, 'ANNULATION_REPORT', 'agent', id, {
      quota: f.reporteDe,
    });
    return { ok: true };
  }

  /* ------------------------- Membres de la commission ------------------------- */

  /** Membres d'un quota avec l'usage de leurs places. */
  async membresCommission(quota: number) {
    const liste = await this.membres.find({
      where: { quota },
      order: { nom: 'ASC' },
    });
    const usage = await this.agents.query<
      { id: string; saisis: number; valides: number; envoyes: number }[]
    >(
      `SELECT "membreCommissionId" AS id, count(*)::int AS saisis,
         count(*) FILTER (WHERE "etatFiche" = 'VALIDEE')::int AS valides,
         count(*) FILTER (WHERE "transmissionNumero" IS NOT NULL)::int AS envoyes
       FROM agent WHERE "membreCommissionId" IS NOT NULL AND quota = $1 GROUP BY 1`,
      [quota],
    );
    return liste.map((m) => {
      const u = usage.find((x) => x.id === m.id);
      const saisis = u?.saisis ?? 0;
      return {
        ...m,
        saisis,
        valides: u?.valides ?? 0,
        envoyes: u?.envoyes ?? 0,
        restantes: m.places - saisis,
        depasse: saisis > m.places,
      };
    });
  }

  async enregistrerMembre(
    u: UtilisateurConnecte,
    id: string | null,
    dto: {
      quota: number;
      nom: string;
      fonction?: string | null;
      places: number;
    },
  ) {
    const nom = dto.nom?.replace(/\s+/g, ' ').trim();
    if (!nom) throw new BadRequestException('Écrivez le nom du membre.');
    if (!(dto.places >= 0))
      throw new BadRequestException('Indiquez le nombre de places.');
    // Les membres se partagent les places de la commission (quota réajusté, Pilotage)
    const pourCommission = await this.beneficiaires.placesCommission(
      String(dto.quota),
    );
    if (pourCommission > 0) {
      const autres = (await this.membres.find({ where: { quota: dto.quota } }))
        .filter((m) => m.id !== id)
        .reduce((t, m) => t + m.places, 0);
      if (autres + Math.round(dto.places) > pourCommission)
        throw new BadRequestException(
          `La commission a ${pourCommission} place(s) dans le quota ${dto.quota} (Pilotage › Bénéficiaires du quota). ${autres} sont déjà données aux autres membres : il en reste ${Math.max(0, pourCommission - autres)} pour ce membre.`,
        );
    }
    const valeurs = {
      quota: dto.quota,
      nom,
      fonction: dto.fonction?.trim() || null,
      places: Math.round(dto.places),
      modifiePar: u.nom,
    };
    const m = id
      ? await this.membres.save({
          ...(await this.membres.findOneOrFail({ where: { id } })),
          ...valeurs,
        })
      : await this.membres.save(this.membres.create(valeurs));
    await this.journal.log(
      u,
      id ? 'MEMBRE_COMMISSION_MODIFIE' : 'MEMBRE_COMMISSION_AJOUTE',
      'membre_commission',
      m.id,
      {
        quota: m.quota,
        places: m.places,
      },
    );
    return m;
  }

  async supprimerMembre(u: UtilisateurConnecte, id: string) {
    const n = await this.agents.count({ where: { membreCommissionId: id } });
    if (n)
      throw new BadRequestException(
        `Ce membre a déjà ${n} dossier(s) : changez d’abord leur origine, ou mettez ses places à 0.`,
      );
    await this.membres.delete(id);
    await this.journal.log(
      u,
      'MEMBRE_COMMISSION_SUPPRIME',
      'membre_commission',
      id,
      {},
    );
    return { ok: true };
  }
}
