const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
loadEnv(path.join(ROOT, '.secrets', 'openai.env'));
loadEnv(path.join(ROOT, '.env'));
const PORT = intEnv('PORT', 8790, 1, 65535);
const HOST = String(process.env.HOST || '127.0.0.1').trim();
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
const OPENAI_TIMEOUT_MS = intEnv('OPENAI_TIMEOUT_MS', 90_000, 1_000, 300_000);
const RATE_LIMIT_WINDOW_MS = intEnv('RATE_LIMIT_WINDOW_MS', 60_000, 1_000, 3_600_000);
const MAX_PARSE_REQUESTS = intEnv('MAX_PARSE_REQUESTS', 12, 1, 10_000);
const MAX_CONCURRENT_PARSES = intEnv('MAX_CONCURRENT_PARSES', 2, 1, 20);
const DEFAULT_CONFIDENCE = 0.9;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
if (!LOOPBACK_HOSTS.has(HOST)) {
  throw new Error(`Refusing to listen on non-loopback host "${HOST}". Use 127.0.0.1, localhost, or ::1.`);
}

const ALLOWED_ORIGINS = new Set([
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
  `http://[::1]:${PORT}`,
  ...(process.env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(value => value && value !== 'null'),
]);

const PUBLIC_FILES = new Map([
  ['/', 'automata.html'],
  ['/automata.html', 'automata.html'],
]);
const parseRateBuckets = new Map();
let activeParseRequests = 0;

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]]) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[m[1]] = value;
  }
}

function intEnv(name, fallback, min, max) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function send(res, status, data, headers = {}) {
  const body = status === 204 ? '' : (typeof data === 'string' ? data : JSON.stringify(data));
  res.writeHead(status, {
    'content-type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

function isAllowedApiOrigin(req) {
  const origin = req.headers.origin;
  return !origin || ALLOWED_ORIGINS.has(origin);
}

function apiCorsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    vary: 'Origin',
  };
}

function sendApi(req, res, status, data, headers = {}) {
  send(res, status, data, { ...apiCorsHeaders(req), ...headers });
}

function consumeParseQuota(req) {
  const now = Date.now();
  const key = req.socket.remoteAddress || 'unknown';
  let bucket = parseRateBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    parseRateBuckets.set(key, bucket);
  }
  const resetSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  if (bucket.count >= MAX_PARSE_REQUESTS) {
    return { allowed: false, remaining: 0, resetSeconds };
  }
  bucket.count += 1;
  return { allowed: true, remaining: MAX_PARSE_REQUESTS - bucket.count, resetSeconds };
}

function readBody(req, limit = 24 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    let finished = false;
    req.on('data', chunk => {
      if (finished) return;
      size += chunk.length;
      if (size > limit) {
        finished = true;
        const err = new Error('Request body is too large');
        err.status = 413;
        reject(err);
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => {
      if (!finished) resolve(Buffer.concat(parts).toString('utf8'));
    });
    req.on('error', err => {
      if (!finished) reject(err);
    });
  });
}

function mime(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
  }[ext] || 'application/octet-stream';
}

function stateId(field, fallback = '') {
  if (field == null) return fallback;
  if (typeof field === 'string' || typeof field === 'number') return String(field);
  return String(field.id || field.value || field.label || fallback);
}

const EPSILON = 'ε';

function normalizeSymbolValue(value) {
  const raw = Array.isArray(value) ? value.join('') : String(value ?? '');
  const s = raw.trim();
  if (!s || /^e(ps(ilon)?)?$/i.test(s) || s === EPSILON) return EPSILON;
  // Safety net: a value that is only broken/tofu/replacement glyphs becomes ε so a
  // literal square can never reach the simulator. (Bottom markers map to Z0 below.)
  if (/^[�□▯▢◻◼⬜⬛]+$/.test(s)) return EPSILON;
  return s
    .replace(/[⊥⟂]/g, 'Z0')
    .replace(/Z_?0/gi, 'Z0')
    .replace(/Z₀/g, 'Z0');
}

function hasSymbolValue(value) {
  return normalizeSymbolValue(value) !== EPSILON;
}

function ruleRawText(transition, rule) {
  return String(
    (rule && (rule.raw_label_text ?? rule.raw_text ?? rule.label_text)) ??
    (transition && (transition.raw_label_text ?? transition.raw_text ?? transition.label_text)) ??
    ''
  ).trim();
}

function compactLabelText(raw) {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[–—→⇒]/g, '->')
    .trim();
}

function labelPartBeforeComma(raw) {
  const txt = compactLabelText(raw).replace(/^.*?:/, '').trim();
  return (txt.split(/[,\u060C،，/]/)[0] || '').trim();
}

function labelPartBetweenCommaAndSlash(raw) {
  const txt = compactLabelText(raw).replace(/^.*?:/, '').trim();
  const afterComma = txt.split(/[,\u060C،，]/).slice(1).join(',');
  return (afterComma.split('/')[0] || '').trim();
}

function labelPartAfterSlash(raw) {
  const txt = compactLabelText(raw);
  return txt.includes('/') ? txt.split('/').slice(1).join('/').trim() : '';
}

function symbolFromLabelPart(part) {
  const s = String(part || '').trim();
  if (!s) return '';
  if (/^(ε|e|epsilon)$/i.test(s)) return EPSILON;
  const m = s.match(/Z_?0|Z₀|[⊥⟂]|[A-Za-z0-9]/);
  return m ? normalizeSymbolValue(m[0]) : '';
}

function readFromRawLabel(raw) {
  const sym = symbolFromLabelPart(labelPartBeforeComma(raw));
  return sym && sym !== EPSILON ? sym : '';
}

function topFromRawLabel(raw) {
  const sym = symbolFromLabelPart(labelPartBetweenCommaAndSlash(raw));
  return sym && sym !== EPSILON ? sym : '';
}

function actionValueFromRawLabel(raw) {
  const tail = labelPartAfterSlash(raw)
    .replace(/ללא\s*שינוי|בלי\s*שינוי|דחיפה|לדחוף|דוחפים|דחוף|שליפה|לשלוף|שולפים|שלוף|no\s*change|none|push|pop/ig, ' ');
  const sym = symbolFromLabelPart(tail);
  return sym && sym !== EPSILON ? sym : '';
}

