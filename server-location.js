const http=require("http"),fs=require("fs"),path=require("path");
const{WebSocketServer,WebSocket}=require("ws");
const PORT=process.env.PORT||3100,PUBLIC_DIR=path.join(__dirname,"public"),MAX_MESSAGES=100,roomMessages=new Map();
function send(ws,payload){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(payload))}
const server=http.createServer((req,res)=>{
 const urlPath=decodeURIComponent((req.url||"/").split("?")[0]);
 if(urlPath==="/"||urlPath==="/index.html")return fs.readFile(path.join(PUBLIC_DIR,"index.html"),"utf8",(error,html)=>{
  if(error)return res.writeHead(404).end("Not found");
  const output=html
   .replace('<link rel="stylesheet" href="/styles.css" />','<link rel="stylesheet" href="/styles.css" /><link rel="stylesheet" href="/theme-clean.css" /><link rel="stylesheet" href="/location.css" />')
   .replace('<script src="/app.js"></script>','<script src="/app-clean.js"></script><script src="/location.js"></script>');
  res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Permissions-Policy":"geolocation=(self)"}).end(output);
 });
 const relative=urlPath==="/room-levels.json"?"../room-levels.json":urlPath.replace(/^\/+/,"");
 const file=path.resolve(PUBLIC_DIR,relative);
 const allowed=file.startsWith(PUBLIC_DIR)||file===path.resolve(__dirname,"room-levels.json");
 if(!allowed)return res.writeHead(403).end("Forbidden");
 fs.readFile(file,(error,data)=>{if(error)return res.writeHead(404).end("Not found");const types={".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".json":"application/json; charset=utf-8"};res.writeHead(200,{"Content-Type":types[path.extname(file)]||"application/octet-stream","Cache-Control":"no-store"}).end(data)});
});
const wss=new WebSocketServer({server});
wss.on("connection",ws=>ws.on("message",raw=>{
 let event;try{event=JSON.parse(raw.toString())}catch{return send(ws,{type:"error",message:"That message could not be read."})}
 if(event.type==="join"){
  const roomId=String(event.roomId||"").slice(0,100),channel=event.channel==="local"?"local":"open";ws.roomKey=`${roomId}:${channel}`;ws.profile={name:String(event.profile?.name||"Neighbour").slice(0,30),homeRoom:String(event.profile?.homeRoom||"")};return send(ws,{type:"history",messages:(roomMessages.get(ws.roomKey)||[]).slice(-MAX_MESSAGES)});
 }
 if(event.type==="message"&&ws.roomKey){
  const split=ws.roomKey.lastIndexOf(":"),roomId=ws.roomKey.slice(0,split),channel=ws.roomKey.slice(split+1);if(channel==="local"&&ws.profile?.homeRoom!==roomId)return send(ws,{type:"error",message:"Only locals can post in this channel."});const text=String(event.text||"").trim().slice(0,500);if(!text)return;const message={id:`${Date.now()}-${Math.random().toString(36).slice(2,7)}`,name:ws.profile.name,text,createdAt:Date.now()},items=roomMessages.get(ws.roomKey)||[];items.push(message);roomMessages.set(ws.roomKey,items.slice(-MAX_MESSAGES));for(const client of wss.clients)if(client.roomKey===ws.roomKey)send(client,{type:"message",message});
 }
}));
server.listen(PORT,()=>console.log(`Nearby location build is running at http://localhost:${PORT}`));
