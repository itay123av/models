// Diagnostic handwriting exemplars from the user's earlier explained drawing.
// These are vocabulary crops, not target rules or a replacement output graph.
// This is calibration on the same writer/drawing, NOT an independent accuracy
// benchmark. Keep it out of the production scanner and default tests.
const fs=require('node:fs'),path=require('node:path');
const {createRequire}=require('node:module');
const dep=process.env.SCAN_NODE_MODULES?createRequire(path.join(process.env.SCAN_NODE_MODULES,'__scan__.cjs')):require;
const sharp=dep('sharp');
const source=process.argv[2],out='test-evidence/scan-handwriting-controls';
(async()=>{
  fs.mkdirSync(out,{recursive:true});
  const {width,height}=await sharp(source).metadata();
  const samples=[{text:'ללא שינוי',name:'none',box:[.170,.264,.060,.038]},
    {text:'דחוף',name:'push',box:[.696,.151,.040,.040]},
    {text:'שלוף',name:'pop',box:[.731,.587,.046,.035]}];
  for(const s of samples){const [x,y,w,h]=s.box;
    s.path=path.resolve(out,s.name+'.png');
    await sharp(source).extract({left:Math.floor(x*width),top:Math.floor(y*height),width:Math.ceil(w*width),height:Math.ceil(h*height)})
      .resize({height:180}).png().toFile(s.path);
  }
  fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify({source:path.resolve(source),samples},null,2));
})();
