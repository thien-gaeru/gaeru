'use strict';

/**
 * Trình hỗ trợ gửi HTTP request có session / cookie / CSRF trong các test tích hợp
 */
function createApiClient(baseUrl, { cookie = '', csrfToken = '' } = {}) {
  let sessionCookie = cookie;
  let activeCsrfToken = csrfToken;

  async function request(path, options = {}) {
    const url = path.startsWith('http') ? path : `${baseUrl}${path}`;
    const headers = new Headers(options.headers || {});

    if (sessionCookie && !headers.has('Cookie')) {
      headers.set('Cookie', sessionCookie);
    }
    if (activeCsrfToken && !headers.has('x-csrf-token')) {
      headers.set('x-csrf-token', activeCsrfToken);
    }

    const response = await fetch(url, {
      ...options,
      headers
    });

    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      sessionCookie = setCookie.split(';')[0];
    }

    return response;
  }

  return {
    request,
    get: (path, opts) => request(path, { ...opts, method: 'GET' }),
    post: (path, body, opts = {}) => request(path, {
      ...opts,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      body: JSON.stringify(body)
    }),
    put: (path, body, opts = {}) => request(path, {
      ...opts,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      body: JSON.stringify(body)
    }),
    delete: (path, opts) => request(path, { ...opts, method: 'DELETE' }),
    setCsrfToken: (token) => { activeCsrfToken = token; },
    setCookie: (c) => { sessionCookie = c; },
    getCookie: () => sessionCookie
  };
}

module.exports = {
  createApiClient
};
