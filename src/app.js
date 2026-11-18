// Front end: one page, plain JS. Bundled with esbuild so we can import the Mesh Web SDK.
import { createLink } from '@meshconnect/web-link-sdk';

const $ = (id) => document.getElementById(id);
const usd = (n) => (n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' }));
const qty = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 8 }));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let currentOrder = null;
let accessTokens = []; // kept in page memory so a returning user can pay without logging in again

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

function logEvent(text) {
  const li = document.createElement('li');
  li.innerHTML = `<time>${new Date().toLocaleTimeString()}</time>${esc(text)}`;
  $('eventLog').prepend(li);
}

// ---------- Mesh Link (one instance, callbacks shared by both flows) ----------
const link = createLink({
  renderType: 'overlay',
  theme: 'dark',
  language: 'system',
  displayFiatCurrency: 'USD',
  accessTokens,
  onIntegrationConnected: async (payload) => {
    const t = payload.accessToken;
    if (!t) { logEvent('integrationConnected (delayed auth, no access token)'); return; }
    const acct = t.accountTokens?.[0];
    logEvent(`integrationConnected → ${t.brokerName} (${t.brokerType})`);
    accessTokens.splice(0, accessTokens.length, {
      accountId: acct.account.accountId,
      accountName: acct.account.accountName,
      accessToken: acct.accessToken,
      brokerType: t.brokerType,
      brokerName: t.brokerName,
    });
    await api('/api/session/connection', {
      method: 'POST',
      body: {
        accessToken: acct.accessToken,
        brokerType: t.brokerType,
        brokerName: t.brokerName,
        accountId: acct.account.accountId,
        accountName: acct.account.accountName,
      },
    });
    setConnected({ brokerName: t.brokerName, accountName: acct.account.accountName });
    loadPortfolio();
  },
  onTransferFinished: async (payload) => {
    logEvent(`transferFinished → ${payload.status} ${payload.amount ?? ''} ${payload.symbol ?? ''}`);
    if (!currentOrder) return;
    try {
      currentOrder = await api(`/api/orders/${currentOrder.orderId}/transfer-finished`, { method: 'POST', body: payload });
      renderOrder();
      pollOrder();
    } catch (e) { toast(e.message); }
  },
  onEvent: (ev) => logEvent(ev.type + (ev.payload?.page ? ` (${ev.payload.page})` : '')),
  onExit: (error) => {
    logEvent(error ? `exit with error: ${error}` : 'Link closed');
    if (error) toast(`Link closed: ${error}`);
  },
});

// ---------- Connect + portfolio ----------
function setConnected(c) {
  const on = Boolean(c);
  $('connBadge').textContent = on ? `${c.brokerName || 'Coinbase'} connected` : 'Coinbase not connected';
  $('connBadge').className = on ? 'badge' : 'badge muted';
  $('portfolioBtn').disabled = !on;
  $('disconnectBtn').disabled = !on;
  $('connectBtn').textContent = on ? 'Reconnect' : 'Connect Coinbase';
}

$('connectBtn').onclick = async () => {
  try {
    $('connectBtn').disabled = true;
    const { linkToken } = await api('/api/linktoken/connect', { method: 'POST', body: {} });
    logEvent('link token created (connect)');
    link.openLink(linkToken);
  } catch (e) { toast(`Could not start Link: ${e.message}`); }
  finally { $('connectBtn').disabled = false; }
};

$('disconnectBtn').onclick = async () => {
  await api('/api/session/connection', { method: 'DELETE' });
  accessTokens.length = 0;
  setConnected(null);
  $('portfolio').className = 'empty';
  $('portfolio').textContent = 'Disconnected. Connect Coinbase to read holdings again.';
};

$('portfolioBtn').onclick = () => loadPortfolio();

