import { os } from "@orpc/server";
import { ORPCError } from "@orpc/client";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { createHash } from "crypto";

import {
  ONBOARDING_SURVEY_PRESETS,
  type OnboardingSurveyOption,
  type OnboardingSurveyPresetKey,
  type OnboardingSurveyQuestionType,
  getOnboardingSurveyPresetByPresetKey,
} from "@/lib/onboarding-survey";
import { adminAuth } from "@/lib/admin-auth";
import { prisma } from "@/lib/prisma";
const prismaUnsafe = prisma as unknown as {
  onboardingSurveyQuestionSetting: {
    upsert: (args: unknown) => Promise<unknown>;
    findMany: (args: unknown) => Promise<unknown[]>;
    createMany: (args: unknown) => Promise<unknown>;
  };
  visitGachaSetting: {
    findUnique: (args: unknown) => Promise<unknown>;
  };
};

const OFFICIAL_ACCOUNT_CACHE_TTL_MS = 5 * 60 * 1000;
let officialAccountCache: { id: string | null; expiresAt: number } | null = null;
const RANK_CACHE_TTL_MS = 5 * 60 * 1000;
const SIGNUP_INITIAL_POINTS = 1;
type GiftExpiryTypeValue = "DAYS_AFTER_ISSUE" | "FIXED_DATE";
type LineDeliveryTriggerTypeValue =
  | "USER_SIGNUP"
  | "CHECKIN_POINT_GRANTED"
  | "RANK_UP"
  | "BIRTHDAY"
  | "GIFT_EXPIRES";
type DeliveryVisitCountSegmentValue = "ZERO" | "ONE" | "TWO_TO_FOUR" | "FIVE_TO_NINE" | "TEN_OR_MORE";
type UserRoleValue = "staff";
type StaffShiftAvailabilityStatusValue = "UNSET" | "AVAILABLE" | "UNAVAILABLE";
type CachedRank = {
  id: string;
  name: string;
  minPoints: number;
  maxPoints: number;
};
let rankCache: { ranks: CachedRank[]; expiresAt: number } | null = null;

type OnboardingSurveySettingRow = {
  id: string;
  questionKey: string;
  presetKey: OnboardingSurveyPresetKey | null;
  questionType: OnboardingSurveyQuestionType;
  label: string;
  options: OnboardingSurveyOption[];
  placeholder: string | null;
  isEnabled: boolean;
  isRequired: boolean;
  sortOrder: number;
};

function matchesVisitQrToken(qrValue: string, expectedToken: string) {
  if (qrValue === expectedToken) {
    return true;
  }

  try {
    const url = new URL(qrValue);
    return url.searchParams.get("token") === expectedToken;
  } catch {
    return false;
  }
}

function getStartOfTodayInJstUtc() {
  const jstOffsetMs = 9 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const jstNow = new Date(nowMs + jstOffsetMs);
  const startOfJstDayMs =
    Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate()) -
    jstOffsetMs;

  return new Date(startOfJstDayMs);
}

function isCheckedInToday(lastCheckInAt: Date | null) {
  if (!lastCheckInAt) {
    return false;
  }

  return lastCheckInAt >= getStartOfTodayInJstUtc();
}

function isCreatedTodayInJst(createdAt: Date, startOfTodayInJstUtc: Date) {
  return createdAt >= startOfTodayInJstUtc;
}

async function resolveOfficialAccountId() {
  const now = Date.now();
  if (officialAccountCache && officialAccountCache.expiresAt > now) {
    return officialAccountCache.id;
  }

  const lineBasicId = process.env.LINE_OFFICIAL_ACCOUNT_ID?.trim();
  if (!lineBasicId) {
    officialAccountCache = {
      id: null,
      expiresAt: now + OFFICIAL_ACCOUNT_CACHE_TTL_MS,
    };
    return null;
  }
  const existing = await prisma.officialAccount.findUnique({
    where: { lineBasicId },
    select: { id: true },
  });
  if (existing?.id) {
    officialAccountCache = {
      id: existing.id,
      expiresAt: now + OFFICIAL_ACCOUNT_CACHE_TTL_MS,
    };
    return existing.id;
  }

  let resolvedId: string | null = null;
  try {
    const created = await prisma.officialAccount.create({
      data: {
        lineBasicId,
        name: lineBasicId,
      },
      select: { id: true },
    });
    resolvedId = created.id;
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
      throw error;
    }
    const duplicated = await prisma.officialAccount.findUnique({
      where: { lineBasicId },
      select: { id: true },
    });
    resolvedId = duplicated?.id ?? null;
  }

  officialAccountCache = {
    id: resolvedId,
    expiresAt: now + OFFICIAL_ACCOUNT_CACHE_TTL_MS,
  };
  return resolvedId;
}

function isValidShiftMonth(month: string) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
}

function getDaysInShiftMonth(month: string) {
  if (!isValidShiftMonth(month)) return 31;
  const [year, monthIndex] = month.split("-").map(Number);
  return new Date(year, monthIndex, 0).getDate();
}

async function resolveStaffScope(userId: string) {
  const officialAccountId = await resolveOfficialAccountId();
  const user = await prisma.user.findUnique({
    where: { userId },
    select: {
      userId: true,
      displayName: true,
      role: true,
      officialAccountId: true,
    },
  });
  if (!user) {
    throw new Error("ユーザーが見つかりません。");
  }

  const scopedOfficialAccountId =
    officialAccountId ?? (process.env.NODE_ENV !== "production" ? user.officialAccountId : null);
  if (!scopedOfficialAccountId) {
    throw new Error("公式アカウント設定が見つかりません。");
  }
  if (user.role !== "staff" || user.officialAccountId !== scopedOfficialAccountId) {
    throw new Error("スタッフ権限がありません。");
  }

  const permission = await prisma.staffStoreOperationPermission.findUnique({
    where: {
      userId_officialAccountId: {
        userId: user.userId,
        officialAccountId: scopedOfficialAccountId,
      },
    },
    select: {
      id: true,
    },
  });
  if (!permission) {
    throw new Error("スタッフ権限がありません。");
  }

  return {
    userId: user.userId,
    displayName: user.displayName,
    officialAccountId: scopedOfficialAccountId,
  };
}

async function ensureOnboardingSurveySettings(officialAccountId: string | null) {
  const scopeKey = officialAccountId ?? "global";
  const existing = (await prismaUnsafe.onboardingSurveyQuestionSetting.findMany({
    where: { scopeKey },
    orderBy: { sortOrder: "asc" },
    select: {
      id: true,
      questionKey: true,
      presetKey: true,
      questionType: true,
      label: true,
      options: true,
      placeholder: true,
      isEnabled: true,
      isRequired: true,
      sortOrder: true,
    },
  })) as Array<{
    id: string;
    questionKey: string;
    presetKey: OnboardingSurveyPresetKey | null;
    questionType: OnboardingSurveyQuestionType;
    label: string;
    options: unknown;
    placeholder: string | null;
    isEnabled: boolean;
    isRequired: boolean;
    sortOrder: number;
  }>;
  if (existing.length > 0) {
    return existing.map((row) => ({
      id: row.id,
      questionKey: row.questionKey,
      presetKey: row.presetKey,
      questionType: row.questionType,
      label: row.label,
      options: Array.isArray(row.options) ? (row.options as OnboardingSurveyOption[]) : [],
      placeholder: row.placeholder,
      isEnabled: row.isEnabled,
      isRequired: row.isRequired,
      sortOrder: row.sortOrder,
    }));
  }

  await prismaUnsafe.onboardingSurveyQuestionSetting.createMany({
    data: ONBOARDING_SURVEY_PRESETS.map((preset, index) => ({
      scopeKey,
      officialAccountId,
      questionKey: preset.questionKey,
      presetKey: preset.presetKey,
      questionType: preset.type,
      label: preset.label,
      options: preset.options,
      placeholder: preset.placeholder,
      isEnabled: preset.defaultEnabled,
      isRequired: preset.defaultRequired,
      sortOrder: index,
    })),
    skipDuplicates: true,
  });

  const rows = (await prismaUnsafe.onboardingSurveyQuestionSetting.findMany({
    where: { scopeKey },
    orderBy: { sortOrder: "asc" },
    select: {
      id: true,
      questionKey: true,
      presetKey: true,
      questionType: true,
      label: true,
      options: true,
      placeholder: true,
      isEnabled: true,
      isRequired: true,
      sortOrder: true,
    },
  })) as Array<{
    id: string;
    questionKey: string;
    presetKey: OnboardingSurveyPresetKey | null;
    questionType: OnboardingSurveyQuestionType;
    label: string;
    options: unknown;
    placeholder: string | null;
    isEnabled: boolean;
    isRequired: boolean;
    sortOrder: number;
  }>;
  return rows.map((row: {
    id: string;
    questionKey: string;
    presetKey: OnboardingSurveyPresetKey | null;
    questionType: OnboardingSurveyQuestionType;
    label: string;
    options: unknown;
    placeholder: string | null;
    isEnabled: boolean;
    isRequired: boolean;
    sortOrder: number;
  }) => ({
    id: row.id,
    questionKey: row.questionKey,
    presetKey: row.presetKey,
    questionType: row.questionType,
    label: row.label,
    options: Array.isArray(row.options) ? (row.options as OnboardingSurveyOption[]) : [],
    placeholder: row.placeholder,
    isEnabled: row.isEnabled,
    isRequired: row.isRequired,
    sortOrder: row.sortOrder,
  }));
}

async function getCachedRanks() {
  const now = Date.now();
  if (rankCache && rankCache.expiresAt > now) {
    return rankCache.ranks;
  }

  const rows = await prisma.rank.findMany({
    select: {
      id: true,
      name: true,
      minPoints: true,
      maxPoints: true,
    },
    orderBy: {
      minPoints: "asc",
    },
  });
  const ranks = rows.map((row) => ({
    ...row,
    minPoints: Number(row.minPoints),
    maxPoints: Number(row.maxPoints),
  }));
  rankCache = {
    ranks,
    expiresAt: now + RANK_CACHE_TTL_MS,
  };
  return ranks;
}

async function resolveRankByPoints(points: number) {
  const ranks = await getCachedRanks();
  const rank = ranks.find((candidate) => points >= candidate.minPoints && points <= candidate.maxPoints);

  if (!rank) {
    throw new Error(`No rank found for points: ${points}`);
  }

  return rank;
}

async function resolveNextRankByPoints(points: number) {
  const ranks = await getCachedRanks();
  const nextRank = ranks.find((candidate) => candidate.minPoints > points);
  return nextRank ?? null;
}

