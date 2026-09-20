import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // A self-contained server bundle, so the runtime image needs no node_modules.
  output: 'standalone',
  serverExternalPackages: ['postgres'],
  // Declared explicitly rather than inferred from tsconfig paths, so the bundler
  // and the typechecker cannot disagree about what "@/" means.
  webpack(config) {
    config.resolve.alias = { ...config.resolve.alias, '@': path.join(root, 'src') }
    return config
  },
  turbopack: {
    resolveAlias: { '@/*': './src/*' },
  },
}

export default nextConfig
