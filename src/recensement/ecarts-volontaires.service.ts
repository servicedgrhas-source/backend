import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { enTexte, normaliser } from '../common/texte';
import { JournalService } from '../core/core.service';
import { AgentRecense, Departement, Volontaire } from '../entities';
import { ConfigRecensementService } from './configuration';
import { RecensementService } from './recensement.service';
import { estVide, lireValeur } from './valeurs';

/**
 * Écarts entre le registre des volontaires et communautaires et la base du personnel (07/11/2026).
 * Chaque personne du registre a sa fiche du personnel ; les deux peuvent ne pas dire la même chose :
 * - COMPLETER : la fiche du personnel connaît une information que le registre n'a pas ;
 * - DIFFERENT : les deux disent autre chose (on choisit laquelle garder).
 * Rien n'est changé sans un choix : « prendre la valeur de la fiche du personnel » (le registre
 * change) ou « garder celle du registre » (la fiche du personnel change, et suit de nouveau le registre).
 */

interface Correspondance {
  cle: keyof Volontaire;
  rubrique: string;
  libelle: string;
  genre: 'TEXTE' | 'DATE' | 'TELEPHONE' | 'SEXE' | 'DEPARTEMENT' | 'LISTE';
}

export const CORRESPONDANCES: Correspondance[] = [
  {
    cle: 'dateNaissance',
    rubrique: 'DATE_NAISSANCE',
    libelle: 'Date de naissance',
    genre: 'DATE',
  },
  {
    cle: 'lieuNaissance',
    rubrique: 'LIEU_NAISSANCE',
    libelle: 'Lieu de naissance',
    genre: 'TEXTE',
  },
  { cle: 'genre', rubrique: 'GENRE', libelle: 'Sexe', genre: 'SEXE' },
  {
    cle: 'telephone',
    rubrique: 'TELEPHONE_1',
    libelle: 'Téléphone',
    genre: 'TELEPHONE',
  },
  {
    cle: 'departementId',
    rubrique: 'DEPARTEMENT',
    libelle: 'Département',
    genre: 'DEPARTEMENT',
  },
  {
    cle: 'etablissement',
    rubrique: 'LIEU_SERVICE',
    libelle: 'Établissement (lieu de service)',
    genre: 'TEXTE',
  },
  {
    cle: 'diplome',
    rubrique: 'DIPLOME_PRO',
    libelle: 'Diplôme',
    genre: 'LISTE',
  },
  {
    cle: 'specialite',
    rubrique: 'SPECIALITE',
    libelle: 'Spécialité',
    genre: 'TEXTE',
  },
  {
    cle: 'datePriseService',
    rubrique: 'DATE_PRISE_SERVICE',
    libelle: 'Date de prise de service',
    genre: 'DATE',
  },
];

type TypeEcart = 'COMPLETER' | 'DIFFERENT';

interface Paire {
  v: Volontaire;
  agentId: number;
  numeroFiche: string | null;
  donnees: Record<string, unknown>;
  agentDep: number | null;
}

@Injectable()
export class EcartsVolontairesService {
  constructor(
    @InjectRepository(Volontaire)
    private readonly volontaires: Repository<Volontaire>,
    @InjectRepository(AgentRecense)
    private readonly agents: Repository<AgentRecense>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    private readonly config: ConfigRecensementService,
    private readonly rec: RecensementService,
    private readonly journal: JournalService,
  ) {}

  private correspondance(cle: string) {
    const c = CORRESPONDANCES.find((x) => x.cle === cle);
    if (!c) throw new BadRequestException('Rubrique inconnue.');
    return c;
  }

  private async paires(population: string): Promise<Paire[]> {
    const lignes = await this.volontaires.query<
      (Volontaire & {
        agentId: number;
        numeroFiche: string | null;
        donnees: Record<string, unknown>;
        agentDep: number | null;
      })[]
    >(
      `SELECT v.*, v."dateNaissance"::text AS "dateNaissance", v."datePriseService"::text AS "datePriseService",
              a.id AS "agentId", a."numeroFiche", a.donnees, a."departementId" AS "agentDep"
         FROM volontaire v JOIN agent_recense a ON a."volontaireId" = v.id
        WHERE v.population = $1 ORDER BY v."nomNormalise"`,
      [population === 'COMMUNAUTAIRE' ? 'COMMUNAUTAIRE' : 'VOLONTAIRE'],
    );
    return lignes.map((l) => ({
      v: l,
      agentId: l.agentId,
      numeroFiche: l.numeroFiche,
      donnees: l.donnees ?? {},
      agentDep: l.agentDep,
    }));
  }

