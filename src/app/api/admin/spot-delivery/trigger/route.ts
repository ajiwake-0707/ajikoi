import { revalidatePath } from "next/cache";
import { findDeliveryDraftForSubmit } from "@/lib/delivery-draft-api";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import { adminAuth } from "@/lib/admin-auth";
import { inngest } from "@/lib/inngest/client";
import { prisma } from "@/lib/prisma";

const triggerPayloadSchema = z.object({
    draftId: z.string().min(1).optional(),
  title: z.string().trim().max(120, "タイトルは120文字以内です。").optional().default(""),
  notificationText: z.string().trim().max(1000, "通知テキストは1000文字以内です。").optional().default(""),
  messages: z
    .array(
      z.union([
        z.object({
          type: z.literal("text"),
          text: z.string().trim().min(1).max(1000),
        }),
        z.object({
          type: z.literal("image"),
          originalContentUrl: z.string().url(),
          previewImageUrl: z.string().url(),
        }),
        z.object({
          type: z.literal("flex"),
          altText: z.string().trim().min(1).max(400),
          contents: z.record(z.string(), z.unknown()),
        }),
      ]),
    )
    .min(1, "配信メッセージを1つ以上追加してください。"),
  targetFilters: z
    .object({
      rankIds: z.array(z.string().min(1)).optional().default([]),
      gender: z.enum(["male", "female", "other"]).nullable().optional().default(null),
      visitCountSegments: z
        .array(z.enum(["ZERO", "ONE", "TWO_TO_FOUR", "FIVE_TO_NINE", "TEN_OR_MORE"]))
        .optional()
        .default([]),
    })
    .optional()
    .default({
      rankIds: [],
      gender: null,
      visitCountSegments: [],
    }),
});

export async function POST(request: Request) {
  try {
    const session = await adminAuth.api.getSession({
      headers: request.headers,
    });
    const adminId = session?.user?.username;
    if (!adminId) {
      return Response.json({ ok: false, message: "管理者ログインが必要です。" }, { status: 401 });
    }

    const adminUser = await prisma.adminUser.findUnique({
      where: { id: adminId },
      select: { id: true, officialAccountId: true },
    });
    if (!adminUser) {
      return Response.json({ ok: false, message: "管理者権限がありません。" }, { status: 403 });
    }

    const parsed = triggerPayloadSchema.safeParse(await request.json());
    if (!parsed.success) {
      return Response.json(
        { ok: false, message: parsed.error.issues[0]?.message ?? "入力内容が不正です。" },
        { status: 400 },
      );
    }


    if (parsed.data.draftId && !await findDeliveryDraftForSubmit(parsed.data.draftId, adminUser, "SPOT")) {
      return Response.json({ ok: false, message: "下書きが見つかりません。一覧から開き直してください。" }, { status: 404 });
    }
    const { title, notificationText, messages, targetFilters } = parsed.data;

    const users = await prisma.user.findMany({
      where: {
        ...(adminUser.officialAccountId ? { officialAccountId: adminUser.officialAccountId } : {}),
        ...(targetFilters.rankIds.length > 0 ? { nextRank: { in: targetFilters.rankIds } } : {}),
        ...(targetFilters.gender ? { survey: { is: { gender: targetFilters.gender } } } : {}),
      },
      select: {
        userId: true,
      },
      take: 10000,
    });
    let targetUserIds = users.map((row) => row.userId);

    if (targetFilters.visitCountSegments.length > 0 && targetUserIds.length > 0) {
      const checkInRows = await prisma.$queryRaw<Array<{ userId: string; checkInCount: number }>>`
        SELECT u."userId" AS "userId", COUNT(c."id")::int AS "checkInCount"
        FROM "users" u
        LEFT JOIN "user_checkins" c ON c."userId" = u."userId"
        WHERE u."userId" IN (${Prisma.join(targetUserIds)})
        GROUP BY u."userId"
      `;
      const resolveVisitCountSegment = (count: number) => {
        if (count <= 0) return "ZERO";
        if (count === 1) return "ONE";
        if (count <= 4) return "TWO_TO_FOUR";
        if (count <= 9) return "FIVE_TO_NINE";
        return "TEN_OR_MORE";
      };
      const allowedIds = new Set(
        checkInRows
          .filter((row) => targetFilters.visitCountSegments.includes(resolveVisitCountSegment(row.checkInCount)))
          .map((row) => row.userId),
      );
      targetUserIds = targetUserIds.filter((userId) => allowedIds.has(userId));
    }

    if (targetUserIds.length === 0) {
      return Response.json({ ok: false, message: "条件に一致する配信対象がいません。" }, { status: 400 });
    }

    await inngest.send({
      name: "line/delivery.triggered",
      data: {
        title,
        notificationText,
        messages,
        officialAccountId: adminUser.officialAccountId ?? null,
        targetUserIds,
        triggeredBy: adminUser.id,
      },
    });

    // The job was already accepted: cleanup errors must not invite a duplicate send.
    if (parsed.data.draftId) {
      await prisma.lineDeliveryDraft.deleteMany({ where: { id: parsed.data.draftId } }).catch((error) => {
        console.error("accepted delivery draft cleanup failed", error);
      });
    }
    revalidatePath("/admin/spot-delivery");
    return Response.json({ ok: true, message: "トリガー配信を受け付けました。" });
  } catch (error) {
    console.error("/api/admin/spot-delivery/trigger POST error", error);
    return Response.json(
      { ok: false, message: "トリガー配信に失敗しました。" },
      { status: 500 },
    );
  }
}
