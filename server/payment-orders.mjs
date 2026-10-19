import { randomUUID } from 'node:crypto';
import { isPublicVideo } from './catalog.mjs';
import { quoteVideoCoupon, resolveMember } from './video-coupons.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NONCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{8,128}$/;
const ACTIVE_ORDER = new Set(['draft', 'pending', 'partial']);
const ACTIVE_COUPON = new Set(['사용가능', '사용', 'active', 'on', 'enabled']);
const USED_COUPON = new Set(['사용완료', 'used', 'redeemed', 'consumed', 'expired', '만료', '취소', 'cancelled', 'canceled']);
export const COUPON_RESERVATION_TTL_MS = 30 * 60 * 1000;

export class PaymentDomainError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'PaymentDomainError';
    this.code = code;
    this.status = status;
  }
}

function own(object, key) { return Object.prototype.hasOwnProperty.call(object || {}, key); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function integer(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : null;
  }
  return null;
}
function positive(value) { const n = integer(value); return n !== null && n > 0 ? n : null; }
function id(value) { const candidate = text(value); return ID.test(candidate) ? candidate : ''; }
function newId(prefix) { return `${prefix}_${randomUUID()}`; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function dateIso(now) { return (now instanceof Date ? now : new Date(now)).toISOString(); }
function records(state, name) {
  if (!object(state.records)) state.records = {};
  if (!Array.isArray(state.records[name])) state.records[name] = [];
  return state.records[name];
}
function memberId(member) { return id(member?.memberId) || id(member?.id); }
function memberIds(member) { return new Set([memberId(member), id(member?.id), id(member?.memberId)].filter(Boolean)); }
function fail(code, message, status) { throw new PaymentDomainError(code, message, status); }

/** Retriable CAS updater shared by JSON and MySQL state stores. */
export async function updatePaymentState(store, mutate, { retries = 8 } = {}) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const snapshot = await store.snapshot();
    const state = clone(snapshot.state);
    const value = await mutate(state, snapshot);
    const replacement = await store.replace(snapshot.revision, state);
    if (replacement.ok) return { value, state: replacement.state, revision: replacement.revision };
  }
  fail('STATE_CONFLICT', '결제 상태가 동시에 변경되었습니다. 다시 시도해 주세요.', 409);
}

/** Only the two new physical buckets are customer spendable. Legacy `balance` is never read. */
export function pointsForMember(state, member) {
  const canonical = member && (records(state, 'members').find(row => memberIds(member).has(memberId(row))) || member);
  const paidPoints = positiveOrZero(canonical?.paidPoints);
  const freePoints = positiveOrZero(canonical?.freePoints);
  const held = records(state, 'orders')
    .filter(order => order?.ownerMemberId === memberId(canonical) && ACTIVE_ORDER.has(order.status) && order.pointsReserved === true)
    .reduce((sum, order) => sum + positiveOrZero(order.pointAmount), 0);
  return {
    paidPoints,
    freePoints,
    balance: paidPoints + freePoints,
    availablePoints: Math.max(0, paidPoints + freePoints - held),
    reservedPoints: held,
  };
}
function positiveOrZero(value) { const n = integer(value); return n !== null && n >= 0 ? n : 0; }

function resolveOwnedMember(state, session) {
  const member = resolveMember(state, session);
  if (!member || !memberId(member)) fail('MEMBER_NOT_LINKED', '로그인 회원 정보를 확인할 수 없습니다.', 403);
  return member;
}

function publicPaidVideo(state, videoId) {
  const video = records(state, 'videos').find(row => row?.id === videoId && isPublicVideo(row));
  const amount = positive(video?.amount);
  if (!video || !amount) fail('VIDEO_NOT_FOUND', '공개 유료 주식교육영상을 찾을 수 없습니다.', 404);
  return { video, amount };
}

function salesProduct(state, productId, optionId) {
  const product = records(state, 'products').find(row => row?.id === productId);
  if (!product || product.display === false || text(product.visible) !== '판매중') {
    fail('PRODUCT_NOT_FOR_SALE', '판매 중인 VIP 서비스가 아닙니다.', 404);
  }
  const option = Array.isArray(product.options) ? product.options.find(row => row?.id === optionId) : null;
  const amount = positive(option?.amount);
  if (!option || !amount) fail('PRODUCT_OPTION_NOT_FOR_SALE', '선택한 VIP 서비스 옵션을 구매할 수 없습니다.', 404);
  return { product, option, amount };
}

function readCouponQuote(state, videoId, session, request, now) {
  const hasId = own(request, 'couponId') && request.couponId !== '';
  const code = own(request, 'couponCode') ? request.couponCode : request.code;
  const hasCode = typeof code === 'string' && code !== '';
  if (!hasId && !hasCode) return { discount: 0, coupon: null };
  const result = quoteVideoCoupon({
    state, videoId, session,
    payload: hasId ? (hasCode ? { couponId: request.couponId, code } : { couponId: request.couponId }) : { code },
    now,
  });
  if (result.status !== 200) {
    const err = result.body?.error || {};
    fail(err.code || 'COUPON_NOT_AVAILABLE', err.message || '쿠폰을 사용할 수 없습니다.', result.status);
  }
  return {
    discount: result.body.discountAmount,
    coupon: { id: result.body.coupon.id, code: hasCode ? text(code).toUpperCase() : '' },
  };
}

function partInput(raw, index, total, split) {
  if (!object(raw)) fail('INVALID_PARTS', '카드 결제 분할 정보가 올바르지 않습니다.');
  const company = text(raw.company);
  const amount = positive(raw.amount);
  const installmentsRaw = raw.installments === undefined || raw.installments === '' ? 0 : integer(raw.installments);
  if (!company || company.length > 50 || !amount || installmentsRaw === null || installmentsRaw < 0 || installmentsRaw > 60) {
    fail('INVALID_PARTS', '카드사·결제금액·할부개월 정보를 확인해 주세요.');
  }
  return { id: `part-${index + 1}`, company, amount, installments: installmentsRaw, approvedAmount: 0, remainingAmount: amount, status: 'pending', split };
}

