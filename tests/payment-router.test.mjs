import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import request from 'supertest';
import { issueSession } from '../server/auth.mjs';
import { createPaymentRouter } from '../server/payment-router.mjs';

const origin = 'http://will.test';
function copy(value) { return JSON.parse(JSON.stringify(value)); }
class MemoryStore {
  constructor(state) { this.state = copy(state); this.revision = 0; }
  async snapshot() { return { revision: this.revision, state: copy(this.state) }; }
  async replace(revision, state) {
    if (revision !== this.revision) return { ok: false, currentRevision: this.revision };
    this.state = copy(state); this.revision += 1;
    return { ok: true, revision: this.revision, state: copy(this.state) };
  }
}
function seed() {
  return {
    version: 4, logs: [], records: {
      members: [{ id: 'm1', loginId: 'member-open-id', group: '무료회원', balance: 999999, paidPoints: 10, freePoints: 20 }],
      videos: [{ id: 'video-1', title: '주식교육영상', visibility: '공개', amount: 100 }],
      products: [{ id: 'vip-1', title: 'VIP A', visible: '판매중', display: true, options: [{ id: 'option-1', title: '1개월', amount: 300 }] }],
      coupons: [{ id: 'point-coupon', status: 'active', benefitType: 'deposit', benefitValue: 55, issueMethod: 'couponCode', couponCodeMode: 'single', code: 'POINT55', targetMode: 'all', usageUnlimited: true }],
      couponIssuances: [{ id: 'issue-1', couponId: 'point-coupon', ownerMemberId: 'm1', status: 'active', usedCount: 0 }],
    },
  };
}
function fakeProvider() {
  return {
    configured: true,
    async register({ part }) { return { authPageUrl: `https://auth.example/${encodeURIComponent(part.serverRef)}` }; },
    async approve({ order, attempt }) {
      return { ok: true, currency: 'KRW', amount: attempt.amount, shopTransactionId: attempt.serverRef, shopOrderNo: order.id, pgCno: `pg-${attempt.id}`, transactionId: `pg-${attempt.id}` };
    },
    async cancel({ attempt }) { return { ok: true, serverRef: attempt.serverRef, cancelPgCno: `cancel-${attempt.id}` }; },
  };
}
async function setup({ provider = fakeProvider() } = {}) {
  const store = new MemoryStore(seed());
  const authConfig = { siteOrigin: origin, secret: new TextEncoder().encode('test-secret-long-enough'), projectId: 'payment-test', adapterPath: '', adminOpenIds: new Set(), expertByOpenId: {} };
  const signed = await issueSession({ openId: 'member-open-id' }, authConfig, 'csrf-test-token');
  const app = express();
  app.use(express.json());
  app.use('/api/payments', createPaymentRouter({ store, authConfig, siteOrigin: origin, provider }));
  const client = request(app);
  const headers = { Cookie: `webdev_app_session=${signed.token}`, Origin: origin, 'X-CSRF-Token': signed.csrf };
  return { store, client, headers };
}
async function callbackFor({ store, client, orderId, partId }) {
  const attempt = store.state.records.paymentAttempts.find(row => row.orderId === orderId && row.partId === partId);
  assert.ok(attempt?.callbackToken, 'registration must persist an opaque callback token');
  return client.post('/api/payments/easypay/return').type('form').send({
    shopTransactionId: attempt.serverRef, callbackToken: attempt.callbackToken, authCode: `auth-${partId}`,
  });
}

