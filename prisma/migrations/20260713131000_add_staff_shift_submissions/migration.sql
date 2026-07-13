-- CreateEnum
CREATE TYPE "StaffShiftAvailabilityStatus" AS ENUM ('UNSET', 'AVAILABLE', 'UNAVAILABLE');

-- CreateTable
CREATE TABLE "staff_shift_submissions" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "officialAccountId" TEXT NOT NULL,
  "month" TEXT NOT NULL,
  "submittedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "staff_shift_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_shift_availabilities" (
  "id" TEXT NOT NULL,
  "submissionId" TEXT NOT NULL,
  "day" INTEGER NOT NULL,
  "status" "StaffShiftAvailabilityStatus" NOT NULL DEFAULT 'UNSET',
  "startTime" TEXT,
  "endTime" TEXT,
  "memo" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "staff_shift_availabilities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "staff_shift_submissions_userId_officialAccountId_month_key"
ON "staff_shift_submissions"("userId", "officialAccountId", "month");

-- CreateIndex
CREATE INDEX "staff_shift_submissions_officialAccountId_month_idx"
ON "staff_shift_submissions"("officialAccountId", "month");

-- CreateIndex
CREATE INDEX "staff_shift_submissions_userId_month_idx"
ON "staff_shift_submissions"("userId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "staff_shift_availabilities_submissionId_day_key"
ON "staff_shift_availabilities"("submissionId", "day");

-- CreateIndex
CREATE INDEX "staff_shift_availabilities_status_idx"
ON "staff_shift_availabilities"("status");

-- AddForeignKey
ALTER TABLE "staff_shift_submissions"
ADD CONSTRAINT "staff_shift_submissions_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_shift_submissions"
ADD CONSTRAINT "staff_shift_submissions_officialAccountId_fkey"
FOREIGN KEY ("officialAccountId") REFERENCES "official_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_shift_availabilities"
ADD CONSTRAINT "staff_shift_availabilities_submissionId_fkey"
FOREIGN KEY ("submissionId") REFERENCES "staff_shift_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
