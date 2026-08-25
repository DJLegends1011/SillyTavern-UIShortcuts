/**
 * SillyTavern UI Shortcuts - Avatar Gallery Module
 * Provides an enhanced avatar gallery selector when clicking character avatars
 */

import { 
    getSTContext, 
    getCharacterAvatarUrl, 
    sanitizeFolderName, 
    isImageFile,
    isVideoFile,
    fetchWithCsrf,
    log 
} from '../../utils.js';
import { hasNativeTransport } from './gelbooru/transport.js';

// Optional sub-modules — loaded dynamically so the gallery works standalone
let GelbooruSearch = null;
let initMobileEnhancements = null;
let SetAsBackground = null;
try { ({ GelbooruSearch } = await import('./gelbooru/index.js')); } catch {}
try { ({ initAvatarGalleryMobileEnhancements: initMobileEnhancements } = await import('./mobile/index.js')); } catch {}
try { ({ SetAsBackground } = await import('./set-as-background/index.js')); } catch {}

const GALLERY_STATE_FIELD = 'galleryPanelState';

// Helper to convert File to base64
const toBase64 = file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
});

// Capture a thumbnail frame from a video URL, returns a JPEG data URL or null
function captureVideoThumbnail(src) {
    return new Promise((resolve) => {
        const video = document.createElement('video');
        video.muted = true;
        video.preload = 'metadata';
        video.crossOrigin = 'anonymous';

        const cleanup = () => { video.src = ''; video.load(); };

        video.addEventListener('error', () => { cleanup(); resolve(null); }, { once: true });

        video.addEventListener('loadedmetadata', () => {
            // Seek to 1s or 10% of duration, whichever is smaller
            video.currentTime = Math.min(1, video.duration * 0.1);
        }, { once: true });

        video.addEventListener('seeked', () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = video.videoWidth || 320;
                canvas.height = video.videoHeight || 180;
                canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL('image/jpeg', 0.7));
            } catch {
                resolve(null);
            } finally {
                cleanup();
            }
        }, { once: true });

        video.src = src;
    });
}

/**
 * Concurrency-limited IntersectionObserver-based lazy loader for gallery tiles.
 * Each tile is a `.uishortcuts-gallery-tile[data-src][data-kind]` element; when
 * it enters the viewport (+ rootMargin), a loader assigns its <img> src or
 * captures a video thumbnail — up to MAX_ACTIVE at once.
 */
class LazyMediaLoader {
    constructor({ root, rootMargin = '200px', maxActive = 6 } = {}) {
        this.maxActive = maxActive;
        this.active = 0;
        this.queue = [];
        this.observer = new IntersectionObserver((entries) => {
            for (const e of entries) {
                if (!e.isIntersecting) continue;
                this.observer.unobserve(e.target);
                this._enqueue(e.target);
            }
        }, { root: root || null, rootMargin });
    }

    observe(tile) { this.observer.observe(tile); }

    _enqueue(tile) {
        if (this.active < this.maxActive) {
            this.active++;
            this._load(tile);
        } else {
            this.queue.push(tile);
        }
    }

    _drain() {
        this.active--;
        if (this.queue.length && this.active < this.maxActive) {
            this.active++;
            this._load(this.queue.shift());
        }
    }

    _load(tile) {
        if (!tile.isConnected) { this._drain(); return; }
        const kind = tile.dataset.kind;
        const src = tile.dataset.src;
        const img = tile.querySelector('img');
        if (!img) { this._drain(); return; }

        const done = () => {
            tile.classList.remove('uishortcuts-gallery-tile-loading');
            this._drain();
        };

        if (kind === 'video') {
            captureVideoThumbnail(src).then(dataUrl => {
                if (!tile.isConnected) return this._drain();
                if (dataUrl) {
                    img.src = dataUrl;
                    done();
                } else {
                    // Fall back to film-icon overlay
                    img.remove();
                    const icon = tile.querySelector('.uishortcuts-gallery-tile-badge');
                    if (icon) {
                        icon.classList.add('uishortcuts-gallery-tile-badge-fallback');
                        icon.innerHTML = '<i class="fa-solid fa-film"></i>';
                    }
                    done();
                }
            });
        } else {
            img.addEventListener('load', done, { once: true });
            img.addEventListener('error', () => {
                tile.classList.add('uishortcuts-gallery-tile-error');
                done();
            }, { once: true });
            img.src = src;
        }
    }

    destroy() {
        this.observer.disconnect();
        this.queue.length = 0;
        this.active = 0;
    }
}

export class AvatarGallerySelector {
    constructor() {
        this.panel = null;
        this.currentImages = [];
        this.selectedIndex = 0;
        this.isGridView = false;
        this.currentCharacter = null;
        this.isMobile = false;
        this.mobileCleanup = null;
        this.boundHandlers = {};
        this.lastSelectedImage = null;
        this.lastSelectedByCharacter = new Map();
        
        // Gelbooru search integration
        this.gelbooru = null;
        this.activeTab = 'local'; // 'local' | 'gelbooru'

        // Set-as-background sub-module
        this.setAsBg = null;
        
        // Panel dragging state
        this.isDragging = false;
        this.dragOffset = { x: 0, y: 0 };
        
        // Zoom state
        this.zoomLevel = 1;
        this.zoomMin = 0.5;
        this.zoomMax = 5;
        
        // Pan state
        this.isPanning = false;
        this.wasPanning = false;
        this.panStart = { x: 0, y: 0 };
        this.panOffset = { x: 0, y: 0 };

        // Video playback state
        this._videoEl = null;
        this._mainImgEl = null; // Stable reference to the persistent <img> element

        // Lazy-loading state
        this._thumbLoader = null;   // Horizontal thumbnail strip loader
        this._gridLoader = null;    // Grid view loader
        this._preloaded = new Map(); // index → HTMLImageElement (prev/next preloads)
        this._mainAbort = null;      // AbortController for current main-image load

        // Resize observer
        this.resizeObserver = null;
        
        // Load saved state
        this.savedState = this.loadState();
        
        this.init();
    }

    // ========================================
    // STATE PERSISTENCE
    // ========================================

    loadState() {
        try {
            const ctx = getSTContext();
            const store = ctx?.extensionSettings?.UIShortcuts;
            return store?.[GALLERY_STATE_FIELD] || null;
        } catch (e) {
            return null;
        }
    }

