import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { cycleDepuis } from '../circuit/structures-import.service';
import { lireClasseur } from '../common/excel';
import { nomEcole } from '../common/nom-ecole';
import { codeDepartement } from '../common/referentiels';
import { cleCompacte, enTexte, normaliser } from '../common/texte';
import { JournalService } from '../core/core.service';
import { Departement, Structure } from '../entities';

/**
 * Répertoire officiel des établissements publics (DGRHAS, 20/11/2026 : « REPERTOIRE ETABLISSEMENTS
 * PUBLICS_2025.xlsx », une feuille par département : département, commune, arrondissement, cycle,
 * zone, secteur, nom). Il devient la référence des écoles :
 *  - une école déjà dans l'organigramme prend le nom du répertoire (« la façon d'écrire du
 *    fichier ») et garde ses anciens noms, pour rester reconnue dans les fiches et les fichiers ;
 *  - une école absente est ajoutée dans l'inspection qui tient déjà les écoles du même cycle de sa
 *    localité (le répertoire ne donne pas l'inspection).
 * Un essai d'abord : rien n'est enregistré sans les cases cochées par la DGRHAS.
 */

export type EtatRepertoire =
  'IDENTIQUE' | 'RENOMMER' | 'PROBABLE' | 'AJOUTER' | 'A_PLACER' | 'DOUBLON';

export interface PropositionRepertoire {
  /** « feuille|ligne » : retrouve la ligne du répertoire à l'enregistrement. */
  cle: string;
  feuille: string;
  ligne: number;
  departementId: number;
  departement: string;
  cycle: string;
  /** Tel qu'écrit dans le répertoire. */
  nomRepertoire: string;
  /** Le nom qui sera enregistré (celui du répertoire, précédé du type d'école s'il manque). */
  nomPropose: string;
  typeLocalite: string | null;
  localite: string | null;
  zone: string | null;
  etat: EtatRepertoire;
  /** Ressemblance des noms (0-100) pour une école retrouvée. */
  ressemblance: number | null;
  memeLocalite: boolean | null;
  structureId: number | null;
  nomActuel: string | null;
  localiteActuelle: string | null;
  inspectionId: number | null;
  inspection: string | null;
  /** Pour une ressemblance écartée : l'inspection où l'ajouter comme autre école. */
  inspectionAjoutId?: number | null;
  pourquoi: string | null;
  /** Coché d'office dans l'essai. */
  cochee: boolean;
}

export interface RapportRepertoire {
  lues: number;
  feuilles: string[];
  ignorees: { raison: string; n: number; exemples: string[] }[];
  compteurs: Record<EtatRepertoire, number>;
  propositions: PropositionRepertoire[];
  /** Inspections d'un département et d'un cycle (« depId|CYCLE »), pour placer une école. */
  inspections: Record<string, { id: number; nom: string }[]>;
  /** Écoles de l'organigramme que le répertoire ne cite pas (laissées telles quelles). */
  horsRepertoire: number;
}

interface LigneRepertoire {
  cle: string;
  feuille: string;
  ligne: number;
  departementId: number;
  departement: string;
  cycle: string;
  nomRepertoire: string;
  nomPropose: string;
  typeLocalite: string | null;
  localite: string | null;
  zone: string | null;
  nomCle: string;
  locCle: string;
  communeCle: string;
}

const MOIS = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
];

