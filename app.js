/**
 * ============================================================
 * Fable v3 Premium — app.js
 * Proxy 기반 리액티브 아키텍처 · Error Boundary · 자원 해제 파이프라인
 *
 * 필수 요구사항:
 *  [R1] Proxy 기반 Reactive Store — syncSettingsUI 폐기
 *  [R2] Null-Safe DOMProxy (Null Object Pattern)
 *  [R2b] FOUC 뮤텍스 가드 (rendition.hooks + rendered)
 *  [R2c] 메모리 누수 자원 해제 파이프라인
 *  [R3] Error Boundary Manager (도메인 격리)
 *
 * UX 고도화 20선 + 초고급 상용 스펙 3선:
 *  #21 오프라인 하이라이트 충돌 해결 엔진 (UUID + LWW Merge)
 *  #22 가상 스크롤 검색 레이어 (IntersectionObserver 재활용 풀)
 *  #23 커스텀 테마 빌더 (CSS Variable 실시간 주입 + epub.js 관통)
 * ============================================================
 */

'use strict';

/* ══════════════════════════════════════════════════════════
   §0. 상수
   ══════════════════════════════════════════════════════════ */
const LH_MAP   = { narrow: '1.5', normal: '1.85', wide: '2.3' };
const STATE_KEY = 'fable_v3_state';
const SYNC_TAG  = 'fable-annotation-sync';
const DB_NAME   = 'FableV3DB';
const DB_VER    = 3;

/* ══════════════════════════════════════════════════════════
   §1. [R3] Error Boundary Manager
   ══════════════════════════════════════════════════════════ */
const ErrorBoundary = (() => {
  const handlers = {};

  function register(domain, handler) { handlers[domain] = handler; }

  function handle(domain, err, context) {
    const msg = `[Fable:${domain}]${context ? ' ' + context + ':' : ''} ${err?.message ?? err}`;
    console.error(msg, err);
    try { (handlers[domain] ?? handlers['global'])?.(err, context); } catch (_) {}
  }

  function wrap(domain, fn) {
    return async (...args) => {
      try { return await fn(...args); } catch (err) { handle(domain, err, fn.name); return null; }
    };
  }

  return { register, handle, wrap };
})();

/* ══════════════════════════════════════════════════════════
   §2. [R2] Null-Safe DOMProxy (Null Object Pattern)
   ══════════════════════════════════════════════════════════ */
const DOMProxy = (() => {
  const cache = new Map();

  const VOID_NODE = new Proxy(Object.create(null), {
    get(_, prop) {
      if (prop === 'style')     return new Proxy({}, { set() { return true; }, get() { return ''; } });
      if (prop === 'classList') return { add(){}, remove(){}, toggle(){}, contains(){ return false; } };
      if (prop === 'dataset')   return new Proxy({}, { set(){ return true; }, get(){ return ''; } });
      const NO_OPS = ['addEventListener','removeEventListener','appendChild','querySelector',
                      'querySelectorAll','focus','click','remove','setAttribute',
                      'removeAttribute','dispatchEvent','contains'];
      if (NO_OPS.includes(prop)) return () => VOID_NODE;
      if (prop === 'textContent' || prop === 'innerHTML' || prop === 'value') return '';
      if (prop === 'offsetHeight') return 0;
      if (prop === 'disabled') return false;
      return VOID_NODE;
    },
    set() { return true; },
  });

  return {
    VOID_NODE,
    get(id) {
      if (!cache.has(id)) cache.set(id, document.getElementById(id) ?? VOID_NODE);
      return cache.get(id);
    },
    exists(id) { return !!document.getElementById(id); },
    q(sel)     { return document.querySelector(sel) ?? VOID_NODE; },
    qa(sel)    { return Array.from(document.querySelectorAll(sel)); },
    invalidate(id) { id ? cache.delete(id) : cache.clear(); },
  };
})();

/* ══════════════════════════════════════════════════════════
   §3. [R1] Proxy 기반 Reactive Store
   ══════════════════════════════════════════════════════════ */
const ReactiveStore = (() => {
  const subscribers = new Map();
  let   pendingKeys = new Set();
  let   flushQueued = false;

  function _flush() {
    flushQueued = false;
    const keys = [...pendingKeys];
    pendingKeys.clear();
    keys.forEach(key => {
      (subscribers.get(key) ?? new Set()).forEach(fn => {
        try { fn(store[key]); } catch (e) { ErrorBoundary.handle('global', e, 'store:' + key); }
      });
      (subscribers.get('*') ?? new Set()).forEach(fn => {
        try { fn(key, store[key]); } catch (e) { ErrorBoundary.handle('global', e, 'store:*'); }
      });
    });
  }

  function _notify(key) {
    pendingKeys.add(key);
    if (!flushQueued) { flushQueued = true; requestAnimationFrame(_flush); }
  }

  const rawState = {
    book: null, rendition: null, toc: [], currentHref: '',
    totalLocations: 0, currentCFI: '', isTocOpen: false, isSettingsOpen: false,
    bookKey: '', indexedDB: null, navBarsVisible: true, isScrollMode: false,
    readingSession: { startTime: Date.now(), accumulated: 0, positions: new Set() },
    fontSize: 100, lineHeight: 'normal', theme: 'paper', flow: 'paginated',
    userBg: '#f4f1ea', userInk: '#1a1814', userSpacing: 0, userLeading: 1.85,
  };

  const store = new Proxy(rawState, {
    set(target, key, value) {
      if (target[key] === value) return true;
      target[key] = value;
      _notify(key);
      return true;
    },
    get(target, key) { return target[key]; },
  });

  function subscribe(key, fn) {
    if (!subscribers.has(key)) subscribers.set(key, new Set());
    subscribers.get(key).add(fn);
    return () => subscribers.get(key)?.delete(fn);
  }

  function patch(updates) { Object.entries(updates).forEach(([k, v]) => { store[k] = v; }); }

  return { store, subscribe, patch };
})();

const store = ReactiveStore.store;

/* ══════════════════════════════════════════════════════════
   §4. [UX#8] 논블로킹 스택 토스트
   ══════════════════════════════════════════════════════════ */
const Toast = (() => {
  const DURATION = 3000, FADE_OUT = 280, MAX_STACK = 4;
  let queue = [];

  function show(message, type = 'info') {
    const container = DOMProxy.get('global-toast-container');
    if (queue.length >= MAX_STACK) {
      const oldest = queue.shift();
      if (oldest?.parentNode) { oldest.classList.add('out'); setTimeout(() => oldest.remove(), FADE_OUT); }
    }
    const el = document.createElement('div');
    el.className = `toast${type !== 'info' ? ' ' + type : ''}`;
    el.textContent = message;
    container.appendChild(el);
    queue.push(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => { el.remove(); queue = queue.filter(t => t !== el); }, FADE_OUT);
    }, DURATION);
  }
  return { show };
})();

/* Error Boundary 기본 핸들러 */
ErrorBoundary.register('global',   (e) => Toast.show(`오류: ${e?.message ?? '알 수 없는 오류'}`, 'error'));
ErrorBoundary.register('storage',  (e) => Toast.show(`저장소 오류: ${e?.message}`, 'error'));
ErrorBoundary.register('renderer', (e) => Toast.show(`렌더링 오류: ${e?.message}`, 'error'));
ErrorBoundary.register('network',  (e) => console.warn('[Network]', e?.message));

/* ══════════════════════════════════════════════════════════
   §5. XSS 유틸
   ══════════════════════════════════════════════════════════ */
function setTextSafe(el, text) {
  if (el && el !== DOMProxy.VOID_NODE) el.textContent = String(text ?? '');
}

/* ══════════════════════════════════════════════════════════
   §6. StorageSystem (IndexedDB + localStorage LRU)
   ══════════════════════════════════════════════════════════ */