function buildParts(method, total, rawParts) {
  if (method === 'points') return [];
  if (method === 'split') {
    if (!Array.isArray(rawParts) || rawParts.length < 2 || rawParts.length > 5) fail('INVALID_PARTS', 'VIP 다중카드는 2~5장으로 나누어야 합니다.');
    const parts = rawParts.map((part, index) => partInput(part, index, total, true));
    if (parts.reduce((sum, part) => sum + part.amount, 0) !== total) fail('PART_AMOUNT_MISMATCH', '분할 카드 금액 합계가 결제금액과 다릅니다.');
    return parts;
  }
  if (Array.isArray(rawParts) && rawParts.length > 1) fail('INVALID_PARTS', '단일 카드 결제에는 카드 한 장만 사용할 수 있습니다.');
  // The company/term are display assertions only. They are never converted to a KICC issuer code.
  const supplied = Array.isArray(rawParts) && rawParts[0] ? rawParts[0] : { company: '선택 카드', amount: total, installments: 0 };
  const part = partInput({ ...supplied, amount: total }, 0, total, false);
  return [part];
}

function quotePlan(state, session, request, { now = new Date() } = {}) {
  if (!object(request)) fail('INVALID_PAYMENT_REQUEST', '결제 요청 형식이 올바르지 않습니다.');
  const member = resolveOwnedMember(state, session);
  const kind = text(request.kind);
  const method = text(request.method);
  const requestedPoints = request.points === undefined ? 0 : integer(request.points);
  if (requestedPoints === null || requestedPoints < 0) fail('INVALID_POINTS', '포인트는 0 이상의 정수여야 합니다.');
  let originalAmount; let discount = 0; let title; let target; let coupon = null;
  if (kind === 'video') {
    const videoId = id(request.videoId);
    if (!videoId) fail('VIDEO_NOT_FOUND', '영상 정보가 올바르지 않습니다.', 404);
    const payable = publicPaidVideo(state, videoId);
    originalAmount = payable.amount;
    ({ discount, coupon } = readCouponQuote(state, videoId, session, request, now));
    title = text(payable.video.title) || '주식교육영상';
    target = { videoId, videoTitle: title };
    if (!['card', 'points', 'mixed'].includes(method)) fail('INVALID_METHOD', '영상은 카드·주식교육영상 포인트·혼합 결제만 가능합니다.');
  } else if (kind === 'vip') {
    const productId = id(request.productId); const optionId = id(request.optionId);
    if (!productId || !optionId) fail('PRODUCT_OPTION_NOT_FOR_SALE', 'VIP 서비스 옵션을 선택해 주세요.', 404);
    const payable = salesProduct(state, productId, optionId);
    originalAmount = payable.amount;
    title = text(payable.product.title) || 'VIP 서비스';
    const baseMonths = positiveOrZero(payable.option.baseMonths ?? payable.option.base_period ?? payable.product.baseMonths);
    const bonusMonths = positiveOrZero(payable.option.bonusMonths ?? payable.option.bonus_period ?? payable.product.bonusMonths);
    target = { productId, optionId, productTitle: title, optionTitle: text(payable.option.title), totalMonths: baseMonths + bonusMonths };
    if (!['card', 'split'].includes(method) || requestedPoints !== 0 || own(request, 'couponId') || own(request, 'couponCode') || own(request, 'code')) {
      fail('VIP_CARD_ONLY', 'VIP 서비스는 카드 또는 2~5장 다중카드 결제만 가능합니다.');
    }
  } else if (kind === 'points') {
    originalAmount = positive(request.amount);
    if (!originalAmount) fail('INVALID_TOPUP_AMOUNT', '충전금액은 1원 이상의 정수여야 합니다.');
    title = '주식교육영상 포인트 충전';
    target = { topupAmount: originalAmount };
    if (method !== 'card' || requestedPoints !== 0) fail('TOPUP_CARD_ONLY', '포인트 충전은 카드 결제만 가능합니다.');
  } else {
    fail('INVALID_KIND', '지원하지 않는 결제 대상입니다.');
  }
  const totalAmount = originalAmount - discount;
  let pointAmount = 0;
  if (kind === 'video') {
    if (method === 'points') pointAmount = totalAmount;
    else if (method === 'mixed') pointAmount = requestedPoints;
    if ((method === 'card' && requestedPoints !== 0) || pointAmount > totalAmount || (method === 'mixed' && (pointAmount < 1 || pointAmount >= totalAmount))) {
      fail('INVALID_POINTS', '선택한 결제수단에 맞는 주식교육영상 포인트 금액을 입력해 주세요.');
    }
  }
  const cardAmount = totalAmount - pointAmount;
  const parts = buildParts(method, cardAmount, request.parts);
  const wallet = pointsForMember(state, member);
  if (pointAmount > wallet.availablePoints) fail('INSUFFICIENT_POINTS', '사용 가능한 주식교육영상 포인트가 부족합니다.', 409);
  return {
    kind, method, ownerMemberId: memberId(member), originalAmount, discount, totalAmount, pointAmount, cardAmount,
    parts, pointsBalance: wallet.balance, availablePoints: wallet.availablePoints, coupon, target, title,
  };
}

export function quotePayment({ state, session, request, now = new Date() }) {
  const plan = quotePlan(state, session, request, { now });
  return publicQuote(plan);
}
function publicQuote(plan) {
  return {
    amount: plan.originalAmount,
    discount: plan.discount,
    totalAmount: plan.totalAmount,
    pointAmount: plan.pointAmount,
    cardAmount: plan.cardAmount,
    parts: plan.parts.map(part => ({ id: part.id, company: part.company, amount: part.amount, installments: part.installments, remainingAmount: part.remainingAmount })),
    pointsBalance: plan.pointsBalance,
    availablePoints: plan.availablePoints,
    canPay: true,
  };
}

function requestFingerprint(request) {
  const parts = Array.isArray(request?.parts) ? request.parts.map(part => [text(part?.company), part?.amount, part?.installments ?? part?.installment ?? 0]) : [];
  return JSON.stringify({
    kind: text(request?.kind), method: text(request?.method), videoId: id(request?.videoId), productId: id(request?.productId), optionId: id(request?.optionId),
    points: request?.points === undefined ? 0 : request.points, couponId: id(request?.couponId), couponCode: text(request?.couponCode || request?.code).toUpperCase(),
    amount: request?.amount, parts,
  });
}

