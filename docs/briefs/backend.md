# Brief BACKEND — Billetterie « Les Nuits de la Garonne »

Tu es le **développeur backend** du projet. Je suis le **PO** (session agent-deck parente `fullstack-js`). Une autre session (`nuits-front`) fait le frontend en parallèle dans `../frontend/`.

## 0. À lire avant toute chose
1. `../docs/plan.md` — plan global validé (modèle de données, solutions aux problèmes du client, sécurité, paramètres configurables). **Il fait autorité.**
2. `../docs/api-contract.md` — **contrat d'API**. Tu l'implémentes à la lettre : chemins, codes HTTP, codes d'erreur, formes de réponse. Le front le code en parallèle sur la base de ce document.
3. Le brief client (résumé ci-dessous).

## 1. Le client et ses problèmes
Collectif bordelais, ~15 événements/an, 80 à 600 places, au moins 2 types de places par événement (prix + quantités différents), tarif « early » qui s'arrête à une date. Deux collectifs partenaires vendent sur le même outil **sans voir les chiffres des autres**.
Problèmes à éliminer **définitivement** :
- Survente (12 places de trop en balcon : accès concurrents). → **zéro survente quel que soit le nombre de clics simultanés.**
- Réservations jamais payées qui bloquent des places. → expiration automatique (carte 15 min, virement 72 h, configurable).
- Notification du prestataire de paiement reçue 2 fois → 2 billets. → **webhook idempotent.**
- Liste d'attente gérée à la main sur Instagram. → file FIFO avec offre à durée limitée.
- Billets présentés 2 fois (captures d'écran). → QR signé + scan atomique.
- Aucune vision temps réel des ventes / encaissements par type de place.
Extras : annulation self-service jusqu'à un délai, billet par mail, export CSV des participants, fuseaux horaires clairs (participants à l'étranger), utilisable sur mobile avec mauvaise connexion (scan hors-ligne).

**Contexte crucial** : à la fin, une équipe adverse va auditer le code pour trouver **toutes** les mauvaises pratiques, bugs et failles de sécurité. Chaque raccourci sera trouvé. La sécurité et la robustesse priment sur la vitesse.

## 2. Périmètre et stack (imposés)
- Tu travailles **uniquement dans `backend/`** (tu peux lire `../docs/`, jamais modifier `../frontend/` ni `../docs/`).
- Node 24, **TypeScript strict** (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), **Express 5**, **Prisma** + **PostgreSQL 16**, **Joi** pour valider **entrées ET sorties**, `jose` (JWT), `argon2`, `helmet`, `cors`, `express-rate-limit`, `pino`, `nodemailer`, `qrcode`. Tests : **Vitest + Supertest** sur un vrai Postgres.
- Infra fournie à la racine : `../docker-compose.yml` → Postgres dev `127.0.0.1:5432` (nuits / nuits_dev_password / nuits), Postgres test `127.0.0.1:5433` (nuits / nuits_test_password / nuits_test), Mailpit SMTP `1025`, UI `8025`. Lance `docker compose up -d` depuis la racine.
- Ports : API `4000`, mock PSP `4001`.
- Arborescence : celle du plan (`src/config`, `src/middlewares`, `src/modules/<domaine>/{routes,controller,service,repo,schemas}.ts`, `src/lib`, `src/mock-psp`, `src/worker.ts`, `tests/`).
- Scripts npm attendus : `dev`, `dev:worker`, `dev:psp`, `build`, `start`, `test`, `lint`, `typecheck`, `db:migrate`, `db:seed`, `keys:generate` (paire Ed25519 dans `keys/`, gitignoré).
- `.env.example` complet et commenté ; `.env` jamais commité. Env validée par Joi au démarrage (refus de démarrer si un secret manque ou est trop court).

