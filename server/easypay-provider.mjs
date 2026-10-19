import { createHmac } from 'node:crypto';

const KICC_DOCS = Object.freeze({
  introduction: 'https://docs.kicc.co.kr/docs/online-payment/general/introduction/',
  register: 'https://docs.kicc.co.kr/en/docs/online-payment/general/integration/register-tx',
  window: 'https://docs.kicc.co.kr/en/docs/online-payment/general/integration/payment-window',
  approve: 'https://docs.kicc.co.kr/en/docs/online-payment/general/integration/approve-payment',
  apiDomains: 'https://docs.kicc.co.kr/en/docs/online-payment/common/api-domain/',
});
const API_ORIGINS = new Set(['https://testpgapi.easypay.co.kr', 'https://pgapi.easypay.co.kr']);

export class EasyPayProviderError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.name = 'EasyPayProviderError';
    this.code = code;
    this.status = status;
  }
}

function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function number(value) { const n = Number(value); return Number.isSafeInteger(n) && n >= 0 ? n : null; }
function hmac(secret, value) { return createHmac('sha256', secret).update(value, 'utf8').digest('hex'); }
function providerError(code, message, status) { throw new EasyPayProviderError(code, message, status); }
function apiOrigin(value) {
  const raw = text(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '') || !API_ORIGINS.has(url.origin) ? '' : url.origin;
  } catch { return ''; }
}
function callbackUrl(value, token) {
  try {
    const url = new URL(text(value));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !text(token)) return '';
    url.searchParams.set('callbackToken', text(token));
    return url.href;
  } catch { return ''; }
}
function utf8(value, limit) {
  let out = '';
  for (const character of Array.from(text(value))) {
    if (Buffer.byteLength(out + character, 'utf8') > limit) break;
    out += character;
  }
  return out;
}
function equalHmac(left, right) {
  const a = text(left); const b = text(right);
  return a.length === b.length && a.length > 0 && /^[a-f0-9]{64}$/i.test(a) && /^[a-f0-9]{64}$/i.test(b) && a.toLowerCase() === b.toLowerCase();
}
function responseObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : null; }

/** Retained for callers that used the legacy simple-payment helpers. General Web Payment does not send this registration HMAC. */
export function registrationMessageAuthValue({ customerKey, shopTransactionId, payMethodDetailCode, easypayVirtualNo, amount, secret }) {
  const values = [customerKey, shopTransactionId, payMethodDetailCode, easypayVirtualNo].map(text);
  const amountValue = number(amount);
  if (!secret || values.some(value => !value) || amountValue === null) providerError('INVALID_KICC_REGISTRATION', 'KICC 거래등록 필수값이 없습니다.', 400);
  return hmac(secret, `${values.join('|')}|${amountValue}`);
}
/** This is the General Payment approval-response integrity formula published by KICC. */
export function approvalMessageAuthValue({ pgCno, amount, transactionDate, secret }) {
  const pg = text(pgCno); const date = text(transactionDate); const amountValue = number(amount);
  if (!secret || !pg || !date || amountValue === null) providerError('INVALID_KICC_APPROVAL', 'KICC 승인 검증 필수값이 없습니다.', 400);
  return hmac(secret, `${pg}|${amountValue}|${date}`);
}
export function cancelMessageAuthValue({ pgCno, shopTransactionId, secret }) {
  const pg = text(pgCno); const transaction = text(shopTransactionId);
  if (!secret || !pg || !transaction) providerError('INVALID_KICC_CANCEL', 'KICC 취소 검증 필수값이 없습니다.', 400);
  return hmac(secret, `${pg}|${transaction}`);
}

/**
 * General Payment needs the KICC merchant ID and the Secret Key used to verify approval responses.
 * There is no API-key field in the documented Web Payment requests.
 */
export function loadPaymentConfig(env = process.env) {
  const mallId = text(env.WILLCLUB_EASYPAY_MALL_ID);
  const secret = text(env.WILLCLUB_EASYPAY_SECRET);
  const origin = apiOrigin(env.WILLCLUB_EASYPAY_API_DOMAIN);
  const requested = env.WILLCLUB_EASYPAY_ENABLED === 'true';
  const missing = [
    !mallId && 'WILLCLUB_EASYPAY_MALL_ID',
    !secret && 'WILLCLUB_EASYPAY_SECRET',
    !origin && 'WILLCLUB_EASYPAY_API_DOMAIN',
  ].filter(Boolean);
  return Object.freeze({
    provider: 'kicc-easypay-general-web',
    configured: requested && missing.length === 0,
    requested,
    credentialPresent: missing.length === 0,
    missing,
    _merchant: { mallId, secret, origin, deviceTypeCode: text(env.WILLCLUB_EASYPAY_DEVICE_TYPE) === 'mobile' ? 'mobile' : 'pc' },
    docs: KICC_DOCS,
    reason: requested && !missing.length ? '' : 'WILLCLUB_EASYPAY_ENABLED=true 및 KICC 일반결제 가맹점 설정이 필요합니다.',
  });
}

