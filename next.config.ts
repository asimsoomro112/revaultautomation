import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Webhook route reads the raw request body itself; keep default body handling.
  experimental: {
    // serverActions not used; keep minimal
  },
};

export default nextConfig;
