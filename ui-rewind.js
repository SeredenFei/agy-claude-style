// Claude Code-style two-step inline Rewind & Quick Undo feature for AGY Claude Style.
//
// Feature module contract (see ui-runtime.js "Feature host"):
//   create(ctx) -> { ownSelector, sync(), onKeyDown(ev) -> boolean, onEscape(ev, info), open(), destroy() }
//   ctx = { getCfg(), getUi(), isDestroyed() }
(function (root, factory) {
  const feature = factory();
  if (typeof module === 'object' && module.exports) module.exports = feature;
  else {
    root.__agCsFeatures = root.__agCsFeatures || {};
    root.__agCsFeatures.rewind = feature;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  const UNDO_DIALOG_TITLES = ['Confirm Undo', '确认撤销', '確認復原', '確認還原', '元に戻す確認'];
  const UNDO_CONFIRM_LABELS = ['Confirm', '确认', '確認', '確定'];
  const UNDO_CANCEL_LABELS = ['Cancel', '取消', 'キャンセル'];
  const UNDO_BTN_HINTS = ['undo', 'revert', '撤销', '復原', '還原', '元に戻す'];
  const COMPOSER_EDITOR_SEL = '[data-testid="agent-input-box"] [contenteditable="true"]';
  const DOUBLE_ESC_WINDOW_MS = 650;
  const PENDING_ACTION_TTL_MS = 2500;
  const PAGE_STEP = 5;

  function stripZeroWidth(s) {
    return String(s || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normTxt(s) {
    return stripZeroWidth(s);
  }

  function stepPromptText(stepEl) {
    if (!stepEl) return '';
    const parts = [];
    const walk = (node) => {
      if (node.nodeType === 3) {
        parts.push(node.nodeValue || '');
        return;
      }
      if (node.tagName === 'BUTTON') return;
      const kids = node.childNodes && node.childNodes.length ? node.childNodes : null;
      if (!kids) {
        if (node.children && node.children.length) {
          for (const c of node.children) walk(c);
        } else {
          parts.push(node.textContent || '');
        }
        return;
      }
      for (const c of kids) walk(c);
    };
    walk(stepEl);
    return normTxt(parts.join(' '));
  }

  function extractUserStepText(stepItem) {
    const v = stepItem?.step?.value;
    if (!v) return '';
    const items = Array.isArray(v.items) ? v.items : [];
    const joined = items.map((it) => it?.chunk?.value || it?.value || '').join(' ');
    return normTxt(joined || v.query || v.userResponse || '');
  }

  function extractStepTimestampMs(stepItem) {
    const ts = stepItem?.metadata?.createdAt || stepItem?.metadata?.timestamp;
    if (!ts) return 0;
    if (typeof ts === 'number') return ts;
    if (typeof ts === 'string') {
      const p = Date.parse(ts);
      return Number.isFinite(p) ? p : 0;
    }
    if (ts && typeof ts.seconds !== 'undefined') {
      return Number(ts.seconds) * 1000;
    }
    return 0;
  }

  function formatShortAge(tsMs) {
    if (!tsMs) return '';
    const sec = Math.max(0, Math.floor((Date.now() - tsMs) / 1000));
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    return `${Math.floor(hr / 24)}d ago`;
  }

  function formatClaudeFilesList(files, lang) {
    if (!files || !files.length) return '';
    if (files.length === 1) return files[0];
    if (files.length === 2) {
      return lang && lang.startsWith('zh') ? `${files[0]} 和 ${files[1]}` : `${files[0]} and ${files[1]}`;
    }
    const rest = files.length - 1;
    if (lang === 'zh-CN') return `${files[0]} 等共 ${files.length} 个文件`;
    if (lang === 'zh-TW' || lang === 'yue') return `${files[0]} 等共 ${files.length} 個檔案`;
    if (lang === 'ja') return `${files[0]} ほか計 ${files.length} ファイル`;
    return `${files[0]} and ${rest} other files`;
  }

  function findFiberApis() {
    const anchors = document.querySelectorAll(
      '[data-testid="user-input-step"], [data-testid="conversation-view"], [data-testid="agent-input-box"]'
    );
    let svc = null;
    let stepHandler = null;
    for (const el of anchors) {
      const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
      for (let f = key && el[key]; f; f = f.return) {
        for (let d = f.dependencies && f.dependencies.firstContext; d; d = d.next) {
          const v = d.memoizedValue;
          if (!v || typeof v !== 'object') continue;
          if (!svc && typeof v.getCascadeTrajectory === 'function') svc = v;
          if (!stepHandler && v.stepHandler && typeof v.stepHandler.revertToIndex === 'function') {
            stepHandler = v.stepHandler;
          }
        }
      }
      if (svc && stepHandler) break;
    }
    return { svc, stepHandler };
  }

  function findComposerMountSlot() {
    const boxes = Array.from(document.querySelectorAll('[data-testid="agent-input-box"]'));
    const activeBox =
      (document.activeElement?.closest && document.activeElement.closest('[data-testid="agent-input-box"]')) ||
      boxes.find((b) => {
        const r = typeof b.getBoundingClientRect === 'function' ? b.getBoundingClientRect() : null;
        return r && r.width > 0 && r.height > 0;
      }) ||
      boxes[0];
    if (!activeBox) return null;
    const card = activeBox.querySelector('.surface-composer-card');
    if (card && card.parentElement) {
      const shell = card.parentElement;
      const anchor = shell.querySelector('.ag-cs-hud-top-bar') || card;
      return { parent: shell, before: anchor, box: activeBox, card };
    }
    return { parent: activeBox, before: activeBox.firstChild || null, box: activeBox, card: null };
  }

  function resolveCascadeId(boxEl) {
    const targets = [boxEl, document.querySelector('[data-testid="conversation-view"]')].filter(Boolean);
    for (const el of targets) {
      const attrCid = el.getAttribute?.('data-cascade-id');
      if (attrCid) return attrCid;
      const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
      for (let f = key && el[key]; f; f = f.return) {
        for (const src of [f.memoizedProps, f.pendingProps, f.memoizedState]) {
          if (src && typeof src === 'object' && typeof src.cascadeId === 'string' && src.cascadeId) {
            return src.cascadeId;
          }
        }
      }
    }
    const m = String(window.location?.pathname || '').match(/\/c\/([0-9a-f-]{20,})/i);
    return m ? m[1] : null;
  }

  function create(ctx) {
    const getCfg = () => (ctx && typeof ctx.getCfg === 'function' ? ctx.getCfg() : {}) || {};
    const getUi = () => (ctx && typeof ctx.getUi === 'function' ? ctx.getUi() : {}) || {};
    const isDestroyed = () => Boolean(ctx && typeof ctx.isDestroyed === 'function' && ctx.isDestroyed());

    let openRewindBar = null;
    let noticeBar = null;
    let rewindState = null;
    let pendingRewindAction = null;
    let bypassUndoInterceptBtn = null;
    let lastEmptyEscAt = 0;
    const handledKeyEvents = typeof WeakSet === 'function' ? new WeakSet() : null;
    const handledEscEvents = typeof WeakSet === 'function' ? new WeakSet() : null;

    function isUndoConfirmDialog(dialog) {
      if (!dialog || dialog.closest?.('.ag-cs-rewind-bar, .ag-cs-rewind-backdrop')) return false;
      const heading = dialog.querySelector('h1, h2, h3, [role="heading"], .font-semibold, .font-medium');
      const titleText = normTxt(heading ? heading.textContent : '');
      if (titleText && UNDO_DIALOG_TITLES.some((t) => titleText.includes(t))) return true;
      const fullText = normTxt(dialog.textContent);
      return UNDO_DIALOG_TITLES.some((t) => fullText.startsWith(t));
    }

    function setCheckboxState(cb, desired) {
      if (!cb) return;
      const isChecked = cb.tagName === 'INPUT' ? Boolean(cb.checked) : cb.getAttribute('aria-checked') === 'true';
      if (isChecked !== Boolean(desired)) cb.click();
    }

    function findDialogConfirmButton(dialog) {
      const btns = Array.from(dialog.querySelectorAll('button'));
      return btns.find((b) => {
        if (b.disabled) return false;
        const t = normTxt(b.textContent);
        if (!t || UNDO_CANCEL_LABELS.some((c) => t.includes(c))) return false;
        return UNDO_CONFIRM_LABELS.some((ok) => t.includes(ok));
      });
    }

    function resolveDesiredRevertFiles() {
      if (pendingRewindAction && Date.now() <= pendingRewindAction.expiresAt) {
        const revert = pendingRewindAction.revertFiles;
        pendingRewindAction = null;
        return revert;
      }
      const mode = getCfg().undoConfirmMode;
      if (mode === 'auto_both') return true;
      if (mode === 'auto_chat') return false;
      return null;
    }

    function processUndoConfirmDialogs() {
      if (isDestroyed()) return;
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      for (const dialog of dialogs) {
        if (dialog.getAttribute('data-ag-cs-undo-handled') === '1') continue;
        if (!isUndoConfirmDialog(dialog)) continue;
        const desiredRevert = resolveDesiredRevertFiles();
        if (desiredRevert === null) continue;
        dialog.setAttribute('data-ag-cs-undo-handled', '1');
        dialog.style.opacity = '0';
        dialog.style.pointerEvents = 'none';
        const cb = dialog.querySelector('input[type="checkbox"], [role="checkbox"], button[aria-checked]');
        setCheckboxState(cb, desiredRevert);
        setTimeout(() => {
          if (isDestroyed() || !dialog.isConnected) return;
          const confirmBtn = findDialogConfirmButton(dialog);
          if (confirmBtn) confirmBtn.click();
          else {
            dialog.style.removeProperty('opacity');
            dialog.style.removeProperty('pointer-events');
          }
        }, 24);
      }
    }

    function isUndoActionButton(btn) {
      if (!btn || btn.tagName !== 'BUTTON') return false;
      const label = (
        btn.getAttribute('aria-label') ||
        btn.getAttribute('title') ||
        btn.textContent ||
        ''
      ).toLowerCase();
      return UNDO_BTN_HINTS.some((h) => label.includes(h));
    }

    function findClickedUndoButton(ev) {
      const c = getCfg();
      if (c.rewindPanel === false || c.undoConfirmMode !== 'picker') return null;
      const target = ev?.target;
      if (!target || !target.closest) return null;
      if (target.closest('.ag-cs-rewind-bar, .ag-cs-rewind-backdrop, #ag-cs-settings-sec')) return null;
      const btn = target.closest('button');
      if (!btn || btn === bypassUndoInterceptBtn) return null;
      if (!isUndoActionButton(btn)) return null;
      if (btn.closest('[role="dialog"]')) return null;
      return btn;
    }

    function findUndoButtonForStep(stepEl) {
      if (!stepEl) return null;
      const inside = Array.from(stepEl.querySelectorAll('button')).find(isUndoActionButton);
      if (inside) return inside;
      let cur = stepEl.parentElement;
      for (let depth = 0; depth < 4 && cur; depth++, cur = cur.parentElement) {
        if (cur.querySelectorAll('[data-testid="user-input-step"]').length > 1) break;
        const found = Array.from(cur.querySelectorAll('button')).find(isUndoActionButton);
        if (found) return found;
      }
      return null;
    }

    function collectRewindTurnsDom() {
      const steps = Array.from(document.querySelectorAll('[data-testid="user-input-step"]'));
      const allUndoBtns = Array.from(document.querySelectorAll('button')).filter(
        (b) => isUndoActionButton(b) && !b.closest('[role="dialog"]') && !b.closest('.ag-cs-rewind-bar')
      );
      const items = [];
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const fullText = stepPromptText(step);
        const text = fullText.slice(0, 140) || `#${i + 1}`;
        const undoBtn = findUndoButtonForStep(step) || (allUndoBtns.length === steps.length ? allUndoBtns[i] : null);
        if (undoBtn) {
          let top = i;
          try {
            const r = typeof step.getBoundingClientRect === 'function' ? step.getBoundingClientRect() : null;
            if (r && Number.isFinite(r.top)) top = r.top;
          } catch {}
          items.push({ domIdx: i, top, text, fullText: fullText || text, undoBtn });
        }
      }
      items.sort((a, b) => (a.top !== b.top ? a.top - b.top : a.domIdx - b.domIdx));
      return items.map((it, idx) => ({
        index: idx + 1,
        text: it.text,
        fullText: it.fullText,
        undoBtn: it.undoBtn,
        isCurrent: false,
        diffMeta: null,
      }));
    }

    function buildTurnsFromTrajectory(traj, cascadeId) {
      const steps = traj?.trajectory?.steps || [];
      const domTurns = collectRewindTurnsDom();
      const turns = [];
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        if (s?.step?.case === 'userInput') {
          const fullText = extractUserStepText(s);
          const text = fullText.slice(0, 140) || `#${turns.length + 1}`;
          const tsMs = extractStepTimestampMs(s);
          const matchedDom = domTurns.find((d) => d.text.slice(0, 32) === text.slice(0, 32));
          turns.push({
            index: turns.length + 1,
            stepIndex: i,
            cascadeId,
            text,
            fullText: fullText || text,
            tsMs,
            undoBtn: matchedDom?.undoBtn || null,
            isCurrent: false,
            diffMeta: null,
          });
        }
      }
      return turns;
    }

    function findTurnForUndoButton(btn) {
      const turns = collectRewindTurnsDom();
      const matched = turns.find((t) => t.undoBtn === btn);
      if (matched) return { turns, turn: matched };
      let cur = btn.parentElement;
      let fullText = '';
      for (let depth = 0; depth < 4 && cur; depth++, cur = cur.parentElement) {
        const step = cur.querySelector('[data-testid="user-input-step"]');
        if (step) {
          fullText = stepPromptText(step);
          break;
        }
      }
      const text = fullText.slice(0, 140);
      return {
        turns,
        turn: {
          index: Math.max(1, turns.length),
          text: text || normTxt(btn.getAttribute('aria-label') || btn.getAttribute('title') || 'Undo'),
          fullText: fullText || text || '',
          undoBtn: btn,
          isCurrent: false,
          diffMeta: null,
        },
      };
    }

    function parseRevertPreviewsMeta(previews, ui) {
      if (!Array.isArray(previews)) return null;
      if (!previews.length) {
        return {
          files: [],
          additions: 0,
          deletions: 0,
          canRestoreCode: false,
          previews: [],
          label: ui.rewindNoCodeChanges || 'No code changes',
        };
      }
      const files = [];
      let additions = 0;
      let deletions = 0;
      for (const p of previews) {
        const uri = String(p?.fileUri || p?.uri || '');
        if (uri) {
          const clean = uri.split('?')[0];
          const parts = clean.split('/');
          const base = parts[parts.length - 1] || clean;
          if (base && !files.includes(base)) files.push(base);
        }
        const lines = Array.isArray(p?.diff?.lines) ? p.diff.lines : [];
        for (const ln of lines) {
          if (ln?.type === 1) additions++;
          else if (ln?.type === 2) deletions++;
        }
      }
      return { files, additions, deletions, canRestoreCode: true, previews };
    }

    function getStep2Options(turn, ui) {
      const canRestoreCode = turn?.diffMeta ? Boolean(turn.diffMeta.canRestoreCode) : true;
      const opts = [];
      if (canRestoreCode) {
        opts.push({ key: 'both', label: ui.rewindOptBoth || '回退代码和对话' });
        opts.push({ key: 'conversation', label: ui.rewindOptChat || '回退对话' });
        opts.push({ key: 'code', label: ui.rewindOptCode || '回退代码' });
      } else {
        opts.push({ key: 'conversation', label: ui.rewindOptChat || '回退对话' });
      }
      opts.push({ key: 'nevermind', label: ui.rewindOptCancel || '取消' });
      return opts.map((o, idx) => ({ ...o, num: `${idx + 1}.` }));
    }

    function findComposerEditor() {
      const eds = Array.from(document.querySelectorAll(COMPOSER_EDITOR_SEL));
      return eds.find((ed) => !ed.closest?.('[data-testid="subagent-tab-conversation"]')) || eds[0] || null;
    }

    function fillComposerText(text) {
      const ed = findComposerEditor();
      if (!ed) return false;
      try {
        if (typeof ed.focus === 'function') ed.focus();
        const sel = window.getSelection ? window.getSelection() : null;
        if (sel && document.createRange) {
          const range = document.createRange();
          range.selectNodeContents(ed);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        let inserted = false;
        if (typeof document.execCommand === 'function') {
          inserted = document.execCommand('insertText', false, text);
        }
        if (!inserted || stripZeroWidth(ed.textContent) !== stripZeroWidth(text)) {
          ed.textContent = text;
          if (typeof InputEvent === 'function') {
            ed.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
          } else {
            ed.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }
        return true;
      } catch {
        return false;
      }
    }

    function restorePromptIntoComposer(promptText) {
      const cleanText = String(promptText || '').trim();
      if (!cleanText) return;
      fillComposerText(cleanText);
      setTimeout(() => {
        if (isDestroyed()) return;
        const ed = findComposerEditor();
        if (ed && !stripZeroWidth(ed.textContent)) {
          fillComposerText(cleanText);
        }
      }, 120);
    }

    function clearComposerEditor(editor) {
      if (!editor) return;
      try {
        if (typeof editor.focus === 'function') editor.focus();
        const sel = window.getSelection ? window.getSelection() : null;
        if (sel && document.createRange) {
          const range = document.createRange();
          range.selectNodeContents(editor);
          sel.removeAllRanges();
          sel.addRange(range);
          if (typeof document.execCommand === 'function') {
            document.execCommand('delete', false);
          }
        }
        if (normTxt(editor.textContent)) {
          editor.textContent = '';
          if (typeof InputEvent === 'function') {
            editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteContentBackward' }));
          }
        }
      } catch {}
    }

    function showNotice(msg) {
      if (noticeBar && noticeBar.isConnected) noticeBar.remove();
      const bar = document.createElement('div');
      bar.className = 'ag-cs-rewind-notice';
      bar.setAttribute('data-ag-no-i18n', '1');
      const txt = document.createElement('span');
      txt.textContent = msg;
      const cls = document.createElement('button');
      cls.type = 'button';
      cls.className = 'ag-cs-rewind-back';
      cls.textContent = '×';
      cls.addEventListener('click', () => {
        if (bar.isConnected) bar.remove();
        if (noticeBar === bar) noticeBar = null;
      });
      bar.appendChild(txt);
      bar.appendChild(cls);
      const slot = findComposerMountSlot();
      if (slot && slot.parent) {
        slot.parent.insertBefore(bar, slot.before || null);
      } else {
        (document.body || document.documentElement).appendChild(bar);
      }
      noticeBar = bar;
      setTimeout(() => {
        if (bar.isConnected) bar.remove();
        if (noticeBar === bar) noticeBar = null;
      }, 6000);
    }

    function closeRewindModal() {
      if (openRewindBar && openRewindBar.isConnected) {
        openRewindBar.remove();
      }
      openRewindBar = null;
      rewindState = null;
    }

    async function applyCodeOnlyRevert(turn, cid) {
      const { svc, stepHandler } = findFiberApis();
      let previews = turn?.diffMeta?.previews;
      if (!Array.isArray(previews) && typeof turn?.stepIndex === 'number' && cid) {
        const revertIdx = turn.stepIndex - 1;
        if (stepHandler && typeof stepHandler.getRevertPreviews === 'function') {
          previews = await stepHandler.getRevertPreviews(cid, revertIdx);
        } else if (svc && typeof svc.getRevertPreview === 'function') {
          previews = await svc.getRevertPreview(cid, revertIdx, undefined);
        }
      }
      if (!Array.isArray(previews) || !previews.length || !svc || typeof svc.writeFile !== 'function') {
        return { restoredCount: 0, skippedCreated: [] };
      }
      const enc = typeof TextEncoder === 'function' ? new TextEncoder() : null;
      let restoredCount = 0;
      const skippedCreated = [];
      for (const p of previews) {
        const uri = String(p?.fileUri || p?.uri || '');
        if (!uri) continue;
        if (p?.actionType === 3) {
          skippedCreated.push(uri.split('?')[0].split('/').pop() || uri);
          continue;
        }
        const lines = Array.isArray(p?.diff?.lines) ? p.diff.lines : null;
        if (!lines) continue;
        const contentStr = lines
          .filter((ln) => ln?.type !== 2)
          .map((ln) => String(ln?.text ?? ''))
          .join('\n');
        const bytes = enc ? enc.encode(contentStr) : contentStr;
        await svc.writeFile({ uri, content: bytes, overwrite: true });
        restoredCount++;
      }
      return { restoredCount, skippedCreated };
    }

    async function executeRewindAction(actionKey) {
      if (actionKey === 'nevermind' || !rewindState) {
        closeRewindModal();
        return;
      }
      const turn = rewindState.selectedTurn || rewindState.turns[rewindState.turnIdx];
      if (!turn || turn.isCurrent) {
        closeRewindModal();
        return;
      }
      const promptToRestore = turn.fullText || (turn.index ? turn.text : '');
      const { svc, stepHandler } = findFiberApis();
      const slot = findComposerMountSlot();
      const cid = turn.cascadeId || resolveCascadeId(slot?.box);

      if (actionKey === 'code') {
        closeRewindModal();
        try {
          const res = await applyCodeOnlyRevert(turn, cid);
          if (res.skippedCreated.length) {
            const ui = getUi();
            showNotice(
              `${ui.rewindCodeSkipDelete || '部分新建文件需通过「回退代码和对话」才能自动删除，其余修改已恢复。'} (${res.skippedCreated.join(', ')})`
            );
          }
        } catch {}
        return;
      }

      const revertFiles = actionKey === 'both';
      if (typeof turn.stepIndex === 'number' && cid) {
        const revertIdx = turn.stepIndex - 1;
        closeRewindModal();
        restorePromptIntoComposer(promptToRestore);
        if (stepHandler && typeof stepHandler.revertToIndex === 'function') {
          try {
            await stepHandler.revertToIndex(cid, revertIdx, { conversationOnly: !revertFiles });
            restorePromptIntoComposer(promptToRestore);
            return;
          } catch {}
        }
        if (svc && typeof svc.revertToCascadeStep === 'function') {
          try {
            await svc.revertToCascadeStep(cid, revertIdx, undefined, !revertFiles);
            restorePromptIntoComposer(promptToRestore);
            return;
          } catch {}
        }
      }

      const targetBtn = turn?.undoBtn;
      if (!targetBtn || !targetBtn.isConnected) {
        closeRewindModal();
        return;
      }
      closeRewindModal();
      restorePromptIntoComposer(promptToRestore);
      pendingRewindAction = { revertFiles, expiresAt: Date.now() + PENDING_ACTION_TTL_MS };
      bypassUndoInterceptBtn = targetBtn;
      try {
        targetBtn.click();
      } finally {
        bypassUndoInterceptBtn = null;
      }
      setTimeout(processUndoConfirmDialogs, 30);
    }

    function appendDiffStatSpans(parent, meta, ui) {
      if (!meta || (!meta.files.length && !meta.additions && !meta.deletions)) {
        parent.textContent = ui.rewindNoCodeChanges || '无代码更改';
        return;
      }
      const fileLabel =
        meta.files.length === 1
          ? `${meta.files[0]} `
          : meta.files.length > 1
          ? `${meta.files.length} files changed `
          : '';
      if (fileLabel) {
        const fEl = document.createElement('span');
        fEl.textContent = fileLabel;
        parent.appendChild(fEl);
      }
      if (meta.additions) {
        const addEl = document.createElement('span');
        addEl.className = 'ag-cs-rewind-stat-add';
        addEl.textContent = `+${meta.additions}`;
        parent.appendChild(addEl);
      }
      if (meta.deletions) {
        const delEl = document.createElement('span');
        delEl.className = 'ag-cs-rewind-stat-del';
        delEl.textContent = (meta.additions ? ' ' : '') + `-${meta.deletions}`;
        parent.appendChild(delEl);
      }
    }

    function updateImpactSummary(impactEl, turn, actionKey, ui) {
      if (!impactEl) return;
      impactEl.innerHTML = '';
      const line1 = document.createElement('div');
      if (actionKey === 'nevermind') {
        line1.textContent = ui.rewindDescCancel || '对话内容将保持不变。';
      } else if (actionKey === 'code') {
        line1.textContent = ui.rewindDescCode || '对话内容将保持不变。';
      } else {
        line1.textContent = ui.rewindDescBoth || '此消息及之后的对话内容将被移除，并恢复到输入框。';
      }
      impactEl.appendChild(line1);

      if (actionKey !== 'nevermind') {
        const line2 = document.createElement('div');
        if (actionKey === 'both' || actionKey === 'code') {
          const meta = turn?.diffMeta;
          if (!meta && !turn?.previewLoaded) {
            line2.textContent = ui.rewindCheckingDiff || '正在统计受影响的文件与代码行数…';
          } else if (meta && !meta.files.length && !meta.additions && !meta.deletions) {
            line2.textContent = ui.rewindCodeNone || '代码未发生更改（无文件或代码行将被取消）。';
          } else if (meta && (meta.files.length || meta.additions || meta.deletions)) {
            const lang = getCfg().language || 'zh-CN';
            const filesDesc = formatClaudeFilesList(meta.files, lang);
            const changedLines = meta.additions + meta.deletions;
            const prefixEl = document.createElement('span');
            prefixEl.textContent =
              lang && lang.startsWith('zh')
                ? `将恢复 ${filesDesc}（共 ${meta.files.length} 个文件，`
                : (ui.rewindCodeRestored || 'The code will be restored') + ' ';
            line2.appendChild(prefixEl);
            if (meta.additions || meta.deletions) {
              if (meta.additions) {
                const aEl = document.createElement('span');
                aEl.className = 'ag-cs-rewind-stat-add';
                aEl.textContent = `+${meta.additions}`;
                line2.appendChild(aEl);
              }
              if (meta.deletions) {
                const dEl = document.createElement('span');
                dEl.className = 'ag-cs-rewind-stat-del';
                dEl.textContent = (meta.additions ? ' ' : '') + `-${meta.deletions}`;
                line2.appendChild(dEl);
              }
              const tailEl = document.createElement('span');
              tailEl.textContent =
                lang && lang.startsWith('zh')
                  ? ` 行，共 ${changedLines} 行改动将被取消/还原）。`
                  : ` in ${filesDesc} (${changedLines} lines reverted).`;
              line2.appendChild(tailEl);
            } else {
              const tailEl = document.createElement('span');
              tailEl.textContent = lang && lang.startsWith('zh') ? '将被还原）。' : `in ${filesDesc}.`;
              line2.appendChild(tailEl);
            }
          } else {
            line2.textContent = ui.rewindCodeRestored || '代码更改将被恢复。';
          }
        } else {
          line2.textContent = ui.rewindCodeUnchanged || '代码将保持不变。';
        }
        impactEl.appendChild(line2);
      }
    }

    async function hydrateRewindDiffs(turns, cascadeId) {
      const { svc, stepHandler } = findFiberApis();
      const hasPreviewApi =
        (stepHandler && typeof stepHandler.getRevertPreviews === 'function') ||
        (svc && typeof svc.getRevertPreview === 'function');
      if (!hasPreviewApi || !cascadeId) return;
      const ui = getUi();
      for (let i = turns.length - 1; i >= 0; i--) {
        if (isDestroyed() || !openRewindBar || !rewindState) return;
        const t = turns[i];
        if (t.isCurrent || typeof t.stepIndex !== 'number' || t.previewLoaded) continue;
        const revertIdx = t.stepIndex - 1;
        try {
          const previews =
            stepHandler && typeof stepHandler.getRevertPreviews === 'function'
              ? await stepHandler.getRevertPreviews(cascadeId, revertIdx)
              : await svc.getRevertPreview(cascadeId, revertIdx, undefined);
          t.diffMeta = parseRevertPreviewsMeta(previews, ui);
          t.previewLoaded = true;
        } catch {}
        if (openRewindBar && rewindState) {
          if (rewindState.step === 'select') {
            const itemMetas = openRewindBar.querySelectorAll('.ag-cs-rewind-item-meta');
            if (itemMetas[i] && t.diffMeta) {
              itemMetas[i].innerHTML = '';
              appendDiffStatSpans(itemMetas[i], t.diffMeta, ui);
            }
          } else if (rewindState.selectedTurn === t) {
            renderRewindBarBody();
          }
        }
      }
    }

    function enterRewindActionStep(turn, idx) {
      if (!rewindState) return;
      if (!turn || turn.isCurrent) {
        closeRewindModal();
        return;
      }
      if (typeof idx === 'number') rewindState.turnIdx = idx;
      rewindState.selectedTurn = turn;
      rewindState.step = 'action';
      rewindState.actionIdx = 0;
      renderRewindBarBody();
      const slot = findComposerMountSlot();
      const cid = turn.cascadeId || resolveCascadeId(slot?.box);
      if (!turn.previewLoaded && typeof turn.stepIndex === 'number' && cid) {
        hydrateRewindDiffs([turn], cid);
      }
    }

    function renderRewindBarBody() {
      if (!openRewindBar || !rewindState) return;
      const ui = getUi();
      const modal = openRewindBar.querySelector('.ag-cs-rewind-modal');
      if (!modal) return;
      modal.innerHTML = '';

      const header = document.createElement('div');
      header.className = 'ag-cs-rewind-header';
      const titleWrap = document.createElement('div');
      titleWrap.className = 'ag-cs-rewind-title-wrap';
      if (rewindState.step === 'action' && !rewindState.preselected) {
        const backBtn = document.createElement('button');
        backBtn.type = 'button';
        backBtn.className = 'ag-cs-rewind-back';
        backBtn.textContent = ui.rewindBack || '← 返回';
        backBtn.addEventListener('click', () => {
          if (!rewindState) return;
          rewindState.step = 'select';
          renderRewindBarBody();
        });
        titleWrap.appendChild(backBtn);
      }
      const titleEl = document.createElement('div');
      titleEl.className = 'ag-cs-rewind-title';
      titleEl.textContent = ui.rewindTitle || 'Rewind';
      titleWrap.appendChild(titleEl);

      const realTurnsCount = rewindState.turns.filter((t) => !t.isCurrent).length;
      const countEl = document.createElement('div');
      countEl.className = 'ag-cs-rewind-count';
      countEl.textContent = realTurnsCount ? `${realTurnsCount}` : '';
      header.appendChild(titleWrap);
      header.appendChild(countEl);
      modal.appendChild(header);

      const subEl = document.createElement('div');
      subEl.className = 'ag-cs-rewind-sub';
      subEl.textContent =
        rewindState.step === 'select'
          ? ui.rewindStep1Sub || '选择要回退到的消息节点（将恢复至发送该消息之前）：'
          : ui.rewindStep2Sub || '确认要恢复到发送以下消息之前的状态：';
      modal.appendChild(subEl);

      if (rewindState.step === 'select') {
        const listEl = document.createElement('div');
        listEl.className = 'ag-cs-rewind-list';
        if (!realTurnsCount) {
          const emptyEl = document.createElement('div');
          emptyEl.className = 'ag-cs-rewind-empty';
          emptyEl.textContent = ui.rewindEmpty || '当前会话暂无可回退的用户消息。';
          listEl.appendChild(emptyEl);
        } else {
          rewindState.turns.forEach((turn, idx) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'ag-cs-rewind-item';
            if (idx === rewindState.turnIdx) item.setAttribute('data-selected', '1');

            const caret = document.createElement('span');
            caret.className = 'ag-cs-rewind-caret';
            caret.textContent = idx === rewindState.turnIdx ? '❯' : '';

            const body = document.createElement('div');
            body.className = 'ag-cs-rewind-item-body';

            const msgLine = document.createElement('div');
            msgLine.className = 'ag-cs-rewind-item-msg';
            msgLine.textContent = turn.isCurrent ? ui.rewindCurrent || '(current)' : turn.text;
            body.appendChild(msgLine);

            if (!turn.isCurrent) {
              const metaLine = document.createElement('div');
              metaLine.className = 'ag-cs-rewind-item-meta';
              if (turn.diffMeta) {
                appendDiffStatSpans(metaLine, turn.diffMeta, ui);
              } else {
                metaLine.textContent = ui.rewindNoCodeChanges || '无代码更改';
              }
              body.appendChild(metaLine);
            }

            item.appendChild(caret);
            item.appendChild(body);
            item.addEventListener('click', () => enterRewindActionStep(turn, idx));
            listEl.appendChild(item);
          });
        }
        modal.appendChild(listEl);

        const footer = document.createElement('div');
        footer.className = 'ag-cs-rewind-footer';
        footer.textContent = ui.rewindStep1Hint || 'Enter 继续 · Esc 取消';
        modal.appendChild(footer);

        const selItem = listEl.querySelector('[data-selected="1"]');
        if (selItem && typeof selItem.scrollIntoView === 'function') {
          selItem.scrollIntoView({ block: 'nearest' });
        }
        return;
      }

      const turn = rewindState.selectedTurn || rewindState.turns[rewindState.turnIdx];
      if (turn) {
        const quoteEl = document.createElement('div');
        quoteEl.className = 'ag-cs-rewind-quote';
        const qText = document.createElement('div');
        qText.className = 'ag-cs-rewind-quote-text';
        qText.textContent = turn.text;
        quoteEl.appendChild(qText);
        const age = formatShortAge(turn.tsMs);
        if (age) {
          const qAge = document.createElement('div');
          qAge.className = 'ag-cs-rewind-quote-age';
          qAge.textContent = `(${age})`;
          quoteEl.appendChild(qAge);
        }
        modal.appendChild(quoteEl);
      }

      const optionsMeta = getStep2Options(turn, ui);
      if (rewindState.actionIdx >= optionsMeta.length) rewindState.actionIdx = 0;

      const impactEl = document.createElement('div');
      impactEl.className = 'ag-cs-rewind-impact';
      updateImpactSummary(impactEl, turn, optionsMeta[rewindState.actionIdx]?.key || optionsMeta[0].key, ui);
      modal.appendChild(impactEl);

      const listEl = document.createElement('div');
      listEl.className = 'ag-cs-rewind-list';
      optionsMeta.forEach((opt, idx) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ag-cs-rewind-opt';
        btn.setAttribute('data-rewind-opt', opt.key);
        if (idx === rewindState.actionIdx) btn.setAttribute('data-selected', '1');
        const caret = document.createElement('span');
        caret.className = 'ag-cs-rewind-caret';
        caret.textContent = idx === rewindState.actionIdx ? '❯' : '';
        const num = document.createElement('span');
        num.className = 'ag-cs-rewind-opt-num';
        num.textContent = opt.num;
        const lbl = document.createElement('span');
        lbl.className = 'ag-cs-rewind-text';
        lbl.textContent = opt.label;
        btn.appendChild(caret);
        btn.appendChild(num);
        btn.appendChild(lbl);
        btn.addEventListener('mouseenter', () => {
          if (!rewindState || rewindState.actionIdx === idx) return;
          updateRewindActionSelection(idx);
        });
        btn.addEventListener('click', () => executeRewindAction(opt.key));
        listEl.appendChild(btn);
      });
      modal.appendChild(listEl);

      const footer = document.createElement('div');
      footer.className = 'ag-cs-rewind-footer';
      footer.textContent = ui.rewindStep2Hint || 'Enter 确认 · Esc 返回/取消';
      modal.appendChild(footer);
    }

    function updateRewindTurnSelection(nextIdx) {
      if (!openRewindBar || !rewindState || !rewindState.turns.length) return;
      const clamped = Math.max(0, Math.min(rewindState.turns.length - 1, nextIdx));
      rewindState.turnIdx = clamped;
      const items = openRewindBar.querySelectorAll('.ag-cs-rewind-item');
      items.forEach((item, idx) => {
        const caret = item.querySelector('.ag-cs-rewind-caret');
        if (idx === clamped) {
          item.setAttribute('data-selected', '1');
          if (caret) caret.textContent = '❯';
          if (typeof item.scrollIntoView === 'function') {
            item.scrollIntoView({ block: 'nearest' });
          }
        } else {
          item.removeAttribute('data-selected');
          if (caret) caret.textContent = '';
        }
      });
    }

    function updateRewindActionSelection(nextIdx) {
      if (!openRewindBar || !rewindState) return;
      const ui = getUi();
      const turn = rewindState.selectedTurn || rewindState.turns[rewindState.turnIdx];
      const optionsMeta = getStep2Options(turn, ui);
      const clamped = Math.max(0, Math.min(optionsMeta.length - 1, nextIdx));
      rewindState.actionIdx = clamped;
      const opts = openRewindBar.querySelectorAll('.ag-cs-rewind-opt');
      opts.forEach((opt, idx) => {
        const caret = opt.querySelector('.ag-cs-rewind-caret');
        if (idx === clamped) {
          opt.setAttribute('data-selected', '1');
          if (caret) caret.textContent = '❯';
        } else {
          opt.removeAttribute('data-selected');
          if (caret) caret.textContent = '';
        }
      });
      const impactEl = openRewindBar.querySelector('.ag-cs-rewind-impact');
      updateImpactSummary(impactEl, turn, optionsMeta[clamped]?.key || optionsMeta[0].key, ui);
    }

    function mountRewindBar(initialState) {
      closeRewindModal();
      rewindState = initialState;
      const bar = document.createElement('div');
      bar.className = 'ag-cs-rewind-bar';
      bar.setAttribute('data-ag-no-i18n', '1');
      bar.setAttribute('data-ag-localization-skip', '1');

      const modal = document.createElement('div');
      modal.className = 'ag-cs-rewind-modal';
      bar.appendChild(modal);

      const slot = findComposerMountSlot();
      if (slot && slot.parent) {
        if (slot.before && typeof slot.parent.insertBefore === 'function') {
          slot.parent.insertBefore(bar, slot.before);
        } else {
          slot.parent.appendChild(bar);
        }
      } else {
        (document.body || document.documentElement).appendChild(bar);
      }
      openRewindBar = bar;
      renderRewindBarBody();
    }

    function openRewindModal() {
      if (isDestroyed() || getCfg().rewindPanel === false) return;
      const domTurns = collectRewindTurnsDom();
      const initialTurns = domTurns.length ? [...domTurns, { isCurrent: true, text: '(current)' }] : [];
      const defaultIdx = domTurns.length ? domTurns.length - 1 : 0;
      mountRewindBar({
        step: 'select',
        turns: initialTurns,
        turnIdx: defaultIdx,
        actionIdx: 0,
        preselected: false,
        selectedTurn: initialTurns[defaultIdx] || null,
      });

      const { svc } = findFiberApis();
      const slot = findComposerMountSlot();
      const cid = resolveCascadeId(slot?.box);
      if (cid && svc && typeof svc.getCascadeTrajectory === 'function') {
        svc
          .getCascadeTrajectory({ cascadeId: cid })
          .then((traj) => {
            if (isDestroyed() || !openRewindBar || !rewindState || rewindState.step !== 'select') return;
            const fullTurns = buildTurnsFromTrajectory(traj, cid);
            if (fullTurns.length) {
              const withCurrent = [...fullTurns, { isCurrent: true, text: '(current)' }];
              rewindState.turns = withCurrent;
              rewindState.turnIdx = Math.max(0, fullTurns.length - 1);
              rewindState.selectedTurn = withCurrent[rewindState.turnIdx];
              renderRewindBarBody();
              hydrateRewindDiffs(withCurrent, cid);
            }
          })
          .catch(() => {});
      }
    }

    function openRewindForButton(btn) {
      if (isDestroyed() || getCfg().rewindPanel === false || !btn) return;
      const { turns, turn } = findTurnForUndoButton(btn);
      mountRewindBar({
        step: 'action',
        turns,
        turnIdx: Math.max(0, turns.indexOf(turn)),
        actionIdx: 0,
        preselected: true,
        selectedTurn: turn,
      });
      const { svc } = findFiberApis();
      const slot = findComposerMountSlot();
      const cid = resolveCascadeId(slot?.box);
      if (cid && svc && typeof svc.getCascadeTrajectory === 'function') {
        svc
          .getCascadeTrajectory({ cascadeId: cid })
          .then((traj) => {
            if (isDestroyed() || !openRewindBar || !rewindState) return;
            const fullTurns = buildTurnsFromTrajectory(traj, cid);
            const matched = fullTurns.find((ft) => ft.text.slice(0, 32) === turn.text.slice(0, 32));
            if (matched) {
              matched.undoBtn = btn;
              rewindState.selectedTurn = matched;
              hydrateRewindDiffs([matched], cid);
              renderRewindBarBody();
            }
          })
          .catch(() => {});
      }
    }

    function isComposerEmptyForRewind() {
      const active = document.activeElement;
      if (active?.closest && active.closest('.monaco-editor')) return false;
      const focusedEd = active?.closest ? active.closest(COMPOSER_EDITOR_SEL) : null;
      if (focusedEd) return !stripZeroWidth(focusedEd.textContent);
      if (active && active !== document.body && active !== document.documentElement) {
        const tag = String(active.tagName || '').toUpperCase();
        if (tag === 'INPUT' || tag === 'TEXTAREA' || active.getAttribute?.('contenteditable') === 'true') {
          return false;
        }
      }
      const ed = findComposerEditor();
      if (!ed) return false;
      return !stripZeroWidth(ed.textContent);
    }

    function stopEvent(ev, immediate) {
      ev.preventDefault();
      ev.stopPropagation();
      if (immediate && typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
    }

    function onKeyDown(ev) {
      if (handledKeyEvents && ev && typeof ev === 'object') {
        if (handledKeyEvents.has(ev)) return false;
        handledKeyEvents.add(ev);
      }

      if (openRewindBar && openRewindBar.isConnected && rewindState) {
        if (rewindState.step === 'select') {
          if (ev.key === 'Escape') {
            stopEvent(ev, true);
            closeRewindModal();
            return true;
          }
          if (ev.key === 'ArrowUp' || ev.key === 'k') {
            stopEvent(ev, true);
            updateRewindTurnSelection(rewindState.turnIdx - 1);
            return true;
          }
          if (ev.key === 'ArrowDown' || ev.key === 'j') {
            stopEvent(ev, true);
            updateRewindTurnSelection(rewindState.turnIdx + 1);
            return true;
          }
          if (ev.key === 'PageUp') {
            stopEvent(ev, true);
            updateRewindTurnSelection(rewindState.turnIdx - PAGE_STEP);
            return true;
          }
          if (ev.key === 'PageDown') {
            stopEvent(ev, true);
            updateRewindTurnSelection(rewindState.turnIdx + PAGE_STEP);
            return true;
          }
          if (ev.key === 'Home' || ev.key === 'End') {
            stopEvent(ev, true);
            updateRewindTurnSelection(ev.key === 'Home' ? 0 : rewindState.turns.length - 1);
            return true;
          }
          if (ev.key === 'Enter' && rewindState.turns.length) {
            stopEvent(ev, true);
            enterRewindActionStep(rewindState.turns[rewindState.turnIdx], rewindState.turnIdx);
            return true;
          }
        } else if (rewindState.step === 'action') {
          if (ev.key === 'Escape') {
            stopEvent(ev, true);
            if (rewindState.preselected) closeRewindModal();
            else {
              rewindState.step = 'select';
              renderRewindBarBody();
            }
            return true;
          }
          if ((ev.key === 'Backspace' || ev.key === 'ArrowLeft') && !rewindState.preselected) {
            stopEvent(ev, true);
            rewindState.step = 'select';
            renderRewindBarBody();
            return true;
          }
          if (ev.key === 'ArrowUp' || ev.key === 'k') {
            stopEvent(ev, true);
            updateRewindActionSelection(rewindState.actionIdx - 1);
            return true;
          }
          if (ev.key === 'ArrowDown' || ev.key === 'j') {
            stopEvent(ev, true);
            updateRewindActionSelection(rewindState.actionIdx + 1);
            return true;
          }
          if (ev.key === '1' || ev.key === '2' || ev.key === '3' || ev.key === '4') {
            const turn = rewindState.selectedTurn || rewindState.turns[rewindState.turnIdx];
            const opts = getStep2Options(turn, getUi());
            const picked = opts[Number(ev.key) - 1];
            if (picked) {
              stopEvent(ev, true);
              executeRewindAction(picked.key);
              return true;
            }
          }
          if (ev.key === 'Enter') {
            stopEvent(ev, true);
            const turn = rewindState.selectedTurn || rewindState.turns[rewindState.turnIdx];
            const opts = getStep2Options(turn, getUi());
            const picked = opts[rewindState.actionIdx] || opts[0];
            if (picked) executeRewindAction(picked.key);
            return true;
          }
        }
        return true;
      }

      if (
        getCfg().rewindPanel !== false &&
        ev.key === 'Enter' &&
        !ev.shiftKey &&
        !ev.ctrlKey &&
        !ev.metaKey &&
        !ev.altKey &&
        !ev.isComposing
      ) {
        const ed = ev?.target?.closest ? ev.target.closest(COMPOSER_EDITOR_SEL) : null;
        if (ed && normTxt(ed.textContent).toLowerCase() === '/rewind') {
          stopEvent(ev, true);
          clearComposerEditor(ed);
          openRewindModal();
          return true;
        }
      }
      return false;
    }

    function onEscape(ev, info) {
      if (handledEscEvents && ev && typeof ev === 'object') {
        if (handledEscEvents.has(ev)) return;
        handledEscEvents.add(ev);
      }
      if (info && info.hadPopover) return;
      if (openRewindBar && openRewindBar.isConnected) return;
      if (getCfg().rewindPanel === false || document.querySelector('[role="dialog"]')) return;
      if (!isComposerEmptyForRewind()) return;
      const now = Date.now();
      if (now - lastEmptyEscAt <= DOUBLE_ESC_WINDOW_MS) {
        lastEmptyEscAt = 0;
        stopEvent(ev, true);
        openRewindModal();
        return;
      }
      lastEmptyEscAt = now;
    }

    // Intercept Undo clicks when undoConfirmMode === 'picker', plus capture window keydown
    // in case host editor blurs focus on 1st Esc or handles window-level Escape.
    function onWinKeyDown(ev) {
      if (onKeyDown(ev)) return;
      if (ev.key === 'Escape') {
        onEscape(ev, { hadPopover: false });
      }
    }
    function onUndoPointerBlock(ev) {
      if (findClickedUndoButton(ev)) stopEvent(ev, true);
    }
    function onUndoClick(ev) {
      const btn = findClickedUndoButton(ev);
      if (btn) {
        stopEvent(ev, true);
        openRewindForButton(btn);
      }
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('keydown', onWinKeyDown, true);
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('pointerdown', onUndoPointerBlock, true);
      document.addEventListener('mousedown', onUndoPointerBlock, true);
      document.addEventListener('click', onUndoClick, true);
    }

    return {
      ownSelector: '.ag-cs-rewind-bar, .ag-cs-rewind-notice, .ag-cs-rewind-backdrop',
      sync: processUndoConfirmDialogs,
      onKeyDown,
      onEscape,
      open: openRewindModal,
      destroy() {
        if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
          try { window.removeEventListener('keydown', onWinKeyDown, true); } catch {}
        }
        if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
          try {
            document.removeEventListener('pointerdown', onUndoPointerBlock, true);
            document.removeEventListener('mousedown', onUndoPointerBlock, true);
            document.removeEventListener('click', onUndoClick, true);
          } catch {}
        }
        closeRewindModal();
        if (noticeBar && noticeBar.isConnected) noticeBar.remove();
        noticeBar = null;
      },
    };
  }

  return { create, normTxt, stepPromptText };
});
