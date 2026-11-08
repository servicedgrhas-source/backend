import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import ExcelJS from 'exceljs';
// JSZip vient avec exceljs (il lit et écrit les .xlsx) : pas de dépendance en plus
import JSZip from 'jszip';
import { DataSource } from 'typeorm';
import { motsDuNom, ressemblance } from '../common/ressemblance';
import { type Personne, RapprochementService } from './rapprochement.service';

/**
 * Rapprochement et détection des doublons (DG, 08/11/2026) : jusqu'à 5 fichiers Excel comparés
 * entre eux (doublons d'un même fichier, d'un fichier à l'autre) et avec toutes les bases du
 * système, SAUF la base des enrôlés. Les cas sûrs sont écartés d'office ; les cas douteux sont
 * montrés à l'agent, qui décide « même personne » ou « pas la même personne ». On télécharge
 * ensuite le fichier des doublons (avec la raison) et le fichier nettoyé (chaque personne une
 * seule fois, personne de déjà connu dans la base).
 *
 * LECTURE SEULE : aucune écriture dans la base. Rien n'est gardé sur le serveur entre l'analyse
 * et les téléchargements : les fichiers et les décisions sont renvoyés à chaque fois.
 */

/** Personne lue, avec une clé stable (même analyse, même clé) pour les décisions. */
interface Lu extends Personne {
  cleStable: string;
  /** Pour la base : son nom (« Base du personnel »…) ; null pour une ligne de fichier. */
  base: string | null;
}

/** Pourquoi un rapprochement est douteux. */
export type Doute = 'NOM_PROCHE' | 'DATE_DIFFERENTE' | 'DATE_MANQUANTE';

const LIBELLE_DOUTE: Record<Doute, string> = {
  NOM_PROCHE: 'Nom écrit autrement',
  DATE_DIFFERENTE: 'Même nom, date de naissance différente',
  DATE_MANQUANTE: 'Même nom, date de naissance absente d’un côté',
};

export interface MembreVu {
  origine: string;
  feuille: string | null;
  ligne: number | null;
  nom: string;
  naissance: string | null;
  details: string;
}

interface Options {
  avecBase: boolean;
  masquees: boolean;
  feuilles?: (string[] | null)[];
}

type Decisions = Record<string, 'MEME' | 'DIFFERENTE'>;

/** Bases comparées (jamais la base des enrôlés). */
const BASES = [
  'Base du personnel',
  'Base des recrutés',
  'Recrutés des années passées',
  'Registre des volontaires et communautaires',
  'États de la bourse',
  'Demandes de mutation et de prestation',
  'Nominations',
] as const;

const VERT = 'FF0F5132';
const plein = (argb: string): ExcelJS.Fill => ({
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb },
});
const compact = (v: string) =>
  v
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
const dateFr = (d: string | null) =>
  d ? d.slice(0, 10).split('-').reverse().join('/') : '';

@Injectable()
export class DetectionDoublonsService {
  constructor(
    private readonly rapprochement: RapprochementService,
    @InjectDataSource() private readonly db: DataSource,
  ) {}

  /* ------------------------------ Lecture ------------------------------ */

  private async lireFichiers(
    fichiers: { nom: string; contenu: Buffer }[],
    options: Options,
  ) {
    if (!fichiers.length)
      throw new BadRequestException(
        'Choisissez au moins un fichier Excel (jusqu’à 5).',
      );
    if (fichiers.length > 5)
      throw new BadRequestException('Cinq fichiers au plus à la fois.');
    const tous: Lu[] = [];
    const lus: {
      nom: string;
      feuilles: { nom: string; lignes: number }[];
      personnes: number;
    }[] = [];
    for (const [n, f] of fichiers.entries()) {
      const r = await this.rapprochement.lireFichier(
        f.contenu,
        n,
        f.nom,
        options.masquees,
        tous.length,
        options.feuilles?.[n] ?? undefined,
      );
      if (!r.personnes.length)
        throw new BadRequestException(
          `« ${f.nom} » : aucune feuille cochée avec une colonne « Noms et prénoms ». Vérifiez le fichier (ou cochez « Lire aussi les feuilles masquées »).`,
        );
      for (const p of r.personnes)
        tous.push({
          ...p,
          cleStable: `F${n}|${p.feuille}|${p.ligne}`,
          base: null,
        });
      lus.push({
        nom: f.nom,
        feuilles: r.feuilles,
        personnes: r.personnes.length,
      });
    }
    return { tous, lus };
  }