function reservationCode(row) { return text(row?.couponCode || row?.code).toUpperCase(); }
function reservationExpiry(row) {
  const explicit = text(row?.expiresAt);
  const date = explicit ? new Date(explicit) : new Date(new Date(row?.createdAt).valueOf() + COUPON_RESERVATION_TTL_MS);
  return Number.isNaN(date.valueOf()) ? null : date;
}
function reservationExpired(row, now) {
  const expiry = reservationExpiry(row);
  const current = now instanceof Date ? now : new Date(now);
  return Boolean(expiry && !Number.isNaN(current.valueOf()) && current >= expiry);
}
function approvalMayBeInFlight(state, orderId) {
  return records(state, 'paymentAttempts').some(attempt => attempt?.orderId === orderId &&
    ['approving', 'registration_unknown', 'approval_unknown'].includes(attempt.status));
}
function releaseExpiredCouponReservations(state, now) {
  for (const reservation of records(state, 'paymentCouponReservations')) {
    if (reservation?.status !== 'reserved' || !reservationExpired(reservation, now)) continue;
    const order = records(state, 'orders').find(row => row?.id === reservation.orderId);
    const mustKeep = Boolean(order?.parts?.some(part => part.status === 'approved')) || approvalMayBeInFlight(state, reservation.orderId);
    if (!mustKeep) {
      reservation.status = 'released'; reservation.releasedAt = dateIso(now); reservation.releaseReason = 'reservation_expired';
      continue;
    }
    // A charged or in-flight transaction may no longer silently lose its accounting hold.
    reservation.needsManualReconciliation = true;
    if (order && order.status !== 'completed') {
      order.status = 'partial'; order.stage = 'reconciliation_required'; order.manualRefundRequired = true;
      order.failureCode = 'COUPON_RESERVATION_EXPIRED'; order.updatedAt = dateIso(now);
    }
  }
}
function couponEnabled(coupon) {
  if (own(coupon, 'status') && text(coupon.status)) return ACTIVE_COUPON.has(text(coupon.status).toLowerCase());
  return coupon?.enabled === true || coupon?.active === true;
}
function limitedCounter(row, key) {
  if (!own(row, key) || row[key] === undefined || row[key] === null || row[key] === '') return { seen: false, value: null };
  const value = integer(row[key]);
  return { seen: true, value };
}
function couponGlobalLimit(coupon) {
  const totalFields = ['totalQuantity', 'totalCount', 'maxUses'].map(key => limitedCounter(coupon, key));
  const usage = limitedCounter(coupon, 'usageLimit');
  const quantity = limitedCounter(coupon, own(coupon, 'couponQuantity') ? 'couponQuantity' : 'quantity');
  if ([...totalFields, usage, quantity].some(field => field.seen && (field.value === null || field.value < 1))) return 0;
  // Match video-coupons: couponQuantity applies to codes and explicitly quantity-limited downloads only.
  const codeCoupon = text(coupon.issueMethod) === 'couponCode' || (!text(coupon.issueMethod) && Boolean(text(coupon.code)));
  const limits = [...totalFields.filter(field => field.seen).map(field => field.value), ...(usage.seen ? [usage.value] : [])];
  if ((codeCoupon || (text(coupon.issueMethod) === 'download' && coupon.downloadQuantityLimited === true)) && quantity.seen) limits.push(quantity.value);
  if (coupon.usageUnlimited === false && !usage.seen) return 0;
  return limits.length ? Math.min(...limits) : null;
}
function counterValue(row, key) {
  const value = limitedCounter(row, key);
  return value.seen && value.value === null ? Number.MAX_SAFE_INTEGER : (value.value || 0);
}
function couponConsumedCount(state, coupon) {
  const couponCount = counterValue(coupon, 'usedCount');
  const issuanceCount = records(state, 'couponIssuances').filter(row => row?.couponId === coupon.id)
    .reduce((sum, row) => Math.min(Number.MAX_SAFE_INTEGER, sum + counterValue(row, 'usedCount')), 0);
  const reservationCount = records(state, 'paymentCouponReservations').filter(row => row?.couponId === coupon.id && row.status === 'consumed').length;
  return Math.max(couponCount, issuanceCount, reservationCount);
}
function issuanceMatchesCode(issuance, code) {
  if (!code) return true;
  const direct = text(issuance?.code || issuance?.couponCode).toUpperCase();
  const generated = Array.isArray(issuance?.generatedCodes) ? issuance.generatedCodes.map(value => text(value).toUpperCase()) : [];
  return !direct || direct === code || generated.includes(code);
}
function codeAlreadyHeldOrConsumed(state, coupon, code) {
  if (!code) return false;
  const reservationMatch = records(state, 'paymentCouponReservations').some(row => row?.couponId === coupon.id &&
    ['reserved', 'consumed'].includes(row.status) && (!reservationCode(row) || reservationCode(row) === code));
  const issuanceMatch = records(state, 'couponIssuances').some(row => row?.couponId === coupon.id &&
    counterValue(row, 'usedCount') > 0 && issuanceMatchesCode(row, code));
  return reservationMatch || issuanceMatch;
}
function releaseCouponReservations(state, orderId, now) {
  for (const row of records(state, 'paymentCouponReservations')) {
    if (row?.orderId === orderId && row.status === 'reserved') {
      row.status = 'released'; row.releasedAt = dateIso(now); row.releaseReason = 'registration_failed';
    }
  }
}
function couponReservation(state, order, plan, now) {
  if (!plan.coupon) return;
  releaseExpiredCouponReservations(state, now);
  const all = records(state, 'paymentCouponReservations');
  if (all.some(row => row.status === 'reserved' && row.ownerMemberId === order.ownerMemberId && row.couponId === plan.coupon.id)) {
    fail('COUPON_RESERVED', '같은 쿠폰으로 진행 중인 결제가 있습니다.', 409);
  }
  const coupon = records(state, 'coupons').find(row => row?.id === plan.coupon.id);
  if (!coupon || !couponEnabled(coupon) || !validCouponDate(coupon, now)) fail('COUPON_NOT_AVAILABLE', '쿠폰을 사용할 수 없습니다.', 403);
  const code = text(plan.coupon.code).toUpperCase();
  const globalLimit = couponGlobalLimit(coupon);
  const reserved = all.filter(row => row?.couponId === coupon.id && row.status === 'reserved').length;
  if (globalLimit !== null && couponConsumedCount(state, coupon) + reserved >= globalLimit) {
    fail('COUPON_CAPACITY_EXHAUSTED', '쿠폰 사용 가능 수량이 모두 예약되었습니다.', 409);
  }
  if (coupon.couponCodeMode === 'multiple' && code && codeAlreadyHeldOrConsumed(state, coupon, code)) {
    fail('COUPON_CODE_RESERVED', '입력한 쿠폰코드는 이미 사용 중이거나 사용되었습니다.', 409);
  }
  const eligibleIssuances = records(state, 'couponIssuances').filter(row => issuanceOwned(row, order.ownerMemberId) &&
    row.couponId === coupon.id && issuanceUsable(row) && issuanceMatchesCode(row, code));
  const ownedIssuances = records(state, 'couponIssuances').filter(row => issuanceOwned(row, order.ownerMemberId) && row.couponId === coupon.id);
  if (ownedIssuances.length && !eligibleIssuances.length) fail('COUPON_NOT_AVAILABLE', '쿠폰을 사용할 수 없습니다.', 403);
  const issuance = eligibleIssuances.find(row => !all.some(reservation => reservation.status === 'reserved' && reservation.issuanceId === row.id));
  if (eligibleIssuances.length && !issuance) fail('COUPON_RESERVED', '같은 쿠폰으로 진행 중인 결제가 있습니다.', 409);
  const createdAt = dateIso(now);
  all.push({ id: newId('couponres'), orderId: order.id, couponId: coupon.id, couponCode: code, ownerMemberId: order.ownerMemberId,
    issuanceId: issuance?.id || '', status: 'reserved', createdAt, expiresAt: new Date(new Date(createdAt).valueOf() + COUPON_RESERVATION_TTL_MS).toISOString() });
}

