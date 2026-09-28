let discoveredLevelRooms=[];
const levelLabels={country:"Country",state:"State / region",district:"District",locality:"Locality"};
const levelIcons={country:"◎",state:"◇",district:"▦",locality:"⌂"};

roomRelationship=room=>profile?.localRoomIds?.includes(room.id)||profile?.homeRoom===room.id?"Local":"Visit";
updatePermissions=function(){
 const hasLocalAccess=profile?.homeRoom===currentRoom.id||profile?.localRoomIds?.includes(currentRoom.id),visitor=currentChannel==="local"&&!hasLocalAccess;
 $("#visitorNotice").hidden=!visitor;composer.classList.toggle("disabled",visitor);input.disabled=visitor;input.placeholder=visitor?"Local conversation is read-only for visitors":currentChannel==="local"?"Message people in this area…":"Message the open room…";
};
renderRooms=function(filter=""){
 const query=filter.trim().toLowerCase(),visible=rooms.filter(room=>`${room.name} ${(room.pathNames||[]).join(" ")}`.toLowerCase().includes(query));
 roomList.innerHTML=visible.length?visible.map(room=>`<button class="room-item level-room ${room.id===currentRoom.id?"active":""}" data-room="${escapeHtml(room.id)}"><span class="room-symbol">${escapeHtml(room.icon||room.name.slice(0,2).toUpperCase())}</span><span class="room-copy"><strong>${escapeHtml(room.name)}</strong><span>${escapeHtml((room.pathNames||[]).slice(0,-1).join(" · ")||room.city||"")}</span></span><span class="room-side"><span class="room-level-badge">${escapeHtml(levelLabels[room.level]||"Room")}</span></span></button>`).join(""):`<div class="empty-directory"><strong>No rooms have been created yet.</strong>Find your location to create the first geographic room tree.</div>`;
 roomList.querySelectorAll("[data-room]").forEach(button=>button.onclick=()=>selectRoom(button.dataset.room));
};

function addRegistryRooms(registryRooms){
 for(const serverRoom of registryRooms){
  const existing=rooms.find(room=>room.id===serverRoom.id),viewRoom={...serverRoom,icon:serverRoom.name.slice(0,2).toUpperCase(),city:(serverRoom.pathNames||[]).slice(0,-1).join(", ")};
  if(existing)Object.assign(existing,viewRoom);else rooms.push(viewRoom);
 }
 renderRooms($("#roomSearch").value);
}
function showEmptyDirectory(){
 currentRoom={id:"",name:"Find your room",city:"",icon:"⌖"};$("#roomName").textContent="Find your room";$("#roomMeta").innerHTML="Create or discover persistent geographic rooms";$("#placeIcon").textContent="⌖";$("#welcomeTitle").textContent="Your town square starts with a place.";messages.innerHTML='<div class="empty-messages"><div><span>⌖</span><strong>No room selected</strong><p>Use Find my rooms to begin.</p></div></div>';composer.classList.add("disabled");input.disabled=true;
}
async function loadRoomRegistry(){
 try{const response=await fetch("/api/rooms");const data=await response.json();rooms.splice(0,rooms.length);addRegistryRooms(data.rooms||[]);if(!rooms.length)return showEmptyDirectory();const preferred=rooms.find(room=>room.id===profile?.homeRoom)||rooms[0];selectRoom(preferred.id)}catch{toast("The room directory could not be loaded.")}
}

function renderLevelChoices(hierarchy,serverRooms){
 discoveredLevelRooms=serverRooms;const result=$("#geoResult");result.hidden=false;$(".geo-card").classList.add("has-levels");
 result.innerHTML=`<div class="geo-breadcrumb">${hierarchy.names.map((name,index)=>`${index?"<span>›</span>":""}<b>${escapeHtml(name)}</b>`).join("")}</div><div class="level-picker"><p>All of these rooms now exist. Choose where you want to enter:</p><div class="level-options">${serverRooms.map(room=>`<button class="level-option" data-enter-room="${escapeHtml(room.id)}"><span class="level-option-icon">${levelIcons[room.level]||"○"}</span><span class="level-option-copy"><strong>${escapeHtml(room.name)}</strong><small>${escapeHtml(levelLabels[room.level]||room.level)} room</small></span><span class="level-option-path">${escapeHtml(room.pathNames.join(" › "))}</span></button>`).join("")}</div></div><div class="accuracy-note">Your coordinates were used for this lookup and were not stored.</div>`;
 result.querySelectorAll("[data-enter-room]").forEach(button=>button.onclick=()=>enterLevelRoom(button.dataset.enterRoom,hierarchy));
}
function enterLevelRoom(roomId,hierarchy){
 const selected=discoveredLevelRooms.find(room=>room.id===roomId);if(!selected)return;
 addRegistryRooms(discoveredLevelRooms);profile={...(profile||{}),homeRoom:selected.id,localRoomIds:discoveredLevelRooms.map(room=>room.id),homeHierarchy:{country:hierarchy.country,state:hierarchy.state,district:hierarchy.district,locality:hierarchy.locality}};localStorage.setItem("nearby-profile",JSON.stringify(profile));localStorage.setItem("nearby-location-hierarchy",JSON.stringify(hierarchy));updateProfileUI();selectRoom(selected.id);closeGeoModal();toast(`Entered the ${selected.name} ${levelLabels[selected.level].toLowerCase()} room.`);
}

$(".geo-privacy span:last-child").innerHTML="<strong>Your coordinates are not saved</strong>They are used once to identify room names. The resulting country, state, district, and locality rooms are stored so the community can revisit them.";
$("#geoLocate").onclick=()=>{
 const button=$("#geoLocate"),errorBox=$("#geoError"),result=$("#geoResult");errorBox.hidden=true;result.hidden=true;
 if(!navigator.geolocation){errorBox.textContent="Location is not supported by this browser.";errorBox.hidden=false;return}
 button.disabled=true;button.textContent="Getting device location…";
 navigator.geolocation.getCurrentPosition(async position=>{
  try{
   button.textContent="Creating your room tree…";const{latitude,longitude,accuracy}=position.coords;
   const geoResponse=await fetch(`/api/reverse-geocode?lat=${encodeURIComponent(latitude)}&lon=${encodeURIComponent(longitude)}`),geoData=await geoResponse.json();if(!geoResponse.ok)throw new Error(geoData.error||"Location lookup failed");
   pendingHierarchy=normalizeLocation(geoData,accuracy);
   const roomResponse=await fetch("/api/rooms/discover",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({country:pendingHierarchy.country,countryCode:pendingHierarchy.countryCode,state:pendingHierarchy.state,district:pendingHierarchy.district,locality:pendingHierarchy.locality})}),roomData=await roomResponse.json();if(!roomResponse.ok)throw new Error(roomData.error||"Room creation failed");
   addRegistryRooms(roomData.rooms);renderLevelChoices(pendingHierarchy,roomData.rooms);button.textContent="Rooms ready";
  }catch(error){errorBox.textContent=error.message||"Rooms could not be created. Please try again.";errorBox.hidden=false;button.disabled=false;button.textContent="Try again"}
 },error=>{const messages={1:"Location permission is blocked. Allow it for localhost, then try again.",2:"Your device could not determine its location.",3:"The location request timed out."};errorBox.textContent=messages[error.code]||error.message;errorBox.hidden=false;button.disabled=false;button.textContent="Try again"},{enableHighAccuracy:true,timeout:20000,maximumAge:0});
};

loadRoomRegistry();
if(profile&&!Array.isArray(profile.localRoomIds))setTimeout(()=>openGeoModal(),350);