const StorageSystem = {
  init: ErrorBoundary.wrap('storage', async function init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('books')) {
          db.createObjectStore('books', { keyPath: 'bookKey' });
        }
        if (!db.objectStoreNames.contains('annotations')) {
          const as = db.createObjectStore('annotations', { keyPath: 'uuid' });
          as.createIndex('bookKey',     'bookKey',     { unique: false });
          as.createIndex('pendingSync', 'pendingSync', { unique: false });
        }
      };
      req.onsuccess = (e) => { store.indexedDB = e.target.result; resolve(); };
      req.onerror   = () => reject(new Error('IndexedDB 초기화 실패'));
    });
  }),

  async saveBook(bookKey, buffer, title, creator) {
    return new Promise((resolve, reject) => {
      const tx = store.indexedDB.transaction(['books'], 'readwrite');
      tx.objectStore('books').put({ bookKey, bytes: buffer, title: title || '제목 없음', creator: creator || '', ts: Date.now() });
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
  },

  async getAllBooks() {
    return new Promise(resolve => {
      if (!store.indexedDB) return resolve([]);
      const tx = store.indexedDB.transaction(['books'], 'readonly');
      const req = tx.objectStore('books').getAll();
      req.onsuccess = () => resolve(req.result || []); req.onerror = () => resolve([]);
    });
  },

  async deleteBook(bookKey) {
    return new Promise(resolve => {
      const tx = store.indexedDB.transaction(['books'], 'readwrite');
      tx.objectStore('books').delete(bookKey);
      tx.oncomplete = () => resolve(true); tx.onerror = () => resolve(false);
    });
  },

  async saveAnnotation(ann) {
    return new Promise((resolve, reject) => {
      const tx = store.indexedDB.transaction(['annotations'], 'readwrite');
      tx.objectStore('annotations').put(ann);
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
  },

  async getAnnotationsByBook(bookKey) {
    return new Promise(resolve => {
      if (!store.indexedDB) return resolve([]);
      const req = store.indexedDB.transaction(['annotations'], 'readonly')
                      .objectStore('annotations').index('bookKey').getAll(bookKey);
      req.onsuccess = () => resolve(req.result || []); req.onerror = () => resolve([]);
    });
  },

  async getPendingAnnotations() {
    return new Promise(resolve => {
      if (!store.indexedDB) return resolve([]);
      const req = store.indexedDB.transaction(['annotations'], 'readonly')
                      .objectStore('annotations').index('pendingSync').getAll(1);
      req.onsuccess = () => resolve(req.result || []); req.onerror = () => resolve([]);
    });
  },

  async markAnnotationSynced(uuid) {
    return new Promise(resolve => {
      const tx = store.indexedDB.transaction(['annotations'], 'readwrite');
      const s  = tx.objectStore('annotations');
      const req = s.get(uuid);
      req.onsuccess = () => {
        if (req.result) { req.result.pendingSync = 0; s.put(req.result); }
        resolve();
      };
      req.onerror = () => resolve();
    });
  },

  lsSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify({ data: value, ts: Date.now() }));
    } catch (e) {
      if (e.name === 'QuotaExceededError') {
        this._evictLRU();
        Toast.show('오래된 서재 데이터가 안전하게 자동 최적화되었습니다.', 'info');
        try { localStorage.setItem(key, JSON.stringify({ data: value, ts: Date.now() })); } catch (_) {}
      }
    }
  },

  lsGet(key, def = null) {
    try { const raw = localStorage.getItem(key); if (!raw) return def; return JSON.parse(raw).data ?? def; }
    catch (_) { return def; }
  },

  _evictLRU() {
    const entries = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith('fable_')) continue;
      try { entries.push({ k, ts: JSON.parse(localStorage.getItem(k)).ts }); } catch (_) {}
    }
    entries.sort((a, b) => a.ts - b.ts)
           .slice(0, Math.ceil(entries.length * 0.3))
           .forEach(e => localStorage.removeItem(e.k));
  },
};

/* ══════════════════════════════════════════════════════════
   §7. [UX#21] 충돌 해결 싱크 엔진 (UUID + LWW Merge)
   ══════════════════════════════════════════════════════════ */
const AnnotationSyncEngine = (() => {
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  async function create(bookKey, cfiRange, text, color = 'yellow', note = '') {
    const ann = {
      uuid: uuid(), bookKey, cfiRange, text: text.slice(0, 500), note, color,
      device_timestamp: Date.now(), pendingSync: 1, synced_at: null,
    };
    await ErrorBoundary.wrap('storage', () => StorageSystem.saveAnnotation(ann))();
    return ann;
  }

  async function updateNote(uuid_, note) {
    const all = await StorageSystem.getAnnotationsByBook(store.bookKey);
    const ann = all.find(a => a.uuid === uuid_);
    if (!ann) return;
    ann.note = note; ann.device_timestamp = Date.now(); ann.pendingSync = 1;
    await ErrorBoundary.wrap('storage', () => StorageSystem.saveAnnotation(ann))();
  }

  /* Last-Write-Wins Merge: 동일 CFI에 두 항목이 충돌하면 device_timestamp 큰 쪽 우선 */
  function mergeWithLWW(remoteItems, localItems) {
    const merged = new Map();
    remoteItems.forEach(r => merged.set(r.cfiRange, r));
    localItems.forEach(l => {
      const ex = merged.get(l.cfiRange);
      if (!ex || l.device_timestamp > ex.device_timestamp) merged.set(l.cfiRange, l);
    });
    return [...merged.values()];
  }

  async function syncPending() {
    const pending = await StorageSystem.getPendingAnnotations();
    if (!pending.length) return;

    if ('serviceWorker' in navigator && 'SyncManager' in window) {
      try {
        const reg = await navigator.serviceWorker.ready;
        await reg.sync.register(SYNC_TAG); return;
      } catch (_) {}
    }

    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'ANNOTATION_SYNC_REQUEST', payload: { items: pending } });
      return;
    }

    /* 직접 fetch 스텁 */
    try {
      const res = await fetch('https://api.fable.example/annotations/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ annotations: pending }),
      });
      if (res.ok) {
        await Promise.all(pending.map(a => StorageSystem.markAnnotationSynced(a.uuid)));
        Toast.show(`${pending.length}개 하이라이트가 동기화되었습니다.`, 'success');
      }
    } catch (err) { ErrorBoundary.handle('network', err, 'syncPending'); }
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', async (e) => {
      if (e.data?.type === 'ANNOTATION_SYNC_RESULT' && e.data.result?.success) {
        const pending = await StorageSystem.getPendingAnnotations();
        await Promise.all(pending.map(a => StorageSystem.markAnnotationSynced(a.uuid)));
        Toast.show(`${e.data.result.synced}개 하이라이트가 동기화되었습니다.`, 'success');
      }
      if (e.data?.type === 'SW_SYNC_TRIGGER') await syncPending();
    });
  }

  return { create, updateNote, mergeWithLWW, syncPending };
})();

/* ══════════════════════════════════════════════════════════
   §8. [R2c] 자원 해제 파이프라인
   ══════════════════════════════════════════════════════════ */
const ResourceRegistry = (() => {
  const listeners = [], storeSubs = [], timers = [], resizeObs = [];

  function addListener(target, type, fn, opts) {
    if (!target || target === DOMProxy.VOID_NODE) return;
    target.addEventListener(type, fn, opts);
    listeners.push({ target, type, fn, opts });
  }
  function addStoreSub(unsub) { storeSubs.push(unsub); }
  function addTimer(id)       { timers.push(id); return id; }
  function addResizeObserver(obs) { resizeObs.push(obs); }

  function releaseAll() {
    listeners.forEach(({ target, type, fn, opts }) => { try { target.removeEventListener(type, fn, opts); } catch (_) {} });
    listeners.length = 0;
    storeSubs.forEach(unsub => { try { unsub(); } catch (_) {} });
    storeSubs.length = 0;
    timers.forEach(id => { clearTimeout(id); clearInterval(id); });
    timers.length = 0;
    resizeObs.forEach(obs => { try { obs.disconnect(); } catch (_) {} });
    resizeObs.length = 0;
  }
  return { addListener, addStoreSub, addTimer, addResizeObserver, releaseAll };
})();

/* ══════════════════════════════════════════════════════════
   §9. [UX#4] 화면 크로스페이드 전환
   ══════════════════════════════════════════════════════════ */
function showViewerScreen() {
  const up = DOMProxy.get('screen-uploader'), vi = DOMProxy.get('screen-viewer');
  up.style.transition = 'opacity 300ms ease, transform 300ms ease';
  up.style.opacity    = '0'; up.style.transform = 'scale(0.97)';
  setTimeout(() => {
    up.style.display = 'none'; up.style.opacity = ''; up.style.transform = '';
    vi.style.display = 'flex'; vi.style.opacity = '0'; vi.style.transform = 'scale(1.02)';
    vi.style.transition = 'opacity 300ms ease, transform 300ms ease';
    requestAnimationFrame(() => requestAnimationFrame(() => { vi.style.opacity = '1'; vi.style.transform = 'scale(1)'; }));
  }, 300);
}

function showUploaderScreen() {
  const up = DOMProxy.get('screen-uploader'), vi = DOMProxy.get('screen-viewer');
  vi.style.transition = 'opacity 260ms ease'; vi.style.opacity = '0';
  setTimeout(() => {
    vi.style.display = 'none'; vi.style.opacity = ''; vi.style.transition = '';
    up.style.display = 'flex'; up.style.opacity = '0';
    up.style.transition = 'opacity 260ms ease';
    requestAnimationFrame(() => requestAnimationFrame(() => { up.style.opacity = '1'; }));
    setTimeout(() => { up.style.transition = ''; }, 300);
  }, 260);
}

/* ══════════════════════════════════════════════════════════
   §10. 로딩 오버레이
   ══════════════════════════════════════════════════════════ */
