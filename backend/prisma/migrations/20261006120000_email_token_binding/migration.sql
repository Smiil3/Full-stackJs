-- Lie chaque jeton mail à l'adresse à laquelle il a été envoyé (rétro-remplissage depuis le compte).
ALTER TABLE "email_tokens" ADD COLUMN "email" VARCHAR(254);
UPDATE "email_tokens" t SET "email" = u."email" FROM "users" u WHERE u."id" = t."userId";
ALTER TABLE "email_tokens" ALTER COLUMN "email" SET NOT NULL;

-- CreateIndex
CREATE INDEX "email_tokens_userId_createdAt_idx" ON "email_tokens"("userId", "createdAt");
