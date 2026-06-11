/**
 * ============================================================
 * FOLIO EPUB READER — app.js
 * epub.js 샌드박스 바인딩 · 독서 상태 엔진 · UI 인터랙션
 * ============================================================
 */

'use strict';

/* ── 0. 전역 상태 ─────────────────────────────────────────── */
const ReaderState = {
  book:           null,   // ePub Book 인스턴스
  rendition:      null,   // ePub Rendition 인스턴스
  toc:            [],     // 파싱된 목차 배열
  currentHref:    '',     // 현재 챕터 href
  totalLocations: 0,      // 전체 위치 수
  currentCFI:     '',     // 현재 CFI
  isTocOpen:      false,  // 목차 사이드바 상태
};


/* ── 1. DOM 레퍼런스 캐시 ────────────────────────────────── */
const DOM = {
  screenUploader:     () => document.getElementById('screen-uploader'),
  screenViewer:       () => document.getElementById('screen-viewer'),
  dropzone:           () => document.getElementById('dropzone'),
  epubFileInput:      () => document.getElementById('epub-file-input'),
  viewerViewport:     () => document.getElementById('viewer-viewport'),
  bookTitleDisplay:   () => document.getElementById('book-title-display'),
  arrowPrev:          () => document.getElementById('arrow-prev'),
  arrowNext:          () => document.getElementById('arrow-next'),
  btnTocToggle:       () => document.getElementById('btn-toc-toggle'),
  btnTocClose:        () => document.getElementById('btn-toc-close'),
  btnCloseViewer:     () => document.getElementById('btn-close-viewer'),
  tocSidebar:         () => document.getElementById('toc-sidebar'),
  tocListContainer:   () => document.getElementById('toc-list-container'),
  readingPercentage:  () => document.getElementById('reading-percentage'),
  readingLocationRange: () => document.getElementById('reading-location-range'),
  toastContainer:     () => document.getElementById('global-toast-container'),
};


/* ── 2. 토스트 알림 유틸리티 ─────────────────────────────── */
const Toast = (() => {
  const DURATION_MS = 3200;
  const FADE_MS     = 300;

  /**
   * @param {string} message
   * @param {'default'|'error'|'success'} type
   */
  function show(message, type = 'default') {
    const container = DOM.toastContainer();
    if (!container) return;

    const el = document.createElement('div');
    el.className = `toast${type !== 'default' ? ' ' + type : ''}`;
    el.textContent = message;

    container.appendChild(el);

    const timer = setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, FADE_MS);
    }, DURATION_MS);

    // 즉시 제거 클릭 방지 (포인터 이벤트 없음)
    el._timer = timer;
  }

  return { show };
})();


/* ── 3. 로딩 오버레이 관리 ───────────────────────────────── */
const LoadingOverlay = (() => {
  let overlayEl = null;

  function show(message = '책을 불러오는 중...') {
    if (overlayEl) return;

    overlayEl = document.createElement('div');
    overlayEl.className = 'loading-overlay';
    overlayEl.innerHTML = `
      <div class="spinner"></div>
      <p>${escapeText(message)}</p>
    `;

    const viewer = DOM.screenViewer();
    if (viewer) viewer.appendChild(overlayEl);
  }

  function hide() {
    if (!overlayEl) return;
    overlayEl.classList.add('fade-out');
    setTimeout(() => {
      if (overlayEl && overlayEl.parentNode) {
        overlayEl.parentNode.removeChild(overlayEl);
      }
      overlayEl = null;
    }, 250);
  }

  return { show, hide };
})();


/* ── 4. 진행률 바 관리 ───────────────────────────────────── */
const ProgressBar = (() => {
  let trackEl = null;
  let fillEl  = null;

  function init() {
    if (trackEl) return;
    trackEl = document.createElement('div');
    trackEl.className = 'progress-bar-track';
    fillEl = document.createElement('div');
    fillEl.className = 'progress-bar-fill';
    trackEl.appendChild(fillEl);
    const viewer = DOM.screenViewer();
    if (viewer) viewer.appendChild(trackEl);
  }

  function setPercent(pct) {
    if (!fillEl) init();
    const clamped = Math.max(0, Math.min(100, pct));
    fillEl.style.width = `${clamped}%`;
  }

  function destroy() {
    if (trackEl && trackEl.parentNode) {
      trackEl.parentNode.removeChild(trackEl);
    }
    trackEl = null;
    fillEl  = null;
  }

  return { init, setPercent, destroy };
})();


