/**
 * Swipe Aggregator
 *
 * Combine the best parts of multiple swipes on the last character message
 * into a new swipe. The user picks which swipes to include, writes an
 * instruction like "use the intro from swipe 1 and the ending from swipe 3",
 * and the result is generated via a quiet prompt and added as a new swipe.
 *
 * Entry points: a merge button on the last message (when it has 2+ swipes),
 * a wand-menu item, and a /swipemix slash command.
 * Swipe mechanics mirror ST's own /addswipe (slash-commands.js addSwipeCallback):
 * push to swipes/swipe_info, optionally switch, saveChat, reloadCurrentChat.
 */

import { log, getSTContext } from '../../utils.js';

const STYLE_ID = 'uishortcuts-swipeagg-styles';
const WAND_BUTTON_ID = 'uishortcuts-swipeagg-wand';
const MES_BUTTON_CLASS = 'uishortcuts-swipeagg-mes-btn';
const PANEL_CLASS = 'uishortcuts-swipeagg-panel';
const BACKDROP_CLASS = 'uishortcuts-swipeagg-backdrop';
const MOBILE_CLASS = 'uishortcuts-swipeagg-mobile';
const BODY_OPEN_CLASS = 'uishortcuts-swipeagg-open';
const MOBILE_MEDIA_QUERY = '(pointer: coarse), (max-width: 900px)';

const DEFAULT_INSTRUCTION = 'Combine the strongest elements of all the drafts into a single best version.';

const DEFAULT_TEMPLATE = `Stop the roleplay. {{name}}'s latest reply has several alternative drafts, numbered below.

{{swipes}}

Task: write one new reply for {{name}} following this instruction: {{instruction}}

Use only material from the drafts unless the instruction says otherwise. Keep their voice, tense, formatting, and a similar length. Output only the new reply text, with no draft numbers, labels, or commentary.`;

// Slash command lives for the whole session; register once even across re-inits.
let slashRegistered = false;

function _toast(type, msg) {
    if (typeof toastr !== 'undefined' && toastr?.[type]) toastr[type](msg);
}

function _getModuleSettings() {
    const ctx = getSTContext();
    const stored = ctx?.extensionSettings?.UIShortcuts?.swipeAggregator || {};
    return {
        autoSwitch: stored.autoSwitch !== false,
        promptTemplate: (typeof stored.promptTemplate === 'string' && stored.promptTemplate.trim())
            ? stored.promptTemplate
            : DEFAULT_TEMPLATE,
    };
}

/**
 * Collects swipe data from the last chat message.
 * @returns {{ error: string|null, message: object|null, swipes: string[], currentId: number, name: string }}
 */
function _getSwipeData() {
    const ctx = getSTContext();
    const chat = ctx?.chat;
    if (!Array.isArray(chat) || chat.length === 0) {
        return { error: 'empty', message: null, swipes: [], currentId: 0, name: '' };
    }

    const message = chat[chat.length - 1];
    if (message.is_user || message.is_system) {
        return { error: 'notchar', message: null, swipes: [], currentId: 0, name: '' };
    }

    const swipes = Array.isArray(message.swipes) && message.swipes.length
        ? message.swipes
        : [message.mes];

    if (swipes.length < 2) {
        return { error: 'fewswipes', message, swipes, currentId: 0, name: message.name || '' };
    }

    return {
        error: null,
        message,
        swipes,
        currentId: typeof message.swipe_id === 'number' ? message.swipe_id : 0,
        name: message.name || ctx?.name2 || 'the character',
    };
}

function _reportError(error) {
    if (error === 'empty') _toast('info', 'The chat has no messages.');
    else if (error === 'notchar') _toast('info', 'The last message must be a character message.');
    else if (error === 'fewswipes') _toast('info', 'The last message needs at least 2 swipes to combine.');
    else _toast('warning', 'Cannot combine swipes right now.');
}

/**
 * Builds the quiet prompt. Swipes keep their original 1-based numbers so the
 * user's "swipe 3" always matches what ST's swipe counter showed them.
 */
