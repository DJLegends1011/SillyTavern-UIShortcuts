/**
 * SillyTavern UI Shortcuts - Gelbooru transport
 *
 * Gelbooru's API sends no CORS headers and its CDN enforces Referer-based
 * hotlink protection, so a browser page cannot talk to it directly. On upstream
 * SillyTavern that is solved by the `uishortcuts-helper` Node server plugin,
 * which proxies the request from the server side.
 *
 * TauriTavern has no Node runtime, so there is no plugin to install. Instead the
 * extension declares `tt_permissions.network` in its manifest, and the host
 * routes those requests through its native HTTP client — no CORS, no hotlink
 * problem, no plugin. See the extension README.
 *
 * Both paths are kept: this module picks one at runtime and returns a normal
 * `Response` either way, so callers do not care which is in use.
 */

import { fetchWithCsrf } from '../../../utils.js';

const PLUGIN_BASE = '/api/plugins/uishortcuts-helper';
const GELBOORU_API = 'https://gelbooru.com/index.php';

/** Gelbooru hosts the extension is permitted to reach. Mirrors the helper plugin. */
const ALLOWED_MEDIA_HOSTS = [
    'gelbooru.com',
    'img2.gelbooru.com',
    'img3.gelbooru.com',
    'img4.gelbooru.com',
    'video-cdn1.gelbooru.com',
    'video-cdn2.gelbooru.com',
    'video-cdn3.gelbooru.com',
];

/** Whether the host provides permissioned native networking. */
export function hasNativeTransport() {
    return typeof window !== 'undefined' && !!window.__TAURITAVERN__;
}

function isAllowedMediaUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol !== 'https:') return false;
        return ALLOWED_MEDIA_HOSTS.some(
            (host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`),
        );
    } catch {
        return false;
    }
}

function jsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

/** Build the Gelbooru `index.php` query the helper plugin would have built. */
function buildApiUrl(kind, body) {
    const params = new URLSearchParams({ page: 'dapi', q: 'index', json: '1' });

    if (kind === 'search') {
        params.set('s', 'post');
        params.set('tags', String(body.tags || '').trim());
        params.set('pid', String(Math.max(0, Number(body.page) || 0)));
        params.set('limit', String(Math.min(100, Math.max(1, Number(body.limit) || 40))));
    } else {
        params.set('s', 'tag');
        params.set('name_pattern', `%${String(body.term || '').trim()}%`);
        params.set('orderby', 'count');
        params.set('limit', String(Math.min(20, Math.max(1, Number(body.limit) || 10))));
    }

    if (body.apiKey && body.userId) {
        params.set('api_key', String(body.apiKey).slice(0, 128));
        params.set('user_id', String(body.userId).slice(0, 64));
    }

    return `${GELBOORU_API}?${params}`;
}

async function nativeApiRequest(kind, init) {
    let body = {};
    try {
        body = JSON.parse(String(init?.body || '{}'));
    } catch {
        return jsonResponse({ error: 'Invalid request body' }, 400);
    }

    const required = kind === 'search' ? body.tags : body.term;
    if (!required || typeof required !== 'string') {
        const field = kind === 'search' ? 'tags' : 'term';
        return jsonResponse({ error: `Missing or invalid "${field}" parameter` }, 400);
    }

    const response = await fetch(buildApiUrl(kind, body), { signal: init?.signal });

    if (!response.ok) {
        const hint = response.status === 401
            ? '. Gelbooru currently requires API credentials. Get a free API key at https://gelbooru.com/index.php?page=account&s=options'
            : '';
        return jsonResponse({
            error: `Gelbooru returned ${response.status}: ${response.statusText}${hint}`,
            code: response.status,
        }, response.status);
    }

    // Gelbooru answers an empty result set with a body that is not valid JSON.
    const text = await response.text();
    try {
        return jsonResponse(text ? JSON.parse(text) : {});
    } catch {
        return jsonResponse({});
    }
}

async function nativeMediaResponse(rawUrl, init) {
    if (!rawUrl || typeof rawUrl !== 'string') {
        return jsonResponse({ error: 'Missing or invalid "url" parameter' }, 400);
    }
    if (!isAllowedMediaUrl(rawUrl)) {
        return jsonResponse({ error: 'URL not from an allowed Gelbooru domain' }, 403);
    }

    // The Referer is the whole point: without it Gelbooru 302s to hotlink.php.
    const response = await fetch(rawUrl, {
        headers: { Referer: 'https://gelbooru.com/' },
        signal: init?.signal,
    });

    if (!response.ok) {
        return jsonResponse({ error: `Image download failed: ${response.status}` }, response.status);
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    if (contentType.startsWith('text/')) {
        // Cloudflare answers a challenge with 200 + HTML rather than an error.
        return jsonResponse(
            { error: 'Gelbooru CDN returned a challenge page instead of the image' },
            502,
        );
    }

    return { response, contentType };
}

async function nativeDownload(init) {
    let body = {};
    try {
        body = JSON.parse(String(init?.body || '{}'));
    } catch {
        return jsonResponse({ error: 'Invalid request body' }, 400);
    }

    const result = await nativeMediaResponse(body.url, init);
    if (result instanceof Response) {
        return result;
    }

    const buffer = await result.response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const CHUNK = 0x8000;
    for (let index = 0; index < bytes.length; index += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
    }

    return jsonResponse({
        base64: btoa(binary),
        contentType: result.contentType,
        size: bytes.length,
    });
}

async function nativeStream(rawUrl, init) {
    const result = await nativeMediaResponse(rawUrl, init);
    if (result instanceof Response) {
        return result;
    }

    const buffer = await result.response.arrayBuffer();
    return new Response(buffer, {
        status: 200,
        headers: {
            'Content-Type': result.contentType,
            'Cache-Control': 'private, max-age=86400, immutable',
        },
    });
}

/**
 * Drop-in replacement for `fetchWithCsrf(PLUGIN_BASE + path, init)`.
 *
 * @param {string} path e.g. '/gelbooru/search' or '/gelbooru/stream?url=...'
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export async function gelbooruFetch(path, init = {}) {
    if (!hasNativeTransport()) {
        return fetchWithCsrf(`${PLUGIN_BASE}${path}`, init);
    }

    const [route, query = ''] = String(path).split('?');

    try {
        switch (route) {
            case '/gelbooru/search':
                return await nativeApiRequest('search', init);
            case '/gelbooru/tags':
                return await nativeApiRequest('tags', init);
            case '/gelbooru/download':
                return await nativeDownload(init);
            case '/gelbooru/stream':
                return await nativeStream(new URLSearchParams(query).get('url'), init);
            default:
                return jsonResponse({ error: `Unsupported Gelbooru route: ${route}` }, 404);
        }
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw error;
        }
        return jsonResponse({ error: error?.message || 'Gelbooru request failed' }, 502);
    }
}

/**
 * Point an <img>/<video> at a Gelbooru CDN URL.
 *
 * Upstream this is just the plugin's streaming URL. Natively the bytes have to
 * be fetched with a Referer first, so the element gets an object URL that is
 * revoked once the media has been decoded.
 *
 * @param {HTMLImageElement|HTMLVideoElement} element
 * @param {string} url
 * @param {{ signal?: AbortSignal }} [options]
 */
export function applyMediaSrc(element, url, options = {}) {
    if (!element) return;

    if (!url) {
        element.src = '';
        return;
    }

    if (!hasNativeTransport()) {
        element.src = `${PLUGIN_BASE}/gelbooru/stream?url=${encodeURIComponent(url)}`;
        return;
    }

    void (async () => {
        try {
            const response = await gelbooruFetch(
                `/gelbooru/stream?url=${encodeURIComponent(url)}`,
                { signal: options.signal },
            );
            if (!response.ok || options.signal?.aborted) {
                return;
            }

            const objectUrl = URL.createObjectURL(await response.blob());
            if (options.signal?.aborted) {
                URL.revokeObjectURL(objectUrl);
                return;
            }

            const revoke = () => URL.revokeObjectURL(objectUrl);
            element.addEventListener('load', revoke, { once: true });
            element.addEventListener('error', revoke, { once: true });
            element.addEventListener('emptied', revoke, { once: true });
            element.src = objectUrl;
        } catch (error) {
            if (error?.name !== 'AbortError') {
                console.warn('[UIShortcuts] Failed to load Gelbooru media:', error);
            }
        }
    })();
}
