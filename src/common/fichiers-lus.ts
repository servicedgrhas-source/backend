import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  PreconditionFailedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { createHash } from 'node:crypto';
import { tap } from 'rxjs';
import type { UtilisateurConnecte } from '../auth/auth';

/** En-tête de l'empreinte (SHA-256) du fichier Excel envoyé, calculée par l'interface. */
const EN_TETE = 'x-fichier';
/** Un fichier lu reste disponible 10 minutes après son dernier usage… */
const DUREE_MS = 10 * 60_000;
/** …et la mémoire qu'ils occupent ensemble reste bornée (les plus anciens partent d'abord). */
const POIDS_MAX = 100 * 1024 * 1024;

const memoire = new Map<string, { f: Express.Multer.File; vu: number }>();
let poids = 0;

function oublier(cle: string) {
  const e = memoire.get(cle);
  if (!e) return;
  poids -= e.f.size;
  memoire.delete(cle);
}

function garder(cle: string, f: Express.Multer.File) {
  oublier(cle);
  const maintenant = Date.now();
  for (const [k, e] of memoire) if (maintenant - e.vu > DUREE_MS) oublier(k);
  if (f.size > POIDS_MAX) return;
  for (const k of memoire.keys()) {
    if (poids + f.size <= POIDS_MAX) break;
    oublier(k);
  }
  memoire.set(cle, { f, vu: maintenant });
  poids += f.size;
}

/**
 * Un fichier Excel n'est envoyé qu'une fois : « Lire le fichier », « Essai » puis « Importer »
 * reprennent le fichier déjà reçu. L'interface joint l'empreinte du fichier (X-Fichier) :
 * - avec le fichier : une fois la demande réussie, il est gardé quelques minutes, pour cet utilisateur ;
 * - sans le fichier : celui qui est gardé est repris ; s'il ne l'est plus (délai passé, serveur
 *   redémarré), la réponse 412 demande à l'interface de le renvoyer.
 */
@Injectable()
export class FichiersLusInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler) {
    const req = ctx
      .switchToHttp()
      .getRequest<
        Request & { user?: UtilisateurConnecte; file?: Express.Multer.File }
      >();
    const empreinte = req.headers[EN_TETE];
    if (
      typeof empreinte !== 'string' ||
      !/^[0-9a-f]{64}$/.test(empreinte) ||
      !req.user
    )
      return next.handle();
    const cle = `${req.user.id}|${empreinte}`;
    if (!req.is('multipart')) {
      const e = memoire.get(cle);
      if (!e || Date.now() - e.vu > DUREE_MS) {
        oublier(cle);
        throw new PreconditionFailedException(
          'Le fichier n’est plus gardé par le serveur : renvoyez-le.',
        );
      }
      e.vu = Date.now();
      req.file = e.f;
      return next.handle();
    }
    return next.handle().pipe(
      tap(() => {
        const f = req.file;
        if (
          f?.buffer &&
          createHash('sha256').update(f.buffer).digest('hex') === empreinte
        )
          garder(cle, f);
      }),
    );
  }
}
