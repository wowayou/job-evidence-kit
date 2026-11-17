import { CaptureError, CaptureQueue, classifyURL, validatePlan, validateSnapshot } from './adapter.mjs';

export const systemClock = {
  now: () => performance.now(),
  iso: () => new Date().toISOString(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: timer => clearTimeout(timer),
};
const abortError = signal => signal.reason instanceof Error ? signal.reason : new CaptureError('stopped');
const checkAbort = signal => { if (signal.aborted) throw abortError(signal); };

export function withAbort(promise, signal) {
  const pending = Promise.resolve(promise);
  if (signal.aborted) {
    pending.catch(() => {}); // Consume an operation that rejected during the same Stop turn.
    return Promise.reject(abortError(signal));
  }
  return new Promise((resolve, reject) => {
    const aborted = () => { cleanup(); reject(abortError(signal)); };
    const cleanup = () => signal.removeEventListener('abort', aborted);
    signal.addEventListener('abort', aborted, { once: true });
    pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

export function waitFor(ms, signal, clock = systemClock) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const cleanup = () => { clock.clearTimeout(timer); signal.removeEventListener('abort', aborted); };
    const aborted = () => { cleanup(); reject(abortError(signal)); };
    const timer = clock.setTimeout(() => { cleanup(); resolve(); }, ms);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

/** Runs only in the open control window. One explicit invocation, one original tab.
 * Closing the panel aborts its owner. No result/plan is persisted and no resume exists.
 * The deadline/Stop races every asynchronous operation; issued navigations cannot be undone.
 */
export class CaptureRunner {
  constructor({ plan, targetTabId, transport, clock = systemClock, captureId, onProgress = () => {} }) {
    this.plan = validatePlan(plan);
    if (!Number.isInteger(targetTabId) || targetTabId < 0) throw new CaptureError('invalid_target_tab');
    this.targetTabId = targetTabId;
    this.transport = transport;
    this.clock = clock;
    this.captureId = captureId ?? crypto.randomUUID();
    this.onProgress = onProgress;
    this.controller = new AbortController();
    this.started = false;
    this.finished = false;
    this.halt = null;
    this.jobs = [];
    this.warnings = new Set(['原始链接可能含私人参数；导出仅存项目和公开仓库之外。', '用户授权不代表BOSS平台许可；条款与账号风险仍由用户承担。']);
  }
  interrupt(status, reason) {
    if (this.finished || this.controller.signal.aborted) return;
    this.halt = { status, reason };
    this.controller.abort(new CaptureError(reason));
  }
  stop() { this.interrupt('stopped', 'user_stop'); }
  async run() {
    if (this.started) throw new CaptureError('task_already_started');
    this.started = true;
    const signal = this.controller.signal;
    const startedAt = this.clock.now();
    const createdAt = this.clock.iso();
    const deadline = startedAt + this.plan.limits.max_seconds * 1000;
    const queue = new CaptureQueue(this.plan);
    let status = 'failed', stopReason = 'not_started';
    const timer = this.clock.setTimeout(() => this.interrupt('stopped', 'max_seconds_reached'), this.plan.limits.max_seconds * 1000);
    const check = () => {
      if (this.clock.now() >= deadline) this.interrupt('stopped', 'max_seconds_reached');
      checkAbort(signal);
    };
    const progress = stage => this.onProgress({ stage, jobs: this.jobs.length, pages: queue.pages, details: queue.details, elapsed_seconds: Math.floor((this.clock.now() - startedAt) / 1000) });
    const read = async mode => {
      check();
      const snapshot = await withAbort(this.transport.read(mode), signal);
      check();
      const valid = validateSnapshot(snapshot, this.transport.expectedURL, mode);
      for (const warning of valid.warnings) this.warnings.add(warning);
      return valid;
    };
    try {
      check();
      await withAbort(this.transport.attach({ targetTabId: this.targetTabId, signal, onFault: reason => this.interrupt('failed', reason) }), signal);
      check();
      classifyURL(this.transport.expectedURL);
      await read('preflight');
      for (let action = queue.next(); action; action = queue.next()) {
        progress('waiting');
        // Every normal navigation has its own full wait; keyword changes do not reset budgets.
        await waitFor(this.plan.limits.min_action_seconds * 1000, signal, this.clock);
        check();
        await read('preflight');
        check();
        progress(action.kind === 'search' ? 'opening_search' : 'opening_detail');
        check();
        // There is no await between the last abort check and issuing this navigation.
        await withAbort(this.transport.navigate(action.url, signal), signal);
        check();
        const snapshot = await read(action.kind);
        if (action.kind === 'search') queue.acceptSearch(snapshot.links);
        else {
          this.jobs.push({
            source_url: snapshot.url,
            observed_at: this.clock.iso(),
            title: snapshot.job.title,
            company: snapshot.job.company,
            location: snapshot.job.location,
            salary_text: snapshot.job.salary_text,
            text: snapshot.job.text,
            collection_method: 'dom',
          });
          progress('job_read');
        }
      }
      check();
      status = this.jobs.length ? 'completed' : 'failed';
      stopReason = this.jobs.length ? queue.reason : 'no_jobs_found';
      if (queue.searchIndex < this.plan.searches.length) this.warnings.add('部分关键词因全局页数或岗位上限未访问。');
    } catch (error) {
      status = this.halt?.status ?? 'failed';
      stopReason = this.halt?.reason ?? (error instanceof CaptureError ? error.code : 'browser_operation_failed');
    } finally {
      this.finished = true;
      this.clock.clearTimeout(timer);
      try { this.transport.dispose(); }
      catch {
        this.warnings.add('browser_cleanup_failed：监听清理失败；任务已终止，不会继续导航。');
        if (status === 'completed') { status = 'failed'; stopReason = 'browser_cleanup_failed'; }
      }
    }
    if (status !== 'completed' && this.jobs.length) this.warnings.add('partial_capture：任务提前中断；仅保留已读岗位，不代表完整采集。');
    if (!this.jobs.length) this.warnings.add('没有采集到可用岗位正文，不得视为采集成功。');
    return {
      schema_version: 1,
      source_kind: 'browser_capture',
      capture_id: this.captureId,
      created_at: createdAt,
      status,
      stop_reason: stopReason,
      source: 'boss',
      limits: { ...this.plan.limits },
      jobs: this.jobs.map(job => ({ ...job })),
      warnings: [...this.warnings],
    };
  }
}
