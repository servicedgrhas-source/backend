import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import ExcelJS from 'exceljs';
import { In, Repository } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { montantArrete } from '../common/lettres';
import { ajouterMois, ecartMois, moisEnClair } from '../common/mois';
import { normaliser } from '../common/texte';
import { JournalService } from '../core/core.service';
import { Departement, Regularisation, Volontaire } from '../entities';
import { BourseService } from './bourse.service';
import { ConfigEnrolementService } from './configuration';

export const ORIGINES: Record<string, string> = {
  MANUEL: 'Saisie à la main',
  TROP_PERCU_BOURSE: 'Bourse payée après la fin de bourse',
  DOUBLE_MISE_EN_ROUTE: 'Mise en route payée deux fois',
};

export interface TropPercu {
  volontaireId: string;
  nomComplet: string;
  statut: string;
  origine: string;
  detail: string;
  montant: number;
  dejaTraite: number;
  aTraiter: number;
}

const versVolontaire = (raw: Record<string, unknown>) => ({
  nomComplet: raw.v_nomComplet as string,
  statutVolontaire: raw.v_statut as string,
  departementId: raw.v_departementId as number | null,
});

@Injectable()
export class RegularisationsService {
  constructor(
    @InjectRepository(Regularisation)
    private readonly regs: Repository<Regularisation>,
    @InjectRepository(Volontaire)
    private readonly volontaires: Repository<Volontaire>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    private readonly config: ConfigEnrolementService,
    private readonly journal: JournalService,
  ) {}

  /* ------------------------------ Lecture ------------------------------ */

  async liste(f: { statut?: string; origine?: string; recherche?: string }) {
    const q = this.regs
      .createQueryBuilder('r')
      .innerJoin(Volontaire, 'v', 'v.id = r.volontaireId')
      .select('r')
      .addSelect(['v.nomComplet', 'v.statut', 'v.departementId']);
    if (f.statut === 'A_RECOUVRER')
      q.andWhere(
        "r.statut = 'EN_ATTENTE' AND r.type = 'RETENUE' AND v.statut = 'SORTI'",
      );
    else if (f.statut) q.andWhere('r.statut = :s', { s: f.statut });
    if (f.origine) q.andWhere('r.origine = :o', { o: f.origine });
    if (f.recherche?.trim())
      q.andWhere('v.nomNormalise LIKE :n', {
        n: `%${normaliser(f.recherche).replace(/[\\%_]/g, '\\$&')}%`,
      });
    const lignes = await q
      .orderBy('r.id', 'DESC')
      .limit(1000)
      .getRawAndEntities();
    const resume = await this.regs.query<
      { type: string; statut: string; n: number; reste: string }[]
    >(
      `SELECT r.type, CASE WHEN r.statut = 'EN_ATTENTE' AND r.type = 'RETENUE' AND v.statut = 'SORTI'
                           THEN 'A_RECOUVRER' ELSE r.statut END AS statut,
              count(*)::int AS n, sum(r.reste)::bigint AS reste
         FROM regularisation r JOIN volontaire v ON v.id = r."volontaireId" GROUP BY 1, 2`,
    );
    return {
      lignes: lignes.entities.map((r, i) => ({
        ...r,
        ...versVolontaire(lignes.raw[i] as Record<string, unknown>),
      })),
      resume,
      origines: ORIGINES,
    };
  }

  /* ------------------------------ Saisie ------------------------------ */

