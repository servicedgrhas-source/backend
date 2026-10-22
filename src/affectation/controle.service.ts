import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { lireClasseur } from '../common/excel';
import { lireDate, nettoyer, normaliser } from '../common/texte';
import { JournalService } from '../core/core.service';
import { Affectation, Agent, NoteService, ReferenceNote } from '../entities';

/** Motif posé sur une affectation retirée parce que la personne est déjà dans une note signée. */
export const MOTIF_DEJA_AFFECTE = 'Déjà affecté hors système';

/** « 270 du 08/04/2026 BZ » → n° 270, date 2026-04-08 (tolère « 08/004/2026 »). */
export function lireReference(brut: string): {
  numero: string | null;
  date: string | null;
} {
  const m =
    /^\s*(\d+)\s*(?:du\s*(\d{1,2})\s*\/\s*(\d{1,3})\s*\/\s*(\d{4}))?/i.exec(
      brut,
    );
  if (!m) return { numero: null, date: null };
  let date: string | null = null;
  if (m[2]) {
    const [j, mo, a] = [Number(m[2]), Number(m[3]), Number(m[4])];
    if (j >= 1 && j <= 31 && mo >= 1 && mo <= 12)
      date = `${a}-${String(mo).padStart(2, '0')}-${String(j).padStart(2, '0')}`;
  }
  return { numero: String(Number(m[1])), date };
}

interface LigneControle {
  ligne: number;
  feuille: string;
  nom: string;
  naissance: string | null;
  numeroTexte: string | null;
  references: string[];
  lieuAffectation: string | null;
  service: string | null;
  lieuService: string | null;
}

export interface RapportControle {
  feuilles: string[];
  lignes: number;
  avecReference: number;
  retrouvees: number;
  /** Personnes du fichier introuvables dans la base (à vérifier). */
  introuvables: {
    ligne: number;
    feuille: string;
    nom: string;
    numeroTexte: string | null;
  }[];
  references: number;
  notes: number;
  doubles: number;
  /** Personnes retirées des notes à préparer (déjà affectées). */
  retirees?: number;
  remisesATraiter?: number;
}

@Injectable()
export class ControleAffectationsService {
  constructor(
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
    @InjectRepository(Affectation)
    private readonly affectations: Repository<Affectation>,
    @InjectRepository(NoteService)
    private readonly notes: Repository<NoteService>,
    @InjectRepository(ReferenceNote)
    private readonly refs: Repository<ReferenceNote>,
    private readonly journal: JournalService,
  ) {}

  /** Lit le fichier de contrôle : toutes les feuilles qui ont « Ref affectation ». */
  private async lire(contenu: Buffer) {
    const feuilles = await lireClasseur(contenu, [
      'NOMSETPRENOMS',
      'REFAFFECTATION',
    ]);
    if (!feuilles.length)
      throw new BadRequestException(
        'Aucune feuille avec les colonnes « Noms et prénoms » et « Ref affectation » : ce n’est pas un fichier de contrôle des affectations.',
      );
    const lignes: LigneControle[] = [];
    for (const f of feuilles)
      for (const l of f.lignes) {
        const nom = nettoyer(l.NOMSETPRENOMS);
        if (!nom || /^noms?\s*et\s*pr/i.test(nom)) continue;
        const references = [l.REFAFFECTATION, l.REFAFFECTATION2]
          .map((x) => nettoyer(x))
          .filter((x): x is string => !!x && /\d/.test(x));
        lignes.push({
          ligne: l._ligne,
          feuille: f.nom,
          nom,
          naissance: lireDate(l.DATEDENAIS ?? l.DATEDENAISSANCE),
          numeroTexte: nettoyer(l.NTEXTE ?? l.NDETEXTE),
          references,
          lieuAffectation: nettoyer(l.LIEUAFFECTATION),
          service: nettoyer(l.SERVICE),
          lieuService: nettoyer(l.LIEUDESERVICE),
        });
      }
    return { feuilles: feuilles.map((f) => f.nom), lignes };
  }

  /** Retrouve chaque ligne dans la base : n° de texte d'abord, puis nom + date de naissance. */
  private async rapprocher(lignes: LigneControle[]) {
    const tous = await this.agents.find({
      select: ['id', 'nomNormalise', 'dateNaissance', 'numeroTexte'],
    });
    const parTexte = new Map<string, Agent[]>();
    const parNom = new Map<string, Agent[]>();
    for (const a of tous) {
      if (a.numeroTexte) {
        const k = a.numeroTexte.trim();
        parTexte.set(k, [...(parTexte.get(k) ?? []), a]);
      }
      parNom.set(a.nomNormalise, [...(parNom.get(a.nomNormalise) ?? []), a]);
    }
    return lignes.map((l) => {
      const nom = normaliser(l.nom);
      const parT = l.numeroTexte ? (parTexte.get(l.numeroTexte) ?? []) : [];
      const agent =
        (parT.length === 1
          ? parT[0]
          : parT.find((a) => a.nomNormalise === nom)) ??
        (parNom.get(nom) ?? []).find(
          (a) => !!l.naissance && a.dateNaissance === l.naissance,
        ) ??
        ((parNom.get(nom) ?? []).length === 1
          ? parNom.get(nom)![0]
          : undefined);
      return { ...l, agentId: agent?.id ?? null };
    });
  }

