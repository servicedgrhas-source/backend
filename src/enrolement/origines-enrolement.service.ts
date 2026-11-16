import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ROLES_TRAITEMENT, type UtilisateurConnecte } from '../auth/auth';
import { lireClasseur } from '../common/excel';
import { enTexte, lireDate, nettoyer, normaliser } from '../common/texte';
import { JournalService } from '../core/core.service';
import { ConfigEnrolementService } from './configuration';
import { paires, ressemblance } from './effectifs-ecoles-regles';
import { cleOrigine, libelleOrigine } from './origines-regles';

/**
 * Origine des enrôlés (DG, 16/11/2026) : qui les a recommandés. Décisive, mais pour la DGRHAS
 * seulement (jamais montrée aux visiteurs ni aux structures).
 * - L'écriture du fichier est gardée telle quelle (`enrole.origineBrute`) ;
 * - les écritures d'une même origine sont regroupées (« S/C DRSC », « SC/ DRSC »… → « DRSC »),
 *   automatiquement, puis à la main (rattacher un groupe à un autre, le renommer) ;
 * - pas d'origine écrite : pas d'origine (rien n'est inventé) ;
 * - l'origine se récupère depuis les fichiers de saisie (colonne ORIGINE, sinon OBS), sans jamais
 *   écraser une origine déjà enregistrée.
 */

const PARAM = 'ENROLEMENT_ORIGINES';

interface Reglages {
  /** Groupe (clé automatique) → groupe où il est compté. */
  rattachees: Record<string, string>;
  /** Groupe → nom choisi par la DGRHAS. */
  libelles: Record<string, string>;
}

/** Ce qui est montré de l'origine selon le compte : la DGRHAS seulement. */
export const voitOrigine = (u: UtilisateurConnecte) =>
  u.role === 'ADMIN' || ROLES_TRAITEMENT.includes(u.role);

const cleNom = (n: string) =>
  normaliser(n)
    .replace(/[^A-Z ]/g, ' ')
    .split(' ')
    .filter(Boolean)
    .sort()
    .join(' ');

const valeur = (l: Record<string, unknown>, prefixes: string[]) => {
  for (const p of prefixes) {
    const k = Object.keys(l).find((x) => x.startsWith(p));
    if (k && nettoyer(l[k])) return nettoyer(l[k]);
  }
  return null;
};

@Injectable()
export class OriginesEnrolementService {
  constructor(
    private readonly ds: DataSource,
    private readonly journal: JournalService,
    private readonly config: ConfigEnrolementService,
  ) {}

  private async reglages(): Promise<Reglages> {
    const [p] = await this.ds.query<{ valeur: string }[]>(
      `SELECT valeur FROM parametre WHERE cle = $1`,
      [PARAM],
    );
    try {
      const r = p ? (JSON.parse(p.valeur) as Partial<Reglages>) : {};
      return { rattachees: r.rattachees ?? {}, libelles: r.libelles ?? {} };
    } catch {
      return { rattachees: {}, libelles: {} };
    }
  }

  private async enregistrerReglages(r: Reglages) {
    await this.ds.query(
      `INSERT INTO parametre (cle, valeur, description) VALUES ($1, $2, $3)
       ON CONFLICT (cle) DO UPDATE SET valeur = EXCLUDED.valeur`,
      [
        PARAM,
        JSON.stringify(r),
        'Enrôlement : regroupement des origines (qui a recommandé)',
      ],
    );
  }

  /** Le groupe où une clé est comptée (en suivant les rattachements). */
  private racine(r: Reglages, cle: string) {
    let x = cle;
    const vues = new Set<string>();
    while (r.rattachees[x] && !vues.has(x)) {
      vues.add(x);
      x = r.rattachees[x];
    }
    return x;
  }

  /** Les enrôlés d'une campagne avec leur origine et ce qu'ils coûtent s'ils sont retenus. */
  private async enroles(campagneId: number) {
    const [camp] = await this.ds.query<
      { montantsParCycle: Record<string, number> | null }[]
    >(`SELECT "montantsParCycle" FROM campagne_enrolement WHERE id = $1`, [
      campagneId,
    ]);
    if (!camp) throw new NotFoundException('Campagne introuvable.');
    const lignes = await this.ds.query<
      {
        id: string;
        origine: string | null;
        etat: string;
        ecarte: boolean;
        cycle: string | null;
      }[]
    >(
      `SELECT id, "origineBrute" AS origine, etat, "ecarteDejaConnu" AS ecarte, cycle
         FROM enrole WHERE "campagneId" = $1`,
      [campagneId],
    );
    const bourse = (c: string | null) =>
      (c && camp.montantsParCycle?.[c]) ||
      (c ? this.config.categorieDepuisTexte(c)?.bourse : 0) ||
      0;
    const equipement = (c: string | null) =>
      (c ? this.config.categorieDepuisTexte(c)?.equipement : 0) || 0;
    return lignes.map((l) => ({
      ...l,
      bourse: bourse(l.cycle),
      equipement: equipement(l.cycle),
    }));
  }