export async function createPaymentOrder({ store, session, request, providerConfigured = false, now = new Date() }) {
  const nonce = text(request?.nonce);
  if (!NONCE.test(nonce)) fail('IDEMPOTENCY_KEY_REQUIRED', '8자 이상의 안전한 결제 요청 번호가 필요합니다.');
  return updatePaymentState(store, state => {
    const member = resolveOwnedMember(state, session);
    const ownerMemberId = memberId(member);
    const existing = records(state, 'orders').find(row => row?.ownerMemberId === ownerMemberId && row.customerNonce === nonce);
    const requestedFingerprint = requestFingerprint(request);
    if (existing) {
      if (existing.requestFingerprint !== requestedFingerprint) fail('IDEMPOTENCY_MISMATCH', '같은 결제 요청 번호가 다른 주문에 사용되었습니다.', 409);
      return { order: existing, idempotent: true };
    }
    const plan = quotePlan(state, session, request, { now });
    const fingerprint = JSON.stringify({ kind: plan.kind, method: plan.method, target: plan.target, totalAmount: plan.totalAmount, pointAmount: plan.pointAmount, parts: plan.parts.map(part => [part.company, part.amount, part.installments]), coupon: plan.coupon?.id || '' });
    const createdAt = dateIso(now);
    const requiresPg = plan.cardAmount > 0;
    const order = {
      id: newId('ord'), ownerMemberId, customerNonce: nonce, requestFingerprint: requestedFingerprint, fingerprint, kind: plan.kind, method: plan.method,
      target: plan.target, title: plan.title, originalAmount: plan.originalAmount, discount: plan.discount, totalAmount: plan.totalAmount,
      pointAmount: plan.pointAmount, cardAmount: plan.cardAmount, currency: 'KRW', coupon: plan.coupon, parts: plan.parts,
      pointsReserved: Boolean(plan.pointAmount && (providerConfigured || !requiresPg)), status: requiresPg ? 'draft' : 'pending',
      stage: requiresPg ? 'pending' : 'points_pending', createdAt, updatedAt: createdAt, fulfilledAt: null, manualRefundRequired: false,
    };
    couponReservation(state, order, plan, now);
    records(state, 'orders').push(order);
    // Pure point video orders settle in the same CAS transaction. No PG configuration is needed because no card is charged.
    if (!requiresPg) settleOrder(state, order, now);
    return { order, idempotent: false };
  });
}

function debitPoints(state, order, now) {
  if (!order.pointAmount) return;
  const member = records(state, 'members').find(row => memberId(row) === order.ownerMemberId);
  if (!member) fail('MEMBER_NOT_LINKED', '주문 회원 정보를 찾을 수 없습니다.', 409);
  const free = positiveOrZero(member.freePoints); const paid = positiveOrZero(member.paidPoints);
  if (free + paid < order.pointAmount) fail('INSUFFICIENT_POINTS', '예약한 주식교육영상 포인트를 사용할 수 없습니다.', 409);
  const freeUsed = Math.min(free, order.pointAmount);
  const paidUsed = order.pointAmount - freeUsed;
  member.freePoints = free - freeUsed;
  member.paidPoints = paid - paidUsed;
  records(state, 'pointsTransactions').push({ id: newId('pointtx'), ownerMemberId: order.ownerMemberId, orderId: order.id, type: 'spend', paidPoints: -paidUsed, freePoints: -freeUsed, amount: order.pointAmount, balanceAfter: member.paidPoints + member.freePoints, status: 'confirmed', createdAt: dateIso(now) });
}

function consumeCoupon(state, order, now) {
  if (!order.coupon) return;
  const reservation = records(state, 'paymentCouponReservations').find(row => row.orderId === order.id && row.status === 'reserved');
  if (!reservation) fail('COUPON_RESERVATION_MISSING', '쿠폰 예약 정보를 찾을 수 없습니다.', 409);
  const coupon = records(state, 'coupons').find(row => row?.id === reservation.couponId);
  if (!coupon || reservation.couponId !== order.coupon.id || !couponEnabled(coupon) || !validCouponDate(coupon, now)) {
    fail('COUPON_NOT_AVAILABLE', '쿠폰이 결제 완료 시점에 유효하지 않습니다.', 409);
  }
  if (reservationExpired(reservation, now)) {
    reservation.needsManualReconciliation = true;
    fail('COUPON_RESERVATION_EXPIRED', '쿠폰 예약 시간이 만료되어 결제 확인이 필요합니다.', 409);
  }
  if (reservationCode(reservation) !== text(order.coupon.code).toUpperCase()) {
    fail('COUPON_RESERVATION_MISMATCH', '쿠폰 예약 정보가 주문과 일치하지 않습니다.', 409);
  }
  if (reservation.issuanceId) {
    const issuance = records(state, 'couponIssuances').find(row => row?.id === reservation.issuanceId && issuanceOwned(row, order.ownerMemberId));
    if (!issuance || !issuanceUsable(issuance)) fail('COUPON_NOT_AVAILABLE', '쿠폰이 이미 사용되었거나 만료되었습니다.', 409);
    issuance.usedCount = positiveOrZero(issuance.usedCount) + 1;
    issuance.used = true; issuance.status = 'used'; issuance.usedAt = dateIso(now); issuance.orderId = order.id;
  }
  // coupon.usedCount is the global counter even when a member-specific issuance was consumed.
  coupon.usedCount = positiveOrZero(coupon.usedCount) + 1;
  reservation.status = 'consumed'; reservation.consumedAt = dateIso(now);
}

