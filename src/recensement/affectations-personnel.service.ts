import {
  BadRequestException,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { UtilisateurConnecte } from '../auth/auth';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AffectationService } from '../affectation/affectation.service';
import { deriver } from '../affectation/calcul';
import { IndexNoms } from '../common/index-noms';
import { libelleLot } from '../common/lots';
import { JournalService, ParametresService } from '../core/core.service';
import {
  Affectation,
  Agent,
  AgentRecense,
  Departement,
  NoteService,
  Volontaire,
} from '../entities';
import { etape, parcoursDe, RecensementService } from './recensement.service';
import { estVide, lireValeur } from './valeurs';

/**
 * Les deux affectations d'une même personne, reportées dans sa fiche du personnel (DG, 23/10/2026) :
 * 1. comme volontaire : la note d'enrôlement (c'est elle qui l'enrôle ; prise de service, bourse) ;
 * 2. comme fonctionnaire ou contractuel : la note d'affectation qui suit son texte d'intégration de
 *    la Fonction Publique (nouvelle prise de service, salaire).
 * Chaque note signée remplit la note d'affectation actuelle et ajoute une ligne aux affectations
 * successives ; la deuxième fait passer la fiche au nouveau statut, à la date du texte. La bourse,
 * elle, ne s'arrête qu'au premier salaire (pointage du bottin).
 */

const SOURCE = 'Notes de service';
const dateFr = (d: string | null | undefined) =>
  d ? d.slice(0, 10).split('-').reverse().join('/') : null;
const referenceNote = (numero: string | null, date: string | null) =>
  `Note n° ${numero ?? '?'}${date ? ` du ${dateFr(date)}` : ''}`;
/**
 * Référence d'une note signée telle qu'elle est imprimée (DG, 24/10/2026) : « Note de service
 * n° 220/MEPPSA-CAB-DGRHAS-DRSC-SR du 15/10/2026 » ; le suffixe dit le chemin hiérarchique, du
 * cabinet au service qui a initié la note.
 */
const referenceComplete = (
  numero: string | null,
  suffixe: string | null | undefined,
  date: string | null,
) =>
  `Note de service n° ${numero ?? '?'}${suffixe ? `/${suffixe}` : ''}${date ? ` du ${dateFr(date)}` : ''}`;

type LigneAffectation = { NOTE?: string; DATE?: string; LIEU?: string };

/**
 * Où va un recruté dans la base du personnel :
 * - LIEE : sa fiche est déjà liée (commission, déport précédent) ;
 * - MISE_A_JOUR : une seule fiche au même nom et à la même date de naissance (volontaire,
 *   communautaire…) : elle est mise à jour ;
 * - DOUBLON : des fiches ressemblent sans être sûres (nom proche, ou même nom et autre date de
 *   naissance) : à trancher avant de déporter ;
 * - CREATION : personne de semblable : une fiche est créée.
 */
export type Rapprochement =
  | { type: 'LIEE' | 'MISE_A_JOUR'; fiche: AgentRecense }
  | { type: 'DOUBLON'; candidats: AgentRecense[] }
  | { type: 'CREATION' };

function rapprocher(
  ag: Pick<Agent, 'agentRecenseId' | 'nomComplet' | 'dateNaissance'>,
  parId: Map<number, AgentRecense>,
  index: IndexNoms<AgentRecense>,
): Rapprochement {
  const liee = ag.agentRecenseId ? parId.get(ag.agentRecenseId) : undefined;
  if (liee) return { type: 'LIEE', fiche: liee };
  const t = index.probables(ag.nomComplet, ag.dateNaissance);
  const meme = t.filter(
    (x) => !!ag.dateNaissance && x.dateNaissance === ag.dateNaissance,
  );
  if (meme.length === 1 && t.length === 1)
    return { type: 'MISE_A_JOUR', fiche: meme[0] };
  if (t.length) return { type: 'DOUBLON', candidats: t.slice(0, 5) };
  // Même nom complet, autre date de naissance : homonyme ou date mal saisie, à trancher
  const homonymes = index.memesNoms(ag.nomComplet);
  if (homonymes.length)
    return { type: 'DOUBLON', candidats: homonymes.slice(0, 5) };
  return { type: 'CREATION' };
}

