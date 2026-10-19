'use strict';

// Node notes are stored as Markdown so agents read the same text the editor shows.
// Run: node tests/test_idea_workbench_markdown.cjs
const assert = require('node:assert/strict');
const { parse, serialize, parseInline, serializeInline } = require('../idea_workbench/static/note-markdown.js');

const roundtrip = (markdown, message) => assert.equal(serialize(parse(markdown)), markdown, message);
const text = value => ({ text: value });

// Bodies written before the editor existed are plain text: single newlines stay line breaks.
const legacy = '实际记录 r-1 / r-2：3 阶训练 RMSE=0.12；\n9 阶外推 RMSE=4.5。\n\n这是单个种子的合成数据观察。';
assert.deepEqual(parse(legacy), [
  { type: 'paragraph', inline: [text('实际记录 r-1 / r-2：3 阶训练 RMSE=0.12；\n9 阶外推 RMSE=4.5。')] },
  { type: 'paragraph', inline: [text('这是单个种子的合成数据观察。')] },
]);
roundtrip(legacy, 'Plain text survives a save unchanged');
roundtrip('train_rmse_9 vs train_rmse_3, step 2*3 = 6, see [1] and C:\\tmp', 'Ordinary symbols are not escaped needlessly');

// Every block the editor offers survives a save.
const note = [
  '# 问题', '## 设置', '### 细节',
  '正文有 **加粗**、*斜体*、~~删除~~、`code` 和 [链接](https://example.com/a_b)。',
  '- 一\n  - 一点一\n- 二', '1. 第一\n2. 第二\n   1. 嵌套',
  '- [ ] 待办\n- [x] 完成', '> 引用第一行\n> 第二行',
  '```python\nprint("hi")\n\n# comment\n```', '---', '![loss](assets/0123456789abcdef01234567.png)',
  '| a | b |\n| --- | ---: |\n| 1 | **2** |', '$$\n\\frac{a}{b}\n$$',
].join('\n\n');
roundtrip(note, 'All supported blocks round-trip');
const blocks = parse(note);
assert.deepEqual(blocks.map(block => block.type), ['heading', 'heading', 'heading', 'paragraph', 'list', 'list', 'list',
  'quote', 'code', 'divider', 'image', 'table', 'raw']);
assert.deepEqual(blocks[3].inline, [text('正文有 '), { text: '加粗', bold: true }, text('、'), { text: '斜体', italic: true },
  text('、'), { text: '删除', strike: true }, text('、'), { text: 'code', code: true }, text(' 和 '),
  { text: '链接', href: 'https://example.com/a_b' }, text('。')]);
assert.deepEqual(blocks[4].items[0].children[0].items[0].inline, [text('一点一')]);
assert.deepEqual(blocks[6].items.map(item => item.checked), [false, true]);
assert.equal(blocks[8].lang, 'python');
assert.equal(blocks[8].text, 'print("hi")\n\n# comment');
assert.deepEqual(blocks[10], { type: 'image', alt: 'loss', src: 'assets/0123456789abcdef01234567.png' });

// Blocks nested inside list items or quotes are kept verbatim; agents write these routinely.
for (const nested of [
  '1. Run:\n   ```py\n   def f():\n       return 1\n   ```\n2. Next',
  '- Results:\n\n  | a | b |\n  |---|---|\n  | 1 | 2 |\n- Done',
  '- Formula:\n  $$\n  a^2\n  $$',
  '- Figure:\n  ![loss](assets/0123456789abcdef01234567.png)',
  '- Note:\n  > quoted under an item',
  '> ```py\n> x = 1\n> ```',
  '- step\n      indented code\n- b',
]) roundtrip(nested, `Nested content survives a save: ${JSON.stringify(nested)}`);
assert.equal(parse('1. Run:\n   ```py\n   - not an item\n\n   x\n   ```\n2. Next')[0].type, 'raw',
  'A fence inside an item swallows lines that look like items or blank lines');

// Tables render as tables: cells hold inline Markdown, alignment is kept, pipes in text are escaped.
{
  const [table] = parse('| 小经验 | 英文 Δ |\n|---|---:|\n| ⑤ 相似对象 | **+8.33** |\n| 完整 E_v4 | +5.56 |');
  assert.deepEqual(table, { type: 'table', align: ['', 'right'], rows: [
    [[text('小经验')], [text('英文 Δ')]],
    [[text('⑤ 相似对象')], [{ text: '+8.33', bold: true }]],
    [[text('完整 E_v4')], [text('+5.56')]],
  ] });
  assert.equal(serialize([table]), '| 小经验 | 英文 Δ |\n| --- | ---: |\n| ⑤ 相似对象 | **+8.33** |\n| 完整 E_v4 | +5.56 |',
    'Compact tables are saved in a normalized but equivalent form');
  const piped = { type: 'table', align: ['center', 'left'], rows: [[[text('a|b')], [{ text: 'x|y', code: true }]], [[], [text('c\\|d')]]] };
  assert.deepEqual(parse(serialize([piped])), [piped], 'Pipes in text and code, and empty cells, read back unchanged');
  assert.deepEqual(parse('| a |\n|---|\n| 1 |\n\nafter').map(block => block.type), ['table', 'paragraph']);
  assert.deepEqual(parse('| a | b |\n|---|---|\n| 1 |')[0].rows[1], [[text('1')], []], 'Short rows are padded');
  for (const odd of ['| a | b |\n|---|---|\n| 1 | 2 | 3 |', '| not | a table |\n| just | pipes |']) {
    assert.equal(parse(odd)[0].type, 'raw', `Tables that cannot be modelled stay verbatim: ${odd}`);
    roundtrip(odd);
  }
}

