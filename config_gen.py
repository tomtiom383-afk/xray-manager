"""Generate Xray-core config.json from the lightweight manager database.

The database intentionally stores business objects (inbounds, users, outbounds
and routing policies), not a raw Xray template. This module is the only place
that turns those objects into Xray's wire format, so the user-level routing
logic is centralized and easy to audit.
"""

from __future__ import annotations

from collections import defaultdict
import random
import string
from typing import Any


JsonDict = dict[str, Any]


class ConfigError(ValueError):
    """Raised when db.json contains references that cannot become Xray config."""


def generate_config(db: JsonDict) -> JsonDict:
    """Return a complete Xray config dict.

    Important behavior:
    - Inbound clients are generated dynamically from db["users"] by inbound_id.
    - Routing policies are separate from outbounds. A policy expands into Xray
      routing rules scoped by Xray user email, in the same top-to-bottom order
      stored in db["routing_policies"][].rules.
    - User-level routing uses Xray's routing.rules[].user field. For protocols
      that carry an email (VLESS/VMess/Trojan/SS clients), Xray can match the
      authenticated user and bind that traffic to the selected outbound.
    """

    inbounds = db.get("inbounds", [])
    users = db.get("users", [])
    outbounds = db.get("outbounds", [])
    routing_policies = db.get("routing_policies", [])
    settings = db.get("settings", {})

    inbound_by_id = _index_by_id(inbounds, "inbound")
    outbound_by_tag = _index_by_tag(outbounds, "outbound")
    policy_by_tag = _index_by_tag(routing_policies, "routing policy")
    duplicated_strategy_tags = set(outbound_by_tag) & set(policy_by_tag)
    if duplicated_strategy_tags:
        raise ConfigError(
            "routing policy tag cannot duplicate outbound tag: "
            + ", ".join(sorted(duplicated_strategy_tags))
        )

    _validate_user_refs(users, inbound_by_id, outbound_by_tag, policy_by_tag)
    _validate_routing_policies(routing_policies, outbound_by_tag)

    real_outbounds = [item for item in outbounds if item.get("type") != "auto"]

    return {
        "log": {"loglevel": settings.get("log_level", "warning")},
        "inbounds": [_build_inbound(item, users) for item in inbounds],
        "outbounds": [_build_outbound(item) for item in real_outbounds],
        "routing": {
            "domainStrategy": "AsIs",
            "rules": _build_user_routing_rules(users, outbound_by_tag, policy_by_tag),
        },
    }


def _index_by_id(items: list[JsonDict], label: str) -> dict[str, JsonDict]:
    result: dict[str, JsonDict] = {}
    for item in items:
        item_id = item.get("id")
        if not item_id:
            raise ConfigError(f"{label} is missing id")
        if item_id in result:
            raise ConfigError(f"duplicate {label} id: {item_id}")
        result[item_id] = item
    return result


def _index_by_tag(items: list[JsonDict], label: str) -> dict[str, JsonDict]:
    result: dict[str, JsonDict] = {}
    for item in items:
        tag = item.get("tag")
        if not tag:
            raise ConfigError(f"{label} is missing tag")
        if tag in result:
            raise ConfigError(f"duplicate {label} tag: {tag}")
        result[tag] = item
    return result


def _validate_user_refs(
    users: list[JsonDict],
    inbound_by_id: dict[str, JsonDict],
    outbound_by_tag: dict[str, JsonDict],
    policy_by_tag: dict[str, JsonDict],
) -> None:
    for user in users:
        email = user.get("email") or user.get("id") or "<unknown>"
        inbound_id = user.get("inbound_id")
        outbound_tag = user.get("outbound_tag")
        if inbound_id not in inbound_by_id:
            raise ConfigError(f"user {email} references missing inbound_id: {inbound_id}")
        if outbound_tag not in outbound_by_tag and outbound_tag not in policy_by_tag:
            raise ConfigError(f"user {email} references missing strategy tag: {outbound_tag}")


