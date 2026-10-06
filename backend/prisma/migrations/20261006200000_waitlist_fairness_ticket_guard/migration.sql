-- AlterTable
ALTER TABLE "waitlist_entries" ADD COLUMN     "accumulatingUntil" TIMESTAMPTZ(3),
ADD COLUMN     "accumulationSkipped" BOOLEAN NOT NULL DEFAULT false;


-- Rattrapage : billets encore VALIDES de commandes déjà closes (avant le déclencheur d'annulation).
UPDATE "tickets" t SET "status" = 'CANCELLED'
FROM "order_items" oi JOIN "orders" o ON o."id" = oi."orderId"
WHERE t."orderItemId" = oi."id" AND t."status" = 'VALID' AND o."status" IN ('CANCELLED', 'REFUNDED', 'EXPIRED');

-- Un billet ne peut être émis que pour une commande PAYÉE.
CREATE FUNCTION "tickets_require_paid_order"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "order_items" oi JOIN "orders" o ON o."id" = oi."orderId"
    WHERE oi."id" = NEW."orderItemId" AND o."status" = 'PAID'
  ) THEN
    RAISE EXCEPTION 'ticket_requires_paid_order' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "tickets_require_paid_order_trg"
  BEFORE INSERT ON "tickets"
  FOR EACH ROW EXECUTE FUNCTION "tickets_require_paid_order"();
