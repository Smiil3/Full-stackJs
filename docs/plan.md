# Billetterie « Les Nuits de la Garonne » — Plan

## Contexte
Collectif bordelais (≈15 événements/an, 80–600 places, ≥2 types de places, tarif early daté) + 2 collectifs partenaires isolés. Problèmes : survente en concurrence, réservations impayées qui bloquent, webhooks PSP dupliqués → billets en double, liste d'attente manuelle, billets présentés 2 fois, pas de chiffres temps réel. Extras : annulation self-service, billet par mail, export CSV, fuseaux horaires clairs, mobile + mauvaise connexion.
Projet audité ensuite par une équipe adverse → **sécurité et robustesse priment sur la vitesse**.

Décisions validées : PostgreSQL + Prisma · PSP **simulé** (webhooks signés HMAC, doublons volontaires) · blocage selon mode de paiement (carte 15 min / virement 72 h validé à la main, configurable par événement) · tout le brief · compte acheteur obligatoire · **JWT access + refresh** · deux dossiers séparés `backend/` et `frontend/`.

## Structure
```
FullstackJs/
  docker-compose.yml        # postgres:16, mailpit (SMTP dev), postgres-test
  backend/                  # Express 5 + TS strict + Prisma + Joi
    prisma/schema.prisma, migrations/, seed.ts
    src/config/env.ts       # env validée par Joi au boot (fail fast)
    src/app.ts, server.ts, worker.ts
    src/middlewares/        # auth, requireOrgRole, validate (Joi in/out), rateLimit, errorHandler, requestId
    src/modules/{auth,orgs,events,orders,payments,tickets,checkin,waitlist,stats,exports}/  (routes → controller → service → repo)
    src/mock-psp/           # faux prestataire (port séparé, désactivé si NODE_ENV=production)
    src/lib/{crypto,jwt,mailer,outbox,money,time,csv,logger}.ts
    tests/                  # Vitest + Supertest sur vrai Postgres
  frontend/                 # React + Vite + TS, React Router, TanStack Query, vite-plugin-pwa
    src/{api,auth,pages,components,scanner,lib}/
    e2e/                    # Playwright (viewport mobile)
  README.md, SECURITY.md (modèle de menaces + limites connues)
```

## Modèle de données (Prisma, montants en centimes `Int`, dates `timestamptz` UTC)
- `User` (email unique normalisé, `passwordHash` argon2id, `emailVerifiedAt`, `failedLoginCount`, `lockedUntil`)
- `Organization`, `Membership(userId, orgId, role: OWNER|MANAGER|SCANNER)` — unique(userId, orgId)
- `RefreshToken(id, userId, familyId, tokenHash sha256, expiresAt, revokedAt, replacedById)`
- `OrganizationSettings(orgId unique, …)` — valeurs par défaut du collectif (voir section « Paramètres configurables »)
- `Event(orgId, title, venue, isOnline, startsAt, endsAt, timezone IANA, status DRAFT|PUBLISHED|CANCELLED, salesStartAt, salesEndAt` + surcharges nullable des paramètres configurables`)`
- `Order` porte aussi les valeurs figées : `serviceFeeCents, refundPercent, cancellableUntil`
- `TicketType(eventId, name, capacity, sold, held, priceCents, earlyPriceCents?, earlyUntil?)` + **CHECK SQL** `sold >= 0 AND held >= 0 AND sold + held <= capacity` (migration SQL manuelle)
- `Order(userId, eventId, status PENDING_PAYMENT|AWAITING_TRANSFER|PAID|EXPIRED|CANCELLED|REFUNDED, paymentMethod CARD|TRANSFER, expiresAt, totalCents, currency, transferReference unique, idempotencyKey)` unique(userId, idempotencyKey)
- `OrderItem(orderId, ticketTypeId, quantity, unitPriceCents)` — prix figé côté serveur
- `Payment(orderId, providerPaymentId unique, amountCents, status)`
- `WebhookEvent(providerEventId UNIQUE, type, receivedAt, processedAt)`
- `Ticket(orderItemId, seq, publicId 128 bits aléatoire, status VALID|USED|CANCELLED, usedAt, usedBy)` unique(orderItemId, seq) → impossible de générer 2 fois
- `CheckIn(ticketId, scannerId, deviceId, scannedAt, result OK|ALREADY_USED|INVALID|CANCELLED, offline)` (journal)
- `WaitlistEntry(ticketTypeId, userId, quantity, status WAITING|OFFERED|CONVERTED|EXPIRED|LEFT, offeredAt, offerExpiresAt)` — index unique partiel « une entrée active par user/type »
- `EmailOutbox(to, template, payload, status, attempts, nextAttemptAt)` ; `AuditLog(actorId, orgId, action, target, meta)`

