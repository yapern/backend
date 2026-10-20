// These integrations are optional: the current Wrangler configuration only
// binds DB and BUCKET. Handlers return their existing unavailable responses
// when an integration has not been configured.
interface Env {
  APP_STATE?: DurableObjectNamespace;
  ANONYMOUS_SIGNUP_LIMIT?: RateLimit;
  GOOGLE_CLIENT_ID?: string;
  SUPABASE_URL?: string;
}
