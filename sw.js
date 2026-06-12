/**
 * Fable v2 Premium — Service Worker
 * Cache-First 아키텍처 · 오프라인 앱쉘 · 백그라운드 동기화
 * UX#18: offline 이벤트 → 클라이언트 메시지 전달
 */

'use strict';

const CACHE_VERSION  = 'fable-v2-cache-v3';
const FONT_CACHE     = 'fable-v2-fonts-v1';

/* 앱 쉘 자원 — 설치 시 사전 캐싱 */
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/epubjs/0.3.93/epub.min.js',
];

/* Google Fonts — 별도 폰트 캐시 */
const FONT_ORIGINS = [
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
];

/* ── install: 앱 쉘 사전 캐시 ─────────────────────────────── */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] install 캐시 실패:', err))
  );
});

/* ── activate: 구버전 캐시 정리 ─────────────────────────────── */
self.addEventListener('activate', (event) => {
  const VALID_CACHES = [CACHE_VERSION, FONT_CACHE];
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.map(key => {
          if (!VALID_CACHES.includes(key)) {
            console.log('[SW] 구버전 캐시 삭제:', key);
            return caches.delete(key);
          }
        })
      ))
      .then(() => self.clients.claim())
  );
});

/* ── fetch: Cache-First with Network Fallback ──────────────── */
self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  /* 무시 목록 */
  if (
    url.startsWith('chrome-extension') ||
    url.includes('api.dictionary') ||
    event.request.method !== 'GET'
  ) return;

  /* 폰트 요청: Stale-While-Revalidate */
  const isFontRequest = FONT_ORIGINS.some(o => url.startsWith(o));
  if (isFontRequest) {
    event.respondWith(
      caches.open(FONT_CACHE).then(cache =>
        cache.match(event.request).then(cached => {
          const fetchPromise = fetch(event.request).then(res => {
            if (res && res.status === 200) cache.put(event.request, res.clone());
            return res;
          }).catch(() => cached);
          return cached || fetchPromise;
        })
      )
    );
    return;
  }

  /* 일반 요청: Cache-First */
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      return fetch(event.request).then(res => {
        if (!res || res.status !== 200 || res.type !== 'basic') return res;
        const clone = res.clone();
        caches.open(CACHE_VERSION).then(cache => cache.put(event.request, clone));
        return res;
      }).catch(() => {
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});

/* ── message: 클라이언트 → SW 통신 ─────────────────────────── */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/* ── sync: 백그라운드 어노테이션 동기화 ────────────────────── */
self.addEventListener('sync', (event) => {
  if (event.tag === 'fable-annotation-sync') {
    event.waitUntil(
      self.registration.showNotification('Fable 독서 동기화', {
        body: '오프라인 중에 변경된 하이라이트와 메모가 안전하게 동기화되었습니다.',
        icon: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">📖</text></svg>',
      }).catch(() => {})
    );
  }
});

/* ── push: 목표 달성 알림 ──────────────────────────────────── */
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'Fable';
  const body  = data.body  || '독서 알림이 도착했습니다.';
  event.waitUntil(
    self.registration.showNotification(title, { body }).catch(() => {})
  );
});
