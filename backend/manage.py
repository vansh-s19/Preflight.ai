"""
manage.py — Admin CLI for organisations and access tokens.

Usage (from backend/):
    .venv/bin/python manage.py create-org org_acme "Acme Corp" --plan growth
    .venv/bin/python manage.py issue-token org_acme --label "Acme rollout"
    .venv/bin/python manage.py list-tokens org_acme
    .venv/bin/python manage.py revoke-token 3
    .venv/bin/python manage.py set-plan org_acme business
    .venv/bin/python manage.py list-orgs

issue-token prints the token once. Only its hash is stored, so copy it then.
Set PREFLIGHT_DB_PATH to point at a database other than the default.
"""

from __future__ import annotations

import argparse
import sys

import auth


def _cmd_create_org(args: argparse.Namespace) -> None:
    auth.create_org(args.org_id, args.name, args.plan)
    print(f"Created organisation {args.org_id} ({args.plan}).")


def _cmd_set_plan(args: argparse.Namespace) -> None:
    auth.set_org_plan(args.org_id, args.plan)
    print(f"{args.org_id} is now on the {args.plan} plan.")


def _cmd_list_orgs(args: argparse.Namespace) -> None:
    for row in auth.list_orgs():
        print(f"{row['id']}\t{row['plan']}\t{row['name']}\t{row['created_at']}")


def _cmd_issue_token(args: argparse.Namespace) -> None:
    record, token = auth.issue_token(args.org_id, args.label)
    print(f"Token id {record.id} for {record.org_id}. Copy it now; it will not be shown again:\n")
    print(token)


def _cmd_list_tokens(args: argparse.Namespace) -> None:
    for record in auth.list_tokens(args.org_id):
        state = f"revoked {record.revoked_at}" if record.revoked_at else "active"
        print(f"{record.id}\t{record.org_id}\t{record.prefix}…\t{state}\t{record.label or ''}")


def _cmd_revoke_token(args: argparse.Namespace) -> None:
    if not auth.revoke_token(args.token_id):
        raise ValueError(f"No active token with id {args.token_id}.")
    print(f"Revoked token {args.token_id}.")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage Preflight organisations and access tokens.")
    sub = parser.add_subparsers(dest="command", required=True)
    plans = ["starter", "growth", "business"]

    p = sub.add_parser("create-org", help="Create an organisation.")
    p.add_argument("org_id")
    p.add_argument("name")
    p.add_argument("--plan", choices=plans, required=True)
    p.set_defaults(func=_cmd_create_org)

    p = sub.add_parser("set-plan", help="Change an organisation's plan.")
    p.add_argument("org_id")
    p.add_argument("plan", choices=plans)
    p.set_defaults(func=_cmd_set_plan)

    p = sub.add_parser("list-orgs", help="List organisations.")
    p.set_defaults(func=_cmd_list_orgs)

    p = sub.add_parser("issue-token", help="Issue a new access token and print it once.")
    p.add_argument("org_id")
    p.add_argument("--label", help="Note to tell tokens apart, e.g. a team or rollout name.")
    p.set_defaults(func=_cmd_issue_token)

    p = sub.add_parser("list-tokens", help="List tokens (prefix only), optionally for one org.")
    p.add_argument("org_id", nargs="?")
    p.set_defaults(func=_cmd_list_tokens)

    p = sub.add_parser("revoke-token", help="Revoke a token by id (see list-tokens).")
    p.add_argument("token_id", type=int)
    p.set_defaults(func=_cmd_revoke_token)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        args.func(args)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
