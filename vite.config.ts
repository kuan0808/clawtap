import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      manifest: {
        name: 'ClawTap',
        short_name: 'ClawTap',
        description: 'Control Claude Code from your phone',
        theme_color: '#09090b',
        background_color: '#09090b',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        icons: [
          { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: '/maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          {
            name: 'New Chat',
            short_name: 'New',
            url: '/?action=newchat',
            icons: [{ src: '/pwa-192x192.png', sizes: '192x192' }],
          },
        ],
        categories: ['developer-tools', 'productivity'],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,svg,woff2}', 'favicon-*.png', 'apple-touch-icon.png', 'badge-*.png', 'mascot/*.png'],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: true,
    proxy: {
      '/api': {
        target: 'https://localhost:3456',
        secure: false,
      },
      '/ws': {
        target: 'wss://localhost:3456',
        ws: true,
        secure: false,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
