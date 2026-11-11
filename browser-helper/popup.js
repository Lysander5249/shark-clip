const $ = id => document.getElementById(id);
let tabId, busy = false, state, feedback = '', selectedFile = '', fileSignature = '';
async function request(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.message || '助手暂时未响应，请重试。');
  return result;
}
async function refresh() {
  try {
    state = await request({ type: 'helper:state', tabId });
    $('pair-state').textContent = state.paired ? `已连接本机工具（${state.toolOrigin}）` : '尚未连接';
    $('page-state').textContent = state.provider === 'xunlei' ? '当前网页：迅雷云盘' : state.provider === 'baidu' ? '当前网页：百度网盘' : '请切换到百度网盘或迅雷云盘网页';
    $('start').disabled = busy || !state.paired || !state.supported || state.capture?.active;
    $('stop').disabled = !state.capture?.active;
    $('pair').disabled = busy;
    $('status').textContent = feedback || state.capture?.message || (state.paired ? '在网盘网页保持登录，然后点击“开始识别当前网页”。' : '请先从原工具复制本次配对地址。');
    $('xunlei-section').hidden = state.provider !== 'xunlei';
    const files = state.capture?.files || [], signature = JSON.stringify(files);
    if (signature !== fileSignature) {
      $('file').replaceChildren(new Option(files.length ? '选择需要取材的影片' : '当前尚未读到影片，请打开目录后刷新', ''));
      for (const file of files) $('file').append(new Option(file.name, file.id));
      if (files.some(file => file.id === selectedFile)) $('file').value = selectedFile; else selectedFile = '';
      fileSignature = signature;
    }
    const reading = state.capture?.detail?.status === 'running';
    $('file').disabled = busy || reading || !state.capture?.active;
    $('refresh-files').disabled = busy || !state.capture?.active;
    $('read-file').disabled = busy || reading || !state.capture?.active || !state.capture?.adapterAvailable || !selectedFile;
    $('read-file').textContent = reading ? '正在读取所选入口…' : '读取所选文件入口';
    $('detail-state').textContent = state.capture?.detail?.message || (state.capture?.active && !state.capture.adapterAvailable
      ? '尚未找到可用的官方文件状态，请先在迅雷网页打开影片目录，再刷新列表。' : '仅请求本次所选文件的官方详情；失败时保留旧下载路径。');
  } catch (error) { $('status').textContent = error.message; }
}
async function act(callback) {
  if (busy) return; busy = true; feedback = ''; $('pair').disabled = true; $('start').disabled = true;
  try { await callback(); }
  catch (error) { feedback = error.message; }
  finally { busy = false; await refresh(); }
}
$('pair').addEventListener('click', () => act(async () => {
  await request({ type: 'helper:pair', pairingUrl: $('pair-url').value });
  $('pair-url').value = ''; $('pair-section').open = false;
}));
$('reset').addEventListener('click', async () => {
  feedback = '';
  try { await request({ type: 'helper:reset' }); $('pair-url').value = ''; $('pair-section').open = true; }
  catch (error) { feedback = error.message; }
  await refresh();
});
$('start').addEventListener('click', () => act(() => request({ type: 'helper:start', tabId })));
$('file').addEventListener('change', () => { selectedFile = $('file').value; void refresh(); });
$('refresh-files').addEventListener('click', () => act(() => request({ type: 'helper:files', tabId })));
$('read-file').addEventListener('click', () => act(() => request({ type: 'helper:detail', tabId, fileId: selectedFile })));
$('stop').addEventListener('click', async () => {
  feedback = '';
  $('stop').disabled = true;
  try { await request({ type: 'helper:stop', tabId }); } catch (error) { feedback = error.message; }
  await refresh();
});
(async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true }); tabId = tabs[0]?.id;
  await refresh(); if (state?.paired) $('pair-section').open = false;
})().catch(() => { $('status').textContent = '无法读取当前网页，请关闭助手后重试。'; });
setInterval(refresh, 1000);
