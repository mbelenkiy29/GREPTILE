"use client";

import {createContext,useContext,useEffect,useSyncExternalStore,type ReactNode} from "react";
import {readTheme,themeCookieValue,type Theme} from "../src/theme";

const ThemeContext=createContext<{theme:Theme;select:(theme:Theme)=>void}|null>(null);

// Pages are prerendered, so the server renders System and the browser reads the saved choice. The
// <head> script in app/layout.tsx has already applied it to <html> before first paint.
let chosen:Theme|undefined;
const listeners=new Set<()=>void>();
const subscribe=(listener:()=>void)=>{listeners.add(listener);return ()=>{listeners.delete(listener);};};
const current=()=>chosen??readTheme(document.cookie);

export function ThemeProvider({children}:{children:ReactNode}) {
  const theme=useSyncExternalStore(subscribe,current,()=>"system" as const);
  // If React ever renders <html> again from scratch it drops the script's attribute; put it back.
  useEffect(()=>{const root=document.documentElement,saved=current();if(root.dataset.theme!==saved)root.dataset.theme=saved;},[]);
  function select(value:Theme) {
    chosen=value;
    document.documentElement.dataset.theme=value;
    document.cookie=themeCookieValue(value,location.protocol==="https:");
    listeners.forEach(listener=>listener());
  }
  return <ThemeContext.Provider value={{theme,select}}>{children}</ThemeContext.Provider>;
}

export function ThemePicker() {
  const preference=useContext(ThemeContext);
  if(!preference)return null;
  return <label>Appearance<select aria-label="Appearance" value={preference.theme} onChange={event=>{
    const value=event.target.value;
    if(value==="system"||value==="light"||value==="dark")preference.select(value);
  }}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>;
}