function _buildPrompt(swipes, includedIndices, instruction, name) {
    const { promptTemplate } = _getModuleSettings();
    const block = includedIndices
        .map(i => `[Swipe ${i + 1}]\n${swipes[i]}`)
        .join('\n\n');

    // Function replacements so '$' sequences in swipe text aren't interpreted.
    // Swipes go in last so placeholders inside swipe text are never expanded.
    return promptTemplate
        .replaceAll('{{instruction}}', () => instruction.trim() || DEFAULT_INSTRUCTION)
        .replaceAll('{{name}}', () => name)
        .replaceAll('{{swipes}}', () => block);
}

/**
 * Adds text as a new swipe on the last message. Mirrors ST's addSwipeCallback.
 * @returns {Promise<boolean>}
 */
async function _addSwipe(message, text) {
    const ctx = getSTContext();
    const chat = ctx?.chat;
    if (!Array.isArray(chat) || chat[chat.length - 1] !== message) {
        _toast('warning', 'The chat changed while generating. Swipe not added.');
        return false;
    }

    const { autoSwitch } = _getModuleSettings();

    if (!Array.isArray(message.swipes)) {
        message.swipes = [message.mes];
        message.swipe_info = [{}];
        message.swipe_id = 0;
    }
    if (!Array.isArray(message.swipe_info)) {
        message.swipe_info = message.swipes.map(() => ({}));
    }

    message.swipes.push(text);
    message.swipe_info.push({
        send_date: new Date().toISOString(),
        gen_started: null,
        gen_finished: null,
        extra: {
            bias: '',
            gen_id: Date.now(),
            api: 'manual',
            model: 'UIShortcuts: Swipe Aggregator',
        },
    });

    const newSwipeId = message.swipes.length - 1;

    if (autoSwitch) {
        // Sync the active swipe before switching, like ST's syncMesToSwipe.
        if (typeof message.swipe_id === 'number' && message.swipe_info[message.swipe_id]) {
            message.swipes[message.swipe_id] = message.mes;
            message.swipe_info[message.swipe_id].extra = structuredClone(message.extra ?? {});
        }
        message.swipe_id = newSwipeId;
        message.mes = text;
        message.extra = structuredClone(message.swipe_info[newSwipeId]?.extra ?? {});
    }

    if (typeof ctx.saveChat === 'function') await ctx.saveChat();
    if (typeof ctx.reloadCurrentChat === 'function') await ctx.reloadCurrentChat();
    return true;
}

async function _generate(quietPrompt) {
    const ctx = getSTContext();
    if (typeof ctx?.generateQuietPrompt !== 'function') {
        throw new Error('generateQuietPrompt unavailable');
    }
    // isAllowed() covers "already generating" and mid-swipe states.
    if (ctx.swipe?.isAllowed && !ctx.swipe.isAllowed()) {
        throw new Error('Generation is busy. Wait for it to finish.');
    }
    const result = await ctx.generateQuietPrompt({ quietPrompt });
    const text = String(result ?? '').trim();
    if (!text) throw new Error('The model returned an empty response.');
    return text;
}

