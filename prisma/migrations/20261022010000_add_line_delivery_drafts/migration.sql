-- CreateEnum
CREATE TYPE "LineDeliveryDraftKind" AS ENUM ('SPOT', 'TRIGGER');

-- CreateTable
CREATE TABLE "line_delivery_drafts" (
    "id" TEXT NOT NULL,
    "kind" "LineDeliveryDraftKind" NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "payload" JSONB NOT NULL,
    "ownerId" TEXT NOT NULL,
    "officialAccountId" TEXT,
    "triggerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "line_delivery_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "line_delivery_drafts_officialAccountId_updatedAt_idx" ON "line_delivery_drafts"("officialAccountId", "updatedAt");

-- CreateIndex
CREATE INDEX "line_delivery_drafts_ownerId_updatedAt_idx" ON "line_delivery_drafts"("ownerId", "updatedAt");

-- CreateIndex
CREATE INDEX "line_delivery_drafts_triggerId_idx" ON "line_delivery_drafts"("triggerId");

-- AddForeignKey
ALTER TABLE "line_delivery_drafts" ADD CONSTRAINT "line_delivery_drafts_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "admin_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "line_delivery_drafts" ADD CONSTRAINT "line_delivery_drafts_officialAccountId_fkey" FOREIGN KEY ("officialAccountId") REFERENCES "official_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "line_delivery_drafts" ADD CONSTRAINT "line_delivery_drafts_triggerId_fkey" FOREIGN KEY ("triggerId") REFERENCES "line_delivery_trigger_settings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

