const $=selector=>document.querySelector(selector);
const THEME_KEY="chatblink.theme";
const BUILT_IN_PATTERNS={casual:"diagonal",fun:"chevrons",comedy:"ribbons",dating:"diamonds",adult:"panels",friends:"weave","best-friends":"cross"},ROOM_PATTERNS=Object.values(BUILT_IN_PATTERNS);
function roomPattern(room){if(BUILT_IN_PATTERNS[room.id])return BUILT_IN_PATTERNS[room.id];let hash=0;for(const character of String(room.id||room.name||"room"))hash=(hash*31+character.charCodeAt(0))>>>0;return ROOM_PATTERNS[hash%ROOM_PATTERNS.length]}
function applyTheme(theme,remember=false){const light=theme==="light",label=`Switch to ${light?"dark":"light"} mode`,icon=light?'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 15.5A8.4 8.4 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/></svg>':'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';document.documentElement.dataset.theme=light?"light":"dark";document.documentElement.style.colorScheme=light?"light":"dark";$("#themeColor").content=light?"#f4f7fb":"#090a12";document.querySelectorAll("[data-theme-toggle]").forEach(button=>{button.title=label;button.setAttribute("aria-label",label);button.innerHTML=icon});if(remember)try{localStorage.setItem(THEME_KEY,light?"light":"dark")}catch{}}
applyTheme(document.documentElement.dataset.theme==="light"?"light":"dark");
document.addEventListener("click",event=>{if(event.target.closest("[data-theme-toggle]"))applyTheme(document.documentElement.dataset.theme==="dark"?"light":"dark",true)});
let currentUser=null,rooms=[],currentRoom=null,socket=null,reconnectTimer=null,activeTool=null,authToken=null,pendingProfileKey=null,onlineUsers=[],profilePhoto="",dmTarget=null,voice=null,replyTarget=null,liveMessages=[],allUsers=[],roomBans=[],requestPoll=null,dmPermission=null,roomsPoll=null,dmsPoll=null,peopleQuery="",exploreCursor=null,exploreQuery="",exploreProfiles=[],exploreSearchTimer=null,profileTarget=null,roomSubscribed=false,subscriptionLoadId=0;
const REACTIONS=["👍","❤️","😂","😮","😢","🔥"];
const dmUnread=new Map();
const seenDmIds=new Set();
let currentCall=null,callTimer=null;
const hiddenUsers=new Set();try{JSON.parse(localStorage.getItem("nearby_hidden_users")||"[]").forEach(id=>hiddenUsers.add(id))}catch{}
const messageAuthor=message=>message.userId||message.username;
const isHiddenMessage=message=>hiddenUsers.has(messageAuthor(message));
function saveHiddenUsers(){try{localStorage.setItem("nearby_hidden_users",JSON.stringify([...hiddenUsers]))}catch{}}
function renderVisibleMessages(){renderMessages(liveMessages.filter(message=>!isHiddenMessage(message)))}
function setUserHidden(person,hidden){if(hidden)hiddenUsers.add(person.id);else hiddenUsers.delete(person.id);saveHiddenUsers();renderVisibleMessages();if(!$("#onlineModal").hidden)renderOnlineList();if(!$("#userModal").hidden)openUserModal(person)}
function toggleUserHidden(person){setUserHidden(person,!hiddenUsers.has(person.id));toast(hiddenUsers.has(person.id)?`Hiding messages from ${person.username}`:`Showing messages from ${person.username}`)}
try{authToken=localStorage.getItem("nearby_auth_token")}catch{}
try{pendingProfileKey=localStorage.getItem("nearby_pending_profile_key")}catch{}
const rememberToken=token=>{authToken=token;try{localStorage.setItem("nearby_auth_token",token)}catch{}};
const forgetToken=()=>{authToken=null;try{localStorage.removeItem("nearby_auth_token")}catch{}};
const rememberProfileKey=key=>{pendingProfileKey=key;try{localStorage.setItem("nearby_pending_profile_key",key)}catch{}};
const forgetProfileKey=()=>{pendingProfileKey=null;try{localStorage.removeItem("nearby_pending_profile_key")}catch{}};
const request=async(url,options={})=>{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Number(options.timeoutMs)||12000);try{const response=await fetch(url,{credentials:"same-origin",...options,signal:controller.signal,headers:{"Content-Type":"application/json",...(authToken?{Authorization:`Bearer ${authToken}`}:{ }),...(options.headers||{})}}),data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||"Something went wrong.");return data}catch(problem){if(problem.name==="AbortError")throw new Error("The server took too long to respond. Please try again.");throw problem}finally{clearTimeout(timer)}};
const initials=name=>String(name||"?").slice(0,2).toUpperCase();
function toast(message){const el=$("#toast");el.textContent=message;el.classList.add("show");setTimeout(()=>el.classList.remove("show"),2300)}
function error(id,message){const el=$(id);el.textContent=message;el.hidden=!message}
function switchAuth(mode){const selected=mode==="signup"||mode==="key-signup"?"signup":"key";document.querySelectorAll("[data-auth-pane]").forEach(pane=>pane.classList.toggle("active",pane.dataset.authPane===selected));if(selected==="key")refreshPasskeyAvailability()}
function authErrorTarget(mode){return ({signup:"#signupError","key-signup":"#signupError",login:"#keyLoginError",key:"#keyLoginError"})[mode]||"#keyLoginError"}
document.querySelectorAll("[data-switch]").forEach(b=>b.onclick=()=>switchAuth(b.dataset.switch));
function busy(form,value){const button=form.querySelector("button[type=submit]");if(!button)return;if(!button.dataset.copy)button.dataset.copy=button.innerHTML;button.disabled=value;button.innerHTML=value?"Please wait…":button.dataset.copy}
// Login and signup intentionally use their normal form actions. A full page load keeps
// the saved account and the visible authentication state in sync even after stale tabs.

