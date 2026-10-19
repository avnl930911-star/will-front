import assert from 'node:assert/strict';
import test from 'node:test';
import {
  approvalMessageAuthValue, createEasyPayProvider, EasyPayProviderError, loadPaymentConfig,
} from '../server/easypay-provider.mjs';

const merchantEnv = {
  WILLCLUB_EASYPAY_ENABLED: 'true',
  WILLCLUB_EASYPAY_MALL_ID: 'T5102001',
  WILLCLUB_EASYPAY_SECRET: 'test-secret',
  WILLCLUB_EASYPAY_API_DOMAIN: 'https://testpgapi.easypay.co.kr',
};
const order = { id: 'ord_12345678', title: '유료 주식교육영상' };
const part = { amount: 1000, serverRef: 'tx_12345678' };
function json(body, ok = true) { return { ok, async json() { return body; } }; }
function approved({ amount = 1000 } = {}) {
  const pgCno = 'PG-123'; const transactionDate = '20260102030405';
  return {
    resCd: '0000', mallId: merchantEnv.WILLCLUB_EASYPAY_MALL_ID, pgCno,
    shopTransactionId: part.serverRef, shopOrderNo: part.serverRef, amount, transactionDate,
    msgAuthValue: approvalMessageAuthValue({ pgCno, amount, transactionDate, secret: merchantEnv.WILLCLUB_EASYPAY_SECRET }),
    paymentInfo: { cardInfo: { installmentMonth: 0 } },
  };
}

test('is disabled by default and when merchant fields are incomplete', async () => {
  const disabled = loadPaymentConfig({});
  assert.equal(disabled.configured, false);
  assert.deepEqual(disabled.missing, ['WILLCLUB_EASYPAY_MALL_ID', 'WILLCLUB_EASYPAY_SECRET', 'WILLCLUB_EASYPAY_API_DOMAIN']);
  const incomplete = loadPaymentConfig({ WILLCLUB_EASYPAY_ENABLED: 'true', WILLCLUB_EASYPAY_MALL_ID: 'T5102001' });
  assert.equal(incomplete.configured, false);
  await assert.rejects(createEasyPayProvider(incomplete).register({ order, part, paymentMethod: {} }), EasyPayProviderError);
});

test('posts only documented General Payment webpay fields and normalizes its per-part identifiers', async () => {
  const calls = [];
  const provider = createEasyPayProvider({ ...loadPaymentConfig(merchantEnv), now: () => new Date('2026-01-02T12:00:00Z'), fetch: async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    if (url.endsWith('/webpay')) return json({ resCd: '0000', authPageUrl: 'https://testpgapi.easypay.co.kr/payment/window' });
    return json(approved());
  } });
  const registered = await provider.register({ order, part, paymentMethod: { returnUrl: 'https://merchant.example/api/payments/easypay/return', callbackToken: 'opaque-server-token' } });
  assert.equal(registered.authPageUrl, 'https://testpgapi.easypay.co.kr/payment/window');
  assert.equal(calls[0].url, 'https://testpgapi.easypay.co.kr/api/ep9/trades/webpay');
  assert.deepEqual(calls[0].body, {
    mallId: 'T5102001', shopOrderNo: part.serverRef, amount: 1000, payMethodTypeCode: '00', currency: '00',
    returnUrl: 'https://merchant.example/api/payments/easypay/return?callbackToken=opaque-server-token',
    deviceTypeCode: 'pc', clientTypeCode: '00', orderInfo: { goodsName: '유료 주식교육영상' },
  });
  assert.equal(calls[0].options.headers['content-type'], 'application/json; charset=utf-8');
  const approval = await provider.approve({ order, attempt: { ...part, installments: 0, company: '선택 카드' }, authorizationId: 'AUTH-123' });
  assert.deepEqual(calls[1].body, {
    mallId: 'T5102001', shopOrderNo: part.serverRef, shopTransactionId: part.serverRef,
    authorizationId: 'AUTH-123', approvalReqDate: '20260102',
  });
  assert.deepEqual(approval, {
    ok: true, currency: 'KRW', amount: 1000, shopTransactionId: part.serverRef,
    shopOrderNo: order.id, pgCno: 'PG-123', transactionId: 'PG-123',
  });
});

test('rejects an approval whose KICC amount does not match the canonical part amount', async () => {
  const provider = createEasyPayProvider({ ...loadPaymentConfig(merchantEnv), fetch: async () => json(approved({ amount: 999 })) });
  const result = await provider.approve({ order, attempt: { ...part, installments: 0 }, authorizationId: 'AUTH-123' });
  assert.deepEqual(result, { ok: false, code: 'APPROVAL_BINDING_MISMATCH' });
});

test('does not convert an ambiguous network result into a payment failure', async () => {
  const provider = createEasyPayProvider({ ...loadPaymentConfig(merchantEnv), fetch: async () => { throw new Error('timeout'); } });
  await assert.rejects(
    provider.approve({ order, attempt: { ...part, installments: 0 }, authorizationId: 'AUTH-123' }),
    error => error instanceof EasyPayProviderError && error.code === 'PG_RECONCILIATION_REQUIRED',
  );
});
