const $ = (id) => document.getElementById(id);
const form = $('checkoutForm');
const privateMode = location.pathname.replace(/\/+$/, '') === '/private-checkout';
let batchTasks = [];
let batchPollTimer = 0;
let batchPollInFlight = false;
let activeTaskKey = '';
let countdownTimer = 0;
let paypalRedirectTimer = 0;
let paypalWindow = null;
let proxySaveTimer = 0;
let logAutoFollow = true;
let renderedLogKey = '';
let roxyLaunchToken = '';
let roxySessionId = '';
let roxyProfileId = '';
let phShortProxyLoaded = false;
let phShortProxyPromise = null;
let accountLoadVersion = 0;
let importedAccountToken = '';
let importedAccount = null;
let importedAccounts = [];

const PROXY_STORAGE_KEYS = {
  entry: 'pay153.proxy_pool_1',
  exit: 'pay153.proxy_pool_2'
};

const providerDefaults = {
  hosted: {country: 'US', currency: 'USD'}, paypal: {country: 'US', currency: 'USD'},
  ideal: {country: 'NL', currency: 'EUR'}, upi: {country: 'IN', currency: 'INR'},
  pix: {country: 'BR', currency: 'BRL'}, momo: {country: 'VN', currency: 'VND'}, gcash: {country: 'PH', currency: 'PHP'}, kakao: {country: 'KR', currency: 'KRW'},
  ph_short: {country: 'PH', currency: 'PHP'}
};
const countryCurrency = {US:'USD',DE:'EUR',FR:'EUR',NL:'EUR',IN:'INR',BR:'BRL',VN:'VND',GB:'GBP',JP:'JPY',KR:'KRW',PH:'PHP',AU:'AUD',CA:'CAD'};

function proxyLines(node){
  return node.value.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
}
function updateProxyCount(node, counter){
  const count = proxyLines(node).length;
  counter.textContent = `${count} / 500`;
  counter.classList.toggle('over-limit', count > 500);
  node.setCustomValidity(count > 500 ? '每个代理池最多填写 500 条' : '');
  return count;
}
function setProxySaveState(text, failed=false){
  const node = $('proxySaveState');
  node.textContent = text;
  node.classList.toggle('save-failed', failed);
}
function saveProxyPools(successText='已保存到本机'){
  clearTimeout(proxySaveTimer);
  proxySaveTimer = setTimeout(() => {
    try {
      localStorage.setItem(PROXY_STORAGE_KEYS.entry, $('entryProxy').value);
      localStorage.setItem(PROXY_STORAGE_KEYS.exit, $('exitProxy').value);
      setProxySaveState(successText);
    } catch (error) {
      setProxySaveState('本地保存失败', true);
    }
  }, 220);
}
function restoreProxyPools(){
  try {
    const entry = localStorage.getItem(PROXY_STORAGE_KEYS.entry);
    const exit = localStorage.getItem(PROXY_STORAGE_KEYS.exit);
    if (entry !== null) $('entryProxy').value = entry;
    if (exit !== null) $('exitProxy').value = exit;
    setProxySaveState(entry !== null || exit !== null ? '已恢复本地代理' : '本地自动保存');
  } catch (error) {
    setProxySaveState('本地保存不可用', true);
  }
}

function selected(name){ return form.querySelector(`input[name="${name}"]:checked`)?.value || ''; }
function bindChoices(group, onChange){
  group.querySelectorAll('label').forEach(label => label.addEventListener('click', () => {
    group.querySelectorAll('label').forEach(x => x.classList.remove('active'));
    label.classList.add('active');
    setTimeout(onChange, 0);
  }));
}
bindChoices($('planGrid'), () => syncFields(false));
bindChoices($('railGrid'), () => {
  syncFields(true);
  if (selected('link_type') === 'ph_short') loadPhShortProxies(true);
});

function selectedAccountTypes(){
  return [...document.querySelectorAll('input[name="accountType"]:checked')].map(node => node.value);
}

function accountTypeLabels(types){
  const labels = {free:'Free', plus_trial:'Plus 试用', oaics:'OAICS'};
  return (types || []).map(type => labels[type] || type);
}

function parallelCount(){
  const input = $('parallelCount');
  const value = Math.max(1, Math.min(3, Number(input.value) || 3));
  input.value = String(value);
  return value;
}

function selectedBatchAccounts(){
  const selectedId = String($('accountSelect').value || '');
  const primary = importedAccounts.find(item => String(item.id) === selectedId);
  const ordered = primary
    ? [primary, ...importedAccounts.filter(item => String(item.id) !== selectedId)]
    : [...importedAccounts];
  return ordered.slice(0, parallelCount());
}

