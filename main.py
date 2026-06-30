from __future__ import annotations

import base64
import copy
import hmac
import json
import os
import secrets
import tempfile
import time
import uuid
from contextlib import asynccontextmanager
from datetime import timedelta
from pathlib import Path
from typing import Any, AsyncIterator

import argon2
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import x25519
from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from config_gen import ConfigError, generate_config, validate_reality_short_ids


BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "db.json"

SESSION_LIFETIME = timedelta(hours=24)
MAX_LOGIN_ATTEMPTS = 5
LOGIN_WINDOW_SECONDS = 15 * 60

_sessions: dict[str, dict[str, Any]] = {}
_login_attempts: dict[str, list[float]] = {}
_password_hasher = argon2.PasswordHasher()

DEFAULT_DB: dict[str, Any] = {
    "inbounds": [],
    "users": [],
    "routing_policies": [],
    "settings": {"log_level": "warning"},
}

DEFAULT_OUTBOUNDS: list[dict[str, Any]] = [
    {
        "id": "11111111-1111-4111-8111-111111111111",
        "tag": "direct",
        "type": "direct",
        "remark": "直连",
        "params": {},
    },
    {
        "id": "22222222-2222-4222-8222-222222222222",
        "tag": "block",
        "type": "block",
        "remark": "黑洞",
        "params": {},
    },
]

BUILTIN_OUTBOUND_IDS = {item["id"] for item in DEFAULT_OUTBOUNDS}
BUILTIN_OUTBOUND_TAGS = {item["tag"] for item in DEFAULT_OUTBOUNDS}

COLLECTIONS = {"inbounds", "users", "routing_policies"}
GLOBAL_COLLECTIONS = {"outbounds"}

def _get_client_ip(request: Request) -> str:
    cf_ip = request.headers.get("CF-Connecting-IP")
    if cf_ip:
        return cf_ip.strip()
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    real_ip = request.headers.get("X-Real-IP")
    if real_ip:
        return real_ip.strip()
    return request.client.host if request.client else "unknown"


_COOKIE_SECURE = os.environ.get("XRAY_COOKIE_SECURE", "false").lower() in {"1", "true", "yes"}


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    ensure_db()
    store = load_store()
    auth = store.get("auth", {})
    if not auth.get("require_auth"):
        if os.environ.get("XRAY_AUTH_REQUIRED", "").lower() in {"false", "0", "no", "off"}:
            print("警告: 登录保护已通过 XRAY_AUTH_REQUIRED=false 禁用")
        else:
            print("未启用登录保护，建议访问 /api/auth/setup-required 初始化管理员账号")
    else:
        print(f"登录保护已启用，管理员数: {len(auth.get('users', []))}")
    yield


app = FastAPI(title="Xray Manager", version="1.0.0", lifespan=lifespan)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    _purge_expired_sessions()
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Content-Security-Policy"] = "default-src 'self'"
    return response


# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------


def _set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key="session_id",
        value=token,
        httponly=True,
        secure=_COOKIE_SECURE,
        samesite="strict",
        max_age=int(SESSION_LIFETIME.total_seconds()),
        path="/",
    )


def _set_csrf_cookie(response: Response) -> str:
    token = secrets.token_urlsafe(32)
    response.set_cookie(
        key="csrf_token",
        value=token,
        httponly=False,
        secure=_COOKIE_SECURE,
        samesite="strict",
        max_age=int(SESSION_LIFETIME.total_seconds()),
        path="/",
    )
    return token


def _clear_session_cookie(response: Response) -> None:
    response.delete_cookie(key="session_id", path="/")
    response.delete_cookie(key="csrf_token", path="/")


def _create_session(user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    _sessions[token] = {
        "user_id": user_id,
        "expires_at": time.time() + SESSION_LIFETIME.total_seconds(),
    }
    return token


def _get_session(token: str | None) -> dict[str, Any] | None:
    if not token:
        return None
    session = _sessions.get(token)
    if not session:
        return None
    if session["expires_at"] < time.time():
        _sessions.pop(token, None)
        return None
    session["expires_at"] = time.time() + SESSION_LIFETIME.total_seconds()
    return session


def _destroy_session(token: str | None) -> None:
    if token:
        _sessions.pop(token, None)


def _purge_expired_sessions() -> None:
    now = time.time()
    expired = [token for token, session in _sessions.items() if session["expires_at"] < now]
    for token in expired:
        _sessions.pop(token, None)


def _hash_password(password: str) -> str:
    return _password_hasher.hash(password)


def _verify_password(password: str, password_hash: str) -> bool:
    try:
        _password_hasher.verify(password_hash, password)
        return True
    except argon2.exceptions.VerifyMismatchError:
        return False


def _validate_password(password: str) -> None:
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="密码至少 8 位")
    if not any(char.isalpha() for char in password):
        raise HTTPException(status_code=400, detail="密码至少包含一个字母")
    if not any(char.isdigit() for char in password):
        raise HTTPException(status_code=400, detail="密码至少包含一个数字")


