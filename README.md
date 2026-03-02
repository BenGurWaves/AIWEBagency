# Velocity — AI Web Design Agency

Fully autonomous AI-powered website design agency — from lead generation to site delivery.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                         PIPELINE ORCHESTRATOR                                │
│                     (runs on schedule or manual)                             │
├─────────┬──────────┬──────────┬─────────┬──────────┬───────────────────────┤
│ Agent 1  │ Agent 2   │ Agent 3  │ Agent 4 │ Agent 5  │ Agent 6               │
│ Lead     │ Outreach  │ Design   │ Sales   │ Web      │ Client                │
│ Research │ (Email)   │ Preview  │ Pipeline│ Designer │ Success               │
├─────────┼──────────┼──────────┼─────────┼──────────┼───────────────────────┤
│ Google   │ SendGrid  │ Claude   │ Stripe  │ Claude   │ WhatsApp/Telegram     │
│ Places   │ SMTP      │Playwright│ LLM     │ GitHub   │ Email                 │
│ PageSpeed│ Claude    │ Pillow   │         │ Vercel   │                       │
│ Scraper  │           │          │         │          │                       │
└─────────┴──────────┴──────────┴─────────┴──────────┴───────────────────────┘
                              │
                    ┌─────────┴──────────┐
                    │  FastAPI Web Server │
                    │  (webhooks + API)   │
                    ├────────────────────┤
                    │   SQLite / DB      │
                    │   (shared state)   │
                    └────────────────────┘
```

## The Pipeline

### Stage 1: Lead Research Agent
Finds service businesses with terrible websites in US markets.

- Searches Google Places by category (plumbers, roofers, HVAC, etc.) and city
- Gets business details: website, phone, address
- Runs PageSpeed Insights audit on each website
- Scores websites by "badness" (mobile-friendliness, speed, SSL, SEO)
- Scrapes contact emails from websites (main page + /contact pages)
- Saves qualified leads (badness > 55) to the database

### Stage 2: Design Preview Agent
Generates blurred mockup previews to use as the hook.

- Screenshots the current (bad) website via Playwright
- Uses Claude to generate a design brief based on audit data
- Generates a full HTML/CSS mockup with realistic content
- Renders the mockup to an image
- Applies gaussian blur for the teaser version
- Saves both blurred preview and full demo

### Stage 3: Outreach Agent
Sends personalized cold emails using a 3-step cadence.

- **Email 1 (Day 0):** "I already redesigned your site" + blurred preview + specific issues from audit
- **Email 2 (Day 3):** Follow-up nudge with the preview
- **Email 3 (Day 10):** Breakup email — "Should I close your file?"
- All emails are CAN-SPAM compliant (physical address, unsubscribe, honest subjects)
- Issue descriptions are LLM-generated from real audit data for personalization
- Max 50 emails/day with configurable limits

### Stage 4: Sales Agent
Handles replies and closes deals.

- Monitors incoming replies via webhook
- Classifies intent with LLM (positive, negative, question, unsubscribe)
- **Positive reply** → sends the full (unblurred) demo
- **Wants to buy** → creates and sends Stripe invoice
- **Payment received** → moves lead to build queue
- Handles the full deal lifecycle: proposal → demo → invoice → paid

### Stage 5: Web Design Agent
Builds complete, multi-page websites.

- Generates comprehensive design brief from lead data
- Plans site architecture (pages, navigation, content)
- Builds each page as clean HTML/CSS using Claude
- Creates shared stylesheet
- Pushes code to GitHub via API
- Deploys live to Vercel
- Handles: home, about, services, gallery, contact, blog pages

### Stage 6: Client Success Agent
Manages ongoing client communication.

- Sends project status updates at each build milestone
- Handles client questions and revision requests
- Routes messages through client's preferred channel (email/WhatsApp/Telegram)
- Generates human-sounding responses using LLM
- Sends welcome messages when projects kick off
- Tracks all communications in the message log

## Web Server

The FastAPI web server provides the HTTP layer that ties everything together:

- **Agency website** — Served at `/` (the Velocity marketing site)
- **Preview hosting** — `/preview/{lead_id}` serves blurred mockup images
- **Demo hosting** — `/demo/{lead_id}` serves full HTML mockups
- **Webhook endpoints** — Stripe, SendGrid, WhatsApp, Telegram
- **Admin API** — Pipeline stats, lead management, project tracking
- **Redesign request API** — Handles form submissions from the agency website

## Data Flow

```
DISCOVERED → AUDITED → QUALIFIED → CONTACTED → REPLIED → DEMO_SENT → INTERESTED → INVOICE_SENT → PAID → IN_BUILD → DELIVERED
                                                                                                              ↑
                                                                                                        (or LOST at any point)