function appendVideoEntitlement(state, order, now) {
  const videoId = order.target?.videoId;
  if (!videoId) fail('ORDER_TARGET_INVALID', '영상 주문 대상이 올바르지 않습니다.', 409);
  const rows = records(state, 'videoEntitlements');
  if (!rows.some(row => row.orderId === order.id && row.ownerMemberId === order.ownerMemberId && row.videoId === videoId)) {
    rows.push({ id: newId('videoent'), ownerMemberId: order.ownerMemberId, videoId, orderId: order.id, status: 'paidConfirmed', createdAt: dateIso(now) });
  }
}

function appendVipService(state, order, now) {
  const member = records(state, 'members').find(row => memberId(row) === order.ownerMemberId);
  const target = order.target || {};
  if (!member || !target.productId || !target.optionId) fail('ORDER_TARGET_INVALID', 'VIP 서비스 주문 대상이 올바르지 않습니다.', 409);
  const product = records(state,'products').find(row => row.id === target.productId);
  const option = (product?.options || []).find(row => row.id === target.optionId);
  const quotedMonths = own(target, 'totalMonths') ? integer(target.totalMonths) : null;
  const months = quotedMonths !== null && quotedMonths >= 0
    ? quotedMonths
    : positiveOrZero(option?.baseMonths ?? option?.base_period ?? product?.baseMonths) + positiveOrZero(option?.bonusMonths ?? option?.bonus_period ?? product?.bonusMonths);
  const began = now instanceof Date ? new Date(now) : new Date(now);
  const ended = new Date(began); const day = ended.getUTCDate();
  ended.setUTCDate(1); ended.setUTCMonth(ended.getUTCMonth()+months);
  const lastDay = new Date(Date.UTC(ended.getUTCFullYear(),ended.getUTCMonth()+1,0)).getUTCDate();
  ended.setUTCDate(Math.min(day,lastDay));
  const service = {id:target.productId,product:target.productTitle,productId:target.productId,optionId:target.optionId,orderId:order.id,status:'정상',start:began.toISOString().slice(0,10),end:ended.toISOString().slice(0,10),expert:product?.expert||'',confirmedAt:dateIso(now)};
  for(const field of ['services','serviceDetails']) {
    if(!Array.isArray(member[field])) member[field]=[];
    if(!member[field].some(row=>row?.orderId===order.id)) member[field].push({...service});
  }
  const services=records(state,'memberServices');
  if(!services.some(row=>row?.orderId===order.id))services.push({...service,id:newId('membersvc'),ownerMemberId:order.ownerMemberId,memberId:order.ownerMemberId});
}

function creditTopup(state, order, now) {
  const member = records(state, 'members').find(row => memberId(row) === order.ownerMemberId);
  if (!member) fail('MEMBER_NOT_LINKED', '주문 회원 정보를 찾을 수 없습니다.', 409);
  const amount = positive(order.target?.topupAmount);
  if (!amount || amount !== order.totalAmount) fail('ORDER_TARGET_INVALID', '충전 주문 금액이 올바르지 않습니다.', 409);
  member.paidPoints = positiveOrZero(member.paidPoints) + amount;
  records(state, 'pointsTransactions').push({ id: newId('pointtx'), ownerMemberId: order.ownerMemberId, orderId: order.id, type: 'topup', paidPoints: amount, freePoints: 0, amount, balanceAfter: member.paidPoints + member.freePoints, status: 'confirmed', createdAt: dateIso(now) });
}

function appendPaymentRecord(state, order, now) {
  const payments = records(state, 'payments');
  if (payments.some(row => row?.orderId === order.id)) return;
  const member = records(state, 'members').find(row => memberId(row) === order.ownerMemberId) || {};
  const source = order.kind === 'vip'
    ? records(state, 'products').find(row => row?.id === order.target?.productId)
    : records(state, 'videos').find(row => row?.id === order.target?.videoId);
  const service = records(state, 'memberServices').find(row => row?.orderId === order.id) || {};
  const paidAmount = (order.parts || []).reduce((sum, part) => sum + positiveOrZero(part?.approvedAmount), 0);
  const method = order.cardAmount > 0 && order.pointAmount > 0 ? '이지페이 카드 + 주식교육영상 포인트'
    : order.cardAmount > 0 ? '이지페이 카드' : '주식교육영상 포인트';
  const canonicalMember = text(member.name) || text(member.nickname) || order.ownerMemberId;
  payments.push({
    id: `pg-${order.id}`, member: canonicalMember, name: canonicalMember, loginId: text(member.loginId), product: order.title,
    expert: text(source?.expert) || text(service.expert), amount: order.totalAmount, paidAmount, method,
    type: order.kind === 'vip' ? 'VIP결제' : order.kind === 'video' ? '영상결제' : '영상포인트충전',
    date: dateIso(now).slice(0, 10), start: text(service.start), end: text(service.end),
    confirmed: true, status: '결제완료', source: 'easypay', orderId: order.id,
  });
}

/** Completes only once, after point debit / coupon consumption and every required card approval. */
export function settleOrder(state, order, now = new Date()) {
  if (order.status === 'completed') return order;
  if (order.cardAmount > 0 && !order.parts.every(part => part.status === 'approved' && part.remainingAmount === 0)) {
    fail('ORDER_NOT_SETTLED', '모든 카드 결제가 승인된 뒤에만 서비스를 제공할 수 있습니다.', 409);
  }
  if (order.pointAmount) debitPoints(state, order, now);
  consumeCoupon(state, order, now);
  if (order.kind === 'video') appendVideoEntitlement(state, order, now);
  else if (order.kind === 'vip') appendVipService(state, order, now);
  else if (order.kind === 'points') creditTopup(state, order, now);
  appendPaymentRecord(state, order, now);
  order.status = 'completed'; order.stage = 'fulfilled'; order.manualRefundRequired = false; order.pointsReserved = false; order.fulfilledAt = dateIso(now); order.updatedAt = dateIso(now);
  return order;
}