  /**
   * Les groupes d'origines d'une campagne : écritures rencontrées, enrôlés par étape, coût des
   * retenus (bourse par mois, mise d'équipement), et les groupes qui se ressemblent (à rattacher).
   */
  async groupes(campagneId: number) {
    const r = await this.reglages();
    const liste = await this.enroles(campagneId);
    const groupes = new Map<
      string,
      {
        cle: string;
        cles: Set<string>;
        ecritures: Map<string, number>;
        n: number;
        retenus: number;
        ecartes: number;
        nonRetenus: number;
        enCours: number;
        bourse: number;
        equipement: number;
      }
    >();
    const sans = { n: 0, retenus: 0, bourse: 0 };
    for (const e of liste) {
      const auto = cleOrigine(e.origine);
      if (!auto) {
        sans.n++;
        if (e.etat === 'RETENU') {
          sans.retenus++;
          sans.bourse += e.bourse;
        }
        continue;
      }
      const cle = this.racine(r, auto);
      const g = groupes.get(cle) ?? {
        cle,
        cles: new Set<string>(),
        ecritures: new Map<string, number>(),
        n: 0,
        retenus: 0,
        ecartes: 0,
        nonRetenus: 0,
        enCours: 0,
        bourse: 0,
        equipement: 0,
      };
      g.cles.add(auto);
      const ecrit = (e.origine ?? '').replace(/\s+/g, ' ').trim();
      g.ecritures.set(ecrit, (g.ecritures.get(ecrit) ?? 0) + 1);
      g.n++;
      if (e.etat === 'RETENU') {
        g.retenus++;
        g.bourse += e.bourse;
        g.equipement += e.equipement;
      } else if (e.etat === 'NON_RETENU') {
        if (e.ecarte) g.ecartes++;
        else g.nonRetenus++;
      } else g.enCours++;
      groupes.set(cle, g);
    }
    const resultat = [...groupes.values()]
      .map((g) => ({
        cle: g.cle,
        libelle: r.libelles[g.cle] || libelleOrigine(g.ecritures),
        renomme: !!r.libelles[g.cle],
        rattachees: [...g.cles].filter((c) => c !== g.cle),
        ecritures: [...g.ecritures.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([ecrit, n]) => ({ ecrit, n })),
        n: g.n,
        retenus: g.retenus,
        ecartes: g.ecartes,
        nonRetenus: g.nonRetenus,
        enCours: g.enCours,
        bourse: g.bourse,
        equipement: g.equipement,
      }))
      .sort((a, b) => b.n - a.n || a.libelle.localeCompare(b.libelle));
    // Les groupes dont les noms se ressemblent (« ATTACHE MBOLE » / « CAB ATTACHE MBOLE »…)
    const p = resultat.map((g) => paires(g.cle));
    const proches: { a: string; b: string; score: number }[] = [];
    for (let i = 0; i < resultat.length; i++)
      for (let j = i + 1; j < resultat.length; j++) {
        const s = ressemblance(resultat[i].cle, resultat[j].cle, p[i], p[j]);
        if (s >= 0.75)
          proches.push({ a: resultat[i].cle, b: resultat[j].cle, score: s });
      }
    return {
      groupes: resultat,
      sansOrigine: sans,
      proches: proches.sort((a, b) => b.score - a.score).slice(0, 200),
      total: liste.length,
    };
  }

  /** Pour chaque enrôlé de la campagne : le nom de son origine regroupée. */
  async libellesParEnrole(campagneId: number) {
    const { groupes } = await this.groupes(campagneId);
    const r = await this.reglages();
    const parCle = new Map(groupes.map((g) => [g.cle, g]));
    const lignes = await this.ds.query<
      { id: string; origine: string | null }[]
    >(
      `SELECT id, "origineBrute" AS origine FROM enrole WHERE "campagneId" = $1 AND "origineBrute" IS NOT NULL`,
      [campagneId],
    );
    const m = new Map<string, { cle: string; libelle: string }>();
    for (const l of lignes) {
      const auto = cleOrigine(l.origine);
      if (!auto) continue;
      const g = parCle.get(this.racine(r, auto));
      if (g) m.set(l.id, { cle: g.cle, libelle: g.libelle });
    }
    return m;
  }

