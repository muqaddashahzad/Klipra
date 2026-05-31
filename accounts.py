"""User accounts + sessions + influencer applications.

Single-file SQLite-backed accounts module. Designed to be embedded into
the existing FastAPI app without pulling in a heavy ORM or migration
framework — just stdlib `sqlite3` + bcrypt for password hashing.

Concepts:
  - User: email + bcrypt-hashed password + collected social handles +
    plan tier (free/pro/studio) + jobs-used counter for the current
    billing cycle. The `stripe_customer_id` column glues a user to a
    Stripe customer for the paid tier.
  - Session: opaque random token mapped to a user_id with a TTL.
    Stored in a `sessions` table; the frontend sends it via
    `Authorization: Bearer <token>` or the `klipra_session` cookie.
  - Influencer application: separate, lightweight intake form
    capturing the creator's promo-video links. Manual approval — you
    review the table and email them the install guide.

Plan limits live in PLAN_LIMITS so they're easy to tune.

Storage location: `data/users.db` (configurable via KLIPRA_USERS_DB).
That path is inside the bind-mounted output dir's sibling so it
survives container rebuilds.
"""

from __future__ import annotations

import json
import os
import secrets
import sqlite3
import time
from contextlib import contextmanager
from typing import Optional, Dict, Any, List

import bcrypt


# ----- Configuration -----------------------------------------------------

USERS_DB_PATH = os.environ.get(
    "KLIPRA_USERS_DB",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "users.db"),
)

# Per-month job allowance per plan. None = unlimited.
PLAN_LIMITS: Dict[str, Optional[int]] = {
    "free":   5,
    "pro":    50,
    "studio": None,
}

# Session TTL (seconds). 30 days. Sessions are extended on every
# auth check, so an active user effectively stays logged in.
SESSION_TTL_SECONDS = 30 * 24 * 3600


# ----- Connection / schema -----------------------------------------------

def _ensure_dir():
    os.makedirs(os.path.dirname(USERS_DB_PATH), exist_ok=True)


