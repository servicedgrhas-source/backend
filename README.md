# DGRHAS — API (backend)

API NestJS 11 + TypeORM + PostgreSQL de l'application DGRHAS (recrutés, affectations,
mutations, enrôlement, notes). L'interface (Next.js) est dans le dépôt `frontend`.

## Sur le poste

```bash
npm install
cp .env.example .env      # puis remplir DB_PASSWORD, JWT_SECRET, ADMIN_PASSWORD, R2_*
npm run start:dev         # http://localhost:4000/api
```

Avec `DB_SYNC=true` (poste uniquement), les tables suivent les entités automatiquement.

## En ligne (Render + Supabase + Cloudflare R2)

| Élément | Où |
|---|---|
| API | Render (Web Service Node), `render.yaml` |
| Base | Supabase PostgreSQL (`DATABASE_URL`, pooler mode session, port 5432, SSL) |
| Scans | Cloudflare R2 (`STOCKAGE=r2`) — le disque de Render n'est pas conservé |

- Build : `npm ci --include=dev && npm run build` — Start : `npm run start:prod`
- Santé : `GET /api/sante`
- Au démarrage : les **migrations** (`src/migrations`) créent/mettent à jour les tables,
  les valeurs par défaut sont créées, puis le premier **administrateur**
  (`ADMIN_EMAIL` / `ADMIN_PASSWORD`) si aucun compte n'existe.

### Amorçage de la configuration

`amorcage/configuration.json` contient la configuration réglée dans « Administration »
(paramètres, grades, règles des diplômes, organigramme, prestations, bénéficiaires du quota,
origines des dossiers) — **aucune donnée de travail ni aucun compte**.

Il est chargé **une seule fois**, au premier démarrage d'une base qui ne contient encore
aucune donnée de travail (témoin : paramètre `AMORCAGE_CONFIGURATION`). `AMORCAGE=non`
le désactive.

Pour le régénérer depuis la base du poste (compte ADMIN, hors production) :
`POST /api/amorcage/export/fichier`, puis versionner le fichier.

### Faire évoluer les tables

Après une modification d'entité :

```bash
npm run migration:generer -- src/migrations/NomDuChangement   # contre une base à jour
npm run migration:jouer                                        # ou au prochain démarrage
```

### Connexion et sessions

- Connexion : e-mail + mot de passe + code personnel (si le compte en a un).
- **10 essais ratés en 15 minutes** : le compte est bloqué 15 minutes (même avec le bon mot de
  passe). L'administrateur ou le DG peut le débloquer (Administration → « Débloquer »).
  Depuis une même adresse, 60 échecs en 15 minutes bloquent l'adresse 15 minutes.
- Le compte est relu en base à chaque requête : désactivation et changement de rôle valent
  tout de suite. Mot de passe ou code changé, ou « Déconnecter » : les sessions ouvertes se ferment.
- Il reste toujours au moins un administrateur actif ; personne ne change son propre rôle
  ni ne désactive son propre compte.
- Tous les refus et blocages sont au journal (`CONNEXION_REFUSEE`, `CONNEXION_BLOQUEE`).

### Secrets

- `JWT_SECRET` signe les sessions. `CODE_SECRET` chiffre les codes personnels.
- Sans `CODE_SECRET`, les codes sont chiffrés avec `JWT_SECRET` : dans ce cas, ne pas changer
  `JWT_SECRET`. Pour pouvoir le changer : ajouter `CODE_SECRET`, redémarrer (les codes sont
  re-chiffrés), puis changer `JWT_SECRET` (tout le monde devra se reconnecter).
- Ne jamais changer `CODE_SECRET` une fois en service. Ne jamais versionner `.env`.