function showProfileSetup(user,key){currentUser=user;$("#authView").hidden=true;$("#appView").hidden=true;$("#setupView").hidden=false;const card=$("#newKeyCard"),profileKey=key||pendingProfileKey;card.hidden=!profileKey;if(profileKey){$("#profileKeyValue").textContent=profileKey;$("#keySaved").checked=false}else $("#keySaved").checked=true;const form=$("#profileForm");form.elements.displayName.value=user.profile?.displayName||user.username;form.elements.bio.value=user.profile?.bio||"";form.elements.gender.value=user.profile?.gender||"";form.elements.interests.value=(user.profile?.interests||[]).join(", ");const avatar=form.querySelector(`[name=avatar][value="${user.profile?.avatar||"✨"}"]`);if(avatar)avatar.checked=true}
$("#copyKey").onclick=async()=>{const key=$("#profileKeyValue").textContent;try{await navigator.clipboard.writeText(key);toast("Profile key copied")}catch{toast("Select the key and copy it manually")}};
$("#downloadKey").onclick=()=>{const key=$("#profileKeyValue").textContent,blob=new Blob([`Chatblink profile key\n\n${key}\n\nKeep this private. It is a backup way to access your profile.\n`],{type:"text/plain"}),url=URL.createObjectURL(blob),link=document.createElement("a");link.href=url;link.download="chatblink-profile-key.txt";link.click();setTimeout(()=>URL.revokeObjectURL(url),500);toast("Profile key downloaded")};
$("#enterRoomsNow").onclick=()=>$("#profileForm").requestSubmit();
$("#profileForm").addEventListener("submit",async event=>{event.preventDefault();const form=event.currentTarget,data=new FormData(form);error("#profileError","");busy(form,true);$("#enterRoomsNow").disabled=true;try{const result=await request("/api/profile",{method:"POST",body:JSON.stringify({displayName:data.get("displayName"),avatar:data.get("avatar"),bio:data.get("bio"),gender:data.get("gender"),interests:data.get("interests")})});forgetProfileKey();$("#setupView").hidden=true;await enterApp(result.user)}catch(problem){error("#profileError",problem.message)}finally{busy(form,false);$("#enterRoomsNow").disabled=false}});
async function enterApp(user){currentUser=user;$("#authView").hidden=true;$("#setupView").hidden=true;$("#appView").hidden=false;await loadRooms();ensureNotifySocket();route("initial")}
async function leaveApp(){endCall();leaveRoomCall(true);roomCallState=null;stopRequestPoll();stopViewPolls();closeNotifySocket();clearTimeout(reconnectTimer);if(socket){socket.onclose=null;socket.close()}currentUser=null;currentRoom=null;$("#setupView").hidden=true;$("#authView").hidden=false;switchAuth("login");enterGuestMode()}
async function enterGuestMode(){try{const result=await request("/api/rooms");rooms=result.rooms;ensureNotifySocket();route("initial")}catch{}}
async function loadRooms(){rooms=(await request("/api/rooms")).rooms}
function stopRequestPoll(){if(requestPoll){clearInterval(requestPoll);requestPoll=null}}
function startRequestPoll(){stopRequestPoll();requestPoll=setInterval(()=>{if(!document.hidden&&currentRoom&&!currentRoom.canEnter)refreshRoomAccess(currentRoom.id)},4000)}
function stopRoomsPoll(){if(roomsPoll){clearInterval(roomsPoll);roomsPoll=null}}
function startRoomsPoll(){stopRoomsPoll();roomsPoll=setInterval(async()=>{if(!currentUser||document.hidden||$("#roomsView").hidden)return;try{const result=await request("/api/rooms/online"),counts=result.online||{};rooms.forEach(room=>{room.online=counts[room.id]||0});renderRoomsGrid()}catch{}},20000)}
function stopDmsPoll(){if(dmsPoll){clearInterval(dmsPoll);dmsPoll=null}}
function startDmsPoll(){stopDmsPoll();dmsPoll=setInterval(async()=>{if(document.hidden||$("#dmsView").hidden)return;try{await loadUsers();renderPeopleList();if(!$("#dmInbox").hidden)renderDmInbox();renderDmHeadDot()}catch{}},30000)}
function stopViewPolls(){stopRoomsPoll();stopDmsPoll()}
const ROOM_LOADER_MIN_MS=2000,ROOM_LOADER_MAX_MS=8000;
let roomLoaderTimer=null,roomLoaderShownAt=0,roomLoaderSettled=true;
function roomLoaderNode(){let node=$("#roomLoader");if(!node){node=document.createElement("div");node.id="roomLoader";node.className="room-loader";node.hidden=true;node.innerHTML='<div class="room-loader-card"><span class="room-loader-icon"></span><strong class="room-loader-name"></strong><span class="room-loader-tag">Opening room</span><div class="room-loader-bar"><i></i></div></div>';const panel=$("#chatPanel");if(panel)panel.appendChild(node)}return node}
function showRoomLoader(room){const node=roomLoaderNode();if(!node)return;roomLoaderSettled=false;roomLoaderShownAt=Date.now();node.querySelector(".room-loader-icon").textContent=(room&&room.icon)||"\uD83D\uDCAC";node.querySelector(".room-loader-name").textContent=(room&&room.name)||"Room";node.classList.remove("room-loader-out");node.hidden=false;node.classList.remove("room-loader-run");void node.offsetWidth;node.classList.add("room-loader-run");clearTimeout(roomLoaderTimer);roomLoaderTimer=setTimeout(()=>hideRoomLoader(true),ROOM_LOADER_MAX_MS)}
function hideRoomLoader(immediate){clearTimeout(roomLoaderTimer);const node=$("#roomLoader");if(!node)return;if(node.hidden){node.classList.remove("room-loader-run","room-loader-out");return}const finish=()=>{node.hidden=true;node.classList.remove("room-loader-run","room-loader-out")};if(immediate){finish();return}node.classList.add("room-loader-out");roomLoaderTimer=setTimeout(finish,320)}
function settleRoomLoader(){if(roomLoaderSettled)return;roomLoaderSettled=true;const elapsed=Date.now()-roomLoaderShownAt;clearTimeout(roomLoaderTimer);roomLoaderTimer=setTimeout(()=>hideRoomLoader(false),Math.max(0,ROOM_LOADER_MIN_MS-elapsed))}
function renderRoomSubscription(loading=false){const button=$("#roomSubscribe");if(!button)return;button.hidden=!currentUser||!currentRoom?.canEnter;button.disabled=loading;button.classList.toggle("active",roomSubscribed);button.setAttribute("aria-pressed",String(roomSubscribed));button.textContent=loading?"🔔 Checking…":roomSubscribed?"🔔 Subscribed":"🔔 Subscribe"}
async function loadRoomSubscription(room){const loadId=++subscriptionLoadId;roomSubscribed=false;renderRoomSubscription(true);if(!currentUser||!room.canEnter)return renderRoomSubscription(false);try{const result=await request(`/api/rooms/${encodeURIComponent(room.id)}/subscription`);if(loadId!==subscriptionLoadId||currentRoom?.id!==room.id)return;roomSubscribed=Boolean(result.subscribed)}catch{}finally{if(loadId===subscriptionLoadId&&currentRoom?.id===room.id)renderRoomSubscription(false)}}
async function toggleRoomSubscription(){if(!currentUser||!currentRoom?.canEnter)return;const room=currentRoom,next=!roomSubscribed;renderRoomSubscription(true);try{if(next){if(!window.ChatblinkPush?.ensure)throw new Error("Notifications are still loading. Try again in a moment.");await window.ChatblinkPush.ensure()}const result=await request(`/api/rooms/${encodeURIComponent(room.id)}/subscription`,{method:"POST",body:JSON.stringify({subscribed:next})});if(currentRoom?.id!==room.id)return;roomSubscribed=Boolean(result.subscribed);toast(roomSubscribed?`Subscribed to ${room.name}`:`Room alerts turned off for ${room.name}`)}catch(problem){toast(problem.message||"Could not update this room subscription")}finally{if(currentRoom?.id===room.id)renderRoomSubscription(false)}}
$("#roomSubscribe").onclick=toggleRoomSubscription;
function selectRoom(room,mode="push"){if(!room)return;if(voice)stopVoiceNote(true);setReplyTarget(null);leaveRoomCall(true);roomCallState=null;currentRoom=room;liveMessages=[];loadRoomSubscription(room);stopRequestPoll();stopViewPolls();if(socket){socket.onclose=null;socket.close();socket=null}clearTimeout(reconnectTimer);$("#chatPanel").style.setProperty("--accent",room.accent);$("#chatPanel").style.setProperty("--soft",room.soft);$("#chatPanel").dataset.roomPattern=roomPattern(room);$("#roomIcon").textContent=room.icon;$("#roomName").textContent=room.name;$("#roomVibe").textContent=room.vibe;$("#accessPill").textContent="REQUEST ONLY";$("#accessPill").hidden=room.access!=="request";$("#chatInput").placeholder=`Message ${room.name}…`;$("#requestsButton").hidden=!(room.isOwner&&room.access==="request");$("#requestCount").textContent=room.pendingCount||0;closePicker();updateComposeTools();applyBanState();loadRoomBans();hideAllViews();markActiveNav("rooms");$("#chatPanel").hidden=false;if(mode==="push"){const path=roomPath(room.id);if(location.pathname!==path)history.pushState({roomId:room.id},"",path)}else if(mode==="replace")history.replaceState({roomId:room.id},"",roomPath(room.id));if(room.canEnter){$("#lockedView").hidden=true;$("#messageList").hidden=false;$("#composerArea").hidden=false;showRoomLoader(room);connectRoom()}else{$("#messageList").hidden=true;$("#composerArea").hidden=true;$("#lockedView").hidden=false;const button=$("#requestAccess");button.disabled=room.requestStatus==="pending";button.textContent=room.requestStatus==="pending"?"Request pending":"Request to join";if(room.requestStatus==="pending")startRequestPoll();else stopRequestPoll()}}
function updateComposeTools(){const allowed=Boolean(currentRoom&&currentRoom.canEnter&&!currentRoom.builtIn&&currentRoom.access==="request"&&!currentRoom.banned);document.querySelectorAll("[data-compose]").forEach(button=>{button.hidden=!allowed});renderRoomCall()}
function applyBanState(){const banned=Boolean(currentRoom&&currentRoom.banned),input=$("#chatInput"),sendButton=$("#chatForm button");input.disabled=banned;sendButton.disabled=banned;input.placeholder=banned?"You are banned from messaging in this room":`Message ${currentRoom?currentRoom.name:"this room"}…`;$("#composerArea .tool-row").hidden=banned;updateComposeTools()}
function handleSocketEvent(event){if(event.type==="history"){liveMessages=event.messages||[];renderVisibleMessages();updatePresence(event.users||[],event.online);settleRoomLoader()}if(event.type==="message"){liveMessages.push(event.message);if(liveMessages.length>100)liveMessages.shift();if(!isHiddenMessage(event.message))appendMessage(event.message)};if(event.type==="presence")updatePresence(event.users||[],event.online);if(event.type==="room-updated")refreshRoomAccess(event.roomId);if(event.type==="room-preview")handleRoomPreview(event);if(event.type==="dm")handleDm(event);if(event.type==="dm-permission")handleDmPermission(event);if(String(event.type||"").startsWith("call-"))handleCallSignal(event);if(event.type==="rooms-changed")refreshRoomsList();if(event.type==="room-online"){const onlineRoom=rooms.find(item=>item.id===event.roomId);if(onlineRoom){onlineRoom.online=event.online;if(!$("#roomsView").hidden)renderRoomsGrid()}}if(event.type==="users-changed")refreshUsersSoon();if(event.type==="room-deleted"){rooms=rooms.filter(item=>item.id!==event.roomId);if(currentRoom&&currentRoom.id===event.roomId){currentRoom=null;if(socket){socket.onclose=null;socket.close();socket=null}toast("This room was deleted");showRoomsPage("none")}else renderRoomsGrid()};if(event.type==="room-ban"){if(currentRoom&&event.roomId===currentRoom.id){currentRoom.banned=event.banned;applyBanState();toast(event.banned?"You are banned from messaging in this room":"You can message in this room again")}}if(event.type==="message-reactions")applyMessageReactions(event.messageId,event.reactions||{});if(event.type==="message-deleted")markMessageDeleted(event.messageId);if(event.type==="notice-changed"){siteNotice=event.notice||null;if(!$("#roomsView").hidden)renderNotice()};if(String(event.type||"").startsWith("group-call-"))handleRoomCallEvent(event).catch(()=>{});if(event.type==="account-deleted"){toast("This account was deleted by the admin");forgetToken();leaveApp()}}
function handleRoomPreview(event){const room=rooms.find(item=>item.id===event.roomId),message=event.message;if(!room||!message||room.access==="request")return;const preview=Array.isArray(room.preview)?room.preview.filter(item=>item.id!==message.id):[];preview.push(message);room.preview=preview.slice(-3);if(!$("#roomsView").hidden)renderRoomsGrid()}
async function refreshRoomsList(){try{await loadRooms();if(!$("#roomsView").hidden)renderRoomsGrid();if(currentRoom){const room=rooms.find(item=>item.id===currentRoom.id);if(room){currentRoom=room;$("#requestCount").textContent=room.pendingCount||0}}}catch{}}
async function refreshUsers(){if(!currentUser)return;await loadUsers();renderPeopleList();if(!$("#dmInbox").hidden)renderDmInbox();renderDmHeadDot();if(!$("#onlineModal").hidden)renderOnlineList();refreshMessageAvatars()}
let notifySocket=null,notifyTimer=null,usersRefreshTimer=null;
function refreshUsersSoon(){clearTimeout(usersRefreshTimer);usersRefreshTimer=setTimeout(refreshUsers,250)}
function ensureNotifySocket(){if((socket&&(socket.readyState===WebSocket.CONNECTING||socket.readyState===WebSocket.OPEN))||(notifySocket&&(notifySocket.readyState===WebSocket.CONNECTING||notifySocket.readyState===WebSocket.OPEN)))return;let channel;try{const protocol=location.protocol==="https:"?"wss:":"ws:",tokenPart=authToken?`&token=${encodeURIComponent(authToken)}`:"";channel=new WebSocket(`${protocol}//${location.host}?room=__notify${tokenPart}`);notifySocket=channel}catch{return}channel.onopen=()=>{refreshRoomsList();refreshUsersSoon()};channel.onmessage=({data})=>{try{handleSocketEvent(JSON.parse(data))}catch{}};channel.onerror=()=>{};channel.onclose=()=>{if(notifySocket!==channel)return;notifySocket=null;clearTimeout(notifyTimer);notifyTimer=setTimeout(ensureNotifySocket,3000)}}
function closeNotifySocket(){clearTimeout(notifyTimer);if(notifySocket){notifySocket.onclose=null;notifySocket.close();notifySocket=null}}
function activeSocket(){return socket&&socket.readyState===WebSocket.OPEN?socket:notifySocket&&notifySocket.readyState===WebSocket.OPEN?notifySocket:null}
function connectRoom(){if(!currentUser||!currentRoom?.canEnter){settleRoomLoader();return;}closeNotifySocket();const protocol=location.protocol==="https:"?"wss:":"ws:",tokenPart=authToken?`&token=${encodeURIComponent(authToken)}`:"";socket=new WebSocket(`${protocol}//${location.host}?room=${encodeURIComponent(currentRoom.id)}${tokenPart}`);socket.onopen=()=>refreshRoomsList();socket.onmessage=({data})=>{const event=JSON.parse(data);handleSocketEvent(event)};socket.onclose=()=>{if(groupCall)leaveRoomCall(true);if(currentUser&&currentRoom?.canEnter){clearTimeout(reconnectTimer);reconnectTimer=setTimeout(connectRoom,1800)}}}
async function refreshRoomAccess(roomId){try{const previous=currentRoom;await loadRooms();if(!$("#roomsView").hidden)renderRoomsGrid();const room=rooms.find(item=>item.id===roomId);if(!room)return;if(currentRoom?.id===roomId){if(room.canEnter!==currentRoom.canEnter){if(room.canEnter)toast("You can now enter "+room.name);selectRoom(room)}else if(previous&&previous.requestStatus==="pending"&&room.requestStatus!=="pending"&&!room.canEnter){currentRoom=room;stopRequestPoll();const button=$("#requestAccess");button.disabled=false;button.textContent="Request to join";toast("The room creator declined your request")}else{currentRoom=room;$("#requestCount").textContent=room.pendingCount||0;if(room.requestStatus==="pending")startRequestPoll()}}else if(room.canEnter&&!room.isOwner&&room.access==="request"&&!room.builtIn)toast("You can now enter "+room.name)}catch{}}
function updatePresence(users,count){$("#onlineCount").textContent=count;onlineUsers=users||[];refreshMessageAvatars();if(!$("#onlineModal").hidden)renderOnlineList()}
const usernamePalette=["#e11d48","#d97706","#059669","#0284c7","#7c3aed","#db2777","#ea580c","#0d9488","#4f46e5","#b45309","#65a30d","#c026d3"];
function usernameColor(username){const value=String(username||"").trim();return usernamePalette[value.length%usernamePalette.length]}
function colorUsername(element,username){if(element)element.style.color=usernameColor(username);return element}
function setAvatar(element,person){element.textContent="";const source=person||{},profile=source.profile||{},photo=source.photo||profile.photo;if(photo){const image=document.createElement("img");image.src=photo;image.alt="";element.appendChild(image)}else element.textContent=profile.avatar||source.avatar||initials(source.username||"?")}
function livePhotoFor(message){if(currentUser&&message.userId===currentUser.id)return (currentUser.profile&&currentUser.profile.photo)||null;const person=[...onlineUsers,...allUsers].find(item=>item.id===message.userId);return (person&&person.profile&&person.profile.photo)||message.photo||null}
function refreshMessageAvatars(){document.querySelectorAll("#messageList .message").forEach(article=>{const userId=article.dataset.userId;if(!userId)return;const person=[...onlineUsers,...allUsers].find(item=>item.id===userId),avatar=article.querySelector(".msg-avatar");if(!person||!avatar)return;const photo=(person.profile&&person.profile.photo)||article.dataset.photo||"",hasImage=Boolean(avatar.querySelector("img"));if(photo&&!hasImage)setAvatar(avatar,{photo,username:person.username});else if(!photo&&hasImage)setAvatar(avatar,{username:person.username})})}
function renderMessages(messages){const list=$("#messageList");list.innerHTML="";if(!messages.length){list.innerHTML='<div class="empty"><div><span>✦</span><h3>The room is quiet</h3><p>Start the first conversation.</p></div></div>';return}messages.forEach(appendMessage);list.scrollTop=list.scrollHeight}
/* --------------------------------------------------------- message actions */

function compactWith(previous,message){
  const sender=message.userId||message.username||"",createdAt=Number(message.createdAt)||Date.now();
  return Boolean(previous&&previous.classList.contains("message")&&previous.dataset.sender===sender&&createdAt-Number(previous.dataset.createdAt)<300000&&createdAt>=Number(previous.dataset.createdAt));
}
function messageSnippet(message){
  const kind=message&&message.kind||"text";
  if(kind==="image")return "\uD83D\uDCF7 Photo";
  if(kind==="voice")return "\uD83C\uDF99 Voice note";
  if(kind==="gif")return "GIF";
  return String(message&&message.content||"").replace(/\s+/g," ").trim().slice(0,120);
}
function canDeleteMessage(message){
  if(!currentUser||!message||message.deleted)return false;
  if(message.userId&&message.userId===currentUser.id)return true;
  return canModerateRoom();
}
function messageById(messageId){return liveMessages.find(message=>message.id===messageId)||null}
function closeMessageTools(except){
  document.querySelectorAll("#messageList .message.tools-open").forEach(article=>{
    if(article===except)return;
    article.classList.remove("tools-open");
    article.querySelector(".reaction-picker")?.remove();
  });
}
function toggleMessageTools(article){
  const open=article.classList.contains("tools-open");
  closeMessageTools(article);
  article.classList.toggle("tools-open",!open);
  if(open)article.querySelector(".reaction-picker")?.remove();
}
function articleFor(messageId){
  const id=String(messageId||"");
  if(!id)return null;
  return document.querySelector(`#messageList .message[data-message-id="${window.CSS&&CSS.escape?CSS.escape(id):id.replace(/[^a-zA-Z0-9_-]/g,"")}"]`);
}
function renderReactionChips(row,reactions){
  row.innerHTML="";
  const mine=currentUser?currentUser.id:"";
  Object.entries(reactions||{}).forEach(([emoji,users])=>{
    const list=Array.isArray(users)?users:[];
    if(!list.length)return;
    const chip=document.createElement("button");
    chip.type="button";
    chip.className="reaction-chip"+(mine&&list.includes(mine)?" mine":"");
    chip.title=(mine&&list.includes(mine)?"Remove your reaction ":"React with ")+emoji;
    const face=document.createElement("span"),count=document.createElement("b");
    face.textContent=emoji;
    count.textContent=String(list.length);
    chip.append(face,count);
    chip.onclick=()=>toggleReaction(row,emoji);
    row.appendChild(chip);
  });
  row.hidden=!row.children.length;
}
function toggleReaction(row,emoji){
  const messageId=row&&row.dataset.messageId;
  if(!messageId)return;
  if(!socket||socket.readyState!==WebSocket.OPEN)return toast("Reconnecting to this room…");
  socket.send(JSON.stringify({type:"react",messageId,emoji}));
}
function applyMessageReactions(messageId,reactions){
  const message=messageById(messageId);
  if(message)message.reactions=reactions;
  const row=articleFor(messageId)&&articleFor(messageId).querySelector(".msg-reactions");
  if(row)renderReactionChips(row,reactions);
}
function markMessageDeleted(messageId){
  const message=messageById(messageId);
  if(!message)return;
  message.deleted=true;
  message.content="";
  message.reactions={};
  const article=articleFor(messageId);
  if(article)article.replaceWith(buildMessage(message,article.classList.contains("compact")));
}
function reactionPicker(tools){
  const article=tools.closest(".message");
  if(!article)return;
  const open=article.querySelector(".reaction-picker");
  if(open){open.remove();return}
  const picker=document.createElement("div");
  picker.className="reaction-picker";
  REACTIONS.forEach(emoji=>{
    const button=document.createElement("button");
    button.type="button";
    button.textContent=emoji;
    button.title="React with "+emoji;
    button.onclick=()=>{
      picker.remove();
      closeMessageTools();
      const row=article.querySelector(".msg-reactions");
      if(row)toggleReaction(row,emoji);
    };
    picker.appendChild(button);
  });
  article.querySelector(".msg-body").appendChild(picker);
}
function messageTools(message){
  const tools=document.createElement("div");
  tools.className="msg-tools";
  const tool=(icon,label,title,onClick,extra)=>{
    const button=document.createElement("button");
    button.type="button";
    button.className="msg-tool"+(extra?" "+extra:"");
    button.title=title;
    button.setAttribute("aria-label",title);
    const face=document.createElement("span");
    face.className="msg-tool-icon";
    face.setAttribute("aria-hidden","true");
    face.textContent=icon;
    button.append(face,document.createTextNode(label));
    button.onclick=onClick;
    return button;
  };
  tools.appendChild(tool("\u21A9","Reply","Reply",()=>{closeMessageTools();useReply(message)}));
  if(!message.deleted)tools.appendChild(tool("\u263A","React","Add a reaction",()=>reactionPicker(tools)));
  if(canDeleteMessage(message))tools.appendChild(tool("\uD83D\uDDD1","Delete","Delete for everyone",()=>{closeMessageTools();askDeleteMessage(message)},"danger"));
  return tools;
}
function replyQuote(reply){
  const quote=document.createElement("button");
  quote.type="button";
  quote.className="msg-quote";
  const name=document.createElement("b"),text=document.createElement("span");
  name.textContent=reply.username||"Member";
  text.textContent=reply.snippet||"Message";
  quote.append(name,text);
  quote.title="Jump to the replied message";
  quote.onclick=()=>{
    const parent=articleFor(reply.id);
    if(!parent)return toast("That message is no longer in the room.");
    parent.scrollIntoView({block:"center",behavior:"smooth"});
    parent.classList.add("flash");
    setTimeout(()=>parent.classList.remove("flash"),1200);
  };
  return quote;
}
function buildMessage(message,compact){
  const mine=Boolean(currentUser&&message.userId===currentUser.id),sender=message.userId||message.username||"",createdAt=Number(message.createdAt)||Date.now();
  const article=document.createElement("article");
  article.className=`message${mine?" me":""}${compact?" compact":""}${message.deleted?" deleted":""}`;
  article.dataset.messageId=message.id||"";
  article.dataset.userId=message.userId||"";
  article.dataset.sender=sender;
  article.dataset.createdAt=String(createdAt);
  article.dataset.photo=message.photo||"";
  article.innerHTML='<span class="msg-avatar"></span><div class="msg-body"><div class="msg-meta"><b></b><time></time></div><div class="bubble"></div></div>';
  article.querySelector("time").textContent=new Intl.DateTimeFormat([],{hour:"numeric",minute:"2-digit"}).format(new Date(createdAt));
  setAvatar(article.querySelector(".msg-avatar"),{photo:livePhotoFor(message),username:message.username});
  const name=article.querySelector(".msg-meta b");
  name.textContent=message.username;
  colorUsername(name,message.username);
  const roleTag=roleTagElement(message.role);
  if(roleTag)name.after(roleTag);
  const body=article.querySelector(".msg-body"),bubble=article.querySelector(".bubble"),kind=message.kind||"text";
  const quote=message.reply?replyQuote(message.reply):null;
  if(message.deleted){
    bubble.classList.add("deleted");
    const note=document.createElement("em");
    note.className="msg-deleted";
    note.textContent="Message deleted";
    bubble.appendChild(note);
  }else if(kind==="gif"||kind==="image"){
    bubble.classList.add(kind);
    const image=document.createElement("img");
    image.src=message.content;
    image.alt=kind==="gif"?"Shared GIF":"Shared image";
    image.loading="lazy";
    image.referrerPolicy="no-referrer";
    bubble.appendChild(image);
  }else if(kind==="voice"){
    bubble.classList.add("voice");
    bubble.appendChild(voicePlayer(message.content));
  }else{
    bubble.classList.add(kind);
    bubble.textContent=message.content??message.text;
  }
  // The quote goes in last: setting textContent for a plain message replaces every child, quote included.
  if(quote)bubble.insertBefore(quote,bubble.firstChild);
  const reactions=document.createElement("div");
  reactions.className="msg-reactions";
  reactions.dataset.messageId=message.id||"";
  renderReactionChips(reactions,message.reactions||{});
  body.appendChild(reactions);
  // The actions get their own row under the message: the meta row is hidden on grouped messages, so
  // anything living there could never be opened on a user's second consecutive line.
  body.appendChild(messageTools(message));
  // The whole row is the target: avatar, name, bubble and timestamp all toggle the actions. Media
  // controls and the row's own buttons are excluded so playing a voice note or quoting a message
  // cannot also open the toolbar.
  article.addEventListener("click",event=>{
    if(event.target.closest("audio,video,button,a,input,select,textarea,label"))return;
    toggleMessageTools(article);
  });
  return article;
}
function useReply(message){
  if(!message||message.deleted)return toast("You cannot reply to a deleted message.");
  setReplyTarget(message);
  $("#chatInput").focus();
}
function setReplyTarget(message){
  replyTarget=message||null;
  const bar=$("#replyBar");
  if(!bar)return;
  bar.hidden=!replyTarget;
  if(!replyTarget){
    if(currentRoom)$("#chatInput").placeholder=`Message ${currentRoom.name}…`;
    return;
  }
  const quote=$("#replyBarText"),name=document.createElement("b"),text=document.createElement("span");
  name.textContent=(replyTarget.username||"Member")+" ";
  text.textContent=messageSnippet(replyTarget)||"Message";
  quote.textContent="";
  quote.append(name,text);
  if(currentRoom&&!currentRoom.banned)$("#chatInput").placeholder="Reply to "+(replyTarget.username||"this message")+"…";
}
function askDeleteMessage(message){
  const mine=Boolean(currentUser&&message.userId===currentUser.id);
  openConfirm(mine?"Delete your message?":"Delete this message for everyone?",mine?"It will be removed for everybody in the room.":"This message was posted by another member and will be removed for everybody in the room.",()=>deleteMessage(message));
}
function deleteMessage(message){
  if(!socket||socket.readyState!==WebSocket.OPEN)return toast("Reconnecting to this room…");
  socket.send(JSON.stringify({type:"delete-message",messageId:message.id}));
}
$("#replyCancel").onclick=()=>{setReplyTarget(null);$("#chatInput").focus()};


