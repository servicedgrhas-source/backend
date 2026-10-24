import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Post,
  Query,
  Req,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import { Repository } from 'typeorm';
import { Public } from '../auth/auth';
import { MOTIFS, MOTIFS_MUTATION, LIBELLE_CYCLE } from '../common/referentiels';
import { Departement } from '../entities';
import { StockageService } from '../common/stockage';
import { MutationService } from '../mutation/mutation.service';
import { CircuitService } from './circuit.service';

/** Demandes reçues par adresse IP (limite contre les envois en masse). */
const envois = new Map<string, number[]>();
const LIMITE = 6;
const FENETRE_MS = 60 * 60 * 1000;

/**
 * Portail DGRHAS : pages publiques, sans compte. L'agent y fait sa demande de mutation
 * depuis son téléphone et suit son dossier avec son numéro et son code.
 */
@Public()
@Controller('portail')
export class PortailController {
  constructor(
    private readonly circuit: CircuitService,
    private readonly mutations: MutationService,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    private readonly stockage: StockageService,
  ) {}

  /** Ce qu'il faut pour remplir le formulaire : départements, structures, types ouverts. */
  @Get('references')
  async references() {
    const types = await this.circuit.listeTypes(true);
    return {
      departements: (await this.deps.find({ order: { ordre: 'ASC' } })).map(
        (d) => ({ id: d.id, nom: d.nom }),
      ),
      structures: await this.circuit.structuresPubliques(),
      types: types.map((t) => ({
        code: t.code,
        libelle: t.libelle,
        pieces: t.pieces,
        motif: t.motifMutation,
        decision: t.decision,
        acte: t.acte,
        // Mutation (formulaire de mutation) ou autre prestation (congé, attestation, prime…)
        mutation: !!t.motifMutation || /^(MUTATION|PERMUTATION)/.test(t.code),
      })),
      motifs: MOTIFS_MUTATION.map((m) => ({
        code: m,
        libelle: MOTIFS[m].libelle,
      })),
      cycles: Object.entries(LIBELLE_CYCLE).map(([code, libelle]) => ({
        code,
        libelle,
      })),
    };
  }

  @Post('demandes')
  @UseInterceptors(
    FilesInterceptor('fichiers', 12, {
      limits: { fileSize: 10 * 1024 * 1024 },
      fileFilter: (_req, f, cb) =>
        cb(null, /\.(pdf|jpe?g|png)$/i.test(f.originalname)),
      // Fichiers gardés en mémoire : envoyés au stockage seulement après tous les contrôles
    }),
  )
  async deposer(
    @Req() req: Request,
    @UploadedFiles() fichiers: Express.Multer.File[] = [],
    @Body('donnees') donnees?: string,
    @Body('libelles') libelles?: string | string[],
    @Body('site') piege?: string,
  ) {
    // Retire du stockage ce qui y a déjà été envoyé (rien tant que les contrôles ne sont pas passés)
    const effacer = () =>
      Promise.all(
        fichiers.map((f) =>
          this.stockage.supprimer('justificatifs', f.filename),
        ),
      );
    // Champ invisible rempli : envoi automatique (robot)
    if (piege) {
      await effacer();
      throw new BadRequestException('Envoi refusé.');
    }
    const ip = req.ip ?? 'inconnue';
    const recents = (envois.get(ip) ?? []).filter(
      (t) => Date.now() - t < FENETRE_MS,
    );
    if (recents.length >= LIMITE) {
      await effacer();
      throw new HttpException(
        'Trop de demandes envoyées depuis cet appareil. Réessayez dans une heure.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    let dto: Record<string, unknown>;
    try {
      dto = JSON.parse(donnees ?? '{}') as Record<string, unknown>;
    } catch {
      await effacer();
      throw new BadRequestException('Formulaire illisible.');
    }
    const texte = (k: string, max = 200) =>
      typeof dto[k] === 'string' ? dto[k].slice(0, max) : null;
    const entier = (k: string) =>
      Number.isInteger(dto[k]) ? (dto[k] as number) : null;
    const types = await this.circuit.listeTypes(true);
    const type = types.find((t) => t.code === dto.typePrestation);
    if (!type) {
      await effacer();
      throw new BadRequestException('Choisissez le type de votre demande.');
    }
    const libs = Array.isArray(libelles)
      ? libelles
      : libelles
        ? [libelles]
        : [];
    if (!fichiers.length)
      throw new BadRequestException(
        'Joignez au moins votre demande manuscrite scannée.',
      );
    await this.stockage.enregistrerTous('justificatifs', fichiers);
    try {
      const r = await this.mutations.creerDepuisPortail(
        {
          typePrestation: type.code,
          nomComplet: texte('nomComplet', 150) ?? '',
          genre: dto.genre === 'F' ? 'F' : 'M',
          grade: texte('grade', 60),
          echelon: entier('echelon'),
          matricule: texte('matricule', 30),
          typeAgent:
            dto.typeAgent === 'FINALISTE' ? 'FINALISTE' : 'FONCTIONNAIRE',
          statutAgent:
            dto.statutAgent === 'PERSONNEL_ADMINISTRATIF'
              ? 'PERSONNEL_ADMINISTRATIF'
              : 'ENSEIGNANT',
          departementOrigineId: entier('departementOrigineId'),
          structureOrigineId: entier('structureOrigineId'),
          structureOrigineTexte: texte('structureOrigineTexte'),
          lieuService: texte('lieuService'),
          cycle: texte('cycle', 30),
          specialite: texte('specialite', 100),
          datePriseService: /^\d{4}-\d{2}-\d{2}$/.test(
            texte('datePriseService') ?? '',
          )
            ? texte('datePriseService')
            : null,
          departementSolliciteId: entier('departementSolliciteId'),
          lieuSollicite: texte('lieuSollicite'),
          motif: type.motifMutation ?? texte('motif', 40) ?? '',
          justificatif: texte('justificatif', 300),
          objet: texte('objet'),
          observation: texte('observation', 1000),
          telephone: texte('telephone', 30),
        },
        fichiers.map((f, i) => ({
          f,
          libelle: libs[i]?.slice(0, 200) || 'Pièce jointe',
        })),
      );
      envois.set(ip, [...recents, Date.now()]);
      // Le portail ne renvoie que le n°, le code et la première étape (pas l'identifiant interne)
      return { numero: r.numero, code: r.code, etape: r.etape };
    } catch (e) {
      await effacer();
      throw e;
    }
  }

  @Get('suivi')
  suivi(@Query('numero') numero: string, @Query('code') code: string) {
    if (!/^\d+$/.test(numero ?? '') || !code?.trim())
      throw new BadRequestException(
        'Écrivez le numéro et le code de votre demande.',
      );
    return this.mutations.suivi(Number(numero), code);
  }
}
