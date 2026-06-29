/**
 * SillyTavern UI Shortcuts - Set-as-Background Popover
 *
 * Self-contained popover panel anchored to the gallery toolbar button.
 * Emits state changes via callbacks; owns no business logic — its parent
 * decides what to do with the values (apply / persist / upload).
 */

import { isAstraLoaded } from '../../../utils.js';

export const DEFAULT_STATE = Object.freeze({
    targets: ['page'],          // 'page' and/or 'chat'
    fit: 'cover',
    opacity: 1.0,
    blur: 0,
    brightness: 1.0,
});

export class BackgroundPopover {
    /**
     * @param {object} opts
     * @param {() => string|null}      opts.getCurrentSrc - Returns the image URL to use as bg.
     * @param {(state) => void}        opts.onPreview     - Live-updates while user tweaks controls.
     * @param {(state) => void}        opts.onApply       - User committed (closes popover).
     * @param {() => void}             opts.onClear       - Remove any applied bg for this character.
     * @param {(state) => Promise<void>|void} opts.onSaveToST - "Save to ST gallery" button.
     */
    constructor(opts) {
        this.getCurrentSrc = opts.getCurrentSrc;
        this.onPreview = opts.onPreview || (() => {});
        this.onApply = opts.onApply || (() => {});
        this.onClear = opts.onClear || (() => {});
        this.onSaveToST = opts.onSaveToST || (() => {});

        this.el = null;
        this.anchorBtn = null;
        this.state = { ...DEFAULT_STATE };
        this.prevSnapshot = null;       // restore-on-cancel snapshot
        this._docClickHandler = null;
    }

    isOpen() {
        return !!this.el && this.el.classList.contains('open');
    }

    /**
     * Open the popover, anchored to `anchorBtn`. Snapshot the prior state so
     * cancel restores it. `initialState` seeds controls with the character's
     * existing saved bg, if any.
     */
    open(anchorBtn, initialState, priorSnapshot) {
        if (!this.el) this._build();
        this.anchorBtn = anchorBtn;

        this.state = { ...DEFAULT_STATE, ...(initialState || {}) };
        this.prevSnapshot = priorSnapshot || null;
        this._writeFields();
        this._position();

        this.el.classList.add('open');

        // Outside-click closes (treated as cancel).
        this._docClickHandler = (e) => {
            if (!this.el) return;
            if (this.el.contains(e.target)) return;
            if (this.anchorBtn && this.anchorBtn.contains(e.target)) return;
            this.cancel();
        };
        // Defer so the click that opened us doesn't immediately close it
        setTimeout(() => document.addEventListener('mousedown', this._docClickHandler, true), 0);
    }

    /** Close without applying — restores prior state via the parent. */
    cancel() {
        if (!this.el) return;
        this.el.classList.remove('open');
        if (this._docClickHandler) {
            document.removeEventListener('mousedown', this._docClickHandler, true);
            this._docClickHandler = null;
        }
        // Hand restoration responsibility back to the parent
        this.onPreview(this.prevSnapshot);
        this.prevSnapshot = null;
    }

    close() {
        if (!this.el) return;
        this.el.classList.remove('open');
        if (this._docClickHandler) {
            document.removeEventListener('mousedown', this._docClickHandler, true);
            this._docClickHandler = null;
        }
        this.prevSnapshot = null;
    }

    destroy() {
        if (this._docClickHandler) {
            document.removeEventListener('mousedown', this._docClickHandler, true);
            this._docClickHandler = null;
        }
        if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
        this.el = null;
    }

    // ============================================================
    // INTERNAL
    // ============================================================

    _build() {
        const el = document.createElement('div');
        el.className = 'uishortcuts-bg-popover';
        el.innerHTML = `
            <div class="uishortcuts-bg-popover-header">
                <i class="fa-solid fa-image"></i>
                <span>Set as background</span>
            </div>

            <div class="uishortcuts-bg-popover-body">
                <label class="uishortcuts-bg-row">
                    <span>Apply to</span>
                    <span class="uishortcuts-bg-targets">
                        <label class="uishortcuts-bg-checkbox">
                            <input type="checkbox" data-target="page"> Page
                        </label>
                        <label class="uishortcuts-bg-checkbox">
                            <input type="checkbox" data-target="chat"> Chat panel
                        </label>
                    </span>
                </label>

                <label class="uishortcuts-bg-row">
                    <span>Fit</span>
                    <select data-field="fit">
                        <option value="cover">Cover</option>
                        <option value="contain">Contain</option>
                        <option value="stretch">Stretch</option>
                        <option value="center">Center</option>
                        <option value="tile">Tile</option>
                    </select>
                </label>

                <label class="uishortcuts-bg-row">
                    <span>Opacity</span>
                    <span class="uishortcuts-bg-slider-wrap">
                        <input type="range" data-field="opacity" min="0" max="1" step="0.05">
                        <span class="uishortcuts-bg-readout" data-readout="opacity">1.00</span>
                    </span>
                </label>

                <label class="uishortcuts-bg-row">
                    <span>Blur</span>
                    <span class="uishortcuts-bg-slider-wrap">
                        <input type="range" data-field="blur" min="0" max="40" step="1">
                        <span class="uishortcuts-bg-readout" data-readout="blur">0px</span>
                    </span>
                </label>

                <label class="uishortcuts-bg-row">
                    <span>Brightness</span>
                    <span class="uishortcuts-bg-slider-wrap">
                        <input type="range" data-field="brightness" min="0" max="2" step="0.05">
                        <span class="uishortcuts-bg-readout" data-readout="brightness">1.00</span>
                    </span>
                </label>
            </div>

            <div class="uishortcuts-bg-popover-footer">
                <button class="uishortcuts-bg-btn uishortcuts-bg-btn-clear" type="button" title="Clear applied background">
                    <i class="fa-solid fa-eraser"></i> Clear
                </button>
                <button class="uishortcuts-bg-btn uishortcuts-bg-btn-save" type="button" title="Copy image into SillyTavern's backgrounds folder">
                    <i class="fa-solid fa-download"></i> Save to ST
                </button>
                <button class="uishortcuts-bg-btn uishortcuts-bg-btn-cancel" type="button">
                    Cancel
                </button>
                <button class="uishortcuts-bg-btn uishortcuts-bg-btn-apply" type="button">
                    <i class="fa-solid fa-check"></i> Apply
                </button>
            </div>

            <div class="uishortcuts-bg-popover-status" data-role="status"></div>
        `;
        document.body.appendChild(el);
        this.el = el;

        if (isAstraLoaded()) {
            const astraFields = ['opacity', 'blur', 'brightness'];
            for (const field of astraFields) {
                const row = el.querySelector(`input[data-field="${field}"]`)?.closest('.uishortcuts-bg-row');
                if (!row) continue;
                row.classList.add('uishortcuts-bg-row--disabled');
                const input = row.querySelector('input');
                if (input) input.disabled = true;
            }
            const note = document.createElement('div');
            note.className = 'uishortcuts-bg-astra-note';
            note.textContent = 'Opacity, blur & brightness are managed by Astra';
            const body = el.querySelector('.uishortcuts-bg-popover-body');
            body.appendChild(note);
        }

        this._bindControls();
    }

