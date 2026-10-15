// Service worker: rende l'app utilizzabile offline.
const SHELL = 'shell-v1';
const IMAGES = 'images-v1';
const FILES = [
  './', 'index.html', 'css/style.css',
  'js/app.js', 'js/db.js', 'js/api.js', 'js/logos.js', 'js/images.js', 'js/scan.js', 'js/version.js', 'js/albums.js', 'js/pokedex.js', 'js/charts.js', 'js/rarity.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Immagini copiate dentro l'app (img/, logos/): non cambiano mai, quindi prima la copia salvata.
  if (url.origin === location.origin && /\/(img|logos)\//.test(url.pathname)) {
    e.respondWith(
      caches.open(IMAGES).then(async cache => {
        const hit = await cache.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      })
    );
    return;
  }

  // File dell'app: prima la rete (così le modifiche si vedono subito), poi la copia salvata.
  // "no-cache" chiede sempre al server se il file è cambiato: senza, il telefono poteva riusare
  // per 10 minuti la copia vecchia anche con una versione nuova già pubblicata.
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' }).then(res => {
        if (res.ok) caches.open(SHELL).then(c => c.put(e.request, res.clone()));
        return res.clone();
      }).catch(() => caches.match(e.request, { ignoreSearch: true }))
    );
    return;
  }

  // Immagini delle carte: non cambiano mai, quindi prima la copia salvata.
  if (url.hostname === 'assets.tcgdex.net' || url.hostname === 'images.scrydex.com') {
    e.respondWith(
      caches.open(IMAGES).then(async cache => {
        const hit = await cache.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      })
    );
  }
  // Le chiamate all'API passano dirette: la cache è in IndexedDB (js/api.js).
});