function appendMessage(message){const list=$("#messageList");list.querySelector(".empty")?.remove();list.appendChild(buildMessage(message,compactWith(list.lastElementChild,message)));while(list.querySelectorAll(".message").length>100)list.querySelector(".message").remove();list.scrollTop=list.scrollHeight}
function send(kind,content){if(socket?.readyState!==WebSocket.OPEN)return toast("Reconnecting to this room…");const payload={type:"message",kind,content};if(replyTarget&&kind==="text")payload.replyTo=replyTarget.id;socket.send(JSON.stringify(payload));if(kind==="text")setReplyTarget(null);closePicker()}
$("#chatForm").onsubmit=event=>{event.preventDefault();const input=$("#chatInput"),text=input.value.trim();if(!text)return;send("text",text);input.value="";input.style.height="auto"};
$("#chatInput").oninput=event=>{event.target.style.height="auto";event.target.style.height=`${Math.min(event.target.scrollHeight,110)}px`};$("#chatInput").onkeydown=event=>{if(event.key==="Enter"&&!event.shiftKey){event.preventDefault();$("#chatForm").requestSubmit()}};
function closePicker(){activeTool=null;$("#mediaPanel").hidden=true;document.querySelectorAll("[data-tool]").forEach(b=>b.classList.remove("active"))}
document.querySelectorAll("[data-tool]").forEach(button=>button.onclick=()=>{const tool=button.dataset.tool;if(activeTool===tool)return closePicker();activeTool=tool;document.querySelectorAll("[data-tool]").forEach(b=>b.classList.toggle("active",b===button));const panel=$("#mediaPanel");panel.hidden=false;if(tool==="emoji")showEmoji();if(tool==="sticker")showStickers();if(tool==="gif")showGif()});
function showEmoji(){const panel=$("#mediaPanel");panel.innerHTML='<div class="picker-grid emoji"></div>';currentRoom.emojis.forEach(item=>{const button=document.createElement("button");button.textContent=item;button.onclick=()=>send("emoji",item);panel.firstChild.appendChild(button)})}
function showStickers(){const panel=$("#mediaPanel");panel.innerHTML='<div class="picker-grid sticker"></div>';currentRoom.stickers.forEach(item=>{const button=document.createElement("button");button.textContent=item;button.onclick=()=>send("sticker",item);panel.firstChild.appendChild(button)})}
function showGif(){const panel=$("#mediaPanel");panel.innerHTML='<div class="picker-grid gif"></div><p class="gif-note">Tap a GIF to send it</p>';const grid=panel.firstChild;(currentRoom.gifs||[]).forEach(url=>{const button=document.createElement("button"),image=document.createElement("img");image.src=url;image.alt=currentRoom.name+" GIF";image.loading="lazy";button.appendChild(image);button.onclick=()=>send("gif",url);grid.appendChild(button)})}
$("#requestAccess").onclick=async()=>{try{await request(`/api/rooms/${encodeURIComponent(currentRoom.id)}/request`,{method:"POST",body:"{}"});currentRoom.requestStatus="pending";$("#requestAccess").disabled=true;$("#requestAccess").textContent="Request pending";startRequestPoll();if(!$("#roomsView").hidden)renderRoomsGrid();toast("Request sent to the room creator")}catch(e){toast(e.message)}};
function openCreate(){error("#createError","");$("#createModal").hidden=false}document.querySelector("[data-close]").onclick=()=>$("#createModal").hidden=true;
$("#createForm").onsubmit=async event=>{event.preventDefault();const form=event.currentTarget,data=new FormData(form),name=String(data.get("name")||"").trim(),vibe=String(data.get("vibe")||"").trim();error("#createError","");if(!name)return error("#createError","Give your room a name.");if(name.length<3)return error("#createError","Room name needs at least 3 characters.");if(vibe&&vibe.length<3)return error("#createError","Short vibe needs at least 3 characters.");busy(form,true);try{const result=await request("/api/rooms",{method:"POST",body:JSON.stringify({name,vibe,access:data.get("access"),theme:data.get("theme")})});rooms=rooms.filter(item=>item.id!==result.room.id);rooms.push(result.room);$("#createModal").hidden=true;form.reset();selectRoom(result.room);toast("Your room is live") }catch(e){error("#createError",e.message)}finally{busy(form,false)}};
$("#createForm").elements.name.addEventListener("input",event=>{const value=String(event.target.value||"").trim();if(value.length>0&&value.length<3)error("#createError","Keep going — room name needs at least 3 characters.");else if(value.length>=3)error("#createError","")});
$("#createForm").elements.vibe.addEventListener("input",event=>{const value=String(event.target.value||"").trim();if(value.length>0&&value.length<3)error("#createError","Keep going — short vibe needs at least 3 characters.");else if(value.length>=3||!value)error("#createError","")});
$("#requestsButton").onclick=async()=>{const modal=$("#requestsModal"),list=$("#requestList");modal.hidden=false;list.innerHTML="Loading…";try{const result=await request(`/api/rooms/${encodeURIComponent(currentRoom.id)}/requests`);list.innerHTML=result.requests.length?"":'<p class="fineprint">No pending requests.</p>';result.requests.forEach(user=>{const row=document.createElement("div");row.className="request-person";row.innerHTML=`<span class="avatar"></span><b></b><button class="approve">Approve</button><button class="decline">Decline</button>`;row.querySelector(".avatar").textContent=initials(user.username);setAvatar(row.querySelector(".avatar"),user);row.querySelector("b").textContent=user.username;row.querySelector(".approve").onclick=()=>manageRequest(user.id,"approve",row);row.querySelector(".decline").onclick=()=>manageRequest(user.id,"decline",row);list.appendChild(row)})}catch(e){list.textContent=e.message}};document.querySelector("[data-close-requests]").onclick=()=>$("#requestsModal").hidden=true;
async function manageRequest(userId,action,row){try{await request(`/api/rooms/${encodeURIComponent(currentRoom.id)}/requests/${encodeURIComponent(userId)}`,{method:"POST",body:JSON.stringify({action})});row.remove();currentRoom.pendingCount=Math.max(0,(currentRoom.pendingCount||0)-1);$("#requestCount").textContent=currentRoom.pendingCount}catch(e){toast(e.message)}}
function roomPath(id){return `/room/${encodeURIComponent(id)}`}
function markActiveNav(action){document.querySelectorAll("[data-action]").forEach(button=>button.classList.toggle("active",button.dataset.action===action))}
function showRoomsPage(mode){stopRequestPoll();stopViewPolls();const path="/rooms";if(mode==="push"&&location.pathname!==path)history.pushState({},"",path);else if(mode==="replace"&&location.pathname!==path)history.replaceState({},"",path);hideAllViews();markActiveNav("rooms");$("#roomsView").hidden=false;renderRoomsGrid();renderNotice();loadNotice();startRoomsPoll();loadRooms().then(()=>{if(!$("#roomsView").hidden)renderRoomsGrid()}).catch(()=>{})}
function showDmsPage(mode){stopViewPolls();const path="/dms";if(mode==="push"&&location.pathname!==path)history.pushState({},"",path);else if(mode==="replace"&&location.pathname!==path)history.replaceState({},"",path);hideAllViews();markActiveNav("dms");$("#dmsView").hidden=false;startDmsPoll()}
function hideAllViews(){hideRoomLoader(true);$("#chatPanel").hidden=true;$("#roomsView").hidden=true;$("#dmsView").hidden=true;$("#exploreView").hidden=true;$("#profileView").hidden=true}
function showExplorePage(mode){stopViewPolls();stopRequestPoll();const path="/explore";if(mode==="push"&&location.pathname!==path)history.pushState({},"",path);else if(mode==="replace"&&location.pathname!==path)history.replaceState({},"",path);hideAllViews();markActiveNav("explore");$("#exploreView").hidden=false;renderExplore(true)}
async function showProfilePage(username,mode){stopViewPolls();stopRequestPoll();let profile=null;try{profile=(await request(`/api/profiles/${encodeURIComponent(username)}`)).profile}catch(problem){toast(problem.message);showExplorePage("push");return}profileTarget=profile;const path=`/profile/${encodeURIComponent(profile.username)}`;if(mode==="push"&&location.pathname!==path)history.pushState({},"",path);else if(mode==="replace"&&location.pathname!==path)history.replaceState({},"",path);hideAllViews();markActiveNav("explore");$("#profileView").hidden=false;renderProfilePage(profile)}
async function renderExplore(reset){const grid=$("#exploreGrid");if(reset){exploreProfiles=[];exploreCursor=null;grid.innerHTML='<p class="dm-inbox-empty">Loading profiles…</p>'}try{const params=new URLSearchParams({limit:"24"});if(exploreQuery)params.set("q",exploreQuery);if(!reset&&exploreCursor)params.set("cursor",String(exploreCursor));const result=await request(`/api/explore?${params.toString()}`);exploreProfiles=reset?result.profiles||[]:exploreProfiles.concat(result.profiles||[]);exploreCursor=result.nextCursor||null;renderExploreCards();$("#exploreMore").hidden=!exploreCursor}catch(problem){if(reset)grid.innerHTML='<p class="dm-inbox-empty">Could not load profiles.</p>';toast(problem.message)}}
function renderExploreCards(){const grid=$("#exploreGrid");grid.innerHTML="";if(!exploreProfiles.length){grid.innerHTML='<p class="dm-inbox-empty">No profiles found.</p>';return}exploreProfiles.forEach(person=>{const card=document.createElement("button");card.type="button";card.className="explore-card";card.innerHTML='<span class="avatar"></span><span class="explore-info"><span class="explore-name"></span><span class="explore-meta"></span><span class="explore-bio"></span><span class="explore-photos"></span></span>';setAvatar(card.querySelector(".avatar"),person);if(person.online){const dot=document.createElement("span");dot.className="presence-dot";card.querySelector(".avatar").appendChild(dot)}const name=card.querySelector(".explore-name");name.textContent=person.displayName||person.username;colorUsername(name,person.username);const tag=roleTagElement(person.role);if(tag)name.appendChild(tag);card.querySelector(".explore-meta").textContent=`@${person.username}${person.age?" · "+person.age+" yrs":""}`;card.querySelector(".explore-bio").textContent=person.bio||"No bio yet.";const photoCount=(person.photos||[]).length;card.querySelector(".explore-photos").textContent=photoCount?photoCount+(photoCount===1?" photo":" photos"):"";card.onclick=()=>showProfilePage(person.username,"push");grid.appendChild(card)})}
function renderProfileGallery(photos){const gallery=$("#profileGallery");if(!gallery)return;gallery.innerHTML="";if(!photos.length){gallery.innerHTML='<div class="gallery-empty">No photos yet.</div>';return}const main=document.createElement("img");main.className="gallery-main";main.src=photos[0];main.alt="Profile photo";gallery.appendChild(main);if(photos.length>1){const thumbs=document.createElement("div");thumbs.className="gallery-thumbs";photos.forEach((url,index)=>{const thumb=document.createElement("img");thumb.src=url;thumb.alt="";if(index===0)thumb.classList.add("active");thumb.onclick=()=>{main.src=url;thumbs.querySelectorAll("img").forEach(item=>item.classList.remove("active"));thumb.classList.add("active")};thumbs.appendChild(thumb)});gallery.appendChild(thumbs)}}
function renderProfilePage(profile){const body=$("#profileBody");body.innerHTML='<div class="profile-gallery" id="profileGallery"></div><div class="profile-details"><div class="profile-head"><span class="avatar" id="profilePageAvatar"></span><div><b id="profilePageDisplay"></b><small id="profilePageHandle"></small></div></div><div class="user-meta" id="profilePageMeta"></div><p class="user-bio" id="profilePageBio"></p><div class="profile-actions" id="profilePageActions"></div></div>';const avatar=$("#profilePageAvatar");setAvatar(avatar,profile);if(profile.online){const dot=document.createElement("span");dot.className="presence-dot";avatar.appendChild(dot)}const display=$("#profilePageDisplay");display.textContent=profile.displayName||profile.username;colorUsername(display,profile.username);const tag=roleTagElement(profile.role);if(tag)display.appendChild(tag);$("#profilePageHandle").textContent="@"+profile.username;const meta=$("#profilePageMeta"),info=[];if(profile.age)info.push(profile.age+" years");if(profile.gender)info.push(profile.gender==="prefer_not"?"prefers not to say":profile.gender);(profile.interests||[]).forEach(item=>info.push(item));info.forEach(item=>{const chip=document.createElement("span");chip.textContent=item;meta.appendChild(chip)});$("#profilePageBio").textContent=profile.bio||"No bio yet.";renderProfileGallery(profile.photos||[]);const actions=$("#profilePageActions");if(profile.isSelf){const edit=document.createElement("button");edit.type="button";edit.className="primary";edit.textContent="Edit profile";edit.onclick=openProfile;actions.appendChild(edit)}else{const message=document.createElement("button");message.type="button";message.className="primary";message.textContent="Message";message.onclick=()=>openDm(profile);actions.appendChild(message);const hide=document.createElement("button");hide.type="button";hide.className="secondary";hide.textContent=hiddenUsers.has(profile.id)?"Show messages":"Hide messages";hide.onclick=()=>{toggleUserHidden(profile);hide.textContent=hiddenUsers.has(profile.id)?"Show messages":"Hide messages"};actions.appendChild(hide)}}
function renderPhotoManager(){const manager=$("#photoManager");if(!manager)return;const photos=(currentUser&&currentUser.profile&&currentUser.profile.photos)||[];manager.innerHTML="";if(!photos.length){manager.innerHTML='<p class="dm-inbox-empty">No photos yet.</p>';return}photos.forEach(url=>{const cell=document.createElement("div");cell.className="photo-cell";const image=document.createElement("img");image.src=url;image.alt="";cell.appendChild(image);const remove=document.createElement("button");remove.type="button";remove.textContent="×";remove.title="Remove photo";remove.onclick=async()=>{try{const result=await request("/api/profile/photos/remove",{method:"POST",body:JSON.stringify({url})});if(currentUser)currentUser.profile={...(currentUser.profile||{}),photos:result.photos};renderPhotoManager();toast("Photo removed")}catch(problem){toast(problem.message)}};cell.appendChild(remove);manager.appendChild(cell)})}
$("#photoAdd").onclick=()=>$("#photoAddInput").click();
$("#photoAddInput").onchange=async event=>{const file=event.target.files[0];event.target.value="";if(!file)return;try{const url=await uploadFile("image",file);const result=await request("/api/profile/photos",{method:"POST",body:JSON.stringify({url})});if(currentUser)currentUser.profile={...(currentUser.profile||{}),photos:result.photos};renderPhotoManager();toast("Photo added to your gallery")}catch(problem){toast(problem.message)}};
$("#exploreSearch").oninput=event=>{exploreQuery=event.target.value.trim();clearTimeout(exploreSearchTimer);exploreSearchTimer=setTimeout(()=>renderExplore(true),350)};
$("#exploreMore").onclick=()=>renderExplore(false);
$("#profileBack").onclick=()=>showExplorePage("push");
function roomPreviewText(message){const kind=message?.kind||"text";if(kind==="image")return "📷 Photo";if(kind==="voice")return "🎙 Voice note";if(kind==="gif")return "GIF";return String(message?.content||"").replace(/\s+/g," ").trim()}
function renderRoomsGrid(){const grid=$("#roomsGrid");grid.innerHTML="";rooms.forEach(room=>{const card=document.createElement("div");card.className=`room-card ${currentRoom?.id===room.id?"active":""}`;card.dataset.roomId=room.id;card.style.setProperty("--room-accent",room.accent);card.style.setProperty("--soft",room.soft);card.innerHTML='<div class="rc-head"><span class="rc-icon"></span><span class="rc-title"><strong></strong><small></small></span><span class="rc-side"><span class="rc-online"><i></i><span class="rc-online-count"></span></span><span class="rc-badge"></span></span></div><div class="rc-preview"></div>';card.querySelector(".rc-icon").textContent=room.icon;card.querySelector("strong").textContent=room.name;card.querySelector(".rc-title small").textContent=room.access==="request"?"Private room":"Open room";const badge=card.querySelector(".rc-badge"),pendingCount=Number(room.pendingCount)||0;if(room.isOwner&&pendingCount>0){badge.textContent=pendingCount===1?"1 request":pendingCount+" requests";badge.classList.add("pending")}else if(room.access==="request")badge.textContent="Request";const onlineCount=Number(room.online)||0;card.querySelector(".rc-online-count").textContent=onlineCount;if(onlineCount>0)card.querySelector(".rc-online").classList.add("on");if(canDeleteRoom(room)){const remove=document.createElement("button");remove.type="button";remove.className="rc-delete";remove.textContent="Delete";remove.onclick=event=>{event.stopPropagation();askDeleteRoom(room)};card.querySelector(".rc-side").appendChild(remove)}const preview=card.querySelector(".rc-preview"),messages=Array.isArray(room.preview)?room.preview.slice(-3):[];if(room.access==="request"){preview.remove();card.classList.add("no-preview")}else if(!room.canEnter){preview.classList.add("empty");preview.textContent="🔒 Join to see recent messages"}else if(!messages.length){preview.classList.add("empty");preview.textContent="No messages yet — start the conversation"}else messages.forEach(message=>{const line=document.createElement("div");line.className="rc-preview-line";const name=document.createElement("b"),copy=document.createElement("span");name.textContent=(message.username||"Member")+":";copy.textContent=roomPreviewText(message);line.title=name.textContent+" "+copy.textContent;line.append(name,copy);preview.appendChild(line)});card.onclick=()=>selectRoom(room,"push");grid.appendChild(card)});const create=document.createElement("button");create.className="room-card create";create.innerHTML="<strong>＋ Create your own room</strong><small>Open or request-only</small>";create.onclick=openCreate;grid.appendChild(create)}
function canDeleteRoom(room){return Boolean(currentUser&&(room.isOwner||currentUser.role==="admin"))&&!room.builtIn}
let confirmAction=null;
function openConfirm(title,text,action){$("#confirmTitle").textContent=title;$("#confirmText").textContent=text;confirmAction=action;$("#confirmModal").hidden=false}
$("#confirmCancel").onclick=()=>{confirmAction=null;$("#confirmModal").hidden=true};
$("#confirmOk").onclick=async()=>{const action=confirmAction;confirmAction=null;$("#confirmModal").hidden=true;if(action)await action()};
function askDeleteRoom(room){openConfirm("Delete this room?","“"+room.name+"” and its messages will be removed for everyone. This cannot be undone.",()=>deleteRoom(room))}
async function deleteRoom(room){try{await request(`/api/rooms/${encodeURIComponent(room.id)}`,{method:"DELETE"});rooms=rooms.filter(item=>item.id!==room.id);if(currentRoom&&currentRoom.id===room.id){currentRoom=null;if(socket){socket.onclose=null;socket.close();socket=null}showRoomsPage("none")}else renderRoomsGrid();toast("Room deleted")}catch(problem){toast(problem.message)}}
function route(mode){if(location.pathname==="/rooms")return showRoomsPage("none");if(location.pathname==="/dms"){prepareDmsPage();return showDmsPage("none")}if(location.pathname==="/explore")return showExplorePage("none");if(location.pathname.startsWith("/profile/")){let name=null;try{name=decodeURIComponent(location.pathname.slice(9))}catch{}if(name)return showProfilePage(name,"none");return showExplorePage("none")}if(location.pathname==="/")return showRoomsPage(mode==="initial"?"replace":"none");let id=null;if(location.pathname.startsWith("/room/")){try{id=decodeURIComponent(location.pathname.slice(6))}catch{}}const room=rooms.find(item=>item.id===id);if(room)selectRoom(room,mode==="initial"?"replace":"none");else showRoomsPage("none")}
window.addEventListener("popstate",()=>route("pop"));
$("#roomsView .top-actions").innerHTML=$("#chatPanel .top-actions").innerHTML;
$("#dmsView .top-actions").innerHTML=$("#chatPanel .top-actions").innerHTML;
$("#exploreView .top-actions").innerHTML=$("#chatPanel .top-actions").innerHTML;
$("#profileView .top-actions").innerHTML=$("#chatPanel .top-actions").innerHTML;
document.querySelectorAll("[data-action]").forEach(button=>button.onclick=()=>{const action=button.dataset.action;if(action==="explore")showExplorePage("push");if(action==="profile")openProfile();if(action==="rooms")showRoomsPage("push");if(action==="dms")openDmInbox();if(action==="menu")toggleMenu(button)});
function toggleMenu(button){const drop=$("#menuDrop");if(!drop.hidden){drop.hidden=true;return}drop.querySelector('[data-menu="admin"]').hidden=!(currentUser&&currentUser.role==="admin");const rect=button.getBoundingClientRect();drop.style.top=`${Math.round(rect.bottom+8)}px`;drop.style.right=`${Math.round(Math.max(12,window.innerWidth-rect.right))}px`;drop.hidden=false}
document.addEventListener("click",event=>{if(!event.target.closest("#menuDrop")&&!event.target.closest("[data-action=menu]"))$("#menuDrop").hidden=true;if(!event.target.closest("#mediaPanel")&&!event.target.closest("[data-tool]"))closePicker()});
// A message row stays open until it is tapped again, another row is tapped, or the tap lands
// somewhere else entirely.
document.addEventListener("click",event=>{if(!event.target.closest("#messageList .message"))closeMessageTools()});
document.addEventListener("keydown",event=>{if(event.key==="Escape")closeMessageTools()});
async function doLogout(){try{await request("/api/auth/logout",{method:"POST",body:"{}"})}finally{forgetToken();forgetProfileKey();leaveApp()}}
$("#menuDrop").querySelector('[data-menu="logout"]').onclick=doLogout;
$("#menuDrop").querySelector('[data-menu="profile"]').onclick=()=>{$("#menuDrop").hidden=true;openProfile()};
$("#menuDrop").querySelector('[data-menu="admin"]').onclick=()=>{$("#menuDrop").hidden=true;openAdminPanel()};
document.querySelector("[data-close-admin]").onclick=()=>$("#adminModal").hidden=true;
$("#menuDrop").querySelector('[data-menu="key"]').onclick=()=>{$("#menuDrop").hidden=true;const key=pendingProfileKey;$("#keyModalValue").textContent=key||"No profile key is stored in this browser.";$("#copyKeyModal").disabled=!key;$("#keyModal").hidden=false};
$("#copyKeyModal").onclick=async()=>{try{await navigator.clipboard.writeText($("#keyModalValue").textContent);toast("Profile key copied")}catch{toast("Select the key and copy it manually")}};
function renderProfilePhoto(){setAvatar($("#profileAvatar"),{photo:profilePhoto,profile:currentUser?.profile||{},username:currentUser?.username||"?"});$("#photoRemove").hidden=!profilePhoto}
function openProfile(){if(!currentUser)return toast("Join the chatrooms first");const profile=currentUser.profile||{},form=$("#profileModalForm");profilePhoto=profile.photo||"";renderProfilePhoto();renderPhotoManager();$("#profileName").textContent=profile.displayName||currentUser.username;$("#profileHandle").textContent=`@${currentUser.username}`;form.elements.displayName.value=profile.displayName||"";form.elements.bio.value=profile.bio||"";form.elements.gender.value=profile.gender||"";form.elements.interests.value=(profile.interests||[]).join(", ");const avatar=form.querySelector(`[name=avatar][value="${profile.avatar||"✨"}"]`);if(avatar)avatar.checked=true;error("#profileModalError","");$("#profileModal").hidden=false}
$("#profileModalForm").onsubmit=async event=>{event.preventDefault();const form=event.currentTarget,data=new FormData(form);busy(form,true);error("#profileModalError","");try{const result=await request("/api/profile",{method:"POST",body:JSON.stringify({displayName:data.get("displayName"),avatar:data.get("avatar"),bio:data.get("bio"),gender:data.get("gender"),interests:data.get("interests"),photo:profilePhoto})});currentUser=result.user;if(allUsers.some(item=>item.id===result.user.id))allUsers=allUsers.map(item=>item.id===result.user.id?result.user:item);$("#profileModal").hidden=true;toast("Profile saved");loadUsers()}catch(problem){error("#profileModalError",problem.message)}finally{busy(form,false)}};
$("#photoUpload").onclick=()=>$("#photoInput").click();
async function setProfilePicture(url){const result=await request("/api/profile/photo",{method:"POST",body:JSON.stringify({url})});currentUser=result.user;profilePhoto=(currentUser.profile&&currentUser.profile.photo)||"";renderProfilePhoto();refreshMessageAvatars();loadUsers();toast(url?"Profile picture updated":"Profile picture removed")}
$("#photoInput").onchange=async event=>{const file=event.target.files[0];event.target.value="";if(!file)return;try{const url=await uploadFile("image",file);await setProfilePicture(url)}catch(problem){toast(problem.message)}};
$("#photoRemove").onclick=async()=>{try{await setProfilePicture("")}catch(problem){toast(problem.message)}};
document.querySelector("[data-close-profile]").onclick=()=>$("#profileModal").hidden=true;
document.querySelector("[data-close-key]").onclick=()=>$("#keyModal").hidden=true;
document.querySelector("[data-close-online]").onclick=()=>$("#onlineModal").hidden=true;
document.querySelector("[data-close-user]").onclick=()=>$("#userModal").hidden=true;
$("#onlineButton").onclick=()=>{renderOnlineList();$("#onlineModal").hidden=false;loadRoomBans()};
$("#peopleSearch").oninput=event=>{peopleQuery=event.target.value;renderPeopleList()};
function renderOnlineList(){const list=$("#onlineList");list.innerHTML="";if(!onlineUsers.length)list.innerHTML='<p class="dm-inbox-empty">Nobody else is here right now.</p>';onlineUsers.forEach(person=>{const row=document.createElement("div");row.className="online-person";const avatar=document.createElement("button");avatar.type="button";avatar.className="avatar";avatar.title="View profile";setAvatar(avatar,person);avatar.onclick=()=>openUserModal(person);const name=document.createElement("span");name.className="online-name";const title=document.createElement("b");title.textContent=(person.profile&&person.profile.displayName)||person.username;colorUsername(title,person.username);const roleTag=roleTagElement(person.role);if(roleTag)title.appendChild(roleTag);const subtitle=document.createElement("small");subtitle.textContent="@"+person.username;name.appendChild(title);name.appendChild(subtitle);row.appendChild(avatar);row.appendChild(name);if(!currentUser||person.id!==currentUser.id){const hide=document.createElement("button");hide.type="button";hide.textContent=hiddenUsers.has(person.id)?"Show":"Hide";hide.onclick=()=>toggleUserHidden(person);row.appendChild(hide);if(canModerateRoom()){const bannedHere=roomBans.some(item=>item.id===person.id);if(bannedHere||canBanPerson(person)){const ban=document.createElement("button");ban.type="button";ban.className=bannedHere?"":"online-ban";ban.textContent=bannedHere?"Unban":"Ban";ban.onclick=()=>bannedHere?unbanUser(person):banUser(person);row.appendChild(ban)}}const message=document.createElement("button");message.type="button";message.textContent="Message";message.onclick=()=>{$("#onlineModal").hidden=true;openDm(person)};row.appendChild(message)}list.appendChild(row)})}
function updateDmBadges(){const total=[...dmUnread.values()].reduce((sum,count)=>sum+count,0);document.querySelectorAll("[data-action=dms]").forEach(button=>{let badge=button.querySelector(".icon-badge");if(!badge){badge=document.createElement("span");badge.className="icon-badge";button.appendChild(badge)}badge.textContent=total>99?"99+":String(total);badge.hidden=total===0})}
function roleTagElement(role){if(role!=="admin"&&role!=="mod")return null;const tag=document.createElement("span");tag.className="role-tag "+role;tag.textContent=role==="admin"?"ADMIN":"MOD";return tag}
function canModerateRoom(){return Boolean(currentUser&&currentRoom&&(currentUser.role==="admin"||currentUser.role==="mod"||currentRoom.isOwner))}
function canBanPerson(person){if(!currentUser||!person||person.id===currentUser.id)return false;if(person.role==="admin")return false;if(currentUser.role==="admin")return true;if(person.role==="mod")return false;if(currentUser.role==="mod")return true;return Boolean(currentRoom&&currentRoom.isOwner)}
async function loadRoomBans(){roomBans=[];if(!canModerateRoom()||!currentRoom){renderBannedList();return}try{roomBans=(await request(`/api/rooms/${encodeURIComponent(currentRoom.id)}/bans`)).users}catch{}renderBannedList()}
function renderBannedList(){const wrap=$("#bannedWrap"),list=$("#bannedList");if(!wrap)return;if(!canModerateRoom()||!roomBans.length){wrap.hidden=true;list.innerHTML="";return}wrap.hidden=false;list.innerHTML="";roomBans.forEach(person=>{const row=document.createElement("div");row.className="online-person";const avatar=document.createElement("span");avatar.className="avatar";setAvatar(avatar,person);const name=document.createElement("span");name.className="online-name";const title=document.createElement("b");title.textContent=(person.profile&&person.profile.displayName)||person.username;colorUsername(title,person.username);const tag=roleTagElement(person.role);if(tag)title.appendChild(tag);const subtitle=document.createElement("small");subtitle.textContent="@"+person.username;name.appendChild(title);name.appendChild(subtitle);row.appendChild(avatar);row.appendChild(name);const unban=document.createElement("button");unban.type="button";unban.textContent="Unban";unban.onclick=()=>unbanUser(person);row.appendChild(unban);list.appendChild(row)})}
async function banUser(person){if(!currentRoom)return;try{await request(`/api/rooms/${encodeURIComponent(currentRoom.id)}/bans/${encodeURIComponent(person.id)}`,{method:"POST",body:JSON.stringify({action:"ban"})});if(!roomBans.some(item=>item.id===person.id))roomBans.push(person);toast(`${person.username} can no longer message in this room`);renderBannedList();if(!$("#onlineModal").hidden)renderOnlineList();if(!$("#userModal").hidden)openUserModal(person)}catch(problem){toast(problem.message)}}
async function unbanUser(person){if(!currentRoom)return;try{await request(`/api/rooms/${encodeURIComponent(currentRoom.id)}/bans/${encodeURIComponent(person.id)}`,{method:"POST",body:JSON.stringify({action:"unban"})});roomBans=roomBans.filter(item=>item.id!==person.id);toast(`${person.username} can message again`);renderBannedList();if(!$("#onlineModal").hidden)renderOnlineList();if(!$("#userModal").hidden)openUserModal(person)}catch(problem){toast(problem.message)}}
let adminUsers=[];
async function openAdminPanel(){if(!currentUser||currentUser.role!=="admin")return;try{adminUsers=(await request("/api/admin/users")).users;$("#adminModal").hidden=false;renderAdminList()}catch(problem){toast(problem.message)}}
function renderAdminList(){const list=$("#adminList");list.innerHTML="";adminUsers.forEach(person=>{const row=document.createElement("div");row.className="online-person";const avatar=document.createElement("span");avatar.className="avatar";setAvatar(avatar,person);const name=document.createElement("span");name.className="online-name";const title=document.createElement("b");title.textContent=(person.profile&&person.profile.displayName)||person.username;colorUsername(title,person.username);const tag=roleTagElement(person.role);if(tag)title.appendChild(tag);const subtitle=document.createElement("small");subtitle.textContent="@"+person.username;name.appendChild(title);name.appendChild(subtitle);row.appendChild(avatar);row.appendChild(name);if(person.id!==currentUser.id&&person.role!=="admin"){const toggle=document.createElement("button");toggle.type="button";toggle.textContent=person.role==="mod"?"Remove mod":"Make mod";toggle.onclick=async()=>{try{const result=await request(`/api/admin/role/${encodeURIComponent(person.id)}`,{method:"POST",body:JSON.stringify({role:person.role==="mod"?"user":"mod"})});const index=adminUsers.findIndex(item=>item.id===person.id);if(index>=0)adminUsers[index]=result.user;renderAdminList();toast(result.user.role==="mod"?`${person.username} is now a mod`:`${person.username} is no longer a mod`)}catch(problem){toast(problem.message)}};const remove=document.createElement("button");remove.type="button";remove.className="danger";remove.textContent="Delete";remove.onclick=()=>askDeleteUser(person);row.appendChild(toggle);row.appendChild(remove)}list.appendChild(row)})}
function askDeleteUser(person){openConfirm("Delete this account?","@"+person.username+" and any rooms they created will be removed for everyone. This cannot be undone.",()=>deleteUser(person))}
async function deleteUser(person){try{const result=await request(`/api/admin/users/${encodeURIComponent(person.id)}`,{method:"DELETE"});adminUsers=adminUsers.filter(item=>item.id!==person.id);renderAdminList();toast("@"+person.username+" deleted"+(result.roomsDeleted?` — ${result.roomsDeleted} room${result.roomsDeleted===1?"":"s"} removed`:""))}catch(problem){toast(problem.message)}}
function openUserModal(person){const card=$("#userCard"),profile=person.profile||{};card.innerHTML='<span class="avatar"></span><h3></h3><p class="handle"></p><div class="user-meta"></div><p class="user-bio"></p>';setAvatar(card.querySelector(".avatar"),person);card.querySelector("h3").textContent=profile.displayName||person.username;colorUsername(card.querySelector("h3"),person.username);card.querySelector(".handle").textContent="@"+person.username;const meta=card.querySelector(".user-meta"),info=[];if(person.age)info.push(person.age+" years");if(profile.gender)info.push(profile.gender==="prefer_not"?"prefers not to say":profile.gender);if(person.role==="admin"||person.role==="mod")info.push(person.role==="admin"?"Admin":"Mod");(profile.interests||[]).slice(0,6).forEach(item=>info.push(item));info.forEach(item=>{const chip=document.createElement("span");chip.textContent=item;meta.appendChild(chip)});const bio=card.querySelector(".user-bio");bio.textContent=profile.bio||"";bio.hidden=!profile.bio;$("#userMessage").hidden=Boolean(currentUser&&person.id===currentUser.id);$("#userMessage").onclick=()=>{$("#userModal").hidden=true;openDm(person)};$("#userViewProfile").onclick=()=>{$("#userModal").hidden=true;showProfilePage(person.username,"push")};const hideButton=$("#userHide");hideButton.hidden=Boolean(currentUser&&person.id===currentUser.id);hideButton.textContent=hiddenUsers.has(person.id)?"Show messages":"Hide messages";hideButton.onclick=()=>toggleUserHidden(person);const bannedHere=roomBans.some(item=>item.id===person.id),banButton=$("#userBan"),mayModerate=canModerateRoom()&&(canBanPerson(person)||bannedHere);banButton.hidden=!mayModerate;banButton.textContent=bannedHere?"Unban from this room":"Ban from this room";banButton.classList.toggle("danger",!bannedHere);banButton.onclick=()=>bannedHere?unbanUser(person):banUser(person);$("#userModal").hidden=false}
const dmThreads=new Map();
function pushDm(person,entry){let thread=dmThreads.get(person.id);if(!thread){thread={person,entries:[]};dmThreads.set(person.id,thread)}thread.person=person;thread.entries.push(entry);if(!$("#dmsView").hidden){if(dmTarget&&dmTarget.id===person.id&&!$("#dmChat").hidden)renderDmThread();else renderDmInbox();renderPeopleList()}}
function handleDm(event){if(event.id){if(seenDmIds.has(event.id))return;seenDmIds.add(event.id);if(seenDmIds.size>500)seenDmIds.delete(seenDmIds.values().next().value)}const fromMe=event.from.id===currentUser?.id;let person;if(fromMe){const thread=dmThreads.get(event.to);person=(thread&&thread.person)||(dmTarget&&dmTarget.id===event.to?dmTarget:null)||{id:event.to,username:"Someone",profile:null}}else person=event.from;const threadOpen=!$("#dmsView").hidden&&dmTarget&&dmTarget.id===person.id&&!$("#dmChat").hidden;if(!fromMe&&!threadOpen){dmUnread.set(person.id,(dmUnread.get(person.id)||0)+1);toast(((person.profile&&person.profile.displayName)||person.username)+" sent a message")}pushDm(person,{content:event.content,kind:event.kind||"text",fromMe,at:event.at});updateDmBadges()}
async function loadUsers(){try{allUsers=(await request("/api/users")).users}catch{}}
function userOnlineState(userId){const person=allUsers.find(item=>item.id===userId);return Boolean(person&&person.online)}
function renderDmHeadDot(){if(!dmTarget)return;const avatar=$("#dmAvatar"),online=userOnlineState(dmTarget.id);avatar.querySelector(".presence-dot")?.remove();if(online){const dot=document.createElement("span");dot.className="presence-dot";avatar.appendChild(dot)}$("#dmPresence").textContent=online?"Online · calls available":"Offline"}
function renderPeopleList(){const list=$("#peopleList");if(!list)return;const byId=new Map(allUsers.map(person=>[person.id,person]));dmThreads.forEach(thread=>byId.set(thread.person.id,thread.person));const lastAt=person=>{const thread=dmThreads.get(person.id);return thread&&thread.entries.length?thread.entries[thread.entries.length-1].at:0};const query=(peopleQuery||"").trim().toLowerCase();const entries=[...byId.values()].sort((a,b)=>lastAt(b)-lastAt(a)||String(a.username).localeCompare(String(b.username))).filter(person=>!query||String(person.username||"").toLowerCase().includes(query)||String((person.profile&&person.profile.displayName)||"").toLowerCase().includes(query));list.innerHTML="";if(!entries.length)list.innerHTML='<p class="dm-inbox-empty">'+(query?"No users match “"+query.replace(/[<>&]/g,"")+"”.":"No other users yet.")+"</p>";entries.forEach(person=>{const thread=dmThreads.get(person.id),active=Boolean(dmTarget&&dmTarget.id===person.id),unread=dmUnread.get(person.id)||0,button=document.createElement("button");button.type="button";button.className="people-item"+(active?" active":"");button.innerHTML='<span class="avatar"></span><span class="people-copy"><span class="people-name"></span><small class="people-last"></small></span>';setAvatar(button.querySelector(".avatar"),person);button.querySelector(".people-name").textContent=(person.profile&&person.profile.displayName)||person.username;colorUsername(button.querySelector(".people-name"),person.username);const peopleTag=roleTagElement(person.role);if(peopleTag)button.querySelector(".people-name").appendChild(peopleTag);button.querySelector(".people-last").textContent=thread&&thread.entries.length?thread.entries[thread.entries.length-1].content:"Start a conversation";if(unread){const badge=document.createElement("span");badge.className="people-unread";badge.textContent=unread>9?"9+":String(unread);button.querySelector(".avatar").appendChild(badge)}if(person.online){const dot=document.createElement("span");dot.className="presence-dot";button.querySelector(".avatar").appendChild(dot)}button.onclick=()=>openDm(person);list.appendChild(button)})}
function ensureKnownUser(person){if(!person||allUsers.some(item=>item.id===person.id))return;allUsers.push(person)}
function dmName(person){return (person.profile&&person.profile.displayName)||person.username}
function ensureDmSocket(){if(activeSocket())return true;ensureNotifySocket();return Boolean(activeSocket())}
function sendDm(kind,content){if(!dmTarget)return;const channel=activeSocket();if(!channel)return toast("Reconnecting — try again in a moment");channel.send(JSON.stringify({type:"dm",to:dmTarget.id,kind,content}))}
async function refreshDmPermission(){if(!dmTarget)return;try{dmPermission=await request(`/api/dm/permissions/${encodeURIComponent(dmTarget.id)}`);renderDmPermBar()}catch{}}
function renderDmPermBar(){const bar=$("#dmPerm");if(!dmTarget||!dmPermission){bar.hidden=true;$("#dmImage").hidden=true;$("#dmVoice").hidden=true;return}const granted=Boolean(dmPermission.canSend);$("#dmImage").hidden=!granted;$("#dmVoice").hidden=!granted;if(granted){bar.hidden=true;bar.innerHTML="";return}bar.hidden=false;bar.innerHTML="";const label=document.createElement("span");if(dmPermission.incomingPending){label.textContent=dmName(dmTarget)+" wants to send you photos and voice notes.";const allow=document.createElement("button");allow.type="button";allow.className="allow";allow.textContent="Allow";allow.onclick=()=>askDmPermission("grant");const deny=document.createElement("button");deny.type="button";deny.className="deny";deny.textContent="Decline";deny.onclick=()=>askDmPermission("decline");bar.append(label,allow,deny);return}if(dmPermission.outgoingPending){label.textContent="Media permission requested — waiting for approval.";bar.appendChild(label);return}label.textContent="Photos and voice notes need their permission first.";const button=document.createElement("button");button.type="button";button.textContent="Request permission";button.onclick=()=>askDmPermission("request");bar.append(label,button)}
async function askDmPermission(action){if(!dmTarget)return;try{await request(`/api/dm/permissions/${encodeURIComponent(dmTarget.id)}`,{method:"POST",body:JSON.stringify({action})});await refreshDmPermission();toast(action==="request"?"Permission requested":action==="grant"?"You allowed "+dmTarget.username+" to send media":action==="decline"?"Request declined":"Permission updated")}catch(problem){toast(problem.message)}}
function handleDmPermission(event){const person=event.from;ensureKnownUser(person);const name=dmName(person),labels={requested:name+" wants to send you photos and voice notes",granted:name+" allowed you to send photos and voice notes",declined:"Media permission was declined",revoked:"Media permission was revoked"};if(labels[event.status])toast(labels[event.status]);if(dmTarget&&dmTarget.id===person.id)refreshDmPermission()}
function prepareDmsPage(){dmTarget=null;dmPermission=null;ensureDmSocket();$("#dmChat").hidden=true;$("#dmInbox").hidden=false;renderDmInbox();renderPeopleList();loadUsers().then(renderPeopleList)}
function openDmInbox(){prepareDmsPage();showDmsPage("push")}
function renderDmInbox(){const inbox=$("#dmInbox");inbox.innerHTML="";if(!dmThreads.size){inbox.innerHTML='<p class="dm-inbox-empty">No conversations yet. Open the online list and tap Message on someone.</p>';return}dmThreads.forEach(thread=>{const last=thread.entries[thread.entries.length-1],person=allUsers.find(item=>item.id===thread.person.id)||thread.person,button=document.createElement("button");button.type="button";button.className="dm-thread-item";button.innerHTML='<span class="avatar"></span><span><b></b><small></small></span><span class="dm-unread"></span>';setAvatar(button.querySelector(".avatar"),person);if(userOnlineState(person.id)){const dot=document.createElement("span");dot.className="presence-dot";button.querySelector(".avatar").appendChild(dot)}button.querySelector("b").textContent=(person.profile&&person.profile.displayName)||person.username;colorUsername(button.querySelector("b"),person.username);const threadTag=roleTagElement(person.role);if(threadTag)button.querySelector("b").appendChild(threadTag);button.querySelector("small").textContent=last.kind==="image"?"📷 Photo":last.kind==="voice"?"🎙 Voice note":last.content;const unread=dmUnread.get(person.id)||0,unreadLabel=button.querySelector(".dm-unread");unreadLabel.textContent=unread>9?"9+":String(unread);unreadLabel.hidden=unread===0;button.onclick=()=>openDm(person);inbox.appendChild(button)})}
function openDm(person){person=allUsers.find(item=>item.id===person.id)||person;ensureKnownUser(person);ensureDmSocket();dmTarget=person;dmPermission=null;dmUnread.delete(person.id);updateDmBadges();setAvatar($("#dmAvatar"),person);renderDmHeadDot();$("#dmInbox").hidden=true;$("#dmChat").hidden=false;$("#dmTitle").textContent=(person.profile&&person.profile.displayName)||person.username;colorUsername($("#dmTitle"),person.username);const dmTag=roleTagElement(person.role);if(dmTag)$("#dmTitle").appendChild(dmTag);renderDmThread();renderDmPermBar();refreshDmPermission();renderPeopleList();showDmsPage("push");$("#dmInput").focus()}
function renderDmThread(){const list=$("#dmMessages"),thread=dmThreads.get(dmTarget.id);list.innerHTML="";((thread&&thread.entries)||[]).forEach(entry=>{const bubble=document.createElement("div");bubble.className="dm-message"+(entry.fromMe?" me":"");const kind=entry.kind||"text";if(kind==="image"){bubble.classList.add("image");const image=document.createElement("img");image.src=entry.content;image.alt="Shared image";image.loading="lazy";bubble.appendChild(image)}else if(kind==="voice"){bubble.classList.add("voice");const audio=voicePlayer(entry.content);bubble.appendChild(audio)}else bubble.textContent=entry.content;const time=document.createElement("time");time.textContent=new Intl.DateTimeFormat([],{hour:"numeric",minute:"2-digit"}).format(new Date(entry.at));bubble.appendChild(time);list.appendChild(bubble)});list.scrollTop=list.scrollHeight}
const rtcConfig={iceServers:[{urls:["stun:stun.l.google.com:19302","stun:stun1.l.google.com:19302"]}]};
function callSignal(type,call,payload={}){const channel=activeSocket();if(!channel||!call)return false;channel.send(JSON.stringify({type,to:call.person.id,callId:call.id,...payload}));return true}
function callLabel(person){return (person&&person.profile&&person.profile.displayName)||person?.username||"Someone"}
function callStatus(text){$("#callStatus").textContent=text}
function showCallOverlay(call,incoming){const card=$("#callCard");card.className="call-card "+call.mode;setAvatar($("#callAvatar"),call.person);$("#callName").textContent=callLabel(call.person);$("#callKind").textContent=(call.mode==="video"?"VIDEO":"VOICE")+" CALL";callStatus(incoming?"Incoming call…":"Calling…");$("#callIncoming").hidden=!incoming;$("#callControls").hidden=incoming;$("#callCamera").hidden=call.mode!=="video";$("#callMute").classList.remove("off");$("#callCamera").classList.remove("off");$("#callMute small").textContent="Mute";$("#callCamera small").textContent="Camera";$("#callOverlay").hidden=false}
function stopCallTracks(stream){if(stream)stream.getTracks().forEach(track=>track.stop())}
function endCall(notify=true){const call=currentCall;if(!call)return;currentCall=null;clearTimeout(callTimer);if(notify)callSignal("call-end",call);try{call.peer?.close()}catch{}stopCallTracks(call.local);$("#callRemoteVideo").srcObject=null;$("#callLocalVideo").srcObject=null;$("#callOverlay").hidden=true}
function failCall(message){endCall(false);toast(message)}
async function flushCallCandidates(call){if(!call.peer||!call.peer.remoteDescription)return;const candidates=call.candidates.splice(0);for(const candidate of candidates)try{await call.peer.addIceCandidate(candidate)}catch{}}
function createCallPeer(call){const peer=new RTCPeerConnection(rtcConfig);call.peer=peer;peer.onicecandidate=event=>{if(currentCall===call&&event.candidate)callSignal("call-ice",call,{candidate:event.candidate.toJSON()})};peer.ontrack=event=>{if(currentCall!==call)return;const stream=event.streams[0]||new MediaStream([event.track]);$("#callRemoteVideo").srcObject=stream;$("#callCard").classList.add("has-remote")};peer.onconnectionstatechange=()=>{if(currentCall!==call)return;if(peer.connectionState==="connected"){clearTimeout(callTimer);callStatus("Connected · peer-to-peer");$("#callCard").classList.add("connected")}else if(peer.connectionState==="failed")failCall("The call could not connect")};return peer}
async function getCallMedia(mode){if(!navigator.mediaDevices?.getUserMedia)throw new Error("Calls are not supported in this browser.");return navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:mode==="video"?{facingMode:"user",width:{ideal:1280},height:{ideal:720}}:false})}
async function startCall(mode){if(currentCall)return toast("You are already in a call");if(!dmTarget)return;if(!window.RTCPeerConnection)return toast("Calls are not supported in this browser");const call={id:crypto.randomUUID?crypto.randomUUID():Date.now()+"-"+Math.random(),person:dmTarget,mode,role:"caller",peer:null,local:null,candidates:[]};currentCall=call;showCallOverlay(call,false);try{call.local=await getCallMedia(mode);if(currentCall!==call)return stopCallTracks(call.local);$("#callLocalVideo").srcObject=call.local;const peer=createCallPeer(call);call.local.getTracks().forEach(track=>peer.addTrack(track,call.local));const offer=await peer.createOffer();await peer.setLocalDescription(offer);if(!callSignal("call-offer",call,{mode,sdp:{type:peer.localDescription.type,sdp:peer.localDescription.sdp}}))throw new Error("Reconnecting — try again in a moment.");callStatus("Ringing…");callTimer=setTimeout(()=>{if(currentCall===call){callSignal("call-end",call);failCall("No answer")}},30000)}catch(problem){if(currentCall===call)failCall(problem.message||"Could not start the call")}}
async function acceptCall(){const call=currentCall;if(!call||call.role!=="receiver")return;$("#callIncoming").hidden=true;$("#callControls").hidden=false;callStatus("Connecting securely…");try{call.local=await getCallMedia(call.mode);if(currentCall!==call)return stopCallTracks(call.local);$("#callLocalVideo").srcObject=call.local;const peer=createCallPeer(call);call.local.getTracks().forEach(track=>peer.addTrack(track,call.local));await peer.setRemoteDescription(call.offer);await flushCallCandidates(call);const answer=await peer.createAnswer();await peer.setLocalDescription(answer);callSignal("call-answer",call,{sdp:{type:peer.localDescription.type,sdp:peer.localDescription.sdp}});callTimer=setTimeout(()=>{if(currentCall===call&&peer.connectionState!=="connected")failCall("The call could not connect")},30000)}catch(problem){callSignal("call-reject",call);if(currentCall===call)failCall(problem.message||"Camera or microphone is unavailable")}}
function declineCall(){const call=currentCall;if(!call)return;callSignal("call-reject",call);endCall(false)}
async function handleCallSignal(event){if(event.type==="call-offer"){if(currentCall){if(currentCall.id!==event.callId)callSignal("call-busy",{id:event.callId,person:event.from});return}const call={id:event.callId,person:event.from,mode:event.mode==="video"?"video":"voice",role:"receiver",offer:event.sdp,peer:null,local:null,candidates:[]};currentCall=call;ensureKnownUser(event.from);showCallOverlay(call,true);try{navigator.vibrate?.([180,80,180])}catch{}callTimer=setTimeout(()=>{if(currentCall===call){callSignal("call-reject",call);endCall(false)}},30000);return}const call=currentCall;if(!call||call.id!==event.callId)return;if(event.type==="call-answer"&&call.role==="caller"){if(call.answering)return;call.answering=true;try{callStatus("Connecting securely…");await call.peer.setRemoteDescription(event.sdp);await flushCallCandidates(call);if(call.peer.connectionState==="connected"){clearTimeout(callTimer);callStatus("Connected · peer-to-peer");$("#callCard").classList.add("connected")}}catch{failCall("The call could not connect")}return}if(event.type==="call-ice"){if(call.peer&&call.peer.remoteDescription)try{await call.peer.addIceCandidate(event.candidate)}catch{}else call.candidates.push(event.candidate);return}if(event.type==="call-taken"){endCall(false);return}if(event.type==="call-reject"){failCall("Call declined");return}if(event.type==="call-busy"){failCall(callLabel(call.person)+" is on another call");return}if(event.type==="call-unavailable"){failCall(callLabel(call.person)+" is offline");return}if(event.type==="call-end")failCall("Call ended")}
$("#dmVoiceCall").onclick=()=>startCall("voice");
$("#dmVideoCall").onclick=()=>startCall("video");
$("#callAccept").onclick=acceptCall;
$("#callDecline").onclick=declineCall;
$("#callHangup").onclick=()=>endCall();
$("#callMute").onclick=()=>{const call=currentCall,track=call&&call.local&&call.local.getAudioTracks()[0];if(!track)return;track.enabled=!track.enabled;$("#callMute").classList.toggle("off",!track.enabled);$("#callMute small").textContent=track.enabled?"Mute":"Unmute"};
$("#callCamera").onclick=()=>{const call=currentCall,track=call&&call.local&&call.local.getVideoTracks()[0];if(!track)return;track.enabled=!track.enabled;$("#callCamera").classList.toggle("off",!track.enabled);$("#callCamera small").textContent=track.enabled?"Camera":"Camera off"};
window.addEventListener("beforeunload",()=>{if(currentCall)callSignal("call-end",currentCall)});
$("#dmBack").onclick=openDmInbox;
$("#dmImage").onclick=()=>$("#dmImageInput").click();
$("#dmImageInput").onchange=async event=>{const file=event.target.files[0];event.target.value="";if(!file)return;try{const url=await uploadFile("image",file);sendDm("image",url)}catch(problem){toast(problem.message)}};
$("#dmVoice").onclick=()=>startVoiceNote({button:$("#dmVoice"),idle:"\uD83C\uDF99"},async(blob,durationMs,extension)=>{const url=await uploadFile("voice",new File([blob],`voice.${extension}`,{type:blob.type}));sendDm("voice",url)});
$("#dmForm").onsubmit=event=>{event.preventDefault();const input=$("#dmInput"),text=input.value.trim();if(!text||!dmTarget)return;const channel=activeSocket();if(!channel)return toast("Reconnecting — try again in a moment");channel.send(JSON.stringify({type:"dm",to:dmTarget.id,kind:"text",content:text}));input.value=""};
function fileToBase64(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(",")[1]||"");reader.onerror=()=>reject(new Error("Could not read that file."));reader.readAsDataURL(file)})}
async function uploadFile(kind,file){const data=await fileToBase64(file);const result=await request("/api/upload",{method:"POST",body:JSON.stringify({kind,data}),timeoutMs:60000});return result.url}

