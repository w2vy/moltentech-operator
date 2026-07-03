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
    <style>
      body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif;margin:24px;line-height:1.4;color:#222}
      .btn{display:inline-block;padding:12px 20px;color:#fff;text-decoration:none;border-radius:10px;border:none;cursor:pointer;font-size:16px;margin:6px 4px}
      .btn-zelcore{background:#1a1a2e}
      .btn-ssp{background:#2563eb}
      .btn:disabled{opacity:.5;cursor:not-allowed}
      code{background:#f3f3f3;padding:2px 6px;border-radius:6px;word-break:break-all}
      .result{margin-top:16px;padding:12px;background:#f0fdf4;border:1px solid #86efac;border-radius:8px;display:none}
      .result.error{background:#fef2f2;border-color:#fca5a5}
      .wallet-section{margin:16px 0;padding:16px;border:1px solid #e5e7eb;border-radius:8px}
      h2{font-size:18px;margin:0 0 8px}
      .sig-box{font-family:monospace;font-size:13px;width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;background:#f9fafb;word-break:break-all;min-height:40px;box-sizing:border-box}
      .copy-btn{margin-top:8px;padding:6px 14px;font-size:13px;background:#111;color:#fff;border:none;border-radius:6px;cursor:pointer;transition:background .15s}
      .copy-btn:hover{background:#333}
      .copy-btn.copied{background:#16a34a}
    </style>
  </head>
  <body>
    <h1>${title}</h1>
    <p>${intro}</p>

    <div class="wallet-section">
      <h2>SSP Wallet</h2>
      <p>Sign directly in your browser if SSP is installed.</p>
      <button class="btn btn-ssp" id="ssp-btn" onclick="signWithSSP()">Sign with SSP</button>
      <span id="ssp-status"></span>
      <div class="result" id="ssp-result"></div>
    </div>

    <div class="wallet-section">
      <h2>Zelcore</h2>
      <p>Opens the Zelcore desktop app to sign.</p>
      <a class="btn btn-zelcore" href="${safeZelcoreLink}">Open in Zelcore</a>
    </div>

    <div class="wallet-section">
      <h2>Signature</h2>
      <p>After signing, copy the signature below and paste it back where requested.</p>
      <div id="sig-output" class="sig-box"></div>
      <button class="copy-btn" id="copy-btn" onclick="copySig()" style="display:none">Copy</button>
    </div>

    <details style="margin-top:16px">
      <summary>Raw message being signed</summary>
      <pre style="white-space:pre-wrap;word-break:break-all;background:#f9fafb;padding:8px;border-radius:6px;max-height:200px;overflow:auto">${safeMessage}</pre>
    </details>

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