def _validate_routing_policies(
    routing_policies: list[JsonDict],
    outbound_by_tag: dict[str, JsonDict],
) -> None:
    for policy in routing_policies:
        tag = policy.get("tag")
        for index, rule in enumerate(policy.get("rules", []), start=1):
            if rule.get("enabled", True) is False:
                continue
            outbound_tag = rule.get("outbound_tag")
            if outbound_tag not in outbound_by_tag:
                raise ConfigError(
                    f"routing policy {tag} rule #{index} references missing outbound_tag: {outbound_tag}"
                )


def _build_inbound(inbound: JsonDict, users: list[JsonDict]) -> JsonDict:
    protocol = inbound.get("protocol")
    params = inbound.get("params", {})
    inbound_users = [user for user in users if user.get("inbound_id") == inbound.get("id")]

    if protocol == "vless-reality":
        reality = params.get("reality", {})
        # Accept both old "dest" and current "target" field names.
        if "dest" not in reality and "target" in reality:
            reality["dest"] = reality["target"]
        target = reality.get("target") or reality.get("dest") or ""
        short_ids = validate_reality_short_ids(
            _as_list(reality.get("shortIds") or []),
            require_non_empty=True,
        )
        flow = params.get("flow", "xtls-rprx-vision")
        network = params.get("network", "raw")
        clients = []
        for user in inbound_users:
            client = {
                "id": user.get("credential", {}).get("uuid"),
                "email": user.get("email"),
            }
            if flow:
                client["flow"] = flow
            client.update(_xui_client_meta(user))
            clients.append(client)

        settings: JsonDict = {
            "clients": clients,
            "decryption": "none",
            "encryption": params.get("encryption", "none"),
        }

        stream_settings: JsonDict = {"network": network}
        if network == "raw":
            stream_settings["rawSettings"] = {
                "acceptProxyProtocol": bool(params.get("acceptProxyProtocol", False)),
                "header": {"type": params.get("headerType", "none")},
            }
        elif network == "tcp":
            stream_settings["tcpSettings"] = {
                "acceptProxyProtocol": bool(params.get("acceptProxyProtocol", False)),
                "header": {"type": params.get("headerType", "none")},
            }
        stream_settings.update(
            {
                "security": "reality",
                "realitySettings": {
                "show": bool(reality.get("show", False)),
                "xver": int(reality.get("xver", 0)),
                "target": target,
                "serverNames": _as_list(reality.get("serverNames") or []),
                "privateKey": reality.get("privateKey", ""),
                "minClientVer": reality.get("minClientVer", ""),
                "maxClientVer": reality.get("maxClientVer", ""),
                "maxTimeDiff": int(reality.get("maxTimeDiff", reality.get("maxTimediff", 0)) or 0),
                "shortIds": short_ids,
                "mldsa65Seed": reality.get("mldsa65Seed", ""),
                # 3x-ui keeps the corresponding client-side values here so the
                # panel can copy client parameters from the same inbound record.
                # Xray server-side REALITY uses privateKey; publicKey/fingerprint
                # are for generated client snippets.
                "settings": {
                    "publicKey": reality.get("publicKey", ""),
                    "fingerprint": reality.get("fingerprint", "chrome"),
                    "serverName": reality.get("clientServerName", ""),
                    "spiderX": reality.get("spiderX", "/"),
                    "mldsa65Verify": reality.get("mldsa65Verify", ""),
                },
                },
            }
        )

        sniffing = params.get("sniffing", {})
        sniffing_settings: JsonDict = {
            "enabled": bool(sniffing.get("enabled", True)),
            "destOverride": sniffing.get("destOverride", ["http", "tls", "quic", "fakedns"]),
        }
        if sniffing.get("metadataOnly"):
            sniffing_settings["metadataOnly"] = True
        if sniffing.get("routeOnly"):
            sniffing_settings["routeOnly"] = True
        if sniffing.get("ipsExcluded"):
            sniffing_settings["ipsExcluded"] = _as_list(sniffing.get("ipsExcluded"))
        if sniffing.get("domainsExcluded"):
            sniffing_settings["domainsExcluded"] = _as_list(sniffing.get("domainsExcluded"))

        return {
            "listen": inbound.get("listen", "0.0.0.0"),
            "port": int(inbound.get("port", 443)),
            "protocol": "vless",
            "tag": inbound.get("tag"),
            "settings": settings,
            "sniffing": sniffing_settings,
            "streamSettings": stream_settings,
        }

    if protocol == "vless-tls":
        tls = params.get("tls", {})
        clients = [
            {
                "id": user.get("credential", {}).get("uuid"),
                "email": user.get("email"),
                **({"flow": params.get("flow")} if params.get("flow") else {}),
            }
            for user in inbound_users
        ]
        return {
            "listen": inbound.get("listen", "0.0.0.0"),
            "port": int(inbound.get("port", 443)),
            "protocol": "vless",
            "settings": {"clients": clients, "decryption": "none"},
            "streamSettings": {
                "network": params.get("network", "raw"),
                "security": "tls",
                "tlsSettings": _tls_settings(tls),
            },
            "tag": inbound.get("tag"),
        }

    if protocol == "shadowsocks-2022":
        method = params.get("method", "2022-blake3-aes-128-gcm")
        clients = [
            {
                "email": user.get("email"),
                "password": user.get("credential", {}).get("password"),
            }
            for user in inbound_users
        ]
        return {
            "listen": inbound.get("listen", "0.0.0.0"),
            "port": int(inbound.get("port", 8388)),
            "protocol": "shadowsocks",
            "settings": {
                "method": method,
                "password": params.get("psk", ""),
                "network": params.get("network", "tcp,udp"),
                "clients": clients,
            },
            "tag": inbound.get("tag"),
        }

    if protocol == "trojan":
        clients = [
            {
                "password": user.get("credential", {}).get("password"),
                "email": user.get("email"),
            }
            for user in inbound_users
        ]
        return {
            "listen": inbound.get("listen", "0.0.0.0"),
            "port": int(inbound.get("port", 443)),
            "protocol": "trojan",
            "settings": {"clients": clients},
            "streamSettings": {
                "network": params.get("network", "raw"),
                "security": "tls",
                "tlsSettings": _tls_settings(params.get("tls", {})),
            },
            "tag": inbound.get("tag"),
        }

    if protocol == "vmess-ws-tls":
        clients = [
            {
                "id": user.get("credential", {}).get("uuid"),
                "email": user.get("email"),
                "alterId": 0,
            }
            for user in inbound_users
        ]
        return {
            "listen": inbound.get("listen", "0.0.0.0"),
            "port": int(inbound.get("port", 443)),
            "protocol": "vmess",
            "settings": {"clients": clients},
            "streamSettings": {
                "network": "ws",
                "security": "tls",
                "tlsSettings": _tls_settings(params.get("tls", {})),
                "wsSettings": {"path": params.get("path", "/ws")},
            },
            "tag": inbound.get("tag"),
            "tag": inbound.get("tag"),
        }

    raise ConfigError(f"unsupported inbound protocol: {protocol}")