  async creer(
    u: UtilisateurConnecte,
    dto: {
      volontaireId: string;
      type: string;
      montant: number;
      motif: string;
      origine?: string;
    },
  ) {
    const v = await this.volontaires.findOne({
      where: { id: dto.volontaireId },
    });
    if (!v) throw new NotFoundException('Volontaire introuvable');
    if (dto.type !== 'COMPLEMENT' && dto.type !== 'RETENUE')
      throw new BadRequestException('Type : complément ou retenue.');
    const montant = Number(dto.montant);
    if (!Number.isInteger(montant) || montant <= 0 || montant > 10_000_000)
      throw new BadRequestException('Montant : nombre entier positif (FCFA).');
    const motif = dto.motif?.replace(/\s+/g, ' ').trim();
    if (!motif || motif.length < 5)
      throw new BadRequestException(
        'Indiquez le motif (ex. « Écart du récapitulatif de septembre : lycée compté au collège »).',
      );
    const origine = ORIGINES[dto.origine ?? 'MANUEL']
      ? (dto.origine ?? 'MANUEL')
      : 'MANUEL';
    const r = await this.regs.save({
      volontaireId: v.id,
      type: dto.type,
      montant,
      reste: montant,
      motif,
      origine,
      statut: 'EN_ATTENTE',
      applications: [],
      creePar: u.nom,
    });
    await this.journal.log(u, 'REGULARISATION_CREEE', 'regularisation', r.id, {
      volontaire: v.nomComplet,
      type: r.type,
      montant,
      origine,
    });
    return r;
  }

  /** Annule ce qui reste à faire (ce qui a déjà été imputé sur une bourse validée reste acquis). */
  async annuler(u: UtilisateurConnecte, id: number, motif: string) {
    const r = await this.regs.findOne({ where: { id } });
    if (!r) throw new NotFoundException('Régularisation introuvable');
    if (r.statut !== 'EN_ATTENTE')
      throw new BadRequestException(
        'Seule une régularisation en attente peut être annulée.',
      );
    if (!motif?.trim() || motif.trim().length < 5)
      throw new BadRequestException('Indiquez pourquoi elle est annulée.');
    await this.regs.update(id, { statut: 'ANNULEE', annulePar: u.nom });
    await this.journal.log(u, 'REGULARISATION_ANNULEE', 'regularisation', id, {
      motif: motif.trim(),
      reste: r.reste,
    });
    return this.regs.findOneOrFail({ where: { id } });
  }

  /* --------------------------- Trop-perçus détectés --------------------------- */

