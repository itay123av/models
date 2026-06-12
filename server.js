const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
loadEnv(path.join(ROOT, '.secrets', 'openai.env'));
loadEnv(path.join(ROOT, '.env'));
const PORT = Number(process.env.PORT || 8790);
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
const DEFAULT_CONFIDENCE = 0.9;

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

function send(res, status, data, headers = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, {
    'content-type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    ...headers,
  });
  res.end(body);
}

function readBody(req, limit = 24 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Image is too large'));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
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

function normalizePayload(value, imageUrl) {
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
    const rules = ruleSrcs.filter(Boolean).map(r => ({
      read_input: {
        value: String((r.read_input && r.read_input.value) ?? r.read ?? 'ε'),
        confidence: Number((r.read_input && r.read_input.confidence) ?? r.read_confidence ?? DEFAULT_CONFIDENCE),
      },
      stack_action: {
        type: String((r.stack_action && r.stack_action.type) || r.action || 'NONE').toUpperCase(),
        confidence: Number((r.stack_action && r.stack_action.confidence) ?? r.action_confidence ?? DEFAULT_CONFIDENCE),
      },
      push_value: {
        value: String((r.push_value && r.push_value.value) ?? r.push ?? 'ε'),
        confidence: Number((r.push_value && r.push_value.confidence) ?? r.push_confidence ?? DEFAULT_CONFIDENCE),
      },
      pop_value: {
        value: String((r.pop_value && r.pop_value.value) ?? r.top ?? r.pop ?? 'ε'),
        confidence: Number((r.pop_value && r.pop_value.confidence) ?? r.top_confidence ?? r.pop_confidence ?? DEFAULT_CONFIDENCE),
      },
    }));
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

  if (states.size && ![...states.values()].some(s => s.is_start)) {
    const first = states.values().next().value;
    if (first) first.is_start = true;
  }
  return { states: [...states.values()], transitions };
}

async function parseDiagram(imageUrl) {
  if (!process.env.OPENAI_API_KEY) {
    const err = new Error('OPENAI_API_KEY is missing. Put it in .env');
    err.status = 401;
    throw err;
  }

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
          states_table: { type: 'string' },
          connectors_table: { type: 'string' },
          label_binding_table: { type: 'string' },
        },
        required: ['states_table', 'connectors_table', 'label_binding_table'],
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
                required: ['read_input', 'stack_action', 'push_value', 'pop_value'],
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
  // Use an internal graph-traversal visual audit before emitting JSON. The model
  // should spend its effort on topology first (states, double circles, start
  // arrow, self-loops, then transitions), then output only the strict JSON.
  const prompt = [
    'You are parsing a hand-drawn automaton diagram (finite automaton or pushdown automaton) for an Israeli high-school automata tool.',
    'Do not rush and do not guess from a quick glance. Follow this two-phase visual reasoning protocol. You will write your visual chain-of-thought INTO the JSON analysis tables FIRST, and only then derive the states and transitions from those tables:',
    'PHASE 1 - GLOBAL CONTEXT AUDIT (lexical constraints):',
    '1a. Scan the ENTIRE sheet first. If a language definition formula is written anywhere (usually at the top, e.g. "L = {a^i b^j c^(i-j) | i>=4}"), read it and derive the valid input alphabet, the stack symbols, and any sequential phase structure it implies (e.g. a stacking phase that reads one letter and pushes, then later phases that read other letters and pop).',
    '1b. Compile the GLOBAL INPUT ALPHABET (every distinct input letter appearing across all clearly legible labels) and the GLOBAL STACK ALPHABET (every distinct stack symbol). Treat these global alphabets as hard lexical constraints for the rest of the parse: a parsed character that is not in them is almost certainly an OCR mistake.',
    '1c. Resolve ambiguous handwriting with the global alphabets plus topological consistency: a cursive glyph resembling "ε", "e", "i", "u" or "cl" must resolve to a symbol that exists in the global alphabet and fits its neighborhood — inside a segment whose transitions repeatedly read one letter and push, an ambiguous glyph is almost always that same letter (a machine cannot count by pushing on ε-moves alone); near a boundary between two letter-segments, resolve by the position in the sequence. Always prefer a symbol from the sheet\'s own global alphabets over generic Greek or special characters — never output ε, φ, or a symbol foreign to the sheet for a glyph that the global alphabet explains better. Output "ε" as the input only where the move clearly reads nothing, which is typical for single forward arrows between segments. Whenever you correct a glyph this way, lower that field\'s confidence.',
    '1d. THE INITIAL STACK MARKER: in this tool the stack ALWAYS starts with exactly one symbol, Z0, already at the top before anything is pushed. Sheets denote this bottom marker with different glyphs — "Z0", "Z_0", "Z₀", "⊥", "$", "#", or even a plain letter. Identify it by ROLE, not glyph: the symbol tested as the stack-top condition on the very first transition(s) out of the start state, BEFORE anything was pushed, is the initial marker — ALWAYS output it as "Z0". A symbol that first appears by being PUSHED (e.g. the S in "ε, Z0 / S") is a regular stack symbol — keep it as written.',
    'PHASE 2 - TOPOLOGICAL GRAPH TRAVERSAL (structure):',
    '2-pre. DEBRIS FILTERING PASS: before listing anything, detect every scribbled-out region on the sheet — repeating high-frequency zig-zags, wavy cancellation waves, X-marks, or dense scratch clusters covering other ink. Everything under such debris is DELETED work: parse NO nodes, NO transitions, and NO labels from those regions; never let them enter any analysis table; and NEVER create a long-distance edge that spans across or originates from an erased region. Clean self-loop arcs near a node are NOT debris — debris is messy, repetitive, and covers other strokes.',
    '2a. Identify every physically drawn node circle and its label (such as q0, q1, q2). For each state inspect the border carefully: set is_accepting=true ONLY when the state is drawn with a double circle. Identify the start state by the incoming arrow from empty space and set is_start=true only for that state.',
    '2b. PHYSICAL CONNECTORS ONLY: list ONLY the arrows that are physically drawn on the sheet. NEVER invent, complete, or "expect" a transition that is not actually drawn — and never drop one that is drawn.',
    '2c. STRICT SELF-LOOP VERIFICATION: declare a self-loop (identical source_state.id and target_state.id) ONLY when there is an explicit, physically drawn loop stroke that leaves and re-enters the SAME circle. If text is written above or near a state but there is NO such loop stroke, do NOT create a self-loop for it — bind that text to the geometrically closest physically drawn arrow instead.',
    '2c2. LABEL BINDING BY GEOMETRIC PROXIMITY: bind every written rule text to its geometrically closest physical connector. When a state DOES have a drawn loop stroke, rule text written directly above/on that state belongs exclusively to that loop; rule text written along a forward arrow belongs only to that arrow. Never mix bindings between adjacent connectors: forward arrows between consecutive states usually carry a SINGLE rule.',
    '2d. MULTI-RULE ARROWS: a single drawn arrow (forward or self-loop) often carries SEVERAL label lines stacked vertically. Output each written line as a SEPARATE object in that transition\'s rules array. Never merge lines together and never keep only the first line.',
    '2e. SANITY CHECK before output: if a forward arrow ended up with two or more rules while a nearby state (especially its source) has NO self-loop in your output, you almost certainly mis-assigned that state\'s self-loop rules — re-inspect and move them back to a self-loop on that state.',
    '2f. IGNORE crossed-out work: any arrow, label, or region cancelled with wavy lines, zig-zag strokes, repeated scribbles, or X marks is a DELETION by the student — never output it. Distinguish cancellation scribbles (messy, repetitive, covering other ink) from valid clean self-loop arcs drawn near a node.',
    'OUTPUT ORDER (Visual Chain-of-Thought): fill the analysis object FIRST, before anything else. analysis.states_table = a markdown table listing EVERY detected circle: | id | double border? | start arrow? |. analysis.connectors_table = a markdown table listing EVERY physically drawn arrow: | source | target | self-loop stroke? |. analysis.label_binding_table = a markdown table mapping EVERY written rule text to its geometrically closest connector: | text | bound connector |.',
    'Then derive the output strictly from your own tables: the states array must match states_table exactly, and the transitions array must match connectors_table + label_binding_table exactly — a transition or self-loop that does not appear in connectors_table must NOT appear in transitions. Return only the JSON object.',
    'Each state object must include id, is_accepting, is_start, and confidence.',
    'Each rule inside a transition has: input symbol read, current stack-top condition (pop_value), stack action, and pushed value. For stack_action: PUSH keeps the stack-top condition in place and pushes push_value on top of it; POP removes the matched stack-top; NONE leaves the stack unchanged.',
    'Use ε for epsilon/no input/no stack condition/no pushed value. The student may write "e", "E", or "ε" for epsilon — always output "ε".',
    'A label like "x, Y / Z" reads as: input x, stack-top condition Y, then the action part Z (pushed string, or a pop mark).',
    'Confidence calibration: clear state labels, clear arrows, and readable fields should usually be 0.85-0.98. Use confidence below 0.75 only for genuinely risky ambiguity such as unclear handwriting, overlapping arrows, glyphs you corrected, or cropped/border text.',
    'If unsure, still provide the best value with a lower confidence score.',
  ].join('\n');

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
          { type: 'input_image', image_url: imageUrl },
        ],
      }],
      text: {
        format: {
          type: 'json_schema',
          name: 'pda_transition_scan',
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
  const parsedJson = JSON.parse(text);
  if (parsedJson && parsedJson.analysis) {
    console.log('--- Visual CoT analysis ---');
    ['states_table', 'connectors_table', 'label_binding_table'].forEach(k => {
      if (parsedJson.analysis[k]) console.log(String(parsedJson.analysis[k]).slice(0, 800));
    });
  }
  return { analysis: (parsedJson && parsedJson.analysis) || null, ...normalizePayload(parsedJson, imageUrl) };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'OPTIONS') {
      send(res, 204, '');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      send(res, 200, { ok: true, model: MODEL, hasKey: Boolean(process.env.OPENAI_API_KEY) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/parse-diagram') {
      const raw = await readBody(req);
      const payload = JSON.parse(raw || '{}');
      if (!payload.image) {
        send(res, 400, { error: 'Missing image data URL' });
        return;
      }
      const parsed = await parseDiagram(payload.image);
      send(res, 200, { ...parsed, model: MODEL });
      return;
    }

    let file = decodeURIComponent(url.pathname === '/' ? '/automata.html' : url.pathname);
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(ROOT, file);
    if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      send(res, 404, 'Not found');
      return;
    }
    res.writeHead(200, { 'content-type': mime(full) });
    fs.createReadStream(full).pipe(res);
  } catch (err) {
    send(res, err.status || 500, { error: err.message || String(err) });
  }
});

server.listen(PORT, () => {
  console.log(`Automata tool running at http://localhost:${PORT}/automata.html`);
  console.log(`OpenAI model: ${MODEL}`);
});
