-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'MANAGER', 'SCANNER');

-- CreateEnum
CREATE TYPE "EmailTokenPurpose" AS ENUM ('VERIFY_EMAIL', 'RESET_PASSWORD');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING_PAYMENT', 'AWAITING_TRANSFER', 'PAID', 'EXPIRED', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CARD', 'TRANSFER');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('VALID', 'USED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CheckInResult" AS ENUM ('OK', 'ALREADY_USED', 'INVALID', 'CANCELLED', 'WRONG_EVENT');

-- CreateEnum
CREATE TYPE "WaitlistStatus" AS ENUM ('WAITING', 'OFFERED', 'CONVERTED', 'EXPIRED', 'LEFT');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" VARCHAR(80) NOT NULL,
    "emailVerifiedAt" TIMESTAMPTZ(3),
    "isPlatformAdmin" BOOLEAN NOT NULL DEFAULT false,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(3),
    "tokensValidAfter" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_tokens" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "purpose" "EmailTokenPurpose" NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "familyId" UUID NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "replacedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "slug" VARCHAR(40) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_settings" (
    "orgId" UUID NOT NULL,
    "cardHoldMinutes" INTEGER NOT NULL DEFAULT 15,
    "transferHoldHours" INTEGER NOT NULL DEFAULT 72,
    "transferEnabled" BOOLEAN NOT NULL DEFAULT true,
    "cancellationDeadlineHours" INTEGER NOT NULL DEFAULT 48,
    "selfCancellationEnabled" BOOLEAN NOT NULL DEFAULT true,
    "refundPercent" INTEGER NOT NULL DEFAULT 100,
    "serviceFeeRefundable" BOOLEAN NOT NULL DEFAULT false,
    "maxPerOrder" INTEGER NOT NULL DEFAULT 6,
    "maxPerUser" INTEGER NOT NULL DEFAULT 6,
    "waitlistOfferMinutes" INTEGER NOT NULL DEFAULT 120,
    "waitlistEnabled" BOOLEAN NOT NULL DEFAULT true,
    "serviceFeeFixedCents" INTEGER NOT NULL DEFAULT 0,
    "serviceFeeBasisPoints" INTEGER NOT NULL DEFAULT 0,
    "defaultTimezone" VARCHAR(64) NOT NULL DEFAULT 'Europe/Paris',
    "contactEmail" VARCHAR(254),
    "bankBeneficiary" VARCHAR(70),
    "bankIbanEncrypted" TEXT,
    "bankIbanMasked" VARCHAR(40),
    "bankBic" VARCHAR(11),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organization_settings_pkey" PRIMARY KEY ("orgId")
);

