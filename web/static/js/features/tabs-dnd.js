function initTabsDragAndDrop(container, onOrderChange) {
    if (!container) return;

    let dragTimeout = null;
    let draggedElement = null;
    let isDragging = false;
    let startX = 0;
    let initialX = 0;

    container.addEventListener('pointerdown', handlePointerDown);
    container.addEventListener('pointermove', handlePointerMove);
    container.addEventListener('pointerup', handlePointerUp);
    container.addEventListener('pointercancel', handlePointerCancel);
    container.addEventListener('contextmenu', (e) => {
        if (isDragging) e.preventDefault(); // Prevent context menu during drag
    });

    function handlePointerDown(e) {
        // Only left clicks or primary touch
        if (!e.isPrimary || e.button !== 0 && e.button !== undefined) return;

        const target = e.target.closest('.tab');
        if (!target) return;

        // Start long-press timer
        startX = e.clientX;
        dragTimeout = setTimeout(() => {
            startDrag(e, target);
        }, 300); // 300ms long press to start drag
    }

    function handlePointerMove(e) {
        // If moved significantly before timeout, cancel drag initiation (it's probably a swipe/scroll)
        if (dragTimeout && !isDragging) {
            const dx = Math.abs(e.clientX - startX);
            if (dx > 10) {
                clearTimeout(dragTimeout);
                dragTimeout = null;
            }
        }

        if (!isDragging || !draggedElement) return;

        e.preventDefault(); // Prevent scrolling while dragging

        // Calculate translation relative to original position to keep under cursor
        const currentX = e.clientX;
        const dx = currentX - startX;

        draggedElement.style.transform = `translateX(${dx}px) scale(1.1)`;

        // Find element underneath
        const tabs = Array.from(container.querySelectorAll('.tab:not([style*="display: none"])'));

        // Find which tab we are hovering over
        let targetElement = null;
        for (const tab of tabs) {
            if (tab === draggedElement) continue;

            const rect = tab.getBoundingClientRect();
            // Check if pointer is horizontally within this tab
            if (currentX >= rect.left && currentX <= rect.right) {
                targetElement = tab;
                break;
            }
        }

        if (targetElement) {
            // Determine if we should insert before or after
            const targetRect = targetElement.getBoundingClientRect();
            const targetCenter = targetRect.left + targetRect.width / 2;

            // Measure before layout shift
            const beforeLeft = draggedElement.getBoundingClientRect().left;

            let domMoved = false;
            // Reorder in DOM immediately for visual feedback
            if (currentX < targetCenter) {
                if (draggedElement.nextElementSibling !== targetElement) {
                    container.insertBefore(draggedElement, targetElement);
                    domMoved = true;
                }
            } else {
                if (targetElement.nextElementSibling !== draggedElement) {
                    container.insertBefore(draggedElement, targetElement.nextElementSibling);
                    domMoved = true;
                }
            }

            if (domMoved) {
                // Measure after layout shift
                const afterLeft = draggedElement.getBoundingClientRect().left;
                // Calculate exact layout shift
                const shiftX = afterLeft - beforeLeft;
                // Adjust startX by layout shift so dx remains consistent with currentX
                startX += shiftX;
                // Force transform update immediately to avoid visual jump
                draggedElement.style.transform = `translateX(${currentX - startX}px) scale(1.1)`;
            }
        }
    }

    function handlePointerUp(e) {
        if (dragTimeout) {
            clearTimeout(dragTimeout);
            dragTimeout = null;
        }

        if (isDragging) {
            e.preventDefault();
            endDrag();
        }
    }

    function handlePointerCancel(e) {
        if (dragTimeout) {
            clearTimeout(dragTimeout);
            dragTimeout = null;
        }
        if (isDragging) {
            endDrag();
        }
    }

    function startDrag(e, element) {
        isDragging = true;
        draggedElement = element;
        container.setPointerCapture(e.pointerId);

        // Visual cues
        draggedElement.style.transition = 'none';
        draggedElement.style.transform = 'scale(1.1)';
        draggedElement.style.zIndex = '100';
        draggedElement.style.position = 'relative';
        draggedElement.style.opacity = '0.9';

        // Haptic feedback if available
        if (window.navigator && window.navigator.vibrate) {
            window.navigator.vibrate(50);
        } else if (window.Telegram?.WebApp?.HapticFeedback) {
             window.Telegram.WebApp.HapticFeedback.impactOccurred('medium');
        }
    }

    function endDrag() {
        if (!draggedElement) return;

        // Reset styles
        draggedElement.style.transition = 'transform 0.2s';
        draggedElement.style.transform = '';
        draggedElement.style.zIndex = '';
        draggedElement.style.position = '';
        draggedElement.style.opacity = '';

        setTimeout(() => {
            if (draggedElement) {
                draggedElement.style.transition = '';
            }
            draggedElement = null;
            isDragging = false;
        }, 200);

        // Capture new order and notify
        const newOrder = Array.from(container.querySelectorAll('.tab'))
            .map(t => t.dataset.tab)
            .filter(Boolean);

        if (typeof onOrderChange === 'function') {
            onOrderChange(newOrder);
        }
    }
}

// Export for global use
window.initTabsDragAndDrop = initTabsDragAndDrop;