import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import ExcelJS from 'exceljs';
import { type FeuilleLue, type Ligne, lireClasseur } from '../common/excel';
import { IndexNoms } from '../common/index-noms';
import { moisEnClair } from '../common/mois';
import { motsDuNom } from '../common/ressemblance';
import { enTexte, lireDate, nettoyer, normaliser } from '../common/texte';
import { ConfigEnrolementService } from './configuration';

/**
 * Comparer un fichier « initial » (fait à la main, envoyé au Trésor) avec ce que le système a
 * produit (DG, 16/11/2026) : qui est ajouté, qui est retiré et pourquoi, quels montants ont
 * changé, et l'incidence financière de chaque écart.
 * - Bourse : un état de paiement d'un mois (volontaires ou communautaires) ;
 * - Enrôlement : les dossiers d'une campagne (retenus, validés sans département, écartés).
 * Lecture seule : rien n'est enregistré. Les personnes sont rapprochées par le nom (mots dans
 * n'importe quel ordre), puis par un nom proche (« à vérifier »).
 */

export type TypeEcart = 'AJOUT' | 'RETRAIT' | 'MONTANT';

export interface LigneEcartBourse {
  type: TypeEcart;
  nom: string;
  /** Le nom tel qu'écrit dans le fichier, quand il diffère de celui du système (nom proche). */
  nomFichier: string | null;
  departement: string;
  cycleFichier: string | null;
  montantFichier: number;
  categorieSysteme: string | null;
  montantSysteme: number;
  incidence: number;
  motif: string;
  detail: string | null;
}

export interface GroupeEcart {
  type: TypeEcart;
  motif: string;
  n: number;
  incidence: number;
}

const LIBELLES_TYPE: Record<TypeEcart, string> = {
  AJOUT: 'Dans le système, pas dans le fichier (ajoutés)',
  RETRAIT: 'Dans le fichier, pas dans le système (retirés)',
  MONTANT: 'Dans les deux, montant différent',
};

/** Clé d'un nom : majuscules sans accents, mots dans l'ordre alphabétique. */
const cle = (nom: string) =>
  normaliser(nom)
    .replace(/[^A-Z ]/g, ' ')
    .split(' ')
    .filter(Boolean)
    .sort()
    .join(' ');

const valeur = (l: Ligne, prefixes: string[]): unknown => {
  for (const p of prefixes) {
    const k = Object.keys(l).find((x) =>
      p === 'N' ? x === 'N' : x.startsWith(p),
    );
    if (k && l[k] !== null && l[k] !== undefined && l[k] !== '') return l[k];
  }
  return null;
};
const NOMS = ['NOMSETPRENOMS', 'NOMETPRENOMS', 'NOMSPRENOMS'];

/**
 * Les lignes d'une personne : un n° d'ordre et un nom (ni titres répétés ni TOTAL). Un nom d'un seul
 * mot compte aussi : la ligne est payée dans le fichier, elle doit être comparée.
 */
function personnes(f: FeuilleLue) {
  return f.lignes.filter((l) => {
    const nom = nettoyer(valeur(l, NOMS));
    const n = valeur(l, ['N']);
    return (
      !!nom &&
      motsDuNom(nom).length >= 1 &&
      !/^(TOTAL|NOMS?\s+(ET\s+)?PR)/i.test(normaliser(nom)) &&
      n !== null &&
      /^\d+$/.test(enTexte(n).trim())
    );
  });
}

const montantDe = (v: unknown) =>
  typeof v === 'number'
    ? Math.round(v)
    : Number(enTexte(v).replace(/[^\d]/g, '')) || 0;

const dateFr = (d: string | null) =>
  d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '';

@Injectable()
export class ComparaisonFichierService {
  constructor(
    private readonly ds: DataSource,
    private readonly config: ConfigEnrolementService,
  ) {}

  /* ------------------------------------ Bourse ------------------------------------ */

  /** Les feuilles d'un fichier de paiement : celles qui ont des noms et des montants. */
  private async feuillesPaiement(contenu: Buffer) {
    const feuilles = await lireClasseur(
      contenu,
      ['NOMSETPRENOMS|NOMETPRENOMS|NOMSPRENOMS'],
      { inclureMasquees: false },
    );
    return feuilles
      .filter((f) => f.entetes.some((e) => e.startsWith('MONTANT')))
      .map((f) => {
        const l = personnes(f);
        return {
          feuille: f,
          nom: f.nom,
          personnes: l.length,
          total: l.reduce((t, x) => t + montantDe(valeur(x, ['MONTANT'])), 0),
          // Retraits, récapitulatifs, anciennes listes : jamais la liste payée
          ecartee: /RETRAIT|RECAP|DESERT|RECRUT|OUBLI/i.test(normaliser(f.nom)),
        };
      })
      .filter((f) => f.personnes > 0);
  }

