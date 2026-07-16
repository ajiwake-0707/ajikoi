import { requireAdminUser } from "@/lib/admin-guard";
import { prisma } from "@/lib/prisma";

import AdminShiftsClient from "./shifts-client";

type Props = {
  searchParams: Promise<{ month?: string }>;
};

type ShiftStatus = "UNSET" | "AVAILABLE" | "UNAVAILABLE";

function formatMonth(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function getDefaultShiftMonth() {
  const date = new Date();
  date.setMonth(date.getMonth() + 1);
  return formatMonth(date);
}

function normalizeMonth(value: string | undefined) {
  return value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : getDefaultShiftMonth();
}

export default async function AdminShiftsPage({ searchParams }: Props) {
  const adminUser = await requireAdminUser();
  const { month: requestedMonth } = await searchParams;
  const month = normalizeMonth(requestedMonth);

  const staffPermissions = await prisma.staffStoreOperationPermission.findMany({
    where: adminUser.officialAccountId ? { officialAccountId: adminUser.officialAccountId } : undefined,
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
      officialAccount: {
        select: {
          name: true,
          lineBasicId: true,
        },
      },
    },
  });

  const staffRows = staffPermissions
    .filter((permission) => permission.user.role === "staff")
    .map((permission) => ({
      userId: permission.user.userId,
      displayName: permission.user.displayName,
      pictureUrl: permission.user.pictureUrl,
      officialAccountId: permission.officialAccountId,
      officialAccountLabel: permission.officialAccount.name?.trim() || permission.officialAccount.lineBasicId,
    }));

  const submissions = await prisma.staffShiftSubmission.findMany({
    where: {
      month,
      ...(adminUser.officialAccountId ? { officialAccountId: adminUser.officialAccountId } : {}),
    },
    select: {
      userId: true,
      officialAccountId: true,
      submittedAt: true,
      entries: {
        orderBy: {
          day: "asc",
        },
        select: {
          day: true,
          status: true,
          startTime: true,
          endTime: true,
          isFree: true,
          memo: true,
        },
      },
    },
  });
  const submissionByScope = new Map(
    submissions.map((submission) => [`${submission.userId}:${submission.officialAccountId}`, submission]),
  );
  const schedule = adminUser.officialAccountId
    ? await prisma.staffShiftSchedule.findUnique({
        where: {
          officialAccountId_month: {
            officialAccountId: adminUser.officialAccountId,
            month,
          },
        },
        select: {
          assignments: {
            orderBy: [{ day: "asc" }, { startTime: "asc" }],
            select: {
              id: true,
              userId: true,
              day: true,
              startTime: true,
              endTime: true,
              isFree: true,
              memo: true,
            },
          },
        },
      })
    : null;

  return (
    <AdminShiftsClient
      key={month}
      month={month}
      staff={staffRows.map((staff) => {
        const submission = submissionByScope.get(`${staff.userId}:${staff.officialAccountId}`);
        return {
          ...staff,
          submittedAt: submission?.submittedAt?.toISOString() ?? null,
          entries: (submission?.entries ?? []).map((entry) => ({
            day: entry.day,
            status: entry.status as ShiftStatus,
            startTime: entry.startTime,
            endTime: entry.endTime,
            isFree: entry.isFree,
            memo: entry.memo,
          })),
        };
      })}
      initialAssignments={(schedule?.assignments ?? []).map((assignment) => ({
        id: assignment.id,
        userId: assignment.userId,
        day: assignment.day,
        startTime: assignment.startTime,
        endTime: assignment.endTime,
        isFree: assignment.isFree,
        memo: assignment.memo,
      }))}
    />
  );
}
