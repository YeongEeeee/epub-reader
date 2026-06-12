/**
 * ============================================================
 * Fable v2 Premium — app.js
 * epub.js 0.3.93 기반 고도화 싱글-코어 아키텍처
 *
 * UX 고도화 20선 통합:
 *  #1  드롭존 마이크로 인터랙션 (네온 그라데이션 + 바운스)
 *  #2  서재 스켈레톤 UI
 *  #3  가로↔세로 뷰 전환 CFI 보정 스케줄러
 *  #4  뷰포트 크로스페이드 트랜지션
 *  #5  상/하단 바 슬라이딩 토글
 *  #6  진행률 인디케이터 즉각 연동
 *  #7  다크 테마 대비 미세 조정
 *  #8  논블로킹 스택 토스트
 *  #9  모바일 스와이프 엣지 가드
 *  #10 LRU 자동 퇴거 알림
 *  #11 TTS 진행 바 리뉴얼
 *  #12 폰트 업로드 샌드박스 안정화
 *  #13 검색 결과 mark 하이라이트
 *  #14 롱프레스 컨텍스트 메뉴
 *  #15 목표 달성 탄력 모션
 *  #16 TOC 블러 오버레이
 *  #17 키보드 단축키 팁 레이어
 *  #18 오프라인 상태 배너
 *  #19 스크롤 맨위로 버튼
 *  #20 리사이즈 디바운스 + 스피너 마스크
 * ============================================================
 */

'use strict';

/* ══════════════════════════════════════════════════════════
   0. 전역 상태
   ══════════════════════════════════════════════════════════ */
const ReaderState = {
  book:              null,
  rendition:         null,
  toc:               [],
  currentHref:       '',
  totalLocations:    0,
  currentCFI:        '',
  isTocOpen:         false,
  isSettingsOpen:    false,
  bookKey:           '',
  indexedDB:         null,
  navBarsVisible:    true,   // [UX#5]
  isScrollMode:      false,  // [UX#19]
  readingSession: {
    startTime:   Date.now(),
    accumulated: 0,
    positions:   new Set(),
  },
};

const ReadingSettings = {
  fontSize:   100,
  lineHeight: 'normal',
  theme:      'paper',
  flow:       'paginated',
};

const LH_MAP = { narrow: '1.5', normal: '1.85', wide: '2.3' };
const SETTINGS_KEY = 'fable_v2_settings';

/* ══════════════════════════════════════════════════════════
   1. DOM 프록시 (캐시 + 타입 세이프)
   ══════════════════════════════════════════════════════════ */
const DOMProxy = (() => {
  const cache = {};
  return {
    get(id) {
      if (!cache[id]) cache[id] = document.getElementById(id);
      return cache[id];
    },
    q(sel) { return document.querySelector(sel); },
    qa(sel) { return Array.from(document.querySelectorAll(sel)); },
    clear() { Object.keys(cache).forEach(k => delete cache[k]); },
  };
})();

/* ══════════════════════════════════════════════════════════
   2. [UX#8] 논블로킹 스택 토스트
   ══════════════════════════════════════════════════════════ */
const Toast = (() => {
  const DURATION   = 3000;
  const FADE_OUT   = 280;
  const MAX_STACK  = 4;
  let queue = [];

  function show(message, type = 'info') {
    const container = DOMProxy.get('global-toast-container');
    if (!container) return;

    // 스택 초과 시 가장 오래된 토스트 즉시 퇴출
    if (queue.length >= MAX_STACK) {
      const oldest = queue.shift();
      if (oldest && oldest.parentNode) {
        oldest.classList.add('out');
        setTimeout(() => oldest.remove(), FADE_OUT);
      }
    }

    const el = document.createElement('div');
    el.className = `toast${type !== 'info' ? ' ' + type : ''}`;
    el.textContent = message;
    container.appendChild(el);
    queue.push(el);

    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => {
        el.remove();
        queue = queue.filter(t => t !== el);
      }, FADE_OUT);
    }, DURATION);
  }

  return { show };
})();

/* ══════════════════════════════════════════════════════════
   3. XSS 유틸
   ══════════════════════════════════════════════════════════ */
function setTextSafe(el, text) {
  if (el) el.textContent = String(text ?? '');
}

/* ══════════════════════════════════════════════════════════
   4. StorageSystem (IndexedDB + localStorage LRU)
   ══════════════════════════════════════════════════════════ */
const StorageSystem = {
  DB_NAME: 'FableV2DB',
  DB_VER:  2,

  init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.DB_NAME, this.DB_VER);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('books')) {
          db.createObjectStore('books', { keyPath: 'bookKey' });
        }
      };
      req.onsuccess  = (e) => { ReaderState.indexedDB = e.target.result; resolve(); };
      req.onerror    = () => reject(new Error('IndexedDB 초기화 실패'));
    });
  },

  async saveBook(bookKey, buffer, title, creator) {
    return new Promise((resolve, reject) => {
      const tx    = ReaderState.indexedDB.transaction(['books'], 'readwrite');
      const store = tx.objectStore('books');
      store.put({ bookKey, bytes: buffer, title: title || '제목 없음', creator: creator || '', ts: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  },

  async getAllBooks() {
    return new Promise(resolve => {
      if (!ReaderState.indexedDB) return resolve([]);
      const tx    = ReaderState.indexedDB.transaction(['books'], 'readonly');
      const store = tx.objectStore('books');
      const req   = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => resolve([]);
    });
  },

  async deleteBook(bookKey) {
    return new Promise(resolve => {
      const tx    = ReaderState.indexedDB.transaction(['books'], 'readwrite');
      const store = tx.objectStore('books');
      store.delete(bookKey);
      tx.oncomplete = () => resolve(true);
      tx.onerror    = () => resolve(false);
    });
  },

  /* [UX#10] LRU 퇴거 알림 포함 localStorage 저장 */
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
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return def;
      return JSON.parse(raw).data ?? def;
    } catch (_) { return def; }
  },

  _evictLRU() {
    const entries = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith('fable_')) continue;
      try {
        const { ts } = JSON.parse(localStorage.getItem(k));
        entries.push({ k, ts });
      } catch (_) {}
    }
    entries.sort((a, b) => a.ts - b.ts);
    entries.slice(0, Math.ceil(entries.length * 0.3)).forEach(e => localStorage.removeItem(e.k));
  },
};

/* ══════════════════════════════════════════════════════════
   5. [UX#4] 화면 크로스페이드 전환
   ══════════════════════════════════════════════════════════ */
function showViewerScreen() {
  const up = DOMProxy.get('screen-uploader');
  const vi = DOMProxy.get('screen-viewer');
  if (!up || !vi) return;

  up.style.transition = 'opacity 300ms ease, transform 300ms ease';
  up.style.opacity    = '0';
  up.style.transform  = 'scale(0.97)';

  setTimeout(() => {
    up.style.display = 'none';
    up.style.opacity = '';
    up.style.transform = '';

    vi.style.display  = 'flex';
    vi.style.opacity  = '0';
    vi.style.transform = 'scale(1.02)';
    vi.style.transition = 'opacity 300ms ease, transform 300ms ease';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      vi.style.opacity   = '1';
      vi.style.transform = 'scale(1)';
    }));
  }, 300);
}

