# Gap Analysis — What's Built vs. What's Needed for Production

## What's Built (This Repo)

- Full 6-agent pipeline with shared database state
- Lead research with Google Places + PageSpeed auditing + email scraping
- Cold email outreach with 3-step cadence + LLM-personalized issues
- Blurred preview generation (screenshot → mockup → blur)
- Sales pipeline with reply classification + Stripe invoicing
- Web design agent that generates multi-page HTML/CSS sites
- Client success agent with WhatsApp/Telegram/email routing
- Pipeline orchestrator connecting all stages
- CLI interface for manual and continuous operation
- **FastAPI web server** with webhook endpoints, preview/demo hosting, admin API
- **Agency website** (Velocity) — modern dark-theme marketing site
- **GitHub + Vercel deployment** — real API integration for site publishing
- Webhook handlers for Stripe, email replies, WhatsApp, Telegram
- SQLite database with full data model
- CAN-SPAM compliant email templates
- Unit tests for models, scoring, and templates

## Resolved Gaps

### Web Application Layer — RESOLVED
- [x] FastAPI web server (`server/app.py`) with full routing
- [x] Preview hosting — `/preview/{lead_id}` serves blurred mockup images
- [x] Demo hosting — `/demo/{lead_id}` serves full HTML mockups
- [x] Stripe webhook endpoint
- [x] SendGrid Inbound Parse webhook for email replies
- [x] WhatsApp/Telegram webhook receivers
- [x] Admin API for pipeline monitoring
- [x] Agency website served at root `/`

### GitHub + Vercel Deployment — RESOLVED
- [x] GitHub API integration — creates repos and pushes site files
- [x] Vercel API integration — creates projects and deploys
- [x] Real deployment service (`services/deployment.py`)
- [x] Web Design Agent updated to use real deployment

## Remaining Gaps Before Production

### 1. Email Deliverability (CRITICAL)

**Problem:** Sending cold emails directly via SendGrid will get you flagged as spam quickly.

**What's needed:**
- [ ] Separate sending domain (never use your primary domain for cold outreach)
- [ ] SPF, DKIM, DMARC DNS records configured on the sending domain
- [ ] Email warmup integration (Instantly, Mailreach, or similar) — 2-4 weeks before sending
- [ ] Email verification service (Hunter, NeverBounce) to validate addresses before sending
- [ ] Sender rotation across 2-3 mailboxes per domain
- [ ] Consider using a dedicated cold email platform (Instantly, Smartlead) instead of SendGrid

### 2. Email Reply Detection (HIGH)

**Problem:** Webhook endpoint exists but needs external service configuration.

**What's needed:**
- [ ] Configure SendGrid Inbound Parse to point to `/webhooks/email/inbound`
- [ ] OR implement IMAP polling as a fallback for reply detection
- [ ] Reply-to address configuration (dedicated inbox per sending identity)

### 3. Content Quality & QA (MEDIUM)

**Problem:** LLM-generated websites need quality checks before delivery.

**What's needed:**
- [ ] Automated QA: run PageSpeed on the generated site
- [ ] Link checker on generated HTML
- [ ] Mobile viewport testing via Playwright
- [ ] Human review step before delivery (or staging URL for client review)
- [ ] Content review for hallucinated info (wrong phone numbers, addresses)

### 4. Scaling & Reliability (MEDIUM)

**Problem:** SQLite doesn't scale, and there's limited retry/failure handling.

**What's needed:**
- [ ] PostgreSQL for production (SQLite is fine for dev/testing)
- [ ] Redis or similar for job queuing
- [ ] Retry logic with exponential backoff for all API calls
- [ ] Rate limiting awareness for Google APIs, SendGrid, etc.
- [ ] Error alerting (Slack/email notifications on pipeline failures)

### 5. Lead Quality Enrichment (LOW-MEDIUM)

**What's needed:**
- [ ] Email enrichment service (Hunter.io, Apollo) when scraping doesn't find email
- [ ] Contact name enrichment (find the business owner's name)
- [ ] Business verification (avoid contacting businesses that don't exist)

### 6. Legal & Compliance (LOW-MEDIUM)

**What's needed:**
- [ ] Global suppression list management
- [ ] Configurable physical address (currently hardcoded)
- [ ] robots.txt checking before scraping websites
- [ ] Terms of service for client data processing

### 7. Revenue Operations (LOW)

**What's needed:**
- [ ] Hosting/maintenance subscription billing (monthly recurring after initial build)
- [ ] Admin dashboard UI (currently API-only)
- [ ] Revenue dashboards and metrics

## Recommended Priority Order

1. **Email deliverability setup** — Without proper warmup, nothing works. Get domains, warm up, verify.
2. **SendGrid Inbound Parse config** — Point it at your webhook URL so replies get detected.
3. **Content QA pipeline** — Run PageSpeed + mobile tests on generated sites before delivery.
4. **PostgreSQL + job queue** — Needed once volume exceeds a few dozen leads/day.
5. **Admin dashboard UI** — Build a frontend for the admin API endpoints.
6. **Everything else** — Iterate based on what bottlenecks appear first.