  async comparerBourse(contenu: Buffer, etatId: number, feuille?: string) {
    const [etat] = await this.ds.query<
      { id: number; mois: string; population: string; statut: string }[]
    >(`SELECT id, mois, population, statut FROM etat_bourse WHERE id = $1`, [
      etatId,
    ]);
    if (!etat) throw new NotFoundException('État introuvable.');
    const feuilles = await this.feuillesPaiement(contenu);
    if (!feuilles.length)
      throw new BadRequestException(
        'Aucune feuille avec une colonne « Noms et prénoms » et une colonne « Montant » dans ce fichier.',
      );
    // La liste payée : celle choisie, sinon la plus longue (hors retraits et récapitulatifs)
    const choisie =
      (feuille && feuilles.find((f) => f.nom === feuille)) ||
      [...feuilles]
        .filter((f) => !f.ecartee)
        .sort((a, b) => b.personnes - a.personnes)[0] ||
      feuilles[0];
    const fichier = personnes(choisie.feuille).map((l) => ({
      ligne: l._ligne,
      nom: nettoyer(valeur(l, NOMS))!,
      cycle: nettoyer(valeur(l, ['CYCLE'])),
      departement: nettoyer(valeur(l, ['DEPART', 'DEPAR'])),
      montant: montantDe(valeur(l, ['MONTANT'])),
    }));

    const deps = new Map(
      (
        await this.ds.query<{ id: number; nom: string }[]>(
          `SELECT id, nom FROM departement`,
        )
      ).map((d) => [d.id, d.nom]),
    );
    const sys = await this.ds.query<
      {
        volontaireId: string;
        nom: string;
        categorie: string | null;
        departementId: number | null;
        montant: number;
        mois: number;
        regularisation: number;
        total: number;
        source: string | null;
        creeLe: string | null;
        premierMois: string | null;
      }[]
    >(
      `SELECT l."volontaireId", l."nomComplet" AS nom, l.categorie, l."departementId", l.montant, l.mois,
              l.regularisation, l.total, v.source, to_char(v."creeLe", 'YYYY-MM-DD') AS "creeLe", v."premierMois"
         FROM ligne_bourse l LEFT JOIN volontaire v ON v.id = l."volontaireId"
        WHERE l."etatId" = $1`,
      [etatId],
    );
    // Le registre (en poste et sortis) pour dire pourquoi une personne du fichier est absente
    const registre = await this.ds.query<
      {
        id: string;
        nom: string;
        statut: string;
        motifSortie: string | null;
        dateSortie: string | null;
        premierMois: string | null;
      }[]
    >(
      `SELECT id, "nomComplet" AS nom, statut, "motifSortie", to_char("dateSortie", 'YYYY-MM-DD') AS "dateSortie", "premierMois"
         FROM volontaire WHERE population = $1`,
      [etat.population],
    );
    const registreParCle = new Map<string, typeof registre>();
    for (const v of registre)
      registreParCle.set(cle(v.nom), [
        ...(registreParCle.get(cle(v.nom)) ?? []),
        v,
      ]);
    const [stocke] = await this.ds.query<{ valeur: string }[]>(
      `SELECT valeur FROM parametre WHERE cle = $1`,
      [`MIS_DE_COTE:${etat.population}:${etat.mois}`],
    );
    const misDeCote = new Map<string, string>();
    if (stocke)
      for (const l of (
        JSON.parse(stocke.valeur) as {
          lignes: { nom: string | null; raison: string }[];
        }
      ).lignes)
        if (l.nom) misDeCote.set(cle(l.nom), l.raison);
    const RAISONS: Record<string, string> = {
      SANS_NOM: 'ligne sans nom',
      DOUBLON_FICHIER: 'doublon dans l’état du DG',
      ABSENT_NON_AJOUTE: 'absent du registre, non ajouté',
      SANS_BAREME: 'cycle non renseigné',
    };

    // 1. Même nom, un pour un ; 2. nom proche (à vérifier)
    const parCle = new Map<string, number[]>();
    sys.forEach((s, i) =>
      parCle.set(cle(s.nom), [...(parCle.get(cle(s.nom)) ?? []), i]),
    );
    const pris = new Set<number>();
    const paires: {
      f: (typeof fichier)[number];
      s: (typeof sys)[number];
      proche: boolean;
    }[] = [];
    const reste: (typeof fichier)[number][] = [];
    const vusDansFichier = new Map<string, number>();
    const enDouble = new Set<(typeof fichier)[number]>();
    for (const f of fichier) {
      const k = cle(f.nom);
      vusDansFichier.set(k, (vusDansFichier.get(k) ?? 0) + 1);
      const i = (parCle.get(k) ?? []).find((j) => !pris.has(j));
      if (i !== undefined) {
        pris.add(i);
        paires.push({ f, s: sys[i], proche: false });
      } else {
        if ((vusDansFichier.get(k) ?? 0) > 1) enDouble.add(f);
        reste.push(f);
      }
    }
    const idx = new IndexNoms<number>();
    sys.forEach((s, i) => {
      if (!pris.has(i)) idx.ajouter(s.nom, null, i);
    });
    const retires: (typeof fichier)[number][] = [];
    for (const f of reste) {
      const i = enDouble.has(f)
        ? undefined
        : idx.probables(f.nom, null).find((j) => !pris.has(j));
      if (i !== undefined) {
        pris.add(i);
        paires.push({ f, s: sys[i], proche: true });
      } else retires.push(f);
    }

    const lib = (code: string | null) =>
      code
        ? (this.config.categorie(code, etat.population)?.libelle ?? code)
        : null;
    const depDe = (id: number | null) => (id ? (deps.get(id) ?? '') : '');
    const origine = (source: string | null) =>
      source
        ? source.split(' · ')[0].replace(/\.xlsx$/i, '')
        : 'saisie à l’écran';
    const lignes: LigneEcartBourse[] = [];
    // Ajoutés
    sys.forEach((s, i) => {
      if (pris.has(i)) return;
      lignes.push({
        type: 'AJOUT',
        nom: s.nom,
        nomFichier: null,
        departement: depDe(s.departementId),
        cycleFichier: null,
        montantFichier: 0,
        categorieSysteme: lib(s.categorie),
        montantSysteme: Number(s.total),
        incidence: Number(s.total),
        motif:
          s.mois > 1
            ? `Rappel de ${s.mois} mois`
            : `Ajouté au registre (${origine(s.source)})`,
        detail: s.creeLe ? `Ajouté le ${dateFr(s.creeLe)}` : null,
      });
    });
    // Retirés : ce que dit le registre
    for (const f of retires) {
      const fiches = registreParCle.get(cle(f.nom)) ?? [];
      const v = fiches.find((x) => x.statut === 'SORTI') ?? fiches[0];
      let motif: string;
      let detail: string | null = null;
      if (enDouble.has(f)) motif = 'Même nom plusieurs fois dans le fichier';
      else if (misDeCote.has(cle(f.nom)))
        motif = `Mis de côté ce mois-ci (${RAISONS[misDeCote.get(cle(f.nom))!] ?? misDeCote.get(cle(f.nom))})`;
      else if (!v) motif = 'Absent du registre';
      else if (v.statut === 'SORTI') {
        motif = `Sorti du registre : ${this.config.motif(v.motifSortie)?.libelle ?? v.motifSortie ?? 'motif non précisé'}`;
        detail = v.dateSortie ? `Sortie le ${dateFr(v.dateSortie)}` : null;
      } else if (v.premierMois && v.premierMois > etat.mois)
        motif = `Payé seulement à partir de ${moisEnClair(v.premierMois)}`;
      else motif = 'En poste, mais pas dans l’état (à vérifier)';
      lignes.push({
        type: 'RETRAIT',
        nom: f.nom,
        nomFichier: null,
        departement: f.departement ?? '',
        cycleFichier: f.cycle,
        montantFichier: f.montant,
        categorieSysteme: null,
        montantSysteme: 0,
        incidence: -f.montant,
        motif,
        detail,
      });
    }
    // Montants différents
    for (const p of paires) {
      const ecart = Number(p.s.total) - p.f.montant;
      if (!ecart && !p.proche) continue;
      const motif = !ecart
        ? 'Nom écrit autrement (même montant, à vérifier)'
        : p.s.mois > 1
          ? `Rappel de ${p.s.mois} mois`
          : p.s.regularisation
            ? 'Régularisation (complément ou retenue)'
            : `Barème « ${lib(p.s.categorie) ?? '?'} » : ${p.f.montant.toLocaleString('fr-FR')} → ${Number(p.s.montant).toLocaleString('fr-FR')} F`;
      lignes.push({
        type: 'MONTANT',
        nom: p.s.nom,
        nomFichier: p.proche ? p.f.nom : null,
        departement: depDe(p.s.departementId),
        cycleFichier: p.f.cycle,
        montantFichier: p.f.montant,
        categorieSysteme: lib(p.s.categorie),
        montantSysteme: Number(p.s.total),
        incidence: ecart,
        motif,
        detail: p.proche ? `Nom dans le fichier : ${p.f.nom}` : null,
      });
    }
    lignes.sort(
      (a, b) =>
        a.type.localeCompare(b.type) ||
        a.motif.localeCompare(b.motif) ||
        a.departement.localeCompare(b.departement) ||
        a.nom.localeCompare(b.nom),
    );
    const groupes = new Map<string, GroupeEcart>();
    for (const l of lignes) {
      const k = `${l.type}|${l.motif}`;
      const g = groupes.get(k) ?? {
        type: l.type,
        motif: l.motif,
        n: 0,
        incidence: 0,
      };
      g.n++;
      g.incidence += l.incidence;
      groupes.set(k, g);
    }
    const initial = {
      n: fichier.length,
      total: fichier.reduce((t, x) => t + x.montant, 0),
    };
    const systeme = {
      n: sys.length,
      total: sys.reduce((t, x) => t + Number(x.total), 0),
    };
    return {
      etat: {
        id: etat.id,
        mois: etat.mois,
        population: etat.population,
        statut: etat.statut,
      },
      feuille: choisie.nom,
      feuilles: feuilles.map((f) => ({
        nom: f.nom,
        personnes: f.personnes,
        total: f.total,
      })),
      initial,
      systeme,
      ecart: systeme.total - initial.total,
      identiques: paires.filter(
        (p) => !p.proche && Number(p.s.total) === p.f.montant,
      ).length,
      nomsProches: paires.filter((p) => p.proche).length,
      groupes: [...groupes.values()].sort(
        (a, b) =>
          ['AJOUT', 'RETRAIT', 'MONTANT'].indexOf(a.type) -
            ['AJOUT', 'RETRAIT', 'MONTANT'].indexOf(b.type) || b.n - a.n,
      ),
      lignes,
    };
  }

