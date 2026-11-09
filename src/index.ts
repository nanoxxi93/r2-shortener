export interface Env {
	DB: D1Database;
	API_SECRET: string;
	PROJECT_DOMAINS: Record<string, string> | string;
}

interface ShortenItem {
	url: string;
	slug?: string;
	project?: string;
}

const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

// Genera un slug determinista de 6 caracteres a partir de la URL usando SHA-256
async function generateDeterministicSlug(targetUrl: string, length = 8): Promise<string> {
	const data = new TextEncoder().encode(targetUrl);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const view = new DataView(hashBuffer);

	let num = view.getBigUint64(0);
	const base = BigInt(62);
	let slug = '';

	for (let i = 0; i < length; i++) {
		slug += BASE62[Number(num % base)];
		num /= base;
	}

	return slug;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const reqUrl = new URL(request.url);
		const path = reqUrl.pathname.slice(1);

		// 1. CREAR LINKS (POST /api/links)
		if (request.method === 'POST' && path === 'api/links') {
			const auth = request.headers.get('Authorization');
			if (!env.API_SECRET || auth !== `Bearer ${env.API_SECRET}`) {
				return Response.json({ error: 'Unauthorized' }, { status: 401 });
			}

			let payload: ShortenItem | ShortenItem[];
			try {
				payload = await request.json<ShortenItem | ShortenItem[]>();
			} catch {
				return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
			}

			const items = Array.isArray(payload) ? payload : [payload];

			if (items.length === 0 || items.length > 500) {
				return Response.json({ error: 'Send between 1 and 500 items' }, { status: 400 });
			}

			const domains: Record<string, string> =
				typeof env.PROJECT_DOMAINS === 'string' ? JSON.parse(env.PROJECT_DOMAINS) : env.PROJECT_DOMAINS || {};

			const stmt = env.DB.prepare(
				`INSERT INTO links (slug, url, project) VALUES (?, ?, ?)
		   ON CONFLICT(slug) DO UPDATE SET url = excluded.url, project = excluded.project`
			);

			const results: { slug: string; project: string; shortUrl: string; target: string }[] = [];
			const batchStatements: D1PreparedStatement[] = [];
			const cache = caches.default;

			for (const item of items) {
				if (!item.url) {
					return Response.json({ error: 'Missing url property in item' }, { status: 400 });
				}

				const project = item.project || 'default';
				const baseDomain = domains[project] || domains['default'] || '';

				const targetUrl = item.url.startsWith('http') ? item.url : `${baseDomain.replace(/\/$/, '')}/${item.url.replace(/^\//, '')}`;

				// Si no envías "slug" en el JSON, crea uno único basado en el hash de targetUrl
				const slug = item.slug?.trim() || (await generateDeterministicSlug(targetUrl, 8));
				const shortUrl = `${reqUrl.origin}/${slug}`;

				results.push({ slug, project, shortUrl, target: targetUrl });
				batchStatements.push(stmt.bind(slug, targetUrl, project));

				// Si se reutilizó un slug manual, limpiamos su caché del Edge por si cambió la URL
				if (item.slug) {
					ctx.waitUntil(cache.delete(new Request(shortUrl, { method: 'GET' })));
				}
			}

			const CHUNK_SIZE = 100;
			for (let i = 0; i < batchStatements.length; i += CHUNK_SIZE) {
				await env.DB.batch(batchStatements.slice(i, i + CHUNK_SIZE));
			}

			return Response.json({ count: results.length, links: results }, { status: 201 });
		}

		// 2. REDIRECCIONAR (GET /:slug)
		if (request.method === 'GET' && path.length > 0 && !path.startsWith('api/')) {
			const cache = caches.default;
			let response = await cache.match(request);
			if (response) return response;

			const record = await env.DB.prepare('SELECT url FROM links WHERE slug = ?').bind(path).first<{ url: string }>();

			if (!record) return new Response('Not Found', { status: 404 });

			response = new Response(null, {
				status: 301,
				headers: {
					Location: record.url,
					'Cache-Control': 'public, max-age=86400, s-maxage=604800',
				},
			});

			ctx.waitUntil(cache.put(request, response.clone()));
			return response;
		}

		return Response.json({ status: 'ok', service: 'r2-shortener' });
	},
};
