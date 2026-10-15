// One bounded OCR experiment, not a full scan or a default npm test.
// Existing credentials are read by server.js and never written to evidence.
const fs=require('node:fs');
const path=require('node:path');
require('../server');
async function main(){
  const images=process.argv.slice(2);
  if(!images.length||images.length>4)throw new Error('Supply 1–4 crop image paths');
  const content=[{type:'input_text',text:
    'Read the handwritten Hebrew/Latin pushdown automaton label in EACH image. Return JSON {rows:[{image,input,stack_top,action_text,action_symbol,confidence}]}. '+
    'Read spatially: input is LEFT of the comma; stack_top is BETWEEN comma and slash; action_text is the Hebrew word(s) RIGHT of slash. The comma is a separator, not a digit 1. '+
    'Transcribe action_text in Hebrew exactly as seen (דחוף / שלוף / ללא שינוי / לל״ש). Some words or operands wrap underneath; inspect the whole crop. '+
    'action_symbol is only the letter next to the Hebrew action, never copy stack_top. Use empty string for no operand. Use ? for illegible ink; do not guess from semantics. '+
    'Notebook lines are background. Preserve letter case. ⊥ is a horizontal base with a stem pointing up; not 1. Input a, c and ε are different; inspect the actual ink. Do not infer symbols from other images.'}];
  if(process.env.SCAN_PROBE_HEBREW==='true') content[0].text=
    'קרא את כתב היד בתמונות. בכל תמונה יש תווית של חץ באוטומט מחסנית. '+
    'תעתק בנפרד את הסימן שמשמאל לפסיק, את הסימן שבין הפסיק ללוכסן, ואת המילים בעברית שמימין ללוכסן. '+
    'קרא את המילים עצמן; אל תנחש פעולה לפי האות הסמוכה. פסיק הוא מפריד ולא הספרה 1. '+
    'אם מילה או אות כתובה מתחת לשורה היא עדיין יכולה להשתייך לפעולה. קווי המחברת הכחולים אינם חלק מהכתב. '+
    'אל תפתור את האוטומט. החזר JSON במבנה {rows:[{image,input,stack_top,action_text,action_symbol,confidence}]}. '+
    'action_text הוא תעתיק המילים העבריות המדויק; action_symbol הוא רק האות הכתובה לצד הפעולה, או מחרוזת ריקה אם אין אות כזאת. '+
    'אם אינך מצליח לקרוא סימן כתוב ?. שמור על אותיות גדולות וקטנות.';
  images.forEach((file,index)=>content.push({type:'input_text',text:`IMAGE ${index+1}`},
    {type:'input_image',image_url:'data:image/png;base64,'+fs.readFileSync(file).toString('base64'),detail:'high'}));
  if(process.env.SCAN_PROBE_REFERENCES){
    const reference=JSON.parse(fs.readFileSync(process.env.SCAN_PROBE_REFERENCES,'utf8'));
    const examples=[{type:'input_text',text:'CALIBRATION: the following isolated handwritten Hebrew words were identified by the writer in earlier examples. Use them as handwriting vocabulary only. Do not emit output rows for these examples. Target images follow after the examples; transcribe target pixels independently.'}];
    reference.samples.forEach(s=>examples.push({type:'input_text',text:`HANDWRITING EXAMPLE: ${s.text}`},
      {type:'input_image',image_url:'data:image/png;base64,'+fs.readFileSync(s.path).toString('base64'),detail:'high'}));
    content.unshift(...examples);
  }
  const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',
    headers:{'content-type':'application/json',authorization:`Bearer ${process.env.OPENAI_API_KEY}`},
    signal:AbortSignal.timeout(120000),body:JSON.stringify({model:process.env.OPENAI_LABEL_MODEL||'gpt-5.6-luna',
      reasoning:{effort:'low',context:'current_turn'},
      input:[{role:'user',content}],max_output_tokens:2400,text:{format:{type:'json_object'}}})});
  if(!response.ok)throw new Error(`OCR probe HTTP ${response.status}`);
  const data=await response.json();
  const text=data.output_text||(data.output||[]).flatMap(x=>x.content||[]).map(x=>x.text||'').join('');
  const model=process.env.OPENAI_LABEL_MODEL||'gpt-5.6-luna';
  const evidence={model,images:images.map(f=>path.resolve(f)),text,status:data.status,incomplete_details:data.incomplete_details,usage:data.usage};
  fs.writeFileSync(path.join(path.dirname(images[0]),`probe-${model}${process.env.SCAN_PROBE_HEBREW==='true'?'-he':''}${process.env.SCAN_PROBE_REFERENCES?'-calibrated':''}.json`),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(evidence));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