function _injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
        .${BACKDROP_CLASS} {
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.65);
            backdrop-filter: blur(4px);
            z-index: 9998;
        }
        .${PANEL_CLASS} {
            position: fixed;
            z-index: 9999;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: min(92vw, 860px);
            height: min(88vh, 720px);
            /* Theme tint over an opaque backstop: stays solid without backdrop blur,
               which themes like Moonlit Echoes rely on for their low-alpha tint. */
            background: linear-gradient(var(--SmartThemeBlurTintColor, #1a1a1a), var(--SmartThemeBlurTintColor, #1a1a1a)), #1a1a1a;
            border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.15));
            border-radius: 10px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
            color: var(--SmartThemeBodyColor, #e0e0e0);
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        /* Our flex rules would otherwise beat the UA's [hidden] display:none. */
        .${PANEL_CLASS} [hidden] { display: none !important; }
        .uishortcuts-swipeagg-header {
            padding: 10px 14px;
            border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.1));
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .uishortcuts-swipeagg-header i { color: var(--SmartThemeQuoteColor, #4a9eff); }
        .uishortcuts-swipeagg-header .uishortcuts-swipeagg-count {
            margin-left: auto;
            font-weight: 400;
            font-size: 0.8rem;
            color: var(--SmartThemeEmColor, #888);
        }
        .uishortcuts-swipeagg-body {
            padding: 12px;
            display: flex;
            flex-direction: column;
            gap: 10px;
            min-height: 0;
            flex: 1;
        }
        .uishortcuts-swipeagg-chips {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
        }
        .uishortcuts-swipeagg-chip {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 5px 10px;
            border-radius: 16px;
            border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.15));
            background: var(--black30a, rgba(0, 0, 0, 0.3));
            cursor: pointer;
            font-size: 0.85rem;
            user-select: none;
            transition: background var(--uishortcuts-transition, 0.15s ease), border-color var(--uishortcuts-transition, 0.15s ease);
        }
        .uishortcuts-swipeagg-chip:hover { background: var(--white20a, rgba(255, 255, 255, 0.12)); }
        .uishortcuts-swipeagg-chip.active {
            border-color: var(--SmartThemeQuoteColor, #4a9eff);
            color: var(--SmartThemeQuoteColor, #4a9eff);
        }
        .uishortcuts-swipeagg-chip.excluded { opacity: 0.45; }
        .uishortcuts-swipeagg-chip input[type="checkbox"] {
            margin: 0;
            cursor: pointer;
        }
        .uishortcuts-swipeagg-chip .uishortcuts-swipeagg-current {
            font-size: 0.7rem;
            color: var(--SmartThemeEmColor, #888);
        }
        .uishortcuts-swipeagg-hint {
            font-size: 0.75rem;
            color: var(--SmartThemeEmColor, #888);
        }
        .uishortcuts-swipeagg-preview {
            flex: 1;
            margin: 0;
            padding: 12px;
            background: color-mix(in srgb, var(--SmartThemeBodyColor, #000) 8%, transparent);
            border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.08));
            border-left: 3px solid var(--SmartThemeQuoteColor, #4a9eff);
            border-radius: 6px;
            word-break: break-word;
            overflow: auto;
            line-height: 1.55;
            font-size: 0.9rem;
            min-height: 0;
        }
        .uishortcuts-swipeagg-preview img { max-width: 100%; height: auto; border-radius: 4px; }
        .uishortcuts-swipeagg-instruction {
            width: 100%;
            box-sizing: border-box;
            min-height: 64px;
            max-height: 30vh;
            resize: vertical;
            padding: 8px 10px;
            border-radius: 6px;
            border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.15));
            background: var(--black30a, rgba(0, 0, 0, 0.3));
            color: var(--SmartThemeBodyColor, #e0e0e0);
            font-size: 0.9rem;
            font-family: inherit;
        }
        .uishortcuts-swipeagg-instruction:focus {
            outline: none;
            border-color: var(--SmartThemeQuoteColor, #4a9eff);
        }
        .uishortcuts-swipeagg-footer {
            padding: 10px 14px;
            border-top: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.1));
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .uishortcuts-swipeagg-footer .spacer { flex: 1; }
        .uishortcuts-swipeagg-btn {
            padding: 6px 14px;
            border-radius: 6px;
            border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.15));
            background: var(--black30a, rgba(0, 0, 0, 0.3));
            color: var(--SmartThemeBodyColor, #e0e0e0);
            cursor: pointer;
            font-size: 0.85rem;
            transition: background var(--uishortcuts-transition, 0.15s ease);
        }
        .uishortcuts-swipeagg-btn:hover { background: var(--white20a, rgba(255, 255, 255, 0.12)); }
        .uishortcuts-swipeagg-btn:disabled { opacity: 0.4; cursor: default; }
        .uishortcuts-swipeagg-btn.primary {
            border-color: var(--SmartThemeQuoteColor, #4a9eff);
            color: var(--SmartThemeQuoteColor, #4a9eff);
        }
        .uishortcuts-swipeagg-settings textarea {
            width: 100%;
            box-sizing: border-box;
        }

        /* Fullscreen opaque on mobile. !important so a custom mobile theme can't
           override size/position; double-gated by media query and JS class. */
        @media ${MOBILE_MEDIA_QUERY} {
            .${PANEL_CLASS},
            .${PANEL_CLASS}.${MOBILE_CLASS} {
                inset: 0 !important;
                top: 0 !important;
                left: 0 !important;
                width: 100vw !important;
                height: 100vh !important;
                height: 100dvh !important; /* respects mobile browser chrome */
                max-width: none !important;
                max-height: none !important;
                transform: none !important;
                border: none !important;
                border-radius: 0 !important;
                box-shadow: none !important;
                background: linear-gradient(var(--SmartThemeBlurTintColor, #14141a), var(--SmartThemeBlurTintColor, #14141a)), #14141a !important;
                backdrop-filter: none !important;
            }
            .${BACKDROP_CLASS} { display: none !important; }
            .uishortcuts-swipeagg-header {
                padding-top: calc(10px + env(safe-area-inset-top));
            }
            .uishortcuts-swipeagg-chip {
                min-height: 40px;
                padding: 8px 14px;
            }
            .uishortcuts-swipeagg-instruction { min-height: 80px; }
            .uishortcuts-swipeagg-footer {
                flex-wrap: wrap;
                gap: 8px;
                padding-bottom: calc(10px + env(safe-area-inset-bottom));
            }
            .uishortcuts-swipeagg-footer .spacer { display: none; }
            .uishortcuts-swipeagg-btn {
                flex: 1 1 0;
                min-height: 44px;
                text-align: center;
                white-space: nowrap;
            }
            .uishortcuts-swipeagg-btn.primary {
                flex-basis: 100%;
                white-space: normal;
            }
            body.${BODY_OPEN_CLASS} {
                overflow: hidden;
                touch-action: none;
            }
        }
    `;
    document.head.appendChild(style);
}

let instance = null;

export class SwipeAggregator {
    constructor() {
        this._observer = null;
        this._panel = null;
        this._backdrop = null;
        this._state = null;
        this._handlers = {};
        this._mql = window.matchMedia ? window.matchMedia(MOBILE_MEDIA_QUERY) : null;
        this._onKeyDown = this._onKeyDown.bind(this);
        this._applyMobileState = this._applyMobileState.bind(this);

        _injectStyles();
        _registerSlashCommand();
        this._ensureWandButton();
        this._bindChatEvents();
        this._refreshMesButton();
    }

    // ---------- entry points ----------

    _ensureWandButton() {
        if (this._addWandButton()) return;
        this._observer = new MutationObserver(() => {
            if (this._addWandButton() && this._observer) {
                this._observer.disconnect();
                this._observer = null;
            }
        });
        this._observer.observe(document.body, { childList: true, subtree: true });
    }

    _addWandButton() {
        const menu = document.getElementById('extensionsMenu');
        if (!menu) return false;
        if (document.getElementById(WAND_BUTTON_ID)) return true;

        const item = document.createElement('div');
        item.id = WAND_BUTTON_ID;
        item.className = 'list-group-item flex-container flexGap5';
        item.title = 'Combine the last message\'s swipes into a new swipe';

        const icon = document.createElement('div');
        icon.className = 'fa-solid fa-code-merge extensionsMenuExtensionButton';
        const label = document.createElement('span');
        label.textContent = 'Combine Swipes';

        item.appendChild(icon);
        item.appendChild(label);
        item.addEventListener('click', () => this.open());
        menu.appendChild(item);
        return true;
    }

    _bindChatEvents() {
        const ctx = getSTContext();
        if (!ctx?.eventSource) return;
        const types = ctx.eventTypes || ctx.event_types || {};

        const refresh = () => this._refreshMesButton();
        this._handlers = {
            rendered: refresh,
            swiped: refresh,
            edited: refresh,
            deleted: refresh,
            chatChanged: refresh,
        };

        if (types.CHARACTER_MESSAGE_RENDERED) ctx.eventSource.on(types.CHARACTER_MESSAGE_RENDERED, this._handlers.rendered);
        if (types.MESSAGE_SWIPED) ctx.eventSource.on(types.MESSAGE_SWIPED, this._handlers.swiped);
        if (types.MESSAGE_EDITED) ctx.eventSource.on(types.MESSAGE_EDITED, this._handlers.edited);
        if (types.MESSAGE_DELETED) ctx.eventSource.on(types.MESSAGE_DELETED, this._handlers.deleted);
        if (types.CHAT_CHANGED) ctx.eventSource.on(types.CHAT_CHANGED, this._handlers.chatChanged);
    }

    /** Shows the merge button only on the last message, only with 2+ swipes. */
    _refreshMesButton() {
        // Defer slightly, since the DOM may not be fully built when events fire.
        setTimeout(() => {
            document.querySelectorAll(`.${MES_BUTTON_CLASS}`).forEach(el => el.remove());

            const { error, message } = _getSwipeData();
            if (error || !message) return;

            const ctx = getSTContext();
            const mesId = ctx.chat.length - 1;
            const messageEl = document.querySelector(`.mes[mesid="${mesId}"]`);
            if (!messageEl) return;

            const container = messageEl.querySelector('.extraMesButtons') || messageEl.querySelector('.mes_buttons');
            if (!container || container.querySelector(`.${MES_BUTTON_CLASS}`)) return;

            const btn = document.createElement('div');
            btn.className = `mes_button ${MES_BUTTON_CLASS} fa-solid fa-code-merge interactable`;
            btn.title = 'Combine swipes into a new one';
            btn.tabIndex = 0;
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.open();
            });
            container.appendChild(btn);
        }, 100);
    }

    // ---------- panel ----------

    open() {
        try {
            const { error, message, swipes, currentId, name } = _getSwipeData();
            if (error) {
                _reportError(error);
                return;
            }

            // Close the wand menu if it's open so it doesn't sit over the panel.
            const wandMenu = document.getElementById('extensionsMenu');
            if (wandMenu) wandMenu.style.display = 'none';

            this._buildPanel({ message, swipes, currentId, name });
        } catch (e) {
            log(`failed to open swipe aggregator: ${e.message}`, 'error');
            _toast('error', 'Could not open the swipe aggregator. Check the console.');
        }
    }

    _buildPanel({ message, swipes, currentId, name }) {
        this._dismiss();
        this._state = {
            message,
            swipes,
            currentId,
            name,
            included: new Set(swipes.map((_, i) => i)),
            previewIdx: currentId,
            busy: false,
            result: null,
        };

        const backdrop = document.createElement('div');
        backdrop.className = BACKDROP_CLASS;
        backdrop.addEventListener('click', () => { if (!this._state?.busy) this._dismiss(); });

        const panel = document.createElement('div');
        panel.className = PANEL_CLASS;
        panel.innerHTML = `
            <div class="uishortcuts-swipeagg-header">
                <i class="fa-solid fa-code-merge"></i>
                <span class="uishortcuts-swipeagg-title">Combine Swipes</span>
                <span class="uishortcuts-swipeagg-count">${swipes.length} swipes</span>
            </div>
            <div class="uishortcuts-swipeagg-body">
                <div class="uishortcuts-swipeagg-chips"></div>
                <div class="uishortcuts-swipeagg-hint compose-only">Tap a number to preview it. Untick to leave it out of the mix.</div>
                <div class="uishortcuts-swipeagg-preview mes_text"></div>
                <textarea class="uishortcuts-swipeagg-instruction compose-only"
                    placeholder="e.g. Use the opening from swipe 1, but end with the dialogue from swipe 3. Leave blank to merge the best parts."></textarea>
            </div>
            <div class="uishortcuts-swipeagg-footer compose-footer">
                <button class="uishortcuts-swipeagg-btn close">Close</button>
                <span class="spacer"></span>
                <button class="uishortcuts-swipeagg-btn primary generate"><i class="fa-solid fa-wand-magic-sparkles"></i> Generate</button>
            </div>
            <div class="uishortcuts-swipeagg-footer result-footer" hidden>
                <button class="uishortcuts-swipeagg-btn back"><i class="fa-solid fa-chevron-left"></i> Back</button>
                <button class="uishortcuts-swipeagg-btn retry"><i class="fa-solid fa-rotate-right"></i> Retry</button>
                <span class="spacer"></span>
                <button class="uishortcuts-swipeagg-btn primary accept"><i class="fa-solid fa-plus"></i> Add as swipe</button>
            </div>
        `;

        panel.querySelector('.close').addEventListener('click', () => { if (!this._state?.busy) this._dismiss(); });
        panel.querySelector('.generate').addEventListener('click', () => this._generateCombined());
        panel.querySelector('.back').addEventListener('click', () => this._showCompose());
        panel.querySelector('.retry').addEventListener('click', () => this._generateCombined());
        panel.querySelector('.accept').addEventListener('click', () => this._acceptResult());

        const textarea = panel.querySelector('.uishortcuts-swipeagg-instruction');
        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                this._generateCombined();
            }
        });

        document.body.appendChild(backdrop);
        document.body.appendChild(panel);
        document.body.classList.add(BODY_OPEN_CLASS);
        this._backdrop = backdrop;
        this._panel = panel;

        this._applyMobileState();
        this._mql?.addEventListener('change', this._applyMobileState);
        document.addEventListener('keydown', this._onKeyDown, true);

        this._renderChips();
        this._renderPreview();
    }

    _applyMobileState() {
        if (!this._panel) return;
        const isMobile = this._mql?.matches ?? false;
        this._panel.classList.toggle(MOBILE_CLASS, isMobile);
    }

    _renderChips() {
        if (!this._panel || !this._state) return;
        const { swipes, included, previewIdx, currentId, result } = this._state;
        const row = this._panel.querySelector('.uishortcuts-swipeagg-chips');
        row.innerHTML = '';

        // In result view the chips are hidden. The preview shows the result.
        row.hidden = result !== null;
        if (result !== null) return;

        swipes.forEach((_, i) => {
            const chip = document.createElement('div');
            chip.className = 'uishortcuts-swipeagg-chip'
                + (i === previewIdx ? ' active' : '')
                + (included.has(i) ? '' : ' excluded');

            const check = document.createElement('input');
            check.type = 'checkbox';
            check.checked = included.has(i);
            check.title = `Include swipe ${i + 1} in the mix`;
            check.addEventListener('click', (e) => {
                e.stopPropagation();
                if (check.checked) included.add(i);
                else included.delete(i);
                this._renderChips();
            });

            const label = document.createElement('span');
            label.textContent = `Swipe ${i + 1}`;

            chip.appendChild(check);
            chip.appendChild(label);

            if (i === currentId) {
                const cur = document.createElement('span');
                cur.className = 'uishortcuts-swipeagg-current';
                cur.textContent = '(current)';
                chip.appendChild(cur);
            }

            chip.addEventListener('click', () => {
                this._state.previewIdx = i;
                this._renderChips();
                this._renderPreview();
            });
            row.appendChild(chip);
        });
    }

    _renderPreview() {
        if (!this._panel || !this._state) return;
        const ctx = getSTContext();
        const { swipes, previewIdx, name, result } = this._state;
        const text = result !== null ? result : swipes[previewIdx];

        const previewEl = this._panel.querySelector('.uishortcuts-swipeagg-preview');
        // Render via ST's own formatter for markdown, media, and sanitized CSS.
        // messageId -1 avoids the chat[0] special case; fall back to plain text if it throws.
        try {
            if (typeof ctx?.messageFormatting !== 'function') throw new Error('messageFormatting unavailable');
            previewEl.innerHTML = ctx.messageFormatting(text, name, false, false, -1);
        } catch (e) {
            log(`swipe preview formatting failed, showing plain text: ${e.message}`, 'warn');
            previewEl.textContent = text;
        }
    }

    _showCompose() {
        if (!this._panel || !this._state) return;
        this._state.result = null;
        this._panel.querySelector('.compose-footer').hidden = false;
        this._panel.querySelector('.result-footer').hidden = true;
        this._panel.querySelectorAll('.compose-only').forEach(el => { el.hidden = false; });
        this._panel.querySelector('.uishortcuts-swipeagg-title').textContent = 'Combine Swipes';
        this._renderChips();
        this._renderPreview();
    }

    _showResult() {
        if (!this._panel || !this._state) return;
        this._panel.querySelector('.compose-footer').hidden = true;
        this._panel.querySelector('.result-footer').hidden = false;
        this._panel.querySelectorAll('.compose-only').forEach(el => { el.hidden = true; });
        this._panel.querySelector('.uishortcuts-swipeagg-title').textContent = 'Combined Result';
        this._renderChips();
        this._renderPreview();
    }

    _setBusy(busy) {
        if (!this._panel || !this._state) return;
        this._state.busy = busy;
        this._panel.querySelectorAll('.uishortcuts-swipeagg-btn').forEach(b => { b.disabled = busy; });
        const genBtn = this._panel.querySelector('.generate');
        const retryBtn = this._panel.querySelector('.retry');
        genBtn.innerHTML = busy
            ? '<i class="fa-solid fa-spinner fa-spin"></i> Generating…'
            : '<i class="fa-solid fa-wand-magic-sparkles"></i> Generate';
        retryBtn.innerHTML = busy
            ? '<i class="fa-solid fa-spinner fa-spin"></i> Generating…'
            : '<i class="fa-solid fa-rotate-right"></i> Retry';
    }

    async _generateCombined() {
        const state = this._state;
        if (!state || state.busy) return;

        const includedIndices = [...state.included].sort((a, b) => a - b);
        if (includedIndices.length === 0) {
            _toast('warning', 'Include at least one swipe.');
            return;
        }

        const instruction = this._panel.querySelector('.uishortcuts-swipeagg-instruction').value;
        const prompt = _buildPrompt(state.swipes, includedIndices, instruction, state.name);

        this._setBusy(true);
        try {
            const text = await _generate(prompt);
            // Panel may have been closed or reopened while generating.
            if (this._state !== state) return;
            state.result = text;
            this._showResult();
        } catch (e) {
            log(`swipe combine generation failed: ${e.message}`, 'error');
            if (this._state === state) _toast('error', e.message);
        } finally {
            if (this._state === state) this._setBusy(false);
        }
    }

    async _acceptResult() {
        const state = this._state;
        if (!state || state.busy || state.result === null) return;

        this._setBusy(true);
        let ok = false;
        try {
            ok = await _addSwipe(state.message, state.result);
        } catch (e) {
            log(`failed to add combined swipe: ${e.message}`, 'error');
        }
        if (this._state !== state) return;
        this._setBusy(false);
        if (ok) {
            this._dismiss();
            _toast('success', 'Combined swipe added.');
        } else {
            _toast('error', 'Could not add the swipe.');
        }
    }

    _onKeyDown(e) {
        if (!this._panel || e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        if (!this._state?.busy) this._dismiss();
    }

    _dismiss() {
        document.removeEventListener('keydown', this._onKeyDown, true);
        this._mql?.removeEventListener('change', this._applyMobileState);
        document.body.classList.remove(BODY_OPEN_CLASS);
        if (this._panel) { this._panel.remove(); this._panel = null; }
        if (this._backdrop) { this._backdrop.remove(); this._backdrop = null; }
        this._state = null;
    }

    /** Direct path for /swipemix with an instruction: no panel, all swipes included. */
    async runDirect(instruction) {
        const { error, message, swipes, name } = _getSwipeData();
        if (error) {
            _reportError(error);
            return;
        }
        const prompt = _buildPrompt(swipes, swipes.map((_, i) => i), instruction, name);
        _toast('info', 'Generating combined swipe…');
        try {
            const text = await _generate(prompt);
            const ok = await _addSwipe(message, text);
            if (ok) _toast('success', 'Combined swipe added.');
        } catch (e) {
            log(`swipe combine generation failed: ${e.message}`, 'error');
            _toast('error', e.message);
        }
    }

    destroy() {
        this._dismiss();
        if (this._observer) {
            this._observer.disconnect();
            this._observer = null;
        }
        const ctx = getSTContext();
        const types = ctx?.eventTypes || ctx?.event_types || {};
        if (ctx?.eventSource) {
            if (types.CHARACTER_MESSAGE_RENDERED && this._handlers.rendered) ctx.eventSource.removeListener(types.CHARACTER_MESSAGE_RENDERED, this._handlers.rendered);
            if (types.MESSAGE_SWIPED && this._handlers.swiped) ctx.eventSource.removeListener(types.MESSAGE_SWIPED, this._handlers.swiped);
            if (types.MESSAGE_EDITED && this._handlers.edited) ctx.eventSource.removeListener(types.MESSAGE_EDITED, this._handlers.edited);
            if (types.MESSAGE_DELETED && this._handlers.deleted) ctx.eventSource.removeListener(types.MESSAGE_DELETED, this._handlers.deleted);
            if (types.CHAT_CHANGED && this._handlers.chatChanged) ctx.eventSource.removeListener(types.CHAT_CHANGED, this._handlers.chatChanged);
        }
        this._handlers = {};
        document.querySelectorAll(`.${MES_BUTTON_CLASS}`).forEach(el => el.remove());
        document.getElementById(WAND_BUTTON_ID)?.remove();
        document.getElementById(STYLE_ID)?.remove();
        instance = null;
        log('Swipe aggregator destroyed');
    }
}

function _registerSlashCommand() {
    if (slashRegistered) return;
    const ctx = getSTContext();
    if (!ctx?.SlashCommandParser || !ctx.SlashCommand) return;

    try {
        ctx.SlashCommandParser.addCommandObject(ctx.SlashCommand.fromProps({
            name: 'swipemix',
            aliases: ['combineswipes'],
            helpString: 'Open the swipe combiner, or pass an instruction (e.g. "use the intro from swipe 1 and the ending from swipe 3") to combine all swipes directly.',
            unnamedArgumentList: ctx.SlashCommandArgument ? [
                ctx.SlashCommandArgument.fromProps({
                    description: 'instruction for combining the swipes',
                    typeList: ctx.ARGUMENT_TYPE ? [ctx.ARGUMENT_TYPE.STRING] : [],
                    isRequired: false,
                }),
            ] : [],
            callback: async (_args, value) => {
                if (!instance) { _toast('info', 'Swipe Aggregator is disabled.'); return ''; }
                const raw = String(value ?? '').trim();
                if (raw === '') instance.open();
                else await instance.runDirect(raw);
                return '';
            },
        }));
        slashRegistered = true;
    } catch (e) {
        log(`swipemix slash command registration failed: ${e.message}`, 'warn');
    }
}

export function initSwipeAggregator() {
    if (!instance) instance = new SwipeAggregator();
    return instance;
}

export const definition = {
    key: 'swipeAggregator',
    label: 'Swipe Aggregator',
    description: 'Combine the best parts of multiple swipes into a new swipe with an instruction like "use the intro from swipe 1 and the ending from swipe 3". Adds a message button, a wand-menu item, and a /swipemix command.',
    init: initSwipeAggregator,
    settings: {
        defaults: {
            autoSwitch: true,
            promptTemplate: DEFAULT_TEMPLATE,
        },
        render: (values) => `
            <div class="uishortcuts-swipeagg-settings">
                <label class="checkbox_label">
                    <input type="checkbox" data-key="autoSwitch" ${values.autoSwitch !== false ? 'checked' : ''} />
                    <span>Switch to the combined swipe after adding it</span>
                </label>
                <small>Prompt template. Placeholders: <code>{{swipes}}</code> (numbered drafts), <code>{{instruction}}</code>, <code>{{name}}</code> (message author). Clear the field to restore the default.</small>
                <textarea data-key="promptTemplate" class="text_pole textarea_compact" rows="8"></textarea>
            </div>
        `,
        hydrate: (el, values) => {
            const ta = el.querySelector('textarea[data-key="promptTemplate"]');
            if (ta) ta.value = values.promptTemplate ?? DEFAULT_TEMPLATE;
        },
    },
};
