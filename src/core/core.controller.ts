import {
  BadRequestException,
  ForbiddenException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { Repository } from 'typeorm';
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
  RegleDiplome,
  ROLES,
  type Role,
  Utilisateur,
} from '../entities';
import { JournalService, ParametresService } from './core.service';

class ConnexionDto {
  @IsString() email: string;
  @IsString() motDePasse: string;
  /** Code personnel de 12 caractères (avec ou sans tirets). */
  @IsOptional() @IsString() code?: string;
}

/** Voir ou régénérer des codes personnels : l'administrateur ou le DG confirme avec son mot de passe et son code. */
class CodesDto {
  @IsIn(['voir', 'regenerer']) action: 'voir' | 'regenerer';
  /** Comptes choisis ; sans liste : tous les comptes sauf celui qui demande. */
  @IsOptional() @IsString({ each: true }) ids?: string[];
  @IsString() motDePasse: string;
  @IsOptional() @IsString() code?: string;
}

class UtilisateurDto {
  @IsEmail() email: string;
  @IsString() @MinLength(2) nom: string;
  @IsOptional() @IsString() initiales?: string;
  @IsIn(ROLES) role: Role;
  @IsOptional() @IsInt() departementId?: number | null;
  /** Structure de l'organigramme (école, inspection, bureau de la DGRHAS…). */
  @IsOptional() @IsInt() structureId?: number | null;
  @IsOptional() @IsString() @MinLength(8) motDePasse?: string;
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
    private readonly jwt: JwtService,
    private readonly journal: JournalService,
    private readonly params: ParametresService,
  ) {}

  /* ------------------------------ Auth ------------------------------ */

  @Public()
  @Post('auth/connexion')
  async connexion(@Body() dto: ConnexionDto) {
    const u = await this.users
      .createQueryBuilder('u')
      .addSelect('u.motDePasseHash')
      .addSelect('u.codeChiffre')
      .where('lower(u.email) = lower(:e)', { e: dto.email.trim() })
      .getOne();
    if (
      !u ||
      !u.actif ||
      !(await bcrypt.compare(dto.motDePasse, u.motDePasseHash))
    )
      throw new UnauthorizedException('Identifiants incorrects');
    // Troisième verrou : même avec l'e-mail et le mot de passe de quelqu'un, il faut son code
    if (u.codeChiffre && !codeValide(dto.code, u.codeChiffre)) {
      await this.journal.log(
        { id: u.id, nom: u.nom } as UtilisateurConnecte,
        'CONNEXION_REFUSEE_CODE',
        'utilisateur',
        u.id,
      );
      throw new UnauthorizedException(
        dto.code?.trim()
          ? 'Code personnel incorrect. Vérifiez les 12 caractères (ex. T3G8-GH6J-FG3U).'
          : 'Tapez votre code personnel de 12 caractères (remis par l’administrateur).',
      );
    }
    const profil: UtilisateurConnecte = {
      id: u.id,
      email: u.email,
      nom: u.nom,
      initiales: u.initiales,
      role: u.role,
      departementId: u.departementId,
      structureId: u.structureId,
    };
    await this.journal.log(profil, 'CONNEXION', 'utilisateur', u.id);
    return { jeton: await this.jwt.signAsync(profil), utilisateur: profil };
  }

  @Roles(...TOUS_LES_ROLES)
  @Get('auth/moi')
  moi(@Moi() u: UtilisateurConnecte) {
    return u;
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
  async codes(@Moi() moi: UtilisateurConnecte, @Body() dto: CodesDto) {
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
    const res: {
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
        res.push({ id: c.id, nom: c.nom, email: c.email, code });
      } else
        res.push({
          id: c.id,
          nom: c.nom,
          email: c.email,
          code: c.codeChiffre ? dechiffrerCode(c.codeChiffre) : null,
        });
    }
    await this.journal.log(
      moi,
      dto.action === 'regenerer'
        ? 'CODES_PERSONNELS_REGENERES'
        : 'CODES_PERSONNELS_CONSULTES',
      'utilisateur',
      tous ? null : (dto.ids ?? []).join(','),
      { comptes: res.length, tous },
    );
    return res;
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
    const code = nouveauCode();
    if (await this.users.findOne({ where: { email: dto.email.toLowerCase() } }))
      throw new BadRequestException('Cet e-mail est déjà utilisé');
    const u = await this.users.save({
      email: dto.email.toLowerCase(),
      nom: dto.nom,
      initiales: dto.initiales ?? null,
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
    @Param('id') id: string,
    @Body() dto: UtilisateurDto,
  ) {
    const u = await this.users.findOne({ where: { id } });
    if (!u) throw new NotFoundException();
    if (moi.role !== 'ADMIN' && (u.role === 'ADMIN' || dto.role === 'ADMIN'))
      throw new ForbiddenException(
        'Seul l’administrateur modifie un compte administrateur.',
      );
    const maj: Partial<Utilisateur> = {
      email: dto.email.toLowerCase(),
      nom: dto.nom,
      initiales: dto.initiales ?? null,
      role: dto.role,
      departementId: dto.departementId ?? null,
      structureId: dto.structureId ?? null,
      actif: dto.actif ?? u.actif,
    };
    if (dto.motDePasse)
      maj.motDePasseHash = await bcrypt.hash(dto.motDePasse, 10);
    await this.users.update(id, maj);
    await this.journal.log(moi, 'MODIFICATION_UTILISATEUR', 'utilisateur', id, {
      role: dto.role,
      actif: maj.actif,
    });
    return this.users.findOne({ where: { id } });
  }

  /* --------------------------- Référentiels -------------------------- */

  @Roles(...TOUS_LES_ROLES)
  @Get('referentiels')
  async referentiels() {
    return {
      departements: await this.deps.find({ order: { ordre: 'ASC' } }),
      regles: await this.regles.find({ order: { code: 'ASC' } }),
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
