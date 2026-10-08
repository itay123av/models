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