  /** Toutes les bases du système sauf celle des enrôlés : lectures seulement. */
  private async lireBases(debut: number) {
    const personnes: Lu[] = [];
    const comptes: Record<string, number> = {};
    const ajouter = (
      base: (typeof BASES)[number],
      id: string | number,
      nom: string | null,
      naissance: string | Date | null,
      details: string,
    ) => {
      if (!nom) return;
      const mots = motsDuNom(nom);
      if (mots.length < 2) return;
      comptes[base] = (comptes[base] ?? 0) + 1;
      personnes.push({
        i: debut + personnes.length,
        fichier: -1,
        origine: base,
        feuille: null,
        ligne: null,
        nom,
        mots,
        cle: [...mots].sort().join(' '),
        naissance:
          naissance instanceof Date
            ? naissance.toISOString().slice(0, 10)
            : naissance
              ? String(naissance).slice(0, 10)
              : null,
        details,
        cleStable: `B|${base}|${id}`,
        base,
      });
    };
    const q = <T>(sql: string) => this.db.query<T[]>(sql);

    for (const a of await q<{
      id: number;
      nom: string;
      naissance: string | null;
      statut: string | null;
      matricule: string | null;
      dep: string | null;
    }>(`SELECT r.id, r."nomComplet" AS nom, r."dateNaissance"::text AS naissance, r.statut,
               r.matricule, d.nom AS dep
          FROM agent_recense r LEFT JOIN departement d ON d.id = r."departementId"
         ORDER BY r.id`))
      ajouter(
        'Base du personnel',
        a.id,
        a.nom,
        a.naissance,
        [
          a.statut?.toLowerCase(),
          a.matricule && `matricule ${a.matricule}`,
          a.dep,
        ]
          .filter(Boolean)
          .join(' · '),
      );

    for (const a of await q<{
      id: number;
      nom: string;
      naissance: string | null;
      feuille: string;
      quota: number | null;
      etat: string | null;
    }>(`SELECT id, "nomComplet" AS nom, "dateNaissance"::text AS naissance, feuille, quota,
               "etatFiche" AS etat
          FROM agent ORDER BY id`))
      ajouter(
        'Base des recrutés',
        a.id,
        a.nom,
        a.naissance,
        [
          a.feuille === 'QUOTA_AUTRES'
            ? 'quota « Autres »'
            : a.quota
              ? `quota ${a.quota}`
              : 'sans quota',
          a.etat?.toLowerCase().replace('_', ' '),
        ]
          .filter(Boolean)
          .join(' · '),
      );

    for (const a of await q<{
      id: number;
      nom: string;
      naissance: string | null;
      annee: number | null;
      source: string | null;
    }>(`SELECT id, "nomComplet" AS nom, "dateNaissance"::text AS naissance, annee, source
          FROM ancien_recrute ORDER BY id`))
      ajouter(
        'Recrutés des années passées',
        a.id,
        a.nom,
        a.naissance,
        `${a.annee ? `recruté en ${a.annee}` : 'année inconnue'}${a.source ? ` · liste « ${a.source} »` : ''}`,
      );

    for (const a of await q<{
      id: number;
      nom: string;
      naissance: string | null;
      population: string | null;
      statut: string | null;
      vague: string | null;
      dep: string | null;
    }>(`SELECT v.id, v."nomComplet" AS nom, v."dateNaissance"::text AS naissance, v.population,
               v.statut, v.vague, coalesce(d.nom, v."departementBrut") AS dep
          FROM volontaire v LEFT JOIN departement d ON d.id = v."departementId"
         ORDER BY v.id`))
      ajouter(
        'Registre des volontaires et communautaires',
        a.id,
        a.nom,
        a.naissance,
        [
          a.population?.toLowerCase(),
          a.statut?.toLowerCase(),
          a.vague && `vague ${a.vague}`,
          a.dep,
        ]
          .filter(Boolean)
          .join(' · '),
      );

    // Une personne payée plusieurs mois n'est comptée qu'une fois
    for (const a of await q<{
      nom: string;
      etats: number;
      dep: string | null;
    }>(`SELECT l."nomComplet" AS nom, count(DISTINCT l."etatId")::int AS etats, max(d.nom) AS dep
          FROM ligne_bourse l LEFT JOIN departement d ON d.id = l."departementId"
         GROUP BY l."nomComplet" ORDER BY l."nomComplet"`))
      ajouter(
        'États de la bourse',
        a.nom,
        a.nom,
        null,
        [`payé sur ${a.etats} état(s)`, a.dep].filter(Boolean).join(' · '),
      );

    for (const a of await q<{
      id: string;
      nom: string;
      numero: number;
      matricule: string | null;
      motif: string | null;
    }>(`SELECT id, "nomComplet" AS nom, "numeroEnregistrement" AS numero, matricule, motif
          FROM demande_mutation WHERE NOT retiree ORDER BY "numeroEnregistrement", id`))
      ajouter(
        'Demandes de mutation et de prestation',
        a.id,
        a.nom,
        null,
        [
          `demande n° ${a.numero}`,
          a.matricule && `matricule ${a.matricule}`,
          a.motif?.toLowerCase().replaceAll('_', ' '),
        ]
          .filter(Boolean)
          .join(' · '),
      );

    for (const a of await q<{
      id: string;
      nom: string;
      annee: string | null;
      poste: string | null;
    }>(`SELECT id, "nomComplet" AS nom, annee::text AS annee, "nouveauPoste" AS poste
          FROM nomination ORDER BY id`))
      ajouter(
        'Nominations',
        a.id,
        a.nom,
        null,
        [a.annee && `nomination ${a.annee}`, a.poste]
          .filter(Boolean)
          .join(' · '),
      );

    return {
      personnes,
      bases: BASES.map((nom) => ({ nom, personnes: comptes[nom] ?? 0 })),
    };
  }

