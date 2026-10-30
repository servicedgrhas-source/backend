import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ROLES_TRAITEMENT, type UtilisateurConnecte } from '../auth/auth';
import { posteResponsable } from '../circuit/catalogue';
import { cleCompacte } from '../common/texte';
import { JournalService } from '../core/core.service';
import {
  BesoinPersonnel,
  CadreOrganique,
  Referentiel,
  Structure,
} from '../entities';
import { RecensementService } from '../recensement/recensement.service';
import { EtablissementsService } from './etablissements.service';

/** Postes proposés quand le référentiel « Postes et fonctions » n'en donne pas assez. */
const POSTES_COURANTS = [
  'Directeur',
  'Chef de service',
  'Chef de bureau',
  'Collaborateur',
  'Secrétaire',
  'Agent de saisie',
  'Comptable',
  'Planton',
  'Chauffeur',
];

const STATUTS = ['EN_ATTENTE', 'ACCORDE', 'REFUSE'];

/**
 * Besoins en personnel des structures administratives (DG, 28/10/2026) : chaque structure (direction,
 * service, bureau, DDEPPSA, inspection…) fixe à l'avance l'effectif normal de chaque poste (cadre
 * organique) et exprime ses besoins ; la DGRHAS les voit, les compare au cadre et décide.
 */
@Injectable()
export class BesoinsAdministratifsService {
  constructor(
    @InjectRepository(CadreOrganique)
    private readonly cadres: Repository<CadreOrganique>,
    @InjectRepository(BesoinPersonnel)
    private readonly besoins: Repository<BesoinPersonnel>,
    @InjectRepository(Structure)
    private readonly structures: Repository<Structure>,
    @InjectRepository(Referentiel)
    private readonly refs: Repository<Referentiel>,
    private readonly etab: EtablissementsService,
    private readonly rec: RecensementService,
    private readonly journal: JournalService,
  ) {}

  private dgrhas(u: UtilisateurConnecte) {
    return u.role === 'ADMIN' || ROLES_TRAITEMENT.includes(u.role);
  }

  /** Structure du périmètre, administrative (pas une école : elles ont leurs propres besoins). */
  private async structure(u: UtilisateurConnecte, id: number) {
    const s = await this.etab.structure(u, id);
    if (s.type === 'ETABLISSEMENT')
      throw new BadRequestException(
        'Les besoins des écoles se calculent à partir des classes : voir « Besoins en enseignants ».',
      );
    return s;
  }

  /** Postes à choisir : le référentiel « Postes et fonctions », puis les postes courants. */
  async postes() {
    const ref = await this.refs.find({
      where: { type: 'POSTE', actif: true },
      order: { ordre: 'ASC', libelle: 'ASC' },
    });
    const vus = new Set<string>();
    const res: string[] = [];
    for (const p of [...POSTES_COURANTS, ...ref.map((r) => r.libelle)]) {
      const k = cleCompacte(p);
      if (!k || vus.has(k)) continue;
      vus.add(k);
      res.push(p);
    }
    return res;
  }

  /**
   * Situation d'une structure : pour chaque poste, l'effectif normal, l'effectif en poste (d'après la
   * « fonction dans la structure » de chaque fiche) et ce qui est demandé ; puis ses demandes.
   */
  async situation(u: UtilisateurConnecte, id: number) {
    const s = await this.structure(u, id);
    const [cadre, demandes, agents] = await Promise.all([
      this.cadres.find({ where: { structureId: id }, order: { poste: 'ASC' } }),
      this.besoins.find({
        where: { structureId: id },
        order: { creeLe: 'DESC' },
      }),
      this.etab.agentsDe([id]),
    ]);
    const enPoste = agents.get(id)?.filter((a) => a.enPoste) ?? [];
    const responsable = posteResponsable(s);
    // Poste de chaque agent : sa fonction dans la structure (le responsable : le poste de la structure)
    const posteDe = (a: { id: number; fonctionStructure: string | null }) =>
      a.id === s.responsableId ? responsable : (a.fonctionStructure ?? '');
    const compte = (poste: string) => {
      const k = cleCompacte(poste);
      return enPoste.filter((a) => {
        const p = cleCompacte(posteDe(a));
        return !!p && (p === k || p.startsWith(k) || k.startsWith(p));
      }).length;
    };
    const postes = new Map<string, string>();
    for (const c of cadre) postes.set(cleCompacte(c.poste), c.poste);
    for (const d of demandes)
      if (d.statut === 'EN_ATTENTE' && !postes.has(cleCompacte(d.poste)))
        postes.set(cleCompacte(d.poste), d.poste);
    const lignes = [...postes.values()].map((poste) => {
      const normal =
        cadre.find((c) => cleCompacte(c.poste) === cleCompacte(poste))
          ?.effectif ?? null;
      const present = compte(poste);
      const demande = demandes
        .filter(
          (d) =>
            d.statut === 'EN_ATTENTE' &&
            cleCompacte(d.poste) === cleCompacte(poste),
        )
        .reduce((t, d) => t + d.nombre, 0);
      return {
        poste,
        normal,
        enPoste: present,
        // Ce qui manque par rapport au cadre (négatif : en surnombre)
        manque: normal === null ? null : normal - present,
        demande,
      };
    });
    return {
      structure: {
        id: s.id,
        nom: s.nom,
        sigle: s.sigle,
        type: s.type,
        posteResponsable: responsable,
      },
      peutModifierCadre: this.peutGerer(u, s.id),
      peutDecider: this.dgrhas(u),
      lignes,
      enPoste: enPoste.length,
      sansFonction: enPoste.filter((a) => !posteDe(a)).length,
      demandes: demandes.map((d) => this.vue(d, lignes)),
    };
  }

