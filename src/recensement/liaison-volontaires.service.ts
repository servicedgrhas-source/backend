import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IndexNoms } from '../common/index-noms';
import { normaliser } from '../common/texte';
import { JournalService } from '../core/core.service';
import { AgentRecense, Departement, Structure, Volontaire } from '../entities';
import { AffectationsPersonnelService } from './affectations-personnel.service';
import { ConfigRecensementService } from './configuration';
import {
  etape,
  numeroFiche,
  parcoursDe,
  RecensementService,
} from './recensement.service';
import { estVide, lireValeur } from './valeurs';

/**
 * Lien entre le registre des volontaires (enrôlement, bourse) et la base du personnel.
 *
 * Chaque volontaire a sa fiche dans la base du personnel (type « Volontaire ») : elle est créée
 * à son entrée dans le registre, ou reliée à une fiche « volontaire » déjà recensée sous le même
 * nom. Les rubriques venant du registre (département, établissement, note…) suivent le registre
 * tant que le recensement ne les a pas corrigées. Le jour où il sort du registre comme « recruté
 * à la Fonction Publique », la même fiche devient « fonctionnaire » : la personne reste une seule.
 */
@Injectable()
export class LiaisonVolontairesService implements OnApplicationBootstrap {
  private readonly log = new Logger('Personnel');
  /** Dernier passage : seuls les volontaires modifiés depuis sont relus. */
  private depuis: string | null = null;
  private enCours: Promise<unknown> | null = null;

  constructor(
    @InjectRepository(Volontaire)
    private readonly volontaires: Repository<Volontaire>,
    @InjectRepository(AgentRecense)
    private readonly agents: Repository<AgentRecense>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    @InjectRepository(Structure)
    private readonly structures: Repository<Structure>,
    private readonly config: ConfigRecensementService,
    private readonly rec: RecensementService,
    private readonly journal: JournalService,
    private readonly notes: AffectationsPersonnelService,
  ) {}

  onApplicationBootstrap() {
    // Au démarrage, en arrière-plan : les volontaires d'avant la base du personnel y entrent
    setTimeout(() => {
      this.miseAJour().catch((e: Error) =>
        this.log.error(
          `Liaison avec le registre des volontaires : ${e.message}`,
        ),
      );
    }, 3000);
  }

  /** Relie ou met à jour les fiches des volontaires nouveaux ou modifiés depuis le dernier passage. */
  async miseAJour() {
    // Un seul passage à la fois ; un appel pendant un passage attend sa fin puis relance
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
    const [{ maintenant }] = await this.agents.query<{ maintenant: string }[]>(
      `SELECT now()::text AS maintenant`,
    );
    const vols = await this.volontaires.query<Volontaire[]>(
      `SELECT v.* FROM volontaire v LEFT JOIN agent_recense a ON a."volontaireId" = v.id
        WHERE a.id IS NULL OR ($1::timestamptz IS NOT NULL AND v."modifieLe" > $1::timestamptz)`,
      [this.depuis],
    );
    const bilan = { lies: 0, crees: 0, misAJour: 0, recrutes: 0 };
    if (vols.length) Object.assign(bilan, await this.traiter(vols));
    this.depuis = maintenant;
    if (bilan.crees || bilan.lies || bilan.recrutes)
      this.log.log(
        `Registre des volontaires → base du personnel : ${bilan.crees} fiche(s) créée(s), ${bilan.lies} reliée(s), ${bilan.misAJour} mise(s) à jour, ${bilan.recrutes} devenue(s) « fonctionnaire »`,
      );
    // Les notes d'enrôlement des volontaires entrent dans leurs affectations successives
    if (vols.length) await this.notes.synchroniser();
    return bilan;
  }

