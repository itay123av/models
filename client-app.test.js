/* בדיקות לעורך, לסימולטור ולמעטפת (בלי סריקה) — על הקוד האמיתי מתוך
   automata.html. קובץ נפרד מ-client-pda.test.js כדי שענפי העבודה המקבילים
   לא יתנגשו בסוף אותו קובץ.
   ה-DOM כאן מינימלי: getElementById מחזיר אובייקט רגיל לכל מזהה שנרשם
   ב-elements, וכל השאר הוא Proxy שבולע הכל. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadClient() {
  const html = fs.readFileSync(path.join(__dirname, 'automata.html'), 'utf8');
  let js = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  js = js.replace(/\r?\ninit\(\);\s*$/, '\n');
  assert.equal(/\binit\(\);\s*$/.test(js.trim()), false, 'init() הוסר מהרצת הבדיקה');

  const noop = () => {};
  const fakeEl = new Proxy({}, {
    get(_, k) {
      if (k === 'style' || k === 'dataset' || k === 'classList') return new Proxy({}, { get: () => noop });
      if (k === 'querySelectorAll' || k === 'getElementsByTagName') return () => [];
      if (k === 'querySelector' || k === 'closest' || k === 'appendChild' || k === 'insertBefore') return () => fakeEl;
      if (k === 'value' || k === 'textContent' || k === 'innerHTML') return '';
      return noop;
    },
    set: () => true,
  });
  const elements = {};
  const sandbox = {
    console,
    document: {
      getElementById: id => elements[id] || fakeEl,
      querySelector: () => fakeEl,
      querySelectorAll: () => [],
      createElement: () => fakeEl,
      createElementNS: () => fakeEl,
      addEventListener: noop,
      body: fakeEl,
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    requestAnimationFrame: noop,
    setTimeout,
    clearTimeout,
    fetch: () => Promise.reject(new Error('no network in this harness')),
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    location: { href: '' },
  };
  sandbox.window = sandbox;

  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'pda-core.js'), 'utf8'), ctx, { filename: 'pda-core.js' });
  vm.runInContext(js, ctx, { filename: 'automata-inline.js' });
  vm.runInContext('globalThis.__setCurrent = v => { current = v; }; globalThis.__getCurrent = () => current;', ctx);
  ctx.__elements = elements;
  return ctx;
}

/* מחליף את פונקציות הציור ואוסף את ההודעות */
function quietUi(ctx) {
  const toasts = [];
  vm.runInContext('renderAll=()=>{}; renderGraph=()=>{}; renderArmBanner=()=>{}; save=()=>{};', ctx);
  ctx.toast = (message, kind) => toasts.push({ message, kind: kind || '' });   // פונקציה גלובלית בסקריפט = מאפיין של ctx
  return toasts;
}

const tick = () => new Promise(r => setTimeout(r, 0));

function faModel(ctx, ndet, transitions) {
  const model = {
    id: 'm', name: 'm', type: 'dfa', ndet, tests: [],
    states: [
      { id: 's0', label: 'q0', isStart: true, isAccept: false, x: 0, y: 0 },
      { id: 's1', label: 'q1', isStart: false, isAccept: true, x: 100, y: 0 },
    ],
    transitions: transitions || [],
  };
  ctx.__setCurrent(model);
  return model;
}

/* מחליף את חלון הקלט: רושם את האפשרויות ומחזיר את מה שהמשתמש "הקליד" */
function answerPrompt(ctx, typed) {
  const seen = [];
  ctx.__promptAnswer = typed;
  ctx.__promptSeen = seen;
  vm.runInContext('promptDialog=(title,opts)=>{ globalThis.__promptSeen.push({title,opts}); return Promise.resolve(globalThis.__promptAnswer); };', ctx);
  return seen;
}

test('ε button: the NFA transition dialog offers ε and an ε-transition is created', async () => {
  const ctx = loadClient();
  quietUi(ctx);
  faModel(ctx, true);
  const seen = answerPrompt(ctx, 'ε');
  ctx.promptTransition('s0', 's1');
  await tick();
  const buttons = seen[0].opts.symbolButtons || [];
  assert.deepEqual(Array.from(buttons, b => b.symbol), ['ε'], 'NFA dialog has an ε button');
  assert.match(buttons[0].label, /בלי לקרוא/, 'the button explains what ε means');
  const t = ctx.__getCurrent().transitions[0];
  assert.deepEqual(Array.from(t.symbols), ['ε']);
});