```

## Quick Start

```bash
# 1. Clone and enter
git clone <repo-url> && cd AIWEBagency

# 2. Create virtual environment
python -m venv .venv && source .venv/bin/activate

# 3. Install dependencies
pip install -e ".[dev]"

# 4. Configure
cp .env.example .env
# Edit .env with your API keys

# 5. Install Playwright browsers
playwright install chromium

# 6. Start the web server (serves agency website + API + webhooks)
agency serve

# 7. Run the full pipeline
agency run

# Or run individual stages
agency stage research
agency stage preview
agency stage outreach
agency stage sales
agency stage design
agency stage client

# Run continuously (every 60 minutes)
agency run --continuous --interval 60

# Check pipeline status
agency status
```

## Project Structure

```
AIWEBagency/
├── website/                 # The agency's own website (Velocity)
│   ├── index.html           # Landing page
│   ├── styles.css           # Full stylesheet
│   └── main.js              # Interactions + animations
├── server/                  # FastAPI web server
│   └── app.py               # Routes, webhooks, API, static serving
├── agents/                  # The 6 autonomous agents
│   ├── base.py              # Shared agent scaffolding
│   ├── lead_researcher.py   # Agent 1: Find businesses with bad websites
│   ├── outreach.py          # Agent 2: Cold email cadence
│   ├── design_preview.py    # Agent 3: Blurred mockup generation
│   ├── sales.py             # Agent 4: Deal closing + invoicing
│   ├── web_designer.py      # Agent 5: Full site builds + GitHub/Vercel deploy
│   └── client_success.py    # Agent 6: Multi-channel client comms
├── config/
│   └── settings.py          # Centralized env-based configuration
├── models/                  # SQLAlchemy data models
│   ├── base.py              # DB mixins (UUID, timestamps)
│   ├── lead.py              # Lead + WebsiteAudit
│   ├── deal.py              # Deal / sales pipeline
│   ├── project.py           # Website build projects
│   ├── message.py           # Communication log
│   └── database.py          # Async engine + session
├── services/                # External API integrations
│   ├── google_maps.py       # Google Places search
│   ├── website_auditor.py   # PageSpeed + screenshots + scoring
│   ├── email_sender.py      # SendGrid / SMTP
│   ├── payments.py          # Stripe invoicing
│   ├── messaging.py         # WhatsApp + Telegram
│   └── deployment.py        # GitHub repo creation + Vercel deployment
├── templates/
│   └── emails.py            # Cold email templates (4 stages)
├── pipeline/
│   ├── orchestrator.py      # Connects all agents in sequence
│   ├── cli.py               # CLI interface (run, stage, serve, status)
│   └── webhooks.py          # Inbound webhook handlers
├── tests/
│   ├── test_models.py
│   ├── test_website_auditor.py
│   └── test_templates.py
├── .env.example             # Environment variable template
├── .gitignore
└── pyproject.toml           # Dependencies + project config
```

## Required API Keys

| Service | Purpose | Free Tier |
|---------|---------|-----------|
| **Anthropic** | Claude LLM for all agents | Pay-per-use |
| **Google Places** | Finding businesses | $200/mo credit |
| **Google PageSpeed** | Website auditing | 25K req/day |
| **SendGrid** | Email sending | 100 emails/day |
| **Stripe** | Payment processing | 2.9% + 30c/txn |
| **WhatsApp Business** | Client messaging | 1K free/mo |
| **Telegram Bot** | Client messaging | Free |
| **Vercel** | Site hosting/deployment | Free tier |
| **GitHub** | Code hosting | Free |

## Cold Email Compliance

All outreach follows CAN-SPAM requirements:
- Honest, non-deceptive subject lines
- Physical mailing address in every email
- Clear unsubscribe mechanism (reply STOP)
- Opt-outs honored within 10 business days
- Email identified as commercial/promotional
- Max 50 emails/day per sending identity
- 3-day minimum between touches to same lead

## Pricing Packages

| Package | Price | Includes |
|---------|-------|----------|
| **Starter** | $997 | 5-page site, SSL, basic SEO, 30 days support |
| **Professional** | $1,997 | Multi-page site, blog, advanced SEO, 60 days support |
| **Premium** | $3,497 | Full custom build, booking system, 90 days VIP support |