  private async traiter(vols: Volontaire[]) {
    const c = this.config.get();
    const champ = (code: string) =>
      c.champs.find((x) => x.code === code && x.actif) ?? null;
    const deps = new Map((await this.deps.find()).map((d) => [d.id, d.code]));
    const structures = new Map<string, Structure>();
    for (const s of await this.structures.find({ where: { actif: true } }))
      structures.set(normaliser(s.nom), s);

    const lies = new Map(
      (
        await this.agents.query<AgentRecense[]>(
          `SELECT * FROM agent_recense WHERE "volontaireId" = ANY($1)`,
          [vols.map((v) => v.id)],
        )
      ).map((a) => [a.volontaireId!, a]),
    );
    // Fiches « volontaire » ou « communautaire » recensées mais pas encore reliées au registre
    const libres = new IndexNoms<AgentRecense>();
    for (const a of await this.agents.query<AgentRecense[]>(
      `SELECT * FROM agent_recense WHERE "volontaireId" IS NULL AND statut IN ('VOLONTAIRE', 'COMMUNAUTAIRE')`,
    ))
      libres.ajouter(a.nomComplet, a.dateNaissance, a);
    const prises = new Set<number>();

    const bilan = { lies: 0, crees: 0, misAJour: 0, recrutes: 0 };
    const nouvelles: AgentRecense[] = [];
    const modifiees: AgentRecense[] = [];
    for (const v of vols) {
      // Valeurs du registre, au format de la fiche du personnel
      const brut: Record<string, unknown> = {
        NOMS_PRENOMS: v.nomComplet,
        DATE_NAISSANCE: v.dateNaissance,
        LIEU_NAISSANCE: v.lieuNaissance,
        TELEPHONE_1: v.telephone,
        DIPLOME_PRO: v.diplome,
        SPECIALITE: v.specialite,
        // Barème des communautaires : « COM_PRIMAIRE » → cycle « PRIMAIRE »
        CYCLE: v.categorie?.replace(/^COM_/, '') ?? null,
        DEPARTEMENT: v.departementId ? deps.get(v.departementId) : null,
        LIEU_SERVICE: v.etablissement,
        NOTE_AFFECTATION: v.noteReference
          ? `Note n° ${v.noteReference}${v.dateNote ? ` du ${v.dateNote.split('-').reverse().join('/')}` : ''}`
          : null,
        TEXTE_RECRUTEMENT: v.noteReference
          ? `Note n° ${v.noteReference}`
          : null,
        DATE_RECRUTEMENT: v.dateNote,
        DATE_PRISE_SERVICE: v.datePriseService,
        POSITION:
          v.statut === 'EN_POSTE'
            ? 'ACTIVITE'
            : v.motifSortie === 'DECES'
              ? 'DECEDE'
              : null,
      };
      const registre: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(brut)) {
        const ch = champ(k);
        if (!ch || estVide(x)) continue;
        const lu = lireValeur(ch, x);
        if (!lu.erreur && !estVide(lu.valeur)) registre[k] = lu.valeur;
      }

      let a = lies.get(v.id) ?? null;
      if (!a) {
        const trouves = libres
          .probables(v.nomComplet, v.dateNaissance)
          .filter((x) => !prises.has(x.id));
        if (trouves.length === 1) {
          a = trouves[0];
          prises.add(a.id);
          a.volontaireId = v.id;
          bilan.lies++;
        }
      }
      const avant = (a?.liaison?.volontaire ?? {}) as Record<string, unknown>;
      if (!a) {
        const statut =
          v.population === 'COMMUNAUTAIRE' ? 'COMMUNAUTAIRE' : 'VOLONTAIRE';
        a = this.agents.create({
          statut,
          parcours: [
            etape(
              statut,
              'Registre des volontaires',
              v.dateNote,
              v.noteReference ? `Note n° ${v.noteReference}` : null,
            ),
          ],
          volontaireId: v.id,
          donnees: {},
          liaison: {},
          source: 'ENROLEMENT',
          creePar: 'Registre des volontaires',
          modifiePar: 'Registre des volontaires',
        });
        bilan.crees++;
      }
      // Une rubrique suit le registre tant que le recensement ne l'a pas corrigée
      const d = { ...(a.donnees ?? {}) };
      let change = false;
      for (const [k, x] of Object.entries(registre)) {
        const actuel = d[k];
        if (
          estVide(actuel) ||
          JSON.stringify(actuel) === JSON.stringify(avant[k])
        ) {
          if (JSON.stringify(actuel) !== JSON.stringify(x)) {
            d[k] = x;
            change = true;
          }
        }
      }
      // Recruté à la Fonction Publique : la même personne devient fonctionnaire
      let recrute = false;
      if (
        v.statut === 'SORTI' &&
        v.motifSortie === 'RECRUTE_FP' &&
        ['VOLONTAIRE', 'COMMUNAUTAIRE'].includes(a.statut)
      ) {
        a.parcours = [
          ...parcoursDe(a),
          etape(
            'FONCTIONNAIRE',
            'Registre des volontaires',
            v.dateSortie,
            'Sorti du registre : recruté à la Fonction Publique',
          ),
        ];
        a.statut = 'FONCTIONNAIRE';
        recrute = true;
        change = true;
        bilan.recrutes++;
      }
      const struct = v.etablissement
        ? structures.get(normaliser(v.etablissement))
        : undefined;
      const col = await this.rec.colonnes(d);
      const nouveau = !a.id;
      if (
        !nouveau &&
        !change &&
        a.structureId === (struct?.id ?? a.structureId)
      ) {
        a.liaison = { ...(a.liaison ?? {}), volontaire: registre };
        modifiees.push(a);
        continue;
      }
      Object.assign(a, col, {
        donnees: d,
        departementId: col.departementId ?? a.departementId ?? null,
        structureId: a.structureId ?? struct?.id ?? null,
        liaison: { ...(a.liaison ?? {}), volontaire: registre },
        modifiePar: nouveau ? a.modifiePar : 'Registre des volontaires',
      });
      if (nouveau) nouvelles.push(a);
      else {
        modifiees.push(a);
        bilan.misAJour++;
      }
      if (recrute && !nouveau)
        await this.journal.log(
          null,
          'PERSONNEL_RECRUTE_FP',
          'agent_recense',
          a.id,
          {
            nom: a.nomComplet,
            motif:
              'Sorti du registre des volontaires : recruté à la Fonction Publique',
          },
        );
    }

    const fournies = await this.rec.piecesFournies(modifiees.map((a) => a.id));
    for (const a of nouvelles) this.rec.appliquerEvaluation(a, {});
    for (const a of modifiees)
      this.rec.appliquerEvaluation(a, fournies.get(a.id) ?? {});
    for (let i = 0; i < nouvelles.length; i += 500)
      await this.agents.save(nouvelles.slice(i, i + 500));
    for (let i = 0; i < modifiees.length; i += 500)
      await this.agents.save(modifiees.slice(i, i + 500));
    if (nouvelles.length)
      await this.agents.query(
        `UPDATE agent_recense SET "numeroFiche" = 'REC-' || lpad(id::text, 6, '0') WHERE "numeroFiche" IS NULL`,
      );
    return bilan;
  }

  /** Fiche du personnel d'un volontaire (lien depuis le registre). */
  async ficheDe(volontaireId: string) {
    const a = await this.agents.findOne({
      where: { volontaireId },
      select: {
        id: true,
        numeroFiche: true,
        statut: true,
        taux: true,
        complet: true,
      },
    });
    return a
      ? {
          id: a.id,
          numeroFiche: a.numeroFiche ?? numeroFiche(a.id),
          statut: a.statut,
          taux: a.taux,
          complet: a.complet,
        }
      : null;
  }
}
