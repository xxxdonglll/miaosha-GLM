// ── Auto Relogin Engine ──
// Handles: maxShots depleted → logout → login → continue firing

var _reloginAbort = false;

function _rel_sleep(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

function _rel_waitForEl(selector, timeout, checkFn) {
  var start = Date.now();
  return new Promise(function(resolve) {
    function poll() {
      if (_reloginAbort) { resolve(null); return; }
      if (Date.now() - start > timeout) { resolve(null); return; }
      var el = document.querySelector(selector);
      if (el && (!checkFn || checkFn(el))) { resolve(el); return; }
      setTimeout(poll, 200);
    }
    poll();
  });
}

function _rel_waitForAuthReady(ready, timeout) {
  var start = Date.now();
  return new Promise(function(resolve) {
    function poll() {
      if (_reloginAbort) { resolve(false); return; }
      if (Date.now() - start > timeout) { resolve(false); return; }
      var hasCookie = document.cookie.indexOf('bigmodel_token_production') !== -1;
      var hasUser = hasCookie &&
        !!localStorage.getItem('Bigmodel-Organization') &&
        !!localStorage.getItem('Bigmodel-Project');
      var authReady = hasCookie && hasUser;
      if (authReady === ready) { resolve(true); return; }
      setTimeout(poll, 300);
    }
    poll();
  });
}

function _rel_dispatchMouseEvent(el, evtType) {
  var evt = new MouseEvent(evtType, { bubbles: true, cancelable: true });
  el.dispatchEvent(evt);
}

function _rel_updateStatus(text) {
  postToOverlay('AUTO_RELOGIN_STATUS', { text: text, round: _reloginRound });
}

async function autoReloginSequence() {
  if (_isAutoRelogin) return;
  _isAutoRelogin = true;
  _reloginAbort = false;
  _reloginRound++;

  _rel_updateStatus('Round ' + _reloginRound + ': logging out...');

  // ── Phase 1: Logout ──
  // 1a. Hover avatar to open user dropdown
  var avatar = document.querySelector('img.user-img');
  if (!avatar) {
    _rel_updateStatus('Logout failed: avatar not found');
    _isAutoRelogin = false;
    return;
  }
  var dropdownTrigger = avatar.closest('.el-dropdown-selfdefine') || avatar.parentElement;
  _rel_dispatchMouseEvent(dropdownTrigger, 'mouseenter');
  await _rel_sleep(400);

  // 1b. Click "退出登录" menu item
  var logoutItem = document.querySelector('li[name="退出登录"]');
  if (!logoutItem) {
    _rel_updateStatus('Logout failed: menu item not found');
    _isAutoRelogin = false;
    return;
  }
  logoutItem.click();
  await _rel_sleep(500);

  // 1c. Confirm logout dialog — click "确定"
  var confirmBtn = document.querySelector('.el-message-box__btns .el-button--primary');
  if (confirmBtn) {
    confirmBtn.click();
  } else {
    _rel_updateStatus('Logout failed: confirm dialog not found');
    _isAutoRelogin = false;
    return;
  }

  // 1d. Wait for auth to become not-ready
  var loggedOut = await _rel_waitForAuthReady(false, 10000);
  if (_reloginAbort) { _isAutoRelogin = false; return; }
  if (!loggedOut) {
    _rel_updateStatus('Logout timeout ⚠');
    // Continue anyway — login will fail if still logged in
  }
  await _rel_sleep(500);

  _rel_updateStatus('Logged out. Logging in...');

  // ── Phase 2: Login ──
  // 2a. Open login modal
  var regBtn = document.querySelector('.register-btn');
  if (!regBtn) {
    _rel_updateStatus('Login failed: register button not found');
    _isAutoRelogin = false;
    return;
  }
  regBtn.click();
  await _rel_sleep(800);

  // 2b. Switch to password tab
  var passTab = document.getElementById('tab-password');
  if (passTab) {
    passTab.click();
    await _rel_sleep(500);
  }

  // 2c. Wait for Chrome auto-fill (password input has value)
  var pwInput = await _rel_waitForEl('#pane-password input[type="password"]', 5000, function(el) {
    return el.value && el.value.length > 0;
  });
  if (!pwInput) {
    _rel_updateStatus('Auto-fill timeout — trying login anyway');
  }
  await _rel_sleep(300);

  // 2d. Click login button
  var loginBtn = document.querySelector('#pane-password .login-btn.el-button--primary');
  if (!loginBtn) {
    _rel_updateStatus('Login failed: submit button not found');
    _isAutoRelogin = false;
    return;
  }
  loginBtn.click();

  // 2e. Wait for auth to become ready
  var loggedIn = await _rel_waitForAuthReady(true, 20000);
  if (_reloginAbort) { _isAutoRelogin = false; return; }
  if (!loggedIn) {
    _rel_updateStatus('Login timeout ⚠');
    _isAutoRelogin = false;
    return;
  }
  await _rel_sleep(1000);

  // ── Phase 3: Resume fire ──
  // Keep existing tickets and resume firing (service may accept them after re-login)
  _rel_updateStatus('Login OK, resuming fire...');
  await _rel_sleep(1500);

  _isAutoRelogin = false;

  window.postMessage({ __miaosha_cmd: true, type: 'AUTO_RELOGIN_DONE' }, '*');
}

// ── Listen for AUTO_RELOGIN_START from content script ──
window.addEventListener('message', function(ev) {
  if (ev.source !== window || !ev.data || !ev.data.__miaosha_overlay) return;
  if (ev.data.type === 'AUTO_RELOGIN_START') {
    autoReloginSequence();
  }
});

// ── Esc to abort relogin cycle ──
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && _isAutoRelogin) {
    _reloginAbort = true;
    _isAutoRelogin = false;
    var autoEl = document.getElementById('_auto');
    if (autoEl) { autoEl.style.color = '#dc2626'; autoEl.textContent = 'Auto-relogin stopped by user'; }
  }
}, true);
