/**
 * Canonical, browser-safe projections for experts and VIP products.
 * This module deliberately reads only the persisted state passed by its caller.
 */

const LEGACY_BY_ID = Object.freeze({
  expert0: Object.freeze({
    key: 'gold',
    catalogKey: 'goldmaster',
    aliases: Object.freeze(['gold', 'goldmaster', '골드', '골드마스터']),
  }),
  expert1: Object.freeze({
    key: 'ggot',
    catalogKey: 'ggotge',
    aliases: Object.freeze(['ggot', 'ggotge', '꽃게', '꽃게선생']),
  }),
});

const LEGACY_BY_ALIAS = Object.freeze({
  gold: 'goldmaster', goldmaster: 'goldmaster', '골드': 'goldmaster', '골드마스터': 'goldmaster',
  ggot: 'ggotge', ggotge: 'ggotge', '꽃게': 'ggotge', '꽃게선생': 'ggotge',
});

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function exactText(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function number(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function nonNegativeNumber(value, fallback = 0) {
  return Math.max(0, number(value, fallback));
}

function normalized(value) {
  return text(value).toLocaleLowerCase('ko-KR');
}

function shortHash(value) {
  // FNV-1a is deterministic and avoids a Node/browser crypto dependency.
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Converts persisted IDs to a deterministic URL/key-safe token.  It remains
 * stable across an expert/product rename because names are never an input.
 */
export function safeStableID(value, maximum = 96) {
  const source = text(value);
  const safeMaximum = Math.max(16, Math.min(120, Math.trunc(number(maximum, 96))));
  let result = '';
  for (const character of source.normalize('NFKC')) {
    if (/^[A-Za-z0-9]$/.test(character)) result += character.toLowerCase();
    else if (character === '-' || character === '_') result += character;
    else result += `u${character.codePointAt(0).toString(36)}-`;
  }
  result = result.replace(/-+/g, '-').replace(/^[-_]+|[-_]+$/g, '');
  if (!result) result = `id-${shortHash(source || 'empty')}`;
  if (!/^[a-z]/.test(result)) result = `id-${result}`;
  if (result.length > safeMaximum) {
    const suffix = shortHash(source);
    result = `${result.slice(0, Math.max(1, safeMaximum - suffix.length - 1))}-${suffix}`;
  }
  return result;
}

function safePublicAsset(value) {
  const raw = text(value);
  if (!raw || /[\u0000-\u001f\u007f]/.test(raw) || raw.startsWith('//')) return '';
  if (raw.startsWith('/')) return raw;
  try {
    const url = new URL(raw);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

function isVisible(value) {
  if (value === false) return false;
  const status = normalized(value);
  return !['false', '0', 'off', 'inactive', 'hidden', '비활성', '숨김', '중지', '탈퇴'].includes(status);
}

function legacyForId(id) {
  return LEGACY_BY_ID[normalized(id)] || null;
}

function aliasesFor(row, dto, legacy) {
  const aliases = new Set([
    row.id, row.loginId, row.name, row.nickname, row.key, row.catalogKey,
    dto.id, dto.key, dto.catalogKey, dto.name, dto.nickname,
    ...(Array.isArray(row.aliases) ? row.aliases : []),
  ].map(normalized).filter(Boolean));
  for (const alias of legacy?.aliases || []) aliases.add(normalized(alias));
  return aliases;
}

function registryEntries(state, { includeInactive = true } = {}) {
  const rows = Array.isArray(state?.records?.experts) ? state.records.experts : [];
  const seenIds = new Set();
  const entries = [];
  rows.forEach((row, index) => {
    if (!object(row)) return;
    const id = text(row.id);
    if (!id || seenIds.has(id)) return;
    seenIds.add(id);
    const legacy = legacyForId(id);
    const name = text(row.name) || text(row.nickname) || id;
    const dto = {
      id,
      key: legacy?.key || `expert-${safeStableID(id)}`,
      catalogKey: legacy?.catalogKey || `expert-${safeStableID(id)}`,
      name,
      nickname: text(row.nickname) || name,
      description: text(row.description),
      image: safePublicAsset(row.image),
      visible: isVisible(row.visible),
      order: number(row.order, index + 1),
      freeBoard: `${name} 게시판`,
    };
    if (includeInactive || dto.visible) entries.push({ dto, aliases: aliasesFor(row, dto, legacy) });
  });
  return entries;
}

/**
 * Returns only persisted expert rows. No seed/prototype expert is synthesized
 * when records.experts is missing or empty.
 */
export function getExpertRegistry(state, { includeInactive = true } = {}) {
  return registryEntries(state, { includeInactive }).map(({ dto }) => ({ ...dto }));
}

/** Resolve a persisted expert by id, key, catalog key, current name, or saved alias. */
export function resolveExpert(state, reference, { includeInactive = true } = {}) {
  const needle = normalized(reference);
  if (!needle) return null;
  const matches = registryEntries(state, { includeInactive }).filter(entry => entry.aliases.has(needle));
  return matches.length === 1 ? { ...matches[0].dto } : null;
}

/** Legacy aliases are intentionally explicit; unknown values never become 꽃게 by default. */
export function legacyCatalogKey(reference) {
  return LEGACY_BY_ALIAS[normalized(reference)] || '';
}

function productExpert(state, product) {
  const reference = text(product?.expertId) || text(product?.expert);
  const resolved = resolveExpert(state, reference);
  if (resolved) return resolved;
  const catalogKey = legacyCatalogKey(reference);
  return catalogKey ? { catalogKey, key: catalogKey === 'goldmaster' ? 'gold' : 'ggot', name: reference } : null;
}

function productId(product, index) {
  const id = text(product?.id);
  return id || `product-${index + 1}`;
}

function productGroupId(product, index) {
  return `product-${safeStableID(productId(product, index), 112)}`.slice(0, 128);
}

/** Every currently existing product has one derived group, including hidden/stopped products. */
export function getProductGroups(state) {
  const products = Array.isArray(state?.records?.products) ? state.records.products : [];
  return products.filter(object).map((product, index) => {
    const expert = productExpert(state, product);
    return {
      id: productGroupId(product, index),
      name: exactText(product.title),
      productId: productId(product, index),
      expert: expert?.catalogKey || text(product.expertId) || text(product.expert),
      origin: 'product',
      sourceProductId: productId(product, index),
    };
  });
}

function safeColor(value) {
  const color = text(value);
  return /^#[0-9a-f]{3,8}$/i.test(color) ? color : '';
}

function publicOption(option, index) {
  const row = object(option) ? option : {};
  return {
    id: text(row.id) || `option-${index + 1}`,
    title: text(row.title),
    base_period: nonNegativeNumber(row.base_period ?? row.baseMonths),
    bonus_period: nonNegativeNumber(row.bonus_period ?? row.bonusMonths),
    amount: nonNegativeNumber(row.amount),
  };
}

function isPurchasable(product) {
  if (product?.purchasable === false) return false;
  const status = normalized(product?.visible);
  return !['판매중지', '판매종료', '중지', '종료', 'false', '0', 'off', 'stopped', 'soldout'].includes(status);
}

function publicProduct(state, product, index) {
  const expert = productExpert(state, product);
  const title = exactText(product.title);
  const id = productId(product, index);
  const options = Array.isArray(product.options) ? product.options.map(publicOption) : [];
  return {
    id,
    title,
    product_name: title,
    expert: expert?.catalogKey || text(product.expertId) || text(product.expert),
    expert_id: expert?.catalogKey || text(product.expertId) || text(product.expert),
    expert_name: expert?.name || text(product.expert),
    base_period: nonNegativeNumber(product.base_period ?? product.baseMonths),
    bonus_period: nonNegativeNumber(product.bonus_period ?? product.bonusMonths),
    amount: nonNegativeNumber(product.amount),
    options,
    purchasable: isPurchasable(product),
    event: product.event === true,
    eventText: text(product.eventText),
    content: exactText(product.content),
    detailHtml: exactText(product.detailHtml || product.instructions || product.content),
    mainHtml: exactText(product.mainHtml),
    monthlyAmount: nonNegativeNumber(product.monthlyAmount),
    groupColor: safeColor(product.groupColor),
    profileImage: safePublicAsset(product.profileImage),
  };
}

/** Public state projection: active experts and non-hidden, PII-free VIP product DTOs only. */
export function getPublicRegistry(state) {
  const products = Array.isArray(state?.records?.products) ? state.records.products : [];
  return {
    experts: getExpertRegistry(state, { includeInactive: false }),
    products: products
      .filter(object)
      .filter(product => product.display !== false)
      .map((product, index) => publicProduct(state, product, index)),
  };
}
