import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["workers/**/*.test.ts"], testTimeout: 15000, hookTimeout: 30000 },
});
