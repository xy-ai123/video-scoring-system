/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@vss/db"],
  experimental: {
    serverComponentsExternalPackages: ["@prisma/client", "googleapis"],
  },
  poweredByHeader: false,
};

export default nextConfig;
