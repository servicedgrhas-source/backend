import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { lireClasseur, lireFeuilleBrute, type Ligne } from '../common/excel';
import { IndexNoms } from '../common/index-noms';
import { MOIS_RE } from '../common/mois';
import { codeDepartement } from '../common/referentiels';
import { motsDuNom } from '../common/ressemblance';
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
import { ConfigEnrolementService } from './configuration';

export interface FiltresVolontaires {
  population?: string;
  vague?: number;
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

  async liste(f: FiltresVolontaires) {
    const taille = Math.min(Math.max(f.taille ?? 50, 1), 200);
    const page = Math.max(f.page ?? 1, 1);
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
    if (f.vague !== undefined)
      q.andWhere('v.vagueNumero = :vg', { vg: f.vague });
    if (f.statut) q.andWhere('v.statut = :s', { s: f.statut });
    if (f.departementId)
      q.andWhere('v.departementId = :d', { d: f.departementId });
    if (f.categorie === '-') q.andWhere('v.categorie IS NULL');
    else if (f.categorie) q.andWhere('v.categorie = :c', { c: f.categorie });
    if (f.motif) q.andWhere('v.motifSortie = :mo', { mo: f.motif });
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

  /* ------------------------------ Entrées ------------------------------ */

  /**
   * Ajout à la main d'un volontaire (reprise d'un oubli, dossier arrivé hors liste).
   * Une personne probablement déjà dans le registre est refusée, sauf confirmation (`forcer`).
   */
  async creer(
    u: UtilisateurConnecte,
    dto: VolontaireDto & { forcer?: boolean },
  ) {
    const nom = (dto.nomComplet ?? '').replace(/\s+/g, ' ').trim();
    if (motsDuNom(nom).length < 2)
      throw new BadRequestException('Écrivez le nom et au moins un prénom.');
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
    await this.mouvement(u, v.id, 'ENTREE', null, 'SAISIE', null);
    // Les autres champs passent par les mêmes contrôles qu'une correction
    const { nomComplet: _n, forcer: _f, population: _p, ...reste } = dto;
    void _n;
    void _f;
    void _p;
    try {
      await this.modifier(u, v.id, reste, false);
    } catch (e) {
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
  async sortir(
    u: UtilisateurConnecte,
    id: string,
    dto: { motif: string; date: string; observation?: string },
  ) {
    const v = await this.volontaires.findOne({ where: { id } });
    if (!v) throw new NotFoundException('Volontaire introuvable');
    if (v.statut === 'SORTI')
      throw new BadRequestException('Ce volontaire est déjà sorti.');
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
      type: 'EN_POSTE' | 'SORTI' | 'NOTE';
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
      enPosteRetrouves: [] as string[],
      autreNote: [] as string[],
      relies: [] as string[],
      agesHorsLimites: [] as string[],
      telephonesPartages: [] as string[],
    };
    const c = this.config.get();
    const aujourdhui = new Date().toISOString().slice(0, 10);
    const aRelier: { id: string; ici: string }[] = [];
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
        if (o.type === 'SORTI' && deja.some((x) => x.statut === 'EN_POSTE'))
          rapport.enPosteRetrouves.push(
            `${ici} ↔ ${deja.find((x) => x.statut === 'EN_POSTE')!.nomComplet}`,
          );
        else {
          rapport.dejaDansRegistre.push(ici);
          continue;
        }
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
      await this.journal.log(u, 'VOLONTAIRES_IMPORTES', 'volontaire', null, {
        fichier: nomFichier,
        feuille: f.nom,
        type: o.type,
        population,
        ajoutes: nouveaux.length,
      });
      await this.lier();
    }
    // Les listes détaillées sont limitées (le nombre exact reste donné)
    const court = (t: string[]) => ({ n: t.length, exemples: t.slice(0, 30) });
    return {
      ...rapport,
      dejaDansRegistre: court(rapport.dejaDansRegistre),
      doublonsDansFichier: court(rapport.doublonsDansFichier),
      sansCategorie: court(rapport.sansCategorie),
      sansDepartement: court(rapport.sansDepartement),
      montantsDifferents: court(rapport.montantsDifferents),
      enPosteRetrouves: court(rapport.enPosteRetrouves),
      autreNote: court(rapport.autreNote),
      relies: court(rapport.relies),
      agesHorsLimites: court(rapport.agesHorsLimites),
      telephonesPartages: court(rapport.telephonesPartages),
      essai: o.essai,
    };
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
