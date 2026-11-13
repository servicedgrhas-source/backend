import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import type { LigneVolontaire } from './export-volontaires';
import type { UtilisateurConnecte } from '../auth/auth';
import { lireClasseur, lireFeuilleBrute, type Ligne } from '../common/excel';
import { IndexNoms } from '../common/index-noms';
import { MOIS_RE } from '../common/mois';
import { codeDepartement } from '../common/referentiels';
import { motsCommuns, motsDuNom, ressemblance } from '../common/ressemblance';
import {
  ageRevolu,
  cleCompacte,
  enTexte,
  lireDate,
  nettoyer,
  normaliser,
} from '../common/texte';
import { JournalService } from '../core/core.service';
import { Departement, MouvementVolontaire, Volontaire } from '../entities';
import { BourseService, LISTES, populationDe } from './bourse.service';
import { LiaisonVolontairesService } from '../recensement/liaison-volontaires.service';
import {
  categorieCommunautaire,
  ConfigEnrolementService,
} from './configuration';

export interface FiltresVolontaires {
  population?: string;
  /** Numéro de vague ; null : vague inconnue (non reconnue ou vide). */
  vague?: number | null;
  recherche?: string;
  statut?: string;
  departementId?: number;
  categorie?: string;
  motif?: string;
  page?: number;
  taille?: number;
}

/** Champs modifiables d'une fiche (tout le reste passe par une sortie ou une réintégration). */
export interface VolontaireDto {
  /** VOLONTAIRE ou COMMUNAUTAIRE (à la création seulement). */
  population?: string;
  nomComplet?: string;
  dateNaissance?: string | null;
  lieuNaissance?: string | null;
  telephone?: string | null;
  diplome?: string | null;
  specialite?: string | null;
  categorie?: string | null;
  departementId?: number | null;
  etablissement?: string | null;
  vague?: string | null;
  noteReference?: string | null;
  dateNote?: string | null;
  datePriseService?: string | null;
  premierMois?: string | null;
  observation?: string | null;
}

