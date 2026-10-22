import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { champ, lireClasseur } from '../common/excel';
import { lireDate, nettoyer, normaliser } from '../common/texte';
import { JournalService } from '../core/core.service';
import { StockageService } from '../common/stockage';
import { Agent, AncienRecrute, OrigineDossier, PieceJointe } from '../entities';

/** Origines relevées dans les fichiers de la DGRHAS (le DG complète la liste). */
const ORIGINES_DEPART = [
  'Liste du Ministre',
  'Cabinet du Ministre',
  'Direction de Cabinet',
  'Primature',
  'IGEPSA',
  'DGRHAS',
  'DRSC',
  'DDEPPSA du département',
  'Syndicats',
  'Dossier déposé directement',
];

/** Origines des dossiers, anciens recrutés (doublons entre années), scans des textes. */
@Injectable()
export class ComplementsService implements OnModuleInit {
  constructor(
    @InjectRepository(OrigineDossier)
    private readonly origines: Repository<OrigineDossier>,
    @InjectRepository(AncienRecrute)
    private readonly anciens: Repository<AncienRecrute>,
    @InjectRepository(PieceJointe)
    private readonly pieces: Repository<PieceJointe>,
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
    private readonly journal: JournalService,
    private readonly stockage: StockageService,
  ) {}

  async onModuleInit() {
    if (!(await this.origines.count()))
      await this.origines.save(
        ORIGINES_DEPART.map((libelle, i) => ({ libelle, ordre: i + 1 })),
      );
  }

  /* ------------------------------ Origines ------------------------------ */

  listeOrigines(toutes = false) {
    return this.origines.find({
      where: toutes ? {} : { actif: true },
      order: { ordre: 'ASC', libelle: 'ASC' },
    });
  }

  async enregistrerOrigine(
    u: UtilisateurConnecte,
    id: number | null,
    dto: { libelle: string; actif?: boolean },
  ) {
    const libelle = dto.libelle?.replace(/\s+/g, ' ').trim();
    if (!libelle) throw new BadRequestException('Écrivez l’origine.');
    const meme = await this.origines.findOne({ where: { libelle } });
    if (meme && meme.id !== id)
      throw new BadRequestException('Cette origine est déjà dans la liste.');
    const o = id
      ? await this.origines.save({
          ...(await this.origines.findOneOrFail({ where: { id } })),
          libelle,
          actif: dto.actif ?? true,
        })
      : await this.origines.save({
          libelle,
          ordre: (await this.origines.count()) + 1,
        });
    await this.journal.log(u, 'ORIGINE_DOSSIER', 'origine', String(o.id), {
      libelle,
      actif: o.actif,
    });
    return o;
  }

  async supprimerOrigine(u: UtilisateurConnecte, id: number) {
    const o = await this.origines.findOne({ where: { id } });
    if (!o) throw new NotFoundException('Origine introuvable');
    await this.origines.delete(id);
    await this.journal.log(
      u,
      'ORIGINE_DOSSIER_SUPPRIMEE',
      'origine',
      String(id),
      {
        libelle: o.libelle,
      },
    );
    return { ok: true };
  }

  /* ------------------ Anciens recrutés (doublons entre années) ------------------ */

  async resumeAnciens() {
    return this.anciens.query<
      {
        source: string;
        annee: number | null;
        n: number;
        importePar: string;
        le: string;
      }[]
    >(`SELECT source, annee, count(*)::int AS n, max("importePar") AS "importePar",
         max("creeLe")::date::text AS le
       FROM ancien_recrute GROUP BY 1, 2 ORDER BY 2 DESC NULLS LAST, 1`);
  }

