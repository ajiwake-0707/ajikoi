import { deliveryDraftScope } from "@/lib/delivery-draft";
import { Prisma } from "@prisma/client";

import { requireAdminUser } from "@/lib/admin-guard";
import { prisma } from "@/lib/prisma";

import SpotDeliveryClient from "./spot-delivery-client";

type DeliveryHistoryRow = {
  id: string;
  title: string;
  sentAt: string;
  sent: number;
  failed: number;
};

const MONTHLY_LINE_DELIVERY_LIMIT = 200;

function getStartOfCurrentMonthInJstUtc() {
  const jstOffsetMs = 9 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const jstNow = new Date(nowMs + jstOffsetMs);
  const startOfMonthInJstMs =
    Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), 1) - jstOffsetMs;
  return new Date(startOfMonthInJstMs);
}

function getStartOfNextMonthInJstUtc() {
  const jstOffsetMs = 9 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const jstNow = new Date(nowMs + jstOffsetMs);
  const startOfNextMonthInJstMs =
    Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth() + 1, 1) - jstOffsetMs;
  return new Date(startOfNextMonthInJstMs);
}

export default async function AdminSpotDeliveryPage() {
  const adminUser = await requireAdminUser();
  const [histories, triggerSettings, monthlyUsageRows, drafts] = await Promise.all([
    prisma.userHistory.findMany({
      where: {
        action: "line_trigger_delivery_executed",
        actorType: "admin",
        actorId: {
          not: {
            startsWith: "system:",
          },
        },
        ...(adminUser.officialAccountId ? { officialAccountId: adminUser.officialAccountId } : {}),
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        createdAt: true,
        metadata: true,
      },
      take: 50,
    }),
    prisma.lineDeliveryTriggerSetting.findMany({
      where: adminUser.officialAccountId ? { officialAccountId: adminUser.officialAccountId } : undefined,
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        title: true,
        triggerType: true,
        notificationText: true,
        messages: true,
        message: true,
        targetRankIds: true,
        targetGender: true,
        targetVisitCountSegments: true,
        delayDays: true,
        deliveryHourJst: true,
        isActive: true,
        updatedAt: true,
      },
      take: 100,
    }),
    prisma.$queryRaw<Array<{ used: number }>>`
      SELECT
        COALESCE(SUM(
          COALESCE((metadata->>'sent')::int, 0) +
          COALESCE((metadata->>'failed')::int, 0)
        ), 0)::int AS "used"
      FROM "user_history"
      WHERE "action" = 'line_trigger_delivery_executed'
        AND "createdAt" >= ${getStartOfCurrentMonthInJstUtc()}
        AND "createdAt" < ${getStartOfNextMonthInJstUtc()}
        ${adminUser.officialAccountId
          ? Prisma.sql`AND "officialAccountId" = ${adminUser.officialAccountId}`
          : Prisma.empty}
    `,
    prisma.lineDeliveryDraft.findMany({
      where: deliveryDraftScope(adminUser),
      orderBy: { updatedAt: "desc" },
      select: { id: true, kind: true, title: true, triggerId: true, updatedAt: true },
    }),
  ]);
  const usedThisMonth = monthlyUsageRows[0]?.used ?? 0;
  const remainingThisMonth = Math.max(MONTHLY_LINE_DELIVERY_LIMIT - usedThisMonth, 0);

  const deliveryHistory: DeliveryHistoryRow[] = histories.map((row) => {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    const metadataTitle = typeof metadata.title === "string" ? metadata.title : "";
    const metadataMessage = typeof metadata.message === "string" ? metadata.message : "";
    const title = metadataTitle.trim() || metadataMessage.trim() || "タイトル未設定";
    const sent = typeof metadata.sent === "number" ? metadata.sent : 0;
    const failed = typeof metadata.failed === "number" ? metadata.failed : 0;
    return {
      id: row.id,
      title,
      sentAt: row.createdAt.toISOString(),
      sent,
      failed,
    };
  });

  return (
    <SpotDeliveryClient
      drafts={drafts.map((draft) => ({ ...draft, updatedAt: draft.updatedAt.toISOString() }))}
      deliveryHistory={deliveryHistory}
      monthlyLimit={MONTHLY_LINE_DELIVERY_LIMIT}
      monthlyUsed={usedThisMonth}
      monthlyRemaining={remainingThisMonth}
      triggerSettings={triggerSettings.map((row) => ({
        id: row.id,
        title: row.title,
        triggerType: row.triggerType,
        notificationText: row.notificationText,
        messages: row.messages,
        message: row.message,
        targetRankIds: row.targetRankIds,
        targetGender: row.targetGender,
        targetVisitCountSegments: row.targetVisitCountSegments,
        delayDays: row.delayDays,
        deliveryHourJst: row.deliveryHourJst,
        isActive: row.isActive,
        updatedAt: row.updatedAt.toISOString(),
      }))}
    />
  );
}
