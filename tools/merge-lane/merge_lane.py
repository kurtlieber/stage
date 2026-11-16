#!/usr/bin/env python3
# Purpose: Decide whether a pull request merges itself or waits for Kurt and, when it merges itself, turn on auto-merge.
"""The merge lane (ADR 0080 section 6; it replaced the Docs lane of ADR 0064).

Runs in .github/workflows/merge-lane.yml with the workflow's GITHUB_TOKEN, from
the base branch. It reads the pull request through the API only and never
checks out or runs pull request code.

A pull request merges itself when all of these hold:
  - it is open, not a draft, targets the default branch and is not from a fork;
  - its author is kurts-bots[bot] or kurtlieber;
  - no changed path, and no old path of a rename, is on the Kurt-only list;
  - it is not labelled waiting-on-kurt.

Then the lane waits for the claude-worker's review of the current head (the
`<!-- claude-worker head=SHA -->` marker) and, on a worker branch (claude/...),
for the worker's request for Kurt's review, which the worker makes when its one
fix round on that review is over. Then it turns on squash auto-merge for that
head. The review is advice and gates nothing; waiting for it only makes sure
every merged pull request carries it, and that a fix round runs before the merge.
Auto-merge then waits for the ruleset's required checks.

Otherwise it posts `merge-lane: Kurt merges: <why>` and turns off any auto-merge
the lane turned on for an earlier head. It never touches auto-merge Kurt turned on.

GitHub does not close a pull request's linked issues ("Closes #N") when the
workflow token merges it, so the lane closes them: at once when it merges, and
from the hourly --sweep when auto-merge finished the merge later (no event
reaches the workflow then). Kurt's merges close them as usual.

Usage: merge_lane.py --repo OWNER/NAME --kurt-only FILE (--pr N | --sha SHA | --sweep) [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

AUTHORS = {"kurts-bots[bot]", "kurtlieber"}
WORKER = "kurts-bots[bot]"
WORKER_BRANCH = "claude/"  # the claude-worker's branches: they get one fix round before Kurt's review request
KURT = "kurtlieber"
HOLD = "waiting-on-kurt"  # a question for Kurt is open on the pull request
LANE_BOT = "github-actions[bot]"  # who auto-merge shows as enabled_by when the lane turned it on
CONTEXT = "merge-lane"

ENABLE = """mutation($id: ID!, $oid: GitObjectID!, $title: String!) {
  enablePullRequestAutoMerge(input: {pullRequestId: $id, expectedHeadOid: $oid,
                                     mergeMethod: SQUASH, commitHeadline: $title}) {
    pullRequest { number }
  }
}"""
DISABLE = """mutation($id: ID!) {
  disablePullRequestAutoMerge(input: {pullRequestId: $id}) { pullRequest { number } }
}"""
LINKED = """query($owner: String!, $name: String!, $n: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $n) {
      closingIssuesReferences(first: 25) { nodes { number state repository { nameWithOwner } } }
    }
  }
}"""
SWEEP_DAYS = 7  # how far back --sweep looks for lane merges
# GitHub refuses auto-merge when the pull request can merge right now; merge it directly then.
MERGEABLE_NOW = re.compile(r"\b(clean|unstable|has_hooks) status\b", re.I)


class GitHubError(Exception):
    pass


def field(query: str) -> str:
    """The mutation a GraphQL document runs, for logs."""
    m = re.search(r"\{\s*(\w+)", query)
    return m.group(1) if m else "?"


# --- Kurt-only list -----------------------------------------------------------------------------

def load_patterns(path: Path) -> list[str]:
    lines = (ln.strip() for ln in path.read_text(encoding="utf-8").splitlines())
    return [ln for ln in lines if ln and not ln.startswith("#")]


def pattern_re(pattern: str) -> re.Pattern[str]:
    """`**/` is zero or more directories, `**` anything, `*` and `?` stay inside one segment."""
    out, i = [], 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out.append("(?:[^/]+/)*")
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("".join(out))


def kurt_only(files: list[dict], patterns: list[str]) -> list[str]:
    """Every path, old rename paths included, that a Kurt-only line matches."""
    regexes = [pattern_re(p) for p in patterns]
    paths = []
    for f in files:
        paths += [f["filename"]] + ([f["previous_filename"]] if f.get("previous_filename") else [])
    return [p for p in paths if any(r.fullmatch(p) for r in regexes)]


# --- decision ----------------------------------------------------------------------------------

@dataclass
class Decision:
    state: str | None  # commit status state, or None: post nothing
    description: str
    merge: bool = False


def marker(sha: str) -> str:
    return f"<!-- claude-worker head={sha} -->"


def reviewed(sha: str, reviews: list[dict], comments: list[dict]) -> bool:
    """The worker's review of this head, posted as a review or, when GitHub refused that, a comment."""
    return any((x.get("user") or {}).get("login") == WORKER and marker(sha) in (x.get("body") or "")
               for x in reviews + comments)


