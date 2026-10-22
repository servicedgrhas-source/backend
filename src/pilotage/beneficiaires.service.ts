import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AffectationService } from '../affectation/affectation.service';
import { salaireBrut } from '../affectation/calcul';
import type { UtilisateurConnecte } from '../auth/auth';
import { CYCLES, LIBELLE_CYCLE, type Cycle } from '../common/referentiels';
import { normaliser } from '../common/texte';
import { JournalService } from '../core/core.service';
import {
  Agent,
  Beneficiaire,
  Enveloppe,
  MembreCommission,
  OrigineDossier,
  PlaceBeneficiaire,
} from '../entities';

export const NOM_COMMISSION = 'Commission de recrutement';

/** Places d'un cycle : prévues par le DG, utilisées par les fiches saisies. */
export interface PlacesCycle {
  prevues: number;
  utilisees: number;
}

/**
 * Planification du quota : le quota reçu de la FP (enveloppe et places par catégorie, il ne
 * change pas), puis le quota réajusté par le DG, réparti entre les bénéficiaires (ministre,
 * syndicats, commission…) par cycle. Ce qui compte, c'est la consommation (l'incidence) :
 * on peut échanger des places d'un cycle contre un autre tant que l'enveloppe tient.
 */
@Injectable()
export class BeneficiairesService implements OnModuleInit {
  constructor(
    @InjectRepository(Beneficiaire)
    private readonly beneficiaires: Repository<Beneficiaire>,
    @InjectRepository(PlaceBeneficiaire)
    private readonly places: Repository<PlaceBeneficiaire>,
    @InjectRepository(Enveloppe)
    private readonly enveloppes: Repository<Enveloppe>,
    @InjectRepository(OrigineDossier)
    private readonly origines: Repository<OrigineDossier>,
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
    @InjectRepository(MembreCommission)
    private readonly membres: Repository<MembreCommission>,
    private readonly affectation: AffectationService,
    private readonly journal: JournalService,
  ) {}

  /** La commission est toujours un bénéficiaire du quota (ses membres se partagent ses places). */
  async onModuleInit() {
    if (await this.beneficiaires.exist({ where: { commission: true } })) return;
    const existant = (await this.beneficiaires.find()).find((b) =>
      /commission/i.test(b.nom),
    );
    if (existant)
      await this.beneficiaires.update(existant.id, { commission: true });
    else
      await this.beneficiaires.save({
        nom: NOM_COMMISSION,
        commission: true,
        ordre: (await this.beneficiaires.count()) + 1,
      });
  }

  /** Bénéficiaire d'une origine écrite sur une fiche (« DDEPPSA du Pool » → origine « DDEPPSA du département »). */
  private beneficiaireDeOrigine(
    origineBrute: string | null,
    parLibelle: Map<string, number>,
  ): number | null {
    if (!origineBrute) return null;
    const k = normaliser(origineBrute);
    return (
      parLibelle.get(k) ??
      (k.startsWith('DDEPPSA')
        ? parLibelle.get(normaliser('DDEPPSA du département'))
        : undefined) ??
      null
    );
  }