const CHAMPS: (keyof VolontaireDto)[] = [
  'nomComplet',
  'dateNaissance',
  'lieuNaissance',
  'telephone',
  'diplome',
  'specialite',
  'categorie',
  'departementId',
  'etablissement',
  'vague',
  'noteReference',
  'dateNote',
  'datePriseService',
  'premierMois',
  'observation',
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Champs que l'on peut corriger en série (libellé → colonne). */
const CHAMPS_EN_SERIE: Record<string, string> = {
  vague: 'vague',
  etablissement: 'etablissement',
  specialite: 'specialite',
  lieuNaissance: 'lieuNaissance',
};

/** Enrôlés d'une note d'enrôlement signée qui ne sont pas encore dans le registre. */
const DEPUIS_ENROLES_A_INTEGRER = `FROM enrole e JOIN note_service n ON n.id = e."noteId"
   WHERE n.module = 'ENROLEMENT' AND n.statut = 'SIGNEE'
     AND NOT EXISTS (SELECT 1 FROM volontaire v WHERE v."enroleId" = e.id)`;
const SQL_ENROLES_A_INTEGRER = `SELECT e.*, e."dateNaissance"::text AS "naissance", n.numero AS "noteNumero",
       n."dateSignature"::text AS "noteDate",
       (SELECT c.annee FROM campagne_enrolement c WHERE c.id = e."campagneId") AS "campagneAnnee"
       ${DEPUIS_ENROLES_A_INTEGRER} ORDER BY e."nomNormalise"`;

/** « 7è Vague », « 7é vague », « 7e Vague » → « 7e vague » ; « 2018-2019 » inchangé. */
export function vagueNormalisee(brut: unknown): string | null {
  const s = nettoyer(brut);
  if (!s) return null;
  const v = /^(\d{1,2})\s*(?:e|è|é|ème|eme|ere|ère|er)?\s*vague$/i.exec(s);
  if (v) return `${v[1]}${v[1] === '1' ? 're' : 'e'} vague`;
  return s;
}

/** Rubriques qu'une réimportation peut compléter, et leur nom à l'écran (07/11/2026). */
export const CHAMPS_MISE_A_JOUR: Record<string, string> = {
  dateNaissance: 'Date de naissance',
  lieuNaissance: 'Lieu de naissance',
  genre: 'Sexe',
  telephone: 'Téléphone',
  diplome: 'Diplôme',
  specialite: 'Spécialité',
  cycleBrut: 'Cycle',
  departementId: 'Département',
  etablissement: 'Établissement',
  circonscription: 'Circonscription',
  datePriseService: 'Date de prise de service',
  vague: 'Vague',
};

@Injectable()
export class VolontairesService implements OnModuleInit {
  constructor(
    @InjectRepository(Volontaire)
    private readonly volontaires: Repository<Volontaire>,
    @InjectRepository(MouvementVolontaire)
    private readonly mouvements: Repository<MouvementVolontaire>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    private readonly config: ConfigEnrolementService,
    private readonly journal: JournalService,
    private readonly liaison: LiaisonVolontairesService,
  ) {}

  /** Numéro de vague des fiches qui n'en ont pas encore (vague écrite avant la numérotation). */
  async onModuleInit() {
    try {
      const sans = await this.volontaires.find({
        where: { vagueNumero: IsNull(), vague: Not(IsNull()) },
        select: { id: true, vague: true },
      });
      for (const v of sans) {
        const n = this.config.numeroVague(v.vague);
        if (n !== null) await this.volontaires.update(v.id, { vagueNumero: n });
      }
    } catch (e) {
      new Logger('Volontaires').warn(
        `Numérotation des vagues : ${(e as Error).message}`,
      );
    }
  }

  /** Base du personnel : chaque volontaire y a sa fiche, tenue à jour après chaque changement du registre. */
  private async lier() {
    try {
      await this.liaison.miseAJour();
    } catch (e) {
      // Le registre reste juste même si la base du personnel n'a pas pu suivre : elle rattrapera au prochain passage
      new Logger('Personnel').error(
        `Liaison registre → personnel : ${(e as Error).message}`,
      );
    }
  }

  /* ------------------------------- Lecture ------------------------------- */

  /** La requête filtrée de la liste (écran, impression, export). */
  private requete(f: FiltresVolontaires) {
    const q = this.volontaires.createQueryBuilder('v');
    for (const [i, mot] of (f.recherche ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 6)
      .entries())
      q.andWhere(
        `(v.nomNormalise LIKE :m${i} OR coalesce(v.telephone, '') LIKE :t${i} OR coalesce(v.etablissement, '') ILIKE :e${i})`,
        {
          [`m${i}`]: `%${normaliser(mot).replace(/[\\%_]/g, '\\$&')}%`,
          [`t${i}`]: `%${mot.replace(/[\\%_]/g, '\\$&')}%`,
          [`e${i}`]: `%${mot.replace(/[\\%_]/g, '\\$&')}%`,
        },
      );
    q.andWhere('v.population = :p', { p: populationDe(f.population) });
    if (f.vague === null) q.andWhere('v.vagueNumero IS NULL');
    else if (f.vague !== undefined && Number.isFinite(f.vague))
      q.andWhere('v.vagueNumero = :vg', { vg: f.vague });
    if (f.statut) q.andWhere('v.statut = :s', { s: f.statut });
    if (f.departementId)
      q.andWhere('v.departementId = :d', { d: f.departementId });
    if (f.categorie === '-') q.andWhere('v.categorie IS NULL');
    else if (f.categorie) q.andWhere('v.categorie = :c', { c: f.categorie });
    if (f.motif) q.andWhere('v.motifSortie = :mo', { mo: f.motif });
    return q;
  }

  /**
   * Toute la liste filtrée, avec les libellés (catégorie, département, motif de sortie…), pour
   * l'imprimer ou l'exporter (06/11/2026). 20 000 personnes au plus.
   */
  async listeComplete(f: FiltresVolontaires): Promise<LigneVolontaire[]> {
    const lignes = await this.requete(f)
      .orderBy('v.nomNormalise', 'ASC')
      .take(20000)
      .getMany();
    const deps = new Map(
      (await this.deps.find()).map((d) => [d.id, d.nom] as const),
    );
    const date = (d: string | null) =>
      d ? d.split('-').reverse().join('/') : '';
    const mois = (m: string | null) =>
      m ? `${m.slice(5, 7)}/${m.slice(0, 4)}` : '';
    return lignes.map((v) => ({
      nomComplet: v.nomComplet,
      naissance: [date(v.dateNaissance), v.lieuNaissance]
        .filter(Boolean)
        .join(' à '),
      telephone: v.telephone ?? '',
      diplome: v.diplome ?? '',
      specialite: v.specialite ?? '',
      categorie:
        this.config.categorie(v.categorie, v.population)?.libelle ??
        v.cycleBrut ??
        '',
      departement:
        (v.departementId ? deps.get(v.departementId) : null) ??
        v.departementBrut ??
        '',
      etablissement: v.etablissement ?? '',
      vague:
        v.vagueNumero != null
          ? `${v.vagueNumero}${v.vagueNumero === 1 ? 're' : 'e'} vague`
          : (v.vague ?? ''),
      note: [v.noteReference, v.dateNote ? `du ${date(v.dateNote)}` : '']
        .filter(Boolean)
        .join(' '),
      priseService: date(v.datePriseService),
      payeDepuis: mois(v.premierMois),
      statut:
        v.statut === 'SORTI'
          ? `Sorti : ${this.config.motif(v.motifSortie)?.libelle ?? v.motifSortie ?? ''}${v.dateSortie ? ` (${date(v.dateSortie)})` : ''}`
          : 'En poste',
      observation: v.observation ?? '',
    }));
  }

  async liste(f: FiltresVolontaires) {
    const taille = Math.min(Math.max(f.taille ?? 50, 1), 200);
    const page = Math.max(f.page ?? 1, 1);
    const q = this.requete(f);
    const [lignes, total] = await q
      .orderBy('v.nomNormalise', 'ASC')
      .skip((page - 1) * taille)
      .take(taille)
      .getManyAndCount();
    const [resume] = await this.volontaires.query<Record<string, number>[]>(
      `SELECT count(*) FILTER (WHERE statut = 'EN_POSTE')::int AS "enPoste",
              count(*) FILTER (WHERE statut = 'SORTI')::int AS sortis,
              count(*) FILTER (WHERE statut = 'EN_POSTE' AND categorie IS NULL)::int AS "sansCategorie",
              count(*) FILTER (WHERE statut = 'EN_POSTE' AND "departementId" IS NULL)::int AS "sansDepartement"
         FROM volontaire WHERE population = $1`,
      [populationDe(f.population)],
    );
    // Volontaires en poste par vague (les plus anciennes sont recrutées d'abord)
    const vagues = await this.volontaires.query<
      { vague: number | null; enPoste: number }[]
    >(
      `SELECT "vagueNumero" AS vague, count(*)::int AS "enPoste" FROM volontaire
        WHERE population = 'VOLONTAIRE' AND statut = 'EN_POSTE' GROUP BY 1 ORDER BY 1 NULLS LAST`,
    );
    const [{ n: enAttente }] = await this.volontaires.query<{ n: number }[]>(
      `SELECT count(*)::int AS n ${DEPUIS_ENROLES_A_INTEGRER}`,
    );
    return {
      lignes,
      total,
      page,
      taille,
      resume: { ...resume, enAttente },
      vagues,
    };
  }

  async fiche(id: string) {
    const v = await this.volontaires.findOne({ where: { id } });
    if (!v) throw new NotFoundException('Volontaire introuvable');
    const mouvements = await this.mouvements.find({
      where: { volontaireId: id },
      order: { creeLe: 'DESC', id: 'DESC' },
    });
    // Ce qu'il a touché (bourse, mise en route) et ses régularisations
    const paiements = await this.volontaires.query<
      { genre: string; libelle: string; montant: number; statut: string }[]
    >(
      `SELECT 'BOURSE' AS genre, e.mois AS libelle, l.total AS montant, e.statut
         FROM ligne_bourse l JOIN etat_bourse e ON e.id = l."etatId" WHERE l."volontaireId" = $1
       UNION ALL
       SELECT 'MISE_EN_ROUTE', m.libelle, l.total, m.statut
         FROM ligne_mise_en_route l JOIN mise_en_route m ON m.id = l."miseEnRouteId" WHERE l."volontaireId" = $1
       ORDER BY 1, 2 DESC`,
      [id],
    );
    const regularisations = await this.volontaires.query<
      {
        id: number;
        type: string;
        montant: number;
        reste: number;
        motif: string;
        statut: string;
        creeLe: string;
      }[]
    >(
      `SELECT id, type, montant, reste, motif, statut, "creeLe" FROM regularisation WHERE "volontaireId" = $1 ORDER BY id DESC`,
      [id],
    );
    const personnel = await this.liaison.ficheDe(id).catch(() => null);
    return { volontaire: v, mouvements, paiements, regularisations, personnel };
  }

  /* ---------------- Prise en charge depuis la base du personnel ---------------- */

  /**
   * Chercher une personne à prendre en charge dans les bourses (DG, 13/11/2026) : on tape un nom,
   * un téléphone ou un matricule, la base du personnel répond avec ce qu'elle sait (pour remplir la
   * fiche du registre sans retaper), et, BIEN VISIBLE, la situation de chacun : déjà fonctionnaire
   * ou contractuel, déjà au registre des volontaires ou des communautaires (en poste, sorti), recruté
   * de la Fonction publique, ou volontaire/communautaire du personnel pas encore pris en charge.
   */
  async candidatsPriseEnCharge(
    q: string,
    population: string,
    agentId?: number | null,
  ) {
    const texte = (q ?? '').trim();
    const chiffres = texte.replace(/\D/g, '');
    const mots = normaliser(texte)
      .split(/\s+/)
      .filter((m) => m.length >= 2 && !/^\d+$/.test(m))
      .slice(0, 5);
    // Assez pour chercher : 3 lettres au moins, ou 6 chiffres (téléphone, matricule)
    const lettres = mots.join('').length;
    if (!agentId && lettres < 3 && chiffres.length < 6) return [];
    const pop = populationDe(population);
    const params: unknown[] = [];
    const conditions: string[] = [];
    // Depuis une fiche du personnel (« Prendre en charge dans la bourse ») : cette fiche-là
    if (agentId) {
      params.push(agentId);
      conditions.push(`a.id = $${params.length}`);
    } else if (mots.length)
      conditions.push(
        mots
          .map((m) => {
            params.push(`%${m.replace(/[\\%_]/g, '\\$&')}%`);
            return `a."nomNormalise" LIKE $${params.length}`;
          })
          .join(' AND '),
      );
    if (!agentId && chiffres.length >= 6) {
      params.push(`%${chiffres.slice(-8)}%`);
      conditions.push(
        `regexp_replace(coalesce(a.telephone, ''), '\\D', '', 'g') LIKE $${params.length} OR coalesce(a.matricule, '') LIKE $${params.length}`,
      );
    }
    const agents = await this.volontaires.query<
      {
        id: number;
        numeroFiche: string | null;
        statut: string;
        nomComplet: string;
        dateNaissance: string | null;
        matricule: string | null;
        telephone: string | null;
        departementId: number | null;
        structure: string | null;
        volontaireId: string | null;
        donnees: Record<string, unknown>;
      }[]
    >(
      `SELECT a.id, a."numeroFiche", a.statut, a."nomComplet", to_char(a."dateNaissance", 'YYYY-MM-DD') AS "dateNaissance",
              a.matricule, a.telephone, a."departementId", s.nom AS structure, a."volontaireId", a.donnees
         FROM agent_recense a LEFT JOIN structure s ON s.id = a."structureId"
        WHERE ${conditions.map((c) => `(${c})`).join(' OR ')}
        ORDER BY a."nomNormalise" LIMIT 25`,
      params,
    );
    if (!agents.length) return [];
    const deps = new Map((await this.deps.find()).map((d) => [d.id, d]));
    const codeDep = new Map([...deps.values()].map((d) => [d.code, d]));
    // Le registre : les fiches reliées, et celles du même nom (pas encore reliées)
    const motLong = (n: string) =>
      [...motsDuNom(n)].sort((a, b) => b.length - a.length)[0] ?? '';
    const longs = [...new Set(agents.map((a) => motLong(a.nomComplet)))].filter(
      Boolean,
    );
    const registre = longs.length
      ? await this.volontaires
          .createQueryBuilder('v')
          .where(
            `(${longs.map((_, i) => `v.nomNormalise LIKE :l${i}`).join(' OR ')}) OR v.id IN (:...lies)`,
            {
              ...Object.fromEntries(longs.map((l, i) => [`l${i}`, `%${l}%`])),
              lies: [
                '00000000-0000-0000-0000-000000000000',
                ...agents.map((a) => a.volontaireId).filter(Boolean),
              ],
            },
          )
          .getMany()
      : [];
    const parId = new Map(registre.map((v) => [v.id, v]));
    const indexRegistre = new IndexNoms<Volontaire>();
    for (const v of registre)
      indexRegistre.ajouter(v.nomComplet, v.dateNaissance, v);
    // Recrutés de la Fonction publique (base des recrutés)
    const recrutes = new IndexNoms<string>();
    if (longs.length)
      for (const r of await this.volontaires.query<
        {
          nomComplet: string;
          dateNaissance: string | null;
          quota: number | null;
          feuille: string;
        }[]
      >(
        `SELECT "nomComplet", to_char("dateNaissance", 'YYYY-MM-DD') AS "dateNaissance", quota, feuille
           FROM agent WHERE ${longs.map((_, i) => `"nomNormalise" LIKE $${i + 1}`).join(' OR ')} LIMIT 500`,
        longs.map((l) => `%${l}%`),
      ))
        recrutes.ajouter(
          r.nomComplet,
          r.dateNaissance,
          r.feuille === 'QUOTA_AUTRES'
            ? 'quota « Autres »'
            : `quota ${r.quota ?? '?'}`,
        );
    const t = (d: Record<string, unknown>, k: string) => {
      const x = d?.[k];
      return x === null || x === undefined || enTexte(x).trim() === ''
        ? null
        : enTexte(x).trim();
    };
    const dateFr = (d: string | null) =>
      d ? d.slice(0, 10).split('-').reverse().join('/') : '';
    const libelleListe = (p: string) =>
      p === 'COMMUNAUTAIRE' ? 'communautaires' : 'volontaires (bourse)';
    return agents.map((a) => {
      const d = a.donnees ?? {};
      const cycle = t(d, 'CYCLE');
      const specialite = t(d, 'SPECIALITE');
      const diplome = t(d, 'DIPLOME_PRO') ?? t(d, 'DIPLOME');
      const depCode = t(d, 'DEPARTEMENT');
      const departement =
        (a.departementId ? deps.get(a.departementId) : undefined) ??
        (depCode ? codeDep.get(depCode) : undefined) ??
        null;
      // Le cycle proposé pour chacune des deux listes
      const categorie = (p: string) =>
        p === 'COMMUNAUTAIRE'
          ? (categorieCommunautaire(
              this.config,
              cycle,
              specialite,
              'COMMUNAUTAIRE',
            )?.code ?? null)
          : (this.config.categorieDepuisTexte(
              `${diplome ?? ''} ${cycle ?? ''}`,
              'VOLONTAIRE',
            )?.code ?? null);
      // La situation, du plus grave au plus simple
      const situation: {
        ton: 'rouge' | 'orange' | 'vert';
        titre: string;
        detail?: string;
      }[] = [];
      if (a.statut === 'FONCTIONNAIRE' || a.statut === 'CONTRACTUEL')
        situation.push({
          ton: 'rouge',
          titre: `DÉJÀ ${a.statut === 'FONCTIONNAIRE' ? 'FONCTIONNAIRE' : 'CONTRACTUEL(LE)'}`,
          detail: `Dans la base du personnel${a.matricule ? `, matricule ${a.matricule}` : ''} : il est payé à la solde, pas par une bourse.`,
        });
      const recrute = recrutes.probables(a.nomComplet, a.dateNaissance)[0];
      if (recrute)
        situation.push({
          ton: 'rouge',
          titre: 'RECRUTÉ(E) À LA FONCTION PUBLIQUE',
          detail: `Dans la base des recrutés (${recrute}).`,
        });
      const lie = a.volontaireId ? parId.get(a.volontaireId) : undefined;
      const memes = lie
        ? [lie]
        : indexRegistre.probables(a.nomComplet, a.dateNaissance);
      for (const v of memes.slice(0, 2)) {
        const sorti = v.statut === 'SORTI';
        situation.push({
          ton: 'orange',
          titre: `DÉJÀ AU REGISTRE DES ${libelleListe(v.population).toUpperCase()} — ${sorti ? 'SORTI(E)' : 'EN POSTE, PAYÉ(E)'}`,
          detail: sorti
            ? `Sorti(e) le ${dateFr(v.dateSortie)} (${this.config.motif(v.motifSortie)?.libelle ?? v.motifSortie ?? 'motif ?'}) : pour le reprendre, ouvrez sa fiche et réintégrez-le, au lieu de créer une autre fiche.`
            : `Déjà payé(e) sur la liste des ${libelleListe(v.population)}${lie ? '' : ' (fiche du même nom, pas encore reliée)'} : ne l’ajoutez pas une deuxième fois.`,
        });
      }
      if (!situation.length)
        situation.push({
          ton: 'vert',
          titre:
            a.statut === 'COMMUNAUTAIRE'
              ? 'COMMUNAUTAIRE DANS LE PERSONNEL — PAS PRIS EN CHARGE DANS LES BOURSES'
              : a.statut === 'VOLONTAIRE'
                ? 'VOLONTAIRE DANS LE PERSONNEL — PAS PRIS EN CHARGE DANS LES BOURSES'
                : `${a.statut} DANS LE PERSONNEL — PAS PRIS EN CHARGE DANS LES BOURSES`,
          detail:
            'Il n’est sur aucune des deux listes payées : il peut être pris en charge.',
        });
      const listeConseillee =
        a.statut === 'COMMUNAUTAIRE'
          ? 'COMMUNAUTAIRE'
          : a.statut === 'VOLONTAIRE'
            ? 'VOLONTAIRE'
            : null;
      if (listeConseillee && listeConseillee !== pop && !memes.length)
        situation.push({
          ton: 'orange',
          titre: `AU PERSONNEL COMME ${listeConseillee === 'COMMUNAUTAIRE' ? 'COMMUNAUTAIRE' : 'VOLONTAIRE'}`,
          detail: `Vous l’ajoutez à la liste des ${libelleListe(pop)} : vérifiez que c’est bien la bonne liste.`,
        });
      const lieu = t(d, 'LIEU_SERVICE') ?? a.structure;
      return {
        agentRecenseId: a.id,
        numeroFiche: a.numeroFiche,
        statut: a.statut,
        matricule: a.matricule,
        dejaRelie: !!lie,
        situation,
        // Le plus grave : rouge (ne pas prendre en charge), orange (déjà quelque part), vert
        ton: situation.some((s) => s.ton === 'rouge')
          ? 'rouge'
          : situation.some((s) => s.ton === 'orange')
            ? 'orange'
            : 'vert',
        registreId: memes[0]?.id ?? null,
        // Ce qui remplit la fiche du registre
        valeurs: {
          nomComplet: a.nomComplet,
          dateNaissance: a.dateNaissance,
          lieuNaissance: t(d, 'LIEU_NAISSANCE'),
          telephone: a.telephone ?? t(d, 'TELEPHONE_1'),
          diplome,
          specialite,
          categorie: categorie(pop),
          cycleBrut: cycle,
          departementId: departement?.id ?? null,
          departement: departement?.nom ?? null,
          etablissement: lieu,
          datePriseService: t(d, 'DATE_PRISE_SERVICE')?.slice(0, 10) ?? null,
        },
      };
    });
  }

  /* ------------------------------ Entrées ------------------------------ */

  /**
   * Ajout à la main d'un volontaire (reprise d'un oubli, dossier arrivé hors liste).
   * Une personne probablement déjà dans le registre est refusée, sauf confirmation (`forcer`).
   */
  async creer(
    u: UtilisateurConnecte,
    dto: VolontaireDto & {
      forcer?: boolean;
      /** Fiche de la base du personnel d'où vient la prise en charge (13/11/2026) : reliée tout de suite. */
      agentRecenseId?: number;
      /** Elle est fonctionnaire ou contractuelle et on la prend en charge quand même (confirmé). */
      forcerFonctionnaire?: boolean;
    },
  ) {
    const nom = (dto.nomComplet ?? '').replace(/\s+/g, ' ').trim();
    if (motsDuNom(nom).length < 2)
      throw new BadRequestException('Écrivez le nom et au moins un prénom.');
    // La fiche du personnel choisie : un fonctionnaire ou un contractuel n'est pas pris en charge
    // sans le dire, et une fiche déjà reliée au registre ne l'est pas deux fois
    const agentId =
      typeof dto.agentRecenseId === 'number' ? dto.agentRecenseId : null;
    if (agentId) {
      const [a] = await this.volontaires.query<
        { statut: string; volontaireId: string | null }[]
      >(`SELECT statut, "volontaireId" FROM agent_recense WHERE id = $1`, [
        agentId,
      ]);
      if (!a) throw new BadRequestException('Fiche du personnel introuvable.');
      if (a.volontaireId)
        throw new BadRequestException(
          'Cette fiche du personnel est déjà reliée à une fiche du registre : ouvrez celle-ci au lieu d’en créer une autre.',
        );
      if (
        ['FONCTIONNAIRE', 'CONTRACTUEL'].includes(a.statut) &&
        !dto.forcerFonctionnaire
      )
        throw new BadRequestException(
          `Cette personne est ${a.statut === 'FONCTIONNAIRE' ? 'fonctionnaire' : 'contractuelle'} dans la base du personnel : confirmez la prise en charge si c’est voulu.`,
        );
    }
    if (!dto.forcer) {
      const index = new IndexNoms<Volontaire>();
      for (const v of await this.volontaires.find({
        select: {
          id: true,
          nomComplet: true,
          dateNaissance: true,
          statut: true,
        },
      }))
        index.ajouter(v.nomComplet, v.dateNaissance, v);
      const deja = index.probables(nom, dto.dateNaissance || null);
      const noms = deja
        .slice(0, 3)
        .map(
          (v) =>
            `${v.nomComplet} (${v.statut === 'EN_POSTE' ? 'en poste' : 'sorti'})`,
        )
        .join(', ');
      if (deja.length)
        throw new BadRequestException(
          `Déjà dans le registre : ${noms}. Ouvrez sa fiche, ou confirmez l’ajout s’il s’agit d’une autre personne.`,
        );
    }
    const v = await this.volontaires.save({
      population: populationDe(dto.population),
      nomComplet: nom,
      nomNormalise: normaliser(nom),
      statut: 'EN_POSTE',
      source: 'Saisie',
      creePar: u.nom,
      verifications: {},
    } as Volontaire);
    // Venue de la base du personnel : reliée tout de suite à SA fiche, avant tout le reste (la
    // liaison du registre créerait sinon une deuxième fiche du personnel, ex. pour un fonctionnaire)
    if (agentId)
      await this.volontaires.query(
        `UPDATE agent_recense SET "volontaireId" = $1 WHERE id = $2 AND "volontaireId" IS NULL`,
        [v.id, agentId],
      );
    await this.mouvement(u, v.id, 'ENTREE', null, 'SAISIE', null);
    // Les autres champs passent par les mêmes contrôles qu'une correction
    const {
      nomComplet: _n,
      forcer: _f,
      population: _p,
      agentRecenseId: _a,
      forcerFonctionnaire: _ff,
      ...reste
    } = dto;
    void _n;
    void _f;
    void _p;
    void _a;
    void _ff;
    try {
      await this.modifier(u, v.id, reste, false);
    } catch (e) {
      await this.volontaires.query(
        `UPDATE agent_recense SET "volontaireId" = NULL WHERE "volontaireId" = $1`,
        [v.id],
      );
      await this.mouvements.delete({ volontaireId: v.id });
      await this.volontaires.delete(v.id);
      throw e;
    }
    await this.lier();
    return this.fiche(v.id);
  }

  /** Nombre d'enrôlés de notes signées pas encore dans le registre. */
  async enAttente() {
    return this.volontaires.query<Record<string, unknown>[]>(
      SQL_ENROLES_A_INTEGRER,
    );
  }

  /**
   * Les enrôlés des notes de service d'enrôlement signées entrent dans le registre :
   * leur bourse démarre selon la règle de la configuration (note ou prise de service).
   */
  async integrerNotes(u: UtilisateurConnecte) {
    const lignes = await this.enAttente();
    const deps = new Map(
      (await this.deps.find()).map((d) => [d.id, d] as const),
    );
    let ajoutes = 0;
    const sansCategorie: string[] = [];
    const relies: string[] = [];
    // Un enrôlé déjà repris d'une liste de bourse (même personne probable) est relié à sa
    // fiche au lieu d'être créé une deuxième fois
    const index = new IndexNoms<Volontaire>();
    for (const v of await this.volontaires.find())
      if (!v.enroleId) index.ajouter(v.nomComplet, v.dateNaissance, v);
    for (const e of lignes) {
      const diplome = enTexte(e.diplome);
      const cycle = (e.cycle as string | null) ?? null;
      // Le diplôme passe avant le cycle : un DEMA enseigne au collège mais relève des Beaux-Arts
      const cat = this.config.categorieDepuisTexte(`${diplome} ${cycle ?? ''}`);
      const nom = enTexte(e.nomComplet);
      const naissance = enTexte(e.naissance) || null;
      const deja = index.probables(nom, naissance).filter((x) => !x.enroleId);
      if (deja.length === 1) {
        const x = deja[0];
        x.enroleId = enTexte(e.id);
        await this.volontaires.update(x.id, {
          enroleId: x.enroleId,
          noteReference: x.noteReference ?? (enTexte(e.noteNumero) || null),
          dateNote: x.dateNote ?? (enTexte(e.noteDate) || null),
          dateNaissance: x.dateNaissance ?? naissance,
        });
        await this.mouvements.save({
          volontaireId: x.id,
          type: 'MODIFICATION',
          dateEffet: null,
          motif: 'NOTE',
          details: { note: enTexte(e.noteNumero), relie: 'enrôlé de la note' },
          par: u.nom,
        });
        relies.push(`${nom} ↔ ${x.nomComplet}`);
        continue;
      }
      if (!cat) sansCategorie.push(nom);
      const depId = (e.departementRetenuId as number | null) ?? null;
      const annee = Number(e.campagneAnnee) || null;
      const vagueNumero = annee ? this.config.numeroVague(annee) : null;
      const v = await this.volontaires.save({
        population: 'VOLONTAIRE',
        vagueNumero,
        vague: vagueNumero
          ? `${vagueNumero}${vagueNumero === 1 ? 're' : 'e'} vague (${annee})`
          : null,
        nomComplet: nom,
        nomNormalise: normaliser(nom),
        dateNaissance: naissance,
        lieuNaissance: (e.lieuNaissance as string | null) ?? null,
        telephone: (e.telephone as string | null) ?? null,
        diplome: diplome || null,
        specialite: (e.specialite as string | null) ?? null,
        categorie: cat?.code ?? null,
        cycleBrut: cycle,
        departementId: depId && deps.has(depId) ? depId : null,
        departementBrut: depId ? (deps.get(depId)?.nom ?? null) : null,
        etablissement: (e.etablissement as string | null) ?? null,
        noteReference: enTexte(e.noteNumero) || null,
        dateNote: enTexte(e.noteDate) || null,
        statut: 'EN_POSTE',
        enroleId: enTexte(e.id),
        source: `Note d’enrôlement n° ${enTexte(e.noteNumero) || '?'}`,
        creePar: u.nom,
        verifications: {},
      } as Volontaire);
      await this.mouvements.save({
        volontaireId: v.id,
        type: 'ENTREE',
        dateEffet: v.dateNote,
        motif: 'NOTE',
        details: { note: v.noteReference },
        par: u.nom,
      });
      ajoutes++;
    }
    if (ajoutes || relies.length)
      await this.journal.log(u, 'VOLONTAIRES_INTEGRES', 'volontaire', null, {
        ajoutes,
        relies: relies.length,
      });
    await this.lier();
    return { ajoutes, relies, sansCategorie };
  }

  /* ------------------------------ Changements ------------------------------ */

  async modifier(
    u: UtilisateurConnecte,
    id: string,
    dto: VolontaireDto,
    tracer = true,
  ) {
    const v = await this.volontaires.findOne({ where: { id } });
    if (!v) throw new NotFoundException('Volontaire introuvable');
    const maj: Partial<Volontaire> = {};
    const avant: Record<string, unknown> = {};
    for (const k of CHAMPS) {
      if (!(k in dto)) continue;
      let val: unknown = dto[k];
      if (typeof val === 'string')
        val = val.replace(/\s+/g, ' ').trim() || null;
      const txt = enTexte(val);
      if (k === 'nomComplet') {
        if (!val || motsDuNom(txt).length < 2)
          throw new BadRequestException(
            'Écrivez le nom et au moins un prénom.',
          );
      }
      if (
        ['dateNaissance', 'dateNote', 'datePriseService'].includes(k) &&
        val &&
        !DATE_RE.test(txt)
      )
        throw new BadRequestException('Date attendue (AAAA-MM-JJ).');
      if (k === 'premierMois' && val && !MOIS_RE.test(txt))
        throw new BadRequestException(
          'Premier mois payé attendu sous la forme AAAA-MM.',
        );
      if (k === 'categorie' && val && !this.config.categorie(txt, v.population))
        throw new BadRequestException(
          'Catégorie de bourse inconnue (voir la configuration).',
        );
      if (k === 'departementId' && val !== null && val !== undefined) {
        val = Number(val);
        if (!(await this.deps.exist({ where: { id: val as number } })))
          throw new BadRequestException('Département inconnu.');
      }
      if ((v as unknown as Record<string, unknown>)[k] !== val) {
        avant[k] = (v as unknown as Record<string, unknown>)[k];
        (maj as Record<string, unknown>)[k] = val;
      }
    }
    if (!Object.keys(maj).length) return v;
    if (maj.nomComplet) maj.nomNormalise = normaliser(maj.nomComplet);
    if (maj.vague !== undefined) {
      maj.vague = vagueNormalisee(maj.vague);
      maj.vagueNumero = this.config.numeroVague(maj.vague);
    }
    await this.volontaires.update(id, maj);
    if (tracer)
      await this.mouvement(u, id, 'MODIFICATION', null, null, {
        avant,
        apres: maj,
      });
    await this.lier();
    return this.volontaires.findOneOrFail({ where: { id } });
  }

  /** Sortie (recruté, déserteur…) : la bourse s'arrête selon la règle du motif. */
  /**
   * Sortie de plusieurs volontaires d'un coup, avec le même motif et la même date (DG, 27/10/2026 :
   * les « Déjà recruté à la FP » des contrôles de la bourse, cochés comme au pointage du bottin).
   */
  async sortirPlusieurs(
    u: UtilisateurConnecte,
    dto: {
      ids: string[];
      motif: string;
      date: string;
      observation?: string;
      /** Observation propre à chacun (ce que le contrôle a retrouvé). */
      observations?: Record<string, string>;
    },
  ) {
    const ids = Array.isArray(dto?.ids) ? [...new Set(dto.ids)] : [];
    if (!ids.length)
      throw new BadRequestException('Cochez les volontaires à sortir.');
    if (ids.length > 1000)
      throw new BadRequestException('1 000 volontaires au plus à la fois.');
    const res = { sortis: 0, erreurs: [] as string[] };
    for (const id of ids) {
      try {
        await this.sortir(
          u,
          id,
          { ...dto, observation: dto.observations?.[id] ?? dto.observation },
          false,
        );
        res.sortis++;
      } catch (e) {
        res.erreurs.push((e as Error).message);
      }
    }
    if (res.sortis) await this.lier();
    return res;
  }

  async sortir(
    u: UtilisateurConnecte,
    id: string,
    dto: { motif: string; date: string; observation?: string },
    lier = true,
  ) {
    const v = await this.volontaires.findOne({ where: { id } });
    if (!v) throw new NotFoundException('Volontaire introuvable');
    if (v.statut === 'SORTI')
      throw new BadRequestException(
        lier
          ? 'Ce volontaire est déjà sorti.'
          : `${v.nomComplet} : déjà sorti.`,
      );
    const motif = this.config.motif(dto.motif);
    if (!motif || !motif.actif)
      throw new BadRequestException('Choisissez un motif de sortie.');
    if (!DATE_RE.test(dto.date ?? ''))
      throw new BadRequestException(
        'Indiquez la date de la sortie (prise en charge, abandon…).',
      );
    await this.volontaires.update(id, {
      statut: 'SORTI',
      motifSortie: motif.code,
      dateSortie: dto.date,
    });
    await this.mouvement(u, id, 'SORTIE', dto.date, motif.code, {
      observation: dto.observation?.trim() || null,
    });
    if (!lier) return null;
    await this.lier();
    return this.fiche(id);
  }

  /** Réintégration (« à rétablir ») : seulement pour un motif qui le permet. */
  async reintegrer(
    u: UtilisateurConnecte,
    id: string,
    dto: { date: string; observation?: string },
  ) {
    const v = await this.volontaires.findOne({ where: { id } });
    if (!v) throw new NotFoundException('Volontaire introuvable');
    if (v.statut !== 'SORTI')
      throw new BadRequestException('Ce volontaire est en poste.');
    const motif = this.config.motif(v.motifSortie);
    if (motif && !motif.reintegrable)
      throw new BadRequestException(
        `Sortie « ${motif.libelle} » : la configuration ne permet pas la réintégration.`,
      );
    if (!DATE_RE.test(dto.date ?? ''))
      throw new BadRequestException('Indiquez la date de reprise.');
    // La période déjà couverte avant la sortie est gardée : ses mois restent légitimement
    // payés (sinon le calcul des trop-perçus les verrait hors période)
    const c = this.config.get();
    const du = BourseService.premierMois(v, c);
    const au = BourseService.dernierMois(v, c, du);
    const periode =
      du && au && au !== '0000-01' && du <= au ? { du, au } : null;
    // La bourse reprend le mois de la reprise
    await this.volontaires.update(id, {
      statut: 'EN_POSTE',
      motifSortie: null,
      dateSortie: null,
      premierMois: dto.date.slice(0, 7),
    });
    await this.mouvement(u, id, 'REINTEGRATION', dto.date, v.motifSortie, {
      observation: dto.observation?.trim() || null,
      periode,
    });
    await this.lier();
    return this.fiche(id);
  }

  /** Contrôle vérifié à la main (« ce n'est pas la même personne ») : il ne bloque plus la bourse. */
  async verifier(
    u: UtilisateurConnecte,
    id: string,
    dto: { controle: string; note: string },
  ) {
    const v = await this.volontaires.findOne({ where: { id } });
    if (!v) throw new NotFoundException('Volontaire introuvable');
    const controle = String(dto.controle ?? '').toUpperCase();
    if (!/^[A-Z_]{3,30}$/.test(controle))
      throw new BadRequestException('Contrôle inconnu.');
    const note = dto.note?.trim();
    if (!note || note.length < 5)
      throw new BadRequestException(
        'Expliquez en quelques mots ce que vous avez vérifié (ex. « pas la même date de naissance, pièces vues »).',
      );
    const verifications = {
      ...(v.verifications ?? {}),
      [controle]: { par: u.nom, le: new Date().toISOString(), note },
    };
    await this.volontaires.update(id, { verifications });
    await this.mouvement(u, id, 'VERIFICATION', null, controle, { note });
    await this.lier();
    return this.fiche(id);
  }

  private async mouvement(
    u: UtilisateurConnecte,
    volontaireId: string,
    type: string,
    dateEffet: string | null,
    motif: string | null,
    details: object | null,
  ) {
    await this.mouvements.save({
      volontaireId,
      type,
      dateEffet,
      motif,
      details,
      par: u.nom,
    });
    await this.journal.log(
      u,
      `VOLONTAIRE_${type}`,
      'volontaire',
      volontaireId,
      {
        motif,
        dateEffet,
      },
    );
  }

  /**
   * Mettre à jour beaucoup de fiches d'un coup (communautaires, 13/11/2026 : 12 000 fiches une par
   * une prenaient trop de temps en ligne). Une requête par rubrique et par paquet de 2 000, dans
   * une transaction : tout est écrit, ou rien.
   */
  private async majEnLot(majs: { id: string; champs: Partial<Volontaire> }[]) {
    if (!majs.length) return;
    const parRubrique = new Map<string, { id: string; v: unknown }[]>();
    for (const { id, champs } of majs)
      for (const [k, v] of Object.entries(champs))
        parRubrique.set(k, [...(parRubrique.get(k) ?? []), { id, v }]);
    const colonnes = new Set(
      this.volontaires.metadata.columns.map((c) => c.propertyName),
    );
    await this.volontaires.manager.transaction(async (m) => {
      for (const [k, lignes] of parRubrique) {
        if (!colonnes.has(k))
          throw new BadRequestException(`Rubrique inconnue : ${k}`);
        for (let i = 0; i < lignes.length; i += 2000)
          await m.query(
            `UPDATE volontaire v
                SET "${k}" = (jsonb_populate_record(NULL::volontaire, x.j))."${k}",
                    "modifieLe" = now()
               FROM jsonb_array_elements($1::jsonb) AS x(j)
              WHERE v.id = (x.j->>'id')::uuid`,
            [
              JSON.stringify(
                lignes.slice(i, i + 2000).map((l) => ({ id: l.id, [k]: l.v })),
              ),
            ],
          );
      }
    });
  }

  /**
   * Les retraits d'un fichier de paiement : le motif de chacun, lu sur toute la ligne (les blocs
   * ajoutés en bas de la feuille n'ont pas les mêmes colonnes ; octobre 2026 : « RETIRE PAR LA
   * DDEPPSA » à droite, hors de la colonne « Obs. »). « SALARIE », « FONCTIONNAIRE » → recruté à la
   * Fonction publique ; sinon « Retiré par la DDEPPSA ».
   */
  private motifsDesRetraits(lignes: Ligne[] | null) {
    const cle = (nom: string) => motsDuNom(nom).sort().join(' ');
    const motif = new Map<string, string>();
    const ligne = new Map<string, number>();
    for (const l of lignes ? this.lignesPersonnes(lignes) : []) {
      const nom = nettoyer(
        this.valeur(l, ['NOMSETPRENOMS', 'NOMETPRENOMS', 'NOMSPRENOMS']),
      );
      if (!nom) continue;
      const t = normaliser(
        Object.entries(l)
          .filter(([k]) => k !== '_ligne' && !k.startsWith('NOM'))
          .map(([, x]) => enTexte(x))
          .join(' '),
      );
      ligne.set(cle(nom), Number(l._ligne));
      motif.set(
        cle(nom),
        /SALARI|SALAIRE|FONCTIONNAIRE|INTEGRE/.test(t)
          ? 'RECRUTE_FP'
          : /NON\s*PARTANT/.test(t)
            ? 'NON_PARTANT'
            : /DESERT|DERSET|ABANDON/.test(t)
              ? 'DESERTEUR'
              : /\bDECE(S|DE)/.test(t) // pas « DÉCEMBRE »
                ? 'DECES'
                : /DEMISSION/.test(t)
                  ? 'DEMISSION'
                  : /DOUBLON/.test(t)
                    ? 'DOUBLON'
                    : /ABSENT/.test(t)
                      ? 'ABSENT'
                      : 'RETIRE_DDEPPSA',
      );
    }
    return { motif, ligne };
  }

  /**
   * Rapprochement d'une liste reçue avec des fiches du registre (DG, 12/11/2026) :
   * 1. même nom (mots dans n'importe quel ordre, ou nom de la liste déjà rapproché une fois) ;
   * 2. nom écrit autrement, une seule fiche en poste qui ressemble et réciproquement : rapproché ;
   * 3. un seul nom différent (2 mots communs ou plus) : paire proposée, rapprochée seulement si
   *    l'agent l'a confirmée (`memes`).
   */
  private rapprocherListe<
    P extends {
      nom: string;
      cle: string;
      feuille: string;
      ligne: number;
      /** Date de naissance de la liste : départage deux homonymes (communautaires, 13/11/2026). */
      naissance?: string | null;
      /** Département de la ligne : départage aussi deux fiches du même nom. */
      departementId?: number | null;
    },
  >(uniques: P[], fiches: Volontaire[], memes: string[]) {
    const cle = (nom: string) => motsDuNom(nom).sort().join(' ');
    const parCle = new Map<string, Volontaire[]>();
    // Le nom de la fiche, et celui de la liste déjà rapproché une fois (« NOM_LISTE ») : relancer la
    // même liste ne redemande pas les mêmes confirmations
    for (const v of fiches) {
      const noms = new Set([cle(v.nomComplet)]);
      const alias = (
        v.verifications as Record<string, { note?: string }> | null
      )?.NOM_LISTE?.note;
      if (alias) noms.add(cle(alias));
      for (const k of noms) parCle.set(k, [...(parCle.get(k) ?? []), v]);
    }
    const gardes: { v: Volontaire; p: P }[] = [];
    const reintegres: { v: Volontaire; p: P }[] = [];
    const nouveaux: P[] = [];
    const plusieursFiches: string[] = [];
    const retrouves = new Set<string>();
    // Homonymes (même nom, dates de naissance différentes) : chaque ligne prend sa fiche, la même
    // date d'abord, puis une fiche en poste ; une fiche ne sert qu'à une ligne
    const prises = new Set<string>();
    const lignesParCle = new Map<string, number>();
    for (const q of uniques)
      lignesParCle.set(q.cle, (lignesParCle.get(q.cle) ?? 0) + 1);
    const avecDate = (p: P) => (lignesParCle.get(p.cle) ?? 0) > 1;
    for (const p of [...uniques].sort(
      (a, b) => Number(!a.naissance) - Number(!b.naissance),
    )) {
      const candidats = parCle.get(p.cle) ?? [];
      const libresCle = candidats.filter((x) => !prises.has(x.id));
      // La fiche la plus vraisemblable, toujours la même d'un essai à l'autre : en poste (on ne
      // réintègre pas le doublon d'un en poste), même date de naissance, même département ; une
      // date différente prouve une autre personne (elle passe après une fiche sortie de même date)
      const score = (x: Volontaire) => {
        const dates = !!p.naissance && !!x.dateNaissance;
        return (
          (x.statut === 'EN_POSTE' ? 4 : 0) +
          (dates && x.dateNaissance === p.naissance ? 2 : 0) -
          (dates && x.dateNaissance !== p.naissance ? 10 : 0) +
          (p.departementId && x.departementId === p.departementId ? 1 : 0)
        );
      };
      const choisi = [...libresCle].sort(
        (a, b) => score(b) - score(a) || a.id.localeCompare(b.id),
      )[0];
      if (candidats.length > 1)
        plusieursFiches.push(
          `${p.nom} : ${candidats.length} fiches dans le registre (${candidats.filter((x) => x.statut === 'EN_POSTE').length} en poste)`,
        );
      if (!choisi) nouveaux.push(p);
      else if (choisi.statut === 'EN_POSTE') gardes.push({ v: choisi, p });
      else reintegres.push({ v: choisi, p });
      if (choisi) prises.add(choisi.id);
      // Un nom porté par une seule ligne : toutes ses fiches sont « retrouvées » (pas de sortie
      // pour un doublon du registre) ; des homonymes : seulement la fiche prise
      if (avecDate(p)) {
        if (choisi) retrouves.add(choisi.id);
      } else for (const x of candidats) retrouves.add(x.id);
    }
    // Noms écrits autrement (ordre, faute de frappe, prénom en plus) : une seule fiche en poste qui
    // ressemble, et réciproquement → la même personne, signalée pour vérification. Plusieurs
    // possibilités : rien n'est décidé, la ligne est signalée (DG, 12/11/2026 : presque la même liste)
    const rapproches: string[] = [];
    const ambigus: string[] = [];
    const libres = () =>
      fiches.filter((v) => v.statut === 'EN_POSTE' && !retrouves.has(v.id));
    const proches = (p: P, dispo: Volontaire[]) =>
      dispo.filter(
        (v) =>
          ressemblance(
            motsDuNom(p.nom),
            null,
            motsDuNom(v.nomComplet),
            null,
          ) === 'PROBABLE',
      );
    const restants = [...nouveaux];
    nouveaux.length = 0;
    for (const p of restants) {
      const dispo = libres();
      const c = proches(p, dispo);
      const reciproque =
        c.length === 1
          ? restants.filter((q) => q !== p && proches(q, [c[0]]).length === 1)
              .length === 0
          : false;
      if (c.length === 1 && reciproque) {
        gardes.push({ v: c[0], p });
        retrouves.add(c[0].id);
        rapproches.push(`${p.nom} (liste) = ${c[0].nomComplet} (registre)`);
      } else {
        if (c.length > 1)
          ambigus.push(
            `${p.nom} : ${c.length} fiches proches (${c
              .slice(0, 3)
              .map((v) => v.nomComplet)
              .join(', ')}) — ajouté(e) comme nouveau, à vérifier`,
          );
        nouveaux.push(p);
      }
    }
    // Un seul nom différent (2 mots communs ou plus) : probablement la même personne, mais pas sûr.
    // L'agent confirme chaque paire (« même personne ») ; sans confirmation, rien n'est rapproché.
    const possibles: {
      paire: string;
      liste: string;
      registre: string;
      feuille: string;
      ligne: number;
    }[] = [];
    const confirmes = new Set(memes);
    const encore = [...nouveaux];
    nouveaux.length = 0;
    for (const p of encore) {
      const dispo = libres();
      const mots = motsDuNom(p.nom);
      const c = dispo.filter(
        (v) => motsCommuns(mots, motsDuNom(v.nomComplet)) >= 2,
      );
      const unique =
        c.length === 1 &&
        encore.filter(
          (q) =>
            q !== p &&
            motsCommuns(motsDuNom(q.nom), motsDuNom(c[0].nomComplet)) >= 2,
        ).length === 0;
      if (!unique) {
        nouveaux.push(p);
        continue;
      }
      const paire = `${c[0].id}~${p.cle}`;
      possibles.push({
        paire,
        liste: p.nom,
        registre: c[0].nomComplet,
        feuille: p.feuille,
        ligne: p.ligne,
      });
      if (confirmes.has(paire)) {
        gardes.push({ v: c[0], p });
        retrouves.add(c[0].id);
        rapproches.push(
          `${p.nom} (liste) = ${c[0].nomComplet} (registre, confirmé)`,
        );
      } else nouveaux.push(p);
    }
    return {
      gardes,
      reintegres,
      nouveaux,
      plusieursFiches,
      retrouves,
      rapproches,
      ambigus,
      possibles,
    };
  }

  /* ------------------ Aligner le registre sur la bourse d'un mois ------------------ */

  /**
   * Le registre des volontaires suit la bourse payée d'un mois (DG, 12/11/2026 : « traiter d'abord
   * septembre, puis octobre ») :
   * - payé ce mois et en poste : reste ; son premier mois payé recule à ce mois s'il était plus tard ;
   * - payé ce mois mais sorti au registre : réintégré ;
   * - payé ce mois mais absent du registre : ajouté, payé à partir de ce mois ;
   * - en poste et payable ce mois mais pas payé : sort au 1er du mois (dernier mois payé : le mois
   *   d'avant), avec le motif lu dans la feuille RETRAITS (« SALARIE » → recruté à la Fonction
   *   Publique, « Non partant », « Déserteur »…), sinon « Retiré par la DDEPPSA » ;
   * - payé alors qu'il est aussi dans les RETRAITS : signalé, rien n'est décidé.
   * Mêmes rapprochements des noms que pour les communautaires. `essai` : le rapport seulement.
   */
  async alignerSurBourse(
    u: UtilisateurConnecte,
    contenu: Buffer,
    nomFichier: string,
    o: {
      mois: string;
      feuille: string;
      feuilleRetraits?: string;
      memes?: string[];
      essai: boolean;
    },
  ) {
    if (!MOIS_RE.test(o.mois ?? ''))
      throw new BadRequestException(
        'Indiquez le mois de cette bourse (ex. 2026-09).',
      );
    const feuilles = await lireClasseur(
      contenu,
      ['NOMSETPRENOMS|NOMETPRENOMS|NOMSPRENOMS'],
      { inclureMasquees: true },
    );
    const f = feuilles.find((x) => x.nom === o.feuille);
    if (!f)
      throw new BadRequestException('Choisissez la feuille de la liste payée.');
    const fr = o.feuilleRetraits
      ? feuilles.find((x) => x.nom === o.feuilleRetraits)
      : null;
    if (o.feuilleRetraits && !fr)
      throw new BadRequestException('Feuille des retraits introuvable.');
    const cle = (nom: string) => motsDuNom(nom).sort().join(' ');
    const deps = await this.deps.find();
    const depId = (brut: unknown) => {
      const c = codeDepartement(nettoyer(brut)?.split(/[/(]/)[0]);
      return c ? (deps.find((d) => d.code === c)?.id ?? null) : null;
    };
    const conf = this.config.get();
    // La liste payée
    const liste = this.lignesPersonnes(f.lignes).map((l) => {
      const nom = nettoyer(
        this.valeur(l, ['NOMSETPRENOMS', 'NOMETPRENOMS', 'NOMSPRENOMS']),
      )!;
      const cycleBrut = nettoyer(this.valeur(l, ['CYCLE']));
      const depBrut = nettoyer(this.valeur(l, ['DEPART']));
      return {
        nom,
        cle: cle(nom),
        feuille: f.nom,
        ligne: l._ligne,
        cycleBrut,
        categorie: this.config.categorieDepuisTexte(cycleBrut)?.code ?? null,
        depBrut,
        departementId: depId(depBrut),
        etablissement: nettoyer(this.valeur(l, ['ETABLISSEMENT'])),
        telephone: nettoyer(this.valeur(l, ['TELEPHONE', 'TEL'])),
        vague: vagueNormalisee(this.valeur(l, ['VAGUE', 'PROMOTION'])),
        montant: Number(this.valeur(l, ['MONTANT'])) || 0,
      };
    });
    if (!liste.length)
      throw new BadRequestException(
        'Aucune personne lue dans cette feuille (colonnes « N° » et « Noms et prénoms »).',
      );
    const vus = new Map<string, (typeof liste)[number]>();
    const doublons: string[] = [];
    const uniques: typeof liste = [];
    for (const p of liste) {
      const d = vus.get(p.cle);
      if (d) {
        doublons.push(`${p.nom} : ligne ${p.ligne} (déjà ligne ${d.ligne})`);
        continue;
      }
      vus.set(p.cle, p);
      uniques.push(p);
    }
    // Les retraits du fichier : motif de chacun
    const { motif: motifRetrait, ligne: ligneRetrait } = this.motifsDesRetraits(
      fr?.lignes ?? null,
    );
    const fiches = await this.volontaires.find({
      where: { population: 'VOLONTAIRE' },
    });
    const {
      gardes,
      reintegres,
      nouveaux,
      plusieursFiches,
      retrouves,
      rapproches,
      ambigus,
      possibles,
    } = this.rapprocherListe(uniques, fiches, o.memes ?? []);
    // En poste, payables ce mois (premier mois payé atteint), et pas sur la liste : ils sortent
    const payable = (v: Volontaire) => {
      const debut = BourseService.premierMois(v, conf);
      return !debut || debut <= o.mois;
    };
    const sortants = fiches.filter(
      (v) => v.statut === 'EN_POSTE' && !retrouves.has(v.id) && payable(v),
    );
    const avancer = gardes.filter(({ v }) => {
      const debut = BourseService.premierMois(v, conf);
      return !debut || debut > o.mois;
    });
    const retiresPayes = uniques.filter((p) => motifRetrait.has(p.cle));
    const payesMaisRetires = retiresPayes.map(
      (p) => `${p.nom} (ligne ${p.ligne})`,
    );
    // Le détail, pour la liste à télécharger et à vérifier avec le service de la bourse
    const payesMaisRetiresDetail = retiresPayes.map((p) => {
      const code = motifRetrait.get(p.cle)!;
      return {
        nom: p.nom,
        ligne: p.ligne,
        departement: p.depBrut,
        etablissement: p.etablissement,
        cycle: p.cycleBrut,
        montant: p.montant,
        motifRetrait: this.config.motif(code)?.libelle ?? code,
        ligneRetrait: ligneRetrait.get(p.cle) ?? null,
      };
    });
    const sansCategorie = nouveaux
      .filter((p) => !p.categorie)
      .map((p) => `${p.nom} : cycle « ${p.cycleBrut ?? 'vide'} »`);
    const sansDepartement = nouveaux
      .filter((p) => !p.departementId)
      .map((p) => `${p.nom} : « ${p.depBrut ?? 'vide'} »`);
    const montantsDifferents = uniques
      .filter((p) => {
        const c = p.categorie ? this.config.categorie(p.categorie) : null;
        return c && p.montant && p.montant !== c.bourse;
      })
      .map((p) => `${p.nom} : ${p.montant} (${p.cycleBrut ?? ''})`);
    const parMotif: Record<string, number> = {};
    const motifDe = (v: Volontaire) =>
      motifRetrait.get(cle(v.nomComplet)) ?? 'RETIRE_DDEPPSA';
    for (const v of sortants)
      parMotif[motifDe(v)] = (parMotif[motifDe(v)] ?? 0) + 1;
    const dateSortie = `${o.mois}-01`;
    const ici = `${nomFichier} · ${f.nom}`;
    if (!o.essai) {
      for (const { v, p } of [...gardes, ...reintegres]) {
        const debut = BourseService.premierMois(v, conf);
        const autreNom = cle(v.nomComplet) !== p.cle;
        const champs: Partial<Volontaire> = {
          ...(autreNom
            ? {
                verifications: {
                  ...(v.verifications ?? {}),
                  NOM_LISTE: {
                    par: u.nom,
                    le: new Date().toISOString(),
                    note: p.nom,
                  },
                },
              }
            : {}),
          ...(!debut || debut > o.mois ? { premierMois: o.mois } : {}),
          ...(!v.categorie && p.categorie ? { categorie: p.categorie } : {}),
          ...(!v.departementId && p.departementId
            ? { departementId: p.departementId, departementBrut: p.depBrut }
            : {}),
          ...(!v.etablissement && p.etablissement
            ? { etablissement: p.etablissement }
            : {}),
          ...(!v.telephone && p.telephone ? { telephone: p.telephone } : {}),
        };
        if (v.statut === 'SORTI')
          Object.assign(champs, {
            statut: 'EN_POSTE',
            motifSortie: null,
            dateSortie: null,
          });
        if (Object.keys(champs).length)
          await this.volontaires.update(v.id, champs);
        if (v.statut === 'SORTI')
          await this.mouvement(
            u,
            v.id,
            'REINTEGRATION',
            dateSortie,
            'BOURSE_PAYEE',
            {
              source: `${ici} · ligne ${p.ligne}`,
            },
          );
      }
      for (const v of sortants) {
        const motif = motifDe(v);
        await this.volontaires.update(v.id, {
          statut: 'SORTI',
          motifSortie: motif,
          dateSortie,
        });
        await this.mouvement(u, v.id, 'SORTIE', dateSortie, motif, {
          observation: `Pas sur la bourse payée de ${o.mois} (${nomFichier})`,
        });
      }
      if (nouveaux.length) {
        const lot = await this.volontaires.save(
          nouveaux.map((p) => ({
            nomComplet: p.nom,
            nomNormalise: normaliser(p.nom),
            categorie: p.categorie,
            cycleBrut: p.cycleBrut,
            departementId: p.departementId,
            departementBrut: p.depBrut,
            etablissement: p.etablissement,
            telephone: p.telephone,
            vague: p.vague,
            vagueNumero: p.vague ? this.config.numeroVague(p.vague) : null,
            population: 'VOLONTAIRE',
            statut: 'EN_POSTE',
            premierMois: o.mois,
            source: `${ici} · ligne ${p.ligne}`,
            creePar: u.nom,
            verifications: {},
          })) as Volontaire[],
        );
        await this.mouvements.save(
          lot.map((v) => ({
            volontaireId: v.id,
            type: 'ENTREE',
            dateEffet: null,
            motif: 'BOURSE_PAYEE',
            details: { source: v.source },
            par: u.nom,
          })),
        );
      }
    }
    const court = (t: string[]) => ({ n: t.length, exemples: t.slice(0, 40) });
    const rapport = {
      essai: o.essai,
      mois: o.mois,
      feuille: f.nom,
      lus: liste.length,
      personnes: uniques.length,
      gardes: gardes.length,
      premierMoisAvance: avancer.length,
      reintegres: court(reintegres.map(({ p }) => p.nom)),
      nouveaux: court(nouveaux.map((p) => p.nom)),
      sortants: court(
        sortants.map(
          (v) =>
            `${v.nomComplet} (${this.config.motif(motifDe(v))?.libelle ?? motifDe(v)})`,
        ),
      ),
      sortantsParMotif: Object.entries(parMotif).map(([code, n]) => ({
        motif: this.config.motif(code)?.libelle ?? code,
        n,
      })),
      payesMaisRetires: court(payesMaisRetires),
      payesMaisRetiresDetail,
      doublonsDansListe: court(doublons),
      plusieursFiches: court(plusieursFiches),
      rapproches: court(rapproches),
      ambigus: court(ambigus),
      possibles,
      sansCategorie: court(sansCategorie),
      sansDepartement: court(sansDepartement),
      montantsDifferents: court(montantsDifferents),
      montantListe: uniques.reduce((t, p) => t + p.montant, 0),
    };
    if (!o.essai) {
      await this.journal.log(
        u,
        'VOLONTAIRES_ALIGNES_BOURSE',
        'volontaire',
        null,
        {
          fichier: nomFichier,
          mois: o.mois,
          personnes: uniques.length,
          nouveaux: nouveaux.length,
          reintegres: reintegres.length,
          sortis: sortants.length,
          rapport,
        },
      );
      await this.lier();
    }
    return rapport;
  }

  /* ------------------ Corriger des dates de sortie en série ------------------ */

  /**
   * Changer la date de sortie de plusieurs fiches d'un coup (DG, 13/11/2026 : les 158 retirés de la
   * Likouala sortis le 13/11 au lieu du 01/10, payés en octobre à tort). On choisit les fiches par
   * la population, le département, le motif et la date actuelle ; le dernier mois payé suit la
   * nouvelle date. L'ancienne date reste dans l'historique de chaque fiche. `essai` : le rapport.
   */
  async changerDatesSortie(
    u: UtilisateurConnecte,
    o: {
      population: string;
      departementId?: number | null;
      motif?: string | null;
      dateActuelle: string;
      nouvelleDate: string;
      essai: boolean;
    },
  ) {
    if (!DATE_RE.test(o.dateActuelle ?? ''))
      throw new BadRequestException(
        'Indiquez la date de sortie actuelle des fiches à corriger.',
      );
    if (!DATE_RE.test(o.nouvelleDate ?? ''))
      throw new BadRequestException('Indiquez la nouvelle date de sortie.');
    if (o.nouvelleDate === o.dateActuelle)
      throw new BadRequestException(
        'La nouvelle date est la même que l’actuelle.',
      );
    const population = populationDe(o.population);
    const q = this.volontaires
      .createQueryBuilder('v')
      .where('v.population = :p', { p: population })
      .andWhere("v.statut = 'SORTI'")
      .andWhere('v.dateSortie = :d', { d: o.dateActuelle });
    if (o.departementId)
      q.andWhere('v.departementId = :dep', { dep: o.departementId });
    if (o.motif) q.andWhere('v.motifSortie = :m', { m: o.motif });
    const fiches = await q.orderBy('v.nomNormalise').getMany();
    const conf = this.config.get();
    const deps = new Map((await this.deps.find()).map((d) => [d.id, d.nom]));
    const dernier = (v: Volontaire, date: string) => {
      const x = { ...v, dateSortie: date } as Volontaire;
      return BourseService.dernierMois(
        x,
        conf,
        BourseService.premierMois(x, conf),
      );
    };
    const parDep: Record<string, number> = {};
    const parMotif: Record<string, number> = {};
    for (const v of fiches) {
      const d = v.departementId
        ? (deps.get(v.departementId) ?? '?')
        : '(sans département)';
      parDep[d] = (parDep[d] ?? 0) + 1;
      const m =
        this.config.motif(v.motifSortie)?.libelle ?? v.motifSortie ?? '?';
      parMotif[m] = (parMotif[m] ?? 0) + 1;
    }
    const exemple = fiches[0];
    const rapport = {
      essai: o.essai,
      n: fiches.length,
      parDepartement: parDep,
      parMotif,
      dernierMoisAvant: exemple ? dernier(exemple, o.dateActuelle) : null,
      dernierMoisApres: exemple ? dernier(exemple, o.nouvelleDate) : null,
      exemples: fiches
        .slice(0, 40)
        .map(
          (v) =>
            `${v.nomComplet} (${v.departementId ? (deps.get(v.departementId) ?? '?') : '?'})`,
        ),
    };
    if (!o.essai && fiches.length) {
      for (let i = 0; i < fiches.length; i += 1000)
        await this.volontaires.update(
          { id: In(fiches.slice(i, i + 1000).map((v) => v.id)) },
          { dateSortie: o.nouvelleDate },
        );
      await this.mouvements.save(
        fiches.map((v) => ({
          volontaireId: v.id,
          type: 'MODIFICATION',
          dateEffet: o.nouvelleDate,
          motif: v.motifSortie,
          details: {
            champ: 'dateSortie',
            avant: o.dateActuelle,
            apres: o.nouvelleDate,
            observation: 'Date de sortie corrigée en série',
          },
          par: u.nom,
        })),
      );
      await this.journal.log(u, 'DATES_SORTIE_CORRIGEES', 'volontaire', null, {
        population,
        departement: o.departementId ? deps.get(o.departementId) : null,
        motif: o.motif ?? null,
        avant: o.dateActuelle,
        apres: o.nouvelleDate,
        fiches: fiches.length,
      });
      void this.lier();
    }
    return rapport;
  }

  /* --------------------- Décisions sur les contrôles de la bourse --------------------- */

  /**
   * Décisions prises sur les contrôles d'un état de paiement (DG, 13/11/2026 : « des boutons
   * adéquats, une panoplie de décisions réalistes, et toujours la possibilité de cocher pour un
   * travail de masse »). Chaque décision vise une ou deux fiches :
   * - SORTIR : sortie avec un motif et une date (recruté FP, doublon, déserteur…) ;
   * - VERIFIER : le contrôle est vérifié à la main, il ne revient plus (note obligatoire) ;
   * - DEUX_PERSONNES : deux fiches qui se ressemblent sont deux personnes (les deux sont notées) ;
   * - GARDER : deux fiches de la même personne : on garde l'une, l'autre sort (motif « Doublon »)
   *   et la fiche gardée reçoit ce que l'autre savait et qu'elle ignorait (cases vides) ;
   * - COMPLETER : département, catégorie ou premier mois payé, pour les fiches qui ne l'ont pas.
   * Une décision qui échoue n'arrête pas les autres : le rapport dit lesquelles et pourquoi.
   */
  async deciderControles(
    u: UtilisateurConnecte,
    dto: {
      decisions: {
        action:
          'SORTIR' | 'VERIFIER' | 'DEUX_PERSONNES' | 'GARDER' | 'COMPLETER';
        id: string;
        autreId?: string;
        controle?: string;
        motif?: string;
        date?: string;
        note?: string;
        departementId?: number;
        categorie?: string;
        premierMois?: string;
      }[];
    },
  ) {
    const decisions = Array.isArray(dto?.decisions) ? dto.decisions : [];
    if (!decisions.length)
      throw new BadRequestException('Aucune décision : cochez des lignes.');
    if (decisions.length > 3000)
      throw new BadRequestException('3 000 décisions au plus à la fois.');
    const res = {
      faites: 0,
      erreurs: [] as string[],
      parAction: {} as Record<string, number>,
    };
    const nomDe = async (id: string) =>
      (
        await this.volontaires.findOne({
          where: { id },
          select: { nomComplet: true },
        })
      )?.nomComplet ?? id;
    const noter = async (id: string, controle: string, note: string) => {
      const v = await this.volontaires.findOne({ where: { id } });
      if (!v) throw new NotFoundException('Fiche introuvable');
      await this.volontaires.update(id, {
        verifications: {
          ...(v.verifications ?? {}),
          [controle]: { par: u.nom, le: new Date().toISOString(), note },
        },
      });
      await this.mouvements.save({
        volontaireId: id,
        type: 'VERIFICATION',
        dateEffet: null,
        motif: controle,
        details: { note },
        par: u.nom,
      });
    };
    for (const d of decisions) {
      try {
        const controle = String(d.controle ?? '').toUpperCase();
        const note = (d.note ?? '').trim();
        switch (d.action) {
          case 'SORTIR':
            await this.sortir(
              u,
              d.id,
              {
                motif: d.motif ?? '',
                date: d.date ?? '',
                observation: note || undefined,
              },
              false,
            );
            break;
          case 'VERIFIER':
            if (!/^[A-Z_]{3,30}$/.test(controle))
              throw new BadRequestException('Contrôle inconnu.');
            if (note.length < 5)
              throw new BadRequestException(
                'Écrivez ce qui a été vérifié (5 caractères au moins).',
              );
            await noter(d.id, controle, note);
            break;
          case 'DEUX_PERSONNES': {
            if (!d.autreId)
              throw new BadRequestException('Il faut les deux fiches.');
            if (!['DOUBLON', 'AUTRE_LISTE'].includes(controle))
              throw new BadRequestException('Contrôle inconnu.');
            const texte = note || 'Deux personnes différentes';
            await noter(
              d.id,
              controle,
              `${texte} (≠ ${await nomDe(d.autreId)})`,
            );
            await noter(
              d.autreId,
              controle,
              `${texte} (≠ ${await nomDe(d.id)})`,
            );
            break;
          }
          case 'GARDER': {
            if (!d.autreId)
              throw new BadRequestException('Il faut les deux fiches.');
            const garde = await this.volontaires.findOne({
              where: { id: d.id },
            });
            const sort = await this.volontaires.findOne({
              where: { id: d.autreId },
            });
            if (!garde || !sort)
              throw new NotFoundException('Fiche introuvable');
            if (garde.statut !== 'EN_POSTE')
              throw new BadRequestException(
                `${garde.nomComplet} : la fiche gardée n’est pas en poste.`,
              );
            // Ce que la fiche sortie sait et que la fiche gardée ignore (cases vides seulement)
            const COMPLETER: (keyof Volontaire)[] = [
              'dateNaissance',
              'lieuNaissance',
              'genre',
              'telephone',
              'diplome',
              'specialite',
              'etablissement',
              'circonscription',
              'departementId',
              'departementBrut',
              'categorie',
              'cycleBrut',
            ];
            const champs: Partial<Volontaire> = {};
            // Une catégorie de volontaire ne veut rien dire pour un communautaire (et inversement)
            const memeListe = garde.population === sort.population;
            for (const k of COMPLETER) {
              if (!memeListe && (k === 'categorie' || k === 'cycleBrut'))
                continue;
              const vide = (x: unknown) =>
                x === null || x === undefined || enTexte(x).trim() === '';
              if (vide(garde[k]) && !vide(sort[k]))
                Object.assign(champs, { [k]: sort[k] });
            }
            if (Object.keys(champs).length)
              await this.volontaires.update(garde.id, champs);
            if (sort.statut === 'EN_POSTE')
              await this.sortir(
                u,
                sort.id,
                {
                  motif: d.motif || 'DOUBLON',
                  date: d.date ?? '',
                  observation: `Doublon de ${garde.nomComplet}${note ? ` : ${note}` : ''}`,
                },
                false,
              );
            break;
          }
          case 'COMPLETER': {
            const v = await this.volontaires.findOne({ where: { id: d.id } });
            if (!v) throw new NotFoundException('Fiche introuvable');
            const champs: Partial<Volontaire> = {};
            if (d.departementId) {
              const dep = await this.deps.findOne({
                where: { id: d.departementId },
              });
              if (!dep) throw new BadRequestException('Département inconnu.');
              Object.assign(champs, {
                departementId: dep.id,
                departementBrut: dep.nom,
              });
            }
            if (d.categorie) {
              if (!this.config.categorie(d.categorie, v.population))
                throw new BadRequestException(
                  'Catégorie inconnue pour cette liste.',
                );
              champs.categorie = d.categorie;
            }
            if (d.premierMois) {
              if (!MOIS_RE.test(d.premierMois))
                throw new BadRequestException(
                  'Premier mois attendu (AAAA-MM).',
                );
              champs.premierMois = d.premierMois;
            }
            if (!Object.keys(champs).length)
              throw new BadRequestException('Rien à compléter.');
            await this.volontaires.update(v.id, champs);
            await this.mouvements.save({
              volontaireId: v.id,
              type: 'MODIFICATION',
              dateEffet: null,
              motif: null,
              details: {
                champs: Object.keys(champs),
                observation: 'Complété depuis les contrôles de la bourse',
              },
              par: u.nom,
            });
            break;
          }
          default:
            throw new BadRequestException('Décision inconnue.');
        }
        res.faites++;
        res.parAction[d.action] = (res.parAction[d.action] ?? 0) + 1;
      } catch (e) {
        res.erreurs.push(
          `${await nomDe(d.id).catch(() => d.id)} : ${(e as Error).message}`,
        );
      }
    }
    if (res.faites) {
      await this.journal.log(
        u,
        'CONTROLES_BOURSE_DECIDES',
        'volontaire',
        null,
        {
          faites: res.faites,
          parAction: res.parAction,
          erreurs: res.erreurs.length,
        },
      );
      void this.lier();
    }
    return {
      ...res,
      erreurs: res.erreurs.slice(0, 50),
      nbErreurs: res.erreurs.length,
    };
  }

  /* --------------- Aligner les communautaires sur un état de paiement --------------- */

  /**
   * Le registre des communautaires suit l'état de paiement mis à jour par la DGRHAS (DG, 13/11/2026 :
   * « l'état des communautaires mis à jour, avec des ajouts »), une feuille par département
   * (« ETAT DE PAIEMENT BOUENZA », « … PLATEAUX-NKENI »…), lues ensemble :
   * - sur l'état et en poste : reste (les cases vides de la fiche sont complétées, rien d'autre ne
   *   change ; un département ou un cycle différent est seulement signalé) ;
   * - sur l'état mais sorti au registre : réintégré, payé à partir de ce mois ;
   * - sur l'état mais absent du registre : ajouté, payé à partir de ce mois. Chaque nouveau est
   *   montré avec son département et son cycle ; on peut les corriger ou ne pas l'ajouter (`choix`).
   *   Déjà fonctionnaire, contractuel ou volontaire en poste : pas ajouté sans le dire ;
   * - en poste mais absent de l'état : sort au 1er du mois, avec le motif lu dans les RETRAITS —
   *   seulement dans les départements présents dans le fichier (une feuille oubliée ne fait sortir
   *   personne).
   * Mêmes rapprochements des noms que pour les volontaires ; la date de naissance départage deux
   * homonymes. `essai` : le rapport, sans rien enregistrer.
   */
  async alignerCommunautaires(
    u: UtilisateurConnecte,
    contenu: Buffer,
    nomFichier: string,
    o: {
      mois: string;
      feuilles: string[];
      feuilleRetraits?: string;
      memes?: string[];
      choix?: Record<
        string,
        {
          ajouter?: boolean;
          departementId?: number | null;
          categorie?: string | null;
        }
      >;
      essai: boolean;
    },
  ) {
    if (!MOIS_RE.test(o.mois ?? ''))
      throw new BadRequestException(
        'Indiquez le mois de cet état de paiement (ex. 2026-09).',
      );
    if (!o.feuilles?.length)
      throw new BadRequestException(
        'Cochez les feuilles de l’état de paiement (une par département).',
      );
    const lues = await lireClasseur(
      contenu,
      ['NOMSETPRENOMS|NOMETPRENOMS|NOMSPRENOMS'],
      { inclureMasquees: true },
    );
    const feuilles = o.feuilles.map((nom) => {
      const f = lues.find((x) => x.nom === nom);
      if (!f)
        throw new BadRequestException(
          `Feuille « ${nom} » introuvable dans le fichier.`,
        );
      return f;
    });
    const fr = o.feuilleRetraits
      ? lues.find((x) => x.nom === o.feuilleRetraits)
      : null;
    if (o.feuilleRetraits && !fr)
      throw new BadRequestException('Feuille des retraits introuvable.');
    if (fr && o.feuilles.includes(fr.nom))
      throw new BadRequestException(
        'La feuille des retraits ne peut pas être aussi une feuille de paiement.',
      );
    const cle = (nom: string) => motsDuNom(nom).sort().join(' ');
    const compact = (s: string) => normaliser(s).replace(/[^A-Z]/g, '');
    const deps = await this.deps.find();
    const depDeCode = (code: string | null) =>
      code ? (deps.find((d) => d.code === code) ?? null) : null;
    const nomDep = (id: number | null | undefined) =>
      id ? (deps.find((d) => d.id === id)?.nom ?? null) : null;
    const depId = (brut: unknown) =>
      depDeCode(codeDepartement(nettoyer(brut)?.split(/[/(]/)[0]))?.id ?? null;
    /**
     * Département d'une feuille d'après son nom : « ETAT DE PAIEMENT BZV (CORRIGE) » → Brazzaville,
     * « … PN (+ALPHA) » → Pointe-Noire ; « … PLATEAUX-NKENI » : deux départements (ambigu).
     */
    const departementsDeFeuille = (nom: string) => {
      const reste = normaliser(nom)
        .replace(/^ETATS?\s+DE\s+PAIEMENT\s*/, '')
        .replace(/\(.*?\)/g, '')
        .trim();
      if (/^PN$|^P\s*NOIRE$/.test(reste)) return [depDeCode('POINTE_NOIRE')!];
      const entier = depDeCode(codeDepartement(reste));
      if (entier && compact(entier.nom) === compact(reste)) return [entier];
      const parties = reste
        .split(/[-/,]|\s+ET\s+/)
        .map((x) => depDeCode(codeDepartement(x.trim())))
        .filter((d): d is Departement => !!d);
      const uniquesDeps = [...new Map(parties.map((d) => [d.id, d])).values()];
      return uniquesDeps.length ? uniquesDeps : entier ? [entier] : [];
    };
    const conf = this.config.get();
    const categories = this.config.categoriesDe('COMMUNAUTAIRE');
    const libelleCat = (code: string | null) =>
      code ? (categories.find((c) => c.code === code)?.libelle ?? code) : null;

    // Les lignes de toutes les feuilles
    const lignes = feuilles.flatMap((f) => {
      const depsFeuille = departementsDeFeuille(f.nom);
      return this.lignesPersonnes(f.lignes).map((l) => {
        const nom = nettoyer(
          this.valeur(l, ['NOMSETPRENOMS', 'NOMETPRENOMS', 'NOMSPRENOMS']),
        )!;
        const naissance = lireDate(this.valeur(l, ['DATEDENAIS', 'NELE']));
        const cycleBrut = nettoyer(this.valeur(l, ['CYCLE']));
        const depBrutColonne = nettoyer(this.valeur(l, ['DEPART', 'DPART']));
        const depColonne = depId(depBrutColonne);
        const departementId =
          depColonne ?? (depsFeuille.length === 1 ? depsFeuille[0].id : null);
        const depBrut = depColonne
          ? depBrutColonne
          : departementId
            ? nomDep(departementId)
            : null;
        const valeurs = this.valeursDuFichier(l, {
          naissance,
          cycleBrut,
          diplome: nettoyer(this.valeur(l, ['DIPLOME'])),
          departementId,
          depBrut,
          population: 'COMMUNAUTAIRE',
        });
        return {
          nom,
          cle: cle(nom),
          feuille: f.nom,
          ligne: Number(l._ligne),
          naissance,
          cycleBrut,
          categorie: valeurs.categorie ?? null,
          departementId,
          depSource: depColonne
            ? ('COLONNE' as const)
            : departementId
              ? ('FEUILLE' as const)
              : null,
          depPossibles: depsFeuille.map((d) => d.id),
          etablissement: valeurs.etablissement ?? null,
          valeurs,
        };
      });
    });
    if (!lignes.length)
      throw new BadRequestException(
        'Aucune personne lue dans ces feuilles (colonnes « N° » et « Noms et prénoms »).',
      );
    // Doublons de la liste : même nom, même date (ou une date absente). Même nom et dates
    // différentes : deux homonymes, gardés tous les deux
    const gardesCle = new Map<string, (typeof lignes)[number][]>();
    const doublons: string[] = [];
    const uniques: typeof lignes = [];
    for (const p of lignes) {
      const deja = (gardesCle.get(p.cle) ?? []).find(
        (q) => !q.naissance || !p.naissance || q.naissance === p.naissance,
      );
      if (deja) {
        doublons.push(
          `${p.nom} : « ${p.feuille} » ligne ${p.ligne} (déjà « ${deja.feuille} » ligne ${deja.ligne})`,
        );
        continue;
      }
      gardesCle.set(p.cle, [...(gardesCle.get(p.cle) ?? []), p]);
      uniques.push(p);
    }
    const { motif: motifRetrait, ligne: ligneRetrait } = this.motifsDesRetraits(
      fr?.lignes ?? null,
    );
    const fiches = await this.volontaires.find({
      where: { population: 'COMMUNAUTAIRE' },
    });
    const {
      gardes,
      reintegres,
      nouveaux,
      plusieursFiches,
      retrouves,
      rapproches,
      ambigus,
      possibles,
    } = this.rapprocherListe(uniques, fiches, o.memes ?? []);

    // Départements présents dans le fichier : seuls leurs absents sortent
    const couverts = new Set<number>();
    for (const { v } of [...gardes, ...reintegres])
      if (v.departementId) couverts.add(v.departementId);
    for (const p of uniques) if (p.departementId) couverts.add(p.departementId);
    const payable = (v: Volontaire) => {
      const debut = BourseService.premierMois(v, conf);
      return !debut || debut <= o.mois;
    };
    const absents = fiches.filter(
      (v) => v.statut === 'EN_POSTE' && !retrouves.has(v.id) && payable(v),
    );
    const sortants = absents.filter(
      (v) => v.departementId && couverts.has(v.departementId),
    );
    const nonTouches = absents.filter(
      (v) => !v.departementId || !couverts.has(v.departementId),
    );
    // Pas sur l'état mais payés seulement plus tard (premier mois après ce mois) : pas touchés
    const plusTard = fiches.filter(
      (v) => v.statut === 'EN_POSTE' && !retrouves.has(v.id) && !payable(v),
    );
    // Plus de fiches en poste que de lignes sur l'état pour un même nom : risque de double
    // paiement (ou deux homonymes) — signalé, rien n'est décidé
    const lignesParNom = new Map<string, number>();
    for (const p of uniques)
      lignesParNom.set(p.cle, (lignesParNom.get(p.cle) ?? 0) + 1);
    // Compté sur le registre APRÈS l'alignement : en poste qui ne sortent pas, et réintégrés
    const enPosteParNom = new Map<string, Volontaire[]>();
    const sortiront = new Set(sortants.map((v) => v.id));
    const reviendront = new Set(reintegres.map(({ v }) => v.id));
    for (const v of fiches)
      if (
        v.statut === 'EN_POSTE' ? !sortiront.has(v.id) : reviendront.has(v.id)
      ) {
        const k = cle(v.nomComplet);
        enPosteParNom.set(k, [...(enPosteParNom.get(k) ?? []), v]);
      }
    const fichesEnTrop = [...enPosteParNom.entries()]
      .filter(
        ([k, l]) => lignesParNom.has(k) && l.length > lignesParNom.get(k)!,
      )
      .map(
        ([k, l]) =>
          `${l[0].nomComplet} : ${l.length} fiches en poste (${l
            .map(
              (v) =>
                `${nomDep(v.departementId) ?? '?'}, né(e) le ${v.dateNaissance ? v.dateNaissance.split('-').reverse().join('/') : '?'}`,
            )
            .join(' ; ')}), ${lignesParNom.get(k)} ligne(s) sur l’état`,
      );
    const motifDe = (v: Volontaire) =>
      motifRetrait.get(cle(v.nomComplet)) ?? 'RETIRE_DDEPPSA';

    // Les nouveaux : déjà fonctionnaires, contractuels ou volontaires en poste ?
    const clesNouveaux = new Set(nouveaux.map((p) => p.cle));
    const ailleurs = new Map<string, string[]>();
    const noter = (k: string, quoi: string) =>
      ailleurs.set(k, [...(ailleurs.get(k) ?? []), quoi]);
    for (const a of await this.volontaires.query<
      { nom: string; statut: string; matricule: string | null }[]
    >(
      `SELECT "nomComplet" AS nom, statut, matricule FROM agent_recense
        WHERE statut IN ('FONCTIONNAIRE', 'CONTRACTUEL')`,
    )) {
      const k = cle(a.nom);
      if (clesNouveaux.has(k))
        noter(
          k,
          `${a.statut === 'FONCTIONNAIRE' ? 'fonctionnaire' : 'contractuel(le)'} dans le personnel${a.matricule ? ` (matricule ${a.matricule})` : ''}`,
        );
    }
    for (const v of await this.volontaires.find({
      where: { population: 'VOLONTAIRE', statut: 'EN_POSTE' },
      select: { nomComplet: true },
    })) {
      const k = cle(v.nomComplet);
      if (clesNouveaux.has(k)) noter(k, 'volontaire en poste (bourse)');
    }
    const procheAmbigu = new Set(
      ambigus.map((x) => x.split(' : ')[0]).filter(Boolean),
    );
    const cleNouveau = (p: { feuille: string; ligne: number }) =>
      `${p.feuille}|${p.ligne}`;
    const nouveauxDetail = nouveaux.map((p) => {
      const c = o.choix?.[cleNouveau(p)];
      const dejaAilleurs = ailleurs.get(p.cle) ?? [];
      const ajouterParDefaut = !dejaAilleurs.length;
      const departementId =
        c?.departementId !== undefined ? c.departementId : p.departementId;
      const categorie = c?.categorie !== undefined ? c.categorie : p.categorie;
      const alertes = [
        ...dejaAilleurs.map((x) => `Déjà ${x}`),
        ...(procheAmbigu.has(p.nom)
          ? ['Ressemble à plusieurs fiches du registre']
          : []),
        ...(!p.departementId
          ? [
              p.depPossibles.length > 1
                ? 'Feuille de plusieurs départements : choisissez le sien'
                : 'Département inconnu : choisissez-le',
            ]
          : []),
        ...(!p.categorie
          ? [`Cycle « ${p.cycleBrut ?? 'vide'} » non reconnu : choisissez-le`]
          : []),
      ];
      return {
        cle: cleNouveau(p),
        nom: p.nom,
        naissance: p.naissance,
        feuille: p.feuille,
        ligne: p.ligne,
        cycleBrut: p.cycleBrut,
        etablissement: p.etablissement,
        departementId,
        departement: nomDep(departementId),
        depSource: p.depSource,
        depPossibles: p.depPossibles,
        categorie,
        categorieLibelle: libelleCat(categorie),
        ajouterParDefaut,
        ajouter: c?.ajouter ?? ajouterParDefaut,
        alertes,
      };
    });
    const aAjouter = nouveauxDetail.filter((n) => n.ajouter);
    const incomplets = aAjouter.filter(
      (n) =>
        !n.departementId ||
        !deps.some((d) => d.id === n.departementId) ||
        !n.categorie ||
        !categories.some((c) => c.code === n.categorie),
    );

    // Avant / après, par département et par cycle (barème des communautaires)
    const parDep = new Map<string, { avant: number; apres: number }>();
    const parCat = new Map<
      string,
      { libelle: string; avant: number; apres: number; taux: number }
    >();
    for (const c of categories)
      parCat.set(c.code, {
        libelle: c.libelle,
        avant: 0,
        apres: 0,
        taux: c.bourse,
      });
    const compter = (
      dep: number | null,
      cat: string | null,
      quand: 'avant' | 'apres',
      n = 1,
    ) => {
      const d = nomDep(dep) ?? '(sans département)';
      parDep.set(d, parDep.get(d) ?? { avant: 0, apres: 0 });
      parDep.get(d)![quand] += n;
      const k = cat && parCat.has(cat) ? cat : '(sans cycle)';
      if (!parCat.has(k))
        parCat.set(k, { libelle: '(sans cycle)', avant: 0, apres: 0, taux: 0 });
      parCat.get(k)![quand] += n;
    };
    for (const v of fiches)
      if (v.statut === 'EN_POSTE')
        compter(v.departementId, v.categorie, 'avant');
    const idsSortants = new Set(sortants.map((v) => v.id));
    for (const v of fiches)
      if (v.statut === 'EN_POSTE' && !idsSortants.has(v.id))
        compter(v.departementId, v.categorie, 'apres');
    for (const { v, p } of reintegres)
      compter(
        v.departementId ?? p.departementId,
        v.categorie ?? p.categorie,
        'apres',
      );
    for (const n of aAjouter) compter(n.departementId, n.categorie, 'apres');
    const montant = (q: 'avant' | 'apres') =>
      [...parCat.values()].reduce((t, x) => t + x[q] * x.taux, 0);

    // Signalés seulement
    const autreDepartement = gardes
      .filter(
        ({ v, p }) =>
          p.depSource === 'COLONNE' &&
          v.departementId &&
          p.departementId &&
          v.departementId !== p.departementId,
      )
      .map(
        ({ v, p }) =>
          `${v.nomComplet} : ${nomDep(v.departementId)} au registre, ${nomDep(p.departementId)} sur l’état`,
      );
    const autreCycle = gardes
      .filter(
        ({ v, p }) => v.categorie && p.categorie && v.categorie !== p.categorie,
      )
      .map(
        ({ v, p }) =>
          `${v.nomComplet} : ${libelleCat(v.categorie)} au registre, ${libelleCat(p.categorie)} sur l’état`,
      );
    const payesMaisRetires = uniques
      .filter((p) => motifRetrait.has(p.cle))
      .map((p) => ({
        nom: p.nom,
        ligne: p.ligne,
        feuille: p.feuille,
        departement: nomDep(p.departementId),
        etablissement: p.etablissement,
        cycle: p.cycleBrut,
        montant: 0,
        motifRetrait:
          this.config.motif(motifRetrait.get(p.cle))?.libelle ??
          motifRetrait.get(p.cle)!,
        ligneRetrait: ligneRetrait.get(p.cle) ?? null,
      }));
    const parMotif: Record<string, number> = {};
    for (const v of sortants)
      parMotif[motifDe(v)] = (parMotif[motifDe(v)] ?? 0) + 1;
    const nonTouchesParDep: Record<string, number> = {};
    for (const v of nonTouches) {
      const d = nomDep(v.departementId) ?? '(sans département)';
      nonTouchesParDep[d] = (nonTouchesParDep[d] ?? 0) + 1;
    }

    // Ce que l'état apprend aux fiches retrouvées : seulement les cases vides (montré dans le
    // rapport, champ par champ) ; réintégré : payé à partir de ce mois (pas de rappel pour le
    // temps où il était sorti)
    const vide = (x: unknown) =>
      x === null || x === undefined || enTexte(x).trim() === '';
    const COMPLETER: [keyof Volontaire, string][] = [
      ['dateNaissance', 'Date de naissance'],
      ['lieuNaissance', 'Lieu de naissance'],
      ['genre', 'Sexe'],
      ['telephone', 'Téléphone'],
      ['diplome', 'Diplôme'],
      ['specialite', 'Spécialité'],
      ['etablissement', 'Établissement'],
      ['circonscription', 'Circonscription'],
    ];
    const majs = [...gardes, ...reintegres].map(({ v, p }) => {
      const reintegre = v.statut === 'SORTI';
      const debut = BourseService.premierMois(v, conf);
      const champs: Partial<Volontaire> = {};
      const completees: string[] = [];
      for (const [k, libelle] of COMPLETER)
        if (vide(v[k]) && !vide(p.valeurs[k])) {
          Object.assign(champs, { [k]: p.valeurs[k] });
          completees.push(libelle);
        }
      if (!v.categorie && p.categorie) {
        Object.assign(champs, {
          categorie: p.categorie,
          cycleBrut: p.cycleBrut,
        });
        completees.push('Cycle');
      }
      if (!v.departementId && p.departementId) {
        Object.assign(champs, {
          departementId: p.departementId,
          departementBrut: nomDep(p.departementId),
        });
        completees.push('Département');
      }
      if (cle(v.nomComplet) !== p.cle)
        champs.verifications = {
          ...(v.verifications ?? {}),
          NOM_LISTE: { par: u.nom, le: new Date().toISOString(), note: p.nom },
        };
      if (reintegre)
        Object.assign(champs, {
          statut: 'EN_POSTE',
          motifSortie: null,
          dateSortie: null,
          premierMois: o.mois,
        });
      else if (debut && debut > o.mois) champs.premierMois = o.mois;
      return { v, p, reintegre, champs, completees };
    });
    const parChamp: Record<string, number> = {};
    for (const m of majs)
      for (const c of m.completees) parChamp[c] = (parChamp[c] ?? 0) + 1;
    if (!o.essai) {
      if (incomplets.length)
        throw new BadRequestException(
          `${incomplets.length} nouveau(x) à ajouter sans département ou sans cycle : choisissez-les, ou décochez-les (${incomplets
            .slice(0, 3)
            .map((n) => n.nom)
            .join(', ')}${incomplets.length > 3 ? '…' : ''}).`,
        );
      const dateEffet = `${o.mois}-01`;
      const ici = `${nomFichier} (état de paiement de ${o.mois})`;
      // Des milliers de fiches complétées : en lot (une requête par rubrique), pas une par fiche
      await this.majEnLot(
        majs
          .filter((m) => Object.keys(m.champs).length)
          .map((m) => ({ id: m.v.id, champs: m.champs })),
      );
      for (const { v, p } of majs.filter((m) => m.reintegre))
        await this.mouvement(u, v.id, 'REINTEGRATION', dateEffet, 'ETAT_PAYE', {
          source: `${ici} · « ${p.feuille} » ligne ${p.ligne}`,
          ancienneSortie: { motif: v.motifSortie, date: v.dateSortie },
        });
      for (const v of sortants) {
        const motif = motifDe(v);
        await this.volontaires.update(v.id, {
          statut: 'SORTI',
          motifSortie: motif,
          dateSortie: dateEffet,
        });
        await this.mouvement(u, v.id, 'SORTIE', dateEffet, motif, {
          observation: `Pas sur l’état de paiement de ${o.mois} (${nomFichier})`,
        });
      }
      if (aAjouter.length) {
        const parCleNouveau = new Map(nouveaux.map((p) => [cleNouveau(p), p]));
        const lot = await this.volontaires.save(
          aAjouter.map((n) => {
            const p = parCleNouveau.get(n.cle)!;
            return {
              ...p.valeurs,
              nomComplet: p.nom,
              nomNormalise: normaliser(p.nom),
              categorie: n.categorie,
              departementId: n.departementId,
              departementBrut:
                n.departementId === p.departementId
                  ? (p.valeurs.departementBrut ?? nomDep(n.departementId))
                  : nomDep(n.departementId),
              population: 'COMMUNAUTAIRE',
              statut: 'EN_POSTE',
              premierMois: o.mois,
              source: `${ici} · « ${p.feuille} » ligne ${p.ligne}`,
              creePar: u.nom,
              verifications: {},
            } as Volontaire;
          }),
        );
        await this.mouvements.save(
          lot.map((v) => ({
            volontaireId: v.id,
            type: 'ENTREE',
            dateEffet,
            motif: 'ETAT_PAYE',
            details: { source: v.source },
            par: u.nom,
          })),
        );
      }
    }
    const court = (t: string[]) => ({ n: t.length, exemples: t.slice(0, 40) });
    const rapport = {
      essai: o.essai,
      mois: o.mois,
      feuilles: feuilles.map((f) => ({
        nom: f.nom,
        departements: departementsDeFeuille(f.nom).map((d) => d.nom),
        personnes: lignes.filter((p) => p.feuille === f.nom).length,
      })),
      lus: lignes.length,
      personnes: uniques.length,
      gardes: gardes.length,
      reintegres: court(
        reintegres.map(
          ({ v, p }) =>
            `${p.nom} (${nomDep(v.departementId) ?? '?'} ; sorti : ${this.config.motif(v.motifSortie)?.libelle ?? v.motifSortie ?? '?'})`,
        ),
      ),
      nouveaux: nouveauxDetail,
      ajoutes: aAjouter.length,
      incomplets: incomplets.length,
      sortants: court(
        sortants.map(
          (v) =>
            `${v.nomComplet} (${nomDep(v.departementId)} ; ${this.config.motif(motifDe(v))?.libelle ?? motifDe(v)})`,
        ),
      ),
      sortantsParMotif: Object.entries(parMotif).map(([code, n]) => ({
        motif: this.config.motif(code)?.libelle ?? code,
        n,
      })),
      nonTouches: {
        n: nonTouches.length,
        parDepartement: nonTouchesParDep,
      },
      plusTard: court(
        plusTard.map(
          (v) =>
            `${v.nomComplet} (${nomDep(v.departementId) ?? '?'} ; payé à partir de ${BourseService.premierMois(v, conf) ?? '?'})`,
        ),
      ),
      fichesEnTrop: court(fichesEnTrop),
      parDepartement: [...parDep.entries()]
        .map(([departement, x]) => ({ departement, ...x }))
        .sort((a, b) => a.departement.localeCompare(b.departement, 'fr')),
      parCycle: [...parCat.values()].filter((x) => x.avant || x.apres),
      montantAvant: montant('avant'),
      montantApres: montant('apres'),
      payesMaisRetires: court(
        payesMaisRetires.map(
          (p) => `${p.nom} (« ${p.feuille} » ligne ${p.ligne})`,
        ),
      ),
      payesMaisRetiresDetail: payesMaisRetires,
      doublonsDansListe: court(doublons),
      plusieursFiches: court(plusieursFiches),
      rapproches: court(rapproches),
      ambigus: court(ambigus),
      possibles,
      autreDepartement: court(autreDepartement),
      autreCycle: court(autreCycle),
      fichesCompletees: majs.filter((m) => m.completees.length).length,
      // Sur l'état de ce mois alors que leur premier mois payé était plus tard : il recule à ce mois
      premierMoisAvance: majs.filter(
        (m) => !m.reintegre && m.champs.premierMois === o.mois,
      ).length,
      completees: court(
        majs
          .filter((m) => m.completees.length)
          .map((m) => `${m.v.nomComplet} : ${m.completees.join(', ')}`),
      ),
      completeesParChamp: parChamp,
    };
    if (!o.essai) {
      await this.journal.log(
        u,
        'COMMUNAUTAIRES_ALIGNES_ETAT',
        'volontaire',
        null,
        {
          fichier: nomFichier,
          mois: o.mois,
          feuilles: o.feuilles,
          personnes: uniques.length,
          ajoutes: aAjouter.length,
          reintegres: reintegres.length,
          sortis: sortants.length,
          rapport: { ...rapport, nouveaux: undefined },
        },
      );
      // La base du personnel suit en arrière-plan (une vingtaine de secondes) : la réponse n'attend pas
      void this.lier();
    }
    return rapport;
  }

  /* ------------------ Remplacer les communautaires d'un département ------------------ */

  /**
   * Nouvelle liste des communautaires d'un département (DG, 12/11/2026 : la Likouala envoie la
   * note de service du 30/10/2026, une feuille par cycle) :
   * - une personne déjà en poste dans ce département garde sa fiche (catégorie, poste, observation
   *   mis à jour) ; une personne sortie de ce département est réintégrée ;
   * - une personne nouvelle est ajoutée en poste, payée à partir de `premierMois` ;
   * - une personne en poste dans ce département mais absente de la liste sort, motif « Retiré par
   *   la DDEPPSA » (réintégrable si c'est une erreur).
   * Le cycle de chaque feuille vient de son nom (« Collège (1er degré) » → Collège). On signale,
   * sans rien décider, les doublons de la liste et les personnes déjà fonctionnaires, contractuelles
   * ou volontaires. `essai` : le rapport, sans rien enregistrer.
   */
  async remplacerDepartement(
    u: UtilisateurConnecte,
    contenu: Buffer,
    nomFichier: string,
    o: {
      departementId: number;
      premierMois: string;
      dateSortie: string;
      /** Paires « fiche~nom de la liste » confirmées « même personne » par l'agent. */
      memes?: string[];
      essai: boolean;
    },
  ) {
    const dep = await this.deps.findOne({ where: { id: o.departementId } });
    if (!dep) throw new BadRequestException('Choisissez le département.');
    if (!MOIS_RE.test(o.premierMois ?? ''))
      throw new BadRequestException(
        'Indiquez le premier mois payé des nouveaux (ex. 2026-11).',
      );
    if (!DATE_RE.test(o.dateSortie ?? ''))
      throw new BadRequestException(
        'Indiquez la date de sortie de ceux qui ne sont plus sur la liste.',
      );
    const motif = this.config.motif('RETIRE_DDEPPSA');
    if (!motif)
      throw new BadRequestException(
        'Motif « Retiré par la DDEPPSA » introuvable dans la configuration.',
      );
    const feuilles = await lireClasseur(
      contenu,
      ['NOMSETPRENOMS|NOMETPRENOMS|NOMSPRENOMS'],
      { inclureMasquees: false },
    );
    const cle = (nom: string) => motsDuNom(nom).sort().join(' ');
    // Les personnes de la liste, feuille par feuille (le cycle vient du nom de la feuille)
    const liste: {
      nom: string;
      cle: string;
      categorie: string;
      libelle: string;
      feuille: string;
      ligne: number;
      genre: 'F' | 'M' | null;
      specialite: string | null;
      etablissement: string | null;
      circonscription: string | null;
      observation: string | null;
    }[] = [];
    const parFeuille: { nom: string; categorie: string; personnes: number }[] =
      [];
    const feuillesInconnues: string[] = [];
    for (const f of feuilles) {
      const cat = this.config.categorieDepuisTexte(f.nom, 'COMMUNAUTAIRE');
      if (!cat) {
        feuillesInconnues.push(f.nom);
        continue;
      }
      let n = 0;
      for (const l of f.lignes) {
        const nom = nettoyer(
          this.valeur(l, ['NOMSETPRENOMS', 'NOMETPRENOMS', 'NOMSPRENOMS']),
        );
        if (
          !nom ||
          motsDuNom(nom).length < 2 ||
          /^(TOTAL|NOMS?\s+(ET\s+)?PR)/i.test(normaliser(nom))
        )
          continue;
        const sexe = normaliser(enTexte(this.valeur(l, ['GENRE', 'SEXE'])));
        n++;
        liste.push({
          nom,
          cle: cle(nom),
          categorie: cat.code,
          libelle: cat.libelle,
          feuille: f.nom,
          ligne: l._ligne,
          genre: sexe.startsWith('F')
            ? 'F'
            : sexe.startsWith('M') || sexe.startsWith('H')
              ? 'M'
              : null,
          specialite: nettoyer(this.valeur(l, ['DISCIPLINE', 'SPECIALITE'])),
          etablissement: nettoyer(
            this.valeur(l, ['NOUVEAUPOSTE', 'ETABLISSEMENT', 'ANCIENPOSTE']),
          ),
          circonscription: nettoyer(
            this.valeur(l, ['CIRCONSCRIPTION', 'LOCALITE']),
          ),
          observation: nettoyer(this.valeur(l, ['OBSERVATION', 'OBS'])),
        });
      }
      parFeuille.push({ nom: f.nom, categorie: cat.libelle, personnes: n });
    }
    if (!liste.length)
      throw new BadRequestException(
        'Aucune feuille de la liste n’a été reconnue : chaque feuille doit porter le nom d’un cycle (Préscolaire, Primaire, Collège, Lycée, Alphabétisation…) et une colonne « Noms et prénoms ».',
      );
    // Doublons de la liste : la première ligne compte, les autres sont signalées
    const vus = new Map<string, (typeof liste)[number]>();
    const doublons: string[] = [];
    const uniques: typeof liste = [];
    for (const p of liste) {
      const d = vus.get(p.cle);
      if (d) {
        doublons.push(
          `${p.nom} : ${p.feuille} ligne ${p.ligne} (déjà ${d.feuille} ligne ${d.ligne})`,
        );
        continue;
      }
      vus.set(p.cle, p);
      uniques.push(p);
    }
    // Les communautaires de ce département dans le registre
    const fiches = await this.volontaires.find({
      where: { population: 'COMMUNAUTAIRE', departementId: dep.id },
    });
    const {
      gardes,
      reintegres,
      nouveaux,
      plusieursFiches,
      retrouves,
      rapproches,
      ambigus,
      possibles,
    } = this.rapprocherListe(uniques, fiches, o.memes ?? []);
    // En poste dans ce département mais absents de la liste : ils sortent
    const sortants = fiches.filter(
      (v) => v.statut === 'EN_POSTE' && !retrouves.has(v.id),
    );
    // Nettoyage : déjà fonctionnaires, contractuels ou volontaires (signalé, rien n'est décidé)
    const cles = new Set(uniques.map((p) => p.cle));
    const ailleurs = new Map<string, string[]>();
    const noter = (k: string, quoi: string) =>
      ailleurs.set(k, [...(ailleurs.get(k) ?? []), quoi]);
    for (const a of await this.volontaires.query<
      { nom: string; statut: string; matricule: string | null }[]
    >(
      `SELECT "nomComplet" AS nom, statut, matricule FROM agent_recense
        WHERE statut IN ('FONCTIONNAIRE', 'CONTRACTUEL')`,
    )) {
      const k = cle(a.nom);
      if (cles.has(k))
        noter(
          k,
          `${a.statut === 'FONCTIONNAIRE' ? 'fonctionnaire' : 'contractuel(le)'} dans le personnel${a.matricule ? ` (matricule ${a.matricule})` : ''}`,
        );
    }
    for (const v of await this.volontaires.find({
      where: { population: 'VOLONTAIRE', statut: 'EN_POSTE' },
      select: { nomComplet: true, departementBrut: true },
    })) {
      const k = cle(v.nomComplet);
      if (cles.has(k)) noter(k, 'volontaire en poste (bourse)');
    }
    const dejaAilleurs = uniques
      .filter((p) => ailleurs.has(p.cle))
      .map((p) => `${p.nom} : ${ailleurs.get(p.cle)!.join(' ; ')}`);
    // Avant / après, par cycle (comme la synthèse de la liste)
    const parCat = new Map<
      string,
      { libelle: string; avant: number; apres: number }
    >();
    for (const c of this.config.categoriesDe('COMMUNAUTAIRE'))
      parCat.set(c.code, { libelle: c.libelle, avant: 0, apres: 0 });
    for (const v of fiches)
      if (v.statut === 'EN_POSTE' && v.categorie && parCat.has(v.categorie))
        parCat.get(v.categorie)!.avant++;
    for (const p of uniques) parCat.get(p.categorie)!.apres++;
    const montant = (n: 'avant' | 'apres') =>
      [...parCat.entries()].reduce(
        (t, [code, x]) =>
          t +
          x[n] * (this.config.categorie(code, 'COMMUNAUTAIRE')?.bourse ?? 0),
        0,
      );
    const ici = `${nomFichier} (liste du département ${dep.nom})`;
    if (!o.essai) {
      for (const { v, p } of [...gardes, ...reintegres]) {
        // Nom écrit autrement dans la liste : il est gardé sur la fiche (rapprochement mémorisé)
        const autreNom = cle(v.nomComplet) !== p.cle;
        const champs: Partial<Volontaire> = {
          ...(autreNom
            ? {
                verifications: {
                  ...(v.verifications ?? {}),
                  NOM_LISTE: {
                    par: u.nom,
                    le: new Date().toISOString(),
                    note: p.nom,
                  },
                },
              }
            : {}),
          categorie: p.categorie,
          cycleBrut: p.feuille,
          ...(p.etablissement ? { etablissement: p.etablissement } : {}),
          ...(p.circonscription ? { circonscription: p.circonscription } : {}),
          ...(p.observation ? { observation: p.observation } : {}),
          ...(!v.genre && p.genre ? { genre: p.genre } : {}),
          ...(!v.specialite && p.specialite
            ? { specialite: p.specialite }
            : {}),
        };
        if (v.statut === 'SORTI')
          Object.assign(champs, {
            statut: 'EN_POSTE',
            motifSortie: null,
            dateSortie: null,
            premierMois: o.premierMois,
          });
        await this.volontaires.update(v.id, champs);
        await this.mouvement(
          u,
          v.id,
          v.statut === 'SORTI' ? 'REINTEGRATION' : 'MODIFICATION',
          v.statut === 'SORTI' ? `${o.premierMois}-01` : null,
          'LISTE_DEPARTEMENT',
          { source: `${ici} · ${p.feuille} · ligne ${p.ligne}` },
        );
      }
      for (const v of sortants) {
        await this.volontaires.update(v.id, {
          statut: 'SORTI',
          motifSortie: motif.code,
          dateSortie: o.dateSortie,
        });
        await this.mouvement(u, v.id, 'SORTIE', o.dateSortie, motif.code, {
          observation: `Absent(e) de la nouvelle liste du département (${nomFichier})`,
        });
      }
      if (nouveaux.length) {
        const lot = await this.volontaires.save(
          nouveaux.map((p) => ({
            nomComplet: p.nom,
            nomNormalise: normaliser(p.nom),
            genre: p.genre,
            specialite: p.specialite,
            categorie: p.categorie,
            cycleBrut: p.feuille,
            departementId: dep.id,
            departementBrut: dep.nom,
            etablissement: p.etablissement,
            circonscription: p.circonscription,
            observation: p.observation,
            population: 'COMMUNAUTAIRE',
            vague: null,
            vagueNumero: null,
            statut: 'EN_POSTE',
            premierMois: o.premierMois,
            source: `${nomFichier} · ${p.feuille} · ligne ${p.ligne}`,
            creePar: u.nom,
            verifications: {},
          })) as Volontaire[],
        );
        await this.mouvements.save(
          lot.map((v) => ({
            volontaireId: v.id,
            type: 'ENTREE',
            dateEffet: null,
            motif: 'LISTE_DEPARTEMENT',
            details: { source: v.source },
            par: u.nom,
          })),
        );
      }
    }
    const court = (t: string[]) => ({ n: t.length, exemples: t.slice(0, 40) });
    const rapport = {
      essai: o.essai,
      departement: dep.nom,
      feuilles: parFeuille,
      feuillesIgnorees: feuillesInconnues,
      lus: liste.length,
      personnes: uniques.length,
      parCategorie: [...parCat.values()].filter((x) => x.avant || x.apres),
      montantAvant: montant('avant'),
      montantApres: montant('apres'),
      gardes: gardes.length,
      reintegres: court(reintegres.map(({ p }) => p.nom)),
      nouveaux: court(nouveaux.map((p) => `${p.nom} (${p.libelle})`)),
      sortants: court(sortants.map((v) => v.nomComplet)),
      doublonsDansListe: court(doublons),
      plusieursFiches: court(plusieursFiches),
      rapproches: court(rapproches),
      // Toutes les paires à confirmer (l'écran les montre une à une)
      possibles,
      ambigus: court(ambigus),
      dejaAilleurs: court(dejaAilleurs),
    };
    if (!o.essai) {
      await this.journal.log(
        u,
        'COMMUNAUTAIRES_DEPARTEMENT_REMPLACES',
        'volontaire',
        null,
        {
          fichier: nomFichier,
          departement: dep.nom,
          personnes: uniques.length,
          gardes: gardes.length,
          nouveaux: nouveaux.length,
          reintegres: reintegres.length,
          sortis: sortants.length,
          rapport,
        },
      );
      await this.lier();
    }
    return rapport;
  }

  /* --------------------------- Reprise (import) --------------------------- */

  /** Feuilles d'un classeur qui contiennent une liste de personnes (y compris les feuilles masquées). */
  async analyser(contenu: Buffer) {
    const feuilles = await lireClasseur(
      contenu,
      ['NOMSETPRENOMS|NOMETPRENOMS|NOMSPRENOMS'],
      { inclureMasquees: true },
    );
    return feuilles.map((f) => {
      const lignes = this.lignesPersonnes(f.lignes);
      const col = (p: string) => f.entetes.find((e) => e.startsWith(p));
      const cMontant = col('MONTANT');
      return {
        nom: f.nom,
        masquee: !!f.masquee,
        personnes: lignes.length,
        colonnes: f.entetes.slice(0, 16),
        montantTotal: cMontant
          ? lignes.reduce((t, l) => t + (Number(l[cMontant]) || 0), 0)
          : null,
      };
    });
  }

  /** Lignes d'une personne : n° d'ordre et nom (pas les titres répétés, ni les lignes TOTAL). */
  private lignesPersonnes(lignes: Ligne[]) {
    return lignes.filter((l) => {
      const nom = nettoyer(
        this.valeur(l, ['NOMSETPRENOMS', 'NOMETPRENOMS', 'NOMSPRENOMS']),
      );
      const n = this.valeur(l, ['N']);
      return (
        !!nom &&
        motsDuNom(nom).length >= 2 &&
        !/^(TOTAL|NOMS?\s+(ET\s+)?PR)/i.test(normaliser(nom)) &&
        n !== null &&
        /^\d+$/.test(enTexte(n).trim())
      );
    });
  }

  private valeur(l: Ligne, prefixes: string[]): unknown {
    for (const p of prefixes) {
      const k = Object.keys(l).find((x) =>
        p === 'N' ? x === 'N' : x.startsWith(p),
      );
      if (k && l[k] !== null && l[k] !== undefined && l[k] !== '') return l[k];
    }
    return null;
  }

  /**
   * Reprise d'une liste existante :
   * - EN_POSTE : volontaires payés (bourse de septembre…), payés à partir de `premierMois` ;
   * - SORTI : liste de sortants (recrutés en 2023, déserteurs…), avec leur motif.
   * Une personne déjà dans le registre n'est pas recréée. `essai` : rapport sans rien enregistrer.
   */
  async importer(
    u: UtilisateurConnecte,
    contenu: Buffer,
    nomFichier: string,
    o: {
      feuille: string;
      type: 'EN_POSTE' | 'SORTI' | 'NOTE' | 'MISE_A_JOUR';
      /**
       * Fiches déjà dans le registre (07/11/2026) : NON (on ne les touche pas), VIDES (on complète
       * leurs cases vides, par défaut). `remplacer` : rubriques dont une valeur différente du
       * fichier remplace celle du registre.
       */
      miseAJour?: 'NON' | 'VIDES';
      remplacer?: string[];
      motif?: string;
      premierMois?: string;
      noteReference?: string;
      dateNote?: string;
      /** Note de service : catégorie de ceux dont le tableau n'indique ni cycle ni diplôme. */
      categorie?: string;
      /** Liste de volontaires (défaut) ou de communautaires. */
      population?: string;
      essai: boolean;
    },
  ) {
    const population = populationDe(o.population);
    if (population === 'COMMUNAUTAIRE' && o.type === 'NOTE')
      throw new BadRequestException(
        'Les communautaires n’ont pas de note de service : importez leur liste de paiement (en poste) ou leurs sortants.',
      );
    const catDefaut = o.categorie
      ? this.config.categorie(o.categorie, population)
      : null;
    if (o.categorie && !catDefaut)
      throw new BadRequestException(
        'Catégorie par défaut inconnue (voir la configuration).',
      );
    const maj = o.type === 'MISE_A_JOUR' || o.miseAJour !== 'NON';
    const remplacer = new Set(o.remplacer ?? []);
    if (o.type === 'EN_POSTE' && !MOIS_RE.test(o.premierMois ?? ''))
      throw new BadRequestException(
        'Indiquez le mois de bourse de cette liste (ex. 2026-09) : ces volontaires sont payés à partir de ce mois.',
      );
    const noteRef = o.noteReference?.trim() || null;
    if (o.type === 'NOTE' && (!noteRef || !DATE_RE.test(o.dateNote ?? '')))
      throw new BadRequestException(
        'Indiquez le numéro et la date de signature de la note : la bourse démarre selon la règle de la configuration.',
      );
    if (o.type === 'NOTE' && o.premierMois && !MOIS_RE.test(o.premierMois))
      throw new BadRequestException(
        'Premier mois payé attendu sous la forme AAAA-MM.',
      );
    const motif = o.type === 'SORTI' ? this.config.motif(o.motif) : null;
    if (o.type === 'SORTI' && !motif)
      throw new BadRequestException(
        'Choisissez le motif de sortie de cette liste.',
      );
    const f =
      o.type === 'NOTE'
        ? await this.lireNote(contenu, o.feuille)
        : (
            await lireClasseur(
              contenu,
              ['NOMSETPRENOMS|NOMETPRENOMS|NOMSPRENOMS'],
              { inclureMasquees: true },
            )
          ).find((x) => x.nom === o.feuille);
    if (!f)
      throw new BadRequestException(
        `Feuille « ${o.feuille} » introuvable dans ce fichier.`,
      );
    const lignes = this.lignesPersonnes(f.lignes);
    if (!lignes.length)
      throw new BadRequestException(
        'Aucune personne lue dans cette feuille (colonnes « N° » et « Noms et prénoms »).',
      );

    const deps = await this.deps.find();
    const depId = (brut: unknown) => {
      const c = codeDepartement(nettoyer(brut)?.split(/[/(]/)[0]);
      return c ? (deps.find((d) => d.code === c)?.id ?? null) : null;
    };
    // Registre actuel : une personne déjà présente n'est pas recréée
    const index = new IndexNoms<Volontaire>();
    for (const v of await this.volontaires.find())
      index.ajouter(v.nomComplet, v.dateNaissance, v);
    const dansFichier = new IndexNoms<number>();

    const rapport = {
      fichier: nomFichier,
      feuille: f.nom,
      type: o.type,
      lues: lignes.length,
      ajoutes: 0,
      dejaDansRegistre: [] as string[],
      doublonsDansFichier: [] as string[],
      sansCategorie: [] as string[],
      sansDepartement: [] as string[],
      montantsDifferents: [] as string[],
      montantFichier: 0,
      montantBareme: 0,
      /** Sortants retrouvés en poste : leur fiche est sortie. */
      enPosteRetrouves: [] as string[],
      /** Sortants qui ressemblent à une fiche en poste sans certitude : rien n'est fermé. */
      aVerifier: [] as string[],
      sortis: 0,
      autreNote: [] as string[],
      relies: [] as string[],
      agesHorsLimites: [] as string[],
      telephonesPartages: [] as string[],
      /** Mise à jour des fiches déjà présentes (07/11/2026). */
      fichesTrouvees: 0,
      fichesCompletees: 0,
      parChamp: {} as Record<string, number>,
      differences: {} as Record<
        string,
        {
          n: number;
          cle: string;
          remplace: boolean;
          exemples: { nom: string; registre: string; fichier: string }[];
        }
      >,
      plusieursFiches: [] as string[],
      /** Trouvés seulement sur l’autre liste (volontaires ↔ communautaires) : rien n’est changé. */
      autreListe: [] as string[],
      introuvables: [] as string[],
    };
    /** Fiches à mettre à jour : id → champs (le dernier fichier lu l'emporte pour une même fiche). */
    const aMettreAJour = new Map<
      string,
      { nom: string; champs: Partial<Volontaire> }
    >();
    const c = this.config.get();
    const aujourdhui = new Date().toISOString().slice(0, 10);
    const aRelier: { id: string; ici: string }[] = [];
    const aSortir: {
      id: string;
      ici: string;
      date: string | null;
      observation: string | null;
    }[] = [];
    const nouveaux: Partial<Volontaire>[] = [];
    for (const l of lignes) {
      const nom = nettoyer(
        this.valeur(l, ['NOMSETPRENOMS', 'NOMETPRENOMS', 'NOMSPRENOMS']),
      )!.replace(/\s+/g, ' ');
      const naissance = lireDate(
        this.valeur(l, ['DATEDENAISSANCE', 'DATEDENAIS', 'NELE']),
      );
      const cycleBrut = nettoyer(this.valeur(l, ['CYCLE']));
      const diplome = nettoyer(this.valeur(l, ['DIPLOME']));
      // Le diplôme passe avant le cycle (un DEMA enseigne au collège mais relève des Beaux-Arts)
      const cat =
        o.type === 'NOTE'
          ? (this.config.categorieDepuisTexte(
              `${diplome ?? ''} ${cycleBrut ?? ''}`,
            ) ?? catDefaut)
          : this.config.categorieDepuisTexte(cycleBrut, population);
      // Note de service : le département vient du titre de section (« I- DEPARTEMENT DE LA BOUENZA »)
      // ou de « Département retenu » (« Brazzaville/Amitié ») ; pas des souhaits « Départ. 1, 2, 3 »
      const depBrut =
        o.type === 'NOTE'
          ? (nettoyer(l._dep) ??
            nettoyer(this.valeur(l, ['DEPARTEMENTRETENU'])))
          : nettoyer(this.valeur(l, ['DEPART']));
      const departementId = depId(depBrut);
      const montantFichier = Number(this.valeur(l, ['MONTANT'])) || 0;
      const ici = `${nom} (ligne ${l._ligne})`;

      const deja = index.probables(nom, naissance);
      if (maj) {
        // Seulement les fiches de la même liste : un volontaire de la bourse ne met jamais à jour une
        // fiche de communautaire du même nom (07/11/2026). La liste de la ligne : sa colonne
        // « Statut » quand le fichier mélange les deux (base biométrique), sinon la liste de l'écran.
        const statutLigne = normaliser(enTexte(this.valeur(l, ['STATUT'])));
        const listeLigne = statutLigne.startsWith('COMMUN')
          ? 'COMMUNAUTAIRE'
          : statutLigne.startsWith('VOLONT')
            ? 'VOLONTAIRE'
            : population;
        const memeListe = deja.filter((x) => x.population === listeLigne);
        const cible = this.ficheSure(memeListe, nom, naissance);
        if (!memeListe.length && deja.length) {
          // Sur l'autre liste seulement : rien n'est changé, c'est signalé (double inscription ?)
          rapport.autreListe.push(
            `${ici} : sur la liste des ${LISTES[deja[0].population] ?? deja[0].population} (${deja[0].nomComplet})`,
          );
          if (o.type === 'MISE_A_JOUR') continue;
        } else if (cible) {
          rapport.fichesTrouvees++;
          this.preparerMiseAJour(
            cible,
            this.valeursDuFichier(l, {
              naissance,
              cycleBrut,
              diplome,
              departementId,
              depBrut,
              population: cible.population,
            }),
            remplacer,
            rapport,
            aMettreAJour,
          );
        } else if (memeListe.length > 1)
          rapport.plusieursFiches.push(
            `${ici} : ${memeListe.map((x) => x.nomComplet).join(', ')}`,
          );
        else if (o.type === 'MISE_A_JOUR') rapport.introuvables.push(ici);
        if (o.type === 'MISE_A_JOUR') continue;
      }
      if (deja.length && o.type === 'NOTE') {
        const autre = deja.find(
          (x) => x.noteReference && x.noteReference !== noteRef,
        );
        if (autre)
          rapport.autreNote.push(
            `${ici} : déjà affecté(e) par la note n° ${autre.noteReference}${autre.etablissement ? ` (${autre.etablissement})` : ''}`,
          );
        else if (deja.some((x) => x.noteReference === noteRef))
          rapport.dejaDansRegistre.push(ici);
        else {
          // Repris d'une liste de bourse, sans note : on relie la fiche (celle qui porte
          // exactement le même nom s'il y en a plusieurs de ressemblantes)
          const exactes = deja.filter(
            (x) => x.nomNormalise === normaliser(nom),
          );
          const cible =
            deja.length === 1
              ? deja[0]
              : exactes.length === 1
                ? exactes[0]
                : null;
          if (cible) {
            rapport.relies.push(`${ici} ↔ ${cible.nomComplet}`);
            aRelier.push({ id: cible.id, ici });
          } else
            rapport.dejaDansRegistre.push(
              `${ici} : plusieurs fiches possibles (${deja.map((x) => x.nomComplet).join(', ')}) — à relier à la main`,
            );
        }
        continue;
      }
      if (deja.some((x) => x.population !== population)) {
        const x = deja.find((y) => y.population !== population)!;
        rapport.dejaDansRegistre.push(
          `${ici} : déjà sur la liste des ${LISTES[x.population] ?? x.population} (${x.nomComplet})`,
        );
        continue;
      }
      if (deja.length) {
        const enPoste = deja.filter((x) => x.statut === 'EN_POSTE');
        if (o.type === 'SORTI' && enPoste.length) {
          // Sortant encore en poste : c'est sa fiche qui sort, sans nouvelle fiche. Une seule fiche
          // possible, et le nom identique quand une date de naissance manque (bourse sans date) ;
          // sinon, à vérifier à la main.
          const cible = enPoste.length === 1 ? enPoste[0] : null;
          const sure =
            !!cible &&
            ((!!naissance && !!cible.dateNaissance) ||
              cible.nomNormalise === normaliser(nom));
          if (cible && aSortir.some((x) => x.id === cible.id))
            rapport.doublonsDansFichier.push(`${ici} ↔ ${cible.nomComplet}`);
          else if (cible && sure) {
            aSortir.push({
              id: cible.id,
              ici,
              date: lireDate(
                this.valeur(l, ['DATEPRISEENCHARGE', 'PRISEENCHARGE']),
              ),
              observation: nettoyer(this.valeur(l, ['OBS'])),
            });
            rapport.enPosteRetrouves.push(`${ici} ↔ ${cible.nomComplet}`);
          } else
            rapport.aVerifier.push(
              `${ici} : ${enPoste.map((x) => x.nomComplet).join(', ')} — à sortir à la main depuis sa fiche`,
            );
        } else rapport.dejaDansRegistre.push(ici);
        continue;
      }
      const memes = dansFichier.probables(nom, naissance);
      if (memes.length)
        rapport.doublonsDansFichier.push(`${ici} ↔ ligne ${memes[0]}`);
      dansFichier.ajouter(nom, naissance, l._ligne);

      if (o.type !== 'SORTI' && naissance) {
        const age = ageRevolu(naissance, aujourdhui);
        if (age < c.ageMinimum || age > c.ageMaximum)
          rapport.agesHorsLimites.push(`${ici} : ${age} ans`);
      }
      if (o.type === 'NOTE') {
        if (!cat)
          rapport.sansCategorie.push(
            `${ici} : « ${[diplome, cycleBrut].filter(Boolean).join(' / ') || 'vide'} »`,
          );
        if (!departementId)
          rapport.sansDepartement.push(`${ici} : « ${depBrut ?? 'vide'} »`);
      }
      if (o.type === 'EN_POSTE') {
        if (!cat)
          rapport.sansCategorie.push(`${ici} : « ${cycleBrut ?? 'vide'} »`);
        if (!departementId)
          rapport.sansDepartement.push(`${ici} : « ${depBrut ?? 'vide'} »`);
        rapport.montantFichier += montantFichier;
        rapport.montantBareme += cat?.bourse ?? 0;
        if (cat && montantFichier && montantFichier !== cat.bourse)
          rapport.montantsDifferents.push(
            `${ici} : ${montantFichier} au lieu de ${cat.bourse} (${cat.libelle})`,
          );
      }
      const datePc = lireDate(
        this.valeur(l, ['DATEPRISEENCHARGE', 'PRISEENCHARGE']),
      );
      nouveaux.push({
        nomComplet: nom,
        nomNormalise: normaliser(nom),
        dateNaissance: naissance,
        lieuNaissance: nettoyer(
          this.valeur(l, ['LIEUDENAISSANCE', 'LIEUDENAIS']),
        ),
        telephone: nettoyer(this.valeur(l, ['TELEPHONE', 'TEL'])),
        diplome,
        specialite: nettoyer(this.valeur(l, ['SPECIALITE'])),
        categorie: cat?.code ?? null,
        cycleBrut,
        departementId,
        departementBrut: depBrut,
        etablissement:
          nettoyer(this.valeur(l, ['ETABLISSEMENT'])) ??
          (o.type === 'NOTE'
            ? (nettoyer(l._etab) ??
              nettoyer(
                enTexte(this.valeur(l, ['DEPARTEMENTRETENU'])).split('/')[1],
              ))
            : null),
        population,
        ...(() => {
          // Les communautaires n'ont pas de vague
          if (population === 'COMMUNAUTAIRE')
            return { vague: null, vagueNumero: null };
          const vague = vagueNormalisee(this.valeur(l, ['VAGUE', 'PROMOTION']));
          return { vague, vagueNumero: this.config.numeroVague(vague) };
        })(),
        statut: o.type === 'SORTI' ? 'SORTI' : 'EN_POSTE',
        motifSortie: motif?.code ?? null,
        dateSortie: o.type === 'SORTI' ? datePc : null,
        premierMois:
          o.type === 'EN_POSTE'
            ? o.premierMois!
            : o.type === 'NOTE'
              ? o.premierMois || null
              : null,
        noteReference: o.type === 'NOTE' ? noteRef : null,
        dateNote: o.type === 'NOTE' ? o.dateNote! : null,
        observation: nettoyer(this.valeur(l, ['OBS'])),
        source: `${nomFichier} · ${f.nom} · ligne ${l._ligne}`,
        creePar: u.nom,
        verifications: {},
      });
    }
    // Téléphone partagé : dans le fichier et avec les volontaires en poste
    if (o.type !== 'SORTI') {
      const parTel = new Map<string, string[]>();
      const cle = (t: string | null | undefined) =>
        (t ?? '').replace(/\D/g, '').slice(-9);
      for (const v of await this.volontaires.find({
        where: { statut: 'EN_POSTE' },
        select: { telephone: true, nomComplet: true },
      })) {
        const k = cle(v.telephone);
        if (k.length >= 8)
          parTel.set(k, [...(parTel.get(k) ?? []), v.nomComplet]);
      }
      for (const v of nouveaux) {
        const k = cle(v.telephone);
        if (k.length >= 8)
          parTel.set(k, [
            ...(parTel.get(k) ?? []),
            `${v.nomComplet} (fichier)`,
          ]);
      }
      for (const [k, noms] of parTel)
        if (
          noms.length >= c.telephonePartage &&
          noms.some((x) => x.endsWith('(fichier)'))
        )
          rapport.telephonesPartages.push(
            `…${k.slice(-4)} : ${noms.join(', ')}`,
          );
    }
    rapport.ajoutes = nouveaux.length;
    rapport.sortis = aSortir.length;
    rapport.fichesCompletees = aMettreAJour.size;
    if (!o.essai)
      for (const [id, x] of aMettreAJour) {
        await this.volontaires.update(id, x.champs);
        await this.mouvement(u, id, 'MODIFICATION', null, 'MISE_A_JOUR', {
          source: `${nomFichier} · ${f.nom}`,
          champs: Object.keys(x.champs),
        });
      }
    // Sans date dans la liste, la bourse s'arrête tout de suite (comme pour une fiche ajoutée sortie)
    if (!o.essai)
      for (const s of aSortir) {
        await this.volontaires.update(s.id, {
          statut: 'SORTI',
          motifSortie: motif!.code,
          dateSortie: s.date,
        });
        await this.mouvement(u, s.id, 'SORTIE', s.date, motif!.code, {
          source: `${nomFichier} · ${f.nom}`,
          ligne: s.ici,
          observation: s.observation,
        });
      }
    if (!o.essai)
      for (const r of aRelier) {
        await this.volontaires.update(r.id, {
          noteReference: noteRef,
          dateNote: o.dateNote!,
        });
        await this.mouvement(u, r.id, 'MODIFICATION', null, 'NOTE', {
          note: noteRef,
          relie: r.ici,
        });
      }
    if (!o.essai && nouveaux.length) {
      for (let i = 0; i < nouveaux.length; i += 500) {
        const lot = await this.volontaires.save(
          nouveaux.slice(i, i + 500) as Volontaire[],
        );
        await this.mouvements.save(
          lot.map((v) => ({
            volontaireId: v.id,
            type: o.type === 'SORTI' ? 'SORTIE' : 'ENTREE',
            dateEffet: o.type === 'NOTE' ? v.dateNote : v.dateSortie,
            motif:
              o.type === 'SORTI'
                ? v.motifSortie
                : o.type === 'NOTE'
                  ? 'NOTE'
                  : 'REPRISE',
            details: { source: v.source },
            par: u.nom,
          })),
        );
      }
    }
    // Les listes détaillées sont limitées (le nombre exact reste donné)
    const court = (t: string[]) => ({ n: t.length, exemples: t.slice(0, 30) });
    const sortie = {
      ...rapport,
      dejaDansRegistre: court(rapport.dejaDansRegistre),
      doublonsDansFichier: court(rapport.doublonsDansFichier),
      sansCategorie: court(rapport.sansCategorie),
      sansDepartement: court(rapport.sansDepartement),
      montantsDifferents: court(rapport.montantsDifferents),
      enPosteRetrouves: court(rapport.enPosteRetrouves),
      aVerifier: court(rapport.aVerifier),
      autreNote: court(rapport.autreNote),
      relies: court(rapport.relies),
      agesHorsLimites: court(rapport.agesHorsLimites),
      telephonesPartages: court(rapport.telephonesPartages),
      plusieursFiches: court(rapport.plusieursFiches),
      autreListe: court(rapport.autreListe),
      introuvables: court(rapport.introuvables),
      essai: o.essai,
    };
    // Import pour de bon : le rapport complet est gardé au journal, pour le revoir plus tard
    // (DG, 26/10/2026 : après l'import, les mêmes messages que pendant l'essai)
    if (!o.essai) {
      await this.journal.log(u, 'VOLONTAIRES_IMPORTES', 'volontaire', null, {
        fichier: nomFichier,
        feuille: f.nom,
        type: o.type,
        population,
        ajoutes: nouveaux.length,
        sortis: aSortir.length,
        completees: aMettreAJour.size,
        rapport: sortie,
      });
      if (nouveaux.length || aSortir.length || aMettreAJour.size)
        await this.lier();
    }
    return sortie;
  }

  /**
   * La fiche du registre d'une ligne du fichier, quand elle est sûre : une seule fiche possible, ou
   * une seule écrite exactement pareil, ou une seule née le même jour. Sinon, rien (à voir à la main).
   */
  private ficheSure(deja: Volontaire[], nom: string, naissance: string | null) {
    if (deja.length === 1) return deja[0];
    const exactes = deja.filter((x) => x.nomNormalise === normaliser(nom));
    if (exactes.length === 1) return exactes[0];
    if (naissance) {
      const nes = deja.filter((x) => x.dateNaissance === naissance);
      if (nes.length === 1) return nes[0];
    }
    return null;
  }

  /** Ce que dit une ligne du fichier, champ par champ (vide : le fichier ne dit rien). */
  private valeursDuFichier(
    l: Ligne,
    x: {
      naissance: string | null;
      cycleBrut: string | null;
      diplome: string | null;
      departementId: number | null;
      depBrut: string | null;
      population: string;
    },
  ): Partial<Volontaire> {
    const sexe = normaliser(enTexte(this.valeur(l, ['SEXE', 'GENRE'])));
    const etab = nettoyer(this.valeur(l, ['ETABLISSEMENT']));
    const specialite = nettoyer(this.valeur(l, ['SPECIALITE']));
    const cat = categorieCommunautaire(
      this.config,
      x.cycleBrut,
      specialite,
      populationDe(x.population),
    );
    const vague =
      x.population === 'COMMUNAUTAIRE'
        ? null
        : vagueNormalisee(this.valeur(l, ['VAGUE', 'PROMOTION']));
    return {
      dateNaissance: x.naissance,
      lieuNaissance: nettoyer(
        this.valeur(l, ['LIEUDENAISSANCE', 'LIEUDENAIS']),
      ),
      genre: sexe.startsWith('F')
        ? 'F'
        : sexe.startsWith('M') || sexe.startsWith('H')
          ? 'M'
          : null,
      telephone: nettoyer(this.valeur(l, ['TELEPHONE', 'TEL'])),
      diplome: x.diplome,
      specialite,
      cycleBrut: x.cycleBrut,
      categorie: cat?.code ?? null,
      departementId: x.departementId,
      departementBrut: x.departementId ? x.depBrut : null,
      etablissement: etab ?? nettoyer(this.valeur(l, ['LIEUDESERVICE'])),
      circonscription: nettoyer(this.valeur(l, ['CIRCONSCRIPTION', 'CIRCONS'])),
      datePriseService: lireDate(
        this.valeur(l, [
          'DATEDEPRISEDESERVICE',
          'DATEDEPRISEDESERVI',
          'PRISEDESERVICE',
          'DATEPRISESERVICE',
        ]),
      ),
      vague,
      vagueNumero: vague ? this.config.numeroVague(vague) : null,
    };
  }

  /**
   * Compare la fiche et la ligne : une case vide de la fiche prend la valeur du fichier ; une valeur
   * différente n'est remplacée que si sa rubrique est cochée (sinon elle est seulement montrée).
   */
  private preparerMiseAJour(
    v: Volontaire,
    fichier: Partial<Volontaire>,
    remplacer: Set<string>,
    rapport: {
      parChamp: Record<string, number>;
      differences: Record<
        string,
        {
          n: number;
          cle: string;
          remplace: boolean;
          exemples: { nom: string; registre: string; fichier: string }[];
        }
      >;
    },
    aMettreAJour: Map<string, { nom: string; champs: Partial<Volontaire> }>,
  ) {
    const vide = (x: unknown) =>
      x === null || x === undefined || String(x).trim() === '';
    const pareil = (k: string, a: unknown, b: unknown) =>
      k === 'telephone'
        ? String(a).replace(/\D/g, '').slice(-8) ===
          String(b).replace(/\D/g, '').slice(-8)
        : // « 2-Primaire » et « Primaire » : même cycle s'ils donnent le même barème
          k === 'cycleBrut' && fichier.categorie && v.categorie
          ? fichier.categorie === v.categorie
          : // Lettres seulement : « Lycée de Bouansa » = « LYCEE DE BOUANSA »
            normaliser(enTexte(a)).replace(/[^A-Z0-9]/g, '') ===
            normaliser(enTexte(b)).replace(/[^A-Z0-9]/g, '');
    // Rubriques liées : le département porte aussi son texte, la vague son numéro, le cycle sa catégorie
    const suit: Record<string, string> = {
      departementBrut: 'departementId',
      vagueNumero: 'vague',
      categorie: 'cycleBrut',
    };
    const champs: Partial<Volontaire> = {
      ...(aMettreAJour.get(v.id)?.champs ?? {}),
    };
    for (const [k, valeur] of Object.entries(fichier) as [
      keyof Volontaire,
      unknown,
    ][]) {
      if (suit[k] || vide(valeur)) continue;
      const actuel = v[k];
      const libelle = CHAMPS_MISE_A_JOUR[k] ?? k;
      let prendre = false;
      if (vide(actuel)) prendre = true;
      else if (!pareil(k, actuel, valeur)) {
        const d = (rapport.differences[libelle] ??= {
          n: 0,
          cle: k,
          remplace: remplacer.has(k),
          exemples: [],
        });
        d.n++;
        if (d.exemples.length < 20)
          d.exemples.push({
            nom: v.nomComplet,
            registre:
              k === 'departementId'
                ? String(v.departementBrut ?? actuel)
                : enTexte(actuel),
            fichier:
              k === 'departementId'
                ? String(fichier.departementBrut ?? valeur)
                : enTexte(valeur),
          });
        prendre = remplacer.has(k);
      }
      if (!prendre) continue;
      (champs as Record<string, unknown>)[k] = valeur;
      for (const [lie, maitre] of Object.entries(suit))
        if (maitre === k && !vide(fichier[lie as keyof Volontaire]))
          (champs as Record<string, unknown>)[lie] =
            fichier[lie as keyof Volontaire];
      if (
        !aMettreAJour.get(v.id)?.champs ||
        !(k in (aMettreAJour.get(v.id)?.champs ?? {}))
      )
        rapport.parChamp[libelle] = (rapport.parChamp[libelle] ?? 0) + 1;
    }
    if (Object.keys(champs).length)
      aMettreAJour.set(v.id, { nom: v.nomComplet, champs });
  }

  /** Le rapport du dernier import (pour de bon) de cette population : revu après coup. */
  async dernierImport(population: string) {
    const [j] = await this.volontaires.manager.query<
      {
        date: Date;
        utilisateurNom: string | null;
        details: Record<string, unknown>;
      }[]
    >(
      `SELECT date, "utilisateurNom", details FROM journal
       WHERE action = 'VOLONTAIRES_IMPORTES' AND details->>'population' = $1
         AND details ? 'rapport'
       ORDER BY date DESC LIMIT 1`,
      [population],
    );
    return j
      ? {
          date: j.date,
          par: j.utilisateurNom,
          fichier: j.details.fichier,
          feuille: j.details.feuille,
          type: j.details.type,
          rapport: j.details.rapport,
        }
      : null;
  }

  /**
   * Note de service mise en page : sections « I- DEPARTEMENT DE LA BOUENZA », puis le nom de
   * l'établissement, puis son tableau (en-têtes répétés). Chaque personne reçoit le département
   * et l'établissement de sa section.
   */
  private async lireNote(contenu: Buffer, feuille: string) {
    const brutes = await lireFeuilleBrute(contenu, feuille);
    if (!brutes) return undefined;
    let colonnes: Map<number, string> | null = null;
    let dep: string | null = null;
    let etab: string | null = null;
    const lignes: Ligne[] = [];
    const entetes = new Set<string>();
    for (const { numero, valeurs } of brutes) {
      const cles = valeurs.map((v) => cleCompacte(v));
      if (
        cles.some((k) => /^(NOMSETPRENOMS|NOMETPRENOMS|NOMSPRENOMS)/.test(k))
      ) {
        colonnes = new Map();
        const vus = new Map<string, number>();
        cles.forEach((k, i) => {
          if (!k) return;
          const n = (vus.get(k) ?? 0) + 1;
          vus.set(k, n);
          colonnes!.set(i, n === 1 ? k : `${k}_${n}`);
          entetes.add(k);
        });
        continue;
      }
      const textes = valeurs.filter(
        (v) => typeof v === 'string' && v.trim(),
      ) as string[];
      const premier = valeurs.find(
        (v) => v !== null && v !== undefined && v !== '',
      );
      // Titre de section : une ou deux cellules de texte, pas de n° d'ordre
      if (textes.length && textes.length <= 2 && typeof premier === 'string') {
        const t = normaliser(textes[0]);
        const d =
          /DEPARTEMENT\s+(?:DE\s+LA\s+|DE\s+L'|DU\s+|DES\s+|DE\s+)?(.+)$/.exec(
            t,
          );
        if (d && /^[IVXL]+\s*-|^DEPARTEMENT/.test(t)) {
          dep = d[1];
          etab = null;
          continue;
        }
        if (
          /^(LYCEE|COLLEGE|CEG|ECOLE|EPP|EP\s|INSTITUT|CENTRE|A LA DISPOSITION|DDEPPSA|INSPECTION|CIRCONSCRIPTION|DIRECTION)/.test(
            t,
          )
        ) {
          etab = textes[0].replace(/\s+/g, ' ').trim();
          continue;
        }
      }
      if (!colonnes) continue;
      const l: Ligne = { _ligne: numero };
      let rempli = false;
      for (const [i, k] of colonnes) {
        const v = valeurs[i];
        if (
          v !== null &&
          v !== undefined &&
          v !== '' &&
          !(typeof v === 'string' && !v.trim())
        ) {
          l[k] = v;
          rempli = true;
        }
      }
      if (!rempli) continue;
      l._dep = dep;
      l._etab = etab;
      lignes.push(l);
    }
    return { nom: feuille, lignes, entetes: [...entetes] };
  }

  /* --------------------------- Correction en série --------------------------- */

  /** Valeurs distinctes d'un champ (pour repérer les fautes : « 2022022 », « 7è Vague »…). */
  async valeurs(champ: string) {
    const col = CHAMPS_EN_SERIE[champ];
    if (!col) throw new BadRequestException('Champ non corrigeable en série.');
    return this.volontaires.query<{ valeur: string | null; n: number }[]>(
      `SELECT "${col}" AS valeur, count(*)::int AS n FROM volontaire GROUP BY 1 ORDER BY 2 DESC, 1`,
    );
  }

  /** Remplace une valeur par une autre sur toutes les fiches (chaque fiche garde la trace). */
  async corrigerEnSerie(
    u: UtilisateurConnecte,
    dto: { champ: string; ancienne: string | null; nouvelle: string | null },
  ) {
    const col = CHAMPS_EN_SERIE[dto.champ];
    if (!col) throw new BadRequestException('Champ non corrigeable en série.');
    const ancienne = dto.ancienne ?? null;
    let nouvelle =
      typeof dto.nouvelle === 'string'
        ? dto.nouvelle.replace(/\s+/g, ' ').trim() || null
        : null;
    if (col === 'vague') nouvelle = vagueNormalisee(nouvelle);
    if (ancienne === nouvelle)
      throw new BadRequestException(
        'La nouvelle valeur est identique à l’ancienne.',
      );
    const ids = (
      await this.volontaires.query<{ id: string }[]>(
        `SELECT id FROM volontaire WHERE "${col}" IS NOT DISTINCT FROM $1`,
        [ancienne],
      )
    ).map((x) => x.id);
    if (!ids.length)
      throw new BadRequestException('Aucune fiche ne porte cette valeur.');
    await this.volontaires.manager.transaction(async (m) => {
      await m.query(
        `UPDATE volontaire SET "${col}" = $1, "modifieLe" = now() WHERE "${col}" IS NOT DISTINCT FROM $2`,
        [nouvelle, ancienne],
      );
      for (let i = 0; i < ids.length; i += 1000)
        await m.insert(
          MouvementVolontaire,
          ids.slice(i, i + 1000).map((volontaireId) => ({
            volontaireId,
            type: 'MODIFICATION',
            motif: 'SERIE',
            details: {
              avant: { [col]: ancienne },
              apres: { [col]: nouvelle },
              serie: true,
            },
            par: u.nom,
          })),
        );
    });
    await this.journal.log(u, 'VOLONTAIRES_CORRIGES', 'volontaire', null, {
      champ: col,
      ancienne,
      nouvelle,
      fiches: ids.length,
    });
    await this.lier();
    return { corriges: ids.length, champ: col, ancienne, nouvelle };
  }
}
