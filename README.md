<p align="center">
  <img src="docs/screenshots/banner.png" alt="Tellsight" width="100%">
</p>

<p align="center">
  <a href="https://github.com/coreystevensdev/tellsight/actions/workflows/ci.yml"><img src="https://github.com/coreystevensdev/tellsight/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License">
  <img src="https://img.shields.io/badge/Next.js-16-black.svg" alt="Next.js 16">
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178c6.svg" alt="TypeScript">
</p>

## Overview

**Live demo:** _(deploying shortly)_

Most analytics tools show you what happened. This one tells you what it means. Upload a CSV, get instant charts, and let AI interpret the trends, anomalies, and opportunities your data reveals. No data science degree required.

Built around production patterns end-to-end: multi-tenant architecture with PostgreSQL row-level security, SSE streaming for AI summaries, Stripe billing, and a privacy-first AI pipeline that sends computed statistics rather than raw rows.

## Problem

Small businesses can't afford data scientists, and enterprise analytics platforms overwhelm non-technical users with dashboards full of numbers but no guidance. The gap isn't visualization. Plenty of tools make charts. The gap is interpretation: what do these numbers actually mean for my business?

## Solution

Upload a CSV of your business data. The dashboard instantly visualizes revenue trends, expense breakdowns, and category comparisons. Then AI reads the computed statistics (not your raw data) and explains what's happening in plain English: which costs are rising faster than revenue, where seasonal patterns suggest opportunities, what anomalies deserve attention.

The core thesis: **interpretation over visualization.**

## Features

<p align="center">
  <img src="docs/screenshots/feature-charts.png" alt="Interactive dashboard with revenue and expense charts" width="100%">
</p>

<table>
<tr>
<td width="50%">

<img src="docs/screenshots/feature-ai.png" alt="AI-powered business insights in dark mode">

**AI-Powered Insights.** Claude reads the computed statistics and explains what matters. Summaries stream in real time via SSE.

</td>
<td width="50%">

<img src="docs/screenshots/feature-charts-dark.png" alt="Dashboard charts in dark mode">

**Dark Mode.** System preference detection + manual toggle. Every component, every chart, every panel.

</td>
</tr>
</table>

**Also included:**
- **Stripe billing.** Free tier with AI preview (~150 words), Pro tier for full summaries.
- **Row-level security.** Org-first multi-tenancy with PostgreSQL RLS policies on every table.
- **Shareable insights.** Generate PNG snapshots or shareable links for team collaboration.
- **Dark mode.** System preference detection + manual toggle with oklch color tokens.
- **Demo mode.** Pre-loaded seed data with cached AI summary, zero configuration needed.

## Architecture

```mermaid
flowchart LR
    Browser --> NextJS["Next.js BFF<br/>(proxy.ts)"]
    NextJS --> Express["Express 5 API"]
    Express --> PG[(PostgreSQL 18)]
    Express --> Redis[(Redis 7)]
    Express --> Claude["Claude API"]

    subgraph Curation["Curation Pipeline"]
        direction TB
        Comp["Computation<br/>raw → stats"] --> Score["Scoring<br/>rank by relevance"]
        Score --> Assembly["Assembly<br/>stats → prompt"]
    end

    Express --> Curation
    Curation --> Claude

    Claude -- "SSE stream" --> Browser
```

The browser never talks to Express directly. Everything routes through a Next.js BFF proxy (same-origin, no CORS). The curation pipeline computes statistics locally, scores them by relevance, then assembles a prompt from the top insights. Raw data never reaches the LLM. Only computed statistics. This privacy-by-architecture approach means the AI interprets trends and anomalies without ever seeing individual rows.

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Frontend | Next.js 16, React 19.2, Tailwind CSS 4 | Turbopack for fast dev, RSC for server-rendered dashboard |
| Backend | Express 5, Node.js 22 | Auto promise rejection forwarding, mature middleware ecosystem |
| Database | PostgreSQL 18, Drizzle ORM 0.45.x | RLS for multi-tenancy, Drizzle for type-safe queries |
| Cache | Redis 7 | Rate limiting + AI summary cache |
| AI | Claude API with SSE streaming | Structured prompt engineering, streaming delivery |
| Auth | JWT + refresh rotation, Google OAuth (jose 6.x) | Secure token lifecycle, social login for onboarding |
| Monorepo | pnpm workspaces, Turborepo | Shared schemas between frontend/backend |
| Testing | Vitest, Playwright | Fast unit tests, browser-based E2E and screenshots |
| CI/CD | GitHub Actions (5-stage pipeline) | Lint, test, seed validation, E2E, Docker smoke |

## Getting Started

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose

### Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/coreystevensdev/tellsight.git
cd tellsight

# 2. Create your env file
cp .env.example .env
# Edit .env, most defaults work for local dev
# CLAUDE_API_KEY is optional: seed data includes a pre-generated AI summary

# 3. Start the full stack
docker compose up
```

The app starts at [http://localhost:3000](http://localhost:3000) with seed data pre-loaded. The dashboard shows charts and an AI summary immediately, no account needed.

### Local Development

```bash
pnpm install
pnpm dev          # Start all services via Turborepo
pnpm lint         # Lint all packages
pnpm type-check   # TypeScript check
pnpm test         # Run all tests
pnpm screenshots  # Regenerate README assets via Playwright
```

## Demo

The app ships with seed data: 12 months of synthetic business data across 6 categories (Revenue, Payroll, Marketing, Rent, Supplies, Utilities) with a pre-generated AI summary. No API keys, no accounts. Just `docker compose up` and open the dashboard.

The AI summary highlights the December revenue spike, Q3 marketing dip, October payroll anomaly, and steady rent baseline. That's the kind of thing the curation pipeline surfaces from real-ish data.

## Project Structure

```
apps/web/          Next.js 16 frontend (port 3000)
apps/api/          Express 5 API (port 3001)
packages/shared/   Shared schemas, types, constants
scripts/           CI tools (seed validation, screenshot generation)
e2e/               Playwright E2E tests
```

## License

MIT. See [LICENSE](LICENSE).
