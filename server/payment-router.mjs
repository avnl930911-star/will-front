import { randomUUID, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { readSession, requireCsrf } from './auth.mjs';
import { createEasyPayProvider, EasyPayProviderError } from './easypay-provider.mjs';
import {
  PaymentDomainError, applyApprovalResult, applyRegistrationFailure, applyRegistrationResult, createPaymentOrder, listOrdersForMember,
  markApprovalReconciliationRequired, orderForMember, pointsForMember, publicOrder, quotePayment, redeemPointCoupon, registerAttempt, updatePaymentState,
} from './payment-orders.mjs';

function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function equal(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}
function error(res, status, code, message) { return res.status(status).json({ error: { code, message } }); }
function domainError(res, cause) {
  if(cause?.name==='PersistentStorageRequiredError')return error(res,503,'PERSISTENT_STORAGE_REQUIRED',cause.message);
  if (cause instanceof PaymentDomainError || cause instanceof EasyPayProviderError) return error(res, cause.status, cause.code, cause.message);
  return error(res, 500, 'PAYMENT_INTERNAL_ERROR', '결제 요청을 처리하지 못했습니다.');
}
function routeOrigin(siteOrigin) {
  try { return new URL(siteOrigin).origin; } catch { throw new Error('siteOrigin은 정확한 HTTP(S) origin이어야 합니다.'); }
}
function suppliedRef(body) { return text(body?.shopTransactionId || body?.serverRef || body?.payRef); }
function suppliedAuthorization(body) { return text(body?.authorizationId || body?.authCode); }
function normalizeRequest(body, forced = {}) {
  const source = body && typeof body === 'object' ? body : {};
  const method = source.method === 'deposit' ? 'points' : source.method;
  const kind = source.kind === 'topup' ? 'points' : source.kind;
  const parts = Array.isArray(source.parts) ? source.parts : (Array.isArray(source.cardParts) ? source.cardParts.map((part, index) => ({
    company: part?.company, amount: part?.amount, installments: part?.installments ?? part?.installment ?? 0, id: `part-${index + 1}`,
  })) : source.parts);
  return { ...source, ...forced, kind: forced.kind || kind, method: forced.method || method, parts };
}
function callbackUrl(siteOrigin) { return new URL('/api/payments/easypay/return', siteOrigin).href; }
function callbackRedirect(siteOrigin, order) {
  const url = new URL(order.kind === 'vip' ? '/vip' : '/paidInfo', siteOrigin);
  url.searchParams.set('orderId', order.id);
  return url.href;
}
function findAttempt(state, serverRef) {
  const attempts = Array.isArray(state?.records?.paymentAttempts) ? state.records.paymentAttempts : [];
  return attempts.find(attempt => attempt?.serverRef === serverRef) || null;
}
function findAttemptByCallbackToken(state, token) {
  const attempts = Array.isArray(state?.records?.paymentAttempts) ? state.records.paymentAttempts : [];
  return attempts.find(attempt => equal(token, attempt?.callbackToken || '')) || null;
}
function knownRegistrationDecline(cause) {
  // General Web Payment maps an explicit non-0000 registration resCd to this reviewed provider error.
  return cause?.code === 'KICC_REGISTRATION_FAILED' || (typeof cause?.resCd === 'string' && cause.resCd !== '0000');
}
function releaseCouponReservation(state, orderId) {
  const rows = Array.isArray(state?.records?.paymentCouponReservations) ? state.records.paymentCouponReservations : [];
  for (const row of rows) if (row?.orderId === orderId && row.status === 'reserved') row.status = 'released';
}
function callbackToken() { return randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''); }
async function recordManualRefundRequired(store, session, orderId, reason) {
  return updatePaymentState(store, state => {
    const order = orderForMember(state, session, orderId);
    order.manualRefundRequired = true;
    if (!['reconciliation_required', 'registration_unknown'].includes(order.stage)) order.stage = 'manualrefund_required';
    order.cancellationRequestedAt = new Date().toISOString();
    order.cancellationReason = reason;
    order.updatedAt = order.cancellationRequestedAt;
    return order;
  });
}

/**
 * Mount this router only at `/api/payments`. The public `easypay/return` route deliberately uses
 * urlencoded parsing; all browser-originated state changes first pass verified session + CSRF checks.
 */
