/**
 * @vitest-environment jsdom
 *
 * tabs-dnd cleanup regression — after a drag ends, the dragged tab must not
 * retain ANY inline styles set by the DnD machinery (transform, position,
 * z-index, opacity, transition). Stale inline styles leaked into the CSS-driven
 * .tab.active state caused sibling tabs to overlap visually after reorder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TABS_DND_JS = path.resolve(__dirname, '../features/tabs-dnd.js');

function makePointerEvent(type, { clientX = 0, pointerId = 1, isPrimary = true, button = 0, target = null } = {}) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'isPrimary', { value: isPrimary });
  Object.defineProperty(ev, 'pointerId', { value: pointerId });
  Object.defineProperty(ev, 'button', { value: button });
  Object.defineProperty(ev, 'clientX', { value: clientX });
  if (target) Object.defineProperty(ev, 'target', { value: target });
  return ev;
}

describe('tabs-dnd cleanup', () => {
  let container;
  let tabA;
  let tabB;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<nav id="tabs"><button class="tab active" data-tab="bp"></button><button class="tab" data-tab="weight"></button></nav>';
    container = document.getElementById('tabs');
    tabA = container.querySelector('[data-tab="bp"]');
    tabB = container.querySelector('[data-tab="weight"]');
    container.setPointerCapture = () => {};
    const source = fs.readFileSync(TABS_DND_JS, 'utf8');
    // eslint-disable-next-line no-eval
    eval(source);
    window.initTabsDragAndDrop(container, () => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    delete window.initTabsDragAndDrop;
    document.body.innerHTML = '';
  });

  function startAndEndDrag(target) {
    const down = makePointerEvent('pointerdown', { clientX: 50, target });
    container.dispatchEvent(down);
    vi.advanceTimersByTime(310);
    const up = makePointerEvent('pointerup', { clientX: 50, target });
    container.dispatchEvent(up);
  }

  it('leaves no inline styles on the dragged tab after the settle timeout', () => {
    expect(tabA.getAttribute('style')).toBeNull();

    startAndEndDrag(tabA);

    expect(tabA.getAttribute('style')).not.toBeNull();
    expect(tabA.style.transition).toBe('transform 0.2s');

    vi.advanceTimersByTime(210);
    expect(tabA.getAttribute('style')).toBeNull();
    expect(tabA.style.transform).toBe('');
    expect(tabA.style.zIndex).toBe('');
    expect(tabA.style.position).toBe('');
    expect(tabA.style.opacity).toBe('');
    expect(tabA.style.transition).toBe('');
  });

  it('preserves inline styles that existed BEFORE the drag', () => {
    tabA.setAttribute('style', 'outline: 2px dashed red;');

    startAndEndDrag(tabA);
    vi.advanceTimersByTime(210);

    expect(tabA.getAttribute('style')).toBe('outline: 2px dashed red;');
  });

  it('back-to-back drags on different tabs both clean up independently', () => {
    startAndEndDrag(tabA);
    vi.advanceTimersByTime(50);
    startAndEndDrag(tabB);
    vi.advanceTimersByTime(500);

    expect(tabA.getAttribute('style')).toBeNull();
    expect(tabB.getAttribute('style')).toBeNull();
  });
});
