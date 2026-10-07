# Rapport d'audit sécurité — Billetterie « Les Nuits de la Garonne »

Date : 2026-10-06. Périmètre : `backend/` (Express 5 + Prisma/PostgreSQL, worker, PSP simulé), `frontend/` (React 19 PWA, scanner), `docs/`, déploiement (`docker-compose.yml`, `frontend/deploy/`), dépendances. Audit en lecture seule : aucun fichier du dépôt modifié, aucun test lancé, pas d'exploitation dynamique. Méthode : lecture intégrale du code source hors `generated/` et hors tests, confrontation systématique aux garanties annoncées dans `SECURITY.md`, `DECISIONS.md` et `docs/api-contract.md`, `npm audit --omit=dev`, vérification de l'historique git.

## Synthèse

| Sévérité | Nombre | Résumé |
|---|---|---|
| Critique | 0 | — |
| Haute | 0 | — |
| Moyenne | 7 | Droits MANAGER sur règles financières, gel de stock via liste d'attente, worker affamé par le PSP, faux « déjà utilisé » au scan, clé d'idempotence jamais renouvelée, écrasement silencieux des réglages, verrouillage de compte illimité |
| Basse | 18 | Interblocages non couverts, expiration définitivement écartée, remboursements orphelins invisibles, logs, CSV, seed, purge, etc. |
| Info | ~12 | Incohérences documentaires, durcissements |

Verdict : code d'un niveau de sécurité très élevé. Aucun chemin trouvé vers un vol d'argent, une survente, une lecture inter-collectif (IDOR), une injection SQL, un XSS, un open redirect, un rejeu de webhook, ou un billet forgé. Les écarts relevés sont de trois natures : des **promesses de SECURITY.md plus fortes que le code**, des **privilèges plus larges qu'annoncés**, et des **bugs de robustesse / disponibilité / logique métier**.

## Trouvailles

### Moyennes

**M1 — Un MANAGER modifie les règles financières d'un événement (SECURITY.md promet OWNER)**
`backend/src/modules/events/routes.ts:13-15`, `events/schemas.ts:10-12`. Les surcharges par événement (`refundPercent`, `serviceFeeFixedCents`, `serviceFeeBasisPoints`, `transferEnabled`, `selfCancellationEnabled`, `cancellationDeadlineHours`, `maxPerOrder`, `maxPerUser`…) sont acceptées en POST/PATCH avec `requireOrgRole('MANAGER')`, alors que `PATCH /orgs/:orgId/settings` exige OWNER et que SECURITY.md classe « réglages » parmi les actions OWNER. Un MANAGER peut mettre `refundPercent` à 0 et des frais à 15 % + 10 € sur un événement publié, sans ré-authentification ni mail aux OWNER ; l'audit n'enregistre que `overrides`. Conforme au contrat d'API, pas au modèle de menaces. Recommandation : réserver les surcharges financières à l'OWNER ou corriger le claim, et notifier les OWNER.

**M2 — Gel de stock via la liste d'attente : « 30 min au plus » ne couvre que l'accumulation**
`waitlist/distribute.ts:58` et `:73`, `config/settingsBounds.ts:19` (`waitlistOfferMinutes` 15–2880). Seule la phase d'accumulation est plafonnée à 30 min ; une offre (`OFFERED`) bloque `held` pendant `waitlistOfferMinutes` (défaut 120 min, jusqu'à 48 h). N comptes vérifiés inscrits tôt reçoivent chacun les places libérées et ne les acceptent jamais ; `reserve()` refuse le public tant qu'une entrée WAITING peut être servie. Recommandation : plafonner la durée d'offre, et écarter un compte qui laisse expirer deux offres.

**M3 — Worker mono-boucle affamé par un PSP muet**
`worker.ts:35-52`, `jobs/expireOrders.ts:35-44`, `PSP_TIMEOUT_MS = 8 s`, `EXPIRE_ORDERS_PER_TICK = 200`. Jobs en série sans budget temps : jusqu'à 200 commandes × sessions × 8 s avant que l'outbox (mails de vérification, de reset, billets) et les remboursements ne passent. `tick()` ne teste pas `stop.signal` entre jobs (SIGTERM attend la fin du passage). Recommandation : budget temps par job, appels PSP en parallèle borné, boucle séparée pour l'outbox.