  async analyser(contenu: Buffer): Promise<RapportControle> {
    const { feuilles, lignes } = await this.lire(contenu);
    const rapprochees = await this.rapprocher(lignes);
    return this.rapport(feuilles, rapprochees);
  }

  private rapport(
    feuilles: string[],
    lignes: (LigneControle & { agentId: string | null })[],
  ): RapportControle {
    const avec = lignes.filter((l) => l.references.length);
    const notes = new Set(
      avec.flatMap((l) =>
        l.references.map((r) => lireReference(r).numero ?? r),
      ),
    );
    return {
      feuilles,
      lignes: lignes.length,
      avecReference: avec.length,
      retrouvees: avec.filter((l) => l.agentId).length,
      introuvables: avec
        .filter((l) => !l.agentId)
        .map((l) => ({
          ligne: l.ligne,
          feuille: l.feuille,
          nom: l.nom,
          numeroTexte: l.numeroTexte,
        })),
      references: avec.reduce((n, l) => n + l.references.length, 0),
      notes: notes.size,
      doubles: avec.filter((l) => l.references.length > 1).length,
    };
  }

  /**
   * Enregistre les références : la personne est « affectée hors système » ; si elle attend
   * encore une note, elle en est retirée avec le motif « Déjà affecté hors système ».
   * Réimporter le même fichier remplace ses références (pas de doublon).
   */
  async importer(u: UtilisateurConnecte, contenu: Buffer, nomFichier: string) {
    const { feuilles, lignes } = await this.lire(contenu);
    const rapprochees = await this.rapprocher(lignes);
    const rapport = this.rapport(feuilles, rapprochees);
    const source = nomFichier.replace(/\.xlsx$/i, '');
    const anciens = await this.refs.find({ where: { source } });
    await this.refs.delete({ source });
    const aGarder = new Map<string, Partial<ReferenceNote>>();
    for (const l of rapprochees) {
      if (!l.agentId) continue;
      for (const brut of l.references) {
        const { numero, date } = lireReference(brut);
        aGarder.set(`${l.agentId}|${brut}`, {
          agentId: l.agentId,
          brut,
          numero,
          date,
          lieuAffectation: l.lieuAffectation,
          service: l.service,
          lieuService: l.lieuService,
          source,
          importePar: u.nom,
        });
      }
    }
    const nouvelles = [...aGarder.values()];
    for (let i = 0; i < nouvelles.length; i += 500)
      await this.refs
        .createQueryBuilder()
        .insert()
        .values(nouvelles.slice(i, i + 500))
        .orIgnore()
        .execute();

    // Retirées des notes à préparer : elles sont déjà dans une note signée
    const avecRef = [...new Set(nouvelles.map((r) => r.agentId!))];
    let retirees = 0;
    for (let i = 0; i < avecRef.length; i += 500) {
      const aff = await this.affectations.find({
        where: { agentId: In(avecRef.slice(i, i + 500)), statut: 'A_TRAITER' },
        loadEagerRelations: false,
      });
      for (const a of aff) {
        const premiere = nouvelles.find((r) => r.agentId === a.agentId)!;
        await this.affectations.update(a.id, {
          statut: 'EXCLU',
          motifExclusion: `${MOTIF_DEJA_AFFECTE} : note n° ${premiere.brut}`,
          traitePar: u.initiales ?? u.nom,
        });
        retirees++;
      }
    }
    // Personnes qui n'ont plus aucune référence (fichier corrigé) : de nouveau à traiter
    const perdues = [
      ...new Set(
        anciens.map((r) => r.agentId).filter((id) => !avecRef.includes(id)),
      ),
    ];
    let remisesATraiter = 0;
    for (const agentId of perdues) {
      if (await this.refs.count({ where: { agentId } })) continue;
      const a = await this.affectations.findOne({
        where: { agentId, statut: 'EXCLU' },
        loadEagerRelations: false,
      });
      if (a?.motifExclusion?.startsWith(MOTIF_DEJA_AFFECTE)) {
        await this.affectations.update(a.id, {
          statut: 'A_TRAITER',
          motifExclusion: null,
        });
        remisesATraiter++;
      }
    }
    const final = { ...rapport, retirees, remisesATraiter };
    await this.journal.log(u, 'IMPORT_REFERENCES_NOTES', 'agent', null, {
      fichier: nomFichier,
      references: rapport.references,
      personnes: rapport.retrouvees,
      introuvables: rapport.introuvables.length,
      retirees,
    });
    return final;
  }

