-- CreateTable
CREATE TABLE "login_lockouts" (
    "userId" UUID NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "lastFailedAt" TIMESTAMPTZ(3),
    "lockedUntil" TIMESTAMPTZ(3),

    CONSTRAINT "login_lockouts_pkey" PRIMARY KEY ("userId","fingerprint")
);

-- CreateIndex
CREATE INDEX "login_lockouts_lastFailedAt_idx" ON "login_lockouts"("lastFailedAt");

-- AddForeignKey
ALTER TABLE "login_lockouts" ADD CONSTRAINT "login_lockouts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

