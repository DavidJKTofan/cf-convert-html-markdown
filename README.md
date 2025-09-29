# Cloudflare Workers Markdown Converter

A Cloudflare Workers project that converts requested HTML pages to Markdown using the [Workers AI `toMarkdown()`](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/) API and caches the resulting `.md` files in R2 for up to 90 days.

## How it works

1. Requests ending with `.md` are intercepted.
2. Worker computes the source URL by stripping `.md` from the request path.
3. Worker checks R2 for a cached object at `key = path-without-leading-slash` (e.g. `articles/foo.md`).
4. If a cached object exists and is less than 90 days old, it is returned directly.
5. Otherwise, the worker:
   - Fetches the source HTML with a recognizable `User-Agent` and proper `Accept` headers.
   - Converts the HTML to Markdown via `env.AI.toMarkdown()`.
   - Saves the Markdown to R2 with metadata.
   - Returns the Markdown response.

## Example usage

```bash
# First request: converts and caches
curl -H "Accept: text/markdown" "https://example.com/articles/cloudflare-l7-security-recommendations.md"

# Subsequent request within 90 days: served from R2
curl -H "Accept: text/markdown" "https://example.com/articles/cloudflare-l7-security-recommendations.md"

# Sending an Accept Header with Text or Markdown will return the site in Markdown too
curl -H "Accept: text/plain" "https://www.example.com/"
curl -H "Accept: text/markdown" "https://www.example.com/"
```

## Debug options

- `?debug=1` — include debug headers.
- `?refresh=1` — force regeneration and overwrite cache.
- `?saveHtml=1` — save the raw upstream HTML to a separate `.source.html` object in R2 for inspection.

## Required bindings

- `AI` — [Workers AI](https://developers.cloudflare.com/workers-ai/configuration/bindings/) binding (provides `env.AI.toMarkdown()`).
- `MARKDOWN_BUCKET` — [R2](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) bucket binding used to store generated `.md` files.

## Deployment

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/DavidJKTofan/cf-convert-html-markdown)

