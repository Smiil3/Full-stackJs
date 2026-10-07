-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "pendingRescheduleId" UUID;

-- CreateTable
CREATE TABLE "event_reschedules" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "oldStartsAt" TIMESTAMPTZ(3) NOT NULL,
    "oldEndsAt" TIMESTAMPTZ(3) NOT NULL,
    "newStartsAt" TIMESTAMPTZ(3) NOT NULL,
    "newEndsAt" TIMESTAMPTZ(3) NOT NULL,
    "oldTimezone" VARCHAR(64) NOT NULL,
    "newTimezone" VARCHAR(64) NOT NULL,
    "fallbackDeadlineHours" INTEGER NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "event_reschedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reschedule_notifications" (
    "rescheduleId" UUID NOT NULL,
    "userId" UUID NOT NULL,

    CONSTRAINT "reschedule_notifications_pkey" PRIMARY KEY ("rescheduleId","userId")
);

-- CreateIndex
CREATE INDEX "event_reschedules_eventId_completedAt_idx" ON "event_reschedules"("eventId", "completedAt");

-- AddForeignKey
ALTER TABLE "event_reschedules" ADD CONSTRAINT "event_reschedules_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reschedule_notifications" ADD CONSTRAINT "reschedule_notifications_rescheduleId_fkey" FOREIGN KEY ("rescheduleId") REFERENCES "event_reschedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Commandes restant à traiter pour un report (index partiel : quasi toujours vide).
CREATE INDEX "orders_pendingRescheduleId_idx" ON "orders"("pendingRescheduleId") WHERE "pendingRescheduleId" IS NOT NULL;
