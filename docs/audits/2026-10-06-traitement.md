# Traitement du rapport d'audit du 2026-10-06

Rapport : [`2026-10-06-rapport-audit-securite.md`](2026-10-06-rapport-audit-securite.md). Verdict de l'auditeur : 0 critique, 0 haute, 7 moyennes, 18 basses, ~12 infos ; aucun chemin vers vol d'argent, survente, IDOR, injection, XSS, open redirect, rejeu de webhook ou billet forgé.
Décisions prises par le PO le 2026-10-07. Lots : **A1** (backend, `nuits-back`), **A2** (frontend, `nuits-front`). Contrat passé en **v1.17**.

| # | Sujet | Décision | Lot |
|---|---|---|---|
| M1 | MANAGER modifie les règles financières | **Corrigé** : surcharges financières (`refundPercent`, frais, `transferEnabled`, `selfCancellationEnabled`, `cancellationDeadlineHours`) réservées à l'OWNER, audit champ par champ + mail aux OWNER (contrat §7.2) | A1 + A2 |
| M2 | Gel de stock via la liste d'attente | **Corrigé** : durée d'offre bornée 15–360 min, sortie de la liste après 2 offres expirées sur un événement (contrat §6) | A1 + A2 |
| M3 | Worker affamé par un PSP muet | **Corrigé** : budget temps par job, appels PSP en parallèle borné, outbox dans une boucle séparée, arrêt entre jobs | A1 |
| M4 | Faux « DÉJÀ UTILISÉ » en relisant le même QR | **Corrigé** : même code ignoré tant qu'il reste dans le champ et pendant N s après fermeture du résultat | A2 |
| M5 | `Idempotency-Key` jamais renouvelée | **Corrigé** : clé oubliée sur commande `EXPIRED` / `CANCELLED` et sur erreur non transitoire, + TTL | A2 |
| M6 | Écrasement silencieux des réglages | **Corrigé** : patch calculé contre l'état initial du formulaire, alerte si le serveur a changé entre-temps | A2 |
| M7 | Verrouillage de compte entretenu par un tiers | **Atténué + documenté** : verrou par couple (compte, IP) ; seuil global par compte plus haut ; limite connue reformulée | A1 |
| B1 | Cycles de verrous (liste d'attente, billets) | **Corrigé** : ordre unique, `withTxRetry` sur report et types | A1 |
| B2 | `expireOrders` sans retry, commande écartée à vie | **Corrigé** : `withTxRetry`, remise à zéro, commandes écartées visibles et relançables par l'admin plateforme | A1 |
| B3 | Remboursements orphelins invisibles | **Corrigé** : `GET /admin/refunds` (contrat §8) | A1 + A2 |
| B4 | MANAGER valide virements / remboursements | **Risque accepté, documenté** (confiance au collectif, tout est audité) | Doc |
| B5 | `pending` PSP ⇒ double remboursement manuel | **Corrigé** : `mark-done` carte interroge le PSP (contrat §7.3 bis) | A1 + A2 |
| B6 | Mail de report dans l'ancien fuseau | **Corrigé** | A1 |
| B7 | Report d'un gros événement en une transaction | **Corrigé** : traitement par lots comme l'annulation | A1 |
| B8 | Aucune purge des données personnelles | **Corrigé** : job de rétention avec durées documentées | A1 |
| B9 | Masquage des logs incomplet | **Corrigé** : clés ajoutées, messages Joi non journalisés tels quels | A1 |
| B10 | CSV dépendant du séparateur | **Corrigé** : cellules contenant `,` citées, neutralisation indépendante du séparateur | A1 |
| B11 | Écouteurs d'export et spam d'audit | **Corrigé** | A1 |
| B12 | Rôle non relu dans la transaction (actions OWNER) | **Corrigé** : relecture du rôle dans la transaction pour toutes les actions OWNER | A1 |
| B13 | Garde du seed contournable | **Corrigé** : `ALLOW_SEED=1` explicite, DECISIONS aligné | A1 |
| B14 | Clé publique du mode secours non épinglée | **Corrigé** : clé publique fixée au build (`VITE_TICKET_PUBLIC_KEY_JWK`), snapshot refusé si différente | A2 |
| B15 | `qrPayload` dans la file hors-ligne | **Documenté** dans les limites connues (nécessaire à la synchro) | Doc |
| B16 | Plus de bouton après 60 s de polling | **Corrigé** : « Reprendre le paiement » / « Actualiser » restent proposés | A2 |
| B17 | Divers front | **Corrigé** point par point | A2 |
| B18 | Mail de reset provoqué par un tiers | **Risque accepté, documenté** (plafonné) | Doc |
| Info | Incohérences documentaires et durcissements | **Corrigés** (contrat, SECURITY.md, DECISIONS, `take: 500`, offre gratuite, `getSettings` sans upsert, `SUM` en bigint, override `mysql2`, `eventId` en minuscules, CSP `upgrade-insecure-requests` et `img-src` justifié) | A1 + A2 + Doc |
| + | Message clair si le prestataire de paiement est injoignable | **Ajouté** : `503 PAYMENT_PROVIDER_UNAVAILABLE` + message « vos places restent réservées jusqu'à HH:MM » (demande du porteur) | A1 + A2 |
