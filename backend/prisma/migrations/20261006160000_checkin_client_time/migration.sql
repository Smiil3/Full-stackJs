-- AlterTable
ALTER TABLE "check_ins" ADD COLUMN     "clientScannedAt" TIMESTAMPTZ(3),
ADD COLUMN     "scannedAtClamped" BOOLEAN NOT NULL DEFAULT false;

