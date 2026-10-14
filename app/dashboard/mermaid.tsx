"use client";
import {useEffect,useRef,useState} from "react";
// Renders OpenReview's validated sequence-diagram subset with Mermaid (strict security, lazily
// loaded); the Mermaid source stays visible if rendering is unavailable.
export function MermaidDiagram({code}:{code:string}){
 const ref=useRef<HTMLDivElement>(null),[state,setState]=useState<"loading"|"ready"|"failed">("loading");
 useEffect(()=>{
  let cancelled=false;
  (async()=>{
   try{
    const {default:mermaid}=await import("mermaid");
    mermaid.initialize({startOnLoad:false,securityLevel:"strict",theme:document.documentElement.dataset.theme==="dark"?"dark":"default"});
    const {svg}=await mermaid.render("sequence-"+Math.random().toString(36).slice(2),code);
    if(!cancelled&&ref.current){ref.current.innerHTML=svg;setState("ready");}
   }catch{if(!cancelled)setState("failed");}
  })();
  return()=>{cancelled=true;};
 },[code]);
 return <figure className="sequence-diagram" aria-label="Sequence diagram"><div ref={ref} hidden={state!=="ready"}/>{state!=="ready"&&<pre><code>{code}</code></pre>}{state==="failed"&&<figcaption className="muted">Diagram preview unavailable; Mermaid source shown.</figcaption>}</figure>;
}