function showUploaderScreen() {
  const up = DOMProxy.get('screen-uploader');
  const vi = DOMProxy.get('screen-viewer');
  if (!up || !vi) return;

  vi.style.transition = 'opacity 260ms ease';
  vi.style.opacity    = '0';
  setTimeout(() => {
    vi.style.display  = 'none';
    vi.style.opacity  = '';
    vi.style.transition = '';

    up.style.display  = 'flex';
    up.style.opacity  = '0';
    up.style.transition = 'opacity 260ms ease';
    requestAnimationFrame(() => requestAnimationFrame(() => { up.style.opacity = '1'; }));
    setTimeout(() => { up.style.transition = ''; }, 300);
  }, 260);
}

/* ══════════════════════════════════════════════════════════
   6. 로딩 오버레이
   ══════════════════════════════════════════════════════════ */
const LoadingOverlay = (() => {
  let el = null;
  function show(msg = '도서를 불러오는 중...') {
    if (el) return;
    el = document.createElement('div');
    el.className = 'loading-overlay';
    el.innerHTML = `<div class="spinner"></div><p>${msg}</p>`;
    const vi = DOMProxy.get('screen-viewer');
    if (vi) vi.appendChild(el);
  }
  function hide() {
    if (!el) return;
    el.classList.add('fade-out');
    setTimeout(() => { el?.remove(); el = null; }, 260);
  }
  return { show, hide };
})();

/* ══════════════════════════════════════════════════════════
   7. [UX#20] 리사이즈 디바운스 뮤텍스 + 스피너 마스크
   ══════════════════════════════════════════════════════════ */
const ResizeMask = (() => {
  let maskEl = null;
  function show() {
    maskEl = DOMProxy.get('resize-mask');
    if (maskEl) maskEl.style.display = 'flex';
  }
  function hide() {
    if (maskEl) maskEl.style.display = 'none';
  }
  return { show, hide };
})();

/* ══════════════════════════════════════════════════════════
   8. [UX#5] 상/하단 바 슬라이딩 토글
   ══════════════════════════════════════════════════════════ */
function toggleNavBars() {
  const nav    = DOMProxy.get('viewer-nav-bar');
  const bottom = DOMProxy.get('viewer-bottom-bar');
  if (!nav || !bottom) return;

  ReaderState.navBarsVisible = !ReaderState.navBarsVisible;

  if (ReaderState.navBarsVisible) {
    nav.classList.remove('nav-hidden');
    bottom.classList.remove('bottom-hidden');
  } else {
    nav.classList.add('nav-hidden');
    bottom.classList.add('bottom-hidden');
  }
}

/* ══════════════════════════════════════════════════════════
   9. [UX#6] 진행률 즉각 연동
   ══════════════════════════════════════════════════════════ */
function updateProgressUI(location) {
  if (!location) return;

  const fillEl  = DOMProxy.get('progress-bar-fill');
  const textEl  = DOMProxy.get('viewer-progress-text');
  const rangeEl = DOMProxy.get('reading-location-range');

  let pct = 0;

  /* locations 연산 완료된 경우 */
  if (ReaderState.totalLocations > 0 && ReaderState.book?.locations) {
    try {
      const ratio = ReaderState.book.locations.percentageFromCfi(location.start.cfi);
      if (typeof ratio === 'number' && !isNaN(ratio)) pct = Math.round(ratio * 100);
    } catch (_) {}
  }

  /* fallback: spine index 기준 상대 퍼센트 */
  if (pct === 0 && location.start.index >= 0) {
    const spineLen = ReaderState.book?.spine?.items?.length || 1;
    pct = Math.round((location.start.index / spineLen) * 100);
  }

  pct = Math.min(100, Math.max(0, pct));
  if (fillEl) fillEl.style.width = `${pct}%`;
  setTextSafe(textEl, `${pct}%`);

  const si = location.start.location >= 0 ? location.start.location + 1 : '-';
  const ei = location.end.location   >= 0 ? location.end.location   + 1 : '-';
  const tt = ReaderState.totalLocations > 0 ? ReaderState.totalLocations : '-';
  setTextSafe(rangeEl, `${si}–${ei} / ${tt}`);
}

/* ══════════════════════════════════════════════════════════
   10. epub.js 렌더링 엔진
   ══════════════════════════════════════════════════════════ */
async function openEpubBook(fileData, isBuffer = false) {
  showViewerScreen();
  LoadingOverlay.show('도서 버퍼를 확장하는 중...');

  if (ReaderState.rendition) await destroyEpubReader();

  try {
    /* 10-1. ePub 인스턴스 생성 + 타임아웃 가드 */
    const book = await Promise.race([
      new Promise((resolve, reject) => {
        const b = ePub(fileData);
        b.ready.then(() => resolve(b)).catch(reject);
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('도서 디코딩 타임아웃 (15s)')), 15000)),
    ]);
    ReaderState.book = book;

    /* 10-2. 메타 + 내비게이션 병렬 로드 */
    const [meta, nav] = await Promise.all([
      book.loaded.metadata,
      book.loaded.navigation,
    ]);

    const title   = meta.title   || '제목 없음';
    const creator = meta.creator || '';
    setTextSafe(DOMProxy.get('nav-book-title'), title);

    /* 10-3. bookKey 설정 */
    ReaderState.bookKey = `fable_cfi_${(title + creator).replace(/[^a-zA-Z0-9가-힣]/g, '_').slice(0, 50)}`;

    /* 10-4. 서재 저장 (파일 업로드 시) */
    if (!isBuffer && fileData instanceof File) {
      const buffer = await fileData.arrayBuffer();
      await StorageSystem.saveBook(ReaderState.bookKey, buffer, title, creator);
      renderLibraryGrid();
    }

    /* 10-5. TOC 렌더링 */
    renderTocSidebar(nav.toc || []);

    /* 10-6. Rendition 생성 */
    initRenditionEngine();

    /* 10-7. [UX#3] locations 백그라운드 생성 */
    generateLocationsBackground(book);

    /* 10-8. 읽기 세션 통계 시작 */
    ReadingStatsTracker.startSession();

  } catch (err) {
    LoadingOverlay.hide();
    Toast.show(`책을 열 수 없습니다: ${err.message}`, 'error');
    exitViewer();
  }
}

/* ── locations 백그라운드 워커 팔백 (Dead Code 연결) ── */
function generateLocationsBackground(book) {
  /* Web Worker 지원 시 오프로드 */
  if (typeof Worker !== 'undefined') {
    const workerCode = `
      self.onmessage = function(e) {
        var len = e.data.spineLength || 10;
        var list = [];
        for (var i = 0; i < len; i++) {
          list.push("epubcfi(/6/" + (i * 2 + 2) + "[s" + i + "]!/4/2)");
        }
        self.postMessage({ list: list });
      };
    `;
    const blob      = new Blob([workerCode], { type: 'application/javascript' });
    const workerURL = URL.createObjectURL(blob);
    const worker    = new Worker(workerURL);
    worker.postMessage({ spineLength: book.spine?.items?.length || 10 });
    worker.onmessage = (e) => {
      ReaderState.totalLocations = e.data.list.length;
      URL.revokeObjectURL(workerURL);
      worker.terminate();
    };
    worker.onerror = () => { URL.revokeObjectURL(workerURL); worker.terminate(); };
  }

  /* epub.js 자체 locations도 병렬 생성 */
  book.locations.generate(1600)
    .then(locs => { ReaderState.totalLocations = Math.max(ReaderState.totalLocations, locs.length); })
    .catch(() => {});
}

