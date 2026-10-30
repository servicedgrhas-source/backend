import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import ExcelJS from 'exceljs';
import { DataSource, Repository } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { lireClasseur, type Ligne } from '../common/excel';
import { IndexNoms } from '../common/index-noms';
import { montantArrete } from '../common/lettres';
import { codeDepartement } from '../common/referentiels';
import { motsDuNom } from '../common/ressemblance';
import { enTexte, lireDate, nettoyer, normaliser } from '../common/texte';
import { JournalService, ParametresService } from '../core/core.service';
import {
  Departement,
  LigneMiseEnRoute,
  MiseEnRoute,
  Volontaire,
} from '../entities';
import { ConfigEnrolementService } from './configuration';

export const CONTROLES_MER: Record<
  string,
  { libelle: string; gravite: 'BLOQUANT' | 'SIGNALE' }
> = {
  DEJA_MIS_EN_ROUTE: {
    libelle: 'Déjà mis(e) en route : non repris(e)',
    gravite: 'SIGNALE',
  },
  TRANSPORT: {
    libelle: 'Transport non fixé pour ce département',
    gravite: 'BLOQUANT',
  },
  CATEGORIE: { libelle: 'Catégorie de bourse inconnue', gravite: 'BLOQUANT' },
  DEPARTEMENT: { libelle: 'Département inconnu', gravite: 'BLOQUANT' },
  DOUBLON: { libelle: 'Inscrit deux fois', gravite: 'BLOQUANT' },
  ETABLISSEMENT: { libelle: 'Établissement non renseigné', gravite: 'SIGNALE' },
};

interface AnomalieMer {
  code: string;
  gravite: 'BLOQUANT' | 'SIGNALE';
  volontaireId: string | null;
  nomComplet: string;
  message: string;
}

/** Contrôle vérifié à la main sur la fiche du volontaire (même clé que pour la bourse). */
const VERIF = (code: string) =>
  code === 'DEJA_MIS_EN_ROUTE' ? 'MISE_EN_ROUTE' : code;

@Injectable()
export class MiseEnRouteService {
  constructor(
    private readonly ds: DataSource,
    @InjectRepository(MiseEnRoute)
    private readonly mers: Repository<MiseEnRoute>,
    @InjectRepository(LigneMiseEnRoute)
    private readonly lignes: Repository<LigneMiseEnRoute>,
    @InjectRepository(Volontaire)
    private readonly volontaires: Repository<Volontaire>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    private readonly config: ConfigEnrolementService,
    private readonly params: ParametresService,
    private readonly journal: JournalService,
  ) {}

  /* ------------------------------ Lecture ------------------------------ */

  async liste() {
    return this.mers.find({ order: { id: 'DESC' } });
  }

  /** Notes de service présentes dans le registre, et celles qui ont déjà un état de mise en route. */
  async notes() {
    return this.volontaires.query<
      {
        noteReference: string;
        dateNote: string | null;
        enPoste: number;
        total: number;
        miseEnRoute: string | null;
      }[]
    >(
      `SELECT v."noteReference", min(v."dateNote")::text AS "dateNote",
              count(*) FILTER (WHERE v.statut = 'EN_POSTE')::int AS "enPoste", count(*)::int AS total,
              (SELECT string_agg(m.libelle || ' (' || lower(m.statut) || ')', ', ')
                 FROM mise_en_route m WHERE m."noteReference" = v."noteReference") AS "miseEnRoute"
         FROM volontaire v WHERE v."noteReference" IS NOT NULL
        GROUP BY v."noteReference" ORDER BY min(v."dateNote") DESC NULLS LAST, 1`,
    );
  }

  async detail(id: number) {
    const mer = await this.mers.findOne({ where: { id } });
    if (!mer) throw new NotFoundException('État de mise en route introuvable');
    const lignes = await this.lignes.find({
      where: { miseEnRouteId: id },
      order: { departementId: 'ASC', nomComplet: 'ASC' },
    });
    return { mer, lignes, controles: CONTROLES_MER };
  }

  /* ------------------------------ Calcul ------------------------------ */

