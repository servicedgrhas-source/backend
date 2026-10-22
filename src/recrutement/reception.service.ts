import { AnomaliesService } from '../common/anomalies';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ImportBaseService } from '../affectation/import.service';
import { LotsReceptionService } from '../affectation/lots-reception.service';
import { libelleLot, sqlLibelleLot } from '../common/lots';
import type { UtilisateurConnecte } from '../auth/auth';
import { champ, lireClasseur } from '../common/excel';
import {
  codeDepartement,
  LIBELLE_CYCLE,
  reconnaitreDiplome,
  type Cycle,
} from '../common/referentiels';
import { motsDuNom, ressemblance } from '../common/ressemblance';
import { cleCompacte, lireDate, nettoyer, normaliser } from '../common/texte';
import { JournalService } from '../core/core.service';
import {
  Affectation,
  Agent,
  Departement,
  LotPublication,
  RegleDiplome,
} from '../entities';

/** Personne d'un texte de la FP absente de la base : elle relève du quota « Autres ». */
export interface QuotaAutresDto {
  nomComplet: string;
  dateNaissance?: string | null;
  lieuNaissance?: string | null;
  diplomeCode: string;
  departementId?: number | null;
  lieuServiceBrut?: string | null;
  quota?: number | null;
  origineBrute?: string | null;
  observation?: string | null;
}

export interface TexteRecuDto {
  /** Date de réception = le paquet ; le lot se déduit du quota et du type de chaque personne. */
  dateReception: string;
  typeTexte: 'ARRETE' | 'DECRET';
  numeroTexte: string;
  dateSignature?: string | null;
  /** Statut écrit sur le texte : AGE = calcul automatique selon l'âge. */
  statutTexte?: 'AGE' | 'FONCTIONNAIRE' | 'CONTRACTUEL';
  agentIds: string[];
}

const NOM_TYPE = { ARRETE: 'Arrêté', DECRET: 'Décret' } as const;

type StatutTexte = 'AGE' | 'FONCTIONNAIRE' | 'CONTRACTUEL';

/**
 * Ligne du fichier Excel renvoyé par la FP, et ce que le système en a compris :
 * TROUVEE (personne connue, envoyée, sans texte), A_VERIFIER (nom qui ressemble),
 * DEJA_POINTEE (même texte déjà enregistré), CONFLIT (autre texte déjà enregistré),
 * NON_ENVOYEE (fiche saisie mais jamais envoyée à la FP), INCONNUE (absente de la
 * base : quota « Autres »), INCOMPLETE (nom ou n° du texte manquant), DOUBLON (deux
 * fois dans le fichier).
 */
export interface LigneRetour {
  ligne: number;
  feuille: string;
  nomComplet: string;
  dateNaissance: string | null;
  lieuNaissance: string | null;
  typeTexte: 'ARRETE' | 'DECRET';
  numeroTexte: string | null;
  dateSignature: string | null;
  statutTexte: StatutTexte;
  diplomeBrut: string | null;
  diplomeCode: string | null;
  departementId: number | null;
  categorie:
    | 'TROUVEE'
    | 'A_VERIFIER'
    | 'DEJA_POINTEE'
    | 'CONFLIT'
    | 'NON_ENVOYEE'
    | 'INCONNUE'
    | 'INCOMPLETE'
    | 'DOUBLON';
  agentId: string | null;
  agentNom: string | null;
  detail: string | null;
}

export interface DecisionRetour extends LigneRetour {
  /** POINTER : rattacher le texte à agentId ; AUTRES : créer au quota « Autres ». */
  decision: 'POINTER' | 'AUTRES' | 'IGNORER';
}

@Injectable()
export class ReceptionService {
  constructor(
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
    @InjectRepository(Affectation)
    private readonly affectations: Repository<Affectation>,
    @InjectRepository(LotPublication)
    private readonly lots: Repository<LotPublication>,
    @InjectRepository(RegleDiplome)
    private readonly regles: Repository<RegleDiplome>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    private readonly importation: ImportBaseService,
    private readonly lotsReception: LotsReceptionService,
    private readonly anomalies: AnomaliesService,
    private readonly journal: JournalService,
  ) {}

  /** Paquets reçus et leurs lots (quota + type). */
  paquets() {
    return this.lotsReception.listePaquets();
  }

