import { legacyCatalogKey, resolveExpert, safeStableID } from '../lib/entity-registry.mjs';

function asText(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function withoutHtml(value) {
  return asText(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
}

function safePublicAsset(value) {
  const raw = asText(value);
  if (!raw || /[\u0000-\u001f\u007f]/.test(raw) || raw.startsWith('//')) return undefined;
  if (raw.startsWith('/')) return raw;
  try {
    const url = new URL(raw);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Legacy aliases stay compatible; unknown names get their own key, never 꽃게 by default. */
export function normalizeExpert(value) {
  return legacyCatalogKey(value) || `expert-${safeStableID(value || 'unknown')}`;
}

function descriptorFor(state, row) {
  const frontend = row?.frontend && typeof row.frontend === 'object' ? row.frontend : {};
  const reference = asText(row?.expertId) || asText(row?.expert) || asText(frontend.expert);
  const expert = resolveExpert(state, reference);
  if (expert) return expert;
  const catalogKey = legacyCatalogKey(reference);
  if (catalogKey) {
    return {
      catalogKey,
      key: catalogKey === 'goldmaster' ? 'gold' : 'ggot',
      name: asText(row?.expert) || (catalogKey === 'goldmaster' ? '골드마스터' : '꽃게선생'),
    };
  }
  return { catalogKey: normalizeExpert(reference), key: normalizeExpert(reference), name: asText(row?.expert) || reference };
}

function normalizeSub(value) {
  const raw = asText(value).toLowerCase();
  if (['analysis', 'education', 'market', 'free'].includes(raw)) return raw;
  if (raw.includes('교육')) return 'education';
  if (raw.includes('시장') || raw.includes('마켓') || raw.includes('시황')) return 'market';
  if (raw.includes('무료')) return 'free';
  return 'analysis';
}

function isoDate(value) {
  const text = asText(value);
  if (!text) return new Date(0).toISOString();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00.000Z`) : new Date(text);
  return Number.isNaN(date.valueOf()) ? new Date(0).toISOString() : date.toISOString();
}

function safeHue(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 360 ? number : 210;
}

function isYoutube(url) {
  const host = url.hostname.toLowerCase();
  return host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com');
}

function validMediaPath(url) {
  return /^\/media\/[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.(mp4|webm)$/i.test(url.pathname);
}

/** 상대 /media URL, 개발용 동일-origin HTTP, 운영 HTTPS만 재생 주소로 허용한다. */
export function isAllowedVideoUrl(value, { siteOrigin } = {}) {
  const raw = asText(value);
  if (!raw || /[\u0000-\u001f\u007f]/.test(raw) || raw.startsWith('//')) return false;
  const base = siteOrigin || 'http://localhost';
  let url;
  try {
    url = new URL(raw, base);
  } catch {
    return false;
  }
  if (url.username || url.password || isYoutube(url) || !/\.(mp4|webm)$/i.test(url.pathname)) return false;
  if (raw.startsWith('/')) return validMediaPath(url);
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  try {
    const localOrigin = new URL(base).origin;
    return url.origin === localOrigin || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  }
}

export function mimeTypeFor(url) {
  return /\.webm(?:$|[?#])/i.test(url) ? 'video/webm' : 'video/mp4';
}

export function isPublicVideo(row) {
  return row && row.visibility === '공개';
}

export function catalogVideo(row, options, state) {
  if (!isPublicVideo(row)) return null;
  const frontend = row.frontend && typeof row.frontend === 'object' ? row.frontend : {};
  const videoUrl = asText(row.videoUrl);
  const expert = descriptorFor(state, row);
  const item = {
    id: asText(row.id),
    title: asText(row.title),
    expert: expert.catalogKey,
    expertName: expert.name,
    sub: normalizeSub(row.category || frontend.sub),
    paid: finiteNumber(row.amount) > 0,
    price: Math.max(0, finiteNumber(row.amount)),
    duration: asText(row.duration),
    views: Math.max(0, Math.trunc(finiteNumber(row.views))),
    publishedAt: isoDate(row.date),
    summary: withoutHtml(frontend.summary || row.content),
    description: withoutHtml(row.content || frontend.description),
    hue: safeHue(frontend.hue),
    hasMedia: isAllowedVideoUrl(videoUrl, options),
  };
  const thumbnail = safePublicAsset(row.image);
  if (thumbnail) item.thumbnail = thumbnail;
  return item;
}

export function buildCatalog(state, options) {
  const rows = Array.isArray(state?.records?.videos) ? state.records.videos : [];
  return rows.map(row => catalogVideo(row, options, state)).filter(Boolean);
}

export function findPlaybackVideo(state, id, options) {
  const rows = Array.isArray(state?.records?.videos) ? state.records.videos : [];
  const row = rows.find(item => item?.id === id && isPublicVideo(item));
  if (!row) return { status: 404, code: 'VIDEO_NOT_FOUND', message: '영상을 찾을 수 없습니다.' };
  if (finiteNumber(row.amount) > 0) {
    return { status: 403, code: 'PURCHASE_REQUIRED', message: '유료 영상은 기존 구매·회원 시청권 연결이 필요합니다.' };
  }
  if (!isAllowedVideoUrl(row.videoUrl, options)) {
    return { status: 404, code: 'MEDIA_NOT_CONNECTED', message: '재생 가능한 미디어가 연결되지 않았습니다.' };
  }
  return { url: asText(row.videoUrl), mimeType: mimeTypeFor(row.videoUrl) };
}

function sameExpert(state, left, right) {
  const leftText = asText(left);
  const rightText = asText(right);
  if (!leftText || !rightText) return false;
  const leftExpert = resolveExpert(state, leftText);
  const rightExpert = resolveExpert(state, rightText);
  if (leftExpert || rightExpert) return Boolean(leftExpert && rightExpert && leftExpert.id === rightExpert.id);
  const leftLegacy = legacyCatalogKey(leftText);
  const rightLegacy = legacyCatalogKey(rightText);
  return Boolean(leftLegacy && rightLegacy && leftLegacy === rightLegacy) || leftText === rightText;
}

function ownedByExpert(state, domain, row, expert) {
  if (!row || typeof row !== 'object') return false;
  const target = resolveExpert(state, expert);
  if (domain === 'videos') return sameExpert(state, row.expertId || row.expert, expert);
  if (sameExpert(state, row.expertId || row.expert, expert)) return true;
  if (target && row.board === target.freeBoard) return true;
  return row.board === `${asText(expert)} 게시판`;
}

function redactValue(value) {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/(phone|email|password|mobile|contact|telegram|receiptNumber|address|resident|identity)/i.test(key))
      .map(([key, item]) => [key, redactValue(item)]));
  }
  return value;
}

function safeExpertMembers(rows) {
  return rows.filter(row => row && typeof row === 'object').map(row => {
    const result = {};
    for (const key of ['id', 'group', 'status', 'start', 'end', 'startDate', 'endDate']) {
      if (Object.hasOwn(row, key)) result[key] = row[key];
    }
    return result;
  });
}

/** 전문가에게는 동적으로 판별된 자기 콘텐츠만, 회원 레코드에는 개인정보 없이 보낸다. */
export function restrictStateForExpert(state, expert) {
  const source = state?.records || {};
  const products = (source.products || []).filter(product => sameExpert(state, product?.expertId || product?.expert, expert));
  const names = new Set(products.map(product => product?.title).filter(value => typeof value === 'string'));
  const videos = (source.videos || []).filter(row => ownedByExpert(state, 'videos', row, expert));
  const videoIds = new Set(videos.map(video => video?.id));
  const members = (source.members || []).filter(member => names.has(member?.group)
    || (member?.services || []).some(service => names.has(service?.product) || sameExpert(state, service?.expertId || service?.expert, expert)));
  const payments = (source.payments || []).filter(payment => sameExpert(state, payment?.expertId || payment?.expert, expert)
    || videoIds.has(payment?.videoId) || names.has(payment?.product));
  const articles = (source.articles || []).filter(row => ownedByExpert(state, 'articles', row, expert));
  const records = Object.fromEntries(Object.keys(source).map(key => [key, []]));
  return {
    ...state,
    records: {
      ...records,
      products: redactValue(products),
      videos: redactValue(videos),
      members: safeExpertMembers(members),
      payments: redactValue(payments),
      articles: redactValue(articles),
    },
    logs: [],
  };
}

/** 상태의 로컬 /media URL이 요청 파일을 실제로 참조하는지 검사한다. */
export function referencesLocalMedia(row, filename, { siteOrigin, localVideoBaseUrl }) {
  const raw = asText(row?.videoUrl);
  if (!raw || !isAllowedVideoUrl(raw, { siteOrigin })) return false;
  let url;
  try {
    url = new URL(raw, siteOrigin);
  } catch {
    return false;
  }
  if (url.pathname !== `/media/${filename}`) return false;
  if (raw.startsWith('/')) return true;
  try {
    const allowedOrigins = new Set([new URL(siteOrigin).origin, new URL(localVideoBaseUrl).origin]);
    return allowedOrigins.has(url.origin);
  } catch {
    return false;
  }
}
