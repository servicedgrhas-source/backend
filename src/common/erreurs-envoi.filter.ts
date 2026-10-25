import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  HttpException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';

/** Messages anglais de multer (envoi de fichiers) et leur traduction. */
const MESSAGES: [RegExp, string][] = [
  [
    /^File too large/,
    'Fichier trop lourd pour cet envoi. Rescannez-le moins lourd (200 à 300 ppp, noir et blanc ou niveaux de gris) et réessayez.',
  ],
  // multer signale aussi « Unexpected field » quand il y a plus de fichiers que permis
  [
    /^(Too many (files|parts)|Unexpected (file )?field)/,
    'Trop de fichiers en un seul envoi : envoyez-les en plusieurs fois.',
  ],
  [
    /^(Multipart|Unexpected end|Malformed part)/,
    'L’envoi a été coupé avant la fin : vérifiez la connexion et réessayez.',
  ],
];

/**
 * Les refus de multer (fichier trop lourd, trop de fichiers, envoi coupé) arrivent en anglais :
 * ils sont rendus en français. Les autres erreurs HTTP suivent le traitement normal.
 */
@Catch(PayloadTooLargeException, BadRequestException)
export class ErreursEnvoiFilter extends BaseExceptionFilter {
  catch(e: HttpException, hote: ArgumentsHost) {
    const reponse = e.getResponse();
    const message =
      typeof reponse === 'string'
        ? reponse
        : (reponse as { message?: unknown }).message;
    const trad =
      typeof message === 'string' &&
      MESSAGES.find(([motif]) => motif.test(message))?.[1];
    if (!trad) return super.catch(e, hote);
    return super.catch(
      e instanceof PayloadTooLargeException
        ? new PayloadTooLargeException(trad)
        : new BadRequestException(trad),
      hote,
    );
  }
}
