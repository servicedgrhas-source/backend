import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { prefixerInspection } from '../circuit/catalogue';
import { lireClasseur } from '../common/excel';
import { codeDepartement } from '../common/referentiels';
import { enTexte, normaliser } from '../common/texte';
import { JournalService } from '../core/core.service';
import { Departement, Structure } from '../entities';
import { cleEcole, cleInspection } from '../nominations/placement';
import { EtablissementsService } from './etablissements.service';
import { nomOfficiel, ressemblanceEcoles } from './repertoire-ecoles.service';

/*
 * Nombre de classes par école, depuis le fichier des allocations budgétaires (DG, 26/11/2026). Le
 * fichier donne, par établissement, le nombre de classes pédagogiques (pas leurs niveaux) : il est
 * gardé à part (« classes déclarées ») et sert au besoin en enseignants tant que les classes ne sont
 * pas saisies une par une. Essai d'abord ; seules les lignes cochées sont enregistrées.
 */

export type EtatClasses = 'SURE' | 'PROBABLE' | 'ABSENTE' | 'IGNOREE';

export interface LigneClasses {
  /** « feuille|ligne » : retrouve la ligne du fichier à l'enregistrement. */
  cle: string;
  feuille: string;
  ligne: number;
  cycle: string;
  departement: string;
  circonscription: string | null;
  nomFichier: string;
  nombre: number;
  etat: EtatClasses;
  ressemblance: number | null;
  memeInspection: boolean | null;
  structureId: number | null;
  ecole: string | null;
  inspection: string | null;
  /** Ce que le système a déjà pour cette année : classes saisies une par une, ou déjà déclarées. */
  classesSaisies: number;
  dejaDeclare: number | null;
  pourquoi: string | null;
  cochee: boolean;
  /** École absente : ce qui servira à l'ajouter dans l'organigramme. */
  departementId: number | null;
  nomPropose: string | null;
  typeLocalite: string | null;
  localite: string | null;
  zone: string | null;
  inspectionProposeeId: number | null;
  /**
   * Aucune inspection de ce nom chez nous : celle à créer d'après la circonscription du fichier
   * (« Inspection IEPA Gamboma 1 »), une seule fois pour toutes ses écoles.
   */
  nouvelleInspection: string | null;
  /** Absente écrite deux fois dans le fichier (même nom, même cycle, même circonscription). */
  doublonFichier: boolean;
}

export interface AjoutEcole {
  cle: string;
  /** -1 : créer l'inspection proposée (nouvelleInspection). */
  inspectionId: number;
}

/** Cycle de l'inspection qui tient une école (l'IEPA tient aussi l'alphabétisation). */
const CYCLE_INSPECTION: Record<string, string> = {
  PRESCOLAIRE: 'PRESCOLAIRE',
  PRIMAIRE: 'PRIMAIRE',
  ALPHABETISATION: 'PRIMAIRE',
  COLLEGE: 'COLLEGE',
  LYCEE: 'LYCEE',
};

/** Inspection à créer pour une circonscription du fichier, avec le préfixe de son cycle (DG, 26/10). */
export function inspectionACreer(circ: string | null, cycleEcole: string) {
  if (!circ || !cleInspection(circ)) return null;
  const cycle = CYCLE_INSPECTION[cycleEcole] ?? cycleEcole;
  const p = prefixerInspection(circ.replace(/\s+/g, ' ').trim(), cycle);
  if (!p || 'conflit' in p)
    return {
      sigle: circ.trim().slice(0, 80),
      nom: `Inspection ${circ.trim()}`,
      cycle,
    };
  return { ...p, cycle };
}

const CYCLES_ECOLE = [
  'PRESCOLAIRE',
  'PRIMAIRE',
  'COLLEGE',
  'LYCEE',
  'ALPHABETISATION',
];

