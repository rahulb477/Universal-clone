/**
 * Preloaded by the command-line entry points (`npm run worker`, `db:migrate`, `user:create`):
 * reads `.env` from the working directory when there is one, like `next start` does for the web app.
 * Variables that are already set in the environment win.
 */
import fs from "node:fs";

if (fs.existsSync(".env") && typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(".env");
  } catch (e) {
    console.error(`Could not read .env: ${e.message}`);
    process.exit(1);
  }
}
