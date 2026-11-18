// Chrome DevTools Protocol (CDP) helpers for AGY Claude Style (agy-claude-style).
// Node >= 22: uses built-in fetch and WebSocket (zero external dependencies).
const fs = require('fs');
const os = require('os');
const path = require('path');

const STYLE_ID = 'ag-claude-style-css';
const PLUGIN_VERSION = '1.2.1';
const SETTING_BINDING = '__agClaudeStyleSetting';
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

const APP_DATA = IS_MAC
  ? path.join(os.homedir(), 'Library', 'Application Support')
  : IS_WIN
  ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');

const PORT_FILE = path.join(APP_DATA, 'Antigravity', 'DevToolsActivePort');
const PID_FILE = path.join(__dirname, '.watch.pid');
const CONFIG_FILE = path.join(__dirname, 'config.json');

const DEFAULT_CONFIG = {
  language: 'zh-CN',
  palette: 'obsidian',
  homeLayout: 'studio',
  homeRipple: true,
  composerRestyle: true,
  mascot: 'crab',
  logoInk: 'accent',
  inlineStats: true,
  ringMode: 'both',
  turnBadges: true,
  hudTopBar: false,
  hudBottomBar: false,
  hudRimProgress: false,
  hudFooterChip: false,
  hudCompact: false,
  effortSliderStyle: 'claude',
  effortAccent: true,
  performanceBackdrop: 'card',
  smoothCaret: true,
  sidebarRestyle: true,
  sidebarCompact: false,
  placeholderStyle: 'studio',
  rewindPanel: true,
  undoConfirmMode: 'picker',
  pollIntervalMs: 2500,
};

function readConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function readPort() {
  if (process.env.AG_CDP_PORT) return parseInt(process.env.AG_CDP_PORT, 10);
  try {
    const text = fs.readFileSync(PORT_FILE, 'utf8');
    const port = parseInt(text.split(/\r?\n/)[0].trim(), 10);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

async function listPages(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(2000),
  });
  const targets = await res.json();
  return targets.filter(
    (t) =>
      t.type === 'page' &&
      t.webSocketDebuggerUrl &&
      !t.url.startsWith('devtools://') &&
      !t.url.startsWith('data:')
  );
}

class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.onClose = null;
    this.listeners = new Map();
    ws.addEventListener('message', (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }
      if (msg.method) {
        for (const cb of this.listeners.get(msg.method) || []) cb(msg.params);
        return;
      }
      const p = msg.id && this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('CDP connection closed'));
      }
      this.pending.clear();
      if (this.onClose) this.onClose();
    });
  }

  static connect(wsUrl, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('CDP connect timeout'));
      }, timeoutMs);
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve(new CdpSession(ws));
        },
        { once: true }
      );
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('CDP connect failed'));
        },
        { once: true }
      );
    });
  }

  send(method, params = {}, timeoutMs = 5000) {
    if (this.closed) return Promise.reject(new Error('CDP connection closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timeout`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, callback) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(callback);
  }

  async evaluate(expression, awaitPromise = false) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    }
    return res.result.value;
  }

  close() {
    if (!this.closed) this.ws.close();
  }
}

function readCss() {
  return fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
}

const RUNTIME_PARTS = ['i18n-locales.js', 'i18n-core.js', 'usage-core.js', 'ripple-core.js', 'mascot-core.js', 'crab-assets.js', 'effort-core.js', 'perf-assets.js', 'custom-themes.js', 'ui-rewind.js', 'ui-runtime.js'];

function readRuntimeBundle() {
  return RUNTIME_PARTS.map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
}

function computeHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function buildInjectExpression(customConfig) {
  const config = customConfig || readConfig();
  const css = readCss();
  const bundle = readRuntimeBundle();
  const codeHash = computeHash(bundle);
  return `(() => {
    const css = ${JSON.stringify(css)};
    const applyStyle = () => {
      const targetParent = document.head || document.documentElement;
      if (!targetParent) return;
      let style = document.getElementById(${JSON.stringify(STYLE_ID)});
      if (!style) {
        style = document.createElement('style');
        style.id = ${JSON.stringify(STYLE_ID)};
      }
      if (style.textContent !== css) style.textContent = css;
      if (style.parentNode !== targetParent || targetParent.lastElementChild !== style) {
        targetParent.appendChild(style);
      }
    };

    let status = 'ok';
    let mounted = false;
    const mount = () => {
      if (mounted || !document.documentElement) return;
      mounted = true;
      try {
        if (document.head) applyStyle();
        else document.addEventListener('DOMContentLoaded', applyStyle, { once: true });
        ${bundle}
        if (typeof globalThis.__agCsUiMain === 'function') {
          globalThis.__agCsUiMain(${JSON.stringify({ ...config, binding: SETTING_BINDING, codeHash })});
        }
      } catch (e) {
        status = 'error: ' + (e && e.message ? e.message : String(e));
        if (typeof console !== 'undefined' && console.error) {
          console.error('[agy-claude-style] init error:', e);
        }
      }
    };

    if (document.documentElement) {
      mount();
    } else {
      status = 'deferred';
      const onReady = () => {
        if (document.documentElement) {
          document.removeEventListener('readystatechange', onReady);
          document.removeEventListener('DOMContentLoaded', onReady);
          mount();
        }
      };
      document.addEventListener('readystatechange', onReady);
      document.addEventListener('DOMContentLoaded', onReady);
    }
    const st = window.__agClaudeStyle && window.__agClaudeStyle.getState ? window.__agClaudeStyle.getState() : null;
    return {
      version: ${JSON.stringify(PLUGIN_VERSION)},
      status,
      state: st,
    };
  })()`;
}

