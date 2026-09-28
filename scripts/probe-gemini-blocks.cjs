// Offline by default; at most THREE provider calls with --live. No app import or mutation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { prepareBlocks, run, loadKey } = require('./probe-gemini-ocr.cjs');
const ROOT = path.resolve(__dirname, '..');
const DIRECTORY = path.join(ROOT, 'test-evidence/scan-guard-contract');
const BUDGET_USD = 0.10;
const RESERVE_USD = 0.03; // Conservative local reservation, NOT a provider-enforced billing cap.

function plan(directory = DIRECTORY) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'request-labels.json'), 'utf8'));
  const blocks = manifest.crops.map((crop, index) => ({ crop, index })).filter(({ crop }) => crop.kind === 'label_block').map(({ crop, index }) => {
    const transition = manifest.topology.transitions.find(t => t.transition_id === crop.transition_id);
    if (!transition || !Number.isInteger(transition.visible_line_count) || transition.visible_line_count < 1 || transition.visible_line_count > 4) throw new Error('Invalid saved geometry');
    return { file: path.join(directory, `crop-${index}-label_block.png`), transition_id: transition.transition_id,
      from: transition.source_observation_id, to: transition.target_observation_id, row_count: transition.visible_line_count };
  });
  if (!blocks.length || blocks.length > 12) throw new Error('Trial supports 1–12 existing label blocks');
  const batches = [];
  for (let i = 0; i < blocks.length; i += 4) {
    const targets = blocks.slice(i, i + 4);
    batches.push({ targets, prepared: prepareBlocks(targets.map(t => t.file), targets.map(t => t.row_count)) });
  }
  return batches;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && !['--live', '--dry-run'].includes(args[0]))) throw new Error('Use --live or --dry-run');
  const batches = plan();
  if (!args.includes('--live')) {
    console.log(JSON.stringify({ status: 'DRY_RUN', network_calls: 0, planned_calls: batches.length,
      blocks: batches.map(b => b.targets), total_rows: batches.flatMap(b => b.targets).reduce((n, t) => n + t.row_count, 0),
      estimated_budget_usd: BUDGET_USD, reserve_per_call_usd: RESERVE_USD }, null, 2));
    return;
  }
  const key = loadKey();
  if (!key) throw new Error('Missing local key');
  const outputDirectory = path.join(ROOT, 'test-evidence/scan-gemini', `blocks-${Date.now()}-${crypto.randomUUID()}`);
  fs.mkdirSync(outputDirectory, { recursive: true });
  let spent = 0;
  const ledger = [];
  for (const [i, batch] of batches.entries()) {
    if (spent + RESERVE_USD > BUDGET_USD) throw new Error('Local estimate budget exhausted');
    const result = await run(batch.prepared, { live: true, key });
    // Persist each response before proceeding. A failed request is never automatically repeated.
    fs.writeFileSync(path.join(outputDirectory, `batch-${i + 1}.json`), JSON.stringify({ targets: batch.targets, ...result }, null, 2), { flag: 'wx' });
    ledger.push({ batch: i + 1, status: result.status, usage: result.usage, estimated_usd: result.estimated_standard_paid_usd });
    fs.writeFileSync(path.join(outputDirectory, 'ledger.json'), JSON.stringify(ledger, null, 2));
    console.log(JSON.stringify({ batch: i + 1, status: result.status, estimated_usd: result.estimated_standard_paid_usd, evidence: outputDirectory }));
    if (result.status !== 'COMPLETED_REQUIRES_ACCURACY_REVIEW' || !Number.isFinite(result.estimated_standard_paid_usd)) throw new Error('Incomplete result or unknown cost; stopped');
    spent += result.estimated_standard_paid_usd;
  }
  console.log(JSON.stringify({ status: 'TRIAL_COMPLETE_REQUIRES_REVIEW', network_calls: ledger.length, estimated_total_usd: spent, evidence: outputDirectory }));
}
if (require.main === module) main().catch(() => { console.error('Bounded Gemini block trial stopped; inspect saved evidence. No automatic retry.'); process.exitCode = 1; });
module.exports = { plan };
