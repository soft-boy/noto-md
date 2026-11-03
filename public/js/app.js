import { Editor, IC } from './editor.js';
import { escapeHtml } from './inline.js';

const $ = (s) => document.querySelector(s);
const MD_EXT = /\.(md|markdown|mdown|mkd)$/i;

const ICONS = {
  chevron: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  folder: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>',
  page: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 2h5l3 3v8.5a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5z" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/><path d="M9 2v3h3M6 8h4M6 10.5h4" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>',
  pencil: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 13l.6-2.6L10.5 3.5l2 2-6.9 6.9z" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/></svg>',
};

const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(`noto:${key}`)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`noto:${key}`, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

const state = {
  name: '',
  tree: [],
  files: [],
  path: null,
  mtime: null,
  saved: '',
  dirty: false,
  saving: null,
  again: false,
  timer: null,
  mode: store.get('mode', 'blocks'),
  expanded: new Set(store.get('expanded', [])),
};

async function api(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: opts.body ? { 'Content-Type': 'application/json' } : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---- paths -----------------------------------------------------------------

const dirOf = (p) => (p && p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
const extOf = (p) => (baseName(p).match(MD_EXT) || ['.md'])[0];
const titleOf = (p) => baseName(p).replace(MD_EXT, '');
const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

function joinPath(base, rel) {
  const parts = rel.startsWith('/') || !base ? [] : base.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function decode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function resolveAsset(src) {
  if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) return src;
  return `/raw/${encodePath(joinPath(dirOf(state.path), decode(src.split(/[?#]/)[0])))}`;
}

const htmlBase = () => {
  const dir = dirOf(state.path);
  return `${location.origin}/raw/${dir ? `${encodePath(dir)}/` : ''}`;
};

const slugify = (s) => s.toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');

function scrollToHeading(anchor) {
  const want = slugify(decode(anchor));
  for (const h of document.querySelectorAll('#editor .block-heading .content')) {
    if (slugify(h.textContent) === want) {
      h.scrollIntoView({ block: 'start', behavior: 'smooth' });
      flash(h.closest('.block'));
      return;
    }
  }
}

function openLink(href) {
  if (!href) return;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    if (/^(https?|mailto):/i.test(href)) window.open(href, '_blank', 'noopener');
    return;
  }
  const [p, anchor] = href.split('#');
  if (!p) return anchor && scrollToHeading(anchor);
  const target = joinPath(dirOf(state.path), decode(p));
  const page = MD_EXT.test(target) ? target : state.files.find((f) => f === `${target}.md` || f === `${target}/README.md`);
  if (page) navigate(page, anchor);
  else window.open(`/raw/${encodePath(target)}`, '_blank', 'noopener');
}

// ---- editor ----------------------------------------------------------------

const editor = new Editor($('#editor'), {
  onChange: scheduleSave,
  resolveAsset,
  openLink,
  htmlBase,
});

const source = $('#source');

function currentContent() {
  return state.mode === 'source' ? source.value : editor.markdown();
}

function loadContent(content) {
  if (state.mode === 'source') {
    source.value = content;
    autosizeSource();
  } else {
    editor.load(content);
  }
}

function autosizeSource() {
  source.style.height = 'auto';
  source.style.height = `${source.scrollHeight + 2}px`;
}

function applyMode() {
  const src = state.mode === 'source';
  $('#editor').hidden = src;
  source.hidden = !src;
  $('#mode-toggle').textContent = src ? 'Blocks' : 'Markdown';
  $('#mode-toggle').title = src ? 'Back to the block editor' : 'Edit the raw Markdown source';
}

function toggleMode() {
  const content = currentContent();
  state.mode = state.mode === 'source' ? 'blocks' : 'source';
  store.set('mode', state.mode);
  applyMode();
  if (state.path) loadContent(content);
}

// ---- saving ----------------------------------------------------------------

function setStatus(text) {
  const el = $('#status');
  el.textContent = text;
  el.classList.toggle('fade', text === 'Saved');
}

function scheduleSave() {
  if (!state.path) return;
  state.dirty = true;
  setStatus('Editing…');
  clearTimeout(state.timer);
  state.timer = setTimeout(save, 500);
}

function save({ force = false } = {}) {
  clearTimeout(state.timer);
  if (!state.path) return Promise.resolve();
  if (state.saving) {
    state.again = true;
    return state.saving;
  }
  const path = state.path;
  const content = currentContent();
  if (content === state.saved && !force) {
    state.dirty = false;
    setStatus('Saved');
    return Promise.resolve();
  }
  setStatus('Saving…');
  state.saving = (async () => {
    try {
      const res = await api('/api/file', {
        method: 'PUT',
        body: JSON.stringify({ path, content, baseMtime: state.mtime, force }),
      });
      if (state.path === path) {
        state.mtime = res.mtime;
        state.saved = content;
        state.dirty = currentContent() !== content;
        hideBanner();
      }
      setStatus('Saved');
    } catch (err) {
      if (err.status === 409) showConflict();
      else {
        setStatus('Not saved');
        showBanner(`Couldn't save: ${err.message}`, [['Retry', () => save()]]);
      }
    } finally {
      state.saving = null;
      if (state.again) {
        state.again = false;
        save();
      }
    }
  })();
  return state.saving;
}

async function flushSave() {
  if (state.saving) await state.saving;
  if (state.dirty) await save();
}

window.addEventListener('pagehide', () => {
  if (!state.dirty || !state.path) return;
  fetch('/api/file', {
    method: 'PUT',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: state.path, content: currentContent(), baseMtime: state.mtime }),
  });
});

