import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const OFFICIAL_LINE_BASIC_ID = process.env.LINE_OFFICIAL_ACCOUNT_ID?.trim() || "@607wzgdz";
const STAFF_PREFIX = "demo-staff-shift-";
const STAFF_NAMES = ["佐藤 はるか", "田中 亮", "山本 美咲", "鈴木 拓海", "高橋 朱里", "伊藤 健太"];

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function formatMonth(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function getDefaultShiftMonth() {
  const date = new Date();
  date.setMonth(date.getMonth() + 1);
  return formatMonth(date);
}

function getDaysInMonth(month) {
  const matched = month.match(/^(\d{4})-(\d{2})$/);
  if (!matched) return 31;
  return new Date(Number(matched[1]), Number(matched[2]), 0).getDate();
}

function randomTimeRange() {
  const starts = ["10:00", "11:00", "12:00", "13:00", "17:00", "18:00"];
  const startTime = starts[randomInt(0, starts.length - 1)];
  const startHour = Number(startTime.slice(0, 2));
  const duration = randomInt(4, 7);
  const endHour = Math.min(startHour + duration, 23);
  return {
    startTime,
    endTime: `${String(endHour).padStart(2, "0")}:00`,
  };
}

async function resolveOfficialAccountId() {
  await prisma.$executeRaw`
    INSERT INTO "official_accounts" ("id", "lineBasicId", "name", "updatedAt")
    VALUES (md5(random()::text || clock_timestamp()::text), ${OFFICIAL_LINE_BASIC_ID}, ${OFFICIAL_LINE_BASIC_ID}, NOW())
    ON CONFLICT ("lineBasicId")
    DO UPDATE SET "updatedAt" = NOW()
  `;

  const rows = await prisma.$queryRaw`
    SELECT "id"
    FROM "official_accounts"
    WHERE "lineBasicId" = ${OFFICIAL_LINE_BASIC_ID}
    LIMIT 1
  `;

  return rows[0]?.id ?? null;
}

async function getDefaultRankId() {
  const regular = await prisma.rank.findUnique({ where: { id: "regular" }, select: { id: true } });
  if (regular) return regular.id;

  const first = await prisma.rank.findFirst({
    orderBy: { minPoints: "asc" },
    select: { id: true },
  });
  if (!first) {
    throw new Error("ranks テーブルが空です。先に migration を適用してください。");
  }

  return first.id;
}

function buildEntries(month, staffIndex) {
  const daysInMonth = getDaysInMonth(month);
  const entries = [];

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(`${month}-${String(day).padStart(2, "0")}T00:00:00+09:00`);
    const weekday = date.getDay();
    const weekendBias = weekday === 0 || weekday === 6 ? 15 : 0;
    const unavailableRoll = randomInt(1, 100);
    const availableRoll = randomInt(1, 100);

    if (unavailableRoll <= 12 + staffIndex) {
      entries.push({
        day,
        status: "UNAVAILABLE",
        startTime: null,
        endTime: null,
        isFree: false,
        memo: null,
      });
      continue;
    }

    if (availableRoll <= 42 + weekendBias) {
      if (availableRoll <= 8) {
        entries.push({
          day,
          status: "AVAILABLE",
          startTime: null,
          endTime: null,
          isFree: true,
          memo: null,
        });
        continue;
      }

      const { startTime, endTime } = randomTimeRange();
      entries.push({
        day,
        status: "AVAILABLE",
        startTime,
        endTime,
        isFree: false,
        memo: null,
      });
      continue;
    }

    entries.push({
      day,
      status: "UNSET",
      startTime: null,
      endTime: null,
      isFree: false,
      memo: null,
    });
  }

  return entries;
}

async function main() {
  const month = process.env.SHIFT_SEED_MONTH?.trim() || getDefaultShiftMonth();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new Error("SHIFT_SEED_MONTH は YYYY-MM 形式で指定してください。");
  }

  const officialAccountId = await resolveOfficialAccountId();
  if (!officialAccountId) {
    throw new Error("official_accounts の作成/取得に失敗しました。");
  }
  const defaultRankId = await getDefaultRankId();

  const deleted = await prisma.user.deleteMany({
    where: {
      userId: {
        startsWith: STAFF_PREFIX,
      },
    },
  });

  for (let index = 0; index < STAFF_NAMES.length; index += 1) {
    const userId = `${STAFF_PREFIX}${String(index + 1).padStart(2, "0")}`;
    await prisma.user.create({
      data: {
        userId,
        displayName: STAFF_NAMES[index],
        role: "staff",
        nextRank: defaultRankId,
        officialAccountId,
        officialLinkedAt: new Date(),
      },
    });

    await prisma.staffStoreOperationPermission.create({
      data: {
        userId,
        officialAccountId,
        canOpen: true,
        canClose: true,
      },
    });

    const submission = await prisma.staffShiftSubmission.create({
      data: {
        userId,
        officialAccountId,
        month,
        submittedAt: new Date(Date.now() - randomInt(0, 5) * 60 * 60 * 1000),
      },
      select: {
        id: true,
      },
    });

    await prisma.staffShiftAvailability.createMany({
      data: buildEntries(month, index).map((entry) => ({
        submissionId: submission.id,
        ...entry,
      })),
    });
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        officialLineBasicId: OFFICIAL_LINE_BASIC_ID,
        officialAccountId,
        month,
        deletedDemoStaff: deleted.count,
        createdStaff: STAFF_NAMES.length,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
