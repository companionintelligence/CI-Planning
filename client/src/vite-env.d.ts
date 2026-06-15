/// <reference types="vite/client" />

// Side-effect CSS imports (e.g. `import './index.css'`) are handled by Vite at
// build time; declare them so `tsc --noEmit` does not flag the import.
declare module '*.css';
