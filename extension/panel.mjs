import { classifyURL, validatePlan } from './adapter.mjs';
import { CaptureRunner } from './runner.mjs';
import { ChromeTransport } from './chrome-transport.mjs';

const elements = Object.fromEntries(['plan', 'plan-status', 'plan-summary', 'consent', 'start', 'stop', 'state', 'progress', 'jobs', 'warnings', 'export'].map(id => [id, document.getElementById(id)]));
let targetTabId = null, plan = null, runner = null, result = null;
let claimed = false, used = false, running = false, importVersion = 0;
const refresh = () => { elements.start.disabled = !claimed || !plan || !elements.consent.checked || used; };
const listItem = (parent, value) => { const item = document.createElement('li'); item.textContent = value; parent.append(item); };
const stageText = { waiting: '等待低频间隔', opening_search: '正在打开搜索页', opening_detail: '正在打开岗位详情', job_read: '已读取岗位正文' };

async function claim() {
  try {
    const panelTab = await chrome.tabs.getCurrent();
    const response = await chrome.runtime.sendMessage({ type: 'claim-control', token: location.hash.slice(1), panelTabId: panelTab?.id });
    if (!response?.ok) throw new Error(response?.error || '控制窗口无效。');
    targetTabId = response.targetTabId;
    const tab = await chrome.tabs.get(targetTabId);
    if (!tab.url || tab.pendingUrl || tab.status === 'loading') throw new Error('原目标标签页未就绪。');
    classifyURL(tab.url);
    claimed = true;
    elements.state.textContent = `已绑定原目标标签页 ${targetTabId}，导入计划并确认后才能开始。`;
  } catch (error) { elements.state.textContent = `未启动：${error.message}`; }
  refresh();
}

elements.plan.addEventListener('change', async () => {
  const version = ++importVersion;
  plan = null;
  elements['plan-summary'].replaceChildren();
  elements['plan-status'].textContent = '正在检查计划……';
  refresh();
  try {
    const file = elements.plan.files?.[0];
    if (!file || file.size > 32768) throw new Error('请选择不大于 32 KiB 的 JSON 文件。');
    const imported = validatePlan(JSON.parse(await file.text()));
    if (version !== importVersion || used) return;
    plan = imported;
    const searches = document.createElement('ul');
    for (const search of plan.searches) listItem(searches, `${search.keyword} · ${search.city_label}（${search.city_code}）`);
    elements['plan-summary'].append(searches);
    const { max_jobs, max_pages, max_seconds, min_action_seconds } = plan.limits;
    elements['plan-status'].textContent = `全局上限：${max_jobs} 岗 / ${max_pages} 搜索页 / ${max_seconds} 秒；每次导航前等 ${min_action_seconds} 秒。`;
  } catch (error) {
    if (version === importVersion) elements['plan-status'].textContent = `计划无效：${error.message}`;
  }
  refresh();
});
elements.consent.addEventListener('change', refresh);
elements.stop.addEventListener('click', () => {
  runner?.stop();
  elements.stop.disabled = true;
  elements.state.textContent = '已请求停止，后续导航已取消。';
});
window.addEventListener('pagehide', () => runner?.stop(), { once: true });

elements.start.addEventListener('click', async () => {
  if (!claimed || !plan || !elements.consent.checked || used) return;
  used = true;
  running = true;
  elements.plan.disabled = true;
  elements.consent.disabled = true;
  elements.stop.disabled = false;
  refresh();
  try {
    runner = new CaptureRunner({
      plan, targetTabId, transport: new ChromeTransport(),
      onProgress: progress => {
        elements.state.textContent = stageText[progress.stage] || progress.stage;
        elements.progress.textContent = `已读 ${progress.jobs} 岗；已预留 ${progress.pages} 搜索页、${progress.details} 详情；已用 ${progress.elapsed_seconds} 秒。`;
      },
    });
    result = await runner.run();
    const states = { completed: '本次有界采集完成', stopped: '已停止，结果为部分或空材料', failed: '采集失败，结果为部分或空材料' };
    elements.state.textContent = `${states[result.status]}：${result.stop_reason}。已读 ${result.jobs.length} 岗。${result.jobs.length ? '' : '没有可用正文，不能视为采集成功。'}`;
    elements.progress.textContent = `本次任务已结束，不会自动重启。`;
    for (const job of result.jobs) listItem(elements.jobs, `${job.title || '岗位名称未知'} · ${job.company || '公司未知'} · ${job.location || '地点未知'}`);
    for (const warning of result.warnings) listItem(elements.warnings, warning);
    elements.export.disabled = false;
  } catch (error) { elements.state.textContent = `未生成有效结果：${error.message}`; }
  finally { running = false; elements.stop.disabled = true; }
});

elements.export.addEventListener('click', () => {
  if (running || !result) return;
  // Native user-clicked Blob download; no downloads permission or external upload.
  const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `job-evidence-${result.capture_id}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  // Kept until panel close to avoid revocation racing the browser's download handling.
  window.addEventListener('pagehide', () => URL.revokeObjectURL(url), { once: true });
});
await claim();
