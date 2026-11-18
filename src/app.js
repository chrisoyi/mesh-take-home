// Front end: one page, plain JS. Bundled with esbuild so we can import the Mesh Web SDK.
import { createLink } from '@meshconnect/web-link-sdk';

const $ = (id) => document.getElementById(id);
const usd = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' }));
const qty = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 8 }));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (v, keep = 6) => (v && String(v).length > keep * 2 + 3 ? `${String(v).slice(0, keep)}…${String(v).slice(-4)}` : v);

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

// ---------- Live timeline ----------
// Masks anything that looks like a credential before it can reach the screen.
const SENSITIVE = /token|secret|password|apikey|api_key|authorization|auth|refresh|signature/i;
function mask(value, depth = 0) {
  if (depth > 4 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => mask(v, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SENSITIVE.test(k) && v != null && typeof v !== 'object' ? '••••' : mask(v, depth + 1)])
    );
  }
  return value;
}

const timeline = [];
function addEntry({ at = new Date(), source, type, summary, ok }) {
  timeline.push({ at: new Date(at), source, type, summary, ok });
  renderTimeline();
}
function renderTimeline() {
  const showLink = $('fBrowser').checked;
  const showServer = $('fServer').checked;
  const rows = timeline
    .filter((e) => (e.source === 'server' || e.source === 'webhook' ? showServer : showLink))
    .sort((a, b) => b.at - a.at)
    .slice(0, 200)
    .map((e) => {
      const cls = e.ok === false ? 'err' : e.ok === true ? 'ok' : '';
      return `<li><time>${e.at.toLocaleTimeString()}</time><span class="src ${e.source}">${esc(e.source)}</span>
        <span class="what"><b class="${cls}">${esc(e.type)}</b><span class="detail">${esc(e.summary || '')}</span></span></li>`;
    })
    .join('');
  $('timeline').innerHTML = rows || '<li class="empty-row">Nothing yet. Click Connect Coinbase or Pay with crypto.</li>';
}
$('fBrowser').onchange = renderTimeline;
$('fServer').onchange = renderTimeline;
$('clearLog').onclick = () => { timeline.length = 0; renderTimeline(); };

// Short, human summary for each Link onEvent type (payloads are masked first)
function summarizeEvent(ev) {
  const p = mask(ev.payload || {});
  const bits = [];
  if (p.integrationName || p.integrationType) bits.push(p.integrationName || p.integrationType);
  if (p.page) bits.push(`page: ${p.page}`);
  if (p.symbol) bits.push(p.symbol);
  if (p.networkName) bits.push(`on ${p.networkName}`);
  if (p.amount != null) bits.push(`amount ${p.amount}`);
  if (p.amountInFiat != null) bits.push(usd(p.amountInFiat));
  if (p.status) bits.push(`status ${p.status}`);
  if (p.errorMessage) bits.push(`error: ${p.errorMessage}`);
  return bits.join(' · ');
}

// Pull server-side Mesh API calls into the timeline
let lastSeq = 0;
async function pollActivity() {
  try {
    const { calls } = await api(`/api/activity?since=${lastSeq}`);
    for (const c of calls) {
      lastSeq = Math.max(lastSeq, c.seq);
      const isWebhook = c.direction === 'in';
      addEntry({
        at: c.at,
        source: isWebhook ? 'webhook' : 'server',
        type: `${c.method} ${c.endpoint} → ${c.status || 'ERR'}`,
        summary: [c.label, c.ms ? `${c.ms} ms` : '', c.error ? `error: ${c.error}` : ''].filter(Boolean).join(' · '),
        ok: c.status >= 200 && c.status < 300,
      });
    }
  } catch { /* ignore */ }
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
    if (!t) {
      addEntry({ source: 'link', type: 'onIntegrationConnected', summary: 'delayed auth, no access token yet' });
      return;
    }
    const acct = t.accountTokens?.[0];
    addEntry({
      source: 'link',
      type: 'onIntegrationConnected',
      summary: `${t.brokerName} (${t.brokerType}) · account ${acct?.account?.accountName || ''} · access token ••••`,
      ok: true,
    });
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
    addEntry({
      source: 'link',
      type: 'onTransferFinished',
      summary: `${payload.status} · ${payload.amount ?? ''} ${payload.symbol ?? ''} on ${payload.networkName || ''} · transfer ${short(payload.transferId) || '—'} · provider accepted, not final on-chain yet`,
      ok: payload.status === 'success',
    });
    if (!currentOrder) return;
    try {
      currentOrder = await api(`/api/orders/${currentOrder.orderId}/transfer-finished`, { method: 'POST', body: payload });
      renderOrder();
      pollOrder();
    } catch (e) { toast(e.message); }
  },
  onEvent: (ev) => addEntry({ source: 'link', type: `onEvent: ${ev.type}`, summary: summarizeEvent(ev) }),
  onExit: (error, summary) => {
    const s = summary ? mask(summary) : null;
    addEntry({
      source: 'link',
      type: 'onExit',
      summary: error ? `error: ${error}` : `Link closed${s?.page ? ` on ${s.page}` : ''}`,
      ok: error ? false : undefined,
    });
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
    addEntry({ source: 'app', type: 'openLink (connect)', summary: 'Got a one-time link token from my server, opening Mesh Link' });
    link.openLink(linkToken);
  } catch (e) { toast(`Could not start Link: ${e.message}`); }
  finally { $('connectBtn').disabled = false; pollActivity(); }
};

