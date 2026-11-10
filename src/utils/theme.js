/**
 * Day / night theme. The theme is one attribute on <html>
 * (data-theme="dark"); every colour on the site is a CSS variable that the
 * attribute swaps (src/styles/globals.css). Day is the default; the choice
 * is remembered in this browser.
 */
import { useCallback, useEffect, useState } from 'react';

export const THEME_KEY = 'theme';
const EVENT = 'themechange';
const CHROME = { light: '#F7F8FA', dark: '#0B1220' };

/**
 * Runs before the page paints (see _document.js) so a visitor who chose
 * night never sees a flash of day.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{if(localStorage.getItem('${THEME_KEY}')==='dark'){document.documentElement.setAttribute('data-theme','dark');}}catch(e){}})();`;

export function currentTheme() {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

/** Switch the page to `theme` ('light' | 'dark'), remember it and tell every listener. */
export function applyTheme(theme) {
  if (typeof document === 'undefined') return;
  const next = theme === 'dark' ? 'dark' : 'light';
  const root = document.documentElement;
  // A short cross-fade for the switch itself; removed so it never slows normal hovers.
  root.classList.add('theme-fade');
  if (next === 'dark') root.setAttribute('data-theme', 'dark'); else root.removeAttribute('data-theme');
  window.setTimeout(() => root.classList.remove('theme-fade'), 320);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', CHROME[next]);
  try { window.localStorage.setItem(THEME_KEY, next); } catch { /* private mode: the choice lasts for this page only */ }
  window.dispatchEvent(new Event(EVENT));
}

/** [theme, toggle]: the current theme, kept in step across components and tabs. */
export function useTheme() {
  // The server and the first client render agree on 'light'; the real value follows at once.
  const [theme, setTheme] = useState('light');
  useEffect(() => {
    const sync = () => setTheme(currentTheme());
    const onStorage = (e) => {
      if (e.key !== THEME_KEY) return;
      if ((e.newValue === 'dark') !== (currentTheme() === 'dark')) applyTheme(e.newValue === 'dark' ? 'dark' : 'light');
    };
    sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', onStorage);
    return () => { window.removeEventListener(EVENT, sync); window.removeEventListener('storage', onStorage); };
  }, []);
  const toggle = useCallback(() => applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'), []);
  return [theme, toggle];
}
