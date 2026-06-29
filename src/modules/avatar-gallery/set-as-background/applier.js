/**
 * SillyTavern UI Shortcuts - Background Applier
 *
 * Owns all DOM/CSS side-effects for the "set as background" sub-module:
 *   - Injects a scoped stylesheet that drives #bg1 and a #chat overlay layer via CSS vars
 *   - Applies / clears state per call (no implicit re-apply — caller decides timing)
 *
 * State shape (all fields optional except `src` + `targets`):
 *   {
 *     src:        string,                          // image URL
 *     targets:    Array<'page' | 'chat'>,
 *     fit:        'cover' | 'contain' | 'stretch' | 'center' | 'tile',
 *     opacity:    number (0..1),
 *     blur:       number (px),
 *     brightness: number (0..2),
 *   }
 */

import { isAstraLoaded } from '../../../utils.js';

const STYLE_ID = 'uishortcuts-bg-styles';
const CHAT_LAYER_ID = 'uishortcuts-chat-bg-layer';
const BG_OVERRIDE_CLASS = 'uishortcuts-bg-override';
const CHAT_HOST_CLASS = 'uishortcuts-bg-host';

const FIT_TO_BG_SIZE = {
    cover:   { size: 'cover',   repeat: 'no-repeat' },
    contain: { size: 'contain', repeat: 'no-repeat' },
    stretch: { size: '100% 100%', repeat: 'no-repeat' },
    center:  { size: 'auto',    repeat: 'no-repeat' },
    tile:    { size: 'auto',    repeat: 'repeat'    },
};

function buildStylesheet(astra) {
    const pageFilter = astra
        ? ''
        : `filter: blur(var(--uishortcuts-bg-page-blur, 0px))
            brightness(var(--uishortcuts-bg-page-brightness, 1)) !important;`;

    const chatAppearance = astra
        ? ''
        : `opacity: var(--uishortcuts-bg-chat-opacity, 1);
    filter: blur(var(--uishortcuts-bg-chat-blur, 0px))
            brightness(var(--uishortcuts-bg-chat-brightness, 1));`;

    return `
#bg1.${BG_OVERRIDE_CLASS} {
    background-image: var(--uishortcuts-bg-page-image) !important;
    background-size: var(--uishortcuts-bg-page-size, cover) !important;
    background-repeat: var(--uishortcuts-bg-page-repeat, no-repeat) !important;
    background-position: center !important;
    ${pageFilter}
}

#chat.${CHAT_HOST_CLASS} {
    position: relative;
}

#${CHAT_LAYER_ID} {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 0;
    background-image: var(--uishortcuts-bg-chat-image, none);
    background-size: var(--uishortcuts-bg-chat-size, cover);
    background-repeat: var(--uishortcuts-bg-chat-repeat, no-repeat);
    background-position: center;
    ${chatAppearance}
}

#chat.${CHAT_HOST_CLASS} > *:not(#${CHAT_LAYER_ID}) {
    position: relative;
    z-index: 1;
}
`;
}

export class BackgroundApplier {
    constructor() {
        this._styleEl = null;
        this._chatLayer = null;
        this._lastState = null;
        this._ensureStylesheet();
    }

