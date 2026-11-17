import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CalculMemorise } from '../common/calcul-memorise';
import { IndexNoms } from '../common/index-noms';
import { normaliser } from '../common/texte';
import { ConfigEnrolementService } from '../enrolement/configuration';
import { EffectifsEcolesService } from '../enrolement/effectifs-ecoles.service';

/**
 * Centre de contrôle des effectifs (DG, 16/11/2026) : chaque fiche de la base du personnel est
 * rangée dans une seule catégorie qui la justifie (fonctionnaire payé, en attente de matricule,
 * volontaire payé en bourse, sorti de la bourse, sans lien avec le registre…), pour pouvoir dire à
 * tout moment « tant sont ceci, tant sont cela » et répondre à n'importe quelle question.
 * Lecture seule : le traitement se fait dans la liste des agents (filtre « effectif »).
 */

export type CodeEffectif =
  | 'FC_PAYE_STRUCTURE'
  | 'FC_PAYE_SANS_STRUCTURE'
  | 'FC_ATTENTE_MATRICULE'
  | 'VC_EN_POSTE'
  | 'VC_SORTI'
  | 'VC_STATUT_DIFFERENT'
  | 'VC_SANS_LIEN_DOUBLON'
  | 'VC_SANS_LIEN_PROCHE'
  | 'VC_SANS_LIEN_ABSENT'
  | 'AJOUT_EN_ATTENTE'
  | 'AUTRE';

type Ton = 'vert' | 'bleu' | 'jaune' | 'rouge' | 'gris';

export const CATEGORIES_EFFECTIFS: Record<
  CodeEffectif,
  {
    groupe: 'FC' | 'VC' | 'AUTRE';
    libelle: string;
    explication: string;
    ton: Ton;
    aTraiter: boolean;
  }
> = {
  FC_PAYE_STRUCTURE: {
    groupe: 'FC',
    libelle: 'Payés (matricule solde), structure connue',
    explication:
      'Fonctionnaires et contractuels qui ont un matricule solde (la Solde leur paie un salaire) et dont la fiche dit où ils travaillent.',
    ton: 'vert',
    aTraiter: false,
  },
  FC_PAYE_SANS_STRUCTURE: {
    groupe: 'FC',
    libelle: 'Payés (matricule solde), structure à compléter',
    explication:
      'Ils ont un matricule solde, mais leur fiche ne dit pas dans quelle structure (école, inspection, direction…) ils travaillent : à compléter dans la fiche.',
    ton: 'jaune',
    aTraiter: true,
  },
  FC_ATTENTE_MATRICULE: {
    groupe: 'FC',
    libelle: 'En attente de matricule solde',
    explication:
      'Fonctionnaires ou contractuels sans matricule solde : recrutés, mais leur salaire n’est pas encore confirmé par la Solde (souvent d’anciens volontaires sortis « recrutés »).',
    ton: 'jaune',
    aTraiter: true,
  },
  VC_EN_POSTE: {
    groupe: 'VC',
    libelle: 'Payés en bourse (en poste dans le registre)',
    explication:
      'Volontaires et communautaires reliés au registre de la bourse, encore en poste : ils sont payés chaque mois en bourse.',
    ton: 'vert',
    aTraiter: false,
  },
  VC_SORTI: {
    groupe: 'VC',
    libelle: 'Sortis de la bourse',
    explication:
      'Reliés au registre, mais sortis de la bourse (désertion, retrait par la DDEPPSA, doublon…) : ils ne sont plus payés. Leur fiche reste pour l’historique.',
    ton: 'gris',
    aTraiter: false,
  },
  VC_STATUT_DIFFERENT: {
    groupe: 'VC',
    libelle: 'Statut différent du registre',
    explication:
      'La fiche dit « volontaire » et le registre « communautaire », ou l’inverse : l’un des deux est faux, à corriger dans la fiche.',
    ton: 'rouge',
    aTraiter: true,
  },
  VC_SANS_LIEN_DOUBLON: {
    groupe: 'VC',
    libelle: 'Sans lien : probablement en double',
    explication:
      'Fiche importée sans lien avec le registre, au même nom qu’une personne du registre qui a déjà sa fiche : très probablement la même personne en deux fiches (à fusionner).',
    ton: 'rouge',
    aTraiter: true,
  },
  VC_SANS_LIEN_PROCHE: {
    groupe: 'VC',
    libelle: 'Sans lien : nom proche d’une personne du registre',
    explication:
      'Fiche sans lien avec le registre, au nom proche d’une personne du registre (écrit autrement) : peut-être la même personne, à vérifier.',
    ton: 'jaune',
    aTraiter: true,
  },
  VC_SANS_LIEN_ABSENT: {
    groupe: 'VC',
    libelle: 'Sans lien : absents du registre de la bourse',
    explication:
      'Volontaires ou communautaires de la base du personnel qui ne sont pas dans le registre de la bourse : ils ne sont pas payés en bourse. Retirés des listes, ou jamais inscrits ? À vérifier.',
    ton: 'jaune',
    aTraiter: true,
  },
  AJOUT_EN_ATTENTE: {
    groupe: 'AUTRE',
    libelle: 'Ajoutés au recensement, en attente de décision',
    explication:
      'Agents rencontrés au recensement mais absents des bases : à contrôler par la DGRHAS, puis décision du DG.',
    ton: 'bleu',
    aTraiter: true,
  },
  AUTRE: {
    groupe: 'AUTRE',
    libelle: 'Autres statuts',
    explication:
      'Fiches dont le statut n’est dans aucune des catégories ci-dessus.',
    ton: 'gris',
    aTraiter: true,
  },
};

