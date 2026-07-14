/* eslint-disable no-undef */
/**
 * Handlers de PUSH. Se importa dentro del service worker de Workbox
 * (vite.config.ts → workbox.importScripts), así que NO es un segundo SW: dos
 * service workers compitiendo por el mismo scope es una fuente clásica de bugs.
 */

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { titulo: 'Aviso', mensaje: event.data ? event.data.text() : '' };
  }

  const titulo = data.titulo || 'Aviso';
  const opciones = {
    body: data.mensaje || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    // Mismo tag = la notificación nueva reemplaza a la anterior en vez de
    // apilar diez avisos iguales.
    tag: data.tag || 'sala',
    data: { url: data.url || '/app' }
  };

  event.waitUntil(self.registration.showNotification(titulo, opciones));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/app';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((lista) => {
      // Si la app ya está abierta, la enfoca en vez de abrir otra pestaña.
      for (const cliente of lista) {
        if ('focus' in cliente) {
          cliente.navigate(url);
          return cliente.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
