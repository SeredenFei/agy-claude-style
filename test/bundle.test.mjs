import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cdp = require('../cdp.js');

test('buildInjectExpression and REMOVE_EXPRESSION compile cleanly as valid JS', () => {
  const injectExpr = cdp.buildInjectExpression();
  const removeExpr = cdp.REMOVE_EXPRESSION;
  assert.doesNotThrow(() => new vm.Script(injectExpr));
  assert.doesNotThrow(() => new vm.Script(removeExpr));
  assert.ok(injectExpr.includes('ag-claude-style-css'));
  assert.ok(injectExpr.includes('ag-cs-home-panel'));
  assert.ok(removeExpr.includes('window.__agClaudeStyle.destroy'));
});

test('inject expression mounts and REMOVE_EXPRESSION cleanly tears down on simulated Antigravity DOM', async () => {
  function makeNode(tag, opts = {}) {
    const attrs = new Map(Object.entries(opts.attrs || {}));
    const listeners = new Map();
    const children = [];
    const classes = new Set((opts.className || '').split(/\s+/).filter(Boolean));
    const node = {
      tagName: tag.toUpperCase(),
      id: opts.id || '',
      style: {
        _props: {},
        setProperty(k, v) { this._props[k] = String(v); },
        getPropertyValue(k) { return this._props[k] || ''; },
        removeProperty(k) { delete this._props[k]; },
      },
      classList: {
        contains: (c) => classes.has(c),
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
      },
      get className() { return Array.from(classes).join(' '); },
      set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
      children,
      parentElement: null,
      parentNode: null,
      isConnected: true,
      _text: opts.text || '',
      get textContent() {
        return children.length ? children.map((c) => c.textContent).join('') : this._text;
      },
      set textContent(v) {
        children.length = 0;
        this._text = String(v);
      },
      set innerHTML(html) {
        children.length = 0;
        this._html = html;
      },
      get innerHTML() { return this._html || ''; },
      get childElementCount() { return children.length; },
      get firstChild() { return children[0] || null; },
      get nextSibling() {
        if (!this.parentElement) return null;
        const idx = this.parentElement.children.indexOf(this);
        return idx >= 0 ? this.parentElement.children[idx + 1] || null : null;
      },
      get lastElementChild() { return children[children.length - 1] || null; },
      clientWidth: opts.clientWidth ?? 900,
      clientHeight: opts.clientHeight ?? 700,
      width: 0,
      height: 0,
      appendChild(ch) {
        ch.parentElement = this;
        ch.parentNode = this;
        children.push(ch);
        return ch;
      },
      insertBefore(ch, ref) {
        ch.parentElement = this;
        ch.parentNode = this;
        const idx = ref ? children.indexOf(ref) : -1;
        if (idx >= 0) children.splice(idx, 0, ch);
        else children.push(ch);
        return ch;
      },
      removeChild(ch) {
        const idx = children.indexOf(ch);
        if (idx >= 0) children.splice(idx, 1);
        ch.parentElement = null;
        ch.parentNode = null;
        return ch;
      },
      remove() {
        if (this.parentElement) this.parentElement.removeChild(this);
      },
      setAttribute(k, v) {
        attrs.set(k, String(v));
        if (k === 'id') this.id = String(v);
      },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      hasAttribute(k) { return attrs.has(k); },
      removeAttribute(k) { attrs.delete(k); },
      toggleAttribute(k, force) {
        const on = force === undefined ? !attrs.has(k) : Boolean(force);
        if (on) attrs.set(k, ''); else attrs.delete(k);
        return on;
      },
      addEventListener(ev, cb) {
        if (!listeners.has(ev)) listeners.set(ev, []);
        listeners.get(ev).push(cb);
      },
      removeEventListener(ev, cb) {
        const arr = listeners.get(ev);
        if (!arr) return;
        const idx = arr.indexOf(cb);
        if (idx >= 0) arr.splice(idx, 1);
      },
      dispatch(ev, payload = {}) {
        const list = listeners.get(ev) || [];
        for (const fn of [...list]) fn({ type: ev, stopPropagation() {}, preventDefault() {}, ...payload });
      },
      getContext() { return null; },
      getBoundingClientRect() { return { left: 0, top: 0, right: 480, bottom: 300, width: 480, height: 300 }; },
      animate() { return { cancel() {}, finished: Promise.resolve() }; },
      closest(sel) {
        let cur = this;
        while (cur) {
          if (matches(cur, sel)) return cur;
          cur = cur.parentElement;
        }
        return null;
      },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) {
        const out = [];
        const walk = (n) => {
          for (const c of n.children) {
            if (matches(c, sel)) out.push(c);
            walk(c);
          }
        };
        walk(this);
        return out;
      },
    };
    return node;
  }

  function matchesSimple(node, simple) {
    let rest = simple.trim();
    if (!rest) return false;
    const tagMatch = /^[a-zA-Z0-9_-]+/.exec(rest);
    if (tagMatch) {
      if (node.tagName !== tagMatch[0].toUpperCase()) return false;
      rest = rest.slice(tagMatch[0].length);
    }
    while (rest.length > 0) {
      if (rest[0] === '#') {
        const m = /^#([a-zA-Z0-9_-]+)/.exec(rest);
        if (!m || node.id !== m[1]) return false;
        rest = rest.slice(m[0].length);
      } else if (rest[0] === '.') {
        const m = /^\.([a-zA-Z0-9_-]+)/.exec(rest);
        if (!m || !node.classList.contains(m[1])) return false;
        rest = rest.slice(m[0].length);
      } else if (rest[0] === '[') {
        const m = /^\[([^\]=]+)(?:="([^"]*)")?\]/.exec(rest);
        if (!m) return false;
        const ok = m[2] === undefined ? node.hasAttribute(m[1]) : node.getAttribute(m[1]) === m[2];
        if (!ok) return false;
        rest = rest.slice(m[0].length);
      } else {
        return false;
      }
    }
    return true;
  }

  function matches(node, selector) {
    return selector.split(',').some((part) => {
      const tokens = part.trim().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) return false;
      if (!matchesSimple(node, tokens[tokens.length - 1])) return false;
      let cur = node.parentElement;
      let idx = tokens.length - 2;
      while (cur && idx >= 0) {
        if (matchesSimple(cur, tokens[idx])) idx--;
        cur = cur.parentElement;
      }
      return idx < 0;
    });
  }

  const html = makeNode('html');
  const head = makeNode('head');
  const body = makeNode('body', { className: 'theme-dark' });
  html.appendChild(head);
  html.appendChild(body);

  // Build simulated Antigravity top-right pane toolbar + Home DOM
  const paneToolbar = makeNode('div', { attrs: { 'data-testid': 'pane-titlebar-toolbar' } });
  const existingToolbarBtn = makeNode('button', { text: 'Split' });
  paneToolbar.appendChild(existingToolbarBtn);
  body.appendChild(paneToolbar);

  const home = makeNode('div', { className: 'agy-home' });
  const scrollWrap = makeNode('div');
  const scrollCol = makeNode('div');
  const greeting = makeNode('div', { attrs: { 'data-testid': 'home-greeting' } });
  const h1 = makeNode('h1', { className: 'home-greeting-title', text: 'Welcome back, girl. Where should we pick up?' });
  greeting.appendChild(h1);
  scrollCol.appendChild(greeting);
  scrollWrap.appendChild(scrollCol);
  home.appendChild(scrollWrap);

  const inputBox = makeNode('div', { id: 'antigravity.agentSidePanelInputBox', attrs: { 'data-testid': 'agent-input-box' } });
  const queuedWrap = makeNode('div', { className: 'relative z-[1] flex flex-col gap-2 w-full hidden-if-empty mb-2' });
  const queuedCard = makeNode('div', { text: '排队中的消息 1 · 智能体完成后发送' });
  queuedWrap.appendChild(queuedCard);
  inputBox.appendChild(queuedWrap);
  const composerShell = makeNode('div', { id: 'antigravity.agentSidePanelInputBox', className: 'surface-composer' });
  const card = makeNode('div', { className: 'surface-composer-card' });
  const editorWrap = makeNode('div', { className: 'relative w-full' });
  const placeholder = makeNode('p', { className: 'pointer-events-none', text: '有问题尽管问' });
  const editorEl = makeNode('div', { attrs: { contenteditable: 'true', 'data-lexical-editor': 'true' } });
  editorWrap.appendChild(placeholder);
  editorWrap.appendChild(editorEl);
  const footer = makeNode('div', { className: 'agy-composer-footer' });
  const modelBtn = makeNode('button', { attrs: { 'data-testid': 'model-selector-trigger' } });
  const modelSpan = makeNode('span', { text: 'Gemini 4 Argon' });
  const effortSpan = makeNode('span', { className: 'opacity-70', text: ' Low' });
  modelSpan.appendChild(effortSpan);
  modelBtn.appendChild(modelSpan);
  footer.appendChild(modelBtn);
  card.appendChild(editorWrap);
  card.appendChild(footer);
  composerShell.appendChild(card);
  inputBox.appendChild(composerShell);
  home.appendChild(inputBox);
  body.appendChild(home);

  // Simulated Settings dialog containing General BEFORE Appearance
  const dialog = makeNode('div', { attrs: { role: 'dialog' } });
  const generalPanel = makeNode('div', { className: 'p-6 flex flex-col gap-4' });
  const generalH2 = makeNode('h2', { text: '常规' });
  const generalSec = makeNode('div', { className: 'space-y-2' });
  generalPanel.appendChild(generalH2);
  generalPanel.appendChild(generalSec);
  const appearancePanel = makeNode('div', { className: 'p-6 flex flex-col gap-4' });
  const appearanceH2 = makeNode('h2', { text: '外观' });
  const appearanceWrap = makeNode('div', { className: 'flex flex-col gap-8' });
  const appearanceSec = makeNode('div', { className: 'space-y-2' });
  appearanceWrap.appendChild(appearanceSec);
  appearancePanel.appendChild(appearanceH2);
  appearancePanel.appendChild(appearanceWrap);
  dialog.appendChild(generalPanel);
  dialog.appendChild(appearancePanel);
  body.appendChild(dialog);

  const doc = {
    documentElement: html,
    head,
    body,
    hidden: false,
    createElement: (t) => makeNode(t),
    getElementById: (id) => html.querySelector('#' + id),
    querySelector: (s) => html.querySelector(s),
    querySelectorAll: (s) => html.querySelectorAll(s),
    addEventListener() {},
    removeEventListener() {},
  };

  const timers = new Set();
  const sandbox = {
    window: null,
    globalThis: null,
    document: doc,
    navigator: { language: 'zh-CN' },
    location: { pathname: '/' },
    localStorage: { _m: {}, getItem(k) { return this._m[k] || null; }, setItem(k, v) { this._m[k] = String(v); } },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false }),
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); timers.add(id); return id; },
    clearTimeout: (id) => { timers.delete(id); clearTimeout(id); },
    setInterval: () => 1,
    clearInterval: () => {},
    performance: { now: () => Date.now() },
    Math,
    Date,
    JSON,
    Map,
    Set,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Promise,
    Uint8Array,
    Float32Array,
    Intl,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  try {
    const res = vm.runInNewContext(cdp.buildInjectExpression(cdp.DEFAULT_CONFIG), sandbox);
    assert.equal(res.status, 'ok');
    assert.equal(html.getAttribute('data-ag-cs-style'), '1');
    assert.equal(html.getAttribute('data-ag-cs-palette'), 'obsidian');
    assert.equal(html.getAttribute('data-ag-cs-home'), 'studio');
    assert.equal(h1.textContent, "What's up next?");
    assert.equal(placeholder.getAttribute('data-ag-cs-placeholder'), '描述任务或提出问题');
    assert.equal(effortSpan.getAttribute('data-ag-cs-effort'), 'low');
    assert.equal(effortSpan.classList.contains('ag-cs-effort-badge'), true);
    assert.ok(head.querySelector('#ag-claude-style-css'));
    assert.ok(home.querySelector('.ag-cs-home-panel'));
    assert.ok(home.querySelector('.ag-cs-ripple-host'));
    assert.ok(home.querySelector('.ag-cs-ripple-canvas'));
    assert.ok(card.querySelector('.ag-cs-crab'));

    // Queued message container before composer shell gets raised by 46px when Clawd crab is active
    assert.equal(queuedWrap.getAttribute('data-ag-cs-queued'), '1');
    assert.equal(queuedWrap.style.getPropertyValue('margin-bottom'), '46px');

    const injectedCss = head.querySelector('#ag-claude-style-css')?.textContent || '';
    assert.ok(injectedCss.includes('width: 264px'));
    assert.ok(injectedCss.includes('margin-bottom: 46px !important'));
    assert.ok(injectedCss.includes('z-index: 12 !important'));
    assert.ok(injectedCss.includes('[data-effort-theme="light"]'));

    // Smooth typing caret overlay is mounted on editor host
    assert.equal(editorWrap.getAttribute('data-ag-cs-caret-host'), '1');
    assert.ok(editorWrap.querySelector('.ag-cs-smooth-caret'));

    // Interactive Thinking Effort Slider Popover (Claude Code & ChatGPT Performance Styles — NO inline style switch)
    assert.equal(sandbox.globalThis.__agCsPerfAssets.FRAME_COUNT, 31);
    assert.ok(sandbox.globalThis.__agCsPerfAssets.frames.every((u) => u.startsWith('data:image/webp;base64,')));

    sandbox.window.__agClaudeStyle.openEffortPopover(effortSpan, modelBtn);
    const effortPop = body.querySelector('.ag-cs-effort-popover');
    assert.ok(effortPop);
    assert.equal(effortPop.getAttribute('data-effort-style'), 'claude');
    assert.equal(effortPop.getAttribute('data-effort-theme'), 'dark');
    assert.equal(effortPop.getAttribute('data-perf-theme'), 'dark');
    assert.ok(effortPop.innerHTML.includes('ag-cs-effort-matrix'));
    assert.ok(effortPop.innerHTML.includes('ag-cs-effort-knob'));
    assert.ok(effortPop.innerHTML.includes('ag-cs-effort-value-slot'));
    assert.equal(effortPop.innerHTML.includes('ag-cs-effort-style-switch'), false);

    // Light theme (even under obsidian/claude palettes) must update popover theme attributes to "light"
    body.className = 'theme-light';
    doc.hidden = true;
    sandbox.window.__agClaudeStyle.refreshConfig({ ...cdp.DEFAULT_CONFIG, palette: 'obsidian' });
    await new Promise((r) => setTimeout(r, 80));
    doc.hidden = false;
    assert.equal(effortPop.getAttribute('data-effort-theme'), 'light');
    assert.equal(effortPop.getAttribute('data-perf-theme'), 'light');
    body.className = 'theme-dark';

    // Switch Effort Slider to ChatGPT (Codex) style via settings refresh
    doc.hidden = true;
    sandbox.window.__agClaudeStyle.refreshConfig({
      ...cdp.DEFAULT_CONFIG,
      effortSliderStyle: 'chatgpt',
      performanceBackdrop: 'page',
    });
    await new Promise((r) => setTimeout(r, 80));
    doc.hidden = false;
    sandbox.window.__agClaudeStyle.openEffortPopover(effortSpan, modelBtn); // closes first
    sandbox.window.__agClaudeStyle.openEffortPopover(effortSpan, modelBtn); // reopens in chatgpt (Codex) style
    const codexPop = body.querySelector('.ag-cs-effort-popover');
    assert.ok(codexPop);
    assert.equal(codexPop.getAttribute('data-effort-style'), 'chatgpt');
    assert.equal(codexPop.getAttribute('data-effort-theme'), 'dark');
    assert.ok(codexPop.innerHTML.includes('ag-cs-codex-track'));
    assert.ok(codexPop.innerHTML.includes('ag-cs-codex-fill'));
    assert.ok(codexPop.innerHTML.includes('ag-cs-codex-energy'));
    assert.ok(codexPop.innerHTML.includes('ag-cs-codex-stars'));
    assert.equal((codexPop.innerHTML.match(/class="ag-cs-codex-star"/g) || []).length, 22);
    assert.ok(codexPop.innerHTML.includes('ag-cs-codex-knob'));
    assert.equal(body.querySelector('.ag-cs-perf-backdrop'), null);

    // Switch Effort Slider to Liang Wufeng (31-frame performance portrait) + page backdrop
    doc.hidden = true;
    sandbox.window.__agClaudeStyle.refreshConfig({
      ...cdp.DEFAULT_CONFIG,
      effortSliderStyle: 'liangwufeng',
      performanceBackdrop: 'page',
    });
    await new Promise((r) => setTimeout(r, 80));
    doc.hidden = false;
    sandbox.window.__agClaudeStyle.openEffortPopover(effortSpan, modelBtn); // closes Codex
    sandbox.window.__agClaudeStyle.openEffortPopover(effortSpan, modelBtn); // reopens in liangwufeng style
    const lwfPop = body.querySelector('.ag-cs-effort-popover');
    assert.ok(lwfPop);
    assert.equal(lwfPop.getAttribute('data-effort-style'), 'liangwufeng');
    assert.equal(lwfPop.getAttribute('data-effort-theme'), 'dark');
    assert.ok(lwfPop.innerHTML.includes('ag-cs-chatgpt-rail'));
    assert.ok(lwfPop.innerHTML.includes('ag-cs-perf-bar'));
    assert.ok(lwfPop.innerHTML.includes('ag-cs-perf-thumb'));
    assert.ok(lwfPop.innerHTML.includes('ag-cs-perf-ticks'));
    assert.equal(lwfPop.innerHTML.includes('ag-cs-perf-status'), false);
    assert.equal(lwfPop.innerHTML.includes('ag-cs-effort-style-switch'), false);
    assert.ok(body.querySelector('.ag-cs-perf-backdrop'));

    // Context HUD popover opens cleanly with NO embedded settings controls, concise tab names, and clamps maxHeight on short viewports
    sandbox.window.innerHeight = 650;
    const origAnchorRect = modelBtn.getBoundingClientRect;
    modelBtn.getBoundingClientRect = () => ({ left: 260, top: 560, right: 390, bottom: 584, width: 130, height: 24 });
    sandbox.window.__agClaudeStyle.openContextPopover(modelBtn, 'quotas');
    const ctxPop = body.querySelector('.ag-cs-ctx-popover');
    assert.ok(ctxPop);
    assert.equal(ctxPop.style.maxHeight, '544px');
    assert.ok(parseInt(ctxPop.style.top, 10) + 300 <= 560);
    modelBtn.getBoundingClientRect = origAnchorRect;
    sandbox.window.innerHeight = 900;
    assert.ok(ctxPop.innerHTML.includes('模型配额'));
    assert.ok(ctxPop.innerHTML.includes('工具/代理 (0)'));
    assert.equal(ctxPop.innerHTML.includes('ag-cs-ctx-settings-list'), false);
    assert.equal(ctxPop.innerHTML.includes('Token HUD 与圆环快捷设置'), false);
    assert.equal(ctxPop.innerHTML.includes('data-hud-key'), false);

    // Settings section must mount ONLY in Appearance, NOT General, grouped cleanly into 3 cards + collapsible HUD details
    assert.equal(generalPanel.querySelector('#ag-cs-settings-sec'), null);
    const settingsSec = appearancePanel.querySelector('#ag-cs-settings-sec');
    assert.ok(settingsSec);
    assert.equal(settingsSec.querySelector('h3')?.textContent, 'AGY Claude Style (agy-claude-style)');
    const settingGroups = settingsSec.querySelectorAll('.ag-cs-settings-group');
    assert.equal(settingGroups.length, 3);
    assert.deepEqual(
      settingGroups.map((g) => g.getAttribute('data-ag-cs-group')),
      ['appearance', 'interaction', 'telemetry']
    );
    const hudDetails = settingsSec.querySelector('.ag-cs-settings-details');
    assert.ok(hudDetails);
    assert.equal(hudDetails.hasAttribute('open'), false);
    const claudeCondRow = settingsSec.querySelector('[data-ag-cs-cond="claude"]');
    const lwfCondRow = settingsSec.querySelector('[data-ag-cs-cond="liangwufeng"]');
    assert.equal(claudeCondRow?.getAttribute('data-ag-cs-dim'), '1'); // because liangwufeng is currently active
    assert.equal(lwfCondRow?.hasAttribute('data-ag-cs-dim'), false);

    const settingKeys = new Set(
      appearancePanel.querySelectorAll('#ag-cs-settings-sec button').map((b) => b.getAttribute('data-ag-cs-key'))
    );
    assert.equal(settingKeys.size, 22);
    for (const expectedKey of [
      'language',
      'homeLayout',
      'palette',
      'logoInk',
      'sidebarRestyle',
      'composerRestyle',
      'effortSliderStyle',
      'effortAccent',
      'performanceBackdrop',
      'smoothCaret',
      'mascot',
      'homeRipple',
      'rewindPanel',
      'undoConfirmMode',
      'inlineStats',
      'ringMode',
      'turnBadges',
      'hudTopBar',
      'hudBottomBar',
      'hudRimProgress',
      'hudFooterChip',
      'hudCompact',
    ]) {
      assert.ok(settingKeys.has(expectedKey), `Missing settings control for ${expectedKey}`);
    }

    // Verify all 5 language buttons exist in Appearance settings and clicking switches UI + emits CDP binding
    const bindingCalls = [];
    sandbox[cdp.SETTING_BINDING] = (payload) => bindingCalls.push(JSON.parse(payload));
    const getLangBtns = () =>
      appearancePanel
        .querySelectorAll('#ag-cs-settings-sec button')
        .filter((b) => b.getAttribute('data-ag-cs-key') === 'language');
    assert.deepEqual(
      getLangBtns().map((b) => [b.getAttribute('data-ag-cs-val'), b.textContent]),
      [
        ['"zh-CN"', '简体中文'],
        ['"zh-TW"', '繁體中文'],
        ['"yue"', '粵語'],
        ['"en"', 'English'],
        ['"ja"', '日本語'],
      ]
    );

    const checkLangSwitch = (targetLang, hostTitle, expectedSettingsLangTitle, expectedOverviewTab, expectedPlaceholder, expectedQuotaTab) => {
      appearanceH2.textContent = hostTitle;
      const btn = getLangBtns().find((b) => b.getAttribute('data-ag-cs-val') === JSON.stringify(targetLang));
      assert.ok(btn, `Expected language button for ${targetLang}`);
      btn.dispatch('click');
      assert.equal(html.getAttribute('data-ag-cs-lang'), targetLang);
      const secNow = appearancePanel.querySelector('#ag-cs-settings-sec');
      assert.ok(secNow, `Settings section should stay mounted when Appearance title is ${hostTitle}`);
      assert.equal(secNow.getAttribute('data-ag-cs-lang'), targetLang);
      assert.equal(secNow.querySelector('[data-ag-cs-row="language"] [data-k="t"]')?.textContent, expectedSettingsLangTitle);
      assert.equal(home.querySelector('.ag-cs-home-tab[data-tab="overview"]')?.textContent, expectedOverviewTab);
      assert.equal(placeholder.getAttribute('data-ag-cs-placeholder'), expectedPlaceholder);
      assert.ok(ctxPop.innerHTML.includes(expectedQuotaTab));
    };

    checkLangSwitch('zh-TW', '外觀', '介面語言', '概覽', '描述任務或提出問題', '模型配額');
    checkLangSwitch('yue', '外觀', '介面語言', '概覽', '寫低你想做嘅任務或者問題', '模型配額');
    checkLangSwitch('en', 'Appearance', 'Interface Language', 'Overview', 'How can I help you today?', 'Quotas');
    assert.equal(html.hasAttribute('data-ag-cs-cjk'), false);
    checkLangSwitch('ja', '外観', '表示言語', '概要', 'タスクの説明や質問を入力してください', 'クォータ');
    assert.equal(html.getAttribute('data-ag-cs-cjk'), '1');
    checkLangSwitch('zh-CN', '外观', '界面语言', '概览', '描述任务或提出问题', '模型配额');

    // Also verify live open Effort Popover refreshes across languages
    sandbox.window.__agClaudeStyle.openEffortPopover(effortSpan, modelBtn);
    const activeLwfPop = body.querySelector('.ag-cs-effort-popover');
    assert.ok(activeLwfPop);
    assert.ok(activeLwfPop.innerHTML.includes('性能 · PERFORMANCE'));
    getLangBtns().find((b) => b.getAttribute('data-ag-cs-val') === '"ja"').dispatch('click');
    assert.ok(activeLwfPop.innerHTML.includes('パフォーマンス'));
    getLangBtns().find((b) => b.getAttribute('data-ag-cs-val') === '"en"').dispatch('click');
    assert.ok(activeLwfPop.innerHTML.includes('PERFORMANCE'));
    getLangBtns().find((b) => b.getAttribute('data-ag-cs-val') === '"zh-CN"').dispatch('click');
    assert.ok(activeLwfPop.innerHTML.includes('性能 · PERFORMANCE'));

    assert.deepEqual(
      bindingCalls.map((c) => [c.key, c.value]),
      [
        ['language', 'zh-TW'],
        ['language', 'yue'],
        ['language', 'en'],
        ['language', 'ja'],
        ['language', 'zh-CN'],
        ['language', 'ja'],
        ['language', 'en'],
        ['language', 'zh-CN'],
      ]
    );
    appearanceH2.textContent = '外观';

    // Refreshing config to chatgpt (Codex) dims BOTH claude and liangwufeng sub-rows
    doc.hidden = true;
    sandbox.window.__agClaudeStyle.refreshConfig({ ...cdp.DEFAULT_CONFIG, effortSliderStyle: 'chatgpt' });
    await new Promise((r) => setTimeout(r, 80));
    doc.hidden = false;
    assert.equal(appearancePanel.querySelector('[data-ag-cs-cond="claude"]')?.getAttribute('data-ag-cs-dim'), '1');
    assert.equal(appearancePanel.querySelector('[data-ag-cs-cond="liangwufeng"]')?.getAttribute('data-ag-cs-dim'), '1');

    // Refreshing config externally syncs open Settings buttons & conditional row dimming immediately
    doc.hidden = true;
    sandbox.window.__agClaudeStyle.refreshConfig({ ...cdp.DEFAULT_CONFIG, palette: 'claude' });
    await new Promise((r) => setTimeout(r, 80));
    doc.hidden = false;
    assert.equal(html.getAttribute('data-ag-cs-palette'), 'claude');
    assert.equal(html.getAttribute('data-ag-cs-effort-accent'), 'on');
    assert.equal(html.getAttribute('data-ag-cs-perf-backdrop'), 'card');
    assert.equal(appearancePanel.querySelector('[data-ag-cs-cond="claude"]')?.hasAttribute('data-ag-cs-dim'), false);
    assert.equal(appearancePanel.querySelector('[data-ag-cs-cond="liangwufeng"]')?.getAttribute('data-ag-cs-dim'), '1');
    const claudeBtn = appearancePanel
      .querySelectorAll('#ag-cs-settings-sec button')
      .find((b) => b.getAttribute('data-ag-cs-key') === 'palette' && b.getAttribute('data-ag-cs-val') === '"claude"');
    assert.equal(claudeBtn.getAttribute('aria-pressed'), 'true');
    assert.equal(claudeBtn.hasAttribute('data-pressed'), true);

    // Effort word-boundary guard: "Flow" inside a model label must not be tagged "low"
    effortSpan.textContent = 'Flow';
    doc.hidden = true;
    sandbox.window.__agClaudeStyle.refreshConfig({ ...cdp.DEFAULT_CONFIG, palette: 'obsidian' });
    await new Promise((r) => setTimeout(r, 80));
    doc.hidden = false;
    assert.equal(effortSpan.hasAttribute('data-ag-cs-effort'), false);

    // Custom Aurora Themes + Top-Bar Theme Capsule (#ag-cs-theme-selector) + 9 Settings Palettes
    const getPaletteBtns = () =>
      appearancePanel
        .querySelectorAll('#ag-cs-settings-sec button')
        .filter((b) => b.getAttribute('data-ag-cs-key') === 'palette');
    assert.deepEqual(
      getPaletteBtns().map((b) => [b.getAttribute('data-ag-cs-val'), b.querySelector('.ag-cs-palette-label')?.textContent]),
      [
        ['"obsidian"', '深邃蓝黑'],
        ['"claude"', 'Claude'],
        ['"gemini"', '暗夜极光'],
        ['"sky"', '深海晴空'],
        ['"cyan"', '幽谷碧波'],
        ['"orange"', '熔岩暮色'],
        ['"red"', '丝绒酒红'],
        ['"purple"', '幻夜幽紫'],
        ['"host"', '跟随宿主'],
      ]
    );
    assert.ok(getPaletteBtns().every((b) => b.querySelector('.ag-cs-palette-swatch')?.innerHTML.startsWith('<svg')));

    const themeSel = paneToolbar.querySelector('#ag-cs-theme-selector');
    assert.ok(themeSel, 'Top-bar theme capsule should mount inside pane-titlebar-toolbar');
    assert.equal(paneToolbar.firstChild, themeSel);
    const themeBtn = themeSel.querySelector('#ag-cs-theme-btn');
    const themeLabel = themeSel.querySelector('#ag-cs-theme-label');
    assert.ok(themeBtn);
    assert.equal(themeLabel?.textContent, '深邃蓝黑');
    assert.equal(sandbox.window.__agClaudeStyle.getState().hasThemeCapsule, true);

    // Open dropdown from top-bar capsule and select Aurora "gemini"
    bindingCalls.length = 0;
    themeBtn.dispatch('click');
    const themeDd = body.querySelector('#ag-cs-theme-dropdown');
    assert.ok(themeDd, 'Clicking #ag-cs-theme-btn should open #ag-cs-theme-dropdown');
    assert.equal(themeBtn.getAttribute('aria-expanded'), 'true');
    assert.equal(themeDd.querySelectorAll('.ag-cs-theme-item').length, 9);
    assert.equal(themeDd.querySelectorAll('.ag-cs-theme-divider').length, 2);
    const geminiItem = themeDd.querySelector('[data-ag-cs-palette-item="gemini"]');
    assert.ok(geminiItem);
    assert.equal(geminiItem.querySelector('.ag-cs-theme-item-text')?.textContent, '暗夜极光');
    geminiItem.dispatch('click');

    assert.equal(body.querySelector('#ag-cs-theme-dropdown'), null);
    assert.equal(themeBtn.getAttribute('aria-expanded'), 'false');
    assert.equal(html.getAttribute('data-ag-cs-palette'), 'gemini');
    assert.equal(html.getAttribute('data-ag-custom-theme'), 'true');
    assert.equal(html.style.getPropertyValue('--antigravity-active-theme-id'), 'gemini');
    assert.equal(themeLabel?.textContent, '暗夜极光');
    assert.deepEqual(bindingCalls.map((c) => [c.key, c.value]), [['palette', 'gemini']]);
    const auroraStyleDark = head.querySelector('#ag-cs-aurora-theme-css');
    assert.ok(auroraStyleDark);
    assert.equal(auroraStyleDark.getAttribute('data-theme-key'), 'gemini:dark');
    assert.ok(auroraStyleDark.textContent.includes('--ag-mesh:'));
    const geminiSettingsBtn = getPaletteBtns().find((b) => b.getAttribute('data-ag-cs-val') === '"gemini"');
    assert.equal(geminiSettingsBtn?.getAttribute('aria-pressed'), 'true');

    // Flipping host theme to Light dynamically switches Aurora CSS + capsule & Settings labels to Light names
    body.className = 'theme-light';
    doc.hidden = true;
    sandbox.window.__agClaudeStyle.refreshConfig({ ...cdp.DEFAULT_CONFIG, palette: 'gemini' });
    await new Promise((r) => setTimeout(r, 80));
    doc.hidden = false;
    assert.equal(head.querySelector('#ag-cs-aurora-theme-css')?.getAttribute('data-theme-key'), 'gemini:light');
    assert.equal(themeSel.querySelector('#ag-cs-theme-label')?.textContent, '四色极光');
    assert.equal(
      getPaletteBtns().find((b) => b.getAttribute('data-ag-cs-val') === '"gemini"')?.querySelector('.ag-cs-palette-label')?.textContent,
      '四色极光'
    );

    // Switching back to non-Aurora palette cleans up Aurora style & root attributes
    body.className = 'theme-dark';
    getPaletteBtns().find((b) => b.getAttribute('data-ag-cs-val') === '"obsidian"')?.dispatch('click');
    assert.equal(html.getAttribute('data-ag-cs-palette'), 'obsidian');
    assert.equal(html.hasAttribute('data-ag-custom-theme'), false);
    assert.equal(head.querySelector('#ag-cs-aurora-theme-css'), null);

    // Activate Aurora "purple" and open dropdown right before teardown to prove REMOVE_EXPRESSION removes everything
    getPaletteBtns().find((b) => b.getAttribute('data-ag-cs-val') === '"purple"')?.dispatch('click');
    themeBtn.dispatch('click');
    assert.ok(head.querySelector('#ag-cs-aurora-theme-css'));
    assert.ok(body.querySelector('#ag-cs-theme-dropdown'));

    // Teardown must cleanly remove everything and restore host greeting text!
    const rem = vm.runInNewContext(cdp.REMOVE_EXPRESSION, sandbox);
    assert.ok(rem.removed >= 1);
    assert.equal(html.hasAttribute('data-ag-cs-style'), false);
    assert.equal(html.hasAttribute('data-ag-cs-effort-accent'), false);
    assert.equal(html.hasAttribute('data-ag-cs-perf-backdrop'), false);
    assert.equal(html.hasAttribute('data-ag-cs-lang'), false);
    assert.equal(html.hasAttribute('data-ag-cs-cjk'), false);
    assert.equal(html.hasAttribute('data-ag-custom-theme'), false);
    assert.equal(html.hasAttribute('data-aux-pane-maximized'), false);
    assert.equal(html.style.getPropertyValue('--antigravity-active-theme-id'), '');
    assert.equal(head.querySelector('#ag-cs-aurora-theme-css'), null);
    assert.equal(paneToolbar.querySelector('#ag-cs-theme-selector'), null);
    assert.equal(body.querySelector('#ag-cs-theme-dropdown'), null);
    assert.equal(sandbox.globalThis.__agCsCustomThemes, undefined);
    assert.equal(sandbox.globalThis.__agCsEffortCore, undefined);
    assert.equal(sandbox.globalThis.__agCsPerfAssets, undefined);
    assert.equal(sandbox.globalThis.__agCsCleanups, undefined);
    assert.equal(body.querySelector('.ag-cs-perf-backdrop'), null);
    assert.equal(h1.textContent, 'Welcome back, girl. Where should we pick up?');
    assert.equal(placeholder.hasAttribute('data-ag-cs-placeholder'), false);
    assert.equal(effortSpan.hasAttribute('data-ag-cs-effort'), false);
    assert.equal(home.querySelector('.ag-cs-home-panel'), null);
    assert.equal(home.querySelector('.ag-cs-ripple-host'), null);
    assert.equal(home.querySelector('.ag-cs-ripple-canvas'), null);
    assert.equal(card.querySelector('.ag-cs-crab'), null);
    assert.equal(dialog.querySelector('#ag-cs-settings-sec'), null);
  } finally {
    for (const id of timers) clearTimeout(id);
  }
});

