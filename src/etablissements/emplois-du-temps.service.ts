import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { JournalService, ParametresService } from '../core/core.service';
import { Classe, EmploiDuTemps, HoraireAgent } from '../entities';
import {
  genererEmploiDuTemps,
  lireCreneaux,
  type EnseignantEdt,
} from './emploi-du-temps-regles';
import { EtablissementsService } from './etablissements.service';

/** Cycles qui ont un emploi du temps par matière (au primaire, un maître par classe). */
const PAR_MATIERE = ['COLLEGE', 'LYCEE'];

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
    private readonly etab: EtablissementsService,
    private readonly params: ParametresService,
    private readonly journal: JournalService,
  ) {}

  private reglages() {
    const jours = this.params
      .get('EDT_JOURS')
      .split(/[,; ]+/)
      .map(Number)
      .filter((j) => Number.isInteger(j) && j >= 1 && j <= 6);
    const creneaux = lireCreneaux(this.params.get('EDT_CRENEAUX'));
    return {
      jours: jours.length ? [...new Set(jours)].sort() : [1, 2, 3, 4, 5],
      creneaux,
      heuresEnseignant: Number(this.params.get('HEURES_ENSEIGNANT')) || 20,
    };
  }

  /** L'emploi du temps enregistré de l'année (ou rien), avec les réglages. */
  async lire(u: UtilisateurConnecte, structureId: number, annee?: string) {
    const s = await this.etab.structure(u, structureId);
    const a = this.etab.annee(annee);
    const e = await this.edt.findOne({
      where: { structureId, anneeScolaire: a },
    });
    return {
      structure: { id: s.id, nom: s.nom, cycle: s.cycle },
      annee: a,
      parMatiere: PAR_MATIERE.includes(s.cycle ?? ''),
      reglages: this.reglages(),
      emploi: e,
    };
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
    const r = this.reglages();
    if (!r.creneaux.length)
      throw new BadRequestException(
        'Aucun créneau de cours dans les paramètres (Administration › Paramètres › créneaux des emplois du temps).',
      );
    const classes = await this.classes.find({
      where: { structureId, anneeScolaire: a },
      order: { nom: 'ASC' },
    });
    if (!classes.length)
      throw new BadRequestException(
        `Aucune classe ouverte en ${a} : ouvrez d’abord les classes de l’école.`,
      );
    const prog = await this.etab.programmes(s.cycle!);
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
      ).map((h) => [h.agentId, h.jours]),
    );
    const enseignants: EnseignantEdt[] = agents.map((x) => ({
      id: x.id,
      nom: x.nomComplet,
      matiere: this.etab.matiereDe(x.specialite, prog.matieres),
      horaire: horaires.get(x.id) ?? null,
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
