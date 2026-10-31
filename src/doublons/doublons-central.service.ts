import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { DoublonsService } from '../affectation/doublons.service';
import { ROLES_CONTROLE, type UtilisateurConnecte } from '../auth/auth';
import { RESSEMBLE } from '../common/anomalies';
import { IndexNoms } from '../common/index-noms';
import { libelleLot } from '../common/lots';
import { JournalService } from '../core/core.service';
import {
  Affectation,
  Agent,
  AgentRecense,
  CampagneEnrolement,
  Departement,
  DoublonDistinct,
  Enrole,
  Volontaire,
} from '../entities';
import { RecensementService } from '../recensement/recensement.service';

/**
 * Doublons probables, partout la même politique (DG, 31/10/2026) : pour chaque base (recrutés,
 * base du personnel, registre des volontaires et communautaires, enrôlés), les paires de fiches
 * qui sont probablement la même personne (même règle : nom proche et même date de naissance,
 * ou même nom sans date). Deux décisions :
 * - même personne : on garde une fiche, l'autre est supprimée définitivement après avoir complété
 *   celle gardée (cases vides, pièces, historique) ; chaque base garde ses sécurités (une fiche
 *   payée, dans une note validée… ne se supprime pas) ;
 * - deux personnes différentes : la paire n'est plus proposée.
 */

export type BaseDoublons = 'RECRUTES' | 'PERSONNEL' | 'VOLONTAIRES' | 'ENROLES';
export const BASES_DOUBLONS: BaseDoublons[] = [
  'RECRUTES',
  'PERSONNEL',
  'VOLONTAIRES',
  'ENROLES',
];

/** Une fiche telle qu'on la compare : des lignes « libellé : valeur », et si on peut la supprimer. */
export interface FicheDoublon {
  id: string;
  nom: string;
  /** Ce qui situe la fiche (« Base du personnel · fonctionnaire · REC-000123 »). */
  repere: string;
  lignes: { libelle: string; valeur: string | null }[];
  supprimable: boolean;
  /** Pourquoi elle ne se supprime pas (affichée sur le bouton). */
  raison: string | null;
}

const fr = (d: string | Date | null | undefined) =>
  d
    ? String(d instanceof Date ? d.toISOString() : d)
        .slice(0, 10)
        .split('-')
        .reverse()
        .join('/')
    : null;
const texte = (v: unknown): string | null =>
  v === null || v === undefined || v === ''
    ? null
    : typeof v === 'string'
      ? v
      : typeof v === 'number' || typeof v === 'boolean'
        ? String(v)
        : JSON.stringify(v);
const vide = (v: unknown) => v === null || v === undefined || v === '';
const paire = (a: string, b: string): [string, string] =>
  a < b ? [a, b] : [b, a];

/** Paires probables d'une liste (même règle partout), sans celles déclarées différentes. */
function pairesProbables<T>(
  fiches: T[],
  f: {
    id: (x: T) => string;
    nom: (x: T) => string;
    naissance: (x: T) => string | null;
    groupe?: (x: T) => string;
  },
  distinctes: (a: T, b: T) => boolean,
) {
  const index = new Map<string, IndexNoms<T>>();
  const res: [T, T][] = [];
  for (const x of fiches) {
    const g = f.groupe?.(x) ?? '';
    const ix = index.get(g) ?? index.set(g, new IndexNoms<T>()).get(g)!;
    for (const y of ix.probables(f.nom(x), f.naissance(x)))
      if (!distinctes(x, y)) res.push([y, x]);
    ix.ajouter(f.nom(x), f.naissance(x), x);
  }
  return res;
}

