import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // The e2e run builds into its own directory so it never clobbers the production build output.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};
export default config;