// A pop operator drawn as a symbol after the slash: ⊟/⊠/boxes, or the whole
// post-slash part being just a minus / dash / horizontal line. (Domain-agnostic:
// only treat a BARE minus as pop, so "+A" pushes and "i-j" inside text is unaffected.)
function afterSlashIsSymbolicPop(rawLabelText) {
  const label = String(rawLabelText || '');
  if (!label.includes('/')) return false;
  const after = label.split('/').slice(1).join('/').trim();
  if (/[⊟⊠▭□⌷]/.test(after)) return true;          // boxed / struck stack-top = pop
  if (/^[-−–—_]+$/.test(after)) return true;        // bare minus / horizontal line = pop
  return false;
}
function normalizeStackAction(rawAction, rule, rawLabelText = '') {
  const raw = String(rawAction ?? '').trim();
  const label = String(rawLabelText || '').trim();
  if (/ללא\s*שינוי|בלי\s*שינוי|no\s*change|none/i.test(label)) return 'NONE';
  if (/שלו|לשלוף|שליפה|pop/i.test(label)) return 'POP';
  if (afterSlashIsSymbolicPop(label)) return 'POP';   // ⊟ / minus / box after slash = POP
  if (/דח|לדחוף|דוחפ|דחיפה|push/i.test(label)) return 'PUSH';
  const upper = raw.toUpperCase();
  if (upper.includes('NONE') || upper.includes('NO_CHANGE') || upper.includes('NO CHANGE')) return 'NONE';
  if (/שלו|לשלוף|שליפה|pop/i.test(raw)) return 'POP';
  if (/דח|לדחוף|דוחפ|דחיפה|push/i.test(raw)) return 'PUSH';
  const pushValue = (rule.push_value && rule.push_value.value) ?? rule.push;
  if (hasSymbolValue(pushValue)) return 'PUSH';
  return raw ? 'PUSH' : 'NONE';
}

function rewriteRawStackTop(raw, top) {
  const text = String(raw || '');
  return text.replace(/^(\s*[^,،，/]+[,،，]\s*)([^/]*?)(\s*\/.*)$/u, `$1${top}$3`);
}

function rewriteRawRead(raw, read) {
  const text = String(raw || '');
  return text.replace(/^(\s*)([^,،，/]+)([,،，].*)$/u, `$1${read}$3`);
}

function repairInitialStackRules(transitions, states) {
  const start = (states || []).find(s => s.is_start) || (states || [])[0];
  if (!start) return;
  for (const t of transitions) {
    if (!t.source_state || t.source_state.id !== start.id || t.target_state.id === start.id) continue;
    for (const r of t.rules || []) {
      if (!r.stack_action || r.stack_action.type !== 'PUSH') continue;
      if (!r.pop_value || r.pop_value.value === 'Z0') continue;
      r.pop_value.value = 'Z0';
      r.pop_value.confidence = Math.min(Number(r.pop_value.confidence) || DEFAULT_CONFIDENCE, 0.62);
      r.raw_label_text = rewriteRawStackTop(r.raw_label_text, 'Z0');
    }
  }
}

function guessedRepeatedPushInput(transitions) {
  // Domain-agnostic: infer the repeated input letter from the sheet's OWN reads,
  // never from a hard-coded alphabet. Returns the most frequent single-symbol
  // input actually parsed, or null when there is no evidence (so callers skip).
  const tally = new Map();
  for (const t of transitions) for (const r of t.rules || []) {
    const v = r.read_input && r.read_input.value;
    if (v && v !== EPSILON && /^[\p{L}\p{N}]$/u.test(v)) tally.set(v, (tally.get(v) || 0) + 1);
  }
  let best = null, bestN = 0;
  for (const [v, n] of tally) if (n > bestN) { best = v; bestN = n; }
  return best;
}

function repairLikelyFalseEpsilonPushReads(transitions) {
  const guessed = guessedRepeatedPushInput(transitions);
  if (!guessed) return; // no input letter is evidenced on this sheet — never invent one
  for (const t of transitions) {
    if (!Array.isArray(t.rules)) continue;
    const pushRules = t.rules.filter(r =>
      r.stack_action && r.stack_action.type === 'PUSH' &&
      r.push_value && r.push_value.value && r.push_value.value !== EPSILON
    );
    for (const r of pushRules) {
      if (!r.read_input || r.read_input.value !== EPSILON) continue;
      if (r.pop_value && r.pop_value.value === 'Z0') continue;
      r.read_input.value = guessed;
      r.read_input.confidence = Math.min(Number(r.read_input.confidence) || DEFAULT_CONFIDENCE, 0.62);
      r.raw_label_text = rewriteRawRead(r.raw_label_text, guessed);
    }
  }
}

function repairStackingSelfLoopRules(transitions) {
  for (const t of transitions) {
    const src = t.source_state && t.source_state.id;
    const dst = t.target_state && t.target_state.id;
    if (!src || src !== dst || !Array.isArray(t.rules) || t.rules.length < 2) continue;
    const pushRules = t.rules.filter(r =>
      r.stack_action && r.stack_action.type === 'PUSH' &&
      r.push_value && r.push_value.value && r.push_value.value !== EPSILON &&
      r.pop_value && r.pop_value.value && r.pop_value.value !== EPSILON
    );
    for (const repeated of pushRules.filter(r => r.read_input && r.read_input.value !== EPSILON)) {
      const pushValue = repeated.push_value.value;
      if (repeated.pop_value.value === pushValue) continue;
      const setup = pushRules.find(r =>
        r !== repeated &&
        r.read_input && r.read_input.value === EPSILON &&
        r.push_value.value === pushValue &&
        r.pop_value.value === pushValue
      );
      if (!setup) continue;
      const setupTop = repeated.pop_value.value;
      repeated.pop_value.value = pushValue;
      setup.pop_value.value = setupTop;
      repeated.pop_value.confidence = Math.min(Number(repeated.pop_value.confidence) || DEFAULT_CONFIDENCE, 0.68);
      setup.pop_value.confidence = Math.min(Number(setup.pop_value.confidence) || DEFAULT_CONFIDENCE, 0.68);
      repeated.raw_label_text = rewriteRawStackTop(repeated.raw_label_text, pushValue);
      setup.raw_label_text = rewriteRawStackTop(setup.raw_label_text, setupTop);
    }
  }
}

