'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { readApiJson } from '@/lib/http-json';
import type { OriginalPaymentOrder } from './useOriginalActions';

export interface PaymentPart { id: string; company: string; amount: number; installments: number; status: string; remainingAmount: number; }
export interface LivePaymentOrder {
  id: string; kind: string; method: string; title: string; amount: number; totalAmount: number;
  pointAmount: number; cardAmount: number; status: string; stage: string; manualRefundRequired: boolean;
  target: { videoId?: string; productId?: string; optionId?: string; productTitle?: string; topupAmount?: number; };
  parts: PaymentPart[]; createdAt: string; fulfilledAt?: string;
}
export interface PaymentOutcome { ok: boolean; pending?: boolean; message?: string; order?: LivePaymentOrder; }
export interface CustomerWallet { balance: number; availablePoints: number; purchases: unknown[]; transactions: unknown[]; services: unknown[]; }
const emptyWallet: CustomerWallet = { balance: 0, availablePoints: 0, purchases: [], transactions: [], services: [] };
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const number = (value: unknown) => Number.isSafeInteger(Number(value)) ? Number(value) : 0;

export function usePaymentActions() {
  const [wallet, setWallet] = useState<CustomerWallet>(emptyWallet);
  const [liveOrder, setLiveOrder] = useState<LivePaymentOrder | null>(null);
  const [walletError, setWalletError] = useState('');
  const mounted = useRef(false);
  const sessionCsrf = useRef('');
  const currentOrder = useRef<LivePaymentOrder | null>(null);
  const requestKeys = useRef(new Map<string, string>());
  const inFlight = useRef(false);

  const request = useCallback(async <T,>(path: string, payload?: unknown): Promise<T> => {
    if (payload !== undefined && !sessionCsrf.current) {
      const response = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
      const data = await readApiJson<{ csrfToken?: string; user?: unknown }>(response);
      if (!response.ok || !data.user) throw new Error('로그인이 필요합니다.');
      sessionCsrf.current = text(data.csrfToken);
      if (!sessionCsrf.current) throw new Error('로그인 세션을 다시 확인해주세요.');
    }
    const response = await fetch(`/api/payments${path}`, { method: payload === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: payload === undefined ? undefined : { 'Content-Type': 'application/json', 'X-CSRF-Token': sessionCsrf.current }, body: payload === undefined ? undefined : JSON.stringify(payload) });
    const data = await readApiJson<T & { error?: { message?: string } }>(response);
    if (!response.ok) throw new Error(data.error?.message || '결제 정보를 처리하지 못했습니다.');
    return data;
  }, []);
  const remember = useCallback((order: LivePaymentOrder | null) => { currentOrder.current = order; if (mounted.current) setLiveOrder(order); }, []);
  const refreshWallet = useCallback(async () => {
    try {
      const data = await request<CustomerWallet>('/wallet');
      if (mounted.current) { setWallet({ balance: number(data.balance), availablePoints: number(data.availablePoints), purchases: data.purchases || [], transactions: data.transactions || [], services: data.services || [] }); setWalletError(''); }
    } catch (error) { if (mounted.current) setWalletError(error instanceof Error ? error.message : '주식교육영상 포인트를 불러오지 못했습니다.'); }
  }, [request]);
  const refreshOrder = useCallback(async (id: string) => {
    const data = await request<{ order: LivePaymentOrder }>(`/orders/${encodeURIComponent(id)}`);
    remember(data.order); return data.order;
  }, [request, remember]);
  useEffect(() => {
    mounted.current = true;
    const onFocus = () => { void refreshWallet(); if (currentOrder.current?.id) void refreshOrder(currentOrder.current.id).catch(() => {}); };
    window.addEventListener('focus', onFocus);
    const id = new URLSearchParams(window.location.search).get('orderId');
    if (id) void refreshOrder(id).then(() => refreshWallet()).catch(error => { if (mounted.current) setWalletError(error instanceof Error ? error.message : '주문을 확인하지 못했습니다.'); });
    return () => { mounted.current = false; window.removeEventListener('focus', onFocus); };
  }, [refreshOrder, refreshWallet]);

  const completePayment = useCallback(async (order: OriginalPaymentOrder, method: string, _couponId?: unknown, rawDetails?: unknown): Promise<PaymentOutcome> => {
    if (inFlight.current) return { ok: false, message: '결제 요청을 처리 중입니다.' };
    inFlight.current = true;
    try {
      const details = object(rawDetails);
      if (details.agreedTerms !== true || details.agreedConditions !== true) throw new Error('약관과 결제 이용조건에 동의해주세요.');
      const cardParts = Array.isArray(details.cardParts) ? details.cardParts : undefined;
      const kind = order.kind === 'topup' ? 'points' : order.kind;
      const normalizedMethod = method === 'deposit' ? 'points' : method === 'card' && cardParts && cardParts.length > 1 ? 'split' : method;
      const coupon = object(details.videoCoupon);
      const payload: Record<string, unknown> = { kind, method: normalizedMethod, videoId: order.videoId, productId: order.productId, optionId: order.optionId, amount: kind === 'points' ? order.amount : undefined, points: number(details.pointAmount), parts: cardParts?.map(value => { const row = object(value); return { company: text(row.company), amount: number(row.amount), installments: row.installment === '일시불' ? 0 : number(String(row.installments ?? row.installment ?? '').replace(/개월$/, '')) }; }) };
      if (kind === 'video' && text(coupon.couponId||object(coupon.coupon).id)) { payload.couponId = text(coupon.couponId||object(coupon.coupon).id); if (text(coupon.code)) payload.couponCode = text(coupon.code); }
      const fingerprint = JSON.stringify(payload);
      let live = currentOrder.current;
      const matching = live && (order.orderId===live.id || (['draft','pending','partial'].includes(live.status) && requestKeys.current.has(fingerprint))) && live.kind === kind && live.target.videoId === order.videoId && live.target.productId === order.productId && live.target.optionId === order.optionId;
      if (!matching || !live || ['cancelled', 'refunded'].includes(live.status)) {
        let nonce = requestKeys.current.get(fingerprint);
        if (!nonce) { nonce = crypto.randomUUID(); requestKeys.current.set(fingerprint, nonce); }
        await request('/quote', payload);
        const data = await request<{ order: LivePaymentOrder }>('/create', { ...payload, nonce });
        live = data.order; remember(live);
      } else { live = await refreshOrder(live.id); }
      if (live.status === 'completed') { requestKeys.current.delete(fingerprint); await refreshWallet(); return { ok: true, order: live }; }
      if (live.manualRefundRequired && live.stage === 'reconciliation_required') throw new Error('결제 승인 상태를 확인해야 합니다. 중복 결제하지 말고 관리자에게 문의해주세요.');
      const requestedIndex = details.partIndex === undefined ? -1 : number(details.partIndex);
      const part = requestedIndex >= 0 ? live.parts[requestedIndex] : live.parts.find(item => item.status !== 'approved');
      if (!part || part.status === 'approved') return { ok: false, pending: true, order: live, message: '승인 상태를 다시 확인해주세요.' };
      if (['approving','reconciliation_required','registration_unknown'].includes(part.status)) return { ok: false, pending: true, order: live, message: '해당 카드 승인 상태를 확인 중입니다. 중복 승인 요청을 하지 마세요.' };
      const registration = await request<{ url: string }>(`/orders/${encodeURIComponent(live.id)}/parts/${encodeURIComponent(part.id)}/register`, {});
      const url = new URL(registration.url);
      if (url.protocol !== 'https:' || !/(^|\.)easypay\.co\.kr$/i.test(url.hostname)) throw new Error('이지페이 결제창 주소를 확인할 수 없습니다.');
      window.location.assign(url.href);
      return { ok: false, pending: true, order: live, message: '이지페이 결제창으로 이동합니다.' };
    } catch (error) { return { ok: false, message: error instanceof Error ? error.message : '결제를 처리하지 못했습니다.' }; }
    finally { inFlight.current = false; }
  }, [request, remember, refreshOrder, refreshWallet]);
  const registerCoupon = useCallback(async (code: string): Promise<PaymentOutcome> => {
    try { await request('/points/redeem', { code }); await refreshWallet(); return { ok: true }; }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : '주식교육영상 포인트 쿠폰을 등록하지 못했습니다.' }; }
  }, [request, refreshWallet]);
  const cancelPayment = useCallback(async (): Promise<PaymentOutcome> => {
    if (!currentOrder.current) return { ok: true };
    try { const result = await request<{order:LivePaymentOrder}>(`/orders/${encodeURIComponent(currentOrder.current.id)}/cancel`, {}); remember(result.order); await refreshWallet(); return { ok: result.order.status === 'cancelled' || result.order.status === 'refunded', order: result.order }; }
    catch(error) { await refreshOrder(currentOrder.current.id).catch(()=>{}); return {ok:false,message:error instanceof Error?error.message:'결제 취소 상태를 확인하지 못했습니다.'}; }
  }, [request, remember, refreshWallet, refreshOrder]);
  const resetPayments = useCallback(() => { sessionCsrf.current = ''; remember(null); setWallet(emptyWallet); }, [remember]);
  return { wallet, walletError, liveOrder, refreshWallet, completePayment, registerCoupon, cancelPayment, resetPayments };
}