/**
 * Les points à corriger sur les fiches, en plus des catégories (une fiche peut y être en plus de sa
 * catégorie) : filtre « effectif » de la liste des agents comme les catégories.
 */
export const POINTS_A_CORRIGER = {
  DEPARTEMENT_NOUVELLE_DEPPSA: {
    libelle: 'Département à mettre à jour : école dans une nouvelle DEPPSA',
    explication:
      'Fonctionnaires et contractuels dont la fiche porte encore l’ancien département (par exemple Plateaux), alors que leur école n’existe que dans une nouvelle DEPPSA (Congo-Oubangui, Djoué-Léfini, Nkéni-Alima), d’après l’organigramme et le registre. À vérifier, puis à passer dans la nouvelle DEPPSA.',
  },
} as const;

const GROUPES = {
  FC: 'Fonctionnaires et contractuels',
  VC: 'Volontaires et communautaires',
  AUTRE: 'Autres fiches',
};

const STATUTS = ['FONCTIONNAIRE', 'CONTRACTUEL', 'VOLONTAIRE', 'COMMUNAUTAIRE'];

const cle = (n: string) =>
  normaliser(n)
    .replace(/[^A-Z ]/g, ' ')
    .split(' ')
    .filter(Boolean)
    .sort()
    .join(' ');

interface Fiche {
  id: number;
  statut: string;
  departementId: number | null;
  code: CodeEffectif;
  /** Le registre : la personne reliée, ou la plus proche (fiches sans lien). */
  registre: {
    nom: string;
    population: string;
    statut: string;
    motif: string | null;
  } | null;
}

@Injectable()
export class ControleEffectifsService {
  private readonly memoire: CalculMemorise<{
    fiches: Fiche[];
    noms: Map<number, { nom: string; lieu: string | null }>;
  }>;

  constructor(
    private readonly ds: DataSource,
    private readonly config: ConfigEnrolementService,
    private readonly ecoles: EffectifsEcolesService,
  ) {
    this.memoire = new CalculMemorise(
      ds,
      ['agent_recense', 'volontaire', 'structure'],
      () => this.calculer(),
      'Centre de contrôle des effectifs',
    );
    this.memoire.prechauffer(60_000);
  }

