$("#geoLocate").onclick=()=>{
 const button=$("#geoLocate"),errorBox=$("#geoError"),result=$("#geoResult");
 errorBox.hidden=true;result.hidden=true;
 if(!navigator.geolocation){errorBox.textContent="Location is not supported by this browser.";errorBox.hidden=false;return}
 button.disabled=true;button.textContent="Getting device location…";
 navigator.geolocation.getCurrentPosition(async position=>{
  try{
   button.textContent="Finding your district…";
   const{latitude,longitude,accuracy}=position.coords;
   const response=await fetch(`/api/reverse-geocode?lat=${encodeURIComponent(latitude)}&lon=${encodeURIComponent(longitude)}`,{headers:{Accept:"application/json"}});
   const data=await response.json();
   if(!response.ok)throw new Error(data.error||"District lookup failed");
   pendingHierarchy=normalizeLocation(data,accuracy);
   if(!pendingHierarchy.district||pendingHierarchy.district==="Unknown country")throw new Error("No district was returned for this location");
   addDetectedRoom(pendingHierarchy);
   $("#geoBreadcrumb").innerHTML=pendingHierarchy.names.map((name,index)=>`${index?"<span>›</span>":""}<b>${escapeHtml(name)}</b>`).join("");
   $("#geoRoomName").textContent=pendingHierarchy.district;
   $("#geoRoomContext").textContent=[pendingHierarchy.state,pendingHierarchy.country].filter(Boolean).join(", ");
   $("#accuracyNote").textContent=`Device accuracy was approximately ${pendingHierarchy.accuracy.toLocaleString()} metres. Coordinates have not been stored.`;
   result.hidden=false;button.textContent="District found";
  }catch(error){errorBox.textContent=error.message||"Your district could not be identified. Please try again.";errorBox.hidden=false;button.disabled=false;button.textContent="Try again"}
 },error=>{
  const messages={1:"Location permission is blocked. Allow it for localhost in your browser, then try again.",2:"Your device could not determine its location. Check that Windows location services are enabled.",3:"The location request timed out. Try again near a window or with Wi-Fi enabled."};
  errorBox.textContent=messages[error.code]||`Location error: ${error.message}`;errorBox.hidden=false;button.disabled=false;button.textContent="Try again";
 },{enableHighAccuracy:true,timeout:20000,maximumAge:0});
};