// Structural validation step (domain-agnostic, never fabricates edges): flags any
// non-accepting state that is unreachable from the start, fully isolated, or a
// dead-end. Flagging = lowering confidence below the client's AI_LOW threshold so
// it surfaces in the manual-review panel; transition assignments are left intact.
function flagStructuralProblems(states, transitions) {
  if (!states.length) return [];
  const start = states.find(s => s.is_start) || states[0];
  const ids = new Set(states.map(s => s.id));
  const adj = new Map(states.map(s => [s.id, []]));
  const inNonSelf = new Map(states.map(s => [s.id, 0]));
  const touch = new Map(states.map(s => [s.id, 0]));
  for (const t of transitions) {
    const f = t.source_state && t.source_state.id;
    const d = t.target_state && t.target_state.id;
    if (!ids.has(f) || !ids.has(d)) continue;
    adj.get(f).push(d);
    touch.set(f, touch.get(f) + 1);
    touch.set(d, touch.get(d) + 1);
    if (f !== d) inNonSelf.set(d, inNonSelf.get(d) + 1);
  }
  const reach = new Set([start.id]);
  const queue = [start.id];
  while (queue.length) {
    const cur = queue.shift();
    for (const nx of adj.get(cur) || []) if (!reach.has(nx)) { reach.add(nx); queue.push(nx); }
  }
  const flagged = [];
  for (const s of states) {
    const problems = [];
    if (!touch.get(s.id)) problems.push('isolated');
    else {
      if (!reach.has(s.id) && !s.is_start) problems.push('unreachable from start');
      else if (!inNonSelf.get(s.id) && !s.is_start) problems.push('no incoming arrow');
      if ((adj.get(s.id) || []).length === 0 && !s.is_accepting && !s.is_start) problems.push('dead-end (no outgoing, not accepting)');
    }
    if (problems.length) {
      s.confidence = Math.min(Number(s.confidence) || DEFAULT_CONFIDENCE, 0.55);
      s.structural_issues = problems;
      flagged.push(`${s.id}: ${problems.join(', ')}`);
    }
  }
  if (flagged.length) console.warn('Structural validation flagged orphan/dead-end states:', flagged.join(' | '));
  return flagged;
}

function normalizePayload(value, imageUrl, isPda) {
  const raw = value || {};
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw.transitions) ? raw.transitions : [raw]);
  const states = new Map();
  const putState = (field, fallback, defaults = {}) => {
    const id = stateId(field, fallback).trim();
    if (!id) return;
    const prev = states.get(id) || { id, is_accepting: false, is_start: false, confidence: DEFAULT_CONFIDENCE };
    const obj = field && typeof field === 'object' ? field : {};
    states.set(id, {
      id,
      is_accepting: Boolean(obj.is_accepting ?? obj.isAccepting ?? obj.is_final ?? defaults.is_accepting ?? prev.is_accepting),
      is_start: Boolean(obj.is_start ?? obj.isStart ?? defaults.is_start ?? prev.is_start),
      confidence: Number(obj.confidence ?? defaults.confidence ?? prev.confidence ?? DEFAULT_CONFIDENCE),
    });
  };

  if (Array.isArray(raw.states)) {
    raw.states.forEach((s, i) => putState(s, `q${i}`, { is_start: i === 0 }));
  }

  const transitions = list.filter(Boolean).map((t, i) => {
    const srcId = stateId(t.source_state || t.source, 'q0');
    const dstId = stateId(t.target_state || t.target, 'q1');
    putState(t.source_state || t.source, srcId);
    putState(t.target_state || t.target, dstId);
    // A single drawn arrow may carry several stacked rules; accept the new
    // rules array as well as the legacy flat one-rule-per-transition shape.
    const ruleSrcs = Array.isArray(t.rules) && t.rules.length ? t.rules : [t];
    const rules = ruleSrcs.filter(Boolean).map(r => {
      const rawText = ruleRawText(t, r);
      // DFA/NFA mode: raw_label_text is a bare input-symbol list ("a", "0,1") with no
      // stack zones, so the comma/slash zone-splitting below would corrupt it (the
      // second symbol of "0,1" would be misread as a stack-top). Take the read as-is
      // and force the stack fields empty.
      if (!isPda) {
        return {
          raw_label_text: rawText,
          read_input: {
            value: normalizeSymbolValue((r.read_input && r.read_input.value) ?? r.read ?? EPSILON),
            confidence: Number((r.read_input && r.read_input.confidence) ?? r.read_confidence ?? DEFAULT_CONFIDENCE),
          },
          stack_action: { type: 'NONE', confidence: 1 },
          push_value: { value: EPSILON, confidence: 1 },
          pop_value: { value: EPSILON, confidence: 1 },
        };
      }
      const rawAction = (r.stack_action && r.stack_action.type) ?? r.action;
      const modelAction = String(rawAction || 'NONE').toUpperCase();
      const action = normalizeStackAction(rawAction, r, rawText);
      let readValue = normalizeSymbolValue((r.read_input && r.read_input.value) ?? r.read ?? EPSILON);
      let pushValue = normalizeSymbolValue((r.push_value && r.push_value.value) ?? r.push ?? EPSILON);
      let popValue = normalizeSymbolValue((r.pop_value && r.pop_value.value) ?? r.top ?? r.pop ?? EPSILON);
      let readConfidence = Number((r.read_input && r.read_input.confidence) ?? r.read_confidence ?? DEFAULT_CONFIDENCE);
      let actionConfidence = Number((r.stack_action && r.stack_action.confidence) ?? r.action_confidence ?? DEFAULT_CONFIDENCE);
      let pushConfidence = Number((r.push_value && r.push_value.confidence) ?? r.push_confidence ?? DEFAULT_CONFIDENCE);
      let popConfidence = Number((r.pop_value && r.pop_value.confidence) ?? r.top_confidence ?? r.pop_confidence ?? DEFAULT_CONFIDENCE);
      const rawRead = readFromRawLabel(rawText);
      const rawTop = topFromRawLabel(rawText);
      const rawActionValue = actionValueFromRawLabel(rawText);
      if (rawRead && readValue !== rawRead) {
        readValue = rawRead;
        readConfidence = Math.min(readConfidence, 0.72);
      }
      if (rawTop && popValue !== rawTop) {
        popValue = rawTop;
        popConfidence = Math.min(popConfidence, 0.78);
      }
      if (action !== modelAction && modelAction) actionConfidence = Math.min(actionConfidence, 0.72);
      if (action === 'POP') {
        if (!rawTop && rawActionValue && popValue !== rawActionValue) {
          popValue = rawActionValue;
          popConfidence = Math.min(popConfidence, 0.78);
        }
        if (popValue === EPSILON && pushValue !== EPSILON) popValue = pushValue;
        pushValue = EPSILON;
        pushConfidence = Math.min(pushConfidence, 0.72);
      }
      if (action === 'PUSH' && rawActionValue && pushValue !== rawActionValue) {
        pushValue = rawActionValue;
        pushConfidence = Math.min(pushConfidence, 0.72);
      }
      if (action === 'NONE') {
        pushValue = EPSILON;
        pushConfidence = Math.min(pushConfidence, 0.72);
      }
      return {
        raw_label_text: rawText,
        read_input: {
          value: readValue,
          confidence: readConfidence,
        },
        stack_action: {
          type: action,
          confidence: actionConfidence,
        },
        push_value: {
          value: pushValue,
          confidence: pushConfidence,
        },
        pop_value: {
          value: popValue,
          confidence: popConfidence,
        },
      };
    });
    return ({
    transition_id: String(t.transition_id || `t_${String(i + 1).padStart(2, '0')}`),
    source_state: {
      id: srcId,
      confidence: Number((t.source_state && t.source_state.confidence) ?? t.source_confidence ?? DEFAULT_CONFIDENCE),
    },
    target_state: {
      id: dstId,
      confidence: Number((t.target_state && t.target_state.confidence) ?? t.target_confidence ?? DEFAULT_CONFIDENCE),
    },
    rules,
    cropped_image_segment_url: t.cropped_image_segment_url || imageUrl || '',
    });
  });

  if (isPda) {   // these repair passes assume a stack — never run them on DFA/NFA sheets
    repairInitialStackRules(transitions, [...states.values()]);
    repairStackingSelfLoopRules(transitions);
    repairLikelyFalseEpsilonPushReads(transitions);
  }

  if (states.size && ![...states.values()].some(s => s.is_start)) {
    const first = states.values().next().value;
    if (first) first.is_start = true;
  }
  const stateArr = [...states.values()];
  flagStructuralProblems(stateArr, transitions);
  return { states: stateArr, transitions };
}

