/**
 * Status: active. Updated/verification date: 2026-11-17 (synthetic checks only).
 * Intended user: an explicitly consenting individual job seeker.
 * Boundary: read normal DOM, never login/chat/resume, never call site APIs.
 * Risk: BOSS routes/selectors below are NOT tested against the live site;
 * user authorization is not platform permission. Missing containers fail closed.
 */
export const BOSS_ORIGIN = 'https://www.zhipin.com';
// Normal-page route assumption, unverified live. No pagination/API route is guessed.
export const SEARCH_ROUTE = '/web/geek/jobs';
export const URL_POLICY = Object.freeze({
  origin: BOSS_ORIGIN,
  searchPattern: '^/web/geek/jobs?/?$',
  detailPattern: '^/job_detail/([A-Za-z0-9_-]+)\\.html$',
  forbiddenPattern: '(?:^|[/_.-])(?:chat|message|resume|login|passport|check|verify|verification|security|captcha)(?:[/_.-]|$)',
});

export class CaptureError extends Error {
  constructor(code) { super(code); this.name = 'CaptureError'; this.code = code; }
}
const fail = code => { throw new CaptureError(code); };
const exactKeys = (value, keys, code) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).length !== keys.length ||
      !keys.every(key => Object.hasOwn(value, key))) fail(code);
};
const stringField = value => typeof value === 'string' && value.trim().length > 0 &&
  [...value].length <= 60 && !/\p{Cc}/u.test(value);

export function validatePlan(input) {
  exactKeys(input, ['version', 'source', 'searches', 'limits'], 'invalid_plan_fields');
  if (input.version !== 1 || input.source !== 'boss') fail('unsupported_plan');
  if (!Array.isArray(input.searches) || input.searches.length < 1 || input.searches.length > 3) fail('invalid_search_count');
  const searches = input.searches.map(search => {
    exactKeys(search, ['keyword', 'city_code', 'city_label'], 'invalid_search_fields');
    if (![search.keyword, search.city_label].every(stringField)) fail('invalid_search_text');
    if (typeof search.city_code !== 'string' || search.city_code.length !== 9 || !/^[0-9]{9}$/.test(search.city_code)) fail('invalid_city_code');
    return { keyword: search.keyword, city_code: search.city_code, city_label: search.city_label };
  });
  exactKeys(input.limits, ['max_jobs', 'max_pages', 'max_seconds', 'min_action_seconds'], 'invalid_limits_fields');
  const ranges = { max_jobs: [1, 3], max_pages: [1, 2], max_seconds: [30, 180], min_action_seconds: [5, 30] };
  for (const [key, [minimum, maximum]] of Object.entries(ranges)) {
    if (!Number.isInteger(input.limits[key]) || input.limits[key] < minimum || input.limits[key] > maximum) fail(`invalid_${key}`);
  }
  return { version: 1, source: 'boss', searches, limits: { ...input.limits } };
}

export function classifyURL(raw) {
  if (typeof raw !== 'string' || raw !== raw.trim() || /[\u0000-\u001f\u007f]/u.test(raw)) fail('invalid_url');
  let url;
  try { url = new URL(raw); } catch { fail('invalid_url'); }
  if (url.origin !== BOSS_ORIGIN || url.username || url.password || url.port) fail('cross_origin');
  if (new RegExp(URL_POLICY.forbiddenPattern, 'i').test(url.pathname)) fail('forbidden_path');
  if (new RegExp(URL_POLICY.searchPattern).test(url.pathname)) return { kind: 'search', url, id: null };
  const detail = url.pathname.match(new RegExp(URL_POLICY.detailPattern));
  if (detail) return { kind: 'detail', url, id: detail[1] };
  fail('unsupported_path');
}

export function buildSearchURL(search) {
  const url = new URL(SEARCH_ROUTE, BOSS_ORIGIN);
  url.searchParams.set('query', search.keyword);
  url.searchParams.set('city', search.city_code);
  return url.href;
}

export function samePage(actual, expected) {
  const left = classifyURL(actual), right = classifyURL(expected);
  if (left.kind !== right.kind) return false;
  if (left.kind === 'detail') return left.id === right.id;
  return left.url.pathname === right.url.pathname &&
    ['query', 'city'].every(key => left.url.searchParams.get(key) === right.url.searchParams.get(key));
}

export function detailLinks(rawLinks, baseURL) {
  classifyURL(baseURL);
  const found = new Set(), links = [];
  for (const raw of rawLinks) {
    if (typeof raw !== 'string' || !raw || raw !== raw.trim() || /[\u0000-\u001f\u007f]/u.test(raw)) continue;
    let resolved;
    try { resolved = new URL(raw, baseURL); } catch { continue; }
    if (!new RegExp(URL_POLICY.detailPattern).test(resolved.pathname)) continue;
    const original = /^https?:\/\//i.test(raw) ? raw : resolved.href;
    classifyURL(original); // A foreign job_detail link fails; never follow it.
    // Unknown query values may carry identity; remove only byte-identical links here.
    if (!found.has(original)) { found.add(original); links.push(original); }
  }
  return links;
}

