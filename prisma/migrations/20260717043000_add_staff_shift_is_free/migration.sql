ALTER TABLE "staff_shift_availabilities"
ADD COLUMN "isFree" BOOLEAN NOT NULL DEFAULT false;

UPDATE "staff_shift_availabilities"
SET "isFree" = true
WHERE "status" = 'AVAILABLE'
  AND "startTime" IS NULL
  AND "endTime" IS NULL;

ALTER TABLE "staff_shift_assignments"
ADD COLUMN "isFree" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "staff_shift_assignments"
ALTER COLUMN "startTime" DROP NOT NULL,
ALTER COLUMN "endTime" DROP NOT NULL;