@Injectable()
export class DoublonsCentralService {
  constructor(
    @InjectRepository(Agent) private readonly recrutes: Repository<Agent>,
    @InjectRepository(Affectation)
    private readonly affectations: Repository<Affectation>,
    @InjectRepository(AgentRecense)
    private readonly personnel: Repository<AgentRecense>,
    @InjectRepository(Volontaire)
    private readonly volontaires: Repository<Volontaire>,
    @InjectRepository(Enrole) private readonly enroles: Repository<Enrole>,
    @InjectRepository(CampagneEnrolement)
    private readonly campagnes: Repository<CampagneEnrolement>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    @InjectRepository(DoublonDistinct)
    private readonly distincts: Repository<DoublonDistinct>,
    private readonly doublonsRecrutes: DoublonsService,
    private readonly rec: RecensementService,
    private readonly journal: JournalService,
  ) {}

  private base(b: string): BaseDoublons {
    if (!BASES_DOUBLONS.includes(b as BaseDoublons))
      throw new BadRequestException('Base inconnue.');
    return b as BaseDoublons;
  }

  /** Paires déclarées différentes d'une base (« a|b »). */
  private async declarees(base: BaseDoublons) {
    return new Set(
      (await this.distincts.find({ where: { base } })).map(
        (d) => `${d.a}|${d.b}`,
      ),
    );
  }

  private async nomsDeps() {
    return new Map((await this.deps.find()).map((d) => [d.id, d.nom]));
  }

  /* ------------------------------ Fiches comparées ------------------------------ */

