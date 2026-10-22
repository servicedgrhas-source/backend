import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import ExcelJS from 'exceljs';
import { Repository } from 'typeorm';
import { lireClasseur, type Ligne } from '../common/excel';
import { motsDuNom, ressemblance } from '../common/ressemblance';
import { lireDate, nettoyer } from '../common/texte';
import { Agent } from '../entities';

/** Écritures possibles de la colonne des noms dans les fichiers reçus. */
const COLONNE_NOM =
  'NOMSETPRENOMS|NOMETPRENOMS|NOMSPRENOMS|NOMPRENOMS|NOMSETPRENOM';

/** Colonnes reprises pour aider à reconnaître la personne (préfixes d'en-têtes compactés). */
const DETAILS: [string, string][] = [
  ['DIPLOME', 'Diplôme'],
  ['CYCLE', 'Cycle'],
  ['DEPARTEMENTRETENU', 'Département retenu'],
  ['DEPART', 'Département'],
  ['VAGUE', 'Vague'],
  ['PROMOT', 'Promotion'],
  ['QUOTA', 'Quota'],
  ['NTEXTE', 'N° texte'],
  ['REFAFFECTATION', 'Note'],
  ['ETABLISSEMENT', 'Établissement'],
  ['ORIGINE', 'Origine'],
  ['OBS', 'Obs.'],
];

interface Personne {
  i: number;
  /** n° du fichier (0 à 3), ou -1 pour la base du système */
  fichier: number;
  origine: string;
  feuille: string | null;
  ligne: number | null;
  nom: string;
  mots: string[];
  cle: string;
  naissance: string | null;
  details: string;
}

export type Niveau = 'IDENTIQUE' | 'PROBABLE';

/**
 * Rapprochement : jusqu'à 4 fichiers Excel comparés entre eux (et avec la base du système) :
 * mêmes personnes, ressemblances, doublons dans un même fichier, homonymes à vérifier.
 * Rien n'est enregistré : les fichiers ne servent qu'à la comparaison.
 */
@Injectable()
export class RapprochementService {
  constructor(
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
  ) {}

  private async lireFichier(
    contenu: Buffer,
    n: number,
    nomFichier: string,
    masquees: boolean,
    debut: number,
    choisies?: string[],
  ) {
    const feuilles = (
      await lireClasseur(contenu, [COLONNE_NOM], {
        inclureMasquees: masquees,
      })
    ).filter((f) => !choisies || choisies.includes(f.nom));
    const personnes: Personne[] = [];
    for (const f of feuilles) {
      const cleNom = f.entetes.find((k) =>
        COLONNE_NOM.split('|').some((a) => k.startsWith(a)),
      )!;
      const cleNaissance = f.entetes.find(
        (k) => k.startsWith('DATEDENAIS') || k.startsWith('DATEETLIEU'),
      );
      for (const l of f.lignes) {
        const nom = nettoyer(l[cleNom]);
        if (!nom || /^noms?\s*(et\s*)?pr[ée]nom/i.test(nom)) continue;
        const mots = motsDuNom(nom);
        if (mots.length < 2) continue;
        personnes.push({
          i: debut + personnes.length,
          fichier: n,
          origine: `Fichier ${n + 1} : ${nomFichier}`,
          feuille: f.nom,
          ligne: l._ligne,
          nom,
          mots,
          cle: [...mots].sort().join(' '),
          naissance: cleNaissance ? this.naissance(l[cleNaissance]) : null,
          details: this.details(l, f.entetes),
        });
      }
    }
    return {
      feuilles: feuilles.map((f) => ({ nom: f.nom, lignes: f.lignes.length })),
      personnes,
    };
  }

