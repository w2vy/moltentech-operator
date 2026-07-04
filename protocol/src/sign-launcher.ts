/**
 * Wallet sign-launcher for owner authorizations — the "integrated signing" surface.
 *
 * Renders a self-contained HTML page that signs a message with SSP Wallet
 * (in-browser `window.ssp.request('sspwid_sign_message')`, returns
 * `{address, signature}`) or Zelcore (a `zel:?action=sign…` deep link). The
 * private key never leaves the wallet; the page only surfaces the resulting
 * signature. Ported from the fluxtools-skills-mcp launcher (Sikbik/fluxtools-skills-mcp).
 *
 * The returned Flux `signmessage` signature is exactly what {@link ownerAuthMessage}
 * expects, so `assembleOwnerAuth(claim, signature)` yields an `OwnerAuth` that
 * `verifyOwnerAuth` (wallet.ts) accepts for the signer's pinned address.
 *
 * Framework-free and crypto-free (returns strings only) so both the operator
 * console and the MT web app can import it without pulling node-only deps.
 */
import {
  OwnerAuth,
  OwnerAuthClaim,
  ownerAuthMessage,
} from "./messages";

/** Default Zelcore in-wallet icon (RunOnFlux ZelID). Override per launcher if desired. */
const DEFAULT_ZELCORE_ICON =
  "https://raw.githubusercontent.com/runonflux/flux/master/zelID.svg";

/** Minimal escaping for inclusion in HTML attributes / text. */
export function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Shared MoltenTech console theme (dark + ember). One source of truth for the
 * launcher page AND the coalition console (imported there), so both surfaces match.
 * The accent lives in a single CSS var (`--accent`/`--accent2`) — an operator can
 * override it for white-label without touching markup.
 */
export const CONSOLE_THEME_CSS = `
:root{--bg:#0a0a0a;--card:#111111;--line:#262626;--fg:#e8e8e8;--muted:#9ca3af;
--accent:#ff4500;--accent2:#ff8c00;--glow:rgba(255,69,0,.3);--ok:#16a34a}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif;
margin:0;padding:24px;line-height:1.5;color:var(--fg);background:var(--bg);
background-image:radial-gradient(1100px 380px at 50% -12%,rgba(255,69,0,.09),transparent)}
.wrap{max-width:860px;margin:0 auto}
header.mt{display:flex;align-items:baseline;gap:10px;margin-bottom:16px}
.mark{font-weight:800;letter-spacing:.3px;font-size:18px;
background:linear-gradient(135deg,var(--accent),var(--accent2));-webkit-background-clip:text;background-clip:text;color:transparent}
.slug{color:var(--muted);font-size:13px}
h1{font-size:22px;margin:0 0 6px}h2{font-size:16px;margin:0 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:14px 0}
a{color:var(--accent2);text-decoration:none}a:hover{text-decoration:underline}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:11px 12px;border-bottom:1px solid var(--line);vertical-align:middle}
th{color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
.btn{display:inline-block;padding:11px 18px;border:none;border-radius:10px;cursor:pointer;
font-size:15px;font-weight:600;text-decoration:none;color:#fff;margin:4px 6px 4px 0}
.btn:hover{text-decoration:none}
.btn-primary{background:linear-gradient(135deg,var(--accent),var(--accent2));box-shadow:0 0 18px var(--glow)}
.btn-ssp{background:#2563eb}.btn-zelcore{background:#1a1a2e;border:1px solid #33334d}
.btn:disabled{opacity:.5;cursor:not-allowed}
.badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700;
text-transform:uppercase;letter-spacing:.3px}
.badge-delete{background:#2a0a0a;color:#f87171;border:1px solid #7f1d1d}
.badge-reprovision{background:#2a1a00;color:#fbbf24;border:1px solid #92400e}
.badge-move{background:#04222a;color:#22d3ee;border:1px solid #155e75}
.badge-ok{background:#04220f;color:#4ade80;border:1px solid #166534}
.badge-warn{background:#2a1a00;color:#fbbf24;border:1px solid #92400e}
.badge-bad{background:#2a0a0a;color:#f87171;border:1px solid #7f1d1d}
.badge-info{background:#04222a;color:#22d3ee;border:1px solid #155e75}
.badge-mut{background:#1a1a1a;color:#9ca3af;border:1px solid #333}
.mono,code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
code{background:#1a1a1a;padding:2px 6px;border-radius:6px;word-break:break-all}
.muted{color:var(--muted)}
.result{margin-top:14px;padding:12px;border-radius:10px;background:#052e16;border:1px solid #14532d;display:none;word-break:break-all}
.result.error{background:#2a0a0a;border-color:#7f1d1d}
.sig-box{font-family:ui-monospace,monospace;font-size:13px;width:100%;padding:10px;border:1px solid var(--line);
border-radius:8px;background:#0d0d0d;color:var(--fg);word-break:break-all;min-height:44px}
textarea.sig-box{min-height:60px}
.copy-btn{margin-top:8px;padding:7px 14px;font-size:13px;background:#1a1a1a;color:#fff;border:1px solid var(--line);border-radius:8px;cursor:pointer}
.copy-btn.copied{background:var(--ok)}
.done{display:none}.done .big{font-size:44px;line-height:1;color:var(--ok)}
summary{cursor:pointer;color:var(--muted)}
`;