test('ε button: the deterministic FA dialog has no ε button and refuses a typed ε', async () => {
  const ctx = loadClient();
  const toasts = quietUi(ctx);
  faModel(ctx, false);
  const seen = answerPrompt(ctx, 'aε');
  ctx.promptTransition('s0', 's1');
  await tick();
  assert.equal((seen[0].opts.symbolButtons || []).length, 0, 'no ε button in a DFA');
  assert.equal(ctx.__getCurrent().transitions.length, 0, 'no transition with a dead ε edge is created');
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].kind, 'danger');
  assert.match(toasts[0].message, /ε/);
  assert.match(toasts[0].message, /לא-דטרמיניסטי/);
});

test('ε button inserts at the caret and replaces a selection', () => {
  const ctx = loadClient();
  const field = (value, start, end) => ({ value, selectionStart: start, selectionEnd: end,
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }, focus() { this.focused = true; } });
  let f = field('ab', 1, 1);
  ctx.insertAtCaret(f, 'ε');
  assert.equal(f.value, 'aεb');
  assert.equal(f.selectionStart, 2, 'the caret moves past the inserted symbol');
  assert.equal(f.focused, true, 'focus stays in the field');
  f = field('abc', 0, 2);
  ctx.insertAtCaret(f, 'ε');
  assert.equal(f.value, 'εc');
  f = { value: 'a' };
  ctx.insertAtCaret(f, 'ε');
  assert.equal(f.value, 'aε', 'no caret information → append');
});

test('ε button: the NFA inspector has an ε button; the DFA inspector refuses ε', () => {
  const ctx = loadClient();
  const toasts = quietUi(ctx);
  const inspector = { innerHTML: '' };
  ctx.__elements.inspector = inspector;
  faModel(ctx, true, [{ id: 't', from: 's0', to: 's1', symbols: ['a'] }]);
  vm.runInContext("sel={type:'transition',id:'t'}", ctx);
  ctx.renderInspector();
  assert.match(inspector.innerHTML, /addEpsilonSymbol\('t'\)/, 'NFA inspector offers ε');
  ctx.__elements.trSyms = { value: 'a' };
  ctx.addEpsilonSymbol('t');
  assert.deepEqual(Array.from(ctx.__getCurrent().transitions[0].symbols), ['a', 'ε']);

  faModel(ctx, false, [{ id: 't', from: 's0', to: 's1', symbols: ['a'] }]);
  ctx.renderInspector();
  assert.doesNotMatch(inspector.innerHTML, /addEpsilonSymbol/, 'no ε button in a DFA');
  ctx.setTransSymbols('t', 'aε');
  assert.deepEqual(Array.from(ctx.__getCurrent().transitions[0].symbols), ['a'], 'the DFA keeps its old symbols');
  assert.equal(toasts.at(-1).kind, 'danger');
  assert.match(toasts.at(-1).message, /ε/);
});

test('a deterministic FA that already holds an ε edge (old data / import) does not run silently wrong', () => {
  const ctx = loadClient();
  const toasts = quietUi(ctx);
  faModel(ctx, false, [{ id: 't', from: 's0', to: 's1', symbols: ['ε'] }]);
  assert.equal(ctx.simReady(), false);
  assert.match(toasts[0].message, /q0 → q1/, 'the message says where the ε is');
  assert.match(toasts[0].message, /ε/);
  faModel(ctx, true, [{ id: 't', from: 's0', to: 's1', symbols: ['ε'] }]);
  toasts.length = 0;
  assert.equal(ctx.simReady(), true, 'the same edge is fine in an NFA');
  assert.equal(ctx.runQuick('').status, 'accepted', 'ε-closure reaches the accepting state');
});

test('the NFA guide explains the ε button', () => {
  const ctx = loadClient();
  const guide = { innerHTML: '' };
  ctx.__elements.guideBody = guide;
  faModel(ctx, true);
  ctx.renderGuide();
  assert.match(guide.innerHTML, /ε/);
  assert.match(guide.innerHTML, /כפתור/, 'the guide points at the ε button, not at typing ε');
  faModel(ctx, false);
  ctx.renderGuide();
  assert.match(guide.innerHTML, /לא-דטרמיניסטי/, 'the DFA guide says where ε lives');
});