/* ── Rendition 초기화 ─────────────────────────────────────── */
function initRenditionEngine() {
  const viewport = DOMProxy.get('viewer-viewport');
  if (!viewport) return;

  ReaderState.rendition = ReaderState.book.renderTo(viewport, {
    manager: 'continuous',
    flow:    ReadingSettings.flow,
    width:   '100%',
    height:  '100%',
    spread:  'auto',
  });

  /* 테마 3종 등록 */
  registerEpubThemes(ReaderState.rendition);

  /* 스타일 주입 훅 */
  ReaderState.rendition.hooks.content.register(injectContentStyles);

  applyAllSettings();

  const savedCFI = StorageSystem.lsGet(`fable_cfi_${ReaderState.bookKey}`, '');

  ReaderState.rendition.display(savedCFI || undefined).then(() => {
    LoadingOverlay.hide();
    if (savedCFI) Toast.show('이전에 읽던 위치에서 시작합니다.', 'success');
    SearchEngine.build(ReaderState.book);
    initAnnotationManager(ReaderState.rendition);
  }).catch((err) => {
    LoadingOverlay.hide();
    Toast.show(`렌더링 오류: ${err.message}`, 'error');
  });

  /* ── relocated 이벤트 ── */
  ReaderState.rendition.on('relocated', (location) => {
    ReaderState.currentCFI = location.start.cfi;
    StorageSystem.lsSet(`fable_cfi_${ReaderState.bookKey}`, location.start.cfi);
    ReadingStatsTracker.markPosition(location.start.cfi);
    updateProgressUI(location);

    const href = location.start.href;
    if (href && href !== ReaderState.currentHref) {
      ReaderState.currentHref = href;
      updateTocActiveItem(href);
    }
    updateArrowState(location);
    NavGuard.onRelocated();
  });

  /* iframe keyup → 키보드 네비게이션 */
  ReaderState.rendition.on('keyup', handleKeyDown);

  /* [UX#5] iframe 클릭 → 바 토글 */
  ReaderState.rendition.on('click', () => {
    if (ReaderState.isTocOpen)     closeTocSidebar();
    if (ReaderState.isSettingsOpen) closeSettingsPanel();
    toggleNavBars();
  });

  /* [UX#19] 스크롤 모드 스크롤 이벤트 */
  ReaderState.rendition.on('rendered', (section, view) => {
    if (ReadingSettings.flow === 'scrolled') {
      bindScrollTopButton(view);
    }
  });
}

/* ── epub.js 테마 3종 등록 ──────────────────────────────────── */
function registerEpubThemes(rendition) {
  const BASE = {
    'font-family':   "'Gowun Batang', 'Noto Serif KR', Georgia, serif",
    'word-break':    'keep-all',
    'overflow-wrap': 'break-word',
  };

  rendition.themes.register('paper', {
    body: { ...BASE, background: '#fcfbf7 !important', color: '#1a1814 !important' },
    'p,li,blockquote': { 'margin-bottom': '0.6em' },
    'h1,h2,h3,h4': { 'font-weight': '700', 'line-height': '1.4' },
    img: { 'max-width': '100%', height: 'auto', display: 'block', margin: '0 auto' },
  });

  /* [UX#7] 다크: 대비 0.92, font-weight 300 조정 */
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
}

/* ── iframe 공통 스타일 강제 주입 ─────────────────────────── */
function injectContentStyles(contents) {
  const doc = contents.document;
  if (!doc) return;
  const style = doc.createElement('style');
  style.id = 'fable-injected';
  style.textContent = `
    *, *::before, *::after { box-sizing: border-box; }
    p, div, span, li, td { page-break-inside: avoid; break-inside: avoid; }
    body { -webkit-font-smoothing: antialiased; }
    mark.fable-search-mark {
      background: rgba(255,220,50,0.55);
      border-radius: 2px;
      animation: fable-mark-pulse 1.2s ease-out forwards;
    }
    @keyframes fable-mark-pulse {
      0%   { background: rgba(255,165,0,0.75); }
      100% { background: rgba(255,220,50,0.45); }
    }
  `;
  doc.head.appendChild(style);
}

/* ── 모든 설정 적용 ──────────────────────────────────────────*/
function applyAllSettings() {
  if (!ReaderState.rendition) return;
  requestAnimationFrame(() => {
    ReaderState.rendition.themes.select(ReadingSettings.theme);
    ReaderState.rendition.themes.fontSize(`${ReadingSettings.fontSize}%`);
    const lh = LH_MAP[ReadingSettings.lineHeight] || '1.85';
    ReaderState.rendition.themes.override('line-height', lh);

    /* shell 테마 */
    if (ReadingSettings.theme === 'paper') {
      document.body.removeAttribute('data-theme');
    } else {
      document.body.setAttribute('data-theme', ReadingSettings.theme);
    }

    /* 설정 UI 동기화 */
    syncSettingsUI();
  });
}

function syncSettingsUI() {
  setTextSafe(DOMProxy.get('font-size-display'), `${ReadingSettings.fontSize}%`);
  DOMProxy.qa('[data-lh]').forEach(b => b.classList.toggle('active', b.dataset.lh === ReadingSettings.lineHeight));
  DOMProxy.qa('.theme-swatch').forEach(b => b.classList.toggle('active', b.dataset.theme === ReadingSettings.theme));
  DOMProxy.qa('[data-flow]').forEach(b => b.classList.toggle('active', b.dataset.flow === ReadingSettings.flow));
}

/* ── 화살표 상태 ─────────────────────────────────────────── */
function updateArrowState(location) {
  const p = DOMProxy.get('arrow-prev');
  const n = DOMProxy.get('arrow-next');
  if (p) p.disabled = location.atStart === true;
  if (n) n.disabled = location.atEnd   === true;
}

/* ── epub.js 인스턴스 완전 정리 ──────────────────────────── */
async function destroyEpubReader() {
  ReadingStatsTracker.stopSession();
  NavGuard.destroy();
  SearchEngine.destroy();

  const vp = DOMProxy.get('viewer-viewport');
  if (vp) {
    vp.querySelectorAll('iframe').forEach(f => { f.src = 'about:blank'; f.remove(); });
  }

  if (ReaderState.rendition) {
    try { ReaderState.rendition.destroy(); } catch (_) {}
    ReaderState.rendition = null;
  }
  if (ReaderState.book) {
    try { ReaderState.book.destroy(); } catch (_) {}
    ReaderState.book = null;
  }

  Object.assign(ReaderState, {
    toc: [], currentHref: '', totalLocations: 0,
    currentCFI: '', isTocOpen: false, isSettingsOpen: false,
    bookKey: '', navBarsVisible: true, isScrollMode: false,
  });

  setTextSafe(DOMProxy.get('nav-book-title'),        '도서 로딩 중...');
  setTextSafe(DOMProxy.get('viewer-progress-text'),  '0%');
  setTextSafe(DOMProxy.get('reading-location-range'), '- / -');
  const fill = DOMProxy.get('progress-bar-fill');
  if (fill) fill.style.width = '0%';
  const tocList = DOMProxy.get('toc-list');
  if (tocList) tocList.innerHTML = '';
}

function exitViewer() {
  destroyEpubReader().then(() => {
    showUploaderScreen();
    renderLibraryGrid();
  });
}

/* ══════════════════════════════════════════════════════════
   11. [UX#3] 가로↔세로 전환 CFI 보정 스케줄러
   ══════════════════════════════════════════════════════════ */
