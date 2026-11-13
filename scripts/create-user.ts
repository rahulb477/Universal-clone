
import { createUser } from "../src/lib/server/users";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

async function main() {
  const email = process.argv[2];
  const role = process.argv[3] === "admin" ? "admin" : "user";

  if (!email) {
    console.error(
      "Usage: npm run user:create -- rahul4319q@gmail.com admin"
    );
    process.exit(1);
  }

  const password = process.env.USER_PASSWORD;

  let finalPassword = password;

  if (!finalPassword) {
    const rl = createInterface({ input: stdin, output: stdout });

    try {
      finalPassword = await rl.question("Enter a new password: ");
    } finally {
      rl.close();
    }
  }

  if (!finalPassword || finalPassword.length < 12) {
    throw new Error("Password must be at least 12 characters long.");
  }

  await createUser(email, finalPassword, role);

  console.log(`User created successfully: ${email}`);
  console.log(`Role: ${role}`);
}

main().catch((error) => {
  console.error("User creation failed:", error.message);
  process.exit(1);
});
