import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ConflictException,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { QueryFailedError } from 'typeorm';

/**
 * Dernier filet : une contrainte de la base violée devient un message clair (400/409)
 * au lieu d'une « Internal server error ». Les autres erreurs suivent le traitement normal.
 */
@Catch(QueryFailedError)
export class ErreursBaseFilter extends BaseExceptionFilter {
  catch(e: QueryFailedError & { code?: string }, hote: ArgumentsHost) {
    const code =
      e.code ?? (e.driverError as { code?: string } | undefined)?.code;
    switch (code) {
      case '23505': // valeur unique déjà prise
        return super.catch(
          new ConflictException('Cette valeur existe déjà (doublon refusé).'),
          hote,
        );
      case '22P02': // identifiant ou nombre mal formé
      case '22007': // date mal formée
      case '22008':
        return super.catch(
          new BadRequestException('Valeur invalide dans la demande.'),
          hote,
        );
      case '23503': // lien vers un élément qui n'existe pas (ou encore utilisé)
        return super.catch(
          new BadRequestException(
            'Opération impossible : un élément lié est introuvable ou encore utilisé.',
          ),
          hote,
        );
      default:
        return super.catch(e, hote);
    }
  }
}
