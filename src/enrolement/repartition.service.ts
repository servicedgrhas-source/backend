import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import ExcelJS from 'exceljs';
import { In, IsNull, Repository } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { specialiteStat } from '../common/referentiels';
import { JournalService } from '../core/core.service';
import {
  CampagneEnrolement,
  Departement,
  Enrole,
  RepartitionEnrolement,
} from '../entities';
import { CYCLES_ENROLEMENT } from './enrolement.service';

/**
 * Répartition des retenus par département (commission, réunion DG du 06/11/2026). « On fixe les
 * quotas par département, puis on dit quel nom dans quel département, sur un brouillon. » Le critère
 * croisé avec le département est libre : cycle, diplôme, spécialité, ou aucun. Les candidats sont les
 * retenus qui ne sont pas encore dans une note. Rien ne change dans la base avant la validation du DG.
 */

export const CRITERES_REPARTITION: Record<string, string> = {
  CYCLE: 'Cycle',
  DIPLOME: 'Diplôme',
  SPECIALITE: 'Spécialité',
  AUCUN: 'Sans autre critère',
};

const DIPLOMES: Record<string, string> = {
  BET: 'BET',
  CFEEN: 'CFEEN',
  DEMA: 'DEMA',
  DCAF: 'DCAF',
  LICENCE: 'Licence',
  MASTER: 'Master',
  AUTRE: 'Autre',
};

@Injectable()
export class RepartitionService {
  constructor(
    @InjectRepository(RepartitionEnrolement)
    private readonly repartitions: Repository<RepartitionEnrolement>,
    @InjectRepository(Enrole) private readonly enroles: Repository<Enrole>,
    @InjectRepository(CampagneEnrolement)
    private readonly campagnes: Repository<CampagneEnrolement>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    private readonly journal: JournalService,
  ) {}

  private async charger(campagneId: number) {
    const c = await this.campagnes.findOne({ where: { id: campagneId } });
    if (!c) throw new NotFoundException('Campagne introuvable');
    let r = await this.repartitions.findOne({ where: { campagneId } });
    if (!r)
      r = await this.repartitions.save(
        this.repartitions.create({ campagneId, critere: 'CYCLE' }),
      );
    return { c, r };
  }

  /** Les candidats : retenus, pas encore dans une note. */
  private candidats(campagneId: number) {
    return this.enroles.find({
      where: { campagneId, etat: 'RETENU', noteId: IsNull() },
      order: { nomNormalise: 'ASC' },
    });
  }

  /** La valeur d'un candidat pour le critère (la colonne de la grille). */
  private valeur(critere: string, e: Enrole) {
    if (critere === 'CYCLE') return e.cycle ?? 'Sans cycle';
    if (critere === 'DIPLOME') return DIPLOMES[e.diplome] ?? e.diplome;
    if (critere === 'SPECIALITE') return specialiteStat(e.specialite);
    return 'Tous';
  }

  private cle(critere: string, depId: number, valeur: string) {
    return `${critere}|${depId}|${valeur}`;
  }