  /** Personnes déjà rattachées à un texte (pour signaler un n° déjà saisi). */
  async texte(typeTexte: string, numero: string) {
    const n = numero?.trim();
    if (!n) return [];
    const liste = await this.agents.find({
      where: { typeTexte: typeTexte as 'ARRETE' | 'DECRET', numeroTexte: n },
      order: { nomNormalise: 'ASC' },
      take: 50,
    });
    return liste.map((a) => ({
      id: a.id,
      nomComplet: a.nomComplet,
      lot: a.lotPublication ? libelleLot(a.lotPublication) : null,
    }));
  }

  /** Textes d'un paquet (date de réception), avec le lot où chacun est rangé. */
  async textesDuPaquet(date: string) {
    return this.agents.query<unknown[]>(
      `SELECT a."typeTexte", a."numeroTexte", l.numero AS "lotNumero",
         ${sqlLibelleLot('l')} AS lot,
         max(a."dateReception")::text AS "dateReception",
         count(*)::int AS n,
         bool_or(a."textePointeLe" IS NOT NULL) AS "dansLeSysteme",
         max(a."textePointePar") AS "pointePar",
         max(a."textePointeLe") AS "pointeLe",
         json_agg(json_build_object(
           'id', a.id, 'nomComplet', a."nomComplet",
           'annulable', a."textePointeLe" IS NOT NULL AND coalesce(f.statut, 'A_TRAITER') = 'A_TRAITER'
         ) ORDER BY a."nomNormalise") AS personnes
       FROM agent a
       JOIN lot_publication l ON l.id = a."lotPublicationId"
       JOIN paquet_reception p ON p.id = l."paquetId"
       LEFT JOIN affectation f ON f."agentId" = a.id
       WHERE p."dateReception" = $1
       GROUP BY 1, 2, 3, 4
       ORDER BY max(a."textePointeLe") DESC NULLS LAST, a."typeTexte", a."numeroTexte"
       LIMIT 400`,
      [date],
    );
  }

  /** Textes d'un lot, regroupés par n°, les derniers enregistrés en premier. */
  async textesDuLot(numero: number) {
    return this.agents.query<unknown[]>(
      `SELECT a."typeTexte", a."numeroTexte",
         max(a."dateReception")::text AS "dateReception",
         count(*)::int AS n,
         bool_or(a."textePointeLe" IS NOT NULL) AS "dansLeSysteme",
         max(a."textePointePar") AS "pointePar",
         max(a."textePointeLe") AS "pointeLe",
         json_agg(json_build_object(
           'id', a.id, 'nomComplet', a."nomComplet",
           'annulable', a."textePointeLe" IS NOT NULL AND coalesce(f.statut, 'A_TRAITER') = 'A_TRAITER'
         ) ORDER BY a."nomNormalise") AS personnes
       FROM agent a
       JOIN lot_publication l ON l.id = a."lotPublicationId"
       LEFT JOIN affectation f ON f."agentId" = a.id
       WHERE l.numero = $1
       GROUP BY 1, 2
       ORDER BY max(a."textePointeLe") DESC NULLS LAST, a."typeTexte", a."numeroTexte"
       LIMIT 400`,
      [numero],
    );
  }