export function orderForMember(state, session, orderId) {
  const member = resolveOwnedMember(state, session);
  const row = records(state, 'orders').find(order => order?.id === orderId);
  if (!row || row.ownerMemberId !== memberId(member)) fail('ORDER_NOT_FOUND', '주문을 찾을 수 없습니다.', 404);
  return row;
}

export function publicOrder(order) {
  return {
    id: order.id, kind: order.kind, method: order.method, target: order.target, title: order.title,
    amount: order.originalAmount, discount: order.discount, totalAmount: order.totalAmount, pointAmount: order.pointAmount,
    cardAmount: order.cardAmount, status: order.status, stage: order.stage, createdAt: order.createdAt, fulfilledAt: order.fulfilledAt,
    manualRefundRequired: order.manualRefundRequired === true,
    parts: (order.parts || []).map(part => ({ id: part.id, company: part.company, amount: part.amount, installments: part.installments, approvedAmount: positiveOrZero(part.approvedAmount), remainingAmount: positiveOrZero(part.remainingAmount), status: part.status })),
  };
}

export function registerAttempt(state, order, partId, now = new Date()) {
  if (!ACTIVE_ORDER.has(order.status)) fail('ORDER_NOT_REGISTERABLE', '현재 주문은 카드 결제를 진행할 수 없습니다.', 409);
  const part = order.parts.find(item => item.id === partId);
  if (!part || part.status === 'approved') fail('PART_NOT_REGISTERABLE', '카드 결제 항목을 찾을 수 없습니다.', 404);
  if (order.coupon) {
    const reservation = records(state, 'paymentCouponReservations').find(row => row?.orderId === order.id && row.status === 'reserved');
    if (!reservation || reservationExpired(reservation, now)) {
      fail('COUPON_RESERVATION_REQUIRED', '쿠폰 예약이 만료되었거나 해제되어 이 주문의 카드 결제를 다시 진행할 수 없습니다.', 409);
    }
  }
  const attempts = records(state, 'paymentAttempts');
  let attempt = attempts.find(item => item.orderId === order.id && item.partId === partId && ['registering', 'registered', 'registration_unknown', 'approving', 'approval_unknown'].includes(item.status));
  if (attempt?.status === 'registration_unknown' || attempt?.status === 'approving' || attempt?.status === 'approval_unknown') {
    fail('PG_RECONCILIATION_REQUIRED', 'KICC 거래상태를 확인하기 전에는 같은 카드 결제를 다시 등록할 수 없습니다.', 409);
  }
  if (attempt) return { attempt, part, reused: true };
  attempt = { id: newId('attempt'), orderId: order.id, ownerMemberId: order.ownerMemberId, partId, serverRef: newId('tx'), amount: part.amount, company: part.company, installments: part.installments, status: 'registering', createdAt: dateIso(now), updatedAt: dateIso(now) };
  attempts.push(attempt);
  part.status = 'registering'; order.status = 'pending'; order.stage = 'card_registration'; order.updatedAt = dateIso(now);
  return { attempt, part, reused: false };
}

export function applyRegistrationResult(state, { serverRef, response, now = new Date() }) {
  const attempt = records(state, 'paymentAttempts').find(row => row.serverRef === serverRef);
  if (!attempt) fail('ATTEMPT_NOT_FOUND', '결제 시도를 찾을 수 없습니다.', 404);
  const order = records(state, 'orders').find(row => row.id === attempt.orderId);
  const part = order?.parts?.find(row => row.id === attempt.partId);
  if (!order || !part) fail('ORDER_NOT_FOUND', '결제 주문을 찾을 수 없습니다.', 404);
  if (attempt.status === 'registered') return { attempt, order, part };
  if (attempt.status !== 'registering') fail('ATTEMPT_NOT_REGISTERABLE', '결제 시도 상태가 올바르지 않습니다.', 409);
  attempt.status = 'registered'; attempt.authPageUrl = text(response?.authPageUrl); attempt.updatedAt = dateIso(now);
  part.status = 'registered'; order.stage = 'awaiting_auth'; order.updatedAt = dateIso(now);
  return { attempt, order, part };
}

/** Persist a registration result that cannot safely be retried after its external request began. */
export function applyRegistrationFailure(state, { serverRef, failureCode = 'PG_RECONCILIATION_REQUIRED', knownFailure = false, now = new Date() }) {
  const attempt = records(state, 'paymentAttempts').find(row => row.serverRef === serverRef);
  if (!attempt) fail('ATTEMPT_NOT_FOUND', '결제 시도를 찾을 수 없습니다.', 404);
  const order = records(state, 'orders').find(row => row.id === attempt.orderId);
  const part = order?.parts?.find(row => row.id === attempt.partId);
  if (!order || !part) fail('ORDER_NOT_FOUND', '결제 주문을 찾을 수 없습니다.', 404);
  if (attempt.status === 'registered' || attempt.status === 'approved') return { attempt, order, part, idempotent: true };
  if (knownFailure) {
    attempt.status = 'failed'; attempt.failureCode = failureCode; attempt.updatedAt = dateIso(now);
    part.status = 'failed'; part.remainingAmount = part.amount;
    flagPartial(order, now, failureCode);
    if (!order.parts.some(item => item.status === 'approved')) releaseCouponReservations(state, order.id, now);
    return { attempt, order, part, failed: true };
  }
  // No response does not prove the trade was absent. Keep its reservation and prohibit another registration.
  attempt.status = 'registration_unknown'; attempt.failureCode = 'PG_RECONCILIATION_REQUIRED'; attempt.updatedAt = dateIso(now);
  attempt.registrationUnknownAt = dateIso(now);
  part.status = 'registration_unknown';
  order.status = 'partial'; order.stage = 'registration_unknown'; order.manualRefundRequired = true;
  order.failureCode = 'PG_RECONCILIATION_REQUIRED'; order.updatedAt = dateIso(now);
  return { attempt, order, part, failed: true, uncertain: true };
}

function flagPartial(order, now, reason) {
  const anyApproved = order.parts.some(part => part.status === 'approved');
  order.status = anyApproved ? 'partial' : 'pending';
  order.stage = anyApproved ? 'manualrefund_required' : 'payment_failed';
  order.manualRefundRequired = anyApproved;
  order.failureReason = reason;
  order.updatedAt = dateIso(now);
}

