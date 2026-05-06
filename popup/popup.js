/**
 * popup.js — Side panel UI.
 * Talks to background.js via chrome.runtime.sendMessage.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let allUsers = [];
let isEnriched = false;
let currentView = 'none';      // 'none' | 'inactive' | 'active'
let currentSort = 'inactive-first';
let isFetching = false;
let isEnriching = false;
let isUnfollowing = false;
let progressWatcher = null;
let rateLimitTimer = null;
let rateLimitUntil = null;

function startRateLimitCountdown(waitMs, labelPrefix) {
  if (rateLimitTimer) {
    clearInterval(rateLimitTimer);
    rateLimitTimer = null;
  }
  const now = Date.now();
  rateLimitUntil = now + (waitMs || 0);
  const update = () => {
    const remaining = Math.max(0, rateLimitUntil - Date.now());
    const secs = Math.ceil(remaining / 1000);
    if (secs <= 0) {
      clearInterval(rateLimitTimer);
      rateLimitTimer = null;
      return;
    }
    progressLabel.textContent = `${labelPrefix} — waiting ${secs}s…`;
  };
  if (!waitMs || waitMs <= 0) return;
  update();
  rateLimitTimer = setInterval(update, 1000);
}
let hasLoadedCache = false;
let hasOnboarded = false;
let currentTheme = 'light';

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

const statusBar    = $('status-bar');
const statusText   = $('status-text');
const btnRefresh   = $('btn-refresh-status');
const btnTheme     = $('btn-theme-toggle');

const sectionNotLoggedIn = $('section-not-logged-in');
const sectionGuide       = $('section-guide');
const sectionApp         = $('section-app');

const btnGuideCheck = $('btn-guide-check');

const selectThreshold  = $('select-threshold');
const inputCustomDays  = $('input-custom-days');
const btnFetch         = $('btn-fetch');
const btnCancelFetch   = $('btn-cancel-fetch');

const progressArea    = $('progress-area');
const progressBarFill = $('progress-bar-fill');
const progressLabel   = $('progress-label');

const statsBar    = $('stats-bar');
const statTotal   = $('stat-total');
const statSelected= $('stat-selected');
const btnToggleAll = $('btn-toggle-all');
const viewTabs    = $('view-tabs');
const countNone     = $('count-none');
const countUnknown  = $('count-unknown');
const countInactive = $('count-inactive');
const countActive   = $('count-active');
const selectSort    = $('select-sort');

const listEmpty    = $('list-empty');
const listLoading  = $('list-loading');
const accountList  = $('account-list');

const unfollowFooter       = $('unfollow-footer');
const unfollowProgressArea = $('unfollow-progress-area');
const unfollowBarFill      = $('unfollow-bar-fill');
const unfollowLabel        = $('unfollow-label');
const btnUnfollow          = $('btn-unfollow');
const btnCancelUnfollow    = $('btn-cancel-unfollow');
const unfollowCount        = $('unfollow-count');

const toast = $('toast');

// ---------------------------------------------------------------------------
// Messaging — with automatic retry when the service worker was just woken up
// ---------------------------------------------------------------------------
/**
 * @param {object} [opts]
 * @param {number} [opts.retries=2] Retries when the service worker was just woken up.
 * @param {number} [opts.timeoutMs=8000] Max wait for sendResponse. Use 0 for no limit
 *   (required for FETCH_FOLLOWING / ENRICH_ACTIVITY / UNFOLLOW, which routinely exceed 8s).
 */
function send(type, payload = {}, opts = {}) {
  const _retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : 8000;
  return new Promise((resolve) => {
    const timeout =
      timeoutMs > 0
        ? setTimeout(() => resolve(null), timeoutMs)
        : null;
    function clearAndResolve(value) {
      if (timeout) clearTimeout(timeout);
      resolve(value);
    }
    function attempt(left) {
      try {
        chrome.runtime.sendMessage(
          { direction: 'FROM_POPUP', type, ...payload },
          (res) => {
            if (chrome.runtime.lastError) {
              if (left > 0) {
                setTimeout(() => attempt(left - 1), 350);
              } else {
                clearAndResolve(null);
              }
              return;
            }
            clearAndResolve(res);
          }
        );
      } catch (_) {
        clearAndResolve(null);
      }
    }
    attempt(_retries);
  });
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
let toastTimer = null;
function showToast(msg, duration = 3000) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), duration);
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------
function setStatus(state, text) {
  statusBar.className = `status-bar status-${state}`;
  statusText.textContent = text;
}

