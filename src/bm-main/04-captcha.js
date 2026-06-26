function produceCaptcha() {
  if (typeof window.TencentCaptcha === 'undefined') { postMsg('CAPTCHA_ERROR', { msg: 'SDK not loaded' }); return; }
  try {
    var c = new window.TencentCaptcha(CAPTCHA_APPID, function(res) {
      _activeCaptcha = null;
      if (res.ret === 0 && res.ticket) {
        postMsg('CAPTCHA_PRODUCED', { ticket: res.ticket, randstr: res.randstr });
        // Batch mode: count and auto-stop at session limit
        if (_batchMode) {
          _batchCount++;
          if (_batchCount >= BATCH_SESSION_LIMIT) {
            setBatchMode(false);
            return;
          }
          setTimeout(produceCaptcha, 300);
        }
      }
      else {
        postMsg('CAPTCHA_ERROR', { msg: 'Failed (ret=' + res.ret + ')' });
        if (_batchMode) { setTimeout(produceCaptcha, 500); }
      }
    }, { mode: 'popup' });
    _activeCaptcha = c;
    c.show();
    // Auto-solve captcha if OCR service is enabled
    if (AUTO_SOLVE) {
      setTimeout(autoSolveCaptcha, 600);
    }
  } catch(e) { postMsg('CAPTCHA_ERROR', { msg: e.message }); }
}

// ── OCR auto-solve ──
var _solvingGen = 0;

function autoSolveCaptcha() {
  if (_solveInFlight) return;
  var gen = ++_solvingGen;
  var bgEl = document.querySelector('.tencent-captcha-dy__verify-bg-img');
  var headerEl = document.querySelector('.tencent-captcha-dy__header-text');
  if (!bgEl || !headerEl) {
    if (_activeCaptcha) setTimeout(autoSolveCaptcha, 200);
    return;
  }

  var headerText = headerEl.textContent || '';
  var chars = headerText.replace('请依次点击：', '').trim().split(/\s+/).filter(Boolean);
  if (chars.length !== 3) {
    if (_activeCaptcha) setTimeout(autoSolveCaptcha, 200);
    return;
  }

  var bg = bgEl.style.backgroundImage;
  var imageUrl = bg.replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
  if (!imageUrl) {
    if (_activeCaptcha) setTimeout(autoSolveCaptcha, 200);
    return;
  }

  _solveInFlight = true;

  fetch(OCR_SERVICE_URL + '/solve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_url: imageUrl,
      chars: chars,
      confidence_threshold: CONFIDENCE_THRESHOLD,
    }),
  })
  .then(function(r) {
    if (!r.ok) throw new Error('OCR service returned ' + r.status);
    return r.json();
  })
  .then(function(data) {
    if (gen !== _solvingGen) return;
    if (!data.positions || data.positions.length !== 3) throw new Error('Invalid OCR response');

    var displayW = bgEl.offsetWidth;
    var displayH = bgEl.offsetHeight;
    var scaleX = displayW / data.image_width;
    var scaleY = displayH / data.image_height;

    var totalDelay = 0;
    data.positions.forEach(function(p, i) {
      var delay = CLICK_INTERVAL;
      totalDelay += delay;
      var d = totalDelay;
      setTimeout(function() {
        if (gen !== _solvingGen) return;
        var offsetX = (Math.random() - 0.5) * CLICK_JITTER * 2;
        var offsetY = (Math.random() - 0.5) * CLICK_JITTER * 2;
        clickCaptchaChar(bgEl, p.x * scaleX + offsetX, p.y * scaleY + offsetY);
      }, d);
    });

    setTimeout(function() {
      if (gen !== _solvingGen) return;
      var confirmBtn = document.querySelector('.tencent-captcha-dy__verify-confirm-btn');
      if (confirmBtn && !confirmBtn.classList.contains('tencent-captcha-dy__verify-confirm-btn--disabled')) {
        confirmBtn.click();
      }
    }, totalDelay + 300);

    setTimeout(function() {
      if (gen !== _solvingGen) return;
      var stillOpen = document.querySelector('.tencent-captcha-dy__verify-bg-img');
      if (stillOpen && _activeCaptcha) {
        var refreshBtn = document.querySelector('.tencent-captcha-dy__footer-icon--refresh');
        if (refreshBtn) refreshBtn.click();
        setTimeout(autoSolveCaptcha, 500);
      }
    }, totalDelay + 1300);

    _solveInFlight = false;
  })
  .catch(function(err) {
    _solveInFlight = false;
    if (_activeCaptcha) {
      var refreshBtn = document.querySelector('.tencent-captcha-dy__footer-icon--refresh');
      if (refreshBtn) refreshBtn.click();
      setTimeout(autoSolveCaptcha, 500);
    }
  });
}

function clickCaptchaChar(bgEl, x, y) {
  var rect = bgEl.getBoundingClientRect();
  bgEl.dispatchEvent(new MouseEvent('click', {
    clientX: rect.left + x,
    clientY: rect.top + y,
    bubbles: true,
    cancelable: true,
    view: window,
  }));
}

// Force-destroy the currently active captcha modal (for ESC / force-stop)
function destroyActiveCaptcha() {
  if (!_activeCaptcha) return;
  try { _activeCaptcha.destroy(); } catch(e) {}
  _activeCaptcha = null;
}

function setBatchMode(on) {
  _batchMode = on;
  if (on) _batchCount = 0;
  var btn = document.getElementById('_ab');
  if (btn) {
    if (on) {
      btn.innerHTML = '&#9632; Stop Batch <span style="font-size:7px;font-weight:600;opacity:.6;margin-left:4px">(Esc)</span>';
      btn.style.borderColor = '#dc2626';
      btn.style.color = '#dc2626';
      btn.style.background = 'rgba(220,38,38,0.03)';
    } else {
      btn.innerHTML = '+ Solve Captcha';
      btn.style.borderColor = '';
      btn.style.color = '';
      btn.style.background = '';
    }
  }
  // Notify ISOLATED world to show/hide the full-width force-stop banner
  postMsg('BATCH_MODE_STATUS', { active: on });
  if (on) {
    produceCaptcha();
  } else {
    // Immediately close any active captcha modal
    destroyActiveCaptcha();
  }
}

function toggleBatchMode() { setBatchMode(!_batchMode); }

// ── Auto-cleanup on successful order: close captcha modal and exit batch mode
// so the bigmodel.cn native payment UI is not blocked by extension UI. ──
window.addEventListener('message', function(e) {
  if (!e.data || e.data.__miaosha_overlay !== true) return;
  if (e.data.type === 'BURST_FIRE_SUCCESS' && e.data.data && e.data.data.bizId) {
    destroyActiveCaptcha();
    if (_batchMode) setBatchMode(false);
  }
});

// ── Keyboard shortcut: Escape to stop batch ──
function setupCaptchaKeyboard() {
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && _batchMode) {
      e.preventDefault();
      e.stopPropagation();
      // Force-destroy the modal BEFORE setting batch mode off,
      // so the modal closes instantly without waiting for callback.
      destroyActiveCaptcha();
      setBatchMode(false);
    }
  }, true);
}
setupCaptchaKeyboard();