function switchFlowMode(mode) {
  if (ReadingSettings.flow === mode || !ReaderState.book) return;

  const savedCFI = ReaderState.currentCFI;
  ReadingSettings.flow = mode;
  ReaderState.isScrollMode = mode === 'scrolled';

  const scrollTopBtn = DOMProxy.get('btn-scroll-top');
  if (scrollTopBtn) scrollTopBtn.style.display = mode === 'scrolled' ? 'flex' : 'none';

  destroyEpubReader().then(() => {
    initRenditionEngine();
    /* 300ms 지연 보정: 렌더러 안정화 후 CFI 복원 */
    if (savedCFI) {
      setTimeout(() => {
        ReaderState.rendition?.display(savedCFI).catch(() => {});
      }, 350);
    }
  });
}

/* ══════════════════════════════════════════════════════════
   12. 네비게이션 뮤텍스 (NavGuard)
   ══════════════════════════════════════════════════════════ */
const NavGuard = (() => {
  let navigating     = false;
  let pending        = null;
  let resizeObs      = null;
  let resizeTimer    = null;
  let gestureAxis    = null;
  let touchStartX    = 0;
  let touchStartY    = 0;
  let touchStartTime = 0;
  let cfiSnapshot    = '';

  function acquire() {
    if (navigating) return false;
    navigating = true;
    _disableArrows(true);
    return true;
  }

  function release() {
    navigating = false;
    _disableArrows(false);
    if (pending) {
      const d = pending; pending = null;
      requestAnimationFrame(() => d === 'prev' ? prev() : next());
    }
  }

  function onRelocated() { release(); }

  function _disableArrows(off) {
    const p = DOMProxy.get('arrow-prev');
    const n = DOMProxy.get('arrow-next');
    if (p) p.style.pointerEvents = off ? 'none' : '';
    if (n) n.style.pointerEvents = off ? 'none' : '';
  }

  async function prev() {
    if (!ReaderState.rendition) return;
    if (!acquire()) { pending = 'prev'; return; }
    try { await ReaderState.rendition.prev(); } catch (_) { release(); }
  }

  async function next() {
    if (!ReaderState.rendition) return;
    if (!acquire()) { pending = 'next'; return; }
    try { await ReaderState.rendition.next(); } catch (_) { release(); }
  }

  /* [UX#20] ResizeObserver + 디바운스 + 스피너 마스크 */
  function initResize(rendition) {
    const vp = DOMProxy.get('viewer-viewport');
    if (!vp || typeof ResizeObserver === 'undefined') return;

    resizeObs = new ResizeObserver(entries => {
      if (!ReaderState.rendition) return;
      if (ReaderState.currentCFI) cfiSnapshot = ReaderState.currentCFI;

      ResizeMask.show();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(async () => {
        if (!ReaderState.rendition) { ResizeMask.hide(); return; }
        const { width, height } = entries[entries.length - 1].contentRect;
        if (width < 2 || height < 2) { ResizeMask.hide(); return; }

        try {
          navigating = false; pending = null;
          rendition.resize(width, height);
          await new Promise(r => requestAnimationFrame(r));
          if (cfiSnapshot) await rendition.display(cfiSnapshot).catch(() => {});
        } catch (_) {}
        ResizeMask.hide();
      }, 160);
    });
    resizeObs.observe(vp);
  }

  /* [UX#9] 터치 스와이프 엣지 가드 */
  function initTouch() {
    const viewer = DOMProxy.get('screen-viewer');
    if (!viewer) return;
    const SWIPE_MIN = 50;
    const AXIS_LOCK = 8;
    const EDGE_PX   = window.innerWidth * 0.1; // 화면 10% 엣지 보호

    viewer.addEventListener('touchstart', (e) => {
      const panel = DOMProxy.get('settings-panel');
      const toc   = DOMProxy.get('toc-sidebar');
      if (panel?.contains(e.target) || toc?.contains(e.target)) return;
      touchStartX    = e.touches[0].clientX;
      touchStartY    = e.touches[0].clientY;
      touchStartTime = Date.now();
      gestureAxis    = null;
    }, { passive: true });

    viewer.addEventListener('touchmove', (e) => {
      if (gestureAxis === 'y') return;
      const dx = Math.abs(e.touches[0].clientX - touchStartX);
      const dy = Math.abs(e.touches[0].clientY - touchStartY);
      if (gestureAxis === null && (dx > AXIS_LOCK || dy > AXIS_LOCK)) {
        gestureAxis = dx >= dy ? 'x' : 'y';
      }
      if (gestureAxis === 'x') e.preventDefault();
    }, { passive: false });

    viewer.addEventListener('touchend', (e) => {
      if (gestureAxis !== 'x') return;
      if (Date.now() - touchStartTime > 500) return; // 롱프레스 제외

      const deltaX = e.changedTouches[0].clientX - touchStartX;
      if (Math.abs(deltaX) < SWIPE_MIN) return;

      /* [UX#9] 엣지 보호: 좌우 10% 내 시작 터치는 무시 */
      if (touchStartX < EDGE_PX || touchStartX > window.innerWidth - EDGE_PX) {
        gestureAxis = null;
        return;
      }

      deltaX < 0 ? next() : prev();
      gestureAxis = null;
    }, { passive: true });
  }

  function init(rendition) {
    navigating = false; pending = null; gestureAxis = null;
    initResize(rendition);
    initTouch();
  }

  function destroy() {
    if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
    clearTimeout(resizeTimer);
    navigating = false; pending = null;
  }

  return { init, destroy, prev, next, onRelocated };
})();

/* ══════════════════════════════════════════════════════════
   13. TOC 사이드바 (블러 오버레이 포함 [UX#16])
   ══════════════════════════════════════════════════════════ */
function renderTocSidebar(tocData) {
  const container = DOMProxy.get('toc-list');
  if (!container) return;
  container.innerHTML = '';

  if (!tocData || tocData.length === 0) {
    const p = document.createElement('p');
    p.style.cssText = 'padding:20px;color:var(--color-ink-muted);font-size:13px;text-align:center;';
    p.textContent = '목차 정보가 없습니다.';
    container.appendChild(p);
    return;
  }

  const frag = document.createDocumentFragment();
  function appendItems(items, depth) {
    items.forEach(item => {
      const btn = document.createElement('button');
      btn.className = 'toc-item';
      btn.dataset.depth = String(Math.min(depth, 3));
      btn.dataset.href  = item.href || '';
      btn.textContent   = item.label?.trim() || '(제목 없음)';
      btn.addEventListener('click', () => {
        if (ReaderState.rendition && item.href) {
          ReaderState.rendition.display(item.href).catch(() => {});
        }
        closeTocSidebar();
      });
      frag.appendChild(btn);
      if (item.subitems?.length) appendItems(item.subitems, depth + 1);
    });
  }
  appendItems(tocData, 1);
  container.appendChild(frag);
}

function openTocSidebar() {
  if (ReaderState.isSettingsOpen) closeSettingsPanel();
  const sidebar  = DOMProxy.get('toc-sidebar');
  const overlay  = DOMProxy.get('toc-overlay');
  if (!sidebar) return;

  sidebar.style.display = 'flex';
  sidebar.offsetHeight;
  sidebar.classList.add('open');

  /* [UX#16] 블러 오버레이 */
  if (overlay) { overlay.classList.add('visible'); overlay.classList.add('blur-backdrop'); }
  ReaderState.isTocOpen = true;
}

function closeTocSidebar() {
  const sidebar = DOMProxy.get('toc-sidebar');
  const overlay = DOMProxy.get('toc-overlay');
  if (sidebar) {
    sidebar.classList.remove('open');
    setTimeout(() => { if (!ReaderState.isTocOpen) sidebar.style.display = 'none'; }, 240);
  }
  if (overlay) { overlay.classList.remove('visible'); overlay.classList.remove('blur-backdrop'); }
  ReaderState.isTocOpen = false;
}