/* ------------------------------------------------------------- voice notes */

// Capture settings are deliberately explicit. Browser defaults pick a profile that varies by device
// and by Android build, which is how a note ends up sounding like it has holes in it; mono Opus at
// 96 kbps is transparent for speech and gives a predictable size on disk.
const VOICE_BITRATE=96000,VOICE_MAX_MS=120000,VOICE_MIN_MS=700,VOICE_MIME_TYPES=["audio/webm;codecs=opus","audio/ogg;codecs=opus","audio/webm","audio/mp4","audio/aac"];
function voiceSupported(){return Boolean(navigator.mediaDevices&&navigator.mediaDevices.getUserMedia&&window.MediaRecorder)}
function voiceMimeType(){if(!window.MediaRecorder||typeof window.MediaRecorder.isTypeSupported!=="function")return "";return VOICE_MIME_TYPES.find(type=>{try{return window.MediaRecorder.isTypeSupported(type)}catch{return false}})||""}
function voiceExtension(mime){return /ogg/.test(mime)?"ogg":/(mp4|aac)/.test(mime)?"m4a":"webm"}
function clockText(ms){const seconds=Math.max(0,Math.floor(ms/1000));return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,"0")}`}
function releaseMicrophone(stream){if(stream)stream.getTracks().forEach(track=>track.stop())}
async function startVoiceNote(ui,deliver){
  if(voice){stopVoiceNote(false);return}
  if(!voiceSupported())return toast("Voice notes are not supported in this browser.");
  ui.button.disabled=true;
  let stream=null;
  try{stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:{ideal:1},echoCancellation:true,noiseSuppression:true,autoGainControl:true,sampleRate:{ideal:48000}}})}
  catch{ui.button.disabled=false;return toast("Microphone is not available.")}
  const mimeType=voiceMimeType();
  let recorder=null;
  try{recorder=new MediaRecorder(stream,{...(mimeType?{mimeType}:{}),audioBitsPerSecond:VOICE_BITRATE})}
  catch{try{recorder=new MediaRecorder(stream)}catch{recorder=null}}
  if(!recorder){releaseMicrophone(stream);ui.button.disabled=false;return toast("This browser cannot record audio.")}
  // A one-second timeslice makes the encoder hand over audio as it goes instead of one blob at stop,
  // so a backgrounded tab or a slow stop cannot cost the end of the note.
  const session={recorder,stream,ui,deliver,chunks:[],startedAt:performance.now(),timer:null,cancelled:false};
  voice=session;
  recorder.ondataavailable=event=>{if(event.data&&event.data.size)session.chunks.push(event.data)};
  recorder.onerror=()=>{toast("The microphone stopped unexpectedly.");stopVoiceNote(true)};
  recorder.onstop=()=>finishVoiceNote(session);
  try{recorder.start(1000)}
  catch{releaseMicrophone(stream);voice=null;ui.button.disabled=false;return toast("Recording could not start.")}
  session.timer=setInterval(()=>{
    if(voice!==session)return;
    const elapsed=performance.now()-session.startedAt;
    if(elapsed>=VOICE_MAX_MS){toast("Voice notes stop at two minutes.");stopVoiceNote(false);return}
    ui.button.textContent="\u23F9 "+clockText(elapsed);
  },250);
  ui.button.disabled=false;
  ui.button.classList.add("recording");
  ui.button.textContent="\u23F9 0:00";
}
function stopVoiceNote(cancelled){
  const session=voice;
  if(!session)return;
  session.cancelled=Boolean(cancelled);
  clearInterval(session.timer);
  session.timer=null;
  try{if(session.recorder.state!=="inactive")session.recorder.stop()}catch{finishVoiceNote(session)}
  // A recorder that never fires onstop would hold the microphone open, so finish regardless.
  setTimeout(()=>{if(voice===session)finishVoiceNote(session)},2000);
}
function finishVoiceNote(session){
  if(voice===session)voice=null;
  clearInterval(session.timer);
  releaseMicrophone(session.stream);
  const {ui,chunks}=session,durationMs=performance.now()-session.startedAt,type=session.recorder.mimeType||(chunks[0]&&chunks[0].type)||"audio/webm",blob=new Blob(chunks,{type});
  ui.button.disabled=false;
  ui.button.classList.remove("recording");
  ui.button.textContent=ui.idle;
  if(session.cancelled)return;
  if(!blob.size||durationMs<VOICE_MIN_MS)return toast("That recording was too short.");
  Promise.resolve().then(()=>session.deliver(blob,durationMs,voiceExtension(type))).catch(problem=>toast((problem&&problem.message)||"Could not send that voice note."));
}
// MediaRecorder writes a WebM stream whose header carries no duration, so the element reports
// Infinity and the scrubber behaves as if the clip never ends. Seeking far past the end makes the
// browser compute the real duration; the jump back to zero is invisible because nothing played.
function voicePlayer(url){
  const audio=document.createElement("audio");
  audio.controls=true;
  audio.preload="metadata";
  audio.src=url;
  audio.addEventListener("loadedmetadata",()=>{
    if(Number.isFinite(audio.duration))return;
    audio.currentTime=1e7;
    audio.addEventListener("timeupdate",()=>{audio.currentTime=0},{once:true});
  },{once:true});
  return audio;
}
/* ------------------------------------------------------------ room calls */

// A room call is a peer-to-peer mesh: everybody connects to everybody, audio only, with the room's
// own WebSocket carrying the offers, answers and ICE candidates. The server only keeps the list of
// participants and relays signals between them, so audio never touches it.
let roomCallState=null,groupCall=null;
function roomCallAvailable(){return Boolean(currentUser&&currentRoom&&currentRoom.canEnter&&!currentRoom.builtIn&&currentRoom.access==="request"&&!currentRoom.banned)}
function groupCallSend(payload){
  const channel=activeSocket();
  if(!channel||!groupCall||!groupCall.callId)return false;
  channel.send(JSON.stringify({...payload,callId:groupCall.callId}));
  return true;
}
function renderRoomCall(){
  const button=$("#groupCallButton");
  if(button){
    button.hidden=!roomCallAvailable();
    const count=roomCallState&&Array.isArray(roomCallState.participants)?roomCallState.participants.length:0;
    button.classList.toggle("active",Boolean(count));
    button.disabled=Boolean(groupCall);
    button.textContent=groupCall?"🔊 In call":count?`🔊 Join call (${count})`:"📞 Group call";
  }
  const dock=$("#groupCall"),people=$("#groupCallPeople");
  if(!dock)return;
  if(!groupCall){dock.hidden=true;people.textContent="";return}
  dock.hidden=false;
  people.textContent="";
  ((roomCallState&&roomCallState.participants)||[]).forEach(person=>{
    const chip=document.createElement("span");
    chip.className="gc-person"+(person.id===currentUser?.id?" me":"");
    chip.textContent=person.username;
    chip.title=person.username;
    people.appendChild(chip);
  });
  $("#groupCallMute").textContent=groupCall.muted?"🔇 Unmute":"🎙 Mute";
  $("#groupCallMute").classList.toggle("off",groupCall.muted);
  // Ending the call for everybody is the starter's decision, so only that account sees the control.
  $("#groupCallEnd").hidden=!(roomCallState&&roomCallState.hostId&&currentUser&&roomCallState.hostId===currentUser.id);
}
function groupPeer(userId){
  if(!groupCall)return null;
  const existing=groupCall.peers.get(userId);
  if(existing)return existing;
  const peer=new RTCPeerConnection(rtcConfig),entry={peer,pending:[],remote:null,offered:false};
  groupCall.peers.set(userId,entry);
  peer.onicecandidate=event=>{if(event.candidate)groupCallSend({type:"group-call-ice",to:userId,candidate:event.candidate.toJSON()})};
  peer.ontrack=event=>{
    const stream=event.streams[0]||new MediaStream([event.track]);
    if(!entry.remote){entry.remote=document.createElement("audio");entry.remote.autoplay=true;entry.remote.playsInline=true;$("#groupCallAudio").appendChild(entry.remote)}
    entry.remote.srcObject=stream;
    Promise.resolve(entry.remote.play?.()).catch(()=>{});
  };
  peer.onconnectionstatechange=()=>{
    if(!groupCall||groupCall.peers.get(userId)!==entry)return;
    if(peer.connectionState==="failed"){dropGroupPeer(userId);toast("Someone dropped out of the room call")}
  };
  groupCall.local.getAudioTracks().forEach(track=>peer.addTrack(track,groupCall.local));
  return entry;
}
async function offerGroupPeer(userId){
  const entry=groupPeer(userId);
  if(!entry||entry.offered)return;
  entry.offered=true;
  try{
    const offer=await entry.peer.createOffer();
    await entry.peer.setLocalDescription(offer);
    groupCallSend({type:"group-call-offer",to:userId,sdp:{type:entry.peer.localDescription.type,sdp:entry.peer.localDescription.sdp}});
  }catch{dropGroupPeer(userId)}
}
function dropGroupPeer(userId){
  const entry=groupCall&&groupCall.peers.get(userId);
  if(!entry)return;
  groupCall.peers.delete(userId);
  try{entry.peer.close()}catch{}
  if(entry.remote)entry.remote.remove();
}
async function flushGroupCandidates(entry){
  if(!entry.peer.remoteDescription)return;
  for(const candidate of entry.pending.splice(0))try{await entry.peer.addIceCandidate(candidate)}catch{}
}
async function joinRoomCall(){
  if(groupCall)return;
  if(!roomCallAvailable())return;
  if(!navigator.mediaDevices?.getUserMedia||!window.RTCPeerConnection)return toast("Room calls are not supported in this browser.");
  if(!activeSocket())return toast("Reconnecting — try again in a moment");
  let stream;
  try{stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}})}
  catch{return toast("Microphone is not available.")}
  groupCall={callId:null,peers:new Map(),local:stream,muted:false};
  renderRoomCall();
  const channel=activeSocket();
  channel.send(JSON.stringify({type:"group-call-join"}));
}
function leaveRoomCall(silent=false){
  const call=groupCall;
  if(!call)return;
  if(!silent)groupCallSend({type:"group-call-leave"});
  for(const userId of [...call.peers.keys()])dropGroupPeer(userId);
  call.local.getTracks().forEach(track=>track.stop());
  groupCall=null;
  $("#groupCallAudio").textContent="";
  renderRoomCall();
}
function toggleRoomCallMute(){
  if(!groupCall)return;
  groupCall.muted=!groupCall.muted;
  groupCall.local.getAudioTracks().forEach(track=>{track.enabled=!groupCall.muted});
  renderRoomCall();
}
async function handleRoomCallEvent(event){
  if(event.type==="group-call-state"){
    roomCallState=event.active?{callId:event.callId,hostId:event.hostId,participants:event.participants||[]}:null;
    if(groupCall&&!event.active){leaveRoomCall(true);toast("The room call ended")}
    renderRoomCall();
    return;
  }
  if(event.type==="group-call-joined"){
    if(!groupCall||groupCall.callId)return;
    groupCall.callId=event.callId;
    roomCallState={callId:event.callId,hostId:event.hostId,participants:event.participants||[]};
    renderRoomCall();
    // The joiner is always the one that offers, so two people joining at once never glare.
    for(const person of (event.participants||[]).filter(item=>item.id!==event.self))offerGroupPeer(person.id);
    return;
  }
  if(!groupCall||!groupCall.callId||event.callId!==groupCall.callId)return;
  if(event.type==="group-call-offer"){
    const entry=groupPeer(event.from);
    if(!entry)return;
    try{
      await entry.peer.setRemoteDescription(event.sdp);
      await flushGroupCandidates(entry);
      const answer=await entry.peer.createAnswer();
      await entry.peer.setLocalDescription(answer);
      groupCallSend({type:"group-call-answer",to:event.from,sdp:{type:entry.peer.localDescription.type,sdp:entry.peer.localDescription.sdp}});
    }catch{dropGroupPeer(event.from)}
    return;
  }
  if(event.type==="group-call-answer"){
    const entry=groupCall.peers.get(event.from);
    if(!entry)return;
    try{await entry.peer.setRemoteDescription(event.sdp);await flushGroupCandidates(entry)}catch{dropGroupPeer(event.from)}
    return;
  }
  if(event.type==="group-call-ice"){
    const entry=groupCall.peers.get(event.from);
    if(!entry)return;
    if(entry.peer.remoteDescription)try{await entry.peer.addIceCandidate(event.candidate)}catch{}
    else entry.pending.push(event.candidate);
    return;
  }
  if(event.type==="group-call-left"){dropGroupPeer(event.userId);return}
  if(event.type==="group-call-ended"){toast(`${event.by?.username||"The host"} ended the room call`);leaveRoomCall(true);return}
  if(event.type==="group-call-full"){toast("That room call is full");leaveRoomCall(true)}
}
function endRoomCall(){
  if(!groupCall)return;
  // The server only honours this from the account that started the call; locally we tear down
  // whether or not it was accepted, because holding the microphone open is never the right answer.
  if(roomCallState&&currentUser&&roomCallState.hostId===currentUser.id)groupCallSend({type:"group-call-end"});
  leaveRoomCall(true);
}
$("#groupCallButton").onclick=joinRoomCall;
$("#groupCallLeave").onclick=()=>leaveRoomCall(false);
$("#groupCallEnd").onclick=endRoomCall;
$("#groupCallMute").onclick=toggleRoomCallMute;
document.querySelector("[data-compose=image]").onclick=()=>$("#imageInput").click();
$("#imageInput").onchange=async event=>{const files=[...event.target.files].slice(0,4);event.target.value="";if(!files.length)return;if(socket?.readyState!==WebSocket.OPEN)return toast("Reconnecting — try again in a moment");toast(files.length>1?`Sending ${files.length} images…`:"Sending image…");for(const file of files){try{const url=await uploadFile("image",file);send("image",url)}catch(problem){toast(problem.message);break}}};
document.querySelector("[data-compose=voice]").onclick=()=>startVoiceNote({button:document.querySelector("[data-compose=voice]"),idle:"\uD83C\uDF99 Voice"},async(blob,durationMs,extension)=>{const url=await uploadFile("voice",new File([blob],`voice.${extension}`,{type:blob.type}));send("voice",url)});
/* ------------------------------------------------------------ passkeys */

const PASSKEYS_KEY="chatblink.passkeys";
let passkeyAvailableCache=null,platformAuthenticatorCache=null,safetyState=null,siteNotice=null,noticeEditing=false;
function base64UrlToBytes(value){const text=String(value||"").replace(/-/g,"+").replace(/_/g,"/"),binary=atob(text+"=".repeat((4-text.length%4)%4)),bytes=new Uint8Array(binary.length);for(let index=0;index<binary.length;index++)bytes[index]=binary.charCodeAt(index);return bytes}
function bytesToBase64Url(value){let binary="";for(const byte of new Uint8Array(value))binary+=String.fromCharCode(byte);return btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")}
function webauthnAvailable(){if(passkeyAvailableCache===null)passkeyAvailableCache=Boolean(window.PublicKeyCredential&&navigator.credentials&&navigator.credentials.get&&navigator.credentials.create);return passkeyAvailableCache}
async function platformAuthenticatorAvailable(){
  // Only a positive answer is cached: the platform authenticator can appear later (a virtual one in
  // tests, Windows Hello being set up mid-session), and a cached "no" would hide the door forever.
  if(platformAuthenticatorCache===true)return true;
  try{platformAuthenticatorCache=Boolean(window.PublicKeyCredential&&PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable&&await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())}catch{platformAuthenticatorCache=false}
  return platformAuthenticatorCache;
}
async function refreshPasskeyAvailability(){
  if(!await platformAuthenticatorAvailable())return;
  $("#passkeyLogin").hidden=false;
  $("#passkeyDivider").hidden=false;
}
function devicePasskeys(){try{const list=JSON.parse(localStorage.getItem(PASSKEYS_KEY)||"[]");return Array.isArray(list)?list:[]}catch{return []}}
function rememberDevicePasskey(id){const list=devicePasskeys().filter(item=>item!==id);list.push(id);try{localStorage.setItem(PASSKEYS_KEY,JSON.stringify(list.slice(-20)))}catch{}}
let pendingRegisterOptions=null,pendingRegisterAt=0,registerOptionsFlight=null;
// Chrome (and Android's credential manager) need a live user activation for create()/get(). Awaiting
// the options request inside the click handler can burn it, so the challenge is fetched ahead of time
// while the panel is open and the click goes straight to the device prompt.
async function primeRegisterOptions(){
  // Only one request may be in flight: two of them would overwrite the challenge cookie, and whichever
  // arrived last would leave the click holding an options object the server no longer honours.
  if(registerOptionsFlight)return registerOptionsFlight;
  if(freshRegisterOptions())return pendingRegisterOptions;
  const flight=passkeyOptions("register").then(options=>{pendingRegisterOptions=options;pendingRegisterAt=Date.now();return options},()=>null).finally(()=>{if(registerOptionsFlight===flight)registerOptionsFlight=null});
  registerOptionsFlight=flight;
  return flight;
}
async function takeRegisterOptions(){
  const options=await primeRegisterOptions();
  pendingRegisterOptions=null;pendingRegisterAt=0;
  return options||passkeyOptions("register");
}
function freshRegisterOptions(){
  return pendingRegisterOptions&&Date.now()-pendingRegisterAt<120000?pendingRegisterOptions:null;
}
function minimalRegisterOptions(options){
  // Everything the platform does not strictly need is dropped, but resident keys stay: without a
  // discoverable credential there is no usernameless sign-in to come back to.
  return {
    challenge:options.challenge,
    rp:options.rp,
    user:options.user,
    pubKeyCredParams:options.pubKeyCredParams,
    authenticatorSelection:{authenticatorAttachment:"platform",userVerification:"required",residentKey:"preferred"},
    attestation:"none"
  };
}
function minimalLoginOptions(options){
  return {challenge:options.challenge,rpId:options.rpId,allowCredentials:[],authenticatorAttachment:"platform",userVerification:"required"};
}
function passkeyErrorMessage(problem){
  const name=(problem&&problem.name)||"",message=String((problem&&problem.message)||"");
  if(name==="NotAllowedError")return "The device did not confirm a passkey. Try again and approve the prompt.";
  if(name==="AbortError")return "The passkey prompt was closed.";
  if(name==="SecurityError")return "The browser refused a passkey on this address. Use https://chatblink.chat.";
  if(name==="InvalidStateError")return "This device already has a passkey for your account.";
  if(name==="ConstraintError"||/not supported/i.test(message))return "This device cannot create a passkey.";
  console.warn("passkey error:",name,message);
  return `The device's credential manager refused (${name||"error"}). Check that Windows Hello, Touch ID or a screen lock is set up on this device, then try again.`;
}

