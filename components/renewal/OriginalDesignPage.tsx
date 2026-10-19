'use client';

import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { OriginalHeader } from './OriginalHome';
import { OriginalAboutBody, OriginalGuideBody, OriginalFreeInfoBody, OriginalFreeArticleBody, OriginalPaidInfoBody, OriginalVipBody, OriginalSupportBody, OriginalEventsBody, OriginalDialogs, OriginalMyInfoBody, setOriginalVideoLibrary } from './OriginalContentPages';
import { RenewalContext } from './context';
import SharedOriginalFooter from './SharedOriginalFooter';
import assets from './assets.json';
import { readApiJson } from '@/lib/http-json';
import type { Video } from '@/components/storefront/data';
import { useOriginalActions } from './useOriginalActions';
import { emptyManagedBoards, type ManagedBoards } from './managed-boards';
import { usePublicRegistry } from './usePublicRegistry';

export default function OriginalDesignPage({ path }: { path: string }) {
  const actions = useOriginalActions();
  const { registry } = usePublicRegistry();
  const expertsHash = useMemo(() => JSON.stringify(registry.experts), [registry.experts]);
  const [location, setLocation] = useState({ search: '', hash: '' });
  const [catalogVersion, setCatalogVersion] = useState(0);
  const [boards, setBoards] = useState<ManagedBoards>(emptyManagedBoards);
  const [boardsVersion, setBoardsVersion] = useState(0);
  const catalogHash = useRef('');
  useEffect(() => {
    const update = () => setLocation({ search: window.location.search, hash: window.location.hash });
    update(); window.addEventListener('hashchange', update); window.addEventListener('popstate', update);
    return () => { window.removeEventListener('hashchange', update); window.removeEventListener('popstate', update); };
  }, [path]);
  useEffect(() => {
    if (path !== '/paidInfo') return;
    let disposed = false; let refreshing = false; let controller: AbortController | null = null;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true; controller?.abort(); controller = new AbortController();
      try {
        const response = await fetch('/api/catalog', { cache: 'no-store', signal: controller.signal });
        const result = await readApiJson<{ items?: Video[]; error?: { message?: string } }>(response);
        if (!response.ok || !Array.isArray(result.items)) throw new Error(result.error?.message || '교육영상 목록을 불러오지 못했습니다.');
        const next = JSON.stringify({ items: result.items, experts: registry.experts });
        if (!disposed && next !== catalogHash.current) {
          catalogHash.current = next;
          setOriginalVideoLibrary(result.items, registry.experts);
          setCatalogVersion(v => v + 1);
        }
      } catch (error) {
        if (!disposed) actions.openModal({ type: 'notice', title: '영상 연결 안내', message: error instanceof Error ? error.message : '교육영상 서버 연결을 확인해주세요.' });
      } finally { refreshing = false; }
    };
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    void refresh(); window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', visible);
    return () => { disposed = true; controller?.abort(); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', visible); };
  }, [path, actions.openModal, expertsHash]);

  useEffect(() => {
    if (!(path.startsWith('/freeInfo') || path.startsWith('/support/'))) return;
    let disposed = false; let previous = ''; let refreshing = false; let controller: AbortController | null = null;
    setBoards(emptyManagedBoards()); setBoardsVersion(v => v + 1);
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true; controller?.abort(); controller = new AbortController();
      try {
        const response = await fetch('/api/boards', { cache: 'no-store', signal: controller.signal });
        const result = await readApiJson<{ boards?: ManagedBoards; error?: { message?: string } }>(response);
        const data = result.boards;
        if (!response.ok || !data || !data.free || !Array.isArray(data.free.posts) || !Array.isArray(data.free.notices)
          || !Array.isArray(data.notice) || !Array.isArray(data.faq) || !Array.isArray(data.event)) throw new Error(result.error?.message || '관리자 게시글을 불러오지 못했습니다.');
        const next = JSON.stringify(data);
        if (!disposed && next !== previous) { previous = next; setBoards(data); setBoardsVersion(v => v + 1); }
      } catch (error) {
        if (!disposed && !(error instanceof Error && error.name === 'AbortError')) {
          setBoards(emptyManagedBoards()); setBoardsVersion(v => v + 1);
          actions.openModal({ type: 'notice', title: '게시판 연결 안내', message: error instanceof Error ? error.message : '게시판 서버 연결을 확인해주세요.' });
        }
      } finally { refreshing = false; }
    };
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    void refresh(); window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', visible);
    return () => { disposed = true; controller?.abort(); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', visible); };
  }, [path, actions.state.loggedIn, actions.openModal]);

  const params = new URLSearchParams(location.search);
  new URLSearchParams(location.hash.replace(/^#/, '')).forEach((value, key) => params.set(key, value));
  const post = params.get('post') || params.get('id') || (path.startsWith('/freeInfo/articles/') ? decodeURIComponent(path.slice('/freeInfo/articles/'.length)) : '');
  const event = params.has('page') && params.get('page') === 'event' ? params.get('event') || undefined : params.get('event') || (path.startsWith('/support/event/') ? decodeURIComponent(path.slice('/support/event/'.length)) : undefined);
  const requestedExpert = params.get('expert');
  const initialExpert = requestedExpert && registry.experts.some(expert => expert.key === requestedExpert) ? requestedExpert : undefined;
  const headerPath = path.startsWith('/freeInfo/') ? '/freeInfo' : path.startsWith('/support/event/') ? '/support/event' : path;
  const handleClick = (e: MouseEvent<HTMLDivElement>) => {
    const link = e.target instanceof Element ? e.target.closest('a') : null;
    if (!link || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (link.getAttribute('href') === '/login') { e.preventDefault(); actions.openModal({ type: 'login' }); }
    if (link.getAttribute('href') === '#live-chat') { e.preventDefault(); actions.openModal({ type: 'contact' }); }
    if (link.textContent?.includes('회원가입하기')) { e.preventDefault(); actions.openModal({ type: 'notice', title: '회원가입', message: '회원가입 화면은 변경하지 않습니다. 기존 윌클럽 사이트에서 이용해주세요.' }); }
  };
  return <RenewalContext.Provider value={actions}>
    <div className="renewal-main" onClick={handleClick}><div className="experience-site">
      <OriginalHeader current={headerPath} assets={assets} experts={registry.experts} />
      <div className="ex-page-content">
        {path === '/about' && <OriginalAboutBody />}
        {path === '/guide' && <OriginalGuideBody />}
        {(path === '/freeInfo' || path.startsWith('/freeInfo/articles/')) && (post ? <OriginalFreeArticleBody key={boardsVersion} posts={[...boards.free.posts, ...boards.free.notices]} id={post} onBack={() => window.location.assign('/freeInfo')} /> : <OriginalFreeInfoBody key={`${boardsVersion}:${initialExpert ?? ''}`} posts={boards.free.posts} notices={boards.free.notices} experts={registry.experts} initialExpert={initialExpert} />)}
        {path === '/paidInfo' && <OriginalPaidInfoBody key={catalogVersion} embedded experts={registry.experts} />}
        {path === '/vip' && <OriginalVipBody standalone imageAssets={assets} products={registry.products} experts={registry.experts} onContinue={actions.openVipPayment} onLogin={() => actions.openModal({ type: 'login' })} />}
        {(path === '/support/notice' || path === '/support/faq') && <OriginalSupportBody key={boardsVersion} posts={path.endsWith('/faq') ? boards.faq : boards.notice} now={undefined} category={path.endsWith('/faq') ? 'faq' : 'notice'} embedded imageAssets={assets} onLogin={() => actions.openModal({ type: 'login' })} />}
        {(path === '/support/event' || path.startsWith('/support/event/')) && <OriginalEventsBody key={boardsVersion} events={boards.event} assets={assets} selectedId={event} />}
        {path === '/myInfo' && actions.state.loggedIn && <OriginalMyInfoBody />}
        {(path === '/login' || (path === '/myInfo' && !actions.state.loggedIn)) && <div className="willclub-page ex-login-page"><h1>{path === '/myInfo' ? '내 정보' : '로그인'}</h1><p>로그인 후 회원 정보를 확인할 수 있습니다.</p><button className="ex-primary" onClick={() => actions.openModal({ type: 'login' })}>로그인</button></div>}
      </div>
      <SharedOriginalFooter />
      <OriginalDialogs assets={assets} />
    </div></div>
  </RenewalContext.Provider>;
}
