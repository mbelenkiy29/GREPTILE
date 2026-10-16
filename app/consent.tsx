"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { startAnalytics, stopAnalytics } from "../src/analytics";
import { consentCookieValue, consentReopenEvent, needsChoice, type Consent } from "../src/consent";
import { posthogToken } from "../src/telemetry";

const signals = () => navigator as Navigator & { globalPrivacyControl?: boolean };

/** Cookie consent for analytics: shown until the visitor chooses, and again from "Cookie settings". */
export function ConsentBanner() {
  const [open, setOpen] = useState(false);
  const first = useRef<HTMLButtonElement>(null), focusNext = useRef(false);
  useEffect(() => {
    // Decided after mount: the cookie and browser signals are only known in the browser.
    setOpen(needsChoice(Boolean(posthogToken), document.cookie, signals()));
    const reopen = () => { focusNext.current = true; setOpen(Boolean(posthogToken)); };
    window.addEventListener(consentReopenEvent, reopen);
    return () => window.removeEventListener(consentReopenEvent, reopen);
  }, []);
  // Reopened from "Cookie settings": move focus into the banner. A first visit never steals focus.
  useEffect(() => {
    if (open && focusNext.current) { focusNext.current = false; first.current?.focus(); }
  }, [open]);
  if (!open) return null;
  const choose = (choice: Consent) => {
    document.cookie = consentCookieValue(choice, location.protocol === "https:");
    if (choice === "granted") startAnalytics();
    else stopAnalytics();
    setOpen(false);
  };
  return <section className="consent" aria-labelledby="consent-heading">
    <h2 id="consent-heading">Analytics cookie</h2>
    <p>May we use a cookie to count visits and see which features people use? No ads, and no tracking on other sites. See the <Link href="/privacy">Privacy Policy</Link>.</p>
    <div className="consent-actions">
      <button ref={first} type="button" onClick={() => choose("denied")}>Decline</button>
      <button type="button" onClick={() => choose("granted")}>Accept</button>
    </div>
  </section>;
}

/** Footer link that reopens the banner so a visitor can change their choice. */
export function CookieSettings() {
  if (!posthogToken) return null;
  return <> · <button type="button" className="link-button" onClick={() => window.dispatchEvent(new Event(consentReopenEvent))}>Cookie settings</button></>;
}
