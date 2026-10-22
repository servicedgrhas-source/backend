import { anomaliesAJour } from '../common/anomalies';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import ExcelJS from 'exceljs';
import { Brackets, Repository } from 'typeorm';
import { AffectationService } from '../affectation/affectation.service';
import {
  estContractuel,
  gradeAffiche,
  referenceTexte,
} from '../affectation/calcul';
import { libelleLot, libellePaquet } from '../common/lots';
import {
  NOTES_AFFECTATION,
  type TypeNoteAffectation,
} from '../common/referentiels';
import { normaliser } from '../common/texte';
import {
  Affectation,
  Agent,
  DemandeMutation,
  Journal,
  MembreCommission,
  NoteService,
  PaquetReception,
  ReferenceNote,
} from '../entities';

const libelleTransmission = (n: number) =>
  `${n === 1 ? '1ère' : `${n}ème`} transmission`;

export interface FiltresEnvois {
  recherche?: string;
  quota?: number;
  transmission?: number;
  statut?: string;
  diplomeCode?: string;
  departementId?: number;
  lotCommission?: string;
  /** attente : texte pas encore revenu ; recu : texte reçu ; vide : tous. */
  texte?: 'attente' | 'recu' | '';
  page?: number;
  taille?: number;
}

/**
 * Un dossier de bout en bout : de la saisie à la note de service, et la recherche
 * globale (nom, n° de texte, n° de note).
 */
@Injectable()
export class DossiersService {
  constructor(
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
    @InjectRepository(Affectation)
    private readonly affectations: Repository<Affectation>,
    @InjectRepository(NoteService)
    private readonly notes: Repository<NoteService>,
    @InjectRepository(DemandeMutation)
    private readonly mutations: Repository<DemandeMutation>,
    @InjectRepository(Journal) private readonly journal: Repository<Journal>,
    @InjectRepository(MembreCommission)
    private readonly membres: Repository<MembreCommission>,
    @InjectRepository(PaquetReception)
    private readonly paquets: Repository<PaquetReception>,
    private readonly affSvc: AffectationService,
    @InjectRepository(ReferenceNote)
    private readonly refsNotes: Repository<ReferenceNote>,
  ) {}

  /* ------------------------- Base des envoyés à la FP ------------------------- */

  private requeteEnvois(f: FiltresEnvois) {
    const q = this.agents
      .createQueryBuilder('a')
      .leftJoinAndSelect('a.departement', 'd')
      .leftJoinAndSelect('a.lotPublication', 'l')
      .where('a.transmissionNumero IS NOT NULL')
      .andWhere("a.feuille = 'MEPPSA'");
    if (f.recherche?.trim()) {
      const mots = normaliser(f.recherche).split(' ').filter(Boolean);
      q.andWhere(
        new Brackets((w) => {
          w.where(
            new Brackets((m) =>
              mots.forEach((x, i) =>
                m.andWhere(`a.nomNormalise LIKE :m${i}`, {
                  [`m${i}`]: `%${x}%`,
                }),
              ),
            ),
          ).orWhere('a.numeroTexte ILIKE :n', {
            n: `%${f.recherche!.trim()}%`,
          });
        }),
      );
    }
    if (f.quota) q.andWhere('a.quota = :quota', { quota: f.quota });
    if (f.transmission)
      q.andWhere('a.transmissionNumero = :tr', { tr: f.transmission });
    if (f.statut) q.andWhere('a.statut = :statut', { statut: f.statut });
    if (f.diplomeCode)
      q.andWhere('a.diplomeCode = :dip', { dip: f.diplomeCode });
    if (f.departementId)
      q.andWhere('a.departementId = :dep', { dep: f.departementId });
    if (f.lotCommission)
      q.andWhere('a.lotCommission = :lc', { lc: f.lotCommission });
    if (f.texte === 'attente') q.andWhere('a.lotPublicationId IS NULL');
    if (f.texte === 'recu') q.andWhere('a.lotPublicationId IS NOT NULL');
    return q;
  }

