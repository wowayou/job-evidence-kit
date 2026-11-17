/** No browser launch here. Parent supplies its already-approved, local synthetic browser.
 * Import extractPageDOM/DOM_POLICY into the page, then call:
 *   extractPageDOM(case.mode, DOM_POLICY, document, case.url)
 * validateSnapshot in Node then calls case.check(snapshot). Never request case.url.
 * Only case.fixture (local synthetic HTML) is loaded. All URL parameters are synthetic.
 */
import assert from 'node:assert/strict';
import { detail } from './browser_helpers.mjs';

export const syntheticCurrentURL = detail('SYNTH_A', '?securityId=synthetic%2Btoken&empty=&x=1&x=2#original');
export const browserDOMCases = [
  {
    name: 'search keeps unknown parameter variants and ignores personal links', fixture: 'search.html', mode: 'search',
    url: 'https://www.zhipin.com/web/geek/jobs?query=synthetic&city=101000000',
    check: snapshot => assert.deepEqual(snapshot.links, [syntheticCurrentURL, detail('SYNTH_A', '?different=synthetic'), detail('SYNTH_B', '?keep=%2f&blank=')]),
  },
  {
    name: 'detail exact current parameters and known DOM only', fixture: 'detail.html', mode: 'detail', url: syntheticCurrentURL,
    check: snapshot => {
      assert.equal(snapshot.url, syntheticCurrentURL);
      assert.equal(snapshot.job.title, '合成数据助理');
      assert.equal(snapshot.job.company, '合成样本公司');
      assert.equal(snapshot.job.location, '合成城市');
      assert.equal(snapshot.job.salary_text, '8–10K·合成薪资');
      assert.match(snapshot.job.text, /岗位职责/);
      assert.match(snapshot.job.text, /要求/);
      assert.doesNotMatch(JSON.stringify(snapshot), /PERSONAL_ONLY|HIDDEN_ONLY|SCRIPT_ONLY|CHAT_ONLY|RESUME_ONLY/);
    },
  },
  { name: 'visible challenge dialog stops', fixture: 'challenge.html', mode: 'detail', url: syntheticCurrentURL, error: 'login_or_challenge' },
  { name: 'visible inline challenge stops', fixture: 'challenge-inline.html', mode: 'detail', url: syntheticCurrentURL, error: 'login_or_challenge' },
  { name: 'login page at otherwise normal detail URL stops', fixture: 'login.html', mode: 'detail', url: syntheticCurrentURL, error: 'login_or_challenge' },
  { name: 'cross-origin current URL stops', fixture: 'detail.html', mode: 'detail', url: 'https://foreign.invalid/job_detail/SYNTH_A.html', error: 'cross_origin' },
  { name: 'forbidden chat current URL stops', fixture: 'detail.html', mode: 'detail', url: 'https://www.zhipin.com/web/geek/chat', error: 'forbidden_path' },
  { name: 'missing known JD container fails', fixture: 'missing-body.html', mode: 'detail', url: syntheticCurrentURL, error: 'missing_job_body' },
  { name: 'missing known search container fails', fixture: 'missing-body.html', mode: 'search', url: 'https://www.zhipin.com/web/geek/jobs?query=synthetic&city=101000000', error: 'missing_search_container' },
  { name: 'empty JD with hidden/private content fails', fixture: 'empty-body.html', mode: 'detail', url: syntheticCurrentURL, error: 'empty_job_body' },
  {
    name: 'unknown fields are empty and warned, never guessed', fixture: 'unknown-fields.html', mode: 'detail', url: syntheticCurrentURL,
    check: snapshot => {
      for (const field of ['title', 'company', 'location', 'salary_text']) { assert.equal(snapshot.job[field], ''); assert.ok(snapshot.warnings.includes(`missing_${field}`)); }
    },
  },
  {
    name: 'long JD capped at 50000 with warning', fixture: 'long-body.html', mode: 'detail', url: syntheticCurrentURL,
    check: snapshot => { assert.equal(snapshot.job.text.length, 50000); assert.ok(snapshot.warnings.includes('job_text_truncated_at_50000')); },
  },
  {
    name: 'cross-origin job detail link stops before navigation', fixture: 'cross-origin-link.html', mode: 'search',
    url: 'https://www.zhipin.com/web/geek/jobs?query=synthetic&city=101000000', error: 'cross_origin',
  },
];
