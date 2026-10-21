import { revalidatePath } from "next/cache";
import { z } from "zod";
import { adminAuth } from "@/lib/admin-auth";
import { prisma } from "@/lib/prisma";
import { deliveryDraftPayloadSchema, deliveryDraftScope } from "@/lib/delivery-draft";

const saveSchema = z.object({
  id: z.string().min(1).optional(),
  kind: z.enum(["SPOT", "TRIGGER"]),
  triggerId: z.string().min(1).nullable().default(null),
  payload: deliveryDraftPayloadSchema,
}).refine((data) => data.kind === "TRIGGER" || data.triggerId === null);

async function getAdmin(request: Request) {
  const session = await adminAuth.api.getSession({ headers: request.headers });
  const id = session?.user?.username;
  return id ? prisma.adminUser.findUnique({ where: { id } }) : null;
}

export async function POST(request: Request) {
  try {
    const admin = await getAdmin(request);
    if (!admin) return Response.json({ message: "管理者ログインが必要です。" }, { status: 401 });
    const parsed = saveSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ message: "下書きの入力内容が不正です。" }, { status: 400 });
    const { id, kind, triggerId, payload } = parsed.data;
    if (triggerId) {
      const trigger = await prisma.lineDeliveryTriggerSetting.findFirst({
        where: { id: triggerId, ...(admin.officialAccountId ? { officialAccountId: admin.officialAccountId } : {}) },
        select: { id: true },
      });
      if (!trigger) return Response.json({ message: "対象のトリガーが見つかりません。" }, { status: 404 });
    }
    if (id) {
      const result = await prisma.lineDeliveryDraft.updateMany({
        where: { id, kind, triggerId, ...deliveryDraftScope(admin) },
        data: { title: payload.title, payload },
      });
      if (!result.count) return Response.json({ message: "下書きが見つかりません。" }, { status: 404 });
      revalidatePath("/admin/spot-delivery");
      return Response.json({ ok: true, id });
    }
    const draft = await prisma.lineDeliveryDraft.create({
      data: { kind, triggerId, title: payload.title, payload, ownerId: admin.id, officialAccountId: admin.officialAccountId },
    });
    revalidatePath("/admin/spot-delivery");
    return Response.json({ ok: true, id: draft.id });
  } catch (error) {
    console.error("delivery draft save failed", error);
    return Response.json({ message: "下書きを保存できませんでした。入力内容を残したまま再試行してください。" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const admin = await getAdmin(request);
    if (!admin) return Response.json({ message: "管理者ログインが必要です。" }, { status: 401 });
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return Response.json({ message: "下書きIDが必要です。" }, { status: 400 });
    const result = await prisma.lineDeliveryDraft.deleteMany({ where: { id, ...deliveryDraftScope(admin) } });
    if (!result.count) return Response.json({ message: "下書きが見つかりません。" }, { status: 404 });
    revalidatePath("/admin/spot-delivery");
    return Response.json({ ok: true });
  } catch (error) {
    console.error("delivery draft delete failed", error);
    return Response.json({ message: "下書きの削除に失敗しました。" }, { status: 500 });
  }
}