  /**
   * Consommation du quota réajusté : chaque fiche saisie du quota compte pour un bénéficiaire
   * (la commission si elle vient d'un membre, sinon le bénéficiaire de son origine) dans le
   * cycle de son diplôme. `exclure` : la fiche en cours de modification.
   */
  async consommation(perimetre: string, exclure?: string) {
    const quota = Number(perimetre);
    const benefs = await this.liste();
    const commission = benefs.find((b) => b.commission) ?? null;
    const origines = await this.origines.find({
      order: { ordre: 'ASC', libelle: 'ASC' },
    });
    const parLibelle = new Map(
      origines
        .filter((o) => o.beneficiaireId)
        .map((o) => [normaliser(o.libelle), o.beneficiaireId!]),
    );
    const regles = await this.affectation.reglesParCode();
    const places = await this.places.find({ where: { perimetre } });
    const fiches = Number.isInteger(quota)
      ? await this.agents.find({
          where: { quota, feuille: 'MEPPSA' },
          select: [
            'id',
            'membreCommissionId',
            'origineBrute',
            'diplomeCode',
            'contentieuxAge',
          ],
          loadEagerRelations: false,
        })
      : [];
    const vide = () =>
      Object.fromEntries(
        CYCLES.map((c) => [c, { prevues: 0, utilisees: 0 }]),
      ) as Record<string, PlacesCycle>;
    const conso = new Map<number, Record<string, PlacesCycle>>(
      benefs.map((b) => [b.id, vide()]),
    );
    for (const p of places) {
      const c = conso.get(p.beneficiaireId)?.[p.cycle];
      if (c) c.prevues += p.places;
    }
    const sans = new Map<string, number>();
    let sansCycle = 0;
    for (const f of fiches) {
      if (f.id === exclure || f.contentieuxAge === 'REJETE') continue;
      const b = f.membreCommissionId
        ? (commission?.id ?? null)
        : this.beneficiaireDeOrigine(f.origineBrute, parLibelle);
      const cycle = f.diplomeCode
        ? regles.get(f.diplomeCode)?.cycle
        : undefined;
      if (!b) {
        const o = f.origineBrute?.trim() || 'Origine non précisée';
        sans.set(o, (sans.get(o) ?? 0) + 1);
        continue;
      }
      if (!cycle || !conso.get(b)?.[cycle]) {
        sansCycle++;
        continue;
      }
      conso.get(b)![cycle].utilisees++;
    }
    const membres = Number.isInteger(quota)
      ? await this.membres.find({ where: { quota } })
      : [];
    return {
      perimetre,
      beneficiaires: benefs.map((b) => {
        const cycles = conso.get(b.id)!;
        const prevues = Object.values(cycles).reduce(
          (t, c) => t + c.prevues,
          0,
        );
        const utilisees = Object.values(cycles).reduce(
          (t, c) => t + c.utilisees,
          0,
        );
        return {
          id: b.id,
          nom: b.nom,
          actif: b.actif,
          commission: b.commission,
          origines: b.commission
            ? []
            : origines
                .filter((o) => o.beneficiaireId === b.id)
                .map((o) => ({ id: o.id, libelle: o.libelle })),
          cycles,
          prevues,
          utilisees,
          // Commission : places données à ses membres (pour ce quota)
          ...(b.commission
            ? {
                membres: membres.length,
                placesMembres: membres.reduce((t, m) => t + m.places, 0),
              }
            : {}),
        };
      }),
      originesSansBeneficiaire: origines
        .filter((o) => !o.beneficiaireId && o.actif)
        .map((o) => ({ id: o.id, libelle: o.libelle })),
      fichesSansBeneficiaire: {
        total: [...sans.values()].reduce((t, n) => t + n, 0),
        parOrigine: [...sans.entries()]
          .map(([origine, n]) => ({ origine, n }))
          .sort((a, b) => b.n - a.n)
          .slice(0, 12),
      },
      fichesSansCycle: sansCycle,
      libellesCycles: Object.fromEntries(
        CYCLES.map((c) => [c, LIBELLE_CYCLE[c]]),
      ),
    };
  }

  /** Rattache une origine à un bénéficiaire (ou la détache). */
  async rattacherOrigine(
    u: UtilisateurConnecte,
    origineId: number,
    beneficiaireId: number | null,
  ) {
    const o = await this.origines.findOne({ where: { id: origineId } });
    if (!o) throw new NotFoundException('Origine introuvable');
    if (beneficiaireId) {
      const b = await this.beneficiaires.findOne({
        where: { id: beneficiaireId },
      });
      if (!b) throw new NotFoundException('Bénéficiaire introuvable');
      if (b.commission)
        throw new BadRequestException(
          'La commission compte les dossiers apportés par ses membres (choisis à la saisie) : on ne lui rattache pas d’origine.',
        );
    }
    await this.origines.update(origineId, { beneficiaireId });
    await this.journal.log(
      u,
      'ORIGINE_BENEFICIAIRE',
      'origine',
      String(origineId),
      {
        origine: o.libelle,
        beneficiaireId,
      },
    );
    return { ok: true };
  }

  /** Places de la commission dans le quota réajusté (0 : pas encore réparti). */
  async placesCommission(perimetre: string) {
    const c = await this.beneficiaires.findOne({ where: { commission: true } });
    if (!c) return 0;
    return (
      await this.places.find({ where: { perimetre, beneficiaireId: c.id } })
    ).reduce((t, p) => t + p.places, 0);
  }

