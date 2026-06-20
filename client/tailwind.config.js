/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  safelist: [
    { pattern: /^(bg|text|border|ring|shadow|fill|stroke|outline)-(surface|ci|accent|primary|secondary|card|muted|destructive|sidebar|chart|tag)/ },
    { pattern: /^(hover|focus-visible):(bg|text|border|ring)-(surface|ci|accent|primary|secondary|card|muted|destructive|tag)/ },
  ],
  theme: {
    extend: {
      fontFamily: {
        // CI-Hub uses Montserrat across the org. Mono kept as a fallback for any code.
        sans:    ['Montserrat', 'system-ui', 'sans-serif'],
        heading: ['Montserrat', 'system-ui', 'sans-serif'],
        mono:    ['"Source Code Pro"', 'ui-monospace', 'monospace'],
      },
      // Radius scale keyed off the global --radius token (CI-Hub: 0.625rem).
      borderRadius: {
        sm: 'calc(var(--radius) - 4px)',
        md: 'calc(var(--radius) - 2px)',
        lg: 'var(--radius)',
        xl: 'calc(var(--radius) + 4px)',
      },
      colors: {
        // ── CI-Hub semantic design tokens (shared org system; flip light/dark via CSS vars) ──
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        card:        { DEFAULT: 'var(--card)', foreground: 'var(--card-foreground)' },
        popover:     { DEFAULT: 'var(--popover)', foreground: 'var(--popover-foreground)' },
        primary:     { DEFAULT: 'var(--primary)', foreground: 'var(--primary-foreground)' },
        secondary:   { DEFAULT: 'var(--secondary)', foreground: 'var(--secondary-foreground)' },
        muted:       { DEFAULT: 'var(--muted)', foreground: 'var(--muted-foreground)' },
        destructive: { DEFAULT: 'var(--destructive)', foreground: 'var(--destructive-foreground)' },
        border: 'var(--border)',
        input:  'var(--input)',
        ring:   'var(--ring)',
        sidebar: {
          DEFAULT: 'var(--sidebar)',
          foreground: 'var(--sidebar-foreground)',
          accent: 'var(--sidebar-accent)',
          border: 'var(--sidebar-border)',
          ring: 'var(--sidebar-ring)',
        },
        chart: { 1: 'var(--chart-1)', 2: 'var(--chart-2)', 3: 'var(--chart-3)', 4: 'var(--chart-4)', 5: 'var(--chart-5)' },
        // Tag palette bases (categorical labels only — see index.css). Variants via var(--tag-N-*).
        tag: {
          1: 'var(--tag-1)', 2: 'var(--tag-2)', 3: 'var(--tag-3)', 4: 'var(--tag-4)',
          5: 'var(--tag-5)', 6: 'var(--tag-6)', 7: 'var(--tag-7)', 8: 'var(--tag-8)',
          9: 'var(--tag-9)', 10: 'var(--tag-10)', 11: 'var(--tag-11)', 12: 'var(--tag-12)',
        },

        // ── Legacy scales remapped onto the tokens so existing utilities theme automatically ──
        // surface-* (page → lines) now resolves to themed surfaces instead of fixed hex.
        surface: {
          950: 'var(--background)', // page background
          900: 'var(--sidebar)',    // nav / top-bar chrome
          800: 'var(--card)',       // cards, modals, popovers
          700: 'var(--border)',     // dividers, nav hover/active, subtle fills
          600: 'var(--input)',      // input / control borders (lighter)
          500: 'var(--input)',
        },
        // slate-* text shades map onto themed text tokens so text flips in light mode,
        // preserving hierarchy: 50–200 = prominent (headings), 300–400 = body,
        // 500–700 = muted/secondary. 800–950 cover the rare bg-slate-* usage.
        slate: {
          50: 'var(--secondary-foreground)', 100: 'var(--secondary-foreground)', 200: 'var(--secondary-foreground)',
          300: 'var(--foreground)', 400: 'var(--foreground)',
          500: 'var(--muted-foreground)', 600: 'var(--muted-foreground)', 700: 'var(--muted-foreground)',
          800: 'var(--card)', 900: 'var(--sidebar)', 950: 'var(--background)',
        },
        // Signature CI teal scale — constant across modes (brand accent: CTA, focus, glow).
        ci: {
          1: '#ABD4D8', 2: '#85c3b4', 3: '#58ebbf', 4: '#409b9b', 5: '#2c676d',
          6: '#1d5f6e', 7: '#0f717a', 8: '#079d99', 9: '#82ffe1', 10: '#244859', 11: '#172e39',
        },
        // accent-* kept as the bright legacy teal for rings/badges; sub-keys unchanged.
        accent: { DEFAULT: '#409b9b', hi: '#58ebbf', light: '#ABD4D8', glow: '#82ffe1' },
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