    _bindControls() {
        const el = this.el;

        // Target checkboxes
        el.querySelectorAll('input[type="checkbox"][data-target]').forEach(cb => {
            cb.addEventListener('change', () => {
                const targets = Array.from(el.querySelectorAll('input[type="checkbox"][data-target]:checked'))
                    .map(c => c.dataset.target);
                this.state.targets = targets;
                this._emitPreview();
            });
        });

        // Fit select
        const fitSel = el.querySelector('select[data-field="fit"]');
        fitSel.addEventListener('change', () => {
            this.state.fit = fitSel.value;
            this._emitPreview();
        });

        // Sliders
        const sliderConfig = [
            { field: 'opacity', format: v => Number(v).toFixed(2) },
            { field: 'blur', format: v => `${Math.round(v)}px` },
            { field: 'brightness', format: v => Number(v).toFixed(2) },
        ];
        sliderConfig.forEach(({ field, format }) => {
            const input = el.querySelector(`input[data-field="${field}"]`);
            const readout = el.querySelector(`[data-readout="${field}"]`);
            input.addEventListener('input', () => {
                this.state[field] = Number(input.value);
                readout.textContent = format(input.value);
                this._emitPreview();
            });
        });

        // Footer buttons
        el.querySelector('.uishortcuts-bg-btn-apply').addEventListener('click', () => {
            const src = this.getCurrentSrc();
            if (!src) return;
            const finalState = { ...this.state, src };
            this.onApply(finalState);
            this.prevSnapshot = null; // committed
            this.close();
        });

        el.querySelector('.uishortcuts-bg-btn-cancel').addEventListener('click', () => this.cancel());

        el.querySelector('.uishortcuts-bg-btn-clear').addEventListener('click', () => {
            this.onClear();
            this.prevSnapshot = null;
            this.close();
        });

        el.querySelector('.uishortcuts-bg-btn-save').addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            const src = this.getCurrentSrc();
            if (!src) return;
            this._setStatus('Uploading…', 'pending');
            btn.disabled = true;
            try {
                await this.onSaveToST({ ...this.state, src });
                this._setStatus('Saved to ST backgrounds', 'ok');
            } catch (err) {
                this._setStatus(`Save failed: ${err.message || err}`, 'err');
            } finally {
                btn.disabled = false;
            }
        });
    }

    _writeFields() {
        const el = this.el;
        el.querySelectorAll('input[type="checkbox"][data-target]').forEach(cb => {
            cb.checked = this.state.targets.includes(cb.dataset.target);
        });
        el.querySelector('select[data-field="fit"]').value = this.state.fit;
        el.querySelector('input[data-field="opacity"]').value = String(this.state.opacity);
        el.querySelector('[data-readout="opacity"]').textContent = Number(this.state.opacity).toFixed(2);
        el.querySelector('input[data-field="blur"]').value = String(this.state.blur);
        el.querySelector('[data-readout="blur"]').textContent = `${Math.round(this.state.blur)}px`;
        el.querySelector('input[data-field="brightness"]').value = String(this.state.brightness);
        el.querySelector('[data-readout="brightness"]').textContent = Number(this.state.brightness).toFixed(2);
        this._setStatus('', '');
    }

    _setStatus(text, kind) {
        const status = this.el?.querySelector('[data-role="status"]');
        if (!status) return;
        status.textContent = text || '';
        status.className = 'uishortcuts-bg-popover-status';
        if (kind) status.classList.add(`uishortcuts-bg-status-${kind}`);
    }

    _emitPreview() {
        const src = this.getCurrentSrc();
        if (!src) return;
        this.onPreview({ ...this.state, src });
    }

    _position() {
        if (!this.anchorBtn || !this.el) return;
        const rect = this.anchorBtn.getBoundingClientRect();
        const popW = 280;
        const margin = 8;

        let left = rect.right - popW;
        if (left < margin) left = margin;
        if (left + popW > window.innerWidth - margin) {
            left = window.innerWidth - popW - margin;
        }
        const top = rect.bottom + 6;

        this.el.style.left = `${left}px`;
        this.el.style.top = `${top}px`;
    }
}