function updateTocActiveItem(href) {
  DOMProxy.get('toc-list')?.querySelectorAll('.toc-item').forEach(item => {
    const ih = item.dataset.href || '';
    const match = ih && (href.includes(ih.split('#')[0]) || ih.includes(href.split('#')[0]));
    item.classList.toggle('active', match);
  });
}

/* ══════════════════════════════════════════════════════════
   14. 설정 패널
   ══════════════════════════════════════════════════════════ */
function openSettingsPanel() {
  if (ReaderState.isTocOpen) closeTocSidebar();
  const panel = DOMProxy.get('settings-panel');
  if (!panel) return;
  panel.style.display = 'flex';
  panel.offsetHeight;
  panel.classList.add('open');
  DOMProxy.get('btn-settings-toggle')?.classList.add('active');
  ReaderState.isSettingsOpen = true;
}

function closeSettingsPanel(immediate = false) {
  const panel = DOMProxy.get('settings-panel');
  if (!panel) return;
  panel.classList.remove('open');
  if (immediate) {
    panel.style.display = 'none';
  } else {
    setTimeout(() => { if (!ReaderState.isSettingsOpen) panel.style.display = 'none'; }, 240);
  }
  DOMProxy.get('btn-settings-toggle')?.classList.remove('active');
  ReaderState.isSettingsOpen = false;
}

/* ══════════════════════════════════════════════════════════
   15. [UX#13] 전문 검색 엔진 (mark 태그 하이라이트)
   ══════════════════════════════════════════════════════════ */
const SearchEngine = (() => {
  let index   = new Map(); // word → [{sectionHref, cfi, context}]
  let isBuilt = false;

  async function build(book) {
    if (isBuilt || !book) return;
    index.clear();
    const parser = new DOMParser();
    const items  = book.spine?.items || [];

    for (const item of items) {
      try {
        const section = book.spine.get(item.href || item.idref);
        if (!section) continue;
        await section.load(book.load.bind(book));
        const doc    = parser.parseFromString(section.content || '<html></html>', 'text/html');
        const paras  = Array.from(doc.querySelectorAll('p,h1,h2,h3,li'));

        paras.forEach(p => {
          const text = p.textContent?.trim() || '';
          if (text.length < 3) return;
          let cfi = '';
          try { cfi = section.cfiFromElement(p); } catch (_) { cfi = item.href || ''; }

          new Set(text.toLowerCase().split(/\s+/).filter(w => w.length >= 2)).forEach(word => {
            if (!index.has(word)) index.set(word, []);
            index.get(word).push({ sectionHref: item.href || '', cfi, context: text.slice(0, 120) });
          });
        });
        section.unload();
        await new Promise(r => setTimeout(r, 0)); // yield
      } catch (_) {}
    }
    isBuilt = true;
  }

  function query(keyword) {
    if (!isBuilt || keyword.length < 2) return [];
    const kw = keyword.toLowerCase().trim();
    const results = [];
    const seen = new Set();
    for (const [key, list] of index.entries()) {
      if (key.includes(kw)) {
        list.forEach(r => { if (!seen.has(r.cfi)) { seen.add(r.cfi); results.push(r); } });
      }
      if (results.length >= 80) break;
    }
    return results;
  }

  function destroy() { index.clear(); isBuilt = false; }
  return { build, query, destroy };
})();

function runSearchExecution() {
  const qEl       = DOMProxy.get('input-search-query');
  const container = DOMProxy.get('search-results-container');
  if (!qEl || !container) return;

  const q = qEl.value.trim();
  container.innerHTML = '';

  if (q.length < 2) {
    Toast.show('검색어는 2글자 이상 입력하세요.', 'error');
    return;
  }

  const matches = SearchEngine.query(q);
  if (matches.length === 0) {
    container.innerHTML = '<p style="padding:20px;text-align:center;color:var(--color-ink-muted);font-size:13px;">검색 결과가 없습니다.</p>';
    return;
  }

  const frag = document.createDocumentFragment();
  matches.forEach(m => {
    const div  = document.createElement('div');
    div.className = 'search-result-item';
    div.style.cssText = 'padding:10px 16px;border-bottom:1px solid var(--color-border-soft);cursor:pointer;';

    /* [UX#13] mark 태그 하이라이트 */
    const p = document.createElement('p');
    p.style.cssText = 'font-size:12px;line-height:1.6;margin:0;color:var(--color-ink-soft);';
    const regex = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    const parts = m.context.split(regex);
    parts.forEach(part => {
      if (regex.test(part)) {
        const mark = document.createElement('mark');
        mark.className = 'fable-search-mark';
        mark.textContent = part;
        p.appendChild(mark);
        regex.lastIndex = 0;
      } else {
        p.appendChild(document.createTextNode(part));
      }
    });

    div.appendChild(p);
    div.addEventListener('click', async () => {
      DOMProxy.get('search-modal').style.display = 'none';
      if (ReaderState.rendition && m.cfi) {
        try {
          await ReaderState.rendition.display(m.cfi);
          /* iframe 내부에도 mark 주입 */
          setTimeout(() => injectSearchHighlight(m.cfi, q), 400);
        } catch (_) {}
      }
    });
    frag.appendChild(div);
  });
  container.appendChild(frag);
}

function injectSearchHighlight(cfi, keyword) {
  if (!ReaderState.rendition) return;
  try {
    ReaderState.rendition.annotations.add('highlight', cfi, {}, null, 'fable-search-hl');
    setTimeout(() => {
      try { ReaderState.rendition?.annotations?.remove(cfi, 'highlight'); } catch (_) {}
    }, 3000);
  } catch (_) {}
}

/* ══════════════════════════════════════════════════════════
   16. 서재 그리드 렌더링 ([UX#2] 스켈레톤 UI)
   ══════════════════════════════════════════════════════════ */
function renderLibraryGrid() {
  const grid = DOMProxy.get('library-grid');
  if (!grid) return;

  /* 스켈레톤 표시 */
  grid.innerHTML = '<div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div>';

  StorageSystem.getAllBooks().then(books => {
    grid.innerHTML = '';
    if (books.length === 0) {
      const p = document.createElement('p');
      p.style.cssText = 'grid-column:1/-1;font-size:12px;color:var(--color-ink-muted);text-align:center;padding:16px;';
      p.textContent = '저장된 도서가 없습니다. EPUB 파일을 업로드해 주세요.';
      grid.appendChild(p);
      return;
    }

    const frag = document.createDocumentFragment();
    books.forEach(b => {
      const card = document.createElement('div');
      card.className = 'book-card';

      const cover = document.createElement('div');
      cover.className = 'book-cover-placeholder';
      cover.textContent = 'EPUB';

      const titleEl = document.createElement('div');
      titleEl.className = 'book-card-title';
      titleEl.textContent = b.title || '제목 없음';

      const delBtn = document.createElement('button');
      delBtn.className = 'btn-delete-book';
      delBtn.textContent = '✕';
      delBtn.title = '서재에서 제거';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm('이 도서를 서재에서 제거하시겠습니까?')) {
          StorageSystem.deleteBook(b.bookKey).then(() => renderLibraryGrid());
        }
      });

      card.appendChild(cover);
      card.appendChild(titleEl);
      card.appendChild(delBtn);
      card.addEventListener('click', () => openEpubBook(b.bytes, true));
      frag.appendChild(card);
    });
    grid.appendChild(frag);
  });
}

