const originalNormalizeLocation=normalizeLocation;
normalizeLocation=function(data,accuracy){
 const hierarchy=originalNormalizeLocation(data,accuracy);
 const preciseTown=String(data.nearbyPopulatedPlace?.name||"").trim();
 if(!preciseTown)return hierarchy;
 hierarchy.locality=preciseTown;
 hierarchy.localityType=data.nearbyPopulatedPlace.type||"locality";
 hierarchy.names=[hierarchy.country,hierarchy.state,hierarchy.district,preciseTown].filter(Boolean).filter((name,index,array)=>array.indexOf(name)===index);
 hierarchy.townId=`${hierarchy.districtId}/${hierarchy.localityType}:${slug(preciseTown)}`;
 return hierarchy;
};

levelLabels.locality="Town / locality";