  /** La DGRHAS et la structure elle-même (son chef) gèrent son cadre et ses demandes. */
  private peutGerer(u: UtilisateurConnecte, structureId: number) {
    return (
      this.dgrhas(u) ||
      u.role === 'DDEPPSA' ||
      (u.role === 'STRUCTURE' && u.structureId === structureId)
    );
  }

  private vue(
    d: BesoinPersonnel,
    lignes: { poste: string; normal: number | null; enPoste: number }[],
  ) {
    const l = lignes.find((x) => cleCompacte(x.poste) === cleCompacte(d.poste));
    // Au-delà du cadre : en poste + demandé > effectif normal
    const depasse = l?.normal != null ? l.enPoste + d.nombre > l.normal : false;
    return {
      id: d.id,
      structureId: d.structureId,
      poste: d.poste,
      nombre: d.nombre,
      motif: d.motif,
      statut: d.statut,
      nombreAccorde: d.nombreAccorde,
      decision: d.decision,
      decidePar: d.decidePar,
      decideLe: d.decideLe,
      creePar: d.creePar,
      creeLe: d.creeLe,
      normal: l?.normal ?? null,
      enPoste: l?.enPoste ?? null,
      depasse,
    };
  }

  /** Effectif normal de chaque poste (remplace le cadre précédent). */
  async fixerCadre(
    u: UtilisateurConnecte,
    id: number,
    lignes: { poste: string; effectif: number }[],
  ) {
    const s = await this.structure(u, id);
    if (!this.peutGerer(u, s.id))
      throw new ForbiddenException(
        'Seuls la DGRHAS, la DDEPPSA et le responsable de la structure fixent son cadre.',
      );
    if (!Array.isArray(lignes))
      throw new BadRequestException('Cadre invalide.');
    const propres = new Map<string, { poste: string; effectif: number }>();
    for (const l of lignes) {
      const poste = String(l?.poste ?? '')
        .trim()
        .replace(/\s+/g, ' ');
      const effectif = Number(l?.effectif);
      if (!poste) continue;
      if (!Number.isInteger(effectif) || effectif < 0 || effectif > 500)
        throw new BadRequestException(
          `Effectif de « ${poste} » : un nombre entier de 0 à 500.`,
        );
      propres.set(cleCompacte(poste), { poste, effectif });
    }
    await this.cadres.manager.transaction(async (m) => {
      await m.delete(CadreOrganique, { structureId: id });
      if (propres.size)
        await m.save(
          CadreOrganique,
          [...propres.values()].map((l) => ({
            structureId: id,
            ...l,
            modifiePar: u.nom,
          })),
        );
    });
    await this.journal.log(u, 'CADRE_ORGANIQUE', 'structure', String(id), {
      postes: [...propres.values()],
    });
    return this.situation(u, id);
  }

  /** La structure exprime un besoin : tel poste, tant de personnes, pourquoi. */
  async exprimer(
    u: UtilisateurConnecte,
    id: number,
    dto: { poste: string; nombre: number; motif: string },
  ) {
    const s = await this.structure(u, id);
    if (!this.peutGerer(u, s.id))
      throw new ForbiddenException(
        'Seuls la structure elle-même, la DDEPPSA et la DGRHAS expriment ses besoins.',
      );
    const poste = String(dto?.poste ?? '')
      .trim()
      .replace(/\s+/g, ' ');
    const nombre = Number(dto?.nombre);
    const motif = String(dto?.motif ?? '').trim();
    if (!poste) throw new BadRequestException('Choisissez le poste.');
    if (!Number.isInteger(nombre) || nombre < 1 || nombre > 100)
      throw new BadRequestException(
        'Indiquez le nombre de personnes (de 1 à 100).',
      );
    if (motif.length < 5)
      throw new BadRequestException(
        'Dites en quelques mots pourquoi ce besoin (départ, création du bureau, surcharge…).',
      );
    const b = await this.besoins.save({
      structureId: id,
      poste,
      nombre,
      motif,
      statut: 'EN_ATTENTE',
      creePar: u.nom,
      creeParId: u.id,
    });
    await this.journal.log(u, 'BESOIN_PERSONNEL', 'structure', String(id), {
      poste,
      nombre,
    });
    return b;
  }

