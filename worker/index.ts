import { handleRequest } from "./app/router";
import { AppState } from "./durable-objects/app-state";
import { cleanupPreviews, consumePreviews } from "./app/preview-jobs";
import { UserNotifications } from "./durable-objects/user-notifications";
import { retryNotificationDelivery } from "./app/notifications";
import { maintainVideos } from "./app/message-videos";
import { deliverEmailNotifications } from "./app/email-notifications";
import { consumeCrawls, recoverCrawls } from "./app/crawl-jobs";

export { AppState, UserNotifications };

export default {
  fetch: handleRequest,
  async queue(batch, env) {
    const isCrawl = (message: Message<unknown>) => message.body && typeof message.body === "object" && "kind" in message.body && message.body.kind === "crawl";
    await consumeCrawls({ ...batch, messages: batch.messages.filter(isCrawl) }, env);
    await consumePreviews({ ...batch, messages: batch.messages.filter(message => !isCrawl(message)) }, env);
  },
  scheduled(_event, env, ctx) {
    ctx.waitUntil(cleanupPreviews(env));
    ctx.waitUntil(retryNotificationDelivery(env));
    ctx.waitUntil(deliverEmailNotifications(env));
    ctx.waitUntil(maintainVideos(env));
    ctx.waitUntil(recoverCrawls(env));
  },
} satisfies ExportedHandler<Env>;