  async envoyes(f: FiltresEnvois) {
    const taille = Math.min(f.taille ?? 50, 200);
    const page = Math.max(f.page ?? 1, 1);
    const [items, total] = await this.requeteEnvois(f)
      .orderBy('a.quota', 'ASC')
      .addOrderBy('a.transmissionNumero', 'ASC')
      .addOrderBy('a.lotCommission', 'ASC')
      .addOrderBy('a.nomNormalise', 'ASC')
      .skip((page - 1) * taille)
      .take(taille)
      .getManyAndCount();
    const [compte] = await this.requeteEnvois({ ...f, texte: '' })
      .select(
        'count(*) FILTER (WHERE a.lotPublicationId IS NULL)::int',
        'attente',
      )
      .addSelect(
        'count(*) FILTER (WHERE a.lotPublicationId IS NOT NULL)::int',
        'recus',
      )
      .getRawMany<{ attente: number; recus: number }>();
    const regles = await this.affSvc.reglesParCode();
    const p = this.affSvc.parametresCalcul();
    return {
      total,
      page,
      taille,
      attente: compte?.attente ?? 0,
      recus: compte?.recus ?? 0,
      items: items.map((a) => {
        const r = a.diplomeCode ? regles.get(a.diplomeCode) : undefined;
        const c = estContractuel(a, p, r?.categorie);
        return {
          id: a.id,
          nomComplet: a.nomComplet,
          dateNaissance: a.dateNaissance,
          lieuNaissance: a.lieuNaissance,
          quota: a.quota,
          statut: a.statut,
          lotCommission: a.lotCommission,
          numeroListe: a.numeroListe,
          diplome: r?.libelle ?? a.diplomeBrut,
          grade: gradeAffiche(r?.grade ?? null, c.contractuel),
          contractuel: c.contractuel,
          provisoire: c.provisoire,
          departement: a.departement?.nom ?? null,
          transmission: libelleTransmission(a.transmissionNumero!),
          transmissionNumero: a.transmissionNumero,
          transmisLe: a.transmisLe,
          texte: a.lotPublicationId
            ? {
                type: a.typeTexte,
                numero: a.numeroTexte,
                lot: a.lotPublication ? libelleLot(a.lotPublication) : null,
              }
            : null,
          rectifiee: a.rectifiee,
        };
      }),
    };
  }

  /** Valeurs possibles des filtres, avec le nombre de dossiers. */
  async filtresEnvois() {
    const q = <T>(sql: string) => this.agents.query<T>(sql);
    const base = `FROM agent a WHERE a."transmissionNumero" IS NOT NULL AND a.feuille = 'MEPPSA'`;
    const [quotas, lots, diplomes, deps, statuts] = await Promise.all([
      q<{ quota: number; numero: number; n: number; attente: number }[]>(
        `SELECT a.quota, a."transmissionNumero" AS numero, count(*)::int AS n,
           count(*) FILTER (WHERE a."lotPublicationId" IS NULL)::int AS attente
         ${base} GROUP BY 1, 2 ORDER BY 1, 2`,
      ),
      q<{ quota: number; lot: string; n: number }[]>(
        `SELECT a.quota, a."lotCommission" AS lot, count(*)::int AS n ${base}
           AND a."lotCommission" IS NOT NULL GROUP BY 1, 2`,
      ),
      q<{ code: string; libelle: string; n: number }[]>(
        `SELECT a."diplomeCode" AS code, coalesce(r.libelle, a."diplomeCode") AS libelle, count(*)::int AS n
         FROM agent a LEFT JOIN regle_diplome r ON r.code = a."diplomeCode"
         WHERE a."transmissionNumero" IS NOT NULL AND a.feuille = 'MEPPSA' AND a."diplomeCode" IS NOT NULL
         GROUP BY 1, 2 ORDER BY 2`,
      ),
      q<{ id: number; nom: string; n: number }[]>(
        `SELECT d.id, d.nom, count(*)::int AS n FROM agent a JOIN departement d ON d.id = a."departementId"
         WHERE a."transmissionNumero" IS NOT NULL AND a.feuille = 'MEPPSA' GROUP BY 1, 2 ORDER BY d.ordre`,
      ),
      q<{ statut: string; n: number }[]>(
        `SELECT a.statut, count(*)::int AS n ${base} AND a.statut IS NOT NULL GROUP BY 1 ORDER BY 1`,
      ),
    ]);
    // Lots de la commission : « Lot 2 » avant « Lot 10 »
    const num = (s: string) => Number(/\d+/.exec(s)?.[0] ?? 0);
    lots.sort((x, y) => num(x.lot) - num(y.lot) || x.lot.localeCompare(y.lot));
    const parQuota = new Map<
      number,
      {
        quota: number;
        n: number;
        attente: number;
        transmissions: {
          numero: number;
          libelle: string;
          n: number;
          attente: number;
        }[];
        lots: { lot: string; n: number }[];
      }
    >();
    for (const t of quotas) {
      const x = parQuota.get(t.quota) ?? {
        quota: t.quota,
        n: 0,
        attente: 0,
        transmissions: [],
        lots: [],
      };
      x.n += t.n;
      x.attente += t.attente;
      x.transmissions.push({
        numero: t.numero,
        libelle: libelleTransmission(t.numero),
        n: t.n,
        attente: t.attente,
      });
      parQuota.set(t.quota, x);
    }
    for (const l of lots)
      parQuota.get(l.quota)?.lots.push({ lot: l.lot, n: l.n });
    return {
      quotas: [...parQuota.values()].sort((a, b) => b.quota - a.quota),
      diplomes,
      departements: deps,
      statuts,
    };
  }

