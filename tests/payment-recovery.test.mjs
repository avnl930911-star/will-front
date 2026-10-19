import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import request from 'supertest';
import { issueSession } from '../server/auth.mjs';
import { EasyPayProviderError } from '../server/easypay-provider.mjs';
import {
  COUPON_RESERVATION_TTL_MS, PaymentDomainError, applyApprovalResult, createPaymentOrder, updatePaymentState,
} from '../server/payment-orders.mjs';
import { createPaymentRouter } from '../server/payment-router.mjs';

const origin = 'http://will.test';
const copy = value => JSON.parse(JSON.stringify(value));
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
  return { version: 4, logs: [], records: {
    members: [
      { id: 'm1', loginId: 'member-one', paidPoints: 100, freePoints: 0 },
      { id: 'm2', loginId: 'member-two', paidPoints: 100, freePoints: 0 },
    ],
    videos: [{ id: 'video-1', title: '교육 영상', visibility: '공개', amount: 100 }],
    products: [], coupons: [], couponIssuances: [],
  } };
}
async function routerSetup(provider) {
  const store = new MemoryStore(seed());
  const authConfig = { siteOrigin: origin, secret: new TextEncoder().encode('payment-recovery-test-secret'), projectId: 'payment-recovery-test', adapterPath: '', adminOpenIds: new Set(), expertByOpenId: {} };
  const signed = await issueSession({ openId: 'member-one' }, authConfig, 'csrf-recovery-token');
  const app = express();
  app.use(express.json());
  app.use('/api/payments', createPaymentRouter({ store, authConfig, siteOrigin: origin, provider }));
  return { store, client: request(app), headers: { Cookie: `webdev_app_session=${signed.token}`, Origin: origin, 'X-CSRF-Token': signed.csrf } };
}
function approvalFor(order, attempt) {
  return { ok: true, currency: 'KRW', amount: attempt.amount, shopTransactionId: attempt.serverRef, shopOrderNo: order.id, pgCno: 'pg-confirmed', transactionId: 'pg-confirmed' };
}