test('buildInjectExpression defers cleanly when documentElement is null at document-start and mounts on DOMContentLoaded', () => {
  const docListeners = new Map();
  let htmlEl = null;
  let headEl = null;
  let bodyEl = null;
  const attrs = new Map();
  const makeStub = (tag) => ({
    tagName: tag.toUpperCase(),
    id: '',
    children: [],
    parentNode: null,
    parentElement: null,
    classList: { contains: () => false, add() {}, remove() {} },
    get lastElementChild() { return this.children[this.children.length - 1] || null; },
    appendChild(c) { c.parentNode = this; c.parentElement = this; this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; c.parentElement = null; return c; },
    remove() { if (this.parentElement) this.parentElement.removeChild(this); },
    setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'id') this.id = String(v); },
    getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
    hasAttribute(k) { return attrs.has(k); },
    removeAttribute(k) { attrs.delete(k); },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    style: { setProperty() {}, getPropertyValue() { return ''; }, removeProperty() {} },
  });

  const doc = {
    get documentElement() { return htmlEl; },
    get head() { return headEl; },
    get body() { return bodyEl; },
    hidden: false,
    readyState: 'loading',
    createElement: (t) => makeStub(t),
    getElementById(id) {
      return headEl?.children?.find((c) => c.id === id) || htmlEl?.children?.find((c) => c.id === id) || null;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(ev, fn) {
      if (!docListeners.has(ev)) docListeners.set(ev, []);
      docListeners.get(ev).push(fn);
    },
    removeEventListener(ev, fn) {
      const arr = docListeners.get(ev);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
  };

  let observedNode = null;
  const timers = new Set();
  const sandbox = {
    window: null,
    globalThis: null,
    document: doc,
    navigator: { language: 'zh-CN' },
    location: { pathname: '/' },
    localStorage: { _m: {}, getItem(k) { return this._m[k] || null; }, setItem(k, v) { this._m[k] = String(v); } },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false }),
    MutationObserver: class {
      observe(node) {
        if (!node) throw new TypeError('parameter 1 is not of type Node');
        observedNode = node;
      }
      disconnect() {}
    },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); timers.add(id); return id; },
    clearTimeout: (id) => { timers.delete(id); clearTimeout(id); },
    setInterval: () => 1,
    clearInterval: () => {},
    performance: { now: () => Date.now() },
    Math, Date, JSON, Map, Set, Array, Object, String, Number, Boolean, Promise, Uint8Array, Float32Array, Intl,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  try {
    const res = vm.runInNewContext(cdp.buildInjectExpression(), sandbox);
    assert.equal(res.status, 'deferred');
    assert.equal(sandbox.window.__agClaudeStyle, undefined);

    // Simulate document parsing completing
    htmlEl = makeStub('html');
    headEl = makeStub('head');
    bodyEl = makeStub('body');
    htmlEl.appendChild(headEl);
    htmlEl.appendChild(bodyEl);
    doc.readyState = 'interactive';
    for (const fn of [...(docListeners.get('DOMContentLoaded') || [])]) fn();

    assert.ok(sandbox.window.__agClaudeStyle, 'Expected __agClaudeStyle to mount after DOMContentLoaded');
    assert.equal(observedNode, htmlEl);
    assert.ok(headEl.children.some((c) => c.id === cdp.STYLE_ID));
    assert.equal(attrs.get('data-ag-cs-style'), '1');

    vm.runInNewContext(cdp.REMOVE_EXPRESSION, sandbox);
    assert.equal(sandbox.window.__agClaudeStyle, undefined);
  } finally {
    for (const id of timers) clearTimeout(id);
  }
});

