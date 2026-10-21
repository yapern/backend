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
  const unsubscribe = `<a href="${escapeHtml(marketingUnsubscribeUrl(recipientEmail))}" style="display:inline-block;padding:12px 0;color:${fancy ? "#acb6ce" : "#595959"};text-decoration:underline;">Unsubscribe</a>`;
  const body = fancy ? `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;table-layout:fixed;">
    <tr><td align="center" style="padding:24px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;table-layout:fixed;border-collapse:collapse;">
        <tr><td style="padding:16px 0 24px;"><a href="https://yapern.com" style="display:inline-block;padding:12px 0;color:#f2f2fb;font-size:24px;font-weight:700;text-decoration:none;">Yapern</a></td></tr>
        <tr><td style="padding:24px 0;overflow-wrap:anywhere;word-break:break-word;">
          <h1 style="margin:0 0 24px;font-size:24px;line-height:1.3;">${title}</h1>
          <div style="color:#f2f2fb;font-size:16px;line-height:1.6;">${content}</div>
        </td></tr>
        <tr><td style="padding:24px 0 0;color:#acb6ce;font-size:13px;line-height:1.5;">${unsubscribe}</td></tr>
      </table>
    </td></tr>
  </table>` : `${content}\n<p style="margin:24px 0 0;font-size:12px;line-height:1.5;">${unsubscribe}</p>`;
  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="${fancy ? "dark" : "light"}">
  <title>${title}</title>
</head>
<body style="margin:0;padding:${fancy ? "0" : "16px"};background-color:${fancy ? "#090d17" : "#ffffff"};color:${fancy ? "#f2f2fb" : "#000000"};font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;overflow-wrap:anywhere;word-break:break-word;-webkit-text-size-adjust:100%;">
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
