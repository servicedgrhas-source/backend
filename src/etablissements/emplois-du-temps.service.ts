import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { JournalService, ParametresService } from '../core/core.service';
import {
  Classe,
  EmploiDuTemps,
  HoraireAgent,
  Structure,
  type PlageEnseignant,
} from '../entities';
import {
  genererEmploiDuTemps,
  lireCreneaux,
  seChevauchent,
  type ChargeEnseignant,
  type EnseignantEdt,
  type NonPlace,
  type Seance,
} from './emploi-du-temps-regles';
import { EtablissementsService } from './etablissements.service';

/** Cycles qui ont un emploi du temps par matière (au primaire, un maître par classe). */
const PAR_MATIERE = ['COLLEGE', 'LYCEE'];
const NOMS_JOURS_EDT = [
  '',
  'Lundi',
  'Mardi',
  'Mercredi',
  'Jeudi',
  'Vendredi',
  'Samedi',
];

/**
 * Emplois du temps (DG, 24/10/2026) : l'emploi du temps général de l'établissement (qui fait
 * français en 6ème 1, anglais en 5ème 2…) et celui de chaque enseignant, qu'on lui remet.
 */
@Injectable()
export class EmploisDuTempsService {
  constructor(
    @InjectRepository(EmploiDuTemps)
    private readonly edt: Repository<EmploiDuTemps>,
    @InjectRepository(Classe) private readonly classes: Repository<Classe>,
    @InjectRepository(HoraireAgent)
    private readonly horaires: Repository<HoraireAgent>,
    @InjectRepository(Structure)
    private readonly structures: Repository<Structure>,
    private readonly etab: EtablissementsService,
    private readonly params: ParametresService,
    private readonly journal: JournalService,
  ) {}

  /** Réglages de l'école s'il y en a (DG, 28/10/2026), sinon ceux d'Administration › Paramètres. */
  private reglages(s: Pick<Structure, 'cycle' | 'reglagesEdt'>) {
    const propres = s.reglagesEdt ?? {};
    const jours = (
      propres.jours?.length
        ? propres.jours
        : this.params
            .get('EDT_JOURS')
            .split(/[,; ]+/)
            .map(Number)
    ).filter((j) => Number.isInteger(j) && j >= 1 && j <= 6);
    const creneaux = lireCreneaux(
      propres.creneaux || this.params.get('EDT_CRENEAUX'),
    );
    return {
      jours: jours.length ? [...new Set(jours)].sort() : [1, 2, 3, 4, 5],
      creneaux,
      heuresEnseignant:
        propres.heuresEnseignant || this.etab.heuresEnseignant(s.cycle),
      propres: !!s.reglagesEdt,
    };
  }

  /**
   * Réglages propres à l'école : jours de cours, créneaux, heures d'un enseignant. `null` revient
   * aux réglages généraux. Le chef d'établissement, la DDEPPSA et la DGRHAS peuvent les changer.
   */
  async enregistrerReglages(
    u: UtilisateurConnecte,
    structureId: number,
    dto: {
      jours?: number[];
      creneaux?: string;
      heuresEnseignant?: number;
    } | null,
  ) {
    const s = await this.etab.structure(u, structureId);
    let reglages: Structure['reglagesEdt'] = null;
    if (dto) {
      const jours = [...new Set((dto.jours ?? []).map(Number))]
        .filter((j) => Number.isInteger(j) && j >= 1 && j <= 6)
        .sort();
      if (!jours.length)
        throw new BadRequestException('Cochez au moins un jour de cours.');
      const creneaux = lireCreneaux(dto.creneaux ?? '');
      if (!creneaux.length)
        throw new BadRequestException(
          'Écrivez les créneaux de la journée, par exemple : 07:30-08:25, 08:25-09:20.',
        );
      const h = Number(dto.heuresEnseignant);
      if (!Number.isInteger(h) || h < 1 || h > 40)
        throw new BadRequestException(
          'Heures d’un enseignant par semaine : un nombre de 1 à 40.',
        );
      reglages = {
        jours,
        creneaux: creneaux.map((c) => `${c.debut}-${c.fin}`).join(', '),
        heuresEnseignant: h,
      };
    }
    await this.structures.update(s.id, { reglagesEdt: reglages });
    await this.journal.log(u, 'ECOLE_REGLAGES_EDT', 'structure', String(s.id), {
      reglages,
    });
    return this.lire(u, structureId);
  }