    _ensureStylesheet() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = buildStylesheet(isAstraLoaded());
        document.head.appendChild(style);
        this._styleEl = style;
    }

    _ensureChatLayer() {
        const chat = document.getElementById('chat');
        if (!chat) return null;
        chat.classList.add(CHAT_HOST_CLASS);
        let layer = document.getElementById(CHAT_LAYER_ID);
        if (!layer) {
            layer = document.createElement('div');
            layer.id = CHAT_LAYER_ID;
            chat.insertBefore(layer, chat.firstChild);
        }
        this._chatLayer = layer;
        return layer;
    }

    _removeChatLayer() {
        const chat = document.getElementById('chat');
        if (chat) chat.classList.remove(CHAT_HOST_CLASS);
        const layer = document.getElementById(CHAT_LAYER_ID);
        if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
        this._chatLayer = null;
    }

    /**
     * Apply a background state to the configured targets. Clears state for
     * any target not listed in `targets`. Passing falsy state or empty targets
     * results in a full clear.
     */
    apply(state) {
        this._lastState = state || null;

        if (!state || !state.src || !Array.isArray(state.targets) || state.targets.length === 0) {
            this.clear();
            return;
        }

        const cssUrl = `url("${state.src.replace(/"/g, '\\"')}")`;
        const fit = FIT_TO_BG_SIZE[state.fit] || FIT_TO_BG_SIZE.cover;
        const astra = isAstraLoaded();
        const opacity = clamp(state.opacity ?? 1, 0, 1);
        const blurPx = Math.max(0, state.blur ?? 0);
        const brightness = clamp(state.brightness ?? 1, 0, 2);

        const root = document.documentElement;
        const bg1 = document.getElementById('bg1');

        // ── Page bg target ─────────────────────────────────
        if (state.targets.includes('page') && bg1) {
            root.style.setProperty('--uishortcuts-bg-page-image', cssUrl);
            root.style.setProperty('--uishortcuts-bg-page-size', fit.size);
            root.style.setProperty('--uishortcuts-bg-page-repeat', fit.repeat);
            if (!astra) {
                root.style.setProperty('--uishortcuts-bg-page-blur', `${blurPx}px`);
                root.style.setProperty('--uishortcuts-bg-page-brightness', String(brightness));
            }
            bg1.classList.add(BG_OVERRIDE_CLASS);
        } else if (bg1) {
            bg1.classList.remove(BG_OVERRIDE_CLASS);
            this._clearPageVars();
        }

        // ── Chat overlay target ────────────────────────────
        if (state.targets.includes('chat')) {
            this._ensureChatLayer();
            root.style.setProperty('--uishortcuts-bg-chat-image', cssUrl);
            root.style.setProperty('--uishortcuts-bg-chat-size', fit.size);
            root.style.setProperty('--uishortcuts-bg-chat-repeat', fit.repeat);
            if (!astra) {
                root.style.setProperty('--uishortcuts-bg-chat-opacity', String(opacity));
                root.style.setProperty('--uishortcuts-bg-chat-blur', `${blurPx}px`);
                root.style.setProperty('--uishortcuts-bg-chat-brightness', String(brightness));
            }
        } else {
            this._removeChatLayer();
            this._clearChatVars();
        }
    }

    clear() {
        const bg1 = document.getElementById('bg1');
        if (bg1) bg1.classList.remove(BG_OVERRIDE_CLASS);
        this._clearPageVars();
        this._removeChatLayer();
        this._clearChatVars();
        this._lastState = null;
    }

    _clearPageVars() {
        const root = document.documentElement;
        root.style.removeProperty('--uishortcuts-bg-page-image');
        root.style.removeProperty('--uishortcuts-bg-page-size');
        root.style.removeProperty('--uishortcuts-bg-page-repeat');
        root.style.removeProperty('--uishortcuts-bg-page-blur');
        root.style.removeProperty('--uishortcuts-bg-page-brightness');
    }

    _clearChatVars() {
        const root = document.documentElement;
        root.style.removeProperty('--uishortcuts-bg-chat-image');
        root.style.removeProperty('--uishortcuts-bg-chat-size');
        root.style.removeProperty('--uishortcuts-bg-chat-repeat');
        root.style.removeProperty('--uishortcuts-bg-chat-opacity');
        root.style.removeProperty('--uishortcuts-bg-chat-blur');
        root.style.removeProperty('--uishortcuts-bg-chat-brightness');
    }

    /** Currently-applied state, or null if nothing is applied. */
    getLastState() {
        return this._lastState;
    }

    destroy() {
        this.clear();
        if (this._styleEl && this._styleEl.parentNode) {
            this._styleEl.parentNode.removeChild(this._styleEl);
        }
        this._styleEl = null;
    }
}

function clamp(n, min, max) {
    return Math.max(min, Math.min(max, Number(n)));
}