export function applyApprovalResult(state, { serverRef, approval, now = new Date() }) {
  const attempt = records(state, 'paymentAttempts').find(row => row.serverRef === serverRef);
  if (!attempt) fail('ATTEMPT_NOT_FOUND', '결제 시도를 찾을 수 없습니다.', 404);
  const order = records(state, 'orders').find(row => row.id === attempt.orderId);
  const part = order?.parts?.find(row => row.id === attempt.partId);
  if (!order || !part) fail('ORDER_NOT_FOUND', '결제 주문을 찾을 수 없습니다.', 404);
  if (attempt.status === 'approved') return { order, attempt, idempotent: true };
  if (!['registered', 'registering', 'approving'].includes(attempt.status)) fail('ATTEMPT_NOT_APPROVABLE', '결제 시도 상태가 올바르지 않습니다.', 409);
  if (!approval?.ok) {
    attempt.status = 'failed'; attempt.failureCode = text(approval?.code) || 'APPROVAL_FAILED'; attempt.updatedAt = dateIso(now);
    part.status = 'failed'; part.remainingAmount = part.amount; flagPartial(order, now, attempt.failureCode);
    return { order, attempt, failed: true };
  }
  if (approval.currency !== 'KRW' || approval.amount !== attempt.amount || approval.shopTransactionId !== attempt.serverRef || approval.shopOrderNo !== order.id) {
    attempt.status = 'failed'; attempt.failureCode = 'APPROVAL_BINDING_MISMATCH'; attempt.updatedAt = dateIso(now);
    part.status = 'failed'; flagPartial(order, now, attempt.failureCode);
    return { order, attempt, failed: true };
  }
  attempt.status = 'approved'; attempt.pgCno = text(approval.pgCno); attempt.transactionId = text(approval.transactionId || approval.pgCno);
  attempt.approvedAt = dateIso(now); attempt.updatedAt = dateIso(now);
  // Do not persist maskingNo, PAN, a payment token, or other card credentials.
  part.status = 'approved'; part.approvedAmount = attempt.amount; part.remainingAmount = 0;
  order.status = order.parts.every(item => item.status === 'approved') ? 'pending' : 'partial';
  order.stage = order.parts.every(item => item.status === 'approved') ? 'settling' : 'awaiting_other_cards'; order.updatedAt = dateIso(now);
  if (order.parts.every(item => item.status === 'approved')) {
    // Settlement runs after money is approved. Its failure must never roll the approval facts back with the CAS clone.
    const approvedOrder = clone(order);
    const preFulfillment = clone(state);
    try { settleOrder(state, order, now); }
    catch (cause) {
      restoreFulfillmentState(state, preFulfillment);
      Object.assign(order, approvedOrder);
      order.status = 'partial'; order.stage = 'reconciliation_required'; order.manualRefundRequired = true;
      order.failureCode = cause?.code || 'FULFILLMENT_FAILED'; order.updatedAt = dateIso(now);
      return { order, attempt, failed: true, fulfillmentFailed: true };
    }
  }
  return { order, attempt, failed: false };
}

/** An approval HTTP failure is indeterminate, not a failed payment. Leave the callback claim in place for reconciliation. */
export function markApprovalReconciliationRequired(state, { serverRef, failureCode = 'PG_RECONCILIATION_REQUIRED', now = new Date() }) {
  const attempt = records(state, 'paymentAttempts').find(row => row.serverRef === serverRef);
  if (!attempt) fail('ATTEMPT_NOT_FOUND', '결제 시도를 찾을 수 없습니다.', 404);
  const order = records(state, 'orders').find(row => row.id === attempt.orderId);
  const part = order?.parts?.find(row => row.id === attempt.partId);
  if (!order || !part) fail('ORDER_NOT_FOUND', '결제 주문을 찾을 수 없습니다.', 404);
  if (attempt.status === 'approved') return { attempt, order, part, idempotent: true };
  attempt.approvalUnknown = true; attempt.failureCode = failureCode; attempt.updatedAt = dateIso(now);
  order.status = 'partial'; order.stage = 'reconciliation_required'; order.manualRefundRequired = true;
  order.failureCode = failureCode; order.updatedAt = dateIso(now);
  return { attempt, order, part, uncertain: true };
}

function restoreFulfillmentState(state, preFulfillment) {
  // Only settlement side effects are reset. Orders/attempts/parts retain the separately established approval boundary.
  for (const name of ['members', 'coupons', 'couponIssuances', 'paymentCouponReservations', 'pointsTransactions', 'videoEntitlements', 'memberServices', 'payments']) {
    if (Array.isArray(preFulfillment.records?.[name])) state.records[name] = clone(preFulfillment.records[name]);
    else delete state.records[name];
  }
}