@Injectable()
export class AffectationsPersonnelService implements OnApplicationBootstrap {
  private readonly log = new Logger('Personnel');
  private enCours: Promise<unknown> | null = null;

  constructor(
    @InjectRepository(AgentRecense)
    private readonly agents: Repository<AgentRecense>,
    @InjectRepository(NoteService)
    private readonly notes: Repository<NoteService>,
    @InjectRepository(Affectation)
    private readonly affectations: Repository<Affectation>,
    @InjectRepository(Volontaire)
    private readonly volontaires: Repository<Volontaire>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    private readonly affSvc: AffectationService,
    private readonly rec: RecensementService,
    private readonly journal: JournalService,
    private readonly params: ParametresService,
  ) {}

  onApplicationBootstrap() {
    // Après la liaison du registre des volontaires (fiches des volontaires d'abord)
    setTimeout(() => {
      this.synchroniser().catch((e: Error) =>
        this.log.error(`Notes de service → base du personnel : ${e.message}`),
      );
    }, 8000);
  }

  /**
   * Notes signées déjà reportées automatiquement avant le 30/10/2026 (leur clé est dans une fiche) :
   * leurs affectés comptent comme déportés. Sans effet pour les notes signées depuis.
   */
  private async marquerDejaDeportes() {
    // Une seule fois (au premier démarrage après la mise à jour) : ensuite, seul le déport décide
    const MARQUE = 'MIGRATION_DEPORT_PERSONNEL_20261030';
    const [fait] = await this.affectations.query<unknown[]>(
      `SELECT 1 FROM parametre WHERE cle = $1`,
      [MARQUE],
    );
    if (fait) return;
    await this.affectations.query(`
      UPDATE affectation f SET "deporteLe" = now(), "deportePar" = 'Report automatique (avant le 30/10/2026)'
      WHERE f."deporteLe" IS NULL AND f.statut = 'AFFECTE' AND f."noteId" IS NOT NULL
        AND EXISTS (SELECT 1 FROM agent_recense r
                    WHERE r.liaison->'notes' ? ('AFFECTATION:' || f."noteId"::text))`);
    await this.affectations.query(
      `INSERT INTO parametre (cle, valeur, description) VALUES ($1, $2, $3) ON CONFLICT (cle) DO NOTHING`,
      [
        MARQUE,
        new Date().toISOString(),
        'Affectés déjà reportés dans la base du personnel marqués « déportés »',
      ],
    );
  }

  /** Un seul passage à la fois. */
  async synchroniser() {
    while (this.enCours) await this.enCours.catch(() => undefined);
    const p = this.passage();
    this.enCours = p;
    try {
      return await p;
    } finally {
      this.enCours = null;
    }
  }

  private async passage() {
    await this.marquerDejaDeportes();
    const enrolement = await this.notesEnrolement();
    // Les recrutés n'entrent dans la base du personnel que déportés (DG, 30/10/2026)
    const affectation = await this.notesAffectation();
    const bilan = { ...enrolement, ...affectation };
    if (Object.values(bilan).some((n) => n > 0))
      this.log.log(
        `Notes de service → base du personnel : ${bilan.enroles} affectation(s) de volontaire, ${bilan.affectes} affectation(s) après le texte de la FP (${bilan.integres} passé(s) fonctionnaire ou contractuel, ${bilan.crees} fiche(s) créée(s))`,
      );
    return bilan;
  }

