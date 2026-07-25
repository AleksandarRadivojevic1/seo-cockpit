import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  // shadcn/Bklit files use the `@/*` import alias declared in tsconfig.json;
  // Next resolves it natively, but vitest needs it wired explicitly.
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
});
