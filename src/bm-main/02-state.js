var CAPTCHA_APPID = '196026326';
var S = {}; // state
var _batchMode = false; // batch continuous captcha solving
var _batchCount = 0; // captchas solved in current batch session
var _activeCaptcha = null; // reference to the currently open TencentCaptcha instance (for force-destroy on ESC)
var BATCH_SESSION_LIMIT = 100; // auto-stop after this many per session (default 100, updatable via CAPTCHA_CONFIG)
var AUTO_SOLVE = false; // auto-solve captcha via local OCR service
var OCR_SERVICE_URL = 'http://127.0.0.1:9876'; // local OCR service URL

// OCR tuning params (updatable via CAPTCHA_CONFIG)
var CONFIDENCE_THRESHOLD = 0.1;
var CLICK_INTERVAL = 200;
var CLICK_JITTER = 3;
var _solveInFlight = false; // prevents duplicate OCR /solve requests
var _authFailed = false; // true when batch-preview API returns code=1001 (not logged in)

// ── Page-level ticket store (sessionStorage) ──
// Tickets live in the page's sessionStorage: they survive a refresh of the same tab,
// but are destroyed automatically when the tab/window is closed.
var TICKET_STORE_KEY = '__bm_tickets';
function readPageTicketStore() {
  try { return JSON.parse(window.sessionStorage.getItem(TICKET_STORE_KEY) || '[]'); } catch (e) { return []; }
}
function writePageTicketStore(list) {
  try { window.sessionStorage.setItem(TICKET_STORE_KEY, JSON.stringify(list || [])); } catch (e) {}
}
function clearPageTicketStore() {
  try { window.sessionStorage.removeItem(TICKET_STORE_KEY); } catch (e) {}
}

// Bridge: isolated content script asks MAIN world to read/write the page store.
window.addEventListener('message', function(ev) {
  if (ev.source !== window || !ev.data || !ev.data.__miaosha_cmd) return;
  var d = ev.data;
  if (d.type === 'READ_TICKET_STORE') {
    window.postMessage({ __miaosha: true, type: 'TICKET_STORE_DATA', reqId: d.reqId, list: readPageTicketStore() }, '*');
  } else if (d.type === 'WRITE_TICKET_STORE') {
    writePageTicketStore(d.list);
  } else if (d.type === 'CLEAR_TICKET_STORE') {
    clearPageTicketStore();
  }
});

// ── Runtime state (latency calibration + auto-fire scheduler) ──
var _rt = {
  latencyMs: 0,       // one-way latency estimate from runtime calibration probes
  clockOffsetMs: 0,   // local clock vs server Date header estimate (ms, can be negative)
  nextSaleTime: 0,    // next sale epoch ms (UTC)
  autoTimer: null,    // setTimeout handle for auto-fire
  countdownTimer: null, // setInterval handle for countdown display
  autoFired: false,   // guard: fire only once per scheduled event
  calibratedAt: 0,    // runtime calibration timestamp (epoch ms)
  sampleCount: 0,     // number of probes used by latest calibration
};

function updateRuntimeDisplay() {
  var latEl = document.getElementById('_lat');
  if (latEl) {
    var latValue = _rt.calibratedAt > 0 ? String(_rt.latencyMs) : '--';
    latEl.innerHTML = latValue + '<span style="font-size:9px;color:#94a3b8">ms</span>';
  }
  var clkEl = document.getElementById('_clk');
  if (clkEl) {
    if (_rt.calibratedAt <= 0) {
      clkEl.innerHTML = '--<span style="font-size:9px;color:#94a3b8">ms</span>';
    } else {
      var sign = _rt.clockOffsetMs >= 0 ? '+' : '';
      clkEl.innerHTML = sign + _rt.clockOffsetMs + '<span style="font-size:9px;color:#94a3b8">ms</span>';
    }
  }
}

function applyRuntimeCalibration(data) {
  if (!data) return false;
  var latency = Number(data.latencyMs);
  var offset = Number(data.clockOffsetMs);
  if (!isFinite(latency) || !isFinite(offset)) return false;

  _rt.latencyMs = Math.max(0, Math.round(latency));
  _rt.clockOffsetMs = Math.round(offset);
  _rt.calibratedAt = typeof data.calibratedAt === 'number' ? data.calibratedAt : Date.now();
  _rt.sampleCount = typeof data.sampleCount === 'number' ? Math.max(0, Math.round(data.sampleCount)) : 0;

  updateRuntimeDisplay();

  // Keep scheduler aligned to freshest calibration.
  if (_rt.nextSaleTime > 0 && !_rt.autoFired) {
    scheduleAutoFire(_rt.nextSaleTime);
  }

  return true;
}

function renderPrefireAuthStatus(data) {
  var authEl = document.getElementById('_auths');
  if (!authEl) return;

  if (!data || !data.ok) {
    authEl.style.color = '#dc2626';
    authEl.textContent = 'Auth: blocked';
    return;
  }

  var source = data.source === 'live-page' ? 'live' : 'cache';
  var ageSec = typeof data.ageMs === 'number' && data.ageMs >= 0
    ? Math.round(data.ageMs / 1000) + 's'
    : '--';
  var suffix = data.tokenSuffix ? (' ...' + data.tokenSuffix) : '';

  authEl.style.color = data.source === 'live-page' ? '#059669' : '#d97706';
  authEl.textContent = 'Auth: ' + source + ' age ' + ageSec + suffix;
}

function postMsg(type, payload) {
  window.postMessage({ __miaosha: true, type: type, payload: payload }, '*');
}
function cmdToOverlay(type) {
  window.postMessage({ __miaosha_cmd: true, type: type }, '*');
}
function postToOverlay(type, data) {
  window.postMessage({ __miaosha_overlay: true, type: type, data: data }, '*');
}

// ── Product Selection State ──
var _productMatrix = { monthly: [], quarterly: [], yearly: [] };
var _billing = 'yearly';
var _priorityList = []; // ordered priority list of { productId }
var _ticketCount = 0;
var _tickets = []; // per-ticket lifecycle list from content script
var _planOrder = ['Lite', 'Pro', 'Max'];
var _fireConfig = { payType: 'ALI', burstIntervalMs: 2100 };
