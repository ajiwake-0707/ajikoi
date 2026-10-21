import { revalidatePath } from "next/cache";
import { findDeliveryDraftForSubmit } from "@/lib/delivery-draft-api";
import { DeliveryVisitCountSegment, LineDeliveryTriggerType, Prisma } from "@prisma/client";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { adminAuth } from "@/lib/admin-auth";
import { prisma } from "@/lib/prisma";

const triggerSettingSchema = z
  .object({
    draftId: z.string().min(1).optional(),
    title: z.string().trim().min(1, "タイトルを入力してください。"),
    triggerType: z.nativeEnum(LineDeliveryTriggerType),
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
    targetRankIds: z.array(z.string().min(1)).max(20).optional().default([]),
    targetGender: z.enum(["male", "female", "other"]).nullable().optional().default(null),
    targetVisitCountSegments: z.array(z.nativeEnum(DeliveryVisitCountSegment)).max(10).optional().default([]),
    delayDays: z.number().int().min(-365).max(365).optional().default(0),
    deliveryHourJst: z.number().int().min(0).max(23).nullable().optional().default(null),
    isActive: z.boolean().optional().default(true),
  })
  .superRefine((value, ctx) => {
    const canUseNegativeDelay =
      value.triggerType === LineDeliveryTriggerType.BIRTHDAY ||
      value.triggerType === LineDeliveryTriggerType.GIFT_EXPIRES;
    if (!canUseNegativeDelay && value.delayDays < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "負数の日数は誕生日/ギフト期限切れトリガーでのみ設定できます。",
        path: ["delayDays"],
      });
    }
  });

export async function POST(request: Request) {
  try {
    const session = await adminAuth.api.getSession({
      headers: await headers(),
    });
    const adminId = session?.user?.username;
    if (!adminId) {
      return NextResponse.json({ ok: false, message: "管理者ログインが必要です。" }, { status: 401 });
    }

    const adminUser = await prisma.adminUser.findUnique({
      where: { id: adminId },
      select: { id: true, officialAccountId: true },
    });
    if (!adminUser) {
      return NextResponse.json({ ok: false, message: "管理者情報が見つかりません。" }, { status: 403 });
    }

    const parsed = triggerSettingSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, message: parsed.error.issues[0]?.message ?? "入力内容が不正です。" },
        { status: 400 },
      );
    }

    if (parsed.data.draftId && !await findDeliveryDraftForSubmit(parsed.data.draftId, adminUser, "TRIGGER")) {
      return Response.json({ ok: false, message: "下書きが見つかりません。一覧から開き直してください。" }, { status: 404 });
    }
    await prisma.$transaction(async (tx) => {
      await tx.lineDeliveryTriggerSetting.create({
        data: {
          officialAccountId: adminUser.officialAccountId ?? null,
          title: parsed.data.title,
          triggerType: parsed.data.triggerType,
          notificationText: parsed.data.notificationText,
          messages: parsed.data.messages as Prisma.InputJsonValue,
          message:
            parsed.data.notificationText ||
            (parsed.data.messages.find((item) => item.type === "text")?.text ?? ""),
          targetRankIds: parsed.data.targetRankIds,
          targetGender: parsed.data.targetGender,
          targetVisitCountSegments: parsed.data.targetVisitCountSegments,
          delayDays: parsed.data.delayDays,
          deliveryHourJst: parsed.data.deliveryHourJst,
          isActive: parsed.data.isActive,
        },
      });

      if (parsed.data.draftId) {
        await tx.lineDeliveryDraft.delete({ where: { id: parsed.data.draftId } });
      }
    });

    revalidatePath("/admin/spot-delivery");
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("/api/admin/spot-delivery/triggers POST error", error);
    return NextResponse.json(
      { ok: false, message: "トリガー配信の作成に失敗しました。" },
      { status: 500 },
    );
  }
}
