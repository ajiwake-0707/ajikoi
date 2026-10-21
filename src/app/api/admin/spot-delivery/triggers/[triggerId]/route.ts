import { revalidatePath } from "next/cache";
import { findDeliveryDraftForSubmit } from "@/lib/delivery-draft-api";
import { DeliveryVisitCountSegment, LineDeliveryTriggerType, Prisma } from "@prisma/client";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { adminAuth } from "@/lib/admin-auth";
import { prisma } from "@/lib/prisma";

const triggerSettingSchema = z.object({
  draftId: z.string().min(1).optional(),
  title: z.string().trim().min(1, "タイトルを入力してください。").optional(),
  triggerType: z.nativeEnum(LineDeliveryTriggerType).optional(),
  notificationText: z.string().trim().max(1000, "通知テキストは1000文字以内です。").optional(),
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
    .min(1, "配信メッセージを1つ以上追加してください。")
    .optional(),
  targetRankIds: z.array(z.string().min(1)).max(20).optional(),
  targetGender: z.enum(["male", "female", "other"]).nullable().optional(),
  targetVisitCountSegments: z.array(z.nativeEnum(DeliveryVisitCountSegment)).max(10).optional(),
  delayDays: z.number().int().min(-365).max(365).optional(),
  deliveryHourJst: z.number().int().min(0).max(23).nullable().optional(),
  isActive: z.boolean().optional(),
});

type RouteContext = {
  params: Promise<{ triggerId: string }>;
};

async function getAdminScope() {
  const session = await adminAuth.api.getSession({
    headers: await headers(),
  });
  const adminId = session?.user?.username;
  if (!adminId) {
    return { ok: false as const, status: 401, message: "管理者ログインが必要です。" };
  }

  const adminUser = await prisma.adminUser.findUnique({
    where: { id: adminId },
    select: { id: true, officialAccountId: true },
  });
  if (!adminUser) {
    return { ok: false as const, status: 403, message: "管理者情報が見つかりません。" };
  }

  return { ok: true as const, adminUser };
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const scope = await getAdminScope();
    if (!scope.ok) {
      return NextResponse.json({ ok: false, message: scope.message }, { status: scope.status });
    }

    const parsed = triggerSettingSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, message: parsed.error.issues[0]?.message ?? "入力内容が不正です。" },
        { status: 400 },
      );
    }

    const { triggerId } = await context.params;
    if (parsed.data.draftId && !await findDeliveryDraftForSubmit(parsed.data.draftId, scope.adminUser, "TRIGGER", triggerId)) {
      return Response.json({ ok: false, message: "下書きが見つかりません。一覧から開き直してください。" }, { status: 404 });
    }

    const target = await prisma.lineDeliveryTriggerSetting.findFirst({
      where: {
        id: triggerId,
        ...(scope.adminUser.officialAccountId ? { officialAccountId: scope.adminUser.officialAccountId } : {}),
      },
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
      },
    });
    if (!target) {
      return NextResponse.json({ ok: false, message: "対象設定が見つかりません。" }, { status: 404 });
    }

    const nextTitle = parsed.data.title ?? target.title;
    const nextTriggerType = parsed.data.triggerType ?? target.triggerType;
    const nextNotificationText = parsed.data.notificationText ?? target.notificationText;
    const nextMessages = parsed.data.messages ?? (Array.isArray(target.messages) ? target.messages : [
      { type: "text", text: target.message || "" },
    ]);
    const nextTargetRankIds = parsed.data.targetRankIds ?? target.targetRankIds;
    const nextTargetGender =
      parsed.data.targetGender !== undefined ? parsed.data.targetGender : target.targetGender;
    const nextTargetVisitCountSegments =
      parsed.data.targetVisitCountSegments ?? target.targetVisitCountSegments;
    const nextDelayDays = parsed.data.delayDays ?? target.delayDays;
    const nextDeliveryHourJst =
      parsed.data.deliveryHourJst !== undefined ? parsed.data.deliveryHourJst : target.deliveryHourJst;
    const canUseNegativeDelay =
      nextTriggerType === LineDeliveryTriggerType.BIRTHDAY ||
      nextTriggerType === LineDeliveryTriggerType.GIFT_EXPIRES;
    if (!canUseNegativeDelay && nextDelayDays < 0) {
      return NextResponse.json(
        { ok: false, message: "負数の日数は誕生日/ギフト期限切れトリガーでのみ設定できます。" },
        { status: 400 },
      );
    }
    const nextIsActive = parsed.data.isActive ?? target.isActive;
    await prisma.$transaction(async (tx) => {
      await tx.lineDeliveryTriggerSetting.update({
        where: { id: triggerId },
        data: {
          title: nextTitle,
          triggerType: nextTriggerType,
          notificationText: nextNotificationText,
          messages: nextMessages as Prisma.InputJsonValue,
          message:
            nextNotificationText ||
            ((nextMessages as Array<{ type?: string; text?: string }>).find((item) => item.type === "text")?.text ?? ""),
          targetRankIds: nextTargetRankIds,
          targetGender: nextTargetGender,
          targetVisitCountSegments: nextTargetVisitCountSegments,
          delayDays: nextDelayDays,
          deliveryHourJst: nextDeliveryHourJst,
          isActive: nextIsActive,
        },
      });

      if (parsed.data.draftId) {
        await tx.lineDeliveryDraft.delete({ where: { id: parsed.data.draftId } });
      }
    });

    revalidatePath("/admin/spot-delivery");
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("/api/admin/spot-delivery/triggers/[triggerId] PATCH error", error);
    return NextResponse.json({ ok: false, message: "トリガー配信の更新に失敗しました。" }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const scope = await getAdminScope();
    if (!scope.ok) {
      return NextResponse.json({ ok: false, message: scope.message }, { status: scope.status });
    }

    const { triggerId } = await context.params;
    const target = await prisma.lineDeliveryTriggerSetting.findFirst({
      where: {
        id: triggerId,
        ...(scope.adminUser.officialAccountId ? { officialAccountId: scope.adminUser.officialAccountId } : {}),
      },
      select: { id: true },
    });
    if (!target) {
      return NextResponse.json({ ok: false, message: "対象設定が見つかりません。" }, { status: 404 });
    }

    await prisma.lineDeliveryTriggerSetting.delete({
      where: { id: triggerId },
    });
    revalidatePath("/admin/spot-delivery");
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("/api/admin/spot-delivery/triggers/[triggerId] DELETE error", error);
    return NextResponse.json({ ok: false, message: "トリガー配信の削除に失敗しました。" }, { status: 500 });
  }
}
