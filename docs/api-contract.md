# Contrat d'API — Billetterie « Les Nuits de la Garonne »

> **Source de vérité commune front / back.** Toute modification passe par le PO (session `fullstack-js`) : demander via une ligne `NEED: changement de contrat …`. Ne jamais diverger silencieusement.
> Version : 1.7 — 2026-10-06 (voir §11 Historique)

## 1. Conventions

- Base URL : `/api/v1`. Back en dev : `http://localhost:4000`. Front en dev : `http://localhost:5173` (proxy Vite `/api` → 4000). Mock PSP : `http://localhost:4001`.
- JSON UTF-8 partout (sauf export CSV et webhook PSP en body brut).
- Identifiants : UUID v4 (string).
- **Montants** : entiers en **centimes** (`priceCents: 1500` = 15,00 €). Devise unique `"EUR"`.
- **Dates** : chaînes ISO 8601 **UTC** avec `Z` (`"2026-11-14T19:00:00.000Z"`). Les événements portent un `timezone` IANA (`"Europe/Paris"`) pour l'affichage.
- Pagination : query `page` (1–1000, défaut 1), `pageSize` (1–100, défaut 20) → réponse `{ items, page, pageSize, total }`.
- Champs inconnus dans un body/query → **400 VALIDATION_ERROR** (pas d'ignorance silencieuse).
- Les réponses ne contiennent **que** les champs listés ici.

### Format d'erreur (toutes les erreurs)
```json
{ "error": { "code": "SOLD_OUT", "message": "Message lisible en français", "details": {} } }
```
`details` optionnel. Pour `VALIDATION_ERROR` : `details.fields = [{ "path": "items.0.quantity", "message": "..." }]`.

| HTTP | code | Sens |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Entrée invalide (Joi) |
| 401 | `UNAUTHENTICATED` | Access token absent / invalide / expiré → le front tente un refresh |
| 401 | `INVALID_CREDENTIALS` | Login échoué, compte verrouillé, ou `currentPassword` faux sur change-password (message générique ; **ne déclenche pas de refresh**) |
| 401 | `INVALID_REFRESH_TOKEN` | Refresh absent / expiré / révoqué / réutilisé → déconnexion |
| 403 | `FORBIDDEN` | Authentifié mais rôle insuffisant **dans un collectif dont on est membre** |
| 403 | `EMAIL_NOT_VERIFIED` | Action nécessitant un email vérifié |
| 403 | `CSRF_CHECK_FAILED` | Origin / en-tête anti-CSRF invalide |
| 404 | `NOT_FOUND` | Ressource inexistante **ou appartenant à un autre utilisateur / collectif** ; aussi `/admin/*` appelé par un non-admin (on ne révèle pas l'existence) |
| 409 | `SOLD_OUT` | Plus assez de places (`details.ticketTypeId`) |
| 409 | `SALES_CLOSED` | Ventes non ouvertes / terminées / événement annulé |
| 409 | `ORDER_EXPIRED` | Réservation expirée |
| 409 | `INVALID_STATE` | Transition impossible (ex. payer une commande annulée) |
| 409 | `IDEMPOTENCY_CONFLICT` | Même Idempotency-Key avec un body différent |
| 409 | `ALREADY_IN_WAITLIST` / `NOT_SOLD_OUT` / `OFFER_EXPIRED` / `WAITLIST_DISABLED` | Liste d'attente |
| 409 | `CANCELLATION_CLOSED` | Délai d'annulation dépassé / billet déjà scanné / annulation désactivée |
| 409 | `CONFLICT` | Conflit générique (slug déjà pris, capacité < vendus, suppression impossible…) |
| 413 | `PAYLOAD_TOO_LARGE` | Corps de requête trop volumineux |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Content-Type non supporté (JSON attendu) |
| 422 | `LIMIT_EXCEEDED` | Plafond par commande ou par personne dépassé (`details.max`, `details.alreadyOwned`) |
| 422 | `PAYMENT_METHOD_UNAVAILABLE` | Virement désactivé ou coordonnées bancaires absentes |
| 422 | `AMOUNT_MISMATCH` | Montant de virement reçu ≠ montant dû |
| 429 | `RATE_LIMITED` | Trop de requêtes (en-tête `Retry-After`) |
| 500 | `INTERNAL_ERROR` | Jamais de stack ni de détail technique |

## 2. Authentification (JWT access + refresh rotatif)

- **Access token** : JWT HS256, durée 10 min, renvoyé dans le body. Le front le garde **en mémoire uniquement** (jamais localStorage/sessionStorage). Envoi : `Authorization: Bearer <token>`.
- **Refresh token** : opaque, cookie `nuits_rt` — `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth; Max-Age=30 jours` (en dev HTTP, `Secure` désactivé par config). Rotation à chaque appel ; réutilisation d'un ancien token ⇒ toute la famille révoquée ⇒ 401 `INVALID_REFRESH_TOKEN`.
- Les endpoints utilisant le cookie (`/auth/refresh`, `/auth/logout`) exigent l'en-tête `X-Requested-With: nuits-web` **et** un `Origin` dans l'allowlist, sinon 403 `CSRF_CHECK_FAILED`.
- Toutes les requêtes front : `credentials: 'include'`.
- **Délai de grâce de rotation** : un refresh rejoué dans les 10 s avec le token précédent, si son successeur n'a jamais servi, renvoie une nouvelle session valide (cas réponse perdue sur réseau mobile). Le cookie n'est effacé que sur 401.
- Durée de vie absolue d'une famille de refresh : 90 jours ⇒ reconnexion obligatoire.
- `POST /auth/verify-email` révoque toutes les sessions existantes : après vérification, le front envoie vers la page de connexion.
- Les rôles ne sont **pas** dans le JWT : `GET /auth/me` donne les adhésions.

### Objets
```ts
type User = { id: string; email: string; displayName: string; emailVerified: boolean; isPlatformAdmin: boolean;
  memberships: { orgId: string; orgName: string; orgSlug: string; role: 'OWNER'|'MANAGER'|'SCANNER' }[] }
type AuthSession = { accessToken: string; expiresIn: number /* secondes */; user: User }
```

| Méthode & chemin | Auth | Body | Réponse |
|---|---|---|---|
| `POST /auth/register` | — | `{ email (ASCII), password (12–128 caractères, ≤ 256 octets, pas un mot de passe courant), displayName (1–80) }` | **202** `{ message }` — identique que l'email existe ou non, temps de réponse constant. Compte non vérifié existant ⇒ la nouvelle inscription remplace l'ancienne (anciens liens invalidés). Compte vérifié ⇒ mail « vous avez déjà un compte ». |
| `POST /auth/verify-email` | — | `{ token }` | 204 · 400 `VALIDATION_ERROR` si token invalide/expiré |
| `POST /auth/resend-verification` | — | `{ email }` | 202 (toujours) |
| `POST /auth/login` | — | `{ email, password }` | 200 `AuthSession` + cookie · 401 `INVALID_CREDENTIALS` · **403 `EMAIL_NOT_VERIFIED`** (uniquement si le mot de passe est correct ; aucune session créée) · 429 |
| `POST /auth/refresh` | cookie + anti-CSRF | — | 200 `AuthSession` + nouveau cookie · 401 `INVALID_REFRESH_TOKEN` |
| `POST /auth/logout` | cookie + anti-CSRF | — | 204, cookie effacé, famille révoquée |
| `POST /auth/forgot-password` | — | `{ email }` | 202 (toujours) |
| `POST /auth/reset-password` | — | `{ token, password }` | 204, toutes les sessions révoquées |
| `POST /auth/change-password` | Bearer | `{ currentPassword, newPassword }` | 204, toutes les sessions révoquées, cookie effacé (le front renvoie au login) |
| `GET /auth/me` | Bearer | — | 200 `User` |

Liens dans les mails : `${FRONT_URL}/verify-email?token=…` et `${FRONT_URL}/reset-password?token=…`.

## 3. Catalogue public

```ts
type Availability = 'AVAILABLE' | 'LOW' /* ≤10 % restants */ | 'SOLD_OUT'   // jamais de chiffres exacts en public
type TicketTypePublic = { id; name; description: string|null; currentPriceCents: number; regularPriceCents: number;
  isEarly: boolean; earlyUntil: string|null; availability: Availability }
type EventRulesPublic = { maxPerOrder; maxPerUser; transferEnabled: boolean; cardHoldMinutes; transferHoldHours;
  selfCancellationEnabled: boolean; cancellationDeadlineHours; refundPercent; serviceFeeFixedCents; serviceFeeBasisPoints; waitlistEnabled: boolean }
type EventSummary = { id; orgId; orgName; orgSlug; title; venue: string|null; isOnline: boolean; startsAt; endsAt;
  timezone; coverAvailability: Availability; fromPriceCents: number }
type EventPublic = EventSummary & { description: string|null; address: string|null; salesStartAt; salesEndAt;
  salesOpen: boolean; ticketTypes: TicketTypePublic[]; rules: EventRulesPublic; contactEmail: string|null }
```
| Méthode & chemin | Auth | Query / Body | Réponse |
|---|---|---|---|
| `GET /events` | — | `page, pageSize, orgSlug?, from?, to?` | 200 `{ items: EventSummary[], … }` — uniquement `PUBLISHED`, à venir, tri `startsAt` asc |
| `GET /events/:eventId` | — | — | 200 `EventPublic` · 404 si non publié |

## 4. Commandes (acheteur)

```ts
type OrderStatus = 'PENDING_PAYMENT'|'AWAITING_TRANSFER'|'PAID'|'EXPIRED'|'CANCELLED'|'REFUNDED'
type Order = { id; eventId; eventTitle; eventStartsAt; eventTimezone; status: OrderStatus; paymentMethod: 'CARD'|'TRANSFER';
  items: { ticketTypeId; name; quantity; unitPriceCents }[]; subtotalCents; serviceFeeCents; totalCents; currency: 'EUR';
  expiresAt: string|null; paidAt: string|null; cancellableUntil: string|null; refundPercent: number; refundAmountCents: number|null;
  refundPreviewCents: number|null /* montant qui serait remboursé si l'acheteur annulait maintenant ; null si annulation impossible */;
  createdAt; transferInstructions: null | { beneficiary; iban; bic; reference; amountCents; deadline } }
```
`transferInstructions` n'est rempli que pour le propriétaire de la commande et si `status = AWAITING_TRANSFER`.

**Remboursement** (calcul serveur, entiers) : `floor(subtotalCents × refundPercent / 100)` + `serviceFeeCents` si `serviceFeeRefundable` (figé sur la commande), sinon + 0. Annulation d'événement par l'organisateur : `totalCents`. `refundPreviewCents` applique cette formule si l'annulation self-service est possible à l'instant de la réponse (statut PAID, aucun billet scanné, avant `cancellableUntil`, annulation activée), sinon `null`. Commande non payée : annulation sans remboursement (`refundPreviewCents = 0`).

| Méthode & chemin | Auth | Body | Réponse |
|---|---|---|---|
| `POST /orders` | Bearer, email vérifié | en-tête **`Idempotency-Key: <uuid>`** (obligatoire) · `{ eventId, paymentMethod, items: [{ ticketTypeId, quantity ≥1 }] (1–10 items, ticketTypeId uniques) }` | **201** `Order` (même Idempotency-Key + même body ⇒ même commande, 200) · 409 `SOLD_OUT`/`SALES_CLOSED`/`IDEMPOTENCY_CONFLICT` · 422 `LIMIT_EXCEEDED`/`PAYMENT_METHOD_UNAVAILABLE` |
| `GET /orders` | Bearer | `page, pageSize` | 200 page de `Order` (les siennes) |
| `GET /orders/:orderId` | Bearer | — | 200 `Order` · 404 si pas à lui |
| `POST /orders/:orderId/checkout` | Bearer | — | 200 `{ redirectUrl }` vers le mock PSP · 409 `ORDER_EXPIRED`/`INVALID_STATE` |
| `POST /orders/:orderId/cancel` | Bearer | — | 200 `Order`. Non payée ⇒ `CANCELLED`. Payée ⇒ `REFUNDED` avec `refundAmountCents` · 409 `CANCELLATION_CLOSED`/`INVALID_STATE` |

Prix, tarif early, frais et total sont **toujours calculés par le serveur** ; le client n'envoie jamais de prix.
Après paiement, le PSP redirige vers `${FRONT_URL}/orders/:orderId?payment=success|failed` ; le front **poll** `GET /orders/:orderId` (toutes les 2 s, max 60 s) jusqu'à `PAID` — la redirection ne prouve rien, seul le webhook fait foi.

## 5. Billets (acheteur)

```ts
type Ticket = { id; publicId: string; status: 'VALID'|'USED'|'CANCELLED'; usedAt: string|null; qrPayload: string;
  ticketTypeName; orderId; event: { id; title; venue; isOnline; startsAt; endsAt; timezone } }
```
`qrPayload` = `NG1.<eventId>.<publicId>.<signature>` — à encoder tel quel dans le QR. Aucune donnée personnelle.
- `eventId` : UUID de l'événement (forme canonique minuscule, 36 caractères).
- `publicId` : 16 octets aléatoires encodés **base64url sans padding** (22 caractères). C'est **exactement la même chaîne** partout (snapshot, réponses de scan, CSV).
- `signature` : Ed25519 (clé privée serveur) sur les **octets UTF-8 de la chaîne ASCII `NG1.<eventId>.<publicId>`**, encodée base64url sans padding (86 caractères).
- Vérification hors-ligne : découper sur `.`, exiger 4 parties et le préfixe `NG1`, vérifier la signature avec `publicKeyJwk`, puis comparer `eventId` à l'événement scanné.

| Méthode & chemin | Auth | Réponse |
|---|---|---|
| `GET /me/tickets` | Bearer | 200 `{ items: Ticket[] }` (événements à venir puis passés) |

## 6. Liste d'attente (acheteur)

```ts
type WaitlistEntry = { id; eventId; eventTitle; ticketTypeId; ticketTypeName; quantity; status: 'WAITING'|'OFFERED'|'CONVERTED'|'EXPIRED'|'LEFT';
  position: number|null /* rang dans la file, si WAITING */; offerExpiresAt: string|null; createdAt }
```
| Méthode & chemin | Auth | Body | Réponse |
|---|---|---|---|
| `POST /events/:eventId/ticket-types/:ticketTypeId/waitlist` | Bearer, email vérifié | `{ quantity (1..maxPerOrder) }` | 201 `WaitlistEntry` · 409 `NOT_SOLD_OUT`/`ALREADY_IN_WAITLIST` · 422 `LIMIT_EXCEEDED` |
| `GET /me/waitlist` | Bearer | — | 200 `{ items: WaitlistEntry[] }` |
| `DELETE /waitlist/:entryId` | Bearer | — | 204 (statut `LEFT` ; si `OFFERED`, les places passent au suivant) |
| `POST /waitlist/:entryId/accept` | Bearer | — | 201 `Order` (CARD, `PENDING_PAYMENT`, places déjà réservées) · 409 `OFFER_EXPIRED` |

## 7. Back-office collectif (préfixe `/orgs/:orgId`, Bearer)

Contrôle à chaque requête : adhésion lue en base. Non-membre ⇒ **404**. Membre avec rôle insuffisant ⇒ 403.
Rôles : **OWNER** ⊃ **MANAGER** ⊃ **SCANNER**.

### 7.1 Collectif, réglages, membres
```ts
type OrgSettings = { cardHoldMinutes; transferHoldHours; transferEnabled; cancellationDeadlineHours; selfCancellationEnabled;
  refundPercent; serviceFeeRefundable: boolean; maxPerOrder; maxPerUser; waitlistOfferMinutes; waitlistEnabled;
  serviceFeeFixedCents; serviceFeeBasisPoints; defaultTimezone; contactEmail: string|null;
  bank: { beneficiary: string|null; ibanMasked: string|null /* "FR76 •••• •••• 1234" */; bic: string|null } }
type Member = { userId; email; displayName; role; createdAt }
```
| Méthode & chemin | Rôle | Body | Réponse |
|---|---|---|---|
| `GET /orgs/:orgId` | SCANNER+ | — | 200 `{ id, name, slug, createdAt }` |
| `GET /orgs/:orgId/settings` | MANAGER+ | — | 200 `OrgSettings` |
| `PATCH /orgs/:orgId/settings` | OWNER | sous-ensemble de `OrgSettings` (sans `bank`) + optionnel `bank: { beneficiary, iban, bic }` (les 3 ensemble, IBAN complet) **+ `currentPassword` obligatoire si `bank` est présent** (ré-authentification ; échec ⇒ 401 `INVALID_CREDENTIALS`, compté dans le verrouillage) ; tout changement bancaire ⇒ mail à tous les OWNER du collectif | 200 `OrgSettings` · 400 si bornes (voir plan) / IBAN invalide / `maxPerUser < maxPerOrder` |
| `GET /orgs/:orgId/members` | MANAGER+ | — | 200 `{ items: Member[] }` |
| `POST /orgs/:orgId/members` | OWNER | `{ email, role }` (compte existant et vérifié) | 201 `Member` · 404 · 409 déjà membre — la personne ajoutée reçoit un mail l'informant (collectif, rôle, qui l'a ajoutée) |
| `PATCH /orgs/:orgId/members/:userId` | OWNER | `{ role }` | 200 `Member` · 409 si retire le dernier OWNER |
| `DELETE /orgs/:orgId/members/:userId` | OWNER | — | 204 · 409 si dernier OWNER |
| `GET /orgs/:orgId/audit-log` | OWNER | `page, pageSize` | 200 page `{ id, actorEmail, action, target, meta, createdAt }` — `actorEmail` vaut `"Administrateur plateforme"` pour une action d'un admin non membre ; `actorEmail` peut être `null` (action système) |

### 7.2 Événements & types de places
```ts
type EventOverrides = { cardHoldMinutes: number|null; transferHoldHours: number|null; transferEnabled: boolean|null;
  cancellationDeadlineHours: number|null; selfCancellationEnabled: boolean|null; refundPercent: number|null;
  maxPerOrder: number|null; maxPerUser: number|null; waitlistOfferMinutes: number|null; waitlistEnabled: boolean|null;
  serviceFeeFixedCents: number|null; serviceFeeBasisPoints: number|null }      // null = hérite du collectif
type TicketTypeAdmin = { id; name; description: string|null; capacity; sold; held; remaining; priceCents; earlyPriceCents: number|null;
  earlyUntil: string|null; sortOrder: number }
type EventAdmin = { id; orgId; title; description: string|null; venue: string|null; address: string|null; isOnline; startsAt; endsAt; timezone;
  status: 'DRAFT'|'PUBLISHED'|'CANCELLED'; salesStartAt; salesEndAt; overrides: EventOverrides;
  effectiveRules: EventRulesPublic; ticketTypes: TicketTypeAdmin[]; createdAt; updatedAt }
```
| Méthode & chemin | Rôle | Body | Réponse |
|---|---|---|---|
| `GET /orgs/:orgId/events` | MANAGER+ | `page, pageSize, status?` | 200 page `EventAdmin` |
| `POST /orgs/:orgId/events` | MANAGER+ | `{ title (1–150), description? (≤5000), venue?, address?, isOnline, startsAt, endsAt (> startsAt), timezone, salesStartAt, salesEndAt (≤ endsAt), overrides? }` | 201 `EventAdmin` (DRAFT) |
| `GET /orgs/:orgId/events/:eventId` | MANAGER+ | — | 200 `EventAdmin` |
| `PATCH /orgs/:orgId/events/:eventId` | MANAGER+ | champs ci-dessus, tous optionnels ; `overrides` partiel ; `rescheduleReason` (1–500) requis si report | 200 `EventAdmin` · 409 si `CANCELLED` · 403 si report par un MANAGER · 400 si `rescheduleReason` manquant |
| `POST /orgs/:orgId/events/:eventId/publish` | MANAGER+ | — | 200 `EventAdmin` · 409 si aucun type de place |
| `POST /orgs/:orgId/events/:eventId/cancel` | OWNER | `{ reason (1–500) }` | 200 `EventAdmin` — rembourse toutes les commandes payées, annule les autres, prévient par mail |
| `POST /orgs/:orgId/events/:eventId/ticket-types` | MANAGER+ | `{ name (1–80), description?, capacity (1–100000), priceCents (0–1000000), earlyPriceCents?, earlyUntil?, sortOrder? }` (early : les 2 ou aucun, `earlyPriceCents < priceCents`) | 201 `TicketTypeAdmin` |
| `PATCH /orgs/:orgId/events/:eventId/ticket-types/:ticketTypeId` | MANAGER+ | mêmes champs optionnels | 200 · 409 `CONFLICT` si `capacity < sold + held` |
| `DELETE /orgs/:orgId/events/:eventId/ticket-types/:ticketTypeId` | MANAGER+ | — | 204 · 409 si déjà des commandes |

**Report d'un événement** (modification de `startsAt` ou `endsAt` alors qu'il existe des commandes `PENDING_PAYMENT`/`AWAITING_TRANSFER`/`PAID`) : réservé à l'**OWNER**, `rescheduleReason` obligatoire. Effets : chaque commande PAID reçoit un nouveau `cancellableUntil` = max(ancien, nouveau `startsAt` − délai figé) et un `refundPercent` porté à 100 (droit au remboursement intégral, frais compris, suite au report) ; mail à tous les acheteurs ; AuditLog.
**Prix modifiés après ventes** : autorisé (MANAGER+), n'affecte que les nouvelles commandes (prix figés), tracé dans l'AuditLog.
**Invariants de dates** revérifiés à la création, à chaque PATCH (valeurs fusionnées) et à la publication : `endsAt > startsAt`, `salesStartAt < salesEndAt ≤ endsAt`, publication impossible si `salesEndAt ≤ maintenant` ; types de places : `earlyUntil ≤ salesEndAt` (revalidé quand les dates de l'événement changent). `GET /events/:eventId` public renvoie 404 pour un événement terminé depuis plus de 30 jours.

### 7.3 Commandes, virements, stats, export
```ts
type OrderAdmin = Order & { buyer: { id; email; displayName } }     // transferInstructions renseigné si AWAITING_TRANSFER, avec iban MASQUÉ (référence utile au rapprochement)
type EventStats = { eventId; generatedAt; currency: 'EUR';
  ticketTypes: { ticketTypeId; name; capacity; sold; held; remaining; checkedIn; revenueCents; refundedCents }[];
  totals: { capacity; sold; held; remaining; checkedIn; revenueCents; refundedCents; serviceFeeCents };
  ordersByStatus: Record<OrderStatus, number>; waitlistWaiting: number }
```
`revenueCents` = encaissé net (paiements − remboursements), frais de service à part.

**Frais de service** : `serviceFeeBasisPoints` entier 0–1500 (points de base : 250 = 2,5 %). Par commande : `serviceFeeCents = serviceFeeFixedCents + round_half_up(subtotalCents × serviceFeeBasisPoints / 10000)`, calcul en entiers uniquement.

| Méthode & chemin | Rôle | Query / Body | Réponse |
|---|---|---|---|
| `GET /orgs/:orgId/events/:eventId/orders` | MANAGER+ | `page, pageSize, status?, q? (email, ≤100)` | 200 page `OrderAdmin` |
| `POST /orgs/:orgId/orders/:orderId/confirm-transfer` | MANAGER+ | `{ receivedAmountCents }` | 200 `OrderAdmin` (PAID, billets émis, mail) · 422 `AMOUNT_MISMATCH` · 409 `ORDER_EXPIRED`/`INVALID_STATE` |
| `GET /orgs/:orgId/events/:eventId/stats` | MANAGER+ | — | 200 `EventStats` (le front poll toutes les 5 s) |
| `GET /orgs/:orgId/events/:eventId/attendees.csv` | MANAGER+ | — | 200 `text/csv; charset=utf-8`, `Content-Disposition: attachment`, séparateur `;`, BOM UTF-8. Colonnes : `billet;type;nom;email;statut;scanne_le` (heure locale de l'événement). Cellules protégées contre l'injection de formules. |

### 7.4 Contrôle d'accès (scan)
| `GET /orgs/:orgId/checkin/events` | SCANNER+ | — | 200 `{ items: { id; title; venue; isOnline; startsAt; endsAt; timezone; status }[] }` — événements PUBLISHED dont la fin date de moins de 24 h, sans aucun chiffre de vente |
| Méthode & chemin | Rôle | Body | Réponse |
|---|---|---|---|
| `GET /orgs/:orgId/events/:eventId/checkin/snapshot` | SCANNER+ | — | 200 `{ eventId; generatedAt; publicKeyJwk: { kty:'OKP', crv:'Ed25519', x }; tickets: { publicId; ticketTypeName; holderInitials; status; usedAt }[] }` |
| `POST /orgs/:orgId/events/:eventId/checkin/scan` | SCANNER+ | `{ qrPayload (≤256), deviceId (uuid), scanId (uuid, généré par l'appareil pour chaque tentative) }` | 200 `{ result: 'OK'|'ALREADY_USED'|'INVALID'|'CANCELLED'|'WRONG_EVENT'; ticket: null | { publicId; ticketTypeName; holderInitials }; usedAt: string|null }` — rate-limité |
| `POST /orgs/:orgId/events/:eventId/checkin/sync` | SCANNER+ | `{ deviceId, scans: [{ scanId (uuid), qrPayload, scannedAt }] (1–500, scanId uniques) }` | 200 `{ results: [{ scanId; result: 'ACCEPTED'|'ALREADY_USED'|'INVALID'|'CANCELLED'|'WRONG_EVENT'; usedAt: string|null }] }` — le premier scan (ordre `scannedAt`, puis arrivée serveur) gagne |

**Idempotence du scan par `scanId`** : `CheckIn.scanId` est UNIQUE. Si un `scanId` déjà enregistré est rejoué (scan en ligne dont la réponse s'est perdue, puis sync), le serveur renvoie le **résultat d'origine** (`OK` ⇒ `ACCEPTED` en sync) sans nouvel effet. Un **nouveau** `scanId` sur un billet déjà utilisé ⇒ `ALREADY_USED`, **même depuis le même appareil** (capture d'écran présentée deux fois à la même porte).
`scannedAt` fourni par l'appareil : sert à l'ordre et au journal, borné à [début des ventes, maintenant + 5 min], jamais pour contourner un `USED` existant.

**Hors-ligne, billet bien signé pour cet événement mais absent du snapshot** (vendu après le snapshot) : le front affiche un écran orange « Billet authentique non présent dans la liste — vérifier en ligne si possible » avec choix humain « Laisser entrer » (scan mis en file de synchro) / « Refuser ».

## 8. Administration plateforme
| Méthode & chemin | Auth | Body | Réponse |
|---|---|---|---|
| `GET /admin/orgs` | `isPlatformAdmin` | — | 200 `{ items: { id, name, slug, createdAt }[] }` |
| `POST /admin/orgs` | `isPlatformAdmin` | `{ name (2–80), slug (^[a-z0-9-]{2,40}$), ownerEmail }` | 201 org, propriétaire = compte existant vérifié |

## 9. Prestataire de paiement simulé (dev / test uniquement)

- Le back crée une session chez le mock : `POST http://localhost:4001/v1/checkout-sessions` (en-tête `Authorization: Bearer <PSP_API_KEY>`) `{ orderId, amountCents, currency, successUrl, cancelUrl }` → `{ id, url }`.
- Page hébergée `GET http://localhost:4001/checkout/:sessionId` avec boutons : **Payer**, **Refuser**, **Payer + envoyer le webhook 2 fois**, **Payer + webhook retardé 30 s**.
- Remboursement : `POST /v1/refunds` `{ paymentId, amountCents }` → `{ id, status: 'succeeded' }` + webhook `refund.succeeded`.
- **Webhook** vers le back : `POST /api/v1/webhooks/psp`, body brut JSON
  ```json
  { "id": "evt_…", "type": "payment.succeeded" | "payment.failed" | "refund.succeeded", "created": 1760000000,
    "data": { "paymentId": "pay_…", "sessionId": "cs_…", "orderId": "…", "amountCents": 3000, "currency": "EUR" } }
  ```
  En-tête `Psp-Signature: t=<unix>,v1=<hex HMAC-SHA256(PSP_WEBHOOK_SECRET, t + "." + rawBody)>`.
  Réponses : 200 `{ received: true }` (y compris doublon déjà traité) · 400 signature invalide / horodatage hors tolérance (5 min).
- Le mock n'est **jamais** démarré quand `NODE_ENV=production`.

## 10. Divers
- `GET /health` → 200 `{ status: 'ok' }` (sans info de version).
- En-têtes de sécurité via helmet ; CORS : origine `FRONT_URL` uniquement, `credentials: true`.

## 11. Historique
- **1.7** (2026-10-06) : report d'événement (OWNER, motif, droit au remboursement intégral) ; invariants de dates ; ré-authentification + notification pour changement bancaire ; mail au membre ajouté ; `GET /orgs/:orgId/events*` réservé MANAGER+, nouvel endpoint `GET /orgs/:orgId/checkin/events` pour SCANNER ; `page` ≤ 1000 ; libellé admin dans l'audit.
- **1.6** (2026-10-06) : `Order.refundPreviewCents` + formule de remboursement explicite.
- **1.5** (2026-10-06) : login non vérifié ⇒ 403 `EMAIL_NOT_VERIFIED` ; règles d'inscription (ASCII, mots de passe courants refusés, dernière inscription gagne) ; délai de grâce 10 s de rotation ; famille 90 j ; verify-email révoque les sessions.
- **1.4** (2026-10-06) : `/admin/*` pour non-admin ⇒ 404 ; liste d'attente désactivée ⇒ 409 `WAITLIST_DISABLED`.
- **1.3** (2026-10-06) : codes `PAYLOAD_TOO_LARGE` (413) et `UNSUPPORTED_MEDIA_TYPE` (415) ; JSON malformé ⇒ 400 `VALIDATION_ERROR`.
- **1.2** (2026-10-06) : `OrderAdmin.transferInstructions` avec IBAN masqué ; `INVALID_CREDENTIALS` couvre compte verrouillé et mauvais mot de passe actuel ; commande à 0 € ⇒ `PAID` directement à la création (pas de checkout) ; annulation d'événement ⇒ remboursement 100 % frais compris.
- **1.1** (2026-10-06) : format QR `NG1.<eventId>.<publicId>.<sig>` et octets signés précisés ; `scanId` ajouté au scan et à la sync (idempotence) ; `serviceFeePercent` remplacé par `serviceFeeBasisPoints` (entier) + formule ; types `string|null` explicités ; cas « billet signé absent du snapshot ».
