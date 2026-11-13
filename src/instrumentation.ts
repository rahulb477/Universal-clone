/** Starts the in-process worker when the deployment is configured for it (see workerMode()). */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.DATABASE_URL) return;
  const { ensureInlineWorker } = await import("@/lib/server/inline-worker");
  ensureInlineWorker();
}