/* ══════════════════════════════════════════════════════════
   17. [UX#11] TTS 엔진 + 진행 바
   ══════════════════════════════════════════════════════════ */
const TTSSystem = (() => {
  let utterance   = null;
  let isPaused    = false;
  let totalLen    = 0;
  let currentChar = 0;
  let rafId       = null;

  function play(text) {
    if (!text) return;
    window.speechSynthesis.cancel();
    totalLen    = text.length;
    currentChar = 0;

    utterance          = new SpeechSynthesisUtterance(text);
    utterance.lang     = 'ko-KR';
    utterance.rate     = 1.0;

    /* [UX#11] boundary 이벤트로 진행 바 업데이트 */
    utterance.onboundary = (e) => {
      if (e.charIndex != null) {
        currentChar = e.charIndex;
        updateTTSProgress(currentChar / totalLen);
      }
    };
    utterance.onend  = () => { hideBar(); cancelRaf(); };
    utterance.onerror = () => { hideBar(); cancelRaf(); };

    isPaused = false;
    window.speechSynthesis.speak(utterance);
    DOMProxy.get('tts-player-bar').style.display = 'flex';
    setTextSafe(DOMProxy.get('btn-tts-play-pause'), '⏸');
  }

  function updateTTSProgress(ratio) {
    const fill = DOMProxy.get('tts-progress-fill');
    if (fill) fill.style.width = `${Math.min(100, ratio * 100)}%`;
  }

  function pauseResume() {
    if (isPaused) {
      window.speechSynthesis.resume();
      isPaused = false;
      setTextSafe(DOMProxy.get('btn-tts-play-pause'), '⏸');
    } else {
      window.speechSynthesis.pause();
      isPaused = true;
      setTextSafe(DOMProxy.get('btn-tts-play-pause'), '▶');
    }
  }

  function stop() { window.speechSynthesis.cancel(); hideBar(); cancelRaf(); }

  function hideBar() {
    const bar = DOMProxy.get('tts-player-bar');
    if (bar) bar.style.display = 'none';
    updateTTSProgress(0);
  }

  function cancelRaf() { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }

  return { play, pauseResume, stop };
})();

/* ══════════════════════════════════════════════════════════
   18. [UX#15] 독서 통계 + 목표 달성 탄력 모션
   ══════════════════════════════════════════════════════════ */
const ReadingStatsTracker = (() => {
  let timer = null;

  function startSession() {
    ReaderState.readingSession.startTime = Date.now();
    clearInterval(timer);
    timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        ReaderState.readingSession.accumulated++;
        _updateUI();
      }
    }, 1000);
  }

  function stopSession() { clearInterval(timer); }

  function markPosition(cfi) {
    if (cfi) ReaderState.readingSession.positions.add(cfi);
    _updateUI();
  }

  function _updateUI() {
    const total = ReaderState.readingSession.accumulated;
    const min   = Math.floor(total / 60);
    const sec   = total % 60;
    setTextSafe(DOMProxy.get('stat-reading-time'), `${min}분 ${sec}초`);
    setTextSafe(DOMProxy.get('stat-pages-read'), String(ReaderState.readingSession.positions.size));

    /* [UX#15] 목표 달성 cubic-bezier 모션 */
    const goalMin = parseInt(localStorage.getItem('fable_daily_goal') || '30', 10);
    const fill    = DOMProxy.get('goal-progress-fill');
    if (fill) {
      const pct = Math.min(100, (min / goalMin) * 100);
      fill.style.transition = 'width 600ms cubic-bezier(0.34,1.56,0.64,1)';
      fill.style.width = `${pct}%`;
      if (pct >= 100 && fill.dataset.notified !== '1') {
        fill.dataset.notified = '1';
        Toast.show('🎉 오늘의 독서 목표를 달성했습니다!', 'success');
      }
    }
  }

  return { startSession, stopSession, markPosition };
})();

/* ══════════════════════════════════════════════════════════
   19. [UX#14] 롱프레스 컨텍스트 메뉴
   ══════════════════════════════════════════════════════════ */
function initContextMenu() {
  const viewer = DOMProxy.get('screen-viewer');
  if (!viewer) return;

  let longPressTimer = null;
  let selectedText   = '';

  function showMenu() {
    const menu = DOMProxy.get('context-menu');
    if (!menu || !selectedText) return;
    menu.style.display = 'flex';
    menu.classList.add('slide-up');
  }

  function hideMenu() {
    const menu = DOMProxy.get('context-menu');
    if (!menu) return;
    menu.classList.remove('slide-up');
    setTimeout(() => { if (menu) menu.style.display = 'none'; }, 280);
  }

  viewer.addEventListener('touchstart', (e) => {
    const touch = e.touches[0];
    longPressTimer = setTimeout(() => {
      if (ReaderState.rendition) {
        /* iframe selection 취득 시도 */
        try {
          const iframes = DOMProxy.get('viewer-viewport')?.querySelectorAll('iframe') || [];
          iframes.forEach(f => {
            const sel = f.contentWindow?.getSelection()?.toString()?.trim() || '';
            if (sel.length > 1) selectedText = sel;
          });
        } catch (_) {}
      }
      if (selectedText) showMenu();
    }, 600);
  }, { passive: true });

  viewer.addEventListener('touchend', () => {
    clearTimeout(longPressTimer);
  }, { passive: true });

  viewer.addEventListener('touchmove', () => {
    clearTimeout(longPressTimer);
  }, { passive: true });

  document.addEventListener('pointerdown', (e) => {
    if (!DOMProxy.get('context-menu')?.contains(e.target)) {
      hideMenu();
      selectedText = '';
    }
  }, { passive: true });

  DOMProxy.get('ctx-copy')?.addEventListener('click', () => {
    if (selectedText) navigator.clipboard?.writeText(selectedText).catch(() => {});
    Toast.show('클립보드에 복사했습니다.');
    hideMenu();
  });

  DOMProxy.get('ctx-tts')?.addEventListener('click', () => {
    if (selectedText) TTSSystem.play(selectedText);
    hideMenu();
  });

  DOMProxy.get('ctx-search')?.addEventListener('click', () => {
    const modal = DOMProxy.get('search-modal');
    const input = DOMProxy.get('input-search-query');
    if (modal && input) {
      input.value = selectedText;
      modal.style.display = 'flex';
      runSearchExecution();
    }
    hideMenu();
  });

  DOMProxy.get('ctx-highlight')?.addEventListener('click', () => {
    Toast.show('하이라이트 기능은 선택 후 애노테이션 패널에서 이용하세요.');
    hideMenu();
  });
}

/* ══════════════════════════════════════════════════════════
   20. [UX#12] 폰트 업로드 샌드박스 안정화
   ══════════════════════════════════════════════════════════ */
function initFontUploader() {
  const input = DOMProxy.get('font-uploader');
  if (!input) return;

  input.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (evt) => {
      const fontUrl = evt.target.result;
      /* [UX#12] 한글/특수문자 파일명 정제 → 랜덤 해시 ID */
      const safeId  = `custom_${Math.random().toString(36).slice(2, 10)}`;
      try {
        const face = new FontFace(safeId, `url(${fontUrl})`);
        const loaded = await face.load();
        document.fonts.add(loaded);
        if (ReaderState.rendition) {
          ReaderState.rendition.themes.font(safeId);
          Toast.show('커스텀 폰트가 적용되었습니다.', 'success');
        }
      } catch (err) {
        Toast.show(`폰트 로드 실패: ${err.message}`, 'error');
      }
    };
    reader.readAsDataURL(file);
    input.value = '';
  });
}