test('wallet uses paidPoints+freePoints only, rejects VIP point methods, and consumes an issued point coupon once', async () => {
  const { client, headers } = await setup();
  const wallet = await client.get('/api/payments/wallet').set('Cookie', headers.Cookie).expect(200);
  assert.equal(wallet.body.balance, 30);
  assert.equal(wallet.body.availablePoints, 30);
  assert.equal(JSON.stringify(wallet.body).includes('999999'), false, 'legacy balance must not leave the server');

  const vipQuote = await client.post('/api/payments/quote').set(headers).send({ kind: 'vip', method: 'points', productId: 'vip-1', optionId: 'option-1', points: 300 }).expect(400);
  assert.equal(vipQuote.body.error.code, 'VIP_CARD_ONLY');

  const first = await client.post('/api/payments/points/redeem').set(headers).send({ couponId: 'point-coupon', couponCode: 'POINT55' }).expect(201);
  assert.equal(first.body.balance, 85);
  const second = await client.post('/api/payments/points/redeem').set(headers).send({ couponId: 'point-coupon', couponCode: 'POINT55' }).expect(403);
  assert.equal(second.body.error.code, 'POINT_COUPON_NOT_AVAILABLE');
});

test('VIP split fulfillment waits for all verified provider approvals and never changes member group dates', async () => {
  const { store, client, headers } = await setup();
  const created = await client.post('/api/payments/create').set(headers).send({
    kind: 'vip', method: 'split', productId: 'vip-1', optionId: 'option-1', nonce: 'vip-split-order-0001',
    parts: [{ company: '국민카드', amount: 100, installments: 0 }, { company: '신한카드', amount: 200, installments: 3 }],
  }).expect(201);
  const orderId = created.body.order.id;
  assert.equal(created.body.order.status, 'draft');

  await client.post(`/api/payments/orders/${orderId}/parts/part-1/register`).set(headers).send({}).expect(200);
  assert.equal((await callbackFor({ store, client, orderId, partId: 'part-1' })).status, 303);
  let order = (await client.get(`/api/payments/orders/${orderId}`).set('Cookie', headers.Cookie).expect(200)).body.order;
  assert.equal(order.status, 'partial');
  assert.equal(store.state.records.memberServices || [].length, 0, 'service must not exist after only one card approval');

  await client.post(`/api/payments/orders/${orderId}/parts/part-2/register`).set(headers).send({}).expect(200);
  assert.equal((await callbackFor({ store, client, orderId, partId: 'part-2' })).status, 303);
  order = (await client.get(`/api/payments/orders/${orderId}`).set('Cookie', headers.Cookie).expect(200)).body.order;
  assert.equal(order.status, 'completed');
  assert.equal(order.parts.every(part => part.remainingAmount === 0 && part.status === 'approved'), true);
  assert.equal(store.state.records.memberServices.length, 1);
  assert.equal(store.state.records.members[0].services[0].productId, 'vip-1');
  assert.equal(store.state.records.members[0].group, '무료회원');
  assert.match(store.state.records.members[0].services[0].start,/^\d{4}-\d{2}-\d{2}$/);
});

test('top-up credits paidPoints only after a verified callback, while disabled provider registration cannot charge points', async () => {
  const { store, client, headers } = await setup();
  const created = await client.post('/api/payments/topup/create').set(headers).send({ amount: 500, nonce: 'topup-order-0001' }).expect(201);
  const orderId = created.body.order.id;
  assert.equal(store.state.records.members[0].paidPoints, 10);
  await client.post(`/api/payments/orders/${orderId}/parts/part-1/register`).set(headers).send({}).expect(200);
  assert.equal((await callbackFor({ store, client, orderId, partId: 'part-1' })).status, 303);
  assert.equal(store.state.records.members[0].paidPoints, 510);
  assert.equal(store.state.records.members[0].balance, 999999, 'legacy balance is never debited or credited');

  const disabled = await setup({ provider: { configured: false } });
  const video = await disabled.client.post('/api/payments/create').set(disabled.headers).send({ kind: 'video', method: 'card', videoId: 'video-1', nonce: 'disabled-card-order-1' }).expect(201);
  await disabled.client.post(`/api/payments/orders/${video.body.order.id}/parts/part-1/register`).set(disabled.headers).send({}).expect(503);
  assert.equal(disabled.store.state.records.members[0].paidPoints, 10);
  assert.equal(disabled.store.state.records.videoEntitlements, undefined);
});