/* ── 5. XSS 방어 유틸리티 ────────────────────────────────── */
function escapeText(str) {
  const div = document.createElement('div');
  div.textContent = String(str || '');
  return div.innerHTML;
}

function setTextSafe(el, text) {
  if (el) el.textContent = String(text || '');
}


/* ── 6. 화면 전환 ────────────────────────────────────────── */
function showViewerScreen() {
  const uploader = DOM.screenUploader();
  const viewer   = DOM.screenViewer();

  if (uploader) {
    uploader.classList.add('fade-out');
    setTimeout(() => {
      uploader.style.display = 'none';
      uploader.classList.remove('fade-out');
    }, 230);
  }

  if (viewer) {
    viewer.style.display = 'flex';
    // 강제 리플로우 후 트랜지션 시작
    viewer.offsetHeight; // eslint-disable-line no-unused-expressions
  }
}

function showUploaderScreen() {
  const uploader = DOM.screenUploader();
  const viewer   = DOM.screenViewer();

  if (viewer) viewer.style.display = 'none';

  if (uploader) {
    uploader.style.display = '';
    uploader.classList.remove('fade-out');
  }
}


/* ── 7. epub.js 렌더링 엔진 ──────────────────────────────── */

/**
 * ArrayBuffer → ePub 책 초기화 및 렌더링
 * @param {ArrayBuffer} arrayBuffer
 * @param {string} fileName
 */
async function initEpubReader(arrayBuffer, fileName) {
  // 기존 인스턴스 정리
  await destroyEpubReader();

  showViewerScreen();
  LoadingOverlay.show('책을 분석하는 중...');
  ProgressBar.init();

  try {
    // ── 7-1. ePub 인스턴스 생성 ──
    const book = ePub(arrayBuffer);
    ReaderState.book = book;

    // 책 기본 정보 로드 대기
    await book.ready;

    // 제목 표시
    try {
      const meta = await book.loaded.metadata;
      const title = meta.title || fileName.replace(/\.epub$/i, '') || '제목 없음';
      setTextSafe(DOM.bookTitleDisplay(), title);
    } catch (_) {
      setTextSafe(DOM.bookTitleDisplay(), fileName.replace(/\.epub$/i, '') || '제목 없음');
    }

    // ── 7-2. Rendition 생성 ──
    const viewport = DOM.viewerViewport();
    if (!viewport) throw new Error('뷰어 뷰포트 DOM을 찾을 수 없습니다.');

    const rendition = book.renderTo(viewport, {
      manager: 'continuous',
      flow:    'paginated',
      width:   '100%',
      height:  '100%',
      spread:  'auto',
    });

    ReaderState.rendition = rendition;

    // ── 7-3. 기본 독서 스타일 주입 ──
    rendition.themes.default({
      body: {
        'font-family':   "'Gowun Batang', 'Noto Serif KR', Georgia, serif !important",
        'font-size':     '1.05em !important',
        'line-height':   '1.85 !important',
        'color':         '#1a1814 !important',
        'background':    '#fcfbf7 !important',
        'word-break':    'keep-all',
        'overflow-wrap': 'break-word',
      },
      'p, li, blockquote': {
        'margin-bottom': '0.6em',
      },
      'h1, h2, h3, h4': {
        'font-weight':  '700',
        'line-height':  '1.4',
        'margin-bottom': '0.8em',
      },
      'a': {
        'color': '#5a4a3a',
      },
      'img': {
        'max-width':  '100%',
        'height':     'auto',
        'display':    'block',
        'margin':     '0 auto',
      },
    });

    // ── 7-4. 목차 로드 ──
    try {
      const navigation = await book.loaded.navigation;
      ReaderState.toc = navigation.toc || [];
      renderTocList(ReaderState.toc);
    } catch (_) {
      ReaderState.toc = [];
    }

    // ── 7-5. 로케이션 생성 (진행률 계산용) ──
    // 비동기로 백그라운드 처리
    book.locations.generate(1600).then(locs => {
      ReaderState.totalLocations = locs.length;
    }).catch(() => {
      ReaderState.totalLocations = 0;
    });

    // ── 7-6. 초기 렌더링 시작 ──
    await rendition.display();

    LoadingOverlay.hide();

    // ── 7-7. 이벤트 바인딩 ──
    bindRenditionEvents(rendition, book);

  } catch (err) {
    LoadingOverlay.hide();
    console.error('[Folio] EPUB 초기화 오류:', err);
    Toast.show(`책을 열 수 없습니다: ${err.message || '알 수 없는 오류'}`, 'error');
    await destroyEpubReader();
    showUploaderScreen();
  }
}


