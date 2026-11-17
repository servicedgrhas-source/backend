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
};

/** Les rubriques de la fiche que l'on peut recopier depuis le rapport. */
export const RUBRIQUES_APPLICABLES = [
  'NOMS_PRENOMS',
  'MATRICULE_SOLDE',
  'LIEU_SERVICE',
  'DATE_NAISSANCE',
  'DATE_PRISE_SERVICE',
  'DEPARTEMENT',
] as const;

const dateFr = (d: string | null | undefined) =>
  d && /^\d{4}-\d{2}-\d{2}/.test(d)
    ? d.slice(0, 10).split('-').reverse().join('/')
    : (d ?? '');

@Injectable()
export class RapprochementRapportsService {
  constructor(
    private readonly ds: DataSource,
    private readonly journal: JournalService,
    private readonly recensement: RecensementService,
  ) {}

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
      })),
    ];
    // Index : par matricule, par mot du nom, par année de naissance
    const parCode = new Map<string, Fiche[]>();
    const parChiffres = new Map<string, Fiche[]>();
    const parMot = new Map<string, Fiche[]>();
    const parAnnee = new Map<number, Fiche[]>();
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
    }
    return { fiches, parCode, parChiffres, parMot, parAnnee };
  }

  /** Rapprocher toutes les lignes d'un rapport (les décisions prises sont gardées). */
  async rapprocher(rapportId: number) {
    const rapport = await this.ds
      .getRepository(RapportPersonnel)
      .findOne({ where: { id: rapportId } });
    if (!rapport) throw new NotFoundException('Rapport introuvable.');
    const repo = this.ds.getRepository(LigneRapportPersonnel);
    const lignes = await repo.find({ where: { rapportId }, order: { ordre: 'ASC' } });
    const b = await this.base();
    const parCle = new Map(b.fiches.map((f) => [f.cle, f]));
    for (const l of lignes) Object.assign(l, this.rapprocherLigne(l, rapport, b, parCle));
    await repo.save(lignes, { chunk: 200 });
    await this.ds
      .getRepository(RapportPersonnel)
      .update(rapportId, { calculeLe: new Date(), lignes: lignes.length });
    return { lignes: lignes.length };
  }

  private rapprocherLigne(
    l: LigneRapportPersonnel,
    rapport: RapportPersonnel,
    b: Awaited<ReturnType<RapprochementRapportsService['base']>>,
    parCle: Map<string, Fiche>,
  ): Partial<LigneRapportPersonnel> {
    const mots = motsDuNom(l.nomComplet);
    const anneeOk = (f: Fiche) =>
      !l.anneeNaissance || !f.annee || f.annee === l.anneeNaissance;
    const ecarts: string[] = [];
    let methode: string | null = null;
    let probable = false;
    let choisie: Fiche | null = null;
    let autres: Fiche[] = [];

    // Une fiche choisie ou confirmée à l'écran reste la fiche de la ligne
    const fixee =
      l.decision === 'CONFIRME' || l.decision === 'AUTRE_FICHE'
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
      const complets = [...parNom]
        .map((f) => ({ f, n: compareNoms(mots, f.mots) }))
        .filter((x) => x.n.complet && anneeOk(x.f))
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
      // 3. Un nom proche (fautes), même année de naissance
      if (!choisie) {
        const memeAnnee = l.anneeNaissance
          ? (b.parAnnee.get(l.anneeNaissance) ?? [])
          : [];
        // Le registre n'a souvent pas la date de naissance : ses fiches de la même DDEPPSA aussi
        const sansDate = b.fiches.filter(
          (f) =>
            f.type === 'REGISTRE' &&
            !f.annee &&
            f.departementId === rapport.departementId,
        );
        const proches = [...memeAnnee, ...sansDate]
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
    return {
      rapport: rapport[0],
      lignes: lignes.map((l) => ({
        ...l,
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
   * Appliquer le rapport à la fiche du personnel (17/11/2026) : les rubriques choisies (nom,
   * matricule, lieu de service, dates, département) sont recopiées, valeur relue à l'écran. Comme
   * une correction faite au recensement : valeurs contrôlées, doublon vérifié, historique de la
   * fiche, journal, et passage au « Contrôle des modifications » (ancienne et nouvelle valeur).
   */
  async appliquer(
    u: UtilisateurConnecte,
    ligneId: number,
    champs: Record<string, unknown>,
    forcer = false,
  ) {
    const repo = this.ds.getRepository(LigneRapportPersonnel);
    const l = await repo.findOne({ where: { id: ligneId } });
    if (!l) throw new NotFoundException('Ligne introuvable.');
    if (!l.agentId)
      throw new BadRequestException(
        'Pas de fiche du personnel pour cette personne : choisissez d’abord la fiche.',
      );
    const donnees: Record<string, unknown> = {};
    for (const k of RUBRIQUES_APPLICABLES) {
      const v = champs?.[k];
      if (v === undefined || v === null || String(v).trim() === '') continue;
      donnees[k] = String(v).trim().slice(0, 250);
    }
    // Le département : choisi par son numéro, écrit dans la fiche par son code
    if (donnees.DEPARTEMENT !== undefined) {
      const [d] = await this.ds.query<{ code: string }[]>(
        `SELECT code FROM departement WHERE id = $1`,
        [Number(donnees.DEPARTEMENT)],
      );
      if (!d) throw new BadRequestException('Département inconnu.');
      donnees.DEPARTEMENT = d.code;
    }
    if (!Object.keys(donnees).length)
      throw new BadRequestException('Cochez au moins une rubrique à recopier.');
    const [avant] = await this.ds.query<{ donnees: Record<string, unknown> }[]>(
      `SELECT donnees FROM agent_recense WHERE id = $1`,
      [l.agentId],
    );
    if (!avant) throw new NotFoundException('Fiche du personnel introuvable.');
    await this.recensement.modifier(u, l.agentId, {
      donnees,
      recensement: true,
      forcer,
    });
    const [apres] = await this.ds.query<{ donnees: Record<string, unknown> }[]>(
      `SELECT donnees FROM agent_recense WHERE id = $1`,
      [l.agentId],
    );
    l.applique = {
      ...(l.applique ?? {}),
      ...Object.fromEntries(
        Object.keys(donnees).map((k) => [
          k,
          { avant: avant.donnees?.[k] ?? null, apres: apres?.donnees?.[k] ?? null },
        ]),
      ),
    };
    l.appliquePar = u.nom;
    l.appliqueLe = new Date();
    // Appliquer, c'est reconnaître la fiche
    if (!l.decision) {
      l.decision = 'CONFIRME';
      l.decidePar = u.nom;
      l.decideLe = new Date();
    }
    const rapport = await this.ds
      .getRepository(RapportPersonnel)
      .findOneOrFail({ where: { id: l.rapportId } });
    const b = await this.base();
    Object.assign(l, this.rapprocherLigne(l, rapport, b, new Map(b.fiches.map((f) => [f.cle, f]))));
    await repo.save(l);
    await this.journal.log(u, 'RAPPORT_DDEPPSA_APPLIQUE', 'ligne_rapport_personnel', l.id, {
      rapportId: l.rapportId,
      agentId: l.agentId,
      rubriques: Object.keys(donnees),
    });
    return { ok: true, rubriques: Object.keys(donnees) };
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
   * L'export demandé (DG, 17/11/2026) : pour chaque personne du rapport, le nom, le lieu de
   * service, la date de naissance, le matricule, la date de prise de service et le département,
   * d'après le rapport puis d'après la base ; le résultat, les écarts, la décision.
   */
  async excel(id: number) {
    const { rapport, lignes } = await this.detail(id);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'SIGRHAS-MEPPSA';
    const ws = wb.addWorksheet('Rapprochement', {
      views: [{ state: 'frozen', xSplit: 2, ySplit: 4 }],
    });
    const VERT = 'FF00692F';
    const bord = { style: 'thin' as const, color: { argb: 'FFD4D4D8' } };
    const cadre = { top: bord, left: bord, bottom: bord, right: bord };
    const cols: [string, number][] = [
      ['N°', 5],
      ['Secteur', 11],
      ['Noms et prénoms', 30],
      ['Lieu de service', 24],
      ['Date de naissance', 11],
      ['Matricule', 11],
      ['Date de prise de service', 12],
      ['Département', 13],
      ['Noms et prénoms', 30],
      ['Lieu de service', 28],
      ['Date de naissance', 11],
      ['Matricule', 11],
      ['Date de prise de service', 12],
      ['Département', 13],
      ['Statut', 14],
      ['Résultat', 15],
      ['Écarts à vérifier', 60],
      ['Décision', 16],
    ];
    ws.columns = cols.map(([, w]) => ({ width: w }));
    ws.mergeCells(1, 1, 1, cols.length);
    const t = ws.getCell(1, 1);
    t.value = `Rapprochement du rapport ${rapport.anneeScolaire || ''} — DDEPPSA ${rapport.departement ?? '?'}`;
    t.font = { size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
    t.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: VERT } };
    t.alignment = { vertical: 'middle', indent: 1 };
    ws.getRow(1).height = 26;
    ws.mergeCells(2, 1, 2, cols.length);
    ws.getCell(2, 1).value = `Fichier « ${rapport.nomFichier} », ${lignes.length} personne(s). Comparé à la base du personnel et au registre des volontaires et des communautaires le ${new Date().toLocaleDateString('fr-FR')}.`;
    ws.getCell(2, 1).font = { size: 10, italic: true, color: { argb: 'FF52525B' } };
    const sous = ws.getRow(3);
    for (const [de, a, txt, fond] of [
      [1, 8, 'D’après le rapport de la DDEPPSA', 'FFE4E4E7'],
      [9, 15, 'Dans la base (SIGRHAS-MEPPSA)', 'FFE9F7EF'],
      [16, 18, 'Rapprochement', 'FFE4E4E7'],
    ] as [number, number, string, string][]) {
      ws.mergeCells(3, de, 3, a);
      const c = sous.getCell(de);
      c.value = txt;
      c.font = { bold: true, size: 10 };
      c.alignment = { horizontal: 'center' };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fond } };
      for (let k = de; k <= a; k++) sous.getCell(k).border = cadre;
    }
    const h = ws.getRow(4);
    cols.forEach(([l], i) => {
      const c = h.getCell(i + 1);
      c.value = l;
      c.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: VERT } };
      c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      c.border = cadre;
    });
    h.height = 30;
    const COULEURS: Record<string, [string, string]> = {
      TROUVE: ['FFE9F7EF', VERT],
      ECARTS: ['FFFDF6D2', 'FF8A6D00'],
      PROBABLE: ['FFE0F2FE', 'FF0369A1'],
      ABSENT: ['FFFBE3E2', 'FFB51D19'],
    };
    const SECTEURS: Record<string, string> = { PUBLIC: 'Public', CONVENTIONNE: 'Conventionné', PRIVE: 'Privé' };
    lignes.forEach((l, i) => {
      const f = l.base;
      const row = ws.getRow(5 + i);
      row.values = [
        l.numero ?? l.ordre,
        SECTEURS[l.secteur ?? ''] ?? '',
        l.nomComplet,
        l.ecole ?? '',
        l.dateNaissance ? dateFr(l.dateNaissance) : (l.anneeNaissance ?? ''),
        l.matricule ?? '',
        l.priseService ?? '',
        rapport.departement ?? '',
        f?.nom ?? '',
        f?.lieu ?? '',
        dateFr(f?.dateNaissance),
        f?.matricule ?? '',
        dateFr(f?.priseService),
        f?.departement ?? '',
        f ? `${STATUTS[f.statut] ?? f.statut}${f.type === 'REGISTRE' ? ` (registre${f.etat === 'SORTI' ? ', sorti' : ''})` : ''}` : '',
        RESULTATS[l.resultat] ?? l.resultat,
        l.ecarts.map((e) => `• ${e}`).join('\n'),
        l.decision ? DECISIONS[l.decision] : '',
      ];
      row.eachCell({ includeEmpty: true }, (c, k) => {
        if (k > cols.length) return;
        c.border = cadre;
        c.font = { size: 10, bold: k === 3 || k === 9 };
        c.alignment = { vertical: 'top', wrapText: true };
        if (i % 2) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F4F5' } };
      });
      const [fond, encre] = COULEURS[l.resultat] ?? COULEURS.ABSENT;
      row.getCell(16).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fond } };
      row.getCell(16).font = { size: 10, bold: true, color: { argb: encre } };
    });
    ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4 + lignes.length, column: cols.length } };
    ws.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '3:4' };
    ws.headerFooter = {
      oddFooter:
        '&L&8Document généré par le Système d’Information de gestion des ressources humaines et de l’administration scolaire (SIGRHAS-MEPPSA)&R&8Page &P / &N',
    };
    const nom = `Rapprochement ${rapport.departement ?? 'DDEPPSA'} ${rapport.anneeScolaire || ''}`.trim();
    return { nom: `${nom}.xlsx`, contenu: Buffer.from(await wb.xlsx.writeBuffer()) };
  }

  /** Le modèle à remplir (ou que l'on produit à partir des photos des rapports). */
  async modele() {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Personnel');
    const titres = [
      'Secteur', 'Cycle', 'Rubrique', 'N°', 'Noms et prénoms', 'Genre', 'Année naiss', 'Nat', 'G/E', 'Stat',
      'Fonct', 'Ecole', 'Situat matri', 'Code serv', 'Ind', 'Mle solde', 'Acad', 'Prof', 'Recr',
      'Dern. promo', 'Arrv départ',
    ];
    ws.addRow(titres);
    ws.addRow(['Public', 'Préscolaire', 'Administratif', 1, 'NOM Prénom', 'F', 1987, 'C', 'IA 1er', 'Fonct', 'Directrice', 'CEP …', 'C2', 2370, 464, '000000X', 'CEPE', 'BET', 2020, 2022, 2020]);
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00692F' } };
    ws.columns.forEach((c, i) => (c.width = i === 4 ? 32 : i === 10 || i === 11 ? 22 : 11));
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