function decodeJwtPayload(token){
  try {
    const part = String(token || '').split('.')[1] || '';
    const padded = part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - part.length % 4) % 4);
    const bytes = Uint8Array.from(atob(padded), char => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    return {};
  }
}

function parseTokenIdentity(raw){
  const text = String(raw || '').trim();
  if (!text) return null;
  let token = '';
  let meta = {};
  if (text.startsWith('{')) {
    try {
      const data = JSON.parse(text);
      token = String(data.accessToken || data.access_token || '');
      meta = data.account && typeof data.account === 'object' ? data.account : {};
      if (!meta.email && data.user && typeof data.user === 'object') meta.email = data.user.email || '';
    } catch (error) {
      return null;
    }
  }
  if (!token) {
    const match = text.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    token = match ? match[0] : text.split(/\r?\n/)[0].trim();
  }
  if (token.split('.').length < 3) return null;
  const claims = decodeJwtPayload(token);
  const auth = claims['https://api.openai.com/auth'] || {};
  const profile = claims['https://api.openai.com/profile'] || {};
  return {
    email: String(claims.email || profile.email || meta.email || ''),
    accountId: String(auth.chatgpt_account_id || meta.id || ''),
  };
}

function setTokenHint(text, state='idle', title=''){
  const node = $('tokenHint');
  node.textContent = text;
  node.className = `account-import-status ${state}`;
  node.title = title || text;
}

function updateTokenSourceStatus(fallbackText='未导入账号', fallbackState='idle'){
  const manual = $('token').value.trim();
  $('token').required = !importedAccountToken;
  if (manual) {
    const identity = parseTokenIdentity(manual);
    const label = identity?.email || identity?.accountId || '账号信息待提交校验';
    setTokenHint(`手动 AT：${label}`, 'manual', identity?.email && identity?.accountId ? `${identity.email} · ${identity.accountId}` : label);
    return;
  }
  const batch = selectedBatchAccounts();
  if (importedAccountToken && importedAccount && batch.length) {
    const emails = batch.map(item => item.email).filter(Boolean);
    setTokenHint(`已导入：${batch.length} 个账号`, 'imported', emails.join(' · '));
    return;
  }
  setTokenHint(fallbackText, fallbackState);
}

function clearImportedAccount(message='未导入账号', state='idle'){
  importedAccountToken = '';
  importedAccount = null;
  updateTokenSourceStatus(message, state);
}

async function loadAccountToken(accountId, version=accountLoadVersion){
  if (!accountId) return;
  const select = $('accountSelect');
  const types = selectedAccountTypes();
  select.disabled = true;
  try {
    const query = encodeURIComponent(types.join(','));
    const response = await fetch(`/api/pay153/accounts/${encodeURIComponent(accountId)}/token?types=${query}`, {cache:'no-store'});
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
    if (version !== accountLoadVersion) return;
    importedAccountToken = data.access_token || '';
    importedAccount = data;
    $('token').value = '';
    updateTokenSourceStatus();
  } catch (error) {
    if (version !== accountLoadVersion) return;
    clearImportedAccount(error.message || String(error), 'error');
  } finally {
    if (version === accountLoadVersion) select.disabled = false;
  }
}

async function loadAccounts(){
  const version = ++accountLoadVersion;
  const select = $('accountSelect');
  const refresh = $('refreshAccounts');
  const types = selectedAccountTypes();
  clearImportedAccount('正在匹配账号');
  if (!types.length) {
    importedAccounts = [];
    select.innerHTML = '<option value="">请先勾选账号类型</option>';
    select.disabled = true;
    updateTokenSourceStatus('请选择 Free、Plus 试用或 OAICS');
    return;
  }
  refresh.disabled = true;
  select.disabled = true;
  try {
    const response = await fetch(`/api/pay153/accounts?types=${encodeURIComponent(types.join(','))}`, {cache:'no-store'});
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
    if (version !== accountLoadVersion) return;
    const items = Array.isArray(data.items) ? data.items : [];
    importedAccounts = items;
    select.innerHTML = items.length
      ? items.map(item => {
          const labels = item.type_labels || accountTypeLabels(item.types);
          return `<option value="${escapeHtml(item.id)}">${escapeHtml(item.email)} · ${escapeHtml(labels.join(' / '))}</option>`;
        }).join('')
      : '<option value="">没有符合条件的账号</option>';
    select.disabled = !items.length;
    if (items.length) {
      select.value = String(data.selected_id || items[0].id);
      await loadAccountToken(select.value, version);
    } else {
      importedAccounts = [];
      updateTokenSourceStatus('没有符合条件的账号');
    }
  } catch (error) {
    if (version !== accountLoadVersion) return;
    importedAccounts = [];
    select.innerHTML = '<option value="">手动输入 Access Token</option>';
    clearImportedAccount(error.message || String(error), 'error');
  } finally {
    if (version === accountLoadVersion) refresh.disabled = false;
  }
}

