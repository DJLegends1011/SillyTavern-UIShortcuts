/**
 * Character Tagline Module
 * Reads the tagline from any provider namespace under character.data.extensions
 * and displays it in the character management panel (position configurable in settings).
 */

import { log, getSTContext } from '../../utils.js';

const TAGLINE_ID = 'uishortcuts-char-tagline';

// Insertion targets by position setting
const POSITIONS = {
    'below-name':  { target: '#rm_PinAndTabs', method: 'after' },
    'above-notes': { target: '#spoiler_free_desc', method: 'before' },
};

function _getPosition() {
    const ctx = getSTContext();
    return ctx?.extensionSettings?.UIShortcuts?.charTagline?.position || 'below-name';
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

        el.textContent = tagline;
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
        },
        render: (values) => `
            <label class="uishortcuts-setting-label" style="margin:0; display:flex; align-items:center; gap:6px;">
                Position
                <select data-key="position" style="flex:1; max-width:200px;">
                    <option value="below-name" ${values.position !== 'above-notes' ? 'selected' : ''}>Below character name</option>
                    <option value="above-notes" ${values.position === 'above-notes' ? 'selected' : ''}>Above Creator's Notes</option>
                </select>
            </label>
        `,
    },
};