  private async fiches(
    base: BaseDoublons,
    ids: string[],
  ): Promise<Map<string, FicheDoublon>> {
    if (!ids.length) return new Map();
    const deps = await this.nomsDeps();
    const res = new Map<string, FicheDoublon>();
    if (base === 'RECRUTES') {
      const agents = await this.recrutes.find({ where: { id: In(ids) } });
      const affs = new Map(
        (
          await this.affectations.find({
            where: { agentId: In(ids) },
            loadEagerRelations: false,
          })
        ).map((f) => [f.agentId, f]),
      );
      for (const a of agents) {
        const f = affs.get(a.id);
        const bloque = !!f && (f.statut === 'AFFECTE' || !!f.noteId);
        res.set(a.id, {
          id: a.id,
          nom: a.nomComplet,
          repere: `Base des recrutés · ${a.feuille === 'QUOTA_AUTRES' ? 'quota « Autres »' : `quota ${a.quota ?? '?'}`}`,
          lignes: [
            {
              libelle: 'Né(e) le',
              valeur:
                fr(a.dateNaissance) ??
                (a.dateNaissanceBrute
                  ? `illisible (${a.dateNaissanceBrute})`
                  : null),
            },
            { libelle: 'Lieu de naissance', valeur: a.lieuNaissance },
            { libelle: 'Diplôme', valeur: a.diplomeBrut },
            {
              libelle: 'Département',
              valeur: a.departement?.nom ?? a.departementBrut,
            },
            {
              libelle: 'Lot',
              valeur: a.lotPublication ? libelleLot(a.lotPublication) : null,
            },
            {
              libelle: 'Texte',
              valeur: a.numeroTexte
                ? `${a.typeTexte === 'DECRET' ? 'Décret' : 'Arrêté'} n° ${a.numeroTexte}`
                : null,
            },
            { libelle: 'Spécialité', valeur: a.specialite },
            { libelle: 'Source', valeur: a.source },
            {
              libelle: 'Affectation',
              valeur: f
                ? ({
                    A_TRAITER: 'à affecter',
                    AFFECTE: 'affectée',
                    EXCLU: 'retirée des notes',
                  }[f.statut] ?? f.statut)
                : 'aucune',
            },
          ],
          supprimable: !bloque,
          raison: bloque ? 'Dans une note validée ou signée' : null,
        });
      }
    } else if (base === 'PERSONNEL') {
      const agents = await this.personnel.find({
        where: { id: In(ids.map(Number)) },
      });
      const pieces = new Map(
        (
          await this.personnel.query<{ id: number; n: number }[]>(
            `SELECT "agentId" AS id, count(*)::int AS n FROM piece_recensement WHERE "agentId" = ANY($1) GROUP BY 1`,
            [agents.map((a) => a.id)],
          )
        ).map((x) => [x.id, x.n]),
      );
      for (const a of agents) {
        const d = a.donnees ?? {};
        res.set(String(a.id), {
          id: String(a.id),
          nom: a.nomComplet,
          repere: `Base du personnel · ${a.statut.toLowerCase()}${a.numeroFiche ? ` · ${a.numeroFiche}` : ''}`,
          lignes: [
            { libelle: 'Né(e) le', valeur: fr(a.dateNaissance) },
            { libelle: 'Lieu de naissance', valeur: texte(d.LIEU_NAISSANCE) },
            { libelle: 'Matricule', valeur: a.matricule },
            { libelle: 'Téléphone', valeur: a.telephone },
            {
              libelle: 'Département',
              valeur: a.departementId
                ? (deps.get(a.departementId) ?? null)
                : null,
            },
            { libelle: 'Lieu de service', valeur: texte(d.LIEU_SERVICE) },
            { libelle: 'Grade', valeur: texte(d.GRADE) },
            {
              libelle: 'Registre des volontaires',
              valeur: a.volontaireId ? 'inscrit' : null,
            },
            {
              libelle: 'Pièces',
              valeur: pieces.get(a.id) ? `${pieces.get(a.id)} pièce(s)` : null,
            },
            {
              libelle: 'Origine',
              valeur:
                {
                  SAISIE: 'saisie',
                  IMPORT: 'import Excel',
                  ENROLEMENT: 'registre des volontaires',
                  AFFECTATION: 'note d’affectation',
                }[a.source] ?? a.source,
            },
          ],
          supprimable: true,
          raison: null,
        });
      }
    } else if (base === 'VOLONTAIRES') {
      const vs = await this.volontaires.find({ where: { id: In(ids) } });
      const payes = await this.payes(vs.map((v) => v.id));
      for (const v of vs) {
        const p = payes.get(v.id) ?? 0;
        res.set(v.id, {
          id: v.id,
          nom: v.nomComplet,
          repere: `Registre · ${v.population === 'COMMUNAUTAIRE' ? 'communautaires' : 'volontaires'} · ${v.statut === 'EN_POSTE' ? 'en poste' : 'sorti'}`,
          lignes: [
            { libelle: 'Né(e) le', valeur: fr(v.dateNaissance) },
            { libelle: 'Lieu de naissance', valeur: v.lieuNaissance },
            { libelle: 'Téléphone', valeur: v.telephone },
            { libelle: 'Diplôme', valeur: v.diplome },
            {
              libelle: 'Département',
              valeur: v.departementId
                ? (deps.get(v.departementId) ?? null)
                : v.departementBrut,
            },
            { libelle: 'Établissement', valeur: v.etablissement },
            { libelle: 'Vague', valeur: v.vague },
            {
              libelle: 'Note de service',
              valeur: v.noteReference
                ? `${v.noteReference}${v.dateNote ? ` du ${fr(v.dateNote)}` : ''}`
                : null,
            },
            { libelle: 'Prise de service', valeur: fr(v.datePriseService) },
            {
              libelle: 'Payé',
              valeur: p ? `sur ${p} état(s) de paiement validé(s)` : 'jamais',
            },
          ],
          supprimable: !p,
          raison: p
            ? 'Déjà sur un état de paiement validé : sortez-la du registre (motif « Doublon »)'
            : null,
        });
      }
    } else {
      const es = await this.enroles.find({ where: { id: In(ids) } });
      const annees = new Map(
        (await this.campagnes.find()).map((c) => [c.id, c.annee]),
      );
      for (const e of es)
        res.set(e.id, {
          id: e.id,
          nom: e.nomComplet,
          repere: `Enrôlement ${annees.get(e.campagneId) ?? ''} · ${e.etat.toLowerCase().replace('_', ' ')}`,
          lignes: [
            { libelle: 'Né(e) le', valeur: fr(e.dateNaissance) },
            { libelle: 'Lieu de naissance', valeur: e.lieuNaissance },
            { libelle: 'Téléphone', valeur: e.telephone },
            {
              libelle: 'Diplôme',
              valeur:
                [e.diplome, e.diplomePrecision].filter(Boolean).join(' ') ||
                null,
            },
            { libelle: 'Cycle', valeur: e.cycle },
            { libelle: 'Spécialité', valeur: e.specialite },
            {
              libelle: 'Département retenu',
              valeur: e.departementRetenuId
                ? (deps.get(e.departementRetenuId) ?? null)
                : null,
            },
            { libelle: 'Établissement', valeur: e.etablissement },
            {
              libelle: 'Note',
              valeur: e.noteId ? 'dans une note validée' : null,
            },
          ],
          supprimable: !e.noteId,
          raison: e.noteId ? 'Dans une note d’enrôlement validée' : null,
        });
    }
    return res;
  }

