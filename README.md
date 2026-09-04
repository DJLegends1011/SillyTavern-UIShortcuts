# SillyTavern UI Shortcuts

A modular SillyTavern extension providing UI enhancements, quality-of-life tweaks, and integrations. Each feature is a standalone module that can be toggled on/off from the Extensions settings panel.

## Installation

### Client Extension

Copy or clone this repository into SillyTavern's third-party extensions directory:

```
SillyTavern/data/<user>/extensions/third-party/SillyTavern-UIShortcuts/
```

Restart SillyTavern or refresh the page. The extension loads automatically.

### Server Plugin (optional, needed only for Gelbooru search)

The `uishortcuts-helper/` folder is a SillyTavern server plugin that proxies requests to Gelbooru (bypassing CORS/CDN restrictions). To enable it:

1. **Enable plugins** in SillyTavern's `config.yaml`:
   ```yaml
   enableServerPlugins: true
   ```

2. Create a symbolic link (junction on Windows) from `uishortcuts-helper/` into SillyTavern's `plugins/` directory:

   **Windows (run as Administrator):**
   ```cmd
   mklink /J "path\to\SillyTavern\plugins\uishortcuts-helper" "path\to\SillyTavern-UIShortcuts\uishortcuts-helper"
   ```
   **Linux / macOS:**
   ```bash
   ln -s /path/to/SillyTavern-UIShortcuts/uishortcuts-helper /path/to/SillyTavern/plugins/uishortcuts-helper
   ```

3. Restart SillyTavern. The plugin registers routes at `/api/plugins/uishortcuts-helper/`.

## Modules

All modules are toggled individually from **Extensions → UI Shortcuts**. Each module has its own settings nested below its toggle when applicable.

### Avatar Gallery

Replaces the default avatar click behavior with a full-featured gallery panel. Browse, upload, zoom, pan, and drag-and-drop images. Includes an optional **Gelbooru Search** tab (requires server plugin + free API key) for searching and saving images by tag directly into the character's gallery.

### CSS Snippets

Create, save, export/import, and toggle custom CSS snippets at runtime. Ships with built-in snippets for common UI hides.

### Prompt Groups

Organizes the Prompt Manager list into collapsible groups and sub-groups using configurable marker prefixes in prompt names (default: `===` for groups, `<` for sub-groups).

### Character Tagline

Displays the character's tagline from Chub or CharacterTavern card data in the character management panel. Position is configurable: below the character name (default) or above Creator's Notes.

### Swipe Aggregator

Combine the best parts of multiple swipes into a new one. When the last message has several swipes, pick which ones to include, write an instruction like "use the intro from swipe 1 and the ending from swipe 3", preview the generated result, and add it as a new swipe. Available from a button on the message, the wand menu, or `/swipemix`.

### Drag & Drop Blocker

Prevents accidental character creation when dragging images onto the SillyTavern UI.

## File Structure

```
SillyTavern-UIShortcuts/
├── index.js                              # Client entry: module registry + lifecycle
├── manifest.json                         # Extension metadata
├── styles.css                            # Root CSS with @imports for module styles
├── src/
│   ├── utils.js                          # Shared helpers
│   ├── settings.js                       # Settings persistence + Extensions panel UI
│   └── modules/
│       ├── avatar-gallery/               # Gallery panel + Gelbooru integration
│       ├── char-tagline/                 # Chub/CharacterTavern tagline display
│       ├── css-snippets/                 # Runtime CSS snippet manager
│       ├── drag-drop-blocker/            # Image drop interceptor
│       ├── prompt-groups/                # Collapsible prompt manager groups
│       └── swipe-aggregator/             # Combine swipes into a new swipe
└── uishortcuts-helper/                   # Server plugin (symlink to ST plugins/)
    ├── index.js                          # Express router: Gelbooru proxy routes
    └── package.json                      # Plugin metadata
```

`src/modules/registry.js` may list module names whose folders aren't present in this release. Missing folders are skipped at startup and log a warning to the browser console. This is expected.

Omitted modules are either in active development, experimental, or personal workflow tools too narrow to publish. The public release is a curated subset of the dev tree.

## License

AGPL-3.0
