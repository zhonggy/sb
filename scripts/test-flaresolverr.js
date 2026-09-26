/** FlareSolverr 客户端端到端测试（模拟 FS 服务，不开真浏览器） */
process.env.FLARESOLVERR_URL = 'http://127.0.0.1:18191';
process.env.PROXY_URL = 'http://user:pw@10.0.0.1:8080'; // 测试代理拆分逻辑

const http = require('http');
const srv = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ status: 'ok' }));
  }
  if (req.url === '/v1') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body);
      const isLogin = /accounts\./.test(j.url);
      console.log('收到请求: cmd=%s url=%s proxy=%s', j.cmd, j.url, JSON.stringify(j.proxy || null));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        status: 'ok',
        solution: {
          url: j.url,
          cookies: isLogin ? [
            // 登录域：新的 cf_clearance（同名不同域）+ accounts 独有 cookie
            { name: 'cf_clearance', value: 'login_tok', domain: 'accounts.studentbeans.com', path: '/', expiry: 1993456000, secure: true },
            { name: 'accounts_cf_bm', value: 'x1', domain: 'accounts.studentbeans.com', path: '/' },
          ] : [
            { name: 'cf_clearance', value: 'tok123', domain: '.studentbeans.com', path: '/', expiry: 1993456000, httpOnly: true, secure: true, sameSite: 'no_restriction' },
            { name: 'sb_session', value: 's1', domain: '.studentbeans.com', path: '/', expires: -1 },
          ],
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) FS-Chrome/130',
        },
      }));
    });
    return;
  }
  res.writeHead(404); res.end();
});

srv.listen(18191, '127.0.0.1', async () => {
  try {
    const f = require('../src/scraper/flaresolverr');
    console.log('isEnabled:', f.isEnabled());
    const w = await f.warm(null, 'acc_test');
    console.log('warm 结果: %d 条 cookie, UA=%s', w.cookies.length, w.userAgent);
    for (const c of w.cookies) console.log('  -', c.name, '@', c.domain, '=', c.value);

    // off 禁用逻辑
    process.env.FLARESOLVERR_URL = 'off';
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/scraper/flaresolverr')];
    const f2 = require('../src/scraper/flaresolverr');
    console.log('设 off 后 isEnabled:', f2.isEnabled());

    // jobRunner 重试编排能正常加载
    require('../src/jobRunner');
    console.log('jobRunner 模块加载 OK');
  } catch (e) {
    console.error('测试失败:', e);
    process.exitCode = 1;
  } finally {
    srv.close();
  }
});
