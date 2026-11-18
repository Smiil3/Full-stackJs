# Rapport d'audit sécurité n° 2 — Billetterie « Les Nuits de la Garonne »

Date : 2026-10-07. Cible : branche `main`, commit `5852eb3` (« Merge pull request #2 »). Périmètre : tout le dépôt, avec priorité au diff `29af261..HEAD` (PR #1 refonte visuelle « Miroir d'eau », PR #2 traitement du rapport du 2026-10-06), soit 436 fichiers modifiés, +13 345 / −1 661 lignes. Mode attaquant : failles exploitables **et** mauvaises pratiques de code.

Méthode : lecture intégrale du code ajouté ou modifié (backend, frontend, migrations, tests, configuration), confrontation à `docs/audits/2026-10-06-traitement.md`, `SECURITY.md`, `DECISIONS.md` (back et front) et `docs/api-contract.md` v1.17 ; exécution en lecture seule de `lint`, `typecheck`, `prisma validate`, `prisma migrate status`, `npm test` (back et front), `npm audit` (prod et dev), `npm outdated` ; analyse AST pour les comptes de qualité (scripts dans le scratchpad de session, non commis). Aucun fichier suivi modifié, aucune opération git d'écriture, aucun secret cité. Chaque trouvaille est marquée **vérifié** (lue dans le code ou un test) ou **déduction** (raisonnement sur la sémantique PostgreSQL ou un entrelacement non rejoué).

## Synthèse

| Sévérité | Nombre |
|---|---|
| Critique | 0 |
| Haute | 0 |
| Moyenne | 4 |
| Basse | 13 |
| Qualité | 16 (regroupées) |
| Info | 18 |

Résultats automatisés : lint et typecheck au vert sur les deux applications ; 34 fichiers / 420 tests backend et 36 fichiers / 586 tests frontend au vert ; 21 migrations appliquées, schéma à jour ; `npm audit` à 0 vulnérabilité (prod et dev) ; aucun secret, `.env`, `.pem` ni artefact de build suivi par git.

Verdict : les 27 points du premier rapport sont traités, 20 complètement. Quatre corrections sont **partielles** et ouvrent chacune un point moyen : le verrou de compte reste entretenable à bas coût (M7), l'anti-gel de la liste d'attente se contourne en quittant l'offre (M2), le report par lots fait perdre ses droits à une commande expirée puis payée tardivement (B7), et l'éditeur d'événement écrase encore les champs non touchés (B17-b). Aucun chemin trouvé vers un vol d'argent, une survente, une lecture inter-collectif, une injection, un XSS, un rejeu de webhook ou un billet forgé. La dette de code est faible pour un projet de cette taille (aucun `any`, aucun `!` en production, aucun cycle d'import, aucun TODO) ; elle se concentre sur la duplication de petits helpers, le contournement des repos et quelques assertions de test faibles.

## Trouvailles

### Moyennes

**M'1 — Verrou de compte : le compteur global ne se remet jamais à zéro, le verrou se maintient avec une requête toutes les 15 min (vérifié)**
`backend/src/modules/auth/repo.ts:56-74`, `config/auth.ts:43-45`, `SECURITY.md:109`. Le verrou par couple (compte, IP) fonctionne et protège le titulaire sur son réseau. Mais le niveau « compte, toutes IP » compte 50 échecs sur une fenêtre glissante **depuis le dernier échec** (`lastFailedLoginAt < now − 60 min ⇒ 1, sinon +1`) et pose un verrou fixe de 15 min sans jamais ramener `failedLoginCount` sous le seuil. Une fois 50 atteint (5 à 10 préfixes IP suffisent, un /48 IPv6 en fournit 256), chaque nouvel échec dans l'heure qui suit le précédent re-verrouille 15 min : **une requête toutes les 15 min, depuis n'importe quelle IP, maintient le compte fermé indéfiniment**. SECURITY.md affirme « au moins 50 tentatives par heure » : inexact après la rafale initiale. Le test `tests/a1/lockout.test.ts` ne couvre pas l'entretien du verrou. Correction : remettre le compteur à 1 quand le verrou a expiré (ou compter la fenêtre depuis le premier échec), proposer un déverrouillage par lien mail au titulaire, et corriger la limite connue.

**M'2 — Anti-gel de la liste d'attente contournable : quitter une offre n'est jamais compté (vérifié)**
`backend/src/modules/waitlist/service.ts:102-116` (`leave`), `:210-213` (seul endroit qui pose `offerExpired: true`). `DELETE /waitlist/:entryId` sur une entrée `OFFERED` passe en `LEFT`, libère les places et redistribue, sans pénalité. Deux comptes vérifiés A et B sur un type complet : A reçoit l'offre, la garde jusqu'à 5 h 59, quitte ; B reçoit, fait de même ; A se réinscrit (autorisé, le type est toujours complet) : le stock reste gelé indéfiniment par cycles de 6 h. L'abandon d'une commande issue d'une offre (`accept` puis expiration sans paiement) n'est pas compté non plus. Le test anti-gel injecte directement `offerExpired: true` en base. Correction : poser `offerExpired` quand on quitte une offre après un court délai de grâce ou après `offerExpiresAt`, et compter l'expiration d'une commande issue d'une offre.

**M'3 — Report par lots : une commande expirée pendant le traitement puis payée tardivement perd les droits du report (déduction, code vérifié)**
`backend/src/modules/events/reschedule.ts:30-33`, `payments/settle.ts` (`tryResettleExpiredOrder`), `jobs/expireOrders.ts`. `applyToLockedOrder` démarque sans rien appliquer toute commande hors `PENDING_PAYMENT / AWAITING_TRANSFER / PAID`. `applyPendingReschedule` n'est appelé que depuis `orders/cancel.ts:90`, ni dans `expireOrders`, ni dans le règlement tardif. Une commande en attente marquée par le report, expirée avant le passage du worker, puis payée en retard (chemin prévu par le contrat) redevient `PAID` avec l'ancien `refundPercent`, un `cancellableUntil` calculé sur l'ancien `startsAt` (parfois déjà passé) et sans mail de report. L'ancienne implémentation en une transaction couvrait ce cas. Correction : appliquer les droits aussi aux commandes `EXPIRED` (sans mail), ou appeler `applyPendingReschedule` avant `EXPIRED` dans `expireOrders` et dans `tryResettleExpiredOrder`.

**M'4 — Éditeur d'événement : le PATCH renvoie encore les anciennes valeurs des champs non touchés (vérifié)**
`frontend/src/pages/org/eventForm.ts:98-120`, `EventEditor.tsx:80`. `diffPatch` compare titre, description, lieu, adresse, `isOnline` et surcharges à l'événement **courant** (`props.event`, rafraîchi) ; seuls fuseau et dates sont comparés au formulaire initial. A ouvre l'éditeur, B change le titre ou `refundPercent`, A enregistre une description : le PATCH embarque l'ancien titre et l'ancienne surcharge. Conséquences : écrasement silencieux (B17-b annoncé « corrigé »), et pour un MANAGER un 403 incompréhensible puisqu'il renvoie une valeur financière périmée. Le test B17-b n'examine pas le corps du PATCH. Correction : comparer chaque champ au formulaire initial, comme `settingsPatch.ts` le fait désormais pour les réglages.

### Basses

**B'1 — `Idempotency-Key` : TTL de 30 min plus court que la réservation, et `UNEXPECTED_RESPONSE` 2xx oublie la clé (vérifié)**
`frontend/src/api/hooks/orders.ts:18,41-44`. `cardHoldMinutes` va jusqu'à 60 min et `transferHoldHours` jusqu'à 240 h : après une réponse perdue puis 30 min, le même panier obtient une nouvelle clé et une seconde commande (`LIMIT_EXCEEDED` ou double blocage de places, sans survente). Une 2xx au corps vide ou non JSON lève `UNEXPECTED_RESPONSE` (non transitoire) : la clé est oubliée alors que la commande a pu être créée. Correction : supprimer le TTL (la clé est déjà oubliée sur `EXPIRED`, `CANCELLED` et à la déconnexion) et classer `UNEXPECTED_RESPONSE` avec `status < 300` comme transitoire.

**B'2 — Scanner : un second passage du même QR est ignoré en silence (vérifié)**
`frontend/src/scanner/ui/sameCodeFilter.ts:20-22`. Chaque lecture repousse `lastSeenAt` : un QR présenté deux fois de suite par deux porteurs (capture partagée) sans sortir du champ, ou moins de 3 s après la fermeture, ne produit ni vert ni rouge. Rien n'entre, mais le contrôleur ne voit « rien ». Le câblage `CameraScanner` / `SameCodeFilter` n'est couvert par aucun test (le composant n'est jamais monté) ; `useRef(new SameCodeFilter())` recrée une instance jetée à chaque rendu (`CameraScanner.tsx:16`). Correction : distinguer « toujours dans le champ » (écart entre lectures < 1 s) de « re-présenté », ou afficher un bref « billet déjà lu à l'instant ».

**B'3 — Retour depuis le cache navigateur : masque levé après 3 s même sans revérification (vérifié)**
`frontend/src/auth/AuthProvider.tsx:12,139-141`. Minuteur fixe de 3 s ; réseau lent ⇒ contenu d'une session terminée redevient visible et actif. Compromis documenté (D69) et testé, mais fenêtre d'exposition non nulle. Correction : lever le masque au plus tôt entre fin de revérification et un plafond plus long.

**B'4 — Offre de liste d'attente : message faux et compteur invisible (vérifié)**
`frontend/src/pages/tickets/WaitlistOfferPage.tsx:61` promet « vous restez inscrit·e » alors que le backend passe l'entrée en `EXPIRED` et exclut après deux offres expirées ; aucun compteur affiché ; le mock compte les `EXPIRED` et non `offerExpired` (`mocks/handlers/buyer.ts:196`), les deux divergent.

**B'5 — Une offre raccourcie par la fin des ventes compte comme « offre expirée » (vérifié)**
`backend/src/modules/waitlist/distribute.ts:73`, `service.ts:210-213`. `offerExpiresAt = min(now + minutes, startsAt, salesEndAt)` : une offre émise 10 s avant `salesEndAt` est intenable et pénalise le compte. Correction : ne pas poser `offerExpired` sous le seuil minimal de 15 min, ou ne pas émettre d'offre sous ce seuil.

**B'6 — Report bloqué sans outil de sortie (vérifié)**
`backend/src/modules/events/reschedule.ts:93-110`, `events/service.ts:251`. Une commande en échec persistant est réessayée à chaque tick, `completedAt` n'est jamais posé, tout nouveau report renvoie 409. Pas d'équivalent de `/admin/stuck-orders` pour les reports, ni de `reschedulePendingOrders` dans `EventAdmin` (alors que `cancellationPendingOrders` existe). Même effet si le worker est arrêté.

**B'7 — Remboursements : `pending` PSP sans fin ni visibilité, erreur de recherche confondue avec « introuvable » (vérifié)**
`backend/src/jobs/processRefunds.ts:27-34,84`. Un remboursement `pending` au PSP est reconsulté toutes les 10 min indéfiniment avec un `warn` répété comme seul signal ; `findRefund(row.id).catch(() => null)` transforme une erreur réseau en « introuvable » et peut faire passer en `MANUAL_REQUIRED` sans trace de la cause.

**B'8 — Arrêt de l'API : rejet non géré (vérifié)**
`backend/src/server.ts:39` : `void disconnectDb().finally(() => process.exit(0))`. Si `$disconnect()` rejette, sortie seulement par le minuteur de secours, code 1. Correction : `.catch(log).finally(exit)`.

**B'9 — Scanner : erreurs de synchronisation avalées, purge sans `catch` (vérifié)**
`frontend/src/scanner/ui/ScannerPage.tsx:81` n'affiche que `SyncForbiddenError` ; réseau ou 5xx ⇒ aucun retour au contrôleur. `:71` `void purgeEvent(eventId).then(reload)` sans `catch` ⇒ rejet non géré sur erreur IndexedDB.

**B'10 — Trois transactions hors du helper `transaction()` (vérifié)**
`backend/src/lib/outbox.ts:93`, `jobs/processRefunds.ts:53`, `modules/reports/attendees.ts:28` : `db.$transaction` sans `maxWait` / `timeout`, donc défauts Prisma (2 s / 5 s) au lieu de `TX_MAX_WAIT_MS` / `TX_TIMEOUT_MS`, précisément sur des chemins sollicités en pic.

**B'11 — `prisma generate` non automatique (vérifié)**
`backend/package.json` : `src/generated/` gitignoré, `test`, `lint` et `dev` ne lancent pas `prisma generate`, pas de `postinstall`. Sur un clone neuf, `npm ci && npm test` échoue ; le README racine omet l'étape. Correction : `postinstall: prisma generate`.

**B'12 — Réservation de tentative de connexion en deux instructions hors transaction (vérifié)**
`backend/src/modules/auth/repo.ts:36-74`. Le compteur du couple est incrémenté puis, si le compte est verrouillé, la tentative est refusée sans évaluation : le couple paie une tentative fantôme. Sans impact sécurité, mais la promesse « atomique » du commentaire n'est tenue que par instruction.

**B'13 — Tests `a1` : `Date.now()` et `!` dans le test de verrouillage (vérifié)**
`backend/tests/a1/lockout.test.ts:30` compare `row.lockedUntil!` à `Date.now()` alors que le code utilise `clock.now()` ; fragile si l'horloge de test est simulée.

### Qualité

- **Q1 — Gabarits mail : typage annulé.** `lib/mail/templates.ts:62` (`as unknown as Record<string, …>`), `lib/outbox.ts:113` (`as never`). Une clé mal orthographiée produit un mail à trou sans erreur de compilation. Correction : table `{ [K in MailTemplate]: (d: TemplatePayloads[K]) => RenderedMail }`.
- **Q2 — Duplication de helpers.** `UUID_RE` 4× back (`requireOrgRole.ts:8`, `jwt.ts:7`, `ticketSigning.ts:8`, `webhook.ts:52`) et 3× front avec casse incohérente ; regex base64url `{22}` / `{43}` / `{86}` répétées ; deux `BEARER` divergents (`middlewares/auth.ts:13` vs `rateLimit.ts:39`) ; `type Empty` 12× ; `const int = Joi.number().integer()` 4× ; `orgParams` / `eventParams` 4× ; `RANK` des rôles 2× back et 2× front ; extraction du code Prisma écrite 5 fois ; `keyGenerator` identique 3× avec cast de `res.locals` (`rateLimit.ts:82,90,96`).
- **Q3 — Verrous SQL écrits à la main à ~12 endroits** ; `admin/stuckOrders.ts:35` duplique `loadOrderForUpdate` sans l'ordre « event KEY SHARE → order » documenté en B1. Correction : `lib/locks.ts`.
- **Q4 — Services qui contournent les repos.** 166 appels Prisma ou SQL brut hors `repo.ts` dans `modules/` contre 58 dans les repos ; 8 modules sur 14 n'ont pas de repo ; `events/service.ts` en a 36 alors qu'`events/repo.ts` existe. `docs/plan.md:18` annonce `routes → controller → service → repo`.
- **Q5 — Couplage circulaire entre modules.** `orders ↔ payments ↔ waitlist` ; `waitlist/service.ts:172` casse le cycle par un `await import('../payments/settle.js')`, seul `import()` du backend. `settle.ts` est le cœur de règlement utilisé par cinq modules : à sortir dans `settlement/`.
- **Q6 — `streamAttendees` prend l'objet Express `Response`** (`reports/attendees.ts:20`) : en-têtes HTTP, `res.on('close')` et SQL dans le service ; le test fabrique une fausse réponse par `as unknown as Response`.
- **Q7 — Fonctions longues.** `createMockPsp` 222 l., `runSeed` 181, `renderTemplate` 133, `reserveAndCreate` 124, `createApp` 88 ; côté front `ScannerPage` 340, `Layout` 262, `EventEditor` 246, `OrderForm` 210, `OrderPage` 206. 22 fonctions > 100 lignes.
- **Q8 — Tests backend au typage relâché.** `eslint.config.js` désactive `no-non-null-assertion` et `no-unsafe-*` pour `tests/**` : 293 `!` et 160 `as` ; un `!` sur un cookie absent donne un TypeError obscur au lieu d'un échec lisible.
- **Q9 — Assertions faibles.** 12 `lastMail(...).not.toBeNull()` sans contrôle du contenu ; 7 `getAccessToken()).not.toBeNull()` ; `toBeDefined()` sur des erreurs Joi ; `toHaveBeenCalled()` sans argument (10) ; 0 `expect.assertions`.
- **Q10 — Tests qui ne prouvent pas la correction.** B2 : `expireFailures: 0` est posé sur une commande qui passe en `EXPIRED`, état terminal (code mort) et le test « succès ⇒ remise à zéro » l'entérine ; le compteur reste cumulatif entre ticks. B1 : `expect([204, 409]).toContain(status)` accepte précisément le 409 d'un interblocage rejoué trois fois ; un seul entrelacement joué. B8 : aucun cas « conservé » pour `refresh_tokens`, `psp_sessions`, `check_ins`. M1 : pas de test où l'OWNER fixe une valeur puis où le MANAGER envoie `null` (le code est correct, non testé). M4 : câblage non testé.
- **Q11 — Nommage des tests par ticket.** `tests/a1/`, `tests/b7/`, `b31`, `b41`, `b51`, `b61`, `b71`, deux `b9.test.ts` ; 17 fichiers sur 36. Codes d'audit en collision (« B9 » = lot, constat et décision ; « B1 » = socle et cycles) ; 16 tests citent `B1.1` et des identifiants `B9 H1`, `B9 M1`… absents de toute documentation.
- **Q12 — Code mort certain.** `lib/schemas.ts:74` `itemsOf`, `orders/repo.ts:17` `findByIdempotencyKey`, `lib/db.ts:6` `Db`, front `api/hooks/org.ts:49` `useOrg`, `api/types.ts:11` `ItemsResponse`, `auth/tokenStore.ts:14` `getAccessTokenExpiry`, `scanner/pinnedKey.ts:43` `pinnedTicketKey` ; `pino-pretty` en devDependency sans aucune référence ; 111 exports jamais importés ailleurs. Correction : `knip` en CI.
- **Q13 — Frontend : trois ouvertures IndexedDB identiques et `ownerHash` dupliqué** (`offline/pendingLogout.ts:12`, `offline/tickets.ts:25,37`, `scanner/db.ts:76,153`) ; 18 `invalidateQueries` avec clés littérales alors que `api/queryKeys.ts` existe (`['org', orgId, 'refunds']` et `checkin-events` n'y figurent pas) ; 42 conversions de temps en dur (`/ 1000`, `60_000`) sans équivalent du `config/units.ts` du back ; `CONFLICT_LABELS` défini deux fois avec des contenus différents.
- **Q14 — `eslint-disable`.** 17 occurrences, toutes motivées sauf 4 `eslint-disable-line no-non-null-assertion` sans motif dans `scanner/scanner.test.ts:84,103,108,128` ; `ScannerPage.tsx:97` désactive `exhaustive-deps` avec une expression booléenne dans le tableau de dépendances ; 4 désactivations identiques de `detect-non-literal-fs-filename` dans `ticketSigning.ts` remplaçables par un override de config.
- **Q15 — Compteurs globaux mutables pour les tests en production** : `passwordMetrics`, `authMetrics`, `checkinMetrics`.
- **Q16 — Mocks MSW : 2 876 lignes qui ré-implémentent les règles métier**, 23 casts `Record<string, unknown>` ; seule `contract.test.ts` détecte une dérive (déjà une : le compteur d'offres expirées, B'4).

### Info

- `SECURITY.md:25` décrit encore le verrouillage sans le couple (compte, IP) ; `:69` affirme que le lint interdit `localStorage` sans mentionner l'exception `ndg-theme` (D56) ; `:100` dit « snapshot signé par une autre clé » alors que le snapshot n'est pas signé (sa clé est comparée) ; check-list « build refusé » sans la nuance `mode === 'production'`.
- `vite.config.ts:35` : les refus de build (PSP https, clé B14) ne valent que pour `--mode production` ; `--mode staging` passe le build, l'application refuse ensuite de démarrer (`import.meta.env.PROD`). Validation de la clé dupliquée entre `vite.config.ts` et `pinnedKey.ts`.
- 503 `PAYMENT_PROVIDER_UNAVAILABLE` : pas de fuite, `Retry-After` exposé par CORS ; réserves : tout `AppError` portant `retryAfterSeconds` perd désormais ses autres `details` (`errorHandler.ts:36-43`) ; `isPspUnavailable` ne couvre pas un `SyntaxError` de `res.json()` sur corps tronqué ni un `TypeError('terminated')` (⇒ 500) ; une `PspError(502)` issue des contrôles de forme est présentée comme « injoignable » ; message « vos places restent réservées » sans borne (le front ajoute l'heure).
- `ipFingerprint` : `TRUST_PROXY_HOPS` faux ⇒ tous les clients partagent une empreinte, le verrou par couple redevient un verrou de compte (déjà couvert par la check-list).
- Événement : en cas de report, l'audit `event.update` n'est pas écrit (seul `event.reschedule`) : titre et surcharges non financières d'un PATCH-report ne sont pas tracés ; `createEvent` n'audite pas les surcharges non financières ; le prix des types de places reste modifiable par un MANAGER sans mail aux OWNER (même classe de risque que M1, conforme au contrat).
- `toOrderView` d'une commande marquée `pendingRescheduleId` affiche l'ancien `refundPreviewCents` et l'ancien `cancellableUntil` jusqu'au passage du worker.
- Rétention : la suppression d'un refresh token rotatif à `expiresAt + 30 j` remplace « révocation de famille sur réutilisation » par un simple 401 ; sans effet pratique (jeton expiré).
- Thème : `index.html` pose `data-theme="dark"` en dur ⇒ flash sombre pour un visiteur « jour » (inévitable sans nonce CSP) ; pas de synchronisation inter-onglets ; `__clearThemePreference` exporté d'un module de production.
- Fuseau d'affichage incohérent : appareil pour « réservées jusqu'à HH:MM » (`OrderPage.tsx:179`), événement pour le message de paiement échoué (`:140`) et `WaitlistOfferPage`.
- `parseRetryAfter` non borné (un `Retry-After` immense désactive « Réessayer » très longtemps ; serveur de confiance).
- `docs/api-contract.md` : en-tête « 1.17 — 2026-10-06 » vs historique 2026-10-07 ; ligne `POST /admin/orgs` tombée dans le bloc `StuckOrder` (tableau cassé).
- `backend/README.md:105` annonce 385 tests (420 `it()`), `frontend/DECISIONS.md:67` 450 (360 `it()`).
- `docs/plan.md` périmé : modules `stats`, `exports` inexistants, `admin`, `catalog`, `orgOrders`, `refunds`, `reports`, `settings` absents, 10 modèles de données omis, aucune mention « historique ».
- E2E : `test.skip(!PASSWORD)` en tête de 5 specs ⇒ sans `.env.e2e` la suite passe au vert sans rien exécuter.
- `docs/design-kit/` (99 fichiers) duplique polices, icônes et CSS de `src/` ; 20 captures PNG commises, écrans mock uniquement (vérifié).
- Variables `E2E_PORT`, `CAPTURE_DIR`, `CAPTURE_PORT`, `MAILPIT_URL` lues mais non documentées ; `ALLOW_SEED` lu hors du schéma Joi.
- Config : `lint` avec `--max-warnings 0` côté front seulement ; `exactOptionalPropertyTypes` et `noImplicitReturns` activés côté back seulement ; ESLint 10 back / 9 front ; `.nvmrc` côté front seulement ; `tsconfig.app.json` expose `@testing-library/jest-dom` au code de production ; docker-compose : healthcheck sur `postgres` seul, Postgres par tag et Mailpit par digest ; `playwright.pwa.config.ts` avec syntaxe POSIX non portable ; 4 configs Playwright qui répètent la même base.
- `npm outdated` : majeures disponibles (TypeScript 7, Prisma 8 rc, ESLint 10 front, MSW 3) ; aucune vulnérabilité.
- `commonPasswords.ts` (170 Ko) sans script de régénération documenté.

## État des corrections du rapport n° 1

| # | Sujet | Statut | Preuve / réserve |
|---|---|---|---|
| M1 | MANAGER et règles financières | **Fait** | `events/service.ts:131-135,157-164,247-249` (`null` sur valeur non nulle = changement ⇒ 403), audit + mail à tous les OWNER dans la même transaction ; `requireRoleInTx` ; front champs en lecture seule. Test du cas `null` manquant (Q10) ; prix des types de places hors périmètre (Info). |
| M2 | Gel via liste d'attente | **Partiel** | Bornes 15–360 min (`settingsBounds.ts:19`, migration), compteur par (compte, événement). Contournable par `leave` (**M'2**) ; offre raccourcie pénalisante (B'5) ; message front faux (B'4). |
| M3 | Worker affamé | **Fait** | `jobs/schedule.ts` : deux boucles, `TimeBudget` 20 s par job, `mapLimit` 5 pour le PSP, arrêt vérifié entre jobs ; `tests/a1/worker.test.ts`. |
| M4 | Faux « déjà utilisé » | **Fait avec réserve** | `sameCodeFilter.ts` + 5 tests réels ; masquage silencieux d'un vrai second passage (B'2), câblage non testé. |
| M5 | `Idempotency-Key` | **Partiel** | Oubli sur `EXPIRED`/`CANCELLED`/erreur non transitoire, tests réels ; TTL 30 min trop court et `UNEXPECTED_RESPONSE` 2xx (B'1). |
| M6 | Écrasement des réglages | **Fait** | `settingsPatch.ts:12-22` contre l'état initial, conflit signalé ; 4 tests unitaires + intégration. Détection bornée au refetch de 15 s (pas d'`If-Match`). |
| M7 | Verrouillage par un tiers | **Partiel** | Couple (compte, IP) effectif ; niveau compte entretenable à 1 requête / 15 min (**M'1**), limite connue inexacte. |
| B1 | Cycles de verrous | **Fait (déduction)** | `settle.ts:31-36` (event KEY SHARE avant l'ordre), `leave`/`expireWaitlistOffers` verrouillent les entrées du type avant l'entrée propre, `withTxRetry` sur report et types. Aucun cycle résiduel trouvé par lecture ; le test ne peut pas en détecter un (Q10). |
| B2 | `expireOrders` | **Partiel** | `withTxRetry` et `/admin/stuck-orders` + `retry` effectifs ; la « remise à zéro » est du code mort, compteur cumulatif entre ticks (Q10). |
| B3 | Remboursements orphelins | **Fait** | `GET /admin/refunds`, `POST /admin/refunds/:id/mark-done`, onglet « Anomalies » derrière `RequirePlatformAdmin`, tests réels. |
| B4 | MANAGER valide virements | Risque accepté, documenté | — |
| B5 | `pending` ⇒ double remboursement | **Fait** | `refunds/service.ts:64-96` : PSP interrogé hors transaction, `pending` ⇒ 409, injoignable ⇒ 503, `succeeded` ⇒ `providerRefundId` posé ; `processRefunds` ne passe plus un `pending` en manuel. Test 503 front absent ; `pending` sans fin sans visibilité (B'7). |
| B6 | Fuseau du mail de report | **Fait** | `events/service.ts:271`, `reschedule.ts` (old/new timezone), test avec assertions sur les deux fuseaux. |
| B7 | Report en une transaction | **Partiel** | Lots par le worker (`reschedule.ts`), 409 si report en cours, un mail par acheteur, auto-annulation applique d'abord le report ; perte de droits sur commande expirée puis payée (**M'3**), report bloqué sans sortie (B'6). |
| B8 | Rétention | **Fait** | `config/retention.ts` = SECURITY.md:57 ; rien d'utile supprimé ; tests sans cas négatif (Q10). |
| B9 | Logs | **Fait** | `logger.ts:6-22`, messages Joi réduits à `path: type` ; reste des clés absentes (`recipient`, `userEmail`, en-têtes) et `scrub` efface aussi les UUID (Info). |
| B10 | CSV | **Fait** | `csv.ts:18-22` : `\t=`, ` =`, NBSP, U+2028, `x,=1+1`, `x;=1+1`, `"=1+1` tous neutralisés ou cités. |
| B11 | Écouteurs d'export | **Fait** | `attendees.ts:36-53`, dédoublonnage d'audit 5 min, limiteur `exportPerUser` 5/min. |
| B12 | Rôle non relu en transaction | **Fait** | `lib/orgRole.ts` `requireRoleInTx` (FOR SHARE) dans `updateSettings`, `addMember`, `updateMemberRole`, `removeMember`, `cancelEvent`, `updateEvent`, `createEvent` ; c'est le rôle relu qui décide. |
| B13 | Seed | **Fait** | `ALLOW_SEED=1` vérifié en premier, refus si compte hors liste de démo, DECISIONS aligné. |
| B14 | Clé publique épinglée | **Fait** | `pinnedKey.ts` (JWK strict), `snapshot.ts:53`, `engine.ts:258` (jamais la clé d'IndexedDB), build et démarrage refusés sans clé ; tests réels ; clé de dev non commise. |
| B15 | `qrPayload` en file | Documenté | — |
| B16 | Plus de bouton après 60 s | **Fait** | `OrderPage.tsx:63-170`, deux tests à horloge simulée. |
| B17 a–g | Divers front | **Fait sauf b** | a (BroadcastChannel), c (double envoi), d (invalidations), e (confirmation OWNER), f (bfcache 3 s, B'3), g (TicketsPage) ; b partiel (**M'4**). |
| B18 | Mail de reset par un tiers | Risque accepté, documenté | — |
| Info | Incohérences et durcissements | **Faits** | `take: 500`, offre gratuite, `getSettings` sans upsert + migration, `SUM` bigint, mysql2 documenté, `eventId` minuscule, CSP `upgrade-insecure-requests` (déployé) et `img-src 'self'`. |
| + | 503 PSP injoignable | **Fait** | `errors.ts`, `isPspUnavailable`, `orders/service.ts:321-327`, `RetryLater`, tests back (port fermé, 502, timeout, 4xx) et front (compte à rebours). |

## Vérifié sans trouvaille

- **Nouvelles routes** : `/admin/refunds`, `/admin/refunds/:id/mark-done`, `/admin/stuck-orders`, `/admin/stuck-orders/:id/retry` derrière `requireAuth` + `requirePlatformAdmin` (404 pour un non-admin), schémas Joi stricts, audit systématique ; `markDoneIn` sérialisé par `updateMany` gardé (deux MANAGER concurrents ⇒ un 409).
- **M1** : `FINANCIAL_OVERRIDE_KEYS` couvre les six champs du contrat ; `overridesOf` renvoie aussi les `null` ; `escapeHtml` sur toutes les interpolations du mail `financialRulesChanged`.
- **Rate limiting** : valeurs identiques au rapport n° 1 ; seul ajout `exportPerUser` ; `trust proxy` et clés inchangés ; quota login par (adresse, empreinte).
- **Migrations `20261007*`** : `event_reschedules` et `reschedule_notifications` (FK cascade, index partiel), `waitlist_anti_freeze` (défaut `false`, bornage sans écrasement), `login_lockouts` (clé `(userId, fingerprint)`, FK cascade), `settings_backfill` (`INSERT … WHERE NOT EXISTS`). Remarques : pas de FK sur `orders.pendingRescheduleId`, pas de `CHECK` SQL sur la borne des durées d'offre (Joi seul).
- **Refactor des constantes** (`config/*`) : toutes les valeurs d'origine conservées (argon2, GCM, JWT, limites de corps, frais, délais).
- **Frontend design** : `readThemePreference` n'accepte que `'dark'` ou `'light'`, aucun `data-theme` arbitraire ; aucun script inline ; `Icon.tsx` via `<use href="/icons.svg#…">` même origine, nom typé par union de littéraux, sprite sans script ni `foreignObject` ; `Poster`, `BrandMark`, `Gauge`, `QuantityStepper`, `Countdown` sans attribut `style` chaîne ; polices locales (12 woff2 ≥ 6,5 Ko, non inlinées) ; aucune dépendance ajoutée ; `demoSeed.ts` chargé uniquement si `DEV && MODE === 'mock'`, `vite build --mode mock` toujours refusé, `dist/` sans trace de mock.
- **ESLint sécurité front** : exception `localStorage` limitée à `themePreference.ts` et vérifiée par `eslint.security.test.ts` ; `sessionStorage`, `window.localStorage`, `indexedDB` toujours restreints.
- **Captures** : `playwright.captures.config.ts` écrit dans `test-results/captures` (ignoré) avec données mock ; les PNG de `docs/design-kit/captures/` sont des écrans mock, aucun secret dans `docs`, `src`, `e2e`, `public`.
- **Code** : 0 `any`, 0 `@ts-ignore`, 0 `!` en production, 0 cycle d'import au niveau fichier, 0 fichier orphelin, 0 TODO/FIXME, 0 test sans `expect`, 0 `.skip`/`.only`, 0 snapshot, 0 `vi.mock` remplaçant la fonction testée ; 55 routes du contrat = 55 routes montées ; tous les scripts npm documentés existent ; versions annoncées cohérentes.

## Priorités recommandées

1. **M'1** : remettre le compteur global à 1 à l'expiration du verrou (ou fenêtre depuis le premier échec), ajouter un déverrouillage par mail, corriger `SECURITY.md:25,109`.
2. **M'3** : appliquer les droits du report aux commandes `EXPIRED` ou avant `EXPIRED` dans `expireOrders` et `tryResettleExpiredOrder` ; ajouter le test manquant.
3. **M'2 + B'5** : compter l'abandon d'une offre (`leave` après grâce, commande issue d'une offre expirée), ne pas pénaliser une offre raccourcie ; corriger le message et le mock (B'4).
4. **M'4** : `diffPatch` contre le formulaire initial pour tous les champs ; test sur le corps du PATCH.
5. **B'1, B'2, B'3** côté front avant le prochain événement (clé d'idempotence sans TTL, feedback « déjà lu », masque bfcache lié à la revérification).
6. **B'6, B'7** : liste admin des reports bloqués et `reschedulePendingOrders` ; visibilité des `pending` PSP ; ne pas confondre erreur de recherche et « introuvable ».
7. **B'8 à B'11** : trois lignes chacune (`.catch` au shutdown, `transaction()` sur les trois transactions, `postinstall: prisma generate`, retour d'erreur de sync au scanner).
8. **Qualité, par rendement** : helpers partagés (Q2, Q3), typage des gabarits mail (Q1), `settle.ts` en module `settlement/` et suppression du `import()` dynamique (Q5), assertions de mails et de tokens (Q9), tests nommés par domaine et codes d'audit documentés (Q11), `knip` en CI et suppression du code mort (Q12).
9. **Documentation** : SECURITY.md (quatre formulations), contrat (date, tableau cassé), README (compte de tests, `prisma generate`), `docs/plan.md` marqué historique ou mis à jour, variables e2e documentées.

Points marqués « déduction » : M'3 (entrelacement non rejoué, code vérifié), absence de cycle résiduel en B1, rôle TOCTOU résolu par `FOR SHARE`. Non vérifié : comportement réel des tableurs sur le CSV, débit des purges sur gros volumes.