$('disconnectBtn').onclick = async () => {
  await api('/api/session/connection', { method: 'DELETE' });
  accessTokens.length = 0;
  setConnected(null);
  addEntry({ source: 'app', type: 'disconnect', summary: 'Access token dropped from server memory' });
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
  } finally { pollActivity(); }
}

// ---------- SmartFunding ----------
const FUNDING_LABELS = {
  existingCryptocurrencyBalance: 'USDC you already hold',
  cryptocurrencyConversion: 'Convert another coin you hold (e.g. ETH, BTC) into USDC',
  stableCoinNoFeeConversion: 'Swap another stablecoin into USDC, no fee',
  cryptocurrencyBuyingPowerConversion: 'Convert crypto using buying power',
  cryptocurrencyMultiStepConversion: 'Multi-step conversion from another coin',
  buyingPowerPurchase: 'Buy USDC with your Coinbase cash balance',
  paymentMethodDepositUsage: 'Buy USDC with a linked payment method',
};

function renderSmartFunding(sf) {
  const el = $('sfPanel');
  if (!$('sfToggle').checked) { el.hidden = true; return; }
  el.hidden = false;
  if (!sf) { el.innerHTML = 'Checking funding options with Mesh…'; return; }
  if (!sf.available) {
    el.innerHTML = `SmartFunding quote not available right now (${esc(sf.reason)}). Checkout still works: Link will ask for USDC directly.`;
    return;
  }
  const items = sf.fundingOptions
    .map((f) => `<li>${esc(FUNDING_LABELS[f.option] || f.option)}${f.paymentMethodType ? ` (${esc(f.paymentMethodType)})` : ''}${f.tradingFeeFiat ? ` · trading fee ~${usd(f.tradingFeeFiat)}` : ' · no trading fee'}</li>`)
    .join('');
  el.innerHTML = `<b>Ways Coinbase can fund this $50 USDC payment</b> (Mesh quote):<ul>${items}</ul>
    ${sf.fees ? `<small>Estimated total fees ${usd(sf.fees.minFeesFiat)}–${usd(sf.fees.maxFeesFiat)} (network ~${usd(sf.fees.networkFeeFiat)}).</small><br />` : ''}
    <small>Mesh applies SmartFunding inside Link when the account has it enabled. The store always receives 50 USDC on Ethereum.</small>`;
}

$('sfToggle').onchange = async () => {
  renderSmartFunding(null);
  if (!$('sfToggle').checked) return;
  addEntry({ source: 'app', type: 'SmartFunding on', summary: 'Asking Mesh how this payment can be funded' });
  try { renderSmartFunding(await api('/api/smartfunding/preview')); }
  catch (e) { renderSmartFunding({ available: false, reason: e.message }); }
  pollActivity();
};

// ---------- Checkout ----------
$('payBtn').onclick = async () => {
  try {
    $('payBtn').disabled = true;
    const smartFunding = $('sfToggle').checked;
    const res = await api('/api/linktoken/payment', { method: 'POST', body: { smartFunding } });
    currentOrder = res.order;
    if (smartFunding) renderSmartFunding(res.smartFunding);
    renderOrder();
    addEntry({ source: 'app', type: 'openLink (payment)', summary: `Order ${res.order.orderId} · 50 USDC on Ethereum${smartFunding ? ' · SmartFunding on' : ''}` });
    link.openLink(res.linkToken);
  } catch (e) { toast(`Could not start checkout: ${e.message}`); }
  finally { $('payBtn').disabled = false; pollActivity(); }
};

$('refreshOrderBtn').onclick = () => refreshOrder();

async function refreshOrder() {
  if (!currentOrder) return;
  currentOrder = await api(`/api/orders/${currentOrder.orderId}`);
  renderOrder();
  pollActivity();
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
  const funding = Array.isArray(o.fundingMethods)
    ? o.fundingMethods.map((f) => f.type || f.fundingMethod || f.symbol || JSON.stringify(mask(f))).join(', ')
    : null;
  $('order').className = '';
  $('order').innerHTML = `
    <p><span class="${cls} status">${label}</span></p>
    <dl class="kv">
      ${row('Order', o.orderId)}
      ${row('Item', `${o.item} · ${usd(o.priceUsd)}`)}
      ${row('Pay', `${o.amount} ${o.symbol} on ${o.network}`)}
      ${row('To wallet', o.toAddress)}
      ${row('SmartFunding', o.smartFundingRequested ? `requested${typeof o.isSmartFundingTransfer === 'boolean' ? `, used by Mesh: ${o.isSmartFundingTransfer ? 'yes' : 'no'}` : ''}` : null)}
      ${row('Funded with', funding)}
      ${row('Transaction ID', o.transactionId)}
      ${row('Mesh transfer', o.transferId)}
      ${row('Mesh status', o.meshStatus)}
      ${row('Webhook status', o.webhookStatus)}
      ${row('Total charged', o.totalAmountInFiat != null ? usd(o.totalAmountInFiat) : null)}
      ${row('Tx hash', o.txHash)}
    </dl>
    <p class="note">“Submitted” means Coinbase accepted the transfer (onTransferFinished). It's only final when Mesh reports it succeeded, which the app checks through the transfer history API and webhooks.</p>`;
}

// ---------- boot ----------
(async () => {
  renderTimeline();
  const cfg = await api('/api/config');
  $('envBadge').textContent = cfg.environment;
  $('whState').textContent = cfg.webhooksEnabled ? 'webhooks listening' : 'webhooks off';
  $('whState').className = cfg.webhooksEnabled ? 'badge' : 'badge muted';
  setConnected(cfg.connected);
  if (cfg.connected) loadPortfolio();
  pollActivity();
  setInterval(pollActivity, 3000);
})();
