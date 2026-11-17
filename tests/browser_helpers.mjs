import { classifyURL } from '../extension/adapter.mjs';

export const makePlan = (limits = {}, searches = 3) => ({
  version: 1, source: 'boss',
  searches: Array.from({ length: searches }, (_, index) => ({ keyword: `合成岗位${index}`, city_code: `10100000${index}`, city_label: `合成城市${index}` })),
  limits: { max_jobs: 3, max_pages: 2, max_seconds: 60, min_action_seconds: 5, ...limits },
});
export const detail = (id, query = '') => `https://www.zhipin.com/job_detail/${id}.html${query}`;
export const initialURL = 'https://www.zhipin.com/web/geek/jobs?query=synthetic&city=101000000';
export const settle = async () => { for (let step = 0; step < 50; step++) await Promise.resolve(); };

export class FakeClock {
  time = 0;
  sequence = 0;
  timers = new Map();
  now = () => this.time;
  iso = () => new Date(Date.UTC(2026, 10, 17) + this.time).toISOString();
  setTimeout = (callback, ms) => { const id = ++this.sequence; this.timers.set(id, { at: this.time + ms, callback }); return id; };
  clearTimeout = id => this.timers.delete(id);
  async advance(ms) {
    const end = this.time + ms;
    for (let step = 0; step < 500; step++) {
      await settle();
      const next = [...this.timers.entries()].filter(([, timer]) => timer.at <= end).sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) { this.time = end; await settle(); if (![...this.timers.values()].some(timer => timer.at <= end)) return; continue; }
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    throw new Error('fake_clock_loop');
  }
}

export class FakeTransport {
  constructor(clock, options = {}) {
    this.clock = clock;
    this.options = options;
    this.expectedURL = options.url ?? initialURL;
    this.navigations = [];
    this.reads = [];
    this.disposed = false;
  }
  async attach(context) { this.context = context; if (this.options.attach) await this.options.attach(this); }
  async navigate(url, signal) {
    if (signal.aborted) throw signal.reason;
    this.expectedURL = url;
    this.navigations.push({ url, at: this.clock.now(), kind: classifyURL(url).kind });
    if (this.options.navigate) await this.options.navigate(this, url);
  }
  async read(mode) {
    this.reads.push(mode);
    const info = classifyURL(this.expectedURL);
    const response = { url: this.expectedURL, kind: info.kind, links: [], job: null, warnings: [], error: '' };
    if (mode === 'search') response.links = this.options.links?.(this.expectedURL) ?? [detail('syntheticA'), detail('syntheticB'), detail('syntheticC')];
    if (mode === 'detail') response.job = { title: '合成岗位', company: '合成公司', location: '合成地点', salary_text: '未知', text: '合成岗位正文，仅用于测试。' };
    return this.options.read ? this.options.read(this, mode, response) : response;
  }
  dispose() { this.disposed = true; }
}

export class FakeEvent {
  handlers = new Set();
  addListener = handler => this.handlers.add(handler);
  removeListener = handler => this.handlers.delete(handler);
  emit = (...args) => { for (const handler of [...this.handlers]) handler(...args); };
}
export function fakeChrome(url = initialURL) {
  const tab = { id: 41, url, status: 'complete' };
  const updates = [], scripts = [];
  const api = {
    tabs: {
      onUpdated: new FakeEvent(), onCreated: new FakeEvent(), onRemoved: new FakeEvent(), onReplaced: new FakeEvent(),
      get: async id => { if (id !== tab.id) throw new Error('wrong_target'); return { ...tab }; },
      update: async (id, changes) => {
        if (id !== tab.id) throw new Error('wrong_target');
        updates.push({ id, ...changes });
        Object.assign(tab, { url: changes.url, status: 'complete' });
        api.tabs.onUpdated.emit(id, { url: tab.url, status: 'complete' }, { ...tab });
        return { ...tab };
      },
    },
    scripting: { executeScript: async request => { scripts.push(request); return [{ frameId: 0, result: { url: tab.url } }]; } },
  };
  return { api, tab, updates, scripts };
}
