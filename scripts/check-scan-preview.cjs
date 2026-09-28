/* Local browser regression: real upload/preview/approval UI, no paid requests.
 * Usage: node scripts/check-scan-preview.cjs <shadowed notebook photo>
 * SCAN_NODE_MODULES and SCAN_CHROME match scan-image-diagnostic.cjs. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const dep = process.env.SCAN_NODE_MODULES
  ? createRequire(path.join(process.env.SCAN_NODE_MODULES, '__scan__.cjs')) : require;
const {chromium} = dep('playwright');
const source = process.argv[2];
if (!source || !fs.existsSync(source)) throw new Error('Supply a local notebook photo');

async function main() {
  const {server} = require('../server');
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser = await chromium.launch({headless:true,
      ...(process.env.SCAN_CHROME?{executablePath:process.env.SCAN_CHROME}:{})});
    const page=await browser.newPage();
    const origin=`http://127.0.0.1:${server.address().port}`;
    let interceptedScans=0;
    // Mock before page load. Never forward a scan to the actual local server
    // or a provider, even if this regression introduces a spurious request.
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin!==origin)return route.abort();
      if(url.pathname==='/api/health')return route.fulfill({json:{ok:true,hasKey:true,model:'offline-test'}});
      if(url.pathname.startsWith('/api/')){
        interceptedScans++;
        return route.fulfill({status:503,json:{error:'Offline preview test: scan intercepted'}});
      }
      return route.continue();
    });
    await page.goto(origin+'/automata.html');
    // An isolated test model/profile, never the user's persisted automaton.
    await page.evaluate(()=>{current=newAutomaton('Offline preview test','pda');openAiScan();});
    await page.locator('[data-state="source"]').waitFor({state:'visible'});
    await page.locator('#scanFile').setInputFiles(source);
    await page.locator('[data-state="preview"]').waitFor({state:'visible'});
    const preview=page.locator('[data-state="preview"] img');
    const full=await preview.evaluate(im=>({w:im.naturalWidth,h:im.naturalHeight}));
    assert.equal(await page.locator('#scanCropApproval').isHidden(),true,'approval stays hidden for a full frame');
    assert.equal(await page.locator('#scanFullFrame').isHidden(),true,'return-to-full button stays hidden for a full frame');
    assert.match(await page.locator('#scanFrameNote').innerText(),/התמונה המלאה/);
    await page.locator('[data-act="propose-crop"]').click();
    await page.locator('#scanCropApproval').waitFor({state:'visible'});
    assert.equal(await page.locator('#scanCropApproved').isChecked(),false);
    await page.locator('[data-act="go"]').click();
    assert.match(await page.locator('#scanFrameNote').innerText(),/לפני הסריקה יש לאשר/);
    assert.equal(interceptedScans,0,'unapproved crop cannot make even a mocked request');
    await page.locator('#scanFullFrame').click();
    await page.locator('#scanCropApproval').waitFor({state:'hidden'});
    assert.deepEqual(await preview.evaluate(im=>({w:im.naturalWidth,h:im.naturalHeight})),full);
    await page.locator('[data-act="propose-crop"]').click();
    await page.locator('#scanCropApproval').waitFor({state:'visible'});
    assert.equal(await page.locator('#scanCropApproved').isChecked(),false,'returning to a proposal resets approval');
    await page.locator('#scanCropApproved').check();
    await page.locator('[data-act="go"]').click();
    await page.locator('[data-state="error"]').waitFor({state:'visible'});
    assert.equal(interceptedScans,1,'approved scan reached only the local test interceptor');
    console.log(JSON.stringify({passed:true,fullPreview:full,interceptedScans,providerCalls:0}));
  } finally {
    if(browser)await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