  /** Nombre d'états de paiement validés (bourse, mise en route) où figure chaque volontaire. */
  private async payes(ids: string[]) {
    if (!ids.length) return new Map<string, number>();
    const l = await this.volontaires.query<{ id: string; n: number }[]>(
      `SELECT id, sum(n)::int AS n FROM (
         SELECT b."volontaireId" AS id, count(DISTINCT b."etatId") AS n FROM ligne_bourse b
           JOIN etat_bourse e ON e.id = b."etatId" AND e.statut <> 'BROUILLON'
          WHERE b."volontaireId" = ANY($1::uuid[]) GROUP BY 1
         UNION ALL
         SELECT l."volontaireId", count(DISTINCT l."miseEnRouteId") FROM ligne_mise_en_route l
           JOIN mise_en_route m ON m.id = l."miseEnRouteId" AND m.statut <> 'BROUILLON'
          WHERE l."volontaireId" = ANY($1::uuid[]) GROUP BY 1
         UNION ALL
         SELECT "volontaireId", count(*) FROM regularisation
          WHERE "volontaireId" = ANY($1::uuid[]) AND statut <> 'ANNULEE' GROUP BY 1
       ) x GROUP BY 1`,
      [ids],
    );
    return new Map(l.map((x) => [x.id, x.n]));
  }

  /* ------------------------------ Paires ------------------------------ */