export const DOM_POLICY = Object.freeze({
  ...URL_POLICY,
  privateSelector: 'nav, [role="navigation"], .nav-figure, .user-info, .geek-info, .user-nav, .nav-user, .user-menu, .user-center, .personal-center, .personal-nav, .personal-navigation, .chat, .chat-panel, .chat-list, .message-panel, .resume, .resume-container, [data-personal], [data-private]',
  challengeSelector: '[role="dialog"], [role="alert"], h1, h2, h3, #captcha, .captcha, .captcha-box, .captcha-wrap, .verify-box, .verify-wrap, .security-check, .login-dialog, .login-container, .login-wrapper, .error-content, .error-page, .error-info, .geetest_panel, .geetest_captcha, .nc-container, .risk-warning, .page-error, .toast, main > p, main > div > p, body > p, body > div > p, #wrap > p, #wrap > div > p',
  challengePattern: '验证码|人机验证|安全验证|安全校验|访问异常|异常访问|操作频繁|访问过于频繁|拖动滑块|滑动.{0,20}验证|请完成.{0,20}验证|请先登录|请登录后|登录后.{0,20}查看|扫码登录|账号密码登录|账号异常|网络环境.{0,20}异常|安全检测|请.{0,20}验证|身份验证|账户验证|账号验证|验证失败|访问受限|请重新登录|登录.{0,10}(?:失效|过期)|立即登录|verify you are human|captcha|sign in to continue|log in to continue|access denied|unusual traffic|security check',
  loginSelector: 'input[type="password"], input[autocomplete="one-time-code"], iframe[src*="captcha"], iframe[src*="verify"], iframe[src*="geetest"]',
  searchRoots: ['.job-list-box', '.job-list-container', '.search-job-result .job-list'],
  cardSelector: '.job-card-wrapper, .job-primary, .job-card-body, .job-card-box, .job-card',
  descriptionSelectors: ['.job-detail .job-sec-text', '.job-detail-container .job-sec-text', '.job-detail .job-description', '.job-detail .job-desc', '.job-detail-section .job-desc'],
  fieldSelectors: {
    title: ['.job-banner .job-name h1', '.job-banner .name h1', '.job-banner h1'],
    company: ['.job-company .company-info a', '.job-company-info .company-name', '.sider-company .company-info a', '.job-detail .company-name'],
    location: ['.job-banner .text-city', '.job-banner .job-area', '.job-location .location-address', '.job-detail .location-address'],
    salary_text: ['.job-banner .salary', '.job-banner .job-salary'],
  },
});

/** Self-contained for chrome.scripting.executeScript; supplied DOM/URL enable offline fixtures.
 * Only reads known regions. No body.innerText, mutation, clicks, network or private-field values.
 */
