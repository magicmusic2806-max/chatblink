const fs=require("fs");
const path=require("path");
const originalReadFile=fs.readFile;
const originalFetch=global.fetch;

fs.readFile=function(file,...args){
 const callback=args.at(-1);
 if(path.basename(String(file))==="index.html"&&args[0]==="utf8"&&typeof callback==="function"){
  args[args.length-1]=(error,html)=>{
   if(!error&&typeof html==="string")html=html.replace('</body>','<script src="/town-accuracy.js"></script></body>');
   callback(error,html);
  };
 }
 return originalReadFile.call(fs,file,...args);
};

global.fetch=async function(resource,options){
 const url=String(resource);
 if(!url.startsWith("https://api.bigdatacloud.net/data/reverse-geocode-client"))return originalFetch(resource,options);
 const primaryResponse=await originalFetch(resource,options);
 if(!primaryResponse.ok)return primaryResponse;
 const primaryData=await primaryResponse.json();
 try{
  const sourceUrl=new URL(url),lat=sourceUrl.searchParams.get("latitude"),lon=sourceUrl.searchParams.get("longitude");
  const placeResponse=await originalFetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&zoom=14&addressdetails=1`,{headers:{Accept:"application/json","User-Agent":"NearbyTownSquarePrototype/0.3"}});
  if(placeResponse.ok){
   const placeData=await placeResponse.json(),address=placeData.address||{};
   const candidates=[["city",address.city],["town",address.town],["village",address.village],["municipality",address.municipality],["hamlet",address.hamlet]];
   const selected=candidates.find(([,name])=>name);
   if(selected)primaryData.nearbyPopulatedPlace={type:selected[0],name:selected[1]};
  }
 }catch{}
 return new Response(JSON.stringify(primaryData),{status:200,headers:{"Content-Type":"application/json"}});
};

require("./server-rooms");
