/* Differential fuzzing of the five simulation engines (DFA, NFA, DPDA, NPDA, TM).
 * Random machines and words are run through the app's real code (quick run AND
 * step-by-step, loaded from automata.html into a VM) and compared with independent
 * reference implementations written from the documented semantics. Offline, free.
 *
 *   node scripts/fuzz-engines.cjs [machinesPerType=100] [seed=12345]
 *
 * Exit code 1 on any mismatch. 500 machines per type takes several minutes (the
 * NPDA reference search is exhaustive); the app engines themselves stay under 0.5 s
 * per run, and a DPDA run slower than 500 ms is reported as a mismatch. */
const fs = require('fs'), vm = require('vm'), path = require('path');
const root=path.join(__dirname,'..');
function loadClient(){
  const html=fs.readFileSync(path.join(root,'automata.html'),'utf8');
  let js=html.slice(html.indexOf('<script>')+8,html.lastIndexOf('</script>')).replace(/\r?\ninit\(\);\s*$/,'\n');
  const noop=()=>{},fakeEl=new Proxy({},{get(_,k){if(k==='style'||k==='dataset'||k==='classList')return new Proxy({},{get:()=>noop});if(k==='querySelectorAll'||k==='getElementsByTagName')return()=>[];if(k==='querySelector'||k==='closest'||k==='appendChild'||k==='insertBefore')return()=>fakeEl;if(k==='value'||k==='textContent'||k==='innerHTML')return'';return noop;},set:()=>true});
  const sb={console,document:{getElementById:()=>fakeEl,querySelector:()=>fakeEl,querySelectorAll:()=>[],createElement:()=>fakeEl,createElementNS:()=>fakeEl,addEventListener:noop,body:fakeEl},localStorage:{getItem:()=>null,setItem:noop,removeItem:noop},requestAnimationFrame:noop,setTimeout,clearTimeout,fetch:()=>Promise.reject(new Error('offline')),navigator:{clipboard:{writeText:()=>Promise.resolve()}},location:{href:''}};sb.window=sb;
  const ctx=vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(root,'pda-core.js'),'utf8'),ctx);
  vm.runInContext(js,ctx);
  vm.runInContext('globalThis.__setCurrent=v=>{current=v;};globalThis.__getCurrent=()=>current;renderAll=()=>{};renderGraph=()=>{};renderInspector=()=>{};save=()=>{};toast=()=>{};',ctx);
  return ctx;
}

const ctx = loadClient();
const N = Number(process.argv[2] || 100);
let seed = Number(process.argv[3] || 12345);
const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const distinct = new Set();
const pick = a => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const words = (alpha, maxLen, count) => {
  const out = new Set(['']);
  while (out.size < count) { const n = int(1, maxLen); let w = ''; for (let i = 0; i < n; i++) w += pick(alpha); out.add(w); }
  return [...out];
};
const BOT = '⊥';
const report = { mismatches: [], counts: {} };
const note = (type, m) => { report.counts[type] = (report.counts[type] || 0) + 1; if (m) report.mismatches.push(m); };

function mkStates(n, pAcc) {
  return Array.from({ length: n }, (_, i) => ({ id: 'q' + i, label: 'q' + i, x: 100 * i, y: 100, isStart: i === 0, isAccept: rnd() < pAcc }));
}
function stepRun(w) {  // the app's step-by-step engine, as the UI drives it
  const s = ctx.simInit(w); let g = 0;
  while (s.status === 'running' && g++ < 100000) ctx.simStepObj(s);
  return s.status;
}

