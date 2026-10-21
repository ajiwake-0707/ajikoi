import { inngest } from "@/lib/inngest/client";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const triggerLineDeliveryPayloadSchema = z.object({
  title: z.string().optional().default(""),
  notificationText: z.string().optional().default(""),
  messages: z
    .array(
      z.union([
        z.object({
          type: z.literal("text"),
          text: z.string().min(1),
        }),
        z.object({
          type: z.literal("image"),
          originalContentUrl: z.string().url(),
          previewImageUrl: z.string().url(),
        }),
        z.object({
          type: z.literal("flex"),
          altText: z.string().min(1),
          contents: z.record(z.string(), z.unknown()),
        }),
      ]),
    )
    .min(1),
  officialAccountId: z.string().nullable(),
  targetUserIds: z.array(z.string().min(1)).optional().default([]),
  scheduledAt: z.string().datetime().nullable().optional().default(null),
  triggeredBy: z.string().min(1),
});

const LINE_PUSH_API_URL = "https://api.line.me/v2/bot/message/push";

function chunkArray<T>(list: T[], chunkSize: number) {
  const chunks: T[][] = [];
  for (let i = 0; i < list.length; i += chunkSize) {
    chunks.push(list.slice(i, i + chunkSize));
  }
  return chunks;
}

type RecipientResult = {
  userId: string;
  displayName: string | null;
  attemptedAt: string;
  completedAt: string;
  status: "accepted" | "failed";
  httpStatus: number | null;
  requestId: string | null;
  error: string | null;
};

function createAggregationUnit() {
  return `spot_${Date.now().toString(36)}`;
}

export const triggerLineDelivery = inngest.createFunction(
  {
    id: "trigger-line-delivery",
    triggers: [{ event: "line/delivery.triggered" }],
  },
  async ({ event, step }) => {
    const { title, notificationText, messages, officialAccountId, targetUserIds, scheduledAt, triggeredBy } =
      triggerLineDeliveryPayloadSchema.parse((event as { data: unknown }).data);
    const aggregationUnit = createAggregationUnit();

    if (scheduledAt) {
      const scheduledDate = new Date(scheduledAt);
      if (!Number.isNaN(scheduledDate.getTime()) && scheduledDate.getTime() > Date.now()) {
        await step.sleepUntil("wait-until-scheduled-time", scheduledDate);
      }
    }

    const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
    if (!accessToken) {
      throw new Error("LINE_CHANNEL_ACCESS_TOKEN が未設定です。");
    }

    const recipients = await step.run("resolve-recipients", async () => {
      if (targetUserIds && targetUserIds.length > 0) {
        return prisma.user.findMany({
          where: {
            userId: { in: targetUserIds },
            ...(officialAccountId ? { officialAccountId } : {}),
          },
          select: { userId: true, displayName: true },
        });
      }
      return prisma.user.findMany({
        where: officialAccountId ? { officialAccountId } : undefined,
        select: { userId: true, displayName: true },
      });
    });

    const userIds = recipients.map((row) => row.userId);
    if (userIds.length === 0) {
      return { ok: true, sent: 0, failed: 0 };
    }

    const recipientResults: RecipientResult[] = [];
    for (const [index, chunk] of chunkArray(recipients, 50).entries()) {
      const results = await step.run(`send-line-push-results-${index}`, async () => {
        // Return JSON-safe outcomes so Inngest preserves individual failures on replay.
        return Promise.all(chunk.map(async (recipient): Promise<RecipientResult> => {
          const attemptedAt = new Date().toISOString();
          let httpStatus: number | null = null;
          let requestId: string | null = null;
          try {
            const response = await fetch(LINE_PUSH_API_URL, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${accessToken}`,
              },
              body: JSON.stringify({
                to: recipient.userId,
                messages,
                customAggregationUnits: [aggregationUnit],
              }),
            });
            httpStatus = response.status;
            requestId = response.headers.get("x-line-request-id");
            const error = response.ok ? null : (await response.text()).slice(0, 2000);
            return {
              userId: recipient.userId,
              displayName: recipient.displayName ?? null,
              attemptedAt,
              completedAt: new Date().toISOString(),
              status: response.ok ? "accepted" : "failed",
              httpStatus,
              requestId,
              error,
            };
          } catch (error) {
            return {
              userId: recipient.userId,
              displayName: recipient.displayName ?? null,
              attemptedAt,
              completedAt: new Date().toISOString(),
              status: "failed",
              httpStatus,
              requestId,
              error: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
            };
          }
        }));
      });
      recipientResults.push(...results);
    }
    const sent = recipientResults.filter((result) => result.status === "accepted").length;
    const failed = recipientResults.length - sent;

    await step.run("insert-history", async () => {
      await prisma.$executeRaw`
        INSERT INTO "user_history"
          ("id", "targetUserId", "actorType", "actorId", "action", "metadata", "officialAccountId", "createdAt")
        VALUES
          (
            md5(random()::text || clock_timestamp()::text),
            ${userIds[0]},
            'admin',
            ${triggeredBy},
            'line_trigger_delivery_executed',
            ${JSON.stringify({
              title,
              notificationText,
              message: notificationText || (messages.find((m) => m.type === "text")?.text ?? ""),
              messages,
              sent,
              failed,
              aggregationUnit,
              recipientResultsVersion: 1,
              recipientResults,
            })}::jsonb,
            ${officialAccountId},
            NOW()
          )
      `;
    });

    return { ok: true, sent, failed };
  },
);