> Deploy as [Route](https://developers.cloudflare.com/workers/configuration/routing/routes/) on the blog / article path.

## Security and limits

- The worker fetches arbitrary external URLs derived from the request path. Restrict or validate requests in production.
- Respect Workers AI model usage quotas and R2 storage costs.
- Upstream fetch failures return `502`. AI conversion failures return `500`.
- If AI returns HTML instead of Markdown, the worker avoids corrupting the `.md` key and saves the raw output to a debug file instead.

> Ensure that you are not blocking this Worker with your own WAF security rules.

# Alternative

Use [Snippets](https://developers.cloudflare.com/rules/snippets/when-to-use/) instead:

```javascript
// JavaScript ES Module snippet suitable for Cloudflare "Snippets" (no bindings).
// Replace ACCOUNT_ID and API_TOKEN placeholders below before deploying.
//
// Behavior (simple):
// - If request Accept header contains "text/markdown" or "text/plain" -> convert the requested URL to Markdown.
// - Or if the path ends with `.md` -> convert the same URL with `.md` removed.
// - Otherwise proxy request to origin unchanged.
// - Uses the Cloudflare REST API: POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/tomarkdown
// - No R2 caching (Snippets cannot use Worker bindings). Minimal, dependency-free.

const ACCOUNT_ID = 'REDACTED_ACCOUNT_ID';
const API_TOKEN = 'REDACTED_API_TOKEN'; // needs `Account.Cloudflare Workers AI` / toMarkdown permission

const API_ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/tomarkdown`;
const DEFAULT_USER_AGENT = 'Cloudflare-Snippet-Markdown-Converter/1.0 (+https://developers.cloudflare.com/workers)';

function prefersMarkdownByPresence(acceptHeader) {
	if (!acceptHeader) return false;
	return /(?:\btext\/markdown\b|\btext\/plain\b)/i.test(acceptHeader);
}

export default {
	async fetch(request) {
		const url = new URL(request.url);
		const pathname = decodeURIComponent(url.pathname || '/');
		const acceptHeader = request.headers.get('accept');
		const triggeredByAccept = prefersMarkdownByPresence(acceptHeader);
		const isMdPath = pathname.endsWith('.md');

		// If not triggered, proxy to origin
		if (!triggeredByAccept && !isMdPath) {
			return fetch(request);
		}

		// Compute source URL to fetch HTML from:
		// - If path has .md: remove .md to get source HTML.
		// - If triggered by Accept only: keep the original path (fetch the page as-is).
		const sourceUrl = new URL(request.url);
		if (isMdPath) sourceUrl.pathname = pathname.slice(0, -3); // strip ".md"
		const target = sourceUrl.toString();

		// Fetch upstream HTML
		const upstream = await fetch(target, {
			method: 'GET',
			headers: {
				Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
				'User-Agent': DEFAULT_USER_AGENT,
			},
			redirect: 'follow',
		});

		if (!upstream.ok) {
			return new Response(`Upstream fetch failed: ${upstream.status} ${upstream.statusText}`, { status: 502 });
		}

		const arrayBuffer = await upstream.arrayBuffer();
		const upstreamContentType = (upstream.headers.get('content-type') || 'text/html').split(';')[0] || 'text/html';
		const blob = new Blob([arrayBuffer], { type: upstreamContentType });

		// Build multipart/form-data payload via FormData
		const form = new FormData();
		// supply a filename derived from the path
		let filename = 'document';
		try {
			const parts = new URL(target).pathname.split('/').filter(Boolean);
			filename = parts.length ? parts[parts.length - 1].replace(/\.[^.]+$/, '') : filename;
		} catch (e) {}
		// append as 'files' (matches CLI example and API docs)
		form.append('files', blob, filename);

		// Call Cloudflare AI REST endpoint
		const apiResp = await fetch(API_ENDPOINT, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${API_TOKEN}`,
				// Note: do NOT set Content-Type here; fetch will set the multipart boundary for FormData
				Accept: 'application/json',
			},
			body: form,
		});

		if (!apiResp.ok) {
			const text = await apiResp.text().catch(() => '');
			return new Response(`AI toMarkdown API failed: ${apiResp.status} ${apiResp.statusText}\n${text}`, { status: 502 });
		}

		// parse response flexibly (API shape can be an array or an object with result)
		let json;
		try {
			json = await apiResp.json();
		} catch (e) {
			const txt = await apiResp.text().catch(() => '');
			return new Response(`AI toMarkdown parse error: ${String(e)}\n${txt}`, { status: 502 });
		}

		// Extract markdown from possible shapes:
		// - direct array: [{ data: "..." }]
		// - { result: [{ data: "..." }], success: true, ... }
		// - { results: [...] }
		let markdown = null;
		if (Array.isArray(json) && json[0] && typeof json[0].data === 'string') {
			markdown = json[0].data;
		} else if (Array.isArray(json.result) && json.result[0] && typeof json.result[0].data === 'string') {
			markdown = json.result[0].data;
		} else if (Array.isArray(json.results) && json.results[0] && typeof json.results[0].data === 'string') {
			markdown = json.results[0].data;
		} else if (json?.data && typeof json.data === 'string') {
			// defensive fallback
			markdown = json.data;
		}

		if (typeof markdown !== 'string') {
			// If no markdown found, return entire JSON for debugging (text/plain)
			return new Response(JSON.stringify(json, null, 2), {
				status: 502,
				headers: { 'Content-Type': 'application/json; charset=utf-8' },
			});
		}

		// Return Markdown to client
		return new Response(markdown, {
			status: 200,
			headers: {
				'Content-Type': 'text/markdown; charset=utf-8',
				'X-Source-URL': target,
				'Cache-Control': 'no-cache, no-store, must-revalidate',
			},
		});
	},
};
```

---

Inspired by [skeptrune](https://www.skeptrune.com/posts/use-the-accept-header-to-serve-markdown-instead-of-html-to-llms/) and [Cloudflare AI Search (AI Index)](https://blog.cloudflare.com/an-ai-index-for-all-our-customers/).

# Disclaimer

This project is intended for educational and personal use. You are responsible for implementing appropriate security and operational measures for production deployments. Always audit and test before production rollout.
