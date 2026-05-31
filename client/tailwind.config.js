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
          1:  '#ABD4D8',  // light teal
          2:  '#85c3b4',  // medium teal-green
          3:  '#58ebbf',  // bright mint — primary CTA
          4:  '#409b9b',  // medium teal — interactive accent
          5:  '#2c676d',  // dark teal
          6:  '#1d5f6e',  // deep teal-blue
          7:  '#0f717a',  // deep teal
          8:  '#079d99',  // vivid teal
          9:  '#82ffe1',  // neon mint — glow
          10: '#244859',  // dark navy-teal surface
          11: '#172e39',  // darkest hero bg
        },
        // App surfaces — teal-navy instead of blue-gray
        surface: {
          950: '#070d11',
          900: '#0a1520',
          800: '#0f1e2e',
          700: '#152637',
          600: '#1a3040',
          500: '#1f3a4a',
        },
        // Accent maps to CI teal
        accent: {
          DEFAULT: '#409b9b',  // c4 — borders, rings, badges
          hi:      '#58ebbf',  // c3 — CTA buttons
          light:   '#ABD4D8',  // c1 — text accent
          glow:    '#82ffe1',  // c9 — neon highlight
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