/** Texte d'une cellule ; une date (« 18 mars 1977 » devenue date dans Excel) redevient un nom. */
function cellule(v: unknown): string {
  if (v instanceof Date && !isNaN(v.getTime()))
    return `${v.getUTCDate()} ${MOIS[v.getUTCMonth()]} ${v.getUTCFullYear()}`;
  return enTexte(v).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Mots qui ne distinguent pas une école (son type, les articles). */
const GENERIQUES = new Set([
  'ECOLE',
  'ECOLES',
  'PRIMAIRE',
  'PRIMAIRES',
  'EP',
  'EPP',
  'CEG',
  'COLLEGE',
  'ENSEIGNEMENT',
  'GENERAL',
  'LYCEE',
  'LEG',
  'CEP',
  'CENTRE',
  'CENTRES',
  'EDUCATION',
  'PRESCOLAIRE',
  'CS',
  'ALPHABETISATION',
  'ALPHA',
  'CA',
  'RESCOLARISATION',
  'RESCOL',
  'POST',
  'PUBLIQUE',
  'PUBLIC',
  'ET',
  'DE',
  'DU',
  'DES',
  'D',
  'LA',
  'LE',
  'LES',
  'L',
  'A',
  'AU',
]);

/** Le nom propre de l'école : « École primaire Obangui A » → « OBANGUI A ». */
export function cleNomEcole(nom: string): string {
  const brut = normaliser(nom)
    .replace(/[^A-Z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
  // Initiales réunies : « A. A. NETO » → « AA NETO », « C E P » → « CEP »
  const mots: string[] = [];
  for (let i = 0; i < brut.length; i++) {
    let j = i;
    while (j < brut.length && /^[A-Z]$/.test(brut[j])) j++;
    if (j - i >= 2 && j < brut.length) {
      mots.push(brut.slice(i, j).join(''));
      i = j - 1;
    } else mots.push(brut[i]);
  }
  // « A » reste quand c'est la lettre de l'école (« OBANGUI A »), pas l'article (« A L'ECOLE »)
  return mots
    .filter(
      (m, i) =>
        !GENERIQUES.has(m) ||
        // « A » final : la lettre de l'école ; « CENTRE » final : « Mayeye Centre », pas son type
        ((m === 'A' || m === 'CENTRE') && i === mots.length - 1 && i > 0),
    )
    .join(' ');
}

/** Mots qui font une autre école quand ils s'ajoutent au nom (« Annexe Mayeye », « Ouenzé Nord »). */
const DISTINCTIFS = new Set([
  'ANNEXE',
  'CENTRE',
  'NORD',
  'SUD',
  'EST',
  'OUEST',
  'NOUVELLE',
  'NOUVEAU',
  'ANCIENNE',
  'ANCIEN',
  'VILLAGE',
  'GARE',
  'PLATEAU',
  'PORT',
  'BIS',
  'I',
  'II',
  'III',
  'IV',
]);

/** Lettre ou numéro qui distingue deux écoles du même nom (« A », « B », « 1 », « 2A »). */
function marque(cle: string): string | null {
  const m = /(?:^|\s)([A-D]|\d{1,2}[A-D]?|[A-D]\d)$/.exec(cle);
  return m ? m[1] : null;
}

/**
 * Lettres communes (méthode de Ratcliff et Obershelp, celle de l'analyse du 20/11/2026) : la plus
 * longue suite commune, puis la même chose à sa gauche et à sa droite.
 */
function lettresCommunes(a: string, b: string): number {
  if (!a || !b) return 0;
  let meilleur = 0;
  let ia = 0;
  let ib = 0;
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++) {
      let k = 0;
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++;
      if (k > meilleur) {
        meilleur = k;
        ia = i;
        ib = j;
      }
    }
  if (!meilleur) return 0;
  return (
    meilleur +
    lettresCommunes(a.slice(0, ia), b.slice(0, ib)) +
    lettresCommunes(a.slice(ia + meilleur), b.slice(ib + meilleur))
  );
}

/** Ressemblance de deux noms propres d'école, de 0 à 1. */
export function ressemblanceEcoles(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  // « Okoyo Centre » et « Okoyo » : peut-être la même école, à confirmer seulement
  const centre = / CENTRE$/;
  if (centre.test(a) !== centre.test(b))
    return Math.min(
      0.86,
      ressemblanceEcoles(a.replace(centre, ''), b.replace(centre, '')),
    );
  const ma = marque(a);
  const mb = marque(b);
  // « OBANGUI A » n'est pas « OBANGUI B », ni « OWANDO 1 » « OWANDO 2 »
  if (ma && mb && ma !== mb) return 0.4;
  const ka = a.replace(/ /g, '');
  const kb = b.replace(/ /g, '');
  let r = (2 * lettresCommunes(a, b)) / (a.length + b.length);
  // Nom raccourci (« MALONGA MAYAMA » / « MALONGA MA MAYAMA DE KIBOSSI »)
  const [court, long] = ka.length <= kb.length ? [a, b] : [b, a];
  const enPlus = long.split(' ').filter((m) => !court.split(' ').includes(m));
  if (
    Math.min(ka.length, kb.length) >= 5 &&
    (ka.includes(kb) || kb.includes(ka))
  )
    r = enPlus.some((m) => DISTINCTIFS.has(m))
      ? Math.min(r, 0.7)
      : Math.max(r, 0.9);
  // L'une marquée (« SOLIDARITE A »), l'autre non (« SOLIDARITE ») : à confirmer seulement
  if (!!ma !== !!mb) r = Math.min(r, 0.85);
  return r;
}

/**
 * Le nom d'une école du répertoire (DG, 21/11/2026) : le préfixe de son cycle et son nom propre,
 * quoi que le répertoire écrive devant (« MOUNDZOMBO B », « ECOLE PRIMAIRE MOUNDZOMBO B » →
 * « EP MOUNDZOMBO B »).
 */
export function nomOfficiel(nom: string, cycle: string): string {
  return nomEcole(cycle, nom);
}

/** Ancienne règle (avant le 21/11/2026) : le type ajouté seulement s'il manquait. */
export function nomOfficielAncien(nom: string, cycle: string): string {
  const k = ` ${normaliser(nom).replace(/[^A-Z0-9]+/g, ' ')} `;
  const a = (re: RegExp) => re.test(k);
  switch (cycle) {
    case 'PRIMAIRE':
      return a(/ (EP|EPP|ECOLE|PRIMAIRE) /) ? nom : `École primaire ${nom}`;
    case 'COLLEGE':
      return a(/ (CEG|COLLEGE) /) ? nom : `CEG ${nom}`;
    case 'LYCEE':
      return a(/ (LYCEE|LEG) /) ? nom : `Lycée ${nom}`;
    case 'PRESCOLAIRE':
      return a(/ (CEP|PRESCOLAIRE|CS|CENTRE D EDUCATION) /)
        ? nom
        : `CEP ${nom}`;
    case 'ALPHABETISATION':
      return a(/ (ALPHA|ALPHABETISATION|RESCOLARISATION|POST) /) ||
        a(/^ CENTRE /)
        ? nom
        : `Centre d’alphabétisation ${nom}`;
    default:
      return nom;
  }
}

/** Même écriture aux accents, aux majuscules et à la ponctuation près (« LEWEME » / « Léwémé »). */
export function memeEcriture(a: string, b: string): boolean {
  const k = (x: string) =>
    normaliser(x)
      .replace(/[^A-Z0-9]+/g, ' ')
      .trim();
  return k(a) === k(b);
}

/**
 * Le nom du répertoire avec les accents de nos noms (DGRHAS, 20/11/2026 : on garde nos accents) :
 * « ECOLE PRIMAIRE DE LEWEME » et « École primaire Léwémé » → « ECOLE PRIMAIRE DE LÉWÉMÉ ».
 */
export function avecAccents(nom: string, sources: string[]): string {
  const accent = /[^\p{ASCII}]/u;
  const accentues = new Map<string, string>();
  for (const src of sources)
    for (const m of src.match(/[\p{L}\p{N}]+/gu) ?? [])
      if (accent.test(m) && !accentues.has(normaliser(m)))
        accentues.set(normaliser(m), m);
  return nom.replace(/[\p{L}\p{N}]+/gu, (mot) => {
    if (accent.test(mot)) return mot;
    const a = accentues.get(normaliser(mot));
    if (!a) return mot;
    if (mot === mot.toUpperCase()) return a.toLocaleUpperCase('fr');
    if (mot === mot.toLowerCase()) return a.toLocaleLowerCase('fr');
    return mot[0] + a.slice(1).toLocaleLowerCase('fr');
  });
}

/** Localité du répertoire : district à la campagne, arrondissement (ou commune) en ville. */
function localiteDe(
  commune: string,
  arrondissement: string,
): { type: string | null; nom: string | null; commune: string } {
  const m = /^\s*(district|disrict|dist\.?|commune)\s+(.*)$/i.exec(commune);
  const base = (m ? m[2] : commune).trim();
  if (!m) return { type: null, nom: base || null, commune: base };
  if (/^dis/i.test(m[1])) return { type: 'DISTRICT', nom: base, commune: base };
  // « AR_6_Talangaï », « AR_1_(Sibiti) », « AR_2_Soulouka(Nkayi) »
  const sansNumero = arrondissement.replace(/^AR\s*\d+\s*/i, '').trim();
  const nom = sansNumero.replace(/\(.*?\)/g, '').trim();
  if (nom) return { type: 'ARRONDISSEMENT', nom, commune: base };
  return { type: 'COMMUNE', nom: base, commune: base };
}

const locCle = (s: string | null | undefined) => cleCompacte(s ?? '');

@Injectable()
export class RepertoireEcolesService {
  constructor(
    @InjectRepository(Structure)
    private readonly structures: Repository<Structure>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    private readonly journal: JournalService,
  ) {}

  /** Les lignes publiques du répertoire, propres. */
  private async lire(contenu: Buffer) {
    const feuilles = await lireClasseur(contenu, ['NOMETABLISSEMENT']);
    if (!feuilles.length)
      throw new BadRequestException(
        'Aucune feuille avec la colonne « NOM_ETABLISSEMENT » : ce n’est pas le répertoire des établissements.',
      );
    const deps = await this.deps.find();
    const depParCode = new Map(deps.map((d) => [d.code, d]));
    const ignorees = new Map<string, { n: number; exemples: string[] }>();
    const ignorer = (raison: string, ex: string) => {
      const x = ignorees.get(raison) ?? { n: 0, exemples: [] };
      x.n++;
      if (x.exemples.length < 5) x.exemples.push(ex);
      ignorees.set(raison, x);
    };
    const lignes: LigneRepertoire[] = [];
    let lues = 0;
    for (const f of feuilles) {
      // Feuille SANGHA : en-tête décalé d'une colonne (la colonne du cycle n'a pas de titre)
      const decalee = !f.entetes.some((e) => e.startsWith('CYCLE'));
      for (const l of f.lignes) {
        const val = (k: string) => cellule(l[k]);
        const nomRep = val('NOMETABLISSEMENT');
        const brut = decalee
          ? {
              dep: f.nom,
              commune: val('DEPARTEMENT'),
              arr: val('COMMUNE'),
              cycle: val('ARRONDISSEMENT'),
            }
          : {
              dep: val('DEPARTEMENT') || f.nom,
              commune: val('COMMUNE'),
              arr: val('ARRONDISSEMENT'),
              cycle: val('CYCLEENSEIGNEMENT'),
            };
        const secteur = val('SECTEUR');
        if (!nomRep && !brut.cycle) continue;
        lues++;
        const ou = `${f.nom} ligne ${l._ligne}`;
        if (/TOTAL/i.test(secteur) || /^TOTAL/i.test(nomRep)) {
          ignorer('Ligne de total', ou);
          continue;
        }
        if (secteur && !/^PUBLIC/i.test(normaliser(secteur))) {
          ignorer(
            'École privée (le répertoire public seulement)',
            `${ou} : ${nomRep}`,
          );
          continue;
        }
        if (!nomRep) {
          ignorer('Sans nom d’établissement', ou);
          continue;
        }
        const code = codeDepartement(brut.dep) ?? codeDepartement(f.nom);
        const dep = code ? depParCode.get(code) : undefined;
        if (!dep) {
          ignorer('Département non reconnu', `${ou} : ${brut.dep}`);
          continue;
        }
        const cycle = /(^|[^P])RESCOL/.test(normaliser(brut.cycle))
          ? 'ALPHABETISATION'
          : cycleDepuis(brut.cycle);
        if (!cycle) {
          ignorer('Cycle non reconnu', `${ou} : ${nomRep} (« ${brut.cycle} »)`);
          continue;
        }
        const loc = localiteDe(brut.commune, brut.arr);
        const zone = /RUR/i.test(normaliser(val('ZONE')))
          ? 'RURALE'
          : /URB/i.test(normaliser(val('ZONE')))
            ? 'URBAINE'
            : null;
        lignes.push({
          cle: `${f.nom}|${l._ligne}`,
          feuille: f.nom,
          ligne: l._ligne,
          departementId: dep.id,
          departement: dep.nom,
          cycle,
          nomRepertoire: nomRep,
          nomPropose: nomOfficiel(nomRep, cycle),
          typeLocalite: loc.type,
          localite: loc.nom,
          zone,
          nomCle: cleNomEcole(nomRep),
          locCle: locCle(loc.nom),
          communeCle: locCle(loc.commune),
        });
      }
    }
    return {
      lignes,
      lues,
      feuilles: feuilles.map((f) => f.nom),
      ignorees: [...ignorees].map(([raison, x]) => ({ raison, ...x })),
    };
  }

  async analyser(contenu: Buffer): Promise<RapportRepertoire> {
    const { lignes, lues, feuilles, ignorees } = await this.lire(contenu);
    const tout = await this.structures.find({
      where: { type: In(['ETABLISSEMENT', 'INSPECTION']), actif: true },
    });
    const ecoles = tout.filter((s) => s.type === 'ETABLISSEMENT');
    const inspections = tout.filter((s) => s.type === 'INSPECTION');
    const inspParId = new Map(inspections.map((s) => [s.id, s]));
    const parGroupe = new Map<string, Structure[]>();
    for (const s of ecoles) {
      const k = `${s.departementId}|${s.cycle}`;
      parGroupe.set(k, [...(parGroupe.get(k) ?? []), s]);
    }
    const memeLocalite = (l: LigneRepertoire, s: Structure) => {
      const k = locCle(s.localite);
      if (!k || !l.locCle) return false;
      return (
        k === l.locCle ||
        k === l.communeCle ||
        (l.locCle.length >= 4 && (k.includes(l.locCle) || l.locCle.includes(k)))
      );
    };

    // Candidats (ligne du répertoire, école de l'organigramme), les meilleurs d'abord ; une école
    // de l'organigramme ne sert qu'une fois
    const candidats: {
      i: number;
      s: Structure;
      r: number;
      loc: boolean;
      sc: number;
    }[] = [];
    lignes.forEach((l, i) => {
      for (const s of parGroupe.get(`${l.departementId}|${l.cycle}`) ?? []) {
        const r = Math.max(
          ...[s.nom, ...(s.anciensNoms ?? [])].map((n) =>
            ressemblanceEcoles(l.nomCle, cleNomEcole(n)),
          ),
        );
        if (r < 0.78) continue;
        const loc = memeLocalite(l, s);
        candidats.push({ i, s, r, loc, sc: r + (loc ? 0.08 : 0) });
      }
    });
    candidats.sort((a, b) => b.sc - a.sc);
    const attribue = new Map<number, (typeof candidats)[number]>();
    const prises = new Set<number>();
    for (const c of candidats) {
      if (attribue.has(c.i) || prises.has(c.s.id)) continue;
      attribue.set(c.i, c);
      prises.add(c.s.id);
    }

    // Inspection d'une école absente : celle qui tient les écoles du même cycle de sa localité
    const inspLoc = new Map<string, Map<number, number>>();
    for (const s of ecoles) {
      if (!s.parentId || !inspParId.has(s.parentId)) continue;
      const k = `${s.departementId}|${s.cycle}|${locCle(s.localite)}`;
      const m = inspLoc.get(k) ?? new Map<number, number>();
      m.set(s.parentId, (m.get(s.parentId) ?? 0) + 1);
      inspLoc.set(k, m);
    }
    const inspectionsDe = new Map<string, Structure[]>();
    const ajouterInsp = (k: string, s: Structure) => {
      const l = inspectionsDe.get(k) ?? [];
      if (!l.includes(s)) inspectionsDe.set(k, [...l, s]);
    };
    // Inspections proposées pour un département et un cycle : celles de ce cycle, et celles qui
    // tiennent déjà des écoles de ce cycle dans le département (une inspection sans cycle écrit, ou
    // les lycées par zone, ILZ, qui couvrent plusieurs départements)
    for (const s of inspections)
      if (s.cycle) ajouterInsp(`${s.departementId}|${s.cycle}`, s);
    for (const s of ecoles) {
      const i = s.parentId ? inspParId.get(s.parentId) : undefined;
      if (i) ajouterInsp(`${s.departementId}|${s.cycle}`, i);
    }
    // Rien pour ce cycle : les inspections du département sans cycle écrit
    const dejaVus = new Set(inspectionsDe.keys());
    for (const s of inspections)
      if (!s.cycle)
        for (const c of [
          'PRESCOLAIRE',
          'PRIMAIRE',
          'COLLEGE',
          'LYCEE',
          'ALPHABETISATION',
        ])
          if (!dejaVus.has(`${s.departementId}|${c}`))
            ajouterInsp(`${s.departementId}|${c}`, s);
    const proposerInspection = (l: LigneRepertoire) => {
      for (const k of [l.locCle, l.communeCle]) {
        const m = inspLoc.get(`${l.departementId}|${l.cycle}|${k}`);
        if (!m) continue;
        const [[id, n]] = [...m].sort((a, b) => b[1] - a[1]);
        const tot = [...m.values()].reduce((x, y) => x + y, 0);
        return {
          id,
          pourquoi: `${n} des ${tot} écoles de ce cycle à ${l.localite} y sont déjà rattachées`,
        };
      }
      const seules = (
        inspectionsDe.get(`${l.departementId}|${l.cycle}`) ?? []
      ).filter((s) => s.cycle === l.cycle);
      if (seules.length === 1)
        return {
          id: seules[0].id,
          pourquoi: 'la seule inspection de ce cycle dans le département',
        };
      return null;
    };

    // Deux lignes du répertoire pour la même école : même nom au même endroit (une école « Panda »
    // à Sibiti et une autre à Mayeye sont deux écoles)
    const memeEndroit = (m: LigneRepertoire, l: LigneRepertoire) =>
      (m.locCle === l.locCle || m.communeCle === l.communeCle) &&
      (m.nomCle === l.nomCle ||
        (m.locCle === l.locCle &&
          ressemblanceEcoles(m.nomCle, l.nomCle) >= 0.88));

    const propositions: PropositionRepertoire[] = [];
    const ajoutees: LigneRepertoire[] = [];
    lignes.forEach((l, i) => {
      const base = {
        cle: l.cle,
        feuille: l.feuille,
        ligne: l.ligne,
        departementId: l.departementId,
        departement: l.departement,
        cycle: l.cycle,
        nomRepertoire: l.nomRepertoire,
        nomPropose: l.nomPropose,
        typeLocalite: l.typeLocalite,
        localite: l.localite,
        zone: l.zone,
      };
      const c = attribue.get(i);
      if (c) {
        const s = c.s;
        const insp = s.parentId ? inspParId.get(s.parentId) : undefined;
        const sur =
          (c.r === 1 && (c.loc || !s.localite)) || (c.r >= 0.95 && c.loc);
        // Seuls les accents ou les majuscules changent : notre nom est gardé ; sinon le nom du
        // répertoire, avec nos accents
        const nomPropose = memeEcriture(s.nom, l.nomPropose)
          ? s.nom
          : avecAccents(l.nomPropose, [s.nom, ...(s.anciensNoms ?? [])]);
        const etat: EtatRepertoire =
          s.nom === nomPropose ? 'IDENTIQUE' : sur ? 'RENOMMER' : 'PROBABLE';
        propositions.push({
          ...base,
          nomPropose,
          etat,
          ressemblance: Math.round(c.r * 100),
          memeLocalite: c.loc,
          structureId: s.id,
          nomActuel: s.nom,
          localiteActuelle: s.localite,
          inspectionId: insp?.id ?? null,
          inspection: insp?.nom ?? null,
          inspectionAjoutId:
            etat === 'PROBABLE' ? (proposerInspection(l)?.id ?? null) : null,
          pourquoi: null,
          cochee:
            etat === 'RENOMMER' ||
            (etat === 'PROBABLE' && c.r >= 0.88 && c.loc),
        });
        return;
      }
      // La même école écrite deux fois dans le répertoire : comptée une fois
      const jumelle =
        lignes.find((m, j) => {
          if (
            j === i ||
            !attribue.has(j) ||
            m.departementId !== l.departementId ||
            m.cycle !== l.cycle
          )
            return false;
          return memeEndroit(m, l);
        }) ??
        ajoutees.find(
          (m) =>
            m.departementId === l.departementId &&
            m.cycle === l.cycle &&
            memeEndroit(m, l),
        );
      if (jumelle) {
        propositions.push({
          ...base,
          etat: 'DOUBLON',
          ressemblance: null,
          memeLocalite: null,
          structureId: null,
          nomActuel: null,
          localiteActuelle: null,
          inspectionId: null,
          inspection: null,
          pourquoi: `déjà écrite : « ${jumelle.nomRepertoire} » (${jumelle.feuille} ligne ${jumelle.ligne})`,
          cochee: false,
        });
        return;
      }
      // Une école du même nom dans le département (« CEG Mataka » à Louingui et à Boko) : peut-être
      // deux écoles, peut-être la même écrite deux fois ; et un nom qui ne suffira plus à la
      // reconnaître dans les fichiers. À vérifier, jamais coché d'office.
      const memeNom = (
        parGroupe.get(`${l.departementId}|${l.cycle}`) ?? []
      ).find((s) =>
        [s.nom, ...(s.anciensNoms ?? [])].some(
          (n) => cleNomEcole(n) === l.nomCle,
        ),
      );
      const ligneMemeNom = ajoutees.find(
        (m) =>
          m.departementId === l.departementId &&
          m.cycle === l.cycle &&
          m.nomCle === l.nomCle,
      );
      const proche = memeNom ?? candidats.find((c) => c.i === i)?.s;
      const homonyme =
        l.nomCle && (proche || ligneMemeNom)
          ? ((proche ? proche.localite : ligneMemeNom?.localite) ?? '')
          : undefined;
      ajoutees.push(l);
      const p = proposerInspection(l);
      const alerte =
        homonyme !== undefined
          ? `une école du même nom (ou d’un nom proche) existe déjà : « ${proche?.nom ?? ligneMemeNom?.nomRepertoire} »${homonyme ? ` à ${homonyme}` : ''} ; vérifiez que c’est bien une autre école`
          : null;
      propositions.push({
        ...base,
        etat: p ? 'AJOUTER' : 'A_PLACER',
        ressemblance: null,
        memeLocalite: null,
        structureId: null,
        nomActuel: null,
        localiteActuelle: null,
        inspectionId: p?.id ?? null,
        inspection: p ? (inspParId.get(p.id)?.nom ?? null) : null,
        pourquoi:
          [
            alerte,
            p?.pourquoi ??
              'aucune école de ce cycle dans cette localité chez nous : choisissez l’inspection',
          ]
            .filter(Boolean)
            .join(' ; ') || null,
        cochee: !!p && !alerte,
      });
    });

    const compteurs = {
      IDENTIQUE: 0,
      RENOMMER: 0,
      PROBABLE: 0,
      AJOUTER: 0,
      A_PLACER: 0,
      DOUBLON: 0,
    } as Record<EtatRepertoire, number>;
    for (const p of propositions) compteurs[p.etat]++;
    const insp: RapportRepertoire['inspections'] = {};
    for (const [k, l] of inspectionsDe)
      insp[k] = l
        .map((s) => ({ id: s.id, nom: s.nom }))
        .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
    return {
      lues,
      feuilles,
      ignorees,
      compteurs,
      propositions,
      inspections: insp,
      horsRepertoire: ecoles.filter((s) => !prises.has(s.id)).length,
    };
  }

  /**
   * Enregistre ce que la DGRHAS a coché : les noms du répertoire (les anciens gardés), les écoles
   * ajoutées dans l'inspection choisie, la zone et la localité du répertoire.
   */
  async appliquer(
    u: UtilisateurConnecte,
    contenu: Buffer,
    choix: {
      renommer: string[];
      ajouter: { cle: string; inspectionId: number }[];
    },
  ) {
    const r = await this.analyser(contenu);
    const parCle = new Map(r.propositions.map((p) => [p.cle, p]));
    const aRenommer = new Set(choix.renommer ?? []);
    const aAjouter = new Map(
      (choix.ajouter ?? []).map((a) => [a.cle, a.inspectionId]),
    );
    const res = {
      renommees: 0,
      ajoutees: 0,
      zones: 0,
      localites: 0,
      fichesMisesAJour: 0,
      refus: [] as string[],
    };
    const traces: { id: number; avant: string; apres: string }[] = [];
    const creees: number[] = [];

    await this.structures.manager.transaction(async (m) => {
      const ecoles = new Map(
        (
          await m.find(Structure, {
            where: {
              id: In(
                r.propositions
                  .map((p) => p.structureId)
                  .filter((x): x is number => !!x),
              ),
            },
          })
        ).map((s) => [s.id, s]),
      );
      for (const p of r.propositions) {
        if (!p.structureId) continue;
        const s = ecoles.get(p.structureId);
        if (!s) continue;
        // Une ressemblance non confirmée ne donne rien à l'école (ni nom, ni zone, ni localité)
        const sure =
          p.etat === 'IDENTIQUE' ||
          p.etat === 'RENOMMER' ||
          (p.etat === 'PROBABLE' && aRenommer.has(p.cle));
        if (!sure) continue;
        let change = false;
        // La zone et la localité du répertoire, là où l'organigramme n'en a pas
        if (p.zone && s.zone !== p.zone) {
          s.zone = p.zone;
          res.zones++;
          change = true;
        }
        if (!s.localite && p.localite) {
          s.typeLocalite = p.typeLocalite;
          s.localite = p.localite;
          res.localites++;
          change = true;
        }
        if (
          aRenommer.has(p.cle) &&
          (p.etat === 'RENOMMER' || p.etat === 'PROBABLE')
        ) {
          const avant = s.nom;
          const anciens = new Set(s.anciensNoms ?? []);
          for (const n of [s.nom, s.sigle])
            if (n && n !== p.nomPropose) anciens.add(n);
          s.anciensNoms = [...anciens];
          s.nom = p.nomPropose;
          s.sigle = p.nomPropose.slice(0, 80);
          res.renommees++;
          traces.push({ id: s.id, avant, apres: s.nom });
          change = true;
          // Le lieu de service écrit dans les fiches rattachées suit le nouveau nom
          const maj = await m.query<unknown[]>(
            `UPDATE agent_recense
                SET donnees = jsonb_set(donnees, '{LIEU_SERVICE}', to_jsonb($2::text))
              WHERE "structureId" = $1
                AND upper(trim(coalesce(donnees->>'LIEU_SERVICE', ''))) = upper(trim($3))
              RETURNING id`,
            [s.id, s.nom, avant],
          );
          res.fichesMisesAJour += Array.isArray(maj[0])
            ? maj[0].length
            : maj.length;
        }
        if (change) await m.save(Structure, s);
      }

      // Les écoles ajoutées : dans l'inspection choisie, de leur département
      const inspIds = [...new Set(aAjouter.values())].filter((x) =>
        Number.isInteger(x),
      );
      const insps = new Map(
        (
          await m.find(Structure, {
            where: {
              id: In(inspIds.length ? inspIds : [0]),
              type: 'INSPECTION',
            },
          })
        ).map((s) => [s.id, s]),
      );
      const rangs = new Map<number, number>();
      for (const [cle, inspId] of aAjouter) {
        const p = parCle.get(cle);
        const insp = insps.get(inspId);
        // Une ressemblance écartée (« c'est une autre école ») peut aussi être ajoutée
        if (
          !p ||
          (p.etat !== 'AJOUTER' &&
            p.etat !== 'A_PLACER' &&
            p.etat !== 'PROBABLE') ||
          aRenommer.has(cle)
        ) {
          res.refus.push(`${cle} : ce n’est pas une école à ajouter.`);
          continue;
        }
        // L'inspection doit être l'une de celles proposées pour ce département et ce cycle
        const permises = r.inspections[`${p.departementId}|${p.cycle}`] ?? [];
        if (!insp || !permises.some((x) => x.id === insp.id)) {
          res.refus.push(
            `${p.nomRepertoire} : choisissez une inspection de son département (${p.departement}) pour ce cycle.`,
          );
          continue;
        }
        if (!rangs.has(insp.id)) {
          const [x] = await m.query<{ n: number }[]>(
            `SELECT coalesce(max(ordre), 0)::int AS n FROM structure WHERE "parentId" = $1`,
            [insp.id],
          );
          rangs.set(insp.id, x?.n ?? 0);
        }
        rangs.set(insp.id, rangs.get(insp.id)! + 1);
        const s = await m.save(Structure, {
          type: 'ETABLISSEMENT',
          nom: p.nomPropose,
          sigle: p.nomPropose.slice(0, 80),
          parentId: insp.id,
          departementId: p.departementId,
          cycle: p.cycle,
          typeLocalite: p.typeLocalite,
          localite: p.localite,
          zone: p.zone,
          anciensNoms: [],
          actif: true,
          ordre: rangs.get(insp.id)!,
        });
        creees.push(s.id);
        res.ajoutees++;
      }
    });
    await this.journal.log(u, 'ECOLES_REPERTOIRE', 'structure', null, {
      ...res,
      renommages: traces,
      creees,
    });
    return res;
  }
}
