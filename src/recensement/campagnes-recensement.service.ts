import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { JournalService } from '../core/core.service';
import { CampagneRecensement } from '../entities';

/**
 * Les recensements (DG, 22/11/2026) : « on ouvre un recensement, on donne son nom, l'année, l'année
 * scolaire, la date de début et de fin facultative ; ça permet de bien ranger et de savoir que les
 * données proviennent de tel recensement ».
 *
 * Un seul recensement est ouvert à la fois : tout ce que le recensement produit pendant qu'il est
 * ouvert (agents ajoutés, fiches modifiées, signalements du terrain, recenseurs créés) porte son
 * numéro. Sans recensement ouvert, le travail continue, simplement sans rangement.
 */

export interface SaisieCampagne {
  nom?: string;
  annee?: number | string;
  anneeScolaire?: string | null;
  debut?: string;
  fin?: string | null;
  observation?: string | null;
}

const JOUR = /^\d{4}-\d{2}-\d{2}$/;

@Injectable()
export class CampagnesRecensementService {
  constructor(
    private readonly ds: DataSource,
    private readonly journal: JournalService,
  ) {}

  private get repo() {
    return this.ds.getRepository(CampagneRecensement);
  }

  /** Le recensement ouvert (le plus récent s'il y en avait plusieurs), ou rien. */
  async ouverte(): Promise<{ id: number; nom: string } | null> {
    const [c] = await this.ds.query<{ id: number; nom: string }[]>(
      `SELECT id, nom FROM campagne_recensement WHERE "clotureLe" IS NULL ORDER BY debut DESC, id DESC LIMIT 1`,
    );
    return c ?? null;
  }

  /** Les recensements, du plus récent au plus ancien, avec ce que chacun a produit. */
  async liste() {
    const lignes = await this.ds.query<
      (CampagneRecensement & {
        recenseurs: number;
        ajoutes: number;
        modifications: number;
        aControler: number;
        signalements: number;
      })[]
    >(
      `SELECT c.*,
              (SELECT count(*) FROM recenseur r WHERE r."campagneId" = c.id)::int AS recenseurs,
              (SELECT count(*) FROM agent_recense a WHERE a."campagneRecensementId" = c.id)::int AS ajoutes,
              (SELECT count(*) FROM modification_recensement m WHERE m."campagneId" = c.id)::int AS modifications,
              (SELECT count(*) FROM modification_recensement m WHERE m."campagneId" = c.id AND m.etat = 'A_CONTROLER')::int AS "aControler",
              (SELECT count(*) FROM signalement_terrain g WHERE g."campagneId" = c.id)::int AS signalements
         FROM campagne_recensement c
        ORDER BY c."clotureLe" IS NULL DESC, c.debut DESC, c.id DESC`,
    );
    return { lignes, ouverte: await this.ouverte() };
  }

  private propre(s: SaisieCampagne, ancien?: CampagneRecensement) {
    const nom = String(s.nom ?? ancien?.nom ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 150);
    if (nom.length < 3)
      throw new BadRequestException(
        'Donnez un nom au recensement (ex. « Recensement général du personnel 2026 »).',
      );
    const annee = Number(s.annee ?? ancien?.annee);
    if (!Number.isInteger(annee) || annee < 2000 || annee > 2100)
      throw new BadRequestException('Année du recensement invalide.');
    let anneeScolaire =
      s.anneeScolaire === undefined
        ? (ancien?.anneeScolaire ?? null)
        : String(s.anneeScolaire ?? '').trim() || null;
    if (anneeScolaire) {
      const m = /^(\d{4})\s*[-/–]\s*(\d{4})$/.exec(anneeScolaire);
      if (!m || Number(m[2]) !== Number(m[1]) + 1)
        throw new BadRequestException(
          'Année scolaire attendue sous la forme 2026-2027.',
        );
      anneeScolaire = `${m[1]}-${m[2]}`;
    }
    const debut = String(s.debut ?? ancien?.debut ?? '');
    if (!JOUR.test(debut))
      throw new BadRequestException('Date de début du recensement attendue.');
    const fin =
      s.fin === undefined
        ? (ancien?.fin ?? null)
        : String(s.fin ?? '').trim() || null;
    if (fin && !JOUR.test(fin))
      throw new BadRequestException('Date de fin invalide.');
    if (fin && fin < debut)
      throw new BadRequestException(
        'La date de fin est avant la date de début.',
      );
    const observation =
      s.observation === undefined
        ? (ancien?.observation ?? null)
        : String(s.observation ?? '')
            .trim()
            .slice(0, 1000) || null;
    return { nom, annee, anneeScolaire, debut, fin, observation };
  }

  /** Ouvrir un recensement (un seul ouvert à la fois). */
  async creer(u: UtilisateurConnecte, s: SaisieCampagne) {
    const deja = await this.ouverte();
    if (deja)
      throw new BadRequestException(
        `Le recensement « ${deja.nom} » est encore ouvert : clôturez-le d’abord (un seul recensement ouvert à la fois, pour que chaque donnée soit rangée sous un seul).`,
      );
    const c = await this.repo.save(
      this.repo.create({ ...this.propre(s), creePar: u.nom }),
    );
    await this.journal.log(
      u,
      'RECENSEMENT_OUVERT',
      'campagne_recensement',
      String(c.id),
      { nom: c.nom, annee: c.annee, anneeScolaire: c.anneeScolaire },
    );
    return c;
  }

  async modifier(u: UtilisateurConnecte, id: number, s: SaisieCampagne) {
    const c = await this.repo.findOne({ where: { id } });
    if (!c) throw new NotFoundException('Recensement introuvable.');
    Object.assign(c, this.propre(s, c));
    await this.repo.save(c);
    await this.journal.log(
      u,
      'RECENSEMENT_MODIFIE',
      'campagne_recensement',
      String(id),
      { nom: c.nom },
    );
    return c;
  }

  /** Clôturer (plus rien ne s'y range) ou rouvrir (si aucun autre n'est ouvert). */
  async cloturer(u: UtilisateurConnecte, id: number, cloture: boolean) {
    const c = await this.repo.findOne({ where: { id } });
    if (!c) throw new NotFoundException('Recensement introuvable.');
    if (!cloture) {
      const deja = await this.ouverte();
      if (deja && deja.id !== id)
        throw new BadRequestException(
          `Le recensement « ${deja.nom} » est ouvert : clôturez-le d’abord.`,
        );
    }
    c.clotureLe = cloture ? new Date() : null;
    await this.repo.save(c);
    await this.journal.log(
      u,
      cloture ? 'RECENSEMENT_CLOTURE' : 'RECENSEMENT_ROUVERT',
      'campagne_recensement',
      String(id),
      { nom: c.nom },
    );
    return c;
  }
}
