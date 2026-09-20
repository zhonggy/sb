/**
 * 定时任务：按 cron 表达式自动运行全部账号
 */
const cron = require('node-cron');
const config = require('./config');
const store = require('./store');
const jobRunner = require('./jobRunner');
const { log } = require('./utils');

let task = null;

function startScheduler() {
  stopScheduler();
  const s = store.getSettings();
  if (!s.scheduleEnabled) { console.log('[scheduler] 未启用定时任务'); return null; }
  try {
    task = cron.schedule(s.scheduleCron, () => {
      const acc = store.listAccounts();
      if (!acc.length) { log(null, 'warn', '定时触发：没有账号，跳过'); return; }
      log(null, 'info', `定时任务触发：运行全部 ${acc.length} 个账号`);
      jobRunner.runAll();
    }, { timezone: config.scheduleTimezone });
    console.log(`[scheduler] 已启用: ${s.scheduleCron} (${config.scheduleTimezone})`);
    return task;
  } catch (e) {
    console.error('[scheduler] cron 表达式无效:', e.message);
    return null;
  }
}

function stopScheduler() {
  if (task) { task.stop(); task = null; }
}

function restartScheduler() { startScheduler(); }

module.exports = { startScheduler, stopScheduler, restartScheduler };
