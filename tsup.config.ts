import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/provider.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node22',
})