// ---- banner ----------------------------------------------------------------

function showBanner(text, actions = []) {
  const el = $('#banner');
  el.innerHTML = `<span>${escapeHtml(text)}</span>${actions.map((a, i) => `<button data-i="${i}">${escapeHtml(a[0])}</button>`).join('')}`;
  el.onclick = (e) => {
    const btn = e.target.closest('button');
    if (btn) actions[Number(btn.dataset.i)][1]();
  };
  el.hidden = false;
}

function hideBanner() {
  $('#banner').hidden = true;
}

function showConflict() {
  setStatus('Conflict');
  showBanner('This page was changed outside noto-md.', [
    ['Load the version on disk', () => reloadFromDisk()],
    ['Keep mine', () => save({ force: true })],
  ]);
}

async function reloadFromDisk() {
  const data = await api(`/api/file?path=${encodeURIComponent(state.path)}`);
  state.mtime = data.mtime;
  state.saved = data.content;
  state.dirty = false;
  loadContent(data.content);
  hideBanner();
  setStatus('Saved');
}

// ---- tree ------------------------------------------------------------------

function flattenFiles(nodes, out = []) {
  for (const n of nodes) {
    if (n.type === 'file') out.push(n.path);
    else flattenFiles(n.children, out);
  }
  return out;
}

async function loadTree() {
  state.tree = await api('/api/tree');
  state.files = flattenFiles(state.tree);
  renderTree();
}

function renderNodes(nodes, depth) {
  return nodes.map((n) => {
    const p = escapeHtml(n.path);
    if (n.type === 'dir') {
      const open = state.expanded.has(n.path);
      return `<div class="tree-row dir${open ? ' open' : ''}" data-path="${p}" data-type="dir" style="--depth:${depth}" title="${p}">
        <span class="chev">${ICONS.chevron}</span><span class="tr-icon">${ICONS.folder}</span>
        <span class="tr-name">${escapeHtml(n.name)}</span>
        <button class="tr-act" data-act="new" title="New page in ${escapeHtml(n.name)}">${IC.plus}</button>
      </div>${open ? renderNodes(n.children, depth + 1) : ''}`;
    }
    return `<a class="tree-row file${n.path === state.path ? ' active' : ''}" href="#/${escapeHtml(encodePath(n.path))}" data-path="${p}" data-type="file" style="--depth:${depth}" title="${p}">
      <span class="chev"></span><span class="tr-icon">${ICONS.page}</span>
      <span class="tr-name">${escapeHtml(titleOf(n.name))}</span>
      <button class="tr-act" data-act="rename" title="Rename">${ICONS.pencil}</button>
    </a>`;
  }).join('');
}

