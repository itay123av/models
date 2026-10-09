/* Evaluation only. Never imported by the scanner and never used to repair OCR.
 * Compare explicit output to a separately reviewed reference, ignoring display
 * order but preserving rule multiplicity. */
const fields=['input','stack_top','action','symbol'];
function observedRule(row){
  const action=row.stack_action?.type||'UNKNOWN';
  return {input:row.read_input?.value??'?',stack_top:row.pop_value?.value??'?',action,
    symbol:action==='NONE'?'':action==='PUSH'?(row.push_value?.value??'?'):(row.pop_symbol?.value??'?')};
}
function pairRules(expected,actual){
  // Exhaustive matching for the small multi-line labels in a diagram. It
  // chooses an evaluation pairing only, never modifies either observation.
  if(actual.length>10||expected.length>10)throw new Error('Benchmark label exceeds ten rules');
  let best=null;
  const visit=(i,used,pairs,cost)=>{
    if(best&&cost>=best.cost)return;
    if(i===expected.length){best={cost:cost+4*(actual.length-used.size),pairs};return;}
    for(let j=0;j<actual.length;j++)if(!used.has(j)){
      const mismatches=fields.filter(f=>expected[i][f]!==actual[j][f]);
      visit(i+1,new Set([...used,j]),[...pairs,{expected:expected[i],actual:actual[j],mismatches}],cost+mismatches.length);
    }
    if(actual.length-used.size<expected.length-i)visit(i+1,used,
      [...pairs,{expected:expected[i],actual:null,mismatches:[...fields]}],cost+4);
  };
  visit(0,new Set(),[],0);return best||{cost:0,pairs:[]};
}
function evaluateScan(payload,truth){
  const states=payload.states||[],transitions=payload.transitions||[];
  const key=(a,b)=>JSON.stringify([a,b]);
  const endpoint=x=>x?.visible_label||x?.id||'?';
  const actual=new Map();
  transitions.forEach(t=>{
    const k=key(endpoint(t.source_state),endpoint(t.target_state));
    const rows=actual.get(k)||[];rows.push(t);actual.set(k,rows);
  });
  const expectedKeys=new Set(truth.transitions.map(t=>key(t.from,t.to)));
  const rows=truth.transitions.map(t=>{
    const matches=actual.get(key(t.from,t.to))||[];
    const rules=matches.flatMap(x=>(x.rules||[]).map(observedRule));
    const paired=pairRules(t.rules,rules);
    return {from:t.from,to:t.to,connectorCount:matches.length,expectedRuleCount:t.rules.length,
      actualRuleCount:rules.length,fieldErrors:paired.cost,rules:paired.pairs};
  });
  const stateNames=states.map(s=>s.visible_label||'?').sort();
  const accepting=states.filter(s=>s.is_accepting===true).map(s=>s.visible_label).sort();
  const start=states.filter(s=>s.is_start===true).map(s=>s.visible_label).sort();
  const expectedStart=truth.photograph?.start_marker_visible===false?[]:[truth.expected.start_state].filter(Boolean);
  const stateNamesCorrect=JSON.stringify(stateNames)===JSON.stringify([...truth.states].sort());
  const acceptingCorrect=JSON.stringify(accepting)===JSON.stringify([...truth.expected.accepting_states].sort());
  const startCorrect=JSON.stringify(start)===JSON.stringify(expectedStart.sort());
  const extraConnectors=[...actual].filter(([k])=>!expectedKeys.has(k)).flatMap(([,v])=>v).length;
  const topologyCorrect=extraConnectors===0&&rows.every(r=>r.connectorCount===1);
  const rulesExact=rows.reduce((n,r)=>n+r.rules.filter(x=>x.mismatches.length===0).length,0);
  const totalRules=truth.transitions.reduce((n,t)=>n+t.rules.length,0);
  const fieldsCorrect=rows.reduce((n,r)=>n+r.rules.reduce((s,x)=>s+4-x.mismatches.length,0),0);
  return {exact:stateNamesCorrect&&acceptingCorrect&&startCorrect&&topologyCorrect&&
    rows.every(r=>r.fieldErrors===0),stateNamesCorrect,acceptingCorrect,startCorrect,topologyCorrect,
    actualStates:stateNames,actualAccepting:accepting,actualStart:start,expectedVisibleStart:expectedStart,
    rulesExact,totalRules,fieldsCorrect,totalFields:4*totalRules,extraConnectors,transitions:rows};
}
module.exports={evaluateScan};
if(require.main===module){
  const fs=require('node:fs');
  const result=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  const truth=JSON.parse(fs.readFileSync(process.argv[3]||'test-fixtures/handwriting/pda-q0-q6-ground-truth.json','utf8'));
  const report=evaluateScan(result.payload||result,truth);
  if(process.argv[4])fs.writeFileSync(process.argv[4],JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));process.exitCode=report.exact?0:1;
}
