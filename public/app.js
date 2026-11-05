// SubWharf 管理面板（原生 JS，无构建链）
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const state = { me: null, subs: [], pool: { nodes: [], skipped: [], deduped: 0 }, nodes: [], links: [], editingSub: null, editingLink: null };

async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, init);
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (res.status === 401 && state.me?.initialized && !path.startsWith('/api/login')) {
    show('login');
    throw new Error('登录已过期');
  }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function show(name) {
  for (const v of ['setup', 'login', 'panel']) $('#view-' + v).classList.toggle('hidden', v !== name);
  $('#btn-logout').classList.toggle('hidden', name !== 'panel');
}

async function boot() {
  try {
    state.me = await api('/api/me');
  } catch {
    return setTimeout(boot, 1500);
  }
  if (!state.me.initialized) return show('setup');
  if (state.me.authed) {
    show('panel');
    await reload();
  } else {
    show('login');
  }
}

// ---------- 初始化 ----------

function qrSvg(text) {
  try {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  } catch {
    return '<p class="err">二维码生成失败，请手动输入密钥</p>';
  }
}

$('#form-setup').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#setup-err').textContent = '';
  const pass = $('#su-pass').value;
  if (pass !== $('#su-pass2').value) {
    $('#setup-err').textContent = '两次密码不一致';
    return;
  }
  try {
    const r = await api('/api/setup', { method: 'POST', body: { setupCode: $('#su-code').value, password: pass } });
    $('#form-setup').classList.add('hidden');
    $('#setup-totp').classList.remove('hidden');
    $('#totp-secret').textContent = r.secret;
    $('#qr').innerHTML = qrSvg(r.otpauth);
  } catch (e) {
    $('#setup-err').textContent = e.message;
  }
});

$('#btn-copy-secret').addEventListener('click', async () => {
  await copyText($('#totp-secret').textContent);
  $('#btn-copy-secret').textContent = '已复制';
  setTimeout(() => ($('#btn-copy-secret').textContent = '复制密钥'), 1500);
});

$('#form-verify').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#verify-err').textContent = '';
  try {
    await api('/api/setup/verify', { method: 'POST', body: { code: $('#vf-code').value } });
    show('panel');
    await reload();
  } catch (e) {
    $('#verify-err').textContent = e.message;
  }
});

// ---------- 登录 / 退出 ----------

$('#form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-err').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: { password: $('#li-pass').value, code: $('#li-code').value } });
    show('panel');
    await reload();
  } catch (e) {
    $('#login-err').textContent = e.message;
  }
});

$('#btn-logout').addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST' });
  } catch {}
  show('login');
});

// ---------- Tab 切换 ----------

