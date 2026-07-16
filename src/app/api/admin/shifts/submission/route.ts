import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAdminUser } from "@/lib/admin-guard";
import { prisma } from "@/lib/prisma";

const availabilitySchema = z.object({
  userId: z.string().min(1),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  day: z.number().int().min(1).max(31),
  status: z.enum(["UNSET", "AVAILABLE", "UNAVAILABLE"]),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  isFree: z.boolean().optional(),
});

const deleteAvailabilitySchema = z.object({
  userId: z.string().min(1),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  day: z.number().int().min(1).max(31),
});

const releaseSubmissionSchema = z.object({
  userId: z.string().min(1),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
});

function getDaysInMonth(month: string) {
  const [year, monthIndex] = month.split("-").map(Number);
  return new Date(year, monthIndex, 0).getDate();
}

function isQuarterHourTime(time: string) {
  return /^([01]\d|2[0-3]):(00|15|30|45)$/.test(time);
}

export async function PATCH(request: Request) {
  try {
    const adminUser = await requireAdminUser();
    if (!adminUser.officialAccountId) {
      return NextResponse.json(
        { ok: false, message: "公式アカウントに紐づく管理者のみ希望シフトを修正できます。" },
        { status: 403 },
      );
    }

    const parsed = availabilitySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, message: parsed.error.issues[0]?.message ?? "入力内容が不正です。" },
        { status: 400 },
      );
    }

    const { userId, month, day, status } = parsed.data;
    const isFree = status === "AVAILABLE" ? (parsed.data.isFree ?? false) : false;
    const startTime = status === "AVAILABLE" && !isFree ? (parsed.data.startTime ?? null) : null;
    const endTime = status === "AVAILABLE" && !isFree ? (parsed.data.endTime ?? null) : null;

    if (day > getDaysInMonth(month)) {
      return NextResponse.json({ ok: false, message: `${day}日は対象月に存在しません。` }, { status: 400 });
    }
    if (!isFree && status === "AVAILABLE" && (!startTime || !endTime)) {
      return NextResponse.json({ ok: false, message: "出勤可能時間を入力してください。" }, { status: 400 });
    }
    if (!isFree && status === "AVAILABLE" && ((startTime && !endTime) || (!startTime && endTime))) {
      return NextResponse.json(
        { ok: false, message: "開始時刻と終了時刻を両方入力するか、両方空にしてください。" },
        { status: 400 },
      );
    }
    if (!isFree && status === "AVAILABLE" && startTime && endTime && startTime >= endTime) {
      return NextResponse.json(
        { ok: false, message: "終了時刻は開始時刻より後にしてください。" },
        { status: 400 },
      );
    }
    if (!isFree && status === "AVAILABLE" && startTime && endTime && (!isQuarterHourTime(startTime) || !isQuarterHourTime(endTime))) {
      return NextResponse.json({ ok: false, message: "時刻は15分刻みで入力してください。" }, { status: 400 });
    }

    const permission = await prisma.staffStoreOperationPermission.findUnique({
      where: {
        userId_officialAccountId: {
          userId,
          officialAccountId: adminUser.officialAccountId,
        },
      },
      select: {
        user: {
          select: {
            role: true,
          },
        },
      },
    });
    if (!permission || permission.user.role !== "staff") {
      return NextResponse.json(
        { ok: false, message: "スタッフ権限がないユーザーは修正できません。" },
        { status: 400 },
      );
    }

    const submission = await prisma.staffShiftSubmission.upsert({
      where: {
        userId_officialAccountId_month: {
          userId,
          officialAccountId: adminUser.officialAccountId,
          month,
        },
      },
      create: {
        userId,
        officialAccountId: adminUser.officialAccountId,
        month,
        submittedAt: new Date(),
      },
      update: {
        submittedAt: new Date(),
      },
      select: {
        id: true,
      },
    });

    await prisma.staffShiftAvailability.upsert({
      where: {
        submissionId_day: {
          submissionId: submission.id,
          day,
        },
      },
      create: {
        submissionId: submission.id,
        day,
        status,
        startTime,
        endTime,
        isFree,
        memo: null,
      },
      update: {
        status,
        startTime,
        endTime,
        isFree,
        memo: null,
      },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("/api/admin/shifts/submission PATCH error", error);
    return NextResponse.json({ ok: false, message: "希望シフトの修正に失敗しました。" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const adminUser = await requireAdminUser();
    if (!adminUser.officialAccountId) {
      return NextResponse.json(
        { ok: false, message: "公式アカウントに紐づく管理者のみ希望シフトを削除できます。" },
        { status: 403 },
      );
    }

    const parsed = deleteAvailabilitySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, message: parsed.error.issues[0]?.message ?? "入力内容が不正です。" },
        { status: 400 },
      );
    }

    const { userId, month, day } = parsed.data;
    if (day > getDaysInMonth(month)) {
      return NextResponse.json({ ok: false, message: `${day}日は対象月に存在しません。` }, { status: 400 });
    }

    const submission = await prisma.staffShiftSubmission.findUnique({
      where: {
        userId_officialAccountId_month: {
          userId,
          officialAccountId: adminUser.officialAccountId,
          month,
        },
      },
      select: {
        id: true,
      },
    });
    if (!submission) {
      return NextResponse.json({ ok: true });
    }

    await prisma.staffShiftAvailability.deleteMany({
      where: {
        submissionId: submission.id,
        day,
      },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("/api/admin/shifts/submission DELETE error", error);
    return NextResponse.json({ ok: false, message: "希望シフトの削除に失敗しました。" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const adminUser = await requireAdminUser();
    if (!adminUser.officialAccountId) {
      return NextResponse.json(
        { ok: false, message: "公式アカウントに紐づく管理者のみ提出状態を解除できます。" },
        { status: 403 },
      );
    }

    const parsed = releaseSubmissionSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, message: parsed.error.issues[0]?.message ?? "入力内容が不正です。" },
        { status: 400 },
      );
    }

    const { userId, month } = parsed.data;
    const permission = await prisma.staffStoreOperationPermission.findUnique({
      where: {
        userId_officialAccountId: {
          userId,
          officialAccountId: adminUser.officialAccountId,
        },
      },
      select: {
        user: {
          select: {
            role: true,
          },
        },
      },
    });
    if (!permission || permission.user.role !== "staff") {
      return NextResponse.json(
        { ok: false, message: "スタッフ権限がないユーザーは解除できません。" },
        { status: 400 },
      );
    }

    await prisma.staffShiftSubmission.updateMany({
      where: {
        userId,
        officialAccountId: adminUser.officialAccountId,
        month,
      },
      data: {
        submittedAt: null,
      },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("/api/admin/shifts/submission POST error", error);
    return NextResponse.json({ ok: false, message: "提出状態の解除に失敗しました。" }, { status: 500 });
  }
}
