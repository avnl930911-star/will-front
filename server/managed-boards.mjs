import sanitizeHtml from 'sanitize-html';
import { getExpertRegistry } from '../lib/entity-registry.mjs';

const BOARD = Object.freeze({
  GOLD: '골드마스터 게시판',
  GGOT: '꽃게선생 게시판',
  NOTICE: '공지사항',
  FAQ: '자주묻는질문',
  EVENT: '이벤트',
});

const SUPPORTED_VISIBILITY = new Set(['공개', '전체공개', '회원전용', '무료회원공개', '유료회원공개']);
const PAID_MEMBER_STATUSES = new Set(['활성', '정상', '유료']);
const ALLOWED_IMAGE_DATA = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/]+={0,2}$/i;
const MAX_DATA_IMAGE_LENGTH = 10 * 1024 * 1024;

const RICH_TAGS = [
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup', 'dd', 'del',
  'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
  'i', 'img', 'li', 'ol', 'p', 'pre', 's', 'small', 'span', 'strong', 'sub', 'sup', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
];

const COLOR = /^(?:#[0-9a-f]{3,8}|rgba?\(\s*(?:\d{1,3}%?\s*,\s*){2}\d{1,3}%?(?:\s*,\s*(?:0|0?\.\d+|1))?\s*\)|transparent|currentcolor)$/i;
const FONT_SIZE = /^(?:\d+(?:\.\d+)?(?:px|pt|em|rem|%)|xx-small|x-small|small|medium|large|x-large|xx-large)$/i;
const FONT_WEIGHT = /^(?:normal|bold|bolder|lighter|[1-9]00)$/i;
const FONT_FAMILY = /^[\w\s,.'"\-가-힣]+$/;
const LENGTH = /^(?:0|[-+]?\d+(?:\.\d+)?(?:px|em|rem|%|pt))$/i;

const RICH_HTML_OPTIONS = {
  allowedTags: RICH_TAGS,
  allowedAttributes: {
    '*': ['style'],
    a: ['href', 'target', 'rel', 'title'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    ol: ['start', 'type'],
    li: ['value'],
    table: ['width', 'height'],
    td: ['colspan', 'rowspan', 'width', 'height'],
    th: ['colspan', 'rowspan', 'width', 'height', 'scope'],
    col: ['span', 'width'],
  },
  allowedSchemes: ['http', 'https'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  allowProtocolRelative: false,
  allowedStyles: {
    '*': {
      color: [COLOR],
      'background-color': [COLOR],
      'font-size': [FONT_SIZE],
      'font-weight': [FONT_WEIGHT],
      'font-family': [FONT_FAMILY],
      'font-style': [/^(?:normal|italic|oblique)$/i],
      'text-align': [/^(?:left|right|center|justify|start|end)$/i],
      'line-height': [/^(?:normal|\d+(?:\.\d+)?|\d+(?:\.\d+)?(?:px|em|rem|%|pt))$/i],
      'text-decoration': [/^(?:none|underline|line-through|overline)(?:\s+(?:underline|line-through|overline))?$/i],
      'letter-spacing': [LENGTH],
      'text-indent': [LENGTH],
      'vertical-align': [/^(?:baseline|sub|super|top|text-top|middle|bottom|text-bottom|[-+]?\d+(?:\.\d+)?(?:px|em|rem|%|pt))$/i],
      'white-space': [/^(?:normal|pre|pre-wrap|pre-line|nowrap)$/i],
    },
  },
  transformTags: {
    a: (_tagName, attribs) => {
      const next = { ...attribs };
      const href = safeUrl(attribs.href);
      if (href) next.href = href;
      else delete next.href;
      if (next.target === '_blank') next.rel = 'noopener noreferrer';
      else {
        delete next.target;
        delete next.rel;
      }
      return { tagName: 'a', attribs: next };
    },
    img: (_tagName, attribs) => {
      const next = { ...attribs };
      const src = safeImageUrl(attribs.src);
      if (src) next.src = src;
      else delete next.src;
      return { tagName: 'img', attribs: next };
    },
  },
};

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function decodeProtocolEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_all, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_all, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&colon;?/gi, ':');
}

/** Only HTTP(S) and non-protocol-relative relative URLs are suitable for public markup. */
function safeUrl(value) {
  const raw = text(value);
  if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) return '';
  let decoded;
  try { decoded = decodeProtocolEntities(raw).trim(); } catch { return ''; }
  if (!decoded || decoded.startsWith('//') || decoded.startsWith('\\')) return '';
  if (/^[a-z][a-z\d+.-]*\s*:/i.test(decoded)) {
    try {
      const url = new URL(decoded);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
    } catch {
      return '';
    }
  }
  return raw;
}

function safeImageUrl(value) {
  const raw = text(value);
  if (raw.length <= MAX_DATA_IMAGE_LENGTH && ALLOWED_IMAGE_DATA.test(raw)) return raw;
  return safeUrl(raw);
}

function sanitizeRichHtml(value) {
  return sanitizeHtml(typeof value === 'string' ? value : '', RICH_HTML_OPTIONS);
}

function plainLimited(value, limit = 320) {
  const plain = sanitizeHtml(typeof value === 'string' ? value : '', {
    allowedTags: [],
    allowedAttributes: {},
  }).replace(/\s+/g, ' ').trim();
  return plain.length > limit ? `${plain.slice(0, limit).trimEnd()}…` : plain;
}

function sourceDate(value) {
  const raw = text(value);
  if (!raw) return Number.NEGATIVE_INFINITY;
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? Date.parse(`${raw}T00:00:00.000Z`) : Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function sortRows(left, right) {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  const byDate = sourceDate(right.date) - sourceDate(left.date);
  if (byDate) return byDate;
  return left.id.localeCompare(right.id, 'ko');
}

function dateOnly(value, endOfDay = false) {
  const raw = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const date = new Date(`${raw}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function asNow(value) {
  const now = value instanceof Date ? value : new Date(value);
  return Number.isNaN(now.valueOf()) ? new Date() : now;
}

function paidMemberForSession(state, session, now) {
  const user = object(session?.user) ? session.user : null;
  if (!user) return null;
  const claims = object(session?.claims) ? session.claims : {};
  const ids = new Set([user.memberId, claims.memberId, user.id, claims.id]
    .filter(value => typeof value === 'string' && value));
  const openId = text(user.openId);
  const matches = (Array.isArray(state?.records?.members) ? state.records.members : [])
    .filter(object)
    .filter(member => ids.has(member.id) || (openId && text(member.openId) === openId));
  // Multiple verified member rows make entitlement ambiguous; fail closed rather than choosing one.
  if (matches.length !== 1) return null;
  const member = matches[0];
  const group = text(member.group);
  const status = text(member.status);
  const start = dateOnly(member.start ?? member.startDate);
  const end = dateOnly(member.end ?? member.endDate, true);
  if (!group || group.replace(/\s/g, '') === '무료회원' || !PAID_MEMBER_STATUSES.has(status) || !start || !end || start > end) return null;
  const current = asNow(now);
  return current >= start && current <= end ? member : null;
}

function boardExpert(board, state) {
  const entry = getExpertRegistry(state).find(expert => expert.freeBoard === board);
  return entry ? { expert: entry.key, expertName: entry.name } : null;
}

function expertMatchesBoard(user, board, state) {
  if (user?.role !== 'expert') return false;
  const expected = getExpertRegistry(state).find(expert => expert.freeBoard === board);
  if (!expected) return false;
  const supplied = text(user.expert).toLowerCase();
  if (!supplied) return false;
  return [expected.key, expected.catalogKey, expected.id, expected.name].some(value => text(value).toLowerCase() === supplied);
}

function canReadBody(row, state, session, now) {
  const visibility = text(row.visibility);
  if (visibility === '공개' || visibility === '전체공개') return true;
  const user = object(session?.user) ? session.user : null;
  const openId = text(user?.openId);
  if (visibility === '회원전용' || visibility === '무료회원공개') return Boolean(openId);
  if (visibility !== '유료회원공개') return false;
  if (user?.role === 'admin') return true;
  if (expertMatchesBoard(user, row.board, state)) return true;
  return Boolean(paidMemberForSession(state, session, now));
}

function richTitleStyle(row) {
  return {
    color: text(row.titleColor) || '#912c2f',
    fontSize: Number.isFinite(Number(row.titleSize)) && Number(row.titleSize) > 0 ? Number(row.titleSize) : 21,
    fontWeight: row.bold === true ? 700 : 400,
  };
}

function baseRow(row, state, session, now) {
  const allowedBody = canReadBody(row, state, session, now);
  const content = allowedBody ? sanitizeRichHtml(row.content) : '';
  return {
    id: text(row.id),
    title: text(row.title),
    date: text(row.date),
    category: text(row.category),
    content,
    visibility: text(row.visibility),
    pinned: row.pinned === true,
    richTitleStyle: richTitleStyle(row),
    titleStyle: richTitleStyle(row),
    image: allowedBody ? safeImageUrl(row.image) : '',
    locked: !allowedBody,
  };
}

function faqCategory(category) {
  switch (category) {
    case '회원정보': return 'member';
    case '결제': return 'payment';
    case '이용문의':
    case '콘텐츠':
    default: return 'usage';
  }
}

function formattedDate(value) {
  const raw = text(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : raw;
}

function eventDate(row) {
  const start = text(row.start ?? row.startDate);
  const end = text(row.end ?? row.endDate);
  if (start && end) return `${formattedDate(start)} ~ ${formattedDate(end)}`;
  return formattedDate(row.date);
}

function eventEnded(row, now) {
  if (text(row.category) === '종료') return true;
  const end = dateOnly(row.end ?? row.endDate, true);
  return Boolean(end && asNow(now) > end);
}

function eventRow(row, state, session, now) {
  const base = baseRow(row, state, session, now);
  const allowedBody = !base.locked;
  const link = safeUrl(row.link);
  const result = {
    id: base.id,
    title: base.title,
    detailTitle: base.title,
    detailDate: eventDate(row),
    detailImage: base.image,
    cardImage: base.image,
    date: base.date,
    tag: base.category || 'EVENT',
    status: text(row.category) === '당첨자발표' ? 'winners' : (eventEnded(row, now) ? 'ended' : 'active'),
    tone: 'cream',
    description: allowedBody ? plainLimited(text(row.description) || row.content) : '',
    body: allowedBody ? base.content : '',
    content: base.content,
    visibility: base.visibility,
    pinned: base.pinned,
    richTitleStyle: base.richTitleStyle,
    image: base.image,
    locked: base.locked,
    action: '자세히보기',
  };
  if (link) result.href = link;
  if (Object.hasOwn(row, 'winners')) {
    result.winners = allowedBody && Array.isArray(row.winners)
      ? row.winners.filter(value => typeof value === 'string').map(value => value.trim()).filter(Boolean)
      : [];
  }
  return result;
}

function publicArticle(row) {
  return object(row) && typeof row.id === 'string' && row.id.trim() && SUPPORTED_VISIBILITY.has(text(row.visibility));
}

/**
 * Public projection of only the five administrator-managed article boards.
 * It never imports seed content and is pure: callers pass the current canonical snapshot.
 */
export function buildManagedBoards(state, session, { now = new Date() } = {}) {
  const result = { free: { posts: [], notices: [] }, notice: [], faq: [], event: [] };
  const rows = Array.isArray(state?.records?.articles) ? state.records.articles : [];

  for (const row of rows) {
    if (!publicArticle(row)) continue;
    const expert = boardExpert(row.board, state);
    if (expert) {
      const base = baseRow(row, state, session, now);
      const item = {
        ...base,
        ...expert,
        body: base.content,
        href: `/freeInfo?post=${encodeURIComponent(base.id)}`,
      };
      (base.pinned ? result.free.notices : result.free.posts).push(item);
      continue;
    }
    if (row.board === BOARD.NOTICE) result.notice.push(baseRow(row, state, session, now));
    else if (row.board === BOARD.FAQ) {
      const item = baseRow(row, state, session, now);
      item.faqCategory = faqCategory(item.category);
      result.faq.push(item);
    } else if (row.board === BOARD.EVENT) result.event.push(eventRow(row, state, session, now));
  }

  result.free.posts.sort(sortRows);
  result.free.notices.sort(sortRows);
  result.notice.sort(sortRows);
  result.faq.sort(sortRows);
  result.event.sort(sortRows);
  return result;
}
