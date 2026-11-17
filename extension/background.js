import { classifyURL } from './adapter.mjs';

// Routing metadata only in session storage. Never store plans, URLs, jobs or credentials.
// activeTab remains scoped to the original tab/origin:
// https://developer.chrome.com/docs/extensions/develop/concepts/activeTab
const CONTROL_KEY = 'jobEvidenceControl';
let opening = null;
const getControl = async () => (await chrome.storage.session.get(CONTROL_KEY))[CONTROL_KEY];
const clearControl = () => chrome.storage.session.remove(CONTROL_KEY);
const notify = async text => {
  await chrome.action.setBadgeText({ text: text ? '!' : '' });
  await chrome.action.setTitle({ title: text || '为当前BOSS标签页打开有界采集控制窗口' });
};

async function openControl(tab) {
  const existing = await getControl();
  if (existing?.panelWindowId != null) {
    try { await chrome.windows.update(existing.panelWindowId, { focused: true }); return; }
    catch { await clearControl(); } // A closed panel never resumes its task.
  }
  if (!tab || !Number.isInteger(tab.id) || !tab.url || tab.pendingUrl || tab.status === 'loading') throw new Error('目标标签页未就绪；请完成正常页面加载。');
  try { classifyURL(tab.url); } catch { throw new Error('仅支持当前 https://www.zhipin.com 正常搜索或岗位详情页；聊天、简历、登录及验证路径不可运行。'); }
  const token = crypto.randomUUID();
  const control = { token, targetTabId: tab.id, panelWindowId: null, panelTabId: null, claimed: false };
  await chrome.storage.session.set({ [CONTROL_KEY]: control });
  let panel;
  try {
    panel = await chrome.windows.create({
      url: `${chrome.runtime.getURL('panel.html')}#${token}`,
      type: 'popup', width: 560, height: 780, focused: true,
    });
    const panelTab = panel.tabs?.find(candidate => candidate.id != null);
    if (!panelTab || !Number.isInteger(panel.id)) throw new Error('无法确定扩展控制窗口。');
    control.panelWindowId = panel.id;
    control.panelTabId = panelTab.id;
    await chrome.storage.session.set({ [CONTROL_KEY]: control });
    await notify('');
  } catch (error) {
    await clearControl();
    if (Number.isInteger(panel?.id)) await chrome.windows.remove(panel.id);
    throw error;
  }
}

chrome.action.onClicked.addListener(tab => {
  if (opening) return;
  opening = openControl(tab).catch(error => notify(error.message)).finally(() => { opening = null; });
});
chrome.windows.onRemoved.addListener(async id => {
  const control = await getControl();
  if (control?.panelWindowId === id) await clearControl();
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'claim-control') return false;
  (async () => {
    if (opening) await opening;
    const control = await getControl();
    const expectedPanel = chrome.runtime.getURL('panel.html');
    const panelTab = control && Number.isInteger(message.panelTabId) ? await chrome.tabs.get(message.panelTabId) : null;
    if (!control || control.claimed || message.token !== control.token ||
        message.panelTabId !== control.panelTabId || panelTab?.windowId !== control.panelWindowId ||
        panelTab?.url?.split('#')[0] !== expectedPanel || sender.id !== chrome.runtime.id ||
        (sender.tab && sender.tab.id !== control.panelTabId) || sender.url?.split('#')[0] !== expectedPanel) {
      return { ok: false, error: '控制窗口无效或已使用；刷新不会恢复任务。请关闭后重新由原目标标签页点击扩展。' };
    }
    control.claimed = true;
    await chrome.storage.session.set({ [CONTROL_KEY]: control });
    return { ok: true, targetTabId: control.targetTabId };
  })().then(sendResponse, () => sendResponse({ ok: false, error: '无法取得原目标标签页；任务未启动。' }));
  return true;
});
