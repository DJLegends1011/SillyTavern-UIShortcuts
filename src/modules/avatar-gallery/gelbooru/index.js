/**
 * SillyTavern UI Shortcuts - Gelbooru Search Module
 * Provides Gelbooru image search inside the Avatar Gallery panel.
 */

import { EXTENSION_DIR, fetchWithCsrf, log } from '../../../utils.js';

const PLUGIN_BASE = '/api/plugins/uishortcuts-helper';

// Rating tag map for Gelbooru API
const RATING_TAGS = {
    general: 'rating:general',
    sensitive: 'rating:sensitive',
    questionable: 'rating:questionable',
    explicit: 'rating:explicit',
};

export class GelbooruSearch {
    /**
     * @param {object} gallery - The parent AvatarGallerySelector instance
     */
    constructor(gallery) {
        this.gallery = gallery;
        this.results = [];
        this.currentPage = 0;
        this.totalCount = 0;
        this.isLoading = false;
        this.currentQuery = '';
        this.previewPost = null;

        // Debounce timer for tag autocomplete
        this._acTimer = null;
        this._acController = null;

        // Preview touch state
        this._touch = {
            startX: 0, startY: 0,
            lastX: 0, lastY: 0,
            isPanning: false, panMoved: false,
            isTracking: false,
            lastTapTime: 0, lastTapX: 0, lastTapY: 0,
            tapMoved: false,
        };
        this._previewZoom = 1;
        this._previewZoomMin = 0.5;
        this._previewZoomMax = 5;
        this._previewPan = { x: 0, y: 0 };
        this._previewPanStart = { x: 0, y: 0 };
        this._previewWasPanning = false;
        this._previewMousePanning = false;
        this._previewController = null;

        // Pinch zoom state
        this._pinch = { active: false, startDist: 0, startZoom: 1 };

        this.container = null;
        this.boundHandlers = {};
    }

    // ========================================
    // SETTINGS HELPERS
    // ========================================

    get settings() {
        return window.UIShortcuts?.settings?.avatarGallery ?? {};
    }

    /**
     * Parse Gelbooru credentials from settings.
     * Handles users pasting the full query string like:
     *   &api_key=XXXXX&user_id=12345
     * or just the raw values.
     */
    get apiKey() {
        let raw = (this.settings.apiKey || '').trim();
        // If the user pasted the whole "&api_key=KEY&user_id=ID" string, extract both
        const keyMatch = raw.match(/(?:^|[&?])api_key=([^&]+)/i);
        if (keyMatch) return keyMatch[1].trim();
        // Otherwise strip any leftover prefix
        return raw.replace(/^&?api_key=/i, '').replace(/&.*$/, '').trim();
    }

    get userId() {
        // Extract from apiKey field (user pastes the combined string)
        const rawKey = (this.settings.apiKey || '').trim();
        const idFromKey = rawKey.match(/(?:^|[&?])user_id=([^&]+)/i);
        if (idFromKey) return idFromKey[1].trim();

        // Legacy: separate userId field
        const raw = (this.settings.userId || '').trim();
        const idMatch = raw.match(/(?:^|[&?])user_id=([^&]+)/i);
        if (idMatch) return idMatch[1].trim();
        return /^\d+$/.test(raw) ? raw : '';
    }

    get resultsPerPage() {
        return this.settings.resultsPerPage || 40;
    }

    // ========================================
    // DOM CREATION
    // ========================================

    _isVideoPost(post) {
        const url = post.file_url || post.sample_url || '';
        return /\.(mp4|webm)$/i.test(url);
    }

    /**
     * Wrap a Gelbooru CDN URL in the server stream proxy.
     * Gelbooru enforces Referer-based hotlink protection: loading a CDN URL
     * directly via <img src> from ST's origin gets 302'd to hotlink.php. The
     * proxy re-fetches with Referer: gelbooru.com and streams the bytes back
     * from our own origin. Returns '' for a falsy url.
     */
    _proxyImageUrl(url) {
        if (!url) return '';
        return `${PLUGIN_BASE}/gelbooru/stream?url=${encodeURIComponent(url)}`;
    }

