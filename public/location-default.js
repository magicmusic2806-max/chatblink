const homeAreaLabel=$("#homeRoomSelect").closest("label");
homeAreaLabel.hidden=true;
homeAreaLabel.setAttribute("aria-hidden","true");

const onboardingSubmit=$("#onboardingForm .primary-button");
onboardingSubmit.innerHTML='Continue to find my room <span>→</span>';

$("#onboardingForm").onsubmit=event=>{
 event.preventDefault();
 const data=new FormData(event.currentTarget);
 profile={name:String(data.get("name")||"").trim(),age:Number(data.get("age")),homeRoom:profile?.homeRoom||"",photo:photoData};
 localStorage.setItem("nearby-profile",JSON.stringify(profile));
 $("#onboardingModal").classList.add("hidden");
 updateProfileUI();
 openGeoModal();
};

const originalGeoConfirm=$("#geoConfirm").onclick;
$("#geoConfirm").onclick=()=>{
 originalGeoConfirm();
 if(profile?.homeRoom)$("#sidebarLocation").textContent=`${rooms.find(room=>room.id===profile.homeRoom)?.name||"Local room"} · Local`;
};
