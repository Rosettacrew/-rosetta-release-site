/**
 * Rosetta Vision Board — main UI controller
 * Extension points: add views via nav + render* ; hooks on item complete → goal progress
 */
(function () {
  'use strict';

  const TYPE_LABELS = {
    task: 'Task',
    appointment: 'Appointment',
    deadline: 'Deadline',
    milestone: 'Milestone'
  };

  let state = {
    view: 'today',
    calYear: new Date().getFullYear(),
    calMonth: new Date().getMonth(),
    selectedDate: todayISO(),
    cats: [],
    goals: [],
    items: [],
    pins: []
  };

  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  function addDays(iso, n) {
    const d = new Date(iso + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 2400);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function refreshData() {
    state.cats = (await VBDB.getAll('categories')).sort((a, b) => (a.order || 0) - (b.order || 0));
    state.goals = await VBDB.getAll('goals');
    state.items = await VBDB.getAll('items');
    state.pins = await VBDB.getAll('pins');
  }

  function catName(id) {
    const c = state.cats.find((x) => x.id === id);
    return c ? c.name : '';
  }

  function goalTitle(id) {
    const g = state.goals.find((x) => x.id === id);
    return g ? g.title : '';
  }

  function goalProgressPct(g) {
    if (!g || !g.target) return 0;
    return Math.min(100, Math.round((Number(g.current) / Number(g.target)) * 100));
  }

  /** Completing a linked task bumps goal.current by 1 (once). */
  async function onItemDoneChange(item, wasDone, nowDone) {
    if (!item.goalId) return;
    const goal = await VBDB.get('goals', item.goalId);
    if (!goal) return;
    let cur = Number(goal.current) || 0;
    if (!wasDone && nowDone) cur += 1;
    else if (wasDone && !nowDone) cur = Math.max(0, cur - 1);
    goal.current = cur;
    goal.updatedAt = Date.now();
    if (goal.target && cur >= goal.target) goal.status = 'done';
    else if (goal.status === 'done') goal.status = 'active';
    await VBDB.put('goals', goal);
  }

  async function toggleItemDone(id) {
    const item = await VBDB.get('items', id);
    if (!item) return;
    const was = !!item.done;
    item.done = !was;
    item.updatedAt = Date.now();
    await VBDB.put('items', item);
    await onItemDoneChange(item, was, item.done);
    await refreshData();
    renderAll();
    toast(item.done ? 'Completed' : 'Marked open');
  }

  /* ---------- Modal ---------- */
  function openModal(html) {
    const bd = document.getElementById('modal-backdrop');
    document.getElementById('modal-body').innerHTML = html;
    bd.classList.remove('hidden');
  }
  function closeModal() {
    document.getElementById('modal-backdrop').classList.add('hidden');
    document.getElementById('modal-body').innerHTML = '';
  }

  document.getElementById('modal-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'modal-backdrop') closeModal();
  });

  /* ---------- Navigation ---------- */
  function setView(name) {
    state.view = name;
    document.querySelectorAll('main.view').forEach((el) => {
      el.classList.toggle('active', el.dataset.view === name);
    });
    document.querySelectorAll('.nav button').forEach((btn) => {
      const on = btn.dataset.nav === name;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    renderAll();
  }

  document.querySelector('.nav').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-nav]');
    if (btn) setView(btn.dataset.nav);
  });

  /* ---------- Render helpers ---------- */
  function itemRowHTML(item, opts) {
    opts = opts || {};
    const type = TYPE_LABELS[item.type] || item.type;
    const sample = item.sample ? ' <span class="badge badge-sample">sample</span>' : '';
    const goal = item.goalId ? ` · ${esc(goalTitle(item.goalId))}` : '';
    const time = item.time ? ` · ${esc(item.time)}` : '';
    return `
      <div class="item-row" data-id="${esc(item.id)}">
        <button type="button" class="check ${item.done ? 'done' : ''}" data-action="toggle" aria-label="Toggle done">${item.done ? '✓' : ''}</button>
        <div class="item-body">
          <div class="title">${esc(item.title)}${sample}</div>
          <div class="meta">${esc(type)} · ${esc(fmtDate(item.date))}${time}${goal}${item.categoryId ? ' · ' + esc(catName(item.categoryId)) : ''}</div>
        </div>
        <div class="item-actions">
          ${opts.hideEdit ? '' : `<button type="button" class="btn btn-sm btn-ghost" data-action="edit">Edit</button>`}
        </div>
      </div>`;
  }

  function bindItemList(container) {
    if (!container || container._bound) return;
    container._bound = true;
    container.addEventListener('click', async (e) => {
      const row = e.target.closest('.item-row');
      if (!row) return;
      const id = row.dataset.id;
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'toggle') await toggleItemDone(id);
      else if (action === 'edit') openItemForm(await VBDB.get('items', id));
    });
  }

  /* ---------- Today ---------- */
  function renderToday() {
    const t = todayISO();
    const soonEnd = addDays(t, 3);
    const todayItems = state.items
      .filter((i) => i.date === t)
      .sort((a, b) => Number(a.done) - Number(b.done) || (a.time || '').localeCompare(b.time || ''));
    const soonItems = state.items
      .filter((i) => !i.done && i.date > t && i.date <= soonEnd)
      .sort((a, b) => a.date.localeCompare(b.date));

    const attention = state.goals.filter((g) => {
      if (g.status === 'done') return false;
      const pct = goalProgressPct(g);
      return pct < 40;
    });

    const tl = document.getElementById('today-list');
    const sl = document.getElementById('soon-list');
    const ag = document.getElementById('attention-goals');

    tl.innerHTML = todayItems.length
      ? todayItems.map((i) => itemRowHTML(i)).join('')
      : '<div class="empty">Nothing scheduled for today. Add from Calendar or Todos.</div>';
    sl.innerHTML = soonItems.length
      ? soonItems.map((i) => itemRowHTML(i)).join('')
      : '<div class="empty">No upcoming items in the next few days.</div>';
    ag.innerHTML = attention.length
      ? attention
          .map((g) => {
            const pct = goalProgressPct(g);
            return `<div class="card attention" style="margin:0 0 8px;padding:10px;">
              <div class="card-title">${esc(g.title)} ${g.sample ? '<span class="badge badge-sample">sample</span>' : ''}</div>
              <div class="progress"><span style="width:${pct}%"></span></div>
              <div class="progress-label">${g.current}/${g.target} ${esc(g.unit || '')} · ${pct}% · ${esc(catName(g.categoryId))}</div>
            </div>`;
          })
          .join('')
      : '<div class="empty">All active goals look on track.</div>';

    bindItemList(tl);
    bindItemList(sl);
  }

  /* ---------- Calendar ---------- */
  function renderCalendar() {
    const y = state.calYear;
    const m = state.calMonth;
    const label = new Date(y, m, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    document.getElementById('cal-month-label').textContent = label;

    const dows = document.getElementById('cal-dows');
    if (!dows.childElementCount) {
      ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].forEach((d) => {
        const el = document.createElement('div');
        el.className = 'cal-dow';
        el.textContent = d;
        dows.appendChild(el);
      });
    }

    const first = new Date(y, m, 1);
    const startPad = first.getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const prevDays = new Date(y, m, 0).getDate();
    const itemDates = new Set(state.items.map((i) => i.date));
    const t = todayISO();

    const grid = document.getElementById('cal-grid');
    grid.innerHTML = '';

    const cells = [];
    for (let i = 0; i < startPad; i++) {
      const day = prevDays - startPad + i + 1;
      const pm = m === 0 ? 11 : m - 1;
      const py = m === 0 ? y - 1 : y;
      cells.push({ day, y: py, m: pm, other: true });
    }
    for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, y, m, other: false });
    while (cells.length % 7 !== 0 || cells.length < 42) {
      const i = cells.length - (startPad + daysInMonth);
      const nm = m === 11 ? 0 : m + 1;
      const ny = m === 11 ? y + 1 : y;
      cells.push({ day: i + 1, y: ny, m: nm, other: true });
      if (cells.length >= 42) break;
    }

    cells.forEach((c) => {
      const iso = `${c.y}-${String(c.m + 1).padStart(2, '0')}-${String(c.day).padStart(2, '0')}`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cal-day';
      if (c.other) btn.classList.add('other');
      if (iso === t) btn.classList.add('today');
      if (iso === state.selectedDate) btn.classList.add('selected');
      if (itemDates.has(iso)) btn.classList.add('has-items');
      btn.textContent = c.day;
      btn.dataset.date = iso;
      btn.addEventListener('click', () => {
        state.selectedDate = iso;
        renderCalendar();
      });
      grid.appendChild(btn);
    });

    const dayItems = state.items
      .filter((i) => i.date === state.selectedDate)
      .sort((a, b) => Number(a.done) - Number(b.done) || (a.time || '').localeCompare(b.time || ''));
    const box = document.getElementById('cal-day-items');
    box.innerHTML =
      `<div class="muted" style="margin-bottom:8px;">${esc(fmtDate(state.selectedDate))}</div>` +
      (dayItems.length
        ? dayItems.map((i) => itemRowHTML(i)).join('')
        : '<div class="empty">No items. Tap “Add for selected date”.</div>');
    bindItemList(box);
  }

  document.getElementById('cal-prev').addEventListener('click', () => {
    state.calMonth--;
    if (state.calMonth < 0) {
      state.calMonth = 11;
      state.calYear--;
    }
    renderCalendar();
  });
  document.getElementById('cal-next').addEventListener('click', () => {
    state.calMonth++;
    if (state.calMonth > 11) {
      state.calMonth = 0;
      state.calYear++;
    }
    renderCalendar();
  });
  document.getElementById('btn-add-cal-item').addEventListener('click', () => {
    openItemForm({ date: state.selectedDate, type: 'task', done: false });
  });

  /* ---------- Goals ---------- */
  function renderGoals() {
    const list = document.getElementById('goals-list');
    const goals = [...state.goals].sort((a, b) => (a.status === 'done') - (b.status === 'done') || b.updatedAt - a.updatedAt);
    if (!goals.length) {
      list.innerHTML = '<div class="empty">No goals yet.</div>';
      return;
    }
    list.innerHTML = goals
      .map((g) => {
        const pct = goalProgressPct(g);
        return `<div class="card" data-goal-id="${esc(g.id)}">
          <div class="row space-between">
            <div class="card-title">${esc(g.title)} ${g.sample ? '<span class="badge badge-sample">sample</span>' : ''} ${g.status === 'done' ? '<span class="badge badge-ok">done</span>' : ''}</div>
            <span class="badge badge-gold">${esc(catName(g.categoryId) || '—')}</span>
          </div>
          ${g.description ? `<p class="muted" style="margin:4px 0 0;">${esc(g.description)}</p>` : ''}
          <div class="progress"><span style="width:${pct}%"></span></div>
          <div class="row space-between">
            <span class="progress-label">${g.current} / ${g.target} ${esc(g.unit || '')} (${pct}%)</span>
            <div class="row gap-sm">
              <button type="button" class="btn btn-sm" data-gaction="edit">Edit</button>
              <button type="button" class="btn btn-sm btn-danger" data-gaction="del">Delete</button>
            </div>
          </div>
        </div>`;
      })
      .join('');

    if (!list._bound) {
      list._bound = true;
      list.addEventListener('click', async (e) => {
        const card = e.target.closest('[data-goal-id]');
        const action = e.target.closest('[data-gaction]')?.dataset.gaction;
        if (!card || !action) return;
        const id = card.dataset.goalId;
        if (action === 'edit') openGoalForm(await VBDB.get('goals', id));
        if (action === 'del') {
          if (!confirm('Delete this goal?')) return;
          await VBDB.remove('goals', id);
          // unlink items
          for (const it of state.items.filter((i) => i.goalId === id)) {
            it.goalId = null;
            await VBDB.put('items', it);
          }
          await refreshData();
          renderAll();
          toast('Goal deleted');
        }
      });
    }
  }

  function catOptions(selected) {
    return state.cats
      .map((c) => `<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`)
      .join('');
  }

  function goalOptions(selected) {
    const active = state.goals.filter((g) => g.status !== 'done' || g.id === selected);
    return (
      `<option value="">— None —</option>` +
      active.map((g) => `<option value="${esc(g.id)}" ${g.id === selected ? 'selected' : ''}>${esc(g.title)}</option>`).join('')
    );
  }

  function openGoalForm(goal) {
    const g = goal || {
      title: '',
      description: '',
      categoryId: state.cats[0]?.id || '',
      target: 5,
      current: 0,
      unit: 'tasks',
      status: 'active'
    };
    openModal(`
      <h3>${goal ? 'Edit goal' : 'New goal'}</h3>
      <div class="field"><label>Title</label><input id="f-g-title" value="${esc(g.title)}" required /></div>
      <div class="field"><label>Description</label><textarea id="f-g-desc">${esc(g.description || '')}</textarea></div>
      <div class="field"><label>Category</label><select id="f-g-cat">${catOptions(g.categoryId)}</select></div>
      <div class="field"><label>Current progress</label><input id="f-g-cur" type="number" min="0" value="${Number(g.current) || 0}" /></div>
      <div class="field"><label>Target</label><input id="f-g-target" type="number" min="1" value="${Number(g.target) || 5}" /></div>
      <div class="field"><label>Unit label</label><input id="f-g-unit" value="${esc(g.unit || '')}" placeholder="tasks, milestones…" /></div>
      <div class="field"><label>Status</label>
        <select id="f-g-status">
          <option value="active" ${g.status === 'active' ? 'selected' : ''}>Active</option>
          <option value="done" ${g.status === 'done' ? 'selected' : ''}>Done</option>
          <option value="paused" ${g.status === 'paused' ? 'selected' : ''}>Paused</option>
        </select>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="f-cancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="f-save">Save</button>
      </div>
    `);
    document.getElementById('f-cancel').onclick = closeModal;
    document.getElementById('f-save').onclick = async () => {
      const title = document.getElementById('f-g-title').value.trim();
      if (!title) return toast('Title required');
      const obj = {
        ...(goal || {}),
        id: g.id || VBDB.uid(),
        title,
        description: document.getElementById('f-g-desc').value.trim(),
        categoryId: document.getElementById('f-g-cat').value,
        current: Number(document.getElementById('f-g-cur').value) || 0,
        target: Number(document.getElementById('f-g-target').value) || 1,
        unit: document.getElementById('f-g-unit').value.trim(),
        status: document.getElementById('f-g-status').value,
        createdAt: g.createdAt || Date.now(),
        updatedAt: Date.now()
      };
      if (!goal) delete obj.sample;
      await VBDB.put('goals', obj);
      closeModal();
      await refreshData();
      renderAll();
      toast('Goal saved');
    };
  }

  document.getElementById('btn-add-goal').addEventListener('click', () => openGoalForm(null));

  function openCategoriesModal() {
    openModal(`
      <h3>Categories</h3>
      <div id="cat-edit-list"></div>
      <div class="field" style="margin-top:12px;"><label>New category name</label>
        <input id="f-new-cat" placeholder="Name" /></div>
      <div class="modal-actions">
        <button type="button" class="btn" id="f-add-cat">Add</button>
        <button type="button" class="btn btn-ghost" id="f-cancel">Close</button>
      </div>
    `);
    const list = document.getElementById('cat-edit-list');
    function paint() {
      list.innerHTML = state.cats
        .map(
          (c) => `<div class="row space-between" style="margin-bottom:8px;" data-cid="${esc(c.id)}">
            <input class="btn-sm" style="flex:1;min-height:36px;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:4px 8px;" value="${esc(c.name)}" data-cname />
            <button type="button" class="btn btn-sm btn-danger" data-cdel>Del</button>
          </div>`
        )
        .join('');
    }
    paint();
    list.onclick = async (e) => {
      const row = e.target.closest('[data-cid]');
      if (!row) return;
      if (e.target.matches('[data-cdel]')) {
        if (!confirm('Delete category?')) return;
        await VBDB.remove('categories', row.dataset.cid);
        await refreshData();
        paint();
        toast('Category removed');
      }
    };
    list.onchange = async (e) => {
      if (!e.target.matches('[data-cname]')) return;
      const row = e.target.closest('[data-cid]');
      const c = await VBDB.get('categories', row.dataset.cid);
      if (!c) return;
      c.name = e.target.value.trim() || c.name;
      await VBDB.put('categories', c);
      await refreshData();
      toast('Category updated');
    };
    document.getElementById('f-cancel').onclick = () => {
      closeModal();
      renderAll();
    };
    document.getElementById('f-add-cat').onclick = async () => {
      const name = document.getElementById('f-new-cat').value.trim();
      if (!name) return;
      await VBDB.put('categories', {
        id: VBDB.uid(),
        name,
        color: '#888890',
        order: state.cats.length
      });
      await refreshData();
      document.getElementById('f-new-cat').value = '';
      paint();
      toast('Category added');
    };
  }
  document.getElementById('btn-manage-cats').addEventListener('click', openCategoriesModal);

  /* ---------- Items / Todos ---------- */
  function openItemForm(item) {
    const it = item || {
      title: '',
      type: 'task',
      date: state.selectedDate || todayISO(),
      time: '',
      done: false,
      goalId: '',
      categoryId: '',
      notes: ''
    };
    openModal(`
      <h3>${item && item.id ? 'Edit item' : 'New item'}</h3>
      <div class="field"><label>Title</label><input id="f-i-title" value="${esc(it.title)}" /></div>
      <div class="field"><label>Type</label>
        <select id="f-i-type">
          ${Object.keys(TYPE_LABELS)
            .map((k) => `<option value="${k}" ${it.type === k ? 'selected' : ''}>${TYPE_LABELS[k]}</option>`)
            .join('')}
        </select>
      </div>
      <div class="field"><label>Date</label><input id="f-i-date" type="date" value="${esc(it.date || '')}" /></div>
      <div class="field"><label>Time (optional)</label><input id="f-i-time" type="time" value="${esc(it.time || '')}" /></div>
      <div class="field"><label>Link to goal</label><select id="f-i-goal">${goalOptions(it.goalId)}</select></div>
      <div class="field"><label>Category</label><select id="f-i-cat"><option value="">—</option>${catOptions(it.categoryId)}</select></div>
      <div class="field"><label>Notes</label><textarea id="f-i-notes">${esc(it.notes || '')}</textarea></div>
      <div class="modal-actions">
        ${item && item.id ? '<button type="button" class="btn btn-danger" id="f-del">Delete</button>' : ''}
        <button type="button" class="btn btn-ghost" id="f-cancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="f-save">Save</button>
      </div>
    `);
    document.getElementById('f-cancel').onclick = closeModal;
    const del = document.getElementById('f-del');
    if (del) {
      del.onclick = async () => {
        if (!confirm('Delete this item?')) return;
        if (it.done && it.goalId) {
          // reverse progress if completed
          await onItemDoneChange(it, true, false);
        }
        await VBDB.remove('items', it.id);
        closeModal();
        await refreshData();
        renderAll();
        toast('Deleted');
      };
    }
    document.getElementById('f-save').onclick = async () => {
      const title = document.getElementById('f-i-title').value.trim();
      if (!title) return toast('Title required');
      const date = document.getElementById('f-i-date').value;
      if (!date) return toast('Date required');
      const obj = {
        ...(item && item.id ? item : {}),
        id: (item && item.id) || VBDB.uid(),
        title,
        type: document.getElementById('f-i-type').value,
        date,
        time: document.getElementById('f-i-time').value || '',
        done: !!(item && item.done),
        goalId: document.getElementById('f-i-goal').value || null,
        categoryId: document.getElementById('f-i-cat').value || null,
        notes: document.getElementById('f-i-notes').value.trim(),
        createdAt: (item && item.createdAt) || Date.now(),
        updatedAt: Date.now()
      };
      if (!(item && item.id)) delete obj.sample;
      await VBDB.put('items', obj);
      closeModal();
      await refreshData();
      renderAll();
      toast('Saved');
    };
  }

  function renderTodos() {
    const hideDone = document.getElementById('todos-hide-done').checked;
    let items = state.items.filter((i) => i.type === 'task' || !i.type);
    // Also show all unfinished non-appointments? Spec: to-do list connected to calendar items — show tasks primarily, plus any undoned calendar items optional.
    // Show all items that are task-like OR all items as checklist filtered:
    items = state.items.slice();
    if (hideDone) items = items.filter((i) => !i.done);
    items.sort((a, b) => (a.date || '').localeCompare(b.date || '') || Number(a.done) - Number(b.done));

    const list = document.getElementById('todos-list');
    list.innerHTML = items.length
      ? items.map((i) => itemRowHTML(i)).join('')
      : '<div class="empty">No to-dos. Add one or create calendar items.</div>';
    bindItemList(list);
  }

  document.getElementById('btn-add-todo').addEventListener('click', () => {
    openItemForm({ type: 'task', date: todayISO(), done: false });
  });
  document.getElementById('todos-hide-done').addEventListener('change', () => renderTodos());

  /* ---------- Vision board ---------- */
  function renderVision() {
    const board = document.getElementById('vision-board');
    board.innerHTML = '';
    state.pins.forEach((p) => {
      const el = document.createElement('div');
      el.className = 'pin';
      el.dataset.id = p.id;
      el.style.left = (p.x || 10) + '%';
      el.style.top = (p.y || 10) + '%';
      if (p.color) el.style.borderColor = p.color;
      el.innerHTML =
        (p.imageUrl
          ? `<img class="pin-img" src="${esc(p.imageUrl)}" alt="" loading="lazy" onerror="this.style.display='none'" />`
          : '') +
        `<div>${esc(p.text)}</div>` +
        `<div class="pin-actions">
          <button type="button" data-paction="edit">Edit</button>
          <button type="button" data-paction="del">Del</button>
        </div>`;
      board.appendChild(el);
      enableDrag(el, p);
    });
    if (!board._bound) {
      board._bound = true;
      board.addEventListener('click', async (e) => {
        const pin = e.target.closest('.pin');
        const action = e.target.closest('[data-paction]')?.dataset.paction;
        if (!pin || !action) return;
        e.stopPropagation();
        const id = pin.dataset.id;
        if (action === 'del') {
          await VBDB.remove('pins', id);
          await refreshData();
          renderVision();
          toast('Pin removed');
        } else if (action === 'edit') {
          openPinForm(await VBDB.get('pins', id));
        }
      });
    }
  }

  let dragState = null;

  function clientXY(e) {
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX, y: t.clientY };
  }

  if (!window._vbDragBound) {
    window._vbDragBound = true;
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('touchmove', onDragMove, { passive: false });
    window.addEventListener('mouseup', onDragEnd);
    window.addEventListener('touchend', onDragEnd);
  }

  function onDragMove(e) {
    if (!dragState) return;
    const board = document.getElementById('vision-board');
    if (!board) return;
    const rect = board.getBoundingClientRect();
    const c = clientXY(e);
    const dx = ((c.x - dragState.startX) / rect.width) * 100;
    const dy = ((c.y - dragState.startY) / rect.height) * 100;
    const nx = Math.max(0, Math.min(85, dragState.origX + dx));
    const ny = Math.max(0, Math.min(85, dragState.origY + dy));
    dragState.el.style.left = nx + '%';
    dragState.el.style.top = ny + '%';
    dragState.nx = nx;
    dragState.ny = ny;
    e.preventDefault();
  }

  async function onDragEnd() {
    if (!dragState) return;
    const { pin, nx, ny } = dragState;
    dragState = null;
    if (nx == null) return;
    pin.x = nx;
    pin.y = ny;
    await VBDB.put('pins', pin);
  }

  function enableDrag(el, pin) {
    function onStart(e) {
      if (e.target.closest('[data-paction]')) return;
      const c = clientXY(e);
      dragState = {
        el,
        pin,
        startX: c.x,
        startY: c.y,
        origX: pin.x || 10,
        origY: pin.y || 10,
        nx: null,
        ny: null
      };
      e.preventDefault();
    }
    el.addEventListener('mousedown', onStart);
    el.addEventListener('touchstart', onStart, { passive: false });
  }

  function openPinForm(pin) {
    const p = pin || { text: '', imageUrl: '', x: 15 + Math.random() * 40, y: 15 + Math.random() * 40, color: '#c9a227' };
    openModal(`
      <h3>${pin ? 'Edit pin' : 'New pin'}</h3>
      <div class="field"><label>Text</label><textarea id="f-p-text">${esc(p.text)}</textarea></div>
      <div class="field"><label>Image URL (optional, small)</label><input id="f-p-img" value="${esc(p.imageUrl || '')}" placeholder="https://…" /></div>
      <div class="field"><label>Accent color</label><input id="f-p-color" type="color" value="${esc(p.color || '#c9a227')}" /></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="f-cancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="f-save">Save</button>
      </div>
    `);
    document.getElementById('f-cancel').onclick = closeModal;
    document.getElementById('f-save').onclick = async () => {
      const text = document.getElementById('f-p-text').value.trim();
      if (!text) return toast('Text required');
      const obj = {
        ...(pin || {}),
        id: (pin && pin.id) || VBDB.uid(),
        text,
        imageUrl: document.getElementById('f-p-img').value.trim(),
        color: document.getElementById('f-p-color').value,
        x: p.x,
        y: p.y,
        createdAt: (pin && pin.createdAt) || Date.now()
      };
      if (!pin) delete obj.sample;
      await VBDB.put('pins', obj);
      closeModal();
      await refreshData();
      renderVision();
      toast('Pin saved');
    };
  }
  document.getElementById('btn-add-pin').addEventListener('click', () => openPinForm(null));

  /* ---------- Export / Import / samples / reminders ---------- */
  document.getElementById('btn-export').addEventListener('click', async () => {
    const data = await VBDB.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `vision-board-backup-${todayISO()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Exported JSON');
  });

  document.getElementById('btn-import').addEventListener('click', () => {
    document.getElementById('import-file').click();
  });
  document.getElementById('import-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!confirm('Replace all local data with this backup?')) return;
      await VBDB.importAll(data);
      await refreshData();
      renderAll();
      toast('Import complete');
    } catch (err) {
      toast('Import failed: ' + (err.message || 'invalid file'));
    }
  });

  document.getElementById('btn-clear-sample').addEventListener('click', async () => {
    if (!confirm('Remove all sample goals, items, and pins?')) return;
    await VBDB.clearSampleData();
    await refreshData();
    renderAll();
    toast('Samples cleared');
  });

  document.getElementById('btn-reminders').addEventListener('click', async () => {
    const p = await VBReminders.requestPermission();
    if (p === 'granted') {
      toast('Reminders on');
      VBReminders.start();
    } else if (p === 'denied') toast('Notifications blocked — enable in browser settings');
    else if (p === 'unsupported') toast('Notifications not supported here');
    else toast('Permission: ' + p);
  });

  function renderAll() {
    if (state.view === 'today') renderToday();
    else if (state.view === 'calendar') renderCalendar();
    else if (state.view === 'goals') renderGoals();
    else if (state.view === 'todos') renderTodos();
    else if (state.view === 'vision') renderVision();
  }

  /* ---------- Boot ---------- */
  async function boot() {
    await VBDB.init();
    await VBSeed.ensureSeeded();
    await refreshData();
    renderAll();

    if ('serviceWorker' in navigator) {
      try {
        await navigator.serviceWorker.register('./sw.js');
      } catch (_) {
        /* file:// or restricted */
      }
    }

    // Auto-start reminder polling if already granted
    if ('Notification' in window && Notification.permission === 'granted') {
      VBReminders.start();
    }

    // Escape closes modal
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeModal();
    });
  }

  boot().catch((err) => {
    console.error(err);
    toast('Failed to start: ' + err.message);
  });
})();
