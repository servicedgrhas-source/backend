import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import ExcelJS from 'exceljs';
import { In } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { lireClasseur } from '../common/excel';
import { cleCompacte, enTexte, normaliser } from '../common/texte';
import { JournalService } from '../core/core.service';
import { AgentRecense, Structure } from '../entities';
import {
  LIBELLES_TYPES,
  type ChampFiche,
  type ConfigRecensement,
} from './configuration';
import {
  etape,
  numeroFiche,
  parcoursDe,
  RecensementService,
  type FiltresAgents,
} from './recensement.service';
import { IndexNoms } from '../common/index-noms';
import { estVide, formaterNom, lireValeur, valeurLisible } from './valeurs';

const COL_NUMERO = 'N° DE LA FICHE';
const COL_STATUT = "TYPE D'AGENT";
const ENTETES_NUMERO = [
  'NDELAFICHE',
  'NUMERODELAFICHE',
  'NFICHE',
  'NUMEROFICHE',
  'NUMERODEFICHE',
];
const ENTETES_STATUT = [
  'TYPEDAGENT',
  'STATUTTYPEDAGENT',
  'STATUTDELAGENT',
  'STATUT',
];
/** Noms et prénoms en deux colonnes (extractions de la solde) : rubrique ← colonne nom + colonne prénom. */
const COMPOSES: [string, string[], string[]][] = [
  ['NOMS_PRENOMS', ['NOM', 'NOMS'], ['PRENOM', 'PRENOMS']],
  ['NOM_PERE', ['NOMDEPERE', 'NOMDUPERE'], ['PRENOMDEPERE', 'PRENOMDUPERE']],
  [
    'NOM_MERE',
    ['NOMDEMERE', 'NOMDELAMERE'],
    ['PRENOMDEMERE', 'PRENOMDELAMERE'],
  ],
];

export interface RapportImportRecensement {
  essai: boolean;
  feuille: string;
  lues: number;
  crees: number;
  misAJour: number;
  ignorees: number;
  raisons: { raison: string; n: number; exemples: string[] }[];
  valeursRejetees: { champ: string; n: number; exemples: string[] }[];
  colonnes: { entete: string; rubrique: string }[];
  colonnesIgnorees: string[];
  incomplets: number;
  exemples: string[];
  /** Nouvelles fiches qui ressemblent à une fiche déjà dans la base (à fusionner ou à distinguer). */
  memesProbables: { n: number; exemples: string[] };
  /** Nouvelles fiches mises en contentieux (recensement sur le terrain). */
  contentieux: number;
  /**
   * Import de recensement : les agents déjà dans la base sont seulement complétés (cases vides),
   * les nouveaux vont au contrôle puis à la décision du DG.
   */
  recensement: boolean;
  /** Recensement : rubriques complétées (cases vides remplies) chez les agents déjà dans la base. */
  valeursAjoutees: number;
  /** Recensement : agents retrouvés à qui le fichier n'apporte rien de nouveau. */
  inchanges: number;
  /** Recensement : valeurs du fichier différentes de celles de la base, gardées sans les remplacer. */
  differences: { champ: string; n: number; exemples: string[] }[];
}

@Injectable()
export class ExcelRecensementService {
  constructor(
    private readonly rec: RecensementService,
    private readonly journal: JournalService,
  ) {}

  private champsActifs(c: ConfigRecensement) {
    const ordre = new Map(c.sections.map((s, i) => [s.code, i]));
    return c.champs
      .filter((x) => x.actif)
      .map((x, i) => ({ x, i }))
      .sort(
        (a, b) =>
          (ordre.get(a.x.section) ?? 99) - (ordre.get(b.x.section) ?? 99) ||
          a.i - b.i,
      )
      .map((y) => y.x);
  }

  /* ------------------------------ Modèle et export ------------------------------ */

