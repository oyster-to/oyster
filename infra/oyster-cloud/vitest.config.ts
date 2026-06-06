import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["test/**/*.test.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // Use isolated in-memory D1 per test file.
          d1Databases: ["DB"],
          // In-memory R2 bucket for session bytes tests.
          r2Buckets: ["SESSIONS_BUCKET"],
          // Stub for the PUBLISH service binding (oyster-publish). Echoes
          // request facts so dispatch tests can assert what was forwarded.
          // The real binding is integration-tested in oyster-publish's own
          // app-host tests.
          serviceBindings: {
            PUBLISH(req: Request) {
              return new Response(
                JSON.stringify({
                  stub: "oyster-publish",
                  url: req.url,
                  method: req.method,
                  origin: req.headers.get("origin"),
                  hasCookie: req.headers.get("cookie") !== null,
                }),
                { headers: { "content-type": "application/json" } },
              );
            },
          },
          // Static SPA assets fixture for the /app serving tests. Mirrors the
          // production [assets] binding (dist-cloud) at directory root.
          assets: { directory: "./test/fixtures/app-assets", binding: "ASSETS" },
          // Encryption key fed in as a binding for tests; in production it's
          // a wrangler secret.
          bindings: {
            SESSIONS_ENCRYPTION_KEY: "test-master-secret-do-not-use-in-prod",
          },
        },
      },
    },
  },
});
