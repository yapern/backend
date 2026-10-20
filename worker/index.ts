import { handleRequest } from "./app/router";
import { AppState } from "./durable-objects/app-state";
import { cleanupPreviews, consumePreviews } from "./app/preview-jobs";
import { UserNotifications } from "./durable-objects/user-notifications";
import { retryNotificationDelivery } from "./app/notifications";

export { AppState, UserNotifications };

export default {
  fetch: handleRequest,
  queue(batch, env) {
    return consumePreviews(batch, env);
  },
  scheduled(_event, env, ctx) {
    ctx.waitUntil(cleanupPreviews(env));
    ctx.waitUntil(retryNotificationDelivery(env));
  },
} satisfies ExportedHandler<Env>;
