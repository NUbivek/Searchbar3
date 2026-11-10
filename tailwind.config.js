/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
      },
      colors: {
        // Design tokens (see DESIGN.md). Every colour the site uses is a CSS
        // variable (src/styles/globals.css), so the night theme is one
        // override block rather than a class on every element.
        ink: 'rgb(var(--c-ink) / <alpha-value>)',
        muted: 'rgb(var(--c-muted) / <alpha-value>)',
        line: 'rgb(var(--c-line) / <alpha-value>)',
        canvas: 'rgb(var(--c-canvas) / <alpha-value>)',
        surface: 'rgb(var(--c-white) / <alpha-value>)',
        // "white" is the surface colour: white by day, a dark panel at night.
        // Text set in it sits on ink or on an accent, and flips with them.
        white: 'rgb(var(--c-white) / <alpha-value>)',
        brand: { 50: 'rgb(var(--c-brand-50) / <alpha-value>)', 100: 'rgb(var(--c-brand-100) / <alpha-value>)', 200: 'rgb(var(--c-brand-200) / <alpha-value>)', 300: 'rgb(var(--c-brand-300) / <alpha-value>)', 400: 'rgb(var(--c-brand-400) / <alpha-value>)', 500: 'rgb(var(--c-brand-500) / <alpha-value>)', 600: 'rgb(var(--c-brand-600) / <alpha-value>)', 700: 'rgb(var(--c-brand-700) / <alpha-value>)' },
        accent: 'rgb(var(--c-brand-500) / <alpha-value>)',
        slate: { 50: 'rgb(var(--c-slate-50) / <alpha-value>)', 100: 'rgb(var(--c-slate-100) / <alpha-value>)', 200: 'rgb(var(--c-slate-200) / <alpha-value>)', 300: 'rgb(var(--c-slate-300) / <alpha-value>)', 400: 'rgb(var(--c-slate-400) / <alpha-value>)', 500: 'rgb(var(--c-slate-500) / <alpha-value>)', 600: 'rgb(var(--c-slate-600) / <alpha-value>)', 700: 'rgb(var(--c-slate-700) / <alpha-value>)', 800: 'rgb(var(--c-slate-800) / <alpha-value>)', 900: 'rgb(var(--c-slate-900) / <alpha-value>)' },
        rose: { 50: 'rgb(var(--c-rose-50) / <alpha-value>)', 100: 'rgb(var(--c-rose-100) / <alpha-value>)', 200: 'rgb(var(--c-rose-200) / <alpha-value>)', 300: 'rgb(var(--c-rose-300) / <alpha-value>)', 400: 'rgb(var(--c-rose-400) / <alpha-value>)', 500: 'rgb(var(--c-rose-500) / <alpha-value>)', 600: 'rgb(var(--c-rose-600) / <alpha-value>)', 700: 'rgb(var(--c-rose-700) / <alpha-value>)', 800: 'rgb(var(--c-rose-800) / <alpha-value>)', 900: 'rgb(var(--c-rose-900) / <alpha-value>)' },
        amber: { 50: 'rgb(var(--c-amber-50) / <alpha-value>)', 100: 'rgb(var(--c-amber-100) / <alpha-value>)', 200: 'rgb(var(--c-amber-200) / <alpha-value>)', 300: 'rgb(var(--c-amber-300) / <alpha-value>)', 400: 'rgb(var(--c-amber-400) / <alpha-value>)', 500: 'rgb(var(--c-amber-500) / <alpha-value>)', 600: 'rgb(var(--c-amber-600) / <alpha-value>)', 700: 'rgb(var(--c-amber-700) / <alpha-value>)', 800: 'rgb(var(--c-amber-800) / <alpha-value>)', 900: 'rgb(var(--c-amber-900) / <alpha-value>)' },
        emerald: { 50: 'rgb(var(--c-emerald-50) / <alpha-value>)', 100: 'rgb(var(--c-emerald-100) / <alpha-value>)', 200: 'rgb(var(--c-emerald-200) / <alpha-value>)', 300: 'rgb(var(--c-emerald-300) / <alpha-value>)', 400: 'rgb(var(--c-emerald-400) / <alpha-value>)', 500: 'rgb(var(--c-emerald-500) / <alpha-value>)', 600: 'rgb(var(--c-emerald-600) / <alpha-value>)', 700: 'rgb(var(--c-emerald-700) / <alpha-value>)', 800: 'rgb(var(--c-emerald-800) / <alpha-value>)', 900: 'rgb(var(--c-emerald-900) / <alpha-value>)' },
        // legacy names still used by older components
        primary: 'rgb(var(--c-ink) / <alpha-value>)',
        border: 'rgb(var(--c-line) / <alpha-value>)',
        'gray-text': 'rgb(var(--c-muted) / <alpha-value>)',
        'light-bg': 'rgb(var(--c-canvas) / <alpha-value>)',
      },
      boxShadow: {
        card: 'var(--shadow-card)',
        float: 'var(--shadow-float)',
        ring: '0 0 0 4px rgba(61, 106, 150, 0.15)',
      },
      borderRadius: {
        xl2: '1rem',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(16px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        glow: {
          '0%, 100%': { opacity: '0.55' },
          '50%': { opacity: '1' },
        },
      },
      animation: {
        fadeIn: 'fadeIn 0.25s ease-out forwards',
        slideUp: 'slideUp 0.4s ease-out forwards',
        shimmer: 'shimmer 1.6s linear infinite',
        glow: 'glow 2.4s ease-in-out infinite',
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.4s ease-out',
      },
    },
  },
  plugins: [],
};
