/**
 * SillyTavern UI Shortcuts - Shared Utilities
 * Common functions used across multiple modules
 */

export const EXTENSION_NAME = "UI Shortcuts";
export const EXTENSION_DIR = "SillyTavern-UIShortcuts";

/**
 * Get the extension's base URL
 * @returns {string} The base URL path for the extension
 */
export function getExtensionUrl() {
    const scripts = document.getElementsByTagName('script');
    for (let i = 0; i < scripts.length; i++) {
        if (scripts[i].src && scripts[i].src.includes(EXTENSION_DIR)) {
            const path = scripts[i].src;
            return path.substring(0, path.lastIndexOf('/'));
        }
    }
    return `scripts/extensions/third-party/${EXTENSION_DIR}`;
}

/**
 * Get the SillyTavern context
 * @returns {object|null} The ST context or null if unavailable
 */
export function getSTContext() {
    try {
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
            return SillyTavern.getContext();
        }
    } catch (e) {
        console.warn(`${EXTENSION_NAME}: Cannot access SillyTavern context:`, e);
    }
    return null;
}

/**
 * Get character avatar URL
 * @param {string} avatar - Avatar filename
 * @returns {string} Full avatar URL path
 */
export function getCharacterAvatarUrl(avatar) {
    if (!avatar) return '';
    return `/characters/${encodeURIComponent(avatar)}`;
}

/**
 * Sanitize folder name for file system
 * @param {string} name - The name to sanitize
 * @returns {string} Sanitized folder name
 */
export function sanitizeFolderName(name) {
    return name.replace(/[<>:"/\\|?*]/g, '_').trim();
}

/**
 * Check if a filename is an image file
 * @param {string} filename - The filename to check
 * @returns {boolean} True if the file is an image
 */
export function isImageFile(filename) {
    const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];
    const lowerName = filename.toLowerCase();
    return imageExtensions.some(ext => lowerName.endsWith(ext));
}

/**
 * Check if a filename is a video file
 * @param {string} filename - The filename to check
 * @returns {boolean} True if the file is a video
 */
export function isVideoFile(filename) {
    const videoExtensions = ['.mp4', '.webm', '.ogv', '.mov'];
    const lowerName = filename.toLowerCase();
    return videoExtensions.some(ext => lowerName.endsWith(ext));
}

/**
 * Fetch with CSRF token support
 * @param {string} url - The URL to fetch
 * @param {object} options - Fetch options
 * @returns {Promise<Response>} The fetch response
 */
export async function fetchWithCsrf(url, options = {}) {
    let csrfToken = '';
    try {
        const csrfResponse = await fetch('/csrf-token');
        if (csrfResponse.ok) {
            const csrfData = await csrfResponse.json();
            csrfToken = csrfData.token;
        }
    } catch (e) {
        // CSRF might not be required
    }
    
    const headers = {
        ...options.headers,
        ...(csrfToken && { 'X-CSRF-Token': csrfToken })
    };
    
    return fetch(url, { ...options, headers });
}

/**
 * Check if AstraProjecta extension is active.
 * Astra adds a body class when its runtime mounts.
 */
export function isAstraLoaded() {
    return document.body.classList.contains('astra-projecta-base-ui-body');
}

/**
 * Log a message with extension prefix
 * @param {string} message - The message to log
 * @param {string} level - Log level (log, warn, error)
 */
export function log(message, level = 'log') {
    const prefix = `${EXTENSION_NAME}:`;
    console[level]?.(prefix, message) || console.log(prefix, message);
}