function issuanceOwned(issuance, member) {
  const owners = ['memberId', 'ownerMemberId', 'recipientMemberId', 'assignedMemberId'].map(key => id(issuance?.[key])).filter(Boolean);
  return owners.includes(member) || (Array.isArray(issuance?.memberIds) && issuance.memberIds.includes(member));
}
function issuanceUsable(issuance) {
  if (!object(issuance) || issuance.used === true || USED_COUPON.has(text(issuance.status).toLowerCase())) return false;
  const remaining = issuance.remainingUses === undefined ? null : integer(issuance.remainingUses);
  const limit = issuance.usageLimit === undefined ? null : integer(issuance.usageLimit);
  const used = positiveOrZero(issuance.usedCount);
  return (remaining === null || remaining > 0) && (limit === null || used < limit);
}
function validCouponDate(coupon, now) {
  const current = now instanceof Date ? now : new Date(now);
  const start = text(coupon.startAt || coupon.start); const end = text(coupon.endAt || coupon.end);
  const startDate = start ? new Date(`${start.length === 10 ? `${start}T00:00:00.000Z` : start}`) : null;
  const endDate = end ? new Date(`${end.length === 10 ? `${end}T23:59:59.999Z` : end}`) : null;
  if (Number.isNaN(current.valueOf()) || (coupon?.validityLimited === true && (!startDate || !endDate))) return false;
  return (!startDate || (!Number.isNaN(startDate) && current >= startDate)) && (!endDate || (!Number.isNaN(endDate) && current <= endDate));
}
function pointCoupon(coupon) {
  const legacyDeposit = text(coupon?.discountType) === '예치금적립';
  const reward = text(coupon?.benefitType || coupon?.rewardType || (legacyDeposit ? 'deposit' : '')).toLowerCase();
  return (reward === 'deposit' || reward === 'points' || reward === 'point') && positive(coupon?.benefitValue ?? coupon?.amount ?? coupon?.pointAmount ?? coupon?.points);
}
function hasVideoDiscountScope(coupon) {
  return Boolean(coupon?.videoId || coupon?.targetVideoId || coupon?.videoIds || coupon?.scopeVideoIds || ['singleVideo', 'video'].includes(text(coupon?.scope)) || text(coupon?.productScope) === 'video');
}
function couponHasCode(coupon, code) {
  const single = text(coupon?.code).toUpperCase();
  const generated = Array.isArray(coupon?.generatedCodes) ? coupon.generatedCodes.map(value => text(value).toUpperCase()).filter(Boolean) : [];
  const values = coupon?.couponCodeMode === 'multiple' && generated.length ? generated : [single];
  return values.includes(code);
}
function couponQuotaAvailable(coupon) {
  const used = positiveOrZero(coupon?.usedCount);
  const usage = coupon?.usageLimit === '' || coupon?.usageLimit === undefined ? null : integer(coupon.usageLimit);
  const quantity = coupon?.couponQuantity === '' || coupon?.couponQuantity === undefined ? null : integer(coupon.couponQuantity);
  if (usage !== null && (usage < 1 || used >= usage)) return false;
  if (coupon?.usageUnlimited === false && usage === null) return false;
  if (coupon?.issueMethod === 'couponCode' && quantity !== null && (quantity < 1 || used >= quantity)) return false;
  return true;
}
function couponTargetsMember(state, coupon, member) {
  const ownerIds = memberIds(member);
  const mode = text(coupon?.targetMode) || 'all';
  if (mode === 'all') return true;
  if (mode === 'members') return Array.isArray(coupon?.targetMemberIds) && coupon.targetMemberIds.some(value => ownerIds.has(id(value)));
  if (mode !== 'groups') return false;
  const groups = Array.isArray(coupon?.targetGroupIds) ? coupon.targetGroupIds.map(id).filter(Boolean) : [];
  if (!groups.length) return false;
  const mine = new Set([id(member?.groupId), id(member?.group)]);
  for (const service of [...(Array.isArray(member?.services) ? member.services : []), ...(Array.isArray(member?.serviceDetails) ? member.serviceDetails : [])]) {
    mine.add(id(service?.productId)); mine.add(id(service?.product));
  }
  for (const product of records(state, 'products')) if (mine.has(id(product?.title))) mine.add(id(product?.id));
  return groups.some(group => mine.has(group));
}

/** Admin-issued, explicit point-reward coupons only. Discount/video coupons are deliberately non-convertible. */
export async function redeemPointCoupon({ store, session, request, now = new Date() }) {
  let couponId = id(request?.couponId); const code = text(request?.couponCode || request?.code).toUpperCase();
  if (!code) fail('POINT_COUPON_REQUIRED', '관리자가 발급한 주식교육영상 포인트 쿠폰코드가 필요합니다.');
  return updatePaymentState(store, state => {
    const member = resolveOwnedMember(state, session); const ownerMemberId = memberId(member);
    const matches=records(state,'coupons').filter(row=>pointCoupon(row)&&couponHasCode(row,code)&&(!couponId||row.id===couponId));
    if(matches.length!==1)fail('POINT_COUPON_NOT_AVAILABLE','사용 가능한 주식교육영상 포인트 쿠폰을 확인할 수 없습니다.',403);
    const coupon=matches[0];couponId=coupon.id;
    const amount = pointCoupon(coupon);
    if (!coupon || !amount || hasVideoDiscountScope(coupon) || !ACTIVE_COUPON.has(text(coupon.status).toLowerCase()) || !validCouponDate(coupon, now) || !couponHasCode(coupon, code) || !couponQuotaAvailable(coupon) || !couponTargetsMember(state, coupon, member)) {
      fail('POINT_COUPON_NOT_AVAILABLE', '사용 가능한 포인트 쿠폰이 아닙니다.', 403);
    }
    const candidates = records(state, 'couponIssuances').filter(row => row?.couponId === couponId && issuanceOwned(row, ownerMemberId) && issuanceUsable(row));
    let issuance = candidates.find(row => {
      const issuedCode = text(row.code || row.couponCode).toUpperCase();
      const generated = Array.isArray(row.generatedCodes) && row.generatedCodes.map(value => text(value).toUpperCase()).includes(code);
      return !issuedCode || issuedCode === code || generated;
    });
    if(!issuance && coupon.issueMethod==='couponCode') {
      const redeemed=records(state,'couponIssuances').some(row=>row?.couponId===couponId&&row.used===true&&(coupon.couponCodeMode==='multiple'?text(row.code).toUpperCase()===code:issuanceOwned(row,ownerMemberId)));
      if(redeemed)fail('POINT_COUPON_NOT_AVAILABLE','사용 가능한 주식교육영상 포인트 쿠폰을 확인할 수 없습니다.',403);
      issuance={id:newId('couponissue'),couponId,memberId:ownerMemberId,code,status:'issued',used:false,usedCount:0};
      records(state,'couponIssuances').push(issuance);
    }
    if(!issuance)fail('POINT_COUPON_NOT_AVAILABLE','발급받은 포인트 쿠폰을 확인할 수 없습니다.',403);
    const memberRow = records(state, 'members').find(row => memberId(row) === ownerMemberId);
    if (!memberRow) fail('MEMBER_NOT_LINKED', '회원 정보를 찾을 수 없습니다.', 409);
    issuance.used = true; issuance.status = 'used'; issuance.usedCount = positiveOrZero(issuance.usedCount) + 1; issuance.usedAt = dateIso(now);
    coupon.usedCount = positiveOrZero(coupon.usedCount) + 1;
    memberRow.freePoints = positiveOrZero(memberRow.freePoints) + amount;
    records(state, 'pointsTransactions').push({ id: newId('pointtx'), ownerMemberId, couponId, issuanceId: issuance.id, type: 'coupon_credit', paidPoints: 0, freePoints: amount, amount, balanceAfter: memberRow.paidPoints + memberRow.freePoints, status: 'confirmed', createdAt: dateIso(now) });
    return { amount, wallet: pointsForMember(state, memberRow) };
  });
}

export function listOrdersForMember(state, session) {
  const member = resolveOwnedMember(state, session); const ownerMemberId = memberId(member);
  return records(state, 'orders').filter(order => order?.ownerMemberId === ownerMemberId).map(publicOrder);
}
