// Characterization tests: asserts current behavior, including known bugs.
// No real LINE/Inngest requests. SQL runs against transaction-local temporary tables.
// Run: node --env-file=.env scripts/test-birthday-delivery.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';

for (const name of ['DATABASE_URL', 'DIRECT_URL']) {
  assert.ok(process.env[name] && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env[name]).hostname), `${name} must be local`);
}
const db = new PrismaClient();
const results = [];
function loadHandler(file, prisma, time, send, fetch) {
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [time])); }
    static now() { return new RealDate(time).getTime(); }
  }
  const exports = {};
  const dependencies = {
    '@prisma/client': { Prisma }, zod: { z }, '@/lib/prisma': { prisma },
    '@/lib/inngest/client': { inngest: { createFunction: (_config, handler) => handler, send } },
  };
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    exports, Date: FixedDate, console,
    process: { env: { LINE_CHANNEL_ACCESS_TOKEN: 'fake-test-token' } },
    fetch: fetch ?? (() => { throw new Error('Unexpected network call'); }),
    require: (id) => { assert.ok(id in dependencies, `Unexpected dependency: ${id}`); return dependencies[id]; },
  }, { filename: file });
  return Object.values(exports)[0];
}
const setting = {
  id: 'test-setting', title: 'Birthday', triggerType: 'BIRTHDAY', isActive: true,
  officialAccountId: 'account-a', targetRankIds: [], targetGender: null,
  targetVisitCountSegments: [], delayDays: 0, deliveryHourJst: null,
  notificationText: '', message: 'Happy birthday', messages: [{ type: 'text', text: 'Happy birthday' }],
};
const step = { run: async (_id, fn) => fn(), sleepUntil: async () => {} };
try {
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`;
    await tx.$executeRaw`CREATE TEMP TABLE users ("userId" text, "surveyId" text, "officialAccountId" text, "nextRank" text) ON COMMIT DROP`;
    await tx.$executeRaw`CREATE TEMP TABLE user_surveys (id text, "birthDate" timestamp(3), gender text) ON COMMIT DROP`;
    await tx.$executeRaw`CREATE TEMP TABLE user_checkins (id text, "userId" text) ON COMMIT DROP`;
    await tx.$executeRaw`INSERT INTO users VALUES ('test-user', 'test-survey', 'account-a', 'rank-a')`;
    await tx.$executeRaw`INSERT INTO user_surveys VALUES ('test-survey', TIMESTAMP '2000-10-22 00:00:00', 'female')`;
    await tx.$executeRaw`INSERT INTO user_checkins VALUES ('checkin-1', 'test-user')`;
    let histories = [];
    async function run(time, overrides = {}) {
      const events = [];
      const stages = [];
      const config = { ...setting, ...overrides };
      const prisma = {
        $queryRaw: tx.$queryRaw.bind(tx),
        lineDeliveryTriggerSetting: { findMany: async ({where}) => config.isActive === where.isActive ? [config] : [] },
        userHistory: { findFirst: async ({where}) => histories.find((h) => h.actorId === where.actorId) ?? null },
      };
      const handler = loadHandler('src/lib/inngest/functions/scheduled-trigger-line-delivery.ts', prisma, time,
        async (event) => { events.push(event); });
      await handler({ step: { ...step, run: async (id, fn) => { stages.push(id); return fn(); } } });
      return { events, stages };
    }
    async function check(name, time, overrides, expected) {
      const result = await run(time, overrides);
      assert.equal(result.events.length, expected, name);
      if (expected) assert.equal(result.events[0].data.targetUserIds.join(','), 'test-user');
      results.push({ name, enqueued: result.events.length });
      return result;
    }
    const previousDay = '2026-10-21T00:00:00Z'; // 09:00 JST
    const birthday = '2026-10-22T00:00:00Z';
    const positive = await check('BUG: birthday 10/22 is enqueued on 10/21 at 09:00 JST', previousDay, {}, 1);
    await check('BUG: no delivery on actual birthday 10/22', birthday, {}, 0);
    await check('Null hour: no delivery at 08:00 JST', '2026-10-20T23:00:00Z', {}, 0);
    await check('Null hour: no catch-up at 10:00 JST', '2026-10-21T01:00:00Z', {}, 0);
    await check('Explicit 10:00: delivery at configured hour', '2026-10-21T01:00:00Z', { deliveryHourJst: 10 }, 1);
    await check('Explicit 10:00: skip 09:00', previousDay, { deliveryHourJst: 10 }, 0);
    await check('Inactive setting excluded', previousDay, { isActive: false }, 0);
    await check('Different official account excluded', previousDay, { officialAccountId: 'account-b' }, 0);
    await check('Different rank excluded', previousDay, { targetRankIds: ['rank-b'] }, 0);
    await check('Different gender excluded', previousDay, { targetGender: 'male' }, 0);
    await check('Different visit count excluded', previousDay, { targetVisitCountSegments: ['ZERO'] }, 0);
    await check('Matching all filters enqueues', previousDay, {targetRankIds: ['rank-a'], targetGender: 'female', targetVisitCountSegments: ['ONE']}, 1);
    await check('BUG: 7 days before becomes 8 days before', '2026-10-14T00:00:00Z', { delayDays: -7 }, 1);
    await check('7 days before: intended date misses', '2026-10-15T00:00:00Z', { delayDays: -7 }, 0);
    await tx.$executeRaw`UPDATE user_surveys SET "birthDate" = NULL`;
    await check('Missing birthday excluded', previousDay, {}, 0);
    await tx.$executeRaw`UPDATE user_surveys SET "birthDate" = TIMESTAMP '2000-01-01 00:00:00'`;
    await check('BUG: January 1 birthday enqueues December 31', '2026-12-31T00:00:00Z', {}, 1);
    await tx.$executeRaw`UPDATE user_surveys SET "birthDate" = TIMESTAMP '2000-10-22 00:00:00'`;
    // Run the real delivery worker with fake LINE responses and captured history writes.
    for (const status of [200, 500]) {
      histories = [];
      let requests = 0;
      const worker = loadHandler('src/lib/inngest/functions/trigger-line-delivery.ts', {
        user: { findMany: async () => [{userId: 'test-user'}] },
        $executeRaw: async (_strings, ...values) => {
          const metadata = values.find((v) => typeof v === 'string' && v.startsWith('{'));
          histories.push({ id: 'test-history', actorId: positive.events[0].data.triggeredBy, metadata: JSON.parse(metadata) });
        },
      }, previousDay, () => { throw new Error('Unexpected Inngest call'); }, async (url, options) => {
        assert.equal(url, 'https://api.line.me/v2/bot/message/push');
        assert.equal(JSON.parse(options.body).to, 'test-user');
        requests++;
        return { ok: status === 200, status, headers: { get: () => 'test-request-id' }, text: async () => 'simulated error' };
      });
      const result = await worker({ event: { data: positive.events[0].data }, step });
      assert.equal(requests, 1);
      assert.equal(result.sent, status === 200 ? 1 : 0);
      assert.equal(result.failed, status === 200 ? 0 : 1);
      assert.equal(histories[0].metadata.failed, result.failed);
      results.push({name: `Fake LINE ${status}`, sent: result.sent, failed: result.failed, ok: result.ok});
      await check(status === 200 ? 'Success history prevents duplicate' : 'BUG: failure history also prevents retry', previousDay, {}, 0);
    }
  }, {timeout: 30000});
  console.log(JSON.stringify({ tests: results.length, results, externalRequests: 0 }, null, 2));
} finally {
  await db.$disconnect();
}
