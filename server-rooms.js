const http=require("http"),fs=require("fs"),fsp=fs.promises,path=require("path"),{WebSocketServer,WebSocket}=require("ws");
const PORT=process.env.PORT||3100,PUBLIC_DIR=path.join(__dirname,"public"),ROOM_FILE=path.join(__dirname,"data","rooms.json"),MAX_MESSAGES=100,roomMessages=new Map();
let roomRegistry={version:1,rooms:[]},saveQueue=Promise.resolve();
try{roomRegistry=JSON.parse(fs.readFileSync(ROOM_FILE,"utf8"))}catch{}
const send=(ws,payload)=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(payload))};
const json=(res,status,payload)=>res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}).end(JSON.stringify(payload));
const slug=value=>String(value||"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,80);
const clean=value=>String(value||"").trim().replace(/[<>]/g,"").slice(0,120);
function saveRooms(){saveQueue=saveQueue.then(()=>fsp.writeFile(ROOM_FILE,JSON.stringify(roomRegistry,null,2),"utf8"));return saveQueue}
function registerHierarchy(input){
 const country=clean(input.country),countryCode=clean(input.countryCode).toUpperCase().slice(0,3),state=clean(input.state),district=clean(input.district),locality=clean(input.locality);
 if(!country||!countryCode)throw new Error("Country information is required");
 const definitions=[{level:"country",name:country,key:`country:${countryCode.toLowerCase()}`}];
 if(state)definitions.push({level:"state",name:state,key:`${definitions.at(-1).key}/state:${slug(state)}`});
 if(district&&district!==state)definitions.push({level:"district",name:district,key:`${definitions.at(-1).key}/district:${slug(district)}`});
 if(locality&&![state,district].includes(locality))definitions.push({level:"locality",name:locality,key:`${definitions.at(-1).key}/locality:${slug(locality)}`});
 let parentId=null;const pathNames=[],created=[];
 for(const definition of definitions){
  pathNames.push(definition.name);let room=roomRegistry.rooms.find(item=>item.id===definition.key);
  if(!room){room={id:definition.key,name:definition.name,level:definition.level,parentId,countryCode,pathNames:[...pathNames],createdAt:new Date().toISOString()};roomRegistry.rooms.push(room)}
  created.push(room);parentId=room.id;
 }
 return created;
}
function readBody(req){return new Promise((resolve,reject)=>{let body="";req.on("data",chunk=>{body+=chunk;if(body.length>32768){reject(new Error("Request too large"));req.destroy()}});req.on("end",()=>{try{resolve(JSON.parse(body||"{}"))}catch{reject(new Error("Invalid JSON"))}});req.on("error",reject)})}

const server=http.createServer(async(req,res)=>{
 const requestUrl=new URL(req.url||"/",`http://${req.headers.host||"localhost"}`),urlPath=decodeURIComponent(requestUrl.pathname);
 if(urlPath==="/api/rooms"&&req.method==="GET")return json(res,200,{rooms:roomRegistry.rooms});
 if(urlPath==="/api/rooms/discover"&&req.method==="POST"){
  try{const created=registerHierarchy(await readBody(req));await saveRooms();return json(res,200,{rooms:created,localRoomIds:created.map(room=>room.id)})}catch(error){return json(res,400,{error:error.message})}
 }
 if(urlPath==="/api/reverse-geocode"){
  const lat=Number(requestUrl.searchParams.get("lat")),lon=Number(requestUrl.searchParams.get("lon"));
  if(!Number.isFinite(lat)||!Number.isFinite(lon)||lat < -90||lat > 90||lon < -180||lon > 180)return json(res,400,{error:"Invalid coordinates"});
  try{const upstream=await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&localityLanguage=en`,{headers:{Accept:"application/json","User-Agent":"NearbyTownSquare/0.2"}});if(!upstream.ok)return json(res,502,{error:"The location provider did not return a place."});return json(res,200,await upstream.json())}catch{return json(res,502,{error:"The location provider could not be reached."})}
 }
 if(urlPath==="/"||urlPath==="/index.html")return fs.readFile(path.join(PUBLIC_DIR,"index.html"),"utf8",(error,html)=>{
  if(error)return res.writeHead(404).end("Not found");
  const output=html.replace('<link rel="stylesheet" href="/styles.css" />','<link rel="stylesheet" href="/styles.css" /><link rel="stylesheet" href="/theme-clean.css" /><link rel="stylesheet" href="/location.css" /><link rel="stylesheet" href="/room-levels.css" />').replace('<script src="/app.js"></script>','<script src="/app-clean.js"></script><script src="/location.js"></script><script src="/location-default.js"></script><script src="/room-levels.js"></script>');
  res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Permissions-Policy":"geolocation=(self)"}).end(output);
 });
 const relative=urlPath==="/room-levels.json"?"../room-levels.json":urlPath.replace(/^\/+/,""),file=path.resolve(PUBLIC_DIR,relative),allowed=file.startsWith(PUBLIC_DIR)||file===path.resolve(__dirname,"room-levels.json");
 if(!allowed)return res.writeHead(403).end("Forbidden");
 fs.readFile(file,(error,data)=>{if(error)return res.writeHead(404).end("Not found");const types={".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".json":"application/json; charset=utf-8"};res.writeHead(200,{"Content-Type":types[path.extname(file)]||"application/octet-stream","Cache-Control":"no-store"}).end(data)});
});

const wss=new WebSocketServer({server});
wss.on("connection",ws=>ws.on("message",raw=>{
 let event;try{event=JSON.parse(raw.toString())}catch{return send(ws,{type:"error",message:"That message could not be read."})}
 if(event.type==="join"){
  const roomId=String(event.roomId||"").slice(0,300),channel=event.channel==="local"?"local":"open";ws.roomKey=`${roomId}:${channel}`;ws.profile={name:String(event.profile?.name||"Neighbour").slice(0,30),homeRoom:String(event.profile?.homeRoom||""),localRoomIds:Array.isArray(event.profile?.localRoomIds)?event.profile.localRoomIds.map(String).slice(0,10):[]};return send(ws,{type:"history",messages:(roomMessages.get(ws.roomKey)||[]).slice(-MAX_MESSAGES)});
 }
 if(event.type==="message"&&ws.roomKey){
  const split=ws.roomKey.lastIndexOf(":"),roomId=ws.roomKey.slice(0,split),channel=ws.roomKey.slice(split+1),localAccess=ws.profile?.homeRoom===roomId||ws.profile?.localRoomIds.includes(roomId);
  if(channel==="local"&&!localAccess)return send(ws,{type:"error",message:"Only people within this geographic hierarchy can post locally."});
  const text=String(event.text||"").trim().slice(0,500);if(!text)return;const message={id:`${Date.now()}-${Math.random().toString(36).slice(2,7)}`,name:ws.profile.name,text,createdAt:Date.now()},items=roomMessages.get(ws.roomKey)||[];items.push(message);roomMessages.set(ws.roomKey,items.slice(-MAX_MESSAGES));for(const client of wss.clients)if(client.roomKey===ws.roomKey)send(client,{type:"message",message});
 }
}));
server.listen(PORT,()=>console.log(`Nearby persistent rooms build is running at http://localhost:${PORT}`));
