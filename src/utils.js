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
    nextExtractAt: a.nextExtractAt || null,
  };
}

/** 尝试从任意文本中提取优惠码（大写字母数字为主，长度 4-16） */
const CODE_RE = /\b([A-Z0-9]{4,16})\b/;
function extractCodeFromText(text) {
  if (!text) return null;
  const lines = String(text).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  // 码必须含大写字母或数字（防止把 "code here" 里的 here 当成码）
  const valid = c => c && /[A-Z0-9]/.test(c) && !/^[a-z]+$/.test(c);
  // 优先匹配带提示词的行
  for (const l of lines) {
    const m = l.match(/(?:code|折扣码|优惠码)[^A-Za-z0-9]{0,6}([A-Za-z0-9]{4,16})/i);
    if (m && valid(m[1])) return m[1].toUpperCase();
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

/** 结果去重键：同账号 + 同优惠码 + 同 planId 视为同一条
 *  （awin 链接的 clickref 每次点击都变，不能参与去重） */
function resultKey(r) {
  if (!r) return '';
  const code = (r.code || '').toUpperCase();
  let plan = '';
  if (r.url) {
    const m = String(r.url).match(/planId=(\d+)/i);
    plan = m ? 'plan' + m[1] : String(r.url).replace(/[?&]clickref=[^&]*/gi, '');
  }
  return (r.accountId || '') + '|' + code + '|' + plan;
}

/** 精简优惠标题：只保留套餐和价格部分
 *  "80 GB for £10 a month + 1 month FREE + Unlimited Social" → "80 GB for £10 a month" */
function shortTitle(title) {
  if (!title) return '';
  const t = String(title).replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.+?\ba month\b)/i);
  if (m) return m[1].trim();
  return t.split(/\s+\+\s+/)[0].trim();
}

/** 按套餐价格升序排序（£10 → £12 → £15 → £20）；无价格的排最后，其次按时间倒序 */
function sortByPrice(rows) {
  const priceOf = r => {
    const m = String((r && r.title) || '').match(/£\s?(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  };
  return rows.slice().sort((a, b) => {
    const pa = priceOf(a), pb = priceOf(b);
    if (pa != null && pb != null && pa !== pb) return pa - pb;
    if (pa != null && pb == null) return -1;
    if (pa == null && pb != null) return 1;
    return ((b.extractedAt || '').localeCompare(a.extractedAt || ''));
  });
}

module.exports = { bus, sleep, uid, log, maskAccount, extractCodeFromText, toCsv, resultKey, shortTitle, sortByPrice };