  /** L'emploi du temps enregistré de l'année (ou rien), avec les réglages. */
  async lire(u: UtilisateurConnecte, structureId: number, annee?: string) {
    const s = await this.etab.structure(u, structureId);
    const a = this.etab.annee(annee);
    const e = await this.edt.findOne({
      where: { structureId, anneeScolaire: a },
    });
    const parMatiere = PAR_MATIERE.includes(s.cycle ?? '');
    const prog = parMatiere ? await this.etab.programmes(s.cycle!) : null;
    const classes = await this.classes.find({
      where: { structureId, anneeScolaire: a },
      order: { nom: 'ASC' },
    });
    return {
      structure: { id: s.id, nom: s.nom, cycle: s.cycle },
      annee: a,
      parMatiere,
      reglages: this.reglages(s),
      // Enseignants, leur matière, leurs jours et leurs plages horaires (DG, 28/10/2026)
      enseignants: await this.enseignantsEtJours(structureId, prog),
      // Les classes de l'année et le programme de leur niveau : pour saisir les plages
      classes: classes.map((c) => ({ id: c.id, nom: c.nom, niveau: c.niveau })),
      programme: Object.fromEntries(
        [...new Set(classes.map((c) => c.niveau))].map((n) => [
          n,
          (prog?.parNiveau.get(n) ?? []).filter((x) => x.heures > 0),
        ]),
      ),
      emploi: e,
      aRegenerer:
        e && PAR_MATIERE.includes(s.cycle ?? '')
          ? this.changements(e, await this.situation(structureId, a, s.cycle!))
          : [],
    };
  }

  /** Enseignants en poste de l'école : leur matière, leurs jours (Présence) et leurs plages horaires. */
  private async enseignantsEtJours(
    structureId: number,
    prog: { matieres: Map<string, string> } | null,
  ) {
    const agents = (
      (await this.etab.agentsDe([structureId])).get(structureId) ?? []
    ).filter((x) => x.enseignant && x.enPoste);
    const horaires = new Map(
      (
        await this.horaires.find({
          where: {
            agentId: In(agents.length ? agents.map((x) => x.id) : [-1]),
          },
        })
      ).map((h) => [h.agentId, h]),
    );
    return agents.map((x) => {
      const matiere = prog ? this.etab.matiereAgent(x, prog.matieres) : null;
      return {
        id: x.id,
        nom: x.nomComplet,
        specialite: x.specialite,
        matiere,
        matiereLibelle: matiere
          ? (prog?.matieres.get(matiere) ?? matiere)
          : null,
        jours: horaires.get(x.id)?.jours ?? null,
        plages: horaires.get(x.id)?.plages ?? [],
      };
    });
  }

  /** Classes ouvertes, programme et enseignants (avec leur matière) d'aujourd'hui. */
  private async situation(structureId: number, a: string, cycle: string) {
    const classes = await this.classes.find({
      where: { structureId, anneeScolaire: a },
      order: { nom: 'ASC' },
    });
    const prog = await this.etab.programmes(cycle);
    const agents = (
      (await this.etab.agentsDe([structureId])).get(structureId) ?? []
    ).filter((x) => x.enseignant && x.enPoste);
    // Jours et plages horaires de chaque enseignant
    const horaires = new Map(
      (
        await this.horaires.find({
          where: {
            agentId: In(agents.length ? agents.map((x) => x.id) : [-1]),
          },
        })
      ).map((h) => [h.agentId, h]),
    );
    // Heures du programme des classes ouvertes (sans les plages)
    const heuresProgramme = classes.reduce(
      (t, c) =>
        t +
        (prog.parNiveau.get(c.niveau) ?? [])
          .filter((p) => p.heures > 0)
          .reduce((u, p) => u + Math.round(p.heures), 0),
      0,
    );
    return { classes, prog, agents, horaires, heuresProgramme };
  }