  /** Toutes les paires probables d'une base, déclarées différentes exclues (ids). */
  private async toutesLesPaires(
    base: BaseDoublons,
  ): Promise<[string, string][]> {
    const declarees = await this.declarees(base);
    const pasDeclaree = (a: string, b: string) =>
      !declarees.has(paire(a, b).join('|'));
    if (base === 'RECRUTES') {
      const exclus = new Set(
        (
          await this.affectations.find({
            where: { statut: 'EXCLU' },
            select: ['agentId'],
            loadEagerRelations: false,
          })
        ).map((f) => f.agentId),
      );
      const l = (
        await this.recrutes.find({
          select: ['id', 'nomComplet', 'dateNaissance', 'anomaliesVerifiees'],
          loadEagerRelations: false,
        })
      ).filter((a) => !exclus.has(a.id));
      return pairesProbables(
        l,
        {
          id: (a) => a.id,
          nom: (a) => a.nomComplet,
          naissance: (a) => a.dateNaissance,
        },
        (a, b) =>
          !pasDeclaree(a.id, b.id) ||
          (a.anomaliesVerifiees ?? []).includes(
            `${RESSEMBLE}${b.nomComplet}`,
          ) ||
          (b.anomaliesVerifiees ?? []).includes(`${RESSEMBLE}${a.nomComplet}`),
      ).map(([a, b]) => [a.id, b.id]);
    }
    if (base === 'PERSONNEL') {
      const l = await this.personnel.query<
        {
          id: number;
          nomComplet: string;
          dateNaissance: string | null;
          distinctes: number[];
          matricule: string | null;
        }[]
      >(
        `SELECT id, "nomComplet", to_char("dateNaissance", 'YYYY-MM-DD') AS "dateNaissance", distinctes,
                upper(replace(matricule, ' ', '')) AS matricule
           FROM agent_recense ORDER BY id`,
      );
      return pairesProbables(
        l,
        {
          id: (a) => String(a.id),
          nom: (a) => a.nomComplet,
          naissance: (a) => a.dateNaissance,
        },
        (a, b) =>
          // Deux matricules différents : deux agents de l'État différents
          (!!a.matricule && !!b.matricule && a.matricule !== b.matricule) ||
          (a.distinctes ?? []).includes(b.id) ||
          (b.distinctes ?? []).includes(a.id) ||
          !pasDeclaree(String(a.id), String(b.id)),
      ).map(([a, b]) => [String(a.id), String(b.id)]);
    }
    if (base === 'VOLONTAIRES') {
      const l = await this.volontaires.find({
        where: { statut: 'EN_POSTE' },
        select: ['id', 'nomComplet', 'dateNaissance', 'verifications'],
      });
      return pairesProbables(
        l,
        {
          id: (v) => v.id,
          nom: (v) => v.nomComplet,
          naissance: (v) => v.dateNaissance,
        },
        // « Pas les mêmes personnes » déjà enregistré au contrôle de la bourse, sur les deux fiches
        (a, b) =>
          !pasDeclaree(a.id, b.id) ||
          (!!a.verifications?.DOUBLON && !!b.verifications?.DOUBLON),
      ).map(([a, b]) => [a.id, b.id]);
    }
    const l = await this.enroles.find({
      select: ['id', 'nomComplet', 'dateNaissance', 'campagneId'],
    });
    return pairesProbables(
      l,
      {
        id: (e) => e.id,
        nom: (e) => e.nomComplet,
        naissance: (e) => e.dateNaissance,
        // Même campagne : un candidat d'une année revient légitimement l'année suivante
        groupe: (e) => String(e.campagneId),
      },
      (a, b) => !pasDeclaree(a.id, b.id),
    ).map(([a, b]) => [a.id, b.id]);
  }

  /** Nombre de paires à trancher, par base. */
  async compter() {
    const r: Record<string, number> = {};
    for (const b of BASES_DOUBLONS)
      r[b] = (await this.toutesLesPaires(b)).length;
    return r;
  }

  /** Les paires d'une base, page par page (fiches complètes à comparer). */
  async paires(b: string, page = 1, taille = 20) {
    const base = this.base(b);
    const toutes = await this.toutesLesPaires(base);
    const ici = toutes.slice((page - 1) * taille, page * taille);
    const fiches = await this.fiches(base, [...new Set(ici.flat())]);
    return {
      base,
      total: toutes.length,
      page,
      taille,
      paires: ici
        .map(([a, b]) => ({ a: fiches.get(a), b: fiches.get(b) }))
        .filter(
          (p): p is { a: FicheDoublon; b: FicheDoublon } => !!p.a && !!p.b,
        ),
    };
  }

  /** Une fiche et celles qui lui ressemblent (depuis la ligne d'un module). */
  async candidats(b: string, id: string) {
    const base = this.base(b);
    const autres = (await this.toutesLesPaires(base))
      .filter(([x, y]) => x === id || y === id)
      .map(([x, y]) => (x === id ? y : x));
    const fiches = await this.fiches(base, [id, ...autres]);
    const fiche = fiches.get(id);
    if (!fiche) throw new NotFoundException('Fiche introuvable');
    return {
      base,
      fiche,
      candidats: autres
        .map((x) => fiches.get(x))
        .filter((x): x is FicheDoublon => !!x),
    };
  }

  /* ------------------------------ Décisions ------------------------------ */

