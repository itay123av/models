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

/* ── ייבוא ונתונים שמורים ───────────────────────────────────────────── */

test('import: a transition to a missing state is dropped with a message instead of breaking the app on every load', () => {
  const ctx = loadClient();
  const toasts = quietUi(ctx);
  vm.runInContext('openAutomaton=id=>{ current=DB.automata.find(a=>a.id===id); };', ctx);
  ctx.importData({ name: 'שבור', states: [{ id: 'a', label: 'q0', x: 100, y: 100, isStart: true }, { label: 'q1' }],
    transitions: [{ id: 't', from: 'a', to: 'zzz', symbols: ['a'] }, { from: 'a', to: 'a' }] });
  const m = ctx.__getCurrent();
  assert.equal(m.transitions.length, 1, 'the dangling transition is gone');
  assert.deepEqual(Array.from(m.transitions[0].symbols), [], 'missing symbols become an empty list, not undefined');
  assert.ok(m.states.every(s => typeof s.id === 'string' && s.id && Number.isFinite(s.x) && Number.isFinite(s.y)), 'every state has an id and a position');
  assert.equal(new Set(m.states.map(s => s.id)).size, 2);
  assert.ok(toasts.some(t => /מעבר אחד הושמט/.test(t.message)), 'the user is told what was dropped');
  assert.equal(ctx.edgeGeom(m.transitions[0]) != null, true, 'drawing no longer throws');
});

test('import: model types from other spellings and rule arrays are normalised', () => {
  const ctx = loadClient();
  quietUi(ctx);
  vm.runInContext('openAutomaton=id=>{ current=DB.automata.find(a=>a.id===id); };', ctx);
  ctx.importData({ automata: [
    { name: 'n', type: 'nfa', states: [{ id: 's', label: 'q0' }], transitions: [{ from: 's', to: 's', symbols: 'ab' }] },
    { name: 'p', type: 'pda', states: [{ id: 's', label: 'q0' }], transitions: [{ from: 's', to: 's' }] },
    null, 'x',
  ] });
  const db = vm.runInContext('DB', ctx);
  const [n, p] = db.automata.slice(-2);
  assert.equal(n.type, 'dfa'); assert.equal(n.ndet, true);
  assert.deepEqual(Array.from(n.transitions[0].symbols), ['a', 'b']);
  assert.deepEqual(Array.from(p.transitions[0].rules), []);
});

test('load: stored data with a dangling transition or a null model is repaired, not fatal', () => {
  const ctx = loadClient();
  const toasts = quietUi(ctx);
  const stored = JSON.stringify({ automata: [null,
    { id: 'm', name: 'ישן', type: 'dfa', states: [{ id: 'a', label: 'q0', x: 0, y: 0, isStart: true }],
      transitions: [{ id: 't', from: 'a', to: 'gone', symbols: ['a'] }] }], settings: { lastId: 'm' } });
  ctx.localStorage.getItem = () => stored;
  ctx.load();
  const db = vm.runInContext('DB', ctx);
  assert.equal(db.automata.length, 1, 'the null entry is dropped');
  assert.equal(db.automata[0].transitions.length, 0);
  assert.equal(vm.runInContext('LOAD_REPAIRED', ctx), 1, 'the repair is counted so init can tell the user');
});

test('JSON import errors are in Hebrew and say where the problem is', () => {
  const ctx = loadClient();
  assert.equal(ctx.jsonSyntaxErrorAt('{"a":1}'), -1);
  assert.equal(ctx.jsonSyntaxErrorAt('{"a":1,}'), 7);
  assert.equal(ctx.jsonSyntaxErrorAt('[1,2'), 4);
  assert.equal(ctx.jsonSyntaxErrorAt('{"a":"x\\q"}'), 8);
  assert.equal(ctx.jsonSyntaxErrorAt('{"a": tru}'), 9, 'points at the first wrong character');
  assert.equal(ctx.jsonSyntaxErrorAt('{"a":1} x'), 8);
  assert.equal(ctx.jsonSyntaxErrorAt('-'), 0);
  let msg = ctx.jsonErrorText('{\n  "name": "x",\n  "states": [1,,2]\n}');
  assert.match(msg, /שורה 3/);
  assert.match(msg, /עמודה 16/, 'the second comma of [1,,2]');
  assert.match(msg, /«\u2066,\u2069»/, 'the character is LTR-isolated so } is not shown mirrored as { in Hebrew text');
  assert.doesNotMatch(msg.replace(/JSON/g, ''), /[A-Za-z]{3,}/, 'no English browser text');
  msg = ctx.jsonErrorText('{"a": [1, 2');
  assert.match(msg, /נגמר באמצע/);
  assert.match(ctx.jsonErrorText('   '), /ריק/);
  assert.match(ctx.jsonErrorText('{"a":"line\nbreak"}'), /ירידת שורה/);
});

