import {
  ValidationPipe,
  type ArgumentMetadata,
  type ValidationPipeOptions,
} from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import type { SecuriteService } from './securite.service';

const cache = new WeakMap<object, Set<string> | null>();

/**
 * Paramètres d'adresse que lit une route (déclarés un par un avec @Query('nom')). null : la route
 * lit tous les paramètres (@Query() entier, ou la requête brute) et on ne vérifie pas les noms.
 */
export function parametresDeLaRoute(
  classe: new (...a: never[]) => unknown,
  handler: (...a: never[]) => unknown,
): Set<string> | null {
  if (cache.has(handler)) return cache.get(handler)!;
  const meta = (Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    classe,
    handler.name,
  ) ?? {}) as Record<string, { data?: unknown }>;
  let tout = false;
  const noms = new Set<string>();
  for (const [cle, v] of Object.entries(meta)) {
    const type = Number(cle.split(':')[0]);
    if (type === Number(RouteParamtypes.QUERY)) {
      if (v.data === undefined) tout = true;
      else if (typeof v.data === 'string') noms.add(v.data);
      else tout = true;
    }
    if (type === Number(RouteParamtypes.REQUEST)) tout = true;
  }
  const r = tout ? null : noms;
  cache.set(handler, r);
  return r;
}

/** Champs refusés par la liste blanche de la validation (y compris dans les objets imbriqués). */
function champsHors(erreurs: ValidationError[], prefixe = ''): string[] {
  const sortie: string[] = [];
  for (const e of erreurs) {
    const nom = prefixe ? `${prefixe}.${e.property}` : e.property;
    if (e.constraints?.whitelistValidation) sortie.push(nom);
    if (e.children?.length) sortie.push(...champsHors(e.children, nom));
  }
  return sortie;
}

/**
 * Validation habituelle (champs inconnus retirés en silence), qui signale en plus à l'outil de
 * détection les champs que l'interface n'envoie jamais. La réponse reste la même.
 */
export class ValidationSurveillee extends ValidationPipe {
  constructor(
    private readonly securite: SecuriteService,
    options: ValidationPipeOptions,
  ) {
    super(options);
  }

  async transform(value: unknown, metadata: ArgumentMetadata) {
    if (
      metadata.type === 'body' &&
      metadata.metatype &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      this.toValidate(metadata)
    )
      try {
        const erreurs = await validate(
          plainToInstance<object, unknown>(
            metadata.metatype as new () => object,
            value,
          ),
          { whitelist: true, forbidNonWhitelisted: true },
        );
        const inconnus = champsHors(erreurs);
        if (inconnus.length) await this.securite.champsInconnus(inconnus);
      } catch {
        /* la validation normale décidera */
      }
    return super.transform(value, metadata) as Promise<unknown>;
  }
}
