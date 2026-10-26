export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

export function marketingUnsubscribeUrl(email: string): string {
  return `https://api.yapern.com/unsubscribe?email=${encodeURIComponent(email)}`;
}

export function renderMarketingEmail(subject: string, message: string, recipientEmail: string, fancy = true): string {
  const title = escapeHtml(subject);
  const content = escapeHtml(message).replace(/\r\n?|\n/g, "<br>\n");
  const fontFamily = fancy ? "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif" : "Arial,Helvetica,sans-serif";
  const unsubscribe = `<a href="${escapeHtml(marketingUnsubscribeUrl(recipientEmail))}" style="display:inline-block;padding:12px 0;color:#595959;text-decoration:underline;">Unsubscribe</a>`;
  const body = fancy ? `
  <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="border-collapse:collapse;table-layout:fixed;">
    <tr><td align="center" style="padding:24px 16px;">
      <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="width:100%;max-width:520px;table-layout:fixed;border-collapse:collapse;">
        <tr><td style="padding:0 0 16px;"><a href="https://yapern.com" style="display:inline-block;padding:2px;text-decoration:none;"><img src="https://yapern.com/images/logo.png" alt="Yapern" width="40" height="40" style="display:block;width:40px;height:40px;border:0;border-radius:8px;"></a></td></tr>
        <tr><td style="padding:0 0 16px;overflow-wrap:anywhere;word-break:break-word;">
          <h1 style="margin:0;color:#363737;font-size:24px;line-height:28px;font-weight:700;">${title}</h1>
        </td></tr>
        <tr><td>
          <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="width:100%;table-layout:fixed;border-collapse:separate;border-spacing:0;">
            <tr><td style="padding:24px;border:1px solid #e5e5e5;border-radius:20px;background-color:#ffffff;color:#363737;font-size:16px;line-height:24px;overflow-wrap:anywhere;word-break:break-word;">${content}</td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:16px 0 0;">
          <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;border-spacing:0;">
            <tr><td align="center" bgcolor="#b39aff" style="border-radius:8px;background-color:#b39aff;"><a href="https://yapern.com" style="display:block;padding:12px 24px;border:1px solid #b39aff;border-radius:8px;color:#090d17;font-size:15px;line-height:20px;font-weight:600;text-align:center;text-decoration:none;">Visit Yapern</a></td></tr>
          </table>
        </td></tr>
        <tr><td align="center" style="padding:24px 0 0;color:#595959;font-size:13px;line-height:20px;">&copy; ${new Date().getUTCFullYear()} Yapern<br>${unsubscribe}</td></tr>
      </table>
    </td></tr>
  </table>` : `${content}\n<p style="margin:24px 0 0;font-size:12px;line-height:1.5;">${unsubscribe}</p>`;
  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${title}</title>
</head>
<body style="margin:0;padding:${fancy ? "0" : "16px"};background-color:#ffffff;color:${fancy ? "#363737" : "#000000"};font-family:${fontFamily};font-size:16px;line-height:1.5;overflow-wrap:anywhere;word-break:break-word;-webkit-text-size-adjust:100%;">
${body}
</body></html>`;
}

export function renderUnsubscribePage(email: string, state: "form" | "success" | "error" | "invalid" = "form"): string {
  const heading = state === "success" ? "Unsubscribed" : "Unsubscribe";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${heading} · Yapern</title>
<style>*{box-sizing:border-box}body{margin:0;padding:32px 24px;background:#090d17;color:#f2f2fb;font:16px/1.5 Arial,Helvetica,sans-serif}main{max-width:480px;margin:0 auto}h1{font-size:24px;margin:0 0 16px}p{margin:0 0 16px}a{color:#b39aff}label{display:block;margin-bottom:8px}input{display:block;width:100%;min-height:44px;margin-bottom:16px;padding:8px;background:#090d17;color:inherit;border:1px solid #acb6ce;border-radius:4px;font:inherit}button{min-height:44px;max-width:100%;padding:8px 16px;background:#b39aff;color:#090d17;border:0;border-radius:4px;font:inherit;cursor:pointer}:focus-visible{outline:2px solid #b39aff;outline-offset:4px}</style></head>
<body><main><h1>${heading}</h1>
${state === "success" ? '<p>You have unsubscribed from Yapern marketing emails.</p><a href="https://yapern.com">Return to Yapern</a>' : `
${state === "error" ? '<p role="alert">We couldn’t save your preference. Please try again.</p>' : state === "invalid" ? '<p role="alert">Enter a valid email address.</p>' : '<p>Stop receiving marketing emails from Yapern.</p>'}
<form action="/unsubscribe" method="post"><label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="email" required maxlength="254" value="${escapeHtml(email)}"><button type="submit">Unsubscribe</button></form>`}
</main></body></html>`;
}
