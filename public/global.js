const $=selector=>document.querySelector(selector);
let currentUser=null,socket=null,googleAction="login",googleClientId=null,reconnectTimer=null;

function toast(message){const element=$("#toast");element.textContent=message;element.classList.add("show");setTimeout(()=>element.classList.remove("show"),2400)}
function initials(name){return String(name||"?").split(/\s+/).map(part=>part[0]).join("").slice(0,2).toUpperCase()}
function showError(id,message){const element=$(id);element.textContent=message;element.hidden=!message}
async function request(url,options={}){const response=await fetch(url,{...options,headers:{"Content-Type":"application/json",...(options.headers||{})}});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||"Something went wrong.");return data}

function switchAuth(mode){
 document.querySelectorAll(".auth-tab").forEach(tab=>tab.classList.toggle("active",tab.dataset.authTab===mode));
 $("#loginPane").classList.toggle("active",mode==="login");$("#signupPane").classList.toggle("active",mode==="signup");
 showError("#loginError","");showError("#signupError","");
}
document.querySelectorAll("[data-auth-tab]").forEach(tab=>tab.onclick=()=>switchAuth(tab.dataset.authTab));
document.querySelectorAll("[data-switch]").forEach(button=>button.onclick=()=>switchAuth(button.dataset.switch));
document.querySelectorAll(".reveal").forEach(button=>button.onclick=()=>{const input=button.parentElement.querySelector("input");input.type=input.type==="password"?"text":"password";button.textContent=input.type==="password"?"Show":"Hide"});

function setBusy(form,busy){const button=form.querySelector("button[type=submit]");button.disabled=busy;button.dataset.label||=(button.innerHTML);button.innerHTML=busy?"Please wait…":button.dataset.label}
$("#loginForm").onsubmit=async event=>{
 event.preventDefault();const form=event.currentTarget,data=new FormData(form);showError("#loginError","");setBusy(form,true);
 try{const result=await request("/api/auth/login",{method:"POST",body:JSON.stringify({identifier:data.get("identifier"),password:data.get("password")})});enterChat(result.user)}catch(error){showError("#loginError",error.message)}finally{setBusy(form,false)}
};
$("#signupForm").onsubmit=async event=>{
 event.preventDefault();const form=event.currentTarget,data=new FormData(form);showError("#signupError","");setBusy(form,true);
 try{const result=await request("/api/auth/signup",{method:"POST",body:JSON.stringify({username:data.get("username"),age:Number(data.get("age")),email:data.get("email"),gender:data.get("gender"),password:data.get("password"),adultConfirmed:data.get("adultConfirmed")==="on"})});enterChat(result.user);toast("Account created. Welcome to Global.")}catch(error){showError("#signupError",error.message)}finally{setBusy(form,false)}
};

async function configureGoogle(){
 try{const config=await request("/api/config");googleClientId=config.googleClientId;if(!googleClientId)return;
  const script=document.createElement("script");script.src="https://accounts.google.com/gsi/client";script.async=true;script.onload=()=>google.accounts.id.initialize({client_id:googleClientId,callback:handleGoogleCredential});document.head.appendChild(script);
 }catch{}
}
document.querySelectorAll("[data-google-action]").forEach(button=>button.onclick=()=>{
 googleAction=button.dataset.googleAction;
 if(googleAction==="signup"&&!$("#signupForm [name=adultConfirmed]").checked){showError("#signupError","Confirm that you are 18 or older before continuing with Google.");$("#signupForm [name=adultConfirmed]").focus();return}
 if(!googleClientId||!window.google){toast("Google sign-in needs a Google client ID before it can be used.");return}
 google.accounts.id.prompt(notification=>{if(notification.isNotDisplayed()||notification.isSkippedMoment())toast("Google sign-in could not open. Check your browser settings.")});
});
async function handleGoogleCredential(response){
 try{const result=await request("/api/auth/google",{method:"POST",body:JSON.stringify({credential:response.credential,adultConfirmed:googleAction==="login"||$("#signupForm [name=adultConfirmed]").checked})});enterChat(result.user)}catch(error){showError(googleAction==="signup"?"#signupError":"#loginError",error.message)}
}

function enterChat(user){
 currentUser=user;$("#authView").hidden=true;$("#chatView").hidden=false;$("#sidebarUsername").textContent=user.username;$("#sidebarInitial").textContent=initials(user.username);connectChat();
}
function leaveChat(){
 currentUser=null;clearTimeout(reconnectTimer);if(socket){socket.onclose=null;socket.close();socket=null}$("#chatView").hidden=true;$("#authView").hidden=false;switchAuth("login");$("#messageList").innerHTML="";
}
async function logout(){try{await request("/api/auth/logout",{method:"POST",body:"{}"})}finally{leaveChat()}}
$("#logoutButton").onclick=logout;$("#accountButton").onclick=()=>toast(`Signed in as ${currentUser?.username||"member"}`);

function updatePresence(count){$("#onlineCount").textContent=count;$("#sidebarOnline").textContent=count}
function connectChat(){
 if(!currentUser)return;const protocol=location.protocol==="https:"?"wss:":"ws:";socket=new WebSocket(`${protocol}//${location.host}`);
 socket.onmessage=({data})=>{const event=JSON.parse(data);if(event.type==="history"){renderMessages(event.messages);updatePresence(event.online)}if(event.type==="message")appendMessage(event.message);if(event.type==="presence")updatePresence(event.online)};
 socket.onclose=()=>{if(currentUser){clearTimeout(reconnectTimer);reconnectTimer=setTimeout(connectChat,1800)}};
}
function renderMessages(items){
 const list=$("#messageList");list.innerHTML="";
 if(!items.length){list.innerHTML='<div class="empty-chat"><div><span>✦</span><h3>The room is quiet</h3><p>Start the first conversation.</p></div></div>';return}
 items.forEach(appendMessage);list.scrollTop=list.scrollHeight;
}
function appendMessage(message){
 const list=$("#messageList");list.querySelector(".empty-chat")?.remove();const article=document.createElement("article");article.className=`message ${message.username===currentUser?.username?"me":""}`;const time=new Intl.DateTimeFormat([],{hour:"numeric",minute:"2-digit"}).format(new Date(message.createdAt));
 article.innerHTML=`<span class="message-avatar">${initials(message.username)}</span><div><div class="message-meta"><strong></strong><time>${time}</time></div><div class="message-bubble"></div></div>`;article.querySelector("strong").textContent=message.username;article.querySelector(".message-bubble").textContent=message.text;list.appendChild(article);const nodes=list.querySelectorAll(".message");if(nodes.length>100)nodes[0].remove();list.scrollTop=list.scrollHeight;
}
$("#chatForm").onsubmit=event=>{event.preventDefault();const input=$("#chatInput"),text=input.value.trim();if(!text)return;if(socket?.readyState!==WebSocket.OPEN)return toast("Reconnecting to chat…");socket.send(JSON.stringify({type:"message",text}));input.value="";input.style.height="auto"};
$("#chatInput").oninput=event=>{event.target.style.height="auto";event.target.style.height=`${Math.min(event.target.scrollHeight,110)}px`};
$("#chatInput").onkeydown=event=>{if(event.key==="Enter"&&!event.shiftKey){event.preventDefault();$("#chatForm").requestSubmit()}};

async function initialize(){configureGoogle();try{const result=await request("/api/auth/me");enterChat(result.user)}catch{switchAuth("login")}}
initialize();