    /**
     * Build the Gelbooru tab content DOM and append it into the gallery panel.
     * Called once from the gallery's createPanel().
     */
    buildTabContent() {
        const el = document.createElement('div');
        el.className = 'uishortcuts-gelbooru-tab';
        el.innerHTML = `
            <div class="uishortcuts-gelbooru-search-bar">
                <div class="uishortcuts-gelbooru-input-wrap">
                    <i class="fa-solid fa-magnifying-glass"></i>
                    <input type="text"
                           class="uishortcuts-gelbooru-input"
                           placeholder="Search tags (space-separated)…"
                           spellcheck="false"
                           autocomplete="off" />
                    <button class="uishortcuts-gelbooru-clear" title="Clear search">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
                <div class="uishortcuts-gelbooru-filters">
                    <select class="uishortcuts-gelbooru-rating" title="Rating filter">
                        <option value="">Any rating</option>
                        <option value="general">General</option>
                        <option value="sensitive">Sensitive</option>
                        <option value="questionable">Questionable</option>
                        <option value="explicit">Explicit</option>
                    </select>
                    <button class="uishortcuts-gelbooru-search-btn" title="Search (Enter)">
                        <i class="fa-solid fa-search"></i> Search
                    </button>
                </div>
                <div class="uishortcuts-gelbooru-autocomplete"></div>
            </div>
            <div class="uishortcuts-gelbooru-results">
                <div class="uishortcuts-gelbooru-grid"></div>
                <div class="uishortcuts-gelbooru-empty">
                    <i class="fa-solid fa-images"></i>
                    <p>Search for images on Gelbooru</p>
                </div>
                <div class="uishortcuts-gelbooru-loader">
                    <i class="fa-solid fa-spinner fa-spin"></i>
                    <span>Searching…</span>
                </div>
                <div class="uishortcuts-gelbooru-error"></div>
            </div>
            <div class="uishortcuts-gelbooru-pagination">
                <button class="uishortcuts-gelbooru-page-prev" disabled>
                    <i class="fa-solid fa-chevron-left"></i> Prev
                </button>
                <span class="uishortcuts-gelbooru-page-info"></span>
                <button class="uishortcuts-gelbooru-page-next" disabled>
                    Next <i class="fa-solid fa-chevron-right"></i>
                </button>
            </div>
            <div class="uishortcuts-gelbooru-preview-overlay">
                <div class="uishortcuts-gelbooru-preview-panel">
                    <div class="uishortcuts-gelbooru-preview-header">
                        <span class="uishortcuts-gelbooru-preview-dims"></span>
                        <div class="uishortcuts-gelbooru-preview-actions">
                            <button class="uishortcuts-gelbooru-save-btn" title="Save to character gallery">
                                <i class="fa-solid fa-download"></i> Save to Gallery
                            </button>
                            <button class="uishortcuts-gelbooru-open-btn" title="Open on Gelbooru">
                                <i class="fa-solid fa-arrow-up-right-from-square"></i> Open
                            </button>
                            <button class="uishortcuts-gelbooru-preview-close" title="Close preview">
                                <i class="fa-solid fa-xmark"></i>
                            </button>
                        </div>
                    </div>
                    <div class="uishortcuts-gelbooru-preview-image-wrap">
                        <img class="uishortcuts-gelbooru-preview-image" src="" alt="Preview" />
                        <div class="uishortcuts-gelbooru-preview-loader">
                            <i class="fa-solid fa-spinner fa-spin"></i>
                        </div>
                    </div>
                    <div class="uishortcuts-gelbooru-preview-tags"></div>
                </div>
            </div>
        `;

        this.container = el;
        this._bindEvents();
        this._applyDefaultRating();
        return el;
    }

    // ========================================
    // EVENT BINDING
    // ========================================