  /**
   * Sommes versées à tort, d'après les états validés et le registre tel qu'il est aujourd'hui :
   * - bourse de mois situés après la fin de bourse (sortie, durée) ou avant son début ;
   * - mise en route payée plusieurs fois à la même personne.
   */
  async tropPercus(): Promise<TropPercu[]> {
    const c = this.config.get();
    const resultats: TropPercu[] = [];
    const lignes = await this.regs.query<
      {
        volontaireId: string;
        mois: string;
        nb: number;
        montant: number;
        du: string | null;
        au: string | null;
      }[]
    >(
      `SELECT l."volontaireId", e.mois, l.mois AS nb, l.montant, l.du, l.au
         FROM ligne_bourse l JOIN etat_bourse e ON e.id = l."etatId"
        WHERE e.statut = 'VALIDE' AND l.mois > 0 AND l.montant > 0`,
    );
    const ids = [...new Set(lignes.map((l) => l.volontaireId))];
    const vs = new Map<string, Volontaire>();
    for (let i = 0; i < ids.length; i += 5000)
      for (const v of await this.volontaires.find({
        where: { id: In(ids.slice(i, i + 5000)) },
      }))
        vs.set(v.id, v);
    // Périodes déjà couvertes avant une réintégration (mois légitimement payés)
    const anciennes = new Map<string, { du: string; au: string }[]>();
    for (const m of await this.regs.query<
      { v: string; p: { du: string; au: string } }[]
    >(
      `SELECT "volontaireId" AS v, details->'periode' AS p FROM mouvement_volontaire
        WHERE type = 'REINTEGRATION' AND details->'periode' IS NOT NULL AND jsonb_typeof(details->'periode') = 'object'`,
    ))
      anciennes.set(m.v, [...(anciennes.get(m.v) ?? []), m.p]);
    const parV = new Map<string, { montant: number; mois: string[] }>();
    for (const l of lignes) {
      const v = vs.get(l.volontaireId);
      if (!v) continue;
      const debut = BourseService.premierMois(v, c);
      const fin = BourseService.dernierMois(v, c, debut);
      const au = l.au ?? l.mois;
      const du = l.du ?? ajouterMois(au, -(l.nb - 1));
      for (let k = 0; k <= ecartMois(du, au); k++) {
        const m = ajouterMois(du, k);
        const avant = (anciennes.get(v.id) ?? []).some(
          (p) => m >= p.du && m <= p.au,
        );
        if (!avant && ((fin && m > fin) || (debut && m < debut))) {
          const x = parV.get(v.id) ?? { montant: 0, mois: [] };
          x.montant += l.montant;
          x.mois.push(m);
          parV.set(v.id, x);
        }
      }
    }
    for (const [id, x] of parV) {
      const v = vs.get(id)!;
      const mois = [...new Set(x.mois)].sort();
      resultats.push({
        volontaireId: id,
        nomComplet: v.nomComplet,
        statut: v.statut,
        origine: 'TROP_PERCU_BOURSE',
        detail: `${mois.length} mois payé(s) hors de sa période de bourse (${mois.map(moisEnClair).join(', ')})${v.statut === 'SORTI' ? ` — sorti le ${v.dateSortie?.split('-').reverse().join('/') ?? '?'}` : ''}`,
        montant: x.montant,
        dejaTraite: 0,
        aTraiter: 0,
      });
    }

    // Mise en route payée plusieurs fois (fiches validées, y compris reprises)
    const mer = await this.regs.manager.query<
      {
        volontaireId: string;
        nomComplet: string;
        libelle: string;
        total: number;
        id: number;
      }[]
    >(
      `SELECT l."volontaireId", l."nomComplet", m.libelle, l.total, m.id
         FROM ligne_mise_en_route l JOIN mise_en_route m ON m.id = l."miseEnRouteId"
        WHERE m.statut = 'VALIDE' AND l."volontaireId" IS NOT NULL
          AND l."volontaireId" IN (
            SELECT l2."volontaireId" FROM ligne_mise_en_route l2
              JOIN mise_en_route m2 ON m2.id = l2."miseEnRouteId"
             WHERE m2.statut = 'VALIDE' AND l2."volontaireId" IS NOT NULL
             GROUP BY 1 HAVING count(*) > 1)
        ORDER BY l."volontaireId", m.id`,
    );
    const parMer = new Map<string, typeof mer>();
    for (const l of mer)
      parMer.set(l.volontaireId, [...(parMer.get(l.volontaireId) ?? []), l]);
    const vMer = await this.volontaires.find({
      where: {
        id: In([...parMer.keys(), '00000000-0000-0000-0000-000000000000']),
      },
    });
    for (const [id, liste] of parMer) {
      const [premiere, ...autres] = liste;
      resultats.push({
        volontaireId: id,
        nomComplet: premiere.nomComplet,
        statut: vMer.find((v) => v.id === id)?.statut ?? '',
        origine: 'DOUBLE_MISE_EN_ROUTE',
        detail: autres.every((a) => a.id === premiere.id)
          ? `Payé(e) ${liste.length} fois dans « ${premiere.libelle} »`
          : `Payé(e) dans « ${premiere.libelle} » puis dans ${autres.map((a) => `« ${a.libelle} »`).join(', ')}`,
        montant: autres.reduce((t, a) => t + a.total, 0),
        dejaTraite: 0,
        aTraiter: 0,
      });
    }

    // Ce qui est déjà pris en charge par une retenue (non annulée) de même origine
    const deja = await this.regs.query<
      { volontaireId: string; origine: string; s: string }[]
    >(
      `SELECT "volontaireId", origine, sum(montant)::bigint AS s FROM regularisation
        WHERE type = 'RETENUE' AND statut <> 'ANNULEE' AND origine <> 'MANUEL' GROUP BY 1, 2`,
    );
    const cle = (v: string, o: string) => `${v}|${o}`;
    const traite = new Map(
      deja.map((d) => [cle(d.volontaireId, d.origine), Number(d.s)]),
    );
    for (const r of resultats) {
      r.dejaTraite = Math.min(
        r.montant,
        traite.get(cle(r.volontaireId, r.origine)) ?? 0,
      );
      r.aTraiter = r.montant - r.dejaTraite;
    }
    return resultats.sort(
      (a, b) =>
        b.aTraiter - a.aTraiter ||
        a.nomComplet.localeCompare(b.nomComplet, 'fr'),
    );
  }

