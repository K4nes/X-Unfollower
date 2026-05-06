/**
 * content.js — Runs in MAIN world on x.com.
 * All X API calls happen here (needs page cookies for auth).
 * Communicates with background via window.postMessage ↔ bridge.js ↔ chrome.runtime.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// X's web-client bearer token — embedded in their JS bundle since 2019.
// %3D is the correct literal form as it appears in the Authorization header.
const FALLBACK_BEARER_TOKEN =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I7wHoABWeg%3DZHRM8OMAz5e0fhMQqeyqlZMEaYAFIKyRmDQiLHJU4vasE4GMLY';

const UNFOLLOW_DELAY_MS = 2000; // one account at a time, 2s apart to reduce rate-limit / bot risk
const FETCH_PAGE_DELAY_MS = 600;
const RATE_LIMIT_BACKOFF_MS = 65000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let capturedBearerToken = null;
let usingFallbackToken = false;
let fetchGeneration = 0;
let unfollowGeneration = 0;

// ---------------------------------------------------------------------------
// Debug logger
// ---------------------------------------------------------------------------

function dbg(level, message, data) {
  const entry = { direction: 'FROM_PAGE', type: 'LOG', ts: Date.now(), level, message };
  if (data !== undefined) {
    try {
      entry.data = JSON.parse(JSON.stringify(data, (k, v) =>
        typeof k === 'string' && /auth|token|bearer|password/i.test(k) ? '[redacted]' : v
      ));
    } catch (_) {
      entry.data = String(data);
    }
  }
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](
    `[XUnfollower] ${message}`, data ?? ''
  );
  window.postMessage(entry, location.origin);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function getCsrfToken() {
  const m = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
  return m ? m[1] : null;
}

function getLoggedInUserId() {
  const m = document.cookie.match(/(?:^|;\s*)twid=u%3D(\d+)/);
  return m ? m[1] : null;
}

function isLoggedIn() {
  return !!getCsrfToken() && !!getLoggedInUserId();
}

// Generates a fresh x-client-transaction-id in X's format (66 random bytes → base64).
// X requires this header for all write operations; without it the server returns 401.
function generateTransactionId() {
  const bytes = new Uint8Array(66);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

function buildHeaders() {
  const csrf = getCsrfToken();
  if (!csrf) {
    dbg('error', 'ct0 CSRF cookie missing — are you logged into x.com?');
    throw new Error('Not logged in — ct0 cookie missing');
  }
  const token = capturedBearerToken || FALLBACK_BEARER_TOKEN;
  return {
    authorization: `Bearer ${token}`,
    'x-csrf-token': csrf,
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
    'x-client-transaction-id': generateTransactionId(),
  };
}

// ---------------------------------------------------------------------------
// Bearer token acquisition — three strategies tried in order
// ---------------------------------------------------------------------------

// Strategy A: search already-loaded inline <script> blocks (instant, synchronous).
// The token is a 100+ char string starting with "AAAA" baked into x.com's bundle.
function searchInlineScripts() {
  const pattern = /AAAA[A-Za-z0-9%]{80,}/;
  for (const el of document.querySelectorAll('script:not([src])')) {
    const m = el.textContent.match(pattern);
    if (m) {
      dbg('info', 'Bearer token found in inline script', { prefix: m[0].slice(0, 16) + '…' });
      return m[0];
    }
  }
  return null;
}

// Strategy B: fetch x.com's external JS bundles and search inside them.
async function searchExternalScripts() {
  const pattern = /AAAA[A-Za-z0-9%]{80,}/;
  const srcs = Array.from(document.querySelectorAll('script[src]'))
    .map((s) => s.src)
    .filter((s) => s.includes('twimg.com') || s.includes('x.com'))
    .slice(0, 10);

  for (const src of srcs) {
    try {
      const text = await fetch(src, { credentials: 'omit' }).then((r) => r.text());
      const m = text.match(pattern);
      if (m) {
        dbg('info', 'Bearer token found in JS bundle', {
          file: src.split('/').pop().slice(0, 30),
          prefix: m[0].slice(0, 16) + '…',
        });
        return m[0];
      }
    } catch (_) {}
  }
  return null;
}

// Strategy C: intercept x.com's own fetch calls to read auth headers.
(function interceptFetch() {
  const original = window.fetch;
  window.fetch = async function (...args) {
    const req = args[0];
    const init = args[1];
    const url = (req instanceof Request ? req.url : String(req || ''));

    if (url.includes('/i/api/')) {
      let auth = null;
      try {
        if (req instanceof Request) {
          auth = req.headers.get('authorization');
        } else if (init?.headers) {
          const h = init.headers;
          auth = (h instanceof Headers)
            ? h.get('authorization')
            : (h['authorization'] || h['Authorization'] || null);
        }
      } catch (_) {}

      if (!capturedBearerToken && auth?.startsWith('Bearer ')) {
        capturedBearerToken = auth.slice(7);
        dbg('info', 'Bearer token captured from live page traffic',
          { prefix: capturedBearerToken.slice(0, 16) + '…' });
      }
    }

    return original.apply(this, args);
  };
})();

// Master: try all strategies before falling back to hardcoded constant.
async function acquireBearerToken() {
  if (capturedBearerToken) return capturedBearerToken;

  const fromInline = searchInlineScripts();
  if (fromInline) { capturedBearerToken = fromInline; return capturedBearerToken; }

  const fromBundle = await searchExternalScripts();
  if (fromBundle) { capturedBearerToken = fromBundle; return capturedBearerToken; }

  // Brief wait in case the page makes a natural API call while we searched
  for (let i = 0; i < 15; i++) {
    await sleep(100);
    if (capturedBearerToken) return capturedBearerToken;
  }

  dbg('warn', 'All token discovery methods failed — using hardcoded fallback');
  usingFallbackToken = true;
  return FALLBACK_BEARER_TOKEN;
}

// ---------------------------------------------------------------------------
// Generic API fetch wrapper
// ---------------------------------------------------------------------------

async function xFetch(url, options = {}) {
  const shortUrl = url.split('?')[0];
  dbg('info', `→ ${options.method || 'GET'} ${shortUrl}`, {
    usingCapturedToken: !!capturedBearerToken,
    csrfPresent: !!getCsrfToken(),
  });

  let res;
  try {
    res = await fetch(url, {
      ...options,
      headers: { ...buildHeaders(), ...(options.headers || {}) },
      credentials: 'include',
    });
  } catch (netErr) {
    dbg('error', `Network error: ${shortUrl}`, { message: netErr.message });
    throw netErr;
  }

  dbg('info', `← ${res.status} ${shortUrl}`, {
    rateLimitRemaining: res.headers.get('x-rate-limit-remaining'),
    rateLimitReset: res.headers.get('x-rate-limit-reset'),
  });

  if (res.status === 429) {
    const resetTs = res.headers.get('x-rate-limit-reset');
    const waitMs = resetTs
      ? Math.max(0, Number(resetTs) * 1000 - Date.now()) + 2000
      : RATE_LIMIT_BACKOFF_MS;
    dbg('warn', `Rate limited: ${shortUrl}`, { waitMs });
    throw { type: 'RATE_LIMIT', waitMs };
  }

  if (res.status === 401) {
    const body = await res.text().catch(() => '');
    dbg('error', `401 Unauthorized: ${shortUrl}`, {
      body: body.slice(0, 300),
      csrfPresent: !!getCsrfToken(),
      usingCapturedToken: !!capturedBearerToken,
      cookiesPresent: document.cookie
        .split(';')
        .map((c) => c.trim().split('=')[0])
        .filter((n) => ['ct0', 'twid', 'auth_token'].includes(n)),
    });
    capturedBearerToken = null; // reset so next attempt re-discovers
    throw new Error(
      '401 — authentication failed. Make sure you are fully logged into x.com ' +
      '(check that your timeline loads), then try again.'
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    dbg('error', `HTTP ${res.status}: ${shortUrl}`, { body: body.slice(0, 300) });
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const text = await res.text().catch(() => '');
  if (!text.trim()) {
    dbg('info', `Empty response body from ${shortUrl} (account may be suspended or restricted)`);
    return null;
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    dbg('warn', `Non-JSON response from ${shortUrl}`, { body: text.slice(0, 200) });
    throw new Error(`Malformed response from ${shortUrl}`);
  }
  if (json?.errors?.length) {
    dbg('warn', `API errors on ${shortUrl}`, { errors: json.errors });
  }
  return json;
}

// ---------------------------------------------------------------------------
// Following list — v1.1 REST (stable, no queryId required)
// GET /1.1/friends/list.json
// ---------------------------------------------------------------------------

async function fetchFollowingPage(userId, cursor) {
  const params = new URLSearchParams({
    user_id: userId,
    count: '200',
    skip_status: '0',         // include each user's last status so we can read lastTweetAt for free
    include_user_entities: '0',
  });
  if (cursor && cursor !== '0') params.set('cursor', cursor);

  dbg('info', 'fetchFollowingPage', { cursor: cursor || null });
  const data = await xFetch(`https://x.com/i/api/1.1/friends/list.json?${params}`);

  const users = (data?.users || []).map((u) => {
    // If the user's most recent status is an original post (not a native RT), use its date
    // directly — this avoids a separate user_timeline API call for most accounts.
    let lastTweetAt = null;
    let lastRetweetAt = null; // captured as a fallback when last status is a retweet
    let activityChecked; // undefined = needs enrichment; true/false = already determined
    const s = u.status;
    if (s && s.created_at) {
      try {
        const dateIso = new Date(s.created_at).toISOString();
        if (!s.retweeted_status) {
          lastTweetAt = dateIso;
          activityChecked = true;
        } else {
          // Last visible action was a retweet — save it as a fallback so enrichment
          // can use it if user_timeline returns no original posts.
          lastRetweetAt = dateIso;
          // activityChecked stays undefined → enrichment will still run to find
          // the last original post date via user_timeline.
        }
      } catch (_) { /* date parse failure — fall through to enrichment */ }
    }

    return {
      id: u.id_str,
      screenName: u.screen_name,
      name: u.name,
      profileImageUrl: (u.profile_image_url_https || '').replace('_normal', '_bigger'),
      followersCount: u.followers_count,
      friendsCount: u.friends_count,
      statusesCount: u.statuses_count,
      lastTweetAt,
      lastRetweetAt,
      activityChecked,
      protected: u.protected || false,
    };
  });

  const nextCursor = (data?.next_cursor_str && data.next_cursor_str !== '0')
    ? data.next_cursor_str
    : null;

  dbg('info', 'fetchFollowingPage result', { users: users.length, nextCursor });
  return { users, nextCursor };
}