async function passkeyOptions(mode){
  const result=await request("/api/auth/passkey/options",{method:"POST",body:JSON.stringify({mode,origin:location.origin})});
  const options=result.options||{};
  options.challenge=base64UrlToBytes(options.challenge);
  if(options.user)options.user.id=base64UrlToBytes(options.user.id);
  (options.excludeCredentials||[]).forEach(item=>{item.id=base64UrlToBytes(item.id)});
  (options.allowCredentials||[]).forEach(item=>{item.id=base64UrlToBytes(item.id)});
  return options;
}
async function signInWithPasskey(){
  if(!webauthnAvailable())return toast("This browser cannot use a passkey.");
  const button=$("#passkeyLogin"),copy=button&&button.textContent;
  if(button){button.disabled=true;button.textContent="Waiting for your device…"}
  try{
    const options=await passkeyOptions("login");
    let assertion;
    try{assertion=await navigator.credentials.get({publicKey:options})}
    catch(problem){
      if(problem&&(problem.name==="NotAllowedError"||problem.name==="AbortError"))throw problem;
      console.warn("passkey get failed, retrying with reduced options:",problem&&problem.name,problem&&problem.message);
      assertion=await navigator.credentials.get({publicKey:minimalLoginOptions(options)});
    }
    const result=await request("/api/auth/passkey/verify",{method:"POST",body:JSON.stringify({origin:location.origin,credentialId:assertion.id,response:{clientDataJSON:bytesToBase64Url(assertion.response.clientDataJSON),authenticatorData:bytesToBase64Url(assertion.response.authenticatorData),signature:bytesToBase64Url(assertion.response.signature)}})});
    rememberToken(result.token);
    await enterApp(result.user);
  }catch(problem){
    if(problem&&problem.name==="NotAllowedError")toast("No passkey was used.");
    else if(problem&&problem.message&&/profile key|not registered|challenge|origin|site/i.test(problem.message))toast(problem.message);
    else toast(passkeyErrorMessage(problem));
  }finally{if(button){button.disabled=false;button.textContent=copy}}
}
async function addPasskey(){
  if(!currentUser)return toast("Join the chatrooms first");
  if(!webauthnAvailable())return toast("This browser cannot use a passkey.");
  const button=$("#safetyAddPasskey");
  if(button){button.disabled=true;button.textContent="Waiting for your device…"}
  try{
    const options=await takeRegisterOptions();
    let credential;
    try{credential=await navigator.credentials.create({publicKey:options})}
    catch(problem){
      if(problem&&(problem.name==="NotAllowedError"||problem.name==="AbortError"))throw problem;
      console.warn("passkey create failed, retrying with reduced options:",problem&&problem.name,problem&&problem.message);
      credential=await navigator.credentials.create({publicKey:minimalRegisterOptions(options)});
    }
    const saved=await request("/api/auth/passkey/register",{method:"POST",body:JSON.stringify({origin:location.origin,credential:{id:credential.id,authenticatorAttachment:credential.authenticatorAttachment,response:{clientDataJSON:bytesToBase64Url(credential.response.clientDataJSON),attestationObject:bytesToBase64Url(credential.response.attestationObject),transports:credential.response.getTransports?credential.response.getTransports():[]}}})});
    rememberDevicePasskey(saved.id||credential.id);
    toast("This device can now sign you in with your fingerprint");
    await loadSafety();
  }catch(problem){
    if(problem&&problem.name==="NotAllowedError")toast("The passkey was not created - approve the prompt on this device.");
    else if(problem&&problem.message&&/already registered for this|profile key|Sign in first|origin|site/i.test(problem.message))toast(problem.message);
    else toast(passkeyErrorMessage(problem));
  }finally{if(button){button.disabled=false;button.textContent="Add this device"}}
}

