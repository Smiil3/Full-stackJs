# Traitement du rapport d'audit n° 2 du 2026-10-07

Rapport : [`2026-10-07-rapport-audit-securite-2.md`](2026-10-07-rapport-audit-securite-2.md). Verdict : 0 critique, 0 haute, 4 moyennes, 13 basses, 16 qualité, 18 info ; 20 corrections du rapport n° 1 complètes, 4 partielles (devenues M'1 à M'4).
Décisions du PO le 2026-10-07. Branche `fix/audit-2-2026-10-07`. Lots **A3** (backend) et **A4** (frontend). Contrat **v1.18**.

| # | Sujet | Décision | Lot |
|---|---|---|---|
| M'1 | Verrou global entretenable à 1 req / 15 min | **Corrigé** : fenêtre comptée depuis le premier échec, compteur remis à zéro à l'expiration du verrou ; mail au titulaire lors d'un verrou global (plafonné) l'invitant à réinitialiser son mot de passe ; la réinitialisation lève tous les verrous ; limite connue réécrite | A3 |
| M'2 | Anti-gel contourné en quittant l'offre | **Corrigé** : offre quittée > 15 min après émission et commande d'offre non payée comptent comme « non honorées » (contrat §6) | A3 + A4 |
| M'3 | Report : droits perdus sur commande expirée puis payée | **Corrigé** : droits du report appliqués avant toute expiration et dans le règlement tardif | A3 |
| M'4 | Éditeur d'événement : écrasement des champs non touchés | **Corrigé** : différence calculée champ par champ contre l'état initial du formulaire, test sur le corps du PATCH | A4 |
| B'1 | TTL de la clé d'idempotence, `UNEXPECTED_RESPONSE` 2xx | **Corrigé** : TTL supprimé, 2xx inattendu traité comme transitoire | A4 |
| B'2 | Second passage du même QR ignoré en silence | **Corrigé** : « toujours dans le champ » (lectures espacées < 1 s) ignoré ; un QR re-présenté est scanné normalement (le serveur répond « déjà utilisé il y a N s ») ; câblage testé | A4 |
| B'3 | Masque bfcache levé après 3 s sans revérification | **Corrigé** : masque levé à la fin de la revérification ; plafond 10 s, puis état hors-ligne explicite | A4 |
| B'4 | Message d'offre faux, mock divergent | **Corrigé** | A4 |
| B'5 | Offre raccourcie pénalisante | **Corrigé** : pas d'offre < 15 min | A3 |
| B'6 | Report bloqué sans sortie | **Corrigé** : `reschedulePendingOrders`, commandes de report en échec listées dans les anomalies admin avec relance | A3 + A4 |
| B'7 | Remboursements `pending` sans fin, erreur ≠ introuvable | **Corrigé** : erreur de recherche distinguée, `pending` visible et alerté au-delà de 24 h | A3 |
| B'8 | Rejet non géré à l'arrêt | **Corrigé** | A3 |
| B'9 | Erreurs de synchro scanner avalées | **Corrigé** | A4 |
| B'10 | Transactions hors helper | **Corrigé** | A3 |
| B'11 | `prisma generate` non automatique | **Corrigé** : génération automatique compatible avec une installation de production | A3 |
| B'12 | Tentative fantôme | **Corrigé** si simple, sinon commentaire exact | A3 |
| B'13 | `Date.now()` et `!` dans un test | **Corrigé** | A3 |
| Q1, Q2, Q3, Q5, Q6, Q9, Q10, Q12, Q13, Q14, Q15 | Qualité | **Corrigés** : gabarits mail typés, helpers partagés (UUID, base64url, Bearer, rôles, extraction Prisma, verrous dans `lib/locks.ts`), module `settlement/` sans import dynamique, export découplé d'Express, assertions renforcées, tests B1/B2/B8/M1/M4 qui prouvent la correction, code mort supprimé + `knip` en CI locale, clés de requête et unités de temps front centralisées, `eslint-disable` justifiés, compteurs de test hors production | A3 + A4 |
| Q4 | Services qui contournent les repos | **Documenté** : architecture réelle décrite (requêtes simples dans le service, sous transaction ; repo pour les requêtes partagées ou en SQL brut) ; pas de refonte massive à risque | Doc |
| Q7 | Fonctions longues | **Partiel** : découpage des plus longues quand c'est sans risque (`ScannerPage`, `reserveAndCreate`, `renderTemplate`), le reste documenté | A3 + A4 |
| Q8 | `!` et `as` dans les tests backend | **Partiel** : helper `expectDefined` sur les cas à message obscur (cookies, en-têtes), règle conservée relâchée pour les tests | A3 |
| Q11 | Tests nommés par ticket | **Corrigé** : dossiers et noms par domaine, codes d'audit documentés dans `docs/audits/` | A3 + A4 |
| Q16 | Mocks MSW volumineux | **Documenté** (test de contrat conservé comme garde-fou) | Doc |
| Info | Docs, config, divers | **Corrigés** : SECURITY.md (4 formulations), contrat (date, tableau), README (comptes de tests, génération Prisma), `docs/plan.md` marqué historique + architecture actuelle, variables e2e documentées, e2e qui échouent sans mot de passe au lieu de s'ignorer, refus de build aussi hors `--mode production`, `Retry-After` sans perte des autres détails, erreurs PSP de forme vs injoignable, audit complet au report et à la création, aperçu de remboursement à jour dès le report, fuseau d'affichage cohérent, `Retry-After` borné, configs TS / ESLint / Node alignées, healthchecks Docker, Playwright factorisé, régénération de `commonPasswords` documentée | A3 + A4 + Doc |
| Info | Thème : flash sombre au chargement | **Accepté** (inévitable sans nonce CSP) | Doc |
| Info | Prix des types de places modifiable par un MANAGER | **Accepté, documenté** (audité ; conforme au contrat) | Doc |