// ── DFA / NFA ──
function refDFA(m, w) {
  let st = 'q0';
  for (const ch of w) { const t = m.transitions.find(t => t.from === st && t.symbols.includes(ch)); if (!t) return false; st = t.to; }
  return m.states.find(s => s.id === st).isAccept;
}
function refNFA(m, w) {
  const close = set => { const out = new Set(set), st = [...set]; while (st.length) { const q = st.pop(); for (const t of m.transitions) if (t.from === q && t.symbols.includes('ε') && !out.has(t.to)) { out.add(t.to); st.push(t.to); } } return out; };
  let cur = close(['q0']);
  for (const ch of w) { const nx = new Set(); for (const q of cur) for (const t of m.transitions) if (t.from === q && t.symbols.includes(ch)) nx.add(t.to); cur = close(nx); }
  return [...cur].some(q => m.states.find(s => s.id === q).isAccept);
}
for (let k = 0; k < N; k++) {
  const n = int(1, 4), states = mkStates(n, 0.4), transitions = []; let id = 0;
  for (const s of states) for (const a of ['a', 'b']) if (rnd() < 0.8) {
    const to = pick(states).id, ex = transitions.find(t => t.from === s.id && t.to === to);
    if (ex) ex.symbols.push(a); else transitions.push({ id: 't' + id++, from: s.id, to, symbols: [a] });
  }
  const m = { type: 'dfa', ndet: false, states, transitions, tests: [] };
  ctx.__setCurrent(m); distinct.add(JSON.stringify(m.ref || m.transitions) + JSON.stringify(m.states.map(x => x.isAccept)));
  for (const w of words(['a', 'b'], 7, 25)) {
    const ref = refDFA(m, w), quick = ctx.runQuick(w).status === 'accepted', step = stepRun(w) === 'accepted';
    note('dfa', ref !== quick || ref !== step ? { type: 'dfa', w, ref, quick, step, m: JSON.stringify(m) } : null);
  }
}
for (let k = 0; k < N; k++) {
  const n = int(1, 4), states = mkStates(n, 0.35), transitions = []; let id = 0;
  for (const s of states) { const c = int(0, 3); for (let i = 0; i < c; i++) transitions.push({ id: 't' + id++, from: s.id, to: pick(states).id, symbols: [pick(['a', 'b', 'ε'])] }); }
  const m = { type: 'dfa', ndet: true, states, transitions, tests: [] };
  ctx.__setCurrent(m); distinct.add(JSON.stringify(m.ref || m.transitions) + JSON.stringify(m.states.map(x => x.isAccept)));
  for (const w of words(['a', 'b'], 7, 25)) {
    const ref = refNFA(m, w), quick = ctx.runQuick(w).status === 'accepted', step = stepRun(w) === 'accepted';
    note('nfa', ref !== quick || ref !== step ? { type: 'nfa', w, ref, quick, step, m: JSON.stringify(m) } : null);
  }
}

// ── PDA (deterministic + non-deterministic) ──
function refRuleOk(r) {                      // documented semantics of an executable rule
  if (!['push', 'pop', 'none'].includes(r.op)) return false;
  if (r.op === 'push' && (!r.sym || r.sym === BOT)) return false;
  if (r.op === 'pop' && (!r.sym || r.sym === BOT || r.top === BOT || (r.top && r.top !== r.sym))) return false;
  return true;
}
function refSucc(m, cfg, w, bound) {
  const out = [];
  for (const r of m.ref) {
    if (r.from !== cfg.state || !refRuleOk(r)) continue;
    if (r.read && (cfg.pos >= w.length || w[cfg.pos] !== r.read)) continue;
    const top = cfg.stack[0];
    if (r.top && top !== r.top) continue;
    let stack = cfg.stack;
    if (r.op === 'push') stack = [r.sym, ...cfg.stack];
    if (r.op === 'pop') { if (top !== r.sym || cfg.stack.length <= 1) continue; stack = cfg.stack.slice(1); }
    if (bound && stack.length > bound) continue;
    out.push({ state: r.to, pos: cfg.pos + (r.read ? 1 : 0), stack });
  }
  return out;
}
const acc = (m, c, w) => c.pos === w.length && m.states.find(s => s.id === c.state).isAccept && c.stack.length === 1 && c.stack[0] === BOT;
const key = c => c.state + '|' + c.pos + '|' + c.stack.join('');
function refDPDA(m, w) {
  let c = { state: 'q0', pos: 0, stack: [BOT] };
  for (let i = 0; i < 20000; i++) {
    if (acc(m, c, w)) return true;
    const nx = refSucc(m, c, w, 0), uniq = new Map(nx.map(x => [key(x), x]));
    if (uniq.size !== 1) return false;       // stuck, or several different outcomes: not accepted
    c = [...uniq.values()][0];
  }
  return false;                              // never halts: not accepted
}
function refNPDA(m, w, bound) {
  const seen = new Set(), q = [{ state: 'q0', pos: 0, stack: [BOT] }];
  for (let h = 0; h < q.length && h < 60000; h++) {
    const c = q[h], k = key(c); if (seen.has(k)) continue; seen.add(k);
    if (acc(m, c, w)) return true;
    q.push(...refSucc(m, c, w, bound));
  }
  return false;
}
function genPDA(ndet) {
  const n = int(1, 3), states = mkStates(n, 0.45), ref = [];
  const rules = int(1, 6);
  for (let i = 0; i < rules; i++) {
    const op = pick(['push', 'push', 'pop', 'pop', 'none']);
    const top = pick(['', BOT, 'A', 'A', 'B']);
    const sym = op === 'push' ? pick(['A', 'B']) : op === 'pop' ? (rnd() < 0.85 ? (top || pick(['A', 'B'])) : pick(['A', 'B', BOT])) : '';
    ref.push({ from: pick(states).id, to: pick(states).id, read: pick(['', 'a', 'b', 'a', 'b']), top, op, sym });
  }
  const transitions = []; let id = 0;
  for (const r of ref) {
    let t = transitions.find(t => t.from === r.from && t.to === r.to);
    if (!t) { t = { id: 't' + id++, from: r.from, to: r.to, rules: [] }; transitions.push(t); }
    t.rules.push(ctx.pdaMakeRule(r.read, r.top, r.op, r.op === 'push' ? r.sym : '', r.op === 'pop' ? r.sym : ''));
  }
  return { type: 'pda', ndet, states, transitions, tests: [], ref };
}
let dpdaAmbiguous = 0, npdaBoundMiss = 0;
for (let k = 0; k < N; k++) {
  const m = genPDA(false);
  ctx.__setCurrent(m); distinct.add(JSON.stringify(m.ref || m.transitions) + JSON.stringify(m.states.map(x => x.isAccept)));
  const v = ctx.computeValidation();
  if (v.ambiguities && v.ambiguities.length) { dpdaAmbiguous++; continue; }   // the UI refuses to run these
  for (const w of words(['a', 'b'], 6, 20)) {
    const ref = refDPDA(m, w); const t0 = Date.now();
    const quick = ctx.runQuick(w).status === 'accepted', step = stepRun(w) === 'accepted';
    const ms = Date.now() - t0;
    note('dpda', ref !== quick || ref !== step || ms > 500 ? { type: 'dpda', w, ref, quick, step, ms, m: JSON.stringify(m.ref) } : null);
  }
}
for (let k = 0; k < N; k++) {
  const m = genPDA(true);
  ctx.__setCurrent(m); distinct.add(JSON.stringify(m.ref || m.transitions) + JSON.stringify(m.states.map(x => x.isAccept)));
  for (const w of words(['a', 'b'], 6, 20)) {
    const ref = refNPDA(m, w, w.length + 30), refTight = refNPDA(m, w, w.length + 20);
    const quick = ctx.runQuick(w).status === 'accepted', step = stepRun(w) === 'accepted';
    if (ref !== refTight) npdaBoundMiss++;
    note('npda', ref !== quick || ref !== step ? { type: 'npda', w, ref, quick, step, m: JSON.stringify(m.ref) } : null);
  }
}

