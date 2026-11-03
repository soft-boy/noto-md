// Caret helpers for contenteditable elements, in terms of plain-text offsets.

export function textOffset(el) {
  const sel = getSelection();
  if (!sel.rangeCount) return 0;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer)) return 0;
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(r.startContainer, r.startOffset);
  return pre.toString().length;
}

function pointAt(el, offset) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node;
  let remaining = offset;
  while ((node = walker.nextNode())) {
    if (remaining <= node.length) return [node, remaining];
    remaining -= node.length;
  }
  return null;
}

export function rangeAt(el, start, end = start) {
  const r = document.createRange();
  const a = pointAt(el, start);
  const b = pointAt(el, end);
  if (a) r.setStart(...a); else { r.selectNodeContents(el); r.collapse(false); }
  if (b) r.setEnd(...b); else r.setEnd(el, el.childNodes.length);
  return r;
}

export function setTextOffset(el, offset) {
  el.focus({ preventScroll: true });
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(rangeAt(el, offset));
}

export function placeAtEnd(el) {
  el.focus({ preventScroll: true });
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    el.selectionStart = el.selectionEnd = el.value.length;
    return;
  }
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

export function placeAtStart(el) {
  el.focus({ preventScroll: true });
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    el.selectionStart = el.selectionEnd = 0;
    return;
  }
  setTextOffset(el, 0);
}

export function isCollapsed() {
  const sel = getSelection();
  return sel.rangeCount > 0 && sel.isCollapsed;
}

export const atStart = (el) => (el.tagName === 'TEXTAREA'
  ? el.selectionStart === 0 && el.selectionEnd === 0
  : isCollapsed() && textOffset(el) === 0);

export const atEnd = (el) => (el.tagName === 'TEXTAREA'
  ? el.selectionStart === el.value.length
  : isCollapsed() && textOffset(el) === el.textContent.length);

export function caretRect() {
  const sel = getSelection();
  if (!sel.rangeCount) return null;
  const r = sel.getRangeAt(0).cloneRange();
  r.collapse(true);
  const rect = r.getClientRects()[0];
  if (rect) return rect;
  const node = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
  return node?.getBoundingClientRect() || null;
}

function lineInfo(el) {
  const cs = getComputedStyle(el);
  const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
  return { lh, rect: el.getBoundingClientRect(), pt: parseFloat(cs.paddingTop), pb: parseFloat(cs.paddingBottom) };
}

export function onFirstLine(el) {
  if (el.tagName === 'TEXTAREA') return !el.value.slice(0, el.selectionStart).includes('\n');
  if (!el.textContent) return true;
  const c = caretRect();
  if (!c || (c.top === 0 && c.height === 0)) return textOffset(el) === 0;
  const { lh, rect, pt } = lineInfo(el);
  return c.top - (rect.top + pt) < lh * 0.6;
}

export function onLastLine(el) {
  if (el.tagName === 'TEXTAREA') return !el.value.slice(el.selectionEnd).includes('\n');
  if (!el.textContent) return true;
  const c = caretRect();
  if (!c || (c.top === 0 && c.height === 0)) return textOffset(el) === el.textContent.length;
  const { lh, rect, pb } = lineInfo(el);
  return rect.bottom - pb - c.bottom < lh * 0.6;
}

// Put the caret in `el` on its first/last line, as close as possible to x.
export function placeAtX(el, x, edge) {
  if (el.tagName === 'TEXTAREA' || !el.textContent) {
    return edge === 'top' ? placeAtStart(el) : placeAtEnd(el);
  }
  const { lh, rect, pt, pb } = lineInfo(el);
  const y = edge === 'top' ? rect.top + pt + lh / 2 : rect.bottom - pb - lh / 2;
  const cx = Math.min(Math.max(x, rect.left + 1), rect.right - 1);
  let range = null;
  if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(cx, y);
  else if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(cx, y);
    if (pos) { range = document.createRange(); range.setStart(pos.offsetNode, pos.offset); }
  }
  if (!range || !el.contains(range.startContainer)) {
    return edge === 'top' ? placeAtStart(el) : placeAtEnd(el);
  }
  el.focus({ preventScroll: true });
  const sel = getSelection();
  sel.removeAllRanges();
  range.collapse(true);
  sel.addRange(range);
}

// Markdown on each side of the caret, without touching the DOM.
export function splitContents(el, toMd) {
  const sel = getSelection();
  const r = sel.getRangeAt(0);
  const before = document.createRange();
  before.selectNodeContents(el);
  before.setEnd(r.startContainer, r.startOffset);
  const after = document.createRange();
  after.selectNodeContents(el);
  after.setStart(r.endContainer, r.endOffset);
  const box = (frag) => { const d = document.createElement('div'); d.append(frag); return d; };
  return [toMd(box(before.cloneContents())), toMd(box(after.cloneContents()))];
}
