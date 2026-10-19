(() => {
  'use strict';

  // Tables inside a note. Cells are edited in place; Tab and Enter move between cells like a
  // spreadsheet, and a small toolbar over the table adds or removes rows and columns.
  const ACTIONS = [['row', '＋ 行'], ['column', '＋ 列'], ['delete-row', '删行'], ['delete-column', '删列'], ['delete-table', '删除表格']];

  function create(editor) {
    const { root } = editor;
    const bar = document.createElement('div');
    bar.className = 'note-table-bar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', '表格');
    bar.hidden = true;
    for (const [action, label] of ACTIONS) {
      const button = Object.assign(document.createElement('button'), { type: 'button', textContent: label });
      button.dataset.action = action;
      if (action.startsWith('delete')) button.classList.add('danger');
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', () => run(action));
      bar.append(button);
    }
    document.body.append(bar);
    let cell = null;

    function cellAt(node) {
      const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
      const found = element?.closest('td, th');
      return found && root.contains(found) ? found : null;
    }

    const rowsOf = table => [...table.querySelectorAll('tr')].filter(row => row.closest('table') === table);

    function emptyCell(tag, align) {
      const created = document.createElement(tag);
      created.append(document.createElement('br'));
      if (align) { created.dataset.align = align; created.style.textAlign = align; }
      return created;
    }

    function addRow(table, after) {
      const header = rowsOf(table)[0];
      const row = document.createElement('tr');
      for (const head of header.children) row.append(emptyCell('td', head.dataset.align));
      if (after && after.parentElement.tagName === 'TBODY') after.after(row);
      else (table.tBodies[0] || table.appendChild(document.createElement('tbody'))).prepend(row);
      return row;
    }

    function hide() { bar.hidden = true; cell = null; }

    function run(action) {
      if (!cell?.isConnected) { hide(); return; }
      const table = cell.closest('table'), row = cell.parentElement, column = [...row.children].indexOf(cell);
      if (action === 'row') editor.placeCaret(addRow(table, row).children[Math.max(0, column)]);
      else if (action === 'column') {
        for (const line of rowsOf(table)) {
          const next = emptyCell(line.parentElement.tagName === 'THEAD' ? 'th' : 'td');
          line.children[column] ? line.children[column].after(next) : line.append(next);
        }
        editor.placeCaret(row.children[column + 1]);
      } else if (action === 'delete-row' && row.parentElement.tagName === 'TBODY') {
        const neighbour = row.nextElementSibling || row.previousElementSibling || rowsOf(table)[0];
        row.remove();
        editor.placeCaret(neighbour.children[Math.min(column, neighbour.children.length - 1)]);
      } else if (action === 'delete-column' && row.children.length > 1) {
        for (const line of rowsOf(table)) line.children[column]?.remove();
        editor.placeCaret(row.children[Math.min(column, row.children.length - 1)]);
      } else if (action === 'delete-table' || action === 'delete-column') {
        const next = table.nextElementSibling || table.previousElementSibling;
        table.remove();
        if (next) editor.placeCaret(next);
        hide();
      }
      editor.changed();
      onSelectionChange();
    }

    // Tab and Enter move between cells; returns true when it handled the key.
    function handleKey(event, range) {
      const current = cellAt(range.startContainer);
      if (!current || (event.key !== 'Tab' && !(event.key === 'Enter' && !event.shiftKey))) return false;
      event.preventDefault();
      const table = current.closest('table'), rows = rowsOf(table), row = current.parentElement;
      const column = [...row.children].indexOf(current), index = rows.indexOf(row);
      if (event.key === 'Enter') {
        const below = rows[index + 1] || addRow(table, row);
        editor.placeCaret(below.children[column] || below.lastElementChild, true);
      } else {
        const cells = rows.flatMap(line => [...line.children]), position = cells.indexOf(current);
        const target = event.shiftKey ? cells[position - 1] : cells[position + 1] || addRow(table, row).firstElementChild;
        if (target) editor.placeCaret(target, true);
      }
      editor.changed();
      return true;
    }

    function onSelectionChange() {
      const range = editor.caret();
      cell = range && editor.hasFocus() ? cellAt(range.startContainer) : null;
      if (!cell) { bar.hidden = true; return; }
      bar.hidden = false;
      const box = cell.closest('table').getBoundingClientRect();
      const top = box.top - bar.offsetHeight - 6;
      bar.style.left = `${Math.max(8, Math.min(window.innerWidth - bar.offsetWidth - 8, box.right - bar.offsetWidth))}px`;
      bar.style.top = `${top < 8 ? box.bottom + 6 : top}px`;
    }

    // A new 3-column table with a header and two rows, replacing an empty line.
    function insert(anchor) {
      const blank = [[], [], []];
      const table = window.NoteDom.render([{ type: 'table', align: ['', '', ''], rows: [blank, blank, blank] }]).firstChild;
      const block = anchor?.parentElement === root ? anchor : root.lastElementChild;
      if (block?.tagName === 'P' && !block.textContent.trim()) block.replaceWith(table);
      else if (block) block.after(table); else root.append(table);
      editor.changed();
      editor.placeCaret(table.querySelector('th'));
    }

    root.addEventListener('blur', () => setTimeout(() => { if (!bar.contains(document.activeElement)) hide(); }, 0));
    document.addEventListener('scroll', event => { if (event.target.contains?.(root)) hide(); }, true);
    return { handleKey, onSelectionChange, insert, hide };
  }

  window.NoteTable = { create };
})();
