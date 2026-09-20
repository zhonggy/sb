/**
 * 登录流程（基于实测 DOM）：
 *  1. 打开 www.studentbeans.com/uk，接受 Cookie 横幅
 *  2. 点击 a[data-testid="nav-login"] → OAuth 跳转到 accounts.studentbeans.com
 *  3. 在 #email / #password 填账号密码，点击表单内 "Log in" 按钮
 *  4. 等待跳回 www 域名（含 Cloudflare Turnstile 自动通过的等待）
 *  5. 校验登录态：nav-login 消失 / profile-img 出现
 *
 * 返回 { ok, status: 'logged_in'|'already_logged_in'|'needs_verify'|'failed', message }
 */
const config = require('../config');
const { sleep, log } = require('../utils');

/** 强制移除 Cookie 遮罩（深色遮罩会拦截页面所有点击） */
async function forceRemoveOverlays(page, job) {
  const removed = await page.evaluate(() => {
    let n = 0;
    for (const s of ['#onetrust-consent-sdk', '.onetrust-pc-dark-filter']) {
      document.querySelectorAll(s).forEach(e => { e.remove(); n++; });
    }
    return n;
  }).catch(() => 0);
  return removed;
}

async function acceptCookies(page, job) {
  // OneTrust SDK 由 JS 延迟注入，即使初始不可见也要轮询等待
  for (let t = 0; t < 10; t++) {
    const shown = await page.locator('#onetrust-consent-sdk').first().isVisible().catch(() => false);
    if (shown) break;
    await sleep(800);
  }
  const selectors = [
    '#onetrust-accept-btn-handler',
    'button:has-text("Accept All Cookies")',
    'button:has-text("Accept all cookies")',
    'button:has-text("Accept")',
  ];
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count()) {
        await el.click({ timeout: 4000 });
        log(job, 'info', '已接受 Cookie 横幅');
        await sleep(1200);
        return true;
      }
    } catch (e) { /* 尝试下一个 */ }
  }
  // 兜底：JS 强制移除遮罩
  const removed = await forceRemoveOverlays(page);
  if (removed > 0) log(job, 'info', `已强制移除 ${removed} 个 Cookie 遮罩元素`);
  return removed > 0;
}

/** 判断当前页面（www 域）是否已登录。
 *  核心信号：未登录时导航栏存在可见的 nav-login 链接；登录后该链接消失。
 *  （不能用 profile-img 判断——未登录页也存在该元素）*/
async function isLoggedInOnSite(page) {
  try {
    return await page.evaluate(() => {
      const links = [...document.querySelectorAll('[data-testid="nav-login"]')]
        .filter(el => el.offsetWidth || el.offsetHeight);
      return links.length === 0;
    });
  } catch (e) {
    return false;
  }
}

async function waitTurnstileToken(page, job, timeoutMs = 20000) {
  // Turnstile 的隐藏 input[name=cf-turnstile-response] 通过后会有值
  try {
    await page.waitForFunction(
      () => {
        const el = document.querySelector('input[name="cf-turnstile-response"]');
        return el && el.value && el.value.length > 20;
      },
      null,
      { timeout: timeoutMs }
    );
    log(job, 'info', 'Turnstile 验证已通过');
    return true;
  } catch (e) {
    log(job, 'warn', '未检测到 Turnstile token（可能无需验证或仍在挑战中）');
    return false;
  }
}