  /** Date de naissance, même écrite « 12/05/1995 à Brazzaville ». */
  private naissance(v: unknown): string | null {
    const d = lireDate(v);
    if (d) return d;
    const m = /(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(
      typeof v === 'string' ? v : '',
    );
    return m ? lireDate(`${m[1]}/${m[2]}/${m[3]}`) : null;
  }

  private details(l: Ligne, entetes: string[]) {
    const pris = new Set<string>();
    const parties: string[] = [];
    for (const [prefixe, libelle] of DETAILS) {
      const k = entetes.find((e) => e.startsWith(prefixe) && !pris.has(e));
      if (!k) continue;
      pris.add(k);
      const v = nettoyer(
        l[k] instanceof Date ? l[k].toISOString().slice(0, 10) : l[k],
      );
      if (v && !/^\d{8,}$/.test(v))
        parties.push(`${libelle} : ${v.slice(0, 40)}`);
    }
    return parties.slice(0, 5).join(' · ');
  }

  /** La base du système : Base des recrutés (avec l'étape et la note) et listes des années passées. */
  private async lireBase(debut: number) {
    const lignes = await this.agents.query<
      {
        nom: string;
        naissance: string | null;
        quota: number | null;
        feuille: string;
        etat: string | null;
        transmis: boolean;
        recu: boolean;
        numeroTexte: string | null;
        statut: string | null;
        note: string | null;
        horsSysteme: string | null;
      }[]
    >(`
      SELECT a."nomComplet" AS nom, a."dateNaissance" AS naissance, a.quota, a.feuille,
             a."etatFiche" AS etat, a."transmissionNumero" IS NOT NULL AS transmis,
             a."lotPublicationId" IS NOT NULL AS recu, a."numeroTexte", f.statut,
             n.numero AS note,
             (SELECT string_agg(r.brut, ', ') FROM reference_note r WHERE r."agentId" = a.id) AS "horsSysteme"
        FROM agent a
        LEFT JOIN affectation f ON f."agentId" = a.id
        LEFT JOIN note_service n ON n.id = f."noteId"`);
    const anciens = await this.agents.query<
      {
        nom: string;
        naissance: string | null;
        annee: number | null;
        source: string;
      }[]
    >(
      `SELECT "nomComplet" AS nom, "dateNaissance" AS naissance, annee, source FROM ancien_recrute`,
    );
    const personnes: Personne[] = [];
    const ajouter = (
      nom: string,
      naissance: string | null,
      origine: string,
      details: string,
    ) => {
      const mots = motsDuNom(nom);
      if (mots.length < 2) return;
      personnes.push({
        i: debut + personnes.length,
        fichier: -1,
        origine,
        feuille: null,
        ligne: null,
        nom,
        mots,
        cle: [...mots].sort().join(' '),
        naissance,
        details,
      });
    };
    for (const a of lignes) {
      const quota =
        a.feuille === 'QUOTA_AUTRES'
          ? 'quota « Autres »'
          : a.quota
            ? `quota ${a.quota}`
            : 'sans quota';
      const etape =
        a.statut === 'AFFECTE'
          ? `affecté${a.note ? ` (note n° ${a.note})` : ''}`
          : a.horsSysteme
            ? `affecté hors système (note n° ${a.horsSysteme})`
            : a.recu
              ? `texte reçu${a.numeroTexte ? ` n° ${a.numeroTexte}` : ''}, pas encore affecté`
              : a.transmis
                ? 'envoyé à la FP, texte attendu'
                : a.etat === 'VALIDEE'
                  ? 'validé, prêt à partir'
                  : 'saisi, en cours de contrôle';
      ajouter(a.nom, a.naissance, 'Base des recrutés', `${quota} · ${etape}`);
    }
    for (const a of anciens)
      ajouter(
        a.nom,
        a.naissance,
        'Recrutés des années passées',
        `${a.annee ? `recruté en ${a.annee}` : 'année inconnue'} · liste « ${a.source} »`,
      );
    return { recrutes: lignes.length, anciens: anciens.length, personnes };
  }

  /** Feuilles de chaque fichier qui ont une colonne de noms (pour choisir celles à comparer). */
  async feuilles(
    fichiers: { nom: string; contenu: Buffer }[],
    masquees: boolean,
  ) {
    const res: {
      nom: string;
      feuilles: { nom: string; lignes: number; masquee: boolean }[];
    }[] = [];
    for (const f of fichiers) {
      const toutes = await lireClasseur(f.contenu, [COLONNE_NOM], {
        inclureMasquees: true,
      });
      const visibles = new Set(
        (await lireClasseur(f.contenu, [COLONNE_NOM])).map((x) => x.nom),
      );
      res.push({
        nom: f.nom,
        feuilles: toutes
          .filter((x) => masquees || visibles.has(x.nom))
          .map((x) => ({
            nom: x.nom,
            lignes: x.lignes.length,
            masquee: !visibles.has(x.nom),
          })),
      });
    }
    return res;
  }

  async comparer(
    fichiers: { nom: string; contenu: Buffer }[],
    options: {
      avecBase: boolean;
      masquees: boolean;
      feuilles?: (string[] | null)[];
    },
  ) {
    if (!fichiers.length)
      throw new BadRequestException(
        'Choisissez au moins un fichier Excel (jusqu’à 4).',
      );
    if (fichiers.length > 4)
      throw new BadRequestException('Quatre fichiers au plus à la fois.');
    if (fichiers.length === 1 && !options.avecBase)
      throw new BadRequestException(
        'Avec un seul fichier, cochez « Comparer aussi avec la base du système » (sinon il n’y a rien à comparer, à part les doublons du fichier).',
      );
    const tous: Personne[] = [];
    const lus: {
      nom: string;
      feuilles: { nom: string; lignes: number }[];
      personnes: number;
    }[] = [];
    for (const [n, f] of fichiers.entries()) {
      const r = await this.lireFichier(
        f.contenu,
        n,
        f.nom,
        options.masquees,
        tous.length,
        options.feuilles?.[n] ?? undefined,
      );
      if (!r.personnes.length)
        throw new BadRequestException(
          `« ${f.nom} » : aucune feuille avec une colonne « Noms et prénoms ». Vérifiez le fichier (ou cochez « Lire aussi les feuilles masquées »).`,
        );
      tous.push(...r.personnes);
      lus.push({
        nom: f.nom,
        feuilles: r.feuilles,
        personnes: r.personnes.length,
      });
    }
    let base = { recrutes: 0, anciens: 0 };
    if (options.avecBase) {
      const b = await this.lireBase(tous.length);
      tous.push(...b.personnes);
      base = { recrutes: b.recrutes, anciens: b.anciens };
    }

    // Paires à comparer : même nom (mots dans n'importe quel ordre), ou un mot peu courant en commun.
    // Clé numérique a × N + b : beaucoup plus rapide qu'un texte sur des dizaines de milliers de lignes.
    const N = tous.length;
    const paires = new Set<number>();
    const ajouterPaire = (a: number, b: number) => {
      if (a === b) return;
      const [x, y] = a < b ? [a, b] : [b, a];
      // Deux lignes de la base entre elles : ce n'est pas l'objet du rapprochement
      if (tous[x].fichier === -1 && tous[y].fichier === -1) return;
      paires.add(x * N + y);
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
    for (const ids of parCle.values())
      for (let x = 0; x < ids.length; x++)
        for (let y = x + 1; y < ids.length; y++) ajouterPaire(ids[x], ids[y]);
    for (const ids of parMot.values()) {
      if (ids.length > 150) continue; // nom très courant : les autres mots suffisent
      for (let x = 0; x < ids.length; x++)
        for (let y = x + 1; y < ids.length; y++) ajouterPaire(ids[x], ids[y]);
    }

    // Union des personnes très probablement identiques ; homonymes à part
    const parent = tous.map((p) => p.i);
    const racine = (i: number): number => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]];
      return i;
    };
    const lies: [number, number, Niveau][] = [];
    const homonymes: [number, number][] = [];
    for (const k of paires) {
      const a = Math.floor(k / N),
        b = k % N;
      const pa = tous[a],
        pb = tous[b];
      const dates =
        !!pa.naissance && !!pb.naissance && pa.naissance !== pb.naissance;
      let niveau: Niveau;
      if (pa.cle === pb.cle) {
        if (dates) {
          homonymes.push([a, b]);
          continue;
        }
        niveau = 'IDENTIQUE';
      } else if (
        ressemblance(pa.mots, pa.naissance, pb.mots, pb.naissance) ===
        'PROBABLE'
      ) {
        niveau = 'PROBABLE';
      } else continue;
      lies.push([a, b, niveau]);
      parent[racine(a)] = racine(b);
    }
    const groupesMap = new Map<number, Set<number>>();
    const probable = new Set<number>();
    for (const [a, b, niveau] of lies) {
      const r = racine(a);
      const g = groupesMap.get(r) ?? new Set<number>();
      g.add(a).add(b);
      groupesMap.set(r, g);
      if (niveau === 'PROBABLE') probable.add(r);
    }
    const groupes = [...groupesMap.entries()]
      .map(([r, g]) => [r, [...g]] as const)
      .filter(([, g]) => g.some((i) => tous[i].fichier >= 0))
      .map(([r, g]) => {
        const niveaux: Niveau[] = [probable.has(r) ? 'PROBABLE' : 'IDENTIQUE'];
        const membres = g
          .map((i) => tous[i])
          .sort(
            (a, b) =>
              (a.fichier === -1 ? 99 : a.fichier) -
                (b.fichier === -1 ? 99 : b.fichier) ||
              (a.ligne ?? 0) - (b.ligne ?? 0),
          );
        const fichiersTouches = new Set(
          membres.filter((m) => m.fichier >= 0).map((m) => m.fichier),
        );
        return {
          niveau: niveaux.every((n) => n === 'IDENTIQUE')
            ? 'IDENTIQUE'
            : 'PROBABLE',
          dansBase: membres.some((m) => m.fichier === -1),
          doublonInterne:
            membres.filter((m) => m.fichier >= 0).length > fichiersTouches.size,
          membres: membres.map((m) => ({
            origine: m.origine,
            feuille: m.feuille,
            ligne: m.ligne,
            nom: m.nom,
            naissance: m.naissance,
            details: m.details,
          })),
        };
      })
      .sort((a, b) =>
        a.niveau === b.niveau
          ? a.membres[0].nom.localeCompare(b.membres[0].nom, 'fr')
          : a.niveau === 'IDENTIQUE'
            ? -1
            : 1,
      );

