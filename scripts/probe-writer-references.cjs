// One diagnostic call, never imported by the app. Offline unless --live.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {prepareWriterReferences}=require('./writer-reference-profile.cjs');
const {run,loadKey,prepareGuidedBlocks}=require('./probe-gemini-ocr.cjs');
const ROOT=path.resolve(__dirname,'..');
async function main(){
  const args=process.argv.slice(2);
  const guided=args.length===3&&['--guide-only','--guided-reasoning','--guided-high-resolution'].includes(args[2]);
  if((args.length!==2&&!guided) || !['--live','--dry-run'].includes(args[0]))
    throw new Error('Use --dry-run or --live followed by a reviewed experiment manifest and optional guided profile');
  const manifestPath=path.resolve(args[1]),base=path.dirname(manifestPath);
  const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  const targets=manifest.targets.map(target=>({...target,file:path.resolve(base,target.file)}));
  const references=manifest.references.map(reference=>({...reference,file:path.resolve(base,reference.file)}));
  if(!manifest.target_source_id || references.some(reference=>reference.source_id===manifest.target_source_id))
    throw new Error('Targets and references must have different reviewed photograph sources');
  const prepared=guided?prepareGuidedBlocks(targets.map(t=>t.file),targets.map(t=>t.row_count),{
    reasoning:args[2]==='--guided-reasoning',highResolution:args[2]==='--guided-high-resolution'}):
    prepareWriterReferences(targets.map(t=>t.file),targets.map(t=>t.row_count),references);
  const live=args[0]==='--live';
  const result=await run(prepared,{live,key:live?loadKey():''});
  if(!live){console.log(JSON.stringify({status:result.status,network_calls:0,profile:result.profile,
    targets:targets.length,rows:prepared.row_counts,reference_images:guided?0:references.length}));return;}
  const directory=path.join(ROOT,'test-evidence/scan-gemini',`writer-${Date.now()}-${crypto.randomUUID()}`);
  fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'batch-1.json'),JSON.stringify({target_source_id:manifest.target_source_id,targets,...result},null,2),{flag:'wx'});
  console.log(JSON.stringify({status:result.status,network_calls:result.network_calls,estimated_usd:result.estimated_standard_paid_usd,evidence:directory}));
  if(result.status!=='COMPLETED_REQUIRES_ACCURACY_REVIEW')process.exitCode=1;
}
if(require.main===module)main().catch(()=>{console.error('Writer-reference trial stopped; no automatic retry.');process.exitCode=1;});