function dateYmd(clock) { return clock().toISOString().slice(0, 10).replaceAll('-', ''); }
function registrationRequest({ merchant, order, part, paymentMethod }) {
  const amount = number(part?.amount);
  const serverRef = text(part?.serverRef);
  const returnUrl = callbackUrl(paymentMethod?.returnUrl, paymentMethod?.callbackToken);
  if (!merchant.mallId || !merchant.secret) providerError('PG_NOT_CONFIGURED', 'KICC EasyPay 가맹점 설정이 필요합니다.', 503);
  if (!order?.id || !serverRef || amount === null || amount < 1 || !returnUrl) providerError('INVALID_ORDER_BINDING', 'KICC 일반결제 주문 바인딩 또는 returnUrl이 올바르지 않습니다.', 409);
  // Each card part gets its own KICC-unique order number. The serverRef is stored before registration and is never browser supplied.
  return {
    mallId: merchant.mallId,
    shopOrderNo: serverRef,
    amount,
    payMethodTypeCode: '00',
    currency: '00',
    returnUrl,
    deviceTypeCode: merchant.deviceTypeCode,
    clientTypeCode: '00',
    orderInfo: { goodsName: utf8(order.title || 'WILLCLUB 결제', 50) || 'WILLCLUB 결제' },
  };
}

export function createEasyPayProvider(config = {}) {
  const merchant = config._merchant || {};
  const live = config.configured === true && Boolean(merchant.mallId && merchant.secret && apiOrigin(merchant.origin));
  const fetchImpl = config.fetch || globalThis.fetch;
  const clock = typeof config.now === 'function' ? config.now : () => new Date();

  function notReady() { providerError('PG_NOT_CONFIGURED', 'KICC EasyPay 일반결제 가맹점 설정이 필요합니다.', 503); }
  async function post(path, payload) {
    if (typeof fetchImpl !== 'function') notReady();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      let result;
      try {
        result = await fetchImpl(new URL(path, merchant.origin).href, {
          method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8', accept: 'application/json' },
          body: JSON.stringify(payload), signal: controller.signal,
        });
      } catch (cause) {
        throw new EasyPayProviderError('PG_RECONCILIATION_REQUIRED', 'KICC 응답을 받지 못했습니다. 거래상태 조회 후 처리하세요.', 503);
      }
      let body;
      try { body = responseObject(await result?.json?.()); } catch { body = null; }
      if (!result?.ok || !body) throw new EasyPayProviderError('PG_RECONCILIATION_REQUIRED', 'KICC HTTP 응답을 확인할 수 없습니다. 거래상태 조회 후 처리하세요.', 503);
      return body;
    } finally { clearTimeout(timeout); }
  }

  return Object.freeze({
    name: 'kicc-easypay-general-web', configured: live, docs: KICC_DOCS,
    async register({ order, part, paymentMethod }) {
      if (!live) return notReady();
      const request = registrationRequest({ merchant, order, part, paymentMethod });
      const response = await post('/api/ep9/trades/webpay', request);
      const authPageUrl = text(response.authPageUrl);
      if (text(response.resCd) !== '0000' || !authPageUrl) providerError('KICC_REGISTRATION_FAILED', 'KICC 결제창 등록 결과를 확인할 수 없습니다.', 502);
      try {
        const url = new URL(authPageUrl);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid');
      } catch { providerError('KICC_REGISTRATION_FAILED', 'KICC 결제창 URL이 올바르지 않습니다.', 502); }
      return { authPageUrl, pgCno: '', shopTransactionId: text(part.serverRef), shopOrderNo: request.shopOrderNo };
    },
    async approve({ order, attempt, authorizationId }) {
      if (!live) return notReady();
      const auth = text(authorizationId); const serverRef = text(attempt?.serverRef);
      if (!auth || !serverRef || !text(order?.id) || number(attempt?.amount) === null) providerError('AUTHORIZATION_ID_REQUIRED', 'KICC 인증 거래번호가 필요합니다.', 400);
      const request = { mallId: merchant.mallId, shopOrderNo: serverRef, shopTransactionId: serverRef, authorizationId: auth, approvalReqDate: dateYmd(clock) };
      const response = await post('/api/ep9/trades/approval', request);
      const amount = number(response.amount);
      if (text(response.resCd) !== '0000') return { ok: false, code: `KICC_APPROVAL_${text(response.resCd) || 'FAILED'}` };
      const expectedHmac = text(response.pgCno) && text(response.transactionDate) && amount !== null
        ? approvalMessageAuthValue({ pgCno: response.pgCno, amount, transactionDate: response.transactionDate, secret: merchant.secret }) : '';
      const card = responseObject(response.paymentInfo)?.cardInfo || {};
      const installment = number(card.installmentMonth);
      const bindingsMatch = text(response.mallId) === merchant.mallId && text(response.shopTransactionId) === serverRef && text(response.shopOrderNo) === serverRef &&
        amount === attempt.amount && Boolean(text(response.pgCno)) && equalHmac(response.msgAuthValue, expectedHmac);
      // The application has no KICC issuer-code mapping; its company label is not an approval binding.
      // A documented installment result, when returned, must still match the server's card-part term.
      const cardTermsMatch = installment === null || installment === Number(attempt.installments || 0);
      if (!bindingsMatch || !cardTermsMatch) return { ok: false, code: !bindingsMatch ? 'APPROVAL_BINDING_MISMATCH' : 'APPROVAL_CARD_TERMS_MISMATCH' };
      // payment-orders has a legacy internal contract keyed by its parent order ID. The raw KICC order key above was still verified as serverRef.
      return { ok: true, currency: 'KRW', amount, shopTransactionId: serverRef, shopOrderNo: order.id, pgCno: text(response.pgCno), transactionId: text(response.pgCno) };
    },
    // No auto refund: query KICC state and complete a reconciled operator workflow first.
    async cancel() { providerError('MANUAL_REFUND_REQUIRED', '자동 취소는 비활성화되어 있습니다. KICC 거래상태 조회 후 관리자 절차로 처리하세요.', 409); },
  });
}
