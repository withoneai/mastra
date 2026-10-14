import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/provider.ts', 'src/workflows.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node22',
})
