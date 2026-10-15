(() => {
  'use strict';

  // A Notion/Obsidian-style writing surface for a node's body. Editing goes through the
  // browser's own commands where possible so ⌘Z keeps working. The DOM is the working copy;
  // `markdown()` turns it into the stored text.
  const { parse, serialize } = window.NoteMarkdown;
  const Dom = window.NoteDom;
  const IMAGE_TYPES = /^image\/(?:png|jpeg|gif|webp)$/;
  const TEXT_BLOCK = 'li, p, h1, h2, h3, h4, h5, h6, blockquote, pre, div';
  const HINT = '输入 / 插入标题、列表、图片…';
  // Typed at the start of a paragraph, these turn it into another block (full-width forms for Chinese input).
  const SHORTCUTS = [
    [/^(#{1,3}|＃{1,3})[ \u3000]$/, match => `h${match[1].length}`],
    [/^[-*+•][ \u3000]$/, () => 'bullet'],
    [/^\d{1,3}[.)。．][ \u3000]$/, () => 'ordered'],
    [/^(\[ ?\]|【 ?】)[ \u3000]$/, () => 'task'],
    [/^[>》][ \u3000]$/, () => 'quote'],
    [/^(```|···)$/, () => 'code'],
    [/^(---|———)$/, () => 'divider'],
  ];
  // Closing the second marker formats the text between, as in Notion and Obsidian.
  const INLINE_SHORTCUTS = [
    [/\*\*([^*\n]+?)\*\*$/, 'strong'],
    [/~~([^~\n]+?)~~$/, 's'],
    [/`([^`\n]+)`$/, 'code'],
    [/(?:^|[^*\w])(\*([^*\s](?:[^*\n]*[^*\s])?)\*)$/, 'em'],
  ];

  function create({ root, upload, onChange, onError, onEscape }) {
    Object.assign(root, { contentEditable: 'true', spellcheck: false });
    root.classList.add('note-editor');
    root.setAttribute('role', 'textbox');
    root.setAttribute('aria-multiline', 'true');
    root.dataset.placeholder = '写点什么……输入 / 插入标题、列表、图片；也可以直接粘贴或拖入图片。';
    // Bumped whenever another note loads, so a slow upload never lands in the wrong note.
    let composing = false, menus = null, generation = 0;
    const picker = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', multiple: true, hidden: true });
    root.after(picker);
    let pickAnchor = null;

    const changed = () => { normalize(); ensureContent(); updateHints(); onChange(); };

    // Browsers sometimes nest a new list or paragraph inside the old <p>; lift such blocks back
    // to the top level and keep the caret on the same text.
    function normalize() {
      const selection = window.getSelection();
      const anchor = selection.rangeCount ? [selection.anchorNode, selection.anchorOffset] : null;
      let lifted = false;
      for (let pass = 0; pass < 8; pass++) {
        const nested = [...root.children].filter(block => (block.tagName === 'P' || block.tagName === 'DIV')
          && [...block.children].some(child => Dom.BLOCK_TAGS.has(child.tagName)));
        if (!nested.length) break;
        for (const block of nested) {
          const parts = [];
          let loose = null;
          for (const child of [...block.childNodes]) {
            if (child.nodeType === Node.ELEMENT_NODE && Dom.BLOCK_TAGS.has(child.tagName)) { loose = null; parts.push(child); continue; }
            if (child.nodeType === Node.TEXT_NODE && !child.nodeValue.trim() && !loose) continue;
            if (!loose) { loose = document.createElement(block.tagName === 'DIV' ? 'p' : block.tagName); parts.push(loose); }
            loose.append(child);
          }
          block.replaceWith(...parts);
        }
        lifted = true;
      }
      if (lifted && anchor?.[0]?.isConnected && root.contains(anchor[0])) {
        try { selection.collapse(anchor[0], anchor[1]); } catch { /* The caret simply stays where the browser put it. */ }
      }
    }

    function caret() {
      const selection = window.getSelection();
      if (!selection.rangeCount) return null;
      const range = selection.getRangeAt(0);
      return root.contains(range.startContainer) ? range : null;
    }

    function element(node) { return node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement; }
    function textBlock(node) {
      const block = element(node)?.closest(TEXT_BLOCK);
      return block && block !== root && root.contains(block) ? block : null;
    }
    function topBlock(node) {
      let current = element(node);
      while (current && current.parentElement !== root) current = current.parentElement;
      return current && root.contains(current) ? current : null;
    }

    // Text with line breaks counted, which Range.toString() leaves out for <br>.
    function textOf(fragment) {
      let text = '';
      const walk = node => {
        if (node.nodeType === Node.TEXT_NODE) text += node.nodeValue;
        else if (node.tagName === 'BR') text += '\n';
        else node.childNodes.forEach(walk);
      };
      walk(fragment);
      return text;
    }
    function around(block, range) {
      const before = document.createRange(), after = document.createRange();
      before.selectNodeContents(block);
      before.setEnd(range.startContainer, range.startOffset);
      after.selectNodeContents(block);
      after.setStart(range.endContainer, range.endOffset);
      return { before: textOf(before.cloneContents()), after: textOf(after.cloneContents()) };
    }

    function placeCaret(node, atEnd = false) {
      const range = document.createRange();
      range.selectNodeContents(node);
      range.collapse(!atEnd);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }

    function paragraph() {
      const p = document.createElement('p');
      p.append(document.createElement('br'));
      return p;
    }

    function ensureContent() {
      const last = root.lastElementChild;
      if (!last) root.replaceChildren(paragraph());
      // Something to click into after an image, divider or code block at the end.
      else if (['FIGURE', 'HR', 'PRE'].includes(last.tagName)) root.append(paragraph());
    }

    function updateHints() {
      const empty = root.childElementCount <= 1 && !root.textContent.trim() && !root.querySelector('figure, hr, li');
      root.classList.toggle('is-empty', empty);
      root.querySelectorAll('[data-hint]').forEach(node => delete node.dataset.hint);
      const range = document.activeElement === root ? caret() : null;
      const block = range && textBlock(range.startContainer);
      if (!empty && block?.tagName === 'P' && !block.textContent) block.dataset.hint = HINT;
    }

    // ---- Block commands (shared by Markdown shortcuts and the / menu) ----

    function exec(command, value = null) { document.execCommand(command, false, value); }

    // Backspace over typed characters. Selecting a whole paragraph and deleting it instead
    // lets the browser merge the emptied paragraph into the block above.
    function removeBefore(count) {
      for (let i = 0; i < count; i++) exec('delete');
    }

    function insertDivider(block) {
      const hr = document.createElement('hr');
      if (block && !block.textContent.trim() && block.parentElement === root) {
        block.before(hr);
        placeCaret(block);
      } else {
        const next = paragraph();
        (block && block.parentElement === root ? block : root.lastElementChild).after(hr, next);
        placeCaret(next);
      }
    }

    function apply(kind) {
      const range = caret();
      const block = range && textBlock(range.startContainer);
      if (kind === 'image') { pickImages(topBlock(range?.startContainer)); return; }
      if (kind === 'divider') insertDivider(topBlock(range?.startContainer));
      else if (kind === 'p' && block?.tagName === 'LI') exec('outdent');
      else if (/^h[1-3]$/.test(kind) || kind === 'p') exec('formatBlock', kind);
      else if (kind === 'quote') exec('formatBlock', 'blockquote');
      else if (kind === 'code') {
        exec('formatBlock', 'pre');
        const pre = textBlock(caret()?.startContainer);
        if (pre?.tagName === 'PRE') pre.classList.add('note-code');
      } else if (kind === 'bullet' || kind === 'task') {
        if (block?.parentElement?.tagName !== 'UL') exec('insertUnorderedList');
        const li = textBlock(caret()?.startContainer);
        if (li?.tagName === 'LI') {
          if (kind === 'task') li.dataset.checked = 'false'; else delete li.dataset.checked;
        }
      } else if (kind === 'ordered' && block?.parentElement?.tagName !== 'OL') exec('insertOrderedList');
      changed();
    }

    function tryInline(range) {
      const node = range.startContainer;
      if (node.nodeType !== Node.TEXT_NODE || element(node).closest('code, pre')) return false;
      const text = node.nodeValue.slice(0, range.startOffset);
      for (const [pattern, tag] of INLINE_SHORTCUTS) {
        const match = pattern.exec(text);
        if (!match) continue;
        const [whole, inner] = tag === 'em' ? [match[1], match[2]] : [match[0], match[1]];
        removeBefore([...whole].length);
        const holder = document.createElement('div');
        holder.append(Object.assign(document.createElement(tag), { textContent: inner }));
        // A zero-width space after the mark keeps the next typed text unformatted; it is dropped on save.
        exec('insertHTML', `${holder.innerHTML}\u200b`);
        return true;
      }
      return false;
    }

    function tryShortcut() {
      const range = caret();
      if (!range || !range.collapsed) return;
      const block = textBlock(range.startContainer);
      if (!block || tryInline(range)) return;
      const { before } = around(block, range);
      const inParagraph = (block.tagName === 'P' || block.tagName === 'DIV') && block.parentElement === root;
      for (const [pattern, kind] of SHORTCUTS) {
        const match = pattern.exec(before);
        if (!match) continue;
        const target = kind(match);
        // Inside a list item only "[ ] " applies, turning the item into a task.
        if (!inParagraph && !(block.tagName === 'LI' && target === 'task')) return;
        removeBefore([...before].length);
        if (block.tagName === 'LI') { block.dataset.checked = 'false'; changed(); } else apply(target);
        return;
      }
    }

    // ---- Images ----

    async function insertImages(files, anchor) {
      const images = [...files].filter(file => IMAGE_TYPES.test(file.type));
      if (!images.length) { onError('只能插入 PNG、JPEG、GIF 或 WebP 图片。'); return; }
      let after = anchor?.parentElement === root ? anchor : root.lastElementChild;
      const replaced = after?.tagName === 'P' && !after.textContent.trim() ? after : null;
      const note = generation;
      for (const file of images) {
        try {
          const saved = await upload(file);
          if (note !== generation) { onError('图片已上传，但你已切换到其他节点，所以没有插入；回到原节点重新粘贴即可。'); return; }
          const alt = /^image\.\w+$/.test(file.name) ? '' : file.name.replace(/\.[^.]+$/, '');
          const figure = Dom.figure(saved.path, alt);
          if (after?.isConnected) after.after(figure); else root.append(figure);
          after = figure;
        } catch (error) { onError(`图片未插入：${error.message}`); }
      }
      if (replaced && replaced !== after && replaced.isConnected && !replaced.textContent.trim()) replaced.remove();
      let next = after?.nextElementSibling;
      if (after && (!next || next.tagName !== 'P')) { next = paragraph(); after.after(next); }
      if (next) { root.focus({ preventScroll: true }); placeCaret(next); }
      changed();
    }

    function pickImages(anchor) {
      pickAnchor = anchor;
      picker.value = '';
      picker.click();
    }
    picker.addEventListener('change', () => { if (picker.files.length) insertImages(picker.files, pickAnchor); });

    function selectFigure(figure) {
      root.querySelectorAll('figure.is-selected').forEach(node => node.classList.remove('is-selected'));
      figure?.classList.add('is-selected');
    }

    function removeFigure(figure) {
      const next = figure.nextElementSibling || figure.previousElementSibling;
      const atEnd = next === figure.previousElementSibling;
      // Deleting through the browser keeps the removal on the ⌘Z undo stack.
      const range = document.createRange();
      range.selectNode(figure);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      exec('delete');
      if (figure.isConnected) figure.remove();
      if (next?.isConnected) placeCaret(next, atEnd);
      changed();
    }

    // ---- Keys ----

    // Line breaks may be <br> or, under pre-wrap, newline characters in text.
    // Each pass removes or trims the deepest last node, so the loop always ends.
    function trimTrailingBreaks(block) {
      for (;;) {
        let node = block;
        while (node.lastChild) node = node.lastChild;
        if (node === block) return;
        if (node.nodeType === Node.TEXT_NODE) {
          const trimmed = node.nodeValue.replace(/\n+$/, '');
          if (trimmed === node.nodeValue && trimmed) return;
          if (trimmed) { node.nodeValue = trimmed; return; }
          node.remove();
        } else if (node.tagName === 'BR' || (!node.textContent && node.tagName !== 'IMG')) node.remove();
        else return;
      }
    }

    function exitBlock(block) {
      // Drop the empty last line, then continue in a new paragraph below.
      trimTrailingBreaks(block);
      const next = paragraph();
      block.after(next);
      placeCaret(next);
      if (!block.textContent && block.tagName !== 'PRE') block.remove();
      changed();
    }

    function onEnter(event, range) {
      const block = textBlock(range.startContainer);
      if (!block || event.shiftKey || !['PRE', 'BLOCKQUOTE'].includes(block.tagName)) return;
      event.preventDefault();
      const { before, after } = around(block, range);
      if (range.collapsed && !after.replace(/\n$/, '') && (before === '' || before.endsWith('\n'))) {
        if (before === '') { exec('formatBlock', 'p'); changed(); } else exitBlock(block);
        return;
      }
      exec(block.tagName === 'PRE' ? 'insertText' : 'insertLineBreak', block.tagName === 'PRE' ? '\n' : null);
    }

    function onBackspace(event, range) {
      const selected = root.querySelector('figure.is-selected');
      if (selected) { event.preventDefault(); removeFigure(selected); return; }
      if (!range.collapsed) return;
      const block = textBlock(range.startContainer);
      if (!block || around(block, range).before !== '') return;
      if (/^(H[1-6]|BLOCKQUOTE|PRE)$/.test(block.tagName)) { event.preventDefault(); exec('formatBlock', 'p'); changed(); return; }
      if (block.tagName === 'LI') {
        event.preventDefault();
        if (block.dataset.checked !== undefined) delete block.dataset.checked; else exec('outdent');
        changed();
        return;
      }
      const previous = block.parentElement === root ? block.previousElementSibling : null;
      if (previous?.tagName === 'HR') { event.preventDefault(); previous.remove(); changed(); }
      else if (previous?.tagName === 'FIGURE') {
        event.preventDefault();
        if (!block.textContent) block.remove();
        selectFigure(previous);
      }
    }

    function toggleTask(li) {
      li.dataset.checked = String(li.dataset.checked !== 'true');
      changed();
    }

    root.addEventListener('keydown', event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (menus?.handleKey(event)) return;
      const range = caret();
      if (!range) return;
      const mod = event.metaKey || event.ctrlKey, key = event.key.toLowerCase();
      if (mod && key === 'e') { event.preventDefault(); menus?.toggleCode(); return; }
      if (mod && key === 'k') { event.preventDefault(); menus?.openLink(); return; }
      if (mod && event.shiftKey && key === 'x') { event.preventDefault(); exec('strikeThrough'); changed(); return; }
      if (mod && key === 'enter') {
        const li = textBlock(range.startContainer);
        if (li?.dataset.checked !== undefined) { event.preventDefault(); toggleTask(li); }
        return;
      }
      if (event.key === 'Enter') onEnter(event, range);
      else if (event.key === 'Backspace') onBackspace(event, range);
      else if (event.key === 'Delete') {
        const selected = root.querySelector('figure.is-selected');
        if (selected) { event.preventDefault(); removeFigure(selected); }
      } else if (event.key === 'Tab') {
        event.preventDefault();
        const block = textBlock(range.startContainer);
        if (block?.tagName === 'LI') { exec(event.shiftKey ? 'outdent' : 'indent'); changed(); }
        else if (block?.tagName === 'PRE' && !event.shiftKey) exec('insertText', '  ');
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onEscape?.();
      } else if (!['Shift', 'Meta', 'Control', 'Alt'].includes(event.key)) selectFigure(null);
    });

    root.addEventListener('input', event => {
      if (event.isComposing || composing) { onChange(); return; }
      if (event.inputType === 'insertText') tryShortcut();
      if (event.inputType === 'insertParagraph') {
        // A new item under a task is an unchecked task.
        const li = textBlock(caret()?.startContainer);
        const previous = li?.previousElementSibling;
        if (li?.tagName === 'LI' && (li.dataset.checked !== undefined || previous?.dataset.checked !== undefined)) li.dataset.checked = 'false';
      }
      menus?.onInput(event.data);
      changed();
    });
    root.addEventListener('compositionstart', () => { composing = true; });
    root.addEventListener('compositionend', event => {
      composing = false;
      tryShortcut();
      menus?.onInput(event.data);
      changed();
    });

    root.addEventListener('mousedown', event => {
      const li = event.target.closest?.('li[data-checked]');
      if (li && root.contains(li) && event.clientX < li.getBoundingClientRect().left) {
        event.preventDefault();
        toggleTask(li);
        return;
      }
      const figure = event.target.closest?.('figure');
      if (figure && root.contains(figure)) {
        event.preventDefault();
        if (document.activeElement !== root) root.focus({ preventScroll: true });
        if (event.target.closest('.figure-remove')) removeFigure(figure); else selectFigure(figure);
        return;
      }
      selectFigure(null);
    });
    // Full-size view inside the page; the desktop app does not open its own files in new windows.
    const viewer = document.createElement('dialog');
    viewer.className = 'image-viewer';
    viewer.setAttribute('aria-label', '查看图片');
    const viewed = document.createElement('img');
    viewer.append(viewed);
    viewer.addEventListener('click', () => viewer.close());
    document.body.append(viewer);
    root.addEventListener('dblclick', event => {
      const image = event.target.closest?.('figure img');
      if (!image) return;
      Object.assign(viewed, { src: image.src, alt: image.alt });
      viewer.showModal();
    });
    root.addEventListener('click', event => {
      const link = event.target.closest?.('a[href]');
      if (!link || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      if (window.NoteMarkdown.SAFE_LINK.test(link.getAttribute('href') || '')) window.open(link.href, '_blank', 'noopener');
    });

    // ---- Clipboard and drops ----

    const looksLikeMarkdown = text => /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|\|)/m.test(text)
      || /\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)/.test(text);

    function insertBlocks(blocks) {
      if (!blocks.length) return;
      const holder = document.createElement('div');
      if (blocks.length === 1 && blocks[0].type === 'paragraph') holder.append(Dom.inlineNodes(blocks[0].inline));
      else holder.append(Dom.render(blocks));
      exec('insertHTML', holder.innerHTML);
      // Re-apply attributes the browser may drop while inserting HTML.
      root.querySelectorAll('figure').forEach(figure => { figure.contentEditable = 'false'; });
      changed();
    }

    root.addEventListener('paste', event => {
      const data = event.clipboardData;
      const range = caret();
      if (!data || !range) return;
      const images = [...data.files].filter(file => IMAGE_TYPES.test(file.type));
      if (images.length) { event.preventDefault(); insertImages(images, topBlock(range.startContainer)); return; }
      const text = data.getData('text/plain'), html = data.getData('text/html');
      event.preventDefault();
      if (textBlock(range.startContainer)?.tagName === 'PRE') { exec('insertText', text); return; }
      if (html && !looksLikeMarkdown(text)) {
        insertBlocks(Dom.read(new DOMParser().parseFromString(html, 'text/html').body));
      } else insertBlocks(parse(text));
    });

    function copySelection(event) {
      const range = caret();
      if (!range || range.collapsed || topBlock(range.startContainer) === topBlock(range.endContainer)) return false;
      // Across blocks, copy Markdown so the structure survives in chats and other notes.
      const holder = document.createElement('div');
      holder.append(range.cloneContents());
      event.preventDefault();
      event.clipboardData.setData('text/plain', serialize(Dom.read(holder)));
      event.clipboardData.setData('text/html', holder.innerHTML);
      return true;
    }
    root.addEventListener('copy', copySelection);
    root.addEventListener('cut', event => { if (copySelection(event)) { exec('delete'); changed(); } });

    const hasFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');
    root.addEventListener('dragover', event => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      root.classList.add('is-drop-target');
    });
    root.addEventListener('dragleave', () => root.classList.remove('is-drop-target'));
    root.addEventListener('drop', event => {
      root.classList.remove('is-drop-target');
      if (!hasFiles(event)) return;
      event.preventDefault();
      const point = document.caretRangeFromPoint?.(event.clientX, event.clientY);
      insertImages(event.dataTransfer.files, topBlock(point?.startContainer) || root.lastElementChild);
    });

    document.addEventListener('selectionchange', () => {
      if (!root.isConnected) return;
      updateHints();
      menus?.onSelectionChange();
    });
    root.addEventListener('focus', () => {
      exec('defaultParagraphSeparator', 'p');
      exec('styleWithCSS', false);
    });

    const editor = {
      root, caret, textBlock, topBlock, around, apply, exec, changed, removeBefore,
      setMarkdown(markdown) {
        generation++;
        menus?.close();
        root.replaceChildren(Dom.render(parse(markdown)));
        ensureContent();
        updateHints();
      },
      markdown() { return serialize(Dom.read(root)); },
      isComposing: () => composing,
      hasFocus: () => document.activeElement === root,
      focus(atEnd = false) {
        root.focus({ preventScroll: true });
        const target = atEnd ? root.lastElementChild : root.firstElementChild;
        if (target) placeCaret(target, atEnd);
      },
    };
    menus = window.NoteMenus.create(editor);
    return editor;
  }

  window.NoteEditor = { create };
})();