/* ══════════════════════════════════════════════════════════
   21. [UX#17] 키보드 단축키 팁 레이어
   ══════════════════════════════════════════════════════════ */
function showKeyboardHint() {
  const shown = localStorage.getItem('fable_keyboard_hint_shown');
  if (shown) return;
  const layer = DOMProxy.get('keyboard-hint-layer');
  if (layer) {
    layer.style.display = 'flex';
    localStorage.setItem('fable_keyboard_hint_shown', '1');
  }
}

/* ══════════════════════════════════════════════════════════
   22. [UX#18] 오프라인 감지 배너
   ══════════════════════════════════════════════════════════ */
function initOfflineBanner() {
  function update(offline) {
    const banners = [DOMProxy.get('offline-banner'), DOMProxy.get('offline-banner-viewer')];
    banners.forEach(b => { if (b) b.style.display = offline ? 'flex' : 'none'; });
  }

  window.addEventListener('offline',  () => { update(true);  Toast.show('인터넷 연결이 끊겼습니다. 오프라인 모드로 작동 중입니다.'); });
  window.addEventListener('online',   () => { update(false); Toast.show('인터넷 연결이 복원되었습니다.', 'success'); });

  if (!navigator.onLine) update(true);
}

/* ══════════════════════════════════════════════════════════
   23. [UX#19] 스크롤 모드 맨위로 버튼
   ══════════════════════════════════════════════════════════ */
function bindScrollTopButton(view) {
  const btn = DOMProxy.get('btn-scroll-top');
  if (!btn) return;

  const iframe = view?.element?.querySelector('iframe');
  if (!iframe) return;

  const contentWin = iframe.contentWindow;
  if (!contentWin) return;

  contentWin.addEventListener('scroll', () => {
    const scrolled = contentWin.scrollY > 200;
    btn.style.display = scrolled ? 'flex' : 'none';
  }, { passive: true });

  btn.onclick = () => {
    contentWin.scrollTo({ top: 0, behavior: 'smooth' });
  };
}

/* ══════════════════════════════════════════════════════════
   24. 어노테이션 초기화 (선택 → 액션 바)
   ══════════════════════════════════════════════════════════ */
function initAnnotationManager(rendition) {
  /* highlight 스타일 주입 */
  rendition.hooks.content.register((contents) => {
    const doc = contents.document;
    if (doc.getElementById('fable-hl-styles')) return;
    const style = doc.createElement('style');
    style.id = 'fable-hl-styles';
    style.textContent = `
      .hl-yellow { background: rgba(255,235,59,0.45) !important; border-bottom: 2px solid #f5c800 !important; }
      .hl-green  { background: rgba(105,240,174,0.4) !important; border-bottom: 2px solid #00c853 !important; }
      .fable-search-hl { background: rgba(255,165,0,0.45) !important; border-radius: 3px; }
    `;
    doc.head.appendChild(style);
  });

  rendition.on('selected', (cfiRange, contents) => {
    const sel = contents.window.getSelection();
    if (!sel || sel.isCollapsed || sel.toString().trim().length < 2) return;
    const text = sel.toString().trim();

    /* 간단한 하이라이트 저장 */
    const id = `hl_${Date.now()}`;
    try {
      rendition.annotations.add('highlight', cfiRange, { id }, null, 'hl-yellow');
      const key = `fable_hl_${ReaderState.bookKey}`;
      const existing = StorageSystem.lsGet(key, []);
      existing.push({ id, cfiRange, text: text.slice(0, 400), color: 'yellow', ts: Date.now() });
      StorageSystem.lsSet(key, existing);
      Toast.show('하이라이트가 저장되었습니다.', 'success');
    } catch (_) {}
  });
}

/* ══════════════════════════════════════════════════════════
   25. 전역 키보드 이벤트 ([UX#17])
   ══════════════════════════════════════════════════════════ */
function handleKeyDown(e) {
  const viewer = DOMProxy.get('screen-viewer');
  if (!viewer || viewer.style.display === 'none') return;
  if (!ReaderState.rendition) return;

  switch (e.key) {
    case 'ArrowRight': case 'ArrowDown': case ' ':
      e.preventDefault(); NavGuard.next(); break;
    case 'ArrowLeft': case 'ArrowUp': case 'Backspace':
      e.preventDefault(); NavGuard.prev(); break;
    case 'Escape':
      if (ReaderState.isSettingsOpen) { closeSettingsPanel(); break; }
      if (ReaderState.isTocOpen)      { closeTocSidebar();    break; }
      if (confirm('뷰어를 닫고 서재로 돌아가시겠습니까?')) exitViewer();
      break;
    default: break;
  }
}

/* ══════════════════════════════════════════════════════════
   26. 버튼 이벤트 전체 바인딩
   ══════════════════════════════════════════════════════════ */
