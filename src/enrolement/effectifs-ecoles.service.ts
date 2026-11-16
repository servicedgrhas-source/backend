import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import ExcelJS from 'exceljs';
import {
  cleEcole,
  cycleDeCategorie,
  cycleDuNom,
  type CycleEcole,
  CYCLES_ECOLE,
  estHorsEcole,
  faute,
  nomAffiche,
} from './effectifs-ecoles-regles';

/**
 * Effectifs par école (Banque mondiale, 16/11/2026) : pour chaque école, rangée par DEPPSA, le nombre
 * de volontaires, de communautaires, de contractuels et de fonctionnaires ; les écoles qui ont moins
 * de 3 fonctionnaires sont signalées (elles passent en priorité). Lecture seule, aucun nom de
 * personne : seulement des nombres.
 *
 * Sources :
 * - volontaires et communautaires : le registre de la bourse (en poste), école et cycle du registre
 *   (sinon l'école de leur fiche du personnel) ;
 * - fonctionnaires et contractuels : la base du personnel (en activité), l'école de l'organigramme
 *   quand la fiche y est rattachée, sinon le « lieu de service » écrit.
 * La même école écrite de plusieurs façons est reconnue (voir effectifs-ecoles-regles.ts) ; les
 * écritures différentes sont rendues dans la feuille « Noms à harmoniser ».
 *
 * Nouveaux départements : la base du personnel est encore sur les anciens (« Plateaux » d'un seul
 * bloc). Un fonctionnaire dont l'école n'est connue que dans une seule des nouvelles DEPPSA
 * (Congo-Oubangui, Djoué-Léfini, Nkéni-Alima), d'après l'organigramme et le registre, y est compté ;
 * ces reclassements sont rendus dans la feuille « DEPPSA reclassées ».
 */

export type Effectif =
  'volontaires' | 'communautaires' | 'contractuels' | 'fonctionnaires';
const EFFECTIFS: Effectif[] = [
  'volontaires',
  'communautaires',
  'contractuels',
  'fonctionnaires',
];
const LIBELLES: Record<Effectif, string> = {
  volontaires: 'Volontaires',
  communautaires: 'Communautaires',
  contractuels: 'Contractuels',
  fonctionnaires: 'Fonctionnaires',
};
const NOUVEAUX_DEPARTEMENTS = ['CONGO_OUBANGUI', 'DJOUE_LEFINI', 'NKENI_ALIMA'];

export interface LigneEcole extends Record<Effectif, number> {
  departementId: number | null;
  departement: string;
  cycle: CycleEcole | null;
  nom: string;
  /** L'école existe dans l'organigramme (Établissements). */
  organigramme: boolean;
  total: number;
  /** Nombre d'écritures différentes du nom rencontrées. */
  ecritures: number;
}

export interface FiltresEcoles {
  cycle?: string;
  departementId?: number;
  seuil: number;
  sousSeuil?: boolean;
  recherche?: string;
}

interface Calcul {
  le: number;
  ecoles: (LigneEcole & { variantes: Map<string, number> })[];
  /** Personnes sans école : rien d'écrit, ou un lieu qui n'est pas une école (inspection…). */
  sansEcole: {
    departementId: number | null;
    departement: string;
    effectif: Effectif;
    sans: number;
    administration: number;
  }[];
  reclassees: { de: string; vers: string; ecole: string; n: number }[];
  deps: { id: number; nom: string; ordre: number }[];
}

@Injectable()
export class EffectifsEcolesService {
  constructor(private readonly ds: DataSource) {}

  private cache: Calcul | null = null;

