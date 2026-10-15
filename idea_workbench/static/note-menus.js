(() => {
  'use strict';

  // The "/" block menu and the formatting toolbar shown over selected text.
  // "、" also opens the menu at the start of a line, since Chinese input types it for "/".
  const BLOCKS = [
    ['p', '正文', '普通文字', 'text zw zhengwen wenben 正文 文本'],
    ['h1', '标题 1', '# 开头', 'h1 heading title bt biaoti 标题 大标题'],
    ['h2', '标题 2', '## 开头', 'h2 heading title bt biaoti 标题'],
    ['h3', '标题 3', '### 开头', 'h3 heading title bt biaoti 标题 小标题'],
    ['bullet', '无序列表', '- 开头', 'ul bullet list lb liebiao wuxu 列表 无序'],
    ['ordered', '有序列表', '1. 开头', 'ol ordered number list yx youxu bianhao 列表 有序 编号'],
    ['task', '待办', '[ ] 开头 · ⌘↵ 勾选', 'todo task check db daiban renwu 待办 任务 勾选'],
    ['quote', '引用', '> 开头', 'quote yy yinyong 引用'],
    ['code', '代码块', '``` 开头', 'code dm daima 代码'],
    ['divider', '分割线', '--- 开头', 'hr divider line fgx fengexian 分割线 分隔'],
    ['image', '图片', '也可以直接粘贴或拖入', 'image img picture photo screenshot tp tupian jietu 图片 照片 截图'],
  ];
  const FORMATS = [
    ['bold', 'B', '加粗 ⌘B'], ['italic', 'I', '斜体 ⌘I'], ['strikeThrough', 'S', '删除线 ⌘⇧X'],
    ['code', '</>', '行内代码 ⌘E'], ['link', '链接', '链接 ⌘K'],
  ];

  function el(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function place(box, rect) {
    const width = box.offsetWidth, height = box.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left));
    const below = rect.bottom + 6 + height <= window.innerHeight - 8;
    box.style.left = `${left}px`;
    box.style.top = `${below ? rect.bottom + 6 : Math.max(8, rect.top - height - 6)}px`;
  }

  function caretRect(range, fallback) {
    const rect = range.getClientRects()[0] || range.getBoundingClientRect();
    return rect && (rect.width || rect.height) ? rect : fallback.getBoundingClientRect();
  }

  function create(editor) {
    const { root } = editor;
    const menu = el('div', 'note-menu');
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', '插入块');
    menu.hidden = true;
    const bar = el('div', 'note-toolbar');
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', '文字格式');
    bar.hidden = true;
    document.body.append(menu, bar);
    let slash = null, active = 0, shown = [], linkRange = null;

    // ---- "/" menu ----

    function query() {
      const range = editor.caret();
      if (!slash || !range || !slash.node.isConnected || range.startContainer !== slash.node || range.startOffset <= slash.offset) return null;
      return slash.node.nodeValue.slice(slash.offset + 1, range.startOffset);
    }

    function close() {
      slash = null;
      menu.hidden = true;
    }

    function renderMenu() {
      const options = shown.map(([, label, hint], index) => {
        const option = el('button', 'note-menu-item');
        option.type = 'button';
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(index === active));
        option.append(el('span', 'note-menu-label', label), el('span', 'note-menu-hint', hint));
        option.addEventListener('mousedown', event => event.preventDefault());
        option.addEventListener('click', () => choose(index));
        return option;
      });
      menu.replaceChildren(...(options.length ? options : [el('p', 'note-menu-empty', '没有匹配的块')]));
      menu.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    }

    function refresh() {
      const text = query();
      if (text === null || /\s/.test(text) || text.length > 12) { close(); return; }
      const needle = text.toLowerCase();
      shown = BLOCKS.filter(([, label, , keys]) => !needle || label.toLowerCase().includes(needle)
        || keys.split(' ').some(key => key.startsWith(needle)));
      active = Math.max(0, Math.min(active, shown.length - 1));
      menu.hidden = false;
      renderMenu();
      place(menu, caretRect(editor.caret(), root));
    }

    function onInput(data) {
      if (slash) { refresh(); return; }
      if (data !== '/' && data !== '、') return;
      const range = editor.caret();
      if (!range?.collapsed || range.startContainer.nodeType !== Node.TEXT_NODE) return;
      const block = editor.textBlock(range.startContainer);
      if (!block || block.tagName === 'PRE') return;
      const head = editor.around(block, range).before.slice(0, -1);
      if (data === '/' ? !(head === '' || /\s$/.test(head)) : head !== '') return;
      slash = { node: range.startContainer, offset: range.startOffset - 1 };
      active = 0;
      refresh();
    }

    function choose(index) {
      const item = shown[index], range = editor.caret();
      if (!item || !range || !slash) { close(); return; }
      // Backspace over the typed "/query", then turn the line into the chosen block.
      const typed = slash.node.nodeValue.slice(slash.offset, range.startOffset);
      editor.removeBefore([...typed].length);
      close();
      editor.apply(item[0]);
    }

    function handleKey(event) {
      if (menu.hidden) return false;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        active = (active + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % Math.max(1, shown.length);
        renderMenu();
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        if (!shown.length) return false;
        choose(active);
      } else if (event.key === 'Escape') close();
      else return false;
      event.preventDefault();
      event.stopPropagation();
      return true;
    }

    // ---- Selection toolbar ----

    const linkForm = el('form', 'note-link-form');
    const linkInput = el('input');
    // Plain text so "example.com" is accepted; https:// is added when missing.
    Object.assign(linkInput, { type: 'text', inputMode: 'url', placeholder: '粘贴链接，留空则移除', autocomplete: 'off', spellcheck: false });
    linkInput.setAttribute('aria-label', '链接地址');
    const linkSave = el('button', '', '确定');
    linkSave.type = 'submit';
    linkForm.append(linkInput, linkSave);
    linkForm.hidden = true;
    const buttons = el('div', 'note-toolbar-buttons');
    for (const [command, label, title] of FORMATS) {
      const button = el('button', '', label);
      Object.assign(button, { type: 'button', title });
      button.dataset.command = command;
      button.setAttribute('aria-label', title);
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', () => {
        if (command === 'link') openLink();
        else if (command === 'code') toggleCode();
        else { editor.exec(command); editor.changed(); }
      });
      buttons.append(button);
    }
    bar.append(buttons, linkForm);

    function hideBar() {
      bar.hidden = true;
      linkForm.hidden = true;
      buttons.hidden = false;
      linkRange = null;
    }

    function onSelectionChange() {
      if (slash) refresh();
      if (linkRange) return;
      const range = editor.caret();
      if (!range || range.collapsed || !editor.hasFocus() || editor.textBlock(range.startContainer)?.tagName === 'PRE') { hideBar(); return; }
      bar.hidden = false;
      const rect = range.getBoundingClientRect();
      place(bar, { left: rect.left + rect.width / 2 - bar.offsetWidth / 2, top: rect.top - 2, bottom: rect.top - bar.offsetHeight - 14 });
      if (parseFloat(bar.style.top) < 8) place(bar, { left: rect.left + rect.width / 2 - bar.offsetWidth / 2, top: rect.bottom, bottom: rect.bottom });
    }

    function toggleCode() {
      const range = editor.caret();
      if (!range || range.collapsed) return;
      const start = range.commonAncestorContainer;
      const code = (start.nodeType === Node.ELEMENT_NODE ? start : start.parentElement)?.closest('code');
      if (code && root.contains(code)) code.replaceWith(...code.childNodes);
      else {
        const holder = el('div');
        holder.textContent = range.toString();
        editor.exec('insertHTML', `<code>${holder.innerHTML}</code>`);
      }
      editor.changed();
    }

    function openLink() {
      const range = editor.caret();
      if (!range || range.collapsed) return;
      linkRange = range.cloneRange();
      const start = range.startContainer;
      const link = (start.nodeType === Node.ELEMENT_NODE ? start : start.parentElement)?.closest('a');
      linkInput.value = link && root.contains(link) ? link.getAttribute('href') : '';
      bar.hidden = false;
      buttons.hidden = true;
      linkForm.hidden = false;
      linkInput.focus();
    }

    function finishLink(save) {
      const range = linkRange;
      hideBar();
      if (!range) return;
      root.focus({ preventScroll: true });
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      if (!save) return;
      const value = linkInput.value.trim();
      if (!value) editor.exec('unlink');
      else editor.exec('createLink', window.NoteMarkdown.SAFE_LINK.test(value) ? value : `https://${value}`);
      editor.changed();
    }

    linkForm.addEventListener('submit', event => { event.preventDefault(); finishLink(true); });
    linkInput.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finishLink(false); }
    });
    linkInput.addEventListener('blur', () => setTimeout(() => { if (linkRange && !bar.contains(document.activeElement)) hideBar(); }, 0));
    root.addEventListener('blur', () => setTimeout(() => {
      if (bar.contains(document.activeElement)) return;
      close();
      hideBar();
    }, 0));
    // Menus are fixed to the window, so they leave when the page under them scrolls.
    document.addEventListener('scroll', event => {
      if (event.target.contains?.(root)) { close(); if (!linkRange) hideBar(); }
    }, true);

    return { onInput, handleKey, onSelectionChange, toggleCode, openLink, close };
  }

  window.NoteMenus = { create };
})();
