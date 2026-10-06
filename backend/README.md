# Backend — Billetterie « Les Nuits de la Garonne »

API REST (Express 5, TypeScript strict, Prisma + PostgreSQL 16) de la billetterie : catalogue, réservation sans survente, paiement (prestataire simulé), billets QR signés, contrôle d'accès en ligne (et hors-ligne en secours), liste d'attente, annulations, back-office multi-collectifs, statistiques et export.

- Contrat d'API (source de vérité commune front / back) : [`../docs/api-contract.md`](../docs/api-contract.md)
- Plan et modèle de données : [`../docs/plan.md`](../docs/plan.md)
- Décisions d'implémentation (datées et justifiées) : [`DECISIONS.md`](DECISIONS.md)
- Modèle de menaces et limites connues : [`../SECURITY.md`](../SECURITY.md)

## Prérequis

- Node.js ≥ 24, npm ≥ 11
- Docker (PostgreSQL de dev et de test, Mailpit) — voir [`../docker-compose.yml`](../docker-compose.yml)

## Installation

```bash
# 1. Services : Postgres dev (5432), Postgres test (5433), Mailpit (SMTP 1025, UI http://localhost:8025)
docker compose -f ../docker-compose.yml up -d

# 2. Dépendances puis génération du client Prisma (aucun script postinstall)
npm ci
npx prisma generate

# 3. Configuration : copier puis renseigner TOUS les secrets (commandes de génération dans le fichier)
cp .env.example .env
#    L'API refuse de démarrer si un secret manque, est trop court, vaut CHANGE_ME ou est réutilisé.

# 4. Clés Ed25519 de signature des billets (dossier keys/, gitignoré, clé privée en 0600)
npm run keys:generate

# 5. Schéma et données de démonstration
npm run db:migrate
npm run db:seed
```

## Lancer

Trois processus en développement (un terminal chacun) :

| Commande | Rôle | Port |
|---|---|---|
| `npm run dev` | API | 4000 (`/health`, `/api/v1/…`) |
| `npm run dev:worker` | Worker : annulations d'événement, rapprochement des paiements auprès du PSP, expirations de réservations et d'offres de liste d'attente, remboursements, envoi des mails (outbox), purge des compteurs | — |
| `npm run dev:psp` | Prestataire de paiement **simulé** (refuse de démarrer en production) | 4001 |

Production :
1. Étape de build (dépendances complètes) : `npm ci`, puis `npm run build` (génère le client Prisma et compile dans `dist/`, client Prisma compris ; le PSP simulé est exclu du build).
2. Migrations, AVANT de démarrer la nouvelle version : `npm run db:migrate`, depuis l'étape de build ou un job dédié — la CLI Prisma est une dépendance de développement, absente de l'image d'exécution.
3. Image d'exécution : `npm ci --omit=dev` + `dist/` ; démarrage par `npm start` (API) et `npm run start:worker` (worker).

## Scripts

