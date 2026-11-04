"""
auth.py — Token-to-org resolution and plan-tier gating.

All plan checks happen server-side. Client-supplied plan fields are never trusted.

Organisations and their access tokens live in SQLite (the same file as the scan
events). Only a SHA-256 hash of each token is stored; the plaintext is shown
once by `manage.py issue-token` and cannot be recovered afterwards.
resolve_org() is the single lookup point used by every authenticated endpoint.
"""

from __future__ import annotations

import hashlib
import os
import secrets
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------

Plan = Literal["starter", "growth", "business"]


@dataclass(frozen=True)
class OrgRecord:
    org_id: str
    plan: Plan


@dataclass(frozen=True)
class TokenRecord:
    id: int
    org_id: str
    prefix: str
    label: Optional[str]
    created_at: str
    revoked_at: Optional[str]


# Plan tier ordering — higher index = more permissive
_PLAN_TIERS: list[str] = ["starter", "growth", "business"]

# Feature availability by minimum required tier
_FEATURE_MIN_TIER: dict[str, str] = {
    "keywords": "starter",
    "history": "starter",
    "dashboard": "starter",
    "export": "starter",
    "layer2": "growth",
    "layer3": "business",
}

TOKEN_PREFIX = "pft_"


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------

_DEFAULT_DATABASE_PATH = Path(__file__).resolve().parent / "preflight_monitoring.sqlite3"


def database_path() -> Path:
    """SQLite file shared by auth and monitoring. Override with PREFLIGHT_DB_PATH."""
    override = os.environ.get("PREFLIGHT_DB_PATH")
    return Path(override) if override else _DEFAULT_DATABASE_PATH


def init_auth_tables(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS organizations (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            plan TEXT NOT NULL CHECK (plan IN ('starter', 'growth', 'business')),
            created_at TEXT NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS access_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            token_hash TEXT NOT NULL UNIQUE,
            prefix TEXT NOT NULL,
            label TEXT NULL,
            created_at TEXT NOT NULL,
            revoked_at TEXT NULL
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_access_tokens_org ON access_tokens(org_id)")


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(database_path())
    conn.row_factory = sqlite3.Row
    init_auth_tables(conn)
    return conn


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def hash_token(token: str) -> str:
    # Tokens are 256-bit random values, so a fast unsalted hash is sufficient.
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Admin operations (used by manage.py and tests)
# ---------------------------------------------------------------------------

def create_org(org_id: str, name: str, plan: Plan) -> OrgRecord:
    if plan not in _PLAN_TIERS:
        raise ValueError(f"Unknown plan '{plan}'. Choose one of: {', '.join(_PLAN_TIERS)}.")
    with _connect() as conn:
        try:
            conn.execute(
                "INSERT INTO organizations (id, name, plan, created_at) VALUES (?, ?, ?, ?)",
                (org_id, name, plan, _now()),
            )
        except sqlite3.IntegrityError as exc:
            raise ValueError(f"Organisation '{org_id}' already exists.") from exc
    return OrgRecord(org_id=org_id, plan=plan)


def set_org_plan(org_id: str, plan: Plan) -> None:
    if plan not in _PLAN_TIERS:
        raise ValueError(f"Unknown plan '{plan}'. Choose one of: {', '.join(_PLAN_TIERS)}.")
    with _connect() as conn:
        cursor = conn.execute("UPDATE organizations SET plan = ? WHERE id = ?", (plan, org_id))
        if cursor.rowcount == 0:
            raise ValueError(f"Organisation '{org_id}' does not exist.")


def list_orgs() -> list[sqlite3.Row]:
    with _connect() as conn:
        return conn.execute("SELECT id, name, plan, created_at FROM organizations ORDER BY id").fetchall()


def issue_token(org_id: str, label: Optional[str] = None) -> tuple[TokenRecord, str]:
    """Create a token for org_id. Returns (record, plaintext); plaintext is not stored."""
    token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    created_at = _now()
    with _connect() as conn:
        if conn.execute("SELECT 1 FROM organizations WHERE id = ?", (org_id,)).fetchone() is None:
            raise ValueError(f"Organisation '{org_id}' does not exist.")
        prefix = token[: len(TOKEN_PREFIX) + 6]
        cursor = conn.execute(
            "INSERT INTO access_tokens (org_id, token_hash, prefix, label, created_at) VALUES (?, ?, ?, ?, ?)",
            (org_id, hash_token(token), prefix, label, created_at),
        )
        record = TokenRecord(
            id=cursor.lastrowid, org_id=org_id, prefix=prefix,
            label=label, created_at=created_at, revoked_at=None,
        )
    return record, token


def list_tokens(org_id: Optional[str] = None) -> list[TokenRecord]:
    query = "SELECT id, org_id, prefix, label, created_at, revoked_at FROM access_tokens"
    params: tuple[str, ...] = ()
    if org_id:
        query += " WHERE org_id = ?"
        params = (org_id,)
    with _connect() as conn:
        rows = conn.execute(query + " ORDER BY id", params).fetchall()
    return [TokenRecord(**dict(row)) for row in rows]


def revoke_token(token_id: int) -> bool:
    """Revoke a token by id. Returns False if it does not exist or was already revoked."""
    with _connect() as conn:
        cursor = conn.execute(
            "UPDATE access_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
            (_now(), token_id),
        )
        return cursor.rowcount > 0


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def resolve_org(token: str) -> OrgRecord | None:
    """
    Return the OrgRecord associated with the given Bearer token.
    Returns None if the token is unknown or revoked.
    """
    if not token or not token.startswith(TOKEN_PREFIX):
        return None
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT o.id, o.plan FROM access_tokens t
            JOIN organizations o ON o.id = t.org_id
            WHERE t.token_hash = ? AND t.revoked_at IS NULL
            """,
            (hash_token(token),),
        ).fetchone()
    if row is None:
        return None
    return OrgRecord(org_id=row["id"], plan=row["plan"])


def plan_includes(plan: str, feature: str) -> bool:
    """
    Return True iff the given plan tier grants access to the specified feature.

    Tier hierarchy:  business ⊇ growth ⊇ starter

    Examples:
        plan_includes("growth",   "layer2") → True
        plan_includes("starter",  "layer2") → False
        plan_includes("business", "layer3") → True
        plan_includes("growth",   "layer3") → False
    """
    if plan not in _PLAN_TIERS:
        return False
    min_tier = _FEATURE_MIN_TIER.get(feature)
    if min_tier is None:
        return False
    return _PLAN_TIERS.index(plan) >= _PLAN_TIERS.index(min_tier)


def plan_features(plan: str) -> list[str]:
    """All features the plan unlocks, in a stable order (sent to the extension by /config)."""
    return [feature for feature in _FEATURE_MIN_TIER if plan_includes(plan, feature)]