/* ── שתי לשוניות דפדפן ──────────────────────────────────────────────── */

test('two browser tabs: a save in the other tab is loaded here, so this tab no longer overwrites it with a stale copy', () => {
  const ctx = loadClient();
  vm.runInContext('renderAll=()=>{}; stopPlay=()=>{};', ctx);
  const toasts = [];
  ctx.toast = (m, k) => toasts.push({ m, k });
  let stored = null;
  ctx.localStorage.setItem = (k, v) => { if (k === 'automata_data_v1') stored = v; };
  const mine = { id: 'm1', name: 'שלי', type: 'dfa', tests: [], states: [{ id: 'a', label: 'q0', x: 0, y: 0, isStart: true }], transitions: [] };
  const db = vm.runInContext('DB', ctx);
  db.automata = [mine];
  ctx.__setCurrent(mine);
  vm.runInContext("UNDO={restore(){}, seq:0}; sel={type:'state',id:'a'};", ctx);

  // הלשונית השנייה שמרה: המודל שלי עם מצב נוסף, ומודל חדש
  const other = { automata: [
    { id: 'm1', name: 'שלי', type: 'dfa', tests: [], states: [{ id: 'a', label: 'q0', x: 0, y: 0, isStart: true }, { id: 'b', label: 'q1', x: 9, y: 9 }], transitions: [] },
    { id: 'm2', name: 'מהלשונית השנייה', type: 'dfa', tests: [], states: [], transitions: [] }], settings: { lastId: 'm2' } };
  assert.equal(ctx.onStorageSync({ key: 'automata_data_v1', newValue: JSON.stringify(other) }), true);
  assert.deepEqual(Array.from(db.automata, a => a.id), ['m1', 'm2'], 'the other tab\'s model is here');
  assert.equal(ctx.__getCurrent().id, 'm1', 'this tab keeps showing its own model');
  assert.equal(ctx.__getCurrent().states.length, 2, 'with the other tab\'s change');
  assert.equal(vm.runInContext('UNDO', ctx), null, 'an undo snapshot from before the sync could roll back the other tab, so it is dropped');
  assert.equal(vm.runInContext('sel.id', ctx), 'a', 'a selection that still exists is kept');

  ctx.save();
  assert.deepEqual(JSON.parse(stored).automata.map(a => a.id), ['m1', 'm2'], 'the next save here keeps the other tab\'s work');

  assert.equal(ctx.onStorageSync({ key: 'automata_cp_collapsed', newValue: '1' }), false, 'other keys are ignored');
  assert.equal(ctx.onStorageSync({ key: 'automata_data_v1', newValue: '{broken' }), false, 'unreadable data is ignored');

  // המודל הפתוח נמחק בלשונית השנייה
  ctx.onStorageSync({ key: 'automata_data_v1', newValue: JSON.stringify({ automata: [other.automata[1]] }) });
  assert.equal(ctx.__getCurrent().id, 'm2');
  assert.match(toasts.at(-1).m, /נמחק בלשונית אחרת/);
});

/* DOM קטן מספיק ל-_buildDialog ולחלונות המעבר: כל querySelector מחזיר אלמנט
   קבוע לכל סלקטור (עם value), והכפתורים שנוצרו נרשמים כדי שאפשר יהיה ללחוץ. */
