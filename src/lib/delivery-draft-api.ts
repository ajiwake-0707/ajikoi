import { prisma } from "@/lib/prisma";
import { deliveryDraftScope, type DeliveryDraftKind } from "./delivery-draft";

export async function findDeliveryDraftForSubmit(
  id: string,
  admin: { id: string; officialAccountId: string | null },
  kind: DeliveryDraftKind,
  triggerId: string | null = null,
) {
  return prisma.lineDeliveryDraft.findFirst({
    where: { id, kind, triggerId, ...deliveryDraftScope(admin) },
    select: { id: true },
  });
}
