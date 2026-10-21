// The state endpoint returns 503 when this optional binding is not configured.
interface Env {
  APP_STATE?: DurableObjectNamespace;
  // Comma-separated exact browser origins; defaults to Yapern and local Vite.
  YAPERN_ORIGINS?: string;
  STREAM_ACCOUNT_ID?: string;
  STREAM_API_TOKEN?: string;
  STREAM_WEBHOOK_SECRET?: string;
}