def _build_outbound(outbound: JsonDict) -> JsonDict:
    outbound_type = outbound.get("type")
    tag = outbound.get("tag")
    params = outbound.get("params", {})

    if outbound_type == "direct":
        return {"protocol": "freedom", "tag": tag}

    if outbound_type == "block":
        return {"protocol": "blackhole", "tag": tag}

    if outbound_type == "vless":
        stream = _stream_settings(params)
        user = {
            "id": params.get("uuid", ""),
            "encryption": "none",
        }
        if params.get("flow"):
            user["flow"] = params.get("flow")
        return {
            "protocol": "vless",
            "settings": {
                "vnext": [
                    {
                        "address": params.get("address", ""),
                        "port": int(params.get("port", 443)),
                        "users": [user],
                    }
                ]
            },
            "streamSettings": stream,
            "tag": tag,
        }

    if outbound_type == "trojan":
        return {
            "protocol": "trojan",
            "settings": {
                "servers": [
                    {
                        "address": params.get("address", ""),
                        "port": int(params.get("port", 443)),
                        "password": params.get("password", ""),
                    }
                ]
            },
            "streamSettings": _stream_settings(params),
            "tag": tag,
        }

    if outbound_type == "shadowsocks":
        return {
            "protocol": "shadowsocks",
            "settings": {
                "servers": [
                    {
                        "address": params.get("address", ""),
                        "port": int(params.get("port", 8388)),
                        "method": params.get("method", "2022-blake3-aes-128-gcm"),
                        "password": params.get("password", ""),
                    }
                ]
            },
            "tag": tag,
        }

    if outbound_type == "vmess":
        return {
            "protocol": "vmess",
            "settings": {
                "vnext": [
                    {
                        "address": params.get("address", ""),
                        "port": int(params.get("port", 443)),
                        "users": [
                            {
                                "id": params.get("uuid", ""),
                                "alterId": int(params.get("alterId", 0)),
                                "security": params.get("security_method", "auto"),
                            }
                        ],
                    }
                ]
            },
            "streamSettings": _stream_settings(params),
            "tag": tag,
        }

    raise ConfigError(f"unsupported outbound type: {outbound_type}")