  /** Prépare (ou recalcule) l'état de mise en route des volontaires d'une note. */
  async preparer(
    u: UtilisateurConnecte,
    dto: { noteReference: string; libelle?: string; id?: number },
  ) {
    const note = dto.noteReference?.trim();
    if (!note) throw new BadRequestException('Choisissez la note de service.');
    let mer = dto.id
      ? await this.mers.findOne({ where: { id: dto.id } })
      : await this.mers.findOne({
          where: { noteReference: note, source: 'CALCUL', statut: 'BROUILLON' },
        });
    if (mer?.statut === 'VALIDE')
      throw new BadRequestException(
        'Cet état est validé : le DG doit le rouvrir avant tout nouveau calcul.',
      );
    if (mer?.source === 'REPRISE')
      throw new BadRequestException(
        'Une fiche reprise (déjà payée) ne se recalcule pas.',
      );
    const c = this.config.get();
    const deps = new Map(
      (await this.deps.find()).map((d) => [d.id, d] as const),
    );
    const vs = await this.volontaires.find({
      where: { noteReference: note, statut: 'EN_POSTE' },
      order: { nomNormalise: 'ASC' },
    });
    if (!vs.length)
      throw new BadRequestException(
        `Aucun volontaire en poste avec la note n° ${note} dans le registre.`,
      );

    // Déjà mis en route ailleurs (état validé, y compris les fiches reprises)
    const deja = new Map<string, string>();
    for (const r of await this.lignes.query<{ v: string; libelle: string }[]>(
      `SELECT l."volontaireId" AS v, string_agg(m.libelle, ', ') AS libelle
         FROM ligne_mise_en_route l JOIN mise_en_route m ON m.id = l."miseEnRouteId"
        WHERE m.statut = 'VALIDE' AND l."volontaireId" IS NOT NULL AND m.id <> $1 GROUP BY 1`,
      [mer?.id ?? 0],
    ))
      deja.set(r.v, r.libelle);

    const anomalies: AnomalieMer[] = [];
    const signaler = (v: Volontaire, code: string, message: string) => {
      if (v.verifications?.[VERIF(code)]) return;
      anomalies.push({
        code,
        gravite: CONTROLES_MER[code].gravite,
        volontaireId: v.id,
        nomComplet: v.nomComplet,
        message,
      });
    };
    const index = new IndexNoms<Volontaire>();
    const lignes: Partial<LigneMiseEnRoute>[] = [];
    for (const v of vs) {
      // Déjà payé(e) dans un état validé : pas repris(e), sauf vérification (nouvelle affectation)
      if (deja.has(v.id) && !v.verifications?.MISE_EN_ROUTE) {
        anomalies.push({
          code: 'DEJA_MIS_EN_ROUTE',
          gravite: 'SIGNALE',
          volontaireId: v.id,
          nomComplet: v.nomComplet,
          message: `Déjà payé(e) dans : ${deja.get(v.id)}. Non repris(e) ici.`,
        });
        continue;
      }
      const cat = c.categories.find((x) => x.code === v.categorie && x.actif);
      const dep = v.departementId ? deps.get(v.departementId) : undefined;
      const t = dep ? c.transport[dep.code] : undefined;
      if (!cat)
        signaler(
          v,
          'CATEGORIE',
          `Catégorie « ${v.categorie ?? v.cycleBrut ?? 'vide'} » : choisissez-la dans la fiche.`,
        );
      if (!dep)
        signaler(
          v,
          'DEPARTEMENT',
          `Département « ${v.departementBrut ?? 'vide'} » non reconnu.`,
        );
      else if (
        t?.billet === null ||
        t?.billet === undefined ||
        t?.bagages === null ||
        t?.bagages === undefined
      )
        signaler(
          v,
          'TRANSPORT',
          `Billet ou bagages vers ${dep.nom} non fixés : réglez-les dans la configuration.`,
        );
      if (!v.etablissement)
        signaler(
          v,
          'ETABLISSEMENT',
          'À la disposition de la DDEPPSA (établissement non indiqué).',
        );
      for (const autre of index.probables(v.nomComplet, v.dateNaissance)) {
        signaler(
          v,
          'DOUBLON',
          `Même personne probable que ${autre.nomComplet}.`,
        );
        signaler(
          autre,
          'DOUBLON',
          `Même personne probable que ${v.nomComplet}.`,
        );
      }
      index.ajouter(v.nomComplet, v.dateNaissance, v);
      const equipement = cat?.equipement ?? 0;
      const billet = t?.billet ?? 0;
      const bagages = t?.bagages ?? 0;
      lignes.push({
        volontaireId: v.id,
        nomComplet: v.nomComplet,
        dateNaissance: v.dateNaissance,
        lieuNaissance: v.lieuNaissance,
        categorie: v.categorie,
        specialite: v.specialite,
        departementId: v.departementId,
        etablissement: v.etablissement,
        telephone: v.telephone,
        equipement,
        billet,
        bagages,
        total: equipement + billet + bagages,
      });
    }
    const total = lignes.reduce((t, l) => t + (l.total ?? 0), 0);
    // Une note déjà mise en route (fiche reprise) : celle-ci est un complément
    const autre = await this.mers.exists({
      where: { noteReference: note, statut: 'VALIDE' },
    });
    const libelle =
      dto.libelle?.trim() ||
      mer?.libelle ||
      `${autre ? 'Complément de mise en route' : 'Mise en route'} — note n° ${note}`;
    await this.ds.transaction(async (m) => {
      if (!mer)
        mer = await m.save(MiseEnRoute, {
          libelle,
          noteReference: note,
          statut: 'BROUILLON',
          source: 'CALCUL',
        });
      await m.delete(LigneMiseEnRoute, { miseEnRouteId: mer.id });
      await m.insert(
        LigneMiseEnRoute,
        lignes.map((l) => ({ ...l, miseEnRouteId: mer!.id })),
      );
      await m.update(MiseEnRoute, mer.id, {
        libelle,
        effectif: lignes.length,
        total: String(total),
        anomalies,
        preparePar: u.nom,
      });
    });
    await this.journal.log(
      u,
      'MISE_EN_ROUTE_CALCULEE',
      'mise_en_route',
      mer!.id,
      { note, effectif: lignes.length, total },
    );
    return this.mers.findOneOrFail({ where: { id: mer!.id } });
  }

