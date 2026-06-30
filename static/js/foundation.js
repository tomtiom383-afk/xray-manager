// foundation.js — state, API, auth, utilities, client link generation, share link parsing

const state = {
  view: 'servers',
  vpsProfiles: [],
  activeVpsId: '',
  inbounds: [],
  users: [],
  outbounds: [],
  routingPolicies: [],
  preview: null,
  status: { running: null, status: 'config-generator-only' },
  filterInbound: '',
  auth: {
    isLoggedIn: false,
    user: null,
    setupRequired: false,
    requireAuth: false,
    checking: true
  }
};

const BUILTIN_OUTBOUND_IDS = new Set(['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']);

const serverNavItems = [
  ['servers', '🖥️', 'VPS 管理']
];

const configNavItems = [
  ['inbounds', '🔌', '入站管理'],
  ['users', '👥', '用户管理'],
  ['outbounds', '🚀', '出站管理'],
  ['routing', '🧭', '分流管理'],
  ['preview', '📋', '配置预览']
];

// ---------------------------------------------------------------------------
// API & auth
// ---------------------------------------------------------------------------

function getCsrfToken() {
  const match = document.cookie.match(/(?:^|; )csrf_token=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : '';
}

const api = async (path, options = {}) => {
  const init = { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...options };
  if (init.body && typeof init.body !== 'string') init.body = JSON.stringify(init.body);
  if (init.method && init.method !== 'GET' && init.method !== 'HEAD') {
    init.headers = { ...init.headers, 'X-CSRF-Token': getCsrfToken() };
  }
  const res = await fetch(path, init);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    if (res.status === 401 && state.auth.requireAuth && !path.startsWith('/api/auth/')) {
      state.auth.isLoggedIn = false;
      state.auth.user = null;
      render();
    }
    const msg = data && data.detail ? data.detail : (text || res.statusText);
    throw new Error(msg);
  }
  return data;
};

async function initAuth() {
  try {
    const setup = await api('/api/auth/setup-required');
    state.auth.requireAuth = true;
    state.auth.setupRequired = Boolean(setup.required);
    if (state.auth.setupRequired) {
      state.auth.isLoggedIn = false;
      state.auth.user = null;
      return;
    }
    try {
      const me = await api('/api/auth/me');
      if (me.id) {
        state.auth.isLoggedIn = true;
        state.auth.user = me;
      } else {
        state.auth.isLoggedIn = false;
        state.auth.user = null;
      }
    } catch {
      state.auth.isLoggedIn = false;
      state.auth.user = null;
    }
  } catch (err) {
    state.auth.isLoggedIn = false;
    state.auth.user = null;
  } finally {
    state.auth.checking = false;
    if (state.auth.isLoggedIn) await refreshAll();
    else render();
  }
}

async function login(username, password) {
  const res = await api('/api/auth/login', { method: 'POST', body: { username, password } });
  state.auth.isLoggedIn = true;
  state.auth.user = res.user;
  state.auth.requireAuth = true;
  state.auth.setupRequired = false;
  await refreshAll();
  render();
}

async function register(username, password) {
  const res = await api('/api/auth/register', { method: 'POST', body: { username, password } });
  state.auth.isLoggedIn = true;
  state.auth.user = res.user;
  state.auth.requireAuth = true;
  state.auth.setupRequired = false;
  await refreshAll();
  render();
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  state.auth.isLoggedIn = false;
  state.auth.user = null;
  render();
}

// ---------------------------------------------------------------------------
// Data access helpers
// ---------------------------------------------------------------------------

function getInbound(id) { return state.inbounds.find(item => item.id === id); }
function getUser(id) { return state.users.find(item => item.id === id); }
function getOutbound(id) { return state.outbounds.find(item => item.id === id); }
function getOutboundByTag(tag) { return state.outbounds.find(item => item.tag === tag); }
function getRoutingPolicy(id) { return state.routingPolicies.find(item => item.id === id); }
function getRoutingPolicyByTag(tag) { return state.routingPolicies.find(item => item.tag === tag); }
function getStrategyByTag(tag) { return getOutboundByTag(tag) || getRoutingPolicyByTag(tag); }
function filteredUsers() { return state.filterInbound ? state.users.filter(user => user.inbound_id === state.filterInbound) : state.users; }
function getVpsProfile(id) { return state.vpsProfiles.find(item => item.id === id); }

// ---------------------------------------------------------------------------
// String / data utilities
// ---------------------------------------------------------------------------