  async excelBourse(
    contenu: Buffer,
    nomFichier: string,
    etatId: number,
    feuille?: string,
  ) {
    const r = await this.comparerBourse(contenu, etatId, feuille);
    const pop =
      r.etat.population === 'COMMUNAUTAIRE'
        ? 'des enseignants communautaires'
        : 'des enseignants volontaires';
    const mois = moisEnClair(r.etat.mois);
    const x = new Classeur(
      `COMPARAISON DU FICHIER INITIAL ET DE L’ÉTAT DU SYSTÈME — ${r.etat.population === 'COMMUNAUTAIRE' ? 'COMMUNAUTAIRES' : 'VOLONTAIRES'}, ${mois.toUpperCase()}`,
      `Paiement ${pop}, ${mois} · fichier « ${nomFichier} », feuille « ${r.feuille} » · état du système ${r.etat.statut === 'VALIDE' ? 'validé' : 'en projet'} · comparé le ${new Date().toLocaleDateString('fr-FR')}`,
    );
    // Synthèse
    const s = x.feuille('Synthèse', [46, 14, 20]);
    let l = x.titres(s, 13, ['', 'Personnes', 'Montant (FCFA)']);
    x.ligne(s, l++, ['Fichier initial', r.initial.n, r.initial.total]);
    x.ligne(s, l++, ['État du système', r.systeme.n, r.systeme.total]);
    x.ligne(
      s,
      l++,
      ['Écart (système − fichier)', r.systeme.n - r.initial.n, r.ecart],
      true,
      'FFD9EAD3',
    );
    l++;
    l = x.titres(s, l, ['L’écart, expliqué', 'Personnes', 'Incidence (FCFA)']);
    let type: TypeEcart | null = null;
    for (const g of r.groupes) {
      if (g.type !== type) {
        type = g.type;
        const sous = r.groupes.filter((y) => y.type === type);
        x.ligne(
          s,
          l++,
          [
            LIBELLES_TYPE[type],
            sous.reduce((n, y) => n + y.n, 0),
            sous.reduce((n, y) => n + y.incidence, 0),
          ],
          true,
          'FFF1F5F2',
        );
      }
      x.ligne(s, l++, [`   ${g.motif}`, g.n, g.incidence]);
    }
    x.ligne(
      s,
      l++,
      [
        'Total des écarts (égal à l’écart ci-dessus)',
        r.groupes.reduce((n, y) => n + y.n, 0),
        r.groupes.reduce((n, y) => n + y.incidence, 0),
      ],
      true,
      'FFD9EAD3',
    );
    l++;
    x.note(
      s,
      l,
      3,
      `Personnes identiques dans les deux (même nom, même montant) : ${r.identiques}. Noms écrits autrement, rapprochés par ressemblance (à vérifier) : ${r.nomsProches}. Rapprochement par le nom (mots dans n’importe quel ordre).`,
    );
    // Une feuille par type d'écart
    const cols = [
      'N°',
      'Nom et prénoms',
      'Département',
      'Cycle (fichier)',
      'Montant fichier',
      'Catégorie (système)',
      'Montant système',
      'Incidence',
      'Motif',
      'Précision',
    ];
    for (const t of ['AJOUT', 'RETRAIT', 'MONTANT'] as TypeEcart[]) {
      const lignes = r.lignes.filter((y) => y.type === t);
      const f = x.feuille(
        t === 'AJOUT'
          ? 'Ajoutés'
          : t === 'RETRAIT'
            ? 'Retirés'
            : 'Montants différents',
        [6, 34, 16, 18, 13, 20, 13, 13, 40, 28],
        true,
      );
      let k = x.titres(f, 13, cols);
      lignes.forEach((y, i) =>
        x.ligne(f, k++, [
          i + 1,
          y.nom,
          y.departement,
          y.cycleFichier ?? '',
          y.montantFichier,
          y.categorieSysteme ?? '',
          y.montantSysteme,
          y.incidence,
          y.motif,
          y.detail ?? '',
        ]),
      );
      x.ligne(
        f,
        k,
        [
          '',
          `TOTAL (${lignes.length})`,
          '',
          '',
          lignes.reduce((n, y) => n + y.montantFichier, 0),
          '',
          lignes.reduce((n, y) => n + y.montantSysteme, 0),
          lignes.reduce((n, y) => n + y.incidence, 0),
          '',
          '',
        ],
        true,
        'FFD9EAD3',
      );
    }
    return {
      nom: `Comparaison ${r.etat.population === 'COMMUNAUTAIRE' ? 'Communautaires' : 'Volontaires'} ${mois} - fichier initial et système.xlsx`,
      contenu: await x.tampon(),
    };
  }