def _normalize_auth(store: dict[str, Any]) -> None:
    store.setdefault("auth", {})
    auth = store["auth"]
    auth.setdefault("users", [])
    users = auth["users"]
    if not isinstance(users, list):
        auth["users"] = []
    env = os.environ.get("XRAY_AUTH_REQUIRED", "").lower()
    if env in {"false", "0", "no", "off"}:
        auth["require_auth"] = False
    else:
        # Configuration access must always be protected. Existing databases with
        # require_auth=false are migrated into the setup/login flow.
        auth["require_auth"] = True


def _find_auth_user(store: dict[str, Any], username: str) -> dict[str, Any] | None:
    username_lower = username.lower()
    for user in store.get("auth", {}).get("users", []):
        if str(user.get("username") or "").lower() == username_lower:
            return user
    return None


def _auth_required(request: Request) -> dict[str, Any]:
    store = load_store()
    auth = store.get("auth", {})
    if not auth.get("require_auth"):
        return {"user_id": None, "username": None, "is_authenticated": False}
    token = request.cookies.get("session_id")
    session = _get_session(token)
    if not session:
        raise HTTPException(status_code=401, detail="未登录或会话已过期")
    user = next(
        (user for user in auth.get("users", []) if user.get("id") == session["user_id"]),
        None,
    )
    if not user:
        raise HTTPException(status_code=401, detail="用户不存在")
    return {"user_id": user["id"], "username": user["username"], "is_authenticated": True}


def _csrf_required(request: Request) -> None:
    store = load_store()
    if not store.get("auth", {}).get("require_auth", False):
        return
    cookie = request.cookies.get("csrf_token")
    header = request.headers.get("X-CSRF-Token")
    if not cookie or not hmac.compare_digest(cookie, header or ""):
        raise HTTPException(status_code=403, detail="CSRF token 缺失或无效")


def _check_login_rate_limit(client_ip: str) -> None:
    now = time.time()
    attempts = _login_attempts.get(client_ip, [])
    attempts = [timestamp for timestamp in attempts if now - timestamp < LOGIN_WINDOW_SECONDS]
    _login_attempts[client_ip] = attempts
    if len(attempts) >= MAX_LOGIN_ATTEMPTS:
        raise HTTPException(status_code=429, detail="登录尝试过多，请 15 分钟后再试")


def _record_login_attempt(client_ip: str) -> None:
    _login_attempts.setdefault(client_ip, []).append(time.time())


@app.get("/api/auth/setup-required")
def auth_setup_required() -> dict[str, Any]:
    store = load_store()
    auth = store.get("auth", {})
    users = auth.get("users", [])
    return {"required": len(users) == 0, "require_auth": auth.get("require_auth", False)}


@app.post("/api/auth/register")
def auth_register(payload: dict[str, Any], response: Response) -> dict[str, Any]:
    store = load_store()
    auth = store.setdefault("auth", {})
    users = auth.setdefault("users", [])
    if users:
        raise HTTPException(status_code=403, detail="已有管理员账号，禁止注册")

    username = str(payload.get("username") or "").strip()
    password = str(payload.get("password") or "")
    if not username:
        raise HTTPException(status_code=400, detail="用户名不能为空")
    _validate_password(password)

    user_id = str(uuid.uuid4())
    now = int(time.time() * 1000)
    user = {
        "id": user_id,
        "username": username,
        "password_hash": _hash_password(password),
        "role": "admin",
        "created_at": now,
        "updated_at": now,
    }
    users.append(user)
    auth["require_auth"] = True
    save_db(store)

    token = _create_session(user_id)
    _set_session_cookie(response, token)
    _set_csrf_cookie(response)
    return {"success": True, "user": {"id": user_id, "username": username}}


@app.post("/api/auth/login")
def auth_login(request: Request, payload: dict[str, Any], response: Response) -> dict[str, Any]:
    client_ip = _get_client_ip(request)
    _check_login_rate_limit(client_ip)

    store = load_store()
    username = str(payload.get("username") or "").strip()
    password = str(payload.get("password") or "")
    user = _find_auth_user(store, username)

    if not user or not _verify_password(password, user.get("password_hash", "")):
        _record_login_attempt(client_ip)
        raise HTTPException(status_code=401, detail="用户名或密码错误")

    token = _create_session(user["id"])
    _set_session_cookie(response, token)
    _set_csrf_cookie(response)
    return {"success": True, "user": {"id": user["id"], "username": user["username"]}}


@app.post("/api/auth/logout")
def auth_logout(request: Request, response: Response) -> dict[str, Any]:
    _destroy_session(request.cookies.get("session_id"))
    _clear_session_cookie(response)
    return {"success": True}


