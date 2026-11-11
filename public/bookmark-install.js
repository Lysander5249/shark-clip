const link = document.getElementById('bookmark-install-link'), status = document.getElementById('bookmark-install-state');
let windowsEdge = false;
let ready = false;
link.addEventListener('click', event => {
  event.preventDefault();
  if (windowsEdge && !ready) return;
  status.textContent = windowsEdge ? '请把按钮拖进 Edge 收藏夹栏。以后在已登录的网盘页面点击保存的书签。'
    : '请把按钮拖进上方书签栏。以后在网盘页面点击保存的书签。';
});
try {
  const response = await fetch('/api/bookmark-capture/state', { cache: 'no-store', credentials: 'omit' });
  const data = await response.json();
  if (!response.ok) throw new Error('unavailable');
  const xunleiOnly = data.edition === 'windows-edge-xunlei';
  windowsEdge = xunleiOnly || data.edition === 'windows-edge-cloud';
  if (windowsEdge) {
    link.draggable = false;
    document.getElementById('bookmark-install-heading').textContent = '把抓链按钮拖进 Edge 收藏夹栏';
    const cloudNames = xunleiOnly ? '迅雷云盘' : '迅雷云盘或百度网盘';
    document.getElementById('bookmark-install-intro').textContent = `在用来登录${cloudNames}的 Edge 配置文件中添加一次。以后在网盘点「片段取材抓链」，再播放或下载影片。`;
    document.getElementById('bookmark-install-shortcuts').hidden = true;
    document.getElementById('bookmark-install-edge-shortcut').hidden = false;
  }
  if (data.available !== true || typeof data.bookmarklet !== 'string' || !data.bookmarklet.startsWith('javascript:')) throw new Error('unavailable');
  ready = true;
  link.href = data.bookmarklet;
  link.draggable = true;
  link.setAttribute('aria-disabled', 'false');
  status.textContent = '书签已准备。拖入后名称为“片段取材抓链”，重启工具后仍可使用。';
  // The browser supplies the anchor URL and visible name when it is dragged.
} catch {
  status.textContent = windowsEdge ? '本机抓链入口暂不可用，请保持片段取材运行并刷新本页。'
    : '书签入口暂不可用，请回到片段取材查看状态。已有旧路径仍可使用。';
}
