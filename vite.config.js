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
        // Long-press the installed icon to go straight to the thing people
        // actually open the app for. Handled by the ?action= check in App.jsx.
        shortcuts: [
          {
            name: 'Log an expense',
            short_name: 'Log expense',
            url: '/finesse-app/?action=log-expense',
            icons: [{ src: 'icons/icon-192.png', sizes: '192x192' }],
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,woff2}'],
        // The OCR statement import is opt-in and rarely opened, but its
        // worker script and wasm core sit under public/tesseract/, and pdf.js
        // plus tesseract.js are real weight (pdf.js alone is ~130KB gzipped)
        // — all of it would otherwise match the glob above and get pulled
        // into every install and every update. It's fetched (and then cached
        // below) only the first time someone actually opens that flow.
        globIgnores: ['tesseract/**', 'assets/vendor-pdf-*.js', 'assets/vendor-ocr-*.js'],
        runtimeCaching: [
          {
            // Tesseract's worker/core/language files, pdf.js's worker, and
            // the vendor-pdf/vendor-ocr script chunks — all same-origin, none
            // precached (see globIgnores above), all cached after first use
            // so OCR import keeps working offline from then on.
            urlPattern: ({ url, sameOrigin }) => (
              sameOrigin && (
                url.pathname.includes('/tesseract/')
                || /\/pdf\.worker[^/]*\.mjs$/.test(url.pathname)
                || /\/(vendor-pdf|vendor-ocr)-[^/]*\.js$/.test(url.pathname)
              )
            ),
            handler: 'CacheFirst',
            options: {
              cacheName: 'ocr-assets',
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
    // 'hidden' writes .map files without a //# sourceMappingURL comment, so
    // browsers never fetch them — they exist only for a developer who has
    // the dist output (or CI artefact) from this exact build to map a raw
    // stack trace back to real source. A device that can't run devtools
    // (an iPhone with no Mac to hand) can still report a stack; this is
    // what makes that report worth anything.
    sourcemap: 'hidden',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/react-dom/') || id.includes('/react/')) return 'vendor-react';
          if (id.includes('/recharts/')) return 'vendor-recharts';
          if (id.includes('/dexie')) return 'vendor-dexie';
          if (id.includes('/date-fns/')) return 'vendor-datefns';
          if (id.includes('/lucide-react/')) return 'vendor-lucide';
          // Argon2 and AES only change when the crypto libraries do, and the
          // unlock path pulls them in on every launch — worth its own chunk so
          // an app update doesn't re-download them.
          if (id.includes('/@noble/')) return 'vendor-crypto';
          // pdf.js and tesseract.js are only ever reached via a dynamic
          // import() from the statement-OCR flow — their own chunk keeps them
          // out of every other page's download.
          if (id.includes('/pdfjs-dist/')) return 'vendor-pdf';
          if (id.includes('/tesseract.js/') || id.includes('/tesseract.js-core/')) return 'vendor-ocr';
        },
      },
    },
  },
})
