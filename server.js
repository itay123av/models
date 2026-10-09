const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const ROOT = __dirname;
loadEnv(path.join(ROOT, '.secrets', 'openai.env'));
loadEnv(path.join(ROOT, '.env.local'));
loadEnv(path.join(ROOT, '.env'));
const PORT = intEnv('PORT', 8790, 1, 65535);
const HOST = String(process.env.HOST || '127.0.0.1').trim();
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-luna';
/* Cost-aware OCR cascade: the mini model reads every local crop first; only
   incomplete, contradictory, or low-confidence batches reach the stronger
   verifier. */
const LABEL_MODEL = process.env.OPENAI_LABEL_MODEL || 'gpt-5.6-luna';
const LABEL_ESCALATION_MODEL = String(process.env.OPENAI_LABEL_ESCALATION_MODEL || 'gpt-5.6-terra').trim();
/* Expensive-model escalation is opt-in. A previous default-on cascade turned
   one user scan into 29 API calls (14 of them Terra) without reliably
   improving the diagram. Never spend on the verifier unless the deployment
   owner explicitly enables it. */
const LABEL_ESCALATION_ENABLED = boolEnv('OPENAI_LABEL_ESCALATION_ENABLED', false);
const LABEL_ESCALATION_CONFIDENCE = numberEnv('OPENAI_LABEL_ESCALATION_CONFIDENCE', 0.78, 0, 1);
const LABEL_TARGETED_RETRY_ENABLED = boolEnv('OPENAI_LABEL_TARGETED_RETRY_ENABLED', true);
const LABEL_TARGETED_RETRY_MAX_BATCHES = intEnv('OPENAI_LABEL_TARGETED_RETRY_MAX_BATCHES', 2, 0, 4);
/* Handwritten topology is the highest-risk geometry step: one missed arrow
   changes the machine. */
const TOPOLOGY_MODEL = process.env.OPENAI_TOPOLOGY_MODEL || 'gpt-5.6-luna';
/* The topology audit is an explicit client-controlled stage.  A deployment
   first uses the high-volume model.  Deterministic structural checks decide
   whether the stronger verifier is warranted; merely entering the audit stage
   must not make every scan expensive. */
const TOPOLOGY_AUDIT_MODEL = String(process.env.OPENAI_TOPOLOGY_AUDIT_MODEL || TOPOLOGY_MODEL).trim();
const TOPOLOGY_ESCALATION_MODEL = String(process.env.OPENAI_TOPOLOGY_ESCALATION_MODEL || 'gpt-5.6-terra').trim();
const TOPOLOGY_ESCALATION_ENABLED = boolEnv('OPENAI_TOPOLOGY_ESCALATION_ENABLED', false);
const TOPOLOGY_ESCALATION_CONFIDENCE = numberEnv('OPENAI_TOPOLOGY_ESCALATION_CONFIDENCE', 0.78, 0, 1);
/* The replacement audit already returns label-block and baseline geometry.
   A second full-image line-geometry pass was both costly and, on the live
   handwritten fixture, occasionally replaced usable boxes with noisier ones.
   Keep it available for experiments, but never pay for it by default. */
const TOPOLOGY_LINE_GEOMETRY_ENABLED = boolEnv('OPENAI_TOPOLOGY_LINE_GEOMETRY_ENABLED', true);
const OPENAI_REASONING_EFFORT = String(process.env.OPENAI_REASONING_EFFORT || 'medium').trim().toLowerCase();
const OPENAI_ESCALATION_REASONING_EFFORT = String(process.env.OPENAI_ESCALATION_REASONING_EFFORT || 'high').trim().toLowerCase();
/* A full gpt-5.4 labels pass may receive dozens of state/line/context crops.
   Ninety seconds caused a valid long-running pass to be discarded as if it
   had produced no result. */
const OPENAI_TIMEOUT_MS = intEnv('OPENAI_TIMEOUT_MS', 240_000, 1_000, 300_000);
const RATE_LIMIT_WINDOW_MS = intEnv('RATE_LIMIT_WINDOW_MS', 60_000, 1_000, 3_600_000);
const MAX_PARSE_REQUESTS = intEnv('MAX_PARSE_REQUESTS', 12, 1, 10_000);
const MAX_CONCURRENT_PARSES = intEnv('MAX_CONCURRENT_PARSES', 2, 1, 20);
/* Cross-stage scan guard. Stages arrive as separate HTTP requests, so the
   ordinary per-request usage collector cannot protect the total bill. This
   ledger follows scan_session_id across topology, audit, and labels. */
const OPENAI_SCAN_MAX_ESTIMATED_USD = numberEnv('OPENAI_SCAN_MAX_ESTIMATED_USD', 0.10, 0.01, 100);
const OPENAI_SCAN_MAX_API_CALLS = intEnv('OPENAI_SCAN_MAX_API_CALLS', 16, 1, 1000);
const OPENAI_SCAN_BUDGET_TTL_MS = intEnv('OPENAI_SCAN_BUDGET_TTL_MS', 3_600_000, 60_000, 86_400_000);
const DEFAULT_CONFIDENCE = 0.9;
const SCAN_RUNTIME_LOG = path.join(ROOT, 'scan-runtime.log');
const OPENAI_PRICING_VERSION = '2026-08-26';
const OPENAI_PRICING_USD_PER_MILLION = Object.freeze({
  'gpt-5.4': { input: 2.50, cachedInput: 0.25, output: 15.00 },
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.50 },
  'gpt-5.6-luna': { input: 0.20, cachedInput: 0.02, cacheWrite: 0.25, output: 1.20 },
  'gpt-5.6-terra': { input: 2.00, cachedInput: 0.20, cacheWrite: 2.50, output: 12.00 },
});
const scanUsageStorage = new AsyncLocalStorage();
const scanBudgetLedger = new Map();
function recordScanRuntime(event, details = {}) {
  try {
    const safe = Object.fromEntries(Object.entries(details).filter(([key]) =>
      !/image|url|prompt|key|raw|crop_manifest/i.test(key)));
    fs.appendFileSync(SCAN_RUNTIME_LOG, `${JSON.stringify({ at: new Date().toISOString(), event, ...safe })}\n`);
  } catch { /* diagnostics must never break scanning */ }
}

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
  // ליבת הסמנטיקה של PDA — משותפת לדפדפן ולבדיקות ב-Node.
  ['/pda-core.js', 'pda-core.js'],
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

function numberEnv(name, fallback, min, max) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function boolEnv(name, fallback) {
  const value = String(process.env[name] ?? '').trim().toLowerCase();
  if (!value) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
}

function modelPricing(model) {
  const id = String(model || '').trim().toLowerCase();
  return OPENAI_PRICING_USD_PER_MILLION[id] || null;
}

function openAIReasoning(model, escalation = false) {
  if (!/^gpt-5\.6(?:-|$)/i.test(String(model || '').trim())) return null;
  const allowed = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  const requested = escalation ? OPENAI_ESCALATION_REASONING_EFFORT : OPENAI_REASONING_EFFORT;
  return { effort: allowed.has(requested) ? requested : (escalation ? 'high' : 'medium'),
    context: 'current_turn' };
}

function estimateOpenAICost(model, usage = {}) {
  const inputTokens = Math.max(0, Number(usage.input_tokens) || 0);
  const outputTokens = Math.max(0, Number(usage.output_tokens) || 0);
  const cachedTokens = Math.min(inputTokens, Math.max(0,
    Number(usage.input_tokens_details && usage.input_tokens_details.cached_tokens) || 0));
  const cacheWriteTokens = Math.min(inputTokens - cachedTokens, Math.max(0,
    Number(usage.input_tokens_details && usage.input_tokens_details.cache_write_tokens) || 0));
  const pricing = modelPricing(model);
  const estimatedCostUsd = pricing
    ? (((inputTokens - cachedTokens - cacheWriteTokens) * pricing.input) +
      (cachedTokens * pricing.cachedInput) +
      (cacheWriteTokens * (pricing.cacheWrite == null ? pricing.input : pricing.cacheWrite)) +
      (outputTokens * pricing.output)) / 1_000_000
    : null;
  return {
    model: String(model || ''),
    input_tokens: inputTokens,
    cached_input_tokens: cachedTokens,
    cache_write_tokens: cacheWriteTokens,
    output_tokens: outputTokens,
    total_tokens: Math.max(0, Number(usage.total_tokens) || inputTokens + outputTokens),
    estimated_cost_usd: estimatedCostUsd == null ? null : Number(estimatedCostUsd.toFixed(8)),
    pricing_version: OPENAI_PRICING_VERSION,
  };
}

function pruneScanBudgetLedger(now = Date.now()) {
  for (const [session, entry] of scanBudgetLedger) {
    if (!entry || now - entry.updatedAt > OPENAI_SCAN_BUDGET_TTL_MS) scanBudgetLedger.delete(session);
  }
}

function resetScanBudget(session) {
  const id = String(session || '').trim();
  if (!id) return null;
  pruneScanBudgetLedger();
  const entry = { session: id, calls: 0, estimatedCostUsd: 0, updatedAt: Date.now() };
  scanBudgetLedger.set(id, entry);
  return entry;
}

function getScanBudget(session, create = true) {
  const id = String(session || '').trim();
  if (!id) return null;
  pruneScanBudgetLedger();
  let entry = scanBudgetLedger.get(id);
  if (!entry && create) {
    entry = { session: id, calls: 0, estimatedCostUsd: 0, updatedAt: Date.now() };
    scanBudgetLedger.set(id, entry);
  }
  return entry || null;
}

function scanCallReserveUsd(model) {
  const id = String(model || '').trim().toLowerCase();
  /* This is deliberately conservative relative to the observed Luna calls.
     Terra is intentionally larger than the default whole-scan budget, so an
     accidental escalation cannot slip through under default settings. */
  if (id === 'gpt-5.6-luna' || id === 'gpt-5.4-nano') return 0.02;
  if (id === 'gpt-5.4-mini') return 0.06;
  return 0.12;
}

function scanBudgetDecision(entry, model, maxCost = OPENAI_SCAN_MAX_ESTIMATED_USD,
  maxCalls = OPENAI_SCAN_MAX_API_CALLS) {
  const calls = Math.max(0, Number(entry && entry.calls) || 0);
  const estimatedCostUsd = Math.max(0, Number(entry && entry.estimatedCostUsd) || 0);
  const reserveUsd = scanCallReserveUsd(model);
  const reason = calls >= maxCalls ? 'call_limit'
    : (estimatedCostUsd + reserveUsd > maxCost + 1e-12 ? 'cost_limit' : '');
  return { allowed: !reason, reason, calls, estimatedCostUsd, reserveUsd, maxCost, maxCalls };
}

function assertScanBudget(model) {
  const scope = scanUsageStorage.getStore();
  const entry = getScanBudget(scope && scope.session);
  if (!entry) return;
  const decision = scanBudgetDecision(entry, model);
  if (decision.allowed) return;
  const err = new Error(decision.reason === 'call_limit'
    ? `Scan stopped before API call ${entry.calls + 1}: the ${OPENAI_SCAN_MAX_API_CALLS}-call safety limit was reached.`
    : `Scan stopped before another ${model} call: estimated scan cost is $${entry.estimatedCostUsd.toFixed(4)} and the configured safety limit is $${OPENAI_SCAN_MAX_ESTIMATED_USD.toFixed(2)}.`);
  err.status = 429;
  err.code = 'SCAN_COST_BUDGET_EXCEEDED';
  recordScanRuntime('scan-budget-blocked', { session: entry.session, model, calls: entry.calls,
    estimated_cost_usd: Number(entry.estimatedCostUsd.toFixed(8)), reserve_usd: decision.reserveUsd,
    max_estimated_usd: OPENAI_SCAN_MAX_ESTIMATED_USD, max_calls: OPENAI_SCAN_MAX_API_CALLS });
  throw err;
}

function recordOpenAIUsage(data, model, telemetry = {}) {
  const row = { ...estimateOpenAICost(model, data && data.usage), ...telemetry };
  const scope = scanUsageStorage.getStore();
  if (scope && Array.isArray(scope.calls)) scope.calls.push(row);
  const entry = getScanBudget(scope && scope.session);
  if (entry) {
    entry.calls += 1;
    if (row.estimated_cost_usd != null) entry.estimatedCostUsd += row.estimated_cost_usd;
    entry.updatedAt = Date.now();
  }
  recordScanRuntime('openai-call-complete', { ...row, scan_session_id: String(scope && scope.session || ''),
    scan_estimated_cost_usd: entry ? Number(entry.estimatedCostUsd.toFixed(8)) : null });
  return row;
}

function summarizeScanUsage(scope) {
  const calls = Array.isArray(scope && scope.calls) ? scope.calls : [];
  const totals = calls.reduce((sum, row) => {
    sum.input_tokens += row.input_tokens || 0;
    sum.cached_input_tokens += row.cached_input_tokens || 0;
    sum.cache_write_tokens += row.cache_write_tokens || 0;
    sum.output_tokens += row.output_tokens || 0;
    sum.total_tokens += row.total_tokens || 0;
    if (row.estimated_cost_usd == null) sum.cost_complete = false;
    else sum.estimated_cost_usd += row.estimated_cost_usd;
    return sum;
  }, { input_tokens: 0, cached_input_tokens: 0, cache_write_tokens: 0, output_tokens: 0, total_tokens: 0,
    estimated_cost_usd: 0, cost_complete: true });
  const budget = getScanBudget(scope && scope.session, false);
  return {
    provider: 'openai',
    stage: String(scope && scope.stage || ''),
    scan_session_id: String(scope && scope.session || ''),
    call_count: calls.length,
    input_tokens: totals.input_tokens,
    cached_input_tokens: totals.cached_input_tokens,
    cache_write_tokens: totals.cache_write_tokens,
    output_tokens: totals.output_tokens,
    total_tokens: totals.total_tokens,
    estimated_cost_usd: totals.cost_complete ? Number(totals.estimated_cost_usd.toFixed(8)) : null,
    pricing_version: OPENAI_PRICING_VERSION,
    scan_estimated_cost_usd: budget ? Number(budget.estimatedCostUsd.toFixed(8)) : null,
    scan_call_count: budget ? budget.calls : calls.length,
    scan_max_estimated_usd: OPENAI_SCAN_MAX_ESTIMATED_USD,
    scan_max_api_calls: OPENAI_SCAN_MAX_API_CALLS,
    models: [...new Set(calls.map(row => row.model).filter(Boolean))],
    calls,
  };
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
// The canonical bottom-of-stack marker. New visual scans must contain this
// exact glyph. normalizeSymbolValue is retained only as the explicit migration
// boundary for already-saved legacy model data.
const BOTTOM = '⊥';

// Letter shapes of the closed PDA action vocabulary in Hebrew handwriting.
// This is general knowledge of Hebrew cursive, not samples of one writer and
// not answers to an exercise. In a bounded crop-level experiment
// (scripts/probe-action-words.cjs) it raised action accuracy from 7/14 to 11/14
// on the user-confirmed 2026-08-24 sheet and from 5/12 to 10/12 on the
// 2026-09-29 sheet; the remaining misses were low-confidence or UNKNOWN.
// Comparing repeated words across a whole sheet was tried as well and made
// errors correlated (7/14), so every crop is still read on its own.
const { PDA_ACTION_WORD_GUIDE } = require('./pda-action-word-guide.cjs');

function normalizeSymbolValue(value) {
  const raw = Array.isArray(value) ? value.join('') : String(value ?? '');
  const s = raw.trim();
  if (!s || s === EPSILON) return EPSILON;
  // A broken/tofu glyph is UNKNOWN, never epsilon. Turning an unreadable mark
  // into ε silently changes whether input is consumed and is therefore unsafe.
  if (/^[�□▯▢◻◼⬜⬛]+$/.test(s)) return '?';
  /* Legacy aliases are tolerated only when the WHOLE field is that one token.
     Never rewrite a substring such as AZ0B into a different stack word. */
  if (/^(?:⟂|Z₀|Z_?0)$/i.test(s)) return BOTTOM;
  return s;
}

/* Vision transcription is intentionally stricter than legacy model import.
   A photographed Z0/Z₀/Z_0/⟂ is visible evidence in its own right; it must
   never be silently reinterpreted as the canonical bottom marker.  Legacy JSON
   migration continues to use normalizeSymbolValue above. */
function normalizeVisionSymbolValue(value) {
  const raw = Array.isArray(value) ? value.join('') : String(value ?? '');
  const s = raw.trim();
  if (!s || s === EPSILON) return EPSILON;
  if (/^[�□▯▢◻◼⬜⬛]+$/.test(s)) return '?';
  return s;
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

function parseTmLabel(raw) {
  // Parse a compact copy only. raw_label_text itself must remain a literal
  // transcription so the client can display/review exactly what was scanned.
  const text = String(raw ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[→⇒↦]/g, '->');
  const patterns = [
    /^(.+?)\s*->\s*(.+?)\s*[,،，]\s*([LRSN])$/i,
    /^(.+?)\s*\/\s*(.+?)\s*[,،，]\s*([LRSN])$/i,
    /^(.+?)\s*[,،，]\s*(.+?)\s*[,،，]\s*([LRSN])$/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const read = match[1].trim();
    const write = match[2].trim();
    if (!read || !write) return null;
    return { read, write, direction: match[3].toUpperCase() };
  }
  return null;
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
  /* A literal Latin E/e is an ordinary visible symbol.  Only an actually
     written epsilon glyph is normalized to epsilon; textual aliases were not
     defined by the user and must not erase a real input/stack symbol. */
  if (s === EPSILON) return EPSILON;
  const m = s.match(/Z_?0|Z₀|[⊥⟂]|[A-Za-z0-9]/);
  return m ? normalizeVisionSymbolValue(m[0]) : '';
}

// ── Semantic validation (reports, never rewrites) ───────────────────────────
// The spatial read is the source of truth for the field values. This pass only
// decides whether what was read forms a legal rule, and says so out loud.
//   POP: ACTION.symbol must equal STACK_TOP, and must never be the bottom ⊥.
//   PUSH: the pushed symbol MAY differ from STACK_TOP, but it must never be ⊥.
function ruleSemanticIssues({ action, popValue, popSymbol, pushValue }) {
  const issues = [];
  const pushed = pushValue === EPSILON ? '' : pushValue;
  if (action === 'PUSH' && pushed === BOTTOM) {
    issues.push(`PUSH of the bottom marker ${BOTTOM} is never allowed`);
  }
  if (action !== 'POP') return issues;
  const top = popValue === EPSILON ? '' : popValue;
  const sym = popSymbol === EPSILON ? '' : popSymbol;
  if (!sym || sym === '?') {
    issues.push('POP action symbol is missing or unreadable');
  }
  // When either side is ε we do not decide — epsilon semantics are still open.
  if (top && sym && sym !== '?' && top !== sym) {
    issues.push(`POP symbol ${sym} does not match STACK_TOP ${top}`);
  }
  if (sym === BOTTOM || top === BOTTOM) {
    issues.push(`POP of the bottom marker ${BOTTOM} is never allowed`);
  }
  return issues;
}

function readFromRawLabel(raw) {
  return symbolFromLabelPart(labelPartBeforeComma(raw));
}

function topFromRawLabel(raw) {
  return symbolFromLabelPart(labelPartBetweenCommaAndSlash(raw));
}

// The action symbol as it appears in the flat text. Audit evidence only: it is
// reported alongside the spatial read and must never overwrite it.
function actionValueFromRawLabel(raw) {
  const tail = labelPartAfterSlash(raw)
    .replace(/ללא\s*שינוי|לל["״']?\s*ש|דחוף|שלוף/g, ' ');
  const sym = symbolFromLabelPart(tail);
  return sym && sym !== EPSILON ? sym : '';
}

function normalizeActionToken(value) {
  const raw = String(value ?? '').trim();
  const upper = raw.toUpperCase();
  if (upper === 'NONE' || /^(ללא\s*שינוי|לל["״']?\s*ש)$/.test(raw)) return 'NONE';
  if (upper === 'POP' || raw === 'שלוף') return 'POP';
  if (upper === 'PUSH' || raw === 'דחוף') return 'PUSH';
  if (upper === 'UNKNOWN') return 'UNKNOWN';
  return '';
}

function actionTypeFromText(text) {
  const s = String(text || '').trim();
  const seen = [];
  if (/ללא\s*שינוי|לל["״']?\s*ש/.test(s)) seen.push('NONE');
  if (/(?:^|\s)שלוף(?:\s|$)/.test(s)) seen.push('POP');
  if (/(?:^|\s)דחוף(?:\s|$)/.test(s)) seen.push('PUSH');
  /* More than one approved action word in one RIGHT zone is conflicting
     evidence, not permission to choose whichever regex happens to run first. */
  return seen.length === 1 ? seen[0] : '';
}

function normalizeStackAction(rawAction, rule, rawLabelText = '') {
  // The structured ACTION field is the spatial read and therefore wins. The
  // right-zone text is the only fallback because it is still spatial evidence.
  // Flat OCR is audit evidence and is never an action source.
  const explicit = normalizeActionToken(rawAction);
  if (explicit) return explicit;
  rule = rule || {};
  const rightZone = rule.zones && rule.zones.right_text;
  const spatialFallback = actionTypeFromText(rightZone);
  if (spatialFallback) return spatialFallback;
  return 'UNKNOWN';
}

function normalizeScannedSymbol(value) {
  const raw = Array.isArray(value) ? value.join('') : String(value ?? '');
  if (!raw.trim()) return '?';
  return normalizeVisionSymbolValue(raw);
}

// Spatial INPUT / STACK_TOP fields contain one literal glyph, not a flat OCR
// sentence. Do not pick the first Latin letter out of alternatives (a / ε).
// Missing/ambiguous evidence stays missing/ambiguous; raw text is unchanged.
function spatialSingleSymbol(value) {
  const literal = String(value ?? '').trim();
  if (!literal) return '';
  if (Array.from(literal).length !== 1 || /[,/�□▯▢◻◼⬜⬛]/u.test(literal)) return '?';
  return literal;
}

function normalizeLineBbox(value) {
  const src = value && typeof value === 'object' ? value : {};
  const vals = ['x', 'y', 'w', 'h'].map(k => Number(src[k]));
  const missing = vals.every(v => v === -1);
  const valid = vals.every(Number.isFinite) && vals[0] >= 0 && vals[1] >= 0 &&
    vals[2] > 0 && vals[3] > 0 && vals.every(v => v <= 1) &&
    vals[0] + vals[2] <= 1.001 && vals[1] + vals[3] <= 1.001;
  return {
    box: valid ? { x: vals[0], y: vals[1], w: vals[2], h: vals[3] }
      : { x: -1, y: -1, w: -1, h: -1 },
    localized: valid,
    invalid: !valid && !missing,
  };
}







// Structural validation step (domain-agnostic, never fabricates edges): flags any
// non-accepting state that is unreachable from the start, fully isolated, or a
// dead-end. Flagging = lowering confidence below the client's AI_LOW threshold so
// it surfaces in the manual-review panel; transition assignments are left intact.
function flagStructuralProblems(states, transitions) {
  if (!states.length) return [];
  /* A visible label is not a physical-state identity: two distinct circles may
     both be unreadable or may genuinely carry the same label. Use the internal
     observation id for graph bookkeeping so this review pass never merges them. */
  const keys = new Set(states.map(s => s.observation_id));
  const byLabel = new Map();
  states.forEach(s => {
    const label = String(s.visible_label ?? s.id ?? '').trim();
    if (!label) return;
    const rows = byLabel.get(label) || [];
    rows.push(s.observation_id);
    byLabel.set(label, rows);
  });
  const endpointKey = endpoint => {
    const explicit = String(endpoint && endpoint.observation_id || '').trim();
    if (explicit && keys.has(explicit)) return explicit;
    const label = String(endpoint && endpoint.id || '').trim();
    const matches = byLabel.get(label) || [];
    return matches.length === 1 ? matches[0] : '';
  };
  const adj = new Map(states.map(s => [s.observation_id, []]));
  const inNonSelf = new Map(states.map(s => [s.observation_id, 0]));
  const touch = new Map(states.map(s => [s.observation_id, 0]));
  for (const t of transitions) {
    const f = endpointKey(t.source_state);
    const d = endpointKey(t.target_state);
    if (!f || !d) continue;
    adj.get(f).push(d);
    touch.set(f, touch.get(f) + 1);
    touch.set(d, touch.get(d) + 1);
    if (f !== d) inNonSelf.set(d, inNonSelf.get(d) + 1);
  }
  const startKeys = states.filter(s => s.is_start).map(s => s.observation_id);
  const reach = new Set(startKeys);
  const queue = [...startKeys];
  while (queue.length) {
    const cur = queue.shift();
    for (const nx of adj.get(cur) || []) if (!reach.has(nx)) { reach.add(nx); queue.push(nx); }
  }
  const flagged = [];
  for (const s of states) {
    const key = s.observation_id;
    const problems = [];
    if (!touch.get(key)) problems.push('isolated');
    else {
      if (startKeys.length && !reach.has(key) && !s.is_start) problems.push('unreachable from start');
      else if (!inNonSelf.get(key) && !s.is_start) problems.push('no incoming arrow');
      if ((adj.get(key) || []).length === 0 && !s.is_accepting && !s.is_start) problems.push('dead-end (no outgoing, not accepting)');
    }
    if (problems.length) {
      // Structural oddities are review notes, not evidence that the drawing was
      // read with low visual confidence. Keep those two axes separate.
      s.structural_issues = problems;
      flagged.push(`${s.visible_label || s.observation_id}: ${problems.join(', ')}`);
    }
  }
  if (flagged.length) console.warn('Structural validation flagged orphan/dead-end states:', flagged.join(' | '));
  return flagged;
}

function normalizePayload(value, imageUrl, isPda, isTm) {
  const raw = value || {};
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw.transitions) ? raw.transitions : [raw]);
  const stateArr = [];
  const observationsByVisibleLabel = new Map();
  const observationsByRawRef = new Map();
  let stateObservationSerial = 0;
  const addStateObservation = (field, defaults = {}, source = 'states') => {
    const visibleLabel = stateId(field, '').trim();
    const obj = field && typeof field === 'object' ? field : {};
    const rawRef = String(obj.observation_id ?? obj.observationId ?? '').trim();
    const observationId = `state_observation_${String(++stateObservationSerial).padStart(3, '0')}`;
    const fieldNotes = [];
    let confidence = Number(obj.confidence ?? defaults.confidence ?? DEFAULT_CONFIDENCE);
    if (!visibleLabel) {
      fieldNotes.push('state label is missing; no semantic label was invented');
      confidence = Math.min(confidence, 0.55);
    } else if (visibleLabel === '?' || /^[�□▯▢◻◼⬜⬛]+$/.test(visibleLabel)) {
      fieldNotes.push('state label is unreadable; the physical circle was preserved separately');
      confidence = Math.min(confidence, 0.55);
    }
    const observation = {
      observation_id: observationId,
      id: visibleLabel,
      visible_label: visibleLabel,
      is_accepting: Boolean(obj.is_accepting ?? obj.isAccepting ?? obj.is_final ?? defaults.is_accepting ?? false),
      is_start: Boolean(obj.is_start ?? obj.isStart ?? defaults.is_start ?? false),
      confidence,
      scan_incomplete: fieldNotes.length > 0,
      field_notes: fieldNotes,
      observation_source: source,
    };
    stateArr.push(observation);
    if (visibleLabel) {
      const rows = observationsByVisibleLabel.get(visibleLabel) || [];
      rows.push(observation);
      observationsByVisibleLabel.set(visibleLabel, rows);
    }
    if (rawRef) {
      const rows = observationsByRawRef.get(rawRef) || [];
      rows.push(observation);
      observationsByRawRef.set(rawRef, rows);
    }
    return observation;
  };

  if (Array.isArray(raw.states)) {
    raw.states.forEach(s => addStateObservation(s));
  }

  /* Duplicate visible labels do not authorize merging physical circles. Keep
     every row and mark the ambiguity until connector geometry identifies one. */
  observationsByVisibleLabel.forEach((rows, label) => {
    if (rows.length < 2) return;
    rows.forEach(s => {
      s.scan_incomplete = true;
      s.field_notes.push(`visible state label "${label}" occurs on more than one physical circle`);
    });
  });
  observationsByRawRef.forEach((rows, rawRef) => {
    if (rows.length < 2) return;
    rows.forEach(s => {
      s.scan_incomplete = true;
      s.field_notes.push(`model observation_id "${rawRef}" was reused for more than one physical circle`);
    });
  });

  const resolveEndpointObservation = field => {
    const obj = field && typeof field === 'object' ? field : {};
    const rawRef = String(obj.observation_id ?? obj.observationId ?? '').trim();
    const visibleLabel = stateId(field, '').trim();
    if (rawRef) {
      const matches = observationsByRawRef.get(rawRef) || [];
      if (matches.length === 1) {
        const stateLabel = String(matches[0].visible_label || '').trim();
        return {
          observation: matches[0],
          ambiguous: false,
          labelConflict: Boolean(visibleLabel && stateLabel && visibleLabel !== stateLabel),
        };
      }
      if (matches.length > 1) return { observation: null, ambiguous: true, labelConflict: false };
    }
    if (!visibleLabel || visibleLabel === '?') return { observation: null, ambiguous: false, labelConflict: false };
    const matches = observationsByVisibleLabel.get(visibleLabel) || [];
    if (matches.length === 1) return { observation: matches[0], ambiguous: false, labelConflict: false };
    if (matches.length > 1) return { observation: null, ambiguous: true, labelConflict: false };
    /* A transition endpoint may be the only returned observation of a clearly
       labelled circle. Preserve that visible evidence once; never invent qN. */
    return { observation: addStateObservation(field, {}, 'transition_endpoint'), ambiguous: false, labelConflict: false };
  };

  const transitions = list.filter(Boolean).map((t, i) => {
    const srcId = stateId(t.source_state || t.source, '').trim();
    const dstId = stateId(t.target_state || t.target, '').trim();
    const sourceResolution = resolveEndpointObservation(t.source_state || t.source);
    const targetResolution = resolveEndpointObservation(t.target_state || t.target);
    // A single drawn arrow may carry several stacked rules; accept the new
    // rules array as well as the legacy flat one-rule-per-transition shape.
    const ruleSrcs = Array.isArray(t.rules) ? t.rules : [t];
    const rules = ruleSrcs.filter(Boolean).map(r => {
      const rawText = ruleRawText(t, r);
      if (isTm) {
        const parsedLabel = parseTmLabel(rawText);
        const modelRead = (r.read_input && r.read_input.value) ?? r.read;
        const readValue = normalizeScannedSymbol((parsedLabel && parsedLabel.read) ?? modelRead);
        let readConfidence = Number((r.read_input && r.read_input.confidence) ?? r.read_confidence ?? DEFAULT_CONFIDENCE);
        const fieldNotes = [];
        if (!rawText) fieldNotes.push('TM raw label evidence is missing');
        else if (!parsedLabel) fieldNotes.push('TM raw label is malformed; read/write/direction could not be verified');
        if (readValue === '?') {
          fieldNotes.push('TM read symbol is missing or unreadable');
          readConfidence = Math.min(readConfidence, 0.55);
        }
        return {
          raw_label_text: rawText,
          read_input: {
            value: readValue,
            confidence: readConfidence,
          },
          // These fields remain present for response-shape compatibility, but a
          // TM has no stack. Empty strings avoid inventing epsilon/PUSH/POP data.
          stack_action: { type: 'NONE', confidence: 1 },
          push_value: { value: '', confidence: 1 },
          pop_value: { value: '', confidence: 1 },
          pop_symbol: { value: '', confidence: 1 },
          zones: { left_text: '', middle_text: '', right_text: '' },
          line_bbox: { x: -1, y: -1, w: -1, h: -1 },
          semantic_issues: [],
          field_notes: fieldNotes,
          scan_incomplete: fieldNotes.length > 0 || !Number.isFinite(readConfidence) || readConfidence < 0.75,
        };
      }
      // DFA/NFA mode: raw_label_text is a bare input-symbol list ("a", "0,1") with no
      // stack zones, so the comma/slash zone-splitting below would corrupt it (the
      // second symbol of "0,1" would be misread as a stack-top). Take the read as-is
      // and force the stack fields empty.
      if (!isPda) {
        const modelRead = (r.read_input && r.read_input.value) ?? r.read;
        const readValue = normalizeScannedSymbol(modelRead);
        let readConfidence = Number((r.read_input && r.read_input.confidence) ?? r.read_confidence ?? DEFAULT_CONFIDENCE);
        const fieldNotes = [];
        if (!rawText) fieldNotes.push('finite-automaton raw label evidence is missing');
        else if (/[�□▯▢◻◼⬜⬛]/.test(rawText)) {
          fieldNotes.push('finite-automaton raw label contains an unreadable glyph');
        }
        if (readValue === '?') {
          fieldNotes.push('finite-automaton read field is missing or unreadable');
          readConfidence = Math.min(readConfidence, 0.55);
        }
        return {
          raw_label_text: rawText,
          read_input: {
            value: readValue,
            confidence: readConfidence,
          },
          stack_action: { type: 'NONE', confidence: 1 },
          push_value: { value: EPSILON, confidence: 1 },
          pop_value: { value: EPSILON, confidence: 1 },
          pop_symbol: { value: EPSILON, confidence: 1 },
          zones: { left_text: '', middle_text: '', right_text: '' },
          line_bbox: { x: -1, y: -1, w: -1, h: -1 },
          semantic_issues: [],
          field_notes: fieldNotes,
          scan_incomplete: fieldNotes.length > 0 || !Number.isFinite(readConfidence) || readConfidence < 0.75,
        };
      }
      // ── PDA rule: the SPATIAL read is the source of truth ──────────────
      // The model returns one field per physical zone of the label:
      //   left zone   -> read_input   (INPUT)
      //   middle zone -> pop_value    (STACK_TOP)
      //   right zone  -> stack_action + push_value / pop_symbol (ACTION)
      // raw_label_text is kept for display, audit and supporting evidence.
      // It must NOT override the spatial read, so nothing below rewrites a
      // field from the flat string — a disagreement is reported instead.
      const rawAction = (r.stack_action && r.stack_action.type) ?? r.action;
      const observedStructuredAction = rawAction == null ? '' : String(rawAction);
      const modelAction = normalizeActionToken(rawAction);
      const action = normalizeStackAction(rawAction, r, rawText);
      const readValue = normalizeScannedSymbol((r.read_input && r.read_input.value) ?? r.read);
      const popValue = normalizeScannedSymbol((r.pop_value && r.pop_value.value) ?? r.top ?? r.pop);
      const observedPushValue = normalizeScannedSymbol((r.push_value && r.push_value.value) ?? r.push);
      const observedPopSymbol = normalizeScannedSymbol((r.pop_symbol && r.pop_symbol.value) ?? r.pop_symbol);
      const pushValue = action === 'PUSH'
        ? observedPushValue
        : EPSILON;
      // ACTION.symbol of a POP, read from the RIGHT zone and stored separately
      // from STACK_TOP so a contradiction between them can be held and shown.
      const popSymbol = action === 'POP'
        ? observedPopSymbol
        : EPSILON;
      let readConfidence = Number((r.read_input && r.read_input.confidence) ?? r.read_confidence ?? DEFAULT_CONFIDENCE);
      let actionConfidence = Number((r.stack_action && r.stack_action.confidence) ?? r.action_confidence ?? DEFAULT_CONFIDENCE);
      let pushConfidence = Number((r.push_value && r.push_value.confidence) ?? r.push_confidence ?? DEFAULT_CONFIDENCE);
      let popConfidence = Number((r.pop_value && r.pop_value.confidence) ?? r.top_confidence ?? r.pop_confidence ?? DEFAULT_CONFIDENCE);
      let popSymbolConfidence = Number((r.pop_symbol && r.pop_symbol.confidence) ?? DEFAULT_CONFIDENCE);

      // Visual-confidence signals only: a disagreement between the flat text and
      // the spatial read means "I may have misread", so the confidence drops and
      // the rule surfaces for review. The VALUE itself is left exactly as read.
      const fieldNotes = [];
      const rawRead = readFromRawLabel(rawText);
      const rawTop = topFromRawLabel(rawText);
      if (rawRead && readValue !== rawRead) {
        fieldNotes.push(`raw label reads input "${rawRead}" but the zone parse says "${readValue}"`);
        readConfidence = Math.min(readConfidence, 0.72);
      }
      if (rawTop && popValue !== rawTop) {
        fieldNotes.push(`raw label reads stack-top "${rawTop}" but the zone parse says "${popValue}"`);
        popConfidence = Math.min(popConfidence, 0.78);
      }
      const rawActionValue = actionValueFromRawLabel(rawText);
      if (rawActionValue && action === 'PUSH' && pushValue !== rawActionValue) {
        fieldNotes.push(`raw label reads push symbol "${rawActionValue}" but the zone parse says "${pushValue}"`);
        pushConfidence = Math.min(pushConfidence, 0.72);
      }
      if (rawActionValue && action === 'POP' && popSymbol !== rawActionValue) {
        fieldNotes.push(`raw label reads pop symbol "${rawActionValue}" but the zone parse says "${popSymbol}"`);
        popSymbolConfidence = Math.min(popSymbolConfidence, 0.72);
      }

      const zones = r.zones && typeof r.zones === 'object' ? r.zones : {};
      const zoneLeft = String(zones.left_text ?? '');
      const zoneMiddle = String(zones.middle_text ?? '');
      const zoneRight = String(zones.right_text ?? '');
      const zoneRead = spatialSingleSymbol(zoneLeft);
      const zoneTop = spatialSingleSymbol(zoneMiddle);
      const zoneAction = actionTypeFromText(zoneRight);
      const zoneActionValue = normalizeScannedSymbol(actionValueFromRawLabel(`x,x / ${zoneRight}`));
      const rawActionType = actionTypeFromText(labelPartAfterSlash(rawText));
      const zoneReadMissing = !zoneRead || zoneRead === '?';
      const zoneTopMissing = !zoneTop || zoneTop === '?';
      const actionNeedsSymbol = action === 'PUSH' || action === 'POP';
      const zoneActionSymbolMissing = actionNeedsSymbol && zoneAction === action &&
        (zoneActionValue === '?' || zoneActionValue === EPSILON);
      const inactiveActionConflict =
        (action === 'PUSH' && observedPopSymbol !== EPSILON) ||
        (action === 'POP' && observedPushValue !== EPSILON) ||
        (action === 'NONE' && (observedPushValue !== EPSILON || observedPopSymbol !== EPSILON));
      if (zoneReadMissing && zoneLeft.trim()) {
        fieldNotes.push('left-zone symbol is missing or unreadable');
        readConfidence = Math.min(readConfidence, 0.55);
      }
      if (zoneTopMissing && zoneMiddle.trim()) {
        fieldNotes.push('middle-zone STACK_TOP symbol is missing or unreadable');
        popConfidence = Math.min(popConfidence, 0.55);
      }
      if (zoneRead && zoneRead !== readValue) {
        fieldNotes.push(`left-zone evidence reads "${zoneRead}" but read_input says "${readValue}"`);
        readConfidence = Math.min(readConfidence, 0.65);
      }
      if (zoneTop && zoneTop !== popValue) {
        fieldNotes.push(`middle-zone evidence reads "${zoneTop}" but pop_value says "${popValue}"`);
        popConfidence = Math.min(popConfidence, 0.65);
      }
      if (zoneAction && zoneAction !== action) {
        fieldNotes.push(`right-zone evidence reads action ${zoneAction} but stack_action says ${action}`);
        actionConfidence = Math.min(actionConfidence, 0.65);
      }
      if (zoneRight.trim() && !zoneAction) {
        fieldNotes.push('right-zone operation is missing or uses an unapproved notation');
        actionConfidence = Math.min(actionConfidence, 0.55);
      }
      if ((action === 'PUSH' || action === 'POP') && zoneAction === action &&
          zoneActionValue !== '?' && zoneActionValue !== EPSILON) {
        const structuredActionValue = action === 'PUSH' ? pushValue : popSymbol;
        if (structuredActionValue !== zoneActionValue) {
          fieldNotes.push(`right-zone action symbol reads "${zoneActionValue}" but the structured field says "${structuredActionValue}"`);
          if (action === 'PUSH') pushConfidence = Math.min(pushConfidence, 0.65);
          else popSymbolConfidence = Math.min(popSymbolConfidence, 0.65);
        }
      }
      if (zoneActionSymbolMissing) {
        fieldNotes.push(`${action} symbol is missing or unreadable in the right-zone evidence`);
        if (action === 'PUSH') pushConfidence = Math.min(pushConfidence, 0.55);
        else popSymbolConfidence = Math.min(popSymbolConfidence, 0.55);
      }
      if (action === 'NONE' && zoneAction === 'NONE' &&
          zoneActionValue !== '?' && zoneActionValue !== EPSILON) {
        /* Whether a symbol may follow NONE was explicitly left open.  Preserve
           the literal right-zone evidence, but do not silently discard it and
           execute the line as an ordinary no-change rule. */
        fieldNotes.push(`right-zone NONE also contains the visible symbol "${zoneActionValue}"; its meaning is not defined`);
        actionConfidence = Math.min(actionConfidence, 0.65);
      }
      if (rawActionType && rawActionType !== action) {
        fieldNotes.push(`raw label suggests action ${rawActionType} but the spatial action is ${action}`);
        actionConfidence = Math.min(actionConfidence, 0.72);
      }
      if (!modelAction) {
        fieldNotes.push(zoneAction
          ? 'structured ACTION is missing or unrecognized; the RIGHT zone was kept only as a review fallback'
          : 'structured ACTION is missing or unrecognized');
        actionConfidence = Math.min(actionConfidence, 0.55);
      }
      if (action === 'UNKNOWN') {
        fieldNotes.push('ACTION is unreadable or uses an unapproved notation');
        actionConfidence = Math.min(actionConfidence, 0.55);
      }
      if (inactiveActionConflict) {
        const detail = action === 'PUSH' ? 'POP symbol' : (action === 'POP' ? 'PUSH symbol' : 'action symbol');
        fieldNotes.push(`${action} was returned together with an inactive ${detail}; the visible fields were preserved for review`);
        actionConfidence = Math.min(actionConfidence, 0.65);
      }
      if (readValue === '?') {
        fieldNotes.push('INPUT is missing or unreadable');
        readConfidence = Math.min(readConfidence, 0.55);
      }
      if (popValue === '?') {
        fieldNotes.push('STACK_TOP is missing or unreadable');
        popConfidence = Math.min(popConfidence, 0.55);
      }
      if (action === 'PUSH' && pushValue === '?') {
        fieldNotes.push('PUSH symbol is missing or unreadable');
        pushConfidence = Math.min(pushConfidence, 0.55);
      }
      if (action === 'POP' && popSymbol === '?') {
        fieldNotes.push('POP action symbol is missing or unreadable');
        popSymbolConfidence = Math.min(popSymbolConfidence, 0.55);
      }
      for (const [name, text] of [['left', zoneLeft], ['middle', zoneMiddle], ['right', zoneRight]]) {
        if (!text.trim()) fieldNotes.push(`${name}-zone literal evidence is missing`);
      }

      const bboxResult = normalizeLineBbox(r.line_bbox);
      if (!bboxResult.localized) {
        fieldNotes.push(bboxResult.invalid ? 'line_bbox was invalid and was discarded' : 'rule line could not be localized');
        readConfidence = Math.min(readConfidence, 0.70);
        popConfidence = Math.min(popConfidence, 0.70);
        actionConfidence = Math.min(actionConfidence, 0.70);
      }

      // Semantic validation: separate from confidence. It never edits a value.
      const semanticIssues = ruleSemanticIssues({ action, popValue, popSymbol, pushValue });
      const fieldConfidenceLow = [readConfidence, popConfidence, actionConfidence,
        action === 'PUSH' ? pushConfidence : 1, action === 'POP' ? popSymbolConfidence : 1]
        .some(c => !Number.isFinite(c) || c < 0.75);
      const zoneConflict = Boolean((zoneAction && zoneAction !== action) || (zoneRight.trim() && !zoneAction) ||
        zoneReadMissing || zoneTopMissing || zoneActionSymbolMissing || inactiveActionConflict ||
        (action === 'NONE' && zoneAction === 'NONE' && zoneActionValue !== '?' && zoneActionValue !== EPSILON) ||
        ((action === 'PUSH' || action === 'POP') && zoneAction === action && zoneActionValue !== '?' &&
          zoneActionValue !== EPSILON && zoneActionValue !== (action === 'PUSH' ? pushValue : popSymbol)));
      const scanIncomplete = !modelAction || action === 'UNKNOWN' || !zoneLeft.trim() || !zoneMiddle.trim() || !zoneRight.trim() ||
        readValue === '?' || popValue === '?' || (action === 'PUSH' && pushValue === '?') ||
        (action === 'POP' && (popSymbol === '?' || popSymbol === EPSILON)) ||
        inactiveActionConflict ||
        zoneConflict || !bboxResult.localized || fieldConfidenceLow || semanticIssues.length > 0;
      return {
        raw_label_text: rawText,
        // The literal text seen in each physical zone, when the model localized
        // them. Never synthesized here — an unlocalized zone stays an empty
        // string and an unlocalized line box stays -1.
        zones: {
          left_text: zoneLeft,
          middle_text: zoneMiddle,
          right_text: zoneRight,
        },
        line_bbox: bboxResult.box,
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
        pop_symbol: {
          value: popSymbol,
          confidence: popSymbolConfidence,
        },
        observed_fields: {
          read_input: readValue,
          stack_top: popValue,
          // Preserve the literal structured model field, including an empty or
          // unapproved token. The executable/fallback action lives separately
          // in stack_action.type and must never overwrite this audit evidence.
          action: observedStructuredAction,
          push_symbol: observedPushValue,
          pop_symbol: observedPopSymbol,
        },
        semantic_issues: semanticIssues,
        field_notes: fieldNotes,
        scan_incomplete: scanIncomplete,
      };
    });
    const sourceConfidence = Number((t.source_state && t.source_state.confidence) ?? t.source_confidence ?? DEFAULT_CONFIDENCE);
    const targetConfidence = Number((t.target_state && t.target_state.confidence) ?? t.target_confidence ?? DEFAULT_CONFIDENCE);
    const countValue = t.visible_rule_line_count;
    const hasValidVisibleLineCount = typeof countValue === 'number' && Number.isInteger(countValue) && countValue >= 0;
    const visibleRuleLineCount = hasValidVisibleLineCount ? countValue : null;
    const visibleLineCountMismatch = !hasValidVisibleLineCount || visibleRuleLineCount !== rules.length;
    const endpointsAmbiguous = sourceResolution.ambiguous || targetResolution.ambiguous;
    const endpointLabelConflict = sourceResolution.labelConflict || targetResolution.labelConflict;
    const endpointEvidenceIncomplete = !srcId || !dstId || !sourceResolution.observation ||
      !targetResolution.observation || endpointsAmbiguous || endpointLabelConflict ||
      sourceConfidence < 0.75 || targetConfidence < 0.75;
    if (endpointEvidenceIncomplete) {
      rules.forEach(rule => {
        rule.scan_incomplete = true;
        const endpointNote = endpointsAmbiguous
          ? 'transition source/target label refers to more than one physical state observation'
          : endpointLabelConflict
            ? 'transition endpoint observation_id conflicts with its visible state label'
          : 'transition source/target is missing or visually uncertain';
        rule.field_notes = [...new Set([...(rule.field_notes || []), endpointNote])];
      });
    }
    if (visibleLineCountMismatch) {
      rules.forEach(rule => {
        rule.scan_incomplete = true;
        const note = hasValidVisibleLineCount
          ? `visible rule-line count ${visibleRuleLineCount} does not match ${rules.length} transcribed rules`
          : 'visible rule-line count is missing or invalid';
        rule.field_notes = [...new Set([...(rule.field_notes || []), note])];
      });
    }
    return ({
    transition_id: String(t.transition_id || `t_${String(i + 1).padStart(2, '0')}`),
    visible_rule_line_count: visibleRuleLineCount,
    endpoint_scan_issue: endpointsAmbiguous
      ? 'endpoint label is shared by multiple physical state observations'
      : (endpointLabelConflict ? 'endpoint observation_id conflicts with its visible label' : ''),
    source_state: {
      id: srcId,
      observation_id: sourceResolution.observation ? sourceResolution.observation.observation_id : '',
      confidence: sourceConfidence,
    },
    target_state: {
      id: dstId,
      observation_id: targetResolution.observation ? targetResolution.observation.observation_id : '',
      confidence: targetConfidence,
    },
    rules,
    /* Never label the full source image as a cropped line.  Until a real crop is
       produced from a verified bbox, leave this field empty. */
    cropped_image_segment_url: '',
    });
  });

  // No silent repair pass runs here any more. A contradiction between what was
  // read and what is semantically legal is reported on the rule (semantic_issues)
  // and surfaced to the user — it is never quietly rewritten into something legal.

  const scanIssues = [];
  stateArr.forEach(s => {
    if (s.scan_incomplete) {
      scanIssues.push(`State observation ${s.observation_id} requires review: ${(s.field_notes || []).join('; ')}`);
    }
  });
  if (stateArr.length && !stateArr.some(s => s.is_start)) {
    scanIssues.push('No start arrow was identified; no state was selected automatically');
  }
  if (stateArr.filter(s => s.is_start).length > 1) {
    scanIssues.push('More than one start arrow was identified; all readings were preserved for manual review');
  }
  transitions.forEach(t => {
    if (!t.source_state.id || !t.target_state.id || !t.source_state.observation_id || !t.target_state.observation_id) {
      scanIssues.push(`Transition ${t.transition_id} has an unresolved source or target; its evidence was preserved`);
    }
    const matchingSourceLabels = observationsByVisibleLabel.get(t.source_state.id) || [];
    const matchingTargetLabels = observationsByVisibleLabel.get(t.target_state.id) || [];
    if ((!t.source_state.observation_id && matchingSourceLabels.length > 1) ||
        (!t.target_state.observation_id && matchingTargetLabels.length > 1)) {
      scanIssues.push(`Transition ${t.transition_id} has an ambiguous endpoint label shared by multiple physical circles`);
    }
    if (t.endpoint_scan_issue) {
      scanIssues.push(`Transition ${t.transition_id} requires endpoint review: ${t.endpoint_scan_issue}`);
    }
    if (t.visible_rule_line_count == null) {
      scanIssues.push(`Transition ${t.transition_id} is missing a valid visible rule-line count`);
    } else if (t.visible_rule_line_count !== t.rules.length) {
      scanIssues.push(`Transition ${t.transition_id} has ${t.visible_rule_line_count} visible rule lines but ${t.rules.length} transcribed rules; missing lines were not invented`);
    }
  });
  flagStructuralProblems(stateArr, transitions);
  return { states: stateArr, transitions, scan_issues: scanIssues };
}

function parsedRules(value) {
  const raw = value || {};
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw.transitions) ? raw.transitions : [raw]);
  return list.filter(Boolean).flatMap(t => {
    const rules = Array.isArray(t.rules) ? t.rules : [t];
    return rules.filter(Boolean).map(r => ({ transition: t, rule: r }));
  });
}

function rawHasActionWord(raw) {
  const s = String(raw || '');
  return /ללא\s*שינוי|לל["״']?\s*ש|(?:^|\s)דחוף(?:\s|$)|(?:^|\s)שלוף(?:\s|$)/.test(s);
}

function rawLooksLikePdaRule(raw) {
  const s = String(raw || '').trim();
  return s.includes('/') && /[,،，]/.test(s);
}

function rawLooksLikeTmRule(raw) {
  return Boolean(parseTmLabel(raw));
}

function parseQualityProblems(value, isPda, isTm) {
  const problems = [];
  const analysis = value && value.analysis;
  for (const key of ['input_glyph_audit_table', 'rule_parse_table', 'final_audit_table']) {
    if (!analysis || !String(analysis[key] || '').trim()) problems.push(`missing analysis.${key}`);
  }
  const transitionList = Array.isArray(value) ? value
    : (value && Array.isArray(value.transitions) ? value.transitions : (value ? [value] : []));
  transitionList.filter(Boolean).forEach((transition, index) => {
    const count = transition.visible_rule_line_count;
    const validCount = typeof count === 'number' && Number.isInteger(count) && count >= 0;
    const actual = Array.isArray(transition.rules)
      ? transition.rules.filter(Boolean).length
      : (transition && !Array.isArray(transition.rules) ? 1 : 0);
    const tag = `transition ${transition.transition_id || index + 1}`;
    if (!validCount) problems.push(`${tag}: missing or invalid visible_rule_line_count`);
    else if (count !== actual) {
      problems.push(`${tag}: visible_rule_line_count ${count} does not match rules.length ${actual}`);
    }
  });
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
      // stack zone or action word, so these must never run in DFA/NFA/TM mode.
      if (!rawLooksLikePdaRule(raw)) problems.push(`${tag}: raw_label_text is not split as input,stack/action`);
      if (!rawHasActionWord(raw)) problems.push(`${tag}: raw_label_text is missing stack action word`);
      const zones = rule && rule.zones;
      if (!zones || !String(zones.left_text || '').trim()) problems.push(`${tag}: missing LEFT-zone evidence`);
      if (!zones || !String(zones.middle_text || '').trim()) problems.push(`${tag}: missing MIDDLE-zone evidence`);
      if (!zones || !String(zones.right_text || '').trim()) problems.push(`${tag}: missing RIGHT-zone evidence`);
      if (!String(from || '').trim() || from === '?' || !String(to || '').trim() || to === '?') problems.push(`${tag}: unresolved source or target`);
      const bbox = normalizeLineBbox(rule && rule.line_bbox);
      if (bbox.invalid) problems.push(`${tag}: invalid line_bbox`);
      else if (!bbox.localized) problems.push(`${tag}: rule line was not localized`);
    } else if (isTm && !rawLooksLikeTmRule(raw)) {
      problems.push(`${tag}: raw_label_text is not a valid TM read/write/direction label`);
    }
  });
  return problems;
}

// ── Conservative two-stage Vision contract ────────────────────────────────
// Stage A owns geometry only. Stage B owns label transcription only. Keeping
// these normalizers pure lets the contract be regression-tested without a live
// model call and, more importantly, prevents Stage B from rewriting topology.
function cloneJson(value, fallback = {}) {
  try { return JSON.parse(JSON.stringify(value)); } catch { return fallback; }
}

function stringIssues(value) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function scanSessionId(value) {
  const supplied = String(value || '').trim();
  if (/^[A-Za-z0-9_.:-]{1,160}$/.test(supplied)) return supplied;
  return `scan_${crypto.randomUUID()}`;
}

function evidenceBox(value, name, issues) {
  const result = normalizeLineBbox(value);
  if (!result.localized) issues.push(result.invalid
    ? `${name} is malformed or outside normalized 0..1 coordinates`
    : `${name} is missing or could not be localized`);
  return result.box;
}

function booleanVisualEvidence(field, legacyConfidence, name, issues) {
  const structured = field && typeof field === 'object' && Object.prototype.hasOwnProperty.call(field, 'value');
  const hasLegacyValue = typeof field === 'boolean';
  const value = structured ? field.value : (hasLegacyValue ? field : false);
  const confidenceValue = structured ? field.confidence : legacyConfidence;
  let confidence = Number(confidenceValue);
  if (typeof value !== 'boolean') issues.push(`${name}.value is missing or malformed`);
  if (!Number.isFinite(confidence)) {
    confidence = 0;
    issues.push(`${name}.confidence is missing or malformed`);
  } else if (confidence < 0.75) {
    issues.push(`${name}.confidence is below review threshold`);
  }
  return { value: typeof value === 'boolean' ? value : false, confidence };
}

function normalizeTopologyStageResult(value, sessionValue) {
  const raw = value && value.topology && typeof value.topology === 'object' ? value.topology : (value || {});
  const session = scanSessionId(sessionValue || (value && value.scan_session_id));
  const topIssues = stringIssues(raw.issues);
  const stateRows = Array.isArray(raw.states) ? raw.states.filter(Boolean) : [];
  const stateIdMap = new Map();
  const states = stateRows.map(row => {
    const observationId = String(row.observation_id || '').trim();
    const issues = stringIssues(row.issues);
    const bbox = evidenceBox(row.bbox || row.circle_bbox, 'circle bbox', issues);
    let confidence = Number(row.confidence ?? DEFAULT_CONFIDENCE);
    if (!observationId) issues.push('physical state observation_id is missing');
    if (!Number.isFinite(confidence)) { confidence = 0; issues.push('state confidence is malformed'); }
    if (confidence < 0.75) issues.push('state geometry confidence is below review threshold');
    const startEvidence = booleanVisualEvidence(row.is_start, row.is_start_confidence,
      'is_start', issues);
    const acceptingEvidence = booleanVisualEvidence(row.is_accepting, row.is_accepting_confidence,
      'is_accepting', issues);
    const out = {
      observation_id: observationId,
      // Stage A is deliberately forbidden to OCR semantic labels.
      visible_label: '',
      bbox,
      is_start: startEvidence,
      is_accepting: acceptingEvidence,
      confidence,
      issues: [...new Set(issues)],
      scan_incomplete: issues.length > 0,
    };
    const matches = stateIdMap.get(observationId) || [];
    matches.push(out);
    stateIdMap.set(observationId, matches);
    return out;
  });
  stateIdMap.forEach((rows, id) => {
    if (!id || rows.length < 2) return;
    topIssues.push(`duplicate physical state observation_id "${id}"`);
    rows.forEach(row => {
      row.issues = [...new Set([...row.issues, `duplicate state observation_id "${id}"`])];
      row.scan_incomplete = true;
    });
  });

  const visibleStateCount = raw.visible_state_count;
  if (typeof visibleStateCount !== 'number' || !Number.isInteger(visibleStateCount) || visibleStateCount < 0) {
    topIssues.push('visible_state_count is missing or malformed');
  } else if (visibleStateCount !== states.length) {
    topIssues.push(`visible_state_count ${visibleStateCount} does not match states.length ${states.length}`);
  }

  /* An arrow entering from empty space is evidence for is_start, not a
     transition that consumes input. Keep it in its own observation table and
     exclude it from every connector count/list below. */
  const startMarkerRows = Array.isArray(raw.start_marker_observations)
    ? raw.start_marker_observations.filter(Boolean) : [];
  const startMarkerIds = new Map();
  const startMarkerObservations = startMarkerRows.map(row => {
    const markerId = String(row.marker_id || '').trim();
    const targetObservationId = String(row.target_observation_id || '').trim();
    const issues = stringIssues(row.issues);
    const markerBbox = evidenceBox(row.marker_bbox || row.bbox, 'start-marker bbox', issues);
    const arrowheadBbox = evidenceBox(row.arrowhead_bbox, 'start-marker arrowhead bbox', issues);
    let confidence = Number(row.confidence ?? DEFAULT_CONFIDENCE);
    if (!markerId) issues.push('start marker_id is missing');
    const targets = stateIdMap.get(targetObservationId) || [];
    if (!targetObservationId) issues.push('start marker target_observation_id is missing');
    else if (targets.length !== 1) issues.push(targets.length
      ? `start marker target_observation_id "${targetObservationId}" is duplicated`
      : `foreign start marker target_observation_id "${targetObservationId}"`);
    if (!Number.isFinite(confidence)) { confidence = 0; issues.push('start-marker confidence is malformed'); }
    if (confidence < 0.75) issues.push('start-marker confidence is below review threshold');
    const out = {
      marker_id: markerId,
      target_observation_id: targetObservationId,
      marker_bbox: markerBbox,
      arrowhead_bbox: arrowheadBbox,
      confidence,
      issues: [...new Set(issues)],
      scan_incomplete: issues.length > 0,
    };
    const matches = startMarkerIds.get(markerId) || [];
    matches.push(out);
    startMarkerIds.set(markerId, matches);
    return out;
  });
  startMarkerIds.forEach((rows, id) => {
    if (!id || rows.length < 2) return;
    topIssues.push(`duplicate start marker_id "${id}"`);
    rows.forEach(row => {
      row.issues = [...new Set([...row.issues, `duplicate start marker_id "${id}"`])];
      row.scan_incomplete = true;
    });
  });
  states.forEach(state => {
    const markerMatches = startMarkerObservations.filter(marker =>
      marker.target_observation_id === state.observation_id && !marker.scan_incomplete);
    if (state.is_start.value !== (markerMatches.length > 0)) {
      state.issues = [...new Set([...state.issues,
        'is_start value conflicts with the separate incoming start-marker observations'])];
      state.scan_incomplete = true;
    }
    if (markerMatches.length > 1) {
      state.issues = [...new Set([...state.issues, 'more than one start marker targets this state'])];
      state.scan_incomplete = true;
    }
  });

  const observationRows = Array.isArray(raw.connector_observations)
    ? raw.connector_observations.filter(Boolean) : [];
  const connectorObservationMap = new Map();
  const connectorObservations = observationRows.map(row => {
    const connectorObservationId = String(row.connector_observation_id || '').trim();
    const issues = stringIssues(row.issues);
    const connectorBbox = evidenceBox(row.connector_bbox || row.bbox, 'connector bbox', issues);
    const arrowheadBbox = evidenceBox(row.arrowhead_bbox, 'arrowhead bbox', issues);
    const labelBlockBbox = evidenceBox(row.label_block_bbox, 'label-block bbox', issues);
    let confidence = Number(row.confidence ?? DEFAULT_CONFIDENCE);
    if (!connectorObservationId) issues.push('connector_observation_id is missing');
    if (!Number.isFinite(confidence)) { confidence = 0; issues.push('connector confidence is malformed'); }
    if (confidence < 0.75) issues.push('connector geometry confidence is below review threshold');
    const count = row.visible_line_count;
    const validCount = typeof count === 'number' && Number.isInteger(count) && count >= 0;
    if (!validCount) issues.push('visible_line_count is missing or malformed');
    const hintRows = Array.isArray(row.line_hints) ? row.line_hints.filter(Boolean) : [];
    const lineIdMap = new Map();
    const lineHints = hintRows.map(hint => {
      const lineId = String(hint.line_id || '').trim();
      const lineIssues = stringIssues(hint.issues);
      const bbox = evidenceBox(hint.bbox || hint.line_bbox, 'line-hint bbox', lineIssues);
      let lineConfidence = Number(hint.confidence ?? confidence);
      if (!lineId) lineIssues.push('line_id is missing');
      if (!Number.isFinite(lineConfidence)) { lineConfidence = 0; lineIssues.push('line confidence is malformed'); }
      if (lineConfidence < 0.75) lineIssues.push('line geometry confidence is below review threshold');
      const normalized = {
        line_id: lineId,
        bbox,
        confidence: lineConfidence,
        issues: [...new Set(lineIssues)],
        scan_incomplete: lineIssues.length > 0,
      };
      const matches = lineIdMap.get(lineId) || [];
      matches.push(normalized);
      lineIdMap.set(lineId, matches);
      return normalized;
    });
    lineIdMap.forEach((rows, id) => {
      if (!id || rows.length < 2) return;
      issues.push(`duplicate line_id "${id}" within one connector observation`);
      rows.forEach(line => {
        line.issues = [...new Set([...line.issues, `duplicate line_id "${id}"`])];
        line.scan_incomplete = true;
      });
    });
    if (validCount && count !== lineHints.length) {
      issues.push(`visible_line_count ${count} does not match line_hints.length ${lineHints.length}`);
    }
    const out = {
      connector_observation_id: connectorObservationId,
      connector_bbox: connectorBbox,
      arrowhead_bbox: arrowheadBbox,
      label_block_bbox: labelBlockBbox,
      visible_line_count: validCount ? count : null,
      line_hints: lineHints,
      confidence,
      issues: [...new Set(issues)],
      scan_incomplete: issues.length > 0 || lineHints.some(line => line.scan_incomplete),
    };
    const matches = connectorObservationMap.get(connectorObservationId) || [];
    matches.push(out);
    connectorObservationMap.set(connectorObservationId, matches);
    return out;
  });
  connectorObservationMap.forEach((rows, id) => {
    if (!id || rows.length < 2) return;
    topIssues.push(`duplicate connector_observation_id "${id}"`);
    rows.forEach(row => {
      row.issues = [...new Set([...row.issues, `duplicate connector_observation_id "${id}"`])];
      row.scan_incomplete = true;
    });
  });

  const transitionRows = Array.isArray(raw.transitions) ? raw.transitions.filter(Boolean)
    : (Array.isArray(raw.connectors) ? raw.connectors.filter(Boolean) : []);
  const transitionIdMap = new Map();
  const transitions = transitionRows.map(row => {
    const transitionId = String(row.transition_id || '').trim();
    const connectorObservationId = String(row.connector_observation_id || '').trim();
    const sourceObservationId = String(row.source_observation_id || '').trim();
    const targetObservationId = String(row.target_observation_id || '').trim();
    const issues = stringIssues(row.issues);
    let confidence = Number(row.confidence ?? DEFAULT_CONFIDENCE);
    if (!transitionId) issues.push('transition_id is missing');
    const physicalMatches = connectorObservationMap.get(connectorObservationId) || [];
    if (!connectorObservationId) issues.push('connector_observation_id reference is missing');
    else if (physicalMatches.length !== 1) issues.push(physicalMatches.length
      ? `connector_observation_id "${connectorObservationId}" is duplicated`
      : `foreign connector_observation_id "${connectorObservationId}"`);
    for (const [role, endpoint] of [['source', sourceObservationId], ['target', targetObservationId]]) {
      const matches = stateIdMap.get(endpoint) || [];
      if (!endpoint) issues.push(`${role}_observation_id is unresolved; no endpoint was invented`);
      else if (matches.length !== 1) issues.push(matches.length
        ? `${role}_observation_id "${endpoint}" is duplicated`
        : `foreign ${role}_observation_id "${endpoint}"`);
    }
    if (!Number.isFinite(confidence)) { confidence = 0; issues.push('transition confidence is malformed'); }
    if (confidence < 0.75) issues.push('transition association confidence is below review threshold');
    const physical = physicalMatches.length === 1 ? physicalMatches[0] : null;
    const out = {
      transition_id: transitionId,
      connector_observation_id: connectorObservationId,
      source_observation_id: sourceObservationId,
      target_observation_id: targetObservationId,
      connector_bbox: physical ? cloneJson(physical.connector_bbox) : { x: -1, y: -1, w: -1, h: -1 },
      arrowhead_bbox: physical ? cloneJson(physical.arrowhead_bbox) : { x: -1, y: -1, w: -1, h: -1 },
      label_block_bbox: physical ? cloneJson(physical.label_block_bbox) : { x: -1, y: -1, w: -1, h: -1 },
      visible_line_count: physical ? physical.visible_line_count : null,
      line_hints: physical ? cloneJson(physical.line_hints, []) : [],
      confidence,
      issues: [...new Set(issues)],
      scan_incomplete: issues.length > 0 || !physical || physical.scan_incomplete,
    };
    const matches = transitionIdMap.get(transitionId) || [];
    matches.push(out);
    transitionIdMap.set(transitionId, matches);
    return out;
  });
  transitionIdMap.forEach((rows, id) => {
    if (!id || rows.length < 2) return;
    topIssues.push(`duplicate transition_id "${id}"`);
    rows.forEach(row => {
      row.issues = [...new Set([...row.issues, `duplicate transition_id "${id}"`])];
      row.scan_incomplete = true;
    });
  });

  const visibleConnectorCount = raw.visible_connector_count;
  const validConnectorCount = typeof visibleConnectorCount === 'number' &&
    Number.isInteger(visibleConnectorCount) && visibleConnectorCount >= 0;
  if (!validConnectorCount) topIssues.push('visible_connector_count is missing or malformed');
  else {
    if (visibleConnectorCount !== connectorObservations.length) {
      topIssues.push(`visible_connector_count ${visibleConnectorCount} does not match connector_observations.length ${connectorObservations.length}`);
    }
    if (visibleConnectorCount !== transitions.length) {
      topIssues.push(`visible_connector_count ${visibleConnectorCount} does not match topology connectors length ${transitions.length}`);
    }
  }
  const referencedConnectorIds = new Map();
  transitions.forEach(t => {
    const rows = referencedConnectorIds.get(t.connector_observation_id) || [];
    rows.push(t);
    referencedConnectorIds.set(t.connector_observation_id, rows);
  });
  connectorObservations.forEach(observation => {
    const refs = referencedConnectorIds.get(observation.connector_observation_id) || [];
    if (observation.connector_observation_id && refs.length !== 1) {
      topIssues.push(refs.length
        ? `connector observation "${observation.connector_observation_id}" maps to ${refs.length} topology connectors`
        : `connector observation "${observation.connector_observation_id}" has no topology connector; no connector was invented`);
    }
  });

  const issues = [...new Set(topIssues)];
  const topology = {
    visible_state_count: typeof visibleStateCount === 'number' ? visibleStateCount : null,
    visible_connector_count: validConnectorCount ? visibleConnectorCount : null,
    states,
    start_marker_observations: startMarkerObservations,
    connector_observations: connectorObservations,
    transitions,
    // Alias for consumers that call transition geometry "connectors". Both are
    // evidence views of the same normalized objects, never separately inferred.
    connectors: cloneJson(transitions, []),
    issues,
    review_only: issues.length > 0 || states.some(s => s.scan_incomplete) ||
      startMarkerObservations.some(marker => marker.scan_incomplete) ||
      connectorObservations.some(c => c.scan_incomplete) || transitions.some(t => t.scan_incomplete),
  };
  return { stage: 'topology', scan_session_id: session, topology, review_only: topology.review_only };
}

function normalizeTopologyAuditManifest(crops, issues = []) {
  const rows = (Array.isArray(crops) ? crops : []).filter(Boolean);
  if (rows.length > 12) issues.push(`topology audit received ${rows.length} tiles; maximum is 12`);
  const idMap = new Map();
  const normalized = rows.map(crop => {
    const cropId = String(crop.crop_id || '').trim();
    const kind = String(crop.kind || '').trim();
    const suppliedIssues = stringIssues(crop.issues);
    const cropIssues = [...suppliedIssues];
    if (!cropId) cropIssues.push('topology tile crop_id is missing');
    if (kind !== 'topology_tile') cropIssues.push(`foreign topology-audit crop kind "${kind || '?'}"`);
    if (!String(crop.image_url || '').trim()) cropIssues.push('topology tile image_url is missing');
    const originalBbox = crop.original_bbox == null
      ? (cropIssues.push('topology tile original_bbox is missing'), { x: -1, y: -1, w: -1, h: -1 })
      : evidenceBox(crop.original_bbox, 'topology tile original_bbox', cropIssues);
    const cropBboxResult = normalizeLineBbox(crop.crop_bbox);
    if (crop.crop_bbox != null && !cropBboxResult.localized) {
      cropIssues.push(cropBboxResult.invalid
        ? 'topology tile crop_bbox is malformed or outside normalized 0..1 coordinates'
        : 'topology tile crop_bbox could not be localized');
    }
    const tileIndexRaw = crop.tile_index;
    const tileIndex = tileIndexRaw == null ? null : Number(tileIndexRaw);
    if (tileIndexRaw != null && (!Number.isInteger(tileIndex) || tileIndex < 0)) {
      cropIssues.push('topology tile tile_index is malformed');
    }
    const originalSize = crop.original_size && typeof crop.original_size === 'object'
      ? { width: Number(crop.original_size.width), height: Number(crop.original_size.height) }
      : null;
    if (originalSize && !(originalSize.width > 0 && originalSize.height > 0)) {
      cropIssues.push('topology tile original_size is malformed');
    }
    const out = {
      crop_id: cropId,
      kind,
      tile_index: Number.isInteger(tileIndex) && tileIndex >= 0 ? tileIndex : null,
      original_bbox: originalBbox,
      crop_bbox: cropBboxResult.box,
      original_size: originalSize && originalSize.width > 0 && originalSize.height > 0
        ? originalSize : null,
      image_role: String(crop.image_role || 'topology_tile'),
      image_present: Boolean(String(crop.image_url || '').trim()),
      issues: [...new Set(cropIssues)],
      scan_incomplete: cropIssues.length > 0,
    };
    const matches = idMap.get(cropId) || [];
    matches.push(out);
    idMap.set(cropId, matches);
    return out;
  });
  idMap.forEach((matches, id) => {
    if (!id || matches.length < 2) return;
    issues.push(`duplicate topology tile crop_id "${id}"`);
    matches.forEach(row => {
      row.issues = [...new Set([...row.issues, `duplicate topology tile crop_id "${id}"`])];
      row.scan_incomplete = true;
    });
  });
  normalized.forEach(row => {
    if (row.scan_incomplete) issues.push(`topology tile ${row.crop_id || '?'} is malformed or incomplete`);
  });
  return normalized;
}

function categoricalVisualEvidence(field, allowedValues, name, issues) {
  const structured = field && typeof field === 'object' &&
    Object.prototype.hasOwnProperty.call(field, 'value');
  const value = String(structured ? field.value : (field ?? 'UNKNOWN')).trim().toUpperCase();
  let confidence = Number(structured ? field.confidence : NaN);
  if (!allowedValues.has(value)) issues.push(`${name}.value is missing or malformed`);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    confidence = 0;
    issues.push(`${name}.confidence is missing or malformed`);
  } else if (confidence < 0.75) {
    issues.push(`${name}.confidence is below review threshold`);
  }
  return { value: allowedValues.has(value) ? value : 'UNKNOWN', confidence };
}

function normalizeTopologyInventoryResult(value, sessionValue) {
  const raw = value && value.inventory && typeof value.inventory === 'object'
    ? value.inventory : (value || {});
  const session = scanSessionId(sessionValue || (value && value.scan_session_id));
  const topIssues = stringIssues(raw.issues);
  const normalizeCount = (rawCount, name, actualLength) => {
    const valid = typeof rawCount === 'number' && Number.isInteger(rawCount) && rawCount >= 0;
    if (!valid) topIssues.push(`${name} is missing or malformed`);
    else if (rawCount !== actualLength) topIssues.push(`${name} ${rawCount} does not match candidates.length ${actualLength}`);
    return valid ? rawCount : null;
  };
  const stateIds = new Map();
  const stateCircleCandidates = (Array.isArray(raw.state_circle_candidates)
    ? raw.state_circle_candidates : []).filter(Boolean).map(row => {
    const candidateId = String(row.candidate_id || '').trim();
    const issues = stringIssues(row.issues);
    if (!candidateId) issues.push('state-circle candidate_id is missing');
    const bbox = evidenceBox(row.bbox, 'state-circle candidate bbox', issues);
    let confidence = Number(row.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      confidence = 0;
      issues.push('state-circle confidence is missing or malformed');
    } else if (confidence < 0.75) issues.push('state-circle confidence is below review threshold');
    const out = {
      candidate_id: candidateId,
      bbox,
      confidence,
      issues: [...new Set(issues)],
      scan_incomplete: issues.length > 0,
    };
    const matches = stateIds.get(candidateId) || [];
    matches.push(out);
    stateIds.set(candidateId, matches);
    return out;
  });
  stateIds.forEach((rows, id) => {
    if (!id || rows.length < 2) return;
    topIssues.push(`duplicate state-circle candidate_id "${id}"`);
    rows.forEach(row => {
      row.issues = [...new Set([...row.issues, `duplicate state-circle candidate_id "${id}"`])];
      row.scan_incomplete = true;
    });
  });

  const arrowIds = new Map();
  const orientationValues = new Set(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'UNKNOWN']);
  const hintValues = new Set(['YES', 'NO', 'UNKNOWN']);
  const computationalArrowheadCandidates = (Array.isArray(raw.computational_arrowhead_candidates)
    ? raw.computational_arrowhead_candidates : []).filter(Boolean).map(row => {
    const candidateId = String(row.candidate_id || '').trim();
    const issues = stringIssues(row.issues);
    if (!candidateId) issues.push('computational-arrowhead candidate_id is missing');
    const bbox = evidenceBox(row.bbox, 'computational-arrowhead candidate bbox', issues);
    const orientation = categoricalVisualEvidence(row.orientation, orientationValues,
      'arrowhead orientation', issues);
    const selfLoopHint = categoricalVisualEvidence(row.self_loop_hint, hintValues,
      'arrowhead self_loop_hint', issues);
    let confidence = Number(row.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      confidence = 0;
      issues.push('computational-arrowhead confidence is missing or malformed');
    } else if (confidence < 0.75) issues.push('computational-arrowhead confidence is below review threshold');
    const out = {
      candidate_id: candidateId,
      bbox,
      orientation,
      self_loop_hint: selfLoopHint,
      confidence,
      issues: [...new Set(issues)],
      scan_incomplete: issues.length > 0,
    };
    const matches = arrowIds.get(candidateId) || [];
    matches.push(out);
    arrowIds.set(candidateId, matches);
    return out;
  });
  arrowIds.forEach((rows, id) => {
    if (!id || rows.length < 2) return;
    topIssues.push(`duplicate computational-arrowhead candidate_id "${id}"`);
    rows.forEach(row => {
      row.issues = [...new Set([...row.issues, `duplicate computational-arrowhead candidate_id "${id}"`])];
      row.scan_incomplete = true;
    });
  });

  const visibleStateCircleCount = normalizeCount(raw.visible_state_circle_count,
    'visible_state_circle_count', stateCircleCandidates.length);
  const visibleComputationalArrowheadCount = normalizeCount(raw.visible_computational_arrowhead_count,
    'visible_computational_arrowhead_count', computationalArrowheadCandidates.length);
  const issues = [...new Set(topIssues)];
  const inventory = {
    visible_state_circle_count: visibleStateCircleCount,
    visible_computational_arrowhead_count: visibleComputationalArrowheadCount,
    state_circle_candidates: stateCircleCandidates,
    computational_arrowhead_candidates: computationalArrowheadCandidates,
    issues,
    review_only: issues.length > 0 || stateCircleCandidates.some(row => row.scan_incomplete) ||
      computationalArrowheadCandidates.some(row => row.scan_incomplete),
  };
  return { stage: 'topology-inventory', scan_session_id: session, inventory, review_only: inventory.review_only };
}

function localizedBoxGeometry(value) {
  const normalized = normalizeLineBbox(value);
  if (!normalized.localized) return null;
  const box = normalized.box;
  return {
    box,
    center: { x: box.x + box.w / 2, y: box.y + box.h / 2 },
    diagonal: Math.hypot(box.w, box.h),
  };
}

function bboxIou(leftValue, rightValue) {
  const left = localizedBoxGeometry(leftValue);
  const right = localizedBoxGeometry(rightValue);
  if (!left || !right) return 0;
  const overlapWidth = Math.max(0, Math.min(left.box.x + left.box.w, right.box.x + right.box.w) -
    Math.max(left.box.x, right.box.x));
  const overlapHeight = Math.max(0, Math.min(left.box.y + left.box.h, right.box.y + right.box.h) -
    Math.max(left.box.y, right.box.y));
  const intersection = overlapWidth * overlapHeight;
  const union = left.box.w * left.box.h + right.box.w * right.box.h - intersection;
  return union > 0 ? intersection / union : 0;
}

function bboxEdgeDistance(leftValue, rightValue) {
  const left = localizedBoxGeometry(leftValue);
  const right = localizedBoxGeometry(rightValue);
  if (!left || !right) return Number.POSITIVE_INFINITY;
  const horizontal = Math.max(0, Math.max(left.box.x, right.box.x) -
    Math.min(left.box.x + left.box.w, right.box.x + right.box.w));
  const vertical = Math.max(0, Math.max(left.box.y, right.box.y) -
    Math.min(left.box.y + left.box.h, right.box.y + right.box.h));
  return Math.hypot(horizontal, vertical);
}

function directionOctant(sourceBox, targetBox) {
  const source = localizedBoxGeometry(sourceBox);
  const target = localizedBoxGeometry(targetBox);
  if (!source || !target) return 'UNKNOWN';
  const dx = target.center.x - source.center.x;
  const dy = target.center.y - source.center.y;
  if (Math.hypot(dx, dy) < 1e-6) return 'UNKNOWN';
  const octants = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
  const degrees = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
  return octants[Math.round(degrees / 45) % 8];
}

function octantDistance(left, right) {
  const octants = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
  const leftIndex = octants.indexOf(String(left || '').toUpperCase());
  const rightIndex = octants.indexOf(String(right || '').toUpperCase());
  if (leftIndex < 0 || rightIndex < 0) return null;
  const distance = Math.abs(leftIndex - rightIndex);
  return Math.min(distance, octants.length - distance);
}

function transformBBoxForReconciliation(value, alignment) {
  const geometry = localizedBoxGeometry(value);
  if (!geometry || !alignment || !alignment.applied) return geometry ? cloneJson(geometry.box) : null;
  return {
    x: geometry.box.x * alignment.scale_x + alignment.translate_x,
    y: geometry.box.y * alignment.scale_y + alignment.translate_y,
    w: geometry.box.w * alignment.scale_x,
    h: geometry.box.h * alignment.scale_y,
  };
}

// Vision calls sometimes return normalized boxes in two slightly different
// global scales even though both calls saw the same original frame.  Estimate a
// bounded axis-aligned affine mapping from the *state constellation only*.
// At least three states and strong constellation consensus are required, so a
// few arbitrary/foreign boxes cannot be aligned into a false match.
function estimateInventoryConstellationAlignment(stateCandidates, states) {
  const candidatePoints = (Array.isArray(stateCandidates) ? stateCandidates : [])
    .map((row, index) => ({ index, id: String(row && row.candidate_id || ''),
      geometry: localizedBoxGeometry(row && row.bbox) }))
    .filter(row => row.geometry);
  const statePoints = (Array.isArray(states) ? states : [])
    .map((row, index) => ({ index, id: String(row && row.observation_id || ''),
      geometry: localizedBoxGeometry(row && row.bbox) }))
    .filter(row => row.geometry);
  const base = {
    method: 'bounded-axis-affine-from-state-constellation',
    applied: false,
    scale_x: 1,
    scale_y: 1,
    translate_x: 0,
    translate_y: 0,
    candidate_state_count: candidatePoints.length,
    final_state_count: statePoints.length,
    consensus_count: 0,
    required_consensus_count: 0,
    rms_center_residual: null,
    max_center_residual: null,
    state_correspondences: [],
    issues: [],
  };
  const smallerCount = Math.min(candidatePoints.length, statePoints.length);
  const requiredConsensus = Math.max(3, Math.ceil(smallerCount * 0.75));
  base.required_consensus_count = requiredConsensus;
  if (smallerCount < 3) {
    base.issues.push('bounded constellation alignment requires at least three localized states');
    return base;
  }

  const extents = points => {
    const xs = points.map(point => point.geometry.center.x);
    const ys = points.map(point => point.geometry.center.y);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  };
  const candidateExtent = extents(candidatePoints);
  const stateExtent = extents(statePoints);
  const candidateRangeX = candidateExtent.maxX - candidateExtent.minX;
  const candidateRangeY = candidateExtent.maxY - candidateExtent.minY;
  const stateRangeX = stateExtent.maxX - stateExtent.minX;
  const stateRangeY = stateExtent.maxY - stateExtent.minY;
  const activeX = candidateRangeX >= 0.08 && stateRangeX >= 0.08;
  const activeY = candidateRangeY >= 0.08 && stateRangeY >= 0.08;
  if (!activeX && !activeY) {
    base.issues.push('state constellation has insufficient span for bounded alignment');
    return base;
  }

  const normalizedPoint = (point, extent, activeAxisX, activeAxisY) => ({
    x: activeAxisX ? (point.geometry.center.x - extent.minX) /
      Math.max(1e-9, extent.maxX - extent.minX) : 0,
    y: activeAxisY ? (point.geometry.center.y - extent.minY) /
      Math.max(1e-9, extent.maxY - extent.minY) : 0,
  });
  const candidateNormalized = candidatePoints.map(point =>
    normalizedPoint(point, candidateExtent, activeX, activeY));
  const stateNormalized = statePoints.map(point =>
    normalizedPoint(point, stateExtent, activeX, activeY));
  const normalizedPairs = [];
  candidatePoints.forEach((candidate, candidateIndex) => {
    statePoints.forEach((state, stateIndex) => {
      const dx = activeX ? candidateNormalized[candidateIndex].x - stateNormalized[stateIndex].x : 0;
      const dy = activeY ? candidateNormalized[candidateIndex].y - stateNormalized[stateIndex].y : 0;
      const distance = Math.hypot(dx, dy) / Math.sqrt((activeX ? 1 : 0) + (activeY ? 1 : 0));
      if (distance <= 0.16) normalizedPairs.push({ candidateIndex, stateIndex, distance });
    });
  });
  normalizedPairs.sort((left, right) => left.distance - right.distance ||
    left.candidateIndex - right.candidateIndex || left.stateIndex - right.stateIndex);
  const usedCandidates = new Set();
  const usedStates = new Set();
  const constellationMatches = [];
  normalizedPairs.forEach(pair => {
    if (usedCandidates.has(pair.candidateIndex) || usedStates.has(pair.stateIndex)) return;
    usedCandidates.add(pair.candidateIndex);
    usedStates.add(pair.stateIndex);
    constellationMatches.push(pair);
  });
  if (constellationMatches.length < requiredConsensus) {
    base.consensus_count = constellationMatches.length;
    base.issues.push(`state-constellation consensus ${constellationMatches.length} is below required ${requiredConsensus}`);
    return base;
  }
  const normalizedRms = Math.sqrt(constellationMatches.reduce((sum, pair) =>
    sum + pair.distance * pair.distance, 0) / constellationMatches.length);
  if (normalizedRms > 0.075) {
    base.consensus_count = constellationMatches.length;
    base.issues.push(`state-constellation normalized residual ${normalizedRms.toFixed(4)} is too large`);
    return base;
  }

  const fitAxis = (candidateKey, stateKey) => {
    const samples = constellationMatches.map(pair => ({
      x: candidatePoints[pair.candidateIndex].geometry.center[candidateKey],
      y: statePoints[pair.stateIndex].geometry.center[stateKey],
    }));
    const meanX = samples.reduce((sum, row) => sum + row.x, 0) / samples.length;
    const meanY = samples.reduce((sum, row) => sum + row.y, 0) / samples.length;
    const variance = samples.reduce((sum, row) => sum + (row.x - meanX) ** 2, 0);
    const covariance = samples.reduce((sum, row) => sum + (row.x - meanX) * (row.y - meanY), 0);
    const scale = variance > 1e-7 ? covariance / variance : 1;
    return { scale, translate: meanY - scale * meanX };
  };
  const xFit = fitAxis('x', 'x');
  const yFit = fitAxis('y', 'y');
  const bounded = xFit.scale >= 0.75 && xFit.scale <= 1.25 &&
    yFit.scale >= 0.75 && yFit.scale <= 1.25 &&
    Math.abs(xFit.translate) <= 0.18 && Math.abs(yFit.translate) <= 0.18;
  if (!bounded) {
    base.consensus_count = constellationMatches.length;
    base.issues.push('estimated state-constellation transform exceeds bounded scale/translation limits');
    return base;
  }

  const transform = {
    scale_x: xFit.scale,
    scale_y: yFit.scale,
    translate_x: xFit.translate,
    translate_y: yFit.translate,
  };
  const validationPairs = [];
  candidatePoints.forEach((candidate, candidateIndex) => {
    const transformed = {
      x: candidate.geometry.center.x * transform.scale_x + transform.translate_x,
      y: candidate.geometry.center.y * transform.scale_y + transform.translate_y,
    };
    statePoints.forEach((state, stateIndex) => {
      const distance = Math.hypot(transformed.x - state.geometry.center.x,
        transformed.y - state.geometry.center.y);
      const scale = Math.max(candidate.geometry.diagonal, state.geometry.diagonal, 0.04);
      if (distance <= Math.max(0.045, scale * 0.70)) {
        validationPairs.push({ candidateIndex, stateIndex, distance, transformed });
      }
    });
  });
  validationPairs.sort((left, right) => left.distance - right.distance ||
    left.candidateIndex - right.candidateIndex || left.stateIndex - right.stateIndex);
  const validationCandidates = new Set();
  const validationStates = new Set();
  const validationMatches = [];
  validationPairs.forEach(pair => {
    if (validationCandidates.has(pair.candidateIndex) || validationStates.has(pair.stateIndex)) return;
    validationCandidates.add(pair.candidateIndex);
    validationStates.add(pair.stateIndex);
    validationMatches.push(pair);
  });
  const residuals = validationMatches.map(pair => pair.distance);
  const rmsResidual = residuals.length ? Math.sqrt(residuals.reduce((sum, value) =>
    sum + value * value, 0) / residuals.length) : Number.POSITIVE_INFINITY;
  const maxResidual = residuals.length ? Math.max(...residuals) : Number.POSITIVE_INFINITY;
  if (validationMatches.length < requiredConsensus || rmsResidual > 0.035 || maxResidual > 0.065) {
    base.consensus_count = validationMatches.length;
    base.rms_center_residual = Number.isFinite(rmsResidual) ? rmsResidual : null;
    base.max_center_residual = Number.isFinite(maxResidual) ? maxResidual : null;
    base.issues.push('bounded transform failed physical state-center consensus validation');
    return base;
  }
  return {
    ...base,
    applied: true,
    scale_x: transform.scale_x,
    scale_y: transform.scale_y,
    translate_x: transform.translate_x,
    translate_y: transform.translate_y,
    consensus_count: validationMatches.length,
    rms_center_residual: rmsResidual,
    max_center_residual: maxResidual,
    state_correspondences: validationMatches.map(pair => ({
      candidate_id: candidatePoints[pair.candidateIndex].id,
      observation_id: statePoints[pair.stateIndex].id,
      raw_candidate_center: cloneJson(candidatePoints[pair.candidateIndex].geometry.center),
      aligned_candidate_center: cloneJson(pair.transformed),
      final_state_center: cloneJson(statePoints[pair.stateIndex].geometry.center),
      center_residual: pair.distance,
    })),
    issues: [],
  };
}

// Reconcile the blind inventory with the independently reconstructed topology
// by physical location, not merely by equal counts.  This function only emits
// evidence and issues: an unmatched candidate can never manufacture a state or
// connector.
function reconcileTopologyInventoryGeometry(inventory, topology) {
  const stateCandidates = Array.isArray(inventory && inventory.state_circle_candidates)
    ? inventory.state_circle_candidates : [];
  const arrowCandidates = Array.isArray(inventory && inventory.computational_arrowhead_candidates)
    ? inventory.computational_arrowhead_candidates : [];
  const states = Array.isArray(topology && topology.states) ? topology.states : [];
  const transitions = Array.isArray(topology && topology.transitions) ? topology.transitions : [];
  const statesById = new Map(states.map(state => [String(state.observation_id || ''), state]));
  const issues = [];
  const alignment = estimateInventoryConstellationAlignment(stateCandidates, states);
  const alignedCandidateBox = candidate => transformBBoxForReconciliation(candidate && candidate.bbox,
    alignment);

  const matchGeometry = (candidates, objects, candidateBox, objectBox, kind) => {
    const pairs = [];
    candidates.forEach((candidate, candidateIndex) => {
      const candidateGeometry = localizedBoxGeometry(candidateBox(candidate));
      if (!candidateGeometry) return;
      objects.forEach((object, objectIndex) => {
        const objectGeometry = localizedBoxGeometry(objectBox(object));
        if (!objectGeometry) return;
        const centerDistance = Math.hypot(candidateGeometry.center.x - objectGeometry.center.x,
          candidateGeometry.center.y - objectGeometry.center.y);
        const iou = bboxIou(candidateGeometry.box, objectGeometry.box);
        const scale = Math.max(0.01, candidateGeometry.diagonal, objectGeometry.diagonal);
        const normalizedCenterDistance = centerDistance / scale;
        const spatiallyCompatible = kind === 'state'
          ? (iou >= 0.10 || centerDistance <= Math.max(0.035, scale * 0.58))
          : (iou >= 0.04 || centerDistance <= Math.max(0.028, scale * 1.25,
            alignment.applied ? 0.09 : 0));
        if (!spatiallyCompatible) return;
        let orientationPenalty = 0;
        let expectedOrientation = 'UNKNOWN';
        let observedOrientation = 'UNKNOWN';
        if (kind === 'arrowhead') {
          const source = statesById.get(String(object.source_observation_id || ''));
          const target = statesById.get(String(object.target_observation_id || ''));
          expectedOrientation = source && target && source !== target
            ? directionOctant(source.bbox, target.bbox) : 'UNKNOWN';
          observedOrientation = String(candidate && candidate.orientation && candidate.orientation.value ||
            'UNKNOWN').toUpperCase();
          const difference = octantDistance(expectedOrientation, observedOrientation);
          if (difference != null) orientationPenalty = difference * 0.35;
        }
        pairs.push({ candidateIndex, objectIndex, centerDistance, normalizedCenterDistance, iou,
          expectedOrientation, observedOrientation, alignedCandidateBbox: cloneJson(candidateGeometry.box),
          score: normalizedCenterDistance - iou * 1.5 + orientationPenalty });
      });
    });
    pairs.sort((left, right) => left.score - right.score || right.iou - left.iou ||
      left.centerDistance - right.centerDistance || left.candidateIndex - right.candidateIndex ||
      left.objectIndex - right.objectIndex);
    const usedCandidates = new Set();
    const usedObjects = new Set();
    const matches = [];
    pairs.forEach(pair => {
      if (usedCandidates.has(pair.candidateIndex) || usedObjects.has(pair.objectIndex)) return;
      usedCandidates.add(pair.candidateIndex);
      usedObjects.add(pair.objectIndex);
      matches.push(pair);
    });
    return {
      matches,
      unmatchedCandidateIndexes: candidates.map((_, index) => index)
        .filter(index => !usedCandidates.has(index)),
      unmatchedObjectIndexes: objects.map((_, index) => index)
        .filter(index => !usedObjects.has(index)),
    };
  };

  const stateResult = matchGeometry(stateCandidates, states, alignedCandidateBox, row => row.bbox, 'state');
  const stateMatches = stateResult.matches.map(match => ({
    candidate_id: String(stateCandidates[match.candidateIndex].candidate_id || ''),
    observation_id: String(states[match.objectIndex].observation_id || ''),
    raw_candidate_bbox: cloneJson(stateCandidates[match.candidateIndex].bbox),
    aligned_candidate_bbox: cloneJson(match.alignedCandidateBbox),
    final_state_bbox: cloneJson(states[match.objectIndex].bbox),
    bbox_iou: match.iou,
    center_distance: match.centerDistance,
    normalized_center_distance: match.normalizedCenterDistance,
  }));
  stateResult.unmatchedCandidateIndexes.forEach(index => {
    issues.push(`geometric inventory state-circle candidate "${String(stateCandidates[index] &&
      stateCandidates[index].candidate_id || index + 1)}" has no spatial bbox-center/IoU match in final topology; no state was invented`);
  });
  stateResult.unmatchedObjectIndexes.forEach(index => {
    issues.push(`final topology state "${String(states[index] && states[index].observation_id || index + 1)}" has no spatial bbox-center/IoU match in geometric inventory`);
  });

  const arrowResult = matchGeometry(arrowCandidates, transitions, alignedCandidateBox,
    row => row.arrowhead_bbox, 'arrowhead');
  const arrowheadMatches = arrowResult.matches.map(match => {
    const candidate = arrowCandidates[match.candidateIndex];
    const transition = transitions[match.objectIndex];
    const sourceId = String(transition.source_observation_id || '');
    const targetId = String(transition.target_observation_id || '');
    const selfLoop = sourceId && sourceId === targetId;
    const selfLoopHint = String(candidate && candidate.self_loop_hint &&
      candidate.self_loop_hint.value || 'UNKNOWN').toUpperCase();
    const orientationDifference = octantDistance(match.expectedOrientation, match.observedOrientation);
    const matchIssues = [];
    if (orientationDifference != null && orientationDifference > 1) {
      matchIssues.push(`orientation ${match.observedOrientation} conflicts with endpoint direction ${match.expectedOrientation}`);
    }
    if ((selfLoop && selfLoopHint === 'NO') || (!selfLoop && selfLoopHint === 'YES')) {
      matchIssues.push(`self_loop_hint ${selfLoopHint} conflicts with ${selfLoop ? 'self-loop' : 'non-self-loop'} endpoints`);
    }
    matchIssues.forEach(issue => issues.push(`geometric inventory arrowhead candidate "${String(candidate &&
      candidate.candidate_id || match.candidateIndex + 1)}" matched transition "${String(transition &&
      transition.transition_id || match.objectIndex + 1)}" but ${issue}`));
    return {
      candidate_id: String(candidate && candidate.candidate_id || ''),
      transition_id: String(transition && transition.transition_id || ''),
      connector_observation_id: String(transition && transition.connector_observation_id || ''),
      raw_candidate_bbox: cloneJson(candidate && candidate.bbox),
      aligned_candidate_bbox: cloneJson(match.alignedCandidateBbox),
      final_arrowhead_bbox: cloneJson(transition && transition.arrowhead_bbox),
      bbox_iou: match.iou,
      center_distance: match.centerDistance,
      normalized_center_distance: match.normalizedCenterDistance,
      observed_orientation: match.observedOrientation,
      expected_orientation: match.expectedOrientation,
      orientation_octant_distance: orientationDifference,
      self_loop_hint: selfLoopHint,
      issues: matchIssues,
    };
  });
  arrowResult.unmatchedCandidateIndexes.forEach(index => {
    issues.push(`geometric inventory computational-arrowhead candidate "${String(arrowCandidates[index] &&
      arrowCandidates[index].candidate_id || index + 1)}" has no spatial bbox-center/IoU match in final topology; no connector was invented`);
  });
  arrowResult.unmatchedObjectIndexes.forEach(index => {
    issues.push(`final topology transition "${String(transitions[index] &&
      transitions[index].transition_id || index + 1)}" has no spatial bbox-center/IoU arrowhead match in geometric inventory`);
  });

  const uniqueIssues = [...new Set(issues)];
  return {
    alignment,
    state_matches: stateMatches,
    arrowhead_matches: arrowheadMatches,
    unmatched_state_candidate_ids: stateResult.unmatchedCandidateIndexes.map(index =>
      String(stateCandidates[index] && stateCandidates[index].candidate_id || '')),
    unmatched_state_observation_ids: stateResult.unmatchedObjectIndexes.map(index =>
      String(states[index] && states[index].observation_id || '')),
    unmatched_arrowhead_candidate_ids: arrowResult.unmatchedCandidateIndexes.map(index =>
      String(arrowCandidates[index] && arrowCandidates[index].candidate_id || '')),
    unmatched_transition_ids: arrowResult.unmatchedObjectIndexes.map(index =>
      String(transitions[index] && transitions[index].transition_id || '')),
    issues: uniqueIssues,
    review_only: uniqueIssues.length > 0,
  };
}

function bboxCenterDistance(leftValue, rightValue) {
  const left = localizedBoxGeometry(leftValue);
  const right = localizedBoxGeometry(rightValue);
  if (!left || !right) return Number.POSITIVE_INFINITY;
  return Math.hypot(left.center.x - right.center.x, left.center.y - right.center.y);
}

function bboxContainsBox(outerValue, innerValue, tolerance = 0.002) {
  const outer = localizedBoxGeometry(outerValue);
  const inner = localizedBoxGeometry(innerValue);
  if (!outer || !inner) return false;
  return inner.box.x >= outer.box.x - tolerance &&
    inner.box.y >= outer.box.y - tolerance &&
    inner.box.x + inner.box.w <= outer.box.x + outer.box.w + tolerance &&
    inner.box.y + inner.box.h <= outer.box.y + outer.box.h + tolerance;
}

function mapCropLocalBoxToOriginal(localValue, originalCropValue) {
  const local = localizedBoxGeometry(localValue);
  const crop = localizedBoxGeometry(originalCropValue);
  if (!local || !crop) return null;
  return {
    x: crop.box.x + local.box.x * crop.box.w,
    y: crop.box.y + local.box.y * crop.box.h,
    w: local.box.w * crop.box.w,
    h: local.box.h * crop.box.h,
  };
}

function cropContainmentMargin(originalCropValue, containedValue) {
  const crop = localizedBoxGeometry(originalCropValue);
  const contained = localizedBoxGeometry(containedValue);
  if (!crop || !contained || !bboxContainsBox(crop.box, contained.box)) {
    return Number.NEGATIVE_INFINITY;
  }
  return Math.min(
    contained.box.x - crop.box.x,
    contained.box.y - crop.box.y,
    crop.box.x + crop.box.w - contained.box.x - contained.box.w,
    crop.box.y + crop.box.h - contained.box.y - contained.box.h,
  ) / Math.max(1e-9, Math.hypot(crop.box.w, crop.box.h));
}

function bboxesNearlyEqual(leftValue, rightValue, tolerance = 1e-6) {
  const left = localizedBoxGeometry(leftValue);
  const right = localizedBoxGeometry(rightValue);
  if (!left || !right) return false;
  return ['x', 'y', 'w', 'h'].every(key =>
    Math.abs(left.box[key] - right.box[key]) <= tolerance);
}

function validateTargetedTraceTileMapping(tile, rawMatches) {
  const issues = [];
  const raws = Array.isArray(rawMatches) ? rawMatches : [];
  if (!tile || tile.kind !== 'topology_tile') issues.push('tile kind is not topology_tile');
  if (!tile || tile.scan_incomplete) issues.push('normalized topology tile is incomplete');
  if (raws.length !== 1) issues.push(`tile has ${raws.length} raw crop records instead of exactly one`);
  const raw = raws.length === 1 ? raws[0] : null;
  if (!raw || String(raw.kind || '') !== 'topology_tile') issues.push('raw crop kind is not topology_tile');
  if (!raw || String(raw.image_role || '') !== 'original_same_frame_crop') {
    issues.push('tile image_role does not prove derivation from original_same_frame');
  }
  if (!raw || !String(raw.image_url || '').trim()) issues.push('tile image pixels are missing');
  const rawOriginal = normalizeLineBbox(raw && raw.original_bbox);
  const rawCrop = normalizeLineBbox(raw && raw.crop_bbox);
  const rawSource = normalizeLineBbox(raw && raw.source_bbox);
  if (!rawOriginal.localized) issues.push('raw tile original_bbox is missing or malformed');
  if (!rawCrop.localized) issues.push('raw tile crop_bbox is missing or malformed');
  if (!rawSource.localized) issues.push('raw tile source_bbox is missing or malformed');
  if (rawOriginal.localized && rawCrop.localized && !bboxesNearlyEqual(rawOriginal.box, rawCrop.box)) {
    issues.push('tile crop_bbox is inconsistent with original_bbox for a zero-padding topology audit tile');
  }
  if (rawOriginal.localized && rawSource.localized && !bboxesNearlyEqual(rawOriginal.box, rawSource.box)) {
    issues.push('tile source_bbox is inconsistent with original_bbox');
  }
  if (rawOriginal.localized && tile && !bboxesNearlyEqual(rawOriginal.box, tile.original_bbox)) {
    issues.push('raw and normalized tile original_bbox mappings disagree');
  }
  if (rawCrop.localized && tile && !bboxesNearlyEqual(rawCrop.box, tile.crop_bbox)) {
    issues.push('raw and normalized tile crop_bbox mappings disagree');
  }
  const originalSize = raw && raw.original_size;
  const width = Number(originalSize && originalSize.width);
  const height = Number(originalSize && originalSize.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 ||
    width > 100000 || height > 100000) {
    issues.push('tile original_size is missing, malformed, or implausible');
  }
  if (!tile || !tile.original_size) issues.push('normalized tile original_size is missing');
  else if (Number(tile.original_size.width) !== width || Number(tile.original_size.height) !== height) {
    issues.push('raw and normalized tile original_size mappings disagree');
  }
  const tileIndex = Number(raw && raw.tile_index);
  if (!Number.isInteger(tileIndex) || tileIndex < 0 || !tile || tile.tile_index !== tileIndex) {
    issues.push('tile_index provenance is missing or inconsistent');
  }
  return {
    valid: issues.length === 0,
    issues: [...new Set(issues)],
    crop_id: String(tile && tile.crop_id || raw && raw.crop_id || '').trim(),
    original_bbox: rawOriginal.box,
    crop_bbox: rawCrop.box,
    source_bbox: rawSource.box,
    original_size: Number.isInteger(width) && Number.isInteger(height) ? { width, height } : null,
    image_role: String(raw && raw.image_role || ''),
    image_url: String(raw && raw.image_url || ''),
  };
}

// A targeted trace may inspect only an already-unmatched inventory arrowhead,
// the full original frame, and an existing mapped topology tile that contains
// the aligned candidate.  The plan retains request URLs only in private fields;
// its public evidence is safe to persist in the audit envelope.
function planTopologyTargetedTrace(topologyAuditEnvelope, fullUrls, fullRoles, cropRows, tileManifest) {
  const topology = topologyAuditEnvelope && topologyAuditEnvelope.topology || {};
  const audit = topologyAuditEnvelope && topologyAuditEnvelope.topology_audit || {};
  const reconciliation = audit.inventory_reconciliation || {};
  const inventory = audit.geometric_inventory || {};
  const unmatchedIds = [...new Set((Array.isArray(reconciliation.unmatched_arrowhead_candidate_ids)
    ? reconciliation.unmatched_arrowhead_candidate_ids : []).map(value => String(value || '').trim())
    .filter(Boolean))];
  const issues = [];
  const unresolved = [];
  const fullImages = (Array.isArray(fullUrls) ? fullUrls : []).map((url, index) => ({
    url,
    role: String((Array.isArray(fullRoles) ? fullRoles[index] : '') || '').trim().toLowerCase(),
    index,
  })).filter(row => row.url && row.role === 'original_same_frame');
  if (unmatchedIds.length && !fullImages.length) {
    issues.push('targeted trace requires an explicit original_same_frame image');
  }

  const candidatesById = new Map();
  (Array.isArray(inventory.computational_arrowhead_candidates)
    ? inventory.computational_arrowhead_candidates : []).filter(Boolean).forEach(candidate => {
    const id = String(candidate.candidate_id || '').trim();
    const rows = candidatesById.get(id) || [];
    rows.push(candidate);
    candidatesById.set(id, rows);
  });
  const rawCropsById = new Map();
  (Array.isArray(cropRows) ? cropRows : []).filter(Boolean).forEach(crop => {
    const id = String(crop.crop_id || '').trim();
    const rows = rawCropsById.get(id) || [];
    rows.push(crop);
    rawCropsById.set(id, rows);
  });
  const tileMappingAudits = (Array.isArray(tileManifest) ? tileManifest : []).map(tile => {
    const cropId = String(tile && tile.crop_id || '').trim();
    const validation = validateTargetedTraceTileMapping(tile, rawCropsById.get(cropId) || []);
    return { ...validation, crop_id: cropId };
  });
  const usableTiles = tileMappingAudits.filter(row => row.valid).map(row => ({
    crop_id: row.crop_id,
    original_bbox: cloneJson(row.original_bbox),
    crop_bbox: cloneJson(row.crop_bbox),
    source_bbox: cloneJson(row.source_bbox),
    original_size: cloneJson(row.original_size, null),
    image_role: row.image_role,
    source_image_role: 'original_same_frame',
    mapping_verified: true,
    image_url: row.image_url,
  }));
  const rejectedTileMappings = tileMappingAudits.filter(row => !row.valid).map(row => ({
    crop_id: row.crop_id,
    issues: cloneJson(row.issues, []),
  }));

  const alignment = reconciliation.alignment || null;
  const candidateManifest = [];
  unmatchedIds.forEach(candidateId => {
    const matches = candidatesById.get(candidateId) || [];
    if (matches.length !== 1) {
      const issue = matches.length
        ? `unmatched targeted-trace candidate_id "${candidateId}" is duplicated in geometric inventory`
        : `unmatched targeted-trace candidate_id "${candidateId}" is absent from geometric inventory`;
      issues.push(issue);
      unresolved.push({ candidate_id: candidateId, issues: [issue] });
      return;
    }
    const candidate = matches[0];
    const alignedBbox = transformBBoxForReconciliation(candidate.bbox, alignment);
    if (!localizedBoxGeometry(alignedBbox)) {
      const issue = `unmatched targeted-trace candidate "${candidateId}" has no localized aligned bbox`;
      issues.push(issue);
      unresolved.push({ candidate_id: candidateId, raw_candidate_bbox: cloneJson(candidate.bbox), issues: [issue] });
      return;
    }
    const containingTiles = usableTiles.map(tile => ({
      tile,
      margin: cropContainmentMargin(tile.original_bbox, alignedBbox),
    })).filter(row => Number.isFinite(row.margin)).sort((left, right) =>
      right.margin - left.margin || left.tile.crop_id.localeCompare(right.tile.crop_id));
    if (!containingTiles.length) {
      const issue = rejectedTileMappings.length && !usableTiles.length
        ? `unmatched targeted-trace candidate "${candidateId}" has no provenance-validated topology tile; ${rejectedTileMappings.length} mapped tile(s) were rejected`
        : `unmatched targeted-trace candidate "${candidateId}" has no existing provenance-validated topology tile containing its aligned bbox`;
      issues.push(issue);
      unresolved.push({ candidate_id: candidateId, raw_candidate_bbox: cloneJson(candidate.bbox),
        aligned_candidate_bbox: cloneJson(alignedBbox), issues: [issue] });
      return;
    }
    const selectedTile = containingTiles[0].tile;
    candidateManifest.push({
      candidate_id: candidateId,
      raw_candidate_bbox: cloneJson(candidate.bbox),
      aligned_candidate_bbox: cloneJson(alignedBbox),
      alignment_validated: Boolean(alignment && alignment.applied &&
        Number(alignment.consensus_count) >= Number(alignment.required_consensus_count) &&
        !stringIssues(alignment.issues).length),
      inventory_orientation: cloneJson(candidate.orientation),
      inventory_self_loop_hint: cloneJson(candidate.self_loop_hint),
      inventory_confidence: Number(candidate.confidence),
      allowed_evidence_crop_ids: [selectedTile.crop_id],
    });
  });

  const selectedCropIds = [...new Set(candidateManifest.flatMap(row => row.allowed_evidence_crop_ids))];
  const selectedTiles = usableTiles.filter(tile => selectedCropIds.includes(tile.crop_id));
  const stateAliasMap = [];
  const stateAliasByObservationId = new Map();
  const states = (Array.isArray(topology.states) ? topology.states : []).filter(Boolean).map((state, index) => {
    const observationId = String(state.observation_id || '');
    const observationRef = `state_ref_${String(index + 1).padStart(3, '0')}`;
    stateAliasMap.push({ observation_ref: observationRef, observation_id: observationId });
    stateAliasByObservationId.set(observationId, observationRef);
    return { observation_ref: observationRef, bbox: cloneJson(state.bbox) };
  });
  const transitionAliasMap = [];
  const transitions = (Array.isArray(topology.transitions) ? topology.transitions : []).filter(Boolean)
    .map((transition, index) => {
      const transitionId = String(transition.transition_id || '');
      const transitionRef = `transition_ref_${String(index + 1).padStart(3, '0')}`;
      transitionAliasMap.push({ transition_ref: transitionRef, transition_id: transitionId });
      return {
        transition_ref: transitionRef,
        connector_ref: `connector_ref_${String(index + 1).padStart(3, '0')}`,
        source_observation_ref: stateAliasByObservationId.get(
          String(transition.source_observation_id || '')) || '',
        target_observation_ref: stateAliasByObservationId.get(
          String(transition.target_observation_id || '')) || '',
        connector_bbox: cloneJson(transition.connector_bbox),
        arrowhead_bbox: cloneJson(transition.arrowhead_bbox),
      };
    });
  const publicTiles = selectedTiles.map(tile => ({
    crop_id: tile.crop_id,
    original_bbox: cloneJson(tile.original_bbox),
    crop_bbox: cloneJson(tile.crop_bbox),
    source_bbox: cloneJson(tile.source_bbox),
    original_size: cloneJson(tile.original_size, null),
    image_role: tile.image_role,
    source_image_role: tile.source_image_role,
    mapping_verified: tile.mapping_verified,
  }));
  const requestUrls = fullImages.slice(0, 1).map(row => row.url)
    .concat(selectedTiles.map(tile => tile.image_url));
  const requestCaptions = fullImages.slice(0, 1).map(() => 'FULL IMAGE ROLE: original_same_frame')
    .concat(selectedTiles.map((tile, index) =>
      `TARGETED TRACE TILE ${index + 1}: crop_id=${tile.crop_id}; original_bbox=${JSON.stringify(tile.original_bbox)}`));
  return {
    has_unmatched: unmatchedIds.length > 0,
    should_call: unmatchedIds.length > 0 && fullImages.length > 0 && candidateManifest.length > 0,
    requested_candidate_ids: unmatchedIds,
    candidate_manifest: candidateManifest,
    state_manifest: states,
    state_alias_map: stateAliasMap,
    existing_transition_manifest: transitions,
    transition_alias_map: transitionAliasMap,
    tile_manifest: publicTiles,
    rejected_tile_mappings: rejectedTileMappings,
    unresolved_connector_candidates: unresolved,
    issues: [...new Set(issues)],
    request_urls: requestUrls,
    request_captions: requestCaptions,
  };
}

function buildTopologyTargetedTracePrompt(plan, modelType) {
  const publicPlan = plan || {};
  return [
    'TARGETED UNMATCHED-ARROWHEAD TRACE — PIXELS AND GEOMETRY ONLY, NO OCR. Trace only the supplied unmatched physical arrowhead candidates. This pass does not create topology and may not invent a candidate, state, endpoint, connector, label, or identifier.',
    `MODEL TYPE CONTEXT (geometry only): ${String(modelType || 'pda').trim().toLowerCase()}. It never authorizes language, label, or expected-automaton reasoning.`,
    `UNMATCHED CANDIDATE MANIFEST: ${JSON.stringify(publicPlan.candidate_manifest || [])}. Emit exactly one candidate_traces row for every supplied candidate_id and no foreign or duplicate id.`,
    `CALL-LOCAL STATE GEOMETRY MANIFEST: ${JSON.stringify(publicPlan.state_manifest || [])}. The observation_ref values are opaque aliases valid only in this call. Put only those aliases in source_observation_id and target_observation_id; never infer or emit a visible state label or any identifier not present here.`,
    `CALL-LOCAL EXISTING CONNECTOR MANIFEST: ${JSON.stringify(publicPlan.existing_transition_manifest || [])}. MATCHES_EXISTING requires exactly one transition_ref copied into existing_transition_id. VERIFIED_OMITTED must leave existing_transition_id empty. These aliases reveal no stored topology identity.`,
    `EVIDENCE TILE MANIFEST: ${JSON.stringify(publicPlan.tile_manifest || [])}. evidence_crop_id must be one of the candidate's allowed_evidence_crop_ids. Every returned bbox is normalized 0..1 in that crop's LOCAL pixel frame, never in the original frame.`,
    'For each candidate, inspect the full original_same_frame first and then its permitted tile. Begin at the visible arrowhead tip and physically follow the same continuous connector stroke backward. Do not bridge a gap, notebook ruling, neighbouring connector, label ink, or scribble by assumption.',
    'verdict is MATCHES_EXISTING only if the traced ink is the same physical connector as one supplied existing transition; VERIFIED_OMITTED only if a complete continuous computational connector and both physical endpoint contacts are visible but absent from the existing connector manifest; NOT_ARROWHEAD only when the candidate ink is visibly not an arrowhead; START_MARKER only when it visibly comes from empty space and has no source state; otherwise UNCERTAIN.',
    'trace_status COMPLETE requires a continuous trace from arrowhead through connector to all endpoint contacts. Use PARTIAL for a broken/occluded trace and AMBIGUOUS when strokes cross, branch, overlap, or ownership cannot be determined. Never upgrade a partial trace because a connector would be expected. VERIFIED_OMITTED is impossible when either endpoint boundary lies outside the selected tile: the full frame is context, but crop-local connector/contact geometry cannot prove a long cross-tile connector.',
    'arrowhead_bbox_in_crop encloses the supplied arrowhead ink. connector_bbox_in_crop encloses the entire traced stroke. tail_contact_bbox_in_crop encloses the source-side contact point and must be spatially distinct from the arrowhead contact for a self-loop. Use {-1,-1,-1,-1} for a bbox that cannot be localized.',
    'orientation.value is the arrowhead direction N, NE, E, SE, S, SW, W, NW, or UNKNOWN. self_loop.value is YES only when the same stroke visibly leaves and re-enters one state, NO only when distinct endpoint geometry is complete, otherwise UNKNOWN. Report confidences independently and preserve every uncertainty in issues.',
    'Regular notebook ruling is background. Lack of an understood role is never proof of scribble. Return only the strict JSON; no prose and no semantic labels.',
  ].join('\n');
}

function targetedTraceUniqueId(prefix, existingIds) {
  let index = 1;
  while (existingIds.has(`${prefix}_${index}`)) index += 1;
  const id = `${prefix}_${index}`;
  existingIds.add(id);
  return id;
}

function normalizeTraceConfidence(value, name, issues) {
  const confidence = Number(value);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    issues.push(`${name} is missing or malformed`);
    return 0;
  }
  return confidence;
}

function traceBoxNearExpected(actual, expected) {
  const actualGeometry = localizedBoxGeometry(actual);
  const expectedGeometry = localizedBoxGeometry(expected);
  if (!actualGeometry || !expectedGeometry) return false;
  const distance = bboxCenterDistance(actualGeometry.box, expectedGeometry.box);
  const scale = Math.max(actualGeometry.diagonal, expectedGeometry.diagonal, 0.012);
  return bboxIou(actualGeometry.box, expectedGeometry.box) >= 0.04 ||
    distance <= Math.max(0.018, scale * 1.15);
}

function stateBoundaryAnnulusContact(contactValue, stateValue) {
  const contact = localizedBoxGeometry(contactValue);
  const state = localizedBoxGeometry(stateValue);
  if (!contact || !state) return { valid: false, reason: 'contact or state bbox is unlocalized' };
  if (contact.box.w > state.box.w * 0.45 || contact.box.h > state.box.h * 0.45 ||
    contact.box.w * contact.box.h > state.box.w * state.box.h * 0.14) {
    return { valid: false, reason: 'contact bbox is too large to localize one state-boundary contact' };
  }
  const radiusX = state.box.w / 2;
  const radiusY = state.box.h / 2;
  const centerX = state.center.x;
  const centerY = state.center.y;
  const xs = [contact.box.x, contact.box.x + contact.box.w / 2, contact.box.x + contact.box.w];
  const ys = [contact.box.y, contact.box.y + contact.box.h / 2, contact.box.y + contact.box.h];
  const radii = [];
  xs.forEach(x => ys.forEach(y => radii.push(Math.hypot(
    (x - centerX) / Math.max(1e-9, radiusX),
    (y - centerY) / Math.max(1e-9, radiusY),
  ))));
  const minRadius = Math.min(...radii);
  const maxRadius = Math.max(...radii);
  // A contact box must actually reach the drawn state boundary.  Merely being
  // somewhere in the outer half of the state is not enough: that loophole let
  // two arbitrary boxes wholly inside a state masquerade as loop contacts.
  // Requiring the sampled box to reach radius 1 is the fail-closed distinction
  // between boundary evidence and a box wholly inside the state.  Detector
  // tolerance is supplied on the outside of the annulus, never by accepting
  // deep/interior boxes as contacts.
  const valid = minRadius <= 1.18 && maxRadius >= 1;
  return {
    valid,
    min_normalized_radius: minRadius,
    max_normalized_radius: maxRadius,
    reason: valid ? '' : (maxRadius < 1
      ? 'contact bbox lies wholly in the deep state interior'
      : 'contact bbox does not intersect the narrow state-boundary annulus'),
  };
}

function connectorExtentAudit(connectorValue, arrowValue, tailValue, sourceValue, targetValue, selfLoop) {
  const connector = localizedBoxGeometry(connectorValue);
  const arrow = localizedBoxGeometry(arrowValue);
  const tail = localizedBoxGeometry(tailValue);
  const source = localizedBoxGeometry(sourceValue);
  const target = localizedBoxGeometry(targetValue);
  const issues = [];
  if (!connector || !arrow || !tail || !source || !target) {
    issues.push('connector extent audit requires complete localized geometry');
    return { valid: false, issues };
  }
  const connectorArea = connector.box.w * connector.box.h;
  if (connectorArea > 0.45 || connector.box.w > 0.98 || connector.box.h > 0.98 ||
    connector.diagonal > 1.15) {
    issues.push('connector bbox is implausibly large or effectively full-frame');
  }
  const contactSeparation = bboxCenterDistance(arrow.box, tail.box);
  const minimumExtent = Math.max(0.018, contactSeparation * 0.85,
    arrow.diagonal * 1.4, tail.diagonal * 1.4);
  if (connector.diagonal < minimumExtent || connectorArea < 1e-5) {
    issues.push('connector bbox has degenerate extent for its two contacts');
  }
  if (bboxEdgeDistance(arrow.box, connector.box) > 0.012 ||
    bboxEdgeDistance(tail.box, connector.box) > 0.012) {
    issues.push('arrowhead or tail contact is detached from the connector extent');
  }
  if (selfLoop) {
    const minimumContactSeparation = Math.max(0.012, source.diagonal * 0.12);
    if (contactSeparation < minimumContactSeparation) {
      issues.push('self-loop contacts are not sufficiently separated on the state boundary');
    }
    const stateArea = source.box.w * source.box.h;
    const relativeWidth = connector.box.w / Math.max(1e-9, source.box.w);
    const relativeHeight = connector.box.h / Math.max(1e-9, source.box.h);
    const relativeArea = connectorArea / Math.max(1e-9, stateArea);
    const relativeCenterDistance = Math.hypot(
      connector.center.x - source.center.x,
      connector.center.y - source.center.y,
    ) / Math.max(1e-9, source.diagonal);
    // A loop is local geometry around one state.  Global 0..1 limits alone
    // allowed a near-full-frame stripe to pass whenever the state itself was
    // small.  Bound every independent extent against that state as well.
    if (relativeWidth > 2.75 || relativeHeight > 2.75 || relativeArea > 4.5 ||
      relativeCenterDistance > 1.4) {
      issues.push('self-loop connector extent or protrusion is implausibly large relative to its state');
    }
    const protrusions = [
      source.box.x - connector.box.x,
      source.box.y - connector.box.y,
      connector.box.x + connector.box.w - source.box.x - source.box.w,
      connector.box.y + connector.box.h - source.box.y - source.box.h,
    ].map(value => Math.max(0, value));
    if (Math.max(...protrusions) < Math.max(0.008, source.diagonal * 0.04)) {
      issues.push('self-loop connector does not visibly exit and re-enter beyond the state boundary');
    }
  }
  return { valid: issues.length === 0, issues: [...new Set(issues)], contact_separation: contactSeparation };
}

// Apply a trace result only after deterministic id, crop-mapping, contact,
// direction, and duplicate checks.  Even the one addable verdict yields a
// provisional review-only connector; it is never executable scan output.
function applyTopologyTargetedTrace(topologyAuditEnvelope, traceValue, sessionValue, metadata = {}) {
  const session = scanSessionId(sessionValue || (topologyAuditEnvelope && topologyAuditEnvelope.scan_session_id));
  const result = cloneJson(topologyAuditEnvelope, {});
  const topology = cloneJson(result.topology, {});
  const preTraceTopology = cloneJson(topology, {});
  const plan = metadata.plan || {};
  const attempted = Boolean(metadata.attempted);
  const errorText = metadata.error == null ? ''
    : String(metadata.error && metadata.error.message || metadata.error).slice(0, 240);
  const failed = attempted && (Boolean(errorText) || traceValue == null);
  const topIssues = [...stringIssues(traceValue && traceValue.issues)];
  const unresolved = cloneJson(plan.unresolved_connector_candidates, []);
  const candidateManifest = Array.isArray(plan.candidate_manifest) ? plan.candidate_manifest : [];
  const requestedIds = new Set((Array.isArray(plan.requested_candidate_ids)
    ? plan.requested_candidate_ids : []).map(value => String(value || '').trim()).filter(Boolean));
  const currentUnmatchedIds = new Set((Array.isArray(result.topology_audit &&
    result.topology_audit.inventory_reconciliation &&
    result.topology_audit.inventory_reconciliation.unmatched_arrowhead_candidate_ids)
    ? result.topology_audit.inventory_reconciliation.unmatched_arrowhead_candidate_ids : [])
    .map(value => String(value || '').trim()).filter(Boolean));
  const currentAlignment = result.topology_audit && result.topology_audit.inventory_reconciliation &&
    result.topology_audit.inventory_reconciliation.alignment;
  const currentAlignmentValidated = Boolean(currentAlignment && currentAlignment.applied &&
    Number(currentAlignment.consensus_count) >= Number(currentAlignment.required_consensus_count) &&
    !stringIssues(currentAlignment.issues).length);
  const candidateById = new Map(candidateManifest.map(row => [String(row.candidate_id || ''), row]));
  const tileById = new Map((Array.isArray(plan.tile_manifest) ? plan.tile_manifest : [])
    .map(row => [String(row.crop_id || ''), row]));
  const stateAliasToId = new Map((Array.isArray(plan.state_alias_map) ? plan.state_alias_map : [])
    .map(row => [String(row && row.observation_ref || ''), String(row && row.observation_id || '')]));
  const transitionAliasToId = new Map((Array.isArray(plan.transition_alias_map)
    ? plan.transition_alias_map : []).map(row =>
    [String(row && row.transition_ref || ''), String(row && row.transition_id || '')]));
  const states = Array.isArray(topology.states) ? topology.states : [];
  const statesById = new Map();
  states.forEach(state => {
    const id = String(state && state.observation_id || '').trim();
    const rows = statesById.get(id) || [];
    rows.push(state);
    statesById.set(id, rows);
  });
  const transitions = Array.isArray(topology.transitions) ? topology.transitions : [];
  const transitionById = new Map();
  transitions.forEach(transition => {
    const id = String(transition && transition.transition_id || '').trim();
    const rows = transitionById.get(id) || [];
    rows.push(transition);
    transitionById.set(id, rows);
  });
  if (failed) {
    topIssues.push(`targeted unmatched-arrowhead trace failed; no connector was added${errorText ? `: ${errorText}` : ''}`);
    candidateManifest.forEach(candidate => unresolved.push({
      candidate_id: String(candidate.candidate_id || ''),
      aligned_candidate_bbox: cloneJson(candidate.aligned_candidate_bbox),
      issues: ['targeted trace produced no usable evidence because its Vision call failed'],
    }));
  } else if (plan.has_unmatched && !attempted) {
    topIssues.push(...stringIssues(plan.issues));
    candidateManifest.forEach(candidate => {
      const candidateId = String(candidate.candidate_id || '');
      if (unresolved.some(row => String(row && row.candidate_id || '') === candidateId)) return;
      unresolved.push({
        candidate_id: candidateId,
        aligned_candidate_bbox: cloneJson(candidate.aligned_candidate_bbox),
        issues: ['targeted trace was skipped because its required full-original or mapped-tile evidence was unavailable'],
      });
    });
    if (!candidateManifest.length && !unresolved.length) {
      topIssues.push('targeted trace was skipped because no unmatched candidate had complete mapped image evidence');
    }
  }

  const allowedVerdicts = new Set(['MATCHES_EXISTING', 'VERIFIED_OMITTED', 'NOT_ARROWHEAD',
    'START_MARKER', 'UNCERTAIN']);
  const allowedStatuses = new Set(['COMPLETE', 'PARTIAL', 'AMBIGUOUS']);
  const allowedOrientations = new Set(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'UNKNOWN']);
  const allowedSelfLoop = new Set(['YES', 'NO', 'UNKNOWN']);
  const rawRows = !failed && traceValue && Array.isArray(traceValue.candidate_traces)
    ? traceValue.candidate_traces.filter(Boolean) : [];
  const normalizedRows = rawRows.map(raw => {
    const issues = stringIssues(raw.issues);
    const structuralIssues = [];
    const addIssue = issue => { issues.push(issue); structuralIssues.push(issue); };
    const candidateId = String(raw.candidate_id || '').trim();
    const candidate = candidateById.get(candidateId);
    if (!candidateId || !requestedIds.has(candidateId) || !currentUnmatchedIds.has(candidateId) || !candidate) {
      addIssue(`foreign or ineligible targeted-trace candidate_id "${candidateId || '?'}"`);
    }
    const verdict = String(raw.verdict || '').trim().toUpperCase();
    if (!allowedVerdicts.has(verdict)) addIssue(`unknown targeted-trace verdict "${verdict || '?'}"`);
    const traceStatus = String(raw.trace_status || '').trim().toUpperCase();
    if (!allowedStatuses.has(traceStatus)) addIssue(`unknown targeted-trace trace_status "${traceStatus || '?'}"`);
    const cropId = String(raw.evidence_crop_id || '').trim();
    const tile = tileById.get(cropId);
    if (!tile || !candidate || !(candidate.allowed_evidence_crop_ids || []).includes(cropId)) {
      addIssue(`foreign or unauthorized targeted-trace evidence_crop_id "${cropId || '?'}"`);
    }
    const tileSize = tile && tile.original_size;
    const tileMappingTrustworthy = Boolean(tile && tile.mapping_verified === true &&
      tile.image_role === 'original_same_frame_crop' && tile.source_image_role === 'original_same_frame' &&
      bboxesNearlyEqual(tile.original_bbox, tile.crop_bbox) &&
      bboxesNearlyEqual(tile.original_bbox, tile.source_bbox) &&
      Number.isInteger(Number(tileSize && tileSize.width)) && Number(tileSize && tileSize.width) > 0 &&
      Number(tileSize && tileSize.width) <= 100000 &&
      Number.isInteger(Number(tileSize && tileSize.height)) && Number(tileSize && tileSize.height) > 0 &&
      Number(tileSize && tileSize.height) <= 100000);
    if (tile && !tileMappingTrustworthy) {
      addIssue('targeted-trace crop mapping metadata is missing, stale, or inconsistent');
    }
    const arrowLocalIssues = [];
    const connectorLocalIssues = [];
    const tailLocalIssues = [];
    const arrowLocal = evidenceBox(raw.arrowhead_bbox_in_crop,
      'targeted-trace crop-local arrowhead bbox', arrowLocalIssues);
    const connectorLocal = evidenceBox(raw.connector_bbox_in_crop,
      'targeted-trace crop-local connector bbox', connectorLocalIssues);
    const tailLocal = evidenceBox(raw.tail_contact_bbox_in_crop,
      'targeted-trace crop-local tail-contact bbox', tailLocalIssues);
    arrowLocalIssues.forEach(addIssue);
    if (verdict === 'MATCHES_EXISTING' || verdict === 'VERIFIED_OMITTED' ||
      verdict === 'START_MARKER') {
      [...connectorLocalIssues, ...tailLocalIssues].forEach(addIssue);
    }
    const arrowOriginal = tileMappingTrustworthy
      ? mapCropLocalBoxToOriginal(arrowLocal, tile.original_bbox) : null;
    const connectorOriginal = tileMappingTrustworthy
      ? mapCropLocalBoxToOriginal(connectorLocal, tile.original_bbox) : null;
    const tailOriginal = tileMappingTrustworthy
      ? mapCropLocalBoxToOriginal(tailLocal, tile.original_bbox) : null;
    const sourceAlias = String(raw.source_observation_id || '').trim();
    const targetAlias = String(raw.target_observation_id || '').trim();
    const existingTransitionAlias = String(raw.existing_transition_id || '').trim();
    const sourceId = sourceAlias ? String(stateAliasToId.get(sourceAlias) || '') : '';
    const targetId = targetAlias ? String(stateAliasToId.get(targetAlias) || '') : '';
    const existingTransitionId = existingTransitionAlias
      ? String(transitionAliasToId.get(existingTransitionAlias) || '') : '';
    if (sourceAlias && !sourceId) addIssue(`foreign targeted-trace source observation alias "${sourceAlias}"`);
    if (targetAlias && !targetId) addIssue(`foreign targeted-trace target observation alias "${targetAlias}"`);
    if (existingTransitionAlias && !existingTransitionId) {
      addIssue(`foreign targeted-trace existing transition alias "${existingTransitionAlias}"`);
    }
    const orientationValue = String(raw.orientation && raw.orientation.value || '').trim().toUpperCase();
    if (!allowedOrientations.has(orientationValue)) addIssue(`unknown targeted-trace orientation "${orientationValue || '?'}"`);
    const selfLoopValue = String(raw.self_loop && raw.self_loop.value || '').trim().toUpperCase();
    if (!allowedSelfLoop.has(selfLoopValue)) addIssue(`unknown targeted-trace self_loop "${selfLoopValue || '?'}"`);
    const candidateConfidence = normalizeTraceConfidence(raw.candidate_confidence,
      'targeted-trace candidate_confidence', structuralIssues);
    const endpointConfidence = normalizeTraceConfidence(raw.endpoint_confidence,
      'targeted-trace endpoint_confidence', structuralIssues);
    const connectorConfidence = normalizeTraceConfidence(raw.connector_confidence,
      'targeted-trace connector_confidence', structuralIssues);
    const orientationConfidence = normalizeTraceConfidence(raw.orientation && raw.orientation.confidence,
      'targeted-trace orientation.confidence', structuralIssues);
    const selfLoopConfidence = normalizeTraceConfidence(raw.self_loop && raw.self_loop.confidence,
      'targeted-trace self_loop.confidence', structuralIssues);
    structuralIssues.forEach(issue => { if (!issues.includes(issue)) issues.push(issue); });
    if (candidate && arrowOriginal && !traceBoxNearExpected(arrowOriginal, candidate.aligned_candidate_bbox)) {
      addIssue('mapped targeted-trace arrowhead bbox is not spatially aligned with the unmatched inventory candidate');
    }
    return {
      candidate_id: candidateId,
      verdict,
      evidence_crop_id: cropId,
      arrowhead_bbox_in_crop: arrowLocal,
      connector_bbox_in_crop: connectorLocal,
      tail_contact_bbox_in_crop: tailLocal,
      arrowhead_bbox_original: arrowOriginal || { x: -1, y: -1, w: -1, h: -1 },
      connector_bbox_original: connectorOriginal || { x: -1, y: -1, w: -1, h: -1 },
      tail_contact_bbox_original: tailOriginal || { x: -1, y: -1, w: -1, h: -1 },
      trace_status: traceStatus,
      source_observation_alias: sourceAlias,
      target_observation_alias: targetAlias,
      source_observation_id: sourceId,
      target_observation_id: targetId,
      existing_transition_alias: existingTransitionAlias,
      existing_transition_id: existingTransitionId,
      orientation: { value: allowedOrientations.has(orientationValue) ? orientationValue : 'UNKNOWN',
        confidence: orientationConfidence },
      self_loop: { value: allowedSelfLoop.has(selfLoopValue) ? selfLoopValue : 'UNKNOWN',
        confidence: selfLoopConfidence },
      candidate_confidence: candidateConfidence,
      endpoint_confidence: endpointConfidence,
      connector_confidence: connectorConfidence,
      model_issues: stringIssues(raw.issues),
      issues,
      structural_issues: [...new Set(structuralIssues)],
      added_provisional_connector: false,
      disposition: 'unresolved',
    };
  });

  const rowsByCandidate = new Map();
  normalizedRows.forEach(row => {
    const rows = rowsByCandidate.get(row.candidate_id) || [];
    rows.push(row);
    rowsByCandidate.set(row.candidate_id, rows);
  });
  rowsByCandidate.forEach((rows, candidateId) => {
    if (!candidateId || rows.length < 2) return;
    const issue = `duplicate targeted-trace rows for candidate_id "${candidateId}"`;
    topIssues.push(issue);
    rows.forEach(row => {
      row.issues = [...new Set([...row.issues, issue])];
      row.structural_issues = [...new Set([...row.structural_issues, issue])];
    });
  });
  const atomicStructuralIssues = [];
  stringIssues(plan.issues).forEach(issue => atomicStructuralIssues.push(`targeted-trace plan: ${issue}`));
  stringIssues(traceValue && traceValue.issues).forEach(issue =>
    atomicStructuralIssues.push(`targeted-trace global issue: ${issue}`));
  if (attempted && !failed && rawRows.length !== candidateManifest.length) {
    atomicStructuralIssues.push(`targeted trace returned ${rawRows.length} rows for ${candidateManifest.length} planned candidates`);
  }
  normalizedRows.forEach(row => (row.structural_issues || []).forEach(issue =>
    atomicStructuralIssues.push(`candidate "${row.candidate_id || '?'}": ${issue}`)));
  if (attempted && !failed) candidateManifest.forEach(candidate => {
    const id = String(candidate.candidate_id || '');
    const rows = rowsByCandidate.get(id) || [];
    if (rows.length !== 1) {
      const issue = rows.length
        ? `targeted trace returned ${rows.length} rows for unmatched candidate "${id}"`
        : `targeted trace omitted unmatched candidate "${id}"`;
      topIssues.push(issue);
      atomicStructuralIssues.push(issue);
      unresolved.push({ candidate_id: id, aligned_candidate_bbox: cloneJson(candidate.aligned_candidate_bbox),
        issues: [issue] });
    }
  });
  const uniqueAtomicStructuralIssues = [...new Set(atomicStructuralIssues)];
  normalizedRows.forEach(row => {
    const candidate = candidateById.get(row.candidate_id);
    if (candidate) return;
    unresolved.push({
      candidate_id: row.candidate_id,
      verdict: row.verdict,
      evidence_crop_id: row.evidence_crop_id,
      arrowhead_bbox_original: cloneJson(row.arrowhead_bbox_original),
      issues: [...new Set(row.issues.length ? row.issues :
        ['foreign targeted-trace row remained unresolved'])],
    });
  });

  const connectorObservations = Array.isArray(topology.connector_observations)
    ? topology.connector_observations : [];
  const connectorAliases = Array.isArray(topology.connectors) ? topology.connectors : [];
  const usedConnectorIds = new Set(connectorObservations.map(row =>
    String(row && row.connector_observation_id || '')).filter(Boolean));
  const usedTransitionIds = new Set(transitions.map(row =>
    String(row && row.transition_id || '')).filter(Boolean));
  const addedTransitionIds = [];
  normalizedRows.forEach(row => {
    const candidate = candidateById.get(row.candidate_id);
    if (!candidate || (rowsByCandidate.get(row.candidate_id) || []).length !== 1) return;
    const addStructural = issue => {
      row.issues = [...new Set([...row.issues, issue])];
      row.structural_issues = [...new Set([...row.structural_issues, issue])];
    };
    const sourceRows = statesById.get(row.source_observation_id) || [];
    const targetRows = statesById.get(row.target_observation_id) || [];
    const needsEndpoints = row.verdict === 'MATCHES_EXISTING' || row.verdict === 'VERIFIED_OMITTED';
    if (needsEndpoints && sourceRows.length !== 1) addStructural(sourceRows.length
      ? `duplicate source_observation_id "${row.source_observation_id}"`
      : `foreign or missing source_observation_id "${row.source_observation_id || '?'}"`);
    if (needsEndpoints && targetRows.length !== 1) addStructural(targetRows.length
      ? `duplicate target_observation_id "${row.target_observation_id}"`
      : `foreign or missing target_observation_id "${row.target_observation_id || '?'}"`);

    if (row.verdict === 'MATCHES_EXISTING') {
      if (row.trace_status !== 'COMPLETE') addStructural('MATCHES_EXISTING requires trace_status COMPLETE');
      if (uniqueAtomicStructuralIssues.length) {
        addStructural(`MATCHES_EXISTING is blocked because the targeted-trace response is not structurally clean: ${uniqueAtomicStructuralIssues.join('; ')}`);
      }
      const matchConfidences = [row.candidate_confidence, row.endpoint_confidence,
        row.connector_confidence, row.orientation.confidence, row.self_loop.confidence];
      if (matchConfidences.some(confidence => confidence < 0.85)) {
        addStructural('MATCHES_EXISTING requires every trace confidence to be at least 0.85');
      }
      if (row.orientation.value === 'UNKNOWN') {
        addStructural('MATCHES_EXISTING requires a localized arrowhead orientation');
      }
      if (row.self_loop.value === 'UNKNOWN') {
        addStructural('MATCHES_EXISTING requires definite self_loop evidence');
      }
      if (row.model_issues.length) addStructural('MATCHES_EXISTING contains model-reported uncertainty');
      if (stringIssues(traceValue && traceValue.issues).length) {
        addStructural('MATCHES_EXISTING is blocked by global model-reported trace uncertainty');
      }
      const existingRows = transitionById.get(row.existing_transition_id) || [];
      if (existingRows.length !== 1) addStructural(existingRows.length
        ? `duplicate existing_transition_id "${row.existing_transition_id}"`
        : `foreign or missing existing_transition_id "${row.existing_transition_id || '?'}"`);
      const existing = existingRows.length === 1 ? existingRows[0] : null;
      if (existing && (existing.scan_incomplete || stringIssues(existing.issues).length ||
        !Number.isFinite(Number(existing.confidence)) || Number(existing.confidence) < 0.75)) {
        addStructural('MATCHES_EXISTING referenced transition is itself incomplete or low-confidence');
      }
      if (existing && (String(existing.source_observation_id || '') !== row.source_observation_id ||
        String(existing.target_observation_id || '') !== row.target_observation_id)) {
        addStructural('MATCHES_EXISTING endpoint ids do not match the referenced transition');
      }
      const source = sourceRows.length === 1 ? sourceRows[0] : null;
      const target = targetRows.length === 1 ? targetRows[0] : null;
      const isSelfLoop = Boolean(source && target && row.source_observation_id === row.target_observation_id);
      if (source && target && ((isSelfLoop && row.self_loop.value !== 'YES') ||
        (!isSelfLoop && row.self_loop.value !== 'NO'))) {
        addStructural('MATCHES_EXISTING self_loop evidence conflicts with the referenced endpoints');
      }
      if (existing && !traceBoxNearExpected(row.arrowhead_bbox_original, existing.arrowhead_bbox)) {
        addStructural('MATCHES_EXISTING arrowhead geometry does not match the referenced transition');
      }
      if (existing && bboxIou(row.connector_bbox_original, existing.connector_bbox) < 0.45) {
        addStructural('MATCHES_EXISTING connector geometry does not overlap the referenced connector strongly enough');
      }
      if (existing && source && target) {
        const evidenceTile = tileById.get(row.evidence_crop_id);
        if (!evidenceTile || !bboxContainsBox(evidenceTile.original_bbox, source.bbox) ||
          !bboxContainsBox(evidenceTile.original_bbox, target.bbox) ||
          !bboxContainsBox(evidenceTile.original_bbox, existing.connector_bbox)) {
          addStructural('MATCHES_EXISTING cannot verify the full referenced connector and endpoint boundaries inside its trustworthy evidence tile');
        }
        const arrowBoundary = stateBoundaryAnnulusContact(row.arrowhead_bbox_original, target.bbox);
        if (!arrowBoundary.valid) {
          addStructural(`MATCHES_EXISTING arrowhead does not localize the referenced target boundary: ${arrowBoundary.reason}`);
        }
        const tailBoundary = stateBoundaryAnnulusContact(row.tail_contact_bbox_original, source.bbox);
        if (!tailBoundary.valid) {
          addStructural(`MATCHES_EXISTING tail does not localize the referenced source boundary: ${tailBoundary.reason}`);
        }
        connectorExtentAudit(row.connector_bbox_original, row.arrowhead_bbox_original,
          row.tail_contact_bbox_original, source.bbox, target.bbox, isSelfLoop).issues
          .forEach(addStructural);
        if (!isSelfLoop) {
          const expectedOrientation = directionOctant(source.bbox, target.bbox);
          const directionDifference = octantDistance(expectedOrientation, row.orientation.value);
          if (directionDifference == null || directionDifference > 1) {
            addStructural(`MATCHES_EXISTING orientation ${row.orientation.value} conflicts with referenced endpoint direction ${expectedOrientation}`);
          }
          if (!(bboxEdgeDistance(row.arrowhead_bbox_original, target.bbox) + 0.008 <
            bboxEdgeDistance(row.arrowhead_bbox_original, source.bbox))) {
            addStructural('MATCHES_EXISTING arrowhead is not materially closer to the referenced target than source');
          }
        }
      }
      const inventoryOrientation = String(candidate.inventory_orientation &&
        candidate.inventory_orientation.value || 'UNKNOWN').toUpperCase();
      const inventoryOrientationConfidence = Number(candidate.inventory_orientation &&
        candidate.inventory_orientation.confidence);
      if (inventoryOrientation !== 'UNKNOWN' && inventoryOrientationConfidence >= 0.75 &&
        (octantDistance(inventoryOrientation, row.orientation.value) == null ||
          octantDistance(inventoryOrientation, row.orientation.value) > 1)) {
        addStructural(`MATCHES_EXISTING orientation ${row.orientation.value} conflicts with independent inventory orientation ${inventoryOrientation}`);
      }
      const inventorySelfLoop = String(candidate.inventory_self_loop_hint &&
        candidate.inventory_self_loop_hint.value || 'UNKNOWN').toUpperCase();
      const inventorySelfLoopConfidence = Number(candidate.inventory_self_loop_hint &&
        candidate.inventory_self_loop_hint.confidence);
      if (inventorySelfLoop !== 'UNKNOWN' && inventorySelfLoopConfidence >= 0.75 &&
        inventorySelfLoop !== row.self_loop.value) {
        addStructural(`MATCHES_EXISTING self_loop ${row.self_loop.value} conflicts with independent inventory hint ${inventorySelfLoop}`);
      }
      if (!row.structural_issues.length && !row.model_issues.length &&
        !stringIssues(traceValue && traceValue.issues).length) {
        row.disposition = 'matched_existing';
      }
    } else if (row.verdict === 'VERIFIED_OMITTED') {
      if (row.existing_transition_id) addStructural('VERIFIED_OMITTED must not reference an existing_transition_id');
      if (row.trace_status !== 'COMPLETE') addStructural('VERIFIED_OMITTED requires trace_status COMPLETE');
      if (!currentAlignmentValidated || candidate.alignment_validated !== true) {
        addStructural('VERIFIED_OMITTED requires a validated and applied inventory-to-topology alignment; raw fallback coordinates are evidence-only');
      }
      if (uniqueAtomicStructuralIssues.length) {
        addStructural(`VERIFIED_OMITTED is atomically blocked because the targeted-trace response contains structural or global issues: ${uniqueAtomicStructuralIssues.join('; ')}`);
      }
      const confidences = [row.candidate_confidence, row.endpoint_confidence, row.connector_confidence,
        row.orientation.confidence, row.self_loop.confidence];
      if (confidences.some(confidence => confidence < 0.85)) {
        addStructural('VERIFIED_OMITTED requires every trace confidence to be at least 0.85');
      }
      if (row.model_issues.length) addStructural('VERIFIED_OMITTED contains model-reported uncertainty');
      if (stringIssues(traceValue && traceValue.issues).length) {
        addStructural('VERIFIED_OMITTED is blocked by global model-reported trace uncertainty');
      }
      const source = sourceRows.length === 1 ? sourceRows[0] : null;
      const target = targetRows.length === 1 ? targetRows[0] : null;
      const isSelfLoop = Boolean(source && target && row.source_observation_id === row.target_observation_id);
      if (row.orientation.value === 'UNKNOWN') addStructural('VERIFIED_OMITTED requires a localized arrowhead orientation');
      const inventoryOrientation = String(candidate.inventory_orientation &&
        candidate.inventory_orientation.value || 'UNKNOWN').toUpperCase();
      const inventoryOrientationConfidence = Number(candidate.inventory_orientation &&
        candidate.inventory_orientation.confidence);
      const inventoryOrientationDifference = octantDistance(inventoryOrientation, row.orientation.value);
      if (inventoryOrientation !== 'UNKNOWN' && inventoryOrientationConfidence >= 0.75 &&
        (inventoryOrientationDifference == null || inventoryOrientationDifference > 1)) {
        addStructural(`targeted arrowhead orientation ${row.orientation.value} conflicts with independent inventory orientation ${inventoryOrientation}`);
      }
      const inventorySelfLoop = String(candidate.inventory_self_loop_hint &&
        candidate.inventory_self_loop_hint.value || 'UNKNOWN').toUpperCase();
      const inventorySelfLoopConfidence = Number(candidate.inventory_self_loop_hint &&
        candidate.inventory_self_loop_hint.confidence);
      if (inventorySelfLoop !== 'UNKNOWN' && inventorySelfLoopConfidence >= 0.75 &&
        inventorySelfLoop !== row.self_loop.value) {
        addStructural(`targeted self_loop ${row.self_loop.value} conflicts with independent inventory hint ${inventorySelfLoop}`);
      }
      if ((isSelfLoop && row.self_loop.value !== 'YES') || (!isSelfLoop && row.self_loop.value !== 'NO')) {
        addStructural('targeted-trace self_loop evidence conflicts with the proposed endpoints');
      }
      if (source && target) {
        const sourceGeometry = localizedBoxGeometry(source.bbox);
        const targetGeometry = localizedBoxGeometry(target.bbox);
        if (!sourceGeometry || !targetGeometry) {
          addStructural('VERIFIED_OMITTED endpoint state geometry is missing or malformed');
        }
        const evidenceTile = tileById.get(row.evidence_crop_id);
        if (!evidenceTile || !bboxContainsBox(evidenceTile.original_bbox, source.bbox) ||
          !bboxContainsBox(evidenceTile.original_bbox, target.bbox)) {
          addStructural('VERIFIED_OMITTED cannot prove a long connector because one or both endpoint boundaries lie outside its trustworthy evidence tile');
        }
        const arrowBoundary = stateBoundaryAnnulusContact(row.arrowhead_bbox_original, target.bbox);
        if (!arrowBoundary.valid) {
          addStructural(`targeted arrowhead does not localize a target boundary contact: ${arrowBoundary.reason}`);
        }
        const tailBoundary = stateBoundaryAnnulusContact(row.tail_contact_bbox_original, source.bbox);
        if (!tailBoundary.valid) {
          addStructural(`targeted tail does not localize a source boundary contact: ${tailBoundary.reason}`);
        }
        connectorExtentAudit(row.connector_bbox_original, row.arrowhead_bbox_original,
          row.tail_contact_bbox_original, source.bbox, target.bbox, isSelfLoop).issues
          .forEach(addStructural);
        if (!isSelfLoop) {
          const arrowTargetDistance = bboxEdgeDistance(row.arrowhead_bbox_original, target.bbox);
          const arrowSourceDistance = bboxEdgeDistance(row.arrowhead_bbox_original, source.bbox);
          const expectedOrientation = directionOctant(source.bbox, target.bbox);
          const directionDifference = octantDistance(expectedOrientation, row.orientation.value);
          if (directionDifference == null || directionDifference > 1) {
            addStructural(`targeted arrowhead orientation ${row.orientation.value} conflicts with endpoint direction ${expectedOrientation}`);
          }
          if (!(arrowTargetDistance + 0.008 < arrowSourceDistance)) {
            addStructural('targeted arrowhead is not materially closer to the proposed target than source');
          }
        }
      }
      const duplicate = transitions.find(existing => {
        const arrowDuplicate = traceBoxNearExpected(row.arrowhead_bbox_original, existing.arrowhead_bbox);
        const connectorDuplicate = bboxIou(row.connector_bbox_original, existing.connector_bbox) >= 0.65;
        return arrowDuplicate || connectorDuplicate;
      });
      if (duplicate) addStructural(`targeted connector duplicates existing transition "${String(duplicate.transition_id || '?')}" geometry`);

      if (!row.structural_issues.length) {
        const connectorObservationId = targetedTraceUniqueId('connector_trace', usedConnectorIds);
        const transitionId = targetedTraceUniqueId('transition_trace', usedTransitionIds);
        const provisionalIssue = `targeted trace provisionally recovered unmatched arrowhead candidate "${row.candidate_id}"; human review is required before use`;
        const connector = {
          connector_observation_id: connectorObservationId,
          connector_bbox: cloneJson(row.connector_bbox_original),
          arrowhead_bbox: cloneJson(row.arrowhead_bbox_original),
          label_block_bbox: { x: -1, y: -1, w: -1, h: -1 },
          visible_line_count: 0,
          line_hints: [],
          confidence: row.connector_confidence,
          issues: [provisionalIssue],
          scan_incomplete: true,
          review_only: true,
          provisional: true,
          trace_candidate_id: row.candidate_id,
          human_review_required: true,
        };
        const transition = {
          transition_id: transitionId,
          connector_observation_id: connectorObservationId,
          source_observation_id: row.source_observation_id,
          target_observation_id: row.target_observation_id,
          connector_bbox: cloneJson(row.connector_bbox_original),
          arrowhead_bbox: cloneJson(row.arrowhead_bbox_original),
          label_block_bbox: { x: -1, y: -1, w: -1, h: -1 },
          visible_line_count: 0,
          line_hints: [],
          confidence: row.endpoint_confidence,
          issues: [provisionalIssue],
          scan_incomplete: true,
          review_only: true,
          provisional: true,
          trace_candidate_id: row.candidate_id,
          human_review_required: true,
        };
        connectorObservations.push(connector);
        transitions.push(transition);
        connectorAliases.push(cloneJson(transition));
        transitionById.set(transitionId, [transition]);
        row.added_provisional_connector = true;
        row.provisional_connector_observation_id = connectorObservationId;
        row.provisional_transition_id = transitionId;
        row.disposition = 'provisional_review_only';
        addedTransitionIds.push(transitionId);
        topIssues.push(provisionalIssue);
      }
    } else if (row.verdict === 'NOT_ARROWHEAD') {
      if (uniqueAtomicStructuralIssues.length) {
        addStructural(`NOT_ARROWHEAD is blocked because the targeted-trace response is not structurally clean: ${uniqueAtomicStructuralIssues.join('; ')}`);
      }
      if (row.trace_status !== 'COMPLETE') {
        addStructural('NOT_ARROWHEAD requires trace_status COMPLETE');
      }
      if (row.candidate_confidence < 0.90) {
        addStructural('NOT_ARROWHEAD requires candidate_confidence of at least 0.90');
      }
      if (row.model_issues.length || stringIssues(traceValue && traceValue.issues).length) {
        addStructural('NOT_ARROWHEAD cannot resolve a candidate while model-reported uncertainty exists');
      }
      row.disposition = row.structural_issues.length ? 'unresolved' : 'not_arrowhead';
    } else if (row.verdict === 'START_MARKER') {
      if (uniqueAtomicStructuralIssues.length) {
        addStructural(`START_MARKER is blocked because the targeted-trace response is not structurally clean: ${uniqueAtomicStructuralIssues.join('; ')}`);
      }
      if (row.trace_status !== 'COMPLETE') {
        addStructural('START_MARKER requires trace_status COMPLETE');
      }
      if ([row.candidate_confidence, row.endpoint_confidence, row.connector_confidence,
        row.orientation.confidence, row.self_loop.confidence].some(confidence => confidence < 0.90)) {
        addStructural('START_MARKER requires every relevant trace confidence to be at least 0.90');
      }
      if (row.model_issues.length || stringIssues(traceValue && traceValue.issues).length) {
        addStructural('START_MARKER cannot resolve a candidate while model-reported uncertainty exists');
      }
      if (row.source_observation_alias || row.source_observation_id) {
        addStructural('START_MARKER must originate in empty space and cannot name a source state');
      }
      if (row.existing_transition_alias || row.existing_transition_id) {
        addStructural('START_MARKER cannot reference a computational transition');
      }
      const startTargets = statesById.get(row.target_observation_id) || [];
      if (startTargets.length !== 1) addStructural(startTargets.length
        ? `duplicate START_MARKER target_observation_id "${row.target_observation_id}"`
        : `foreign or missing START_MARKER target_observation_id "${row.target_observation_id || '?'}"`);
      if (row.self_loop.value !== 'NO') {
        addStructural('START_MARKER self_loop evidence must be NO');
      }
      const inventorySelfLoop = String(candidate.inventory_self_loop_hint &&
        candidate.inventory_self_loop_hint.value || 'UNKNOWN').toUpperCase();
      const inventorySelfLoopConfidence = Number(candidate.inventory_self_loop_hint &&
        candidate.inventory_self_loop_hint.confidence);
      if (inventorySelfLoop === 'YES' && inventorySelfLoopConfidence >= 0.75) {
        addStructural('START_MARKER conflicts with independent high-confidence inventory self-loop evidence');
      }
      const startTarget = startTargets.length === 1 ? startTargets[0] : null;
      const evidenceTile = tileById.get(row.evidence_crop_id);
      if (startTarget && (!evidenceTile || !bboxContainsBox(evidenceTile.original_bbox, startTarget.bbox))) {
        addStructural('START_MARKER target boundary lies outside its trustworthy evidence tile');
      }
      if (startTarget) {
        const arrowBoundary = stateBoundaryAnnulusContact(row.arrowhead_bbox_original, startTarget.bbox);
        if (!arrowBoundary.valid) {
          addStructural(`START_MARKER arrowhead does not localize its target boundary: ${arrowBoundary.reason}`);
        }
        const tailStateConflicts = states.filter(state => {
          if (!localizedBoxGeometry(state && state.bbox)) return false;
          const boundary = stateBoundaryAnnulusContact(row.tail_contact_bbox_original, state.bbox);
          return boundary.valid || bboxEdgeDistance(row.tail_contact_bbox_original, state.bbox) <= 0.002;
        });
        if (tailStateConflicts.length) {
          addStructural('START_MARKER tail must remain in clear empty space and cannot touch, straddle, or enter any state boundary');
        }
        connectorExtentAudit(row.connector_bbox_original, row.arrowhead_bbox_original,
          row.tail_contact_bbox_original, startTarget.bbox, startTarget.bbox, false).issues
          .forEach(addStructural);
        const expectedOrientation = directionOctant(row.tail_contact_bbox_original, startTarget.bbox);
        const directionDifference = octantDistance(expectedOrientation, row.orientation.value);
        if (directionDifference == null || directionDifference > 1) {
          addStructural(`START_MARKER orientation ${row.orientation.value} conflicts with its empty-space tail and target boundary`);
        }
      }
      row.disposition = row.structural_issues.length ? 'unresolved' : 'start_marker';
    }
    if (row.disposition === 'unresolved') {
      unresolved.push({
        candidate_id: row.candidate_id,
        verdict: row.verdict,
        evidence_crop_id: row.evidence_crop_id,
        aligned_candidate_bbox: cloneJson(candidate.aligned_candidate_bbox),
        arrowhead_bbox_original: cloneJson(row.arrowhead_bbox_original),
        issues: [...new Set(row.issues.length ? row.issues : ['targeted trace remained unresolved'])],
      });
    }
  });

  topology.connector_observations = connectorObservations;
  topology.transitions = transitions;
  topology.connectors = connectorAliases;
  if (addedTransitionIds.length) {
    const previousCount = preTraceTopology.visible_connector_count;
    const previousObservationCount = Array.isArray(preTraceTopology.connector_observations)
      ? preTraceTopology.connector_observations.length : 0;
    if (Number.isInteger(previousCount) && previousCount >= 0 && previousCount === previousObservationCount) {
      topology.visible_connector_count = previousCount + addedTransitionIds.length;
    } else {
      topIssues.push('targeted trace preserved a pre-existing connector-count mismatch instead of silently rewriting it');
    }
  }
  const uniqueTopIssues = [...new Set([...stringIssues(plan.issues), ...topIssues,
    ...uniqueAtomicStructuralIssues])];
  if (plan.has_unmatched || attempted || uniqueTopIssues.length || addedTransitionIds.length) {
    topology.issues = [...new Set([...stringIssues(topology.issues), ...uniqueTopIssues])];
    topology.review_only = true;
  }
  result.topology = topology;
  result.review_only = Boolean(topology.review_only);
  result.issues = [...new Set([...stringIssues(result.issues), ...uniqueTopIssues])];
  result.topology_audit = {
    ...cloneJson(result.topology_audit, {}),
    pre_targeted_trace_topology: preTraceTopology,
    targeted_trace: {
      stage: 'topology-targeted-trace',
      scan_session_id: session,
      attempted,
      failed,
      model: String(metadata.model || TOPOLOGY_AUDIT_MODEL),
      requested_candidate_ids: [...requestedIds],
      candidate_manifest: cloneJson(candidateManifest, []),
      tile_manifest: cloneJson(plan.tile_manifest, []),
      rejected_tile_mappings: cloneJson(plan.rejected_tile_mappings, []),
      candidate_traces: normalizedRows,
      raw_candidate_traces: cloneJson(rawRows, []),
      atomic_structural_issues: uniqueAtomicStructuralIssues,
      unresolved_connector_candidates: unresolved,
      added_provisional_transition_ids: addedTransitionIds,
      issues: uniqueTopIssues,
      review_only: Boolean(plan.has_unmatched || attempted || uniqueTopIssues.length || addedTransitionIds.length),
    },
  };
  return result;
}

function validateChangedTransitionArrowheadTargets(initialTopology, finalTopology) {
  const initialTransitions = Array.isArray(initialTopology && initialTopology.transitions)
    ? initialTopology.transitions : [];
  const finalTransitions = Array.isArray(finalTopology && finalTopology.transitions)
    ? finalTopology.transitions : [];
  const finalStates = new Map((Array.isArray(finalTopology && finalTopology.states)
    ? finalTopology.states : []).map(state => [String(state.observation_id || ''), state]));
  const initialByConnector = new Map();
  const initialByTransition = new Map();
  initialTransitions.forEach(transition => {
    const connectorId = String(transition.connector_observation_id || '');
    const transitionId = String(transition.transition_id || '');
    if (connectorId) initialByConnector.set(connectorId, transition);
    if (transitionId) initialByTransition.set(transitionId, transition);
  });
  const validations = [];
  const issues = [];
  finalTransitions.forEach(transition => {
    const connectorId = String(transition.connector_observation_id || '');
    const transitionId = String(transition.transition_id || '');
    const before = initialByConnector.get(connectorId) || initialByTransition.get(transitionId);
    if (!before) return;
    const endpointChanged = String(before.source_observation_id || '') !==
      String(transition.source_observation_id || '') || String(before.target_observation_id || '') !==
      String(transition.target_observation_id || '');
    if (!endpointChanged) return;
    const auditedSourceId = String(transition.source_observation_id || '');
    const auditedTargetId = String(transition.target_observation_id || '');
    const source = finalStates.get(String(transition.source_observation_id || ''));
    const target = finalStates.get(String(transition.target_observation_id || ''));
    const arrow = localizedBoxGeometry(transition.arrowhead_bbox);
    const sourceGeometry = source && localizedBoxGeometry(source.bbox);
    const targetGeometry = target && localizedBoxGeometry(target.bbox);
    let sourceDistance = Number.POSITIVE_INFINITY;
    let targetDistance = Number.POSITIVE_INFINITY;
    let consistent = false;
    const validationIssues = [];
    if (!arrow || !sourceGeometry || !targetGeometry) {
      validationIssues.push('changed endpoints cannot be reconciled because arrowhead/source/target bbox evidence is missing');
    } else {
      sourceDistance = bboxEdgeDistance(arrow.box, sourceGeometry.box);
      targetDistance = bboxEdgeDistance(arrow.box, targetGeometry.box);
      const selfLoop = String(transition.source_observation_id || '') ===
        String(transition.target_observation_id || '');
      const targetReach = Math.max(0.04, targetGeometry.diagonal * 0.55);
      if (selfLoop) {
        consistent = targetDistance <= targetReach;
      } else {
        const materiallyCloserToTarget = targetDistance + 0.01 < sourceDistance;
        consistent = targetDistance <= targetReach && materiallyCloserToTarget;
      }
      if (!consistent) {
        validationIssues.push(`arrowhead_bbox is not geometrically aligned with the audited target ` +
          `(target edge distance ${Number.isFinite(targetDistance) ? targetDistance.toFixed(4) : 'unknown'}, ` +
          `source edge distance ${Number.isFinite(sourceDistance) ? sourceDistance.toFixed(4) : 'unknown'})`);
      }
    }
    if (validationIssues.length) {
      const message = `transition "${transitionId || connectorId || '?'}" endpoint change remains unresolved: ` +
        `${validationIssues.join('; ')}; audited endpoint alternative was preserved as review evidence, ` +
        'while structured endpoints kept the geometrically safer first-pass values';
      issues.push(message);
      transition.source_observation_id = String(before.source_observation_id || '');
      transition.target_observation_id = String(before.target_observation_id || '');
      transition.issues = [...new Set([...stringIssues(transition.issues), ...validationIssues,
        'audited endpoint direction is unresolved; first-pass endpoints retained'])];
      transition.scan_incomplete = true;
      const alias = (Array.isArray(finalTopology.connectors) ? finalTopology.connectors : [])
        .find(row => String(row.transition_id || '') === transitionId);
      if (alias) {
        alias.source_observation_id = transition.source_observation_id;
        alias.target_observation_id = transition.target_observation_id;
        alias.issues = cloneJson(transition.issues, []);
        alias.scan_incomplete = true;
      }
      validationIssues.push(`audited alternative was ${auditedSourceId || '?'}→${auditedTargetId || '?'}`);
    }
    validations.push({
      transition_id: transitionId,
      connector_observation_id: connectorId,
      previous_source_observation_id: String(before.source_observation_id || ''),
      previous_target_observation_id: String(before.target_observation_id || ''),
      audited_source_observation_id: auditedSourceId,
      audited_target_observation_id: auditedTargetId,
      structured_source_observation_id: String(transition.source_observation_id || ''),
      structured_target_observation_id: String(transition.target_observation_id || ''),
      arrowhead_bbox: cloneJson(transition.arrowhead_bbox),
      target_edge_distance: Number.isFinite(targetDistance) ? targetDistance : null,
      source_edge_distance: Number.isFinite(sourceDistance) ? sourceDistance : null,
      consistent,
      issues: validationIssues,
    });
  });
  return { validations, issues: [...new Set(issues)], review_only: issues.length > 0 };
}

// The line-geometry Vision pass can split one handwritten baseline into several
// physical boxes (for example, a main Latin segment plus a narrow Hebrew action
// segment).  This pass groups only by normalized geometry.  It never reads text,
// never knows a transition id, and never discards an ambiguous physical box.
function groupTopologyLineFragments(labelBlockBbox, lineHints) {
  const physicalFragments = cloneJson(Array.isArray(lineHints) ? lineHints : [], []);
  const structuralIssues = [];
  const unresolvedIndexes = new Set();
  const blockResult = normalizeLineBbox(labelBlockBbox);
  const block = blockResult.box;
  const entries = physicalFragments.map((fragment, index) => {
    const bboxResult = normalizeLineBbox(fragment && fragment.bbox);
    if (!bboxResult.localized) {
      unresolvedIndexes.add(index);
      structuralIssues.push(`physical line fragment "${String(fragment && fragment.line_id || index + 1)}" has no valid bbox`);
    }
    return {
      index,
      fragment,
      bbox: bboxResult.box,
      localized: bboxResult.localized,
      isSeed: false,
    };
  });
  if (!blockResult.localized) {
    entries.forEach(entry => unresolvedIndexes.add(entry.index));
    structuralIssues.push('logical-line grouping requires a valid label_block_bbox');
  }

  const EPS = 1e-9;
  const intervalOverlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  const intervalGap = (a0, a1, b0, b1) => Math.max(0, Math.max(a0, b0) - Math.min(a1, b1));
  const relation = (left, right) => {
    const a = left.bbox;
    const b = right.bbox;
    const verticalOverlap = intervalOverlap(a.y, a.y + a.h, b.y, b.y + b.h);
    const horizontalOverlap = intervalOverlap(a.x, a.x + a.w, b.x, b.x + b.w);
    return {
      vertical_overlap_ratio: verticalOverlap / Math.max(EPS, Math.min(a.h, b.h)),
      horizontal_overlap_ratio: horizontalOverlap / Math.max(EPS, Math.min(a.w, b.w)),
      vertical_gap: intervalGap(a.y, a.y + a.h, b.y, b.y + b.h),
      horizontal_gap: intervalGap(a.x, a.x + a.w, b.x, b.x + b.w),
      vertical_center_distance: Math.abs((a.y + a.h / 2) - (b.y + b.h / 2)),
    };
  };
  const suffixRelation = (fragment, anchor) => {
    const metric = relation(fragment, anchor);
    const fragmentCenterX = fragment.bbox.x + fragment.bbox.w / 2;
    const anchorCenterX = anchor.bbox.x + anchor.bbox.w / 2;
    const fragmentRight = fragment.bbox.x + fragment.bbox.w;
    const anchorRight = anchor.bbox.x + anchor.bbox.w;
    const unionLeft = Math.min(fragment.bbox.x, anchor.bbox.x);
    const unionRight = Math.max(fragmentRight, anchorRight);
    const unionWidthRatio = (unionRight - unionLeft) / Math.max(EPS, block.w);
    // A slanted handwritten baseline can put the right/action fragment mostly
    // below the Latin fragment.  A non-trivial overlap is still required, but
    // 58% was too strict for real diagonal labels (some provide only 17-26%).
    const sameBaselineEnvelope = metric.vertical_overlap_ratio >= 0.08 ||
      metric.vertical_gap <= block.h * 0.02;
    const materiallyShorter = fragment.bbox.w <= anchor.bbox.w * 0.90 &&
      fragment.bbox.w <= block.w * 0.65;
    const beginsInLaterZone = fragment.bbox.x >= anchor.bbox.x + block.w * 0.035;
    const centerOrEdgeShiftedRight = fragmentCenterX > anchorCenterX ||
      fragment.bbox.x > anchor.bbox.x + block.w * 0.07;
    const touchesSuffixZone = metric.horizontal_overlap_ratio > 0 ||
      metric.horizontal_gap <= block.w * 0.12;
    // Some action-zone fragments are narrow and wholly contained in the
    // anchor's right half (live handwriting left a 35% block-width tail).  The
    // positive left-edge shift and baseline overlap remain mandatory, so this
    // tolerance does not absorb a separate same-x short row.
    const reachesAnchorEnd = fragmentRight >= anchorRight - block.w * 0.38;
    const coversLineZone = unionWidthRatio >= 0.82;
    const inlineSuffix = sameBaselineEnvelope && materiallyShorter && beginsInLaterZone &&
      centerOrEdgeShiftedRight && touchesSuffixZone && reachesAnchorEnd && coversLineZone;
    /* A handwritten PUSH/POP symbol is sometimes wrapped immediately below
       the Hebrew action word because the connector leaves little horizontal
       space. It is still part of the same rule, not a new rule baseline. Keep
       this deliberately narrow: one tiny action-zone glyph, a very small
       vertical gap, horizontal overlap with the anchor, and a dominant full
       row to attach to. A short row beginning at the INPUT side remains a
       separate physical rule. */
    const fragmentCenterY = fragment.bbox.y + fragment.bbox.h / 2;
    const anchorCenterY = anchor.bbox.y + anchor.bbox.h / 2;
    const veryNarrow = fragment.bbox.w <= anchor.bbox.w * 0.30 &&
      fragment.bbox.w <= block.w * 0.18;
    const inActionZone = fragmentCenterX >= block.x + block.w * 0.62;
    const wrappedBelow = fragmentCenterY > anchorCenterY &&
      metric.vertical_gap <= Math.max(block.h * 0.09, anchor.bbox.h * 0.65);
    const overlapsAnchorHorizontally = metric.horizontal_overlap_ratio > 0;
    const dominantRow = anchor.bbox.w >= block.w * 0.64 &&
      Math.abs(anchor.bbox.x - block.x) <= block.w * 0.18;
    const wrappedSuffix = dominantRow && veryNarrow && inActionZone && wrappedBelow &&
      overlapsAnchorHorizontally && materiallyShorter;
    return inlineSuffix || wrappedSuffix;
  };
  const unionBoxes = members => {
    const xs = members.map(member => member.bbox.x);
    const ys = members.map(member => member.bbox.y);
    const rights = members.map(member => member.bbox.x + member.bbox.w);
    const bottoms = members.map(member => member.bbox.y + member.bbox.h);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return {
      x,
      y,
      w: Math.max(...rights) - x,
      h: Math.max(...bottoms) - y,
    };
  };

  const groups = [];
  const groupBySeedIndex = new Map();
  if (blockResult.localized) {
    // A seed must be both substantially full-width and anchored to the block's
    // left edge.  Requiring both protects real stacked rows from being merged.
    const seedMinWidthRatio = 0.64;
    const seedMaxLeftOffsetRatio = 0.18;
    entries.filter(entry => entry.localized).forEach(entry => {
      const widthRatio = entry.bbox.w / Math.max(EPS, block.w);
      const leftOffsetRatio = Math.abs(entry.bbox.x - block.x) / Math.max(EPS, block.w);
      entry.isSeed = widthRatio >= seedMinWidthRatio && leftOffsetRatio <= seedMaxLeftOffsetRatio;
      if (entry.isSeed) {
        const group = { seed: entry, members: [entry], reason: 'full-width-left-anchored-seed' };
        groups.push(group);
        groupBySeedIndex.set(entry.index, group);
      }
    });

    const seeds = entries.filter(entry => entry.localized && entry.isSeed);
    const remaining = entries.filter(entry => entry.localized && !entry.isSeed);
    const unattached = [];
    for (const fragment of remaining) {
      const candidates = seeds.map(seed => ({ seed, metric: relation(fragment, seed) }))
        .filter(candidate => suffixRelation(fragment, candidate.seed))
        .sort((a, b) => a.metric.vertical_center_distance - b.metric.vertical_center_distance ||
          a.seed.index - b.seed.index);
      if (!candidates.length) {
        unattached.push(fragment);
        continue;
      }
      let unique = candidates.length === 1;
      if (!unique) {
        const margin = candidates[1].metric.vertical_center_distance -
          candidates[0].metric.vertical_center_distance;
        const uniquenessBand = Math.max(block.h * 0.08, fragment.bbox.h * 0.15);
        unique = margin > uniquenessBand;
      }
      if (!unique) {
        unresolvedIndexes.add(fragment.index);
        structuralIssues.push(`physical line fragment "${String(fragment.fragment && fragment.fragment.line_id || fragment.index + 1)}" is geometrically ambiguous between logical baselines`);
        continue;
      }
      groupBySeedIndex.get(candidates[0].seed.index).members.push(fragment);
      groupBySeedIndex.get(candidates[0].seed.index).reason = 'seed-with-uniquely-nearest-fragments';
    }

    // If there is no suitable full-width seed, a shorter, right-shifted suffix
    // may still belong to one dominant left anchor on the same baseline.
    // Require strong vertical overlap and one unique anchor for the complete
    // component; a chain or two neighbouring short rows remain unresolved or
    // standalone instead of being transitively merged.
    const relatedWithoutSeed = (left, right) =>
      suffixRelation(left, right) || suffixRelation(right, left);
    const pending = new Set(unattached.map(entry => entry.index));
    while (pending.size) {
      const firstIndex = Math.min(...pending);
      const queue = [firstIndex];
      const componentIndexes = new Set([firstIndex]);
      pending.delete(firstIndex);
      while (queue.length) {
        const current = entries[queue.shift()];
        for (const candidateIndex of [...pending]) {
          const candidate = entries[candidateIndex];
          if (!relatedWithoutSeed(current, candidate)) continue;
          pending.delete(candidateIndex);
          componentIndexes.add(candidateIndex);
          queue.push(candidateIndex);
        }
      }
      const component = [...componentIndexes].map(index => entries[index]);
      const isClique = component.every((left, leftIndex) => component.every((right, rightIndex) =>
        leftIndex === rightIndex || relatedWithoutSeed(left, right)));
      const anchors = component.filter(anchor => component.every(fragment =>
        fragment.index === anchor.index || suffixRelation(fragment, anchor)));
      if (!isClique || (component.length > 1 && anchors.length !== 1)) {
        component.forEach(entry => unresolvedIndexes.add(entry.index));
        structuralIssues.push(`physical line fragments ${component.map(entry =>
          `"${String(entry.fragment && entry.fragment.line_id || entry.index + 1)}"`).join(', ')} lack one unambiguous left anchor plus strongly-overlapping right-shifted suffix geometry`);
      } else {
        groups.push({
          seed: component.length > 1 ? anchors[0] : null,
          members: component,
          reason: component.length > 1
            ? 'left-anchor-with-strongly-overlapping-right-suffix-without-full-width-seed'
            : 'standalone-fragment',
        });
      }
    }
  }

  const logicalLineGroups = groups
    .filter(group => group.members.length && group.members.every(member => !unresolvedIndexes.has(member.index)))
    .map(group => {
      const members = [...group.members].sort((a, b) => a.index - b.index);
      const memberIds = members.map(member => String(member.fragment && member.fragment.line_id || ''));
      const confidences = members.map(member => Number(member.fragment && member.fragment.confidence))
        .filter(Number.isFinite);
      const memberIssues = members.flatMap(member => stringIssues(member.fragment && member.fragment.issues));
      const groupingIssue = members.length > 1
        ? [`physical fragments ${memberIds.map(id => `"${id || '?'}"`).join(', ')} were grouped into one logical baseline by geometry`]
        : [];
      return {
        logical_line_id: String((group.seed || members[0]).fragment &&
          (group.seed || members[0]).fragment.line_id || ''),
        member_line_ids: memberIds,
        member_fragment_indexes: members.map(member => member.index),
        member_fragments: members.map(member => cloneJson(member.fragment)),
        bbox: unionBoxes(members),
        confidence: confidences.length ? Math.min(...confidences) : 0,
        grouping_reason: group.reason,
        issues: [...new Set([...memberIssues, ...groupingIssue])],
      };
    })
    .sort((left, right) => left.bbox.y - right.bbox.y || left.bbox.x - right.bbox.x);
  const logicalLineHints = logicalLineGroups.map(group => ({
    line_id: group.logical_line_id,
    bbox: cloneJson(group.bbox),
    confidence: group.confidence,
    issues: cloneJson(group.issues, []),
    scan_incomplete: group.issues.length > 0 || group.confidence < 0.75,
  }));
  const unresolvedFragments = [...unresolvedIndexes].sort((a, b) => a - b)
    .map(index => cloneJson(physicalFragments[index]));
  const groupingChanged = logicalLineGroups.some(group => group.member_line_ids.length > 1) ||
    logicalLineGroups.length + unresolvedFragments.length !== physicalFragments.length;

  return {
    physical_fragments: physicalFragments,
    logical_line_groups: logicalLineGroups,
    logical_line_hints: logicalLineHints,
    logical_visible_line_count: logicalLineHints.length,
    unresolved_fragments: unresolvedFragments,
    grouping_changed: groupingChanged,
    structural_issues: [...new Set(structuralIssues)],
    structurally_valid: structuralIssues.length === 0 && unresolvedFragments.length === 0,
  };
}

function normalizeTopologyLineGeometryAuditResult(value, topologyEnvelope, sessionValue) {
  const raw = value && value.line_geometry_audit && typeof value.line_geometry_audit === 'object'
    ? value.line_geometry_audit : (value || {});
  const session = scanSessionId(sessionValue || (value && value.scan_session_id));
  const topology = cloneJson(topologyEnvelope && topologyEnvelope.topology
    ? topologyEnvelope.topology : topologyEnvelope, {});
  const topologyTransitions = Array.isArray(topology.transitions) ? topology.transitions
    : (Array.isArray(topology.connectors) ? topology.connectors : []);
  const expectedTransitions = new Map();
  topologyTransitions.forEach(transition => {
    const transitionId = String(transition && transition.transition_id || '').trim();
    const matches = expectedTransitions.get(transitionId) || [];
    matches.push(transition);
    expectedTransitions.set(transitionId, matches);
  });
  const topIssues = stringIssues(raw.issues);
  expectedTransitions.forEach((rows, id) => {
    if (!id) topIssues.push('final topology contains a transition with no transition_id');
    else if (rows.length > 1) topIssues.push(`final topology contains duplicate transition_id "${id}"`);
  });

  const rowMap = new Map();
  const connectorLines = (Array.isArray(raw.connector_lines) ? raw.connector_lines : [])
    .filter(Boolean).map(row => {
      const transitionId = String(row.transition_id || '').trim();
      const issues = stringIssues(row.issues);
      const structuralIssues = [];
      const addStructuralIssue = issue => {
        issues.push(issue);
        structuralIssues.push(issue);
      };
      const expected = expectedTransitions.get(transitionId) || [];
      if (!transitionId) addStructuralIssue('line-geometry transition_id is missing');
      else if (expected.length !== 1) addStructuralIssue(expected.length
        ? `duplicate final-topology transition_id "${transitionId}"`
        : `foreign line-geometry transition_id "${transitionId}"`);
      const labelBlockIssues = [];
      const labelBlockBbox = evidenceBox(row.label_block_bbox,
        'line-geometry label_block_bbox', labelBlockIssues);
      labelBlockIssues.forEach(addStructuralIssue);
      const visibleLineCountRaw = row.visible_line_count;
      const validCount = typeof visibleLineCountRaw === 'number' && Number.isInteger(visibleLineCountRaw) &&
        visibleLineCountRaw >= 0;
      if (!validCount) addStructuralIssue('line-geometry visible_line_count is missing or malformed');
      let confidence = Number(row.confidence);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        confidence = 0;
        issues.push('line-geometry connector confidence is missing or malformed');
      } else if (confidence < 0.75) {
        issues.push('line-geometry connector confidence is below review threshold');
      }
      const lineIds = new Map();
      const lineHints = (Array.isArray(row.line_hints) ? row.line_hints : []).filter(Boolean)
        .map(line => {
          const lineId = String(line.line_id || '').trim();
          const lineIssues = stringIssues(line.issues);
          const lineStructuralIssues = [];
          if (!lineId) {
            lineIssues.push('line-geometry line_id is missing');
            lineStructuralIssues.push('line-geometry line_id is missing');
          }
          const bboxIssues = [];
          const bbox = evidenceBox(line.bbox || line.line_bbox,
            'line-geometry line-hint bbox', bboxIssues);
          bboxIssues.forEach(issue => {
            lineIssues.push(issue);
            lineStructuralIssues.push(issue);
          });
          let lineConfidence = Number(line.confidence);
          if (!Number.isFinite(lineConfidence) || lineConfidence < 0 || lineConfidence > 1) {
            lineConfidence = 0;
            lineIssues.push('line-geometry line confidence is missing or malformed');
          } else if (lineConfidence < 0.75) {
            lineIssues.push('line-geometry line confidence is below review threshold');
          }
          const out = {
            line_id: lineId,
            bbox,
            confidence: lineConfidence,
            issues: [...new Set(lineIssues)],
            structural_issues: [...new Set(lineStructuralIssues)],
            scan_incomplete: lineIssues.length > 0,
          };
          const matches = lineIds.get(lineId) || [];
          matches.push(out);
          lineIds.set(lineId, matches);
          return out;
        });
      lineHints.forEach(line => (line.structural_issues || []).forEach(addStructuralIssue));
      lineIds.forEach((rows, id) => {
        if (!id || rows.length < 2) return;
        addStructuralIssue(`duplicate line-geometry line_id "${id}" for transition "${transitionId || '?'}"`);
        rows.forEach(line => {
          line.issues = [...new Set([...line.issues, `duplicate line-geometry line_id "${id}"`])];
          line.structural_issues = [...new Set([...(line.structural_issues || []),
            `duplicate line-geometry line_id "${id}"`])];
          line.scan_incomplete = true;
        });
      });
      if (validCount && visibleLineCountRaw !== lineHints.length) {
        addStructuralIssue(`line-geometry visible_line_count ${visibleLineCountRaw} does not match line_hints.length ${lineHints.length}`);
      }
      // Keep both the model's original fragment records and their normalized
      // counterparts.  Logical rows are a derived view and never overwrite this
      // physical evidence inside the audit envelope.
      const rawPhysicalFragments = cloneJson(Array.isArray(row.line_hints) ? row.line_hints : [], []);
      const grouping = groupTopologyLineFragments(labelBlockBbox, lineHints);
      grouping.structural_issues.forEach(addStructuralIssue);
      if (grouping.grouping_changed) {
        issues.push('physical line fragments were grouped into logical baselines by deterministic geometry; human review is required');
      }
      const out = {
        transition_id: transitionId,
        label_block_bbox: labelBlockBbox,
        visible_line_count: validCount ? visibleLineCountRaw : null,
        line_hints: lineHints,
        raw_physical_fragments: rawPhysicalFragments,
        physical_fragments: cloneJson(grouping.physical_fragments, []),
        logical_visible_line_count: grouping.logical_visible_line_count,
        logical_line_hints: cloneJson(grouping.logical_line_hints, []),
        logical_line_groups: cloneJson(grouping.logical_line_groups, []),
        unresolved_fragments: cloneJson(grouping.unresolved_fragments, []),
        grouping_changed: grouping.grouping_changed,
        confidence,
        issues: [...new Set(issues)],
        structural_issues: [...new Set(structuralIssues)],
        structurally_valid: structuralIssues.length === 0 && grouping.structurally_valid,
        scan_incomplete: issues.length > 0 || lineHints.some(line => line.scan_incomplete),
      };
      const matches = rowMap.get(transitionId) || [];
      matches.push(out);
      rowMap.set(transitionId, matches);
      return out;
    });
  rowMap.forEach((rows, id) => {
    if (!id || rows.length < 2) return;
    topIssues.push(`duplicate line-geometry row for transition_id "${id}"`);
    rows.forEach(row => {
      row.issues = [...new Set([...row.issues, `duplicate line-geometry row for transition_id "${id}"`])];
      row.structural_issues = [...new Set([...(row.structural_issues || []),
        `duplicate line-geometry row for transition_id "${id}"`])];
      row.structurally_valid = false;
      row.scan_incomplete = true;
    });
  });
  expectedTransitions.forEach((rows, id) => {
    if (!id || rows.length !== 1) return;
    const auditRows = rowMap.get(id) || [];
    if (auditRows.length !== 1) topIssues.push(auditRows.length
      ? `transition "${id}" has ${auditRows.length} line-geometry rows`
      : `transition "${id}" is missing its line-geometry row`);
  });
  const issues = [...new Set(topIssues)];
  const lineGeometryAudit = {
    connector_lines: connectorLines,
    issues,
    grouping_changed: connectorLines.some(row => row.grouping_changed),
    review_only: issues.length > 0 || connectorLines.some(row => row.scan_incomplete),
  };
  return {
    stage: 'topology-line-geometry-audit',
    scan_session_id: session,
    line_geometry_audit: lineGeometryAudit,
    review_only: lineGeometryAudit.review_only,
  };
}

function applyTopologyLineGeometryAudit(topologyAuditEnvelope, auditValue, sessionValue, metadata = {}) {
  const session = scanSessionId(sessionValue || (topologyAuditEnvelope && topologyAuditEnvelope.scan_session_id));
  const result = cloneJson(topologyAuditEnvelope, {});
  const topology = cloneJson(result.topology, {});
  const preLineTopology = cloneJson(topology, {});
  const auditEnvelope = normalizeTopologyLineGeometryAuditResult(auditValue, topology, session);
  const lineAudit = auditEnvelope.line_geometry_audit;
  const errorText = metadata.error == null ? ''
    : String(metadata.error && metadata.error.message || metadata.error).slice(0, 240);
  const failed = Boolean(errorText) || auditValue == null;
  const issues = [];
  if (failed) issues.push(`independent line-geometry audit failed; replacement topology preserved for review${errorText ? `: ${errorText}` : ''}`);
  (lineAudit.issues || []).forEach(issue => issues.push(`line-geometry audit: ${issue}`));
  if (lineAudit.review_only) issues.push('line-geometry audit contains unresolved, duplicate, foreign, missing, or low-confidence evidence');
  if (lineAudit.grouping_changed) {
    issues.push('line-geometry audit grouped physical fragments into logical baselines; human review remains required');
  }

  const transitions = Array.isArray(topology.transitions) ? topology.transitions : [];
  const connectorObservations = Array.isArray(topology.connector_observations)
    ? topology.connector_observations : [];
  const connectorAliases = Array.isArray(topology.connectors) ? topology.connectors : [];
  const transitionMap = new Map();
  transitions.forEach(transition => {
    const id = String(transition && transition.transition_id || '').trim();
    const rows = transitionMap.get(id) || [];
    rows.push(transition);
    transitionMap.set(id, rows);
  });
  const connectorMap = new Map();
  connectorObservations.forEach(connector => {
    const id = String(connector && connector.connector_observation_id || '').trim();
    const rows = connectorMap.get(id) || [];
    rows.push(connector);
    connectorMap.set(id, rows);
  });
  const connectorAliasMap = new Map();
  connectorAliases.forEach(connector => {
    const id = String(connector && connector.transition_id || '').trim();
    const rows = connectorAliasMap.get(id) || [];
    rows.push(connector);
    connectorAliasMap.set(id, rows);
  });
  const auditRows = new Map();
  (lineAudit.connector_lines || []).forEach(row => {
    const id = String(row.transition_id || '').trim();
    const rows = auditRows.get(id) || [];
    rows.push(row);
    auditRows.set(id, rows);
  });
  let changed = false;
  if (!failed) auditRows.forEach((rows, transitionId) => {
    if (!transitionId || rows.length !== 1) return;
    const row = rows[0];
    const reliableGeometry = row.structurally_valid && !row.scan_incomplete &&
      Number(row.confidence) >= 0.75 && (row.logical_line_hints || []).every(line =>
        !line.scan_incomplete && Number(line.confidence) >= 0.75);
    if (!reliableGeometry || (row.unresolved_fragments || []).length) {
      issues.push(`line-geometry row for transition "${transitionId}" was not applied because its physical fragments are invalid or geometrically ambiguous`);
      return;
    }
    const matches = transitionMap.get(transitionId) || [];
    if (matches.length !== 1) return;
    const transition = matches[0];
    const physicalMatches = connectorMap.get(String(transition.connector_observation_id || '').trim()) || [];
    const aliasMatches = connectorAliasMap.get(transitionId) || [];
    if (physicalMatches.length !== 1 || aliasMatches.length !== 1) {
      issues.push(`line-geometry row for transition "${transitionId}" was not applied because its physical connector observation or connector alias is missing or duplicated`);
      return;
    }
    const replacement = {
      label_block_bbox: cloneJson(row.label_block_bbox),
      visible_line_count: row.logical_visible_line_count,
      line_hints: cloneJson(row.logical_line_hints, []),
    };
    const before = JSON.stringify({
      label_block_bbox: transition.label_block_bbox,
      visible_line_count: transition.visible_line_count,
      line_hints: transition.line_hints,
    });
    const after = JSON.stringify(replacement);
    transition.label_block_bbox = replacement.label_block_bbox;
    transition.visible_line_count = replacement.visible_line_count;
    transition.line_hints = replacement.line_hints;
    const physical = physicalMatches[0];
    physical.label_block_bbox = cloneJson(replacement.label_block_bbox);
    physical.visible_line_count = replacement.visible_line_count;
    physical.line_hints = cloneJson(replacement.line_hints, []);
    const alias = aliasMatches[0];
    alias.label_block_bbox = cloneJson(replacement.label_block_bbox);
    alias.visible_line_count = replacement.visible_line_count;
    alias.line_hints = cloneJson(replacement.line_hints, []);
    if (before !== after) changed = true;
  });
  if (changed) issues.push('independent line-geometry audit revised label-block or baseline geometry; human review remains required');
  const combinedIssues = [...new Set([...(Array.isArray(topology.issues) ? topology.issues.map(String) : []), ...issues])];
  topology.issues = combinedIssues;
  topology.review_only = Boolean(topology.review_only || failed || changed || lineAudit.review_only || issues.length);
  result.topology = topology;
  result.review_only = topology.review_only;
  result.issues = [...new Set([...(Array.isArray(result.issues) ? result.issues.map(String) : []), ...issues])];
  result.topology_audit = {
    ...cloneJson(result.topology_audit, {}),
    pre_line_topology: preLineTopology,
    line_geometry_audit: cloneJson(lineAudit),
    line_geometry_model: String(metadata.model || metadata.line_geometry_model || TOPOLOGY_AUDIT_MODEL),
    line_geometry_changed: changed,
    line_geometry_grouping_changed: Boolean(lineAudit.grouping_changed),
    line_geometry_failed: failed,
  };
  return result;
}

/* Acceptance is a visual property of the circle border.  A second Vision pass
   is useful as an independent vote, but one pass must not turn an ordinary,
   repeatedly-traced pencil circle into a final double circle by itself.  Keep
   both observations in the audit trail and expose accepting=true only when
   both same-frame passes agree on the same physical state. */
function reconcileAuditedAcceptingFlags(initialTopology, auditedTopology) {
  const initialStates = Array.isArray(initialTopology && initialTopology.states)
    ? initialTopology.states : [];
  const auditedStates = Array.isArray(auditedTopology && auditedTopology.states)
    ? auditedTopology.states : [];
  const initialById = new Map(initialStates.map(state =>
    [String(state && state.observation_id || '').trim(), state]));
  const usedInitial = new Set();
  const disagreements = [];
  const issues = [];
  auditedStates.forEach(audited => {
    const auditedId = String(audited && audited.observation_id || '').trim();
    let initial = initialById.get(auditedId);
    if (!initial) {
      const nearest = initialStates.map(candidate => ({ candidate,
        distance: bboxCenterDistance(candidate && candidate.bbox, audited && audited.bbox) }))
        .filter(row => Number.isFinite(row.distance) && row.distance <= 0.08 &&
          !usedInitial.has(row.candidate))
        .sort((left, right) => left.distance - right.distance)[0];
      initial = nearest && nearest.candidate;
    }
    if (!initial) return;
    usedInitial.add(initial);
    const initialValue = Boolean(initial.is_accepting && initial.is_accepting.value);
    const auditedValue = Boolean(audited.is_accepting && audited.is_accepting.value);
    if (initialValue === auditedValue) return;
    const finalValue = initialValue && auditedValue;
    const initialConfidence = Number(initial.is_accepting && initial.is_accepting.confidence);
    const auditedConfidence = Number(audited.is_accepting && audited.is_accepting.confidence);
    const message = `accepting-state border disagrees between independent passes for state "${auditedId || '?'}"; ` +
      'structured accepting=false until the double border is confirmed';
    disagreements.push({
      observation_id: auditedId,
      initial_value: initialValue,
      audited_value: auditedValue,
      final_value: finalValue,
      initial_confidence: Number.isFinite(initialConfidence) ? initialConfidence : null,
      audited_confidence: Number.isFinite(auditedConfidence) ? auditedConfidence : null,
    });
    issues.push(message);
    audited.is_accepting = {
      ...(audited.is_accepting && typeof audited.is_accepting === 'object'
        ? audited.is_accepting : {}),
      value: finalValue,
      confidence: Number.isFinite(initialConfidence) && Number.isFinite(auditedConfidence)
        ? Math.min(initialConfidence, auditedConfidence) : 0,
    };
    audited.issues = [...new Set([...stringIssues(audited.issues), message])];
    audited.scan_incomplete = true;
  });
  return { disagreements, issues: [...new Set(issues)] };
}

function normalizeTopologyAuditStageResult(value, topologyEnvelope, crops, sessionValue, metadata = {}) {
  const requestedSession = String(sessionValue || '').trim();
  const topologySession = String(topologyEnvelope && topologyEnvelope.scan_session_id || '').trim();
  const session = scanSessionId(requestedSession || topologySession);
  const initialRaw = cloneJson(topologyEnvelope && topologyEnvelope.topology
    ? topologyEnvelope.topology : topologyEnvelope, {});
  const initial = normalizeTopologyStageResult(initialRaw, session);
  const initialEvidence = cloneJson(initial.topology, {});
  const auditIssues = [];
  if (requestedSession && topologySession && requestedSession !== topologySession) {
    auditIssues.push('topology-audit scan_session_id does not match topology scan_session_id');
  }
  const tileManifest = normalizeTopologyAuditManifest(crops, auditIssues);
  const inventoryEnvelope = metadata.inventory == null ? null
    : normalizeTopologyInventoryResult(metadata.inventory, session);
  const inventoryEvidence = inventoryEnvelope ? cloneJson(inventoryEnvelope.inventory, null) : null;
  if (inventoryEvidence) {
    (inventoryEvidence.issues || []).forEach(issue => auditIssues.push(`geometric inventory: ${issue}`));
    if (inventoryEvidence.review_only) {
      auditIssues.push('geometric inventory contains unresolved or low-confidence physical candidates');
    }
  }
  const initialModel = String(metadata.initial_model || metadata.initialModel || TOPOLOGY_MODEL);
  const auditModel = String(metadata.audit_model || metadata.auditModel || TOPOLOGY_AUDIT_MODEL);
  const errorText = metadata.error == null ? ''
    : String(metadata.error && metadata.error.message || metadata.error).slice(0, 240);
  const failed = Boolean(errorText) || value == null;
  const finalEnvelope = failed
    ? normalizeTopologyStageResult(initialEvidence, session)
    : normalizeTopologyStageResult(value, session);
  const stateFlagReconciliation = failed
    ? { disagreements: [], issues: [] }
    : reconcileAuditedAcceptingFlags(initialEvidence, finalEnvelope.topology);
  stateFlagReconciliation.issues.forEach(issue => auditIssues.push(issue));
  const changed = !failed && JSON.stringify(finalEnvelope.topology) !== JSON.stringify(initialEvidence);

  if (changed) {
    auditIssues.push('independent topology audit revised the initial extraction; human review remains required');
  }
  if (failed) {
    auditIssues.push(`independent topology audit failed; initial extraction preserved for review${errorText ? `: ${errorText}` : ''}`);
  }
  const endpointGeometryValidation = failed
    ? { validations: [], issues: [], review_only: false }
    : validateChangedTransitionArrowheadTargets(initialEvidence, finalEnvelope.topology);
  endpointGeometryValidation.issues.forEach(issue => auditIssues.push(issue));
  let inventoryReconciliation = null;
  if (inventoryEvidence) {
    const finalStateCount = finalEnvelope.topology.visible_state_count;
    const inventoryStateCount = inventoryEvidence.visible_state_circle_count;
    if (Number.isInteger(finalStateCount) && Number.isInteger(inventoryStateCount) &&
      finalStateCount !== inventoryStateCount) {
      auditIssues.push(`geometric inventory state count ${inventoryStateCount} does not match final topology state count ${finalStateCount}; no state was invented`);
    }
    const finalConnectorCount = finalEnvelope.topology.visible_connector_count;
    const inventoryArrowheadCount = inventoryEvidence.visible_computational_arrowhead_count;
    if (Number.isInteger(finalConnectorCount) && Number.isInteger(inventoryArrowheadCount) &&
      finalConnectorCount !== inventoryArrowheadCount) {
      auditIssues.push(`geometric inventory computational-arrowhead count ${inventoryArrowheadCount} does not match final topology connector count ${finalConnectorCount}; no connector was invented`);
    }
    inventoryReconciliation = reconcileTopologyInventoryGeometry(inventoryEvidence,
      finalEnvelope.topology);
    inventoryReconciliation.issues.forEach(issue =>
      auditIssues.push(`geometric inventory reconciliation: ${issue}`));
  }
  const allIssues = [...new Set([...(finalEnvelope.topology.issues || []), ...auditIssues])];
  finalEnvelope.topology.issues = allIssues;
  finalEnvelope.topology.review_only = Boolean(finalEnvelope.topology.review_only || auditIssues.length || failed || changed);
  finalEnvelope.stage = 'topology-audit';
  finalEnvelope.review_only = finalEnvelope.topology.review_only;
  finalEnvelope.issues = allIssues;
  finalEnvelope.topology_audit = {
    initial_topology: initialEvidence,
    initial_model: initialModel,
    audit_model: auditModel,
    inventory_model: String(metadata.inventory_model || metadata.inventoryModel || auditModel),
    models: { initial: initialModel, audit: auditModel },
    changed,
    failed,
    model_type: String(metadata.model_type || 'pda').trim().toLowerCase(),
    image_roles: Array.isArray(metadata.image_roles) ? metadata.image_roles.map(String) : [],
    tile_manifest: tileManifest,
    geometric_inventory: inventoryEvidence,
    inventory_reconciliation: inventoryReconciliation,
    state_flag_reconciliation: stateFlagReconciliation,
    endpoint_geometry_validation: endpointGeometryValidation,
    inventory_failed: Boolean(metadata.inventory_error),
  };
  return finalEnvelope;
}

function normalizeCropManifest(crops, topology, issues) {
  const transitionRows = Array.isArray(topology.transitions) ? topology.transitions
    : (Array.isArray(topology.connectors) ? topology.connectors : []);
  const transitions = new Map();
  transitionRows.forEach(t => {
    const id = String(t && t.transition_id || '').trim();
    const rows = transitions.get(id) || [];
    rows.push(t);
    transitions.set(id, rows);
  });
  const stateRows = Array.isArray(topology.states) ? topology.states : [];
  const states = new Map();
  stateRows.forEach(state => {
    const id = String(state && state.observation_id || '').trim();
    const rows = states.get(id) || [];
    rows.push(state);
    states.set(id, rows);
  });
  const cropIdMap = new Map();
  const lineKeyMap = new Map();
  const stateKeyMap = new Map();
  const normalized = (Array.isArray(crops) ? crops : []).filter(Boolean).map(crop => {
    const cropId = String(crop.crop_id || '').trim();
    const transitionId = String(crop.transition_id || '').trim();
    const lineId = String(crop.line_id || '').trim();
    const observationId = String(crop.observation_id || '').trim();
    const kind = crop.kind === 'label_block' ? 'label_block'
      : (crop.kind === 'line' ? 'line' : (crop.kind === 'state_label' ? 'state_label' : ''));
    const suppliedIssues = stringIssues(crop.issues);
    const cropIssues = suppliedIssues.filter(issue => !(crop.derived_from_state_bbox &&
      /נגזר מהאזור הפנימי של עיגול המצב/.test(issue)));
    if (!cropId) cropIssues.push('crop_id is missing');
    if (kind === 'state_label') {
      const matches = states.get(observationId) || [];
      if (!observationId || matches.length !== 1) cropIssues.push(!observationId
        ? 'state-label crop observation_id is missing'
        : `foreign or duplicate state observation_id "${observationId}"`);
    } else if (!transitionId || (transitions.get(transitionId) || []).length !== 1) {
      cropIssues.push(!transitionId ? 'transition_id is missing' : `foreign or duplicate transition_id "${transitionId}"`);
    }
    if (!kind) cropIssues.push('crop kind must be label_block, line, or state_label');
    if (kind === 'line' && !lineId) cropIssues.push('line crop is missing line_id');
    if (!String(crop.image_url || '').trim()) cropIssues.push('crop image_url is missing');
    const sourceBbox = evidenceBox(crop.source_bbox, 'crop source_bbox', cropIssues);
    const labelBlockBbox = kind === 'state_label'
      ? normalizeLineBbox(crop.label_block_bbox).box
      : evidenceBox(crop.label_block_bbox, 'crop label_block_bbox', cropIssues);
    const stateLabelBbox = kind === 'state_label'
      ? evidenceBox(crop.state_label_bbox || crop.inner_label_bbox || crop.label_bbox || crop.source_bbox,
        'state-label bbox', cropIssues)
      : { x: -1, y: -1, w: -1, h: -1 };
    const stateBbox = kind === 'state_label'
      ? evidenceBox(crop.state_bbox, 'state circle bbox', cropIssues)
      : normalizeLineBbox(crop.state_bbox).box;
    const labelBbox = kind === 'state_label'
      ? evidenceBox(crop.label_bbox || crop.inner_label_bbox || crop.state_label_bbox || crop.source_bbox,
        'state label bbox', cropIssues)
      : normalizeLineBbox(crop.label_bbox).box;
    const innerLabelBbox = kind === 'state_label'
      ? evidenceBox(crop.inner_label_bbox || crop.label_bbox || crop.state_label_bbox || crop.source_bbox,
        'inner state-label bbox', cropIssues)
      : normalizeLineBbox(crop.inner_label_bbox).box;
    const lineBbox = kind === 'line'
      ? evidenceBox(crop.line_bbox, 'crop line_bbox', cropIssues)
      : normalizeLineBbox(crop.line_bbox).box;
    const targetLineBboxInCropResult = normalizeLineBbox(crop.target_line_bbox_in_crop);
    if (kind === 'line' && crop.target_line_bbox_in_crop != null && !targetLineBboxInCropResult.localized) {
      cropIssues.push('crop-local target line bbox is malformed or outside normalized 0..1 coordinates');
    }
    const targetLineIds = new Set();
    const transitionMatches = transitions.get(transitionId) || [];
    const knownLineIds = new Set(transitionMatches.length === 1
      ? (Array.isArray(transitionMatches[0].line_hints) ? transitionMatches[0].line_hints : [])
        .map(line => String(line && line.line_id || '').trim()).filter(Boolean)
      : []);
    const targetLineBboxesInContext = (Array.isArray(crop.target_line_bboxes_in_context)
      ? crop.target_line_bboxes_in_context : []).filter(Boolean).map((target, targetIndex) => {
      const targetIssues = [];
      const targetLineId = String(target.line_id || '').trim();
      const lineIndexValue = Number(target.line_index);
      if (!targetLineId) targetIssues.push('context target line_id is missing');
      else if (targetLineIds.has(targetLineId)) targetIssues.push(`duplicate context target line_id "${targetLineId}"`);
      else if (knownLineIds.size && !knownLineIds.has(targetLineId)) {
        targetIssues.push(`foreign context target line_id "${targetLineId}"`);
      }
      targetLineIds.add(targetLineId);
      if (!Number.isInteger(lineIndexValue) || lineIndexValue < 0) {
        targetIssues.push('context target line_index is malformed');
      }
      const targetBbox = target.bbox == null
        ? (targetIssues.push('context target bbox is missing'), { x: -1, y: -1, w: -1, h: -1 })
        : evidenceBox(target.bbox, 'context target bbox', targetIssues);
      if (targetIssues.length) cropIssues.push(...targetIssues.map(issue =>
        `context target ${targetLineId || targetIndex}: ${issue}`));
      return {
        line_id: targetLineId,
        line_index: Number.isInteger(lineIndexValue) && lineIndexValue >= 0 ? lineIndexValue : null,
        bbox: targetBbox,
        issues: [...new Set(targetIssues)],
      };
    });
    const cropBboxResult = normalizeLineBbox(crop.crop_bbox);
    if (crop.crop_bbox != null && !cropBboxResult.localized) cropIssues.push(cropBboxResult.invalid
      ? 'crop_bbox is malformed or outside normalized 0..1 coordinates'
      : 'crop_bbox could not be localized');
    const originalSize = crop.original_size && typeof crop.original_size === 'object'
      ? { width: Number(crop.original_size.width), height: Number(crop.original_size.height) }
      : { width: NaN, height: NaN };
    if (!(originalSize.width > 0 && originalSize.height > 0)) cropIssues.push('original_size is missing or malformed');
    const out = {
      crop_id: cropId,
      transition_id: transitionId,
      line_id: lineId,
      observation_id: observationId,
      kind,
      source_bbox: sourceBbox,
      state_bbox: stateBbox,
      label_bbox: labelBbox,
      inner_label_bbox: innerLabelBbox,
      derived_from_state_bbox: Boolean(crop.derived_from_state_bbox),
      label_block_bbox: labelBlockBbox,
      state_label_bbox: stateLabelBbox,
      line_bbox: lineBbox,
      target_line_bbox_in_crop: targetLineBboxInCropResult.box,
      expanded_horizontally_from_line_bbox: Boolean(crop.expanded_horizontally_from_line_bbox),
      target_line_bboxes_in_context: targetLineBboxesInContext,
      crop_bbox: cropBboxResult.box,
      padding: cloneJson(crop.padding, null),
      original_size: Number.isFinite(originalSize.width) && Number.isFinite(originalSize.height)
        ? originalSize : null,
      image_role: String(crop.image_role || ''),
      image_present: Boolean(String(crop.image_url || '').trim()),
      issues: [...new Set([...suppliedIssues, ...cropIssues])],
      crop_notes: stringIssues(crop.crop_notes),
      scan_incomplete: cropIssues.length > 0,
    };
    const byId = cropIdMap.get(cropId) || [];
    byId.push(out);
    cropIdMap.set(cropId, byId);
    if (kind === 'line') {
      const key = `${transitionId}\u0000${lineId}`;
      const byLine = lineKeyMap.get(key) || [];
      byLine.push(out);
      lineKeyMap.set(key, byLine);
    } else if (kind === 'state_label') {
      const key = `${observationId}\u0000${cropId}`;
      const byState = stateKeyMap.get(key) || [];
      byState.push(out);
      stateKeyMap.set(key, byState);
    }
    return out;
  });
  cropIdMap.forEach((rows, id) => {
    if (!id || rows.length < 2) return;
    issues.push(`duplicate crop_id "${id}"`);
    rows.forEach(row => { row.issues.push(`duplicate crop_id "${id}"`); row.scan_incomplete = true; });
  });
  lineKeyMap.forEach((rows, key) => {
    if (rows.length < 2) return;
    issues.push(`duplicate line crop reference "${key.replace('\u0000', ':')}"`);
    rows.forEach(row => { row.issues.push('duplicate transition_id + line_id crop'); row.scan_incomplete = true; });
  });
  stateKeyMap.forEach((rows, key) => {
    if (rows.length < 2) return;
    issues.push(`duplicate state-label crop reference "${key.replace('\u0000', ':')}"`);
    rows.forEach(row => { row.issues.push('duplicate observation_id + crop_id state-label crop'); row.scan_incomplete = true; });
  });
  return { normalized, cropIdMap, lineKeyMap, stateKeyMap, transitions, states };
}

function normalizeLabelsStageResult(value, topologyEnvelope, crops, modelType, sessionValue) {
  const raw = adaptLabelWireResult(value || {});
  const immutableTopology = cloneJson(topologyEnvelope && topologyEnvelope.topology
    ? topologyEnvelope.topology : topologyEnvelope, {});
  const requestedSession = String(sessionValue || '').trim();
  const topologySession = String(topologyEnvelope && topologyEnvelope.scan_session_id || '').trim();
  const session = scanSessionId(requestedSession || topologySession);
  const topIssues = stringIssues(raw.issues);
  if (requestedSession && topologySession && requestedSession !== topologySession) {
    topIssues.push('labels scan_session_id does not match topology scan_session_id');
  }
  const topologyAudit = normalizeTopologyStageResult(immutableTopology, session);
  if (topologyAudit.review_only) topIssues.push('topology is review-only; labels cannot make it runnable');
  const cropAudit = normalizeCropManifest(crops, immutableTopology, topIssues);
  cropAudit.normalized.forEach(crop => {
    if (crop.scan_incomplete) topIssues.push(`crop ${crop.crop_id || '?'} is malformed or incomplete`);
  });

  const mode = String(modelType || 'pda').trim().toLowerCase();
  const isTm = mode === 'tm';
  const isPda = !isTm && mode !== 'dfa' && mode !== 'nfa';
  const readRows = Array.isArray(raw.label_reads) ? raw.label_reads.filter(Boolean) : [];
  const readKeyMap = new Map();
  const labelReads = readRows.map(row => {
    const cropId = String(row.crop_id || '').trim();
    const transitionId = String(row.transition_id || '').trim();
    const lineId = String(row.line_id || '').trim();
    const issues = stringIssues(row.issues);
    const matchingCrops = (cropAudit.cropIdMap.get(cropId) || []).filter(c => c.kind === 'line');
    if (matchingCrops.length !== 1) issues.push(matchingCrops.length
      ? `crop_id "${cropId}" is duplicated`
      : `foreign line crop_id "${cropId}"`);
    const matchingCrop = matchingCrops.length === 1 ? matchingCrops[0] : null;
    if (matchingCrop && (matchingCrop.transition_id !== transitionId || matchingCrop.line_id !== lineId)) {
      issues.push('label read transition_id/line_id does not match its crop manifest entry');
    }
    const bbox = evidenceBox(row.bbox || row.line_bbox, 'crop-local label bbox', issues);
    // Row identity and pixel provenance are different: a clipped zoom can be
    // read from its owning context without moving the rule to another row.
    const evidenceCropId = String(row.evidence_crop_id ?? cropId).trim();
    const evidenceMatches = cropAudit.cropIdMap.get(evidenceCropId) || [];
    const evidenceCrop = evidenceMatches.length === 1 ? evidenceMatches[0] : null;
    const ownEvidence = Boolean(matchingCrop && evidenceCrop &&
      evidenceCrop.transition_id === transitionId &&
      (evidenceCropId === cropId || evidenceCrop.kind === 'label_block'));
    let originalEvidenceBbox = null;
    if (!ownEvidence) issues.push('evidence_crop_id must identify the row zoom or a unique same-transition label_block');
    else {
      const local = normalizeLineBbox(bbox), frame = normalizeLineBbox(evidenceCrop.crop_bbox);
      if (evidenceCrop.scan_incomplete) issues.push('selected evidence crop is malformed or incomplete');
      if (!frame.localized) issues.push('selected evidence crop lacks valid original-frame crop_bbox');
      if (local.localized && frame.localized) {
        originalEvidenceBbox = {
          x: frame.box.x + local.box.x * frame.box.w,
          y: frame.box.y + local.box.y * frame.box.h,
          w: local.box.w * frame.box.w, h: local.box.h * frame.box.h,
        };
      }
      if (evidenceCropId !== cropId) {
        issues.push('label ink read from same-transition context; primary row localization requires review');
      }
    }
    const zones = row.zones && typeof row.zones === 'object' ? row.zones : {};
    const leftText = String(zones.left_text ?? '');
    const middleText = String(zones.middle_text ?? '');
    const rightText = String(zones.right_text ?? '');
    const rawText = String(row.raw_label_text ?? '');
    const observedAction = (row.stack_action && row.stack_action.type) ?? row.action;
    const action = normalizeStackAction(observedAction, row, rawText);
    let readValue = normalizeScannedSymbol((row.read_input && row.read_input.value) ?? row.read);
    let topValue = normalizeScannedSymbol((row.pop_value && row.pop_value.value) ?? row.top);
    let observedPush = normalizeScannedSymbol((row.push_value && row.push_value.value) ?? row.push);
    let observedPop = normalizeScannedSymbol((row.pop_symbol && row.pop_symbol.value) ?? row.pop_symbol);
    let readConfidence = Number((row.read_input && row.read_input.confidence) ?? DEFAULT_CONFIDENCE);
    let topConfidence = Number((row.pop_value && row.pop_value.confidence) ?? DEFAULT_CONFIDENCE);
    let actionConfidence = Number((row.stack_action && row.stack_action.confidence) ?? DEFAULT_CONFIDENCE);
    let pushConfidence = Number((row.push_value && row.push_value.confidence) ?? DEFAULT_CONFIDENCE);
    let popConfidence = Number((row.pop_symbol && row.pop_symbol.confidence) ?? DEFAULT_CONFIDENCE);
    if (!rawText.trim()) issues.push('raw_label_text is missing');
    if (isTm) {
      const parsed = parseTmLabel(rawText);
      if (!parsed) issues.push('TM label is malformed');
      readValue = normalizeScannedSymbol((parsed && parsed.read) ?? readValue);
      topValue = '';
      observedPush = '';
      observedPop = '';
    } else if (!isPda) {
      topValue = EPSILON;
      observedPush = EPSILON;
      observedPop = EPSILON;
      if (readValue === '?') issues.push('finite-automaton read is missing or unreadable');
    } else {
      const zoneRead = spatialSingleSymbol(leftText);
      const zoneTop = spatialSingleSymbol(middleText);
      const zoneAction = actionTypeFromText(rightText);
      const zoneActionValue = normalizeScannedSymbol(actionValueFromRawLabel(`x,x / ${rightText}`));
      if (!leftText.trim() || !zoneRead || zoneRead === '?') issues.push('LEFT-zone evidence is missing or unreadable');
      if (!middleText.trim() || !zoneTop || zoneTop === '?') issues.push('MIDDLE-zone evidence is missing or unreadable');
      if (!rightText.trim() || !zoneAction) issues.push('RIGHT-zone action evidence is missing or unapproved');
      if (zoneRead && zoneRead !== readValue) issues.push(`LEFT-zone evidence "${zoneRead}" conflicts with read_input "${readValue}"`);
      if (zoneTop && zoneTop !== topValue) issues.push(`MIDDLE-zone evidence "${zoneTop}" conflicts with STACK_TOP "${topValue}"`);
      if (zoneAction && zoneAction !== action) issues.push(`RIGHT-zone action ${zoneAction} conflicts with structured action ${action}`);
      const activeSymbol = action === 'PUSH' ? observedPush : observedPop;
      if ((action === 'PUSH' || action === 'POP') &&
          (zoneActionValue === '?' || zoneActionValue === EPSILON)) issues.push(`${action} symbol is missing or unreadable`);
      else if ((action === 'PUSH' || action === 'POP') && zoneActionValue !== activeSymbol) {
        issues.push(`RIGHT-zone action symbol "${zoneActionValue}" conflicts with structured symbol "${activeSymbol}"`);
      }
      if (action === 'UNKNOWN' || !normalizeActionToken(observedAction)) issues.push('structured ACTION is missing or unrecognized');
      if (readValue === '?') issues.push('INPUT is missing or unreadable');
      if (topValue === '?') issues.push('STACK_TOP is missing or unreadable');
      if (action === 'PUSH' && observedPush === '?') issues.push('PUSH symbol is missing or unreadable');
      if (action === 'POP' && observedPop === '?') issues.push('POP symbol is missing or unreadable');
      if (action === 'PUSH' && observedPop !== EPSILON) issues.push('inactive POP symbol conflicts with PUSH action');
      if (action === 'POP' && observedPush !== EPSILON) issues.push('inactive PUSH symbol conflicts with POP action');
      if (action === 'NONE' && (observedPush !== EPSILON || observedPop !== EPSILON)) {
        issues.push('inactive action symbols conflict with NONE action');
      }
      issues.push(...ruleSemanticIssues({ action, popValue: topValue, popSymbol: observedPop, pushValue: observedPush }));
    }
    const confidences = [readConfidence, topConfidence, actionConfidence,
      action === 'PUSH' ? pushConfidence : 1, action === 'POP' ? popConfidence : 1];
    if (confidences.some(c => !Number.isFinite(c) || c < 0.75)) issues.push('one or more field confidences are below review threshold');
    const overallConfidence = Number(row.confidence ?? Math.min(...confidences.filter(Number.isFinite)));
    if (!Number.isFinite(overallConfidence) || overallConfidence < 0.75) issues.push('label-read confidence is below review threshold');
    const normalized = {
      crop_id: cropId,
      evidence_crop_id: evidenceCropId,
      original_evidence_bbox: originalEvidenceBbox,
      transition_id: transitionId,
      line_id: lineId,
      raw_label_text: rawText,
      zones: { left_text: leftText, middle_text: middleText, right_text: rightText },
      bbox,
      read_input: { value: readValue, confidence: readConfidence },
      stack_action: { type: isPda ? action : 'NONE', confidence: actionConfidence },
      push_value: { value: isPda && action === 'PUSH' ? observedPush : (isPda ? EPSILON : observedPush), confidence: pushConfidence },
      pop_value: { value: topValue, confidence: topConfidence },
      pop_symbol: { value: isPda && action === 'POP' ? observedPop : (isPda ? EPSILON : observedPop), confidence: popConfidence },
      observed_fields: {
        action: observedAction == null ? '' : String(observedAction),
        push_symbol: observedPush,
        pop_symbol: observedPop,
        ...(row.stack_top ? { stack_top: cloneJson(row.stack_top, {}) } : {}),
      },
      ocr_alternatives: cloneJson(row.ocr_alternatives, null),
      confidence: Number.isFinite(overallConfidence) ? overallConfidence : 0,
      issues: [...new Set(issues)],
      field_notes: [...new Set(issues)],
      scan_incomplete: issues.length > 0,
      review_only: issues.length > 0,
    };
    const key = `${cropId}\u0000${transitionId}\u0000${lineId}`;
    const matches = readKeyMap.get(key) || [];
    matches.push(normalized);
    readKeyMap.set(key, matches);
    return normalized;
  });
  readKeyMap.forEach((rows, key) => {
    if (rows.length < 2) return;
    topIssues.push(`duplicate label read identity "${key.replaceAll('\u0000', ':')}"`);
    rows.forEach(row => {
      row.issues = [...new Set([...row.issues, 'duplicate label read identity'])];
      row.field_notes = [...row.issues];
      row.scan_incomplete = true;
      row.review_only = true;
    });
  });

  const stateReadRows = Array.isArray(raw.state_label_reads) ? raw.state_label_reads.filter(Boolean) : [];
  const stateReadKeyMap = new Map();
  const stateLabelReads = stateReadRows.map(row => {
    const cropId = String(row.crop_id || '').trim();
    const observationId = String(row.observation_id || '').trim();
    const visibleLabel = String(row.visible_label ?? '').trim();
    const issues = stringIssues(row.issues);
    const matchingCrops = (cropAudit.cropIdMap.get(cropId) || []).filter(c => c.kind === 'state_label');
    if (matchingCrops.length !== 1) issues.push(matchingCrops.length
      ? `state-label crop_id "${cropId}" is duplicated`
      : `foreign state-label crop_id "${cropId}"`);
    const matchingCrop = matchingCrops.length === 1 ? matchingCrops[0] : null;
    if (matchingCrop && matchingCrop.observation_id !== observationId) {
      issues.push('state-label read observation_id does not match its crop manifest entry');
    }
    const stateMatches = cropAudit.states.get(observationId) || [];
    if (!observationId || stateMatches.length !== 1) issues.push(!observationId
      ? 'state-label read observation_id is missing'
      : `foreign or duplicate state observation_id "${observationId}"`);
    if (!visibleLabel || visibleLabel === '?' || /^[�□▯▢◻◼⬜⬛]+$/.test(visibleLabel)) {
      issues.push('state visible_label is missing or unreadable; no q-label was invented');
    }
    let confidence = Number(row.confidence);
    if (!Number.isFinite(confidence)) { confidence = 0; issues.push('state-label confidence is missing or malformed'); }
    else if (confidence < 0.75) issues.push('state-label confidence is below review threshold');
    const forbidden = ['bbox', 'circle_bbox', 'is_start', 'is_accepting', 'source_observation_id',
      'target_observation_id', 'source_state', 'target_state', 'transition_id'];
    const attempted = forbidden.filter(key => Object.prototype.hasOwnProperty.call(row, key));
    if (attempted.length) {
      issues.push(`state-label read attempted to overwrite forbidden topology fields: ${attempted.join(', ')}`);
    }
    const normalized = {
      crop_id: cropId,
      observation_id: observationId,
      visible_label: visibleLabel,
      confidence,
      ocr_alternatives: cloneJson(row.ocr_alternatives, null),
      issues: [...new Set(issues)],
      scan_incomplete: issues.length > 0,
      review_only: issues.length > 0,
    };
    const key = `${observationId}\u0000${cropId}`;
    const rows = stateReadKeyMap.get(key) || [];
    rows.push(normalized);
    stateReadKeyMap.set(key, rows);
    return normalized;
  });
  stateReadKeyMap.forEach((rows, key) => {
    if (rows.length < 2) return;
    topIssues.push(`duplicate state-label read identity "${key.replace('\u0000', ':')}"`);
    rows.forEach(row => {
      row.issues = [...new Set([...row.issues, 'duplicate state-label read identity'])];
      row.scan_incomplete = true;
      row.review_only = true;
    });
  });

  const topologyStates = Array.isArray(immutableTopology.states) ? immutableTopology.states : [];
  topologyStates.forEach(state => {
    const observationId = String(state && state.observation_id || '').trim();
    const stateCrops = cropAudit.normalized.filter(crop =>
      crop.kind === 'state_label' && crop.observation_id === observationId);
    const reads = stateLabelReads.filter(read => read.observation_id === observationId);
    if (stateCrops.length !== 1) {
      topIssues.push(`state ${observationId || '?'} has ${stateCrops.length} state-label crops; exactly one is required`);
    }
    if (reads.length !== 1) {
      topIssues.push(`state ${observationId || '?'} has ${reads.length} state-label reads; exactly one is required`);
    }
    if (stateCrops.length === 1) {
      const matchingReads = reads.filter(read => read.crop_id === stateCrops[0].crop_id);
      if (matchingReads.length !== 1) {
        topIssues.push(`missing or duplicate state-label read for ${observationId}:${stateCrops[0].crop_id}`);
      }
    }
  });

  const topologyTransitions = Array.isArray(immutableTopology.transitions) ? immutableTopology.transitions
    : (Array.isArray(immutableTopology.connectors) ? immutableTopology.connectors : []);
  topologyTransitions.forEach(transition => {
    const transitionId = String(transition && transition.transition_id || '').trim();
    const hints = Array.isArray(transition && transition.line_hints) ? transition.line_hints : [];
    const expectedKeys = hints.map(h => `${transitionId}\u0000${String(h && h.line_id || '').trim()}`);
    const lineCrops = cropAudit.normalized.filter(c => c.kind === 'line' && c.transition_id === transitionId);
    const reads = labelReads.filter(r => r.transition_id === transitionId);
    if (lineCrops.length !== expectedKeys.length) {
      topIssues.push(`transition ${transitionId} has ${expectedKeys.length} topology line hints but ${lineCrops.length} line crops`);
    }
    if (reads.length !== expectedKeys.length) {
      topIssues.push(`transition ${transitionId} has ${expectedKeys.length} expected label lines but ${reads.length} label reads`);
    }
    expectedKeys.forEach(key => {
      const cropMatches = cropAudit.lineKeyMap.get(key) || [];
      if (cropMatches.length !== 1) topIssues.push(`missing or duplicate line crop for ${key.replace('\u0000', ':')}`);
      const [tid, lid] = key.split('\u0000');
      const readMatches = labelReads.filter(r => r.transition_id === tid && r.line_id === lid);
      if (readMatches.length !== 1) topIssues.push(`missing or duplicate label read for ${tid}:${lid}`);
    });
  });
  if (topologyAudit.review_only) {
    labelReads.forEach(row => {
      row.issues = [...new Set([...row.issues, 'topology contract is review-only'])];
      row.field_notes = [...row.issues];
      row.scan_incomplete = true;
      row.review_only = true;
    });
    stateLabelReads.forEach(row => {
      row.issues = [...new Set([...row.issues, 'topology contract is review-only'])];
      row.scan_incomplete = true;
      row.review_only = true;
    });
  }
  const issues = [...new Set(topIssues)];
  const reviewOnly = issues.length > 0 || labelReads.some(row => row.review_only) ||
    stateLabelReads.some(row => row.review_only) || cropAudit.normalized.some(crop => crop.scan_incomplete);
  return {
    stage: 'labels',
    scan_session_id: session,
    topology: immutableTopology,
    crop_manifest: cropAudit.normalized,
    label_reads: labelReads,
    state_label_reads: stateLabelReads,
    issues,
    review_only: reviewOnly,
  };
}

function normalizedBboxSchema() {
  return {
    type: 'object', additionalProperties: false,
    properties: {
      x: { type: 'number', minimum: -1, maximum: 1 },
      y: { type: 'number', minimum: -1, maximum: 1 },
      w: { type: 'number', minimum: -1, maximum: 1 },
      h: { type: 'number', minimum: -1, maximum: 1 },
    },
    required: ['x', 'y', 'w', 'h'],
  };
}

function issueArraySchema() {
  return { type: 'array', items: { type: 'string' } };
}

function topologyInventorySchema() {
  const categoricalEvidence = values => ({
    type: 'object', additionalProperties: false,
    properties: {
      value: { type: 'string', enum: values },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['value', 'confidence'],
  });
  return {
    type: 'object', additionalProperties: false,
    properties: {
      visible_state_circle_count: { type: 'integer', minimum: 0 },
      visible_computational_arrowhead_count: { type: 'integer', minimum: 0 },
      state_circle_candidates: {
        type: 'array', items: {
          type: 'object', additionalProperties: false,
          properties: {
            candidate_id: { type: 'string' },
            bbox: normalizedBboxSchema(),
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            issues: issueArraySchema(),
          },
          required: ['candidate_id', 'bbox', 'confidence', 'issues'],
        },
      },
      computational_arrowhead_candidates: {
        type: 'array', items: {
          type: 'object', additionalProperties: false,
          properties: {
            candidate_id: { type: 'string' },
            bbox: normalizedBboxSchema(),
            orientation: categoricalEvidence(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'UNKNOWN']),
            self_loop_hint: categoricalEvidence(['YES', 'NO', 'UNKNOWN']),
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            issues: issueArraySchema(),
          },
          required: ['candidate_id', 'bbox', 'orientation', 'self_loop_hint', 'confidence', 'issues'],
        },
      },
      issues: issueArraySchema(),
    },
    required: ['visible_state_circle_count', 'visible_computational_arrowhead_count',
      'state_circle_candidates', 'computational_arrowhead_candidates', 'issues'],
  };
}

function topologyTargetedTraceSchema() {
  const categoricalEvidence = values => ({
    type: 'object', additionalProperties: false,
    properties: {
      value: { type: 'string', enum: values },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['value', 'confidence'],
  });
  return {
    type: 'object', additionalProperties: false,
    properties: {
      candidate_traces: {
        type: 'array', items: {
          type: 'object', additionalProperties: false,
          properties: {
            candidate_id: { type: 'string' },
            verdict: { type: 'string', enum: ['MATCHES_EXISTING', 'VERIFIED_OMITTED',
              'NOT_ARROWHEAD', 'START_MARKER', 'UNCERTAIN'] },
            evidence_crop_id: { type: 'string' },
            arrowhead_bbox_in_crop: normalizedBboxSchema(),
            connector_bbox_in_crop: normalizedBboxSchema(),
            tail_contact_bbox_in_crop: normalizedBboxSchema(),
            trace_status: { type: 'string', enum: ['COMPLETE', 'PARTIAL', 'AMBIGUOUS'] },
            source_observation_id: { type: 'string' },
            target_observation_id: { type: 'string' },
            existing_transition_id: { type: 'string' },
            orientation: categoricalEvidence(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'UNKNOWN']),
            self_loop: categoricalEvidence(['YES', 'NO', 'UNKNOWN']),
            candidate_confidence: { type: 'number', minimum: 0, maximum: 1 },
            endpoint_confidence: { type: 'number', minimum: 0, maximum: 1 },
            connector_confidence: { type: 'number', minimum: 0, maximum: 1 },
            issues: issueArraySchema(),
          },
          required: ['candidate_id', 'verdict', 'evidence_crop_id', 'arrowhead_bbox_in_crop',
            'connector_bbox_in_crop', 'tail_contact_bbox_in_crop', 'trace_status',
            'source_observation_id', 'target_observation_id', 'existing_transition_id',
            'orientation', 'self_loop', 'candidate_confidence', 'endpoint_confidence',
            'connector_confidence', 'issues'],
        },
      },
      issues: issueArraySchema(),
    },
    required: ['candidate_traces', 'issues'],
  };
}

function topologyLineGeometryAuditSchema() {
  return {
    type: 'object', additionalProperties: false,
    properties: {
      connector_lines: {
        type: 'array', items: {
          type: 'object', additionalProperties: false,
          properties: {
            transition_id: { type: 'string' },
            label_block_bbox: normalizedBboxSchema(),
            visible_line_count: { type: 'integer', minimum: 0 },
            line_hints: {
              type: 'array', items: {
                type: 'object', additionalProperties: false,
                properties: {
                  line_id: { type: 'string' },
                  bbox: normalizedBboxSchema(),
                  confidence: { type: 'number', minimum: 0, maximum: 1 },
                  issues: issueArraySchema(),
                },
                required: ['line_id', 'bbox', 'confidence', 'issues'],
              },
            },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            issues: issueArraySchema(),
          },
          required: ['transition_id', 'label_block_bbox', 'visible_line_count',
            'line_hints', 'confidence', 'issues'],
        },
      },
      issues: issueArraySchema(),
    },
    required: ['connector_lines', 'issues'],
  };
}

function topologyStageSchema() {
  const bbox = () => normalizedBboxSchema();
  const booleanEvidence = () => ({
    type: 'object', additionalProperties: false,
    properties: { value: { type: 'boolean' }, confidence: { type: 'number' } },
    required: ['value', 'confidence'],
  });
  return {
    type: 'object', additionalProperties: false,
    properties: {
      visible_state_count: { type: 'integer', minimum: 0 },
      visible_connector_count: { type: 'integer', minimum: 0 },
      states: {
        type: 'array', items: {
          type: 'object', additionalProperties: false,
          properties: {
            observation_id: { type: 'string' },
            bbox: bbox(),
            is_start: booleanEvidence(),
            is_accepting: booleanEvidence(),
            confidence: { type: 'number' },
            issues: issueArraySchema(),
          },
          required: ['observation_id', 'bbox', 'is_start', 'is_accepting', 'confidence', 'issues'],
        },
      },
      start_marker_observations: {
        type: 'array', items: {
          type: 'object', additionalProperties: false,
          properties: {
            marker_id: { type: 'string' },
            target_observation_id: { type: 'string' },
            marker_bbox: bbox(),
            arrowhead_bbox: bbox(),
            confidence: { type: 'number' },
            issues: issueArraySchema(),
          },
          required: ['marker_id', 'target_observation_id', 'marker_bbox', 'arrowhead_bbox', 'confidence', 'issues'],
        },
      },
      connector_observations: {
        type: 'array', items: {
          type: 'object', additionalProperties: false,
          properties: {
            connector_observation_id: { type: 'string' },
            connector_bbox: bbox(),
            arrowhead_bbox: bbox(),
            label_block_bbox: bbox(),
            visible_line_count: { type: 'integer', minimum: 0 },
            line_hints: {
              type: 'array', items: {
                type: 'object', additionalProperties: false,
                properties: {
                  line_id: { type: 'string' },
                  bbox: bbox(),
                  confidence: { type: 'number' },
                  issues: issueArraySchema(),
                },
                required: ['line_id', 'bbox', 'confidence', 'issues'],
              },
            },
            confidence: { type: 'number' },
            issues: issueArraySchema(),
          },
          required: ['connector_observation_id', 'connector_bbox', 'arrowhead_bbox', 'label_block_bbox',
            'visible_line_count', 'line_hints', 'confidence', 'issues'],
        },
      },
      transitions: {
        type: 'array', items: {
          type: 'object', additionalProperties: false,
          properties: {
            transition_id: { type: 'string' },
            connector_observation_id: { type: 'string' },
            source_observation_id: { type: 'string' },
            target_observation_id: { type: 'string' },
            confidence: { type: 'number' },
            issues: issueArraySchema(),
          },
          required: ['transition_id', 'connector_observation_id', 'source_observation_id',
            'target_observation_id', 'confidence', 'issues'],
        },
      },
      issues: issueArraySchema(),
    },
    required: ['visible_state_count', 'visible_connector_count', 'states', 'start_marker_observations',
      'connector_observations', 'transitions', 'issues'],
  };
}

function labelsStageSchema() {
  const valueConfidence = () => ({
    type: 'object', additionalProperties: false,
    properties: { value: { type: 'string' }, confidence: { type: 'number' } },
    required: ['value', 'confidence'],
  });
  return {
    type: 'object', additionalProperties: false,
    properties: {
      state_label_reads: {
        type: 'array', items: {
          type: 'object', additionalProperties: false,
          properties: {
            crop_id: { type: 'string' },
            observation_id: { type: 'string' },
            visible_label: { type: 'string' },
            confidence: { type: 'number' },
            issues: issueArraySchema(),
          },
          required: ['crop_id', 'observation_id', 'visible_label', 'confidence', 'issues'],
        },
      },
      label_reads: {
        type: 'array', items: {
          type: 'object', additionalProperties: false,
          properties: {
            crop_id: { type: 'string' },
            evidence_crop_id: { type: 'string', description: 'The image whose local coordinate frame contains bbox: either this row crop_id or its same-transition label_block crop_id. Row identity stays in crop_id.' },
            transition_id: { type: 'string' },
            line_id: { type: 'string' },
            raw_label_text: { type: 'string' },
            zones: {
              type: 'object', additionalProperties: false,
              properties: {
                left_text: { type: 'string' }, middle_text: { type: 'string' }, right_text: { type: 'string' },
              },
              required: ['left_text', 'middle_text', 'right_text'],
            },
            bbox: normalizedBboxSchema(),
            read_input: valueConfidence(),
            stack_action: {
              type: 'object', additionalProperties: false,
              properties: {
                type: { type: 'string', enum: ['PUSH', 'POP', 'NONE', 'UNKNOWN'] },
                confidence: { type: 'number' },
              },
              required: ['type', 'confidence'],
            },
            push_value: valueConfidence(),
            stack_top: { ...valueConfidence(), description: 'MIDDLE zone: the required existing stack-top symbol BEFORE the action, for PUSH, POP and NONE alike. This is a condition, never an item to remove. Transcribe the middle symbol even when action is NONE.' },
            pop_symbol: valueConfidence(),
            confidence: { type: 'number' },
            issues: issueArraySchema(),
          },
          required: ['crop_id', 'evidence_crop_id', 'transition_id', 'line_id', 'raw_label_text', 'zones', 'bbox',
            'read_input', 'stack_action', 'push_value', 'stack_top', 'pop_symbol', 'confidence', 'issues'],
        },
      },
      issues: issueArraySchema(),
    },
    required: ['state_label_reads', 'label_reads', 'issues'],
  };
}

// The legacy application calls the stack-top guard `pop_value`. Do not expose
// that misleading name to OCR: real responses used ε for it on PUSH/NONE.
// This adapter only renames an explicitly supplied field; it never reads a
// condition from raw text or derives the separately observed POP operand.
function adaptLabelWireResult(value) {
  if (!value || !Array.isArray(value.label_reads)) return value;
  return { ...value, label_reads:value.label_reads.map(row => {
    if (!row || !Object.prototype.hasOwnProperty.call(row,'stack_top')) return row;
    if (Object.prototype.hasOwnProperty.call(row,'pop_value')) {
      if(JSON.stringify(row.stack_top)===JSON.stringify(row.pop_value)) return row;
      return { ...row, issues:[...stringIssues(row.issues),'stack_top conflicts with legacy pop_value; ambiguous guard evidence'] };
    }
    return { ...row, pop_value:row.stack_top };
  }) };
}

function normalizedImageRoles(urls, imageRoles) {
  const supplied = Array.isArray(imageRoles) ? imageRoles : [];
  return urls.map((_, index) => {
    const role = String(supplied[index] || '').trim().toLowerCase();
    return ['enhanced_same_frame', 'ink_same_frame', 'original_same_frame',
      'independent_crop', 'independent_drawing', 'typeset_reference'].includes(role)
      ? role : 'unspecified';
  });
}

async function callVisionJson({ urls, captions, prompt, schema, schemaName, instructions, model = MODEL,
  telemetry = {} }) {
  if (!process.env.OPENAI_API_KEY) {
    const err = new Error('OPENAI_API_KEY is missing. Put it in .env');
    err.status = 401;
    throw err;
  }
  assertScanBudget(model);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  try {
    const content = [{ type: 'input_text', text: prompt }];
    urls.forEach((imageUrl, index) => {
      content.push({ type: 'input_text', text: String(captions[index] || `IMAGE ${index + 1}`) });
      content.push({ type: 'input_image', image_url: imageUrl, detail: 'high' });
    });
    const reasoning = openAIReasoning(model, telemetry.attempt === 'escalation');
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        instructions,
        ...(reasoning ? { reasoning } : {}),
        input: [{ role: 'user', content }],
        max_output_tokens: 7000,
        text: { format: { type: 'json_schema', name: schemaName, schema, strict: true } },
      }),
    });
    const body = await response.text();
    if (!response.ok) {
      const err = new Error(body || `OpenAI request failed with ${response.status}`);
      err.status = response.status;
      throw err;
    }
    const data = JSON.parse(body);
    recordOpenAIUsage(data, model, telemetry);
    const outputText = data.output_text || (data.output || [])
      .flatMap(item => item.content || []).map(part => part.text || '').join('');
    if (!outputText) throw new Error('OpenAI returned an empty response');
    return JSON.parse(outputText);
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
}

async function parseTopologyStage(imageUrls, imageRoles, requestedSession) {
  const urls = (Array.isArray(imageUrls) ? imageUrls : [imageUrls]).filter(Boolean);
  const roles = normalizedImageRoles(urls, imageRoles);
  const session = scanSessionId(requestedSession);
  const roleManifest = roles.map((role, index) => `IMAGE ${index + 1}: ${role}`).join('; ');
  const prompt = [
    'STAGE A — GEOMETRY/TOPOLOGY ONLY. Do not read, transcribe, infer, repair, or output any state label or transition-label character. No input symbols, stack symbols, action words, or semantic state ids belong in this stage.',
    `IMAGE ROLE MANIFEST: ${roleManifest || 'none'}. ONLY enhanced_same_frame, ink_same_frame, and original_same_frame are aligned views of one original frame. unspecified and every other role are geometrically independent and must never be cross-aligned.`,
    'Run independent physical counting passes before associations. visible_state_count is the number of real state circles. visible_connector_count counts ONLY computational transition arrows between/from states. An incoming arrow from empty space is a START MARKER only: put it in start_marker_observations, use it as evidence for the target state is_start field, and EXCLUDE it from visible_connector_count, connector_observations, and transitions because it has no source state and consumes no input. Then emit exactly one states row per circle and one connector_observations row per computational transition connector. Do not hide an omitted object by changing a count.',
    'COVERAGE AUDIT: sweep the page as a 3-by-3 grid from top-left to bottom-right and record every black-ink state circle and every distinct black-ink arrowhead before linking anything. Then make a second independent sweep by tracing every connector from its tail to its arrowhead, including back-edges, diagonals, vertical edges, self-loops, and connectors near the page boundaries. Reconcile the two sweeps; do not stop after finding an apparent left-to-right backbone.',
    'Every physical state gets a unique observation_id (state_1, state_2, ...), a normalized 0..1 bbox in the original frame, confidence, and issues. The bbox must conservatively contain the ENTIRE outer circle stroke (both strokes for an accepting state), never merely the inner text or circle center. observation_id is opaque physical identity, never an OCR label. is_start and is_accepting are independent visual-evidence objects {value,confidence}; circle confidence must not make a faint start arrow or faint double border look confidently false. Use low confidence and an issue whenever either property is uncertain.',
    'ACCEPTING-BORDER AUDIT: inspect every state circumference at high zoom for two distinct nested circle strokes. A faint or partially obscured second border is uncertainty, not confident false. Trace both rings around the same center; state-label ink, notebook ruling, a connector crossing the circle, or a retraced segment of one ring must never become a second accepting border.',
    'For every initial arrow from empty space, emit one start_marker_observations row with its own marker_id, target_observation_id, marker_bbox, arrowhead_bbox, confidence, and issues. It is not a connector/transition. is_start.value must agree with these separate marker observations; never infer start from a state name such as q0.',
    'Every physical connector gets a unique connector_observation_id, connector_bbox, arrowhead_bbox, label_block_bbox, visible_line_count, and one unique line_id+bbox per visibly separate label baseline. Count partly unreadable lines. label_block_bbox and every line-hint bbox must conservatively contain ALL ink belonging to the block/line with a small visual margin; an overly tight box that clips ascenders, Hebrew action text, punctuation, or the first/last glyph is invalid. Coordinates are normalized 0..1 in that same original frame; use all -1 when genuinely unlocalized.',
    'SELF-LOOP AUDIT: after the first connector count, inspect the complete circumference of EACH state clockwise for a stroke that leaves and re-enters that same circle. A small side/bottom loop is still one computational connector when a physical arrowhead is visible. Conversely, nearby text without a loop stroke is not a connector. SELF-LOOP OWNERSHIP is determined by the one circle boundary physically touched twice by that loop stroke. Trace both contact points and the arrowhead back to that exact circle; never assign the loop to a neighbouring state merely because its center or label block is closer.',
    'DIRECTION AUDIT: zoom mentally into every arrowhead_bbox and verify the target independently. Horizontal arrows along the bottom or top may point left; diagonal return arrows and back-edges are common. Never use page-reading direction or state position as a substitute for the visible arrowhead.',
    'Only after the independent connector observation pass, emit transitions linking transition_id to connector_observation_id and physical source_observation_id/target_observation_id. Determine direction only from the arrowhead. If either endpoint is uncertain, use an empty observation id, add an issue, and never invent an endpoint.',
    'connector_observations and transitions are separate evidence tables. Every connector observation should map one-to-one to a transition, but if the visual evidence remains inconsistent, preserve the mismatch in the arrays/issues; do not invent or delete an object to make counts equal.',
    'Scribbles are ignored only when stroke morphology independently establishes a scribble. A faint, crooked, partial, initial, or self-loop connector is not a scribble merely because its role is hard to determine. Overlapping scribble/object fate remains undefined: preserve visible uncertainty.',
    'NOTEBOOK RULING/BACKGROUND GRID: regular parallel page-spanning blue ruling lines are paper background. They are NOT connectors, circle strokes, arrowheads, label line hints, comma/slash separators, or scribbles, and they never enter counts. Black automaton ink remains real visible evidence when it crosses a blue ruling line; do not erase, split, or lower it merely because of that crossing.',
    'Return only the strict JSON. Again: this stage must contain geometry, opaque observation ids, counts, confidence, and issues—never label text.',
  ].join('\n');
  const parsed = await callVisionJson({
    urls,
    captions: roles.map((role, index) => `IMAGE ${index + 1} ROLE: ${role}`),
    prompt,
    schema: topologyStageSchema(),
    schemaName: 'automaton_topology_stage',
    model: TOPOLOGY_MODEL,
  });
  return normalizeTopologyStageResult(parsed, session);
}

function buildTopologyInventoryPrompt(fullRoles, tileManifest, manifestIssues, modelType) {
  return [
    'INDEPENDENT GEOMETRIC INVENTORY — PIXELS ONLY. No prior topology is supplied to this pass. Do not read, transcribe, infer, or output any state label, transition label, input symbol, stack symbol, action word, semantic state id, endpoint association, or rule-line count.',
    `MODEL TYPE CONTEXT (geometry only): ${String(modelType || 'pda').trim().toLowerCase()}. It never authorizes OCR or expected-language reasoning.`,
    `FULL-IMAGE ROLE MANIFEST: ${JSON.stringify(fullRoles)}. Only a role explicitly named original_same_frame is the full normalized 0..1 coordinate frame.`,
    `TOPOLOGY TILE MANIFEST: ${JSON.stringify(tileManifest)}. Each valid original_bbox maps that tile back to the full original frame. Tiles are zoom evidence only; never count the same physical circle or arrowhead twice because it appears in overlapping tiles.`,
    `TOPOLOGY TILE MANIFEST VALIDATION ISSUES: ${JSON.stringify([...new Set(manifestIssues)])}. A missing/invalid mapping is unlocalized evidence and must not be placed by guesswork.`,
    'Perform an independent 3-by-3 sweep of the full frame. First inventory every physical state-circle outline as one state_circle_candidate with an opaque candidate_id and a bbox containing the complete outer circle. A double accepting border is still one physical state circle. Do not read the text inside it.',
    'Then inventory every DISTINCT COMPUTATIONAL ARROWHEAD as one computational_arrowhead_candidate. Count the visible physical arrowhead, not labels, line baselines, expected transitions, or the prior exercise logic. An incoming arrow from empty space is a START MARKER and must be EXCLUDED from the computational-arrowhead count and candidates. If computational-vs-start identity remains uncertain, preserve low confidence and an issue rather than making the drawing complete by assumption.',
    'For each computational arrowhead candidate, bbox only the visible arrowhead ink with a small margin. orientation.value is the direction the arrowhead points TOWARD its target: N, NE, E, SE, S, SW, W, NW, or UNKNOWN. Determine it from the tip/wings, never page-reading direction. Give special scrutiny to the bottom-left region, left-pointing bottom arrows, vertical arrows, diagonals, and return edges.',
    'For self_loop_hint, inspect the complete 360-degree circumference of the nearby state and report YES only when local stroke evidence shows this arrowhead belongs to a connector that leaves and re-enters that same circle; NO only when physical geometry rules that out; otherwise UNKNOWN. This is a hint, not an endpoint assignment.',
    'visible_state_circle_count and visible_computational_arrowhead_count are independent physical counts and must equal their corresponding candidate-array lengths. Do not fabricate a candidate to satisfy a count and do not lower a count to hide a candidate whose role is uncertain.',
    'Regular parallel blue notebook ruling is background. Scribbles may be ignored only when stroke morphology independently establishes scribble; lack of an understood role is never proof of scribble. Overlap remains uncertain. A connector line without a localized physical arrowhead is not permission to invent an arrowhead candidate.',
    'Return only the strict geometric-inventory JSON. No topology, no endpoints, no labels, and no prose.',
  ].join('\n');
}

function buildTopologyReplacementAuditPrompt(initialTopology, inventory, fullRoles, tileManifest,
  manifestIssues, modelType) {
  return [
    'TOPOLOGY AUDIT STAGE — GEOMETRY ONLY. Return one COMPLETE replacement topology object in the exact topology schema. This is not a patch. Do not read, transcribe, infer, repair, or output any state label, transition label, input symbol, stack symbol, or action word.',
    `MODEL TYPE CONTEXT (geometry only): ${String(modelType || 'pda').trim().toLowerCase()}. It never authorizes semantic OCR in this stage.`,
    `FALLIBLE INITIAL TOPOLOGY EVIDENCE: ${JSON.stringify(initialTopology)}`,
    `INDEPENDENT PIXEL INVENTORY EVIDENCE: ${JSON.stringify(inventory)}. This inventory was produced without seeing the initial topology, but it remains fallible evidence rather than an instruction to add objects. Reconfirm every candidate in the pixels. Never invent a state or connector merely to reconcile a count; preserve any mismatch in issues for human review.`,
    `FULL-IMAGE ROLE MANIFEST: ${JSON.stringify(fullRoles)}. Only a role explicitly named original_same_frame is the full coordinate frame.`,
    `TOPOLOGY TILE MANIFEST: ${JSON.stringify(tileManifest)}. Each valid original_bbox maps that crop's pixels back into the normalized 0..1 original frame. A tile is supplemental visual evidence, not a state or connector and never changes a count merely by existing. A tile with an invalid/missing original_bbox is unlocalized evidence and must not be placed by guesswork.`,
    `TOPOLOGY TILE MANIFEST VALIDATION ISSUES: ${JSON.stringify([...new Set(manifestIssues)])}. Preserve these uncertainties; never repair a malformed mapping by visual guesswork.`,
    'The initial topology and independent inventory are both fallible. Reinspect the pixels before accepting any count, bbox, endpoint, arrow direction, self-loop, start marker, accepting border, or visible-line count. Preserve an existing observation_id, connector_observation_id, transition_id, marker_id, or line_id only when it still refers to the SAME physical ink object. Add a fresh opaque id only for a genuinely verified omitted physical object. Do not transfer an old id onto a different object merely to keep arrays stable.',
    'WHOLE-FRAME COVERAGE: sweep the original frame as a 3-by-3 grid, left-to-right and top-to-bottom, counting physical state circles and distinct computational arrowheads independently before endpoint association. Use tiles to zoom the corresponding original_bbox, then reconcile both fallible evidence sets with the pixels. Do not stop at a left-to-right backbone and do not hide an omission by lowering a visible count.',
    'ACCEPTING-BORDER AUDIT: use the close state-neighbourhood tiles to inspect each state for two distinct nested circle strokes around the same center. A faint, open, or partly occluded possible second ring requires low confidence plus an issue, never confident false. Do not mistake state-label ink, blue ruling, connector crossings, or a locally retraced single border for the second ring.',
    'SELF-LOOP AUDIT: inspect the entire 360-degree circumference of every state. Short side loops, bottom loops, top loops, and faint loops are computational connectors only when a physical stroke leaves and re-enters the same state with a visible arrowhead. Nearby label ink alone is not a loop. For every verified loop, trace its two boundary contacts and arrowhead to the exact owning state; never transfer it to the next state because of label proximity or page-reading order.',
    'DIRECTION AUDIT: determine target only from the physical arrowhead tip. Give special scrutiny to arrows and arrowheads in the bottom-left of the drawing, bottom horizontal arrows that point left, vertical arrows, diagonal return arrows, and back-edges. Page-reading direction and state position are never substitutes for an arrowhead.',
    'Start arrows from empty space are start_marker_observations only and are excluded from visible_connector_count, connector_observations, and transitions. Computational connectors must maintain one physical connector observation and one transition association; preserve unresolved disagreement in issues rather than inventing an endpoint.',
    'Count every visibly separate transition-label baseline geometrically even when its text is unreadable. Emit line_id plus bbox evidence only; never OCR its glyphs. Do not infer extra baselines from the number of rules expected or from neighbouring text. All bboxes use normalized original-frame coordinates, not crop-local coordinates.',
    'Regular parallel blue notebook ruling is background, not automaton ink. Scribbles may be ignored only when stroke morphology independently establishes a scribble; lack of an understood role never proves scribble. Overlap between scribble and a real component remains unresolved and must be represented as uncertainty.',
    'Return only strict JSON satisfying the complete topology schema. No prose and no semantic labels.',
  ].join('\n');
}

function topologyLineGeometryConnectorManifest(topologyEnvelope) {
  const topology = topologyEnvelope && topologyEnvelope.topology
    ? topologyEnvelope.topology : (topologyEnvelope || {});
  const transitions = Array.isArray(topology.transitions) ? topology.transitions
    : (Array.isArray(topology.connectors) ? topology.connectors : []);
  return transitions.filter(Boolean).map(transition => ({
    transition_id: String(transition.transition_id || ''),
    connector_observation_id: String(transition.connector_observation_id || ''),
    connector_bbox: cloneJson(transition.connector_bbox),
    arrowhead_bbox: cloneJson(transition.arrowhead_bbox),
    current_label_block_bbox: cloneJson(transition.label_block_bbox),
    current_visible_line_count: transition.visible_line_count,
    current_line_hints: cloneJson(transition.line_hints, []),
  }));
}

function buildTopologyLineGeometryAuditPrompt(connectorManifest, fullRoles, tileManifest,
  manifestIssues, modelType) {
  return [
    'INDEPENDENT LINE-GEOMETRY AUDIT — PIXELS ONLY, NO OCR. The computational connectors already exist and are immutable. Return geometry for exactly one label block per supplied transition_id. Never add, remove, merge, split, redirect, or renumber a state, connector, endpoint, transition, start marker, or accepting state.',
    `MODEL TYPE CONTEXT (geometry only): ${String(modelType || 'pda').trim().toLowerCase()}. Do not read or interpret input symbols, stack symbols, actions, state names, or language semantics.`,
    `IMMUTABLE FINAL CONNECTOR GEOMETRY MANIFEST: ${JSON.stringify(connectorManifest)}. connector_bbox and arrowhead_bbox identify the existing physical connector. Current label-block/count/line-hint values are fallible comparison evidence. Emit exactly one connector_lines row for every manifest transition_id and no foreign id.`,
    `FULL-IMAGE ROLE MANIFEST: ${JSON.stringify(fullRoles)}. Only original_same_frame is the full normalized 0..1 coordinate frame.`,
    `TOPOLOGY TILE MANIFEST: ${JSON.stringify(tileManifest)}. Valid original_bbox values map overlapping zoom tiles into the original frame; never double-count ink seen in two tiles.`,
    `TOPOLOGY TILE MANIFEST VALIDATION ISSUES: ${JSON.stringify([...new Set(manifestIssues)])}. Preserve uncertain mappings rather than guessing.`,
    'For each immutable connector, locate the single contiguous/visually grouped label block physically owned by that connector. label_block_bbox must contain that block in original-frame coordinates with a small margin, while excluding the connector stroke, arrowhead, state circles, blue notebook ruling, and neighbouring connectors’ labels as far as the pixels allow.',
    'Within that block, count VISIBLE PHYSICAL TEXT BASELINES only. One handwritten transition-rule row is one baseline even when it contains several separated words/symbol zones; do not count individual glyphs, words, punctuation, ascenders, page-ruling intersections, connector strokes, or visual wrapping artifacts as extra lines. A neighbouring connector label is not part of this block.',
    'Emit exactly visible_line_count line_hints. Each bbox must contain all ink on one physical baseline with a small margin and must not include an adjacent baseline. Preserve an existing line_id only when it still denotes the same physical baseline; otherwise use a fresh opaque line id. Never create a line merely to match a prior count or expected automaton semantics.',
    'WRAPPED FRAGMENTS: a lone short glyph directly under the right-hand word is not evidence of a second complete rule. Localize its ACTUAL ink width, not the full width of the row above it. Preserve it as a tight physical fragment if separate, so geometric suffix grouping can associate it without losing the original box. Never widen an isolated operand fragment into an INPUT-to-ACTION baseline. Do not read its identity or guess its meaning.',
    'Audit self-loop labels around the full state circumference, crowded diagonal-return labels, vertical connectors, and the bottom-left region carefully. Geometry and proximity to the supplied connector are the only binding evidence. If ownership or a baseline boundary is uncertain, retain the best localized bbox with low confidence and an explicit issue rather than borrowing neighbouring ink.',
    'No OCR: do not output raw text, state labels, input symbols, stack-top symbols, action types, or action words. Return only the strict line-geometry JSON keyed by the supplied transition_ids.',
  ].join('\n');
}

function topologyStructureSignature(value) {
  const topology = value && value.topology ? value.topology : (value || {});
  const states = Array.isArray(topology.states) ? topology.states : [];
  const transitions = Array.isArray(topology.transitions) ? topology.transitions
    : (Array.isArray(topology.connectors) ? topology.connectors : []);
  const markers = Array.isArray(topology.start_marker_observations)
    ? topology.start_marker_observations : [];
  return JSON.stringify({
    visible_state_count: topology.visible_state_count,
    visible_connector_count: topology.visible_connector_count,
    states: states.map(row => ({ id: String(row && row.observation_id || ''),
      start: Boolean(row && row.is_start && row.is_start.value),
      accepting: Boolean(row && row.is_accepting && row.is_accepting.value) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    markers: markers.map(row => ({ id: String(row && row.marker_id || ''),
      target: String(row && row.target_observation_id || '') }))
      .sort((a, b) => `${a.id}:${a.target}`.localeCompare(`${b.id}:${b.target}`)),
    transitions: transitions.map(row => ({ id: String(row && row.transition_id || ''),
      connector: String(row && row.connector_observation_id || ''),
      source: String(row && row.source_observation_id || ''),
      target: String(row && row.target_observation_id || '') }))
      .sort((a, b) => `${a.id}:${a.connector}`.localeCompare(`${b.id}:${b.connector}`)),
  });
}

function topologyInventoryEscalationReasons(envelope,
  threshold = TOPOLOGY_ESCALATION_CONFIDENCE) {
  const inventory = envelope && envelope.inventory ? envelope.inventory : (envelope || {});
  const reasons = [];
  const states = Array.isArray(inventory.state_circle_candidates) ? inventory.state_circle_candidates : [];
  const arrows = Array.isArray(inventory.computational_arrowhead_candidates)
    ? inventory.computational_arrowhead_candidates : [];
  if (!Number.isInteger(inventory.visible_state_circle_count) ||
      inventory.visible_state_circle_count !== states.length) reasons.push('state-circle inventory cardinality is unresolved');
  if (!Number.isInteger(inventory.visible_computational_arrowhead_count) ||
      inventory.visible_computational_arrowhead_count !== arrows.length) reasons.push('arrowhead inventory cardinality is unresolved');
  if (states.some(row => row && (row.scan_incomplete || Number(row.confidence) < threshold))) {
    reasons.push('one or more state-circle candidates are incomplete or low-confidence');
  }
  if (arrows.some(row => row && (row.scan_incomplete || Number(row.confidence) < threshold ||
      String(row.orientation && row.orientation.value || '').toUpperCase() === 'UNKNOWN'))) {
    reasons.push('one or more arrowhead candidates are incomplete, unoriented, or low-confidence');
  }
  if (Array.isArray(inventory.issues) && inventory.issues.length) reasons.push('geometric inventory reported issues');
  return [...new Set(reasons)];
}

function topologyAuditEscalationReasons(envelope, initialTopology,
  threshold = TOPOLOGY_ESCALATION_CONFIDENCE) {
  const topology = envelope && envelope.topology ? envelope.topology : (envelope || {});
  const audit = envelope && envelope.topology_audit ? envelope.topology_audit : {};
  const reasons = [];
  const states = Array.isArray(topology.states) ? topology.states : [];
  const observations = Array.isArray(topology.connector_observations)
    ? topology.connector_observations : [];
  const transitions = Array.isArray(topology.transitions) ? topology.transitions
    : (Array.isArray(topology.connectors) ? topology.connectors : []);
  if (audit.failed) reasons.push('topology replacement audit failed');
  if (!Number.isInteger(topology.visible_state_count) || topology.visible_state_count !== states.length) {
    reasons.push('visible state count does not match state observations');
  }
  if (!Number.isInteger(topology.visible_connector_count) ||
      topology.visible_connector_count !== observations.length ||
      topology.visible_connector_count !== transitions.length) {
    reasons.push('visible connector count does not match connector evidence');
  }
  if (states.some(row => row && (row.scan_incomplete || Number(row.confidence) < threshold))) {
    reasons.push('one or more states are incomplete or low-confidence');
  }
  if (observations.some(row => row && (row.scan_incomplete || Number(row.confidence) < threshold))) {
    reasons.push('one or more connector observations are incomplete or low-confidence');
  }
  if (transitions.some(row => row && (row.scan_incomplete || Number(row.confidence) < threshold ||
      !String(row.source_observation_id || '').trim() || !String(row.target_observation_id || '').trim()))) {
    reasons.push('one or more transition endpoints are incomplete or low-confidence');
  }
  const inventory = audit.geometric_inventory;
  if (inventory) topologyInventoryEscalationReasons(inventory, threshold)
    .forEach(reason => reasons.push(`inventory: ${reason}`));
  const reconciliation = audit.inventory_reconciliation;
  if (reconciliation && Array.isArray(reconciliation.issues) && reconciliation.issues.length) {
    reasons.push('inventory and topology geometry do not reconcile');
  }
  const endpointValidation = audit.endpoint_geometry_validation;
  if (endpointValidation && (endpointValidation.review_only ||
      Array.isArray(endpointValidation.issues) && endpointValidation.issues.length)) {
    reasons.push('audited endpoint changes failed deterministic geometry validation');
  }
  if (initialTopology && topologyStructureSignature(topology) !== topologyStructureSignature(initialTopology)) {
    reasons.push('the audited physical topology differs structurally from the first pass');
  }
  return [...new Set(reasons)];
}

function topologyLineAuditEscalationReasons(value, topology,
  threshold = TOPOLOGY_ESCALATION_CONFIDENCE) {
  if (value == null) return ['line-geometry audit failed'];
  const normalized = normalizeTopologyLineGeometryAuditResult(value, topology, 'quality-check');
  const audit = normalized.line_geometry_audit || {};
  const rows = Array.isArray(audit.connector_lines) ? audit.connector_lines : [];
  const reasons = [];
  if (Array.isArray(audit.issues) && audit.issues.length) reasons.push('line-geometry audit reported structural issues');
  if (rows.some(row => row && (row.scan_incomplete || !row.structurally_valid ||
      Number(row.confidence) < threshold || Array.isArray(row.unresolved_fragments) && row.unresolved_fragments.length))) {
    reasons.push('one or more label-line geometries are incomplete or low-confidence');
  }
  return [...new Set(reasons)];
}

async function parseTopologyAuditStage(topologyEnvelope, imageUrls, imageRoles, crops, modelType,
  requestedSession, runtime = {}) {
  const visionCall = typeof runtime.callVisionJson === 'function' ? runtime.callVisionJson : callVisionJson;
  const primaryModel = String(runtime.topologyAuditModel || TOPOLOGY_AUDIT_MODEL).trim();
  const escalationModel = String(runtime.topologyEscalationModel || TOPOLOGY_ESCALATION_MODEL).trim();
  const escalationEnabled = runtime.topologyEscalationEnabled == null
    ? TOPOLOGY_ESCALATION_ENABLED : Boolean(runtime.topologyEscalationEnabled);
  const lineGeometryEnabled = runtime.topologyLineGeometryEnabled == null
    ? TOPOLOGY_LINE_GEOMETRY_ENABLED : Boolean(runtime.topologyLineGeometryEnabled);
  const mayEscalate = Boolean(escalationEnabled && escalationModel && escalationModel !== primaryModel);
  const session = scanSessionId(requestedSession || (topologyEnvelope && topologyEnvelope.scan_session_id));
  const fullUrls = (Array.isArray(imageUrls) ? imageUrls : [imageUrls]).filter(Boolean);
  const fullRoles = normalizedImageRoles(fullUrls, imageRoles);
  const cropRows = (Array.isArray(crops) ? crops : []).filter(Boolean).slice(0, 12);
  const manifestIssues = [];
  const tileManifest = normalizeTopologyAuditManifest(cropRows, manifestIssues);
  const tileUrls = cropRows.map(row => row && row.image_url).filter(Boolean);
  const initialTopology = cloneJson(topologyEnvelope && topologyEnvelope.topology
    ? topologyEnvelope.topology : topologyEnvelope, {});
  const urls = [...fullUrls, ...tileUrls];
  const captions = [
    ...fullRoles.map((role, index) => `FULL IMAGE ${index + 1} ROLE: ${role}`),
    ...cropRows.filter(row => row && row.image_url).map((row, index) => {
      const evidence = tileManifest.find(tile => tile.crop_id === String(row.crop_id || '').trim()) || {};
      return `TOPOLOGY TILE ${index + 1}: crop_id=${String(row.crop_id || '')}; original_bbox=${JSON.stringify(evidence.original_bbox || null)}`;
    }),
  ];
  const metadata = {
    initial_model: TOPOLOGY_MODEL,
    audit_model: primaryModel,
    model_type: modelType,
    image_roles: fullRoles,
  };
  const routing = {};
  let inventory = null;
  try {
    if (!urls.length) throw new Error('topology audit has no full image or topology-tile pixels');
    const inventoryRequest = (model, attempt) => visionCall({
        urls,
        captions,
        prompt: buildTopologyInventoryPrompt(fullRoles, tileManifest, manifestIssues, modelType),
        schema: topologyInventorySchema(),
        schemaName: 'automaton_topology_geometric_inventory',
        model,
        telemetry: { purpose: 'topology-inventory', attempt },
      });
    let primaryInventoryRaw = null;
    let primaryInventoryError = null;
    try { primaryInventoryRaw = await inventoryRequest(primaryModel, 'primary'); }
    catch (error) { primaryInventoryError = error; }
    let selectedInventoryRaw = primaryInventoryRaw;
    let selectedInventoryModel = primaryModel;
    let primaryInventoryReasons = primaryInventoryRaw
      ? topologyInventoryEscalationReasons(normalizeTopologyInventoryResult(primaryInventoryRaw, session))
      : [`primary inventory failed: ${String(primaryInventoryError && primaryInventoryError.message || primaryInventoryError).slice(0, 180)}`];
    let escalationInventoryReasons = [];
    let escalationInventoryError = null;
    const escalateInventory = mayEscalate && (!primaryInventoryRaw || primaryInventoryReasons.length > 0);
    if (escalateInventory) {
      try {
        const strongerRaw = await inventoryRequest(escalationModel, 'escalation');
        escalationInventoryReasons = topologyInventoryEscalationReasons(
          normalizeTopologyInventoryResult(strongerRaw, session));
        if (!primaryInventoryRaw || escalationInventoryReasons.length <= primaryInventoryReasons.length) {
          selectedInventoryRaw = strongerRaw;
          selectedInventoryModel = escalationModel;
        }
      } catch (error) { escalationInventoryError = error; }
      recordScanRuntime('topology-inventory-escalated', { session, primary_model: primaryModel,
        escalation_model: escalationModel, selected_model: selectedInventoryModel,
        primary_problem_count: primaryInventoryReasons.length,
        escalation_problem_count: escalationInventoryReasons.length,
        escalation_failed: Boolean(escalationInventoryError) });
    }
    routing.inventory = { primary_model: primaryModel, final_model: selectedInventoryModel,
      escalated: escalateInventory, escalation_reasons: primaryInventoryReasons,
      primary_problem_count: primaryInventoryReasons.length,
      final_problem_count: selectedInventoryModel === escalationModel
        ? escalationInventoryReasons.length : primaryInventoryReasons.length,
      escalation_error: escalationInventoryError
        ? String(escalationInventoryError.message || escalationInventoryError).slice(0, 240) : '' };
    if (!selectedInventoryRaw) {
      const inventoryError = escalationInventoryError || primaryInventoryError ||
        new Error('independent geometric inventory returned no result');
      const error = new Error(`independent geometric inventory failed: ${String(inventoryError && inventoryError.message || inventoryError)}`);
      const failed = normalizeTopologyAuditStageResult(null, topologyEnvelope, cropRows, session,
        { ...metadata, error, inventory_error: inventoryError });
      failed.topology_audit.model_routing = routing;
      return failed;
    }
    inventory = normalizeTopologyInventoryResult(selectedInventoryRaw, session);
    const prompt = buildTopologyReplacementAuditPrompt(initialTopology, inventory.inventory,
      fullRoles, tileManifest, manifestIssues, modelType);
    const replacementRequest = (model, attempt) => visionCall({ urls, captions, prompt,
      schema: topologyStageSchema(), schemaName: 'automaton_topology_audit_stage', model,
      telemetry: { purpose: 'topology-replacement-audit', attempt } });
    let primaryReplacementRaw = null;
    let primaryReplacementError = null;
    try { primaryReplacementRaw = await replacementRequest(primaryModel, 'primary'); }
    catch (error) { primaryReplacementError = error; }
    let selectedReplacement = primaryReplacementRaw
      ? normalizeTopologyAuditStageResult(primaryReplacementRaw, topologyEnvelope, cropRows, session,
        { ...metadata, audit_model: primaryModel, inventory, inventory_model: selectedInventoryModel })
      : null;
    let selectedReplacementModel = primaryModel;
    const primaryReplacementReasons = selectedReplacement
      ? topologyAuditEscalationReasons(selectedReplacement, initialTopology)
      : [`primary topology audit failed: ${String(primaryReplacementError && primaryReplacementError.message || primaryReplacementError).slice(0, 180)}`];
    let escalationReplacementReasons = [];
    let escalationReplacementError = null;
    const escalateReplacement = mayEscalate && (!selectedReplacement || primaryReplacementReasons.length > 0);
    if (escalateReplacement) {
      try {
        const strongerRaw = await replacementRequest(escalationModel, 'escalation');
        const stronger = normalizeTopologyAuditStageResult(strongerRaw, topologyEnvelope, cropRows, session,
          { ...metadata, audit_model: escalationModel, inventory, inventory_model: selectedInventoryModel });
        escalationReplacementReasons = topologyAuditEscalationReasons(stronger, initialTopology);
        if (!selectedReplacement || escalationReplacementReasons.length <= primaryReplacementReasons.length) {
          selectedReplacement = stronger;
          selectedReplacementModel = escalationModel;
        }
      } catch (error) { escalationReplacementError = error; }
      recordScanRuntime('topology-replacement-escalated', { session, primary_model: primaryModel,
        escalation_model: escalationModel, selected_model: selectedReplacementModel,
        primary_problem_count: primaryReplacementReasons.length,
        escalation_problem_count: escalationReplacementReasons.length,
        escalation_failed: Boolean(escalationReplacementError) });
    }
    routing.replacement = { primary_model: primaryModel, final_model: selectedReplacementModel,
      escalated: escalateReplacement, escalation_reasons: primaryReplacementReasons,
      primary_problem_count: primaryReplacementReasons.length,
      final_problem_count: selectedReplacementModel === escalationModel
        ? escalationReplacementReasons.length : primaryReplacementReasons.length,
      escalation_error: escalationReplacementError
        ? String(escalationReplacementError.message || escalationReplacementError).slice(0, 240) : '' };
    if (!selectedReplacement) {
      const error = escalationReplacementError || primaryReplacementError ||
        new Error('independent topology audit returned no result');
      const failed = normalizeTopologyAuditStageResult(null, topologyEnvelope, cropRows, session,
        { ...metadata, error, inventory, inventory_error: null, inventory_model: selectedInventoryModel });
      failed.topology_audit.model_routing = routing;
      return failed;
    }
    const replacement = selectedReplacement;
    const tracePlan = planTopologyTargetedTrace(replacement, fullUrls, fullRoles, cropRows, tileManifest);
    let tracedReplacement;
    const traceModel = tracePlan.should_call && mayEscalate ? escalationModel : selectedReplacementModel;
    if (!tracePlan.has_unmatched) {
      tracedReplacement = applyTopologyTargetedTrace(replacement, null, session,
        { plan: tracePlan, attempted: false, model: traceModel });
    } else if (!tracePlan.should_call) {
      tracedReplacement = applyTopologyTargetedTrace(replacement, null, session,
        { plan: tracePlan, attempted: false, model: traceModel });
    } else {
      try {
        const targetedTraceRaw = await visionCall({
          urls: tracePlan.request_urls,
          captions: tracePlan.request_captions,
          prompt: buildTopologyTargetedTracePrompt(tracePlan, modelType),
          schema: topologyTargetedTraceSchema(),
          schemaName: 'automaton_topology_targeted_trace',
          model: traceModel,
          telemetry: { purpose: 'topology-targeted-trace',
            attempt: traceModel === escalationModel ? 'escalation' : 'primary' },
        });
        tracedReplacement = applyTopologyTargetedTrace(replacement, targetedTraceRaw, session,
          { plan: tracePlan, attempted: true, model: traceModel });
      } catch (targetedTraceError) {
        tracedReplacement = applyTopologyTargetedTrace(replacement, null, session,
          { plan: tracePlan, attempted: true, model: traceModel,
            error: targetedTraceError });
      }
    }
    routing.targeted_trace = { attempted: Boolean(tracePlan.should_call), model: traceModel,
      escalated: Boolean(tracePlan.should_call && traceModel === escalationModel) };
    if (!lineGeometryEnabled) {
      routing.line_geometry = { enabled: false, skipped: true, reason: 'disabled by cost/quality policy' };
      tracedReplacement.topology_audit.model_routing = routing;
      tracedReplacement.topology_audit.escalated = Object.values(routing).some(row => row && row.escalated);
      return tracedReplacement;
    }
    const connectorManifest = topologyLineGeometryConnectorManifest(tracedReplacement.topology);
    const linePrompt = buildTopologyLineGeometryAuditPrompt(connectorManifest, fullRoles,
      tileManifest, manifestIssues, modelType);
    const lineRequest = (model, attempt) => visionCall({
        urls,
        captions,
        prompt: linePrompt,
        schema: topologyLineGeometryAuditSchema(),
        schemaName: 'automaton_topology_line_geometry_audit',
        model,
        telemetry: { purpose: 'topology-line-geometry', attempt },
      });
    let primaryLineRaw = null;
    let primaryLineError = null;
    try { primaryLineRaw = await lineRequest(primaryModel, 'primary'); }
    catch (error) { primaryLineError = error; }
    let selectedLineRaw = primaryLineRaw;
    let selectedLineModel = primaryModel;
    const primaryLineReasons = topologyLineAuditEscalationReasons(primaryLineRaw,
      tracedReplacement.topology);
    let escalationLineReasons = [];
    let escalationLineError = null;
    const escalateLine = mayEscalate && (!primaryLineRaw || primaryLineReasons.length > 0);
    if (escalateLine) {
      try {
        const strongerRaw = await lineRequest(escalationModel, 'escalation');
        escalationLineReasons = topologyLineAuditEscalationReasons(strongerRaw,
          tracedReplacement.topology);
        if (!primaryLineRaw || escalationLineReasons.length <= primaryLineReasons.length) {
          selectedLineRaw = strongerRaw;
          selectedLineModel = escalationModel;
        }
      } catch (error) { escalationLineError = error; }
      recordScanRuntime('topology-line-geometry-escalated', { session, primary_model: primaryModel,
        escalation_model: escalationModel, selected_model: selectedLineModel,
        primary_problem_count: primaryLineReasons.length,
        escalation_problem_count: escalationLineReasons.length,
        escalation_failed: Boolean(escalationLineError) });
    }
    routing.line_geometry = { primary_model: primaryModel, final_model: selectedLineModel,
      escalated: escalateLine, escalation_reasons: primaryLineReasons,
      primary_problem_count: primaryLineReasons.length,
      final_problem_count: selectedLineModel === escalationModel
        ? escalationLineReasons.length : primaryLineReasons.length,
      escalation_error: escalationLineError
        ? String(escalationLineError.message || escalationLineError).slice(0, 240) : '' };
    const finalResult = applyTopologyLineGeometryAudit(tracedReplacement, selectedLineRaw, session,
      { model: selectedLineModel, error: selectedLineRaw ? null
        : (escalationLineError || primaryLineError || new Error('line-geometry audit returned no result')) });
    finalResult.topology_audit.model_routing = routing;
    finalResult.topology_audit.escalated = Object.values(routing).some(row => row && row.escalated);
    return finalResult;
  } catch (error) {
    const failed = normalizeTopologyAuditStageResult(null, topologyEnvelope, cropRows, session,
      { ...metadata, error, inventory, inventory_error: inventory ? null : error,
        inventory_model: routing.inventory && routing.inventory.final_model || primaryModel });
    failed.topology_audit.model_routing = routing;
    return failed;
  }
}

function buildLabelCropBatches(crops, options = {}) {
  const rows = (Array.isArray(crops) ? crops : []).filter(Boolean);
  const maxImages = Math.max(2, Number(options.max_images) || 12);
  /* Up to three single-line transition-local groups share one request. Dense
     multi-line labels remain isolated below. This reserves a paid-call slot
     for the bounded targeted retry without weakening immutable crop ids. */
  const maxTransitions = Math.max(1, Number(options.max_transitions) || 3);
  const batches = [];
  const stateRows = rows.filter(row => row.kind === 'state_label');
  for (let index = 0; index < stateRows.length; index += maxImages) {
    batches.push({ batch_id: `states-${batches.length + 1}`, kind: 'states',
      transition_ids: [], rows: stateRows.slice(index, index + maxImages) });
  }

  const groups = new Map();
  const foreignRows = [];
  rows.filter(row => row.kind !== 'state_label').forEach(row => {
    const transitionId = String(row.transition_id || '').trim();
    if (!transitionId) { foreignRows.push(row); return; }
    const group = groups.get(transitionId) || [];
    group.push(row);
    groups.set(transitionId, group);
  });
  let pendingRows = [], pendingIds = [];
  const flush = () => {
    if (!pendingRows.length) return;
    batches.push({ batch_id: `transitions-${batches.length + 1}`, kind: 'transitions',
      transition_ids: pendingIds, rows: pendingRows });
    pendingRows = []; pendingIds = [];
  };
  groups.forEach((groupRows, transitionId) => {
    const physicalLineCount = groupRows.filter(row => row.kind === 'line').length;
    /* Dense two/three-row PDA labels are the most error-prone crops and must
       never share a model call with a neighbouring connector. Single-row
       connectors may still be grouped to keep the scan affordable. */
    if (physicalLineCount > 1) {
      flush();
      pendingRows = [...groupRows];
      pendingIds = [transitionId];
      flush();
      return;
    }
    if (pendingRows.length && (pendingIds.length >= maxTransitions ||
        pendingRows.length + groupRows.length > maxImages)) flush();
    pendingRows.push(...groupRows);
    pendingIds.push(transitionId);
    /* A transition is never split merely to satisfy the soft image limit. */
    if (pendingIds.length >= maxTransitions || pendingRows.length >= maxImages) flush();
  });
  flush();
  if (foreignRows.length) batches.push({ batch_id: `unassigned-${batches.length + 1}`,
    kind: 'unassigned', transition_ids: [], rows: foreignRows });
  return batches;
}

function labelBatchTopologyContext(topology, batch) {
  const allStates = Array.isArray(topology && topology.states) ? topology.states : [];
  const allTransitions = Array.isArray(topology && topology.transitions) ? topology.transitions
    : (Array.isArray(topology && topology.connectors) ? topology.connectors : []);
  if (batch.kind === 'states') {
    const ids = new Set(batch.rows.map(row => String(row.observation_id || '').trim()));
    return { states: allStates.filter(state => ids.has(String(state && state.observation_id || '').trim())),
      transitions: [] };
  }
  const transitionIds = new Set(batch.transition_ids || []);
  const transitions = allTransitions.filter(transition =>
    transitionIds.has(String(transition && transition.transition_id || '').trim()));
  const endpointIds = new Set();
  transitions.forEach(transition => {
    endpointIds.add(String(transition && transition.source_observation_id || '').trim());
    endpointIds.add(String(transition && transition.target_observation_id || '').trim());
  });
  return { states: allStates.filter(state => endpointIds.has(String(state && state.observation_id || '').trim())),
    transitions };
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const output = new Array(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

function unreadableLabelValue(value) {
  const text = String(value ?? '').trim();
  return !text || text.includes('?') || /^[�□▯▢◻◼⬜⬛]+$/.test(text);
}

function labelBatchEscalationReasons(parsed, batch, modelType,
  threshold = LABEL_ESCALATION_CONFIDENCE) {
  const value = parsed && typeof parsed === 'object' ? parsed : {};
  const reasons = [];
  const expectedLines = batch.rows.filter(row => row.kind === 'line');
  const expectedStates = batch.rows.filter(row => row.kind === 'state_label');
  const lineReads = Array.isArray(value.label_reads) ? value.label_reads.filter(Boolean) : [];
  const stateReads = Array.isArray(value.state_label_reads) ? value.state_label_reads.filter(Boolean) : [];
  const mode = String(modelType || 'pda').trim().toLowerCase();
  const isPda = mode !== 'tm' && mode !== 'dfa' && mode !== 'nfa';
  const add = reason => { if (reason && !reasons.includes(reason)) reasons.push(reason); };
  if (stringIssues(value.issues).length) add('batch reported OCR issues');
  if (lineReads.length !== expectedLines.length) add(`expected ${expectedLines.length} line reads, received ${lineReads.length}`);
  if (stateReads.length !== expectedStates.length) add(`expected ${expectedStates.length} state reads, received ${stateReads.length}`);

  const expectedLineKeys = new Set(expectedLines.map(row =>
    `${String(row.crop_id || '')}\u0000${String(row.transition_id || '')}\u0000${String(row.line_id || '')}`));
  const actualLineKeys = new Set();
  lineReads.forEach(row => {
    const key = `${String(row.crop_id || '')}\u0000${String(row.transition_id || '')}\u0000${String(row.line_id || '')}`;
    actualLineKeys.add(key);
    if (!expectedLineKeys.has(key)) add('line-read identity does not match the local crop manifest');
    if (stringIssues(row.issues).length) add('one or more line reads reported OCR issues');
    if (unreadableLabelValue(row.raw_label_text)) add('raw label text is missing or unreadable');
    const confidenceValues = [row.confidence, row.read_input && row.read_input.confidence];
    if (isPda) confidenceValues.push(row.pop_value && row.pop_value.confidence,
      row.stack_action && row.stack_action.confidence);
    const action = String(row.stack_action && row.stack_action.type || '').trim().toUpperCase();
    if (action === 'PUSH') confidenceValues.push(row.push_value && row.push_value.confidence);
    if (action === 'POP') confidenceValues.push(row.pop_symbol && row.pop_symbol.confidence);
    if (confidenceValues.some(confidence => !Number.isFinite(Number(confidence)) || Number(confidence) < threshold)) {
      add('one or more OCR confidences are below the escalation threshold');
    }
    if (unreadableLabelValue(row.read_input && row.read_input.value)) add('INPUT is missing or unreadable');
    if (isPda) {
      const zones = row.zones && typeof row.zones === 'object' ? row.zones : {};
      if (unreadableLabelValue(zones.left_text) || unreadableLabelValue(zones.middle_text) ||
          unreadableLabelValue(zones.right_text)) add('one or more physical PDA zones are missing or unreadable');
      if (unreadableLabelValue(row.pop_value && row.pop_value.value)) add('STACK_TOP is missing or unreadable');
      if (!['PUSH', 'POP', 'NONE'].includes(action)) add('PDA action is missing or unrecognized');
      if (action === 'PUSH' && unreadableLabelValue(row.push_value && row.push_value.value)) {
        add('PUSH symbol is missing or unreadable');
      }
      if (action === 'POP' && unreadableLabelValue(row.pop_symbol && row.pop_symbol.value)) {
        add('POP symbol is missing or unreadable');
      }
    }
  });
  expectedLineKeys.forEach(key => { if (!actualLineKeys.has(key)) add('one or more expected line reads are missing'); });

  const expectedStateKeys = new Set(expectedStates.map(row =>
    `${String(row.crop_id || '')}\u0000${String(row.observation_id || '')}`));
  const actualStateKeys = new Set();
  stateReads.forEach(row => {
    const key = `${String(row.crop_id || '')}\u0000${String(row.observation_id || '')}`;
    actualStateKeys.add(key);
    if (!expectedStateKeys.has(key)) add('state-read identity does not match the local crop manifest');
    if (stringIssues(row.issues).length) add('one or more state reads reported OCR issues');
    if (unreadableLabelValue(row.visible_label)) add('state label is missing or unreadable');
    if (!Number.isFinite(Number(row.confidence)) || Number(row.confidence) < threshold) {
      add('one or more state-label confidences are below the escalation threshold');
    }
  });
  expectedStateKeys.forEach(key => { if (!actualStateKeys.has(key)) add('one or more expected state reads are missing'); });
  return reasons;
}

function labelCandidateConfidence(row, isState) {
  if (!row || typeof row !== 'object') return -1;
  const values = isState ? [row.confidence] : [
    row.confidence,
    row.read_input && row.read_input.confidence,
    row.pop_value && row.pop_value.confidence,
    row.stack_action && row.stack_action.confidence,
  ];
  if (!isState) {
    const action = String(row.stack_action && row.stack_action.type || '').trim().toUpperCase();
    if (action === 'PUSH') values.push(row.push_value && row.push_value.confidence);
    if (action === 'POP') values.push(row.pop_symbol && row.pop_symbol.confidence);
  }
  const finite = values.map(Number).filter(Number.isFinite);
  return finite.length ? Math.min(...finite) : -1;
}

/* Batch-level reason categories are deliberately de-duplicated for telemetry,
   so they are too coarse for choosing between two OCR attempts. Compare the
   direct visual reads independently for every immutable crop identity and
   keep one complete, unmodified observation for each physical row. */
function mergeLabelBatchCandidates(primary, escalation, batch, modelType) {
  if (!primary) return { parsed: escalation, selectedModels: [LABEL_ESCALATION_MODEL] };
  if (!escalation) return { parsed: primary, selectedModels: [LABEL_MODEL] };
  // Never let Map's last-write-wins behavior erase duplicate observations.
  // Such a response has ambiguous physical identity, regardless of confidence.
  const identityProblems = [];
  const checkIdentities = (result, source, field, kind, keys) => {
    const identity = row => keys.map(key => String(row?.[key] || '').trim()).join('\u0000');
    const expected = new Set(batch.rows.filter(row => row.kind === kind).map(identity));
    const seen = new Set();
    for (const row of Array.isArray(result[field]) ? result[field] : []) {
      const key = identity(row);
      if (!row || !expected.has(key)) identityProblems.push(`${source}: foreign ${field} identity`);
      if (seen.has(key)) identityProblems.push(`${source}: duplicate ${field} identity`);
      seen.add(key);
    }
  };
  for (const [source, result] of [['primary', primary], ['retry', escalation]]) {
    checkIdentities(result, source, 'label_reads', 'line', ['crop_id', 'transition_id', 'line_id']);
    checkIdentities(result, source, 'state_label_reads', 'state_label', ['crop_id', 'observation_id']);
  }
  if (identityProblems.length) {
    const issues = [...new Set([...stringIssues(primary.issues), ...stringIssues(escalation.issues), ...identityProblems])];
    const mark = row => ({ ...cloneJson(row), issues: [...stringIssues(row?.issues), ...identityProblems],
      scan_incomplete: true, review_only: true,
      ocr_alternatives: { primary: cloneJson(primary), retry: cloneJson(escalation), conflicts: identityProblems } });
    return { parsed: { ...cloneJson(primary),
      label_reads: (primary.label_reads || []).filter(Boolean).map(mark),
      state_label_reads: (primary.state_label_reads || []).filter(Boolean).map(mark),
      issues, review_only: true }, selectedModels: [LABEL_MODEL] };
  }
  const mode = String(modelType || 'pda').trim().toLowerCase();
  const primaryLines = new Map((Array.isArray(primary.label_reads) ? primary.label_reads : [])
    .filter(Boolean).map(row => [`${String(row.crop_id || '')}\u0000${String(row.transition_id || '')}\u0000${String(row.line_id || '')}`, row]));
  const escalationLines = new Map((Array.isArray(escalation.label_reads) ? escalation.label_reads : [])
    .filter(Boolean).map(row => [`${String(row.crop_id || '')}\u0000${String(row.transition_id || '')}\u0000${String(row.line_id || '')}`, row]));
  const primaryStates = new Map((Array.isArray(primary.state_label_reads) ? primary.state_label_reads : [])
    .filter(Boolean).map(row => [`${String(row.crop_id || '')}\u0000${String(row.observation_id || '')}`, row]));
  const escalationStates = new Map((Array.isArray(escalation.state_label_reads) ? escalation.state_label_reads : [])
    .filter(Boolean).map(row => [`${String(row.crop_id || '')}\u0000${String(row.observation_id || '')}`, row]));
  const selectedModels = new Set();
  const choose = (manifestRow, left, right, isState) => {
    if (!left) { selectedModels.add(LABEL_ESCALATION_MODEL); return right; }
    if (!right) { selectedModels.add(LABEL_MODEL); return left; }
    const localBatch = { batch_id: batch.batch_id, rows: [manifestRow] };
    const wrap = row => ({ issues: [], label_reads: isState ? [] : [row],
      state_label_reads: isState ? [row] : [] });
    const leftProblems = labelBatchEscalationReasons(wrap(left), localBatch, mode).length;
    const rightProblems = labelBatchEscalationReasons(wrap(right), localBatch, mode).length;
    let selected = right;
    let selectedModel = LABEL_ESCALATION_MODEL;
    if (leftProblems < rightProblems || (leftProblems === rightProblems &&
        labelCandidateConfidence(left, isState) > labelCandidateConfidence(right, isState))) {
      selected = left;
      selectedModel = LABEL_MODEL;
    }
    selectedModels.add(selectedModel);
    // A higher self-reported confidence does not resolve two different visible
    // readings. Keep the selected observation intact, but retain both sources
    // and fail closed on concrete disagreements (not unknown -> readable).
    const literal = field => field && typeof field === 'object' ? field.value : field;
    const fields = isState ? [['visible_label',left.visible_label,right.visible_label]] : [
      ['INPUT',literal(left.read_input),literal(right.read_input)],
      ...(mode === 'tm' || mode === 'dfa' || mode === 'nfa' ? [] : [
        ['STACK_TOP',literal(left.stack_top ?? left.pop_value),literal(right.stack_top ?? right.pop_value)],
        ['ACTION',left.stack_action?.type,right.stack_action?.type],
        ...(left.stack_action?.type === right.stack_action?.type && ['PUSH','POP'].includes(left.stack_action?.type)
          ? [['ACTION_SYMBOL',literal(left.stack_action.type === 'PUSH' ? left.push_value : left.pop_symbol),
            literal(right.stack_action.type === 'PUSH' ? right.push_value : right.pop_symbol)]] : []),
      ]),
    ];
    const conflicts = fields.filter(([,a,b]) => !unreadableLabelValue(a) && !unreadableLabelValue(b) &&
      String(a).trim() !== 'UNKNOWN' && String(b).trim() !== 'UNKNOWN' && String(a).trim() !== String(b).trim())
      .map(([field,a,b]) => `OCR alternatives disagree on ${field}: "${String(a).trim()}" versus "${String(b).trim()}"; confidence cannot resolve this`);
    if (conflicts.length) return {
      ...cloneJson(selected),
      issues: [...new Set([...stringIssues(selected.issues),...conflicts])],
      scan_incomplete: true, review_only: true,
      ocr_alternatives: { primary: cloneJson(left), retry: cloneJson(right), conflicts },
    };
    return selected;
  };
  const labelReads = batch.rows.filter(row => row.kind === 'line').map(row => {
    const key = `${String(row.crop_id || '')}\u0000${String(row.transition_id || '')}\u0000${String(row.line_id || '')}`;
    return choose(row, primaryLines.get(key), escalationLines.get(key), false);
  }).filter(Boolean);
  const stateLabelReads = batch.rows.filter(row => row.kind === 'state_label').map(row => {
    const key = `${String(row.crop_id || '')}\u0000${String(row.observation_id || '')}`;
    return choose(row, primaryStates.get(key), escalationStates.get(key), true);
  }).filter(Boolean);
  const primaryTopIssues = stringIssues(primary.issues);
  const escalationTopIssues = stringIssues(escalation.issues);
  return {
    parsed: {
      ...cloneJson(escalation),
      label_reads: labelReads,
      state_label_reads: stateLabelReads,
      issues: escalationTopIssues.length <= primaryTopIssues.length
        ? escalationTopIssues : primaryTopIssues,
    },
    selectedModels: [...selectedModels],
  };
}

/* A retry should spend its visual attention only on the unreadable physical
   rows. Keep the owning label block for context, but do not resend seven clean
   state circles or neighbouring transition rows merely because they shared a
   primary batch. The merge below still uses the complete original manifest,
   so clean primary observations remain byte-for-byte intact. */
function targetedLabelRetryBatch(result, modelType) {
  const batch = result && result.batch;
  const parsed = result && result.parsed;
  if (!batch || !parsed) return batch;
  const lineReads = new Map((Array.isArray(parsed.label_reads) ? parsed.label_reads : [])
    .filter(Boolean).map(row => [
      `${String(row.crop_id || '')}\u0000${String(row.transition_id || '')}\u0000${String(row.line_id || '')}`, row,
    ]));
  const stateReads = new Map((Array.isArray(parsed.state_label_reads) ? parsed.state_label_reads : [])
    .filter(Boolean).map(row => [
      `${String(row.crop_id || '')}\u0000${String(row.observation_id || '')}`, row,
    ]));
  const badTransitionIds = new Set();
  const selected = [];
  batch.rows.forEach(row => {
    if (row.kind === 'state_label') {
      const key = `${String(row.crop_id || '')}\u0000${String(row.observation_id || '')}`;
      const read = stateReads.get(key);
      const local = { batch_id: batch.batch_id, rows: [row] };
      const wrapped = { issues: [], label_reads: [], state_label_reads: read ? [read] : [] };
      if (labelBatchEscalationReasons(wrapped, local, modelType).length) selected.push(row);
      return;
    }
    if (row.kind !== 'line') return;
    const key = `${String(row.crop_id || '')}\u0000${String(row.transition_id || '')}\u0000${String(row.line_id || '')}`;
    const read = lineReads.get(key);
    const local = { batch_id: batch.batch_id, rows: [row] };
    const wrapped = { issues: [], label_reads: read ? [read] : [], state_label_reads: [] };
    if (labelBatchEscalationReasons(wrapped, local, modelType).length) {
      selected.push(row);
      badTransitionIds.add(String(row.transition_id || ''));
    }
  });
  batch.rows.filter(row => row.kind === 'label_block' &&
    badTransitionIds.has(String(row.transition_id || ''))).forEach(row => selected.unshift(row));
  if (!selected.length) return batch;
  return {
    ...batch,
    batch_id: `${batch.batch_id}-targeted`,
    transition_ids: [...badTransitionIds],
    rows: selected,
  };
}

async function parseLabelsStage(topologyEnvelope, crops, modelType, requestedSession, runtime = {}) {
  const visionCall = typeof runtime.callVisionJson === 'function' ? runtime.callVisionJson : callVisionJson;
  const primaryLabelModel = String(runtime.labelModel || LABEL_MODEL).trim();
  const escalationLabelModel = String(runtime.labelEscalationModel || LABEL_ESCALATION_MODEL).trim();
  const escalationEnabled = runtime.labelEscalationEnabled == null
    ? LABEL_ESCALATION_ENABLED : Boolean(runtime.labelEscalationEnabled);
  const targetedRetryEnabled = runtime.labelTargetedRetryEnabled == null
    ? LABEL_TARGETED_RETRY_ENABLED : Boolean(runtime.labelTargetedRetryEnabled);
  const targetedRetryMaxBatches = runtime.labelTargetedRetryMaxBatches == null
    ? LABEL_TARGETED_RETRY_MAX_BATCHES
    : Math.max(0, Math.min(4, Number(runtime.labelTargetedRetryMaxBatches) || 0));
  const session = scanSessionId(requestedSession || (topologyEnvelope && topologyEnvelope.scan_session_id));
  const cropRows = (Array.isArray(crops) ? crops : []).filter(Boolean);
  const topology = cloneJson(topologyEnvelope && topologyEnvelope.topology
    ? topologyEnvelope.topology : topologyEnvelope, {});
  const mode = String(modelType || 'pda').trim().toLowerCase();
  const modeRules = mode === 'tm'
    ? 'This is TM label reading: transcribe read/write/direction literally; do not invent stack semantics.'
    : (mode === 'dfa' || mode === 'nfa')
      ? 'This is finite-automaton label reading: read bare input symbols only; stack fields are compatibility NONE/ε fields.'
      : 'This is PDA label reading. Split every line physically as LEFT INPUT, MIDDLE STACK_TOP, RIGHT ACTION. Hebrew/Latin display order must never swap these zones. PUSH may differ from STACK_TOP; POP symbol must be read separately and may not be silently copied from STACK_TOP.';
  const promptForBatch = (batch, manifest, previousAttempt = null) => [
    'STAGE B — LABEL CROPS ONLY. The images supplied to this request are crops, not the original drawing. Read only these crop pixels. Do not infer, rewrite, add, remove, redirect, or merge any state, connector, endpoint, count, bbox, transition_id, or observation_id from topology.',
    `LOCAL BATCH ID: ${batch.batch_id}`,
    'This request is one LOCAL OCR BATCH. Never transfer a glyph, row, action, or symbol between different transition_id values, even when two transitions are present in this batch.',
    `LOCAL IMMUTABLE TOPOLOGY EVIDENCE: ${JSON.stringify(labelBatchTopologyContext(topology, batch))}`,
    `LOCAL CROP MANIFEST (image_url omitted): ${JSON.stringify(manifest)}`,
    `LOCAL CARDINALITY CONTRACT: emit exactly ${batch.rows.filter(row => row.kind === 'line').length} label_reads and exactly ${batch.rows.filter(row => row.kind === 'state_label').length} state_label_reads. Emit no read for a crop outside this local manifest.`,
    modeRules,
    'OUTPUT GUARD FIELD: stack_top is the middle condition for EVERY action including PUSH and NONE. It is not a pop operation. Keep the comma separator out of read_input: a comma stroke is not the digit 1. Do not include comma or slash in the three zones.',
    'kind=label_block is the PRIMARY transition-local view for establishing the number, top-to-bottom order, and complete horizontal extent of the handwritten rows. It must not itself produce a label_read. Use target_line_bboxes_in_context and line_index to bind every visible baseline to its immutable line_id. Never borrow a row from another transition_id.',
    'kind=line is a TARGET ZOOM for one physical baseline and must produce exactly one label_read carrying crop_id, transition_id, and line_id verbatim. Use it for character detail, but do not let a clipped, shifted, connector-only, or malformed line crop erase a row that is clearly visible in its owning label_block. In that case transcribe the same indexed row from the label_block, add an issue explaining the recovery, and lower confidence. If the block and zoom disagree or row identity remains ambiguous, return UNKNOWN/? rather than combining glyphs or synthesizing text.',
    'Emit exactly one state_label_read for every kind=state_label crop, carrying crop_id and observation_id verbatim. NEVER emit a state_label_read for a kind=line or kind=label_block crop. Before returning, verify that state_label_reads.length equals the number of kind=state_label manifest rows and that their crop_id set is identical. Copy only the literal state name ink into visible_label (for example q0, q_3, A). If it is absent or unreadable, return "?" with low confidence/issues. Never invent q0/qN from position, start-arrow status, numbering sequence, or neighbouring states.',
    'A state_label_read may supply visible_label only. It must never return or alter bbox, is_start, is_accepting, geometry, connector ownership, endpoints, transition ids, or any topology property. Those remain immutable Stage A evidence.',
    'PIXEL PROVENANCE: crop_id always remains the assigned kind=line identity. Set evidence_crop_id to the image in which the complete row ink is visible: that line crop, or its SAME-transition kind=label_block. bbox is normalized 0..1 relative to evidence_crop_id, not necessarily crop_id. When recovering from context, locate the ink inside that context and report its context-local bbox; never use negative/out-of-range zoom coordinates. Never select another row zoom, another transition, or a state-label crop as evidence. Do not reuse original-frame coordinates as crop-local coordinates.',
    'INACTIVE FIELDS: for PUSH set pop_symbol.value to ε; for POP set push_value.value to ε; for NONE set both to ε. These are not printed action operands: they mark an inactive structured slot only. A missing ACTIVE operand must stay ? and must never be filled from stack_top.',
    'For PDA lines, locate comma and slash as physical anchors before OCR. zones.left_text is only ink left/before comma; middle_text only between comma and slash; right_text only after/right of slash. raw_label_text is audit evidence and cannot override zones. If a glyph/anchor/action is unreadable, preserve what is visible, use ? in its structured field, lower confidence, and add an issue. Never turn missing ink into ε.',
    'PDA ZONE INDEPENDENCE CHECK: inspect LEFT, MIDDLE, and RIGHT as three separate visual tasks before forming structured fields. Never copy the readable MIDDLE stack symbol into an unclear LEFT input, and never copy a PUSH/POP symbol into either condition field. If LEFT ink is unclear, read_input must be ? even when MIDDLE is A/S/⊥. Determine PUSH/POP/NONE only from the approved Hebrew action word visibly present in RIGHT; a bare A, S, ⊥, plus, or minus does not establish an action. Read the WHOLE Hebrew word shape: דחוף means PUSH, שלוף means POP, and the two-word phrase ללא שינוי or abbreviation לל״ש means NONE. Do not collapse ללא שינוי into דחוף merely because one cramped trailing stroke looks similar. A visible Latin A/S following דחוף or שלוף belongs to the action symbol; ללא שינוי has no action symbol under the currently approved notation. Distinguish handwriting from any surviving notebook ruling: a ruling line is background and must not turn ⊥ into 1 or become part of a symbol. Carefully distinguish handwritten ε from Latin c, but preserve ? if the pixels do not decide it. Before returning each row, verify that read_input came from LEFT pixels, pop_value from MIDDLE pixels, and the action plus its symbol from RIGHT pixels.',
    ...(mode !== 'tm' && mode !== 'dfa' && mode !== 'nfa' ? ['HEBREW ACTION WORD — LETTER SHAPES (read the RIGHT zone with these cues):', ...PDA_ACTION_WORD_GUIDE] : []),
    'Preserve contradictions. Never make PUSH equal STACK_TOP just for consistency; never derive POP symbol from STACK_TOP; never normalize photographed Z0/Z₀/Z_0/⟂ into ⊥; never execute or repair NONE with extra visible symbols.',
    'Each crop has its own local coordinates. The explicit target_line_bboxes_in_context mapping may associate a zoom with its owning block, never with another transition. A block can recover clipped ink for that SAME mapped row, including Hebrew words or an action operand written below its baseline; this is not an additional rule. Never change row IDs or invent a continuation. Record which view supplied recovered ink in issues.',
    'LOCALIZATION CHECK: a line zoom may contain only paper/ruling because its tentative bbox is wrong. Inspect its SAME-transition label_block context before returning unknown. A LOCAL_LOOP_CONTEXT may include the owning circle and full loop neighbourhood. For a single-row loop, recover the one uniquely associated label from that context even outside the tentative line box; record the recovered location and localization disagreement in issues. Never borrow another connector label or assign multiple possible labels by proximity alone. Keep topology and row IDs unchanged. An isolated wrapped operand is not a complete extra rule: report that fact and its parent row in issues, keep the extra row unknown for review, and read the operand as part of the parent only when its spatial association is unambiguous.',
    'INPUT GLYPH CHECK: a, b, c, and ε are distinct literal symbols. Before choosing ε inspect the LEFT glyph at full crop resolution: a closed bowl with a right-hand stem/tail supports handwritten a; an ascender with a bowl supports b; an open curve may be c; epsilon has open lobes and a middle stroke. These are visual cues, not a forced alphabet. Compare the entire glyph, including faint closure/stem strokes, independently of the action or expected language. If the pixels cannot distinguish a/c/ε, return ? with the alternatives in issues, not ε as a default.',
    ...(previousAttempt ? [
      'TARGETED SECOND LOOK: the preceding Luna read for this exact immutable batch was incomplete or low-confidence. Re-inspect the crop pixels independently. Do not repeat a previous guess merely for consistency and do not fill a missing field from automaton semantics.',
      `PREVIOUS ATTEMPT — audit context only, never pixel evidence: ${JSON.stringify(previousAttempt)}`,
    ] : []),
    'Return only strict JSON label_reads and issues. Do not return topology.',
  ].join('\n');
  const batches = buildLabelCropBatches(cropRows);
  const callLabelBatch = (batch, model, attempt, previousAttempt = null) => {
    const imageRows = batch.rows.filter(crop => crop.image_url);
    const manifest = batch.rows.map(({ image_url, ...crop }) => crop);
    return visionCall({
      urls: imageRows.map(crop => crop.image_url),
      captions: imageRows.map((crop, index) =>
        `LOCAL CROP ${index + 1}/${imageRows.length}: batch=${batch.batch_id}; crop_id=${crop.crop_id}; kind=${crop.kind}; observation_id=${crop.observation_id || ''}; transition_id=${crop.transition_id || ''}; line_id=${crop.line_id || ''}`),
      prompt: promptForBatch(batch, manifest, previousAttempt).replace('pop_value from MIDDLE', 'stack_top from MIDDLE'),
      schema: labelsStageSchema(),
      schemaName: mode === 'tm' ? 'tm_label_crop_stage' : (mode === 'dfa' || mode === 'nfa'
        ? 'fa_label_crop_stage' : 'pda_label_crop_stage'),
      model,
      telemetry: { purpose: 'label-ocr', batch: batch.batch_id, attempt },
    }).then(adaptLabelWireResult);
  };
  const results = await mapWithConcurrency(batches, 2, async batch => {
    const startedAt = Date.now();
    let primary = null;
    let primaryError = null;
    try { primary = await callLabelBatch(batch, primaryLabelModel, 'primary'); } catch (error) { primaryError = error; }
    const primaryReasons = primary
      ? labelBatchEscalationReasons(primary, batch, mode)
      : [`primary OCR failed: ${String(primaryError && primaryError.message || primaryError).slice(0, 180)}`];
    const mayEscalate = escalationEnabled && escalationLabelModel &&
      escalationLabelModel !== primaryLabelModel && (!primary || primaryReasons.length > 0);
    let selected = primary;
    let selectedModel = primaryLabelModel;
    let escalation = null;
    let escalationReasons = [];
    let escalationError = null;
    if (mayEscalate) {
      try {
        escalation = await callLabelBatch(batch, escalationLabelModel, 'escalation');
        escalationReasons = labelBatchEscalationReasons(escalation, batch, mode);
        if (!primary) {
          selected = escalation;
          selectedModel = escalationLabelModel;
        } else {
          const merged = mergeLabelBatchCandidates(primary, escalation, batch, mode);
          selected = merged.parsed;
          selectedModel = merged.selectedModels.length === 1
            ? merged.selectedModels[0]
            : (merged.selectedModels.length > 1
              ? `mixed:${merged.selectedModels.join('+')}`
              : (escalationReasons.length <= primaryReasons.length
                ? escalationLabelModel : primaryLabelModel));
        }
      } catch (error) {
        escalationError = error;
      }
      recordScanRuntime('label-batch-escalated', { session, batch: batch.batch_id,
        primary_model: primaryLabelModel, escalation_model: escalationLabelModel,
        primary_problem_count: primaryReasons.length, escalation_problem_count: escalationReasons.length,
        selected_model: selectedModel, escalation_failed: Boolean(escalationError) });
    }
    const route = {
      batch_id: batch.batch_id,
      primary_model: primaryLabelModel,
      final_model: selectedModel,
      escalated: mayEscalate,
      escalation_reasons: primaryReasons,
      primary_problem_count: primaryReasons.length,
      final_problem_count: labelBatchEscalationReasons(selected, batch, mode).length,
      escalation_error: escalationError ? String(escalationError.message || escalationError).slice(0, 240) : '',
    };
    if (selected) {
      recordScanRuntime('label-batch-complete', { session, batch: batch.batch_id,
        crop_count: batch.rows.length, transition_count: batch.transition_ids.length,
        elapsed_ms: Date.now() - startedAt, model: selectedModel, escalated: mayEscalate });
      return { parsed: selected, route, batch };
    }
    const error = escalationError || primaryError || new Error('label OCR returned no result');
      recordScanRuntime('label-batch-failed', { session, batch: batch.batch_id,
        crop_count: batch.rows.length, transition_count: batch.transition_ids.length,
        elapsed_ms: Date.now() - startedAt, error_message: String(error && error.message || error).slice(0, 300) });
    return { parsed: { label_reads: [], state_label_reads: [],
      issues: [`local OCR batch ${batch.batch_id} failed: ${String(error && error.message || error).slice(0, 240)}`] }, route, batch };
  });
  let targetedRetryCount = 0;
  if (targetedRetryEnabled && targetedRetryMaxBatches > 0) {
    const retryCandidates = results.filter(result => result && result.parsed && result.batch)
      .map(result => ({ result, problems: labelBatchEscalationReasons(result.parsed, result.batch, mode),
        retryBatch: targetedLabelRetryBatch(result, mode) }))
      .filter(candidate => candidate.problems.length)
      .sort((left, right) => {
        const leftScore = left.problems.length + (left.result.batch.kind === 'states' ? 100 : 0);
        const rightScore = right.problems.length + (right.result.batch.kind === 'states' ? 100 : 0);
        return rightScore - leftScore;
      })
      .slice(0, targetedRetryMaxBatches);
    for (const candidate of retryCandidates) {
      try {
        const retry = await callLabelBatch(candidate.retryBatch, primaryLabelModel,
          'targeted-retry', candidate.result.parsed);
        const merged = mergeLabelBatchCandidates(candidate.result.parsed, retry,
          candidate.result.batch, mode);
        candidate.result.parsed = merged.parsed;
        candidate.result.route.targeted_retry = true;
        candidate.result.route.retry_model = primaryLabelModel;
        candidate.result.route.retry_problem_count = labelBatchEscalationReasons(retry,
          candidate.retryBatch, mode).length;
        candidate.result.route.retry_crop_count = candidate.retryBatch.rows.length;
        candidate.result.route.final_problem_count = labelBatchEscalationReasons(candidate.result.parsed,
          candidate.result.batch, mode).length;
        targetedRetryCount += 1;
        recordScanRuntime('label-batch-targeted-retry', { session, batch: candidate.result.batch.batch_id,
          prior_problem_count: candidate.problems.length,
          final_problem_count: candidate.result.route.final_problem_count, model: primaryLabelModel });
      } catch (error) {
        candidate.result.route.targeted_retry = false;
        candidate.result.route.retry_error = String(error && error.message || error).slice(0, 240);
      }
    }
  }
  const parsed = {
    label_reads: results.flatMap(result => Array.isArray(result.parsed && result.parsed.label_reads)
      ? result.parsed.label_reads : []),
    state_label_reads: results.flatMap(result => Array.isArray(result.parsed && result.parsed.state_label_reads)
      ? result.parsed.state_label_reads : []),
    issues: results.flatMap(result => stringIssues(result.parsed && result.parsed.issues)),
  };
  const normalized = normalizeLabelsStageResult(parsed, topologyEnvelope, cropRows, mode, session);
  normalized.model_routing = results.map(result => result.route);
  normalized.escalated_batch_count = normalized.model_routing.filter(route => route.escalated).length;
  normalized.targeted_retry_count = targetedRetryCount;
  return normalized;
}

async function parseDiagram(imageUrls, modelType, imageRoles) {
  if (!process.env.OPENAI_API_KEY) {
    const err = new Error('OPENAI_API_KEY is missing. Put it in .env');
    err.status = 401;
    throw err;
  }
  // Hybrid mode context from the client: 'pda' keeps the strict stack-rule pipeline;
  // 'tm' uses read/write/head-direction labels, while 'dfa'/'nfa' use bare symbols.
  // Missing/unknown => 'pda', so legacy clients keep the exact previous behavior.
  const mode = String(modelType || 'pda').trim().toLowerCase();
  const isTm = mode === 'tm';
  const isPda = !isTm && mode !== 'dfa' && mode !== 'nfa';
  const urls = (Array.isArray(imageUrls) ? imageUrls : [imageUrls]).filter(Boolean).slice(0, 3);
  const suppliedRoles = Array.isArray(imageRoles) ? imageRoles : [];
  const roles = urls.map((_, i) => {
    const role = String(suppliedRoles[i] || '').trim().toLowerCase();
    return ['enhanced_same_frame', 'ink_same_frame', 'original_same_frame',
      'independent_crop', 'independent_drawing', 'typeset_reference'].includes(role)
      ? role : 'unspecified';
  });
  const roleManifest = roles.map((role, i) => `IMAGE ${i + 1}: ${role}`).join('; ');

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
            // Non-semantic identity of this one physical circle. It remains
            // unique even when the visible id is empty or duplicated.
            observation_id: { type: 'string', minLength: 1 },
            id: { type: 'string' },
            is_accepting: { type: 'boolean' },
            is_start: { type: 'boolean' },
            confidence: { type: 'number' },
          },
          required: ['observation_id', 'id', 'is_accepting', 'is_start', 'confidence'],
        },
      },
      transitions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            transition_id: { type: 'string' },
            // Count physical label rows before attempting transcription. This
            // independent visual count is the completeness gate for rules[].
            visible_rule_line_count: { type: 'integer', minimum: 0 },
            source_state: {
              type: 'object',
              additionalProperties: false,
              properties: {
                observation_id: { type: 'string' },
                id: { type: 'string' },
                confidence: { type: 'number' },
              },
              required: ['observation_id', 'id', 'confidence'],
            },
            target_state: {
              type: 'object',
              additionalProperties: false,
              properties: {
                observation_id: { type: 'string' },
                id: { type: 'string' },
                confidence: { type: 'number' },
              },
              required: ['observation_id', 'id', 'confidence'],
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
                      type: { type: 'string', enum: ['PUSH', 'POP', 'NONE', 'UNKNOWN'] },
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
                  // STACK_TOP — the condition read from the MIDDLE zone.
                  pop_value: {
                    type: 'object',
                    additionalProperties: false,
                    properties: { value: { type: 'string' }, confidence: { type: 'number' } },
                    required: ['value', 'confidence'],
                  },
                  // ACTION.symbol of a POP — read from the RIGHT zone, kept apart
                  // from pop_value so a mismatch can be reported, not silently fixed.
                  pop_symbol: {
                    type: 'object',
                    additionalProperties: false,
                    properties: { value: { type: 'string' }, confidence: { type: 'number' } },
                    required: ['value', 'confidence'],
                  },
                  // The literal text seen in each physical zone of this one line.
                  zones: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      left_text: { type: 'string' },
                      middle_text: { type: 'string' },
                      right_text: { type: 'string' },
                    },
                    required: ['left_text', 'middle_text', 'right_text'],
                  },
                  // Normalised 0..1 box of this rule line. Use -1 on every field
                  // when the line cannot be localized — never guess coordinates.
                  line_bbox: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      x: { type: 'number', minimum: -1, maximum: 1 },
                      y: { type: 'number', minimum: -1, maximum: 1 },
                      w: { type: 'number', minimum: -1, maximum: 1 },
                      h: { type: 'number', minimum: -1, maximum: 1 },
                    },
                    required: ['x', 'y', 'w', 'h'],
                  },
                },
                required: ['raw_label_text', 'zones', 'line_bbox', 'read_input', 'stack_action', 'push_value', 'pop_value', 'pop_symbol'],
              },
            },
            cropped_image_segment_url: { type: 'string' },
          },
          required: [
            'transition_id',
            'visible_rule_line_count',
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
  const tmContextBlock = [
    'You are analyzing a Turing Machine (TM). Transitions represent tape head operations and usually follow the format "Read -> Write, Direction" (e.g., "a -> b, R" or "a/b, R", where direction is L/R/S).',
    'Do NOT look for stack operations like PUSH or POP. Do NOT use the symbols ε or ⊥ unless they represent a blank tape symbol (like "_" or "B"). Deliver raw, literal tape-transition strings in raw_label_text.',
  ].join(' ');

  const prompt = [
    'You are parsing a hand-drawn automaton diagram (a finite automaton, a pushdown automaton, or a Turing machine) for a computational-models tool. Be FULLY DOMAIN-AGNOSTIC: make NO assumption about any particular language, exam, alphabet, or "expected" structure — derive everything from THIS sheet alone.',
    'You may receive several image versions. ONLY images explicitly marked enhanced_same_frame, ink_same_frame, or original_same_frame are aligned variants of one original frame and may share geometry. Every other role, including unspecified, must be treated as geometrically independent and may support symbol identity only, never physical x/y ordering or connector ownership.',
    `IMAGE ROLE MANIFEST: ${roleManifest || 'no images'}. Images marked enhanced_same_frame, ink_same_frame, and original_same_frame are pixel-aligned views of one photograph. Images marked independent_crop, independent_drawing, typeset_reference, or unspecified MUST NOT be cross-aligned geometrically.`,
    'Do NOT rush and do NOT guess from a quick glance. Follow this strict, slowed-down visual reasoning protocol. You will write your visual chain-of-thought INTO the JSON analysis tables FIRST, and only then derive the states and transitions from those tables.',

    'PHASE 0 — SCRIBBLE SUPPRESSION PASS (run this before listing anything):',
    '0a. Classify an INDEPENDENT stroke group as a SCRIBBLE from the STROKE MORPHOLOGY ITSELF, not from whether you managed to find a role for it: rapid back-and-forth repetition, dense crossings, zig-zags, inconsistent/erratic line quality, or repeated cancellation strokes. This rule applies only when the scribble can be identified confidently without deciding the fate of another covered object.',
    '0b. A confidently classified scribble is NON-EXISTENT for the automaton: derive NO state, NO arrow, NO arrowhead, NO self-loop, NO label, NO source/target, NO input symbol, NO stack symbol, NO stack action, and NO topological relation from it. It never enters any analysis table.',
    '0c. NEVER apply the rule "I could not identify a role for this stroke, therefore it is a scribble". Absence of an identifiable structural role is NOT evidence of a scribble. Real elements are routinely partial, faint or hard to read, and every one of the following is a LEGITIMATE element you must keep: an INITIAL arrow that touches only ONE state (it comes from empty space and connects nothing else); a SELF-LOOP whose source and target are the same single state; an arrowhead that is faint, short or barely drawn; a valid label that is blurry, tilted, cramped, or whose comma/slash separators did not survive the scan. Sloppiness is not deletion — an imperfect circle, a crooked arrow, ugly handwriting, a slanted label or a badly drawn ⊥ are all still valid parts of the automaton.',
    '0d. The converse is equally true: a scribble can COINCIDENTALLY touch two states, close into a loop-like shape, or end in something that resembles an arrowhead. So an apparent role does not prove an element is real either. Weigh BOTH stroke morphology and structural context. If they conflict, the stroke is not a confidently classified independent scribble and Phase 0 must not silently delete or reinterpret it.',
    '0e. Never synthesize an edge from strokes that were confidently classified as an independent scribble. In particular, those strokes must not become a long-distance, diagonal, or screen-crossing transition. This does not authorize deleting a separate clean edge merely because a scribble is nearby.',
    '0f. Do NOT mistake a clean curved self-loop arc near a node for a scribble: a scribble is messy, repetitive and overlaps other strokes; a self-loop is a single clean arc that leaves and re-enters the same circle.',
    '0g. A scribble NEXT TO a clean element does not damage that element: read the clean element normally and do NOT lower its confidence merely because a scribble sits nearby. A scribble that directly overlaps or covers an arrow, state, or label is explicitly UNDEFINED by the current specification: do not claim that the covered object is automatically deleted or automatically valid, and do not infer hidden content. Record only visible evidence and genuine visual uncertainty.',

    'PHASE 1 — TWO-PASS LEXICAL AUDIT (supporting evidence only):',
    '1a. PASS 1 (EXTRACT): Read the WHOLE sheet first and extract the global alphabets. If a formal definition is written anywhere (a set-builder language, a list/legend of symbols, or a transition table), use it only as supporting evidence for glyph identity. Never derive or repair graph structure from prose, a familiar exercise, or an expected language. If none exists, derive the alphabets purely from the clearly legible labels.',
    '1b. Compile a GLOBAL INPUT ALPHABET and, for a PDA, a GLOBAL STACK ALPHABET from clearly legible labels. State both in the analysis as supporting audit evidence only. They are NOT hard constraints and may never overwrite a glyph read from its physical zone.',
    '1c. PASS 2 (CROSS-REFERENCE): use repeated glyph shapes and the extracted alphabets to notice ambiguity, not to auto-correct it. When a glyph cannot be resolved from visible evidence, output "?" for that structured field, preserve the literal mark in raw_label_text/zones, and lower confidence. Never choose a convenient alphabet member merely because it makes the automaton look consistent.',
    '1d. EPSILON DISCIPLINE: output "ε" only when an epsilon/empty-input mark is explicitly visible before the comma. NEVER infer ε from a missing, broken, tofu, blurry, or unfamiliar glyph. If the glyph could genuinely be either a letter or ε and the image does not resolve it, output "?" with low confidence rather than silently selecting either one.',
    '1e. BOTTOM-OF-STACK MARKER (PDA only): the canonical bottom marker is "⊥" and the stack starts with exactly one. It is legal only as the existing bottom item / STACK_TOP condition: it may NEVER be popped and a second ⊥ may NEVER be pushed. If the image really shows PUSH ⊥ or POP ⊥, preserve the literal observation and mark it as a semantic contradiction; do not repair or drop it. Output "⊥" only when the visible two-stroke marker described below is identified (with its role as supporting evidence). Do not use an expected first transition by itself to turn an unrelated glyph into ⊥.',
    '1f. HOW ⊥ IS DRAWN BY HAND: it is TWO strokes — a horizontal base bar and a shorter vertical stroke rising upward from about the middle of that bar; the vertical does not descend below the base. There is no circle, loop, subscript, or digit. It can be confused with T, ⊤, L, 1, |, +, ⟂, or ת, especially near ruled-page lines, so verify the strokes instead of blanket-converting lookalikes.',
    '1g. NO BROKEN GLYPHS: never turn a placeholder/tofu box ("□", "▯", "▢"), the replacement character "�", or a garbled square into ε or an expected alphabet symbol. Keep the literal evidence in raw_label_text/zones, put "?" in the affected structured field, and lower that field\'s confidence.',

    'PHASE 2 — TOPOLOGICAL GRAPH TRAVERSAL (structure):',
    '2a. STATES: list every physically drawn circle as a separate observation. Give it a unique non-semantic observation_id such as state_1, state_2, ... and copy only the actually visible state label into id. If the circle has no visible label, use id=""; if ink is visible but unreadable, use id="?" with low confidence. NEVER invent q0/q1/qN to fill a missing label. Set is_accepting=true ONLY for a clearly DOUBLE-bordered circle. Set is_start=true ONLY for the state reached by an arrow coming from empty space.',
    '2a2. ZERO STATE OMISSION OR MERGING: scan the entire chain sequentially and output EVERY drawn circle as its OWN state row — including an unlabeled circle, an unreadable circle, intermediate circles, and circles with non-numeric names ("qn", "q_n", "qi", "p", "A"). Two different physical circles remain two rows even when their visible id strings are identical or both empty/?; observation_id, not id, distinguishes them. Never drop, skip, or merge an intermediate state (no "q0 -> qn -> q1" collapse that swallows the middle circle). states_table and states[] must have exactly one row/object per drawn circle, with none omitted.',
    '2b. PHYSICAL CONNECTORS ONLY: list ONLY arrows actually drawn on the sheet. NEVER invent, complete, or "expect" a transition that is not drawn, and never drop one that is drawn.',
    '2b2. ARROWHEAD DIRECTION (rigid source/target validation): determine each transition\'s direction SOLELY from the physical arrowHEAD — never from text orientation, label position, or left-to-right reading habit. The node the arrowhead POINT touches is the TARGET (target_state); the node at the tail is the SOURCE. BACK-EDGES ARE COMMON and must be preserved exactly: if arrows drawn from q2 and from q3 have their heads landing on q1, then q1 is the TARGET of both (q2 -> q1 and q3 -> q1) — never flip them to q1 -> q2 / q1 -> q3 just to make the graph read forward. Inspect every arrowhead independently; two heads near one node are two separate arrows. When unsure which end has the head, lower the transition confidence rather than guessing the forward direction.',
    '2c. STRICT SELF-LOOP VERIFICATION (anti-hallucination): do NOT generate self-loops by default. Declare a self-loop (source_state.id === target_state.id) ONLY when there is an explicit, physically drawn CIRCULAR loop stroke that leaves and re-enters the SAME circle. If a node merely has text written above/near it but NO physical loop stroke, you must NOT create a self-loop for it — instead associate that text with the nearest valid forward transition by geometric proximity (rule 2d). Floating text is the main cause of hallucinated self-loops on nearly every node; suppress it.',
    '2d. SPATIAL LABEL BINDING: bind each complete label block to the connector supported by its geometry: distance to the connector path, alignment with it, and separation from neighbouring blocks. A label above a state is not automatically a self-loop label, and a nearby self-loop does not make that ownership exclusive. Preserve genuine ambiguity with low confidence; never move a block merely to make the graph look expected. Each transition endpoint must carry the observation_id of the exact physical circle from states[]; a repeated visible id alone is never enough to merge or choose between circles.',
    '2d2. VISIBLE RULE-LINE COUNT (before transcription): for every physical arrow, first count the distinct label rows geometrically bound to that arrow and store that integer in visible_rule_line_count. Count rows even when a row is partly unreadable. Only after fixing this visual count may you transcribe rules[]. The final rules.length MUST equal visible_rule_line_count. Never merge several physical rows into one rule, never split one physical row into several rules, and never invent a missing transcription merely to satisfy the count; use ? and low confidence for unreadable visible characters.',
    '2e. MULTI-RULE ARROWS: a single drawn arrow (forward OR self-loop) often carries SEVERAL rule lines stacked vertically. Output each written line as a SEPARATE object in that transition\'s rules array — never merge lines and never keep only the first line.',
    '2f. A forward arrow with two or more rules is fully valid and is NOT evidence that a self-loop label was stolen. Do not create a self-loop or move rules merely because a normal arrow has several lines.',
    '2g. RULE MICRO-AUDIT — SPATIAL ZONE SPLIT (this is a binding rule): deskew each physical rule line along its own baseline, locate the FIRST COMMA and the SLASH as geometric ink anchors, and only then split it. The ink physically BEFORE/LEFT OF THE COMMA is INPUT/read_input (usually the one glyph immediately beside the comma); the ink BETWEEN COMMA AND SLASH is STACK_TOP/pop_value; the ink physically AFTER/RIGHT OF THE SLASH is ACTION plus its symbol. The required geometry is LEFT field < comma < MIDDLE field < slash < RIGHT field along the local baseline. Split first and decode each crop separately. If anchors or ordering cannot be localized, use ?/low confidence and an all--1 line_bbox rather than using display order or a flat transcription.',
    '2g2. HEBREW / RTL WARNING: these labels mix Latin letters, punctuation and Hebrew words written right-to-left, in free handwriting. A flat OCR string of such a line comes back with its characters in a SCRAMBLED order. NEVER let the character order of a flat string decide which value is the input, which is the stack top and which is the action. In particular, a Hebrew action word ("דחוף", "שלוף", "ללא שינוי", "לל״ש") always belongs to the RIGHT zone even when a garbled transcription appears to place it on the left — never move it into read_input, and never swap read_input, pop_value and the action between each other because of reading direction.',
    '2g3. ZONE EVIDENCE: for each rule line also fill zones.left_text / zones.middle_text / zones.right_text with the literal text you see in that physical zone, and line_bbox with the normalised 0..1 box of that ONE line (x,y = top-left corner, w,h = size). Count the visibly separate baselines in the label block before transcribing them; rules.length must equal that visible line count. If you genuinely cannot localize a line or its separators, set every line_bbox field to -1 and lower the affected confidence — NEVER invent coordinates or split/merge a line to make semantics look tidy.',
    '2h. NO SEQUENTIAL-BACKBONE ASSUMPTION: numbering such as q0,q1,q2 does not prove that arrows connect consecutive states. A bypass, isolated state, unreachable state, or dead end may be what was actually drawn. You may list it as a structural review note, but must not redirect an arrow, invent a missing edge, change a state, or lower visual confidence solely to force a sequential flow.',

    'OUTPUT ORDER — VISUAL CHAIN-OF-THOUGHT (fill the analysis object FIRST, before anything else):',
    'analysis.states_table = a markdown table listing EVERY detected circle: | observation_id | literal visible id | double border? | start arrow? |. Keep separate rows for duplicate/missing labels.',
    'analysis.connectors_table = a markdown table listing EVERY physically drawn arrow, with the arrowhead end and the pre-transcription label-row count recorded explicitly: | tail observation_id | arrowhead lands on observation_id (= target) | source | target | self-loop stroke? | visible rule-line count |. Fill "source"/"target" strictly from the arrowhead column, so back-edges (e.g. q2 -> q1, q3 -> q1) are recorded in their true direction.',
    'analysis.label_binding_table = a markdown table mapping EVERY written rule text to its geometrically closest connector, applying rule 2d: | text | bound connector | reason |.',
    'analysis.input_glyph_audit_table = one row per rule: | raw_label_text | glyph before comma as seen | visible candidates | chosen read_input | reason |. If visible evidence does not resolve the glyph, chosen read_input must be "?"; the global alphabet is supporting evidence, not permission to guess.',
    'analysis.rule_parse_table = one row per rule: | raw_label_text | LEFT zone (read) | MIDDLE zone (stack top) | RIGHT zone (action text) | action symbol | chosen action |.',
    'analysis.final_audit_table = one row per rule: | raw_label_text | read_input | stack_action | pop_value | push_value | pop_symbol | ok/contradiction |. If a row contradicts the structural rules (e.g. a POP whose symbol differs from the stack top, or a POP of ⊥), RE-INSPECT THE IMAGE for that line and correct only what you actually misread. If the image really does show the contradiction, RECORD IT AS SEEN and mark the row "contradiction" — do NOT silently change either symbol to make the rule legal, and do NOT drop the rule.',
    'Then derive the output STRICTLY from your own tables: the states array must match states_table exactly, and the transitions array must match connectors_table + label_binding_table exactly — a node/edge/self-loop that does not appear in those tables must NOT appear in the output, and vice-versa. Return only the JSON object.',

    'FIELD RULES:',
    'Each state object must include observation_id, id, is_accepting, is_start, and confidence. observation_id is physical identity; id is literal visible label evidence and may be empty or ?.',
    'Each transition must include visible_rule_line_count and source_state/target_state must each include the exact observation_id from states[] in addition to the literal id and confidence.',
    'Each rule inside a transition MUST include raw_label_text, zones, line_bbox, read_input (LEFT zone), pop_value (MIDDLE zone = the current stack-top condition), stack_action, push_value and pop_symbol (both from the RIGHT zone).',
    'STACK SEMANTICS (these define the meaning of each action — follow them exactly):',
    '  • PUSH X ADDS a new item X ON TOP of the existing stack top. The old top is NOT removed and NOT replaced — it stays and simply moves one layer down. Two separate items now sit in two separate layers; never describe the result as one merged symbol such as "AA". Put ONLY the pushed symbol in push_value.',
    '  • The pushed symbol MAY DIFFER from the stack top and that is fully legal: "b,A / דחוף B" is a correct rule that leaves B on top and A directly beneath it. NEVER flag, "fix" or lower confidence on a PUSH just because push_value differs from pop_value. The sole exception is the protected bottom marker: PUSH ⊥ is always semantically invalid because ⊥ exists exactly once at the bottom.',
    '  • POP X removes ONLY the single top item, and the item beneath it becomes the new top. Put the popped symbol in pop_symbol and set push_value="ε".',
    '  • For a POP the written symbol must equal the stack top (pop_symbol === pop_value). If the image really shows them differing, TRANSCRIBE BOTH AS SEEN — put the middle-zone symbol in pop_value and the right-zone symbol in pop_symbol, lower the confidence, and let the tool report the contradiction. NEVER copy one over the other to make the rule legal.',
    '  • ⊥ can never be popped or pushed. If a line appears to read "שלוף ⊥" or "דחוף ⊥", re-inspect it; if that really is what is drawn, output it as seen with low confidence rather than altering it.',
    '  • NONE leaves the stack unchanged: nothing is pushed and nothing is popped, but the input symbol and the stack-top condition are still required for the transition to fire. Set push_value="ε" and pop_symbol="ε".',
    'For a FINITE AUTOMATON drawn with no stack notation, set stack_action="NONE" and pop_value/push_value/pop_symbol="ε"; read_input still holds the input symbol before any comma.',
    'raw_label_text must be the exact text you see for that single physical rule line, e.g. "a,A / A דחוף" or "b,S / S שלוף". It must not be empty for a labelled rule. If a glyph is unclear, use ? and lower confidence. If a label has two stacked lines, output two rule objects even when the two literal raw_label_text values happen to be identical.',
    'The approved written action forms are binding: "דחוף" => stack_action.type="PUSH" with the displayed symbol in push_value.value; "שלוף" => stack_action.type="POP" with the displayed symbol in pop_symbol.value and push_value.value="ε"; "ללא שינוי"/"לל״ש" => stack_action.type="NONE". Other wording remains UNKNOWN unless the user defines it later.',
    'Do not invent meanings for unapproved symbolic action notations such as a bare minus, plus, box, or empty symbol. The currently approved actions are the written forms for PUSH, POP, and NONE listed here. If the RIGHT zone uses an unfamiliar notation, preserve it in zones.right_text/raw_label_text, set stack_action.type="UNKNOWN", put "?" in any unreadable action symbol, lower confidence, and do not infer an operation from expected semantics.',
    'Use stack_action.type="NONE" ONLY when the label explicitly says the approved form "ללא שינוי" or "לל״ש". Do not infer NONE from a missing, unfamiliar, translated, or merely similar word.',
    'Use stack_action.type="UNKNOWN" when the RIGHT-zone operation itself cannot be read or uses a notation not approved above. UNKNOWN is incomplete evidence, not NONE, PUSH, or POP.',
    'CRITICAL ACTION CHECK before output: determine the action from the physical RIGHT zone. If it clearly contains the approved word "שלוף", choose POP; if it clearly contains "דחוף", choose PUSH; "ללא שינוי"/"לל״ש" means NONE. A scrambled flat raw_label_text is audit evidence only and may not override that spatial choice.',
    'CRITICAL INPUT CHECK before output: read_input is exactly the glyph in the LEFT zone, WHATEVER letter it is — copy it from the image, never substitute from memory. Output ε only when epsilon/empty is explicitly drawn (rule 1d).',
    'NO SEMANTIC GUESSING: never change a field because the resulting automaton would "make more sense", would otherwise loop, or does not match a familiar exercise. Your job is to report faithfully what is drawn, including anything that looks wrong. Re-reading the image is always allowed; inventing a value to repair the logic is not.',
    'Format examples (these illustrate ZONE-SPLITTING only — they are NOT a target language): "x,A / A דחוף" => read_input=x, pop_value=A, stack_action=PUSH, push_value=A, pop_symbol=ε. "x,A / B דחוף" => read_input=x, pop_value=A, stack_action=PUSH, push_value=B, pop_symbol=ε (a perfectly legal rule). "y,A / A שלוף" => read_input=y, pop_value=A, stack_action=POP, pop_symbol=A, push_value=ε. "z,S / ללא שינוי" => read_input=z, pop_value=S, stack_action=NONE, push_value=ε, pop_symbol=ε. "ε,⊥ / S דחוף" => read_input=ε, pop_value=⊥, stack_action=PUSH, push_value=S, pop_symbol=ε.',
    'MULTI-RULE ARROW EXAMPLE: one arrow carrying the three stacked lines "b,⊥ / S דחוף", "b,S / A דחוף", "b,A / A דחוף" is ONE transition with THREE rules in its rules array — not three transitions and not one merged rule. Rules sharing the same read_input but a different pop_value are NOT duplicates; keep all of them, in the visual top-to-bottom order.',
    'When the actual two-stroke bottom marker is visible, its canonical JSON value is "⊥". Never output retired Z0/Z_0/Z₀ as a substitute for that marker, and never blanket-convert unrelated visible text. Output ε only for an explicitly visible epsilon/empty-input mark; an unreadable glyph is "?", not ε.',
    'A label like "x, Y / Z" reads as: input x (LEFT), stack-top condition Y (MIDDLE), then the action Z (RIGHT).',
    'Confidence calibration: clear state labels, clear arrows, and readable fields should usually be 0.85-0.98. Use confidence below 0.75 only for genuine ambiguity — unclear handwriting, overlapping arrows, a glyph you corrected, or cropped/border text. If unsure, still provide the best value with a lower confidence score.',
    ...(isTm ? [
      'MODEL TYPE CONTEXT (provided by the client): this sheet is a TURING MACHINE (TM), not a finite automaton and not a pushdown automaton.',
      tmContextBlock,
      'TM LABELS OVERRIDE the PDA/FA zone-split rules above. A transition label contains a tape symbol to read, a tape symbol to write, and a head direction. Accept literal forms such as "a -> b, R", "a/b, R", and "a, b, R"; direction is L, R, S, or N (S/N both mean no head movement). Preserve the visible spelling, punctuation, separators, and direction verbatim in raw_label_text.',
      'For schema compatibility, put the read tape symbol in read_input.value, set stack_action.type="NONE", and set pop_value.value and push_value.value to empty strings. These are compatibility fields only: never infer a stack, PUSH, POP, epsilon transition, or bottom-of-stack marker for a TM.',
      'For a blank tape symbol, prefer the literal symbol drawn on the sheet (normally "_" or "B"). Do not rewrite a literal TM label into PDA notation.',
      'In analysis.input_glyph_audit_table audit the read-tape symbol. In analysis.rule_parse_table record raw_label_text, read, write, and direction. In analysis.final_audit_table verify the same three TM fields; put "—" in stack-only columns.',
    ] : isPda ? [] : [
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
      const reasoning = openAIReasoning(MODEL, false);
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'content-type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: MODEL,
          instructions: isTm ? tmContextBlock : undefined,
          ...(reasoning ? { reasoning } : {}),
          input: [{
            role: 'user',
            content: [
              { type: 'input_text', text: promptText },
              ...urls.flatMap((image_url, i) => [
                { type: 'input_text', text: `IMAGE ${i + 1} ROLE: ${roles[i]}` },
                { type: 'input_image', image_url, detail: 'high' },
              ]),
            ],
          }],
          max_output_tokens: 6000,
          text: {
            format: {
              type: 'json_schema',
              name: isTm ? 'tm_transition_scan' : (isPda ? 'pda_transition_scan' : 'fa_transition_scan'),
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
      recordOpenAIUsage(data, MODEL, { purpose: 'legacy-diagram-parse', attempt: 'primary' });
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
  let qualityProblems = parseQualityProblems(parsedJson, isPda, isTm);
  if (qualityProblems.length) {
    console.warn('AI parse failed quality gate, retrying:', qualityProblems.slice(0, 8).join(' | '));
    const retryPrompt = prompt + '\n\n' + (isPda ? [
      'VALIDATION FAILURE RECOVERY PASS:',
      'Your previous JSON failed validation. The most common failure is leaving raw_label_text empty or omitting the Hebrew action word.',
      `Detected problems: ${qualityProblems.slice(0, 12).join('; ')}`,
      'Retry from the image, not from the previous answer. For every visible transition-rule line, raw_label_text must be a literal transcription of that ONE line and must include the comma, the slash, and the visible action word: דחוף / שלוף / ללא שינוי.',
      'Do not replace a visible Hebrew action word with ε, ⊥, or a guessed push string. Determine stack_action.type from the physical RIGHT zone; flat raw text may only support the audit.',
      'Do not turn a missing or ambiguous LEFT-zone glyph into ε or an expected alphabet letter. If the image does not resolve it, use ? and low confidence.',
      'Re-read every zone from its position in the image. Do not repair a rule by making it semantically tidy: a PUSH whose symbol differs from the stack top is legal, and a genuine contradiction must be reported as seen rather than smoothed over.',
      'If you cannot read one character, write your best visible transcription with ? for the unclear character, set confidence below 0.60, and keep parsing the rest. Never use an empty string.',
      'Before returning JSON, check every rules[].raw_label_text. If any is empty, or lacks both comma and slash, re-read that physical line. If a character remains unreadable, preserve the visible evidence, use ?, and lower confidence instead of inventing a repair.',
    ] : isTm ? [
      'VALIDATION FAILURE RECOVERY PASS — TURING MACHINE:',
      'Your previous JSON failed TM label validation. Do not apply PDA or finite-automaton label rules.',
      `Detected problems: ${qualityProblems.slice(0, 12).join('; ')}`,
      'Retry from the image, not from the previous answer. Every visible TM transition line must be copied literally into raw_label_text and contain read symbol, write symbol, and direction L/R/S/N, such as "a -> b, R", "a/b, R", or "a, b, S".',
      'Do not look for or invent PUSH, POP, stack tops, ε, or ⊥. Use stack_action="NONE" and empty pop_value/push_value compatibility fields.',
      'If a tape glyph is unclear, keep your best literal transcription with ? and lower confidence, but do not omit the read/write/direction structure.',
    ] : [
      'VALIDATION FAILURE RECOVERY PASS:',
      'Your previous JSON failed validation. The most common failure on a finite-automaton sheet is leaving raw_label_text empty for a labelled arrow.',
      `Detected problems: ${qualityProblems.slice(0, 12).join('; ')}`,
      'Retry from the image, not from the previous answer. This is a FINITE AUTOMATON (DFA/NFA) sheet: every physical arrow-label LINE must appear once as raw_label_text with its bare input symbols (e.g. "a" or "0,1"). Keep alternatives written on one physical line together in that one rule; do not split them merely to increase rules.length. Use stack_action="NONE" and pop_value/push_value="ε".',
      'If you cannot read one character, write your best visible transcription with ? for the unclear character, set confidence below 0.60, and keep parsing the rest. Never use an empty string.',
    ]).join('\n') + '\n' + [
      'For EVERY transition, recount the physical label baselines before transcription and set visible_rule_line_count to that independent visual count. Verify visible_rule_line_count === rules.length. Do not invent a missing rule: preserve an unreadable visible row with ? and low confidence.',
      'Keep every physical state circle as its own observation_id. Never invent a q-number for an empty/unreadable state label and never merge two circles merely because their id text is the same.',
    ].join('\n');
    parsedJson = await callVision(retryPrompt);
    qualityProblems = parseQualityProblems(parsedJson, isPda, isTm);
  }
  const countedVisibleLines = parsedJson && Array.isArray(parsedJson.transitions) &&
    parsedJson.transitions.some(t => t && typeof t.visible_rule_line_count === 'number' &&
      Number.isInteger(t.visible_rule_line_count) && t.visible_rule_line_count > 0);
  if (qualityProblems.some(p => p === 'no transition rules') && !countedVisibleLines) {
    const err = new Error('ה-AI לא הצליח לקרוא את תוויות המעברים בצורה אמינה. נסה צילום חד/קרוב יותר, או הדבק JSON ידנית. פרטים: ' + qualityProblems.slice(0, 4).join(' | '));
    err.status = 422;
    throw err;
  }
  if (qualityProblems.length) {
    // Partial spatial evidence is precisely what the human-in-the-loop review
    // is for. Return it with warnings instead of discarding the whole scan.
    console.warn('AI parse returned reviewable quality warnings:', qualityProblems.slice(0, 12).join(' | '));
  }
  if (parsedJson && parsedJson.analysis) {
    console.log('--- Visual CoT analysis ---');
    ['states_table', 'connectors_table', 'label_binding_table', 'input_glyph_audit_table', 'rule_parse_table', 'final_audit_table'].forEach(k => {
      if (parsedJson.analysis[k]) console.log(String(parsedJson.analysis[k]).slice(0, 800));
    });
  }
  return {
    analysis: (parsedJson && parsedJson.analysis) || null,
    quality_problems: qualityProblems,
    ...normalizePayload(parsedJson, urls[0] || '', isPda, isTm),
  };
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
      sendApi(req, res, 200, { ok: true, model: MODEL, labelModel: LABEL_MODEL, topologyModel: TOPOLOGY_MODEL,
        labelEscalationModel: LABEL_ESCALATION_ENABLED ? LABEL_ESCALATION_MODEL : '',
        labelEscalationEnabled: LABEL_ESCALATION_ENABLED,
        labelEscalationConfidence: LABEL_ESCALATION_CONFIDENCE,
        labelTargetedRetryEnabled: LABEL_TARGETED_RETRY_ENABLED,
        labelTargetedRetryMaxBatches: LABEL_TARGETED_RETRY_MAX_BATCHES,
        topologyAuditModel: TOPOLOGY_AUDIT_MODEL, topologyAuditStage: true,
        topologyEscalationModel: TOPOLOGY_ESCALATION_ENABLED ? TOPOLOGY_ESCALATION_MODEL : '',
        topologyEscalationEnabled: TOPOLOGY_ESCALATION_ENABLED,
        topologyEscalationConfidence: TOPOLOGY_ESCALATION_CONFIDENCE,
        topologyLineGeometryEnabled: TOPOLOGY_LINE_GEOMETRY_ENABLED,
        reasoningEffort: OPENAI_REASONING_EFFORT,
        escalationReasoningEffort: OPENAI_ESCALATION_REASONING_EFFORT,
        pricingVersion: OPENAI_PRICING_VERSION,
        scanMaxEstimatedUsd: OPENAI_SCAN_MAX_ESTIMATED_USD,
        scanMaxApiCalls: OPENAI_SCAN_MAX_API_CALLS,
        hasKey: Boolean(process.env.OPENAI_API_KEY) });
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
      const stage = String(payload.stage || '').trim().toLowerCase();
      if (stage && stage !== 'topology' && stage !== 'topology-audit' && stage !== 'labels') {
        sendApi(req, res, 400, { error: 'stage must be "topology", "topology-audit", or "labels"' }, quotaHeaders);
        return;
      }
      const images = Array.isArray(payload.images) ? payload.images.filter(Boolean) : [payload.image].filter(Boolean);
      const crops = Array.isArray(payload.crops) ? payload.crops.filter(Boolean) : [];
      if (stage === 'labels') {
        const topology = payload.topology;
        if (!topology || typeof topology !== 'object') {
          sendApi(req, res, 400, { error: 'labels stage requires topology evidence' }, quotaHeaders);
          return;
        }
        if (!crops.length || !crops.some(crop => crop &&
          (crop.kind === 'line' || crop.kind === 'state_label') && crop.image_url)) {
          sendApi(req, res, 400, { error: 'labels stage requires at least one line or state_label crop with image_url' }, quotaHeaders);
          return;
        }
        if (crops.length > 64) {
          sendApi(req, res, 400, { error: 'labels stage accepts at most 64 crop records' }, quotaHeaders);
          return;
        }
      } else if (stage === 'topology-audit') {
        if (!payload.topology || typeof payload.topology !== 'object') {
          sendApi(req, res, 400, { error: 'topology-audit stage requires initial topology evidence' }, quotaHeaders);
          return;
        }
        if (images.length > 1) {
          sendApi(req, res, 400, { error: 'topology-audit stage accepts at most one full original image' }, quotaHeaders);
          return;
        }
        if (crops.length > 12) {
          sendApi(req, res, 400, { error: 'topology-audit stage accepts at most 12 topology-tile crop records' }, quotaHeaders);
          return;
        }
      } else {
        if (!images.length) {
          sendApi(req, res, 400, { error: 'Missing image data URL' }, quotaHeaders);
          return;
        }
        if (stage === 'topology' && images.length > 3) {
          sendApi(req, res, 400, { error: 'topology stage accepts at most 3 image variants' }, quotaHeaders);
          return;
        }
      }
      if (activeParseRequests >= MAX_CONCURRENT_PARSES) {
        sendApi(req, res, 429, { error: 'The scanner is busy. Try again shortly.' }, {
          ...quotaHeaders,
          'retry-after': '1',
        });
        return;
      }

      activeParseRequests += 1;
      const stageStartedAt = Date.now();
      if (stage === 'topology') resetScanBudget(payload.scan_session_id);
      recordScanRuntime('stage-start', { stage: stage || 'legacy', session: String(payload.scan_session_id || ''),
        image_count: images.length, crop_count: crops.length,
        model: stage === 'topology' ? TOPOLOGY_MODEL : (stage === 'topology-audit' ? TOPOLOGY_AUDIT_MODEL : (stage === 'labels' ? LABEL_MODEL : MODEL)) });
      try {
        try {
          const usageScope = { stage: stage || 'legacy', session: String(payload.scan_session_id || ''), calls: [] };
          const parsed = await scanUsageStorage.run(usageScope, async () => (stage === 'topology'
            ? parseTopologyStage(images, payload.image_roles, payload.scan_session_id)
            : stage === 'topology-audit'
              ? parseTopologyAuditStage(payload.topology, images, payload.image_roles, crops,
                payload.model_type, payload.scan_session_id)
            : stage === 'labels'
              ? parseLabelsStage(payload.topology, crops, payload.model_type, payload.scan_session_id)
              : parseDiagram(images, payload.model_type, payload.image_roles)));
          const scanUsage = summarizeScanUsage(usageScope);
          recordScanRuntime('stage-complete', { stage: stage || 'legacy', session: String(payload.scan_session_id || ''),
            elapsed_ms: Date.now() - stageStartedAt,
            state_count: Array.isArray(parsed.states) ? parsed.states.length : null,
            transition_count: Array.isArray(parsed.transitions) ? parsed.transitions.length : null,
            label_read_count: Array.isArray(parsed.label_reads) ? parsed.label_reads.length : null,
            api_call_count: scanUsage.call_count, estimated_cost_usd: scanUsage.estimated_cost_usd });
          sendApi(req, res, 200, { ...parsed, model: stage === 'topology'
            ? TOPOLOGY_MODEL : (stage === 'topology-audit' ? TOPOLOGY_AUDIT_MODEL : (stage === 'labels' ? LABEL_MODEL : MODEL)),
          scan_usage: scanUsage }, quotaHeaders);
        } catch (error) {
          recordScanRuntime('stage-failed', { stage: stage || 'legacy', session: String(payload.scan_session_id || ''),
            elapsed_ms: Date.now() - stageStartedAt, error_name: String(error && error.name || ''),
            error_message: String(error && error.message || error).slice(0, 500), status: Number(error && error.status) || null });
          throw error;
        }
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
    if (isApiRequest) sendApi(req, res, status, { error: message, ...(err.code ? { code: String(err.code) } : {}) });
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
    console.log(`OpenAI label model: ${LABEL_MODEL}`);
    if (LABEL_ESCALATION_ENABLED && LABEL_ESCALATION_MODEL !== LABEL_MODEL) {
      console.log(`OpenAI label escalation model: ${LABEL_ESCALATION_MODEL} (confidence < ${LABEL_ESCALATION_CONFIDENCE})`);
    }
    if (TOPOLOGY_MODEL !== MODEL) console.log(`OpenAI topology model: ${TOPOLOGY_MODEL}`);
    if (TOPOLOGY_AUDIT_MODEL) console.log(`OpenAI topology audit model: ${TOPOLOGY_AUDIT_MODEL}`);
    if (TOPOLOGY_ESCALATION_ENABLED && TOPOLOGY_ESCALATION_MODEL !== TOPOLOGY_AUDIT_MODEL) {
      console.log(`OpenAI topology escalation model: ${TOPOLOGY_ESCALATION_MODEL} ` +
        `(confidence < ${TOPOLOGY_ESCALATION_CONFIDENCE})`);
    }
    console.log(`OpenAI reasoning effort: ${OPENAI_REASONING_EFFORT}; escalation: ${OPENAI_ESCALATION_REASONING_EFFORT}`);
    console.log(`OpenAI scan safety limit: estimated $${OPENAI_SCAN_MAX_ESTIMATED_USD.toFixed(2)} / ` +
      `${OPENAI_SCAN_MAX_API_CALLS} calls; Terra escalation is ` +
      `${LABEL_ESCALATION_ENABLED || TOPOLOGY_ESCALATION_ENABLED ? 'explicitly enabled' : 'disabled'}`);
  });
  return server;
}

if (require.main === module) startServer();

module.exports = {
  server,
  startServer,
  // Pure helpers, exported so the scan-normalisation contract can be tested
  // deterministically without a network call to the vision model.
  BOTTOM,
  EPSILON,
  PDA_ACTION_WORD_GUIDE,
  normalizeSymbolValue,
  normalizeStackAction,
  ruleSemanticIssues,
  normalizePayload,
  parseQualityProblems,
  normalizeTopologyStageResult,
  normalizeTopologyAuditManifest,
  normalizeTopologyInventoryResult,
  planTopologyTargetedTrace,
  applyTopologyTargetedTrace,
  groupTopologyLineFragments,
  normalizeTopologyLineGeometryAuditResult,
  applyTopologyLineGeometryAudit,
  normalizeTopologyAuditStageResult,
  normalizeLabelsStageResult,
  buildLabelCropBatches,
  labelBatchEscalationReasons,
  mergeLabelBatchCandidates,
  estimateOpenAICost,
  scanBudgetDecision,
  summarizeScanUsage,
  topologyStageSchema,
  topologyInventorySchema,
  topologyTargetedTraceSchema,
  topologyLineGeometryAuditSchema,
  labelsStageSchema,
  buildTopologyInventoryPrompt,
  buildTopologyReplacementAuditPrompt,
  buildTopologyTargetedTracePrompt,
  topologyLineGeometryConnectorManifest,
  buildTopologyLineGeometryAuditPrompt,
  topologyInventoryEscalationReasons,
  topologyAuditEscalationReasons,
  topologyLineAuditEscalationReasons,
  parseTopologyAuditStage,
  parseLabelsStage,
};
