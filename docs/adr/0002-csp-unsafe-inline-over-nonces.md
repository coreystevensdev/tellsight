# 2. Keep `'unsafe-inline'` in script-src instead of migrating to nonces

- Status: Accepted
- Date: 2026-09-29
- Deciders: Corey Stevens

## Context

`apps/web/next.config.ts` sends a Content-Security-Policy on every response, and its `script-src` carries `'unsafe-inline'`. That directive is the weakest thing in the policy, and it comes up every time the headers are reviewed, so this records why it is there and what it would cost to remove.

What it is actually covering is small and not ours. The live `/dashboard` serves 17 external `<script src=>` tags and 3 inline `<script>` blocks, one of which is Next's `self.__next_f.push(...)` hydration payload. All three are framework-generated. There are no nonces on the page today and no `next/script` usage anywhere in `apps/web`. So the question is not whether to allow inline script in general, it is how to let the framework's own three through while blocking an injected fourth.

The alternative is a per-request nonce. Next.js only mints one in middleware, which here is `proxy.ts`.

Three measurements decided this, taken on 2026-09-29:

**The matcher would go from 5 routes to all of them.** `proxy.ts` currently matches `/upload`, `/billing`, `/admin`, `/settings` and `/dashboard`. The app has 24 page routes. A nonce has to reach every rendered page, so the matcher becomes a catch-all with an exclusion regex.

**21 of 24 pages are statically rendered today.** Only 3 carry a `dynamic` export. A nonce is per-request by definition, so every page that receives one opts out of static rendering. This runs on a t3.micro that sits at roughly 262MB available with swap already in use.

**The CSP would move out of static config.** `next.config.ts` evaluates `headers()` at build time and cannot produce a per-request value, so the whole policy moves into `proxy.ts`. Today the header applies to `/(.*)` unconditionally. Afterwards the exclusion regex in the matcher decides which paths get a policy at all, and a path excluded by accident ships with none. That is a regression the current arrangement cannot have.

One concern turned out to be smaller than it first appeared, and is recorded here so it is not raised again as a reason. Widening the matcher does not make `proxy.ts` redirect public routes: every redirect sits inside `if (isProtected)`, gated on `matches(pathname, PROTECTED_ROUTES)`, which is path-based rather than matcher-based. The auth behaviour would not change.

## Decision

Keep `'unsafe-inline'` in `script-src`. Do not migrate to nonces.

The directive is not load-bearing on its own, and the things an injected script would need next are already removed:

- `connect-src 'self'` (plus the Sentry origin when a DSN is set) blocks exfiltration to another origin
- `form-action 'self'` blocks posting the page somewhere else
- `base-uri 'none'` blocks rewriting every relative URL on the page
- `object-src 'none'` and `frame-ancestors 'none'` close the plugin and framing paths

`dangerouslySetInnerHTML` appears nowhere in `apps/web`, verified by grep on 2026-09-29; the only occurrence of the string is a comment mentioning it. React escaping is what keeps injected script out in the first place, and `'unsafe-inline'` only matters once that has already failed.

`style-src 'unsafe-inline'` stays regardless. Tailwind and html-to-image both write inline style attributes, so there is no version of this policy without it.

## Consequences

An injected inline script would execute. The policy narrows what it can do rather than preventing it, and the prevention lives in React's escaping and the absence of raw HTML injection.

The nonce migration is a known quantity if it is ever wanted. It needs a shared `csp(nonce)` builder, the CSP set on both the request headers (Next reads the nonce from there to stamp its own tags) and the response, `'strict-dynamic'` in `script-src` so the 17 external chunks still load, and the matcher widened with an exclusion regex. `proxy.ts` already routes every exit through a `finish()` helper, so the response header is one line rather than one per branch.

There is a failure mode worth naming, because it produces something worse than the current state. A nonce policy that is wired up wrong fails loudly: the nonce in the header does not match the one on the tag, browsers block the framework's own scripts, and the page is blank. The tempting repair is to add `'unsafe-inline'` back alongside the nonce, at which point browsers ignore the nonce entirely and the policy is exactly as permissive as it is today while looking hardened. If this migration is attempted, that is the outcome to watch for.

Nothing in the test suite can confirm a nonce matched. A mismatch is a blank page in a real browser, so verification is browser-only and the E2E job is the only thing that would catch it.

Revisit this if any of the following change: the app starts injecting HTML it did not author, `connect-src` has to widen to third-party origins, the static-rendering count drops far enough that the per-request cost stops mattering, or Next.js gains a way to apply a nonce without routing every request through middleware.
