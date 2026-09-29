// One bounded experiment, not a full scan or a default npm test.
// Classifies the handwritten Hebrew stack-action word of every saved line crop
// of ONE sheet. Variant "sheet" sends all crops in one request so the model can
// compare repeated words by the same hand; "isolated" sends the same guide but
// forbids cross-image comparison. Credentials are read by server.js and never
// written to evidence. Reference answers are used only for scoring afterwards.
//
// node scripts/probe-action-words.cjs <evidence-dir> <reference.json> [sheet|isolated]
const fs = require('node:fs');
const path = require('node:path');
const { PDA_ACTION_WORD_GUIDE } = require('../server');

const GUIDE = [
  'Each image is ONE handwritten transition-rule line of a pushdown automaton, shaped like "input , stack_top / ACTION".',
  'Your ONLY task: identify the Hebrew ACTION word(s) written to the RIGHT of the slash, and any single stack symbol (operand) written next to that word, beside it or directly under it.',
  ...PDA_ACTION_WORD_GUIDE,
  'Blue notebook ruling and arrow strokes are background. An operand is a single Latin capital (A, S, B, ...) or ⊥ written next to or under the action word; the symbols LEFT of the slash are NOT the operand.',
  'Never decide the action from automaton semantics, from the operand, or from the stack_top. If the word cannot be seen, answer UNKNOWN with low confidence.',
];
const SHEET = [
  'All images come from ONE sheet written by ONE person, who writes the same word the same way every time.',
  'Step 1: group the images whose action words have the SAME visual shape (you may compare across images). Step 2: decide each group\'s word from its clearest member using the letter-shape cues. Step 3: report every image. A word that looks different from all others forms its own group — never force it into a group.',
  'Return JSON {"groups":[{"group":"g1","images":[1,2],"shape_left_to_right":"...","letters_right_to_left":"...","word":"...","action":"PUSH|POP|NONE|UNKNOWN"}],"rows":[{"image":1,"group":"g1","word":"...","action":"PUSH|POP|NONE|UNKNOWN","operand":"","confidence":0.0}]}.',
];
const ISOLATED = [
  'Treat every image independently; do NOT compare images or group them.',
  'Return JSON {"rows":[{"image":1,"shape_left_to_right":"...","letters_right_to_left":"...","word":"...","action":"PUSH|POP|NONE|UNKNOWN","operand":"","confidence":0.0}]}.',
];

async function main() {
  const [dir, referencePath, variant = 'sheet'] = process.argv.slice(2);
  if (!dir || !referencePath || !['sheet', 'isolated'].includes(variant)) throw new Error('usage: <evidence-dir> <reference.json> [sheet|isolated]');
  const request = JSON.parse(fs.readFileSync(path.join(dir, 'request-labels.json'), 'utf8'));
  const lines = request.crops.map((crop, index) => ({ crop, index, file: path.join(dir, `crop-${index}-line.png`) }))
    .filter(x => x.crop.kind === 'line' && fs.existsSync(x.file));
  if (!lines.length || lines.length > 24) throw new Error(`expected 1-24 line crops, found ${lines.length}`);
  const content = [{ type: 'input_text', text: [...GUIDE, ...(variant === 'sheet' ? SHEET : ISOLATED)].join('\n') }];
  lines.forEach((line, i) => content.push({ type: 'input_text', text: `IMAGE ${i + 1}` },
    { type: 'input_image', image_url: 'data:image/png;base64,' + fs.readFileSync(line.file).toString('base64'), detail: 'high' }));
  const model = process.env.OPENAI_LABEL_MODEL || 'gpt-5.6-luna';
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    signal: AbortSignal.timeout(240000),
    body: JSON.stringify({ model, reasoning: { effort: process.env.OPENAI_REASONING_EFFORT || 'medium' },
      input: [{ role: 'user', content }], max_output_tokens: 16000, text: { format: { type: 'json_object' } } }),
  });
  if (!response.ok) throw new Error(`probe HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const data = await response.json();
  const text = data.output_text || (data.output || []).flatMap(x => x.content || []).map(x => x.text || '').join('');
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* scored as all-missing below */ }

  const reference = JSON.parse(fs.readFileSync(referencePath, 'utf8'));
  const rows = (parsed && Array.isArray(parsed.rows)) ? parsed.rows : [];
  const score = { action: 0, operand: 0, total: 0, details: [] };
  lines.forEach((line, i) => {
    const expected = reference[String(line.index)];
    if (!expected) return;
    const got = rows.find(r => Number(r.image) === i + 1) || {};
    const action = String(got.action || '').toUpperCase(), operand = String(got.operand || '').trim();
    const actionOk = action === expected.action, operandOk = operand === (expected.operand || '');
    score.total++; score.action += actionOk; score.operand += operandOk;
    score.details.push({ crop: line.index, line_id: line.crop.line_id, expected, got: { action, operand, word: got.word, confidence: got.confidence }, actionOk, operandOk });
  });
  const evidence = { model, variant, lines: lines.length, status: data.status, usage: data.usage, parsed, raw_text: parsed ? undefined : text, score };
  const out = path.join(dir, `probe-action-words-${variant}-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ out, variant, usage: data.usage, action: `${score.action}/${score.total}`, operand: `${score.operand}/${score.total}` }));
  score.details.filter(d => !d.actionOk || !d.operandOk).forEach(d => console.log('  miss', d.crop, d.line_id, JSON.stringify(d.expected), '->', JSON.stringify(d.got)));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