  /* ------------------------------ Analyse ------------------------------ */

  /**
   * Personnes sûrement identiques (réunies d'office) et rapprochements douteux (à trancher).
   * Sûr : même nom (mots dans n'importe quel ordre) et, avec la base, même date de naissance ;
   * d'un fichier à l'autre, même nom sans dates contradictoires.
   */
  private async analyser(
    fichiers: { nom: string; contenu: Buffer }[],
    options: Options,
  ) {
    const { tous, lus } = await this.lireFichiers(fichiers, options);
    let bases: { nom: string; personnes: number }[] = [];
    if (options.avecBase) {
      const b = await this.lireBases(tous.length);
      tous.push(...b.personnes);
      bases = b.bases;
    }
    const N = tous.length;

    // Paires candidates : toujours au moins une ligne de fichier (la base n'est pas comparée à elle-même)
    const paires = new Set<number>();
    const ajouterPaires = (ids: number[], plafond: number) => {
      const f = ids.filter((i) => tous[i].fichier >= 0);
      if (!f.length || ids.length > plafond) return;
      for (const a of f)
        for (const b of ids) {
          if (a === b || (tous[b].fichier >= 0 && b < a)) continue;
          paires.add(Math.min(a, b) * N + Math.max(a, b));
        }
    };
    const parCle = new Map<string, number[]>();
    const parMot = new Map<string, number[]>();
    for (const p of tous) {
      const c = parCle.get(p.cle);
      if (c) c.push(p.i);
      else parCle.set(p.cle, [p.i]);
      for (const m of new Set(p.mots)) {
        if (m.length < 4) continue;
        const l = parMot.get(m);
        if (l) l.push(p.i);
        else parMot.set(m, [p.i]);
      }
    }
    for (const ids of parCle.values()) ajouterPaires(ids, Infinity);
    // Un mot peu courant en commun : fautes de frappe, prénom en plus ou en moins
    for (const ids of parMot.values()) ajouterPaires(ids, 300);

    // 1. Liens sûrs : réunis d'office
    const parent = tous.map((p) => p.i);
    const racine = (i: number): number => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]];
      return i;
    };
    const douteux: [number, number, Doute][] = [];
    for (const k of paires) {
      const a = Math.floor(k / N),
        b = k % N;
      const pa = tous[a],
        pb = tous[b];
      const avecBase = pa.fichier === -1 || pb.fichier === -1;
      const deuxDates = !!pa.naissance && !!pb.naissance;
      if (pa.cle === pb.cle) {
        if (deuxDates && pa.naissance !== pb.naissance)
          douteux.push([a, b, 'DATE_DIFFERENTE']);
        else if (avecBase && !deuxDates) douteux.push([a, b, 'DATE_MANQUANTE']);
        else parent[racine(a)] = racine(b);
      } else if (
        ressemblance(pa.mots, pa.naissance, pb.mots, pb.naissance) ===
        'PROBABLE'
      )
        douteux.push([a, b, 'NOM_PROCHE']);
    }

    // Groupes sûrs : clé stable = la plus petite clé de ses membres
    const membresDe = new Map<number, number[]>();
    for (const p of tous) {
      const r = racine(p.i);
      const l = membresDe.get(r);
      if (l) l.push(p.i);
      else membresDe.set(r, [p.i]);
    }
    const cleGroupe = new Map<number, string>();
    for (const [r, ids] of membresDe)
      cleGroupe.set(r, ids.map((i) => tous[i].cleStable).sort()[0]);

    // 2. Liens douteux entre deux groupes sûrs : une décision par couple de groupes
    const PRIORITE: Record<Doute, number> = {
      NOM_PROCHE: 1,
      DATE_MANQUANTE: 2,
      DATE_DIFFERENTE: 3,
    };
    const aTrancher = new Map<
      string,
      {
        id: string;
        ra: number;
        rb: number;
        doute: Doute;
        /** Nom écrit autrement mais même date de naissance : « même personne » est proposé. */
        memeNaissance: boolean;
      }
    >();
    for (const [a, b, doute] of douteux) {
      let ra = racine(a),
        rb = racine(b);
      if (ra === rb) continue;
      if (cleGroupe.get(ra)! > cleGroupe.get(rb)!) [ra, rb] = [rb, ra];
      const id = `${cleGroupe.get(ra)}~${cleGroupe.get(rb)}`;
      const avant = aTrancher.get(id);
      const memeNaissance =
        doute === 'NOM_PROCHE' &&
        !!tous[a].naissance &&
        tous[a].naissance === tous[b].naissance;
      // Un nom proche l'emporte sur une date différente (le doute le plus fort est montré)
      if (!avant || PRIORITE[doute] < PRIORITE[avant.doute])
        aTrancher.set(id, {
          id,
          ra,
          rb,
          doute,
          memeNaissance: memeNaissance || !!avant?.memeNaissance,
        });
      else if (memeNaissance) avant.memeNaissance = true;
    }
    return { tous, lus, bases, racine, membresDe, aTrancher, options };
  }

  private vu(p: Lu): MembreVu {
    return {
      origine: p.origine,
      feuille: p.feuille,
      ligne: p.ligne,
      nom: p.nom,
      naissance: p.naissance,
      details: p.details,
    };
  }

  private trier = (a: Lu, b: Lu) =>
    (a.fichier === -1 ? 99 : a.fichier) - (b.fichier === -1 ? 99 : b.fichier) ||
    (a.feuille ?? '').localeCompare(b.feuille ?? '') ||
    (a.ligne ?? 0) - (b.ligne ?? 0) ||
    a.origine.localeCompare(b.origine);

  /**
   * Avec les décisions : chaque ligne des fichiers est gardée (une seule fois par personne, la plus
   * complète) ou écartée, avec sa raison. Une personne déjà dans une base est toujours écartée.
   */
  private trancher(
    a: Awaited<ReturnType<DetectionDoublonsService['analyser']>>,
    decisions: Decisions,
  ) {
    const { tous, racine, membresDe, aTrancher } = a;
    const parent = new Map<number, number>();
    const chef = (r: number): number => {
      let x = r;
      while (parent.has(x) && parent.get(x) !== x) x = parent.get(x)!;
      return x;
    };
    const lienDecide: { id: string; decision: 'MEME' | 'DIFFERENTE' }[] = [];
    for (const t of aTrancher.values()) {
      const d =
        decisions[t.id] ??
        (t.doute === 'DATE_DIFFERENTE' ? 'DIFFERENTE' : undefined);
      if (!d) continue;
      lienDecide.push({ id: t.id, decision: d });
      if (d === 'MEME') {
        const x = chef(t.ra),
          y = chef(t.rb);
        if (x !== y) parent.set(x, y);
      }
    }
    // Groupes finals : seulement ceux qui touchent les fichiers (les dizaines de milliers de
    // personnes des bases qui ne ressemblent à personne n'y entrent pas : mémoire du serveur)
    const utiles = new Set<number>();
    for (const [r, ids] of membresDe)
      if (ids.some((i) => tous[i].fichier >= 0)) utiles.add(chef(r));
    const groupes = new Map<number, Lu[]>();
    for (const [r, ids] of membresDe) {
      const c = chef(r);
      if (!utiles.has(c)) continue;
      const l = groupes.get(c) ?? [];
      l.push(...ids.map((i) => tous[i]));
      groupes.set(c, l);
    }
    const garde = new Set<number>();
    const ecartes: {
      p: Lu;
      motif: 'BASE' | 'AUTRE_FICHIER' | 'MEME_FICHIER';
      raison: string;
      gardee: string;
      sur: boolean;
    }[] = [];
    const fusions: { gardee: Lu; autres: Lu[] }[] = [];
    // Le groupe a-t-il été formé avec une décision de l'agent ? (sinon : sûr)
    const decide = (g: Lu[]) => new Set(g.map((p) => racine(p.i))).size > 1;
    for (const g of groupes.values()) {
      const lignes = g.filter((p) => p.fichier >= 0).sort(this.trier);
      if (!lignes.length) continue;
      const base = g.filter((p) => p.fichier === -1).sort(this.trier);
      const sur = !decide(g);
      if (base.length) {
        const raison = `Déjà dans : ${base.map((b) => `${b.origine}${b.details ? ` (${b.details})` : ''}`).join(' ; ')}`;
        for (const p of lignes) {
          const autres = lignes.filter((x) => x !== p);
          ecartes.push({
            p,
            motif: 'BASE',
            raison:
              raison +
              (autres.length
                ? ` · aussi : ${autres.map((x) => this.ou(x)).join(' ; ')}`
                : ''),
            gardee: '',
            sur,
          });
        }
        continue;
      }
      if (lignes.length === 1) {
        garde.add(lignes[0].i);
        continue;
      }
      // Plusieurs fois dans les fichiers : la ligne la plus complète est gardée, les autres écartées
      const gardee = [...lignes].sort(
        (x, y) => (y.remplies ?? 0) - (x.remplies ?? 0) || this.trier(x, y),
      )[0];
      garde.add(gardee.i);
      const autres = lignes.filter((x) => x !== gardee);
      fusions.push({ gardee, autres });
      for (const p of autres)
        ecartes.push({
          p,
          motif:
            p.fichier === gardee.fichier ? 'MEME_FICHIER' : 'AUTRE_FICHIER',
          raison:
            p.fichier === gardee.fichier
              ? `En double dans le même fichier : déjà ${p.feuille === gardee.feuille ? '' : `feuille « ${gardee.feuille} », `}ligne ${gardee.ligne}`
              : `Aussi dans ${this.ou(gardee)}`,
          gardee: this.ou(gardee),
          sur,
        });
    }
    ecartes.sort((x, y) => this.trier(x.p, y.p));
    return { garde, ecartes, fusions, lienDecide };
  }

  private ou(p: Lu) {
    return p.fichier >= 0
      ? `Fichier ${p.fichier + 1} › ${p.feuille}, ligne ${p.ligne}`
      : p.origine;
  }

  /** L'analyse montrée à l'écran : chiffres, cas sûrs, et cas douteux à trancher. */
  async detecter(
    fichiers: { nom: string; contenu: Buffer }[],
    options: Options,
  ) {
    const a = await this.analyser(fichiers, options);
    const t = this.trancher(a, {});
    const { tous, membresDe, aTrancher } = a;
    const nbEcartes = (n: number, m?: string) =>
      t.ecartes.filter(
        (e) => e.p.fichier === n && e.sur && (!m || e.motif === m),
      ).length;
    // Groupes sûrs qui touchent les fichiers (pour la liste « écartés d'office »)
    const surs = [...membresDe.values()]
      .map((ids) => ids.map((i) => tous[i]).sort(this.trier))
      .filter(
        (g) =>
          g.length > 1 &&
          g.some((p) => p.fichier >= 0) &&
          (g.some((p) => p.fichier === -1) ||
            g.filter((p) => p.fichier >= 0).length > 1),
      )
      .sort((x, y) => x[0].nom.localeCompare(y[0].nom, 'fr'));
    const douteux = [...aTrancher.values()]
      .map((d) => ({
        id: d.id,
        doute: d.doute,
        libelle: LIBELLE_DOUTE[d.doute],
        // Proposition : une date différente fait penser à deux personnes
        suggestion:
          d.doute === 'DATE_DIFFERENTE'
            ? 'DIFFERENTE'
            : d.memeNaissance
              ? 'MEME'
              : null,
        memeNaissance: d.memeNaissance,
        a: membresDe
          .get(d.ra)!
          .map((i) => tous[i])
          .sort(this.trier)
          .map((p) => this.vu(p)),
        b: membresDe
          .get(d.rb)!
          .map((i) => tous[i])
          .sort(this.trier)
          .map((p) => this.vu(p)),
      }))
      .sort(
        (x, y) =>
          x.doute.localeCompare(y.doute) ||
          x.a[0].nom.localeCompare(y.a[0].nom, 'fr'),
      );
    return {
      fichiers: a.lus.map((f, n) => ({
        ...f,
        ecartesBase: nbEcartes(n, 'BASE'),
        ecartesFichiers:
          nbEcartes(n, 'AUTRE_FICHIER') + nbEcartes(n, 'MEME_FICHIER'),
      })),
      avecBase: a.options.avecBase,
      bases: a.bases,
      surs: surs.slice(0, 2000).map((g) => g.map((p) => this.vu(p))),
      sursTotal: surs.length,
      douteux,
    };
  }

  /* ------------------------------ Fichiers ------------------------------ */

  private decisionsLues(brut?: string): Decisions {
    if (!brut) return {};
    try {
      const v = JSON.parse(brut) as unknown;
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).filter(
          (e): e is [string, 'MEME' | 'DIFFERENTE'] =>
            e[1] === 'MEME' || e[1] === 'DIFFERENTE',
        ),
      );
    } catch {
      throw new BadRequestException('Décisions illisibles.');
    }
  }

  /** Les cas douteux doivent tous être tranchés avant de télécharger. */
  private async preparer(
    fichiers: { nom: string; contenu: Buffer }[],
    options: Options,
    brut?: string,
  ) {
    const a = await this.analyser(fichiers, options);
    const decisions = this.decisionsLues(brut);
    const restants = [...a.aTrancher.values()].filter(
      (d) => !decisions[d.id] && d.doute !== 'DATE_DIFFERENTE',
    ).length;
    if (restants)
      throw new BadRequestException(
        `${restants} rapprochement(s) restent à trancher (« même personne » ou « pas la même personne ») avant de télécharger. Si les bases ont changé depuis l’analyse, relancez-la.`,
      );
    return { a, t: this.trancher(a, decisions) };
  }

  private enTete(ws: ExcelJS.Worksheet, titre: string, sousTitre: string) {
    ws.getCell(1, 1).value = titre;
    ws.getCell(1, 1).font = { bold: true, size: 14, color: { argb: VERT } };
    ws.getCell(2, 1).value = sousTitre;
    ws.getCell(2, 1).font = { size: 10, color: { argb: 'FF52525B' } };
  }

  private ligneTitres(ws: ExcelJS.Worksheet, n: number, titres: string[]) {
    const row = ws.getRow(n);
    titres.forEach((t, i) => {
      const c = row.getCell(i + 1);
      c.value = t;
      c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
      c.fill = plein(VERT);
      c.alignment = { vertical: 'middle', wrapText: true };
      c.border = { bottom: { style: 'thin', color: { argb: 'FF0A3622' } } };
    });
    row.height = 30;
    ws.views = [{ state: 'frozen', ySplit: n }];
    ws.autoFilter = {
      from: { row: n, column: 1 },
      to: { row: n, column: titres.length },
    };
  }

  /** Fichier des doublons : chaque ligne écartée, où elle a été trouvée, et les décisions prises. */
  async excelDoublons(
    fichiers: { nom: string; contenu: Buffer }[],
    options: Options,
    brut?: string,
  ) {
    const { a, t } = await this.preparer(fichiers, options, brut);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'SIGRHAS-MEPPSA';
    const le = new Date().toLocaleDateString('fr-FR');

    // Résumé
    const r = wb.addWorksheet('Résumé');
    this.enTete(
      r,
      'Rapprochement et détection des doublons',
      `Édité le ${le} · rien n’a été enregistré dans le système`,
    );
    this.ligneTitres(r, 4, [
      'Fichier',
      'Personnes lues',
      'Gardées (fichier nettoyé)',
      'Écartées : déjà dans une base',
      'Écartées : en double dans les fichiers',
    ]);
    r.views = [];
    r.autoFilter = undefined;
    let ligne = 5;
    for (const [n, f] of a.lus.entries()) {
      const e = t.ecartes.filter((x) => x.p.fichier === n);
      r.getRow(ligne++).values = [
        `Fichier ${n + 1} : ${f.nom} (${f.feuilles.map((x) => x.nom).join(', ')})`,
        f.personnes,
        a.tous.filter((p) => p.fichier === n && t.garde.has(p.i)).length,
        e.filter((x) => x.motif === 'BASE').length,
        e.filter((x) => x.motif !== 'BASE').length,
      ];
    }
    ligne++;
    r.getCell(ligne++, 1).value = a.options.avecBase
      ? `Bases comparées (la base des enrôlés n’est jamais comparée) : ${a.bases.map((b) => `${b.nom} (${b.personnes.toLocaleString('fr-FR')})`).join(' ; ')}`
      : 'Bases du système : non comparées (seulement les fichiers entre eux).';
    r.getCell(ligne++, 1).value =
      `Rapprochements tranchés par l’agent : ${t.lienDecide.filter((d) => d.decision === 'MEME').length} « même personne », ${t.lienDecide.filter((d) => d.decision === 'DIFFERENTE').length} « pas la même personne ».`;
    r.getColumn(1).width = 90;
    [2, 3, 4, 5].forEach((c) => (r.getColumn(c).width = 18));

    // Doublons écartés
    const ws = wb.addWorksheet('Doublons écartés');
    this.enTete(
      ws,
      `Doublons écartés (${t.ecartes.length.toLocaleString('fr-FR')})`,
      `Édité le ${le} · rouge : déjà dans une base du système · orange : dans un autre fichier · jaune : en double dans le même fichier`,
    );
    this.ligneTitres(ws, 4, [
      'N°',
      'Noms et prénoms',
      'Date de naissance',
      'Fichier',
      'Feuille',
      'Ligne',
      'Raison',
      'Ligne gardée à la place',
      'Certitude',
      'Détails de la ligne',
    ]);
    const COULEUR = {
      BASE: 'FFFDE2E1',
      AUTRE_FICHIER: 'FFFFEDD5',
      MEME_FICHIER: 'FFFEF9C3',
    };
    t.ecartes.forEach((e, k) => {
      const row = ws.getRow(5 + k);
      row.values = [
        k + 1,
        e.p.nom,
        dateFr(e.p.naissance),
        `Fichier ${e.p.fichier + 1} : ${a.lus[e.p.fichier].nom}`,
        e.p.feuille,
        e.p.ligne,
        e.raison,
        e.gardee || '— (personne déjà connue : aucune ligne gardée)',
        e.sur ? 'Sûr' : 'Décidé par l’agent',
        e.p.details,
      ];
      row.eachCell((c) => {
        c.alignment = { vertical: 'top', wrapText: true };
        c.border = { bottom: { style: 'hair', color: { argb: 'FFD4D4D8' } } };
      });
      row.getCell(2).fill = plein(COULEUR[e.motif]);
      row.getCell(2).font = { bold: true };
    });
    ws.columns = [6, 34, 13, 34, 16, 7, 60, 34, 14, 50].map((width) => ({
      width,
    }));

    // Rapprochements jugés « pas la même personne » : gardés pour mémoire
    const diff = t.lienDecide.filter((d) => d.decision === 'DIFFERENTE');
    if (diff.length) {
      const wd = wb.addWorksheet('Pas la même personne');
      this.enTete(
        wd,
        `Rapprochements écartés : pas la même personne (${diff.length})`,
        'Ces personnes se ressemblaient ; elles ont été jugées différentes et restent dans le fichier nettoyé (sauf autre doublon).',
      );
      this.ligneTitres(wd, 4, ['Raison du doute', 'Personne A', 'Personne B']);
      const desc = (ids: number[]) =>
        ids
          .map((i) => a.tous[i])
          .sort(this.trier)
          .map(
            (p) =>
              `${p.nom}${p.naissance ? ` (${dateFr(p.naissance)})` : ''} — ${this.ou(p)}`,
          )
          .join('\n');
      diff.forEach((d, k) => {
        const x = a.aTrancher.get(d.id)!;
        const row = wd.getRow(5 + k);
        row.values = [
          LIBELLE_DOUTE[x.doute],
          desc(a.membresDe.get(x.ra)!),
          desc(a.membresDe.get(x.rb)!),
        ];
        row.eachCell(
          (c) => (c.alignment = { vertical: 'top', wrapText: true }),
        );
      });
      wd.columns = [{ width: 34 }, { width: 70 }, { width: 70 }];
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  /**
   * Fichier nettoyé : les feuilles comparées, recopiées telles quelles (mise en forme comprise),
   * sans les lignes écartées ; chaque personne n'y figure qu'une fois et aucune n'est déjà dans
   * une base. La colonne « N° » est renumérotée.
   */
  async excelNettoye(
    fichiers: { nom: string; contenu: Buffer }[],
    options: Options,
    brut?: string,
    planBrut?: string,
  ) {
    // Le plan (feuilles lues, lignes écartées) vient d'un appel précédent : l'analyse et la
    // recopie ne se font pas dans la même requête (08/11/2026 : le serveur en ligne manquait de
    // mémoire). Sans plan, l'analyse est refaite ici.
    const { feuilles, ecartees } = planBrut
      ? this.planLu(planBrut, fichiers.length)
      : await this.planNettoye(fichiers, options, brut);
    const sortie = new ExcelJS.Workbook();
    sortie.creator = 'SIGRHAS-MEPPSA';
    const noms = new Set<string>();
    for (const [n, f] of fichiers.entries()) {
      const source = new ExcelJS.Workbook();
      // Les feuilles non cochées sont vidées avant l'ouverture : seules les feuilles lues pèsent
      await source.xlsx.load(
        (await this.alleger(f.contenu, feuilles[n])) as unknown as ArrayBuffer,
      );
      for (const feuille of feuilles[n].map((nom) => ({ nom }))) {
        const ws = source.getWorksheet(feuille.nom);
        if (!ws) continue;
        let nom = `F${n + 1} ${feuille.nom}`.replace(/[\\/?*[\]:]/g, ' ');
        nom = nom.slice(0, 31);
        for (let k = 2; noms.has(nom); k++) nom = `${nom.slice(0, 28)} ${k}`;
        noms.add(nom);
        this.recopier(
          ws,
          sortie.addWorksheet(nom),
          ecartees.get(`${n}|${feuille.nom}`) ?? new Set(),
        );
      }
    }
    return Buffer.from(await sortie.xlsx.writeBuffer());
  }

  /** Le plan du fichier nettoyé, à renvoyer tel quel pour le télécharger (petit : des numéros de ligne). */
  async plan(
    fichiers: { nom: string; contenu: Buffer }[],
    options: Options,
    brut?: string,
  ) {
    const { feuilles, ecartees } = await this.planNettoye(
      fichiers,
      options,
      brut,
    );
    return {
      feuilles,
      ecartees: Object.fromEntries(
        [...ecartees].map(([k, v]) => [k, [...v].sort((x, y) => x - y)]),
      ),
    };
  }

  /** Plan reçu du navigateur : vérifié (des noms de feuilles et des numéros de ligne seulement). */
  private planLu(brut: string, nbFichiers: number) {
    const refus = () =>
      new BadRequestException(
        'Plan du fichier nettoyé illisible : relancez la recherche.',
      );
    let v: unknown;
    try {
      v = JSON.parse(brut);
    } catch {
      throw refus();
    }
    const p = v as { feuilles?: unknown; ecartees?: unknown };
    if (
      !Array.isArray(p.feuilles) ||
      p.feuilles.length !== nbFichiers ||
      !p.feuilles.every(
        (l) =>
          Array.isArray(l) &&
          l.length <= 50 &&
          l.every((x) => typeof x === 'string' && x.length <= 100),
      ) ||
      !p.ecartees ||
      typeof p.ecartees !== 'object' ||
      Array.isArray(p.ecartees)
    )
      throw refus();
    const ecartees = new Map<string, Set<number>>();
    for (const [k, l] of Object.entries(
      p.ecartees as Record<string, unknown>,
    )) {
      if (
        !Array.isArray(l) ||
        l.length > 200000 ||
        !l.every((x) => Number.isInteger(x) && (x as number) > 0)
      )
        throw refus();
      ecartees.set(k, new Set(l as number[]));
    }
    return { feuilles: p.feuilles as string[][], ecartees };
  }

  /** Les feuilles lues de chaque fichier et les lignes écartées : de quoi faire le fichier nettoyé. */
  private async planNettoye(
    fichiers: { nom: string; contenu: Buffer }[],
    options: Options,
    brut?: string,
  ) {
    const { a, t } = await this.preparer(fichiers, options, brut);
    const ecartees = new Map<string, Set<number>>();
    for (const e of t.ecartes) {
      const k = `${e.p.fichier}|${e.p.feuille}`;
      const s = ecartees.get(k) ?? new Set<number>();
      s.add(e.p.ligne!);
      ecartees.set(k, s);
    }
    return {
      feuilles: a.lus.map((l) => l.feuilles.map((x) => x.nom)),
      ecartees,
    };
  }

  /**
   * Le classeur sans le contenu des feuilles qu'on ne garde pas (remplacées par des feuilles
   * vides) : ouvrir un classeur entier avec ses feuilles masquées de milliers de lignes coûte des
   * centaines de Mo.
   */
  private async alleger(contenu: Buffer, garder: string[]) {
    try {
      const zip = await JSZip.loadAsync(contenu);
      const wb = await zip.file('xl/workbook.xml')?.async('string');
      const rels = await zip
        .file('xl/_rels/workbook.xml.rels')
        ?.async('string');
      if (!wb || !rels) return contenu;
      const cible = new Map<string, string>();
      for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
        const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
        const t = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
        if (id && t)
          cible.set(
            id,
            t.startsWith('/') ? t.slice(1) : `xl/${t.replace(/^\.\//, '')}`,
          );
      }
      const xml = (v: string) =>
        v.replace(
          /&(amp|lt|gt|quot|apos);/g,
          (_t, e: string) =>
            ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e] ?? '',
        );
      const VIDE =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>';
      let videes = 0;
      for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
        const nom = /\bname="([^"]*)"/.exec(m[0])?.[1];
        const rid = /\br:id="([^"]+)"/.exec(m[0])?.[1];
        const chemin = rid ? cible.get(rid) : undefined;
        if (nom === undefined || !chemin || garder.includes(xml(nom))) continue;
        if (!zip.file(chemin)) continue;
        zip.file(chemin, VIDE);
        videes++;
      }
      if (!videes) return contenu;
      return await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'STORE',
      });
    } catch {
      // Classeur inhabituel : il est ouvert tel quel
      return contenu;
    }
  }

  /** Recopie une feuille sans certaines lignes (valeurs, styles, largeurs, fusions), N° renuméroté. */
  private recopier(
    ws: ExcelJS.Worksheet,
    cible: ExcelJS.Worksheet,
    sans: Set<number>,
  ) {
    // Ligne des titres : celle qui porte « Noms et prénoms »
    let titres = 0;
    let colonneN = 0;
    for (let r = 1; r <= Math.min(ws.rowCount, 40) && !titres; r++)
      ws.getRow(r).eachCell((c) => {
        const v = compact(c.text);
        if (/^NOMS?(ET)?PRENOMS?/.test(v)) titres = r;
      });
    if (titres)
      ws.getRow(titres).eachCell((c, col) => {
        if (!colonneN && /^(N|NO|NUMERO|NORDRE)$/.test(compact(c.text)))
          colonneN = col;
      });
    ws.columns?.forEach((c, i) => {
      if (c?.width) cible.getColumn(i + 1).width = c.width;
      if (c?.hidden) cible.getColumn(i + 1).hidden = true;
    });
    const avant: number[] = []; // lignes retirées avant chaque ligne (décalage)
    let retirees = 0;
    let numero = 0;
    for (let r = 1; r <= ws.rowCount; r++) {
      avant[r] = retirees;
      if (sans.has(r)) {
        retirees++;
        continue;
      }
      const src = ws.getRow(r);
      const dst = cible.getRow(r - retirees);
      if (src.height) dst.height = src.height;
      if (src.hidden) dst.hidden = true;
      src.eachCell({ includeEmpty: true }, (c, col) => {
        const d = dst.getCell(col);
        const v = c.value;
        // Une formule renverrait à des lignes déplacées : sa valeur est reprise
        d.value =
          v && typeof v === 'object' && ('formula' in v || 'sharedFormula' in v)
            ? ((v as { result?: ExcelJS.CellValue }).result ?? null)
            : v;
        // Le style est partagé (pas recopié) : la recopie coûtait de la mémoire pour rien
        d.style = c.style;
      });
      if (
        titres &&
        colonneN &&
        r > titres &&
        typeof dst.getCell(colonneN).value === 'number'
      )
        dst.getCell(colonneN).value = ++numero;
    }
    // Fusions (en-têtes surtout) : gardées si aucune de leurs lignes n'a été retirée
    const fusions = (ws.model as { merges?: string[] }).merges ?? [];
    for (const plage of fusions) {
      const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(plage);
      if (!m) continue;
      const r1 = Number(m[2]),
        r2 = Number(m[4]);
      let coupee = false;
      for (let r = r1; r <= r2; r++) if (sans.has(r)) coupee = true;
      if (coupee) continue;
      try {
        cible.mergeCells(`${m[1]}${r1 - avant[r1]}:${m[3]}${r2 - avant[r1]}`);
      } catch {
        // fusion qui chevauche une autre : ignorée
      }
    }
    if (titres) cible.views = [{ state: 'frozen', ySplit: titres }];
  }
}