export function createPaymentRouter({ store, authConfig, siteOrigin, config = {}, provider } = {}) {
  if (!store || !authConfig || !siteOrigin) throw new Error('store, authConfig, siteOrigin이 필요합니다.');
  const origin = routeOrigin(siteOrigin);
  const paymentProvider = provider || createEasyPayProvider(config);
  const router = express.Router();
  router.use((_req,res,next)=>{res.set('Cache-Control','private, no-store');res.vary('Cookie');next();});

  async function authenticated(req, res, next) {
    const result = await readSession(req, authConfig);
    if (!result.session) return error(res, 401, 'AUTH_REQUIRED', '로그인이 필요합니다.');
    req.willclubAuth = { kind: 'session', ...result.session };
    return next();
  }
  function writeRoute(handler) {
    return [authenticated, (req, res) => requireCsrf(req, res, () => Promise.resolve(handler(req, res)).catch(cause => domainError(res, cause)), { siteOrigin: origin })];
  }

  router.get('/wallet', authenticated, async (req, res) => {
    try {
      const snapshot = await store.snapshot();
      const member = awaitMember(snapshot.state, req.willclubAuth);
      const wallet = pointsForMember(snapshot.state, member);
      // `balance` is active paid+free points; the legacy member.balance is intentionally absent.
      const ownerMemberId = text(member.memberId || member.id);
      const orders = Array.isArray(snapshot.state.records?.orders) ? snapshot.state.records.orders : [];
      const pointRows = Array.isArray(snapshot.state.records?.pointsTransactions) ? snapshot.state.records.pointsTransactions : [];
      const services = Array.isArray(member.services) ? member.services.filter(service => !['cancelled','expired'].includes(service?.status) && service?.status !== '환불' && service?.status !== 'refunded') : [];
      return res.json({
        balance: wallet.balance, availablePoints: wallet.availablePoints, reservedPoints: wallet.reservedPoints,
        purchases: orders.filter(order => order?.ownerMemberId === ownerMemberId && order.kind === 'video' && order.status === 'completed').map(publicOrder),
        transactions: pointRows.filter(row => row?.ownerMemberId === ownerMemberId).map(row => ({ id: row.id, type: row.type, amount: row.amount, paidPoints: row.paidPoints, freePoints: row.freePoints, balanceAfter: positiveBalance(row.balanceAfter), status: row.status, createdAt: row.createdAt, orderId: row.orderId })),
        services: services.map(service => ({ start:service.start,end:service.end,expert:service.expert,id: service.id, product: service.product, productId: service.productId, optionId: service.optionId, orderId: service.orderId, status: service.status, confirmedAt: service.confirmedAt })),
      });
    } catch (cause) { return domainError(res, cause); }
  });

  router.get('/orders', authenticated, async (req, res) => {
    try { const snapshot = await store.snapshot(); return res.json({ orders: listOrdersForMember(snapshot.state, req.willclubAuth) }); }
    catch (cause) { return domainError(res, cause); }
  });
  router.get('/orders/:id', authenticated, async (req, res) => {
    try { const snapshot = await store.snapshot(); return res.json({ order: publicOrder(orderForMember(snapshot.state, req.willclubAuth, req.params.id)) }); }
    catch (cause) { return domainError(res, cause); }
  });

  router.post('/quote', ...writeRoute(async (req, res) => {
    const snapshot = await store.snapshot();
    const quote = quotePayment({ state: snapshot.state, session: req.willclubAuth, request: normalizeRequest(req.body) });
    return res.json(quote);
  }));
  router.post('/topup/quote', ...writeRoute(async (req, res) => {
    const snapshot = await store.snapshot();
    const quote = quotePayment({ state: snapshot.state, session: req.willclubAuth, request: normalizeRequest(req.body, { kind: 'points', method: 'card' }) });
    return res.json(quote);
  }));

  async function createOrder(req, res, forced) {
    const result = await createPaymentOrder({ store, session: req.willclubAuth, request: normalizeRequest(req.body, forced), providerConfigured: paymentProvider.configured });
    return res.status(result.value.idempotent ? 200 : 201).json({ order: publicOrder(result.value.order) });
  }
  router.post('/create', ...writeRoute((req, res) => createOrder(req, res)));
  router.post('/topup/create', ...writeRoute((req, res) => createOrder(req, res, { kind: 'points', method: 'card' })));

  router.post('/points/redeem', ...writeRoute(async (req, res) => {
    const result = await redeemPointCoupon({ store, session: req.willclubAuth, request: req.body });
    return res.status(201).json({ creditedPoints: result.value.amount, balance: result.value.wallet.balance, availablePoints: result.value.wallet.availablePoints });
  }));

  router.post('/orders/:id/parts/:partId/register', ...writeRoute(async (req, res) => {
    if (!paymentProvider.configured) return error(res, 503, 'PG_NOT_CONFIGURED', 'KICC EasyPay 가맹점 설정과 서버 커넥터가 필요합니다.');
    let prepared;
    try {
      const stored = await updatePaymentState(store, state => {
        const order = orderForMember(state, req.willclubAuth, req.params.id);
        const result = registerAttempt(state, order, req.params.partId);
        if (!result.attempt.callbackToken) result.attempt.callbackToken = callbackToken();
        return { order: publicOrder(order), part: result.part, attempt: result.attempt, reused: result.reused };
      });
      prepared = stored.value;
      if (prepared.reused && prepared.attempt.status === 'registered' && prepared.attempt.authPageUrl) {
        return res.json({ url: prepared.attempt.authPageUrl, part: publicPart(prepared.part) });
      }
      if (prepared.reused && prepared.attempt.status === 'registering') {
        return error(res, 409, 'PAYMENT_REGISTRATION_IN_PROGRESS', '이미 카드 결제창 등록을 진행하고 있습니다. 잠시 후 다시 확인해 주세요.');
      }
      const registration = await paymentProvider.register({
        order: { ...prepared.order }, part: { ...prepared.part, serverRef: prepared.attempt.serverRef },
        // The browser never submits raw cards or a virtual card number. A reviewed merchant connector must provide this server-side.
        paymentMethod: { returnUrl: callbackUrl(origin), callbackToken: prepared.attempt.callbackToken },
      });
      const registrationCode = text(registration?.resCd);
      if (registrationCode && registrationCode !== '0000') {
        const decline = new EasyPayProviderError('KICC_REGISTRATION_FAILED', 'KICC 결제창 등록이 거절되었습니다.', 502);
        decline.resCd = registrationCode;
        throw decline;
      }
      const storedResult = await updatePaymentState(store, state => applyRegistrationResult(state, { serverRef: prepared.attempt.serverRef, response: registration }));
      return res.json({ url: registration.authPageUrl, part: publicPart(storedResult.value.part) });
    } catch (cause) {
      if (prepared?.attempt?.serverRef) {
        try {
          await updatePaymentState(store, state => applyRegistrationFailure(state, {
            serverRef: prepared.attempt.serverRef,
            failureCode: text(cause?.code) || 'PG_RECONCILIATION_REQUIRED',
            knownFailure: knownRegistrationDecline(cause),
          }));
        } catch {
          // Preserve the original provider/storage error. A later operator query is safer than a guessed retry.
        }
      }
      return domainError(res, cause);
    }
  }));

  // KICC General Payment posts resCd, shopOrderNo and authorizationId to returnUrl. The opaque token is embedded
  // only in the server-created returnUrl; no browser-provided serverRef is used to locate an attempt.
  router.post('/easypay/return', express.urlencoded({ extended: false, limit: '32kb' }), async (req, res) => {
    const token = text(req.query?.callbackToken || req.body?.callbackToken);
    const callbackOrderNo = text(req.body?.shopOrderNo);
    const legacyServerRef = suppliedRef(req.body);
    const authorizationId = suppliedAuthorization(req.body);
    const callbackCode = text(req.body?.resCd);
    if (!token) return error(res, 400, 'INVALID_EASYPAY_CALLBACK', '결제 인증 콜백 정보가 올바르지 않습니다.');
    try {
      const snapshot = await store.snapshot();
      const attempt = findAttemptByCallbackToken(snapshot.state, token);
      // Old internal callers may still send shopTransactionId, but the KICC General API sends shopOrderNo.
      // Both identify the server-generated KICC per-part order key, never a client-selected value.
      if (!attempt || (callbackOrderNo && callbackOrderNo !== attempt.serverRef) || (!callbackOrderNo && legacyServerRef !== attempt.serverRef)) {
        return error(res, 404, 'PAYMENT_ATTEMPT_NOT_FOUND', '결제 시도를 찾을 수 없습니다.');
      }
      const serverRef = attempt.serverRef;
      const order = (snapshot.state.records?.orders || []).find(row => row?.id === attempt.orderId && row?.ownerMemberId === attempt.ownerMemberId);
      if (!order) return error(res, 404, 'ORDER_NOT_FOUND', '결제 주문을 찾을 수 없습니다.');
      if(attempt.status==='approved')return res.redirect(303,callbackRedirect(origin,order));
      if(!['draft','pending','partial'].includes(order.status))return error(res,409,'ORDER_NOT_ACTIVE','현재 주문은 결제 승인을 진행할 수 없습니다.');
      const claimed=await updatePaymentState(store,state=>{
        const current=findAttempt(state,serverRef);
        const currentOrder=(state.records?.orders||[]).find(row=>row?.id===current?.orderId&&row?.ownerMemberId===current?.ownerMemberId);
        if(!current || !currentOrder || !['draft','pending','partial'].includes(currentOrder.status))return {claimed:false,active:false};
        if(!['registered','registering'].includes(current.status))return {claimed:false,active:true};
        current.status='approving';current.updatedAt=new Date().toISOString();return {claimed:true};
      });
      if(!claimed.value.claimed) {
        if (!claimed.value.active) return error(res, 409, 'ORDER_NOT_ACTIVE', '현재 주문은 결제 승인을 진행할 수 없습니다.');
        return res.redirect(303,callbackRedirect(origin,order));
      }
      // A non-success authentication response is a known failure, while a success-looking callback still must be approved server-to-server.
      let approval;
      if (callbackCode && callbackCode !== '0000') approval = { ok: false, code: `KICC_AUTHENTICATION_${callbackCode}` };
      else {
        try { approval = await paymentProvider.approve({ order, attempt, authorizationId }); }
        catch (cause) {
          try { await updatePaymentState(store, state => markApprovalReconciliationRequired(state, { serverRef, failureCode: text(cause?.code) || 'PG_RECONCILIATION_REQUIRED' })); }
          catch { /* The original transport failure remains the accurate response. */ }
          return domainError(res, cause);
        }
      }
      const result = await updatePaymentState(store, state => applyApprovalResult(state, { serverRef, approval }));
      if (result.value.failed && !result.value.fulfillmentFailed) return error(res, 409, 'APPROVAL_FAILED', '결제 승인이 확인되지 않았습니다.');
      // A 303 changes the PG browser POST to a safe GET and carries only the encoded order identifier.
      return res.redirect(303, callbackRedirect(origin, result.value.order));
    } catch (cause) { return domainError(res, cause); }
  });

  router.post('/orders/:id/cancel', ...writeRoute(async (req, res) => {
    try {
      const snapshot = await store.snapshot();
      const order = orderForMember(snapshot.state, req.willclubAuth, req.params.id);
      const approved = (order.parts || []).filter(part => part.status === 'approved');
      const allApproved = approved.length > 0 && approved.length === (order.parts || []).length;
      // Nothing approved: cancel draft locally and release only the reservation. No funds are claimed refunded.
      if (!approved.length && ['draft', 'pending'].includes(order.status)) {
        const result = await updatePaymentState(store, state => {
          const current = orderForMember(state, req.willclubAuth, req.params.id);
          const currentAttempts = Array.isArray(state.records?.paymentAttempts) ? state.records.paymentAttempts : [];
          if (currentAttempts.some(attempt => attempt?.orderId === current.id && ['approving', 'registration_unknown', 'approval_unknown'].includes(attempt.status))) {
            current.manualRefundRequired = true; current.stage = 'reconciliation_required';
            current.cancellationRequestedAt = new Date().toISOString(); current.cancellationReason = 'approval_or_registration_status_unknown';
            current.updatedAt = current.cancellationRequestedAt;
            return { current, blocked: true };
          }
          current.status = 'cancelled'; current.stage = 'cancelled'; current.pointsReserved = false; current.updatedAt = new Date().toISOString();
          releaseCouponReservation(state, current.id);
          return { current, blocked: false };
        });
        if (result.value.blocked) return error(res, 409, 'MANUAL_REFUND_REQUIRED', '승인 또는 등록 결과가 확인 중인 결제는 자동 취소할 수 없습니다.');
        return res.json({ order: publicOrder(result.value.current) });
      }
      // Do not auto-compensate split partials, point/mixed orders, or top-ups. A card refund without coherent service/wallet reversal is unsafe.
      if (!allApproved || order.manualRefundRequired || order.pointAmount > 0 || order.kind === 'points') {
        await recordManualRefundRequired(store, req.willclubAuth, req.params.id, 'automatic_refund_not_safe');
        return error(res, 409, 'MANUAL_REFUND_REQUIRED', '부분 승인·포인트·충전 주문은 KICC 거래상태 확인 후 관리자 환불 절차가 필요합니다.');
      }
      if (!paymentProvider.configured || typeof paymentProvider.cancel !== 'function') {
        await recordManualRefundRequired(store, req.willclubAuth, req.params.id, 'pg_cancel_connector_not_configured');
        return error(res, 503, 'PG_NOT_CONFIGURED', 'KICC 자동 취소 커넥터가 설정되지 않았습니다.');
      }
      const attempts = (snapshot.state.records?.paymentAttempts || []).filter(attempt => attempt?.orderId === order.id && attempt.status === 'approved');
      const cancellation = [];
      for (const attempt of attempts) cancellation.push(await paymentProvider.cancel({ order, attempt }));
      if (cancellation.some(result => !result?.ok)) {
        await recordManualRefundRequired(store, req.willclubAuth, req.params.id, 'pg_cancel_not_confirmed');
        return error(res, 409, 'MANUAL_REFUND_REQUIRED', 'KICC 취소 결과를 확인할 수 없어 자동 환불을 완료하지 않았습니다.');
      }
      const result = await updatePaymentState(store, state => {
        const current = orderForMember(state, req.willclubAuth, req.params.id);
        const currentAttempts = Array.isArray(state.records?.paymentAttempts) ? state.records.paymentAttempts : [];
        if (current.parts.some(part => part.status !== 'approved') || current.pointAmount > 0 || current.kind === 'points') throw new PaymentDomainError('MANUAL_REFUND_REQUIRED', '자동 환불 대상이 아닙니다.', 409);
        for (const attempt of currentAttempts.filter(item => item?.orderId === current.id && item.status === 'approved')) {
          const receipt = cancellation.find(item => item.serverRef === attempt.serverRef) || {};
          attempt.status = 'cancelled'; attempt.cancelTransactionId = text(receipt.cancelPgCno || receipt.transactionId); attempt.cancelledAt = new Date().toISOString();
        }
        current.status = 'refunded'; current.stage = 'refunded'; current.refundedAt = new Date().toISOString(); current.updatedAt = current.refundedAt;
        for (const entitlement of (state.records?.videoEntitlements || [])) if (entitlement?.orderId === current.id) { entitlement.status = 'refunded'; entitlement.revokedAt = current.refundedAt; }
        for (const service of (state.records?.memberServices || [])) if (service?.orderId === current.id) { service.status = 'refunded'; service.revokedAt = current.refundedAt; }
        const member = (state.records?.members || []).find(row => row && (row.id === current.ownerMemberId || row.memberId === current.ownerMemberId));
        if (member?.services) for (const service of member.services) if (service?.orderId === current.id) { service.status = 'refunded'; service.revokedAt = current.refundedAt; }
        return current;
      });
      return res.json({ order: publicOrder(result.value) });
    } catch (cause) { return domainError(res, cause); }
  }));

  return router;
}

