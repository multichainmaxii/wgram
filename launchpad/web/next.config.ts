import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This app lives inside a larger repo with its own lockfile; pin the root here.
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
