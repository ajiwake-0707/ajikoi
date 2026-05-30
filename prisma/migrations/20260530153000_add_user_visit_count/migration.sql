-- AlterTable
ALTER TABLE "users" ADD COLUMN "visitCount" INTEGER NOT NULL DEFAULT 0;

-- Backfill from existing check-in records where available.
UPDATE "users" AS u
SET "visitCount" = c."count"
FROM (
  SELECT "userId", COUNT(*)::int AS "count"
  FROM "user_checkins"
  GROUP BY "userId"
) AS c
WHERE u."userId" = c."userId";
