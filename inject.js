// Inject AGY Claude Style (agy-claude-style) into every open Antigravity window over CDP.
//
//   node inject.js           one-shot: inject now and exit
//   node inject.js --watch   daemon mode: auto-inject into new/reloaded windows
//                            and hot-reload style.css / *.js / config.json
const fs = require('fs');
const path = require('path');
const {
  PORT_FILE,
  PID_FILE,
  CONFIG_FILE,
  SETTING_BINDING,
  readConfig,
  readPort,
  listPages,
  CdpSession,
  buildInjectExpression,
} = require('./cdp');

const WATCH = process.argv.includes('--watch');
const LOG_FILE = path.join(__dirname, 'watch.log');

function log(...args) {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  console.log(line);
  if (WATCH) {
    try {
      fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
    } catch {}
  }
}

function shortTitle(page) {
  const t = page.title || page.url;
  return t.length > 60 ? t.slice(0, 57) + '...' : t;
}

function updateConfigSetting(key, value) {
  const validators = {
    language: (v) => v === 'zh-CN' || v === 'zh-TW' || v === 'yue' || v === 'en' || v === 'ja',
    palette: (v) =>
      v === 'obsidian' ||
      v === 'claude' ||
      v === 'gemini' ||
      v === 'sky' ||
      v === 'cyan' ||
      v === 'orange' ||
      v === 'red' ||
      v === 'purple' ||
      v === 'host',
    homeLayout: (v) => v === 'studio' || v === 'classic' || v === 'off',
    homeRipple: (v) => typeof v === 'boolean',
    composerRestyle: (v) => typeof v === 'boolean',
    mascot: (v) => v === 'crab' || v === 'off',
    logoInk: (v) => v === 'accent' || v === 'foreground',
    inlineStats: (v) => typeof v === 'boolean',
    ringMode: (v) => v === 'context' || v === 'quota' || v === 'both',
    turnBadges: (v) => typeof v === 'boolean',
    hudTopBar: (v) => typeof v === 'boolean',
    hudBottomBar: (v) => typeof v === 'boolean',
    hudRimProgress: (v) => typeof v === 'boolean',
    hudFooterChip: (v) => typeof v === 'boolean',
    hudCompact: (v) => typeof v === 'boolean',
    effortSliderStyle: (v) => v === 'claude' || v === 'chatgpt' || v === 'liangwufeng',
    effortAccent: (v) => typeof v === 'boolean',
    performanceBackdrop: (v) => v === 'off' || v === 'card' || v === 'page',
    smoothCaret: (v) => typeof v === 'boolean',
    sidebarRestyle: (v) => typeof v === 'boolean',
    sidebarCompact: (v) => typeof v === 'boolean',
    placeholderStyle: (v) => v === 'studio' || v === 'host',
    rewindPanel: (v) => typeof v === 'boolean',
    undoConfirmMode: (v) => v === 'picker' || v === 'prompt' || v === 'auto_both' || v === 'auto_chat',
  };
  if (!Object.prototype.hasOwnProperty.call(validators, key) || !validators[key](value)) return false;
  const next = { ...readConfig(), [key]: value };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n');
  return true;
}

async function injectOnce() {
  const port = readPort();
  if (!port) {
    throw new Error(`未找到调试端口文件，Antigravity 可能未运行: ${PORT_FILE}`);
  }
  let pages;
  try {
    pages = await listPages(port);
  } catch {
    throw new Error(`端口 ${port} 无响应：请确认 Antigravity 正在运行`);
  }
  if (pages.length === 0) throw new Error('未找到 Antigravity 窗口页面');

  log(`[+] 调试端口 ${port}，发现 ${pages.length} 个窗口`);
  const expr = buildInjectExpression();
  for (const page of pages) {
    const session = await CdpSession.connect(page.webSocketDebuggerUrl);
    try {
      const res = await session.evaluate(expr);
      log(`[✓] ${shortTitle(page)} (agy-claude-style ${res.version} · 状态: ${res.status})`);
    } finally {
      session.close();
    }
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
    if (pid && pid !== process.pid && isAlive(pid)) {
      console.error(`[!] 守护进程已在运行 (PID ${pid})。如需重启请先运行 remove.bat`);
      process.exit(1);
    }
  } catch {}
  fs.writeFileSync(PID_FILE, String(process.pid));
  const release = () => {
    try {
      if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) {
        fs.unlinkSync(PID_FILE);
      }
    } catch {}
  };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
    process.on(sig, () => process.exit(0));
  }
}

