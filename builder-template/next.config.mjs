/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Allow running in Docker sandbox without hostname issues
  experimental: {},
};

export default nextConfig;
