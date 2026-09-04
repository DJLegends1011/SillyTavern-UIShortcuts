/**
 * SillyTavern UI Shortcuts - Server Plugin
 * Provides server-side API routes for features that require proxying external services.
 * Currently: Gelbooru image search proxy (bypasses CORS restrictions).
 *
 * This folder (uishortcuts-helper) should be symlinked into ST's plugins/ directory.
 */

export const info = {
    id: 'uishortcuts-helper',
    name: 'UIShortcuts Helper',
    description: 'Server-side proxy routes for the UI Shortcuts extension (Gelbooru search, image download).',
};

const GELBOORU_API = 'https://gelbooru.com/index.php';

/**
 * @param {import('express').Router} router - Express router provided by SillyTavern
 */
export async function init(router) {
    // ── Health check (used by client to detect plugin availability) ──
    router.get('/health', (_req, res) => res.json({ ok: true }));

    // ── Gelbooru search proxy ───────────────────────────────────────
    router.post('/gelbooru/search', async (req, res) => {
        try {
            const { tags = '', page = 0, limit = 40, apiKey, userId } = req.body;

            if (!tags || typeof tags !== 'string') {
                return res.status(400).json({ error: 'Missing or invalid "tags" parameter' });
            }

            const params = new URLSearchParams({
                page: 'dapi',
                s: 'post',
                q: 'index',
                json: '1',
                tags: tags.trim(),
                pid: String(Math.max(0, Number(page) || 0)),
                limit: String(Math.min(100, Math.max(1, Number(limit) || 40))),
            });

            // Optional Gelbooru API credentials for higher rate limits
            if (apiKey && userId) {
                const key = String(apiKey).slice(0, 128);
                const uid = String(userId).slice(0, 64);
                params.set('api_key', key);
                params.set('user_id', uid);
            }

            const url = `${GELBOORU_API}?${params}`;
            const response = await fetch(url);

            if (!response.ok) {
                const hint = response.status === 401
                    ? '. Gelbooru currently requires API credentials. Get a free API key at https://gelbooru.com/index.php?page=account&s=options'
                    : '';
                return res.status(response.status).json({
                    error: `Gelbooru returned ${response.status}: ${response.statusText}${hint}`,
                    code: response.status,
                });
            }

            const data = await response.json();
            return res.json(data);
        } catch (err) {
            console.error('[UIShortcuts] Gelbooru search error:', err.message);
            return res.status(500).json({ error: 'Gelbooru proxy request failed' });
        }
    });

    // ── Gelbooru image download proxy (for saving to gallery) ───────
    router.post('/gelbooru/download', async (req, res) => {
        try {
            const { url } = req.body;

            if (!url || typeof url !== 'string') {
                return res.status(400).json({ error: 'Missing or invalid "url" parameter' });
            }

            // Only allow Gelbooru domains (img* for images, video-cdn* for videos)
            const parsed = new URL(url);
            const allowed = ['gelbooru.com', 'img2.gelbooru.com', 'img3.gelbooru.com', 'img4.gelbooru.com',
                'video-cdn1.gelbooru.com', 'video-cdn2.gelbooru.com', 'video-cdn3.gelbooru.com'];
            if (!allowed.some(d => parsed.hostname === d || parsed.hostname.endsWith('.' + d))) {
                return res.status(403).json({ error: 'URL not from an allowed Gelbooru domain' });
            }

            const response = await fetch(url, {
                headers: {
                    'Referer': 'https://gelbooru.com/',
                },
            });

            if (!response.ok) {
                return res.status(response.status).json({
                    error: `Image download failed: ${response.status}`,
                });
            }

            const contentType = response.headers.get('content-type') || 'image/jpeg';

            // Cloudflare may return 200 with HTML challenge instead of the image
            if (contentType.startsWith('text/')) {
                console.error('[UIShortcuts] Gelbooru CDN returned text instead of image, likely blocked by Cloudflare');
                return res.status(502).json({
                    error: 'Gelbooru CDN returned a challenge page instead of the image',
                });
            }

            const arrayBuf = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuf);

            // Return as base64 so the client can feed it directly into ST's upload API
            const base64 = buffer.toString('base64');
            return res.json({
                base64,
                contentType,
                size: buffer.length,
            });
        } catch (err) {
            console.error('[UIShortcuts] Gelbooru download error:', err.message);
            return res.status(500).json({ error: 'Image download failed' });
        }
    });

    // ── Gelbooru media streaming proxy (for video/large media) ─────
    router.get('/gelbooru/stream', async (req, res) => {
        try {
            const { url } = req.query;

            if (!url || typeof url !== 'string') {
                return res.status(400).json({ error: 'Missing or invalid "url" parameter' });
            }

            // Only allow Gelbooru domains
            const parsed = new URL(url);
            const allowed = ['gelbooru.com', 'img2.gelbooru.com', 'img3.gelbooru.com', 'img4.gelbooru.com',
                'video-cdn1.gelbooru.com', 'video-cdn2.gelbooru.com', 'video-cdn3.gelbooru.com'];
            if (!allowed.some(d => parsed.hostname === d || parsed.hostname.endsWith('.' + d))) {
                return res.status(403).json({ error: 'URL not from an allowed Gelbooru domain' });
            }

            const response = await fetch(url, {
                headers: { 'Referer': 'https://gelbooru.com/' },
            });

            if (!response.ok) {
                return res.status(response.status).json({ error: `Upstream returned ${response.status}` });
            }

            // Forward content headers
            const ct = response.headers.get('content-type');
            if (ct) res.setHeader('Content-Type', ct);
            const cl = response.headers.get('content-length');
            if (cl) res.setHeader('Content-Length', cl);
            // Gelbooru CDN URLs are md5-addressed and immutable, so let the
            // browser cache them and avoid re-proxying grid thumbnails on
            // every page flip.
            res.setHeader('Cache-Control', 'private, max-age=86400, immutable');

            // Buffer and send (reliable across Node versions)
            const arrayBuf = await response.arrayBuffer();
            res.end(Buffer.from(arrayBuf));
        } catch (err) {
            console.error('[UIShortcuts] Gelbooru stream error:', err.message);
            if (!res.headersSent) {
                return res.status(500).json({ error: 'Stream failed' });
            }
        }
    });

    // ── Gelbooru tags autocomplete proxy ────────────────────────────
    router.post('/gelbooru/tags', async (req, res) => {
        try {
            const { term = '', limit = 10, apiKey, userId } = req.body;

            if (!term || typeof term !== 'string') {
                return res.status(400).json({ error: 'Missing or invalid "term" parameter' });
            }

            const params = new URLSearchParams({
                page: 'dapi',
                s: 'tag',
                q: 'index',
                json: '1',
                name_pattern: `%${term.trim()}%`,
                orderby: 'count',
                limit: String(Math.min(20, Math.max(1, Number(limit) || 10))),
            });

            // Pass API credentials if available
            if (apiKey && userId) {
                params.set('api_key', String(apiKey).slice(0, 128));
                params.set('user_id', String(userId).slice(0, 64));
            }

            const url = `${GELBOORU_API}?${params}`;
            const response = await fetch(url);

            if (!response.ok) {
                return res.status(response.status).json({
                    error: `Gelbooru tags returned ${response.status}`,
                });
            }

            const data = await response.json();
            return res.json(data);
        } catch (err) {
            console.error('[UIShortcuts] Gelbooru tags error:', err.message);
            return res.status(500).json({ error: 'Tag lookup failed' });
        }
    });

    console.log('[UIShortcuts] Server plugin loaded. Gelbooru proxy routes registered');
}

export async function exit() {
    console.log('[UIShortcuts] Server plugin unloaded');
}
