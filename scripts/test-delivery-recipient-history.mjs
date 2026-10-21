// Run: node scripts/test-delivery-recipient-history.mjs (no network or database).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { z } from 'zod';

const recipients = Array.from({ length: 53 }, (_, i) => ({ userId: `user-${i}`, displayName: i === 52 ? null : `会員${i}` }));
let requests = 0;
let history;
let rejectHistory = true;
const prisma = {
  user: { findMany: async () => recipients },
  $executeRaw: async (_strings, ...values) => {
    if (rejectHistory) { rejectHistory = false; throw new Error('temporary database failure'); }
    history = JSON.parse(values.find(value => typeof value === 'string' && value.startsWith('{')));
  },
};
const dependencies = {
  zod: { z }, '@/lib/prisma': { prisma },
  '@/lib/inngest/client': { inngest: { createFunction: (_config, handler) => handler } },
};
const exports = {};
vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/inngest/functions/trigger-line-delivery.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, {
  exports, Date, Error, process: { env: { LINE_CHANNEL_ACCESS_TOKEN: 'test-only' } },
  require: id => { assert.ok(id in dependencies); return dependencies[id]; },
  fetch: async (_url, options) => {
    requests++;
    const { to } = JSON.parse(options.body);
    if (to === 'user-51') throw new Error('network unavailable');
    const status = to === 'user-50' ? 429 : 200;
    return { ok: status === 200, status, headers: { get: () => `request-${to}` }, text: async () => 'rate limited' };
  },
});
const cache = new Map();
const step = {
  run: async (id, fn) => {
    if (!cache.has(id)) cache.set(id, JSON.stringify(await fn()));
    const value = cache.get(id);
    return value === undefined ? undefined : JSON.parse(value);
  },
  sleepUntil: async () => {},
};
const event = { data: { title: '誕生日', officialAccountId: null, targetUserIds: recipients.map(r => r.userId), triggeredBy: 'system:birthday:test:20261022', messages: [{ type: 'text', text: 'test' }] } };
await assert.rejects(exports.triggerLineDelivery({ event, step }), /temporary database failure/);
assert.equal(requests, 53);
const result = await exports.triggerLineDelivery({ event, step });
assert.equal(requests, 53, 'history retry must not resend completed batches');
assert.equal(result.sent, 51);
assert.equal(result.failed, 2);
assert.equal(history.recipientResultsVersion, 1);
assert.equal(history.recipientResults.length, 53);
assert.deepEqual(history.recipientResults.map(r => r.userId), recipients.map(r => r.userId));
for (const row of history.recipientResults) {
  assert.ok(Number.isFinite(Date.parse(row.attemptedAt)));
  assert.ok(Date.parse(row.completedAt) >= Date.parse(row.attemptedAt));
}
assert.equal(history.recipientResults[0].displayName, '会員0');
assert.equal(history.recipientResults[0].status, 'accepted');
assert.equal(history.recipientResults[0].requestId, 'request-user-0');
assert.equal(history.recipientResults[50].status, 'failed');
assert.equal(history.recipientResults[50].httpStatus, 429);
assert.equal(history.recipientResults[50].error, 'rate limited');
assert.equal(history.recipientResults[51].error, 'network unavailable');
assert.equal(history.recipientResults[51].httpStatus, null);
assert.equal(history.recipientResults[52].displayName, null);
console.log('PASS: 53 recipients, multiple batches, HTTP/network failures, timestamps, names, JSON replay and history retry without resending');
