/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
    turbopack: {
      root: '.',
    },
  },
}

module.exports = nextConfig