  async enregistrer(
    u: UtilisateurConnecte,
    dto: TexteRecuDto,
    options: { affectations?: boolean; journal?: boolean } = {},
  ) {
    const numeroTexte = dto.numeroTexte?.replace(/\s+/g, ' ').trim();
    if (!numeroTexte)
      throw new BadRequestException('Écrivez le numéro du texte.');
    const ids = [...new Set(dto.agentIds ?? [])];
    if (!ids.length)
      throw new BadRequestException(
        'Ajoutez au moins une personne concernée par ce texte.',
      );

    const agents = await this.agents.find({ where: { id: In(ids) } });
    if (agents.length !== ids.length)
      throw new NotFoundException('Une des personnes est introuvable.');
    for (const a of agents) {
      const memeTexte =
        a.typeTexte === dto.typeTexte && a.numeroTexte === numeroTexte;
      if (a.lotPublicationId && !memeTexte)
        throw new BadRequestException(
          `${a.nomComplet} a déjà reçu son texte (${NOM_TYPE[a.typeTexte ?? 'ARRETE']} n° ${a.numeroTexte ?? '?'}, ${a.lotPublication ? libelleLot(a.lotPublication) : 'lot ?'}).`,
        );
      if (
        a.origineFiche === 'SAISIE' &&
        a.feuille === 'MEPPSA' &&
        !a.transmissionNumero
      )
        throw new BadRequestException(
          `La fiche de ${a.nomComplet} n'a pas encore été envoyée à la Fonction Publique.`,
        );
    }

    if (!dto.dateReception)
      throw new BadRequestException('Indiquez la date de réception du paquet.');

    const maintenant = new Date();
    for (const a of agents)
      await this.agents.update(a.id, {
        typeTexte: dto.typeTexte,
        numeroTexte,
        dateReception: dto.dateReception,
        dateSignatureTexte: null,
        textePointePar: u.nom,
        textePointeLe: maintenant,
        ...(dto.statutTexte && dto.statutTexte !== 'AGE'
          ? { contractuelForce: dto.statutTexte === 'CONTRACTUEL' }
          : {}),
        anomalies: (a.anomalies ?? []).filter(
          (x) => !x.startsWith('Lot de publication sans numéro'),
        ),
      });
    // Rangement : paquet de la date de réception, lot du quota et du type de chaque personne
    const rangement = await this.lotsReception.ranger(
      agents.map((a) => ({ id: a.id, date: dto.dateReception })),
    );

    // Date de signature : celle du lot par défaut (1er texte du lot), sinon propre au texte
    if (dto.dateSignature)
      for (const r of rangement) {
        const lot = (await this.lots.findOne({ where: { id: r.lot.id } }))!;
        const champ =
          lot.typeTexte === 'ARRETE'
            ? 'dateSignatureArretes'
            : 'dateSignatureDecrets';
        if (!lot[champ])
          await this.lots.update(lot.id, { [champ]: dto.dateSignature });
        else if (lot[champ] !== dto.dateSignature)
          await this.agents.update(
            { id: In(ids), lotPublicationId: lot.id },
            { dateSignatureTexte: dto.dateSignature },
          );
      }

    const nouveaux =
      options.affectations === false
        ? 0
        : await this.importation.creerAffectations();

    if (options.journal !== false)
      await this.journal.log(
        u,
        'RECEPTION_TEXTE',
        'lot_publication',
        rangement[0]?.lot.id ?? null,
        {
          typeTexte: dto.typeTexte,
          numeroTexte,
          personnes: agents.length,
          lot: rangement.map((r) => r.libelle).join(', '),
          paquet: rangement[0]?.paquet,
        },
      );
    await this.anomalies.reconcilier(ids);
    return {
      paquet: rangement[0]?.paquet ?? null,
      lots: rangement.map((r) => ({
        numero: r.lot.numero,
        libelle: r.libelle,
        n: r.n,
      })),
      personnes: agents.length,
      aAffecter: nouveaux,
    };
  }

  /** Retire une personne d'un texte saisi par erreur (avant toute note validée). */
  async annuler(u: UtilisateurConnecte, agentId: string) {
    const a = await this.agents.findOne({ where: { id: agentId } });
    if (!a) throw new NotFoundException('Personne introuvable');
    if (!a.textePointeLe)
      throw new BadRequestException(
        'Ce texte vient du fichier Excel : corrigez-le dans le fichier ou dans la fiche.',
      );
    const aff = await this.affectations.findOne({
      where: { agentId },
      loadEagerRelations: false,
    });
    if (aff && aff.statut !== 'A_TRAITER')
      throw new BadRequestException(
        aff.statut === 'AFFECTE'
          ? 'Cette personne est déjà dans une note validée par le DG.'
          : 'Cette personne a été retirée de la note : réintégrez-la d’abord.',
      );
    if (aff) await this.affectations.delete(aff.id);
    await this.agents.update(agentId, {
      typeTexte: null,
      numeroTexte: null,
      dateReception: null,
      dateSignatureTexte: null,
      lotPublicationId: null,
      textePointePar: null,
      textePointeLe: null,
    });
    await this.lotsReception.nettoyer();
    await this.journal.log(u, 'ANNULATION_RECEPTION', 'agent', agentId, {
      typeTexte: a.typeTexte,
      numeroTexte: a.numeroTexte,
      lot: a.lotPublication ? libelleLot(a.lotPublication) : null,
    });
    return { ok: true };
  }

  /* --------------- Fichier Excel du retour de la FP ---------------------- */

