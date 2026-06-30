// interface.js — page renderers, modals, form handling, install scripts

// ---------------------------------------------------------------------------
// Auth pages
// ---------------------------------------------------------------------------

function renderAuth() {
  document.getElementById('app').classList.add('auth-mode');
  document.getElementById('topbar').style.display = 'none';
  document.getElementById('nav').style.display = 'none';
  if (state.auth.setupRequired) return renderRegister();
  return renderLogin();
}

function renderLogin() {
  document.getElementById('content').innerHTML = `
    <div class="auth-layout">
      <div class="auth-copy">
        <div class="auth-kicker">XR</div>
        <h1>Xray 配置生成器</h1>
        <p>登录后管理 VPS、入站、出站和用户策略。配置数据只在本地项目目录中读写。</p>
      </div>
      <div class="auth-card">
        <h2 class="auth-title">欢迎回来</h2>
        <p class="auth-sub">登录到 Xray 配置生成器</p>
        <div class="auth-error" id="auth-error"></div>
        <form class="auth-form" id="auth-form">
          <div class="field"><label>用户名</label><input class="input" name="username" autocomplete="username" autofocus></div>
          <div class="field"><label>密码</label><input class="input" type="password" name="password" autocomplete="current-password"></div>
          <button type="submit" class="btn primary" id="auth-submit">登录</button>
        </form>
      </div>
    </div>`;
  bindAuthForm('auth-form', 'auth-error', 'auth-submit', async (data) => {
    await login(data.username, data.password);
    toast('登录成功');
  });
}

function renderRegister() {
  document.getElementById('content').innerHTML = `
    <div class="auth-layout">
      <div class="auth-copy">
        <div class="auth-kicker">XR</div>
        <h1>初始化管理员</h1>
        <p>首次使用必须创建管理员账号。创建完成前，配置页面和 API 都不会开放。</p>
      </div>
      <div class="auth-card">
        <h2 class="auth-title">初始化管理员</h2>
        <p class="auth-sub">首次使用，请创建管理员账号</p>
        <div class="auth-error" id="auth-error"></div>
        <form class="auth-form" id="auth-form">
          <div class="field"><label>用户名</label><input class="input" name="username" autocomplete="username" autofocus placeholder="admin"></div>
          <div class="field"><label>密码</label><input class="input" type="password" name="password" autocomplete="new-password" placeholder="至少 8 位，含字母和数字"></div>
          <div class="field"><label>确认密码</label><input class="input" type="password" name="password2" autocomplete="new-password"></div>
          <button type="submit" class="btn primary" id="auth-submit">创建管理员</button>
        </form>
      </div>
    </div>`;
  bindAuthForm('auth-form', 'auth-error', 'auth-submit', async (data) => {
    if (data.password !== data.password2) throw new Error('两次输入的密码不一致');
    await register(data.username, data.password);
    toast('管理员账号已创建');
  });
}

function bindAuthForm(formId, errorId, submitId, handler) {
  document.getElementById(formId).onsubmit = async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById(errorId);
    errorEl.classList.remove('visible');
    errorEl.textContent = '';
    const btn = document.getElementById(submitId);
    btn.disabled = true;
    const data = Object.fromEntries(new FormData(e.target).entries());
    try {
      await handler(data);
    } catch (err) {
      errorEl.textContent = err.message || '操作失败';
      errorEl.classList.add('visible');
      btn.disabled = false;
    }
  };
}

// ---------------------------------------------------------------------------
// VPS profiles
// ---------------------------------------------------------------------------

async function refreshAll() {
  state.vpsProfiles = await api('/api/vps');
  state.activeVpsId = (state.vpsProfiles.find(item => item.active) || state.vpsProfiles[0] || {}).id || '';
  if (state.view === 'servers') {
    render();
    return;
  }
  const [inbounds, users, outbounds, routingPolicies] = await Promise.all([
    api('/api/inbounds'),
    api('/api/users'),
    api('/api/outbounds'),
    api('/api/routing-policies')
  ]);
  state.inbounds = inbounds;
  state.users = users;
  state.outbounds = outbounds;
  state.routingPolicies = routingPolicies;
  render();
}

function renderVpsProfiles() {
  const cards = state.vpsProfiles.map(item => {
    const counts = item.counts || {};
    return `<article class="card">
      <div class="card-top">
        <div>
          <div class="card-title">${escapeHtml(item.name || '未命名 VPS')}</div>
        </div>
      </div>
      <div class="meta">
        ${item.remark ? `<div class="muted">${escapeHtml(item.remark)}</div>` : ''}
        <div class="meta-row"><span class="meta-label">入站</span><span>${counts.inbounds || 0}</span></div>
        <div class="meta-row"><span class="meta-label">用户</span><span>${counts.users || 0}</span></div>
        <div class="meta-row"><span class="meta-label">分流</span><span>${counts.routing_policies || 0}</span></div>
      </div>
      <div class="actions">
        <button class="btn primary" data-enter-vps="${item.id}">进入</button>
        <button class="btn" data-edit-vps="${item.id}">编辑</button>
        <button class="btn danger" data-delete-vps="${item.id}">删除</button>
      </div>
    </article>`;
  }).join('');
  document.getElementById('content').innerHTML = `<div class="page-head">
    <h1 class="page-title">VPS 管理</h1>
    <div class="toolbar">
      <button class="btn primary" id="add-vps">+ 添加 VPS</button>
    </div>
  </div>
  <div class="grid">${cards || '<div class="empty">暂无 VPS</div>'}</div>`;
  document.getElementById('add-vps').onclick = () => openVpsModal();
  document.querySelectorAll('[data-enter-vps]').forEach(btn => btn.onclick = () => enterVps(btn.dataset.enterVps));
  document.querySelectorAll('[data-edit-vps]').forEach(btn => btn.onclick = () => openVpsModal(getVpsProfile(btn.dataset.editVps)));
  document.querySelectorAll('[data-delete-vps]').forEach(btn => btn.onclick = () => deleteVps(btn.dataset.deleteVps));
}

function openVpsModal(item = null) {
  openModal(item ? '编辑 VPS' : '添加 VPS', `<form id="modal-form" class="form-grid">
    <div class="field"><label>名称</label><input class="input" name="name" value="${escapeAttr(item ? item.name || '' : '')}" placeholder="例如：东京 VPS"></div>
    <div class="field full"><label>备注</label><input class="input" name="remark" value="${escapeAttr(item ? item.remark || '' : '')}" placeholder="例如：AWS 日本机房"></div>
  </form>`, async () => {
    const data = Object.fromEntries(new FormData(document.getElementById('modal-form')).entries());
    const payload = {
      name: String(data.name || '').trim() || '未命名 VPS',
      host: '',
      remark: String(data.remark || '').trim()
    };
    if (item) await api(`/api/vps/${item.id}`, { method: 'PUT', body: payload });
    else await api('/api/vps', { method: 'POST', body: payload });
    closeModal();
    state.view = 'servers';
    await refreshAll();
  });
}

