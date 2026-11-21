import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { JournalService } from '../core/core.service';
import { AgentRecense, Departement, Nomination, Structure } from '../entities';
import { nomOfficiel } from '../etablissements/repertoire-ecoles.service';
import { CATEGORIE } from './categories';
import { CHEFS_DE_STRUCTURE, cleEcole, placerNominations } from './placement';

/**
 * Ce que devient une nomination validée dans l'organigramme :
 * - A_PLACER : structure sûre, cochée d'office ;
 * - A_CONFIRMER : structure probable (nom proche, plusieurs possibles) ;
 * - CONFLIT : deux chefs pour une structure, ou une personne nommée à deux postes ;
 * - SANS_FICHE : le nommé n'est pas relié à sa fiche du personnel (page Nominations) ;
 * - INTROUVABLE : la structure n'est pas dans l'organigramme (l'école peut être ajoutée) ;
 * - SANS_STRUCTURE : fonction départementale sans structure (coordonnateurs départementaux) ;
 * - DEJA_FAIT : la fiche et la structure le disent déjà.
 */
export type EtatNominationPlacee =
  | 'A_PLACER'
  | 'A_CONFIRMER'
  | 'CONFLIT'
  | 'SANS_FICHE'
  | 'INTROUVABLE'
  | 'SANS_STRUCTURE'
  | 'DEJA_FAIT';

export interface NominationPlacee {
  id: number;
  etat: EtatNominationPlacee;
  categorie: string;
  fonction: string;
  /** Le nommé dirige la structure : il en devient le responsable. */
  chef: boolean;
  departementId: number | null;
  departement: string | null;
  nomComplet: string;
  observation: string;
  poste: string | null;
  circonscription: string | null;
  agentId: number | null;
  structureId: number | null;
  structure: string | null;
  ressemblance: number | null;
  pourquoi: string | null;
  /** Où est la fiche aujourd'hui. */
  ficheStructure: string | null;
  /** Le responsable actuel de la structure (un autre que le nommé). */
  remplace: string | null;
  /** Structure introuvable : l'inspection où ajouter l'école. */
  inspectionAjoutId: number | null;
  inspectionAjout: string | null;
  cochee: boolean;
}

export interface RapportPlacement {
  annee: string | null;
  annees: string[];
  compteurs: Record<EtatNominationPlacee, number>;
  /** Structures qui recevront leur responsable si tout ce qui est coché est enregistré. */
  responsables: number;
  nominations: NominationPlacee[];
  inspections: Record<string, { id: number; nom: string }[]>;
}

const SOURCE = 'Nominations (placement)';

@Injectable()
export class PlacementNominationsService {
  constructor(
    @InjectRepository(Nomination)
    private readonly nominations: Repository<Nomination>,
    @InjectRepository(Structure)
    private readonly structures: Repository<Structure>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    @InjectRepository(AgentRecense)
    private readonly agents: Repository<AgentRecense>,
    private readonly journal: JournalService,
  ) {}