    saveState() {
        try {
            const rect = this.panel.getBoundingClientRect();
            const state = {
                left: this.panel.style.left || `${rect.left}px`,
                top: this.panel.style.top || `${rect.top}px`,
                width: this.panel.offsetWidth,
                height: this.panel.offsetHeight
            };
            const ctx = getSTContext();
            if (ctx?.extensionSettings?.UIShortcuts) {
                ctx.extensionSettings.UIShortcuts[GALLERY_STATE_FIELD] = state;
                if (typeof ctx.saveSettingsDebounced === 'function') {
                    ctx.saveSettingsDebounced();
                }
            }
            this.savedState = state;
        } catch (e) {
            log('Could not save panel state: ' + e.message, 'warn');
        }
    }

    restoreState() {
        if (!this.savedState) return;
        
        const { left, top, width, height } = this.savedState;
        
        if (left) this.panel.style.left = left;
        if (top) this.panel.style.top = top;
        if (width) this.panel.style.width = `${width}px`;
        if (height) this.panel.style.height = `${height}px`;
        this.panel.style.right = 'auto';
        this.panel.style.bottom = 'auto';
    }

    // ========================================
    // INITIALIZATION
    // ========================================

    init() {
        this.createPanel();
        if (initMobileEnhancements) {
            this.mobileCleanup = initMobileEnhancements(this);
        }
        this.interceptAvatarClicks();
    }

    createPanel() {
        this.panel = document.createElement('div');
        this.panel.id = 'uishortcuts-avatar-gallery';
        this.panel.className = 'uishortcuts-gallery-panel';
        this.panel.innerHTML = `
            <div class="uishortcuts-gallery-header" data-draggable="true">
                <div class="uishortcuts-gallery-title">
                    <i class="fa-solid fa-images"></i>
                    <span class="uishortcuts-gallery-char-name">Avatar Gallery</span>
                </div>
                <div class="uishortcuts-gallery-controls">
                    ${GelbooruSearch ? `
                    <button class="uishortcuts-gallery-btn uishortcuts-gallery-gelbooru-toggle" title="Gelbooru Search (Tab)">
                        <i class="fa-solid fa-magnifying-glass"></i>
                    </button>
                    ` : ''}
                    <button class="uishortcuts-gallery-btn uishortcuts-gallery-grid" title="Grid View (G)">
                        <i class="fa-solid fa-grip"></i>
                    </button>
                    <button class="uishortcuts-gallery-btn uishortcuts-gallery-notes" title="Creator's Notes (N)">
                        <i class="fa-solid fa-book"></i>
                    </button>
                    <button class="uishortcuts-gallery-close" title="Close (Esc)">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
            </div>
            <div class="uishortcuts-gallery-content">
                <div class="uishortcuts-gallery-main-view">
                    <button class="uishortcuts-gallery-nav uishortcuts-gallery-prev" title="Previous (←)">
                        <i class="fa-solid fa-chevron-left"></i>
                    </button>
                    <div class="uishortcuts-gallery-image-wrapper">
                        <img class="uishortcuts-gallery-main-image" src="" alt="Selected image">
                        <div class="uishortcuts-gallery-image-loader">
                            <i class="fa-solid fa-spinner fa-spin"></i>
                        </div>
                    </div>
                    <button class="uishortcuts-gallery-nav uishortcuts-gallery-next" title="Next (→)">
                        <i class="fa-solid fa-chevron-right"></i>
                    </button>
                </div>
                <div class="uishortcuts-gallery-grid-view">
                    <div class="uishortcuts-gallery-grid-scroll"></div>
                </div>
                <div class="uishortcuts-gallery-thumbnails">
                    <div class="uishortcuts-gallery-thumbnails-scroll"></div>
                </div>
                <div class="uishortcuts-gallery-footer">
                    <span class="uishortcuts-gallery-counter">1 / 1</span>
                </div>
            </div>
            <div class="uishortcuts-gallery-resize-hint" title="Drag to resize">
                <i class="fa-solid fa-grip"></i>
            </div>
            <div class="uishortcuts-gallery-notes-overlay">
                <div class="uishortcuts-gallery-notes-modal">
                    <div class="uishortcuts-gallery-notes-header">
                        <span class="uishortcuts-gallery-notes-title">
                            <i class="fa-solid fa-book"></i>
                            Creator's Notes
                        </span>
                        <button class="uishortcuts-gallery-notes-close" title="Close">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                    </div>
                    <div class="uishortcuts-gallery-notes-content"></div>
                </div>
            </div>
        `;

        document.body.appendChild(this.panel);

        // Initialize Gelbooru search if available
        if (GelbooruSearch) {
            this.gelbooru = new GelbooruSearch(this);
            const gelbooruTab = this.gelbooru.buildTabContent();
            const contentEl = this.panel.querySelector('.uishortcuts-gallery-content');
            contentEl.parentNode.insertBefore(gelbooruTab, contentEl.nextSibling);
        }

        // Initialize Set-as-background sub-module if available
        if (SetAsBackground) {
            this.setAsBg = new SetAsBackground(this);
        }

        this.bindEvents();
    }

    // ========================================
    // EVENT BINDING
    // ========================================