/** « District de Mossaka », « Commune de Dolisie », « Arrondissement 3 Poto-Poto »… */
function localiteFichier(t: string): {
  type: string | null;
  nom: string | null;
} {
  const m =
    /^\s*(district|dist\.?|commune|arrondissement|arr\.?)\s*(de |d’|d')?\s*(.*)$/i.exec(
      t,
    );
  if (!m) return { type: null, nom: t || null };
  const nom = m[3].trim() || null;
  if (/^dis/i.test(m[1])) return { type: 'DISTRICT', nom };
  if (/^com/i.test(m[1])) return { type: 'COMMUNE', nom };
  return { type: 'ARRONDISSEMENT', nom: nom?.replace(/^\d+\s*/, '') || nom };
}

/** Cycle d'une feuille du fichier (« ALPHA-RESCO-POST-ALPHA », « COLLEGE D'ENSEIGNEMENT GENE »…). */
function cycleFeuille(nom: string): string | null {
  const n = normaliser(nom);
  // « PRESCOLAIRE » contient « RESCO » : le préscolaire d'abord
  if (/PRESCO/.test(n)) return 'PRESCOLAIRE';
  if (/ALPHA|RESCO/.test(n)) return 'ALPHABETISATION';
  if (/PRIMAIRE/.test(n)) return 'PRIMAIRE';
  if (/COLLEGE|CEG/.test(n)) return 'COLLEGE';
  if (/LYCEE/.test(n)) return 'LYCEE';
  return null;
}

@Injectable()
export class ClassesDeclareesService {
  constructor(
    @InjectRepository(Structure)
    private readonly structures: Repository<Structure>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    private readonly journal: JournalService,
    private readonly etab: EtablissementsService,
  ) {}

