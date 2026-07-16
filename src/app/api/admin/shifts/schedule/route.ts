import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAdminUser } from "@/lib/admin-guard";
import { prisma } from "@/lib/prisma";

const assignmentSchema = z.object({
  userId: z.string().min(1),
  day: z.number().int().min(1).max(31),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  isFree: z.boolean().optional(),
  memo: z.string().trim().max(200).nullable().optional(),
});

const saveScheduleSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  assignments: z.array(assignmentSchema).max(500),
});

function getDaysInMonth(month: string) {
  const [year, monthIndex] = month.split("-").map(Number);
  return new Date(year, monthIndex, 0).getDate();
}

export async function PATCH(request: Request) {
  try {
    const adminUser = await requireAdminUser();
    if (!adminUser.officialAccountId) {
      return NextResponse.json(
        { ok: false, message: "公式アカウントに紐づく管理者のみ確定シフトを保存できます。" },
        { status: 403 },
      );
    }

    const parsed = saveScheduleSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, message: parsed.error.issues[0]?.message ?? "入力内容が不正です。" },
        { status: 400 },
      );
    }

    const { month, assignments } = parsed.data;
    const daysInMonth = getDaysInMonth(month);
    for (const assignment of assignments) {
      if (assignment.day > daysInMonth) {
        return NextResponse.json(
          { ok: false, message: `${assignment.day}日は対象月に存在しません。` },
          { status: 400 },
        );
      }
      const isFree = assignment.isFree ?? false;
      if (!isFree && (!assignment.startTime || !assignment.endTime)) {
        return NextResponse.json(
          { ok: false, message: `${assignment.day}日の勤務時間を入力してください。` },
          { status: 400 },
        );
      }
      if (!isFree && assignment.startTime && assignment.endTime && assignment.startTime >= assignment.endTime) {
        return NextResponse.json(
          { ok: false, message: `${assignment.day}日の終了時刻は開始時刻より後にしてください。` },
          { status: 400 },
        );
      }
    }

    const uniqueUserIds = [...new Set(assignments.map((assignment) => assignment.userId))];
    if (uniqueUserIds.length > 0) {
      const permissions = await prisma.staffStoreOperationPermission.findMany({
        where: {
          officialAccountId: adminUser.officialAccountId,
          userId: { in: uniqueUserIds },
          user: {
            role: "staff",
          },
        },
        select: {
          userId: true,
        },
      });
      const allowedUserIds = new Set(permissions.map((permission) => permission.userId));
      const invalidUserId = uniqueUserIds.find((userId) => !allowedUserIds.has(userId));
      if (invalidUserId) {
        return NextResponse.json(
          { ok: false, message: "スタッフ権限がないユーザーが含まれています。" },
          { status: 400 },
        );
      }
    }

    const schedule = await prisma.staffShiftSchedule.upsert({
      where: {
        officialAccountId_month: {
          officialAccountId: adminUser.officialAccountId,
          month,
        },
      },
      create: {
        officialAccountId: adminUser.officialAccountId,
        month,
      },
      update: {},
      select: {
        id: true,
      },
    });

    await prisma.$transaction(async (tx) => {
      await tx.staffShiftAssignment.deleteMany({
        where: { scheduleId: schedule.id },
      });
      if (assignments.length > 0) {
        await tx.staffShiftAssignment.createMany({
          data: assignments.map((assignment) => ({
            scheduleId: schedule.id,
            userId: assignment.userId,
            day: assignment.day,
            startTime: assignment.isFree ? null : (assignment.startTime ?? null),
            endTime: assignment.isFree ? null : (assignment.endTime ?? null),
            isFree: assignment.isFree ?? false,
            memo: assignment.memo?.trim() || null,
          })),
        });
      }
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("/api/admin/shifts/schedule PATCH error", error);
    return NextResponse.json({ ok: false, message: "確定シフトの保存に失敗しました。" }, { status: 500 });
  }
}
