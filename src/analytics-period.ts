const day=86400000;
export function analyticsPeriod(since:string,until:string):{since:number;until:number}|{error:string}{
 const parse=(value:string)=>{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return NaN;
  const at=Date.parse(value+"T00:00:00.000Z");
  return Number.isFinite(at)&&new Date(at).toISOString().slice(0,10)===value?at:NaN;
 };
 const start=parse(since),end=parse(until)+day-1;
 if(!Number.isFinite(start)||!Number.isFinite(end))return {error:"Choose valid From and Through dates."};
 if(end<start)return {error:"Through must be on or after From."};
 if(end-start>366*day)return {error:"Choose a period of at most one year."};
 return {since:start,until:end};
}
