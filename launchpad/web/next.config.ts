import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This app lives inside a larger repo with its own lockfile; pin the root here.
  turbopack: {
    root: path.join(__dirname),
  },
  // "My coins" became Profile.
  async redirects() {
    return [{ source: "/my-coins", destination: "/profile", permanent: true }];
  },
};

export default nextConfig;
