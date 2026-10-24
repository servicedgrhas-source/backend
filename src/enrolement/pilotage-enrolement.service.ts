import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import ExcelJS from 'exceljs';
import { Repository } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { jourLocal } from '../common/jours';
import { normaliser } from '../common/texte';
import { JournalService } from '../core/core.service';
import { BesoinEtablissement, Departement } from '../entities';
import { ConfigEnrolementService } from './configuration';
import { RegularisationsService } from './regularisations.service';

export interface BesoinDto {
  departementId: number;
  etablissement: string;
  categorie: string;
  specialite?: string | null;
  nombre: number;
  anneeScolaire?: string | null;
  observation?: string | null;
}

/** « Lycée de l'Amitié » et « LYCEE DE L AMITIE » : même établissement. */
const cleEtablissement = (s: string | null | undefined) =>
  normaliser(s)
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();

@Injectable()
export class PilotageEnrolementService {
  constructor(
    @InjectRepository(BesoinEtablissement)
    private readonly besoins: Repository<BesoinEtablissement>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    private readonly config: ConfigEnrolementService,
    private readonly journal: JournalService,
    private readonly regs: RegularisationsService,
  ) {}

  /* ------------------------------ Besoins ------------------------------ */

  /** Une DDEPPSA ne voit et ne gère que son département. */
  private perimetre(u: UtilisateurConnecte, departementId?: number | null) {
    if (u.role === 'DDEPPSA') {
      if (!u.departementId)
        throw new ForbiddenException('Compte DDEPPSA sans département.');
      if (departementId && departementId !== u.departementId)
        throw new ForbiddenException(
          'Vous ne gérez que les besoins de votre département.',
        );
      return u.departementId;
    }
    return departementId ?? null;
  }

  /** Besoins, et pour chacun les volontaires en poste qui y répondent (même établissement, catégorie, spécialité). */
  async besoinsAvecCouverture(u: UtilisateurConnecte, departementId?: number) {
    const dep = this.perimetre(u, departementId);
    const besoins = await this.besoins.find({
      where: dep ? { departementId: dep } : {},
      order: {
        departementId: 'ASC',
        etablissementNormalise: 'ASC',
        categorie: 'ASC',
      },
    });
    const enPoste = await this.besoins.query<
      {
        departementId: number;
        etab: string | null;
        categorie: string | null;
        specialite: string | null;
        n: number;
      }[]
    >(
      `SELECT "departementId", etablissement AS etab, categorie, specialite, count(*)::int AS n
         FROM volontaire WHERE population = 'VOLONTAIRE' AND statut = 'EN_POSTE' AND "departementId" IS NOT NULL ${dep ? 'AND "departementId" = $1' : ''}
        GROUP BY 1, 2, 3, 4`,
      dep ? [dep] : [],
    );
    const lignes = besoins.map((b) => {
      const couverts = enPoste
        .filter(
          (x) =>
            x.departementId === b.departementId &&
            cleEtablissement(x.etab) === b.etablissementNormalise &&
            x.categorie === b.categorie &&
            (!b.specialite ||
              normaliser(x.specialite) === normaliser(b.specialite)),
        )
        .reduce((t, x) => t + x.n, 0);
      return {
        ...b,
        enPoste: couverts,
        manque: Math.max(0, b.nombre - couverts),
        surplus: Math.max(0, couverts - b.nombre),
      };
    });
    return {
      lignes,
      total: {
        besoin: lignes.reduce((t, l) => t + l.nombre, 0),
        enPoste: lignes.reduce((t, l) => t + Math.min(l.enPoste, l.nombre), 0),
        manque: lignes.reduce((t, l) => t + l.manque, 0),
      },
    };
  }

  private async valider(u: UtilisateurConnecte, dto: BesoinDto) {
    const departementId = this.perimetre(u, Number(dto.departementId));
    if (
      !departementId ||
      !(await this.deps.exists({ where: { id: departementId } }))
    )
      throw new BadRequestException('Choisissez le département.');
    const etablissement = dto.etablissement?.replace(/\s+/g, ' ').trim();
    if (!etablissement || etablissement.length < 3)
      throw new BadRequestException('Indiquez l’établissement.');
    if (!this.config.categorie(dto.categorie))
      throw new BadRequestException(
        'Catégorie inconnue (voir la configuration).',
      );
    const nombre = Number(dto.nombre);
    if (!Number.isInteger(nombre) || nombre < 1 || nombre > 500)
      throw new BadRequestException('Nombre de volontaires : entre 1 et 500.');
    return {
      departementId,
      etablissement,
      etablissementNormalise: cleEtablissement(etablissement),
      categorie: dto.categorie,
      specialite: dto.specialite?.replace(/\s+/g, ' ').trim() || null,
      nombre,
      anneeScolaire: dto.anneeScolaire?.trim() || null,
      observation: dto.observation?.trim() || null,
    };
  }

