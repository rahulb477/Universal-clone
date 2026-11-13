import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native/dynamic-import heavy packages must not be bundled into the server build.
  serverExternalPackages: ["playwright-core", "archiver", "pngjs", "pixelmatch", "cheerio"],
  outputFileTracingExcludes: { "*": [".crawl-data/**/*"] },
  poweredByHeader: false,
  // Security headers are set at run time in src/proxy.ts.
};

export default nextConfig;