  private async calcul(): Promise<Calcul> {
    if (this.cache && Date.now() - this.cache.le < 120_000) return this.cache;
    const q = <T>(sql: string, p: unknown[] = []) => this.ds.query<T[]>(sql, p);
    const deps = await q<{
      id: number;
      nom: string;
      code: string;
      ordre: number;
    }>(`SELECT id, nom, code, ordre FROM departement ORDER BY ordre`);
    const nomDep = new Map(deps.map((d) => [d.id, d.nom]));
    const nouveaux = new Set(
      deps
        .filter((d) => NOUVEAUX_DEPARTEMENTS.includes(d.code))
        .map((d) => d.id),
    );
    const structures = new Map(
      (
        await q<{
          id: number;
          nom: string;
          type: string;
          cycle: string | null;
          departementId: number | null;
        }>(
          `SELECT id, nom, type, cycle, "departementId" FROM structure WHERE actif`,
        )
      ).map((s) => [s.id, s]),
    );
    const personnel = await q<{
      statut: string;
      departementId: number | null;
      structureId: number | null;
      lieu: string | null;
      cycle: string | null;
      volontaireId: string | null;
    }>(
      `SELECT statut, "departementId", "structureId", donnees->>'LIEU_SERVICE' AS lieu,
              donnees->>'CYCLE' AS cycle, "volontaireId"
         FROM agent_recense
        WHERE coalesce(contentieux->>'etat', 'CONFIRME') = 'CONFIRME'
          AND coalesce(donnees->>'POSITION', '') NOT IN ('RETRAITE', 'DECEDE')`,
    );
    const registre = await q<{
      id: string;
      population: string;
      departementId: number | null;
      etablissement: string | null;
      categorie: string | null;
    }>(
      `SELECT id, population, "departementId", etablissement, categorie
         FROM volontaire WHERE statut = 'EN_POSTE'`,
    );

    // La fiche du personnel d'une personne du registre ; devenue fonctionnaire ou contractuel, elle
    // est comptée une seule fois, avec le personnel
    const ficheDe = new Map(
      personnel.filter((p) => p.volontaireId).map((p) => [p.volontaireId, p]),
    );
    const fc = (s: string) => s === 'FONCTIONNAIRE' || s === 'CONTRACTUEL';

    interface Lieu {
      departementId: number | null;
      cycle: CycleEcole | null;
      cle: string;
      ecrit: string;
      structureId: number | null;
    }
    type Resultat = Lieu | 'SANS' | 'ADMINISTRATION';
    const lieuDe = (
      departementId: number | null,
      structureId: number | null,
      texte: string | null,
      cycleDeclare: CycleEcole | null,
    ): Resultat => {
      const s = structureId ? structures.get(structureId) : undefined;
      const t = (texte ?? '').trim();
      if (s && s.type === 'ETABLISSEMENT') {
        const cycle =
          (s.cycle && s.cycle in CYCLES_ECOLE
            ? (s.cycle as CycleEcole)
            : null) ??
          cycleDuNom(s.nom) ??
          cycleDeclare;
        return {
          departementId: s.departementId ?? departementId,
          cycle,
          cle: cleEcole(s.nom),
          ecrit: s.nom,
          structureId: s.id,
        };
      }
      if (!t || /^[\d\s.-]*$/.test(t)) return s ? 'ADMINISTRATION' : 'SANS';
      if (estHorsEcole(t)) return 'ADMINISTRATION';
      const cle = cleEcole(t);
      if (!cle) return 'SANS';
      return {
        departementId,
        cycle: cycleDuNom(t) ?? cycleDeclare,
        cle,
        ecrit: t,
        structureId: null,
      };
    };

    const gens: { effectif: Effectif; r: Resultat; fc: boolean }[] = [];
    for (const v of registre) {
      const fiche = ficheDe.get(v.id);
      if (fiche && fc(fiche.statut)) continue;
      const cycle = cycleDeCategorie(v.categorie);
      let r = lieuDe(v.departementId, null, v.etablissement, cycle);
      if (r === 'SANS' && fiche)
        r = lieuDe(
          v.departementId ?? fiche.departementId,
          fiche.structureId,
          fiche.lieu,
          cycle,
        );
      gens.push({
        effectif:
          v.population === 'COMMUNAUTAIRE' ? 'communautaires' : 'volontaires',
        r,
        fc: false,
      });
    }
    for (const p of personnel) {
      if (!fc(p.statut)) continue;
      const cycle = cycleDeCategorie(p.cycle);
      gens.push({
        effectif:
          p.statut === 'CONTRACTUEL' ? 'contractuels' : 'fonctionnaires',
        r: lieuDe(p.departementId, p.structureId, p.lieu, cycle),
        fc: true,
      });
    }

    // Les écoles connues ailleurs que dans la base du personnel (organigramme, registre) : DEPPSA
    // et cycle de référence d'un nom
    const reference = new Map<string, Set<number>>();
    const referenceNom = new Map<string, Set<number>>();
    const cyclesDe = new Map<string, Set<CycleEcole>>();
    const noter = (
      dep: number | null,
      cycle: CycleEcole | null,
      cle: string,
      estReference = true,
    ) => {
      if (dep !== null && estReference) {
        const k = `${cycle ?? ''}|${cle}`;
        reference.set(k, (reference.get(k) ?? new Set()).add(dep));
        referenceNom.set(cle, (referenceNom.get(cle) ?? new Set()).add(dep));
      }
      if (cycle && dep !== null) {
        const k = `${dep}|${cle}`;
        cyclesDe.set(k, (cyclesDe.get(k) ?? new Set()).add(cycle));
      }
    };
    for (const s of structures.values())
      if (s.type === 'ETABLISSEMENT')
        noter(
          s.departementId,
          (s.cycle && s.cycle in CYCLES_ECOLE
            ? (s.cycle as CycleEcole)
            : null) ?? cycleDuNom(s.nom),
          cleEcole(s.nom),
        );
    for (const g of gens)
      if (!g.fc && typeof g.r === 'object')
        noter(g.r.departementId, g.r.cycle, g.r.cle);
    for (const g of gens)
      if (g.fc && typeof g.r === 'object' && g.r.cycle)
        noter(g.r.departementId, g.r.cycle, g.r.cle, false);

    // Reclassement dans les nouvelles DEPPSA
    const reclasse = new Map<string, number>();
    for (const g of gens) {
      if (!g.fc || typeof g.r !== 'object' || g.r.structureId) continue;
      const r = g.r;
      if (r.departementId !== null && nouveaux.has(r.departementId)) continue;
      const ref = r.cycle
        ? reference.get(`${r.cycle}|${r.cle}`)
        : referenceNom.get(r.cle);
      if (!ref || ref.size !== 1) continue;
      const [vers] = [...ref];
      if (!nouveaux.has(vers) || vers === r.departementId) continue;
      const k = `${r.departementId === null ? 'Non renseignée' : (nomDep.get(r.departementId) ?? '?')}|${nomDep.get(vers) ?? '?'}|${nomAffiche(r.ecrit, r.cycle)}`;
      reclasse.set(k, (reclasse.get(k) ?? 0) + 1);
      r.departementId = vers;
    }

    // Le cycle d'une école écrite sans libellé (« Mbala Prosper ») : celui que les autres écritures
    // de la même école dans la même DEPPSA donnent, s'il n'y en a qu'un
    for (const g of gens) {
      if (typeof g.r !== 'object' || g.r.cycle || g.r.departementId === null)
        continue;
      const c = cyclesDe.get(`${g.r.departementId}|${g.r.cle}`);
      if (c?.size === 1) g.r.cycle = [...c][0];
    }

    // Les fautes de frappe (« MOUYONDZI » / « MOYONDZI ») : dans la même DEPPSA et le même cycle, la
    // clé la moins fréquente rejoint la plus fréquente (celle de l'organigramme d'abord)
    const poids = new Map<string, Map<string, number>>();
    const peser = (groupe: string, cle: string, n: number) => {
      const m = poids.get(groupe) ?? new Map<string, number>();
      m.set(cle, (m.get(cle) ?? 0) + n);
      poids.set(groupe, m);
    };
    for (const s of structures.values())
      if (s.type === 'ETABLISSEMENT')
        peser(
          `${s.departementId ?? ''}|${(s.cycle && s.cycle in CYCLES_ECOLE ? s.cycle : null) ?? cycleDuNom(s.nom) ?? ''}`,
          cleEcole(s.nom),
          1_000_000,
        );
    for (const g of gens)
      if (typeof g.r === 'object')
        peser(`${g.r.departementId ?? ''}|${g.r.cycle ?? ''}`, g.r.cle, 1);
    const versCle = new Map<string, string>();
    for (const [groupe, m] of poids) {
      const retenues: string[] = [];
      for (const [cle] of [...m.entries()].sort((a, b) => b[1] - a[1])) {
        const proche = retenues.find((x) => faute(x, cle));
        if (proche) versCle.set(`${groupe}|${cle}`, proche);
        else retenues.push(cle);
      }
    }
    for (const g of gens)
      if (typeof g.r === 'object') {
        const k = `${g.r.departementId ?? ''}|${g.r.cycle ?? ''}|${g.r.cle}`;
        g.r.cle = versCle.get(k) ?? g.r.cle;
      }

    const ecoles = new Map<
      string,
      LigneEcole & {
        variantes: Map<string, number>;
        structureId: number | null;
      }
    >();
    const sans = new Map<string, Calcul['sansEcole'][number]>();
    for (const g of gens) {
      if (typeof g.r !== 'object') continue;
      const r = g.r;
      const k = `${r.departementId ?? ''}|${r.cycle ?? ''}|${r.cle}`;
      let e = ecoles.get(k);
      if (!e) {
        e = {
          departementId: r.departementId,
          departement:
            r.departementId === null
              ? 'DEPPSA non renseignée'
              : (nomDep.get(r.departementId) ?? '?'),
          cycle: r.cycle,
          nom: '',
          organigramme: false,
          volontaires: 0,
          communautaires: 0,
          contractuels: 0,
          fonctionnaires: 0,
          total: 0,
          ecritures: 0,
          variantes: new Map(),
          structureId: null,
        };
        ecoles.set(k, e);
      }
      e[g.effectif]++;
      e.total++;
      if (r.structureId) e.structureId = r.structureId;
      const ecrit = r.ecrit.replace(/\s+/g, ' ').trim();
      e.variantes.set(ecrit, (e.variantes.get(ecrit) ?? 0) + 1);
    }
    // Sans école : par DEPPSA et par effectif (les personnes, dans l'ordre où elles ont été lues)
    let i = 0;
    for (const v of registre) {
      const fiche = ficheDe.get(v.id);
      if (fiche && fc(fiche.statut)) continue;
      const g = gens[i++];
      if (typeof g.r === 'object') continue;
      const k = `${v.departementId ?? ''}|${g.effectif}`;
      const x = sans.get(k) ?? {
        departementId: v.departementId,
        departement:
          v.departementId === null
            ? 'DEPPSA non renseignée'
            : (nomDep.get(v.departementId) ?? '?'),
        effectif: g.effectif,
        sans: 0,
        administration: 0,
      };
      x[g.r === 'SANS' ? 'sans' : 'administration']++;
      sans.set(k, x);
    }
    for (const p of personnel) {
      if (!fc(p.statut)) continue;
      const g = gens[i++];
      if (typeof g.r === 'object') continue;
      const k = `${p.departementId ?? ''}|${g.effectif}`;
      const x = sans.get(k) ?? {
        departementId: p.departementId,
        departement:
          p.departementId === null
            ? 'DEPPSA non renseignée'
            : (nomDep.get(p.departementId) ?? '?'),
        effectif: g.effectif,
        sans: 0,
        administration: 0,
      };
      x[g.r === 'SANS' ? 'sans' : 'administration']++;
      sans.set(k, x);
    }

    // Le nom affiché : celui de l'organigramme, sinon l'écriture la plus fréquente, abrégée
    const ordreDep = new Map(deps.map((d) => [d.id, d.ordre]));
    const liste = [...ecoles.values()].map((e) => {
      const s = e.structureId ? structures.get(e.structureId) : undefined;
      const frequente = [...e.variantes.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
      )[0][0];
      const { structureId, ...reste } = e;
      void structureId;
      return {
        ...reste,
        nom: nomAffiche(s?.nom ?? frequente, e.cycle),
        organigramme: !!s,
        ecritures: new Set([...e.variantes.keys()].map((x) => x.toUpperCase()))
          .size,
      };
    });
    const rangCycle = (c: string | null) =>
      c ? Object.keys(CYCLES_ECOLE).indexOf(c) : 9;
    liste.sort(
      (a, b) =>
        (ordreDep.get(a.departementId ?? -1) ?? 99) -
          (ordreDep.get(b.departementId ?? -1) ?? 99) ||
        rangCycle(a.cycle) - rangCycle(b.cycle) ||
        a.nom.localeCompare(b.nom, 'fr', { sensitivity: 'base' }),
    );
    this.cache = {
      le: Date.now(),
      ecoles: liste,
      sansEcole: [...sans.values()].sort(
        (a, b) =>
          (ordreDep.get(a.departementId ?? -1) ?? 99) -
            (ordreDep.get(b.departementId ?? -1) ?? 99) ||
          EFFECTIFS.indexOf(a.effectif) - EFFECTIFS.indexOf(b.effectif),
      ),
      reclassees: [...reclasse.entries()]
        .map(([k, n]) => {
          const [de, vers, ecole] = k.split('|');
          return { de, vers, ecole, n };
        })
        .sort(
          (a, b) =>
            a.vers.localeCompare(b.vers) || a.ecole.localeCompare(b.ecole),
        ),
      deps: deps.map(({ id, nom, ordre }) => ({ id, nom, ordre })),
    };
    return this.cache;
  }

