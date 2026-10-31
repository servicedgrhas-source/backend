import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { IndexNoms } from '../common/index-noms';
import { cleCompacte } from '../common/texte';
import { JournalService } from '../core/core.service';
import {
  AgentRecense,
  DemandeMutation,
  Departement,
  Nomination,
} from '../entities';
import { etape, RecensementService } from '../recensement/recensement.service';
import { estVide, lireValeur } from '../recensement/valeurs';

/**
 * Rattachement des mutations et des nominations à la base du personnel (DG, 31/10/2026) : une
 * demande concerne une personne, on la relie à sa fiche. Jamais bloquant :
 * - sûr : même matricule (une seule fiche) → MATRICULE ; même nom, une seule fiche possible (et
 *   pas de contradiction de matricule ou de département) → NOM ;
 * - doute : plusieurs fiches possibles → A_VERIFIER, on choisit ;
 * - aucune fiche → INTROUVABLE : on crée la fiche depuis la demande (signalée « à valider »), ou on
 *   la laisse sans fiche.
 */

export type ModuleRattachement = 'MUTATION' | 'NOMINATION';

interface Demande {
  id: string;
  nom: string;
  matricule: string | null;
  departementId: number | null;
  agentId: number | null;
  rattachement: string | null;
}
interface Fiche {
  id: number;
  nomComplet: string;
  matricule: string | null;
  departementId: number | null;
}

@Injectable()
export class RattachementService {
  constructor(
    @InjectRepository(DemandeMutation)
    private readonly mutations: Repository<DemandeMutation>,
    @InjectRepository(Nomination)
    private readonly nominations: Repository<Nomination>,
    @InjectRepository(AgentRecense)
    private readonly agents: Repository<AgentRecense>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    private readonly rec: RecensementService,
    private readonly journal: JournalService,
  ) {}

  private module(m: string): ModuleRattachement {
    if (m !== 'MUTATION' && m !== 'NOMINATION')
      throw new BadRequestException('Module inconnu.');
    return m;
  }

  /** Les demandes d'un module, sous une forme commune. */
  private async demandes(
    module: ModuleRattachement,
    ids?: string[],
  ): Promise<Demande[]> {
    if (module === 'MUTATION')
      return (
        await this.mutations.find({
          where: ids ? { id: In(ids) } : {},
          select: [
            'id',
            'nomComplet',
            'matricule',
            'departementOrigineId',
            'agentId',
            'rattachement',
          ],
          loadEagerRelations: false,
        })
      ).map((d) => ({
        id: d.id,
        nom: d.nomComplet,
        matricule: d.matricule,
        departementId: d.departementOrigineId,
        agentId: d.agentId,
        rattachement: d.rattachement,
      }));
    return (
      await this.nominations.find({
        where: ids ? { id: In(ids.map(Number)) } : {},
        select: [
          'id',
          'nomComplet',
          'departementId',
          'agentId',
          'rattachement',
        ],
      })
    ).map((n) => ({
      id: String(n.id),
      nom: n.nomComplet,
      matricule: null,
      departementId: n.departementId,
      agentId: n.agentId,
      rattachement: n.rattachement,
    }));
  }

  private async ecrire(
    module: ModuleRattachement,
    id: string,
    agentId: number | null,
    rattachement: string,
  ) {
    if (module === 'MUTATION')
      await this.mutations.update(id, { agentId, rattachement });
    else await this.nominations.update(Number(id), { agentId, rattachement });
  }

  /** Index de toute la base du personnel (noms, matricules). */
  private async indexPersonnel() {
    const fiches = await this.agents.query<Fiche[]>(
      `SELECT id, "nomComplet", matricule, "departementId" FROM agent_recense`,
    );
    const index = new IndexNoms<Fiche>();
    const parMatricule = new Map<string, Fiche[]>();
    for (const f of fiches) {
      index.ajouter(f.nomComplet, null, f);
      const m = cleCompacte(f.matricule);
      if (m.length >= 4)
        (parMatricule.get(m) ?? parMatricule.set(m, []).get(m)!).push(f);
    }
    return { index, parMatricule };
  }