  /** Les deux valeurs d'une rubrique, lisibles (« Féminin », « Bouenza », « 12/03/1994 »). */
  private valeurs(c: Correspondance, p: Paire, nomsDeps: Map<number, string>) {
    const champ = this.config.get().champs.find((x) => x.code === c.rubrique);
    const dateFr = (x: unknown) => {
      const t = enTexte(x).slice(0, 10);
      return /^\d{4}-\d{2}-\d{2}$/.test(t)
        ? t.split('-').reverse().join('/')
        : t;
    };
    const brutR = p.v[c.cle];
    const brutP =
      c.genre === 'DEPARTEMENT' ? p.agentDep : p.donnees[c.rubrique];
    const lisible = (x: unknown, cote: 'R' | 'P') => {
      if (estVide(x)) return null;
      if (c.genre === 'DATE') return dateFr(x);
      if (c.genre === 'DEPARTEMENT')
        return nomsDeps.get(Number(x)) ?? String(x);
      if (c.genre === 'SEXE') {
        const t = normaliser(enTexte(x));
        return t.startsWith('F')
          ? 'Féminin'
          : t.startsWith('M') || t.startsWith('H')
            ? 'Masculin'
            : enTexte(x);
      }
      if (c.genre === 'LISTE' && cote === 'P' && champ)
        return champ.options.find((o) => o.code === x)?.libelle ?? enTexte(x);
      return enTexte(x).replace(/\s+/g, ' ').trim();
    };
    return {
      registre: lisible(brutR, 'R'),
      personnel: lisible(brutP, 'P'),
      brutR,
      brutP,
    };
  }

  private pareil(c: Correspondance, a: string, b: string) {
    // « 66864252 » = « 06 686 42 52 » : le 0 du début se perd dans Excel
    if (c.genre === 'TELEPHONE')
      return a.replace(/\D/g, '').slice(-8) === b.replace(/\D/g, '').slice(-8);
    return (
      normaliser(a).replace(/[^A-Z0-9]/g, '') ===
      normaliser(b).replace(/[^A-Z0-9]/g, '')
    );
  }

  private typeDe(
    c: Correspondance,
    p: Paire,
    nomsDeps: Map<number, string>,
  ): TypeEcart | null {
    const x = this.valeurs(c, p, nomsDeps);
    if (!x.personnel) return null;
    if (!x.registre) return 'COMPLETER';
    // Une liste (diplôme) : le texte du registre (« BAC A4 ») lu comme la fiche le lirait
    if (c.genre === 'LISTE') {
      const champ = this.config.get().champs.find((y) => y.code === c.rubrique);
      const lu = champ ? lireValeur(champ, x.brutR) : null;
      if (lu && !lu.erreur && lu.valeur === x.brutP) return null;
    }
    return this.pareil(c, x.registre, x.personnel) ? null : 'DIFFERENT';
  }

  private async nomsDeps() {
    return new Map((await this.deps.find()).map((d) => [d.id, d.nom] as const));
  }

  /** Le bilan : pour chaque rubrique, combien à compléter et combien de valeurs différentes. */
  async bilan(population: string) {
    const paires = await this.paires(population);
    const nomsDeps = await this.nomsDeps();
    return {
      reliees: paires.length,
      rubriques: CORRESPONDANCES.map((c) => {
        let completer = 0;
        let different = 0;
        for (const p of paires) {
          const t = this.typeDe(c, p, nomsDeps);
          if (t === 'COMPLETER') completer++;
          else if (t === 'DIFFERENT') different++;
        }
        return { cle: c.cle, libelle: c.libelle, completer, different };
      }),
    };
  }

  /** Les personnes d'un écart (une rubrique, un type), page par page, avec les deux valeurs. */
  async liste(
    population: string,
    cle: string,
    type: TypeEcart,
    page = 1,
    recherche = '',
  ) {
    const c = this.correspondance(cle);
    const nomsDeps = await this.nomsDeps();
    const r = normaliser(recherche);
    const toutes = (await this.paires(population)).filter(
      (p) =>
        this.typeDe(c, p, nomsDeps) === type &&
        (!r || p.v.nomNormalise.includes(r)),
    );
    const parPage = 50;
    return {
      total: toutes.length,
      page,
      pages: Math.max(1, Math.ceil(toutes.length / parPage)),
      lignes: toutes.slice((page - 1) * parPage, page * parPage).map((p) => {
        const x = this.valeurs(c, p, nomsDeps);
        return {
          volontaireId: p.v.id,
          agentId: p.agentId,
          numeroFiche: p.numeroFiche,
          nom: p.v.nomComplet,
          registre: x.registre,
          personnel: x.personnel,
        };
      }),
    };
  }