  async valider(u: UtilisateurConnecte, id: number) {
    if (u.role !== 'DG' && u.role !== 'ADMIN')
      throw new ForbiddenException('Seul le DG valide une mise en route.');
    const avant = await this.mers.findOne({ where: { id } });
    if (!avant)
      throw new NotFoundException('État de mise en route introuvable');
    if (avant.statut === 'VALIDE')
      throw new BadRequestException('Cet état est déjà validé.');
    const mer = await this.preparer(u, {
      noteReference: avant.noteReference ?? '',
      id,
    });
    if (!mer.effectif)
      throw new BadRequestException(
        'Personne à mettre en route : tous ont déjà été payés.',
      );
    const bloquants = (mer.anomalies as AnomalieMer[]).filter(
      (a) => a.gravite === 'BLOQUANT',
    );
    if (bloquants.length)
      throw new BadRequestException(
        `${bloquants.length} contrôle(s) bloquant(s) : mise en route déjà payée, transport non fixé, catégorie ou département manquant, doublon.`,
      );
    await this.mers.update(id, {
      statut: 'VALIDE',
      validePar: u.nom,
      valideLe: new Date(),
    });
    await this.journal.log(u, 'MISE_EN_ROUTE_VALIDEE', 'mise_en_route', id, {
      total: mer.total,
    });
    return this.mers.findOneOrFail({ where: { id } });
  }

  async rouvrir(u: UtilisateurConnecte, id: number, motif: string) {
    if (u.role !== 'DG' && u.role !== 'ADMIN')
      throw new ForbiddenException('Seul le DG rouvre une mise en route.');
    const mer = await this.mers.findOne({ where: { id } });
    if (!mer) throw new NotFoundException('État de mise en route introuvable');
    if (mer.statut !== 'VALIDE')
      throw new BadRequestException('Cet état n’est pas validé.');
    if (!motif?.trim() || motif.trim().length < 5)
      throw new BadRequestException('Indiquez pourquoi l’état est rouvert.');
    await this.mers.update(id, {
      statut: 'BROUILLON',
      validePar: null,
      valideLe: null,
    });
    await this.journal.log(u, 'MISE_EN_ROUTE_ROUVERTE', 'mise_en_route', id, {
      motif: motif.trim(),
    });
    return this.mers.findOneOrFail({ where: { id } });
  }

  async supprimer(u: UtilisateurConnecte, id: number) {
    const mer = await this.mers.findOne({ where: { id } });
    if (!mer) throw new NotFoundException('État de mise en route introuvable');
    if (mer.statut === 'VALIDE')
      throw new BadRequestException(
        'Un état validé ne se supprime pas (le DG peut le rouvrir).',
      );
    await this.ds.transaction(async (m) => {
      await m.delete(LigneMiseEnRoute, { miseEnRouteId: id });
      await m.delete(MiseEnRoute, id);
    });
    await this.journal.log(u, 'MISE_EN_ROUTE_SUPPRIMEE', 'mise_en_route', id, {
      libelle: mer.libelle,
    });
    return { ok: true };
  }