function splitList(value) { return String(value || '').split(',').map(item => item.trim()).filter(Boolean); }
function setValue(id, value) { const el = document.getElementById(id); if (el) el.value = value; }
function listToLines(value) { if (Array.isArray(value)) return value.join('\n'); return value || ''; }
function linesToList(value) { return String(value || '').split(/\n|,/).map(item => item.trim()).filter(Boolean); }
function nowMs() { return Date.now(); }
function yamlEscape(value) { return String(value).replaceAll('"', '\\"'); }

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function escapeAttr(value) { return escapeHtml(value); }

function highlightJson(json) {
  return escapeHtml(json).replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, match => {
    let cls = 'json-number';
    if (/^"/.test(match)) cls = /:$/.test(match) ? 'json-key' : 'json-string';
    else if (/true|false/.test(match)) cls = 'json-bool';
    else if (/null/.test(match)) cls = 'json-null';
    return `<span class="${cls}">${match}</span>`;
  });
}

async function copyText(text, okMessage) {
  await navigator.clipboard.writeText(text);
  toast(okMessage);
}

async function copyClientLink(text, okMessage) {
  if (String(text || '').startsWith('# ')) {
    toast(String(text).slice(2), true);
    return false;
  }
  await copyText(text, okMessage);
  return true;
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Random generators
// ---------------------------------------------------------------------------

function randomEmail() { return `user${Math.floor(Math.random() * 90000 + 10000)}@example.com`; }
function randomPassword() { return crypto.getRandomValues(new Uint32Array(2)).join(''); }

function defaultInboundTag(protocol, port) {
  if (protocol === 'vless-reality') return `in-${port}-tcp`;
  return `${protocol}-${port}`;
}

function defaultOutboundTag(type) {
  const tags = { direct: 'direct', block: 'block', vless: 'vless', shadowsocks: 'ss' };
  return tags[type] || type;
}

function randomShortId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  if (!isYamlSafeRealityShortId(hex)) {
    const chars = 'abcdf';
    const random = new Uint8Array(2);
    crypto.getRandomValues(random);
    const pos = random[0] % hex.length;
    const replacement = chars[random[1] % chars.length];
    hex = `${hex.slice(0, pos)}${replacement}${hex.slice(pos + 1)}`;
  }
  return hex;
}

function randomShortIds(count = 8) {
  return Array.from({ length: count }, () => randomShortId());
}