  /**
   * Lit un fichier Excel d'une année passée (toutes les feuilles avec « Noms et prénoms »).
   * L'année vient de la colonne « Quota »/« Année », sinon du nom de la feuille ou du
   * fichier (« Liste générale R.2021 »), sinon de l'année choisie.
   */
  async importerAnciens(
    u: UtilisateurConnecte,
    contenu: Buffer,
    nomFichier: string,
    anneeChoisie: number | null,
  ) {
    const feuilles = await lireClasseur(contenu, ['NOMSETPRENOMS'], {
      inclureMasquees: true,
    });
    if (!feuilles.length)
      throw new BadRequestException(
        'Aucune feuille avec la colonne « Noms et prénoms » n’a été trouvée.',
      );
    const annee = (t: string) => {
      const m = /20[12]\d/.exec(t);
      return m ? Number(m[0]) : null;
    };
    const fichier = nomFichier.replace(/\.xlsx$/i, '');
    const vus = new Set<string>();
    const lignes: Partial<AncienRecrute>[] = [];
    let sansAnnee = 0;
    for (const f of feuilles)
      for (const l of f.lignes) {
        const nom = nettoyer(champ(l, 'NOMSETPRENOMS'));
        if (!nom) continue;
        const valeur = champ(l, 'QUOTA', 'ANNEE', 'RECRUTEMENT');
        const colonne =
          typeof valeur === 'number'
            ? valeur
            : Number(/^\d{4}$/.exec(nettoyer(valeur) ?? '')?.[0]);
        const an =
          (colonne >= 2000 && colonne <= 2100 ? colonne : null) ??
          annee(f.nom) ??
          annee(fichier) ??
          anneeChoisie;
        if (!an) sansAnnee++;
        const dateNaissance = lireDate(champ(l, 'DATEDENAIS'));
        const nomNormalise = normaliser(nom);
        const cle = `${nomNormalise}|${dateNaissance}|${an}`;
        if (vus.has(cle)) continue;
        vus.add(cle);
        lignes.push({
          nomComplet: nom,
          nomNormalise,
          dateNaissance,
          annee: an,
          source: `${fichier} › ${f.nom}`.slice(0, 250),
          diplome: nettoyer(champ(l, 'DIPLOME')),
          importePar: u.nom,
        });
      }
    // Réimporter le même fichier remplace ses lignes
    const sources = [...new Set(lignes.map((x) => x.source!))];
    for (const s of sources) await this.anciens.delete({ source: s });
    for (let i = 0; i < lignes.length; i += 1000)
      await this.anciens.insert(lignes.slice(i, i + 1000));
    await this.journal.log(
      u,
      'IMPORT_ANCIENS_RECRUTES',
      'ancien_recrute',
      null,
      {
        fichier: nomFichier,
        lignes: lignes.length,
        feuilles: sources.length,
      },
    );
    return { lignes: lignes.length, feuilles: sources, sansAnnee };
  }

  async supprimerSource(u: UtilisateurConnecte, source: string) {
    const r = await this.anciens.delete({ source });
    await this.journal.log(
      u,
      'SUPPRESSION_ANCIENS_RECRUTES',
      'ancien_recrute',
      null,
      {
        source,
        lignes: r.affected ?? 0,
      },
    );
    return { supprimees: r.affected ?? 0 };
  }

  /** Anciens recrutés au même nom (mots du nom) : pour l'alerte de doublon à la saisie. */
  async anciensProches(nomNormalise: string) {
    const mots = nomNormalise.split(' ').filter((m) => m.length >= 2);
    if (!mots.length) return [];
    const q = this.anciens.createQueryBuilder('x');
    mots.forEach((m, i) =>
      q.andWhere(`x.nomNormalise LIKE :m${i}`, { [`m${i}`]: `%${m}%` }),
    );
    return q.take(20).getMany();
  }

  /* ------------------------- Scans des textes ------------------------- */

  piecesDe(agentId: string) {
    return this.pieces.find({ where: { agentId }, order: { creeLe: 'DESC' } });
  }

  async ajouterPiece(
    u: UtilisateurConnecte,
    agentId: string,
    f: Express.Multer.File,
    nature: string,
    legalise: boolean,
  ) {
    if (!(await this.agents.exist({ where: { id: agentId } }))) {
      await this.stockage.supprimer('pieces', f.filename);
      throw new NotFoundException('Dossier introuvable');
    }
    const p = await this.pieces.save({
      agentId,
      nature: nature === 'AUTRE' ? 'AUTRE' : 'TEXTE',
      legalise,
      nomOrigine: f.originalname.slice(0, 200),
      fichier: f.filename,
      mime: f.mimetype,
      taille: f.size,
      ajoutePar: u.nom,
    });
    await this.journal.log(u, 'AJOUT_PIECE', 'agent', agentId, {
      nature: p.nature,
      legalise,
    });
    return p;
  }

  async piece(agentId: string, id: string) {
    const p = await this.pieces.findOne({ where: { id, agentId } });
    if (!p) throw new NotFoundException('Pièce introuvable');
    return p;
  }

  async modifierPiece(
    u: UtilisateurConnecte,
    agentId: string,
    id: string,
    legalise: boolean,
  ) {
    const p = await this.piece(agentId, id);
    await this.pieces.update(p.id, { legalise });
    await this.journal.log(u, 'MODIFICATION_PIECE', 'agent', agentId, {
      legalise,
    });
    return { ...p, legalise };
  }

  async supprimerPiece(u: UtilisateurConnecte, agentId: string, id: string) {
    const p = await this.piece(agentId, id);
    await this.pieces.delete(p.id);
    await this.stockage.supprimer('pieces', p.fichier);
    await this.journal.log(u, 'SUPPRESSION_PIECE', 'agent', agentId, {
      nature: p.nature,
    });
    return { ok: true };
  }
}
