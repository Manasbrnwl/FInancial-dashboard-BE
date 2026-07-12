/**
 * HTML for the manual MCP token page (GET/POST /auth).
 * Open it in a browser, log in, copy the Bearer token into your MCP client config.
 */

const SHARED_STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, #0f172a 0%, #1e293b 60%, #0f172a 100%);
    font-family: 'Inter', system-ui, sans-serif;
    padding: 24px;
  }
  .card {
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 20px;
    padding: 44px 40px;
    width: 100%;
    max-width: 460px;
    backdrop-filter: blur(24px);
    box-shadow: 0 32px 64px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.05);
  }
  .logo { text-align: center; font-size: 36px; margin-bottom: 10px; }
  h1 { color: #f1f5f9; font-size: 22px; font-weight: 700; text-align: center; margin-bottom: 4px; letter-spacing: -0.3px; }
  .subtitle { color: #64748b; font-size: 13px; text-align: center; margin-bottom: 8px; }
  .badge {
    display: flex; align-items: center; justify-content: center; gap: 6px;
    background: rgba(99,102,241,0.12); border: 1px solid rgba(99,102,241,0.25);
    border-radius: 20px; padding: 5px 14px; font-size: 11px; color: #a5b4fc;
    width: fit-content; margin: 0 auto 32px;
  }
  label { display: block; color: #94a3b8; font-size: 12px; font-weight: 500; margin-bottom: 7px; letter-spacing: 0.5px; text-transform: uppercase; }
  .field { margin-bottom: 20px; }
  input[type="email"], input[type="password"] {
    width: 100%; padding: 12px 15px; border-radius: 10px;
    border: 1px solid rgba(255,255,255,0.12);
    background: rgba(255,255,255,0.06); color: #f1f5f9; font-size: 14px;
    outline: none; transition: border-color 0.2s, box-shadow 0.2s;
  }
  input:focus { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,0.15); }
  button[type="submit"] {
    width: 100%; padding: 13px; border-radius: 10px; border: none;
    background: linear-gradient(90deg, #6366f1 0%, #8b5cf6 100%);
    color: #fff; font-size: 15px; font-weight: 600; cursor: pointer;
    transition: opacity 0.2s, transform 0.1s; margin-top: 6px;
    letter-spacing: 0.2px;
  }
  button[type="submit"]:hover { opacity: 0.88; }
  button[type="submit"]:active { transform: scale(0.99); }
  .error {
    background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3);
    color: #fca5a5; border-radius: 10px; padding: 11px 15px;
    font-size: 13px; margin-bottom: 20px; display: flex; align-items: center; gap: 8px;
  }
`;

export function renderAuthPage(error = ''): string {
  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MCP Auth — Finance Dashboard</title>
  <style>
    ${SHARED_STYLES}
    .divider { display: flex; align-items: center; gap: 12px; margin: 24px 0; }
    .divider hr { flex: 1; border: none; border-top: 1px solid rgba(255,255,255,0.08); }
    .divider span { color: #475569; font-size: 12px; }
    .help { color: #475569; font-size: 12px; text-align: center; line-height: 1.6; }
    .help code { color: #a5b4fc; background: rgba(99,102,241,0.1); padding: 2px 6px; border-radius: 4px; font-size: 11px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">📊</div>
    <h1>Finance Dashboard</h1>
    <p class="subtitle">MCP Server — Token Generator</p>
    <div class="badge"><span>🔒</span> Read-only · 30-day token</div>

    ${error ? `<div class="error"><span>⚠️</span> ${error}</div>` : ''}

    <form method="POST" action="/auth">
      <div class="field">
        <label for="auth-email">Email</label>
        <input type="email" id="auth-email" name="email" required
               autocomplete="email" placeholder="you@example.com">
      </div>
      <div class="field">
        <label for="auth-password">Password</label>
        <input type="password" id="auth-password" name="password" required
               autocomplete="current-password" placeholder="••••••••">
      </div>
      <button type="submit">Generate Token →</button>
    </form>

    <div class="divider"><hr><span>how to use</span><hr></div>
    <p class="help">
      Sign in to get a Bearer token. Paste it into your MCP client config as<br>
      <code>Authorization: Bearer &lt;token&gt;</code>
    </p>
  </div>
</body>
</html>`;
}

export function renderTokenResult(token: string, email: string, expiryDate: string, mcpUrl: string): string {
  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MCP Token — Finance Dashboard</title>
  <style>
    ${SHARED_STYLES}
    .card { max-width: 560px; }
    .success-banner {
      display: flex; align-items: center; gap: 10px;
      background: rgba(34,197,94,0.1); border: 1px solid rgba(34,197,94,0.25);
      border-radius: 10px; padding: 12px 15px; margin-bottom: 28px; color: #86efac; font-size: 13px;
    }
    .token-section { margin-bottom: 24px; }
    .token-label { color: #94a3b8; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; }
    .token-box {
      background: rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.1);
      border-radius: 10px; padding: 14px 15px; font-family: 'Courier New', monospace;
      font-size: 11px; color: #a5b4fc; word-break: break-all; line-height: 1.6;
      position: relative; cursor: pointer; transition: border-color 0.2s;
      user-select: all;
    }
    .token-box:hover { border-color: rgba(99,102,241,0.4); }
    .copy-btn {
      background: rgba(99,102,241,0.15); border: 1px solid rgba(99,102,241,0.3);
      color: #a5b4fc; border-radius: 6px; padding: 4px 10px; font-size: 11px;
      font-weight: 600; cursor: pointer; transition: all 0.15s; font-family: inherit;
    }
    .copy-btn:hover { background: rgba(99,102,241,0.3); }
    .copy-btn.copied { background: rgba(34,197,94,0.15); border-color: rgba(34,197,94,0.3); color: #86efac; }
    .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 24px; }
    .meta-item { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); border-radius: 10px; padding: 12px 14px; }
    .meta-item .key { color: #475569; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
    .meta-item .val { color: #cbd5e1; font-size: 12px; font-weight: 500; }
    .instructions {
      background: rgba(15,23,42,0.6); border: 1px solid rgba(255,255,255,0.06);
      border-radius: 12px; padding: 18px;
    }
    .instructions h3 { color: #94a3b8; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 14px; }
    .step { display: flex; gap: 12px; margin-bottom: 14px; align-items: flex-start; }
    .step:last-child { margin-bottom: 0; }
    .step-num { background: rgba(99,102,241,0.2); color: #a5b4fc; border-radius: 50%; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; flex-shrink: 0; margin-top: 1px; }
    .step-text { color: #64748b; font-size: 12px; line-height: 1.6; }
    .step-text code { color: #a5b4fc; background: rgba(99,102,241,0.1); padding: 1px 5px; border-radius: 4px; font-size: 11px; }
    .new-token-link { display: block; text-align: center; margin-top: 20px; color: #6366f1; font-size: 13px; text-decoration: none; }
    .new-token-link:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">✅</div>
    <h1>Token Generated</h1>
    <p class="subtitle" style="margin-bottom:28px">Your MCP access token is ready</p>

    <div class="success-banner">
      <span>🎉</span> Signed in as <strong style="color:#d1fae5">${email}</strong>
    </div>

    <div class="token-section">
      <div class="token-label">
        <span>Access Token</span>
        <button class="copy-btn" id="copy-token" onclick="copyToken()">Copy</button>
      </div>
      <div class="token-box" id="token-display" onclick="copyToken()">${token}</div>
    </div>

    <div class="meta">
      <div class="meta-item">
        <div class="key">Expires</div>
        <div class="val">${expiryDate}</div>
      </div>
      <div class="meta-item">
        <div class="key">Scope</div>
        <div class="val">Read-only</div>
      </div>
      <div class="meta-item">
        <div class="key">MCP Endpoint</div>
        <div class="val" style="font-size:10px;word-break:break-all">${mcpUrl}</div>
      </div>
      <div class="meta-item">
        <div class="key">Type</div>
        <div class="val">Bearer</div>
      </div>
    </div>

    <div class="instructions">
      <h3>📋 How to Connect</h3>
      <div class="step">
        <div class="step-num">1</div>
        <div class="step-text">Copy the token above</div>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <div class="step-text">
          In Claude / Cursor / your MCP client, add a custom server with URL:<br>
          <code>${mcpUrl}</code>
        </div>
      </div>
      <div class="step">
        <div class="step-num">3</div>
        <div class="step-text">
          Set the Authorization header:<br>
          <code>Authorization: Bearer &lt;token&gt;</code>
        </div>
      </div>
      <div class="step">
        <div class="step-num">4</div>
        <div class="step-text">
          For <strong style="color:#cbd5e1">Antigravity / mcp_config.json</strong>, add:<br>
          <code>"env": { "MCP_BEARER_TOKEN": "&lt;token&gt;" }</code>
        </div>
      </div>
    </div>

    <a href="/auth" class="new-token-link">← Generate a new token</a>
  </div>

  <script>
    function copyToken() {
      const token = document.getElementById('token-display').textContent;
      navigator.clipboard.writeText(token).then(() => {
        const btn = document.getElementById('copy-token');
        btn.textContent = '✓ Copied!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2500);
      });
    }
  </script>
</body>
</html>`;
}