async function enterVps(id) {
  await api(`/api/vps/${id}/activate`, { method: 'POST' });
  state.view = 'inbounds';
  state.preview = null;
  await refreshAll();
}

async function deleteVps(id) {
  const item = getVpsProfile(id);
  if (!confirm(`确认删除 ${item ? item.name : '该 VPS'}？该机器下的配置会一并删除。`)) return;
  try {
    await api(`/api/vps/${id}`, { method: 'DELETE' });
    state.view = 'servers';
    await refreshAll();
  } catch (err) { toast(err.message, true); }
}

// ---------------------------------------------------------------------------
// Inbounds
// ---------------------------------------------------------------------------

function renderInbounds() {
  const content = document.getElementById('content');
  const cards = state.inbounds.map(item => {
    const count = state.users.filter(user => user.inbound_id === item.id).length;
    return `<article class="card">
      <div class="card-top">
        <div>
          <div class="card-title">${escapeHtml(item.tag || '未命名入站')}</div>
          <div class="card-sub">${escapeHtml(item.listen || '0.0.0.0')}:${escapeHtml(String(item.port || ''))}</div>
        </div>
        ${badge(item.protocol || '')}
      </div>
      <div class="meta">
        <div class="meta-row"><span class="meta-label">端口</span><span>${escapeHtml(String(item.port || ''))}</span></div>
        <div class="meta-row"><span class="meta-label">用户数</span><span>${count}</span></div>
      </div>
      <div class="actions">
        <button class="btn" data-edit-inbound="${item.id}">编辑</button>
        <button class="btn danger" data-delete-inbound="${item.id}">删除</button>
      </div>
    </article>`;
  }).join('');
  content.innerHTML = `<div class="page-head">
    <h1 class="page-title">入站管理</h1>
    <button class="btn primary" id="add-inbound">+ 添加入站</button>
  </div>${cards ? `<div class="grid">${cards}</div>` : '<div class="empty">还没有入站，先添加一个 VLESS + Reality。</div>'}`;
  document.getElementById('add-inbound').onclick = () => openInboundModal();
  document.querySelectorAll('[data-edit-inbound]').forEach(btn => btn.onclick = () => openInboundModal(getInbound(btn.dataset.editInbound)));
  document.querySelectorAll('[data-delete-inbound]').forEach(btn => btn.onclick = () => deleteInbound(btn.dataset.deleteInbound));
}

function openInboundModal(item = null) {
  const protocol = item ? item.protocol : 'vless-reality';
  const title = item ? '编辑入站' : '添加入站';
  openModal(title, `<form id="modal-form" class="form-grid">
    <div class="field">
      <label>协议</label>
      <select class="select" name="protocol" id="inbound-protocol">
        <option value="vless-reality">VLESS + Reality</option>
        <option value="shadowsocks-2022">Shadowsocks 2022</option>
      </select>
    </div>
    <div id="inbound-fields" class="field full"></div>
  </form>`, async () => {
    const payload = collectInboundPayload(item);
    if (item) await api(`/api/inbounds/${item.id}`, { method: 'PUT', body: payload });
    else await api('/api/inbounds', { method: 'POST', body: payload });
    closeModal();
    await refreshAll();
    toast('入站已保存');
  });
  document.getElementById('inbound-protocol').value = protocol;
  const draw = () => renderInboundFields(item);
  document.getElementById('inbound-protocol').onchange = draw;
  draw();
}

function renderInboundFields(item) {
  const protocol = document.getElementById('inbound-protocol').value;
  const params = item ? (item.params || {}) : {};
  const reality = params.reality || {};
  const tls = params.tls || {};
  let html = commonInboundFields(item, protocol);
  if (protocol === 'vless-reality') {
    const sniffing = params.sniffing || {};
    const destOverride = sniffing.destOverride || ['http', 'tls', 'quic', 'fakedns'];
    html += `<div class="field full"><label>Reality target</label><input class="input" name="target" value="${escapeAttr(reality.target || '')}" placeholder="example.com:443"></div>
      <div class="field full"><label>serverNames</label><input class="input" name="serverNames" value="${escapeAttr((reality.serverNames || []).join(','))}" placeholder="example.com，可多个用逗号分隔"></div>
      <div class="field"><label>Reality privateKey（服务端 config 使用）</label><input class="input" name="privateKey" value="${escapeAttr(reality.privateKey || '')}" placeholder="服务端私钥"></div>
      <div class="field"><label>Reality publicKey（客户端配置使用）</label><input class="input" name="publicKey" value="${escapeAttr(reality.publicKey || '')}" placeholder="客户端公钥"></div>
      <div class="field full"><button type="button" class="btn" id="gen-x25519">🔑 生成 Reality 密钥对</button></div>
      <div class="field"><label>shortIds</label><div class="inline-row"><input class="input" name="shortIds" value="${escapeAttr((reality.shortIds || randomShortIds()).join(','))}"><button type="button" class="icon-btn" id="gen-shortid">🎲</button></div></div>
      <div class="field"><label>flow</label><select class="select" name="flow" id="inbound-flow">
        <option value="xtls-rprx-vision">xtls-rprx-vision</option>
        <option value="">无</option>
      </select></div>
      <div class="field"><label>network</label><select class="select" name="network" id="inbound-network"><option value="raw">raw</option><option value="tcp">tcp</option></select></div>
      <div class="field"><label>fingerprint</label><select class="select" name="fingerprint" id="inbound-fingerprint"><option>chrome</option><option>safari</option><option>firefox</option><option>edge</option></select></div>
      <div class="field"><label>spiderX</label><input class="input" name="spiderX" value="${escapeAttr(reality.spiderX || '/')}"></div>
      <div class="field"><label>maxTimeDiff</label><input class="input" type="number" name="maxTimeDiff" value="${escapeAttr(reality.maxTimeDiff || reality.maxTimediff || 0)}"></div>
      <div class="section-box">
        <label class="switch-row"><span>启用 sniffing</span><input type="checkbox" name="sniffingEnabled" id="sniffing-toggle" ${sniffing.enabled ? 'checked' : ''}></label>
        <div id="sniffing-detail" style="${sniffing.enabled ? '' : 'display:none'}">
          <div class="field full">
            <label>destOverride</label>
            <div class="chip-row">
              ${sniffChip('http', 'HTTP', destOverride)}
              ${sniffChip('tls', 'TLS', destOverride)}
              ${sniffChip('quic', 'QUIC', destOverride)}
              ${sniffChip('fakedns', 'FAKEDNS', destOverride)}
            </div>
          </div>
          <label class="switch-row"><span>仅元数据</span><input type="checkbox" name="sniffMetadataOnly" ${sniffing.metadataOnly ? 'checked' : ''}></label>
          <label class="switch-row"><span>仅路由</span><input type="checkbox" name="sniffRouteOnly" ${sniffing.routeOnly ? 'checked' : ''}></label>
          <div class="field full"><label>排除的 IP</label><textarea class="textarea" name="sniffIpsExcluded" placeholder="IP/CIDR/geoip:*/ext:*">${escapeHtml(listToLines(sniffing.ipsExcluded))}</textarea></div>
          <div class="field full"><label>排除的域名</label><textarea class="textarea" name="sniffDomainsExcluded" placeholder="domain:*/ext:*">${escapeHtml(listToLines(sniffing.domainsExcluded))}</textarea></div>
        </div>
      </div>`;
  }
  if (protocol === 'vless-tls') {
    html += `<div class="field full"><label>flow</label><input class="input" name="flow" value="${escapeAttr(params.flow || '')}"></div>`;
  }
  if (protocol === 'shadowsocks-2022') {
    html += `<div class="field"><label>加密方式</label><select class="select" name="method" id="ss-method">
        <option value="2022-blake3-aes-128-gcm">2022-blake3-aes-128-gcm</option>
        <option value="2022-blake3-aes-256-gcm">2022-blake3-aes-256-gcm</option>
      </select></div>
      <div class="field"><label>PSK</label><div class="inline-row"><input class="input" name="psk" value="${escapeAttr(params.psk || '')}" readonly><button type="button" class="icon-btn" id="gen-psk">🎲</button></div></div>`;
  }
  document.getElementById('inbound-fields').innerHTML = `<div class="form-grid">${html}</div>`;
  setValue('ss-method', params.method || '2022-blake3-aes-128-gcm');
  setValue('inbound-flow', Object.prototype.hasOwnProperty.call(params, 'flow') ? params.flow : 'xtls-rprx-vision');
  setValue('inbound-network', params.network || 'raw');
  setValue('inbound-fingerprint', reality.fingerprint || 'chrome');
  const targetInput = document.querySelector('[name="target"]');
  if (targetInput) targetInput.oninput = () => {
    const value = targetInput.value.trim();
    if (value) {
      document.querySelector('[name="serverNames"]').value = value.split(':')[0];
    }
  };
  const genKey = document.getElementById('gen-x25519');
  if (genKey) genKey.onclick = async () => {
    try {
      const keys = await api('/api/util/x25519');
      document.querySelector('[name="privateKey"]').value = keys.privateKey || '';
      document.querySelector('[name="publicKey"]').value = keys.publicKey || '';
    } catch (err) { toast(err.message, true); }
  };
  // Auto-generate Reality keys for new inbound
  if (!item) {
    const priv = document.querySelector('[name="privateKey"]');
    if (priv && !priv.value) genKey.click();
  }
  const genPsk = document.getElementById('gen-psk');
  if (genPsk) genPsk.onclick = async () => {
    const bits = document.getElementById('ss-method').value.includes('256') ? 256 : 128;
    const data = await api(`/api/util/ss-psk?bits=${bits}`);
    document.querySelector('[name="psk"]').value = data.psk;
  };
  const genShortId = document.getElementById('gen-shortid');
  if (genShortId) genShortId.onclick = () => {
    document.querySelector('[name="shortIds"]').value = randomShortIds().join(',');
  };
  const sniffToggle = document.getElementById('sniffing-toggle');
  if (sniffToggle) {
    sniffToggle.onchange = () => {
      document.getElementById('sniffing-detail').style.display = sniffToggle.checked ? '' : 'none';
    };
  }
}