function miniDom(ctx) {
  const created = [];
  const miniEl = tag => {
    const subs = {};
    const el = {
      tagName: String(tag).toUpperCase(), children: [], style: {}, dataset: {}, attrs: {}, value: '', textContent: '', innerHTML: '', className: '', isConnected: true,
      classList: { s: new Set(), add(...c) { c.forEach(x => this.s.add(x)); }, remove(...c) { c.forEach(x => this.s.delete(x)); }, contains(c) { return this.s.has(c); },
        toggle(c, on) { if (on === undefined) on = !this.s.has(c); if (on) this.s.add(c); else this.s.delete(c); return on; } },
      appendChild(c) { this.children.push(c); return c; }, append(...c) { this.children.push(...c); }, insertBefore(c) { this.children.push(c); return c; },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; }, removeAttribute(k) { delete this.attrs[k]; },
      addEventListener() {}, removeEventListener() {}, focus() {}, select() {}, remove() { this.isConnected = false; }, closest() { return null; },
      querySelector(sel) { if (sel === 'input,textarea') return null; return subs[sel] || (subs[sel] = miniEl('div')); },
      querySelectorAll() { return []; }, getClientRects() { return [1]; },
    };
    created.push(el);
    return el;
  };
  ctx.document.createElement = miniEl;
  ctx.document.removeEventListener = () => {};
  return {
    created,
    clickPrimary() { const b = created.filter(e => e.tagName === 'BUTTON' && /btn-primary/.test(e.className)).at(-1); b.onclick(); },
  };
}

function pdaTabModels() {
  const rule = (read, top, op, push) => ({ read, top, op, push: push ? [push] : [] });
  return [
    { id: 'm1', name: 'מחסנית', type: 'pda', tests: [], states: [{ id: 'a', label: 'q0', x: 0, y: 0, isStart: true }, { id: 'b', label: 'q1', x: 99, y: 0, isAccept: true }],
      transitions: [{ id: 't', from: 'a', to: 'b', rules: [rule('a', '⊥', 'push', 'A')] }] },
    { id: 'm2', name: 'אחר', type: 'dfa', tests: [], states: [{ id: 's', label: 'q0', x: 0, y: 0, isStart: true }], transitions: [] },
  ];
}

function tabB() {
  const ctx = loadClient();
  vm.runInContext('renderAll=()=>{}; renderGraph=()=>{}; renderInspector=()=>{}; renderArmBanner=()=>{}; renderTabs=()=>{}; fitView=()=>{}; stopPlay=()=>{};', ctx);
  const toasts = [];
  ctx.toast = (m, k) => toasts.push({ m, k: k || '' });
  const db = vm.runInContext('DB', ctx);
  db.automata = pdaTabModels();
  ctx.__setCurrent(db.automata[0]);
  const dom = miniDom(ctx);
  return { ctx, toasts, db, dom };
}

test('two tabs: an edit dialog left open while the other tab changes the same model is not saved silently into a stale copy', async () => {
  const { ctx, toasts, db, dom } = tabB();
  ctx.editPdaTransition('t', 0);                       // לשונית B: חלון עריכת כלל פתוח
  const wrap = dom.created[0];
  wrap.querySelector('#pdaOp').value = 'B';             // משנה: דחיפה של B במקום A

  const fromA = pdaTabModels();                         // לשונית A שמרה שינוי באותו מודל
  fromA[0].transitions[0].rules.push({ read: 'b', top: 'A', op: 'pop', push: [], popSym: 'A' });
  ctx.onStorageSync({ key: 'automata_data_v1', newValue: JSON.stringify({ automata: fromA }) });

  dom.clickPrimary();                                   // B: «שמור שינויים»
  await tick(); await tick();
  const t = db.automata[0].transitions[0];
  const savedHere = t.rules.some(r => (r.push || []).includes('B'));
  const warned = toasts.some(x => x.k === 'danger' && /לשונית אחרת|השתנה/.test(x.m));
  assert.ok(savedHere || warned, 'the edit is either applied to the current model or the user is told it was not saved');
  assert.ok(!toasts.some(x => x.k === 'success' && /עודכן/.test(x.m)), 'no false "saved" message');
  assert.equal(t.rules.length, 2, 'the other tab\'s rule is not lost');
});

test('two tabs: an edit dialog stays valid when the other tab changed a different model', async () => {
  const { ctx, toasts, db, dom } = tabB();
  ctx.editPdaTransition('t', 0);
  dom.created[0].querySelector('#pdaOp').value = 'B';
  const fromA = pdaTabModels();
  fromA[1].name = 'אחר — שונה בלשונית A';
  ctx.onStorageSync({ key: 'automata_data_v1', newValue: JSON.stringify({ automata: fromA }) });
  dom.clickPrimary();
  await tick(); await tick();
  assert.deepEqual(Array.from(db.automata[0].transitions[0].rules[0].push), ['B'], 'the edit is saved');
  assert.equal(db.automata[1].name, 'אחר — שונה בלשונית A', 'and the other tab\'s change is kept');
  assert.ok(!toasts.some(x => x.k === 'danger'));
});

