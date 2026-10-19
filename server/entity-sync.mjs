import { getExpertRegistry, getProductGroups } from '../lib/entity-registry.mjs';

const text = value => typeof value === 'string' ? value.trim() : '';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function clone(value) {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function recordsOf(state) {
  return object(state?.records) ? state.records : {};
}

function productId(row) {
  return text(row?.id);
}

function groupSourceId(group) {
  return text(group?.sourceProductId) || text(group?.productId);
}

function isDerivedProductGroup(group) {
  return object(group) && group.origin === 'product';
}

function sameId(left, right) {
  return text(left) && text(left) === text(right);
}

function uniqueById(rows) {
  const counts = new Map();
  for (const row of rows) {
    const id = text(row?.id);
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

function expertRenamePairs(nextState, previousState) {
  const next = getExpertRegistry(nextState);
  const previous = getExpertRegistry(previousState);
  const previousById = new Map(previous.map(expert => [expert.id, expert]));
  const previousBoardCounts = new Map();
  const previousNameCounts = new Map();
  for (const expert of previous) {
    previousBoardCounts.set(expert.freeBoard, (previousBoardCounts.get(expert.freeBoard) || 0) + 1);
    previousNameCounts.set(expert.name, (previousNameCounts.get(expert.name) || 0) + 1);
  }
  return next.map(expert => ({ expert, previous: previousById.get(expert.id) || null }))
    .filter(({ previous }) => previous && (previous.name !== undefined))
    .map(({ expert, previous }) => ({
      expert,
      previous,
      changed: expert.freeBoard !== previous.freeBoard || expert.name !== previous.name,
      previousBoardUnique: previousBoardCounts.get(previous.freeBoard) === 1,
      previousNameUnique: previousNameCounts.get(previous.name) === 1,
    }));
}

function preserveExpertAliases(records, previousState) {
  const experts = Array.isArray(records.experts) ? records.experts : [];
  const previousExperts = Array.isArray(recordsOf(previousState).experts) ? recordsOf(previousState).experts : [];
  const previousById = new Map(previousExperts.filter(object).map(expert => [text(expert.id), expert]));
  records.experts = experts.map(expert => {
    if (!object(expert)) return expert;
    const previous = previousById.get(text(expert.id));
    if (!previous) return expert;
    const aliases = new Set((Array.isArray(expert.aliases) ? expert.aliases : []).map(text).filter(Boolean));
    for (const value of [previous.name, previous.nickname, previous.loginId, ...(Array.isArray(previous.aliases) ? previous.aliases : [])]) {
      const alias = text(value);
      if (alias) aliases.add(alias);
    }
    const currentAliases = Array.isArray(expert.aliases) ? expert.aliases.map(text).filter(Boolean) : [];
    const nextAliases = [...aliases];
    const changed = nextAliases.length !== currentAliases.length || nextAliases.some(alias => !currentAliases.includes(alias));
    return changed ? { ...expert, aliases: nextAliases } : expert;
  });
}

function assignCurrentArticleOwnership(articles, experts) {
  const boardCounts = new Map();
  for (const expert of experts) boardCounts.set(expert.freeBoard, (boardCounts.get(expert.freeBoard) || 0) + 1);
  const expertByBoard = new Map(experts.map(expert => [expert.freeBoard, expert]));
  return articles.map(article => {
    if (!object(article) || text(article.expertId)) return article;
    const expert = expertByBoard.get(text(article.board));
    if (!expert || boardCounts.get(expert.freeBoard) !== 1) return article;
    return { ...article, expertId: expert.id };
  });
}

function rebrandExpertContent(records, nextState, previousState) {
  const pairs = expertRenamePairs(nextState, previousState);
  const articles = Array.isArray(records.articles) ? records.articles : [];
  const withOwnership = assignCurrentArticleOwnership(articles, getExpertRegistry(nextState));
  if (!pairs.length) {
    records.articles = withOwnership;
    return records;
  }
  const byId = new Map(pairs.map(pair => [pair.expert.id, pair]));

  records.articles = withOwnership.map(article => {
    if (!object(article)) return article;
    const direct = byId.get(text(article.expertId));
    if (direct?.changed) return { ...article, board: direct.expert.freeBoard, expertId: direct.expert.id };
    const byPreviousBoard = pairs.filter(pair => pair.changed && pair.previousBoardUnique && text(article.board) === pair.previous.freeBoard);
    if (byPreviousBoard.length === 1) {
      const pair = byPreviousBoard[0];
      return { ...article, board: pair.expert.freeBoard, expertId: pair.expert.id };
    }
    return article;
  });

  const videos = Array.isArray(records.videos) ? records.videos : [];
  records.videos = videos.map(video => {
    if (!object(video)) return video;
    const direct = byId.get(text(video.expertId));
    if (direct?.changed) return { ...video, expert: direct.expert.name, expertId: direct.expert.id };
    const byPreviousName = pairs.filter(pair => pair.changed && pair.previousNameUnique && text(video.expert) === pair.previous.name);
    if (byPreviousName.length === 1) {
      const pair = byPreviousName[0];
      return { ...video, expert: pair.expert.name, expertId: pair.expert.id };
    }
    return video;
  });
  return records;
}

function reconcileGroups(records, nextState, previousState) {
  const currentGroups = Array.isArray(records.groups) ? records.groups : [];
  const previousGroups = Array.isArray(recordsOf(previousState).groups) ? recordsOf(previousState).groups : [];
  const desiredGroups = getProductGroups(nextState);
  const existingBySource = new Map();
  for (const group of [...currentGroups, ...previousGroups]) {
    if (!isDerivedProductGroup(group)) continue;
    const sourceId = groupSourceId(group);
    if (sourceId && !existingBySource.has(sourceId)) existingBySource.set(sourceId, group);
  }

  // Manual groups survive unchanged. Derived groups are an exact projection of existing products.
  const manualGroups = currentGroups.filter(group => !isDerivedProductGroup(group));
  const derivedGroups = desiredGroups.map(desired => {
    const existing = existingBySource.get(desired.productId);
    return {
      ...(object(existing) ? existing : {}),
      ...desired,
      origin: 'product',
      sourceProductId: desired.productId,
    };
  });
  records.groups = [...manualGroups, ...derivedGroups];
}

function renameExplicitMemberGroups(records, nextState, previousState) {
  const nextProducts = Array.isArray(recordsOf(nextState).products) ? recordsOf(nextState).products : [];
  const previousProducts = Array.isArray(recordsOf(previousState).products) ? recordsOf(previousState).products : [];
  const previousById = new Map(previousProducts.filter(object).map(product => [productId(product), product]));
  const ids = uniqueById(nextProducts.filter(object));
  const renamed = new Map();

  for (const product of nextProducts) {
    if (!object(product)) continue;
    const id = productId(product);
    const previous = previousById.get(id);
    if (!id || ids.get(id) !== 1 || !object(previous)) continue;
    if (typeof product.title === 'string' && typeof previous.title === 'string' && product.title !== previous.title) {
      renamed.set(id, product.title);
    }
  }
  if (!renamed.size || !Array.isArray(records.members)) return;

  // Never infer identity from a display name. A member row must carry an explicit stable product reference.
  records.members = records.members.map(member => {
    if (!object(member)) return member;
    const id = text(member.productId) || text(member.groupProductId);
    const nextName = renamed.get(id);
    return nextName === undefined ? member : { ...member, group: nextName };
  });
}

/**
 * Reconciles only managed projections. It never deletes member rows, articles,
 * videos, payments, or other historical/financial records when a product goes away.
 */
export function reconcileManagedEntities(nextState, previousState = {}) {
  const next = clone(object(nextState) ? nextState : {});
  next.records = clone(recordsOf(next));
  preserveExpertAliases(next.records, previousState);
  reconcileGroups(next.records, next, previousState);
  renameExplicitMemberGroups(next.records, next, previousState);
  rebrandExpertContent(next.records, next, previousState);
  return next;
}
