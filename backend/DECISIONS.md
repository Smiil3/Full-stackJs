# Décisions backend

Décisions non bloquantes prises pendant l'implémentation (option la plus sûre retenue). Format : date — décision — raison.

## B1 — Socle

- **2026-10-06 — Prisma 7.10 (stable) et TypeScript 6.0.** — `prisma@latest` pointe sur une 8.0 *release candidate* ; `typescript-eslint` ne supporte pas encore TS 7. On reste sur des versions stables et épinglées (`--save-exact`).
- **2026-10-06 — Overrides npm `deepmerge-ts@8.0.2` et `mysql2@3.24.5`.** — Vulnérabilités hautes remontées par `npm audit --omit=dev` via la CLI Prisma (le pilote MySQL n'est jamais utilisé). Les overrides suppriment les alertes sans changer de version de Prisma.
- **2026-10-06 — `GET /health` servi à la racine (`/health`), hors `/api/v1`.** — Le contrat §10 l'écrit sans préfixe ; c'est aussi l'usage des sondes d'infrastructure.
- **2026-10-06 — Body JSON validé sans conversion de type ; params/query avec conversion.** — « convert maîtrisé » : un `"5"` n'est pas accepté comme nombre dans un body JSON, alors que les paramètres d'URL sont par nature des chaînes. Les dates d'entrée exigent un fuseau explicite (`Z` ou `±hh:mm`).
- **2026-10-06 — Sortie validée en mode strict hors production.** — En dev/test, un champ non déclaré ou manquant fait échouer la requête (500 + log) : un champ sensible ne peut pas fuiter silencieusement. En production : champs non déclarés retirés (`stripUnknown`), champ manquant ⇒ 500 journalisée.
- **2026-10-06 — Corps trop volumineux ⇒ 413 avec code `VALIDATION_ERROR`.** — Le contrat ne liste pas de code dédié ; on garde un code existant et le statut HTTP standard.
- **2026-10-06 — IBAN chiffré au repos (AES-256-GCM, `DATA_ENCRYPTION_KEY`) + forme masquée pré-calculée.** — Une fuite de la base ne révèle pas les coordonnées bancaires ; la forme masquée évite de déchiffrer pour l'affichage back-office.
- **2026-10-06 — Coordonnées de virement figées sur la commande.** — Un changement d'IBAN du collectif ne doit pas modifier les instructions déjà données à un acheteur (cohérent avec « valeurs figées sur la commande »).
- **2026-10-06 — `Ticket.eventId` dénormalisé.** — Le scan atomique `UPDATE … WHERE publicId = $1 AND eventId = $2 AND status = 'VALID'` et le snapshot n'ont pas besoin de jointure ; l'appartenance à l'événement fait partie de la condition atomique.
- **2026-10-06 — Table `Refund` (remboursement asynchrone).** — Les remboursements sont enregistrés dans la transaction métier puis exécutés auprès du PSP par le worker (avec clé d'idempotence = id du remboursement) : aucun appel réseau externe pendant une transaction, pas de remboursement perdu en cas de crash.
- **2026-10-06 — Table `EmailToken` unique pour vérification d'email et reset.** — Même cycle de vie (hash SHA-256, usage unique, 30 min) ; le champ `purpose` empêche d'utiliser un jeton de vérification pour un reset.
- **2026-10-06 — `User.tokenVersion` (claim `ver`), remplace `tokensValidAfter`.** — Le middleware d'auth relit l'utilisateur en base et exige `ver === tokenVersion` : un changement / reset de mot de passe incrémente la version et invalide immédiatement tous les access tokens en cours, sans la fenêtre d'une seconde qu'imposait la comparaison sur `iat` (décision PO).
- **2026-10-06 — Contraintes CHECK étendues.** — En plus du stock (`sold + held <= capacity`) : montants positifs, `total = sous-total + frais`, cohérence early, dates d'événement, bornes des réglages (collectif et surcharges), `USED ⇔ usedAt`. Filet de sécurité si un bug applicatif passait la validation Joi.
- **2026-10-06 — Nettoyage de la base de test par une liste de tables statique.** — `TRUNCATE` ne prend pas de paramètres liés ; plutôt que `$executeRawUnsafe` (interdit), liste littérale + test qui vérifie qu'elle couvre toutes les tables du schéma.
- **2026-10-06 — Seed refusé en production et sur base non vide ; mot de passe commun aléatoire affiché une fois si `SEED_PASSWORD` est vide.**
- **2026-10-06 — Frais de service nuls sur une commande à 0 €.** — Éviter de facturer des frais sur une entrée gratuite (une commande gratuite n'a pas de paiement PSP).

## B2 — Authentification

- **2026-10-06 — Rotation du refresh avec délai de grâce de 10 s (B2.1 M1, remplace la règle stricte initiale).** — Un rejeu de l'ancien jeton dans les 10 s, si son successeur n'a jamais servi, révoque ce successeur et émet une nouvelle paire (même famille) ; au-delà, ou si la chaîne a continué ⇒ famille révoquée. Un jeton supplanté pendant la grâce renvoie 401 sans révoquer la famille (sinon le client « perdant » d'une course tuerait la chaîne survivante). Cookie effacé uniquement sur 401.
- **2026-10-06 — Ordre de verrouillage utilisateur → jetons dans tout le module auth.** — Refresh, login, reset et changement de mot de passe se sérialisent sur la ligne `users` (FOR UPDATE) : pas d'interblocage, et une session ne peut pas survivre à un reset concurrent (version de famille ≠ `tokenVersion`).
- **2026-10-06 — Famille de refresh : 90 jours absolus ; expiration de chaque jeton = min(30 j glissants, fin de famille).**
- **2026-10-06 — Compte verrouillé ⇒ 401 `INVALID_CREDENTIALS`.** — Ne révèle pas l'existence du compte (validé PO, contrat 1.2). Verrouillage (B2.1 M4) : tentative réservée atomiquement AVANT l'évaluation du mot de passe, seuil 5, verrou 1 min puis doublé, plafonné à 15 min (limite le déni de service sur le compte d'autrui), compteur remis à zéro après 15 min sans échec. Même compteur pour `change-password`.
- **2026-10-06 — Le verrou de compte ne coupe pas les sessions existantes (B2.1 B4).** — Il protège la connexion par mot de passe, pas les sessions légitimes déjà ouvertes : `requireAuth` ne le consulte pas. Sinon un attaquant pourrait déconnecter n'importe qui en ratant volontairement 5 connexions.
- **2026-10-06 — Logout simple : l'access token survit au plus 10 min (B2.1 B4).** — Le logout révoque la famille de refresh mais n'incrémente pas `tokenVersion` (ce qui déconnecterait tous les appareils). Le front oublie le token en mémoire ; limite documentée dans SECURITY.md.
- **2026-10-06 — Inscription sur un compte non vérifié : la dernière inscription gagne (B2.1 H1).** — Anti pré-détournement : mot de passe et nom remplacés, anciens liens invalidés, sessions révoquées. Le plafond d'envoi (1 mail / 2 min) peut retarder le nouveau lien : l'utilisateur utilise « renvoyer » après 2 min ; les anciens liens sont invalidés dans tous les cas.
- **2026-10-06 — Plafond d'envoi par adresse (B2.1 M6).** — 1 mail d'authentification / 2 min et 10 / 24 h par compte, silencieux ; un lien frais n'est jamais invalidé par une nouvelle demande trop proche. En plus : quota HTTP 429 par adresse (5 / h par action, 30 logins / 15 min), appliqué que le compte existe ou non.
- **2026-10-06 — Rate limiting en PostgreSQL (B2.1 M8).** — Store maison pour express-rate-limit (UPSERT atomique, clés hachées SHA-256 : ni IP ni email en clair), partagé entre instances et conservé au redémarrage ; purge des compteurs expirés par le worker.
- **2026-10-06 — Temps de réponse plancher 400 ms + gigue (B2.1 M5).** — register / forgot / resend ; configurable (≥ 300 ms hors test, 0 autorisé seulement en test pour garder une suite rapide ; un test dédié vérifie le vrai plancher).
- **2026-10-06 — argon2id m=19456, t=2, p=1 + sémaphore 4 calculs / 64 en file (B2.1 M9).** — Les anciens hashs (autres paramètres) restent vérifiables (paramètres encodés dans le hash).
- **2026-10-06 — Liste de mots de passe courants (B2.1 B2).** — 10 000 mots de passe de 12–128 caractères les plus fréquents (SecLists xato 1M, licence MIT), embarqués en module TS (pas d'appel externe, rien à copier au build) ; les plus courts sont déjà refusés par la règle de longueur.
- **2026-10-06 — Outbox chiffrée (B2.1 M7).** — Payload AES-256-GCM (AAD `outbox:<id>`), purgé à l'état SENT / FAILED ; `lastError` ne contient que le nom de l'erreur (jamais le message SMTP, qui peut citer l'adresse).
- **2026-10-06 — Inscription avec un email déjà vérifié ⇒ mail « vous avez déjà un compte » avec lien de reset ; email non vérifié ⇒ nouveau lien de vérification.** — Réponse HTTP identique dans tous les cas.
- **2026-10-06 — Le reset de mot de passe vaut vérification d'email.** — Le lien reçu prouve la possession de l'adresse.
- **2026-10-06 — Jetons mail stockés hashés, liés à l'adresse d'envoi (B2.1 B5), émis sous verrou de la ligne utilisateur.**

## B3 — Collectifs, réglages, événements, catalogue

- **2026-10-06 — Contrôle d'adhésion avant validation des paramètres.** — `requireOrgRole` valide lui-même `orgId` (UUID strict, sinon 404) puis lit l'adhésion en base ; il est, avec `validate`, le seul autorisé à lire `req.params` (règle ESLint).
- **2026-10-06 — Ressource d'un autre collectif adressée via son propre préfixe ⇒ 404.** — Tous les repos back-office filtrent par `orgId` (événement, type de place via `event.orgId`).
- **2026-10-06 — Rétrogradation / retrait du dernier OWNER : verrou `FOR UPDATE` sur les OWNER du collectif.** — Deux OWNER qui se rétrogradent mutuellement en même temps : il en reste toujours un.
- **2026-10-06 — Résolution des réglages : `maxPerOrder` effectif borné par `maxPerUser` effectif.** — Un mélange d'héritages (collectif modifié après coup) ne peut pas produire un plafond par commande supérieur au plafond par personne ; les incohérences explicites sont refusées (400).
- **2026-10-06 — `rules.transferEnabled` public = virement activé ET coordonnées bancaires complètes.** — Le public ne voit pas une option qui échouerait (`PAYMENT_METHOD_UNAVAILABLE`).
- **2026-10-06 — Catalogue : événements PUBLIÉS dont la fin est dans le futur (en cours inclus) ; `earlyUntil` public renvoyé seulement si le tarif early est actif.**
- **2026-10-06 — Disponibilité publique : SOLD_OUT dès qu'une personne attend en liste d'attente sur ce type.** — Les places libérées leur reviennent avant le public (décision PO 4).
- **2026-10-06 — Suppression d'un type de place refusée s'il a des ventes, des places bloquées ou une liste d'attente, et pour le dernier type d'un événement publié.**
- **2026-10-06 — Réduction de capacité par UPDATE conditionnel `sold + held <= capacity`.** — Atomique face à une réservation concurrente (pas de lecture puis écriture).
- **2026-10-06 — Création d'événement : fin dans le futur obligatoire ; dates d'entrée avec fuseau explicite ; fuseau IANA vérifié par `Intl.supportedValuesOf`.**

## B3.1 — Revue multi-collectifs

- **2026-10-06 — Report d'événement (contrat 1.7).** — Détecté quand `startsAt` ou `endsAt` change alors qu'il existe des commandes PENDING_PAYMENT / AWAITING_TRANSFER / PAID : OWNER seulement (403 pour un MANAGER, contrôle avant le motif), `rescheduleReason` obligatoire. Commandes PAID : `refundPercent = 100`, `serviceFeeRefundable = true` (frais compris), `cancellableUntil = max(ancienne limite, nouveau début − délai figé)` où le délai figé = ancien début − ancienne limite ; si l'annulation était désactivée (limite null), on accorde le délai effectif actuel de l'événement (le droit au remboursement doit être exerçable). Mail à chaque acheteur actif, AuditLog `event.reschedule`.
- **2026-10-06 — `earlyUntil ≤ salesEndAt`** à la création / modification d'un type (400) et revalidé quand les dates de l'événement changent (409 CONFLICT avec la liste des types concernés : l'organisateur corrige d'abord ses tarifs).
- **2026-10-06 — Suppression de type : `FOR UPDATE` sur la ligne `ticket_types` avant les comptages ; P2003 ⇒ 409.**
- **2026-10-06 — Tout SQL brut sur `ticket_types` porte la clé parente `eventId`** (défense en profondeur).
- **2026-10-06 — Changement bancaire : `currentPassword` obligatoire (et interdit sans `bank`), vérifié avec le compteur / verrou du login ; mail à tous les OWNER.** Les coordonnées restent figées sur les commandes AWAITING_TRANSFER existantes (testé).
- **2026-10-06 — Ajout de membre : mail d'information à la personne ajoutée. L'oracle d'énumération (404 si le compte n'existe pas / n'est pas vérifié) est accepté pour un OWNER** : il ne révèle que l'existence d'un compte vérifié, à un utilisateur authentifié et propriétaire d'un collectif, et la personne est prévenue par mail de tout ajout.
- **2026-10-06 — `page` ≤ 1000 partout ; `from ≤ to` au catalogue ; le catalogue ne charge que les réglages nécessaires (jamais l'IBAN chiffré) ; détail public 404 pour un événement terminé depuis plus de 30 jours.**
- **2026-10-06 — SCANNER : plus d'accès à `GET /orgs/:orgId/events*` (chiffres de vente) ; `GET /orgs/:orgId/checkin/events` sans aucun chiffre (événements publiés terminés depuis moins de 24 h).**
- **2026-10-06 — Textes : espaces de début / fin retirés avant les règles de longueur (un texte vide après trim est refusé) ; jamais pour les mots de passe.**
- **2026-10-06 — Audit : `actorEmail = "Administrateur plateforme"` pour un admin non membre du collectif (son email n'est pas divulgué), `null` pour une action système.**
- **2026-10-06 — `GET /admin/orgs` paginé (contrat 1.8), tri nom puis id.**

## B4 / B4.1 — Réservation et expiration

- **2026-10-06 — Ordre de verrouillage unique (B4.1 H2).** — verrou consultatif (acheteur, événement) → `events` → `orders` → `ticket_types` (triés par id). La réservation prend l'événement en `FOR SHARE` (les réservations ne se bloquent pas entre elles mais attendent une annulation / un report en `FOR UPDATE`) et ne verrouille jamais une commande existante ; l'expiration, le webhook, la validation de virement et l'annulation verrouillent la commande avant ses types. Le PO avait proposé `ticket_types → orders` : l'ordre retenu (orders avant ticket_types) est celui de tous les chemins qui manipulent une commande existante, et la création ne prend aucun verrou de commande — aucun cycle possible.
- **2026-10-06 — Expiration : une transaction par commande, `FOR UPDATE SKIP LOCKED LIMIT 1`, échéance comparée à `now()` SQL (B4.1 H1 / M5).** — Une commande en erreur est comptée (`expireFailures`), journalisée et sautée ; au-delà de 5 échecs elle est écartée (alerte, intervention manuelle) sans bloquer les suivantes. Plus de verrou consultatif global : `SKIP LOCKED` suffit à répartir le travail entre workers.
- **2026-10-06 — Nouvel essai borné des transactions de réservation (B4.1 M1).** — 3 essais avec gigue sur 40P01 / 40001 / P2034 (et collision de référence de virement), puis 409 CONFLICT ; l'errorHandler mappe aussi ces erreurs transitoires sur 409, jamais 500.
- **2026-10-06 — UPDATE de réservation exécuté le plus tard possible, lecture de la réponse hors transaction (B4.1 M2).** — Mesure du test « 300 requêtes » : ~0,93 s avant, ~0,90 s après (variance ±0,4 s) : gain non mesurable à cette échelle, le test étant dominé par la création des comptes et le HTTP ; le bénéfice est la durée de détention des verrous de ligne sous forte contention.
- **2026-10-06 — `createdAt` d'une commande = instant de tarification (horloge applicative).** — Le prix early appliqué est vérifiable a posteriori.
- **2026-10-06 — Commande gratuite : confirmée quel que soit le moyen de paiement demandé, sans contrôle bancaire ni instructions de virement (B4.1 B1).**
- **2026-10-06 — Limites de réservation : 60 / min par IP (CGNAT mobile) et 10 / min par compte (B4.1 M4).**
- **2026-10-06 — Liste d'attente : à implémenter en B7 (B4.1 M3).** — (a) `distributeWaitlist` / `expireWaitlistOffers` branchés dans le worker ET déclenchés à chaque libération de places (expiration, annulation, remboursement, hausse de capacité) ; (b) garde publique corrigée : la vente publique n'est bloquée que s'il existe une entrée WAITING dont `quantity ≤ places libres` (une entrée trop grosse ne bloque ni les suivantes ni le public). D'ici là, la garde actuelle (« aucun WAITING ») est plus restrictive que nécessaire mais ne permet aucune survente.
- **2026-10-06 — Idempotency-Key réutilisée sur une commande EXPIRED ⇒ renvoie la commande EXPIRED (contrat §4) ; une nouvelle tentative utilise une nouvelle clé.**

## B6 — Billets et contrôle d'accès

- **2026-10-06 — QR `NG1.<eventId>.<publicId>.<signature>` calculé à la volée (jamais stocké) ; publicId = 16 octets aléatoires base64url (22 car.) ; signature Ed25519 sur `NG1.<eventId>.<publicId>` (contrat 1.1).** — Vérification stricte : 4 parties, préfixe, formats (UUID minuscule, 22 et 86 caractères base64url), puis signature.
- **2026-10-06 — Scan : `scanId` réservé en premier (`INSERT … ON CONFLICT DO NOTHING`), puis passage atomique `VALID → USED` gardé par le statut et l'événement.** — Un scanId rejoué (y compris en parallèle) renvoie le résultat d'origine sans effet ; s'il est rejoué sur un autre événement : INVALID sans effet. Un QR d'un autre événement (même ou autre collectif) ⇒ WRONG_EVENT (l'eventId est déjà visible dans le QR signé : aucune information divulguée).
- **2026-10-06 — Synchronisation : chaque scan dans sa propre transaction, traités dans l'ordre `scannedAt` puis d'arrivée ; `scannedAt` borné à [début des ventes, maintenant + 5 min] (décision PO 6), avec `clientScannedAt` (valeur brute) et `scannedAtClamped` journalisés dans `CheckIn` ; `usedAt` d'un billet accepté hors-ligne = scannedAt borné.**
- **2026-10-06 — Limite de corps de 160 ko réservée à la route de synchronisation, lue APRÈS authentification, contrôle de rôle et limiteurs (B6.1 M3, contrat 1.12)** ; le parseur global (10 ko) ignore cette route ; toutes les autres routes restent à 10 ko.
- **2026-10-06 — Snapshot et réponses de scan : initiales du porteur uniquement (« J.P.D. »), jamais de nom complet ni d'email.**
- **2026-10-06 — Mail de confirmation : un QR PNG par billet VALIDE, généré à l'envoi (jamais stocké dans l'outbox).**

## B5 / B5.1 — Paiements

- **2026-10-06 — Un paiement authentifié n'est jamais perdu (contrat 1.10 §9).** — Après signature valide, 200 dans tous les cas métier. Toute somme encaissée sans billets (commande inconnue, montant / devise / session incohérents, commande non CARD, stock bloqué incohérent, paiement tardif sans places, doublon) est enregistrée (`Payment`), remboursée automatiquement (`Refund`), journalisée en `error` et tracée dans l'AuditLog.
- **2026-10-06 — Commande inconnue : `Payment.orderId` et `Refund.orderId` nullables** (plutôt qu'une table d'anomalies) : le remboursement suit le même circuit (worker, PSP) ; ces remboursements n'apparaissent dans aucun back-office de collectif (aucun collectif identifiable), seulement dans les logs et l'AuditLog plateforme (orgId null).
- **2026-10-06 — Devise des paiements : format ISO libre (`^[A-Z]{3}$`) au lieu de EUR strict** — un paiement dans une autre devise doit pouvoir être enregistré pour être remboursé ; seule une commande en EUR peut être réglée.
- **2026-10-06 — Session : pour une commande CARD en attente, `data.sessionId` doit égaler la session ouverte ; sinon remboursement UNEXPECTED_PAYMENT.** — Après `payment.failed`, la session est oubliée et `checkoutAttempt` incrémenté : la clé d'idempotence PSP du checkout est `orderId:tentative`, la tentative suivante ouvre une nouvelle session.
- **2026-10-06 — `payment.failed` puis `payment.succeeded` du même paymentId : le Payment FAILED passe SUCCEEDED et l'événement est traité normalement ; seul un Payment déjà SUCCEEDED est ignoré.**
- **2026-10-06 — Enveloppe signée inexploitable (JSON valide sans identifiant…) : 200 + log error** — impossible de dédoublonner ou de traiter ; un 4xx ferait réessayer le PSP indéfiniment.
- **2026-10-06 — `refund.succeeded` apparié par `data.refundId` (identifiant PSP), jamais par montant** ; un succès tardif régularise aussi MANUAL_REQUIRED / FAILED. Le mock PSP ajoute `refundId` aux données du webhook (champ additionnel toléré par le contrat 1.10).
- **2026-10-06 — Remboursements : tentative comptée et bail posé AVANT l'appel PSP ; refus définitif du PSP (4xx hors 408/409/425/429) ou essais épuisés ⇒ MANUAL_REQUIRED (jamais FAILED silencieux) ; plafond vérifié sous `FOR UPDATE` du paiement avant insertion (montant plafonné au reste remboursable, le déclencheur SQL reste le filet ultime).**
- **2026-10-06 — Validation de virement : l'échéance fait foi (expiresAt dépassé ⇒ ORDER_EXPIRED même si le worker n'est pas passé) ; événement non publié ⇒ SALES_CLOSED.**
- **2026-10-06 — Recherche par email : jokers LIKE (`%`, `_`, `\`) échappés.**

## B6.1 — Revue du contrôle d'accès

- **2026-10-06 — Billets d'une commande close : annulés dans la même transaction que l'annulation / le remboursement, ET par un déclencheur SQL (filet) quand une commande passe CANCELLED / REFUNDED / EXPIRED** ; les billets USED restent USED (sauf annulation d'événement, qui annule tout et rembourse intégralement). Un remboursement de paiement en double / inattendu sur une commande PAID ne touche ni la commande ni ses billets.
- **2026-10-06 — Fenêtre de contrôle : événement du collectif, PUBLISHED, terminé depuis moins de 24 h ; CANCELLED ⇒ scan / sync répondent CANCELLED (snapshot 404) ; brouillon ou trop ancien ⇒ 404.**
- **2026-10-06 — Limites du contrôle : 2 400 / min par IP (wifi de salle partagé), 240 / min par contrôleur ; synchronisation : quota de 2 000 scans / min par contrôleur, coût = taille du lot.**
- **2026-10-06 — QR de format invalide : rejet sans ligne CheckIn (compteur agrégé + log tous les 100) ; signature invalide d'un format correct : journalisée (tentative de fraude).**
- **2026-10-06 — Clé publique de signature dérivée de la clé privée (le fichier public, s'il existe, doit correspondre) ; paire chargée au démarrage de l'API et du worker (fail-fast) ; en production, clé privée refusée si lisible par le groupe ou les autres (secret à monter en 0400 / 0600).**
- **2026-10-06 — base64url canonique exigé pour publicId et signature** (pas d'encodages équivalents d'un même QR).
- **2026-10-06 — « Premier gagne » : par `scannedAt` au sein d'un lot ; par ordre d'arrivée serveur entre lots et face au scan en ligne.**
- **2026-10-06 — `deviceId` n'a aucune valeur de preuve** (fourni par l'appareil) : le `scannerId` issu du jeton authentifié fait foi.

## B7 — Liste d'attente, annulations, chiffres, export

- **2026-10-06 — Distribution FIFO (createdAt, id) avec saut des demandes trop grosses ; une offre bloque ses places (`held`) pendant `waitlistOfferMinutes`, au plus jusqu'au début de l'événement ; déclenchée dans la transaction de chaque libération (expiration, annulation self-service, refus / expiration d'offre, hausse de capacité) + balayage périodique du worker.** L'annulation d'un événement ferme la liste (WAITING / OFFERED ⇒ EXPIRED) sans distribution.
- **2026-10-06 — Garde publique : vente bloquée seulement s'il existe une demande WAITING qui tient dans les places libres (réservation, reprise d'un paiement tardif, disponibilité du catalogue).**
- **2026-10-06 — Inscription : refusée (NOT_SOLD_OUT) si le public peut acheter la quantité demandée ; plafond par personne = commandes actives + offres + demandes en attente.**
- **2026-10-06 — Acceptation d'une offre : commande CARD PENDING_PAYMENT sur les places déjà bloquées, prix calculés à l'acceptation ; idempotente (une seconde acceptation renvoie la même commande) ; offre gratuite confirmée immédiatement.**
- **2026-10-06 — Annulation self-service : même règle (`canSelfCancelPaid`) et même fonction de calcul (`selfCancellationRefund`) que `refundPreviewCents` ; part hors frais répartie sur les lignes (plus fort reste) pour les statistiques par type.**
- **2026-10-06 — Statistiques : revenu net par type = lignes des commandes payées (PAID / REFUNDED ayant été payées) − parts remboursées ; frais de service à part (encaissés − remboursés) ; `refundsToProcess` = MANUAL_REQUIRED + FAILED.**
- **2026-10-06 — Export CSV : streaming par pages de 500 avec contre-pression, BOM UTF-8, `;`, neutralisation des formules (préfixe `'`), guillemets pour `;` `"` et sauts de ligne, heure de scan dans le fuseau de l'événement, export tracé dans l'AuditLog.**
