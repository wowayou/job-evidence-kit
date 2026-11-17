import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchURL, CaptureQueue, classifyURL, detailLinks, samePage, validatePlan, validateSnapshot } from '../extension/adapter.mjs';
import { detail, initialURL, makePlan } from './browser_helpers.mjs';

const clone = value => JSON.parse(JSON.stringify(value));

test('strict plan rejects extra/missing fields, wrong types, and every boundary violation', () => {
  const valid = makePlan();
  assert.deepEqual(validatePlan(valid), valid);
  const cases = [
    plan => { plan.extra = true; }, plan => { delete plan.source; }, plan => { plan.source = 'other'; },
    plan => { plan.version = '1'; }, plan => { plan.searches = []; }, plan => { plan.searches.push(plan.searches[0]); },
    plan => { plan.searches[0].city_code = 101; }, plan => { plan.searches[0].extra = ''; },
    plan => { plan.searches[0].keyword = ' '; }, plan => { plan.searches[0].keyword = 'x\n'; },
    plan => { plan.searches[0].keyword = 'x'.repeat(61); }, plan => { plan.searches[0].city_label = '地'.repeat(61); },
    plan => { plan.searches[0].city_label = '城\u0085市'; },
    ...['10100', '1234567890', 'abcdefghi', '12345678 ', '123456789\n', '１２３４５６７８９'].map(value => plan => { plan.searches[0].city_code = value; }),
    plan => { plan.limits.extra = 1; }, plan => { delete plan.limits.max_pages; },
    ...Object.entries({ max_jobs: [0, 4, 1.2, '2'], max_pages: [0, 3], max_seconds: [29, 181], min_action_seconds: [4, 31] }).flatMap(([key, values]) => values.map(value => plan => { plan.limits[key] = value; })),
  ];
  for (const mutate of cases) { const value = clone(valid); mutate(value); assert.throws(() => validatePlan(value)); }
  assert.doesNotThrow(() => validatePlan(makePlan({ max_jobs: 1, max_pages: 1, max_seconds: 30, min_action_seconds: 30 }, 1)));
  assert.doesNotThrow(() => validatePlan(makePlan({ max_jobs: 3, max_pages: 2, max_seconds: 180, min_action_seconds: 5 })));
  const unicode = makePlan();
  unicode.searches[0].keyword = '😀'.repeat(60);
  unicode.searches[0].city_label = '地'.repeat(60);
  assert.doesNotThrow(() => validatePlan(unicode));
});

test('normal search URL encodes keyword and city without inventing pagination', () => {
  const url = new URL(buildSearchURL({ keyword: 'A&B 运营/中文', city_code: '101000000' }));
  assert.equal(url.origin, 'https://www.zhipin.com');
  assert.equal(url.pathname, '/web/geek/jobs');
  assert.equal(url.searchParams.get('query'), 'A&B 运营/中文');
  assert.equal(url.searchParams.get('city'), '101000000');
  assert.deepEqual([...url.searchParams.keys()], ['query', 'city']);
});

test('only exact HTTPS www origin and normal search/detail routes are accepted', () => {
  for (const path of ['/web/geek/job', '/web/geek/jobs', '/job_detail/Ab_-23.html']) assert.ok(classifyURL(`https://www.zhipin.com${path}`));
  for (const raw of [
    'https://zhipin.com/web/geek/jobs', 'http://www.zhipin.com/web/geek/jobs', 'https://www.zhipin.com.evil.test/web/geek/jobs',
    'https://www.zhipin.com:444/web/geek/jobs', 'https://name@www.zhipin.com/web/geek/jobs',
    'https://www.zhipin.com/web/geek/chat', 'https://www.zhipin.com/web/geek/resume',
    'https://www.zhipin.com/web/geek/jobs/login', 'https://www.zhipin.com/check',
    'https://www.zhipin.com/verify', 'https://www.zhipin.com/security', 'https://www.zhipin.com/captcha',
    'https://www.zhipin.com/job_detail/login.html', 'https://www.zhipin.com/job_detail/.html',
    'https://www.zhipin.com/web/geek/jobs\n', 'javascript:alert(1)',
  ]) assert.throws(() => classifyURL(raw), raw);
});

