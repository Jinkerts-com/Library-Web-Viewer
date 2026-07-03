// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

import tailwindcss from '@tailwindcss/vite';
import react from '@astrojs/react';

// https://astro.build/config
export default defineConfig({
  server: {
    host: true
  },
  output: 'server',
  adapter: node({
    mode: 'standalone',
  }),
  integrations: [react()],
  vite: {
    server: {
      // Defaults to accepting any Host header so self-hosted LAN setups work
      // out of the box; set ALLOWED_HOSTS (comma-separated) to restrict.
      allowedHosts: process.env.ALLOWED_HOSTS ? process.env.ALLOWED_HOSTS.split(',') : true
    },
    ssr: {
      external: ['bun:sqlite']
    },

    plugins: [tailwindcss()]
  }
});