test('an approval survives a fulfillment failure while all fulfillment writes are rolled back', async () => {
  const state = seed();
  state.records.orders = [{
    id: 'ord-1', ownerMemberId: 'm1', kind: 'video', method: 'mixed', target: { videoId: 'video-1' },
    pointAmount: 20, cardAmount: 80, totalAmount: 100, pointsReserved: true, status: 'pending', stage: 'settling',
    coupon: { id: 'removed-coupon', code: '' }, manualRefundRequired: false,
    parts: [{ id: 'part-1', amount: 80, approvedAmount: 0, remainingAmount: 80, status: 'registered' }],
  }];
  state.records.paymentAttempts = [{ id: 'attempt-1', orderId: 'ord-1', ownerMemberId: 'm1', partId: 'part-1', serverRef: 'tx-1', amount: 80, status: 'approving' }];
  state.records.paymentCouponReservations = [{ id: 'res-1', orderId: 'ord-1', couponId: 'removed-coupon', ownerMemberId: 'm1', issuanceId: '', couponCode: '', status: 'reserved', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:30:00.000Z' }];
  const store = new MemoryStore(state);

  const result = await updatePaymentState(store, working => {
    const order = working.records.orders[0];
    const attempt = working.records.paymentAttempts[0];
    return applyApprovalResult(working, { serverRef: attempt.serverRef, approval: approvalFor(order, attempt), now: new Date('2026-01-01T00:05:00.000Z') });
  });

  assert.equal(result.value.failed, true);
  const [order] = store.state.records.orders;
  const [attempt] = store.state.records.paymentAttempts;
  assert.equal(attempt.status, 'approved');
  assert.equal(attempt.pgCno, 'pg-confirmed');
  assert.deepEqual(order.parts[0], { id: 'part-1', amount: 80, approvedAmount: 80, remainingAmount: 0, status: 'approved' });
  assert.equal(order.status, 'partial');
  assert.equal(order.stage, 'reconciliation_required');
  assert.equal(order.manualRefundRequired, true);
  assert.equal(store.state.records.members[0].paidPoints, 100, 'the mixed-payment debit was rolled back');
  assert.equal(store.state.records.pointsTransactions, undefined, 'no wallet mutation survived');
  assert.equal(store.state.records.videoEntitlements, undefined, 'no entitlement was granted');
});

test('registration failures distinguish a known decline from an indeterminate PG request and never re-register unknown money', async () => {
  let calls = 0;
  const unknownProvider = {
    configured: true,
    async register() { calls += 1; throw new EasyPayProviderError('PG_RECONCILIATION_REQUIRED', 'timeout', 503); },
  };
  const unknown = await routerSetup(unknownProvider);
  const created = await unknown.client.post('/api/payments/create').set(unknown.headers).send({ kind: 'video', method: 'card', videoId: 'video-1', nonce: 'unknown-register-order-1' }).expect(201);
  const path = `/api/payments/orders/${created.body.order.id}/parts/part-1/register`;
  await unknown.client.post(path).set(unknown.headers).send({}).expect(503);
  const unknownAttempt = unknown.store.state.records.paymentAttempts[0];
  assert.equal(unknownAttempt.status, 'registration_unknown');
  assert.equal(unknown.store.state.records.orders[0].stage, 'registration_unknown');
  assert.equal(unknown.store.state.records.orders[0].manualRefundRequired, true);
  const retry = await unknown.client.post(path).set(unknown.headers).send({}).expect(409);
  assert.equal(retry.body.error.code, 'PG_RECONCILIATION_REQUIRED');
  assert.equal(calls, 1, 'an indeterminate registration must not produce a fresh PG trade');

  const knownProvider = {
    configured: true,
    async register() { throw new EasyPayProviderError('KICC_REGISTRATION_FAILED', 'declined', 502); },
  };
  const known = await routerSetup(knownProvider);
  known.store.state.records.coupons.push({ id: 'discount-1', title: '할인', status: 'active', benefitType: 'amount', benefitValue: 10, issueMethod: 'download', targetMode: 'all', videoId: 'video-1', usageUnlimited: true });
  const knownOrder = await known.client.post('/api/payments/create').set(known.headers).send({ kind: 'video', method: 'card', videoId: 'video-1', couponId: 'discount-1', nonce: 'known-register-order-01' }).expect(201);
  await known.client.post(`/api/payments/orders/${knownOrder.body.order.id}/parts/part-1/register`).set(known.headers).send({}).expect(502);
  assert.equal(known.store.state.records.paymentAttempts[0].status, 'failed');
  assert.equal(known.store.state.records.orders[0].parts[0].status, 'failed');
  assert.equal(known.store.state.records.paymentCouponReservations[0].status, 'released');
});

test('an approval transport exception remains a reconciliation claim rather than a known payment failure', async () => {
  const provider = {
    configured: true,
    async register({ part }) { return { authPageUrl: `https://auth.test/${part.serverRef}` }; },
    async approve() { throw new EasyPayProviderError('PG_RECONCILIATION_REQUIRED', 'approval timeout', 503); },
  };
  const { store, client, headers } = await routerSetup(provider);
  const created = await client.post('/api/payments/create').set(headers).send({ kind: 'video', method: 'card', videoId: 'video-1', nonce: 'approve-timeout-order-1' }).expect(201);
  const orderId = created.body.order.id;
  await client.post(`/api/payments/orders/${orderId}/parts/part-1/register`).set(headers).send({}).expect(200);
  const attempt = store.state.records.paymentAttempts[0];
  await client.post('/api/payments/easypay/return').type('form').send({ shopTransactionId: attempt.serverRef, callbackToken: attempt.callbackToken, authCode: 'auth-1' }).expect(503);
  assert.equal(store.state.records.paymentAttempts[0].status, 'approving');
  assert.equal(store.state.records.orders[0].stage, 'reconciliation_required');
  assert.equal(store.state.records.orders[0].manualRefundRequired, true);
});

test('CAS creation accounts for global coupon holds and releases only an expired uncharged code reservation', async () => {
  const state = seed();
  state.records.coupons.push({
    id: 'many-codes', title: '코드 할인', status: 'active', benefitType: 'amount', benefitValue: 10,
    issueMethod: 'couponCode', couponCodeMode: 'multiple', generatedCodes: ['ALPHA', 'BETA'], couponQuantity: 2,
    usageUnlimited: true, targetMode: 'all', videoId: 'video-1',
  });
  const store = new MemoryStore(state);
  const firstAt = new Date('2026-01-01T00:00:00.000Z');
  const cardRequest = (nonce, code) => ({ kind: 'video', method: 'card', videoId: 'video-1', couponCode: code, nonce });
  await createPaymentOrder({ store, session: { user: { openId: 'member-one' } }, request: cardRequest('coupon-hold-order-01', 'ALPHA'), providerConfigured: true, now: firstAt });
  await assert.rejects(
    createPaymentOrder({ store, session: { user: { openId: 'member-two' } }, request: cardRequest('coupon-hold-order-02', 'ALPHA'), providerConfigured: true, now: firstAt }),
    cause => cause instanceof PaymentDomainError && cause.code === 'COUPON_CODE_RESERVED',
  );
  await createPaymentOrder({ store, session: { user: { openId: 'member-two' } }, request: cardRequest('coupon-hold-order-03', 'ALPHA'), providerConfigured: true, now: new Date(firstAt.valueOf() + COUPON_RESERVATION_TTL_MS) });
  const reservations = store.state.records.paymentCouponReservations;
  assert.equal(reservations[0].status, 'released');
  assert.equal(reservations[1].status, 'reserved');
});
