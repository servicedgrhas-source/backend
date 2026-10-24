import { motsDuNom, ressemblance } from './ressemblance';

/**
 * Index de noms pour comparer vite des milliers de personnes : on ne compare deux noms
 * que s'ils partagent au moins un mot (de 4 lettres ou plus).
 */
export class IndexNoms<T> {
  private readonly parMot = new Map<
    string,
    { mots: string[]; naissance: string | null; item: T }[]
  >();

  ajouter(nom: string, naissance: string | null, item: T) {
    const mots = motsDuNom(nom);
    const e = { mots, naissance, item };
    for (const m of new Set(mots.filter((x) => x.length >= 4))) {
      const liste = this.parMot.get(m);
      if (liste) liste.push(e);
      else this.parMot.set(m, [e]);
    }
  }

  /** Personnes très probablement identiques (même nom au mot près, ou même date et un nom commun). */
  probables(nom: string, naissance: string | null): T[] {
    const mots = motsDuNom(nom);
    const vus = new Set<T>();
    const res: T[] = [];
    for (const m of new Set(mots.filter((x) => x.length >= 4)))
      for (const e of this.parMot.get(m) ?? [])
        if (!vus.has(e.item)) {
          vus.add(e.item);
          if (ressemblance(mots, naissance, e.mots, e.naissance) === 'PROBABLE')
            res.push(e.item);
        }
    return res;
  }
}