  /**
   * Classeur de la fiche de renseignements : feuille « Fiches » (une ligne par agent, listes
   * déroulantes, titres en rouge pour les rubriques obligatoires du type choisi), « Consignes »
   * (chaque rubrique : obligatoire pour qui, format, exemple, pièces à joindre) et « Listes ».
   */
  async classeur(
    u: UtilisateurConnecte,
    o: { statut?: string; agents?: AgentRecense[] },
  ) {
    const c = this.rec.config.get();
    const champs = this.champsActifs(c);
    const statut = o.statut ? this.rec.config.statut(o.statut) : null;
    const deps = await this.rec.departements();
    const nomDep = (code: string) =>
      [...deps.parId.values()].find((d) => d.code === code)?.nom;
    const statutsActifs = c.statuts.filter((s) => s.actif);
    const obligatoire = (ch: ChampFiche) =>
      statut
        ? ch.obligatoirePour.includes(statut.code)
        : ch.obligatoirePour.length === statutsActifs.length;

    const wb = new ExcelJS.Workbook();
    wb.creator = 'SIRHAS — DGRHAS';
    const ws = wb.addWorksheet('Fiches', {
      views: [{ state: 'frozen', xSplit: 3, ySplit: 1 }],
    });
    const listes = wb.addWorksheet('Listes', { state: 'hidden' });
    const consignes = wb.addWorksheet('Consignes');

    const entetes = [
      COL_NUMERO,
      COL_STATUT,
      ...champs.map((ch) => ch.libelle.toUpperCase()),
    ];
    const ligneTitres = ws.addRow(entetes);
    ligneTitres.height = 42;
    ligneTitres.eachCell((cell, col) => {
      const ch = champs[col - 3];
      const rouge =
        col === 2 || (ch && (ch.code === 'NOMS_PRENOMS' || obligatoire(ch)));
      cell.font = {
        bold: true,
        color: { argb: rouge ? 'FFFFFFFF' : 'FF1F2937' },
        size: 9,
      };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: {
          argb: col === 1 ? 'FFD1D5DB' : rouge ? 'FFB91C1C' : 'FFE5E7EB',
        },
      };
      cell.alignment = {
        wrapText: true,
        vertical: 'middle',
        horizontal: 'center',
      };
      if (ch) {
        const pour = ch.obligatoirePour.map(
          (s) => c.statuts.find((x) => x.code === s)?.libelle ?? s,
        );
        cell.note = [
          pour.length ? `Obligatoire pour : ${pour.join(', ')}` : 'Facultatif',
          `Format : ${LIBELLES_TYPES[ch.type]}`,
          ch.options.length
            ? `Valeurs : ${ch.options.map((x) => x.libelle).join(' ; ')}`
            : '',
          ch.exemple ? `Exemple : ${ch.exemple}` : '',
          ch.aide,
        ]
          .filter(Boolean)
          .join('\n');
      }
    });
    ws.getColumn(1).width = 14;
    ws.getColumn(2).width = 16;
    ws.getCell('A1').note =
      'Laissez vide pour un nouvel agent. Gardez le numéro pour corriger une fiche déjà dans le système.';

    // Listes déroulantes (feuille « Listes »)
    let colListe = 1;
    const plage = (valeurs: string[]) => {
      const lettre = listes.getColumn(colListe).letter;
      valeurs.forEach((v, i) => (listes.getCell(i + 1, colListe).value = v));
      colListe++;
      return `Listes!$${lettre}$1:$${lettre}$${Math.max(1, valeurs.length)}`;
    };
    const nbLignes = Math.max(2000, (o.agents?.length ?? 0) + 500);
    const validation = (col: number, formule: string, autre: boolean) => {
      const l = ws.getColumn(col).letter;
      (
        ws as unknown as {
          dataValidations: {
            add: (plage: string, v: ExcelJS.DataValidation) => void;
          };
        }
      ).dataValidations.add(`${l}2:${l}${nbLignes}`, {
        type: 'list',
        allowBlank: true,
        formulae: [formule],
        showErrorMessage: !autre,
        errorStyle: autre ? 'information' : 'stop',
        errorTitle: 'Valeur hors liste',
        error: 'Choisissez une valeur de la liste.',
      });
    };
    validation(2, plage(statutsActifs.map((s) => s.libelle)), false);
    champs.forEach((ch, i) => {
      const col = i + 3;
      const colonne = ws.getColumn(col);
      colonne.width =
        ch.type === 'LIGNES' ||
        ch.type === 'LISTE_MULTIPLE' ||
        ch.type === 'TABLEAU'
          ? 40
          : ch.code === 'NOMS_PRENOMS'
            ? 30
            : 18;
      if (ch.type === 'LISTE')
        validation(
          col,
          plage(ch.options.map((x) => x.libelle)),
          ch.autreValeur,
        );
      if (ch.type === 'DEPARTEMENT')
        validation(
          col,
          plage(
            [...deps.parId.values()]
              .sort((a, b) => a.ordre - b.ordre)
              .map((d) => d.nom),
          ),
          false,
        );
      if (ch.type === 'DATE') colonne.numFmt = 'dd/mm/yyyy';
      if (ch.type === 'TELEPHONE' || ch.type === 'TEXTE') colonne.numFmt = '@';
    });

