/* Only our exact loopback pairing document may request this handshake. No
 * automatic pairing: a trusted user click is required for each connection. */
(() => {
  try { globalThis.ClipFetcherCaptureCore.parsePairingUrl(location.href); } catch { return; }
  if (window.top !== window || document.body?.getAttribute('data-clip-fetcher-pair-page') !== '1'
      || document.getElementById('clip-fetcher-browser-pair')) return;
  const section = document.createElement('section'); section.id = 'clip-fetcher-browser-pair';
  Object.assign(section.style, { padding: '20px', margin: '20px auto', maxWidth: '640px', background: '#f4f5ef',
    border: '1px solid #c9d5c9', borderRadius: '12px', color: '#203b33', font: '14px/1.7 system-ui,sans-serif' });
  const title = document.createElement('strong'); title.textContent = '片段取材 · 浏览器助手已就绪';
  const note = document.createElement('p');
  note.textContent = '点击即可连接当前工具。连接另一工具会停止旧连接的网页识别，已经创建的下载任务不受影响。';
  const button = document.createElement('button'); button.textContent = '连接当前工具';
  Object.assign(button.style, { padding: '10px 18px', border: '0', borderRadius: '8px', background: '#28634d', color: '#fff', font: 'inherit', cursor: 'pointer' });
  const status = document.createElement('p'); status.setAttribute('role','status'); status.textContent = '连接后，切换到已登录的迅雷或百度网页，点击工具栏的片段取材助手。';
  button.addEventListener('click', async event => {
    if (!event.isTrusted || button.disabled) return;
    button.disabled = true; status.textContent = '正在连接本机工具…';
    try {
      const result = await chrome.runtime.sendMessage({ type: 'helper:pair-page', pairingUrl: location.href });
      if (!result?.ok) throw new Error(result?.message || '连接未完成，请从原工具重新打开本页。');
      status.textContent = '已连接。请切换到网盘页面，点击浏览器工具栏的片段取材助手开始识别。';
      button.textContent = '已连接当前工具';
    } catch (error) { status.textContent = error.message; button.disabled = false; }
  });
  section.append(title, note, button, status);
  const target = document.getElementById('browser-pair-action');
  if (target) target.replaceChildren(section); else document.body.prepend(section);
})();
