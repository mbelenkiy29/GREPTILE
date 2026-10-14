'use client';
import React,{useId,type ReactNode} from 'react';
/** Keep horizontal table navigation available without intercepting keys in its links or controls. */
export function ScrollTable({label,children}:{label:string;children:ReactNode}){
 const hint=useId();
 return <><p id={hint} className="sr-only">Use left and right arrow keys to scroll columns. Home shows the first column; End shows the last.</p><div className="table-wrap" role="region" aria-label={label} aria-describedby={hint} tabIndex={0} onKeyDown={event=>{
  if(event.target!==event.currentTarget||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;
  const region=event.currentTarget;
  if(event.key==='ArrowRight')region.scrollLeft+=64;
  else if(event.key==='ArrowLeft')region.scrollLeft-=64;
  else if(event.key==='Home')region.scrollLeft=0;
  else if(event.key==='End')region.scrollLeft=region.scrollWidth;
  else return;
  event.preventDefault();
 }}>{children}</div></>;
}