  /**
   * Ce qui a changé depuis la génération (classe ouverte ou fermée, enseignant arrivé ou parti,
   * matière d'un enseignant, quotas horaires) : l'emploi du temps affiché n'est plus à jour.
   */
  private changements(
    e: EmploiDuTemps,
    x: Awaited<ReturnType<EmploisDuTempsService['situation']>>,
  ) {
    const raisons: string[] = [];
    const seances = e.seances as unknown as Seance[];
    const nonPlaces = e.nonPlaces as unknown as NonPlace[];
    const charges = e.charges as unknown as ChargeEnseignant[];
    const avant = new Set([
      ...seances.map((s) => s.classeId),
      ...nonPlaces
        .map((n) => x.classes.find((c) => c.nom === n.classe)?.id)
        .filter((id): id is number => !!id),
    ]);
    const maintenant = new Set(x.classes.map((c) => c.id));
    const ouvertes = x.classes
      .filter((c) => !avant.has(c.id))
      .map((c) => c.nom);
    const fermees = [...avant].filter((id) => !maintenant.has(id)).length;
    if (ouvertes.length)
      raisons.push(`classe(s) ouverte(s) depuis : ${ouvertes.join(', ')}`);
    if (fermees) raisons.push(`${fermees} classe(s) fermée(s) depuis`);
    const matieres = new Map(
      charges.map((c) => [c.agentId, c.matiere ?? null]),
    );
    const arrives = x.agents.filter((g) => !matieres.has(g.id));
    const partis = [...matieres.keys()].filter(
      (id) => !x.agents.some((g) => g.id === id),
    );
    const changes = x.agents.filter(
      (g) =>
        matieres.has(g.id) &&
        matieres.get(g.id) !== this.etab.matiereAgent(g, x.prog.matieres),
    );
    if (arrives.length)
      raisons.push(`${arrives.length} enseignant(s) arrivé(s) depuis`);
    if (partis.length)
      raisons.push(`${partis.length} enseignant(s) parti(s) ou plus en poste`);
    if (changes.length)
      raisons.push(
        `matière changée ou ajoutée pour ${changes.length} enseignant(s)`,
      );
    // Plages horaires ou jours d'un enseignant changés après la génération (Présence…)
    const genere = new Date(e.genereLe).getTime();
    const modifies = x.agents.filter(
      (g) => (x.horaires.get(g.id)?.modifieLe?.getTime() ?? 0) > genere,
    );
    if (modifies.length)
      raisons.push(
        `plages horaires ou jours de ${modifies.length} enseignant(s) modifiés depuis`,
      );
    const programmeAvant = e.heuresProgramme ?? e.heuresTotal;
    if (x.heuresProgramme !== programmeAvant)
      raisons.push(
        `quotas horaires changés (${x.heuresProgramme} h par semaine au programme au lieu de ${programmeAvant} h)`,
      );
    return raisons;
  }