test('tab badges distinguish NFA and NPDA from their deterministic versions', () => {
  const ctx = loadClient();
  const tabs = { innerHTML: '' };
  ctx.__elements.tabs = tabs;
  const db = vm.runInContext('DB', ctx);
  db.automata = [
    { id: 'a', name: 'A', type: 'dfa' }, { id: 'b', name: 'B', type: 'dfa', ndet: true },
    { id: 'c', name: 'C', type: 'pda' }, { id: 'd', name: 'D', type: 'pda', ndet: true }, { id: 'e', name: 'E', type: 'tm' },
  ];
  ctx.renderTabs();
  const badges = [...tabs.innerHTML.matchAll(/class="tab-type">([^<]*)</g)].map(m => m[1]);
  assert.deepEqual(badges, ['DFA', 'NFA', 'PDA', 'NPDA', 'TM']);
});

/* ── נגישות ─────────────────────────────────────────────────────────── */

/* כפתור/שדה מזויף מספיק ל-dialogKey: closest/matches לפי רשימת סלקטורים */
function fakeTarget(kinds, extra = {}) {
  return Object.assign({
    closest(sel) { return sel.split(',').some(x => kinds.includes(x.trim())) ? this : null; },
    matches(sel) { return sel.split(',').some(x => kinds.includes(x.trim())); },
    classList: { contains: c => Boolean(extra.on && c === 'on') },
    clicks: 0, click() { this.clicks++; },
  }, extra);
}
function fakeKey(key, target, opts = {}) {
  return Object.assign({ key, target, shiftKey: false, isComposing: false, prevented: false, preventDefault() { this.prevented = true; } }, opts);
}

test('dialog keyboard: Enter on a focused button activates that button, not the primary (Enter on «ביטול» used to delete)', () => {
  const ctx = loadClient();
  const primary = { clicks: 0, click() { this.clicks++; } };
  const bg = { querySelector: () => primary };
  let dismissed = 0;
  const cancel = fakeTarget(['button']);
  let e = fakeKey('Enter', cancel);
  ctx.dialogKey(e, bg, () => dismissed++);
  assert.equal(primary.clicks, 0, 'Enter on «ביטול» does not press «מחק»');
  assert.equal(e.prevented, false, 'the button keeps its own Enter behaviour');

  ctx.dialogKey(fakeKey('Enter', fakeTarget(['input'])), bg, () => dismissed++);
  assert.equal(primary.clicks, 1, 'Enter in a field still confirms');

  const chip = fakeTarget(['button', '.chip']);
  ctx.dialogKey(fakeKey('Enter', chip), bg, () => dismissed++);
  assert.equal(chip.clicks, 1, 'Enter on an unselected choice selects it');
  assert.equal(primary.clicks, 2, '…and confirms');
  const onChip = fakeTarget(['button', '.chip'], { on: true });
  ctx.dialogKey(fakeKey('Enter', onChip), bg, () => dismissed++);
  assert.equal(onChip.clicks, 0, 'an already selected choice is not toggled again');
  assert.equal(primary.clicks, 3);

  ctx.dialogKey(fakeKey('Enter', fakeTarget(['textarea'])), bg, () => dismissed++);
  assert.equal(primary.clicks, 3, 'Enter in a textarea is a new line');
  ctx.dialogKey(fakeKey('Escape', fakeTarget(['input'])), bg, () => dismissed++);
  assert.equal(dismissed, 1);
});

test('dialog keyboard: Tab stays inside the dialog', () => {
  const ctx = loadClient();
  let focused = '';
  const a = { getClientRects: () => [1], focus() { focused = 'a'; } };
  const b = { getClientRects: () => [1], focus() { focused = 'b'; } };
  const hidden = { getClientRects: () => [], focus() { focused = 'hidden'; } };
  const modal = { querySelectorAll: () => [a, hidden, b] };
  const bg = { querySelector: sel => (sel === '.modal' ? modal : null) };
  ctx.document.activeElement = b;
  const e = fakeKey('Tab', b);
  ctx.dialogKey(e, bg, () => {});
  assert.equal(e.prevented, true);
  assert.equal(focused, 'a', 'Tab on the last control wraps to the first');
  ctx.document.activeElement = a;
  ctx.dialogKey(fakeKey('Tab', a, { shiftKey: true }), bg, () => {});
  assert.equal(focused, 'b', 'Shift+Tab on the first wraps to the last (hidden controls skipped)');
  ctx.document.activeElement = { outside: true };
  ctx.dialogKey(fakeKey('Tab', {}), bg, () => {});
  assert.equal(focused, 'a', 'focus that escaped the dialog is pulled back in');
});