def requested(events: list[dict]) -> bool:
    """Kurt's review was requested at some point: on a worker branch, its fix round is over."""
    return any(e.get("event") == "review_requested" and (e.get("requested_reviewer") or {}).get("login") == KURT
               for e in events)


def decide(pr: dict, files: list[dict], patterns: list[str], default_branch: str,
           is_reviewed: bool, round_over: bool = True) -> Decision:
    author = (pr.get("user") or {}).get("login", "")
    head_repo = ((pr.get("head") or {}).get("repo") or {}).get("full_name")
    if pr.get("state") != "open":
        return Decision(None, "not open")
    if pr.get("draft"):
        return Decision(None, "draft")
    if pr["base"]["ref"] != default_branch:
        return Decision("success", f"Kurt merges: targets {pr['base']['ref']}, not {default_branch}")
    if head_repo != pr["base"]["repo"]["full_name"]:
        return Decision("success", "Kurt merges: from a fork")
    if author not in AUTHORS:
        return Decision("success", f"Kurt merges: author {author} is not in the lane")
    if not files or len(files) != pr.get("changed_files"):
        return Decision("success", "Kurt merges: could not list every changed file")
    hit = kurt_only(files, patterns)
    if hit:
        more = f" and {len(hit) - 1} more" if len(hit) > 1 else ""
        return Decision("success", f"Kurt merges: {hit[0]}{more} on the Kurt-only list")
    if HOLD in {(lb or {}).get("name") for lb in pr.get("labels") or []}:
        return Decision("success", f"Kurt merges: labelled {HOLD}")
    if not is_reviewed:
        return Decision("pending", "waiting for the worker's review of this head")
    if not round_over:
        return Decision("pending", "waiting for the worker's fix round")
    return Decision("success", "merges itself after CI", merge=True)


# --- GitHub ------------------------------------------------------------------------------------

class GitHub:
    def __init__(self, token: str, api: str, graphql: str, dry: bool = False) -> None:
        self.token, self.api, self.graphql_url, self.dry = token, api.rstrip("/"), graphql, dry

    def request(self, method: str, url: str, body: dict | None = None) -> tuple[object, dict]:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "merge-lane",
        })
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read()
                return (json.loads(raw) if raw else None), dict(r.headers)
        except urllib.error.HTTPError as e:
            msg = e.read().decode(errors="replace")[:300]
            raise GitHubError(f"{method} {url.removeprefix(self.api)}: HTTP {e.code}: {msg}") from None

    def get(self, path: str) -> object:
        return self.request("GET", f"{self.api}/{path}")[0]

    def pages(self, path: str) -> list:
        out: list = []
        url: str | None = f"{self.api}/{path}{'&' if '?' in path else '?'}per_page=100"
        while url:
            body, headers = self.request("GET", url)
            out += body  # type: ignore[operator]
            m = re.search(r'<([^>]+)>;\s*rel="next"', headers.get("Link") or headers.get("link") or "")
            url = m.group(1) if m else None
        return out

    def write(self, method: str, path: str, body: dict) -> object:
        if self.dry:
            log(f"dry run: would {method} {path}")
            return None
        return self.request(method, f"{self.api}/{path}", body)[0]

    def graphql(self, query: str, variables: dict, write: bool = True) -> dict:
        if self.dry and write:
            log(f"dry run: would run {field(query)}")
            return {}
        body, _ = self.request("POST", self.graphql_url, {"query": query, "variables": variables})
        errors = (body or {}).get("errors")  # type: ignore[union-attr]
        if errors:
            raise GitHubError("; ".join(e.get("message", "?") for e in errors))
        return body["data"]  # type: ignore[index]


def log(msg: str) -> None:
    print(f"merge-lane: {msg}", flush=True)


def find_pr(gh: GitHub, repo: str, sha: str) -> int | None:
    for p in gh.get(f"repos/{repo}/commits/{sha}/pulls") or []:  # type: ignore[union-attr]
        if p.get("state") == "open" and p["head"]["sha"] == sha:
            return p["number"]
    return None


def post_status(gh: GitHub, repo: str, sha: str, d: Decision, target: str) -> None:
    current = next((s for s in gh.get(f"repos/{repo}/commits/{sha}/statuses") or []  # type: ignore[union-attr]
                    if s.get("context") == CONTEXT), None)
    desc = d.description[:140]
    if current and current.get("state") == d.state and current.get("description") == desc:
        return
    body = {"state": d.state, "context": CONTEXT, "description": desc}
    if target:
        body["target_url"] = target
    gh.write("POST", f"repos/{repo}/statuses/{sha}", body)


def merged_by_lane(pr: dict) -> bool:
    return bool(pr.get("merged")) and (pr.get("merged_by") or {}).get("login") == LANE_BOT