  private filtrer(c: Calcul, f: FiltresEcoles) {
    const r = f.recherche
      ? f.recherche.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
      : '';
    return c.ecoles.filter(
      (e) =>
        (!f.cycle || (f.cycle === 'SANS' ? !e.cycle : e.cycle === f.cycle)) &&
        (!f.departementId || e.departementId === f.departementId) &&
        (!f.sousSeuil || e.fonctionnaires < f.seuil) &&
        (!r ||
          e.nom.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().includes(r)),
    );
  }

  /** Par DEPPSA : nombre d'écoles, écoles sous le seuil, effectifs. */
  private parDeppsa(ecoles: LigneEcole[], seuil: number) {
    const m = new Map<
      string,
      Record<Effectif, number> & {
        departement: string;
        ecoles: number;
        sousSeuil: number;
        total: number;
      }
    >();
    for (const e of ecoles) {
      const x = m.get(e.departement) ?? {
        departement: e.departement,
        ecoles: 0,
        sousSeuil: 0,
        volontaires: 0,
        communautaires: 0,
        contractuels: 0,
        fonctionnaires: 0,
        total: 0,
      };
      x.ecoles++;
      if (e.fonctionnaires < seuil) x.sousSeuil++;
      for (const k of EFFECTIFS) x[k] += e[k];
      x.total += e.total;
      m.set(e.departement, x);
    }
    return [...m.values()];
  }

