/* 冒烟测试脚本：启动服务，验证 API + 全流程 */
const { spawn } = require('child_process');
const path = require('path');

const BASE = 'http://localhost:3100';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const env = { ...process.env, PW_CHANNEL: 'chrome', PORT: '3100' };
  const srv = spawn('node', ['src/server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', d => process.stdout.write('[srv] ' + d));
  srv.stderr.on('data', d => process.stdout.write('[srv:err] ' + d));
  await sleep(3500);

  const show = (t, r) => console.log(`\n== ${t} -> ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  const call = async (t, url, opts) => {
    try {
      const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
      const body = await res.json().catch(() => ({}));
      show(t, { status: res.status, body });
      return { res, body };
    } catch (e) { console.log(`\n== ${t} -> ERROR ${e.message}`); return {}; }
  };

  await call('GET /api/config', BASE + '/api/config');

  // 加一个测试账号（假密码，预期登录失败但不崩溃）
  await call('POST /api/accounts', BASE + '/api/accounts', {
    method: 'POST',
    body: JSON.stringify({ label: '冒烟测试', email: 'test-' + Date.now() + '@example.com', password: 'fake-password-123' }),
  });

  const boot = await call('GET /api/bootstrap', BASE + '/api/bootstrap');

  // 触发一次任务（会真实打开浏览器尝试登录，预期优雅失败）
  const acc = boot.body.accounts && boot.body.accounts[0];
  if (acc) {
    const run = await call('POST /api/jobs', BASE + '/api/jobs', { method: 'POST', body: JSON.stringify({ accountId: acc.id }) });
    // 等任务跑完（最多 220 秒）
    for (let i = 0; i < 44; i++) {
      await sleep(5000);
      const b = await call('GET /api/bootstrap(轮询' + (i + 1) + ')', BASE + '/api/bootstrap').catch(() => ({}));
      const job = b.body.jobs && b.body.jobs[0];
      if (job && ['success', 'failed', 'cancelled', 'needs_verify'].includes(job.status)) {
        console.log(`\n任务最终状态: ${job.status}  error=${job.error || '无'}`);
        console.log('全部日志:');
        (job.logs || []).forEach(l => console.log(`  [${l.level}] ${l.msg.split('\n')[0]}`));
        break;
      }
      if (i === 43) console.log('\n轮询超时，任务仍在进行');
    }
  }

  // 导出
  const csv = await fetch(BASE + '/api/export?format=csv');
  console.log('\n== CSV 导出 ->', csv.status, (await csv.text()).split('\n')[0]);

  srv.kill();
  process.exit(0);
}

main();
