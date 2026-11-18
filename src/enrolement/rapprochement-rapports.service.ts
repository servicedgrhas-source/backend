import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import ExcelJS from 'exceljs';
import { DataSource } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { lireDate, normaliser } from '../common/texte';
import { JournalService } from '../core/core.service';
import { LigneRapportPersonnel, RapportPersonnel } from '../entities';
import { RecensementService } from '../recensement/recensement.service';
import { PropositionsBmService } from './propositions-bm.service';
import { cleEcole, paires, ressemblance } from './effectifs-ecoles-regles';
import {
  codeMatricule,
  colonneDe,
  type ColonneRapport,
  compareNoms,
  motsDuNom,
  naissanceDe,
  partieDe,
  statutDe,
  vide,
} from './rapprochement-rapports-regles';

/*
 * Rapprochement des rapports de fin d'année des DDEPPSA (Banque mondiale, 17/11/2026).
 *
 * Les bases du système datent de l'enrôlement biométrique (2022-2023) ; les rapports annuels des
 * DDEPPSA donnent l'état nominatif récent du personnel. On importe ces états (fichier Excel de la
 * DDEPPSA, ou tiré des photos du rapport), et chaque personne est cherchée dans TOUTE la base du
 * personnel et tout le registre des volontaires et des communautaires :
 * 1. par le matricule de solde (si le nom ou l'année de naissance concordent : sinon, le matricule
 *    du rapport est celui d'une autre personne, et c'est signalé) ;
 * 2. par le nom (tous les mots, dans n'importe quel ordre, à une faute près) et l'année ;
 * 3. par un nom proche (fautes d'orthographe), même année de naissance : « probable ».
 * Les écarts avec la fiche trouvée sont listés ; une décision prise à l'écran (c'est bien elle,
 * une autre fiche, absente) est gardée quand on recalcule.
 *
 * Volet Banque mondiale : ce travail LIT nos bases et n'y écrit JAMAIS (DG, 17/11/2026). Les
 * corrections (« Corriger la liste ») et les personnes gardées hors de nos bases (« Garder dans la
 * liste ») restent sur les lignes du rapport ; l'export Excel les reprend.
 */

/** Une fiche de la base (personnel ou registre), ce qu'il faut pour rapprocher et afficher. */
interface Fiche {
  cle: string;
  type: 'PERSONNEL' | 'REGISTRE';
  id: number | string;
  nom: string;
  mots: string[];
  annee: number | null;
  dateNaissance: string | null;
  matricule: string | null;
  code: string;
  chiffres: string;
  statut: string;
  /** Registre : EN_POSTE ou SORTI. */
  etat: string | null;
  departementId: number | null;
  departement: string | null;
  lieu: string | null;
  priseService: string | null;
  /** Les paires de lettres du nom (tri rapide avant la comparaison fine). */
  lettres: Set<string>;
}

/** Les paires de lettres d'un nom (« MBAMA » → MB, BA, AM, MA). */
function pairesDe(mots: string[]) {
  const s = new Set<string>();
  for (const m of mots)
    for (let i = 0; i < m.length - 1; i++) s.add(m.slice(i, i + 2));
  return s;
}

/** Part des paires de lettres communes à deux noms (0 à 1). */
function communes(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return (2 * n) / (a.size + b.size);
}

const STATUTS: Record<string, string> = {
  FONCTIONNAIRE: 'fonctionnaire',
  CONTRACTUEL: 'contractuel',
  VOLONTAIRE: 'volontaire',
  COMMUNAUTAIRE: 'communautaire',
};

export const RESULTATS: Record<string, string> = {
  TROUVE: 'Trouvé',
  ECARTS: 'Trouvé, à vérifier',
  PROBABLE: 'Probable',
  ABSENT: 'Absent de la base',
};

export const DECISIONS: Record<string, string> = {
  CONFIRME: 'Confirmé',
  AUTRE_FICHE: 'Autre fiche choisie',
  ABSENT: 'Absent confirmé',
  AJOUTE: 'Gardé dans la liste Banque mondiale',
};

/** Les rubriques que l'on peut corriger dans la liste Banque mondiale. */
export const RUBRIQUES_APPLICABLES = [
  'NOMS_PRENOMS',
  'MATRICULE_SOLDE',
  'LIEU_SERVICE',
  'DATE_NAISSANCE',
  'DATE_PRISE_SERVICE',
  'DEPARTEMENT',
] as const;

/**
 * Les rubriques qu'on peut proposer à la base du personnel (17/11/2026) : le rapport récent y est
 * fiable. Jamais le nom ; la date de naissance seulement quand la fiche n'en a pas (DG, 18/11).
 */
export const RUBRIQUES_PROPOSABLES = [
  'LIEU_SERVICE',
  'DATE_PRISE_SERVICE',
  'DEPARTEMENT',
  'MATRICULE_SOLDE',
] as const;

/** Les écarts que règle la correction d'une rubrique (début du message). */
const ECARTS_DE: Record<string, string[]> = {
  NOMS_PRENOMS: ['Nom écrit autrement'],
  DATE_NAISSANCE: ['Année de naissance'],
  MATRICULE_SOLDE: ['Matricule :', 'Pas de matricule', 'Le matricule du rapport'],
  LIEU_SERVICE: ['Lieu de service', 'Pas de lieu de service'],
  DEPARTEMENT: ['Département dans la base'],
};

const dateFr = (d: string | null | undefined) =>
  d && /^\d{4}-\d{2}-\d{2}/.test(d)
    ? d.slice(0, 10).split('-').reverse().join('/')
    : (d ?? '');

@Injectable()
export class RapprochementRapportsService {
  constructor(
    private readonly ds: DataSource,
    private readonly journal: JournalService,
    // Seulement pour PROPOSER au contrôle des modifications : jamais d'écriture dans une fiche
    private readonly recensement: RecensementService,
    // Proposer l'ajout d'une personne absente : rien n'est créé avant la validation
    private readonly propositions: PropositionsBmService,
  ) {}

  /** Proposer d'ajouter à la base du personnel une personne absente de nos bases (18/11/2026). */
  async proposerAjout(u: UtilisateurConnecte, ligneId: number, statut?: string) {
    const l = await this.ds.getRepository(LigneRapportPersonnel).findOne({ where: { id: ligneId } });
    if (!l) throw new NotFoundException('Ligne introuvable.');
    const r = await this.propositions.proposerAgents(u, [l], statut);
    if (r.erreurs.length) throw new BadRequestException(r.erreurs[0].message);
    return { ok: true };
  }

  /* ------------------------------ Lecture du fichier ------------------------------ */