// Text that looks like syntax is escaped so it reads back as the same text.
for (const value of ['# not a heading', '- not a list', '1. not a list', '> not a quote', '---', '**not bold**',
  '`not code`', '[not](a link)', '![not](an image)', '| not | a table |', 'a\\*b', '[ ] not a task']) {
  const saved = serialize([{ type: 'paragraph', inline: [text(value)] }]);
  assert.deepEqual(parse(saved), [{ type: 'paragraph', inline: [text(value)] }], `${value} → ${saved}`);
}
const tricky = [{ type: 'list', ordered: false, items: [
  { inline: [text('[ ] literal brackets\n- continued line')], checked: null, children: [] }] }];
assert.deepEqual(parse(serialize(tricky)), tricky, 'List text never turns into tasks or nested items');
const fence = [{ type: 'code', lang: '', text: '```\ninside\n```' }];
assert.deepEqual(parse(serialize(fence)), fence, 'Code containing fences gets a longer fence');

// Inline formatting merges adjacent equal spans and drops empty ones.
assert.equal(serializeInline([{ text: 'a', bold: true }, { text: 'b', bold: true }, text(''), text('c')]), '**ab**c');
assert.deepEqual(parseInline('**unclosed and *also'), [text('**unclosed and *also')]);
assert.deepEqual(parseInline('[x](javascript:alert(1))'), [text('[x](javascript:alert(1))')], 'Only web and mail links are links');
assert.deepEqual(parseInline('**[粗链接](https://a.b)**'), [{ text: '粗链接', bold: true, href: 'https://a.b' }]);

// Unclosed or unusual input never loses text.
assert.deepEqual(parse('```js\nconst a = 1;'), [{ type: 'code', lang: 'js', text: 'const a = 1;' }]);
assert.deepEqual(parse('#'), [{ type: 'heading', level: 1, inline: [] }]);
assert.deepEqual(parse(''), []);
assert.equal(serialize([{ type: 'code', lang: '', text: '' }, { type: 'paragraph', inline: [text(' ')] }, { type: 'divider' }]), '---',
  'Empty code blocks and blank paragraphs are not saved');
assert.deepEqual(parse('- a\n\n- b'), [{ type: 'list', ordered: false, items: [
  { inline: [text('a')], checked: null, children: [] }, { inline: [text('b')], checked: null, children: [] }] }]);
assert.deepEqual(parse('- a\n1. b').map(block => block.ordered), [false, true], 'Switching markers starts a new list');
assert.equal(serialize(parse('#### deep\n\n<b>html</b>')), '#### deep\n\n<b>html</b>');

// Randomized: any text and marks typed into a paragraph, list item or quote reads back unchanged.
let seed = 7;
const random = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
const alphabet = ['a', 'b', ' ', '*', '**', '_', '`', '~', '~~', '[', ']', '(', ')', '!', '\\', '#', '-', '1.', '>', '|', '$$', '\n', '中'];
const plainText = spans => spans.map(span => span.text).join('');
// Whitespace at line ends, and indentation inside list items, carries no meaning in Markdown.
const comparable = (value, type) => value.split('\n').map(line => type === 'list' ? line.trim() : line.trimEnd()).join('\n').trim();
for (let round = 0; round < 5000; round++) {
  const spans = Array.from({ length: 1 + random(4) }, () => ({
    text: Array.from({ length: 1 + random(6) }, () => alphabet[random(alphabet.length)]).join(''),
    ...(random(4) === 0 ? { bold: true } : {}), ...(random(5) === 0 ? { italic: true } : {}),
  }));
  const full = plainText(spans);
  // A blank line inside a block would legitimately start a new block.
  if (!full.trim() || /\n[ \t]*\n/.test(full.trim())) continue;
  const block = [{ type: 'paragraph', inline: spans }, { type: 'quote', inline: spans },
    { type: 'list', ordered: false, items: [{ inline: spans, checked: null, children: [] }] }][round % 3];
  const saved = serialize([block]), restored = parse(saved);
  const where = `${block.type}: ${JSON.stringify(spans)} → ${JSON.stringify(saved)}`;
  assert.equal(restored.length, 1, where);
  const inlineOf = restored[0].inline ?? restored[0].items?.[0]?.inline ?? [];
  assert.equal(comparable(plainText(inlineOf), block.type), comparable(full, block.type), where);
}

console.log('note markdown: ok');
