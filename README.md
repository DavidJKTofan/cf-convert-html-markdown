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

---

Inspired by [skeptrune](https://www.skeptrune.com/posts/use-the-accept-header-to-serve-markdown-instead-of-html-to-llms/) and [Cloudflare AI Search (AI Index)](https://blog.cloudflare.com/an-ai-index-for-all-our-customers/).

## Disclaimer

This project is intended for educational and personal use. You are responsible for implementing appropriate security and operational measures for production deployments. Always audit and test before production rollout.
