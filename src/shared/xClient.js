/**
 * XClient - Decoupled client abstraction for X.com API operations.
 */

class XClient {
  /**
   * @param {object} providers
   * @param {object} providers.cookieProvider
   * @param {object} providers.tokenProvider
   * @param {object} [providers.httpClient]
   */
  constructor({ cookieProvider, tokenProvider, httpClient }) {
    this.cookieProvider = cookieProvider;
    this.tokenProvider = tokenProvider;
    this.httpClient = httpClient || {
      async fetch(url, options) {
        return fetch(url, options);
      }
    };
    this.rateLimitResetTime = null;
  }

  isLoggedIn() {
    const userId = this.cookieProvider.getCookie('twid');
    const csrf = this.cookieProvider.getCookie('ct0');
    return !!(userId && csrf);
  }

  getLoggedInUserId() {
    const val = this.cookieProvider.getCookie('twid');
    if (!val) return null;
    const match = val.match(/u=(\d+)/);
    return match ? match[1] : val;
  }

  getCsrfToken() {
    return this.cookieProvider.getCookie('ct0') || '';
  }

  async getBearerToken() {
    return this.tokenProvider.acquireToken();
  }

  async getFollowingList(userId, onProgress, fetchGeneration) {
    const users = [];
    let cursor = '-1';
    let page = 1;

    while (cursor && cursor !== '0') {
      if (fetchGeneration && fetchGeneration() !== this.currentFetchGeneration) {
        throw new Error('Fetch cancelled.');
      }

      onProgress({ phase: 'fetch_page', page, total: users.length });

      const url = `https://x.com/i/api/1.1/friends/list.json?user_id=${userId}&cursor=${cursor}&count=200&skip_status=1&include_user_entities=false`;
      let res;
      try {
        res = await this.executeRequest(url);
      } catch (err) {
        if (err.message.includes('Rate limit')) {
          onProgress({ phase: 'rate_limit', waitMs: 65000 });
          await new Promise(r => setTimeout(r, 65000));
          continue;
        }
        throw err;
      }

      if (res.users && Array.isArray(res.users)) {
        users.push(...res.users.map(u => ({
          id: u.id_str,
          screenName: u.screen_name,
          name: u.name,
          profileImageUrl: u.profile_image_url_https,
          followersCount: u.followers_count,
          friendsCount: u.friends_count,
          statusesCount: u.statuses_count,
          protected: u.protected,
          lastTweetAt: null
        })));
      }
      cursor = res.next_cursor_str;
      page++;
      await new Promise(r => setTimeout(r, 600));
    }

    return users;
  }

  async unfollowUser(userId) {
    const url = `https://x.com/i/api/1.1/friendships/destroy.json?user_id=${userId}`;
    return this.executeRequest(url, 'POST');
  }

  async buildHeaders() {
    const csrf = this.getCsrfToken();
    const token = await this.getBearerToken();
    return {
      'Authorization': `Bearer ${token}`,
      'x-csrf-token': csrf,
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'en',
      'content-type': 'application/json'
    };
  }

  async executeRequest(url, method = 'GET', body = null) {
    if (this.rateLimitResetTime && Date.now() < this.rateLimitResetTime) {
      throw new Error(`Rate limited. Try again after ${new Date(this.rateLimitResetTime).toLocaleTimeString()}`);
    }

    const headers = await this.buildHeaders();
    const options = {
      method,
      headers
    };
    if (body) {
      options.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const res = await this.httpClient.fetch(url, options);
    
    if (res.status === 429) {
      const resetHeader = res.headers ? res.headers.get('x-rate-limit-reset') : null;
      if (resetHeader) {
        const secs = parseInt(resetHeader, 10);
        this.rateLimitResetTime = secs * 1000;
      } else {
        this.rateLimitResetTime = Date.now() + 60 * 1000;
      }
      throw new Error('Rate limit hit.');
    }

    if (!res.ok) {
      throw new Error(`HTTP Error: ${res.status}`);
    }

    return res.json();
  }
}

export default XClient;
