const fs=require('node:fs'),crypto=require('node:crypto');
const {rulingContrastView}=require('./ruling-view.cjs');
const {prepareBlocks}=require('./probe-gemini-ocr.cjs');
function preparePairedBlocks(files,counts,PNG){
  const prepared=prepareBlocks(files,counts);
  prepared.request.model='gemini-3.6-flash';
  prepared.request.generation_config={max_output_tokens:1600,thinking_level:'minimal',thinking_summaries:'none'};
  prepared.profile='original-plus-brightest-channel-literal-operands-v1';
  prepared.auxiliary_views=[];
  files.forEach((file,index)=>{
    const source=PNG.sync.read(fs.readFileSync(file));
    const view=rulingContrastView(source.data);
    const bytes=PNG.sync.write({width:source.width,height:source.height,data:Buffer.from(view)});
    prepared.auxiliary_views.push({image:index+1,width:source.width,height:source.height,
      sha256:crypto.createHash('sha256').update(bytes).digest('hex'),algorithm:'brightest-channel-grayscale-v1'});
    prepared.request.input.push({type:'text',text:`AUXILIARY ALIGNED VIEW FOR IMAGE ${index+1}. Same pixels and coordinates, brightest-channel grayscale to weaken coloured notebook ruling. Not a new image identity or rule. Original colour image remains authoritative; genuine coloured ink may be weakened here. Compare both; a long background line crossing a symbol is not automatically a glyph stroke. Preserve genuine punctuation/symbols; if ambiguous return ?. No automatic substitutions.`},
      {type:'image',mime_type:'image/png',data:bytes.toString('base64')});
  });
  if(prepared.request.input.filter(x=>x.type==='image').reduce((n,x)=>n+Buffer.from(x.data,'base64').length,0)>4*1024*1024)
    throw new Error('Paired image budget exceeded');
  return prepared;
}
module.exports={preparePairedBlocks};
