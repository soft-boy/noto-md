// Inline Markdown <-> editable HTML.
//
// mdToHtml() renders the formatting we can edit (bold, italic, strike, code,
// links, images); everything else stays as literal text. htmlToMd() walks the
// edited DOM back to Markdown, emitting text verbatim so unrecognised syntax
// survives the round-trip. Elements remember the exact markers they came from
// (`data-m`, `data-dest`, `data-raw`) so untouched spans are written back as-is.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
export const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c]);

const PUNCT = /[!-/:-@[-`{-~]/;
const SPECIAL = new Set(['\\', '`', '!', '[', '<', '*', '_', '~']);

const safeHref = (href) => (/^\s*(javascript|vbscript|data):/i.test(href) ? '#' : href);

function matchBracket(s, start, open, close) {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i;
  }
  return -1;
}

// [text](dest "title") starting at s[i] === '['
function parseLink(s, i) {
  const close = matchBracket(s, i, '[', ']');
  if (close < 0 || s[close + 1] !== '(') return null;
  const end = matchBracket(s, close + 1, '(', ')');
  if (end < 0) return null;
  const dest = s.slice(close + 2, end);
  const d = dest.trim();
  const href = d.startsWith('<') ? d.slice(1, d.indexOf('>') > 0 ? d.indexOf('>') : undefined) : d.split(/\s+/)[0];
  return { text: s.slice(i + 1, close), dest, href, end: end + 1 };
}

const rawSpan = (raw, shown) =>
  `<span class="md-raw" data-raw="${escapeHtml(raw)}" data-text="${escapeHtml(shown)}">${escapeHtml(shown)}</span>`;

export function mdToHtml(src, ctx = {}) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (!SPECIAL.has(c)) { out += escapeHtml(c); i++; continue; }
    const rest = src.slice(i);
    let m;

    if (c === '\\' && PUNCT.test(src[i + 1] || '')) {
      out += rawSpan(src.slice(i, i + 2), src[i + 1]);
      i += 2;
      continue;
    }
    if (c === '`' && (m = rest.match(/^(`+)(?!`)([\s\S]*?[^`])\1(?!`)/))) {
      out += `<code>${escapeHtml(m[2])}</code>`;
      i += m[0].length;
      continue;
    }
    if (c === '!' && src[i + 1] === '[') {
      const lk = parseLink(src, i + 1);
      if (lk) {
        const url = ctx.resolve ? ctx.resolve(lk.href) : lk.href;
        out += `<img data-raw="${escapeHtml(src.slice(i, lk.end))}" alt="${escapeHtml(lk.text)}" src="${escapeHtml(safeHref(url))}" contenteditable="false">`;
        i = lk.end;
        continue;
      }
    }
    if (c === '[') {
      const lk = parseLink(src, i);
      if (lk) {
        out += `<a href="${escapeHtml(safeHref(lk.href))}" data-dest="${escapeHtml(lk.dest)}" data-href="${escapeHtml(safeHref(lk.href))}">${mdToHtml(lk.text, ctx)}</a>`;
        i = lk.end;
        continue;
      }
    }
    if (c === '<' && (m = rest.match(/^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/))) {
      const href = m[1].includes(':') ? m[1] : `mailto:${m[1]}`;
      out += `<a href="${escapeHtml(safeHref(href))}" data-auto="1">${escapeHtml(m[1])}</a>`;
      i += m[0].length;
      continue;
    }
    if (c === '*' || c === '_') {
      const intraword = c === '_' && /[A-Za-z0-9]/.test(src[i - 1] || '');
      if (!intraword) {
        const strong = c === '*' ? /^\*\*(?=\S)([\s\S]*?\S)\*\*/ : /^__(?=\S)([\s\S]*?\S)__(?![A-Za-z0-9])/;
        const em = c === '*' ? /^\*(?=[^\s*])([\s\S]*?[^\s*])\*(?!\*)/ : /^_(?=[^\s_])([\s\S]*?[^\s_])_(?![A-Za-z0-9])/;
        if ((m = rest.match(strong))) {
          out += `<strong data-m="${c}${c}">${mdToHtml(m[1], ctx)}</strong>`;
          i += m[0].length;
          continue;
        }
        if ((m = rest.match(em))) {
          out += `<em data-m="${c}">${mdToHtml(m[1], ctx)}</em>`;
          i += m[0].length;
          continue;
        }
      }
    }
    if (c === '~' && (m = rest.match(/^~~(?=\S)([\s\S]*?\S)~~/))) {
      out += `<s>${mdToHtml(m[1], ctx)}</s>`;
      i += m[0].length;
      continue;
    }
    out += escapeHtml(c);
    i++;
  }
  return out;
}

// Wrap with markers, keeping surrounding whitespace outside them (`**a** `, not `**a **`).
function wrap(marker, s) {
  const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/);
  return m[2] ? `${m[1]}${marker}${m[2]}${marker}${m[3]}` : s;
}

function codeSpan(text) {
  if (!text) return '';
  const longest = Math.max(0, ...(text.match(/`+/g) || []).map((r) => r.length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return fence + pad + text + pad + fence;
}

function nodeToMd(n) {
  if (n.nodeType === 3) return n.nodeValue.replace(/ /g, ' ').replace(/​/g, '');
  if (n.nodeType !== 1) return '';
  const tag = n.tagName;
  const d = n.dataset;
  if (d.raw != null) {
    if (tag === 'IMG' || n.textContent === d.text) return d.raw;
    return n.textContent;
  }
  switch (tag) {
    case 'BR': return '\n';
    case 'STRONG': case 'B': return wrap(d.m || '**', htmlToMd(n));
    case 'EM': case 'I': return wrap(d.m || '*', htmlToMd(n));
    case 'S': case 'DEL': case 'STRIKE': return wrap('~~', htmlToMd(n));
    case 'CODE': return codeSpan(n.textContent);
    case 'A': {
      const text = htmlToMd(n);
      if (d.auto) return `<${n.textContent}>`;
      if (d.dest != null && n.getAttribute('href') === d.href) return `[${text}](${d.dest})`;
      const href = n.getAttribute('href') || '';
      return `[${text}](${/[\s()]/.test(href) ? `<${href}>` : href})`;
    }
    case 'DIV': case 'P':
      return (n.previousSibling ? '\n' : '') + htmlToMd(n);
    default:
      return htmlToMd(n);
  }
}

export function htmlToMd(root) {
  let out = '';
  for (const n of root.childNodes) out += nodeToMd(n);
  return out;
}
