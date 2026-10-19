import assert from 'node:assert/strict';
import test from 'node:test';
import { getExpertRegistry, getProductGroups, getPublicRegistry } from '../lib/entity-registry.mjs';
import { reconcileManagedEntities } from '../server/entity-sync.mjs';
import { buildCatalog, restrictStateForExpert } from '../server/catalog.mjs';
import { mergeExpertRecords } from '../server/expert-state.mjs';

function state() {
  return {
    records: {
      experts: [
        { id: 'expert0', name: '골드마스터', nickname: '골드', visible: '활동', order: 1 },
        { id: 'expert1', name: '꽃게선생', nickname: '꽃게', visible: '활동', order: 2 },
        { id: 'advisor-3', name: '세번째 전문가', nickname: '셋째', visible: '활동', order: 3 },
      ],
      products: [
        { id: 'p-1', title: '같은 이름', expert: '골드마스터', visible: '판매중', amount: 100, options: [{ id: 'o-1', title: '1개월', baseMonths: 1, bonusMonths: 0, amount: 100 }] },
        { id: 'p-2', title: '같은 이름', expert: '세번째 전문가', visible: '판매중지', display: true, amount: 200, options: [{ id: 'o-2', title: '2개월', baseMonths: 2, bonusMonths: 1, amount: 200 }] },
        { id: 'p-hidden', title: '숨긴 반', expert: '세번째 전문가', visible: '판매중', display: false, amount: 300 },
      ],
      groups: [{ id: 'manual', name: '수동 그룹', origin: 'manual' }],
      members: [{ id: 'm-explicit', group: '같은 이름', productId: 'p-1', phone: '010', email: 'private@test' }],
      payments: [{ id: 'pay-1', product: '같은 이름', amount: 100 }],
      articles: [{ id: 'a-third', board: '세번째 전문가 게시판', title: '글', visibility: '공개' }],
      videos: [{ id: 'v-third', title: '셋째 영상', expert: '세번째 전문가', visibility: '공개', amount: 0, date: '2026-01-01' }],
    },
    logs: [],
  };
}

test('registry gives legacy fixed keys and third experts stable dynamic keys', () => {
  const registry = getExpertRegistry(state());
  assert.deepEqual(registry.map(({ id, key, catalogKey }) => ({ id, key, catalogKey })), [
    { id: 'expert0', key: 'gold', catalogKey: 'goldmaster' },
    { id: 'expert1', key: 'ggot', catalogKey: 'ggotge' },
    { id: 'advisor-3', key: 'expert-advisor-3', catalogKey: 'expert-advisor-3' },
  ]);
  const renamed = state();
  renamed.records.experts[2].name = '새 이름';
  assert.equal(getExpertRegistry(renamed)[2].key, 'expert-advisor-3');
  assert.equal(getExpertRegistry({ records: {} }).length, 0);
});

test('product groups cover hidden/stopped products, retain exact duplicate titles, and have stable IDs', () => {
  const groups = getProductGroups(state());
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.filter(group => group.name === '같은 이름').map(group => group.productId), ['p-1', 'p-2']);
  assert.equal(groups.find(group => group.productId === 'p-hidden').name, '숨긴 반');
  assert.ok(groups.every(group => group.id.length <= 128));
});

test('public registry hides only display=false products and exposes stopped products as not purchasable with authoritative options', () => {
  const publicRegistry = getPublicRegistry(state());
  assert.equal(publicRegistry.experts.length, 3);
  assert.deepEqual(publicRegistry.products.map(product => product.id), ['p-1', 'p-2']);
  assert.equal(publicRegistry.products[1].purchasable, false);
  assert.deepEqual(Object.keys(publicRegistry.products[0].options[0]), ['id', 'title', 'base_period', 'bonus_period', 'amount']);
  assert.equal(JSON.stringify(publicRegistry).includes('010'), false);
});

test('reconciliation changes only derived groups and explicit product-linked memberships on rename/delete', () => {
  const previous = state();
  const next = state();
  next.records.products[0].title = '이름 변경';
  next.records.products = next.records.products.filter(product => product.id !== 'p-2');
  const result = reconcileManagedEntities(next, previous);
  assert.deepEqual(result.records.groups.filter(group => group.origin === 'product').map(group => group.productId), ['p-1', 'p-hidden']);
  assert.equal(result.records.groups.find(group => group.productId === 'p-1').name, '이름 변경');
  assert.equal(result.records.members[0].group, '이름 변경');
  assert.equal(result.records.payments.length, 1);
  assert.equal(result.records.videos.length, 1);
  assert.equal(next.records.groups.length, 1, 'input state remains unmutated');
});

test('expert rename rebrands only linked/unambiguous content and assigns matching legacy board ownership', () => {
  const initiallyLinked = reconcileManagedEntities(state(), {});
  assert.equal(initiallyLinked.records.articles.find(row => row.id === 'a-third').expertId, 'advisor-3');

  const previous = state();
  const next = state();
  next.records.experts[2].name = '세번째 새이름';
  next.records.articles.push({ id: 'other', board: '다른 게시판', title: '보존' });
  const result = reconcileManagedEntities(next, previous);
  const article = result.records.articles.find(row => row.id === 'a-third');
  assert.equal(article.board, '세번째 새이름 게시판');
  assert.equal(article.expertId, 'advisor-3');
  assert.equal(result.records.articles.find(row => row.id === 'other').board, '다른 게시판');
  assert.equal(result.records.videos[0].expert, '세번째 새이름');
  assert.equal(result.records.videos[0].expertId, 'advisor-3');
  assert.ok(result.records.experts[2].aliases.includes('세번째 전문가'));
  assert.equal(restrictStateForExpert(result, '세번째 전문가').records.videos[0].id, 'v-third');
});

test('third-expert catalog and expert-state scoping remain dynamically owned and redact private fields', () => {
  const source = state();
  source.records.videos.push({ id: 'v-gold', title: '골드 영상', expert: '골드마스터', visibility: '공개', amount: 0, date: '2026-01-01' });
  const catalog = buildCatalog(source);
  assert.equal(catalog.find(video => video.id === 'v-third').expert, 'expert-advisor-3');
  assert.equal(catalog.find(video => video.id === 'v-third').expertName, '세번째 전문가');
  const scoped = restrictStateForExpert(source, '세번째 전문가');
  assert.deepEqual(scoped.records.videos.map(video => video.id), ['v-third']);
  assert.equal(scoped.records.members[0].phone, undefined);
  assert.equal(scoped.records.members[0].email, undefined);

  const saved = mergeExpertRecords(source, '세번째 전문가', {
    videos: [{ ...scoped.records.videos[0], title: '수정된 셋째 영상' }],
    articles: [{ ...scoped.records.articles[0], title: '수정된 글' }],
  });
  assert.equal(saved.records.videos.find(video => video.id === 'v-third').title, '수정된 셋째 영상');
  assert.equal(saved.records.videos.find(video => video.id === 'v-gold').title, '골드 영상');
});
