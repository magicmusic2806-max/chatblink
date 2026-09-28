const rooms=[
 {id:"indiranagar",name:"Indiranagar",city:"Bengaluru, Karnataka",icon:"IN"},
 {id:"domlur",name:"Domlur",city:"Bengaluru, Karnataka",icon:"DO"},
 {id:"koramangala",name:"Koramangala",city:"Bengaluru, Karnataka",icon:"KO"},
 {id:"jayanagar",name:"Jayanagar",city:"Bengaluru, Karnataka",icon:"JA"},
 {id:"mysuru",name:"Mysuru",city:"Karnataka",icon:"MY"},
 {id:"kochi",name:"Kochi",city:"Kerala",icon:"KO"},
 {id:"mumbai",name:"Mumbai",city:"Maharashtra",icon:"MU"}
];
const $=s=>document.querySelector(s),roomList=$("#roomList"),messages=$("#messages"),input=$("#messageInput"),composer=$("#messageForm");
let profile=readProfile(),currentRoom=rooms[0],currentChannel="local",socket,reconnectTimer,photoData="";
function readProfile(){try{return JSON.parse(localStorage.getItem("nearby-profile"))||null}catch{return null}}
function initials(name){return name.split(/\s+/).map(p=>p[0]).join("").slice(0,2).toUpperCase()}
function roomRelationship(room){return profile?.homeRoom===room.id?"Your local room":"Open to visit"}
function renderRooms(filter=""){
 const q=filter.trim().toLowerCase(),visible=rooms.filter(r=>`${r.name} ${r.city}`.toLowerCase().includes(q));
 roomList.innerHTML=visible.length?visible.map(r=>`<button class="room-item ${r.id===currentRoom.id?"active":""}" data-room="${r.id}"><span class="room-symbol">${r.icon}</span><span class="room-copy"><strong>${r.name}</strong><span>${r.city}</span></span><span class="room-side">${roomRelationship(r)}</span></button>`).join(""):`<p class="empty-search">No matching place yet.</p>`;
 roomList.querySelectorAll("[data-room]").forEach(b=>b.onclick=()=>selectRoom(b.dataset.room));
}
function selectRoom(id){
 currentRoom=rooms.find(r=>r.id===id)||rooms[0];const local=profile?.homeRoom===currentRoom.id;
 $("#roomName").textContent=currentRoom.name;$("#roomMeta").innerHTML=`${currentRoom.city} · <span>${local?"Your local room":"Visiting"}</span>`;$("#placeIcon").textContent=currentRoom.icon;$("#welcomeTitle").textContent=local?`Welcome home to ${currentRoom.name}.`:`You’re visiting ${currentRoom.name}.`;
 renderRooms($("#roomSearch").value);updatePermissions();joinChannel();$("#sidebar").classList.remove("open");
}
function setChannel(channel){
 currentChannel=channel;document.querySelectorAll(".channel-tab").forEach(t=>t.classList.toggle("active",t.dataset.channel===channel));
 $("#channelNote").innerHTML=channel==="local"?`Local conversation <span>•</span> Last 100 messages`:`Open conversation <span>•</span> Last 100 messages`;
 $("#composerBadge").textContent=channel.toUpperCase();updatePermissions();joinChannel();
}
function updatePermissions(){
 const visitor=currentChannel==="local"&&profile?.homeRoom!==currentRoom.id;$("#visitorNotice").hidden=!visitor;composer.classList.toggle("disabled",visitor);input.disabled=visitor;input.placeholder=visitor?"Local conversation is read-only for visitors":currentChannel==="local"?"Message your neighbours…":`Message the open room…`;
}
function connect(){
 const protocol=location.protocol==="https:"?"wss:":"ws:";socket=new WebSocket(`${protocol}//${location.host}`);socket.onopen=joinChannel;socket.onmessage=({data})=>{const event=JSON.parse(data);if(event.type==="history")renderMessages(event.messages);if(event.type==="message")appendMessage(event.message);if(event.type==="error")toast(event.message)};socket.onclose=()=>{messages.innerHTML=`<div class="empty-messages"><div><span>↻</span><strong>Reconnecting…</strong><p>The room will return automatically.</p></div></div>`;clearTimeout(reconnectTimer);reconnectTimer=setTimeout(connect,1800)};
}
function joinChannel(){
 messages.innerHTML=`<div class="empty-messages"><div><span>◌</span><strong>Opening the room…</strong></div></div>`;
 if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:"join",roomId:currentRoom.id,channel:currentChannel,profile}));
}
function renderMessages(items){
 messages.innerHTML=`<div class="day-divider">Recent conversation</div>`;
 if(!items.length){messages.innerHTML+=`<div class="empty-messages"><div><span>✦</span><strong>No messages yet</strong><p>${currentChannel==="local"?"Be the first neighbour to say something.":`Start the open conversation about ${currentRoom.name}.`}</p></div></div>`;return}
 items.slice(-100).forEach(appendMessage);messages.scrollTop=messages.scrollHeight;
}
function appendMessage(message){
 messages.querySelector(".empty-messages")?.remove();const article=document.createElement("article");article.className=`message ${message.name===profile?.name?"me":""}`;const time=new Intl.DateTimeFormat([],{hour:"numeric",minute:"2-digit"}).format(new Date(message.createdAt));article.innerHTML=`<span class="avatar">${initials(message.name)}</span><div><div class="message-head"><strong></strong><time>${time}</time></div><div class="message-body"></div></div>`;article.querySelector("strong").textContent=message.name;article.querySelector(".message-body").textContent=message.text;messages.appendChild(article);const nodes=messages.querySelectorAll(".message");if(nodes.length>100)nodes[0].remove();messages.scrollTop=messages.scrollHeight;
}
function updateProfileUI(){
 if(!profile)return;$("#sidebarName").textContent=profile.name;$("#sidebarLocation").textContent=`${rooms.find(r=>r.id===profile.homeRoom)?.name||"Area not set"} · Local`;const avatar=$("#sidebarAvatar");avatar.textContent=profile.photo?"":initials(profile.name);avatar.style.backgroundImage=profile.photo?`url(${profile.photo})`:"";
}
function showOnboarding(edit=false){
 $("#onboardingModal").classList.remove("hidden");if(edit&&profile){const form=$("#onboardingForm");form.elements.name.value=profile.name;form.elements.age.value=profile.age;form.elements.homeRoom.value=profile.homeRoom;photoData=profile.photo||"";if(photoData){$("#photoPreview").textContent="";$("#photoPreview").style.backgroundImage=`url(${photoData})`}}
}
function toast(message){const el=$("#toast");el.textContent=message;el.classList.add("show");setTimeout(()=>el.classList.remove("show"),2400)}

