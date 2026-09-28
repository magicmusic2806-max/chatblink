const rooms=[
 {id:"indiranagar",name:"Indiranagar",city:"Bengaluru, Karnataka",distance:"1.2 km",online:284,unread:3,icon:"IN",pulse:"Lively right now",detail:"42 messages in the last hour"},
 {id:"domlur",name:"Domlur",city:"Bengaluru, Karnataka",distance:"2.4 km",online:126,unread:0,icon:"DO",pulse:"A few neighbours chatting",detail:"18 messages in the last hour"},
 {id:"koramangala",name:"Koramangala",city:"Bengaluru, Karnataka",distance:"4.8 km",online:492,unread:7,icon:"KO",pulse:"Very lively right now",detail:"67 messages in the last hour"},
 {id:"jayanagar",name:"Jayanagar",city:"Bengaluru, Karnataka",distance:"7.1 km",online:218,unread:0,icon:"JA",pulse:"Steady conversation",detail:"31 messages in the last hour"},
 {id:"mysuru",name:"Mysuru",city:"Karnataka",distance:"144 km",online:611,unread:0,icon:"MY",pulse:"Lively right now",detail:"53 messages in the last hour"},
 {id:"kochi",name:"Kochi",city:"Kerala",distance:"548 km",online:837,unread:0,icon:"KO",pulse:"Very lively right now",detail:"81 messages in the last hour"},
 {id:"mumbai",name:"Mumbai",city:"Maharashtra",distance:"981 km",online:2401,unread:0,icon:"MU",pulse:"Buzzing right now",detail:"100 recent messages"}
];
const $=s=>document.querySelector(s),roomList=$("#roomList"),messages=$("#messages"),input=$("#messageInput"),composer=$("#messageForm");
let profile=readProfile(),currentRoom=rooms[0],currentChannel="local",socket,reconnectTimer,photoData="";
function readProfile(){try{return JSON.parse(localStorage.getItem("nearby-profile"))||null}catch{return null}}
function initials(name){return name.split(/\s+/).map(p=>p[0]).join("").slice(0,2).toUpperCase()}
function renderRooms(filter=""){
 const q=filter.trim().toLowerCase(),visible=rooms.filter(r=>`${r.name} ${r.city}`.toLowerCase().includes(q));
 roomList.innerHTML=visible.length?visible.map(r=>`<button class="room-item ${r.id===currentRoom.id?"active":""}" data-room="${r.id}"><span class="room-symbol">${r.icon}</span><span class="room-copy"><strong>${r.name}</strong><span>${r.city} · ${r.online.toLocaleString()} online</span></span><span class="room-side">${r.distance}${r.unread?`<b>${r.unread}</b>`:""}</span></button>`).join(""):`<p class="empty-search">No place found. Try a city, district, or neighbourhood.</p>`;
 roomList.querySelectorAll("[data-room]").forEach(b=>b.onclick=()=>selectRoom(b.dataset.room));
}
function selectRoom(id){
 currentRoom=rooms.find(r=>r.id===id)||rooms[0];
 $("#roomName").textContent=currentRoom.name;$("#roomMeta").innerHTML=`${currentRoom.city} · <span>${currentRoom.distance} away</span>`;$("#placeIcon").textContent=currentRoom.icon;$("#onlineCount").textContent=currentRoom.online.toLocaleString();$("#welcomeTitle").textContent=`Good evening, ${currentRoom.name}.`;$("#pulseText").textContent=currentRoom.pulse;$("#pulseDetail").textContent=currentRoom.detail;
 renderRooms($("#roomSearch").value);updatePermissions();joinChannel();$("#sidebar").classList.remove("open");
}
function setChannel(channel){
 currentChannel=channel;document.querySelectorAll(".channel-tab").forEach(t=>t.classList.toggle("active",t.dataset.channel===channel));
 $("#channelNote").innerHTML=channel==="local"?`Verified locals can talk here <span>•</span> Last 100 messages`:`Everyone can join the conversation <span>•</span> Last 100 messages`;
 $("#composerBadge").textContent=channel.toUpperCase();updatePermissions();joinChannel();
}
function updatePermissions(){
 const visitor=currentChannel==="local"&&profile?.homeRoom!==currentRoom.id;$("#visitorNotice").hidden=!visitor;composer.classList.toggle("disabled",visitor);input.disabled=visitor;input.placeholder=visitor?"Local conversation is read-only for visitors":currentChannel==="local"?"Message your neighbours…":`Message everyone in ${currentRoom.name}…`;
}
function connect(){
 const protocol=location.protocol==="https:"?"wss:":"ws:";socket=new WebSocket(`${protocol}//${location.host}`);socket.onopen=joinChannel;socket.onmessage=({data})=>{const e=JSON.parse(data);if(e.type==="history")renderMessages(e.messages);if(e.type==="message")appendMessage(e.message);if(e.type==="error")toast(e.message)};socket.onclose=()=>{clearTimeout(reconnectTimer);reconnectTimer=setTimeout(connect,1800)};
}
function joinChannel(){
 messages.innerHTML=`<div class="empty-messages"><div><span>◌</span><strong>Opening the conversation…</strong></div></div>`;
 if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:"join",roomId:currentRoom.id,channel:currentChannel,profile}));
}
function renderMessages(items){
 messages.innerHTML=`<div class="day-divider">Latest in ${currentRoom.name}</div>`;
 if(!items.length){messages.innerHTML+=`<div class="empty-messages"><div><span>☀</span><strong>It’s quiet here—for now.</strong><p>Start the conversation in ${currentChannel==="local"?"your neighbourhood":"this open room"}.</p></div></div>`;return}
 items.slice(-100).forEach(appendMessage);messages.scrollTop=messages.scrollHeight;
}
function appendMessage(message){
 messages.querySelector(".empty-messages")?.remove();const article=document.createElement("article");article.className=`message ${message.name===profile?.name?"me":""}`;const time=new Intl.DateTimeFormat([],{hour:"numeric",minute:"2-digit"}).format(new Date(message.createdAt));
 article.innerHTML=`<span class="avatar">${initials(message.name)}</span><div><div class="message-head"><strong></strong><time>${time}</time></div><div class="message-body"></div></div>`;article.querySelector("strong").textContent=message.name;article.querySelector(".message-body").textContent=message.text;messages.appendChild(article);const nodes=messages.querySelectorAll(".message");if(nodes.length>100)nodes[0].remove();messages.scrollTop=messages.scrollHeight;
}
function updateProfileUI(){
 if(!profile)return;$("#sidebarName").textContent=profile.name;$("#sidebarLocation").textContent=`${rooms.find(r=>r.id===profile.homeRoom)?.name||"Local"} · Local`;const avatar=$("#sidebarAvatar");avatar.textContent=profile.photo?"":initials(profile.name);avatar.style.backgroundImage=profile.photo?`url(${profile.photo})`:"";
}
function showOnboarding(edit=false){
 $("#onboardingModal").classList.remove("hidden");if(edit&&profile){const f=$("#onboardingForm");f.elements.name.value=profile.name;f.elements.age.value=profile.age;f.elements.homeRoom.value=profile.homeRoom;photoData=profile.photo||"";if(photoData)$("#photoPreview").style.backgroundImage=`url(${photoData})`}
}
function toast(message){const el=$("#toast");el.textContent=message;el.classList.add("show");setTimeout(()=>el.classList.remove("show"),2400)}

