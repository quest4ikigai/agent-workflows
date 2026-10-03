// Tiny GitHub REST/GraphQL client built on fetch (Node 18+). No dependencies.
//
// Tests inject `fetchImpl`; production uses global fetch. Transient failures
// (network errors, 5xx, secondary rate limits) are retried with backoff.

export class GitHubError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.body = body;
  }
}

export function createClient({ token, apiUrl = 'https://api.github.com', fetchImpl = globalThis.fetch, retries = 3, sleep = defaultSleep } = {}) {
  if (!token) throw new Error('a GitHub token is required');
  const base = apiUrl.replace(/\/$/, '');

  async function raw(method, path, body) {
    const url = /^https?:/.test(path) ? path : `${base}/${path.replace(/^\//, '')}`;
    let attempt = 0;
    for (;;) {
      attempt++;
      let res;
      try {
        res = await fetchImpl(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'agent-workflows',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        if (attempt <= retries) {
          await sleep(1000 * 2 ** (attempt - 1));
          continue;
        }
        throw new GitHubError(`${method} ${path} failed: ${err.message}`, 0);
      }
      const retryable = res.status >= 500 || (res.status === 403 && res.headers.get('retry-after')) || res.status === 429;
      if (retryable && attempt <= retries) {
        const after = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : 1000 * 2 ** (attempt - 1));
        continue;
      }
      const text = await res.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      if (!res.ok) {
        const msg = data && typeof data === 'object' && data.message ? data.message : text.slice(0, 200);
        throw new GitHubError(`${method} ${path} → ${res.status}: ${msg}`, res.status, data);
      }
      return { data, headers: res.headers };
    }
  }

  return {
    async request(method, path, body) {
      return (await raw(method, path, body)).data;
    },
    get(path) {
      return this.request('GET', path);
    },
    post(path, body) {
      return this.request('POST', path, body ?? {});
    },
    patch(path, body) {
      return this.request('PATCH', path, body);
    },
    delete(path) {
      return this.request('DELETE', path);
    },
    /** Follow Link: rel="next" pages; `key` selects an array inside object responses. */
    async paginate(path, key) {
      const out = [];
      let next = path.includes('per_page=') ? path : `${path}${path.includes('?') ? '&' : '?'}per_page=100`;
      let pages = 0;
      while (next) {
        const { data, headers } = await raw('GET', next);
        const items = key ? data[key] : data;
        if (!Array.isArray(items)) throw new GitHubError(`GET ${path} did not return a list`, 200, data);
        out.push(...items);
        next = parseNextLink(headers.get('link'));
        if (++pages > 50) throw new GitHubError(`GET ${path}: too many pages`, 200);
      }
      return out;
    },
    async graphql(query, variables) {
      const data = await this.request('POST', `${base}/graphql`, { query, variables });
      if (data && data.errors && data.errors.length) {
        throw new GitHubError(`GraphQL: ${data.errors.map((e) => e.message).join('; ')}`, 200, data);
      }
      return data.data;
    },
  };
}

export function parseNextLink(header) {
  if (!header) return null;
  for (const part of header.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