  private async calculer() {
    const agents = await this.ds.query<
      {
        id: number;
        statut: string;
        nom: string;
        naissance: string | null;
        matricule: string | null;
        structure: boolean;
        departementId: number | null;
        volontaireId: string | null;
        contentieux: string | null;
        lieu: string | null;
      }[]
    >(
      `SELECT a.id, a.statut, a."nomComplet" AS nom, to_char(a."dateNaissance", 'YYYY-MM-DD') AS naissance,
              coalesce(nullif(trim(a.matricule), ''), nullif(trim(a.donnees->>'MATRICULE_SOLDE'), '')) AS matricule,
              (a."structureId" IS NOT NULL OR nullif(trim(a.donnees->>'LIEU_SERVICE'), '') IS NOT NULL) AS structure,
              a."departementId", a."volontaireId", a.contentieux->>'etat' AS contentieux,
              coalesce(s.nom, nullif(trim(a.donnees->>'LIEU_SERVICE'), '')) AS lieu
         FROM agent_recense a LEFT JOIN structure s ON s.id = a."structureId"`,
    );
    const registre = await this.ds.query<
      {
        id: string;
        nom: string;
        naissance: string | null;
        population: string;
        statut: string;
        motif: string | null;
      }[]
    >(
      `SELECT id, "nomComplet" AS nom, to_char("dateNaissance", 'YYYY-MM-DD') AS naissance,
              population, statut, "motifSortie" AS motif FROM volontaire`,
    );
    const parId = new Map(registre.map((r) => [r.id, r]));
    const relies = new Set(
      agents.filter((a) => a.volontaireId).map((a) => a.volontaireId),
    );
    const parCle = new Map<string, typeof registre>();
    for (const r of registre) {
      const k = cle(r.nom);
      const l = parCle.get(k);
      if (l) l.push(r);
      else parCle.set(k, [r]);
    }
    const index = new IndexNoms<(typeof registre)[number]>();
    for (const r of registre) index.ajouter(r.nom, r.naissance, r);
    const vue = (r: (typeof registre)[number] | undefined) =>
      r
        ? {
            nom: r.nom,
            population: r.population,
            statut: r.statut,
            motif: r.motif,
          }
        : null;

    const fiches: Fiche[] = [];
    const noms = new Map<number, { nom: string; lieu: string | null }>();
    for (const a of agents) {
      noms.set(a.id, { nom: a.nom, lieu: a.lieu });
      let code: CodeEffectif;
      let reg: Fiche['registre'] = null;
      if (a.contentieux && a.contentieux !== 'CONFIRME')
        code = 'AJOUT_EN_ATTENTE';
      else if (a.statut === 'FONCTIONNAIRE' || a.statut === 'CONTRACTUEL') {
        code = !a.matricule
          ? 'FC_ATTENTE_MATRICULE'
          : a.structure
            ? 'FC_PAYE_STRUCTURE'
            : 'FC_PAYE_SANS_STRUCTURE';
        reg = vue(a.volontaireId ? parId.get(a.volontaireId) : undefined);
      } else if (a.statut === 'VOLONTAIRE' || a.statut === 'COMMUNAUTAIRE') {
        const r = a.volontaireId ? parId.get(a.volontaireId) : undefined;
        if (r) {
          reg = vue(r);
          code =
            r.population !== a.statut
              ? 'VC_STATUT_DIFFERENT'
              : r.statut === 'SORTI'
                ? 'VC_SORTI'
                : 'VC_EN_POSTE';
        } else {
          // Sans lien : même nom qu'une personne du registre déjà reliée (double), nom proche, absent
          const memes = parCle.get(cle(a.nom)) ?? [];
          if (memes.length) {
            code = memes.some((m) => relies.has(m.id))
              ? 'VC_SANS_LIEN_DOUBLON'
              : 'VC_SANS_LIEN_PROCHE';
            reg = vue(memes[0]);
          } else {
            const proche = index.probables(a.nom, a.naissance)[0];
            code = proche ? 'VC_SANS_LIEN_PROCHE' : 'VC_SANS_LIEN_ABSENT';
            reg = vue(proche);
          }
        }
      } else code = 'AUTRE';
      fiches.push({
        id: a.id,
        statut: a.statut,
        departementId: a.departementId,
        code,
        registre: reg,
      });
    }
    return { fiches, noms };
  }

  /** Les ids d'une catégorie (filtre « effectif » de la liste des agents). */
  async ids(code: string) {
    if (code === 'DEPARTEMENT_NOUVELLE_DEPPSA')
      return (await this.ecoles.agentsAReclasser()).map((x) => x.agentId);
    const { donnees } = await this.memoire.lire();
    return donnees.fiches.filter((f) => f.code === code).map((f) => f.id);
  }

  /** Les fiches à passer dans leur nouvelle DEPPSA (calcul des écoles). */
  agentsAReclasser() {
    return this.ecoles.agentsAReclasser();
  }

  /** Après une correction : le calcul des écoles est refait. */
  oublierEcoles() {
    this.ecoles.oublier();
  }

  libelle(code: string) {
    return CATEGORIES_EFFECTIFS[code as CodeEffectif]?.libelle ?? null;
  }

