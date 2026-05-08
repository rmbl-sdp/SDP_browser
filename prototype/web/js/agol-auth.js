// ArcGIS Online OAuth 2.0 (PKCE) for browser-only apps.
// Flow: open popup → user signs in at arcgis.com → callback page postMessages
// {access_token, expires_in, username} back here → we cache in sessionStorage.
//
// AGOL app must be registered as type "Browser" with the redirect URI pointing
// at <origin>/oauth-callback.html.

const PORTAL = "https://www.arcgis.com";
const STORAGE_KEY = "sdp_agol_token";
const VERIFIER_KEY = "sdp_agol_verifier";
const STATE_KEY = "sdp_agol_state";
const CLIENT_KEY = "sdp_agol_client";

function randomString(len = 64) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256b64url(input) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64url(new Uint8Array(hash));
}

export function getStoredToken() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const tok = JSON.parse(raw);
    if (!tok.access_token || !tok.expires_at) return null;
    if (Date.now() >= tok.expires_at - 30_000) return null; // 30s skew
    return tok;
  } catch {
    return null;
  }
}

export function clearToken() {
  sessionStorage.removeItem(STORAGE_KEY);
}

function storeToken(tok) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(tok));
}

export async function signIn({ clientId, redirectUri }) {
  if (!clientId) throw new Error("AGOL_CLIENT_ID not configured");

  const verifier = randomString(64);
  const challenge = await sha256b64url(verifier);
  const state = randomString(16);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);
  // Stash clientId so the callback page can complete the exchange without
  // needing __SDP_CONFIG__ (prototype doesn't load config.js).
  sessionStorage.setItem(CLIENT_KEY, clientId);

  const u = new URL(`${PORTAL}/sharing/rest/oauth2/authorize`);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);

  const popup = window.open(u.toString(), "agol_signin", "width=520,height=720");
  if (!popup) throw new Error("Popup blocked — allow popups for this site and retry");

  return new Promise((resolve, reject) => {
    const onMessage = (ev) => {
      if (ev.origin !== window.location.origin) return;
      const msg = ev.data;
      if (!msg || msg.source !== "sdp-agol-callback") return;
      window.removeEventListener("message", onMessage);
      clearInterval(closedTimer);
      sessionStorage.removeItem(VERIFIER_KEY);
      sessionStorage.removeItem(STATE_KEY);
      sessionStorage.removeItem(CLIENT_KEY);
      if (msg.error) {
        reject(new Error(msg.error));
        return;
      }
      const tok = {
        access_token: msg.access_token,
        username: msg.username || null,
        expires_at: Date.now() + (Number(msg.expires_in || 7200) * 1000),
      };
      storeToken(tok);
      resolve(tok);
    };
    window.addEventListener("message", onMessage);

    // Detect manually closed popup so the caller's promise doesn't dangle.
    const closedTimer = setInterval(() => {
      if (popup.closed) {
        clearInterval(closedTimer);
        window.removeEventListener("message", onMessage);
        reject(new Error("Sign-in cancelled"));
      }
    }, 500);
  });
}