  async creerBesoin(u: UtilisateurConnecte, dto: BesoinDto) {
    const b = await this.besoins.save({
      ...(await this.valider(u, dto)),
      creePar: u.nom,
    });
    await this.journal.log(u, 'BESOIN_CREE', 'besoin_etablissement', b.id, {
      etablissement: b.etablissement,
      nombre: b.nombre,
    });
    return b;
  }

  async modifierBesoin(u: UtilisateurConnecte, id: number, dto: BesoinDto) {
    const b = await this.besoins.findOne({ where: { id } });
    if (!b) throw new NotFoundException('Besoin introuvable');
    this.perimetre(u, b.departementId);
    await this.besoins.update(id, await this.valider(u, dto));
    await this.journal.log(u, 'BESOIN_MODIFIE', 'besoin_etablissement', id, {
      nombre: dto.nombre,
    });
    return this.besoins.findOneOrFail({ where: { id } });
  }

  async supprimerBesoin(u: UtilisateurConnecte, id: number) {
    const b = await this.besoins.findOne({ where: { id } });
    if (!b) throw new NotFoundException('Besoin introuvable');
    this.perimetre(u, b.departementId);
    await this.besoins.delete(id);
    await this.journal.log(u, 'BESOIN_SUPPRIME', 'besoin_etablissement', id, {
      etablissement: b.etablissement,
    });
    return { ok: true };
  }

