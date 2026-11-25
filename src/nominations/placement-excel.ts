import ExcelJS from 'exceljs';
import { GENERE_PAR } from '../common/export-liste';
import type {
  EtatNominationPlacee,
  NominationPlacee,
  RapportPlacement,
} from './placement.service';

/*
 * Placer les nommés, en Excel (DG, 25/11/2026) : « un fichier à envoyer aux DDEPPSA pour leur
 * montrer à quel dilemme on est confronté dans le choix ». Une feuille de synthèse, puis une
 * feuille par onglet de la page (à confirmer, structure introuvable, conflits…), avec la raison du
 * doute et une colonne vide où la DDEPPSA écrit sa décision.
 */

const VERT = 'FF0F5132';
const JAUNE = 'FFFEF9C3';
const GRIS = 'FFF4F4F5';

/** Les feuilles, dans l'ordre de la page ; ce qui explique le choix à faire. */
const FEUILLES: {
  etat: EtatNominationPlacee;
  nom: string;
  titre: string;
  aide: string;
  question: string;
}[] = [
  {
    etat: 'A_CONFIRMER',
    nom: 'À confirmer',
    titre: 'Nominations à confirmer : la structure ressemble, sans certitude',
    aide: 'Le poste écrit dans la note ressemble à une structure de l’organigramme, mais le nom est proche sans être le même, ou plusieurs structures sont possibles. La colonne « Le doute » dit lesquelles.',
    question:
      'Pour chaque ligne : est-ce bien la structure proposée ? Sinon, laquelle ?',
  },
  {
    etat: 'INTROUVABLE',
    nom: 'Structure introuvable',
    titre: 'Nominations dont la structure n’est pas dans l’organigramme',
    aide: 'Le poste écrit dans la note n’existe pas dans l’organigramme (école absente, ou écrite très autrement). Quand l’inspection de la circonscription est connue, elle est proposée pour y ajouter l’école.',
    question:
      'Pour chaque ligne : l’école existe-t-elle ? Sous quel nom exact, et de quelle inspection relève-t-elle ?',
  },
  {
    etat: 'CONFLIT',
    nom: 'Conflits',
    titre:
      'Conflits : deux responsables pour une même structure, ou une personne à deux postes',
    aide: 'Ces nominations se contredisent : deux chefs nommés pour la même école ou inspection, ou une même personne nommée à plusieurs postes la même année.',
    question:
      'Pour chaque cas : qui est vraiment en poste, et où ? Laquelle des nominations faut-il garder ?',
  },
  {
    etat: 'SANS_FICHE',
    nom: 'Sans fiche',
    titre: 'Nommés non retrouvés dans la base du personnel',
    aide: 'Le nommé n’a pas été retrouvé dans la base du personnel (nom écrit autrement, ou plusieurs agents possibles). Sans sa fiche, il ne peut être placé.',
    question:
      'Pour chaque ligne : le nom exact, le matricule et la date de naissance de l’agent.',
  },
  {
    etat: 'SANS_STRUCTURE',
    nom: 'Sans structure',
    titre: 'Fonctions départementales sans structure dans l’organigramme',
    aide: 'Coordonnateurs départementaux d’alphabétisation : leur fonction n’a pas de structure dans l’organigramme. Leur fiche n’est pas déplacée.',
    question: 'Pour information.',
  },
  {
    etat: 'A_PLACER',
    nom: 'À placer',
    titre: 'Nominations sûres, pas encore enregistrées',
    aide: 'La structure de la note est retrouvée sans doute possible : elles seront enregistrées par la DGRHAS.',
    question: 'Pour information.',
  },
  {
    etat: 'DEJA_FAIT',
    nom: 'Déjà en place',
    titre: 'Nommés déjà en place dans leur structure',
    aide: 'La fiche et la structure le disent déjà : rien à faire.',
    question: 'Pour information.',
  },
];

const OBSERVATION: Record<string, string> = {
  RECONDUIT: 'Reconduit(e)',
  PROMU: 'Promu(e)',
  MUTE: 'Muté(e)',
  PERMUTE: 'Permuté(e)',
};