/**
 * 렌더러에 이벤트 바인딩
 * @param {object} rendition
 * @param {object} book
 */
function bindRenditionEvents(rendition, book) {

  // 페이지 이동 완료 시
  rendition.on('relocated', (location) => {
    try {
      ReaderState.currentCFI = location.start.cfi;

      // 진행률 계산
      if (ReaderState.totalLocations > 0 && book.locations) {
        const pct = book.locations.percentageFromCfi(location.start.cfi);
        const percent = Math.round((pct || 0) * 100);
        setTextSafe(DOM.readingPercentage(), `${percent}%`);
        ProgressBar.setPercent(percent);
      }

      // 위치 정보 표시
      const startIdx = location.start.location >= 0 ? location.start.location + 1 : '-';
      const endIdx   = location.end.location   >= 0 ? location.end.location   + 1 : '-';
      const total    = ReaderState.totalLocations > 0 ? ReaderState.totalLocations : '-';
      setTextSafe(DOM.readingLocationRange(), `${startIdx}–${endIdx} / ${total}`);

      // 현재 href 갱신 → 목차 활성화
      const href = location.start.href;
      if (href && href !== ReaderState.currentHref) {
        ReaderState.currentHref = href;
        updateTocActiveItem(href);
      }

      // 화살표 버튼 상태 갱신
      updateArrowButtons(location);

    } catch (e) {
      console.warn('[Folio] relocated 핸들러 오류:', e);
    }
  });

  // 렌더러 내부 키보드 이벤트 (iframe 포커스 시)
  rendition.on('keyup', (e) => {
    handleKeyNavigation(e);
  });

  // iframe 클릭 → 목차 닫기
  rendition.on('click', () => {
    if (ReaderState.isTocOpen) closeToc();
  });

  // 렌더 오류
  rendition.on('renderFailed', (err) => {
    console.error('[Folio] 렌더 오류:', err);
    Toast.show('페이지 렌더링 중 오류가 발생했습니다.', 'error');
  });
}


/**
 * 화살표 버튼 활성화/비활성화
 * @param {object} location
 */
function updateArrowButtons(location) {
  const prevBtn = DOM.arrowPrev();
  const nextBtn = DOM.arrowNext();

  if (!prevBtn || !nextBtn) return;

  if (prevBtn) {
    prevBtn.disabled = location.atStart === true;
  }
  if (nextBtn) {
    nextBtn.disabled = location.atEnd === true;
  }
}


/**
 * epub.js 인스턴스 완전 정리
 */
async function destroyEpubReader() {
  if (ReaderState.rendition) {
    try { ReaderState.rendition.destroy(); } catch (_) {}
    ReaderState.rendition = null;
  }
  if (ReaderState.book) {
    try { ReaderState.book.destroy(); } catch (_) {}
    ReaderState.book = null;
  }

  ReaderState.toc            = [];
  ReaderState.currentHref    = '';
  ReaderState.totalLocations = 0;
  ReaderState.currentCFI     = '';
  ReaderState.isTocOpen      = false;

  // 뷰포트 초기화
  const vp = DOM.viewerViewport();
  if (vp) vp.innerHTML = '';

  // UI 초기화
  setTextSafe(DOM.bookTitleDisplay(), '도서 제목 정보 로딩 중...');
  setTextSafe(DOM.readingPercentage(), '0%');
  setTextSafe(DOM.readingLocationRange(), '- / -');

  const tocList = DOM.tocListContainer();
  if (tocList) tocList.innerHTML = '';

  closeToc(true);
  ProgressBar.destroy();
}


