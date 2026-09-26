/**
 * 任务运行器：串行队列，逐个账号执行「登录 → 提取 VOXI 优惠码」
 * 状态: queued → running → success | failed | needs_verify | cancelled
 */
const path = require('path');
const fs = require('fs');
const config = require('./config');
const store = require('./store');
const { sleep, uid, log } = require('./utils');
const { launchContext } = require('./scraper/browser');
const { doLogin, isLoggedInOnSite, acceptCookies } = require('./scraper/login');
const { extractVoxi } = require('./scraper/extractVoxi');
const flaresolverr = require('./scraper/flaresolverr');

const queue = [];
let running = false;

function enqueue(accountId) {
  const account = store.getAccount(accountId);
  if (!account) throw new Error('账号不存在: ' + accountId);
  if (!account.password && !(account.cookies && account.cookies.length)) {
    throw new Error('账号未设置密码或 Cookie，无法运行');
  }
  // 同一账号已有排队/运行中任务则跳过
  if (queue.some(a => a === accountId)) return { queued: false, reason: '该账号已在队列中' };
  if (activeJobs.has(accountId)) return { queued: false, reason: '该账号正在运行中' };

  const settings = store.getSettings();
  const artifactsDir = path.join(config.dataDir, 'artifacts', uid('job_'));
  const job = {
    id: uid('job_'),
    accountId,
    accountLabel: account.label || account.email,
    status: 'queued',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    logs: [],
    resultIds: [],
    error: null,
    artifactsDir,
    artifacts: [],
    cancelRequested: false,
  };
  store.addJob(job);
  log(job, 'info', '任务已排队');
  queue.push(accountId);
  activeJobs.set(accountId, job.id);
  setTimeout(processNext, 100);
  return { queued: true, jobId: job.id };
}

/** accountId -> jobId 当前运行中 */
const activeJobs = new Map();

async function processNext() {
  if (running) return;
  const accountId = queue.shift();
  if (!accountId) return;
  running = true;
  const jobId = activeJobs.get(accountId);
  const job = store.getDb().jobs.find(j => j.id === jobId);
  try {
    if (job) await runJob(job);
  } catch (e) {
    log(job, 'error', '任务异常: ' + (e && e.message));
    if (job) store.updateJob(job.id, { status: 'failed', error: String(e && e.message), finishedAt: new Date().toISOString() });
  } finally {
    activeJobs.delete(accountId);
    running = false;
    setTimeout(processNext, 200);
  }
}

/** 任务编排：两级自动兜底
 *  ① CloakBrowser 因 license/会话限制失败时，回退 Playwright 引擎重试一次
 *  ② 登录被 Cloudflare/Turnstile 拦截且配了 FlareSolverr 时，预热 Cookie + 同 UA 重试一次 */
async function runJob(job) {
  await runJobOnce(job, null);
  let j = store.getDb().jobs.find(x => x.id === job.id);

  // 兜底①：CloakBrowser license/会话限制 → 换 Playwright 引擎重试
  if (j && j.status === 'failed' && !job.retried) {
    const engine = (config.browserEngine || '').toLowerCase();
    const cloakErr = /CloakBrowser Pro|license|session limit|couldn't verify/i.test(j.error || '');
    if (engine === 'cloak' && cloakErr) {
      job.retried = true;
      log(job, 'warn', `CloakBrowser 失败（${(j.error || '').split('\n')[0]}）——免费 key 仅支持 1 个并发会话且 license 服务器从本机直连不稳定；回退 Playwright 引擎重试一次`);
      store.updateJob(job.id, { status: 'queued', error: null, finishedAt: null, logs: j.logs });
      await runJobOnce(job, 'playwright');
      j = store.getDb().jobs.find(x => x.id === job.id);
    }
  }

  // 兜底②：被 Cloudflare/Turnstile 拦截 → FlareSolverr 预热 Cookie + 同 UA 重试
  if (j && j.status === 'failed' && !job.fsRetried && flaresolverr.isEnabled()) {
    const cfBlocked = /cloudflare|turnstile|人机验证|challenge|输入框/i.test(j.error || '');
    if (cfBlocked) {
      job.fsRetried = true;
      log(job, 'warn', '登录疑似被 Cloudflare 拦截——尝试 FlareSolverr 预热 Cookie 后重试一次');
      store.updateJob(job.id, { status: 'queued', error: null, finishedAt: null, logs: j.logs });
      // Camoufox 是 Firefox 指纹，与 FlareSolverr 的 Chrome UA 不匹配（cf_clearance 会失效），
      // 兜底重试强制用 Playwright 引擎
      const engine = (config.browserEngine || '').toLowerCase();
      await runJobOnce(job, engine === 'camoufox' ? 'playwright' : null, { flaresolverrWarm: true });
    }
  }
}

