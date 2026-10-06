-- AlterEnum
ALTER TYPE "RefundStatus" ADD VALUE 'MANUAL_REQUIRED';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "pspSessionUrl" VARCHAR(500);