  /**
   * La grille : départements × valeurs du critère ; chaque case dit les places fixées, les candidats
   * placés dans le brouillon, et ceux qui ont demandé ce département (1er, 2e ou 3e choix).
   */
  async grille(campagneId: number, critere?: string) {
    const { c, r } = await this.charger(campagneId);
    const crit = critere && CRITERES_REPARTITION[critere] ? critere : r.critere;
    if (crit !== r.critere) {
      r.critere = crit;
      await this.repartitions.update(r.id, { critere: crit });
    }
    const liste = await this.candidats(campagneId);
    const deps = await this.deps.find({ order: { ordre: 'ASC' } });
    const valeurs = [...new Set(liste.map((e) => this.valeur(crit, e)))];
    const ordre =
      crit === 'CYCLE'
        ? (v: string) => {
            const i = (CYCLES_ENROLEMENT as readonly string[]).indexOf(v);
            return i < 0 ? 99 : i;
          }
        : () => 0;
    const colonnes = valeurs.sort(
      (a, b) => ordre(a) - ordre(b) || a.localeCompare(b, 'fr'),
    );
    const grille = deps.map((d) => ({
      departementId: d.id,
      departement: d.nom,
      cases: colonnes.map((v) => {
        const k = this.cle(crit, d.id, v);
        const demandeurs = liste.filter(
          (e) =>
            this.valeur(crit, e) === v &&
            (e.departementsSouhaites ?? []).includes(d.id),
        );
        return {
          valeur: v,
          quota: r.quotas[k] ?? 0,
          places: liste.filter(
            (e) => this.valeur(crit, e) === v && r.placements[e.id] === d.id,
          ).length,
          demandeurs: demandeurs.length,
          premierChoix: demandeurs.filter(
            (e) => e.departementsSouhaites?.[0] === d.id,
          ).length,
        };
      }),
    }));
    const parColonne = colonnes.map((v) => ({
      valeur: v,
      candidats: liste.filter((e) => this.valeur(crit, e) === v).length,
      places: liste.filter(
        (e) => this.valeur(crit, e) === v && r.placements[e.id],
      ).length,
      quota: deps.reduce(
        (t, d) => t + (r.quotas[this.cle(crit, d.id, v)] ?? 0),
        0,
      ),
    }));
    const places = liste.filter((e) => r.placements[e.id]).length;
    return {
      campagne: { id: c.id, annee: c.annee, anneeScolaire: c.anneeScolaire },
      critere: crit,
      criteres: CRITERES_REPARTITION,
      colonnes,
      grille,
      parColonne,
      candidats: liste.length,
      places,
      nonPlaces: liste.length - places,
      dejaUnDepartement: liste.filter((e) => e.departementRetenuId).length,
      modifiePar: r.modifiePar,
      modifieLe: r.modifieLe,
      valideePar: r.valideePar,
      valideeLe: r.valideeLe,
    };
  }

  /** Les candidats d'une case : ceux du critère qui ont demandé ce département, puis les autres. */
  async candidatsCase(
    campagneId: number,
    departementId: number,
    valeur: string,
    tous = false,
  ) {
    const { r } = await this.charger(campagneId);
    const deps = new Map(
      (await this.deps.find()).map((d) => [d.id, d.nom] as const),
    );
    const liste = (await this.candidats(campagneId)).filter(
      (e) => this.valeur(r.critere, e) === valeur,
    );
    const rang = (e: Enrole) => {
      const i = (e.departementsSouhaites ?? []).indexOf(departementId);
      return i < 0 ? null : i + 1;
    };
    const lignes = liste
      .filter(
        (e) => tous || rang(e) !== null || r.placements[e.id] === departementId,
      )
      .map((e) => ({
        id: e.id,
        nom: e.nomComplet,
        diplome: DIPLOMES[e.diplome] ?? e.diplome,
        specialite: e.specialite,
        promotion: e.promotion,
        cycle: e.cycle,
        rang: rang(e),
        souhaits: (e.departementsSouhaites ?? []).map(
          (d) => deps.get(d) ?? '?',
        ),
        placeA: r.placements[e.id] ?? null,
        placeANom: r.placements[e.id]
          ? (deps.get(r.placements[e.id]) ?? null)
          : null,
      }))
      // Ici d'abord, puis 1er, 2e, 3e choix, puis la promotion la plus ancienne
      .sort(
        (a, b) =>
          Number(b.placeA === departementId) -
            Number(a.placeA === departementId) ||
          (a.rang ?? 9) - (b.rang ?? 9) ||
          String(a.promotion ?? '9999').localeCompare(
            String(b.promotion ?? '9999'),
          ) ||
          a.nom.localeCompare(b.nom, 'fr'),
      );
    return {
      departement: deps.get(departementId) ?? '',
      valeur,
      quota: r.quotas[this.cle(r.critere, departementId, valeur)] ?? 0,
      lignes,
    };
  }

