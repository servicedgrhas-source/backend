import { motsDuNom, ressemblance } from './ressemblance';

interface Entree<T> {
  mots: string[];
  naissance: string | null;
  item: T;
  /** Rang d'ajout : les résultats gardent l'ordre d'ajout. */
  rang: number;
}

/**
 * Index de noms pour comparer vite des milliers de personnes : on ne compare deux noms
 * que s'ils partagent au moins un mot (de 4 lettres ou plus).
 *
 * Deux dates de naissance connues et différentes ne sont jamais « très probablement » la même
 * personne (voir `ressemblance`) : une personne dont la date est connue n'est comparée qu'aux
 * personnes nées le même jour ou sans date. Sans cela, un nom très courant obligeait à
 * comparer chaque fiche à des milliers d'autres (30 s pour 28 000 agents).
 */
export class IndexNoms<T> {
  private readonly parMot = new Map<string, Entree<T>[]>();
  /** Par mot et date de naissance (« MOT|AAAA-MM-JJ »), et par mot pour les personnes sans date. */
  private readonly parMotEtDate = new Map<string, Entree<T>[]>();
  private readonly parMotSansDate = new Map<string, Entree<T>[]>();
  private rang = 0;

  ajouter(nom: string, naissance: string | null, item: T) {
    const mots = motsDuNom(nom);
    const e: Entree<T> = { mots, naissance, item, rang: this.rang++ };
    for (const m of new Set(mots.filter((x) => x.length >= 4))) {
      pousser(this.parMot, m, e);
      if (naissance) pousser(this.parMotEtDate, `${m}|${naissance}`, e);
      else pousser(this.parMotSansDate, m, e);
    }
  }

  /** Personnes très probablement identiques (même nom au mot près, ou même date et un nom commun). */
  probables(nom: string, naissance: string | null): T[] {
    const mots = motsDuNom(nom);
    const vus = new Set<T>();
    const res: T[] = [];
    for (const m of new Set(mots.filter((x) => x.length >= 4)))
      for (const e of naissance
        ? fusionner(
            this.parMotEtDate.get(`${m}|${naissance}`),
            this.parMotSansDate.get(m),
          )
        : (this.parMot.get(m) ?? []))
        if (!vus.has(e.item)) {
          vus.add(e.item);
          if (ressemblance(mots, naissance, e.mots, e.naissance) === 'PROBABLE')
            res.push(e.item);
        }
    return res;
  }
}

function pousser<T>(m: Map<string, Entree<T>[]>, cle: string, e: Entree<T>) {
  const liste = m.get(cle);
  if (liste) liste.push(e);
  else m.set(cle, [e]);
}

/** Deux listes rangées par ordre d'ajout, fusionnées dans cet ordre. */
function fusionner<T>(a: Entree<T>[] = [], b: Entree<T>[] = []) {
  if (!a.length) return b;
  if (!b.length) return a;
  const res: Entree<T>[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length)
    res.push(
      j >= b.length || (i < a.length && a[i].rang < b[j].rang)
        ? a[i++]
        : b[j++],
    );
  return res;
}