    bindEvents() {
        const closeBtn = this.panel.querySelector('.uishortcuts-gallery-close');
        const prevBtn = this.panel.querySelector('.uishortcuts-gallery-prev');
        const nextBtn = this.panel.querySelector('.uishortcuts-gallery-next');
        const notesBtn = this.panel.querySelector('.uishortcuts-gallery-notes');
        const notesCloseBtn = this.panel.querySelector('.uishortcuts-gallery-notes-close');
        const notesOverlay = this.panel.querySelector('.uishortcuts-gallery-notes-overlay');
        const gridBtn = this.panel.querySelector('.uishortcuts-gallery-grid');
        const mainImg = this.panel.querySelector('.uishortcuts-gallery-main-image');
        this._mainImgEl = mainImg;
        const imageWrapper = this.panel.querySelector('.uishortcuts-gallery-image-wrapper');
        const header = this.panel.querySelector('.uishortcuts-gallery-header');

        this.boundHandlers.onCloseClick = () => this.close();
        this.boundHandlers.onPrevClick = () => this.navigate(-1);
        this.boundHandlers.onNextClick = () => this.navigate(1);
        this.boundHandlers.onNotesClick = () => this.showCreatorNotes();
        this.boundHandlers.onNotesClose = () => this.hideCreatorNotes();
        this.boundHandlers.onNotesOverlay = (e) => {
            if (e.target.classList.contains('uishortcuts-gallery-notes-overlay')) {
                this.hideCreatorNotes();
            }
        };
        this.boundHandlers.onGridToggle = () => this.toggleGridView();
        this.boundHandlers.onImageClick = (e) => this.handleImageClick(e);
        this.boundHandlers.onImageMouseDown = (e) => this.startPan(e);
        this.boundHandlers.onPanMove = (e) => this.onPan(e);
        this.boundHandlers.onPanEnd = (e) => this.stopPan(e);
        this.boundHandlers.onWheel = (e) => this.handleZoom(e);
        this.boundHandlers.onDragStart = (e) => this.startDrag(e);
        this.boundHandlers.onDragMove = (e) => this.onDrag(e);
        this.boundHandlers.onDragEnd = () => this.stopDrag();
        this.boundHandlers.onKeydown = (e) => this.handleKeydown(e);
        this.boundHandlers.onPopState = (e) => this._onPopState(e);

        closeBtn.addEventListener('click', this.boundHandlers.onCloseClick);
        prevBtn.addEventListener('click', this.boundHandlers.onPrevClick);
        nextBtn.addEventListener('click', this.boundHandlers.onNextClick);
        notesBtn.addEventListener('click', this.boundHandlers.onNotesClick);
        notesCloseBtn.addEventListener('click', this.boundHandlers.onNotesClose);
        notesOverlay.addEventListener('click', this.boundHandlers.onNotesOverlay);
        gridBtn.addEventListener('click', this.boundHandlers.onGridToggle);
        mainImg.addEventListener('click', this.boundHandlers.onImageClick);
        mainImg.addEventListener('mousedown', this.boundHandlers.onImageMouseDown);
        document.addEventListener('mousemove', this.boundHandlers.onPanMove);
        document.addEventListener('mouseup', this.boundHandlers.onPanEnd);
        imageWrapper.addEventListener('wheel', this.boundHandlers.onWheel, { passive: false });
        header.addEventListener('mousedown', this.boundHandlers.onDragStart);
        document.addEventListener('mousemove', this.boundHandlers.onDragMove);
        document.addEventListener('mouseup', this.boundHandlers.onDragEnd);
        document.addEventListener('keydown', this.boundHandlers.onKeydown, true);
        window.addEventListener('popstate', this.boundHandlers.onPopState);

        this.setupDragAndDrop();
        if (GelbooruSearch) this.bindTabSwitching();
    }

    // ========================================
    // TAB SWITCHING
    // ========================================

