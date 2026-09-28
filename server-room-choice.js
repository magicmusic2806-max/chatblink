const fs=require("fs");
const path=require("path");
const originalReadFile=fs.readFile;

fs.readFile=function(file,...args){
 const callback=args.at(-1);
 if(path.basename(String(file))==="index.html"&&args[0]==="utf8"&&typeof callback==="function"){
  args[args.length-1]=(error,html)=>{
   if(!error&&typeof html==="string")html=html.replace('</body>','<script src="/no-local-label.js"></script></body>');
   callback(error,html);
  };
 }
 return originalReadFile.call(fs,file,...args);
};

require("./server-open-access");