@contextmanager
def _conn():
    """Yield a SQLite connection with row factory + foreign keys on."""
    _ensure_dir()
    con = sqlite3.connect(USERS_DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    try:
        yield con
        con.commit()
    finally:
        con.close()


def init_db() -> None:
    """Create tables if they don't exist. Idempotent — safe to call on
    every backend start, which is what we do from app.py's lifespan.

    Also runs lightweight ALTER TABLE migrations for columns added after
    the initial release (e.g. OAuth identity columns) so existing
    deployments don't need a manual migration step.
    """
    _ensure_dir()
    with _conn() as con:
        con.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                email               TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash       TEXT NOT NULL,
                full_name           TEXT,
                social_handles_json TEXT NOT NULL DEFAULT '{}',
                plan                TEXT NOT NULL DEFAULT 'free',
                jobs_used           INTEGER NOT NULL DEFAULT 0,
                jobs_period_start   INTEGER NOT NULL,
                stripe_customer_id  TEXT,
                stripe_subscription_id TEXT,
                is_admin            INTEGER NOT NULL DEFAULT 0,
                created_at          INTEGER NOT NULL,
                updated_at          INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                token       TEXT PRIMARY KEY,
                user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at  INTEGER NOT NULL,
                expires_at  INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

            CREATE TABLE IF NOT EXISTS influencer_applications (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                email             TEXT NOT NULL,
                full_name         TEXT,
                social_handles_json TEXT NOT NULL DEFAULT '{}',
                promo_links_json  TEXT NOT NULL DEFAULT '[]',
                notes             TEXT,
                status            TEXT NOT NULL DEFAULT 'pending',
                created_at        INTEGER NOT NULL,
                reviewed_at       INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_apps_status ON influencer_applications(status);
            """
        )
        # Lightweight migrations for columns added after the initial
        # release. SQLite doesn't support `ADD COLUMN IF NOT EXISTS`, so
        # we check via PRAGMA first.
        existing_cols = {r["name"] for r in con.execute("PRAGMA table_info(users)")}
        if "oauth_provider" not in existing_cols:
            con.execute("ALTER TABLE users ADD COLUMN oauth_provider TEXT")
        if "oauth_provider_id" not in existing_cols:
            con.execute("ALTER TABLE users ADD COLUMN oauth_provider_id TEXT")
        if "avatar_url" not in existing_cols:
            con.execute("ALTER TABLE users ADD COLUMN avatar_url TEXT")
        con.execute(
            "CREATE INDEX IF NOT EXISTS idx_users_oauth "
            "ON users(oauth_provider, oauth_provider_id)"
        )


# ----- Password hashing --------------------------------------------------

def hash_password(plain: str) -> str:
    if not plain or len(plain) < 8:
        raise ValueError("Password must be at least 8 characters.")
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt(rounds=12)).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    if not plain or not hashed:
        return False
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False


# ----- User CRUD ---------------------------------------------------------

def _row_get(row, key, default=None):
    """sqlite3.Row doesn't expose .get(). Wrap KeyError so callers
    can ask for columns added by a later migration without crashing
    when an old DB hasn't run them yet."""
    try:
        return row[key]
    except (IndexError, KeyError):
        return default


def _row_to_user(row: sqlite3.Row) -> Dict[str, Any]:
    """Normalize a sqlite Row into the shape we hand to API consumers."""
    if not row:
        return None
    try:
        handles = json.loads(row["social_handles_json"] or "{}")
    except Exception:
        handles = {}
    return {
        "id": row["id"],
        "email": row["email"],
        "full_name": row["full_name"],
        "social_handles": handles,
        "plan": row["plan"] or "free",
        "jobs_used": row["jobs_used"] or 0,
        "jobs_limit": PLAN_LIMITS.get(row["plan"] or "free", PLAN_LIMITS["free"]),
        "jobs_period_start": row["jobs_period_start"],
        "stripe_customer_id": row["stripe_customer_id"],
        "stripe_subscription_id": row["stripe_subscription_id"],
        "is_admin": bool(row["is_admin"]),
        "oauth_provider": _row_get(row, "oauth_provider"),
        "avatar_url": _row_get(row, "avatar_url"),
        "created_at": row["created_at"],
    }


def find_or_create_oauth_user(*, provider: str, provider_user_id: str,
                               email: Optional[str], full_name: Optional[str] = None,
                               avatar_url: Optional[str] = None) -> tuple[Dict[str, Any], bool]:
    """Resolve an OAuth login to a Klipra user, in order of preference:

      1. Match by (oauth_provider, oauth_provider_id). Pure happy path —
         this user has signed in with this provider before.
      2. Match by email. The user already has a password account; we
         link the OAuth identity onto it so they can use either method.
      3. Create a new user with no password (random unguessable hash so
         the NOT NULL constraint is satisfied; verify_password will
         always return False, so password-based sign-in is impossible).

    Returns `(user, was_created)`. `was_created` is True only on
    branch 3 — caller uses it to decide whether to fire a welcome
    email (we don't want every login to spam the user).

    Email is required because:
      - It's the unique key on the users table.
      - We need it for billing receipts, password resets, etc.
    Google always returns email; GitHub may return None if the user has
    set their email private — the caller fetches it from /user/emails.
    """
    if not provider_user_id:
        raise ValueError("provider_user_id is required.")
    provider_user_id = str(provider_user_id)
    if not email:
        raise ValueError(
            f"{provider} did not return an email address. Make sure your "
            "primary email is verified and not hidden in your provider "
            "account settings."
        )
    email = email.strip().lower()
    now = int(time.time())
    with _conn() as con:
        # 1. By (provider, provider_user_id)
        row = con.execute(
            "SELECT * FROM users WHERE oauth_provider = ? AND oauth_provider_id = ?",
            (provider, provider_user_id),
        ).fetchone()
        if row:
            con.execute(
                "UPDATE users SET full_name = COALESCE(?, full_name), "
                "avatar_url = COALESCE(?, avatar_url), updated_at = ? WHERE id = ?",
                (full_name, avatar_url, now, row["id"]),
            )
            return get_user_by_id(row["id"]), False  # existing OAuth user

        # 2. By email — link OAuth identity onto the existing account
        row = con.execute(
            "SELECT * FROM users WHERE email = ? COLLATE NOCASE",
            (email,),
        ).fetchone()
        if row:
            con.execute(
                "UPDATE users SET oauth_provider = ?, oauth_provider_id = ?, "
                "full_name = COALESCE(?, full_name), avatar_url = COALESCE(?, avatar_url), "
                "updated_at = ? WHERE id = ?",
                (provider, provider_user_id, full_name, avatar_url, now, row["id"]),
            )
            return get_user_by_id(row["id"]), False  # linked to existing account

        # 3. Create a brand-new account
        random_pw = secrets.token_urlsafe(32)
        pw_hash = hash_password(random_pw)
        cur = con.execute(
            """
            INSERT INTO users (email, password_hash, full_name, social_handles_json,
                               plan, jobs_used, jobs_period_start,
                               oauth_provider, oauth_provider_id, avatar_url,
                               created_at, updated_at)
            VALUES (?, ?, ?, '{}', 'free', 0, ?, ?, ?, ?, ?, ?)
            """,
            (email, pw_hash, full_name, now, provider, provider_user_id,
             avatar_url, now, now),
        )
        new_id = cur.lastrowid
        new_user = con.execute("SELECT * FROM users WHERE id = ?", (new_id,)).fetchone()
        return dict(new_user), True  # brand-new signup


def create_user(*, email: str, password: str, full_name: Optional[str] = None,
                social_handles: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    email = (email or "").strip().lower()
    if not email or "@" not in email:
        raise ValueError("Invalid email address.")
    pw_hash = hash_password(password)
    handles_json = json.dumps(social_handles or {}, ensure_ascii=False)
    now = int(time.time())
    with _conn() as con:
        try:
            cur = con.execute(
                """
                INSERT INTO users (email, password_hash, full_name, social_handles_json,
                                   plan, jobs_used, jobs_period_start, created_at, updated_at)
                VALUES (?, ?, ?, ?, 'free', 0, ?, ?, ?)
                """,
                (email, pw_hash, full_name, handles_json, now, now, now),
            )
        except sqlite3.IntegrityError as e:
            raise ValueError("An account with that email already exists.") from e
        user_id = cur.lastrowid
    return get_user_by_id(user_id)


def get_user_by_email(email: str) -> Optional[Dict[str, Any]]:
    if not email:
        return None
    with _conn() as con:
        row = con.execute(
            "SELECT * FROM users WHERE email = ? COLLATE NOCASE",
            (email.strip().lower(),),
        ).fetchone()
    return _row_to_user(row)


def get_user_by_id(user_id: int) -> Optional[Dict[str, Any]]:
    if not user_id:
        return None
    with _conn() as con:
        row = con.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return _row_to_user(row)


def authenticate(email: str, password: str) -> Optional[Dict[str, Any]]:
    """Return the user dict on success, None on bad email/password.
    Hashes are looked up with a separate query to avoid leaking
    timing info on whether the email exists."""
    with _conn() as con:
        row = con.execute(
            "SELECT id, password_hash FROM users WHERE email = ? COLLATE NOCASE",
            ((email or "").strip().lower(),),
        ).fetchone()
    if not row:
        # Run a dummy verify against a known hash to keep timing roughly
        # constant. Probably overkill for our use case but cheap.
        verify_password(password, "$2b$12$" + "a" * 53)
        return None
    if not verify_password(password, row["password_hash"]):
        return None
    return get_user_by_id(row["id"])


# ----- Sessions ----------------------------------------------------------

def create_session(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    now = int(time.time())
    with _conn() as con:
        con.execute(
            "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (token, user_id, now, now + SESSION_TTL_SECONDS),
        )
    return token


def get_user_by_session(token: str) -> Optional[Dict[str, Any]]:
    if not token:
        return None
    now = int(time.time())
    with _conn() as con:
        row = con.execute(
            "SELECT user_id, expires_at FROM sessions WHERE token = ?",
            (token,),
        ).fetchone()
        if not row:
            return None
        if row["expires_at"] < now:
            con.execute("DELETE FROM sessions WHERE token = ?", (token,))
            return None
        # Slide the expiry forward so active users stay logged in.
        con.execute(
            "UPDATE sessions SET expires_at = ? WHERE token = ?",
            (now + SESSION_TTL_SECONDS, token),
        )
        user = get_user_by_id(row["user_id"])
    return user


def destroy_session(token: str) -> None:
    if not token:
        return
    with _conn() as con:
        con.execute("DELETE FROM sessions WHERE token = ?", (token,))


# ----- Plan / usage gating ----------------------------------------------

def can_run_job(user_id: int) -> tuple[bool, str]:
    """Return (allowed, reason). Resets monthly counter if a new period
    has started since `jobs_period_start`. Counter is incremented by
    `record_job_usage` after the job actually starts."""
    user = get_user_by_id(user_id)
    if not user:
        return False, "User not found."
    plan = user["plan"] or "free"
    limit = PLAN_LIMITS.get(plan, PLAN_LIMITS["free"])
    now = int(time.time())
    # Treat 30 days as "a month" for simplicity. A real billing-cycle
    # implementation would key off Stripe's invoice period.
    if user["jobs_period_start"] and now - user["jobs_period_start"] > 30 * 24 * 3600:
        with _conn() as con:
            con.execute(
                "UPDATE users SET jobs_used = 0, jobs_period_start = ?, updated_at = ? WHERE id = ?",
                (now, now, user_id),
            )
        user["jobs_used"] = 0
    if limit is None:
        return True, "ok"
    if (user["jobs_used"] or 0) >= limit:
        return False, (
            f"You've used all {limit} jobs on the {plan} plan this month. "
            "Upgrade to keep going."
        )
    return True, "ok"


def record_job_usage(user_id: int, increment: int = 1) -> None:
    now = int(time.time())
    with _conn() as con:
        con.execute(
            "UPDATE users SET jobs_used = jobs_used + ?, updated_at = ? WHERE id = ?",
            (increment, now, user_id),
        )


def set_plan(user_id: int, plan: str, *, stripe_subscription_id: Optional[str] = None) -> None:
    if plan not in PLAN_LIMITS:
        raise ValueError(f"Unknown plan: {plan}")
    now = int(time.time())
    with _conn() as con:
        con.execute(
            "UPDATE users SET plan = ?, stripe_subscription_id = COALESCE(?, stripe_subscription_id), "
            "jobs_used = 0, jobs_period_start = ?, updated_at = ? WHERE id = ?",
            (plan, stripe_subscription_id, now, now, user_id),
        )


def attach_stripe_customer(user_id: int, customer_id: str) -> None:
    now = int(time.time())
    with _conn() as con:
        con.execute(
            "UPDATE users SET stripe_customer_id = ?, updated_at = ? WHERE id = ?",
            (customer_id, now, user_id),
        )


def find_user_by_stripe_customer(customer_id: str) -> Optional[Dict[str, Any]]:
    if not customer_id:
        return None
    with _conn() as con:
        row = con.execute(
            "SELECT * FROM users WHERE stripe_customer_id = ?",
            (customer_id,),
        ).fetchone()
    return _row_to_user(row)


# ----- Influencer applications ------------------------------------------

def submit_influencer_application(*, email: str, full_name: Optional[str],
                                   social_handles: Optional[Dict[str, str]],
                                   promo_links: Optional[List[str]],
                                   notes: Optional[str]) -> int:
    email = (email or "").strip().lower()
    if not email or "@" not in email:
        raise ValueError("Invalid email address.")
    handles_json = json.dumps(social_handles or {}, ensure_ascii=False)
    promo_json = json.dumps([x for x in (promo_links or []) if x], ensure_ascii=False)
    now = int(time.time())
    with _conn() as con:
        cur = con.execute(
            """
            INSERT INTO influencer_applications
                (email, full_name, social_handles_json, promo_links_json, notes,
                 status, created_at)
            VALUES (?, ?, ?, ?, ?, 'pending', ?)
            """,
            (email, full_name, handles_json, promo_json, notes, now),
        )
    return cur.lastrowid


def list_influencer_applications(status: Optional[str] = None) -> List[Dict[str, Any]]:
    with _conn() as con:
        if status:
            rows = con.execute(
                "SELECT * FROM influencer_applications WHERE status = ? ORDER BY created_at DESC",
                (status,),
            ).fetchall()
        else:
            rows = con.execute(
                "SELECT * FROM influencer_applications ORDER BY created_at DESC",
            ).fetchall()
    out = []
    for r in rows:
        out.append({
            "id": r["id"],
            "email": r["email"],
            "full_name": r["full_name"],
            "social_handles": _json_or_default(r["social_handles_json"], {}),
            "promo_links": _json_or_default(r["promo_links_json"], []),
            "notes": r["notes"],
            "status": r["status"],
            "created_at": r["created_at"],
            "reviewed_at": r["reviewed_at"],
        })
    return out


def _json_or_default(raw, default):
    try:
        return json.loads(raw) if raw else default
    except Exception:
        return default