$("#homeRoomSelect").innerHTML=rooms.map(r=>`<option value="${r.id}">${r.name}, ${r.city}</option>`).join("");renderRooms();
if(profile){$("#onboardingModal").classList.add("hidden");currentRoom=rooms.find(r=>r.id===profile.homeRoom)||rooms[0];updateProfileUI();selectRoom(currentRoom.id)}
connect();
$("#roomSearch").oninput=e=>renderRooms(e.target.value);$("#locateButton").onclick=()=>toast("Rooms are ranked from your approximate location.");$("#profileButton").onclick=()=>showOnboarding(true);$("#openSidebar").onclick=()=>$("#sidebar").classList.add("open");$("#closeSidebar").onclick=()=>$("#sidebar").classList.remove("open");$("#switchOpen").onclick=()=>setChannel("open");document.querySelectorAll(".channel-tab").forEach(t=>t.onclick=()=>setChannel(t.dataset.channel));
composer.onsubmit=e=>{e.preventDefault();if(!profile)return showOnboarding();const text=input.value.trim();if(!text)return;socket.send(JSON.stringify({type:"message",text}));input.value="";input.style.height="auto"};
input.oninput=()=>{input.style.height="auto";input.style.height=`${Math.min(input.scrollHeight,100)}px`};input.onkeydown=e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();composer.requestSubmit()}};
$("#photoInput").onchange=e=>{const file=e.target.files[0];if(!file)return;if(file.size>2097152)return toast("Please choose a photo under 2 MB.");const reader=new FileReader();reader.onload=()=>{photoData=reader.result;$("#photoPreview").textContent="";$("#photoPreview").style.backgroundImage=`url(${photoData})`};reader.readAsDataURL(file)};
$("#onboardingForm").onsubmit=e=>{e.preventDefault();const data=new FormData(e.currentTarget);profile={name:data.get("name").trim(),age:Number(data.get("age")),homeRoom:data.get("homeRoom"),photo:photoData};localStorage.setItem("nearby-profile",JSON.stringify(profile));$("#onboardingModal").classList.add("hidden");updateProfileUI();selectRoom(profile.homeRoom);toast(`Welcome to Nearby, ${profile.name}.`)};
document.onkeydown=e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="k"){e.preventDefault();$("#roomSearch").focus()}};
