/**
 * Notification API + local polling for due items.
 */
(function (global) {
  const CHECK_MS = 60 * 1000;
  let timer = null;
  let lastNotified = new Set();

  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  async function requestPermission() {
    if (!('Notification' in window)) return 'unsupported';
    if (Notification.permission === 'granted') return 'granted';
    if (Notification.permission === 'denied') return 'denied';
    const p = await Notification.requestPermission();
    await VBDB.setMeta('reminderPermissionAsked', true);
    return p;
  }

  function notify(title, body, tag) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      new Notification(title, {
        body,
        tag: tag || 'vb-reminder',
        icon: './icons/icon-192.png',
        badge: './icons/icon-192.png'
      });
    } catch (_) {
      /* iOS Safari may need service worker / PWA context */
    }
  }

  async function checkDue() {
    const items = await VBDB.getAll('items');
    const t = todayISO();
    const due = items.filter((i) => !i.done && i.date && i.date <= t);
    const soon = items.filter((i) => {
      if (i.done || !i.date) return false;
      const d = new Date(i.date + 'T12:00:00');
      const now = new Date();
      const diff = (d - now) / (1000 * 60 * 60 * 24);
      return diff > 0 && diff <= 2;
    });

    for (const i of due) {
      const tag = 'due_' + i.id;
      if (lastNotified.has(tag)) continue;
      lastNotified.add(tag);
      notify('Due: ' + i.title, (i.type || 'task') + ' · ' + i.date, tag);
    }

    // Soft reminder for soon (once per session per item)
    for (const i of soon) {
      const tag = 'soon_' + i.id;
      if (lastNotified.has(tag)) continue;
      lastNotified.add(tag);
      notify('Coming up: ' + i.title, (i.type || 'task') + ' · ' + i.date, tag);
    }

    return { due: due.length, soon: soon.length };
  }

  function start() {
    stop();
    checkDue();
    timer = setInterval(checkDue, CHECK_MS);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  global.VBReminders = { requestPermission, checkDue, start, stop };
})(typeof window !== 'undefined' ? window : self);
