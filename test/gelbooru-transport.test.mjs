/**
 * Exercises the Gelbooru transport in both modes: the upstream server-plugin
 * path and TauriTavern's permissioned native path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Requests captured from the last run, so assertions can inspect them. */
let captured = [];

function installBrowserGlobals({ tauri }) {
    captured = [];
    globalThis.window = tauri ? { __TAURITAVERN__: { abiVersion: 1 } } : {};
    globalThis.document = { getElementsByTagName: () => [] };

    globalThis.fetch = async (url, init = {}) => {
        captured.push({ url: String(url), init });

        if (String(url).includes('s=post')) {
            return new Response(JSON.stringify({ post: [{ id: 1 }] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        if (String(url).includes('s=tag')) {
            return new Response(JSON.stringify({ tag: [{ name: 'sky' }] }), { status: 200 });
        }
        // A CDN media response.
        return new Response(new Uint8Array([1, 2, 3, 4]), {
            status: 200,
            headers: { 'Content-Type': 'image/png' },
        });
    };
}

/** Import fresh so module-level transport selection re-evaluates per mode. */
async function loadTransport(mode) {
    installBrowserGlobals(mode);
    const url = new URL('../src/modules/avatar-gallery/gelbooru/transport.js', import.meta.url);
    return import(`${url.href}?mode=${mode.tauri ? 'tauri' : 'upstream'}&t=${Math.random()}`);
}

test('upstream mode routes through the helper plugin', async () => {
    const { gelbooruFetch, hasNativeTransport } = await loadTransport({ tauri: false });
    assert.equal(hasNativeTransport(), false);

    await gelbooruFetch('/gelbooru/search', {
        method: 'POST',
        body: JSON.stringify({ tags: 'sky' }),
    });

    // fetchWithCsrf takes a /csrf-token round trip first, then the plugin call.
    assert.equal(captured.length, 2);
    assert.match(captured[0].url, /\/csrf-token$/);
    assert.match(captured[1].url, /\/api\/plugins\/uishortcuts-helper\/gelbooru\/search$/);
    assert.ok(
        !captured.some((request) => request.url.startsWith('https://gelbooru.com')),
        'upstream mode must never reach gelbooru from the page',
    );
});

test('native mode skips the CSRF round trip the plugin path needs', async () => {
    const { gelbooruFetch } = await loadTransport({ tauri: true });

    await gelbooruFetch('/gelbooru/search', {
        method: 'POST',
        body: JSON.stringify({ tags: 'sky' }),
    });

    assert.equal(captured.length, 1);
    assert.ok(!captured.some((request) => request.url.includes('/csrf-token')));
});

test('native mode calls gelbooru directly and preserves the plugin response shape', async () => {
    const { gelbooruFetch, hasNativeTransport } = await loadTransport({ tauri: true });
    assert.equal(hasNativeTransport(), true);

    const response = await gelbooruFetch('/gelbooru/search', {
        method: 'POST',
        body: JSON.stringify({ tags: 'sky', page: 2, limit: 40, apiKey: 'k', userId: 'u' }),
    });

    assert.equal(response.ok, true);
    assert.deepEqual(await response.json(), { post: [{ id: 1 }] });

    assert.equal(captured.length, 1);
    const url = new URL(captured[0].url);
    assert.equal(url.origin + url.pathname, 'https://gelbooru.com/index.php');
    assert.equal(url.searchParams.get('s'), 'post');
    assert.equal(url.searchParams.get('tags'), 'sky');
    assert.equal(url.searchParams.get('pid'), '2');
    assert.equal(url.searchParams.get('api_key'), 'k');
    assert.equal(url.searchParams.get('user_id'), 'u');
});

test('native mode clamps the page size the same way the plugin did', async () => {
    const { gelbooruFetch } = await loadTransport({ tauri: true });

    await gelbooruFetch('/gelbooru/search', {
        method: 'POST',
        body: JSON.stringify({ tags: 'sky', limit: 5000 }),
    });

    assert.equal(new URL(captured[0].url).searchParams.get('limit'), '100');
});

test('native mode rejects a missing search term without hitting the network', async () => {
    const { gelbooruFetch } = await loadTransport({ tauri: true });

    const response = await gelbooruFetch('/gelbooru/search', {
        method: 'POST',
        body: JSON.stringify({}),
    });

    assert.equal(response.status, 400);
    assert.equal(captured.length, 0);
});

test('native mode refuses media URLs outside the Gelbooru allowlist', async () => {
    const { gelbooruFetch } = await loadTransport({ tauri: true });

    for (const url of [
        'https://evil.com/x.png',
        'https://notgelbooru.com/x.png',
        'http://gelbooru.com/x.png', // downgraded scheme
    ]) {
        const response = await gelbooruFetch('/gelbooru/download', {
            method: 'POST',
            body: JSON.stringify({ url }),
        });
        assert.equal(response.status, 403, `expected ${url} to be refused`);
    }

    assert.equal(captured.length, 0, 'no request should reach the network');
});

test('native mode sends the hotlink Referer for media', async () => {
    const { gelbooruFetch } = await loadTransport({ tauri: true });

    const response = await gelbooruFetch('/gelbooru/download', {
        method: 'POST',
        body: JSON.stringify({ url: 'https://img3.gelbooru.com/images/a/b/c.png' }),
    });

    assert.equal(response.ok, true);
    const payload = await response.json();
    assert.equal(payload.contentType, 'image/png');
    assert.equal(payload.size, 4);
    assert.equal(Buffer.from(payload.base64, 'base64').length, 4);
    assert.equal(captured[0].init.headers.Referer, 'https://gelbooru.com/');
});

test('native mode surfaces a Cloudflare challenge as an error, not an image', async () => {
    const { gelbooruFetch } = await loadTransport({ tauri: true });
    globalThis.fetch = async () =>
        new Response('<html>challenge</html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
        });

    const response = await gelbooruFetch('/gelbooru/download', {
        method: 'POST',
        body: JSON.stringify({ url: 'https://img3.gelbooru.com/images/a/b/c.png' }),
    });

    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /challenge page/);
});

test('native mode maps a 401 to the credentials hint the UI keys off', async () => {
    const { gelbooruFetch } = await loadTransport({ tauri: true });
    globalThis.fetch = async () => new Response('', { status: 401, statusText: 'Unauthorized' });

    const response = await gelbooruFetch('/gelbooru/search', {
        method: 'POST',
        body: JSON.stringify({ tags: 'sky' }),
    });

    assert.equal(response.status, 401);
    const payload = await response.json();
    assert.equal(payload.code, 401);
    assert.match(payload.error, /API key/);
});

test('native mode tolerates the non-JSON body gelbooru returns for no results', async () => {
    const { gelbooruFetch } = await loadTransport({ tauri: true });
    globalThis.fetch = async () => new Response('', { status: 200 });

    const response = await gelbooruFetch('/gelbooru/search', {
        method: 'POST',
        body: JSON.stringify({ tags: 'nothingmatchesthis' }),
    });

    assert.equal(response.ok, true);
    assert.deepEqual(await response.json(), {});
});
