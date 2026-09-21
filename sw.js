/* Front Office — the notification helper.

   A phone will only show a web app's notification through a service worker,
   so this file exists for that and nothing else. It sits beside index.html and
   has to be deployed with it.

   It deliberately caches nothing and answers no requests. Every deploy is
   picked up the next time the app opens, exactly as before — there is no old
   copy held on anybody's phone. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

/* Tapping a notification brings the app forward, or opens it if it was closed. */
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

/* Ready for a push from a league server, if one is ever set up — that is what
   would reach a phone that is locked or has the app closed. */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; }
  catch (x) { d = { title: 'Front Office', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(
    self.registration.showNotification(d.title || 'Front Office', {
      body: d.body || '',
      tag: d.tag || undefined,
      data: { url: d.url || self.registration.scope }
    })
  );
});