  /** Lit le fichier et classe chaque ligne, sans rien enregistrer. */
  async analyserRetour(contenu: Buffer) {
    const feuilles = await lireClasseur(contenu, ['NOMSETPRENOMS']);
    if (!feuilles.length)
      throw new BadRequestException(
        'Aucune feuille avec la colonne « Noms et prénoms » n’a été trouvée.',
      );
    if (
      !feuilles.some((f) =>
        f.entetes.some((e) =>
          /^N(DU|DE)?TEXTE|^NUMERODUTEXTE|^NUMTEXTE/.test(e),
        ),
      )
    )
      throw new BadRequestException(
        'Le fichier n’a pas de colonne « N° du texte » : impossible de savoir quel arrêté ou décret correspond à chaque personne.',
      );
    const regles = await this.regles.find();
    const deps = new Map((await this.deps.find()).map((d) => [d.code, d]));
    const base = (
      await this.agents.find({
        select: [
          'id',
          'nomComplet',
          'nomNormalise',
          'dateNaissance',
          'lotPublicationId',
          'typeTexte',
          'numeroTexte',
          'origineFiche',
          'feuille',
          'transmissionNumero',
        ],
        loadEagerRelations: false,
      })
    ).map((a) => ({ ...a, mots: motsDuNom(a.nomNormalise) }));
    const parNom = new Map<string, typeof base>();
    for (const a of base)
      parNom.set(a.nomNormalise, [...(parNom.get(a.nomNormalise) ?? []), a]);

    const lignes: LigneRetour[] = [];
    const vus = new Set<string>();
    for (const f of feuilles)
      for (const l of f.lignes) {
        const nomComplet = nettoyer(champ(l, 'NOMSETPRENOMS'));
        if (!nomComplet) continue;
        const typeBrut = cleCompacte(nettoyer(champ(l, 'TYPEDETEXTE', 'TYPE')));
        const numeroTexte = nettoyer(
          champ(
            l,
            'NDUTEXTE',
            'NTEXTE',
            'NDETEXTE',
            'NUMERODUTEXTE',
            'NUMTEXTE',
          ),
        );
        const statutBrut = cleCompacte(nettoyer(champ(l, 'STATUT')));
        const diplomeBrut = nettoyer(champ(l, 'DIPLOME'));
        const codeDep = codeDepartement(
          nettoyer(champ(l, 'DEPARTEMENT', 'DEPART')),
        );
        const dateNaissance = lireDate(champ(l, 'DATEDENAIS'));
        const ligne: LigneRetour = {
          ligne: l._ligne,
          feuille: f.nom,
          nomComplet,
          dateNaissance,
          lieuNaissance: nettoyer(champ(l, 'LIEUDENAIS')),
          typeTexte:
            typeBrut.includes('DECRET') ||
            (!typeBrut && /^\d{4}-\d+/.test(numeroTexte ?? ''))
              ? 'DECRET'
              : 'ARRETE',
          numeroTexte,
          dateSignature: lireDate(
            champ(l, 'DATEDESIGNATURE', 'DATESIGNATURE', 'DATEDUTEXTE'),
          ),
          statutTexte: statutBrut.includes('CONTRACT')
            ? 'CONTRACTUEL'
            : statutBrut.includes('FONCTION')
              ? 'FONCTIONNAIRE'
              : 'AGE',
          diplomeBrut,
          diplomeCode: reconnaitreDiplome(diplomeBrut, regles),
          departementId: codeDep ? (deps.get(codeDep)?.id ?? null) : null,
          categorie: 'INCONNUE',
          agentId: null,
          agentNom: null,
          detail: null,
        };
        lignes.push(ligne);
        const nomNormalise = normaliser(nomComplet);
        const clePersonne = `${nomNormalise}|${dateNaissance ?? ''}`;
        if (!numeroTexte) {
          ligne.categorie = 'INCOMPLETE';
          ligne.detail = 'N° du texte absent';
          continue;
        }
        if (vus.has(clePersonne)) {
          ligne.categorie = 'DOUBLON';
          ligne.detail = 'Déjà plus haut dans le fichier';
          continue;
        }
        vus.add(clePersonne);

        // Même nom (et même date si les deux sont connues)
        const memes = (parNom.get(nomNormalise) ?? []).filter(
          (a) =>
            !dateNaissance ||
            !a.dateNaissance ||
            a.dateNaissance === dateNaissance,
        );
        let a = memes.length === 1 ? memes[0] : null;
        if (!a && memes.length > 1) {
          ligne.categorie = 'A_VERIFIER';
          a = memes[0];
          ligne.detail = `${memes.length} personnes portent ce nom : vérifiez la date de naissance`;
        }
        if (!a) {
          // Nom écrit autrement : on propose, l'agent confirme
          const mots = motsDuNom(nomNormalise);
          const proche =
            base.find(
              (b) =>
                ressemblance(mots, dateNaissance, b.mots, b.dateNaissance) ===
                'PROBABLE',
            ) ?? null;
          if (proche) {
            a = proche;
            ligne.categorie = 'A_VERIFIER';
            ligne.detail = 'Nom écrit un peu autrement';
          }
        }
        if (!a) continue; // INCONNUE
        ligne.agentId = a.id;
        ligne.agentNom = a.nomComplet;
        const memeTexte =
          a.typeTexte === ligne.typeTexte && a.numeroTexte === numeroTexte;
        if (a.lotPublicationId) {
          ligne.categorie = memeTexte ? 'DEJA_POINTEE' : 'CONFLIT';
          ligne.detail = memeTexte
            ? 'Ce texte est déjà enregistré pour cette personne'
            : `A déjà un autre texte : ${NOM_TYPE[a.typeTexte ?? 'ARRETE']} n° ${a.numeroTexte ?? '?'}`;
        } else if (
          a.origineFiche === 'SAISIE' &&
          a.feuille === 'MEPPSA' &&
          !a.transmissionNumero
        ) {
          ligne.categorie = 'NON_ENVOYEE';
          ligne.detail =
            'Sa fiche est saisie mais n’a jamais été envoyée à la Fonction Publique';
        } else if (ligne.categorie !== 'A_VERIFIER')
          ligne.categorie = 'TROUVEE';
      }

    const compteurs: Record<LigneRetour['categorie'], number> = {
      TROUVEE: 0,
      A_VERIFIER: 0,
      DEJA_POINTEE: 0,
      CONFLIT: 0,
      NON_ENVOYEE: 0,
      INCONNUE: 0,
      INCOMPLETE: 0,
      DOUBLON: 0,
    };
    for (const l of lignes) compteurs[l.categorie]++;
    return { lues: lignes.length, compteurs, lignes };
  }

