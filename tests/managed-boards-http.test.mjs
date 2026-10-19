import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import request from 'supertest';
import { createApplication, loadServerConfig } from '../server/index.mjs';
import { deploymentDecision } from '../lib/deployment.mjs';

test('관리자 저장→무료정보·공지·FAQ·이벤트 API→수정·비공개·삭제, 실제 저장소 공유', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'willclub-board-http-'));
  const token = 'board-integration-test-only-token-32-characters';
  const config = loadServerConfig({
    NODE_ENV: 'development', SITE_ORIGIN: 'http://localhost:4300', ADMIN_API_TOKEN: token,
    STATE_FILE: path.join(directory, 'state.json'), SEED_FILE: 'data/seed.json',
    LOCAL_VIDEO_DIRECTORY: path.join(directory, 'media'), VIDEO_METADATA_FILE: path.join(directory, 'videos.json'),
    UPLOAD_TEMP_DIR: path.join(directory, 'tmp'), WILLCLUB_DEPLOY_TARGET: 'all',
  });
  const service = await createApplication({ config });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const authorization = `Bearer ${token}`;
  const initial = (await request(service.app).get('/api/admin/state').set('Authorization', authorization).expect(200)).body;
  let state = initial.state, revision = initial.revision;
  const rows = [
    {id:'cms-free-gold', board:'골드마스터 게시판', title:'관리자 무료정보 검증', content:'<h2 style="color:#875764">관리자 본문</h2><p>새로 게시한 내용</p>', pinned:false},
    {id:'cms-notice', board:'공지사항', title:'관리자 공지 검증', content:'<p>공지 내용</p>', pinned:true},
    {id:'cms-faq', board:'자주묻는질문', title:'관리자 FAQ 검증', content:'<p>관리자 답변</p>', category:'결제'},
    {id:'cms-event', board:'이벤트', title:'관리자 이벤트 검증', content:'<p>이벤트 본문</p>', start:'2026-10-01', end:'2099-10-31'},
    {id:'cms-winners', board:'이벤트', title:'관리자 당첨자 공지', content:'<p>당첨자 발표 내용</p>', category:'당첨자발표'},
  ].map(row=>({date:'2026-10-19', category:'전체', visibility:'공개', titleColor:'#363238', titleSize:18, bold:true, ...row}));
  state.records.articles.push(...rows);
  let saved = await request(service.app).put('/api/admin/state').set('Authorization', authorization).send({state,revision}).expect(200);
  revision = saved.body.revision;
  const publicResponse = await request(service.app).get('/api/boards').expect(200);
  assert.match(publicResponse.headers['cache-control'], /no-store/);
  const boards = publicResponse.body.boards;
  assert.equal(boards.free.posts.find(row=>row.id==='cms-free-gold').body, rows[0].content);
  assert.equal(boards.notice.find(row=>row.id==='cms-notice').title, rows[1].title);
  assert.equal(boards.faq.find(row=>row.id==='cms-faq').faqCategory, 'payment');
  assert.equal(boards.event.find(row=>row.id==='cms-event').body, rows[3].content);
  assert.equal(boards.event.find(row=>row.id==='cms-winners').status, 'winners');
  assert.equal(boards.free.posts.find(row=>row.id==='cms-free-gold').titleStyle.fontSize,18);
  state.records.articles.find(row=>row.id==='cms-free-gold').title='수정된 관리자 무료정보';
  state.records.articles.find(row=>row.id==='cms-notice').visibility='비공개';
  state.records.articles = state.records.articles.filter(row=>row.id!=='cms-faq');
  state.records.articles.find(row=>row.id==='cms-event').visibility='회원전용';
  saved=await request(service.app).put('/api/admin/state').set('Authorization',authorization).send({state,revision}).expect(200);
  const after=(await request(service.app).get('/api/boards?role=admin&memberId=anything').expect(200)).body.boards;
  assert.equal(after.free.posts.find(row=>row.id==='cms-free-gold').title,'수정된 관리자 무료정보');
  assert.equal(after.notice.some(row=>row.id==='cms-notice'),false);
  assert.equal(after.faq.some(row=>row.id==='cms-faq'),false);
  assert.equal(after.event.find(row=>row.id==='cms-event').locked,true);
  assert.equal(after.event.find(row=>row.id==='cms-event').body,'');
  assert.equal(after.event.find(row=>row.id==='cms-event').detailImage,'');
});

test('독립 프론트는 게시판 조회만 열고 관리자 저장 경로는 계속 차단', () => {
  const env={WILLCLUB_DEPLOY_TARGET:'frontend'};
  assert.equal(deploymentDecision('/api/boards','GET',env).status,200);
  assert.equal(deploymentDecision('/api/admin/state','GET',env).status,403);
});