function commonInboundFields(item, protocol) {
  const defaultPort = protocol === 'shadowsocks-2022' ? 8388 : 443;
  const tag = item ? item.tag : '';
  const params = item ? item.params || {} : {};
  return `<div class="field"><label>端口</label><input class="input" type="number" name="port" value="${escapeAttr(item ? item.port : defaultPort)}"></div>
    <div class="field"><label>Listen</label><input class="input" name="listen" value="${escapeAttr(item ? item.listen || '0.0.0.0' : '0.0.0.0')}"></div>
    <div class="field full"><label>分享地址 / 客户端连接地址</label><input class="input" name="shareAddress" value="${escapeAttr(params.shareAddress || '')}" placeholder="节点公网 IP 或域名"></div>
    <div class="field full"><label>Tag</label><input class="input" name="tag" value="${escapeAttr(tag)}"></div>`;
}

function tlsFields(tls) {
  return `<div class="field"><label>TLS 证书路径</label><input class="input" name="certificateFile" value="${escapeAttr(tls.certificateFile || '')}"></div>
    <div class="field"><label>TLS 私钥路径</label><input class="input" name="keyFile" value="${escapeAttr(tls.keyFile || '')}"></div>
    <div class="field full"><label>SNI</label><input class="input" name="tlsServerName" value="${escapeAttr(tls.serverName || '')}"></div>`;
}

function collectInboundPayload(item) {
  const form = document.getElementById('modal-form');
  const data = Object.fromEntries(new FormData(form).entries());
  const protocol = data.protocol;
  const sniffDestOverride = Array.from(form.querySelectorAll('[name="sniffDestOverride"]:checked')).map(item => item.value);
  const payload = {
    ...(item || {}),
    protocol,
    tag: data.tag,
    listen: data.listen,
    port: Number(data.port),
    params: { shareAddress: String(data.shareAddress || '').trim() }
  };
  if (protocol === 'vless-reality') {
    payload.params = {
      ...payload.params,
      reality: {
        target: data.target,
        serverNames: splitList(data.serverNames),
        privateKey: data.privateKey,
        publicKey: data.publicKey,
        shortIds: normalizeRealityShortIds(splitList(data.shortIds)),
        fingerprint: data.fingerprint || 'chrome',
        spiderX: data.spiderX || '/',
        maxTimeDiff: Number(data.maxTimeDiff || 0)
      },
      flow: data.flow,
      network: data.network || 'raw',
      encryption: 'none',
      sniffing: {
        enabled: Boolean(form.elements.sniffingEnabled.checked),
        destOverride: sniffDestOverride,
        metadataOnly: Boolean(form.elements.sniffMetadataOnly.checked),
        routeOnly: Boolean(form.elements.sniffRouteOnly.checked),
        ipsExcluded: linesToList(data.sniffIpsExcluded),
        domainsExcluded: linesToList(data.sniffDomainsExcluded)
      }
    };
  } else if (protocol === 'shadowsocks-2022') {
    payload.params = { ...payload.params, method: data.method, psk: data.psk, network: 'tcp,udp' };
  }
  return payload;
}