async function fetchAllFollowing(userId, onProgress, gen) {
  const all = [];
  let cursor = null;
  let page = 0;
  dbg('info', 'fetchAllFollowing start', { userId });

  while (true) {
    if (fetchGeneration > gen) throw { type: 'CANCELLED' };

    let result;
    try {
      result = await fetchFollowingPage(userId, cursor);
    } catch (err) {
      if (err.type === 'RATE_LIMIT') {
        onProgress({ phase: 'rate_limit', waitMs: err.waitMs });
        await sleep(err.waitMs);
        continue;
      }
      dbg('error', 'fetchAllFollowing failed', { message: err.message });
      throw err;
    }

    all.push(...result.users);
    page++;
    onProgress({ phase: 'fetch_page', page, total: all.length });

    if (!result.nextCursor || result.users.length === 0) break;
    cursor = result.nextCursor;
    await sleep(FETCH_PAGE_DELAY_MS);
  }

  dbg('info', 'fetchAllFollowing complete', { total: all.length, pages: page });
  return all;
}

// ---------------------------------------------------------------------------
// Last tweet date — v1.1 REST
// GET /1.1/statuses/user_timeline.json
// ---------------------------------------------------------------------------

async function fetchLastTweetDate(userId, includeRts = false) {
  const params = new URLSearchParams({
    user_id: userId,
    count: '1',
    include_rts: includeRts ? '1' : '0',
    exclude_replies: '0',
    tweet_mode: 'extended',
  });

  try {
    const data = await xFetch(
      `https://x.com/i/api/1.1/statuses/user_timeline.json?${params}`
    );
    if (Array.isArray(data) && data.length > 0 && data[0].created_at) {
      return new Date(data[0].created_at).toISOString();
    }
    return null;
  } catch (err) {
    if (err.type !== 'RATE_LIMIT') {
      dbg('warn', 'fetchLastTweetDate failed', { userId, message: err.message });
    }
    throw err;
  }
}

