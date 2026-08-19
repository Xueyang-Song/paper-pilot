import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src/renderer", import.meta.url))
    }
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    globals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
      include: ["src/main/**/*.ts", "src/shared/**/*.ts"],
      exclude: ["src/main/index.ts", "**/*.d.ts", "**/types.ts"],
      thresholds: {
        statements: 45,
        branches: 35,
        functions: 50,
        lines: 50
      }
    }
  }
});