def close_linked(gh: GitHub, repo: str, number: int) -> None:
    """Close the open issues this pull request names with a closing keyword, in this repository."""
    owner, name = repo.split("/")
    data = gh.graphql(LINKED, {"owner": owner, "name": name, "n": number}, write=False)
    refs = (((data.get("repository") or {}).get("pullRequest") or {})
            .get("closingIssuesReferences") or {}).get("nodes") or []
    for i in refs:
        if i.get("state") != "OPEN" or (i.get("repository") or {}).get("nameWithOwner", "").lower() != repo.lower():
            continue
        gh.write("PATCH", f"repos/{repo}/issues/{i['number']}", {"state": "closed", "state_reason": "completed"})
        log(f"#{number}: closed #{i['number']}")


def sweep(gh: GitHub, repo: str) -> None:
    """Close the linked issues of recent lane merges, for those auto-merge finished."""
    since = datetime.now(timezone.utc) - timedelta(days=SWEEP_DAYS)
    for p in gh.get(f"repos/{repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50") or []:  # type: ignore[union-attr]
        merged = p.get("merged_at")
        if not merged or datetime.fromisoformat(merged.replace("Z", "+00:00")) < since:
            continue
        if merged_by_lane(gh.get(f"repos/{repo}/pulls/{p['number']}")):  # type: ignore[arg-type]
            close_linked(gh, repo, p["number"])


def run(gh: GitHub, repo: str, number: int, patterns: list[str], target: str = "") -> Decision:
    pr: dict = gh.get(f"repos/{repo}/pulls/{number}")  # type: ignore[assignment]
    sha = pr["head"]["sha"]
    default_branch = pr["base"]["repo"]["default_branch"]
    files = gh.pages(f"repos/{repo}/pulls/{number}/files") if pr.get("state") == "open" else []
    is_reviewed = bool(files) and reviewed(sha, gh.pages(f"repos/{repo}/pulls/{number}/reviews"),
                                           gh.pages(f"repos/{repo}/issues/{number}/comments"))
    # The worker requests Kurt's review of its own pull request only when its fix round is over
    # (claude-worker, pass 2 and end_round); every other pull request requests him at once.
    round_over = (not is_reviewed or not pr["head"]["ref"].startswith(WORKER_BRANCH)
                  or requested(gh.pages(f"repos/{repo}/issues/{number}/events")))
    d = decide(pr, files, patterns, default_branch, is_reviewed, round_over)
    log(f"#{number} at {sha[:7]}: {d.description}")
    if d.state is None:
        if merged_by_lane(pr):
            close_linked(gh, repo, number)
        return d
    post_status(gh, repo, sha, d, target)

    auto = pr.get("auto_merge")
    if d.merge and not auto:
        title = f"{pr['title']} (#{number})"
        try:
            gh.graphql(ENABLE, {"id": pr["node_id"], "oid": sha, "title": title})
            log(f"#{number}: auto-merge on for {sha[:7]}")
        except GitHubError as e:
            if not MERGEABLE_NOW.search(str(e)):
                raise
            gh.write("PUT", f"repos/{repo}/pulls/{number}/merge",
                     {"merge_method": "squash", "sha": sha, "commit_title": title})
            log(f"#{number}: merged {sha[:7]} (it could merge at once, so no auto-merge)")
            close_linked(gh, repo, number)
    elif not d.merge and auto and (auto.get("enabled_by") or {}).get("login") == LANE_BOT:
        gh.graphql(DISABLE, {"id": pr["node_id"]})
        log(f"#{number}: auto-merge off; the lane had turned it on for an earlier head")
    return d


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--repo", required=True)
    ap.add_argument("--kurt-only", required=True, type=Path)
    ap.add_argument("--pr", type=int)
    ap.add_argument("--sha")
    ap.add_argument("--sweep", action="store_true", help="close the linked issues of recent lane merges")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not token:
        log("GITHUB_TOKEN is unset")
        return 2
    api = os.environ.get("GITHUB_API_URL", "https://api.github.com")
    gh = GitHub(token, api, os.environ.get("GITHUB_GRAPHQL_URL", f"{api}/graphql"), a.dry_run)
    if a.sweep:
        try:
            sweep(gh, a.repo)
        except GitHubError as e:
            log(str(e))
            return 1
        return 0
    number = a.pr or (find_pr(gh, a.repo, a.sha) if a.sha else None)
    if not number:
        log(f"no open pull request has head {a.sha}" if a.sha else "give --pr or --sha")
        return 0 if a.sha else 2
    server, run_id = os.environ.get("GITHUB_SERVER_URL"), os.environ.get("GITHUB_RUN_ID")
    target = f"{server}/{a.repo}/actions/runs/{run_id}" if server and run_id else ""
    try:
        run(gh, a.repo, number, load_patterns(a.kurt_only), target)
    except GitHubError as e:
        log(str(e))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
