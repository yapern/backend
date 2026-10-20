const reasons = {
  preview_metadata_missing: "No usable Open Graph or Twitter image was found in the first 256 KiB of page HTML.",
  preview_http_error: "The website returned an unsuccessful HTTP status.",
  preview_non_html: "The website returned a content type other than HTML.",
  preview_empty_html: "The website returned no HTML to inspect.",
  preview_dns_failed: "The website hostname could not be resolved.",
  preview_dns_not_public: "The website hostname resolves to a private or reserved network address.",
  preview_url_not_allowed: "The destination URL is not allowed for previews.",
  preview_redirect_not_allowed: "The website redirected to a URL that is not allowed for previews.",
  preview_redirect_limit: "The website exceeded the preview redirect limit.",
  preview_timeout: "The preview operation exceeded its time limit.",
  preview_fetch_failed: "The website could not be fetched for metadata.",
  preview_browser_failed: "The browser service could not complete the screenshot request.",
  preview_navigation_failed: "The browser could not navigate to the website.",
  preview_connection_failed: "The preview service could not connect to the website.",
  preview_tls_failed: "A secure connection to the website could not be established.",
  preview_invalid_snapshot: "The browser service returned an invalid or incomplete snapshot response.",
  preview_challenge: "The rendered page contains a bot check or CAPTCHA.",
  preview_access_denied: "The rendered page reports that access is denied.",
  preview_login_required: "The rendered page is a sign-in page.",
  preview_error_page: "The rendered page appears to be an error or not-found page.",
  preview_consent_overlay: "A cookie consent overlay obscures the rendered page.",
  preview_blank_page: "The rendered page has too little visible content for a screenshot preview.",
  preview_unusable: "The cached screenshot was rejected as blank, blocked, or an error page; no more specific reason was recorded.",
  preview_response_too_large: "The browser snapshot exceeded the 12 MiB response limit.",
  preview_invalid_image: "The screenshot is not a valid JPEG between 1,000 bytes and 5 MiB.",
  preview_storage_failed: "The screenshot could not be saved to preview storage.",
  preview_lease_lost: "The screenshot job expired or was superseded before it could be saved.",
  preview_failed: "The screenshot job failed; no more specific reason was recorded.",
} as const;

type PreviewReason = keyof typeof reasons;
type DiagnosticDetails = { httpStatus?: number; contentType?: string; providerCode?: number };
export type PreviewDiagnostic = DiagnosticDetails & { code: PreviewReason; message: string };
export type PreviewDiagnostics = { metadata?: PreviewDiagnostic; screenshot?: PreviewDiagnostic };

export function previewDiagnostic(code: PreviewReason, details: DiagnosticDetails = {}): PreviewDiagnostic {
  return { code, message: reasons[code], ...details };
}

export class PreviewFailure extends Error {
  readonly diagnostic: PreviewDiagnostic;
  constructor(code: PreviewReason, details: DiagnosticDetails = {}) {
    super(code);
    this.name = "PreviewFailure";
    this.diagnostic = previewDiagnostic(code, details);
  }
}

export function failureDiagnostic(error: unknown, fallback: PreviewReason, signal?: AbortSignal): PreviewDiagnostic {
  if (error instanceof PreviewFailure) return error.diagnostic;
  if (signal?.aborted || (error instanceof Error && /^(?:TimeoutError|AbortError)$/.test(error.name))) {
    return previewDiagnostic("preview_timeout");
  }
  let cause = error;
  for (let depth = 0; depth < 3 && cause && typeof cause === "object"; depth++) {
    const item = cause as { message?: unknown; code?: unknown; cause?: unknown };
    const message = typeof item.message === "string" ? item.message : "";
    if (Object.hasOwn(reasons, message)) return previewDiagnostic(message as PreviewReason);
    const description = `${typeof item.code === "string" ? item.code : ""} ${message}`;
    if (/timed?\s*out|timeout/i.test(description)) return previewDiagnostic("preview_timeout");
    if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i.test(description)) return previewDiagnostic("preview_dns_failed");
    if (/ERR_CERT_|CERT_|SSL_|TLS|certificate/i.test(description)) return previewDiagnostic("preview_tls_failed");
    if (/ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH/i.test(description)) return previewDiagnostic("preview_connection_failed");
    if (/net::ERR_|navigation|ERR_CONNECTION/i.test(description)) return previewDiagnostic("preview_navigation_failed");
    cause = item.cause;
  }
  return previewDiagnostic(fallback);
}

// Stored diagnostics may predate the current code. Rebuild only known fields
// with curated messages so neither old rows nor provider errors expose raw data.
export function readPreviewDiagnostics(value: string | null): PreviewDiagnostics {
  try {
    const stored = JSON.parse(value ?? "null");
    const diagnostics: PreviewDiagnostics = {};
    for (const stage of ["metadata", "screenshot"] as const) {
      const item = stored?.[stage];
      if (!item || typeof item.code !== "string" || !Object.hasOwn(reasons, item.code)) continue;
      diagnostics[stage] = previewDiagnostic(item.code as PreviewReason, {
        ...(Number.isInteger(item.httpStatus) ? { httpStatus: item.httpStatus } : {}),
        ...(typeof item.contentType === "string" ? { contentType: item.contentType.slice(0, 120) } : {}),
        ...(Number.isInteger(item.providerCode) ? { providerCode: item.providerCode } : {}),
      });
    }
    return diagnostics;
  } catch { return {}; }
}
