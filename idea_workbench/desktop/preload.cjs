const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('workbenchDesktop', {
  open: () => ipcRenderer.invoke('desktop:open'),
  create: () => ipcRenderer.invoke('desktop:create'),
  recent: () => ipcRenderer.invoke('desktop:recent'),
  openRecent: index => ipcRenderer.invoke('desktop:open-recent', index),
});
window.addEventListener('DOMContentLoaded', () => {
  const actions = document.querySelector('.header-actions');
  if (!actions) return;
  const open = document.createElement('button');
  open.type = 'button';
  open.textContent = '打开项目';
  open.title = '打开研究项目（⌘O）';
  open.addEventListener('click', () => ipcRenderer.invoke('desktop:open'));
  actions.prepend(open);
  document.querySelector('#layout-status').textContent = '布局保存在此 App';
  const exportLink = document.querySelector('a[download]');
  exportLink.addEventListener('click', event => {
    event.preventDefault();
    ipcRenderer.invoke('desktop:export');
  });
});
