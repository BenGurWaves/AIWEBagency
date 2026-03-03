"""
CLI interface for the AI Web Agency pipeline.

Usage:
  agency run              — Run one full pipeline cycle
  agency run --continuous — Run continuously (every 60 min)
  agency stage research   — Run only the lead research stage
  agency stage outreach   — Run only the outreach stage
  agency stage preview    — Run only the preview generation stage
  agency stage sales      — Run only the sales stage
  agency stage design     — Run only the web design stage
  agency stage client     — Run only the client success stage
  agency status           — Show pipeline statistics
  agency serve            — Start the web server (API + website + webhooks)
"""

from __future__ import annotations

import asyncio

import click
from rich.console import Console
from rich.table import Table

from pipeline.orchestrator import PipelineOrchestrator

console = Console()


@click.group()
def main():
    """AI Web Agency — Autonomous website design agency pipeline."""
    pass


@main.command()
@click.option("--continuous", is_flag=True, help="Run continuously on a schedule")
@click.option("--interval", default=60, help="Minutes between cycles (continuous mode)")
def run(continuous: bool, interval: int):
    """Run the full pipeline."""
    orchestrator = PipelineOrchestrator()

    if continuous:
        console.print(f"[bold green]Starting continuous pipeline (every {interval} min)...[/]")
        asyncio.run(orchestrator.run_continuous(interval))
    else:
        console.print("[bold green]Running full pipeline cycle...[/]")
        results = asyncio.run(orchestrator.run_full_cycle())
        _print_results(results)


@main.command()
@click.argument("stage_name")
@click.option("--categories", "-c", multiple=True, help="Business categories to search")
@click.option("--cities", multiple=True, help="Cities to search")
def stage(stage_name: str, categories: tuple, cities: tuple):
    """Run a single pipeline stage."""
    orchestrator = PipelineOrchestrator()

    # Map friendly names to internal names
    name_map = {
        "research": "research",
        "preview": "preview",
        "outreach": "outreach",
        "sales": "sales",
        "design": "design",
        "client": "client_success",
        "client_success": "client_success",
    }

    internal_name = name_map.get(stage_name)
    if not internal_name:
        console.print(f"[red]Unknown stage: {stage_name}[/]")
        console.print(f"Valid stages: {', '.join(name_map.keys())}")
        return

    kwargs = {}
    if categories:
        kwargs["categories"] = list(categories)
    if cities:
        kwargs["cities"] = list(cities)

    console.print(f"[bold cyan]Running stage: {stage_name}...[/]")
    result = asyncio.run(orchestrator.run_stage(internal_name, **kwargs))
    console.print(result)


@main.command()
@click.option("--host", default="0.0.0.0", help="Host to bind to")
@click.option("--port", default=8000, type=int, help="Port to listen on")
@click.option("--reload", is_flag=True, help="Enable auto-reload for development")
def serve(host: str, port: int, reload: bool):
    """Start the web server (API + website + webhooks)."""
    import uvicorn

    console.print(f"[bold green]Starting Velocity web server on {host}:{port}...[/]")
    console.print(f"[dim]  Website:    http://localhost:{port}[/]")
    console.print(f"[dim]  API docs:   http://localhost:{port}/docs[/]")
    console.print(f"[dim]  Webhooks:   http://localhost:{port}/webhooks/...[/]")
    console.print(f"[dim]  Admin API:  http://localhost:{port}/api/admin/...[/]")
    uvicorn.run("server.app:app", host=host, port=port, reload=reload)


@main.command()
def status():
    """Show current pipeline statistics."""
    asyncio.run(_show_status())


async def _show_status():
    """Query the database and display pipeline stats."""
    from models.database import init_db, async_session
    from models.lead import Lead, LeadStatus
    from models.project import Project
    from sqlalchemy import select, func

    await init_db()

    async with async_session() as session:
        table = Table(title="Pipeline Status")
        table.add_column("Stage", style="cyan")
        table.add_column("Count", justify="right", style="green")

        for status in LeadStatus:
            result = await session.execute(
                select(func.count()).select_from(Lead).where(Lead.status == status)
            )
            count = result.scalar()
            if count > 0:
                table.add_row(status.value, str(count))

        console.print(table)


def _print_results(results: dict):
    """Pretty-print pipeline results."""
    table = Table(title="Pipeline Cycle Results")
    table.add_column("Stage", style="cyan")
    table.add_column("Results", style="green")

    for stage_name, result in results.items():
        table.add_row(stage_name, str(result))

    console.print(table)


if __name__ == "__main__":
    main()