  /** Crée les retenues des trop-perçus (tous, ou ceux choisis). */
  async creerRetenues(
    u: UtilisateurConnecte,
    choix?: { volontaireId: string; origine: string }[],
  ) {
    const liste = (await this.tropPercus()).filter(
      (t) =>
        t.aTraiter > 0 &&
        (!choix?.length ||
          choix.some(
            (c) => c.volontaireId === t.volontaireId && c.origine === t.origine,
          )),
    );
    for (const t of liste)
      await this.regs.save({
        volontaireId: t.volontaireId,
        type: 'RETENUE',
        montant: t.aTraiter,
        reste: t.aTraiter,
        motif: t.detail,
        origine: t.origine,
        statut: 'EN_ATTENTE',
        applications: [],
        creePar: u.nom,
      });
    if (liste.length)
      await this.journal.log(u, 'RETENUES_CREEES', 'regularisation', null, {
        nombre: liste.length,
        total: liste.reduce((s, t) => s + t.aTraiter, 0),
      });
    return {
      creees: liste.length,
      total: liste.reduce((s, t) => s + t.aTraiter, 0),
    };
  }

  /* ------------------------------ Excel ------------------------------ */

  /** Sommes à recouvrer : retenues en attente sur des volontaires sortis (plus de bourse sur laquelle retenir). */
  async excelARecouvrer(): Promise<Buffer> {
    const { lignes } = await this.liste({ statut: 'A_RECOUVRER' });
    const deps = new Map((await this.deps.find()).map((d) => [d.id, d.nom]));
    const c = this.config.get();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('À recouvrer', {
      pageSetup: {
        orientation: 'landscape',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        paperSize: 9,
      },
    });
    ws.addRow([
      'DIRECTION GÉNÉRALE DES RESSOURCES HUMAINES ET DE L’ADMINISTRATION SCOLAIRE',
    ]);
    ws.addRow([]);
    ws.addRow(['SOMMES À RECOUVRER — ENSEIGNANTS VOLONTAIRES SORTIS']).font = {
      bold: true,
      size: 12,
    };
    ws.addRow([`Arrêtée le ${new Date().toLocaleDateString('fr-FR')}`]);
    ws.addRow([]);
    const e = ws.addRow([
      'N°',
      'Noms et prénoms',
      'Département',
      'Origine',
      'Motif',
      'Montant',
      'Déjà retenu',
      'Reste à recouvrer',
    ]);
    e.font = { bold: true };
    lignes.forEach((r, i) =>
      ws.addRow([
        i + 1,
        r.nomComplet,
        r.departementId ? (deps.get(r.departementId) ?? '') : '',
        ORIGINES[r.origine] ?? r.origine,
        r.motif,
        r.montant,
        r.montant - r.reste,
        r.reste,
      ]),
    );
    const total = lignes.reduce((t, r) => t + r.reste, 0);
    ws.addRow(['', 'TOTAL', '', '', '', '', '', total]).font = { bold: true };
    ws.addRow([]);
    ws.addRow([
      `Arrêté la présente liste à la somme de : ${montantArrete(total)}`,
    ]).font = { italic: true };
    ws.addRow([]);
    ws.addRow(['', '', '', '', c.signatairePaiementTitre]).font = {
      bold: true,
    };
    ws.addRow([]);
    ws.addRow(['', '', '', '', c.signatairePaiementNom]).font = {
      bold: true,
      underline: true,
    };
    [5, 34, 16, 28, 50, 13, 13, 16].forEach(
      (w, i) => (ws.getColumn(i + 1).width = w),
    );
    [6, 7, 8].forEach((k) => (ws.getColumn(k).numFmt = '#,##0'));
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
}