/* ── 8. 목차 렌더링 ──────────────────────────────────────── */

/**
 * 목차 배열 → DOM 렌더링
 * @param {Array} tocItems
 * @param {number} depth
 */
function renderTocList(tocItems, depth = 1) {
  const container = DOM.tocListContainer();
  if (!container) return;

  if (depth === 1) container.innerHTML = '';

  if (!tocItems || tocItems.length === 0) {
    if (depth === 1) {
      const empty = document.createElement('p');
      empty.style.cssText = 'padding: 20px; color: var(--color-ink-muted); font-size: 13px; text-align: center;';
      empty.textContent = '목차 정보가 없습니다.';
      container.appendChild(empty);
    }
    return;
  }

  tocItems.forEach(item => {
    const btn = document.createElement('button');
    btn.className = 'toc-item';
    btn.dataset.depth = String(depth);
    btn.dataset.href = item.href || '';
    btn.textContent = item.label || '(제목 없음)';

    btn.addEventListener('click', () => {
      navigateToTocItem(item.href);
    });

    container.appendChild(btn);

    // 서브아이템 재귀 렌더링 (최대 3뎁스)
    if (item.subitems && item.subitems.length > 0 && depth < 3) {
      renderSubTocItems(container, item.subitems, depth + 1);
    }
  });
}

/**
 * 서브 목차 재귀 렌더링
 */
function renderSubTocItems(container, items, depth) {
  items.forEach(item => {
    const btn = document.createElement('button');
    btn.className = 'toc-item';
    btn.dataset.depth = String(depth);
    btn.dataset.href = item.href || '';
    btn.textContent = item.label || '(제목 없음)';

    btn.addEventListener('click', () => {
      navigateToTocItem(item.href);
    });

    container.appendChild(btn);

    if (item.subitems && item.subitems.length > 0 && depth < 3) {
      renderSubTocItems(container, item.subitems, depth + 1);
    }
  });
}

/**
 * 목차 아이템으로 이동
 * @param {string} href
 */
async function navigateToTocItem(href) {
  if (!href || !ReaderState.rendition) return;

  try {
    await ReaderState.rendition.display(href);
    closeToc();
  } catch (err) {
    console.error('[Folio] 목차 이동 오류:', err);
    Toast.show('해당 챕터로 이동할 수 없습니다.', 'error');
  }
}

/**
 * 현재 href에 해당하는 목차 아이템 활성화
 * @param {string} href
 */
function updateTocActiveItem(href) {
  const container = DOM.tocListContainer();
  if (!container || !href) return;

  const items = container.querySelectorAll('.toc-item');
  items.forEach(item => {
    item.classList.remove('active');
    // href 부분 매칭 (앵커 포함 대응)
    const itemHref = item.dataset.href || '';
    if (itemHref && (href.includes(itemHref.split('#')[0]) || itemHref.includes(href.split('#')[0]))) {
      item.classList.add('active');
    }
  });
}


/* ── 9. 목차 사이드바 토글 ───────────────────────────────── */
function openToc() {
  const sidebar = DOM.tocSidebar();
  if (!sidebar) return;

  sidebar.style.display = 'flex';
  // 강제 리플로우
  sidebar.offsetHeight; // eslint-disable-line no-unused-expressions
  sidebar.classList.add('open');

  // 오버레이 생성
  let overlay = document.getElementById('toc-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'toc-overlay';
    overlay.className = 'toc-sidebar-overlay';
    const viewer = DOM.screenViewer();
    if (viewer) viewer.appendChild(overlay);

    overlay.addEventListener('click', () => closeToc());
  }

  overlay.offsetHeight; // eslint-disable-line no-unused-expressions
  overlay.classList.add('visible');

  ReaderState.isTocOpen = true;
}

function closeToc(immediate = false) {
  const sidebar = DOM.tocSidebar();
  const overlay = document.getElementById('toc-overlay');

  if (sidebar) {
    sidebar.classList.remove('open');
    if (immediate) {
      sidebar.style.display = 'none';
    } else {
      setTimeout(() => {
        // 이미 다시 열린 경우 숨기지 않음
        if (!ReaderState.isTocOpen) {
          sidebar.style.display = 'none';
        }
      }, 240);
    }
  }

  if (overlay) {
    overlay.classList.remove('visible');
  }

  ReaderState.isTocOpen = false;
}