  /** Ajoute la ligne de la note aux affectations successives (ou remplace celle d'un ancien numéro). */
  private ajouterLigne(a: AgentRecense, cle: string, ligne: LigneAffectation) {
    const d = a.donnees;
    const deja = (a.liaison?.notes ?? {}) as Record<string, string>;
    const ancien = deja[cle];
    const lignes = (
      Array.isArray(d.AFFECTATIONS_SUCCESSIVES)
        ? d.AFFECTATIONS_SUCCESSIVES
        : []
    ) as LigneAffectation[];
    const propre = Object.fromEntries(
      Object.entries(ligne).filter(([, v]) => !estVide(v)),
    ) as LigneAffectation;
    const i = lignes.findIndex(
      (l) => l?.NOTE === ligne.NOTE || (!!ancien && l?.NOTE === ancien),
    );
    if (i >= 0) lignes[i] = { ...lignes[i], ...propre };
    else lignes.push(propre);
    d.AFFECTATIONS_SUCCESSIVES = lignes;
    a.liaison = { ...(a.liaison ?? {}), notes: { ...deja, [cle]: ligne.NOTE } };
  }

  private dejaFait(a: AgentRecense, cle: string, note: string) {
    return ((a.liaison?.notes ?? {}) as Record<string, string>)[cle] === note;
  }

  private async enregistrer(liste: AgentRecense[]) {
    if (!liste.length) return;
    const fournies = await this.rec.piecesFournies(
      liste.filter((a) => a.id).map((a) => a.id),
    );
    for (const a of liste) {
      const col = await this.rec.colonnes(a.donnees);
      Object.assign(a, col, {
        departementId: col.departementId ?? a.departementId,
      });
      this.rec.appliquerEvaluation(a, a.id ? (fournies.get(a.id) ?? {}) : {});
    }
    for (let i = 0; i < liste.length; i += 500)
      await this.agents.save(liste.slice(i, i + 500));
    await this.agents.query(
      `UPDATE agent_recense SET "numeroFiche" = 'REC-' || lpad(id::text, 6, '0') WHERE "numeroFiche" IS NULL`,
    );
  }

  /**
   * 1. Comme volontaire : la note d'enrôlement de chaque volontaire du registre (note signée dans le
   * système, ou reprise d'une liste existante) entre dans ses affectations successives.
   */
  private async notesEnrolement() {
    const lignes = await this.volontaires.query<
      {
        agentId: number;
        noteReference: string;
        dateNote: string | null;
        datePriseService: string | null;
        etablissement: string | null;
      }[]
    >(
      `SELECT a.id AS "agentId", v."noteReference", to_char(v."dateNote", 'YYYY-MM-DD') AS "dateNote",
              to_char(v."datePriseService", 'YYYY-MM-DD') AS "datePriseService", v.etablissement
         FROM volontaire v JOIN agent_recense a ON a."volontaireId" = v.id
        WHERE v."noteReference" IS NOT NULL`,
    );
    if (!lignes.length) return { enroles: 0 };
    const fiches = new Map(
      (
        await this.agents.find({
          where: { id: In(lignes.map((l) => l.agentId)) },
        })
      ).map((a) => [a.id, a]),
    );
    const modifiees: AgentRecense[] = [];
    for (const l of lignes) {
      const a = fiches.get(l.agentId);
      if (!a) continue;
      const note = `${referenceNote(l.noteReference, l.dateNote)} (enrôlement)`;
      const cle = `ENROLEMENT:${l.noteReference}`;
      if (this.dejaFait(a, cle, note)) continue;
      this.ajouterLigne(a, cle, {
        NOTE: note,
        DATE: l.datePriseService ?? undefined,
        LIEU: l.etablissement ?? undefined,
      });
      // La première étape du parcours prend la date de la note d'enrôlement
      const p = parcoursDe(a);
      if (p[0].statut === 'VOLONTAIRE' && !p[0].depuis)
        a.parcours = [
          { ...p[0], depuis: l.dateNote, texte: p[0].texte ?? note },
          ...p.slice(1),
        ];
      a.modifiePar = SOURCE;
      modifiees.push(a);
    }
    await this.enregistrer(modifiees);
    return { enroles: modifiees.length };
  }