$("#homeRoomSelect").innerHTML=rooms.map(r=>`<option value="${r.id}">${r.name}, ${r.city}</option>`).join("");$("#locateButton").textContent="Choose area";$("#pulseText").textContent="";$("#pulseDetail").textContent="";renderRooms();
if(profile){$("#onboardingModal").classList.add("hidden");currentRoom=rooms.find(r=>r.id===profile.homeRoom)||rooms[0];updateProfileUI();selectRoom(currentRoom.id)}
connect();
$("#roomSearch").oninput=e=>renderRooms(e.target.value);$("#locateButton").onclick=()=>showOnboarding(Boolean(profile));$("#profileButton").onclick=()=>showOnboarding(true);$("#openSidebar").onclick=()=>$("#sidebar").classList.add("open");$("#closeSidebar").onclick=()=>$("#sidebar").classList.remove("open");$("#switchOpen").onclick=()=>setChannel("open");document.querySelectorAll(".channel-tab").forEach(t=>t.onclick=()=>setChannel(t.dataset.channel));
composer.onsubmit=e=>{e.preventDefault();if(!profile)return showOnboarding();const text=input.value.trim();if(!text)return;if(socket?.readyState!==WebSocket.OPEN)return toast("Still connecting. Try again in a moment.");socket.send(JSON.stringify({type:"message",text}));input.value="";input.style.height="auto"};
input.oninput=()=>{input.style.height="auto";input.style.height=`${Math.min(input.scrollHeight,100)}px`};input.onkeydown=e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();composer.requestSubmit()}};
$("#photoInput").onchange=e=>{const file=e.target.files[0];if(!file)return;if(file.size>2097152)return toast("Please choose a photo under 2 MB.");const reader=new FileReader();reader.onload=()=>{photoData=reader.result;$("#photoPreview").textContent="";$("#photoPreview").style.backgroundImage=`url(${photoData})`};reader.readAsDataURL(file)};
$("#onboardingForm").onsubmit=e=>{e.preventDefault();const data=new FormData(e.currentTarget);profile={name:data.get("name").trim(),age:Number(data.get("age")),homeRoom:data.get("homeRoom"),photo:photoData};localStorage.setItem("nearby-profile",JSON.stringify(profile));$("#onboardingModal").classList.add("hidden");updateProfileUI();selectRoom(profile.homeRoom);toast(`Welcome, ${profile.name}.`)};
document.onkeydown=e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="k"){e.preventDefault();$("#roomSearch").focus()}};
