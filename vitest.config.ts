import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // The database tests share one PostgreSQL and its household-independent
    // reference tables (crowd levels, park weather and hours), so two files
    // running at once can overwrite each other's rows. One file at a time
    // when a database is set; the pure tests still run in parallel workers.
    fileParallelism: !process.env.DATABASE_URL,
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
})
