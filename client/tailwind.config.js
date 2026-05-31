/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  safelist: [
    // Ensure all custom surface + accent utilities are always generated
    // so @apply in index.css can reference them even in dev/JIT mode.
    { pattern: /^(bg|text|border|ring|shadow|fill|stroke|outline)-(surface|accent)/ },
    { pattern: /^focus(-visible)?:(ring|border|outline)-(surface|accent)/ },
    { pattern: /^hover:(bg|text|border)-(surface|accent)/ },
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['Geist Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      colors: {
        surface: {
          950: '#070a0f',
          900: '#0d1117',
          800: '#13181f',
          700: '#1c2330',
          600: '#252d3a',
          500: '#30394a',
        },
        accent: {
          DEFAULT: '#6e40c9',
          hi: '#7c50d9',
          light: '#a78bfa',
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
      },
      animation: {
        'slide-down': 'slideDown 150ms ease both',
        'pulse2': 'pulse2 1.5s ease-in-out infinite',
      },
      boxShadow: {
        'glow-accent': '0 0 16px -4px rgba(110, 64, 201, 0.4)',
      },
    },
  },
  plugins: [],
};