    // Agents déjà recensés (réactualisation)
    for (const a of o.agents ?? []) {
      ws.addRow([
        a.numeroFiche,
        c.statuts.find((s) => s.code === a.statut)?.libelle ?? a.statut,
        ...champs.map((ch) => {
          const v = a.donnees?.[ch.code];
          if (estVide(v)) return null;
          if (ch.type === 'DATE' && /^\d{4}-\d{2}-\d{2}$/.test(String(v))) {
            const [y, m, d] = String(v).split('-').map(Number);
            return new Date(Date.UTC(y, m - 1, d));
          }
          if (ch.type === 'NOMBRE') return Number(v);
          return valeurLisible(ch, v, nomDep);
        }),
      ]);
    }

    // Consignes
    consignes.getColumn(1).width = 34;
    consignes.getColumn(2).width = 22;
    consignes.getColumn(3).width = 36;
    consignes.getColumn(4).width = 46;
    consignes.getColumn(5).width = 30;
    const titre = consignes.addRow([
      `FICHE DE RENSEIGNEMENTS DU PERSONNEL${statut ? ` — ${statut.libelle.toUpperCase()}` : ''}`,
    ]);
    titre.font = { bold: true, size: 13 };
    for (const t of [
      'Une ligne par agent, dans la feuille « Fiches ». Ne changez pas les titres des colonnes.',
      'Titres en rouge : rubriques obligatoires' +
        (statut
          ? ` pour un ${statut.libelle.toLowerCase()}.`
          : ' pour tous les types d’agent.'),
      'Colonne « N° de la fiche » : vide pour un nouvel agent ; pour corriger un agent déjà recensé, gardez son numéro.',
      'Dates au format JJ/MM/AAAA. Plusieurs valeurs dans une case (diplômes, historique) : séparez-les par « ; ».',
      'Les pièces (scans) ne vont pas dans ce fichier : elles se déposent ensuite sur la fiche de chaque agent, ou en masse (fichiers nommés « N° de fiche_CODE », ex. REC-000123_CNI.pdf).',
    ])
      consignes.addRow([t]);
    consignes.addRow([]);
    const t1 = consignes.addRow([
      'RUBRIQUE',
      'OBLIGATOIRE POUR',
      'FORMAT / VALEURS',
      'AIDE',
      'EXEMPLE',
    ]);
    t1.font = { bold: true };
    for (const ch of champs)
      consignes.addRow([
        ch.libelle,
        ch.obligatoirePour.length
          ? ch.obligatoirePour
              .map((s) => c.statuts.find((x) => x.code === s)?.libelle ?? s)
              .join(', ')
          : 'Facultatif',
        ch.options.length
          ? `${LIBELLES_TYPES[ch.type]} : ${ch.options.map((x) => x.libelle).join(' ; ')}${ch.autreValeur ? ' (ou autre)' : ''}`
          : LIBELLES_TYPES[ch.type],
        ch.aide,
        ch.exemple,
      ]).alignment = { wrapText: true, vertical: 'top' };
    consignes.addRow([]);
    const t2 = consignes.addRow([
      'PIÈCE À JOINDRE (SCAN)',
      'EXIGÉE POUR',
      'CONDITION',
      'CODE (nom du fichier)',
    ]);
    t2.font = { bold: true };
    for (const p of c.pieces.filter((x) => x.actif))
      consignes.addRow([
        p.libelle,
        p.exigeePour.length
          ? p.exigeePour
              .map((s) => c.statuts.find((x) => x.code === s)?.libelle ?? s)
              .join(', ')
          : 'Facultative',
        [
          p.si
            ? `si « ${c.champs.find((x) => x.code === p.si!.champ)?.libelle ?? p.si.champ} »${p.si.valeurs.length ? ` = ${p.si.valeurs.join(' ou ')}` : ' est rempli'}`
            : '',
          p.nombreSelon
            ? `une par unité de « ${c.champs.find((x) => x.code === p.nombreSelon)?.libelle ?? p.nombreSelon} »`
            : '',
        ]
          .filter(Boolean)
          .join(' ; '),
        p.code,
      ]).alignment = { wrapText: true, vertical: 'top' };
    wb.views = [
      {
        x: 0,
        y: 0,
        width: 10000,
        height: 20000,
        firstSheet: 0,
        activeTab: 0,
        visibility: 'visible',
      },
    ];
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  async exporter(
    u: UtilisateurConnecte,
    f: FiltresAgents & { statut?: string },
  ) {
    const ids: number[] = [];
    for (let page = 1; ; page++) {
      const r = await this.rec.liste(u, { ...f, page });
      ids.push(...r.lignes.map((l) => l.id as number));
      if (r.lignes.length < r.parPage || ids.length >= 20000) break;
    }
    const agents: AgentRecense[] = [];
    for (let i = 0; i < ids.length; i += 1000)
      agents.push(
        ...(await this.rec.agents.find({
          where: { id: In(ids.slice(i, i + 1000)) },
        })),
      );
    const ordre = new Map(ids.map((id, i) => [id, i]));
    agents.sort((a, b) => (ordre.get(a.id) ?? 0) - (ordre.get(b.id) ?? 0));
    return this.classeur(u, { statut: f.statut, agents });
  }