test('effort popover uses clientWidth (immune to pop-in scale), preserves Extra label, and mounts ChatGPT status only on interaction', async () => {
  const timers = new Set();
  const makeNode = (tag, opts = {}) => {
    const attrs = new Map(Object.entries(opts.attrs || {}));
    const listeners = new Map();
    const children = [];
    const classes = new Set((opts.className || '').split(/\s+/).filter(Boolean));
    const parseAttrs = (str) => {
      const out = {};
      const re = /([a-zA-Z0-9_-]+)(?:="([^"]*)")?/g;
      let m;
      while ((m = re.exec(str))) {
        out[m[1]] = m[2] ?? '';
      }
      return out;
    };
    const buildChildrenFromHtml = (parent, htmlStr) => {
      parent.children.length = 0;
      const stack = [parent];
      const tokRe = /<\/([a-zA-Z0-9_-]+)>|<([a-zA-Z0-9_-]+)([^>]*?)(\/?)>|([^<]+)/g;
      let tok;
      while ((tok = tokRe.exec(htmlStr))) {
        if (tok[1]) {
          if (stack.length > 1) stack.pop();
        } else if (tok[2]) {
          const parsed = parseAttrs(tok[3] || '');
          const child = makeNode(tok[2], { className: parsed.class || '', attrs: parsed });
          stack[stack.length - 1].appendChild(child);
          if (!tok[4]) stack.push(child);
        } else if (tok[5]) {
          const cur = stack[stack.length - 1];
          const txt = tok[5].replace(/\s+/g, ' ');
          if (txt.trim()) cur._text += txt;
        }
      }
    };
    const matchesSimple = (n, s) => {
      let rest = s.trim();
      const tm = /^[a-zA-Z0-9_-]+/.exec(rest);
      if (tm) {
        if (n.tagName !== tm[0].toUpperCase()) return false;
        rest = rest.slice(tm[0].length);
      }
      while (rest) {
        if (rest[0] === '.') {
          const m = /^\.([a-zA-Z0-9_-]+)/.exec(rest);
          if (!m || !n.classList.contains(m[1])) return false;
          rest = rest.slice(m[0].length);
        } else if (rest[0] === '[') {
          const m = /^\[([^\]=]+)(?:="([^"]*)")?\]/.exec(rest);
          if (!m) return false;
          const ok = m[2] === undefined ? n.hasAttribute(m[1]) : n.getAttribute(m[1]) === m[2];
          if (!ok) return false;
          rest = rest.slice(m[0].length);
        } else {
          return false;
        }
      }
      return true;
    };
    const node = {
      tagName: tag.toUpperCase(),
      id: attrs.get('id') || '',
      children,
      parentElement: null,
      parentNode: null,
      isConnected: true,
      _text: opts.text || '',
      _listeners: listeners,
      clientWidth: opts.clientWidth ?? (classes.has('ag-cs-effort-track') ? 230 : 264),
      offsetWidth: opts.offsetWidth ?? (classes.has('ag-cs-effort-track') ? 230 : 264),
      clientHeight: opts.clientHeight ?? 30,
      offsetHeight: opts.offsetHeight ?? 30,
      _knobTransitionLog: [],
      style: {
        _props: {},
        transition: '',
        backgroundImage: '',
        setProperty(k, v) {
          this._props[k] = String(v);
          if (k === '--ag-cs-knob-x') node._knobTransitionLog.push({ val: String(v), transition: this.transition });
        },
        getPropertyValue(k) { return this._props[k] || ''; },
        removeProperty(k) { delete this._props[k]; },
      },
      classList: {
        contains: (c) => classes.has(c),
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        toggle: (c, f) => (f === undefined ? (classes.has(c) ? classes.delete(c) : classes.add(c)) : f ? classes.add(c) : classes.delete(c)),
      },
      get className() { return Array.from(classes).join(' '); },
      set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
      get textContent() { return children.length ? children.map((c) => c.textContent).join('') : this._text; },
      set textContent(v) { children.length = 0; this._text = String(v); },
      get innerHTML() { return this._html || ''; },
      set innerHTML(v) { this._html = String(v); buildChildrenFromHtml(this, this._html); },
      get childElementCount() { return children.length; },
      appendChild(ch) { ch.parentElement = this; ch.parentNode = this; children.push(ch); return ch; },
      removeChild(ch) { const i = children.indexOf(ch); if (i >= 0) children.splice(i, 1); ch.parentElement = null; ch.parentNode = null; return ch; },
      remove() { if (this.parentElement) this.parentElement.removeChild(this); },
      setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'id') this.id = String(v); if (k === 'class') this.className = String(v); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      hasAttribute(k) { return attrs.has(k); },
      removeAttribute(k) { attrs.delete(k); },
      toggleAttribute(k, force) { const on = force === undefined ? !attrs.has(k) : Boolean(force); if (on) attrs.set(k, ''); else attrs.delete(k); return on; },
      addEventListener(ev, cb) { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(cb); },
      removeEventListener(ev, cb) { const a = listeners.get(ev); if (a) { const i = a.indexOf(cb); if (i >= 0) a.splice(i, 1); } },
      dispatch(ev, payload = {}) {
        const list = listeners.get(ev) || [];
        for (const fn of list) fn({ stopPropagation() {}, preventDefault() {}, ...payload });
      },
      getContext() { return null; },
      getBoundingClientRect() {
        // Simulate 0.98 pop-in scale transform distorting boundingClientRect while clientWidth remains unscaled (230)
        if (classes.has('ag-cs-effort-track')) return { left: 16, top: 20, right: 241.4, bottom: 50, width: 225.4, height: 30 };
        return { left: 100, top: 500, right: 240, bottom: 524, width: 140, height: 24 };
      },
      closest(sel) {
        let cur = this;
        while (cur) {
          if (sel.split(',').some((p) => matchesSimple(cur, p.trim()))) return cur;
          cur = cur.parentElement;
        }
        return null;
      },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) {
        const parts = sel.split(',').map((s) => s.trim()).filter(Boolean);
        const out = [];
        const walk = (n) => {
          for (const c of n.children) {
            if (parts.some((p) => matchesSimple(c, p))) out.push(c);
            walk(c);
          }
        };
        walk(this);
        return out;
      },
    };
    return node;
  };

  const html = makeNode('html');
  const head = makeNode('head');
  const body = makeNode('body', { className: 'theme-light' });
  html.appendChild(head);
  html.appendChild(body);

  const card = makeNode('div', { className: 'surface-composer-card' });
  const modelNameSpan = makeNode('span', { text: 'Gemini 4 Hydrogen Extra' });
  const effortSpan = makeNode('span', { text: ' Extra' });
  const modelBtn = makeNode('button', { attrs: { 'data-testid': 'model-selector-trigger' } });
  modelBtn.appendChild(modelNameSpan);
  modelBtn.appendChild(effortSpan);
  modelBtn.__reactFiber$test = {
    memoizedProps: {
      selectedModel: { label: 'Gemini 4 Hydrogen (XHigh)' },
      modelOptions: [
        { label: 'Gemini 3.8 Flash (Low)' },
        { label: 'Gemini 3.8 Flash (Medium)' },
        { label: 'Gemini 3.8 Flash (High)' },
        { label: 'Gemini 4 Hydrogen (Low)' },
        { label: 'Gemini 4 Hydrogen (Medium)' },
        { label: 'Gemini 4 Hydrogen (High)' },
        { label: 'Gemini 4 Hydrogen (XHigh)' },
      ],
      setSelectedModel() {},
    },
    return: null,
  };
  card.appendChild(modelBtn);
  const inputBox = makeNode('div', { attrs: { 'data-testid': 'agent-input-box' } });
  inputBox.appendChild(card);
  body.appendChild(inputBox);

  const doc = {
    documentElement: html,
    head,
    body,
    hidden: false,
    readyState: 'complete',
    createElement: (t) => makeNode(t),
    getElementById: (id) => {
      const find = (n) => (n.id === id ? n : n.children.map(find).find(Boolean) || null);
      return find(html);
    },
    querySelector: (s) => html.querySelector(s),
    querySelectorAll: (s) => html.querySelectorAll(s),
    addEventListener() {},
    removeEventListener() {},
  };

  const winListeners = new Map();
  const sandbox = {
    window: null,
    globalThis: null,
    document: doc,
    navigator: { language: 'zh-CN' },
    location: { pathname: '/workspace' },
    localStorage: { _m: {}, getItem(k) { return this._m[k] || null; }, setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; } },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false }),
    addEventListener(ev, fn) { if (!winListeners.has(ev)) winListeners.set(ev, new Set()); winListeners.get(ev).add(fn); },
    removeEventListener(ev, fn) { winListeners.get(ev)?.delete(fn); },
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); timers.add(id); return id; },
    clearTimeout: (id) => { timers.delete(id); clearTimeout(id); },
    setInterval: () => 1,
    clearInterval: () => {},
    performance: { now: () => Date.now() },
    Math, Date, JSON, Map, Set, Array, Object, String, Number, Boolean, Promise, Uint8Array, Float32Array, Intl,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  try {
    vm.runInNewContext(cdp.buildInjectExpression(), sandbox);
    assert.equal(winListeners.get('resize')?.size || 0, 1);

    // 1. Open Claude slider on Light theme + Extra badge + scaled getBoundingClientRect()
    sandbox.window.__agClaudeStyle.openEffortPopover(effortSpan, modelBtn);
    const pop = body.querySelector('.ag-cs-effort-popover');
    assert.ok(pop);
    assert.equal(pop.getAttribute('data-effort-theme'), 'light');
    assert.equal(pop.getAttribute('data-perf-theme'), 'light');
    assert.equal(pop.querySelector('.ag-cs-effort-value')?.textContent.trim(), 'Extra');

    const knob = pop.querySelector('.ag-cs-effort-knob');
    assert.ok(knob);
    // track.clientWidth === 230 => span = 214 => at apex (prog = 1) must be 214.00px (NOT scaled 209.40px)
    assert.equal(knob.style.getPropertyValue('--ag-cs-knob-x'), '214.00px');
    // Initial mount sets --ag-cs-knob-x synchronously with transition === 'none' so knob does not sweep from 0px
    assert.ok(knob._knobTransitionLog.length >= 1);
    assert.equal(knob._knobTransitionLog[0].val, '214.00px');
    assert.equal(knob._knobTransitionLog[0].transition, 'none');
    assert.equal(knob.style.transition, '');

    // If track.clientWidth === 0 (hidden/detached), positionKnob falls back cleanly to left: calc(...)
    const track = pop.querySelector('.ag-cs-effort-track');
    track.clientWidth = 0;
    pop._syncEffortKnob();
    assert.equal(knob.style.left, 'calc(1.0000 * (100% - 16px))');

    // 2. Switch to ChatGPT (Codex) mode: preserves "Extra" in value label, mounts 22 stars + nebula, responds to ArrowLeft/End
    doc.hidden = true;
    sandbox.window.__agClaudeStyle.refreshConfig({ ...cdp.DEFAULT_CONFIG, effortSliderStyle: 'chatgpt', hudTopBar: true });
    await new Promise((r) => setTimeout(r, 80));
    doc.hidden = false;

    const codexTrack = pop.querySelector('.ag-cs-codex-track');
    assert.ok(codexTrack, 'Expected Codex track element');
    assert.equal(pop.querySelectorAll('.ag-cs-codex-star').length, 22);
    assert.equal(pop.querySelector('.ag-cs-codex-value')?.textContent.trim(), 'Extra');
    assert.equal(pop.getAttribute('data-energy'), '1');
    codexTrack.dispatch('keydown', { key: 'Home' });
    assert.equal(pop.querySelector('.ag-cs-codex-value')?.textContent.trim(), 'Low');
    codexTrack.dispatch('keydown', { key: 'End' });
    assert.equal(pop.querySelector('.ag-cs-codex-value')?.textContent.trim(), 'Extra');

    // 2b. Switch to Liang Wufeng mode: preserves "Extra" in meta, verifies card scrim & translucent page backdrop, omits idle status until tick hover/click
    doc.hidden = true;
    sandbox.window.__agClaudeStyle.refreshConfig({ ...cdp.DEFAULT_CONFIG, effortSliderStyle: 'liangwufeng', hudTopBar: true });
    await new Promise((r) => setTimeout(r, 80));
    doc.hidden = false;

    const bgEl = pop.querySelector('.ag-cs-perf-card-bg');
    assert.ok(bgEl?.style?.backgroundImage.includes('76%'), 'Expected tightened 76% stop in card scrim');

    const meta = pop.querySelector('.ag-cs-perf-meta');
    assert.ok(meta?.textContent.includes('Extra'), `Expected Extra in meta, got: ${meta?.textContent}`);
    assert.equal(pop.querySelector('.ag-cs-perf-status'), null);

    const firstTick = pop.querySelector('.ag-cs-perf-tick');
    firstTick.dispatch('mouseenter');
    assert.ok(pop.querySelector('.ag-cs-perf-status'));
    firstTick.dispatch('mouseleave');
    assert.equal(pop.querySelector('.ag-cs-perf-status'), null);
    firstTick.dispatch('click');
    assert.ok(pop.querySelector('.ag-cs-perf-status'));

    doc.hidden = true;
    sandbox.window.__agClaudeStyle.refreshConfig({ ...cdp.DEFAULT_CONFIG, effortSliderStyle: 'liangwufeng', performanceBackdrop: 'page', hudTopBar: true });
    await new Promise((r) => setTimeout(r, 80));
    doc.hidden = false;
    const pageBgEl = pop.querySelector('.ag-cs-perf-card-bg');
    assert.ok(pageBgEl);
    assert.equal((pageBgEl.style.backgroundImage.match(/linear-gradient\(/g) || []).length, 1, 'Expected only translucent scrim linear-gradient in page mode');

    // 3. Clicking XHigh from High when host dynamically sets badge to " Extra" updates open popover to "Extra"
    doc.hidden = true;
    sandbox.window.__agClaudeStyle.refreshConfig({ ...cdp.DEFAULT_CONFIG, effortSliderStyle: 'claude' });
    await new Promise((r) => setTimeout(r, 80));
    doc.hidden = false;
    modelBtn.__reactFiber$test.memoizedProps.selectedModel = { label: 'Gemini 4 Hydrogen (High)' };
    modelBtn.__reactFiber$test.memoizedProps.setSelectedModel = (opt) => {
      modelBtn.__reactFiber$test.memoizedProps.selectedModel = opt;
      effortSpan.textContent = /\bXHigh\b/i.test(opt.label) ? ' Extra' : ' High';
    };
    effortSpan.textContent = ' High';
    effortSpan.setAttribute('data-ag-cs-effort', 'xhigh'); // intentionally stale attr must not shadow live ' High' text
    sandbox.window.__agClaudeStyle.openEffortPopover(effortSpan, modelBtn); // closes previous
    assert.equal(pop.parentElement, null);
    sandbox.window.__agClaudeStyle.openEffortPopover(effortSpan, modelBtn); // opens on High
    const activePop = body.querySelector('.ag-cs-effort-popover');
    assert.ok(activePop);
    assert.equal(activePop.querySelector('.ag-cs-effort-value')?.textContent.trim(), 'High');
    const xhighTick = activePop.querySelector('.ag-cs-effort-tick[data-effort-id="xhigh"]');
    assert.ok(xhighTick);
    xhighTick.dispatch('click', { detail: 1 });
    assert.equal(effortSpan.getAttribute('data-ag-cs-effort'), 'extra');
    assert.equal(activePop.querySelector('.ag-cs-effort-value')?.textContent.trim(), 'Extra');
    assert.equal(activePop.querySelector('.ag-cs-effort-track')?.getAttribute('aria-valuetext'), 'Extra');

    vm.runInNewContext(cdp.REMOVE_EXPRESSION, sandbox);
    assert.equal(winListeners.get('resize')?.size || 0, 0);
  } finally {
    for (const id of timers) clearTimeout(id);
  }
});