async function deleteInbound(id) {
  const count = state.users.filter(user => user.inbound_id === id).length;
  const message = count ? `该入站下有 ${count} 个用户将被一并删除，确认继续？` : '确认删除该入站？';
  if (!confirm(message)) return;
  await api(`/api/inbounds/${id}`, { method: 'DELETE' });
  await refreshAll();
  toast('入站已删除');
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

function renderUsers() {
  const rows = filteredUsers().map(user => {
    const inbound = getInbound(user.inbound_id);
    return `<tr>
      <td>${escapeHtml(user.remark || '')}</td>
      <td>${escapeHtml(user.email || '')}</td>
      <td>${escapeHtml(inbound ? inbound.tag : '已删除')}</td>
      <td class="strategy-cell">${strategyPicker(user)}</td>
      <td>
        <div class="inline-row">
          <button class="btn" data-export-user="${user.id}" title="复制分享链接">📋</button>
          <button class="btn" data-edit-user="${user.id}">编辑</button>
          <button class="btn danger" data-delete-user="${user.id}">删除</button>
        </div>
      </td>
    </tr>`;
  }).join('');
  document.getElementById('content').innerHTML = `<div class="page-head">
    <h1 class="page-title">用户管理</h1>
    <div class="toolbar">
      <select class="select" id="filter-inbound" style="width: 220px">
        <option value="">全部入站</option>
        ${state.inbounds.map(item => `<option value="${escapeAttr(item.id)}" ${state.filterInbound === item.id ? 'selected' : ''}>${escapeHtml(item.tag)}</option>`).join('')}
      </select>
      <button class="btn primary" id="add-user">+ 添加用户</button>
    </div>
  </div>
  <div class="table-wrap"><table>
    <thead><tr><th>备注</th><th>Email</th><th>所属入站</th><th>流量策略</th><th>操作</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5" class="muted">暂无用户</td></tr>'}</tbody>
  </table></div>`;
  document.getElementById('add-user').onclick = () => openUserModal();
  document.getElementById('filter-inbound').onchange = event => { state.filterInbound = event.target.value; renderUsers(); };
  document.querySelectorAll('[data-export-user]').forEach(btn => btn.onclick = async () => {
    const user = getUser(btn.dataset.exportUser);
    const inbound = user ? getInbound(user.inbound_id) : null;
    const server = defaultClientServer(inbound) || '<待填写>';
    const link = buildClientLink(user, inbound, server);
    await copyClientLink(link, '分享链接已复制');
  });
  document.querySelectorAll('[data-edit-user]').forEach(btn => btn.onclick = () => openUserModal(getUser(btn.dataset.editUser)));
  document.querySelectorAll('[data-delete-user]').forEach(btn => btn.onclick = () => deleteUser(btn.dataset.deleteUser));
  bindStrategyPickers();
}

function openUserModal(item = null) {
  if (!state.inbounds.length) return toast('请先添加入站', true);
  if (!state.outbounds.length) return toast('请先添加出站', true);
  const inboundId = item ? item.inbound_id : state.inbounds[0].id;
  openModal(item ? '编辑用户' : '添加用户', `<form id="modal-form" class="form-grid">
    <div class="field"><label>备注</label><input class="input" name="remark" value="${escapeAttr(item ? item.remark || '' : '')}"></div>
    <div class="field"><label>Email</label><input class="input" name="email" value="${escapeAttr(item ? item.email || '' : randomEmail())}"></div>
    <div class="field"><label>所属入站</label><select class="select" name="inbound_id" id="user-inbound">${state.inbounds.map(inb => `<option value="${escapeAttr(inb.id)}">${escapeHtml(inb.tag)}</option>`).join('')}</select></div>
    <div class="field"><label>流量策略</label><select class="select" name="outbound_tag">${strategyOptions(item ? item.outbound_tag : state.outbounds[0].tag)}</select></div>
    <div id="credential-fields" class="field full"></div>
  </form>`, async () => {
    const payload = collectUserPayload(item);
    await saveUser(payload, Boolean(item));
    closeModal();
  });
  document.querySelector('[name="inbound_id"]').value = inboundId;
  document.querySelector('[name="outbound_tag"]').value = item ? item.outbound_tag : state.outbounds[0].tag;
  const draw = () => renderCredentialFields(item);
  document.getElementById('user-inbound').onchange = draw;
  draw();
}

function renderCredentialFields(item) {
  const inbound = getInbound(document.getElementById('user-inbound').value);
  const cred = item ? item.credential || {} : {};
  const uuidProtocols = ['vless-reality'];
  const html = uuidProtocols.includes(inbound.protocol)
    ? `<label>UUID</label><div class="inline-row"><input class="input" name="uuid" value="${escapeAttr(cred.uuid || '')}"><button type="button" class="icon-btn" id="gen-uuid">🎲</button></div>`
    : `<label>密码</label><input class="input" name="password" value="${escapeAttr(cred.password || randomPassword())}">`;
  document.getElementById('credential-fields').innerHTML = html;
  const btn = document.getElementById('gen-uuid');
  if (btn) btn.onclick = async () => {
    const data = await api('/api/util/uuid');
    document.querySelector('[name="uuid"]').value = data.uuid;
  };
}

function collectUserPayload(item) {
  const data = Object.fromEntries(new FormData(document.getElementById('modal-form')).entries());
  const inbound = getInbound(data.inbound_id);
  const uuidProtocols = ['vless-reality'];
  return {
    ...(item || {}),
    remark: data.remark,
    email: data.email,
    inbound_id: data.inbound_id,
    outbound_tag: data.outbound_tag,
    credential: uuidProtocols.includes(inbound.protocol)
      ? { uuid: data.uuid || crypto.randomUUID(), password: null }
      : { uuid: null, password: data.password || randomPassword() },
    params: {
      ...(item ? item.params || {} : {}),
      created_at: item ? (item.params || {}).created_at || Date.now() : Date.now(),
      updated_at: Date.now()
    }
  };
}

async function saveUser(payload, existing) {
  if (existing) await api(`/api/users/${payload.id}`, { method: 'PUT', body: payload });
  else await api('/api/users', { method: 'POST', body: payload });
  await refreshAll();
  toast('用户已保存');
}

async function deleteUser(id) {
  if (!confirm('确认删除该用户？')) return;
  await api(`/api/users/${id}`, { method: 'DELETE' });
  await refreshAll();
  toast('用户已删除');
}

// ---------------------------------------------------------------------------
// Strategy picker (inline dropdown in user table)
// ---------------------------------------------------------------------------

function strategyPicker(user) {
  const selected = user.outbound_tag || '';
  const items = strategyItems();
  const menu = items.map(item => `<button type="button" class="strategy-item ${item.tag === selected ? 'active' : ''}" data-strategy-user="${escapeAttr(user.id)}" data-strategy-value="${escapeAttr(item.tag)}">
      <span class="strategy-item-tag">${escapeHtml(item.tag)}</span>
      <span class="strategy-item-type">${escapeHtml(item.type)}</span>
    </button>`).join('');
  return `<div class="strategy-picker">
    <button type="button" class="strategy-trigger" data-strategy-toggle>
      <span class="strategy-trigger-label">${escapeHtml(selected || '选择策略')}</span>
      <span class="strategy-chevron">⌄</span>
    </button>
    <div class="strategy-menu">${menu || '<div class="muted" style="padding:8px 9px">暂无策略</div>'}</div>
  </div>`;
}

function closeStrategyPickers(except = null) {
  document.querySelectorAll('.strategy-picker.open').forEach(node => {
    if (node !== except) node.classList.remove('open');
  });
}

function bindStrategyPickers() {
  document.querySelectorAll('[data-strategy-toggle]').forEach(btn => {
    btn.onclick = event => {
      event.stopPropagation();
      const picker = btn.closest('.strategy-picker');
      const willOpen = !picker.classList.contains('open');
      closeStrategyPickers(picker);
      picker.classList.toggle('open', willOpen);
    };
  });
  document.querySelectorAll('[data-strategy-value]').forEach(btn => {
    btn.onclick = async event => {
      event.stopPropagation();
      const user = getUser(btn.dataset.strategyUser);
      if (!user) return;
      closeStrategyPickers();
      await saveUser({ ...user, outbound_tag: btn.dataset.strategyValue }, true);
    };
  });
}

// ---------------------------------------------------------------------------
// Outbounds
// ---------------------------------------------------------------------------

function renderOutbounds() {
  const cards = state.outbounds.map(item => {
    const count = state.users.filter(user => user.outbound_tag === item.tag).length;
    const isBuiltin = BUILTIN_OUTBOUND_IDS.has(item.id);
    return `<article class="card">
      <div class="card-top">
        <div>
          <div class="card-title">${escapeHtml(item.tag || '未命名出站')}</div>
          <div class="card-sub">${escapeHtml(item.type || '')}</div>
        </div>
        ${badge(item.type || '')}
      </div>
      <div class="meta">
        <div class="meta-row"><span class="meta-label">类型</span><span>${escapeHtml(item.type || '')}</span></div>
        <div class="meta-row"><span class="meta-label">绑定用户</span><span>${count}</span></div>
      </div>
      <div class="actions">
        <button class="btn" data-edit-outbound="${item.id}" ${isBuiltin ? 'style="display:none"' : ''}>编辑</button>
        <button class="btn danger" data-delete-outbound="${item.id}">删除</button>
      </div>
    </article>`;
  }).join('');
  document.getElementById('content').innerHTML = `<div class="page-head">
    <h1 class="page-title">出站管理</h1>
    <button class="btn primary" id="add-outbound">+ 添加出站</button>
  </div>${cards ? `<div class="grid">${cards}</div>` : '<div class="empty">暂无出站</div>'}`;
  document.getElementById('add-outbound').onclick = () => openOutboundModal();
  document.querySelectorAll('[data-edit-outbound]').forEach(btn => {
    const out = getOutbound(btn.dataset.editOutbound);
    if (out && BUILTIN_OUTBOUND_IDS.has(out.id)) return;
    btn.onclick = () => openOutboundModal(out);
  });
  document.querySelectorAll('[data-delete-outbound]').forEach(btn => btn.onclick = () => deleteOutbound(btn.dataset.deleteOutbound));
}

function openOutboundModal(item = null) {
  const isBuiltin = item ? BUILTIN_OUTBOUND_IDS.has(item.id) : false;
  if (isBuiltin) {
    closeModal();
    return toast('内置出站 direct/block 不允许编辑', true);
  }
  const type = item ? item.type : 'vless';
  openModal(item ? '编辑出站' : '添加出站', `<form id="modal-form" class="form-grid">
    <div class="field full">
      <label>粘贴分享链接自动识别</label>
      <div class="inline-row">
        <input class="input" id="share-link-input" placeholder="ss://... / vless://..." onpaste="setTimeout(()=>importShareLink(),50)">
        <button type="button" class="btn" id="manual-parse-btn">识别</button>
      </div>
    </div>
    <div class="field"><label>类型</label><select class="select" name="type" id="outbound-type">
      <option value="vless">VLESS</option>
      <option value="shadowsocks">Shadowsocks</option>
    </select></div>
    <div id="outbound-fields" class="field full"></div>
  </form>`, async () => {
    const payload = collectOutboundPayload(item);
    if (item) await api(`/api/outbounds/${item.id}`, { method: 'PUT', body: payload });
    else await api('/api/outbounds', { method: 'POST', body: payload });
    closeModal();
    await refreshAll();
    toast('出站已保存');
  });
  document.getElementById('outbound-type').value = type;
  const draw = () => renderOutboundFields(item, isBuiltin);
  document.getElementById('outbound-type').onchange = draw;
  document.getElementById('manual-parse-btn').onclick = () => importShareLink();
  draw();
}

function renderOutboundFields(item, isBuiltin = false) {
  const type = document.getElementById('outbound-type').value;
  const params = item ? item.params || {} : {};
  const disabledAttr = isBuiltin ? 'readonly' : '';
  let html = `<div class="field full"><label>Tag</label><input class="input" name="tag" value="${escapeAttr(item ? item.tag || '' : defaultOutboundTag(type))}" ${disabledAttr}></div>`;
  if (type !== 'direct' && type !== 'block') {
    html += `<div class="field"><label>服务器地址</label><input class="input" name="address" value="${escapeAttr(params.address || '')}" ${disabledAttr}></div>
      <div class="field"><label>端口</label><input class="input" type="number" name="port" value="${escapeAttr(params.port || (type === 'shadowsocks' ? 8388 : 443))}" ${disabledAttr}></div>
      <div class="field"><label>${type === 'shadowsocks' ? '密码' : 'UUID'}</label><input class="input" name="credential" value="${escapeAttr(params.uuid || params.password || '')}" ${disabledAttr}></div>`;
  }
  if (type === 'shadowsocks') {
    html += `<div class="field full"><label>加密方式</label><select class="select" name="method" id="out-method" ${isBuiltin ? 'disabled' : ''}><option value="2022-blake3-aes-128-gcm">2022-blake3-aes-128-gcm</option><option value="2022-blake3-aes-256-gcm">2022-blake3-aes-256-gcm</option></select></div>`;
  }
  if (type === 'vless') {
    html += `<div class="field"><label>TLS 类型</label><select class="select" name="security" id="out-security" ${isBuiltin ? 'disabled' : ''}><option value="reality">Reality</option><option value="tls">TLS</option><option value="none">None</option></select></div>
      <div class="field"><label>network</label><select class="select" name="network" id="out-network" ${isBuiltin ? 'disabled' : ''}><option value="tcp">tcp</option><option value="raw">raw</option><option value="ws">ws</option><option value="grpc">grpc</option></select></div>
      <div class="field"><label>flow</label><input class="input" name="flow" value="${escapeAttr(params.flow || '')}" ${disabledAttr}></div>
      <div class="field"><label>serverName</label><input class="input" name="serverName" value="${escapeAttr((params.reality || {}).serverName || params.serverName || '')}" ${disabledAttr}></div>
      <div class="field"><label>publicKey</label><input class="input" name="publicKey" value="${escapeAttr((params.reality || {}).publicKey || '')}" ${disabledAttr}></div>
      <div class="field"><label>shortId</label><input class="input" name="shortId" value="${escapeAttr((params.reality || {}).shortId || '')}" ${disabledAttr}></div>
      <div class="field"><label>fingerprint</label><select class="select" name="fingerprint" id="fingerprint" ${isBuiltin ? 'disabled' : ''}><option>chrome</option><option>safari</option><option>firefox</option><option>edge</option></select></div>
      <div class="field"><label>WS path / gRPC service</label><input class="input" name="path" value="${escapeAttr(params.path || params.serviceName || '')}" ${disabledAttr}></div>`;
  }
  document.getElementById('outbound-fields').innerHTML = `<div class="form-grid">${html}</div>`;
  if (type === 'vless') {
    setValue('out-security', params.security || 'reality');
    setValue('out-network', params.network || 'raw');
    setValue('fingerprint', (params.reality || {}).fingerprint || 'chrome');
  }
  if (type === 'shadowsocks') {
    setValue('out-method', params.method || '2022-blake3-aes-128-gcm');
  }
}

function collectOutboundPayload(item) {
  const form = document.getElementById('modal-form');
  const data = Object.fromEntries(new FormData(form).entries());
  const tag = String(data.tag || '').trim();
  if (!tag) throw new Error('出站 Tag 不能为空');
  const uniqueTag = uniqueStrategyTag(tag, item ? item.id : null);
  const payload = { ...(item || {}), type: data.type, remark: uniqueTag, tag: uniqueTag, params: {} };
  if (data.type === 'shadowsocks') {
    payload.params = {
      address: data.address,
      port: Number(data.port || 8388),
      password: data.credential,
      method: data.method || '2022-blake3-aes-128-gcm'
    };
  } else if (data.type === 'vless') {
    payload.params = {
      address: data.address,
      port: Number(data.port || 443),
      network: data.network,
      security: data.security,
      flow: data.flow || '',
      serverName: data.serverName || '',
      path: data.network === 'ws' ? data.path || '/ws' : '',
      serviceName: data.network === 'grpc' ? data.path || '' : '',
      reality: {
        serverName: data.serverName || '',
        publicKey: data.publicKey || '',
        shortId: data.shortId || '',
        fingerprint: data.fingerprint || 'chrome',
        spiderX: ''
      }
    };
    payload.params.uuid = data.credential;
  }
  return payload;
}

async function deleteOutbound(id) {
  if (!confirm('确认删除该出站？')) return;
  try {
    await api(`/api/outbounds/${id}`, { method: 'DELETE' });
    await refreshAll();
    toast('出站已删除');
  } catch (err) { toast(err.message, true); }
}

// ---------------------------------------------------------------------------
// Routing policies
// ---------------------------------------------------------------------------

function renderRoutingPolicies() {
  const cards = state.routingPolicies.map(item => {
    const count = state.users.filter(user => user.outbound_tag === item.tag).length;
    const rules = (item.rules || []).map((rule, index) => (
      `<div class="meta">${index + 1}. ${escapeHtml(ruleDescription(rule))} → ${escapeHtml(rule.outbound_tag || '')}</div>`
    )).join('');
    return `<article class="card">
      <div class="card-top">
        <div>
          <div class="card-title">${escapeHtml(item.remark || item.tag || '未命名分流')}</div>
          <div class="card-sub">${escapeHtml(item.tag || '')}</div>
        </div>
        ${badge('auto')}
      </div>
      <div class="meta">
        <div class="meta-row"><span class="meta-label">绑定用户</span><span>${count}</span></div>
        <div class="meta-row"><span class="meta-label">规则数</span><span>${(item.rules || []).length}</span></div>
      </div>
      <div class="meta">${rules || '<span class="muted">暂无规则</span>'}</div>
      <div class="actions">
        <button class="btn" data-edit-policy="${item.id}">编辑</button>
        <button class="btn danger" data-delete-policy="${item.id}">删除</button>
      </div>
    </article>`;
  }).join('');
  document.getElementById('content').innerHTML = `<div class="page-head">
    <h1 class="page-title">分流管理</h1>
    <button class="btn primary" id="add-policy">+ 添加分流</button>
  </div>${cards ? `<div class="grid">${cards}</div>` : '<div class="empty">暂无分流策略。可以新增一个策略，将 AI 合集和兜底规则按顺序组合。</div>'}`;
  document.getElementById('add-policy').onclick = () => openRoutingPolicyModal();
  document.querySelectorAll('[data-edit-policy]').forEach(btn => btn.onclick = () => openRoutingPolicyModal(getRoutingPolicy(btn.dataset.editPolicy)));
  document.querySelectorAll('[data-delete-policy]').forEach(btn => btn.onclick = () => deleteRoutingPolicy(btn.dataset.deletePolicy));
}

function openRoutingPolicyModal(item = null) {
  if (!state.outbounds.length) return toast('请先添加真实出站', true);
  const defaultRules = [
    { id: crypto.randomUUID(), kind: 'preset', preset: 'ai', outbound_tag: firstNonBlockOutboundTag(), enabled: true },
    { id: crypto.randomUUID(), kind: 'fallback', preset: '', outbound_tag: firstNonBlockOutboundTag(), enabled: true }
  ];
  openModal(item ? '编辑分流' : '添加分流', `<form id="modal-form" class="form-grid">
    <div class="field"><label>备注</label><input class="input" name="remark" value="${escapeAttr(item ? item.remark || '' : '分流策略')}"></div>
    <div class="field"><label>Tag</label><input class="input" name="tag" value="${escapeAttr(item ? item.tag || '' : 'routing-main')}"></div>
    <div class="field full">
      <label>规则顺序</label>
      <div id="policy-rules"></div>
    </div>
    <div class="field full">
      <div class="toolbar">
        <button type="button" class="btn" data-preset="cn">🌐 国内</button>
        <button type="button" class="btn" data-preset="ai">🤖 AI</button>
        <button type="button" class="btn" data-preset="ads">📢 广告</button>
        <button type="button" class="btn" data-preset="private">🏠 私网</button>
        <button type="button" class="btn" data-preset="bt">🔽 BT</button>
        <button type="button" class="btn" id="add-manual-rule">+ 手动匹配</button>
        <button type="button" class="btn" id="add-fallback-rule">+ 兜底</button>
      </div>
    </div>
  </form>`, async () => {
    const payload = collectRoutingPolicyPayload(item);
    if (item) await api(`/api/routing-policies/${item.id}`, { method: 'PUT', body: payload });
    else await api('/api/routing-policies', { method: 'POST', body: payload });
    closeModal();
    await refreshAll();
    toast('分流策略已保存');
  });
  window.__policyRules = JSON.parse(JSON.stringify(item ? item.rules || [] : defaultRules));
  renderPolicyRuleEditors();
  document.querySelectorAll('[data-preset]').forEach(btn => {
    btn.onclick = () => {
      const preset = btn.dataset.preset;
      window.__policyRules = collectPolicyRulesFromDom();
      window.__policyRules.push({ id: crypto.randomUUID(), kind: 'preset', preset, outbound_tag: preset === 'ads' || preset === 'bt' ? 'block' : (preset === 'cn' ? 'direct' : firstNonBlockOutboundTag()), enabled: true });
      renderPolicyRuleEditors();
    };
  });
  document.getElementById('add-manual-rule').onclick = () => {
    window.__policyRules = collectPolicyRulesFromDom();
    window.__policyRules.push({ id: crypto.randomUUID(), kind: 'manual', domain: '', ip: '', protocol: '', outbound_tag: firstNonBlockOutboundTag(), enabled: true });
    renderPolicyRuleEditors();
  };
  document.getElementById('add-fallback-rule').onclick = () => {
    window.__policyRules = collectPolicyRulesFromDom();
    window.__policyRules.push({ id: crypto.randomUUID(), kind: 'fallback', outbound_tag: firstNonBlockOutboundTag(), enabled: true });
    renderPolicyRuleEditors();
  };
}

function renderPolicyRuleEditors() {
  const rules = window.__policyRules || [];
  const kindMeta = { preset: '合集', manual: '匹配', fallback: '兜底' };
  document.getElementById('policy-rules').innerHTML = rules.map((rule, index) => {
    const k = rule.kind === 'fallback' ? 'fallback' : (rule.kind === 'manual' ? 'manual' : 'preset');
    const icon = { preset: '📦', manual: '✏️', fallback: '🏁' }[k];
    return `<div class="rule-card" data-rule-index="${index}" draggable="true">
    <div class="rule-header">
      <span class="grip" title="拖动排序">⠿</span>
      <span class="rule-index ${k}">${index + 1}</span>
      <span style="font-weight:700;flex:1;font-size:12px">${icon} ${escapeHtml(ruleDescription(rule))}</span>
      ${k === 'preset' ? `<select class="select rule-preset" style="width:200px">${presetOptions(rule.preset || 'cn')}</select>` : ''}
      <select class="select rule-outbound" style="width:170px">${outboundOptions(rule.outbound_tag)}</select>
      <button type="button" class="icon-btn delete-rule" title="删除">✕</button>
    </div>
    ${k === 'manual' ? `<div class="rule-body">
      <div class="field"><label>域名 / IP / 协议</label>
        <textarea class="textarea rule-domain" rows="2" placeholder="domain:openai.com&#10;geosite:google">${escapeHtml(listToLines(rule.domain))}</textarea>
        <textarea class="textarea rule-ip" rows="2" placeholder="geoip:us&#10;1.1.1.1/32">${escapeHtml(listToLines(rule.ip))}</textarea>
        <textarea class="textarea rule-protocol" rows="1" placeholder="bittorrent">${escapeHtml(listToLines(rule.protocol))}</textarea>
      </div>
    </div>` : ''}
  </div>`;
  }).join('') || '<div class="empty">还没有规则</div>';
  bindRuleCardEvents();
}

function bindRuleCardEvents() {
  const cards = document.querySelectorAll('.rule-card');
  cards.forEach(card => {
    const index = Number(card.dataset.ruleIndex);
    card.querySelector('.delete-rule').onclick = () => {
      window.__policyRules = collectPolicyRulesFromDom().filter((_, i) => i !== index);
      renderPolicyRuleEditors();
    };
    card.addEventListener('dragstart', e => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(index));
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      card.classList.add('drag-over');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop', e => {
      e.preventDefault();
      card.classList.remove('drag-over');
      const fromIdx = Number(e.dataTransfer.getData('text/plain'));
      const toIdx = index;
      if (fromIdx === toIdx || isNaN(fromIdx)) return;
      window.__policyRules = collectPolicyRulesFromDom();
      const [item] = window.__policyRules.splice(fromIdx, 1);
      window.__policyRules.splice(toIdx, 0, item);
      renderPolicyRuleEditors();
    });
  });
}