    bindTabSwitching() {
        const toggleBtn = this.panel.querySelector('.uishortcuts-gallery-gelbooru-toggle');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => {
                this.switchTab(this.activeTab === 'local' ? 'gelbooru' : 'local');
            });
        }
    }

    switchTab(tabName, skipHistory = false) {
        this.activeTab = tabName;
        if (!skipHistory && tabName === 'gelbooru') this._pushHistoryState('gelbooru');

        // Update toggle button active state
        const toggleBtn = this.panel.querySelector('.uishortcuts-gallery-gelbooru-toggle');
        if (toggleBtn) toggleBtn.classList.toggle('active', tabName === 'gelbooru');

        // Toggle content visibility
        const localContent = this.panel.querySelector('.uishortcuts-gallery-content');
        const gelbooruContent = this.panel.querySelector('.uishortcuts-gelbooru-tab');
        const resizeHint = this.panel.querySelector('.uishortcuts-gallery-resize-hint');

        // Toggle header buttons visibility (grid & notes only apply to local tab)
        const gridBtn = this.panel.querySelector('.uishortcuts-gallery-grid');
        const notesBtn = this.panel.querySelector('.uishortcuts-gallery-notes');

        // Notify the set-as-bg sub-module so it hides its button on the gelbooru tab.
        this.setAsBg?.setActive(tabName === 'local');

        if (tabName === 'gelbooru') {
            localContent.style.display = 'none';
            gelbooruContent.style.display = 'flex';
            if (resizeHint) resizeHint.style.display = 'none';
            if (gridBtn) gridBtn.style.display = 'none';
            if (notesBtn) notesBtn.style.display = 'none';

            // Pre-populate search with character name
            if (this.currentCharacter?.name) {
                this.gelbooru.setCharacterName(this.currentCharacter.name);
            }

            // Focus the search input
            setTimeout(() => {
                const input = this.panel.querySelector('.uishortcuts-gelbooru-input');
                if (input) input.focus();
            }, 50);
        } else {
            localContent.style.display = '';
            gelbooruContent.style.display = 'none';
            if (resizeHint) resizeHint.style.display = '';
            if (gridBtn) gridBtn.style.display = '';
            if (notesBtn) notesBtn.style.display = '';
        }
    }

    handleImageClick(e) {
        // Ignore if we just finished panning
        if (this.wasPanning) {
            this.wasPanning = false;
            return;
        }
        // Reset zoom on click when already zoomed; otherwise no-op
        if (this.zoomLevel !== 1) {
            this.resetZoom();
        }
    }

    // ========================================
    // PANEL DRAGGING
    // ========================================

    startDrag(e) {
        if (e.target.closest('button')) return;
        this.isDragging = true;
        const rect = this.panel.getBoundingClientRect();
        this.dragOffset.x = e.clientX - rect.left;
        this.dragOffset.y = e.clientY - rect.top;
        this.panel.style.cursor = 'grabbing';
    }

    onDrag(e) {
        if (!this.isDragging) return;
        e.preventDefault();
        
        const x = e.clientX - this.dragOffset.x;
        const y = e.clientY - this.dragOffset.y;
        
        const maxX = window.innerWidth - this.panel.offsetWidth;
        const maxY = window.innerHeight - this.panel.offsetHeight;
        
        this.panel.style.left = `${Math.max(0, Math.min(x, maxX))}px`;
        this.panel.style.top = `${Math.max(0, Math.min(y, maxY))}px`;
        this.panel.style.right = 'auto';
        this.panel.style.bottom = 'auto';
    }

    stopDrag() {
        if (this.isDragging) {
            this.saveState();
        }
        this.isDragging = false;
        this.panel.style.cursor = '';
    }

    // ========================================
    // KEYBOARD HANDLING
    // ========================================

    handleKeydown(e) {
        if (!this.panel.classList.contains('active')) return;

        // Stop all keyboard events from reaching ST while the gallery is open
        // Both listeners are on document, so stopImmediatePropagation is needed
        e.stopImmediatePropagation();

        // Delegate to Gelbooru when its tab is active
        if (this.activeTab === 'gelbooru' && this.gelbooru) {
            if (this.gelbooru.handleKeydown(e)) {
                e.preventDefault();
                return;
            }
            // Escape closes panel if Gelbooru didn't consume it
            if (e.key === 'Escape') {
                this.close();
                e.preventDefault();
                return;
            }
            // Don't intercept other keys when Gelbooru tab is active
            // (user may be typing in search input)
            return;
        }
        
        // Check if creator notes overlay is visible
        const notesOverlay = this.panel.querySelector('.uishortcuts-gallery-notes-overlay');
        const notesVisible = notesOverlay && notesOverlay.classList.contains('active');
        
        switch(e.key) {
            case 'Escape':
                if (notesVisible) {
                    this.hideCreatorNotes();
                } else {
                    this.close();
                }
                e.preventDefault();
                break;
            case 'ArrowLeft':
                if (!e.target.matches('input, textarea')) {
                    this.navigate(-1);
                    e.preventDefault();
                }
                break;
            case 'ArrowRight':
                if (!e.target.matches('input, textarea')) {
                    this.navigate(1);
                    e.preventDefault();
                }
                break;
            case 'n':
            case 'N':
                if (!e.target.matches('input, textarea')) {
                    this.toggleCreatorNotes();
                    e.preventDefault();
                }
                break;
            case 'g':
            case 'G':
                if (!e.target.matches('input, textarea')) {
                    this.toggleGridView();
                    e.preventDefault();
                }
                break;
            case '+':
            case '=':
                if (!e.target.matches('input, textarea')) {
                    this.zoomLevel = Math.min(this.zoomMax, this.zoomLevel + 0.25);
                    this.applyZoom();
                    e.preventDefault();
                }
                break;
            case '-':
            case '_':
                if (!e.target.matches('input, textarea')) {
                    this.zoomLevel = Math.max(this.zoomMin, this.zoomLevel - 0.25);
                    this.applyZoom();
                    e.preventDefault();
                }
                break;
            case '0':
                if (!e.target.matches('input, textarea')) {
                    this.resetZoom();
                    e.preventDefault();
                }
                break;
            case 'Tab':
                if (GelbooruSearch && !e.target.matches('input, textarea, select')) {
                    this.switchTab(this.activeTab === 'local' ? 'gelbooru' : 'local');
                    e.preventDefault();
                }
                break;
        }
    }

    // ========================================
    // AVATAR CLICK INTERCEPTION
    // ========================================

    interceptAvatarClicks() {
        this.boundHandlers.onAvatarClick = (e) => {
            const avatar = e.target.closest('.avatar');
            if (!avatar) return;
            
            // Only intercept clicks on avatars within the chat area
            // This excludes character list, persona list, etc.
            const isInChatArea = avatar.closest('#chat') || 
                                 avatar.closest('.mes') || 
                                 avatar.closest('#avatar_div_for_chat');
            if (!isInChatArea) return;
            
            const avatarImg = avatar.querySelector('img') || (avatar.tagName === 'IMG' ? avatar : null);
            if (!avatarImg || !avatarImg.src) return;
            
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            
            this.collectAndShowImages(avatarImg.src, avatar, e);
        };
        document.body.addEventListener('click', this.boundHandlers.onAvatarClick, true);
    }

    // ========================================
    // IMAGE COLLECTION
    // ========================================

    async collectAndShowImages(clickedSrc, avatarElement, clickEvent) {
        const context = getSTContext();
        let characterName = 'Character';
        this.currentImages = [];
        
        let character = null;
        
        if (context) {
            const charId = context.characterId;
            if (charId !== undefined && charId !== null && context.characters) {
                character = context.characters[charId];
            }
            
            if (character) {
                characterName = character.name || 'Character';
                
                // Check if character changed - close notes overlay if so
                const characterChanged = this.currentCharacter?.avatar !== character.avatar;
                if (characterChanged) {
                    this.hideCreatorNotes();
                }
                
                this.currentCharacter = character;
                
                if (character.avatar) {
                    this.currentImages.push(getCharacterAvatarUrl(character.avatar));
                }
                
                await this.fetchCharacterGalleryImages(character);
            }
        }
        
        if (this.currentImages.length === 0) {
            this.currentImages.push(clickedSrc);
        }
        
        this.currentImages = [...new Set(this.currentImages)];
        this.panel.querySelector('.uishortcuts-gallery-char-name').textContent = characterName;

        const characterKey = character?.avatar || character?.name || clickedSrc;
        const preferredSrc = this.lastSelectedByCharacter.get(characterKey) || this.lastSelectedImage;
        const preferredIndex = preferredSrc ? this.currentImages.indexOf(preferredSrc) : -1;
        this.selectedIndex = preferredIndex >= 0 ? preferredIndex : 0;
        this.positionNearClick(clickEvent);
        this.open();
    }

    async fetchCharacterGalleryImages(character) {
        if (!character || !character.name) return;
        
        try {
            // Use the same folder resolution as uploads (respects ST's unique folder settings)
            const folderName = this.getGalleryFolderName(character);
            
            const response = await fetchWithCsrf('/api/images/list', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folder: folderName, type: 7 })
            });
            
            if (response.ok) {
                const files = await response.json();
                if (Array.isArray(files) && files.length > 0) {
                    for (const file of files) {
                        const fileName = (typeof file === 'string') ? file : file.name;
                        if (fileName && (isImageFile(fileName) || isVideoFile(fileName))) {
                            const imagePath = `/user/images/${encodeURIComponent(folderName)}/${encodeURIComponent(fileName)}`;
                            this.currentImages.push(imagePath);
                        }
                    }
                }
            }
        } catch (err) {
            log('Could not fetch gallery images: ' + err.message, 'warn');
        }
        
        // Check embedded assets
        if (character.data?.extensions?.assets) {
            const assets = character.data.extensions.assets;
            if (Array.isArray(assets)) {
                for (const asset of assets) {
                    if (asset.uri && (isImageFile(asset.uri) || isVideoFile(asset.uri))) {
                        this.currentImages.push(asset.uri);
                    }
                }
            }
        }
    }

    // ========================================
    // PANEL POSITIONING
    // ========================================

    positionNearClick(event) {
        const padding = 20;
        let x = event.clientX + padding;
        let y = event.clientY - 100;
        
        const panelWidth = 420;
        const panelHeight = 500;
        
        if (x + panelWidth > window.innerWidth) {
            x = event.clientX - panelWidth - padding;
        }
        if (y < padding) {
            y = padding;
        }
        if (y + panelHeight > window.innerHeight) {
            y = window.innerHeight - panelHeight - padding;
        }
        
        this.panel.style.left = `${Math.max(padding, x)}px`;
        this.panel.style.top = `${Math.max(padding, y)}px`;
        this.panel.style.right = 'auto';
        this.panel.style.bottom = 'auto';
    }

    // ========================================
    // PANEL OPEN/CLOSE
    // ========================================

    open() {
        this.restoreState();
        this.panel.classList.add('active');
        this.renderThumbnails();
        this.renderGridView();
        this.showImage(this.selectedIndex);
        this._pushHistoryState('gallery');
        
        if (!this.resizeObserver) {
            this.resizeObserver = new ResizeObserver(() => {
                if (this.panel.classList.contains('active')) {
                    this.saveState();
                }
            });
            this.resizeObserver.observe(this.panel);
        }
    }

    close() {
        this.saveState();
        this._cleanupVideo();
        this._cleanupLoaders();
        this.resetZoom();
        this.hideCreatorNotes();
        this.panel.classList.remove('active');
        this.panel.classList.remove('grid-mode');
        this.isGridView = false;

        // Reset Gelbooru state and switch back to local tab
        if (this.gelbooru) this.gelbooru.reset();
        if (this.activeTab !== 'local') this.switchTab('local', true);

        // Dismiss the set-as-bg popover (but keep the applier alive)
        this.setAsBg?.onGalleryClose();
    }

    _cleanupLoaders() {
        if (this._mainAbort) { this._mainAbort.abort(); this._mainAbort = null; }
        if (this._thumbLoader) { this._thumbLoader.destroy(); this._thumbLoader = null; }
        if (this._gridLoader) { this._gridLoader.destroy(); this._gridLoader = null; }
        this._preloaded.clear();
    }

    // ========================================
    // HISTORY / BACK BUTTON NAVIGATION
    // ========================================

    _pushHistoryState(view) {
        history.pushState({ uishortcutsGallery: view }, '');
    }

    _onPopState(e) {
        const state = e.state;
        // Only handle our own history entries
        if (!this.panel.classList.contains('active')) return;

        const galleryState = state?.uishortcutsGallery;

        // Back from gelbooru preview → close preview
        if (this.activeTab === 'gelbooru' && this.gelbooru?.previewPost) {
            this.gelbooru.closePreview();
            return;
        }

        // Back from gelbooru tab → return to local tab
        if (this.activeTab === 'gelbooru') {
            this.gelbooru?.reset();
            this.switchTab('local', true);
            return;
        }

        // Back from gallery → close gallery
        if (!galleryState || galleryState === 'gallery') {
            this.close();
        }
    }

    // ========================================
    // NAVIGATION
    // ========================================

    navigate(direction) {
        this.navigateWrap(direction);
    }

    navigateWrap(direction) {
        if (!this.currentImages.length) return;
        const length = this.currentImages.length;
        const newIndex = (this.selectedIndex + direction + length) % length;
        this.selectedIndex = newIndex;
        this.resetZoom();
        this.showImage(this.selectedIndex);
        this.updateThumbnailSelection();
        this.updateGridSelection();
    }

    showImage(index) {
        const loader = this.panel.querySelector('.uishortcuts-gallery-image-loader');
        const counter = this.panel.querySelector('.uishortcuts-gallery-counter');
        const src = this.currentImages[index];

        // Abort any in-flight main-image load from a prior navigation
        if (this._mainAbort) this._mainAbort.abort();
        const controller = new AbortController();
        this._mainAbort = controller;

        // Clean up any existing video before switching media
        this._cleanupVideo();

        if (isVideoFile(src)) {
            // --- VIDEO ---
            // Hide the static <img>; give the class to <video> so all zoom/pan code finds it
            this._mainImgEl.classList.remove('uishortcuts-gallery-main-image');
            this._mainImgEl.style.display = 'none';

            const video = document.createElement('video');
            video.className = 'uishortcuts-gallery-main-image';
            video.src = src;
            video.controls = true;
            video.autoplay = true;
            video.loop = true;
            video.muted = true;
            video.playsInline = true;

            // Reattach pan/click handlers so zoom and pan work on video too
            video.addEventListener('click', this.boundHandlers.onImageClick);
            video.addEventListener('mousedown', this.boundHandlers.onImageMouseDown);

            loader.before(video);
            this._videoEl = video;
            loader.classList.remove('active');
        } else {
            // --- IMAGE ---
            const mainImg = this._mainImgEl;

            // If we preloaded this one, use the decoded Image directly — instant swap
            const preloaded = this._preloaded.get(index);
            if (preloaded && preloaded.src === src && preloaded.complete && preloaded.naturalWidth > 0) {
                mainImg.src = src;
                mainImg.style.opacity = '1';
                loader.classList.remove('active');
            } else {
                // Show spinner over the currently displayed image while loading
                loader.classList.add('active');
                const img = new Image();
                img.decoding = 'async';
                img.src = src;

                // Use decode() for smooth transition — swap only once decoded
                img.decode().then(() => {
                    if (controller.signal.aborted) return;
                    mainImg.src = src;
                    mainImg.style.opacity = '1';
                    loader.classList.remove('active');
                }).catch(() => {
                    if (controller.signal.aborted) return;
                    // decode() failed — swap anyway so the browser can try rendering
                    mainImg.src = src;
                    mainImg.style.opacity = '0.5';
                    loader.classList.remove('active');
                });
            }
        }

        const characterKey = this.currentCharacter?.avatar || this.currentCharacter?.name;
        this.lastSelectedImage = this.currentImages[index];
        if (characterKey) {
            this.lastSelectedByCharacter.set(characterKey, this.currentImages[index]);
        }

        // Notify sub-modules that the current image changed
        this.setAsBg?.onImageChanged(src);

        counter.textContent = `${index + 1} / ${this.currentImages.length}`;

        const prevBtn = this.panel.querySelector('.uishortcuts-gallery-prev');
        const nextBtn = this.panel.querySelector('.uishortcuts-gallery-next');
        prevBtn.disabled = false;
        nextBtn.disabled = false;

        // Preload neighbours for smooth prev/next navigation
        this._preloadAdjacent(index);
    }

    /**
     * Preload the images immediately before and after `index`, and evict
     * any cached preloads that are no longer neighbours. Only images are
     * preloaded (video is skipped — they're too heavy to preload blindly).
     */
    _preloadAdjacent(index) {
        const total = this.currentImages.length;
        if (total <= 1) return;

        const keep = new Set([index, (index + 1) % total, (index - 1 + total) % total]);
        // Evict old entries
        for (const k of this._preloaded.keys()) {
            if (!keep.has(k)) this._preloaded.delete(k);
        }

        const warm = (i) => {
            if (this._preloaded.has(i)) return;
            const src = this.currentImages[i];
            if (!src || isVideoFile(src)) return;
            const img = new Image();
            img.decoding = 'async';
            img.src = src;
            this._preloaded.set(i, img);
        };
        warm((index + 1) % total);
        warm((index - 1 + total) % total);
    }

    _cleanupVideo() {
        if (!this._videoEl) return;
        this._videoEl.pause();
        this._videoEl.removeAttribute('src');
        this._videoEl.load(); // Release media resources
        this._videoEl.removeEventListener('click', this.boundHandlers.onImageClick);
        this._videoEl.removeEventListener('mousedown', this.boundHandlers.onImageMouseDown);
        this._videoEl.remove();
        this._videoEl = null;
        // Restore the persistent <img> element
        if (this._mainImgEl) {
            this._mainImgEl.classList.add('uishortcuts-gallery-main-image');
            this._mainImgEl.style.display = '';
        }
    }

    // ========================================
    // THUMBNAILS
    // ========================================

    /**
     * Build a tile DOM element for both strip thumbnails and grid items.
     * Returns the tile element; lazy-loading happens when the tile enters
     * the viewport (attached to a LazyMediaLoader observer).
     */
    _buildTile(src, index, variant) {
        const tile = document.createElement('div');
        tile.className = `uishortcuts-gallery-tile uishortcuts-gallery-tile-${variant} uishortcuts-gallery-tile-loading`;
        tile.dataset.src = src;
        tile.dataset.kind = isVideoFile(src) ? 'video' : 'image';
        tile.dataset.index = String(index);
        if (index === this.selectedIndex) tile.classList.add('active');

        // Transparent placeholder to reserve space + hold future src
        const img = document.createElement('img');
        img.alt = `${variant === 'strip' ? 'Thumbnail' : 'Image'} ${index + 1}`;
        img.decoding = 'async';
        img.draggable = false;
        // 1×1 transparent SVG placeholder (no network request)
        img.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>';
        tile.appendChild(img);

        if (isVideoFile(src)) {
            const badge = document.createElement('div');
            badge.className = 'uishortcuts-gallery-tile-badge';
            badge.innerHTML = '<i class="fa-solid fa-play"></i>';
            tile.appendChild(badge);
        }

        return tile;
    }

    renderThumbnails() {
        const container = this.panel.querySelector('.uishortcuts-gallery-thumbnails-scroll');
        const thumbnailsSection = this.panel.querySelector('.uishortcuts-gallery-thumbnails');

        // Tear down previous loader
        if (this._thumbLoader) this._thumbLoader.destroy();
        container.innerHTML = '';

        if (this.currentImages.length <= 1) {
            thumbnailsSection.style.display = 'none';
            return;
        }
        thumbnailsSection.style.display = '';

        this._thumbLoader = new LazyMediaLoader({ root: container, rootMargin: '300px', maxActive: 6 });

        this.currentImages.forEach((src, index) => {
            const tile = this._buildTile(src, index, 'strip');
            tile.addEventListener('click', () => {
                this.selectedIndex = index;
                this.resetZoom();
                this.showImage(index);
                this.updateThumbnailSelection();
            });
            container.appendChild(tile);
            this._thumbLoader.observe(tile);
        });
    }

    updateThumbnailSelection() {
        const tiles = this.panel.querySelectorAll('.uishortcuts-gallery-tile-strip');
        tiles.forEach((tile, index) => {
            tile.classList.toggle('active', index === this.selectedIndex);
        });

        const activeThumb = this.panel.querySelector('.uishortcuts-gallery-tile-strip.active');
        if (activeThumb) {
            activeThumb.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }
    }

    // ========================================
    // GRID VIEW
    // ========================================

    toggleGridView() {
        this.isGridView = !this.isGridView;
        this.panel.classList.toggle('grid-mode', this.isGridView);

        const gridBtn = this.panel.querySelector('.uishortcuts-gallery-grid i');
        gridBtn.className = this.isGridView ? 'fa-solid fa-image' : 'fa-solid fa-grip';
    }

    renderGridView() {
        const container = this.panel.querySelector('.uishortcuts-gallery-grid-scroll');

        // Tear down previous loader
        if (this._gridLoader) this._gridLoader.destroy();
        container.innerHTML = '';

        this._gridLoader = new LazyMediaLoader({ root: container, rootMargin: '400px', maxActive: 6 });

        this.currentImages.forEach((src, index) => {
            const tile = this._buildTile(src, index, 'grid');
            tile.addEventListener('click', () => {
                this.selectedIndex = index;
                this.showImage(index);
                this.updateThumbnailSelection();
                this.updateGridSelection();
                if (this.isGridView) this.toggleGridView();
            });
            container.appendChild(tile);
            this._gridLoader.observe(tile);
        });
    }

    updateGridSelection() {
        const tiles = this.panel.querySelectorAll('.uishortcuts-gallery-tile-grid');
        tiles.forEach((tile, index) => {
            tile.classList.toggle('active', index === this.selectedIndex);
        });
    }

    // ========================================
    // CREATOR'S NOTES
    // ========================================

    showCreatorNotes() {
        if (!this.currentCharacter) return;
        
        const overlay = this.panel.querySelector('.uishortcuts-gallery-notes-overlay');
        const content = this.panel.querySelector('.uishortcuts-gallery-notes-content');
        
        // Get creator notes from character data
        const creatorNotes = this.currentCharacter.data?.creator_notes || 
                            this.currentCharacter.creator_notes || 
                            '';
        
        if (!creatorNotes.trim()) {
            content.innerHTML = '<div class="uishortcuts-gallery-notes-empty"><i class="fa-solid fa-file-circle-question"></i><p>No creator\'s notes available for this character.</p></div>';
        } else {
            // Render the notes with full HTML support
            content.innerHTML = `<div class="uishortcuts-gallery-notes-body">${creatorNotes}</div>`;
        }
        
        overlay.classList.add('active');
        
        // Update button state
        const notesBtn = this.panel.querySelector('.uishortcuts-gallery-notes');
        if (notesBtn) notesBtn.classList.add('active');
    }

    hideCreatorNotes() {
        const overlay = this.panel.querySelector('.uishortcuts-gallery-notes-overlay');
        overlay.classList.remove('active');
        
        // Update button state
        const notesBtn = this.panel.querySelector('.uishortcuts-gallery-notes');
        if (notesBtn) notesBtn.classList.remove('active');
    }

    toggleCreatorNotes() {
        const overlay = this.panel.querySelector('.uishortcuts-gallery-notes-overlay');
        if (overlay.classList.contains('active')) {
            this.hideCreatorNotes();
        } else {
            this.showCreatorNotes();
        }
    }

    // ========================================
    // ZOOM & PAN
    // ========================================

    handleZoom(e) {
        e.preventDefault();
        
        const delta = e.deltaY > 0 ? -0.15 : 0.15;
        const newZoom = Math.max(this.zoomMin, Math.min(this.zoomMax, this.zoomLevel + delta));
        
        if (newZoom !== this.zoomLevel) {
            this.zoomLevel = newZoom;
            this.applyZoom();
        }
    }

    applyZoom() {
        const mainImg = this.panel.querySelector('.uishortcuts-gallery-main-image');
        mainImg.style.transform = `translate(${this.panOffset.x}px, ${this.panOffset.y}px) scale(${this.zoomLevel})`;
        mainImg.classList.toggle('zoomed', this.zoomLevel > 1);
        
        if (this.zoomLevel <= 1) {
            this.panOffset = { x: 0, y: 0 };
            mainImg.style.transform = `scale(${this.zoomLevel})`;
        }
    }

    resetZoom() {
        this.zoomLevel = 1;
        this.panOffset = { x: 0, y: 0 };
        const mainImg = this.panel.querySelector('.uishortcuts-gallery-main-image');
        mainImg.style.transform = 'scale(1)';
        mainImg.classList.remove('zoomed');
    }

    startPan(e) {
        if (this.zoomLevel <= 1) return;
        e.preventDefault();
        this.isPanning = true;
        this.panStart.x = e.clientX - this.panOffset.x;
        this.panStart.y = e.clientY - this.panOffset.y;
    }

    onPan(e) {
        if (!this.isPanning) return;
        e.preventDefault();
        
        this.panOffset.x = e.clientX - this.panStart.x;
        this.panOffset.y = e.clientY - this.panStart.y;
        
        const mainImg = this.panel.querySelector('.uishortcuts-gallery-main-image');
        mainImg.style.transform = `translate(${this.panOffset.x}px, ${this.panOffset.y}px) scale(${this.zoomLevel})`;
    }

    stopPan(e) {
        if (this.isPanning) {
            this.wasPanning = true;
        }
        this.isPanning = false;
    }

    // ========================================
    // DRAG AND DROP UPLOAD
    // ========================================

    setupDragAndDrop() {
        const content = this.panel.querySelector('.uishortcuts-gallery-content');

        this.boundHandlers.onDragEnter = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (this.currentCharacter) {
                content.classList.add('drag-over');
            }
        };
        this.boundHandlers.onDragOver = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (this.currentCharacter) {
                content.classList.add('drag-over');
            }
        };
        this.boundHandlers.onDragLeave = (e) => {
            e.preventDefault();
            e.stopPropagation();
            content.classList.remove('drag-over');
        };
        this.boundHandlers.onDrop = (e) => {
            e.preventDefault();
            e.stopPropagation();
            content.classList.remove('drag-over');
            this.handleFileDrop(e);
        };

        content.addEventListener('dragenter', this.boundHandlers.onDragEnter);
        content.addEventListener('dragover', this.boundHandlers.onDragOver);
        content.addEventListener('dragleave', this.boundHandlers.onDragLeave);
        content.addEventListener('drop', this.boundHandlers.onDrop);
    }

    async handleFileDrop(e) {
        if (!this.currentCharacter) {
            log('No character selected for media upload', 'warn');
            return;
        }
        
        const files = e.dataTransfer?.files;
        if (!files || files.length === 0) return;
        
        // Filter to image and video files
        const mediaFiles = Array.from(files).filter(file => 
            file.type.startsWith('image/') || file.type.startsWith('video/') ||
            isImageFile(file.name) || isVideoFile(file.name)
        );
        
        if (mediaFiles.length === 0) {
            log('No image or video files detected in drop', 'warn');
            return;
        }
        
        // Show loading state
        const loader = this.panel.querySelector('.uishortcuts-gallery-image-loader');
        loader.classList.add('active');
        
        try {
            const results = await this.uploadImages(mediaFiles);
            
            if (results.success > 0) {
                log(`Uploaded ${results.success} file(s) to gallery`);
                // Refresh the gallery to show new files
                await this.refreshGallery();
            }
            
            if (results.errors > 0) {
                log(`Failed to upload ${results.errors} file(s)`, 'warn');
            }
        } catch (err) {
            log('Error uploading media: ' + err.message, 'error');
        } finally {
            loader.classList.remove('active');
        }
    }

    /**
     * Get the gallery folder name for a character
     * Checks ST's extensionSettings for custom folder overrides (e.g., unique gallery folders)
     * Falls back to sanitized character name
     * @param {object} char - Character object
     * @returns {string} The folder name to use for ch_name parameter
     */
    getGalleryFolderName(char) {
        if (!char) return '';
        
        const context = getSTContext();
        
        // Check if ST has a custom folder override for this character (unique gallery folders)
        const folderOverride = context?.extensionSettings?.gallery?.folders?.[char.avatar];
        if (folderOverride) {
            return folderOverride;
        }
        
        // Fall back to sanitized character name
        return sanitizeFolderName(char.name || '');
    }

    async uploadImages(files) {
        const results = { success: 0, errors: 0 };
        
        // Get the correct gallery folder name (respects ST's unique folder settings)
        const folderName = this.getGalleryFolderName(this.currentCharacter);
        
        for (const file of files) {
            try {
                // Convert file to base64 (strip data URL prefix)
                const base64DataUrl = await toBase64(file);
                const base64Data = base64DataUrl.split(',')[1];
                
                // Get file extension/format
                const extension = file.name.split('.').pop().toLowerCase();
                const format = extension === 'jpg' ? 'jpeg' : extension;
                
                // Get filename without extension
                const filename = file.name.replace(/\.[^/.]+$/, '');
                
                const response = await fetchWithCsrf('/api/images/upload', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        image: base64Data,
                        format: format,
                        filename: filename,
                        ch_name: folderName
                    })
                });
                
                if (response.ok) {
                    results.success++;
                } else {
                    results.errors++;
                    const errorText = await response.text().catch(() => '');
                    log(`Failed to upload ${file.name}: ${response.status} ${errorText}`, 'warn');
                }
            } catch (err) {
                results.errors++;
                log(`Error uploading ${file.name}: ${err.message}`, 'warn');
            }
        }
        
        return results;
    }

    async refreshGallery() {
        if (!this.currentCharacter) return;
        
        // Remember current selection
        const currentSrc = this.currentImages[this.selectedIndex];
        
        // Re-fetch images
        this.currentImages = [];
        
        if (this.currentCharacter.avatar) {
            this.currentImages.push(getCharacterAvatarUrl(this.currentCharacter.avatar));
        }
        
        await this.fetchCharacterGalleryImages(this.currentCharacter);
        this.currentImages = [...new Set(this.currentImages)];
        
        // Try to restore selection, or default to last image (newest upload)
        const newIndex = this.currentImages.indexOf(currentSrc);
        this.selectedIndex = newIndex >= 0 ? newIndex : Math.max(0, this.currentImages.length - 1);
        
        // Re-render
        this.renderThumbnails();
        this.renderGridView();
        this.showImage(this.selectedIndex);
    }

    // ========================================
    // CLEANUP
    // ========================================

    destroy() {
        this._cleanupVideo();
        this._cleanupLoaders();
        if (this.mobileCleanup) {
            this.mobileCleanup();
        }
        if (this.gelbooru) {
            this.gelbooru.destroy();
            this.gelbooru = null;
        }
        if (this.setAsBg) {
            this.setAsBg.destroy();
            this.setAsBg = null;
        }
        if (this.panel) {
            const closeBtn = this.panel.querySelector('.uishortcuts-gallery-close');
            const prevBtn = this.panel.querySelector('.uishortcuts-gallery-prev');
            const nextBtn = this.panel.querySelector('.uishortcuts-gallery-next');
            const notesBtn = this.panel.querySelector('.uishortcuts-gallery-notes');
            const notesCloseBtn = this.panel.querySelector('.uishortcuts-gallery-notes-close');
            const notesOverlay = this.panel.querySelector('.uishortcuts-gallery-notes-overlay');
            const gridBtn = this.panel.querySelector('.uishortcuts-gallery-grid');
            const mainImg = this._mainImgEl;
            const imageWrapper = this.panel.querySelector('.uishortcuts-gallery-image-wrapper');
            const header = this.panel.querySelector('.uishortcuts-gallery-header');
            const content = this.panel.querySelector('.uishortcuts-gallery-content');

            closeBtn?.removeEventListener('click', this.boundHandlers.onCloseClick);
            prevBtn?.removeEventListener('click', this.boundHandlers.onPrevClick);
            nextBtn?.removeEventListener('click', this.boundHandlers.onNextClick);
            notesBtn?.removeEventListener('click', this.boundHandlers.onNotesClick);
            notesCloseBtn?.removeEventListener('click', this.boundHandlers.onNotesClose);
            notesOverlay?.removeEventListener('click', this.boundHandlers.onNotesOverlay);
            gridBtn?.removeEventListener('click', this.boundHandlers.onGridToggle);
            mainImg?.removeEventListener('click', this.boundHandlers.onImageClick);
            mainImg?.removeEventListener('mousedown', this.boundHandlers.onImageMouseDown);
            imageWrapper?.removeEventListener('wheel', this.boundHandlers.onWheel);
            header?.removeEventListener('mousedown', this.boundHandlers.onDragStart);

            content?.removeEventListener('dragenter', this.boundHandlers.onDragEnter);
            content?.removeEventListener('dragover', this.boundHandlers.onDragOver);
            content?.removeEventListener('dragleave', this.boundHandlers.onDragLeave);
            content?.removeEventListener('drop', this.boundHandlers.onDrop);
        }
        document.removeEventListener('mousemove', this.boundHandlers.onPanMove);
        document.removeEventListener('mouseup', this.boundHandlers.onPanEnd);
        document.removeEventListener('mousemove', this.boundHandlers.onDragMove);
        document.removeEventListener('mouseup', this.boundHandlers.onDragEnd);
        document.removeEventListener('keydown', this.boundHandlers.onKeydown, true);
        window.removeEventListener('popstate', this.boundHandlers.onPopState);
        document.body.removeEventListener('click', this.boundHandlers.onAvatarClick, true);
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
        }
        if (this.panel && this.panel.parentNode) {
            this.panel.parentNode.removeChild(this.panel);
        }
    }
}