test('bottom-right context ring navigates directly to quotas or breakdown tab based on ringMode', async () => {
  const timers = new Set();
  const makeEl = (tag, opts = {}) => {
    const attrs = new Map(Object.entries(opts.attrs || {}));
    const listeners = new Map();
    const children = [];
    const classes = new Set((opts.className || '').split(/\s+/).filter(Boolean));
    const parseAttrs = (str) => {
      const out = {};
      const re = /([a-zA-Z0-9_-]+)(?:="([^"]*)")?/g;
      let m;
      while ((m = re.exec(str))) out[m[1]] = m[2] ?? '';
      return out;
    };
    const buildChildrenFromHtml = (parent, htmlStr) => {
      parent.children.length = 0;
      const stack = [parent];
      const tokRe = /<\/([a-zA-Z0-9_-]+)>|<([a-zA-Z0-9_-]+)([^>]*?)(\/?)>|([^<]+)/g;
      let tok;
      while ((tok = tokRe.exec(htmlStr))) {
        if (tok[1]) {
          if (stack.length > 1) stack.pop();
        } else if (tok[2]) {
          const parsed = parseAttrs(tok[3] || '');
          const child = makeEl(tok[2], { className: parsed.class || '', attrs: parsed });
          stack[stack.length - 1].appendChild(child);
          if (!tok[4]) stack.push(child);
        } else if (tok[5]) {
          const cur = stack[stack.length - 1];
          const txt = tok[5].replace(/\s+/g, ' ');
          if (txt.trim()) cur._text += txt;
        }
      }
    };
    const matchesSimple = (n, s) => {
      let rest = s.trim();
      const tm = /^[a-zA-Z0-9_-]+/.exec(rest);
      if (tm) {
        if (n.tagName !== tm[0].toUpperCase()) return false;
        rest = rest.slice(tm[0].length);
      }
      while (rest) {
        if (rest[0] === '#') {
          const m = /^#([a-zA-Z0-9_-]+)/.exec(rest);
          if (!m || n.id !== m[1]) return false;
          rest = rest.slice(m[0].length);
        } else if (rest[0] === '.') {
          const m = /^\.([a-zA-Z0-9_-]+)/.exec(rest);
          if (!m || !n.classList.contains(m[1])) return false;
          rest = rest.slice(m[0].length);
        } else if (rest[0] === '[') {
          const m = /^\[([^\]=]+)(?:="([^"]*)")?\]/.exec(rest);
          if (!m) return false;
          const ok = m[2] === undefined ? n.hasAttribute(m[1]) : n.getAttribute(m[1]) === m[2];
          if (!ok) return false;
          rest = rest.slice(m[0].length);
        } else {
          return false;
        }
      }
      return true;
    };
    const matchesChain = (n, selector) =>
      selector.split(',').some((part) => {
        const tokens = part.trim().split(/\s+/).filter(Boolean);
        if (tokens.length === 0 || !matchesSimple(n, tokens[tokens.length - 1])) return false;
        let cur = n.parentElement;
        let idx = tokens.length - 2;
        while (cur && idx >= 0) {
          if (matchesSimple(cur, tokens[idx])) idx -= 1;
          cur = cur.parentElement;
        }
        return idx < 0;
      });
    const node = {
      tagName: tag.toUpperCase(),
      id: attrs.get('id') || '',
      children,
      parentElement: null,
      parentNode: null,
      isConnected: true,
      _text: opts.text || '',
      _listeners: listeners,
      clientWidth: 280,
      offsetWidth: 280,
      clientHeight: 30,
      offsetHeight: 30,
      style: { _props: {}, setProperty(k, v) { this._props[k] = String(v); }, getPropertyValue(k) { return this._props[k] || ''; }, removeProperty(k) { delete this._props[k]; } },
      classList: { contains: (c) => classes.has(c), add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
      get className() { return Array.from(classes).join(' '); },
      set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
      get textContent() { return children.length ? children.map((c) => c.textContent).join('') : this._text; },
      set textContent(v) { children.length = 0; this._text = String(v); },
      set innerHTML(v) { this._html = v; buildChildrenFromHtml(this, v); },
      get innerHTML() { return this._html || ''; },
      appendChild(c) { c.parentElement = this; c.parentNode = this; children.push(c); return c; },
      removeChild(c) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); c.parentElement = null; c.parentNode = null; return c; },
      remove() { if (this.parentElement) this.parentElement.removeChild(this); },
      setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'id') node.id = String(v); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      hasAttribute(k) { return attrs.has(k); },
      removeAttribute(k) { attrs.delete(k); },
      toggleAttribute(k, f) { const on = f === undefined ? !attrs.has(k) : Boolean(f); if (on) attrs.set(k, ''); else attrs.delete(k); return on; },
      addEventListener(ev, cb) { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(cb); },
      removeEventListener(ev, cb) { const a = listeners.get(ev); if (a) { const i = a.indexOf(cb); if (i >= 0) a.splice(i, 1); } },
      dispatch(ev, extra = {}) {
        const e = { type: ev, stopPropagation() {}, preventDefault() {}, ...extra };
        for (const cb of [...(listeners.get(ev) || [])]) cb(e);
      },
      getBoundingClientRect() { return { left: 200, top: 600, right: 480, bottom: 630, width: 280, height: 30 }; },
      animate() { return { cancel() {}, finished: Promise.resolve() }; },
      closest(sel) { let cur = this; while (cur) { if (matchesChain(cur, sel)) return cur; cur = cur.parentElement; } return null; },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) {
        const out = [];
        const walk = (n) => {
          for (const c of n.children) {
            if (matchesChain(c, sel)) out.push(c);
            walk(c);
          }
        };
        walk(this);
        return out;
      },
    };
    return node;
  };

  const cascadeId = '11111111-1111-4111-8111-111111111111';
  const html = makeEl('html');
  const head = makeEl('head');
  const body = makeEl('body', { className: 'theme-dark' });
  html.appendChild(head);
  html.appendChild(body);

  const convView = makeEl('div', { attrs: { 'data-testid': 'conversation-view', 'data-cascade-id': cascadeId } });
  const inputBox = makeEl('div', { id: 'antigravity.agentSidePanelInputBox', attrs: { 'data-testid': 'agent-input-box' } });
  const card = makeEl('div', { className: 'surface-composer-card' });
  const editorEl = makeEl('div', { attrs: { contenteditable: 'true', 'data-lexical-editor': 'true' } });
  const footer = makeEl('div', { className: 'agy-composer-footer' });
  const modelBtn = makeEl('button', { attrs: { 'data-testid': 'model-selector-trigger' } });
  footer.appendChild(modelBtn);
  card.appendChild(editorEl);
  card.appendChild(footer);
  inputBox.appendChild(card);
  convView.appendChild(inputBox);
  body.appendChild(convView);

  const mockTraj = {
    trajectory: {
      steps: [
        { status: 3, step: { case: 'userInput' } },
        { status: 1, step: { case: 'plannerResponse', value: {} } },
      ],
      generatorMetadata: [
        {
          metadata: {
            value: {
              usage: { inputTokens: '2000', cacheReadTokens: '18000', outputTokens: '500', thinkingOutputTokens: '100' },
              chatStartMetadata: {
                contextWindowMetadata: { estimatedTokensUsed: 50000, maxContextTokens: 256000 },
              },
            },
          },
        },
      ],
    },
  };
  inputBox.__reactFiber$test = {
    memoizedProps: {
      cascadeId,
      store: {
        getState: () => ({
          cascadeTrajectorySummaries: {
            [cascadeId]: { stepCount: 2, lastModifiedTime: '2026-11-14T10:00:00Z' },
          },
        }),
        subscribe: () => () => {},
      },
    },
    dependencies: {
      firstContext: {
        memoizedValue: {
          async getCascadeTrajectory() { return mockTraj; },
          async retrieveUserQuotaSummary() { return { models: [] }; },
        },
      },
    },
    return: null,
  };

  const doc = {
    documentElement: html,
    head,
    body,
    hidden: false,
    readyState: 'complete',
    createElement: (t) => makeEl(t),
    getElementById: (id) => {
      const find = (n) => (n.id === id ? n : n.children.map(find).find(Boolean) || null);
      return find(html);
    },
    querySelector: (s) => html.querySelector(s),
    querySelectorAll: (s) => html.querySelectorAll(s),
    addEventListener() {},
    removeEventListener() {},
  };

  const sandbox = {
    window: null,
    globalThis: null,
    document: doc,
    navigator: { language: 'zh-CN' },
    location: { pathname: `/c/${cascadeId}` },
    localStorage: { _m: {}, getItem(k) { return this._m[k] || null; }, setItem(k, v) { this._m[k] = String(v); } },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false }),
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); timers.add(id); return id; },
    clearTimeout: (id) => { timers.delete(id); clearTimeout(id); },
    setInterval: () => 1,
    clearInterval: () => {},
    performance: { now: () => Date.now() },
    Math, Date, JSON, Map, Set, Array, Object, String, Number, Boolean, Promise, Uint8Array, Float32Array, Intl,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  try {
    vm.runInNewContext(cdp.buildInjectExpression({ ...cdp.DEFAULT_CONFIG, ringMode: 'context' }), sandbox);
    await new Promise((r) => setTimeout(r, 80));

    const ringBtn = footer.querySelector('.ag-cs-context-ring');
    assert.ok(ringBtn, 'Expected bottom-right context ring widget');

    ringBtn.dispatch('click');
    let pop = body.querySelector('.ag-cs-ctx-popover');
    assert.equal(pop?.querySelector('.is-active')?.getAttribute('data-ctx-tab'), 'breakdown');
    pop?.querySelector('.ag-cs-ctx-close')?.dispatch('click');

    doc.hidden = true;
    sandbox.window.__agClaudeStyle.refreshConfig({ ...cdp.DEFAULT_CONFIG, ringMode: 'quota' });
    await new Promise((r) => setTimeout(r, 80));
    doc.hidden = false;

    ringBtn.dispatch('click');
    pop = body.querySelector('.ag-cs-ctx-popover');
    assert.equal(pop?.querySelector('.is-active')?.getAttribute('data-ctx-tab'), 'quotas');
    pop?.querySelector('.ag-cs-ctx-close')?.dispatch('click');

    doc.hidden = true;
    sandbox.window.__agClaudeStyle.refreshConfig({ ...cdp.DEFAULT_CONFIG, ringMode: 'both' });
    await new Promise((r) => setTimeout(r, 80));
    doc.hidden = false;

    const quotaRingBtn = footer.querySelector('.ag-cs-quota-ring');
    const usedRingBtn = footer.querySelector('.ag-cs-context-ring');
    assert.ok(quotaRingBtn, 'Expected left quota ring widget in both mode');
    assert.ok(usedRingBtn, 'Expected right context-used ring widget in both mode');
    assert.equal(quotaRingBtn.getAttribute('data-ring-mode'), 'quota');
    assert.equal(usedRingBtn.getAttribute('data-ring-mode'), 'context-used');

    quotaRingBtn.dispatch('click');
    pop = body.querySelector('.ag-cs-ctx-popover');
    assert.equal(pop?.querySelector('.is-active')?.getAttribute('data-ctx-tab'), 'quotas');
    pop?.querySelector('.ag-cs-ctx-close')?.dispatch('click');

    usedRingBtn.dispatch('click');
    pop = body.querySelector('.ag-cs-ctx-popover');
    assert.equal(pop?.querySelector('.is-active')?.getAttribute('data-ctx-tab'), 'breakdown');
    pop?.querySelector('.ag-cs-ctx-close')?.dispatch('click');

    // Switching back to single ring removes stale .ag-cs-quota-ring cleanly
    doc.hidden = true;
    sandbox.window.__agClaudeStyle.refreshConfig({ ...cdp.DEFAULT_CONFIG, ringMode: 'context' });
    await new Promise((r) => setTimeout(r, 80));
    doc.hidden = false;
    assert.equal(footer.querySelector('.ag-cs-quota-ring'), null);

    // Re-enable dual rings and ensure REMOVE_EXPRESSION removes both rings
    doc.hidden = true;
    sandbox.window.__agClaudeStyle.refreshConfig({ ...cdp.DEFAULT_CONFIG, ringMode: 'both' });
    await new Promise((r) => setTimeout(r, 80));
    doc.hidden = false;
    assert.ok(footer.querySelector('.ag-cs-quota-ring'));

    vm.runInNewContext(cdp.REMOVE_EXPRESSION, sandbox);
    assert.equal(footer.querySelector('.ag-cs-quota-ring'), null);
    assert.equal(footer.querySelector('.ag-cs-context-ring'), null);
  } finally {
    for (const id of timers) clearTimeout(id);
  }
});