    // Situation de chaque ligne des fichiers
    const groupeDe = new Map<number, number[]>();
    for (const g of groupesMap.values()) {
      const liste = [...g];
      for (const i of liste) groupeDe.set(i, liste);
    }
    const resultat = (p: Personne) => {
      const g = (groupeDe.get(p.i) ?? [])
        .filter((i) => i !== p.i)
        .map((i) => tous[i]);
      const base = g.filter((x) => x.fichier === -1);
      const autres = g.filter((x) => x.fichier >= 0 && x.fichier !== p.fichier);
      const memeFichier = g.filter((x) => x.fichier === p.fichier);
      return {
        trouve: g.length > 0,
        base: base.map((x) => `${x.origine} (${x.details})`),
        autresFichiers: autres.map(
          (x) => `${x.origine} › ${x.feuille}, ligne ${x.ligne}`,
        ),
        memeFichier: memeFichier.map((x) => `${x.feuille}, ligne ${x.ligne}`),
      };
    };
    const parFichier = lus.map((f, n) => {
      const ps = tous.filter((p) => p.fichier === n);
      const r = ps.map(resultat);
      return {
        ...f,
        doublonsInternes: r.filter((x) => x.memeFichier.length).length,
        dansAutresFichiers: r.filter((x) => x.autresFichiers.length).length,
        dansBase: r.filter((x) => x.base.length).length,
        nullePart: r.filter((x) => !x.trouve).length,
      };
    });
    return {
      fichiers: parFichier,
      avecBase: options.avecBase,
      base,
      groupes: groupes.slice(0, 3000),
      groupesTotal: groupes.length,
      homonymes: homonymes
        .filter(([a, b]) => tous[a].fichier >= 0 || tous[b].fichier >= 0)
        .slice(0, 500)
        .map(([a, b]) =>
          [a, b].map((i) => ({
            origine: tous[i].origine,
            feuille: tous[i].feuille,
            ligne: tous[i].ligne,
            nom: tous[i].nom,
            naissance: tous[i].naissance,
            details: tous[i].details,
          })),
        ),
      // Pour le fichier Excel du résultat
      lignes: tous
        .filter((p) => p.fichier >= 0)
        .map((p) => ({ p, r: resultat(p) })),
    };
  }

  /** Le résultat en Excel : une feuille par fichier, chaque ligne avec ce qui a été trouvé (en rouge si trouvé ailleurs). */
  async excel(
    fichiers: { nom: string; contenu: Buffer }[],
    options: {
      avecBase: boolean;
      masquees: boolean;
      feuilles?: (string[] | null)[];
    },
  ) {
    const r = await this.comparer(fichiers, options);
    const wb = new ExcelJS.Workbook();
    const resume = wb.addWorksheet('Résumé');
    resume.addRow([
      'Rapprochement du ' + new Date().toLocaleDateString('fr-FR'),
    ]).font = { bold: true, size: 13 };
    resume.addRow([]);
    resume.addRow([
      'Fichier',
      'Personnes lues',
      'En double dans le fichier',
      'Dans un autre fichier',
      'Dans la base du système',
      'Trouvées nulle part',
    ]).font = { bold: true };
    for (const f of r.fichiers)
      resume.addRow([
        f.nom,
        f.personnes,
        f.doublonsInternes,
        f.dansAutresFichiers,
        r.avecBase ? f.dansBase : '—',
        f.nullePart,
      ]);
    resume.columns.forEach((c) => (c.width = 22));
    resume.getColumn(1).width = 50;
    for (const [n, f] of r.fichiers.entries()) {
      const ws = wb.addWorksheet(`Fichier ${n + 1}`.slice(0, 31));
      ws.addRow([f.nom]).font = { bold: true };
      ws.addRow([
        'Feuille',
        'Ligne',
        'Noms et prénoms',
        'Date de naissance',
        'Résultat',
        'Trouvé dans',
        'Détails',
      ]).font = { bold: true };
      for (const { p, r: x } of r.lignes.filter((l) => l.p.fichier === n)) {
        const ou = [
          ...x.base,
          ...x.autresFichiers,
          ...x.memeFichier.map((m) => `même fichier : ${m}`),
        ].join(' | ');
        const etat = !x.trouve
          ? 'Trouvé nulle part'
          : x.base.length
            ? 'Déjà dans la base'
            : x.autresFichiers.length
              ? 'Dans un autre fichier'
              : 'En double dans le fichier';
        const row = ws.addRow([
          p.feuille,
          p.ligne,
          p.nom,
          p.naissance,
          etat,
          ou,
          p.details,
        ]);
        if (x.trouve)
          row.getCell(3).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: {
              argb:
                x.base.length || x.autresFichiers.length
                  ? 'FFFFC7CE'
                  : 'FFFFEB9C',
            },
          };
      }
      ws.columns = [
        { width: 22 },
        { width: 8 },
        { width: 40 },
        { width: 14 },
        { width: 24 },
        { width: 70 },
        { width: 60 },
      ];
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
}