// Export a factory function for initialization
export function initAvatarGallery() {
    return new AvatarGallerySelector();
}

export const definition = {
    key: 'avatarGallery',
    label: 'Avatar Gallery',
    description: 'Replaces avatar clicks with a gallery that supports browsing, zoom, and uploads.',
    init: initAvatarGallery,
    ...(GelbooruSearch ? {
        settings: {
            defaults: {
                apiKey: '',
                defaultRating: 'general',
                resultsPerPage: 40,
            },
            render: () => `
                <div class="uishortcuts-plugin-banner uishortcuts-hidden">
                    <i class="fa-solid fa-puzzle-piece"></i>
                    <div>
                        <strong>uishortcuts-helper plugin required</strong>
                        <span>Gelbooru search requires the uishortcuts-helper server plugin to proxy requests. Install it in SillyTavern's <code>plugins/</code> folder and enable <code>enableServerPlugins</code> in config.yaml.</span>
                    </div>
                </div>
                <div class="uishortcuts-gelbooru-fields">
                    <small style="display:block; margin-bottom:6px; opacity:0.7;">
                        <i class="fa-solid fa-image"></i> Gelbooru Search — free API key from
                        <a href="https://gelbooru.com/index.php?page=account&s=options" target="_blank" rel="noopener"
                           style="color: var(--SmartThemeQuoteColor, #4a9eff);">your account page</a>
                    </small>
                    <label class="uishortcuts-setting-label">
                        API Credentials <small style="opacity:0.6">(paste from Gelbooru account page)</small>
                        <input type="text" data-key="apiKey"
                               placeholder="&api_key=…&user_id=…"
                               style="width:100%; margin-top:2px;" />
                    </label>
                </div>
            `,
            hydrate: async (container, values) => {
                const input = container.querySelector('[data-key="apiKey"]');
                if (input) input.value = values.apiKey || '';

                // Check uishortcuts-helper plugin availability
                const banner = container.querySelector('.uishortcuts-plugin-banner');
                const fields = container.querySelector('.uishortcuts-gelbooru-fields');
                if (!banner || !fields) return;

                // On TauriTavern the manifest's tt_permissions.network grant
                // replaces the helper plugin entirely, so there is nothing to
                // install and nothing to probe.
                if (hasNativeTransport()) {
                    banner.classList.remove('uishortcuts-hidden');
                    banner.classList.add('uishortcuts-plugin-ok');
                    banner.querySelector('i').className = 'fa-solid fa-circle-check';
                    banner.querySelector('strong').textContent = 'Native network access granted';
                    banner.querySelector('span').textContent =
                        'TauriTavern is proxying Gelbooru requests through the host. No server plugin needed.';
                    fields.classList.remove('uishortcuts-fields-disabled');
                    return;
                }

                let available = false;
                try {
                    const resp = await fetchWithCsrf('/api/plugins/uishortcuts-helper/health');
                    if (resp.ok) {
                        const data = await resp.json();
                        available = data?.ok === true;
                    }
                } catch { /* plugin not reachable */ }

                if (available) {
                    banner.classList.remove('uishortcuts-hidden');
                    banner.classList.add('uishortcuts-plugin-ok');
                    banner.querySelector('i').className = 'fa-solid fa-circle-check';
                    banner.querySelector('strong').textContent = 'uishortcuts-helper plugin detected';
                    banner.querySelector('span').textContent = 'Gelbooru search proxy is available.';
                    fields.classList.remove('uishortcuts-fields-disabled');
                } else {
                    banner.classList.remove('uishortcuts-hidden');
                    fields.classList.add('uishortcuts-fields-disabled');
                }
            },
        },
    } : {}),
};