async function loadPhShortProxies(force=false){
  if (selected('link_type') !== 'ph_short') return;
  if (phShortProxyLoaded && !force) return;
  if (phShortProxyPromise) return phShortProxyPromise;
  phShortProxyPromise = (async () => {
    setProxySaveState('正在读取 US / TR 代理');
    try {
      const response = await fetch('/api/pay153/ph-short-proxies', {cache:'no-store'});
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      $('entryProxy').value = (data.entry_proxies || []).join('\n');
      $('exitProxy').value = (data.exit_proxies || []).join('\n');
      updateProxyCount($('entryProxy'), $('entryProxyCount'));
      updateProxyCount($('exitProxy'), $('exitProxyCount'));
      phShortProxyLoaded = true;
      saveProxyPools(`已导入 US ${data.entry_count || 0} / TR ${data.exit_count || 0}`);
    } catch (error) {
      phShortProxyLoaded = false;
      setProxySaveState(error.message || String(error), true);
      throw error;
    } finally {
      phShortProxyPromise = null;
    }
  })();
  return phShortProxyPromise;
}

function syncFields(applyRailDefault=false){
  const plan = selected('plan'), rail = selected('link_type');
  $('teamFields').hidden = plan !== 'team';
  $('codexFields').hidden = plan !== 'codex_low';
  $('idealOptions').hidden = rail !== 'ideal';
  $('paypalOptions').hidden = rail !== 'paypal';
  $('pixOptions').hidden = rail !== 'pix';
  $('regionFields').hidden = rail === 'paypal';
  $('regionAutoHint').hidden = rail !== 'paypal';
  $('pixTaxId').required = false;
  const promoSupported = plan === 'plus';
  $('promoLine').style.display = promoSupported ? 'flex' : 'none';
  $('plusPromoFields').hidden = !promoSupported || !$('usePromo').checked;
  const needsExit = rail !== 'hosted' && rail !== 'pix' && rail !== 'momo';
  $('proxyGrid').classList.toggle('single', !needsExit);
  $('exitProxyField').hidden = !needsExit;
  $('exitProxy').required = needsExit;
  $('copyEntryProxy').hidden = !needsExit;
  const recommendations = {
    hosted: '推荐代理：使用账号常用地区。',
    ph_short: '推荐代理：代理池 1 使用 US 创建 PH/PHP Checkout，代理池 2 使用 TR 应用优惠。',
    paypal: '\u63a8\u8350\u4ee3\u7406\uff1a\u7cfb\u7edf\u4f18\u5148\u4f7f\u7528\u4ee3\u7406\u6c60 2 \u5f53\u524d\u56fd\u5bb6\u7684 PayPal \u8d26\u5355\uff1b\u82e5\u8be5\u56fd\u5bb6 Checkout \u672a\u5f00\u653e PayPal\uff0c\u5219\u81ea\u52a8\u56de\u9000\u5fb7\u56fd DE/EUR \u8d26\u5355\u3002',
    ideal: '推荐代理：两个代理池均使用 NL。',
    upi: '推荐代理：代理池 1 使用可获得优惠资格的国家或地区（如 TR、JP、BR），代理池 2 使用 IN 创建并处理 UPI。',
    pix: '推荐代理：代理池 1 使用 BR。',
    momo: '推荐代理：代理池 1 全程使用 VN，Checkout、优惠、Stripe 与确认均保持同一条越南线路。',
    gcash: '推荐代理：代理池 1 使用 US 创建 PH/PHP 账单，代理池 2 使用你选择的优惠国家。',
    kakao: '推荐代理：代理池 1 使用 VN 应用优惠，代理池 2 使用 KR 创建并处理 Kakao Pay。'
  };
  const pool2Hints = {ph_short:'必须 TR',paypal:'巴西 PayPal 推荐 BR',ideal:'推荐 NL',upi:'推荐 IN',kakao:'推荐 KR'};
  const recommendation = recommendations[rail] || '推荐代理：使用与所选地区一致的代理。';
  $('proxyRecommendation').textContent = recommendation;
  $('proxyFootHint').textContent = recommendation;
  $('exitProxyHint').textContent = pool2Hints[rail] || '推荐同地区';
  if (applyRailDefault && providerDefaults[rail]) {
    $('country').value = providerDefaults[rail].country;
    $('currency').value = providerDefaults[rail].currency;
  }
}
$('country').addEventListener('change', () => $('currency').value = countryCurrency[$('country').value] || 'USD');
$('usePromo').addEventListener('change', () => syncFields(false));
$('entryProxy').addEventListener('input', () => { phShortProxyLoaded = false; updateProxyCount($('entryProxy'), $('entryProxyCount')); saveProxyPools(); });
$('exitProxy').addEventListener('input', () => { phShortProxyLoaded = false; updateProxyCount($('exitProxy'), $('exitProxyCount')); saveProxyPools(); });
$('accountSelect').addEventListener('change', () => loadAccountToken($('accountSelect').value));
$('refreshAccounts').addEventListener('click', loadAccounts);
document.querySelectorAll('input[name="accountType"]').forEach(node => node.addEventListener('change', loadAccounts));
$('token').addEventListener('input', () => updateTokenSourceStatus());
$('parallelCount').addEventListener('change', () => updateTokenSourceStatus());
$('copyEntryProxy').addEventListener('click', () => {
  $('exitProxy').value = $('entryProxy').value.trim();
  updateProxyCount($('exitProxy'), $('exitProxyCount'));
  saveProxyPools();
  $('exitProxy').focus();
});

