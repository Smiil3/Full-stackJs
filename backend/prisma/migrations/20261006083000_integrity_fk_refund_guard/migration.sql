-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_replacedById_key" ON "refresh_tokens"("replacedById");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_replacedById_fkey" FOREIGN KEY ("replacedById") REFERENCES "refresh_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_usedByUserId_fkey" FOREIGN KEY ("usedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Devise unique de la plateforme, aussi sur les paiements reçus du PSP.
ALTER TABLE "payments" ADD CONSTRAINT "payments_currency_check" CHECK ("currency" = 'EUR');

-- Garde « somme des remboursements non échoués ≤ montant du paiement ».
-- Le paiement est verrouillé (FOR UPDATE) : deux remboursements concurrents sont sérialisés,
-- le second voit le premier et échoue s'il fait dépasser le montant payé.
CREATE FUNCTION "refunds_within_payment"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  paid INTEGER;
  already INTEGER;
BEGIN
  SELECT "amountCents" INTO paid FROM "payments" WHERE "id" = NEW."paymentId" FOR UPDATE;
  SELECT COALESCE(SUM("amountCents"), 0) INTO already
    FROM "refunds"
    WHERE "paymentId" = NEW."paymentId" AND "status" <> 'FAILED' AND "id" <> NEW."id";
  IF NEW."status" <> 'FAILED' AND already + NEW."amountCents" > paid THEN
    RAISE EXCEPTION 'refund_exceeds_payment' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "refunds_within_payment_trg"
  BEFORE INSERT OR UPDATE OF "amountCents", "status", "paymentId" ON "refunds"
  FOR EACH ROW EXECUTE FUNCTION "refunds_within_payment"();