  /** Notes connues pour chaque personne : hors système (références) et dans le système. */
  private async notesParPersonne(agentIds?: string[]) {
    const refs = await this.refs.find(
      agentIds
        ? {
            where: {
              agentId: In(
                agentIds.concat('00000000-0000-0000-0000-000000000000'),
              ),
            },
          }
        : {},
    );
    const q = this.affectations
      .createQueryBuilder('f')
      .innerJoin(NoteService, 'n', 'n.id = f.noteId')
      .select([
        'f.agentId AS "agentId"',
        'n.id AS "noteId"',
        'n.numero AS numero',
        'n.statut AS statut',
        'n.dateSignature AS "dateSignature"',
      ])
      .where("n.statut IN ('VALIDEE','SIGNEE')");
    if (agentIds)
      q.andWhere('f.agentId IN (:...ids)', {
        ids: agentIds.concat('00000000-0000-0000-0000-000000000000'),
      });
    const systeme = await q.getRawMany<{
      agentId: string;
      noteId: string;
      numero: string | null;
      statut: string;
      dateSignature: string | null;
    }>();
    const m = new Map<
      string,
      { refs: ReferenceNote[]; systeme: typeof systeme }
    >();
    for (const r of refs) {
      const e = m.get(r.agentId) ?? { refs: [], systeme: [] };
      e.refs.push(r);
      m.set(r.agentId, e);
    }
    for (const s of systeme) {
      const e = m.get(s.agentId) ?? { refs: [], systeme: [] };
      e.systeme.push(s);
      m.set(s.agentId, e);
    }
    return m;
  }

  /** Personnes affectées deux fois (deux notes différentes, ou deux fois dans la même note). */
  async doubles() {
    const m = await this.notesParPersonne();
    // Même n° de note dans le fichier et dans le système : c'est la même note, pas un double
    const genre = (e: {
      refs: ReferenceNote[];
      systeme: { numero: string | null; noteId: string }[];
    }) => {
      const numeros = new Set([
        ...e.refs.map((r) => r.numero ?? r.brut),
        ...e.systeme.map((x) => x.numero ?? `système ${x.noteId}`),
      ]);
      if (numeros.size > 1) return 'DEUX_NOTES' as const;
      const parNumero = new Map<string, number>();
      for (const r of e.refs)
        parNumero.set(
          r.numero ?? r.brut,
          (parNumero.get(r.numero ?? r.brut) ?? 0) + 1,
        );
      return [...parNumero.values()].some((n) => n > 1)
        ? ('MEME_NOTE' as const)
        : null;
    };
    const ids = [...m.entries()].filter(([, e]) => genre(e)).map(([id]) => id);
    if (!ids.length) return [];
    const agents = await this.agents.find({ where: { id: In(ids) } });
    return agents
      .map((a) => {
        const e = m.get(a.id)!;
        return {
          agentId: a.id,
          nomComplet: a.nomComplet,
          quota: a.feuille === 'QUOTA_AUTRES' ? 'Autres' : a.quota,
          numeroTexte: a.numeroTexte,
          departement: a.departement?.nom ?? null,
          genre: genre(e),
          horsSysteme: e.refs.map((r) => ({
            brut: r.brut,
            lieuAffectation: r.lieuAffectation,
            source: r.source,
          })),
          systeme: e.systeme.map((s) => ({
            noteId: s.noteId,
            numero: s.numero,
            statut: s.statut,
          })),
        };
      })
      .sort((x, y) => x.nomComplet.localeCompare(y.nomComplet, 'fr'));
  }

  /** Vue d'ensemble : personnes affectées hors système, notes connues, doubles, fichiers importés. */
  async resume() {
    const [personnes, notes, sources] = await Promise.all([
      this.refs
        .createQueryBuilder('r')
        .select('count(DISTINCT r.agentId)::int', 'n')
        .getRawOne<{ n: number }>(),
      this.refs
        .createQueryBuilder('r')
        .select('coalesce(r.numero, r.brut)', 'numero')
        .addSelect('min(r.date)', 'date')
        .addSelect('count(DISTINCT r.agentId)::int', 'personnes')
        .groupBy('coalesce(r.numero, r.brut)')
        .orderBy('min(r.date)', 'ASC', 'NULLS LAST')
        .getRawMany<{
          numero: string;
          date: string | null;
          personnes: number;
        }>(),
      this.refs
        .createQueryBuilder('r')
        .select('r.source', 'source')
        .addSelect('count(*)::int', 'references')
        .addSelect('max(r.creeLe)', 'le')
        .addSelect('max(r.importePar)', 'par')
        .groupBy('r.source')
        .getRawMany(),
    ]);
    return {
      personnes: personnes?.n ?? 0,
      notes,
      sources,
      doubles: (await this.doubles()).length,
    };
  }

  /** Notes hors système d'une personne (fiche du dossier). */
  async referencesDe(agentId: string) {
    return this.refs.find({ where: { agentId }, order: { date: 'ASC' } });
  }

  /** Personnes affectées hors système (pour les statistiques). */
  async agentsAvecReference(): Promise<Set<string>> {
    const r = await this.refs
      .createQueryBuilder('r')
      .select('DISTINCT r.agentId', 'agentId')
      .getRawMany<{ agentId: string }>();
    return new Set(r.map((x) => x.agentId));
  }
}