  /**
   * Décision sur une paire : `SUPPRIMER` supprime définitivement `id` (gardée : `autreId`) ;
   * `DIFFERENTES` déclare deux personnes. Supprimer est réservé au contrôle (chef de service,
   * directeur, bureau d'études, DG).
   */
  async trancher(
    u: UtilisateurConnecte,
    b: string,
    id: string,
    autreId: string,
    decision: 'SUPPRIMER' | 'DIFFERENTES',
    motif?: string,
  ) {
    const base = this.base(b);
    if (id === autreId)
      throw new BadRequestException('Choisissez deux fiches différentes.');
    if (
      decision === 'SUPPRIMER' &&
      u.role !== 'ADMIN' &&
      !ROLES_CONTROLE.includes(u.role)
    )
      throw new ForbiddenException(
        'Supprimer une fiche est réservé au chef de service, au directeur, au bureau d’études et au DG.',
      );
    const fiches = await this.fiches(base, [id, autreId]);
    const supprimee = fiches.get(id);
    const gardee = fiches.get(autreId);
    if (!supprimee || !gardee) throw new NotFoundException('Fiche introuvable');

    if (decision === 'DIFFERENTES') {
      const [a, c] = paire(id, autreId);
      await this.distincts
        .createQueryBuilder()
        .insert()
        .values({ base, a, b: c, motif: motif?.trim() || null, par: u.nom })
        .orIgnore()
        .execute();
      // Mécanisme propre à chaque base, pour que ses écrans suivent la même décision
      if (base === 'RECRUTES')
        await this.doublonsRecrutes.trancher(u, id, autreId, 'DIFFERENTES');
      else if (base === 'PERSONNEL')
        await this.rec.distinguer(u, Number(id), Number(autreId));
      else if (base === 'VOLONTAIRES')
        for (const v of [id, autreId])
          await this.volontaires.query(
            `UPDATE volontaire SET verifications = coalesce(verifications, '{}'::jsonb) || jsonb_build_object('DOUBLON', jsonb_build_object('note', $2::text, 'par', $3::text, 'le', now()))
              WHERE id = $1`,
            [
              v,
              motif?.trim() ||
                'Deux personnes différentes (Doublons probables)',
              u.nom,
            ],
          );
      await this.journal.log(u, 'DOUBLON_DIFFERENTES', base.toLowerCase(), id, {
        base,
        autre: autreId,
        noms: [supprimee.nom, gardee.nom],
      });
      return { ok: true, decision };
    }

    if (!supprimee.supprimable)
      throw new BadRequestException(
        `${supprimee.nom} : ${supprimee.raison ?? 'cette fiche ne peut pas être supprimée'}. Supprimez plutôt l’autre fiche.`,
      );
    let completes: string[] = [];
    if (base === 'RECRUTES')
      completes =
        (await this.doublonsRecrutes.trancher(u, id, autreId, 'SUPPRIMER'))
          .completes ?? [];
    else if (base === 'PERSONNEL') {
      // Vérifié avant de rien déplacer : jamais de fusion à moitié faite
      const [x, y] = await Promise.all([
        this.personnel.findOne({
          where: { id: Number(id) },
          select: ['id', 'volontaireId'],
        }),
        this.personnel.findOne({
          where: { id: Number(autreId) },
          select: ['id', 'volontaireId'],
        }),
      ]);
      if (x?.volontaireId && y?.volontaireId)
        throw new BadRequestException(
          'Les deux fiches sont liées au registre des volontaires : la personne y est inscrite deux fois. Réglez d’abord le doublon dans l’onglet « Registre des volontaires » : sa fiche suivra.',
        );
      // La fusion du personnel garde `autreId` et absorbe `id` (pièces, parcours, présences,
      // mutations, nominations, emplois du temps…)
      await this.rec.fusionner(u, Number(autreId), Number(id));
      completes = ['fiche fusionnée'];
    } else if (base === 'VOLONTAIRES')
      completes = await this.supprimerVolontaire(id, autreId);
    else completes = await this.supprimerEnrole(id, autreId);

    await this.journal.log(
      u,
      'DOUBLON_FICHE_SUPPRIMEE',
      base.toLowerCase(),
      autreId,
      {
        base,
        supprimee: supprimee.nom,
        gardee: gardee.nom,
        completes,
      },
    );
    return { ok: true, decision, completes };
  }