**M4 — Scanner : relecture du même QR après fermeture du résultat ⇒ écran rouge « DÉJÀ UTILISÉ » pour un porteur légitime**
`frontend/src/scanner/ui/CameraScanner.tsx:34-38`, `ScannerPage.tsx:97-103`. `last.at` est posé à la première lecture ; l'overlay OK se ferme à 2,5 s ; la fenêtre anti-doublon de 3 s est déjà écoulée dès que la latence réseau dépasse 0,5 s. Si le téléphone reste devant la caméra, le serveur répond `ALREADY_USED` et le refus (non fermable sans appui) s'affiche. Recommandation : rafraîchir le délai à la fermeture de l'overlay ou ignorer le même texte tant qu'il n'a pas disparu du champ.

**M5 — `Idempotency-Key` jamais renouvelée après expiration (claim SECURITY.md non tenue)**
`frontend/src/api/hooks/orders.ts:14-38,54-58`. La clé par (compte, panier) n'est oubliée que sur `onSuccess`. Réponse perdue → clé conservée → le même panier plus tard renvoie l'ancienne commande `EXPIRED` et le front y navigue : réservation impossible sans rechargement complet. Recommandation : oublier la clé sur erreur non transitoire ou commande `EXPIRED`/`CANCELLED`, ou TTL.

**M6 — Écrasement silencieux (lost update) des réglages du collectif**
`frontend/src/pages/org/SettingsPage.tsx:49-73`. Le patch compare le formulaire aux réglages *courants* (refetch 15 s) et non à l'état initial du formulaire : un champ modifié par un autre OWNER entre-temps est renvoyé à l'ancienne valeur. `diffPatch` (événements) fait correctement, pas les réglages. Recommandation : comparer à la valeur initiale.

**M7 — Verrouillage de compte par un tiers : indéfiniment répétable**
`backend/src/modules/auth/repo.ts:32-55`, `config/auth.ts:22-26`. SECURITY.md l'assume « pendant au plus 15 min », mais une requête toutes les 15 min suffit à maintenir le verrou sans limite (limiteur login 20/15 min/IP, quota email 30/15 min). Le quota par adresse (30 tentatives) peut aussi être épuisé par un tiers. Recommandation : verrou par couple (compte, IP) ou cookie d'appareil connu, CAPTCHA au-delà d'un seuil, ou reformuler la limite connue (« tant que l'attaquant insiste »).

### Basses

**B1 — Cycles de verrous possibles malgré le claim « aucun cycle »** (déduction). `waitlist/service.ts:95-105` (`leave`) et `:176-183` (`expireWaitlistOffers`) verrouillent leur entrée avant `lockWaitlistEntries` (ordre `createdAt, id`) : inverse d'un `distributeWaitlist` concurrent. `settleHeldOrder` → `issueTickets` prend un `FOR KEY SHARE` sur `events` après `ticket_types`, inverse de `lockEvent` → types. Conséquence : 409 (jamais 500), mais `expireOrders` n'est pas rejoué (B2). Recommandation : `lockWaitlistEntries` avant l'entrée propre ; `withTxRetry` sur `updateEvent` et les types de places.

**B2 — `expireOrders` sans `withTxRetry`, 5 échecs transitoires ⇒ commande écartée à vie** (`jobs/expireOrders.ts:49-57,85-92`). `expireFailures` jamais remis à zéro ; places `held` prisonnières ; aucun endpoint back-office pour libérer ; « alerte » promise = un log `error`. 

**B3 — Remboursements sans commande invisibles de tout organisateur** (`refunds/service.ts:24-28`, `settle.ts:190`, audit `orgId: null`). Un `Refund` `MANUAL_REQUIRED` à `orderId NULL` n'apparaît nulle part ; `/admin` ne liste rien. Claim « jamais d'échec silencieux » trop large.

