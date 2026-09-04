/**
 * Character Tagline Module
 * Reads the tagline from any provider namespace under character.data.extensions
 * and displays it in the character management panel (position configurable in settings).
 * Taglines authored on Chub/CharacterTavern routinely carry inline HTML, so the value is
 * rendered through DOMPurify when rich text is on and shown as plain text otherwise.
 */

import { log, getSTContext } from '../../utils.js';

const TAGLINE_ID = 'uishortcuts-char-tagline';

// Insertion targets by position setting
const POSITIONS = {
    'below-name':  { target: '#rm_PinAndTabs', method: 'after' },
    'above-notes': { target: '#spoiler_free_desc', method: 'before' },
};

// Formatting a card author may use in a tagline. Anything that executes, loads a remote
// resource, or takes input is left out; DOMPurify strips the rest with the event handlers.
const ALLOWED_TAGS = [
    'p', 'br', 'hr', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'del',
    'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'center', 'font', 'small', 'sub', 'sup',
];
const ALLOWED_ATTR = ['class', 'style', 'color', 'size', 'align', 'title'];

const HTML_RE = /<[a-z][\s\S]*>/i;

const CLASS_CLAMPED = 'uishortcuts-char-tagline--clamped';
const CLASS_EXPANDED = 'uishortcuts-char-tagline--expanded';
// Sub-pixel line heights make scrollHeight overshoot clientHeight by a fraction on content
// that actually fits; a couple of pixels of slack avoids clamping those.
const CLAMP_TOLERANCE_PX = 2;

function _getPosition() {
    const ctx = getSTContext();
    return ctx?.extensionSettings?.UIShortcuts?.charTagline?.position || 'below-name';
}

function _getRichText() {
    const ctx = getSTContext();
    return ctx?.extensionSettings?.UIShortcuts?.charTagline?.richText !== false;
}

function _getTagline(char) {
    const ext = char?.data?.extensions;
    if (!ext) return null;
    // CharacterLibrary writes the tagline under the linked provider's id (janitorai, wyvern,
    // botbooru, ...) and only falls back to 'cl' when unlinked, so scan every namespace
    // rather than enumerating them. Known sources keep priority.
    return ext.chub?.tagline
        || ext.chartavern?.tagline
        || ext.cl?.tagline
        || Object.values(ext).find(v => typeof v?.tagline === 'string' && v.tagline)?.tagline
        || null;
}

function _setContent(el, tagline) {
    // Plain taglines and the rich-text-off case never touch innerHTML.
    if (!_getRichText() || !HTML_RE.test(tagline)) {
        el.textContent = tagline;
        return;
    }

    // Fail closed: with no sanitizer available the card's markup is shown as text, not injected.
    const purify = globalThis.DOMPurify;
    if (typeof purify?.sanitize !== 'function') {
        el.textContent = tagline;
        return;
    }

    el.innerHTML = purify.sanitize(tagline, {
        ALLOWED_TAGS,
        ALLOWED_ATTR,
        FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea', 'style', 'link', 'img', 'a'],
        FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover', 'href', 'src'],
        ALLOW_UNKNOWN_PROTOCOLS: false,
        KEEP_CONTENT: true,
    });
}

export class CharTagline {
    constructor() {
        this._el = null;
        this._eventHandler = null;
        this._observer = null;

        this._listen();
        this._update();
    }

    _listen() {
        const ctx = getSTContext();
        if (!ctx?.eventSource) {
            this._watchDOM();
            return;
        }

        this._eventHandler = () => this._update();
        ctx.eventSource.on('character_editor_opened', this._eventHandler);
        ctx.eventSource.on('character_edited', this._eventHandler);
    }

    _watchDOM() {
        this._observer = new MutationObserver(() => {
            const panel = document.querySelector('#right-nav-panel.openDrawer');
            if (panel) this._update();
        });
        this._observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    }

    _update() {
        const ctx = getSTContext();
        const char = ctx?.characters?.[ctx?.characterId];
        const tagline = _getTagline(char);

        if (!tagline) {
            this._remove();
            return;
        }

        this._render(tagline);
    }

