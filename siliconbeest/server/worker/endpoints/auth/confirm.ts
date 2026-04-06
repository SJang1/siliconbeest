import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import type { AppVariables } from '../../types';
import { getInstanceTitle } from '../../services/instance';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

function renderPage(title: string, body: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         background: #282c37; color: #d9e1e8; display: flex; align-items: center; justify-content: center;
         min-height: 100vh; }
  .card { background: #313543; border-radius: 8px; padding: 32px; width: 100%; max-width: 400px; text-align: center; }
  h1 { font-size: 20px; margin-bottom: 16px; color: #fff; }
  p { font-size: 14px; color: #9baec8; margin-bottom: 16px; line-height: 1.5; }
  .success { color: #79bd9a; }
  .error { color: #ff6b6b; }
  a.btn { display: inline-block; padding: 10px 24px; border-radius: 4px; font-size: 14px;
          font-weight: 600; text-decoration: none; background: #6364ff; color: #fff; margin-top: 8px; }
  a.btn:hover { background: #5253e0; }
</style>
</head>
<body>
<div class="card">
${body}
</div>
</body>
</html>`;
}

app.get('/', async (c) => {
	const token = c.req.query('token');
	const domain = env.INSTANCE_DOMAIN;
	const title = await getInstanceTitle();

	if (!token) {
		return c.html(renderPage(`Error - ${title}`,
			`<h1 class="error">Invalid Link</h1>
<p>No confirmation token provided.</p>`), 400);
	}

	// Look up token in KV
	const data = await env.CACHE.get('email_confirm:' + token, 'json') as { userId: string; email: string } | null;

	if (!data) {
		return c.html(renderPage(`Error - ${title}`,
			`<h1 class="error">Token Expired or Invalid</h1>
<p>This confirmation link has expired or has already been used. Please request a new confirmation email.</p>`), 400);
	}

	// Confirm the user
	const now = new Date().toISOString();
	await env.DB.prepare('UPDATE users SET confirmed_at = ?1, confirmation_token = NULL WHERE id = ?2').bind(now, data.userId).run();

	// Delete the KV entry
	await env.CACHE.delete('email_confirm:' + token);

	return c.html(renderPage(`Email Confirmed - ${title}`,
		`<h1 class="success">Email Confirmed!</h1>
<p>Your email address <strong>${data.email}</strong> has been verified.</p>
<p>You can now sign in to your account.</p>
<a class="btn" href="https://${domain}">Go to ${title}</a>`));
});

export default app;