// ── Turing machine ──
function refTM(m, w) {
  const tape = new Map(); tape.set(-2, '&'); tape.set(-1, '&'); [...w].forEach((c, i) => tape.set(i, c)); tape.set(w.length, '&');
  let st = 'q0', head = 0, steps = 0;
  const isAcc = id => m.states.find(s => s.id === id).isAccept;
  for (;;) {
    if (isAcc(st)) return 'accepted';
    const read = tape.has(head) ? tape.get(head) : '_';
    let rule = null, t = null;
    for (const tr of m.transitions) { if (tr.from !== st) continue; const r = tr.rules.find(r => r.read === read); if (r) { rule = r; t = tr; break; } }
    if (!rule) return 'rejected';
    if (read !== '&') tape.set(head, rule.write);
    head += rule.move === 'R' ? 1 : rule.move === 'L' ? -1 : 0; st = t.to; steps++;
    if (isAcc(st)) return 'accepted';
    if (steps > 20000) return 'stopped';
  }
}
for (let k = 0; k < N; k++) {
  const n = int(1, 4), states = mkStates(n, 0.3), transitions = []; let id = 0;
  for (const s of states) for (const rd of ['0', '1', '_', '&']) if (rnd() < 0.6) {
    const to = pick(states).id; let t = transitions.find(t => t.from === s.id && t.to === to);
    if (!t) { t = { id: 't' + id++, from: s.id, to, rules: [] }; transitions.push(t); }
    t.rules.push({ read: rd, write: pick(['0', '1', '_']), move: pick(['L', 'R', 'R', 'S']) });
  }
  const m = { type: 'tm', ndet: false, states, transitions, tests: [] };
  ctx.__setCurrent(m); distinct.add(JSON.stringify(m.ref || m.transitions) + JSON.stringify(m.states.map(x => x.isAccept)));
  for (const w of words(['0', '1'], 6, 15)) {
    const ref = refTM(m, w), quick = ctx.runQuick(w).status, step = stepRun(w);
    note('tm', ref !== quick || ref !== step ? { type: 'tm', w, ref, quick, step, m: JSON.stringify(m) } : null);
  }
}
console.error('done');console.log('comparisons per type:', JSON.stringify(report.counts));
console.log('DPDA machines skipped as statically ambiguous (UI refuses to run):', dpdaAmbiguous);
console.log('NPDA cases where a stack bound of len+20 changes the reference answer:', npdaBoundMiss);
console.log('distinct machines tested:', distinct.size); console.log('mismatches:', report.mismatches.length);
const byType = {}; report.mismatches.forEach(x => { (byType[x.type] = byType[x.type] || []).push(x); });
for (const [t, list] of Object.entries(byType)) { console.log(`-- ${t}: ${list.length}`); list.slice(0, 3).forEach(x => console.log('   ', JSON.stringify(x).slice(0, 700))); }

if (report.mismatches.length) process.exitCode = 1;
