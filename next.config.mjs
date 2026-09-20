import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // A self-contained server bundle, so the runtime image needs no node_modules.
  output: 'standalone',
  env: {
    // The version the footer shows. Inlined at build time; the git revision
    // arrives separately, as BALLAST_BUILD_SHA from the image build.
    BALLAST_VERSION: version,
  },
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