async function runJobOnce(job, engineOverride, extra = {}) {
  const account = store.getAccount(job.accountId);
  if (!account) {
    store.updateJob(job.id, { status: 'failed', error: '账号已被删除', finishedAt: new Date().toISOString() });
    return;
  }
  store.updateJob(job.id, { status: 'running' });
  log(job, 'info', `开始任务（账号: ${account.email}）${engineOverride ? '（引擎: ' + engineOverride + '）' : ''}${extra.flaresolverrWarm ? '（FlareSolverr 兜底重试）' : ''}`);

  // FlareSolverr 兜底重试：先预热（拿 cf_clearance 等 Cookie + 它过质询用的 UA），
  // 预热失败则照常裸跑（不阻断）
  let launchOpts;
  if (extra.flaresolverrWarm) {
    const warmRes = await flaresolverr.warm(job, job.accountId);
    if (warmRes) launchOpts = { userAgent: warmRes.userAgent || undefined, preCookies: warmRes.cookies };
  }

  const settings = store.getSettings();

  let context = null;
  const resultIds = [];
  let finalStatus = 'failed';
  let finalError = null;

  try {
    context = await launchContext(job.accountId, engineOverride, launchOpts);
    const page = context.pages()[0] || await context.newPage();

    // Cookie 导入优先（跳过用户名密码登录）
    let loginRes;
    if (account.cookies && account.cookies.length) {
      log(job, 'info', `使用导入的 Cookie 恢复会话…（${account.cookies.length} 条: ${account.cookies.map(c => c.name).slice(0, 15).join(', ')}）`);
      await context.addCookies(account.cookies);
      await page.goto(config.voxiPageUrl, { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs }).catch(() => {});
      await sleep(2000);
      let cookieOk = await isLoggedInOnSite(page);
      if (!cookieOk) {
        // React 水化慢可能误判，再等 2 秒复查一次
        await sleep(2000);
        cookieOk = await isLoggedInOnSite(page);
      }
      if (cookieOk) {
        loginRes = { ok: true, status: 'already_logged_in' };
        log(job, 'info', 'Cookie 会话有效');
      } else {
        // 诊断：上下文里实际生效的 studentbeans cookie + 当前 URL
        const ctxCookies = await context.cookies('https://www.studentbeans.com').catch(() => []);
        log(job, 'warn', `Cookie 验证未通过（当前URL: ${page.url()}；上下文生效 cookie: ${ctxCookies.map(c => c.name).slice(0, 20).join(', ') || '无'}）`);
        log(job, 'warn', '提示：document.cookie 复制不到 httpOnly 的会话 cookie——若浏览器明明已登录，请改用「Copy as cURL」方式重新导入');
        loginRes = account.password ? await doLogin(page, account, job) : { ok: false, status: 'failed', message: 'Cookie 失效且未设置密码' };
      }
    } else {
      loginRes = await doLogin(page, account, job);
    }

    if (!loginRes.ok) {
      finalStatus = loginRes.status === 'needs_verify' ? 'needs_verify' : 'failed';
      finalError = loginRes.message || '登录失败';
      const shot = await page.screenshot().catch(() => null);
      await saveJobArtifact(job, 'login-fail.png', shot, 'image/png');
      log(job, finalStatus === 'needs_verify' ? 'warn' : 'error', finalError);
      return;
    }
    log(job, 'info', loginRes.status === 'already_logged_in' ? '复用已有会话' : '登录成功');

    // 提取
    const { results, artifacts, error } = await extractVoxi(page, account, job, {
      maxOffers: settings.maxOffersPerRun,
      stepDelayMs: settings.stepDelayMs,
    });
    for (const r of results) resultIds.push(r.id);
    if (results.length) {
      store.addResults(results);
      log(job, 'ok', `本轮共提取 ${results.length} 条优惠码`);
      finalStatus = 'success';
      // 成功提取到码和链接 → 标记下次提取日期（默认 30 天后）
      const nextExtractAt = new Date(Date.now() + config.nextExtractDays * 864e5).toISOString();
      store.updateAccount(account.id, { nextExtractAt });
      log(job, 'info', `🗓 已标记下次提取日期: ${nextExtractAt.slice(0, 10)}（${config.nextExtractDays} 天后）`);
    } else {
      finalError = error || '未提取到优惠码';
      finalStatus = error ? 'failed' : 'success'; // 页面正常但无码也算成功
      log(job, error ? 'error' : 'warn', finalError);
    }

    store.updateAccount(account.id, { lastRunAt: new Date().toISOString(), lastStatus: finalStatus, lastError: finalError });
  } catch (e) {
    finalError = (e && e.message) || String(e);
    finalStatus = 'failed';
    log(job, 'error', '运行失败: ' + finalError);
  } finally {
    if (context) await context.close().catch(() => {});
    if (!finalStatus) finalStatus = 'failed';
    store.updateJob(job.id, {
      status: job.cancelRequested ? 'cancelled' : finalStatus,
      finishedAt: new Date().toISOString(),
      resultIds,
      error: finalError,
    });
    log(job, job.cancelRequested ? 'warn' : (finalStatus === 'success' ? 'ok' : 'error'),
      job.cancelRequested ? '任务已取消' : `任务结束: ${finalStatus}${finalError ? '（' + finalError + '）' : ''}`);
    store.pruneJobs();
  }
}

async function saveJobArtifact(job, name, buffer, mime = 'text/plain') {
  if (!buffer) return null;
  const dir = job.artifactsDir;
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fs.promises.writeFile(file, buffer);
  if (!job.artifacts) job.artifacts = [];
  job.artifacts.push(file);
  return file;
}

function cancelJob(jobId) {
  const job = store.getDb().jobs.find(j => j.id === jobId);
  if (!job) return false;
  if (job.status === 'running' || job.status === 'queued') {
    job.cancelRequested = true;
    store.save();
    log(job, 'warn', '收到取消请求');
    return true;
  }
  return false;
}

function runAll() {
  const accounts = store.listAccounts();
  const out = [];
  for (const a of accounts) {
    try { out.push({ accountId: a.id, ...enqueue(a.id) }); } catch (e) { out.push({ accountId: a.id, queued: false, reason: e.message }); }
  }
  return out;
}

module.exports = { enqueue, cancelJob, runAll, activeJobs };
