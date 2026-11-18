import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const cdp = require(path.join(ROOT_DIR, 'cdp.js'));

function matchesSimple(el, sel) {
  sel = sel.trim();
  if (!sel || !el || !el.tagName) return false;
  const m = sel.match(/^([a-zA-Z0-9*]*)((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/);
  if (!m) return false;
  const [, tag, classPart, attrPart] = m;
  if (tag && tag !== '*' && el.tagName !== tag.toUpperCase()) return false;
  for (const c of classPart.split('.').filter(Boolean)) {
    if (!el.classList.contains(c)) return false;
  }
  for (const a of attrPart.match(/\[[^\]]+\]/g) || []) {
    const am = a.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
    if (!am) return false;
    const v = el.getAttribute(am[1]);
    if (v === null) return false;
    if (am[2] !== undefined && v !== am[2]) return false;
  }
  return true;
}

function matches(el, selector) {
  return selector.split(',').some((part) => {
    const chain = part.trim().split(/\s+/);
    if (!matchesSimple(el, chain[chain.length - 1])) return false;
    let cur = el.parentElement;
    for (let i = chain.length - 2; i >= 0; i--) {
      while (cur && !matchesSimple(cur, chain[i])) cur = cur.parentElement;
      if (!cur) return false;
      cur = cur.parentElement;
    }
    return true;
  });
}

function createFakeDom() {
  const docListeners = [];
  const winListeners = [];
  const elProto = {
    get isConnected() {
      let cur = this;
      while (cur.parentElement) cur = cur.parentElement;
      return cur === doc.documentElement;
    },
    get firstChild() {
      return this.children[0] || null;
    },
    getAttribute(k) {
      return this._attrs.has(k) ? this._attrs.get(k) : null;
    },
    setAttribute(k, v) {
      this._attrs.set(k, String(v));
    },
    removeAttribute(k) {
      this._attrs.delete(k);
    },
    hasAttribute(k) {
      return this._attrs.has(k);
    },
    appendChild(child) {
      if (child.parentElement) child.remove();
      child.parentElement = this;
      this.children.push(child);
      return child;
    },
    insertBefore(newNode, refNode) {
      if (!refNode) return this.appendChild(newNode);
      if (newNode.parentElement) newNode.remove();
      const idx = this.children.indexOf(refNode);
      if (idx === -1) return this.appendChild(newNode);
      newNode.parentElement = this;
      this.children.splice(idx, 0, newNode);
      return newNode;
    },
    remove() {
      if (!this.parentElement) return;
      const sib = this.parentElement.children;
      const idx = sib.indexOf(this);
      if (idx >= 0) sib.splice(idx, 1);
      this.parentElement = null;
    },
    addEventListener(type, fn) {
      (this._listeners[type] ||= []).push(fn);
    },
    dispatchEvent(ev) {
      const event = { target: this, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...ev };
      for (const fn of this._listeners[event.type] || []) fn(event);
      return true;
    },
    dispatch(type, ev = {}) {
      const event = { target: this, type, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...ev };
      for (const fn of this._listeners[type] || []) fn(event);
      return event;
    },
    click() {
      this.clicked = (this.clicked || 0) + 1;
      if (this.tagName === 'INPUT' && this._attrs.get('type') === 'checkbox') {
        this.checked = !this.checked;
      }
      this.dispatch('click');
    },
    focus() {
      doc.activeElement = this;
    },
    getBoundingClientRect() {
      return this._rect || { top: 0, left: 0, width: 320, height: 120 };
    },
    scrollIntoView() {},
    closest(sel) {
      let cur = this;
      while (cur && cur.tagName) {
        if (matches(cur, sel)) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
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
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    },
  };

  function makeEl(tag, { attrs = {}, text = '', className = '', checked = false, rect = null } = {}) {
    const el = Object.create(elProto);
    el.tagName = tag.toUpperCase();
    el.children = [];
    el.parentElement = null;
    el.disabled = false;
    el.checked = checked;
    el._rect = rect;
    el._attrs = new Map(Object.entries(attrs));
    el._listeners = {};
    el._text = text;
    el.style = {
      _props: new Map(),
      setProperty(k, v) {
        this._props.set(k, v);
      },
      removeProperty(k) {
        this._props.delete(k);
      },
      getPropertyValue(k) {
        return this._props.get(k) || '';
      },
    };
    const classSet = new Set(className.split(/\s+/).filter(Boolean));
    el.classList = {
      contains: (c) => classSet.has(c),
      add: (c) => classSet.add(c),
      remove: (c) => classSet.delete(c),
    };
    Object.defineProperty(el, 'className', {
      get: () => [...classSet].join(' '),
      set: (v) => {
        classSet.clear();
        for (const c of String(v).split(/\s+/).filter(Boolean)) classSet.add(c);
      },
    });
    Object.defineProperty(el, 'textContent', {
      get: () => el._text + el.children.map((c) => c.textContent).join(''),
      set: (v) => {
        el._text = String(v);
        el.children = [];
      },
    });
    Object.defineProperty(el, 'innerHTML', {
      get: () => el.textContent,
      set: (v) => {
        if (v === '') {
          el._text = '';
          el.children = [];
        } else {
          el._text = String(v);
          el.children = [];
        }
      },
    });
    return el;
  }

  const html = makeEl('html');
  const body = makeEl('body');
  html.appendChild(body);

  const doc = {
    documentElement: html,
    body,
    activeElement: body,
    createElement: (tag) => makeEl(tag),
    createRange: () => ({ selectNodeContents() {} }),
    execCommand: () => false,
    querySelectorAll: (sel) => html.querySelectorAll(sel),
    querySelector: (sel) => html.querySelector(sel),
    addEventListener(type, fn, cap) {
      docListeners.push({ type, fn, cap: Boolean(cap) });
    },
    removeEventListener(type, fn, cap) {
      for (let i = docListeners.length - 1; i >= 0; i--) {
        const l = docListeners[i];
        if (l.type === type && l.fn === fn && l.cap === Boolean(cap)) docListeners.splice(i, 1);
      }
    },
  };

  const win = {
    location: { pathname: '/c/11111111-2222-3333-4444-555555555555' },
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    addEventListener(type, fn, cap) {
      winListeners.push({ type, fn, cap: Boolean(cap) });
    },
    removeEventListener(type, fn, cap) {
      for (let i = winListeners.length - 1; i >= 0; i--) {
        const l = winListeners[i];
        if (l.type === type && l.fn === fn && l.cap === Boolean(cap)) winListeners.splice(i, 1);
      }
    },
    emitKeyDown(ev) {
      for (const l of [...winListeners]) {
        if (l.type === 'keydown') l.fn(ev);
      }
    },
    emitDocClick(ev) {
      for (const l of [...docListeners]) {
        if (l.type === 'click') l.fn(ev);
      }
    },
  };

  return { doc, win, html, body, makeEl, docListeners, winListeners };
}

function loadFeatureInDom(dom, cfgOverride = {}) {
  const src = fs.readFileSync(path.join(ROOT_DIR, 'ui-rewind.js'), 'utf8');
  const sandbox = {
    document: dom.doc,
    window: dom.win,
    Event: class Event {
      constructor(type, init = {}) {
        this.type = type;
        Object.assign(this, init);
      }
    },
    InputEvent: class InputEvent {
      constructor(type, init = {}) {
        this.type = type;
        Object.assign(this, init);
      }
    },
    TextEncoder,
    WeakSet,
    Set,
    Map,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Math,
    Date,
    Promise,
    setTimeout: (fn, ms) => setTimeout(fn, typeof ms === 'number' ? ms : 0),
    clearTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox);

  let cfg = { ...cdp.DEFAULT_CONFIG, ...cfgOverride };
  let destroyed = false;
  const feature = sandbox.__agCsFeatures.rewind;
  const inst = feature.create({
    getCfg: () => cfg,
    getUi: () => ({}),
    isDestroyed: () => destroyed,
  });

  return {
    feature,
    inst,
    setCfg(next) {
      cfg = { ...cfg, ...next };
    },
    destroy() {
      destroyed = true;
      inst.destroy();
    },
  };
}

function buildConversationTree(dom, turnsSpec, { svc, stepHandler } = {}) {
  const conv = dom.makeEl('div', { attrs: { 'data-testid': 'conversation-view', 'data-cascade-id': 'cid-test-1' } });
  for (const t of turnsSpec) {
    const wrap = dom.makeEl('div');
    const step = dom.makeEl('div', { attrs: { 'data-testid': 'user-input-step' }, text: t.text, rect: { top: t.top, left: 0, width: 300, height: 24 } });
    const undoBtn = dom.makeEl('button', { attrs: { 'aria-label': 'Undo to here' }, text: 'Undo' });
    wrap.appendChild(step);
    wrap.appendChild(undoBtn);
    conv.appendChild(wrap);
  }

  const inputBox = dom.makeEl('div', { attrs: { 'data-testid': 'agent-input-box' } });
  const shell = dom.makeEl('div', { className: 'composer-shell' });
  const card = dom.makeEl('div', { className: 'surface-composer-card' });
  const editor = dom.makeEl('div', { attrs: { contenteditable: 'true' } });
  card.appendChild(editor);
  shell.appendChild(card);
  inputBox.appendChild(shell);
  conv.appendChild(inputBox);
  dom.body.appendChild(conv);

  if (svc || stepHandler) {
    conv.__reactFiber$test = {
      dependencies: {
        firstContext: {
          memoizedValue: svc || {},
          next: stepHandler ? { memoizedValue: { stepHandler }, next: null } : null,
        },
      },
      return: null,
    };
  }

  return { conv, inputBox, shell, card, editor };
}

test('ui-rewind: /rewind opens inline Step 1 bar above composer with trajectory turns and no popup backdrop', async () => {
  const dom = createFakeDom();
  const reverts = [];
  const previewsMap = new Map([
    [
      0,
      [
        {
          fileUri: 'file:///repo/app.js',
          actionType: 1,
          diff: { lines: [{ type: 1, text: 'new' }, { type: 2, text: 'old' }] },
        },
      ],
    ],
    [2, []],
  ]);

  const { editor } = buildConversationTree(
    dom,
    [
      { text: 'First prompt', top: 10 },
      { text: 'Second prompt', top: 100 },
    ],
    {
      svc: {
        async getCascadeTrajectory() {
          return {
            trajectory: {
              steps: [
                { step: { case: 'welcome' } },
                { step: { case: 'userInput', value: { query: 'First\u200B  full   prompt line' } }, metadata: { createdAt: Date.now() - 120000 } },
                { step: { case: 'modelResponse' } },
                { step: { case: 'userInput', value: { query: 'Second prompt' } }, metadata: { createdAt: Date.now() - 10000 } },
              ],
            },
          };
        },
      },
      stepHandler: {
        async getRevertPreviews(cid, revertIdx) {
          return previewsMap.get(revertIdx) || [];
        },
        async revertToIndex(cid, idx, opts) {
          reverts.push({ cid, idx, opts });
        },
      },
    }
  );

  const { inst, destroy } = loadFeatureInDom(dom);
  try {
    editor.textContent = '/rewind';
    const enterEv = {
      type: 'keydown',
      key: 'Enter',
      target: editor,
      preventDefault() {},
      stopPropagation() {},
      stopImmediatePropagation() {},
    };
    const consumed = inst.onKeyDown(enterEv);
    assert.equal(consumed, true);
    assert.equal(editor.textContent, '');

    // Must mount inline inside composer-shell before card, with NO modal backdrop
    assert.equal(dom.doc.querySelector('.ag-cs-rewind-backdrop'), null);
    const bar = dom.doc.querySelector('.composer-shell .ag-cs-rewind-bar');
    assert.ok(bar, 'Inline rewind bar should mount inside .composer-shell above .surface-composer-card');
    assert.equal(bar.parentElement.classList.contains('composer-shell'), true);

    await new Promise((r) => setTimeout(r, 10));

    const items = bar.querySelectorAll('.ag-cs-rewind-item');
    assert.equal(items.length, 3);
    assert.equal(items[0].querySelector('.ag-cs-rewind-item-msg').textContent, 'First full prompt line');
    assert.equal(items[2].querySelector('.ag-cs-rewind-item-msg').textContent, '(current)');

    // Move up to first turn and press Enter -> Step 2 shows 3 restore options + cancel
    dom.win.emitKeyDown({ key: 'ArrowUp', preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
    dom.win.emitKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });

    await new Promise((r) => setTimeout(r, 10));
    const optKeys = bar.querySelectorAll('.ag-cs-rewind-opt').map((b) => b.getAttribute('data-rewind-opt'));
    assert.deepEqual(optKeys, ['both', 'conversation', 'code', 'nevermind']);
    assert.ok(bar.querySelector('.ag-cs-rewind-impact').textContent.includes('app.js'));

    // Choose option '2' (conversation only) -> calls revertToIndex(conversationOnly: true) & restores fullText
    dom.win.emitKeyDown({ key: '2', preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(dom.doc.querySelector('.ag-cs-rewind-bar'), null);
    assert.equal(reverts.length, 1);
    assert.equal(reverts[0].cid, 'cid-test-1');
    assert.equal(reverts[0].idx, 0);
    assert.equal(reverts[0].opts.conversationOnly, true);
    assert.equal(editor.textContent, 'First full prompt line');

    // Re-open, pick turn 2 (no code changes -> hides 'both' and 'code')
    inst.open();
    await new Promise((r) => setTimeout(r, 10));
    dom.win.emitKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
    await new Promise((r) => setTimeout(r, 10));
    const noCodeBar = dom.doc.querySelector('.ag-cs-rewind-bar');
    assert.deepEqual(
      noCodeBar.querySelectorAll('.ag-cs-rewind-opt').map((b) => b.getAttribute('data-rewind-opt')),
      ['conversation', 'nevermind']
    );
  } finally {
    destroy();
  }
});

test('ui-rewind: double-Esc deduplicates identical KeyboardEvent across window & document listeners', () => {
  const dom = createFakeDom();
  const { editor } = buildConversationTree(dom, [{ text: 'Turn A', top: 10 }]);
  editor.focus();
  const { inst, destroy } = loadFeatureInDom(dom);
  try {
    const sharedEv1 = { key: 'Escape', preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} };
    // Simulate both window capture listener and ui-runtime onDocKeyDown forwarding the SAME event
    dom.win.emitKeyDown(sharedEv1);
    inst.onEscape(sharedEv1, { hadPopover: false });
    assert.equal(dom.doc.querySelector('.ag-cs-rewind-bar'), null, 'Single Esc must NOT trigger twice');

    const secondEscEv = { key: 'Escape', preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} };
    dom.win.emitKeyDown(secondEscEv);
    assert.ok(dom.doc.querySelector('.ag-cs-rewind-bar'), 'Second distinct Esc must open Rewind bar');
  } finally {
    destroy();
  }
});

test('ui-rewind: code-only restore writes file via svc.writeFile and warns about created files', async () => {
  const dom = createFakeDom();
  const written = [];
  buildConversationTree(
    dom,
    [{ text: 'Turn A', top: 10 }],
    {
      svc: {
        async getCascadeTrajectory() {
          return {
            trajectory: {
              steps: [{ step: { case: 'userInput', value: { query: 'Turn A' } } }],
            },
          };
        },
        async writeFile(arg) {
          written.push(arg);
        },
      },
      stepHandler: {
        async getRevertPreviews() {
          return [
            {
              fileUri: 'file:///repo/mod.js',
              actionType: 1,
              diff: { lines: [{ type: 2, text: 'removed' }, { type: 1, text: 'keep' }] },
            },
            {
              fileUri: 'file:///repo/created.js',
              actionType: 3,
              diff: { lines: [{ type: 2, text: 'created' }] },
            },
          ];
        },
        async revertToIndex() {
          throw new Error('should not revert conversation');
        },
      },
    }
  );

  const { inst, destroy } = loadFeatureInDom(dom);
  try {
    inst.open();
    await new Promise((r) => setTimeout(r, 10));
    dom.win.emitKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
    await new Promise((r) => setTimeout(r, 10));

    dom.win.emitKeyDown({ key: '3', preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(written.length, 1);
    assert.equal(written[0].uri, 'file:///repo/mod.js');
    assert.equal(new TextDecoder().decode(written[0].content), 'keep');
    const notice = dom.doc.querySelector('.ag-cs-rewind-notice');
    assert.ok(notice && notice.textContent.includes('created.js'));
  } finally {
    destroy();
  }
});

test('ui-rewind: native Undo button click opens Step 2 in picker mode and auto-confirms dialog in auto modes', async () => {
  const dom = createFakeDom();
  buildConversationTree(dom, [{ text: 'Target turn', top: 10 }]);
  const undoBtn = dom.doc.querySelector('[data-testid="conversation-view"] button');
  const { inst, setCfg, destroy } = loadFeatureInDom(dom, { undoConfirmMode: 'picker' });

  try {
    dom.win.emitDocClick({
      target: undoBtn,
      preventDefault() {},
      stopPropagation() {},
      stopImmediatePropagation() {},
    });
    const bar = dom.doc.querySelector('.ag-cs-rewind-bar');
    assert.ok(bar, 'Undo click in picker mode opens inline Step 2 Rewind bar');
    assert.equal(bar.querySelectorAll('.ag-cs-rewind-opt').length, 4);

    // Cancel closes cleanly
    dom.win.emitKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
    assert.equal(dom.doc.querySelector('.ag-cs-rewind-bar'), null);

    // Switch to auto_chat -> handles Confirm Undo dialog with checkbox unchecked
    setCfg({ undoConfirmMode: 'auto_chat' });
    const dialog = dom.makeEl('div', { attrs: { role: 'dialog' } });
    dialog.appendChild(dom.makeEl('h2', { text: 'Confirm Undo' }));
    const cb = dom.makeEl('input', { attrs: { type: 'checkbox' }, checked: true });
    const okBtn = dom.makeEl('button', { text: 'Confirm' });
    dialog.appendChild(cb);
    dialog.appendChild(okBtn);
    dom.body.appendChild(dialog);

    inst.sync();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(cb.checked, false);
    assert.equal(okBtn.clicked, 1);
  } finally {
    destroy();
  }
});
