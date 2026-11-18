-- AlterTable
ALTER TABLE "users" ADD COLUMN     "failureWindowStartAt" TIMESTAMPTZ(3),
ADD COLUMN     "lockNoticeSentAt" TIMESTAMPTZ(3);