export function extractPageDOM(mode, policy, suppliedDocument, suppliedURL) {
  const doc = suppliedDocument ?? document;
  const href = suppliedURL ?? location.href;
  const response = { url: href, kind: '', links: [], job: null, warnings: [], error: '' };
  const bad = code => ({ ...response, error: code });
  let parsed;
  try { parsed = new URL(href); } catch { return bad('invalid_url'); }
  if (parsed.origin !== policy.origin || parsed.username || parsed.password || parsed.port) return bad('cross_origin');
  if (new RegExp(policy.forbiddenPattern, 'i').test(parsed.pathname)) return bad('forbidden_path');
  response.kind = new RegExp(policy.searchPattern).test(parsed.pathname) ? 'search' :
    new RegExp(policy.detailPattern).test(parsed.pathname) ? 'detail' : '';
  if (!response.kind) return bad('unsupported_path');
  if (!['preflight', 'search', 'detail'].includes(mode) || (mode !== 'preflight' && mode !== response.kind)) return bad('unexpected_page');
  const privateNode = element => Boolean(element?.closest?.(policy.privateSelector));
  const visible = element => {
    if (!element || privateNode(element)) return false;
    if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    for (let parent = element; parent && parent.nodeType === 1; parent = parent.parentElement) {
      const style = doc.defaultView?.getComputedStyle(parent);
      if (style && (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0)) return false;
    }
    return !element.getClientRects || element.getClientRects().length > 0;
  };
  const blockTags = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'PRE']);
  const ignoredTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'NAV', 'SVG', 'CANVAS', 'FORM']);
  const read = (root, cap) => {
    const parts = [];
    let size = 0, visited = 0, truncated = false;
    const add = value => {
      const remaining = cap + 1 - size;
      if (value.length > remaining) truncated = true;
      if (remaining > 0) { const part = value.slice(0, remaining); parts.push(part); size += part.length; }
    };
    const visit = node => {
      if (size > cap) { truncated = true; return; }
      if (++visited > 12000) throw new Error('dom_read_limit');
      if (node.nodeType === 3) { add(node.nodeValue ?? ''); return; }
      if (node.nodeType !== 1 || ignoredTags.has(node.tagName) || !visible(node)) return;
      if (node.tagName === 'BR') { add('\n'); return; }
      if (blockTags.has(node.tagName) && size > 0) add('\n');
      for (const child of node.childNodes) { visit(child); if (size > cap) break; }
      if (blockTags.has(node.tagName)) add('\n');
    };
    visit(root);
    const text = parts.join('').replace(/\r/g, '').replace(/[\t \u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return { text: text.slice(0, cap), truncated: truncated || text.length > cap };
  };
  const firstVisible = selectors => {
    for (const selector of selectors) {
      for (const node of doc.querySelectorAll(selector)) if (visible(node)) return node;
    }
    return null;
  };
  try {
    for (const node of doc.querySelectorAll(policy.loginSelector)) if (visible(node)) return bad('login_or_challenge');
    const pattern = new RegExp(policy.challengePattern, 'i');
    let inspected = 0;
    for (const node of doc.querySelectorAll(policy.challengeSelector)) {
      if (!visible(node)) continue;
      if (++inspected > 120) return bad('challenge_scan_limit');
      if (pattern.test(read(node, 1200).text)) return bad('login_or_challenge');
    }
    if (response.kind === 'search') {
      const root = firstVisible(policy.searchRoots);
      if (!root) return bad('missing_search_container');
      if (mode === 'preflight') return response;
      let count = 0;
      for (const anchor of root.querySelectorAll('a[href]')) {
        if (++count > 300) { response.warnings.push('search_link_scan_limited'); break; }
        if (visible(anchor) && anchor.closest(policy.cardSelector)) response.links.push(anchor.getAttribute('href'));
      }
      return response;
    }
    const body = firstVisible(policy.descriptionSelectors);
    if (!body) return bad('missing_job_body');
    const description = read(body, 50000);
    if (!description.text) return bad('empty_job_body');
    // Challenge text inside the known JD container also fails, without reading the page body.
    if (pattern.test(description.text)) return bad('login_or_challenge');
    if (mode === 'preflight') return response;
    const job = { title: '', company: '', location: '', salary_text: '', text: description.text };
    if (description.truncated) response.warnings.push('job_text_truncated_at_50000');
    for (const [field, selectors] of Object.entries(policy.fieldSelectors)) {
      const node = firstVisible(selectors);
      const value = node ? read(node, 500) : { text: '', truncated: false };
      job[field] = value.text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
      if (!value.text) response.warnings.push(`missing_${field}`);
      if (value.truncated) response.warnings.push(`truncated_${field}`);
    }
    response.job = job;
    return response;
  } catch (error) {
    return bad(error.message === 'dom_read_limit' ? 'dom_read_limit' : 'dom_read_failed');
  }
}

export function validateSnapshot(snapshot, expectedURL, mode) {
  if (!snapshot || typeof snapshot !== 'object') fail('invalid_dom_response');
  if (snapshot.error) fail(snapshot.error);
  if (!samePage(snapshot.url, expectedURL)) fail('unexpected_navigation');
  const info = classifyURL(snapshot.url);
  if (snapshot.kind !== info.kind || (mode !== 'preflight' && info.kind !== mode)) fail('unexpected_page');
  if (!Array.isArray(snapshot.warnings) || !snapshot.warnings.every(item => typeof item === 'string')) fail('invalid_dom_response');
  if (mode === 'search') {
    if (!Array.isArray(snapshot.links) || snapshot.links.length > 300) fail('invalid_dom_response');
    return { ...snapshot, links: detailLinks(snapshot.links, snapshot.url) };
  }
  if (mode === 'detail') {
    const job = snapshot.job;
    exactKeys(job, ['title', 'company', 'location', 'salary_text', 'text'], 'invalid_job_fields');
    if (!Object.values(job).every(value => typeof value === 'string') || !job.text.trim() || job.text.length > 50000) fail('invalid_job_body');
  }
  return snapshot;
}

/** One global queue; limits never reset per keyword. Only each keyword's first page.
 * Reserving an action consumes its budget before navigation; no retry/requeue exists.
 */
export class CaptureQueue {
  constructor(plan) {
    this.plan = validatePlan(plan);
    this.searchIndex = 0;
    this.pages = 0;
    this.details = 0;
    this.pending = [];
    this.seen = new Set();
  }
  next() {
    if (this.details >= this.plan.limits.max_jobs) return null;
    if (this.pending.length) { this.details++; return { kind: 'detail', url: this.pending.shift() }; }
    if (this.pages >= this.plan.limits.max_pages || this.searchIndex >= this.plan.searches.length) return null;
    const search = this.plan.searches[this.searchIndex++];
    this.pages++;
    return { kind: 'search', url: buildSearchURL(search) };
  }
  acceptSearch(links) {
    for (const link of links) {
      const info = classifyURL(link);
      if (info.kind !== 'detail') fail('unexpected_page');
      if (this.seen.has(link)) continue;
      this.seen.add(link);
      if (this.pending.length + this.details < this.plan.limits.max_jobs) this.pending.push(link);
    }
  }
  get reason() {
    if (this.details >= this.plan.limits.max_jobs) return 'max_jobs_reached';
    if (this.pages >= this.plan.limits.max_pages) return 'max_pages_reached';
    return 'searches_exhausted';
  }
}