  liste() {
    return this.beneficiaires.find({ order: { ordre: 'ASC', nom: 'ASC' } });
  }

  async enregistrer(
    u: UtilisateurConnecte,
    id: number | null,
    dto: { nom: string; actif?: boolean },
  ) {
    const nom = dto.nom?.replace(/\s+/g, ' ').trim();
    if (!nom) throw new BadRequestException('Écrivez le nom du bénéficiaire.');
    const meme = await this.beneficiaires.findOne({ where: { nom } });
    if (meme && meme.id !== id)
      throw new BadRequestException('Ce bénéficiaire existe déjà.');
    const b = id
      ? await this.beneficiaires.save({
          ...(await this.beneficiaires.findOneOrFail({ where: { id } })),
          nom,
          actif: dto.actif ?? true,
        })
      : await this.beneficiaires.save({
          nom,
          ordre: (await this.beneficiaires.count()) + 1,
        });
    await this.journal.log(
      u,
      'BENEFICIAIRE_QUOTA',
      'beneficiaire',
      String(b.id),
      { nom },
    );
    return b;
  }

  async supprimer(u: UtilisateurConnecte, id: number) {
    const b = await this.beneficiaires.findOne({ where: { id } });
    if (!b) throw new NotFoundException('Bénéficiaire introuvable');
    if (b.commission)
      throw new BadRequestException(
        'La commission de recrutement reste toujours dans les bénéficiaires (mettez ses places à 0 si besoin).',
      );
    if (await this.origines.exist({ where: { beneficiaireId: id } }))
      throw new BadRequestException(
        'Des origines sont rattachées à ce bénéficiaire : rattachez-les d’abord à un autre bénéficiaire.',
      );
    if (await this.places.exist({ where: { beneficiaireId: id } }))
      throw new BadRequestException(
        'Ce bénéficiaire a des places : mettez-les à 0 ou désactivez-le.',
      );
    await this.beneficiaires.delete(id);
    await this.journal.log(
      u,
      'BENEFICIAIRE_SUPPRIME',
      'beneficiaire',
      String(id),
      { nom: b.nom },
    );
    return { ok: true };
  }

  /** Coût annuel d'une place par cycle : l'indice du diplôme le plus recruté dans ce cycle. */
  private async couts() {
    const regles = [...(await this.affectation.reglesParCode()).values()];
    const p = this.affectation.parametresCalcul();
    const usage = await this.enveloppes.query<{ code: string; n: number }[]>(
      `SELECT "diplomeCode" AS code, count(*)::int AS n FROM agent WHERE "diplomeCode" IS NOT NULL GROUP BY 1`,
    );
    const n = new Map(usage.map((x) => [x.code, x.n]));
    return CYCLES.map((c) => {
      const du = regles.filter((r) => r.cycle === c && r.indice);
      const r = [...du].sort(
        (a, b) => (n.get(b.code) ?? 0) - (n.get(a.code) ?? 0),
      )[0];
      const salaire = salaireBrut(r?.indice, p) ?? 0;
      return {
        cycle: c,
        libelle: LIBELLE_CYCLE[c],
        categorie: r ? `${r.categorie ?? '?'}-${r.echelle ?? '?'}` : null,
        diplome: r?.libelle ?? null,
        indice: r?.indice ?? null,
        coutAnnuel: salaire * 12,
      };
    });
  }

