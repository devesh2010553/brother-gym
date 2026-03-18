// Brothers Gym — Service Worker v4
// TRUE background push: periodic sync + push events
const CACHE = 'brothers-gym-v4';
const OFFLINE_URLS = ['/portal', '/manifest.json', '/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(OFFLINE_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {

    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));

    await self.clients.claim();

    // Start background notification polling
    try {
      const reg = await self.registration;

      if (reg.sync) {
        await reg.sync.register('poll-notifications');
      }

      if (reg.periodicSync) {
        await reg.periodicSync.register('gym-poll', {
          minInterval: 30 * 60 * 1000
        });
      }

    } catch(err) {
      // ignore errors
    }

  })());
});

// Network-first fetch
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (!e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok && (e.request.url.includes('/portal') || e.request.url.includes('/manifest') || e.request.url.includes('/icon-'))) {
          caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// ── PUSH from server (Web Push API) ──────────────────────────
self.addEventListener('push', e => {
  let data = {title:'Brothers Gym 💪', body:'New notification', type:'info', url:'/portal'};
  try { data = {...data, ...e.data.json()}; } catch(err) {}
  e.waitUntil(showNotif(data.title, data));
});

function showNotif(title, data) {

  // Prevent duplicate notifications
  const notifTag = data.id || data._id || data.type || 'general';

  const actions =
    data.type === 'live'
      ? [
          { action: 'watch', title: '▶ Watch Now' },
          { action: 'dismiss', title: 'Dismiss' }
        ]
      : data.type === 'expiry'
      ? [
          { action: 'renew', title: '🔄 Renew Now' },
          { action: 'dismiss', title: 'Later' }
        ]
      : data.type === 'announcement'
      ? [
          { action: 'read', title: '📢 Read Now' },
          { action: 'dismiss', title: 'Later' }
        ]
      : data.type === 'reset'
      ? [
          { action: 'open', title: '🔑 Login Now' },
          { action: 'dismiss', title: 'Later' }
        ]
      : [{ action: 'open', title: '💪 Open App' }];

  return self.registration.showNotification(title, {
    body: data.body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',

    // ensures notification only shows once
    tag: notifTag,
    renotify: false,

    requireInteraction: ['live','expiry','announcement','reset'].includes(data.type),

    data: {
      url: data.url || '/portal',
      type: data.type
    },

    actions,

    vibrate:
      data.type === 'live'
        ? [300,100,300,100,300]
        : data.type === 'expiry'
        ? [200,100,200]
        : [100,50,100]
  });
}

// ── Background Sync — poll when back online ───────────────────
self.addEventListener('sync', e => {
  if (e.tag === 'poll-notifications') {
    e.waitUntil(bgPoll());
  }
});

// ── Periodic Background Sync (every 30 min if granted) ────────
self.addEventListener('periodicsync', e => {
  if (e.tag === 'gym-poll') {
    e.waitUntil(bgPoll());
  }
});

async function bgPoll() {
  try {
    const cache = await caches.open(CACHE);

    // get saved session
    const sessRes = await cache.match('__session__');
    if (!sessRes) return;

    const sess = await sessRes.json();
    if (!sess?.phone) return;

    // request pending notifications
    const res = await fetch(`/api/push/poll?phone=${encodeURIComponent(sess.phone)}`);
    if (!res.ok) return;

    const msgs = await res.json();
    if (!Array.isArray(msgs) || !msgs.length) return;

    const seenKey = '__seen_ids__';
    const seenRes = await cache.match(seenKey);

    let seen = new Set();
    try {
      if (seenRes) {
        const arr = await seenRes.json();
        seen = new Set(arr);
      }
    } catch (e) {}

    // filter fresh notifications safely
    const fresh = msgs.filter(m => {
      const id = String(m._id || m.id || '');
      if (!id) return false;
      return !seen.has(id);
    });

    for (const m of fresh) {
      const id = String(m._id || m.id || '');
      if (!id) continue;

      seen.add(id);

      await showNotif(m.title || 'Brothers Gym 💪', {
        ...m,
        id
      });
    }

    if (fresh.length) {
      // store seen ids (limit 500)
      await cache.put(
        seenKey,
        new Response(JSON.stringify([...seen].slice(-500)), {
          headers: { 'Content-Type': 'application/json' }
        })
      );

      // mark notifications delivered on server
      fetch('/api/push/mark-delivered', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids: fresh.map(m => String(m._id || m.id))
        })
      }).catch(() => {});
    }

  } catch (e) {
    console.error('bgPoll error', e);
  }
}
// ── Notification click ────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data = e.notification.data || {};
  const url = '/portal';
  e.waitUntil(
    clients.matchAll({type:'window', includeUncontrolled:true}).then(list => {
      for (const c of list) {
        if (c.url.includes('/portal') && 'focus' in c) {
          c.focus();
          c.postMessage({type:'navigate', section: data.type});
          return;
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

self.addEventListener('notificationclose', e => {});

// ── Message from page ─────────────────────────────────────────
self.addEventListener('message', e => {
  if (!e.data) return;
  if (e.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (e.data.type === 'SAVE_SESSION') {
    caches.open(CACHE).then(cache => {
      cache.put('__session__', new Response(JSON.stringify(e.data.session), {
        headers: {'Content-Type':'application/json'}
      }));
    });
  }
  if (e.data.type === 'POLL_NOW') bgPoll();
});