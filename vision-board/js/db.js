/**
 * Local-first store: IndexedDB with localStorage fallback.
 * Data model:
 *  categories: { id, name, color?, order }
 *  goals: { id, title, description?, categoryId, target, current, unit?, status, createdAt, updatedAt, sample? }
 *  items: calendar/todo items
 *    { id, title, type: 'task'|'appointment'|'deadline'|'milestone',
 *      date (YYYY-MM-DD), time?, done, goalId?, categoryId?, notes?, sample?, createdAt, updatedAt }
 *  pins: vision board { id, text, imageUrl?, x, y, color?, createdAt, sample? }
 *  meta: { seeded, reminderPermissionAsked }
 */
(function (global) {
  const DB_NAME = 'rosetta-vision-board';
  const DB_VER = 1;
  const LS_KEY = 'rosetta-vision-board-v1';
  const STORES = ['categories', 'goals', 'items', 'pins', 'meta'];

  let db = null;
  let useLS = false;
  let memory = null;

  function uid() {
    return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
  }

  function lsLoad() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return { categories: [], goals: [], items: [], pins: [], meta: [] };
  }

  function lsSave() {
    localStorage.setItem(LS_KEY, JSON.stringify(memory));
  }

  function openIDB() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in global)) {
        reject(new Error('no idb'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onerror = () => reject(req.error);
      req.onupgradeneeded = () => {
        const d = req.result;
        STORES.forEach((name) => {
          if (!d.objectStoreNames.contains(name)) {
            d.createObjectStore(name, { keyPath: 'id' });
          }
        });
      };
      req.onsuccess = () => resolve(req.result);
    });
  }

  async function init() {
    try {
      db = await openIDB();
      useLS = false;
    } catch (_) {
      useLS = true;
      memory = lsLoad();
    }
    return { useLS };
  }

  function idbTx(store, mode) {
    return db.transaction(store, mode).objectStore(store);
  }

  function idbGetAll(store) {
    return new Promise((resolve, reject) => {
      const r = idbTx(store, 'readonly').getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    });
  }

  function idbGet(store, id) {
    return new Promise((resolve, reject) => {
      const r = idbTx(store, 'readonly').get(id);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(r.error);
    });
  }

  function idbPut(store, obj) {
    return new Promise((resolve, reject) => {
      const r = idbTx(store, 'readwrite').put(obj);
      r.onsuccess = () => resolve(obj);
      r.onerror = () => reject(r.error);
    });
  }

  function idbDelete(store, id) {
    return new Promise((resolve, reject) => {
      const r = idbTx(store, 'readwrite').delete(id);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
  }

  function idbClear(store) {
    return new Promise((resolve, reject) => {
      const r = idbTx(store, 'readwrite').clear();
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
  }

  async function getAll(store) {
    if (useLS) return [...(memory[store] || [])];
    return idbGetAll(store);
  }

  async function get(store, id) {
    if (useLS) return (memory[store] || []).find((x) => x.id === id) || null;
    return idbGet(store, id);
  }

  async function put(store, obj) {
    if (!obj.id) obj.id = uid();
    if (useLS) {
      const arr = memory[store] || (memory[store] = []);
      const i = arr.findIndex((x) => x.id === obj.id);
      if (i >= 0) arr[i] = obj;
      else arr.push(obj);
      lsSave();
      return obj;
    }
    return idbPut(store, obj);
  }

  async function remove(store, id) {
    if (useLS) {
      memory[store] = (memory[store] || []).filter((x) => x.id !== id);
      lsSave();
      return;
    }
    return idbDelete(store, id);
  }

  async function clearStore(store) {
    if (useLS) {
      memory[store] = [];
      lsSave();
      return;
    }
    return idbClear(store);
  }

  async function getMeta(key) {
    const row = await get('meta', key);
    return row ? row.value : undefined;
  }

  async function setMeta(key, value) {
    return put('meta', { id: key, value });
  }

  /** Full dump for export */
  async function exportAll() {
    const out = { version: 1, exportedAt: new Date().toISOString() };
    for (const s of STORES) out[s] = await getAll(s);
    return out;
  }

  /** Replace all data from import */
  async function importAll(data) {
    if (!data || typeof data !== 'object') throw new Error('Invalid import');
    for (const s of STORES) {
      await clearStore(s);
      const rows = Array.isArray(data[s]) ? data[s] : [];
      for (const row of rows) await put(s, row);
    }
  }

  async function clearSampleData() {
    for (const s of ['goals', 'items', 'pins']) {
      const rows = await getAll(s);
      for (const r of rows) {
        if (r.sample) await remove(s, r.id);
      }
    }
  }

  global.VBDB = {
    uid,
    init,
    getAll,
    get,
    put,
    remove,
    clearStore,
    getMeta,
    setMeta,
    exportAll,
    importAll,
    clearSampleData,
    STORES
  };
})(typeof window !== 'undefined' ? window : self);
