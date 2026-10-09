import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ICONS_PATH = path.join(REPO_ROOT, 'web/static/js/components/wg-icons.js');
const KIT_DIR = path.join(REPO_ROOT, 'docs/design/claude-design/ui_kits/app-v2');

function loadEnv(body = '') {
    const dom = new JSDOM(`<!DOCTYPE html><body>${body}</body>`, {
        url: 'https://example.test/',
        runScripts: 'outside-only',
    });
    dom.window.eval(fs.readFileSync(ICONS_PATH, 'utf8'));
    return { window: dom.window, document: dom.window.document };
}

// Every icon name the kit spec uses: data-icon values in its pages plus the
// names its icons.js defines.
function kitIconNames() {
    const names = new Set();
    for (const f of fs.readdirSync(KIT_DIR).filter((f) => f.endsWith('.html'))) {
        const html = fs.readFileSync(path.join(KIT_DIR, f), 'utf8');
        for (const m of html.matchAll(/data-icon="([a-z][a-z-]*)"/g)) names.add(m[1]);
    }
    const js = fs.readFileSync(path.join(KIT_DIR, 'icons.js'), 'utf8');
    const block = js.slice(js.indexOf('var P={'), js.indexOf('};'));
    for (const m of block.matchAll(/(?:^|,)\s*'?([a-z][a-z-]*)'?:'/gm)) names.add(m[1]);
    return [...names];
}

describe('WGIcons — kit v2 registry', () => {
    it('resolves every icon name used by the kit', () => {
        const { window } = loadEnv();
        const names = kitIconNames();
        expect(names.length).toBeGreaterThan(50);
        for (const name of names) {
            expect(() => window.WGIcons.iconSvg(name), name).not.toThrow();
        }
    });

    it('keeps existing names and still throws on unknown ones', () => {
        const { window } = loadEnv();
        for (const name of ['home', 'activity', 'apple', 'pill', 'scale', 'dumbbell', 'heart', 'settings', 'pencil', 'trash', 'close', 'chevronLeft']) {
            expect(window.WGIcons.iconSvg(name).getAttribute('data-wg-icon')).toBe(name);
        }
        expect(() => window.WGIcons.iconSvg('no-such-icon')).toThrow(/unknown icon/);
    });

    it('aliases resolve to the same path as their target', () => {
        const { window } = loadEnv();
        const { paths, aliases } = window.WGIcons;
        expect(aliases).toMatchObject({ health: 'heart', gear: 'settings', food: 'apple', edit: 'pencil', x: 'close', 'chev-l': 'chevronLeft', 'chev-r': 'chevronRight', 'chev-d': 'chevronDown' });
        for (const [alias, target] of Object.entries(aliases)) {
            expect(paths[alias]).toBe(paths[target]);
            expect(window.WGIcons.iconSvg(alias).innerHTML).toBe(window.WGIcons.iconSvg(target).innerHTML);
        }
    });
});

describe('WGIcons.hydrate', () => {
    it('replaces placeholders with inline svg and is idempotent', () => {
        const { window, document } = loadEnv(
            '<div id="a"><i class="wg-ico" data-icon="pill"></i><i class="wg-ico" data-icon="chev-u"></i></div>' +
            '<button id="b" data-icon="barcode">Scan</button>'
        );
        window.WGIcons.hydrate();
        const icons = document.querySelectorAll('#a .wg-ico');
        expect(icons[0].querySelector('svg').getAttribute('data-wg-icon')).toBe('pill');
        expect(icons[1].querySelector('svg').getAttribute('data-wg-icon')).toBe('chev-u');
        const first = icons[0].firstChild;
        window.WGIcons.hydrate(document);
        expect(icons[0].firstChild).toBe(first);
        expect(icons[0].querySelectorAll('svg').length).toBe(1);
        // Non-.wg-ico data-icon users are untouched.
        expect(document.getElementById('b').textContent).toBe('Scan');
    });

    it('hydrates only the given subtree, including the root itself', () => {
        const { window, document } = loadEnv(
            '<i id="out" class="wg-ico" data-icon="gear"></i><i id="root" class="wg-ico" data-icon="x"></i>'
        );
        window.WGIcons.hydrate(document.getElementById('root'));
        expect(document.getElementById('root').querySelector('svg')).not.toBeNull();
        expect(document.getElementById('out').querySelector('svg')).toBeNull();
    });
});
