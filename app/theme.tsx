"use client";

import {createContext,useContext,useState,type ReactNode} from "react";

export type Theme = "system" | "light" | "dark";
const ThemeContext=createContext<{theme:Theme;select:(theme:Theme)=>void}|null>(null);

export function ThemeProvider({initial,children}:{initial:Theme;children:ReactNode}) {
  const [theme,setTheme]=useState(initial);
  function select(value:Theme) {
    document.documentElement.dataset.theme=value;
    document.cookie=`openreview_theme=${value}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol==="https:"?"; Secure":""}`;
    setTheme(value);
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
