/**
 * Creates an application user (the only way to get an account when AUTH_REGISTRATION is "closed").
 *   DATABASE_URL=… npm run user:create -- someone@example.com            (prompts for the password on stdin)
 *   DATABASE_URL=… USER_PASSWORD=… npm run user:create -- someone@example.com
 */
import readline from "node:readline";
import { closeDb } from "@/db";
import { createUser } from "@/lib/server/users";

async function main() {
  const email = process.argv[2];
  if (!email) throw new Error("usage: npm run user:create -- <email> [role]");
  let password = process.env.USER_PASSWORD ?? "";
  if (!password) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: false });
    process.stderr.write("Password (min. 10 characters): ");
    password = await new Promise<string>((resolve) => rl.once("line", resolve));
    rl.close();
  }
  const user = await createUser(email, password, process.argv[3] === "admin" ? "admin" : "user");
  console.log(`created user ${user.email} (${user.id})`);
}

main()
  .catch((e) => {
    console.error((e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