async function loadPortfolio() {
  const el = $('portfolio');
  el.className = 'empty';
  el.textContent = 'Loading holdings from Coinbase via Mesh…';
  try {
    const p = await api('/api/portfolio');
    const rows = p.positions
      .map((x) => `<tr><td><b>${esc(x.symbol)}</b></td><td class="num">${qty(x.amount)}</td><td class="num">${usd(x.lastPrice)}</td><td class="num">${usd(x.marketValue)}</td></tr>`)
      .join('');
    el.className = '';
    el.innerHTML = `
      <div class="totals">
        <div><span class="sub">Total value</span><b>${usd(p.totals.totalValue)}</b></div>
        <div><span class="sub">Crypto</span><b>${usd(p.totals.cryptoValue)}</b></div>
        <div><span class="sub">Cash</span><b>${usd(p.totals.fiatValue)}</b></div>
        <div><span class="sub">Account</span><b>${esc(p.institution)}</b></div>
      </div>
      ${p.positions.length ? `<table><thead><tr><th>Asset</th><th class="num">Amount</th><th class="num">Price</th><th class="num">Value</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">No crypto positions in this account.</div>'}
      <p class="note">Read live from Coinbase with POST /api/v1/holdings/get and /holdings/value, using the access token from onIntegrationConnected. Fetched ${new Date(p.fetchedAt).toLocaleTimeString()}.</p>`;
  } catch (e) {
    el.className = 'empty';
    el.textContent = e.status === 401 ? e.message : `Could not load portfolio: ${e.message}`;
  }
}

// ---------- Checkout ----------
$('payBtn').onclick = async () => {
  try {
    $('payBtn').disabled = true;
    const { linkToken, order } = await api('/api/linktoken/payment', { method: 'POST', body: {} });
    currentOrder = order;
    renderOrder();
    logEvent(`link token created (payment ${order.orderId})`);
    link.openLink(linkToken);
  } catch (e) { toast(`Could not start checkout: ${e.message}`); }
  finally { $('payBtn').disabled = false; }
};

$('refreshOrderBtn').onclick = () => refreshOrder();

async function refreshOrder() {
  if (!currentOrder) return;
  currentOrder = await api(`/api/orders/${currentOrder.orderId}`);
  renderOrder();
  return currentOrder;
}

async function pollOrder() {
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const o = await refreshOrder().catch(() => null);
    if (!o || o.status === 'paid' || o.status === 'failed') return;
  }
}

const STATUS = {
  awaiting_payment: ['Awaiting payment', 'badge muted'],
  submitted: ['Submitted, waiting for on-chain confirmation', 'badge warn'],
  paid: ['Paid ✓', 'badge'],
  failed: ['Failed', 'badge bad'],
};

function renderOrder() {
  const o = currentOrder;
  $('refreshOrderBtn').disabled = !o;
  if (!o) return;
  const [label, cls] = STATUS[o.status] || [o.status, 'badge muted'];
  const row = (k, v) => (v == null || v === '' ? '' : `<dt>${k}</dt><dd>${esc(v)}</dd>`);
  $('order').className = '';
  $('order').innerHTML = `
    <p><span class="${cls} status">${label}</span></p>
    <dl class="kv">
      ${row('Order', o.orderId)}
      ${row('Item', `${o.item} · ${usd(o.priceUsd)}`)}
      ${row('Pay', `${o.amount} ${o.symbol} on ${o.network}`)}
      ${row('To wallet', o.toAddress)}
      ${row('Transaction ID', o.transactionId)}
      ${row('Mesh transfer', o.transferId)}
      ${row('Mesh status', o.meshStatus)}
      ${row('Webhook status', o.webhookStatus)}
      ${row('Total charged', o.totalAmountInFiat != null ? usd(o.totalAmountInFiat) : null)}
      ${row('Tx hash', o.txHash)}
    </dl>
    <p class="note">“Submitted” means Coinbase accepted the transfer (onTransferFinished). It's only final when Mesh reports it succeeded, which the app checks through the transfer history API and webhooks.</p>`;
}

// ---------- Webhook log ----------
async function loadWebhooks() {
  try {
    const { enabled, events } = await api('/api/webhooks/events');
    $('whState').textContent = enabled ? 'listening' : 'off (no secret set)';
    $('whState').className = enabled ? 'badge' : 'badge muted';
    $('webhookLog').innerHTML = events
      .map((e) => `<li><time>${new Date(e.receivedAt).toLocaleTimeString()}</time>${esc(e.transferStatus)} ${esc(e.amount ?? '')} ${esc(e.token ?? '')} ${e.duplicate ? '(duplicate, ignored)' : ''}</li>`)
      .join('');
  } catch { /* ignore */ }
}

// ---------- boot ----------
(async () => {
  const cfg = await api('/api/config');
  $('envBadge').textContent = cfg.environment;
  setConnected(cfg.connected);
  if (cfg.connected) loadPortfolio();
  loadWebhooks();
  setInterval(loadWebhooks, 5000);
})();