function toggleToc() {
  if (ReaderState.isTocOpen) {
    closeToc();
  } else {
    openToc();
  }
}


/* ── 10. 키보드 내비게이션 ───────────────────────────────── */
function handleKeyNavigation(e) {
  if (!ReaderState.rendition) return;

  switch (e.key) {
    case 'ArrowRight':
    case 'ArrowDown':
    case 'PageDown':
      navigateNext();
      break;
    case 'ArrowLeft':
    case 'ArrowUp':
    case 'PageUp':
      navigatePrev();
      break;
    default:
      break;
  }
}

async function navigatePrev() {
  if (!ReaderState.rendition) return;
  try {
    await ReaderState.rendition.prev();
  } catch (err) {
    console.warn('[Folio] 이전 페이지 이동 오류:', err);
  }
}

async function navigateNext() {
  if (!ReaderState.rendition) return;
  try {
    await ReaderState.rendition.next();
  } catch (err) {
    console.warn('[Folio] 다음 페이지 이동 오류:', err);
  }
}


/* ── 11. 파일 입력 처리 ──────────────────────────────────── */

/**
 * File 객체를 ArrayBuffer로 변환
 * @param {File} file
 * @returns {Promise<ArrayBuffer>}
 */
function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = (e) => resolve(e.target.result);
    reader.onerror = () => reject(new Error('파일을 읽는 중 오류가 발생했습니다.'));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * EPUB 파일 유효성 검사
 * @param {File} file
 * @returns {boolean}
 */
function validateEpubFile(file) {
  if (!file) return false;

  const MAX_SIZE = 300 * 1024 * 1024; // 300 MB
  if (file.size > MAX_SIZE) {
    Toast.show('파일 크기가 너무 큽니다. (최대 300 MB)', 'error');
    return false;
  }

  const name = file.name.toLowerCase();
  if (!name.endsWith('.epub')) {
    Toast.show('EPUB 파일만 지원합니다. (.epub)', 'error');
    return false;
  }

  return true;
}

/**
 * 파일 처리 메인 핸들러
 * @param {File} file
 */
async function handleEpubFile(file) {
  if (!validateEpubFile(file)) return;

  try {
    Toast.show(`"${file.name}" 파일을 여는 중...`);
    const arrayBuffer = await readFileAsArrayBuffer(file);
    await initEpubReader(arrayBuffer, file.name);
  } catch (err) {
    console.error('[Folio] 파일 처리 오류:', err);
    Toast.show(`파일 처리 오류: ${err.message || '알 수 없는 오류'}`, 'error');
    showUploaderScreen();
  }
}


/* ── 12. 드래그 앤 드롭 ──────────────────────────────────── */
function initDropzone() {
  const dropzone   = DOM.dropzone();
  const fileInput  = DOM.epubFileInput();

  if (!dropzone || !fileInput) return;

  // 파일 선택 input 변경
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
      await handleEpubFile(file);
      // 동일 파일 재선택 허용
      fileInput.value = '';
    }
  });

  // 드래그 이벤트
  dropzone.addEventListener('dragenter', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.add('drag-over');
  });

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    dropzone.classList.add('drag-over');
  });

  dropzone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // 자식 요소로의 이탈은 무시
    if (e.currentTarget.contains(e.relatedTarget)) return;
    dropzone.classList.remove('drag-over');
  });

  dropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.remove('drag-over');

    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    if (files.length > 1) {
      Toast.show('파일은 한 번에 하나씩만 열 수 있습니다.', 'error');
      return;
    }

    await handleEpubFile(files[0]);
  });

  // 클릭으로도 드롭존 전체 활성화
  dropzone.addEventListener('click', (e) => {
    // 버튼 클릭은 버튼 자체의 onclick으로 처리
    if (e.target.classList.contains('btn-select')) return;
    fileInput.click();
  });
}

