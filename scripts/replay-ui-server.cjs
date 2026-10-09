/* Shows a saved scan result inside the real app, without a new scan.
 * The app's page blocks cross-origin fetches, so this tiny local server serves
 * automata.html, pda-core.js and the payload from ONE origin. Embedded image
 * data URLs are stripped (they make the payload huge and are not needed to draw).
 *
 *   node scripts/replay-ui-server.cjs <result.json|payload.json> [port=8799] [--keep-images]
 *
 * --keep-images keeps the embedded crop images (several MB), which the post-scan
 * review needs to show the row pictures, e.g. the repeated-input-glyph card.
 *
 * Then, in the browser pane at http://127.0.0.1:<port>/ (its storage is separate
 * from the user's), run in the page:
 *   const p=await fetch('/payload.json').then(r=>r.json());
 *   const a=newAutomaton('replay','pda'); DB.automata.push(a); openAutomaton(a.id);
 *   applyAiTransitionsToCanvas(p,{atomic:true,scanSessionId:p.scan_session_id}); renderAll(); fitView();
 * Free: no model calls. Stop it when done. */
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), keepImages = args.includes('--keep-images');
const [source, portArg] = args.filter(a => !a.startsWith('--')), port = Number(portArg || 8799);
if (!source) throw new Error('usage: node scripts/replay-ui-server.cjs <result.json|payload.json> [port]');
const raw = JSON.parse(fs.readFileSync(source, 'utf8'));
const payload = raw.payload || raw;   // result.json from scan-image-diagnostic wraps it
const body = JSON.stringify(payload, (k, v) => (!keepImages && typeof v === 'string' && v.startsWith('data:') ? '' : v));
const root = path.join(__dirname, '..');
http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/payload.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(body); }
  if (url === '/pda-core.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(fs.readFileSync(path.join(root, 'pda-core.js'))); }
  if (url === '/' || url === '/automata.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(path.join(root, 'automata.html'))); }
  res.writeHead(404); res.end();
}).listen(port, '127.0.0.1', () => console.log(`replay UI on http://127.0.0.1:${port}/  (payload ${body.length} bytes)`));