test('new conversation renders bottom-right ring and inline tokens info on home view and during Turn 1 (calls === 0)', async () => {
  const timers = new Set();
  const makeEl = (tag, opts = {}) => {
    const attrs = new Map(Object.entries(opts.attrs || {}));
    const listeners = new Map();
    const children = [];
    const classes = new Set((opts.className || '').split(/\s+/).filter(Boolean));
    const parseAttrs = (str) => {
      const out = {};
      const re = /([a-zA-Z0-9_-]+)(?:="([^"]*)")?/g;
      let m;
      while ((m = re.exec(str))) out[m[1]] = m[2] ?? '';
      return out;
    };
    const buildChildrenFromHtml = (parent, htmlStr) => {
      parent.children.length = 0;
      const stack = [parent];
      const tokRe = /<\/([a-zA-Z0-9_-]+)>|<([a-zA-Z0-9_-]+)([^>]*?)(\/?)>|([^<]+)/g;
      let tok;
      while ((tok = tokRe.exec(htmlStr))) {
        if (tok[1]) {
          if (stack.length > 1) stack.pop();
        } else if (tok[2]) {
          const parsed = parseAttrs(tok[3] || '');
          const child = makeEl(tok[2], { className: parsed.class || '', attrs: parsed });
          stack[stack.length - 1].appendChild(child);
          if (!tok[4]) stack.push(child);
        } else if (tok[5]) {
          const cur = stack[stack.length - 1];
          const txt = tok[5].replace(/\s+/g, ' ');
          if (txt.trim()) cur._text += txt;
        }
      }
    };
    const matchesSimple = (n, s) => {
      let rest = s.trim();
      const tm = /^[a-zA-Z0-9_-]+/.exec(rest);
      if (tm) {
        if (n.tagName !== tm[0].toUpperCase()) return false;
        rest = rest.slice(tm[0].length);
      }
      while (rest) {
        if (rest[0] === '#') {
          const m = /^#([a-zA-Z0-9_-]+)/.exec(rest);
          if (!m || n.id !== m[1]) return false;
          rest = rest.slice(m[0].length);
        } else if (rest[0] === '.') {
          const m = /^\.([a-zA-Z0-9_-]+)/.exec(rest);
          if (!m || !n.classList.contains(m[1])) return false;
          rest = rest.slice(m[0].length);
        } else if (rest[0] === '[') {
          const m = /^\[([^\]=]+)(?:="([^"]*)")?\]/.exec(rest);
          if (!m) return false;
          const ok = m[2] === undefined ? n.hasAttribute(m[1]) : n.getAttribute(m[1]) === m[2];
          if (!ok) return false;
          rest = rest.slice(m[0].length);
        } else {
          return false;
        }
      }
      return true;
    };
    const matchesChain = (n, selector) =>
      selector.split(',').some((part) => {
        const tokens = part.trim().split(/\s+/).filter(Boolean);
        if (tokens.length === 0 || !matchesSimple(n, tokens[tokens.length - 1])) return false;
        let cur = n.parentElement;
        let idx = tokens.length - 2;
        while (cur && idx >= 0) {
          if (matchesSimple(cur, tokens[idx])) idx -= 1;
          cur = cur.parentElement;
        }
        return idx < 0;
      });
    const node = {
      tagName: tag.toUpperCase(),
      id: attrs.get('id') || '',
      children,
      parentElement: null,
      parentNode: null,
      isConnected: true,
      _text: opts.text || '',
      _listeners: listeners,
      clientWidth: 480,
      offsetWidth: 480,
      clientHeight: 30,
      offsetHeight: 30,
      style: { _props: {}, setProperty(k, v) { this._props[k] = String(v); }, getPropertyValue(k) { return this._props[k] || ''; }, removeProperty(k) { delete this._props[k]; } },
      classList: { contains: (c) => classes.has(c), add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
      get className() { return Array.from(classes).join(' '); },
      set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
      get textContent() { return children.length ? children.map((c) => c.textContent).join('') : this._text; },
      set textContent(v) { children.length = 0; this._text = String(v); },
      set innerHTML(v) { this._html = v; buildChildrenFromHtml(this, v); },
      get innerHTML() { return this._html || ''; },
      get firstChild() { return children[0] || null; },
      get childElementCount() { return children.length; },
      get nextSibling() {
        if (!this.parentElement) return null;
        const idx = this.parentElement.children.indexOf(this);
        return idx >= 0 ? this.parentElement.children[idx + 1] || null : null;
      },
      get lastElementChild() { return children[children.length - 1] || null; },
      getContext() { return null; },
      appendChild(c) { c.parentElement = this; c.parentNode = this; children.push(c); return c; },
      insertBefore(c, ref) {
        c.parentElement = this;
        c.parentNode = this;
        const idx = ref ? children.indexOf(ref) : -1;
        if (idx >= 0) children.splice(idx, 0, c);
        else children.push(c);
        return c;
      },
      removeChild(c) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); c.parentElement = null; c.parentNode = null; return c; },
      remove() { if (this.parentElement) this.parentElement.removeChild(this); },
      setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'id') node.id = String(v); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      hasAttribute(k) { return attrs.has(k); },
      removeAttribute(k) { attrs.delete(k); },
      toggleAttribute(k, f) { const on = f === undefined ? !attrs.has(k) : Boolean(f); if (on) attrs.set(k, ''); else attrs.delete(k); return on; },
      addEventListener(ev, cb) { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(cb); },
      removeEventListener(ev, cb) { const a = listeners.get(ev); if (a) { const i = a.indexOf(cb); if (i >= 0) a.splice(i, 1); } },
      dispatch(ev, extra = {}) {
        const e = { type: ev, stopPropagation() {}, preventDefault() {}, ...extra };
        for (const cb of [...(listeners.get(ev) || [])]) cb(e);
      },
      getBoundingClientRect() { return { left: 200, top: 600, right: 680, bottom: 630, width: 480, height: 30 }; },
      animate() { return { cancel() {}, finished: Promise.resolve() }; },
      closest(sel) { let cur = this; while (cur) { if (matchesChain(cur, sel)) return cur; cur = cur.parentElement; } return null; },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) {
        const out = [];
        const walk = (n) => {
          for (const c of n.children) {
            if (matchesChain(c, sel)) out.push(c);
            walk(c);
          }
        };
        walk(this);
        return out;
      },
    };
    return node;
  };

  // Part A: New conversation Home view (.agy-home, no conversation-view, no cascadeId) with ringMode: 'quota'
  const html = makeEl('html');
  const head = makeEl('head');
  const body = makeEl('body', { className: 'theme-dark' });
  html.appendChild(head);
  html.appendChild(body);

  const home = makeEl('div', { className: 'agy-home' });
  const greeting = makeEl('div', { attrs: { 'data-testid': 'home-greeting' } });
  greeting.appendChild(makeEl('h1', { className: 'home-greeting-title', text: 'Welcome' }));
  home.appendChild(greeting);

  const inputBox = makeEl('div', { id: 'antigravity.agentSidePanelInputBox', attrs: { 'data-testid': 'agent-input-box' } });
  const card = makeEl('div', { className: 'surface-composer-card' });
  const editorEl = makeEl('div', { attrs: { contenteditable: 'true', 'data-lexical-editor': 'true' } });
  const footer = makeEl('div', { className: 'agy-composer-footer' });
  const modelBtn = makeEl('button', { attrs: { 'data-testid': 'model-selector-trigger' } });
  modelBtn.appendChild(makeEl('span', { text: 'Gemini 4 Hydrogen' }));
  modelBtn.appendChild(makeEl('span', { text: ' Extra' }));
  footer.appendChild(modelBtn);
  card.appendChild(editorEl);
  card.appendChild(footer);
  inputBox.appendChild(card);
  home.appendChild(inputBox);
  body.appendChild(home);

  let currentCascadeId = '';
  let currentStatus = 2;
  let currentTraj = { trajectory: { steps: [], generatorMetadata: [] } };
  const docListeners = new Map();
  inputBox.__reactFiber$test = {
    memoizedProps: {
      get cascadeId() { return currentCascadeId; },
      store: {
        getState: () => ({
          trajectorySummaries: { summaries: currentCascadeId ? { [currentCascadeId]: { stepCount: currentTraj.trajectory.steps.length, status: currentStatus } } : {} },
          userStatus: {
            cascadeModelConfigData: {
              clientModelConfigs: [{ label: 'Gemini 4 Hydrogen (XHigh)', quotaInfo: { remainingFraction: 0.42 } }],
            },
          },
        }),
        subscribe: () => () => {},
      },
    },
    dependencies: {
      firstContext: {
        memoizedValue: {
          async getCascadeTrajectory() { return currentTraj; },
          async retrieveUserQuotaSummary() {
            return { groups: [{ displayName: 'Gemini', buckets: [{ window: '5h', remaining: { case: 'remainingFraction', value: 0.42 } }] }] };
          },
        },
      },
    },
    return: null,
  };

  const doc = {
    documentElement: html,
    head,
    body,
    hidden: false,
    readyState: 'complete',
    createElement: (t) => makeEl(t),
    getElementById: (id) => {
      const find = (n) => (n.id === id ? n : n.children.map(find).find(Boolean) || null);
      return find(html);
    },
    querySelector: (s) => html.querySelector(s),
    querySelectorAll: (s) => html.querySelectorAll(s),
    addEventListener(ev, fn) { if (!docListeners.has(ev)) docListeners.set(ev, []); docListeners.get(ev).push(fn); },
    removeEventListener(ev, fn) { const a = docListeners.get(ev); if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } },
  };

  const sandbox = {
    window: null,
    globalThis: null,
    document: doc,
    navigator: { language: 'zh-CN' },
    location: { pathname: '/' },
    localStorage: { _m: {}, getItem(k) { return this._m[k] || null; }, setItem(k, v) { this._m[k] = String(v); } },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false }),
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 5),
    cancelAnimationFrame: (id) => clearTimeout(id),
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); timers.add(id); return id; },
    clearTimeout: (id) => { timers.delete(id); clearTimeout(id); },
    setInterval: () => 1,
    clearInterval: () => {},
    performance: { now: () => Date.now() },
    Math, Date, JSON, Map, Set, Array, Object, String, Number, Boolean, Promise, Uint8Array, Float32Array, Intl,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  try {
    const res = vm.runInNewContext(
      cdp.buildInjectExpression({ ...cdp.DEFAULT_CONFIG, ringMode: 'quota', hudFooterChip: true, hudTopBar: true }),
      sandbox
    );
    assert.equal(res.status, 'ok');
    await new Promise((r) => setTimeout(r, 60));

    // On .agy-home before sending, ring shows quota (42%) and inline stats + surround HUDs are mounted!
    const statsBtn = footer.querySelector('.ag-cs-inline-stats');
    const ringBtn = footer.querySelector('.ag-cs-context-ring');
    const chip = footer.querySelector('.ag-cs-hud-footer-chip');
    const topBar = card.querySelector('.ag-cs-hud-top-bar');
    assert.ok(statsBtn, 'Expected inline tokens info on new conversation home view');
    assert.ok(ringBtn, 'Expected bottom-right ring on new conversation home view');
    assert.ok(chip, 'Expected optional footer chip when enabled on new conversation');
    assert.ok(topBar, 'Expected optional top HUD bar when enabled on new conversation');
    assert.equal(statsBtn.textContent, '0 轮 0 步 · 0 tok · 0% 缓存');
    assert.equal(ringBtn.getAttribute('data-ring-mode'), 'quota');
    assert.equal(ringBtn.querySelector('span')?.textContent, '42%');

    // Typing a draft in new conversation updates inline tokens estimate live
    editorEl.textContent = '帮我修复新建对话下未显示圆环及tokens信息的问题';
    for (const fn of [...(docListeners.get('input') || [])]) {
      fn({ type: 'input', target: editorEl });
    }
    await new Promise((r) => setTimeout(r, 40));
    assert.match(statsBtn.textContent, /^0 轮 0 步 · ~\d+ tok · 0% 缓存$/);

    // Part B: Transition into a newly started conversation while Turn 1 is still streaming (calls === 0)
    home.remove();
    currentCascadeId = '22222222-2222-4222-8222-222222222222';
    const convView = makeEl('div', { attrs: { 'data-testid': 'conversation-view', 'data-cascade-id': currentCascadeId } });
    editorEl.textContent = '';
    currentTraj = {
      trajectory: {
        steps: [
          { status: 3, step: { case: 'userInput', value: { query: 'Hello' } } },
          { status: 1, metadata: { modelUsage: { outputTokens: '64' } }, step: { case: 'plannerResponse', value: { thinking: 'Thinking...' } } },
        ],
        generatorMetadata: [],
      },
    };
    convView.appendChild(inputBox);
    body.appendChild(convView);
    sandbox.window.__agClaudeStyle.refreshConfig({ ...cdp.DEFAULT_CONFIG, ringMode: 'quota' });
    await new Promise((r) => setTimeout(r, 60));

    assert.ok(footer.querySelector('.ag-cs-inline-stats'), 'Expected inline stats during Turn 1 before generatorMetadata');
    assert.ok(footer.querySelector('.ag-cs-context-ring'), 'Expected ring during Turn 1 before generatorMetadata');
    assert.equal(footer.querySelector('.ag-cs-inline-stats')?.textContent, '0 轮 2 步 · ~64 tok · 0% 缓存');
    assert.equal(footer.querySelector('.ag-cs-context-ring span')?.textContent, '42%');

    // Part C: Once Turn 1 completes its first LLM call, stats & ring update in-place and click opens latest data
    currentStatus = 1;
    currentTraj = {
      trajectory: {
        steps: [
          { status: 3, step: { case: 'userInput', value: { query: 'Hello' } } },
          { status: 3, step: { case: 'plannerResponse', value: { response: 'Hi' } } },
        ],
        generatorMetadata: [
          {
            stepIndices: [0, 1],
            metadata: {
              value: {
                modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
                usage: { inputTokens: '1000', cacheReadTokens: '9000', outputTokens: '300' },
                chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 20000, maxContextTokens: 734000 } },
              },
            },
          },
        ],
      },
    };
    doc.hidden = true;
    sandbox.window.__agClaudeStyle.refreshConfig({ ...cdp.DEFAULT_CONFIG, ringMode: 'quota' });
    await new Promise((r) => setTimeout(r, 60));
    doc.hidden = false;

    assert.equal(footer.querySelector('.ag-cs-inline-stats')?.textContent, '1 轮 2 步 · 10.3k tok · 90% 缓存');
    footer.querySelector('.ag-cs-inline-stats')?.dispatch('click');
    const pop = body.querySelector('.ag-cs-ctx-popover');
    assert.ok(pop);
    assert.ok(pop.innerHTML.includes('734.0K'), `Expected updated 734.0K context window in popover, got ${pop.innerHTML}`);

    vm.runInNewContext(cdp.REMOVE_EXPRESSION, sandbox);
    assert.equal(footer.querySelector('.ag-cs-inline-stats'), null);
    assert.equal(footer.querySelector('.ag-cs-context-ring'), null);
  } finally {
    for (const id of timers) clearTimeout(id);
  }
});

