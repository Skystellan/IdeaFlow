const desktop = window.workbenchDesktop;
async function run(action) {
  document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  document.getElementById('status').textContent = '正在打开项目…';
  try { await action(); document.getElementById('status').textContent = ''; }
  catch { document.getElementById('status').textContent = '项目未能打开，请重试。'; }
  finally { document.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
}
document.getElementById('open').addEventListener('click', () => run(desktop.open));
document.getElementById('create').addEventListener('click', () => run(desktop.create));
desktop.recent().then(items => {
  if (!items.length) return;
  const container = document.getElementById('recent');
  container.replaceChildren();
  items.forEach((item, index) => {
    const button = document.createElement('button');
    button.className = 'recent';
    button.textContent = item.name;
    const detail = document.createElement('small');
    detail.textContent = item.path;
    button.append(detail);
    button.addEventListener('click', () => run(() => desktop.openRecent(index)));
    container.append(button);
  });
});
