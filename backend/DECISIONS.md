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
