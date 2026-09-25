/**
 * JSON 文件持久化存储（原子写入，无需数据库）
 * data/db.json:
 * {
 *   accounts: [], jobs: [], results: [], settings: {...}
 * }
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { resultKey } = require('./utils');

const DB_FILE = path.join(config.dataDir, 'db.json');

const defaults = () => ({
  accounts: [],
  jobs: [],
  results: [],
  settings: {
    headless: config.headless,
    scheduleEnabled: config.scheduleEnabled,
    scheduleCron: config.scheduleCron,
    maxOffersPerRun: config.maxOffersPerRun,
    stepDelayMs: config.stepDelayMs,
    // Resin 代理（控制台保存的配置，优先于 .env）
    resinUrl: '',
    resinPlatformName: '',
    // 启用开关：null=跟随配置（有URL即启用）| true=强制启用 | false=强制停用
    resinEnabled: null,
    // CloakBrowser license key（空=免费版；填了则用最新版，需联网下载）
    cloakLicenseKey: '',
    cloakHumanize: true,
  },
});

let db = defaults();
let saveTimer = null;
let saving = false;
let saveQueued = false;

function load() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      db = { ...defaults(), ...parsed, settings: { ...defaults().settings, ...(parsed.settings || {}) } };
    }
  } catch (e) {
    console.error('[store] db.json 损坏，已重置:', e.message);
    fs.renameSync(DB_FILE, DB_FILE + '.corrupt-' + Date.now());
    db = defaults();
  }
}

function persist() {
  // 防抖 + 串行化写入
  if (saving) { saveQueued = true; return; }
  saving = true;
  const snapshot = JSON.stringify(db, null, 2);
  const tmp = DB_FILE + '.tmp';
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFile(tmp, snapshot, err => {
    saving = false;
    if (err) { console.error('[store] 写入失败:', err.message); return; }
    fs.rename(tmp, DB_FILE, err2 => {
      if (err2) console.error('[store] rename 失败:', err2.message);
      if (saveQueued) { saveQueued = false; persist(); }
    });
  });
}

const save = () => { if (saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; persist(); }, 150); };

function getDb() { return db; }

// ---------- accounts ----------
const listAccounts = () => db.accounts;
const getAccount = id => db.accounts.find(a => a.id === id);
function addAccount({ label, email, password }) {
  const a = {
    id: require('./utils').uid('acc_'),
    label: label || email,
    email, password, cookies: null,
    createdAt: new Date().toISOString(),
    lastRunAt: null, lastStatus: null, lastError: null,
  };
  db.accounts.push(a); save();
  return a;
}
function updateAccount(id, patch) {
  const a = getAccount(id);
  if (!a) return null;
  Object.assign(a, patch);
  save();
  return a;
}
function removeAccount(id) {
  const i = db.accounts.findIndex(a => a.id === id);
  if (i >= 0) { db.accounts.splice(i, 1); save(); return true; }
  return false;
}

// ---------- jobs ----------
const listJobs = () => db.jobs.slice().sort((x, y) => (y.startedAt || '').localeCompare(x.startedAt || ''));
function addJob(job) { db.jobs.push(job); save(); return job; }
function updateJob(id, patch) {
  const j = db.jobs.find(x => x.id === id);
  if (!j) return null;
  Object.assign(j, patch); save();
  return j;
}
function pruneJobs() {
  if (db.jobs.length > 200) db.jobs.splice(0, db.jobs.length - 200);
}
/** 清空任务记录（保留排队中/运行中的，避免破坏任务队列）；返回删除条数 */
function clearJobs() {
  const keep = new Set(['running', 'queued']);
  const before = db.jobs.length;
  db.jobs = db.jobs.filter(j => keep.has(j.status));
  save();
  return before - db.jobs.length;
}

// ---------- results ----------
function addResults(rows) {
  for (const r of rows) db.results.push(r);
  if (db.results.length > 2000) db.results.splice(0, db.results.length - 2000);
  dedupeResults();
  save();
}
/** 同账号+同码+同 planId 只保留最新一条（clickref 每次不同，不参与去重） */
function dedupeResults() {
  const seen = new Set();
  const sorted = db.results.slice().sort((a, b) => (b.extractedAt || '').localeCompare(a.extractedAt || ''));
  const out = [];
  for (const r of sorted) {
    const k = resultKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  db.results = out;
}
const listResults = (accountId, limit = 500) => {
  let rows = db.results.slice().sort((a, b) => (b.extractedAt || '').localeCompare(a.extractedAt || ''));
  if (accountId) rows = rows.filter(r => r.accountId === accountId);
  return rows.slice(0, limit);
};
/** 清空提取结果（传 accountId 只清该账号）；返回删除条数 */
function clearResults(accountId) {
  const before = db.results.length;
  db.results = accountId ? db.results.filter(r => r.accountId !== accountId) : [];
  save();
  return before - db.results.length;
}

// ---------- settings ----------
const getSettings = () => db.settings;
function updateSettings(patch) {
  Object.assign(db.settings, patch || {});
  save();
  return db.settings;
}

load();

module.exports = {
  getDb, save,
  listAccounts, getAccount, addAccount, updateAccount, removeAccount,
  listJobs, addJob, updateJob, pruneJobs, clearJobs,
  addResults, listResults, clearResults,
  getSettings, updateSettings,
};
