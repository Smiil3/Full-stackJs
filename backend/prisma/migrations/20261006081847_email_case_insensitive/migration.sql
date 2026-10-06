-- Unicité de l'email insensible à la casse (A@x.com et a@x.com = un seul compte).
-- L'application normalise déjà (trim + NFC + minuscules) ; cet index est le filet de sécurité en base.
CREATE UNIQUE INDEX "users_email_lower_key" ON "users" (lower("email"));

-- Toute adresse stockée doit déjà être normalisée.
ALTER TABLE "users" ADD CONSTRAINT "users_email_normalized_check" CHECK ("email" = lower(btrim("email")));
