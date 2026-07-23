CREATE TABLE "staff_shift_schedule_drafts" (
  "id" TEXT NOT NULL,
  "officialAccountId" TEXT NOT NULL,
  "month" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "staff_shift_schedule_drafts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "staff_shift_draft_assignments" (
  "id" TEXT NOT NULL,
  "draftId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "day" INTEGER NOT NULL,
  "startTime" TEXT,
  "endTime" TEXT,
  "isFree" BOOLEAN NOT NULL DEFAULT false,
  "memo" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "staff_shift_draft_assignments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "staff_shift_schedule_drafts_officialAccountId_month_key"
ON "staff_shift_schedule_drafts"("officialAccountId", "month");

CREATE INDEX "staff_shift_schedule_drafts_officialAccountId_month_idx"
ON "staff_shift_schedule_drafts"("officialAccountId", "month");

CREATE INDEX "staff_shift_draft_assignments_draftId_day_idx"
ON "staff_shift_draft_assignments"("draftId", "day");

CREATE INDEX "staff_shift_draft_assignments_userId_idx"
ON "staff_shift_draft_assignments"("userId");

ALTER TABLE "staff_shift_schedule_drafts"
ADD CONSTRAINT "staff_shift_schedule_drafts_officialAccountId_fkey"
FOREIGN KEY ("officialAccountId") REFERENCES "official_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "staff_shift_draft_assignments"
ADD CONSTRAINT "staff_shift_draft_assignments_draftId_fkey"
FOREIGN KEY ("draftId") REFERENCES "staff_shift_schedule_drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "staff_shift_draft_assignments"
ADD CONSTRAINT "staff_shift_draft_assignments_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;
