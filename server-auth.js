const http=require("http"),fs=require("fs"),fsp=fs.promises,path=require("path"),crypto=require("crypto"),{WebSocketServer,WebSocket}=require("ws");
const PORT=process.env.PORT||3100,PUBLIC_DIR=path.join(__dirname,"public"),USER_FILE=path.join(__dirname,"data","users.json"),MAX_MESSAGES=100;
const GOOGLE_CLIENT_ID=process.env.GOOGLE_CLIENT_ID||"",RESEND_API_KEY=process.env.RESEND_API_KEY||"",EMAIL_FROM=process.env.EMAIL_FROM||"",APP_ORIGIN=String(process.env.APP_ORIGIN||"").replace(/\/$/,"");
let userStore={version:1,users:[]},saveQueue=Promise.resolve();try{userStore=JSON.parse(fs.readFileSync(USER_FILE,"utf8"))}catch{}
const sessions=new Map(),messages=[],attempts=new Map();
const json=(res,status,payload)=>res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}).end(JSON.stringify(payload));
const clean=value=>String(value||"").trim();
const publicUser=user=>({id:user.id,username:user.username,age:user.age,gender:user.gender,provider:user.provider,emailVerified:Boolean(user.emailVerified||user.provider==="google")});
function saveUsers(){saveQueue=saveQueue.then(()=>fsp.writeFile(USER_FILE,JSON.stringify(userStore,null,2),"utf8"));return saveQueue}
function readBody(req){return new Promise((resolve,reject)=>{let body="";req.on("data",chunk=>{body+=chunk;if(body.length>32768){reject(new Error("Request too large"));req.destroy()}});req.on("end",()=>{try{resolve(JSON.parse(body||"{}"))}catch{reject(new Error("Invalid request"))}});req.on("error",reject)})}
function parseCookies(req){return Object.fromEntries(String(req.headers.cookie||"").split(";").map(part=>part.trim().split("=")).filter(pair=>pair.length===2).map(([key,value])=>[key,decodeURIComponent(value)]))}
function sessionUser(req){const token=parseCookies(req).nearby_session,session=token&&sessions.get(token);if(!session||session.expiresAt<Date.now()){if(token)sessions.delete(token);return null}return userStore.users.find(user=>user.id===session.userId)||null}
function setSession(req,res,user){const token=crypto.randomBytes(32).toString("base64url"),maxAge=604800;sessions.set(token,{userId:user.id,expiresAt:Date.now()+maxAge*1000});const secure=req.headers["x-forwarded-proto"]==="https"?"; Secure":"";res.setHeader("Set-Cookie",`nearby_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`)}
function clearSession(req,res){const token=parseCookies(req).nearby_session;if(token)sessions.delete(token);res.setHeader("Set-Cookie","nearby_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0")}
function sameOrigin(req){const origin=req.headers.origin;if(!origin)return true;try{return new URL(origin).host===req.headers.host}catch{return false}}
function rateLimited(req,key,limit=15){const id=`${req.socket.remoteAddress}:${key}`,now=Date.now(),record=attempts.get(id)||{count:0,resetAt:now+600000};if(record.resetAt<now){record.count=0;record.resetAt=now+600000}record.count++;attempts.set(id,record);return record.count>limit}
const tokenHash=token=>crypto.createHash("sha256").update(token).digest("hex");
const safe=value=>String(value).replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
function scrypt(password,salt){return new Promise((resolve,reject)=>crypto.scrypt(password,salt,64,(error,key)=>error?reject(error):resolve(key.toString("hex"))))}
function uniqueUsername(base){const normalized=base.replace(/[^a-zA-Z0-9_]/g,"").slice(0,18)||"member";let candidate=normalized,counter=1;while(userStore.users.some(user=>user.usernameLower===candidate.toLowerCase()))candidate=`${normalized}${counter++}`;return candidate}
function verificationOrigin(req){if(APP_ORIGIN)return APP_ORIGIN;return `http://${req.headers.host||`localhost:${PORT}`}`}
async function sendVerification(req,user,rawToken){
 if(!RESEND_API_KEY||!EMAIL_FROM)throw new Error("Verification email is not configured yet.");
 const verifyUrl=`${verificationOrigin(req)}/verify-email?token=${encodeURIComponent(rawToken)}`,username=safe(user.username);
 const response=await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:`Bearer ${RESEND_API_KEY}`,"Content-Type":"application/json"},body:JSON.stringify({from:EMAIL_FROM,to:[user.email],subject:"Verify your Nearby account",html:`<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:28px;color:#172033"><h1 style="font-size:24px">Verify your email</h1><p>Hi ${username}, confirm this email address to enter Nearby's global chat.</p><p style="margin:28px 0"><a href="${safe(verifyUrl)}" style="background:#446df6;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700">Verify email</a></p><p style="color:#697386;font-size:13px">This link expires in 30 minutes. If you did not create this account, ignore this email.</p></div>`})});
 if(!response.ok){const detail=await response.json().catch(()=>({}));throw new Error(detail.message||"Verification email could not be sent.")}
}
function validateManual(body){
 const username=clean(body.username),email=clean(body.email).toLowerCase(),password=String(body.password||""),age=Number(body.age),gender=clean(body.gender);
 if(body.adultConfirmed!==true)throw new Error("Confirm that you are 18 or older.");if(!/^[a-zA-Z0-9_]{3,24}$/.test(username))throw new Error("Username must be 3–24 characters using letters, numbers, or underscores.");if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error("Enter a valid email address.");if(!Number.isInteger(age)||age<18||age>120)throw new Error("You must be 18 or older.");if(!["woman","man","nonbinary","prefer_not"].includes(gender))throw new Error("Choose a gender option.");if(password.length<8||password.length>128)throw new Error("Password must be between 8 and 128 characters.");return{username,email,password,age,gender};
}
async function createManualUser(req,body){
 if(!RESEND_API_KEY||!EMAIL_FROM)throw new Error("Email verification is being configured. Please try again later.");
 const{username,email,password,age,gender}=validateManual(body),existingEmail=userStore.users.find(user=>user.emailLower===email);
 if(userStore.users.some(user=>user.usernameLower===username.toLowerCase()))throw new Error("That username is already taken.");if(existingEmail)throw new Error(existingEmail.emailVerified?"An account already exists for that email.":"That email is waiting for verification. Use resend verification below.");
 const passwordSalt=crypto.randomBytes(16).toString("hex"),passwordHash=await scrypt(password,passwordSalt),rawToken=crypto.randomBytes(32).toString("base64url");
 const user={id:crypto.randomUUID(),username,usernameLower:username.toLowerCase(),email,emailLower:email,age,gender,passwordSalt,passwordHash,provider:"password",emailVerified:false,verificationTokenHash:tokenHash(rawToken),verificationExpiresAt:Date.now()+1800000,adultConfirmedAt:new Date().toISOString(),createdAt:new Date().toISOString()};
 userStore.users.push(user);await saveUsers();try{await sendVerification(req,user,rawToken)}catch(error){userStore.users=userStore.users.filter(item=>item.id!==user.id);await saveUsers();throw error}return user;
}
async function verifyGoogle(body){
 if(!GOOGLE_CLIENT_ID)throw new Error("Google sign-in is not configured yet.");if(body.adultConfirmed!==true)throw new Error("Confirm that you are 18 or older.");
 const response=await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(body.credential||"")}`);if(!response.ok)throw new Error("Google sign-in could not be verified.");const token=await response.json();
 if(token.aud!==GOOGLE_CLIENT_ID||token.email_verified!=="true"||!token.sub||Number(token.exp)*1000<Date.now())throw new Error("Google sign-in could not be verified.");
 let user=userStore.users.find(item=>item.googleSubject===token.sub)||userStore.users.find(item=>item.emailLower===String(token.email).toLowerCase());
 if(!user){const username=uniqueUsername(String(token.name||token.email.split("@")[0]));user={id:crypto.randomUUID(),username,usernameLower:username.toLowerCase(),email:token.email,emailLower:String(token.email).toLowerCase(),age:null,gender:"prefer_not",passwordSalt:null,passwordHash:null,provider:"google",googleSubject:token.sub,emailVerified:true,adultConfirmedAt:new Date().toISOString(),createdAt:new Date().toISOString()};userStore.users.push(user)}else{user.googleSubject=token.sub;user.emailVerified=true}
 await saveUsers();return user;
}

const server=http.createServer(async(req,res)=>{
 const requestUrl=new URL(req.url||"/",`http://${req.headers.host||"localhost"}`),urlPath=decodeURIComponent(requestUrl.pathname);
 if(urlPath==="/api/config")return json(res,200,{googleClientId:GOOGLE_CLIENT_ID||null,emailVerificationConfigured:Boolean(RESEND_API_KEY&&EMAIL_FROM)});
 if(urlPath==="/api/auth/me"){const user=sessionUser(req);return user?json(res,200,{user:publicUser(user)}):json(res,401,{error:"Not signed in"})}
 if(urlPath==="/api/auth/signup"&&req.method==="POST"){
  if(!sameOrigin(req))return json(res,403,{error:"Request origin was rejected."});if(rateLimited(req,"signup",8))return json(res,429,{error:"Too many attempts. Try again later."});
  try{const user=await createManualUser(req,await readBody(req));return json(res,201,{pendingVerification:true,email:user.email})}catch(error){return json(res,400,{error:error.message})}
 }
 if(urlPath==="/api/auth/resend-verification"&&req.method==="POST"){
  if(!sameOrigin(req))return json(res,403,{error:"Request origin was rejected."});if(rateLimited(req,"resend",5))return json(res,429,{error:"Too many resend attempts. Try again later."});
  try{const body=await readBody(req),email=clean(body.email).toLowerCase(),user=userStore.users.find(item=>item.emailLower===email);if(user&&!user.emailVerified){const rawToken=crypto.randomBytes(32).toString("base64url");user.verificationTokenHash=tokenHash(rawToken);user.verificationExpiresAt=Date.now()+1800000;await saveUsers();await sendVerification(req,user,rawToken)}return json(res,200,{ok:true})}catch(error){return json(res,400,{error:error.message})}
 }
 if(urlPath==="/verify-email"&&req.method==="GET"){
  const rawToken=requestUrl.searchParams.get("token")||"",hash=tokenHash(rawToken),user=userStore.users.find(item=>item.verificationTokenHash===hash&&item.verificationExpiresAt>Date.now());
  if(!user){res.writeHead(302,{Location:"/?verification=invalid"}).end();return}user.emailVerified=true;user.verificationTokenHash=null;user.verificationExpiresAt=null;user.verifiedAt=new Date().toISOString();await saveUsers();setSession(req,res,user);res.writeHead(302,{Location:"/?verified=1"}).end();return;
 }
 if(urlPath==="/api/auth/google"&&req.method==="POST"){
  if(!sameOrigin(req))return json(res,403,{error:"Request origin was rejected."});if(rateLimited(req,"google",10))return json(res,429,{error:"Too many attempts. Try again later."});try{const user=await verifyGoogle(await readBody(req));setSession(req,res,user);return json(res,200,{user:publicUser(user)})}catch(error){return json(res,400,{error:error.message})}
 }
 if(urlPath==="/api/auth/login"&&req.method==="POST"){
  if(!sameOrigin(req))return json(res,403,{error:"Request origin was rejected."});if(rateLimited(req,"login",20))return json(res,429,{error:"Too many attempts. Try again later."});
  try{const body=await readBody(req),identifier=clean(body.identifier).toLowerCase(),password=String(body.password||""),user=userStore.users.find(item=>item.emailLower===identifier||item.usernameLower===identifier);if(!user?.passwordHash)throw new Error("Incorrect username, email, or password.");const candidate=await scrypt(password,user.passwordSalt),valid=crypto.timingSafeEqual(Buffer.from(candidate,"hex"),Buffer.from(user.passwordHash,"hex"));if(!valid)throw new Error("Incorrect username, email, or password.");if(!user.emailVerified)throw new Error("Verify your email before logging in.");setSession(req,res,user);return json(res,200,{user:publicUser(user)})}catch(error){return json(res,401,{error:error.message})}
 }
 if(urlPath==="/api/auth/logout"&&req.method==="POST"){if(!sameOrigin(req))return json(res,403,{error:"Request origin was rejected."});clearSession(req,res);return json(res,200,{ok:true})}
 if(urlPath==="/"||urlPath==="/index.html")return fs.readFile(path.join(PUBLIC_DIR,"global.html"),"utf8",(error,html)=>{if(error)return res.writeHead(404).end("Not found");const output=html.replace('<script src="/global.js"></script>','<script src="/global.js"></script><script src="/auth-enhancements.js"></script>');res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"}).end(output)});
 const relative=urlPath.replace(/^\/+/,""),file=path.resolve(PUBLIC_DIR,relative);if(!file.startsWith(PUBLIC_DIR))return res.writeHead(403).end("Forbidden");fs.readFile(file,(error,data)=>{if(error)return res.writeHead(404).end("Not found");const types={".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8"};res.writeHead(200,{"Content-Type":types[path.extname(file)]||"application/octet-stream","Cache-Control":"no-store"}).end(data)});
});
const wss=new WebSocketServer({noServer:true});server.on("upgrade",(req,socket,head)=>{const user=sessionUser(req);if(!user)return socket.destroy();wss.handleUpgrade(req,socket,head,ws=>{ws.user=user;wss.emit("connection",ws,req)})});
function broadcast(payload){const text=JSON.stringify(payload);for(const client of wss.clients)if(client.readyState===WebSocket.OPEN)client.send(text)}function presence(){return[...wss.clients].filter(client=>client.readyState===WebSocket.OPEN).length}
wss.on("connection",ws=>{ws.send(JSON.stringify({type:"history",messages:messages.slice(-MAX_MESSAGES),online:presence()}));broadcast({type:"presence",online:presence()});ws.on("message",raw=>{let event;try{event=JSON.parse(raw.toString())}catch{return}if(event.type!=="message")return;const text=clean(event.text).slice(0,500);if(!text)return;const message={id:crypto.randomUUID(),username:ws.user.username,text,createdAt:Date.now()};messages.push(message);if(messages.length>MAX_MESSAGES)messages.splice(0,messages.length-MAX_MESSAGES);broadcast({type:"message",message})});ws.on("close",()=>broadcast({type:"presence",online:presence()}))});
server.listen(PORT,()=>console.log(`Nearby verified auth is running at http://localhost:${PORT}`));
