import { createBrowserHelperController } from './controller.mjs';
const helper = createBrowserHelperController({ chromeApi: chrome });
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  helper.handle(message, sender).then(respond, () => respond({ ok: false, code: 'CAPTURE_UNAVAILABLE', message: '助手暂时无法完成操作，请重试。' }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => { void helper.removed(tabId); });
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') void helper.removed(tabId);
});