  /** Les fiches possibles d'une demande, et la décision la plus sûre. */
  private chercher(
    d: Demande,
    ix: Awaited<ReturnType<RattachementService['indexPersonnel']>>,
  ): { etat: string; agentId: number | null; candidats: Fiche[] } {
    const mat = cleCompacte(d.matricule);
    if (mat.length >= 4) {
      const m = ix.parMatricule.get(mat) ?? [];
      if (m.length === 1)
        return { etat: 'MATRICULE', agentId: m[0].id, candidats: m };
      if (m.length > 1)
        return { etat: 'A_VERIFIER', agentId: null, candidats: m };
    }
    // Même nom : écrit pareil (ordre des mots libre) ou au mot près
    let c = [
      ...new Map(
        [...ix.index.memesNoms(d.nom), ...ix.index.probables(d.nom, null)].map(
          (f) => [f.id, f],
        ),
      ).values(),
    ];
    // Un autre matricule connu : une autre personne
    if (mat.length >= 4)
      c = c.filter((f) => !f.matricule || cleCompacte(f.matricule) === mat);
    if (!c.length) return { etat: 'INTROUVABLE', agentId: null, candidats: [] };
    const memeDep = d.departementId
      ? c.filter((f) => f.departementId === d.departementId)
      : [];
    if (c.length === 1) {
      const f = c[0];
      // Une seule fiche, mais dans un autre département : à vérifier
      if (
        d.departementId &&
        f.departementId &&
        f.departementId !== d.departementId
      )
        return { etat: 'A_VERIFIER', agentId: null, candidats: c };
      return { etat: 'NOM', agentId: f.id, candidats: c };
    }
    if (memeDep.length === 1)
      return { etat: 'NOM', agentId: memeDep[0].id, candidats: c };
    return { etat: 'A_VERIFIER', agentId: null, candidats: c };
  }

  /**
   * Rattache les demandes pas encore rattachées (toutes, ou celles données). Les décisions déjà
   * prises (rattachée, créée, laissée sans fiche) ne sont pas refaites.
   */
  async rattacher(m: string, ids?: string[]) {
    const module = this.module(m);
    const ix = await this.indexPersonnel();
    const bilan: Record<string, number> = {};
    for (const d of await this.demandes(module, ids)) {
      if (d.agentId || d.rattachement === 'SANS_FICHE') continue;
      const r = this.chercher(d, ix);
      if (r.etat === d.rattachement && !r.agentId) continue;
      await this.ecrire(module, d.id, r.agentId, r.etat);
      bilan[r.etat] = (bilan[r.etat] ?? 0) + 1;
    }
    // Déjà liée sans état : une mutation l'a été depuis la fiche de l'agent (portail, saisie) ;
    // une nomination, par l'ancien import (même nom, une seule fiche)
    if (module === 'MUTATION')
      await this.mutations.update(
        { agentId: Not(IsNull()), rattachement: IsNull() },
        { rattachement: 'MANUEL' },
      );
    else
      await this.nominations.update(
        { agentId: Not(IsNull()), rattachement: IsNull() },
        { rattachement: 'NOM' },
      );
    return bilan;
  }

