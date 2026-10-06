# Sécurité — Billetterie « Les Nuits de la Garonne »

Ce document décrit le modèle de menaces, les protections en place et les **limites connues assumées**. Il est tenu à jour avec le code ; toute décision de sécurité y figure avec sa justification (détails d'implémentation : `backend/DECISIONS.md`, `frontend/DECISIONS.md`, contrat : `docs/api-contract.md`).

## Signaler une vulnérabilité

Ne pas ouvrir de ticket public. Écrire aux mainteneurs du dépôt en décrivant le scénario, l'impact et une preuve de concept minimale. Réponse sous 72 h ouvrées.

## Vue d'ensemble

- `backend/` : API Express 5 + TypeScript strict, PostgreSQL 16 via Prisma, validation Joi des entrées **et** des sorties, worker séparé (expirations, remboursements, mails, liste d'attente).
- `frontend/` : React 19 + TypeScript strict, PWA mobile-first, scanner d'entrée.
- Prestataire de paiement **simulé** (développement uniquement).

## Backend

### Périmètre et actifs protégés
- Comptes (emails, hashs de mots de passe, sessions), données des acheteurs (nom, email, commandes), coordonnées bancaires des collectifs (IBAN), argent encaissé (paiements, remboursements), intégrité du stock de places et des billets, chiffres de vente de chaque collectif.
- Acteurs hostiles considérés : visiteur anonyme, acheteur malveillant, membre d'un collectif cherchant à voir un autre collectif, contrôleur indélicat, attaquant réseau (rejeu, CSRF), attaquant ayant lu la base de données, prestataire de paiement compromis ou défaillant.

### Authentification et sessions
- Mots de passe : argon2id (m=19 Mio, t=2, p=1), normalisation NFC, 12–128 caractères et ≤ 256 octets, refus des 10 000 mots de passe longs les plus courants ; au plus 4 calculs simultanés (file bornée, 429 au-delà).
- Anti-énumération : réponses et temps de réponse identiques (plancher 400 ms + gigue) pour l'inscription, le renvoi de vérification et le mot de passe oublié ; hash factice pour un email inconnu ; 401 générique au login (compte verrouillé compris).
- Anti pré-détournement : connexion impossible tant que l'email n'est pas vérifié ; une nouvelle inscription sur un compte non vérifié remplace l'ancienne et révoque tout.
- Verrouillage : tentative réservée atomiquement AVANT l'évaluation du mot de passe (au plus 5 évaluations même en rafale parallèle), verrou de 1 min doublé jusqu'à 15 min, fenêtre glissante de 15 min ; même compteur pour le changement de mot de passe et la ré-authentification bancaire.
- Access token JWT HS256 (10 min), algorithme épinglé, `iss` / `aud` / `exp` vérifiés, `kid` + trousseau pour la rotation, payload `sub` / `jti` / `ver` ; `ver` = version de jeton du compte, incrémentée à chaque changement / reset de mot de passe et vérification d'email (révocation immédiate).
- Refresh token opaque 256 bits, stocké haché, cookie `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth` ; rotation à chaque usage, réutilisation ⇒ famille révoquée, délai de grâce de 10 s pour une réponse perdue (si le successeur n'a jamais servi), famille limitée à 90 jours, version liée au mot de passe (aucune session ne survit à un reset concurrent).
- Anti-CSRF des routes à cookie : en-tête `X-Requested-With` + `Origin` dans l'allowlist (Origin `null` refusée).
- Liens mail (vérification, reset) : jetons aléatoires hachés, usage unique (UPDATE gardé), 30 min, liés à l'adresse d'envoi ; au plus 1 mail d'authentification / 2 min et 10 / 24 h par compte, sans invalider un lien frais.

### Autorisations et isolation des collectifs
- Rôles jamais dans le jeton : adhésion relue en base à chaque requête ; non-membre ⇒ 404, rôle insuffisant ⇒ 403.
- Chaque requête back-office filtre par `orgId` (y compris via la clé parente dans le SQL brut) ; une ressource d'un autre collectif ou d'un autre acheteur ⇒ 404. Tests d'IDOR avec vérification que les données ciblées sont restées identiques.
- Actions sensibles réservées à l'OWNER : réglages, coordonnées bancaires (avec ré-authentification et mail à tous les OWNER), membres, report et annulation d'événement, mode de contrôle hors-ligne. Le dernier OWNER ne peut pas être retiré, même en concurrence.

### Entrées, sorties et surface HTTP
- Joi sur params / query / body / en-têtes : champs inconnus refusés (400), corps JSON non converti, dates avec fuseau explicite, textes sans caractères de contrôle ni marques bidirectionnelles, NUL refusé à toute profondeur, clés `__proto__` / `constructor` / `prototype` refusées ; emails ASCII ; montants plafonnés.
- Joi en sortie : seuls les champs du contrat sortent (en test, un champ en trop fait échouer).
- Aucun objet client passé tel quel à la base (mapping explicite) ; SQL uniquement paramétré (`$queryRaw` tagué ; `$queryRawUnsafe` interdit par lint).
- Prix, tarif early, frais, totaux et remboursements calculés côté serveur en entiers (BigInt), figés sur la commande.
- Corps limités à 10 ko (64 ko webhook, 160 ko pour la synchronisation, lue seulement après authentification) ; Content-Type JSON exigé (415).
- helmet (CSP `default-src 'none'`, `frame-ancestors 'none'`, HSTS en production), CORS limité à l'origine du front, `Cache-Control: no-store`, pas d'`X-Powered-By`, nombre de proxys de confiance borné (0–3).
- Erreurs centralisées : jamais de stack ni de message SQL ; erreurs transitoires (interblocage) ⇒ 409, jamais 500.
- Rate limiting partagé en base (multi-instance, survit au redémarrage, identifiants hachés) : par IP ET par compte / adresse (connexion, mails, réservations, scans).

### Argent, stock et billets
- Zéro survente : décrément atomique conditionnel + contrainte `CHECK (sold + held <= capacity)` ; ordre de verrous unique (verrou consultatif acheteur / événement → événement → commande → types de places).
- Idempotence : `Idempotency-Key` par acheteur (même clé + corps différent ⇒ 409) ; webhook dédoublonné par identifiant d'événement dans la même transaction que son effet ; billets uniques par (ligne, rang) ; remboursements exécutés avec une clé d'idempotence ; scans idempotents par `scanId`.
- Webhook : signature HMAC-SHA256 vérifiée à temps constant sur le corps brut, fenêtre de 5 min ; une fois la signature valide, aucun paiement n'est perdu : toute somme encaissée sans billets est enregistrée puis remboursée automatiquement (log error + audit).
- Remboursements : jamais d'appel réseau dans une transaction (bail + worker), plafond vérifié sous verrou ET par déclencheur SQL ; échec durable ⇒ traitement manuel visible par l'organisateur (jamais d'échec silencieux).
- Billets : identifiant public 128 bits aléatoire, QR `NG1.<eventId>.<publicId>.<signature Ed25519>` sans donnée personnelle, base64url canonique exigé ; passage `VALID → USED` atomique ; billets d'une commande annulée / remboursée / expirée annulés dans la même transaction et par déclencheur SQL ; contrôle limité aux événements publiés terminés depuis moins de 24 h.

### Données au repos et journaux
- IBAN chiffrés en AES-256-GCM liés à leur ligne (données associées), identifiant de clé pour la rotation, jamais renvoyés en clair (forme masquée) sauf à l'acheteur concerné par un virement ; coordonnées figées sur chaque commande.
- File de mails chiffrée (même mécanisme) et purgée après envoi ou abandon : aucun lien à jeton lisible en base.
- Journaux pino : identifiant de requête généré par le serveur, masquage des en-têtes et champs sensibles à toute profondeur, erreurs de base réduites à leur type / code, messages et stacks expurgés (emails, IBAN, hashs, jetons) ; audit des actions sensibles (réglages avec IBAN masqué, membres, report, annulation, virements, remboursements, export).

## Frontend

_Section rédigée avec le jalon F5._

## Limites connues et risques acceptés

- **Contrôle hors-ligne (mode secours, désactivé par défaut)** : le contrôle d'accès fonctionne en ligne ; sans réponse du serveur, l'entrée est refusée (« Vérification impossible »). Le mode secours hors-ligne n'existe que si un OWNER l'active pour un événement (action auditée). Dans ce mode, deux appareils hors-ligne en même temps peuvent accepter le même billet ; le conflit n'apparaît qu'à la synchronisation (le premier passage gagne). Recommandation : un appareil par porte, synchronisation dès que possible, n'activer le mode qu'en cas de réseau défaillant. La liste téléchargée contient les identifiants publics et les initiales des porteurs : un appareil perdu l'expose.
- **Access token après déconnexion simple** : il reste valable au plus 10 min (la déconnexion révoque la session de renouvellement mais pas la version du compte, pour ne pas déconnecter les autres appareils). Un changement de mot de passe, lui, révoque tout immédiatement.
- **Verrouillage de compte** : un tiers peut bloquer la connexion d'un compte dont il connaît l'email pendant au plus 15 min (les sessions existantes ne sont pas coupées).
- **Oracle d'existence pour un OWNER** : l'ajout d'un membre répond 404 si le compte n'existe pas ou n'est pas vérifié ; la personne ajoutée est prévenue par mail.
- **Secrets** : clés JWT, clé de chiffrement des IBAN et clé de signature des billets sont fournies par fichiers / variables d'environnement (pas de HSM / KMS) ; une compromission du serveur les expose. Rotation prévue (identifiants de clé) mais manuelle. La clé privée de signature doit être en 0600 / 0400 (refus de démarrer sinon, en production).
- **Prestataire de paiement simulé** : uniquement pour le développement et les tests (refuse de démarrer en production) ; aucune intégration réelle n'est fournie.
- **Remboursement des virements** : manuel (le collectif effectue le virement retour puis le marque comme fait).
- **Disponibilité** : base PostgreSQL unique (stock, sessions, compteurs de limitation, files) ; pas de protection anti-DDoS volumétrique au-delà du rate limiting applicatif ; le worker doit tourner pour que les réservations expirent et que les mails / remboursements partent (plusieurs instances possibles sans double traitement).
- **Pas de double authentification (MFA)** pour les organisateurs.
- **Horloge des appareils** : les horodatages de scans hors-ligne sont bornés mais déclaratifs (journal), et `deviceId` n'a aucune valeur de preuve.
- **Plafond par personne** : il s'applique par compte ; plusieurs comptes d'une même personne ne sont pas détectés.

## Check-list de mise en production

- [ ] `NODE_ENV=production` (active HSTS, cookie `Secure`, refuse le mock PSP, les placeholders et un `RATE_LIMIT_MULTIPLIER` > 1).
- [ ] Secrets générés aléatoirement (commandes dans `backend/.env.example`), tous distincts, injectés hors dépôt.
- [ ] Clé privée Ed25519 en 0400, propriétaire = utilisateur du service.
- [ ] `TRUST_PROXY_HOPS` réglé selon l'architecture réelle (vérifier `req.ip` dans les logs au démarrage).
- [ ] Front servi derrière le reverse proxy avec les en-têtes de `frontend/deploy/nginx.conf.example` (CSP stricte, HSTS, `frame-ancestors 'none'`, `Permissions-Policy`).
- [ ] TLS partout ; API et front sur la même origine (ou CORS limité à l'origine exacte du front).
- [ ] Worker démarré et supervisé ; alerte sur les remboursements `MANUAL_REQUIRED` et les commandes en échec d'expiration.
- [ ] Sauvegardes chiffrées de PostgreSQL, accès base restreint.
- [ ] `npm audit --omit=dev` sans vulnérabilité haute ou critique sur les deux applications.
