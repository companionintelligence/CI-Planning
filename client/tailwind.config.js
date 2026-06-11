/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  safelist: [
    { pattern: /^(bg|text|border|ring|shadow|fill|stroke|outline)-(surface|ci|accent)/ },
    { pattern: /^(hover|focus-visible):(bg|text|border|ring)-(surface|ci|accent)/ },
  ],
  theme: {
    extend: {
      fontFamily: {
        // CI uses Source Code Pro as primary + Abel for headings
        sans:    ['"Source Code Pro"', 'ui-monospace', 'monospace'],
        heading: ['Abel', '"Source Code Pro"', 'sans-serif'],
        mono:    ['"Source Code Pro"', 'ui-monospace', 'monospace'],
      },
      colors: {
        // CI exact palette (from CSS variables)
        ci: {
          1:  'var(--ci-1)',
          2:  'var(--ci-2)',
          3:  'var(--ci-3)',
          4:  'var(--ci-4)',
          5:  'var(--ci-5)',
          6:  'var(--ci-6)',
          7:  'var(--ci-7)',
          8:  'var(--ci-8)',
          9:  'var(--ci-9)',
          10: 'var(--ci-10)',
          11: 'var(--ci-11)',
        },
        // App surfaces — teal-navy instead of blue-gray
        surface: {
          950: 'var(--bg-950)',
          900: 'var(--bg-900)',
          800: 'var(--bg-800)',
          700: 'var(--bg-700)',
          600: 'var(--bg-600)',
          500: 'var(--bg-500)',
        },
        // Accent maps to CI teal
        accent: {
          DEFAULT: 'var(--accent)',
          hi:      'var(--accent-hi)',
          light:   'var(--accent-light)',
          glow:    'var(--accent-glow)',
        },
      },
      keyframes: {
        slideDown: {
          from: { opacity: '0', transform: 'translateY(-4px)' },
          to:   { opacity: '1', transform: 'translateY(0)' },
        },
        pulse2: {
          '0%, 100%': { opacity: '1' },
          '50%':       { opacity: '0.4' },
        },
        glow: {
          '0%, 100%': { 'box-shadow': '0 0 8px rgba(88,235,191,.3)' },
          '50%':       { 'box-shadow': '0 0 20px rgba(88,235,191,.6)' },
        },
      },
      animation: {
        'slide-down': 'slideDown 150ms ease both',
        'pulse2':     'pulse2 1.5s ease-in-out infinite',
        'glow':       'glow 2s ease-in-out infinite',
      },
      boxShadow: {
        'glow-ci':    '0 0 20px -4px rgba(88,235,191,.35)',
        'glow-ci-lg': '0 0 32px -4px rgba(88,235,191,.5)',
      },
    },
  },
  plugins: [],
};
