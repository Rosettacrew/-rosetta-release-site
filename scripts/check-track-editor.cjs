// Run with jsdom installed: node scripts/check-track-editor.cjs
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const assert = require('node:assert/strict');
(async () => {
  const html = fs.readFileSync('admin-dashboard.html', 'utf8');
  const code = html.slice(html.indexOf('      let trackDraft ='), html.indexOf('      q("previewAudio").onclick'));
  const dom = new JSDOM(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''), { runScripts: 'outside-only', url: 'https://example.test' });
  const w = dom.window, q = id => w.document.getElementById(id);
  let uploads = 0, failUpload = false, failAttach = false;
  const calls = [];
  Object.assign(w, {
    q, esc: s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
    rels: [{ id: 'album', tracks: [{id:'a',title:'First',track_number:1},{id:'b',title:'Second',track_number:2}] }],
    coverUrl: () => null, M: 'mock', setBusy: (b, on) => { b.disabled = on; }, loadR: async () => {},
    uploadAsset: async (id, kind, f) => { uploads++; if (failUpload) throw Error('Connection lost'); return {path:'album/tracks/'+f.name}; },
    af: async (url, opts) => {
      const b = JSON.parse(opts.body); calls.push(b);
      if (b.action === 'attach_uploaded_track') {
        if (failAttach) throw Error('Registration interrupted');
        const t = {id:'new-'+b.path,title:b.title,track_number:b.track_number}; w.rels[0].tracks.push(t); return {track:t};
      }
      if (b.action === 'save_track_order') { w.rels[0].tracks = b.tracks.map((t,i) => ({...t,track_number:i+1})); return {ok:true}; }
    },
  });
  q('uRelease').innerHTML = '<option value="album">Album</option><option value="other">Other</option>';
  w.eval(code + '\nsyncTrackEditor();');
  const click = selector => w.document.querySelector(selector).click();
  click('[data-move="1"][data-offset="-1"]');
  assert.equal(q('album-title-0').value, 'Second');
  q('album-title-0').value = 'Second renamed'; q('album-title-0').dispatchEvent(new w.Event('input', {bubbles:true}));
  Object.defineProperty(q('file'), 'files', {configurable:true, value:[new w.File(['test'],'Third.wav'),new w.File(['test'],'Fourth.mp3')]});
  await q('upload').onclick();
  assert.equal(w.document.querySelectorAll('[data-title]').length, 4);
  q('albumTracks').ondragstart({target:w.document.querySelector('[data-drag="3"]'),dataTransfer:{setData(){}},preventDefault(){}});
  q('albumTracks').ondrop({target:w.document.querySelector('[data-track-index="0"]'),preventDefault(){}});
  assert.equal(q('album-title-0').value, 'Fourth');
  failUpload = true;
  await q('saveTracks').onclick();
  assert.match(q('trackMsg').textContent, /Connection lost/);
  assert.equal(calls.filter(c => c.action === 'attach_uploaded_track').length, 0);
  failUpload = false; failAttach = true;
  await q('saveTracks').onclick();
  assert.match(q('trackMsg').textContent, /Registration interrupted/);
  const priorUploads = uploads;
  failAttach = false;
  await q('saveTracks').onclick();
  assert.equal(uploads, priorUploads + 1, 'Retry reuses already uploaded audio');
  assert.match(q('trackMsg').textContent, /order saved/);
  assert.deepEqual(Array.from(w.rels[0].tracks,t=>t.title), ['Fourth','Second renamed','First','Third']);
  await q('reloadTracks').onclick();
  assert.equal(q('album-title-0').value, 'Fourth');
  assert.equal(q('saveTracks').disabled, true);
  q('album-title-0').value = '<img src=x onerror=alert(1)>';
  q('album-title-0').dispatchEvent(new w.Event('input',{bubbles:true}));
  click('[data-move="0"][data-offset="1"]');
  assert.equal(q('albumTracks').querySelector('img'), null, 'Titles render as text');
  w.confirm = () => false; q('uRelease').value = 'other'; q('uRelease').onchange();
  assert.equal(q('uRelease').value, 'album', 'Unsaved switch can be cancelled');
  console.log('PASS: multi-file queue, title edits, buttons, drag order, failed upload, registration retry, saved reload, text escaping, unsaved-change guard.');
  dom.window.close();
})().catch(e => { console.error(e); process.exitCode = 1; });