  /**
   * 2. Comme fonctionnaire ou contractuel : chaque note d'affectation signée (après le texte de la
   * FP) est reportée dans la fiche de la personne, retrouvée par le lien de la commission ou par son
   * nom et sa date de naissance ; une personne absente de la base y entre.
   */
  private async notesAffectation(
    choix: Map<string, number | 'NOUVELLE'> = new Map(),
  ) {
    const bilan = { affectes: 0, integres: 0, crees: 0, doublons: 0 };
    const notes = await this.notes.find({
      where: { module: 'AFFECTATION', statut: 'SIGNEE' },
      order: { dateSignature: 'ASC' },
    });
    if (!notes.length) return bilan;
    // Fiches créées pour un recruté : son lien est gardé sur sa fiche de recrutement
    const liens: { agentId: string; fiche: AgentRecense }[] = [];
    const regles = await this.affSvc.reglesParCode();
    const p = this.affSvc.parametresCalcul();
    const deps = new Map((await this.deps.find()).map((d) => [d.id, d]));
    const c = this.rec.config.get();
    const champ = (code: string) =>
      c.champs.find((x) => x.code === code && x.actif);
    const valeur = (code: string, v: unknown) => {
      const ch = champ(code);
      if (!ch || estVide(v)) return undefined;
      const lu = lireValeur(ch, v);
      return lu.erreur || estVide(lu.valeur) ? undefined : lu.valeur;
    };

    // Fiches existantes : par id et par nom (et date de naissance)
    const toutes = await this.agents.find();
    const parId = new Map(toutes.map((a) => [a.id, a]));
    const index = new IndexNoms<AgentRecense>();
    for (const a of toutes) index.ajouter(a.nomComplet, a.dateNaissance, a);
    const modifiees = new Map<number, AgentRecense>();
    const nouvelles: AgentRecense[] = [];

    for (const n of notes) {
      const note = referenceComplete(
        n.numero,
        (n.contenu as { entete?: { reference?: string } } | null)?.entete
          ?.reference ?? this.params.get('REFERENCE_NOTE'),
        n.dateSignature,
      );
      // Grade imprimé sur la note validée (« Inst.C. » : contractuel)
      const grades = new Map<string, string>();
      for (const s of (
        n.contenu as {
          sections?: { lignes?: { id: string; grade?: string }[] }[];
        } | null
      )?.sections ?? [])
        for (const l of s.lignes ?? []) if (l.grade) grades.set(l.id, l.grade);
      const affs = (
        await this.affectations.find({ where: { noteId: n.id } })
      ).filter((x) => x.deporteLe);
      for (const aff of affs) {
        const ag = aff.agent;
        if (!ag) continue;
        const cle = `AFFECTATION:${n.id}`;
        const d = deriver(aff, regles, p);
        const grade = grades.get(aff.id) ?? d.grade;
        const contractuel = grade
          ? /\.C\.?$/i.test(grade.trim())
          : d.contractuel === true;
        const statut = contractuel ? 'CONTRACTUEL' : 'FONCTIONNAIRE';
        const dep = aff.departementId ? deps.get(aff.departementId) : undefined;
        const lieu =
          aff.etablissement ??
          aff.structure ??
          (dep ? `DDEPPSA ${dep.nom}` : null);
        const typeTexte = /DECRET/i.test(ag.typeTexte ?? '')
          ? 'Décret'
          : 'Arrêté';
        const texte = d.reference ? `${typeTexte} n° ${d.reference}` : null;

        // Choix fait à l'écran du déport (doublon possible), sinon le rapprochement
        const c = choix.get(aff.id);
        const r = rapprocher(ag, parId, index);
        let a: AgentRecense | undefined =
          c === 'NOUVELLE'
            ? undefined
            : typeof c === 'number'
              ? parId.get(c)
              : r.type === 'LIEE' || r.type === 'MISE_A_JOUR'
                ? r.fiche
                : undefined;
        // Doublon possible non tranché : rien n'est écrit (il reste à déporter)
        if (!a && c === undefined && r.type === 'DOUBLON') {
          bilan.doublons++;
          continue;
        }
        if (a && this.dejaFait(a, cle, note)) continue;
        if (a && ag.agentRecenseId !== a.id)
          liens.push({ agentId: ag.id, fiche: a });
        if (!a) {
          // Recruté qui n'était pas encore dans la base du personnel
          a = this.agents.create({
            statut,
            donnees: {},
            liaison: {},
            parcours: [etape(statut, SOURCE, d.dateSignature, texte)],
            source: 'AFFECTATION',
            creePar: SOURCE,
            modifiePar: SOURCE,
          });
          for (const [k, v] of Object.entries({
            NOMS_PRENOMS: ag.nomComplet,
            DATE_NAISSANCE: ag.dateNaissance,
            LIEU_NAISSANCE: ag.lieuNaissance,
            DIPLOME_PRO: ag.diplomeBrut,
          })) {
            const x = valeur(k, v);
            if (x !== undefined) a.donnees[k] = x;
          }
          nouvelles.push(a);
          index.ajouter(ag.nomComplet, ag.dateNaissance, a);
          liens.push({ agentId: ag.id, fiche: a });
          bilan.crees++;
        } else if (['VOLONTAIRE', 'COMMUNAUTAIRE'].includes(a.statut)) {
          // Même personne, nouveau statut : nouvelle prise de service à renseigner
          a.parcours = [
            ...parcoursDe(a),
            etape(
              statut,
              SOURCE,
              d.dateSignature,
              texte ? `${texte} · ${note}` : note,
            ),
          ];
          a.statut = statut;
          if (champ('DATE_PRISE_SERVICE')) delete a.donnees.DATE_PRISE_SERVICE;
          bilan.integres++;
        }
        const maj: Record<string, unknown> = {
          NOTE_AFFECTATION: note,
          TEXTE_RECRUTEMENT: texte,
          DATE_RECRUTEMENT: d.dateSignature,
          LIEU_SERVICE: lieu,
          DEPARTEMENT: dep?.code,
        };
        // Carrière : seulement si la fiche ne la donne pas encore (le recensement fait foi)
        for (const [k, v] of Object.entries({
          GRADE: grade,
          CATEGORIE: d.categorie,
          ECHELLE: d.echelle,
          ECHELON: d.echelon,
          INDICE_SOLDE: d.indice,
        }))
          if (estVide(a.donnees[k])) maj[k] = v;
        for (const [k, v] of Object.entries(maj)) {
          const x = valeur(k, v);
          if (x !== undefined) a.donnees[k] = x;
        }
        this.ajouterLigne(a, cle, {
          NOTE: note,
          LIEU: lieu ?? undefined,
        });
        a.modifiePar = SOURCE;
        if (a.id) modifiees.set(a.id, a);
        bilan.affectes++;
      }
    }
    await this.enregistrer([...modifiees.values(), ...nouvelles]);
    for (const l of liens)
      if (l.fiche.id)
        await this.affectations.manager.update(Agent, l.agentId, {
          agentRecenseId: l.fiche.id,
        });
    if (bilan.affectes)
      await this.journal.log(
        null,
        'PERSONNEL_NOTES',
        'agent_recense',
        null,
        bilan,
      );
    return bilan;
  }