/* ── קלטים קיצוניים ─────────────────────────────────────────────────── */

test('a long state name shrinks, then is cut with "…" inside the circle; the full name stays in the tooltip and spoken label', () => {
  const ctx = loadClient();
  const nodes = { innerHTML: '' }, edges = { innerHTML: '' };
  Object.assign(ctx.__elements, { nodes, edges, stageEmpty: { style: {} }, canvas: { querySelector: () => null } });
  vm.runInContext('renderAiReviewPanel=()=>{};', ctx);
  const long = 'מצב_עם_שם_ארוך_מאוד';
  faModel(ctx, false, []);
  ctx.__getCurrent().states[0].label = long;
  ctx.__getCurrent().states[1].label = 'q12345';
  ctx.renderGraph();
  const texts = [...nodes.innerHTML.matchAll(/<text class="nlabel"([^>]*)>([^<]*)<\/text>/g)].map(m => ({ attrs: m[1], text: m[2] }));
  assert.equal(texts.length, 2);
  assert.ok(texts[0].text.endsWith('…') && texts[0].text.length <= 9, `cut to fit: ${texts[0].text}`);
  assert.match(texts[0].attrs, /font-size:\s*1[0-3]px/);
  assert.match(nodes.innerHTML, new RegExp(`<title>${long}</title>`), 'full name on hover');
  assert.match(nodes.innerHTML, new RegExp(`aria-label="מצב ${long}, התחלתי"`), 'full name for screen readers');
  assert.equal(texts[1].text, 'q12345', 'a medium name is only made smaller');
  assert.match(texts[1].attrs, /font-size/);
  ctx.__getCurrent().states[1].label = 'q1';
  ctx.renderGraph();
  assert.doesNotMatch(nodes.innerHTML, /<text class="nlabel"[^>]*font-size[^>]*>q1</, 'short names keep the normal size');
});

