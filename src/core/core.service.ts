import { sqlLibelleLot } from '../common/lots';
import { rechiffrerCode } from '../common/code-personnel';
import {
  BadRequestException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { Repository } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { DEPARTEMENTS } from '../common/referentiels';
import { Departement, Journal, Parametre, Utilisateur } from '../entities';

/** Paramètres numériques : [minimum, maximum, consigne affichée en cas d'erreur]. */
const PARAMETRES_ENTIERS: Record<string, [number, number, string]> = {
  CONTRACTUEL_AGE_LIMITE: [18, 70, 'un âge entre 18 et 70 ans'],
  CONTRACTUEL_AGE_LIMITE_CAT_I: [18, 70, 'un âge entre 18 et 70 ans'],
  AGE_MINIMUM: [14, 40, 'un âge entre 14 et 40 ans'],
  AGE_MAXIMUM: [25, 70, 'un âge entre 25 et 70 ans'],
  TAILLE_LOT_COMMISSION: [1, 1000, 'un nombre de dossiers entre 1 et 1000'],
  POINT_INDICIAIRE: [1, 100000, 'un montant en FCFA (nombre entier)'],
  HEURES_ENSEIGNANT: [1, 40, 'un nombre d’heures entre 1 et 40'],
  HEURES_ENSEIGNANT_LYCEE: [1, 40, 'un nombre d’heures entre 1 et 40'],
};

export const PARAMETRES_DEFAUT: Record<string, [string, string]> = {
  ANNEE_SCOLAIRE: ['2026-2027', 'Année scolaire mentionnée dans les notes'],
  ANNEE_SCOLAIRE_MUTATION: [
    '',
    'Année scolaire des notes de mutation (vide : la même que ci-dessus). Les notes pas encore validées la reprennent.',
  ],
  CAMPAGNE_RECRUTEMENT: [
    '2024-2025',
    'Campagne de recrutement inscrite sur la liste envoyée à la Fonction Publique',
  ],
  CONTRACTUEL_AGE_LIMITE: [
    '30',
    'Catégories II et III (du CEPE au BAC) : au-delà de cet âge révolu, l’agent est contractuel',
  ],
  CONTRACTUEL_AGE_LIMITE_CAT_I: [
    '35',
    'Catégorie I (BTS, licence, master) : au-delà de cet âge révolu, l’agent est contractuel',
  ],
  AGE_MINIMUM: [
    '18',
    'Âge minimum (révolu) à la date de dépôt du dossier : en dessous, le dossier est refusé',
  ],
  AGE_MAXIMUM: [
    '45',
    'Âge maximum (dérogation) : au-delà, le dossier part en contentieux et attend la décision du DG',
  ],
  TAILLE_LOT_COMMISSION: [
    '50',
    'Nombre maximum de dossiers dans un lot de la commission',
  ],
  POINT_INDICIAIRE: [
    '300',
    'Point indiciaire : salaire brut = indice × point indiciaire',
  ],
  EDT_JOURS: [
    '1,2,3,4,5,6',
    'Emplois du temps : jours de cours (1 = lundi … 6 = samedi ; le samedi, la matinée seulement)',
  ],
  EDT_CRENEAUX: [
    '07:30-08:25, 08:25-09:20, 09:20-10:15, 10:30-11:25, 11:25-12:20, 12:20-13:15, 15:00-15:55, 15:55-16:50, 16:50-17:45',
    'Emplois du temps : créneaux d’une heure de cours (début-fin, séparés par des virgules) ; avant 13 h, le matin (vague A), après, l’après-midi (vague B)',
  ],
  HEURES_ENSEIGNANT: [
    '20',
    'Heures de cours par semaine d’un enseignant du collège : les heures des classes divisées par ce nombre donnent les enseignants nécessaires',
  ],
  HEURES_ENSEIGNANT_LYCEE: [
    '15',
    'Heures de cours par semaine d’un enseignant du lycée : les heures des classes divisées par ce nombre donnent les enseignants nécessaires',
  ],
  MENTION_BOURSE_ENROLEMENT: [
    "Les intéressés percevront une bourse mensuelle conformément au protocole d'accord du 16 octobre 2023, passé entre le Gouvernement de la République et la Coordination des Diplômés des Ecoles Professionnelles de l'Enseignement, assistée par les syndicats des enseignants et l'Association des Parents d'Elèves et Etudiants du Congo (APEEC).",
    'Notes d’enrôlement : phrase sur la bourse des volontaires (après les tableaux)',
  ],
  SIGNATAIRE_TITRE: ['Le Ministre,', 'Titre du signataire des notes'],
  SIGNATAIRE_NOM: ['Jean-Luc MOUTHOU', 'Nom du signataire des notes'],
  LIEU_SIGNATURE: ['Brazzaville', 'Lieu de signature (« Fait à … »)'],
  // Le numéro dit le chemin de la note, du cabinet au service qui l'a initiée (DG, 24/10/2026 :
  // le Service de recrutement à la fin)
  REFERENCE_NOTE: [
    'MEPPSA-CAB-DGRHAS-DRSC-SR',
    'Suffixe du numéro de note : le chemin hiérarchique, du cabinet au service qui a initié la note',
  ],
  PIED_PAGE_DROITE: [
    'MEPPSA {an}',
    'Mention en bas à droite des notes ({an} = année d’édition)',
  ],
  SIGNATAIRE_LISTE_TITRE: [
    'La Directrice de Cabinet,',
    'Titre du signataire des listes envoyées à la Fonction Publique',
  ],
  SIGNATAIRE_LISTE_NOM: [
    'Régine TCHICAYA-OBOA',
    'Nom du signataire des listes envoyées à la Fonction Publique',
  ],
  DG_TITRE: [
    'Le Directeur général,',
    'Titre du signataire de la fiche de demande (seule signature, avant l’envoi au Ministre)',
  ],
  DG_NOM: [
    '',
    'Nom du Directeur général imprimé sous sa signature (vide : le nom du compte qui a décidé)',
  ],
  SOIT_TRANSMIS_DESTINATAIRE: [
    'Monsieur le Directeur de Cabinet du Ministre d’Etat, Ministre de la Fonction Publique, du Travail et du Dialogue social',
    'Destinataire du soit-transmis qui accompagne chaque transmission à la FP',
  ],
  SOIT_TRANSMIS_REFERENCE: [
    'MEPPSA-CAB-DGRHAS-DRSC',
    'Suffixe du numéro du soit-transmis (le numéro est donné par le Cabinet)',
  ],
  SOIT_TRANSMIS_APPEL: [
    'Monsieur le Directeur de Cabinet et cher collègue,',
    'Formule d’appel du soit-transmis',
  ],
  ADRESSE_PIED: [
    'Contacts : BP : 169 avenue des 1ers Jeux Africains, face Stade Marchand Brazzaville',
    'Adresse imprimée en pied de page',
  ],
};

@Injectable()
export class JournalService {
  constructor(
    @InjectRepository(Journal) private readonly repo: Repository<Journal>,
  ) {}

  async log(
    u: UtilisateurConnecte | null,
    action: string,
    entite?: string,
    entiteId?: string | number | null,
    details?: unknown,
  ) {
    await this.repo.insert({
      utilisateurId: u?.id ?? null,
      utilisateurNom: u?.nom ?? null,
      action,
      entite: entite ?? null,
      entiteId: entiteId != null ? String(entiteId) : null,
      details: (details ?? null) as object,
    });
  }

  async liste(limite = 200, entite?: string, entiteId?: string) {
    const where: Record<string, string> = {};
    if (entite) where.entite = entite;
    if (entiteId) where.entiteId = entiteId;
    const lignes = await this.repo.find({
      where,
      order: { date: 'DESC' },
      take: limite,
    });
    const objets = await this.libellesObjets(lignes);
    return lignes.map((l) => ({
      ...l,
      objet:
        (l.entite && l.entiteId && objets.get(`${l.entite}|${l.entiteId}`)) ??
        null,
    }));
  }

  /** Nom lisible de la personne, du lot ou de la note concernée par chaque action. */
  private async libellesObjets(lignes: Journal[]) {
    const ids = (entite: string) => [
      ...new Set(
        lignes
          .filter((l) => l.entite === entite && l.entiteId)
          .map((l) => l.entiteId!),
      ),
    ];
    const res = new Map<string, string>();
    const charger = async (entite: string, sql: string, numerique = false) => {
      const liste = ids(entite);
      if (!liste.length) return;
      const valeurs = numerique
        ? liste.map(Number).filter(Number.isFinite)
        : liste;
      const rangs = await this.repo.query<{ id: string; libelle: string }[]>(
        sql,
        [valeurs],
      );
      for (const r of rangs) res.set(`${entite}|${r.id}`, r.libelle);
    };
    await charger(
      'agent',
      `SELECT id::text, "nomComplet" AS libelle FROM agent WHERE id = ANY($1::uuid[])`,
    );
    await charger(
      'affectation',
      `SELECT f.id::text, a."nomComplet" AS libelle FROM affectation f JOIN agent a ON a.id = f."agentId" WHERE f.id = ANY($1::uuid[])`,
    );
    await charger(
      'demande_mutation',
      `SELECT id::text, "nomComplet" AS libelle FROM demande_mutation WHERE id = ANY($1::uuid[])`,
    );
    await charger(
      'lot_publication',
      `SELECT id::text, ${sqlLibelleLot('lot_publication')} AS libelle FROM lot_publication WHERE id = ANY($1::int[])`,
      true,
    );
    await charger(
      'utilisateur',
      `SELECT id::text, nom AS libelle FROM utilisateur WHERE id = ANY($1::uuid[])`,
    );
    await charger(
      'note_service',
      `SELECT n.id::text, 'Note ' || CASE WHEN n.module = 'AFFECTATION' THEN 'd''affectation' ELSE 'de mutation' END
         || COALESCE(' – ' || ${sqlLibelleLot('l')}, '') || COALESCE(' n° ' || n.numero, '') AS libelle
       FROM note_service n LEFT JOIN lot_publication l ON l.id = n."lotPublicationId" WHERE n.id = ANY($1::uuid[])`,
    );
    return res;
  }
}

@Injectable()
export class ParametresService {
  private cache = new Map<string, string>();

  constructor(
    @InjectRepository(Parametre) private readonly repo: Repository<Parametre>,
  ) {}

  async charger() {
    const tous = await this.repo.find();
    this.cache = new Map(tous.map((p) => [p.cle, p.valeur]));
    await this.miseAJourReference();
  }

  /**
   * Numéro des notes (DG, 24/10/2026) : le suffixe va jusqu'au service qui a initié la note, le
   * Service de recrutement. Une seule fois : un suffixe enregistré tel quel (l'ancien par défaut)
   * reçoit « -SR » ; un suffixe que le DG a écrit autrement est gardé.
   */
  private async miseAJourReference() {
    const MARQUE = 'MIGRATION_REFERENCE_SR_20261024';
    if (this.cache.has(MARQUE)) return;
    if (this.cache.get('REFERENCE_NOTE') === 'MEPPSA-CAB-DGRHAS-DRSC') {
      await this.repo.update(
        { cle: 'REFERENCE_NOTE' },
        { valeur: PARAMETRES_DEFAUT.REFERENCE_NOTE[0] },
      );
      this.cache.set('REFERENCE_NOTE', PARAMETRES_DEFAUT.REFERENCE_NOTE[0]);
    }
    await this.repo.save({
      cle: MARQUE,
      valeur: new Date().toISOString(),
      description: 'Suffixe des notes complété par le Service de recrutement',
    });
    this.cache.set(MARQUE, 'fait');
  }

  get(cle: string): string {
    return this.cache.get(cle) ?? PARAMETRES_DEFAUT[cle]?.[0] ?? '';
  }

  tous() {
    return Object.entries(PARAMETRES_DEFAUT).map(
      ([cle, [defaut, description]]) => ({
        cle,
        valeur: this.cache.get(cle) ?? defaut,
        description,
      }),
    );
  }

  /** Refuse une valeur qui fausserait les notes ou les calculs (message lisible pour l'utilisateur). */
  verifier(cle: string, valeur: string) {
    if (!PARAMETRES_DEFAUT[cle])
      throw new BadRequestException('Paramètre inconnu');
    if (
      cle === 'ANNEE_SCOLAIRE' ||
      (cle === 'ANNEE_SCOLAIRE_MUTATION' && valeur)
    ) {
      const an = /^(\d{4})-(\d{4})$/.exec(valeur);
      if (!an || Number(an[2]) !== Number(an[1]) + 1)
        throw new BadRequestException(
          'Écrivez l’année scolaire sous la forme « 2027-2028 » (deux années qui se suivent).',
        );
      return;
    }
    // Emplois du temps : des jours de 1 à 6, des créneaux « 07:30-08:25 » qui se suivent
    if (cle === 'EDT_JOURS') {
      const j = valeur.split(/[,; ]+/).filter(Boolean);
      if (!j.length || j.some((x) => !/^[1-6]$/.test(x)))
        throw new BadRequestException(
          'Écrivez les jours de cours avec des chiffres de 1 (lundi) à 6 (samedi), séparés par des virgules : 1,2,3,4,5,6.',
        );
      return;
    }
    if (cle === 'EDT_CRENEAUX') {
      const morceaux = valeur
        .split(/[,;\n]+/)
        .map((x) => x.trim())
        .filter(Boolean);
      const faux = morceaux.find(
        (x) => !/^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/.test(x),
      );
      if (!morceaux.length || faux)
        throw new BadRequestException(
          `Créneau « ${faux ?? ''} » mal écrit : écrivez chaque heure de cours comme 07:30-08:25, séparées par des virgules.`,
        );
      return;
    }
    const borne = PARAMETRES_ENTIERS[cle];
    if (borne) {
      const n = Number(valeur);
      if (!/^\d+$/.test(valeur) || n < borne[0] || n > borne[1])
        throw new BadRequestException(`Valeur refusée : écrivez ${borne[2]}.`);
      const min = cle === 'AGE_MINIMUM' ? n : Number(this.get('AGE_MINIMUM'));
      const max = cle === 'AGE_MAXIMUM' ? n : Number(this.get('AGE_MAXIMUM'));
      if (min >= max)
        throw new BadRequestException(
          `L’âge minimum (${min} ans) doit rester inférieur à l’âge maximum (${max} ans).`,
        );
      return;
    }
    if (!valeur && !['DG_NOM', 'ANNEE_SCOLAIRE_MUTATION'].includes(cle))
      throw new BadRequestException('Ce paramètre ne peut pas rester vide.');
  }

  async definir(cle: string, valeur: string) {
    // « 1 500 000 » ou « 1.500.000 » → 1500000
    if (PARAMETRES_ENTIERS[cle]) valeur = valeur.replace(/[\s.]/g, '');
    this.verifier(cle, valeur);
    await this.repo.save({
      cle,
      valeur,
      description: PARAMETRES_DEFAUT[cle]?.[1] ?? null,
    });
    this.cache.set(cle, valeur);
  }
}

/** Initialise les référentiels et le premier administrateur au démarrage. */
@Injectable()
export class InitialisationService implements OnApplicationBootstrap {
  private readonly logger = new Logger('Initialisation');

  constructor(
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    @InjectRepository(Utilisateur)
    private readonly users: Repository<Utilisateur>,
    private readonly params: ParametresService,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap() {
    for (const [i, d] of DEPARTEMENTS.entries()) {
      const ex = await this.deps.findOne({ where: { code: d.code } });
      if (!ex) await this.deps.insert({ ...d, ordre: i + 1 });
    }
    // Les diplômes et les grades sont mis en place par ConfigurationService.

    await this.params.charger();

    if ((await this.users.count()) === 0) {
      const email = this.config.get<string>('ADMIN_EMAIL');
      const mdp = this.config.get<string>('ADMIN_PASSWORD');
      if (email && mdp) {
        await this.users.insert({
          email: email.trim().toLowerCase(),
          nom: 'Administrateur',
          initiales: 'ADM',
          role: 'ADMIN',
          motDePasseHash: await bcrypt.hash(mdp, 10),
        });
        this.logger.log(`Administrateur initial créé : ${email}`);
      } else {
        this.logger.warn(
          'Aucun utilisateur : définissez ADMIN_EMAIL et ADMIN_PASSWORD',
        );
      }
    }

    // CODE_SECRET ajouté : les codes encore chiffrés avec l'ancienne clé passent sur la nouvelle
    if (process.env.CODE_SECRET) {
      const avecCode = await this.users
        .createQueryBuilder('u')
        .select(['u.id', 'u.codeChiffre'])
        .where('u.codeChiffre IS NOT NULL')
        .getMany();
      let n = 0;
      for (const u of avecCode) {
        const nouveau = rechiffrerCode(u.codeChiffre!);
        if (nouveau) {
          await this.users.update(u.id, { codeChiffre: nouveau });
          n++;
        }
      }
      if (n)
        this.logger.log(
          `${n} code(s) personnel(s) re-chiffré(s) avec CODE_SECRET`,
        );
    }
  }
}