function publicPart(part) {
  return { id: part.id, company: part.company, amount: part.amount, installments: part.installments, approvedAmount: Number(part.approvedAmount || 0), remainingAmount: Number(part.remainingAmount || 0), status: part.status };
}

function positiveBalance(value) {
  const balance = Number(value);
  return Number.isSafeInteger(balance) && balance >= 0 ? balance : undefined;
}

function awaitMember(state, auth) {
  // The wallet needs the same stable member linker used by the order module; invoking a quote is not appropriate.
  const rows = Array.isArray(state?.records?.members) ? state.records.members : [];
  const openId = text(auth?.user?.openId);
  const claimed = text(auth?.user?.memberId || auth?.claims?.memberId);
  const byOpenId = rows.filter(member => member?.openId === openId || member?.loginId === openId);
  const byClaim = claimed ? rows.filter(member => member?.id === claimed || member?.memberId === claimed) : [];
  const candidates = claimed ? byOpenId.filter(member => byClaim.includes(member)) : byOpenId;
  const selected = candidates.length ? candidates : (!byOpenId.length && byClaim.length ? byClaim : []);
  if (selected.length !== 1) throw new PaymentDomainError('MEMBER_NOT_LINKED', '로그인 회원 정보를 확인할 수 없습니다.', 403);
  return selected[0];
}
