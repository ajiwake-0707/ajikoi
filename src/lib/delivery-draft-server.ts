import "server-only";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { deliveryDraftPayloadSchema, deliveryDraftScope, type DeliveryDraftKind } from "./delivery-draft";

export async function loadDeliveryDraft(
  id: string | string[] | undefined,
  admin: { id: string; officialAccountId: string | null },
  kind: DeliveryDraftKind,
  triggerId: string | null = null,
) {
  if (id === undefined) return undefined;
  if (typeof id !== "string") notFound();
  const draft = await prisma.lineDeliveryDraft.findFirst({
    where: { id, kind, triggerId, ...deliveryDraftScope(admin) },
  });
  if (!draft) notFound();
  const parsed = deliveryDraftPayloadSchema.safeParse(draft.payload);
  if (!parsed.success) notFound();
  return { id: draft.id, payload: parsed.data };
}
