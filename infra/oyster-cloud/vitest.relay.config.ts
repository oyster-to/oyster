import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";
import { sharedMiniflareOptions } from "./vitest.shared";

// Relay tests run with isolatedStorage OFF: vitest-pool-workers 0.5.x's
// storage stacking asserts every Durable Object file ends in .sqlite, but
// a DO with live (hibernatable) WebSockets keeps its SQLite WAL open, so
// a .sqlite-shm exists at suite teardown and the pop fails. The relay
// suite doesn't need stacked isolation anyway — every test mints its own
// user, which means its own RelayDO instance and its own D1 rows.
// Revisit when the pool is upgraded past the assertion (needs vitest 4).
export default defineWorkersProject({
  test: {
    name: "relay",
    include: ["test/relay-routes.test.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        isolatedStorage: false,
        singleWorker: true,
        miniflare: sharedMiniflareOptions,
      },
    },
  },
});