/* ------------------------------------------------------ account safety */

function renderSafetyRows(container,rows){
  container.innerHTML="";
  rows.forEach(([label,value])=>{
    const row=document.createElement("div");row.className="safety-row";
    const key=document.createElement("span");key.textContent=label;
    const val=document.createElement("b");val.textContent=value;
    row.append(key,val);container.appendChild(row);
  });
}
function renderSafety(){
  const body=$("#safetyBody");
  if(!body)return;
  body.innerHTML="";
  const account=(safetyState&&safetyState.account)||{},passkeys=(safetyState&&safetyState.passkeys)||[];
  const details=document.createElement("div");details.className="safety-card";
  const rows=[["Username","@"+account.username]];
  if(account.displayName&&account.displayName!==account.username)rows.push(["Display name",account.displayName]);
  if(account.age)rows.push(["Age",String(account.age)]);
  if(account.role&&account.role!=="user")rows.push(["Role",account.role==="admin"?"Admin":"Moderator"]);
  if(account.createdAt){const when=new Date(account.createdAt);if(!Number.isNaN(when.getTime()))rows.push(["Member since",when.toLocaleDateString()])}
  rows.push(["Devices with a passkey",String(passkeys.length)]);
  renderSafetyRows(details,rows);
  body.appendChild(details);

  const device=document.createElement("div");device.className="safety-card";
  const deviceText=document.createElement("p");deviceText.className="safety-copy";deviceText.textContent="Checking this device…";
  device.appendChild(deviceText);
  platformAuthenticatorAvailable().then(available=>{
    if(!deviceText.isConnected)return;
    deviceText.textContent=available
      ?"This device can use its fingerprint, face or screen lock to sign you in."
      :"This device has no fingerprint, face or screen lock set up, so there is nothing to add here. Your profile key signs you in on this device.";
    if(available&&add.parentElement!==device)device.appendChild(add);
    if(!available)add.remove();
  });
  const add=document.createElement("button");add.type="button";add.className="primary safety-add";add.id="safetyAddPasskey";add.textContent="Add this device";
  add.disabled=!webauthnAvailable();add.onclick=addPasskey;
  device.appendChild(add);
  body.appendChild(device);

  const list=document.createElement("div");list.className="safety-card";
  const title=document.createElement("p");title.className="safety-title";title.textContent="Your passkeys";list.appendChild(title);
  if(!passkeys.length){
    const empty=document.createElement("p");empty.className="safety-copy";empty.textContent="No passkey yet. Add this device to sign in with your fingerprint instead of typing your key.";list.appendChild(empty);
  }
  const mine=devicePasskeys();
  passkeys.forEach(passkey=>{
    const row=document.createElement("div");row.className="safety-passkey";
    const info=document.createElement("span");
    const label=document.createElement("b");label.textContent=mine.includes(passkey.id)?"This device":"Passkey";
    const meta=document.createElement("small");
    const created=passkey.createdAt?new Date(passkey.createdAt):null;
    meta.textContent=[created&&!Number.isNaN(created.getTime())?"Added "+created.toLocaleDateString():null,passkey.lastUsedAt?"last used "+new Date(passkey.lastUsedAt).toLocaleDateString():"not used yet"].filter(Boolean).join(" · ");
    info.append(label,meta);
    const remove=document.createElement("button");remove.type="button";remove.className="safety-remove";remove.textContent="Remove";
    remove.onclick=()=>askRemovePasskey(passkey);
    row.append(info,remove);list.appendChild(row);
  });
  body.appendChild(list);

  const key=document.createElement("p");key.className="safety-copy";key.textContent="Your profile key still works everywhere, including on a device without a passkey. Keep it somewhere safe - it is the only way back in if you lose every passkey.";
  body.appendChild(key);
}
async function loadSafety(){
  primeRegisterOptions();
  try{safetyState=await request("/api/account/safety");renderSafety()}
  catch(problem){const body=$("#safetyBody");if(body)body.textContent=problem.message}
}
function openSafety(){
  if(!currentUser)return toast("Join the chatrooms first");
  $("#safetyModal").hidden=false;
  const body=$("#safetyBody");if(body)body.innerHTML='<p class="dm-inbox-empty">Loading…</p>';
  platformAuthenticatorCache=null;
  loadSafety();
}
function askRemovePasskey(passkey){
  openConfirm("Remove this passkey?","That device will no longer sign you in with its fingerprint. Your profile key still works.",()=>removePasskey(passkey));
}
async function removePasskey(passkey){
  try{
    await request("/api/account/passkeys/remove",{method:"POST",body:JSON.stringify({credentialId:passkey.id})});
    toast("Passkey removed");
    await loadSafety();
  }catch(problem){toast(problem.message)}
}

