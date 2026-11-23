import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "lib/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    testTimeout: 30000,
  },
});
