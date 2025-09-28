// worker-md-final.ts
// Cloudflare Worker (TypeScript, ES Module)
// - Only handles requests whose path ends with `.md`
// - Converts the corresponding source URL (same path without .md) to Markdown using env.AI.toMarkdown()
// - Caches resulting Markdown in R2 (MARKDOWN_BUCKET) for up to 90 days
// - Verifies it's saving the AI-returned markdown (never overwrites .md key with raw HTML)
// - Recognizable User-Agent and robust Accept header on upstream fetches
// - Debug flags: ?debug=1 (adds debug headers), ?refresh=1 (force re-convert), ?saveHtml=1 (save upstream HTML to a .source.html key)

export interface Env {
	AI: {
		toMarkdown: (
			docs: Array<{ name: string; blob: Blob }>
		) => Promise<Array<{ name: string; mimeType?: string; format?: string; tokens?: number; data: string }>>;
	};
	MARKDOWN_BUCKET?: R2Bucket;
}

const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const DEFAULT_USER_AGENT = 'Cloudflare-HTML-Markdown-Converter/1.0 (+https://developers.cloudflare.com/workers)';

function nowIso() {
	return new Date().toISOString();
}

function mkLog(reqId: string) {
	return (lvl: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => {
		const o = { ts: nowIso(), lvl, req: reqId, msg, ...(meta || {}) };
		const s = JSON.stringify(o);
		if (lvl === 'error') console.error(s);
		else if (lvl === 'warn') console.warn(s);
		else console.log(s);
	};
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const reqId =
			typeof crypto !== 'undefined' && 'randomUUID' in crypto
				? (crypto as any).randomUUID()
				: `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
		const log = mkLog(reqId);
		const t0 = (globalThis as any).performance?.now ? (globalThis as any).performance.now() : Date.now();

		const url = new URL(request.url);
		const pathname = decodeURIComponent(url.pathname || '/');
		log('info', 'incoming request', { method: request.method, pathname });

		// debug controls
		const debugMode = url.searchParams.get('debug') === '1';
		const forceRefresh = url.searchParams.get('refresh') === '1';
		const saveHtml = url.searchParams.get('saveHtml') === '1';
		const upstreamUa = url.searchParams.get('ua') || DEFAULT_USER_AGENT;

		if (!pathname.endsWith('.md')) {
			log('info', 'not a .md request — proxying through', { pathname });
			const proxied = await fetch(request);
			if (debugMode) {
				const h = new Headers(proxied.headers);
				h.set('X-Debug-Request-Id', reqId);
				h.set('X-Debug-Proxy', 'true');
				return new Response(await proxied.arrayBuffer(), { status: proxied.status, statusText: proxied.statusText, headers: h });
			}
			return proxied;
		}

		// compute R2 key and target source URL
		const key = pathname.replace(/^\//, ''); // e.g. articles/foo.md
		const srcUrl = new URL(request.url);
		srcUrl.pathname = pathname.slice(0, -3); // remove trailing .md
		const target = srcUrl.toString();

		log('info', 'processing conversion request', { target, key, forceRefresh, debugMode, saveHtml });

		try {
			// If R2 available and not forced refresh, check cache
			if (env.MARKDOWN_BUCKET && !forceRefresh) {
				log('info', 'checking R2 for cached markdown', { key });
				const existing = await env.MARKDOWN_BUCKET.get(key);
				if (existing) {
					const uploaded = existing.uploaded instanceof Date ? existing.uploaded : null;
					const ageMs = uploaded ? Date.now() - uploaded.getTime() : null;
					const ct = existing.httpMetadata?.contentType || null;
					log('info', 'found existing R2 object', { key, contentType: ct, uploaded: uploaded?.toISOString?.(), ageMs });

					// Ensure existing is actual markdown and fresh
					const isMarkdown = typeof ct === 'string' && ct.toLowerCase().startsWith('text/markdown');
					if (isMarkdown && uploaded && ageMs !== null && ageMs < MAX_AGE_MS) {
						log('info', 'serving fresh markdown from R2', { key, ageDays: Math.round(ageMs / (24 * 3600 * 1000)) });
						const text = await existing.text();
						const headers = new Headers({
							'Content-Type': 'text/markdown; charset=utf-8',
							'X-Cache': 'r2',
							'X-Source-URL': target,
							'X-Debug-Request-Id': reqId,
						});
						if (debugMode) {
							headers.set('X-Debug-R2-Uploaded', uploaded.toISOString());
							headers.set('X-Debug-R2-ContentType', String(ct));
						}
						return new Response(text, { status: 200, headers });
					} else {
						log('info', 'cached object invalid or stale — re-generating', { key, isMarkdown, ageMs });
					}
				} else {
					log('info', 'no cached object found in R2', { key });
				}
			} else if (!env.MARKDOWN_BUCKET) {
				log('warn', 'R2 binding not configured; will not read/write cache');
			} else {
				log('info', 'force refresh requested; skipping R2 read', { forceRefresh });
			}

			// Fetch upstream with robust Accept and User-Agent
			log('info', 'fetching source upstream', { target, upstreamUa });
			const tFetchStart = (globalThis as any).performance?.now ? (globalThis as any).performance.now() : Date.now();
			const upstream = await fetch(target, {
				method: 'GET',
				headers: {
					Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
					'Accept-Language': 'en-US,en;q=0.9',
					'User-Agent': upstreamUa,
				},
				redirect: 'follow',
			});
			const tFetch = Math.round(((globalThis as any).performance?.now ? (globalThis as any).performance.now() : Date.now()) - tFetchStart);

			if (!upstream.ok) {
				log('error', 'upstream fetch failed', { status: upstream.status, statusText: upstream.statusText, tFetch });
				return new Response(`Upstream fetch failed: ${upstream.status} ${upstream.statusText}`, { status: 502 });
			}

			const arrayBuffer = await upstream.arrayBuffer();
			const upstreamContentType = (upstream.headers.get('content-type') || 'text/html').split(';')[0];

			// Optionally save raw HTML to a distinct key for debugging; never overwrite the .md key
			if (saveHtml && env.MARKDOWN_BUCKET) {
				try {
					const htmlKey = `${key}.source.html`;
					log('info', 'saving source HTML to debug key', { htmlKey });
					await env.MARKDOWN_BUCKET.put(htmlKey, arrayBuffer, {
						httpMetadata: { contentType: upstreamContentType },
						customMetadata: { source: target, savedAt: nowIso(), requestId: reqId },
					});
					log('info', 'saved source HTML debug object', { htmlKey });
				} catch (errSaveHtml) {
					log('warn', 'failed to save source HTML to R2', { err: String(errSaveHtml) });
				}
			}

			// Prepare blob for toMarkdown; ensure blob MIME reflects HTML where appropriate
			const blobMime = upstreamContentType || 'text/html';
			const blob = new Blob([arrayBuffer], { type: blobMime });

			// Derive filename for AI call
			let filename = 'document';
			try {
				const parts = new URL(target).pathname.split('/').filter(Boolean);
				filename = parts.length ? parts[parts.length - 1].replace(/\.[^.]+$/, '') : filename;
			} catch (e) {
				log('warn', 'failed to compute filename for toMarkdown, using fallback', { err: String(e) });
			}

			// Call Workers AI toMarkdown
			log('info', 'calling env.AI.toMarkdown', { filename, blobType: blob.type });
			const tAIStart = (globalThis as any).performance?.now ? (globalThis as any).performance.now() : Date.now();
			const results = await env.AI.toMarkdown([{ name: filename, blob }]);
			const tAI = Math.round(((globalThis as any).performance?.now ? (globalThis as any).performance.now() : Date.now()) - tAIStart);
			log('info', 'toMarkdown returned', { resultCount: Array.isArray(results) ? results.length : 0, tAI });

			if (!Array.isArray(results) || !results[0] || typeof results[0].data !== 'string') {
				log('error', 'invalid toMarkdown result shape', { results });
				return new Response('AI conversion failed', { status: 500 });
			}

			const aiResult = results[0];
			log('info', 'ai result meta', { name: aiResult.name, mimeType: aiResult.mimeType, format: aiResult.format, tokens: aiResult.tokens });

			const markdown = aiResult.data;

			// Safety: if AI output looks like HTML (starts with '<') we will not overwrite the .md key.
			if (markdown.trim().startsWith('<')) {
				log('warn', 'AI output appears to be HTML — aborting write to .md key', { preview: markdown.slice(0, 240) });
				if (env.MARKDOWN_BUCKET) {
					const failKey = `${key}.ai-failed.txt`;
					try {
						await env.MARKDOWN_BUCKET.put(failKey, markdown, {
							httpMetadata: { contentType: 'text/plain; charset=utf-8' },
							customMetadata: { source: target, note: 'ai-output-looks-like-html', generatedAt: nowIso(), requestId: reqId },
						});
						log('info', 'saved AI output to debug key', { failKey });
					} catch (errPutFail) {
						log('warn', 'failed to save AI-failed output to R2', { err: String(errPutFail) });
					}
				}
				const headers = new Headers({
					'Content-Type': 'text/plain; charset=utf-8',
					'X-Note': 'ai-output-looks-like-html',
					'X-Debug-Request-Id': reqId,
					'X-Debug-AI-ms': String(tAI),
					'X-Debug-Fetch-ms': String(tFetch),
				});
				if (debugMode)
					headers.set('X-Debug-AI-Meta', JSON.stringify({ mimeType: aiResult.mimeType, format: aiResult.format, tokens: aiResult.tokens }));
				return new Response(markdown, { status: 200, headers });
			}

			// Save only the markdown string to the .md key in R2
			if (env.MARKDOWN_BUCKET) {
				try {
					await env.MARKDOWN_BUCKET.put(key, markdown, {
						httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
						customMetadata: { source: target, generatedAt: nowIso(), requestId: reqId, aiMime: aiResult.mimeType ?? '' },
					});
					log('info', 'saved markdown to R2', { key });
				} catch (errPut) {
					log('warn', 'failed to write markdown to R2 (non-fatal)', { err: String(errPut) });
				}
			}

			const totalMs = Math.round(((globalThis as any).performance?.now ? (globalThis as any).performance.now() : Date.now()) - t0);
			const headers = new Headers({
				'Content-Type': 'text/markdown; charset=utf-8',
				'Cache-Control': 'no-cache, no-store, must-revalidate',
				'X-Cache': env.MARKDOWN_BUCKET ? 'miss,r2-updated' : 'miss,no-r2',
				'X-Source-URL': target,
				'X-Debug-Request-Id': reqId,
				'X-Debug-Fetch-ms': String(tFetch),
				'X-Debug-AI-ms': String(tAI),
				'X-Debug-Duration-ms': String(totalMs),
			});
			if (debugMode)
				headers.set(
					'X-Debug-AI-Meta',
					JSON.stringify({ name: aiResult.name, mimeType: aiResult.mimeType, format: aiResult.format, tokens: aiResult.tokens })
				);

			log('info', 'returning markdown response', { key, totalMs });
			return new Response(markdown, { status: 200, headers });
		} catch (err) {
			const emsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
			log('error', 'unhandled error while generating markdown', {
				err: emsg,
				stack: err instanceof Error ? err.stack?.split('\n').slice(0, 8) : undefined,
			});
			const headers = new Headers({
				'Content-Type': 'text/plain; charset=utf-8',
				'X-Debug-Request-Id': reqId,
			});
			if (url.searchParams.get('debug') === '1') {
				headers.set('X-Debug-Error', emsg);
				if (err instanceof Error && err.stack) headers.set('X-Debug-Stack', err.stack.split('\n').slice(0, 6).join(' | '));
			}
			return new Response(`Internal Server Error\nRequest ID: ${reqId}\n${emsg}`, { status: 500, headers });
		}
	},
};