/* --------------------------------------------------------- notice board */

function renderNotice(){
  const board=$("#noticeBoard");
  if(!board)return;
  const admin=Boolean(currentUser&&currentUser.role==="admin");
  const notice=siteNotice||{};
  const showing=Boolean(notice.visible&&notice.message);
  if(!showing&&!admin&&!noticeEditing){board.hidden=true;board.innerHTML="";return}
  board.hidden=false;
  board.innerHTML="";
  if(noticeEditing){
    board.classList.add("editing");
    const label=document.createElement("label");label.className="notice-label";label.textContent="Notice for the room list";
    const area=document.createElement("textarea");area.id="noticeInput";area.maxLength=600;area.rows=3;area.placeholder="What is new? Ship notes, downtime, house rules…";area.value=notice.message||"";
    const toggle=document.createElement("label");toggle.className="notice-toggle";
    const check=document.createElement("input");check.type="checkbox";check.id="noticeVisible";check.checked=Boolean(notice.visible);
    const toggleText=document.createElement("span");toggleText.textContent="Show on the room list";
    toggle.append(check,toggleText);
    const actions=document.createElement("div");actions.className="notice-actions";
    const save=document.createElement("button");save.type="button";save.className="primary";save.textContent="Save notice";save.onclick=saveNotice;
    const cancel=document.createElement("button");cancel.type="button";cancel.className="secondary";cancel.textContent="Cancel";cancel.onclick=()=>{noticeEditing=false;renderNotice()};
    actions.append(save,cancel);
    board.append(label,area,toggle,actions);
    return;
  }
  board.classList.remove("editing");
  if(showing){
    const icon=document.createElement("span");icon.className="notice-icon";icon.textContent="📣";
    const copy=document.createElement("p");copy.className="notice-copy";copy.textContent=notice.message;
    board.append(icon,copy);
  }else{
    const copy=document.createElement("p");copy.className="notice-copy empty";copy.textContent="No notice is showing on the room list.";
    board.appendChild(copy);
  }
  if(admin){
    const edit=document.createElement("button");edit.type="button";edit.className="notice-edit";edit.textContent=showing?"Edit":"Write a notice";
    edit.onclick=()=>{noticeEditing=true;renderNotice()};
    board.appendChild(edit);
  }
}
async function saveNotice(){
  const area=$("#noticeInput"),check=$("#noticeVisible");
  if(!area)return;
  try{
    const result=await request("/api/notice",{method:"POST",body:JSON.stringify({message:area.value,visible:Boolean(check&&check.checked)})});
    siteNotice=result.notice;noticeEditing=false;renderNotice();
    toast(result.notice.visible?"Notice is live on the room list":"Notice hidden");
  }catch(problem){toast(problem.message)}
}
async function loadNotice(){
  try{siteNotice=(await request("/api/notice")).notice}catch{}
  renderNotice();
}