    _bindEvents() {
        const input = this.container.querySelector('.uishortcuts-gelbooru-input');
        const clearBtn = this.container.querySelector('.uishortcuts-gelbooru-clear');
        const searchBtn = this.container.querySelector('.uishortcuts-gelbooru-search-btn');
        const prevBtn = this.container.querySelector('.uishortcuts-gelbooru-page-prev');
        const nextBtn = this.container.querySelector('.uishortcuts-gelbooru-page-next');
        const previewOverlay = this.container.querySelector('.uishortcuts-gelbooru-preview-overlay');
        const previewClose = this.container.querySelector('.uishortcuts-gelbooru-preview-close');
        const saveBtn = this.container.querySelector('.uishortcuts-gelbooru-save-btn');
        const openBtn = this.container.querySelector('.uishortcuts-gelbooru-open-btn');

        // Search
        this.boundHandlers.onSearchClick = () => this.search();
        this.boundHandlers.onInputKeydown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this._hideAutocomplete();
                this.search();
            } else if (e.key === 'Escape') {
                this._hideAutocomplete();
            }
        };
        this.boundHandlers.onInputInput = () => this._onInputChanged();
        this.boundHandlers.onClear = () => {
            input.value = '';
            input.focus();
            this._hideAutocomplete();
        };

        // Pagination
        this.boundHandlers.onPrev = () => this.search(this.currentPage - 1);
        this.boundHandlers.onNext = () => this.search(this.currentPage + 1);

        // Preview
        this.boundHandlers.onPreviewClose = () => this.closePreview();
        this.boundHandlers.onPreviewOverlayClick = (e) => {
            if (e.target === previewOverlay) this.closePreview();
        };
        // Close preview when clicking the image-wrap background (not the image/video itself)
        const imgWrap = this.container.querySelector('.uishortcuts-gelbooru-preview-image-wrap');
        this.boundHandlers.onImgWrapClick = (e) => {
            if (e.target === imgWrap) this.closePreview();
        };
        this.boundHandlers.onSave = () => this._saveCurrentPreview();
        this.boundHandlers.onOpen = () => this._openOnGelbooru();

        // Dismiss autocomplete on blur (short delay so mousedown on AC items fires first)
        this.boundHandlers.onInputBlur = () => {
            setTimeout(() => this._hideAutocomplete(), 150);
        };

        // Dismiss autocomplete when results grid scrolls
        const grid = this.container.querySelector('.uishortcuts-gelbooru-grid');
        this.boundHandlers.onGridScroll = () => this._hideAutocomplete();

        // Swipe on grid for page navigation
        this._gridSwipe = { startX: 0, startY: 0, tracking: false };
        this.boundHandlers.onGridTouchStart = (e) => {
            if (e.touches.length !== 1) return;
            this._gridSwipe.startX = e.touches[0].clientX;
            this._gridSwipe.startY = e.touches[0].clientY;
            this._gridSwipe.tracking = true;
        };
        this.boundHandlers.onGridTouchEnd = (e) => {
            if (!this._gridSwipe.tracking) return;
            this._gridSwipe.tracking = false;
            const t = e.changedTouches[0];
            const dx = t.clientX - this._gridSwipe.startX;
            const dy = t.clientY - this._gridSwipe.startY;
            if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 2) {
                if (dx < 0 && this.currentPage < Math.ceil(this.totalCount / this.resultsPerPage) - 1) {
                    this.search(this.currentPage + 1);
                } else if (dx > 0 && this.currentPage > 0) {
                    this.search(this.currentPage - 1);
                }
            }
        };

        // Dismiss autocomplete on any touch/click outside the search bar
        this.boundHandlers.onContainerPointerDown = (e) => {
            if (!e.target.closest('.uishortcuts-gelbooru-search-bar')) {
                this._hideAutocomplete();
            }
        };

        searchBtn.addEventListener('click', this.boundHandlers.onSearchClick);
        input.addEventListener('keydown', this.boundHandlers.onInputKeydown);
        input.addEventListener('input', this.boundHandlers.onInputInput);
        input.addEventListener('blur', this.boundHandlers.onInputBlur);
        clearBtn.addEventListener('click', this.boundHandlers.onClear);
        prevBtn.addEventListener('click', this.boundHandlers.onPrev);
        nextBtn.addEventListener('click', this.boundHandlers.onNext);
        previewClose.addEventListener('click', this.boundHandlers.onPreviewClose);
        previewOverlay.addEventListener('click', this.boundHandlers.onPreviewOverlayClick);
        imgWrap.addEventListener('click', this.boundHandlers.onImgWrapClick);
        saveBtn.addEventListener('click', this.boundHandlers.onSave);
        openBtn.addEventListener('click', this.boundHandlers.onOpen);
        grid.addEventListener('scroll', this.boundHandlers.onGridScroll, { passive: true });
        grid.addEventListener('touchstart', this.boundHandlers.onGridTouchStart, { passive: true });
        grid.addEventListener('touchend', this.boundHandlers.onGridTouchEnd);
        this.container.addEventListener('pointerdown', this.boundHandlers.onContainerPointerDown);

        // Desktop: wheel zoom on preview
        this.boundHandlers.onPreviewWheel = (e) => this._handlePreviewWheel(e);
        imgWrap.addEventListener('wheel', this.boundHandlers.onPreviewWheel, { passive: false });

        // Desktop: mouse drag to pan when zoomed
        const previewImg = this.container.querySelector('.uishortcuts-gelbooru-preview-image');
        this.boundHandlers.onPreviewMouseDown = (e) => this._startPreviewMousePan(e);
        this.boundHandlers.onPreviewMouseMove = (e) => this._onPreviewMousePan(e);
        this.boundHandlers.onPreviewMouseUp = (e) => this._stopPreviewMousePan(e);
        this.boundHandlers.onPreviewImageClick = (e) => this._handlePreviewImageClick(e);
        previewImg.addEventListener('mousedown', this.boundHandlers.onPreviewMouseDown);
        document.addEventListener('mousemove', this.boundHandlers.onPreviewMouseMove);
        document.addEventListener('mouseup', this.boundHandlers.onPreviewMouseUp);
        previewImg.addEventListener('click', this.boundHandlers.onPreviewImageClick);

        // Preview touch gestures
        this.boundHandlers.onPreviewTouchStart = (e) => this._onPreviewTouchStart(e);
        this.boundHandlers.onPreviewTouchMove = (e) => this._onPreviewTouchMove(e);
        this.boundHandlers.onPreviewTouchEnd = (e) => this._onPreviewTouchEnd(e);
        imgWrap.addEventListener('touchstart', this.boundHandlers.onPreviewTouchStart, { passive: false });
        imgWrap.addEventListener('touchmove', this.boundHandlers.onPreviewTouchMove, { passive: false });
        imgWrap.addEventListener('touchend', this.boundHandlers.onPreviewTouchEnd);
        imgWrap.addEventListener('touchcancel', this.boundHandlers.onPreviewTouchEnd);
    }

    // ========================================
    // SEARCH
    // ========================================

    async search(page = 0) {
        const input = this.container.querySelector('.uishortcuts-gelbooru-input');
        let tags = (input?.value || '').trim();
        if (!tags) return;

        // Append rating filter tag
        const ratingSelect = this.container.querySelector('.uishortcuts-gelbooru-rating');
        const rating = ratingSelect?.value;
        if (rating && RATING_TAGS[rating]) {
            // Remove any existing rating: tags to avoid duplicates
            tags = tags.replace(/\brating:\w+/g, '').trim();
            tags += ` ${RATING_TAGS[rating]}`;
        }

        this.currentQuery = tags;
        this.currentPage = Math.max(0, page);
        this.isLoading = true;
        this._updateUI();

        try {
            const apiKey = this.apiKey;
            const userId = this.userId;
            if (!apiKey || !userId) {
                this._showError(
                    `<i class="fa-solid fa-key"></i> <strong>API credentials required.</strong><br>` +
                    `Enter your Gelbooru API Key and User ID in the extension settings (Extensions → UI Shortcuts).`,
                    { html: true }
                );
                throw new Error('Gelbooru API credentials not configured');
            }
            const response = await fetchWithCsrf(`${PLUGIN_BASE}/gelbooru/search`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tags,
                    page: this.currentPage,
                    limit: this.resultsPerPage,
                    apiKey,
                    userId,
                }),
            });

            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                if (response.status === 401 || err.code === 401) {
                    this._showError(
                        `<i class="fa-solid fa-key"></i> <strong>Gelbooru requires API credentials.</strong><br>` +
                        `Get a free API key from your ` +
                        `<a href="https://gelbooru.com/index.php?page=account&s=options" target="_blank" rel="noopener">Gelbooru account page</a>, ` +
                        `then enter your API Key and User ID in the extension settings (Extensions → UI Shortcuts → Gelbooru).`,
                        { html: true }
                    );
                    throw new Error('Gelbooru API authentication required');
                }
                throw new Error(err.error || `HTTP ${response.status}`);
            }

            const data = await response.json();
            // Gelbooru v0.2 wraps results in { post: [...], @attributes: { ... } }
            this.results = Array.isArray(data?.post) ? data.post : (Array.isArray(data) ? data : []);
            this.totalCount = data?.['@attributes']?.count ?? this.results.length;
        } catch (err) {
            log('Gelbooru search failed: ' + err.message, 'error');
            this.results = [];
            this.totalCount = 0;
            this._showError(err.message);
        } finally {
            this.isLoading = false;
            this._updateUI();
        }
    }

    // ========================================
    // UI RENDERING
    // ========================================

    _updateUI() {
        const grid = this.container.querySelector('.uishortcuts-gelbooru-grid');
        const empty = this.container.querySelector('.uishortcuts-gelbooru-empty');
        const loader = this.container.querySelector('.uishortcuts-gelbooru-loader');
        const errorEl = this.container.querySelector('.uishortcuts-gelbooru-error');
        const pagination = this.container.querySelector('.uishortcuts-gelbooru-pagination');

        // Hide error on new search
        errorEl.style.display = 'none';
        errorEl.textContent = '';

        if (this.isLoading) {
            loader.style.display = 'flex';
            grid.style.display = 'none';
            empty.style.display = 'none';
            pagination.style.display = 'none';
            return;
        }

        loader.style.display = 'none';

        if (this.results.length === 0 && this.currentQuery) {
            grid.style.display = 'none';
            empty.querySelector('p').textContent = 'No results found';
            empty.style.display = 'flex';
            pagination.style.display = 'none';
            return;
        }

        if (this.results.length === 0) {
            grid.style.display = 'none';
            empty.querySelector('p').textContent = 'Search for images on Gelbooru';
            empty.style.display = 'flex';
            pagination.style.display = 'none';
            return;
        }

        empty.style.display = 'none';
        grid.style.display = 'grid';
        this._renderGrid();
        this._updatePagination();
    }

    _renderGrid() {
        const grid = this.container.querySelector('.uishortcuts-gelbooru-grid');
        grid.innerHTML = '';

        for (const post of this.results) {
            const item = document.createElement('div');
            item.className = 'uishortcuts-gelbooru-grid-item';
            item.dataset.id = post.id;
            item.title = (post.tags || '').substring(0, 120);

            const img = document.createElement('img');
            // Use preview URL (small thumbnail) for grid, routed through the
            // stream proxy. Gelbooru now blocks direct hotlinked CDN access.
            img.src = this._proxyImageUrl(post.preview_url || post.sample_url || post.file_url || '');
            img.alt = `Post ${post.id}`;
            img.loading = 'lazy';

            // Rating badge
            const badge = document.createElement('span');
            badge.className = `uishortcuts-gelbooru-rating-badge rating-${post.rating || 'unknown'}`;
            badge.textContent = (post.rating || '?')[0].toUpperCase();

            item.appendChild(img);
            item.appendChild(badge);

            if (this._isVideoPost(post)) {
                const videoBadge = document.createElement('span');
                videoBadge.className = 'uishortcuts-gelbooru-video-badge';
                videoBadge.innerHTML = '<i class="fa-solid fa-play"></i>';
                item.appendChild(videoBadge);
            }

            item.addEventListener('click', () => this.openPreview(post));
            grid.appendChild(item);
        }
    }

    _updatePagination() {
        const prevBtn = this.container.querySelector('.uishortcuts-gelbooru-page-prev');
        const nextBtn = this.container.querySelector('.uishortcuts-gelbooru-page-next');
        const info = this.container.querySelector('.uishortcuts-gelbooru-page-info');
        const pagination = this.container.querySelector('.uishortcuts-gelbooru-pagination');

        const totalPages = Math.ceil(this.totalCount / this.resultsPerPage);
        const hasResults = this.results.length > 0;

        pagination.style.display = hasResults ? 'flex' : 'none';
        prevBtn.disabled = this.currentPage <= 0;
        nextBtn.disabled = this.currentPage >= totalPages - 1 || this.results.length < this.resultsPerPage;
        info.textContent = hasResults
            ? `Page ${this.currentPage + 1}${totalPages > 0 ? ` / ${totalPages}` : ''} · ${this.totalCount.toLocaleString()} results`
            : '';
    }

    _showError(message, { html = false } = {}) {
        const errorEl = this.container.querySelector('.uishortcuts-gelbooru-error');
        if (html) {
            errorEl.innerHTML = message;
        } else {
            errorEl.textContent = `Error: ${message}`;
        }
        errorEl.style.display = 'block';
    }

    // ========================================
    // PREVIEW
    // ========================================

    async openPreview(post) {
        // Abort any in-flight preview fetch
        if (this._previewController) this._previewController.abort();
        const controller = new AbortController();
        this._previewController = controller;

        this.previewPost = post;
        this.gallery._pushHistoryState('gelbooru-preview');
        const overlay = this.container.querySelector('.uishortcuts-gelbooru-preview-overlay');
        const imgWrap = this.container.querySelector('.uishortcuts-gelbooru-preview-image-wrap');
        const img = this.container.querySelector('.uishortcuts-gelbooru-preview-image');
        const loader = this.container.querySelector('.uishortcuts-gelbooru-preview-loader');
        const dims = this.container.querySelector('.uishortcuts-gelbooru-preview-dims');
        const tagsEl = this.container.querySelector('.uishortcuts-gelbooru-preview-tags');
        const saveBtn = this.container.querySelector('.uishortcuts-gelbooru-save-btn');

        // Show overlay
        overlay.classList.add('active');

        // Clean up any previous video element
        const oldVideo = imgWrap.querySelector('.uishortcuts-gelbooru-preview-video');
        if (oldVideo) { oldVideo.pause(); oldVideo.src = ''; oldVideo.remove(); }

        const isVideo = this._isVideoPost(post);

        if (isVideo) {
            // Video post: show <video> element
            img.style.display = 'none';
            loader.style.display = 'flex';

            const video = document.createElement('video');
            video.className = 'uishortcuts-gelbooru-preview-video';
            video.controls = true;
            video.autoplay = true;
            video.loop = true;
            video.muted = true;
            video.playsInline = true;

            const fullUrl = post.file_url || post.sample_url || '';
            if (fullUrl) {
                // Try streaming endpoint first (fast), fall back to base64 download
                try {
                    const streamResp = await fetchWithCsrf(`${PLUGIN_BASE}/gelbooru/stream?url=${encodeURIComponent(fullUrl)}`, {
                        signal: controller.signal,
                    });
                    if (controller.signal.aborted) return;
                    if (streamResp.ok) {
                        const blob = await streamResp.blob();
                        if (controller.signal.aborted) return;
                        const objUrl = URL.createObjectURL(blob);
                        video.src = objUrl;
                        video.addEventListener('emptied', () => URL.revokeObjectURL(objUrl), { once: true });
                    } else {
                        throw new Error('stream unavailable');
                    }
                } catch (err) {
                    if (err.name === 'AbortError') return;
                    // Fallback: download as base64 via POST proxy
                    try {
                        const dlResp = await fetchWithCsrf(`${PLUGIN_BASE}/gelbooru/download`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ url: fullUrl }),
                            signal: controller.signal,
                        });
                        if (controller.signal.aborted) return;
                        if (dlResp.ok) {
                            const { base64, contentType } = await dlResp.json();
                            if (controller.signal.aborted) return;
                            if (base64) {
                                video.src = `data:${contentType};base64,${base64}`;
                            }
                        } else {
                            log(`Video download error (${dlResp.status})`, 'warn');
                        }
                    } catch (dlErr) {
                        if (dlErr.name === 'AbortError') return;
                        log(`Video download failed: ${dlErr.message}`, 'warn');
                    }
                }
            }

            video.addEventListener('canplay', () => loader.style.display = 'none', { once: true });
            imgWrap.insertBefore(video, loader);

            saveBtn.disabled = false;
            saveBtn.title = 'Save to character gallery';
        } else {
            // Image post: show thumbnail immediately, upgrade to full-res
            img.style.display = '';

            // Show thumbnail at full opacity, stretched to fill frame.
            // Routed through the proxy since direct CDN hotlinks are blocked.
            img.src = this._proxyImageUrl(post.preview_url || '');
            img.style.opacity = '1';
            img.classList.add('loading-preview');
            loader.style.display = 'flex';

            // Load full-res image via server proxy (Gelbooru CDN blocks direct browser access)
            const fullUrl = post.file_url || post.sample_url || '';
            if (fullUrl) {
                try {
                    const dlResp = await fetchWithCsrf(`${PLUGIN_BASE}/gelbooru/download`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ url: fullUrl }),
                        signal: controller.signal,
                    });
                    // Check if we were aborted (user navigated away)
                    if (controller.signal.aborted) return;
                    if (dlResp.ok) {
                        const { base64, contentType } = await dlResp.json();
                        if (controller.signal.aborted) return;
                        if (base64) {
                            img.src = `data:${contentType};base64,${base64}`;
                        }
                    } else {
                        const errBody = await dlResp.text().catch(() => '');
                        log(`Preview proxy error (${dlResp.status}): ${errBody}`, 'warn');
                    }
                } catch (err) {
                    if (err.name === 'AbortError') return;
                    log(`Preview proxy failed: ${err.message}`, 'warn');
                    // Fallback: try direct URL (may work on some networks)
                    if (!controller.signal.aborted) img.src = fullUrl;
                }
            }
            if (!controller.signal.aborted) {
                img.classList.remove('loading-preview');
                loader.style.display = 'none';
            }

            saveBtn.disabled = false;
            saveBtn.title = 'Save to character gallery';
        }

        // Metadata
        dims.textContent = `${post.width}×${post.height}`;

        // Tags (show first ~20)
        const tagList = (post.tags || '').split(' ').filter(Boolean).slice(0, 30);
        tagsEl.innerHTML = tagList
            .map(t => `<span class="uishortcuts-gelbooru-tag" title="${t}">${t}</span>`)
            .join('');

        // Clicking a tag inserts it into search
        tagsEl.querySelectorAll('.uishortcuts-gelbooru-tag').forEach(el => {
            el.addEventListener('click', () => {
                const input = this.container.querySelector('.uishortcuts-gelbooru-input');
                const current = input.value.trim();
                const tag = el.title;
                if (!current.split(/\s+/).includes(tag)) {
                    input.value = current ? `${current} ${tag}` : tag;
                }
            });
        });
    }

    closePreview() {
        if (this._previewController) this._previewController.abort();
        this.previewPost = null;
        this._resetPreviewZoom();
        const overlay = this.container.querySelector('.uishortcuts-gelbooru-preview-overlay');
        overlay.classList.remove('active');

        // Clean up video element if present
        const imgWrap = this.container.querySelector('.uishortcuts-gelbooru-preview-image-wrap');
        const video = imgWrap?.querySelector('.uishortcuts-gelbooru-preview-video');
        if (video) {
            video.pause();
            video.src = '';
            video.remove();
        }
        // Restore img visibility
        const img = this.container.querySelector('.uishortcuts-gelbooru-preview-image');
        if (img) img.style.display = '';
    }

    navigatePreview(direction) {
        if (!this.previewPost || !this.results.length) return;
        const idx = this.results.findIndex(p => p.id === this.previewPost.id);
        if (idx === -1) return;
        const next = idx + direction;
        if (next < 0 || next >= this.results.length) return;
        this._resetPreviewZoom();
        this.openPreview(this.results[next]);
    }

    _openOnGelbooru() {
        if (!this.previewPost) return;
        window.open(`https://gelbooru.com/index.php?page=post&s=view&id=${this.previewPost.id}`, '_blank');
    }

    // ========================================
    // SAVE TO CHARACTER GALLERY
    // ========================================

    async _saveCurrentPreview() {
        if (!this.previewPost) return;

        const gallery = this.gallery;
        if (!gallery.currentCharacter) {
            log('No character selected, cannot save image', 'warn');
            return;
        }

        const saveBtn = this.container.querySelector('.uishortcuts-gelbooru-save-btn');
        const originalHtml = saveBtn.innerHTML;
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';

        try {
            const post = this.previewPost;
            const imageUrl = post.file_url || post.sample_url;

            if (!imageUrl) throw new Error('No image URL available');

            // Download via server proxy
            const dlResponse = await fetchWithCsrf(`${PLUGIN_BASE}/gelbooru/download`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: imageUrl }),
            });

            if (!dlResponse.ok) {
                const err = await dlResponse.json().catch(() => ({}));
                throw new Error(err.error || `Download failed: HTTP ${dlResponse.status}`);
            }

            const { base64, contentType } = await dlResponse.json();

            // Determine file format from content type
            const formatMap = {
                'image/jpeg': 'jpeg',
                'image/jpg': 'jpeg',
                'image/png': 'png',
                'image/webp': 'webp',
                'image/gif': 'gif',
                'video/mp4': 'mp4',
                'video/webm': 'webm',
            };
            const format = formatMap[contentType] || 'png';
            const filename = `gelbooru_${post.id}`;

            // Upload to character gallery using ST's API
            const folderName = gallery.getGalleryFolderName(gallery.currentCharacter);
            const uploadResponse = await fetchWithCsrf('/api/images/upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image: base64,
                    format,
                    filename,
                    ch_name: folderName,
                }),
            });

            if (!uploadResponse.ok) {
                throw new Error(`Upload failed: HTTP ${uploadResponse.status}`);
            }

            log(`Saved Gelbooru post ${post.id} to ${folderName}`);
            saveBtn.innerHTML = '<i class="fa-solid fa-check"></i> Saved!';

            // Refresh gallery in background
            gallery.refreshGallery();

            setTimeout(() => {
                saveBtn.innerHTML = originalHtml;
                saveBtn.disabled = false;
            }, 2000);
        } catch (err) {
            log('Failed to save Gelbooru image: ' + err.message, 'error');
            saveBtn.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Failed';
            setTimeout(() => {
                saveBtn.innerHTML = originalHtml;
                saveBtn.disabled = false;
            }, 2500);
        }
    }

    // ========================================
    // AUTOCOMPLETE
    // ========================================

    _onInputChanged() {
        clearTimeout(this._acTimer);
        const input = this.container.querySelector('.uishortcuts-gelbooru-input');
        const value = input.value.trim();

        // Get the last word being typed (tag autocompletion)
        const words = value.split(/\s+/);
        const lastWord = words[words.length - 1] || '';

        if (lastWord.length < 2) {
            this._hideAutocomplete();
            return;
        }

        this._acTimer = setTimeout(() => this._fetchAutocomplete(lastWord), 300);
    }

    async _fetchAutocomplete(term) {
        // Abort previous request if pending
        if (this._acController) this._acController.abort();
        this._acController = new AbortController();

        try {
            const response = await fetchWithCsrf(`${PLUGIN_BASE}/gelbooru/tags`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ term, limit: 10, apiKey: this.apiKey, userId: this.userId }),
                signal: this._acController.signal,
            });

            if (!response.ok) return;
            const data = await response.json();
            const tags = Array.isArray(data?.tag) ? data.tag : (Array.isArray(data) ? data : []);
            this._showAutocomplete(tags, term);
        } catch {
            // Aborted or failed, ignore
        }
    }

    _showAutocomplete(tags, currentTerm) {
        const ac = this.container.querySelector('.uishortcuts-gelbooru-autocomplete');
        if (!tags.length) {
            ac.style.display = 'none';
            return;
        }

        ac.innerHTML = '';
        for (const tag of tags) {
            const name = tag.name || tag.tag || '';
            const count = tag.count || 0;
            const item = document.createElement('div');
            item.className = 'uishortcuts-gelbooru-ac-item';
            item.innerHTML = `<span class="ac-name">${this._highlight(name, currentTerm)}</span><span class="ac-count">${this._formatCount(count)}</span>`;
            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                this._insertTag(name);
                ac.style.display = 'none';
            });
            ac.appendChild(item);
        }

        ac.style.display = 'block';
    }

    _hideAutocomplete() {
        const ac = this.container?.querySelector('.uishortcuts-gelbooru-autocomplete');
        if (ac) ac.style.display = 'none';
    }

    _insertTag(tagName) {
        const input = this.container.querySelector('.uishortcuts-gelbooru-input');
        const words = input.value.trim().split(/\s+/);
        words[words.length - 1] = tagName;
        input.value = words.join(' ') + ' ';
        input.focus();
    }

    _highlight(text, term) {
        if (!term) return text;
        const idx = text.toLowerCase().indexOf(term.toLowerCase());
        if (idx === -1) return text;
        return text.substring(0, idx) + '<b>' + text.substring(idx, idx + term.length) + '</b>' + text.substring(idx + term.length);
    }

    _formatCount(n) {
        if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
        if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
        return String(n);
    }

    // ========================================
    // PUBLIC HELPERS
    // ========================================

    _applyDefaultRating() {
        const rating = this.settings.defaultRating || '';
        const select = this.container?.querySelector('.uishortcuts-gelbooru-rating');
        if (select) select.value = rating;
    }

    /**
     * Populate search input with character name (called when gallery opens).
     * @param {string} name
     */
    setCharacterName(name) {
        const input = this.container?.querySelector('.uishortcuts-gelbooru-input');
        if (input && !input.value.trim()) {
            input.value = name.replace(/[^a-zA-Z0-9_\s]/g, '').trim().replace(/\s+/g, '_').toLowerCase();
        }
    }

    /**
     * Reset state when gallery closes.
     */
    reset() {
        this.closePreview();
        this._hideAutocomplete();
    }

    /**
     * Handle keyboard events forwarded from gallery.
     * @param {KeyboardEvent} e
     * @returns {boolean} true if the event was consumed
     */
    handleKeydown(e) {
        if (!this.previewPost) return false;
        // Close preview on Escape
        if (e.key === 'Escape') {
            this.closePreview();
            return true;
        }
        // Navigate preview with arrows
        if (e.key === 'ArrowLeft') {
            this.navigatePreview(-1);
            return true;
        }
        if (e.key === 'ArrowRight') {
            this.navigatePreview(1);
            return true;
        }
        // Keyboard zoom
        if (e.key === '+' || e.key === '=') {
            this._previewZoom = Math.min(this._previewZoomMax, this._previewZoom + 0.25);
            this._applyPreviewTransform();
            return true;
        }
        if (e.key === '-' || e.key === '_') {
            this._previewZoom = Math.max(this._previewZoomMin, this._previewZoom - 0.25);
            this._applyPreviewTransform();
            return true;
        }
        if (e.key === '0') {
            this._resetPreviewZoom();
            return true;
        }
        return false;
    }

    // ========================================
    // PREVIEW TOUCH GESTURES
    // ========================================

    _resetPreviewZoom() {
        this._previewZoom = 1;
        this._previewPan = { x: 0, y: 0 };
        const img = this.container?.querySelector('.uishortcuts-gelbooru-preview-image');
        if (img) {
            img.style.transform = '';
            img.classList.remove('zoomed');
        }
    }

    _applyPreviewTransform() {
        const img = this.container?.querySelector('.uishortcuts-gelbooru-preview-image');
        if (!img) return;
        img.classList.toggle('zoomed', this._previewZoom > 1);
        if (this._previewZoom <= 1) {
            this._previewPan = { x: 0, y: 0 };
            img.style.transform = `scale(${this._previewZoom})`;
        } else {
            const { x, y } = this._previewPan;
            img.style.transform = `translate(${x}px, ${y}px) scale(${this._previewZoom})`;
        }
    }

    // ---- Desktop wheel zoom ----

    _handlePreviewWheel(e) {
        if (!this.previewPost || this._isVideoPost(this.previewPost)) return;
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.15 : 0.15;
        const newZoom = Math.max(this._previewZoomMin, Math.min(this._previewZoomMax, this._previewZoom + delta));
        if (newZoom !== this._previewZoom) {
            this._previewZoom = newZoom;
            this._applyPreviewTransform();
        }
    }

    // ---- Desktop mouse pan ----

    _startPreviewMousePan(e) {
        if (!this.previewPost || this._isVideoPost(this.previewPost)) return;
        if (this._previewZoom <= 1) return;
        e.preventDefault();
        this._previewMousePanning = true;
        this._previewWasPanning = false;
        this._previewPanStart.x = e.clientX - this._previewPan.x;
        this._previewPanStart.y = e.clientY - this._previewPan.y;
    }

    _onPreviewMousePan(e) {
        if (!this._previewMousePanning) return;
        e.preventDefault();
        this._previewWasPanning = true;
        this._previewPan.x = e.clientX - this._previewPanStart.x;
        this._previewPan.y = e.clientY - this._previewPanStart.y;
        const img = this.container?.querySelector('.uishortcuts-gelbooru-preview-image');
        if (img) {
            img.style.transform = `translate(${this._previewPan.x}px, ${this._previewPan.y}px) scale(${this._previewZoom})`;
        }
    }

    _stopPreviewMousePan() {
        this._previewMousePanning = false;
    }

    _handlePreviewImageClick(e) {
        if (this._previewWasPanning) {
            this._previewWasPanning = false;
            return;
        }
        if (this._previewZoom !== 1) {
            this._resetPreviewZoom();
        }
    }

    _onPreviewTouchStart(e) {
        const isVideo = this.previewPost && this._isVideoPost(this.previewPost);

        // Pinch-to-zoom: two fingers on images
        if (e.touches.length === 2 && !isVideo) {
            e.preventDefault();
            const [a, b] = e.touches;
            this._pinch.active = true;
            this._pinch.startDist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
            this._pinch.startZoom = this._previewZoom;
            this._touch.isTracking = false;
            this._touch.isPanning = false;
            return;
        }

        if (e.touches.length !== 1) return;
        const t = e.touches[0];
        const s = this._touch;
        s.startX = s.lastX = t.clientX;
        s.startY = s.lastY = t.clientY;
        s.tapMoved = false;
        s.isTracking = true;
        // Only allow panning for images when zoomed
        s.isPanning = !isVideo && this._previewZoom > 1;
        s.panMoved = false;
        if (s.isPanning) {
            e.preventDefault();
            this._previewPanStart.x = t.clientX - this._previewPan.x;
            this._previewPanStart.y = t.clientY - this._previewPan.y;
        }
    }

    _onPreviewTouchMove(e) {
        // Pinch zoom
        if (this._pinch.active && e.touches.length === 2) {
            e.preventDefault();
            const [a, b] = e.touches;
            const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
            if (this._pinch.startDist > 0) {
                const zoom = this._pinch.startZoom * (dist / this._pinch.startDist);
                this._previewZoom = Math.max(this._previewZoomMin, Math.min(this._previewZoomMax, zoom));
                this._applyPreviewTransform();
            }
            return;
        }

        const s = this._touch;
        if (!s.isTracking || e.touches.length !== 1) return;
        const t = e.touches[0];
        const dx = t.clientX - s.startX;
        const dy = t.clientY - s.startY;
        s.lastX = t.clientX;
        s.lastY = t.clientY;

        if (Math.abs(dx) > 10 || Math.abs(dy) > 10) s.tapMoved = true;

        if (s.isPanning) {
            if (Math.abs(dx) > 10 || Math.abs(dy) > 10) s.panMoved = true;
            e.preventDefault();
            this._previewPan.x = t.clientX - this._previewPanStart.x;
            this._previewPan.y = t.clientY - this._previewPanStart.y;
            this._applyPreviewTransform();
            return;
        }

        // Horizontal swipe: prevent vertical scroll
        if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
            e.preventDefault();
        }
    }

    _onPreviewTouchEnd(e) {
        // End pinch
        if (this._pinch.active) {
            if (e.touches.length < 2) this._pinch.active = false;
            return;
        }

        const s = this._touch;
        if (!s.isTracking) return;
        s.isTracking = false;

        if (s.isPanning && s.panMoved) return;

        const dx = s.lastX - s.startX;
        const dy = s.lastY - s.startY;

        // Swipe navigation (only when not zoomed, to avoid interfering with pan)
        if (this._previewZoom <= 1 && s.tapMoved && Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
            this.navigatePreview(dx < 0 ? 1 : -1);
            return;
        }

        // Double-tap zoom
        const now = Date.now();
        const isTap = !s.tapMoved;
        const withinDelay = now - s.lastTapTime <= 300;
        const tapDist = Math.hypot(s.startX - s.lastTapX, s.startY - s.lastTapY);

        if (isTap && withinDelay && tapDist <= 24) {
            if (this._previewZoom !== 1) {
                this._resetPreviewZoom();
            } else {
                this._previewZoom = 2;
                this._previewPan = { x: 0, y: 0 };
                this._applyPreviewTransform();
            }
            s.lastTapTime = 0;
            return;
        }

        if (isTap) {
            s.lastTapTime = now;
            s.lastTapX = s.startX;
            s.lastTapY = s.startY;
        }
    }

    /**
     * Cleanup resources.
     */
    destroy() {
        clearTimeout(this._acTimer);
        if (this._acController) this._acController.abort();
        if (this._previewController) this._previewController.abort();
        const imgWrap = this.container?.querySelector('.uishortcuts-gelbooru-preview-image-wrap');
        if (imgWrap) {
            imgWrap.removeEventListener('click', this.boundHandlers.onImgWrapClick);
            imgWrap.removeEventListener('touchstart', this.boundHandlers.onPreviewTouchStart);
            imgWrap.removeEventListener('touchmove', this.boundHandlers.onPreviewTouchMove);
            imgWrap.removeEventListener('touchend', this.boundHandlers.onPreviewTouchEnd);
            imgWrap.removeEventListener('touchcancel', this.boundHandlers.onPreviewTouchEnd);
            imgWrap.removeEventListener('wheel', this.boundHandlers.onPreviewWheel);
        }
        const previewImg = this.container?.querySelector('.uishortcuts-gelbooru-preview-image');
        if (previewImg) {
            previewImg.removeEventListener('mousedown', this.boundHandlers.onPreviewMouseDown);
            previewImg.removeEventListener('click', this.boundHandlers.onPreviewImageClick);
        }
        document.removeEventListener('mousemove', this.boundHandlers.onPreviewMouseMove);
        document.removeEventListener('mouseup', this.boundHandlers.onPreviewMouseUp);
        const grid = this.container?.querySelector('.uishortcuts-gelbooru-grid');
        if (grid) {
            grid.removeEventListener('touchstart', this.boundHandlers.onGridTouchStart);
            grid.removeEventListener('touchend', this.boundHandlers.onGridTouchEnd);
        }
    }
}
