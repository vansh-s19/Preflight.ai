"""
tests/test_auth.py — Token store, endpoint authentication and org isolation.

These tests use a temporary SQLite file and do not need the trained model.

Run:
    cd backend
    .venv/bin/python -m pytest tests/test_auth.py -v
"""

from __future__ import annotations

import pathlib
import sys

# Ensure backend root is on the path
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))

import pytest
from fastapi.testclient import TestClient

import auth
import main
import manage


DASHBOARD_PATHS = [
    "/api/dashboard/summary",
    "/api/dashboard/recent-events",
    "/api/dashboard/timeline",
    "/api/dashboard/severity",
    "/api/dashboard/categories",
    "/api/dashboard/heatmap",
    "/api/dashboard/source/browser-distribution",
    "/api/dashboard/source/ai-platform-distribution",
    "/api/dashboard/export/json",
    "/api/dashboard/export/csv",
]


def _event(**overrides) -> dict:
    event = {
        "timestamp": "2026-11-01T10:00:00Z",
        "input_preview": "",
        "layer1_detections": ["aadhaar"],
        "layer2_detections": [],
        "severity": "critical",
        "latency_ms": 4.0,
        "ai_platform": "chatgpt",
        "domain": "chatgpt.com",
    }
    event.update(overrides)
    return event


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture()
def db(tmp_path, monkeypatch):
    monkeypatch.setenv("PREFLIGHT_DB_PATH", str(tmp_path / "test.sqlite3"))
    main.init_database()


@pytest.fixture()
def client(db):
    # Not used as a context manager, so the ML lifespan (model loading) is skipped.
    return TestClient(main.app)


@pytest.fixture()
def tokens(db):
    auth.create_org("org_a", "Org A", "growth")
    auth.create_org("org_b", "Org B", "starter")
    _, token_a = auth.issue_token("org_a")
    _, token_b = auth.issue_token("org_b")
    return {"a": token_a, "b": token_b}


# ---------------------------------------------------------------------------
# Token store
# ---------------------------------------------------------------------------

class TestTokenStore:
    def test_issued_token_resolves_to_its_org(self, tokens):
        assert auth.resolve_org(tokens["a"]) == auth.OrgRecord(org_id="org_a", plan="growth")

    def test_plaintext_token_is_not_stored(self, tokens, tmp_path):
        raw = (tmp_path / "test.sqlite3").read_bytes()
        assert tokens["a"].encode() not in raw
        assert auth.hash_token(tokens["a"]).encode() in raw

    def test_revoked_token_no_longer_resolves(self, db):
        auth.create_org("org_r", "Org R", "business")
        record, token = auth.issue_token("org_r")
        assert auth.revoke_token(record.id) is True
        assert auth.resolve_org(token) is None
        assert auth.revoke_token(record.id) is False

    @pytest.mark.parametrize("token", ["tok_starter_acme", "tok_growth_bravo", "tok_business_delta", "", "pft_"])
    def test_unknown_and_old_demo_tokens_do_not_resolve(self, db, token):
        assert auth.resolve_org(token) is None

    def test_issue_token_for_missing_org_fails(self, db):
        with pytest.raises(ValueError):
            auth.issue_token("org_missing")

    def test_duplicate_org_fails(self, db):
        auth.create_org("org_x", "X", "starter")
        with pytest.raises(ValueError):
            auth.create_org("org_x", "X again", "growth")

    def test_plan_change_applies_to_existing_tokens(self, tokens):
        auth.set_org_plan("org_b", "business")
        assert auth.resolve_org(tokens["b"]).plan == "business"


class TestManageCli:
    def test_create_issue_list_revoke(self, db, capsys):
        assert manage.main(["create-org", "org_cli", "CLI Org", "--plan", "growth"]) == 0
        assert manage.main(["issue-token", "org_cli", "--label", "pilot"]) == 0
        token = capsys.readouterr().out.strip().splitlines()[-1]
        assert auth.resolve_org(token).org_id == "org_cli"

        assert manage.main(["list-tokens", "org_cli"]) == 0
        listing = capsys.readouterr().out
        assert token not in listing
        assert token[:10] in listing

        token_id = auth.list_tokens("org_cli")[0].id
        assert manage.main(["revoke-token", str(token_id)]) == 0
        assert auth.resolve_org(token) is None

    def test_errors_return_nonzero(self, db, capsys):
        assert manage.main(["issue-token", "org_missing"]) == 1
        assert "does not exist" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# Endpoint authentication
