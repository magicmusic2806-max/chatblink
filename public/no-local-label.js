queueMicrotask(()=>{
 updateProfileUI=function(){
  if(!profile)return;
  $("#sidebarName").textContent=profile.name;
  const lastRoom=rooms.find(room=>room.id===(profile.lastRoomId||profile.homeRoom));
  $("#sidebarLocation").textContent=lastRoom?`Last room · ${lastRoom.name}`:"Rooms found by location";
  const avatar=$("#sidebarAvatar");
  avatar.textContent=profile.photo?"":initials(profile.name);
  avatar.style.backgroundImage=profile.photo?`url(${profile.photo})`:"";
 };

 const openSelectedRoom=selectRoom;
 selectRoom=function(id){
  openSelectedRoom(id);
  const selected=rooms.find(room=>room.id===id);
  if(!selected)return;
  if(profile){profile.lastRoomId=id;localStorage.setItem("nearby-profile",JSON.stringify(profile));updateProfileUI()}
  $("#roomMeta").innerHTML=escapeHtml((selected.pathNames||[]).join(" · ")||selected.city||levelLabels[selected.level]||"Community room");
  $("#welcomeTitle").textContent=`${selected.name} community chat`;
 };

 enterLevelRoom=function(roomId,hierarchy){
  const selected=discoveredLevelRooms.find(room=>room.id===roomId);
  if(!selected)return;
  addRegistryRooms(discoveredLevelRooms);
  profile={...(profile||{}),lastRoomId:selected.id,localRoomIds:discoveredLevelRooms.map(room=>room.id),homeHierarchy:{country:hierarchy.country,state:hierarchy.state,district:hierarchy.district,locality:hierarchy.locality}};
  delete profile.homeRoom;
  localStorage.setItem("nearby-profile",JSON.stringify(profile));
  localStorage.setItem("nearby-location-hierarchy",JSON.stringify(hierarchy));
  updateProfileUI();selectRoom(selected.id);closeGeoModal();toast(`Opened ${selected.name}.`);
 };

 const existingHome=profile?.homeRoom;
 if(profile&&existingHome){profile.lastRoomId=profile.lastRoomId||existingHome;delete profile.homeRoom;localStorage.setItem("nearby-profile",JSON.stringify(profile));updateProfileUI()}
});