function renderTree() {
  const nav = $('#tree');
  nav.innerHTML = state.tree.length ? renderNodes(state.tree, 0) : '<div class="tree-empty">No Markdown files here yet.</div>';
}

function expandTo(path) {
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) state.expanded.add(parts.slice(0, i).join('/'));
  store.set('expanded', [...state.expanded]);
}

$('#tree').addEventListener('click', (e) => {
  const row = e.target.closest('.tree-row');
  if (!row) return;
  const act = e.target.closest('.tr-act');
  if (act) {
    e.preventDefault();
    if (act.dataset.act === 'new') newPage(row.dataset.path);
    else renamePrompt(row.dataset.path);
    return;
  }
  if (row.dataset.type === 'dir') {
    const p = row.dataset.path;
    if (state.expanded.has(p)) state.expanded.delete(p); else state.expanded.add(p);
    store.set('expanded', [...state.expanded]);
    renderTree();
  }
});

// ---- pages -----------------------------------------------------------------

const cleanName = (s) => s.trim().replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+/, '');

async function newPage(dir = '') {
  const name = prompt(dir ? `New page in ${dir}/` : 'New page name');
  if (!name || !cleanName(name)) return;
  const file = MD_EXT.test(cleanName(name)) ? cleanName(name) : `${cleanName(name)}.md`;
  const path = dir ? `${dir}/${file}` : file;
  try {
    await api('/api/files', { method: 'POST', body: JSON.stringify({ path, content: '' }) });
  } catch (err) {
    alert(err.message);
    return;
  }
  await loadTree();
  navigate(path);
}

async function renamePage(from, newTitle) {
  const name = cleanName(newTitle);
  if (!name) return false;
  const to = joinPath(dirOf(from), MD_EXT.test(name) ? name : name + extOf(from));
  if (to === from) return true;
  if (from === state.path) await flushSave();
  try {
    await api('/api/rename', { method: 'POST', body: JSON.stringify({ from, to }) });
  } catch (err) {
    alert(err.message);
    return false;
  }
  if (from === state.path) {
    state.path = to;
    history.replaceState(null, '', `#/${encodePath(to)}`);
    renderHeader();
  }
  await loadTree();
  return true;
}

function renamePrompt(path) {
  const name = prompt('Rename page', titleOf(path));
  if (name != null) renamePage(path, name);
}

function navigate(path, anchor) {
  const hash = `#/${encodePath(path)}`;
  if (location.hash === hash) {
    if (anchor) scrollToHeading(anchor);
  } else {
    pendingAnchor = anchor;
    location.hash = hash;
  }
}

let pendingAnchor = null;

function renderHeader() {
  const crumbs = [state.name, ...dirOf(state.path).split('/').filter(Boolean)];
  $('#crumbs').innerHTML = [...crumbs.map((c) => `<span class="crumb">${escapeHtml(c)}</span>`), `<span class="crumb current">${escapeHtml(titleOf(state.path))}</span>`]
    .join('<span class="crumb-sep">/</span>');
  $('#title').textContent = titleOf(state.path);
  document.title = `${titleOf(state.path)} · noto-md`;
}

function showPage(on) {
  $('#page').hidden = !on;
  $('#empty').hidden = on;
  $('#topbar-actions').hidden = !on;
}

function showEmpty(message) {
  state.path = null;
  showPage(false);
  $('#crumbs').innerHTML = `<span class="crumb">${escapeHtml(state.name)}</span>`;
  $('#empty-text').textContent = message;
  document.title = 'noto-md';
}

async function openPath(path) {
  if (path === state.path) return;
  await flushSave();
  let data;
  try {
    data = await api(`/api/file?path=${encodeURIComponent(path)}`);
  } catch (err) {
    showEmpty(err.status === 404 ? `“${path}” doesn't exist anymore.` : `Couldn't open ${path}: ${err.message}`);
    renderTree();
    return;
  }
  state.path = path;
  state.mtime = data.mtime;
  state.saved = data.content;
  state.dirty = false;
  hideBanner();
  setStatus('');
  expandTo(path);
  renderTree();
  renderHeader();
  showPage(true);
  loadContent(data.content);
  $('#scroller').scrollTop = 0;
  if (pendingAnchor) scrollToHeading(pendingAnchor);
  pendingAnchor = null;
  if (!data.content.trim()) {
    if (state.mode === 'source') source.focus(); else editor.focusStart();
  }
  document.querySelector('.tree-row.active')?.scrollIntoView({ block: 'nearest' });
}

