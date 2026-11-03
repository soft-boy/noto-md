import { parse, serialize, createBlock, uid, numberOf, LIST_TYPES, TEXT_TYPES, CALLOUT_KINDS } from './markdown.js';
import { mdToHtml, htmlToMd, escapeHtml } from './inline.js';
import {
  textOffset, setTextOffset, rangeAt, placeAtEnd, placeAtStart, placeAtX,
  atStart, atEnd, onFirstLine, onLastLine, caretRect, splitContents,
} from './caret.js';
import { Menu } from './menu.js';

const svg = (d, size = 16) => `<svg viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true">${d}</svg>`;
export const IC = {
  plus: svg('<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>'),
  grip: svg('<g fill="currentColor"><circle cx="5.5" cy="3.5" r="1.2"/><circle cx="10.5" cy="3.5" r="1.2"/><circle cx="5.5" cy="8" r="1.2"/><circle cx="10.5" cy="8" r="1.2"/><circle cx="5.5" cy="12.5" r="1.2"/><circle cx="10.5" cy="12.5" r="1.2"/></g>'),
  trash: svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round"/>'),
  copy: svg('<rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M10.5 3.5V3a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v5.5a1 1 0 0 0 1 1h.5" stroke="currentColor" stroke-width="1.3" fill="none"/>'),
  up: svg('<path d="M8 13V3M4 7l4-4 4 4" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'),
  down: svg('<path d="M8 3v10M4 9l4 4 4-4" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'),
  image: svg('<rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.3" fill="none"/><circle cx="6" cy="6.5" r="1.2" fill="currentColor"/><path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3" stroke="currentColor" stroke-width="1.3" fill="none"/>'),
};

export const BLOCK_SPECS = [
  { type: 'paragraph', label: 'Text', desc: 'Just start writing with plain text.', icon: 'Aa', keywords: ['text', 'paragraph', 'plain'] },
  { type: 'heading', level: 1, label: 'Heading 1', desc: 'Big section heading.', icon: 'H1', hint: '#', keywords: ['h1', 'title'] },
  { type: 'heading', level: 2, label: 'Heading 2', desc: 'Medium section heading.', icon: 'H2', hint: '##', keywords: ['h2', 'subtitle'] },
  { type: 'heading', level: 3, label: 'Heading 3', desc: 'Small section heading.', icon: 'H3', hint: '###', keywords: ['h3'] },
  { type: 'bullet', label: 'Bulleted list', desc: 'Create a simple bulleted list.', icon: '•', hint: '-', keywords: ['ul', 'unordered', 'bullet'] },
  { type: 'numbered', label: 'Numbered list', desc: 'Create a list with numbering.', icon: '1.', hint: '1.', keywords: ['ol', 'ordered', 'number'] },
  { type: 'todo', label: 'To-do list', desc: 'Track tasks with a to-do list.', icon: '☑', hint: '[]', keywords: ['todo', 'task', 'checkbox', 'check'] },
  { type: 'quote', label: 'Quote', desc: 'Capture a quote.', icon: '❝', hint: '>', keywords: ['blockquote', 'citation'] },
  { type: 'callout', label: 'Callout', desc: 'Make writing stand out.', icon: '💡', keywords: ['note', 'tip', 'warning', 'alert', 'admonition'] },
  { type: 'code', label: 'Code', desc: 'Capture a code snippet.', icon: '&lt;/&gt;', hint: '```', keywords: ['snippet', 'pre', 'fence'] },
  { type: 'divider', label: 'Divider', desc: 'Visually divide blocks.', icon: '—', hint: '---', keywords: ['hr', 'line', 'separator', 'rule'] },
  { type: 'table', label: 'Table', desc: 'Add a simple table.', icon: '⊞', keywords: ['grid', 'rows', 'columns'] },
  { type: 'image', label: 'Image', desc: 'Embed an image by URL or path.', icon: IC.image, keywords: ['picture', 'img', 'photo'] },
];
const INSERT_ONLY = new Set(['divider', 'table', 'image']);
const CALLOUT_ICONS = { note: 'ℹ️', tip: '💡', important: '📌', warning: '⚠️', caution: '🛑' };

