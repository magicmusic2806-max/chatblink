currentChannel="local";

const communityTab=document.querySelector('.channel-tab[data-channel="local"]');
const openTab=document.querySelector('.channel-tab[data-channel="open"]');
if(communityTab)communityTab.innerHTML='<span>◎</span> Community <b>Everyone</b>';
if(openTab)openTab.hidden=true;
$("#channelNote").innerHTML='One shared conversation <span>•</span> Last 100 messages';
$("#visitorNotice").hidden=true;
$("#composerBadge").textContent="CHAT";

updatePermissions=function(){
 const hasRoom=Boolean(currentRoom?.id);
 $("#visitorNotice").hidden=true;
 composer.classList.toggle("disabled",!hasRoom);
 input.disabled=!hasRoom;
 input.placeholder=hasRoom?`Message ${currentRoom.name}…`:"Choose a room to begin";
};

const selectCommunityRoom=selectRoom;
selectRoom=function(id){
 currentChannel="local";
 if(profile&&id){
  const access=new Set(Array.isArray(profile.localRoomIds)?profile.localRoomIds:[]);
  access.add(id);
  profile.localRoomIds=[...access];
  localStorage.setItem("nearby-profile",JSON.stringify(profile));
 }
 selectCommunityRoom(id);
 if(communityTab)communityTab.classList.add("active");
 if(openTab)openTab.classList.remove("active");
 $("#channelNote").innerHTML='One shared conversation <span>•</span> Last 100 messages';
 $("#composerBadge").textContent="CHAT";
};

setChannel=function(){
 currentChannel="local";
 joinChannel();
 updatePermissions();
};

if(currentRoom?.id)updatePermissions();