    _render(tagline) {
        const pos = _getPosition();
        const config = POSITIONS[pos] || POSITIONS['below-name'];
        const target = document.querySelector(config.target);
        if (!target) return;

        let el = document.getElementById(TAGLINE_ID);

        // If element exists but is in the wrong position, remove and re-create
        if (el) {
            const correctParent = config.method === 'after'
                ? target.nextElementSibling === el || target.parentElement.contains(el)
                : target.previousElementSibling === el;
            if (!correctParent) {
                el.remove();
                el = null;
            }
        }

        if (!el) {
            el = document.createElement('div');
            el.id = TAGLINE_ID;
            el.className = 'uishortcuts-char-tagline';
            if (config.method === 'after') {
                target.after(el);
            } else {
                target.parentElement.insertBefore(el, target);
            }
        }

        el.classList.toggle('uishortcuts-char-tagline--rich', _getRichText() && HTML_RE.test(tagline));
        _setContent(el, tagline);
        this._applyClamp(el);
    }

    /**
     * Collapse an over-long tagline to a few lines, click to expand. The clamp class is
     * added first and dropped again if the content turns out to fit, so short taglines
     * never get the pointer cursor or the fade.
     */
    _applyClamp(el) {
        el.classList.remove(CLASS_EXPANDED);
        el.classList.add(CLASS_CLAMPED);
        el.title = '';

        // Bind per element, not per instance: _render() re-creates the div on a position change.
        if (el.dataset.clampBound !== '1') {
            el.dataset.clampBound = '1';
            el.addEventListener('click', (e) => {
                const node = e.currentTarget;
                if (!node.classList.contains(CLASS_CLAMPED)) return;
                const expanded = node.classList.toggle(CLASS_EXPANDED);
                node.title = expanded ? 'Click to collapse' : 'Click to expand';
            });
        }

        // Measure after layout, or scrollHeight is read before the new content is laid out.
        requestAnimationFrame(() => {
            if (!el.isConnected) return;
            if (el.scrollHeight <= el.clientHeight + CLAMP_TOLERANCE_PX) {
                el.classList.remove(CLASS_CLAMPED);
            } else {
                el.title = 'Click to expand';
            }
        });
    }

    _remove() {
        document.getElementById(TAGLINE_ID)?.remove();
    }

    destroy() {
        const ctx = getSTContext();
        if (ctx?.eventSource && this._eventHandler) {
            ctx.eventSource.removeListener('character_editor_opened', this._eventHandler);
            ctx.eventSource.removeListener('character_edited', this._eventHandler);
        }
        if (this._observer) {
            this._observer.disconnect();
            this._observer = null;
        }
        this._remove();
        log('Character tagline destroyed');
    }
}

let instance = null;

export function initCharTagline() {
    if (!instance) instance = new CharTagline();
    return instance;
}

export const definition = {
    key: 'charTagline',
    label: 'Character Tagline',
    description: "Shows the character's tagline (Chub, CharacterTavern, CharacterLibrary and other providers) in the character management panel.",
    init: initCharTagline,
    settings: {
        defaults: {
            position: 'below-name',
            richText: true,
        },
        render: (values) => `
            <label class="uishortcuts-setting-label" style="margin:0; display:flex; align-items:center; gap:6px;">
                Position
                <select data-key="position" style="flex:1; max-width:200px;">
                    <option value="below-name" ${values.position !== 'above-notes' ? 'selected' : ''}>Below character name</option>
                    <option value="above-notes" ${values.position === 'above-notes' ? 'selected' : ''}>Above Creator's Notes</option>
                </select>
            </label>
            <label class="uishortcuts-setting-label" style="margin:6px 0 0; display:flex; align-items:center; gap:6px;">
                <input type="checkbox" data-key="richText" ${values.richText !== false ? 'checked' : ''}>
                Render tagline formatting (colors, bold, headings)
            </label>
        `,
    },
};
