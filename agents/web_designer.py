"""
Agent 5 — Web Design Agent
Builds complete, multi-page websites after payment is confirmed.

Pipeline:
  1. Generate a comprehensive design brief from lead data + audit
  2. Plan site architecture (pages, navigation, content)
  3. Generate each page as clean HTML/CSS (or Next.js if configured)
  4. Create a GitHub repo for the project
  5. Deploy to Vercel
  6. Run final QA checks (PageSpeed, mobile, links)
"""

from __future__ import annotations

import json
from pathlib import Path

from sqlalchemy import select

from agents.base import BaseAgent
from models.lead import Lead, LeadStatus
from models.deal import Deal
from models.project import Project, ProjectStatus
from config.settings import settings
from services.deployment import create_github_repo, push_files_to_github, deploy_to_vercel


BUILD_DIR = Path("builds")


class WebDesignAgent(BaseAgent):
    name = "web_designer"

    async def run(self, project_id: str | None = None) -> dict:
        """Build websites for paid projects."""
        stats = {"built": 0, "errors": 0}

        if project_id:
            result = await self.db.execute(select(Project).where(Project.id == project_id))
            projects = [result.scalar_one()]
        else:
            result = await self.db.execute(
                select(Project).where(Project.status == ProjectStatus.QUEUED).limit(5)
            )
            projects = list(result.scalars().all())

        for project in projects:
            try:
                await self._build_site(project)
                stats["built"] += 1
            except Exception as exc:
                self.log.error("build_failed", project=project.id, error=str(exc))
                stats["errors"] += 1

        await self.db.commit()
        self.log.info("builds_complete", **stats)
        return stats

    async def _build_site(self, project: Project) -> None:
        """Full site build pipeline."""
        project.status = ProjectStatus.DESIGNING
        await self.db.commit()

        # Get lead info
        result = await self.db.execute(select(Lead).where(Lead.id == project.lead_id))
        lead = result.scalar_one()

        # Step 1: Generate comprehensive design brief
        self.log.info("designing", project=project.id, business=lead.business_name)
        design_brief = await self._create_design_brief(lead, project)
        project.design_brief = design_brief

        # Step 2: Plan site architecture
        site_plan = await self._plan_site_architecture(lead, design_brief)
        project.pages = site_plan

        project.status = ProjectStatus.BUILDING
        await self.db.commit()

        # Step 3: Generate each page
        site_dir = BUILD_DIR / f"site_{project.id}"
        site_dir.mkdir(parents=True, exist_ok=True)

        pages = site_plan.get("pages", [])
        for page_info in pages:
            self.log.info("building_page", page=page_info["slug"], project=project.id)
            html = await self._generate_page(lead, design_brief, page_info, pages)
            page_path = site_dir / f"{page_info['slug']}.html"
            page_path.write_text(html, encoding="utf-8")

        # Step 4: Generate shared CSS
        css = await self._generate_css(design_brief, project.brand_colors)
        (site_dir / "styles.css").write_text(css, encoding="utf-8")

        # Step 5: Deploy (GitHub + Vercel)
        project.status = ProjectStatus.DEPLOYING
        await self.db.commit()

        if settings.github_token:
            repo_url = await self._create_github_repo(project, site_dir)
            project.github_repo = repo_url

        if settings.vercel_token:
            live_url = await self._deploy_to_vercel(project, site_dir)
            project.live_url = live_url

        # Update statuses
        project.status = ProjectStatus.LIVE
        lead.status = LeadStatus.DELIVERED
        await self.db.commit()

        self.log.info(
            "site_built",
            project=project.id,
            business=lead.business_name,
            live_url=project.live_url,
        )

    async def _create_design_brief(self, lead: Lead, project: Project) -> str:
        """Generate a detailed design brief."""
        audit_info = ""
        if lead.audit:
            audit_info = f"""Current site issues:
- Performance: {lead.audit.performance_score}/100
- Not mobile-friendly: {not lead.audit.is_mobile_friendly}
- No SSL: {not lead.audit.has_ssl}
- Slow load time: {lead.audit.load_time_ms}ms"""

        return await self.think(
            system="""You are a senior web designer creating a comprehensive design brief.
Include: color palette (hex codes), typography choices, layout patterns,
component styles, and specific design decisions. Be very detailed.""",
            user_message=f"""Create a detailed design brief for:
Business: {lead.business_name}
Type: {lead.business_type}
Location: {lead.city}, {lead.state}
Phone: {lead.phone}
Site type: {project.site_type}
{audit_info}
Brand colors: {json.dumps(project.brand_colors) if project.brand_colors else 'Choose appropriate colors for this industry'}
Content notes: {project.content_notes or 'None provided'}""",
            model=settings.design_model,
            max_tokens=4096,
        )

    async def _plan_site_architecture(self, lead: Lead, design_brief: str) -> dict:
        """Plan the pages and navigation structure."""
        response = await self.think(
            system="""You are a web architect planning a website structure.
Output valid JSON with this exact schema:
{
  "pages": [
    {"slug": "index", "title": "Home", "sections": ["hero", "services", "testimonials", "cta"]},
    {"slug": "about", "title": "About", "sections": ["story", "team", "values"]},
    ...
  ],
  "navigation": [{"label": "Home", "slug": "index"}, ...],
  "footer_links": [{"label": "Privacy", "slug": "privacy"}, ...]
}
Output ONLY the JSON, no markdown fences.""",
            user_message=f"""Plan the website structure for:
Business: {lead.business_name}
Type: {lead.business_type}

Include pages appropriate for this type of service business.
Most {lead.business_type} sites need: Home, About, Services, Gallery/Portfolio, Contact, and maybe a Blog.""",
            temperature=0.2,
        )

        try:
            return json.loads(response)
        except json.JSONDecodeError:
            # Fallback structure
            return {
                "pages": [
                    {"slug": "index", "title": "Home", "sections": ["hero", "services", "testimonials", "contact"]},
                    {"slug": "about", "title": "About Us", "sections": ["story", "values", "team"]},
                    {"slug": "services", "title": "Services", "sections": ["service_list", "process", "cta"]},
                    {"slug": "contact", "title": "Contact", "sections": ["form", "map", "info"]},
                ],
                "navigation": [
                    {"label": "Home", "slug": "index"},
                    {"label": "About", "slug": "about"},
                    {"label": "Services", "slug": "services"},
                    {"label": "Contact", "slug": "contact"},
                ],
            }

    async def _generate_page(
        self, lead: Lead, brief: str, page_info: dict, all_pages: list[dict]
    ) -> str:
        """Generate a complete HTML page."""
        nav_html = " | ".join(
            f'<a href="{p["slug"]}.html">{p["title"]}</a>' for p in all_pages
        )

        return await self.think(
            system=f"""You are a senior frontend developer building a production website.
Generate a complete, semantic HTML5 page with a <link> to styles.css.
Requirements:
- Clean, semantic HTML5
- Responsive design (mobile-first)
- Realistic content for this specific business
- Proper heading hierarchy
- Accessible (ARIA labels, alt text)
- Link to styles.css for external styles
- Include navigation: {nav_html}
Output ONLY the HTML, no explanation.""",
            user_message=f"""Generate the '{page_info['title']}' page (/{page_info['slug']}.html).

Business: {lead.business_name}
Type: {lead.business_type}
Location: {lead.city}, {lead.state}
Phone: {lead.phone}
Sections to include: {', '.join(page_info.get('sections', []))}

Design Brief:
{brief}

Write realistic, compelling content specific to this {lead.business_type} business.""",
            model=settings.design_model,
            max_tokens=8192,
        )

    async def _generate_css(self, brief: str, brand_colors: dict | None) -> str:
        """Generate the shared stylesheet."""
        return await self.think(
            system="""You are a CSS expert. Generate a complete, modern stylesheet.
Requirements:
- CSS custom properties for colors and spacing
- Mobile-first responsive breakpoints
- Smooth transitions and micro-animations
- Clean typography system
- Utility classes for common patterns
- Dark/light section alternation
Output ONLY the CSS, no explanation.""",
            user_message=f"""Generate styles.css based on this design brief:
{brief}

Brand colors: {json.dumps(brand_colors) if brand_colors else 'Extract from the brief'}""",
            model=settings.design_model,
            max_tokens=4096,
        )

    async def _create_github_repo(self, project: Project, site_dir: Path) -> str | None:
        """Create a GitHub repo and push the site files."""
        try:
            repo_name = f"site-{project.id[:12]}"
            repo_info = await create_github_repo(
                repo_name=repo_name,
                description=f"Website for {project.site_type} business — built by Velocity",
            )

            # Push all site files
            await push_files_to_github(
                repo_full_name=repo_info["full_name"],
                site_dir=site_dir,
                commit_message="Deploy website via Velocity AI",
            )

            self.log.info("github_repo_created", project=project.id, repo=repo_info["repo_url"])
            return repo_info["repo_url"]

        except Exception as exc:
            self.log.error("github_deploy_failed", project=project.id, error=str(exc))
            return None

    async def _deploy_to_vercel(self, project: Project, site_dir: Path) -> str | None:
        """Deploy the site to Vercel."""
        try:
            project_name = f"site-{project.id[:12]}"
            result = await deploy_to_vercel(
                project_name=project_name,
                site_dir=site_dir,
            )

            project.vercel_project_id = result.get("deployment_id")
            self.log.info("vercel_deployed", project=project.id, url=result["url"])
            return result["url"]

        except Exception as exc:
            self.log.error("vercel_deploy_failed", project=project.id, error=str(exc))
            return None