  /**
   * Applique les choix de l'agent : mêmes règles que la saisie texte par texte
   * (un enregistrement par texte), puis création des affectations une seule fois.
   */
  async appliquerRetour(
    u: UtilisateurConnecte,
    dto: {
      dateReception: string;
      lignes: DecisionRetour[];
      nomFichier?: string;
    },
  ) {
    const retenues = dto.lignes.filter(
      (l) =>
        l.numeroTexte?.trim() &&
        ((l.decision === 'POINTER' && l.agentId) || l.decision === 'AUTRES'),
    );
    if (!retenues.length)
      throw new BadRequestException('Aucune ligne à enregistrer.');

    // 1. Personnes absentes de la base : quota « Autres »
    let ajoutees = 0;
    const refusees: { nom: string; raison: string }[] = [];
    const cibles: { l: DecisionRetour; agentId: string }[] = [];
    for (const l of retenues) {
      if (l.decision === 'POINTER') {
        cibles.push({ l, agentId: l.agentId! });
        continue;
      }
      try {
        const a = await this.creerQuotaAutres(u, {
          nomComplet: l.nomComplet,
          dateNaissance: l.dateNaissance,
          lieuNaissance: l.lieuNaissance,
          diplomeCode: l.diplomeCode ?? '',
          departementId: l.departementId,
          diplomeBrut: l.diplomeBrut,
          observation: 'Ajoutée depuis le fichier Excel de la FP',
        });
        ajoutees++;
        cibles.push({ l, agentId: a.id });
      } catch (e) {
        refusees.push({ nom: l.nomComplet, raison: (e as Error).message });
      }
    }

    // 2. Un enregistrement par texte (même n°, même date, même statut)
    const groupes = new Map<string, { l: DecisionRetour; ids: string[] }>();
    for (const c of cibles) {
      const k = [
        c.l.typeTexte,
        c.l.numeroTexte!.trim(),
        c.l.dateSignature ?? '',
        c.l.statutTexte,
      ].join('|');
      const g = groupes.get(k) ?? { l: c.l, ids: [] };
      g.ids.push(c.agentId);
      groupes.set(k, g);
    }
    // Lots remplis : libellé -> nombre de personnes
    const lots = new Map<string, { numero: number; n: number }>();
    const noter = (r: {
      lots: { numero: number; libelle: string; n: number }[];
    }) => {
      for (const l of r.lots) {
        const x = lots.get(l.libelle) ?? { numero: l.numero, n: 0 };
        x.n += l.n;
        lots.set(l.libelle, x);
      }
    };
    let paquet: string | null = null;
    let personnes = 0;
    for (const g of groupes.values()) {
      const dtoTexte = {
        dateReception: dto.dateReception,
        typeTexte: g.l.typeTexte,
        numeroTexte: g.l.numeroTexte!,
        dateSignature: g.l.dateSignature,
        statutTexte: g.l.statutTexte,
      };
      try {
        const r = await this.enregistrer(
          u,
          { ...dtoTexte, agentIds: g.ids },
          { affectations: false, journal: false },
        );
        noter(r);
        paquet = r.paquet ?? paquet;
        personnes += r.personnes;
      } catch {
        // Une personne refusée ne bloque pas les autres du même texte
        for (const id of g.ids)
          try {
            const r = await this.enregistrer(
              u,
              { ...dtoTexte, agentIds: [id] },
              { affectations: false, journal: false },
            );
            noter(r);
            paquet = r.paquet ?? paquet;
            personnes += r.personnes;
          } catch (e) {
            const a = await this.agents.findOne({ where: { id } });
            refusees.push({
              nom: a?.nomComplet ?? '?',
              raison: (e as Error).message,
            });
          }
      }
    }
    const aAffecter = await this.importation.creerAffectations();
    await this.journal.log(u, 'IMPORT_RETOUR_FP', 'lot_publication', null, {
      fichier: dto.nomFichier ?? null,
      paquet,
      lot: [...lots.keys()].join(', '),
      textes: groupes.size,
      personnes,
      ajouteesQuotaAutres: ajoutees,
      refusees: refusees.length,
    });
    await this.anomalies.reconcilier();
    return {
      paquet,
      lots: [...lots].map(([libelle, x]) => ({ libelle, ...x })),
      textes: groupes.size,
      personnes,
      ajoutees,
      refusees,
      aAffecter,
    };
  }

