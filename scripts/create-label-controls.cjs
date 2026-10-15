// Clean independent controls: generated text, not edits to a user's photo.
const fs=require('node:fs');
const path=require('node:path');
const {createRequire}=require('node:module');
const dep=process.env.SCAN_NODE_MODULES?createRequire(path.join(process.env.SCAN_NODE_MODULES,'__scan__.cjs')):require;
const sharp=dep('sharp');
const out='test-evidence/scan-controls';fs.mkdirSync(out,{recursive:true});
(async()=>{
  for(const [name,left,middle,right] of [['none','b','⊥','ללא שינוי'],['pop','c','A','שלוף A'],['push','b','S','דחוף A']]){
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="700" height="180"><rect width="700" height="180" fill="white"/><g font-family="Arial" font-size="46" fill="black"><text x="40" y="95">${left}</text><text x="100" y="95">,</text><text x="165" y="95">${middle}</text><text x="230" y="95">/</text><text x="610" y="95" direction="rtl" text-anchor="start">${right}</text></g></svg>`;
    await sharp(Buffer.from(svg)).png().toFile(path.join(out,name+'.png'));
  }
})();
