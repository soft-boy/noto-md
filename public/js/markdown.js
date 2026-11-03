// Block-level Markdown model.
//
// parse() turns a file into a flat list of blocks; serialize() turns it back.
// Every parsed block keeps its original source (`raw`) and the whitespace that
// followed it (`gap`), so anything the user did not touch is written back
// byte-for-byte. Only edited (`dirty`) or new blocks are regenerated.

export const LIST_TYPES = new Set(['bullet', 'numbered', 'todo']);
export const TEXT_TYPES = new Set(['paragraph', 'heading', 'bullet', 'numbered', 'todo', 'quote', 'callout']);
export const CALLOUT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'];

let seq = 0;
export function uid() {
  seq += 1;
  return `b${Date.now().toString(36)}${seq.toString(36)}`;
}

export function createBlock(type, props = {}) {
  const b = { id: uid(), type, text: '', ...props };
  if (type === 'heading') b.level ??= 1;
  if (LIST_TYPES.has(type)) b.level ??= 0;
  if (type === 'todo') b.checked ??= false;
  if (type === 'callout') b.kind ??= 'note';
  if (type === 'code') b.lang ??= '';
  if (type === 'image') { b.src ??= ''; b.alt ??= ''; }
  if (type === 'table' && !b.rows) {
    b.rows = [['', '', ''], ['', '', ''], ['', '', '']];
    b.align = [null, null, null];
  }
  return b;
}