  /** Le centre de contrôle : toutes les fiches justifiées, par catégorie et par département. */
  async tableau() {
    const r = await this.memoire.lire();
    const { fiches } = r.donnees;
    const deps = new Map(
      (
        await this.ds.query<{ id: number; nom: string; ordre: number }[]>(
          `SELECT id, nom, ordre FROM departement ORDER BY ordre`,
        )
      ).map((d) => [d.id, d]),
    );
    const parCode = new Map<CodeEffectif, Fiche[]>();
    for (const f of fiches) {
      const l = parCode.get(f.code);
      if (l) l.push(f);
      else parCode.set(f.code, [f]);
    }
    const motif = (c: string | null) =>
      c ? (this.config.motif(c)?.libelle ?? c) : 'motif non précisé';
    const groupes = (['FC', 'VC', 'AUTRE'] as const)
      .map((g) => {
        const lignes = (Object.keys(CATEGORIES_EFFECTIFS) as CodeEffectif[])
          .filter((c) => CATEGORIES_EFFECTIFS[c].groupe === g)
          .map((c) => {
            const l = parCode.get(c) ?? [];
            // Le détail qui aide à répondre : par statut, et par motif de sortie pour les sortis
            const detail = new Map<string, number>();
            for (const f of l) {
              const k =
                c === 'VC_SORTI'
                  ? motif(f.registre?.motif ?? null)
                  : f.statut === 'FONCTIONNAIRE'
                    ? 'fonctionnaires'
                    : f.statut === 'CONTRACTUEL'
                      ? 'contractuels'
                      : f.statut === 'VOLONTAIRE'
                        ? 'volontaires'
                        : f.statut === 'COMMUNAUTAIRE'
                          ? 'communautaires'
                          : f.statut.toLowerCase();
              detail.set(k, (detail.get(k) ?? 0) + 1);
            }
            return {
              code: c,
              ...CATEGORIES_EFFECTIFS[c],
              n: l.length,
              detail: [...detail.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([libelle, n]) => ({ libelle, n })),
            };
          })
          .filter((x) => x.n > 0);
        return {
          code: g,
          titre: GROUPES[g],
          n: lignes.reduce((s, x) => s + x.n, 0),
          lignes,
        };
      })
      .filter((g) => g.n > 0);
    // Par département : chaque statut, et ce qui reste à traiter
    const parDep = new Map<
      number | null,
      Record<string, number> & { total: number; aTraiter: number }
    >();
    for (const f of fiches) {
      const x = parDep.get(f.departementId) ?? { total: 0, aTraiter: 0 };
      x[f.statut] = (x[f.statut] ?? 0) + 1;
      x.total++;
      if (CATEGORIES_EFFECTIFS[f.code].aTraiter) x.aTraiter++;
      parDep.set(f.departementId, x);
    }
    return {
      total: fiches.length,
      parStatut: STATUTS.map((s) => ({
        statut: s,
        n: fiches.filter((f) => f.statut === s).length,
      })),
      aTraiter: fiches.filter((f) => CATEGORIES_EFFECTIFS[f.code].aTraiter)
        .length,
      groupes,
      aCorriger: [
        {
          code: 'DEPARTEMENT_NOUVELLE_DEPPSA',
          ...POINTS_A_CORRIGER.DEPARTEMENT_NOUVELLE_DEPPSA,
          n: (await this.ecoles.agentsAReclasser()).length,
        },
      ],
      parDepartement: [...parDep.entries()]
        .map(([id, x]) => ({
          departementId: id,
          departement: id ? (deps.get(id)?.nom ?? '?') : 'Non renseigné',
          ordre: id ? (deps.get(id)?.ordre ?? 99) : 100,
          ...x,
        }))
        .sort((a, b) => a.ordre - b.ordre),
      calculeLe: new Date(r.le).toISOString(),
      aJour: r.aJour,
    };
  }

  /**
   * Les fiches de volontaires et communautaires sans lien avec le registre, pour le suivi de
   * l'intégration (Banque mondiale) : en lecture seule, avec la personne du registre la plus proche.
   */
  async sansLien(
    cas: string | undefined,
    recherche: string | undefined,
    page = 1,
    taille = 50,
  ) {
    const { donnees } = await this.memoire.lire();
    const codes: CodeEffectif[] = [
      'VC_SANS_LIEN_DOUBLON',
      'VC_SANS_LIEN_PROCHE',
      'VC_SANS_LIEN_ABSENT',
    ];
    const deps = new Map(
      (
        await this.ds.query<{ id: number; nom: string }[]>(
          `SELECT id, nom FROM departement`,
        )
      ).map((d) => [d.id, d.nom]),
    );
    const toutes = donnees.fiches.filter((f) => codes.includes(f.code));
    const q = recherche ? normaliser(recherche) : '';
    const liste = toutes.filter(
      (f) =>
        (!cas || f.code === cas) &&
        (!q || normaliser(donnees.noms.get(f.id)?.nom ?? '').includes(q)),
    );
    const fr = new Intl.Collator('fr');
    liste.sort((a, b) =>
      fr.compare(
        donnees.noms.get(a.id)?.nom ?? '',
        donnees.noms.get(b.id)?.nom ?? '',
      ),
    );
    return {
      cas: codes.map((c) => ({
        code: c,
        libelle: CATEGORIES_EFFECTIFS[c].libelle,
        explication: CATEGORIES_EFFECTIFS[c].explication,
        n: toutes.filter((f) => f.code === c).length,
      })),
      total: liste.length,
      lignes: liste.slice((page - 1) * taille, page * taille).map((f) => ({
        id: f.id,
        nom: donnees.noms.get(f.id)?.nom ?? '',
        statut: f.statut,
        departement: f.departementId ? (deps.get(f.departementId) ?? '') : '',
        lieu: donnees.noms.get(f.id)?.lieu ?? null,
        cas: f.code,
        registre: f.registre,
      })),
    };
  }
}
