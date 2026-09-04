/**
 * Module Registry
 *
 * Lists module folder names to discover at startup.
 * Each folder must contain an index.js that exports a `definition` object.
 *
 * To add a module:    add its folder name here.
 * To remove a module: delete its entry (or its folder — missing folders are skipped).
 */
export default [
    'avatar-gallery',
    'css-snippets',
    'drag-drop-blocker',
    'external-media-always-on',
    'prompt-groups',
    'char-tagline',
    'alt-greeting-inserter',
    'swipe-aggregator',
    'chat-cleaner',
    'background-keepalive',
    'stream-pulse',
    'stream-diagnostics',
];
