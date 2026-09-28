queueMicrotask(()=>{
 if(profile?.lastRoomId&&!profile.homeRoom)profile.homeRoom=profile.lastRoomId;
 const rememberRoomInternally=selectRoom;
 selectRoom=function(id){
  if(profile&&id)profile.homeRoom=id;
  rememberRoomInternally(id);
 };
});
