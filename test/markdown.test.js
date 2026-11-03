import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, serialize, createBlock } from '../public/js/markdown.js';
import { mdToHtml } from '../public/js/inline.js';

const SAMPLES = {
  basic: '# Title\n\nSome *text* here.\nSecond line.\n\n## Sub\n\n- a\n- b\n  - nested\n- c\n',
  frontmatter: '---\ntitle: Hi\ntags: [a, b]\n---\n\n# Doc\n',
  code: 'Intro\n\n```js\nconst a = 1;\n\nconsole.log(a);\n```\n\nAfter\n',
  unclosedCode: '```\nnever closed\n',
  tildes: '~~~python\nprint("x")\n~~~\n',
  todos: '- [ ] one\n- [x] two\n* [X] three\n',
  numbered: '1. one\n2. two\n   1. sub\n3. three\n',
  quote: '> quoted\n> lines\n\n> [!WARNING]\n> careful\n',
  table: '| a | b |\n|:--|--:|\n| 1 | 2 |\n| 3 | 4 |\n',
  html: '<p align="center">\n  <img src="x.png">\n</p>\n\nText\n',
  setext: 'Title\n=====\n\nSub\n---\n\npara\n',
  divider: 'a\n\n---\n\nb\n\n***\n',
  image: '![alt text](./img/pic.png "Title")\n',
  noTrailingNewline: '# x\n\ny',
  extraBlankLines: '\n\n# x\n\n\n\ny\n\n\n',
  crlf: '# x\r\n\r\n- a\r\n- b\r\n',
  whitespaceOnly: '\n\n  \n',
  empty: '',
  lazy: '- item\ncontinued lazily\n- next\n',
  mixed: 'Para\n- list right after\n\n> quote\n```\ncode\n```\n',
};

test('untouched documents round-trip byte-for-byte', () => {
  for (const [name, src] of Object.entries(SAMPLES)) {
    assert.equal(serialize(parse(src)), src, name);
  }
});

const shape = (doc) => doc.blocks.map((b) => ({
  type: b.type, text: b.text ?? '', level: b.level, checked: b.checked, rows: b.rows, lang: b.lang, kind: b.kind,
}));

test('regenerated documents parse back to the same blocks', () => {
  for (const [name, src] of Object.entries(SAMPLES)) {
    const doc = parse(src);
    for (const b of doc.blocks) b.dirty = true;
    const out = serialize(doc);
    assert.deepEqual(shape(parse(out)), shape(parse(src)), `${name}:\n${out}`);
  }
});

test('editing one block leaves the rest untouched', () => {
  const src = 'Intro   with  odd   spacing\n\n* star bullet\n* another\n\n## Old\n';
  const doc = parse(src);
  const h = doc.blocks.find((b) => b.type === 'heading');
  h.text = 'New';
  h.dirty = true;
  assert.equal(serialize(doc), 'Intro   with  odd   spacing\n\n* star bullet\n* another\n\n## New\n');
});

test('inserting and converting blocks produces valid markdown', () => {
  const doc = parse('- a\n- b\n');
  const t = createBlock('todo', { text: 'task' });
  doc.blocks.splice(1, 0, t);
  doc.blocks.push(createBlock('paragraph', { text: 'after' }));
  assert.equal(serialize(doc), '- a\n- [ ] task\n- b\n\nafter\n');

  const nested = createBlock('bullet', { text: 'child', level: 1 });
  doc.blocks.splice(1, 0, nested);
  assert.match(serialize(doc), /^- a\n {2}- child\n/);
});

test('paragraph text that looks like block syntax is escaped', () => {
  const doc = parse('');
  doc.blocks.push(createBlock('paragraph', { text: '# not a heading' }), createBlock('paragraph', { text: '1. not a list' }));
  const out = serialize(doc);
  assert.equal(out, '\\# not a heading\n\n1\\. not a list\n');
  assert.deepEqual(parse(out).blocks.map((b) => b.type), ['paragraph', 'paragraph']);
});

test('empty placeholder blocks are not written', () => {
  const doc = parse('a\n');
  doc.blocks.push(createBlock('paragraph'));
  assert.equal(serialize(doc), 'a\n');
});

test('inline markdown renders safely', () => {
  assert.equal(mdToHtml('<script>x</script>'), '&lt;script&gt;x&lt;/script&gt;');
  assert.match(mdToHtml('**b** and *i* and `c`'), /<strong data-m="\*\*">b<\/strong> and <em data-m="\*">i<\/em> and <code>c<\/code>/);
  assert.match(mdToHtml('[x](javascript:alert(1))'), /href="#"/);
  assert.equal(mdToHtml('snake_case_name'), 'snake_case_name');
});