$$('#tabs button').forEach((b) =>
  b.addEventListener('click', () => {
    $$('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
    for (const t of ['subs', 'pool', 'nodes', 'links']) $('#tab-' + t).classList.toggle('hidden', t !== b.dataset.tab);
  })
);

// ---------- 数据加载 ----------

async function reload() {
  const [status, poolR, nodesR, linksR] = await Promise.all([
    api('/api/status'),
    api('/api/pool'),
    api('/api/nodes'),
    api('/api/links'),
  ]);
  state.subs = status.subs;
  state.pool = poolR;
  state.nodes = nodesR.nodes;
  state.links = linksR.links;
  renderSubs();
  renderPool();
  renderNodes();
  renderLinks();
}

// ---------- 订阅 ----------

function fmtBytes(n) {
  if (n === undefined || n === null) return '未知';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '从未';
}

function expireInfo(u) {
  if (!u?.expire) return '';
  const days = Math.floor((u.expire * 1000 - Date.now()) / 86400000);
  return days <= 0 ? '已到期' : `剩余 ${days} 天`;
}

function trafficBar(u) {
  if (!u || !u.total) return '<span class="dim">流量未知</span>';
  const used = u.upload + u.download;
  const pct = Math.min(100, Math.round((used / u.total) * 100));
  return `<div class="bar"><div class="bar-fill ${pct > 90 ? 'warn' : ''}" style="width:${pct}%"></div></div>
    <span class="dim">${fmtBytes(used)} / ${fmtBytes(u.total)} · ${pct}% ${expireInfo(u)}</span>`;
}

function renderSubs() {
  const el = $('#sub-list');
  if (!state.subs.length) {
    el.innerHTML = '<p class="dim">还没有订阅，点击「新增订阅」添加。抓取由 cron 每天 09:00 / 21:00（北京时间）自动执行。</p>';
    return;
  }
  el.innerHTML = state.subs
    .map((s) => {
      const rules = [
        s.clean ? '名称清洗' : '保留原名',
        s.include ? `包含 ${esc(s.include)}` : '',
        s.exclude ? `排除 ${esc(s.exclude)}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      return `
    <div class="card" data-id="${s.id}">
      <div class="row">
        <strong>${esc(s.name)}</strong>
        <span class="badge">${s.format === 'clash' ? 'Clash YAML' : 'base64/URI'}</span>
        <span class="badge ${s.enabled ? 'ok' : 'off'}">${s.enabled ? '已启用' : '已停用'}</span>
        <span class="grow"></span>
        <button data-act="nodes">查看节点</button>
        <button data-act="edit">编辑</button>
        <button data-act="refresh">刷新</button>
        <button data-act="toggle">${s.enabled ? '停用' : '启用'}</button>
        <button data-act="del" class="danger">删除</button>
      </div>
      <div class="row dim">节点 ${s.snap?.nodeCount ?? 0} 个 · 上次抓取 ${fmtTime(s.snap?.fetchedAt)}</div>
      <div class="row dim">节点规则：${rules}</div>
      ${s.snap?.error ? `<div class="row err">✘ ${esc(s.snap.error)}（${fmtTime(s.snap.errorAt)}，保留上次成功快照）</div>` : ''}
      ${s.snap?.skipped?.length ? `<div class="row dim">跳过：${esc(s.snap.skipped.join('；'))}</div>` : ''}
      ${s.snap?.userinfo ? `<div class="row">${trafficBar(s.snap.userinfo)}</div>` : ''}
    </div>`;
    })
    .join('');
}

$('#sub-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.card').dataset.id;
  const s = state.subs.find((x) => x.id === id);
  try {
    if (btn.dataset.act === 'nodes') return openNodesDialog(s);
    if (btn.dataset.act === 'edit') return openSubDialog(s);
    if (btn.dataset.act === 'refresh') {
      await api(`/api/subs/${id}/refresh`, { method: 'POST' });
      return reload();
    }
    if (btn.dataset.act === 'toggle') {
      await api(`/api/subs/${id}`, { method: 'PUT', body: { name: s.name, ua: s.ua || '', format: s.format, enabled: !s.enabled } });
      return reload();
    }
    if (btn.dataset.act === 'del' && confirm(`删除订阅「${s.name}」？（其快照一并删除）`)) {
      await api(`/api/subs/${id}`, { method: 'DELETE' });
      return reload();
    }
  } catch (e) {
    alert(e.message);
  }
});

function openSubDialog(s) {
  state.editingSub = s?.id ?? null;
  $('#sub-title').textContent = s ? '编辑订阅' : '新增订阅';
  $('#sub-err').textContent = '';
  $('#sub-name').value = s?.name ?? '';
  $('#sub-url').value = '';
  $('#sub-url').placeholder = s ? '留空表示不修改' : 'https://…';
  $('#sub-ua').value = s?.ua ?? '';
  $('#sub-format').value = s?.format ?? 'base64';
  $('#sub-include').value = s?.include ?? '';
  $('#sub-exclude').value = s?.exclude ?? '';
  $('#sub-clean').checked = s ? s.clean !== false : true;
  $('#sub-enabled').checked = s ? s.enabled : true;
  $('#dlg-sub').showModal();
}

$('#btn-add-sub').addEventListener('click', () => openSubDialog(null));

$('#form-sub').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#sub-err').textContent = '';
  const body = {
    name: $('#sub-name').value,
    ua: $('#sub-ua').value,
    format: $('#sub-format').value,
    include: $('#sub-include').value,
    exclude: $('#sub-exclude').value,
    clean: $('#sub-clean').checked,
    enabled: $('#sub-enabled').checked,
  };
  for (const [key, label] of [
    ['include', '包含正则'],
    ['exclude', '排除正则'],
  ]) {
    const v = body[key].trim();
    if (v) {
      try {
        new RegExp(v);
      } catch (e) {
        $('#sub-err').textContent = `${label}无效：${e.message}`;
        return;
      }
    }
  }
  const url = $('#sub-url').value.trim();
  if (url) body.url = url;
  if (!url && !state.editingSub) {
    $('#sub-err').textContent = '新增订阅必须填写 URL';
    return;
  }
  try {
    if (state.editingSub) await api(`/api/subs/${state.editingSub}`, { method: 'PUT', body });
    else await api('/api/subs', { method: 'POST', body });
    $('#dlg-sub').close();
    await reload();
  } catch (e) {
    $('#sub-err').textContent = e.message;
  }
});

$('#sub-cancel').addEventListener('click', () => $('#dlg-sub').close());

$('#btn-refresh-all').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = '刷新中…';
  try {
    await api('/api/refresh-all', { method: 'POST' });
    await reload();
  } catch (e) {
    alert(e.message);
  }
  btn.disabled = false;
  btn.textContent = '立即刷新全部';
});

// ---------- 节点池（清洗后） ----------

function renderPool() {
  const q = $('#pool-filter').value.trim();
  let re = null;
  if (q) {
    try {
      re = new RegExp(q);
    } catch (e) {
      $('#pool-count').textContent = '正则无效：' + e.message;
      $('#pool-list').innerHTML = '';
      return;
    }
  }
  const all = state.pool.nodes;
  const list = re ? all.filter((n) => re.test(n.name)) : all;
  const stats = [`共 ${all.length} 个`];
  if (state.pool.deduped) stats.push(`内容去重 ${state.pool.deduped} 个`);
  if (state.pool.skipped?.length) stats.push(`跳过：${state.pool.skipped.join('；')}`);
  $('#pool-count').textContent = (re ? `匹配 ${list.length} / ` : '') + stats.join(' · ');
  $('#pool-list').innerHTML =
    list
      .map((n) => {
        const changed = n.name !== `[${n.source}] ${n.original}`;
        return `
    <div class="row node-row">
      <span class="badge">${esc(n.type)}</span>
      <span class="grow">${esc(n.name)}</span>
      ${changed ? `<span class="dim">原名 ${esc(n.original)}</span>` : ''}
      <span class="dim">${esc(n.source)} · ${esc(n.server)}:${n.port}</span>
    </div>`;
      })
      .join('') || '<p class="dim">无匹配节点</p>';
}

$('#pool-filter').addEventListener('input', renderPool);

// ---------- 节点查看（正则筛选） ----------

const nodesView = { subId: null, all: [] };

async function openNodesDialog(s) {
  nodesView.subId = s.id;
  nodesView.all = [];
  $('#nodes-title').textContent = `节点 · ${s.name}`;
  $('#nodes-filter').value = '';
  $('#nodes-err').textContent = '';
  $('#nodes-count').textContent = '加载中…';
  $('#nodes-list').innerHTML = '';
  $('#dlg-nodes').showModal();
  try {
    const r = await api(`/api/subs/${s.id}/nodes`);
    nodesView.all = r.nodes;
    renderNodesView();
  } catch (e) {
    $('#nodes-err').textContent = e.message;
    $('#nodes-count').textContent = '';
  }
}

function renderNodesView() {
  const q = $('#nodes-filter').value.trim();
  let re = null;
  if (q) {
    try {
      re = new RegExp(q);
      $('#nodes-err').textContent = '';
    } catch (e) {
      $('#nodes-err').textContent = '正则无效：' + e.message;
      $('#nodes-count').textContent = `共 ${nodesView.all.length} 个`;
      $('#nodes-list').innerHTML = '';
      return;
    }
  }
  const list = re ? nodesView.all.filter((n) => re.test(n.name)) : nodesView.all;
  $('#nodes-count').textContent = `匹配 ${list.length} / 共 ${nodesView.all.length} 个`;
  $('#nodes-list').innerHTML =
    list
      .map(
        (n) => `
    <div class="row node-row">
      <span class="badge">${esc(n.type)}</span>
      <span class="grow">${esc(n.name)}</span>
      <span class="dim">${esc(n.server)}:${n.port}</span>
    </div>`
      )
      .join('') || '<p class="dim">无匹配节点</p>';
}

$('#nodes-filter').addEventListener('input', renderNodesView);
$('#nodes-close').addEventListener('click', () => $('#dlg-nodes').close());

// ---------- 自建节点 ----------

function renderNodes() {
  const el = $('#node-list');
  if (!state.nodes.length) {
    el.innerHTML = '<p class="dim">还没有自建节点。</p>';
    return;
  }
  el.innerHTML = state.nodes
    .map(
      (r) => `
    <div class="card row" data-id="${r.id}">
      <span class="badge">${esc(r.node.type)}</span>
      <strong>${esc(r.node.name)}</strong>
      <span class="dim">${esc(r.node.server)}:${r.node.port}</span>
      <span class="grow"></span>
      <button data-act="del" class="danger">删除</button>
    </div>`
    )
    .join('');
}

$('#btn-add-nodes').addEventListener('click', async () => {
  const uris = $('#node-uris').value.trim();
  if (!uris) return;
  try {
    const r = await api('/api/nodes', { method: 'POST', body: { uris } });
    $('#node-uris').value = '';
    $('#node-msg').textContent = `已添加 ${r.added} 个` + (r.skipped.length ? `；跳过：${r.skipped.join('；')}` : '');
    await reload();
  } catch (e) {
    $('#node-msg').textContent = e.message;
  }
});

$('#node-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act="del"]');
  if (btn && confirm('删除该节点？')) {
    await api(`/api/nodes/${btn.closest('.card').dataset.id}`, { method: 'DELETE' });
    await reload();
  }
});

// ---------- 输出链接 ----------

function linkUrl(l) {
  return `${location.origin}/s/${l.token}`;
}

function sourceNames(l) {
  const names = l.sources.map((id) => state.subs.find((s) => s.id === id)?.name ?? '?');
  if (l.includeCustom) names.push('自建节点');
  return names.join('、') || '（无）';
}

function renderLinks() {
  const el = $('#link-list');
  if (!state.links.length) {
    el.innerHTML = '<p class="dim">还没有输出链接。链接 token 即订阅凭据，泄露后可一键重置。</p>';
    return;
  }
  el.innerHTML = state.links
    .map((l) => {
      const filt = [l.include ? `含 ${l.include}` : '', l.exclude ? `排除 ${l.exclude}` : ''].filter(Boolean).join('，');
      return `
    <div class="card" data-token="${l.token}">
      <div class="row">
        <strong>${esc(l.label)}</strong>
        <span class="badge">${l.target}</span>
        <span class="badge">${l.rules === 'cn' ? '绕华直连' : '纯代理'}</span>
        <span class="badge ${l.enabled ? 'ok' : 'off'}">${l.enabled ? '启用' : '停用'}</span>
        <span class="grow"></span>
        <button data-act="copy">复制链接</button>
        <button data-act="edit">编辑</button>
        <button data-act="reset">重置 Token</button>
        <button data-act="toggle">${l.enabled ? '停用' : '启用'}</button>
        <button data-act="del" class="danger">删除</button>
      </div>
      <div class="row dim">来源：${esc(sourceNames(l))}${filt ? ` · 筛选：${esc(filt)}` : ''} · 支持 ?target=clash|singbox|base64|uri&amp;rules=cn|none 覆盖</div>
      <div class="row"><code class="grow">${esc(linkUrl(l))}</code></div>
    </div>`;
    })
    .join('');
}

async function copyText(t) {
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {}
  const ta = document.createElement('textarea');
  ta.value = t;
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  return ok;
}

$('#link-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const token = btn.closest('.card').dataset.token;
  const l = state.links.find((x) => x.token === token);
  try {
    if (btn.dataset.act === 'copy') {
      const ok = await copyText(linkUrl(l));
      if (!ok) prompt('请手动复制：', linkUrl(l));
      return;
    }
    if (btn.dataset.act === 'edit') return openLinkDialog(l);
    if (btn.dataset.act === 'reset' && confirm(`重置「${l.label}」的 token？旧链接立即失效。`)) {
      await api(`/api/links/${token}/reset`, { method: 'POST' });
      return reload();
    }
    if (btn.dataset.act === 'toggle') {
      await api(`/api/links/${token}`, { method: 'PUT', body: { ...l, enabled: !l.enabled } });
      return reload();
    }
    if (btn.dataset.act === 'del' && confirm(`删除链接「${l.label}」？`)) {
      await api(`/api/links/${token}`, { method: 'DELETE' });
      return reload();
    }
  } catch (e) {
    alert(e.message);
  }
});

function openLinkDialog(l) {
  state.editingLink = l?.token ?? null;
  $('#link-title').textContent = l ? '编辑链接' : '新增链接';
  $('#link-err').textContent = '';
  $('#link-label').value = l?.label ?? '';
  $('#link-target').value = l?.target ?? 'clash';
  $('#link-rules').value = l?.rules ?? 'none';
  $('#link-rsource').value = l?.ruleSource ?? 'official';
  $('#link-include').value = l?.include ?? '';
  $('#link-exclude').value = l?.exclude ?? '';
  $('#link-enabled').checked = l ? l.enabled : true;
  $('#link-sources').innerHTML = state.subs
    .map(
      (s) => `
    <label class="chk"><input type="checkbox" value="${s.id}" ${l?.sources?.includes(s.id) ? 'checked' : ''}> ${esc(s.name)}</label>`
    )
    .join('') || '<span class="dim">暂无订阅，可仅输出自建节点</span>';
  $('#link-custom').checked = l ? l.includeCustom : true;
  toggleRsource();
  $('#dlg-link').showModal();
}

function toggleRsource() {
  $('#rsource-row').classList.toggle('hidden', $('#link-rules').value !== 'cn');
}

$('#link-rules').addEventListener('change', toggleRsource);
$('#btn-add-link').addEventListener('click', () => openLinkDialog(null));

$('#form-link').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#link-err').textContent = '';
  const body = {
    label: $('#link-label').value,
    target: $('#link-target').value,
    rules: $('#link-rules').value,
    ruleSource: $('#link-rsource').value,
    sources: $$('#link-sources input:checked').map((i) => i.value),
    includeCustom: $('#link-custom').checked,
    enabled: $('#link-enabled').checked,
    include: $('#link-include').value,
    exclude: $('#link-exclude').value,
  };
  for (const [key, label] of [['include', '包含正则'], ['exclude', '排除正则']]) {
    const v = body[key].trim();
    if (v) {
      try {
        new RegExp(v);
      } catch (e) {
        $('#link-err').textContent = `${label}无效：${e.message}`;
        return;
      }
    }
  }
  try {
    if (state.editingLink) await api(`/api/links/${state.editingLink}`, { method: 'PUT', body });
    else await api('/api/links', { method: 'POST', body });
    $('#dlg-link').close();
    await reload();
  } catch (e) {
    $('#link-err').textContent = e.message;
  }
});

$('#link-cancel').addEventListener('click', () => $('#dlg-link').close());

boot();