@app.get("/api/auth/me")
def auth_me(request: Request) -> dict[str, Any]:
    user_info = _auth_required(request)
    return {"id": user_info["user_id"], "username": user_info["username"]}


# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------


def ensure_db() -> None:
    if not DB_PATH.exists():
        save_db(_new_store("默认 VPS", "", DEFAULT_DB))


def _default_workspace() -> dict[str, Any]:
    return json.loads(json.dumps(DEFAULT_DB, ensure_ascii=False))


def _default_outbounds() -> list[dict[str, Any]]:
    return json.loads(json.dumps(DEFAULT_OUTBOUNDS, ensure_ascii=False))


def _new_store(name: str, host: str = "", workspace: dict[str, Any] | None = None) -> dict[str, Any]:
    profile_id = str(uuid.uuid4())
    workspace_data = _normalize_workspace(workspace or _default_workspace())
    return {
        "active_vps_id": profile_id,
        "outbounds": _default_outbounds(),
        "vps_profiles": [
            {
                "id": profile_id,
                "name": name or "默认 VPS",
                "host": host,
                "remark": "",
                "data": workspace_data,
            }
        ],
    }


def _normalize_workspace(data: dict[str, Any]) -> dict[str, Any]:
    workspace = dict(data)
    for key, value in DEFAULT_DB.items():
        if workspace.get(key) is None:
            workspace[key] = json.loads(json.dumps(value, ensure_ascii=False))
    # Outbounds are now global; remove any leftover per-profile outbounds.
    workspace.pop("outbounds", None)
    workspace.setdefault("settings", {"log_level": "warning"})
    return migrate_legacy_auto_outbounds(workspace, persist=False)


def _infer_profile_name(workspace: dict[str, Any]) -> str:
    for inbound in workspace.get("inbounds", []):
        share_address = (inbound.get("params") or {}).get("shareAddress")
        if share_address:
            return str(share_address)
    return "默认 VPS"


def _migrate_outbounds_to_global(raw: dict[str, Any]) -> None:
    """Move per-profile outbounds to a shared global list, keeping first occurrence of each tag."""
    if "outbounds" in raw and isinstance(raw["outbounds"], list):
        # Already global; just ensure builtins exist.
        return

    seen_tags: set[str] = set(BUILTIN_OUTBOUND_TAGS)
    global_outbounds = _default_outbounds()

    # Legacy flat DB may have outbounds at top level before vps_profiles migration.
    top_outbounds = raw.pop("outbounds", None)
    if isinstance(top_outbounds, list):
        for item in top_outbounds:
            tag = str(item.get("tag") or "").strip()
            if tag and tag not in seen_tags:
                seen_tags.add(tag)
                global_outbounds.append(dict(item))

    for profile in raw.get("vps_profiles", []):
        data = profile.get("data") or {}
        profile_outbounds = data.pop("outbounds", None)
        if not isinstance(profile_outbounds, list):
            continue
        for item in profile_outbounds:
            tag = str(item.get("tag") or "").strip()
            if tag in BUILTIN_OUTBOUND_TAGS:
                continue
            if tag and tag not in seen_tags:
                seen_tags.add(tag)
                global_outbounds.append(dict(item))

    raw["outbounds"] = global_outbounds


def _normalize_store(raw: dict[str, Any]) -> dict[str, Any]:
    # Work on a deep copy so mutations don't affect the loaded raw dict,
    # otherwise the equality check below may incorrectly report no changes.
    raw = copy.deepcopy(raw)
    if "vps_profiles" not in raw:
        workspace = _normalize_workspace({key: raw.get(key) for key in DEFAULT_DB})
        # Migrate any top-level outbounds before wrapping into vps_profiles.
        _migrate_outbounds_to_global(raw)
        profile_id = str(uuid.uuid4())
        outbounds = raw.pop("outbounds", _default_outbounds())
        raw = {
            "active_vps_id": profile_id,
            "outbounds": outbounds,
            "vps_profiles": [
                {
                    "id": profile_id,
                    "name": _infer_profile_name(workspace),
                    "host": "",
                    "remark": "",
                    "data": workspace,
                }
            ],
        }
    _migrate_outbounds_to_global(raw)
    raw.setdefault("outbounds", _default_outbounds())
    raw.setdefault("vps_profiles", [])
    if not raw["vps_profiles"]:
        raw["vps_profiles"].append(_new_store("默认 VPS")["vps_profiles"][0])
    for profile in raw["vps_profiles"]:
        profile.setdefault("id", str(uuid.uuid4()))
        profile.setdefault("name", "未命名 VPS")
        profile.setdefault("host", "")
        profile.setdefault("remark", "")
        profile["data"] = _normalize_workspace(profile.get("data") or _default_workspace())
    profile_ids = {profile["id"] for profile in raw["vps_profiles"]}
    if raw.get("active_vps_id") not in profile_ids:
        raw["active_vps_id"] = raw["vps_profiles"][0]["id"]
    _normalize_auth(raw)
    return raw


