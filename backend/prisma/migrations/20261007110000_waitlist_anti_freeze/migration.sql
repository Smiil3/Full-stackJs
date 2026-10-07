-- AlterTable
ALTER TABLE "waitlist_entries" ADD COLUMN     "offerExpired" BOOLEAN NOT NULL DEFAULT false;


-- Anti-gel (contrat 1.17 §6) : durée d'une offre bornée à 360 min ; valeurs existantes ramenées dans la borne.
UPDATE "organization_settings" SET "waitlistOfferMinutes" = 360 WHERE "waitlistOfferMinutes" > 360;
UPDATE "events" SET "waitlistOfferMinutes" = 360 WHERE "waitlistOfferMinutes" > 360;