export async function excelPlacement(
  r: RapportPlacement,
  departement: string | null,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SIGRHAS-MEPPSA';
  const fin: Partial<ExcelJS.Border> = {
    style: 'thin',
    color: { argb: 'FFBDBDBD' },
  };
  const bords = { top: fin, bottom: fin, left: fin, right: fin };
  const lignes = r.nominations.filter(
    (n) => !departement || n.departement === departement,
  );
  const portee = departement
    ? `Département : ${departement}`
    : 'Tous les départements';
  const edite = `Édité le ${new Date().toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Brazzaville' }).replace(' ', ' à ')}`;

  /** Une feuille avec l'en-tête du ministère ; renvoie la ligne où commence le tableau. */
  const feuille = (
    nom: string,
    largeurs: number[],
    titre: string,
    aide: string,
    question?: string,
  ) => {
    const ws = wb.addWorksheet(nom.slice(0, 31), {
      pageSetup: {
        paperSize: 9,
        orientation: 'landscape',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
      },
      headerFooter: { oddFooter: '&L&7' + GENERE_PAR + '&R&8Page &P sur &N' },
    });
    largeurs.forEach((l, i) => (ws.getColumn(i + 1).width = l));
    const n = largeurs.length;
    const ecrire = (
      l: number,
      c1: number,
      c2: number,
      v: string,
      font: Partial<ExcelJS.Font>,
      horizontal: 'center' | 'left' = 'center',
    ) => {
      if (c2 > c1) ws.mergeCells(l, c1, l, c2);
      const x = ws.getCell(l, c1);
      x.value = v;
      x.font = { name: 'Calibri', ...font };
      x.alignment = { horizontal, vertical: 'middle', wrapText: true };
    };
    const g = { size: 10, bold: true };
    const gauche = Math.min(3, n - 2);
    const d1 = Math.max(gauche + 1, n - 1);
    ecrire(1, 1, gauche, 'MINISTÈRE DE L’ENSEIGNEMENT PRÉSCOLAIRE,', g);
    ecrire(1, d1, n, 'RÉPUBLIQUE DU CONGO', g);
    ecrire(2, 1, gauche, 'PRIMAIRE, SECONDAIRE ET DE L’ALPHABÉTISATION', g);
    ecrire(2, d1, n, 'Unité - Travail - Progrès', g);
    ecrire(3, 1, gauche, '-----------', g);
    ecrire(4, 1, gauche, 'DIRECTION GÉNÉRALE DES RESSOURCES HUMAINES', g);
    ecrire(5, 1, gauche, 'ET DE L’ADMINISTRATION SCOLAIRE', g);
    ecrire(7, 1, n, titre, { size: 13, bold: true, color: { argb: VERT } });
    ecrire(8, 1, n, `Nominations ${r.annee ?? ''} · ${portee} · ${edite}`, {
      size: 10,
      italic: true,
    });
    ecrire(9, 1, n, aide, { size: 10 }, 'left');
    ws.getRow(7).height = 30;
    ws.getRow(9).height = Math.max(30, Math.ceil(aide.length / 160) * 15);
    let l = 10;
    if (question) {
      ecrire(
        10,
        1,
        n,
        `À la DDEPPSA : ${question}`,
        { size: 10, bold: true, color: { argb: 'FF8A6D00' } },
        'left',
      );
      const x = ws.getCell(10, 1);
      x.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: JAUNE } };
      ws.getRow(10).height = 24;
      l = 11;
    }
    return { ws, debut: l + 1 };
  };

  const titres = (
    ws: ExcelJS.Worksheet,
    l: number,
    noms: string[],
    aRemplir: number[] = [],
  ) => {
    const row = ws.getRow(l);
    noms.forEach((t, i) => {
      const x = row.getCell(i + 1);
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
        fgColor: { argb: aRemplir.includes(i) ? 'FFB38F00' : VERT },
      };
      x.alignment = {
        horizontal: 'center',
        vertical: 'middle',
        wrapText: true,
      };
      x.border = bords;
    });
    row.height = 32;
    // (pas de volets figés : le DG ne les veut pas, 25/11/2026)
    ws.autoFilter = {
      from: { row: l, column: 1 },
      to: { row: l, column: noms.length },
    };
  };

  const ligne = (
    ws: ExcelJS.Worksheet,
    l: number,
    valeurs: (string | number | null)[],
    aRemplir: number[] = [],
    fond?: string,
  ) => {
    const row = ws.getRow(l);
    valeurs.forEach((v, i) => {
      const x = row.getCell(i + 1);
      x.value = v ?? '';
      x.border = bords;
      x.font = { name: 'Calibri', size: 10 };
      x.alignment = {
        vertical: 'top',
        wrapText: true,
        horizontal: typeof v === 'number' ? 'right' : 'left',
      };
      const f = aRemplir.includes(i) ? JAUNE : fond;
      if (f)
        x.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: f } };
    });
  };

  // 1. Synthèse : combien de nominations dans chaque situation, par département
  const deps = [...new Set(lignes.map((n) => n.departement ?? '—'))].sort(
    (a, b) => a.localeCompare(b, 'fr'),
  );
  const colonnes = FEUILLES.map((f) => f.nom);
  const s = feuille(
    'Synthèse',
    [26, ...colonnes.map(() => 14), 12],
    'Placement des nommés dans les structures : où en est-on ?',
    'Chaque nomination validée doit prendre effet dans l’organigramme : le chef devient le responsable de sa structure, la fiche de chaque nommé y est rattachée. Ce tableau compte les nominations dans chaque situation ; chaque feuille suivante en donne la liste, avec ce qui fait hésiter.',
  );
  titres(s.ws, s.debut, ['Département', ...colonnes, 'Total']);
  let l = s.debut + 1;
  const compter = (d: string | null) =>
    FEUILLES.map(
      (f) =>
        lignes.filter(
          (n) =>
            n.etat === f.etat && (d === null || (n.departement ?? '—') === d),
        ).length,
    );
  for (const d of deps) {
    const c = compter(d);
    ligne(s.ws, l++, [d, ...c, c.reduce((a, b) => a + b, 0)]);
  }
  const tot = compter(null);
  ligne(s.ws, l, ['Total', ...tot, tot.reduce((a, b) => a + b, 0)], [], GRIS);
  s.ws.getRow(l).font = { name: 'Calibri', size: 10, bold: true };

  // 2. Une feuille par situation (celles qui ont des lignes)
  for (const f of FEUILLES) {
    const liste = lignes
      .filter((n) => n.etat === f.etat)
      .sort(
        (a, b) =>
          (a.departement ?? '').localeCompare(b.departement ?? '', 'fr') ||
          (a.circonscription ?? '').localeCompare(
            b.circonscription ?? '',
            'fr',
          ) ||
          (a.poste ?? '').localeCompare(b.poste ?? '', 'fr') ||
          a.nomComplet.localeCompare(b.nomComplet, 'fr'),
      );
    if (!liste.length) continue;
    const pourDecider = !['A_PLACER', 'DEJA_FAIT', 'SANS_STRUCTURE'].includes(
      f.etat,
    );
    const cols: {
      titre: string;
      largeur: number;
      v: (n: NominationPlacee) => string | number | null;
    }[] = [
      { titre: 'N°', largeur: 6, v: () => null },
      { titre: 'Département', largeur: 16, v: (n) => n.departement },
      { titre: 'Nommé(e)', largeur: 30, v: (n) => n.nomComplet },
      { titre: 'Fonction', largeur: 30, v: (n) => n.fonction },
      {
        titre: 'Observation',
        largeur: 13,
        v: (n) => OBSERVATION[n.observation] ?? n.observation,
      },
      { titre: 'Poste écrit dans la note', largeur: 30, v: (n) => n.poste },
      { titre: 'Circonscription', largeur: 26, v: (n) => n.circonscription },
      {
        titre:
          f.etat === 'INTROUVABLE'
            ? 'Inspection proposée pour ajouter l’école'
            : 'Structure proposée (organigramme)',
        largeur: 32,
        v: (n) => (f.etat === 'INTROUVABLE' ? n.inspectionAjout : n.structure),
      },
      ...(f.etat === 'A_CONFIRMER'
        ? [
            {
              titre: 'Ressemblance des noms',
              largeur: 12,
              v: (n: NominationPlacee) =>
                n.ressemblance === null ? null : `${n.ressemblance} %`,
            },
          ]
        : []),
      {
        titre: pourDecider ? 'Le doute' : 'Remarque',
        largeur: 44,
        v: (n) => n.pourquoi,
      },
      { titre: 'Fiche aujourd’hui', largeur: 26, v: (n) => n.ficheStructure },
      ...(f.etat !== 'SANS_FICHE'
        ? [
            {
              titre: 'Responsable actuel remplacé',
              largeur: 24,
              v: (n: NominationPlacee) => (n.chef ? n.remplace : null),
            },
          ]
        : []),
      ...(pourDecider
        ? [{ titre: 'Décision de la DDEPPSA', largeur: 36, v: () => null }]
        : []),
    ];
    const aRemplir = pourDecider ? [cols.length - 1] : [];
    const x = feuille(
      f.nom,
      cols.map((c) => c.largeur),
      f.titre,
      f.aide,
      pourDecider ? f.question : undefined,
    );
    titres(
      x.ws,
      x.debut,
      cols.map((c) => c.titre),
      aRemplir,
    );
    liste.forEach((n, i) => {
      const v = cols.map((c) => c.v(n));
      v[0] = i + 1;
      ligne(x.ws, x.debut + 1 + i, v, aRemplir);
    });
    const finL = x.debut + liste.length + 2;
    x.ws.mergeCells(finL, 1, finL, cols.length);
    const c = x.ws.getCell(finL, 1);
    c.value = `${liste.length} nomination(s). ${GENERE_PAR}`;
    c.font = {
      name: 'Calibri',
      size: 8,
      italic: true,
      color: { argb: 'FF71717A' },
    };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