  async planification(perimetre: string) {
    const env = await this.enveloppes.findOne({ where: { perimetre } });
    const cycles = await this.couts();
    const benefs = await this.liste();
    const places = await this.places.find({ where: { perimetre } });
    const conso = await this.consommation(perimetre);
    const lignes = benefs.map((b) => {
      const p = Object.fromEntries(
        CYCLES.map((c) => [
          c,
          places.find((x) => x.beneficiaireId === b.id && x.cycle === c)
            ?.places ?? 0,
        ]),
      );
      const incidence = cycles.reduce(
        (t, c) => t + (p[c.cycle] ?? 0) * c.coutAnnuel,
        0,
      );
      const c = conso.beneficiaires.find((x) => x.id === b.id)!;
      return {
        id: b.id,
        nom: b.nom,
        actif: b.actif,
        commission: b.commission,
        origines: c.origines,
        membres: c.membres ?? null,
        placesMembres: c.placesMembres ?? null,
        places: p,
        utilisees: Object.fromEntries(
          CYCLES.map((x) => [x, c.cycles[x].utilisees]),
        ),
        totalUtilisees: c.utilisees,
        total: Object.values(p).reduce((t, x) => t + x, 0),
        incidence,
      };
    });
    const incidence = lignes.reduce((t, l) => t + l.incidence, 0);
    const enveloppe = env ? Number(env.montantAnnuel) : null;
    return {
      perimetre,
      quotaRecu: env
        ? {
            enveloppe,
            placesCatI: env.placesCatI,
            placesCatII: env.placesCatII,
            placesCatIII: env.placesCatIII,
          }
        : null,
      cycles,
      lignes,
      originesSansBeneficiaire: conso.originesSansBeneficiaire,
      fichesSansBeneficiaire: conso.fichesSansBeneficiaire,
      fichesSansCycle: conso.fichesSansCycle,
      totaux: {
        places: lignes.reduce((t, l) => t + l.total, 0),
        parCycle: Object.fromEntries(
          CYCLES.map((c) => [
            c,
            lignes.reduce((t, l) => t + (l.places[c] ?? 0), 0),
          ]),
        ),
        incidence,
        reste: enveloppe !== null ? enveloppe - incidence : null,
      },
    };
  }

  /** Enregistre le quota réajusté ; refusé s'il dépasse l'enveloppe accordée. */
  async repartir(
    u: UtilisateurConnecte,
    perimetre: string,
    lignes: { beneficiaireId: number; cycle: string; places: number }[],
  ) {
    const cycles = await this.couts();
    const cout = new Map<string, number>(
      cycles.map((c) => [c.cycle, c.coutAnnuel]),
    );
    for (const l of lignes) {
      if (!CYCLES.includes(l.cycle as Cycle))
        throw new BadRequestException('Cycle inconnu.');
      if (!Number.isInteger(l.places) || l.places < 0)
        throw new BadRequestException(
          'Le nombre de places doit être un entier positif.',
        );
    }
    const incidence = lignes.reduce(
      (t, l) => t + l.places * (cout.get(l.cycle) ?? 0),
      0,
    );
    const env = await this.enveloppes.findOne({ where: { perimetre } });
    if (
      env &&
      Number(env.montantAnnuel) > 0 &&
      incidence > Number(env.montantAnnuel)
    )
      throw new BadRequestException(
        `La répartition consomme ${new Intl.NumberFormat('fr-FR').format(incidence)} F par an : elle dépasse l’enveloppe de ${new Intl.NumberFormat('fr-FR').format(Number(env.montantAnnuel))} F. Retirez des places, ou échangez des places chères contre des places moins chères.`,
      );
    const commission = await this.beneficiaires.findOne({
      where: { commission: true },
    });
    if (commission && Number.isInteger(Number(perimetre))) {
      const pourCommission = lignes
        .filter((l) => l.beneficiaireId === commission.id)
        .reduce((t, l) => t + l.places, 0);
      const auxMembres = (
        await this.membres.find({ where: { quota: Number(perimetre) } })
      ).reduce((t, m) => t + m.places, 0);
      if (auxMembres > pourCommission)
        throw new BadRequestException(
          `La commission aurait ${pourCommission} place(s), mais ${auxMembres} place(s) sont déjà données à ses membres (« Membres de la commission »). Donnez au moins ${auxMembres} place(s) à la commission, ou diminuez d’abord les places des membres.`,
        );
    }
    await this.places.delete({ perimetre });
    const aGarder = lignes.filter((l) => l.places > 0);
    if (aGarder.length)
      await this.places.insert(
        aGarder.map((l) => ({
          perimetre,
          beneficiaireId: l.beneficiaireId,
          cycle: l.cycle,
          places: l.places,
        })),
      );
    await this.journal.log(u, 'QUOTA_REAJUSTE', 'enveloppe', perimetre, {
      places: aGarder.reduce((t, l) => t + l.places, 0),
      incidence,
    });
    return this.planification(perimetre);
  }
}