  /* ------------------------------ Import ------------------------------ */

  /** Colonne du fichier → rubrique de la fiche. */
  private correspondances(c: ConfigRecensement, entetes: string[]) {
    const champs = c.champs.filter((x) => x.actif);
    const cles = new Map<string, ChampFiche>();
    for (const ch of champs)
      for (const e of [ch.libelle, ch.code, ...ch.entetes]) {
        const k = cleCompacte(e);
        if (k && !cles.has(k)) cles.set(k, ch);
      }
    const colonnes = new Map<string, ChampFiche>();
    let numero: string | null = null;
    let statut: string | null = null;
    const ignorees: string[] = [];
    for (const e of entetes) {
      const k = e.replace(/_\d+$/, '');
      if (ENTETES_NUMERO.includes(k)) numero ??= e;
      else if (ENTETES_STATUT.includes(k)) statut ??= e;
      else if (cles.has(k) && ![...colonnes.values()].includes(cles.get(k)!))
        colonnes.set(e, cles.get(k)!);
      else ignorees.push(e);
    }
    // Nom et prénom en deux colonnes
    const composes: { champ: ChampFiche; nom: string; prenom: string }[] = [];
    for (const [code, noms, prenoms] of COMPOSES) {
      const ch = champs.find((x) => x.code === code);
      if (!ch) continue;
      const prenom = entetes.find((e) => prenoms.includes(e));
      const deja = [...colonnes].find(([, x]) => x === ch)?.[0];
      // Rubrique déjà trouvée en une colonne « noms et prénoms » : rien à composer
      if (deja && !(noms.includes(deja) && prenom)) continue;
      const nom = deja ?? entetes.find((e) => noms.includes(e));
      if (!nom) continue;
      if (deja) colonnes.delete(deja);
      composes.push({ champ: ch, nom, prenom: prenom ?? '' });
      for (const x of [nom, prenom]) {
        const i = x ? ignorees.indexOf(x) : -1;
        if (i >= 0) ignorees.splice(i, 1);
      }
    }
    return { colonnes, numero, statut, composes, ignorees };
  }

  async analyser(contenu: Buffer) {
    const c = this.rec.config.get();
    const feuilles = await lireClasseur(contenu, [
      'NOMSETPRENOMS|NOMSPRENOMS|NOMETPRENOMS|NOM',
    ]);
    if (!feuilles.length)
      throw new BadRequestException(
        'Aucune feuille avec une colonne « Noms et prénoms » (ou « Nom »). Utilisez le modèle Excel du système.',
      );
    const lues = feuilles.map((f) => {
      const m = this.correspondances(c, f.entetes);
      return {
        nom: f.nom,
        lignes: f.lignes.length,
        colonnesReconnues:
          m.colonnes.size +
          m.composes.length +
          (m.numero ? 1 : 0) +
          (m.statut ? 1 : 0),
        colonnesIgnorees: m.ignorees,
        aStatut: !!m.statut,
      };
    });
    // Feuilles d’aide (« Consignes »…) : une seule colonne reconnue, elles ne sont pas proposées
    const utiles = lues.filter((f) => f.colonnesReconnues >= 2);
    return utiles.length ? utiles : lues;
  }

