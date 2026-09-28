const baseNormalizeLocation=normalizeLocation;
normalizeLocation=function(data,accuracy){
 const hierarchy=baseNormalizeLocation(data,accuracy);
 const place=data.containingLocality;
 if(!place?.name)throw new Error("A containing city, town, or village was not returned for this position.");
 hierarchy.locality=String(place.name).trim();
 hierarchy.localityType=place.type;
 hierarchy.names=[hierarchy.country,hierarchy.state,hierarchy.district,hierarchy.locality].filter(Boolean).filter((name,index,array)=>array.indexOf(name)===index);
 hierarchy.townId=`${hierarchy.districtId}/${slug(place.type)}:${slug(hierarchy.locality)}`;
 return hierarchy;
};

levelLabels.locality="Locality";