  /* ---------------------------------- Enrôlement ---------------------------------- */

  async comparerEnrolement(contenu: Buffer, campagneId: number) {
    const [camp] = await this.ds.query<
      {
        id: number;
        annee: number;
        montantsParCycle: Record<string, number> | null;
      }[]
    >(
      `SELECT id, annee, "montantsParCycle" FROM campagne_enrolement WHERE id = $1`,
      [campagneId],
    );
    if (!camp) throw new NotFoundException('Campagne introuvable.');
    const feuilles = (
      await lireClasseur(contenu, ['NOMSETPRENOMS|NOMETPRENOMS|NOMSPRENOMS'], {
        inclureMasquees: false,
      })
    )
      .map((f) => ({ f, l: personnes(f) }))
      .filter((x) => x.l.length);
    if (!feuilles.length)
      throw new BadRequestException(
        'Aucune feuille avec une colonne « Noms et prénoms » dans ce fichier.',
      );
    const fichier = feuilles.flatMap(({ f, l }) => {
      const retrait = /RETRAIT|ECART|REJET|NON ?RETENU/i.test(
        normaliser(f.nom),
      );
      return l.map((x) => ({
        feuille: f.nom,
        retrait,
        nom: nettoyer(valeur(x, NOMS))!,
        naissance: lireDate(valeur(x, ['DATEDENAIS', 'DATENAIS', 'NELE'])),
        cycle: nettoyer(valeur(x, ['CYCLE'])),
        departementRetenu: nettoyer(
          valeur(x, ['DEPARTEMENTRETENU', 'DEPARTEMENTRET']),
        ),
      }));
    });
    const deps = await this.ds.query<{ id: number; nom: string }[]>(
      `SELECT id, nom FROM departement`,
    );
    const sys = await this.ds.query<
      {
        id: string;
        nom: string;
        naissance: string | null;
        cycle: string | null;
        etat: string;
        dep: number | null;
        ecarte: boolean;
        motif: string | null;
      }[]
    >(
      `SELECT id, "nomComplet" AS nom, to_char("dateNaissance", 'YYYY-MM-DD') AS naissance, cycle, etat,
              "departementRetenuId" AS dep, "ecarteDejaConnu" AS ecarte, "motifDecision" AS motif
         FROM enrole WHERE "campagneId" = $1`,
      [campagneId],
    );
    const bourse = (cycle: string | null) =>
      (cycle && camp.montantsParCycle?.[cycle]) ||
      (cycle ? this.config.categorieDepuisTexte(cycle)?.bourse : 0) ||
      0;
    const equipement = (cycle: string | null) =>
      (cycle ? this.config.categorieDepuisTexte(cycle)?.equipement : 0) || 0;
    const situation = (e: (typeof sys)[number]) =>
      e.etat === 'RETENU'
        ? e.dep
          ? 'Retenu, département retenu choisi'
          : 'Retenu (validé), département retenu pas encore choisi'
        : e.etat === 'NON_RETENU'
          ? e.ecarte
            ? 'Écarté (déjà connu ailleurs : mis de côté)'
            : 'Non retenu'
          : 'Pas encore décidé (contrôle en cours)';
    const nomDep = (id: number | null) =>
      id ? (deps.find((d) => d.id === id)?.nom ?? '') : '';

    // Rapprochement : même nom (même date de préférence), puis nom proche
    const parCle = new Map<string, number[]>();
    sys.forEach((e, i) =>
      parCle.set(cle(e.nom), [...(parCle.get(cle(e.nom)) ?? []), i]),
    );
    const idx = new IndexNoms<number>();
    sys.forEach((e, i) => idx.ajouter(e.nom, e.naissance, i));
    const pris = new Set<number>();
    const lien: {
      f: (typeof fichier)[number];
      e: (typeof sys)[number];
      proche: boolean;
    }[] = [];
    const absents: (typeof fichier)[number][] = [];
    for (const f of fichier) {
      const l = (parCle.get(cle(f.nom)) ?? []).filter((i) => !pris.has(i));
      let i: number | undefined =
        l.find((j) => f.naissance && sys[j].naissance === f.naissance) ?? l[0];
      let proche = false;
      if (i === undefined) {
        i = idx.probables(f.nom, f.naissance).find((j) => !pris.has(j));
        proche = i !== undefined;
      }
      if (i === undefined) {
        absents.push(f);
        continue;
      }
      pris.add(i);
      lien.push({ f, e: sys[i], proche });
    }
    const sansFichier = sys.filter((_, i) => !pris.has(i));

    // Le système, par situation
    const parSituation = new Map<
      string,
      { situation: string; n: number; bourse: number; equipement: number }
    >();
    for (const e of sys) {
      const k = situation(e);
      const x = parSituation.get(k) ?? {
        situation: k,
        n: 0,
        bourse: 0,
        equipement: 0,
      };
      x.n++;
      x.bourse += bourse(e.cycle);
      x.equipement += equipement(e.cycle);
      parSituation.set(k, x);
    }
    const ligne = (
      type: string,
      e: (typeof sys)[number] | null,
      f: (typeof fichier)[number] | null,
      motif: string,
    ) => ({
      type,
      nom: e?.nom ?? f!.nom,
      nomFichier: f && e && cle(f.nom) !== cle(e.nom) ? f.nom : null,
      feuille: f?.feuille ?? null,
      cycle: e?.cycle ?? f?.cycle ?? null,
      situation: e ? situation(e) : 'Absent du système',
      departementRetenuFichier: f?.departementRetenu ?? null,
      departementRetenuSysteme: e ? nomDep(e.dep) || null : null,
      bourse: e?.etat === 'RETENU' ? bourse(e.cycle) : 0,
      equipement: e?.etat === 'RETENU' ? equipement(e.cycle) : 0,
      motif,
    });
    const lignes = [
      ...absents
        .filter((f) => !f.retrait)
        .map((f) =>
          ligne('FICHIER_SEUL', null, f, 'Dans le fichier, absent du système'),
        ),
      ...sansFichier.map((e) =>
        ligne('SYSTEME_SEUL', e, null, 'Dans le système, absent du fichier'),
      ),
      ...lien
        .filter((p) => p.f.retrait && p.e.etat === 'RETENU')
        .map((p) =>
          ligne(
            'RETRAIT_RETENU',
            p.e,
            p.f,
            `Retiré dans le fichier (feuille « ${p.f.feuille} »), retenu dans le système`,
          ),
        ),
      ...lien
        .filter(
          (p) =>
            !p.f.retrait &&
            p.f.departementRetenu &&
            normaliser(p.f.departementRetenu) !== normaliser(nomDep(p.e.dep)),
        )
        .map((p) =>
          ligne('DEPARTEMENT', p.e, p.f, 'Département retenu différent'),
        ),
      ...lien
        .filter((p) => p.proche)
        .map((p) =>
          ligne('NOM_PROCHE', p.e, p.f, 'Nom écrit autrement (à vérifier)'),
        ),
    ];
    const compte = (t: string) => {
      const l = lignes.filter((x) => x.type === t);
      return {
        n: l.length,
        bourse: l.reduce((s, x) => s + x.bourse, 0),
        equipement: l.reduce((s, x) => s + x.equipement, 0),
      };
    };
    return {
      campagne: { id: camp.id, annee: camp.annee },
      fichier: {
        feuilles: feuilles.map(({ f, l }) => ({
          nom: f.nom,
          personnes: l.length,
          retrait: /RETRAIT|ECART|REJET|NON ?RETENU/i.test(normaliser(f.nom)),
        })),
        n: fichier.filter((f) => !f.retrait).length,
        retraits: fichier.filter((f) => f.retrait).length,
      },
      systeme: { n: sys.length, parSituation: [...parSituation.values()] },
      rapproches: lien.length,
      ecarts: {
        FICHIER_SEUL: compte('FICHIER_SEUL'),
        SYSTEME_SEUL: compte('SYSTEME_SEUL'),
        RETRAIT_RETENU: compte('RETRAIT_RETENU'),
        DEPARTEMENT: compte('DEPARTEMENT'),
        NOM_PROCHE: compte('NOM_PROCHE'),
      },
      retraitsCoherents: lien.filter(
        (p) => p.f.retrait && p.e.etat !== 'RETENU',
      ).length,
      lignes,
    };
  }

