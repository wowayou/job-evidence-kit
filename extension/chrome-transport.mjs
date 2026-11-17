import { CaptureError, DOM_POLICY, classifyURL, extractPageDOM, samePage } from './adapter.mjs';

/** Main-frame DOM + tabs.update only. No content script, host permission or site requests.
 * Chrome primary API references (reviewed 2026-11-17):
 * https://developer.chrome.com/docs/extensions/reference/api/scripting
 * https://developer.chrome.com/docs/extensions/reference/api/tabs
 */
export class ChromeTransport {
  constructor(api = chrome) {
    this.api = api;
    this.expectedURL = '';
    this.targetTabId = null;
    this.cleanups = [];
  }
  async attach({ targetTabId, signal, onFault }) {
    this.targetTabId = targetTabId;
    this.signal = signal;
    this.onFault = onFault;
    this.listen(this.api.tabs.onUpdated, (id, change, tab) => {
      if (id !== this.targetTabId || signal.aborted) return;
      const candidate = change.url || tab.pendingUrl;
      if (candidate) this.guard(candidate);
      if (change.status && !tab.url) onFault('tab_access_lost');
      if (change.status === 'complete' && tab.url) this.guard(tab.url);
    });
    this.listen(this.api.tabs.onCreated, tab => { if (tab.openerTabId === targetTabId) onFault('new_tab_opened'); });
    this.listen(this.api.tabs.onRemoved, id => { if (id === targetTabId) onFault('target_tab_closed'); });
    this.listen(this.api.tabs.onReplaced, (_added, removed) => { if (removed === targetTabId) onFault('target_tab_replaced'); });
    const tab = await this.api.tabs.get(targetTabId);
    if (signal.aborted) throw signal.reason;
    if (tab.id !== targetTabId || !tab.url) throw new CaptureError('tab_access_lost');
    classifyURL(tab.url);
    if (tab.pendingUrl || tab.status === 'loading') throw new CaptureError('target_not_ready');
    this.expectedURL = tab.url;
  }
  listen(event, callback) {
    event.addListener(callback);
    this.cleanups.push(() => event.removeListener(callback));
  }
  guard(url) {
    try {
      classifyURL(url);
      if (this.expectedURL && !samePage(url, this.expectedURL)) throw new CaptureError('unexpected_navigation');
    } catch (error) { this.onFault(error instanceof CaptureError ? error.code : 'tab_access_lost'); }
  }
  async read(mode) {
    if (this.signal.aborted) throw this.signal.reason;
    const tab = await this.api.tabs.get(this.targetTabId);
    if (this.signal.aborted) throw this.signal.reason;
    if (tab.id !== this.targetTabId || !tab.url) throw new CaptureError('tab_access_lost');
    if (tab.pendingUrl || tab.status === 'loading') throw new CaptureError('unexpected_navigation');
    this.guard(tab.url);
    if (this.signal.aborted) throw this.signal.reason;
    const frames = await this.api.scripting.executeScript({
      target: { tabId: this.targetTabId, frameIds: [0] },
      func: extractPageDOM,
      args: [mode, DOM_POLICY],
    });
    if (frames.length !== 1 || frames[0].frameId !== 0) throw new CaptureError('invalid_frame_result');
    return frames[0].result;
  }
  navigate(url, signal) {
    if (signal.aborted) return Promise.reject(signal.reason);
    classifyURL(url);
    this.expectedURL = url;
    return new Promise((resolve, reject) => {
      let settled = false, updateReturned = false, completeTab = null;
      const cleanup = () => {
        this.api.tabs.onUpdated.removeListener(updated);
        signal.removeEventListener('abort', aborted);
      };
      const finish = (error, tab) => {
        if (settled) return;
        settled = true;
        cleanup();
        error ? reject(error) : resolve(tab);
      };
      const aborted = () => finish(signal.reason);
      const completed = tab => {
        if (!tab.url) return finish(new CaptureError('tab_access_lost'));
        try {
          if (!samePage(tab.url, url)) throw new CaptureError('unexpected_navigation');
          finish(null, tab);
        } catch (error) { finish(error); }
      };
      const updated = (id, change, tab) => {
        if (id !== this.targetTabId || change.status !== 'complete') return;
        completeTab = tab;
        if (updateReturned) completed(tab);
      };
      this.api.tabs.onUpdated.addListener(updated);
      signal.addEventListener('abort', aborted, { once: true });
      // Stop cannot interleave between this synchronous guard and tabs.update.
      if (signal.aborted) return aborted();
      this.api.tabs.update(this.targetTabId, { url }).then(tab => {
        if (settled) return;
        updateReturned = true;
        if (!tab || tab.id !== this.targetTabId) return finish(new CaptureError('target_tab_changed'));
        try {
          if (completeTab) completed(completeTab);
          else if (tab.status === 'complete' && tab.url && samePage(tab.url, url)) completed(tab);
        } catch (error) { finish(error); }
      }, () => finish(new CaptureError('navigation_failed')));
    });
  }
  dispose() {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }
}