**B4 — `markDone` et `confirm-transfer` au niveau MANAGER sans preuve ni second regard** (`refunds/service.ts:38-47`, `orgOrders/routes.ts:12`). Un MANAGER déclare un remboursement carte « fait » (note libre) ou émet des billets sur simple saisie d'un montant. Choix de confiance au collectif, à documenter en risque accepté.

**B5 — `processRefunds` : `pending` PSP après 10 essais ⇒ `MANUAL_REQUIRED`** (`jobs/processRefunds.ts:27-34`). Double remboursement possible si un MANAGER traite à la main avant le `refund.succeeded` tardif.

**B6 — Mail de report daté dans l'ancien fuseau** (`events/service.ts:204` vs `:258-260`, `formatWithZone(…, before.timezone)`). Bug vérifié. Correctif : `body.timezone ?? before.timezone`.

**B7 — Report d'un gros événement en une seule transaction de 20 s** (`events/service.ts:230-263`, `TX_TIMEOUT_MS`). Au-delà de quelques milliers de commandes, le report devient impossible. Les annulations sont par lots, pas les reports.

**B8 — Aucune purge des tables à données personnelles** (`email_outbox` : destinataire en clair, `email_tokens.email`, `refresh_tokens`, `webhook_events`, `psp_sessions`, `check_ins`). Seuls `rate_limit_buckets` sont purgés. Rétention RGPD non bornée.

**B9 — Masquage des logs « à toute profondeur » = 4 niveaux et clés exactes** (`lib/logger.ts:6-17`). Non masqués : `buyerEmail`, `contactEmail`, `ownerEmail`, `to`, `displayName`, `bankBeneficiary`, `transferReference`, `idempotencyKey`, `link`. `ResponseContractError.problems` (`validate.ts:121`) journalise les messages Joi bruts (peuvent contenir la valeur fautive).

**B10 — CSV : neutralisation dépendante du séparateur** (`lib/csv.ts:20,36`). `x,=1+1` n'est ni préfixé ni cité ; sur un tableur en séparateur virgule, la seconde cellule devient une formule. Recommandation : citer aussi les cellules contenant `,` et neutraliser après tout séparateur.

