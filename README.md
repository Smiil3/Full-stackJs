# Billetterie « Les Nuits de la Garonne »

Outil de billetterie pour collectifs organisateurs de concerts et soirées (Bordeaux) : plusieurs collectifs sur la même plateforme, chacun ne voyant que ses données.

- **Vente** : plusieurs types de places par événement, tarif early daté, plafonds par commande et par personne, **zéro survente** même sous forte concurrence.
- **Paiement** : carte (prestataire simulé, notifications signées et idempotentes) ou virement validé par l'organisateur ; réservations non payées libérées automatiquement.
- **Billets** : QR signés (Ed25519), envoyés par mail, contrôlés à l'entrée **une seule fois** ; contrôle en ligne par défaut, mode secours hors-ligne activable par événement.
- **Liste d'attente** équitable, **annulation** par l'acheteur jusqu'à un délai, annulation et report d'événement avec remboursements.
- **Back-office** : ventes et encaissements en temps réel, validation des virements, remboursements à traiter, export CSV des participants, réglages par collectif et par événement, membres et journal d'audit.
- **Horaires** affichés dans le fuseau de l'événement **et** celui du visiteur.

## Structure

| Dossier | Contenu |
|---|---|
| [`backend/`](backend/README.md) | API Express 5 + TypeScript + Prisma/PostgreSQL, worker, prestataire de paiement simulé |
| [`frontend/`](frontend/README.md) | Application React 19 + TypeScript (PWA mobile-first, back-office, scanner) |
| [`docs/api-contract.md`](docs/api-contract.md) | Contrat d'API — source de vérité commune front / back |
| [`docs/plan.md`](docs/plan.md) | Plan, modèle de données, réponses aux problèmes du client |
| [`SECURITY.md`](SECURITY.md) | Modèle de menaces, protections, limites connues, check-list de production |

## Démarrage rapide (développement)

Prérequis : Node.js ≥ 24, npm ≥ 11, Docker.

```bash
# 1. Services locaux : PostgreSQL dev (5432) et test (5433), Mailpit (SMTP 1025, UI http://localhost:8025)
docker compose up -d

# 2. Mot de passe des comptes de démonstration (voir .env.e2e.example)
printf 'SEED_PASSWORD=%s\n' "$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)" > .env.e2e && chmod 600 .env.e2e

# 3. Backend : configuration, clés, base, puis API + worker + prestataire simulé
cd backend && npm ci && cp .env.example .env   # renseigner les secrets (commandes dans le fichier)
npm run keys:generate && npm run db:migrate && npm run db:seed
npm run dev        # API      http://localhost:4000
npm run dev:worker # worker (expirations, remboursements, mails, liste d'attente)
npm run dev:psp    # prestataire de paiement simulé http://localhost:4001

# 4. Frontend
cd ../frontend && npm ci && cp .env.example .env
npm run dev        # http://localhost:5173 (proxy /api → 4000)
# ou, sans backend : npm run dev:mock (API simulée dans le navigateur)
```

Comptes de démonstration (mot de passe = `SEED_PASSWORD`) : voir [`backend/README.md`](backend/README.md).

## Tests

```bash
cd backend  && npm run lint && npm run typecheck && npm test     # unitaires + intégration sur PostgreSQL réel
cd frontend && npm run lint && npm run typecheck && npm test     # unitaires et composants
cd frontend && npm run e2e                                       # bout en bout contre l'API réelle (Playwright, mobile)
```

## Mise en production

Lire la check-list de [`SECURITY.md`](SECURITY.md#check-list-de-mise-en-production). `docker-compose.yml` est réservé au développement.