  /** Ajoute à la base une personne du texte qui n'y figure pas (quota « Autres »). */
  async ajouterQuotaAutres(u: UtilisateurConnecte, dto: QuotaAutresDto) {
    return this.creerQuotaAutres(u, dto, true);
  }

  private async creerQuotaAutres(
    u: UtilisateurConnecte,
    dto: QuotaAutresDto & { diplomeBrut?: string | null },
    diplomeObligatoire = false,
  ) {
    const nomComplet = dto.nomComplet?.replace(/\s+/g, ' ').trim();
    if (!nomComplet)
      throw new BadRequestException('Écrivez le nom écrit sur le texte.');
    const regle = dto.diplomeCode
      ? await this.regles.findOne({ where: { code: dto.diplomeCode } })
      : null;
    if (!regle && diplomeObligatoire)
      throw new BadRequestException('Choisissez le diplôme.');
    const dep = dto.departementId
      ? await this.deps.findOne({ where: { id: dto.departementId } })
      : null;
    const nomNormalise = normaliser(nomComplet);
    const dateNaissance = dto.dateNaissance || null;
    const existant = await this.agents.findOne({
      where: { nomNormalise, ...(dateNaissance ? { dateNaissance } : {}) },
    });
    if (existant)
      throw new BadRequestException(
        `${existant.nomComplet} est déjà dans la base : cherchez-la par son nom.`,
      );
    const a = await this.agents.save(
      this.agents.create({
        cle: `QA|${nomNormalise}|${dateNaissance ?? Date.now()}`,
        feuille: 'QUOTA_AUTRES',
        nomComplet,
        nomNormalise,
        dateNaissance,
        lieuNaissance: dto.lieuNaissance?.trim() || null,
        diplomeBrut: regle?.libelle ?? dto.diplomeBrut ?? null,
        diplomeCode: regle?.code ?? null,
        departementBrut: dep?.nom ?? null,
        departementId: dep?.id ?? null,
        source: 'FP',
        statut: 'Autres',
        cycleBrut: regle ? (LIBELLE_CYCLE[regle.cycle as Cycle] ?? null) : null,
        lieuServiceBrut: dto.lieuServiceBrut?.trim() || null,
        quota: dto.quota ?? null,
        origineBrute: dto.origineBrute?.trim() || null,
        observation: dto.observation?.trim() || null,
        origineFiche: 'SAISIE',
        etatFiche: 'VALIDEE',
        saisiePar: u.nom,
        anomalies: [
          ...(dateNaissance ? [] : ['Date de naissance absente']),
          ...(regle ? [] : ['Diplôme non reconnu']),
        ],
      }),
    );
    await this.journal.log(u, 'AJOUT_QUOTA_AUTRES', 'agent', a.id, {
      diplome: regle?.libelle ?? dto.diplomeBrut ?? null,
    });
    return (await this.agents.findOne({ where: { id: a.id } }))!;
  }
}