test('detail links deduplicate only identical URLs and preserve same-ID parameter variants', () => {
  const original = detail('A1', '?securityId=synthetic%2Bsecret&blank=&x=1&x=2#source');
  assert.deepEqual(detailLinks([original, original, detail('A1', '?other=1'), '/job_detail/B2.html?u=%2f&keep=', '/web/geek/chat', 'javascript:void(0)'], initialURL), [original, detail('A1', '?other=1'), detail('B2', '?u=%2f&keep=')]);
  assert.throws(() => detailLinks(['https://foreign.invalid/job_detail/C3.html'], initialURL), /cross_origin/);
});

test('samePage permits current detail query changes but rejects another ID/search keyword', () => {
  assert.ok(samePage(detail('A', '?x=1'), detail('A', '?private=2')));
  assert.equal(samePage(detail('A'), detail('B')), false);
  assert.equal(samePage(initialURL, initialURL.replace('synthetic', 'other')), false);
});

test('queue shares page/job budgets across all keywords and never navigates back to a list', () => {
  const queue = new CaptureQueue(makePlan({ max_jobs: 3, max_pages: 2 }));
  assert.equal(queue.next().kind, 'search');
  queue.acceptSearch([detail('A')]);
  assert.deepEqual(queue.next(), { kind: 'detail', url: detail('A') });
  assert.equal(queue.next().kind, 'search');
  queue.acceptSearch([detail('A'), detail('B'), detail('C'), detail('D')]);
  assert.deepEqual(queue.next(), { kind: 'detail', url: detail('B') });
  assert.deepEqual(queue.next(), { kind: 'detail', url: detail('C') });
  assert.equal(queue.next(), null);
  assert.equal(queue.pages, 2);
  assert.equal(queue.details, 3);
  const empty = new CaptureQueue(makePlan({ max_pages: 1 }));
  assert.equal(empty.next().kind, 'search');
  assert.equal(empty.next(), null);
});

test('snapshot challenge, foreign URL, missing body and oversize body fail explicitly', () => {
  const base = { url: detail('A'), kind: 'detail', error: '', warnings: [], links: [], job: { title: '', company: '', location: '', salary_text: '', text: '合成正文' } };
  assert.equal(validateSnapshot(base, detail('A'), 'detail').job.text, '合成正文');
  assert.throws(() => validateSnapshot({ ...base, error: 'login_or_challenge' }, detail('A'), 'detail'), /login_or_challenge/);
  assert.throws(() => validateSnapshot({ ...base, url: 'https://foreign.invalid/job_detail/A.html' }, detail('A'), 'detail'), /cross_origin/);
  assert.throws(() => validateSnapshot({ ...base, job: null }, detail('A'), 'detail'), /invalid_job_fields/);
  assert.throws(() => validateSnapshot({ ...base, job: { ...base.job, text: ' ' } }, detail('A'), 'detail'), /invalid_job_body/);
  assert.throws(() => validateSnapshot({ ...base, job: { ...base.job, text: 'x'.repeat(50001) } }, detail('A'), 'detail'), /invalid_job_body/);
  assert.throws(() => validateSnapshot({ ...base, job: { ...base.job, extra: '' } }, detail('A'), 'detail'), /invalid_job_fields/);
});


test('queue retains same-ID unknown and identity parameter variants without expanding job budget', () => {
  const queue=new CaptureQueue(makePlan({max_jobs:3,max_pages:1}));
  queue.next();
  const variants=[detail('A','?jobAdId=one'),detail('A','?jobAdId=two'),detail('A','?securityId=synthetic')];
  queue.acceptSearch([...variants,detail('B')]);
  for(const url of variants) assert.equal(queue.next().url,url);
  assert.equal(queue.next(),null);
  assert.equal(queue.details,3);
});