  /* --------------------------- Reprise d'une fiche payée --------------------------- */

  async analyser(contenu: Buffer) {
    const feuilles = await lireClasseur(
      contenu,
      ['NOMSPRENOMS|NOMSETPRENOMS|NOMETPRENOMS', 'MISE'],
      { inclureMasquees: true },
    );
    return feuilles.map((f) => {
      const l = this.personnes(f.lignes);
      return {
        nom: f.nom,
        personnes: l.length,
        total: l.reduce((t, x) => t + this.montants(x).total, 0),
      };
    });
  }

  private personnes(lignes: Ligne[]) {
    return lignes.filter((l) => {
      const nom = nettoyer(
        this.valeur(l, ['NOMSPRENOMS', 'NOMSETPRENOMS', 'NOMETPRENOMS']),
      );
      const n = this.valeur(l, ['N']);
      return (
        !!nom &&
        motsDuNom(nom).length >= 2 &&
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

  private montants(l: Ligne) {
    const n = (p: string[]) => Math.round(Number(this.valeur(l, p))) || 0;
    const equipement = n(['MISEDEQUI', 'MISE']);
    const billet = n(['TRANSPORTBILLET', 'BILLET']);
    const bagages = n(['TRANSPORTBAGAGES', 'BAGAGES']);
    const total = n(['TOTAL']) || equipement + billet + bagages;
    return { equipement, billet, bagages, total };
  }

  /**
   * Enregistre une fiche de mise en route déjà payée (avant l'application) : elle sert au
   * contrôle des doubles paiements. Chaque personne est reliée à sa fiche du registre.
   */
  async importer(
    u: UtilisateurConnecte,
    contenu: Buffer,
    nomFichier: string,
    o: {
      feuille: string;
      libelle: string;
      noteReference?: string;
      essai: boolean;
    },
  ) {
    const libelle = o.libelle?.replace(/\s+/g, ' ').trim();
    if (!libelle || libelle.length < 4)
      throw new BadRequestException(
        'Donnez un nom à cette fiche (ex. « Mise en route — note n° 1006 »).',
      );
    const feuilles = await lireClasseur(
      contenu,
      ['NOMSPRENOMS|NOMSETPRENOMS|NOMETPRENOMS', 'MISE'],
      { inclureMasquees: true },
    );
    const f = feuilles.find((x) => x.nom === o.feuille);
    if (!f)
      throw new BadRequestException(
        `Feuille « ${o.feuille} » introuvable, ou sans colonnes « Noms prénoms » et « Mise d’équipement ».`,
      );
    const personnes = this.personnes(f.lignes);
    if (!personnes.length)
      throw new BadRequestException('Aucune personne lue dans cette feuille.');

    const deps = await this.deps.find();
    const depId = (brut: unknown) => {
      const c = codeDepartement(nettoyer(brut)?.split(/[/(]/)[0]);
      return c ? (deps.find((d) => d.code === c)?.id ?? null) : null;
    };
    const index = new IndexNoms<Volontaire>();
    for (const v of await this.volontaires.find())
      index.ajouter(v.nomComplet, v.dateNaissance, v);
    const deja = new Map<string, string>();
    for (const r of await this.lignes.query<{ v: string; libelle: string }[]>(
      `SELECT l."volontaireId" AS v, string_agg(m.libelle, ', ') AS libelle
         FROM ligne_mise_en_route l JOIN mise_en_route m ON m.id = l."miseEnRouteId"
        WHERE m.statut = 'VALIDE' AND l."volontaireId" IS NOT NULL GROUP BY 1`,
    ))
      deja.set(r.v, r.libelle);

    const rapport = {
      lues: personnes.length,
      relies: 0,
      nonTrouves: [] as string[],
      dejaPayes: [] as string[],
      ecartsTotal: [] as string[],
      total: 0,
    };
    const lignes: Partial<LigneMiseEnRoute>[] = [];
    for (const l of personnes) {
      const nom = nettoyer(
        this.valeur(l, ['NOMSPRENOMS', 'NOMSETPRENOMS', 'NOMETPRENOMS']),
      )!.replace(/\s+/g, ' ');
      const naissance = lireDate(this.valeur(l, ['DATEDENAIS']));
      const m = this.montants(l);
      const ici = `${nom} (ligne ${l._ligne})`;
      if (m.total !== m.equipement + m.billet + m.bagages)
        rapport.ecartsTotal.push(
          `${ici} : total ${m.total}, somme des colonnes ${m.equipement + m.billet + m.bagages}`,
        );
      const trouves = index.probables(nom, naissance);
      const exactes = trouves.filter((x) => x.nomNormalise === normaliser(nom));
      const v =
        trouves.length === 1
          ? trouves[0]
          : exactes.length === 1
            ? exactes[0]
            : null;
      if (v) {
        rapport.relies++;
        if (deja.has(v.id))
          rapport.dejaPayes.push(`${ici} : déjà dans ${deja.get(v.id)}`);
      } else
        rapport.nonTrouves.push(
          trouves.length > 1 ? `${ici} (plusieurs fiches possibles)` : ici,
        );
      rapport.total += m.total;
      lignes.push({
        volontaireId: v?.id ?? null,
        nomComplet: nom,
        dateNaissance: naissance,
        lieuNaissance: nettoyer(this.valeur(l, ['LIEUDENAIS'])),
        categorie:
          v?.categorie ??
          this.config.categorieDepuisTexte(this.valeur(l, ['CYCLE']))?.code ??
          null,
        specialite: nettoyer(this.valeur(l, ['SPECIALITE'])),
        departementId: depId(this.valeur(l, ['DEPAR'])),
        etablissement: nettoyer(this.valeur(l, ['ETABLISSEMENT'])),
        telephone: nettoyer(this.valeur(l, ['TELEPHONE', 'TEL'])),
        ...m,
        observation: v ? null : 'Pas retrouvé(e) dans le registre',
      });
    }
    let id: number | null = null;
    if (!o.essai) {
      await this.ds.transaction(async (m) => {
        const mer = await m.save(MiseEnRoute, {
          libelle,
          noteReference: o.noteReference?.trim() || null,
          statut: 'VALIDE',
          source: 'REPRISE',
          effectif: lignes.length,
          total: String(rapport.total),
          anomalies: [],
          preparePar: u.nom,
          validePar: `${u.nom} (reprise de ${nomFichier})`,
          valideLe: new Date(),
        });
        id = mer.id;
        await m.insert(
          LigneMiseEnRoute,
          lignes.map((l) => ({ ...l, miseEnRouteId: mer.id })),
        );
      });
      await this.journal.log(u, 'MISE_EN_ROUTE_REPRISE', 'mise_en_route', id, {
        fichier: nomFichier,
        feuille: f.nom,
        effectif: lignes.length,
        total: rapport.total,
      });
    }
    const court = (t: string[]) => ({ n: t.length, exemples: t.slice(0, 30) });
    return {
      id,
      essai: o.essai,
      feuille: f.nom,
      lues: rapport.lues,
      relies: rapport.relies,
      total: rapport.total,
      nonTrouves: court(rapport.nonTrouves),
      dejaPayes: court(rapport.dejaPayes),
      ecartsTotal: court(rapport.ecartsTotal),
    };
  }

  /* ------------------------------ Excel ------------------------------ */

  /** Fiche de paiement des mises en route, comme celles de la DGRHAS. */
  async excel(id: number): Promise<{ nom: string; contenu: Buffer }> {
    const { mer, lignes } = await this.detail(id);
    const c = this.config.get();
    const deps = new Map((await this.deps.find()).map((d) => [d.id, d.nom]));
    const brouillon = mer.statut !== 'VALIDE';
    const wb = new ExcelJS.Workbook();
    wb.creator = 'SIRHAS';
    const ws = wb.addWorksheet('Fiche de mise en route', {
      pageSetup: {
        orientation: 'landscape',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        paperSize: 9,
      },
    });
    const bord: Partial<ExcelJS.Borders> = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' },
    };
    ws.addRow([
      'MINISTÈRE DE L’ENSEIGNEMENT PRÉSCOLAIRE, PRIMAIRE,',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      'RÉPUBLIQUE DU CONGO',
    ]);
    ws.addRow([
      'SECONDAIRE ET DE L’ALPHABÉTISATION',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      'Unité-Travail-Progrès',
    ]);
    ws.addRow(['CABINET']);
    ws.addRow([
      'DIRECTION GÉNÉRALE DES RESSOURCES HUMAINES ET DE L’ADMINISTRATION SCOLAIRE',
    ]);
    ws.addRow([]);
    const t = ws.addRow([
      `FICHE DE PAIEMENT DES MISES EN ROUTE DES VOLONTAIRES AFFECTÉS — ${mer.libelle.toUpperCase()}${brouillon ? ' (PROJET NON VALIDÉ)' : ''}`,
    ]);
    t.font = { bold: true, size: 12 };
    ws.mergeCells(t.number, 1, t.number, 15);
    t.alignment = { horizontal: 'center' };
    const a = ws.addRow([
      `ANNÉE SCOLAIRE : ${this.params.get('ANNEE_SCOLAIRE')}`,
    ]);
    ws.mergeCells(a.number, 1, a.number, 15);
    a.alignment = { horizontal: 'center' };
    ws.addRow([]);
    const e = ws.addRow([
      'N°',
      'Noms prénoms',
      'Date de nais.',
      'Lieu de nais.',
      'Cycle',
      'Spécialité',
      'Département',
      'Établissement',
      'Mise d’équipement',
      'Transport billet',
      'Transport bagages',
      'Total',
      'CNI',
      'Émargement',
      'Téléphone',
    ]);
    e.font = { bold: true };
    e.eachCell((cell) => {
      cell.border = bord;
      cell.alignment = {
        wrapText: true,
        horizontal: 'center',
        vertical: 'middle',
      };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE5E7EB' },
      };
    });
    const libCat = (k: string | null) =>
      c.categories.find((x) => x.code === k)?.libelle ?? k ?? '';
    lignes.forEach((l, i) => {
      const r = ws.addRow([
        i + 1,
        l.nomComplet,
        l.dateNaissance?.split('-').reverse().join('/') ?? '',
        l.lieuNaissance,
        libCat(l.categorie),
        l.specialite,
        l.departementId ? deps.get(l.departementId) : '',
        l.etablissement ?? 'À la disposition de la DDEPPSA',
        l.equipement,
        l.billet,
        l.bagages,
        l.total,
        '',
        '',
        l.telephone,
      ]);
      r.eachCell({ includeEmpty: true }, (cell) => (cell.border = bord));
      [9, 10, 11, 12].forEach((k) => (r.getCell(k).numFmt = '#,##0'));
    });
    const s = (k: keyof LigneMiseEnRoute) =>
      lignes.reduce((t2, l) => t2 + Number(l[k] ?? 0), 0);
    const tot = ws.addRow([
      '',
      'TOTAL',
      '',
      '',
      '',
      '',
      '',
      '',
      s('equipement'),
      s('billet'),
      s('bagages'),
      s('total'),
    ]);
    tot.font = { bold: true };
    tot.eachCell({ includeEmpty: true }, (cell) => (cell.border = bord));
    [9, 10, 11, 12].forEach((k) => (tot.getCell(k).numFmt = '#,##0'));
    ws.addRow([]);
    ws.addRow([
      `Arrêté la présente fiche à la somme de : ${montantArrete(s('total'))}`,
    ]).font = { italic: true };
    ws.addRow([]);
    ws.addRow(['', '', '', '', '', '', '', '', '', 'Fait à Brazzaville, le']);
    ws.addRow(['', '', '', '', '', '', '', '', '', c.signatairePaiementTitre]);
    ws.addRow([]);
    ws.addRow([]);
    ws.addRow([
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      c.signatairePaiementNom,
    ]).font = { bold: true };
    [5, 32, 11, 14, 12, 18, 14, 26, 12, 11, 11, 12, 10, 14, 14].forEach(
      (w, i) => (ws.getColumn(i + 1).width = w),
    );
    ws.views = [{ state: 'frozen', ySplit: e.number }];
    const nom = `${mer.libelle.replace(/[\\/:*?"<>|]/g, '-')}${brouillon ? ' (projet)' : ''}.xlsx`;
    return { nom, contenu: Buffer.from(await wb.xlsx.writeBuffer()) };
  }

  /** Nombre de volontaires déjà mis en route (pour le tableau de bord). */
  async compteurs() {
    const [r] = await this.mers.query<
      { projets: number; valides: number; total: string }[]
    >(
      `SELECT count(*) FILTER (WHERE statut = 'BROUILLON')::int AS projets,
              count(*) FILTER (WHERE statut = 'VALIDE')::int AS valides,
              coalesce(sum(total) FILTER (WHERE statut = 'VALIDE'), 0)::bigint AS total FROM mise_en_route`,
    );
    return r;
  }
}