  async effectifs(f: FiltresEcoles, page = 1, taille = 50) {
    const c = await this.calcul();
    const tout = this.filtrer(c, { ...f, sousSeuil: false });
    const lignes = this.filtrer(c, f);
    const parDep = this.parDeppsa(tout, f.seuil);
    const totaux = parDep.reduce(
      (t, d) => {
        t.ecoles += d.ecoles;
        t.sousSeuil += d.sousSeuil;
        for (const k of EFFECTIFS) t[k] += d[k];
        t.total += d.total;
        return t;
      },
      {
        ecoles: 0,
        sousSeuil: 0,
        volontaires: 0,
        communautaires: 0,
        contractuels: 0,
        fonctionnaires: 0,
        total: 0,
      },
    );
    const sansEcole = c.sansEcole.filter(
      (s) => !f.departementId || s.departementId === f.departementId,
    );
    return {
      totaux,
      parDeppsa: parDep,
      sansEcole: EFFECTIFS.map((k) => ({
        effectif: k,
        libelle: LIBELLES[k],
        sans: sansEcole
          .filter((s) => s.effectif === k)
          .reduce((n, s) => n + s.sans, 0),
        administration: sansEcole
          .filter((s) => s.effectif === k)
          .reduce((n, s) => n + s.administration, 0),
      })),
      reclassees: c.reclassees.reduce((n, r) => n + r.n, 0),
      aHarmoniser: tout.filter((e) => e.ecritures > 1).length,
      horsOrganigramme: tout.filter((e) => !e.organigramme).length,
      total: lignes.length,
      ecoles: lignes
        .slice((page - 1) * taille, page * taille)
        .map(({ variantes, ...e }) => {
          void variantes;
          return e;
        }),
      departements: c.deps.map(({ id, nom }) => ({ id, nom })),
    };
  }