function routeFromHash() {
  const m = location.hash.match(/^#\/(.+)$/);
  return m ? decode(m[1]) : null;
}

function defaultPage() {
  const prefer = ['README.md', 'readme.md', 'Readme.md', 'index.md'];
  return prefer.find((p) => state.files.includes(p)) || state.files[0] || null;
}

async function route() {
  const path = routeFromHash();
  if (path) return openPath(path);
  const def = defaultPage();
  if (def) {
    history.replaceState(null, '', `#/${encodePath(def)}`);
    return openPath(def);
  }
  showEmpty('This folder has no Markdown files yet.');
}

window.addEventListener('hashchange', route);

// ---- title -----------------------------------------------------------------

const title = $('#title');
title.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || (e.key === 'ArrowDown' && !e.shiftKey)) {
    e.preventDefault();
    title.blur();
    editor.focusStart();
  } else if (e.key === 'Escape') {
    title.textContent = titleOf(state.path);
    title.blur();
  }
});
title.addEventListener('paste', (e) => {
  e.preventDefault();
  document.execCommand('insertText', false, e.clipboardData.getData('text/plain').replace(/\s+/g, ' '));
});
title.addEventListener('blur', async () => {
  if (!state.path) return;
  const text = title.textContent.trim();
  if (text === titleOf(state.path)) return;
  if (!(await renamePage(state.path, text))) title.textContent = titleOf(state.path);
});

// ---- search ----------------------------------------------------------------

const search = { el: $('#search'), input: $('#search-input'), list: $('#search-results'), items: [], active: 0, timer: null, seq: 0 };

function fuzzyScore(q, s) {
  s = s.toLowerCase();
  const idx = s.indexOf(q);
  if (idx >= 0) return 100 - idx - s.length * 0.01 + (baseName(s).includes(q) ? 50 : 0);
  let j = 0;
  for (const ch of s) if (ch === q[j]) j++;
  return j === q.length ? 10 - s.length * 0.01 : -1;
}

function openSearch() {
  search.el.hidden = false;
  search.input.value = '';
  renderSearch(state.files.slice(0, 12).map((path) => ({ path })));
  search.input.focus();
}

function closeSearch() {
  search.el.hidden = true;
}

function renderSearch(items) {
  search.items = items;
  search.active = 0;
  search.list.innerHTML = items.length ? items.map((it, i) => `
    <div class="sr${i === 0 ? ' active' : ''}" data-i="${i}">
      <span class="sr-icon">${ICONS.page}</span>
      <span class="sr-main"><span class="sr-title">${escapeHtml(titleOf(it.path))}</span>
      <span class="sr-sub">${it.text ? escapeHtml(it.text) : escapeHtml(dirOf(it.path) || state.name)}</span></span>
    </div>`).join('') : '<div class="sr-empty">No results</div>';
}

function runSearch() {
  const q = search.input.value.trim().toLowerCase();
  if (!q) return renderSearch(state.files.slice(0, 12).map((path) => ({ path })));
  const byName = state.files.map((path) => ({ path, score: fuzzyScore(q, path) }))
    .filter((r) => r.score >= 0).sort((a, b) => b.score - a.score).slice(0, 8);
  renderSearch(byName);
  clearTimeout(search.timer);
  const seq = ++search.seq;
  search.timer = setTimeout(async () => {
    const hits = await api(`/api/search?q=${encodeURIComponent(q)}`).catch(() => []);
    if (seq !== search.seq) return;
    const content = hits.filter((h) => h.line).map((h) => ({ path: h.path, text: h.text, q }));
    renderSearch([...byName, ...content].slice(0, 30));
  }, 150);
}

