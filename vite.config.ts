import vue from '@vitejs/plugin-vue'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // 部署子路径，可用环境变量覆盖：VITE_BASE=/ pnpm build（根路径部署）
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [vue()],
    /**
     * 站点部署在 /element-cube/ 下（非域名根路径）。
     * 所有静态资源、代码块、public 资源的 URL 都会以此为前缀生成。
     */
    base: env.VITE_BASE ?? '/element-cube/',
    build: {
      outDir: 'dist',
      // 生成后若目录非空会自动清理，方便反复打包
      emptyOutDir: true,
      chunkSizeWarningLimit: 900,
    },
  }
})