function findRankByPoints(ranks: CachedRank[], points: number) {
  const rank = ranks.find((candidate) => points >= candidate.minPoints && points <= candidate.maxPoints);
  if (!rank) {
    throw new Error(`No rank found for points: ${points}`);
  }
  return rank;
}

function findNextRankByPoints(ranks: CachedRank[], points: number) {
  return ranks.find((candidate) => candidate.minPoints > points) ?? null;
}

function addDays(base: Date, days: number) {
  const date = new Date(base);
  date.setDate(date.getDate() + days);
  return date;
}

function resolveGiftExpiryAt(gift: {
  expiryType: GiftExpiryTypeValue;
  expiryDays: number | null;
  expiryAt: Date | null;
}) {
  const now = new Date();
  if (gift.expiryType === "DAYS_AFTER_ISSUE") {
    const days = gift.expiryDays ?? 0;
    if (days > 0) {
      return addDays(now, days);
    }
    return null;
  }
  return gift.expiryAt ?? null;
}

type MemberBenefitSettingWithRanks = {
  signupGiftId: string | null;
  reviewGiftId: string | null;
  reviewPasswordHash: string | null;
  topRankLoopGiftId: string | null;
  rankBenefitGiftSettings: Array<{
    rankId: string;
    giftId: string;
  }>;
};

async function getMemberBenefitSetting(officialAccountId: string | null) {
  const scopeKey = officialAccountId ?? "global";
  const setting = await prisma.memberBenefitSetting.findUnique({
    where: { scopeKey },
    select: {
      signupGiftId: true,
      reviewGiftId: true,
      reviewPasswordHash: true,
      topRankLoopGiftId: true,
      rankBenefitGiftSettings: {
        select: {
          rankId: true,
          giftId: true,
        },
      },
    },
  });
  return setting as MemberBenefitSettingWithRanks | null;
}

async function resolveMemberBenefitSettingForUser(userOfficialAccountId: string | null) {
  const envOfficialAccountId = await resolveOfficialAccountId();
  const scopeCandidates = [
    envOfficialAccountId,
    userOfficialAccountId,
    null,
  ].filter((id, index, array) => array.indexOf(id) === index);

  for (const officialAccountId of scopeCandidates) {
    const setting = await getMemberBenefitSetting(officialAccountId);
    if (setting) {
      return { setting, officialAccountId };
    }
  }

  return null;
}

function hashReviewPassword(password: string) {
  return createHash("sha256").update(`review-password:${password}`).digest("hex");
}

async function issueGiftFromSetting(params: {
  userId: string;
  giftId: string;
  officialAccountId: string | null;
  action: string;
  dedupeKey: string;
  dedupeValue: string;
  extraMetadata?: Record<string, unknown>;
}) {
  const gift = await prisma.gift.findUnique({
    where: { id: params.giftId },
    select: {
      id: true,
      title: true,
      expiryType: true,
      expiryDays: true,
      expiryAt: true,
    },
  });
  if (!gift) {
    return null;
  }

  const expiresAt = resolveGiftExpiryAt(gift);
  if (!expiresAt) {
    return null;
  }

  const createdRows = await prisma.$queryRaw<Array<{ id: string }>>`
    WITH inserted AS (
      INSERT INTO "user_gifts"
        ("id", "userId", "giftId", "isUsed", "issuedAt", "expiresAt", "createdAt", "updatedAt")
      SELECT
        md5(random()::text || clock_timestamp()::text),
        ${params.userId},
        ${gift.id},
        false,
        NOW(),
        ${expiresAt},
        NOW(),
        NOW()
      WHERE NOT EXISTS (
        SELECT 1
        FROM "user_history" h
        WHERE h."targetUserId" = ${params.userId}
          AND h."action" = ${params.action}
          AND h."metadata"->>${params.dedupeKey} = ${params.dedupeValue}
      )
      RETURNING "id"
    )
    SELECT "id"
    FROM inserted
    LIMIT 1
  `;
  const created = createdRows[0] ?? null;
  if (!created) {
    return null;
  }

  await prisma.$executeRaw`
    INSERT INTO "user_history"
      ("id", "targetUserId", "actorType", "actorId", "action", "metadata", "officialAccountId", "createdAt")
    VALUES
      (
        md5(random()::text || clock_timestamp()::text),
        ${params.userId},
        'system',
        'member_benefit',
        ${params.action},
        ${JSON.stringify({
          giftId: gift.id,
          giftTitle: gift.title,
          userGiftId: created.id,
          [params.dedupeKey]: params.dedupeValue,
          ...(params.extraMetadata ?? {}),
        })}::jsonb,
        ${params.officialAccountId},
        NOW()
      )
  `;

  return gift.title;
}

async function sendLineDeliveryTriggers(params: {
  triggerType: LineDeliveryTriggerTypeValue;
  officialAccountId: string | null;
  targetUserId: string;
}) {
  try {
    const toScheduledAt = (delayDays: number, deliveryHourJst: number | null) => {
      if (delayDays <= 0 && deliveryHourJst === null) {
        return null;
      }
      const jstOffsetMs = 9 * 60 * 60 * 1000;
      const now = new Date();
      if (deliveryHourJst === null) {
        return new Date(now.getTime() + delayDays * 24 * 60 * 60 * 1000).toISOString();
      }
      const jstNow = new Date(now.getTime() + jstOffsetMs);
      const jstDate = new Date(
        Date.UTC(
          jstNow.getUTCFullYear(),
          jstNow.getUTCMonth(),
          jstNow.getUTCDate() + delayDays,
          deliveryHourJst,
          0,
          0,
          0,
        ) - jstOffsetMs,
      );
      if (jstDate.getTime() <= now.getTime()) {
        return new Date(jstDate.getTime() + 24 * 60 * 60 * 1000).toISOString();
      }
      return jstDate.toISOString();
    };
    const resolveVisitCountSegment = (checkInCount: number): DeliveryVisitCountSegmentValue => {
      if (checkInCount <= 0) return "ZERO";
      if (checkInCount === 1) return "ONE";
      if (checkInCount <= 4) return "TWO_TO_FOUR";
      if (checkInCount <= 9) return "FIVE_TO_NINE";
      return "TEN_OR_MORE";
    };

    const settings = await prisma.lineDeliveryTriggerSetting.findMany({
      where: {
        triggerType: params.triggerType,
        isActive: true,
        ...(params.officialAccountId
          ? { officialAccountId: params.officialAccountId }
          : { officialAccountId: null }),
      },
      select: {
        id: true,
        title: true,
        notificationText: true,
        messages: true,
        message: true,
        targetRankIds: true,
        targetGender: true,
        targetVisitCountSegments: true,
        delayDays: true,
        deliveryHourJst: true,
      },
      take: 20,
    });
    if (settings.length === 0) {
      return;
    }

    const [targetUser, checkInCount] = await Promise.all([
      prisma.user.findUnique({
        where: { userId: params.targetUserId },
        select: {
          nextRank: true,
          survey: {
            select: {
              gender: true,
            },
          },
        },
      }),
      prisma.userCheckIn.count({
        where: { userId: params.targetUserId },
      }),
    ]);
    if (!targetUser) {
      return;
    }
    const visitCountSegment = resolveVisitCountSegment(checkInCount);
    const matchedSettings = settings.filter((setting) => {
      if (setting.targetRankIds.length > 0 && !setting.targetRankIds.includes(targetUser.nextRank)) {
        return false;
      }
      if (setting.targetGender && setting.targetGender !== (targetUser.survey?.gender ?? null)) {
        return false;
      }
      if (
        setting.targetVisitCountSegments.length > 0 &&
        !setting.targetVisitCountSegments.includes(visitCountSegment)
      ) {
        return false;
      }
      return true;
    });
    if (matchedSettings.length === 0) {
      return;
    }

    const { inngest } = await import("@/lib/inngest/client");
    await Promise.allSettled(
      matchedSettings.map((setting) =>
        inngest.send({
          name: "line/delivery.triggered",
          data: {
            title: setting.title,
            notificationText: setting.notificationText || setting.message,
            messages: Array.isArray(setting.messages)
              ? setting.messages
              : [
                  {
                    type: "text",
                    text: setting.message,
                  },
                ],
            officialAccountId: params.officialAccountId,
            targetUserIds: [params.targetUserId],
            scheduledAt: toScheduledAt(setting.delayDays, setting.deliveryHourJst),
            triggeredBy: `system:${params.triggerType.toLowerCase()}`,
          },
        }),
      ),
    );
  } catch (error) {
    console.error("[line-trigger-send-failed]", {
      triggerType: params.triggerType,
      targetUserId: params.targetUserId,
      error,
    });
  }
}

type VisitGachaResult = {
  executed: boolean;
  won: boolean;
  winProbability: number;
  giftTitle: string | null;
  resultImageUrl: string | null;
  previewGift: {
    title: string;
    usageGuide: string;
    imageUrl: string;
    expiresLabel: string | null;
  } | null;
};
type VisitGachaPreview = {
  eligible: boolean;
  winProbability: number;
  previewGift: {
    title: string;
    usageGuide: string;
    imageUrl: string;
    expiresLabel: string | null;
  } | null;
};
type VisitGachaContext = {
  winProbability: number;
  winImageUrl: string | null;
  loseImageUrl: string | null;
  gift: {
    id: string;
    title: string;
    usageGuide: string;
    imageUrl: string;
    expiryType: GiftExpiryTypeValue;
    expiryDays: number | null;
    expiryAt: Date | null;
  };
};