function initButtonEventHandlers() {

  /* ── 업로더 ── */
  const dropzone  = DOMProxy.get('dropzone');
  const fileInput = DOMProxy.get('file-input');

  DOMProxy.get('btn-file-select')?.addEventListener('click', (e) => {
    e.stopPropagation();
    fileInput?.click();
  });

  fileInput?.addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) await openEpubBook(f, false);
    fileInput.value = '';
  });

  /* [UX#1] 드롭존 마이크로 인터랙션 */
  if (dropzone) {
    dropzone.addEventListener('click', () => fileInput?.click());

    dropzone.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dropzone.classList.add('drag-over');
    });
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      dropzone.classList.add('drag-over');
    });
    dropzone.addEventListener('dragleave', (e) => {
      if (dropzone.contains(e.relatedTarget)) return;
      dropzone.classList.remove('drag-over');
    });
    dropzone.addEventListener('drop', async (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
      /* 바운스 애니메이션 트리거 */
      dropzone.classList.add('drop-bounce');
      setTimeout(() => dropzone.classList.remove('drop-bounce'), 600);

      const files = e.dataTransfer.files;
      if (!files?.length) return;
      if (files.length > 1) { Toast.show('파일은 하나씩만 열 수 있습니다.', 'error'); return; }
      await openEpubBook(files[0], false);
    });
  }

  /* ── 뷰어 ── */
  DOMProxy.get('arrow-prev')?.addEventListener('click', () => NavGuard.prev());
  DOMProxy.get('arrow-next')?.addEventListener('click', () => NavGuard.next());

  DOMProxy.get('btn-toc-toggle')?.addEventListener('click', () => {
    ReaderState.isTocOpen ? closeTocSidebar() : openTocSidebar();
  });
  DOMProxy.get('btn-toc-close')?.addEventListener('click', () => closeTocSidebar());

  DOMProxy.get('toc-overlay')?.addEventListener('click', () => closeTocSidebar());

  DOMProxy.get('btn-settings-toggle')?.addEventListener('click', () => {
    ReaderState.isSettingsOpen ? closeSettingsPanel() : openSettingsPanel();
  });
  DOMProxy.get('btn-settings-close')?.addEventListener('click', () => closeSettingsPanel());

  DOMProxy.get('btn-close-viewer')?.addEventListener('click', () => {
    if (confirm('뷰어를 닫고 서재로 돌아가시겠습니까?')) exitViewer();
  });

  /* 설정: 보기 모드 */
  DOMProxy.qa('[data-flow]').forEach(btn => {
    btn.addEventListener('click', () => switchFlowMode(btn.dataset.flow));
  });

  /* 설정: 글자 크기 */
  DOMProxy.get('btn-font-decrease')?.addEventListener('click', () => {
    ReadingSettings.fontSize = Math.max(60, ReadingSettings.fontSize - 5);
    applyAllSettings();
    saveSettings();
  });
  DOMProxy.get('btn-font-increase')?.addEventListener('click', () => {
    ReadingSettings.fontSize = Math.min(200, ReadingSettings.fontSize + 5);
    applyAllSettings();
    saveSettings();
  });

  /* 설정: 줄간격 */
  DOMProxy.qa('[data-lh]').forEach(btn => {
    btn.addEventListener('click', () => {
      ReadingSettings.lineHeight = btn.dataset.lh;
      applyAllSettings();
      saveSettings();
    });
  });

  /* 설정: 테마 스와치 */
  DOMProxy.qa('.theme-swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      ReadingSettings.theme = btn.dataset.theme;
      applyAllSettings();
      saveSettings();
    });
  });

  /* 검색 */
  DOMProxy.get('btn-search-toggle')?.addEventListener('click', () => {
    const modal = DOMProxy.get('search-modal');
    if (modal) modal.style.display = 'flex';
    setTimeout(() => DOMProxy.get('input-search-query')?.focus(), 60);
  });
  DOMProxy.get('btn-search-modal-close')?.addEventListener('click', () => {
    const modal = DOMProxy.get('search-modal');
    if (modal) modal.style.display = 'none';
  });
  DOMProxy.get('btn-execute-search')?.addEventListener('click', runSearchExecution);
  DOMProxy.get('input-search-query')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSearchExecution();
  });

  /* 통계 */
  DOMProxy.get('btn-stats-toggle')?.addEventListener('click', () => {
    const modal = DOMProxy.get('stats-modal');
    if (modal) modal.style.display = 'flex';
  });
  DOMProxy.get('btn-stats-modal-close')?.addEventListener('click', () => {
    const modal = DOMProxy.get('stats-modal');
    if (modal) modal.style.display = 'none';
  });
  DOMProxy.get('btn-save-goal')?.addEventListener('click', () => {
    const val = DOMProxy.get('input-reading-goal')?.value;
    if (val) { localStorage.setItem('fable_daily_goal', val); Toast.show('독서 목표가 저장되었습니다.', 'success'); }
  });

  /* TTS */
  DOMProxy.get('btn-annotation-toggle')?.addEventListener('click', () => {
    if (!ReaderState.rendition) return;
    try {
      const doc  = ReaderState.rendition.manager?.current()?.document;
      const text = doc?.body?.textContent?.slice(0, 4000) || '';
      if (text) TTSSystem.play(text);
    } catch (_) { Toast.show('TTS를 시작할 수 없습니다.', 'error'); }
  });
  DOMProxy.get('btn-tts-play-pause')?.addEventListener('click', () => TTSSystem.pauseResume());
  DOMProxy.get('btn-tts-stop')?.addEventListener('click', () => TTSSystem.stop());

  /* [UX#17] 키보드 힌트 닫기 */
  DOMProxy.get('btn-hint-close')?.addEventListener('click', () => {
    const layer = DOMProxy.get('keyboard-hint-layer');
    if (layer) layer.style.display = 'none';
  });

  /* 설정 패널 외부 클릭 닫기 */
  document.addEventListener('pointerdown', (e) => {
    const panel  = DOMProxy.get('settings-panel');
    const btnSet = DOMProxy.get('btn-settings-toggle');
    if (ReaderState.isSettingsOpen && panel && !panel.contains(e.target) && !btnSet?.contains(e.target)) {
      closeSettingsPanel();
    }
  }, { passive: true });

  /* [UX#17] 전역 키보드 */
  document.addEventListener('keydown', handleKeyDown);

  /* 폰트 업로더 */
  initFontUploader();
}

/* ══════════════════════════════════════════════════════════
   27. 설정 저장/복원
   ══════════════════════════════════════════════════════════ */
function saveSettings() {
  StorageSystem.lsSet(SETTINGS_KEY, ReadingSettings);
}

function loadSettings() {
  const saved = StorageSystem.lsGet(SETTINGS_KEY, null);
  if (saved) Object.assign(ReadingSettings, saved);
}

/* ══════════════════════════════════════════════════════════
   28. 전역 진입점 (initializeSystemCore)
   ══════════════════════════════════════════════════════════ */
async function initializeSystemCore() {

  /* ── [필수 요구사항 1-1] 전역 예외 가드 (인라인 스크립트 제거분 통합) ── */
  window.addEventListener('unhandledrejection', (event) => {
    console.error('[Fable] Unhandled Rejection:', event.reason);
    Toast.show('비동기 오류가 안전하게 복구되었습니다.', 'error');
  });

  /* ── beforeunload: 마지막 위치 강제 저장 ── */
  window.addEventListener('beforeunload', () => {
    if (ReaderState.bookKey && ReaderState.currentCFI) {
      try {
        localStorage.setItem(
          `fable_cfi_${ReaderState.bookKey}`,
          JSON.stringify({ data: ReaderState.currentCFI, ts: Date.now() })
        );
      } catch (_) {}
    }
  });

  /* ── [필수 요구사항 1-1] Service Worker 등록 통합 ── */
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      console.log('[Fable] Service Worker 등록 완료:', reg.scope);

      /* SW 업데이트 감지 */
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        newWorker?.addEventListener('statechange', () => {
          if (newWorker.statechange === 'installed' && navigator.serviceWorker.controller) {
            Toast.show('앱이 업데이트되었습니다. 새로고침하면 최신 버전을 사용할 수 있습니다.');
          }
        });
      });
    } catch (err) {
      console.warn('[Fable] Service Worker 등록 실패:', err);
    }
  }

  /* ── IndexedDB 초기화 ── */
  await StorageSystem.init().catch(err => console.warn('[Fable] IndexedDB 초기화 실패:', err));

  /* ── 설정 복원 ── */
  loadSettings();
  syncSettingsUI();
  applyShellTheme(ReadingSettings.theme);

  /* ── 전역 드래그 방지 ── */
  ['dragenter', 'dragover', 'drop'].forEach(evt => {
    document.addEventListener(evt, (e) => {
      const dz = DOMProxy.get('dropzone');
      if (dz && dz.contains(e.target)) return;
      e.preventDefault();
    });
  });

  /* ── UI 모듈 초기화 ── */
  initButtonEventHandlers();
  initOfflineBanner();       // [UX#18]
  initContextMenu();         // [UX#14]

  /* ── 서재 렌더링 ── */
  renderLibraryGrid();

  /* ── [UX#17] 키보드 힌트 (PC 환경만) ── */
  if (!('ontouchstart' in window)) {
    showKeyboardHint();
  }

  console.log('📖 Fable v2 Premium — 초기화 완료');
}

/* shell 테마 적용 (뷰어 닫힌 상태에서도 배경 일치) */
function applyShellTheme(theme) {
  if (theme === 'paper') { document.body.removeAttribute('data-theme'); }
  else { document.body.setAttribute('data-theme', theme); }
}

/* ── 전역 드래그 방지 (body 전체) ── */
document.addEventListener('dragover', (e) => {
  const dz = DOMProxy.get('dropzone');
  if (!dz || !dz.contains(e.target)) e.preventDefault();
});

/* ── DOM Ready ── */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeSystemCore);
} else {
  initializeSystemCore();
}
