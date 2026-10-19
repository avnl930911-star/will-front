import test from 'node:test';
import assert from 'node:assert/strict';
import { hasPaymentVideoEntitlement } from '../server/payment-entitlements.mjs';
import { pointsForMember } from '../server/payment-orders.mjs';

function fixture() {
  return {records:{members:[{id:'member-one',openId:'verified-one',balance:999999,paidPoints:1000,freePoints:500}],orders:[{id:'paid-order',ownerMemberId:'member-one',kind:'video',target:{videoId:'video-one'},status:'completed'}],videoEntitlements:[{id:'grant-one',ownerMemberId:'member-one',orderId:'paid-order',videoId:'video-one',status:'paidConfirmed'}]}};
}
test('교육영상 구매권은 검증된 같은 회원·완료 주문·해당 영상이 일치해야 한다',()=>{
  const state=fixture(),session={user:{openId:'verified-one'}};
  assert.equal(hasPaymentVideoEntitlement(state,session,'video-one'),true);
  assert.equal(hasPaymentVideoEntitlement(state,{user:{openId:'other'}},'video-one'),false);
  assert.equal(hasPaymentVideoEntitlement(state,session,'video-other'),false);
  state.records.orders[0].status='partial';assert.equal(hasPaymentVideoEntitlement(state,session,'video-one'),false);
  state.records.orders[0].status='completed';state.records.videoEntitlements[0].status='refunded';assert.equal(hasPaymentVideoEntitlement(state,session,'video-one'),false);
});
test('기존 사이트 balance는 고객 지갑 합계나 결제 가능 잔액에 포함하지 않는다',()=>{
  const state=fixture(),wallet=pointsForMember(state,state.records.members[0]);
  assert.equal(wallet.balance,1500);assert.equal(wallet.availablePoints,1500);
  state.records.members[0].balance=0;assert.equal(pointsForMember(state,state.records.members[0]).balance,1500);
});
