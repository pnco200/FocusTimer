// Generated asset URLs are discovered from the built entry. Install succeeds only when the shell is cached.
const CACHE = 'focus-timer-shell-__BUILD_ID__';
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const response = await fetch('/index.html', { cache: 'reload' });
    if (!response.ok) throw new Error('Application shell unavailable');
    const html = await response.clone().text();
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"\s]+)"/g)].map(match => match[1]);
    if (!assets.length) throw new Error('Built application assets unavailable');
    await cache.addAll([...assets, '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png']);
    await cache.put('/index.html', response);
  })());
});
self.addEventListener('activate', event => {
  // Activation waits for all old tabs to close; retain their cache until then.
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('focus-timer-shell-') && key !== CACHE).map(key => caches.delete(key)))));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(async () => (await caches.open(CACHE)).match('/index.html')));
  } else if (url.pathname.startsWith('/assets/') || ['/icon.svg', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'].includes(url.pathname)) {
    // These are public, same-origin, immutable shell assets. Preview/static servers may
    // vary on Origin; module requests must still find the asset cached at installation.
    event.respondWith(caches.open(CACHE).then(cache => cache.match(event.request, { ignoreVary: true })).then(cached => cached || fetch(event.request)));
  }
});