## Points critiques du brief → solution
1. **Zéro survente** : dans une transaction, pour chaque type (trié par id → pas de deadlock) `UPDATE ticket_type SET held = held + $q WHERE id = $id AND sold + held + $q <= capacity RETURNING id` (Prisma `$queryRaw` tagué). 0 ligne → rollback + 409. Contrainte CHECK = filet ultime. Test : 300 requêtes parallèles sur 10 places → exactement 10 commandes.
2. **Réservations impayées** : `expiresAt` = now + cardHold (carte) ou transferHold (virement, référence unique à mettre dans le libellé, validation manuelle par MANAGER). Worker (intervalle + `pg_try_advisory_lock` pour instance unique) : `SELECT … FOR UPDATE SKIP LOCKED` sur commandes expirées → EXPIRED, `held -= q`, puis distribution à la liste d'attente. Paiement arrivé après expiration : re-réserve si stock dispo, sinon remboursement auto (mock) + mail.
3. **Webhook en double** : body brut, en-tête `t=…,v1=HMAC-SHA256(t.body)`, `crypto.timingSafeEqual`, tolérance 5 min (anti-rejeu), `INSERT WebhookEvent` (unique) **dans la même transaction** que le traitement ; transition gardée `UPDATE order SET status='PAID' WHERE id=$1 AND status IN ('PENDING_PAYMENT')` ; vérif montant + devise + orderId ; `held→sold` ; tickets via unique(orderItemId, seq). Toujours 2xx pour un doublon déjà traité.
4. **Liste d'attente** : inscription quand type complet ; quand des places se libèrent, elles vont d'abord au 1er WAITING (FIFO `createdAt, id`) sous forme d'offre qui garde les places `held` pendant `waitlistOfferMinutes` (défaut 120) + mail ; acceptation → commande CARD classique ; offre expirée → suivant. Places rendues au public seulement si file vide.
5. **Billets anti-copie** : QR = `publicId` + signature **Ed25519** serveur. Scan en ligne : `UPDATE ticket SET status='USED' WHERE publicId=$1 AND status='VALID' AND event appartient à l'org du scanneur` → 2ᵉ présentation = rouge « déjà utilisé à HH:MM ». Le QR ne contient aucune donnée perso.
6. **Mauvaise connexion à l'entrée** : PWA scanner (rôle SCANNER) télécharge avant l'ouverture la clé publique + liste des billets (publicId, statut, type) en IndexedDB ; hors-ligne : vérif signature + statut local, marque USED localement, file de synchro rejouée au retour réseau ; conflits → le premier scan serveur gagne, doublons signalés. Limite documentée : 2 appareils hors-ligne simultanés peuvent accepter le même billet → recommandation 1 appareil par porte ou synchro dès que possible (SECURITY.md).
7. **Chiffres temps réel** : endpoint stats agrégées par type (vendus, en attente, restants, encaissé) ; dashboard en polling 5 s TanStack Query (robuste sur mobile, pas de souci d'auth SSE).
8. **Multi-collectifs** : toute route orga sous `/orgs/:orgId/...`, middleware `requireOrgRole` charge l'adhésion **en base** à chaque requête (rôles jamais dans le JWT), repos qui exigent `orgId` dans chaque `where`. Ressource d'une autre orga → 404. Tests IDOR systématiques.
9. **Annulation self-service** : autorisée si PAID, aucun billet scanné, et `now < startsAt - cancellationDeadlineHours` ; remboursement mock, tickets CANCELLED, places → liste d'attente / public.
10. **Mail** : Nodemailer → Mailpit en dev, via outbox transactionnel (retry exponentiel) ; billet = QR PNG en pièce jointe + lien « mes billets ». Templates échappés.
11. **Export participants** : CSV streamé, OWNER/MANAGER uniquement, protection injection CSV (préfixe `'` si la cellule commence par `= + - @ \t \r`), journalisé dans AuditLog.
12. **Fuseaux** : stockage UTC + `timezone` IANA (validée via `Intl.supportedValuesOf('timeZone')`) ; affichage « 20:00 heure de Paris (UTC+2) · 14:00 chez vous (New York) » avec `Intl.DateTimeFormat`. Tarif early et délais calculés côté serveur en UTC.

## Sécurité transverse (backend)
- **Auth JWT** : lib `jose`, access token 10 min, algo épinglé (`HS256`, secret ≥ 256 bits), `iss/aud/exp` vérifiés, payload = `sub` seulement ; gardé **en mémoire** côté front (jamais localStorage). Refresh = opaque 256 bits, hashé en base, cookie `httpOnly Secure SameSite=Strict Path=/api/v1/auth`, **rotation à chaque usage + détection de réutilisation → révocation de toute la famille**. Logout / changement de mot de passe → révocation. Endpoint refresh : vérif `Origin` + en-tête custom (anti-CSRF).
- Mots de passe argon2id, min 12 car. ; hash factice si email inconnu (timing) ; messages génériques (pas d'énumération à l'inscription / reset) ; tokens vérif email & reset : aléatoires, hashés, usage unique, 30 min.
- Rate limiting (`express-rate-limit`) global + strict sur login/register/reset/réservation ; verrouillage progressif par compte.
- **Joi partout** : `params`, `query`, `body` (`allowUnknown: false`, `abortEarly: false`) et **réponses** (schémas de sortie : seuls les champs déclarés sortent ; en test un écart fait échouer, en prod log + 500). Aucun `req.body` passé tel quel à Prisma (anti mass-assignment). Prix, early, total : **toujours calculés serveur**.
- `helmet` (CSP stricte), CORS allowlist + credentials, `express.json({ limit: '10kb' })` (raw pour webhook), `x-powered-by` off, `trust proxy` explicite, handler d'erreur centralisé sans stack ni message Prisma, `pino` avec redaction (authorization, cookie, password, token), requestId.
- Idempotency-Key sur création de commande ; plafonds par commande et par utilisateur/événement.
- Pas de `$queryRawUnsafe`, pas de `eval`, uuid partout mais autorisation quand même. Secrets via `.env` gitignoré + `.env.example`. Mock PSP inaccessible en production.
- Qualité : TS `strict` + `noUncheckedIndexedAccess`, ESLint + `eslint-plugin-security`, `npm audit` sans vuln haute, versions verrouillées.

## Frontend (React, mobile-first)
- Pages : catalogue / détail événement (prix, early, fuseau), panier → paiement (redirection mock PSP) / instructions virement avec compte à rebours, mes billets (QR), annulation, liste d'attente ; espace orga : événements & types CRUD, dashboard ventes, validation virements, export CSV, gestion membres ; scanner PWA.
- Client API : access token en mémoire, refresh silencieux sur 401 (une seule promesse partagée), `credentials: 'include'`. Aucun `dangerouslySetInnerHTML`. Validation légère côté client (UX), le serveur fait foi. Routes protégées par rôle (UX seulement, l'API vérifie).

## Organisation : 2 sessions agent-deck enfants, moi = PO
**Moi (session `fullstack-js`, PO)** : je n'écris pas le code applicatif. Je rédige le contrat, les briefs, je réponds aux questions, je valide chaque jalon et je fais passer les changements de contrat d'une équipe à l'autre.

### Étape 0 — préparation (par moi, avant de lancer les sessions)
1. `git init` à la racine, `.gitignore` (node_modules, .env, dist, coverage), `docker-compose.yml` (postgres 16, postgres-test, mailpit).
2. `docs/api-contract.md` — **contrat d'API, source de vérité commune** : conventions (préfixe `/api/v1`, JSON, montants en centimes, dates ISO 8601 UTC, format d'erreur `{ error: { code, message, details? } }`, pagination), auth (flux access/refresh, cookie, en-têtes), puis chaque endpoint : méthode, chemin, rôle requis, requête, réponse, codes d'erreur. Toute modification passe par moi.
3. `docs/briefs/backend.md` et `docs/briefs/frontend.md` — briefs détaillés (contexte métier, périmètre, règles de sécurité non négociables, jalons avec critères d'acceptation, conventions de commit en français, protocole : `NEED:` pour toute question ou demande de changement de contrat, interdiction d'empiéter sur l'autre dossier).
4. Ce plan copié dans `docs/plan.md` pour référence.

### Lancement
```
agent-deck launch backend  -t "nuits-back"  -c claude -g Efrei -create-dir -auto-mode -model claude-opus-5-5 -message-file docs/briefs/backend.md
agent-deck launch frontend -t "nuits-front" -c claude -g Efrei -create-dir -auto-mode -model claude-opus-5-5 -message-file docs/briefs/frontend.md
```
(sessions enfants liées à la mienne ; `-auto-mode` pour qu'elles puissent lancer npm, docker, tests sans prompt à chaque commande ; à retirer si vous préférez valider chaque commande.)

### Travail en parallèle
- **Back** : jalons 1→7 ci-dessous, dans l'ordre ; chaque jalon = tests verts + commit + message de fin de jalon.
- **Front** : démarre tout de suite sur le contrat avec **MSW** (mocks fidèles au contrat), branche l'API réelle au fil des jalons back annoncés.
- **Ma boucle PO** : `agent-deck inbox drain` / `session children` → à chaque `NEED:` je tranche (ou je vous remonte la question si c'est une décision client) ; à chaque jalon je vérifie moi-même (tests, lint, lecture ciblée, revue par sous-agent sonnet) avant d'autoriser la suite ; tout changement de contrat est mis à jour dans `docs/api-contract.md` puis notifié à l'autre session via `agent-deck session send`.
- Fin : intégration e2e Playwright (session front, back démarré), puis revue sécurité globale par moi (`/security-review` + revue adversariale) et retours correctifs aux deux sessions.

## Ordre de réalisation
1. Socle : docker-compose, backend (env Joi, app sécurisée, logger, erreurs, validate in/out), Prisma schema + CHECK, seed.
2. Auth (register/verify/login/refresh rotatif/logout/reset) + tests.
3. Orgs/memberships/rôles + réglages collectif & surcharges événement + événements/types de places (CRUD orga, publication) + tests IDOR.
4. Réservation atomique + expiration worker + test de concurrence.
5. Mock PSP + webhook (signature, rejeu, doublons, paiement tardif) + virement manuel + génération billets + outbox mail.
6. Billets QR signés + check-in en ligne + sync hors-ligne.
7. Liste d'attente, annulation, stats, export CSV.
8. Frontend complet + PWA scanner.
9. Playwright e2e, README, SECURITY.md, passe `/security-review` + `/code-review` finale.

## Vérification
- `docker compose up -d` puis `npm test` dans `backend/` : unitaires + intégration sur Postgres réel, dont les tests ciblés : survente (300 req // sur 10 places), webhook doublon / signature invalide / rejoué / montant faux / après expiration, réutilisation refresh token, IDOR inter-collectifs (lecture, export, stats, scan), double scan concurrent, injection CSV, bornes early/annulation, ordre et expiration liste d'attente, sortie Joi stricte (pas de `passwordHash` qui fuit).
- `npm run lint && npm run typecheck && npm audit` sur les deux dossiers.
- `npx playwright test` (viewport mobile) : achat carte → mail Mailpit → QR → scan OK puis « déjà utilisé » ; scanner hors-ligne (network offline) puis resync.
- Manuel : `curl` du mock PSP en envoyant 2 fois le même webhook → 1 seul jeu de billets.

## Paramètres configurables en back-office (plus de valeurs codées en dur)
Deux niveaux : **réglages du collectif** (`OrganizationSettings`, valeurs par défaut) → **surcharge par événement** (champs nullable sur `Event` ; `null` = hérite du collectif). Résolution centralisée dans `src/modules/settings/resolveEventSettings.ts`, utilisée par tous les services (réservation, annulation, waitlist, virement, calcul du total). Les valeurs sont **figées sur la commande** au moment de la réservation (`expiresAt`, frais, politique de remboursement) → modifier un réglage ne change pas les commandes déjà passées.

| Paramètre | Défaut | Niveau | Validation Joi |
|---|---|---|---|
| Délai de blocage carte (min) | 15 | collectif + événement | 5–60 |
| Délai de blocage virement (h) | 72 | collectif + événement | 1–240 |
| Virement activé | oui | collectif + événement | bool |
| Délai limite d'annulation (h avant début) | 48 | collectif + événement | 0–720 ; 0 = jusqu'au début |
| Annulation self-service activée | oui | collectif + événement | bool |
| Remboursement (% du prix billet) | 100 | collectif + événement | 0–100 entier |
| Frais de service remboursables | non | collectif | bool |
| Plafond places par commande | 6 | collectif + événement | 1–20 |
| Plafond places par personne / événement | 6 | collectif + événement | 1–50, ≥ plafond commande |
| Délai de réponse liste d'attente (min) | 120 | collectif + événement | 15–2880 |
| Liste d'attente activée | oui | collectif + événement | bool |
| Frais de service | 0 | collectif + événement | fixe en centimes (0–1000) + points de base (0–1500, 250 = 2,5 %), arrondi au centime, affichés avant paiement |
| Coordonnées virement (titulaire, IBAN, BIC) | — | collectif | IBAN validé (mod 97), BIC regex ; virement impossible tant que non renseigné |
| Fuseau horaire par défaut | Europe/Paris | collectif | IANA |
| Email de contact affiché aux acheteurs | — | collectif | email |

Sécurité de ces réglages :
- Écriture réservée au rôle **OWNER** (MANAGER : lecture seule ; surcharges événement : OWNER + MANAGER), via `PATCH /orgs/:orgId/settings` et `PATCH /orgs/:orgId/events/:eventId` ; schémas Joi stricts (bornes ci-dessus, `allowUnknown: false`).
- IBAN = donnée sensible : jamais exposé dans les endpoints publics sauf à l'acheteur d'une commande `AWAITING_TRANSFER` qui le concerne ; affiché masqué (`FR76 •••• 1234`) dans le back-office hors édition.
- Chaque modification tracée dans `AuditLog` (avant/après, IBAN masqué).
- Contraintes métier croisées vérifiées côté service (ex. plafond par personne ≥ plafond par commande, délai d'annulation impossible à réduire sous les commandes existantes → n'affecte que les nouvelles commandes).

Front back-office : page « Réglages du collectif » + section « Règles de vente » dans le formulaire d'événement avec bascule « utiliser le réglage du collectif / personnaliser » et affichage de la valeur effective.

Tests ajoutés : héritage collectif → événement, figement sur commande existante, MANAGER refusé en écriture des réglages collectif, IDOR réglages inter-collectifs, bornes Joi, non-fuite IBAN dans les réponses publiques.