test('canvas states and transitions are keyboard targets with spoken names', () => {
  const ctx = loadClient();
  const nodes = { innerHTML: '' }, edges = { innerHTML: '' };
  Object.assign(ctx.__elements, { nodes, edges, stageEmpty: { style: {} }, canvas: { querySelector: () => null } });
  vm.runInContext('renderAiReviewPanel=()=>{};', ctx);
  faModel(ctx, false, [{ id: 't', from: 's0', to: 's1', symbols: ['a', 'b'] }]);
  ctx.renderGraph();
  assert.match(nodes.innerHTML, /data-state-id="s0"[^>]*tabindex="0"[^>]*role="button"[^>]*aria-label="מצב q0, התחלתי"/);
  assert.match(nodes.innerHTML, /aria-label="מצב q1, מקבל"/);
  assert.match(edges.innerHTML, /data-trans-id="t"[^>]*tabindex="0"[^>]*aria-label="מעבר q0 → q1: a, b"/);
});

test('tabs: the name is a focusable button and ✕ says which model it deletes', () => {
  const ctx = loadClient();
  const tabs = { innerHTML: '' };
  ctx.__elements.tabs = tabs;
  vm.runInContext('DB', ctx).automata = [{ id: 'a', name: 'זוגי a-ים', type: 'dfa' }];
  ctx.renderTabs();
  assert.match(tabs.innerHTML, /<button type="button" class="tab-open"/);
  assert.match(tabs.innerHTML, /class="tab-x"[^>]*aria-label="סגור ומחק את «זוגי a-ים»"/);
});

test('toasts are announced (live region) and decorative icons are hidden from screen readers', () => {
  const html = fs.readFileSync(path.join(__dirname, 'automata.html'), 'utf8');
  assert.match(html, /<div class="toast" id="toast" role="status" aria-live="polite"/);
  const ctx = loadClient();
  assert.match(ctx.ico('trash'), /aria-hidden="true"/);
});

/* ניגודיות: צבע הטקסט מול הרקע שלו, מתוך ה-CSS עצמו (WCAG AA = 4.5:1).
   כשסלקטור מופיע כמה פעמים — הכלל האחרון מנצח, כמו בדפדפן. */
test('text colours meet WCAG AA contrast (toasts, verdicts, batch results, run button, tape cells)', () => {
  const html = fs.readFileSync(path.join(__dirname, 'automata.html'), 'utf8');
  const css = html.slice(html.indexOf('<style>'), html.lastIndexOf('</style>'));
  const vars = {};
  for (const m of css.matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})/g)) if (!(m[1] in vars)) vars[m[1]] = m[2];
  const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prop = (selector, name) => {
    let val = null;
    for (const m of css.matchAll(new RegExp(`(?:^|[}\\s])${reEsc(selector)}\\s*\\{([^}]*)\\}`, 'g'))) {
      const d = m[1].match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`));
      if (d) val = d[1].trim();
    }
    if (!val) return null;
    const v = val.match(/var\(--([\w-]+)\)/);
    return v ? vars[v[1]] : (val.match(/#[0-9a-fA-F]{6}/) || [null])[0];
  };
  const lum = h => { const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const checks = [
    ['.toast.danger', '#ffffff', prop('.toast.danger', 'background')],
    ['.toast.success', '#ffffff', prop('.toast.success', 'background')],
    ['.btn-run', '#ffffff', prop('.btn-run', 'background')],
    ['.verdict.ok', prop('.verdict.ok', 'color'), '#bbf7d0'],
    ['.verdict.bad', prop('.verdict.bad', 'color'), '#fecaca'],
    ['.bres.ok', prop('.bres.ok', 'color'), '#ffffff'],
    ['.bres.bad', prop('.bres.bad', 'color'), '#ffffff'],
    ['.cell.read', prop('.cell.read', 'color'), vars['green-soft']],
    ['.cell.stuck', prop('.cell.stuck', 'color'), vars['red-soft']],
    ['.pda-hint', prop('.pda-hint', 'color'), '#f3f4f6'],
  ];
  for (const [name, fg, bg] of checks) {
    assert.ok(fg && bg, `${name}: colours found (${fg} on ${bg})`);
    assert.ok(ratio(fg, bg) >= 4.5, `${name}: ${fg} on ${bg} = ${ratio(fg, bg).toFixed(2)} < 4.5`);
  }
});
