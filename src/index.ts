// Triggers Markdown conversion whenever Accept header
// contains "text/markdown" or "text/plain" (case-insensitive), regardless of .md path.

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

function nowIso(): string {
	return new Date().toISOString();
}

function prefersMarkdownByPresence(acceptHeader: string | null): boolean {
	if (!acceptHeader) return false;
	// simple presence check (case-insensitive). Matches 'text/markdown' or 'text/plain' anywhere.
	return /(?:\btext\/markdown\b|\btext\/plain\b)/i.test(acceptHeader);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const reqId =
			typeof crypto !== 'undefined' && 'randomUUID' in crypto
				? (crypto as any).randomUUID()
				: `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
		const url = new URL(request.url);
		const pathname = decodeURIComponent(url.pathname || '/');
		const acceptHeader = request.headers.get('accept');
		const debugMode = url.searchParams.get('debug') === '1';
		const forceRefresh = url.searchParams.get('refresh') === '1';
		const saveHtml = url.searchParams.get('saveHtml') === '1';
		const upstreamUa = url.searchParams.get('ua') || DEFAULT_USER_AGENT;

		// For debugging, log the Accept header. Check Cloudflare logs or include as response header.
		console.log(JSON.stringify({ ts: nowIso(), reqId, pathname, acceptHeader, debugMode }));

		const acceptPrefers = prefersMarkdownByPresence(acceptHeader);
		const isMdPath = pathname.endsWith('.md');

		// Decision: Accept header presence wins. If Accept requests markdown/plain -> trigger conversion.
		if (!acceptPrefers && !isMdPath) {
			// Not a markdown request — proxy through origin.
			const proxied = await fetch(request);
			if (debugMode) {
				const headers = new Headers(proxied.headers);
				headers.set('X-Debug-Request-Id', reqId);
				headers.set('X-Debug-Accept', String(acceptHeader));
				headers.set('X-Debug-Triggered', 'proxy');
				return new Response(await proxied.arrayBuffer(), { status: proxied.status, statusText: proxied.statusText, headers });
			}
			return proxied;
		}

		// Build source target and R2 key:
		// - If Accept triggered and path doesn't end in .md -> store under path.md
		// - If path ends in .md -> fetch source without .md and keep key as requested path without leading slash
		let key: string;
		const sourceUrl = new URL(request.url);
		if (isMdPath) {
			key = pathname.replace(/^\//, ''); // keep .md in key (e.g., articles/foo.md)
			sourceUrl.pathname = pathname.slice(0, -3); // source HTML at same path without .md
		} else {
			const base = pathname.replace(/^\//, '').replace(/\/$/, '') || 'index';
			key = `${base}.md`;
			// sourceUrl stays as-is (fetch HTML at same path)
		}
		const target = sourceUrl.toString();

		// Echo debug in response headers so curl -v shows them.
		const responseDebugHeaders = new Headers();
		responseDebugHeaders.set('X-Debug-Request-Id', reqId);
		responseDebugHeaders.set('X-Debug-Accept', String(acceptHeader));
		responseDebugHeaders.set('X-Debug-Triggered', acceptPrefers ? 'accept' : 'path-md');

		try {
			// R2 cache check
			if (env.MARKDOWN_BUCKET && !forceRefresh) {
				const existing = await env.MARKDOWN_BUCKET.get(key);
				if (existing) {
					const uploaded = existing.uploaded instanceof Date ? existing.uploaded.getTime() : null;
					const contentType = existing.httpMetadata?.contentType ?? '';
					const ageOk = uploaded !== null && Date.now() - uploaded < MAX_AGE_MS;
					const isMarkdownCT = typeof contentType === 'string' && contentType.toLowerCase().startsWith('text/markdown');
					if (existing && ageOk && isMarkdownCT) {
						const cachedText = await existing.text();
						responseDebugHeaders.set('X-Cache', 'r2');
						responseDebugHeaders.set('X-Source-URL', target);
						if (debugMode) {
							responseDebugHeaders.set('X-Debug-R2-Uploaded', new Date(uploaded!).toISOString());
							responseDebugHeaders.set('X-Debug-R2-ContentType', contentType);
						}
						return new Response(cachedText, { status: 200, headers: responseDebugHeaders });
					}
				}
			}

			// Fetch upstream HTML
			const upstream = await fetch(target, {
				method: 'GET',
				headers: {
					Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'User-Agent': upstreamUa,
				},
				redirect: 'follow',
			});

			if (!upstream.ok) {
				responseDebugHeaders.set('X-Error', `upstream ${upstream.status}`);
				return new Response(`Upstream fetch failed: ${upstream.status} ${upstream.statusText}`, {
					status: 502,
					headers: responseDebugHeaders,
				});
			}

			const arrayBuffer = await upstream.arrayBuffer();
			const upstreamContentType = (upstream.headers.get('content-type') || 'text/html').split(';')[0];
			// Optionally save HTML separately (never overwrite .md key)
			if (saveHtml && env.MARKDOWN_BUCKET) {
				try {
					const htmlKey = `${key}.source.html`;
					await env.MARKDOWN_BUCKET.put(htmlKey, arrayBuffer, {
						httpMetadata: { contentType: upstreamContentType },
						customMetadata: { source: target, savedAt: nowIso(), reqId },
					});
				} catch (e) {
					console.warn('saveHtml failed', String(e));
				}
			}

			// Convert with Workers AI
			const blob = new Blob([arrayBuffer], { type: upstreamContentType || 'text/html' });
			let filename = 'document';
			try {
				const parts = new URL(target).pathname.split('/').filter(Boolean);
				filename = parts.length ? parts[parts.length - 1].replace(/\.[^.]+$/, '') : filename;
			} catch {}
			const results = await env.AI.toMarkdown([{ name: filename, blob }]);
			if (!Array.isArray(results) || !results[0] || typeof results[0].data !== 'string') {
				responseDebugHeaders.set('X-Error', 'ai-invalid-result');
				return new Response('AI conversion failed', { status: 500, headers: responseDebugHeaders });
			}
			const markdown = results[0].data;

			// Safety: if AI output looks like HTML, do not write to primary .md key
			if (markdown.trim().startsWith('<')) {
				if (env.MARKDOWN_BUCKET) {
					const debugKey = `${key}.ai-failed.txt`;
					try {
						await env.MARKDOWN_BUCKET.put(debugKey, markdown, {
							httpMetadata: { contentType: 'text/plain; charset=utf-8' },
							customMetadata: { source: target, note: 'ai-output-looks-like-html', time: nowIso(), reqId },
						});
						responseDebugHeaders.set('X-Note', 'ai-output-looks-like-html-saved');
					} catch (e) {
						responseDebugHeaders.set('X-Note', 'ai-output-looks-like-html-save-failed');
					}
				}
				responseDebugHeaders.set('Content-Type', 'text/plain; charset=utf-8');
				return new Response(markdown, { status: 200, headers: responseDebugHeaders });
			}

			// Save markdown to R2
			if (env.MARKDOWN_BUCKET) {
				try {
					await env.MARKDOWN_BUCKET.put(key, markdown, {
						httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
						customMetadata: { source: target, generatedAt: nowIso(), reqId },
					});
				} catch (e) {
					console.warn('r2 put failed', String(e));
				}
			}

			responseDebugHeaders.set('Content-Type', 'text/markdown; charset=utf-8');
			responseDebugHeaders.set('X-Cache', env.MARKDOWN_BUCKET ? 'miss,r2-updated' : 'miss,no-r2');
			responseDebugHeaders.set('X-Source-URL', target);
			return new Response(markdown, { status: 200, headers: responseDebugHeaders });
		} catch (err) {
			console.error('unhandled', String(err));
			const headers = new Headers();
			headers.set('X-Debug-Request-Id', reqId);
			headers.set('Content-Type', 'text/plain; charset=utf-8');
			return new Response(`Internal Server Error\nRequest ID: ${reqId}\n${String(err)}`, { status: 500, headers });
		}
	},
};