def _write_raw_db(data: dict[str, Any]) -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=".db.", suffix=".json", dir=DB_PATH.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(tmp_name, DB_PATH)
    finally:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)


def load_store() -> dict[str, Any]:
    ensure_db()
    with DB_PATH.open("r", encoding="utf-8-sig") as handle:
        raw = json.load(handle)
    store = _normalize_store(raw)
    if store != raw:
        _write_raw_db(store)
    return store


def _active_profile(store: dict[str, Any]) -> dict[str, Any]:
    active_id = store.get("active_vps_id")
    for profile in store.get("vps_profiles", []):
        if profile.get("id") == active_id:
            return profile
    return store["vps_profiles"][0]


def load_db() -> dict[str, Any]:
    return _active_profile(load_store())["data"]


# Backward-compatible alias for modules using the old name.
load_database = load_db


def migrate_legacy_auto_outbounds(data: dict[str, Any], persist: bool = True) -> dict[str, Any]:
    auto_outbounds = [item for item in data.get("outbounds", []) if item.get("type") == "auto"]
    if not auto_outbounds:
        return data

    existing_policy_tags = {item.get("tag") for item in data.get("routing_policies", [])}
    for item in auto_outbounds:
        if item.get("tag") in existing_policy_tags:
            continue
        params = item.get("params", {})
        rules: list[dict[str, Any]] = []
        if params.get("block_ads"):
            rules.append({"id": str(uuid.uuid4()), "kind": "preset", "preset": "ads", "outbound_tag": "block", "enabled": True})
        if params.get("china_direct"):
            rules.append({"id": str(uuid.uuid4()), "kind": "preset", "preset": "cn", "outbound_tag": "direct", "enabled": True})
        if params.get("block_bt"):
            rules.append({"id": str(uuid.uuid4()), "kind": "preset", "preset": "bt", "outbound_tag": "block", "enabled": True})
        rules.append({"id": str(uuid.uuid4()), "kind": "fallback", "outbound_tag": params.get("fallback_tag", "direct"), "enabled": True})
        data.setdefault("routing_policies", []).append(
            {
                "id": item.get("id", str(uuid.uuid4())),
                "tag": item.get("tag"),
                "remark": item.get("remark", "自动分流"),
                "rules": rules,
                "params": {},
            }
        )

    data["outbounds"] = [item for item in data.get("outbounds", []) if item.get("type") != "auto"]
    if persist:
        save_db(data)
    return data


def save_db(data: dict[str, Any]) -> None:
    if "vps_profiles" in data:
        _write_raw_db(_normalize_store(data))
        return
    store = load_store()
    _active_profile(store)["data"] = _normalize_workspace(data)
    _write_raw_db(store)


def save_global_outbounds(outbounds: list[dict[str, Any]]) -> None:
    store = load_store()
    store["outbounds"] = outbounds
    _write_raw_db(_normalize_store(store))


def find_item(items: list[dict[str, Any]], item_id: str) -> dict[str, Any]:
    for item in items:
        if item.get("id") == item_id:
            return item
    raise HTTPException(status_code=404, detail="not found")


def normalize_item(payload: dict[str, Any]) -> dict[str, Any]:
    item = dict(payload)
    item.setdefault("id", str(uuid.uuid4()))
    item.setdefault("params", {})
    return item


def validate_outbound_item(item: dict[str, Any]) -> None:
    tag = str(item.get("tag") or "").strip()
    if not tag:
        raise HTTPException(status_code=400, detail="出站 Tag 不能为空")
    item["tag"] = tag
    if not item.get("remark"):
        item["remark"] = tag
    item_id = item.get("id")
    if item_id in BUILTIN_OUTBOUND_IDS and tag not in BUILTIN_OUTBOUND_TAGS:
        raise HTTPException(status_code=400, detail="内置出站 direct/block 的 Tag 不能修改")


def _list_from_value(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        return [part.strip() for part in value.split(",") if part.strip()]
    return [value]


def validate_inbound_item(item: dict[str, Any]) -> None:
    tag = str(item.get("tag") or "").strip()
    if not tag:
        raise HTTPException(status_code=400, detail="inbound Tag cannot be empty")
    port = item.get("port")
    if port is not None:
        try:
            port = int(port)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="端口必须是整数")
        if not (1 <= port <= 65535):
            raise HTTPException(status_code=400, detail="端口必须在 1-65535 范围内")
    if item.get("protocol") != "vless-reality":
        return

    params = item.setdefault("params", {})
    reality = params.setdefault("reality", {})
    try:
        reality["shortIds"] = validate_reality_short_ids(
            _list_from_value(reality.get("shortIds")),
            require_non_empty=True,
        )
    except ConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _validate_outbound_tag_unique(outbounds: list[dict[str, Any]], current_id: str | None = None) -> None:
    seen: set[str] = set()
    for item in outbounds:
        if current_id is not None and item.get("id") == current_id:
            continue
        tag = str(item.get("tag") or "").strip()
        if not tag:
            continue
        if tag in seen:
            raise HTTPException(status_code=400, detail=f"出站 Tag 重复: {tag}")
        seen.add(tag)


