import path from "node:path";
import { workerMode } from "./config";

const g = globalThis as typeof globalThis & { __ucInlineWorker?: Promise<unknown> };

/**
 * In "inline" mode the web process runs the worker loop itself, through exactly the same queue as a
 * separate worker would. In "external" mode this is a no-op and the crawler engine is never loaded.
 */
export function ensureInlineWorker(): void {
  if (workerMode() !== "inline" || g.__ucInlineWorker) return;
  g.__ucInlineWorker = (async () => {
    try {
      // The inline worker needs the same packaged browser as the standalone worker.
      // External web processes must not extract or launch a browser.
      const helper = path.join(process.cwd(), "scripts", "chromium-env.mjs");
      const { applyChromiumEnv } = (await import(/* webpackIgnore: true */ helper)) as { applyChromiumEnv: () => Promise<{ ok: boolean; reason?: string }> };
      const browser = await applyChromiumEnv();
      if (!browser.ok) console.warn(`[worker] inline Chromium is unavailable (${browser.reason}); browser-dependent crawls may fail.`);
      const { CrawlWorker } = await import("@/worker/worker");
      const worker = new CrawlWorker({ id: process.env.WORKER_ID || undefined, info: { inline: true, node: process.version } });
      await worker.start();
      const stop = () => void worker.stop().finally(() => process.exit(0));
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
      return worker;
    } catch (e) {
      console.error("[worker] inline worker failed to start:", (e as Error).message);
      g.__ucInlineWorker = undefined;
      return null;
    }
  })();
}
