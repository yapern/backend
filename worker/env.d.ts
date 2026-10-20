// The state endpoint returns 503 when this optional binding is not configured.
interface Env {
  APP_STATE?: DurableObjectNamespace;
}
