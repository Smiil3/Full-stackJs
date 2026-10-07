-- Réglages créés avec chaque collectif : rattrapage des collectifs historiques sans réglages
-- (getSettings ne fait plus d'upsert sur les chemins de lecture — audit, section Info).
INSERT INTO "organization_settings" ("orgId", "updatedAt")
SELECT o."id", CURRENT_TIMESTAMP FROM "organizations" o
WHERE NOT EXISTS (SELECT 1 FROM "organization_settings" s WHERE s."orgId" = o."id");