  /**
   * Plages horaires d'un enseignant (DG, 28 et 30/10/2026) : son emploi du temps tel que l'école le
   * fait (le lundi 07:30-08:25 en 6ème 1…), aux heures des créneaux de l'école ou à ses propres heures
   * (le lundi 07:00-08:00 en 5ème 2). Une classe ne peut pas avoir deux enseignants à des heures qui se
   * chevauchent (07:00-08:00 et 07:30-08:30 le même jour : refusé, avec les heures du collègue), ni
   * lui deux classes à la fois. Ses jours de présence suivent ses plages. L'emploi du temps est
   * regénéré tout de suite.
   */
  async plagesEnseignant(
    u: UtilisateurConnecte,
    structureId: number,
    agentId: number,
    plages: unknown,
  ) {
    const s = await this.etab.structure(u, structureId);
    if (!PAR_MATIERE.includes(s.cycle ?? ''))
      throw new BadRequestException(
        'Les plages horaires par matière concernent les collèges et les lycées.',
      );
    const a = this.etab.annee();
    const r = this.reglages(s);
    const agents = (
      (await this.etab.agentsDe([structureId])).get(structureId) ?? []
    ).filter((x) => x.enseignant && x.enPoste);
    const agent = agents.find((x) => x.id === agentId);
    if (!agent)
      throw new BadRequestException(
        'Cet enseignant n’est pas en poste dans cette école.',
      );
    const classes = new Map(
      (
        await this.classes.find({ where: { structureId, anneeScolaire: a } })
      ).map((c) => [c.id, c]),
    );
    const nomJour = (j: number) => NOMS_JOURS_EDT[j] ?? `jour ${j}`;
    const HEURE = /^([01]\d|2[0-3]):[0-5]\d$/;
    const min = (h: string) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3));
    const propres: PlageEnseignant[] = [];
    for (const x of Array.isArray(plages) ? plages : []) {
      const p = x as Partial<PlageEnseignant>;
      const classe = classes.get(Number(p.classeId));
      const jour = Number(p.jour);
      const debut = String(p.debut ?? '').trim();
      // Sans heure de fin : celle du créneau qui commence à cette heure
      const fin =
        String(p.fin ?? '').trim() ||
        r.creneaux.find((c) => c.debut === debut)?.fin ||
        '';
      if (!classe)
        throw new BadRequestException(
          `Une plage porte sur une classe qui n’est pas ouverte en ${a} dans cette école.`,
        );
      if (!r.jours.includes(jour))
        throw new BadRequestException(
          `${nomJour(jour)} n’est pas un jour de cours de l’école.`,
        );
      if (!HEURE.test(debut) || !HEURE.test(fin))
        throw new BadRequestException(
          `${nomJour(jour)}, ${classe.nom} : écrivez l’heure de début et l’heure de fin comme 07:30 et 08:25.`,
        );
      const duree = min(fin) - min(debut);
      if (duree <= 0)
        throw new BadRequestException(
          `${nomJour(jour)} ${debut}-${fin} (${classe.nom}) : la fin doit être après le début.`,
        );
      if (duree < 15 || duree > 240)
        throw new BadRequestException(
          `${nomJour(jour)} ${debut}-${fin} (${classe.nom}) : un cours dure de 15 minutes à 4 heures.`,
        );
      if (debut < '06:00' || fin > '20:00')
        throw new BadRequestException(
          `${nomJour(jour)} ${debut}-${fin} (${classe.nom}) : les cours ont lieu entre 06:00 et 20:00.`,
        );
      const plage = { classeId: classe.id, jour, debut, fin };
      // Lui : deux classes à des heures qui se chevauchent
      const lui = propres.find(
        (q) => q.jour === jour && seChevauchent(q, plage),
      );
      if (lui)
        throw new BadRequestException(
          `${nomJour(jour)} : ${debut}-${fin} (${classe.nom}) chevauche sa plage ${lui.debut}-${lui.fin} (${classes.get(lui.classeId)?.nom ?? 'classe'}) : il ne peut pas être dans deux cours à la fois.`,
        );
      propres.push(plage);
    }
    // Une classe n'a qu'un enseignant à la fois : les plages des collègues sont vérifiées
    const collegues = await this.horaires.find({
      where: {
        agentId: In(
          agents.filter((x) => x.id !== agentId).map((x) => x.id).length
            ? agents.filter((x) => x.id !== agentId).map((x) => x.id)
            : [-1],
        ),
      },
    });
    for (const p of propres)
      for (const h of collegues) {
        const autre = (h.plages ?? []).find(
          (q) =>
            q.classeId === p.classeId &&
            q.jour === p.jour &&
            seChevauchent(q, p),
        );
        if (autre)
          throw new BadRequestException(
            `${nomJour(p.jour)} ${p.debut}-${p.fin} : la ${classes.get(p.classeId)!.nom} a déjà cours avec ${agents.find((x) => x.id === h.agentId)?.nomComplet ?? 'un autre enseignant'} de ${autre.debut} à ${autre.fin} : les heures se chevauchent.`,
          );
      }
    // Ses jours de présence suivent ses plages : chaque jour où il a cours, de la première à la
    // dernière heure ; sans plages, ses jours ne changent pas
    const h = await this.horaires.findOne({ where: { agentId } });
    let jours = h?.jours ?? {};
    if (propres.length) {
      jours = {};
      for (const p of propres) {
        const j = jours[String(p.jour)];
        jours[String(p.jour)] = {
          debut: !j?.debut || p.debut < j.debut ? p.debut : j.debut,
          fin: !j?.fin || p.fin > j.fin ? p.fin : j.fin,
        };
      }
    }
    await this.horaires.save({
      agentId,
      structureId,
      jours,
      plages: propres,
      modifiePar: u.nom,
    });
    await this.journal.log(
      u,
      'ECOLE_PLAGES_ENSEIGNANT',
      'agent_recense',
      agentId,
      { structureId, plages: propres.length },
    );
    // L'emploi du temps affiché reprend tout de suite les plages
    let regenere = false;
    if (classes.size && r.creneaux.length) {
      await this.generer(u, structureId, a);
      regenere = true;
    }
    return { plages: propres, jours, regenere };
  }

  /** Génère (ou regénère) l'emploi du temps de l'année à partir des classes et des enseignants. */
  async generer(u: UtilisateurConnecte, structureId: number, annee?: string) {
    const s = await this.etab.structure(u, structureId);
    if (!PAR_MATIERE.includes(s.cycle ?? ''))
      throw new BadRequestException(
        s.cycle
          ? 'Au préscolaire, au primaire et à l’alphabétisation, un maître fait toutes les matières de sa classe : pas d’emploi du temps par matière à générer.'
          : 'Indiquez d’abord le cycle de l’école dans l’organigramme (collège ou lycée).',
      );
    const a = this.etab.annee(annee);
    const r = this.reglages(s);
    if (!r.creneaux.length)
      throw new BadRequestException(
        'Aucun créneau de cours dans les paramètres (Administration › Paramètres › créneaux des emplois du temps).',
      );
    const { classes, prog, agents, horaires, heuresProgramme } =
      await this.situation(structureId, a, s.cycle!);
    if (!classes.length)
      throw new BadRequestException(
        `Aucune classe ouverte en ${a} : ouvrez d’abord les classes de l’école.`,
      );
    // Les plages à leurs heures réelles : le moteur les place sur les créneaux qu'elles touchent
    const enseignants: EnseignantEdt[] = agents.map((x) => ({
      id: x.id,
      nom: x.nomComplet,
      matiere: this.etab.matiereAgent(x, prog.matieres),
      horaire: horaires.get(x.id)?.jours ?? null,
      plages: (horaires.get(x.id)?.plages ?? []).map((p) => ({
        classeId: p.classeId,
        jour: p.jour,
        debut: p.debut,
        fin: p.fin,
      })),
    }));
    const res = genererEmploiDuTemps({
      classes: classes.map((c) => ({
        id: c.id,
        nom: c.nom,
        niveau: c.niveau,
        salleId: c.salleId,
      })),
      programme: prog.parNiveau,
      libelles: prog.matieres,
      enseignants,
      jours: r.jours,
      creneaux: r.creneaux,
      heuresEnseignant: r.heuresEnseignant,
    });
    const sansMatiere = enseignants.filter((x) => !x.matiere);
    if (sansMatiere.length)
      res.nonPlaces.unshift(
        ...sansMatiere.map((x) => ({
          classe: '—',
          matiere: '',
          matiereLibelle: x.nom,
          heures: 0,
          raison:
            'Enseignant sans spécialité reconnue : écrivez sa matière dans sa fiche pour lui donner des heures',
        })),
      );
    const e =
      (await this.edt.findOne({ where: { structureId, anneeScolaire: a } })) ??
      this.edt.create({ structureId, anneeScolaire: a });
    Object.assign(e, {
      jours: r.jours,
      creneaux: r.creneaux,
      seances: res.seances,
      nonPlaces: res.nonPlaces,
      charges: res.charges,
      heuresTotal: res.heuresTotal,
      heuresPlacees: res.heuresPlacees,
      heuresProgramme,
      generePar: u.nom,
    });
    const sauve = await this.edt.save(e);
    await this.journal.log(
      u,
      'ECOLE_EMPLOI_DU_TEMPS',
      'structure',
      structureId,
      {
        annee: a,
        classes: classes.length,
        heures: res.heuresTotal,
        placees: res.heuresPlacees,
      },
    );
    return sauve;
  }
}
