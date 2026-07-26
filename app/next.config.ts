import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits .next/standalone with only the traced files plus the slice of
  // node_modules the server actually needs, so the runtime image carries no
  // toolchain and no dev dependencies. better-sqlite3 is a native module, but
  // it is already in Next's built-in server-external-packages list, so it is
  // `require`d rather than bundled and its prebuilt .node binding is traced in.
  output: "standalone",

  // The Next root is `app/`, not the repo root. Without this, a stray
  // package-lock.json anywhere above the project makes Next infer a different
  // workspace root and trace the wrong tree — which has already happened on
  // this machine (a /home/ar/package-lock.json). Pinning it keeps the Docker
  // build independent of whatever sits above the build context.
  outputFileTracingRoot: path.join(import.meta.dirname, "."),

  // better-sqlite3 resolves its native addon through a path BUILT AT RUNTIME
  // (`path.join(__dirname, '..', 'build', 'Release', 'better_sqlite3.node')`
  // in lib/binding.js), which the static tracer cannot follow. Without this,
  // the compiled binary is left out of .next/standalone and every route 500s
  // with ERR_DLOPEN_FAILED. Every route reads the database, so the include is
  // unconditional.
  outputFileTracingIncludes: {
    "/**/*": ["./node_modules/better-sqlite3/build/Release/*.node"],
  },
};

export default nextConfig;
