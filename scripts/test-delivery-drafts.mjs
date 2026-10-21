// Run against a local development server with the draft migration applied:
// node --env-file=.env scripts/test-delivery-drafts.mjs http://localhost:3100
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const base = process.argv[2] ?? "http://localhost:3000";
for (const url of [base, process.env.DATABASE_URL, process.env.DIRECT_URL]) {
  assert.ok(url && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname), "Tests require local app and DB URLs");
}
const db = new PrismaClient();
const prefix = `drafttest${Date.now()}`;
const accounts = [];
const authIds = [];
const admins = [];
let checks = 0;
async function request(path, { cookie, method = "GET", body } = {}) {
  return fetch(`${base}${path}`, {
    method, redirect: "manual",
    headers: { "Content-Type": "application/json", Origin: base, ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function expectStatus(response, status) {
  const text = await response.text();
  assert.equal(response.status, status, text.slice(0, 500));
  checks++;
  return text;
}
async function createAdmin(suffix, accountId) {
  const username = prefix + suffix;
  const response = await request("/api/auth/sign-up/email", { method: "POST", body: {
    name: username, username, email: `${username}@example.test`, password: randomUUID(),
  } });
  const user = JSON.parse(await expectStatus(response, 200));
  authIds.push(user.user.id);
  await db.adminUser.create({ data: { id: username, passwordHash: "integration-test-only", officialAccountId: accountId } });
  admins.push(username);
  const cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  assert.ok(cookie);
  return cookie;
}
const payload = {
  title: "", notificationText: "途中の通知", message: "未完成の本文", showTextElement: true,
  showImageElement: true, showGiftElement: true, selectedGiftId: null,
  uploadedImageUrl: "https://example.test/image.png", targetRankIds: [], targetGender: "female",
  targetVisitCountSegments: ["TWO_TO_FOUR"], triggerType: "BIRTHDAY", delayDirection: "past",
  delayDayCountInput: "3", deliveryHourJst: 9, isActive: false,
};
const save = (cookie, body) => request("/api/admin/spot-delivery/drafts", { cookie, method: "POST", body });
try {
  for (const suffix of ["a", "b"]) {
    const row = await db.officialAccount.create({ data: { lineBasicId: `${prefix}${suffix}` } });
    accounts.push(row.id);
  }
  const cookie = await createAdmin("a", accounts[0]);
  const other = await createAdmin("b", accounts[1]);
  const peer = await createAdmin("c", accounts[0]);
  await expectStatus(await save(undefined, { kind: "SPOT", payload }), 401);
  await expectStatus(await save(cookie, { kind: "INVALID", payload }), 400);
  const spot = JSON.parse(await expectStatus(await save(cookie, { kind: "SPOT", payload }), 200));
  assert.deepEqual((await db.lineDeliveryDraft.findUnique({ where: { id: spot.id } })).payload, payload);
  const changed = { ...payload, title: `${prefix}復元確認`, message: "更新した下書き" };
  await expectStatus(await save(cookie, { id: spot.id, kind: "SPOT", payload: changed }), 200);
  assert.equal(await db.lineDeliveryDraft.count({ where: { ownerId: admins[0] } }), 1);
  await expectStatus(await save(other, { id: spot.id, kind: "SPOT", payload }), 404);
  await expectStatus(await request(`/api/admin/spot-delivery/drafts?id=${spot.id}`, { cookie: other, method: "DELETE" }), 404);
  await expectStatus(await save(peer, { id: spot.id, kind: "SPOT", payload: changed }), 200);
  const list = await expectStatus(await request("/admin/spot-delivery", { cookie }), 200);
  assert.ok(list.includes("編集を再開") && list.includes(`draft=${spot.id}`));
  const restored = await expectStatus(await request(`/admin/spot-delivery/new?draft=${spot.id}`, { cookie }), 200);
  assert.ok(restored.includes(changed.title) && restored.includes(changed.message) && restored.includes(payload.uploadedImageUrl));
  const foreignList = await expectStatus(await request("/admin/spot-delivery", { cookie: other }), 200);
  assert.ok(!foreignList.includes(changed.title));
  const foreignPage = await request(`/admin/spot-delivery/new?draft=${spot.id}`, { cookie: other });
  assert.ok(!(await foreignPage.text()).includes(changed.title));
  checks++;
  // No users exist in this isolated account, so this cannot enqueue a LINE delivery.
  await expectStatus(await request("/api/admin/spot-delivery/trigger", { cookie, method: "POST", body: {
    draftId: spot.id, messages: [{ type: "text", text: "test" }],
  } }), 400);
  assert.ok(await db.lineDeliveryDraft.findUnique({ where: { id: spot.id } }));
  const triggerDraft = JSON.parse(await expectStatus(await save(cookie, { kind: "TRIGGER", payload }), 200));
  await expectStatus(await request("/api/admin/spot-delivery/triggers", { cookie, method: "POST", body: {
    draftId: triggerDraft.id, title: "", triggerType: "BIRTHDAY", messages: [], isActive: false,
  } }), 400);
  assert.ok(await db.lineDeliveryDraft.findUnique({ where: { id: triggerDraft.id } }));
  await expectStatus(await request("/api/admin/spot-delivery/triggers", { cookie, method: "POST", body: {
    draftId: spot.id, title: "wrong-kind", triggerType: "BIRTHDAY", messages: [{ type: "text", text: "test" }], isActive: false,
  } }), 404);
  const finalSetting = { title: prefix, triggerType: "BIRTHDAY", messages: [{ type: "text", text: "完成" }], isActive: false };
  await expectStatus(await request("/api/admin/spot-delivery/triggers", { cookie, method: "POST", body: {
    ...finalSetting, draftId: triggerDraft.id,
  } }), 200);
  assert.equal(await db.lineDeliveryDraft.findUnique({ where: { id: triggerDraft.id } }), null);
  const trigger = await db.lineDeliveryTriggerSetting.findFirstOrThrow({ where: { officialAccountId: accounts[0] } });
  const edit = JSON.parse(await expectStatus(await save(cookie, { kind: "TRIGGER", triggerId: trigger.id, payload: changed }), 200));
  assert.equal((await db.lineDeliveryTriggerSetting.findUnique({ where: { id: trigger.id } })).title, prefix);
  const editHtml = await expectStatus(await request(`/admin/spot-delivery/triggers/${trigger.id}?draft=${edit.id}`, { cookie }), 200);
  assert.ok(editHtml.includes(changed.title));
  await expectStatus(await request(`/api/admin/spot-delivery/triggers/${trigger.id}`, { cookie, method: "PATCH", body: {
    ...finalSetting, title: "編集完了", draftId: edit.id,
  } }), 200);
  assert.equal(await db.lineDeliveryDraft.findUnique({ where: { id: edit.id } }), null);
  assert.equal((await db.lineDeliveryTriggerSetting.findUnique({ where: { id: trigger.id } })).title, "編集完了");
  await expectStatus(await request(`/api/admin/spot-delivery/drafts?id=${spot.id}`, { cookie, method: "DELETE" }), 200);
  assert.equal(await db.lineDeliveryDraft.findUnique({ where: { id: spot.id } }), null);
  console.log(`PASS: ${checks} API/page checks plus DB persistence, isolation, restore and cleanup assertions`);
} finally {
  await db.adminUser.deleteMany({ where: { id: { in: admins } } });
  await db.officialAccount.deleteMany({ where: { id: { in: accounts } } });
  await db.adminAuthUser.deleteMany({ where: { id: { in: authIds } } });
  await db.$disconnect();
}
