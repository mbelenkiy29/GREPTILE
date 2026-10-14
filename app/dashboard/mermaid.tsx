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
    const theme=document.documentElement.dataset.theme,dark=theme==="dark"||(theme!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);
    mermaid.initialize({startOnLoad:false,securityLevel:"strict",theme:"base",themeVariables:dark?{background:"#14120b",primaryColor:"#1b1913",primaryTextColor:"#edecec",primaryBorderColor:"#edecec33",lineColor:"#a09f9b",textColor:"#edecec",actorBkg:"#1b1913",actorBorder:"#edecec33",actorTextColor:"#edecec",signalColor:"#edecec",signalTextColor:"#edecec",noteBkgColor:"#26241e",noteTextColor:"#edecec",fontFamily:"Inter Variable, Inter, system-ui, sans-serif"}:{background:"#f7f7f4",primaryColor:"#f2f1ed",primaryTextColor:"#26251e",primaryBorderColor:"#26251e33",lineColor:"#64635c",textColor:"#26251e",actorBkg:"#f2f1ed",actorBorder:"#26251e33",actorTextColor:"#26251e",signalColor:"#26251e",signalTextColor:"#26251e",noteBkgColor:"#e6e5e0",noteTextColor:"#26251e",fontFamily:"Inter Variable, Inter, system-ui, sans-serif"}});
    const {svg}=await mermaid.render("sequence-"+Math.random().toString(36).slice(2),code);
    if(!cancelled&&ref.current){ref.current.innerHTML=svg;setState("ready");}
   }catch{if(!cancelled)setState("failed");}
  })();
  return()=>{cancelled=true;};
 },[code]);
 return <figure className="sequence-diagram" aria-label="Sequence diagram"><div ref={ref} hidden={state!=="ready"}/>{state!=="ready"&&<pre><code>{code}</code></pre>}{state==="failed"&&<figcaption className="muted">Diagram preview unavailable; Mermaid source shown.</figcaption>}</figure>;
}
