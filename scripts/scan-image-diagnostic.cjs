/* Reproducible diagnostic of the real client image pipeline. No API calls
 * unless --live is explicitly supplied. Uses an isolated browser profile. */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const bundled = process.env.SCAN_NODE_MODULES;
const dep = bundled ? createRequire(path.join(bundled, '__scan__.cjs')) : require;
const { chromium } = dep('playwright');
const source = process.argv.find(a => /\.(jpe?g|png)$/i.test(a));
if (!source) throw new Error('Pass an input image path. Optional: --live');
const out = path.resolve(process.env.SCAN_EVIDENCE_DIR || 'test-evidence/scan-diagnostic');
fs.mkdirSync(out, { recursive: true });
function writeJSON(name, value) { fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2)); }
function writeImage(name, data) {
  if (!data || !data.startsWith('data:image/')) return;
  fs.writeFileSync(path.join(out, name), Buffer.from(data.split(',')[1], 'base64'));
}
async function main() {
  const { server } = require('../server');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true,
    ...(process.env.SCAN_CHROME ? {executablePath: process.env.SCAN_CHROME} : {}) });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/automata.html`);
    const data = fs.readFileSync(source).toString('base64');
    const proposeCrop = process.argv.includes('--propose-crop');
    const frames = await page.evaluate(async ({data,proposeCrop}) => {
      const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
      return window.__diagnosticFrames = await downscaleImage(new File([bytes], 'input.jpeg', {type:'image/jpeg'}), 2400, .92,
        {enableDocumentCrop:proposeCrop});
    }, {data,proposeCrop});
    if (!proposeCrop && (frames.normalization.applied ||
        JSON.stringify(frames.normalization.bbox)!==JSON.stringify({x:0,y:0,w:1,h:1}))) {
      throw new Error('Default preprocessing discarded source margins');
    }
    writeJSON('normalization.json', frames.normalization);
    writeImage('original.jpg', frames.images[2]);
    writeImage('enhanced.jpg', frames.images[0]);
    writeImage('ink.jpg', frames.images[1]);
    writeImage('label.png', frames.label);
    const preservation = await page.evaluate(async () => {
      const im=new Image(); im.src=window.__diagnosticFrames.label; await im.decode();
      const original=new Image(); original.src=window.__diagnosticFrames.images[2]; await original.decode();
      const read=image=>{const c=document.createElement('canvas');c.width=image.width;c.height=image.height;
        const ctx=c.getContext('2d');ctx.drawImage(image,0,0);return ctx.getImageData(0,0,c.width,c.height).data;};
      const a=read(original),b=read(im);let dark=0,erased=0;
      for(let i=0;i<a.length;i+=4) if(.299*a[i]+.587*a[i+1]+.114*a[i+2]<170){
        dark++;if(b[i]>240&&b[i+1]>240&&b[i+2]>240)erased++;
      }
      return {darkOriginalPixels:dark,erasedPixels:erased,erasedFraction:erased/Math.max(1,dark)};
    });
    writeJSON('pixel-preservation.json', preservation);
    if(preservation.erasedFraction>.005) throw new Error('OCR preprocessing erased source ink: '+JSON.stringify(preservation));
    console.log(JSON.stringify({phase:'prepared', normalization:frames.normalization}));
    if (!process.argv.includes('--live')) return;
    const replay=process.env.SCAN_REPLAY_DIR;
    if(replay) {
      const prior=JSON.parse(fs.readFileSync(path.join(replay,'normalization.json'),'utf8'));
      if(JSON.stringify(prior)!==JSON.stringify(frames.normalization)) throw new Error('Replay frame differs from saved topology frame');
    }
    // Forward through Node: the isolated ephemeral test origin isn't a public
    // browser origin; use the real endpoint without relaxing its CORS policy.
    await page.exposeFunction('diagnosticFetch', async (url, options) => {
      const body = JSON.parse(options.body);
      writeJSON(`request-${body.stage}.json`, body);
      if (body.crops) body.crops.forEach((c, i) => writeImage(`crop-${i}-${c.kind}.png`, c.image_url));
      console.log(JSON.stringify({phase:body.stage, crops:body.crops?.length}));
      if(replay && body.stage!=='labels') {
        const prior=JSON.parse(fs.readFileSync(path.join(replay,`response-${body.stage}.json`),'utf8'));
        const oldSession=prior.scan_session_id;
        const cached=JSON.parse(JSON.stringify(prior).split(oldSession).join(body.scan_session_id));
        delete cached.scan_usage;
        writeJSON(`response-${body.stage}.json`,cached);
        console.log(JSON.stringify({phase:body.stage,replayed:true}));
        return {ok:true,status:200,body:JSON.stringify(cached)};
      }
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/parse-diagram`, {
        method:'POST', headers:{'content-type':'application/json'}, body:options.body });
      const text = await response.text();
      try { writeJSON(`response-${body.stage}.json`, JSON.parse(text)); } catch {}
      return {ok:response.ok, status:response.status, body:text};
    });
    const result = await page.evaluate(async () => runTwoStageDiagramScan(window.__diagnosticFrames, 'pda',
      async (url, options) => { const r=await window.diagnosticFetch(url, options); return {...r, text:async()=>r.body}; }));
    writeJSON('result.json', result);
    console.log(JSON.stringify({phase:'complete', usage:result.scanUsage, states:result.payload.states.length,
      transitions:result.payload.transitions.length, labelError:result.passB.stage_error}));
  } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
}
main().catch(error => { console.error(error.message); process.exitCode=1; });
