import { storeToken } from "../lib/ig-token";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

async function run() {
  console.log("Saving token...");
  const token = "IGAAUL2ZAN6NrZABZAFp2Wmx5TlJ5ZA2xhem0yYUxWTmVYUFhOUFkwWFJRTjVSTHBxTldqOWI5b1l5ZATZAtbllZANkpnVEI2aGZALb3EyTWdLeWdNZADluSFkxYVdGNUNwNHBFdF9rV29nSnlJLVZAHYVByUFA0U1VrR0ZA5WEhtVWREUVVGUQZDZD";
  // The short-lived token expires in about 1 hour. We'll set it to 1 hour from now.
  const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
  await storeToken(token, expiresAt);
  console.log("Token saved successfully in Firestore.");
}

run().catch(console.error);