def _xui_client_meta(user: JsonDict) -> JsonDict:
    params = user.get("params", {})
    email = user.get("email", "")
    stable_seed = user.get("id") or email or user.get("credential", {}).get("uuid", "")
    rng = random.Random(str(stable_seed))
    return {
        "limitIp": int(params.get("limitIp", 0) or 0),
        "totalGB": int(params.get("totalGB", 0) or 0),
        "expiryTime": int(params.get("expiryTime", 0) or 0),
        "enable": bool(params.get("enable", True)),
        "tgId": int(params.get("tgId", 0) or 0),
        "subId": params.get("subId") or ''.join(rng.choices(string.ascii_lowercase + string.digits, k=16)),
        "comment": params.get("comment", user.get("remark", "")),
        "reset": int(params.get("reset", 0) or 0),
        "created_at": int(params.get("created_at") or 0),
        "updated_at": int(params.get("updated_at") or 0),
    }


def _build_user_routing_rules(
    users: list[JsonDict],
    outbound_by_tag: dict[str, JsonDict],
    policy_by_tag: dict[str, JsonDict],
) -> list[JsonDict]:
    """Build routing.rules for user-level outbound binding.

    Xray can match authenticated users by the client "email" field. The manager
    stores each user's selected strategy in user["outbound_tag"]. For backward
    compatibility that field may point directly to a real outbound tag or to a
    routing policy tag.

    Rule order matters:
    - Policy rules are expanded exactly in the order shown in the UI.
    - A fallback rule catches all remaining traffic for the policy's users, so
      operators should normally place it last.
    - Users bound directly to a real outbound still get one simple user rule.
    - Traffic that does not match any explicit user rule is left to Xray's
      default behavior: use the first real outbound in the config.
    """

    grouped: dict[str, list[str]] = defaultdict(list)
    for user in users:
        email = user.get("email")
        tag = user.get("outbound_tag")
        if email and tag:
            grouped[tag].append(email)

    rules: list[JsonDict] = []
    for strategy_tag, emails in grouped.items():
        if strategy_tag in policy_by_tag:
            for rule in policy_by_tag[strategy_tag].get("rules", []):
                if rule.get("enabled", True) is False:
                    continue
                rules.extend(_expand_policy_rule(rule, emails))
        else:
            rules.append(
                {
                    "type": "field",
                    "user": emails,
                    "outboundTag": strategy_tag,
                }
            )

    return rules


