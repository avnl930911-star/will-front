import test from 'node:test';
import assert from 'node:assert/strict';
import { buildManagedBoards } from '../server/managed-boards.mjs';

const NOW = new Date('2026-10-19T12:00:00.000Z');
const publicSession = { user: { role: 'member', openId: 'member-open-id' } };

function state(articles, members = []) {
  return { records: { articles, members, experts: [{id:'expert0',name:'골드마스터'}, {id:'expert1',name:'꽃게선생'}], staff: [{ password: 'never-project-this' }] } };
}

function article(id, board, extra = {}) {
  return {
    id,
    board,
    title: `${id} 제목`,
    date: '2026-10-09',
    category: '콘텐츠',
    visibility: '공개',
    pinned: false,
    titleColor: '#875764',
    titleSize: 18,
    bold: true,
    content: '<p><span style="color:#875764;font-size:18px;font-weight:700">보존할 <strong>리치</strong> 본문</span></p>',
    image: '/renewal-assets/images/poster.png',
    ...extra,
  };
}

test('5개 관리자 게시판을 원본 소비자 shape로 매핑하고 리치 HTML과 허용 필드만 반환한다', () => {
  const boards = buildManagedBoards(state([
    article('gold-normal', '골드마스터 게시판', { expertName: '무시되어야 할 임의값', phone: '010-1111-2222' }),
    article('gold-pinned', '골드마스터 게시판', { pinned: true, date: '2026-10-10' }),
    article('ggot', '꽃게선생 게시판'),
    article('notice', '공지사항'),
    article('faq', '자주묻는질문', { category: '회원정보' }),
    article('event', '이벤트', { start: '2026-10-01', end: '2026-10-31', description: '이벤트 설명', link: '/event/join' }),
  ]), null, { now: NOW });

  assert.deepEqual(Object.keys(boards), ['free', 'notice', 'faq', 'event']);
  assert.equal(boards.free.posts.length, 2);
  assert.equal(boards.free.notices.length, 1);
  assert.equal(boards.free.posts.find(row => row.id === 'gold-normal').expert, 'gold');
  assert.equal(boards.free.posts.find(row => row.id === 'ggot').expertName, '꽃게선생');
  assert.equal(boards.free.notices[0].href, '/freeInfo?post=gold-pinned');
  assert.equal(boards.free.posts.some(row => row.id === 'gold-pinned'), false);
  assert.match(boards.free.posts[0].body, /<span style="color:#875764;font-size:18px;font-weight:700">/);
  assert.deepEqual(boards.free.posts[0].richTitleStyle, { color: '#875764', fontSize: 18, fontWeight: 700 });
  assert.equal(boards.notice[0].content.includes('<strong>리치</strong>'), true);
  assert.equal(boards.faq[0].faqCategory, 'member');
  assert.equal(boards.event[0].detailDate, '2026.10.01 ~ 2026.10.31');
  assert.equal(boards.event[0].status, 'active');
  assert.equal(boards.event[0].href, '/event/join');
  const serialized = JSON.stringify(boards);
  assert.equal(serialized.includes('010-1111-2222'), false);
  assert.equal(serialized.includes('never-project-this'), false);
  assert.equal(serialized.includes('무시되어야 할 임의값'), false);
});

test('회원전용/무료회원공개는 실제 openId 세션에만 본문을 공개하고 익명에는 메타데이터만 준다', () => {
  const source = state([
    article('member-free', '골드마스터 게시판', { visibility: '회원전용', content: '<p>회원만 보는 글</p>' }),
    article('member-notice', '공지사항', { visibility: '무료회원공개', content: '<p>회원만 보는 공지</p>' }),
    article('member-event', '이벤트', { visibility: '회원전용', content: '<p>회원만 보는 이벤트</p>', description: '비공개 설명', winners: ['당첨자'] }),
  ]);
  const anonymous = buildManagedBoards(source, null, { now: NOW });
  assert.equal(anonymous.free.posts[0].locked, true);
  assert.equal(anonymous.free.posts[0].body, '');
  assert.equal(anonymous.free.posts[0].content, '');
  assert.equal(anonymous.notice[0].locked, true);
  assert.equal(anonymous.notice[0].content, '');
  assert.equal(anonymous.event[0].body, '');
  assert.equal(anonymous.event[0].content, '');
  assert.equal(anonymous.event[0].description, '');
  assert.deepEqual(anonymous.event[0].winners, []);

  const loggedIn = buildManagedBoards(source, publicSession, { now: NOW });
  assert.equal(loggedIn.free.posts[0].locked, false);
  assert.match(loggedIn.notice[0].content, /회원만 보는 공지/);
  assert.match(loggedIn.event[0].body, /회원만 보는 이벤트/);
});

