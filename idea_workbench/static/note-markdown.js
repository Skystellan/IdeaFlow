(() => {
  'use strict';

  // Node bodies are Markdown, so Codex reads the same text the editor shows. This module
  // converts between Markdown and a small block model; it never produces HTML.
  // Single newlines inside a paragraph are line breaks, which keeps older plain-text bodies intact.
  //
  // Blocks: paragraph/heading/quote { inline }, list { ordered, start?, items: [{ inline, checked, children }] },
  // code { lang, text }, divider, image { alt, src }, raw { text } for tables and math kept verbatim.
  // Inline: [{ text, bold?, italic?, strike?, code?, href? }].

  const MARKS = ['href', 'bold', 'italic', 'strike', 'code'];
  const PUNCTUATION = /[!-/:-@[-`{-~]/;
  const LIST = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*)|[ \t]*)$/;
  const TASK = /^\[([ xX])\](?:[ \t]+|$)/;
  const HEADING = /^(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
  const DIVIDER = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([\w+#.-]*)[ \t]*$/;
  const IMAGE = /^!\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)\)$/;
  const QUOTE = /^ {0,3}> ?(.*)$/;
  const TABLE = /^ {0,3}\|/;
  const MATH = /^ {0,3}\$\$/;
  const SAFE_LINK = /^(?:https?:\/\/|mailto:)/i;

  function startsBlock(line) {
    return HEADING.test(line) || DIVIDER.test(line) || FENCE.test(line) || LIST.test(line) || QUOTE.test(line)
      || IMAGE.test(line.trim()) || TABLE.test(line) || MATH.test(line);
  }

  // ---- Inline ----

  const same = (a, b) => MARKS.every(mark => (a[mark] || undefined) === (b[mark] || undefined));

  function normalize(spans) {
    const result = [];
    for (const span of spans) {
      if (!span.text) continue;
      const last = result[result.length - 1];
      if (last && same(last, span)) last.text += span.text;
      else result.push({ ...span });
    }
    return result;
  }

  function withMark(spans, mark, value = true) {
    return spans.map(span => ({ ...span, [mark]: value }));
  }

  const INLINE_RULES = [
    { pattern: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/, build: m => [{ text: m[2], code: true }] },
    { pattern: /^\[((?:\\.|[^\]\\\n])*)\]\(([^)\s]+)\)/, build: m => SAFE_LINK.test(m[2])
      ? withMark(inline(m[1]), 'href', unescapeUrl(m[2])) : [{ text: m[0] }] },
    { pattern: /^\*\*\*(?=[^\s*])([\s\S]*?[^\s*])\*\*\*(?!\*)/, build: m => withMark(withMark(inline(m[1]), 'bold'), 'italic') },
    { pattern: /^\*\*(?=\S)([\s\S]*?\S)\*\*/, build: m => withMark(inline(m[1]), 'bold') },
    { pattern: /^~~(?=\S)([\s\S]*?\S)~~/, build: m => withMark(inline(m[1]), 'strike') },
    { pattern: /^\*(?=[^\s*])([\s\S]*?[^\s*])\*(?!\*)/, build: m => withMark(inline(m[1]), 'italic') },
  ];

  function inline(source) {
    const spans = [];
    let plain = '';
    for (let i = 0; i < source.length;) {
      const char = source[i];
      if (char === '\\' && PUNCTUATION.test(source[i + 1] || '')) { plain += source[i + 1]; i += 2; continue; }
      if ('`[*~'.includes(char)) {
        const rest = source.slice(i);
        const rule = INLINE_RULES.find(candidate => candidate.pattern.test(rest));
        if (rule) {
          const match = rule.pattern.exec(rest);
          spans.push({ text: plain }, ...rule.build(match));
          plain = '';
          i += match[0].length;
          continue;
        }
      }
      plain += char;
      i++;
    }
    spans.push({ text: plain });
    return spans;
  }

  function parseInline(source) { return normalize(inline(String(source || ''))); }

  const escapeAll = value => value.replace(/[\\`*~[\]!]/g, '\\$&');
  const encodeUrl = url => url.replace(/[\s()<>]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  function unescapeUrl(url) { return url.replace(/\\([!-/:-@[-`{-~])/g, '$1'); }

  function render(spans, escape) {
    let out = '', open = [];
    const close = keep => {
      while (open.length && !keep(open[open.length - 1])) {
        const mark = open.pop();
        out += mark.mark === 'href' ? `](${encodeUrl(mark.value)})` : DELIMITERS[mark.mark];
      }
    };
    for (const span of spans) {
      // Close every mark the next span lacks (and anything opened inside it), then open new ones.
      const keepUntil = open.findIndex(item => (span[item.mark] || undefined) !== item.value);
      if (keepUntil >= 0) close(item => open.indexOf(item) < keepUntil);
      for (const mark of MARKS) {
        if (span[mark] && !open.some(item => item.mark === mark)) {
          open.push({ mark, value: span[mark] });
          out += mark === 'href' ? '[' : DELIMITERS[mark];
        }
      }
      out += span.code ? span.text : escape ? escapeAll(span.text) : span.text;
    }
    close(() => false);
    return out;
  }
  const DELIMITERS = { bold: '**', italic: '*', strike: '~~', code: '`' };

  const EMPHASIS = ['bold', 'italic', 'strike'];
  const canonical = spans => JSON.stringify(spans.map(span => [span.text, ...MARKS.map(mark => span[mark] || null)]));

  // Markdown cannot write whitespace at the edge of emphasis ("** a**"), so it moves outside the mark.
  function tidy(spans) {
    const result = [];
    for (const original of normalize(spans || [])) {
      const span = { ...original, code: original.code && !original.text.includes('`') || undefined,
        href: original.href ? encodeUrl(original.href) : undefined };
      const [, before, core, after] = /^(\s*)([\s\S]*?)(\s*)$/.exec(span.text);
      if (span.code || !EMPHASIS.some(mark => span[mark]) || (!before && !after)) { result.push(span); continue; }
      const outside = { ...span, bold: undefined, italic: undefined, strike: undefined };
      result.push({ ...outside, text: before }, { ...span, text: core }, { ...outside, text: after });
    }
    return normalize(result);
  }

  // `finish` applies the block's line escaping, so the check covers exactly what gets stored.
  function serializeInline(spans, finish = out => out) {
    const clean = tidy(spans), expected = canonical(clean);
    // Prefer readable output; escape only when the plain form would read back differently.
    for (const escape of [false, true]) {
      const out = finish(render(clean, escape));
      if (canonical(parseInline(out)) === expected) return out;
    }
    // Overlapping marks Markdown cannot express: keep every character, drop the formatting.
    return finish(escapeAll(clean.map(span => span.text).join('')));
  }

  // ---- Blocks ----

  // Text typed at the start of a quote or list line that would otherwise open a verbatim block.
  const escapeVerbatim = line => FENCE.test(line) || TABLE.test(line) || MATH.test(line) ? escapeLine(line) : line;

  function escapeLine(line) {
    if (!startsBlock(line)) return line;
    const ordered = /^(\s*\d+)([.)])/.exec(line);
    if (ordered) return `${ordered[1]}\\${line.slice(ordered[1].length)}`;
    const indent = /^\s*/.exec(line)[0];
    return `${indent}\\${line.slice(indent.length)}`;
  }

  // A list item here holds text and nested lists only. A list containing anything else
  // (fenced code, tables, math, quotes, headings, images) is kept verbatim as a raw block.
  const NESTED_BLOCK = line => FENCE.test(line) || TABLE.test(line) || MATH.test(line) || QUOTE.test(line)
    || HEADING.test(line) || IMAGE.test(line.trim());
  const closingFence = open => new RegExp(`^ *${open[1][0] === '`' ? '`' : '~'}{${open[1].length},}[ \\t]*$`);

  function parseList(lines, start) {
    const roots = [], stack = [];
    let i = start, verbatim = false, fence = null;
    const newList = (ordered, number) => ({ type: 'list', ordered, ...(ordered ? { start: number } : {}), items: [] });
    // An item's own first line opens a block only for fences, tables and math; other markers there are text.
    const nest = (text, first = false) => {
      if (first ? !(FENCE.test(text) || TABLE.test(text) || MATH.test(text)) : !NESTED_BLOCK(text)) return;
      verbatim = true;
      const open = FENCE.exec(text);
      if (open) fence = closingFence(open);
    };
    while (i < lines.length) {
      const line = lines[i];
      // Inside a fence every line belongs to it, including blank lines and "- " lines.
      if (fence) { if (fence.test(line)) fence = null; i++; continue; }
      const match = LIST.exec(line);
      if (!match || DIVIDER.test(line)) {
        if (!line.trim()) {
          const next = lines.slice(i + 1).find(candidate => candidate.trim());
          if (next !== undefined && (LIST.test(next) && !DIVIDER.test(next) || /^ {2,}\S/.test(next))) { i++; continue; }
          break;
        }
        const indent = /^ */.exec(line)[0].length;
        if (indent < 2 || !stack.length) break;
        const owner = [...stack].reverse().find(entry => entry.indent < indent) || stack[0];
        // Keep indentation beyond the item's own, so code-like lines stay aligned.
        const text = line.slice(Math.min(indent, owner.content));
        nest(text);
        owner.list.items[owner.list.items.length - 1].source += `\n${text}`;
        i++;
        continue;
      }
      const indent = match[1].length, ordered = /\d/.test(match[2]);
      let source = match[3] || '', checked = null;
      const task = TASK.exec(source);
      if (task) { checked = task[1] !== ' '; source = source.slice(task[0].length); }
      nest(source, true);
      const item = { source, checked, children: [] };
      const entry = list => ({ indent, content: indent + match[2].length + 1, list });
      const top = stack[stack.length - 1];
      if (top && indent >= top.indent + 2) {
        const parent = top.list.items[top.list.items.length - 1];
        const list = newList(ordered, parseInt(match[2], 10));
        parent.children.push(list);
        stack.push(entry(list));
      } else {
        while (stack.length > 1 && stack[stack.length - 1].indent > indent + 1) stack.pop();
        const current = stack[stack.length - 1];
        if (!current || current.list.ordered !== ordered) {
          const list = newList(ordered, parseInt(match[2], 10));
          if (stack.length > 1) stack[stack.length - 2].list.items.at(-1).children.push(list);
          else roots.push(list);
          if (current) stack[stack.length - 1] = entry(list); else stack.push(entry(list));
        }
      }
      stack[stack.length - 1].list.items.push(item);
      i++;
    }
    if (verbatim) return { blocks: [{ type: 'raw', text: lines.slice(start, i).join('\n') }], next: i };
    const finish = list => ({ ...list, items: list.items.map(({ source, checked, children }) =>
      ({ inline: parseInline(source), checked, children: children.map(finish) })) });
    return { blocks: roots.map(finish), next: i };
  }

  function parse(markdown) {
    const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const fence = FENCE.exec(line);
      if (fence) {
        const body = [];
        const closing = new RegExp(`^ {0,3}${fence[1][0] === '`' ? '`' : '~'}{${fence[1].length},}[ \\t]*$`);
        for (i++; i < lines.length && !closing.test(lines[i]); i++) body.push(lines[i]);
        blocks.push({ type: 'code', lang: fence[2], text: body.join('\n') });
        i++;
        continue;
      }
      if (MATH.test(line)) {
        const body = [line];
        const single = line.trim().length > 2 && line.trim().endsWith('$$') && line.trim() !== '$$';
        if (!single) {
          for (i++; i < lines.length; i++) {
            body.push(lines[i]);
            if (lines[i].trim().endsWith('$$')) break;
          }
        }
        blocks.push({ type: 'raw', text: body.join('\n') });
        i++;
        continue;
      }
      if (TABLE.test(line)) {
        const body = [];
        for (; i < lines.length && TABLE.test(lines[i]); i++) body.push(lines[i]);
        blocks.push({ type: 'raw', text: body.join('\n') });
        continue;
      }
      const heading = HEADING.exec(line);
      if (heading) {
        blocks.push({ type: 'heading', level: heading[1].length, inline: parseInline(heading[2] || '') });
        i++;
        continue;
      }
      if (DIVIDER.test(line)) { blocks.push({ type: 'divider' }); i++; continue; }
      const image = IMAGE.exec(line.trim());
      if (image) {
        blocks.push({ type: 'image', alt: image[1].replace(/\\(.)/g, '$1'), src: unescapeUrl(image[2]) });
        i++;
        continue;
      }
      if (QUOTE.test(line)) {
        const body = [], first = i;
        for (; i < lines.length && QUOTE.test(lines[i]); i++) body.push(QUOTE.exec(lines[i])[1]);
        // A quote holding code, tables or math is kept verbatim, like such lists.
        if (body.some(text => FENCE.test(text) || TABLE.test(text) || MATH.test(text))) blocks.push({ type: 'raw', text: lines.slice(first, i).join('\n') });
        else blocks.push({ type: 'quote', inline: parseInline(body.join('\n')) });
        continue;
      }
      if (LIST.test(line)) {
        const list = parseList(lines, i);
        blocks.push(...list.blocks);
        i = list.next;
        continue;
      }
      const body = [line];
      for (i++; i < lines.length && lines[i].trim() && !startsBlock(lines[i]); i++) body.push(lines[i]);
      blocks.push({ type: 'paragraph', inline: parseInline(body.join('\n')) });
    }
    return blocks;
  }

  function serializeList(list, indent = '') {
    return list.items.map((item, index) => {
      const marker = list.ordered ? `${(list.start ?? 1) + index}.` : '-';
      const inner = indent + ' '.repeat(marker.length + 1);
      const task = item.checked === true ? '[x] ' : item.checked === false ? '[ ] ' : '';
      const text = serializeInline(item.inline, out => out.split('\n').map((line, index) =>
        index ? escapeLine(line) : !task && TASK.test(line) ? `\\${line}` : escapeVerbatim(line)).join('\n'));
      const [head, ...rest] = text.split('\n');
      const lines = [`${indent}${marker} ${task}${head}`.trimEnd(), ...rest.map(line => `${inner}${line}`)];
      for (const child of item.children || []) lines.push(serializeList(child, inner));
      return lines.join('\n');
    }).join('\n');
  }

  function serializeBlock(block) {
    switch (block.type) {
      case 'heading': {
        const oneLine = block.inline.map(span => ({ ...span, text: span.text.replace(/\n/g, ' ') }));
        return `${'#'.repeat(Math.min(6, Math.max(1, block.level || 1)))} ${serializeInline(oneLine)}`.trimEnd();
      }
      case 'quote': return serializeInline(block.inline, out => out.split('\n').map(escapeVerbatim).join('\n'))
        .split('\n').map(line => `> ${line}`.trimEnd()).join('\n');
      case 'list': return serializeList(block);
      case 'code': {
        const longest = Math.max(0, ...(block.text.match(/`+/g) || []).map(run => run.length));
        const fence = '`'.repeat(Math.max(3, longest + 1));
        return `${fence}${String(block.lang || '').replace(/[^\w+#.-]/g, '')}\n${block.text}\n${fence}`;
      }
      case 'divider': return '---';
      case 'image': return `![${String(block.alt || '').replace(/[\\\]]/g, '\\$&')}](${encodeUrl(block.src)})`;
      case 'raw': return block.text;
      default: return serializeInline(block.inline, out => out.split('\n').map(escapeLine).join('\n'));
    }
  }

  function isEmpty(block) {
    if (block.type === 'paragraph') return !block.inline.some(span => span.text.trim());
    if (block.type === 'list') return !block.items.length;
    if (block.type === 'raw' || block.type === 'code') return !block.text.trim();
    return false;
  }

  function serialize(blocks) {
    return (blocks || []).filter(block => !isEmpty(block)).map(serializeBlock).join('\n\n');
  }

  const api = { parse, serialize, parseInline, serializeInline, startsBlock, SAFE_LINK };
  if (typeof window !== 'undefined') window.NoteMarkdown = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
