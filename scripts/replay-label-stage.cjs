// Re-runs ONLY the production label stage (parseLabelsStage) on the crops and
// topology saved by an earlier scan (request-labels.json in an evidence dir).
// PAID: calling parseLabelsStage directly bypasses the HTTP handler's per-scan
// usage scope, so the app's scan budget guard does NOT apply. One run of a
// 7-state sheet cost about $0.03-0.04 (7-11 label calls). Nothing is sent
// without --live. Topology is not re-scanned. The reference file is read only
// after the model has answered, for scoring.
// Output: <dir>/replay-labels-<timestamp>.json
//
// node scripts/replay-label-stage.cjs <evidence-dir> <reference.json> --live
//   REPLAY_SCORE_ONLY=<response-labels.json>  score a saved answer, no model call (no --live needed)
//   REPLAY_SERVER=<path to another server.js>  A/B a different prompt version
//   REPLAY_TAG=<name>                          tag the output file (e.g. old/new)
const fs = require('node:fs');
const path = require('node:path');
const { parseLabelsStage } = require(process.env.REPLAY_SERVER ? require('node:path').resolve(process.env.REPLAY_SERVER) : '../server');

const val = f => (f && typeof f === 'object' ? (f.value ?? f.type ?? '') : (f ?? ''));

async function main() {
  const [dir, referencePath] = process.argv.slice(2);
  if (!dir || !referencePath) throw new Error('usage: <evidence-dir> <reference.json> --live');
  if (!process.env.REPLAY_SCORE_ONLY && !process.argv.includes('--live'))
    throw new Error('paid label-stage replay: pass --live to send requests (or REPLAY_SCORE_ONLY to score a saved answer)');
  const request = JSON.parse(fs.readFileSync(path.join(dir, 'request-labels.json'), 'utf8'));
  const startedAt = Date.now();
  // REPLAY_SCORE_ONLY=<response-labels.json> scores an earlier saved answer the same way, without a model call.
  const result = process.env.REPLAY_SCORE_ONLY
    ? JSON.parse(fs.readFileSync(process.env.REPLAY_SCORE_ONLY, 'utf8'))
    : await parseLabelsStage(request.topology, request.crops, request.model_type || 'pda', request.scan_session_id);
  const reads = new Map((result.label_reads || []).map(r => [r.crop_id, r]));
  const reference = JSON.parse(fs.readFileSync(referencePath, 'utf8'));
  const fields = ['action', 'operand', 'input', 'top'];
  const score = Object.fromEntries(fields.map(f => [f, { ok: 0, total: 0 }]));
  const details = [];
  request.crops.forEach((crop, index) => {
    const expected = reference[String(index)];
    if (!expected || crop.kind !== 'line') return;
    const r = reads.get(crop.crop_id) || {};
    const action = String(val(r.stack_action)).toUpperCase();
    const got = {
      action,
      operand: String(action === 'POP' ? val(r.pop_symbol) : action === 'PUSH' ? val(r.push_value) : '').replace('ε', ''),
      input: String(val(r.read_input)),
      top: String(val(r.pop_value)),
      raw: r.raw_label_text,
      confidence: r.confidence,
    };
    const row = { crop: index, line_id: crop.line_id, expected, got, miss: [] };
    fields.forEach(f => {
      if (expected[f] === undefined && f !== 'operand') return;   // unconfirmed field: not scored
      const want = f === 'operand' ? (expected.operand || '') : expected[f];
      score[f].total++;
      if (got[f] === want) score[f].ok++; else row.miss.push(f);
    });
    details.push(row);
  });
  const out = path.join(dir, `replay-labels-${process.env.REPLAY_SCORE_ONLY ? 'baseline-' : ''}${process.env.REPLAY_TAG ? process.env.REPLAY_TAG + '-' : ''}${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({ elapsed_ms: Date.now() - startedAt, scan_usage: result.scan_usage || null, score, details, result }, null, 2));
  console.log(JSON.stringify({ out, elapsed_ms: Date.now() - startedAt, score: Object.fromEntries(fields.map(f => [f, `${score[f].ok}/${score[f].total}`])) }));
  details.filter(d => d.miss.length).forEach(d => console.log('  miss', d.crop, d.line_id, d.miss.join('+'), JSON.stringify(d.expected), '->', JSON.stringify({ ...d.got, raw: undefined })));
}
main().catch(e => { console.error(e.stack || e.message); process.exitCode = 1; });