  async importer(
    u: UtilisateurConnecte,
    contenu: Buffer,
    o: {
      feuille: string;
      statutDefaut?: string;
      essai: boolean;
      recensement?: boolean;
    },
  ): Promise<RapportImportRecensement> {
    const c = this.rec.config.get();
    const p = await this.rec.perimetre(u);
    const feuilles = await lireClasseur(contenu, [
      'NOMSETPRENOMS|NOMSPRENOMS|NOMETPRENOMS|NOM',
    ]);
    const f = feuilles.find((x) => x.nom === o.feuille);
    if (!f) throw new BadRequestException('Choisissez la feuille à importer.');
    const defaut = o.statutDefaut
      ? this.rec.config.statut(o.statutDefaut)
      : null;
    const m = this.correspondances(c, f.entetes);
    if (!m.statut && !defaut)
      throw new BadRequestException(
        'Ce fichier n’a pas de colonne « Type d’agent » : choisissez le type d’agent de toute la liste.',
      );

    const deps = await this.rec.departements();
    const structures = await this.rec.agents.manager
      .getRepository(Structure)
      .find();
    const structureParNom = new Map<string, Structure>();
    for (const s of structures) {
      structureParNom.set(normaliser(s.nom), s);
      structureParNom.set(normaliser(s.sigle), s);
    }

    // Index des agents déjà recensés : n° de fiche, matricule, nom + date de naissance
    const existants = await this.rec.agents.query<
      {
        id: number;
        numeroFiche: string | null;
        matricule: string | null;
        nomNormalise: string;
        dateNaissance: string | null;
        departementId: number | null;
        structureId: number | null;
      }[]
    >(
      `SELECT id, "numeroFiche", matricule, "nomNormalise", to_char("dateNaissance",'YYYY-MM-DD') AS "dateNaissance", "departementId", "structureId" FROM agent_recense`,
    );
    const parNumero = new Map(
      existants.filter((e) => e.numeroFiche).map((e) => [e.numeroFiche!, e]),
    );
    const parMatricule = new Map(
      existants.filter((e) => e.matricule).map((e) => [e.matricule!, e]),
    );
    const parNom = new Map(
      existants
        .filter((e) => e.dateNaissance)
        .map((e) => [`${e.nomNormalise}|${e.dateNaissance}`, e]),
    );

    const rapport: RapportImportRecensement = {
      essai: o.essai,
      feuille: f.nom,
      lues: f.lignes.length,
      crees: 0,
      misAJour: 0,
      ignorees: 0,
      raisons: [],
      valeursRejetees: [],
      colonnes: [
        ...(m.numero ? [{ entete: m.numero, rubrique: 'N° de la fiche' }] : []),
        ...(m.statut ? [{ entete: m.statut, rubrique: 'Type d’agent' }] : []),
        ...[...m.colonnes].map(([e, ch]) => ({
          entete: e,
          rubrique: ch.libelle,
        })),
        ...m.composes.map((x) => ({
          entete: `${x.nom}${x.prenom ? ` + ${x.prenom}` : ''}`,
          rubrique: x.champ.libelle,
        })),
      ],
      colonnesIgnorees: m.ignorees,
      incomplets: 0,
      exemples: [],
      memesProbables: { n: 0, exemples: [] },
      contentieux: 0,
      recensement: !!o.recensement,
      valeursAjoutees: 0,
      inchanges: 0,
      differences: [],
    };
    const difference = (ch: string, ex: string) => {
      const x =
        rapport.differences.find((y) => y.champ === ch) ??
        rapport.differences[
          rapport.differences.push({ champ: ch, n: 0, exemples: [] }) - 1
        ];
      x.n++;
      if (x.exemples.length < 5) x.exemples.push(ex);
    };
    // Fiches déjà dans la base, pour repérer la même personne sous un autre nom ou sans date
    const index = new IndexNoms<{ nom: string; numero: string | null }>();
    for (const e of existants)
      index.ajouter(e.nomNormalise, e.dateNaissance, {
        nom: e.nomNormalise,
        numero: e.numeroFiche,
      });
    const raison = (r: string, ex: string) => {
      rapport.ignorees++;
      const x =
        rapport.raisons.find((y) => y.raison === r) ??
        rapport.raisons[
          rapport.raisons.push({ raison: r, n: 0, exemples: [] }) - 1
        ];
      x.n++;
      if (x.exemples.length < 5) x.exemples.push(ex);
    };
    const rejet = (ch: ChampFiche, ex: string) => {
      const x =
        rapport.valeursRejetees.find((y) => y.champ === ch.libelle) ??
        rapport.valeursRejetees[
          rapport.valeursRejetees.push({
            champ: ch.libelle,
            n: 0,
            exemples: [],
          }) - 1
        ];
      x.n++;
      if (x.exemples.length < 5) x.exemples.push(ex);
    };

    const aCreer: AgentRecense[] = [];
    const aMettreAJour: AgentRecense[] = [];
    const majs: {
      id: number;
      donnees: Record<string, unknown>;
      statut: string | null;
      structureId: number | null;
      departementId: number | null;
    }[] = [];
    const vus = new Set<string>();
    const idsMaj = new Set<number>();

    for (const l of f.lignes) {
      const ligneTxt = `ligne ${l._ligne}`;
      const donnees: Record<string, unknown> = {};
      const suites: [string, unknown][] = [];
      for (const [e, ch] of m.colonnes) {
        const lu = lireValeur(ch, l[e]);
        if (lu.erreur) rejet(ch, `${ligneTxt} : ${lu.erreur}`);
        else if (!estVide(lu.valeur)) donnees[ch.code] = lu.valeur;
        if (lu.suite) suites.push([ch.code, lu.suite]);
      }
      // Deuxième téléphone écrit dans la case du premier
      for (const [code, v] of suites)
        if (code === 'TELEPHONE_1' && estVide(donnees.TELEPHONE_2))
          donnees.TELEPHONE_2 = v;
      for (const x of m.composes) {
        // Nom et prénom en deux colonnes : on sait où finit le nom (« NOM Prénoms »)
        const nomBrut = estVide(l[x.nom]) ? '' : enTexte(l[x.nom]);
        const prenomBrut =
          x.prenom && !estVide(l[x.prenom]) ? enTexte(l[x.prenom]) : '';
        const brut =
          x.champ.code === 'NOMS_PRENOMS' && nomBrut && prenomBrut
            ? formaterNom(
                `${nomBrut.toUpperCase()} ${prenomBrut.toLowerCase()}`,
              )
            : [nomBrut, prenomBrut].filter(Boolean).join(' ');
        const lu = lireValeur(x.champ, brut);
        if (!estVide(lu.valeur)) donnees[x.champ.code] = lu.valeur;
      }
      if (typeof donnees.NOMS_PRENOMS === 'string')
        donnees.NOMS_PRENOMS = formaterNom(donnees.NOMS_PRENOMS);
      const nom = enTexte(donnees.NOMS_PRENOMS).trim();
      if (!nom) {
        raison('Sans noms et prénoms', ligneTxt);
        continue;
      }
      const statut =
        m.statut && !estVide(l[m.statut])
          ? this.rec.config.statutDepuisTexte(l[m.statut])
          : defaut;
      if (!statut) {
        raison(
          'Type d’agent non reconnu',
          `${ligneTxt} : « ${enTexte(l[m.statut ?? ''])} » (${nom})`,
        );
        continue;
      }
      const col = await this.rec.colonnes(donnees);
      const numBrut = m.numero
        ? normaliser(l[m.numero]).replace(/\s/g, '')
        : '';
      // Seul un n° de fiche du système (« REC-000123 ») compte : le « numéro de la fiche » d'une
      // autre opération (enrôlement biométrique…) n'est qu'un numéro d'ordre, il désignerait la
      // fiche d'une autre personne
      const num = /^REC-?\d{1,6}$/.test(numBrut)
        ? numeroFiche(Number(numBrut.replace(/\D/g, '')))
        : null;
      const cle =
        num ??
        col.matricule ??
        `${col.nomNormalise}|${col.dateNaissance ?? ''}`;
      if (vus.has(cle)) {
        raison(
          'En double dans le fichier (même n° de fiche, matricule, ou nom et date de naissance)',
          `${ligneTxt} : ${nom}`,
        );
        continue;
      }
      vus.add(cle);
      const existant =
        (num ? parNumero.get(num) : undefined) ??
        (col.matricule ? parMatricule.get(col.matricule) : undefined) ??
        (col.dateNaissance
          ? parNom.get(`${col.nomNormalise}|${col.dateNaissance}`)
          : undefined);
      if (num && !parNumero.get(num)) {
        raison(
          'N° de fiche inconnu (laissez la case vide pour un nouvel agent)',
          `${ligneTxt} : ${numBrut} (${nom})`,
        );
        continue;
      }

      // Rattachement : la structure du compte, ou le lieu de service reconnu dans l'organigramme
      let structureId: number | null = null;
      if ('structures' in p)
        structureId =
          existant?.structureId && p.structures.includes(existant.structureId)
            ? existant.structureId
            : p.principale;
      else if (donnees.LIEU_SERVICE)
        structureId =
          structureParNom.get(normaliser(donnees.LIEU_SERVICE))?.id ?? null;
      const struct = structureId
        ? structures.find((s) => s.id === structureId)
        : undefined;
      let departementId = col.departementId ?? struct?.departementId ?? null;
      if ('departementId' in p) {
        if (departementId && departementId !== p.departementId) {
          raison('Agent d’un autre département', `${ligneTxt} : ${nom}`);
          continue;
        }
        departementId = p.departementId;
      }
      if (departementId && !donnees.DEPARTEMENT) {
        const d = deps.parId.get(departementId);
        if (d) donnees.DEPARTEMENT = d.code;
      }
      if (struct && !donnees.LIEU_SERVICE && 'structures' in p)
        donnees.LIEU_SERVICE = struct.nom;

      if (existant) {
        if (!this.rec.dansPerimetre(p, existant)) {
          raison(
            'Agent déjà recensé dans un autre établissement ou département',
            `${ligneTxt} : ${nom}`,
          );
          continue;
        }
        if (idsMaj.has(existant.id)) {
          raison(
            'En double dans le fichier (même n° de fiche, matricule, ou nom et date de naissance)',
            `${ligneTxt} : ${nom}`,
          );
          continue;
        }
        idsMaj.add(existant.id);
        majs.push({
          id: existant.id,
          donnees,
          statut: m.statut && !estVide(l[m.statut]) ? statut.code : null,
          structureId,
          departementId,
        });
      } else {
        const semblable = index.probables(nom, col.dateNaissance)[0];
        // Recensement : un agent du fichier absent de la base va au contrôle, puis au DG
        const motif = o.recensement
          ? `Trouvé dans le fichier de recensement (feuille « ${f.nom} »), absent de la base${semblable ? ` ; ressemble à la fiche ${semblable.numero ?? semblable.nom} (même personne ?)` : ''} : à contrôler`
          : false;
        const a = this.rec.agents.create({
          ...col,
          departementId,
          structureId,
          statut: statut.code,
          donnees,
          parcours: [etape(statut.code, u.nom)],
          contentieux: this.rec.contentieuxPour(p, motif, u.nom),
          source: 'IMPORT',
          creePar: u.nom,
          modifiePar: u.nom,
        });
        aCreer.push(a);
        if (a.contentieux) rapport.contentieux++;
        if (semblable) {
          rapport.memesProbables.n++;
          if (rapport.memesProbables.exemples.length < 5)
            rapport.memesProbables.exemples.push(
              `${ligneTxt} : ${nom} ≈ ${semblable.numero ?? semblable.nom}`,
            );
        }
        if (rapport.exemples.length < 5)
          rapport.exemples.push(`${nom} (${statut.libelle})`);
      }
    }

    // Réactualisation : seules les cases remplies remplacent les valeurs déjà connues
    for (let i = 0; i < majs.length; i += 1000) {
      const lot = majs.slice(i, i + 1000);
      const charges = new Map(
        (
          await this.rec.agents.find({
            where: { id: In(lot.map((x) => x.id)) },
          })
        ).map((a) => [a.id, a]),
      );
      for (const x of lot) {
        const a = charges.get(x.id);
        if (!a) continue;
        if (o.recensement) {
          // Recensement : on complète seulement les cases vides ; une valeur différente de la
          // base est signalée, jamais remplacée (la fiche se corrige à l'écran, après vérification)
          let ajoutees = 0;
          for (const [k, v] of Object.entries(x.donnees)) {
            if (estVide(a.donnees[k])) {
              a.donnees[k] = v;
              ajoutees++;
            } else if (
              normaliser(JSON.stringify(a.donnees[k])) !==
              normaliser(JSON.stringify(v))
            )
              difference(
                c.champs.find((ch) => ch.code === k)?.libelle ?? k,
                `${a.nomComplet} (${a.numeroFiche}) : base « ${enTexte(a.donnees[k]) || JSON.stringify(a.donnees[k])} », fichier « ${enTexte(v) || JSON.stringify(v)} »`,
              );
          }
          if (x.statut && x.statut !== a.statut)
            difference(
              'Type d’agent',
              `${a.nomComplet} (${a.numeroFiche}) : base « ${a.statut} », fichier « ${x.statut} » (à changer sur la fiche : « Changer de statut »)`,
            );
          if (!ajoutees && (a.structureId || !x.structureId)) {
            rapport.inchanges++;
            continue;
          }
          rapport.valeursAjoutees += ajoutees;
          const nouvelles = await this.rec.colonnes(a.donnees);
          Object.assign(a, nouvelles, {
            departementId:
              a.departementId ?? nouvelles.departementId ?? x.departementId,
            structureId: a.structureId ?? x.structureId,
            modifiePar: u.nom,
          });
          aMettreAJour.push(a);
          continue;
        }
        a.donnees = { ...a.donnees, ...x.donnees };
        if (x.statut && x.statut !== a.statut) {
          a.parcours = [...parcoursDe(a), etape(x.statut, u.nom)];
          a.statut = x.statut;
        }
        const nouvelles = await this.rec.colonnes(a.donnees);
        Object.assign(a, nouvelles, {
          departementId:
            nouvelles.departementId ?? a.departementId ?? x.departementId,
          structureId: x.structureId ?? a.structureId,
          modifiePar: u.nom,
        });
        aMettreAJour.push(a);
      }
    }
    const fournies = await this.rec.piecesFournies(
      aMettreAJour.map((a) => a.id),
    );
    for (const a of aCreer) this.rec.appliquerEvaluation(a, {});
    for (const a of aMettreAJour)
      this.rec.appliquerEvaluation(a, fournies.get(a.id) ?? {});
    rapport.crees = aCreer.length;
    rapport.misAJour = aMettreAJour.length;
    rapport.incomplets = [...aCreer, ...aMettreAJour].filter(
      (a) => !a.complet,
    ).length;
    rapport.raisons.sort((a, b) => b.n - a.n);
    rapport.valeursRejetees.sort((a, b) => b.n - a.n);
    rapport.differences.sort((a, b) => b.n - a.n);
    if (o.essai) return rapport;

    if (
      !('tous' in p) &&
      !aCreer.length &&
      !aMettreAJour.length &&
      rapport.ignorees
    )
      throw new ForbiddenException(
        'Aucune ligne de ce fichier ne concerne votre établissement ou votre département.',
      );
    for (let i = 0; i < aCreer.length; i += 500)
      await this.rec.agents.save(aCreer.slice(i, i + 500));
    for (let i = 0; i < aMettreAJour.length; i += 500)
      await this.rec.agents.save(aMettreAJour.slice(i, i + 500));
    await this.rec.agents.query(
      `UPDATE agent_recense SET "numeroFiche" = 'REC-' || lpad(id::text, 6, '0') WHERE "numeroFiche" IS NULL`,
    );
    // Fiches importées sans établissement : rattachées d'après leur lieu de service
    await this.rec.rattacherAutomatiquement();
    await this.journal.log(u, 'RECENSEMENT_IMPORT', 'agent_recense', null, {
      feuille: f.nom,
      crees: rapport.crees,
      misAJour: rapport.misAJour,
      ignorees: rapport.ignorees,
      recensement: rapport.recensement,
      contentieux: rapport.contentieux,
    });
    return rapport;
  }
}
