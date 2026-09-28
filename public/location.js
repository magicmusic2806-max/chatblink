let pendingHierarchy=null,roomLevelConfig={};
const slug=value=>String(value||"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
const escapeHtml=value=>String(value||"").replace(/[&<>"]/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[char]));

document.body.insertAdjacentHTML("beforeend",`
 <div class="geo-backdrop" id="geoModal" hidden>
  <section class="geo-card" role="dialog" aria-modal="true" aria-labelledby="geoTitle">
   <div class="geo-top"><div class="geo-icon">⌖</div><button class="geo-close" id="geoClose" aria-label="Close">×</button></div>
   <h2 id="geoTitle">Find your nearest town square</h2>
   <p>Nearby uses your device location once to identify your country, region, district, and town.</p>
   <div class="geo-privacy"><span>◉</span><span><strong>Your coordinates are not saved</strong>They are sent to our geocoding provider to identify place names, then discarded. Only the resulting room hierarchy is kept on this device.</span></div>
   <button class="geo-action" id="geoLocate">Use my precise location</button>
   <button class="geo-secondary" id="geoCancel">Not now</button>
   <div class="geo-error" id="geoError" hidden></div>
   <div class="geo-result" id="geoResult" hidden>
    <div class="geo-breadcrumb" id="geoBreadcrumb"></div>
    <div class="suggested-room"><small>RECOMMENDED DISTRICT ROOM</small><h3 id="geoRoomName"></h3><p id="geoRoomContext"></p></div>
    <button class="geo-confirm" id="geoConfirm">Use this as my local room</button>
    <div class="accuracy-note" id="accuracyNote"></div>
   </div>
  </section>
 </div>`);

fetch("/room-levels.json").then(response=>response.ok?response.json():{}).then(data=>roomLevelConfig=data).catch(()=>{});

function normalizeLocation(data,accuracy){
 const country=data.countryName||data.countryCode||"Unknown country";
 const countryCode=(data.countryCode||"XX").toUpperCase();
 const state=data.principalSubdivision||data.localityInfo?.administrative?.find(item=>item.adminLevel===4)?.name||"";
 const locality=data.city||data.locality||data.localityInfo?.informative?.find(item=>/city|town|village/i.test(item.description||""))?.name||"";
 const administrative=Array.isArray(data.localityInfo?.administrative)?data.localityInfo.administrative:[];
 const districtMatch=administrative.find(item=>{
  const label=`${item.description||""} ${item.name||""}`;
  return /district|county|borough|department|regency|municipality|local government area|arrondissement/i.test(label)&&![country,state,locality].includes(item.name);
 });
 const remaining=administrative.map(item=>item.name).filter(Boolean).filter(name=>![country,state,locality].includes(name));
 const district=districtMatch?.name||remaining.at(-1)||locality||state;
 const names=[country,state,district,locality].filter(Boolean).filter((name,index,array)=>array.indexOf(name)===index);
 const districtId=`${countryCode.toLowerCase()}/${slug(state||country)}/${slug(district)}`;
 const townId=locality&&locality!==district?`${districtId}/${slug(locality)}`:null;
 return {country,countryCode,state,district,locality,names,districtId,townId,accuracy:Math.round(accuracy),levels:roomLevelConfig[countryCode]||roomLevelConfig.default||[]};
}

function addDetectedRoom(hierarchy){
 let districtRoom=rooms.find(room=>room.id===hierarchy.districtId);
 if(!districtRoom){
  districtRoom={id:hierarchy.districtId,name:hierarchy.district,city:[hierarchy.state,hierarchy.country].filter(Boolean).join(", "),icon:hierarchy.district.slice(0,2).toUpperCase(),children:[]};rooms.unshift(districtRoom);
 }
 if(hierarchy.locality&&hierarchy.locality!==hierarchy.district&&!districtRoom.children.some(child=>child.id===hierarchy.townId))districtRoom.children.push({id:hierarchy.townId,name:hierarchy.locality,status:"Town room planned"});
 const select=$("#homeRoomSelect");
 if(![...select.options].some(option=>option.value===districtRoom.id))select.insertAdjacentHTML("afterbegin",`<option value="${escapeHtml(districtRoom.id)}">${escapeHtml(districtRoom.name)}, ${escapeHtml(districtRoom.city)}</option>`);
 renderRooms($("#roomSearch").value);return districtRoom;
}

renderRooms=function(filter=""){
 const query=filter.trim().toLowerCase(),visible=rooms.filter(room=>`${room.name} ${room.city}`.toLowerCase().includes(query));
 roomList.innerHTML=visible.length?visible.map(room=>`<div class="room-group"><button class="room-item ${room.id===currentRoom.id?"active":""}" data-room="${escapeHtml(room.id)}"><span class="room-symbol">${escapeHtml(room.icon)}</span><span class="room-copy"><strong>${escapeHtml(room.name)}</strong><span>${escapeHtml(room.city)}</span></span><span class="room-side">${escapeHtml(roomRelationship(room))}</span></button>${room.children?.length?`<button class="town-toggle" data-tree="${escapeHtml(room.id)}">▾ ${room.children.length} town-level room${room.children.length===1?"":"s"}</button><div class="town-list" data-children="${escapeHtml(room.id)}">${room.children.map(child=>`<button class="town-item" disabled>${escapeHtml(child.name)}<small>${escapeHtml(child.status)}</small></button>`).join("")}</div>`:""}</div>`).join(""):`<p class="empty-search">No matching place yet.</p>`;
 roomList.querySelectorAll("[data-room]").forEach(button=>button.onclick=()=>selectRoom(button.dataset.room));roomList.querySelectorAll("[data-tree]").forEach(button=>button.onclick=()=>roomList.querySelector(`[data-children="${CSS.escape(button.dataset.tree)}"]`)?.classList.toggle("open"));
};

function openGeoModal(){
 $("#geoModal").hidden=false;$("#geoError").hidden=true;$("#geoResult").hidden=true;$("#geoLocate").disabled=false;$("#geoLocate").textContent="Use my precise location";
}
function closeGeoModal(){$("#geoModal").hidden=true}
$("#locateButton").textContent="⌖ Find my rooms";$("#locateButton").onclick=openGeoModal;$("#geoClose").onclick=closeGeoModal;$("#geoCancel").onclick=closeGeoModal;

$("#geoLocate").onclick=()=>{
 const button=$("#geoLocate"),errorBox=$("#geoError");errorBox.hidden=true;$("#geoResult").hidden=true;
 if(!navigator.geolocation){errorBox.textContent="Location is not supported by this browser.";errorBox.hidden=false;return}
 button.disabled=true;button.textContent="Finding your district…";
 navigator.geolocation.getCurrentPosition(async position=>{
  try{
   const{latitude,longitude,accuracy}=position.coords;
   const endpoint=`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}&localityLanguage=en`;
   const response=await fetch(endpoint);if(!response.ok)throw new Error("Location lookup failed");
   pendingHierarchy=normalizeLocation(await response.json(),accuracy);addDetectedRoom(pendingHierarchy);
   $("#geoBreadcrumb").innerHTML=pendingHierarchy.names.map((name,index)=>`${index?"<span>›</span>":""}<b>${escapeHtml(name)}</b>`).join("");$("#geoRoomName").textContent=pendingHierarchy.district;$("#geoRoomContext").textContent=[pendingHierarchy.state,pendingHierarchy.country].filter(Boolean).join(", ");$("#accuracyNote").textContent=`Device accuracy was approximately ${pendingHierarchy.accuracy.toLocaleString()} metres. Coordinates have not been stored.`;$("#geoResult").hidden=false;button.textContent="Location found";
  }catch(error){errorBox.textContent="We found your coordinates but could not identify the district. Please try again.";errorBox.hidden=false;button.disabled=false;button.textContent="Try again"}
 },error=>{
  const messages={1:"Location permission was denied. Allow location access in your browser and try again.",2:"Your device could not determine its location.",3:"The location request timed out. Please try again."};errorBox.textContent=messages[error.code]||"Location could not be retrieved.";errorBox.hidden=false;button.disabled=false;button.textContent="Try again";
 },{enableHighAccuracy:true,timeout:15000,maximumAge:0});
};

$("#geoConfirm").onclick=()=>{
 if(!pendingHierarchy)return;const room=addDetectedRoom(pendingHierarchy);localStorage.setItem("nearby-location-hierarchy",JSON.stringify(pendingHierarchy));
 if(profile){profile.homeRoom=room.id;localStorage.setItem("nearby-profile",JSON.stringify(profile));updateProfileUI();selectRoom(room.id)}else{$("#homeRoomSelect").value=room.id;showOnboarding()}
 closeGeoModal();toast(`${room.name} is now your local district room.`);
};

try{const saved=JSON.parse(localStorage.getItem("nearby-location-hierarchy"));if(saved?.districtId){pendingHierarchy=saved;addDetectedRoom(saved)}}catch{}
renderRooms();