-- CreateTable
CREATE TABLE "events" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "title" VARCHAR(150) NOT NULL,
    "description" VARCHAR(5000),
    "venue" VARCHAR(150),
    "address" VARCHAR(300),
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "timezone" VARCHAR(64) NOT NULL,
    "status" "EventStatus" NOT NULL DEFAULT 'DRAFT',
    "salesStartAt" TIMESTAMPTZ(3) NOT NULL,
    "salesEndAt" TIMESTAMPTZ(3) NOT NULL,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" VARCHAR(500),
    "cardHoldMinutes" INTEGER,
    "transferHoldHours" INTEGER,
    "transferEnabled" BOOLEAN,
    "cancellationDeadlineHours" INTEGER,
    "selfCancellationEnabled" BOOLEAN,
    "refundPercent" INTEGER,
    "maxPerOrder" INTEGER,
    "maxPerUser" INTEGER,
    "waitlistOfferMinutes" INTEGER,
    "waitlistEnabled" BOOLEAN,
    "serviceFeeFixedCents" INTEGER,
    "serviceFeeBasisPoints" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_types" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "description" VARCHAR(1000),
    "capacity" INTEGER NOT NULL,
    "sold" INTEGER NOT NULL DEFAULT 0,
    "held" INTEGER NOT NULL DEFAULT 0,
    "priceCents" INTEGER NOT NULL,
    "earlyPriceCents" INTEGER,
    "earlyUntil" TIMESTAMPTZ(3),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ticket_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "status" "OrderStatus" NOT NULL,
    "paymentMethod" "PaymentMethod" NOT NULL,
    "idempotencyKey" UUID NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'EUR',
    "subtotalCents" INTEGER NOT NULL,
    "serviceFeeCents" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "refundPercent" INTEGER NOT NULL,
    "serviceFeeRefundable" BOOLEAN NOT NULL,
    "cancellableUntil" TIMESTAMPTZ(3),
    "refundAmountCents" INTEGER,
    "expiresAt" TIMESTAMPTZ(3),
    "paidAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "transferReference" VARCHAR(20),
    "transferBeneficiary" VARCHAR(70),
    "transferIbanEncrypted" TEXT,
    "transferIbanMasked" VARCHAR(40),
    "transferBic" VARCHAR(11),
    "pspSessionId" VARCHAR(100),
    "waitlistEntryId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "ticketTypeId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceCents" INTEGER NOT NULL,
    "refundedCents" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "providerPaymentId" VARCHAR(100) NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "PaymentStatus" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "reason" VARCHAR(40) NOT NULL,
    "providerRefundId" VARCHAR(100),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" VARCHAR(500),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "providerEventId" VARCHAR(100) NOT NULL,
    "type" VARCHAR(50) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tickets" (
    "id" UUID NOT NULL,
    "orderItemId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "eventId" UUID NOT NULL,
    "publicId" CHAR(22) NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'VALID',
    "usedAt" TIMESTAMPTZ(3),
    "usedByUserId" UUID,
    "usedDeviceId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "check_ins" (
    "id" UUID NOT NULL,
    "scanId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "ticketId" UUID,
    "scannerId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "scannedAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "result" "CheckInResult" NOT NULL,
    "offline" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "check_ins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "waitlist_entries" (
    "id" UUID NOT NULL,
    "ticketTypeId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" "WaitlistStatus" NOT NULL DEFAULT 'WAITING',
    "offeredAt" TIMESTAMPTZ(3),
    "offerExpiresAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "waitlist_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_outbox" (
    "id" UUID NOT NULL,
    "to" VARCHAR(254) NOT NULL,
    "template" VARCHAR(50) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" VARCHAR(500),
    "sentAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "orgId" UUID,
    "actorId" UUID,
    "action" VARCHAR(60) NOT NULL,
    "target" VARCHAR(200) NOT NULL,
    "meta" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "email_tokens_tokenHash_key" ON "email_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "email_tokens_userId_purpose_idx" ON "email_tokens"("userId", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_familyId_idx" ON "refresh_tokens"("familyId");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "memberships_orgId_role_idx" ON "memberships"("orgId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_userId_orgId_key" ON "memberships"("userId", "orgId");

-- CreateIndex
CREATE INDEX "events_orgId_startsAt_idx" ON "events"("orgId", "startsAt");

-- CreateIndex
CREATE INDEX "events_status_startsAt_idx" ON "events"("status", "startsAt");

-- CreateIndex
CREATE INDEX "ticket_types_eventId_sortOrder_idx" ON "ticket_types"("eventId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "orders_transferReference_key" ON "orders"("transferReference");

-- CreateIndex
CREATE UNIQUE INDEX "orders_waitlistEntryId_key" ON "orders"("waitlistEntryId");

-- CreateIndex
CREATE INDEX "orders_status_expiresAt_idx" ON "orders"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "orders_eventId_status_idx" ON "orders"("eventId", "status");

-- CreateIndex
CREATE INDEX "orders_userId_eventId_status_idx" ON "orders"("userId", "eventId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "orders_userId_idempotencyKey_key" ON "orders"("userId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "order_items_ticketTypeId_idx" ON "order_items"("ticketTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "order_items_orderId_ticketTypeId_key" ON "order_items"("orderId", "ticketTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_providerPaymentId_key" ON "payments"("providerPaymentId");

-- CreateIndex
CREATE INDEX "payments_orderId_idx" ON "payments"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_providerRefundId_key" ON "refunds"("providerRefundId");

-- CreateIndex
CREATE INDEX "refunds_status_nextAttemptAt_idx" ON "refunds"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_providerEventId_key" ON "webhook_events"("providerEventId");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_publicId_key" ON "tickets"("publicId");

-- CreateIndex
CREATE INDEX "tickets_eventId_status_idx" ON "tickets"("eventId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_orderItemId_seq_key" ON "tickets"("orderItemId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "check_ins_scanId_key" ON "check_ins"("scanId");

-- CreateIndex
CREATE INDEX "check_ins_eventId_scannedAt_idx" ON "check_ins"("eventId", "scannedAt");

-- CreateIndex
CREATE INDEX "check_ins_ticketId_idx" ON "check_ins"("ticketId");

-- CreateIndex
CREATE INDEX "waitlist_entries_ticketTypeId_status_createdAt_id_idx" ON "waitlist_entries"("ticketTypeId", "status", "createdAt", "id");

-- CreateIndex
CREATE INDEX "waitlist_entries_status_offerExpiresAt_idx" ON "waitlist_entries"("status", "offerExpiresAt");

-- CreateIndex
CREATE INDEX "waitlist_entries_userId_idx" ON "waitlist_entries"("userId");

-- CreateIndex
CREATE INDEX "email_outbox_status_nextAttemptAt_idx" ON "email_outbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "audit_logs_orgId_createdAt_idx" ON "audit_logs"("orgId", "createdAt");

-- AddForeignKey
ALTER TABLE "email_tokens" ADD CONSTRAINT "email_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_types" ADD CONSTRAINT "ticket_types_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_waitlistEntryId_fkey" FOREIGN KEY ("waitlistEntryId") REFERENCES "waitlist_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_ticketTypeId_fkey" FOREIGN KEY ("ticketTypeId") REFERENCES "ticket_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_scannerId_fkey" FOREIGN KEY ("scannerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_ticketTypeId_fkey" FOREIGN KEY ("ticketTypeId") REFERENCES "ticket_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Contraintes métier ajoutées à la main (non exprimables dans le schéma Prisma).
-- Elles sont le filet de sécurité ultime : même un bug applicatif ne peut pas
-- produire de survente, de montant négatif ni de double entrée active en liste d'attente.
-- ---------------------------------------------------------------------------

-- Zéro survente : la somme vendue + bloquée ne dépasse jamais la capacité.
ALTER TABLE "ticket_types"
  ADD CONSTRAINT "ticket_types_stock_check"
    CHECK ("sold" >= 0 AND "held" >= 0 AND "capacity" > 0 AND "sold" + "held" <= "capacity"),
  ADD CONSTRAINT "ticket_types_price_check"
    CHECK ("priceCents" >= 0),
  ADD CONSTRAINT "ticket_types_early_check"
    CHECK (
      ("earlyPriceCents" IS NULL AND "earlyUntil" IS NULL)
      OR ("earlyPriceCents" IS NOT NULL AND "earlyUntil" IS NOT NULL
          AND "earlyPriceCents" >= 0 AND "earlyPriceCents" < "priceCents")
    );

ALTER TABLE "events"
  ADD CONSTRAINT "events_dates_check"
    CHECK ("endsAt" > "startsAt" AND "salesEndAt" > "salesStartAt" AND "salesEndAt" <= "endsAt");

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_amounts_check"
    CHECK (
      "subtotalCents" >= 0 AND "serviceFeeCents" >= 0
      AND "totalCents" = "subtotalCents" + "serviceFeeCents"
      AND "refundPercent" BETWEEN 0 AND 100
      AND ("refundAmountCents" IS NULL OR ("refundAmountCents" >= 0 AND "refundAmountCents" <= "totalCents"))
    ),
  ADD CONSTRAINT "orders_currency_check" CHECK ("currency" = 'EUR');

ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_amounts_check"
    CHECK ("quantity" > 0 AND "unitPriceCents" >= 0
           AND "refundedCents" >= 0 AND "refundedCents" <= "unitPriceCents" * "quantity");

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amount_check" CHECK ("amountCents" >= 0);

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_amount_check" CHECK ("amountCents" > 0);

ALTER TABLE "tickets"
  ADD CONSTRAINT "tickets_seq_check" CHECK ("seq" >= 1),
  ADD CONSTRAINT "tickets_used_check" CHECK (("status" = 'USED') = ("usedAt" IS NOT NULL));

ALTER TABLE "waitlist_entries"
  ADD CONSTRAINT "waitlist_entries_quantity_check" CHECK ("quantity" > 0),
  ADD CONSTRAINT "waitlist_entries_offer_check"
    CHECK ("status" <> 'OFFERED' OR ("offeredAt" IS NOT NULL AND "offerExpiresAt" IS NOT NULL));

-- Une seule entrée active (en attente ou avec offre) par acheteur et par type de place.
CREATE UNIQUE INDEX "waitlist_entries_active_unique"
  ON "waitlist_entries" ("userId", "ticketTypeId")
  WHERE "status" IN ('WAITING', 'OFFERED');

ALTER TABLE "organization_settings"
  ADD CONSTRAINT "organization_settings_bounds_check"
    CHECK (
      "cardHoldMinutes" BETWEEN 5 AND 60
      AND "transferHoldHours" BETWEEN 1 AND 240
      AND "cancellationDeadlineHours" BETWEEN 0 AND 720
      AND "refundPercent" BETWEEN 0 AND 100
      AND "maxPerOrder" BETWEEN 1 AND 20
      AND "maxPerUser" BETWEEN 1 AND 50
      AND "maxPerUser" >= "maxPerOrder"
      AND "waitlistOfferMinutes" BETWEEN 15 AND 2880
      AND "serviceFeeFixedCents" BETWEEN 0 AND 1000
      AND "serviceFeeBasisPoints" BETWEEN 0 AND 1500
    );

ALTER TABLE "events"
  ADD CONSTRAINT "events_overrides_bounds_check"
    CHECK (
      ("cardHoldMinutes" IS NULL OR "cardHoldMinutes" BETWEEN 5 AND 60)
      AND ("transferHoldHours" IS NULL OR "transferHoldHours" BETWEEN 1 AND 240)
      AND ("cancellationDeadlineHours" IS NULL OR "cancellationDeadlineHours" BETWEEN 0 AND 720)
      AND ("refundPercent" IS NULL OR "refundPercent" BETWEEN 0 AND 100)
      AND ("maxPerOrder" IS NULL OR "maxPerOrder" BETWEEN 1 AND 20)
      AND ("maxPerUser" IS NULL OR "maxPerUser" BETWEEN 1 AND 50)
      AND ("waitlistOfferMinutes" IS NULL OR "waitlistOfferMinutes" BETWEEN 15 AND 2880)
      AND ("serviceFeeFixedCents" IS NULL OR "serviceFeeFixedCents" BETWEEN 0 AND 1000)
      AND ("serviceFeeBasisPoints" IS NULL OR "serviceFeeBasisPoints" BETWEEN 0 AND 1500)
    );