  /** Volontaire jamais payé (vérifié avant) : supprimé, ses informations complètent l'autre fiche. */
  private async supprimerVolontaire(id: string, autreId: string) {
    const [v, g] = await Promise.all([
      this.volontaires.findOne({ where: { id } }),
      this.volontaires.findOne({ where: { id: autreId } }),
    ]);
    if (!v || !g) throw new NotFoundException('Fiche introuvable');
    const champs = [
      'dateNaissance',
      'lieuNaissance',
      'telephone',
      'diplome',
      'specialite',
      'categorie',
      'cycleBrut',
      'departementId',
      'departementBrut',
      'etablissement',
      'vague',
      'vagueNumero',
      'noteReference',
      'dateNote',
      'datePriseService',
      'premierMois',
      'observation',
      'enroleId',
    ] as const;
    const maj: Record<string, unknown> = {};
    for (const k of champs) if (vide(g[k]) && !vide(v[k])) maj[k] = v[k];
    await this.volontaires.manager.transaction(async (m) => {
      if (Object.keys(maj).length) await m.update(Volontaire, g.id, maj);
      // Fiche du personnel : rattachée à la fiche gardée si celle-ci n'en a pas
      const [lien] = await m.query<{ id: number }[]>(
        `SELECT id FROM agent_recense WHERE "volontaireId" = $1`,
        [g.id],
      );
      await m.query(
        `UPDATE agent_recense SET "volontaireId" = $2 WHERE "volontaireId" = $1`,
        [v.id, lien ? null : g.id],
      );
      // Lignes des états encore en brouillon (recalculées), mouvements et régularisations annulées
      await m.query(
        `DELETE FROM ligne_bourse b USING etat_bourse e WHERE e.id = b."etatId" AND e.statut = 'BROUILLON' AND b."volontaireId" = $1`,
        [v.id],
      );
      await m.query(
        `DELETE FROM ligne_mise_en_route l USING mise_en_route r WHERE r.id = l."miseEnRouteId" AND r.statut = 'BROUILLON' AND l."volontaireId" = $1`,
        [v.id],
      );
      await m.query(
        `DELETE FROM regularisation WHERE "volontaireId" = $1 AND statut = 'ANNULEE'`,
        [v.id],
      );
      await m.query(
        `DELETE FROM mouvement_volontaire WHERE "volontaireId" = $1`,
        [v.id],
      );
      await m.delete(Volontaire, v.id);
    });
    return Object.keys(maj);
  }

  /** Enrôlé pas encore dans une note (vérifié avant) : supprimé, ses informations complètent l'autre. */
  private async supprimerEnrole(id: string, autreId: string) {
    const [e, g] = await Promise.all([
      this.enroles.findOne({ where: { id } }),
      this.enroles.findOne({ where: { id: autreId } }),
    ]);
    if (!e || !g) throw new NotFoundException('Fiche introuvable');
    const champs = [
      'dateNaissance',
      'lieuNaissance',
      'telephone',
      'diplomePrecision',
      'promotion',
      'cycle',
      'specialite',
      'departementRetenuId',
      'etablissement',
      'origineBrute',
      'membreId',
      'observation',
    ] as const;
    const maj: Record<string, unknown> = {};
    for (const k of champs) if (vide(g[k]) && !vide(e[k])) maj[k] = e[k];
    await this.enroles.manager.transaction(async (m) => {
      if (Object.keys(maj).length) await m.update(Enrole, g.id, maj);
      await m.query(
        `UPDATE volontaire SET "enroleId" = $2 WHERE "enroleId" = $1`,
        [e.id, g.id],
      );
      await m.query(
        `UPDATE recommandation SET "enroleId" = $2 WHERE "enroleId" = $1`,
        [e.id, g.id],
      );
      await m.delete(Enrole, e.id);
    });
    return Object.keys(maj);
  }
}
