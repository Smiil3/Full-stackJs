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
- **2026-10-06 — `User.tokensValidAfter`.** — Le middleware d'auth relit l'utilisateur en base et refuse tout access token émis avant cette date : un changement / reset de mot de passe invalide aussi les access tokens en cours (et pas seulement les refresh tokens).
- **2026-10-06 — Contraintes CHECK étendues.** — En plus du stock (`sold + held <= capacity`) : montants positifs, `total = sous-total + frais`, cohérence early, dates d'événement, bornes des réglages (collectif et surcharges), `USED ⇔ usedAt`. Filet de sécurité si un bug applicatif passait la validation Joi.
- **2026-10-06 — Nettoyage de la base de test par une liste de tables statique.** — `TRUNCATE` ne prend pas de paramètres liés ; plutôt que `$executeRawUnsafe` (interdit), liste littérale + test qui vérifie qu'elle couvre toutes les tables du schéma.
- **2026-10-06 — Seed refusé en production et sur base non vide ; mot de passe commun aléatoire affiché une fois si `SEED_PASSWORD` est vide.**
- **2026-10-06 — Frais de service nuls sur une commande à 0 €.** — Éviter de facturer des frais sur une entrée gratuite (une commande gratuite n'a pas de paiement PSP).