  /** Compter un groupe avec un autre (null : le détacher). */
  async rattacher(u: UtilisateurConnecte, cle: string, cible: string | null) {
    const r = await this.reglages();
    if (!cle) throw new BadRequestException('Origine inconnue.');
    if (cible) {
      if (cible === cle || this.racine(r, cible) === cle)
        throw new BadRequestException(
          'Ces deux origines sont déjà comptées ensemble dans l’autre sens.',
        );
      r.rattachees[cle] = cible;
    } else delete r.rattachees[cle];
    await this.enregistrerReglages(r);
    await this.journal.log(u, 'ENROLES_ORIGINE_REGROUPEE', 'parametre', PARAM, {
      origine: cle,
      avec: cible,
    });
    return { ok: true };
  }

  /** Donner un nom à un groupe d'origines (null : revenir à l'écriture la plus fréquente). */
  async renommer(u: UtilisateurConnecte, cle: string, libelle: string | null) {
    const r = await this.reglages();
    const l = libelle?.trim().slice(0, 120);
    if (l) r.libelles[cle] = l;
    else delete r.libelles[cle];
    await this.enregistrerReglages(r);
    await this.journal.log(u, 'ENROLES_ORIGINE_RENOMMEE', 'parametre', PARAM, {
      origine: cle,
      libelle: l ?? null,
    });
    return { ok: true };
  }

  /** Écrire (ou effacer) l'origine d'un enrôlé à la main. */
  async definir(u: UtilisateurConnecte, id: string, origine: string | null) {
    const [e] = await this.ds.query<{ id: string; origine: string | null }[]>(
      `SELECT id, "origineBrute" AS origine FROM enrole WHERE id = $1`,
      [id],
    );
    if (!e) throw new NotFoundException('Enrôlé introuvable.');
    const o = origine?.trim().slice(0, 200) || null;
    await this.ds.query(`UPDATE enrole SET "origineBrute" = $2 WHERE id = $1`, [
      id,
      o,
    ]);
    await this.journal.log(u, 'ENROLE_ORIGINE', 'enrole', id, {
      avant: e.origine,
      apres: o,
    });
    return { ok: true };
  }

  /* ------------------------- Récupérer l'origine d'un fichier ------------------------- */

