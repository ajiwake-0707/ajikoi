import { z } from "zod";

// Preserve incomplete editor values; final delivery validation stays in the send APIs.
export const deliveryDraftPayloadSchema = z.object({
  title: z.string().max(1000),
  notificationText: z.string().max(10000),
  message: z.string().max(10000),
  showTextElement: z.boolean(),
  showImageElement: z.boolean(),
  showGiftElement: z.boolean(),
  selectedGiftId: z.string().nullable(),
  uploadedImageUrl: z.string().url().nullable(),
  targetRankIds: z.array(z.string()).max(100),
  targetGender: z.enum(["male", "female", "other"]).nullable(),
  targetVisitCountSegments: z.array(z.enum(["ZERO", "ONE", "TWO_TO_FOUR", "FIVE_TO_NINE", "TEN_OR_MORE"])).max(10),
  triggerType: z.enum(["USER_SIGNUP", "CHECKIN_POINT_GRANTED", "RANK_UP", "BIRTHDAY", "GIFT_EXPIRES"]).optional(),
  delayDirection: z.enum(["future", "past"]).optional(),
  delayDayCountInput: z.string().max(100).optional(),
  deliveryHourJst: z.number().int().min(0).max(23).nullable().optional(),
  isActive: z.boolean().optional(),
});
export type DeliveryDraftPayload = z.infer<typeof deliveryDraftPayloadSchema>;
export type EditorDraft = { id: string; payload: DeliveryDraftPayload };
export type DeliveryDraftKind = "SPOT" | "TRIGGER";

export function deliveryDraftScope(admin: { id: string; officialAccountId: string | null }) {
  return admin.officialAccountId
    ? { officialAccountId: admin.officialAccountId }
    : { officialAccountId: null, ownerId: admin.id };
}