function collectRoutingPolicyPayload(item) {
  const data = Object.fromEntries(new FormData(document.getElementById('modal-form')).entries());
  return {
    ...(item || {}),
    remark: data.remark,
    tag: data.tag,
    rules: collectPolicyRulesFromDom()
  };
}

function collectPolicyRulesFromDom() {
  const cards = document.querySelectorAll('.rule-card');
  if (!cards.length) return [];
  return Array.from(cards).map(card => {
    const idx = Number(card.dataset.ruleIndex);
    const rule = window.__policyRules[idx] || {};
    return {
      id: rule.id || crypto.randomUUID(),
      kind: rule.kind || 'preset',
      preset: rule.kind === 'preset' ? (card.querySelector('.rule-preset')?.value || rule.preset || 'ai') : undefined,
      domain: rule.kind === 'manual' ? linesToList(card.querySelector('.rule-domain')?.value || '') : undefined,
      ip: rule.kind === 'manual' ? linesToList(card.querySelector('.rule-ip')?.value || '') : undefined,
      protocol: rule.kind === 'manual' ? linesToList(card.querySelector('.rule-protocol')?.value || '') : undefined,
      outbound_tag: card.querySelector('.rule-outbound')?.value || rule.outbound_tag || 'direct',
      enabled: true
    };
  });
}

