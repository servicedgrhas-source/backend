import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AncienRecrute, Agent, RegleDiplome } from '../entities';
import { codeCycle } from './referentiels';
import { ageRevolu, normaliser } from './texte';

/**
 * Âges vraisemblables à la date de signature du texte : le dossier n'est reçu qu'à 18 ans
 * révolus (au dépôt, donc au plus tard à la signature), et personne n'est recruté après 65 ans.
 * En dehors, la date de naissance est une faute de saisie (« 2018 » pour « 1988 »…).
 */
export const AGE_VRAISEMBLABLE = { min: 18, max: 65 } as const;
export const NAISSANCE_IMPROBABLE = 'Date de naissance improbable';
export const TEXTE_PARTAGE = 'N° de texte partagé';
export const RESSEMBLE = 'Ressemble à ';

export function naissanceImprobable(
  naissance: string | null | undefined,
  reference: string,
): boolean {
  if (!naissance) return false;
  const age = ageRevolu(naissance, reference);
  return age < AGE_VRAISEMBLABLE.min || age > AGE_VRAISEMBLABLE.max;
}

/** « 2018-08-18 » → « 18/08/2018 ». */
export function dateFr(d: string) {
  const [a, m, j] = d.split('-');
  return `${j}/${m}/${a}`;
}

/** Numéro de texte comparable : « 6 758 », « 6758 » et « N°6758 » sont le même texte. */
export function cleTexte(n: string | null | undefined) {
  return (n ?? '')
    .toUpperCase()
    .replace(/^N\s*[°O]\s*/, '')
    .replace(/\s+/g, '');
}

/** Champs d'une fiche qui disent si une anomalie est toujours vraie. */
export type FicheAnomalies = Pick<
  Agent,
  | 'anomalies'
  | 'dateNaissance'
  | 'departementId'
  | 'diplomeCode'
  | 'numeroTexte'
  | 'lotPublicationId'
  | 'quota'
  | 'feuille'
  | 'cycleBrut'
>;

/**
 * Les anomalies relevées à l'import (ou à la saisie) restent sur la fiche ; celle-ci peut
 * avoir été complétée depuis (répartition du quota « Autres », correction, réception du
 * texte…). On ne garde que celles qui sont encore vraies d'après la fiche telle qu'elle est.
 * `cycleDuDiplome` permet de revérifier l'écart de cycle ; sans lui, cet écart est gardé.
 */
export function anomaliesAJour(
  f: Partial<FicheAnomalies>,
  cycleDuDiplome?: (code: string) => string | undefined,
): string[] {
  const quotaAutres = f.feuille === 'QUOTA_AUTRES';
  return (f.anomalies ?? []).filter((a) => {
    // Date impossible : l'anomalie part dès que la date est corrigée
    if (a.startsWith(NAISSANCE_IMPROBABLE))
      return naissanceImprobable(
        f.dateNaissance,
        new Date().toISOString().slice(0, 10),
      );
    if (a.startsWith('Date de naissance')) return !f.dateNaissance;
    // « N° de texte partagé (6758, avec X) » : tant que la fiche garde ce numéro
    if (a.startsWith(TEXTE_PARTAGE)) {
      const n = /^[^(]*\(([^,)]+)/.exec(a)?.[1];
      return !!n && cleTexte(f.numeroTexte) === cleTexte(n);
    }
    // Le quota « Autres » arrive sans département : la répartition le donne, ce n'est pas une erreur du fichier
    if (a === 'Département absent' || a === 'Département non reconnu')
      return !f.departementId && !quotaAutres;
    if (a.startsWith('Diplôme')) return !f.diplomeCode;
    if (a === 'Cycle de la base différent de celui du diplôme') {
      if (!cycleDuDiplome || !f.diplomeCode) return true;
      const attendu = cycleDuDiplome(f.diplomeCode);
      const lu = codeCycle(f.cycleBrut);
      return !!attendu && !!lu && attendu !== lu;
    }
    if (a.startsWith('Lot de publication sans numéro')) return !f.numeroTexte;
    if (a.startsWith('Lot de publication invalide')) return !f.lotPublicationId;
    if (a.startsWith('Quota invalide')) return !f.quota;
    return true;
  });
}

/** « Ressemble à MOUANDA Jean (né(e) le 01/02/1990) » → « MOUANDA Jean ». */
export function nomRessemblant(anomalie: string) {
  return anomalie
    .slice('Ressemble à '.length)
    .replace(/ \(né\(e\) le [^)]*\)$/, '')
    .trim();
}

/** Remet les anomalies des fiches d'accord avec leur contenu (après une opération en masse). */
@Injectable()
export class AnomaliesService implements OnApplicationBootstrap {
  private readonly logger = new Logger('Anomalies');

  constructor(
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
    @InjectRepository(RegleDiplome)
    private readonly regles: Repository<RegleDiplome>,
    @InjectRepository(AncienRecrute)
    private readonly anciens: Repository<AncienRecrute>,
  ) {}

  /** Au démarrage : les fiches déjà en base sont remises d'accord une fois. */
  async onApplicationBootstrap() {
    const n = await this.reconcilier();
    if (n) this.logger.log(`${n} fiche(s) : anomalies déjà réglées retirées`);
  }

  /** Recalcule les anomalies des fiches données (toutes si `ids` est absent). */
  async reconcilier(ids?: string[]): Promise<number> {
    if (ids && !ids.length) return 0;
    const cycles = new Map(
      (await this.regles.find()).map((r) => [r.code, r.cycle]),
    );
    const q = this.agents
      .createQueryBuilder('a')
      .select([
        'a.id',
        'a.anomalies',
        'a.dateNaissance',
        'a.departementId',
        'a.diplomeCode',
        'a.numeroTexte',
        'a.lotPublicationId',
        'a.quota',
        'a.feuille',
        'a.cycleBrut',
      ])
      .where('jsonb_array_length(a.anomalies) > 0');
    if (ids) q.andWhere({ id: In(ids) });
    const fiches = await q.getMany();
    // « Ressemble à NOM » : l'autre fiche existe-t-elle encore (base actuelle ou années passées) ?
    const noms = [
      ...new Set(
        fiches.flatMap((a) =>
          a.anomalies
            .filter((x) => x.startsWith('Ressemble à '))
            .map((x) => normaliser(nomRessemblant(x))),
        ),
      ),
    ];
    const existants = new Map<string, Set<string>>();
    if (noms.length) {
      for (const x of await this.agents.find({
        where: { nomNormalise: In(noms) },
        select: ['id', 'nomNormalise'],
      }))
        existants.set(
          x.nomNormalise,
          (existants.get(x.nomNormalise) ?? new Set()).add(x.id),
        );
      for (const x of await this.anciens.find({
        where: { nomNormalise: In(noms) },
        select: ['id', 'nomNormalise'],
      }))
        existants.set(
          x.nomNormalise,
          (existants.get(x.nomNormalise) ?? new Set()).add(`ancien-${x.id}`),
        );
    }
    let n = 0;
    for (const a of fiches) {
      const justes = anomaliesAJour(a, (c) => cycles.get(c)).filter((x) => {
        if (!x.startsWith('Ressemble à ')) return true;
        const ids = existants.get(normaliser(nomRessemblant(x)));
        return !!ids && [...ids].some((id) => id !== a.id);
      });
      if (justes.length === a.anomalies.length) continue;
      await this.agents.update(a.id, { anomalies: justes });
      n++;
    }
    return n;
  }
}