  /** Retirer une demande pas encore traitée (par la structure ou la DGRHAS). */
  async retirer(u: UtilisateurConnecte, id: number) {
    const b = await this.besoins.findOne({ where: { id } });
    if (!b) throw new NotFoundException('Demande introuvable');
    await this.structure(u, b.structureId);
    if (!this.peutGerer(u, b.structureId))
      throw new ForbiddenException('Vous ne pouvez pas retirer cette demande.');
    if (b.statut !== 'EN_ATTENTE')
      throw new BadRequestException(
        'Cette demande a déjà reçu une réponse : elle ne se retire plus.',
      );
    await this.besoins.delete(id);
    await this.journal.log(
      u,
      'BESOIN_RETIRE',
      'structure',
      String(b.structureId),
      {
        poste: b.poste,
        nombre: b.nombre,
      },
    );
    return { ok: true };
  }

  /** Réponse de la DGRHAS : accordé (en tout ou en partie) ou refusé, avec le motif. */
  async decider(
    u: UtilisateurConnecte,
    id: number,
    dto: { decision: string; nombreAccorde?: number; commentaire?: string },
  ) {
    if (!this.dgrhas(u))
      throw new ForbiddenException('Seule la DGRHAS répond aux besoins.');
    const b = await this.besoins.findOne({ where: { id } });
    if (!b) throw new NotFoundException('Demande introuvable');
    if (b.statut !== 'EN_ATTENTE')
      throw new BadRequestException('Cette demande a déjà reçu une réponse.');
    const commentaire = String(dto?.commentaire ?? '').trim() || null;
    if (dto?.decision === 'REFUSE') {
      if (!commentaire)
        throw new BadRequestException(
          'Dites pourquoi la demande est refusée (par exemple : au-delà du cadre organique).',
        );
      Object.assign(b, { statut: 'REFUSE', nombreAccorde: 0 });
    } else if (dto?.decision === 'ACCORDE') {
      const n = Number(dto.nombreAccorde ?? b.nombre);
      if (!Number.isInteger(n) || n < 1 || n > b.nombre)
        throw new BadRequestException(
          `Nombre accordé : de 1 à ${b.nombre} (le nombre demandé).`,
        );
      Object.assign(b, { statut: 'ACCORDE', nombreAccorde: n });
    } else throw new BadRequestException('Choisissez : accorder ou refuser.');
    Object.assign(b, {
      decision: commentaire,
      decidePar: u.nom,
      decideLe: new Date(),
    });
    await this.besoins.save(b);
    await this.journal.log(
      u,
      'BESOIN_DECISION',
      'structure',
      String(b.structureId),
      {
        poste: b.poste,
        nombre: b.nombre,
        statut: b.statut,
        nombreAccorde: b.nombreAccorde,
      },
    );
    return { ok: true };
  }

  /** Toutes les demandes du périmètre (DGRHAS : toutes ; DDEPPSA : son département ; chef : la sienne). */
  async liste(
    u: UtilisateurConnecte,
    f: { statut?: string; departement?: number },
  ) {
    const p = await this.rec.perimetre(u);
    const demandes = await this.besoins.find({ order: { creeLe: 'DESC' } });
    const ids = [...new Set(demandes.map((d) => d.structureId))];
    const structures = new Map(
      (ids.length
        ? await this.structures.find({ where: { id: In(ids) } })
        : []
      ).map((s) => [s.id, s]),
    );
    const visibles = demandes.filter((d) => {
      const s = structures.get(d.structureId);
      if (!s) return false;
      if (f.departement && s.departementId !== f.departement) return false;
      return (
        'tous' in p ||
        ('departementId' in p
          ? s.departementId === p.departementId
          : p.structures.includes(s.id))
      );
    });
    // Cadre et effectif en poste de chaque structure concernée, pour comparer
    const situations = new Map<
      number,
      Awaited<ReturnType<typeof this.situation>>
    >();
    for (const id of new Set(visibles.map((d) => d.structureId)))
      situations.set(id, await this.situation(u, id));
    const lignes = visibles.map((d) => {
      const s = structures.get(d.structureId)!;
      return {
        ...this.vue(d, situations.get(d.structureId)!.lignes),
        structure: s.nom,
        sigle: s.sigle,
      };
    });
    const compter = (st: string) =>
      lignes.filter((l) => l.statut === st).length;
    return {
      lignes:
        f.statut && STATUTS.includes(f.statut)
          ? lignes.filter((l) => l.statut === f.statut)
          : lignes,
      enAttente: compter('EN_ATTENTE'),
      accordees: compter('ACCORDE'),
      refusees: compter('REFUSE'),
      peutDecider: this.dgrhas(u),
    };
  }
}