async function fetchLastTweetDateWithHeaders(userId, includeRts = false) {
  const params = new URLSearchParams({
    user_id: userId,
    count: '1',
    include_rts: includeRts ? '1' : '0',
    exclude_replies: '0',
    tweet_mode: 'extended',
  });

  const url = `https://x.com/i/api/1.1/statuses/user_timeline.json?${params}`;
  const shortUrl = url.split('?')[0];
  dbg('info', `→ GET ${shortUrl}`, { userId });

  let res;
  try {
    res = await fetch(url, {
      headers: { ...buildHeaders() },
      credentials: 'include',
    });
  } catch (netErr) {
    dbg('error', `Network error: ${shortUrl}`, { message: netErr.message });
    throw netErr;
  }

  if (res.status === 429) {
    const resetTs = res.headers.get('x-rate-limit-reset');
    const waitMs = resetTs
      ? Math.max(0, Number(resetTs) * 1000 - Date.now()) + 2000
      : RATE_LIMIT_BACKOFF_MS;
    dbg('warn', `Rate limited: ${shortUrl}`, { waitMs });
    throw { type: 'RATE_LIMIT', waitMs };
  }

  if (res.status === 401) {
    capturedBearerToken = null;
    throw new Error('401 — authentication failed');
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const text = await res.text().catch(() => '');
  if (!text.trim()) return { date: null, response: res };

  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    return { date: null, response: res };
  }

  if (Array.isArray(json) && json.length > 0 && json[0].created_at) {
    return { date: new Date(json[0].created_at).toISOString(), response: res };
  }
  return { date: null, response: res };
}

