# Go-to-Market Plan

A 16-week plan from current state to Product Hunt launch and beyond. Assumes solo founder, ~20 hours/week, split between product development and marketing.

**Start date:** Week of 2026-04-20
**Product Hunt launch target:** Week 12 (2026-07-13)
**Revenue target:** 10 paying customers ($290 MRR) by Week 16

---

## Positioning

**One-liner:** AI-powered analytics that explains your business data in plain English.

**For:** Small business owners who want to understand their financials without hiring an analyst or learning spreadsheets.

**Against:** Fathom (accountant-configured reporting, no AI interpretation), Pulse (cash flow only), spreadsheets (no interpretation at all).

**Wedge:** Upload a CSV or connect QuickBooks. Get a plain-English explanation of what's happening in your business, not just charts, but what the charts mean and what to do about it.

**Enemy:** "Dashboards that show numbers without explaining what they mean."

**Pricing (decided 2026-04-17):**
- **Free**, Dashboard + charts + AI preview (~150 words, truncated)
- **Pro $29/mo** ($19/mo annual), Full AI interpretation, weekly email digest, proactive alerts, export, unlimited datasets
- **Strategy:** Maximize adoption at $29. Raise to $39-49 once retention data and testimonials justify it. Price lives in Stripe (STRIPE_PRICE_ID env var), not code, can change without a deploy.

---

## Phase 1: Production & Foundation (Weeks 1-4)

Goal: Get the product live on the internet so real people can use it.

### Week 1 (Apr 20-26), Deploy to Production

**Product:**
- [ ] Deploy frontend to Vercel (follow deployment-roadmap.md topology)
- [ ] Deploy API to Railway or Fly.io
- [ ] Provision Neon/Supabase PostgreSQL + Upstash Redis
- [ ] Switch Stripe from test mode to live keys
- [ ] Add production Google OAuth redirect URI
- [ ] Verify seed data + demo mode work in production
- [ ] Smoke test: full signup → upload CSV → see AI summary flow

