"""
FastAPI web server — the HTTP layer that ties the pipeline together.

Provides:
  - Webhook endpoints (Stripe, SendGrid, WhatsApp, Telegram)
  - Preview/demo hosting (serve blurred and full mockups)
  - Public API (request a redesign from the website form)
  - Admin dashboard API (pipeline stats, lead management)
  - Static file serving for the agency website
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI, Request, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, EmailStr
from sqlalchemy import select, func

from config.settings import settings
from models.database import init_db, async_session
from models.lead import Lead, LeadStatus, WebsiteAudit
from models.deal import Deal, DealStage
from models.project import Project, ProjectStatus
from models.message import Message
from pipeline.webhooks import (
    handle_stripe_webhook,
    handle_inbound_email,
    handle_whatsapp_message,
    handle_telegram_message,
)

WEBSITE_DIR = Path(__file__).parent.parent / "website"
PREVIEW_DIR = Path("previews")
BUILDS_DIR = Path("builds")

app = FastAPI(
    title="Velocity — AI Web Agency",
    description="Backend API for the autonomous AI web design agency",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ═══════════════════════════════════════════════════════════
# Startup
# ═══════════════════════════════════════════════════════════

@app.on_event("startup")
async def startup():
    await init_db()


# ═══════════════════════════════════════════════════════════
# Public API — Website Form
# ═══════════════════════════════════════════════════════════

class RedesignRequest(BaseModel):
    website_url: str
    email: str


@app.post("/api/request-redesign")
async def request_redesign(req: RedesignRequest):
    """Handle redesign requests from the agency website CTA form."""
    async with async_session() as session:
        # Check if we already have this lead
        existing = await session.execute(
            select(Lead).where(Lead.email == req.email)
        )
        if existing.scalar_one_or_none():
            return {"status": "already_exists", "message": "We already have you on file!"}

        lead = Lead(
            business_name="Website Request",
            business_type="unknown",
            website_url=req.website_url,
            email=req.email,
            status=LeadStatus.DISCOVERED,
            notes="Inbound request from agency website",
        )
        session.add(lead)
        await session.commit()

    return {"status": "success", "message": "We'll send your free redesign within 24-48 hours."}


# ═══════════════════════════════════════════════════════════
# Preview & Demo Hosting
# ═══════════════════════════════════════════════════════════

@app.get("/preview/{lead_id}")
async def serve_preview(lead_id: str):
    """Serve the blurred preview image for a lead."""
    blurred_path = PREVIEW_DIR / "blurred" / f"blurred_{lead_id}.png"
    if blurred_path.exists():
        return FileResponse(str(blurred_path), media_type="image/png")

    raise HTTPException(status_code=404, detail="Preview not found")


@app.get("/demo/{lead_id}")
async def serve_demo(lead_id: str):
    """Serve the full (unblurred) demo HTML mockup."""
    mockup_path = PREVIEW_DIR / "full" / f"mockup_{lead_id}.html"
    if mockup_path.exists():
        return HTMLResponse(mockup_path.read_text(encoding="utf-8"))

    raise HTTPException(status_code=404, detail="Demo not found")


@app.get("/demo/{lead_id}/image")
async def serve_demo_image(lead_id: str):
    """Serve the full demo screenshot."""
    full_path = PREVIEW_DIR / "full" / f"full_{lead_id}.png"
    if full_path.exists():
        return FileResponse(str(full_path), media_type="image/png")

    raise HTTPException(status_code=404, detail="Demo image not found")


# ═══════════════════════════════════════════════════════════
# Client Site Hosting (built sites)
# ═══════════════════════════════════════════════════════════

@app.get("/sites/{project_id}/{page}")
async def serve_built_site(project_id: str, page: str = "index.html"):
    """Serve pages from built client websites."""
    site_dir = BUILDS_DIR / f"site_{project_id}"
    page_path = site_dir / page

    if page_path.exists() and site_dir in page_path.resolve().parents:
        if page.endswith(".css"):
            return FileResponse(str(page_path), media_type="text/css")
        return HTMLResponse(page_path.read_text(encoding="utf-8"))

    raise HTTPException(status_code=404, detail="Page not found")


# ═══════════════════════════════════════════════════════════
# Webhooks
# ═══════════════════════════════════════════════════════════

@app.post("/webhooks/stripe")
async def stripe_webhook(request: Request):
    """Stripe payment webhook."""
    payload = await request.body()
    sig_header = request.headers.get("stripe-signature", "")

    try:
        result = await handle_stripe_webhook(payload, sig_header)
        return result
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/webhooks/email/inbound")
async def email_inbound(request: Request):
    """SendGrid Inbound Parse webhook — receives email replies."""
    form = await request.form()

    sender_email = form.get("from", "")
    subject = form.get("subject", "")
    body = form.get("text", "") or form.get("html", "")

    # Extract email address from "Name <email>" format
    if "<" in sender_email and ">" in sender_email:
        sender_email = sender_email.split("<")[1].split(">")[0]

    result = await handle_inbound_email(sender_email, subject, body)
    return result


@app.post("/webhooks/whatsapp")
async def whatsapp_webhook(request: Request):
    """WhatsApp Business webhook."""
    data = await request.json()

    # WhatsApp webhook verification
    if request.method == "GET":
        mode = request.query_params.get("hub.mode")
        token = request.query_params.get("hub.verify_token")
        challenge = request.query_params.get("hub.challenge")

        if mode == "subscribe" and token == settings.whatsapp_verify_token:
            return int(challenge)
        raise HTTPException(status_code=403)

    # Process incoming messages
    for entry in data.get("entry", []):
        for change in entry.get("changes", []):
            messages = change.get("value", {}).get("messages", [])
            for msg in messages:
                phone = msg.get("from", "")
                text = msg.get("text", {}).get("body", "")
                if phone and text:
                    await handle_whatsapp_message(phone, text)

    return {"status": "ok"}


@app.get("/webhooks/whatsapp")
async def whatsapp_verify(
    mode: str = Query(None, alias="hub.mode"),
    token: str = Query(None, alias="hub.verify_token"),
    challenge: str = Query(None, alias="hub.challenge"),
):
    """WhatsApp webhook verification (GET request)."""
    if mode == "subscribe" and token == settings.whatsapp_verify_token:
        return int(challenge)
    raise HTTPException(status_code=403)


@app.post("/webhooks/telegram")
async def telegram_webhook(request: Request):
    """Telegram Bot webhook."""
    data = await request.json()

    message = data.get("message", {})
    chat_id = str(message.get("chat", {}).get("id", ""))
    text = message.get("text", "")

    if chat_id and text:
        result = await handle_telegram_message(chat_id, text)
        return result

    return {"status": "no_message"}


# ═══════════════════════════════════════════════════════════
# Admin Dashboard API
# ═══════════════════════════════════════════════════════════

@app.get("/api/admin/stats")
async def admin_stats():
    """Pipeline statistics for the admin dashboard."""
    async with async_session() as session:
        stats = {}

        # Lead counts by status
        for status in LeadStatus:
            result = await session.execute(
                select(func.count()).select_from(Lead).where(Lead.status == status)
            )
            count = result.scalar()
            if count > 0:
                stats[status.value] = count

        # Total leads
        total = await session.execute(
            select(func.count()).select_from(Lead)
        )
        stats["total_leads"] = total.scalar()

        # Active projects
        active = await session.execute(
            select(func.count()).select_from(Project).where(
                Project.status.in_([
                    ProjectStatus.QUEUED, ProjectStatus.DESIGNING,
                    ProjectStatus.BUILDING, ProjectStatus.REVIEW,
                ])
            )
        )
        stats["active_projects"] = active.scalar()

        # Delivered
        delivered = await session.execute(
            select(func.count()).select_from(Project).where(
                Project.status == ProjectStatus.LIVE
            )
        )
        stats["delivered"] = delivered.scalar()

        # Revenue (sum of paid deals)
        revenue = await session.execute(
            select(func.sum(Deal.price_cents)).where(
                Deal.stage == DealStage.PAID
            )
        )
        stats["revenue_cents"] = revenue.scalar() or 0

        return stats


@app.get("/api/admin/leads")
async def admin_leads(
    status: str | None = None,
    limit: int = 50,
    offset: int = 0,
):
    """List leads with optional status filter."""
    async with async_session() as session:
        query = select(Lead).order_by(Lead.created_at.desc()).limit(limit).offset(offset)

        if status:
            query = query.where(Lead.status == LeadStatus(status))

        result = await session.execute(query)
        leads = result.scalars().all()

        return [
            {
                "id": lead.id,
                "business_name": lead.business_name,
                "business_type": lead.business_type,
                "website_url": lead.website_url,
                "email": lead.email,
                "phone": lead.phone,
                "city": lead.city,
                "state": lead.state,
                "status": lead.status.value,
                "score": lead.score,
                "outreach_count": lead.outreach_count,
                "created_at": str(lead.created_at),
            }
            for lead in leads
        ]


@app.get("/api/admin/leads/{lead_id}")
async def admin_lead_detail(lead_id: str):
    """Get detailed lead info including audit and messages."""
    async with async_session() as session:
        result = await session.execute(select(Lead).where(Lead.id == lead_id))
        lead = result.scalar_one_or_none()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")

        # Get audit
        audit_data = None
        if lead.audit:
            audit_data = {
                "performance_score": lead.audit.performance_score,
                "accessibility_score": lead.audit.accessibility_score,
                "seo_score": lead.audit.seo_score,
                "best_practices_score": lead.audit.best_practices_score,
                "is_mobile_friendly": lead.audit.is_mobile_friendly,
                "has_ssl": lead.audit.has_ssl,
                "load_time_ms": lead.audit.load_time_ms,
                "badness_score": lead.audit.badness_score,
            }

        # Get messages
        msg_result = await session.execute(
            select(Message).where(Message.lead_id == lead_id).order_by(Message.created_at.desc())
        )
        messages = [
            {
                "id": msg.id,
                "channel": msg.channel.value,
                "direction": msg.direction,
                "subject": msg.subject,
                "body": msg.body[:200],
                "created_at": str(msg.created_at),
            }
            for msg in msg_result.scalars().all()
        ]

        # Get deal
        deal_result = await session.execute(
            select(Deal).where(Deal.lead_id == lead_id).order_by(Deal.created_at.desc())
        )
        deal = deal_result.scalar_one_or_none()
        deal_data = None
        if deal:
            deal_data = {
                "stage": deal.stage.value,
                "package_name": deal.package_name,
                "price_cents": deal.price_cents,
                "preview_url": deal.preview_url,
                "demo_url": deal.demo_url,
            }

        return {
            "id": lead.id,
            "business_name": lead.business_name,
            "business_type": lead.business_type,
            "website_url": lead.website_url,
            "email": lead.email,
            "phone": lead.phone,
            "city": lead.city,
            "state": lead.state,
            "status": lead.status.value,
            "score": lead.score,
            "outreach_count": lead.outreach_count,
            "created_at": str(lead.created_at),
            "audit": audit_data,
            "deal": deal_data,
            "messages": messages,
        }


@app.get("/api/admin/projects")
async def admin_projects():
    """List all projects."""
    async with async_session() as session:
        result = await session.execute(
            select(Project).order_by(Project.created_at.desc())
        )
        projects = result.scalars().all()

        return [
            {
                "id": project.id,
                "lead_id": project.lead_id,
                "status": project.status.value,
                "site_type": project.site_type,
                "github_repo": project.github_repo,
                "live_url": project.live_url,
                "revision_count": project.revision_count,
                "created_at": str(project.created_at),
            }
            for project in projects
        ]


# ═══════════════════════════════════════════════════════════
# Health Check
# ═══════════════════════════════════════════════════════════

@app.get("/api/health")
async def health_check():
    return {"status": "healthy", "service": "velocity-agency"}


# ═══════════════════════════════════════════════════════════
# Static Files — Agency Website
# ═══════════════════════════════════════════════════════════

if WEBSITE_DIR.exists():
    assets_dir = WEBSITE_DIR / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

    @app.get("/")
    async def serve_website():
        return FileResponse(str(WEBSITE_DIR / "index.html"))

    # Serve CSS, JS, and other static files from website dir
    @app.get("/{filename}")
    async def serve_static(filename: str):
        filepath = WEBSITE_DIR / filename
        if filepath.exists() and filepath.is_file():
            media_types = {
                ".css": "text/css",
                ".js": "application/javascript",
                ".svg": "image/svg+xml",
                ".png": "image/png",
                ".jpg": "image/jpeg",
                ".ico": "image/x-icon",
            }
            ext = filepath.suffix
            return FileResponse(str(filepath), media_type=media_types.get(ext))
        raise HTTPException(status_code=404)