def _expand_policy_rule(rule: JsonDict, emails: list[str]) -> list[JsonDict]:
    outbound_tag = rule.get("outbound_tag")
    kind = rule.get("kind", "preset")
    preset = rule.get("preset", "")
    base = {"type": "field", "user": emails, "outboundTag": outbound_tag}

    if kind == "fallback":
        return [base]

    if kind == "manual":
        expanded: list[JsonDict] = []
        domains = _as_list(rule.get("domain"))
        ips = _as_list(rule.get("ip"))
        protocols = _as_list(rule.get("protocol"))
        if domains:
            expanded.append({**base, "domain": domains})
        if ips:
            expanded.append({**base, "ip": ips})
        if protocols:
            expanded.append({**base, "protocol": protocols})
        return expanded or [base]

    if preset == "cn":
        return [
            {**base, "domain": ["geosite:cn"]},
            {**base, "ip": ["geoip:cn", "geoip:private"]},
        ]

    if preset == "ai":
        return [
            {
                **base,
                "domain": [
                    # OpenAI / ChatGPT
                    "domain:openai.com",
                    "domain:chatgpt.com",
                    "domain:oaistatic.com",
                    "domain:oaiusercontent.com",
                    # Anthropic / Claude
                    "domain:anthropic.com",
                    "domain:claude.ai",
                    # Google AI
                    "domain:gemini.google.com",
                    "domain:generativelanguage.googleapis.com",
                    "domain:ai.google.dev",
                    # Perplexity
                    "domain:perplexity.ai",
                    # Poe
                    "domain:poe.com",
                    # DeepSeek
                    "domain:deepseek.com",
                    "domain:deepseek.ai",
                    # GitHub Copilot
                    "domain:githubcopilot.com",
                    # Bing / Microsoft Copilot
                    "domain:bing.com",
                    "domain:copilot.microsoft.com",
                    # Grok
                    "domain:x.ai",
                    "domain:grok.com",
                    # Tabnine
                    "domain:tabnine.com",
                ],
            }
        ]

    if preset == "ads":
        return [{**base, "domain": ["geosite:category-ads-all"]}]

    if preset == "private":
        return [{**base, "ip": ["geoip:private"]}]

    if preset == "bt":
        return [{**base, "protocol": ["bittorrent"]}]

    return [base]


def _stream_settings(params: JsonDict) -> JsonDict:
    network = params.get("network", "raw")
    security = params.get("security", "none")
    stream: JsonDict = {"network": network, "security": security}

    if security == "reality":
        reality = params.get("reality", {})
        # Newer Xray REALITY outbound config uses "password" for the public key.
        # The UI/database may still call it publicKey because that is easier for
        # operators to recognize, but generated Xray config writes "password".
        stream["realitySettings"] = {
            "show": False,
            "fingerprint": reality.get("fingerprint", "chrome"),
            "serverName": reality.get("serverName", ""),
            "password": reality.get("publicKey", reality.get("password", "")),
            "shortId": reality.get("shortId", ""),
            "spiderX": reality.get("spiderX", ""),
        }
    elif security == "tls":
        stream["tlsSettings"] = {
            "serverName": params.get("serverName", params.get("address", "")),
            "allowInsecure": bool(params.get("allowInsecure", False)),
        }

    if network == "ws":
        stream["wsSettings"] = {"path": params.get("path", "/ws")}
    elif network == "grpc":
        stream["grpcSettings"] = {"serviceName": params.get("serviceName", "")}

    return stream


def _tls_settings(tls: JsonDict) -> JsonDict:
    certificates = []
    cert_file = tls.get("certificateFile")
    key_file = tls.get("keyFile")
    if cert_file or key_file:
        certificates.append(
            {
                "certificateFile": cert_file or "",
                "keyFile": key_file or "",
            }
        )
    result: JsonDict = {
        "serverName": tls.get("serverName", ""),
    }
    if certificates:
        result["certificates"] = certificates
    return result


def _as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    return [value]


def validate_reality_short_ids(short_ids: list[Any], require_non_empty: bool = False) -> list[str]:
    result = [str(item).strip() for item in short_ids if str(item).strip()]
    for index, short_id in enumerate(result):
        if len(short_id) > 16 or len(short_id) % 2 != 0:
            raise ConfigError(
                f"REALITY shortIds[{index}] must be even-length hex with 2-16 characters: {short_id}"
            )
        if any(char not in string.hexdigits for char in short_id):
            raise ConfigError(f"REALITY shortIds[{index}] must contain only hex characters: {short_id}")
    if require_non_empty and not result:
        raise ConfigError("REALITY shortIds must include at least one non-empty short ID")
    return result


def _validate_reality_short_ids(short_ids: list[Any]) -> list[str]:
    return validate_reality_short_ids(short_ids)
