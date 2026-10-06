-- CreateTable
CREATE TABLE "psp_sessions" (
    "id" VARCHAR(100) NOT NULL,
    "orderId" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "psp_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "psp_sessions_orderId_idx" ON "psp_sessions"("orderId");

-- AddForeignKey
ALTER TABLE "psp_sessions" ADD CONSTRAINT "psp_sessions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Rattrapage : sessions déjà connues des commandes existantes.
INSERT INTO "psp_sessions" ("id", "orderId", "attempt", "expiresAt", "createdAt")
SELECT "pspSessionId", "id", "checkoutAttempt", COALESCE("expiresAt", now()), "updatedAt" FROM "orders" WHERE "pspSessionId" IS NOT NULL
ON CONFLICT DO NOTHING;
