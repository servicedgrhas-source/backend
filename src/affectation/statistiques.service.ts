import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { codeCycle, CYCLES, LIBELLE_CYCLE } from '../common/referentiels';
import { Agent, Departement } from '../entities';
import { ControleAffectationsService } from './controle.service';

interface Ligne {
  id: string;
  feuille: string;
  quota: number | null;
  transmis: boolean;
  recu: boolean;
  type: string | null;
  cycleBrut: string | null;
  dep: number | null;
  statut: string | null;
}

interface Compte {
  envoyes: number | null;
  recus: number;
  arretes: number;
  decretsPM: number;
  decretsPR: number;
  resteARecevoir: number | null;
  affectes: number;
  dontHorsSysteme: number;
  resteAAffecter: number;
}

/**
 * Statistiques de suivi tenues jusque-là à la main par le chef de service : par quota
 * (envoyés, textes reçus, affectés, restes), textes reçus par cycle et par département.
 */
@Injectable()
export class StatistiquesService {
  constructor(
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    private readonly controle: ControleAffectationsService,
  ) {}

  async recrutement() {
    const lignes = await this.agents.query<Ligne[]>(`
      SELECT a.id, a.feuille, a.quota,
             a."transmissionNumero" IS NOT NULL AS transmis,
             a."lotPublicationId" IS NOT NULL AS recu,
             l."typeTexte" AS type, a."cycleBrut",
             coalesce(f."departementId", a."departementId") AS dep, f.statut
        FROM agent a
        LEFT JOIN lot_publication l ON l.id = a."lotPublicationId"
        LEFT JOIN affectation f ON f."agentId" = a.id
       WHERE a.feuille = 'QUOTA_AUTRES' OR a.quota IS NOT NULL`);
    const horsSysteme = await this.controle.agentsAvecReference();
    const groupe = (l: Ligne) =>
      l.feuille === 'QUOTA_AUTRES' ? 'AUTRES' : String(l.quota);
    const groupes = [
      ...[
        ...new Set(
          lignes.filter((l) => l.feuille !== 'QUOTA_AUTRES').map(groupe),
        ),
      ].sort(),
      ...(lignes.some((l) => l.feuille === 'QUOTA_AUTRES') ? ['AUTRES'] : []),
    ];
    const affecte = (l: Ligne) =>
      l.statut === 'AFFECTE' || horsSysteme.has(l.id);

    const parQuota = groupes.map((g) => {
      const ls = lignes.filter((l) => groupe(l) === g);
      const recus = ls.filter((l) => l.recu);
      const autres = g === 'AUTRES';
      const envoyes = autres ? null : ls.filter((l) => l.transmis).length;
      const affectes = recus.filter(affecte).length;
      const c: Compte = {
        // Le quota « Autres » n'a pas été envoyé par nous : ce sont des textes reçus de la FP
        envoyes,
        recus: recus.length,
        arretes: recus.filter((l) => l.type === 'ARRETE').length,
        decretsPM: recus.filter((l) => l.type === 'DECRET_PM').length,
        decretsPR: recus.filter((l) => l.type === 'DECRET_PR').length,
        resteARecevoir:
          envoyes === null
            ? null
            : Math.max(0, envoyes - recus.filter((l) => l.transmis).length),
        affectes,
        dontHorsSysteme: recus.filter(
          (l) => l.statut !== 'AFFECTE' && horsSysteme.has(l.id),
        ).length,
        resteAAffecter: recus.length - affectes,
      };
      return {
        groupe: g,
        libelle: autres ? 'Quota « Autres »' : `Quota ${g}`,
        ...c,
      };
    });
    const somme = (k: keyof Compte) =>
      parQuota.reduce((n, q) => n + (q[k] ?? 0), 0);
    const total = {
      envoyes: somme('envoyes'),
      recus: somme('recus'),
      arretes: somme('arretes'),
      decretsPM: somme('decretsPM'),
      decretsPR: somme('decretsPR'),
      resteARecevoir: somme('resteARecevoir'),
      affectes: somme('affectes'),
      dontHorsSysteme: somme('dontHorsSysteme'),
      resteAAffecter: somme('resteAAffecter'),
    };

    // Textes reçus par cycle : le cycle écrit dans la base (« Non renseigné » s'il manque)
    const cycles = [
      ...CYCLES.map((c) => ({ code: c, libelle: LIBELLE_CYCLE[c] })),
      { code: 'VIDE', libelle: 'Non renseigné' },
    ];
    const cycleDe = (l: Ligne) => codeCycle(l.cycleBrut) ?? 'VIDE';
    const parCycle = groupes.map((g) => {
      const recus = lignes.filter((l) => groupe(l) === g && l.recu);
      return {
        groupe: g,
        valeurs: Object.fromEntries(
          cycles.map((c) => [
            c.code,
            recus.filter((l) => cycleDe(l) === c.code).length,
          ]),
        ),
        total: recus.length,
      };
    });

    // Textes reçus par département (département d'affectation retenu)
    const deps = await this.deps.find({ order: { ordre: 'ASC' } });
    const colonnes = [
      ...deps.map((d) => ({ id: d.id, nom: d.nom })),
      { id: null, nom: 'Sans département' },
    ];
    const parDepartement = groupes.map((g) => {
      const recus = lignes.filter((l) => groupe(l) === g && l.recu);
      return {
        groupe: g,
        valeurs: colonnes.map(
          (c) => recus.filter((l) => (l.dep ?? null) === c.id).length,
        ),
        total: recus.length,
      };
    });

    return {
      groupes: groupes.map((g) => ({
        code: g,
        libelle: g === 'AUTRES' ? 'Quota « Autres »' : `Quota ${g}`,
      })),
      parQuota,
      total,
      cycles,
      parCycle,
      departements: colonnes.map((c) => c.nom),
      parDepartement,
    };
  }
}
