// worker-md-accept-presence-logs.ts
// Triggers Markdown conversion when Accept header contains "text/markdown" or "text/plain",
// or when path ends with ".md". Caches results in R2 up to 90 days.

export interface Env {
	AI: {
		toMarkdown: (
			docs: Array<{ name: string; blob: Blob }>
		) => Promise<Array<{ name: string; mimeType?: string; format?: string; tokens?: number; data: string }>>;
	};
	MARKDOWN_BUCKET?: R2Bucket;
}

const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_USER_AGENT = 'Cloudflare-HTML-Markdown-Converter/1.0 (+https://developers.cloudflare.com/workers)';

function nowIso() {
	return new Date().toISOString();
}
// logger helper
function mkLog(requestId: string) {
	return (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => {
		const payload = {
			ts: nowIso(),
			lvl: level,
			req: requestId,
			msg,
			...(meta || {}),
		};
		const out = JSON.stringify(payload);
		if (level === 'error') console.error(out);
		else if (level === 'warn') console.warn(out);
		else console.log(out);
	};
}

function prefersMarkdownByPresence(acceptHeader: string | null): boolean {
	if (!acceptHeader) return false;
	return /(?:\btext\/markdown\b|\btext\/plain\b)/i.test(acceptHeader);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const reqId =
			typeof crypto !== 'undefined' && 'randomUUID' in crypto
				? (crypto as any).randomUUID()
				: `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
		const log = mkLog(reqId);

		const url = new URL(request.url);
		const pathname = decodeURIComponent(url.pathname || '/');
		const acceptHeader = request.headers.get('accept');
		const debugMode = url.searchParams.get('debug') === '1';
		const forceRefresh = url.searchParams.get('refresh') === '1';
		const saveHtml = url.searchParams.get('saveHtml') === '1';
		const upstreamUa = url.searchParams.get('ua') || DEFAULT_USER_AGENT;

		log('info', 'incoming', { pathname, acceptHeader, debugMode, forceRefresh });

		const acceptPrefers = prefersMarkdownByPresence(acceptHeader);
		const isMdPath = pathname.endsWith('.md');

		if (!acceptPrefers && !isMdPath) {
			log('info', 'proxy pass-through');
			const proxied = await fetch(request);
			return proxied;
		}

		let key: string;
		const sourceUrl = new URL(request.url);
		if (isMdPath) {
			key = pathname.replace(/^\//, '');
			sourceUrl.pathname = pathname.slice(0, -3);
		} else {
			const base = pathname.replace(/^\//, '').replace(/\/$/, '') || 'index';
			key = `${base}.md`;
		}
		const target = sourceUrl.toString();
		log('info', 'conversion triggered', { key, target, reason: acceptPrefers ? 'accept' : 'path' });

		try {
			if (env.MARKDOWN_BUCKET && !forceRefresh) {
				const existing = await env.MARKDOWN_BUCKET.get(key);
				if (existing) {
					const uploaded = existing.uploaded instanceof Date ? existing.uploaded.getTime() : null;
					const contentType = existing.httpMetadata?.contentType ?? '';
					const ageOk = uploaded !== null && Date.now() - uploaded < MAX_AGE_MS;
					const isMarkdownCT = typeof contentType === 'string' && contentType.toLowerCase().startsWith('text/markdown');
					if (existing && ageOk && isMarkdownCT) {
						log('info', 'cache hit', { key, uploaded: new Date(uploaded!).toISOString(), contentType });
						const cachedText = await existing.text();
						return new Response(cachedText, {
							status: 200,
							headers: {
								'Content-Type': 'text/markdown; charset=utf-8',
								'X-Cache': 'r2',
								'X-Source-URL': target,
								'X-Debug-Request-Id': reqId,
							},
						});
					}
				}
			}

			log('info', 'fetching upstream', { target, ua: upstreamUa });
			const upstream = await fetch(target, {
				method: 'GET',
				headers: {
					Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'User-Agent': upstreamUa,
				},
				redirect: 'follow',
			});

			if (!upstream.ok) {
				log('error', 'upstream failed', { status: upstream.status, statusText: upstream.statusText });
				return new Response(`Upstream fetch failed: ${upstream.status} ${upstream.statusText}`, { status: 502 });
			}

			const arrayBuffer = await upstream.arrayBuffer();
			const upstreamContentType = (upstream.headers.get('content-type') || 'text/html').split(';')[0];

			if (saveHtml && env.MARKDOWN_BUCKET) {
				const htmlKey = `${key}.source.html`;
				try {
					await env.MARKDOWN_BUCKET.put(htmlKey, arrayBuffer, {
						httpMetadata: { contentType: upstreamContentType },
						customMetadata: { source: target, savedAt: new Date().toISOString(), reqId },
					});
					log('info', 'saved html snapshot', { htmlKey });
				} catch (e) {
					log('warn', 'failed to save html snapshot', { err: String(e) });
				}
			}

			const blob = new Blob([arrayBuffer], { type: upstreamContentType || 'text/html' });
			let filename = 'document';
			try {
				const parts = new URL(target).pathname.split('/').filter(Boolean);
				filename = parts.length ? parts[parts.length - 1].replace(/\.[^.]+$/, '') : filename;
			} catch {}
			log('info', 'calling AI.toMarkdown', { filename });

			const results = await env.AI.toMarkdown([{ name: filename, blob }]);
			if (!Array.isArray(results) || !results[0] || typeof results[0].data !== 'string') {
				log('error', 'ai conversion invalid result', { results });
				return new Response('AI conversion failed', { status: 500 });
			}
			const markdown = results[0].data;

			if (markdown.trim().startsWith('<')) {
				log('warn', 'ai output looks like html', { snippet: markdown.slice(0, 80) });
				if (env.MARKDOWN_BUCKET) {
					const debugKey = `${key}.ai-failed.txt`;
					try {
						await env.MARKDOWN_BUCKET.put(debugKey, markdown, {
							httpMetadata: { contentType: 'text/plain; charset=utf-8' },
							customMetadata: { source: target, note: 'ai-output-looks-like-html', time: new Date().toISOString(), reqId },
						});
						log('info', 'saved ai-failed output', { debugKey });
					} catch (e) {
						log('warn', 'failed saving ai-failed output', { err: String(e) });
					}
				}
				return new Response(markdown, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
			}

			if (env.MARKDOWN_BUCKET) {
				await env.MARKDOWN_BUCKET.put(key, markdown, {
					httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
					customMetadata: { source: target, generatedAt: new Date().toISOString(), reqId },
				});
				log('info', 'markdown saved to r2', { key });
			}

			return new Response(markdown, {
				status: 200,
				headers: {
					'Content-Type': 'text/markdown; charset=utf-8',
					'Cache-Control': 'no-cache, no-store, must-revalidate',
					'X-Cache': env.MARKDOWN_BUCKET ? 'miss,r2-updated' : 'miss,no-r2',
					'X-Source-URL': target,
					'X-Debug-Request-Id': reqId,
				},
			});
		} catch (err) {
			log('error', 'unhandled', { err: String(err) });
			return new Response(String(err), { status: 500 });
		}
	},
};
