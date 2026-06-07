import { defineWorkspace } from "vitest/config";

// Two projects because of one incompatibility: vitest-pool-workers 0.5.x
// isolated-storage stacking can't pop a Durable Object whose SQLite WAL is
// held open by live WebSockets (see vitest.relay.config.ts). Everything
// else keeps per-file isolated storage as before.
export default defineWorkspace([
  "./vitest.config.ts",
  "./vitest.relay.config.ts",
]);