const LoadingOverlay = (() => {
  let el = null;
  function show(msg = '도서를 불러오는 중...') {
    if (el) return;
    el = document.createElement('div'); el.className = 'loading-overlay';
    const p = document.createElement('p'); p.textContent = msg;
    el.innerHTML = '<div class="spinner"></div>'; el.appendChild(p);
    const vi = DOMProxy.get('screen-viewer');
    if (DOMProxy.exists('screen-viewer')) vi.appendChild(el);
  }
  function hide() {
    if (!el) return;
    el.classList.add('fade-out'); setTimeout(() => { el?.remove(); el = null; }, 260);
  }
  return { show, hide };
})();

/* ══════════════════════════════════════════════════════════
   §11. [UX#20] 리사이즈 마스크
   ══════════════════════════════════════════════════════════ */
const ResizeMask = {
  show() { DOMProxy.get('resize-mask').style.display = 'flex'; },
  hide() { DOMProxy.get('resize-mask').style.display = 'none'; },
};

/* ══════════════════════════════════════════════════════════
   §12. [R1] Reactive UI Binders 마운트
   ══════════════════════════════════════════════════════════ */
function mountReactiveBinders() {

  ReactiveStore.subscribe('theme', (theme) => {
    if (theme === 'paper' || theme === 'custom') document.body.removeAttribute('data-theme');
    else document.body.setAttribute('data-theme', theme);

    if (store.rendition) {
      requestAnimationFrame(() => {
        try { store.rendition.themes.select(theme === 'custom' ? 'custom' : theme); }
        catch (e) { ErrorBoundary.handle('renderer', e, 'theme:select'); }
      });
    }
    DOMProxy.qa('.theme-swatch').forEach(b => {
      const ok = b.dataset.theme === theme;
      b.classList.toggle('active', ok); b.setAttribute('aria-checked', String(ok));
    });
    DOMProxy.get('custom-theme-builder').style.display = theme === 'custom' ? 'block' : 'none';
  });

  ReactiveStore.subscribe('fontSize', (size) => {
    setTextSafe(DOMProxy.get('font-size-display'), `${size}%`);
    if (store.rendition) requestAnimationFrame(() => {
      try { store.rendition.themes.fontSize(`${size}%`); }
      catch (e) { ErrorBoundary.handle('renderer', e, 'fontSize'); }
    });
  });

  ReactiveStore.subscribe('lineHeight', (lh) => {
    DOMProxy.qa('[data-lh]').forEach(b => {
      const ok = b.dataset.lh === lh;
      b.classList.toggle('active', ok); b.setAttribute('aria-checked', String(ok));
    });
    if (store.rendition) {
      const val = LH_MAP[lh] || '1.85';
      requestAnimationFrame(() => {
        try { store.rendition.themes.override('line-height', val); }
        catch (e) { ErrorBoundary.handle('renderer', e, 'lineHeight'); }
      });
    }
  });

  ReactiveStore.subscribe('flow', (flow) => {
    DOMProxy.qa('[data-flow]').forEach(b => {
      const ok = b.dataset.flow === flow;
      b.classList.toggle('active', ok); b.setAttribute('aria-checked', String(ok));
    });
    DOMProxy.get('btn-scroll-top').style.display = flow === 'scrolled' ? 'flex' : 'none';
  });

  ReactiveStore.subscribe('navBarsVisible', (visible) => {
    DOMProxy.get('viewer-nav-bar').classList.toggle('nav-hidden', !visible);
    DOMProxy.get('viewer-bottom-bar').classList.toggle('bottom-hidden', !visible);
  });

  ReactiveStore.subscribe('isTocOpen', (open) => {
    const sidebar = DOMProxy.get('toc-sidebar');
    const overlay = DOMProxy.get('toc-overlay');
    const btn     = DOMProxy.get('btn-toc-toggle');
    if (open) {
      sidebar.style.display = 'flex'; sidebar.offsetHeight;
      sidebar.classList.add('open');
      overlay.classList.add('visible', 'blur-backdrop');
      btn.setAttribute('aria-expanded', 'true');
    } else {
      sidebar.classList.remove('open');
      overlay.classList.remove('visible', 'blur-backdrop');
      btn.setAttribute('aria-expanded', 'false');
      setTimeout(() => { if (!store.isTocOpen) sidebar.style.display = 'none'; }, 240);
    }
  });

  ReactiveStore.subscribe('isSettingsOpen', (open) => {
    const panel = DOMProxy.get('settings-panel');
    const btn   = DOMProxy.get('btn-settings-toggle');
    if (open) {
      panel.style.display = 'flex'; panel.offsetHeight;
      panel.classList.add('open'); btn.classList.add('active');
      btn.setAttribute('aria-expanded', 'true');
    } else {
      panel.classList.remove('open'); btn.classList.remove('active');
      btn.setAttribute('aria-expanded', 'false');
      setTimeout(() => { if (!store.isSettingsOpen) panel.style.display = 'none'; }, 240);
    }
  });

  /* [UX#23] 커스텀 테마 CSS 변수 실시간 주입 */
  ReactiveStore.subscribe('userBg',      (v) => { document.documentElement.style.setProperty('--color-user-bg', v);         _injectCustomToIframe(); });
  ReactiveStore.subscribe('userInk',     (v) => { document.documentElement.style.setProperty('--color-user-ink', v);        _injectCustomToIframe(); });
  ReactiveStore.subscribe('userSpacing', (v) => { document.documentElement.style.setProperty('--user-letter-spacing', v + 'em'); _injectCustomToIframe(); });
  ReactiveStore.subscribe('userLeading', (v) => { document.documentElement.style.setProperty('--user-line-height', String(v)); _injectCustomToIframe(); });
}

function _injectCustomToIframe() {
  if (!store.rendition || store.theme !== 'custom') return;
  try {
    store.rendition.themes.override('background-color', store.userBg);
    store.rendition.themes.override('color',            store.userInk);
    store.rendition.themes.override('letter-spacing',   store.userSpacing + 'em');
    store.rendition.themes.override('line-height',      String(store.userLeading));
  } catch (e) { ErrorBoundary.handle('renderer', e, 'customTheme'); }
}

/* ══════════════════════════════════════════════════════════
   §13. [UX#6] 진행률 즉각 연동
   ══════════════════════════════════════════════════════════ */
function updateProgressUI(location) {
  if (!location) return;
  let pct = 0;

  if (store.totalLocations > 0 && store.book?.locations) {
    try {
      const ratio = store.book.locations.percentageFromCfi(location.start.cfi);
      if (typeof ratio === 'number' && !isNaN(ratio)) pct = Math.round(ratio * 100);
    } catch (_) {}
  }
  if (pct === 0 && location.start.index >= 0) {
    pct = Math.round((location.start.index / (store.book?.spine?.items?.length || 1)) * 100);
  }
  pct = Math.min(100, Math.max(0, pct));

  const fill = DOMProxy.get('progress-bar-fill');
  fill.style.width = `${pct}%`;
  DOMProxy.q('.progress-bar-track').setAttribute('aria-valuenow', pct);
  setTextSafe(DOMProxy.get('viewer-progress-text'), `${pct}%`);

  const si = location.start.location >= 0 ? location.start.location + 1 : '-';
  const ei = location.end.location   >= 0 ? location.end.location   + 1 : '-';
  const tt = store.totalLocations    >  0 ? store.totalLocations        : '-';
  setTextSafe(DOMProxy.get('reading-location-range'), `${si}\u2013${ei} / ${tt}`);
}

/* ══════════════════════════════════════════════════════════
   §14. epub.js 렌더링 엔진
   ══════════════════════════════════════════════════════════ */
async function openEpubBook(fileData, isBuffer = false) {
  showViewerScreen();
  LoadingOverlay.show('도서 버퍼를 확장하는 중...');
  await destroyCurrentRenditionContext();

  await ErrorBoundary.wrap('renderer', async () => {
    const book = await Promise.race([
      new Promise((res, rej) => { const b = ePub(fileData); b.ready.then(() => res(b)).catch(rej); }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('도서 디코딩 타임아웃 (15s)')), 15000)),
    ]);
    store.book = book;

    const [meta, nav] = await Promise.all([book.loaded.metadata, book.loaded.navigation]);
    const title = meta.title || '제목 없음', creator = meta.creator || '';
    setTextSafe(DOMProxy.get('nav-book-title'), title);
    store.bookKey = 'fable_cfi_' + (title + creator).replace(/[^a-zA-Z0-9가-힣]/g, '_').slice(0, 50);

    if (!isBuffer && fileData instanceof File) {
      const buf = await fileData.arrayBuffer();
      await StorageSystem.saveBook(store.bookKey, buf, title, creator);
      renderLibraryGrid();
    }

    renderTocSidebar(nav.toc || []);
    initRenditionEngine(book);
    generateLocationsBackground(book);
    ReadingStatsTracker.startSession();

    const annotations = await StorageSystem.getAnnotationsByBook(store.bookKey);
    AnnotationManager.restoreAll(annotations);
  })();

  if (!store.rendition) { LoadingOverlay.hide(); exitViewer(); }
}

