import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { VitePWA, type VitePWAOptions } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

export function isPwaEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.VITE_PWA !== '0';
}

export const pwaOptions: Partial<VitePWAOptions> = {
  registerType: 'prompt',
  injectRegister: false,
  manifest: {
    name: 'The Shark — المخزون والمكسب',
    short_name: 'The Shark',
    description: 'إدارة المخزون والمكسب اليومي',
    lang: 'ar',
    dir: 'rtl',
    display: 'standalone',
    start_url: '/',
    scope: '/',
    background_color: '#ffffff',
    theme_color: '#171717',
    icons: [
      {
        src: '/icons/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
      },
      {
        src: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
      },
    ],
  },
  workbox: {
    // Cache the built shell only; never precache or cache any Supabase API data.
    globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
    cleanupOutdatedCaches: true,
    clientsClaim: false,
    skipWaiting: false,
    navigateFallback: '/index.html',
    navigateFallbackDenylist: [
      /^\/rest\//,
      /^\/auth\//,
      /^\/realtime\//,
      /^\/storage\//,
      /^\/functions\//,
    ],
    runtimeCaching: [
      {
        // All Supabase and cross-origin API calls are strictly network-only.
        // Background Sync is intentionally not used.
        urlPattern: ({ url, sameOrigin }) =>
          !sameOrigin ||
          url.pathname.startsWith('/rest/') ||
          url.pathname.startsWith('/auth/') ||
          url.pathname.startsWith('/realtime/') ||
          url.pathname.startsWith('/storage/') ||
          url.pathname.startsWith('/functions/'),
        handler: 'NetworkOnly',
      },
    ],
  },
};

export function buildPlugins(
  env: Record<string, string | undefined> = process.env,
) {
  return [
    react(),
    tailwindcss(),
    ...(isPwaEnabled(env) ? [VitePWA(pwaOptions)] : []),
  ];
}

export default defineConfig({
  clearScreen: false,
  plugins: buildPlugins(process.env),
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'e2e/**/*.test.ts'],
  },
});
