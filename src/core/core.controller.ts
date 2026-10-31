import {
  BadRequestException,
  ForbiddenException,
  Body,
  Controller,
  Get,
  HttpCode,
  Ip,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { Response } from 'express';
import { Not, Repository } from 'typeorm';
import { SessionService } from '../auth/session.service';
import {
  Public,
  Roles,
  Utilisateur as Moi,
  type UtilisateurConnecte,
  TOUS_LES_ROLES,
} from '../auth/auth';
import {
  NOTES_AFFECTATION,
  MOTIFS,
  TYPES_NOTE_AFFECTATION,
  MOTIFS_MUTATION,
} from '../common/referentiels';
import {
  chiffrerCode,
  codeValide,
  dechiffrerCode,
  nouveauCode,
} from '../common/code-personnel';
import {
  Departement,
  Grade,
  RegleDiplome,
  ROLES,
  type Role,
  Utilisateur,
} from '../entities';
import { JournalService, ParametresService } from './core.service';

/** Longueurs maximales : un envoi démesuré est refusé avant tout calcul. */
class ConnexionDto {
  @IsString() @MaxLength(254, { message: 'E-mail trop long.' }) email: string;
  @IsString()
  @MaxLength(128, {
    message: 'Mot de passe trop long (128 caractères au plus).',
  })
  motDePasse: string;
  /** Code personnel de 12 caractères (avec ou sans tirets). */
  @IsOptional()
  @IsString()
  @MaxLength(32, { message: 'Code personnel trop long.' })
  code?: string;
}

/** Voir ou régénérer des codes personnels : l'administrateur ou le DG confirme avec son mot de passe et son code. */
class CodesDto {
  @IsIn(['voir', 'regenerer']) action: 'voir' | 'regenerer';
  /** Comptes choisis ; sans liste : tous les comptes sauf celui qui demande. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsUUID('all', { each: true, message: 'Liste de comptes invalide.' })
  ids?: string[];
  @IsString() @MaxLength(128) motDePasse: string;
  @IsOptional() @IsString() @MaxLength(32) code?: string;
}

class UtilisateurDto {
  @IsEmail({}, { message: 'Adresse e-mail invalide.' })
  @MaxLength(254, { message: 'E-mail trop long.' })
  email: string;
  @IsString()
  @MinLength(2, { message: 'Nom trop court.' })
  @MaxLength(120, { message: 'Nom trop long (120 caractères au plus).' })
  nom: string;
  @IsOptional()
  @IsString()
  @MaxLength(10, { message: 'Initiales : 10 caractères au plus.' })
  initiales?: string;
  @IsIn(ROLES) role: Role;
  @IsOptional() @IsInt() departementId?: number | null;
  /** Structure de l'organigramme (école, inspection, bureau de la DGRHAS…). */
  @IsOptional() @IsInt() structureId?: number | null;
  @IsOptional()
  @IsString()
  @MinLength(8, { message: 'Mot de passe : 8 caractères au moins.' })
  @MaxLength(128, { message: 'Mot de passe : 128 caractères au plus.' })
  motDePasse?: string;
  @IsOptional() @IsBoolean() actif?: boolean;
}

@Controller()
export class CoreController {
  constructor(
    @InjectRepository(Utilisateur)
    private readonly users: Repository<Utilisateur>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    @InjectRepository(RegleDiplome)
    private readonly regles: Repository<RegleDiplome>,
    @InjectRepository(Grade) private readonly grades: Repository<Grade>,
    private readonly sessions: SessionService,
    private readonly journal: JournalService,
    private readonly params: ParametresService,
  ) {}

  /* ------------------------------ Auth ------------------------------ */

  @Public()
  @Post('auth/connexion')
  @HttpCode(200)
  connexion(@Body() dto: ConnexionDto, @Ip() ip: string) {
    return this.sessions.connexion(dto, ip);
  }

  @Roles(...TOUS_LES_ROLES)
  @Get('auth/moi')
  async moi(@Moi() u: UtilisateurConnecte) {
    // Profil relu en base à chaque requête (voir AuthGuard). Le type de sa structure dit au menu si
    // c'est une école ou une structure administrative (besoins en personnel, DG 28/10/2026).
    const [s] = u.structureId
      ? await this.users.query<{ type: string }[]>(
          `SELECT type FROM structure WHERE id = $1`,
          [u.structureId],
        )
      : [];
    return { ...u, structureType: s?.type ?? null };
  }

  /**
   * Fermer ses autres sessions (poste oublié allumé, téléphone perdu…) : celle-ci reste
   * ouverte grâce au nouveau jeton renvoyé.
   */
  @Roles(...TOUS_LES_ROLES)
  @Post('auth/deconnecter-ailleurs')
  @HttpCode(200)
  async deconnecterAilleurs(
    @Moi() moi: UtilisateurConnecte,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.sessions.fermerSessions([moi.id]);
    await this.renouvelerJeton(moi, [moi.id], res);
    await this.journal.log(moi, 'SESSIONS_FERMEES', 'utilisateur', moi.id);
    return { ok: true };
  }

  /**
   * Le mot de passe ne se change pas soi-même (demande du DG) : quelqu'un qui entrerait par hasard
   * dans le compte d'un autre pourrait l'en exclure. On le demande à l'administrateur ou au DG.
   */
  @Roles(...TOUS_LES_ROLES)
  @Post('auth/mot-de-passe')
  changerMotDePasse() {
    throw new ForbiddenException(
      'Le mot de passe est donné par l’administrateur ou le DG : demandez-leur de le changer.',
    );
  }

  /* ---------------- Délégation pendant une absence ---------------- */

  /** Ma délégation (qui agit à ma place) et celles que j'ai reçues. */
  @Roles(...TOUS_LES_ROLES)
  @Get('auth/delegation')
  async delegation(@Moi() moi: UtilisateurConnecte) {
    const u = await this.users.findOne({ where: { id: moi.id } });
    // Choix possibles : les collègues de la même structure (école…), ou les comptes de la DGRHAS
    const candidats = (
      await this.users.find({ where: { actif: true }, order: { nom: 'ASC' } })
    ).filter(
      (x) =>
        x.id !== moi.id &&
        (moi.role === 'STRUCTURE'
          ? !!u?.structureId && x.structureId === u.structureId
          : x.role !== 'STRUCTURE' && x.role !== 'ADMIN'),
    );
    const aujourdhui = new Date().toISOString().slice(0, 10);
    const recues = (
      await this.users.find({ where: { delegueId: moi.id } })
    ).filter((t) => !!t.delegationFin && t.delegationFin >= aujourdhui);
    return {
      delegueId: u?.delegueId ?? null,
      delegationFin: u?.delegationFin ?? null,
      active:
        !!u?.delegueId && !!u.delegationFin && u.delegationFin >= aujourdhui,
      candidats: candidats.map((x) => ({ id: x.id, nom: x.nom })),
      recues: recues.map((t) => ({ nom: t.nom, fin: t.delegationFin })),
    };
  }

  @Roles(...TOUS_LES_ROLES)
  @Put('auth/delegation')
  async deleguer(
    @Moi() moi: UtilisateurConnecte,
    @Body() dto: { delegueId?: string | null; fin?: string | null },
  ) {
    if (!dto.delegueId) {
      await this.users.update(moi.id, { delegueId: null, delegationFin: null });
      await this.journal.log(moi, 'DELEGATION_ARRETEE', 'utilisateur', moi.id);
      return { ok: true };
    }
    if (dto.delegueId === moi.id)
      throw new BadRequestException('Choisissez un collègue.');
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(dto.fin ?? '') ||
      dto.fin! < new Date().toISOString().slice(0, 10)
    )
      throw new BadRequestException(
        'Indiquez la date de fin de la délégation (aujourd’hui ou plus tard).',
      );
    const delegue = await this.users.findOne({
      where: { id: dto.delegueId, actif: true },
    });
    if (!delegue) throw new BadRequestException('Collègue introuvable.');
    const u = await this.users.findOne({ where: { id: moi.id } });
    if (moi.role === 'STRUCTURE' && delegue.structureId !== u?.structureId)
      throw new BadRequestException(
        'Choisissez un collègue de votre structure.',
      );
    await this.users.update(moi.id, {
      delegueId: delegue.id,
      delegationFin: dto.fin!,
    });
    await this.journal.log(moi, 'DELEGATION_DONNEE', 'utilisateur', moi.id, {
      delegue: delegue.nom,
      fin: dto.fin,
    });
    return { ok: true };
  }

  /* --------------------------- Utilisateurs -------------------------- */

  @Roles('ADMIN', 'DG')
  @Get('utilisateurs')
  async listeUtilisateurs() {
    return (await this.users.find({ order: { nom: 'ASC' } })).map((u) => ({
      ...u,
      aCode: !!u.codeCreeLe,
    }));
  }

  /**
   * Voir ou régénérer les codes personnels, d'un compte ou de tous (sauf le sien). Celui qui
   * demande confirme avec son mot de passe et son propre code. Les codes ne vont jamais au journal.
   */
  @Roles('ADMIN', 'DG')
  @Post('utilisateurs/codes')
  async codes(
    @Moi() moi: UtilisateurConnecte,
    @Body() dto: CodesDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const lui = await this.users
      .createQueryBuilder('u')
      .addSelect('u.motDePasseHash')
      .addSelect('u.codeChiffre')
      .where('u.id = :id', { id: moi.id })
      .getOne();
    if (
      !lui ||
      !(await bcrypt.compare(dto.motDePasse ?? '', lui.motDePasseHash)) ||
      (lui.codeChiffre && !codeValide(dto.code, lui.codeChiffre))
    ) {
      await this.journal.log(
        moi,
        'VERIFICATION_CODES_REFUSEE',
        'utilisateur',
        moi.id,
      );
      throw new ForbiddenException(
        'Mot de passe ou code personnel incorrect : les codes ne sont pas affichés.',
      );
    }
    const tous = !dto.ids?.length;
    let cibles = await this.users
      .createQueryBuilder('u')
      .addSelect('u.codeChiffre')
      .where(tous ? 'u.id <> :moi' : 'u.id IN (:...ids)', {
        moi: moi.id,
        ids: dto.ids,
      })
      .orderBy('u.nom', 'ASC')
      .getMany();
    // Le DG ne touche pas aux comptes administrateur
    if (moi.role !== 'ADMIN') {
      if (!tous && cibles.some((c) => c.role === 'ADMIN'))
        throw new ForbiddenException(
          'Seul l’administrateur voit ou change le code d’un administrateur.',
        );
      cibles = cibles.filter((c) => c.role !== 'ADMIN');
    }
    if (!cibles.length) throw new BadRequestException('Aucun compte choisi.');
    const liste: {
      id: string;
      nom: string;
      email: string;
      code: string | null;
    }[] = [];
    for (const c of cibles) {
      if (dto.action === 'regenerer') {
        const code = nouveauCode();
        await this.users.update(c.id, {
          codeChiffre: chiffrerCode(code),
          codeCreeLe: new Date(),
        });
        liste.push({ id: c.id, nom: c.nom, email: c.email, code });
      } else
        liste.push({
          id: c.id,
          nom: c.nom,
          email: c.email,
          code: c.codeChiffre ? dechiffrerCode(c.codeChiffre) : null,
        });
    }
    if (dto.action === 'regenerer') {
      // Code changé : les sessions ouvertes avec l'ancien se ferment (la sienne est renouvelée)
      const ids = cibles.map((c) => c.id);
      await this.sessions.fermerSessions(ids);
      await this.renouvelerJeton(moi, ids, res);
    }
    await this.journal.log(
      moi,
      dto.action === 'regenerer'
        ? 'CODES_PERSONNELS_REGENERES'
        : 'CODES_PERSONNELS_CONSULTES',
      'utilisateur',
      tous ? null : (dto.ids ?? []).join(','),
      { comptes: liste.length, tous },
    );
    return liste;
  }

  @Roles('ADMIN', 'DG')
  @Post('utilisateurs')
  async creerUtilisateur(
    @Moi() moi: UtilisateurConnecte,
    @Body() dto: UtilisateurDto,
  ) {
    if (moi.role !== 'ADMIN' && dto.role === 'ADMIN')
      throw new ForbiddenException(
        'Seul l’administrateur crée un compte administrateur.',
      );
    if (!dto.motDePasse)
      throw new BadRequestException(
        'Mot de passe requis (8 caractères minimum)',
      );
    const email = dto.email.trim().toLowerCase();
    await this.emailLibre(email);
    const code = nouveauCode();
    const u = await this.users.save({
      email,
      nom: dto.nom.trim(),
      initiales: dto.initiales?.trim() || null,
      role: dto.role,
      departementId: dto.departementId ?? null,
      structureId: dto.structureId ?? null,
      actif: dto.actif ?? true,
      motDePasseHash: await bcrypt.hash(dto.motDePasse, 10),
      // Chaque nouveau compte reçoit tout de suite son code personnel
      codeChiffre: chiffrerCode(code),
      codeCreeLe: new Date(),
    });
    await this.journal.log(moi, 'CREATION_UTILISATEUR', 'utilisateur', u.id, {
      email: u.email,
      role: u.role,
    });
    // Le code n'est montré qu'ici (et ensuite après vérification) : à remettre à la personne
    return { ...u, motDePasseHash: undefined, codeChiffre: undefined, code };
  }

  @Roles('ADMIN', 'DG')
  @Put('utilisateurs/:id')
  async modifierUtilisateur(
    @Moi() moi: UtilisateurConnecte,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UtilisateurDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const u = await this.cible(moi, id, dto.role);
    const email = dto.email.trim().toLowerCase();
    if (email !== u.email.toLowerCase()) await this.emailLibre(email, id);
    const actif = dto.actif ?? u.actif;

    // Personne ne se retire lui-même ses droits (fausse manipulation = plus d'accès)
    if (id === moi.id && (dto.role !== u.role || !actif))
      throw new BadRequestException(
        'Vous ne pouvez pas changer votre propre rôle ni désactiver votre propre compte : demandez-le à un autre administrateur.',
      );
    // Il reste toujours au moins un administrateur actif
    if (u.role === 'ADMIN' && u.actif && (dto.role !== 'ADMIN' || !actif))
      await this.garderUnAdministrateur(id);

    const maj: Partial<Utilisateur> = {
      email,
      nom: dto.nom.trim(),
      initiales: dto.initiales?.trim() || null,
      role: dto.role,
      departementId: dto.departementId ?? null,
      structureId: dto.structureId ?? null,
      actif,
    };
    const nouveauMotDePasse = !!dto.motDePasse;
    if (nouveauMotDePasse) {
      maj.motDePasseHash = await bcrypt.hash(dto.motDePasse!, 10);
      // Mot de passe redonné : le blocage pour essais ratés est levé
      maj.echecsConnexion = 0;
      maj.dernierEchec = null;
      maj.bloqueJusqua = null;
    }
    await this.users.update(id, maj);
    // Mot de passe changé ou compte désactivé : ses sessions ouvertes se ferment
    if (nouveauMotDePasse || (u.actif && !actif)) {
      await this.sessions.fermerSessions([id]);
      await this.renouvelerJeton(moi, [id], res);
    }
    await this.journal.log(moi, 'MODIFICATION_UTILISATEUR', 'utilisateur', id, {
      role: dto.role,
      actif,
      ...(nouveauMotDePasse ? { motDePasse: 'changé' } : {}),
    });
    return this.users.findOne({ where: { id } });
  }

  /** Lève le blocage d'un compte après trop d'essais ratés. */
  @Roles('ADMIN', 'DG')
  @Post('utilisateurs/:id/debloquer')
  @HttpCode(200)
  async debloquerUtilisateur(
    @Moi() moi: UtilisateurConnecte,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.cible(moi, id);
    await this.sessions.debloquer(id);
    await this.journal.log(moi, 'COMPTE_DEBLOQUE', 'utilisateur', id);
    return { ok: true };
  }

  /** Ferme toutes les sessions ouvertes d'un compte (poste volé, départ…). */
  @Roles('ADMIN', 'DG')
  @Post('utilisateurs/:id/deconnecter')
  @HttpCode(200)
  async deconnecterUtilisateur(
    @Moi() moi: UtilisateurConnecte,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.cible(moi, id);
    await this.sessions.fermerSessions([id]);
    await this.renouvelerJeton(moi, [id], res);
    await this.journal.log(moi, 'SESSIONS_FERMEES', 'utilisateur', id);
    return { ok: true };
  }

  /** Compte visé par une action d'administration ; le DG ne touche pas aux administrateurs. */
  private async cible(
    moi: UtilisateurConnecte,
    id: string,
    nouveauRole?: Role,
  ) {
    const u = await this.users.findOne({ where: { id } });
    if (!u) throw new NotFoundException('Compte introuvable.');
    if (moi.role !== 'ADMIN' && (u.role === 'ADMIN' || nouveauRole === 'ADMIN'))
      throw new ForbiddenException(
        'Seul l’administrateur modifie un compte administrateur.',
      );
    return u;
  }

  /** E-mail déjà pris par un autre compte (sans tenir compte des majuscules) ? */
  private async emailLibre(email: string, saufId?: string) {
    const pris = await this.users
      .createQueryBuilder('u')
      .where('lower(u.email) = :e', { e: email })
      .andWhere(saufId ? 'u.id <> :id' : 'TRUE', { id: saufId })
      .getExists();
    if (pris) throw new BadRequestException('Cet e-mail est déjà utilisé.');
  }

  /** Refuse de retirer le dernier administrateur actif. */
  private async garderUnAdministrateur(saufId: string) {
    const autres = await this.users.count({
      where: { role: 'ADMIN', actif: true, id: Not(saufId) },
    });
    if (!autres)
      throw new BadRequestException(
        'C’est le dernier administrateur actif : créez ou activez d’abord un autre administrateur.',
      );
  }

  /**
   * Ses propres sessions viennent d'être fermées (son code ou son mot de passe a changé) :
   * un nouveau jeton est renvoyé dans l'en-tête X-Jeton, pour rester connecté sur ce poste.
   */
  private async renouvelerJeton(
    moi: UtilisateurConnecte,
    ids: string[],
    res: Response,
  ) {
    if (ids.includes(moi.id))
      res.setHeader('X-Jeton', await this.sessions.jetonPour(moi.id));
  }

  /* --------------------------- Référentiels -------------------------- */

  @Roles(...TOUS_LES_ROLES)
  @Get('referentiels')
  async referentiels() {
    return {
      departements: await this.deps.find({ order: { ordre: 'ASC' } }),
      regles: await this.regles.find({ order: { code: 'ASC' } }),
      grades: await this.grades.find({ order: { libelle: 'ASC' } }),
      typesNote: TYPES_NOTE_AFFECTATION.map((code) => ({
        code,
        libelle: NOTES_AFFECTATION[code].libelle,
      })),
      motifs: MOTIFS_MUTATION.map((code) => ({
        code,
        libelle: MOTIFS[code].libelle,
      })),
      roles: ROLES,
    };
  }

  /* ---------------------------- Paramètres --------------------------- */

  @Get('parametres')
  parametres() {
    return this.params.tous();
  }

  @Roles('DG')
  @Put('parametres/:cle')
  async definirParametre(
    @Moi() moi: UtilisateurConnecte,
    @Param('cle') cle: string,
    @Body() body: { valeur: string },
  ) {
    if (typeof body?.valeur !== 'string')
      throw new BadRequestException('valeur requise');
    await this.params.definir(cle, body.valeur.trim());
    await this.journal.log(moi, 'MODIFICATION_PARAMETRE', 'parametre', cle, {
      valeur: body.valeur,
    });
    return { ok: true };
  }

  /* ------------------------------ Journal ---------------------------- */

  @Roles('ADMIN', 'DG', 'DIRECTEUR')
  @Get('journal')
  journalListe(
    @Query('entite') entite?: string,
    @Query('entiteId') entiteId?: string,
  ) {
    return this.journal.liste(300, entite, entiteId);
  }
}