  async excelEnrolement(
    contenu: Buffer,
    nomFichier: string,
    campagneId: number,
  ) {
    const r = await this.comparerEnrolement(contenu, campagneId);
    const x = new Classeur(
      `COMPARAISON DU FICHIER D’ENRÔLEMENT ET DU SYSTÈME — ENRÔLEMENT ${r.campagne.annee}`,
      `Fichier « ${nomFichier} » (${r.fichier.n} dossier(s), ${r.fichier.retraits} retrait(s)) · comparé le ${new Date().toLocaleDateString('fr-FR')}`,
    );
    const s = x.feuille('Synthèse', [52, 12, 20, 22]);
    let l = x.titres(s, 13, [
      'Enrôlés dans le système, par situation',
      'Personnes',
      'Bourse par mois (FCFA)',
      'Mise d’équipement (FCFA)',
    ]);
    for (const p of r.systeme.parSituation)
      x.ligne(s, l++, [p.situation, p.n, p.bourse, p.equipement]);
    x.ligne(
      s,
      l++,
      [
        'TOTAL',
        r.systeme.n,
        r.systeme.parSituation.reduce((t, p) => t + p.bourse, 0),
        r.systeme.parSituation.reduce((t, p) => t + p.equipement, 0),
      ],
      true,
      'FFD9EAD3',
    );
    l++;
    l = x.titres(s, l, [
      'Écarts entre le fichier et le système',
      'Personnes',
      'Bourse par mois (FCFA)',
      'Mise d’équipement (FCFA)',
    ]);
    const LIB: Record<string, string> = {
      FICHIER_SEUL: 'Dans le fichier, absents du système',
      SYSTEME_SEUL: 'Dans le système, absents du fichier',
      RETRAIT_RETENU: 'Retirés dans le fichier mais retenus dans le système',
      DEPARTEMENT: 'Département retenu différent',
      NOM_PROCHE: 'Nom écrit autrement (à vérifier)',
    };
    for (const [k, v] of Object.entries(r.ecarts))
      x.ligne(s, l++, [LIB[k], v.n, v.bourse, v.equipement]);
    l++;
    x.note(
      s,
      l,
      4,
      `Personnes rapprochées entre le fichier et le système : ${r.rapproches}. Retraits du fichier qui ne sont pas retenus dans le système (cohérent) : ${r.retraitsCoherents}. La bourse et la mise d’équipement ne sont comptées que pour les retenus.`,
    );
    const cols = [
      'N°',
      'Nom et prénoms',
      'Nom dans le fichier',
      'Feuille',
      'Cycle',
      'Situation dans le système',
      'Département retenu (fichier)',
      'Département retenu (système)',
      'Bourse / mois',
      'Équipement',
      'Écart',
    ];
    for (const [k, titre] of Object.entries(LIB)) {
      const lignes = r.lignes.filter((y) => y.type === k);
      const f = x.feuille(
        titre.slice(0, 31),
        [6, 32, 26, 14, 14, 34, 18, 18, 12, 12, 40],
        true,
      );
      let j = x.titres(f, 13, cols);
      lignes.forEach((y, i) =>
        x.ligne(f, j++, [
          i + 1,
          y.nom,
          y.nomFichier ?? '',
          y.feuille ?? '',
          y.cycle ?? '',
          y.situation,
          y.departementRetenuFichier ?? '',
          y.departementRetenuSysteme ?? '',
          y.bourse,
          y.equipement,
          y.motif,
        ]),
      );
      x.ligne(
        f,
        j,
        [
          '',
          `TOTAL (${lignes.length})`,
          '',
          '',
          '',
          '',
          '',
          '',
          lignes.reduce((t, y) => t + y.bourse, 0),
          lignes.reduce((t, y) => t + y.equipement, 0),
          '',
        ],
        true,
        'FFD9EAD3',
      );
    }
    return {
      nom: `Comparaison Enrôlement ${r.campagne.annee} - fichier et système.xlsx`,
      contenu: await x.tampon(),
    };
  }
}

