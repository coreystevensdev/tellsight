# Demo Walkthrough Plan

Recording guide for a 3-4 minute portfolio demo (Loom or similar).

## Before Recording

- `docker compose up`, full stack running
- Browser at `http://localhost:3000`, incognito window
- Dark mode OFF (start in light mode for contrast)
- Browser zoom 110-125% so UI reads well on small embeds
- Close unrelated tabs, silence notifications

## Script

### 1. Hook (10s)

Open on the dashboard with seed data visible.

"This is an analytics dashboard that does something most don't, it explains your data in plain English. Upload a CSV of your business numbers, and AI tells you what matters."

### 2. Dashboard + AI Summary (30s)

- Show the charts: revenue trend, expense breakdown, category comparison
- Scroll to the AI summary card, point out that it's already generated from seed data
- Highlight a specific insight the AI surfaced (December revenue spike, October payroll anomaly)
- Click the transparency panel to show what stats were sent to the LLM

"The AI never sees your raw data. It only gets computed statistics, revenue trends, anomaly scores, category comparisons. That's a deliberate architectural choice."

### 3. CSV Upload (30s)

- Click Upload, select a sample CSV
- Show the preview table with column types and validation
- Confirm the upload
- Watch the dashboard update with the new dataset
- Trigger a new AI summary, show the SSE streaming (text appearing word by word)

"The summary streams in real time via Server-Sent Events. You see the analysis build rather than waiting for a loading spinner."

### 4. Sharing (20s)

- Click the share button on the AI summary
- Generate a PNG snapshot
- Create a shareable link
- Open the link in a new tab to show the public read-only view

"Your team doesn't need an account to see shared insights."

### 5. Dark Mode (10s)

- Toggle to dark mode
- Let it settle, show the dashboard in dark theme
- Toggle to system preference

Quick transition, no narration needed beyond "dark mode works."

### 6. Architecture Callouts (40s)

Switch to the terminal or code briefly.

- Show `docker compose up` output, 4 services (web, api, db, redis)
- Quick scroll through `apps/api/src/index.ts`, middleware chain, graceful shutdown
- Show `packages/shared/`, shared types between frontend and backend
- Mention: "Row-level security on every table, Stripe billing with webhook lifecycle, 781 tests across 75 files"

"This isn't a tutorial project. It's built the way I'd build a production SaaS, multi-tenant, tested, and deployed through a 5-stage CI pipeline."

### 7. Close (10s)

Back to the dashboard.

"If you want to try it: `docker compose up`, open localhost:3000, and you'll see exactly what you just saw. Link in the README."

## Recording Tips

- Keep cursor movements deliberate, avoid darting around the screen
- Pause 1-2 seconds on each view so it registers on video
- Don't try to show everything. Skip: admin panel, billing page, invite system. These are in the README for people who dig deeper.
- If you stumble, just keep going. A slightly imperfect take feels more genuine than a rehearsed pitch.
- Aim for 3 minutes. Under 4 minutes is fine. Over 5 minutes is too long, hiring managers skim.

## Post-Recording

- Upload to Loom or YouTube (unlisted)
- Add the link to the README under the Overview section
- Add a thumbnail screenshot (hero-light.png works)
