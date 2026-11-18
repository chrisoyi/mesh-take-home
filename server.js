// Mesh take-home: small Express backend.
// Keeps the Mesh Client ID / API key on the server, creates Link tokens,
// reads the Coinbase portfolio, tracks the shoe order, and receives webhooks.
const express = require('express');
const crypto = require('crypto');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const MESH_BASE_URL = process.env.MESH_BASE_URL || 'https://sandbox-integration-api.meshconnect.com';
const { MESH_CLIENT_ID, MESH_API_KEY, MESH_WEBHOOK_SECRET } = process.env;

if (!MESH_CLIENT_ID || !MESH_API_KEY) {
  console.error('Missing MESH_CLIENT_ID or MESH_API_KEY. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// Values from the assignment, confirmed against the sandbox catalog
// (GET /api/v1/transfers/managed/networks and /integrations).
const STORE = {
  product: { sku: 'MESH-RUNNER-01', name: 'Mesh Runner', priceUsd: 50 },
  pay: {
    symbol: 'USDC',
    amount: 50, // USDC is ~1:1 with USD, so the payment is an exact 50 USDC
    networkId: 'e3c7fdd8-b1fc-4e51-85ae-bb276e075611', // Ethereum
    networkName: 'Ethereum',
    address: process.env.MERCHANT_WALLET || '0x0Ff0000f0A0f0000F0F000000000ffFf00f0F0f0',
  },
};

// ---------- in-memory state (demo only, nothing written to disk) ----------
const sessions = new Map(); // sid -> { userId, connection }
const orders = new Map(); // orderId -> order
const webhookEvents = []; // newest first
const seenEventIds = new Set();
let coinbaseIntegration = null; // { id, type, name } looked up from Mesh
const apiLog = []; // server -> Mesh calls, shown in the UI timeline (no secrets, no tokens)
let apiSeq = 0;

function getSession(req, res) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)sid=([a-f0-9]{32})/);
  let sid = match && match[1];
  if (!sid || !sessions.has(sid)) {
    sid = crypto.randomBytes(16).toString('hex');
    sessions.set(sid, { userId: `demo-user-${sid.slice(0, 12)}`, connection: null });
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Lax; Path=/${secure}`);
  }
  return sessions.get(sid);
}

// ---------- Mesh API helper ----------
function recordApiCall(entry) {
  apiLog.push({ seq: ++apiSeq, at: new Date().toISOString(), ...entry });
  if (apiLog.length > 300) apiLog.shift();
}

// Calls the Mesh API. `ctx.userId` scopes the log entry to one browser session;
// `ctx.label` is a plain-words description for the demo timeline.
async function mesh(method, urlPath, body, ctx = {}) {
  const started = Date.now();
  const endpoint = urlPath.split('?')[0]; // never log query values
  let res;
  try {
    res = await fetch(MESH_BASE_URL + urlPath, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Client-Id': MESH_CLIENT_ID,
      'X-Client-Secret': MESH_API_KEY,
    },
    body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    recordApiCall({ userId: ctx.userId, method, endpoint, status: 0, ms: Date.now() - started, label: ctx.label, error: 'network error' });
    throw e;
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  const failed = !res.ok || (json.status && json.status !== 'ok');
  recordApiCall({
    userId: ctx.userId, method, endpoint, status: res.status, ms: Date.now() - started, label: ctx.label,
    error: failed ? json.message || json.errorType || `HTTP ${res.status}` : undefined,
  });
  if (failed) {
    const err = new Error(json.displayMessage || json.message || `Mesh returned HTTP ${res.status}`);
    err.status = res.status >= 400 ? res.status : 502;
    err.mesh = { httpStatus: res.status, status: json.status, message: json.message, errorType: json.errorType };
    throw err;
  }
  return json.content;
}

async function loadCoinbaseIntegration() {
  if (process.env.MESH_COINBASE_INTEGRATION_ID) {
    coinbaseIntegration = { id: process.env.MESH_COINBASE_INTEGRATION_ID, type: 'override', name: 'Coinbase' };
    return;
  }
  try {
    const content = await mesh('GET', '/api/v1/transfers/managed/integrations', null, { label: 'Startup: load integration catalog' });
    const list = content.integrations || [];
    // In sandbox the Coinbase tile is the "sandboxCoinbase" integration.
    coinbaseIntegration =
      list.find((i) => i.type === 'sandboxCoinbase') || list.find((i) => i.type === 'coinbase') || null;
    if (coinbaseIntegration) {
      const { id, type, name } = coinbaseIntegration;
      coinbaseIntegration = { id, type, name };
      console.log(`Coinbase integration: ${type} (${id})`);
    }
  } catch (e) {
    console.warn('Could not load integrations list, Link will show the full catalog:', e.message);
  }
}

function linkTokenBody(userId, { deepLink, transferOptions }) {
  const body = { userId, restrictMultipleAccounts: true };
  if (deepLink && coinbaseIntegration) body.integrationId = coinbaseIntegration.id;
  if (transferOptions) body.transferOptions = transferOptions;
  return body;
}

// ---------- SmartFunding ----------
// Mesh docs: SmartFunding is an account-level capability that Link applies automatically.
// There is no link-token field for it (LinkTokenTransferOptions has none), so the
// payment request stays "merchant receives exactly 50 USDC on Ethereum" either way.
// What we CAN do with the API is ask Mesh how the user could fund it:
// POST /api/v1/transfers/managed/quote returns `fundingOptions` (Coinbase only).
const QUOTE_BROKER_TYPES = new Set(['coinbase']);
async function smartFundingQuote(s) {
  const connected = s.connection?.brokerType;
  // Sandbox rejects "sandboxCoinbase" for quotes but accepts "coinbase".
  const brokerType = QUOTE_BROKER_TYPES.has(connected) ? connected : 'coinbase';
  try {
    const q = await mesh(
      'POST',
      '/api/v1/transfers/managed/quote',
      {
        amountInFiat: STORE.product.priceUsd,
        fiatCurrency: 'USD',
        symbol: STORE.pay.symbol,
        networkId: STORE.pay.networkId,
        toAddress: STORE.pay.address,
        brokerType,
      },
      { userId: s.userId, label: 'SmartFunding quote: how can Coinbase fund $50 USDC?' }
    );
    return {
      available: true,
      brokerType,
      isEligible: q.isEligible,
      fundingOptions: (q.fundingOptions || []).map((f) => ({
        option: f.fundingOption,
        paymentMethodType: f.paymentMethodType,
        tradingFeeFiat: f.tradingFeeFiat,
        paymentMethodFeeFiat: f.paymentMethodFeeFiat,
      })),
      fees: q.fees?.inFiat ? { minFeesFiat: q.fees.inFiat.minFeesFiat, maxFeesFiat: q.fees.inFiat.maxFeesFiat, networkFeeFiat: q.fees.inFiat.networkFeeFiat } : null,
    };
  } catch (e) {
    return { available: false, reason: e.message };
  }
}

// ---------- app ----------
const app = express();
app.set('trust proxy', true);

// Webhook route must see the RAW body for the HMAC check, so it is registered
// before express.json().
app.post('/webhooks/mesh', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  if (!MESH_WEBHOOK_SECRET) return res.status(503).send('Webhook secret not configured');
  const received = String(req.headers['x-mesh-signature-256'] || '');
  const computed = crypto.createHmac('sha256', MESH_WEBHOOK_SECRET).update(req.body).digest('base64');
  const a = Buffer.from(received);
  const b = Buffer.from(computed);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(400).send('Invalid signature');
  }
  res.sendStatus(200); // answer fast (< 200 ms), then process

  setImmediate(() => {
    let evt;
    try { evt = JSON.parse(req.body.toString('utf8')); } catch { return; }
    const duplicate = evt.EventId && seenEventIds.has(evt.EventId);
    if (evt.EventId) seenEventIds.add(evt.EventId);
    webhookEvents.unshift({
      receivedAt: new Date().toISOString(),
      duplicate: Boolean(duplicate),
      eventId: evt.EventId,
      transferStatus: evt.TransferStatus,
      transactionId: evt.TransactionId,
      transferId: evt.TransferId,
      token: evt.Token,
      chain: evt.Chain,
      amount: evt.DestinationAmount ?? evt.SourceAmount,
      txHash: evt.TxHash,
    });
    webhookEvents.length = Math.min(webhookEvents.length, 100);
    recordApiCall({
      direction: 'in', method: 'POST', endpoint: '/webhooks/mesh', status: 200, ms: 0,
      userId: evt.UserId, label: `Webhook ${evt.TransferStatus || ''}${duplicate ? ' (duplicate EventId, ignored)' : ''}`,
    });
    if (duplicate) return; // idempotent: same EventId = same event, already applied
    const order = [...orders.values()].find((o) => o.transactionId === evt.TransactionId);
    if (order) {
      order.webhookStatus = evt.TransferStatus;
      if (evt.TxHash) order.txHash = evt.TxHash;
      if (evt.TransferStatus === 'Succeeded') order.status = 'paid';
      if (evt.TransferStatus === 'Failed') order.status = 'failed';
      order.updatedAt = new Date().toISOString();
    }
  });
});

app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/api/config', (req, res) => {
  const s = getSession(req, res);
  res.json({
    environment: MESH_BASE_URL.includes('sandbox') ? 'sandbox' : 'production',
    product: STORE.product,
    pay: STORE.pay,
    coinbaseIntegration,
    connected: s.connection
      ? { brokerName: s.connection.brokerName, brokerType: s.connection.brokerType, accountName: s.connection.accountName }
      : null,
    webhooksEnabled: Boolean(MESH_WEBHOOK_SECRET),
  });
});

// 1) Link token for "Connect Coinbase" (read-only connection, no transfer)
app.post('/api/linktoken/connect', async (req, res, next) => {
  try {
    const s = getSession(req, res);
    const body = linkTokenBody(s.userId, { deepLink: req.body?.deepLink !== false });
    const content = await mesh('POST', '/api/v1/linktoken', body, { userId: s.userId, label: 'Link token for Connect Coinbase' });
    res.json({ linkToken: content.linkToken });
  } catch (e) { next(e); }
});

// 2) Link token for paying $50 in USDC on Ethereum
app.post('/api/linktoken/payment', async (req, res, next) => {
  try {
    const s = getSession(req, res);
    const orderId = `ord_${crypto.randomBytes(6).toString('hex')}`;
    const transactionId = `txn_${crypto.randomUUID()}`;
    const transferOptions = {
      transactionId,
      transferType: 'payment',
      isInclusiveFeeEnabled: false, // fees on top, merchant receives the full 50 USDC
      generatePayLink: false,
      toAddresses: [
        { networkId: STORE.pay.networkId, symbol: STORE.pay.symbol, address: STORE.pay.address, amount: STORE.pay.amount },
      ],
    };
    const smartFunding = req.body?.smartFunding === true;
    const [content, funding] = await Promise.all([
      mesh('POST', '/api/v1/linktoken', linkTokenBody(s.userId, { deepLink: req.body?.deepLink !== false, transferOptions }), {
        userId: s.userId,
        label: `Link token for $50 payment (50 USDC on Ethereum)${smartFunding ? ', SmartFunding on' : ''}`,
      }),
      smartFunding ? smartFundingQuote(s) : Promise.resolve(null),
    ]);
    const order = {
      orderId,
      transactionId,
      userId: s.userId,
      item: STORE.product.name,
      priceUsd: STORE.product.priceUsd,
      amount: STORE.pay.amount,
      symbol: STORE.pay.symbol,
      network: STORE.pay.networkName,
      toAddress: STORE.pay.address,
      status: 'awaiting_payment',
      smartFundingRequested: smartFunding,
      createdAt: new Date().toISOString(),
    };
    orders.set(orderId, order);
    res.json({ linkToken: content.linkToken, order, smartFunding: funding });
  } catch (e) { next(e); }
});

// Front end hands us the tokens from onIntegrationConnected. Kept in memory only.
app.post('/api/session/connection', (req, res) => {
  const s = getSession(req, res);
  const { accessToken, brokerType, brokerName, accountId, accountName } = req.body || {};
  if (!accessToken || !brokerType) return res.status(400).json({ error: 'accessToken and brokerType are required' });
  s.connection = { accessToken, brokerType, brokerName, accountId, accountName, connectedAt: new Date().toISOString() };
  res.json({ ok: true, brokerName, brokerType, accountName });
});

app.delete('/api/session/connection', (req, res) => {
  getSession(req, res).connection = null;
  res.json({ ok: true });
});

// 3) Read the Coinbase portfolio with the access token
app.get('/api/portfolio', async (req, res, next) => {
  try {
    const s = getSession(req, res);
    if (!s.connection) return res.status(401).json({ error: 'Connect Coinbase first, then load the portfolio.' });
    const auth = { authToken: s.connection.accessToken, type: s.connection.brokerType };
    const ctx = { userId: s.userId };
    const [holdings, value] = await Promise.all([
      mesh('POST', '/api/v1/holdings/get', auth, { ...ctx, label: 'Read Coinbase holdings with access token' }),
      mesh('POST', '/api/v1/holdings/value', auth, { ...ctx, label: 'Read portfolio totals' }).catch(() => null),
    ]);
    const positions = (holdings.cryptocurrencyPositions || [])
      .map((p) => ({
        symbol: p.symbol,
        name: p.name,
        amount: p.amount,
        lastPrice: p.lastPrice ?? null,
        marketValue: p.marketValue ?? (p.lastPrice != null ? p.amount * p.lastPrice : null),
        costBasis: p.costBasis ?? null,
      }))
      .sort((a, b) => (b.marketValue || 0) - (a.marketValue || 0));
    const summed = positions.reduce((t, p) => t + (p.marketValue || 0), 0);
    res.json({
      institution: holdings.institutionName || s.connection.brokerName,
      accountName: holdings.accountName || s.connection.accountName,
      positions,
      totals: {
        cryptoValue: value?.cryptocurrenciesValue ?? summed,
        fiatValue: value?.fiatValue ?? null,
        totalValue: value?.totalValue ?? summed,
      },
      fetchedAt: new Date().toISOString(),
    });
  } catch (e) { next(e); }
});

// Front end reports onTransferFinished (provider accepted the transfer, not yet on-chain final)
app.post('/api/orders/:id/transfer-finished', (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const p = req.body || {};
  if (p.clientTransactionId && p.clientTransactionId !== order.transactionId) {
    return res.status(400).json({ error: 'transactionId does not match this order' });
  }
  Object.assign(order, {
    status: p.status && p.status !== 'success' ? 'failed' : order.status === 'paid' ? 'paid' : 'submitted',
    transferId: p.transferId,
    txId: p.txId,
    txHash: p.txHash || order.txHash,
    paidAmount: p.amount,
    paidSymbol: p.symbol,
    networkName: p.networkName,
    fromAddress: p.fromAddress,
    totalAmountInFiat: p.totalAmountInFiat,
    errorMessage: p.errorMessage,
    updatedAt: new Date().toISOString(),
  });
  res.json(order);
});

// Order status, double-checked server-side against Mesh's transfer history
app.get('/api/orders/:id', async (req, res, next) => {
  try {
    const order = orders.get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    try {
      const q = new URLSearchParams({ ClientTransactionId: order.transactionId, Count: '1' });
      const content = await mesh('GET', `/api/v1/transfers/managed/mesh?${q}`, null, {
        userId: order.userId,
        label: 'Check transfer status by our transactionId',
      });
      const t = content?.items?.[0];
      if (t) {
        order.meshStatus = t.status;
        if (typeof t.isSmartFundingTransfer === 'boolean') order.isSmartFundingTransfer = t.isSmartFundingTransfer;
        if (Array.isArray(t.fundingMethods) && t.fundingMethods.length) order.fundingMethods = t.fundingMethods;
        order.transferId = order.transferId || t.id;
        if (t.hash) order.txHash = t.hash;
        if (t.status === 'succeeded') order.status = 'paid';
        if (t.status === 'failed' || t.status === 'expired') order.status = 'failed';
      }
    } catch (e) {
      order.meshLookupError = e.message;
    }
    res.json(order);
  } catch (e) { next(e); }
});

// SmartFunding preview for the UI toggle (no link token, just the quote)
app.get('/api/smartfunding/preview', async (req, res) => {
  res.json(await smartFundingQuote(getSession(req, res)));
});

// Server-side API activity for this browser session (for the demo timeline)
app.get('/api/activity', (req, res) => {
  const s = getSession(req, res);
  const since = Number(req.query.since || 0);
  res.json({ calls: apiLog.filter((c) => c.seq > since && (!c.userId || c.userId === s.userId)) });
});

app.get('/api/webhooks/events', (req, res) => res.json({ enabled: Boolean(MESH_WEBHOOK_SECRET), events: webhookEvents }));

// Errors: return a clean message, never echo credentials
app.use((err, req, res, _next) => {
  console.error(`[${req.method} ${req.path}]`, err.message, err.mesh ? JSON.stringify(err.mesh) : '');
  res.status(err.status && err.status < 600 ? err.status : 500).json({ error: err.message, mesh: err.mesh });
});

loadCoinbaseIntegration().finally(() => {
  app.listen(PORT, () => console.log(`Mesh Runner store on http://localhost:${PORT} (${MESH_BASE_URL})`));
});
