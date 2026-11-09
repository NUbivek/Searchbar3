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
        // Design tokens (see DESIGN.md)
        ink: '#0F172A',
        muted: '#64748B',
        line: '#E6E8EF',
        canvas: '#F7F8FA',
        brand: {
          50: '#F2F6FA',
          100: '#E3EBF3',
          200: '#C7D6E6',
          300: '#9DB6CF',
          400: '#6B8FB5',
          500: '#3D6A96',
          600: '#2F567C',
          700: '#244463',
        },
        accent: '#3D6A96',
        // legacy names still used by older components
        primary: '#111827',
        border: '#E6E8EF',
        'gray-text': '#64748B',
        'light-bg': '#F6F7FB',
      },
      boxShadow: {
        card: '0 1px 2px rgba(15, 23, 42, 0.04), 0 8px 24px -12px rgba(15, 23, 42, 0.12)',
        float: '0 12px 40px -12px rgba(15, 23, 42, 0.18)',
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