async function doLogin(page, account, job) {
  log(job, 'info', '打开主页准备登录…');
  await page.goto(config.siteUrl, { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs });
  await sleep(2500);
  await acceptCookies(page, job);

  if (await isLoggedInOnSite(page)) {
    log(job, 'info', '会话仍然有效，跳过登录');
    return { ok: true, status: 'already_logged_in' };
  }

  // 点击登录入口 → OAuth 跳转到 accounts 域（先清遮罩再点，最多重试 3 次）
  log(job, 'info', '点击导航登录按钮…');
  const navLogin = page.locator('a[data-testid="nav-login"]').first();
  let entered = false;
  for (let attempt = 0; attempt < 3 && !entered; attempt++) {
    await forceRemoveOverlays(page);
    if (await navLogin.count()) {
      entered = await navLogin.click({ timeout: 6000 }).then(() => true).catch(() => false);
    }
    if (!entered && attempt === 1) {
      // 第二次失败：改用完整 OAuth 链接（携带 client_id，登录后才能正确回写主站会话）
      const href = await page.evaluate(() => {
        const el = document.querySelector('a[data-testid="nav-login"]');
        return el && el.href ? el.href : null;
      });
      if (href) {
        log(job, 'info', '改用 OAuth 链接直接进入登录页');
        await page.goto(href, { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs }).catch(() => {});
        entered = true;
      }
    }
    if (!entered) await sleep(1500);
  }
  if (!entered) {
    log(job, 'warn', '点击登录入口多次失败，直接跳转登录页');
    await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs }).catch(() => {});
  }

  // 等待到达 accounts 登录域（OAuth 授权端点可能是中间页，轮询：URL 命中 或 登录表单已出现）
  let onLoginPage = false;
  for (let t = 0; t < 30; t++) {
    await sleep(1000);
    const url = page.url();
    if (/accounts\.studentbeans\.com/.test(url)) { onLoginPage = true; break; }
    const formVisible = await page.locator('input#email, input[type="email"], input#password').first().isVisible().catch(() => false);
    if (formVisible) { onLoginPage = true; break; }
  }
  if (!onLoginPage) {
    log(job, 'info', '未到达登录页，直接打开登录页');
    await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs }).catch(() => {});
  }
  await sleep(3000);
  await acceptCookies(page, job);

  // 可能出现的二次确认/验证提示
  const bodyText = () => page.innerText('body').catch(() => '');

  // 填写表单
  log(job, 'info', '填写账号密码…');
  const emailInput = page.locator('input#email, input[type="email"], input[name="email"]').first();
  const pwdInput = page.locator('input#password, input[type="password"], input[name="password"]').first();
  if (!(await emailInput.count()) || !(await pwdInput.count())) {
    const t = await bodyText();
    if (/verify|confirm|check your email/i.test(t)) {
      return { ok: false, status: 'needs_verify', message: '检测到需要邮箱验证链接' };
    }
    return { ok: false, status: 'failed', message: '登录页未找到邮箱/密码输入框（页面结构可能变化）' };
  }

  await emailInput.fill(account.email);
  await sleep(300);
  await pwdInput.fill(account.password);
  await sleep(500);

  // Turnstile：先等它出 token（managed 模式通常自动通过）
  await waitTurnstileToken(page, job, 25000);

  // 提交按钮：Turnstile 通过前是 disabled，等它解除禁用（最多 45s）
  const submitSel = 'form button[type="submit"]:has-text("Log in"), button[type="submit"]:has-text("Log in")';
  log(job, 'info', '等待提交按钮可用（Turnstile 验证）…');
  const btnReady = await page.waitForSelector(
    submitSel.split(',')[0] + ':not([disabled])',
    { timeout: 45000 }
  ).then(() => true).catch(() => false);
  if (!btnReady) {
    log(job, 'warn', '提交按钮仍处于禁用状态（Turnstile 未通过），尝试回车提交');
  }

  log(job, 'info', '提交登录…');
  try {
    const submitBtn = page.locator(submitSel).first();
    if (await submitBtn.count()) {
      await submitBtn.click({ timeout: config.clickTimeoutMs, force: !!btnReady ? undefined : true });
    } else {
      await pwdInput.press('Enter');
    }
  } catch (e) {
    log(job, 'warn', '点击提交失败，改用回车: ' + e.message.split('\n')[0]);
    await pwdInput.press('Enter').catch(() => {});
  }

  // 等待结果：跳回 www 域 / 错误提示 / 验证提示 / 人机验证
  const deadline = Date.now() + config.loginTimeoutMs;
  let outcome = 'unknown';
  let turnstileStuck = false;
  while (Date.now() < deadline) {
    await sleep(2000);
    const url = page.url();
    const txt = await bodyText();

    if (!/accounts\.studentbeans\.com/.test(url)) {
      outcome = 'redirected';
      break;
    }
    if (/incorrect|invalid|wrong password|unable to log|not recognised|try again|error/i.test(txt)) {
      const snippet = txt.replace(/\s+/g, ' ').slice(0, 120);
      return { ok: false, status: 'failed', message: `账号或密码可能错误（站点提示片段: ${snippet}）` };
    }
    if (/verify your email|confirm your email|check your (inbox|email)|magic link|link.*expired/i.test(txt)) {
      return { ok: false, status: 'needs_verify', message: 'Student Beans 要求先点击邮件里的验证链接（新 IP/新设备常见）。请到邮箱点击链接后重试，或在账号上导入 Cookie。' };
    }
    // Cloudflare Turnstile 交互式挑战（iframe 复选框可见）
    const tsVisible = await page.evaluate(() => {
      const f = [...document.querySelectorAll('iframe')].find(f => /challenges\.cloudflare\.com/.test(f.src || ''));
      return !!(f && (f.offsetWidth || f.offsetHeight) && f.getBoundingClientRect().width > 10);
    }).catch(() => false);
    if (tsVisible) {
      turnstileStuck = true;
    }
  }

  await sleep(3000);
  if (outcome !== 'redirected') {
    // 最后再确认一次 URL
    if (/accounts\.studentbeans\.com/.test(page.url())) {
      if (turnstileStuck) {
        return {
          ok: false, status: 'failed',
          message: '卡在 Cloudflare 人机验证（Turnstile）。建议：1) 使用英国/住宅 IP（PROXY_URL）；2) 改 HEADLESS=false 手动过一次验证；3) 或在账号上导入已登录的 Cookie。',
        };
      }
      return { ok: false, status: 'failed', message: '登录后未跳转回主站（可能卡在人机验证）' };
    }
  }

  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await acceptCookies(page, job);

  const ok = await isLoggedInOnSite(page);
  log(job, ok ? 'info' : 'warn', ok ? '登录成功' : '已跳转回主站但登录态存疑');
  return { ok, status: ok ? 'logged_in' : 'failed', message: ok ? '' : '未确认登录状态（nav 未变化）' };
}

module.exports = { doLogin, isLoggedInOnSite, acceptCookies, forceRemoveOverlays };