  /** Affectés (note signée) pas encore déportés, des lots donnés (tous si vide). */
  private async aDeporter(lots: number[], ids?: string[]) {
    const q = this.affectations
      .createQueryBuilder('f')
      .leftJoinAndSelect('f.agent', 'a')
      .leftJoinAndSelect('a.lotPublication', 'l')
      .innerJoin(NoteService, 'n', 'n.id = f."noteId"')
      .where("f.statut = 'AFFECTE' AND n.statut = 'SIGNEE'")
      .andWhere('f.deporteLe IS NULL');
    if (lots.length) q.andWhere('l.numero IN (:...lots)', { lots });
    if (ids) q.andWhere('f.id IN (:...ids)', { ids: ids.length ? ids : [''] });
    const affs = await q.orderBy('a.nomNormalise').getMany();
    const notes = new Map(
      (
        await this.notes.find({
          where: { id: In([...new Set(affs.map((f) => f.noteId!))]) },
          select: ['id', 'numero', 'dateSignature'],
        })
      ).map((n) => [n.id, n]),
    );
    return { affs, notes };
  }

  /**
   * Aperçu du déport dans la base du personnel (DG, 30/10/2026) : pour chaque affecté dont la note
   * est signée, la fiche mise à jour, créée, ou les fiches qui lui ressemblent (doublon possible, à
   * trancher). C'est le seul moment où l'on compare les recrutés à la base du personnel.
   */
  async apercuDeport(lots: number[]) {
    const { affs, notes } = await this.aDeporter(lots);
    const toutes = await this.agents.find();
    const parId = new Map(toutes.map((a) => [a.id, a]));
    const index = new IndexNoms<AgentRecense>();
    for (const a of toutes) index.ajouter(a.nomComplet, a.dateNaissance, a);
    const fiche = (x: AgentRecense) => ({
      id: x.id,
      numeroFiche: x.numeroFiche,
      nomComplet: x.nomComplet,
      dateNaissance: x.dateNaissance,
      statut: x.statut,
    });
    const lignes = affs.map((f) => {
      const r = rapprocher(f.agent, parId, index);
      const n = notes.get(f.noteId!);
      return {
        id: f.id,
        nomComplet: f.agent.nomComplet,
        dateNaissance: f.agent.dateNaissance,
        lot: f.agent.lotPublication ? libelleLot(f.agent.lotPublication) : null,
        note: n
          ? `Note n° ${n.numero ?? '?'}${n.dateSignature ? ` du ${dateFr(n.dateSignature)}` : ''}`
          : null,
        action: r.type,
        fiche:
          r.type === 'LIEE' || r.type === 'MISE_A_JOUR' ? fiche(r.fiche) : null,
        candidats: r.type === 'DOUBLON' ? r.candidats.map(fiche) : [],
      };
    });
    const compte = (t: string) => lignes.filter((l) => l.action === t).length;
    return {
      total: lignes.length,
      creations: compte('CREATION'),
      misesAJour: compte('MISE_A_JOUR') + compte('LIEE'),
      doublons: compte('DOUBLON'),
      lignes,
    };
  }