  private modifiable(campagneId: number) {
    return this.charger(campagneId);
  }

  async fixerQuota(
    u: UtilisateurConnecte,
    campagneId: number,
    departementId: number,
    valeur: string,
    places: number,
  ) {
    const { r } = await this.modifiable(campagneId);
    const n = Math.max(0, Math.floor(Number(places) || 0));
    const k = this.cle(r.critere, departementId, valeur);
    const quotas = { ...r.quotas };
    if (n) quotas[k] = n;
    else delete quotas[k];
    await this.repartitions.update(r.id, { quotas, modifiePar: u.nom });
    return { ok: true, quota: n };
  }

  /** Placer (ou retirer : departementId null) des candidats dans le brouillon. */
  async placer(
    u: UtilisateurConnecte,
    campagneId: number,
    ids: string[],
    departementId: number | null,
  ) {
    const { r } = await this.modifiable(campagneId);
    if (!ids?.length) throw new BadRequestException('Aucun candidat choisi.');
    const valides = await this.enroles.find({
      where: { id: In(ids), campagneId, etat: 'RETENU', noteId: IsNull() },
      select: { id: true },
    });
    const placements = { ...r.placements };
    for (const e of valides)
      if (departementId) placements[e.id] = departementId;
      else delete placements[e.id];
    await this.repartitions.update(r.id, { placements, modifiePar: u.nom });
    return { ok: true, places: valides.length };
  }

  /**
   * Proposer (une aide, pas une décision) : chaque case encore incomplète reçoit, dans l'ordre, ceux
   * qui l'ont demandée en 1er choix, puis en 2e, puis en 3e (promotion la plus ancienne d'abord),
   * parmi les candidats pas encore placés. Tout reste modifiable.
   */
  async proposer(u: UtilisateurConnecte, campagneId: number) {
    const { r } = await this.modifiable(campagneId);
    const liste = await this.candidats(campagneId);
    const placements = { ...r.placements };
    const libres = () => liste.filter((e) => !placements[e.id]);
    let ajoutes = 0;
    for (const rangVoulu of [0, 1, 2])
      for (const [k, quota] of Object.entries(r.quotas)) {
        const [crit, dep, ...reste] = k.split('|');
        if (crit !== r.critere) continue;
        const depId = Number(dep);
        const valeur = reste.join('|');
        const deja = liste.filter(
          (e) => placements[e.id] === depId && this.valeur(crit, e) === valeur,
        ).length;
        let manque = quota - deja;
        if (manque <= 0) continue;
        const choix = libres()
          .filter(
            (e) =>
              this.valeur(crit, e) === valeur &&
              e.departementsSouhaites?.[rangVoulu] === depId,
          )
          .sort((a, b) =>
            String(a.promotion ?? '9999').localeCompare(
              String(b.promotion ?? '9999'),
            ),
          );
        for (const e of choix) {
          if (manque <= 0) break;
          placements[e.id] = depId;
          manque--;
          ajoutes++;
        }
      }
    await this.repartitions.update(r.id, { placements, modifiePar: u.nom });
    await this.journal.log(
      u,
      'REPARTITION_PROPOSEE',
      'campagne_enrolement',
      String(campagneId),
      { ajoutes },
    );
    return { ajoutes };
  }

  /** Vider le brouillon (les places fixées restent). */
  async vider(u: UtilisateurConnecte, campagneId: number) {
    const { r } = await this.modifiable(campagneId);
    await this.repartitions.update(r.id, { placements: {}, modifiePar: u.nom });
    return { ok: true };
  }