**Marketing:**
- [ ] Register domain (if not done)
- [ ] Set up Plausible or PostHog analytics (not Google Analytics, you're the privacy-respecting alternative)
- [ ] Create Twitter/X account for the product
- [ ] Write first Twitter thread: "I built an AI that reads your financial data and tells you what it means in plain English. Here's the story." (attach screenshot of AI summary)

### Week 2 (Apr 27-May 3), Critical Production Gaps

**Product:**
- [ ] Add Sentry error tracking (API + web)
- [ ] Add audit logging table (who, what, when, org_id), financial product needs this
- [ ] Add basic GDPR data deletion endpoint (account deletion removes all user data)
- [ ] Set up automated database backups (Neon has built-in, or pg_dump cron)

**Marketing:**
- [ ] Write landing page copy, rewrite app/page.tsx hero section for conversion
  - Headline: "Your business data, explained in English"
  - Subhead: "Upload a CSV or connect QuickBooks. Get AI-powered insights in seconds, not charts you can't read."
  - CTA: "Try free, no credit card"
  - Social proof section (empty for now, add testimonials as they come)
- [ ] Post Twitter thread: "Why I'm building this, the problem with analytics dashboards" (2-3 tweets about Marcus persona, without naming him)

### Week 3 (May 4-10), Weekly Email Digest (High-Impact Feature)

**Product:**
- [ ] Build weekly email digest system
  - Cron job (Sunday evening) that generates AI summary for each active org
  - Email template: 3-5 bullet points of "what happened this week"
  - Include one chart snapshot (revenue trend or biggest mover)
  - CTA: "See full dashboard →"
  - Only for Pro subscribers (free users get "upgrade to get weekly insights")
- [ ] This is the "product comes to you" feature that Fathom doesn't have

**Marketing:**
- [ ] LinkedIn post: screenshot of the email digest, caption "What if your business data emailed you every week with what's changing?"
- [ ] Twitter post: behind-the-scenes of building the email system
- [ ] Submit to 3 startup directories (BetaList, StartupBase, SaaSHub)

### Week 4 (May 11-17), Proactive Alerts

**Product:**
- [ ] Build threshold-based alerts
  - Let users set simple rules: "Alert me if monthly expenses exceed $X"
  - Or auto-detect: anomaly detection already exists in curation pipeline (StatType.Anomaly)
  - Deliver via email (SMS later)
  - AI explains the alert in plain English: "Your shipping costs were $4,200 this month, 40% higher than your 3-month average of $3,000. This was driven by 12 more shipments than usual."
- [ ] This differentiates from every competitor, proactive AI, not reactive dashboards

**Marketing:**
- [ ] Twitter thread: "Most dashboards wait for you to log in. Ours emails you when something's wrong." (with screenshot of alert email)
- [ ] Start r/smallbusiness engagement (2-3 genuinely helpful comments per week, no self-promotion yet)

---

## Phase 2: Distribution & Content (Weeks 5-8)

Goal: Build organic discovery through content, start building a waitlist for Product Hunt.

### Week 5 (May 18-24), SEO Content Sprint

**Product:**
- [ ] Bug fixes and polish from early users (if any)
- [ ] Add "Powered by Claude" transparency badge to AI summaries (trust signal)
- [ ] Mobile responsive polish, test dashboard on iPhone/Android, fix layout issues

**Marketing, write and publish 3 SEO articles on a /blog route or separate blog:**
- [ ] "How to Read Your P&L Statement (Without an Accounting Degree)", top-funnel, targeting SMB owners who Google this
- [ ] "5 Financial Metrics Every Small Business Should Track Monthly", mid-funnel, naturally mentions your product
- [ ] "What Your Accountant's Reports Actually Mean", mid-funnel, positions you as the translator

### Week 6 (May 25-31), QuickBooks Integration Ship

**Product:**
- [ ] Complete QuickBooks OAuth flow (spec exists, implementation started)
- [ ] Ship QB sync: connect → pull transactions → normalize → show in dashboard
- [ ] Test with real QuickBooks sandbox data
- [ ] Add "Connect QuickBooks" button to onboarding flow and settings

**Marketing:**
- [ ] Twitter announcement: "You can now connect QuickBooks and get AI-powered insights on your real financial data"
- [ ] LinkedIn post targeting small business owners who use QB
- [ ] Write SEO article: "QuickBooks Reporting Alternatives 2026", bottom-funnel, directly comparative

### Week 7 (Jun 1-7), Accountant Outreach

**Product:**
- [ ] Add "Invite your accountant" flow, accountant gets read-only access to client dashboard
- [ ] This makes your product a conversation starter between owner and accountant

**Marketing, accountant channel (Fathom's distribution, adapted for you):**
- [ ] Identify 20 bookkeepers/fractional CFOs on LinkedIn who serve SMBs
- [ ] DM 10 of them: "I built a tool that explains financial data in plain English for your clients. Would you try it with one client? Free Pro account for you."
- [ ] Goal: 3-5 accountants willing to try it with one client each
- [ ] Write SEO article: "Fathom vs [Your Product], Which SMB Analytics Tool Is Right for You?"

### Week 8 (Jun 8-14), Comparison & Bottom-Funnel Content

**Product:**
- [ ] Cash flow forecasting (simple version)
  - "If current trends continue, here's your cash position in 3 months"
  - Linear projection based on trailing 3-6 months
  - Display as a chart with confidence band
  - AI interprets: "At your current burn rate, you'll have ~$12,000 in the bank by September. Your biggest risk is the seasonal dip in July, last year revenue dropped 22% that month."
- [ ] This is table-stakes for SMB financial tools, Fathom has it, you need it

**Marketing:**
- [ ] Write 2 more SEO articles:
  - "Small Business Analytics Dashboard, Do You Need One?"
  - "How AI Is Changing Small Business Financial Analysis"
- [ ] Product Hunt "coming soon" page, start collecting subscribers
- [ ] Twitter milestone post: user count, what you've shipped, what's next

---

## Phase 3: Launch Preparation (Weeks 9-11)

Goal: Build launch momentum, collect testimonials, prepare Product Hunt assets.

### Week 9 (Jun 15-21), Testimonial Collection & Polish

**Product:**
- [ ] In-app feedback widget (simple modal: "How useful was this AI insight? 1-5 + text")
- [ ] Fix any issues reported by early users
- [ ] Performance audit, dashboard load time under 2 seconds
- [ ] Dark mode polish (already built, verify it looks good for screenshots)

**Marketing:**
- [ ] Email early users asking for a testimonial quote (even 5 users is enough)
- [ ] Record 2-minute demo video: upload CSV → AI explains data → "aha moment"
  - Screen recording with voiceover
  - Show the actual AI output, not a mockup
  - End with: "Try it free at [domain]"
- [ ] Post demo video on Twitter, LinkedIn

### Week 10 (Jun 22-28), Product Hunt Prep

**Product:**
- [ ] Create a "Product Hunt special", first 100 PH users get 3 months Pro free
- [ ] Landing page variant for Product Hunt traffic (add PH badge, social proof)
- [ ] Load test: simulate 500 concurrent users hitting the dashboard
- [ ] Ensure signup → first insight flow is under 60 seconds

**Marketing:**
- [ ] Build Product Hunt launch list: DM 200+ people (Twitter followers, LinkedIn connections, early users, indie hacker community contacts)
- [ ] Prepare PH assets:
  - Tagline (under 60 chars): "Your business data, explained in plain English"
  - Description (3-4 sentences)
  - 5 screenshots (dashboard, AI summary, email digest, mobile view, QB connection)
  - Demo video (from Week 9)
  - Maker comment (your story, why you built this)
- [ ] Line up 3-5 hunters with 1k+ followers to follow your product

### Week 11 (Jun 29-Jul 5), Pre-Launch Buzz

**Product:**
- [ ] Feature freeze, bug fixes only
- [ ] Final smoke test of entire user journey
- [ ] Prepare infrastructure for traffic spike (auto-scaling on Railway/Fly)

**Marketing:**
- [ ] Twitter countdown: "Launching on Product Hunt next Tuesday"
- [ ] LinkedIn post: personal story about building the product
- [ ] Email early users: "We're launching on Product Hunt, would you upvote and leave a review?"
- [ ] DM the 200-person launch list: "We launch Tuesday at midnight PT, here's the link"
- [ ] r/SaaS post: "Show r/SaaS, I built an AI analytics tool for small businesses. Launching on PH next week."
- [ ] Indie Hackers milestone post

---

## Phase 4: Launch & Post-Launch (Weeks 12-16)

### Week 12 (Jul 6-12), Product Hunt Launch

**Launch day (Tuesday or Wednesday):**
- [ ] Go live at 12:01 AM PT
- [ ] Post maker comment immediately, tell your story:
  - "I'm a solo dev who spent 5 months building this because I watched small business owners stare at charts they couldn't interpret..."
  - Mention: AI-powered, plain English, CSV + QuickBooks, free tier
  - Be genuine, not salesy
- [ ] Activate launch list, DM/email everyone
- [ ] Monitor and respond to every PH comment within 30 minutes
- [ ] Post on Twitter, LinkedIn, r/SaaS, Indie Hackers
- [ ] Track: signups, PH upvotes, ranking, conversion to Pro

**Rest of week:**
- [ ] Respond to all feedback from PH launch
- [ ] Fix any bugs surfaced by traffic spike
- [ ] Write a "launch retrospective" Twitter thread with real numbers

**Realistic PH outcome:** Top 5 of the day = 500-2,000 signups. Expect 2-5% to convert to Pro within 30 days = 10-100 paying customers.

### Week 13 (Jul 13-19), Post-Launch Momentum

**Product:**
- [ ] Ship fixes for top 3 user complaints from launch week
- [ ] Add conversational follow-up to AI summaries: "Ask a question about your data", user types "Why did revenue drop in March?" → AI answers from their data
- [ ] This is the feature nobody has, Fathom can't do it, Mode requires SQL

**Marketing:**
- [ ] "Week 1 post-launch" Twitter thread: signups, revenue, learnings, user quotes
- [ ] Write case study from best early user story
- [ ] Hacker News "Show HN" post (save this for post-PH, separate audience, separate spike)

### Week 14 (Jul 20-26), Xero Integration

**Product:**
- [ ] Ship Xero integration (reuse QB adapter pattern)
- [ ] This unlocks UK/AU/NZ market where Xero dominates

**Marketing:**
- [ ] Announce Xero integration, target Xero community, UK/AU small business groups
- [ ] Write: "Xero Reporting Alternatives 2026" SEO article
- [ ] Continue weekly Twitter updates with revenue numbers

### Week 15 (Jul 27-Aug 2), Referral & Growth Loop

**Product:**
- [ ] Build referral program: "Give a friend 1 month Pro free, get 1 month free"
- [ ] Add "Share your insights" viral loop (already built, shareable links with AI snapshot)
- [ ] Shared insight page should have strong CTA: "Want AI insights on YOUR data? Try free →"

**Marketing:**
- [ ] Email all Pro subscribers about the referral program
- [ ] Twitter thread: "How I grew from 0 to [X] users in 4 weeks"
- [ ] Reach out to 5 more accountants with results from Week 7 outreach

### Week 16 (Aug 3-9), Review & Iterate

**Assess:**
- [ ] Current MRR vs $290 target
- [ ] Top 3 reasons people upgrade (double down on these)
- [ ] Top 3 reasons people don't upgrade (fix or accept)
- [ ] Churn analysis, who left and why?
- [ ] Best acquisition channel (PH? SEO? Twitter? Accountant referral?)

**Decide next phase:**
- [ ] If MRR > $500: hire a part-time content writer, increase SEO output
- [ ] If MRR < $200: talk to churned users, consider pivot to accountant-facing (like Fathom)
- [ ] If SEO is working: triple content output, target 20 articles by month 6
- [ ] If accountant channel is working: build a "partner dashboard" for bookkeepers

---

## Ongoing Weekly Habits (Start Week 1, Never Stop)

| Day | Activity | Time |
|-----|----------|------|
| Monday | Write 1 Twitter/X post (build in public update) | 20 min |
| Tuesday | Engage in 2-3 Reddit/LinkedIn threads (genuine help, no self-promo) | 30 min |
| Wednesday | Write or edit 1 section of an SEO article | 45 min |
| Thursday | Write 1 LinkedIn post (targeting SMB owners) | 20 min |
| Friday | Ship product work (bug fixes, features, polish) | 3-4 hrs |
| Weekend | Review analytics, plan next week | 30 min |

---

## Key Metrics to Track

| Metric | Week 4 Target | Week 8 Target | Week 12 Target | Week 16 Target |
|--------|---------------|---------------|----------------|----------------|
| Signups (free) | 20 | 50 | 200+ (PH spike) | 300 |
| Pro subscribers | 0 | 2-3 | 10-20 | 25-50 |
| MRR | $0 | $58-87 | $290-580 | $725-1,450 |
| Twitter followers | 100 | 300 | 500+ | 800 |
| SEO articles published | 0 | 3 | 7 | 10 |
| Accountant partners | 0 | 3-5 | 5-8 | 8-12 |

---

## Budget (Estimated Monthly Costs)

| Item | Cost/mo | Notes |
|------|---------|-------|
| Vercel (Pro) | $20 | Frontend hosting |
| Railway/Fly.io | $5-20 | API hosting (scales with traffic) |
| Neon PostgreSQL | $0-19 | Free tier covers early users |
| Upstash Redis | $0-10 | Pay-per-request |
| Claude API | $20-100 | Scales with AI summary usage |
| Stripe fees | 2.9% + 30c | Per transaction |
| Domain | $12/yr |, |
| Plausible Analytics | $9 | Privacy-respecting analytics |
| Email (Resend/Postmark) | $0-20 | Transactional email for digests |
| **Total** | **$66-210** | Covered by ~3-8 Pro subscribers |

Break-even at ~3-8 Pro subscribers ($29/mo). Everything after that is margin.

---

## Risk Mitigation

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Nobody signs up | Medium | Validate with 5 real users before PH launch. If CSV upload → insight flow doesn't get "wow" reactions, the product needs work, not marketing. |
| Claude API costs spike | Medium | Cache aggressively (already built, ai_summaries table). Rate limit free tier. Monitor cost per user. |
| Fathom adds real AI interpretation | Low (12mo) | Their cautious approach (Commentary Writer is accountant-reviewed) means they won't ship owner-facing AI quickly. Move fast. |
| Product Hunt flops | Medium | PH is one channel, not the only channel. SEO + accountant channel are slow-burn alternatives. Don't bet everything on one launch day. |
| Solo founder burnout | High | 20 hrs/week cap. Ship weekly, not daily. The plan is 16 weeks, not 16 sprints. |