// ---------------------------------------------------------------------------
// Threshold
// ---------------------------------------------------------------------------
function getThresholdDays() {
  if (selectThreshold.value === 'custom') {
    return Math.max(1, parseInt(inputCustomDays.value, 10) || 90);
  }
  return Math.min(3650, Math.max(1, parseInt(selectThreshold.value, 10) || 90));
}

function isNoTweets(user) {
  return user.statusesCount === 0;
}

function isUnknown(user) {
  return !isNoTweets(user) && !user.lastTweetAt && !!user.activityChecked;
}

function isInactive(user) {
  if (user.statusesCount === 0) return false;
  if (user.lastTweetAt) {
    const diffMs = Date.now() - new Date(user.lastTweetAt).getTime();
    return Math.floor(diffMs / 86400000) > getThresholdDays();
  }
  return false;
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------
function formatDate(isoStr) {
  if (!isoStr) return '—';
  const days = Math.floor((Date.now() - new Date(isoStr).getTime()) / 86400000);
  if (days < 1)   return 'Today';
  if (days < 2)   return 'Yesterday';
  if (days < 30)  return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderBadge(user, enriched) {
  if (!enriched) return `<span class="badge badge-loading">checking…</span>`;
  if (user.statusesCount === 0) return `<span class="badge badge-never">No tweets</span>`;
  if (user.lastTweetAt) {
    const days = Math.floor((Date.now() - new Date(user.lastTweetAt).getTime()) / 86400000);
    return days > getThresholdDays() ? `<span class="badge badge-inactive">Inactive</span>` : '';
  }
  // activityChecked=true but no date → restricted/suspended or all tweets deleted
  if (user.activityChecked && isUnknown(user)) return `<span class="badge badge-muted">No data</span>`;
  return '';
}

function createAccountItem(user, enriched = false) {
  const inactive = enriched && isInactive(user);
  const li = document.createElement('li');
  li.className = `account-item${inactive ? ' is-inactive' : ''}`;
  li.dataset.userId = user.id;
  li.innerHTML = `
    <input type="checkbox" class="account-checkbox" data-user-id="${user.id}" />
    <img class="account-avatar" src="${escHtml(user.profileImageUrl)}" alt="" loading="lazy" />
    <div class="account-info">
      <span class="account-name">${escHtml(user.name)}</span>
      <a class="account-handle" href="https://x.com/${escHtml(user.screenName)}" target="_blank" rel="noopener noreferrer">@${escHtml(user.screenName)}</a>
    </div>
    <div class="account-meta">
      ${renderBadge(user, enriched)}
      <span class="account-last-tweet">${enriched ? formatDate(user.lastTweetAt) : ''}</span>
    </div>`;

  const avatar = li.querySelector('.account-avatar');
  avatar.addEventListener('error', () => { avatar.style.display = 'none'; });

  li.querySelector('.account-checkbox').addEventListener('change', updateStats);
  li.addEventListener('click', (e) => {
    if (e.target.classList.contains('account-checkbox')) return;
    if (e.target.closest('a')) return; // let handle link open natively
    const cb = li.querySelector('.account-checkbox');
    cb.checked = !cb.checked;
    updateStats();
  });
  return li;
}

function updateAccountItem(user, enriched) {
  const li = accountList.querySelector(`[data-user-id="${user.id}"]`);
  if (!li) return;
  const inactive = enriched && isInactive(user);
  li.className = `account-item${inactive ? ' is-inactive' : ''}`;
  li.querySelector('.account-meta').innerHTML = `
    ${renderBadge(user, enriched)}
    <span class="account-last-tweet">${enriched ? formatDate(user.lastTweetAt) : ''}</span>`;
}

// ---------------------------------------------------------------------------
// Filtering + sorting
// ---------------------------------------------------------------------------
function sortUsers(users) {
  const copy = [...users];
  switch (currentSort) {
    case 'inactive-first':
      return copy.sort((a, b) => {
        const ai = isInactive(a), bi = isInactive(b);
        if (ai && !bi) return -1;
        if (!ai && bi) return 1;
        // Within inactive group: oldest first
        if (ai && bi) {
          const ad = a.lastTweetAt ? new Date(a.lastTweetAt).getTime() : 0;
          const bd = b.lastTweetAt ? new Date(b.lastTweetAt).getTime() : 0;
          return ad - bd;
        }
        return 0;
      });
    case 'oldest-first':
      return copy.sort((a, b) => {
        const ad = a.lastTweetAt ? new Date(a.lastTweetAt).getTime() : 0;
        const bd = b.lastTweetAt ? new Date(b.lastTweetAt).getTime() : 0;
        return ad - bd;
      });
    case 'newest-first':
      return copy.sort((a, b) => {
        const ad = a.lastTweetAt ? new Date(a.lastTweetAt).getTime() : 0;
        const bd = b.lastTweetAt ? new Date(b.lastTweetAt).getTime() : 0;
        return bd - ad;
      });
    case 'followers':
      return copy.sort((a, b) => (b.followersCount || 0) - (a.followersCount || 0));
    default:
      return copy;
  }
}

function getViewUsers() {
  if (currentView === 'none')    return sortUsers(allUsers.filter(isNoTweets));
  if (currentView === 'unknown') return sortUsers(allUsers.filter(isUnknown));
  if (currentView === 'inactive')
    return sortUsers(allUsers.filter((u) => !isNoTweets(u) && !isUnknown(u) && isInactive(u)));
  if (currentView === 'active')
    return sortUsers(allUsers.filter((u) => !isNoTweets(u) && !isUnknown(u) && !isInactive(u)));
  return sortUsers(allUsers);
}

function renderList(enriched = false) {
  isEnriched = enriched;
  accountList.innerHTML = '';
  const toShow = getViewUsers();
  toShow.forEach((u) => accountList.appendChild(createAccountItem(u, enriched)));
  listEmpty.classList.toggle('hidden', allUsers.length > 0);
  statsBar.classList.toggle('hidden', allUsers.length === 0);
  viewTabs.classList.toggle('hidden', allUsers.length === 0);
  updateStats();
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
function getSelectedIds() {
  return Array.from(accountList.querySelectorAll('.account-checkbox:checked'))
    .map((cb) => cb.dataset.userId);
}

function updateStats() {
  const total       = allUsers.length;
  const noneN       = allUsers.filter(isNoTweets).length;
  const unknownN    = allUsers.filter(isUnknown).length;
  const inactiveN   = allUsers.filter((u) => !isNoTweets(u) && !isUnknown(u) && isInactive(u)).length;
  const activeN     = total - noneN - unknownN - inactiveN;
  const selected    = getSelectedIds().length;

  statTotal.textContent    = `${total} following`;
  statSelected.textContent = `${selected} selected`;
  unfollowCount.textContent = selected;

  // Tab counts
  countNone.textContent     = noneN;
  countUnknown.textContent  = unknownN;
  countInactive.textContent = inactiveN;
  countActive.textContent   = activeN;

  const showFooter = selected > 0 || isUnfollowing;
  unfollowFooter.classList.toggle('hidden', !showFooter);
  if (!isUnfollowing) unfollowProgressArea.classList.add('hidden');

  // Sync toggle-all button label with current selection state
  const checkboxes = accountList.querySelectorAll('.account-checkbox');
  const allChecked = checkboxes.length > 0 && Array.from(checkboxes).every((cb) => cb.checked);
  btnToggleAll.textContent = allChecked ? 'Deselect All' : 'Select All';
}

// ---------------------------------------------------------------------------
// Login check
// ---------------------------------------------------------------------------
async function checkLogin() {
  setStatus('checking', 'Checking…');
  btnRefresh.classList.add('spinning');
  try {
    const res = await send('PING');
    if (!res) {
      setStatus('warn', 'Service worker not responding — refresh your x.com tab and try again');
      return;
    }
    if (res.success && res.loggedIn) {
      const tokenLabel = res.tokenReady ? 'token captured ✓' : 'using fallback token';
      const fallbackWarning = res.usingFallback ? ' — token may be outdated, try refreshing x.com' : '';
      setStatus(res.usingFallback ? 'warn' : 'ok', `Logged in · ${tokenLabel}${fallbackWarning}`);
      sectionNotLoggedIn.classList.add('hidden');
      sectionGuide.classList.add('hidden');
      sectionApp.classList.remove('hidden');
      if (!hasLoadedCache) {
        await loadCachedData();
        hasLoadedCache = true;
      }
    } else {
      const err = res.error || 'Open x.com and log in first.';
      setStatus('error', err);
      sectionApp.classList.add('hidden');
      if (!hasOnboarded) {
        sectionNotLoggedIn.classList.add('hidden');
        sectionGuide.classList.remove('hidden');
      } else {
        sectionNotLoggedIn.classList.remove('hidden');
        sectionGuide.classList.add('hidden');
      }
    }
  } catch (e) {
    setStatus('error', 'Could not connect — refresh your x.com tab and try again');
  } finally {
    btnRefresh.classList.remove('spinning');
  }
}

// ---------------------------------------------------------------------------
// Load cached data
// ---------------------------------------------------------------------------
async function loadCachedData() {
  const res = await send('GET_CACHED');
  if (res?.success && res.followingList?.length) {
    allUsers = res.followingList;
    // Consider enriched if any user has the activityChecked flag or a lastTweetAt date
    const enriched = allUsers.some((u) => u.activityChecked || u.lastTweetAt !== null);
    listLoading.classList.add('hidden');
    renderList(enriched);
    if (res.fetchedAt) {
      const mins = Math.round((Date.now() - res.fetchedAt) / 60000);
      const inactiveN = allUsers.filter(isInactive).length;
      showToast(`${allUsers.length} accounts (${inactiveN} inactive) — cached ${mins}m ago`);
    }
  }
}

// ---------------------------------------------------------------------------
// Fetch following
// ---------------------------------------------------------------------------
function startProgressWatcher(storageKey, onUpdate) {
  stopProgressWatcher();
  progressWatcher = setInterval(async () => {
    const data = await chrome.storage.local.get(storageKey);
    if (data[storageKey]) onUpdate(data[storageKey]);
  }, 350);
}

function stopProgressWatcher() {
  if (progressWatcher) { clearInterval(progressWatcher); progressWatcher = null; }
  if (rateLimitTimer) { clearInterval(rateLimitTimer); rateLimitTimer = null; }
}

async function startFetch() {
  isFetching = true;
  btnFetch.disabled = true;
  btnCancelFetch.classList.remove('hidden');
  progressArea.classList.remove('hidden');
  progressBarFill.style.width = '0%';
  progressLabel.textContent = 'Fetching following list…';
  await chrome.storage.local.remove('enrichProgress');
  // Keep existing list visible while the network request runs

  startProgressWatcher('fetchProgress', (p) => {
    if (p.phase === 'fetch_page') {
      if (rateLimitTimer) { clearInterval(rateLimitTimer); rateLimitTimer = null; }
      progressLabel.textContent = `Page ${p.page} — ${p.total} accounts…`;
      progressBarFill.style.width = `${Math.min(5 + p.page * 3, 68)}%`;
    } else if (p.phase === 'rate_limit') {
      const secs = Math.ceil(p.waitMs / 1000);
      setStatus('warn', `Rate limited (${secs}s)`);
      startRateLimitCountdown(p.waitMs, 'Rate limited');
    }
  });

  try {
    const res = await send('FETCH_FOLLOWING', {}, { timeoutMs: 0 });
    stopProgressWatcher();

    if (!res) {
      showToast('Panel disconnected — close and reopen the side panel.', 6000);
      setStatus('warn', 'Disconnected');
      resetFetchUI();
      return;
    }
    if (!res.success) {
      showToast(res.error || 'Fetch cancelled.', 5000);
      setStatus('warn', res.error || 'Fetch cancelled');
      resetFetchUI();
      return;
    }

    const merged = res.users;
    const newCount = res.newCount ?? merged.length;
    progressBarFill.style.width = '70%';

    allUsers = merged;
    // Render immediately — show known data; accounts still needing a check show no badge
    const hasEnrichedData = merged.some((u) => u.activityChecked !== undefined);
    listLoading.classList.add('hidden');
    renderList(hasEnrichedData);

    // Mark onboarding complete on first successful fetch
    if (!hasOnboarded) {
      hasOnboarded = true;
      await chrome.storage.local.set({ hasOnboarded: true });
    }

    // Accounts whose last status was a native RT (or had no status) still need one API call
    // to find their last original post. Also retry anyone previously marked Unknown —
    // we now have better fallbacks (include_rts=1 + lastRetweetAt) that may resolve them.
    const needsEnrichment = merged.some(
      (u) => !u.protected && u.statusesCount !== 0 &&
             (u.activityChecked === undefined || isUnknown(u))
    );

    if (!needsEnrichment) {
      // Everything resolved — either from inline status or cache, no extra API calls needed
      progressBarFill.style.width = '100%';
      const inactive = allUsers.filter(isInactive).length;
      if (newCount === 0) {
        progressLabel.textContent = `No new accounts — all ${merged.length} up to date.`;
        showToast(`All ${merged.length} accounts up to date.`);
      } else {
        progressLabel.textContent = `Done — ${inactive} inactive account${inactive !== 1 ? 's' : ''} found.`;
        showToast(`${newCount} new account${newCount !== 1 ? 's' : ''} added.`);
      }
      setStatus('ok', `${allUsers.length} accounts · ${inactive} inactive`);
      setTimeout(() => progressArea.classList.add('hidden'), 3000);
      resetFetchUI();
    } else {
      // Some accounts only retweet — need user_timeline call to find their last original post
      progressLabel.textContent = hasEnrichedData
        ? `${newCount > 0 ? `${newCount} new — ` : ''}checking remaining activity…`
        : `Got ${merged.length} accounts — checking activity…`;
      await startEnrich(merged);
    }
  } catch (e) {
    stopProgressWatcher();
    showToast(`Error: ${e.message}`, 6000);
    setStatus('error', e.message);
    resetFetchUI();
  }
}

async function startEnrich(users) {
  isEnriching = true;
  await chrome.storage.local.remove('enrichProgress');
  startProgressWatcher('enrichProgress', (p) => {
    if (p.phase === 'enrich' && p.total > 0) {
      if (rateLimitTimer) { clearInterval(rateLimitTimer); rateLimitTimer = null; }
      const pct = 70 + Math.round((p.index / p.total) * 30);
      progressBarFill.style.width = `${pct}%`;
      progressLabel.textContent = `Checking activity: ${p.index + 1} / ${p.total}`;
      if (p.user) {
        // Keep allUsers in sync so partial state is correct if enrichment is interrupted.
        const idx = allUsers.findIndex((u) => u.id === p.user.id);
        if (idx !== -1) allUsers[idx] = p.user;
        updateAccountItem(p.user, true);
        updateStats();
      }
    } else if (p.phase === 'rate_limit') {
      startRateLimitCountdown(p.waitMs, 'Rate limited');
    }
  });

  try {
    const res = await send('ENRICH_ACTIVITY', { users }, { timeoutMs: 0 });
    stopProgressWatcher();

    if (!res) {
      showToast('Panel disconnected — close and reopen the side panel.', 6000);
      setStatus('warn', 'Disconnected');
    } else if (res.success) {
      allUsers = res.users;
      const inactive = allUsers.filter(isInactive).length;

      // Auto-switch to Inactive tab if any were found
      if (inactive > 0) {
        currentView = 'inactive';
        document.querySelectorAll('.view-tab').forEach((b) => {
          b.classList.toggle('active', b.dataset.view === 'inactive');
        });
      }

      renderList(true);
      progressBarFill.style.width = '100%';
      progressLabel.textContent = `Done — ${inactive} inactive account${inactive !== 1 ? 's' : ''} found.`;
      setStatus('ok', `${allUsers.length} accounts · ${inactive} inactive`);
      setTimeout(() => progressArea.classList.add('hidden'), 3000);
    } else if (res.cancelled) {
      showToast('Activity check cancelled.', 3000);
    } else {
      showToast(res.error || 'Activity check failed.', 6000);
      setStatus('error', res.error || 'Activity check failed');
    }
  } catch (e) {
    stopProgressWatcher();
    showToast(`Activity check error: ${e.message}`, 6000);
    setStatus('error', e.message);
  } finally {
    isEnriching = false;
    resetFetchUI();
  }
}

function resetFetchUI() {
  isFetching = false;
  isEnriching = false;
  btnFetch.disabled = false;
  btnCancelFetch.classList.add('hidden');
  listLoading.classList.add('hidden');
  stopProgressWatcher();
}

// ---------------------------------------------------------------------------
// Unfollow
// ---------------------------------------------------------------------------
async function startUnfollow() {
  const ids = getSelectedIds();
  if (ids.length === 0) return;
  if (!confirm(`Unfollow ${ids.length} account${ids.length !== 1 ? 's' : ''}?`)) return;

  isUnfollowing = true;
  btnUnfollow.disabled = true;
  btnCancelUnfollow.classList.remove('hidden');
  unfollowProgressArea.classList.remove('hidden');
  unfollowBarFill.style.width = '0%';
  unfollowLabel.textContent = `Unfollowing 0 / ${ids.length}…`;

  startProgressWatcher('unfollowProgress', (p) => {
    if (p.phase === 'unfollow_progress') {
      const pct = Math.round((p.done / p.total) * 100);
      unfollowBarFill.style.width = `${pct}%`;
      unfollowLabel.textContent = `Unfollowing ${p.done} / ${p.total}…`;
      const li = accountList.querySelector(`[data-user-id="${p.userId}"]`);
      if (li) li.classList.add('is-unfollowed');
    } else if (p.phase === 'unfollow_error') {
      const li = accountList.querySelector(`[data-user-id="${p.userId}"]`);
      if (li) {
        li.classList.add('is-unfollow-failed');
        li.title = p.error || 'Unfollow failed';
      }
    } else if (p.phase === 'rate_limit') {
      unfollowLabel.textContent = `Rate limited — waiting ${Math.ceil(p.waitMs / 1000)}s…`;
    }
  });

  try {
    const res = await send('UNFOLLOW', { userIds: ids }, { timeoutMs: 0 });
    stopProgressWatcher();
    const p = res?.progress || {};
    const done = p.done ?? 0;
    const phase = p.phase || '';

    // If user cancelled, don't treat remaining accounts as successfully unfollowed.
    if (phase === 'unfollow_cancelled') {
      // Remove only the ones we actually unfollowed (marked in the DOM).
      const removedIds = Array.from(
        accountList.querySelectorAll('.account-item.is-unfollowed')
      ).map((li) => li.dataset.userId);

      if (removedIds.length > 0) {
        await send('REMOVE_UNFOLLOWED', { userIds: removedIds });
        allUsers = allUsers.filter((u) => !removedIds.includes(u.id));
        renderList(true);
      }

      unfollowBarFill.style.width = `${Math.round((done / ids.length) * 100)}%`;
      unfollowLabel.textContent = `Stopped after ${done} / ${ids.length}.`;
      showToast(`Unfollow stopped after ${done} account${done !== 1 ? 's' : ''}.`, 6000);
      setStatus('warn', `Unfollow stopped at ${done}/${ids.length}`);
      return;
    }
    const failedIds = new Set(p.failed || []);
    const errorsMap = p.errors || {};
    const successfulIds = ids.filter((id) => !failedIds.has(id));
    unfollowBarFill.style.width = '100%';
    const failedCount = failedIds.size;
    if (failedCount > 0) {
      const firstError = Object.values(errorsMap)[0] || 'Unknown error';
      unfollowLabel.textContent = `Unfollowed ${done} / ${ids.length} — ${failedCount} failed.`;
      const is401 = /401|authentication failed|logged into x\.com/i.test(firstError);
      const toastMsg = is401
        ? 'Session expired. Refresh your x.com tab (or log in again), then try unfollow again.'
        : `${failedCount} unfollow${failedCount !== 1 ? 's' : ''} failed: ${firstError}`;
      showToast(toastMsg, is401 ? 12000 : 8000);
      setStatus('warn', `${done} unfollowed, ${failedCount} failed`);
    } else {
      unfollowLabel.textContent = `Unfollowed ${done} account${done !== 1 ? 's' : ''}.`;
      showToast(`Unfollowed ${done} account${done !== 1 ? 's' : ''}.`);
      setStatus('ok', `Unfollowed ${done}`);
    }

    if (successfulIds.length > 0) {
      await send('REMOVE_UNFOLLOWED', { userIds: successfulIds });
      allUsers = allUsers.filter((u) => !successfulIds.includes(u.id));
      renderList(true);
    }
  } catch (e) {
    stopProgressWatcher();
    showToast(`Error: ${e.message}`, 6000);
    setStatus('error', e.message);
  } finally {
    isUnfollowing = false;
    btnUnfollow.disabled = false;
    btnCancelUnfollow.classList.add('hidden');
    setTimeout(() => { unfollowProgressArea.classList.add('hidden'); updateStats(); }, 3000);
  }
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------
btnRefresh.addEventListener('click', checkLogin);

selectThreshold.addEventListener('change', () => {
  const custom = selectThreshold.value === 'custom';
  inputCustomDays.classList.toggle('hidden', !custom);
  if (!custom) { renderList(true); }
});
inputCustomDays.addEventListener('input', () => renderList(true));

btnFetch.addEventListener('click', () => { if (!isFetching && !isEnriching) startFetch(); });

btnCancelFetch.addEventListener('click', async () => {
  await send('CANCEL_FETCH');
  btnCancelFetch.classList.add('hidden');
  showToast('Fetch cancelled.');
});

btnToggleAll.addEventListener('click', () => {
  // Toggle between select all / deselect all for accounts currently visible in the active tab
  const checkboxes = accountList.querySelectorAll('.account-checkbox');
  const allChecked = Array.from(checkboxes).every((cb) => cb.checked);
  if (allChecked) {
    checkboxes.forEach((cb) => { cb.checked = false; });
    btnToggleAll.textContent = 'Select All';
  } else {
    checkboxes.forEach((cb) => { cb.checked = true; });
    btnToggleAll.textContent = 'Deselect All';
  }
  updateStats();
});

// View filter tabs
document.querySelectorAll('.view-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.view-tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentView = btn.dataset.view;
    renderList(isEnriched);
    // Restore scroll to top when switching tabs
    $('list-container').scrollTop = 0;
  });
});

// Sort select
selectSort.addEventListener('change', () => {
  currentSort = selectSort.value;
  renderList(isEnriched);
  $('list-container').scrollTop = 0;
});

btnUnfollow.addEventListener('click', startUnfollow);
btnCancelUnfollow.addEventListener('click', async () => {
  await send('CANCEL_UNFOLLOW');
  showToast('Unfollow stopped.');
});

// ---------------------------------------------------------------------------
// Onboarding guide
// ---------------------------------------------------------------------------
async function markOnboarded() {
  hasOnboarded = true;
  await chrome.storage.local.set({ hasOnboarded: true });
  sectionGuide.classList.add('hidden');
  await checkLogin();
}

btnGuideCheck.addEventListener('click', markOnboarded);

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
const moonIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>';
const sunIcon  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>';

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  btnTheme.innerHTML = theme === 'dark' ? sunIcon : moonIcon;
  btnTheme.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
}

async function toggleTheme() {
  const next = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { await chrome.storage.local.set({ theme: next }); } catch (_) {}
}

btnTheme.addEventListener('click', toggleTheme);

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  try {
    const stored = await chrome.storage.local.get(['hasOnboarded', 'theme']);
    hasOnboarded = !!stored.hasOnboarded;
    const theme = stored.theme
      || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    applyTheme(theme);
  } catch (_) {
    hasOnboarded = false;
    applyTheme('light');
  }

  if (hasOnboarded) {
    setStatus('checking', 'Checking…');
    await checkLogin();
  } else {
    setStatus('ok', 'Ready');
    sectionNotLoggedIn.classList.add('hidden');
    sectionGuide.classList.remove('hidden');
    sectionApp.classList.add('hidden');
  }
}

init().catch(() => {});