test('Q&A takeover card, side-question panel, and running tasks clear Clawd mascot without double spacing', async () => {
  const timers = new Set();
  const makeEl = (tag, opts = {}) => {
    const attrs = new Map(Object.entries(opts.attrs || {}));
    const classes = new Set((opts.className || '').split(/\s+/).filter(Boolean));
    const children = [];
    const matchesSimple = (node, simple) => {
      let rest = simple.trim();
      if (!rest) return false;
      const tagMatch = /^[a-zA-Z0-9_-]+/.exec(rest);
      if (tagMatch) {
        if (node.tagName !== tagMatch[0].toUpperCase()) return false;
        rest = rest.slice(tagMatch[0].length);
      }
      while (rest.length > 0) {
        if (rest[0] === '#') {
          const m = /^#((?:\\.|[a-zA-Z0-9_-])+)/.exec(rest);
          if (!m || node.id !== m[1].replace(/\\/g, '')) return false;
          rest = rest.slice(m[0].length);
        } else if (rest[0] === '.') {
          const m = /^\.([a-zA-Z0-9_-]+)/.exec(rest);
          if (!m || !node.classList.contains(m[1])) return false;
          rest = rest.slice(m[0].length);
        } else if (rest[0] === '[') {
          const m = /^\[([^\]=]+)(?:="([^"]*)")?\]/.exec(rest);
          if (!m) return false;
          const ok = m[2] === undefined ? node.hasAttribute(m[1]) : node.getAttribute(m[1]) === m[2];
          if (!ok) return false;
          rest = rest.slice(m[0].length);
        } else {
          return false;
        }
      }
      return true;
    };
    const matchesChain = (node, selector) =>
      selector.split(',').some((part) => {
        const tokens = part.trim().split(/\s+/).filter(Boolean);
        if (tokens.length === 0 || !matchesSimple(node, tokens[tokens.length - 1])) return false;
        let cur = node.parentElement;
        let idx = tokens.length - 2;
        while (cur && idx >= 0) {
          if (matchesSimple(cur, tokens[idx])) idx -= 1;
          cur = cur.parentElement;
        }
        return idx < 0;
      });
    const node = {
      tagName: tag.toUpperCase(),
      id: attrs.get('id') || opts.id || '',
      children,
      parentElement: null,
      parentNode: null,
      isConnected: true,
      _text: opts.text || '',
      clientWidth: 640,
      offsetWidth: 640,
      clientHeight: 40,
      offsetHeight: 40,
      style: {
        _props: {},
        setProperty(k, v) { this._props[k] = String(v); },
        getPropertyValue(k) { return this._props[k] || ''; },
        removeProperty(k) { delete this._props[k]; },
      },
      classList: {
        contains: (c) => classes.has(c),
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
      },
      get className() { return Array.from(classes).join(' '); },
      set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
      get textContent() { return children.length ? children.map((c) => c.textContent).join('') : this._text; },
      set textContent(v) { children.length = 0; this._text = String(v); },
      get childElementCount() { return children.length; },
      get firstChild() { return children[0] || null; },
      get nextSibling() {
        if (!this.parentElement) return null;
        const i = this.parentElement.children.indexOf(this);
        return i >= 0 ? this.parentElement.children[i + 1] || null : null;
      },
      get lastElementChild() { return children[children.length - 1] || null; },
      appendChild(c) { c.parentElement = this; c.parentNode = this; children.push(c); return c; },
      insertBefore(c, ref) {
        c.parentElement = this;
        c.parentNode = this;
        const idx = ref ? children.indexOf(ref) : -1;
        if (idx >= 0) children.splice(idx, 0, c);
        else children.push(c);
        return c;
      },
      removeChild(c) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); c.parentElement = null; c.parentNode = null; return c; },
      remove() { if (this.parentElement) this.parentElement.removeChild(this); },
      setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'id') node.id = String(v); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      hasAttribute(k) { return attrs.has(k); },
      removeAttribute(k) { attrs.delete(k); },
      addEventListener() {},
      removeEventListener() {},
      getContext() { return null; },
      getBoundingClientRect() { return { left: 0, top: 0, right: 640, bottom: 40, width: 640, height: 40 }; },
      animate() { return { cancel() {}, finished: Promise.resolve() }; },
      closest(sel) { let cur = this; while (cur) { if (matchesChain(cur, sel)) return cur; cur = cur.parentElement; } return null; },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) {
        const out = [];
        const walk = (n) => {
          for (const c of n.children) {
            if (matchesChain(c, sel)) out.push(c);
            walk(c);
          }
        };
        walk(this);
        return out;
      },
    };
    return node;
  };

  const html = makeEl('html');
  const head = makeEl('head');
  const body = makeEl('body', { className: 'theme-dark' });
  html.appendChild(head);
  html.appendChild(body);

  const convView = makeEl('div', { attrs: { 'data-testid': 'conversation-view' } });
  const rtcWrap = makeEl('div', { className: 'relative z-10 flex flex-col gap-1 min-h-0' });
  const takeoverWrap = makeEl('div', { className: 'relative z-[1] mb-1 flex flex-col min-h-0' });
  const takeoverCard = makeEl('div', { className: 'agy-takeover-frame', attrs: { 'data-testid': 'interaction-takeover-card' } });
  takeoverWrap.appendChild(takeoverCard);

  const contentsWrap = makeEl('div', { className: 'contents' });
  const inputBox = makeEl('div', { attrs: { 'data-testid': 'agent-input-box' } });
  const queuedWrap = makeEl('div', { className: 'relative z-[1] flex flex-col gap-2 w-full hidden-if-empty mb-2' });
  const composerShell = makeEl('div', { id: 'antigravity.agentSidePanelInputBox', className: 'surface-composer' });
  const runningWrap = makeEl('div', { className: 'relative z-[1]' });
  const runningPanel = makeEl('div', { className: 'grid grid-rows-[0fr]', attrs: { 'data-testid': 'running-items-panel' } });
  runningWrap.appendChild(runningPanel);
  const card = makeEl('div', { className: 'surface-composer-card' });
  const footer = makeEl('div', { className: 'agy-composer-footer' });
  card.appendChild(footer);
  composerShell.appendChild(runningWrap);
  composerShell.appendChild(card);
  inputBox.appendChild(queuedWrap);
  inputBox.appendChild(composerShell);
  contentsWrap.appendChild(inputBox);

  rtcWrap.appendChild(takeoverWrap);
  rtcWrap.appendChild(contentsWrap);
  convView.appendChild(rtcWrap);
  body.appendChild(convView);

  const doc = {
    documentElement: html,
    head,
    body,
    hidden: false,
    readyState: 'complete',
    createElement: (t) => makeEl(t),
    getElementById: (id) => {
      const find = (n) => (n.id === id ? n : n.children.map(find).find(Boolean) || null);
      return find(html);
    },
    querySelector: (s) => html.querySelector(s),
    querySelectorAll: (s) => html.querySelectorAll(s),
    addEventListener() {},
    removeEventListener() {},
  };

  const sandbox = {
    window: null,
    globalThis: null,
    document: doc,
    navigator: { language: 'zh-CN' },
    location: { pathname: '/' },
    localStorage: { _m: {}, getItem(k) { return this._m[k] || null; }, setItem(k, v) { this._m[k] = String(v); } },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false }),
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 5),
    cancelAnimationFrame: (id) => clearTimeout(id),
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); timers.add(id); return id; },
    clearTimeout: (id) => { timers.delete(id); clearTimeout(id); },
    setInterval: () => 1,
    clearInterval: () => {},
    performance: { now: () => Date.now() },
    Math, Date, JSON, Map, Set, Array, Object, String, Number, Boolean, Promise, Uint8Array, Float32Array, Intl,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  try {
    const res = vm.runInNewContext(cdp.buildInjectExpression(cdp.DEFAULT_CONFIG), sandbox);
    assert.equal(res.status, 'ok');

    // 1. Q&A takeover card alone: wrapper raised by 46px with data-ag-cs-takeover="1"
    assert.equal(takeoverWrap.getAttribute('data-ag-cs-takeover'), '1');
    assert.equal(takeoverWrap.style.getPropertyValue('margin-bottom'), '46px');
    assert.equal(queuedWrap.hasAttribute('data-ag-cs-queued'), false);
    assert.equal(runningWrap.hasAttribute('data-ag-cs-queued'), false);

    // 2. When queued message is also present, queuedWrap takes the 46px clearance and takeoverWrap avoids double spacing
    const queuedItem = makeEl('div', { text: '排队中的消息' });
    queuedWrap.appendChild(queuedItem);
    sandbox.window.__agClaudeStyle.refreshConfig(cdp.DEFAULT_CONFIG);
    assert.equal(queuedWrap.getAttribute('data-ag-cs-queued'), '1');
    assert.equal(queuedWrap.style.getPropertyValue('margin-bottom'), '46px');
    assert.equal(takeoverWrap.hasAttribute('data-ag-cs-takeover'), false);
    assert.equal(takeoverWrap.style.getPropertyValue('margin-bottom'), '');

    // 3. When queued clears and side-question-panel sits below takeoverWrap, side-question-panel takes clearance
    queuedItem.remove();
    const sideQ = makeEl('div', { attrs: { 'data-testid': 'side-question-panel' } });
    rtcWrap.insertBefore(sideQ, contentsWrap);
    sandbox.window.__agClaudeStyle.refreshConfig(cdp.DEFAULT_CONFIG);
    assert.equal(sideQ.getAttribute('data-ag-cs-takeover'), '1');
    assert.equal(sideQ.style.getPropertyValue('margin-bottom'), '46px');
    assert.equal(takeoverWrap.hasAttribute('data-ag-cs-takeover'), false);

    // 4. When running-items-panel expands (grid-rows-[1fr]), its wrapper takes the 46px clearance
    runningPanel.className = 'grid grid-rows-[1fr]';
    sandbox.window.__agClaudeStyle.refreshConfig(cdp.DEFAULT_CONFIG);
    assert.equal(runningWrap.getAttribute('data-ag-cs-queued'), '1');
    assert.equal(runningWrap.style.getPropertyValue('margin-bottom'), '46px');
    assert.equal(sideQ.hasAttribute('data-ag-cs-takeover'), false);
    assert.equal(takeoverWrap.hasAttribute('data-ag-cs-takeover'), false);

    // 5. Turning mascot off clears all takeover/queued clearances cleanly
    runningPanel.className = 'grid grid-rows-[0fr]';
    sideQ.remove();
    sandbox.window.__agClaudeStyle.refreshConfig({ ...cdp.DEFAULT_CONFIG, mascot: 'off' });
    assert.equal(takeoverWrap.hasAttribute('data-ag-cs-takeover'), false);
    assert.equal(takeoverWrap.style.getPropertyValue('margin-bottom'), '');
    assert.equal(runningWrap.hasAttribute('data-ag-cs-queued'), false);

    // 6. Re-enable crab, verify takeover clearance returns, then verify REMOVE_EXPRESSION tears down cleanly
    sandbox.window.__agClaudeStyle.refreshConfig(cdp.DEFAULT_CONFIG);
    assert.equal(takeoverWrap.getAttribute('data-ag-cs-takeover'), '1');
    assert.equal(takeoverWrap.style.getPropertyValue('margin-bottom'), '46px');
    vm.runInNewContext(cdp.REMOVE_EXPRESSION, sandbox);
    assert.equal(takeoverWrap.hasAttribute('data-ag-cs-takeover'), false);
    assert.equal(takeoverWrap.style.getPropertyValue('margin-bottom'), '');

    const injectedCss = cdp.buildInjectExpression(cdp.DEFAULT_CONFIG);
    assert.ok(injectedCss.includes('interaction-takeover-card'));
    assert.ok(injectedCss.includes('side-question-panel'));
  } finally {
    for (const id of timers) clearTimeout(id);
  }
});
