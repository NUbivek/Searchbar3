/** @jest-environment jsdom */
/**
 * Day / night theme: the switch sets one attribute on <html>, remembers the
 * choice, and the boot script restores it before the page paints.
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { applyTheme, currentTheme, THEME_BOOT_SCRIPT, THEME_KEY } from '../../src/utils/theme';
import { ThemeToggle } from '../../src/components/layout/PageShell';

jest.mock('next/head', () => function Head({ children }) { return <>{children}</>; });
jest.mock('next/link', () => function Link({ children, href, ...props }) { return <a href={href} {...props}>{children}</a>; });
jest.mock('next/router', () => ({ useRouter: () => ({ pathname: '/', query: {} }) }));
jest.mock('next-auth/react', () => ({ useSession: () => ({ data: null, status: 'unauthenticated' }) }));
jest.mock('../../src/components/account/AccountMenu', () => function AccountMenu() { return <div>account</div>; });

describe('theme', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme');
    window.localStorage.clear();
  });

  test('day is the default; applyTheme switches, remembers and can switch back', () => {
    expect(currentTheme()).toBe('light');
    applyTheme('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem(THEME_KEY)).toBe('dark');
    expect(currentTheme()).toBe('dark');
    applyTheme('light');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(window.localStorage.getItem(THEME_KEY)).toBe('light');
    // anything unexpected falls back to day
    applyTheme('sepia');
    expect(currentTheme()).toBe('light');
  });

  test('the boot script restores a remembered night theme and leaves day alone', () => {
    // eslint-disable-next-line no-eval
    (0, eval)(THEME_BOOT_SCRIPT);
    expect(currentTheme()).toBe('light');
    window.localStorage.setItem(THEME_KEY, 'dark');
    // eslint-disable-next-line no-eval
    (0, eval)(THEME_BOOT_SCRIPT);
    expect(currentTheme()).toBe('dark');
  });

  test('the toggle is a switch that flips the theme and reports its state', () => {
    render(<ThemeToggle />);
    const toggle = screen.getByRole('switch', { name: 'Night mode' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    act(() => { fireEvent.click(toggle); });
    expect(currentTheme()).toBe('dark');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.getAttribute('title')).toBe('Switch to day mode');
    act(() => { fireEvent.click(toggle); });
    expect(currentTheme()).toBe('light');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  test('every colour token has a night value', () => {
    const css = require('fs').readFileSync(require('path').join(__dirname, '../../src/styles/globals.css'), 'utf8');
    const day = css.slice(css.indexOf(':root {'), css.indexOf(":root[data-theme='dark'] {"));
    const night = css.slice(css.indexOf(":root[data-theme='dark'] {"), css.indexOf('@media print'));
    const names = (block) => [...block.matchAll(/(--c-[a-z0-9-]+):/g)].map((m) => m[1]).sort();
    expect(names(day).length).toBeGreaterThan(40);
    expect(names(night)).toEqual(names(day));
  });
});