/**
 * Build a Zelcore `zel:?action=sign…` deep link for `message`. An optional
 * `callback` URL lets the wallet POST the signature back for an automated
 * round-trip (otherwise the user copies it from the launcher page).
 */
export function buildZelcoreSignLink(opts: {
  message: string;
  icon?: string;
  callback?: string;
}): string {
  const icon = opts.icon ?? DEFAULT_ZELCORE_ICON;
  const callback = opts.callback
    ? `&callback=${encodeURIComponent(opts.callback)}`
    : "";
  return `zel:?action=sign&message=${encodeURIComponent(
    opts.message
  )}&icon=${encodeURIComponent(icon)}${callback}`;
}

/** Render the self-contained SSP + Zelcore sign-launcher page for `message`. */
export function buildSignLauncherHtml(opts: {
  message: string;
  zelcoreLink: string;
  title?: string;
  intro?: string;
}): string {
  const safeZelcoreLink = escapeHtmlAttribute(opts.zelcoreLink);
  const title = escapeHtmlAttribute(opts.title ?? "MoltenTech — Owner Authorization");
  const intro = escapeHtmlAttribute(
    opts.intro ??
      "Review the action below and sign it with your Flux owner wallet."
  );
  const safeMessage = escapeHtmlAttribute(opts.message);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>${CONSOLE_THEME_CSS}</style>
  </head>
  <body>
    <div class="wrap">
    <header class="mt"><span class="mark">MoltenTech</span><span class="slug">owner authorization</span></header>
    <h1>${title}</h1>
    <p class="muted">${intro}</p>

    <div class="card wallet-section">
      <h2>SSP Wallet</h2>
      <p class="muted">Sign directly in your browser if the SSP extension is installed.</p>
      <button class="btn btn-ssp" id="ssp-btn" onclick="signWithSSP()">Sign with SSP</button>
      <span id="ssp-status" class="muted"></span>
      <div class="result" id="ssp-result"></div>
    </div>

    <div class="card wallet-section">
      <h2>Zelcore</h2>
      <p class="muted">Opens the Zelcore desktop app to sign; it posts the signature back automatically.</p>
      <a class="btn btn-zelcore" href="${safeZelcoreLink}">Sign with Zelcore</a>
    </div>

    <div class="card wallet-section">
      <h2>Signature</h2>
      <p class="muted">After signing, the signature appears here and is submitted for you. Copy it only for the manual fallback.</p>
      <div id="sig-output" class="sig-box"></div>
      <button class="copy-btn" id="copy-btn" onclick="copySig()" style="display:none">Copy</button>
    </div>

    <details class="card">
      <summary>Raw message being signed</summary>
      <pre style="white-space:pre-wrap;word-break:break-all;background:#0d0d0d;padding:10px;border-radius:8px;max-height:200px;overflow:auto;margin:8px 0 0">${safeMessage}</pre>
    </details>
    </div>

    <script>
      var messageToSign = ${JSON.stringify(opts.message)};

      async function signWithSSP() {
        var btn = document.getElementById('ssp-btn');
        var status = document.getElementById('ssp-status');
        var result = document.getElementById('ssp-result');
        var sigOutput = document.getElementById('sig-output');
        btn.disabled = true;
        status.textContent = 'Requesting signature...';
        result.style.display = 'none';
        result.className = 'result';
        try {
          if (!window.ssp) throw new Error('SSP Wallet not detected. Make sure the SSP extension is installed.');
          var response = await window.ssp.request('sspwid_sign_message', { message: messageToSign });
          if (response.status === 'ERROR') throw new Error(response.data || response.result || 'SSP signing failed');
          status.textContent = '';
          result.style.display = 'block';
          result.innerHTML = '<strong>Signed!</strong><br>Address: <code>' + response.address + '</code><br>Signature: <code>' + response.signature + '</code>';
          sigOutput.textContent = response.signature;
          document.getElementById('copy-btn').style.display = '';
          try { await navigator.clipboard.writeText(response.signature); result.innerHTML += '<br><em>(Copied to clipboard)</em>'; } catch(e) {}
        } catch (err) {
          status.textContent = '';
          result.style.display = 'block';
          result.className = 'result error';
          result.textContent = err.message || String(err);
        } finally {
          btn.disabled = false;
        }
      }

      async function copySig() {
        var sig = document.getElementById('sig-output').textContent;
        if (!sig) return;
        var btn = document.getElementById('copy-btn');
        try {
          await navigator.clipboard.writeText(sig);
          btn.textContent = 'Copied!';
          btn.classList.add('copied');
          setTimeout(function() { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
        } catch(e) {
          var range = document.createRange();
          range.selectNodeContents(document.getElementById('sig-output'));
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }

      if (typeof window.ssp === 'undefined') {
        document.getElementById('ssp-status').textContent = '(SSP not detected)';
      }
    </script>
  </body>
</html>
`;
}

/**
 * MoltenTech convenience: build the owner-authorization message + Zelcore link +
 * launcher page for an `OwnerAuthClaim` (delete/reprovision/move). The owner signs
 * the returned page; feed the resulting signature to {@link assembleOwnerAuth}.
 */
export function buildOwnerAuthSignLauncher(
  claim: OwnerAuthClaim,
  opts?: { callback?: string; icon?: string; title?: string; intro?: string }
): { message: string; zelcoreLink: string; html: string } {
  const message = ownerAuthMessage(claim);
  const zelcoreLink = buildZelcoreSignLink({
    message,
    icon: opts?.icon,
    callback: opts?.callback,
  });
  const intro =
    opts?.intro ??
    `Authorize "${claim.action}" of ${claim.vmName}@${claim.nodeName} (${claim.providerSlug}). This authorization expires ${claim.expiresAt}.`;
  const html = buildSignLauncherHtml({
    message,
    zelcoreLink,
    title: opts?.title,
    intro,
  });
  return { message, zelcoreLink, html };
}

/**
 * Combine the wallet-returned signature with its claim into a validated
 * `OwnerAuth`. Throws (ZodError) if the claim or signature is malformed — the
 * operator agent's `verifyOwnerAuth` still checks the signature recovers to the
 * pinned owner; this only guarantees a well-formed envelope.
 */
export function assembleOwnerAuth(
  claim: OwnerAuthClaim,
  signature: string
): OwnerAuth {
  return OwnerAuth.parse({ ...claim, signature });
}
