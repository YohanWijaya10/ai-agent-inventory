/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    typedRoutes: true,
    serverActions: {
      allowedOrigins: ["*"]
    }
  },
  async rewrites() {
    return [
      {
        source: '/data/:path*',
        destination: 'https://serverless-twg8.vercel.app/:path*',
      },
    ];
  },
};

export default nextConfig;
