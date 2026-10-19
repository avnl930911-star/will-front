import { randomUUID } from 'node:crypto';
import { legacyCatalogKey, resolveExpert } from '../lib/entity-registry.mjs';

const text = value => typeof value === 'string' ? value.trim() : '';

function sameExpert(state, left, right) {
  const leftText = text(left);
  const rightText = text(right);
  if (!leftText || !rightText) return false;
  const leftExpert = resolveExpert(state, leftText);
  const rightExpert = resolveExpert(state, rightText);
  if (leftExpert || rightExpert) return Boolean(leftExpert && rightExpert && leftExpert.id === rightExpert.id);
  const leftLegacy = legacyCatalogKey(leftText);
  const rightLegacy = legacyCatalogKey(rightText);
  return Boolean(leftLegacy && rightLegacy && leftLegacy === rightLegacy) || leftText === rightText;
}

function owned(state, domain, row, expert) {
  if (!row || typeof row !== 'object') return false;
  if (domain === 'videos') return sameExpert(state, row.expertId || row.expert, expert);
  if (sameExpert(state, row.expertId || row.expert, expert)) return true;
  const target = resolveExpert(state, expert);
  return (target && row.board === target.freeBoard) || row.board === `${text(expert)} 게시판`;
}

function forbidden(status, message) {
  throw Object.assign(new Error(message), { status });
}

/** 담당 데이터만 서버 원본에 병합합니다. 전문가에게 보이지 않는 필드는 덮어쓰지 않습니다. */
export function mergeExpertRecords(source, expert, incoming) {
  if (!incoming || !Array.isArray(incoming.videos) || !Array.isArray(incoming.articles)) {
    forbidden(400, '전문가 영상과 게시글 목록이 필요합니다.');
  }
  const next = structuredClone(source);
  next.records ||= {};
  const target = resolveExpert(source, expert);
  for (const domain of ['videos', 'articles']) {
    const rows = incoming[domain];
    if (rows.length > 2000) forbidden(400, '한 번에 저장할 수 있는 항목 수를 초과했습니다.');
    const all = Array.isArray(source?.records?.[domain]) ? source.records[domain] : [];
    const ids = new Set();
    const merged = rows.map(row => {
      if (!row || typeof row.id !== 'string' || !row.id || ids.has(row.id) || !owned(source, domain, row, expert)) {
        forbidden(403, '담당 전문가의 항목만 저장할 수 있습니다.');
      }
      ids.add(row.id);
      const original = all.find(item => item?.id === row.id);
      if (original && !owned(source, domain, original, expert)) forbidden(403, '다른 전문가의 항목은 수정할 수 없습니다.');
      // 전화/이메일 같은 숨겨진 서버 필드는 원본에서 보존합니다.
      const value = { ...original, ...row };
      if (target) {
        value.expertId = target.id;
        if (domain === 'videos') value.expert = target.name;
        else if (!text(value.board)) value.board = target.freeBoard;
      }
      if (original && domain === 'videos') {
        value.views = original.views ?? 0;
        value.purchases = original.purchases ?? 0;
      }
      return value;
    });
    next.records[domain] = [...all.filter(row => !owned(source, domain, row, expert)), ...merged];
  }
  next.logs = [{ id: randomUUID(), date: new Date().toISOString(), action: '전문가 담당 콘텐츠 저장', domain: 'videos/articles', target: expert }, ...(source.logs || [])].slice(0, 500);
  return next;
}
