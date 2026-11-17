import test from 'node:test';
import assert from 'node:assert/strict';
import { ChromeTransport } from '../extension/chrome-transport.mjs';
import { detail, fakeChrome, initialURL, settle } from './browser_helpers.mjs';

async function attached(url) {
  const fake = fakeChrome(url);
  const transport = new ChromeTransport(fake.api);
  const controller = new AbortController();
  const faults = [];
  await transport.attach({ targetTabId: 41, signal: controller.signal, onFault: reason => { faults.push(reason); controller.abort(new Error(reason)); } });
  return { ...fake, transport, controller, faults };
}

test('transport preflight rejects foreign/login/chat/resume target, then removes all listeners', async () => {
  for (const url of ['https://foreign.invalid/web/geek/jobs', 'https://www.zhipin.com/login', 'https://www.zhipin.com/web/geek/chat', 'https://www.zhipin.com/web/geek/resume']) {
    const fake = fakeChrome(url);
    const transport = new ChromeTransport(fake.api);
    await assert.rejects(transport.attach({ targetTabId: 41, signal: new AbortController().signal, onFault: () => {} }));
    transport.dispose();
    assert.equal(fake.updates.length, 0);
    for (const key of ['onUpdated', 'onCreated', 'onRemoved', 'onReplaced']) assert.equal(fake.api.tabs[key].handlers.size, 0);
  }
});

test('normal navigation and DOM injection use only original tab/main frame', async () => {
  const state = await attached();
  await state.transport.navigate(detail('A', '?synthetic=1'), state.controller.signal);
  await state.transport.read('detail');
  assert.deepEqual(state.updates, [{ id: 41, url: detail('A', '?synthetic=1') }]);
  assert.deepEqual(state.scripts[0].target, { tabId: 41, frameIds: [0] });
  assert.equal(state.scripts[0].args[0], 'detail');
  state.transport.dispose();
});

test('cross-origin redirect, forbidden path, unexpected target URL and permission loss abort', async () => {
  for (const url of ['https://foreign.invalid/web/geek/jobs', 'https://www.zhipin.com/login', detail('unexpected')]) {
    const state = await attached();
    state.api.tabs.onUpdated.emit(41, { url, status: 'loading' }, { id: 41, url });
    assert.equal(state.controller.signal.aborted, true);
    assert.ok(state.faults.length);
    assert.equal(state.updates.length, 0);
    state.transport.dispose();
  }
  const lost = await attached();
  lost.api.tabs.onUpdated.emit(41, { status: 'loading' }, { id: 41 });
  assert.deepEqual(lost.faults, ['tab_access_lost']);
  lost.transport.dispose();
});

test('new child tab, target close/replacement stop; unrelated tab activity is ignored', async () => {
  for (const [event, args, expected] of [
    ['onCreated', [{ id: 75, openerTabId: 41 }], 'new_tab_opened'],
    ['onRemoved', [41], 'target_tab_closed'],
    ['onReplaced', [75, 41], 'target_tab_replaced'],
  ]) {
    const state = await attached();
    state.api.tabs.onUpdated.emit(52, { url: 'https://foreign.invalid/' }, { id: 52 });
    state.api.tabs.onCreated.emit({ id: 90, openerTabId: 99 });
    assert.equal(state.faults.length, 0);
    state.api.tabs[event].emit(...args);
    assert.deepEqual(state.faults, [expected]);
    state.transport.dispose();
  }
});

test('cancel pending navigation unregisters navigation waiter and blocks future tabs.update', async () => {
  const state = await attached();
  state.api.tabs.update = async () => new Promise(() => {});
  const pending = state.transport.navigate(detail('A'), state.controller.signal);
  assert.equal(state.api.tabs.onUpdated.handlers.size, 2);
  state.controller.abort(new Error('user_stop'));
  await assert.rejects(pending, /user_stop/);
  assert.equal(state.api.tabs.onUpdated.handlers.size, 1);
  await assert.rejects(state.transport.navigate(detail('B'), state.controller.signal), /user_stop/);
  state.transport.dispose();
  assert.equal(state.api.tabs.onUpdated.handlers.size, 0);
});

test('Stop while tabs.get resolves prevents executeScript and does not touch another tab', async () => {
  const state = await attached();
  let release;
  state.api.tabs.get = () => new Promise(resolve => { release = resolve; });
  const pending = state.transport.read('preflight');
  await settle();
  state.controller.abort(new Error('user_stop'));
  release({ id: 41, url: initialURL, status: 'complete' });
  await assert.rejects(pending, /user_stop/);
  assert.equal(state.scripts.length, 0);
  state.transport.dispose();
});