  async excelBesoins(u: UtilisateurConnecte): Promise<Buffer> {
    const { lignes } = await this.besoinsAvecCouverture(u);
    const deps = new Map((await this.deps.find()).map((d) => [d.id, d.nom]));
    const c = this.config.get();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Besoins');
    ws.addRow(['BESOINS EN ENSEIGNANTS VOLONTAIRES PAR ÉTABLISSEMENT']).font = {
      bold: true,
      size: 12,
    };
    ws.addRow([]);
    ws.addRow([
      'Département',
      'Établissement',
      'Catégorie',
      'Spécialité',
      'Besoin',
      'En poste',
      'Manque',
      'Observation',
    ]).font = { bold: true };
    for (const l of lignes)
      ws.addRow([
        deps.get(l.departementId),
        l.etablissement,
        c.categories.find((x) => x.code === l.categorie)?.libelle ??
          l.categorie,
        l.specialite ?? 'Toutes',
        l.nombre,
        l.enPoste,
        l.manque,
        l.observation,
      ]);
    ws.addRow([
      'TOTAL',
      '',
      '',
      '',
      lignes.reduce((t, l) => t + l.nombre, 0),
      lignes.reduce((t, l) => t + l.enPoste, 0),
      lignes.reduce((t, l) => t + l.manque, 0),
    ]).font = { bold: true };
    [16, 34, 22, 20, 9, 9, 9, 40].forEach(
      (w, i) => (ws.getColumn(i + 1).width = w),
    );
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  /* --------------------------- Tableau de bord --------------------------- */

  async tableau() {
    const c = this.config.get();
    const q = <T>(sql: string, p: unknown[] = []) =>
      this.besoins.query<T[]>(sql, p);
    const [registre] = await q<{
      enPoste: number;
      sortis: number;
      sansCategorie: number;
      sansDepartement: number;
    }>(
      `SELECT count(*) FILTER (WHERE statut = 'EN_POSTE')::int AS "enPoste", count(*) FILTER (WHERE statut = 'SORTI')::int AS sortis,
              count(*) FILTER (WHERE statut = 'EN_POSTE' AND categorie IS NULL)::int AS "sansCategorie",
              count(*) FILTER (WHERE statut = 'EN_POSTE' AND "departementId" IS NULL)::int AS "sansDepartement" FROM volontaire WHERE population = 'VOLONTAIRE'`,
    );
    const parDepCat = await q<{
      departementId: number | null;
      categorie: string | null;
      n: number;
    }>(
      `SELECT "departementId", categorie, count(*)::int AS n FROM volontaire WHERE population = 'VOLONTAIRE' AND statut = 'EN_POSTE' GROUP BY 1, 2`,
    );
    // Coût mensuel au barème actuel (sans rappels ni régularisations)
    const coutMensuel = parDepCat.reduce(
      (t, x) =>
        t +
        x.n *
          (c.categories.find((k) => k.code === x.categorie && k.actif)
            ?.bourse ?? 0),
      0,
    );
    const etats = await q<{
      id: number;
      mois: string;
      statut: string;
      effectif: number;
      total: string;
      bloquants: number;
    }>(
      `SELECT id, mois, statut, effectif, total::text,
              (SELECT count(*) FROM jsonb_array_elements(anomalies) a WHERE a->>'gravite' = 'BLOQUANT')::int AS bloquants
         FROM etat_bourse WHERE population = 'VOLONTAIRE' ORDER BY mois DESC LIMIT 12`,
    );
    const sorties = await q<{ mois: string; motif: string; n: number }>(
      `SELECT to_char("dateSortie", 'YYYY-MM') AS mois, "motifSortie" AS motif, count(*)::int AS n
         FROM volontaire WHERE population = 'VOLONTAIRE' AND statut = 'SORTI' AND "dateSortie" >= (date_trunc('month', now()) - interval '5 months')
        GROUP BY 1, 2 ORDER BY 1 DESC, 3 DESC`,
    );
    const [regs] = await q<{
      enAttente: number;
      complements: string;
      retenues: string;
      aRecouvrer: string;
    }>(
      `SELECT count(*) FILTER (WHERE r.statut = 'EN_ATTENTE')::int AS "enAttente",
              coalesce(sum(r.reste) FILTER (WHERE r.statut = 'EN_ATTENTE' AND r.type = 'COMPLEMENT'), 0)::text AS complements,
              coalesce(sum(r.reste) FILTER (WHERE r.statut = 'EN_ATTENTE' AND r.type = 'RETENUE' AND v.statut = 'EN_POSTE'), 0)::text AS retenues,
              coalesce(sum(r.reste) FILTER (WHERE r.statut = 'EN_ATTENTE' AND r.type = 'RETENUE' AND v.statut = 'SORTI'), 0)::text AS "aRecouvrer"
         FROM regularisation r JOIN volontaire v ON v.id = r."volontaireId"`,
    );
    const [enAttente] = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM enrole e JOIN note_service n ON n.id = e."noteId"
        WHERE n.module = 'ENROLEMENT' AND n.statut = 'SIGNEE' AND NOT EXISTS (SELECT 1 FROM volontaire v WHERE v."enroleId" = e.id)`,
    );
    const [mer] = await q<{ projets: number; valides: number; total: string }>(
      `SELECT count(*) FILTER (WHERE statut = 'BROUILLON')::int AS projets, count(*) FILTER (WHERE statut = 'VALIDE')::int AS valides,
              coalesce(sum(total) FILTER (WHERE statut = 'VALIDE'), 0)::text AS total FROM mise_en_route`,
    );
    const [besoins] = await q<{ besoin: number }>(
      `SELECT coalesce(sum(nombre), 0)::int AS besoin FROM besoin_etablissement`,
    );
    return {
      registre,
      parDepCat,
      coutMensuel,
      etats: etats.reverse(),
      sorties,
      regularisations: regs,
      enrolesAIntegrer: enAttente.n,
      misesEnRoute: mer,
      besoins: besoins.besoin,
      categories: c.categories.map((k) => ({
        code: k.code,
        libelle: k.libelle,
        bourse: k.bourse,
      })),
      motifs: c.motifsSortie.map((m) => ({ code: m.code, libelle: m.libelle })),
    };
  }

  /* ------------------------------ Guide pas à pas ------------------------------ */

  /**
   * L'état de chaque étape des trois parcours de l'enrôlement (démarrage, chaque année,
   * chaque mois), pour que l'utilisateur sache toujours où il en est et quoi faire ensuite.
   */
  async guide() {
    const q = async <T>(sql: string, p: unknown[] = []) =>
      (await this.besoins.query<T[]>(sql, p))[0];
    const n = (x: unknown) => Number(x ?? 0);
    const mois = jourLocal().slice(0, 7);

    const reg = await q<{
      enPoste: number;
      sortis: number;
      notes: number;
      sansCategorie: number;
      sansDepartement: number;
    }>(
      `SELECT count(*) FILTER (WHERE statut = 'EN_POSTE')::int AS "enPoste", count(*) FILTER (WHERE statut = 'SORTI')::int AS sortis,
              count(DISTINCT "noteReference")::int AS notes,
              count(*) FILTER (WHERE statut = 'EN_POSTE' AND categorie IS NULL)::int AS "sansCategorie",
              count(*) FILTER (WHERE statut = 'EN_POSTE' AND "departementId" IS NULL)::int AS "sansDepartement" FROM volontaire WHERE population = 'VOLONTAIRE'`,
    );
    const mer = await q<{ reprises: number; projets: number; valides: number }>(
      `SELECT count(*) FILTER (WHERE source = 'REPRISE')::int AS reprises,
              count(*) FILTER (WHERE statut = 'BROUILLON')::int AS projets,
              count(*) FILTER (WHERE statut = 'VALIDE')::int AS valides FROM mise_en_route`,
    );
    // Volontaires affectés par une note, en poste, jamais mis en route
    const sansMer = await q<{ n: number; notes: string | null }>(
      `SELECT count(*)::int AS n, string_agg(DISTINCT v."noteReference", ', ') AS notes FROM volontaire v
        WHERE v.statut = 'EN_POSTE' AND v."noteReference" IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM ligne_mise_en_route l JOIN mise_en_route m ON m.id = l."miseEnRouteId"
                           WHERE l."volontaireId" = v.id AND m.statut = 'VALIDE')`,
    );
    const etats = await q<{ valides: number; dernier: string | null }>(
      `SELECT count(*) FILTER (WHERE statut = 'VALIDE')::int AS valides, max(mois) FILTER (WHERE statut = 'VALIDE') AS dernier FROM etat_bourse WHERE population = 'VOLONTAIRE'`,
    );
    const ce = await q<
      | {
          id: number;
          statut: string;
          bloquants: number;
          effectif: number;
          total: string;
        }
      | undefined
    >(
      `SELECT id, statut, effectif, total::text,
              (SELECT count(*) FROM jsonb_array_elements(anomalies) a WHERE a->>'gravite' = 'BLOQUANT')::int AS bloquants
         FROM etat_bourse WHERE mois = $1 AND population = 'VOLONTAIRE'`,
      [mois],
    );
    const campagne = await q<
      { id: number; annee: number; ouverte: boolean; quota: number } | undefined
    >(
      `SELECT id, annee, ouverte, quota FROM campagne_enrolement ORDER BY annee DESC LIMIT 1`,
    );
    const dossiers = campagne
      ? await q<{
          aControler: number;
          aDecider: number;
          retenus: number;
          sansDepartement: number;
          horsNote: number;
          membres: number;
        }>(
          `SELECT count(*) FILTER (WHERE etat = 'A_CONTROLER')::int AS "aControler",
                  count(*) FILTER (WHERE etat = 'CONTROLE')::int AS "aDecider",
                  count(*) FILTER (WHERE etat = 'RETENU')::int AS retenus,
                  count(*) FILTER (WHERE etat = 'RETENU' AND "departementRetenuId" IS NULL)::int AS "sansDepartement",
                  count(*) FILTER (WHERE etat = 'RETENU' AND "noteId" IS NULL)::int AS "horsNote",
                  (SELECT count(*) FROM membre_enrolement m WHERE m."campagneId" = $1)::int AS membres
             FROM enrole WHERE "campagneId" = $1`,
          [campagne.id],
        )
      : null;
    const notes = await q<{
      aSoumettre: number;
      soumises: number;
      validees: number;
      signeesSansScan: number;
      signees: number;
    }>(
      `SELECT count(*) FILTER (WHERE statut = 'BROUILLON')::int AS "aSoumettre", count(*) FILTER (WHERE statut = 'SOUMISE')::int AS soumises,
              count(*) FILTER (WHERE statut = 'VALIDEE')::int AS validees,
              count(*) FILTER (WHERE statut = 'SIGNEE' AND "scanLe" IS NULL)::int AS "signeesSansScan",
              count(*) FILTER (WHERE statut = 'SIGNEE')::int AS signees
         FROM note_service WHERE module = 'ENROLEMENT' ${campagne ? 'AND "campagneId" = $1' : ''}`,
      campagne ? [campagne.id] : [],
    );
    const aIntegrer = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM enrole e JOIN note_service n ON n.id = e."noteId"
        WHERE n.module = 'ENROLEMENT' AND n.statut = 'SIGNEE' AND NOT EXISTS (SELECT 1 FROM volontaire v WHERE v."enroleId" = e.id)`,
    );
    const regsAttente = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM regularisation WHERE statut = 'EN_ATTENTE'`,
    );
    let tropPercus = 0;
    try {
      tropPercus = (await this.regs.tropPercus()).filter(
        (t) => t.aTraiter > 0,
      ).length;
    } catch {
      tropPercus = 0;
    }
    return {
      mois,
      registre: {
        enPoste: n(reg.enPoste),
        sortis: n(reg.sortis),
        notes: n(reg.notes),
        sansCategorie: n(reg.sansCategorie),
        sansDepartement: n(reg.sansDepartement),
      },
      misesEnRoute: {
        reprises: n(mer.reprises),
        projets: n(mer.projets),
        valides: n(mer.valides),
        sansMiseEnRoute: n(sansMer.n),
        notesSansMiseEnRoute: sansMer.notes,
      },
      bourse: {
        valides: n(etats.valides),
        dernierValide: etats.dernier,
        moisCourant: ce ? { ...ce, total: Number(ce.total) } : null,
      },
      campagne: campagne ? { ...campagne, ...dossiers } : null,
      notes: {
        aSoumettre: n(notes.aSoumettre),
        soumises: n(notes.soumises),
        validees: n(notes.validees),
        signeesSansScan: n(notes.signeesSansScan),
        signees: n(notes.signees),
      },
      enrolesAIntegrer: n(aIntegrer.n),
      regularisations: { enAttente: n(regsAttente.n), tropPercus },
    };
  }
}