## 3. Règles de sécurité NON NÉGOCIABLES
1. **Joi partout** : middleware `validate({ params, query, body, headers? })` avec `allowUnknown: false`, `abortEarly: false`, `convert` maîtrisé ; **schéma de réponse Joi pour chaque endpoint** (`stripUnknown` sur la sortie pour ne laisser passer que les champs du contrat ; en `NODE_ENV=test` un champ en trop ou manquant fait échouer le test). Aucun objet Prisma renvoyé brut.
2. **Jamais** `req.body` passé tel quel à Prisma : mapping explicite champ par champ.
3. **Prix / early / frais / total calculés serveur** au moment de la réservation, figés dans `OrderItem` / `Order`.
4. **Concurrence** : réservation par `UPDATE … SET held = held + q WHERE … AND sold + held + q <= capacity RETURNING` dans une transaction, types triés par id ; **contrainte CHECK** en base (migration SQL). Toutes les transitions d'état de commande / billet / liste d'attente sont des **UPDATE gardés par le statut attendu** (`WHERE status = 'X'`) et vérifient le nombre de lignes modifiées.
5. **Webhook** : body brut, HMAC-SHA256 vérifié avec `crypto.timingSafeEqual`, tolérance 5 min, `WebhookEvent.providerEventId` UNIQUE inséré **dans la même transaction** que l'effet, vérif montant + devise + commande, idempotent (doublon ⇒ 200 sans effet). Paiement arrivé après expiration ⇒ re-réservation si possible, sinon remboursement automatique + mail.
6. **Multi-collectifs** : middleware `requireOrgRole(minRole)` qui lit l'adhésion **en base** à chaque requête ; tous les repos back-office prennent `orgId` et le mettent dans chaque `where` ; ressource d'un autre collectif ⇒ **404**. Ressource d'un autre acheteur ⇒ 404.
7. **Auth** selon le contrat §2 : access JWT HS256 10 min (algo épinglé, `iss`, `aud`, `exp` vérifiés, payload `sub` + `jti` uniquement), refresh opaque 256 bits **hashé** (SHA-256) en base, rotation + détection de réutilisation (révocation de famille), cookie `HttpOnly; SameSite=Strict; Path=/api/v1/auth`, anti-CSRF (`Origin` allowlist + `X-Requested-With: nuits-web`). argon2id, mot de passe 12–128 caractères, hash factice si email inconnu, réponses identiques à l'inscription / mot de passe oublié (anti-énumération), tokens email & reset aléatoires hashés, usage unique, 30 min, verrouillage progressif après échecs + rate limiting.
8. **Billets** : `publicId` 128 bits aléatoires (`crypto.randomBytes`), QR `NG1.<publicId>.<sig Ed25519>`, scan = `UPDATE ticket SET status='USED' … WHERE publicId=$1 AND status='VALID'` + contrôle que l'événement appartient au collectif du scanneur et correspond à `:eventId`.
9. **CSV** : neutraliser `= + - @ \t \r` en tête de cellule, échapper `;` `"` et retours ligne, streaming.
10. Express : `helmet` (CSP `default-src 'none'` pour l'API), CORS allowlist `FRONT_URL` + credentials, `express.json({ limit: '10kb' })` (raw uniquement sur la route webhook), `app.disable('x-powered-by')`, `trust proxy` configuré via env, handler d'erreur centralisé (aucune stack / message Prisma / SQL exposé ; `Prisma P2002` ⇒ 409 propre), 404 JSON, `pino` avec `redact` (authorization, cookie, set-cookie, password, token, iban), requestId.
11. Interdits : `$queryRawUnsafe`, `$executeRawUnsafe`, `eval`, `new Function`, `Math.random` pour quoi que ce soit de sensible, secrets en dur, `console.log`, `any` non justifié, `@ts-ignore`, dépendances non maintenues. `npm audit --omit=dev` sans vulnérabilité haute/critique.
12. Mails via **outbox transactionnelle** (insérée dans la même transaction que l'événement métier, envoyée par le worker avec retry exponentiel). Templates HTML avec échappement systématique des données utilisateur.
13. **Paramètres configurables** (section du plan) : `OrganizationSettings` + surcharges nullable sur `Event`, résolution unique dans `src/modules/settings/resolveEventSettings.ts`, valeurs figées sur la commande, IBAN validé mod 97 et **jamais renvoyé en clair** sauf `transferInstructions` à l'acheteur concerné ; toute modification tracée dans `AuditLog` (IBAN masqué).
14. Mock PSP : app Express séparée (`src/mock-psp/server.ts`), refuse de démarrer si `NODE_ENV=production`, clé API et secret webhook via env.
15. Seed (`prisma/seed.ts`) : 1 admin plateforme, 3 collectifs (« Les Nuits de la Garonne », 2 partenaires), 1 OWNER / 1 MANAGER / 1 SCANNER par collectif, 1 acheteur vérifié, quelques événements (dont un en ligne avec fuseau `America/New_York`, un avec early, un presque complet). Mots de passe de seed lus depuis l'env ou générés et affichés une fois en console — jamais en dur dans le code commité.

## 4. Jalons (dans l'ordre — un jalon n'est terminé que si `npm run lint && npm run typecheck && npm test` passent)
| # | Contenu | Critères d'acceptation (tests obligatoires) |
|---|---|---|
| B1 | Socle : package.json, tsconfig, ESLint (+ `eslint-plugin-security`), env Joi, app sécurisée, logger, erreurs, middleware `validate` in/out, `/health`, schéma Prisma **complet** + migration avec CHECK + index uniques partiels, seed, setup tests (DB test migrée/vidée entre tests) | démarrage refusé si env invalide ; 404 JSON ; champ inconnu ⇒ 400 ; aucune stack en 500 ; en-têtes helmet présents |
| B2 | Auth complète (§2 du contrat) | anti-énumération register/forgot ; login KO générique ; verrouillage ; refresh rotation ; **réutilisation ⇒ famille révoquée** ; CSRF refusé sans en-tête / mauvaise Origin ; JWT `alg:none` / autre algo / mauvaise `aud` refusés ; `passwordHash` jamais dans une réponse |
| B3 | Collectifs, membres, réglages, admin plateforme, événements, types de places, catalogue public | **IDOR** : un MANAGER du collectif A ne lit/modifie rien du collectif B (404) ; MANAGER ne peut pas modifier les réglages collectif ; héritage réglages collectif → événement ; bornes Joi ; IBAN invalide refusé ; IBAN jamais en clair ; catalogue public sans chiffres exacts ; dernier OWNER non supprimable |
| B4 | Réservation (`POST /orders`, idempotence), calcul prix/early/frais, plafonds, expiration par le worker (advisory lock, `SKIP LOCKED`) | **300 requêtes concurrentes sur 10 places ⇒ exactement 10 places vendues/held, 0 survente** ; bornes early (1 ms avant/après) ; plafond par personne cumulé sur commandes actives ; expiration libère `held` ; Idempotency-Key rejouée ⇒ même commande, body différent ⇒ 409 |
| B5 | Mock PSP, checkout, webhook, virement manuel, émission billets, outbox mail + worker d'envoi | **webhook envoyé 2 fois (séquentiel et concurrent) ⇒ 1 seul jeu de billets** ; signature invalide / horodatage périmé / montant faux ⇒ rejet sans effet ; paiement après expiration (stock dispo / stock épuisé ⇒ remboursement) ; confirm-transfer montant faux ⇒ 422 ; mail présent dans Mailpit (test d'intégration optionnel) |
| B6 | Billets (`/me/tickets`, QR signé), check-in scan + snapshot + sync | **2 scans concurrents du même billet ⇒ 1 OK, 1 ALREADY_USED** ; QR falsifié ⇒ INVALID ; billet d'un autre événement ⇒ WRONG_EVENT ; SCANNER d'un autre collectif ⇒ 404 ; sync : conflits résolus, premier scan gagne |
| B7 | Liste d'attente, annulation self-service, annulation d'événement, stats, export CSV, audit log | ordre FIFO ; offre expirée ⇒ suivant ; places libérées vont à la file avant le public ; annulation après délai / après scan ⇒ 409 ; remboursement au bon % ; stats exactes après ventes/remboursements ; **injection CSV neutralisée** ; export d'un autre collectif ⇒ 404 |
| B8 | `README` backend (installation, scripts, comptes de seed, architecture), section backend de `../SECURITY.md` → **propose-moi le contenu via `NEED:`**, je l'écris (fichier racine) | revue PO |

## 5. Protocole de travail avec moi (PO)
- **Avant de coder B1**, envoie-moi en une réponse courte : ta compréhension, ton découpage du schéma Prisma, les points du contrat qui te semblent ambigus. Puis enchaîne sans attendre sauf si tu poses une question bloquante.
- Question bloquante, ambiguïté métier, **demande de changement du contrat** ⇒ une ligne commençant par `NEED:` puis attends ma réponse. Ne diverge **jamais** du contrat sans mon accord.
- Décision non bloquante ⇒ prends l'option la plus sûre, note-la dans `backend/DECISIONS.md` (date, décision, raison) et continue.
- **Fin de chaque jalon** : commit(s), puis un message récapitulatif : `JALON Bx TERMINÉ` + endpoints livrés + résultat de `npm test` (nombre de tests) + écarts éventuels. J'audite puis je te donne le feu vert ou des corrections. Tu peux commencer le jalon suivant pendant mon audit.
- Quand **tout** est livré, termine par la ligne sentinelle de fin.

## 6. Git
- Repo à la racine (`../`), déjà initialisé. Ne commite **que** des fichiers de `backend/`.
- Messages de commit **en français**, orientés métier (ex. « Empêche la survente lors de réservations simultanées »). Petits commits cohérents.
- **Jamais** `git commit --amend`, `git push --force`, réécriture d'historique, ni `git add -A` à la racine.
- Aucun secret commité.

Commence maintenant par la lecture des documents puis ton retour de compréhension.