/** Un classeur aux couleurs de la DGRHAS : en-tête officiel, titres verts, sans volets figés. */
class Classeur {
  private wb = new ExcelJS.Workbook();
  private readonly VERT = 'FF0F5132';
  private readonly bords: Partial<ExcelJS.Borders>;

  constructor(
    private readonly titre: string,
    private readonly sousTitre: string,
  ) {
    this.wb.creator = 'SIGRHAS-MEPPSA';
    const fin: Partial<ExcelJS.Border> = {
      style: 'thin',
      color: { argb: 'FFBDBDBD' },
    };
    this.bords = { top: fin, bottom: fin, left: fin, right: fin };
  }

  feuille(nom: string, largeurs: number[], paysage = false) {
    const ws = this.wb.addWorksheet(nom, {
      pageSetup: {
        paperSize: 9,
        orientation: paysage ? 'landscape' : 'portrait',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        printTitlesRow: '13:13',
      },
      headerFooter: { oddFooter: '&R&8Page &P sur &N' },
    });
    largeurs.forEach((l, i) => (ws.getColumn(i + 1).width = l));
    const n = largeurs.length;
    const ecrire = (
      l: number,
      c1: number,
      c2: number,
      v: string,
      font: Partial<ExcelJS.Font>,
    ) => {
      if (c2 > c1) ws.mergeCells(l, c1, l, c2);
      const x = ws.getCell(l, c1);
      x.value = v;
      x.font = { name: 'Calibri', ...font };
      x.alignment = {
        horizontal: 'center',
        vertical: 'middle',
        wrapText: true,
      };
    };
    const g = { size: 11, bold: true };
    const gauche = Math.max(1, Math.min(3, n - 2));
    const d1 = Math.max(gauche + 1, n - 1);
    ecrire(1, 1, gauche, "MINISTERE DE L'ENSEIGNEMENT PRESCOLAIRE,", g);
    ecrire(1, d1, n, 'REPUBLIQUE DU CONGO', g);
    ecrire(2, 1, gauche, "PRIMAIRE, SECONDAIRE ET DE L'ALPHABETISATION", g);
    ecrire(2, d1, n, 'Unité - Travail - Progrès', g);
    ecrire(3, 1, gauche, '-----------', g);
    ecrire(3, d1, n, '-----------', g);
    ecrire(4, 1, gauche, 'CABINET', g);
    ecrire(5, 1, gauche, '-----------', g);
    ecrire(6, 1, gauche, 'DIRECTION GENERALE DES RESSOURCES HUMAINES', g);
    ecrire(7, 1, gauche, "ET DE L'ADMINISTRATION SCOLAIRE", g);
    ecrire(8, 1, gauche, '-----------', g);
    ecrire(10, 1, n, this.titre, {
      size: 13,
      bold: true,
      color: { argb: this.VERT },
    });
    ecrire(11, 1, n, this.sousTitre, { size: 10, italic: true });
    ws.getRow(10).height = 34;
    ws.getRow(11).height = 30;
    return ws;
  }