/* ── 테마 등록 ── */
function registerEpubThemes(rendition) {
  const BASE = { 'font-family': "'Gowun Batang','Noto Serif KR',Georgia,serif", 'word-break': 'keep-all', 'overflow-wrap': 'break-word' };

  rendition.themes.register('paper', {
    body: { ...BASE, background: '#fcfbf7 !important', color: '#1a1814 !important' },
    'p,li,blockquote': { 'margin-bottom': '0.6em' },
    'h1,h2,h3,h4': { 'font-weight': '700', 'line-height': '1.4' },
    img: { 'max-width': '100%', height: 'auto', display: 'block', margin: '0 auto' },
  });
  rendition.themes.register('dark', {
    body: { ...BASE, background: '#1a1a1e !important', color: '#c8c6c0 !important', filter: 'contrast(0.92)', 'font-weight': '300' },
    'p,li,blockquote': { 'margin-bottom': '0.6em' },
    'h1,h2,h3,h4': { 'font-weight': '600', 'line-height': '1.4', color: '#e0dede !important' },
    a: { color: '#8a8882 !important' },
    img: { 'max-width': '100%', height: 'auto', display: 'block', margin: '0 auto' },
  });
  rendition.themes.register('white', {
    body: { ...BASE, background: '#ffffff !important', color: '#111111 !important' },
    'p,li,blockquote': { 'margin-bottom': '0.6em' },
    'h1,h2,h3,h4': { 'font-weight': '700', 'line-height': '1.4' },
    img: { 'max-width': '100%', height: 'auto', display: 'block', margin: '0 auto' },
  });
  rendition.themes.register('custom', {
    body: { ...BASE, background: store.userBg + ' !important', color: store.userInk + ' !important',
            'letter-spacing': store.userSpacing + 'em', 'line-height': String(store.userLeading) },
    img: { 'max-width': '100%', height: 'auto', display: 'block', margin: '0 auto' },
  });
}

/* [R2b] FOUC 방지 콘텐츠 스타일 즉시 주입 */
function injectContentStyles(contents) {
  const doc = contents.document;
  if (!doc) return;
  doc.getElementById('fable-injected')?.remove();
  const style = doc.createElement('style');
  style.id = 'fable-injected';
  const themeBg = store.theme === 'dark' ? '#1a1a1e' : store.theme === 'white' ? '#ffffff' : store.theme === 'custom' ? store.userBg : '#fcfbf7';
  style.textContent = `
    html,body { background:${themeBg} !important; -webkit-font-smoothing:antialiased; }
    *,*::before,*::after { box-sizing:border-box; }
    p,div,span,li,td { page-break-inside:avoid; break-inside:avoid; }
    mark.fable-search-mark { background:rgba(255,220,50,0.55); border-radius:2px; animation:fable-mark-pulse 1.2s ease-out forwards; }
    @keyframes fable-mark-pulse { 0% { background:rgba(255,165,0,0.75); } 100% { background:rgba(255,220,50,0.45); } }
    .hl-yellow { background:rgba(255,235,59,0.45)!important; border-bottom:2px solid #f5c800!important; }
    .hl-green  { background:rgba(105,240,174,0.40)!important; border-bottom:2px solid #00c853!important; }
    .fable-search-hl { background:rgba(255,165,0,0.45)!important; border-radius:3px; }
  `;
  doc.head.appendChild(style);
}

function initRenditionEngine(book) {
  const viewport = DOMProxy.get('viewer-viewport');
  if (!DOMProxy.exists('viewer-viewport')) return;

  const rendition = book.renderTo(viewport, {
    manager: 'continuous', flow: store.flow, width: '100%', height: '100%', spread: 'auto',
  });
  store.rendition = rendition;

  registerEpubThemes(rendition);
  rendition.hooks.content.register(injectContentStyles); /* [R2b] */
  _applyAllRenditionSettings(rendition);

  const savedCFI = StorageSystem.lsGet('fable_cfi_' + store.bookKey, '');
  rendition.display(savedCFI || undefined)
    .then(() => {
      LoadingOverlay.hide();
      if (savedCFI) Toast.show('이전에 읽던 위치에서 시작합니다.', 'success');
      SearchEngine.build(book);
      initAnnotationManager(rendition);
      NavGuard.init(rendition);
    })
    .catch(err => { LoadingOverlay.hide(); ErrorBoundary.handle('renderer', err, 'rendition.display'); });

  rendition.on('relocated', (location) => {
    store.currentCFI = location.start.cfi;
    StorageSystem.lsSet('fable_cfi_' + store.bookKey, location.start.cfi);
    ReadingStatsTracker.markPosition(location.start.cfi);
    updateProgressUI(location);
    const href = location.start.href;
    if (href && href !== store.currentHref) { store.currentHref = href; updateTocActiveItem(href); }
    _updateArrowState(location);
    NavGuard.onRelocated();
  });

  rendition.on('keyup', handleKeyDown);
  rendition.on('click', () => {
    if (store.isTocOpen)      store.isTocOpen     = false;
    if (store.isSettingsOpen) store.isSettingsOpen = false;
    store.navBarsVisible = !store.navBarsVisible;
  });
  rendition.on('rendered', (section, view) => {
    if (view?.document) injectContentStyles({ document: view.document }); /* [R2b] 재확인 */
    if (store.flow === 'scrolled') bindScrollTopButton(view);
  });
}

function _applyAllRenditionSettings(rendition) {
  const t = store.theme === 'custom' ? 'custom' : store.theme;
  try { rendition.themes.select(t); } catch (_) {}
  try { rendition.themes.fontSize(`${store.fontSize}%`); } catch (_) {}
  try { rendition.themes.override('line-height', LH_MAP[store.lineHeight] || '1.85'); } catch (_) {}
  if (store.theme === 'custom') _injectCustomToIframe();
}

function _updateArrowState(location) {
  DOMProxy.get('arrow-prev').disabled = location.atStart === true;
  DOMProxy.get('arrow-next').disabled = location.atEnd   === true;
}

/* ══════════════════════════════════════════════════════════
   §15. [R2c] destroyCurrentRenditionContext — 자원 해제 파이프라인
   ══════════════════════════════════════════════════════════ */
async function destroyCurrentRenditionContext() {
  ReadingStatsTracker.stopSession();
  NavGuard.destroy();
  SearchEngine.destroy();
  AnnotationManager.reset();
  VirtualSearchList.destroy();
  ResourceRegistry.releaseAll(); /* [R2c] 모든 이벤트 리스너 일괄 해제 */

  const vp = DOMProxy.get('viewer-viewport');
  if (DOMProxy.exists('viewer-viewport')) {
    vp.querySelectorAll('iframe').forEach(f => { f.src = 'about:blank'; f.remove(); });
  }

  if (store.rendition) { try { store.rendition.destroy(); } catch (_) {} store.rendition = null; }
  if (store.book)      { try { store.book.destroy();      } catch (_) {} store.book      = null; }

  ReactiveStore.patch({
    toc: [], currentHref: '', totalLocations: 0, currentCFI: '',
    isTocOpen: false, isSettingsOpen: false, bookKey: '',
    navBarsVisible: true, isScrollMode: false,
  });
  DOMProxy.invalidate();

  setTextSafe(DOMProxy.get('nav-book-title'),        '도서 로딩 중...');
  setTextSafe(DOMProxy.get('viewer-progress-text'),  '0%');
  setTextSafe(DOMProxy.get('reading-location-range'), '- / -');
  DOMProxy.get('progress-bar-fill').style.width = '0%';
  if (DOMProxy.exists('toc-list')) DOMProxy.get('toc-list').innerHTML = '';
}

function exitViewer() {
  destroyCurrentRenditionContext().then(() => { showUploaderScreen(); renderLibraryGrid(); });
}

/* ══════════════════════════════════════════════════════════
   §16. [UX#3] 가로↔세로 CFI 보정 스케줄러
   ══════════════════════════════════════════════════════════ */
function switchFlowMode(mode) {
  if (store.flow === mode || !store.book) return;
  const savedCFI = store.currentCFI;
  const savedBook = store.book;
  store.flow = mode;
  destroyCurrentRenditionContext().then(() => {
    store.book = savedBook;
    initRenditionEngine(savedBook);
    if (savedCFI) ResourceRegistry.addTimer(setTimeout(() => { store.rendition?.display(savedCFI).catch(() => {}); }, 350));
  });
}

/* ══════════════════════════════════════════════════════════
   §17. NavGuard (뮤텍스 + 리사이즈 + 터치 스와이프)
   ══════════════════════════════════════════════════════════ */