  /** Les envoyés filtrés, en Excel (sans budget). */
  async exporterEnvois(f: FiltresEnvois) {
    const liste = await this.envoyes({ ...f, page: 1, taille: 200 });
    const tous = [...liste.items];
    for (let page = 2; (page - 1) * 200 < liste.total; page++)
      tous.push(...(await this.envoyes({ ...f, page, taille: 200 })).items);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Envoyés à la FP');
    ws.columns = [
      { header: 'N°', width: 6 },
      { header: 'Noms et prénoms', width: 34 },
      { header: 'Date de naissance', width: 14 },
      { header: 'Lieu de naissance', width: 18 },
      { header: 'Diplôme', width: 20 },
      { header: 'Grade', width: 10 },
      { header: 'Département', width: 18 },
      { header: 'Quota', width: 8 },
      { header: 'Statut', width: 14 },
      { header: 'Lot de la commission', width: 14 },
      { header: 'Transmission', width: 18 },
      { header: 'Envoyé le', width: 12 },
      { header: 'Texte de la FP', width: 30 },
    ];
    ws.getRow(1).font = { bold: true };
    tous.forEach((x, i) =>
      ws.addRow([
        i + 1,
        x.nomComplet,
        x.dateNaissance,
        x.lieuNaissance,
        x.diplome,
        x.grade,
        x.departement,
        x.quota,
        x.statut,
        x.lotCommission,
        x.transmission,
        x.transmisLe,
        x.texte
          ? `${x.texte.type === 'DECRET' ? 'Décret' : 'Arrêté'} n° ${x.texte.numero ?? '?'} (${x.texte.lot ?? ''})`
          : 'Attendu',
      ]),
    );
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  /* ------------------------------ Un dossier ------------------------------ */

  async dossier(id: string, voirInterne: boolean) {
    const a = await this.agents.findOne({ where: { id } });
    if (!a) throw new NotFoundException('Dossier introuvable');
    const regles = await this.affSvc.reglesParCode();
    const p = this.affSvc.parametresCalcul();
    const r = a.diplomeCode ? regles.get(a.diplomeCode) : undefined;
    const c = estContractuel(a, p, r?.categorie);
    const aff = await this.affectations.findOne({
      where: { agentId: id },
      relations: { departement: true },
      loadEagerRelations: false,
    });
    const note = aff?.noteId
      ? await this.notes.findOne({ where: { id: aff.noteId } })
      : // Pas encore dans une note validée : note ouverte de son lot et de son type
        aff
        ? await this.notes.findOne({
            where: {
              module: 'AFFECTATION',
              lotPublicationId: aff.lotPublicationId,
              typeNote: aff.typeNote,
              statut: 'BROUILLON',
            },
          })
        : null;
    const noteSoumise =
      !note && aff && aff.statut === 'A_TRAITER'
        ? await this.notes.findOne({
            where: {
              module: 'AFFECTATION',
              lotPublicationId: aff.lotPublicationId,
              typeNote: aff.typeNote,
              statut: 'SOUMISE',
            },
          })
        : null;
    const n = note ?? noteSoumise;
    const paquet = a.lotPublication?.paquetId
      ? await this.paquets.findOne({ where: { id: a.lotPublication.paquetId } })
      : null;
    const membre = a.membreCommissionId
      ? await this.membres.findOne({ where: { id: a.membreCommissionId } })
      : null;
    const historique = await this.journal.find({
      where: { entiteId: id },
      order: { date: 'DESC' },
      take: 30,
    });
    // Demandes de mutation au même nom (peut être un homonyme)
    const cle = normaliser(a.nomComplet);
    const mutations = (
      await this.mutations.find({
        select: [
          'id',
          'nomComplet',
          'motif',
          'numeroEnregistrement',
          'instructionMinistre',
          'retiree',
          'noteId',
        ],
      })
    ).filter((m) => normaliser(m.nomComplet) === cle);
    const { reference } = referenceTexte(a);

    const etapes = this.etapes(a, aff, n);
    // Notes signées hors du système (fichier de contrôle des affectations)
    const horsSysteme = await this.refsNotes.find({
      where: { agentId: id },
      order: { date: 'ASC' },
    });
    const etape = etapes.filter((e) => e.fait).at(-1)?.titre ?? 'Saisi';
    return {
      id: a.id,
      etape:
        horsSysteme.length && aff?.statut !== 'AFFECTE'
          ? 'Affecté (note signée hors du système)'
          : etape,
      // Même règle que « Contrôle des affectations » : deux n° différents, ou deux fois le même n° dans le fichier
      doubleAffectation: (() => {
        const numeros = horsSysteme.map((r) => r.numero ?? r.brut);
        const systeme =
          aff?.statut === 'AFFECTE' &&
          note &&
          ['VALIDEE', 'SIGNEE'].includes(note.statut)
            ? [note.numero ?? `système ${note.id}`]
            : [];
        const tous = [...numeros, ...systeme];
        return (
          new Set(tous).size > 1 || numeros.length !== new Set(numeros).size
        );
      })(),
      notesHorsSysteme: horsSysteme.map((r) => ({
        brut: r.brut,
        lieuAffectation: r.lieuAffectation,
        service: r.service,
        lieuService: r.lieuService,
        source: r.source,
      })),
      etapes,
      identite: {
        nomComplet: a.nomComplet,
        dateNaissance: a.dateNaissance,
        dateNaissanceBrute: a.dateNaissance ? null : a.dateNaissanceBrute,
        lieuNaissance: a.lieuNaissance,
        diplome: r?.libelle ?? a.diplomeBrut,
        cycle: r?.cycle ?? a.cycleBrut,
        grade: gradeAffiche(r?.grade ?? null, c.contractuel),
        gradeLibelle: r?.gradeLibelle ?? null,
        classification: r
          ? `Cat. ${r.categorie ?? '?'} · échelle ${r.echelle ?? '?'} · échelon ${r.echelon ?? '?'} · indice ${r.indice ?? '?'}`
          : null,
        contractuel: c.contractuel,
        age: c.age,
        dateAge: c.dateAge,
        provisoire: c.provisoire,
        statutImpose: c.impose,
      },
      recrutement: {
        feuille: a.feuille,
        origineFiche: a.origineFiche,
        quota: a.quota,
        statut: a.statut,
        lotCommission: a.lotCommission,
        numeroOrdre: a.numeroOrdre,
        numeroListe: a.numeroListe,
        departement: a.departement?.nom ?? a.departementBrut,
        lieuService: a.lieuServiceBrut,
        dateDepot: a.dateDepot,
        observation: a.observation,
        origine: voirInterne ? a.origineBrute : null,
        membreCommission:
          voirInterne && membre
            ? `${membre.nom}${membre.fonction ? ` (${membre.fonction})` : ''}`
            : null,
        saisiePar: a.saisiePar,
        controleePar: a.controleePar,
        valideePar: a.valideePar,
        etatFiche: a.etatFiche,
        contentieuxAge: a.contentieuxAge,
        remarqueControle: a.remarqueControle,
        reporteDe: a.reporteDe,
        reportMotif: a.reportMotif,
        misDeCoteMotif: a.misDeCoteMotif,
        misDeCoteLe: a.misDeCoteLe,
        anomalies: anomaliesAJour(a),
      },
      fp: {
        transmission: a.transmissionNumero
          ? `${libelleTransmission(a.transmissionNumero)} du quota ${a.quota}`
          : (a.transmission ?? null),
        transmisLe: a.transmisLe,
        rectifiee: a.rectifiee,
        typeTexte: a.typeTexte,
        numeroTexte: a.numeroTexte,
        reference,
        dateReception: a.dateReception,
        lot: a.lotPublication
          ? {
              numero: a.lotPublication.numero,
              libelle: libelleLot(a.lotPublication),
            }
          : null,
        paquet: paquet ? libellePaquet(paquet) : null,
        textePointePar: a.textePointePar,
      },
      affectation: aff
        ? {
            statut: aff.statut,
            typeNote:
              NOTES_AFFECTATION[aff.typeNote as TypeNoteAffectation]?.libelle ??
              aff.typeNote,
            departement: aff.departement?.nom ?? null,
            etablissement: aff.etablissement,
            structure: aff.structure,
            specialite: aff.specialite,
            motifExclusion: aff.motifExclusion,
            lotNumero: a.lotPublication?.numero ?? null,
          }
        : null,
      note: n
        ? {
            id: n.id,
            statut: n.statut,
            numero: n.numero,
            dateSignature: n.dateSignature,
            libelle: `${NOTES_AFFECTATION[n.typeNote as TypeNoteAffectation]?.libelle ?? n.typeNote}${a.lotPublication ? ` – ${libelleLot(a.lotPublication)}` : ''}`,
            definitive: aff?.noteId === n.id,
          }
        : null,
      mutations: mutations.map((m) => ({
        id: m.id,
        numero: m.numeroEnregistrement,
        motif: m.motif,
        instruction: m.instructionMinistre,
        retiree: m.retiree,
      })),
      historique: historique.map((h) => ({
        date: h.date,
        action: h.action,
        par: h.utilisateurNom,
        details: h.details,
      })),
    };
  }

  /** Le fil du dossier, étape par étape. */
  private etapes(a: Agent, aff: Affectation | null, n: NoteService | null) {
    const saisie = a.origineFiche === 'SAISIE';
    const envoye = !!a.transmissionNumero || !!a.transmission;
    const etapes: { titre: string; fait: boolean; detail: string | null }[] =
      [];
    if (a.feuille === 'QUOTA_AUTRES')
      etapes.push({
        titre: 'Quota « Autres »',
        fait: true,
        detail:
          'Personne trouvée sur un texte de la FP, sans avoir été envoyée par la DGRHAS',
      });
    else {
      etapes.push({
        titre: 'Saisi',
        fait: true,
        detail: saisie
          ? `par ${a.saisiePar ?? '?'}`
          : 'repris de la fiche de suivi Excel',
      });
      if (saisie) {
        etapes.push({
          titre: 'Contrôlé',
          fait: a.etatFiche !== 'A_CONTROLER',
          detail: a.controleePar ? `par ${a.controleePar}` : null,
        });
        etapes.push({
          titre: 'Validé par le DG',
          fait: a.etatFiche === 'VALIDEE',
          detail: a.valideePar ? `par ${a.valideePar}` : null,
        });
      }
      etapes.push({
        titre: 'Envoyé à la FP',
        fait: envoye,
        detail: a.transmissionNumero
          ? `${libelleTransmission(a.transmissionNumero)} du quota ${a.quota}${a.transmisLe ? `, le ${a.transmisLe.split('-').reverse().join('/')}` : ''}`
          : (a.transmission ?? null),
      });
    }
    etapes.push({
      titre: 'Texte reçu de la FP',
      fait: !!a.lotPublicationId,
      detail: a.lotPublicationId
        ? `${a.typeTexte === 'DECRET' ? 'Décret' : 'Arrêté'} n° ${a.numeroTexte ?? '?'}`
        : envoye
          ? 'en attente'
          : null,
    });
    etapes.push({
      titre: 'Dans une note de service',
      fait: !!n,
      detail: n
        ? n.statut === 'BROUILLON'
          ? 'note à soumettre au DG'
          : n.statut === 'SOUMISE'
            ? 'note en attente de validation du DG'
            : `note ${n.statut === 'SIGNEE' ? 'signée' : 'validée'}${n.numero ? ` n° ${n.numero}` : ''}`
        : aff?.statut === 'EXCLU'
          ? 'retiré de la note'
          : null,
    });
    etapes.push({
      titre: 'Affecté',
      fait: aff?.statut === 'AFFECTE',
      detail:
        aff?.statut === 'AFFECTE'
          ? (aff.etablissement ?? aff.structure ?? null)
          : null,
    });
    return etapes;
  }

  /* --------------------------- Recherche globale --------------------------- */

  async recherche(texte: string) {
    const brut = texte?.trim() ?? '';
    if (brut.length < 2) return { dossiers: [], mutations: [], notes: [] };
    const mots = normaliser(brut).split(' ').filter(Boolean);
    const q = this.agents
      .createQueryBuilder('a')
      .leftJoinAndSelect('a.departement', 'd')
      .leftJoinAndSelect('a.lotPublication', 'l')
      .where(
        new Brackets((w) => {
          w.where(
            new Brackets((m) =>
              mots.forEach((x, i) =>
                m.andWhere(`a.nomNormalise LIKE :m${i}`, {
                  [`m${i}`]: `%${x}%`,
                }),
              ),
            ),
          ).orWhere('a.numeroTexte ILIKE :n', { n: `%${brut}%` });
        }),
      )
      .orderBy('a.nomNormalise', 'ASC')
      .take(25);
    const agents = await q.getMany();
    const affs = agents.length
      ? await this.affectations.find({
          where: agents.map((a) => ({ agentId: a.id })),
          loadEagerRelations: false,
        })
      : [];
    const mutations = (
      await this.mutations.find({
        select: [
          'id',
          'nomComplet',
          'motif',
          'numeroEnregistrement',
          'instructionMinistre',
          'retiree',
        ],
      })
    )
      .filter((m) => {
        const nom = normaliser(m.nomComplet);
        return mots.every((x) => nom.includes(x));
      })
      .slice(0, 10);
    const notes = await this.notes
      .createQueryBuilder('n')
      .where('n.numero ILIKE :n', { n: `%${brut}%` })
      .take(10)
      .getMany();
    return {
      dossiers: agents.map((a) => {
        const aff = affs.find((x) => x.agentId === a.id);
        return {
          id: a.id,
          nomComplet: a.nomComplet,
          dateNaissance: a.dateNaissance,
          diplome: a.diplomeBrut,
          departement: a.departement?.nom ?? null,
          quota: a.feuille === 'QUOTA_AUTRES' ? 'Autres' : a.quota,
          etape: this.etapeCourte(a, aff),
          texte: a.numeroTexte
            ? `${a.typeTexte === 'DECRET' ? 'Décret' : 'Arrêté'} n° ${a.numeroTexte}`
            : null,
          trouvePar: !mots.every((x) => a.nomNormalise.includes(x))
            ? 'texte'
            : 'nom',
        };
      }),
      mutations: mutations.map((m) => ({
        id: m.id,
        nomComplet: m.nomComplet,
        numero: m.numeroEnregistrement,
        motif: m.motif,
        instruction: m.instructionMinistre,
        retiree: m.retiree,
      })),
      notes: notes.map((n) => ({
        id: n.id,
        module: n.module,
        numero: n.numero,
        statut: n.statut,
        typeNote: n.typeNote,
      })),
    };
  }

  private etapeCourte(a: Agent, aff?: Affectation) {
    if (aff?.statut === 'AFFECTE') return 'Affecté';
    if (aff?.statut === 'EXCLU') return 'Retiré de la note';
    if (a.lotPublicationId) return 'Texte reçu, pas encore affecté';
    if (a.transmissionNumero || a.transmission)
      return 'Envoyé à la FP, texte attendu';
    if (a.etatFiche === 'VALIDEE') return 'Validé, prêt à envoyer';
    if (a.etatFiche === 'CONTROLEE') return 'Contrôlé, attend le DG';
    if (a.contentieuxAge === 'EN_ATTENTE') return 'Contentieux d’âge';
    return 'Saisi, à contrôler';
  }
}