def _validate_outbound_tag_not_policy_tag(tag: str, exclude_vps_id: str | None = None) -> None:
    store = load_store()
    for profile in store.get("vps_profiles", []):
        if exclude_vps_id and profile.get("id") == exclude_vps_id:
            continue
        for policy in profile.get("data", {}).get("routing_policies", []):
            if policy.get("tag") == tag:
                raise HTTPException(
                    status_code=400,
                    detail=f"出站 Tag '{tag}' 与 VPS '{profile.get('name')}' 的分流策略 Tag 冲突",
                )


def replace_collection(name: str, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if name == "outbounds":
        normalized = [normalize_item(item) for item in items]
        for item in normalized:
            validate_outbound_item(item)
        _validate_outbound_tag_unique(normalized)
        save_global_outbounds(normalized)
        return normalized
    data = load_db()
    normalized = [normalize_item(item) for item in items]
    if name == "inbounds":
        for item in normalized:
            validate_inbound_item(item)
    data[name] = normalized
    if name == "inbounds":
        inbound_ids = {item["id"] for item in data["inbounds"]}
        data["users"] = [user for user in data["users"] if user.get("inbound_id") in inbound_ids]
    save_db(data)
    return data[name]


def delete_collection(name: str) -> dict[str, Any]:
    if name == "outbounds":
        store = load_store()
        for profile in store.get("vps_profiles", []):
            if profile.get("data", {}).get("users"):
                raise HTTPException(status_code=400, detail="仍有用户绑定出站，不能清空出站")
            for policy in profile.get("data", {}).get("routing_policies", []):
                if policy.get("rules"):
                    raise HTTPException(status_code=400, detail="仍有分流规则引用出站，不能清空出站")
        save_global_outbounds([item for item in DEFAULT_OUTBOUNDS])
        return {"success": True}
    data = load_db()
    if name == "inbounds":
        data["inbounds"] = []
        data["users"] = []
    elif name == "users":
        data["users"] = []
    elif name == "routing_policies":
        bound = _users_bound_to_policy_tags(data, {item.get("tag") for item in data.get("routing_policies", [])})
        if bound:
            raise HTTPException(status_code=400, detail="仍有用户绑定分流策略，不能清空分流")
        data["routing_policies"] = []
    save_db(data)
    return {"success": True}


def _users_bound_to_policy_tags(data: dict[str, Any], tags: set[str]) -> list[dict[str, Any]]:
    return [user for user in data.get("users", []) if user.get("outbound_tag") in tags]


def _profile_summary(profile: dict[str, Any], active_id: str | None = None) -> dict[str, Any]:
    workspace = profile.get("data") or {}
    return {
        "id": profile.get("id"),
        "name": profile.get("name", ""),
        "host": profile.get("host", ""),
        "remark": profile.get("remark", ""),
        "active": profile.get("id") == active_id,
        "counts": {
            "inbounds": len(workspace.get("inbounds", [])),
            "users": len(workspace.get("users", [])),
            "routing_policies": len(workspace.get("routing_policies", [])),
        },
    }


def _find_profile(store: dict[str, Any], profile_id: str) -> dict[str, Any]:
    for profile in store.get("vps_profiles", []):
        if profile.get("id") == profile_id:
            return profile
    raise HTTPException(status_code=404, detail="VPS 不存在")


@app.get("/api/vps", dependencies=[Depends(_auth_required)])
def list_vps_profiles() -> list[dict[str, Any]]:
    store = load_store()
    active_id = store.get("active_vps_id")
    return [_profile_summary(profile, active_id) for profile in store.get("vps_profiles", [])]


@app.post("/api/vps", dependencies=[Depends(_auth_required), Depends(_csrf_required)])
def create_vps_profile(payload: dict[str, Any]) -> dict[str, Any]:
    store = load_store()
    profile_id = str(uuid.uuid4())
    host = str(payload.get("host") or "").strip()
    profile = {
        "id": profile_id,
        "name": str(payload.get("name") or host or "未命名 VPS").strip(),
        "host": host,
        "remark": str(payload.get("remark") or "").strip(),
        "data": _normalize_workspace(DEFAULT_DB),
    }
    store.setdefault("vps_profiles", []).append(profile)
    store["active_vps_id"] = profile_id
    save_db(store)
    return _profile_summary(profile, store["active_vps_id"])


@app.put("/api/vps/{profile_id}", dependencies=[Depends(_auth_required), Depends(_csrf_required)])
def update_vps_profile(profile_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    store = load_store()
    profile = _find_profile(store, profile_id)
    if "name" in payload:
        profile["name"] = str(payload.get("name") or "").strip() or profile.get("name") or "未命名 VPS"
    if "host" in payload:
        profile["host"] = str(payload.get("host") or "").strip()
    if "remark" in payload:
        profile["remark"] = str(payload.get("remark") or "").strip()
    save_db(store)
    return _profile_summary(profile, store.get("active_vps_id"))


@app.delete("/api/vps/{profile_id}", dependencies=[Depends(_auth_required), Depends(_csrf_required)])
def delete_vps_profile(profile_id: str) -> dict[str, Any]:
    store = load_store()
    profiles = store.get("vps_profiles", [])
    if len(profiles) <= 1:
        raise HTTPException(status_code=400, detail="至少保留一台 VPS")
    _find_profile(store, profile_id)
    store["vps_profiles"] = [profile for profile in profiles if profile.get("id") != profile_id]
    if store.get("active_vps_id") == profile_id:
        store["active_vps_id"] = store["vps_profiles"][0]["id"]
    save_db(store)
    return {"success": True, "active_vps_id": store.get("active_vps_id")}


@app.post("/api/vps/{profile_id}/activate", dependencies=[Depends(_auth_required), Depends(_csrf_required)])
def activate_vps_profile(profile_id: str) -> dict[str, Any]:
    store = load_store()
    profile = _find_profile(store, profile_id)
    store["active_vps_id"] = profile_id
    save_db(store)
    return _profile_summary(profile, profile_id)


@app.get("/")
def index() -> FileResponse:
    return FileResponse(BASE_DIR / "static" / "index.html")


@app.get("/api/inbounds", dependencies=[Depends(_auth_required)])
def list_inbounds() -> list[dict[str, Any]]:
    return load_db()["inbounds"]


@app.post("/api/inbounds", dependencies=[Depends(_auth_required), Depends(_csrf_required)])
def create_inbound(payload: dict[str, Any]) -> dict[str, Any]:
    data = load_db()
    item = normalize_item(payload)
    validate_inbound_item(item)
    data["inbounds"].append(item)
    save_db(data)
    return item


@app.put("/api/inbounds", dependencies=[Depends(_auth_required), Depends(_csrf_required)])
def put_inbounds(payload: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return replace_collection("inbounds", payload)


@app.delete("/api/inbounds", dependencies=[Depends(_auth_required), Depends(_csrf_required)])
def clear_inbounds() -> dict[str, Any]:
    return delete_collection("inbounds")


@app.get("/api/inbounds/{item_id}", dependencies=[Depends(_auth_required)])
def get_inbound(item_id: str) -> dict[str, Any]:
    return find_item(load_db()["inbounds"], item_id)


@app.put("/api/inbounds/{item_id}", dependencies=[Depends(_auth_required), Depends(_csrf_required)])
def update_inbound(item_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    data = load_db()
    item = find_item(data["inbounds"], item_id)
    next_item = normalize_item({**payload, "id": item_id})
    validate_inbound_item(next_item)
    item.clear()
    item.update(next_item)
    save_db(data)
    return item


@app.delete("/api/inbounds/{item_id}", dependencies=[Depends(_auth_required), Depends(_csrf_required)])
def delete_inbound(item_id: str) -> dict[str, Any]:
    data = load_db()
    before = len(data["inbounds"])
    data["inbounds"] = [item for item in data["inbounds"] if item.get("id") != item_id]
    if len(data["inbounds"]) == before:
        raise HTTPException(status_code=404, detail="not found")
    removed_users = [user for user in data["users"] if user.get("inbound_id") == item_id]
    data["users"] = [user for user in data["users"] if user.get("inbound_id") != item_id]
    save_db(data)
    return {"success": True, "removed_users": len(removed_users)}


@app.get("/api/users", dependencies=[Depends(_auth_required)])
def list_users(inbound_id: str | None = Query(default=None)) -> list[dict[str, Any]]:
    users = load_db()["users"]
    if inbound_id:
        return [user for user in users if user.get("inbound_id") == inbound_id]
    return users


@app.post("/api/users", dependencies=[Depends(_auth_required), Depends(_csrf_required)])
def create_user(payload: dict[str, Any]) -> dict[str, Any]:
    data = load_db()
    item = normalize_item(payload)
    item.setdefault("credential", {})
    data["users"].append(item)
    save_db(data)
    return item


@app.put("/api/users", dependencies=[Depends(_auth_required), Depends(_csrf_required)])
def put_users(payload: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return replace_collection("users", payload)


@app.delete("/api/users", dependencies=[Depends(_auth_required), Depends(_csrf_required)])
def clear_users() -> dict[str, Any]:
    return delete_collection("users")


@app.get("/api/users/{item_id}", dependencies=[Depends(_auth_required)])
def get_user(item_id: str) -> dict[str, Any]:
    return find_item(load_db()["users"], item_id)


@app.put("/api/users/{item_id}", dependencies=[Depends(_auth_required), Depends(_csrf_required)])
def update_user(item_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    data = load_db()
    item = find_item(data["users"], item_id)
    item.clear()
    item.update(normalize_item({**payload, "id": item_id}))
    item.setdefault("credential", {})
    save_db(data)
    return item


@app.delete("/api/users/{item_id}", dependencies=[Depends(_auth_required), Depends(_csrf_required)])
def delete_user(item_id: str) -> dict[str, Any]:
    data = load_db()
    before = len(data["users"])
    data["users"] = [item for item in data["users"] if item.get("id") != item_id]
    if len(data["users"]) == before:
        raise HTTPException(status_code=404, detail="not found")
    save_db(data)
    return {"success": True}


def _db_for_config() -> dict[str, Any]:
    """Return active workspace merged with global outbounds for config generation."""
    store = load_store()
    data = dict(_active_profile(store)["data"])
    data["outbounds"] = list(store.get("outbounds", []))
    return data


@app.get("/api/outbounds", dependencies=[Depends(_auth_required)])
def list_outbounds() -> list[dict[str, Any]]:
    return load_store().get("outbounds", [])


@app.post("/api/outbounds", dependencies=[Depends(_auth_required), Depends(_csrf_required)])
def create_outbound(payload: dict[str, Any]) -> dict[str, Any]:
    store = load_store()
    item = normalize_item(payload)
    validate_outbound_item(item)
    tag = str(item.get("tag") or "").strip()
    _validate_outbound_tag_not_policy_tag(tag)
    outbounds = list(store.get("outbounds", []))
    if any(str(o.get("tag") or "").strip() == tag for o in outbounds):
        raise HTTPException(status_code=400, detail=f"出站 Tag 已存在: {tag}")
    outbounds.append(item)
    save_global_outbounds(outbounds)
    return item


@app.put("/api/outbounds", dependencies=[Depends(_auth_required), Depends(_csrf_required)])
def put_outbounds(payload: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return replace_collection("outbounds", payload)


@app.delete("/api/outbounds", dependencies=[Depends(_auth_required), Depends(_csrf_required)])
def clear_outbounds() -> dict[str, Any]:
    return delete_collection("outbounds")


@app.get("/api/outbounds/{item_id}", dependencies=[Depends(_auth_required)])
def get_outbound(item_id: str) -> dict[str, Any]:
    return find_item(load_store().get("outbounds", []), item_id)


@app.put("/api/outbounds/{item_id}", dependencies=[Depends(_auth_required), Depends(_csrf_required)])
def update_outbound(item_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    store = load_store()
    outbounds = list(store.get("outbounds", []))
    item = find_item(outbounds, item_id)
    next_item = normalize_item({**payload, "id": item_id})
    if item_id in BUILTIN_OUTBOUND_IDS:
        # Reject any modification to built-in outbound except remark preservation.
        next_tag = str(next_item.get("tag") or "").strip()
        if next_tag not in BUILTIN_OUTBOUND_TAGS:
            raise HTTPException(status_code=400, detail="内置出站 direct/block 的 Tag 不能修改")
        next_type = next_item.get("type")
        if next_type not in BUILTIN_OUTBOUND_TAGS:
            raise HTTPException(status_code=400, detail="内置出站 direct/block 的类型不能修改")
    validate_outbound_item(next_item)
    new_tag = str(next_item.get("tag") or "").strip()
    old_tag = str(item.get("tag") or "").strip()
    if new_tag != old_tag:
        _validate_outbound_tag_not_policy_tag(new_tag)
        if any(str(o.get("tag") or "").strip() == new_tag and o.get("id") != item_id for o in outbounds):
            raise HTTPException(status_code=400, detail=f"出站 Tag 已存在: {new_tag}")
    item.clear()
    item.update(next_item)
    save_global_outbounds(outbounds)
    return item


@app.delete("/api/outbounds/{item_id}", dependencies=[Depends(_auth_required), Depends(_csrf_required)])
def delete_outbound(item_id: str) -> dict[str, Any]:
    if item_id in BUILTIN_OUTBOUND_IDS:
        raise HTTPException(status_code=400, detail="内置出站 direct/block 不能删除")
    store = load_store()
    outbounds = list(store.get("outbounds", []))
    outbound = find_item(outbounds, item_id)
    tag = outbound.get("tag")
    for profile in store.get("vps_profiles", []):
        bound_users = [user for user in profile.get("data", {}).get("users", []) if user.get("outbound_tag") == tag]
        if bound_users:
            raise HTTPException(
                status_code=400,
                detail=f"该出站仍有用户绑定（VPS: {profile.get('name')}），请先改绑后再删除",
            )
        for policy in profile.get("data", {}).get("routing_policies", []):
            for rule in policy.get("rules", []):
                if rule.get("outbound_tag") == tag:
                    raise HTTPException(
                        status_code=400,
                        detail=f"该出站仍被分流规则引用（VPS: {profile.get('name')}）",
                    )
    save_global_outbounds([item for item in outbounds if item.get("id") != item_id])
    return {"success": True}


@app.get("/api/routing-policies", dependencies=[Depends(_auth_required)])
def list_routing_policies() -> list[dict[str, Any]]:
    return load_db().get("routing_policies", [])


@app.post("/api/routing-policies", dependencies=[Depends(_auth_required), Depends(_csrf_required)])
def create_routing_policy(payload: dict[str, Any]) -> dict[str, Any]:
    data = load_db()
    item = normalize_item(payload)
    item.setdefault("rules", [])
    data.setdefault("routing_policies", []).append(item)
    save_db(data)
    return item


@app.put("/api/routing-policies", dependencies=[Depends(_auth_required), Depends(_csrf_required)])
def put_routing_policies(payload: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return replace_collection("routing_policies", payload)


@app.delete("/api/routing-policies", dependencies=[Depends(_auth_required), Depends(_csrf_required)])
def clear_routing_policies() -> dict[str, Any]:
    return delete_collection("routing_policies")


@app.get("/api/routing-policies/{item_id}", dependencies=[Depends(_auth_required)])
def get_routing_policy(item_id: str) -> dict[str, Any]:
    return find_item(load_db().get("routing_policies", []), item_id)


@app.put("/api/routing-policies/{item_id}", dependencies=[Depends(_auth_required), Depends(_csrf_required)])
def update_routing_policy(item_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    data = load_db()
    item = find_item(data.setdefault("routing_policies", []), item_id)
    item.clear()
    item.update(normalize_item({**payload, "id": item_id}))
    item.setdefault("rules", [])
    save_db(data)
    return item


@app.delete("/api/routing-policies/{item_id}", dependencies=[Depends(_auth_required), Depends(_csrf_required)])
def delete_routing_policy(item_id: str) -> dict[str, Any]:
    data = load_db()
    policy = find_item(data.setdefault("routing_policies", []), item_id)
    tag = policy.get("tag")
    if _users_bound_to_policy_tags(data, {tag}):
        raise HTTPException(status_code=400, detail="该分流策略仍有用户绑定，请先改绑后再删除")
    data["routing_policies"] = [item for item in data["routing_policies"] if item.get("id") != item_id]
    save_db(data)
    return {"success": True}


@app.get("/api/config/preview", dependencies=[Depends(_auth_required)])
def preview_config() -> dict[str, Any]:
    try:
        return generate_config(_db_for_config())
    except ConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/apply", dependencies=[Depends(_auth_required), Depends(_csrf_required)])
def apply_config() -> dict[str, Any]:
    """Return the generated config without touching the local Xray service.

    The endpoint name is kept for UI/API compatibility, but this app is a
    configuration generator only: it never writes /etc/xray/config.json and
    never calls systemctl reload xray.
    """

    try:
        config = generate_config(_db_for_config())
    except ConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"success": True, "config": config}


@app.get("/api/status", dependencies=[Depends(_auth_required)])
def status() -> dict[str, Any]:
    return {
        "running": None,
        "status": "config-generator-only",
        "message": "仅生成配置，不读取或控制本机 Xray 服务",
    }


@app.get("/api/util/x25519", dependencies=[Depends(_auth_required)])
def util_x25519() -> dict[str, Any]:
    private = x25519.X25519PrivateKey.generate()
    public = private.public_key()
    private_raw = private.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_raw = public.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return {
        "privateKey": _xray_base64(private_raw),
        "publicKey": _xray_base64(public_raw),
    }


@app.get("/api/util/uuid", dependencies=[Depends(_auth_required)])
def util_uuid() -> dict[str, str]:
    return {"uuid": str(uuid.uuid4())}


@app.get("/api/util/ss-psk", dependencies=[Depends(_auth_required)])
def util_ss_psk(bits: int = Query(default=128)) -> dict[str, Any]:
    if bits not in (128, 256):
        raise HTTPException(status_code=400, detail="bits must be 128 or 256")
    byte_len = bits // 8
    return {
        "bits": bits,
        "psk": base64.b64encode(os.urandom(byte_len)).decode("ascii"),
    }


def _xray_base64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