  /**
   * Appliquer un choix : PERSONNEL (le registre prend la valeur de la fiche du personnel) ou
   * REGISTRE (la fiche du personnel reprend la valeur du registre et le suit de nouveau). Pour les
   * personnes données, ou toutes celles de cet écart.
   */
  async appliquer(
    u: UtilisateurConnecte,
    o: {
      population: string;
      cle: string;
      type: TypeEcart;
      choix: 'PERSONNEL' | 'REGISTRE';
      ids?: string[];
    },
  ) {
    const c = this.correspondance(o.cle);
    if (o.choix !== 'PERSONNEL' && o.choix !== 'REGISTRE')
      throw new BadRequestException('Choisissez la valeur à garder.');
    if (o.type === 'COMPLETER' && o.choix === 'REGISTRE')
      throw new BadRequestException(
        'Le registre n’a pas cette information : on ne peut que la prendre de la fiche du personnel.',
      );
    const nomsDeps = await this.nomsDeps();
    const ids = o.ids?.length ? new Set(o.ids) : null;
    const cibles = (await this.paires(o.population)).filter(
      (p) =>
        (!ids || ids.has(p.v.id)) && this.typeDe(c, p, nomsDeps) === o.type,
    );
    if (!cibles.length) return { modifiees: 0 };
    if (o.choix === 'PERSONNEL') {
      // Le registre prend la valeur de la fiche (au format du registre)
      for (const p of cibles) {
        const x = this.valeurs(c, p, nomsDeps);
        let valeur: unknown = x.personnel;
        const champs: Partial<Volontaire> = {};
        if (c.genre === 'DATE') valeur = enTexte(x.brutP).slice(0, 10);
        else if (c.genre === 'SEXE')
          valeur = x.personnel === 'Féminin' ? 'F' : 'M';
        else if (c.genre === 'DEPARTEMENT') {
          valeur = p.agentDep;
          champs.departementBrut = x.personnel;
        }
        (champs as Record<string, unknown>)[c.cle] = valeur;
        await this.volontaires.update(p.v.id, champs);
      }
    } else {
      // La fiche du personnel reprend la valeur du registre, et la suit de nouveau
      const champ = this.config.get().champs.find((x) => x.code === c.rubrique);
      if (!champ)
        throw new BadRequestException(
          'Rubrique absente de la fiche du personnel.',
        );
      const fiches = await this.agents.find({
        where: { id: In(cibles.map((p) => p.agentId)) },
      });
      const parId = new Map(fiches.map((a) => [a.id, a] as const));
      const nomsCodes = new Map(
        (await this.deps.find()).map((d) => [d.id, d.code] as const),
      );
      const fournies = await this.rec.piecesFournies(fiches.map((a) => a.id));
      const aSauver: AgentRecense[] = [];
      for (const p of cibles) {
        const a = parId.get(p.agentId);
        if (!a) continue;
        const brut =
          c.genre === 'DEPARTEMENT'
            ? nomsCodes.get(Number(p.v.departementId))
            : p.v[c.cle];
        const lu = lireValeur(champ, brut);
        if (lu.erreur || estVide(lu.valeur)) continue;
        const d = { ...(a.donnees ?? {}), [c.rubrique]: lu.valeur };
        const lien = {
          ...((a.liaison?.volontaire as Record<string, unknown>) ?? {}),
          [c.rubrique]: lu.valeur,
        };
        Object.assign(a, await this.rec.colonnes(d), {
          donnees: d,
          liaison: { ...(a.liaison ?? {}), volontaire: lien },
          modifiePar: u.nom,
        });
        this.rec.appliquerEvaluation(a, fournies.get(a.id) ?? {});
        aSauver.push(a);
      }
      for (let i = 0; i < aSauver.length; i += 500)
        await this.agents.save(aSauver.slice(i, i + 500));
    }
    await this.journal.log(u, 'ECARTS_REGISTRE_PERSONNEL', 'volontaire', null, {
      rubrique: c.libelle,
      type: o.type,
      choix: o.choix,
      personnes: cibles.length,
    });
    return { modifiees: cibles.length };
  }
}
