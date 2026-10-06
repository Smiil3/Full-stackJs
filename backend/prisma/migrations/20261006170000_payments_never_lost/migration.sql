-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "checkoutAttempt" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "payments" ALTER COLUMN "orderId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "refunds" ADD COLUMN     "note" VARCHAR(500),
ALTER COLUMN "orderId" DROP NOT NULL;


-- Un paiement authentifié dans une autre devise doit pouvoir être enregistré (puis remboursé) :
-- devise libre au format ISO 4217 plutôt que strictement EUR.
ALTER TABLE "payments" DROP CONSTRAINT "payments_currency_check";
ALTER TABLE "payments" ADD CONSTRAINT "payments_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');
