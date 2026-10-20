// The state endpoint returns 503 when this optional binding is not configured.
interface Env {
  APP_STATE?: DurableObjectNamespace;
  // Comma-separated exact browser origins; defaults to Yapern and local Vite.
  YAPERN_ORIGINS?: string;
}