$("#passkeyLogin").onclick=signInWithPasskey;
$("#safetyClose").onclick=()=>{$("#safetyModal").hidden=true};
$("#menuDrop").querySelector('[data-menu="safety"]').onclick=()=>{$("#menuDrop").hidden=true;openSafety()};
// The fingerprint door is only offered where this device actually has a platform authenticator; a
// browser that would fall back to "use a phone instead" gets the profile key form and nothing else.
refreshPasskeyAvailability();

async function init(){const hashParams=new URLSearchParams(location.hash.slice(1)),hashToken=hashParams.get("auth"),hashKey=hashParams.get("profileKey"),params=new URLSearchParams(location.search),bootstrapToken=window.__NEARBY_TOKEN__;if(bootstrapToken||hashToken)rememberToken(bootstrapToken||hashToken);if(hashKey)rememberProfileKey(hashKey);if(window.__NEARBY_NEW_KEY__)rememberProfileKey(window.__NEARBY_NEW_KEY__);if(hashToken||hashKey)history.replaceState({},"",location.pathname);if(location.pathname!=="/"&&location.pathname!=="/rooms"&&location.pathname!=="/dms"&&!location.pathname.startsWith("/room/")&&!location.pathname.startsWith("/profile/"))history.replaceState({},"","/");const requested=params.get("mode"),mode=["signup","login","key","key-signup"].includes(requested)?requested:"signup",message=params.get("error"),notice=params.get("notice");try{const user=window.__NEARBY_USER__||(await request("/api/auth/me")).user;if(window.__NEARBY_NEW_KEY__){showProfileSetup(user,window.__NEARBY_NEW_KEY__);return}if(user.profileComplete)await enterApp(user);else showProfileSetup(user,pendingProfileKey)}catch{forgetToken();enterGuestMode();switchAuth(mode);if(message)error(authErrorTarget(mode),message);if(notice){const banner=$("#authNotice");banner.textContent=notice;banner.hidden=false}}}init();