test('유료회원공개는 검증된 단일 활성 유료 회원 또는 관리자만 열고 모든 추측성 매칭을 거부한다', () => {
  const protectedArticle = article('paid', '골드마스터 게시판', { visibility: '유료회원공개', content: '<p>결제 회원 본문</p>' });
  const members = [
    { id: 'paid-id', loginId: 'different-login', name: '이름', nickname: '별명', phone: '010-9', email: 'x@example.test', group: '골드반', status: '정상', start: '2026-10-01', end: '2026-10-31' },
    { id: 'free-id', openId: 'free-open', group: '무료회원', status: '정상', start: '2026-10-01', end: '2026-10-31' },
    { id: 'expired-id', openId: 'expired-open', group: '유료반', status: '정상', start: '2026-09-01', end: '2026-10-01' },
  ];
  const source = state([protectedArticle], members);
  assert.equal(buildManagedBoards(source, { user: { role: 'member', openId: 'any', name: '이름', loginId: 'different-login' } }, { now: NOW }).free.posts[0].locked, true);
  assert.equal(buildManagedBoards(source, { user: { role: 'member', openId: 'any', memberId: 'paid-id' } }, { now: NOW }).free.posts[0].locked, false);
  assert.equal(buildManagedBoards(source, { user: { role: 'member', openId: 'free-open' } }, { now: NOW }).free.posts[0].locked, true);
  assert.equal(buildManagedBoards(source, { user: { role: 'member', openId: 'expired-open' } }, { now: NOW }).free.posts[0].locked, true);
  assert.equal(buildManagedBoards(source, { user: { role: 'admin', openId: 'admin-open' } }, { now: NOW }).free.posts[0].locked, false);
  assert.equal(buildManagedBoards(source, { user: { role: 'expert', openId: 'expert-open', expert: 'gold' } }, { now: NOW }).free.posts[0].locked, false);
  assert.equal(buildManagedBoards(source, { user: { role: 'expert', openId: 'expert-open', expert: 'ggot' } }, { now: NOW }).free.posts[0].locked, true);
});

test('비공개·초안·알 수 없는 공개범위는 관리자에게도 완전히 제외하고 악성 HTML과 URL을 제거한다', () => {
  const malicious = article('malicious', '공지사항', {
    content: '<p onclick="alert(1)"><span style="color:#123456;font-size:18px;background-image:url(javascript:bad)">안전</span><script>비밀스크립트</script><img src="data:image/svg+xml;base64,PHN2Zy8+" onerror="alert(1)"><a href="javascript&#58;alert(1)">위험</a></p>',
    image: 'javascript:alert(1)',
  });
  const source = state([
    malicious,
    article('private', '공지사항', { visibility: '비공개', content: '<p>절대 노출 금지</p>' }),
    article('draft', '공지사항', { visibility: '초안', content: '<p>절대 노출 금지</p>' }),
    article('missing-visibility', '공지사항', { visibility: undefined, content: '<p>절대 노출 금지</p>' }),
  ]);
  const output = buildManagedBoards(source, { user: { role: 'admin', openId: 'admin' } }, { now: NOW });
  assert.equal(output.notice.length, 1);
  assert.equal(output.notice[0].image, '');
  assert.match(output.notice[0].content, /color:#123456/);
  for (const unsafe of ['onclick', 'alert(1)', '비밀스크립트', 'javascript', 'background-image', 'data:image/svg']) {
    assert.equal(output.notice[0].content.includes(unsafe), false, unsafe);
  }
});

test('현재 state를 순수하게 즉시 투영하여 수정·삭제·정렬과 이벤트/FAQ 분류를 반영한다', () => {
  const source = state([
    article('old', '공지사항', { date: '2026-10-01' }),
    article('pinned', '공지사항', { date: '2026-10-01', pinned: true }),
    article('new', '공지사항', { date: '2026-10-18' }),
    article('winner', '이벤트', { category: '당첨자발표', winners: ['A'] }),
    article('ended', '이벤트', { category: '콘텐츠', endDate: '2026-10-10' }),
    article('payment-faq', '자주묻는질문', { category: '결제' }),
    article('usage-faq', '자주묻는질문', { category: '이용문의' }),
  ]);
  const first = buildManagedBoards(source, null, { now: NOW });
  assert.deepEqual(first.notice.map(row => row.id), ['pinned', 'new', 'old']);
  assert.equal(first.event.find(row => row.id === 'winner').status, 'winners');
  assert.equal(first.event.find(row => row.id === 'ended').status, 'ended');
  assert.equal(first.faq.find(row => row.id === 'payment-faq').faqCategory, 'payment');
  assert.equal(first.faq.find(row => row.id === 'usage-faq').faqCategory, 'usage');

  source.records.articles = source.records.articles.filter(row => row.id !== 'old');
  source.records.articles.find(row => row.id === 'new').title = '관리자가 방금 고친 제목';
  const second = buildManagedBoards(source, null, { now: NOW });
  assert.equal(second.notice.some(row => row.id === 'old'), false);
  assert.equal(second.notice.find(row => row.id === 'new').title, '관리자가 방금 고친 제목');
  assert.equal(first.notice.find(row => row.id === 'new').title, 'new 제목');
});