  /**
   * Validation du DG : chaque candidat placé reçoit son département retenu. Les autres ne changent
   * pas (ils restent de côté, sans département : ils n'entrent pas dans les notes).
   */
  async valider(u: UtilisateurConnecte, campagneId: number) {
    const { r } = await this.modifiable(campagneId);
    const liste = await this.candidats(campagneId);
    const parDep = new Map<number, string[]>();
    for (const e of liste) {
      const d = r.placements[e.id];
      if (!d) continue;
      parDep.set(d, [...(parDep.get(d) ?? []), e.id]);
    }
    if (!parDep.size)
      throw new BadRequestException(
        'Le brouillon est vide : placez d’abord les candidats.',
      );
    let n = 0;
    for (const [d, ids] of parDep) {
      // Un autre département déjà retenu : le brouillon l'emporte (choix de la commission)
      await this.enroles.update({ id: In(ids) }, { departementRetenuId: d });
      n += ids.length;
    }
    await this.repartitions.update(r.id, {
      valideePar: u.nom,
      valideeLe: new Date(),
    });
    await this.journal.log(
      u,
      'REPARTITION_VALIDEE',
      'campagne_enrolement',
      String(campagneId),
      {
        departements: parDep.size,
        candidats: n,
      },
    );
    return { candidats: n, departements: parDep.size };
  }

  /** Le brouillon en Excel : une feuille par département (pour travailler aussi sur papier). */
  async excel(campagneId: number) {
    const g = await this.grille(campagneId);
    const { r } = await this.charger(campagneId);
    const liste = await this.candidats(campagneId);
    const deps = new Map(
      (await this.deps.find()).map((d) => [d.id, d.nom] as const),
    );
    const wb = new ExcelJS.Workbook();
    const recap = wb.addWorksheet('Places');
    recap.addRow([
      `Répartition ${g.campagne.anneeScolaire} — places par département (${CRITERES_REPARTITION[g.critere]})`,
    ]).font = { bold: true, size: 12 };
    recap.addRow([]);
    const t = recap.addRow([
      'Département',
      ...g.colonnes.flatMap((v) => [
        `${v} : places`,
        `${v} : placés`,
        `${v} : demandeurs`,
      ]),
    ]);
    t.font = { bold: true };
    for (const l of g.grille)
      recap.addRow([
        l.departement,
        ...l.cases.flatMap((x) => [x.quota, x.places, x.demandeurs]),
      ]);
    recap.columns = [
      { width: 22 },
      ...g.colonnes.flatMap(() => [
        { width: 12 },
        { width: 12 },
        { width: 14 },
      ]),
    ];
    const brouillon = wb.addWorksheet('Brouillon');
    const e = brouillon.addRow([
      'Département',
      'N°',
      'Noms et prénoms',
      'Diplôme',
      'Spécialité',
      'Promotion',
      'Cycle',
      'Choix 1',
      'Choix 2',
      'Choix 3',
    ]);
    e.font = { bold: true };
    const parDep = [...deps.entries()];
    for (const [id, nom] of parDep) {
      const ici = liste.filter((x) => r.placements[x.id] === id);
      ici.forEach((x, i) =>
        brouillon.addRow([
          nom,
          i + 1,
          x.nomComplet,
          DIPLOMES[x.diplome] ?? x.diplome,
          x.specialite ?? '',
          x.promotion ?? '',
          x.cycle ?? '',
          ...[0, 1, 2].map(
            (k) => deps.get(x.departementsSouhaites?.[k] ?? -1) ?? '',
          ),
        ]),
      );
    }
    const restes = liste.filter((x) => !r.placements[x.id]);
    restes.forEach((x, i) =>
      brouillon.addRow([
        'Pas encore placé',
        i + 1,
        x.nomComplet,
        DIPLOMES[x.diplome] ?? x.diplome,
        x.specialite ?? '',
        x.promotion ?? '',
        x.cycle ?? '',
        ...[0, 1, 2].map(
          (k) => deps.get(x.departementsSouhaites?.[k] ?? -1) ?? '',
        ),
      ]),
    );
    brouillon.columns = [22, 6, 34, 10, 22, 10, 14, 16, 16, 16].map(
      (width) => ({ width }),
    );
    return {
      nom: `Répartition ${g.campagne.anneeScolaire}.xlsx`,
      contenu: Buffer.from(await wb.xlsx.writeBuffer()),
    };
  }
}
