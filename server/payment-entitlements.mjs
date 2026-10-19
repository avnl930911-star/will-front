import { orderForMember } from './payment-orders.mjs';

/** The cookie verifier and canonical owned-member resolver remain authoritative. */
export function hasPaymentVideoEntitlement(state, session, videoId) {
  if (!session?.user) return false;
  const rows = Array.isArray(state?.records?.videoEntitlements) ? state.records.videoEntitlements : [];
  return rows.some(row => {
    if (row.videoId !== videoId || row.status !== 'paidConfirmed') return false;
    try {
      const order = orderForMember(state, session, row.orderId);
      return order.status === 'completed' && order.kind === 'video' && order.target?.videoId === videoId && order.ownerMemberId === row.ownerMemberId;
    } catch { return false; }
  });
}
