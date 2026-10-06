-- Filet de sécurité en base : tout billet encore VALIDE d'une commande annulée, remboursée ou expirée
-- devient CANCELLED (les billets déjà USED restent USED). Le code applicatif le fait déjà dans la même
-- transaction ; ce déclencheur couvre tout chemin futur qui l'oublierait.
CREATE FUNCTION "cancel_tickets_of_closed_order"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "tickets" SET "status" = 'CANCELLED'
  WHERE "status" = 'VALID'
    AND "orderItemId" IN (SELECT "id" FROM "order_items" WHERE "orderId" = NEW."id");
  RETURN NULL;
END;
$$;

CREATE TRIGGER "cancel_tickets_of_closed_order_trg"
  AFTER UPDATE OF "status" ON "orders"
  FOR EACH ROW
  WHEN (NEW."status" IN ('CANCELLED', 'REFUNDED', 'EXPIRED') AND OLD."status" IS DISTINCT FROM NEW."status")
  EXECUTE FUNCTION "cancel_tickets_of_closed_order"();
