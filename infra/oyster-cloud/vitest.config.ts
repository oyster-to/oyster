import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";
import { sharedMiniflareOptions } from "./vitest.shared";

export default defineWorkersProject({
  test: {
    name: "cloud",
    // relay-routes runs in its own project (vitest.relay.config.ts) with
    // isolatedStorage off — see vitest.workspace.ts.
    include: ["test/**/*.test.ts"],
    exclude: ["test/relay-routes.test.ts", "**/node_modules/**"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: sharedMiniflareOptions,
      },
    },
  },
});