const NavGuard = (() => {
  let navigating = false, pending = null, resizeObs = null, resizeTimer = null;
  let gestureAxis = null, touchStartX = 0, touchStartY = 0, touchStartTime = 0, cfiSnap = '';

  function acquire() { if (navigating) return false; navigating = true; _setArrows(false); return true; }
  function release() {
    navigating = false; _setArrows(true);
    if (pending) { const d = pending; pending = null; requestAnimationFrame(() => d === 'prev' ? prev() : next()); }
  }
  function onRelocated() { release(); }
  function _setArrows(en) {
    DOMProxy.get('arrow-prev').style.pointerEvents = en ? '' : 'none';
    DOMProxy.get('arrow-next').style.pointerEvents = en ? '' : 'none';
  }

  async function prev() {
    if (!store.rendition) return;
    if (!acquire()) { pending = 'prev'; return; }
    try { await store.rendition.prev(); } catch (_) { release(); }
  }
  async function next() {
    if (!store.rendition) return;
    if (!acquire()) { pending = 'next'; return; }
    try { await store.rendition.next(); } catch (_) { release(); }
  }

  function _initResize(rendition) {
    const vp = DOMProxy.get('viewer-viewport');
    if (!DOMProxy.exists('viewer-viewport') || typeof ResizeObserver === 'undefined') return;
    resizeObs = new ResizeObserver(entries => {
      if (!store.rendition) return;
      if (store.currentCFI) cfiSnap = store.currentCFI;
      ResizeMask.show();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(async () => {
        if (!store.rendition) { ResizeMask.hide(); return; }
        const { width, height } = entries[entries.length - 1].contentRect;
        if (width < 2 || height < 2) { ResizeMask.hide(); return; }
        try {
          navigating = false; pending = null;
          rendition.resize(width, height);
          await new Promise(r => requestAnimationFrame(r));
          if (cfiSnap) await rendition.display(cfiSnap).catch(() => {});
        } catch (_) {}
        ResizeMask.hide();
      }, 160);
    });
    resizeObs.observe(vp);
    ResourceRegistry.addResizeObserver(resizeObs);
  }

  function _initTouch() {
    const viewer = DOMProxy.get('screen-viewer');
    if (!DOMProxy.exists('screen-viewer')) return;
    const SWIPE_MIN = 50, AXIS_LOCK = 8, EDGE_PX = window.innerWidth * 0.1;

    const onStart = (e) => {
      const panel = DOMProxy.get('settings-panel'), toc = DOMProxy.get('toc-sidebar');
      if (panel.contains?.(e.target) || toc.contains?.(e.target)) return;
      touchStartX = e.touches[0].clientX; touchStartY = e.touches[0].clientY;
      touchStartTime = Date.now(); gestureAxis = null;
    };
    const onMove = (e) => {
      if (gestureAxis === 'y') return;
      const dx = Math.abs(e.touches[0].clientX - touchStartX), dy = Math.abs(e.touches[0].clientY - touchStartY);
      if (gestureAxis === null && (dx > AXIS_LOCK || dy > AXIS_LOCK)) gestureAxis = dx >= dy ? 'x' : 'y';
      if (gestureAxis === 'x') e.preventDefault();
    };
    const onEnd = (e) => {
      if (gestureAxis !== 'x') return;
      if (Date.now() - touchStartTime > 500) return;
      const deltaX = e.changedTouches[0].clientX - touchStartX;
      if (Math.abs(deltaX) < SWIPE_MIN) return;
      if (touchStartX < EDGE_PX || touchStartX > window.innerWidth - EDGE_PX) { gestureAxis = null; return; }
      deltaX < 0 ? next() : prev(); gestureAxis = null;
    };
    ResourceRegistry.addListener(viewer, 'touchstart', onStart, { passive: true });
    ResourceRegistry.addListener(viewer, 'touchmove',  onMove,  { passive: false });
    ResourceRegistry.addListener(viewer, 'touchend',   onEnd,   { passive: true });
  }

  function init(rendition) { navigating = false; pending = null; gestureAxis = null; _initResize(rendition); _initTouch(); }
  function destroy() { if (resizeObs) { resizeObs.disconnect(); resizeObs = null; } clearTimeout(resizeTimer); navigating = false; pending = null; }

  return { init, destroy, prev, next, onRelocated };
})();

/* ══════════════════════════════════════════════════════════
   §18. locations 백그라운드 생성
   ══════════════════════════════════════════════════════════ */
function generateLocationsBackground(book) {
  if (typeof Worker !== 'undefined') {
    const code = `self.onmessage=function(e){var l=e.data.spineLength||10,list=[];for(var i=0;i<l;i++)list.push("epubcfi(/6/"+(i*2+2)+"[s"+i+"]!/4/2)");self.postMessage({list:list});};`;
    const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
    const w   = new Worker(url);
    w.postMessage({ spineLength: book.spine?.items?.length || 10 });
    w.onmessage = (e) => { store.totalLocations = e.data.list.length; URL.revokeObjectURL(url); w.terminate(); };
    w.onerror   = () => { URL.revokeObjectURL(url); w.terminate(); };
  }
  book.locations.generate(1600).then(l => { store.totalLocations = Math.max(store.totalLocations, l.length); }).catch(() => {});
}

/* ══════════════════════════════════════════════════════════
   §19. TOC 사이드바
   ══════════════════════════════════════════════════════════ */
function renderTocSidebar(tocData) {
  const container = DOMProxy.get('toc-list');
  if (!DOMProxy.exists('toc-list')) return;
  container.innerHTML = '';

  if (!tocData?.length) {
    const p = document.createElement('p');
    p.style.cssText = 'padding:20px;color:var(--color-ink-muted);font-size:13px;text-align:center;';
    p.textContent = '목차 정보가 없습니다.'; container.appendChild(p); return;
  }
  const frag = document.createDocumentFragment();
  function appendItems(items, depth) {
    items.forEach(item => {
      const btn = document.createElement('button');
      btn.className     = 'toc-item'; btn.dataset.depth = String(Math.min(depth, 3));
      btn.dataset.href  = item.href || ''; btn.textContent = item.label?.trim() || '(제목 없음)';
      btn.setAttribute('role', 'listitem');
      btn.addEventListener('click', () => {
        if (store.rendition && item.href) store.rendition.display(item.href).catch(() => {});
        store.isTocOpen = false;
      });
      frag.appendChild(btn);
      if (item.subitems?.length) appendItems(item.subitems, depth + 1);
    });
  }
  appendItems(tocData, 1); container.appendChild(frag);
}

function updateTocActiveItem(href) {
  DOMProxy.get('toc-list').querySelectorAll?.('.toc-item').forEach(item => {
    const ih = item.dataset.href || '';
    item.classList.toggle('active', !!(ih && (href.includes(ih.split('#')[0]) || ih.includes(href.split('#')[0]))));
  });
}

/* ══════════════════════════════════════════════════════════
   §20. [UX#22] 가상 스크롤 검색 레이어 (IntersectionObserver 재활용 풀)
   ══════════════════════════════════════════════════════════ */
