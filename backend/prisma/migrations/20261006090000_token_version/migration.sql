-- AlterTable
ALTER TABLE "users" DROP COLUMN "tokensValidAfter",
ADD COLUMN     "tokenVersion" INTEGER NOT NULL DEFAULT 0;