  /**
   * Rapprocher les lignes d'un fichier de saisie des enrôlés (même nom ; même date de naissance
   * quand les deux en ont une) et lire leur origine : colonne ORIGINE, sinon OBS / Observation.
   */
  private async rapprocher(contenu: Buffer, campagneId: number) {
    const feuilles = await lireClasseur(
      contenu,
      ['NOMSETPRENOMS|NOMETPRENOMS|NOMSPRENOMS'],
      { inclureMasquees: false },
    );
    const enroles = await this.ds.query<
      {
        id: string;
        nom: string;
        naissance: string | null;
        origine: string | null;
      }[]
    >(
      `SELECT id, "nomComplet" AS nom, to_char("dateNaissance", 'YYYY-MM-DD') AS naissance, "origineBrute" AS origine
         FROM enrole WHERE "campagneId" = $1`,
      [campagneId],
    );
    const parNom = new Map<string, typeof enroles>();
    for (const e of enroles)
      parNom.set(cleNom(e.nom), [...(parNom.get(cleNom(e.nom)) ?? []), e]);
    const lues: {
      feuille: string;
      colonne: string | null;
      personnes: number;
      avecOrigine: number;
    }[] = [];
    const lignes: {
      feuille: string;
      ligne: number;
      nom: string;
      origine: string | null;
      enrole: (typeof enroles)[number] | null;
      ambigu: boolean;
    }[] = [];
    for (const f of feuilles) {
      // Feuilles de retraits ou d'anciennes versions : on ne lit que les listes
      if (/RETRAIT|DOUBLON/i.test(normaliser(f.nom))) continue;
      const colOrigine = f.entetes.find((e) => e.startsWith('ORIGINE'));
      const colObs = f.entetes.find(
        (e) => e === 'OBS' || e.startsWith('OBSERV'),
      );
      const personnes = f.lignes.filter(
        (l) =>
          /^\d+$/.test(enTexte(l.N).trim()) &&
          !!valeur(l, ['NOMSETPRENOMS', 'NOMETPRENOMS', 'NOMSPRENOMS']),
      );
      if (!personnes.length) continue;
      const remplie = (c?: string) =>
        c ? personnes.filter((l) => nettoyer(l[c])).length : 0;
      // La colonne ORIGINE si elle est remplie, sinon OBS
      const colonne =
        remplie(colOrigine) > 0
          ? colOrigine!
          : remplie(colObs) > 0
            ? colObs!
            : null;
      lues.push({
        feuille: f.nom,
        colonne: colonne
          ? colonne.startsWith('ORIGINE')
            ? 'Origine'
            : 'Observation (OBS)'
          : null,
        personnes: personnes.length,
        avecOrigine: remplie(colonne ?? undefined),
      });
      for (const l of personnes) {
        const nom = valeur(l, [
          'NOMSETPRENOMS',
          'NOMETPRENOMS',
          'NOMSPRENOMS',
        ])!;
        const naissance = lireDate(valeur(l, ['DATEDENAIS', 'DATENAIS']));
        const candidats = (parNom.get(cleNom(nom)) ?? []).filter(
          (e) => !naissance || !e.naissance || e.naissance === naissance,
        );
        lignes.push({
          feuille: f.nom,
          ligne: l._ligne,
          nom,
          origine: colonne ? nettoyer(l[colonne]) : null,
          enrole: candidats.length === 1 ? candidats[0] : null,
          ambigu: candidats.length > 1,
        });
      }
    }
    if (!lues.length)
      throw new BadRequestException(
        'Aucune liste avec une colonne « Noms et prénoms » dans ce fichier.',
      );
    // Par enrôlé : les origines que le fichier lui donne
    const parEnrole = new Map<string, Set<string>>();
    for (const l of lignes)
      if (l.enrole && l.origine)
        parEnrole.set(
          l.enrole.id,
          (parEnrole.get(l.enrole.id) ?? new Set()).add(l.origine),
        );
    const aRemplir: { id: string; nom: string; origine: string }[] = [];
    const conflits: {
      id: string;
      nom: string;
      systeme: string | null;
      fichier: string[];
    }[] = [];
    let identiques = 0;
    for (const [id, set] of parEnrole) {
      const e = enroles.find((x) => x.id === id)!;
      const origines = [...set];
      const memes = (a: string | null, b: string) =>
        normaliser(a ?? '') === normaliser(b);
      if (e.origine && origines.every((o) => memes(e.origine, o))) identiques++;
      else if (!e.origine && origines.length === 1)
        aRemplir.push({ id, nom: e.nom, origine: origines[0] });
      else
        conflits.push({
          id,
          nom: e.nom,
          systeme: e.origine,
          fichier: origines,
        });
    }
    return {
      feuilles: lues,
      lignes: lignes.length,
      rapprochees: lignes.filter((l) => l.enrole).length,
      introuvables: lignes
        .filter((l) => !l.enrole && !l.ambigu)
        .map((l) => ({
          feuille: l.feuille,
          ligne: l.ligne,
          nom: l.nom,
          origine: l.origine,
        })),
      ambigues: lignes.filter((l) => l.ambigu).length,
      sansOrigine: lignes.filter((l) => l.enrole && !l.origine).length,
      identiques,
      aRemplir,
      conflits,
    };
  }

  /** Ce que le fichier apporterait, sans rien enregistrer. */
  async analyser(contenu: Buffer, campagneId: number) {
    return this.rapprocher(contenu, campagneId);
  }

  /** Remplir l'origine des enrôlés qui n'en ont pas ; les autres (conflits) ne changent pas. */
  async appliquer(
    u: UtilisateurConnecte,
    contenu: Buffer,
    nomFichier: string,
    campagneId: number,
  ) {
    const r = await this.rapprocher(contenu, campagneId);
    // Seulement les origines encore vides au moment d'écrire (jamais d'écrasement)
    for (let i = 0; i < r.aRemplir.length; i += 500) {
      const lot = r.aRemplir.slice(i, i + 500);
      await this.ds.query(
        `UPDATE enrole e SET "origineBrute" = v.origine
           FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::text[]) AS origine) v
          WHERE e.id = v.id AND e."origineBrute" IS NULL`,
        [lot.map((x) => x.id), lot.map((x) => x.origine)],
      );
    }
    await this.journal.log(
      u,
      'ENROLES_ORIGINE_RECUPEREE',
      'campagne_enrolement',
      campagneId,
      {
        fichier: nomFichier,
        remplies: r.aRemplir.length,
        identiques: r.identiques,
        conflits: r.conflits.length,
        introuvables: r.introuvables.length,
      },
    );
    return { ...r, enregistrees: r.aRemplir.length };
  }
}