function uniqueStrategyTag(base, currentId = null) {
  const cleanBase = String(base || 'out').trim() || 'out';
  const used = new Set([
    ...state.outbounds.filter(item => item.id !== currentId).map(item => item.tag).filter(Boolean),
    ...state.routingPolicies.map(item => item.tag).filter(Boolean)
  ]);
  if (!used.has(cleanBase)) return cleanBase;
  let index = 2;
  let candidate = `${cleanBase}-${index}`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `${cleanBase}-${index}`;
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// Strategy helpers
// ---------------------------------------------------------------------------

function strategyItems() {
  return [
    ...state.outbounds.map(out => ({ tag: out.tag, type: out.type || '出站' })),
    ...state.routingPolicies.map(policy => ({ tag: policy.tag, type: '分流策略' }))
  ].filter(item => item.tag);
}

function strategyOptions(selected) {
  return strategyItems().map(item => `<option value="${escapeAttr(item.tag)}" ${item.tag === selected ? 'selected' : ''}>${escapeHtml(item.tag)}</option>`).join('');
}

function outboundOptions(selected) {
  return state.outbounds.map(out => `<option value="${escapeAttr(out.tag)}" ${out.tag === selected ? 'selected' : ''}>${escapeHtml(out.tag)}</option>`).join('');
}

function presetOptions(selected) {
  const presets = [
    ['cn', 'CN 国内合集（geosite:cn + geoip:cn/private）'],
    ['ai', 'AI 常见域名合集'],
    ['ads', '广告合集（geosite:category-ads-all）'],
    ['private', '私网 IP（geoip:private）'],
    ['bt', 'BT 协议（bittorrent）']
  ];
  return presets.map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('');
}

function sniffChip(value, label, selected) {
  const checked = (selected || []).includes(value) ? 'checked' : '';
  return `<label class="check-chip"><input type="checkbox" name="sniffDestOverride" value="${escapeAttr(value)}" ${checked}>${escapeHtml(label)}</label>`;
}

function ruleDescription(rule) {
  if (rule.kind === 'fallback') return '兜底';
  if (rule.kind === 'manual') return '手动匹配';
  const labels = {
    cn: 'CN 国内合集',
    ai: 'AI 常见域名合集',
    ads: '广告合集',
    private: '私网 IP',
    bt: 'BT 协议'
  };
  return labels[rule.preset] || '常用合集';
}

function firstNonBlockOutboundTag() {
  const out = state.outbounds.find(item => item.tag !== 'block') || state.outbounds[0];
  return out ? out.tag : '';
}

function badge(type) {
  const cls = type.includes('reality') ? 'reality' :
    type.includes('vless') ? 'vless' :
    type.includes('vmess') ? 'vmess' :
    type.includes('shadowsocks') ? 'ss' :
    type.includes('trojan') ? 'trojan' :
    type.includes('direct') ? 'direct' :
    type.includes('block') ? 'block' :
    type.includes('auto') ? 'auto' : '';
  return `<span class="badge ${cls}">${escapeHtml(type)}</span>`;
}

function parseHostPort(hostPort) {
  const m = hostPort.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (m) return { host: m[1], port: m[2] };
  const lastColon = hostPort.lastIndexOf(':');
  if (lastColon > 0) {
    const port = hostPort.slice(lastColon + 1);
    if (/^\d+$/.test(port)) return { host: hostPort.slice(0, lastColon), port };
  }
  return { host: hostPort };
}

function toQuery(params) {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

function base64Utf8(text) {
  const bytes = new TextEncoder().encode(String(text));
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function base64UrlUtf8(text) {
  return base64Utf8(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// REALITY shortId helpers
// ---------------------------------------------------------------------------

function isValidRealityShortId(value) {
  return /^[0-9a-fA-F]{2,16}$/.test(value) && value.length % 2 === 0;
}

function isYamlSafeRealityShortId(value) {
  return /[abcdfABCDF]/.test(String(value || ''));
}

function firstValidRealityShortId(shortIds) {
  const valid = (shortIds || []).map(item => String(item || '').trim()).filter(isValidRealityShortId);
  return valid.find(isYamlSafeRealityShortId) || valid[0] || '';
}

function normalizeRealityShortIds(shortIds) {
  return (shortIds || []).map(item => String(item || '').trim()).filter(isValidRealityShortId);
}

function shareTransportType(network) {
  return !network || network === 'raw' ? 'tcp' : network;
}

function defaultClientServer(inbound) {
  const shareAddress = String(inbound ? (inbound.params || {}).shareAddress || '' : '').trim();
  if (shareAddress) return shareAddress;
  const listen = String(inbound ? inbound.listen || '' : '').trim();
  const local = new Set(['', '0.0.0.0', '::', '[::]', '127.0.0.1', 'localhost']);
  return local.has(listen) ? '' : listen;
}

// ---------------------------------------------------------------------------
// Client link generation
// ---------------------------------------------------------------------------

function buildClientLink(user, inbound, server) {
  if (!user || !inbound) return '# 用户或入站不存在';
  const params = inbound.params || {};
  const credential = user.credential || {};
  const name = user.remark || user.email || 'xray';
  const port = Number(inbound.port || 443);
  if (!String(server || '').trim() || String(server || '').startsWith('<')) {
    return '# 请先填写分享地址 / 客户端连接地址';
  }

  if (inbound.protocol === 'vless-reality') {
    const reality = params.reality || {};
    const sid = firstValidRealityShortId(reality.shortIds || []);
    if (!sid) return '# REALITY shortIds 为空或无效，请先生成并保存 shortIds';
    if (!reality.publicKey) return '# REALITY publicKey 为空，请先生成并保存密钥对';
    const query = {
      encryption: 'none',
      security: 'reality',
      type: shareTransportType(params.network),
      fp: reality.fingerprint || 'chrome',
      pbk: reality.publicKey || '',
      sid,
      sni: (reality.serverNames || [''])[0] || '',
      spx: reality.spiderX || '/',
      flow: params.flow || ''
    };
    return `vless://${credential.uuid || ''}@${server}:${port}?${toQuery(query)}#${encodeURIComponent(name)}`;
  }

  if (inbound.protocol === 'vless-tls') {
    const tls = params.tls || {};
    const query = {
      encryption: 'none',
      security: 'tls',
      type: shareTransportType(params.network),
      sni: tls.serverName || server,
      flow: params.flow || ''
    };
    return `vless://${credential.uuid || ''}@${server}:${port}?${toQuery(query)}#${encodeURIComponent(name)}`;
  }

  if (inbound.protocol === 'shadowsocks-2022') {
    const method = params.method || '2022-blake3-aes-128-gcm';
    const serverKey = params.psk || '';
    const clientKey = credential.password || '';
    const password = method.startsWith('2022-')
      ? [method, serverKey, clientKey || serverKey].join(':')
      : `${method}:${clientKey || serverKey}`;
    return `ss://${base64UrlUtf8(password)}@${server}:${port}?${toQuery({ type: 'tcp' })}#${encodeURIComponent(name)}`;
  }

  if (inbound.protocol === 'trojan') {
    const tls = params.tls || {};
    return `trojan://${encodeURIComponent(credential.password || '')}@${server}:${port}?${toQuery({ security: 'tls', sni: tls.serverName || server, type: shareTransportType(params.network) })}#${encodeURIComponent(name)}`;
  }

  if (inbound.protocol === 'vmess-ws-tls') {
    const tls = params.tls || {};
    const sni = tls.serverName || server;
    const path = params.path || '/ws';
    const json = JSON.stringify({
      v: '2', ps: name, add: server, port: String(port),
      id: credential.uuid || '', aid: '0', scy: 'auto',
      net: 'ws', type: 'none', host: sni, path, tls: 'tls', sni
    });
    return `vmess://${base64Utf8(json)}`;
  }

  return '# 暂不支持该协议';
}

// ---------------------------------------------------------------------------
// Share link parsing / import
// ---------------------------------------------------------------------------

function _parsedToParams(p) {
  const params = {
    address: p.host || '',
    port: p.port || (p.type === 'shadowsocks' ? 8388 : 443),
    network: p.network || 'raw',
    security: p.security || 'none',
    flow: p.flow || '',
    serverName: p.serverName || '',
    path: p.path || '',
  };
  if (p.type === 'vless' || p.type === 'vmess') params.uuid = p.uuid || '';
  if (p.type === 'shadowsocks') params.password = p.password || '';
  if (p.method) params.method = p.method;
  if (p.security === 'reality' || p.publicKey || p.shortId) {
    params.reality = {
      serverName: p.serverName || '',
      publicKey: p.publicKey || '',
      shortId: p.shortId || '',
      fingerprint: p.fingerprint || 'chrome',
    };
  }
  return params;
}

function parseShareLink(raw) {
  let name = '';
  const hashIdx = raw.lastIndexOf('#');
  if (hashIdx > 0 && !raw.slice(hashIdx + 1).includes('://')) {
    name = decodeURIComponent(raw.slice(hashIdx + 1));
    raw = raw.slice(0, hashIdx);
  }

  if (raw.startsWith('ss://')) {
    const body = raw.slice(5);
    let method = '', password = '', host = '', port = '';
    const atIdx = body.lastIndexOf('@');
    let userinfo = '', hostPort = '';
    if (atIdx > 0) {
      userinfo = body.slice(0, atIdx);
      hostPort = body.slice(atIdx + 1);
    } else {
      userinfo = body;
    }
    const qIdx = hostPort.indexOf('?');
    if (qIdx > 0) hostPort = hostPort.slice(0, qIdx);
    let decoded = userinfo;
    if (userinfo.includes('%')) {
      try { decoded = decodeURIComponent(userinfo); } catch (e) {}
    } else {
      try {
        let padded = userinfo.replace(/-/g, '+').replace(/_/g, '/');
        while (padded.length % 4) padded += '=';
        decoded = atob(padded);
      } catch (e) {
        try { decoded = decodeURIComponent(userinfo); } catch {}
      }
    }
    const colon = decoded.indexOf(':');
    if (colon >= 0) {
      method = decoded.slice(0, colon);
      password = decoded.slice(colon + 1);
    } else {
      method = decoded;
    }
    if (hostPort) {
      const hp = parseHostPort(hostPort);
      host = hp.host;
      port = hp.port || 8388;
    }
    return { type: 'shadowsocks', host, port: Number(port || 8388), method, password, name };
  }

  if (raw.startsWith('vless://')) {
    const body = raw.slice(8);
    const atIdx = body.indexOf('@');
    const questionIdx = body.indexOf('?');
    const uuid = body.slice(0, atIdx);
    const hostStr = questionIdx > 0 ? body.slice(atIdx + 1, questionIdx) : body.slice(atIdx + 1);
    const query = questionIdx > 0 ? body.slice(questionIdx + 1) : '';
    const hp = parseHostPort(hostStr);
    const params = Object.fromEntries(new URLSearchParams(query));
    return {
      type: 'vless', host: hp.host, port: Number(hp.port || 443),
      uuid: uuid.replace(/[^a-f0-9-]/gi, ''),
      security: params.security || params.encryption || 'none',
      flow: params.flow || '',
      network: params.type || 'raw',
      serverName: params.sni || '',
      fingerprint: params.fp || 'chrome',
      publicKey: params.pbk || '',
      shortId: params.sid || '',
      path: params.path || params.serviceName || '',
      name
    };
  }

  if (raw.startsWith('trojan://')) {
    const body = raw.slice(9);
    const atIdx = body.indexOf('@');
    const questionIdx = body.indexOf('?');
    const password = decodeURIComponent(body.slice(0, atIdx));
    const hostStr = questionIdx > 0 ? body.slice(atIdx + 1, questionIdx) : body.slice(atIdx + 1);
    const query = questionIdx > 0 ? body.slice(questionIdx + 1) : '';
    const hp = parseHostPort(hostStr);
    const params = Object.fromEntries(new URLSearchParams(query));
    return {
      type: 'trojan', host: hp.host, port: Number(hp.port || 443),
      password,
      security: params.security || (params.allowInsecure || params.tls ? 'tls' : 'none'),
      network: params.type || 'raw',
      flow: params.flow || '',
      serverName: params.sni || '',
      fingerprint: params.fp || 'chrome',
      path: params.path || params.serviceName || '',
      name
    };
  }

  if (raw.startsWith('vmess://')) {
    let b64 = raw.slice(7);
    try {
      let padded = b64.replace(/-/g, '+').replace(/_/g, '/');
      while (padded.length % 4) padded += '=';
      const json = JSON.parse(atob(padded));
      return {
        type: 'vmess', host: json.add, port: Number(json.port || 443),
        uuid: json.id,
        security: json.tls === 'tls' ? 'tls' : (json.tls === 'reality' ? 'reality' : 'none'),
        network: json.net || 'raw',
        flow: json.flow || '',
        serverName: json.sni || json.host || '',
        fingerprint: json.fp || 'chrome',
        path: json.path || '',
        alterId: json.aid || 0,
        name: json.ps || name
      };
    } catch (e) {
      return null;
    }
  }

  return null;
}

function importShareLink() {
  const input = document.getElementById('share-link-input');
  if (!input) return;
  const raw = input.value.trim();
  if (!raw) return;
  try {
    const parsed = parseShareLink(raw);
    if (!parsed) { toast('无法识别该链接', true); return; }
    const fakeItem = {
      type: parsed.type,
      remark: parsed.name || `${parsed.host}:${parsed.port}`,
      tag: '',
      params: _parsedToParams(parsed)
    };
    document.getElementById('outbound-type').value = parsed.type;
    renderOutboundFields(fakeItem);
    toast(`识别为 ${parsed.type.toUpperCase()} 节点`);
  } catch (e) {
    toast('无法识别该链接', true);
  }
}

// ---------------------------------------------------------------------------
// UI: nav, topbar, render dispatcher
// ---------------------------------------------------------------------------

function renderNav() {
  const isServers = state.view === 'servers';
  const items = isServers ? [] : configNavItems;
  document.getElementById('nav').innerHTML = items.map(([id, icon, label]) => (
    `<button class="nav-btn ${state.view === id ? 'active' : ''}" data-view="${id}"><span class="nav-icon">${icon}</span><span>${label}</span></button>`
  )).join('');
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.onclick = async () => {
      state.view = btn.dataset.view;
      if (state.view === 'preview') await loadPreview();
      render();
    };
  });
}

function renderTopActions() {
  const root = document.getElementById('top-actions');
  const user = state.auth.user;
  let html = state.view === 'servers' ? '' : `<button class="btn ghost" id="back-to-vps">← 返回 VPS 列表</button>`;
  if (user) html += `<div class="user-menu"><span class="user-name" title="${escapeAttr(user.username || '')}">${escapeHtml(user.username || '')}</span><button class="btn ghost" id="logout-btn">退出登录</button></div>`;
  root.innerHTML = html;
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) logoutBtn.onclick = () => logout();
  const backBtn = document.getElementById('back-to-vps');
  if (backBtn) backBtn.onclick = () => { state.view = 'servers'; render(); };
}

function render() {
  if (state.auth.checking) {
    document.getElementById('content').innerHTML = '<div class="empty" style="margin-top:120px">加载中…</div>';
    return;
  }
  if (state.auth.setupRequired || !state.auth.isLoggedIn) {
    renderAuth();
    return;
  }
  document.getElementById('app').classList.remove('auth-mode');
  document.getElementById('app').classList.toggle('servers-mode', state.view === 'servers');
  document.getElementById('topbar').style.display = '';
  document.getElementById('nav').style.display = state.view === 'servers' ? 'none' : '';
  renderNav();
  renderTopActions();
  if (state.view === 'servers') renderVpsProfiles();
  if (state.view === 'inbounds') renderInbounds();
  if (state.view === 'users') renderUsers();
  if (state.view === 'outbounds') renderOutbounds();
  if (state.view === 'routing') renderRoutingPolicies();
  if (state.view === 'preview') renderPreview();
}