| Script | Effet |
|---|---|
| `dev`, `dev:worker`, `dev:psp` | API / worker / PSP simulé en mode watch (tsx) |
| `build`, `start`, `start:worker` | Compilation TypeScript puis exécution |
| `test` | Vitest + Supertest sur un **vrai** PostgreSQL (`TEST_DATABASE_URL`, nom de base finissant par `_test`, vidée entre chaque test) |
| `lint` | ESLint (`strictTypeChecked` + `eslint-plugin-security` + règles maison : pas de `Math.random`, de SQL non paramétré, de `console`, de lecture de `req.body` hors validation) |
| `typecheck` | `tsc --noEmit` (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) |
| `db:migrate` / `db:migrate:dev` | Migrations Prisma (déploiement / développement) |
| `db:seed` | Données de démonstration (voir ci-dessous) |
| `keys:generate` | Paire Ed25519 dans `keys/` (refuse d'écraser une paire existante) |

Vérification complète : `npm run lint && npm run typecheck && npm test && npm audit --omit=dev`.

## Comptes de démonstration (seed)

Mot de passe commun : variable `SEED_PASSWORD` (≥ 16 caractères), lue dans l'environnement ou dans `../.env.e2e` (partagé avec les tests e2e du front, gitignoré). Si elle est vide, un mot de passe aléatoire est généré et affiché **une seule fois**. Le seed refuse de s'exécuter en production et sur une base non locale ; rejoué sur une base déjà peuplée, il **resynchronise** les comptes de démonstration (mot de passe, sessions révoquées) sans rien supprimer.

| Compte | Rôle |
|---|---|
| `admin@nuits-garonne.test` | Administrateur de la plateforme |
| `acheteur@nuits-garonne.test` | Acheteur vérifié |
| `owner@nuits.test`, `manager@nuits.test`, `scanner@nuits.test` | Les Nuits de la Garonne |
| `owner@rivedroite.test`, `manager@rivedroite.test`, `scanner@rivedroite.test` | Collectif Rive Droite |
| `owner@chais.test`, `manager@chais.test`, `scanner@chais.test` | Les Chais Sonores |

Événements : une nuit électro avec tarif early, un live en ligne au fuseau `America/New_York`, un concert presque complet (balcon), un événement partenaire publié et un brouillon. Les mails partent vers Mailpit (http://localhost:8025).

## Architecture

```
src/
  server.ts, worker.ts, app.ts, routes.ts   démarrage (fail-fast env + clés), pile Express, montage des modules
  config/                                   env.ts (variables d'environnement validées par Joi) + constantes par domaine (voir « Configuration »)
  middlewares/                              auth (JWT + relecture en base), requireOrgRole, validate (Joi in/out),
                                            csrf, rate limit, contentType, rawBody (webhook), errorHandler, requestId
  modules/<domaine>/{routes,controller,service,repo,schemas}.ts
    auth          inscription, vérification, sessions (access JWT + refresh rotatif), mots de passe
    orgs, admin   collectifs, réglages (IBAN chiffré), membres, audit, administration plateforme
    settings      resolveEventSettings : point UNIQUE de résolution réglages collectif → événement
    events, catalog   back-office événements / types de places, catalogue public
    orders, orgOrders réservation, idempotence, annulations ; vue organisateur, validation de virement
    payments      webhook PSP (idempotent, aucun paiement perdu), règlement, remboursements
    refunds       suivi des remboursements par l'organisateur
    tickets, checkin  billets QR signés, scan, snapshot (mode secours), synchronisation hors-ligne
    waitlist      liste d'attente (FIFO, offres à durée limitée)
    reports       statistiques temps réel, export CSV
  jobs/          ordre du worker (schedule), rapprochement des paiements, expiration des réservations, remboursements
  lib/           crypto (AES-GCM + AAD, jetons), jwt, password (argon2id + sémaphore), money (entiers, BigInt),
                 ticketSigning (Ed25519), outbox mail, rate limit PostgreSQL, horloge injectable, CSV sûr…
  mock-psp/      prestataire de paiement simulé (app Express séparée)
prisma/          schéma, migrations (dont contraintes CHECK, index partiels et déclencheurs SQL), seed
tests/           385 tests d'intégration et unitaires (Vitest + Supertest, base réelle)
```

### Garanties principales et où elles vivent

| Garantie | Mécanisme |
|---|---|
| Zéro survente | `UPDATE … SET held = held + q WHERE sold + held + q <= capacity` (types triés par id) + `CHECK (sold + held <= capacity)` ; test de 300 requêtes simultanées sur 10 places |
| Réservations impayées libérées | Échéance figée sur la commande (carte / virement) et sur la session PSP, rapprochement auprès du PSP avant expiration, worker `FOR UPDATE SKIP LOCKED`, une transaction par commande |
| Webhook en double | `WebhookEvent.providerEventId` UNIQUE inséré dans la même transaction que l'effet ; billets `UNIQUE (orderItemId, seq)` |
| Aucun paiement perdu | Toute somme encaissée sans billets est enregistrée et remboursée automatiquement (log + audit) |
| Billet présenté deux fois | QR signé Ed25519 + passage atomique `VALID → USED` ; `scanId` idempotent |
| Isolation des collectifs | Adhésion relue en base à chaque requête ; `orgId` dans chaque requête back-office ; ressource étrangère ⇒ 404 |
| Ordre des verrous | verrou consultatif (acheteur, événement) → `events` → `orders` → `ticket_types` (unique dans tout le code) |
| Entrées / sorties | Joi en entrée (champs inconnus ⇒ 400) et en sortie (seuls les champs du contrat sortent) |

Les décisions détaillées (et leurs raisons) sont dans [`DECISIONS.md`](DECISIONS.md).

## Configuration

Deux niveaux, jamais mélangés :

- **Variables d'environnement** (`src/config/env.ts`, validées au démarrage) : ce qui change d'un déploiement à l'autre — URL, secrets, SMTP, proxys, intervalle du worker.
- **Constantes de code** (`src/config/*.ts`) : toutes les valeurs métier et techniques, nommées, typées et commentées (sens + source). Aucun nombre en dur ailleurs dans `src/` : la règle ESLint `@typescript-eslint/no-magic-numbers` est en erreur.

| Fichier | Contenu |
|---|---|
| `units.ts` | Unités de temps et conversions (`minutes(15)`, `hours(12)`, `toUnixSeconds()`) |
| `auth.ts`, `password.ts` | Sessions, liens mail, verrouillage, argon2id, longueurs de mot de passe |
| `rateLimits.ts` | Tous les plafonds de requêtes et quotas, en tableau |
| `http.ts` | Codes HTTP, tailles de corps, pagination, HSTS / CORS |
| `checkin.ts` | Fenêtre de contrôle, lots de synchronisation, format du QR |
| `payments.ts`, `refunds.ts`, `mail.ts` | PSP, webhook, rapprochement, remboursements, outbox et SMTP |
| `money.ts`, `settingsBounds.ts`, `fields.ts` | Plafonds de montants, bornes des réglages du back-office, longueurs des champs |
| `banking.ts`, `crypto.ts`, `database.ts` | IBAN, tailles cryptographiques, pool et transactions |
| `events.ts`, `waitlist.ts`, `worker.ts`, `mockPsp.ts` | Catalogue, liste d'attente, lots du worker, PSP simulé |

Les valeurs réglables par un collectif (durées de réservation, frais, plafonds…) restent en base (réglages du back-office) ; seules leurs bornes sont dans `settingsBounds.ts`. Les invariants entre constantes sont testés dans `tests/unit/config.test.ts`.

## Variables d'environnement

Toutes documentées dans [`.env.example`](.env.example) : base de données, URL du front (CORS + anti-CSRF), proxys de confiance, secrets JWT (avec rotation `JWT_KEY_ID` / `JWT_PREVIOUS_SECRETS`), clé de chiffrement des IBAN (rotation `DATA_ENCRYPTION_KEY_ID` / `DATA_ENCRYPTION_PREVIOUS_KEYS`), clés de signature des billets, SMTP, prestataire de paiement, worker, plancher de temps de réponse, multiplicateur de rate limiting (> 1 refusé en production).

## Tests

```bash
docker compose -f ../docker-compose.yml up -d postgres-test   # base de test sur 5433
npm test
```

La suite applique les migrations sur `TEST_DATABASE_URL`, génère des secrets et des clés éphémères à chaque exécution, et vide les tables entre chaque test. Le test Mailpit est ignoré si Mailpit n'est pas joignable.
