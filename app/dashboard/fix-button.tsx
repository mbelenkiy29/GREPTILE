"use client";
import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import { launchFix } from "./actions";
export function FixButton({reviewId,findingId,label="Fix with AI",agent="codex"}: {reviewId:string;findingId?:string;label?:string;agent?:string}) {
 const [state,action,pending]=useActionState(launchFix,{});
 const [launch,setLaunch]=useState<{status:string;error?:string}>({status:"pending"});
 useEffect(()=>{
  if(!state.url)return;
  window.location.assign(state.url);
  let stopped=false;
  const poll=async()=>{
   try{const id=new URL(state.url!).searchParams.get("request");const response=await fetch("/api/fixes/"+id,{cache:"no-store"});if(!response.ok)throw new Error("Status unavailable");const result=await response.json();if(!stopped){setLaunch(result);if(["finished","failed","expired"].includes(result.status))clearInterval(timer);}}
   catch{if(!stopped){setLaunch({status:"unavailable",error:"Unable to read bridge status. Check your local bridge terminal."});clearInterval(timer);}}
  };
  const timer=setInterval(poll,2000);void poll();
  return ()=>{stopped=true;clearInterval(timer);};
 },[state.url]);
 return <div className="fix-control"><form action={action}><input type="hidden" name="reviewId" value={reviewId}/>{findingId&&<input type="hidden" name="findingId" value={findingId}/>}<label className="sr-only" htmlFor={`agent-${findingId??reviewId}`}>Coding agent</label><select id={`agent-${findingId??reviewId}`} name="agent" defaultValue={agent}><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="cursor">Cursor Agent</option></select><button className="primary" disabled={pending}>{pending?"Preparing…":label}</button></form>{state.error&&<p role="alert" className="error">{state.error}</p>}{state.url&&<p role="status">{launch.status === "finished" ? "Agent exited successfully. Review its diff and test output." : launch.status === "launched" ? "Agent launched." : launch.status === "claimed" ? "Bridge claimed the request; waiting for launch confirmation. Check the local terminal before retrying." : launch.status === "failed" ? "Agent failed: "+launch.error : launch.status === "expired" ? "Request expired. Click Fix to create another." : launch.status === "unavailable" ? launch.error : "Waiting for your local bridge."} <a href={state.url}>Open your agent</a>. <Link href="/dashboard/settings/agents">Bridge setup</Link> if no window opens. This does not mark the issue resolved.</p>}</div>;
}
