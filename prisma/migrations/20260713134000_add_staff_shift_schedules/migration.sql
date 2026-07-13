-- CreateTable
CREATE TABLE "staff_shift_schedules" (
  "id" TEXT NOT NULL,
  "officialAccountId" TEXT NOT NULL,
  "month" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "staff_shift_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_shift_assignments" (
  "id" TEXT NOT NULL,
  "scheduleId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "day" INTEGER NOT NULL,
  "startTime" TEXT NOT NULL,
  "endTime" TEXT NOT NULL,
  "memo" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "staff_shift_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "staff_shift_schedules_officialAccountId_month_key"
ON "staff_shift_schedules"("officialAccountId", "month");

-- CreateIndex
CREATE INDEX "staff_shift_schedules_officialAccountId_month_idx"
ON "staff_shift_schedules"("officialAccountId", "month");

-- CreateIndex
CREATE INDEX "staff_shift_assignments_scheduleId_day_idx"
ON "staff_shift_assignments"("scheduleId", "day");

-- CreateIndex
CREATE INDEX "staff_shift_assignments_userId_idx"
ON "staff_shift_assignments"("userId");

-- AddForeignKey
ALTER TABLE "staff_shift_schedules"
ADD CONSTRAINT "staff_shift_schedules_officialAccountId_fkey"
FOREIGN KEY ("officialAccountId") REFERENCES "official_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_shift_assignments"
ADD CONSTRAINT "staff_shift_assignments_scheduleId_fkey"
FOREIGN KEY ("scheduleId") REFERENCES "staff_shift_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_shift_assignments"
ADD CONSTRAINT "staff_shift_assignments_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("userId") ON DELETE CASCADE ON UPDATE CASCADE;