/* 전역 드래그 방지 (뷰어 화면 위 드롭 오동작 방지) */
function initGlobalDragPrevention() {
  ['dragenter', 'dragover', 'drop'].forEach(eventName => {
    document.addEventListener(eventName, (e) => {
      // dropzone 내부가 아닌 경우 기본 동작 차단
      const dropzone = DOM.dropzone();
      if (dropzone && dropzone.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
    });
  });
}


/* ── 13. 버튼 이벤트 바인딩 ──────────────────────────────── */
function initButtonEvents() {
  // 이전 페이지
  const prevBtn = DOM.arrowPrev();
  if (prevBtn) {
    prevBtn.addEventListener('click', () => navigatePrev());
  }

  // 다음 페이지
  const nextBtn = DOM.arrowNext();
  if (nextBtn) {
    nextBtn.addEventListener('click', () => navigateNext());
  }

  // 목차 토글
  const tocToggleBtn = DOM.btnTocToggle();
  if (tocToggleBtn) {
    tocToggleBtn.addEventListener('click', () => toggleToc());
  }

  // 목차 닫기
  const tocCloseBtn = DOM.btnTocClose();
  if (tocCloseBtn) {
    tocCloseBtn.addEventListener('click', () => closeToc());
  }

  // 뷰어 닫기 (초기화 후 업로더 화면으로)
  const closeViewerBtn = DOM.btnCloseViewer();
  if (closeViewerBtn) {
    closeViewerBtn.addEventListener('click', async () => {
      if (confirm('현재 책을 닫고 파일 선택 화면으로 돌아가시겠습니까?')) {
        await destroyEpubReader();
        showUploaderScreen();
        Toast.show('파일 선택 화면으로 돌아왔습니다.');
      }
    });
  }
}


/* ── 14. 전역 키보드 이벤트 ──────────────────────────────── */
function initKeyboardEvents() {
  document.addEventListener('keydown', (e) => {
    // 뷰어 화면이 아닐 경우 무시
    const viewer = DOM.screenViewer();
    if (!viewer || viewer.style.display === 'none') return;
    if (!ReaderState.rendition) return;

    // Escape → 목차 닫기
    if (e.key === 'Escape') {
      if (ReaderState.isTocOpen) {
        closeToc();
        return;
      }
    }

    handleKeyNavigation(e);
  });
}


/* ── 15. 터치 스와이프 내비게이션 ────────────────────────── */
function initTouchSwipe() {
  const viewer = DOM.screenViewer();
  if (!viewer) return;

  let touchStartX = 0;
  let touchStartY = 0;
  const SWIPE_THRESHOLD = 50; // px
  const AXIS_LOCK_RATIO = 1.5; // 가로/세로 비율

  viewer.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  viewer.addEventListener('touchend', (e) => {
    if (!ReaderState.rendition) return;

    const deltaX = e.changedTouches[0].clientX - touchStartX;
    const deltaY = e.changedTouches[0].clientY - touchStartY;

    // 세로 스와이프가 더 강하면 무시
    if (Math.abs(deltaY) * AXIS_LOCK_RATIO > Math.abs(deltaX)) return;
    if (Math.abs(deltaX) < SWIPE_THRESHOLD) return;

    if (deltaX < 0) {
      navigateNext();
    } else {
      navigatePrev();
    }
  }, { passive: true });
}

/* ── 16. 앱 초기화 ───────────────────────────────────────── */
function init() {
  // 뷰어 스크린 초기 상태: 숨김
  const viewer = DOM.screenViewer();
  if (viewer) viewer.style.display = 'none';

  // 목차 사이드바 초기 상태: 숨김
  const tocSidebar = DOM.tocSidebar();
  if (tocSidebar) tocSidebar.style.display = 'none';

  initDropzone();
  initGlobalEvents();

  // 안전장치 가드: 라이브러리 최종 존재 유무 검증 문턱 낮추기
  if (typeof ePub === 'undefined' && typeof window.ePub === 'undefined') {
    console.error("[Folio] epub.js (ePub) 전역 변수 없음.");
    showToast("리더 엔진 라이브러리를 로드하지 못했습니다. 페이지를 새로고침해 주세요.", true);
    return;
  }
  
  console.log("🚀 Fable Engine Initialized Successfully.");
}

// 브라우저가 HTML/라이브러리 파싱을 완전히 마친 후 안전하게 init 실행
document.addEventListener('DOMContentLoaded', init);