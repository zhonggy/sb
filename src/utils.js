/**
 * 工具函数 + 事件总线（用于 SSE 推送任务日志）
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(100);

const sleep = ms => new Promise(r => setTimeout(r, ms));

const uid = (prefix = '') => prefix + crypto.randomBytes(8).toString('hex');

/** 日志行：{ts, level, msg, accountId, jobId} */
function log(job, level, msg) {
  const line = { ts: new Date().toISOString(), level, msg: String(msg) };
  if (job) {
    line.jobId = job.id;
    line.accountId = job.accountId;
    job.logs.push(line);
    if (job.logs.length > 500) job.logs.splice(0, job.logs.length - 500);
  }
  bus.emit('log', line);
  const tag = job ? `[${job.accountLabel || job.accountId}]` : '[sys]';
  console.log(`${line.ts} ${level.toUpperCase()} ${tag} ${line.msg}`);
}

/** 脱敏：用于返回给前端的账号数据 */
function maskAccount(a) {
  if (!a) return a;
  return {
    id: a.id, label: a.label, email: a.email,
    passwordSet: !!a.password,
    hasCookies: Array.isArray(a.cookies) && a.cookies.length > 0,
    cookieCount: Array.isArray(a.cookies) ? a.cookies.length : 0,
    createdAt: a.createdAt, lastRunAt: a.lastRunAt, lastStatus: a.lastStatus, lastError: a.lastError,
  };
}

/** 尝试从任意文本中提取优惠码（大写字母数字为主，长度 4-16） */
const CODE_RE = /\b([A-Z0-9]{4,16})\b/;
function extractCodeFromText(text) {
  if (!text) return null;
  const lines = String(text).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  // 优先匹配带提示词的行
  for (const l of lines) {
    const m = l.match(/(?:code|折扣码|优惠码)[^A-Za-z0-9]{0,6}([A-Z0-9]{4,16})/i);
    if (m) return m[1];
  }
  for (const l of lines) {
    const m = l.match(CODE_RE);
    if (m && /\d/.test(m[1])) return m[1]; // 含数字的更可能是码
  }
  const m = String(text).match(CODE_RE);
  return m ? m[1] : null;
}

function toCsv(rows, headers) {
  const esc = v => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const head = headers.map(esc).join(',');
  const body = rows.map(r => headers.map(h => esc(r[h])).join(',')).join('\n');
  return head + '\n' + body;
}

module.exports = { bus, sleep, uid, log, maskAccount, extractCodeFromText, toCsv };