// ---------------------------------------------------------------------------
// Enrich following list with last tweet dates — parallel with concurrency pool
// ---------------------------------------------------------------------------

const ENRICH_CONCURRENCY = 5;
const RATE_LIMIT_SAFETY_BUFFER = 50;

function createPool(concurrency) {
  const queue = [];
  let running = 0;
  function drain() {
    while (running < concurrency && queue.length) {
      running++;
      const task = queue.shift();
      task().finally(() => { running--; drain(); });
    }
  }
  return (fn) => new Promise((resolve, reject) => {
    queue.push(() => fn().then(resolve, reject));
    drain();
  });
}

async function enrichWithActivity(users, onProgress, gen) {
  dbg('info', 'enrichWithActivity start', { count: users.length, concurrency: ENRICH_CONCURRENCY });

  const completed = new Uint8Array(users.length);
  let completedCount = 0;
  let globalRateLimitRemaining = 900;
  let globalRateLimitReset = 0;

  function reportProgress(user, idx) {
    onProgress({ phase: 'enrich', index: idx, total: users.length, user });
  }

  function handleRateLimitHeaders(res) {
    const remaining = res.headers?.get('x-rate-limit-remaining');
    const reset = res.headers?.get('x-rate-limit-reset');
    if (remaining !== null && remaining !== undefined) {
      globalRateLimitRemaining = parseInt(remaining, 10) || 0;
    }
    if (reset !== null && reset !== undefined) {
      globalRateLimitReset = parseInt(reset, 10) * 1000;
    }
  }

  async function waitForRateLimitReset() {
    const waitMs = globalRateLimitReset
      ? Math.max(0, globalRateLimitReset - Date.now()) + 2000
      : RATE_LIMIT_BACKOFF_MS;
    dbg('info', 'Rate limit safety buffer reached, pausing pool', { waitMs, remaining: globalRateLimitRemaining });
    onProgress({ phase: 'rate_limit', waitMs });
    await sleep(waitMs);
    globalRateLimitRemaining = 900;
  }

  const pool = createPool(ENRICH_CONCURRENCY);

  await Promise.all(users.map((user, i) => pool(async () => {
    if (fetchGeneration > gen) return;

    if (user.activityChecked !== undefined) {
      if (user.lastTweetAt || user.statusesCount === 0 || user.protected) {
        reportProgress(user, i);
        return;
      }
    }

    if (user.protected) {
      user.lastTweetAt = null;
      user.activityChecked = false;
    } else if (user.statusesCount === 0) {
      user.lastTweetAt = null;
      user.activityChecked = true;
    } else {
      let retries = 0;
      let emptyTries = 0;
      while (retries < 3 && emptyTries < 3) {
        if (fetchGeneration > gen) return;

        if (globalRateLimitRemaining < RATE_LIMIT_SAFETY_BUFFER) {
          await waitForRateLimitReset();
        }

        try {
          const { date, response } = await fetchLastTweetDateWithHeaders(user.id);
          if (response) handleRateLimitHeaders(response);
          globalRateLimitRemaining--;

          if (date) {
            user.lastTweetAt = date;
            user.activityChecked = true;
            break;
          }
          emptyTries++;
          if (emptyTries >= 3) {
            try {
              const rtResult = await fetchLastTweetDateWithHeaders(user.id, true);
              if (rtResult.response) handleRateLimitHeaders(rtResult.response);
              user.lastTweetAt = rtResult.date || user.lastRetweetAt || null;
            } catch (_) {
              user.lastTweetAt = user.lastRetweetAt || null;
            }
            user.activityChecked = true;
            break;
          }
          dbg('info', 'fetchLastTweetDate returned empty, retrying after delay', {
            userId: user.id,
            emptyTries,
          });
          await sleep(2000);
        } catch (err) {
          if (err.type === 'RATE_LIMIT') {
            onProgress({ phase: 'rate_limit', waitMs: err.waitMs });
            await sleep(err.waitMs);
            retries++;
          } else {
            user.lastTweetAt = user.lastRetweetAt || null;
            user.activityChecked = true;
            break;
          }
        }
      }
    }

    reportProgress(user, i);
  })));

  dbg('info', 'enrichWithActivity complete', { count: users.length });
  return users;
}