function parsedRules(value) {
  const raw = value || {};
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw.transitions) ? raw.transitions : [raw]);
  return list.filter(Boolean).flatMap(t => {
    const rules = Array.isArray(t.rules) && t.rules.length ? t.rules : [t];
    return rules.filter(Boolean).map(r => ({ transition: t, rule: r }));
  });
}

function rawHasActionWord(raw) {
  const s = String(raw || '');
  // Hebrew/English action words …
  if (/ללא\s*שינוי|בלי\s*שינוי|דחיפה|לדחוף|דוחפים|דחוף|שליפה|לשלוף|שולפים|שלוף|no\s*change|none|push|pop/i.test(s)) return true;
  // … or a symbolic operator after the slash: ⊟/box (pop), +X (push), bare minus (pop).
  return /[⊟⊠▭□⌷]/.test(s) || /\/\s*[+\-−–—]/.test(s);
}

function rawLooksLikePdaRule(raw) {
  const s = String(raw || '').trim();
  return s.includes('/') && /[,،，]/.test(s);
}

function parseQualityProblems(value, isPda) {
  const problems = [];
  const analysis = value && value.analysis;
  for (const key of ['input_glyph_audit_table', 'rule_parse_table', 'final_audit_table']) {
    if (!analysis || !String(analysis[key] || '').trim()) problems.push(`missing analysis.${key}`);
  }
  const rules = parsedRules(value);
  if (!rules.length) problems.push('no transition rules');
  rules.forEach(({ transition, rule }, i) => {
    const from = stateId(transition && (transition.source_state || transition.source), '?');
    const to = stateId(transition && (transition.target_state || transition.target), '?');
    const raw = ruleRawText(transition, rule);
    const tag = `rule ${i + 1} ${from}->${to}`;
    if (!raw) problems.push(`${tag}: empty raw_label_text`);
    else if (isPda) {
      // Strict PDA-only checks: a finite-automaton label ("a" / "0,1") has no
      // stack zone or action word, so these must never run in DFA/NFA mode.
      if (!rawLooksLikePdaRule(raw)) problems.push(`${tag}: raw_label_text is not split as input,stack/action`);
      if (!rawHasActionWord(raw)) problems.push(`${tag}: raw_label_text is missing stack action word`);
    }
  });
  return problems;
}

