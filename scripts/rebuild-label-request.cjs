/* Rebuilds the label-stage request of a saved scan with the CURRENT client crop
 * code, so replay-label-stage measures today's crops instead of the saved ones.
 * Free: no model calls. Uses an isolated headless browser, not the user's storage.
 *
 *   node scripts/rebuild-label-request.cjs <saved-scan-dir> <out-dir>
 *     <saved-scan-dir> must hold request-labels.json (topology + session) and label.png
 *     (the label frame that the original scan cropped from).
 *   env SCAN_NODE_MODULES=<dir with playwright>, SCAN_CHROME=<chrome.exe>  (as in scan-image-diagnostic)
 *
 * Writes <out-dir>/request-labels.json (same shape the client posts) and one PNG per crop.
 * Then: node scripts/replay-label-stage.cjs <out-dir> <reference.json> --live */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const bundled = process.env.SCAN_NODE_MODULES;
const dep = bundled ? createRequire(path.join(bundled, '__scan__.cjs')) : require;
const { chromium } = dep('playwright');

async function main() {
  const [sourceDir, outDir] = process.argv.slice(2);
  if (!sourceDir || !outDir) throw new Error('usage: <saved-scan-dir> <out-dir>');
  const saved = JSON.parse(fs.readFileSync(path.join(sourceDir, 'request-labels.json'), 'utf8'));
  const label = 'data:image/png;base64,' + fs.readFileSync(path.join(sourceDir, 'label.png')).toString('base64');
  fs.mkdirSync(outDir, { recursive: true });
  const { server } = require('../server');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.SCAN_CHROME ? { executablePath: process.env.SCAN_CHROME } : {}) });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/automata.html`);
    const crops = await page.evaluate(async ({ topology, session, url }) => {
      const built = await materializeTwoStageCrops(url, buildTwoStageCropSpecs({ topology }, session));
      // The same field list runTwoStageDiagramScan posts to the labels stage.
      return built.map(c => ({ crop_id: c.crop_id, observation_id: c.observation_id || '', transition_id: c.transition_id, line_id: c.line_id, kind: c.kind,
        image_url: c.image_url, image_role: c.image_role, source_bbox: c.source_bbox, state_bbox: c.state_bbox, label_bbox: c.label_bbox,
        inner_label_bbox: c.inner_label_bbox, derived_from_state_bbox: Boolean(c.derived_from_state_bbox), label_block_bbox: c.label_block_bbox,
        line_bbox: c.line_bbox, target_line_bbox_in_crop: c.target_line_bbox_in_crop, target_line_bboxes_in_context: c.target_line_bboxes_in_context,
        expanded_horizontally_from_line_bbox: Boolean(c.expanded_horizontally_from_line_bbox), crop_bbox: c.crop_bbox, padding: c.padding,
        original_size: c.original_size, issues: c.issues || [], crop_notes: c.crop_notes || [] }));
    }, { topology: saved.topology, session: saved.scan_session_id, url: label });
    if (errors.length) throw new Error('page errors: ' + errors.join(' | '));
    const request = { stage: 'labels', scan_session_id: saved.scan_session_id, model_type: saved.model_type || 'pda', topology: saved.topology, crops };
    fs.writeFileSync(path.join(outDir, 'request-labels.json'), JSON.stringify(request));
    crops.forEach((c, i) => { if (c.image_url) fs.writeFileSync(path.join(outDir, `crop-${i}-${c.kind}.png`), Buffer.from(c.image_url.split(',')[1], 'base64')); });
    const before = saved.crops.map(c => c.crop_id), after = crops.map(c => c.crop_id);
    console.log(JSON.stringify({ out: outDir, crops: crops.length, same_crop_order: JSON.stringify(before) === JSON.stringify(after),
      moved: crops.filter((c, i) => JSON.stringify(c.crop_bbox) !== JSON.stringify((saved.crops[i] || {}).crop_bbox)).map(c => `${c.transition_id || c.observation_id}:${c.line_id || c.kind}`) }));
  } finally {
    await browser.close();
    server.close();
  }
}
main().catch(e => { console.error(e.stack || e.message); process.exitCode = 1; });