  /**
   * Les personnes d'un état nominatif : la ligne de titres (« Noms et prénoms »…), et la ligne en
   * dessous si elle précise (« Acad », « prof », « recr »…) ; les lignes de partie (« A2 - Secteur
   * privé ») donnent le secteur, le cycle, la rubrique des lignes suivantes ; les titres répétés
   * sont sautés.
   */
  async lireFichier(contenu: Buffer) {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(contenu as unknown as ArrayBuffer);
    } catch {
      throw new BadRequestException('Fichier Excel illisible (.xlsx attendu).');
    }
    const texte = (v: ExcelJS.CellValue): string => {
      if (v === null || v === undefined) return '';
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      if (typeof v === 'object') {
        if ('richText' in v) return v.richText.map((r) => r.text).join('');
        if ('result' in v) return texte(v.result as ExcelJS.CellValue);
        if ('text' in v) return String(v.text);
        return '';
      }
      return String(v);
    };
    const lignes: {
      valeurs: Partial<Record<ColonneRapport, string>>;
      brut: Record<string, string>;
      secteur: string | null;
      cycle: string | null;
      rubrique: string | null;
    }[] = [];
    for (const ws of wb.worksheets) {
      const rangs: string[][] = [];
      ws.eachRow({ includeEmpty: true }, (row, n) => {
        const r: string[] = [];
        for (let c = 1; c <= ws.columnCount; c++)
          r[c - 1] = texte(row.getCell(c).value).replace(/\s+/g, ' ').trim();
        rangs[n - 1] = r;
      });
      let colonnes: (ColonneRapport | null)[] | null = null;
      let titres: string[] = [];
      let partie = { secteur: null, cycle: null, rubrique: null } as ReturnType<
        typeof partieDe
      >;
      for (let i = 0; i < rangs.length; i++) {
        const r = rangs[i] ?? [];
        const pleines = r.filter((x) => x);
        if (!pleines.length) continue;
        const cols = r.map(colonneDe);
        // Une ligne de titres : « Noms et prénoms » et au moins deux autres colonnes reconnues
        if (cols.includes('nom') && cols.filter(Boolean).length >= 3) {
          colonnes = cols;
          titres = [...r];
          // La ligne de dessous précise les colonnes groupées (Diplômes : Acad / prof…)
          const sous = rangs[i + 1] ?? [];
          const sousCols = sous.map(colonneDe);
          if (sousCols.filter(Boolean).length >= 2 && !sousCols.includes('nom')) {
            sous.forEach((t, k) => {
              if (sousCols[k]) {
                colonnes![k] = sousCols[k];
                titres[k] = t;
              }
            });
            i++;
          }
          continue;
        }
        // Une ligne de partie (une seule case écrite, ou un titre sans tableau)
        if (pleines.length <= 2 && !/^\d+\.?$/.test(pleines[0])) {
          const p = partieDe(pleines.join(' '));
          if (p.secteur || p.cycle || p.rubrique)
            partie = {
              secteur: p.secteur ?? (p.cycle || p.rubrique ? null : partie.secteur),
              cycle: p.cycle ?? partie.cycle,
              rubrique: p.rubrique ?? partie.rubrique,
            };
          if (p.secteur) partie.secteur = p.secteur;
          continue;
        }
        if (!colonnes) continue;
        const valeurs: Partial<Record<ColonneRapport, string>> = {};
        const brut: Record<string, string> = {};
        colonnes.forEach((c, k) => {
          const v = r[k] ?? '';
          if (titres[k] && !vide(v)) brut[titres[k]] = v;
          if (c && !vide(v) && !valeurs[c]) valeurs[c] = v;
        });
        if (!valeurs.nom || !/[A-Za-zÀ-ÿ]{2}/.test(valeurs.nom)) continue;
        // Les lignes du fichier donnent aussi la partie (fichier tiré des photos)
        const p = partieDe(
          `${valeurs.secteur ?? ''} ${valeurs.cycle ?? ''} ${valeurs.rubrique ?? ''}`,
        );
        lignes.push({
          valeurs,
          brut,
          secteur: p.secteur ?? partie.secteur,
          cycle: p.cycle ?? partie.cycle,
          rubrique: p.rubrique ?? partie.rubrique,
        });
      }
    }
    if (!lignes.length)
      throw new BadRequestException(
        'Aucune personne trouvée : le fichier doit avoir une ligne de titres avec « Noms et prénoms » (voir le modèle).',
      );
    return lignes;
  }

  /** Importer un état nominatif, puis le rapprocher de la base. */
  async importer(
    u: UtilisateurConnecte,
    contenu: Buffer,
    nomFichier: string,
    p: { departementId?: number; anneeScolaire?: string },
  ) {
    const lues = await this.lireFichier(contenu);
    const deps = await this.ds.query<{ id: number; nom: string }[]>(
      `SELECT id, nom FROM departement`,
    );
    // La DDEPPSA : choisie à l'import, sinon écrite dans le fichier
    let departementId = p.departementId ?? null;
    if (!departementId) {
      const ecrit = lues.find((l) => l.valeurs.departement)?.valeurs.departement;
      departementId =
        deps.find((d) => normaliser(d.nom) === normaliser(ecrit ?? ''))?.id ??
        null;
    }
    const id = await this.ds.transaction(async (em) => {
      const rapport = await em.getRepository(RapportPersonnel).save(
        em.getRepository(RapportPersonnel).create({
          departementId,
          anneeScolaire: (p.anneeScolaire ?? '').trim().slice(0, 20),
          nomFichier: nomFichier.slice(0, 200),
          lignes: lues.length,
          importePar: u.nom,
        }),
      );
      const repo = em.getRepository(LigneRapportPersonnel);
      await repo.save(
        lues.map((l, i) => {
          const v = l.valeurs;
          const n = naissanceDe(
            v.naissance && /^\d+(\.\d+)?$/.test(v.naissance) && +v.naissance > 3000
              ? lireDate(+v.naissance)
              : v.naissance,
          );
          return repo.create({
            rapportId: rapport.id,
            ordre: i + 1,
            rubrique: l.rubrique,
            cycle: l.cycle,
            secteur: l.secteur,
            numero: v.numero?.replace(/\.$/, '').slice(0, 20) ?? null,
            nomComplet: v.nom!.slice(0, 250),
            nomNormalise: normaliser(v.nom),
            anneeNaissance: n.annee,
            dateNaissance: n.date,
            statut: statutDe(v.statut),
            matricule: v.matricule?.slice(0, 40) ?? null,
            ecole: v.ecole?.slice(0, 250) ?? null,
            fonction: v.fonction?.slice(0, 250) ?? null,
            priseService: v.arrivee?.slice(0, 40) ?? null,
            donnees: l.brut,
          });
        }),
        { chunk: 200 },
      );
      return rapport.id;
    });
    await this.journal.log(u, 'RAPPORT_DDEPPSA_IMPORTE', 'rapport_personnel', id, {
      fichier: nomFichier,
      lignes: lues.length,
      departementId,
    });
    await this.rapprocher(id);
    return { id, lignes: lues.length };
  }

  /* -------------------------------- Rapprochement -------------------------------- */

  /** Toute la base : le personnel (hors fiches rejetées) et le registre. */
  private async base() {
    const personnel = await this.ds.query<
      {
        id: number;
        nomComplet: string;
        dateNaissance: string | null;
        matricule: string | null;
        statut: string;
        departementId: number | null;
        departement: string | null;
        lieu: string | null;
        priseService: string | null;
      }[]
    >(
      `SELECT a.id, a."nomComplet", a."dateNaissance"::text AS "dateNaissance", a.matricule, a.statut,
              a."departementId", d.nom AS departement,
              coalesce(s.nom, a.donnees->>'LIEU_SERVICE') AS lieu,
              a.donnees->>'DATE_PRISE_SERVICE' AS "priseService"
         FROM agent_recense a
         LEFT JOIN departement d ON d.id = a."departementId"
         LEFT JOIN structure s ON s.id = a."structureId"
        WHERE coalesce(a.contentieux->>'etat', 'CONFIRME') <> 'REJETE'`,
    );
    const registre = await this.ds.query<
      {
        id: string;
        nomComplet: string;
        dateNaissance: string | null;
        population: string;
        statut: string;
        departementId: number | null;
        departement: string | null;
        lieu: string | null;
        priseService: string | null;
      }[]
    >(
      `SELECT v.id, v."nomComplet", v."dateNaissance"::text AS "dateNaissance", v.population, v.statut,
              v."departementId", d.nom AS departement, v.etablissement AS lieu,
              v."datePriseService"::text AS "priseService"
         FROM volontaire v LEFT JOIN departement d ON d.id = v."departementId"`,
    );
    const fiches: Fiche[] = [
      ...personnel.map((a) => ({
        cle: `P${a.id}`,
        type: 'PERSONNEL' as const,
        id: a.id,
        nom: a.nomComplet,
        mots: motsDuNom(a.nomComplet),
        annee: a.dateNaissance ? +a.dateNaissance.slice(0, 4) : null,
        dateNaissance: a.dateNaissance,
        matricule: a.matricule,
        code: codeMatricule(a.matricule),
        chiffres: (a.matricule ?? '').replace(/\D/g, ''),
        statut: a.statut,
        etat: null,
        departementId: a.departementId,
        departement: a.departement,
        lieu: a.lieu,
        priseService: a.priseService,
        lettres: new Set<string>(),
      })),
      ...registre.map((v) => ({
        cle: `V${v.id}`,
        type: 'REGISTRE' as const,
        id: v.id,
        nom: v.nomComplet,
        mots: motsDuNom(v.nomComplet),
        annee: v.dateNaissance ? +v.dateNaissance.slice(0, 4) : null,
        dateNaissance: v.dateNaissance,
        matricule: null,
        code: '',
        chiffres: '',
        statut: v.population,
        etat: v.statut,
        departementId: v.departementId,
        departement: v.departement,
        lieu: v.lieu,
        priseService: v.priseService,
        lettres: new Set<string>(),
      })),
    ];
    for (const f of fiches) f.lettres = pairesDe(f.mots);
    // Index : par matricule, par mot du nom, par année de naissance
    const parCode = new Map<string, Fiche[]>();
    const parChiffres = new Map<string, Fiche[]>();
    const parMot = new Map<string, Fiche[]>();
    const parAnnee = new Map<number, Fiche[]>();
    // Le registre sans date de naissance, par DDEPPSA (pour les noms proches)
    const sansDateParDep = new Map<number | null, Fiche[]>();
    const ajouter = <K>(m: Map<K, Fiche[]>, k: K, f: Fiche) => {
      const l = m.get(k);
      if (l) l.push(f);
      else m.set(k, [f]);
    };
    for (const f of fiches) {
      if (f.code) ajouter(parCode, f.code, f);
      if (f.chiffres.length >= 5) ajouter(parChiffres, f.chiffres, f);
      for (const m of new Set(f.mots)) if (m.length >= 3) ajouter(parMot, m, f);
      if (f.annee) ajouter(parAnnee, f.annee, f);
      else if (f.type === 'REGISTRE') ajouter(sansDateParDep, f.departementId, f);
    }
    return { fiches, parCode, parChiffres, parMot, parAnnee, sansDateParDep };
  }

  /**
   * Rapprocher les lignes d'un rapport (toutes, ou seulement celles indiquées) ; les décisions
   * prises sont gardées.
   */
  async rapprocher(rapportId: number, seulement?: number[]) {
    const rapport = await this.ds
      .getRepository(RapportPersonnel)
      .findOne({ where: { id: rapportId } });
    if (!rapport) throw new NotFoundException('Rapport introuvable.');
    const repo = this.ds.getRepository(LigneRapportPersonnel);
    const toutes = await repo.find({ where: { rapportId }, order: { ordre: 'ASC' } });
    const garder = seulement ? new Set(seulement) : null;
    const lignes = garder ? toutes.filter((l) => garder.has(l.id)) : toutes;
    if (!lignes.length) return { lignes: 0 };
    const b = await this.base();
    const parCle = new Map(b.fiches.map((f) => [f.cle, f]));
    for (const l of lignes) Object.assign(l, this.rapprocherLigne(l, rapport, b, parCle));
    await repo.save(lignes, { chunk: 200 });
    if (!garder)
      await this.ds
        .getRepository(RapportPersonnel)
        .update(rapportId, { calculeLe: new Date(), lignes: toutes.length });
    return { lignes: lignes.length };
  }

  private rapprocherLigne(
    l: LigneRapportPersonnel,
    rapport: RapportPersonnel,
    b: Awaited<ReturnType<RapprochementRapportsService['base']>>,
    parCle: Map<string, Fiche>,
  ): Partial<LigneRapportPersonnel> {
    const mots = motsDuNom(l.nomComplet);
    const lettres = pairesDe(mots);
    const anneeOk = (f: Fiche) =>
      !l.anneeNaissance || !f.annee || f.annee === l.anneeNaissance;
    const ecarts: string[] = [];
    let methode: string | null = null;
    let probable = false;
    let choisie: Fiche | null = null;
    let autres: Fiche[] = [];

    // Gardée dans la liste Banque mondiale, sans fiche dans nos bases : rien à chercher
    if (l.decision === 'AJOUTE' && !l.agentId && !l.volontaireId)
      return { resultat: 'ABSENT', methode: 'AJOUT', agentId: null, volontaireId: null, ecarts: [], candidats: [] };

    // Une fiche choisie ou confirmée à l'écran reste la fiche de la ligne
    const fixee =
      l.decision === 'CONFIRME' || l.decision === 'AUTRE_FICHE' || l.decision === 'AJOUTE'
        ? parCle.get(
            l.agentId ? `P${l.agentId}` : l.volontaireId ? `V${l.volontaireId}` : '',
          )
        : undefined;
    if (fixee) {
      choisie = fixee;
      methode = l.methode ?? 'CHOIX';
    } else {
      // 1. Le matricule
      const code = codeMatricule(l.matricule);
      const chiffres = (l.matricule ?? '').replace(/\D/g, '');
      if (code.length >= 5) {
        const parMat = [
          ...(b.parCode.get(code) ?? []),
          ...(chiffres.length >= 5 ? (b.parChiffres.get(chiffres) ?? []) : []),
        ].filter((f, i, t) => t.indexOf(f) === i);
        for (const f of parMat) {
          const n = compareNoms(mots, f.mots);
          if (n.score >= 0.6 || (anneeOk(f) && f.annee && n.score >= 0.4)) {
            choisie = f;
            methode = 'MATRICULE';
            break;
          }
        }
        if (!choisie && parMat.length)
          ecarts.push(
            `Le matricule du rapport (${l.matricule}) est celui d’une autre personne dans la base : « ${parMat[0].nom} »${parMat[0].departement ? `, ${parMat[0].departement}` : ''}.`,
          );
      }
      // 2. Le nom (tous les mots retrouvés) et l'année
      const parNom = new Set<Fiche>();
      for (const m of mots)
        if (m.length >= 3) for (const f of b.parMot.get(m) ?? []) parNom.add(f);
      const tousComplets = [...parNom]
        .filter((f) => communes(lettres, f.lettres) >= 0.4)
        .map((f) => ({ f, n: compareNoms(mots, f.mots) }))
        .filter((x) => x.n.complet);
      const complets = tousComplets
        .filter((x) => anneeOk(x.f))
        .sort(
          (x, y) =>
            Number(!!(y.f.annee && y.f.annee === l.anneeNaissance)) -
              Number(!!(x.f.annee && x.f.annee === l.anneeNaissance)) ||
            Number(y.f.departementId === rapport.departementId) -
              Number(x.f.departementId === rapport.departementId) ||
            Number(y.f.type === 'PERSONNEL') - Number(x.f.type === 'PERSONNEL') ||
            y.n.score - x.n.score,
        );
      if (!choisie && complets.length) {
        choisie = complets[0].f;
        methode = 'NOM';
      }
      autres = complets.map((x) => x.f).filter((f) => f !== choisie);
      // Le même nom (tous les mots identiques) mais une autre année de naissance : probablement la
      // même personne, année mal écrite d'un côté (17/11/2026 : sinon « Ajouter » crée un doublon)
      if (!choisie) {
        const memeNom = tousComplets
          .filter((x) => !anneeOk(x.f) && x.n.score === 1)
          .sort(
            (x, y) =>
              Number(y.f.departementId === rapport.departementId) -
                Number(x.f.departementId === rapport.departementId) ||
              Number(y.f.type === 'PERSONNEL') - Number(x.f.type === 'PERSONNEL'),
          );
        if (memeNom.length) {
          choisie = memeNom[0].f;
          methode = 'NOM_AUTRE_ANNEE';
          probable = true;
          autres = memeNom.slice(1, 4).map((x) => x.f);
        }
      }
      // 3. Un nom proche (fautes), même année de naissance
      if (!choisie) {
        const memeAnnee = l.anneeNaissance
          ? (b.parAnnee.get(l.anneeNaissance) ?? [])
          : [];
        // Le registre n'a souvent pas la date de naissance : ses fiches de la même DDEPPSA aussi
        const sansDate = b.sansDateParDep.get(rapport.departementId) ?? [];
        const proches = [...memeAnnee, ...sansDate]
          .filter((f) => communes(lettres, f.lettres) >= 0.5)
          .map((f) => ({ f, n: compareNoms(mots, f.mots) }))
          .filter((x) => x.n.score >= 0.8)
          .sort((x, y) => y.n.score - x.n.score);
        if (proches.length) {
          choisie = proches[0].f;
          methode = 'NOM_PROCHE';
          probable = true;
          autres = proches.slice(1, 4).map((x) => x.f);
        }
      }
    }

    // La fiche du personnel passe avant celle du registre ; le registre est rappelé à côté
    if (choisie?.type === 'REGISTRE') {
      const perso = autres.find((f) => f.type === 'PERSONNEL');
      if (perso && !fixee) {
        autres = [choisie, ...autres.filter((f) => f !== perso)];
        choisie = perso;
      }
    }
    const candidats = autres.slice(0, 4).map((f) => ({
      ...(f.type === 'PERSONNEL'
        ? { agentId: f.id as number }
        : { volontaireId: f.id as string }),
      nom: f.nom,
      detail: [
        f.type === 'REGISTRE' ? `registre (${STATUTS[f.statut] ?? f.statut}${f.etat === 'SORTI' ? ', sorti' : ''})` : STATUTS[f.statut] ?? f.statut,
        f.annee ? `né(e) en ${f.annee}` : null,
        f.departement,
        f.matricule ? `matricule ${f.matricule}` : null,
      ]
        .filter(Boolean)
        .join(' · '),
    }));

    if (!choisie)
      return {
        resultat: 'ABSENT',
        methode: null,
        agentId: null,
        volontaireId: null,
        ecarts: l.decision === 'ABSENT' ? [] : ecarts,
        candidats,
      };

    // Les écarts entre le rapport et la fiche
    const f = choisie;
    const n = compareNoms(mots, f.mots);
    if (normaliser(f.nom) !== l.nomNormalise && !(n.complet && n.score === 1))
      ecarts.push(`Nom écrit autrement dans la base : « ${f.nom} ».`);
    if (l.anneeNaissance && f.annee && f.annee !== l.anneeNaissance)
      ecarts.push(
        `Année de naissance : ${l.anneeNaissance} dans le rapport, ${f.annee} dans la base.`,
      );
    if (l.matricule && codeMatricule(l.matricule) !== f.code && f.type === 'PERSONNEL')
      ecarts.push(
        f.matricule
          ? `Matricule : ${l.matricule} dans le rapport, ${f.matricule} dans la base.`
          : `Pas de matricule dans la base (rapport : ${l.matricule}).`,
      );
    if (rapport.departementId && f.departementId !== rapport.departementId)
      ecarts.push(`Département dans la base : ${f.departement ?? 'aucun'}.`);
    // Le statut (fonctionnaire et contractuel : « presque pareils », DG 17/11/2026)
    const fc = (s: string | null) =>
      s === 'FONCTIONNAIRE' || s === 'CONTRACTUEL' ? 'FC' : s;
    if (l.statut && fc(l.statut) !== fc(f.statut))
      ecarts.push(
        `Statut : ${STATUTS[l.statut]} dans le rapport, ${STATUTS[f.statut] ?? f.statut.toLowerCase()} dans la base${f.type === 'REGISTRE' ? ' (registre)' : ''}.`,
      );
    if (f.type === 'REGISTRE' && f.etat === 'SORTI')
      ecarts.push('Sorti(e) du registre des volontaires et des communautaires.');
    if (!f.lieu) ecarts.push('Pas de lieu de service dans la base.');
    else if (l.ecole) {
      const a = cleEcole(l.ecole);
      const c = cleEcole(f.lieu);
      // « NDL A » : les initiales de « Notre Dame de Lourdes »
      const initiales = c
        .split(' ')
        .filter((m) => !['DE', 'DU', 'D', 'DES', 'LA', 'LE', 'L', 'ET'].includes(m))
        .map((m) => m[0])
        .join('');
      const sigle = a.split(' ')[0];
      const memeSigle = sigle.length >= 2 && initiales.includes(sigle);
      if (a && c && a !== c && !memeSigle && !c.includes(a) && !a.includes(c) && ressemblance(a, c, paires(a), paires(c)) < 0.6)
        ecarts.push(`Lieu de service : « ${l.ecole} » dans le rapport, « ${f.lieu} » dans la base.`);
    }
    if (autres.filter((x) => x.type === 'PERSONNEL').length && f.type === 'PERSONNEL')
      ecarts.push(
        `${autres.filter((x) => x.type === 'PERSONNEL').length + 1} fiches possibles dans la base du personnel (homonymes ou doublon).`,
      );
    // Une rubrique corrigée dans la liste Banque mondiale : son écart est réglé
    const corrige = l.applique ?? {};
    const regles = Object.entries(ECARTS_DE)
      .filter(([k]) => k in corrige)
      .flatMap(([, debuts]) => debuts);
    ecarts.splice(0, ecarts.length, ...ecarts.filter((e) => !regles.some((d) => e.startsWith(d))));
    return {
      resultat: probable ? 'PROBABLE' : ecarts.length ? 'ECARTS' : 'TROUVE',
      methode,
      agentId: f.type === 'PERSONNEL' ? (f.id as number) : null,
      volontaireId: f.type === 'REGISTRE' ? (f.id as string) : null,
      ecarts,
      candidats,
    };
  }

  /* ---------------------------------- Lecture ---------------------------------- */

  /** Les rapports importés, avec leurs résultats. */
  async liste() {
    return this.ds.query<unknown[]>(
      `SELECT r.id, r."departementId", d.nom AS departement, r."anneeScolaire", r."nomFichier", r.lignes,
              r."importePar", r."importeLe", r."calculeLe",
              count(*) FILTER (WHERE l.resultat = 'TROUVE')::int AS trouves,
              count(*) FILTER (WHERE l.resultat = 'ECARTS')::int AS ecarts,
              count(*) FILTER (WHERE l.resultat = 'PROBABLE')::int AS probables,
              count(*) FILTER (WHERE l.resultat = 'ABSENT')::int AS absents,
              count(*) FILTER (WHERE l.decision IS NOT NULL)::int AS decides
         FROM rapport_personnel r
         LEFT JOIN departement d ON d.id = r."departementId"
         LEFT JOIN ligne_rapport_personnel l ON l."rapportId" = r.id
        GROUP BY r.id, d.nom
        ORDER BY r."importeLe" DESC`,
    );
  }

  /** Un rapport : ses lignes, chacune avec la fiche de la base qui lui correspond. */
  async detail(id: number) {
    const rapport = await this.ds.query<
      (RapportPersonnel & { departement: string | null })[]
    >(
      `SELECT r.*, d.nom AS departement FROM rapport_personnel r
         LEFT JOIN departement d ON d.id = r."departementId" WHERE r.id = $1`,
      [id],
    );
    if (!rapport.length) throw new NotFoundException('Rapport introuvable.');
    const lignes = await this.ds
      .getRepository(LigneRapportPersonnel)
      .find({ where: { rapportId: id }, order: { ordre: 'ASC' } });
    const fiches = await this.fichesDe(lignes);
    const pids = lignes.map((l) => l.propositionId).filter((x): x is number => !!x);
    const propositions = new Map(
      (pids.length
        ? await this.ds.query<{ id: number; etat: string; controlePar: string | null; note: string | null }[]>(
            `SELECT id, etat, "controlePar", note FROM modification_recensement WHERE id = ANY($1)`,
            [pids],
          )
        : []
      ).map((p) => [p.id, p]),
    );
    const ajouts = await this.propositions.enAttente('AGENT', lignes.map((l) => `L${l.id}`));
    const ajoutDe = (id: number) => {
      const p = ajouts.get(`L${id}`);
      return p ? { id: p.id, etat: p.etat, controlePar: p.controlePar, note: p.note } : null;
    };
    return {
      rapport: rapport[0],
      lignes: lignes.map((l) => ({
        ...l,
        propositionAjout: ajoutDe(l.id),
        proposition: l.propositionId ? (propositions.get(l.propositionId) ?? null) : null,
        base: l.agentId
          ? (fiches.get(`P${l.agentId}`) ?? null)
          : l.volontaireId
            ? (fiches.get(`V${l.volontaireId}`) ?? null)
            : null,
      })),
    };
  }

  /** Les fiches de la base citées par des lignes (ce qu'on affiche et exporte). */
  private async fichesDe(lignes: LigneRapportPersonnel[]) {
    const ids = [...new Set(lignes.map((l) => l.agentId).filter((x): x is number => !!x))];
    const vids = [...new Set(lignes.map((l) => l.volontaireId).filter((x): x is string => !!x))];
    const m = new Map<
      string,
      {
        type: 'PERSONNEL' | 'REGISTRE';
        id: number | string;
        nom: string;
        lieu: string | null;
        dateNaissance: string | null;
        matricule: string | null;
        priseService: string | null;
        departement: string | null;
        statut: string;
        etat: string | null;
      }
    >();
    if (ids.length)
      for (const a of await this.ds.query<
        { id: number; nom: string; lieu: string | null; dateNaissance: string | null; matricule: string | null; priseService: string | null; departement: string | null; statut: string }[]
      >(
        `SELECT a.id, a."nomComplet" AS nom, coalesce(s.nom, a.donnees->>'LIEU_SERVICE') AS lieu,
                a."dateNaissance"::text AS "dateNaissance", a.matricule,
                a.donnees->>'DATE_PRISE_SERVICE' AS "priseService", d.nom AS departement, a.statut
           FROM agent_recense a LEFT JOIN departement d ON d.id = a."departementId"
           LEFT JOIN structure s ON s.id = a."structureId" WHERE a.id = ANY($1)`,
        [ids],
      ))
        m.set(`P${a.id}`, { type: 'PERSONNEL', etat: null, ...a });
    if (vids.length)
      for (const v of await this.ds.query<
        { id: string; nom: string; lieu: string | null; dateNaissance: string | null; priseService: string | null; departement: string | null; statut: string; etat: string }[]
      >(
        `SELECT v.id, v."nomComplet" AS nom, v.etablissement AS lieu, v."dateNaissance"::text AS "dateNaissance",
                v."datePriseService"::text AS "priseService", d.nom AS departement, v.population AS statut, v.statut AS etat
           FROM volontaire v LEFT JOIN departement d ON d.id = v."departementId" WHERE v.id = ANY($1::uuid[])`,
        [vids],
      ))
        m.set(`V${v.id}`, { type: 'REGISTRE', matricule: null, ...v });
    return m;
  }

  /* --------------------------------- Décisions --------------------------------- */

  /**
   * Décider pour une ligne : CONFIRME (la fiche trouvée est la bonne), AUTRE_FICHE (une autre
   * fiche, choisie à la main), ABSENT (la personne n'est pas dans la base), ou null (annuler).
   */
  async decider(
    u: UtilisateurConnecte,
    ligneId: number,
    d: { decision: string | null; agentId?: number; volontaireId?: string },
  ) {
    const repo = this.ds.getRepository(LigneRapportPersonnel);
    const l = await repo.findOne({ where: { id: ligneId } });
    if (!l) throw new NotFoundException('Ligne introuvable.');
    if (d.decision && !(d.decision in DECISIONS))
      throw new BadRequestException('Décision inconnue.');
    if (d.decision === 'CONFIRME' && !l.agentId && !l.volontaireId)
      throw new BadRequestException('Aucune fiche à confirmer : choisissez une fiche.');
    if (d.decision === 'AUTRE_FICHE') {
      if (!d.agentId && !d.volontaireId)
        throw new BadRequestException('Choisissez la fiche.');
      l.agentId = d.agentId ?? null;
      l.volontaireId = d.agentId ? null : (d.volontaireId ?? null);
      l.methode = 'CHOIX';
    }
    if (d.decision === 'ABSENT') {
      l.agentId = null;
      l.volontaireId = null;
    }
    l.decision = d.decision ?? null;
    l.decidePar = d.decision ? u.nom : null;
    l.decideLe = d.decision ? new Date() : null;
    await repo.save(l);
    // Les écarts sont refaits avec la fiche retenue
    const rapport = await this.ds
      .getRepository(RapportPersonnel)
      .findOneOrFail({ where: { id: l.rapportId } });
    const b = await this.base();
    const parCle = new Map(b.fiches.map((f) => [f.cle, f]));
    Object.assign(l, this.rapprocherLigne(l, rapport, b, parCle));
    if (l.decision === 'ABSENT') l.resultat = 'ABSENT';
    await repo.save(l);
    await this.journal.log(u, 'RAPPORT_DDEPPSA_DECISION', 'ligne_rapport_personnel', l.id, {
      rapportId: l.rapportId,
      decision: l.decision,
      agentId: l.agentId,
      volontaireId: l.volontaireId,
    });
    return { ok: true };
  }

  /**
   * Corriger la liste Banque mondiale (17/11/2026) : les rubriques choisies (nom, matricule, lieu de
   * service, dates, département) sont gardées sur la ligne, avec la valeur de nos bases à côté.
   * Nos bases (fiches du personnel, registre) ne sont JAMAIS modifiées : seul l'export en tient compte.
   */
  async appliquer(
    u: UtilisateurConnecte,
    ligneId: number,
    champs: Record<string, unknown>,
  ) {
    const repo = this.ds.getRepository(LigneRapportPersonnel);
    const l = await repo.findOne({ where: { id: ligneId } });
    if (!l) throw new NotFoundException('Ligne introuvable.');
    const donnees: Record<string, string> = {};
    for (const k of RUBRIQUES_APPLICABLES) {
      const v = champs?.[k];
      if (v === undefined || v === null || String(v).trim() === '') continue;
      donnees[k] = String(v).replace(/\s+/g, ' ').trim().slice(0, 250);
    }
    for (const k of ['DATE_NAISSANCE', 'DATE_PRISE_SERVICE'])
      if (donnees[k] !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(donnees[k]))
        throw new BadRequestException('Date mal écrite : choisissez-la dans le calendrier.');
    // Le département : choisi par son numéro, gardé par son nom (ce qu'on exporte)
    if (donnees.DEPARTEMENT !== undefined) {
      const [d] = await this.ds.query<{ nom: string }[]>(
        `SELECT nom FROM departement WHERE id = $1`,
        [Number(donnees.DEPARTEMENT)],
      );
      if (!d) throw new BadRequestException('Département inconnu.');
      donnees.DEPARTEMENT = d.nom;
    }
    if (!Object.keys(donnees).length)
      throw new BadRequestException('Cochez au moins une rubrique à corriger.');
    // La valeur de nos bases, pour mémoire (lue, jamais écrite)
    const fiche = (await this.fichesDe([l])).get(
      l.agentId ? `P${l.agentId}` : l.volontaireId ? `V${l.volontaireId}` : '',
    );
    const dansLaBase: Record<string, string | null | undefined> = {
      NOMS_PRENOMS: fiche?.nom,
      MATRICULE_SOLDE: fiche?.matricule,
      LIEU_SERVICE: fiche?.lieu,
      DATE_NAISSANCE: fiche?.dateNaissance,
      DATE_PRISE_SERVICE: fiche?.priseService,
      DEPARTEMENT: fiche?.departement,
    };
    l.applique = {
      ...(l.applique ?? {}),
      ...Object.fromEntries(
        Object.entries(donnees).map(([k, v]) => [k, { avant: dansLaBase[k] ?? null, apres: v }]),
      ),
    };
    l.appliquePar = u.nom;
    l.appliqueLe = new Date();
    // Corriger, c'est reconnaître la personne
    if (!l.decision && (l.agentId || l.volontaireId)) {
      l.decision = 'CONFIRME';
      l.decidePar = u.nom;
      l.decideLe = new Date();
    }
    await repo.save(l);
    await this.journal.log(u, 'RAPPORT_DDEPPSA_CORRIGE', 'ligne_rapport_personnel', l.id, {
      rapportId: l.rapportId,
      rubriques: Object.keys(donnees),
    });
    // Les écarts réglés par la correction disparaissent
    const rapport = await this.ds
      .getRepository(RapportPersonnel)
      .findOneOrFail({ where: { id: l.rapportId } });
    const b = await this.base();
    Object.assign(l, this.rapprocherLigne(l, rapport, b, new Map(b.fiches.map((x) => [x.cle, x]))));
    await repo.save(l);
    return { ok: true, rubriques: Object.keys(donnees) };
  }

  /**
   * Proposer à la base du personnel les corrections d'une ligne (17/11/2026) : lieu de service, date
   * de prise de service, département, matricule. La fiche ne change PAS : la proposition part au
   * contrôle des modifications, avec sa source ; la base n'est modifiée que si le contrôle valide.
   */
  async proposer(u: UtilisateurConnecte, ligneId: number) {
    const repo = this.ds.getRepository(LigneRapportPersonnel);
    const l = await repo.findOne({ where: { id: ligneId } });
    if (!l) throw new NotFoundException('Ligne introuvable.');
    const r = await this.proposerLignes(u, await this.rapportAvecDep(l.rapportId), [l]);
    if (r.erreurs.length) throw new BadRequestException(r.erreurs[0].message);
    return { ok: true };
  }

  private async rapportAvecDep(id: number) {
    const [r] = await this.ds.query<(RapportPersonnel & { departement: string | null })[]>(
      `SELECT r.*, d.nom AS departement FROM rapport_personnel r
         LEFT JOIN departement d ON d.id = r."departementId" WHERE r.id = $1`,
      [id],
    );
    if (!r) throw new NotFoundException('Rapport introuvable.');
    return r;
  }

  private async proposerLignes(
    u: UtilisateurConnecte,
    rapport: RapportPersonnel & { departement: string | null },
    lignes: LigneRapportPersonnel[],
  ) {
    const repo = this.ds.getRepository(LigneRapportPersonnel);
    const erreurs: { ligneId: number; nom: string; message: string }[] = [];
    let faits = 0;
    const deps = new Map(
      (await this.ds.query<{ nom: string; code: string }[]>(`SELECT nom, code FROM departement`)).map(
        (d) => [d.nom, d.code],
      ),
    );
    const enCours = new Set(
      (
        await this.ds.query<{ id: number }[]>(
          `SELECT id FROM modification_recensement WHERE id = ANY($1) AND etat = 'A_CONTROLER'`,
          [lignes.map((l) => l.propositionId).filter((x): x is number => !!x)],
        )
      ).map((x) => x.id),
    );
    // La date de naissance : proposée seulement si la fiche n'en a pas (DG, 18/11/2026)
    const sansNaissance = new Set(
      (
        await this.ds.query<{ id: number }[]>(
          `SELECT id FROM agent_recense WHERE id = ANY($1)
              AND "dateNaissance" IS NULL AND coalesce(donnees->>'DATE_NAISSANCE', '') = ''`,
          [lignes.map((l) => l.agentId).filter((x): x is number => !!x)],
        )
      ).map((x) => x.id),
    );
    for (const l of lignes) {
      const erreur = (message: string) => erreurs.push({ ligneId: l.id, nom: l.nomComplet, message });
      if (!l.agentId) {
        erreur('Pas de fiche dans la base du personnel.');
        continue;
      }
      if (l.propositionId && enCours.has(l.propositionId)) {
        erreur('Déjà proposée : en attente du contrôle des modifications.');
        continue;
      }
      const donnees: Record<string, string> = {};
      for (const k of RUBRIQUES_PROPOSABLES) {
        const v = l.applique?.[k]?.apres;
        if (v === undefined || v === null || v === '') continue;
        donnees[k] = k === 'DEPARTEMENT' ? (deps.get(String(v)) ?? '') : String(v);
      }
      const naissance = l.applique?.DATE_NAISSANCE?.apres;
      if (naissance && sansNaissance.has(l.agentId)) donnees.DATE_NAISSANCE = String(naissance);
      if (!Object.keys(donnees).length) {
        erreur('Rien à proposer : corrigez d’abord la liste (lieu de service, prise de service, département, matricule, ou date de naissance si la fiche n’en a pas).');
        continue;
      }
      const source = `Rapport de fin d’année ${rapport.anneeScolaire || ''} de la DDEPPSA ${rapport.departement ?? ''} (fichier « ${rapport.nomFichier} », n° ${l.numero ?? l.ordre})`
        .replace(/\s+/g, ' ')
        .trim();
      try {
        const p = await this.recensement.proposer(u, l.agentId, donnees, source);
        await repo.update(l.id, { propositionId: p.id });
        faits++;
      } catch (e) {
        erreur((e as Error).message);
      }
    }
    return { faits, erreurs };
  }

  /** Garder dans la liste Banque mondiale une personne absente de nos bases (statut du rapport, ou choisi). */
  async ajouter(u: UtilisateurConnecte, ligneId: number, statutChoisi?: string) {
    const repo = this.ds.getRepository(LigneRapportPersonnel);
    const l = await repo.findOne({ where: { id: ligneId } });
    if (!l) throw new NotFoundException('Ligne introuvable.');
    const r = await this.garderLignes(u, [l], statutChoisi);
    if (r.erreurs.length) throw new BadRequestException(r.erreurs[0].message);
    return { ok: true };
  }

  /**
   * Garder des personnes dans la liste Banque mondiale : la ligne est marquée « gardée » (avec son
   * statut) ; AUCUNE fiche n'est créée dans nos bases. Elle figure dans l'export.
   */
  private async garderLignes(
    u: UtilisateurConnecte,
    lignes: LigneRapportPersonnel[],
    statutChoisi?: string,
  ) {
    const repo = this.ds.getRepository(LigneRapportPersonnel);
    const erreurs: { ligneId: number; nom: string; message: string }[] = [];
    let faits = 0;
    if (statutChoisi && !(statutChoisi in STATUTS))
      throw new BadRequestException('Statut inconnu.');
    for (const l of lignes) {
      if (l.agentId || l.volontaireId) {
        erreurs.push({ ligneId: l.id, nom: l.nomComplet, message: 'A déjà une fiche dans nos bases : confirmez-la plutôt.' });
        continue;
      }
      if (l.decision === 'AJOUTE') continue;
      await repo.update(l.id, {
        statut: statutChoisi ?? l.statut,
        methode: 'AJOUT',
        decision: 'AJOUTE',
        decidePar: u.nom,
        decideLe: new Date(),
        resultat: 'ABSENT',
        ecarts: [],
        candidats: [],
      });
      faits++;
      await this.journal.log(u, 'RAPPORT_DDEPPSA_GARDE', 'ligne_rapport_personnel', l.id, {
        rapportId: l.rapportId,
      });
    }
    return { faits, erreurs };
  }

  /**
   * Agir sur plusieurs lignes d'un coup (cochées à l'écran) :
   * - CONFIRMER : la fiche trouvée est la bonne ;
   * - AJOUTER : garder dans la liste Banque mondiale les personnes absentes de nos bases ;
   * - PROPOSER : proposer les corrections au contrôle des modifications (la fiche ne change pas) ;
   * - ABSENT : déclarer absentes.
   * La base n'est lue qu'une fois ; le rapport est rapproché à la fin.
   */
  async lot(
    u: UtilisateurConnecte,
    rapportId: number,
    action: string,
    ids: number[],
  ) {
    if (!['CONFIRMER', 'AJOUTER', 'ABSENT', 'ANNULER', 'PROPOSER', 'PROPOSER_AJOUT'].includes(action))
      throw new BadRequestException('Action inconnue.');
    const uniques = [...new Set(ids.filter((x) => Number.isInteger(x)))];
    if (!uniques.length) throw new BadRequestException('Cochez au moins une personne.');
    const repo = this.ds.getRepository(LigneRapportPersonnel);
    const lignes = (await repo.find({ where: { rapportId } })).filter((l) =>
      uniques.includes(l.id),
    );
    let faits = 0;
    const erreurs: { ligneId: number; nom: string; message: string }[] = [];
    const maintenant = new Date();
    if (action === 'CONFIRMER') {
      const a = lignes.filter((l) => (l.agentId || l.volontaireId) && !l.decision);
      if (a.length)
        await repo.update(
          a.map((l) => l.id),
          { decision: 'CONFIRME', decidePar: u.nom, decideLe: maintenant },
        );
      faits = a.length;
    } else if (action === 'ANNULER') {
      // La ligne revient « à traiter » (une fiche créée avant le volet Banque mondiale reste)
      const a = lignes.filter((l) => l.decision && !(l.decision === 'AJOUTE' && l.agentId));
      if (a.length)
        await repo.update(
          a.map((l) => l.id),
          { decision: null, decidePar: null, decideLe: null },
        );
      faits = a.length;
    } else if (action === 'ABSENT') {
      const a = lignes.filter((l) => !(l.decision === 'AJOUTE' && l.agentId));
      if (a.length)
        await repo.update(
          a.map((l) => l.id),
          { decision: 'ABSENT', decidePar: u.nom, decideLe: maintenant, agentId: null, volontaireId: null, resultat: 'ABSENT', methode: null, ecarts: [] },
        );
      faits = a.length;
    } else if (action === 'PROPOSER_AJOUT') {
      const r = await this.propositions.proposerAgents(u, lignes);
      faits = r.faits;
      erreurs.push(...r.erreurs);
    } else if (action === 'PROPOSER') {
      const r = await this.proposerLignes(u, await this.rapportAvecDep(rapportId), lignes);
      faits = r.faits;
      erreurs.push(...r.erreurs);
    } else {
      const r = await this.garderLignes(u, lignes);
      faits = r.faits;
      erreurs.push(...r.erreurs);
    }
    await this.journal.log(u, 'RAPPORT_DDEPPSA_LOT', 'rapport_personnel', rapportId, {
      action,
      lignes: uniques.length,
      faits,
      erreurs: erreurs.length,
    });
    // Confirmer ou déclarer absent ne change pas la recherche : seules les fiches touchées sont refaites
    if (action === 'ANNULER')
      await this.rapprocher(rapportId, uniques);
    return { faits, erreurs };
  }

  async supprimer(u: UtilisateurConnecte, id: number) {
    const r = await this.ds.getRepository(RapportPersonnel).findOne({ where: { id } });
    if (!r) throw new NotFoundException('Rapport introuvable.');
    await this.ds.transaction(async (em) => {
      await em.getRepository(LigneRapportPersonnel).delete({ rapportId: id });
      await em.getRepository(RapportPersonnel).delete(id);
    });
    await this.journal.log(u, 'RAPPORT_DDEPPSA_SUPPRIME', 'rapport_personnel', id, {
      fichier: r.nomFichier,
    });
    return { ok: true };
  }

  /* ----------------------------------- Excel ----------------------------------- */

  /**
   * L'export demandé (DG, 17/11/2026) : une ligne par personne, une seule valeur par colonne — nom,
   * lieu de service, date de naissance, matricule, date de prise de service, département, statut.
   * La valeur retenue : la correction faite dans la liste Banque mondiale, sinon celle de nos bases
   * quand la personne y a une fiche, sinon celle du rapport. La même personne sur plusieurs listes du
   * rapport (directeur et enseignant) n'a qu'une ligne.
   */
  async excel(id: number) {
    const { rapport, lignes } = await this.detail(id);
    const SECTEURS: Record<string, string> = {
      PUBLIC: 'Public',
      CONVENTIONNE: 'Conventionné',
      PRIVE: 'Privé',
    };
    const STATUT_TITRE: Record<string, string> = {
      FONCTIONNAIRE: 'Fonctionnaire',
      CONTRACTUEL: 'Contractuel',
      VOLONTAIRE: 'Volontaire',
      COMMUNAUTAIRE: 'Communautaire',
    };
    const ou = (...v: (string | number | null | undefined)[]) =>
      v.find((x) => x !== null && x !== undefined && String(x).trim() !== '') ?? '';
    // Une personne = une fiche (personnel ou registre) ; sans fiche : son nom et son année
    const vues = new Set<string>();
    const personnes = lignes.filter((l) => {
      const k = l.agentId
        ? `P${l.agentId}`
        : l.volontaireId
          ? `V${l.volontaireId}`
          : `R${l.nomNormalise}|${l.anneeNaissance ?? ''}`;
      if (vues.has(k)) return false;
      vues.add(k);
      return true;
    });
    const wb = new ExcelJS.Workbook();
    wb.creator = 'SIGRHAS-MEPPSA';
    const ws = wb.addWorksheet('Personnel', {
      views: [{ state: 'frozen', xSplit: 2, ySplit: 3 }],
    });
    const VERT = 'FF00692F';
    const bord = { style: 'thin' as const, color: { argb: 'FFD4D4D8' } };
    const cadre = { top: bord, left: bord, bottom: bord, right: bord };
    const cols: [string, number][] = [
      ['N°', 6],
      ['Noms et prénoms', 34],
      ['Lieu de service', 32],
      ['Date de naissance', 13],
      ['Matricule', 12],
      ['Date de prise de service', 14],
      ['Département', 14],
      ['Statut', 15],
      ['Secteur', 13],
    ];
    ws.columns = cols.map(([, w]) => ({ width: w }));
    ws.mergeCells(1, 1, 1, cols.length);
    const t = ws.getCell(1, 1);
    t.value = `Personnel — DDEPPSA ${rapport.departement ?? '?'} — rapport ${rapport.anneeScolaire || ''}`;
    t.font = { size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
    t.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: VERT } };
    t.alignment = { vertical: 'middle', indent: 1 };
    ws.getRow(1).height = 26;
    ws.mergeCells(2, 1, 2, cols.length);
    ws.getCell(2, 1).value = `${personnes.length} personne(s), situation au ${new Date().toLocaleDateString('fr-FR')}.`;
    ws.getCell(2, 1).font = { size: 10, italic: true, color: { argb: 'FF52525B' } };
    const h = ws.getRow(3);
    cols.forEach(([l], i) => {
      const c = h.getCell(i + 1);
      c.value = l;
      c.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: VERT } };
      c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      c.border = cadre;
    });
    h.height = 30;
    personnes.forEach((l, i) => {
      const f = l.base;
      const c = (k: string) => {
        const v = l.applique?.[k]?.apres;
        return v === undefined || v === null ? null : String(v);
      };
      const row = ws.getRow(4 + i);
      row.values = [
        i + 1,
        ou(c('NOMS_PRENOMS'), f?.nom, l.nomComplet),
        ou(c('LIEU_SERVICE'), f?.lieu, l.ecole),
        ou(dateFr(c('DATE_NAISSANCE')), dateFr(f?.dateNaissance), l.dateNaissance ? dateFr(l.dateNaissance) : l.anneeNaissance),
        ou(c('MATRICULE_SOLDE'), f?.matricule, l.matricule),
        ou(dateFr(c('DATE_PRISE_SERVICE')), dateFr(f?.priseService), l.priseService),
        ou(c('DEPARTEMENT'), f?.departement, rapport.departement),
        ou(f ? STATUT_TITRE[f.statut] : null, l.statut ? STATUT_TITRE[l.statut] : null),
        SECTEURS[l.secteur ?? ''] ?? '',
      ];
      row.eachCell({ includeEmpty: true }, (c, k) => {
        if (k > cols.length) return;
        c.border = cadre;
        c.font = { size: 10, bold: k === 2 };
        c.alignment = { vertical: 'middle', wrapText: true, horizontal: k === 1 ? 'center' : 'left' };
        if (i % 2) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F4F5' } };
      });
    });
    ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3 + personnes.length, column: cols.length } };
    ws.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '3:3' };
    ws.headerFooter = {
      oddFooter:
        '&L&8Document généré par le Système d’Information de gestion des ressources humaines et de l’administration scolaire (SIGRHAS-MEPPSA)&R&8Page &P / &N',
    };
    const nom = `Personnel ${rapport.departement ?? 'DDEPPSA'} ${rapport.anneeScolaire || ''}`.trim();
    return { nom: `${nom}.xlsx`, contenu: Buffer.from(await wb.xlsx.writeBuffer()) };
  }

  /**
   * Le modèle à remplir (17/11/2026) : la feuille « Personnel » (une ligne de titres, une ligne par
   * personne) et la feuille « Consignes » (ce qu'on prend dans le rapport, ce qu'on ne prend pas,
   * comment écrire chaque colonne). Le même modèle sert à recopier les photos des rapports.
   */
  async modele() {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'SIGRHAS-MEPPSA';
    const VERT = 'FF00692F';
    const OR = 'FFFDF6D2';
    const bord = { style: 'thin' as const, color: { argb: 'FFD4D4D8' } };
    const cadre = { top: bord, left: bord, bottom: bord, right: bord };
    // [titre, obligatoire, largeur, explication]
    const COLS: [string, boolean, number, string][] = [
      ['Département', false, 14, 'La DDEPPSA du rapport (sinon choisie à l’import).'],
      ['Page', false, 6, 'La page du rapport (pour retrouver la ligne).'],
      ['Secteur', true, 13, 'Public ou Conventionné (le privé n’est pas pris).'],
      ['Cycle', true, 12, 'Préscolaire ou Primaire.'],
      ['Rubrique', true, 13, 'Administratif ou Enseignant.'],
      ['N°', false, 5, 'Le numéro de la ligne dans le rapport.'],
      ['Noms et prénoms', true, 32, 'Comme écrit dans le rapport : NOM en majuscules, puis les prénoms. Ne pas corriger.'],
      ['Genre', false, 7, 'F ou M.'],
      ['Année naiss', true, 9, 'L’année (1987), ou la date complète (06/02/1987) si elle est écrite.'],
      ['Nat', false, 6, 'Comme écrit (C, Cg…).'],
      ['G/E', false, 9, 'Grade et échelon, comme écrits (IA 1er, IP 10e…).'],
      ['Stat', true, 9, 'Fonct, Contr, Com (communautaire), Final (finaliste = volontaire).'],
      ['Fonct', false, 18, 'La fonction (Directrice, Gestionnaire, Enseignant…).'],
      ['Ecole', true, 22, 'L’école ou le lieu de service, comme écrit (CEP Indo, NDL A…).'],
      ['Situat matri', false, 9, 'Comme écrit (C2, M…).'],
      ['Code serv', false, 8, 'Comme écrit.'],
      ['Ind', false, 7, 'L’indice, comme écrit.'],
      ['Mle solde', true, 11, 'Le matricule de solde AVEC sa lettre (233792R). Vide si le rapport n’en donne pas.'],
      ['Acad', false, 9, 'Diplôme académique.'],
      ['Prof', false, 9, 'Diplôme professionnel.'],
      ['Recr', false, 8, 'Année ou date de recrutement.'],
      ['Dern. promo', false, 9, 'Année ou date de la dernière promotion.'],
      ['Arrv départ', true, 10, 'Date (ou année) d’arrivée au poste = date de prise de service.'],
    ];
    const ws = wb.addWorksheet('Personnel', {
      views: [{ state: 'frozen', ySplit: 1, xSplit: 7 }],
    });
    ws.columns = COLS.map(([, , w]) => ({ width: w }));
    const h = ws.addRow(COLS.map(([titre]) => titre));
    h.height = 32;
    h.eachCell((c, k) => {
      const [, oblig, , aide] = COLS[k - 1];
      c.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: oblig ? VERT : 'FF71717A' } };
      c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      c.border = cadre;
      c.note = aide;
    });
    const exemples = [
      ['Lékoumou', 17, 'Public', 'Préscolaire', 'Administratif', 1, 'NOMEXEMPLE Prénom', 'F', 1987, 'C', 'IA 1er', 'Fonct', 'Directrice', 'CEP Indo', 'C2', 2370, 464, '000000R', 'CEPE', 'BET', 2020, 2022, 2020],
      ['Lékoumou', 44, 'Conventionné', 'Primaire', 'Enseignant', 1, 'AUTRENOM Prénom Deuxième', 'M', 1968, 'Cg', '', 'Com', 'Enseignant', 'NDL B', 'C6', '', '', '', 'BEMG', '', 2004, '', 2004],
      ['Lékoumou', 44, 'Conventionné', 'Primaire', 'Enseignant', 2, 'TROISIEME Prénom', 'F', 1997, 'C', '', 'Final', 'Enseignante', 'NDL A', 'C2', '', '', '', 'BAC', 'CFEEN', 2024, '', 2024],
    ];
    for (const e of exemples) {
      const r = ws.addRow(e);
      r.eachCell({ includeEmpty: true }, (c, k) => {
        if (k > COLS.length) return;
        c.border = cadre;
        c.font = { size: 10, italic: true, color: { argb: 'FF71717A' } };
      });
    }

    const wc = wb.addWorksheet('Consignes');
    wc.columns = [{ width: 4 }, { width: 120 }];
    let n = 1;
    const titre = (txt: string) => {
      const r = wc.getRow(n++);
      wc.mergeCells(r.number, 1, r.number, 2);
      r.getCell(1).value = txt;
      r.getCell(1).font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
      r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: VERT } };
      r.height = 22;
    };
    const point = (txt: string, fond?: string) => {
      const r = wc.getRow(n++);
      r.getCell(1).value = '•';
      r.getCell(2).value = txt;
      r.getCell(2).alignment = { wrapText: true, vertical: 'top' };
      r.getCell(1).alignment = { horizontal: 'right', vertical: 'top' };
      if (fond)
        for (const k of [1, 2])
          r.getCell(k).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fond } };
    };
    const blanc = () => n++;
    const r0 = wc.getRow(n++);
    wc.mergeCells(r0.number, 1, r0.number, 2);
    r0.getCell(1).value =
      'État nominatif du personnel — recopier un rapport de fin d’année de DDEPPSA (Banque mondiale)';
    r0.getCell(1).font = { bold: true, size: 14 };
    r0.height = 24;
    blanc();
    titre('1. La forme du fichier');
    point('Un fichier par rapport de DDEPPSA. Tout dans la feuille « Personnel ».');
    point('Une seule ligne de titres, tout en haut (ne pas changer les titres), puis UNE LIGNE PAR PERSONNE. Pas de cellules fusionnées, pas de ligne vide au milieu, pas de ligne de total.');
    point('Colonnes en vert : obligatoires (à remplir quand le rapport les donne). Colonnes en gris : utiles, à remplir si le rapport les donne. Survolez un titre pour voir l’explication.');
    point('Secteur, Cycle et Rubrique sont écrits sur CHAQUE ligne. (Une ligne seule avec un titre de partie du rapport, par exemple « A1 - Secteur public », est aussi comprise : elle vaut pour les lignes en dessous.)');
    point('Une case vide dans le rapport (« / », « - », rien) : laissez la case vide.');
    point('Les 3 lignes grises en italique de la feuille « Personnel » sont des exemples : effacez-les.');
    blanc();
    titre('2. Ce qu’on prend dans le rapport');
    point('Les états nominatifs du PERSONNEL : personnel administratif ET personnel enseignant.', 'FFE9F7EF');
    point('Du secteur PUBLIC et du secteur CONVENTIONNÉ.', 'FFE9F7EF');
    point('Du PRÉSCOLAIRE et du PRIMAIRE.', 'FFE9F7EF');
    point('Toutes les catégories : fonctionnaires, contractuels, communautaires, finalistes (= volontaires).', 'FFE9F7EF');
    blanc();
    titre('3. Ce qu’on NE prend PAS');
    point('Le secteur PRIVÉ.', OR);
    point('Les collèges et les lycées (pour l’instant).', OR);
    point('Les tableaux qui ne sont pas des listes de personnes : effectifs d’élèves, classes, salles, tables-bancs, manuels, résultats d’examens, statistiques, tableaux de synthèse et totaux.', OR);
    point('Les lignes de total ou de sous-total, les titres répétés en haut de page, le pied de page (« Rapport de fin d’année scolaire… », « Page 17 »).', OR);
    point('Les marques ajoutées à la main sur le papier (coches ✓, traits, notes dans la marge).', OR);
    point('Les lignes coupées en haut ou en bas d’une photo : prenez-les sur la photo de la page où elles sont entières.', OR);
    blanc();
    titre('4. Comment écrire');
    point('RECOPIER EXACTEMENT ce qui est écrit, même s’il y a une faute (« TSOKO » et pas « NTSOKO ») : c’est le système qui fait le rapprochement et montre les écarts.');
    point('Ne rien inventer, ne rien compléter de mémoire : une information absente reste vide.');
    point('Matricule : avec sa lettre, sans espace (233792R). Une lettre illisible : écrivez les chiffres seuls.');
    point('Année de naissance : quatre chiffres (1987). Si la date complète est écrite, recopiez-la (06/02/1987).');
    point('Statut : Fonct, Contr, Com ou Final, comme dans le rapport.');
    point('École : comme écrite, abréviations comprises (CEP Indo, NDL A, Isaac BALENDE).');
    point('Un mot illisible : laissez la case vide plutôt que deviner, et notez le numéro de la ligne pour vérification.');
    blanc();
    titre('5. Les photos du rapport (si on n’a pas le fichier Word)');
    point('Une photo par page, la page entière, bien droite, à plat, à la lumière du jour, sans reflet ni ombre : tout le tableau doit être lisible (nom, matricule, dates).');
    point('Le mieux reste le fichier Word du rapport : demandez-le à la DDEPPSA (partie « personnel » seulement).');
    blanc();
    titre('6. Ensuite');
    point('Dans le système : Volontaires et communautaires › Suivi et réglages › Rapprochement des rapports des DDEPPSA › « Importer un état nominatif ».');
    point('Le système cherche chaque personne dans toute la base du personnel et le registre, montre les écarts, permet de confirmer, de compléter la fiche, ou d’ajouter la personne avec la mention « Ajouté depuis le rapport de la DDEPPSA ».');
    wc.headerFooter = {
      oddFooter:
        '&L&8Document généré par le Système d’Information de gestion des ressources humaines et de l’administration scolaire (SIGRHAS-MEPPSA)',
    };
    wc.pageSetup = { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  /** Pour l'écran : chercher une autre fiche (personnel et registre) par le nom. */
  async chercherFiche(texte: string) {
    const mots = motsDuNom(texte).filter((m) => m.length >= 2).slice(0, 6);
    if (!mots.length) return [];
    const like = mots.map((_, i) => `"nomNormalise" LIKE $${i + 1}`).join(' AND ');
    const p = mots.map((m) => `%${m}%`);
    const perso = await this.ds.query<{ id: number; nom: string; detail: string }[]>(
      `SELECT a.id, a."nomComplet" AS nom,
              concat_ws(' · ', initcap(lower(a.statut)), 'né(e) le ' || to_char(a."dateNaissance", 'DD/MM/YYYY'), d.nom,
                        CASE WHEN a.matricule IS NOT NULL THEN 'matricule ' || a.matricule END) AS detail
         FROM agent_recense a LEFT JOIN departement d ON d.id = a."departementId"
        WHERE ${like.replace(/"nomNormalise"/g, 'a."nomNormalise"')} ORDER BY a."nomNormalise" LIMIT 10`,
      p,
    );
    const reg = await this.ds.query<{ id: string; nom: string; detail: string }[]>(
      `SELECT v.id, v."nomComplet" AS nom,
              concat_ws(' · ', 'registre (' || lower(v.population) || CASE WHEN v.statut = 'SORTI' THEN ', sorti' ELSE '' END || ')',
                        'né(e) le ' || to_char(v."dateNaissance", 'DD/MM/YYYY'), d.nom) AS detail
         FROM volontaire v LEFT JOIN departement d ON d.id = v."departementId"
        WHERE ${like.replace(/"nomNormalise"/g, 'v."nomNormalise"')} ORDER BY v."nomNormalise" LIMIT 10`,
      p,
    );
    return [
      ...perso.map((x) => ({ agentId: x.id, nom: x.nom, detail: x.detail })),
      ...reg.map((x) => ({ volontaireId: x.id, nom: x.nom, detail: x.detail })),
    ];
  }
}
