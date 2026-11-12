import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native/dynamic-import heavy packages must not be bundled into the server build.
  serverExternalPackages: ["playwright-core", "archiver", "pngjs", "pixelmatch", "cheerio"],
  outputFileTracingExcludes: { "*": [".crawl-data/**/*"] },
};

export default nextConfig;
