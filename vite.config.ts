import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({ command }) => ({
  plugins: [react(), ...(command === 'serve' ? [{
    name: 'prism-local-development-csp',
    transformIndexHtml(html: string) {
      // Vite's React refresh preamble and local HMR socket are development-only.
      return html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';")
        .replace("connect-src 'self'", "connect-src 'self' ws://127.0.0.1:*");
    },
  }] : [])],
  base: './',
}));
