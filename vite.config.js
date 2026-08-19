import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

// The About card in Settings answers "has the PR I just merged actually reached
// my phone?". package.json's version alone can't tell you that, so the commit
// and the build time are baked in alongside it. Building outside a git checkout
// (a tarball, a CI export) must still work, hence the fallback.
function gitCommit() {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim() || 'dev'
  } catch {
    return 'dev'
  }
}

export default defineConfig({
  base: '/finesse-app/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_COMMIT__: JSON.stringify(gitCommit()),
    __APP_BUILT_AT__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Finesse',
        short_name: 'Finesse',
        description: 'Private local-first personal finance',
        theme_color: '#0a0f1e',
        background_color: '#0a0f1e',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/finesse-app/',
        start_url: '/finesse-app/',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
        // Long-press the installed icon to go straight to the two things people
        // actually open the app for. Handled by the ?action= check in App.jsx.
        shortcuts: [
          {
            name: 'Log an expense',
            short_name: 'Log expense',
            url: '/finesse-app/?action=log-expense',
            icons: [{ src: 'icons/icon-192.png', sizes: '192x192' }],
          },
          {
            name: 'Can I purchase it?',
            short_name: 'Can I buy it',
            url: '/finesse-app/?action=purchase-check',
            icons: [{ src: 'icons/icon-192.png', sizes: '192x192' }],
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/react-dom/') || id.includes('/react/')) return 'vendor-react';
          if (id.includes('/recharts/')) return 'vendor-recharts';
          if (id.includes('/dexie')) return 'vendor-dexie';
          if (id.includes('/date-fns/')) return 'vendor-datefns';
          if (id.includes('/lucide-react/')) return 'vendor-lucide';
        },
      },
    },
  },
})