const RE = {
  fence: /^([ \t]*)(`{3,}|~{3,})(.*)$/,
  atx: /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/,
  hr: /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/,
  setext1: /^ {0,3}=+[ \t]*$/,
  setext2: /^ {0,3}-+[ \t]*$/,
  quote: /^ {0,3}>/,
  list: /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)(.*)$/,
  todo: /^\[([ xX])\](?:[ \t]+|$)(.*)$/,
  tableDelim: /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/,
  htmlBlockTag: /^ {0,3}<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|picture|pre|script|section|source|style|summary|table|tbody|td|textarea|tfoot|th|thead|title|tr|track|ul|video|audio|img)(?=[\s/>]|$)/i,
  htmlLoneTag: /^ {0,3}(<!--|<\/?[a-zA-Z][\w-]*(\s[^>]*)?\/?>\s*$)/,
  image: /^!\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+("[^"]*"|'[^']*'))?\s*\)$/,
  callout: /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*$/i,
};

const isBlank = (l) => /^[ \t]*$/.test(l);
const leadingWs = (l) => l.match(/^[ \t]*/)[0];
const width = (ws) => ws.replace(/\t/g, '    ').length;
const isHtmlStart = (l) => RE.htmlBlockTag.test(l) || RE.htmlLoneTag.test(l);

function stripCols(line, cols) {
  let i = 0;
  while (i < cols && (line[i] === ' ' || line[i] === '\t')) i++;
  return line.slice(i);
}

// Can this line interrupt a running paragraph?
function startsBlock(line) {
  if (RE.fence.test(line) || RE.atx.test(line) || RE.hr.test(line) || RE.quote.test(line)) return true;
  const m = line.match(RE.list);
  return !!(m && m[4].trim() !== '' && (/^[-*+]$/.test(m[2]) || /^1[.)]$/.test(m[2])));
}

export function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let k = 0; k < s.length; k++) {
    if (s[k] === '\\' && s[k + 1] === '|') { cur += '\\|'; k++; continue; }
    if (s[k] === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += s[k];
  }
  cells.push(cur.trim());
  return cells;
}

function isTableStart(lines, i) {
  return lines[i].includes('|') && i + 1 < lines.length && RE.tableDelim.test(lines[i + 1])
    && splitRow(lines[i]).length === splitRow(lines[i + 1]).length;
}

export function parse(src) {
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const text = src.replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const blocks = [];
  let listStack = [];
  let i = 0;
  let m;

  const push = (block, start, end) => {
    block.raw = lines.slice(start, end).join('\n');
    block._s = start;
    block._e = end;
    blocks.push(block);
    i = end;
  };

  if (lines[0] === '---') {
    const close = lines.findIndex((l, k) => k > 0 && (l === '---' || l === '...'));
    if (close > 0) push(createBlock('frontmatter', { text: lines.slice(1, close).join('\n') }), 0, close + 1);
  }

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const indent = leadingWs(line);
    const isList = RE.list.test(line) && !RE.hr.test(line);
    if (!isList && width(indent) === 0) listStack = [];

    if ((m = line.match(RE.fence)) && !(m[2][0] === '`' && m[3].includes('`'))) {
      const [, ws, fence, info] = m;
      const closeRe = new RegExp(`^[ \\t]*${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`);
      let j = i + 1;
      while (j < lines.length && !closeRe.test(lines[j])) j++;
      const body = lines.slice(i + 1, j).map((l) => stripCols(l, width(ws)));
      push(createBlock('code', { lang: info.trim(), text: body.join('\n'), indent: ws, fence }), i, Math.min(j + 1, lines.length));
      continue;
    }

    if ((m = line.match(RE.atx))) {
      push(createBlock('heading', { level: m[1].length, text: (m[2] || '').trim() }), i, i + 1);
      continue;
    }

    if (RE.hr.test(line)) {
      push(createBlock('divider'), i, i + 1);
      continue;
    }

    if (isTableStart(lines, i)) {
      const header = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => {
        const l = c.startsWith(':'), r = c.endsWith(':');
        return l && r ? 'center' : r ? 'right' : l ? 'left' : null;
      });
      let j = i + 2;
      while (j < lines.length && !isBlank(lines[j]) && !startsBlock(lines[j])) j++;
      const n = header.length;
      const fit = (r) => Array.from({ length: n }, (_, c) => r[c] ?? '');
      const rows = [header, ...lines.slice(i + 2, j).map((l) => fit(splitRow(l)))];
      push(createBlock('table', { rows, align }), i, j);
      continue;
    }

    if (RE.quote.test(line)) {
      let j = i + 1;
      while (j < lines.length && !isBlank(lines[j]) && (RE.quote.test(lines[j]) || !startsBlock(lines[j]))) j++;
      const content = lines.slice(i, j).map((l) => l.replace(/^ {0,3}> ?/, ''));
      const cm = content[0].match(RE.callout);
      if (cm) push(createBlock('callout', { kind: cm[1].toLowerCase(), text: content.slice(1).join('\n') }), i, j);
      else push(createBlock('quote', { text: content.join('\n') }), i, j);
      continue;
    }

    if (isList) {
      m = line.match(RE.list);
      const [, ws, marker, , rest] = m;
      const w = width(ws);
      while (listStack.length && w <= listStack[listStack.length - 1]) listStack.pop();
      const level = listStack.length;
      listStack.push(w);
      let j = i + 1;
      while (j < lines.length && !isBlank(lines[j]) && !startsBlock(lines[j]) && !RE.list.test(lines[j])) j++;
      let first = rest;
      const props = { level, origLevel: level, indent: ws };
      let type;
      const tm = rest.match(RE.todo);
      if (tm) {
        type = 'todo';
        props.checked = tm[1] !== ' ';
        props.marker = marker;
        first = tm[2];
      } else if (/^\d/.test(marker)) {
        type = 'numbered';
        props.num = parseInt(marker, 10);
        props.delim = marker.slice(-1);
      } else {
        type = 'bullet';
        props.marker = marker;
      }
      props.text = [first, ...lines.slice(i + 1, j).map((l) => l.trimStart())].join('\n');
      push(createBlock(type, props), i, j);
      continue;
    }

    if (isHtmlStart(line)) {
      let j = i + 1;
      while (j < lines.length && !isBlank(lines[j])) j++;
      push(createBlock('html', { text: lines.slice(i, j).join('\n') }), i, j);
      continue;
    }

    // Paragraph (possibly a setext heading or a standalone image).
    let j = i + 1;
    let setext = 0;
    while (j < lines.length && !isBlank(lines[j])) {
      if (RE.setext1.test(lines[j])) { setext = 1; break; }
      if (RE.setext2.test(lines[j])) { setext = 2; break; }
      if (startsBlock(lines[j]) || isTableStart(lines, j)) break;
      j++;
    }
    const paraLines = lines.slice(i, j).map((l) => l.trimStart());
    if (setext) {
      push(createBlock('heading', { level: setext, text: paraLines.join(' ').trim() }), i, j + 1);
      continue;
    }
    const im = paraLines.length === 1 && paraLines[0].trimEnd().match(RE.image);
    if (im) {
      push(createBlock('image', {
        alt: im[1],
        src: im[2].replace(/^<|>$/g, ''),
        title: im[3] ? im[3].slice(1, -1) : '',
        indent,
      }), i, j);
      continue;
    }
    push(createBlock('paragraph', { text: paraLines.join('\n'), indent }), i, j);
  }

  // Record the whitespace between blocks so it can be reproduced exactly.
  blocks.forEach((b, k) => {
    const next = blocks[k + 1];
    const tail = lines.slice(b._e, next ? next._s : lines.length).map((l) => '\n' + l).join('');
    b.gap = next ? tail + '\n' : tail;
    b.gapKey = gapKey(b, next);
  });
  const lead = blocks.length ? lines.slice(0, blocks[0]._s).map((l) => l + '\n').join('') : text;
  for (const b of blocks) { delete b._s; delete b._e; }
  return { eol, lead, blocks };
}

const gapKey = (b, next) => `${b.type}>${next ? `${next.id}:${next.type}` : ''}`;

function gapFor(b, next) {
  if (b.gap != null && b.gapKey === gapKey(b, next)) return b.gap;
  if (!next) return '\n';
  return LIST_TYPES.has(b.type) && LIST_TYPES.has(next.type) ? '\n' : '\n\n';
}

// Number shown for a numbered item: continues its preceding sibling.
export function numberOf(blocks, k) {
  const b = blocks[k];
  for (let j = k - 1; j >= 0; j--) {
    const p = blocks[j];
    if (!LIST_TYPES.has(p.type) || p.level < b.level) break;
    if (p.level === b.level) return p.type === 'numbered' ? numberOf(blocks, j) + 1 : (b.num ?? 1);
  }
  return b.num ?? 1;
}

function listMarker(blocks, k) {
  const b = blocks[k];
  if (b.type === 'numbered') return `${numberOf(blocks, k)}${b.delim || '.'}`;
  return b.marker || '-';
}

function listIndent(blocks, k) {
  const b = blocks[k];
  if (b.level === b.origLevel && b.indent != null) return b.indent;
  if (!b.level) return '';
  for (let j = k - 1; j >= 0; j--) {
    const p = blocks[j];
    if (!LIST_TYPES.has(p.type)) break;
    if (p.level === b.level) return listIndent(blocks, j);
    if (p.level < b.level) return listIndent(blocks, j) + ' '.repeat(listMarker(blocks, j).length + 1);
  }
  return '  '.repeat(b.level);
}

// Escape a line that would otherwise be read back as a different block type.
function escapeLine(line) {
  if (!startsBlock(line) && !RE.list.test(line) && !isHtmlStart(line)) return line;
  const ord = line.match(/^(\s*\d+)([.)])/);
  if (ord) return `${ord[1]}\\${ord[2]}${line.slice(ord[0].length)}`;
  const ws = leadingWs(line);
  return `${ws}\\${line.slice(ws.length)}`;
}

// Inline text from the editor: no trailing newlines, no blank lines (they would end the block).
const tidy = (s) => (s || '').replace(/\n+$/, '').replace(/\n{2,}/g, '\n');
const prefixLines = (s, prefix) => s.split('\n').map((l) => (l ? prefix + l : l)).join('\n');

function tableToMarkdown(b) {
  const n = Math.max(1, ...b.rows.map((r) => r.length));
  const cell = (s) => tidy(s).replace(/\n/g, ' ').replace(/\\\||\|/g, (x) => (x === '|' ? '\\|' : x));
  const rows = b.rows.map((r) => Array.from({ length: n }, (_, c) => cell(r[c])));
  const w = Array.from({ length: n }, (_, c) => Math.max(3, ...rows.map((r) => r[c].length)));
  const line = (r) => `| ${r.map((s, c) => s.padEnd(w[c])).join(' | ')} |`;
  const delim = `| ${w.map((x, c) => {
    const a = b.align?.[c];
    const d = '-'.repeat(x);
    if (a === 'center') return `:${d.slice(2)}:`;
    if (a === 'left') return `:${d.slice(1)}`;
    if (a === 'right') return `${d.slice(1)}:`;
    return d;
  }).join(' | ')} |`;
  return [line(rows[0]), delim, ...rows.slice(1).map(line)].join('\n');
}

export function blockToMarkdown(b, blocks, k) {
  switch (b.type) {
    case 'paragraph':
      return prefixLines(tidy(b.text).split('\n').map(escapeLine).join('\n'), b.indent || '');
    case 'heading':
      return `${'#'.repeat(b.level)} ${tidy(b.text).replace(/\n/g, ' ')}`.trimEnd();
    case 'bullet':
    case 'numbered':
    case 'todo': {
      const indent = listIndent(blocks, k);
      const marker = listMarker(blocks, k);
      const box = b.type === 'todo' ? (b.checked ? '[x]' : '[ ]') : '';
      const [first, ...rest] = tidy(b.text).split('\n');
      const head = [indent + marker, box, first].filter(Boolean).join(' ');
      const pad = indent + ' '.repeat(marker.length + 1);
      return [head, ...rest.map((l) => pad + l)].join('\n');
    }
    case 'quote':
      return (b.text || '').replace(/\n+$/, '').split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
    case 'callout': {
      const body = (b.text || '').replace(/\n+$/, '');
      const lines = body ? body.split('\n').map((l) => (l ? `> ${l}` : '>')) : [];
      return [`> [!${(b.kind || 'note').toUpperCase()}]`, ...lines].join('\n');
    }
    case 'code': {
      const indent = b.indent || '';
      let fence = b.fence || '```';
      const runs = b.text.match(fence[0] === '`' ? /`{3,}/g : /~{3,}/g) || [];
      for (const r of runs) if (r.length >= fence.length) fence = fence[0].repeat(r.length + 1);
      const body = b.text ? `\n${prefixLines(b.text, indent)}` : '';
      return `${indent}${fence}${b.lang || ''}${body}\n${indent}${fence}`;
    }
    case 'divider':
      return '---';
    case 'table':
      return tableToMarkdown(b);
    case 'image': {
      const src = /[\s()]/.test(b.src) ? `<${b.src}>` : b.src;
      return `${b.indent || ''}![${b.alt || ''}](${src}${b.title ? ` "${b.title}"` : ''})`;
    }
    case 'frontmatter':
      return `---\n${b.text}\n---`;
    default:
      return b.text || '';
  }
}

// Blocks that exist only in the editor (an empty line the user hasn't typed into).
const isPlaceholder = (b) => (b.dirty || b.raw == null)
  && (b.type === 'paragraph' || b.type === 'heading') && !(b.text || '').trim();

export function serialize(doc) {
  const blocks = doc.blocks.filter((b) => !isPlaceholder(b));
  let out = blocks.length ? doc.lead || '' : '';
  blocks.forEach((b, k) => {
    const md = !b.dirty && b.raw != null ? b.raw : blockToMarkdown(b, blocks, k);
    out += md + gapFor(b, blocks[k + 1]);
  });
  if (!doc.blocks.some((b) => b.raw != null || b.dirty) && !blocks.length) out = doc.lead || '';
  return doc.eol === '\r\n' ? out.replace(/\n/g, '\r\n') : out;
}
