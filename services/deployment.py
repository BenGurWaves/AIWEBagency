"""GitHub + Vercel deployment — creates repos and deploys built sites."""

from __future__ import annotations

import base64
from pathlib import Path

import httpx
import structlog

from config.settings import settings

log = structlog.get_logger()

GITHUB_API = "https://api.github.com"
VERCEL_API = "https://api.vercel.com"


# ══════════════════════════════════════════════════════════
# GitHub
# ══════════════════════════════════════════════════════════

async def create_github_repo(repo_name: str, description: str = "") -> dict:
    """
    Create a GitHub repo under the configured org (or user account).
    Returns {"repo_url": ..., "clone_url": ..., "full_name": ...}
    """
    headers = {
        "Authorization": f"Bearer {settings.github_token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }

    payload = {
        "name": repo_name,
        "description": description,
        "private": False,
        "auto_init": False,
    }

    async with httpx.AsyncClient(timeout=30) as client:
        if settings.github_org:
            url = f"{GITHUB_API}/orgs/{settings.github_org}/repos"
        else:
            url = f"{GITHUB_API}/user/repos"

        resp = await client.post(url, json=payload, headers=headers)

        if resp.status_code == 422:
            # Repo already exists — fetch it
            owner = settings.github_org or (await _get_github_user(client, headers))
            resp = await client.get(
                f"{GITHUB_API}/repos/{owner}/{repo_name}", headers=headers
            )

        resp.raise_for_status()
        data = resp.json()

    log.info("deployment.github_repo_created", repo=data["full_name"])
    return {
        "repo_url": data["html_url"],
        "clone_url": data["clone_url"],
        "full_name": data["full_name"],
    }


async def push_files_to_github(
    repo_full_name: str,
    site_dir: Path,
    commit_message: str = "Initial site deployment",
) -> str:
    """
    Push all files from a directory to a GitHub repo using the Contents API.
    Returns the commit URL.
    """
    headers = {
        "Authorization": f"Bearer {settings.github_token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }

    async with httpx.AsyncClient(timeout=30) as client:
        for file_path in site_dir.rglob("*"):
            if file_path.is_dir():
                continue

            relative = file_path.relative_to(site_dir)
            content = file_path.read_bytes()
            encoded = base64.b64encode(content).decode("utf-8")

            url = f"{GITHUB_API}/repos/{repo_full_name}/contents/{relative}"

            # Check if file already exists (need its SHA to update)
            sha = None
            existing = await client.get(url, headers=headers)
            if existing.status_code == 200:
                sha = existing.json().get("sha")

            payload = {
                "message": commit_message,
                "content": encoded,
            }
            if sha:
                payload["sha"] = sha

            resp = await client.put(url, json=payload, headers=headers)
            if resp.status_code not in (200, 201):
                log.error(
                    "deployment.github_push_failed",
                    file=str(relative),
                    status=resp.status_code,
                    body=resp.text[:200],
                )

    log.info("deployment.github_pushed", repo=repo_full_name, files=len(list(site_dir.rglob("*"))))
    return f"https://github.com/{repo_full_name}"


async def _get_github_user(client: httpx.AsyncClient, headers: dict) -> str:
    """Get authenticated GitHub username."""
    resp = await client.get(f"{GITHUB_API}/user", headers=headers)
    resp.raise_for_status()
    return resp.json()["login"]


# ══════════════════════════════════════════════════════════
# Vercel
# ══════════════════════════════════════════════════════════

async def create_vercel_project(
    project_name: str,
    github_repo: str,
) -> dict:
    """
    Create a Vercel project linked to a GitHub repo.
    Returns {"project_id": ..., "url": ...}
    """
    headers = {
        "Authorization": f"Bearer {settings.vercel_token}",
        "Content-Type": "application/json",
    }

    payload = {
        "name": project_name,
        "framework": None,  # Static HTML, no framework
        "gitRepository": {
            "type": "github",
            "repo": github_repo,  # "owner/repo"
        },
    }

    if settings.vercel_team_id:
        payload["teamId"] = settings.vercel_team_id

    params = {}
    if settings.vercel_team_id:
        params["teamId"] = settings.vercel_team_id

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{VERCEL_API}/v10/projects",
            json=payload,
            headers=headers,
            params=params,
        )

        if resp.status_code == 409:
            # Project already exists
            resp = await client.get(
                f"{VERCEL_API}/v9/projects/{project_name}",
                headers=headers,
                params=params,
            )

        resp.raise_for_status()
        data = resp.json()

    project_id = data.get("id", "")
    url = f"https://{project_name}.vercel.app"

    log.info("deployment.vercel_project_created", name=project_name, url=url)
    return {"project_id": project_id, "url": url}


async def deploy_to_vercel(
    project_name: str,
    site_dir: Path,
) -> dict:
    """
    Deploy files directly to Vercel using the Deployments API.
    Returns {"url": ..., "deployment_id": ...}
    """
    headers = {
        "Authorization": f"Bearer {settings.vercel_token}",
        "Content-Type": "application/json",
    }

    params = {}
    if settings.vercel_team_id:
        params["teamId"] = settings.vercel_team_id

    # Build file list
    files = []
    for file_path in site_dir.rglob("*"):
        if file_path.is_dir():
            continue

        relative = str(file_path.relative_to(site_dir))
        content = file_path.read_text(encoding="utf-8", errors="replace")

        files.append({
            "file": relative,
            "data": content,
        })

    payload = {
        "name": project_name,
        "files": files,
        "projectSettings": {
            "framework": None,
        },
    }

    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(
            f"{VERCEL_API}/v13/deployments",
            json=payload,
            headers=headers,
            params=params,
        )
        resp.raise_for_status()
        data = resp.json()

    url = f"https://{data.get('url', project_name + '.vercel.app')}"
    deployment_id = data.get("id", "")

    log.info("deployment.vercel_deployed", url=url, deployment_id=deployment_id)
    return {"url": url, "deployment_id": deployment_id}