// ---------------------------------------------------------------------------
// Unfollow — v1.1 REST (has been stable for years)
// POST /1.1/friendships/destroy.json
// ---------------------------------------------------------------------------

async function unfollowUser(userId) {
  dbg('info', 'unfollowing', { userId });
  const result = await xFetch('https://x.com/i/api/1.1/friendships/destroy.json', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `user_id=${userId}`,
  });
  if (result?.errors?.length) {
    const errMsg = result.errors.map((e) => e.message || JSON.stringify(e)).join(', ');
    dbg('error', 'unfollowUser: API returned errors', { userId, errors: result.errors });
    throw new Error(`Unfollow API error: ${errMsg}`);
  }
  dbg('info', 'unfollowed', { userId });
}

async function unfollowQueue(userIds, onProgress, gen) {
  let done = 0;
  const failed = [];
  const errors = {};
  dbg('info', 'unfollowQueue start', { count: userIds.length });

  for (const userId of userIds) {
    if (unfollowGeneration > gen) {
      onProgress({ phase: 'unfollow_cancelled', done, total: userIds.length, failed, errors });
      return;
    }

    let retries = 0;
    while (retries < 3) {
      try {
        await unfollowUser(userId);
        done++;
        onProgress({ phase: 'unfollow_progress', done, total: userIds.length, userId });
        await sleep(UNFOLLOW_DELAY_MS);
        break;
      } catch (err) {
        if (err.type === 'RATE_LIMIT') {
          onProgress({ phase: 'rate_limit', waitMs: err.waitMs });
          await sleep(err.waitMs);
          retries++;
          if (retries >= 3) {
            failed.push(userId);
            errors[userId] = 'Rate limited after 3 retries';
            dbg('error', 'unfollowQueue: rate limited all retries', { userId });
            onProgress({ phase: 'unfollow_error', userId, error: errors[userId] });
            await sleep(UNFOLLOW_DELAY_MS);
          }
        } else {
          const errMsg = err.message || String(err);
          failed.push(userId);
          errors[userId] = errMsg;
          dbg('error', 'unfollowQueue: unfollow failed', { userId, error: errMsg });
          onProgress({ phase: 'unfollow_error', userId, error: errMsg });
          await sleep(UNFOLLOW_DELAY_MS);
          break;
        }
      }
    }
  }

  dbg('info', 'unfollowQueue done', { done, failed: failed.length, errors });
  onProgress({ phase: 'unfollow_done', done, total: userIds.length, failed, errors });
}