async function parseDiagram(imageUrls, modelType) {
  if (!process.env.OPENAI_API_KEY) {
    const err = new Error('OPENAI_API_KEY is missing. Put it in .env');
    err.status = 401;
    throw err;
  }
  // Hybrid mode context from the client: 'pda' keeps the strict stack-rule pipeline;
  // 'dfa'/'nfa' treat labels as bare input-symbol lists with no stack zones at all.
  // Missing/unknown => 'pda', so legacy clients keep the exact previous behavior.
  const mode = String(modelType || 'pda').trim().toLowerCase();
  const isPda = mode !== 'dfa' && mode !== 'nfa';
  const urls = (Array.isArray(imageUrls) ? imageUrls : [imageUrls]).filter(Boolean).slice(0, 3);

  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      // Visual Chain-of-Thought: generated FIRST (schema order = generation order),
      // forcing the model to audit the topology before emitting states/transitions.
      analysis: {
        type: 'object',
        additionalProperties: false,
          properties: {
          states_table: { type: 'string', minLength: 1 },
          connectors_table: { type: 'string', minLength: 1 },
          label_binding_table: { type: 'string', minLength: 1 },
          input_glyph_audit_table: { type: 'string', minLength: 1 },
          rule_parse_table: { type: 'string', minLength: 1 },
          final_audit_table: { type: 'string', minLength: 1 },
        },
        required: ['states_table', 'connectors_table', 'label_binding_table', 'input_glyph_audit_table', 'rule_parse_table', 'final_audit_table'],
      },
      states: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            is_accepting: { type: 'boolean' },
            is_start: { type: 'boolean' },
            confidence: { type: 'number' },
          },
          required: ['id', 'is_accepting', 'is_start', 'confidence'],
        },
      },
      transitions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            transition_id: { type: 'string' },
            source_state: {
              type: 'object',
              additionalProperties: false,
              properties: { id: { type: 'string' }, confidence: { type: 'number' } },
              required: ['id', 'confidence'],
            },
            target_state: {
              type: 'object',
              additionalProperties: false,
              properties: { id: { type: 'string' }, confidence: { type: 'number' } },
              required: ['id', 'confidence'],
            },
            rules: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  raw_label_text: { type: 'string', minLength: 1 },
                  read_input: {
                    type: 'object',
                    additionalProperties: false,
                    properties: { value: { type: 'string' }, confidence: { type: 'number' } },
                    required: ['value', 'confidence'],
                  },
                  stack_action: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      type: { type: 'string', enum: ['PUSH', 'POP', 'NONE'] },
                      confidence: { type: 'number' },
                    },
                    required: ['type', 'confidence'],
                  },
                  push_value: {
                    type: 'object',
                    additionalProperties: false,
                    properties: { value: { type: 'string' }, confidence: { type: 'number' } },
                    required: ['value', 'confidence'],
                  },
                  pop_value: {
                    type: 'object',
                    additionalProperties: false,
                    properties: { value: { type: 'string' }, confidence: { type: 'number' } },
                    required: ['value', 'confidence'],
                  },
                },
                required: ['raw_label_text', 'read_input', 'stack_action', 'push_value', 'pop_value'],
              },
            },
            cropped_image_segment_url: { type: 'string' },
          },
          required: [
            'transition_id',
            'source_state',
            'target_state',
            'rules',
            'cropped_image_segment_url',
          ],
        },
      },
    },
    required: ['analysis', 'states', 'transitions'],
  };

  // Prompt engineering note for the VLM backend:
  // Fully domain-agnostic visual audit. The model derives BOTH the topology and
  // the lexicon from THIS sheet alone (no assumptions about any specific
  // language/exam/alphabet), writes its chain-of-thought into the analysis tables
  // FIRST, then emits states/transitions strictly derived from those tables.
  const prompt = [
    'You are parsing a hand-drawn automaton diagram (a finite automaton or a pushdown automaton) for a computational-models tool. Be FULLY DOMAIN-AGNOSTIC: make NO assumption about any particular language, exam, alphabet, or "expected" structure — derive everything from THIS sheet alone.',
    'You may receive several image versions of the same sheet: usually a high-contrast text image first, an ink-preserving sharpened image second, and the original photo last. Use ALL of them — the original photo for topology/arrow geometry, the enhanced images for small labels — and cross-check every ambiguous glyph across all versions.',
    'Do NOT rush and do NOT guess from a quick glance. Follow this strict, slowed-down visual reasoning protocol. You will write your visual chain-of-thought INTO the JSON analysis tables FIRST, and only then derive the states and transitions from those tables.',

    'PHASE 0 — DEBRIS / SCRIBBLE SUPPRESSION PASS (run this before listing anything):',
    '0a. Scan the whole sheet for cancelled / scribbled-out regions: repeating high-frequency zig-zags, wavy cancellation waves, dense cross-hatching, X-marks, or scratch clusters drawn ON TOP OF other ink. These represent work the author DELETED.',
    '0b. Treat every such region as non-existent: parse NO node, NO arrow, and NO label out of it, and never let it enter any analysis table.',
    '0c. NEVER synthesise a long-distance, screen-crossing, or DIAGONAL edge that crosses, originates in, or terminates inside a scribbled-out region (for example spurious q0->q2, q0->q3, or q3->q5 edges that skip over intermediate states). Dense, repeating, high-frequency wavy / zig-zag cancellation strokes are erasures, not arrows — they must never become a hallucinated transition. This is the main cause of false long diagonal edges.',
    '0d. Do NOT mistake a clean curved self-loop arc near a node for debris: debris is messy, repetitive and overlaps other strokes; a self-loop is a single clean arc that leaves and re-enters the same circle.',

    'PHASE 1 — TWO-PASS LEXICAL VERIFICATION (alphabet extraction as a hard constraint):',
    '1a. PASS 1 (EXTRACT): Read the WHOLE sheet first and extract the global alphabets. If a formal definition is written anywhere (a set-builder language, a list/legend of symbols, or a transition table), use it to derive the alphabets and any structure it implies. If none exists, derive the alphabets purely from the clearly legible labels.',
    '1b. Compile the GLOBAL INPUT ALPHABET (every distinct input symbol appearing before a comma across all legible labels) and, for a PDA, the GLOBAL STACK ALPHABET (every distinct stack symbol). State both in the analysis. Treat them as HARD lexical constraints: a parsed character belonging to neither alphabet is almost certainly an OCR mistake and must be re-read.',
    '1c. PASS 2 (CROSS-REFERENCE): when transcribing each individual transition, cross-reference every ambiguous handwritten glyph against the extracted global alphabets and resolve it to the member that best fits BOTH its shape AND its neighbourhood. Cursive glyphs that look like "ε", "e", "i", "u", "cl", "l", or "r" must be checked against the global input alphabet first. Never invent a Greek/special character for a glyph that an extracted alphabet explains better (the classic error is a cursive "a" misread as "ε"). Whenever you correct a glyph this way, LOWER that field\'s confidence.',
    '1d. EPSILON DISCIPLINE: output "ε" as an input value ONLY when the label explicitly draws epsilon / "e" / an empty mark before the comma. NEVER infer ε merely because an arrow moves between states or "looks like" a transition. A real input letter misread as ε is the single most damaging error: when the glyph before a comma could be EITHER a letter from the global input alphabet OR ε, choose the letter (with lower confidence) unless epsilon is explicitly drawn.',
    '1e. INITIAL STACK MARKER (PDA only): the stack always starts with exactly one bottom marker. Sheets write it as "Z0", "Z_0", "Z₀", "⊥", "⟂", "$", "#", or a plain letter. Identify it by ROLE — the symbol tested as the stack-top on the FIRST transition(s) out of the start state, before anything has been pushed — and ALWAYS output it as "Z0". A symbol that first appears by being PUSHED (e.g. the S in "ε,Z0 / S") is an ordinary stack symbol; keep it as written.',
    '1f. SYMBOL TRANSLATION DICTIONARY (curriculum-aware, for simulator compatibility): high-school sheets draw the bottom-of-stack marker in many hand styles — "⊥", "⟂", "\\perp", a hand-drawn inverted-T or "⊤", a plain "T", or a single vertical stroke with a base bar that resembles "1". When a glyph plays the bottom-marker ROLE (rule 1e), ALWAYS output it as "Z0", whatever its drawn shape; never emit "⊥", "T", or "1" for the bottom marker. IMPORTANT GUARD: do this by ROLE only — if "T"/"1"/"$"/"#" appears as an ordinary INPUT letter or PUSHED stack symbol (i.e. it is NOT the initial stack-top tested before any push), keep it verbatim; never blanket-convert every "T" or "1" to Z0. For epsilon, output "ε" for any epsilon/empty glyph ("e", "E", "ε", a tiny loop); and resolve a cursive glyph that could be input "a" vs "ε" via the global input alphabet (rule 1d) — prefer the alphabet letter unless epsilon is explicitly drawn.',
    '1g. NO BROKEN GLYPHS: every symbol in the JSON must be a clean, standardized character. NEVER emit a placeholder/tofu box ("□", "▯", "▢"), the Unicode replacement char "�", or a garbled square. If OCR yields such a glyph, resolve it by ROLE: a bottom-marker role => "Z0"; an empty-string / pop / erasure mark after the slash => a POP action with push_value "ε"; otherwise the nearest member of the global alphabets. raw_label_text may keep your best literal transcription, but read_input/pop_value/push_value must be clean symbols only.',

    'PHASE 2 — TOPOLOGICAL GRAPH TRAVERSAL (structure):',
    '2a. STATES: list every physically drawn circle and its label. Set is_accepting=true ONLY for a clearly DOUBLE-bordered circle. Set is_start=true ONLY for the state reached by an arrow coming from empty space.',
    '2a2. ZERO STATE OMISSION: scan the entire chain sequentially and output EVERY drawn circle that contains a label as its OWN state node — including intermediate circles and ones with non-numeric names ("qn", "q_n", "qi", "p", "A"). Never drop, skip, or merge an intermediate state (no "q0 -> qn -> q1" collapse that swallows the middle circle). states_table must have exactly one row per drawn circle, with none omitted.',
    '2b. PHYSICAL CONNECTORS ONLY: list ONLY arrows actually drawn on the sheet. NEVER invent, complete, or "expect" a transition that is not drawn, and never drop one that is drawn.',
    '2b2. ARROWHEAD DIRECTION (rigid source/target validation): determine each transition\'s direction SOLELY from the physical arrowHEAD — never from text orientation, label position, or left-to-right reading habit. The node the arrowhead POINT touches is the TARGET (target_state); the node at the tail is the SOURCE. BACK-EDGES ARE COMMON and must be preserved exactly: if arrows drawn from q2 and from q3 have their heads landing on q1, then q1 is the TARGET of both (q2 -> q1 and q3 -> q1) — never flip them to q1 -> q2 / q1 -> q3 just to make the graph read forward. Inspect every arrowhead independently; two heads near one node are two separate arrows. When unsure which end has the head, lower the transition confidence rather than guessing the forward direction.',
    '2c. STRICT SELF-LOOP VERIFICATION (anti-hallucination): do NOT generate self-loops by default. Declare a self-loop (source_state.id === target_state.id) ONLY when there is an explicit, physically drawn CIRCULAR loop stroke that leaves and re-enters the SAME circle. If a node merely has text written above/near it but NO physical loop stroke, you must NOT create a self-loop for it — instead associate that text with the nearest valid forward transition by geometric proximity (rule 2d). Floating text is the main cause of hallucinated self-loops on nearly every node; suppress it.',
    '2d. STRICT SPATIAL ANCHOR RULE FOR FLOATING LABELS (this fixes label-stealing): bind each text label to the connector it is geometrically closest to. CRITICALLY — if a label is written directly ON TOP OF or ABOVE a state circle AND that state has a physically drawn self-loop arc, that label belongs EXCLUSIVELY to that state\'s self-loop (source === target). Do NOT assign such a top-of-state label to the horizontal forward transition running below or beside the state. Conversely, a label sitting along a forward arrow belongs only to that arrow. Never mix bindings between adjacent connectors.',
    '2e. MULTI-RULE ARROWS: a single drawn arrow (forward OR self-loop) often carries SEVERAL rule lines stacked vertically. Output each written line as a SEPARATE object in that transition\'s rules array — never merge lines and never keep only the first line.',
    '2f. SANITY CHECK: if a forward arrow ended up with two or more rules while its SOURCE state has NO self-loop in your output, you very likely stole that state\'s self-loop label — re-inspect and move those rules back onto a self-loop of that state (per rule 2d).',
    '2g. RULE MICRO-AUDIT: for EVERY label line, first transcribe the exact visible text into raw_label_text, then split it into zones — BEFORE the first comma = read_input; BETWEEN comma and slash = current stack top (pop_value); AFTER the slash = action phrase + action value. Derive values from these zones, never from memory or expectation.',
    '2h. SEQUENTIAL PATH PRIOR + NO ORPHANS: when states are numbered consecutively (q0,q1,q2,…,qk), the drawn structure is almost always a sequential backbone q_i -> q_(i+1). Use this only as a prior for re-reading geometry, NOT for inventing edges: every detected circle must end up logically connected and integrated into the flow. An apparent bypass that crosses a node (e.g. q3 -> q5 while q4 is left orphaned with no incoming arrow) is a SEVERE parsing error — re-inspect that region: the true arrow almost certainly lands on the in-between node (q4) or you missed the short q4 -> q5 arrow under debris. Before output, confirm in connectors_table that no detected non-accepting state is left without an incoming arrow (unless it is the start state) and none is left fully isolated; if one is, you mis-read the connectors — fix it from the image, never by fabricating an arrow.',

    'OUTPUT ORDER — VISUAL CHAIN-OF-THOUGHT (fill the analysis object FIRST, before anything else):',
    'analysis.states_table = a markdown table listing EVERY detected circle: | id | double border? | start arrow? |.',
    'analysis.connectors_table = a markdown table listing EVERY physically drawn arrow, with the arrowhead end recorded explicitly: | tail node | arrowhead lands on (= target) | source | target | self-loop stroke? |. Fill "source"/"target" strictly from the arrowhead column, so back-edges (e.g. q2 -> q1, q3 -> q1) are recorded in their true direction.',
    'analysis.label_binding_table = a markdown table mapping EVERY written rule text to its geometrically closest connector, applying rule 2d: | text | bound connector | reason |.',
    'analysis.input_glyph_audit_table = one row per rule, to prevent false ε: | raw_label_text | glyph before comma as seen | candidates from the global input alphabet | chosen read_input | reason |. Any row whose first glyph is plausibly a letter from the global input alphabet must choose that letter, not ε, unless an explicit epsilon symbol is drawn.',
    'analysis.rule_parse_table = one row per rule: | raw_label_text | before comma (read) | between comma and slash (stack top) | after slash (action text) | action value | chosen action |.',
    'analysis.final_audit_table = one row per rule: | raw_label_text | read_input | stack_action | pop_value | push_value | pass/fix |. Fix before output any row whose action word disagrees with stack_action, or whose first glyph is a global-alphabet letter while read_input is ε.',
    'Then derive the output STRICTLY from your own tables: the states array must match states_table exactly, and the transitions array must match connectors_table + label_binding_table exactly — a node/edge/self-loop that does not appear in those tables must NOT appear in the output, and vice-versa. Return only the JSON object.',

    'FIELD RULES:',
    'Each state object must include id, is_accepting, is_start, and confidence.',
    'Each rule inside a transition MUST include raw_label_text plus: read_input (symbol before the first comma), pop_value (current stack-top condition), stack_action, and push_value. For stack_action: PUSH keeps the stack-top in place and pushes push_value on top of it; POP removes the matched stack-top; NONE leaves the stack unchanged.',
    'For a FINITE AUTOMATON drawn with no stack notation, set stack_action="NONE" and pop_value/push_value="ε"; read_input still holds the input symbol before any comma.',
    'raw_label_text must be the exact text you see for that single rule line, e.g. "a,A / A דחוף" or "b,S / S שלוף". It must not be empty for a labelled rule. If a glyph is unclear, still transcribe your best guess (use ? for an unreadable character) and lower confidence. If a label has two stacked lines, output two rules with two different raw_label_text values.',
    'Hebrew action words are binding: "דחוף"/"לדחוף"/"דחיפה" => stack_action.type="PUSH" with the displayed symbol in push_value.value; "שלוף"/"לשלוף"/"שליפה" => stack_action.type="POP" with the displayed top in pop_value.value and push_value.value="ε".',
    'SYMBOLIC STACK OPERATORS (not every sheet uses words): the action after the slash "/" may be a SYMBOL. A pop is commonly drawn as a minus "-", a horizontal line/bar, a struck-through or boxed stack symbol, "⊟"/"⊠"/an empty box "□", or "∅" — parse ANY of these strictly as stack_action="POP" (put the removed/top symbol in pop_value, push_value="ε"); NEVER misread a pop symbol as a push such as "+A"/"+S". A push is drawn as a leading "+" before a symbol ("+A") or a bare stack string after the slash ("A"/"AA") — parse as stack_action="PUSH" with that string in push_value. Only "ללא שינוי"/"no change" (or an explicit blank with the same top) is NONE.',
    'Use stack_action.type="NONE" ONLY when the label explicitly says "ללא שינוי", "בלי שינוי", "no change", or "none". Do not infer NONE from a missing or unfamiliar word.',
    'CRITICAL ACTION CHECK before output: a raw_label_text containing "שלוף"/"לשלוף"/"שליפה" is POP and must NEVER become NONE; one containing "דחוף"/"לדחוף"/"דחיפה" is PUSH and must NEVER become NONE. If unsure, choose PUSH/POP with lower confidence rather than NONE.',
    'CRITICAL INPUT CHECK before output: read_input is exactly the glyph before the first comma, WHATEVER letter it is — copy it from raw_label_text, never substitute from memory. Output ε only when epsilon/empty is explicitly drawn (rule 1d).',
    'PUSH+ε GUARD: a PUSH rule whose read_input is ε is legitimate only as a one-time initialization on the bottom marker Z0. For an ordinary stack top, a PUSH that reads ε would create an unbounded epsilon-growth path, so it is almost certainly a real input letter misread as ε — resolve it to the appropriate symbol from the global input alphabet (the letter the neighbouring rules read) with lower confidence.',
    'Format examples (these illustrate ZONE-SPLITTING only — they are NOT a target language): "x,A / A דחוף" => read_input=x, pop_value=A, stack_action=PUSH, push_value=A. "y,A / A שלוף" => read_input=y, pop_value=A, stack_action=POP, push_value=ε. "z,S / ללא שינוי" => read_input=z, pop_value=S, stack_action=NONE, push_value=ε. "ε,Z0 / S דחוף" => read_input=ε, pop_value=Z0, stack_action=PUSH, push_value=S.',
    'Normalize any bottom-marker glyph ("⊥", "⟂", "Z_0", "Z₀") to "Z0" in the JSON; never output "⊥". Treat "e"/"E"/"ε" for epsilon as "ε" everywhere.',
    'A label like "x, Y / Z" reads as: input x, stack-top condition Y, then the action part Z (a pushed string, or a pop mark).',
    'Confidence calibration: clear state labels, clear arrows, and readable fields should usually be 0.85-0.98. Use confidence below 0.75 only for genuine ambiguity — unclear handwriting, overlapping arrows, a glyph you corrected, or cropped/border text. If unsure, still provide the best value with a lower confidence score.',
    ...(isPda ? [] : [
      'MODEL TYPE CONTEXT (provided by the client): this sheet is a FINITE AUTOMATON (DFA/NFA) — there is NO stack anywhere on it.',
      'FA LABELS OVERRIDE the zone-split rules above (2g, and the stack parts of the FIELD RULES): a transition label is one or more BARE input symbols. A comma separates ALTERNATIVE input symbols on the SAME arrow (e.g. "0,1" means the arrow fires on 0 and also on 1) — it is NOT an input/stack-top separator. There is no slash "/" and no action word on this sheet.',
      'For every visible label line: raw_label_text = the exact visible text (e.g. "a" or "0,1"), and emit ONE rule per alternative symbol with read_input = that symbol, stack_action="NONE", pop_value="ε", push_value="ε".',
      'Ignore the stack-specific rules 1e/1f (bottom marker) and the PUSH/POP action rules. Epsilon discipline (1d) still applies: ε is a legitimate NFA input, but only when an epsilon is explicitly drawn.',
      'In analysis.rule_parse_table and analysis.final_audit_table fill the stack-top / action columns with "—" — those zones do not exist on a finite-automaton sheet.',
    ]),
  ].join('\n');

  const callVision = async (promptText) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
    try {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'content-type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: MODEL,
          input: [{
            role: 'user',
            content: [
              { type: 'input_text', text: promptText },
              ...urls.map(image_url => ({ type: 'input_image', image_url, detail: 'high' })),
            ],
          }],
          max_output_tokens: 6000,
          text: {
            format: {
              type: 'json_schema',
              name: isPda ? 'pda_transition_scan' : 'fa_transition_scan',
              schema,
              strict: true,
            },
          },
        }),
      });

      const body = await response.text();
      if (!response.ok) {
        const err = new Error(body || `OpenAI request failed with ${response.status}`);
        err.status = response.status;
        throw err;
      }
      const data = JSON.parse(body);
      const text = data.output_text || (data.output || [])
        .flatMap(item => item.content || [])
        .map(part => part.text || '')
        .join('');
      if (!text) throw new Error('OpenAI returned an empty response');
      return JSON.parse(text);
    } catch (err) {
      if (controller.signal.aborted) {
        const timeoutError = new Error(`OpenAI request timed out after ${OPENAI_TIMEOUT_MS} ms`);
        timeoutError.status = 504;
        throw timeoutError;
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  };

  let parsedJson = await callVision(prompt);
  let qualityProblems = parseQualityProblems(parsedJson, isPda);
  if (qualityProblems.length) {
    console.warn('AI parse failed quality gate, retrying:', qualityProblems.slice(0, 8).join(' | '));
    const retryPrompt = prompt + '\n\n' + (isPda ? [
      'VALIDATION FAILURE RECOVERY PASS:',
      'Your previous JSON failed validation. The most common failure is leaving raw_label_text empty or omitting the Hebrew action word.',
      `Detected problems: ${qualityProblems.slice(0, 12).join('; ')}`,
      'Retry from the image, not from the previous answer. For every visible transition-rule line, raw_label_text must be a literal transcription of that ONE line and must include the comma, the slash, and the visible action word: דחוף / שלוף / ללא שינוי.',
      'Do not replace a visible Hebrew action word with ε, Z0, or a guessed push string. The action word determines stack_action.type.',
      'Do not turn a possible input letter before the comma into ε. If the first glyph is ambiguous, resolve it to the member of the global input alphabet that fits its shape and neighbourhood (with low confidence) unless the image clearly shows an explicit epsilon.',
      'PUSH plus read_input=ε is allowed only for a clear one-time Z0 initialization. For an ordinary stack top, repair it to the input letter the neighbouring rules read (from the global input alphabet) with low confidence.',
      'If you cannot read one character, write your best visible transcription with ? for the unclear character, set confidence below 0.60, and keep parsing the rest. Never use an empty string.',
      'Before returning JSON, check every rules[].raw_label_text. If any is empty, or lacks both comma and slash, repair it. If it lacks דחוף/שלוף/ללא שינוי while the image has such a word, zoom mentally into the label and transcribe it.',
    ] : [
      'VALIDATION FAILURE RECOVERY PASS:',
      'Your previous JSON failed validation. The most common failure on a finite-automaton sheet is leaving raw_label_text empty for a labelled arrow.',
      `Detected problems: ${qualityProblems.slice(0, 12).join('; ')}`,
      'Retry from the image, not from the previous answer. This is a FINITE AUTOMATON (DFA/NFA) sheet: every visible arrow label must appear as raw_label_text with its bare input symbols (e.g. "a" or "0,1"), one rule per alternative symbol, stack_action="NONE" and pop_value/push_value="ε".',
      'If you cannot read one character, write your best visible transcription with ? for the unclear character, set confidence below 0.60, and keep parsing the rest. Never use an empty string.',
    ]).join('\n');
    parsedJson = await callVision(retryPrompt);
    qualityProblems = parseQualityProblems(parsedJson, isPda);
  }
  if (qualityProblems.length) {
    const err = new Error('ה-AI לא הצליח לקרוא את תוויות המעברים בצורה אמינה. נסה צילום חד/קרוב יותר, או הדבק JSON ידנית. פרטים: ' + qualityProblems.slice(0, 4).join(' | '));
    err.status = 422;
    throw err;
  }
  if (parsedJson && parsedJson.analysis) {
    console.log('--- Visual CoT analysis ---');
    ['states_table', 'connectors_table', 'label_binding_table', 'input_glyph_audit_table', 'rule_parse_table', 'final_audit_table'].forEach(k => {
      if (parsedJson.analysis[k]) console.log(String(parsedJson.analysis[k]).slice(0, 800));
    });
  }
  return { analysis: (parsedJson && parsedJson.analysis) || null, ...normalizePayload(parsedJson, urls[0] || '', isPda) };
}

