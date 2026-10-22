import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { types } from 'pg';
import { AmorcageService } from './amorcage/amorcage.service';
import { AppModule } from './app.module';

// Les colonnes DATE restent des chaînes « AAAA-MM-JJ » : sans cela, le pilote
// les convertit en minuit heure locale et elles reculent d'un jour en UTC.
types.setTypeParser(1082, (v: string) => v);

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // En ligne, le serveur est derrière le proxy de l'hébergeur (Render) : l'adresse du
  // visiteur est dans X-Forwarded-For (limite d'envois du portail par appareil).
  app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));
  app.setGlobalPrefix('api');
  app.use(helmet());
  app.enableCors({ origin: originesAutorisees() });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  const port = Number(process.env.PORT ?? 4000);
  // Tables à jour (migrations) et valeurs par défaut créées, puis configuration d'amorçage
  await app.init();
  await app.get(AmorcageService).amorcerAuDemarrage();
  await app.listen(port);
  // Le proxy de l'interface garde ses connexions ouvertes : si le serveur les fermait
  // avant lui (5 s par défaut), une requête tomberait sur une connexion coupée (ECONNRESET).
  const serveur = app.getHttpServer() as import('http').Server;
  serveur.keepAliveTimeout = 65_000;
  serveur.headersTimeout = 66_000;
  Logger.log(
    `API DGRHAS démarrée sur http://localhost:${port}/api`,
    'Bootstrap',
  );
}
/**
 * Adresses de l'interface autorisées à appeler l'API (FRONTEND_ORIGIN, séparées par des
 * virgules). « https://*.vercel.app » autorise aussi les aperçus de Vercel.
 */
function originesAutorisees(): (string | RegExp)[] {
  return (process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean)
    .map((o) =>
      o.includes('*')
        ? new RegExp(
            `^${o.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]+')}$`,
          )
        : o,
    );
}

void bootstrap();