const VirtualSearchList = (() => {
  const VISIBLE = 20, ITEM_H = 64;
  let allResults = [], renderedStart = 0, container = null, sentinel = null, observer = null, pool = [], _q = '';

  function _createItem() {
    const div = document.createElement('div');
    div.className = 'search-result-item';
    div.setAttribute('role', 'option');
    div.style.cssText = `min-height:${ITEM_H}px;padding:10px 16px;border-bottom:1px solid var(--color-border-soft);cursor:pointer;`;
    div.innerHTML = '<div class="sri-section" style="font-size:10px;color:var(--color-ink-muted);margin-bottom:3px;"></div><p class="sri-snippet" style="font-size:12px;line-height:1.5;margin:0;color:var(--color-ink-soft);"></p>';
    return div;
  }

  function _renderChunk(start, q) {
    if (!container) return;
    const end = Math.min(start + VISIBLE, allResults.length);
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const m = allResults[i], node = pool.pop() || _createItem();
      node.querySelector('.sri-section').textContent = `${i+1}. ${(m.sectionHref||'').split('/').pop()}`;
      const snip = node.querySelector('.sri-snippet'); snip.innerHTML = '';
      const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})`, 'gi');
      m.context.split(re).forEach(part => {
        if (re.test(part)) { const mk = document.createElement('mark'); mk.className='fable-search-mark'; mk.textContent=part; snip.appendChild(mk); re.lastIndex=0; }
        else snip.appendChild(document.createTextNode(part));
      });
      node.onclick = async () => {
        DOMProxy.get('search-modal').style.display = 'none';
        if (store.rendition && m.cfi) { try { await store.rendition.display(m.cfi); setTimeout(() => injectSearchHighlight(m.cfi), 400); } catch (_) {} }
      };
      frag.appendChild(node);
    }
    container.appendChild(frag); renderedStart = end;
  }

  function _setupSentinel() {
    sentinel = document.createElement('div'); sentinel.style.height = '1px';
    container.appendChild(sentinel);
    observer = new IntersectionObserver(entries => {
      if (!entries[0].isIntersecting || renderedStart >= allResults.length) return;
      const old = container.querySelectorAll('.search-result-item');
      if (old.length > VISIBLE * 2) { Array.from(old).slice(0, old.length - VISIBLE).forEach(n => { pool.push(n); n.remove(); }); }
      _renderChunk(renderedStart, _q); container.appendChild(sentinel);
    }, { threshold: 0.1 });
    observer.observe(sentinel);
  }

  function render(containerEl, results, query) {
    if (observer) { observer.disconnect(); observer = null; }
    pool = []; allResults = results; container = containerEl; renderedStart = 0; _q = query;
    container.innerHTML = '';
    if (!results.length) {
      const p = document.createElement('p'); p.style.cssText='padding:20px;text-align:center;color:var(--color-ink-muted);font-size:13px;';
      p.textContent='검색 결과가 없습니다.'; container.appendChild(p); return;
    }
    _renderChunk(0, query); _setupSentinel();
  }

  function destroy() { if (observer) { observer.disconnect(); observer = null; } pool=[]; allResults=[]; container=null; sentinel=null; }
  return { render, destroy };
})();

/* ══════════════════════════════════════════════════════════
   §21. 전문 검색 엔진
   ══════════════════════════════════════════════════════════ */
const SearchEngine = (() => {
  let index = new Map(), isBuilt = false;

  async function build(book) {
    if (isBuilt || !book) return;
    index.clear();
    const parser = new DOMParser(), items = book.spine?.items || [];
    for (const item of items) {
      try {
        const section = book.spine.get(item.href || item.idref);
        if (!section) continue;
        await section.load(book.load.bind(book));
        const doc = parser.parseFromString(section.content || '<html></html>', 'text/html');
        Array.from(doc.querySelectorAll('p,h1,h2,h3,li')).forEach(p => {
          const text = p.textContent?.trim() || '';
          if (text.length < 3) return;
          let cfi = ''; try { cfi = section.cfiFromElement(p); } catch (_) { cfi = item.href || ''; }
          new Set(text.toLowerCase().split(/\s+/).filter(w => w.length >= 2)).forEach(word => {
            if (!index.has(word)) index.set(word, []);
            index.get(word).push({ sectionHref: item.href || '', cfi, context: text.slice(0, 120) });
          });
        });
        section.unload(); await new Promise(r => setTimeout(r, 0));
      } catch (_) {}
    }
    isBuilt = true;
  }

  function query(keyword) {
    if (!isBuilt || keyword.length < 2) return [];
    const kw = keyword.toLowerCase().trim(), results = [], seen = new Set();
    for (const [key, list] of index.entries()) {
      if (key.includes(kw)) list.forEach(r => { if (!seen.has(r.cfi)) { seen.add(r.cfi); results.push(r); } });
      if (results.length >= 200) break;
    }
    return results;
  }

  function destroy() { index.clear(); isBuilt = false; }
  return { build, query, destroy };
})();

function runSearchExecution() {
  const q = DOMProxy.get('input-search-query').value?.trim() ?? '';
  if (q.length < 2) { Toast.show('검색어는 2글자 이상 입력하세요.', 'error'); return; }
  VirtualSearchList.render(DOMProxy.get('search-results-container'), SearchEngine.query(q), q);
}

function injectSearchHighlight(cfi) {
  if (!store.rendition) return;
  try { store.rendition.annotations.add('highlight', cfi, {}, null, 'fable-search-hl'); setTimeout(() => { try { store.rendition?.annotations?.remove(cfi, 'highlight'); } catch (_) {} }, 3000); }
  catch (_) {}
}

/* ══════════════════════════════════════════════════════════
   §22. 서재 그리드 ([UX#2] 스켈레톤 UI)
   ══════════════════════════════════════════════════════════ */
function renderLibraryGrid() {
  const grid = DOMProxy.get('library-grid');
  if (!DOMProxy.exists('library-grid')) return;
  grid.innerHTML = '<div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div>';

  StorageSystem.getAllBooks().then(books => {
    grid.innerHTML = '';
    if (!books.length) {
      const p = document.createElement('p');
      p.style.cssText = 'grid-column:1/-1;font-size:12px;color:var(--color-ink-muted);text-align:center;padding:16px;';
      p.textContent = '저장된 도서가 없습니다. EPUB 파일을 업로드해 주세요.'; grid.appendChild(p); return;
    }
    const frag = document.createDocumentFragment();
    books.forEach(b => {
      const card = document.createElement('div'); card.className = 'book-card'; card.setAttribute('role','listitem');
      const cover = document.createElement('div'); cover.className = 'book-cover-placeholder'; cover.textContent = 'EPUB'; cover.setAttribute('aria-hidden','true');
      const titleEl = document.createElement('div'); titleEl.className = 'book-card-title'; titleEl.textContent = b.title || '제목 없음';
      const delBtn = document.createElement('button'); delBtn.className = 'btn-delete-book'; delBtn.textContent = '✕';
      delBtn.title = '서재에서 제거'; delBtn.setAttribute('aria-label', (b.title||'도서') + ' 서재에서 제거');
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm('이 도서를 서재에서 제거하시겠습니까?')) StorageSystem.deleteBook(b.bookKey).then(() => renderLibraryGrid());
      });
      card.appendChild(cover); card.appendChild(titleEl); card.appendChild(delBtn);
      card.setAttribute('aria-label', (b.title||'제목 없음') + ' 열기');
      card.addEventListener('click', () => openEpubBook(b.bytes, true));
      frag.appendChild(card);
    });
    grid.appendChild(frag);
  });
}

/* ══════════════════════════════════════════════════════════
   §23. [UX#11] TTS 엔진
   ══════════════════════════════════════════════════════════ */
const TTSSystem = (() => {
  let utterance = null, isPaused = false, totalLen = 0;
  function play(text) {
    if (!text) return;
    window.speechSynthesis.cancel(); totalLen = text.length;
    utterance = new SpeechSynthesisUtterance(text); utterance.lang = 'ko-KR'; utterance.rate = 1.0;
    utterance.onboundary = (e) => { if (e.charIndex != null) { DOMProxy.get('tts-progress-fill').style.width = `${Math.min(100,(e.charIndex/totalLen)*100)}%`; } };
    utterance.onend = utterance.onerror = () => { DOMProxy.get('tts-player-bar').style.display='none'; DOMProxy.get('tts-progress-fill').style.width='0%'; };
    isPaused = false; window.speechSynthesis.speak(utterance);
    DOMProxy.get('tts-player-bar').style.display = 'flex'; setTextSafe(DOMProxy.get('btn-tts-play-pause'), '⏸');
  }
  function pauseResume() {
    if (isPaused) { window.speechSynthesis.resume(); isPaused = false; setTextSafe(DOMProxy.get('btn-tts-play-pause'), '⏸'); }
    else { window.speechSynthesis.pause(); isPaused = true; setTextSafe(DOMProxy.get('btn-tts-play-pause'), '▶'); }
  }
  function stop() { window.speechSynthesis.cancel(); DOMProxy.get('tts-player-bar').style.display='none'; }
  return { play, pauseResume, stop };
})();

/* ══════════════════════════════════════════════════════════
   §24. [UX#15] 독서 통계 + 탄력 모션
   ══════════════════════════════════════════════════════════ */
const ReadingStatsTracker = (() => {
  let timer = null;
  function startSession() {
    store.readingSession.startTime = Date.now();
    clearInterval(timer);
    timer = setInterval(() => {
      if (document.visibilityState === 'visible') { store.readingSession.accumulated++; _updateUI(); }
    }, 1000);
    ResourceRegistry.addTimer(timer);
  }
  function stopSession() { clearInterval(timer); }
  function markPosition(cfi) { if (cfi) store.readingSession.positions.add(cfi); _updateUI(); }
  function _updateUI() {
    const total = store.readingSession.accumulated, min = Math.floor(total / 60), sec = total % 60;
    setTextSafe(DOMProxy.get('stat-reading-time'), `${min}분 ${sec}초`);
    setTextSafe(DOMProxy.get('stat-pages-read'), String(store.readingSession.positions.size));
    const goalMin = parseInt(localStorage.getItem('fable_daily_goal') || '30', 10);
    const fill = DOMProxy.get('goal-progress-fill'), pct = Math.min(100, (min / goalMin) * 100);
    fill.style.transition = 'width 600ms cubic-bezier(0.34,1.56,0.64,1)'; fill.style.width = `${pct}%`;
    DOMProxy.q('.goal-track').setAttribute('aria-valuenow', Math.round(pct));
    if (pct >= 100 && fill.dataset.notified !== '1') { fill.dataset.notified = '1'; Toast.show('\uD83C\uDF89 오늘의 독서 목표를 달성했습니다!', 'success'); }
  }
  return { startSession, stopSession, markPosition };
})();

/* ══════════════════════════════════════════════════════════
   §25. [UX#14] 롱프레스 컨텍스트 메뉴
   ══════════════════════════════════════════════════════════ */
function initContextMenu() {
  const viewer = DOMProxy.get('screen-viewer');
  if (!DOMProxy.exists('screen-viewer')) return;
  let longPressTimer = null, selectedText = '';

  function showMenu() { if (!selectedText) return; const m = DOMProxy.get('context-menu'); m.style.display='flex'; m.classList.add('slide-up'); }
  function hideMenu() { const m = DOMProxy.get('context-menu'); m.classList.remove('slide-up'); setTimeout(() => { m.style.display='none'; }, 280); }

  const onStart = (e) => {
    longPressTimer = setTimeout(() => {
      if (store.rendition) {
        try { DOMProxy.get('viewer-viewport').querySelectorAll('iframe').forEach(f => { const s = f.contentWindow?.getSelection()?.toString()?.trim(); if (s?.length > 1) selectedText = s; }); } catch (_) {}
      }
      if (selectedText) showMenu();
    }, 600);
  };
  ResourceRegistry.addListener(viewer, 'touchstart', onStart, { passive: true });
  ResourceRegistry.addListener(viewer, 'touchend',   () => clearTimeout(longPressTimer), { passive: true });
  ResourceRegistry.addListener(viewer, 'touchmove',  () => clearTimeout(longPressTimer), { passive: true });
  ResourceRegistry.addListener(document, 'pointerdown', (e) => { if (!DOMProxy.get('context-menu').contains?.(e.target)) { hideMenu(); selectedText = ''; } }, { passive: true });

  DOMProxy.get('ctx-copy').addEventListener('click', () => { if (selectedText) navigator.clipboard?.writeText(selectedText).catch(() => {}); Toast.show('클립보드에 복사했습니다.'); hideMenu(); });
  DOMProxy.get('ctx-tts').addEventListener('click', () => { if (selectedText) TTSSystem.play(selectedText); hideMenu(); });
  DOMProxy.get('ctx-search').addEventListener('click', () => { const m=DOMProxy.get('search-modal'), i=DOMProxy.get('input-search-query'); i.value=selectedText; m.style.display='flex'; runSearchExecution(); hideMenu(); });
  DOMProxy.get('ctx-highlight').addEventListener('click', () => { Toast.show('하이라이트 기능은 텍스트 선택 후 자동 추가됩니다.'); hideMenu(); });
}

/* ══════════════════════════════════════════════════════════
   §26. [UX#21] 어노테이션 매니저
   ══════════════════════════════════════════════════════════ */
const AnnotationManager = (() => {
  let _rendition = null;
  function init(rendition) {
    _rendition = rendition;
    rendition.on('selected', async (cfiRange, contents) => {
      const sel = contents.window.getSelection();
      if (!sel || sel.isCollapsed || sel.toString().trim().length < 2) return;
      try {
        const ann = await AnnotationSyncEngine.create(store.bookKey, cfiRange, sel.toString().trim(), 'yellow');
        rendition.annotations.add('highlight', cfiRange, { uuid: ann.uuid }, null, 'hl-yellow');
        Toast.show('하이라이트가 저장되었습니다.', 'success');
      } catch (e) { ErrorBoundary.handle('storage', e, 'annotation:create'); }
    });
  }
  function restoreAll(annotations) {
    if (!_rendition) return;
    annotations.forEach(ann => { try { _rendition.annotations.add('highlight', ann.cfiRange, { uuid: ann.uuid }, null, 'hl-' + (ann.color||'yellow')); } catch (_) {} });
  }
  function reset() { _rendition = null; }
  return { init, restoreAll, reset };
})();

function initAnnotationManager(rendition) { AnnotationManager.init(rendition); }

/* ══════════════════════════════════════════════════════════
   §27. [UX#12] 폰트 업로드 샌드박스
   ══════════════════════════════════════════════════════════ */
function initFontUploader() {
  if (!DOMProxy.exists('font-uploader')) return;
  DOMProxy.get('font-uploader').addEventListener('change', (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = async (evt) => {
      const safeId = 'custom_' + Math.random().toString(36).slice(2, 10);
      try {
        const face = new FontFace(safeId, `url(${evt.target.result})`);
        const loaded = await face.load(); document.fonts.add(loaded);
        if (store.rendition) { store.rendition.themes.font(safeId); Toast.show('커스텀 폰트가 적용되었습니다.', 'success'); }
      } catch (err) { Toast.show(`폰트 로드 실패: ${err.message}`, 'error'); }
    };
    reader.readAsDataURL(file); e.target.value = '';
  });
}

/* ══════════════════════════════════════════════════════════
   §28. [UX#23] 커스텀 테마 빌더
   ══════════════════════════════════════════════════════════ */
function initCustomThemeBuilder() {
  function syncColor(colorId, hexId, storeKey) {
    const colorEl = DOMProxy.get(colorId), hexEl = DOMProxy.get(hexId);
    colorEl.addEventListener('input', () => { const v=colorEl.value; hexEl.value=v; store[storeKey]=v; _saveStateToLS(); });
    hexEl.addEventListener('input', () => { const v=hexEl.value.trim(); if (/^#[0-9A-Fa-f]{6}$/.test(v)) { colorEl.value=v; store[storeKey]=v; _saveStateToLS(); } });
  }
  syncColor('input-user-bg', 'input-user-bg-hex', 'userBg');
  syncColor('input-user-ink','input-user-ink-hex','userInk');
  DOMProxy.get('input-user-spacing').addEventListener('input', () => { const v=parseFloat(DOMProxy.get('input-user-spacing').value); setTextSafe(DOMProxy.get('spacing-val'), v+'em'); store.userSpacing=v; _saveStateToLS(); });
  DOMProxy.get('input-user-leading').addEventListener('input', () => { const v=parseFloat(DOMProxy.get('input-user-leading').value); setTextSafe(DOMProxy.get('leading-val'), String(v)); store.userLeading=v; _saveStateToLS(); });
}

/* ══════════════════════════════════════════════════════════
   §29. 키보드 단축키 & 단축키 팁
   ══════════════════════════════════════════════════════════ */
function handleKeyDown(e) {
  const viewer = DOMProxy.get('screen-viewer');
  if (!DOMProxy.exists('screen-viewer') || viewer.style.display === 'none') return;
  if (!store.rendition) return;
  switch (e.key) {
    case 'ArrowRight': case 'ArrowDown': case ' ':     e.preventDefault(); NavGuard.next(); break;
    case 'ArrowLeft':  case 'ArrowUp':  case 'Backspace': e.preventDefault(); NavGuard.prev(); break;
    case 'Escape':
      if (store.isSettingsOpen) { store.isSettingsOpen = false; break; }
      if (store.isTocOpen)      { store.isTocOpen      = false; break; }
      if (confirm('뷰어를 닫고 서재로 돌아가시겠습니까?')) exitViewer(); break;
    default: break;
  }
}

function showKeyboardHint() {
  if (localStorage.getItem('fable_keyboard_hint_shown')) return;
  DOMProxy.get('keyboard-hint-layer').style.display = 'flex';
  localStorage.setItem('fable_keyboard_hint_shown', '1');
}

/* ══════════════════════════════════════════════════════════
   §30. 오프라인 배너 + 동기화 트리거
   ══════════════════════════════════════════════════════════ */
function initOfflineBanner() {
  function update(offline) {
    [DOMProxy.get('offline-banner'), DOMProxy.get('offline-banner-viewer')].forEach(b => { b.style.display = offline ? 'flex' : 'none'; });
  }
  window.addEventListener('offline', () => { update(true); Toast.show('인터넷 연결이 끊겼습니다. 오프라인 모드로 작동 중입니다.'); });
  window.addEventListener('online',  async () => { update(false); Toast.show('인터넷 연결이 복원되었습니다.', 'success'); await AnnotationSyncEngine.syncPending(); });
  if (!navigator.onLine) update(true);
}

/* ══════════════════════════════════════════════════════════
   §31. 스크롤 맨위로 버튼
   ══════════════════════════════════════════════════════════ */
function bindScrollTopButton(view) {
  const btn = DOMProxy.get('btn-scroll-top');
  const iframe = view?.element?.querySelector('iframe');
  if (!iframe) return;
  const cw = iframe.contentWindow; if (!cw) return;
  const onScroll = () => { btn.style.display = cw.scrollY > 200 ? 'flex' : 'none'; };
  ResourceRegistry.addListener(cw, 'scroll', onScroll, { passive: true });
  btn.onclick = () => cw.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ══════════════════════════════════════════════════════════
   §32. 설정 저장 / 복원
   ══════════════════════════════════════════════════════════ */
function _saveStateToLS() {
  const snap = { fontSize: store.fontSize, lineHeight: store.lineHeight, theme: store.theme, flow: store.flow,
                 userBg: store.userBg, userInk: store.userInk, userSpacing: store.userSpacing, userLeading: store.userLeading };
  try { localStorage.setItem(STATE_KEY, JSON.stringify(snap)); } catch (_) {}
}

function _loadStateFromLS() {
  try {
    const raw = localStorage.getItem(STATE_KEY); if (!raw) return;
    const s = JSON.parse(raw);
    ReactiveStore.patch({
      fontSize: s.fontSize ?? 100, lineHeight: s.lineHeight ?? 'normal', theme: s.theme ?? 'paper', flow: s.flow ?? 'paginated',
      userBg: s.userBg ?? '#f4f1ea', userInk: s.userInk ?? '#1a1814', userSpacing: s.userSpacing ?? 0, userLeading: s.userLeading ?? 1.85,
    });
  } catch (_) {}
}

/* ══════════════════════════════════════════════════════════
   §33. 버튼 이벤트 전체 바인딩
   ══════════════════════════════════════════════════════════ */
function initButtonEventHandlers() {
  const dropzone = DOMProxy.get('dropzone'), fileInput = DOMProxy.get('file-input');

  DOMProxy.get('btn-file-select').addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
  fileInput.addEventListener('change', async (e) => { const f = e.target.files[0]; if (f) await openEpubBook(f, false); fileInput.value = ''; });

  if (DOMProxy.exists('dropzone')) {
    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragenter', (e) => { e.preventDefault(); dropzone.classList.add('drag-over'); });
    dropzone.addEventListener('dragover',  (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; dropzone.classList.add('drag-over'); });
    dropzone.addEventListener('dragleave', (e) => { if (!dropzone.contains(e.relatedTarget)) dropzone.classList.remove('drag-over'); });
    dropzone.addEventListener('drop', async (e) => {
      e.preventDefault(); dropzone.classList.remove('drag-over');
      dropzone.classList.add('drop-bounce'); setTimeout(() => dropzone.classList.remove('drop-bounce'), 600);
      const files = e.dataTransfer.files; if (!files?.length) return;
      if (files.length > 1) { Toast.show('파일은 하나씩만 열 수 있습니다.', 'error'); return; }
      await openEpubBook(files[0], false);
    });
  }

  DOMProxy.get('arrow-prev').addEventListener('click', () => NavGuard.prev());
  DOMProxy.get('arrow-next').addEventListener('click', () => NavGuard.next());

  DOMProxy.get('btn-toc-toggle').addEventListener('click', () => { store.isTocOpen = !store.isTocOpen; });
  DOMProxy.get('btn-toc-close').addEventListener('click',  () => { store.isTocOpen = false; });
  DOMProxy.get('toc-overlay').addEventListener('click',    () => { store.isTocOpen = false; });

  DOMProxy.get('btn-settings-toggle').addEventListener('click', () => { store.isSettingsOpen = !store.isSettingsOpen; });
  DOMProxy.get('btn-settings-close').addEventListener('click',  () => { store.isSettingsOpen = false; });
  DOMProxy.get('btn-close-viewer').addEventListener('click', () => { if (confirm('뷰어를 닫고 서재로 돌아가시겠습니까?')) exitViewer(); });

  DOMProxy.qa('[data-flow]').forEach(btn => btn.addEventListener('click', () => switchFlowMode(btn.dataset.flow)));
  DOMProxy.get('btn-font-decrease').addEventListener('click', () => { store.fontSize = Math.max(60, store.fontSize - 5); _saveStateToLS(); });
  DOMProxy.get('btn-font-increase').addEventListener('click', () => { store.fontSize = Math.min(200, store.fontSize + 5); _saveStateToLS(); });
  DOMProxy.qa('[data-lh]').forEach(btn => btn.addEventListener('click', () => { store.lineHeight = btn.dataset.lh; _saveStateToLS(); }));
  DOMProxy.qa('.theme-swatch').forEach(btn => btn.addEventListener('click', () => { store.theme = btn.dataset.theme; _saveStateToLS(); }));

  DOMProxy.get('btn-search-toggle').addEventListener('click', () => { DOMProxy.get('search-modal').style.display='flex'; setTimeout(() => DOMProxy.get('input-search-query').focus(), 60); });
  DOMProxy.get('btn-search-modal-close').addEventListener('click', () => { DOMProxy.get('search-modal').style.display='none'; VirtualSearchList.destroy(); });
  DOMProxy.get('btn-execute-search').addEventListener('click', runSearchExecution);
  DOMProxy.get('input-search-query').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearchExecution(); });

  DOMProxy.get('btn-stats-toggle').addEventListener('click', () => { DOMProxy.get('stats-modal').style.display='flex'; });
  DOMProxy.get('btn-stats-modal-close').addEventListener('click', () => { DOMProxy.get('stats-modal').style.display='none'; });
  DOMProxy.get('btn-save-goal').addEventListener('click', () => { const v=DOMProxy.get('input-reading-goal').value; if(v){localStorage.setItem('fable_daily_goal',v);Toast.show('독서 목표가 저장되었습니다.','success');} });

  DOMProxy.get('btn-annotation-toggle').addEventListener('click', () => {
    if (!store.rendition) return;
    try { const doc = store.rendition.manager?.current()?.document; const text = doc?.body?.textContent?.slice(0, 4000)||''; if(text) TTSSystem.play(text); }
    catch (_) { Toast.show('TTS를 시작할 수 없습니다.', 'error'); }
  });
  DOMProxy.get('btn-tts-play-pause').addEventListener('click', () => TTSSystem.pauseResume());
  DOMProxy.get('btn-tts-stop').addEventListener('click',       () => TTSSystem.stop());
  DOMProxy.get('btn-hint-close').addEventListener('click', () => { DOMProxy.get('keyboard-hint-layer').style.display='none'; });

  document.addEventListener('pointerdown', (e) => {
    const panel = DOMProxy.get('settings-panel'), btn = DOMProxy.get('btn-settings-toggle');
    if (store.isSettingsOpen && !panel.contains?.(e.target) && !btn.contains?.(e.target)) store.isSettingsOpen = false;
  }, { passive: true });

  document.addEventListener('keydown', handleKeyDown);
  initFontUploader();
  initCustomThemeBuilder();
}

/* ══════════════════════════════════════════════════════════
   §34. 전역 진입점
   ══════════════════════════════════════════════════════════ */
async function initializeSystemCore() {
  window.addEventListener('unhandledrejection', (e) => {
    ErrorBoundary.handle('global', e.reason ?? new Error('Unhandled rejection'), 'unhandledrejection');
  });
  window.addEventListener('beforeunload', () => {
    if (store.bookKey && store.currentCFI) {
      try { localStorage.setItem('fable_cfi_' + store.bookKey, JSON.stringify({ data: store.currentCFI, ts: Date.now() })); } catch (_) {}
    }
  });

  ['dragenter','dragover','drop'].forEach(evt => {
    document.addEventListener(evt, (e) => { if (!DOMProxy.get('dropzone').contains?.(e.target)) e.preventDefault(); });
  });

  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      console.log('[Fable] SW 등록 완료:', reg.scope);
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw?.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller)
            Toast.show('앱이 업데이트되었습니다. 새로고침하면 최신 버전을 사용할 수 있습니다.');
        });
      });
    } catch (err) { console.warn('[Fable] SW 등록 실패:', err); }
  }

  await StorageSystem.init()?.catch(err => ErrorBoundary.handle('storage', err, 'init'));

  mountReactiveBinders();   /* [R1] */
  _loadStateFromLS();
  _forceSyncSettingsUI();
  initButtonEventHandlers();
  initOfflineBanner();     /* [UX#18] */
  initContextMenu();       /* [UX#14] */
  renderLibraryGrid();
  if (!('ontouchstart' in window)) showKeyboardHint(); /* [UX#17] */

  console.log('\uD83D\uDCD6 Fable v3 — Reactive Architecture Initialized');
}

function _forceSyncSettingsUI() {
  setTextSafe(DOMProxy.get('font-size-display'), `${store.fontSize}%`);
  DOMProxy.qa('[data-lh]').forEach(b => { const ok = b.dataset.lh === store.lineHeight; b.classList.toggle('active',ok); b.setAttribute('aria-checked',String(ok)); });
  DOMProxy.qa('[data-flow]').forEach(b => { const ok = b.dataset.flow === store.flow; b.classList.toggle('active',ok); b.setAttribute('aria-checked',String(ok)); });
  DOMProxy.qa('.theme-swatch').forEach(b => { const ok = b.dataset.theme === store.theme; b.classList.toggle('active',ok); b.setAttribute('aria-checked',String(ok)); });
  DOMProxy.get('custom-theme-builder').style.display = store.theme === 'custom' ? 'block' : 'none';
  if (store.theme !== 'paper' && store.theme !== 'custom') document.body.setAttribute('data-theme', store.theme);
  document.documentElement.style.setProperty('--color-user-bg',       store.userBg);
  document.documentElement.style.setProperty('--color-user-ink',      store.userInk);
  document.documentElement.style.setProperty('--user-letter-spacing', store.userSpacing + 'em');
  document.documentElement.style.setProperty('--user-line-height',    String(store.userLeading));
  DOMProxy.get('input-user-bg').value      = store.userBg;
  DOMProxy.get('input-user-bg-hex').value  = store.userBg;
  DOMProxy.get('input-user-ink').value     = store.userInk;
  DOMProxy.get('input-user-ink-hex').value = store.userInk;
  DOMProxy.get('input-user-spacing').value = String(store.userSpacing);
  setTextSafe(DOMProxy.get('spacing-val'), store.userSpacing + 'em');
  DOMProxy.get('input-user-leading').value = String(store.userLeading);
  setTextSafe(DOMProxy.get('leading-val'), String(store.userLeading));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeSystemCore);
} else {
  initializeSystemCore();
}