test('a very long word: the tape draws a window around the head, not every cell (each step re-laid-out 1000 cells)', () => {
  const ctx = loadClient();
  const word = [...'ab'.repeat(500)];
  word[500] = 'X';
  const count = html => (html.match(/<span class="cell(?! more)[^"]*">/g) || []).length;
  const hidden = html => [...html.matchAll(/class="cell more"[^>]*>…(\d+)</g)].reduce((s, m) => s + Number(m[1]), 0);

  let html = ctx.tapeHTML(word, 500, 'running');
  assert.ok(count(html) <= 130, `drawn cells: ${count(html)}`);
  assert.match(html, /<span class="cell head">X<span class="hmark">/, 'the head cell is drawn');
  assert.equal(count(html) + hidden(html), 1000, 'the "…N" markers account for every hidden cell');

  html = ctx.tapeHTML(word, 1000, 'accepted');
  assert.ok(count(html) <= 130 && hidden(html) + count(html) === 1000, 'end of the word');
  html = ctx.tapeHTML(word, 0, 'preview');
  assert.ok(count(html) <= 130 && hidden(html) + count(html) === 1000, 'preview starts at the beginning');
  assert.equal(count(ctx.tapeHTML([...'abc'], 1, 'running')), 3, 'short words are drawn whole, without markers');
  assert.doesNotMatch(ctx.tapeHTML([...'abc'], 1, 'running'), /cell more/);

  html = ctx.pdaInputHTML({ input: word.join(''), pos: 500, stack: ['⊥'] });
  assert.ok(count(html) <= 130 && hidden(html) + count(html) === 1000, 'PDA input');
  html = ctx.pdaInputHTML({ npda: true, input: word.join(''), configs: [{ pos: 400 }, { pos: 420 }] });
  assert.ok(count(html) <= 160 && hidden(html) + count(html) === 1000, 'NPDA input with several heads');
  assert.ok(count(ctx.pdaInputPreview(word.join(''))) <= 130, 'PDA preview');
  assert.ok(count(ctx.tmPreviewHTML(word.join(''))) <= 130, 'TM preview');
  const tape = { '-2': '&', '-1': '&', 1000: '&' };
  word.forEach((c, i) => { tape[i] = c; });
  html = ctx.tmTapeHTML({ tape, head: 500 });
  assert.ok(count(html) <= 130, `TM tape cells: ${count(html)}`);
  assert.match(html, /cell head[^"]*">X/);
});

/* ── Ctrl+Z ─────────────────────────────────────────────────────────── */

test('Ctrl+Z undoes the last deletion (same window as the «בטל» button), also on a Hebrew keyboard layout', () => {
  const ctx = loadClient();
  vm.runInContext('renderAll=()=>{}; renderGraph=()=>{}; renderInspector=()=>{}; renderTabs=()=>{}; fitView=()=>{}; stopPlay=()=>{}', ctx);
  const toasts = [];
  ctx.toast = (m, k) => toasts.push({ m, k });
  ctx.toastAction = () => {};
  const model = { id: 'm1', name: 'עבודה', type: 'dfa', tests: [],
    states: [{ id: 'a', label: 'q0', isStart: true }, { id: 'b', label: 'q1' }], transitions: [] };
  vm.runInContext('DB', ctx).automata = [model];
  ctx.__setCurrent(model);
  const key = extra => Object.assign({ key: 'z', code: 'KeyZ', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false,
    prevented: false, preventDefault() { this.prevented = true; } }, extra);

  ctx.deleteState('b');
  const e = key({ key: 'ז' });                 // Ctrl+Z בפריסה עברית: key הוא ז, code נשאר KeyZ
  assert.equal(ctx.handleUndoShortcut(e), true);
  assert.equal(e.prevented, true);
  assert.equal(ctx.__getCurrent().states.length, 2, 'the state is back');

  assert.equal(ctx.handleUndoShortcut(key()), true, 'still handled when there is nothing to undo');
  assert.match(toasts.at(-1).m, /אין מה לבטל/);
  assert.equal(ctx.handleUndoShortcut(key({ shiftKey: true })), false, 'Ctrl+Shift+Z is not undo');
  assert.equal(ctx.handleUndoShortcut(key({ ctrlKey: false })), false, 'plain z is not undo');
  assert.equal(ctx.handleUndoShortcut(key({ ctrlKey: false, metaKey: true })), true, 'Cmd+Z on a Mac');

  const guide = { innerHTML: '' };
  ctx.__elements.guideBody = guide;
  for (const m of [{ type: 'dfa' }, { type: 'dfa', ndet: true }, { type: 'pda' }, { type: 'tm' }]) {
    ctx.__setCurrent(Object.assign({ states: [], transitions: [] }, m));
    ctx.renderGuide();
    assert.match(guide.innerHTML, /Ctrl\+Z/, `the ${m.type}${m.ndet ? ' ndet' : ''} guide mentions Ctrl+Z`);
  }
});

test('pasting invalid JSON in the scan dialog shows the Hebrew message with position, not the browser\'s English text', () => {
  const ctx = loadClient();
  const src = ctx.openAiScan.toString();
  assert.doesNotMatch(src, /'JSON לא תקין: '\s*\+\s*err\.message/, 'the English browser message is gone');
  assert.match(src, /jsonErrorText\(text,\{pasted:true\}\)/);
  assert.match(ctx.jsonErrorText('{,}', { pasted: true }), /^ה-JSON שהודבק לא תקין/, 'pasted text is not called a file');
});

/* ── מחיקות מיידיות עם «בטל» ───────────────────────────────────────── */

function undoHarness() {
  const ctx = loadClient();
  vm.runInContext('renderAll=()=>{}; renderGraph=()=>{}; renderInspector=()=>{}; renderTabs=()=>{}; renderTopbar=()=>{}; fitView=()=>{}; stopPlay=()=>{};', ctx);
  const toasts = [], actions = [];
  vm.runInContext('globalThis.TOAST = toast;', ctx);  // שמירת המקורית לבדיקה שצריכה אותה
  ctx.toast = (m, k) => toasts.push({ m, k: k || '' });
  const realAction = ctx.toastAction;                  // הודעת «בטל» נרשמת, והמקורית ממשיכה לרוץ
  ctx.toastAction = (...a) => { toasts.push({ m: a[0], k: 'action' }); return realAction(...a); };
  ctx.confirmDialog = () => { throw new Error('no confirmation dialog for deletions'); };
  const db = vm.runInContext('DB', ctx);
  db.automata = pdaTabModels();
  db.automata[0].transitions[0].rules.push({ read: 'b', top: 'A', op: 'pop', push: [], popSym: 'A' });
  db.automata.push({ id: 'm3', name: 'טיורינג', type: 'tm', tests: [], states: [{ id: 'x', label: 'q0', x: 0, y: 0, isStart: true }],
    transitions: [{ id: 'tt', from: 'x', to: 'x', rules: [{ read: '0', write: '1', move: 'R' }, { read: '1', write: '0', move: 'R' }] }] });
  ctx.__setCurrent(db.automata[0]);
  const ctrlZ = () => ctx.handleUndoShortcut({ key: 'z', code: 'KeyZ', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, preventDefault() {} });
  return { ctx, db, toasts, actions, ctrlZ };
}

test('deleting a PDA rule is immediate and can be undone (button and Ctrl+Z); the last rule takes the arrow with it', () => {
  const { ctx, db, toasts, ctrlZ } = undoHarness();
  ctx.deletePdaRule('t', 0);
  let t = db.automata[0].transitions[0];
  assert.equal(t.rules.length, 1, 'deleted at once, no dialog');
  assert.equal(ctrlZ(), true);
  assert.equal(db.automata[0].transitions[0].rules.length, 2, 'Ctrl+Z brings it back');

  ctx.deletePdaRule('t', 0); ctx.deletePdaRule('t', 0);
  assert.equal(db.automata[0].transitions.length, 0, 'no rules left → the arrow is gone too');
  assert.match(toasts.at(-1).m, /המעבר/, 'the message says the arrow went too');
  assert.equal(ctx.undoLast(), true);
  t = db.automata[0].transitions[0];
  assert.ok(t && t.rules.length === 1, 'undo brings back the arrow with its rule (not an empty arrow)');
});

test('deleting a Turing-machine rule is immediate and can be undone', () => {
  const { ctx, db } = undoHarness();
  ctx.__setCurrent(db.automata[2]);
  ctx.deleteTmRule('tt', 1);
  assert.equal(db.automata[2].transitions[0].rules.length, 1);
  assert.equal(ctx.undoLast(), true);
  assert.deepEqual(Array.from(db.automata[2].transitions[0].rules, r => r.read), ['0', '1']);
});

test('deleting a whole model can be undone even after other changes; Ctrl+Z works over the library', () => {
  const { ctx, db, ctrlZ } = undoHarness();
  ctx.delAutomaton('m2');
  ctx.__getCurrent().name = 'שינוי אחר'; ctx.save();       // שינוי אחר אחרי המחיקה
  assert.equal(ctrlZ(), true);
  assert.deepEqual(Array.from(db.automata, a => a.id), ['m1', 'm2', 'm3'], 'the model is back in its place');
  assert.equal(db.automata[0].name, 'שינוי אחר', 'the other change is kept');

  // מעל הספרייה Ctrl+Z מותר; מעל חלון עריכה — לא
  ctx.document.querySelectorAll = () => [{ dataset: { allowUndo: '1' }, classList: { contains: () => false } }];
  assert.equal(ctx.undoShortcutAllowed(), true, 'library on top');
  ctx.document.querySelectorAll = () => [{ dataset: {}, classList: { contains: () => false } }];
  assert.equal(ctx.undoShortcutAllowed(), false, 'an edit dialog on top');
  ctx.document.querySelectorAll = () => [];
  assert.equal(ctx.undoShortcutAllowed(), true, 'no dialog');
});

test('the library deletes a model without a confirmation dialog', () => {
  const { ctx, db } = undoHarness();
  assert.equal(typeof ctx.libraryAction, 'function', 'library clicks go through libraryAction');
  ctx.libraryAction({ del: 'm2' });
  assert.deepEqual(Array.from(db.automata, a => a.id), ['m1', 'm3'], 'deleted at once');
  assert.equal(ctx.undoLast(), true);
  assert.equal(db.automata.length, 3);
});

test('a «בטל» offer ends when its message is replaced by another message', () => {
  const { ctx } = undoHarness();
  vm.runInContext('toast=TOAST', ctx);                 // ההודעה האמיתית (ה-harness החליף אותה)
  ctx.deletePdaRule('t', 0);
  assert.notEqual(vm.runInContext('UNDO', ctx), null, 'offered');
  ctx.toast('הודעה אחרת');
  assert.equal(vm.runInContext('UNDO', ctx), null, 'the offer is gone with its button, so Ctrl+Z no longer reaches it');
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
