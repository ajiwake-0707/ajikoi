import { requireAdminUser } from "@/lib/admin-guard";
import { prisma } from "@/lib/prisma";
import MembersClient from "./members-client";

export default async function AdminMembersPage() {
  const startedAt = Date.now();
  const adminUser = await requireAdminUser();
  const [members, officialAccounts] = await Promise.all([
    prisma.user.findMany({
      where: adminUser.officialAccountId
        ? { officialAccountId: adminUser.officialAccountId }
        : undefined,
      orderBy: [{ points: "desc" }, { createdAt: "desc" }],
      select: {
        userId: true,
        displayName: true,
        pictureUrl: true,
        visitCount: true,
        role: true,
        createdAt: true,
        lastCheckInAt: true,
        rank: {
          select: {
            name: true,
          },
        },
        storeOperationPermissions: {
          select: {
            officialAccountId: true,
            canOpen: true,
            canClose: true,
          },
          orderBy: {
            createdAt: "desc",
          },
          take: 1,
        },
      },
      take: 500,
    }),
    prisma.officialAccount.findMany({
      where: adminUser.officialAccountId ? { id: adminUser.officialAccountId } : undefined,
      select: {
        id: true,
        lineBasicId: true,
        name: true,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 100,
    }),
  ]);
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs >= 500) {
    console.info("[admin.members-page-ms]", {
      total: elapsedMs,
      members: members.length,
      officialAccounts: officialAccounts.length,
    });
  }

  return (
    <MembersClient
      officialAccounts={officialAccounts.map((account) => ({
        id: account.id,
        label: account.name?.trim() || account.lineBasicId,
      }))}
      initialMembers={members.map((row) => ({
        userId: row.userId,
        displayName: row.displayName,
        pictureUrl: row.pictureUrl,
        role: row.role,
        checkInCount: row.visitCount,
        rankName: row.rank.name,
        registeredAt: row.createdAt.toISOString(),
        lastVisitedAt: row.lastCheckInAt ? row.lastCheckInAt.toISOString() : null,
        assignedOfficialAccountId: row.storeOperationPermissions[0]?.officialAccountId ?? null,
      }))}
    />
  );
}