  async excel(f: FiltresEcoles): Promise<{ nom: string; contenu: Buffer }> {
    const c = await this.calcul();
    const ecoles = this.filtrer(c, f);
    const tout = this.filtrer(c, { ...f, sousSeuil: false });
    const libCycle = f.cycle
      ? f.cycle === 'SANS'
        ? 'cycle non reconnu'
        : CYCLES_ECOLE[f.cycle as CycleEcole]
      : 'tous les cycles';
    const dep = f.departementId
      ? c.deps.find((d) => d.id === f.departementId)?.nom
      : null;
    const sous = `${libCycle}${dep ? ` · DEPPSA ${dep}` : ' · toutes les DEPPSA'}${f.sousSeuil ? ` · écoles de moins de ${f.seuil} fonctionnaires` : ''} · situation au ${new Date().toLocaleDateString('fr-FR')}`;

    const wb = new ExcelJS.Workbook();
    wb.creator = 'SIGRHAS-MEPPSA';
    const VERT = 'FF0F5132';
    const ORANGE = 'FFFDE9D9';
    const GRIS = 'FFF1F5F2';
    const fin: Partial<ExcelJS.Border> = {
      style: 'thin',
      color: { argb: 'FFBDBDBD' },
    };
    const bords = { top: fin, bottom: fin, left: fin, right: fin };
    const feuille = (nom: string, largeurs: number[], paysage = false) => {
      const ws = wb.addWorksheet(nom, {
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
      return ws;
    };
    const entete = (ws: ExcelJS.Worksheet, nbCol: number, t: string) => {
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
      const gauche = Math.max(1, Math.min(3, nbCol - 3));
      const d1 = Math.max(gauche + 1, nbCol - 2);
      ecrire(1, 1, gauche, "MINISTERE DE L'ENSEIGNEMENT PRESCOLAIRE,", g);
      ecrire(1, d1, nbCol, 'REPUBLIQUE DU CONGO', g);
      ecrire(2, 1, gauche, "PRIMAIRE, SECONDAIRE ET DE L'ALPHABETISATION", g);
      ecrire(2, d1, nbCol, 'Unité - Travail - Progrès', g);
      ecrire(3, 1, gauche, '-----------', g);
      ecrire(3, d1, nbCol, '-----------', g);
      ecrire(4, 1, gauche, 'CABINET', g);
      ecrire(5, 1, gauche, '-----------', g);
      ecrire(6, 1, gauche, 'DIRECTION GENERALE DES RESSOURCES HUMAINES', g);
      ecrire(7, 1, gauche, "ET DE L'ADMINISTRATION SCOLAIRE", g);
      ecrire(8, 1, gauche, '-----------', g);
      ecrire(10, 1, nbCol, t, { size: 14, bold: true, color: { argb: VERT } });
      ecrire(11, 1, nbCol, sous, { size: 11, italic: true });
      ws.getRow(1).height = 16;
      ws.getRow(10).height = 22;
      ws.getRow(11).height = 30;
    };
    const titres = (ws: ExcelJS.Worksheet, l: number, noms: string[]) => {
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
        x.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: VERT } };
        x.alignment = {
          horizontal: 'center',
          vertical: 'middle',
          wrapText: true,
        };
        x.border = bords;
      });
      r.height = 32;
    };
    const ligne = (
      ws: ExcelJS.Worksheet,
      l: number,
      valeurs: ExcelJS.CellValue[],
      gras = false,
      fond?: string,
    ) => {
      const r = ws.getRow(l);
      valeurs.forEach((v, i) => {
        const x = r.getCell(i + 1);
        x.value = v;
        x.border = bords;
        x.font = { name: 'Calibri', size: 10, bold: gras };
        x.alignment = {
          vertical: 'middle',
          wrapText: true,
          horizontal: typeof v === 'number' ? 'right' : 'left',
        };
        if (typeof v === 'number') x.numFmt = '#,##0';
        if (fond)
          x.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: fond },
          };
      });
    };
    const note = (
      ws: ExcelJS.Worksheet,
      l: number,
      nbCol: number,
      t: string,
    ) => {
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
      ws.getRow(l).height = Math.max(15, Math.ceil(t.length / 110) * 13);
    };

    // 1. Par école, rangée par DEPPSA, avec un sous-total par DEPPSA
    const enTetes = [
      'N°',
      'DEPPSA',
      'École',
      'Cycle',
      ...EFFECTIFS.map((k) => LIBELLES[k]),
      'Total',
      `Moins de ${f.seuil} fonctionnaires`,
      'Dans l’organigramme',
    ];
    const ws = feuille(
      'Par école',
      [6, 18, 40, 15, 12, 15, 13, 14, 10, 14, 14],
      true,
    );
    entete(ws, enTetes.length, 'EFFECTIFS DU PERSONNEL ENSEIGNANT PAR ÉCOLE');
    titres(ws, 13, enTetes);
    let l = 14;
    let n = 0;
    const totalDep = (d: string, lignes: LigneEcole[]) => {
      ligne(
        ws,
        l++,
        [
          '',
          `Total ${d}`,
          `${lignes.length} école(s)`,
          '',
          ...EFFECTIFS.map((k) => lignes.reduce((s, e) => s + e[k], 0)),
          lignes.reduce((s, e) => s + e.total, 0),
          lignes.filter((e) => e.fonctionnaires < f.seuil).length,
          '',
        ],
        true,
        GRIS,
      );
    };
    let courant: string | null = null;
    let bloc: LigneEcole[] = [];
    for (const e of ecoles) {
      if (courant !== null && e.departement !== courant) {
        totalDep(courant, bloc);
        bloc = [];
      }
      courant = e.departement;
      bloc.push(e);
      const sous = e.fonctionnaires < f.seuil;
      ligne(
        ws,
        l,
        [
          ++n,
          e.departement,
          e.nom,
          e.cycle ? CYCLES_ECOLE[e.cycle] : '—',
          ...EFFECTIFS.map((k) => e[k]),
          e.total,
          sous ? 'Oui' : '',
          e.organigramme ? 'Oui' : 'Non',
        ],
        false,
        sous ? ORANGE : undefined,
      );
      l++;
    }
    if (courant !== null) totalDep(courant, bloc);
    ligne(
      ws,
      l++,
      [
        '',
        'TOTAL GÉNÉRAL',
        `${ecoles.length} école(s)`,
        '',
        ...EFFECTIFS.map((k) => ecoles.reduce((s, e) => s + e[k], 0)),
        ecoles.reduce((s, e) => s + e.total, 0),
        ecoles.filter((e) => e.fonctionnaires < f.seuil).length,
        '',
      ],
      true,
      'FFD9EAD3',
    );
    l++;
    note(
      ws,
      l,
      enTetes.length,
      `En orange : les écoles qui ont moins de ${f.seuil} fonctionnaires. Volontaires et communautaires : registre de la bourse (en poste). Fonctionnaires et contractuels : base du personnel (en activité), école de l’organigramme ou « lieu de service » écrit. La même école écrite de plusieurs façons est comptée une seule fois (voir « Noms à harmoniser »).`,
    );

    // 2. Par DEPPSA
    const parDep = this.parDeppsa(tout, f.seuil);
    const e2 = [
      'DEPPSA',
      'Écoles',
      `Écoles de moins de ${f.seuil} fonctionnaires`,
      ...EFFECTIFS.map((k) => LIBELLES[k]),
      'Total',
    ];
    const ws2 = feuille('Par DEPPSA', [22, 10, 16, 12, 15, 13, 14, 10]);
    entete(ws2, e2.length, 'EFFECTIFS PAR DEPPSA');
    titres(ws2, 13, e2);
    l = 14;
    for (const d of parDep)
      ligne(ws2, l++, [
        d.departement,
        d.ecoles,
        d.sousSeuil,
        ...EFFECTIFS.map((k) => d[k]),
        d.total,
      ]);
    ligne(
      ws2,
      l++,
      [
        'TOTAL',
        parDep.reduce((s, d) => s + d.ecoles, 0),
        parDep.reduce((s, d) => s + d.sousSeuil, 0),
        ...EFFECTIFS.map((k) => parDep.reduce((s, d) => s + d[k], 0)),
        parDep.reduce((s, d) => s + d.total, 0),
      ],
      true,
      'FFD9EAD3',
    );

    // 3. Les personnes qu'on ne peut pas placer dans une école
    const ws3 = feuille('Sans école', [22, 16, 18, 22, 10]);
    const e3 = [
      'DEPPSA',
      'Effectif',
      'École non renseignée',
      'Administration (inspection, direction…)',
      'Total',
    ];
    entete(ws3, e3.length, 'PERSONNES SANS ÉCOLE CONNUE');
    titres(ws3, 13, e3);
    l = 14;
    const s3 = c.sansEcole.filter(
      (s) => !f.departementId || s.departementId === f.departementId,
    );
    for (const s of s3)
      ligne(ws3, l++, [
        s.departement,
        LIBELLES[s.effectif],
        s.sans,
        s.administration,
        s.sans + s.administration,
      ]);
    ligne(
      ws3,
      l++,
      [
        'TOTAL',
        '',
        s3.reduce((x, s) => x + s.sans, 0),
        s3.reduce((x, s) => x + s.administration, 0),
        s3.reduce((x, s) => x + s.sans + s.administration, 0),
      ],
      true,
      'FFD9EAD3',
    );
    l++;
    note(
      ws3,
      l,
      e3.length,
      'Ces personnes ne sont dans aucune école du tableau : leur école (ou lieu de service) n’est pas renseignée, ou elles travaillent dans une inspection, une direction ou un cabinet. Toutes DEPPSA et tous cycles confondus.',
    );

    // 4. Les noms d'une même école écrits de plusieurs façons
    const e4 = [
      'DEPPSA',
      'Cycle',
      'Nom retenu',
      'Écriture rencontrée',
      'Personnes',
    ];
    const ws4 = feuille('Noms à harmoniser', [20, 15, 36, 50, 11]);
    entete(ws4, e4.length, 'NOMS D’ÉCOLES À HARMONISER');
    titres(ws4, 13, e4);
    l = 14;
    for (const e of tout.filter((x) => x.ecritures > 1)) {
      const v = [...e.variantes.entries()].sort((a, b) => b[1] - a[1]);
      v.forEach(([ecrit, k], j) =>
        ligne(
          ws4,
          l++,
          [
            j ? '' : e.departement,
            j ? '' : e.cycle ? CYCLES_ECOLE[e.cycle] : '—',
            j ? '' : e.nom,
            ecrit,
            k,
          ],
          false,
          j ? undefined : GRIS,
        ),
      );
    }
    l++;
    note(
      ws4,
      l,
      e4.length,
      'Chaque école réunit les écritures que le système a reconnues comme la même école (même DEPPSA, même nom une fois ôtés le libellé du cycle, les accents, la ponctuation et les articles). À corriger dans les fichiers d’origine pour n’en garder qu’une.',
    );

    // 5. Reclassements dans les nouvelles DEPPSA
    const e5 = [
      'DEPPSA de la base du personnel',
      'Nouvelle DEPPSA',
      'École',
      'Agents',
    ];
    const ws5 = feuille('DEPPSA reclassées', [26, 20, 40, 10]);
    entete(ws5, e5.length, 'AGENTS RECLASSÉS DANS LES NOUVELLES DEPPSA');
    titres(ws5, 13, e5);
    l = 14;
    for (const r of c.reclassees) ligne(ws5, l++, [r.de, r.vers, r.ecole, r.n]);
    l++;
    note(
      ws5,
      l,
      e5.length,
      'La base des fonctionnaires et des contractuels est encore sur les anciens départements. Un agent est compté dans une nouvelle DEPPSA (Congo-Oubangui, Djoué-Léfini, Nkéni-Alima) quand son école n’est connue que là, d’après l’organigramme et le registre. La fiche de l’agent n’est pas modifiée.',
    );

    const contenu = Buffer.from(await wb.xlsx.writeBuffer());
    const cyc =
      f.cycle && f.cycle !== 'SANS'
        ? ` - ${CYCLES_ECOLE[f.cycle as CycleEcole]}`
        : '';
    return {
      nom: `Effectifs par école${cyc}${dep ? ` - ${dep}` : ''} (${new Date().toLocaleDateString('fr-FR').replace(/\//g, '-')}).xlsx`,
      contenu,
    };
  }
}