**B11 — Export : accumulation d'écouteurs `drain`/`close`** (`reports/attendees.ts:36-39`) et une ligne d'audit par appel sans limitation (spam d'audit possible par un MANAGER).

**B12 — TOCTOU du rôle sur les actions OWNER hors réglages bancaires** (`requireOrgRole.ts:24-29` ; `orgs/service.ts:126-177` ; `events/service.ts:300-316`). Seul `updateSettings` relit le rôle dans la transaction ; un OWNER rétrogradé entre middleware et transaction peut encore agir, y compris se remettre OWNER.

**B13 — Seed : garde `localhost` contournable et mode « synchronisation » contraire à DECISIONS.md** (`prisma/seedGuard.ts`, `seedData.ts:93-135`). Tunnel SSH / `NODE_ENV=staging` passent ; base peuplée ⇒ `syncExisting` réécrit le mot de passe de `admin@nuits-garonne.test` (admin plateforme) et force `emailVerifiedAt`, alors que DECISIONS.md:21 dit « refusé sur base non vide ». Recommandation : `ALLOW_SEED=1` explicite, refus si des utilisateurs hors liste de démo existent.

**B14 — Clé publique Ed25519 du mode secours non épinglée** (`frontend/src/scanner/snapshot.ts:30-72`, `db.ts:18-29`). Clé issue du snapshot, stockée en clair dans IndexedDB : un serveur/proxy compromis ou un opérateur modifiant IndexedDB peut faire accepter des QR forgés hors-ligne. Vérification elle-même correcte. Option : clé fixée au build (`VITE_*`) ou snapshot signé.

**B15 — « Stockage local minimal » omet les `qrPayload` de la file hors-ligne** (`scanner/db.ts:40-50`, `engine.ts:277,306`). La file conserve les QR complets après déconnexion jusqu'à synchro ; un appareil perdu expose des billets encore `VALID` côté serveur.

**B16 — `?payment=success` masque « Payer » après la fin du polling** (`OrderPage.tsx:34-35,144,160`). Après 60 s sans confirmation, ni « Payer » ni « Reprendre » ; seule l'annulation reste. Sans impact sécurité.

**B17 — Divers front** : `dropSession('logout')` n'émet pas le BroadcastChannel (autres onglets gardent le token ≤ 10 min) ; `<EventEditor key={event.updatedAt}>` perd les modifications non enregistrées sans avertissement ; double-clic possible dans `decideAndSend` pendant `refreshEvent()` ; invalidations react-query incomplètes sur les types de places ; promotion OWNER en un clic sans confirmation ; `pageshow` démonte tout l'arbre jusqu'à 15 s ; `TicketsPage` lance un refresh à chaque retour au premier plan.

**B18 — `POST /auth/register` sur un compte vérifié émet un lien de reset** (`auth/service.ts:171-174`) : un tiers peut provoquer l'envoi d'un mail de réinitialisation (plafonné 10/j, 1/2 min) et invalider le lien précédent de la victime. Comportement voulu (« compte existant ») mais surface d'hameçonnage indirecte à garder en tête.

### Info

- `docs/api-contract.md:160` : accumulation « au plus `waitlistOfferMinutes` » vs code `min(…, 30 min)`.
- SECURITY.md « une seule horloge » : `nextAttemptAt @default(now())` (refunds, email_outbox) posé par l'horloge SQL puis comparé à l'horloge applicative ; absent de la liste d'exceptions.
- `lib/audit.ts` annonce « append-only » : rien ne l'impose en base.
- `tickets/service.ts:18-20` : `take: 500` trié par `startsAt asc` : au-delà de 500 billets, les événements les plus lointains disparaissent.
- `waitlist/service.ts:160-165` : offre gratuite, résultat de `settleHeldOrder` ignoré (commande à 0 € peut rester `PENDING_PAYMENT`).
- `orgs/repo.ts:8-11` : `getSettings` fait un `upsert` sur des chemins de lecture (contention possible avec `updateSettings`).
- `reports/stats.ts:26-27` : `SUM(...)::int` déborde au-delà de 21 M€ par type.
- CSP front : pas de `upgrade-insecure-requests`, `report-to`, Trusted Types ; `img-src data:` non justifié par le code lu ; HSTS sans `preload`.
- `backend/package.json` : override `mysql2` dans un projet PostgreSQL, non documenté.
- PSP simulé : page `/checkout/:id/:action` sans CSRF (dev uniquement, lié à 127.0.0.1).
- Dépendances : `npm audit --omit=dev` = 0 vulnérabilité (backend 285 deps, frontend 41) ; `@zxing/browser` 0.2.1 peu maintenu.
- Frontend : `eventId` en majuscules dans l'URL casserait la comparaison avec le QR (minuscule).

## Vérifié sans trouvaille

- **Secrets** : aucun `.env`, `.pem` ni clé dans git ni dans l'historique ; `backend/keys/*.pem` en 0600 ; `.idea/` non tracké ; secrets d'exemple refusés au démarrage (`CHANGE_ME`, doublons par octets décodés, longueurs).
- **Auth** : argon2id borné (sémaphore), hash factice, plancher de temps + gigue, JWT HS256 épinglé avec `kid`/`iss`/`aud`/`exp`/`ver` et relecture en base, refresh opaque haché avec rotation, détection de réutilisation, grâce 10 s, famille 90 j, cookie `HttpOnly/SameSite=Strict/Path=/api/v1/auth`, CSRF (`X-Requested-With` + `Origin` normalisé), login CSRF bloqué par l'exigence `application/json`, jetons mail 256 bits hachés à usage unique liés à l'adresse, anti pré-détournement.
- **Autorisation** : `requireOrgRole` sur 100 % des routes `/orgs/:orgId/*` ; adhésion relue en base ; non-membre 404 ; filtres `orgId` sur toutes les requêtes back-office y compris SQL brut ; `/admin` derrière `requirePlatformAdmin` (404) ; IBAN masqué pour le back-office (`viewer: 'admin'` confirmé), en clair uniquement pour l'acheteur concerné.
- **Entrées/sorties** : Joi strict partout (inconnus refusés, pas de conversion sur le body, NUL et clés `__proto__` refusés dès le parsing), validation des réponses, corps 10 ko / 64 ko / 160 ko (ce dernier seulement après auth + rôle + limiteurs), `Content-Type` exigé, helmet, CORS strict, `no-store`, erreurs sans stack ni SQL.
- **SQL** : ~60 requêtes brutes, toutes en gabarits paramétrés ; aucun `Prisma.raw`/`$queryRawUnsafe` ; lint l'interdit.
- **Argent / stock** : arithmétique BigInt, `reserve` conditionnel + `CHECK (sold + held <= capacity)`, plafond de remboursement sous `FOR UPDATE` + trigger SQL, billets uniques `(orderItemId, seq)` + trigger « billet seulement pour commande payée », annulation des billets par trigger, prix figés sur la commande, early strictement avant `earlyUntil`, idempotence `Idempotency-Key` + hash de requête à temps constant, référence de virement par rejet sans biais modulo.
- **Webhook PSP** : HMAC-SHA256 à temps constant sur les octets bruts, tolérance ±5 min, dédoublonnage `providerEventId` dans la même transaction que l'effet, session rattachée à la commande, montant/devise/méthode vérifiés, tout paiement sans billets enregistré puis remboursé automatiquement, paiement tardif re-vérifié contre toutes les règles de vente, rapprochement par consultation du PSP avant expiration, remboursements hors transaction avec bail et clé d'idempotence.
- **Billets / check-in** : `publicId` 128 bits, QR `NG1.<eventId>.<publicId>.<sig>` Ed25519 en base64url canonique, passage `VALID→USED` atomique, `scanId` idempotent, fenêtre de contrôle, `scannedAt` hors-ligne borné, `deviceId` sans valeur de preuve, snapshot seulement si mode secours activé par un OWNER.
- **Frontend** : aucun `innerHTML`/`dangerouslySetInnerHTML`/`eval` ; `?next=` et redirection PSP strictement bornés ; token d'accès en mémoire seule ; jetons d'URL retirés et oubliés ; aucune réponse d'API dans le service worker ; mocks absents du `dist/` ; CSP sans `unsafe-*` en prod ; nginx avec snippet d'en-têtes inclus dans chaque `location` ; `X-Forwarded-For` écrasé.
- **Mails** : `escapeHtml` sur toute interpolation, liens construits depuis `new URL(FRONT_URL).origin`, pas de CRLF possible (Joi), outbox chiffrée AES-256-GCM avec AAD, payload vidé après envoi.
- **Dépendances** : versions exactes, `npm audit --omit=dev` propre sur les deux applications.

## Priorités recommandées

1. Trancher M1 (OWNER-only ou claim corrigé + notification) et M7 (reformuler ou mitiger le verrouillage).
2. M2 : plafonner la durée d'offre et pénaliser les offres expirées.
3. M3 + B2 + B1 : budget temps du worker, `withTxRetry` sur `expireOrders`, ordre de verrous dans `leave`/`expireWaitlistOffers`.
4. M4, M5, M6 côté front (risque opérationnel réel le soir de l'événement pour M4).
5. B3/B4/B5 : visibilité admin des remboursements orphelins, documenter la confiance accordée aux MANAGER.
6. B6 (une ligne), B8 (purge), B9 (clés de redaction), B10 (CSV virgule), B13 (seed).
7. Mettre `SECURITY.md`/`DECISIONS.md`/`api-contract.md` en cohérence (liste en section Info).

Les points marqués « déduction » (B1, B12) proviennent de la lecture du code et de la sémantique des verrous PostgreSQL, sans reproduction. Comportement des tableurs sur B10 et émission SQL de l'`upsert` non vérifiés.