# ---------------------------------------------------------------------------

class TestAuthRequired:
    def test_health_is_public(self, client):
        assert client.get("/health").status_code == 200

    def test_scan_event_without_token_is_401(self, client):
        assert client.post("/api/scan-event", json=_event()).status_code == 401

    @pytest.mark.parametrize("path", DASHBOARD_PATHS + ["/config"])
    def test_get_without_token_is_401(self, client, path):
        assert client.get(path).status_code == 401

    @pytest.mark.parametrize("path", DASHBOARD_PATHS + ["/config"])
    def test_get_with_bad_token_is_401(self, client, tokens, path):
        assert client.get(path, headers=_bearer("pft_not_a_real_token")).status_code == 401

    @pytest.mark.parametrize("token", ["tok_starter_acme", "tok_growth_bravo", "tok_business_delta"])
    def test_old_demo_tokens_are_rejected(self, client, token):
        assert client.get("/config", headers=_bearer(token)).status_code == 401
        assert client.post("/api/scan-event", json=_event(), headers=_bearer(token)).status_code == 401

    def test_classify_without_token_is_401(self, client):
        assert client.post("/classify", json={"text": "hello"}).status_code == 401


class TestConfig:
    def test_config_returns_features_for_plan(self, client, tokens):
        body = client.get("/config", headers=_bearer(tokens["a"])).json()
        assert body["org_id"] == "org_a"
        assert body["plan"] == "growth"
        assert body["layer2_enabled"] is True
        assert body["layer3_enabled"] is False
        assert body["features"] == ["keywords", "history", "dashboard", "export", "layer2"]

    def test_starter_features_exclude_layer2(self, client, tokens):
        body = client.get("/config", headers=_bearer(tokens["b"])).json()
        assert "layer2" not in body["features"]
        assert {"keywords", "dashboard", "export"} <= set(body["features"])

    def test_business_features_include_layer3(self):
        assert auth.plan_features("business")[-2:] == ["layer2", "layer3"]


# ---------------------------------------------------------------------------
# Org isolation
# ---------------------------------------------------------------------------

class TestOrgIsolation:
    def test_org_id_comes_from_token_not_body(self, client, tokens):
        response = client.post(
            "/api/scan-event",
            json=_event(organization_id="org_b"),
            headers=_bearer(tokens["a"]),
        )
        assert response.status_code == 200

        events_a = client.get("/api/dashboard/recent-events", headers=_bearer(tokens["a"])).json()
        events_b = client.get("/api/dashboard/recent-events", headers=_bearer(tokens["b"])).json()
        assert [event["organization_id"] for event in events_a] == ["org_a"]
        assert events_b == []

    def test_org_a_cannot_see_org_b_events(self, client, tokens):
        for _ in range(3):
            client.post("/api/scan-event", json=_event(domain="a.example"), headers=_bearer(tokens["a"]))
        client.post(
            "/api/scan-event",
            json=_event(domain="b.example", severity="low", ai_platform="claude"),
            headers=_bearer(tokens["b"]),
        )

        summary_a = client.get("/api/dashboard/summary", headers=_bearer(tokens["a"])).json()
        summary_b = client.get("/api/dashboard/summary", headers=_bearer(tokens["b"])).json()
        assert summary_a["total_scans"] == 3
        assert summary_b["total_scans"] == 1
        assert summary_b["critical_threats"] == 0

        export_a = client.get("/api/dashboard/export/json", headers=_bearer(tokens["a"])).json()
        assert {row["domain"] for row in export_a} == {"a.example"}

        csv_b = client.get("/api/dashboard/export/csv", headers=_bearer(tokens["b"])).text
        assert "b.example" in csv_b
        assert "a.example" not in csv_b

        platforms_b = client.get(
            "/api/dashboard/source/ai-platform-distribution", headers=_bearer(tokens["b"])
        ).json()
        assert {item["name"]: item["count"] for item in platforms_b}["chatgpt"] == 0

        # Filters can't widen the scope past the caller's org.
        filtered = client.get(
            "/api/dashboard/recent-events",
            params={"domain": "a.example"},
            headers=_bearer(tokens["b"]),
        ).json()
        assert filtered == []

    def test_revoked_token_loses_dashboard_access(self, client, tokens):
        token_id = auth.list_tokens("org_a")[0].id
        auth.revoke_token(token_id)
        assert client.get("/api/dashboard/summary", headers=_bearer(tokens["a"])).status_code == 401
