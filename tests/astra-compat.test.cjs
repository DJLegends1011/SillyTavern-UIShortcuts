// Run with: node --test tests/astra-compat.test.cjs
// Requires Playwright and its Chromium browser (or PLAYWRIGHT_CHROMIUM_EXECUTABLE).
// Uses the sibling Astra checkout's actual native override stylesheet.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
let browser;
let astraCss;
before(async () => {
    astraCss = await readFile(path.resolve(root, '../SillyTavern-AstraProjecta/src/styles/sillytavern-overrides.css'), 'utf8');
    browser = await chromium.launch({
        headless: true,
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
            ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
    });
});
after(async () => { await browser?.close(); });

async function setup(t, active = false) {
    const page = await browser.newPage();
    t.after(() => page.close());
    await page.route('http://uishortcuts.test/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/') {
            return route.fulfill({ contentType: 'text/html', body: '<html><head></head><body><div id="bg1"></div><div id="chat"><div class="mes">Message</div></div><button id="anchor">Background</button></body></html>' });
        }
        if (!pathname.startsWith('/src/')) return route.fulfill({ status: 204 });
        const filename = path.resolve(root, '.' + pathname);
        if (!filename.startsWith(root + path.sep)) return route.abort();
        await route.fulfill({ contentType: 'text/javascript', body: await readFile(filename, 'utf8') });
    });
    await page.goto('http://uishortcuts.test/');
    await page.addStyleTag({ content: astraCss });
    await page.addStyleTag({ content: await readFile(path.join(root, 'src/modules/avatar-gallery/set-as-background/styles.css'), 'utf8') });
    await page.evaluate(async active => {
        document.body.classList.toggle('astra-projecta-base-ui-body', active);
        document.body.classList.toggle('astra-projecta-mobile-layout', active);
        document.body.style.setProperty('--astra-chat-bg-blur', '4px');
        document.body.style.setProperty('--astra-chat-bg-opacity', '0.35');
        const base = '/src/modules/avatar-gallery/set-as-background/';
        const { BackgroundApplier } = await import(base + 'applier.js');
        const { BackgroundPopover } = await import(base + 'popover.js');
        window.applier = new BackgroundApplier();
        window.saved = { src: '/image.png', targets: ['page', 'chat'], blur: 12, opacity: 0.6, brightness: 0.7 };
        window.applier.apply(window.saved);
        window.popover = new BackgroundPopover({ getCurrentSrc: () => '/image.png', onPreview: state => window.applier.apply(state) });
    }, active);
    return page;
}

async function appearance(page, id = 'bg1') {
    return page.evaluate(id => {
        const style = getComputedStyle(document.getElementById(id));
        return { filter: style.filter, opacity: style.opacity };
    }, id);
}

test('page effects follow Astra entering and leaving mobile layout without reapplying', async t => {
    const page = await setup(t);
    assert.equal((await appearance(page)).filter, 'blur(12px) brightness(0.7)');
    await page.evaluate(() => document.body.classList.add('astra-projecta-mobile-layout', 'astra-projecta-base-ui-body'));
    assert.deepEqual(await appearance(page), { filter: 'blur(4px) brightness(0.7)', opacity: '0.35' });
    await page.evaluate(() => document.body.style.setProperty('--astra-chat-bg-blur', '3px'));
    assert.equal((await appearance(page)).filter, 'blur(3px) brightness(0.7)');
    await page.evaluate(() => document.body.classList.remove('astra-projecta-mobile-layout', 'astra-projecta-base-ui-body'));
    assert.equal((await appearance(page)).filter, 'blur(12px) brightness(0.7)');
});

test('a background initialized in Astra retains brightness and restores desktop effects', async t => {
    const page = await setup(t, true);
    assert.deepEqual(await appearance(page), { filter: 'blur(4px) brightness(0.7)', opacity: '0.35' });
    await page.evaluate(() => document.body.classList.remove('astra-projecta-mobile-layout', 'astra-projecta-base-ui-body'));
    assert.equal((await appearance(page)).filter, 'blur(12px) brightness(0.7)');
});

test('Astra does not suppress the separate chat overlay effects', async t => {
    const page = await setup(t, true);
    assert.deepEqual(await appearance(page, 'uishortcuts-chat-bg-layer'), { filter: 'blur(12px) brightness(0.7)', opacity: '0.6' });
});

async function controls(page) {
    return page.evaluate(() => Object.fromEntries(['opacity', 'blur', 'brightness'].map(field => [field, document.querySelector(`input[data-field="${field}"]`).disabled])));
}

test('page controls preserve brightness and update as Astra activates or deactivates', async t => {
    const page = await setup(t);
    await page.evaluate(() => window.popover.open(document.getElementById('anchor'), { ...window.saved, targets: ['page'] }));
    assert.deepEqual(await controls(page), { opacity: false, blur: false, brightness: false });
    await page.evaluate(() => document.body.classList.add('astra-projecta-mobile-layout', 'astra-projecta-base-ui-body'));
    assert.deepEqual(await controls(page), { opacity: true, blur: true, brightness: false });
    await page.evaluate(() => document.body.classList.remove('astra-projecta-mobile-layout', 'astra-projecta-base-ui-body'));
    assert.deepEqual(await controls(page), { opacity: false, blur: false, brightness: false });
});

test('selecting the chat overlay enables its sliders and previews changes under Astra', async t => {
    const page = await setup(t, true);
    await page.evaluate(() => window.popover.open(document.getElementById('anchor'), { ...window.saved, targets: ['page'] }));
    await page.locator('input[data-target="chat"]').check();
    assert.deepEqual(await controls(page), { opacity: false, blur: false, brightness: false });
    await page.locator('input[data-field="blur"]').fill('8');
    assert.equal((await appearance(page, 'uishortcuts-chat-bg-layer')).filter, 'blur(8px) brightness(0.7)');
    assert.equal((await appearance(page)).filter, 'blur(4px) brightness(0.7)');
    await page.locator('input[data-target="chat"]').uncheck();
    assert.deepEqual(await controls(page), { opacity: true, blur: true, brightness: false });
});

test('reopening controls reflects layout changes while closed and destroy removes owned UI', async t => {
    const page = await setup(t, true);
    await page.evaluate(() => {
        window.popover.open(document.getElementById('anchor'), { ...window.saved, targets: ['page'] });
        window.popover.close();
        document.body.classList.remove('astra-projecta-mobile-layout', 'astra-projecta-base-ui-body');
        window.popover.open(document.getElementById('anchor'), { ...window.saved, targets: ['page'] });
    });
    assert.deepEqual(await controls(page), { opacity: false, blur: false, brightness: false });
    await page.evaluate(() => { window.popover.destroy(); window.applier.destroy(); });
    assert.equal(await page.locator('#uishortcuts-chat-bg-layer, #uishortcuts-bg-styles, .uishortcuts-bg-popover, .uishortcuts-bg-host, .uishortcuts-bg-override').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.style.length), 0);
});