const SHORTCUTS = [
  { re: /^(#{1,3}) /, spec: (m) => ({ type: 'heading', level: m[1].length }) },
  { re: /^[-*+] /, spec: () => ({ type: 'bullet' }) },
  { re: /^(\d+)[.)] /, spec: (m) => ({ type: 'numbered', num: Number(m[1]) }) },
  { re: /^\[(x| )?\] /i, spec: (m) => ({ type: 'todo', checked: (m[1] || '').toLowerCase() === 'x' }) },
  { re: /^> /, spec: () => ({ type: 'quote' }) },
  { re: /^```$/, spec: () => ({ type: 'code' }) },
  { re: /^---$/, spec: () => ({ type: 'divider' }) },
];

// Notion-style shortcuts: ⌘⌥0 text, 1–3 headings, 4 to-do, 5 bullets, 6 numbers, 8 code.
const DIGIT_SPECS = {
  Digit0: { type: 'paragraph' }, Digit1: { type: 'heading', level: 1 }, Digit2: { type: 'heading', level: 2 },
  Digit3: { type: 'heading', level: 3 }, Digit4: { type: 'todo' }, Digit5: { type: 'bullet' },
  Digit6: { type: 'numbered' }, Digit8: { type: 'code' },
};

const rowsFor = (s) => Math.max(1, s.split('\n').length);

function toLetters(n) {
  let s = '';
  while (n > 0) { n--; s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}
function toRoman(n) {
  const map = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let s = '';
  for (const [v, r] of map) while (n >= v) { s += r; n -= v; }
  return s;
}
const formatNumber = (n, level) => (level % 3 === 1 ? toLetters(n) : level % 3 === 2 ? toRoman(n) : String(n));

export class Editor {
  constructor(root, opts) {
    this.root = root;
    this.opts = opts; // { onChange, resolveAsset, openLink, htmlBase }
    this.doc = { lead: '', eol: '\n', blocks: [] };
    this.els = new Map();
    this.undoStack = [];
    this.redoStack = [];
    this.menu = new Menu();
    this.slash = null;
    this.toolbar = this.createToolbar();

    root.addEventListener('beforeinput', (e) => this.onBeforeInput(e));
    root.addEventListener('input', (e) => this.onInput(e));
    root.addEventListener('keydown', (e) => this.onKeyDown(e));
    root.addEventListener('paste', (e) => this.onPaste(e));
    root.addEventListener('click', (e) => this.onClick(e));
    root.addEventListener('focusin', (e) => this.onFocusIn(e));
    root.addEventListener('focusout', (e) => this.onFocusOut(e));
    root.addEventListener('dragstart', (e) => this.onDragStart(e));
    root.addEventListener('dragover', (e) => this.onDragOver(e));
    root.addEventListener('drop', (e) => this.onDrop(e));
    root.addEventListener('dragend', () => this.endDrag());
    document.addEventListener('selectionchange', () => this.updateToolbar());
    window.addEventListener('scroll', () => this.updateToolbar(), true);
  }

  // ---- public API --------------------------------------------------------

  load(markdown) {
    this.menu.close();
    this.doc = parse(markdown);
    if (!this.doc.blocks.length) this.doc.blocks.push(createBlock('paragraph'));
    this.undoStack = [];
    this.redoStack = [];
    this.renderAll();
  }

  markdown() {
    return serialize(this.doc);
  }

  focusStart() {
    const first = this.doc.blocks[0];
    if (first) this.focusBlock(first, 'start');
  }

  // Click below the last block: continue in an empty paragraph.
  focusEnd() {
    const last = this.doc.blocks[this.doc.blocks.length - 1];
    if (last && last.type === 'paragraph' && !last.text) return this.focusBlock(last, 'end');
    const nb = createBlock('paragraph');
    this.insertAfter(last, nb);
    this.focusBlock(nb, 'start');
  }

  // ---- model helpers -----------------------------------------------------

  get(id) { return this.doc.blocks.find((b) => b.id === id); }
  indexOf(b) { return this.doc.blocks.indexOf(b); }
  prev(b) { return this.doc.blocks[this.indexOf(b) - 1]; }
  next(b) { return this.doc.blocks[this.indexOf(b) + 1]; }
  contentEl(b) { return this.els.get(b.id)?.querySelector('.content'); }

  blockFrom(target) {
    const el = target?.closest?.('.block');
    return el && this.root.contains(el) ? [this.get(el.dataset.id), el] : [null, null];
  }

  touch(b) {
    if (b) b.dirty = true;
    this.opts.onChange?.();
  }

  checkpoint() {
    const snap = JSON.stringify(this.doc.blocks);
    if (this.undoStack[this.undoStack.length - 1] !== snap) {
      this.undoStack.push(snap);
      if (this.undoStack.length > 300) this.undoStack.shift();
    }
    this.redoStack = [];
  }

  undo() {
    const cur = JSON.stringify(this.doc.blocks);
    let snap;
    do snap = this.undoStack.pop(); while (snap === cur);
    if (!snap) return;
    this.redoStack.push(cur);
    this.restore(snap);
  }

  redo() {
    const snap = this.redoStack.pop();
    if (!snap) return;
    this.undoStack.push(JSON.stringify(this.doc.blocks));
    this.restore(snap);
  }

  restore(snap) {
    const focusId = this.focusedId;
    this.doc.blocks = JSON.parse(snap);
    this.typing = false;
    this.menu.close();
    this.renderAll();
    const b = this.get(focusId) || this.doc.blocks[this.doc.blocks.length - 1];
    if (b) this.focusBlock(b, 'end');
    this.opts.onChange?.();
  }

  insertAfter(ref, nb) {
    const i = ref ? this.indexOf(ref) : -1;
    this.doc.blocks.splice(i + 1, 0, nb);
    const el = this.renderBlock(nb);
    if (ref) this.els.get(ref.id).after(el); else this.root.prepend(el);
    this.refreshMarkers();
  }

  insertBefore(ref, nb) {
    this.doc.blocks.splice(this.indexOf(ref), 0, nb);
    this.els.get(ref.id).before(this.renderBlock(nb));
    this.refreshMarkers();
  }

  replaceBlock(old, nb) {
    this.doc.blocks.splice(this.indexOf(old), 1, nb);
    this.els.get(old.id).replaceWith(this.renderBlock(nb));
    this.els.delete(old.id);
    this.refreshMarkers();
  }

  removeBlock(b) {
    this.doc.blocks.splice(this.indexOf(b), 1);
    this.els.get(b.id)?.remove();
    this.els.delete(b.id);
    if (!this.doc.blocks.length) {
      const p = createBlock('paragraph');
      this.doc.blocks.push(p);
      this.root.append(this.renderBlock(p));
    }
    this.refreshMarkers();
  }

  rerender(b) {
    const old = this.els.get(b.id);
    old.replaceWith(this.renderBlock(b));
    this.refreshMarkers();
  }

  setContent(b) {
    const c = this.contentEl(b);
    if (c) c.innerHTML = this.inline(b.text);
  }

  moveBlock(b, toIndex) {
    const from = this.indexOf(b);
    if (toIndex === from || toIndex < 0 || toIndex >= this.doc.blocks.length) return;
    this.checkpoint();
    this.doc.blocks.splice(from, 1);
    this.doc.blocks.splice(toIndex, 0, b);
    const el = this.els.get(b.id);
    const after = this.doc.blocks[toIndex - 1];
    if (after) this.els.get(after.id).after(el); else this.root.prepend(el);
    this.refreshMarkers();
    this.touch();
  }

  continuation(b) {
    if (LIST_TYPES.has(b.type)) {
      return createBlock(b.type, {
        level: b.level, origLevel: b.origLevel, indent: b.indent, marker: b.marker, delim: b.delim, checked: false,
      });
    }
    return createBlock('paragraph', { indent: b.type === 'paragraph' ? b.indent : '' });
  }

  // ---- rendering ---------------------------------------------------------

  inline(md) {
    return mdToHtml(md || '', { resolve: this.opts.resolveAsset });
  }

  renderAll() {
    this.els.clear();
    this.root.replaceChildren(...this.doc.blocks.map((b) => this.renderBlock(b)));
    this.refreshMarkers();
  }

  editable(b, placeholder) {
    const c = document.createElement('div');
    c.className = 'content';
    c.contentEditable = 'true';
    c.dataset.placeholder = placeholder;
    c.innerHTML = this.inline(b.text);
    return c;
  }

  textarea(value, cls) {
    const ta = document.createElement('textarea');
    ta.className = `content ${cls}`;
    ta.value = value || '';
    ta.spellcheck = false;
    ta.rows = rowsFor(ta.value);
    ta.setAttribute('wrap', 'off');
    return ta;
  }

  renderBlock(b) {
    const el = document.createElement('div');
    el.className = `block block-${b.type}`;
    el.dataset.id = b.id;
    if (b.type === 'heading') el.classList.add(`h${Math.min(b.level, 4)}`);
    if (LIST_TYPES.has(b.type)) el.style.setProperty('--level', b.level);
    el.innerHTML = `<div class="gutter" contenteditable="false">
      <button class="g-add" tabindex="-1" title="Click to add a block below&#10;Alt-click to add above">${IC.plus}</button>
      <button class="g-handle" tabindex="-1" draggable="true" title="Drag to move&#10;Click to open menu">${IC.grip}</button>
    </div><div class="body"></div>`;
    const body = el.lastElementChild;
    this.els.set(b.id, el);
    const marker = (html = '') => {
      const m = document.createElement('div');
      m.className = 'marker';
      m.contentEditable = 'false';
      m.innerHTML = html;
      return m;
    };

    switch (b.type) {
      case 'paragraph':
        body.append(this.editable(b, "Type '/' for commands"));
        break;
      case 'heading':
        body.append(this.editable(b, `Heading ${b.level}`));
        break;
      case 'bullet':
      case 'numbered':
        body.append(marker(), this.editable(b, 'List'));
        break;
      case 'todo':
        body.append(marker(`<input type="checkbox" tabindex="-1"${b.checked ? ' checked' : ''}>`), this.editable(b, 'To-do'));
        el.classList.toggle('checked', !!b.checked);
        break;
      case 'quote':
        body.append(this.editable(b, 'Empty quote'));
        break;
      case 'callout': {
        el.classList.add(`kind-${b.kind}`);
        const icon = marker(`<button class="callout-icon" tabindex="-1" title="${b.kind[0].toUpperCase() + b.kind.slice(1)} — click to change">${CALLOUT_ICONS[b.kind] || '💡'}</button>`);
        body.append(icon, this.editable(b, 'Type something…'));
        break;
      }
      case 'code': {
        body.innerHTML = `<div class="code-wrap"><div class="code-bar">
          <input class="code-lang" spellcheck="false" placeholder="plain text" value="${escapeHtml(b.lang || '')}">
          <button class="code-copy" tabindex="-1">Copy</button></div></div>`;
        body.firstChild.append(this.textarea(b.text, 'code'));
        break;
      }
      case 'html': {
        body.innerHTML = `<div class="html-wrap"><div class="html-label">HTML</div>
          <div class="html-preview"><iframe sandbox="allow-same-origin" tabindex="-1" title="HTML preview"></iframe>
          <div class="html-cover" title="Click to edit HTML"></div></div></div>`;
        body.firstChild.append(this.textarea(b.text, 'code'));
        this.fillPreview(body.querySelector('iframe'), b.text);
        break;
      }
      case 'frontmatter':
        body.innerHTML = '<div class="fm"><div class="fm-label">Properties</div></div>';
        body.firstChild.append(this.textarea(b.text, 'code'));
        break;
      case 'divider':
        body.innerHTML = '<div class="divider" tabindex="0"><hr></div>';
        break;
      case 'image':
        this.renderImage(b, body);
        break;
      case 'table':
        this.renderTable(b, body);
        break;
      default:
        body.append(this.textarea(b.text, 'code'));
    }
    return el;
  }

  renderImage(b, body) {
    const src = b.src ? this.opts.resolveAsset(b.src) : '';
    body.innerHTML = `<figure class="image-fig" tabindex="0">${src
      ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(b.alt || '')}">${b.alt ? `<figcaption>${escapeHtml(b.alt)}</figcaption>` : ''}`
      : `<div class="image-empty">${IC.image}<span>Add an image</span></div>`}</figure>
      <div class="image-edit">
        <input class="img-src" spellcheck="false" placeholder="Image URL or relative path" value="${escapeHtml(b.src || '')}">
        <input class="img-alt" placeholder="Caption (alt text)" value="${escapeHtml(b.alt || '')}">
      </div>`;
    body.parentElement.classList.toggle('no-src', !b.src);
  }

  renderTable(b, body) {
    let html = '<div class="table-wrap"><table><tbody>';
    b.rows.forEach((row, r) => {
      html += '<tr>';
      row.forEach((cell, c) => {
        const tag = r === 0 ? 'th' : 'td';
        const al = b.align?.[c];
        html += `<${tag} contenteditable="true" data-r="${r}" data-c="${c}"${al ? ` style="text-align:${al}"` : ''}>${this.inline(cell)}</${tag}>`;
      });
      html += '</tr>';
    });
    html += `</tbody></table></div><div class="table-tools" contenteditable="false">
      <button data-t="row" tabindex="-1">+ Row</button><button data-t="col" tabindex="-1">+ Column</button>
      <button data-t="delrow" tabindex="-1">− Row</button><button data-t="delcol" tabindex="-1">− Column</button></div>`;
    body.innerHTML = html;
  }

  fillPreview(frame, html) {
    const color = getComputedStyle(document.body).color;
    frame.srcdoc = `<!doctype html><html><head><base href="${escapeHtml(this.opts.htmlBase())}" target="_blank">
      <style>body{display:flow-root}html,body{margin:0;background:transparent;color:${color};font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
      body>:first-child{margin-top:0}body>:last-child{margin-bottom:0}img,video{max-width:100%}a{color:inherit}</style>
      </head><body>${html}</body></html>`;
    frame.onload = () => {
      const doc = frame.contentDocument;
      if (!doc) return;
      const fit = () => { frame.style.height = `${Math.max(24, Math.ceil(doc.body.getBoundingClientRect().height))}px`; };
      fit();
      doc.querySelectorAll('img').forEach((img) => img.addEventListener('load', fit));
    };
  }

  refreshMarkers() {
    const blocks = this.doc.blocks;
    blocks.forEach((b, k) => {
      if (b.type !== 'numbered' && b.type !== 'bullet') return;
      const mk = this.els.get(b.id)?.querySelector('.body > .marker');
      if (!mk) return;
      mk.textContent = b.type === 'numbered' ? `${formatNumber(numberOf(blocks, k), b.level)}.` : ['•', '◦', '▪'][b.level % 3];
    });
  }

  focusTarget(b) {
    const el = this.els.get(b.id);
    if (!el) return null;
    switch (b.type) {
      case 'divider': return el.querySelector('.divider');
      case 'image': return b.src ? el.querySelector('.image-fig') : el.querySelector('.img-src');
      case 'table': return el.querySelector('th, td');
      case 'html': el.classList.add('editing'); return el.querySelector('textarea');
      default: return el.querySelector('.content');
    }
  }

  // where: 'start' | 'end' | text offset | { x, edge: 'top'|'bottom' }
  focusBlock(b, where = 'end') {
    const t = this.focusTarget(b);
    if (!t) return;
    const editable = t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'INPUT';
    if (!editable) t.focus({ preventScroll: true });
    else if (typeof where === 'number') {
      if (t.tagName === 'TEXTAREA') { t.focus(); t.selectionStart = t.selectionEnd = Math.min(where, t.value.length); }
      else setTextOffset(t, Math.min(where, t.textContent.length));
    } else if (where === 'start') placeAtStart(t);
    else if (where && where.x != null) placeAtX(t, where.x, where.edge);
    else placeAtEnd(t);
    t.scrollIntoView({ block: 'nearest' });
  }

  // ---- block transformations --------------------------------------------

  turnInto(b, spec, opts = {}) {
    if (INSERT_ONLY.has(spec.type)) return this.insertSpecial(b, spec);
    this.checkpoint();
    const c = this.contentEl(b);
    const caret = opts.caret ?? (c && c.tagName !== 'TEXTAREA' && document.activeElement === c ? textOffset(c) : 'end');
    const wasList = LIST_TYPES.has(b.type);
    const toList = LIST_TYPES.has(spec.type);
    if (!(wasList && toList)) {
      b.indent = toList ? undefined : '';
      b.origLevel = undefined;
      b.level = toList ? 0 : b.level;
    }
    b.type = spec.type;
    if (spec.type === 'heading') b.level = spec.level;
    if (spec.type === 'todo') { b.checked = spec.checked ?? false; b.marker ||= '-'; }
    if (spec.type === 'bullet' && !/^[-*+]$/.test(b.marker || '')) b.marker = '-';
    if (spec.type === 'numbered') { b.num = spec.num ?? b.num; b.delim ||= '.'; }
    if (spec.type === 'callout') b.kind ||= 'note';
    if (spec.type === 'code') b.lang ??= '';
    this.rerender(b);
    this.focusBlock(b, caret);
    this.touch(b);
  }

  insertSpecial(b, spec) {
    this.checkpoint();
    const nb = createBlock(spec.type);
    if (b.type === 'paragraph' && !b.text.trim()) this.replaceBlock(b, nb);
    else this.insertAfter(b, nb);
    if (spec.type === 'divider') {
      let after = this.next(nb);
      if (!after || after.type !== 'paragraph' || after.text) {
        after = createBlock('paragraph');
        this.insertAfter(nb, after);
      }
      this.focusBlock(after, 'start');
    } else {
      this.focusBlock(nb, 'start');
    }
    this.touch(nb);
  }

  splitBlock(b, t) {
    this.checkpoint();
    const empty = !t.textContent && !t.querySelector('img');
    if (empty && (LIST_TYPES.has(b.type) || b.type === 'quote' || b.type === 'callout')) {
      if (LIST_TYPES.has(b.type) && b.level > 0) return this.indent(b, -1);
      return this.turnInto(b, { type: 'paragraph' }, { caret: 0 });
    }
    const [before, after] = splitContents(t, htmlToMd);
    const nb = this.continuation(b);
    if (!before && after) {
      // Enter at the very start opens a line above and leaves this block alone.
      this.insertBefore(b, nb);
      this.focusBlock(b, 'start');
    } else {
      b.text = before;
      nb.text = after;
      this.setContent(b);
      this.insertAfter(b, nb);
      this.focusBlock(nb, 'start');
      this.touch(b);
    }
    this.touch(nb);
  }

  backspaceAtStart(b) {
    if (b.type !== 'paragraph') return this.turnInto(b, { type: 'paragraph' }, { caret: 0 });
    const p = this.prev(b);
    if (!p) {
      const n = this.next(b);
      if (!b.text && n) {
        this.checkpoint();
        this.removeBlock(b);
        this.focusBlock(n, 'start');
        this.touch();
      }
      return;
    }
    this.checkpoint();
    if (TEXT_TYPES.has(p.type)) {
      const offset = this.contentEl(p).textContent.length;
      p.text = (p.text || '') + (b.text || '');
      this.removeBlock(b);
      this.setContent(p);
      this.focusBlock(p, offset);
      this.touch(p);
    } else if (p.type === 'divider') {
      this.removeBlock(p);
      this.touch();
    } else {
      if (!b.text) {
        this.removeBlock(b);
        this.touch();
      }
      this.focusBlock(p, 'end');
    }
  }

  mergeNext(b) {
    const n = this.next(b);
    if (!n || !TEXT_TYPES.has(n.type)) return false;
    this.checkpoint();
    const offset = this.contentEl(b).textContent.length;
    b.text = (b.text || '') + (n.text || '');
    this.removeBlock(n);
    this.setContent(b);
    this.focusBlock(b, offset);
    this.touch(b);
    return true;
  }

  indent(b, dir) {
    const p = this.prev(b);
    let level = (b.level || 0) + dir;
    if (dir > 0) {
      if (!p || !LIST_TYPES.has(p.type)) return;
      level = Math.min(level, p.level + 1);
    }
    level = Math.max(0, level);
    if (level === b.level) return;
    this.checkpoint();
    const c = this.contentEl(b);
    const off = document.activeElement === c ? textOffset(c) : 'end';
    b.level = level;
    this.rerender(b);
    this.focusBlock(b, off);
    this.touch(b);
  }

  duplicate(b) {
    this.checkpoint();
    const copy = { ...JSON.parse(JSON.stringify(b)), id: uid() };
    delete copy.gap;
    delete copy.gapKey;
    this.insertAfter(b, copy);
    this.focusBlock(copy, 'end');
    this.touch();
  }

  deleteBlock(b) {
    this.checkpoint();
    const neighbour = this.prev(b) || this.next(b);
    this.removeBlock(b);
    this.focusBlock(neighbour && this.get(neighbour.id) ? neighbour : this.doc.blocks[0], 'end');
    this.touch();
  }

  addBelow(b, above) {
    let nb = b;
    if (!(b.type === 'paragraph' && !b.text)) {
      this.checkpoint();
      nb = createBlock('paragraph');
      if (above) this.insertBefore(b, nb); else this.insertAfter(b, nb);
    }
    this.focusBlock(nb, 'start');
    document.execCommand('insertText', false, '/');
  }

  tableOp(b, op, at) {
    this.checkpoint();
    b.align ||= [];
    const cell = this.lastCell?.id === b.id ? this.lastCell : null;
    const cols = b.rows[0].length;
    let focus = cell ? [cell.r, cell.c] : [0, 0];
    if (op === 'row') {
      const i = at ?? (cell ? cell.r + 1 : b.rows.length);
      b.rows.splice(Math.max(1, i), 0, Array(cols).fill(''));
      focus = [Math.max(1, i), cell ? cell.c : 0];
    } else if (op === 'col') {
      const i = cell ? cell.c + 1 : cols;
      b.rows.forEach((r) => r.splice(i, 0, ''));
      b.align.splice(i, 0, null);
      focus = [cell ? cell.r : 0, i];
    } else if (op === 'delrow') {
      if (b.rows.length <= 1) return;
      const i = cell && cell.r > 0 ? cell.r : b.rows.length - 1;
      if (i === 0) return;
      b.rows.splice(i, 1);
      focus = [Math.min(i, b.rows.length - 1), cell ? cell.c : 0];
    } else if (op === 'delcol') {
      if (cols <= 1) return;
      const i = cell ? cell.c : cols - 1;
      b.rows.forEach((r) => r.splice(i, 1));
      b.align.splice(i, 1);
      focus = [cell ? cell.r : 0, Math.min(i, cols - 2)];
    }
    this.rerender(b);
    const target = this.els.get(b.id).querySelector(`[data-r="${focus[0]}"][data-c="${focus[1]}"]`);
    if (target) placeAtEnd(target);
    this.touch(b);
  }

  // ---- menus -------------------------------------------------------------

  blockItems() {
    return BLOCK_SPECS.map((s) => ({ ...s, section: 'Basic blocks', action: 'turn', spec: s }));
  }

  openSlash(b, t, start) {
    const slash = { id: b.id, el: t, start };
    this.slash = slash;
    this.menu.open({
      rect: caretRect() || t.getBoundingClientRect(),
      items: this.blockItems(),
      onPick: (item) => this.pickSlash(slash, item),
      onClose: () => { if (this.slash === slash) this.slash = null; },
    });
  }

  updateSlash(b, t, e) {
    if (this.slash) {
      const off = textOffset(t);
      if (this.slash.el !== t || off <= this.slash.start || t.textContent[this.slash.start] !== '/') return this.menu.close();
      const q = t.textContent.slice(this.slash.start + 1, off);
      if (/^\s|\s\s/.test(q) || q.length > 24) return this.menu.close();
      if (!this.menu.filter(q) && q.length > 3) this.menu.close();
      return;
    }
    if (e.data?.includes('/')) {
      const off = textOffset(t);
      const start = off - e.data.length + e.data.lastIndexOf('/');
      const before = t.textContent[start - 1];
      if (t.textContent[start] !== '/' || !(start === 0 || /\s/.test(before))) return;
      this.openSlash(b, t, start);
      if (off > start + 1) this.menu.filter(t.textContent.slice(start + 1, off));
    }
  }

  pickSlash(slash, item) {
    const b = this.get(slash.id);
    if (!b) return;
    const t = slash.el;
    const end = document.activeElement === t ? textOffset(t) : slash.start + 1;
    rangeAt(t, slash.start, Math.max(end, slash.start + 1)).deleteContents();
    if (!t.textContent && !t.querySelector('img')) t.replaceChildren();
    b.text = htmlToMd(t);
    this.turnInto(b, item.spec, { caret: slash.start });
  }

  openBlockMenu(b, anchor) {
    const items = [
      { label: 'Delete', icon: IC.trash, hint: 'Del', action: 'delete' },
      { label: 'Duplicate', icon: IC.copy, hint: '⌘D', action: 'duplicate' },
      { label: 'Move up', icon: IC.up, hint: '⌘⇧↑', action: 'up' },
      { label: 'Move down', icon: IC.down, hint: '⌘⇧↓', action: 'down' },
    ];
    if (TEXT_TYPES.has(b.type) || b.type === 'code') {
      for (const s of BLOCK_SPECS) {
        if (!INSERT_ONLY.has(s.type)) items.push({ ...s, desc: '', hint: '', section: 'Turn into', action: 'turn', spec: s });
      }
    }
    this.menu.open({ rect: anchor.getBoundingClientRect(), items, onPick: (it) => this.blockAction(b, it) });
  }

  blockAction(b, it) {
    if (!this.get(b.id)) return;
    if (it.action === 'delete') this.deleteBlock(b);
    else if (it.action === 'duplicate') this.duplicate(b);
    else if (it.action === 'up') this.moveBlock(b, this.indexOf(b) - 1);
    else if (it.action === 'down') this.moveBlock(b, this.indexOf(b) + 1);
    else if (it.action === 'turn') this.turnInto(b, it.spec);
  }

  // ---- inline formatting -------------------------------------------------

  createToolbar() {
    const tb = document.createElement('div');
    tb.className = 'format-bar';
    tb.hidden = true;
    tb.innerHTML = `
      <button data-cmd="turn" class="fb-turn" title="Turn into">Turn into ▾</button>
      <span class="fb-sep"></span>
      <button data-cmd="bold" title="Bold (⌘B)"><b>B</b></button>
      <button data-cmd="italic" title="Italic (⌘I)"><i>i</i></button>
      <button data-cmd="strikeThrough" title="Strikethrough (⌘⇧S)"><s>S</s></button>
      <button data-cmd="code" title="Inline code (⌘E)">&lt;/&gt;</button>
      <button data-cmd="link" title="Link (⌘K)">Link</button>`;
    tb.addEventListener('mousedown', (e) => e.preventDefault());
    tb.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.cmd === 'turn') {
        const [b] = this.blockFrom(getSelection().anchorNode?.parentElement);
        if (b && TEXT_TYPES.has(b.type)) this.openBlockMenu(b, btn);
        return;
      }
      this.format(btn.dataset.cmd);
    });
    document.body.append(tb);
    return tb;
  }

  selectionHost() {
    const sel = getSelection();
    if (!sel.rangeCount) return null;
    const node = sel.anchorNode;
    const host = (node?.nodeType === 1 ? node : node?.parentElement)?.closest('.content[contenteditable="true"], td, th');
    return host && this.root.contains(host) && host.contains(sel.focusNode) ? host : null;
  }

  updateToolbar() {
    const sel = getSelection();
    const host = !sel.isCollapsed && this.selectionHost();
    if (!host || this.menu.isOpen) { this.toolbar.hidden = true; return; }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect.width && !rect.height) { this.toolbar.hidden = true; return; }
    const tb = this.toolbar;
    tb.hidden = false;
    tb.querySelector('.fb-turn').hidden = !!host.closest('td, th');
    for (const btn of tb.querySelectorAll('[data-cmd]')) {
      const cmd = btn.dataset.cmd;
      let on = false;
      if (['bold', 'italic', 'strikeThrough'].includes(cmd)) on = document.queryCommandState(cmd);
      if (cmd === 'code') on = !!sel.anchorNode?.parentElement?.closest('code');
      if (cmd === 'link') on = !!sel.anchorNode?.parentElement?.closest('a');
      btn.classList.toggle('on', on);
    }
    let top = rect.top - tb.offsetHeight - 8;
    if (top < 8) top = rect.bottom + 8;
    const left = Math.max(8, Math.min(rect.left + rect.width / 2 - tb.offsetWidth / 2, innerWidth - tb.offsetWidth - 8));
    tb.style.top = `${top}px`;
    tb.style.left = `${left}px`;
  }

  format(cmd) {
    const host = this.selectionHost();
    if (!host) return;
    this.checkpoint();
    this.typing = false;
    document.execCommand('styleWithCSS', false, false);
    if (cmd === 'code') this.toggleCode();
    else if (cmd === 'link') this.promptLink();
    else document.execCommand(cmd);
    this.sync(host);
    this.updateToolbar();
  }

  toggleCode() {
    const sel = getSelection();
    const r = sel.getRangeAt(0);
    const node = r.commonAncestorContainer;
    const code = (node.nodeType === 1 ? node : node.parentElement).closest('code');
    if (code) {
      const text = document.createTextNode(code.textContent);
      code.replaceWith(text);
      sel.selectAllChildren(text.parentNode);
      const nr = document.createRange();
      nr.selectNode(text);
      sel.removeAllRanges();
      sel.addRange(nr);
    } else if (!r.collapsed) {
      const el = document.createElement('code');
      el.textContent = r.toString();
      r.deleteContents();
      r.insertNode(el);
      const nr = document.createRange();
      nr.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(nr);
    }
  }

  promptLink() {
    const sel = getSelection();
    const saved = sel.getRangeAt(0).cloneRange();
    const existing = (saved.commonAncestorContainer.nodeType === 1
      ? saved.commonAncestorContainer : saved.commonAncestorContainer.parentElement).closest('a');
    const url = prompt('Link URL (or a relative path to another page)', existing?.getAttribute('href') || 'https://');
    sel.removeAllRanges();
    sel.addRange(saved);
    if (url === null) return;
    if (existing) {
      if (!url.trim()) existing.replaceWith(...existing.childNodes);
      else {
        existing.setAttribute('href', url.trim());
        delete existing.dataset.dest;
      }
    } else if (url.trim()) {
      if (saved.collapsed) document.execCommand('insertHTML', false, `<a href="${escapeHtml(url.trim())}">${escapeHtml(url.trim())}</a>`);
      else document.execCommand('createLink', false, url.trim());
    }
  }

  sync(host) {
    const [b] = this.blockFrom(host);
    if (!b) return;
    if (host.matches('td, th')) b.rows[Number(host.dataset.r)][Number(host.dataset.c)] = htmlToMd(host);
    else b.text = htmlToMd(host);
    this.touch(b);
  }

  // ---- events ------------------------------------------------------------

  onBeforeInput(e) {
    if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
      e.preventDefault();
      if (e.inputType === 'historyUndo') this.undo(); else this.redo();
      return;
    }
    if (!this.typing) this.checkpoint();
    this.typing = true;
    clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => { this.typing = false; }, 800);
  }

  onInput(e) {
    const t = e.target;
    const [b] = this.blockFrom(t);
    if (!b) return;
    if (t.matches('td, th')) return this.sync(t);
    if (t.classList.contains('code-lang')) {
      b.lang = t.value.trim();
      return this.touch(b);
    }
    if (t.classList.contains('img-src') || t.classList.contains('img-alt')) {
      const el = this.els.get(b.id);
      b.src = el.querySelector('.img-src').value.trim();
      b.alt = el.querySelector('.img-alt').value;
      clearTimeout(this.imgTimer);
      this.imgTimer = setTimeout(() => this.refreshImage(b), 400);
      return this.touch(b);
    }
    if (!t.classList.contains('content')) return;
    if (t.tagName === 'TEXTAREA') {
      b.text = t.value;
      t.rows = rowsFor(t.value);
      return this.touch(b);
    }
    if (!t.textContent && !t.querySelector('img')) t.replaceChildren();
    b.text = htmlToMd(t);
    this.touch(b);
    if (b.type === 'paragraph' && e.inputType?.startsWith('insert') && this.applyShortcut(b, t, e.data)) return;
    this.updateSlash(b, t, e);
  }

  refreshImage(b) {
    const el = this.els.get(b.id);
    if (!el) return;
    const fig = el.querySelector('.image-fig');
    const src = b.src ? this.opts.resolveAsset(b.src) : '';
    fig.innerHTML = src
      ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(b.alt || '')}">${b.alt ? `<figcaption>${escapeHtml(b.alt)}</figcaption>` : ''}`
      : `<div class="image-empty">${IC.image}<span>Add an image</span></div>`;
    el.classList.toggle('no-src', !b.src);
  }

  // Fires when the text just inserted completes a prefix like "## " or "- ".
  applyShortcut(b, t, data) {
    const text = t.textContent.replace(/ /g, ' ');
    const off = textOffset(t);
    const insertedFrom = off - (data || ' ').length;
    for (const s of SHORTCUTS) {
      const m = text.match(s.re);
      if (!m || off < m[0].length || insertedFrom >= m[0].length || !b.text.startsWith(m[0])) continue;
      this.menu.close();
      b.text = b.text.slice(m[0].length);
      const spec = s.spec(m);
      if (spec.type === 'divider') {
        this.setContent(b);
        this.turnInto(b, spec);
      } else {
        this.turnInto(b, spec, { caret: off - m[0].length });
      }
      return true;
    }
    return false;
  }

  onFocusIn(e) {
    const [b, el] = this.blockFrom(e.target);
    if (!b) return;
    this.focusedId = b.id;
    if (e.target.matches('td, th')) this.lastCell = { id: b.id, r: Number(e.target.dataset.r), c: Number(e.target.dataset.c) };
    if (b.type === 'html') el.classList.add('editing');
  }

  onFocusOut(e) {
    const [b, el] = this.blockFrom(e.target);
    if (!b) return;
    if (this.slash && e.target === this.slash.el) this.menu.close();
    if (b.type === 'html' && !el.contains(e.relatedTarget)) {
      el.classList.remove('editing');
      this.fillPreview(el.querySelector('iframe'), b.text);
    }
  }

  onClick(e) {
    const t = e.target;
    const [b, el] = this.blockFrom(t);
    if (!b) return;
    if (t.closest('.g-add')) return this.addBelow(b, e.altKey);
    if (t.closest('.g-handle')) return this.openBlockMenu(b, t.closest('.g-handle'));
    if (t.matches('.marker input[type="checkbox"]')) {
      this.checkpoint();
      b.checked = t.checked;
      el.classList.toggle('checked', b.checked);
      return this.touch(b);
    }
    if (t.closest('.callout-icon')) {
      this.checkpoint();
      b.kind = CALLOUT_KINDS[(CALLOUT_KINDS.indexOf(b.kind) + 1) % CALLOUT_KINDS.length];
      this.rerender(b);
      return this.touch(b);
    }
    if (t.closest('.code-copy')) {
      navigator.clipboard?.writeText(b.text).then(() => {
        t.textContent = 'Copied';
        setTimeout(() => { t.textContent = 'Copy'; }, 1200);
      });
      return;
    }
    if (t.closest('.html-cover')) return this.focusBlock(b, 'start');
    if (t.closest('.table-tools button')) return this.tableOp(b, t.closest('button').dataset.t);
    const a = t.closest('a');
    if (a) {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) this.opts.openLink(a.getAttribute('href'));
    }
  }

  onKeyDown(e) {
    if (e.isComposing || e.defaultPrevented) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key;
    if (mod && !e.altKey && key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.redo(); else this.undo();
      return;
    }
    if (e.ctrlKey && !e.metaKey && key.toLowerCase() === 'y') {
      e.preventDefault();
      this.redo();
      return;
    }
    const t = e.target;
    const [b, el] = this.blockFrom(t);
    if (!b) return;

    if (mod && !e.altKey && key.toLowerCase() === 'd') { e.preventDefault(); return this.duplicate(b); }
    if (mod && e.shiftKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
      e.preventDefault();
      this.moveBlock(b, this.indexOf(b) + (key === 'ArrowUp' ? -1 : 1));
      return this.focusBlock(b, 'end');
    }
    if (mod && e.altKey && DIGIT_SPECS[e.code] && (TEXT_TYPES.has(b.type) || b.type === 'code')) {
      e.preventDefault();
      return this.turnInto(b, DIGIT_SPECS[e.code]);
    }

    if (t.matches('td, th')) return this.onTableKey(e, b, t, el);
    if (t.matches('.divider, .image-fig')) return this.onObjectKey(e, b);
    if (t.matches('.img-src, .img-alt, .code-lang')) {
      if (key === 'Enter' || key === 'Escape') {
        e.preventDefault();
        if (b.type === 'code' && key === 'Enter') return this.focusBlock(b, 'start');
        if (b.type === 'image' && b.src) return this.focusBlock(b);
        t.blur();
      }
      return;
    }
    if (!t.classList.contains('content')) return;
    const ta = t.tagName === 'TEXTAREA';

    if (mod && !ta && this.onFormatKey(e)) return;
    if (mod && key === 'Enter') {
      e.preventDefault();
      if (b.type === 'todo') {
        this.checkpoint();
        b.checked = !b.checked;
        el.classList.toggle('checked', b.checked);
        el.querySelector('.marker input').checked = b.checked;
        return this.touch(b);
      }
      const nb = createBlock('paragraph');
      this.checkpoint();
      this.insertAfter(b, nb);
      return this.focusBlock(nb, 'start');
    }

    switch (key) {
      case 'Enter': {
        if (ta) {
          if (b.type === 'code' && !e.shiftKey) {
            e.preventDefault();
            const v = t.value;
            const lineStart = v.lastIndexOf('\n', t.selectionStart - 1) + 1;
            document.execCommand('insertText', false, `\n${v.slice(lineStart).match(/^[ \t]*/)[0]}`);
          }
          return;
        }
        e.preventDefault();
        if (e.shiftKey) {
          if (b.type !== 'heading') document.execCommand('insertLineBreak');
          return;
        }
        return this.splitBlock(b, t);
      }
      case 'Backspace': {
        if (ta) {
          if (!t.value) {
            e.preventDefault();
            if (b.type === 'code') this.turnInto(b, { type: 'paragraph' });
            else this.deleteBlock(b);
          }
          return;
        }
        if (!atStart(t)) return;
        e.preventDefault();
        return this.backspaceAtStart(b);
      }
      case 'Delete':
        if (!ta && atEnd(t) && this.mergeNext(b)) e.preventDefault();
        return;
      case 'Tab':
        e.preventDefault();
        if (ta) document.execCommand('insertText', false, '  ');
        else if (LIST_TYPES.has(b.type)) this.indent(b, e.shiftKey ? -1 : 1);
        return;
      case 'ArrowUp':
      case 'ArrowLeft': {
        if (e.shiftKey || e.altKey || mod) return;
        const edge = key === 'ArrowUp' ? onFirstLine(t) : atStart(t);
        const p = edge && this.prev(b);
        if (!p) return;
        e.preventDefault();
        const x = ta ? t.getBoundingClientRect().left : caretRect()?.left ?? 0;
        return this.focusBlock(p, key === 'ArrowUp' ? { x, edge: 'bottom' } : 'end');
      }
      case 'ArrowDown':
      case 'ArrowRight': {
        if (e.shiftKey || e.altKey || mod) return;
        const edge = key === 'ArrowDown' ? onLastLine(t) : atEnd(t);
        const n = edge && this.next(b);
        if (!n) return;
        e.preventDefault();
        const x = ta ? t.getBoundingClientRect().left : caretRect()?.left ?? 0;
        return this.focusBlock(n, key === 'ArrowDown' ? { x, edge: 'top' } : 'start');
      }
      case 'Escape':
        t.blur();
        return;
      default:
    }
  }

  onFormatKey(e) {
    const k = e.key.toLowerCase();
    let cmd = null;
    if (k === 'b' && !e.shiftKey) cmd = 'bold';
    else if (k === 'i' && !e.shiftKey) cmd = 'italic';
    else if (k === 'e' && !e.shiftKey) cmd = 'code';
    else if (k === 'k' && !e.shiftKey) cmd = 'link';
    else if ((k === 's' || k === 'x') && e.shiftKey) cmd = 'strikeThrough';
    if (!cmd) return false;
    e.preventDefault();
    this.format(cmd);
    return true;
  }

  onObjectKey(e, b) {
    const key = e.key;
    if (key === 'Backspace' || key === 'Delete') {
      e.preventDefault();
      return this.deleteBlock(b);
    }
    if (key === 'Enter') {
      e.preventDefault();
      this.checkpoint();
      const nb = createBlock('paragraph');
      this.insertAfter(b, nb);
      return this.focusBlock(nb, 'start');
    }
    if (key === 'ArrowUp' || key === 'ArrowLeft') {
      const p = this.prev(b);
      if (p) { e.preventDefault(); this.focusBlock(p, 'end'); }
    }
    if (key === 'ArrowDown' || key === 'ArrowRight') {
      const n = this.next(b);
      if (n) { e.preventDefault(); this.focusBlock(n, 'start'); }
    }
  }

  onTableKey(e, b, cell, el) {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && this.onFormatKey(e)) return;
    const r = Number(cell.dataset.r);
    const c = Number(cell.dataset.c);
    const rows = b.rows.length;
    const cols = b.rows[0].length;
    const go = (r2, c2) => {
      const target = el.querySelector(`[data-r="${r2}"][data-c="${c2}"]`);
      if (target) placeAtEnd(target);
    };
    if (e.key === 'Tab') {
      e.preventDefault();
      const idx = r * cols + c + (e.shiftKey ? -1 : 1);
      if (idx < 0) return;
      if (idx >= rows * cols) {
        this.lastCell = null;
        return this.tableOp(b, 'row', rows);
      }
      return go(Math.floor(idx / cols), idx % cols);
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (mod || e.shiftKey) {
        this.checkpoint();
        const nb = createBlock('paragraph');
        this.insertAfter(b, nb);
        return this.focusBlock(nb, 'start');
      }
      if (r + 1 < rows) return go(r + 1, c);
      return this.tableOp(b, 'row', rows);
    }
    if (e.key === 'ArrowUp' && onFirstLine(cell)) {
      e.preventDefault();
      if (r > 0) return go(r - 1, c);
      const p = this.prev(b);
      if (p) this.focusBlock(p, 'end');
    }
    if (e.key === 'ArrowDown' && onLastLine(cell)) {
      e.preventDefault();
      if (r + 1 < rows) return go(r + 1, c);
      const n = this.next(b);
      if (n) this.focusBlock(n, 'start');
    }
  }

  onPaste(e) {
    const t = e.target.closest?.('.content, td, th');
    if (!t || t.tagName === 'TEXTAREA') return;
    const [b] = this.blockFrom(t);
    if (!b) return;
    e.preventDefault();
    const text = (e.clipboardData.getData('text/plain') || '').replace(/\r\n/g, '\n');
    if (!text) return;
    this.checkpoint();
    this.typing = false;
    const sel = getSelection();
    if (/^https?:\/\/\S+$/.test(text.trim()) && !sel.isCollapsed) {
      document.execCommand('createLink', false, text.trim());
      return this.sync(t);
    }
    if (t.matches('td, th') || !text.trim().includes('\n')) {
      document.execCommand('insertText', false, text.replace(/\n+$/, '').replace(/\n/g, ' '));
      return;
    }
    // Multi-line paste: parse it as Markdown and insert real blocks.
    const pasted = parse(text).blocks.filter((p) => p.type !== 'frontmatter');
    if (!pasted.length) return;
    const [before, after] = splitContents(t, htmlToMd);
    let anchor = b;
    let rest = pasted;
    if (!before.trim() && b.type === 'paragraph') {
      this.replaceBlock(b, pasted[0]);
      anchor = pasted[0];
      rest = pasted.slice(1);
    } else {
      b.text = before;
      this.setContent(b);
      b.dirty = true;
    }
    for (const p of rest) {
      this.insertAfter(anchor, p);
      anchor = p;
    }
    if (after.trim()) {
      const tail = createBlock('paragraph', { text: after });
      this.insertAfter(anchor, tail);
      this.focusBlock(tail, 'start');
    } else {
      this.focusBlock(anchor, 'end');
    }
    this.touch();
  }

  onDragStart(e) {
    const h = e.target.closest?.('.g-handle');
    if (!h) return;
    const el = h.closest('.block');
    this.dragId = el.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-noto-block', this.dragId);
    e.dataTransfer.setDragImage(el, 24, 12);
    this.menu.close();
    requestAnimationFrame(() => el.classList.add('dragging'));
  }

  clearDrop() {
    for (const el of this.root.querySelectorAll('.drop-before, .drop-after')) el.classList.remove('drop-before', 'drop-after');
  }

  onDragOver(e) {
    if (!this.dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    let el = e.target.closest?.('.block');
    if (!el || !this.root.contains(el)) {
      const all = [...this.root.children];
      el = all.find((x) => x.getBoundingClientRect().bottom > e.clientY) || all[all.length - 1];
    }
    this.clearDrop();
    if (!el) return;
    const r = el.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    el.classList.add(after ? 'drop-after' : 'drop-before');
    this.dropTarget = { id: el.dataset.id, after };
  }

  onDrop(e) {
    if (!this.dragId) return;
    e.preventDefault();
    const b = this.get(this.dragId);
    const target = this.dropTarget && this.get(this.dropTarget.id);
    if (b && target && target !== b) {
      const from = this.indexOf(b);
      let to = this.indexOf(target) + (this.dropTarget.after ? 1 : 0);
      if (from < to) to -= 1;
      this.moveBlock(b, to);
    }
    this.endDrag();
  }

  endDrag() {
    this.clearDrop();
    this.root.querySelector('.dragging')?.classList.remove('dragging');
    this.dragId = null;
    this.dropTarget = null;
  }
}
