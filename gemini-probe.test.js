const test = require('node:test');
const assert = require('node:assert/strict');
const { prepare, prepareBlocks, validateRows, estimate, run, ENDPOINT } = require('./scripts/probe-gemini-ocr.cjs');
const row = { image: 1, input: '?', stack_top: 'A', action_text: 'שלוף', action_symbol: 'B', confidence: 0.3 };
const prepared = { images: [{ image: 1 }], request: { model: 'gemini-3.8-flash' } };
const reply = (rows = [row], status = 'completed') => ({ ok: true, json: async () => ({ status,
  steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify({ rows }) }] }],
  usage: { total_input_tokens: 100, total_output_tokens: 200, total_thought_tokens: 50 } }) });

test('Gemini probe dry run never contacts provider or requires a key', async () => {
  const result = await run(prepared, { fetchImpl: () => { throw new Error('must not fetch'); } });
  assert.equal(result.status, 'DRY_RUN'); assert.equal(result.network_calls, 0);
});
test('Gemini probe rejects missing credentials before network', async () => {
  await assert.rejects(run(prepared, { live: true, fetchImpl: () => assert.fail('fetch') }), /no request sent/);
});
test('Gemini request goes only to fixed Google endpoint and blocks redirects', async () => {
  let calls = 0;
  const result = await run(prepared, { live: true, key: 'test-only-secret', fetchImpl: async (url, options) => {
    calls++; assert.equal(url, ENDPOINT); assert.equal(options.redirect, 'error');
    assert.equal(options.headers['x-goog-api-key'], 'test-only-secret'); return reply();
  } });
  assert.equal(calls, 1); assert.equal(result.status, 'COMPLETED_REQUIRES_ACCURACY_REVIEW');
  assert.deepEqual(result.validation.rows, [row]); // Don't repair POP B to A, or '?' to epsilon.
  assert.equal(JSON.stringify(result).includes('test-only-secret'), false);
});
test('Gemini probe never retries provider failures or prints response body', async () => {
  let calls = 0;
  const result = await run(prepared, { live: true, key: 'test-secret', fetchImpl: async () => {
    calls++; return { ok: false, status: 429, json: () => assert.fail('must not read body') };
  } });
  assert.equal(calls, 1); assert.equal(result.status, 'HTTP_ERROR'); assert.equal(result.http_status, 429);
});
test('Gemini network exceptions cannot leak credentials and never trigger retry', async () => {
  const result = await run(prepared, { live: true, key: 'test-secret', fetchImpl: async () => { throw new Error('test-secret'); } });
  assert.equal(result.status, 'REQUEST_OR_RESPONSE_FAILED'); assert.equal(result.network_calls, 1);
  assert.equal(JSON.stringify(result).includes('test-secret'), false);
});
test('Gemini response echoing a key is redacted in private evidence too', async () => {
  const result = await run(prepared, { live: true, key: 'test-secret', fetchImpl: async () => reply([{ ...row, input: 'test-secret' }]) });
  assert.equal(JSON.stringify(result).includes('test-secret'), false);
});
test('Gemini partial completion stays invalid while retaining reported usage', async () => {
  const result = await run(prepared, { live: true, key: 'test-secret', fetchImpl: async () => reply([row], 'incomplete') });
  assert.equal(result.status, 'INVALID_OUTPUT'); assert.equal(result.validation.issue, 'INCOMPLETE_INTERACTION');
  assert.equal(result.usage.total_input_tokens, 100);
});
test('Gemini validates exact row identities, count, fields and confidence', () => {
  assert.equal(validateRows('not JSON', 1).valid, false);
  assert.equal(validateRows(JSON.stringify({ rows: [] }), 1).valid, false);
  for (const bad of [{ ...row, image: 2 }, { ...row, input: null }, { ...row, confidence: 2 }])
    assert.equal(validateRows(JSON.stringify({ rows: [bad] }), 1).valid, false);
  assert.equal(validateRows(JSON.stringify({ rows: [row, row] }), 2).valid, false);
  assert.equal(validateRows(JSON.stringify({ rows: [row] }), 1).valid, true);
});
test('Gemini paid estimate includes separately reported thought tokens and expires', () => {
  const usage = { total_input_tokens: 1000000, total_output_tokens: 1000000, total_thought_tokens: 1000000 };
  assert.equal(estimate(usage, new Date('2026-09-11')), 8.25);
  assert.equal(estimate(usage, new Date('2027-01-01')), null);
  assert.equal(estimate({}, new Date('2026-09-11')), null);
});
test('Gemini preparation refuses unbounded crop count before reading files', () => {
  assert.throws(() => prepare([]), /1–4/);
  assert.throws(() => prepare(Array(5).fill('missing')), /1–4/);
});
test('Gemini multiline response preserves separate rows and rejects missing, extra or duplicate identities', () => {
  const rows = [{ ...row, image: 1, row_index: 1 }, { ...row, image: 1, row_index: 2 }, { ...row, image: 2, row_index: 1 }];
  assert.equal(validateRows(JSON.stringify({ rows }), 2, [2, 1]).valid, true);
  assert.equal(validateRows(JSON.stringify({ rows: rows.slice(1) }), 2, [2, 1]).valid, false);
  assert.equal(validateRows(JSON.stringify({ rows: [rows[0], rows[0], rows[2]] }), 2, [2, 1]).valid, false);
  assert.equal(validateRows(JSON.stringify({ rows: [rows[0], rows[1], { ...rows[2], row_index: 2 }] }), 2, [2, 1]).valid, false);
});
test('Gemini block request rejects invalid geometry counts before reading images', () => {
  assert.throws(() => prepareBlocks(['missing'], [0]), /counts/);
  assert.throws(() => prepareBlocks(['missing'], [1, 2]), /counts/);
  assert.throws(() => prepareBlocks(['a', 'b', 'c'], [3, 3, 3]), /8 label/);
});
test('Gemini evaluation penalizes incomplete batches and includes their cost', () => {
  const { evaluate } = require('./scripts/evaluate-gemini-blocks.cjs');
  const truth = { transitions: [{ from: 'q0', to: 'q1', rules: [{ input: 'b', stack_top: 'A', action: 'POP', symbol: 'A' }] }] };
  const failed = { targets: [{ from: 's1', to: 's2' }], network_calls: 1, estimated_standard_paid_usd: 0.01, status: 'INVALID_OUTPUT', validation: { valid: false } };
  const result = evaluate([failed], truth, { s1: 'q0', s2: 'q1' });
  assert.equal(result.rulesExact, 0); assert.equal(result.fieldsCorrect, 0);
  assert.equal(result.unavailableRules, 1); assert.equal(result.estimated_paid_usd, 0.01);
  assert.equal(result.failedBatches, 1); assert.equal(result.exact, false);
});
test('Gemini evaluator preserves multiplicity and does not discard a spurious NONE operand', () => {
  const { pair } = require('./scripts/evaluate-gemini-blocks.cjs');
  const expected = { input: 'b', stack_top: 'A', action: 'NONE', symbol: '' };
  assert.equal(pair([expected], [{ ...expected, symbol: 'A' }]).errors, 1);
  assert.equal(pair([expected], [expected, expected]).errors, 4);
  assert.equal(pair([expected, { ...expected, input: 'c' }], [{ ...expected, input: 'c' }, expected]).errors, 0);
});
test('Gemini experiment reports actual output allowance and blocks larger budgets before network', async () => {
  const request = { ...prepared.request, generation_config: { max_output_tokens: 4096 } };
  assert.equal((await run({ ...prepared, request })).max_output_tokens, 4096);
  await assert.rejects(run({ ...prepared, request: { ...request, generation_config: { max_output_tokens: 4097 } } },
    { live: true, key: 'test-secret', fetchImpl: () => assert.fail('must not fetch') }), /budget/);
});
test('Gemini probe records the selected priced model and refuses unknown tariffs', async () => {
  const request = { ...prepared.request, model: 'gemini-3.6-flash', generation_config: { thinking_level: 'minimal', max_output_tokens: 2400 } };
  const result = await run({ ...prepared, request });
  assert.equal(result.model, 'gemini-3.6-flash'); assert.equal(result.thinking_level, 'minimal');
  await assert.rejects(run({ ...prepared, request: { model: 'unpriced-model' } }), /Unpriced/);
});