  async analyse(contenu: Buffer, anneeDemandee?: string) {
    const annee = this.etab.annee(anneeDemandee);
    const feuilles = await lireClasseur(contenu, ['NOMETABLISSEMENT']);
    if (!feuilles.length)
      throw new BadRequestException(
        'Aucune feuille avec la colonne « NOM_ETABLISSEMENT » : ce n’est pas le fichier des allocations budgétaires.',
      );
    const deps = await this.deps.find();
    const depParCode = new Map(deps.map((d) => [d.code, d]));
    const tout = await this.structures.find({
      where: { type: In(['ETABLISSEMENT', 'INSPECTION']), actif: true },
      select: [
        'id',
        'type',
        'nom',
        'sigle',
        'parentId',
        'departementId',
        'cycle',
        'anciensNoms',
      ],
    });
    const insp = new Map(
      tout.filter((s) => s.type === 'INSPECTION').map((s) => [s.id, s]),
    );
    const ecoles = tout.filter((s) => s.type === 'ETABLISSEMENT');
    const noms = (s: Structure) =>
      [s.nom, s.sigle, ...(s.anciensNoms ?? [])].filter(
        (x): x is string => !!x,
      );
    const clesEcole = new Map(ecoles.map((s) => [s.id, noms(s).map(cleEcole)]));
    const clesInsp = new Map(
      [...insp.values()].map((s) => [s.id, noms(s).map(cleInspection)]),
    );
    const inspectionsDe = new Map<string, Structure[]>();
    const ajouterInsp = (k: string, s: Structure) => {
      const l = inspectionsDe.get(k) ?? [];
      if (!l.includes(s)) inspectionsDe.set(k, [...l, s]);
    };
    for (const s of insp.values()) {
      if (s.cycle) ajouterInsp(`${s.departementId}|${s.cycle}`, s);
      // Sans cycle écrit : tous les cycles de sa circonscription
      else
        for (const c of CYCLES_ECOLE) ajouterInsp(`${s.departementId}|${c}`, s);
      // L'inspection du primaire tient aussi les CEP et les centres d'alphabétisation
      if (s.cycle === 'PRIMAIRE')
        for (const c of ['PRESCOLAIRE', 'ALPHABETISATION'])
          ajouterInsp(`${s.departementId}|${c}`, s);
    }
    for (const s of ecoles) {
      const i = s.parentId ? insp.get(s.parentId) : undefined;
      if (i) ajouterInsp(`${s.departementId}|${s.cycle}`, i);
    }
    /** L'inspection dont le nom est celui de la circonscription du fichier ; à défaut, la seule possible. */
    const proposerInspection = (
      depId: number,
      cycle: string,
      circ: string | null,
    ) => {
      const permises = inspectionsDe.get(`${depId}|${cycle}`) ?? [];
      const ci = cleInspection(circ);
      let meilleure: { id: number; r: number } | null = null;
      if (ci)
        for (const s of permises) {
          const r = Math.max(
            0,
            ...(clesInsp.get(s.id) ?? []).map((b) => ressemblanceEcoles(ci, b)),
          );
          if (r >= 0.8 && (!meilleure || r > meilleure.r))
            meilleure = { id: s.id, r };
        }
      return meilleure?.id ?? (permises.length === 1 ? permises[0].id : null);
    };
    // La DDEPPSA de chaque département : elle reçoit les inspections créées
    const ddeppsa = new Map(
      (
        await this.structures.find({
          where: { type: 'DDEPPSA', actif: true },
          select: ['id', 'departementId'],
        })
      ).map((d) => [d.departementId, d.id]),
    );
    const [saisies, declarees] = await Promise.all([
      this.structures.query<{ id: number; n: number }[]>(
        `SELECT "structureId" AS id, count(*)::int AS n FROM classe WHERE "anneeScolaire" = $1 GROUP BY 1`,
        [annee],
      ),
      this.structures.query<{ id: number; n: number }[]>(
        `SELECT "structureId" AS id, nombre AS n FROM classes_declarees WHERE "anneeScolaire" = $1`,
        [annee],
      ),
    ]);
    const nSaisies = new Map(saisies.map((x) => [x.id, x.n]));
    const nDeclarees = new Map(declarees.map((x) => [x.id, x.n]));

    // Les lignes du fichier (les sous-totaux et les lignes sans nom sont laissés de côté)
    const lignes: (Omit<
      LigneClasses,
      | 'etat'
      | 'ressemblance'
      | 'memeInspection'
      | 'structureId'
      | 'ecole'
      | 'inspection'
      | 'classesSaisies'
      | 'dejaDeclare'
      | 'pourquoi'
      | 'cochee'
      | 'departementId'
      | 'nomPropose'
      | 'typeLocalite'
      | 'localite'
      | 'zone'
      | 'inspectionProposeeId'
      | 'nouvelleInspection'
      | 'doublonFichier'
    > & { depId: number | null; district: string; zoneTexte: string })[] = [];
    let ignorees = 0;
    for (const f of feuilles) {
      const cycle = cycleFeuille(f.nom);
      if (!cycle) continue;
      for (const l of f.lignes) {
        const val = (k: string) => enTexte(l[k]).replace(/\s+/g, ' ').trim();
        const colonne = (debut: string) => {
          const k = Object.keys(l).find((x) => x.startsWith(debut));
          return k ? val(k) : '';
        };
        const nom = val('NOMETABLISSEMENT');
        const depTexte = val('DEPARTEMENT');
        const nombre = Number(
          val('NOMBREDECLASSESPEDAGOGIQUES').replace(',', '.'),
        );
        if (!nom || !depTexte || /TOTAL/i.test(depTexte) || !(nombre > 0)) {
          if (nom || depTexte) ignorees++;
          continue;
        }
        const code = codeDepartement(depTexte);
        const dep = code ? depParCode.get(code) : undefined;
        lignes.push({
          cle: `${f.nom}|${l._ligne}`,
          feuille: f.nom.trim(),
          ligne: Number(l._ligne),
          cycle,
          departement: dep?.nom ?? depTexte,
          depId: dep?.id ?? null,
          circonscription:
            val('CIRCONSCRIPTIONSCOLAIRE') || val('CIRCONSCRIPTION') || null,
          nomFichier: nom,
          nombre: Math.round(nombre),
          district: colonne('DISTRICT'),
          zoneTexte: colonne('ZONE'),
        });
      }
    }

    // Candidats (ligne, école), les meilleurs d'abord ; une école ne sert qu'une fois
    const cand: {
      i: number;
      s: Structure;
      r: number;
      memeInsp: boolean;
      sc: number;
    }[] = [];
    lignes.forEach((x, i) => {
      if (!x.depId) return;
      const a = cleEcole(x.nomFichier);
      const ci = cleInspection(x.circonscription);
      for (const s of ecoles) {
        if (s.departementId !== x.depId || s.cycle !== x.cycle) continue;
        const r = Math.max(
          0,
          ...(clesEcole.get(s.id) ?? []).map((b) => ressemblanceEcoles(a, b)),
        );
        if (r < 0.78) continue;
        const p = s.parentId ? insp.get(s.parentId) : undefined;
        const memeInsp =
          !!ci &&
          !!p &&
          (clesInsp.get(p.id) ?? []).some(
            (b) => ressemblanceEcoles(ci, b) >= 0.88,
          );
        cand.push({ i, s, r, memeInsp, sc: r + (memeInsp ? 0.08 : 0) });
      }
    });
    cand.sort((a, b) => b.sc - a.sc);
    const choix = new Map<number, (typeof cand)[number]>();
    const second = new Map<number, (typeof cand)[number]>();
    const prises = new Set<number>();
    for (const c of cand) {
      if (choix.has(c.i)) {
        if (!second.has(c.i)) second.set(c.i, c);
        continue;
      }
      if (prises.has(c.s.id)) continue;
      choix.set(c.i, c);
      prises.add(c.s.id);
    }

    const absentesVues = new Set<string>();
    const sortie: LigneClasses[] = lignes.map((x, i) => {
      const c = choix.get(i);
      const deux = second.get(i);
      let etat: EtatClasses = 'ABSENTE';
      let pourquoi: string | null = null;
      if (!x.depId) {
        etat = 'IGNOREE';
        pourquoi = `département « ${x.departement} » non reconnu`;
      } else if (c) {
        const net = !deux || c.sc - deux.sc >= 0.05;
        etat =
          net && (c.r >= 0.95 || (c.r >= 0.88 && c.memeInsp))
            ? 'SURE'
            : 'PROBABLE';
        if (etat === 'PROBABLE')
          pourquoi = !net
            ? `plusieurs écoles possibles : « ${c.s.nom} », « ${deux.s.nom} »…`
            : `nom proche : « ${c.s.nom} »`;
        else if (!c.memeInsp)
          pourquoi =
            'rangée sous une autre inspection que la circonscription du fichier';
      } else
        pourquoi = 'aucune école de ce nom dans le département et le cycle';
      // Une absente écrite deux fois n'est ajoutée qu'une fois
      let doublonFichier = false;
      if (etat === 'ABSENTE') {
        const k = `${x.depId}|${x.cycle}|${cleInspection(x.circonscription)}|${cleEcole(x.nomFichier)}`;
        doublonFichier = absentesVues.has(k);
        absentesVues.add(k);
        if (doublonFichier)
          pourquoi =
            'écrite deux fois dans le fichier : ajoutée une seule fois';
      }
      const loc = localiteFichier(x.district);
      const proposee =
        etat === 'ABSENTE' && x.depId && !doublonFichier
          ? proposerInspection(x.depId, x.cycle, x.circonscription)
          : null;
      const s = c?.s;
      const p = s?.parentId ? insp.get(s.parentId) : undefined;
      const classesSaisies = s ? (nSaisies.get(s.id) ?? 0) : 0;
      const dejaDeclare = s ? (nDeclarees.get(s.id) ?? null) : null;
      return {
        cle: x.cle,
        feuille: x.feuille,
        ligne: x.ligne,
        cycle: x.cycle,
        departement: x.departement,
        circonscription: x.circonscription,
        nomFichier: x.nomFichier,
        nombre: x.nombre,
        etat,
        ressemblance: c ? Math.round(c.r * 100) : null,
        memeInspection: c?.memeInsp ?? null,
        structureId: s?.id ?? null,
        ecole: s?.nom ?? null,
        inspection: p?.nom ?? null,
        classesSaisies,
        dejaDeclare,
        pourquoi,
        // Déjà fait (même nombre) : rien à cocher ; une absente n'est ajoutée que cochée à la main
        cochee: etat === 'SURE' && dejaDeclare !== x.nombre,
        departementId: x.depId,
        nomPropose:
          etat === 'ABSENTE' ? nomOfficiel(x.nomFichier, x.cycle) : null,
        typeLocalite: loc.type,
        localite: loc.nom,
        zone: /RUR/i.test(normaliser(x.zoneTexte))
          ? 'RURALE'
          : /URB/i.test(normaliser(x.zoneTexte))
            ? 'URBAINE'
            : null,
        inspectionProposeeId: proposee,
        nouvelleInspection:
          etat === 'ABSENTE' &&
          x.depId &&
          !doublonFichier &&
          !proposee &&
          ddeppsa.has(x.depId)
            ? (inspectionACreer(x.circonscription, x.cycle)?.nom ?? null)
            : null,
        doublonFichier,
      };
    });
    const compteurs = {
      SURE: 0,
      PROBABLE: 0,
      ABSENTE: 0,
      IGNOREE: 0,
    } as Record<EtatClasses, number>;
    for (const x of sortie) compteurs[x.etat]++;
    return {
      annee,
      lues: lignes.length,
      ignorees,
      compteurs,
      classes: sortie
        .filter((x) => x.structureId)
        .reduce((n, x) => n + x.nombre, 0),
      lignes: sortie,
      /** Inspections possibles pour une école ajoutée, par « départementId|cycle ». */
      inspections: Object.fromEntries(
        [...inspectionsDe].map(([k, l]) => [
          k,
          l
            .map((s) => ({ id: s.id, nom: s.nom }))
            .sort((a, b) => a.nom.localeCompare(b.nom, 'fr')),
        ]),
      ),
    };
  }

