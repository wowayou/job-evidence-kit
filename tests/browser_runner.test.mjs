import test from 'node:test';
import assert from 'node:assert/strict';
import { CaptureRunner } from '../extension/runner.mjs';
import { detail, FakeClock, FakeTransport, makePlan, settle } from './browser_helpers.mjs';

function setup(options = {}, limits = {}) {
  const clock = new FakeClock();
  const transport = new FakeTransport(clock, options);
  const runner = new CaptureRunner({ plan: makePlan(limits), targetTabId: 41, transport, clock, captureId: 'synthetic-capture' });
  return { clock, transport, runner };
}

test('all navigations have a global interval, and job/page caps span keywords', async () => {
  const { clock, transport, runner } = setup({ links: url => new URL(url).searchParams.get('query').endsWith('0') ? [detail('A')] : [detail('A'), detail('B'), detail('C'), detail('D')] });
  const pending = runner.run();
  await clock.advance(60000);
  const result = await pending;
  assert.equal(result.status, 'completed');
  assert.equal(result.jobs.length, 3);
  assert.deepEqual(transport.navigations.map(item => item.kind), ['search', 'detail', 'search', 'detail', 'detail']);
  assert.deepEqual(transport.navigations.map(item => item.at), [5000, 10000, 15000, 20000, 25000]);
  assert.equal(transport.disposed, true);
  assert.equal(clock.timers.size, 0);
});

test('Stop interrupts initial wait and permanently prevents navigation', async () => {
  const { clock, transport, runner } = setup();
  const pending = runner.run();
  await clock.advance(4999);
  runner.stop();
  const result = await pending;
  await clock.advance(180000);
  assert.equal(result.status, 'stopped');
  assert.equal(result.stop_reason, 'user_stop');
  assert.equal(result.jobs.length, 0);
  assert.equal(transport.navigations.length, 0);
  assert.equal(clock.timers.size, 0);
});

test('Stop at wait boundary via progress cannot issue the next navigation', async () => {
  const { clock, transport, runner } = setup();
  runner.onProgress = progress => { if (progress.stage === 'opening_search') runner.stop(); };
  const pending = runner.run();
  await clock.advance(5000);
  const result = await pending;
  assert.equal(result.status, 'stopped');
  assert.equal(transport.navigations.length, 0);
});

test('Stop during an unresolved navigation returns without waiting and forbids subsequent reads', async () => {
  let release;
  const { clock, transport, runner } = setup({ navigate: () => new Promise(resolve => { release = resolve; }) });
  const pending = runner.run();
  await clock.advance(5000);
  const reads = transport.reads.length;
  runner.stop();
  const result = await pending;
  assert.equal(result.status, 'stopped');
  release();
  await settle();
  await clock.advance(180000);
  assert.equal(transport.navigations.length, 1);
  assert.equal(transport.reads.length, reads);
});

test('Stop immediately after navigation prevents detail/search extraction and later navigation', async () => {
  const setupResult = setup({ navigate: () => setupResult.runner.stop() });
  const pending = setupResult.runner.run();
  await setupResult.clock.advance(60000);
  const result = await pending;
  assert.equal(result.status, 'stopped');
  assert.deepEqual(setupResult.transport.reads, ['preflight', 'preflight']);
  assert.equal(setupResult.transport.navigations.length, 1);
});

test('already read jobs are retained with partial warning when manually stopped', async () => {
  const { clock, transport, runner } = setup();
  runner.onProgress = progress => { if (progress.stage === 'job_read') runner.stop(); };
  const pending = runner.run();
  await clock.advance(60000);
  const result = await pending;
  assert.equal(result.status, 'stopped');
  assert.equal(result.jobs.length, 1);
  assert.ok(result.warnings.some(warning => warning.startsWith('partial_capture')));
  assert.equal(transport.navigations.length, 2);
});

test('deadline includes every wait/keyword and wins before navigation at exactly max_seconds', async () => {
  const { clock, transport, runner } = setup({}, { max_seconds: 30, min_action_seconds: 10 });
  const pending = runner.run();
  await clock.advance(180000);
  const result = await pending;
  assert.equal(result.status, 'stopped');
  assert.equal(result.stop_reason, 'max_seconds_reached');
  assert.equal(result.jobs.length, 1);
  assert.deepEqual(transport.navigations.map(item => item.at), [10000, 20000]);
});

test('challenge before next navigation fails closed with no retry', async () => {
  let preflights = 0;
  const { clock, transport, runner } = setup({ read: (_transport, mode, response) => mode === 'preflight' && ++preflights >= 2 ? { ...response, error: 'login_or_challenge' } : response });
  const pending = runner.run();
  await clock.advance(60000);
  const result = await pending;
  assert.equal(result.status, 'failed');
  assert.equal(result.stop_reason, 'login_or_challenge');
  assert.equal(transport.navigations.length, 0);
});

test('foreign origin, chat/resume/login and lost target fail before any navigation', async () => {
  for (const url of ['https://foreign.invalid/web/geek/jobs', 'https://www.zhipin.com/web/geek/chat', 'https://www.zhipin.com/web/geek/resume', 'https://www.zhipin.com/login']) {
    const { transport, runner } = setup({ url });
    const result = await runner.run();
    assert.equal(result.status, 'failed');
    assert.equal(transport.navigations.length, 0);
  }
});

test('new tab or foreign navigation fault after a job preserves partial and prevents later actions', async () => {
  for (const reason of ['new_tab_opened', 'cross_origin']) {
    const { clock, transport, runner } = setup();
    runner.onProgress = progress => { if (progress.stage === 'job_read') transport.context.onFault(reason); };
    const pending = runner.run();
    await clock.advance(60000);
    const result = await pending;
    assert.equal(result.status, 'failed');
    assert.equal(result.stop_reason, reason);
    assert.equal(result.jobs.length, 1);
    assert.equal(transport.navigations.length, 2);
  }
});

test('empty results fail; exact export fields and original current URL are retained', async () => {
  const original = detail('A', '?securityId=synthetic%2Btoken&empty=&x=1&x=2#part');
  const filled = setup({ links: () => [original] }, { max_jobs: 1 });
  const pending = filled.runner.run();
  await filled.clock.advance(60000);
  const result = await pending;
  assert.deepEqual(Object.keys(result), ['schema_version', 'source_kind', 'capture_id', 'created_at', 'status', 'stop_reason', 'source', 'limits', 'jobs', 'warnings']);
  assert.deepEqual(Object.keys(result.jobs[0]), ['source_url', 'observed_at', 'title', 'company', 'location', 'salary_text', 'text', 'collection_method']);
  assert.equal(result.jobs[0].source_url, original);
  const empty = setup({ links: () => [] });
  const emptyPending = empty.runner.run();
  await empty.clock.advance(60000);
  assert.equal((await emptyPending).status, 'failed');
  assert.equal(empty.transport.navigations.length, 2);
  await assert.rejects(empty.runner.run(), /task_already_started/);
});


test('listener cleanup failure still exports all read jobs as partial', async () => {
  const { clock, transport, runner } = setup({}, { max_jobs: 1 });
  transport.dispose = () => { throw new Error('synthetic_cleanup_failure'); };
  const pending = runner.run();
  await clock.advance(60000);
  const result = await pending;
  assert.equal(result.status, 'failed');
  assert.equal(result.stop_reason, 'browser_cleanup_failed');
  assert.equal(result.jobs.length, 1);
  assert.ok(result.warnings.some(warning => warning.startsWith('partial_capture')));
});