  /**
   * Déport : les affectés choisis entrent dans la base du personnel. Chaque doublon possible doit
   * être tranché : `choix[id]` = n° de la fiche (même personne) ou « NOUVELLE » (autre personne).
   */
  async deporter(
    u: UtilisateurConnecte,
    ids: string[],
    choix: Record<string, number | 'NOUVELLE'>,
  ) {
    if (!ids.length) throw new BadRequestException('Aucune personne choisie.');
    const { affs } = await this.aDeporter([], ids);
    if (!affs.length)
      throw new BadRequestException(
        "Ces personnes sont déjà déportées, ou leur note n'est pas encore signée.",
      );
    const toutes = await this.agents.find();
    const parId = new Map(toutes.map((a) => [a.id, a]));
    const index = new IndexNoms<AgentRecense>();
    for (const a of toutes) index.ajouter(a.nomComplet, a.dateNaissance, a);
    const sansChoix = affs.filter(
      (f) =>
        rapprocher(f.agent, parId, index).type === 'DOUBLON' &&
        choix[f.id] === undefined,
    );
    if (sansChoix.length)
      throw new BadRequestException(
        `${sansChoix.length} doublon(s) possible(s) à trancher avant de déporter : même personne ou personne différente.`,
      );
    for (const v of Object.values(choix))
      if (v !== 'NOUVELLE' && !parId.has(Number(v)))
        throw new BadRequestException(`Fiche n° ${v} introuvable.`);
    const retenus = affs.map((f) => f.id);
    while (this.enCours) await this.enCours.catch(() => undefined);
    await this.affectations.update(
      { id: In(retenus) },
      { deporteLe: new Date(), deportePar: u.nom },
    );
    const p = this.notesAffectation(
      new Map(
        Object.entries(choix)
          .filter(([k]) => retenus.includes(k))
          .map(([k, v]) => [k, v === 'NOUVELLE' ? 'NOUVELLE' : Number(v)]),
      ),
    );
    this.enCours = p;
    let bilan: Awaited<typeof p>;
    try {
      bilan = await p;
    } finally {
      this.enCours = null;
    }
    await this.journal.log(u, 'DEPORT_PERSONNEL', 'affectation', null, {
      personnes: retenus.length,
      ...bilan,
    });
    return { personnes: retenus.length, ...bilan };
  }
}
