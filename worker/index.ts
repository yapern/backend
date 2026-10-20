import { handleRequest } from "./app/router";
import { AppState } from "./durable-objects/app-state";
import { cleanupPreviews, consumePreviews } from "./app/preview-jobs";

export { AppState };

export default {
  fetch: handleRequest,
  queue(batch, env) {
    return consumePreviews(batch, env);
  },
  scheduled(_event, env, ctx) {
    ctx.waitUntil(cleanupPreviews(env));
  },
} satisfies ExportedHandler<Env>;
