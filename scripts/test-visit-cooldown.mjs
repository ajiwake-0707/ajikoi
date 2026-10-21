// Local PostgreSQL only; temporary tables are rolled back. No LINE calls.
// node --env-file=.env scripts/test-visit-cooldown.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { PrismaClient } from '@prisma/client';
for (const key of ['DATABASE_URL', 'DIRECT_URL']) {
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env[key]).hostname));
}
const source = readFileSync('src/orpc/router.ts', 'utf8');
const helpers = source.slice(source.indexOf('const VISIT_COOLDOWN_MS'), source.indexOf('function isCreatedTodayInJst'));
const pointStart = source.indexOf('const cooldownCutoff =');
const pointCode = source.slice(pointStart, source.indexOf('if (Number(updatedCount)', pointStart));
const gachaStart = source.indexOf('if (!isWithinVisitCooldown(user.lastCheckInAt))');
const gachaCode = source.slice(gachaStart, source.indexOf('const startOfTodayInJstUtc', gachaStart));
const now = new Date('2026-10-22T14:00:00Z'); // 23:00 JST
class Clock extends Date { static now() { return now.getTime(); } }
function evaluate(code, globals) {
  return vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, { Date: Clock, ...globals });
}
const db = new PrismaClient();
try {
  await db.$transaction(async tx => {
    await tx.$executeRaw`CREATE TEMP TABLE users ("userId" text PRIMARY KEY, points int, "visitCount" int, "lastCheckInAt" timestamp(3)) ON COMMIT DROP`;
    await tx.$executeRaw`CREATE TEMP TABLE user_history ("targetUserId" text, action text, "createdAt" timestamp(3)) ON COMMIT DROP`;
    await tx.$executeRaw`INSERT INTO users VALUES ('test', 0, 0, NULL)`;
    const award = () => evaluate(`${helpers}\n(async () => { ${pointCode} return Number(updatedCount); })()`, { prisma: tx, now, input: { userId: 'test' } });
    for (const [elapsed, expected] of [[null, 1], [12 * 3600000 - 1, 0], [12 * 3600000, 1], [13 * 3600000, 1]]) {
      const last = elapsed === null ? null : new Date(now.getTime() - elapsed);
      await tx.$executeRaw`UPDATE users SET "lastCheckInAt" = ${last}`;
      assert.equal(await award(), expected, `elapsed=${elapsed}`);
      assert.equal(await award(), 0, 'repeat scan cannot award again');
    }
    // Midnight does not reset the interval.
    now.setTime(Date.parse('2026-10-22T15:01:00Z'));
    await tx.$executeRaw`UPDATE users SET "lastCheckInAt" = ${new Date('2026-10-22T14:59:00Z')}`;
    assert.equal(await award(), 0);
    const checkGacha = last => evaluate(`${helpers}\n(async () => { ${gachaCode} return { eligible: true }; })()`, { prisma: tx, user: { userId: 'test', lastCheckInAt: last } });
    const last = new Date('2026-10-22T14:59:00Z');
    assert.equal((await checkGacha(last)).eligible, true, 'gacha may cross midnight');
    await tx.$executeRaw`INSERT INTO user_history VALUES ('test', 'visit_gacha_lost', ${new Date('2026-10-22T15:00:00Z')})`;
    assert.equal((await checkGacha(last)).alreadyChallengedToday, true);
    now.setTime(Date.parse('2026-10-23T03:00:00Z'));
    assert.equal((await checkGacha(new Date('2026-10-23T02:59:00Z'))).eligible, true, 'new visit allows gacha even with earlier result on same JST date');
    await assert.rejects(checkGacha(new Date(now.getTime() - 12 * 3600000)), /12時間以内/);
    await assert.rejects(checkGacha(null), /12時間以内/);
  });
  console.log('PASS: first scan, 12h boundary, repeat scans, midnight, gacha once per visit and new visit on same day');
} finally { await db.$disconnect(); }