function formatGiftExpiryLabel(gift: {
  expiryType: GiftExpiryTypeValue;
  expiryDays: number | null;
  expiryAt: Date | null;
}) {
  if (gift.expiryType === "DAYS_AFTER_ISSUE") {
    const days = gift.expiryDays ?? 0;
    if (days > 0) {
      return `獲得日から${days}日間有効`;
    }
    return null;
  }
  if (!gift.expiryAt) {
    return null;
  }
  const date = gift.expiryAt;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}/${m}/${d} まで有効`;
}

function toVisitGachaPreviewGift(gift: {
  title: string;
  usageGuide: string;
  imageUrl: string;
  expiryType: GiftExpiryTypeValue;
  expiryDays: number | null;
  expiryAt: Date | null;
}) {
  return {
    title: gift.title,
    usageGuide: gift.usageGuide,
    imageUrl: gift.imageUrl,
    expiresLabel: formatGiftExpiryLabel(gift),
  };
}

async function resolveVisitGachaContext(userId: string, officialAccountId: string | null): Promise<VisitGachaContext | null> {
  const scopeKey = officialAccountId ?? "global";
  const setting = (await prismaUnsafe.visitGachaSetting.findUnique({
    where: { scopeKey },
    select: {
      winProbability: true,
      winImageUrl: true,
      loseImageUrl: true,
      isActive: true,
      rankProbabilities: {
        select: {
          rankId: true,
          winProbability: true,
        },
      },
      gift: {
        select: {
          id: true,
          title: true,
          usageGuide: true,
          imageUrl: true,
          expiryType: true,
          expiryDays: true,
          expiryAt: true,
        },
      },
    },
  })) as {
    winProbability: number;
    winImageUrl: string | null;
    loseImageUrl: string | null;
    isActive: boolean;
    rankProbabilities: Array<{ rankId: string; winProbability: number }>;
    gift: {
      id: string;
      title: string;
      usageGuide: string;
      imageUrl: string;
      expiryType: GiftExpiryTypeValue;
      expiryDays: number | null;
      expiryAt: Date | null;
    } | null;
  } | null;
  if (!setting || !setting.isActive || !setting.gift) {
    return null;
  }

  const user = await prisma.user.findUnique({
    where: { userId },
    select: {
      nextRank: true,
    },
  });
  const rankProbability = user
    ? setting.rankProbabilities.find((row) => row.rankId === user.nextRank)
    : null;
  const winProbability = Math.max(0, Math.min(100, rankProbability?.winProbability ?? setting.winProbability));
  return {
    winProbability,
    winImageUrl: setting.winImageUrl,
    loseImageUrl: setting.loseImageUrl,
    gift: setting.gift,
  };
}

async function resolveVisitGachaContextForUser(
  userId: string,
  userOfficialAccountId: string | null,
): Promise<VisitGachaContext | null> {
  const envOfficialAccountId = await resolveOfficialAccountId();
  const scopeCandidates = [
    envOfficialAccountId,
    userOfficialAccountId,
    null,
  ].filter((id, index, array) => array.indexOf(id) === index);

  for (const officialAccountId of scopeCandidates) {
    const context = await resolveVisitGachaContext(userId, officialAccountId);
    if (context) {
      return context;
    }
  }

  return null;
}

async function getVisitGachaPreview(userId: string, userOfficialAccountId: string | null): Promise<VisitGachaPreview> {
  const context = await resolveVisitGachaContextForUser(userId, userOfficialAccountId);
  if (!context) {
    return {
      eligible: false,
      winProbability: 0,
      previewGift: null,
    };
  }
  return {
    eligible: true,
    winProbability: context.winProbability,
    previewGift: toVisitGachaPreviewGift(context.gift),
  };
}

async function runVisitGacha(userId: string, userOfficialAccountId: string | null): Promise<VisitGachaResult> {
  const context = await resolveVisitGachaContextForUser(userId, userOfficialAccountId);
  if (!context) {
    return {
      executed: false,
      won: false,
      winProbability: 0,
      giftTitle: null,
      resultImageUrl: null,
      previewGift: null,
    };
  }
  const winProbability = context.winProbability;
  const won = Math.random() * 100 < winProbability;
  const resultImageUrl = won ? context.winImageUrl : context.loseImageUrl;
  const previewGift = toVisitGachaPreviewGift(context.gift);

  if (!won) {
    return {
      executed: true,
      won: false,
      winProbability,
      giftTitle: null,
      resultImageUrl,
      previewGift,
    };
  }

  const gift = context.gift;
  const expiresAt = resolveGiftExpiryAt(gift);

  if (!expiresAt) {
    return {
      executed: true,
      won: false,
      winProbability,
      giftTitle: null,
      resultImageUrl,
      previewGift,
    };
  }

  await prisma.userGift.create({
    data: {
      userId,
      giftId: gift.id,
      expiresAt,
    },
  });

  return {
    executed: true,
    won: true,
    winProbability,
    giftTitle: gift.title,
    resultImageUrl,
    previewGift,
  };
}

type MemberTrendRow = {
  day: Date;
  members: number;
};

type RepeaterTrendRow = {
  day: Date;
  repeaters: number;
};

type VisitTrendRow = {
  day: Date;
  newVisits: number;
  repeatVisits: number;
  totalVisits: number;
};

type VisitStatsRow = {
  members: number;
  repeaters: number;
  repeatRate: number;
  visit1: number;
  visit2: number;
  visit3: number;
  visit4: number;
  visit5Plus: number;
};

type AgeDistributionRow = {
  label: string;
  count: number;
  sortOrder: number;
};

type GenderDistributionRow = {
  label: string;
  count: number;
  sortOrder: number;
};

type RevisitFrequencyRow = {
  usersCount: number;
  avgVisitsIn30Days: number;
};

type LatestDeliveryRow = {
  sentAt: Date;
  message: string;
  sent: number;
  failed: number;
  aggregationUnit: string | null;
};

type LatestDeliveryVisitRow = {
  visits: number;
};

type UpsertedLiffUserRow = {
  userId: string;
  points: number;
  nextRank: string;
  role: UserRoleValue | null;
  lastCheckInAt: Date | null;
  surveyId: string | null;
  googleReviewId: string | null;
  isNew: boolean;
};

function formatJstYmd(date: Date) {
  const jstOffsetMs = 9 * 60 * 60 * 1000;
  const jst = new Date(date.getTime() + jstOffsetMs);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

async function getLineUniqueImpressionByAggregationUnit(
  aggregationUnit: string,
  sentAt: Date,
): Promise<number | null> {
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
  if (!accessToken) {
    return null;
  }

  const from = formatJstYmd(sentAt);
  const toDate = new Date();
  const maxToDate = new Date(sentAt);
  maxToDate.setDate(maxToDate.getDate() + 30);
  const to = formatJstYmd(toDate <= maxToDate ? toDate : maxToDate);

  const url = new URL("https://api.line.me/v2/bot/insight/message/event/aggregation");
  url.searchParams.set("customAggregationUnit", aggregationUnit);
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200);
    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
    if (!response.ok) {
      return null;
    }
    const json = (await response.json()) as {
      overview?: {
        uniqueImpression?: number | null;
      };
    };
    return json.overview?.uniqueImpression ?? null;
  } catch {
    return null;
  }
}

async function getAdminReportMetrics(officialAccountId: string | null) {
  const queryStartedAt = Date.now();
  const queryTimings: Record<string, number> = {};
  const measure = async <T>(name: string, run: () => Promise<T>) => {
    const startedAt = Date.now();
    const value = await run();
    queryTimings[name] = Date.now() - startedAt;
    return value;
  };
  const officialAccountFilterUsers = officialAccountId
    ? Prisma.sql`AND u."officialAccountId" = ${officialAccountId}`
    : Prisma.empty;
  const officialAccountFilterCheckins = officialAccountId
    ? Prisma.sql`AND c."officialAccountId" = ${officialAccountId}`
    : Prisma.empty;

  const memberTrendPromise = measure("memberTrend", () => prisma.$queryRaw<MemberTrendRow[]>`
    WITH daily_new_members AS (
      SELECT
        u."createdAt"::date AS day,
        COUNT(*)::int AS new_members
      FROM "users" u
      WHERE 1 = 1
      ${officialAccountFilterUsers}
      GROUP BY u."createdAt"::date
    ),
    bounds AS (
      SELECT COALESCE(MIN(day), CURRENT_DATE) AS start_day
      FROM daily_new_members
    ),
    days AS (
      SELECT generate_series(
        (SELECT start_day FROM bounds),
        CURRENT_DATE::date,
        INTERVAL '1 day'
      )::date AS day
    )
    SELECT
      d.day AS "day",
      SUM(COALESCE(dnm.new_members, 0)) OVER (ORDER BY d.day)::int AS "members"
    FROM days d
    LEFT JOIN daily_new_members dnm ON dnm.day = d.day
    ORDER BY d.day ASC
  `);

  const visitTrendPromise = measure("visitTrend", () => prisma.$queryRaw<VisitTrendRow[]>`
    WITH daily_visits AS (
      SELECT
        c."checkedInAt"::date AS day,
        SUM(CASE WHEN c."isFirstVisit" THEN 1 ELSE 0 END)::int AS "newVisits",
        SUM(CASE WHEN c."isRepeatVisit" THEN 1 ELSE 0 END)::int AS "repeatVisits",
        COUNT(*)::int AS "totalVisits"
      FROM "user_checkins" c
      WHERE 1 = 1
      ${officialAccountFilterCheckins}
      GROUP BY c."checkedInAt"::date
    ),
    bounds AS (
      SELECT COALESCE(MIN(day), CURRENT_DATE) AS start_day
      FROM daily_visits
    ),
    days AS (
      SELECT generate_series(
        (SELECT start_day FROM bounds),
        CURRENT_DATE::date,
        INTERVAL '1 day'
      )::date AS day
    )
    SELECT
      d.day AS "day",
      COALESCE(v."newVisits", 0)::int AS "newVisits",
      COALESCE(v."repeatVisits", 0)::int AS "repeatVisits",
      COALESCE(v."totalVisits", 0)::int AS "totalVisits"
    FROM days d
    LEFT JOIN daily_visits v ON v.day = d.day
    ORDER BY d.day ASC
  `);

  const repeaterTrendPromise = measure("repeaterTrend", () => prisma.$queryRaw<RepeaterTrendRow[]>`
    WITH eligible_users AS (
      SELECT u."userId", u."createdAt"::date AS created_day
      FROM "users" u
      WHERE 1 = 1
      ${officialAccountFilterUsers}
    ),
    second_visits AS (
      SELECT
        ranked."userId",
        ranked."checkedInAt"::date AS second_day
      FROM (
        SELECT
          c."userId",
          c."checkedInAt",
          ROW_NUMBER() OVER (PARTITION BY c."userId" ORDER BY c."checkedInAt" ASC) AS rn
        FROM "user_checkins" c
        JOIN eligible_users eu ON eu."userId" = c."userId"
        WHERE 1 = 1
        ${officialAccountFilterCheckins}
      ) ranked
      WHERE ranked.rn = 2
    ),
    daily_repeaters AS (
      SELECT sv.second_day AS day, COUNT(*)::int AS repeater_count
      FROM second_visits sv
      GROUP BY sv.second_day
    ),
    bounds AS (
      SELECT COALESCE(MIN(eu.created_day), CURRENT_DATE) AS start_day
      FROM eligible_users eu
    ),
    days AS (
      SELECT generate_series(
        (SELECT start_day FROM bounds),
        CURRENT_DATE::date,
        INTERVAL '1 day'
      )::date AS day
    )
    SELECT
      d.day AS "day",
      SUM(COALESCE(dr.repeater_count, 0)) OVER (ORDER BY d.day)::int AS "repeaters"
    FROM days d
    LEFT JOIN daily_repeaters dr ON dr.day = d.day
    ORDER BY d.day ASC
  `);

  const visitStatsRowsPromise = measure("visitStats", () => prisma.$queryRaw<VisitStatsRow[]>`
    WITH visits_per_user AS (
      SELECT
        u."userId",
        COALESCE(COUNT(c.*), 0)::int AS visits
      FROM "users" u
      LEFT JOIN "user_checkins" c
        ON c."userId" = u."userId"
        ${officialAccountId ? Prisma.sql`AND c."officialAccountId" = ${officialAccountId}` : Prisma.empty}
      WHERE 1 = 1
      ${officialAccountFilterUsers}
      GROUP BY u."userId"
    )
    SELECT
      COUNT(*)::int AS "members",
      COUNT(*) FILTER (WHERE visits >= 2)::int AS "repeaters",
      COALESCE(
        ROUND(
          (COUNT(*) FILTER (WHERE visits >= 2))::numeric
          / NULLIF(COUNT(*), 0)::numeric * 100,
          2
        ),
        0
      )::float AS "repeatRate",
      COUNT(*) FILTER (WHERE visits = 1)::int AS "visit1",
      COUNT(*) FILTER (WHERE visits = 2)::int AS "visit2",
      COUNT(*) FILTER (WHERE visits = 3)::int AS "visit3",
      COUNT(*) FILTER (WHERE visits = 4)::int AS "visit4",
      COUNT(*) FILTER (WHERE visits >= 5)::int AS "visit5Plus"
    FROM visits_per_user
  `);

  const ageDistributionRowsPromise = measure("ageDistribution", () => prisma.$queryRaw<AgeDistributionRow[]>`
    WITH surveyed AS (
      SELECT
        CASE
          WHEN DATE_PART('year', AGE(CURRENT_DATE, s."birthDate")) BETWEEN 10 AND 19 THEN '10代'
          WHEN DATE_PART('year', AGE(CURRENT_DATE, s."birthDate")) BETWEEN 20 AND 29 THEN '20代'
          WHEN DATE_PART('year', AGE(CURRENT_DATE, s."birthDate")) BETWEEN 30 AND 39 THEN '30代'
          WHEN DATE_PART('year', AGE(CURRENT_DATE, s."birthDate")) BETWEEN 40 AND 49 THEN '40代'
          WHEN DATE_PART('year', AGE(CURRENT_DATE, s."birthDate")) BETWEEN 50 AND 59 THEN '50代'
          WHEN DATE_PART('year', AGE(CURRENT_DATE, s."birthDate")) >= 60 THEN '60代〜'
          ELSE 'その他'
        END AS age_band
      FROM "users" u
      JOIN "user_surveys" s ON s."id" = u."surveyId"
      WHERE 1 = 1
      ${officialAccountFilterUsers}
    )
    SELECT * FROM (
      SELECT '10代'::text AS "label", COUNT(*) FILTER (WHERE age_band = '10代')::int AS "count", 1::int AS "sortOrder" FROM surveyed
      UNION ALL
      SELECT '20代'::text AS "label", COUNT(*) FILTER (WHERE age_band = '20代')::int AS "count", 2::int AS "sortOrder" FROM surveyed
      UNION ALL
      SELECT '30代'::text AS "label", COUNT(*) FILTER (WHERE age_band = '30代')::int AS "count", 3::int AS "sortOrder" FROM surveyed
      UNION ALL
      SELECT '40代'::text AS "label", COUNT(*) FILTER (WHERE age_band = '40代')::int AS "count", 4::int AS "sortOrder" FROM surveyed
      UNION ALL
      SELECT '50代'::text AS "label", COUNT(*) FILTER (WHERE age_band = '50代')::int AS "count", 5::int AS "sortOrder" FROM surveyed
      UNION ALL
      SELECT '60代〜'::text AS "label", COUNT(*) FILTER (WHERE age_band = '60代〜')::int AS "count", 6::int AS "sortOrder" FROM surveyed
      UNION ALL
      SELECT 'その他'::text AS "label", COUNT(*) FILTER (WHERE age_band = 'その他')::int AS "count", 7::int AS "sortOrder" FROM surveyed
    ) t
    ORDER BY t."sortOrder" ASC
  `);

  const genderDistributionRowsPromise = measure("genderDistribution", () => prisma.$queryRaw<GenderDistributionRow[]>`
    WITH surveyed AS (
      SELECT
        CASE
          WHEN s."gender" = 'male' THEN '男性'
          WHEN s."gender" = 'female' THEN '女性'
          ELSE 'その他'
        END AS gender_label
      FROM "users" u
      JOIN "user_surveys" s ON s."id" = u."surveyId"
      WHERE 1 = 1
      ${officialAccountFilterUsers}
    )
    SELECT * FROM (
      SELECT '女性'::text AS "label", COUNT(*) FILTER (WHERE gender_label = '女性')::int AS "count", 1::int AS "sortOrder" FROM surveyed
      UNION ALL
      SELECT '男性'::text AS "label", COUNT(*) FILTER (WHERE gender_label = '男性')::int AS "count", 2::int AS "sortOrder" FROM surveyed
      UNION ALL
      SELECT 'その他'::text AS "label", COUNT(*) FILTER (WHERE gender_label = 'その他')::int AS "count", 3::int AS "sortOrder" FROM surveyed
    ) t
    ORDER BY t."sortOrder" ASC
  `);

  const revisitFrequencyRowsPromise = measure("revisitFrequency", () => prisma.$queryRaw<RevisitFrequencyRow[]>`
    WITH first_checkins AS (
      SELECT c."userId", MIN(c."checkedInAt") AS first_at
      FROM "user_checkins" c
      WHERE 1 = 1
      ${officialAccountFilterCheckins}
      GROUP BY c."userId"
    ),
    revisit_users AS (
      SELECT f."userId", f.first_at
      FROM first_checkins f
      WHERE EXISTS (
        SELECT 1
        FROM "user_checkins" c2
        WHERE c2."userId" = f."userId"
          AND c2."checkedInAt" > f.first_at
          AND c2."checkedInAt" <= f.first_at + INTERVAL '30 days'
          ${officialAccountId ? Prisma.sql`AND c2."officialAccountId" = ${officialAccountId}` : Prisma.empty}
      )
    ),
    visits_30d AS (
      SELECT r."userId", COUNT(*)::int AS visits
      FROM revisit_users r
      JOIN "user_checkins" c ON c."userId" = r."userId"
      WHERE c."checkedInAt" >= r.first_at
        AND c."checkedInAt" <= r.first_at + INTERVAL '30 days'
        ${officialAccountId ? Prisma.sql`AND c."officialAccountId" = ${officialAccountId}` : Prisma.empty}
      GROUP BY r."userId"
    )
    SELECT
      COUNT(*)::int AS "usersCount",
      COALESCE(ROUND(AVG(v.visits)::numeric, 2), 0)::float AS "avgVisitsIn30Days"
    FROM visits_30d v
  `);

  const latestDeliveryRowsPromise = measure("latestDelivery", () => prisma.$queryRaw<LatestDeliveryRow[]>`
    SELECT
      h."createdAt" AS "sentAt",
      COALESCE(h."metadata"->>'message', '') AS "message",
      COALESCE((h."metadata"->>'sent')::int, 0) AS "sent",
      COALESCE((h."metadata"->>'failed')::int, 0) AS "failed",
      (h."metadata"->>'aggregationUnit') AS "aggregationUnit"
    FROM "user_history" h
    WHERE h."action" = 'line_trigger_delivery_executed'
      ${officialAccountId ? Prisma.sql`AND h."officialAccountId" = ${officialAccountId}` : Prisma.empty}
    ORDER BY h."createdAt" DESC
    LIMIT 1
  `);

  const [
    memberTrend,
    visitTrend,
    repeaterTrend,
    visitStatsRows,
    ageDistributionRows,
    genderDistributionRows,
    revisitFrequencyRows,
    latestDeliveryRows,
  ] = await Promise.all([
    memberTrendPromise,
    visitTrendPromise,
    repeaterTrendPromise,
    visitStatsRowsPromise,
    ageDistributionRowsPromise,
    genderDistributionRowsPromise,
    revisitFrequencyRowsPromise,
    latestDeliveryRowsPromise,
  ]);

  const latestDelivery = latestDeliveryRows[0];
  let latestDeliveryVisits = 0;
  let latestDeliveryOpened: number | null = null;
  if (latestDelivery) {
    const [latestDeliveryVisitRows, opened] = await Promise.all([
      measure("latestDeliveryVisits", () => prisma.$queryRaw<LatestDeliveryVisitRow[]>`
        SELECT COUNT(*)::int AS "visits"
        FROM "user_checkins" c
        WHERE c."checkedInAt" >= ${latestDelivery.sentAt}
        ${officialAccountId ? Prisma.sql`AND c."officialAccountId" = ${officialAccountId}` : Prisma.empty}
      `),
      latestDelivery.aggregationUnit
        ? measure("latestDeliveryOpened", () =>
            getLineUniqueImpressionByAggregationUnit(latestDelivery.aggregationUnit!, latestDelivery.sentAt),
          )
        : Promise.resolve(null),
    ]);
    latestDeliveryVisits = latestDeliveryVisitRows[0]?.visits ?? 0;
    latestDeliveryOpened = opened;
  }

  const visitStats = visitStatsRows[0] ?? {
    members: 0,
    repeaters: 0,
    repeatRate: 0,
    visit1: 0,
    visit2: 0,
    visit3: 0,
    visit4: 0,
    visit5Plus: 0,
  };
  const queryElapsedMs = Date.now() - queryStartedAt;
  if (queryElapsedMs >= 300) {
    console.info("[admin.reportMetrics-query-breakdown-ms]", {
      total: queryElapsedMs,
      ...queryTimings,
    });
  }

  return {
    memberTrend,
    repeaterTrend,
    visitTrend,
    repeaterSummary: {
      members: visitStats.members,
      repeaters: visitStats.repeaters,
      repeatRate: visitStats.repeatRate,
    },
    visitCountDistribution: [
      { label: "1回", count: visitStats.visit1 },
      { label: "2回", count: visitStats.visit2 },
      { label: "3回", count: visitStats.visit3 },
      { label: "4回", count: visitStats.visit4 },
      { label: "5回〜", count: visitStats.visit5Plus },
    ],
    ageDistribution: ageDistributionRows.map((row) => ({
      label: row.label,
      count: row.count,
    })),
    genderDistribution: genderDistributionRows.map((row) => ({
      label: row.label,
      count: row.count,
    })),
    revisitFrequency: revisitFrequencyRows[0] ?? {
      usersCount: 0,
      avgVisitsIn30Days: 0,
    },
    latestDelivery: latestDelivery
      ? {
          sentAt: latestDelivery.sentAt,
          message: latestDelivery.message,
          sent: latestDelivery.sent,
          opened: latestDeliveryOpened,
          visits: latestDeliveryVisits,
          statusLabel: "確定",
        }
      : null,
  };
}

type AdminReportMetrics = Awaited<ReturnType<typeof getAdminReportMetrics>>;
const ADMIN_REPORT_METRICS_TTL_MS = 30_000;
const adminReportMetricsCache = new Map<string, { expiresAt: number; value: AdminReportMetrics }>();
const adminReportMetricsInFlight = new Map<string, Promise<AdminReportMetrics>>();

async function getCachedAdminReportMetrics(officialAccountId: string | null) {
  const cacheKey = officialAccountId ?? "__global__";
  const now = Date.now();
  const cached = adminReportMetricsCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return {
      metrics: cached.value,
      cacheHit: true,
    };
  }

  const inflight = adminReportMetricsInFlight.get(cacheKey);
  if (inflight) {
    return {
      metrics: await inflight,
      cacheHit: true,
    };
  }

  const promise = getAdminReportMetrics(officialAccountId);
  adminReportMetricsInFlight.set(cacheKey, promise);
  try {
    const metrics = await promise;
    adminReportMetricsCache.set(cacheKey, {
      value: metrics,
      expiresAt: now + ADMIN_REPORT_METRICS_TTL_MS,
    });
    return {
      metrics,
      cacheHit: false,
    };
  } finally {
    adminReportMetricsInFlight.delete(cacheKey);
  }
}

function serializeAdminReportMetrics(metrics: AdminReportMetrics) {
  return {
    ...metrics,
    memberTrend: metrics.memberTrend.map((row) => ({
      day: row.day.toISOString(),
      members: row.members,
    })),
    repeaterTrend: metrics.repeaterTrend.map((row) => ({
      day: row.day.toISOString(),
      repeaters: row.repeaters,
    })),
    visitTrend: metrics.visitTrend.map((row) => ({
      day: row.day.toISOString(),
      newVisits: row.newVisits,
      repeatVisits: row.repeatVisits,
      totalVisits: row.totalVisits,
    })),
    latestDelivery: metrics.latestDelivery
      ? {
          ...metrics.latestDelivery,
          sentAt: metrics.latestDelivery.sentAt.toISOString(),
        }
      : null,
  };
}

export async function getAdminReportMetricsResponse(officialAccountId: string | null) {
  const { metrics } = await getCachedAdminReportMetrics(officialAccountId);
  return serializeAdminReportMetrics(metrics);
}

export const appRouter = {
  system: {
    health: os.handler(() => {
      return {
        ok: true,
        message: "oRPC server is running",
        timestamp: new Date().toISOString(),
      };
    }),
    greet: os
      .input(
        z.object({
          name: z.string().min(1).default("ゲスト"),
        }),
      )
      .handler(({ input }) => {
        return {
          message: `こんにちは、${input.name}さん`,
        };
      }),
  },
  user: {
    upsertFromLiff: os
      .input(
        z.object({
          userId: z.string().min(1),
          displayName: z.string().min(1),
          pictureUrl: z.string().optional(),
        }),
      )
      .handler(async ({ input }) => {
        const startedAt = Date.now();
        const ranksPromise = getCachedRanks();
        const officialAccountId = await resolveOfficialAccountId();
        const officialResolvedAt = Date.now();
        const upsertRows = await prisma.$queryRaw<UpsertedLiffUserRow[]>`
          WITH existed AS (
            SELECT 1 AS "present"
            FROM "users"
            WHERE "userId" = ${input.userId}
            LIMIT 1
          ),
          upserted AS (
            INSERT INTO "users" (
              "userId",
              "displayName",
              "pictureUrl",
              "points",
              "officialAccountId",
              "officialLinkedAt",
              "createdAt",
              "updatedAt"
            )
            VALUES (
              ${input.userId},
              ${input.displayName},
              ${input.pictureUrl ?? null},
              ${SIGNUP_INITIAL_POINTS},
              ${officialAccountId},
              ${officialAccountId ? new Date() : null},
              NOW(),
              NOW()
            )
            ON CONFLICT ("userId") DO UPDATE
            SET
              "displayName" = EXCLUDED."displayName",
              "pictureUrl" = COALESCE(EXCLUDED."pictureUrl", "users"."pictureUrl"),
              "officialAccountId" = COALESCE("users"."officialAccountId", EXCLUDED."officialAccountId"),
              "officialLinkedAt" = CASE
                WHEN "users"."officialAccountId" IS NULL AND EXCLUDED."officialAccountId" IS NOT NULL
                  THEN NOW()
                ELSE "users"."officialLinkedAt"
              END,
              "updatedAt" = NOW()
            WHERE
              "users"."displayName" IS DISTINCT FROM EXCLUDED."displayName"
              OR EXCLUDED."pictureUrl" IS NOT NULL AND "users"."pictureUrl" IS DISTINCT FROM EXCLUDED."pictureUrl"
              OR ("users"."officialAccountId" IS NULL AND EXCLUDED."officialAccountId" IS NOT NULL)
            RETURNING
              "userId",
              "points",
              "nextRank",
              "role",
              "lastCheckInAt",
              "surveyId",
              "googleReviewId"
          )
          SELECT
            u."userId",
            u."points",
            u."nextRank",
            u."role",
            u."lastCheckInAt",
            u."surveyId",
            u."googleReviewId",
            NOT EXISTS (SELECT 1 FROM existed) AS "isNew"
          FROM upserted u
          UNION ALL
          SELECT
            u2."userId",
            u2."points",
            u2."nextRank",
            u2."role",
            u2."lastCheckInAt",
            u2."surveyId",
            u2."googleReviewId",
            NOT EXISTS (SELECT 1 FROM existed) AS "isNew"
          FROM "users" u2
          WHERE u2."userId" = ${input.userId}
            AND NOT EXISTS (SELECT 1 FROM upserted)
          LIMIT 1
        `;
        const user = upsertRows[0];
        if (!user) {
          throw new Error("ユーザーの同期に失敗しました。");
        }
        const upsertedAt = Date.now();

        const ranks = await ranksPromise;
        const currentRank = findRankByPoints(ranks, user.points);
        const nextRank = findNextRankByPoints(ranks, user.points);
        const rankedAt = Date.now();
        const checkedInToday = isCheckedInToday(user.lastCheckInAt);
        let signupGiftTitle: string | null = null;
        if (user.isNew) {
          const benefitSetting = await getMemberBenefitSetting(officialAccountId);
          if (benefitSetting?.signupGiftId) {
            signupGiftTitle = await issueGiftFromSetting({
              userId: user.userId,
              giftId: benefitSetting.signupGiftId,
              officialAccountId,
              action: "member_signup_gift_granted",
              dedupeKey: "eventKey",
              dedupeValue: "signup",
            });
          }
          await sendLineDeliveryTriggers({
            triggerType: "USER_SIGNUP",
            officialAccountId,
            targetUserId: user.userId,
          });
        }

        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs >= 500) {
          console.info("[user.upsertFromLiff-ms]", {
            total: elapsedMs,
            resolveOfficialAccountId: officialResolvedAt - startedAt,
            upsertUser: upsertedAt - officialResolvedAt,
            resolveRanks: rankedAt - upsertedAt,
          });
        }

        return {
          ok: true,
          provider: "prisma",
          points: user.points,
          nextRank: currentRank.id,
          currentRankName: currentRank.name,
          nextRankName: nextRank?.name ?? null,
          pointsToNextRank: nextRank ? Math.max(nextRank.minPoints - user.points, 0) : 0,
          checkedInToday,
          hasSurvey: Boolean(user.surveyId),
          hasGoogleReview: Boolean(user.googleReviewId),
          role: user.role,
          signupGiftTitle,
        };
      }),
    getStaffStoreStatus: os
      .input(
        z.object({
          userId: z.string().min(1),
        }),
      )
      .handler(async ({ input }) => {
        const officialAccountId = await resolveOfficialAccountId();
        if (!officialAccountId) {
          return {
            ok: true,
            authorized: false,
            isOpen: false,
            canOpen: false,
            canClose: false,
          };
        }

        const user = await prisma.user.findUnique({
          where: { userId: input.userId },
          select: {
            userId: true,
            role: true,
            officialAccountId: true,
          },
        });
        if (!user) {
          throw new Error("ユーザーが見つかりません。");
        }
        if (user.role !== "staff" || user.officialAccountId !== officialAccountId) {
          return {
            ok: true,
            authorized: false,
            isOpen: false,
            canOpen: false,
            canClose: false,
          };
        }

        const permission = await prisma.staffStoreOperationPermission.findUnique({
          where: {
            userId_officialAccountId: {
              userId: user.userId,
              officialAccountId,
            },
          },
          select: {
            canOpen: true,
            canClose: true,
          },
        });
        if (!permission) {
          return {
            ok: true,
            authorized: false,
            isOpen: false,
            canOpen: false,
            canClose: false,
          };
        }

        const status = await prisma.storeStatus.upsert({
          where: { officialAccountId },
          create: {
            officialAccountId,
            isOpen: false,
          },
          update: {},
          select: { isOpen: true },
        });

        return {
          ok: true,
          authorized: true,
          isOpen: status.isOpen,
          canOpen: permission.canOpen,
          canClose: permission.canClose,
        };
      }),
    getStoreStatus: os
      .input(z.object({}))
      .handler(async () => {
        const officialAccountId = await resolveOfficialAccountId();
        if (!officialAccountId) {
          return {
            ok: true,
            isOpen: false,
          };
        }

        const status = await prisma.storeStatus.upsert({
          where: { officialAccountId },
          create: {
            officialAccountId,
            isOpen: false,
          },
          update: {},
          select: { isOpen: true },
        });

        return {
          ok: true,
          isOpen: status.isOpen,
        };
      }),
    toggleStaffStoreStatus: os
      .input(
        z.object({
          userId: z.string().min(1),
          action: z.enum(["open", "close"]),
        }),
      )
      .handler(async ({ input }) => {
        const officialAccountId = await resolveOfficialAccountId();
        if (!officialAccountId) {
          throw new Error("公式アカウント設定が見つかりません。");
        }

        const user = await prisma.user.findUnique({
          where: { userId: input.userId },
          select: {
            userId: true,
            role: true,
            officialAccountId: true,
          },
        });
        if (!user) {
          throw new Error("ユーザーが見つかりません。");
        }
        if (user.role !== "staff" || user.officialAccountId !== officialAccountId) {
          throw new Error("この操作を行う権限がありません。");
        }

        const permission = await prisma.staffStoreOperationPermission.findUnique({
          where: {
            userId_officialAccountId: {
              userId: user.userId,
              officialAccountId,
            },
          },
          select: {
            canOpen: true,
            canClose: true,
          },
        });
        if (!permission) {
          throw new Error("この操作を行う権限がありません。");
        }
        if (input.action === "open" && !permission.canOpen) {
          throw new Error("開店権限がありません。");
        }
        if (input.action === "close" && !permission.canClose) {
          throw new Error("閉店権限がありません。");
        }

        const nextIsOpen = input.action === "open";
        const status = await prisma.storeStatus.upsert({
          where: { officialAccountId },
          create: {
            officialAccountId,
            isOpen: nextIsOpen,
          },
          update: {
            isOpen: nextIsOpen,
          },
          select: {
            isOpen: true,
          },
        });

        return {
          ok: true,
          isOpen: status.isOpen,
        };
      }),
    listStaffLoginOptions: os
      .input(z.object({}))
      .handler(async () => {
        if (process.env.NODE_ENV === "production") {
          return {
            ok: true,
            staff: [],
          };
        }

        const officialAccountId = await resolveOfficialAccountId();
        const permissions = await prisma.staffStoreOperationPermission.findMany({
          where: officialAccountId ? { officialAccountId } : undefined,
          orderBy: {
            createdAt: "desc",
          },
          select: {
            officialAccountId: true,
            user: {
              select: {
                userId: true,
                displayName: true,
                pictureUrl: true,
                role: true,
              },
            },
          },
          take: 50,
        });

        return {
          ok: true,
          staff: permissions
            .filter((permission) => permission.user.role === "staff")
            .map((permission) => ({
              userId: permission.user.userId,
              displayName: permission.user.displayName,
              pictureUrl: permission.user.pictureUrl,
              officialAccountId: permission.officialAccountId,
            })),
        };
      }),
    createDevStaffLogin: os
      .input(
        z.object({
          displayName: z.string().trim().min(1).max(40).optional().default("ローカルスタッフ"),
        }),
      )
      .handler(async ({ input }) => {
        if (process.env.NODE_ENV === "production") {
          throw new Error("開発環境でのみ利用できます。");
        }

        let officialAccountId = await resolveOfficialAccountId();
        if (!officialAccountId) {
          const account = await prisma.officialAccount.upsert({
            where: { lineBasicId: "local-dev" },
            create: {
              lineBasicId: "local-dev",
              name: "ローカル開発店舗",
            },
            update: {
              name: "ローカル開発店舗",
            },
            select: { id: true },
          });
          officialAccountId = account.id;
        }

        const userId = "dev-staff";
        const user = await prisma.user.upsert({
          where: { userId },
          create: {
            userId,
            displayName: input.displayName,
            role: "staff",
            officialAccountId,
            officialLinkedAt: new Date(),
          },
          update: {
            displayName: input.displayName,
            role: "staff",
            officialAccountId,
            officialLinkedAt: new Date(),
          },
          select: {
            userId: true,
            displayName: true,
            pictureUrl: true,
          },
        });

        await prisma.staffStoreOperationPermission.upsert({
          where: {
            userId_officialAccountId: {
              userId: user.userId,
              officialAccountId,
            },
          },
          create: {
            userId: user.userId,
            officialAccountId,
            canOpen: true,
            canClose: true,
          },
          update: {
            canOpen: true,
            canClose: true,
          },
        });

        return {
          ok: true,
          staff: {
            userId: user.userId,
            displayName: user.displayName,
            pictureUrl: user.pictureUrl,
            officialAccountId,
          },
        };
      }),
    getStaffShiftSubmission: os
      .input(
        z.object({
          userId: z.string().min(1),
          month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "対象月が不正です。"),
        }),
      )
      .handler(async ({ input }) => {
        const scope = await resolveStaffScope(input.userId);
        const [submission, schedule] = await Promise.all([
          prisma.staffShiftSubmission.findUnique({
            where: {
              userId_officialAccountId_month: {
                userId: scope.userId,
                officialAccountId: scope.officialAccountId,
                month: input.month,
              },
            },
            select: {
              id: true,
              submittedAt: true,
              updatedAt: true,
              entries: {
                orderBy: { day: "asc" },
                select: {
                  day: true,
                  status: true,
                  startTime: true,
                  endTime: true,
                  memo: true,
                },
              },
            },
          }),
          prisma.staffShiftSchedule.findUnique({
          where: {
            officialAccountId_month: {
              officialAccountId: scope.officialAccountId,
              month: input.month,
            },
          },
          select: {
            assignments: {
              where: { userId: scope.userId },
              orderBy: [{ day: "asc" }, { startTime: "asc" }],
              select: {
                day: true,
                startTime: true,
                endTime: true,
                memo: true,
              },
            },
          },
          }),
        ]);

        return {
          ok: true,
          staffName: scope.displayName,
          month: input.month,
          submittedAt: submission?.submittedAt?.toISOString() ?? null,
          updatedAt: submission?.updatedAt.toISOString() ?? null,
          entries: (submission?.entries ?? []).map((entry) => ({
            day: entry.day,
            status: entry.status as StaffShiftAvailabilityStatusValue,
            startTime: entry.startTime,
            endTime: entry.endTime,
            memo: entry.memo,
          })),
          confirmedAssignments: (schedule?.assignments ?? []).map((assignment) => ({
            day: assignment.day,
            startTime: assignment.startTime,
            endTime: assignment.endTime,
            memo: assignment.memo,
          })),
        };
      }),
    saveStaffShiftSubmission: os
      .input(
        z.object({
          userId: z.string().min(1),
          month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "対象月が不正です。"),
          entries: z.array(
            z.object({
              day: z.number().int().min(1).max(31),
              status: z.enum(["UNSET", "AVAILABLE", "UNAVAILABLE"]),
              startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
              endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
              memo: z.string().trim().max(200).nullable().optional(),
            }),
          ),
        }),
      )
      .handler(async ({ input }) => {
        const scope = await resolveStaffScope(input.userId);
        const existingSubmission = await prisma.staffShiftSubmission.findUnique({
          where: {
            userId_officialAccountId_month: {
              userId: scope.userId,
              officialAccountId: scope.officialAccountId,
              month: input.month,
            },
          },
          select: {
            id: true,
            submittedAt: true,
          },
        });
        if (existingSubmission?.submittedAt) {
          throw new Error("提出済みの希望シフトは修正できません。");
        }

        const daysInMonth = getDaysInShiftMonth(input.month);
        const normalizedEntries = input.entries
          .filter((entry) => entry.day <= daysInMonth)
          .map((entry) => ({
            day: entry.day,
            status: entry.status,
            startTime: entry.status === "AVAILABLE" ? (entry.startTime ?? null) : null,
            endTime: entry.status === "AVAILABLE" ? (entry.endTime ?? null) : null,
            memo: entry.memo?.trim() || null,
          }));

        for (const entry of normalizedEntries) {
          if (entry.status === "AVAILABLE" && (!entry.startTime || !entry.endTime)) {
            throw new Error(`${entry.day}日の出勤可能時間を入力してください。`);
          }
          if (entry.status === "AVAILABLE" && entry.startTime && entry.endTime && entry.startTime >= entry.endTime) {
            throw new Error(`${entry.day}日の終了時刻は開始時刻より後にしてください。`);
          }
        }

        const submission = await prisma.staffShiftSubmission.upsert({
          where: {
            userId_officialAccountId_month: {
              userId: scope.userId,
              officialAccountId: scope.officialAccountId,
              month: input.month,
            },
          },
          create: {
            userId: scope.userId,
            officialAccountId: scope.officialAccountId,
            month: input.month,
            submittedAt: new Date(),
          },
          update: {
            submittedAt: new Date(),
          },
          select: {
            id: true,
          },
        });

        await prisma.$transaction(async (tx) => {
          await tx.staffShiftAvailability.deleteMany({
            where: { submissionId: submission.id },
          });
          if (normalizedEntries.length > 0) {
            await tx.staffShiftAvailability.createMany({
              data: normalizedEntries.map((entry) => ({
                submissionId: submission.id,
                day: entry.day,
                status: entry.status,
                startTime: entry.startTime,
                endTime: entry.endTime,
                memo: entry.memo,
              })),
            });
          }
        });

        return {
          ok: true,
          submittedAt: new Date().toISOString(),
        };
      }),
    getOnboardingSurveyQuestions: os
      .input(z.object({}))
      .handler(async () => {
        const officialAccountId = await resolveOfficialAccountId();
        const rows = await ensureOnboardingSurveySettings(officialAccountId);
        return {
          ok: true,
          questions: rows
            .slice()
            .sort((a: OnboardingSurveySettingRow, b: OnboardingSurveySettingRow) => a.sortOrder - b.sortOrder)
            .map((row: OnboardingSurveySettingRow) => ({
              id: row.id,
              questionKey: row.questionKey,
              presetKey: row.presetKey,
              questionType: row.questionType,
              label: row.label,
              options: row.options,
              placeholder: row.placeholder,
              isEnabled: row.isEnabled,
              isRequired: row.isRequired,
              sortOrder: row.sortOrder,
            })),
        };
      }),
    submitOnboardingSurvey: os
      .input(
        z.object({
          userId: z.string().min(1),
          answers: z.array(
            z.object({
              questionKey: z.string().min(1),
              value: z.string().min(1),
            }),
          ),
        }),
      )
      .handler(async ({ input }) => {
        const existingUser = await prisma.user.findUnique({
          where: { userId: input.userId },
          select: { surveyId: true, officialAccountId: true },
        });
        if (!existingUser) {
          throw new Error("ユーザーが見つかりません。");
        }

        const settings = await ensureOnboardingSurveySettings(existingUser.officialAccountId ?? null);
        const enabledSettings = settings.filter((row: OnboardingSurveySettingRow) => row.isEnabled);
        const answerByQuestionKey = new Map(input.answers.map((answer) => [answer.questionKey, answer.value.trim()]));
        for (const questionKey of answerByQuestionKey.keys()) {
          if (!enabledSettings.some((row: OnboardingSurveySettingRow) => row.questionKey === questionKey)) {
            throw new Error("無効な質問が送信されました。");
          }
        }

        for (const row of enabledSettings) {
          const value = answerByQuestionKey.get(row.questionKey) ?? "";
          if (row.isRequired && value.length === 0) {
            throw new Error(`「${row.label}」は必須です。`);
          }
        }

        type ParsedSurveyAnswer = {
          row: OnboardingSurveySettingRow;
          valueOption: string | null;
          valueText: string | null;
          valueDate: Date | null;
        };
        const parsedAnswers: ParsedSurveyAnswer[] = enabledSettings.flatMap((row) => {
          const value = answerByQuestionKey.get(row.questionKey) ?? "";
          if (value.length === 0) {
            return [];
          }
          if (row.questionType === "single_select") {
            const options = row.options ?? [];
            const matched = options.find((option: OnboardingSurveyOption) => option.value === value);
            if (!matched) {
              throw new Error(`「${row.label}」の選択肢が不正です。`);
            }
            const answer: ParsedSurveyAnswer = {
              row,
              valueOption: matched.value,
              valueText: matched.label,
              valueDate: null,
            };
            return [answer];
          }
          if (row.questionType === "date") {
            const parsed = new Date(value);
            if (Number.isNaN(parsed.getTime())) {
              throw new Error(`「${row.label}」の日付形式が不正です。`);
            }
            const answer: ParsedSurveyAnswer = {
              row,
              valueOption: null,
              valueText: null,
              valueDate: parsed,
            };
            return [answer];
          }
          const answer: ParsedSurveyAnswer = {
            row,
            valueOption: null,
            valueText: value,
            valueDate: null,
          };
          return [answer];
        });

        const getPresetValue = (presetKey: OnboardingSurveyPresetKey) => {
          const preset = getOnboardingSurveyPresetByPresetKey(presetKey);
          if (!preset) return null;
          return answerByQuestionKey.get(preset.questionKey) ?? null;
        };
        const birthDateRaw = getPresetValue("birthDate");
        const parsedBirthDate = birthDateRaw ? new Date(birthDateRaw) : null;
        if (birthDateRaw && (!parsedBirthDate || Number.isNaN(parsedBirthDate.getTime()))) {
          throw new Error("生年月日の形式が不正です。");
        }

        const surveyPayload = {
          gender: getPresetValue("gender"),
          visitFrequency: getPresetValue("visitFrequency"),
          companionType: getPresetValue("companionType"),
          birthDate: parsedBirthDate,
        };

        let surveyId = existingUser.surveyId;
        if (surveyId) {
          await prisma.userSurvey.update({
            where: { id: surveyId },
            data: surveyPayload as never,
          });
        } else {
          const created = await prisma.userSurvey.create({
            data: surveyPayload as never,
          });
          surveyId = created.id;
          await prisma.user.update({
            where: { userId: input.userId },
            data: { surveyId },
          });
        }

        if (!surveyId) {
          throw new Error("アンケート保存に失敗しました。");
        }
        await prisma.$transaction(async (tx) => {
          const txUnsafe = tx as unknown as {
            onboardingSurveyAnswer: {
              deleteMany: (args: unknown) => Promise<unknown>;
              createMany: (args: unknown) => Promise<unknown>;
            };
          };
          await txUnsafe.onboardingSurveyAnswer.deleteMany({
            where: { surveyId },
          });
          if (parsedAnswers.length > 0) {
            await txUnsafe.onboardingSurveyAnswer.createMany({
              data: parsedAnswers.map((answer) => ({
                surveyId,
                questionId: answer.row.id,
                questionKey: answer.row.questionKey,
                valueOption: answer.valueOption,
                valueText: answer.valueText,
                valueDate: answer.valueDate,
              })),
            });
          }
        });

        return {
          ok: true,
          surveyId,
        };
      }),
    listOwnedGifts: os
      .input(
        z.object({
          userId: z.string().min(1),
        }),
      )
      .handler(async ({ input }) => {
        const now = new Date();
        const gifts = await prisma.userGift.findMany({
          where: {
            userId: input.userId,
            isUsed: false,
            expiresAt: {
              gte: now,
            },
          },
          orderBy: [{ issuedAt: "desc" }, { createdAt: "desc" }],
          select: {
            id: true,
            expiresAt: true,
            gift: {
              select: {
                id: true,
                title: true,
                usageGuide: true,
                imageUrl: true,
              },
            },
          },
        });

        return {
          ok: true,
          gifts: gifts.map((row) => ({
            userGiftId: row.id,
            giftId: row.gift.id,
            title: row.gift.title,
            usageGuide: row.gift.usageGuide,
            imageUrl: row.gift.imageUrl,
            expiresAt: row.expiresAt.toISOString(),
          })),
        };
      }),
    useGift: os
      .input(
        z.object({
          userId: z.string().min(1),
          userGiftId: z.string().min(1),
        }),
      )
      .handler(async ({ input }) => {
        const now = new Date();
        const updated = await prisma.userGift.updateMany({
          where: {
            id: input.userGiftId,
            userId: input.userId,
            isUsed: false,
            expiresAt: {
              gte: now,
            },
          },
          data: {
            isUsed: true,
            usedAt: now,
          },
        });

        if (updated.count === 0) {
          throw new Error("特典の利用に失敗しました。期限切れまたは利用済みの可能性があります。");
        }

        return {
          ok: true,
          userGiftId: input.userGiftId,
        };
      }),
    claimGiftFromLink: os
      .input(
        z.object({
          userId: z.string().min(1),
          giftId: z.string().min(1),
        }),
      )
      .handler(async ({ input }) => {
        const [user, gift] = await Promise.all([
          prisma.user.findUnique({
            where: { userId: input.userId },
            select: {
              userId: true,
              officialAccountId: true,
            },
          }),
          prisma.gift.findUnique({
            where: { id: input.giftId },
            select: {
              id: true,
              title: true,
              expiryType: true,
              expiryDays: true,
              expiryAt: true,
            },
          }),
        ]);
        if (!user) {
          throw new Error("ユーザーが見つかりません。");
        }
        if (!gift) {
          throw new Error("ギフトが見つかりません。");
        }

        const expiresAt = resolveGiftExpiryAt(gift);
        if (!expiresAt) {
          throw new Error("このギフトは配布できません。期限設定を確認してください。");
        }

        const createdRows = await prisma.$queryRaw<Array<{ id: string }>>`
          WITH inserted AS (
            INSERT INTO "user_gifts"
              ("id", "userId", "giftId", "isUsed", "issuedAt", "expiresAt", "createdAt", "updatedAt")
            SELECT
              md5(random()::text || clock_timestamp()::text),
              ${user.userId},
              ${gift.id},
              false,
              NOW(),
              ${expiresAt},
              NOW(),
              NOW()
            WHERE NOT EXISTS (
              SELECT 1
              FROM "user_history" h
              WHERE h."targetUserId" = ${user.userId}
                AND h."action" = 'spot_delivery_gift_claimed'
                AND h."metadata"->>'giftId' = ${gift.id}
            )
            RETURNING "id"
          )
          SELECT "id"
          FROM inserted
          LIMIT 1
        `;
        const created = createdRows[0] ?? null;
        if (!created) {
          return {
            ok: true,
            giftTitle: gift.title,
            userGiftId: null,
            alreadyClaimed: true,
          };
        }

        await prisma.$executeRaw`
          INSERT INTO "user_history"
            ("id", "targetUserId", "actorType", "actorId", "action", "metadata", "officialAccountId", "createdAt")
          VALUES
            (
              md5(random()::text || clock_timestamp()::text),
              ${user.userId},
              'system',
              'spot_delivery',
              'spot_delivery_gift_claimed',
              ${JSON.stringify({
                giftId: gift.id,
                giftTitle: gift.title,
                userGiftId: created.id,
              })}::jsonb,
              ${user.officialAccountId},
              NOW()
            )
        `;

        return {
          ok: true,
          giftTitle: gift.title,
          userGiftId: created.id,
          alreadyClaimed: false,
        };
      }),
    claimReviewGiftWithPassword: os
      .input(
        z.object({
          userId: z.string().min(1),
          password: z.string().regex(/^\d{4}$/),
        }),
      )
      .handler(async ({ input }) => {
        const user = await prisma.user.findUnique({
          where: { userId: input.userId },
          select: {
            userId: true,
            officialAccountId: true,
            googleReviewId: true,
          },
        });
        if (!user) {
          throw new ORPCError("NOT_FOUND", {
            message: "ユーザーが見つかりません。",
            defined: true,
          });
        }
        if (user.googleReviewId) {
          return {
            ok: true,
            alreadyReviewed: true,
            giftTitle: null as string | null,
          };
        }

        const benefitResolution = await resolveMemberBenefitSettingForUser(user.officialAccountId);
        const benefitSetting = benefitResolution?.setting ?? null;
        const officialAccountId =
          benefitResolution?.officialAccountId ??
          user.officialAccountId ??
          (await resolveOfficialAccountId());
        if (!benefitSetting?.reviewGiftId) {
          throw new ORPCError("BAD_REQUEST", {
            message: "口コミ特典ギフトが未設定です。管理画面の会員設定で口コミ特典を設定してください。",
            defined: true,
          });
        }
        if (!benefitSetting.reviewPasswordHash) {
          throw new ORPCError("BAD_REQUEST", {
            message: "口コミパスワードが未設定です。管理画面で口コミパスワードを設定してください。",
            defined: true,
          });
        }

        const inputHash = hashReviewPassword(input.password);
        if (inputHash !== benefitSetting.reviewPasswordHash) {
          throw new ORPCError("BAD_REQUEST", {
            message: "パスワードが正しくありません。",
            defined: true,
          });
        }

        const grantedTitle = await issueGiftFromSetting({
          userId: user.userId,
          giftId: benefitSetting.reviewGiftId,
          officialAccountId,
          action: "member_google_review_gift_granted",
          dedupeKey: "eventKey",
          dedupeValue: "google_review",
        });

        if (!grantedTitle) {
          return {
            ok: true,
            alreadyReviewed: true,
            giftTitle: null as string | null,
          };
        }

        const review = await prisma.googleReview.create({
          data: {
            reviewText: "google-review-verified",
          },
          select: {
            id: true,
          },
        });
        await prisma.user.update({
          where: { userId: user.userId },
          data: {
            googleReviewId: review.id,
          },
        });

        return {
          ok: true,
          alreadyReviewed: false,
          giftTitle: grantedTitle,
        };
      }),
    challengeVisitGacha: os
      .input(
        z.object({
          userId: z.string().min(1),
        }),
      )
      .handler(async ({ input }) => {
        const user = await prisma.user.findUnique({
          where: { userId: input.userId },
          select: {
            userId: true,
            officialAccountId: true,
            lastCheckInAt: true,
            createdAt: true,
          },
        });
        if (!user) {
          throw new Error("ユーザーが見つかりません。");
        }
        if (!isCheckedInToday(user.lastCheckInAt)) {
          throw new Error("本日の来店チェックイン後にガチャへ参加してください。");
        }

        const gachaLogRows = await prisma.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS "count"
          FROM "user_history"
          WHERE "targetUserId" = ${user.userId}
            AND "action" IN ('visit_gacha_won', 'visit_gacha_lost')
            AND "createdAt" >= ${getStartOfTodayInJstUtc()}
        `;
        if ((gachaLogRows[0]?.count ?? 0) > 0) {
          return {
            ok: true,
            executed: false,
            alreadyChallengedToday: true,
            won: false,
            winProbability: 0,
            giftTitle: null as string | null,
            resultImageUrl: null as string | null,
          };
        }

        const startOfTodayInJstUtc = getStartOfTodayInJstUtc();
        if (isCreatedTodayInJst(user.createdAt, startOfTodayInJstUtc)) {
          return {
            ok: true,
            executed: false,
            alreadyChallengedToday: false,
            won: false,
            winProbability: 0,
            giftTitle: null as string | null,
            resultImageUrl: null as string | null,
          };
        }

        const officialAccountId = user.officialAccountId ?? (await resolveOfficialAccountId());
        const gacha = await runVisitGacha(user.userId, user.officialAccountId);
        if (!gacha.executed) {
          return {
            ok: true,
            executed: false,
            alreadyChallengedToday: false,
            won: false,
            winProbability: gacha.winProbability,
            giftTitle: null as string | null,
            resultImageUrl: null as string | null,
          };
        }

        await prisma.$executeRaw`
          INSERT INTO "user_history"
            ("id", "targetUserId", "actorType", "actorId", "action", "metadata", "officialAccountId", "createdAt")
          VALUES
            (
              md5(random()::text || clock_timestamp()::text),
              ${user.userId},
              'system',
              'visit_gacha',
              ${gacha.won ? "visit_gacha_won" : "visit_gacha_lost"},
              ${JSON.stringify({
                winProbability: gacha.winProbability,
                giftTitle: gacha.giftTitle,
              })}::jsonb,
              ${officialAccountId},
              NOW()
            )
        `;

        return {
          ok: true,
          executed: true,
          alreadyChallengedToday: false,
          won: gacha.won,
          winProbability: gacha.winProbability,
          giftTitle: gacha.giftTitle,
          resultImageUrl: gacha.resultImageUrl,
        };
      }),
    addVisitPoint: os
      .input(
        z.object({
          userId: z.string().min(1),
          qrValue: z.string().min(1),
        }),
      )
      .handler(async ({ input }) => {
        const expectedQrToken = process.env.VISIT_QR_TOKEN;
        if (expectedQrToken && !matchesVisitQrToken(input.qrValue.trim(), expectedQrToken)) {
          throw new Error("無効なQRコードです。");
        }

        const startOfTodayInJstUtc = getStartOfTodayInJstUtc();
        const now = new Date();

        const updatedCount =         await prisma.$executeRaw`
          UPDATE "users"
          SET "points" = "points" + 1,
              "visitCount" = "visitCount" + 1,
              "lastCheckInAt" = ${now}
          WHERE "userId" = ${input.userId}
            AND ("lastCheckInAt" IS NULL OR "lastCheckInAt" < ${startOfTodayInJstUtc})
        `;

        if (Number(updatedCount) === 0) {
          const existingUser = await prisma.user.findUnique({
            where: {
              userId: input.userId,
            },
          });
          if (!existingUser) {
            throw new Error("ユーザーが見つかりません。");
          }
          const currentRank = await resolveRankByPoints(existingUser.points);
          const nextRank = await resolveNextRankByPoints(existingUser.points);
          return {
            ok: true,
            points: existingUser.points,
            currentRankName: currentRank.name,
            nextRankName: nextRank?.name ?? null,
            pointsToNextRank: nextRank ? Math.max(nextRank.minPoints - existingUser.points, 0) : 0,
            checkedInToday: true,
            alreadyCheckedInToday: true,
            grantedGiftTitles: [] as string[],
            gacha: {
              eligible: false,
              winProbability: 0,
              previewGift: null,
            },
          };
        }

        const updatedUser = await prisma.user.findUnique({
          where: {
            userId: input.userId,
          },
          select: {
            userId: true,
            points: true,
            nextRank: true,
            createdAt: true,
          },
        });

        if (!updatedUser) {
          throw new Error("ユーザーが見つかりません。");
        }

        const currentRank = await resolveRankByPoints(updatedUser.points);
        const rankUpOccurred = updatedUser.nextRank !== currentRank.id;
        if (rankUpOccurred) {
          await prisma.user.update({
            where: {
              userId: updatedUser.userId,
            },
            data: {
              nextRank: currentRank.id,
            },
          });
        }

        const nextRank = await resolveNextRankByPoints(updatedUser.points);

        const checkInCountRows = await prisma.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS "count"
          FROM "user_checkins"
          WHERE "userId" = ${updatedUser.userId}
        `;
        const checkInCount = checkInCountRows[0]?.count ?? 0;
        const nextCheckInCount = checkInCount + 1;
        const isFirstVisit = checkInCount === 0;
        const userOfficialRows = await prisma.$queryRaw<Array<{ officialAccountId: string | null }>>`
          SELECT "officialAccountId"
          FROM "users"
          WHERE "userId" = ${updatedUser.userId}
          LIMIT 1
        `;
        const userOfficialAccountId = userOfficialRows[0]?.officialAccountId ?? null;
        const officialAccountId = userOfficialAccountId ?? (await resolveOfficialAccountId());

        await prisma.$executeRaw`
          INSERT INTO "user_checkins"
            ("id", "userId", "checkedInAt", "isFirstVisit", "isRepeatVisit", "officialAccountId", "createdAt")
          VALUES
            (
              md5(random()::text || clock_timestamp()::text),
              ${updatedUser.userId},
              ${now},
              ${isFirstVisit},
              ${!isFirstVisit},
              ${officialAccountId},
              NOW()
            )
        `;

        await prisma.$executeRaw`
          INSERT INTO "user_history"
            ("id", "targetUserId", "actorType", "actorId", "action", "metadata", "officialAccountId", "createdAt")
          VALUES
            (
              md5(random()::text || clock_timestamp()::text),
              ${updatedUser.userId},
              'system',
              'checkin_qr',
              'checkin_point_granted',
              ${JSON.stringify({
                qrValue: input.qrValue,
                pointsAfter: updatedUser.points,
                currentRankName: currentRank.name,
              })}::jsonb,
              ${officialAccountId},
              NOW()
            )
        `;

        const grantedGiftTitles: string[] = [];
        const benefitSetting = await getMemberBenefitSetting(officialAccountId);
        if (benefitSetting) {
          const rankBenefitGiftId =
            benefitSetting.rankBenefitGiftSettings.find((row) => row.rankId === currentRank.id)?.giftId ?? null;
          if (rankBenefitGiftId && updatedUser.nextRank !== currentRank.id) {
            const rankGiftTitle = await issueGiftFromSetting({
              userId: updatedUser.userId,
              giftId: rankBenefitGiftId,
              officialAccountId,
              action: "member_rank_gift_granted",
              dedupeKey: "rankId",
              dedupeValue: currentRank.id,
              extraMetadata: {
                rankName: currentRank.name,
              },
            });
            if (rankGiftTitle) {
              grantedGiftTitles.push(rankGiftTitle);
            }
          }

          const cachedRanks = await getCachedRanks();
          const highestRank = cachedRanks[cachedRanks.length - 1];
          const shouldIssueTopLoopGift =
            highestRank &&
            currentRank.id === highestRank.id &&
            nextCheckInCount > 0 &&
            nextCheckInCount % 10 === 0;
          if (shouldIssueTopLoopGift && benefitSetting.topRankLoopGiftId) {
            const topLoopGiftTitle = await issueGiftFromSetting({
              userId: updatedUser.userId,
              giftId: benefitSetting.topRankLoopGiftId,
              officialAccountId,
              action: "member_top_rank_loop_gift_granted",
              dedupeKey: "loopCount",
              dedupeValue: String(nextCheckInCount / 10),
              extraMetadata: {
                checkInCount: nextCheckInCount,
                rankId: currentRank.id,
                rankName: currentRank.name,
              },
            });
            if (topLoopGiftTitle) {
              grantedGiftTitles.push(topLoopGiftTitle);
            }
          }
        }

        const gacha = isCreatedTodayInJst(updatedUser.createdAt, startOfTodayInJstUtc)
          ? {
              eligible: false,
              winProbability: 0,
              previewGift: null,
            }
          : await getVisitGachaPreview(updatedUser.userId, userOfficialAccountId);

        await sendLineDeliveryTriggers({
          triggerType: "CHECKIN_POINT_GRANTED",
          officialAccountId,
          targetUserId: updatedUser.userId,
        });
        if (rankUpOccurred) {
          await sendLineDeliveryTriggers({
            triggerType: "RANK_UP",
            officialAccountId,
            targetUserId: updatedUser.userId,
          });
        }

        return {
          ok: true,
          points: updatedUser.points,
          currentRankName: currentRank.name,
          nextRankName: nextRank?.name ?? null,
          pointsToNextRank: nextRank ? Math.max(nextRank.minPoints - updatedUser.points, 0) : 0,
          checkedInToday: true,
          alreadyCheckedInToday: false,
          grantedGiftTitles,
          gacha,
        };
      }),
  },
  admin: {
    reportMetrics: os
      .input(z.object({}))
      .handler(async ({ context }) => {
        const startedAt = Date.now();
        const request = (context as { request?: Request } | undefined)?.request;
        if (!request) {
          throw new Error("リクエスト情報が見つかりません。");
        }

        const session = await adminAuth.api.getSession({
          headers: request.headers,
        });
        const sessionResolvedAt = Date.now();
        const adminId = session?.user?.username;
        if (!adminId) {
          throw new Error("管理者ログインが必要です。");
        }

        const adminScope = await prisma.adminUser.findUnique({
          where: { id: adminId },
          select: { officialAccountId: true },
        });
        const officialAccountId = adminScope?.officialAccountId ?? null;
        const scopeResolvedAt = Date.now();

        const { metrics, cacheHit } = await getCachedAdminReportMetrics(officialAccountId);
        const metricsResolvedAt = Date.now();
        const elapsedMs = metricsResolvedAt - startedAt;
        if (elapsedMs >= 500) {
          console.info("[admin.reportMetrics-ms]", {
            total: elapsedMs,
            resolveSession: sessionResolvedAt - startedAt,
            resolveScope: scopeResolvedAt - sessionResolvedAt,
            queryMetrics: metricsResolvedAt - scopeResolvedAt,
            cacheHit,
          });
        }

        return serializeAdminReportMetrics(metrics);
      }),
  },
};