  /** Les titres de colonnes ; renvoie la ligne suivante. */
  titres(ws: ExcelJS.Worksheet, l: number, noms: string[]) {
    const r = ws.getRow(l);
    noms.forEach((t, i) => {
      const x = r.getCell(i + 1);
      x.value = t;
      x.font = {
        name: 'Calibri',
        size: 10,
        bold: true,
        color: { argb: 'FFFFFFFF' },
      };
      x.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: this.VERT },
      };
      x.alignment = {
        horizontal: 'center',
        vertical: 'middle',
        wrapText: true,
      };
      x.border = this.bords;
    });
    r.height = 30;
    return l + 1;
  }

  ligne(
    ws: ExcelJS.Worksheet,
    l: number,
    valeurs: ExcelJS.CellValue[],
    gras = false,
    fond?: string,
  ) {
    const r = ws.getRow(l);
    valeurs.forEach((v, i) => {
      const x = r.getCell(i + 1);
      x.value = v;
      x.border = this.bords;
      x.font = { name: 'Calibri', size: 10, bold: gras };
      x.alignment = {
        vertical: 'middle',
        wrapText: true,
        horizontal: typeof v === 'number' ? 'right' : 'left',
      };
      if (typeof v === 'number') x.numFmt = '#,##0';
      if (fond)
        x.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fond } };
    });
  }

  note(ws: ExcelJS.Worksheet, l: number, nbCol: number, t: string) {
    ws.mergeCells(l, 1, l, nbCol);
    const x = ws.getCell(l, 1);
    x.value = t;
    x.font = {
      name: 'Calibri',
      size: 9,
      italic: true,
      color: { argb: 'FF52525B' },
    };
    x.alignment = { wrapText: true, vertical: 'top' };
    ws.getRow(l).height = Math.max(15, Math.ceil(t.length / 90) * 13);
  }

  async tampon() {
    return Buffer.from(await this.wb.xlsx.writeBuffer());
  }
}
