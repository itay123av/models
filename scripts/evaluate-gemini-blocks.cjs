// Evaluation ONLY: this module never sends API requests or changes scanner output.
const fs = require('node:fs');
const path = require('node:path');
const FIELDS = ['input', 'stack_top', 'action', 'symbol'];
const action = text => ({ 'דחוף': 'PUSH', 'שלוף': 'POP', 'ללא שינוי': 'NONE', 'לל״ש': 'NONE', 'לל"ש': 'NONE' })[text] || 'UNKNOWN';

function pair(expected, actual) {
  if (expected.length > 4 || actual.length > 4) throw new Error('Evaluation block limit exceeded');
  let best;
  function visit(i, used, rows, errors) {
    if (i === expected.length) {
      const total = errors + 4 * (actual.length - used.size);
      if (!best || total < best.errors) best = { errors: total, rows };
      return;
    }
    for (let j = 0; j < actual.length; j++) if (!used.has(j)) {
      const mismatches = FIELDS.filter(k => expected[i][k] !== actual[j][k]);
      visit(i + 1, new Set([...used, j]), [...rows, { expected: expected[i], actual: actual[j], mismatches }], errors + mismatches.length);
    }
    if (actual.length - used.size < expected.length - i)
      visit(i + 1, used, [...rows, { expected: expected[i], actual: null, mismatches: FIELDS }], errors + 4);
  }
  visit(0, new Set(), [], 0);
  return best;
}

function evaluate(batches, truth, stateMap) {
  const actual = new Map();
  let networkCalls = 0, cost = 0, unknownCosts = 0, failedBatches = 0;
  for (const batch of batches) {
    networkCalls += batch.network_calls || 0;
    if (Number.isFinite(batch.estimated_standard_paid_usd)) cost += batch.estimated_standard_paid_usd;
    else unknownCosts++;
    const valid = batch.status === 'COMPLETED_REQUIRES_ACCURACY_REVIEW' && batch.validation?.valid === true;
    if (!valid) failedBatches++;
    batch.targets.forEach((target, i) => {
      if (!stateMap[target.from] || !stateMap[target.to]) throw new Error('Missing reviewed evaluation-only state mapping');
      const key = `${stateMap[target.from]}->${stateMap[target.to]}`;
      if (actual.has(key)) throw new Error('Duplicate physical connector in trial');
      const rows = valid ? batch.validation.rows.filter(r => r.image === i + 1).map(r => ({
        input: r.input, stack_top: r.stack_top, action: action(r.action_text), symbol: r.action_symbol,
        raw_action_text: r.action_text, confidence: r.confidence, row_index: r.row_index
      })) : [];
      actual.set(key, rows);
    });
  }
  const expectedKeys = new Set(truth.transitions.map(t => `${t.from}->${t.to}`));
  const extraConnectors = [...actual.keys()].filter(k => !expectedKeys.has(k));
  const transitions = truth.transitions.map(t => {
    const rows = actual.get(`${t.from}->${t.to}`) || [];
    return { from: t.from, to: t.to, expected_rows: t.rules.length, returned_rows: rows.length, ...pair(t.rules, rows) };
  });
  const compared = transitions.flatMap(t => t.rows);
  return { scope: 'label recognition only; topology and markers NOT tested', networkCalls, failedBatches,
    estimated_paid_usd: cost, unknownCosts, extraConnectors,
    exact: !failedBatches && !extraConnectors.length && transitions.every(t => t.errors === 0),
    rulesExact: compared.filter(r => !r.mismatches.length).length, totalRules: compared.length,
    fieldsCorrect: compared.reduce((n, r) => n + 4 - r.mismatches.length, 0), totalFields: compared.length * 4,
    unavailableRules: compared.filter(r => r.actual === null).length, transitions };
}

if (require.main === module) {
  const directory = path.resolve(process.argv[2]);
  const truth = JSON.parse(fs.readFileSync(path.join(__dirname, '../test-fixtures/handwriting/pda-q0-q6-ground-truth.json'), 'utf8'));
  // Explicit reviewed mapping for this photograph, not inferred from numbering by the scanner.
  if (truth.fixture_id !== 'pda-q0-q6-handwritten-2026-08-24') throw new Error('Unsupported evaluation fixture');
  const stateMap = { state_1: 'q0', state_2: 'q1', state_3: 'q2', state_4: 'q3', state_5: 'q4', state_6: 'q5', state_7: 'q6' };
  const files = fs.readdirSync(directory).filter(f => /^batch-\d+\.json$/.test(f)).sort();
  const report = evaluate(files.map(f => JSON.parse(fs.readFileSync(path.join(directory, f), 'utf8'))), truth, stateMap);
  fs.writeFileSync(path.join(directory, 'accuracy.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.exact ? 0 : 1;
}
module.exports = { evaluate, pair };
