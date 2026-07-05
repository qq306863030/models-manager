import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { VantResolver } from 'unplugin-vue-components/resolvers';
import Components from 'unplugin-vue-components/vite';
import AutoImport from 'unplugin-auto-import/vite';
import { resolve } from 'path';

export default defineConfig({
  plugins: [
    vue(),
    AutoImport({ resolvers: [VantResolver()], imports: ['vue', 'vue-router'] }),
    Components({ resolvers: [VantResolver()] }),
  ],
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
  build: {
    outDir: '../dist/public',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        mobile: resolve(__dirname, 'mobile.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:11888',
        changeOrigin: true,
      },
    },
  },
});
