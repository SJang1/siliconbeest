import { Hono } from 'hono';
import type { Env, AppVariables } from '../../env';
import { verifyPassword } from '../../utils/crypto';
import { generateToken } from '../../utils/crypto';
import { generateUlid } from '../../utils/ulid';
import { verifyTurnstile, getTurnstileSettings } from '../../utils/turnstile';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// ---------------------------------------------------------------------------
// HTML templates
// ---------------------------------------------------------------------------

function loginPage(params: {
	clientId: string;
	redirectUri: string;
	scope: string;
	state: string;
	responseType: string;
	error?: string;
	instanceTitle: string;
	turnstileSiteKey?: string;
}): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign in - ${params.instanceTitle}</title>
${params.turnstileSiteKey ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ''}
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         background: #282c37; color: #d9e1e8; display: flex; align-items: center; justify-content: center;
         min-height: 100vh; }
  .card { background: #313543; border-radius: 8px; padding: 32px; width: 100%; max-width: 400px; }
  h1 { font-size: 20px; margin-bottom: 8px; color: #fff; }
  p.sub { font-size: 14px; color: #9baec8; margin-bottom: 24px; }
  label { display: block; font-size: 14px; color: #9baec8; margin-bottom: 4px; }
  input[type="email"], input[type="password"] {
    width: 100%; padding: 10px 12px; border: 1px solid #4a4f5e; border-radius: 4px;
    background: #282c37; color: #d9e1e8; font-size: 14px; margin-bottom: 16px; }
  input:focus { outline: none; border-color: #6364ff; }
  button { width: 100%; padding: 10px; border: none; border-radius: 4px; font-size: 14px;
           font-weight: 600; cursor: pointer; margin-bottom: 8px; }
  .btn-primary { background: #6364ff; color: #fff; }
  .btn-primary:hover { background: #5253e0; }
  .error { background: #ff6b6b22; border: 1px solid #ff6b6b; color: #ff6b6b;
           padding: 10px 12px; border-radius: 4px; margin-bottom: 16px; font-size: 14px; }
  .divider { text-align: center; color: #9baec8; font-size: 12px; margin: 12px 0; }
</style>
</head>
<body>
<div class="card">
  <h1>${params.instanceTitle}</h1>
  <p class="sub">Sign in to authorize the application</p>
  ${params.error ? `<div class="error">${params.error}</div>` : ''}
  <form method="POST" action="/oauth/authorize">
    <input type="hidden" name="client_id" value="${escapeAttr(params.clientId)}" />
    <input type="hidden" name="redirect_uri" value="${escapeAttr(params.redirectUri)}" />
    <input type="hidden" name="scope" value="${escapeAttr(params.scope)}" />
    <input type="hidden" name="state" value="${escapeAttr(params.state)}" />
    <input type="hidden" name="response_type" value="${escapeAttr(params.responseType)}" />
    <label for="email">Email</label>
    <input id="email" type="email" name="email" required autocomplete="username" />
    <label for="password">Password</label>
    <input id="password" type="password" name="password" required autocomplete="current-password" />
    ${params.turnstileSiteKey ? `<div class="cf-turnstile" data-sitekey="${escapeAttr(params.turnstileSiteKey)}" data-theme="dark" style="margin-bottom:16px;"></div>` : ''}
    <button type="submit" class="btn-primary">Sign in</button>
  </form>
  <div class="divider">or</div>
  <button id="passkey-btn" class="btn-primary" style="background:#4a4f5e;display:none;" onclick="passkeyLogin()">🔑 Sign in with Passkey</button>
  <script>
    if (window.PublicKeyCredential) document.getElementById('passkey-btn').style.display='block';
    async function b64url(buf){return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');}
    function b64urlDec(s){s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';const b=atob(s);const u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u.buffer;}
    async function passkeyLogin(){
      try{
        const r=await fetch('/api/v1/auth/webauthn/authenticate/options',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
        const opts=await r.json();
        const cred=await navigator.credentials.get({publicKey:{challenge:b64urlDec(opts.challenge),timeout:opts.timeout,rpId:opts.rpId,userVerification:opts.userVerification||'preferred',allowCredentials:(opts.allowCredentials||[]).map(c=>({id:b64urlDec(c.id),type:c.type,transports:c.transports}))}});
        if(!cred)return;
        const resp=cred.response;
        const v=await fetch('/api/v1/auth/webauthn/authenticate/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:cred.id,rawId:await b64url(cred.rawId),type:cred.type,response:{authenticatorData:await b64url(resp.authenticatorData),clientDataJSON:await b64url(resp.clientDataJSON),signature:await b64url(resp.signature),userHandle:resp.userHandle?await b64url(resp.userHandle):null}})});
        const d=await v.json();
        if(d.access_token){
          const form=document.querySelector('form');
          let pt=form.querySelector('[name=passkey_token]');
          if(!pt){pt=document.createElement('input');pt.type='hidden';pt.name='passkey_token';form.appendChild(pt);}
          pt.value=d.access_token;
          form.querySelector('[name=email]').removeAttribute('required');
          form.querySelector('[name=password]').removeAttribute('required');
          form.submit();
        }else{alert(d.error||'Passkey login failed');}
      }catch(e){if(e.name!=='NotAllowedError')alert(e.message);}
    }
  </script>
</div>
</body>
</html>`;
}

function totpPage(params: {
	sessionToken: string;
	clientId: string;
	redirectUri: string;
	scope: string;
	state: string;
	responseType: string;
	error?: string;
	instanceTitle: string;
}): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Two-Factor Authentication - ${params.instanceTitle}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         background: #282c37; color: #d9e1e8; display: flex; align-items: center; justify-content: center;
         min-height: 100vh; }
  .card { background: #313543; border-radius: 8px; padding: 32px; width: 100%; max-width: 400px; }
  h1 { font-size: 20px; margin-bottom: 8px; color: #fff; }
  p.sub { font-size: 14px; color: #9baec8; margin-bottom: 24px; }
  label { display: block; font-size: 14px; color: #9baec8; margin-bottom: 4px; }
  input[type="text"] {
    width: 100%; padding: 10px 12px; border: 1px solid #4a4f5e; border-radius: 4px;
    background: #282c37; color: #d9e1e8; font-size: 18px; letter-spacing: 4px;
    text-align: center; margin-bottom: 16px; }
  input:focus { outline: none; border-color: #6364ff; }
  button { width: 100%; padding: 10px; border: none; border-radius: 4px; font-size: 14px;
           font-weight: 600; cursor: pointer; }
  .btn-primary { background: #6364ff; color: #fff; }
  .btn-primary:hover { background: #5253e0; }
  .error { background: #ff6b6b22; border: 1px solid #ff6b6b; color: #ff6b6b;
           padding: 10px 12px; border-radius: 4px; margin-bottom: 16px; font-size: 14px; }
</style>
</head>
<body>
<div class="card">
  <h1>Two-Factor Authentication</h1>
  <p class="sub">Enter the code from your authenticator app</p>
  ${params.error ? `<div class="error">${params.error}</div>` : ''}
  <form method="POST" action="/oauth/authorize">
    <input type="hidden" name="client_id" value="${escapeAttr(params.clientId)}" />
    <input type="hidden" name="redirect_uri" value="${escapeAttr(params.redirectUri)}" />
    <input type="hidden" name="scope" value="${escapeAttr(params.scope)}" />
    <input type="hidden" name="state" value="${escapeAttr(params.state)}" />
    <input type="hidden" name="response_type" value="${escapeAttr(params.responseType)}" />
    <input type="hidden" name="session_token" value="${escapeAttr(params.sessionToken)}" />
    <label for="otp_code">Authentication code</label>
    <input id="otp_code" type="text" name="otp_code" inputmode="numeric" autocomplete="one-time-code"
           pattern="[0-9]{6}" maxlength="6" required />
    <button type="submit" class="btn-primary">Verify</button>
  </form>
</div>
</body>
</html>`;
}

function escapeAttr(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// GET /oauth/authorize — render login form
// ---------------------------------------------------------------------------

app.get('/', async (c) => {
	const clientId = c.req.query('client_id') ?? '';
	const redirectUri = c.req.query('redirect_uri') ?? '';
	const scope = c.req.query('scope') ?? 'read';
	const state = c.req.query('state') ?? '';
	const responseType = c.req.query('response_type') ?? 'code';
	const errorMsg = c.req.query('error') ?? undefined;

	// If session_token is present, show TOTP page
	const sessionToken = c.req.query('session_token');
	if (sessionToken) {
		return c.html(
			totpPage({
				sessionToken,
				clientId,
				redirectUri,
				scope,
				state,
				responseType,
				error: errorMsg,
				instanceTitle: c.env.INSTANCE_TITLE,
			}),
		);
	}

	// Some apps pass email/password as query params on GET — handle direct login
	const email = c.req.query('email');
	const password = c.req.query('password');
	if (email && password && clientId) {
		// Validate app
		const oauthApp = await c.env.DB.prepare(
			'SELECT id FROM oauth_applications WHERE client_id = ?1 LIMIT 1',
		).bind(clientId).first();

		if (oauthApp) {
			const user = await c.env.DB.prepare(
				'SELECT id, encrypted_password, otp_enabled FROM users WHERE email = ?1 LIMIT 1',
			).bind(email.toLowerCase()).first();

			if (user) {
				const valid = await verifyPassword(password, user.encrypted_password as string);
				if (valid && !user.otp_enabled) {
					return await issueAuthorizationCode(c, {
						userId: user.id as string,
						applicationId: oauthApp.id as string,
						redirectUri,
						scope,
						state,
					});
				}
			}
		}
		// Fall through to login page on failure
	}

	// Fetch turnstile settings for the login page
	const turnstile = await getTurnstileSettings(c.env.DB, c.env.CACHE);

	return c.html(
		loginPage({
			clientId,
			redirectUri,
			scope,
			state,
			responseType,
			error: errorMsg,
			instanceTitle: c.env.INSTANCE_TITLE,
			turnstileSiteKey: turnstile.enabled ? turnstile.siteKey : undefined,
		}),
	);
});

// ---------------------------------------------------------------------------
// POST /oauth/authorize — process login
// ---------------------------------------------------------------------------

app.post('/', async (c) => {
	const body = await c.req.parseBody();

	const clientId = (body.client_id as string) ?? '';
	const redirectUri = (body.redirect_uri as string) ?? '';
	const scope = (body.scope as string) ?? 'read';
	const state = (body.state as string) ?? '';
	const responseType = (body.response_type as string) ?? 'code';

	// Validate the OAuth application exists
	const oauthApp = await c.env.DB.prepare(
		`SELECT id, redirect_uri, scopes FROM oauth_applications WHERE client_id = ?1 LIMIT 1`,
	)
		.bind(clientId)
		.first();

	if (!oauthApp) {
		return c.html(
			loginPage({
				clientId,
				redirectUri,
				scope,
				state,
				responseType,
				error: 'Unknown application',
				instanceTitle: c.env.INSTANCE_TITLE,
			}),
			400,
		);
	}

	// ---------------------------------------------------------------------------
	// Passkey flow: if passkey_token is present, resolve user from access token
	// ---------------------------------------------------------------------------
	const passkeyToken = body.passkey_token as string | undefined;
	if (passkeyToken) {
		// Look up user from the access token
		const tokenHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(passkeyToken)))).map(b => b.toString(16).padStart(2, '0')).join('');
		const cacheKey = `token:${tokenHash}`;
		let tokenPayload = await c.env.CACHE.get(cacheKey, 'json') as { user: { id: string; account_id: string } } | null;
		if (!tokenPayload) {
			const tokenRow = await c.env.DB.prepare(
				`SELECT t.user_id, u.account_id FROM oauth_access_tokens t JOIN users u ON u.id = t.user_id WHERE t.token = ?1 AND t.revoked_at IS NULL LIMIT 1`,
			).bind(passkeyToken).first<{ user_id: string; account_id: string }>();
			if (tokenRow) tokenPayload = { user: { id: tokenRow.user_id, account_id: tokenRow.account_id } };
		}
		if (tokenPayload) {
			// Issue authorization code directly
			const codeValue = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
			const now = new Date().toISOString();
			const codeId = crypto.randomUUID();
			await c.env.DB.prepare(
				`INSERT INTO oauth_authorization_codes (id, application_id, user_id, code, redirect_uri, scopes, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
			).bind(codeId, oauthApp.id, tokenPayload.user.id, codeValue, redirectUri, scope, now, new Date(Date.now() + 600000).toISOString()).run();
			const sep = redirectUri.includes('?') ? '&' : '?';
			return c.redirect(`${redirectUri}${sep}code=${codeValue}${state ? '&state=' + encodeURIComponent(state) : ''}`);
		}
	}

	// ---------------------------------------------------------------------------
	// 2FA flow: verify TOTP code
	// ---------------------------------------------------------------------------
	const sessionToken = body.session_token as string | undefined;
	const otpCode = body.otp_code as string | undefined;

	if (sessionToken && otpCode) {
		// Look up pending session
		const sessionData = await c.env.SESSIONS.get(`oauth_session:${sessionToken}`, 'json') as {
			userId: string;
		} | null;

		if (!sessionData) {
			return c.html(
				loginPage({
					clientId,
					redirectUri,
					scope,
					state,
					responseType,
					error: 'Session expired. Please sign in again.',
					instanceTitle: c.env.INSTANCE_TITLE,
				}),
				400,
			);
		}

		// Verify TOTP code
		const user2fa = await c.env.DB.prepare(
			`SELECT otp_secret FROM users WHERE id = ?1 AND otp_enabled = 1 LIMIT 1`,
		)
			.bind(sessionData.userId)
			.first();

		if (!user2fa) {
			return c.html(
				totpPage({
					sessionToken,
					clientId,
					redirectUri,
					scope,
					state,
					responseType,
					error: 'Two-factor authentication error',
					instanceTitle: c.env.INSTANCE_TITLE,
				}),
				400,
			);
		}

		// Simple TOTP verification using crypto
		const isValid = await verifyTotp(otpCode, user2fa.otp_secret as string);
		if (!isValid) {
			return c.html(
				totpPage({
					sessionToken,
					clientId,
					redirectUri,
					scope,
					state,
					responseType,
					error: 'Invalid two-factor code',
					instanceTitle: c.env.INSTANCE_TITLE,
				}),
				400,
			);
		}

		// Clean up session
		await c.env.SESSIONS.delete(`oauth_session:${sessionToken}`);

		// Issue authorization code
		return await issueAuthorizationCode(c, {
			userId: sessionData.userId,
			applicationId: oauthApp.id as string,
			redirectUri,
			scope,
			state,
		});
	}

	// ---------------------------------------------------------------------------
	// Turnstile CAPTCHA verification (if enabled)
	// ---------------------------------------------------------------------------
	const turnstile = await getTurnstileSettings(c.env.DB, c.env.CACHE);

	// ---------------------------------------------------------------------------
	// Email/password login
	// ---------------------------------------------------------------------------
	const email = (body.email as string) ?? '';
	const password = (body.password as string) ?? '';

	if (!email || !password) {
		return c.html(
			loginPage({
				clientId,
				redirectUri,
				scope,
				state,
				responseType,
				error: 'Email and password are required',
				instanceTitle: c.env.INSTANCE_TITLE,
				turnstileSiteKey: turnstile.enabled ? turnstile.siteKey : undefined,
			}),
			400,
		);
	}

	// Verify Turnstile token if enabled
	if (turnstile.enabled && turnstile.secretKey) {
		const cfToken = (body['cf-turnstile-response'] as string) ?? '';
		if (!cfToken) {
			return c.html(
				loginPage({
					clientId,
					redirectUri,
					scope,
					state,
					responseType,
					error: 'CAPTCHA verification failed. Please try again.',
					instanceTitle: c.env.INSTANCE_TITLE,
					turnstileSiteKey: turnstile.siteKey,
				}),
				422,
			);
		}
		const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For');
		const valid = await verifyTurnstile(cfToken, turnstile.secretKey, ip);
		if (!valid) {
			return c.html(
				loginPage({
					clientId,
					redirectUri,
					scope,
					state,
					responseType,
					error: 'CAPTCHA verification failed. Please try again.',
					instanceTitle: c.env.INSTANCE_TITLE,
					turnstileSiteKey: turnstile.siteKey,
				}),
				422,
			);
		}
	}

	// Look up user
	const user = await c.env.DB.prepare(
		`SELECT id, encrypted_password, otp_enabled, confirmed_at FROM users WHERE email = ?1 LIMIT 1`,
	)
		.bind(email.toLowerCase())
		.first();

	if (!user) {
		return c.html(
			loginPage({
				clientId,
				redirectUri,
				scope,
				state,
				responseType,
				error: 'Invalid email or password',
				instanceTitle: c.env.INSTANCE_TITLE,
				turnstileSiteKey: turnstile.enabled ? turnstile.siteKey : undefined,
			}),
			400,
		);
	}

	// Verify password
	const passwordValid = await verifyPassword(password, user.encrypted_password as string);
	if (!passwordValid) {
		return c.html(
			loginPage({
				clientId,
				redirectUri,
				scope,
				state,
				responseType,
				error: 'Invalid email or password',
				instanceTitle: c.env.INSTANCE_TITLE,
				turnstileSiteKey: turnstile.enabled ? turnstile.siteKey : undefined,
			}),
			400,
		);
	}

	// Check if email is confirmed
	if (!user.confirmed_at) {
		return c.html(
			loginPage({
				clientId,
				redirectUri,
				scope,
				state,
				responseType,
				error: 'Please confirm your email address before signing in',
				instanceTitle: c.env.INSTANCE_TITLE,
				turnstileSiteKey: turnstile.enabled ? turnstile.siteKey : undefined,
			}),
			403,
		);
	}

	// Check if 2FA is required
	if (user.otp_enabled) {
		const sessionTok = generateToken(64);
		await c.env.SESSIONS.put(
			`oauth_session:${sessionTok}`,
			JSON.stringify({ userId: user.id }),
			{ expirationTtl: 300 }, // 5 minutes
		);

		// Redirect back to GET with session_token
		const params = new URLSearchParams({
			client_id: clientId,
			redirect_uri: redirectUri,
			scope,
			state,
			response_type: responseType,
			session_token: sessionTok,
		});
		return c.redirect(`/oauth/authorize?${params.toString()}`);
	}

	// Issue authorization code directly
	return await issueAuthorizationCode(c, {
		userId: user.id as string,
		applicationId: oauthApp.id as string,
		redirectUri,
		scope,
		state,
	});
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function issueAuthorizationCode(
	c: any,
	opts: {
		userId: string;
		applicationId: string;
		redirectUri: string;
		scope: string;
		state: string;
	},
) {
	const code = generateToken(64);
	const id = generateUlid();
	const now = new Date().toISOString();

	// Store authorization code in D1 (expires in 10 minutes)
	await c.env.DB.prepare(
		`INSERT INTO oauth_authorization_codes (id, application_id, user_id, code, redirect_uri, scopes, expires_at, created_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
	)
		.bind(
			id,
			opts.applicationId,
			opts.userId,
			code,
			opts.redirectUri,
			opts.scope,
			new Date(Date.now() + 10 * 60 * 1000).toISOString(),
			now,
		)
		.run();

	// Build redirect URL
	const url = new URL(opts.redirectUri);
	url.searchParams.set('code', code);
	if (opts.state) {
		url.searchParams.set('state', opts.state);
	}

	return c.redirect(url.toString());
}

async function verifyTotp(code: string, secret: string): Promise<boolean> {
	// Basic TOTP verification (RFC 6238)
	// Time step = 30 seconds, check current and +/- 1 window
	const timeStep = 30;
	const now = Math.floor(Date.now() / 1000);

	for (const offset of [-1, 0, 1]) {
		const counter = Math.floor((now + offset * timeStep) / timeStep);
		const expected = await generateHotp(secret, counter);
		if (expected === code) return true;
	}
	return false;
}

async function generateHotp(secret: string, counter: number): Promise<string> {
	// Decode base32 secret
	const keyBytes = base32Decode(secret);

	// Counter to 8-byte big-endian
	const counterBytes = new Uint8Array(8);
	let c = counter;
	for (let i = 7; i >= 0; i--) {
		counterBytes[i] = c & 0xff;
		c = Math.floor(c / 256);
	}

	// HMAC-SHA1
	const key = await crypto.subtle.importKey(
		'raw',
		keyBytes,
		{ name: 'HMAC', hash: 'SHA-1' },
		false,
		['sign'],
	);
	const sig = await crypto.subtle.sign('HMAC', key, counterBytes);
	const hmac = new Uint8Array(sig);

	// Dynamic truncation
	const offset = hmac[hmac.length - 1] & 0x0f;
	const binary =
		((hmac[offset] & 0x7f) << 24) |
		((hmac[offset + 1] & 0xff) << 16) |
		((hmac[offset + 2] & 0xff) << 8) |
		(hmac[offset + 3] & 0xff);

	const otp = binary % 1_000_000;
	return otp.toString().padStart(6, '0');
}

function base32Decode(encoded: string): Uint8Array {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	const cleaned = encoded.replace(/[=\s]/g, '').toUpperCase();

	let bits = 0;
	let value = 0;
	const output: number[] = [];

	for (const char of cleaned) {
		const idx = alphabet.indexOf(char);
		if (idx === -1) continue;
		value = (value << 5) | idx;
		bits += 5;
		if (bits >= 8) {
			output.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}

	return new Uint8Array(output);
}

export default app;