async function deleteRoutingPolicy(id) {
  if (!confirm('确认删除该分流策略？')) return;
  try {
    await api(`/api/routing-policies/${id}`, { method: 'DELETE' });
    await refreshAll();
    toast('分流策略已删除');
  } catch (err) { toast(err.message, true); }
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

async function loadPreview() {
  try {
    state.preview = await api('/api/config/preview');
  } catch (err) {
    state.preview = { error: err.message };
  }
}

function renderPreview() {
  const json = JSON.stringify(state.preview || {}, null, 2);
  document.getElementById('content').innerHTML = `<div class="page-head">
    <h1 class="page-title">配置预览</h1>
    <button class="btn" id="refresh-preview">刷新预览</button>
  </div>
  <div class="preview-layout">
    <pre class="code" id="json-preview">${highlightJson(json)}</pre>
    <aside class="side-panel">
      <button class="btn primary" id="apply-config">✅ 生成配置</button>
      <button class="btn" id="copy-json">📋 复制 JSON</button>
      <button class="btn" id="download-json">📥 下载 config.json</button>
      <button class="btn" id="copy-install-script">🚀 复制安装脚本</button>
      <button class="btn danger" id="copy-uninstall-script">🧹 复制卸载脚本</button>
    </aside>
  </div>`;
  document.getElementById('refresh-preview').onclick = async () => { await loadPreview(); renderPreview(); };
  document.getElementById('apply-config').onclick = applyConfig;
  document.getElementById('copy-json').onclick = () => copyText(json, 'JSON 已复制');
  document.getElementById('download-json').onclick = () => downloadText('config.json', json);
  document.getElementById('copy-install-script').onclick = copyInstallScript;
  document.getElementById('copy-uninstall-script').onclick = copyUninstallScript;
}

async function applyConfig() {
  try {
    const result = await api('/api/apply', { method: 'POST' });
    state.preview = result.config;
    renderPreview();
    toast('配置已生成');
  } catch (err) { toast(err.message, true); }
}

// ---------------------------------------------------------------------------
// Install / uninstall scripts
// ---------------------------------------------------------------------------

async function copyInstallScript() {
  const json = JSON.stringify(state.preview || {}, null, 2);
  const configB64 = base64Utf8(json);
  const configB64Lines = configB64.match(/.{1,76}/g) || [''];
  const lines = [
    '#!/bin/bash',
    '# Auto-install Xray-core and import the generated config',
    '# Supports: Ubuntu/Debian, CentOS/RHEL, Arch Linux',
    '',
    'set -e',
    '',
    'if [ "$EUID" -ne 0 ]; then echo "Please run as root: sudo bash install.sh"; exit 1; fi',
    '',
    'echo "[1/4] Installing Xray-core"',
    'if command -v apt-get &>/dev/null; then',
    '  apt-get update && apt-get install -y ca-certificates curl unzip',
    'elif command -v dnf &>/dev/null; then',
    '  dnf install -y ca-certificates curl unzip',
    'elif command -v yum &>/dev/null; then',
    '  yum install -y ca-certificates curl unzip',
    'elif command -v pacman &>/dev/null; then',
    '  pacman -S --noconfirm ca-certificates curl unzip',
    'else',
    '  echo "Unsupported package manager. Install curl and unzip first."; exit 1',
    'fi',
    '',
    'ARCH=$(uname -m)',
    'case $ARCH in',
    '  x86_64)  XARCH="linux-64" ;;',
    '  aarch64) XARCH="linux-arm64-v8a" ;;',
    '  armv7l)  XARCH="linux-arm32-v7a" ;;',
    '  *) echo "Unsupported architecture: $ARCH"; exit 1 ;;',
    'esac',
    '',
    'DL_URL="https://github.com/XTLS/Xray-core/releases/latest/download/Xray-${XARCH}.zip"',
    'curl -fL --retry 3 --connect-timeout 15 -o /tmp/xray.zip "$DL_URL"',
    'unzip -oq /tmp/xray.zip -d /usr/local/bin/',
    'chmod +x /usr/local/bin/xray',
    'rm -f /tmp/xray.zip',
    '',
    'echo "[2/4] Writing config"',
    'mkdir -p /usr/local/etc/xray',
    'base64 -d > /usr/local/etc/xray/config.json <<\'CONFIG_B64\'',
    ...configB64Lines,
    'CONFIG_B64',
    '/usr/local/bin/xray run -test -config /usr/local/etc/xray/config.json',
    '',
    'echo "[3/4] Creating systemd service"',
    'cat > /etc/systemd/system/xray.service <<\'UNIT\'',
    '[Unit]',
    'Description=Xray Service',
    'Documentation=https://github.com/XTLS/Xray-core',
    'After=network.target nss-lookup.target',
    '',
    '[Service]',
    'Type=simple',
    'User=nobody',
    'WorkingDirectory=/usr/local/bin',
    'Environment=XRAY_LOCATION_ASSET=/usr/local/bin',
    'CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_BIND_SERVICE',
    'AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE',
    'NoNewPrivileges=true',
    'ExecStart=/usr/local/bin/xray run -config /usr/local/etc/xray/config.json',
    'Restart=on-failure',
    'RestartSec=3',
    'LimitNOFILE=65536',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    'UNIT',
    '',
    'echo "[4/4] Starting Xray"',
    'systemctl daemon-reload',
    'systemctl enable xray',
    'systemctl restart xray',
    'sleep 1',
    'if ! systemctl is-active --quiet xray; then',
    '  echo ""',
    '  echo "============================================"',
    '  echo "  ✗ Xray 安装失败，请检查日志"',
    '  echo "============================================"',
    '  echo ""',
    '  systemctl status xray --no-pager || true',
    '  journalctl -u xray -n 80 --no-pager || true',
    '  exit 1',
    'fi',
    'echo ""',
    'echo "============================================"',
    'echo "  ✓ Xray 安装成功"',
    'echo "============================================"',
    'echo ""',
    'echo "Config: /usr/local/etc/xray/config.json"',
    'echo "journalctl -u xray -f     # 查看日志"',
    'echo "systemctl restart xray    # 重启服务"',
  ];
  const script = lines.join('\n');
  await navigator.clipboard.writeText(script);
  toast('安装脚本已复制到剪贴板，在 VPS 执行: bash install.sh');
}

async function copyUninstallScript() {
  const lines = [
    '#!/bin/bash',
    '# Remove the Xray-core service, binary, assets, and config.',
    '',
    'set -e',
    '',
    'if [ "$EUID" -ne 0 ]; then echo "Please run as root: sudo bash uninstall-xray.sh"; exit 1; fi',
    '',
    'echo "[1/3] Stopping Xray service"',
    'systemctl disable --now xray >/dev/null 2>&1 || true',
    '',
    'echo "[2/3] Removing service, binary, assets, and config"',
    'rm -f /etc/systemd/system/xray.service',
    'rm -f /usr/local/bin/xray',
    'rm -f /usr/local/bin/geosite.dat /usr/local/bin/geoip.dat',
    'rm -rf /usr/local/etc/xray',
    'rm -f /tmp/xray.zip /tmp/xray-install.generated.sh /tmp/xray-config.generated.json',
    '',
    'echo "[3/3] Reloading systemd"',
    'systemctl daemon-reload',
    'systemctl reset-failed xray >/dev/null 2>&1 || true',
    '',
    'echo ""',
    'echo "============================================"',
    'echo "  ✓ Xray 卸载成功"',
    'echo "============================================"',
  ];
  await navigator.clipboard.writeText(lines.join('\n'));
  toast('卸载脚本已复制到剪贴板，在 VPS 执行: bash uninstall-xray.sh');
}

// ---------------------------------------------------------------------------
// Modal & toast
// ---------------------------------------------------------------------------

function openModal(title, body, onSubmit, submitText = '保存') {
  document.getElementById('modal-root').innerHTML = `<div class="modal-backdrop" id="modal-backdrop">
    <section class="modal" role="dialog" aria-modal="true">
      <div class="modal-head"><strong>${escapeHtml(title)}</strong><button class="icon-btn" id="modal-close" type="button">×</button></div>
      <div class="modal-body">${body}</div>
      <div class="modal-foot"><button class="btn" id="modal-cancel" type="button">取消</button><button class="btn primary" id="modal-submit" type="button">${escapeHtml(submitText)}</button></div>
    </section>
  </div>`;
  document.getElementById('modal-close').onclick = closeModal;
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('modal-submit').onclick = async () => {
    try { await onSubmit(); } catch (err) { toast(err.message, true); }
  };
  document.getElementById('modal-backdrop').onclick = event => { if (event.target.id === 'modal-backdrop') closeModal(); };
}

function closeModal() { document.getElementById('modal-root').innerHTML = ''; window.__policyRules = null; }

function toast(message, error = false) {
  const node = document.createElement('div');
  node.className = `toast ${error ? 'error' : ''}`;
  node.textContent = message;
  document.getElementById('toast-root').appendChild(node);
  requestAnimationFrame(() => {
    node.style.opacity = '0';
    node.style.transform = 'translateY(-10px)';
    requestAnimationFrame(() => {
      node.style.opacity = '1';
      node.style.transform = 'translateY(0)';
    });
  });
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transform = 'translateY(-10px)';
    setTimeout(() => node.remove(), 220);
  }, 3000);
}

// ---------------------------------------------------------------------------
// Global listeners & bootstrap
// ---------------------------------------------------------------------------

document.addEventListener('keydown', event => { if (event.key === 'Escape') closeModal(); });
document.addEventListener('click', () => closeStrategyPickers());

initAuth().catch(err => toast(err.message, true));