const STATIC_HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; '),
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

const server = http.createServer(async (req, res) => {
  let isApiRequest = false;
  try {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    isApiRequest = url.pathname.startsWith('/api/');

    if (isApiRequest && !isAllowedApiOrigin(req)) {
      send(res, 403, { error: 'Origin is not allowed' });
      return;
    }
    if (req.method === 'OPTIONS') {
      if (!isApiRequest) {
        send(res, 404, 'Not found');
        return;
      }
      sendApi(req, res, 204, '');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendApi(req, res, 200, { ok: true, model: MODEL, hasKey: Boolean(process.env.OPENAI_API_KEY) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/parse-diagram') {
      const quota = consumeParseQuota(req);
      const quotaHeaders = {
        'x-ratelimit-limit': String(MAX_PARSE_REQUESTS),
        'x-ratelimit-remaining': String(quota.remaining),
        'x-ratelimit-reset': String(quota.resetSeconds),
      };
      if (!quota.allowed) {
        sendApi(req, res, 429, { error: 'Too many scan requests. Try again shortly.' }, {
          ...quotaHeaders,
          'retry-after': String(quota.resetSeconds),
        });
        return;
      }

      const raw = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(raw || '{}');
      } catch {
        sendApi(req, res, 400, { error: 'Malformed JSON request body' }, quotaHeaders);
        return;
      }
      const images = Array.isArray(payload.images) ? payload.images.filter(Boolean) : [payload.image].filter(Boolean);
      if (!images.length) {
        sendApi(req, res, 400, { error: 'Missing image data URL' }, quotaHeaders);
        return;
      }
      if (activeParseRequests >= MAX_CONCURRENT_PARSES) {
        sendApi(req, res, 429, { error: 'The scanner is busy. Try again shortly.' }, {
          ...quotaHeaders,
          'retry-after': '1',
        });
        return;
      }

      activeParseRequests += 1;
      try {
        const parsed = await parseDiagram(images, payload.model_type);
        sendApi(req, res, 200, { ...parsed, model: MODEL }, quotaHeaders);
      } finally {
        activeParseRequests -= 1;
      }
      return;
    }

    if (isApiRequest) {
      sendApi(req, res, 404, { error: 'API route not found' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'Method not allowed', { allow: 'GET, HEAD' });
      return;
    }

    const publicFile = PUBLIC_FILES.get(url.pathname);
    if (!publicFile) {
      send(res, 404, 'Not found');
      return;
    }
    const full = path.join(ROOT, publicFile);
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      send(res, 404, 'Not found');
      return;
    }
    res.writeHead(200, { 'content-type': mime(full), ...STATIC_HEADERS });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(full).pipe(res);
  } catch (err) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const status = err.status || 500;
    if (!err.status) console.error(err);
    const message = err.status ? (err.message || String(err)) : 'Internal server error';
    if (isApiRequest) sendApi(req, res, status, { error: message });
    else send(res, status, { error: message });
  }
});

function startServer() {
  if (server.listening) return server;
  server.listen(PORT, HOST, () => {
    const displayHost = HOST === '::1' ? '[::1]' : HOST;
    console.log(`Automata tool running at http://${displayHost}:${PORT}/automata.html`);
    console.log(`Listening on loopback only (${HOST})`);
    console.log(`OpenAI model: ${MODEL}`);
  });
  return server;
}

if (require.main === module) startServer();

module.exports = { server, startServer };