// ---------------------------------------------------------------------------
// Message listener — window.postMessage bridge
// ---------------------------------------------------------------------------

window.addEventListener('message', async (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.direction !== 'FROM_EXTENSION') return;

  const reply = (data) =>
    window.postMessage({ direction: 'FROM_PAGE', id: msg.id, ...data }, location.origin);

  dbg('info', `← msg: ${msg.type}`);

  switch (msg.type) {

    case 'PING': {
      const loggedIn = isLoggedIn();
      const userId = getLoggedInUserId();
      dbg('info', 'PING', {
        loggedIn,
        userId,
        csrfPresent: !!getCsrfToken(),
        capturedToken: !!capturedBearerToken,
      });
      reply({ type: 'PONG', loggedIn, userId, tokenReady: !!capturedBearerToken, usingFallback: usingFallbackToken });
      break;
    }

    case 'FETCH_FOLLOWING': {
      const userId = getLoggedInUserId();
      if (!userId) {
        dbg('error', 'FETCH_FOLLOWING: not logged in');
        reply({ type: 'ERROR', error: 'Not logged in to x.com' });
        return;
      }

      await acquireBearerToken();

      const gen = ++fetchGeneration;
      try {
        const users = await fetchAllFollowing(userId, (p) =>
          reply({ type: 'FETCH_PROGRESS', progress: p })
        , gen);
        reply({ type: 'FETCH_FOLLOWING_DONE', users });
      } catch (err) {
        if (err.type === 'CANCELLED') {
          reply({ type: 'FETCH_CANCELLED' });
        } else {
          reply({ type: 'ERROR', error: err.message || String(err) });
        }
      }
      break;
    }

    case 'ENRICH_ACTIVITY': {
      const gen = ++fetchGeneration;
      try {
        const enriched = await enrichWithActivity(msg.users, (p) =>
          reply({ type: 'ENRICH_PROGRESS', progress: p })
        , gen);
        reply({ type: 'ENRICH_DONE', users: enriched });
      } catch (err) {
        if (err.type === 'CANCELLED') {
          reply({ type: 'FETCH_CANCELLED' });
        } else {
          reply({ type: 'ERROR', error: err.message || String(err) });
        }
      }
      break;
    }

    case 'UNFOLLOW': {
      const gen = ++unfollowGeneration;
      try {
        await acquireBearerToken();
        await unfollowQueue(msg.userIds, (p) =>
          reply({ type: 'UNFOLLOW_PROGRESS', progress: p })
        , gen);
      } catch (err) {
        reply({ type: 'ERROR', error: err.message || String(err) });
      }
      break;
    }

    case 'CANCEL_FETCH':
      fetchGeneration++;
      dbg('info', 'CANCEL_FETCH: fetchGeneration incremented', { fetchGeneration });
      reply({ type: 'OK' });
      break;

    case 'CANCEL_UNFOLLOW':
      unfollowGeneration++;
      dbg('info', 'CANCEL_UNFOLLOW: unfollowGeneration incremented', { unfollowGeneration });
      reply({ type: 'OK' });
      break;

    default:
      dbg('warn', `Unknown message: ${msg.type}`);
  }
});

dbg('info', 'content.js loaded', { href: location.href });
