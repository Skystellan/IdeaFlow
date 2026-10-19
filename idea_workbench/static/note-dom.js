(() => {
  'use strict';

  // Converts between the editor's DOM and NoteMarkdown blocks. Rendering only creates
  // elements and text nodes, so note text can never become markup. Reading accepts whatever
  // the browser produced while editing (divs, spans, stray text) and maps it back to blocks.
  const { SAFE_LINK } = window.NoteMarkdown;
  const ASSET = /^assets\/[0-9a-f]{24}\.(?:png|jpg|gif|webp)$/;
  const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'HR', 'FIGURE', 'TABLE', 'SECTION', 'ARTICLE']);

  const imageUrl = src => ASSET.test(src) ? `/${src}` : null;

  function el(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  // ---- Blocks → DOM ----

  function appendText(parent, text) {
    text.split('\n').forEach((line, index) => {
      if (index) parent.append(document.createElement('br'));
      if (line) parent.append(document.createTextNode(line));
    });
  }

  function inlineNodes(spans) {
    const fragment = document.createDocumentFragment();
    for (const span of spans || []) {
      let node = document.createDocumentFragment();
      appendText(node, span.text);
      for (const [mark, tag] of [['code', 'code'], ['strike', 's'], ['italic', 'em'], ['bold', 'strong']]) {
        if (!span[mark]) continue;
        const wrapper = document.createElement(tag);
        wrapper.append(node);
        node = wrapper;
      }
      if (span.href) {
        const link = document.createElement('a');
        link.href = span.href;
        link.title = '⌘ 点击在浏览器中打开';
        link.append(node);
        node = link;
      }
      fragment.append(node);
    }
    return fragment;
  }

  function filled(element, spans) {
    element.append(inlineNodes(spans));
    // An empty block needs a <br> so the caret has somewhere to go.
    if (!element.textContent) element.append(document.createElement('br'));
    return element;
  }

  function figure(src, alt) {
    const box = el('figure', 'note-figure');
    box.contentEditable = 'false';
    box.dataset.src = src;
    box.dataset.alt = alt || '';
    const url = imageUrl(src);
    if (url) {
      const image = el('img');
      Object.assign(image, { src: url, alt: alt || '', draggable: false, loading: 'lazy' });
      box.append(image);
    } else {
      box.classList.add('is-external');
      box.append(el('span', '', `外部图片未加载：${src}`));
    }
    const remove = el('button', 'figure-remove', '✕');
    Object.assign(remove, { type: 'button', title: '删除图片' });
    remove.setAttribute('aria-label', '删除图片');
    box.append(remove);
    return box;
  }

  function listNode(block) {
    const list = el(block.ordered ? 'ol' : 'ul');
    if (block.ordered && block.start && block.start !== 1) list.start = block.start;
    for (const item of block.items) {
      const li = filled(el('li'), item.inline);
      if (item.checked !== null && item.checked !== undefined) li.dataset.checked = String(item.checked);
      for (const child of item.children || []) li.append(listNode(child));
      list.append(li);
    }
    return list;
  }

  function tableCell(tag, spans, align) {
    const cell = filled(el(tag), spans);
    if (align) { cell.dataset.align = align; cell.style.textAlign = align; }
    return cell;
  }

  function tableNode(block) {
    const columns = Math.max(1, ...block.rows.map(row => row.length));
    const table = el('table', 'note-table'), head = el('thead'), body = el('tbody');
    block.rows.forEach((row, index) => {
      const line = el('tr');
      for (let column = 0; column < columns; column++) line.append(tableCell(index ? 'td' : 'th', row[column] || [], block.align?.[column]));
      (index ? body : head).append(line);
    });
    table.append(head, body);
    return table;
  }

  function blockNode(block) {
    switch (block.type) {
      case 'heading': return filled(el(`h${Math.min(6, Math.max(1, block.level))}`), block.inline);
      case 'quote': return filled(el('blockquote'), block.inline);
      case 'list': return listNode(block);
      case 'code': {
        const pre = el('pre', 'note-code', block.text || '');
        if (block.lang) pre.dataset.lang = block.lang;
        return pre;
      }
      case 'raw': {
        const pre = el('pre', 'note-raw', block.text);
        pre.dataset.raw = 'true';
        pre.title = '原样保留的 Markdown（表格、公式等）';
        return pre;
      }
      case 'divider': return el('hr');
      case 'table': return tableNode(block);
      case 'image': return figure(block.src, block.alt);
      default: return filled(el('p'), block.inline);
    }
  }

  function render(blocks) {
    const fragment = document.createDocumentFragment();
    blocks.forEach(block => fragment.append(blockNode(block)));
    return fragment;
  }

  // ---- DOM → blocks ----

  function styleMarks(element, marks) {
    const style = element.style;
    const next = { ...marks };
    if (style.fontWeight === 'bold' || Number(style.fontWeight) >= 600) next.bold = true;
    if (style.fontStyle === 'italic') next.italic = true;
    if (style.textDecorationLine?.includes('line-through') || style.textDecoration?.includes('line-through')) next.strike = true;
    return next;
  }

  // Collect inline spans; images found inside text are hoisted out as their own blocks.
  function collect(node, marks, spans, hoisted) {
    if (node.nodeType === Node.TEXT_NODE) {
      spans.push({ text: node.nodeValue.replace(/\u00a0/g, ' ').replace(/\u200b/g, ''), ...marks });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName;
    if (tag === 'BR') { spans.push({ text: '\n' }); return; }
    if (tag === 'FIGURE') { hoisted.push(...readBlock(node, [])); return; }
    if (tag === 'UL' || tag === 'OL') { hoisted.push(readList(node, hoisted)); return; }
    if (tag === 'TABLE') { hoisted.push(readTable(node, hoisted)); return; }
    if (tag === 'IMG' || tag === 'BUTTON' || tag === 'STYLE' || tag === 'SCRIPT') return;
    let next = styleMarks(node, marks);
    if (tag === 'B' || tag === 'STRONG') next.bold = true;
    if (tag === 'I' || tag === 'EM') next.italic = true;
    if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') next.strike = true;
    if (tag === 'CODE') next = { ...next, code: true };
    if (tag === 'A' && SAFE_LINK.test(node.getAttribute('href') || '')) next.href = node.getAttribute('href');
    const block = BLOCK_TAGS.has(tag) && tag !== 'LI';
    if (block && spans.length && !spans[spans.length - 1].text.endsWith('\n')) spans.push({ text: '\n' });
    node.childNodes.forEach(child => collect(child, next, spans, hoisted));
    if (block && spans.length && !spans[spans.length - 1].text.endsWith('\n')) spans.push({ text: '\n' });
  }

  function inlineOf(element, hoisted, skip = () => false) {
    const spans = [];
    element.childNodes.forEach(child => { if (!skip(child)) collect(child, {}, spans, hoisted); });
    // The browser keeps a trailing <br> in blocks; it is not a line the writer typed.
    const last = spans[spans.length - 1];
    if (last && last.text.endsWith('\n')) last.text = last.text.slice(0, -1);
    return spans.filter(span => span.text);
  }

  const isList = node => node.nodeType === Node.ELEMENT_NODE && (node.tagName === 'UL' || node.tagName === 'OL');

  function readList(list, hoisted) {
    const ordered = list.tagName === 'OL';
    const block = { type: 'list', ordered, ...(ordered ? { start: Number(list.getAttribute('start')) || 1 } : {}), items: [] };
    for (const child of list.childNodes) {
      if (isList(child)) {
        // Some browsers indent by nesting a list directly inside the list.
        if (!block.items.length) block.items.push({ inline: [], checked: null, children: [] });
        block.items[block.items.length - 1].children.push(readList(child, hoisted));
        continue;
      }
      if (child.nodeType === Node.TEXT_NODE && !child.nodeValue.trim()) continue;
      const checked = child.dataset?.checked;
      const item = {
        inline: child.nodeType === Node.ELEMENT_NODE ? inlineOf(child, hoisted, isList) : [{ text: child.nodeValue }],
        checked: checked === 'true' ? true : checked === 'false' ? false : null,
        children: child.nodeType === Node.ELEMENT_NODE ? [...child.childNodes].filter(isList).map(nested => readList(nested, hoisted)) : [],
      };
      block.items.push(item);
    }
    return block;
  }

  function preText(pre) {
    let text = '';
    const walk = node => {
      if (node.nodeType === Node.TEXT_NODE) text += node.nodeValue.replace(/\u00a0/g, ' ');
      else if (node.tagName === 'BR') text += '\n';
      else {
        if (BLOCK_TAGS.has(node.tagName) && text && !text.endsWith('\n')) text += '\n';
        node.childNodes.forEach(walk);
      }
    };
    pre.childNodes.forEach(walk);
    return text.replace(/\n$/, '');
  }

  // The first row is the header, whether or not the browser put it in <thead> (pasted tables often don't).
  function readTable(table, hoisted) {
    const rows = [...table.querySelectorAll('tr')].filter(row => row.closest('table') === table);
    const cells = rows.map(row => [...row.children].filter(cell => cell.tagName === 'TD' || cell.tagName === 'TH')
      .map(cell => inlineOf(cell, hoisted).map(span => ({ ...span, text: span.text.replace(/\n/g, ' ') }))));
    const header = rows[0] ? [...rows[0].children] : [];
    return { type: 'table', align: header.map(cell => cell.dataset?.align || ''), rows: cells.length ? cells : [[[]]] };
  }

  function readBlock(node, hoisted) {
    const tag = node.tagName;
    if (/^H[1-6]$/.test(tag)) return [{ type: 'heading', level: Number(tag[1]), inline: inlineOf(node, hoisted) }];
    if (tag === 'BLOCKQUOTE') return [{ type: 'quote', inline: inlineOf(node, hoisted) }];
    if (tag === 'UL' || tag === 'OL') return [readList(node, hoisted)];
    if (tag === 'PRE') {
      return [node.dataset.raw ? { type: 'raw', text: preText(node) } : { type: 'code', lang: node.dataset.lang || '', text: preText(node) }];
    }
    if (tag === 'HR') return [{ type: 'divider' }];
    if (tag === 'TABLE') return [readTable(node, hoisted)];
    if (tag === 'FIGURE') return node.dataset.src ? [{ type: 'image', alt: node.dataset.alt || '', src: node.dataset.src }] : [];
    if ((tag === 'DIV' || tag === 'SECTION' || tag === 'ARTICLE') && [...node.children].some(child => BLOCK_TAGS.has(child.tagName))) {
      return read(node);
    }
    return [{ type: 'paragraph', inline: inlineOf(node, hoisted) }];
  }

  function read(root) {
    const blocks = [];
    let loose = null;
    const flush = () => {
      if (!loose) return;
      blocks.push({ type: 'paragraph', inline: inlineOf(loose, []) });
      loose = null;
    };
    for (const child of [...root.childNodes]) {
      const block = child.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(child.tagName);
      if (!block) {
        // Text the browser left directly in the editor belongs to one paragraph.
        // Build in the source document, so pasted HTML never starts loading images in the page.
        loose ||= root.ownerDocument.createElement('p');
        loose.append(child.cloneNode(true));
        continue;
      }
      flush();
      const hoisted = [];
      blocks.push(...readBlock(child, hoisted), ...hoisted);
    }
    flush();
    return blocks;
  }

  window.NoteDom = { render, read, inlineNodes, figure, imageUrl, BLOCK_TAGS };
})();