function pickSearch(i) {
  const it = search.items[i];
  if (!it) return;
  closeSearch();
  const go = () => it.text && highlightText(it.q);
  if (it.path === state.path) go();
  else {
    navigate(it.path);
    afterOpen = go;
  }
}

let afterOpen = null;
window.addEventListener('hashchange', () => {
  const fn = afterOpen;
  afterOpen = null;
  if (fn) setTimeout(fn, 150);
});

function flash(el) {
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

function highlightText(q) {
  const block = [...document.querySelectorAll('#editor .block')].find((b) => b.textContent.toLowerCase().includes(q)
    || [...b.querySelectorAll('textarea')].some((t) => t.value.toLowerCase().includes(q)));
  if (!block) return;
  block.scrollIntoView({ block: 'center', behavior: 'smooth' });
  flash(block);
}

search.input.addEventListener('input', runSearch);
search.input.addEventListener('keydown', (e) => {
  const rows = search.list.querySelectorAll('.sr');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!rows.length) return;
    search.active = (search.active + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
    rows.forEach((r, i) => r.classList.toggle('active', i === search.active));
    rows[search.active].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    pickSearch(search.active);
  } else if (e.key === 'Escape') {
    closeSearch();
  }
});
search.list.addEventListener('click', (e) => {
  const row = e.target.closest('.sr');
  if (row) pickSearch(Number(row.dataset.i));
});
search.el.addEventListener('mousedown', (e) => {
  if (e.target === search.el) closeSearch();
});

// ---- chrome ----------------------------------------------------------------

function setSidebar(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  store.set('sidebarCollapsed', collapsed);
}

$('#collapse').addEventListener('click', () => setSidebar(true));
$('#expand').addEventListener('click', () => setSidebar(false));
$('#search-btn').addEventListener('click', openSearch);
$('#new-page').addEventListener('click', () => newPage(''));
$('#empty-new').addEventListener('click', () => newPage(''));
$('#mode-toggle').addEventListener('click', toggleMode);
source.addEventListener('input', () => {
  autosizeSource();
  scheduleSave();
});
$('#page-end').addEventListener('click', () => {
  if (state.mode === 'source') source.focus(); else editor.focusEnd();
});

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && (e.key.toLowerCase() === 'k' || e.key.toLowerCase() === 'p') && !document.activeElement?.closest?.('#editor')) {
    e.preventDefault();
    openSearch();
  } else if (mod && e.key.toLowerCase() === 'p') {
    e.preventDefault();
    openSearch();
  } else if (mod && e.key === '\\') {
    e.preventDefault();
    setSidebar(!document.body.classList.contains('sidebar-collapsed'));
  } else if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    save();
  } else if (mod && e.shiftKey && e.key.toLowerCase() === 'm') {
    e.preventDefault();
    toggleMode();
  }
});

// ---- live updates ----------------------------------------------------------

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'tree') {
      clearTimeout(connectEvents.treeTimer);
      connectEvents.treeTimer = setTimeout(loadTree, 100);
    }
    if (msg.type !== 'file' || msg.path !== state.path || state.saving || msg.mtime === state.mtime) return;
    if (msg.mtime == null) {
      showBanner('This page was deleted or moved outside noto-md. Keep editing to recreate it.');
      return;
    }
    const data = await api(`/api/file?path=${encodeURIComponent(state.path)}`).catch(() => null);
    if (!data || data.path !== state.path) return;
    if (data.content === state.saved || data.content === currentContent()) {
      state.mtime = data.mtime;
      state.saved = data.content;
      return;
    }
    if (state.dirty) return showConflict();
    state.mtime = data.mtime;
    state.saved = data.content;
    loadContent(data.content);
    setStatus('Updated from disk');
  };
}

// ---- boot ------------------------------------------------------------------

async function boot() {
  setSidebar(store.get('sidebarCollapsed', false));
  applyMode();
  const info = await api('/api/info');
  state.name = info.name;
  $('#ws-name').textContent = info.name;
  $('#ws-icon').textContent = (info.name[0] || 'N').toUpperCase();
  $('#ws-name').title = info.root;
  await loadTree();
  await route();
  connectEvents();
}

boot().catch((err) => showEmpty(`Couldn't start: ${err.message}`));