function taskIsTerminal(task){
  return ['done', 'error', 'cancelled'].includes(task.status);
}
function taskStatusLabel(status){
  return status === 'done' ? '完成' : status === 'error' ? '异常' : status === 'cancelled' ? '已停止' : status === 'queued' ? '排队中' : status === 'running' ? '运行中' : '创建中';
}
function taskStatusClass(status){
  return ['done', 'error', 'cancelled', 'running'].includes(status) ? status : 'queued';
}
function renderTaskProgress(){
  const list = $('taskProgressList');
  if (!batchTasks.length) {
    list.innerHTML = '<div class="task-progress-empty">选择账号后开始任务</div>';
    return;
  }
  list.innerHTML = batchTasks.map(task => {
    const percent = Math.max(0, Math.min(100, Number(task.percent) || 0));
    const statusClass = taskStatusClass(task.status);
    return `<button class="task-progress-item ${statusClass}${task.key === activeTaskKey ? ' active' : ''}" type="button" data-task-key="${escapeHtml(task.key)}">
      <span class="task-progress-head"><strong>${escapeHtml(task.email || '手动账号')}</strong><span>${taskStatusLabel(task.status)} · ${Math.round(percent)}%</span></span>
      <span class="task-progress-bar" aria-hidden="true"><i style="width:${percent}%"></i></span>
      <span class="task-progress-meta"><span>${escapeHtml(task.text || '等待提交')}</span><span>${task.queuePosition > 0 ? `队列 ${task.queuePosition}` : ''}</span></span>
    </button>`;
  }).join('');
}
function updateBatchSummary(){
  const badge = $('statusBadge');
  if (!batchTasks.length) {
    badge.className = 'status-badge idle';
    badge.textContent = '等待';
    return;
  }
  const total = batchTasks.length;
  const running = batchTasks.filter(task => !taskIsTerminal(task)).length;
  const done = batchTasks.filter(task => task.status === 'done').length;
  const failed = batchTasks.filter(task => task.status === 'error').length;
  const cancelled = batchTasks.filter(task => task.status === 'cancelled').length;
  let status = 'running';
  let text = `运行 ${running}/${total}`;
  if (running === 0 && failed > 0) { status = 'error'; text = `异常 ${failed}/${total}`; }
  else if (running === 0 && done === total) { status = 'done'; text = `完成 ${done}/${total}`; }
  else if (running === 0 && cancelled === total) { status = 'cancelled'; text = '已停止'; }
  else if (running === 0) { status = 'done'; text = `结束 ${done}/${total}`; }
  badge.className = `status-badge ${status}`;
  badge.textContent = text;
}
function renderLogs(logs){
  const box = $('logBox');
  if (!logs?.length) {
    const emptyKey = `${activeTaskKey}|empty`;
    if (renderedLogKey !== emptyKey) box.innerHTML = '<div class="empty-log">该账号暂无日志。</div>';
    renderedLogKey = emptyKey;
    return;
  }
  const nextKey = `${activeTaskKey}|${logs.map(x => `${x.time}|${x.message}`).join('\n')}`;
  if (nextKey === renderedLogKey) return;
  const previousTop = box.scrollTop;
  const wasFollowing = logAutoFollow;
  box.innerHTML = logs.map(x => `<div class="log-row"><time>${escapeHtml(x.time)}</time><span>${escapeHtml(x.message)}</span></div>`).join('');
  renderedLogKey = nextKey;
  if (wasFollowing) box.scrollTop = box.scrollHeight;
  else box.scrollTop = previousTop;
}
function escapeHtml(v){ return String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function renderActiveTask(allowRedirect=false){
  const task = batchTasks.find(item => item.key === activeTaskKey);
  $('activeLogAccount').textContent = task?.email || '等待任务';
  renderedLogKey = '';
  renderLogs(task?.logs || []);
  if (task?.result) showResult(task.result, {allowRedirect, scroll:false});
  else $('resultPanel').hidden = true;
}
function selectTask(taskKey){
  if (!batchTasks.some(task => task.key === taskKey)) return;
  activeTaskKey = taskKey;
  renderTaskProgress();
  renderActiveTask(false);
}
function setRunning(running){
  $('submitButton').disabled = running;
  $('cancelButton').hidden = !running;
  $('parallelCount').disabled = running;
  $('accountSelect').disabled = running || !importedAccounts.length;
  $('refreshAccounts').disabled = running;
  $('token').disabled = running;
  document.querySelectorAll('input[name="accountType"]').forEach(node => { node.disabled = running; });
}
$('taskProgressList').addEventListener('click', event => {
  const button = event.target.closest('[data-task-key]');
  if (button) selectTask(button.dataset.taskKey);
});
$('logBox').addEventListener('scroll', () => {
  const box = $('logBox');
  logAutoFollow = box.scrollHeight - box.clientHeight - box.scrollTop < 28;
});

function showResult(result, {allowRedirect=false, scroll=false}={}){
  clearTimeout(paypalRedirectTimer);
  $('resultPanel').hidden = false;
  $('resultType').textContent = `${String(result.plan||'').toUpperCase()} · ${String(result.link_type||'').toUpperCase()}`;
  $('resultEmail').textContent = result.account_email || '—';
  $('resultRegion').textContent = `${result.country || '—'} / ${result.currency || '—'}`;
  $('resultPromo').textContent = !result.promo_requested ? '未请求' : result.promo_applied === true ? '已生效 · 今日应付 0' : result.promo_applied === false ? '未生效' : '打开结账页确认';
  $('resultSession').textContent = result.checkout_session_id || '—';
  const resultProvider = String(result.link_type || result.provider || '').toLowerCase();
  const isIdeal = resultProvider === 'ideal';
  const isKakao = resultProvider === 'kakao';
  const isCodexLow = String(result.plan || '').toLowerCase() === 'codex_low';
  const codexShortLink = isCodexLow && result.checkout_session_id
    ? (result.short_link || result.verification_url || `https://chatgpt.com/checkout/openai_llc/${result.checkout_session_id}`)
    : '';
  const finalValue = codexShortLink || result.short_link || result.verification_url || ((isIdeal || isKakao)
    ? (result.provider_redirect_url || result.checkout_url || result.qr_data || '')
    : (result.qr_data || result.provider_redirect_url || result.checkout_url || ''));
  $('resultValue').value = finalValue;
  const openUrl = codexShortLink || result.short_link || result.verification_url || result.provider_redirect_url || result.checkout_url || '';
  $('openResult').href = openUrl || '#';
  $('openResult').style.display = openUrl ? 'inline-flex' : 'none';
  const verifyUrl = result.verification_url || '';
  $('verifyResult').href = verifyUrl || '#';
  $('verifyResult').hidden = !verifyUrl;
  roxyLaunchToken = String(result.roxy_launch_token || '');
  $('openInRoxy').hidden = Boolean(roxySessionId) || !(result.roxy_available && roxyLaunchToken);
  $('openInRoxy').disabled = false;
  $('closeRoxy').hidden = !roxySessionId;
  $('closeRoxy').disabled = false;
  $('roxyStatus').textContent = roxySessionId
    ? `Roxy 环境 ${roxyProfileId || '—'} 仍在运行，请使用关闭按钮清理`
    : (result.roxy_available ? '可使用本次成功线路在 Roxy 中打开' : '');
  $('roxyStatus').className = 'roxy-status';
  const qr = isIdeal
    ? (result.qr_image_svg || result.qr_image_png || '')
    : (result.qr_image_png || result.qr_image_svg || '');
  $('qrWrap').hidden = !qr;
  if (qr) $('qrImage').src = qr;
  startCountdown(result.expires_at);
  if (scroll) $('resultPanel').scrollIntoView({behavior:'smooth',block:'nearest'});
  if (allowRedirect) schedulePayPalRedirect(result);
}
function schedulePayPalRedirect(result){
  const provider = String(result.link_type || result.provider || '').toLowerCase();
  if (provider !== 'paypal') return;
  const rawUrl = result.paypal_link || result.paypal_url || result.provider_redirect_url || result.checkout_url || '';
  let target = '';
  try {
    const parsed = new URL(String(rawUrl).trim(), window.location.href);
    const host = parsed.hostname.toLowerCase();
    const isPayPalHost = host === 'paypal.com' || host.endsWith('.paypal.com')
      || host === 'paypalobjects.com' || host.endsWith('.paypalobjects.com');
    if (/^https?:$/.test(parsed.protocol) && isPayPalHost) target = parsed.href;
  } catch (_) {
    target = '';
  }
  if (!target) return;
  paypalRedirectTimer = window.setTimeout(() => {
    try {
      if (paypalWindow && !paypalWindow.closed) {
        paypalWindow.location.href = target;
        try { paypalWindow.focus?.(); } catch (_) {}
        return;
      }
      const opened = window.open(target, '_blank');
      if (opened) {
        paypalWindow = opened;
        return;
      }
      $('roxyStatus').textContent = 'PayPal 页面已生成，请点击“普通浏览器打开”';
    } catch (_) {
      $('roxyStatus').textContent = 'PayPal 页面已生成，请点击“普通浏览器打开”';
    }
  }, 350);
}
function closePayPalWindow(){
  try { if (paypalWindow && !paypalWindow.closed) paypalWindow.close(); } catch (_) {}
  paypalWindow = null;
}
function startCountdown(expiresAt){
  clearInterval(countdownTimer); const node = $('qrCountdown');
  if (!expiresAt) { node.textContent = ''; return; }
  const render = () => { const remain = Math.max(0, Number(expiresAt)*1000-Date.now()); const m=Math.floor(remain/60000),s=Math.floor(remain%60000/1000); node.textContent=remain?`二维码剩余 ${m}:${String(s).padStart(2,'0')}`:'二维码已到期'; };
  render(); countdownTimer=setInterval(render,1000);
}

async function resolveLaunchAccounts(){
  const manualToken = $('token').value.trim();
  if (manualToken) {
    const identity = parseTokenIdentity(manualToken);
    return [{
      key: `manual-${Date.now()}`,
      email: identity?.email || identity?.accountId || '手动账号',
      token: manualToken,
    }];
  }
  const selectedItems = selectedBatchAccounts();
  if (!selectedItems.length) throw new Error('没有符合当前筛选条件的账号');
  const query = encodeURIComponent(selectedAccountTypes().join(','));
  return Promise.all(selectedItems.map(async item => {
    if (importedAccountToken && String(importedAccount?.id) === String(item.id)) {
      return {key:`account-${item.id}`, email:item.email || '匹配账号', token:importedAccountToken};
    }
    const response = await fetch(`/api/pay153/accounts/${encodeURIComponent(item.id)}/token?types=${query}`, {cache:'no-store'});
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(`${item.email || '账号'}：${data.error || `HTTP ${response.status}`}`);
    return {key:`account-${item.id}`, email:data.email || item.email || '匹配账号', token:data.access_token || ''};
  }));
}

function checkoutBody(token){
  const plan = selected('plan');
  return {
    token, plan, link_type: selected('link_type'), country: $('country').value,
    currency: $('currency').value, entry_proxies: proxyLines($('entryProxy')), exit_proxies: proxyLines($('exitProxy')),
    retry_count: Math.max(1, Math.min(50, Number($('retryCount').value || 10))),
    use_sen: $('useSentinel').checked,
    use_so: $('useSentinel').checked,
    use_promo: plan === 'plus' && $('usePromo').checked,
    promo_campaign: plan === 'plus' ? $('promoCampaign').value.trim() : '',
    promo_code: plan === 'team' ? $('promoCode').value.trim() : '',
    workspace_name: plan === 'codex_low' ? $('codexWorkspaceName').value.trim() : $('workspaceName').value.trim(),
    workspace_id: $('workspaceId').value.trim(), seat_quantity: Number($('seatQuantity').value || 5),
    price_interval: $('priceInterval').value, credit_quantity: Number($('creditQuantity').value || 13),
    ideal_bank: '',
    pix_tax_id: selected('link_type') === 'pix' ? $('pixTaxId').value.trim() : '',
    pix_auto_kind: selected('link_type') === 'pix' ? $('pixAutoKind').value : 'cpf'
  };
}

async function startBatchTask(task){
  try {
    const response = await fetch('api/checkout', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(checkoutBody(task.token))
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    task.jobId = data.job_id;
    task.status = data.queue_position > 0 ? 'queued' : 'running';
    task.percent = data.queue_position > 0 ? 2 : 4;
    task.queuePosition = Number(data.queue_position) || 0;
    task.text = data.queue_position > 0 ? `任务已进入队列，当前第 ${data.queue_position} 位` : '任务已提交';
  } catch (error) {
    task.status = 'error';
    task.percent = 100;
    task.text = '创建任务失败';
    task.error = error.message || String(error);
    task.logs = [{time:'ERROR', message:task.error}];
  } finally {
    task.token = '';
  }
}

async function pollBatchTask(task){
  if (!task.jobId || taskIsTerminal(task)) return;
  try {
    const response = await fetch(`api/checkout-progress?job_id=${encodeURIComponent(task.jobId)}`, {cache:'no-store'});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    const previousStatus = task.status;
    task.status = data.status || 'running';
    task.percent = Math.max(0, Math.min(100, Number(data.percent) || 0));
    task.text = data.text || '处理中';
    task.logs = Array.isArray(data.logs) ? data.logs : [];
    task.result = data.result || null;
    task.error = data.error || '';
    task.queuePosition = Number(data.queue_position) || 0;
    task.justDone = previousStatus !== 'done' && task.status === 'done';
    if (task.status === 'error' && task.error && !task.logs.some(row => row.message === task.error)) {
      task.logs = [...task.logs, {time:'ERROR', message:task.error}];
    }
  } catch (error) {
    task.status = 'error';
    task.percent = 100;
    task.text = '读取任务状态失败';
    task.error = error.message || String(error);
    task.logs = [...(task.logs || []), {time:'ERROR', message:task.error}];
  }
}

async function pollBatch(){
  if (batchPollInFlight) return;
  batchPollInFlight = true;
  try {
    await Promise.all(batchTasks.map(pollBatchTask));
    renderTaskProgress();
    updateBatchSummary();
    const active = batchTasks.find(task => task.key === activeTaskKey);
    if (active) {
      $('activeLogAccount').textContent = active.email;
      renderLogs(active.logs || []);
      if (active.justDone && active.result) showResult(active.result, {allowRedirect:batchTasks.length === 1, scroll:false});
      active.justDone = false;
    }
    if (batchTasks.length && batchTasks.every(taskIsTerminal)) {
      clearInterval(batchPollTimer);
      batchPollTimer = 0;
      setRunning(false);
      if (!batchTasks.some(task => task.status === 'done')) closePayPalWindow();
    }
  } finally {
    batchPollInFlight = false;
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  clearTimeout(paypalRedirectTimer);
  clearInterval(batchPollTimer);
  batchPollTimer = 0;
  paypalWindow = null;
  const expectedCount = $('token').value.trim() ? 1 : selectedBatchAccounts().length;
  if (selected('link_type') === 'paypal' && expectedCount === 1) {
    try { paypalWindow = window.open('about:blank', '_blank'); } catch (_) { paypalWindow = null; }
  }
  if (selected('link_type') === 'ph_short') {
    try {
      await loadPhShortProxies(false);
    } catch (error) {
      batchTasks = [{key:'proxy-error', email:'代理配置', status:'error', percent:100, text:'代理读取失败', logs:[{time:'ERROR', message:error.message || String(error)}]}];
      activeTaskKey = batchTasks[0].key;
      renderTaskProgress(); updateBatchSummary(); renderActiveTask();
      return;
    }
  }
  if (!roxySessionId) $('resultPanel').hidden = true;
  renderedLogKey = '';
  logAutoFollow = true;
  setRunning(true);
  try {
    const accounts = await resolveLaunchAccounts();
    batchTasks = accounts.map(account => ({
      ...account, jobId:'', status:'creating', percent:3, text:'正在创建任务', logs:[], result:null, error:'', queuePosition:0
    }));
    activeTaskKey = batchTasks[0]?.key || '';
    renderTaskProgress(); updateBatchSummary(); renderActiveTask();
    await Promise.all(batchTasks.map(startBatchTask));
    renderTaskProgress(); updateBatchSummary(); renderActiveTask();
    await pollBatch();
    if (batchTasks.some(task => !taskIsTerminal(task))) batchPollTimer = setInterval(pollBatch, 1200);
    else setRunning(false);
  } catch (error) {
    closePayPalWindow();
    batchTasks = [{key:'batch-error', email:'批量任务', status:'error', percent:100, text:'任务创建失败', logs:[{time:'ERROR', message:error.message || String(error)}]}];
    activeTaskKey = batchTasks[0].key;
    renderTaskProgress(); updateBatchSummary(); renderActiveTask();
    setRunning(false);
  }
});

$('cancelButton').addEventListener('click', async () => {
  const cancellable = batchTasks.filter(task => task.jobId && !taskIsTerminal(task));
  if (!cancellable.length) return;
  clearInterval(batchPollTimer);
  batchPollTimer = 0;
  closePayPalWindow();
  cancellable.forEach(task => {
    task.status = 'cancelled'; task.percent = 100; task.text = '任务已停止';
  });
  renderTaskProgress(); updateBatchSummary(); renderActiveTask(); setRunning(false);
  await Promise.allSettled(cancellable.map(task => fetch('api/checkout-cancel', {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({job_id:task.jobId})
  })));
});
$('copyResult').addEventListener('click', async () => { await navigator.clipboard.writeText($('resultValue').value || ''); const old=$('copyResult').textContent; $('copyResult').textContent='已复制'; setTimeout(()=>$('copyResult').textContent=old,1200); });
$('returnToPay153').addEventListener('click', () => {
  if (window.self !== window.top) {
    window.top.postMessage({type: 'pay153:return'}, window.location.origin);
  } else if (window.history.length > 1) {
    window.history.back();
  } else {
    window.location.href = '/';
  }
});
$('openPaypalProtocol').addEventListener('click', () => {
  if (window.self !== window.top) {
    window.top.postMessage({type: 'paypal-protocol:open'}, window.location.origin);
  } else {
    window.location.href = 'http://127.0.0.1:18097/';
  }
});

$('openInRoxy').addEventListener('click', async () => {
  if (!roxyLaunchToken || roxySessionId) return;
  const button = $('openInRoxy');
  button.disabled = true;
  $('roxyStatus').className = 'roxy-status';
  $('roxyStatus').textContent = '正在创建 Roxy 临时环境…';
  try {
    const response = await fetch('/api/pay153/roxy/open', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({launch_token: roxyLaunchToken})
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
    roxySessionId = String(data.session_id || '');
    roxyProfileId = String(data.profile_id || '');
    button.hidden = true;
    $('closeRoxy').hidden = false;
    $('roxyStatus').className = 'roxy-status success';
    $('roxyStatus').textContent = `Roxy 已打开（环境 ${data.profile_id || '—'}）`;
  } catch (error) {
    button.disabled = false;
    $('roxyStatus').className = 'roxy-status error';
    $('roxyStatus').textContent = error.message || String(error);
  }
});

$('closeRoxy').addEventListener('click', async () => {
  if (!roxySessionId) return;
  const button = $('closeRoxy');
  button.disabled = true;
  $('roxyStatus').className = 'roxy-status';
  $('roxyStatus').textContent = '正在关闭并删除 Roxy 临时环境…';
  try {
    const response = await fetch('/api/pay153/roxy/close', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({session_id: roxySessionId})
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
    roxySessionId = '';
    roxyProfileId = '';
    button.hidden = true;
    button.disabled = false;
    $('openInRoxy').hidden = !roxyLaunchToken;
    $('openInRoxy').disabled = false;
    $('roxyStatus').className = 'roxy-status success';
    $('roxyStatus').textContent = 'Roxy 环境已关闭并删除';
  } catch (error) {
    button.disabled = false;
    $('roxyStatus').className = 'roxy-status error';
    $('roxyStatus').textContent = error.message || String(error);
  }
});

function applyTheme(dark){
  document.documentElement.classList.toggle('dark',dark);
  localStorage.setItem('pay153-theme',dark?'dark':'light');
  const themeToggle = $('themeToggle');
  if (themeToggle) {
    themeToggle.textContent = dark ? '☀' : '☾';
    themeToggle.setAttribute('aria-label', dark ? '切换到浅色模式' : '切换到深色模式');
  }
}
const requestedTheme = new URLSearchParams(location.search).get('theme');
const saved=localStorage.getItem('pay153-theme');
applyTheme(requestedTheme ? requestedTheme === 'dark' : (saved ? saved==='dark' : matchMedia('(prefers-color-scheme: dark)').matches));
if ($('themeToggle')) $('themeToggle').addEventListener('click',()=>applyTheme(!document.documentElement.classList.contains('dark')));
if (privateMode) {
  document.body.classList.add('private-mode');
  document.title = 'PAY.153 · 私有直通提链';
  const brand = document.querySelector('.brand');
  if (brand) brand.href = '/private-checkout';
  const modeLabel = document.querySelector('.form-panel .panel-heading .quiet');
  if (modeLabel) modeLabel.textContent = '私有直通工作台';
  const limitNote = document.querySelector('.public-limit-note');
  if (limitNote) limitNote.innerHTML = '<b>私有直通通道</b><span>使用独立任务执行池，不占用公开队列名额，也不受公开 RPM 与单 IP 限制。</span>';
  const rateCard = document.querySelector('.hero-board > div:nth-child(2)');
  if (rateCard) rateCard.innerHTML = '<small>PRIVATE LANE</small><strong>DIRECT</strong><span>独立执行池</span>';
}
syncFields(true);
restoreProxyPools();
updateProxyCount($('entryProxy'), $('entryProxyCount'));
updateProxyCount($('exitProxy'), $('exitProxyCount'));
loadAccounts();