async function watch() {
  acquireLock();
  try {
    fs.writeFileSync(LOG_FILE, '');
  } catch {}
  log(`[*] AGY Claude Style (agy-claude-style) 守护模式启动 (PID ${process.pid})，每 2 秒检查一次窗口`);

  const attached = new Map();
  let expr = buildInjectExpression();

  async function apply(entry) {
    if (entry.scriptId) {
      await entry.session
        .send('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.scriptId })
        .catch(() => {});
    }
    const { identifier } = await entry.session.send('Page.addScriptToEvaluateOnNewDocument', {
      source: expr,
    });
    entry.scriptId = identifier;
    return await entry.session.evaluate(expr);
  }

  async function attach(page) {
    attached.set(page.id, null);
    try {
      const session = await CdpSession.connect(page.webSocketDebuggerUrl);
      const entry = { session, scriptId: null };
      attached.set(page.id, entry);
      session.onClose = () => {
        attached.delete(page.id);
        log(`[-] 窗口已关闭: ${shortTitle(page)}`);
      };
      await session.send('Page.enable');
      session.on('Runtime.bindingCalled', ({ name, payload }) => {
        if (name !== SETTING_BINDING) return;
        try {
          const { key, value } = JSON.parse(payload);
          if (updateConfigSetting(key, value)) {
            log(`[⚙] 设置已保存: ${key} = ${JSON.stringify(value)}`);
          }
        } catch {}
      });
      await session.send('Runtime.enable');
      await session.send('Runtime.addBinding', { name: SETTING_BINDING });
      const res = await apply(entry);
      log(`[✓] 已注入 agy-claude-style: ${shortTitle(page)} (${res.status})`);
    } catch (err) {
      const entry = attached.get(page.id);
      if (entry) entry.session.close();
      attached.delete(page.id);
      log(`[!] 注入失败，稍后重试: ${shortTitle(page)} — ${err.message}`);
    }
  }

  let busy = false;
  let lastPort = null;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const port = readPort();
      if (!port) return;
      let pages;
      try {
        pages = await listPages(port);
      } catch {
        return;
      }
      if (port !== lastPort) {
        log(`[+] 连接到调试端口 ${port}`);
        lastPort = port;
      }
      await Promise.all(pages.filter((p) => !attached.has(p.id)).map(attach));
    } finally {
      busy = false;
    }
  }

  let reloadTimer = null;
  fs.watch(__dirname, (_, filename) => {
    if (!filename || !/\.(css|js|json)$/i.test(filename) || filename.startsWith('.')) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      try {
        delete require.cache[require.resolve('./cdp')];
        const freshCdp = require('./cdp');
        expr = freshCdp.buildInjectExpression();
      } catch (err) {
        log(`[!] 读取文件失败: ${err.message}`);
        return;
      }
      let n = 0;
      for (const entry of attached.values()) {
        if (!entry) continue;
        try {
          await apply(entry);
          n++;
        } catch {}
      }
      log(`[↻] ${filename} 已变更，已热更新 ${n} 个窗口`);
    }, 180);
  });

  if (WATCH) {
    process.on('uncaughtException', (err) => {
      log(`[!] 未捕获异常: ${err && err.stack ? err.stack : err}`);
    });
    process.on('unhandledRejection', (err) => {
      log(`[!] 未处理 Promise 拒绝: ${err && err.stack ? err.stack : err}`);
    });
  }

  await tick();
  setInterval(tick, 2000);
}

(WATCH ? watch() : injectOnce()).catch((err) => {
  console.error(`[✗] ${err.message}`);
  process.exit(1);
});
