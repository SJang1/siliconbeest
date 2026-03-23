import { Hono } from 'hono';
import type { Env, AppVariables } from '../../env';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// GET /.well-known/host-meta
app.get('/', async (c) => {
	const domain = c.env.INSTANCE_DOMAIN;

	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0">
  <Link rel="lrdd" template="https://${domain}/.well-known/webfinger?resource={uri}" />
</XRD>`;

	return c.body(xml, 200, {
		'Content-Type': 'application/xrd+xml; charset=utf-8',
		'Cache-Control': 'max-age=259200, public',
	});
});

export default app;