  async analyse(anneeDemandee?: string): Promise<RapportPlacement> {
    const annees = (
      await this.nominations.query<{ annee: string }[]>(
        `SELECT DISTINCT annee FROM nomination WHERE statut = 'VALIDEE' ORDER BY annee DESC`,
      )
    ).map((x) => x.annee);
    const annee =
      anneeDemandee && annees.includes(anneeDemandee)
        ? anneeDemandee
        : (annees[0] ?? null);
    const compteurs = {
      A_PLACER: 0,
      A_CONFIRMER: 0,
      CONFLIT: 0,
      SANS_FICHE: 0,
      INTROUVABLE: 0,
      SANS_STRUCTURE: 0,
      DEJA_FAIT: 0,
    } as Record<EtatNominationPlacee, number>;
    if (!annee)
      return {
        annee,
        annees,
        compteurs,
        responsables: 0,
        nominations: [],
        inspections: {},
      };

    const [liste, structures, deps] = await Promise.all([
      this.nominations.find({
        where: { annee, statut: 'VALIDEE' },
        order: { id: 'ASC' },
      }),
      this.structures.find(),
      this.deps.find(),
    ]);
    const actives = liste.filter((n) => n.observation !== 'RELEVE');
    const parId = new Map(structures.map((s) => [s.id, s]));
    const depNom = new Map(deps.map((d) => [d.id, d.nom]));
    const places = placerNominations(actives, structures, deps);

    const agentIds = [
      ...new Set(actives.map((n) => n.agentId).filter((x): x is number => !!x)),
    ];
    const fiches = new Map(
      (agentIds.length
        ? await this.agents.query<
            {
              id: number;
              structureId: number | null;
              fonction: string | null;
            }[]
          >(
            `SELECT id, "structureId", donnees->>'FONCTION_STRUCTURE' AS fonction FROM agent_recense WHERE id = ANY($1)`,
            [agentIds],
          )
        : []
      ).map((f) => [f.id, f]),
    );
    const respIds = [
      ...new Set(
        structures.map((s) => s.responsableId).filter((x): x is number => !!x),
      ),
    ];
    const nomsResp = new Map(
      (respIds.length
        ? await this.agents.query<{ id: number; nom: string }[]>(
            `SELECT id, "nomComplet" AS nom FROM agent_recense WHERE id = ANY($1)`,
            [respIds],
          )
        : []
      ).map((x) => [x.id, x.nom]),
    );

    // Conflits : deux chefs différents pour une même structure ; une personne à deux postes
    const chefsPar = new Map<number, Set<number>>();
    const postesPar = new Map<number, number>();
    for (const n of actives) {
      const p = places.get(n.id)!;
      if (!n.agentId || !p.structureId) continue;
      if (p.etat !== 'SUR' && p.etat !== 'PROBABLE') continue;
      postesPar.set(n.agentId, (postesPar.get(n.agentId) ?? 0) + 1);
      if (CHEFS_DE_STRUCTURE.has(n.categorie)) {
        const e = chefsPar.get(p.structureId) ?? new Set<number>();
        e.add(n.agentId);
        chefsPar.set(p.structureId, e);
      }
    }

    const sortie: NominationPlacee[] = actives.map((n) => {
      const p = places.get(n.id)!;
      const cat = CATEGORIE.get(n.categorie);
      const fonction = cat?.libelle ?? n.categorie;
      const chef = CHEFS_DE_STRUCTURE.has(n.categorie);
      const s = p.structureId ? parId.get(p.structureId) : undefined;
      const fiche = n.agentId ? fiches.get(n.agentId) : undefined;
      const inspAjout = p.inspectionAjoutId
        ? parId.get(p.inspectionAjoutId)
        : undefined;
      let etat: EtatNominationPlacee;
      let pourquoi = p.pourquoi;
      if (p.etat === 'SANS_STRUCTURE') etat = 'SANS_STRUCTURE';
      else if (p.etat === 'INTROUVABLE') etat = 'INTROUVABLE';
      else if (!n.agentId || !fiche) {
        etat = 'SANS_FICHE';
        pourquoi =
          n.rattachement === 'A_VERIFIER'
            ? 'plusieurs fiches possibles : à choisir dans la page Nominations'
            : 'fiche du personnel non retrouvée : à rattacher dans la page Nominations';
      } else if ((postesPar.get(n.agentId) ?? 0) > 1) {
        etat = 'CONFLIT';
        pourquoi =
          'nommé(e) à plusieurs postes cette année : à trancher dans la page Nominations (doublons)';
      } else if (chef && (chefsPar.get(p.structureId!)?.size ?? 0) > 1) {
        etat = 'CONFLIT';
        pourquoi = `${chefsPar.get(p.structureId!)!.size} responsables nommés pour « ${s?.nom} » : à trancher dans la page Nominations`;
      } else if (
        fiche.structureId === p.structureId &&
        fiche.fonction === fonction &&
        (!chef || s?.responsableId === n.agentId)
      )
        etat = 'DEJA_FAIT';
      else etat = p.etat === 'SUR' ? 'A_PLACER' : 'A_CONFIRMER';
      compteurs[etat]++;
      return {
        id: n.id,
        etat,
        categorie: n.categorie,
        fonction,
        chef,
        departementId: n.departementId,
        departement: n.departementId
          ? (depNom.get(n.departementId) ?? null)
          : null,
        nomComplet: n.nomComplet,
        observation: n.observation,
        poste: n.nouveauPoste,
        circonscription: n.circonscription,
        agentId: n.agentId,
        structureId: p.structureId,
        structure: s?.nom ?? null,
        ressemblance: p.ressemblance,
        pourquoi,
        ficheStructure: fiche?.structureId
          ? (parId.get(fiche.structureId)?.nom ?? null)
          : null,
        remplace:
          chef && s?.responsableId && s.responsableId !== n.agentId
            ? (nomsResp.get(s.responsableId) ?? 'un autre agent')
            : null,
        inspectionAjoutId: inspAjout?.id ?? null,
        inspectionAjout: inspAjout?.nom ?? null,
        cochee: etat === 'A_PLACER',
      };
    });

    // Inspections où ajouter une école introuvable, par département et cycle
    const inspections: RapportPlacement['inspections'] = {};
    for (const s of structures)
      if (s.type === 'INSPECTION' && s.actif && s.departementId)
        (inspections[String(s.departementId)] ??= []).push({
          id: s.id,
          nom: s.nom,
        });
    for (const l of Object.values(inspections))
      l.sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));

    return {
      annee,
      annees,
      compteurs,
      responsables: new Set(
        sortie.filter((x) => x.cochee && x.chef).map((x) => x.structureId),
      ).size,
      nominations: sortie,
      inspections,
    };
  }

  /**
   * Placement d'office à la validation (DG, 21/11/2026 : « quand on nomme quelqu'un d'autre, ça doit
   * être à jour ») : les nominations validées dont la structure est reconnue sans doute (« À placer »)
   * prennent effet tout de suite, le nouveau responsable remplaçant l'ancien. Les cas douteux
   * (à confirmer, conflit, sans fiche, introuvable) restent dans « Placer les nommés ».
   */
  async placerValidees(u: UtilisateurConnecte, ids: number[]) {
    const vide = { placees: 0, responsables: 0, aTraiter: 0 };
    if (!ids.length) return vide;
    const annees = await this.nominations.query<{ annee: string }[]>(
      `SELECT DISTINCT annee FROM nomination WHERE id = ANY($1) AND statut = 'VALIDEE'`,
      [ids],
    );
    const res = { ...vide };
    for (const { annee } of annees) {
      const r = await this.analyse(annee);
      if (r.annee !== annee) continue;
      const voulues = new Set(ids);
      const lignes = r.nominations.filter((n) => voulues.has(n.id));
      const placer = lignes
        .filter((n) => n.etat === 'A_PLACER')
        .map((n) => n.id);
      res.aTraiter += lignes.filter(
        (n) => !['A_PLACER', 'DEJA_FAIT', 'SANS_STRUCTURE'].includes(n.etat),
      ).length;
      if (!placer.length) continue;
      const a = await this.appliquer(u, annee, { placer, ajouter: [] });
      res.placees += a.placees;
      res.responsables += a.responsables;
    }
    return res;
  }

  /**
   * Enregistre ce que la DGRHAS a coché : le chef devient le responsable de sa structure, la fiche
   * de chaque nommé est rattachée à sa structure avec sa fonction (et son département s'il change) ;
   * une école de la note absente de l'organigramme est ajoutée dans l'inspection choisie.
   */
  async appliquer(
    u: UtilisateurConnecte,
    annee: string,
    choix: {
      placer: number[];
      ajouter: { id: number; inspectionId: number }[];
    },
  ) {
    const r = await this.analyse(annee);
    if (r.annee !== annee)
      throw new BadRequestException('Année des nominations inconnue.');
    const parId = new Map(r.nominations.map((n) => [n.id, n]));
    const res = {
      placees: 0,
      responsables: 0,
      fiches: 0,
      changementsDepartement: 0,
      ecolesAjoutees: 0,
      refus: [] as string[],
    };
    const deps = new Map((await this.deps.find()).map((d) => [d.id, d]));
    const traces: {
      nomination: number;
      structureId: number;
      chef: boolean;
      avant: number | null;
    }[] = [];

    await this.nominations.manager.transaction(async (m) => {
      const structures = new Map(
        (await m.find(Structure)).map((s) => [s.id, s]),
      );
      // Écoles ajoutées : une par école de la note (directeur et économe d'une même école)
      const creees = new Map<string, Structure>();
      const cibles = new Map<number, number>();
      for (const a of choix.ajouter) {
        const n = parId.get(a.id);
        const insp = structures.get(a.inspectionId);
        if (!n || n.etat !== 'INTROUVABLE' || !n.poste) {
          res.refus.push(`${a.id} : pas une école à ajouter.`);
          continue;
        }
        const cat = CATEGORIE.get(n.categorie);
        if (
          !insp ||
          insp.type !== 'INSPECTION' ||
          insp.departementId !== n.departementId ||
          !cat ||
          cat.cycle === 'ADMINISTRATION'
        ) {
          res.refus.push(
            `${n.poste} : choisissez une inspection de son département.`,
          );
          continue;
        }
        const cle = `${n.departementId}|${cat.cycle}|${cleEcole(n.poste)}`;
        let s = creees.get(cle);
        if (!s) {
          const [x] = await m.query<{ n: number }[]>(
            `SELECT coalesce(max(ordre), 0)::int AS n FROM structure WHERE "parentId" = $1`,
            [insp.id],
          );
          const nom = nomOfficiel(n.poste.trim(), cat.cycle);
          s = await m.save(Structure, {
            type: 'ETABLISSEMENT',
            nom,
            sigle: nom.slice(0, 80),
            parentId: insp.id,
            departementId: n.departementId,
            cycle: cat.cycle,
            localite: insp.localite,
            typeLocalite: insp.typeLocalite,
            anciensNoms: [],
            actif: true,
            ordre: (x?.n ?? 0) + 1,
          });
          structures.set(s.id, s);
          creees.set(cle, s);
          res.ecolesAjoutees++;
        }
        cibles.set(n.id, s.id);
      }

      const aPlacer = [...new Set([...choix.placer, ...cibles.keys()])]
        .map((id) => parId.get(id))
        .filter((n): n is NominationPlacee => !!n);
      const fiches = new Map(
        (
          await m.find(AgentRecense, {
            where: {
              id: In(
                aPlacer.map((n) => n.agentId).filter((x): x is number => !!x),
              ),
            },
          })
        ).map((a) => [a.id, a]),
      );
      for (const n of aPlacer) {
        const structureId = cibles.get(n.id) ?? n.structureId;
        const permis =
          cibles.has(n.id) || n.etat === 'A_PLACER' || n.etat === 'A_CONFIRMER';
        const s = structureId ? structures.get(structureId) : undefined;
        const a = n.agentId ? fiches.get(n.agentId) : undefined;
        if (!permis || !s || !a) {
          if (!cibles.has(n.id) || !a)
            res.refus.push(
              `${n.poste ?? n.id} : ${!a ? 'fiche du personnel non reliée' : 'à placer depuis son onglet'}.`,
            );
          continue;
        }
        // Le chef devient le responsable de la structure
        if (n.chef && s.responsableId !== a.id) {
          traces.push({
            nomination: n.id,
            structureId: s.id,
            chef: true,
            avant: s.responsableId,
          });
          s.responsableId = a.id;
          s.responsableInterim = false;
          await m.save(Structure, s);
          res.responsables++;
        }
        // La fiche suit : structure, lieu de service, fonction, département
        const donnees = { ...a.donnees };
        donnees.LIEU_SERVICE = s.nom;
        donnees.FONCTION_STRUCTURE = n.fonction;
        const dep = s.departementId ? deps.get(s.departementId) : undefined;
        if (dep && a.departementId !== dep.id) {
          a.departementId = dep.id;
          donnees.DEPARTEMENT = dep.code;
          res.changementsDepartement++;
        }
        if (
          a.structureId !== s.id ||
          a.donnees.LIEU_SERVICE !== donnees.LIEU_SERVICE ||
          a.donnees.FONCTION_STRUCTURE !== donnees.FONCTION_STRUCTURE
        ) {
          if (!n.chef)
            traces.push({
              nomination: n.id,
              structureId: s.id,
              chef: false,
              avant: a.structureId,
            });
          a.structureId = s.id;
          a.donnees = donnees;
          a.modifiePar = SOURCE;
          await m.save(AgentRecense, a);
          res.fiches++;
        }
        res.placees++;
      }
    });
    await this.journal.log(u, 'NOMINATIONS_PLACEMENT', 'nomination', null, {
      annee,
      ...res,
      refus: res.refus.length,
      traces,
    });
    return res;
  }
}