  /** Où en est le rattachement d'un module : nombre par état. */
  async bilan(m: string) {
    const module = this.module(m);
    const table = module === 'MUTATION' ? 'demande_mutation' : 'nomination';
    const l = await this.agents.query<{ etat: string | null; n: number }[]>(
      `SELECT CASE WHEN "agentId" IS NOT NULL THEN coalesce(rattachement, 'MANUEL') ELSE coalesce(rattachement, 'INTROUVABLE') END AS etat,
              count(*)::int AS n FROM ${table} GROUP BY 1`,
    );
    const creees = await this.agents.query<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM agent_recense WHERE liaison->'aValider'->>'origine' = $1`,
      [module],
    );
    return {
      parEtat: Object.fromEntries(
        l.map((x): [string, number] => [x.etat ?? 'INTROUVABLE', x.n]),
      ) as Record<string, number>,
      fichesAValider: creees[0]?.n ?? 0,
    };
  }

  /** Demandes à trancher (à vérifier, introuvables), avec leurs fiches possibles. */
  async aTrancher(m: string) {
    const module = this.module(m);
    const ix = await this.indexPersonnel();
    const deps = new Map((await this.deps.find()).map((d) => [d.id, d.nom]));
    const liste = (await this.demandes(module)).filter(
      (d) => !d.agentId && d.rattachement !== 'SANS_FICHE',
    );
    const ids = new Set<number>();
    const lignes = liste.map((d) => {
      const r = this.chercher(d, ix);
      r.candidats.forEach((c) => ids.add(c.id));
      return { d, r };
    });
    const details = new Map(
      (
        await this.agents.query<
          {
            id: number;
            numeroFiche: string | null;
            statut: string;
            dateNaissance: string | null;
            lieu: string | null;
            grade: string | null;
          }[]
        >(
          `SELECT id, "numeroFiche", statut, to_char("dateNaissance", 'YYYY-MM-DD') AS "dateNaissance",
                  donnees->>'LIEU_SERVICE' AS lieu, donnees->>'GRADE' AS grade
             FROM agent_recense WHERE id = ANY($1)`,
          [[...ids]],
        )
      ).map((x) => [x.id, x]),
    );
    return lignes
      .map(({ d, r }) => ({
        id: d.id,
        nom: d.nom,
        matricule: d.matricule,
        departement: d.departementId
          ? (deps.get(d.departementId) ?? null)
          : null,
        etat: r.etat === 'INTROUVABLE' ? 'INTROUVABLE' : 'A_VERIFIER',
        candidats: r.candidats.slice(0, 8).map((c) => ({
          id: c.id,
          nomComplet: c.nomComplet,
          matricule: c.matricule,
          departement: c.departementId
            ? (deps.get(c.departementId) ?? null)
            : null,
          ...details.get(c.id),
        })),
      }))
      .sort(
        (a, b) =>
          a.etat.localeCompare(b.etat) || a.nom.localeCompare(b.nom, 'fr'),
      );
  }

  /**
   * Décision sur une demande : LIER à une fiche choisie, CREER sa fiche (signalée « à valider »),
   * SANS_FICHE (laissée sans fiche ; elle n'est plus proposée).
   */
  async decider(
    u: UtilisateurConnecte,
    m: string,
    id: string,
    action: 'LIER' | 'CREER' | 'SANS_FICHE',
    agentId?: number,
  ) {
    const module = this.module(m);
    const [d] = await this.demandes(module, [id]);
    if (!d) throw new NotFoundException('Demande introuvable');
    if (action === 'LIER') {
      const a = agentId
        ? await this.agents.findOne({
            where: { id: agentId },
            select: ['id', 'nomComplet'],
          })
        : null;
      if (!a)
        throw new BadRequestException('Choisissez la fiche du personnel.');
      await this.ecrire(module, id, a.id, 'MANUEL');
      await this.journal.log(
        u,
        'RATTACHEMENT_PERSONNEL',
        module.toLowerCase(),
        id,
        { fiche: a.id, nom: d.nom },
      );
      return { ok: true, agentId: a.id };
    }
    if (action === 'SANS_FICHE') {
      await this.ecrire(module, id, null, 'SANS_FICHE');
      await this.journal.log(
        u,
        'RATTACHEMENT_SANS_FICHE',
        module.toLowerCase(),
        id,
        { nom: d.nom },
      );
      return { ok: true };
    }
    const fiche = await this.creerFiche(u, module, id);
    return { ok: true, agentId: fiche.id };
  }

  /** Crée les fiches de toutes les demandes introuvables d'un module. */
  async creerToutes(u: UtilisateurConnecte, m: string) {
    const module = this.module(m);
    const ix = await this.indexPersonnel();
    let n = 0;
    for (const d of await this.demandes(module)) {
      if (d.agentId || d.rattachement === 'SANS_FICHE') continue;
      if (this.chercher(d, ix).etat !== 'INTROUVABLE') continue;
      await this.creerFiche(u, module, d.id);
      n++;
    }
    return { creees: n };
  }

  /** Fiche du personnel créée depuis une demande : ce que la demande sait de la personne. */
  private async creerFiche(
    u: UtilisateurConnecte,
    module: ModuleRattachement,
    id: string,
  ) {
    const c = this.rec.config.get();
    const champ = (code: string) =>
      c.champs.find((x) => x.code === code && x.actif);
    const valeur = (code: string, v: unknown) => {
      const ch = champ(code);
      if (!ch || estVide(v)) return undefined;
      const lu = lireValeur(ch, v);
      return lu.erreur || estVide(lu.valeur) ? undefined : lu.valeur;
    };
    const deps = new Map((await this.deps.find()).map((x) => [x.id, x.code]));
    let brut: Record<string, unknown>;
    let statut = 'FONCTIONNAIRE';
    let repere: string;
    if (module === 'MUTATION') {
      const d = await this.mutations.findOne({ where: { id } });
      if (!d) throw new NotFoundException('Demande introuvable');
      if (d.agentId)
        throw new BadRequestException(
          'Cette demande est déjà rattachée à une fiche.',
        );
      if (d.typeAgent === 'FINALISTE') statut = 'VOLONTAIRE';
      brut = {
        NOMS_PRENOMS: d.nomComplet,
        MATRICULE_SOLDE: d.matricule,
        GRADE: d.grade,
        ECHELON: d.echelon,
        SPECIALITE: d.specialite,
        LIEU_SERVICE: d.lieuService,
        DEPARTEMENT: d.departementOrigineId
          ? deps.get(d.departementOrigineId)
          : null,
      };
      repere = `Demande de mutation n° ${d.numeroEnregistrement}`;
    } else {
      const n = await this.nominations.findOne({ where: { id: Number(id) } });
      if (!n) throw new NotFoundException('Nomination introuvable');
      if (n.agentId)
        throw new BadRequestException(
          'Cette nomination est déjà rattachée à une fiche.',
        );
      brut = {
        NOMS_PRENOMS: n.nomComplet,
        GRADE: n.grade,
        ECHELON: n.echelon,
        SPECIALITE: n.specialite,
        LIEU_SERVICE: n.ancienPoste,
        DEPARTEMENT: n.departementId ? deps.get(n.departementId) : null,
      };
      repere = `Nomination ${n.annee} (${n.categorie})`;
    }
    const donnees: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(brut)) {
      const x = valeur(k, v);
      if (x !== undefined) donnees[k] = x;
    }
    // Le nom passe toujours (la fiche doit pouvoir être retrouvée)
    if (estVide(donnees.NOMS_PRENOMS)) donnees.NOMS_PRENOMS = brut.NOMS_PRENOMS;
    const a = this.agents.create({
      statut,
      donnees,
      liaison: {
        aValider: {
          origine: module,
          demande: id,
          repere,
          par: u.nom,
          le: new Date().toISOString(),
        },
      },
      parcours: [etape(statut, u.nom, null, repere)],
      source: module,
      creePar: u.nom,
      modifiePar: u.nom,
    });
    const col = await this.rec.colonnes(donnees);
    Object.assign(a, col);
    this.rec.appliquerEvaluation(a, {});
    const fiche = await this.agents.save(a);
    await this.agents.query(
      `UPDATE agent_recense SET "numeroFiche" = 'REC-' || lpad(id::text, 6, '0') WHERE id = $1 AND "numeroFiche" IS NULL`,
      [fiche.id],
    );
    await this.ecrire(module, id, fiche.id, 'CREEE');
    await this.journal.log(
      u,
      'RATTACHEMENT_FICHE_CREEE',
      'agent_recense',
      fiche.id,
      { origine: module, repere, nom: fiche.nomComplet },
    );
    return fiche;
  }

  /* ------------------------- Fiches créées, à valider ------------------------- */

  /** Fiches créées depuis une mutation ou une nomination, en attente de validation. */
  async fichesAValider() {
    return this.agents.query<
      {
        id: number;
        numeroFiche: string | null;
        nomComplet: string;
        statut: string;
        matricule: string | null;
        departement: string | null;
        lieu: string | null;
        origine: string;
        repere: string | null;
        par: string | null;
        le: string | null;
      }[]
    >(
      `SELECT a.id, a."numeroFiche", a."nomComplet", a.statut, a.matricule, d.nom AS departement,
              a.donnees->>'LIEU_SERVICE' AS lieu, a.liaison->'aValider'->>'origine' AS origine,
              a.liaison->'aValider'->>'repere' AS repere, a.liaison->'aValider'->>'par' AS par,
              a.liaison->'aValider'->>'le' AS le
         FROM agent_recense a LEFT JOIN departement d ON d.id = a."departementId"
        WHERE a.liaison ? 'aValider' ORDER BY a.id DESC`,
    );
  }

  /**
   * VALIDER : la fiche entre normalement dans la base. REJETER : ce n'est pas un agent reconnu,
   * la fiche reste mais marquée rejetée (hors effectifs), la demande garde son lien. SUPPRIMER :
   * fiche créée par erreur, effacée ; ses demandes redeviennent à rattacher.
   */
  async validerFiche(
    u: UtilisateurConnecte,
    id: number,
    action: 'VALIDER' | 'REJETER' | 'SUPPRIMER',
    note?: string,
  ) {
    const a = await this.agents.findOne({ where: { id } });
    if (!a || !a.liaison?.aValider)
      throw new NotFoundException('Fiche introuvable, ou déjà validée.');
    const liaison = { ...a.liaison };
    delete liaison.aValider;
    if (action === 'SUPPRIMER') {
      const [lie] = await this.agents.query<{ n: number }[]>(
        `SELECT (SELECT count(*) FROM piece_recensement WHERE "agentId" = $1) + (SELECT count(*) FROM evenement_carriere WHERE "agentId" = $1) +
                (SELECT count(*) FROM presence WHERE "agentId" = $1) AS n`,
        [id],
      );
      if (Number(lie?.n) > 0)
        throw new BadRequestException(
          'Cette fiche a déjà des pièces ou un suivi : validez-la, ou fusionnez-la avec la bonne fiche (Doublons probables).',
        );
      await this.agents.manager.transaction(async (m) => {
        await m.query(
          `UPDATE demande_mutation SET "agentId" = NULL, rattachement = NULL WHERE "agentId" = $1`,
          [id],
        );
        await m.query(
          `UPDATE nomination SET "agentId" = NULL, rattachement = NULL WHERE "agentId" = $1`,
          [id],
        );
        await m.delete(AgentRecense, id);
      });
    } else {
      a.liaison = liaison;
      a.modifiePar = u.nom;
      if (action === 'REJETER') {
        const maintenant = new Date().toISOString();
        a.contentieux = {
          etat: 'REJETE',
          motif:
            note?.trim() ||
            'Fiche créée depuis une demande, rejetée : pas un agent reconnu',
          ouvertPar: u.nom,
          ouvertLe: maintenant,
          decidePar: u.nom,
          decideLe: maintenant,
        };
      }
      await this.agents.save(a);
    }
    await this.journal.log(u, `FICHE_CREEE_${action}`, 'agent_recense', id, {
      nom: a.nomComplet,
      note,
    });
    return { ok: true };
  }
}