const REMOVE_EXPRESSION = `(() => {
  if (Array.isArray(globalThis.__agCsCleanups)) {
    while (globalThis.__agCsCleanups.length) {
      const fn = globalThis.__agCsCleanups.pop();
      try {
        if (typeof fn === 'function') fn();
      } catch (e) {}
    }
  }
  delete globalThis.__agCsCleanups;
  try {
    if (window.__agClaudeStyle && typeof window.__agClaudeStyle.destroy === 'function') {
      window.__agClaudeStyle.destroy();
    }
  } catch (e) {}
  if (window.__agCsI18n && typeof window.__agCsI18n.destroy === 'function') {
    window.__agCsI18n.destroy();
  }
  delete window.__agClaudeStyle;
  delete window.__agCsI18n;
  delete globalThis.__agCsUiMain;
  delete globalThis.__agCsCrabAssets;
  delete globalThis.__agCsMascotCore;
  delete globalThis.__agCsRippleCore;
  delete globalThis.__agCsUsageCore;
  delete globalThis.__agCsEffortCore;
  delete globalThis.__agCsPerfAssets;
  delete globalThis.__agCsCustomThemes;
  delete globalThis.__agCsI18nCore;
  delete globalThis.__agCsLocales;
  delete globalThis.__agCsFeatures;
  const root = document.documentElement;
  if (root) {
    root.removeAttribute('data-ag-cs-effort-accent');
    root.removeAttribute('data-ag-cs-perf-backdrop');
    root.removeAttribute('data-ag-cs-lang');
    root.removeAttribute('data-ag-cs-cjk');
    root.removeAttribute('data-ag-custom-theme');
    root.removeAttribute('data-aux-pane-maximized');
    if (root.style && typeof root.style.removeProperty === 'function') {
      root.style.removeProperty('--antigravity-active-theme-id');
    }
    if (root.getAttribute('data-ag-cjk') === '1') root.removeAttribute('data-ag-cjk');
  }
  const nodes = document.querySelectorAll(
    'style#${STYLE_ID}, style#ag-cs-aurora-theme-css, style#ag-token-hud-style, .ag-cs-home-panel-seat, .ag-cs-ripple-host, .ag-cs-ripple-canvas, .ag-cs-crab, .ag-cs-inline-stats, .ag-cs-quota-ring, .ag-cs-context-ring, .ag-cs-ctx-popover, .ag-cs-effort-popover, .ag-cs-perf-backdrop, .ag-cs-smooth-caret, .ag-cs-turn-bar, .ag-cs-hud-top-bar, .ag-cs-hud-bottom-bar, .ag-cs-hud-rim-progress, .ag-cs-hud-footer-chip, .ag-cs-rewind-bar, .ag-cs-rewind-notice, .ag-cs-rewind-backdrop, #ag-cs-settings-sec, #ag-cs-theme-selector, #ag-cs-theme-dropdown, .ag-th-top-bar, .ag-th-bottom-bar, .ag-th-rim-progress, .ag-th-footer-chip, .ag-th-popover, .ag-th-turn-bar, .ag-th-reopen-pill'
  );
  nodes.forEach((n) => n.remove());
  return { removed: nodes.length };
})()`;

module.exports = {
  STYLE_ID,
  PLUGIN_VERSION,
  SETTING_BINDING,
  RUNTIME_PARTS,
  PORT_FILE,
  PID_FILE,
  CONFIG_FILE,
  DEFAULT_CONFIG,
  readConfig,
  readPort,
  listPages,
  CdpSession,
  readCss,
  readRuntimeBundle,
  buildInjectExpression,
  REMOVE_EXPRESSION,
};
