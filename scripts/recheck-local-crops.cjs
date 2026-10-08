/* Rebuild local crop pixels from saved geometry, without rescanning topology.
 * Default OFFLINE. --live allows one guarded labels request for <=2 transitions.
 * Usage: node scripts/recheck-local-crops.cjs <evidence-dir> <id,id> [--live|--gemini]
 * --gemini is one isolated literal block comparison, not a production fallback.
 * No reference answers enter the request. A fresh evidence subfolder is used.
 */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createRequire}=require('node:module');
const dep=process.env.SCAN_NODE_MODULES?createRequire(path.join(process.env.SCAN_NODE_MODULES,'__scan__.cjs')):require;
const {chromium}=dep('playwright');
async function main(){
  const dir=path.resolve(process.argv[2]||''),ids=(process.argv[3]||'').split(',').filter(Boolean);
  assert.ok(ids.length>=1&&ids.length<=2&&new Set(ids).size===ids.length,'select one or two distinct transition IDs');
  assert.ok(!(process.argv.includes('--live')&&process.argv.includes('--gemini')),'select one provider per experiment');
  assert.ok(process.argv.slice(4).every(arg=>['--live','--gemini','--ruling-view'].includes(arg)),'unknown option');
  const request=JSON.parse(fs.readFileSync(path.join(dir,'request-labels.json'),'utf8'));
  const source=fs.readFileSync(path.join(dir,'label.png')).toString('base64');
  const transitions=request.topology.transitions||request.topology.connectors||[];
  assert.ok(ids.every(id=>transitions.some(t=>t.transition_id===id)),'unknown transition ID');
  // Local process only: neither production config nor the running app changes.
  process.env.OPENAI_SCAN_MAX_ESTIMATED_USD='0.04';
  process.env.OPENAI_SCAN_MAX_API_CALLS='2';
  process.env.OPENAI_LABEL_ESCALATION_ENABLED='false';
  process.env.OPENAI_LABEL_TARGETED_RETRY_ENABLED='false';
  const {server}=require('../server');
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  const output=path.join(dir,`local-recheck-${Date.now()}`);
  fs.mkdirSync(output,{recursive:true});
  const save=(name,value)=>fs.writeFileSync(path.join(output,name),JSON.stringify(value,null,2));
  try{
    browser=await chromium.launch({headless:true,...(process.env.SCAN_CHROME?{executablePath:process.env.SCAN_CHROME}:{})});
    const page=await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/automata.html`);
    const session=`local-recheck-${Date.now()}`;
    const crops=await page.evaluate(async({topology,source,ids,session})=>{
      const plan=buildTwoStageCropSpecs({topology},session);
      plan.specs=plan.specs.filter(s=>s.kind!=='state_label'&&ids.includes(s.transition_id));
      return materializeTwoStageCrops('data:image/png;base64,'+source,plan);
    },{topology:request.topology,source,ids,session});
    assert.ok(crops.length<=8&&crops.every(c=>c.image_url),'invalid or unbounded crop request');
    crops.forEach((c,i)=>fs.writeFileSync(path.join(output,`${i}-${c.kind}.png`),Buffer.from(c.image_url.split(',')[1],'base64')));
    const auxiliary=[];
    if(process.argv.includes('--ruling-view')){
      const {rulingContrastView}=require('./ruling-view.cjs');
      for(const [i,c] of crops.entries()){
        if(c.kind!=='label_block')continue;
        const pixels=await page.evaluate(async url=>{
          const im=new Image();im.src=url;await im.decode();
          const canvas=document.createElement('canvas');canvas.width=im.width;canvas.height=im.height;
          const context=canvas.getContext('2d');context.drawImage(im,0,0);
          return {width:im.width,height:im.height,rgba:Array.from(context.getImageData(0,0,im.width,im.height).data)};
        },c.image_url);
        const changed=rulingContrastView(pixels.rgba);
        const url=await page.evaluate(({width,height,rgba})=>{
          const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
          canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba),width,height),0,0);
          return canvas.toDataURL('image/png');
        },{...pixels,rgba:Array.from(changed)});
        fs.writeFileSync(path.join(output,`${i}-auxiliary.png`),Buffer.from(url.split(',')[1],'base64'));
        auxiliary.push({transition_id:c.transition_id,url,file:`${i}-auxiliary.png`});
      }
    }
    const topology=structuredClone(request.topology);
    for(const key of ['transitions','connectors'])if(Array.isArray(topology[key]))topology[key]=topology[key].filter(t=>ids.includes(t.transition_id));
    const body={stage:'labels',scan_session_id:session,model_type:'pda',topology,crops};
    save('request.json',body);
    save('view-manifest.json',{algorithm:'brightest-channel-grayscale-v1',original_required:true,
      auxiliaries:auxiliary.map(a=>({transition_id:a.transition_id,file:a.file,
        sha256:require('node:crypto').createHash('sha256').update(Buffer.from(a.url.split(',')[1],'base64')).digest('hex')}))});
    console.log(JSON.stringify({output,crops:crops.length,live:process.argv.includes('--live')||process.argv.includes('--gemini')}));
    if(process.argv.includes('--gemini')){
      const {prepareBlocks,run,loadKey}=require('./probe-gemini-ocr.cjs');
      const blocks=crops.map((c,i)=>({c,i})).filter(({c})=>c.kind==='label_block');
      const counts=blocks.map(({c})=>crops.filter(line=>line.kind==='line'&&line.transition_id===c.transition_id).length);
      const prepared=prepareBlocks(blocks.map(({i,c})=>path.join(output,`${i}-${c.kind}.png`)),counts);
      for(const aux of auxiliary){
        const imageIndex=blocks.findIndex(({c})=>c.transition_id===aux.transition_id)+1;
        prepared.request.input.push({type:'text',text:`AUXILIARY ALIGNED VIEW FOR IMAGE ${imageIndex}. Same pixels and coordinates, brightest-channel grayscale to weaken coloured notebook ruling. Not a new image identity or rule. Original colour image remains authoritative; genuine coloured ink may be weakened here. Compare both; a long background line crossing a symbol is not automatically a glyph stroke. Preserve genuine punctuation/symbols; if ambiguous return ?. No automatic substitutions.`},
          {type:'image',mime_type:'image/png',data:aux.url.split(',')[1]});
      }
      assert.ok(prepared.request.input.filter(x=>x.type==='image').reduce((n,x)=>n+Buffer.from(x.data,'base64').length,0)<=4*1024*1024,'paired views exceed image budget');
      prepared.request.model='gemini-3.6-flash';
      prepared.request.generation_config={max_output_tokens:1600,thinking_level:'minimal',thinking_summaries:'none'};
      const result=await run(prepared,{live:true,key:loadKey()});
      result.auxiliary_profile=auxiliary.length?'original-plus-brightest-channel-v1':'original-only';
      result.auxiliary_files=auxiliary.map(a=>({transition_id:a.transition_id,file:a.file}));
      save('gemini-response.json',result);
      console.log(JSON.stringify({status:result.status,usage:result.usage,estimated_usd:result.estimated_standard_paid_usd,rows:result.validation?.rows}));
      if(!result.validation?.valid)process.exitCode=1;
      return;
    }
    if(!process.argv.includes('--live'))return;
    // Use the HTTP entry point: it creates the usage scope/budget ledger which
    // direct calls to parseLabelsStage from a probe would otherwise bypass.
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/parse-diagram`,{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const result=await response.json();save('response.json',result);
    if(!response.ok)throw new Error(`Local labels request failed (HTTP ${response.status}); evidence saved`);
    console.log(JSON.stringify({usage:result.scan_usage,rows:result.label_reads.map(r=>({transition:r.transition_id,line:r.line_id,
      input:r.read_input?.value,top:r.pop_value?.value,action:r.stack_action?.type,push:r.push_value?.value,pop:r.pop_symbol?.value,issues:r.issues}))}));
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