  /** Enregistre le nombre de classes des lignes cochées (DG et administrateurs). */
  async appliquer(
    u: UtilisateurConnecte,
    contenu: Buffer,
    anneeDemandee: string | undefined,
    cles: string[],
    ajouter: AjoutEcole[],
    source: string,
  ) {
    const r = await this.analyse(contenu, anneeDemandee);
    const annee = r.annee;
    const voulues = new Set(cles);
    const aFaire: { structureId: number; nombre: number }[] = r.lignes
      .filter(
        (x) =>
          voulues.has(x.cle) &&
          x.structureId &&
          (x.etat === 'SURE' || x.etat === 'PROBABLE'),
      )
      .map((x) => ({ structureId: x.structureId!, nombre: x.nombre }));
    const parCle = new Map(r.lignes.map((x) => [x.cle, x]));
    const refus: string[] = [];
    const creees: number[] = [];
    const inspectionsCreees: number[] = [];
    if (!aFaire.length && !ajouter.length)
      return {
        enregistrees: 0,
        classes: 0,
        ajoutees: 0,
        inspections: 0,
        refus,
      };
    await this.structures.manager.transaction(async (m) => {
      // Les écoles absentes cochées : ajoutées dans l'inspection choisie, avec leur nombre de classes
      const rangs = new Map<number, number>();
      const rangSuivant = async (parentId: number) => {
        if (!rangs.has(parentId)) {
          const [n] = await m.query<{ n: number }[]>(
            `SELECT coalesce(max(ordre), 0)::int AS n FROM structure WHERE "parentId" = $1`,
            [parentId],
          );
          rangs.set(parentId, n?.n ?? 0);
        }
        rangs.set(parentId, rangs.get(parentId)! + 1);
        return rangs.get(parentId)!;
      };
      // Inspections créées pendant cet enregistrement, par département, cycle et circonscription
      const nouvelles = new Map<string, number>();
      const ddeppsa = new Map(
        (
          await m.find(Structure, {
            where: { type: 'DDEPPSA', actif: true },
            select: ['id', 'departementId'],
          })
        ).map((d) => [d.departementId, d.id]),
      );
      for (const a of ajouter) {
        const x = parCle.get(a.cle);
        let inspectionId = a.inspectionId;
        if (
          !x ||
          x.etat !== 'ABSENTE' ||
          x.doublonFichier ||
          !x.departementId ||
          !x.nomPropose
        ) {
          refus.push(
            `${x?.nomFichier ?? a.cle} : ce n’est pas une école à ajouter.`,
          );
          continue;
        }
        if (a.inspectionId === -1) {
          const n = inspectionACreer(x.circonscription, x.cycle);
          const parent = ddeppsa.get(x.departementId);
          if (!x.nouvelleInspection || !n || !parent) {
            refus.push(
              `${x.nomFichier} : pas d’inspection à créer pour sa circonscription ; choisissez-en une.`,
            );
            continue;
          }
          const k = `${x.departementId}|${n.cycle}|${cleInspection(n.nom)}`;
          if (!nouvelles.has(k)) {
            const i = await m.save(Structure, {
              type: 'INSPECTION',
              nom: n.nom.slice(0, 200),
              sigle: n.sigle,
              parentId: parent,
              departementId: x.departementId,
              cycle: n.cycle,
              anciensNoms: [],
              actif: true,
              ordre: await rangSuivant(parent),
            });
            nouvelles.set(k, i.id);
            inspectionsCreees.push(i.id);
          }
          inspectionId = nouvelles.get(k)!;
        } else if (
          !(r.inspections[`${x.departementId}|${x.cycle}`] ?? []).some(
            (i) => i.id === inspectionId,
          )
        ) {
          refus.push(
            `${x.nomFichier} : choisissez une inspection de son département (${x.departement}) pour ce cycle.`,
          );
          continue;
        }
        const ordre = await rangSuivant(inspectionId);
        const s = await m.save(Structure, {
          type: 'ETABLISSEMENT',
          nom: x.nomPropose,
          sigle: x.nomPropose.slice(0, 80),
          parentId: inspectionId,
          departementId: x.departementId,
          cycle: x.cycle,
          typeLocalite: x.typeLocalite,
          localite: x.localite,
          zone: x.zone,
          anciensNoms: [],
          actif: true,
          ordre,
        });
        creees.push(s.id);
        aFaire.push({ structureId: s.id, nombre: x.nombre });
      }
      for (let i = 0; i < aFaire.length; i += 500) {
        const lot = aFaire.slice(i, i + 500);
        await m.query(
          `INSERT INTO classes_declarees ("structureId", "anneeScolaire", nombre, source, "importePar")
           SELECT * FROM unnest($1::int[], $2::text[], $3::int[], $4::text[], $5::text[])
           ON CONFLICT ("structureId", "anneeScolaire") DO UPDATE
             SET nombre = EXCLUDED.nombre, source = EXCLUDED.source, "importePar" = EXCLUDED."importePar", "importeLe" = now()`,
          [
            lot.map((x) => x.structureId),
            lot.map(() => annee),
            lot.map((x) => x.nombre),
            lot.map(() => source),
            lot.map(() => u.nom),
          ],
        );
      }
    });
    const res = {
      enregistrees: aFaire.length,
      classes: aFaire.reduce((n, x) => n + x.nombre, 0),
      ajoutees: creees.length,
      inspections: inspectionsCreees.length,
      refus,
    };
    await this.journal.log(u, 'CLASSES_DECLAREES', 'structure', null, {
      annee,
      source,
      ...res,
      creees,
      inspectionsCreees,
    });
    return res;
  }
}
