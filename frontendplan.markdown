# Frontend Refactor Plan (Vanilla JS + Web Components)

## 1. Цель
Сделать фронтенд более идиоматичным и компактным без функциональных регрессий:
- уменьшить дублирование в UI/JS;
- вынести повторяемые UI-паттерны в переиспользуемые Web Components (Custom Elements);
- перейти к более тестируемой структуре (unit + DOM + smoke e2e);
- сохранить текущую UX-логику Telegram WebApp, offline/sync и feature toggles.

## 2. Текущее состояние (актуализировано: 2026-02-28)

### 2.1 Ключевые файлы
- `web/static/index.html` (919 строк) — основной UI-скелет; inline-обработчики удалены, управление событиями вынесено в JS.
- `web/static/js/app.js` (6406 строк) — основной модуль приложения (auth/API/state/рендер/charts/gestures); текущий главный hotspot по объему и смешанной ответственности.
- `web/static/js/workout.js` (2199 строк) — workout UI/CRUD/history/stats; string-template hotspot закрыт, рендер и биндинги переведены на DOM/event listeners.
- `web/static/js/data-store.js` — основной SWR/кэш/changes-поллинг+stream.
- `web/static/js/db.js`, `sync.js`, `push.js` — offline/storage/sync/push.
- `web/static/css/styles.css` (1792 строки) — общий стиль.

### 2.2 Быстрые метрики техдолга
- Inline DOM handlers в `index.html` (`onclick`, `onchange`, `onsubmit`, `oninput`, `onfocus`, `onmouseover`, `onmouseout`): `0`.
- Присваивания `innerHTML`:
  - `app.js`: `31`
  - `workout.js`: `0`
- Inline `onclick` в JS template-строках:
  - `app.js`: `0`
  - `workout.js`: `0`
- Тестовый контур: `35` test files, `193` test cases (Vitest/JSDOM).

### 2.3 Основные проблемы
1. Монолитность `app.js`:
   - в одном файле смешаны transport/state/render/event wiring;
   - feature-границы остаются размытыми.
2. `app.js` сохраняет значимый остаточный renderer-hotspot:
   - `innerHTML` остается в критичных ветках food/health/meds;
   - есть потенциал для дальнейшей декомпозиции на DOM helpers.
3. Монолитность `workout.js`:
   - смешаны transport/state/render/event wiring;
   - основные hotspot-рендеры закрыты, но файл остается крупным.
4. Stage 6 близок к завершению:
   - workout hotspot и inline handlers в `index.html` закрыты;
   - остается точечная зачистка renderer-участков в `app.js`.

### 2.4 Что уже работает хорошо и важно не сломать
- Telegram WebApp интеграция (initData, BackButton, alerts/confirms).
- Offline/Sync слой (Dexie + SyncManager + DataStore changes).
- Feature toggles (скрытие/показ вкладок и секций).
- Background/service worker поведение.

### 2.5 Прогресс по этапам
- Этап 0: `completed` (baseline сценарии зафиксированы, есть characterization тесты).
- Этап 1: `completed` (`vitest` + `jsdom`, моки Telegram/Web APIs, стабильный regression run).
- Этап 2: `completed` (DataStore fallback убран, общие helper-утилиты вынесены).
- Этап 3: `completed` (единый ModalManager + общий modal-history контракт).
- Этап 4: `completed` (shared tab-controller + bind для main/med/workout tabs).
- Этап 5: `completed` (`mt-modal` и `mt-setting-toggle` интегрированы в production-разметку).
- Этап 6: `in_progress` (workout hotspot и inline handlers в `index.html` закрыты; фокус смещен на остаточные `app.js` renderer-hotspots).
- Этап 7: `pending`.

## 3. Ограничения и принципы миграции
- Без big-bang переписывания.
- Каждая итерация должна быть обратимо маленькой.
- Сначала тестовый контур/characterization, потом перенос кода.
- Сохраняем vanilla JS (без React/Vue/Svelte).
- Web Components внедряем постепенно и в совместимом режиме с текущим DOM.

## 4. Целевая архитектура (incremental)

### 4.1 JS слои
- `core/`:
  - `api-client.js` (единый HTTP wrapper),
  - `state.js` (глобальное состояние/флаги),
  - `date-utils.js`, `dom-utils.js`, `formatters.js`.
- `features/`:
  - `bp/`, `weight/`, `food/`, `meds/`, `workouts/`, `settings/`, `health/`.
- `components/`:
  - Web Components + небольшие reusable renderer helpers.

### 4.2 Первые компоненты-кандидаты
1. `mt-tab-group` — управление активной вкладкой и событие `tabchange`.
2. `mt-modal` — общий shell, overlay, close semantics, escape/back hooks.
3. `mt-setting-toggle` — карточка настройки + toggle + описание.
4. `mt-day-picker` — выбор дней недели (med/workout).

## 5. Этапы работ

## Этап 0. Базовая фиксация поведения (до рефакторинга)
**Цель:** задокументировать инварианты текущего поведения и риски.

Задачи:
- Зафиксировать список критичных пользовательских сценариев (см. секцию 7).
- Добавить `frontend-testing-notes.md` (чек-листы ручного smoke до/после).
- Подготовить карту зависимостей `index.html -> global JS functions`.

Критерий завершения:
- есть явный baseline поведения для сравнения после каждого этапа.

## Этап 1. Тестовый контур
**Цель:** поставить инфраструктуру тестов для безопасной миграции.

Задачи:
- Подключить Node test stack (рекомендуемо: `vitest` + `jsdom`).
- Настроить запуск unit/DOM тестов без браузера Telegram.
- Подготовить моки:
  - `window.Telegram.WebApp`,
  - `fetch`,
  - `navigator.serviceWorker`,
  - `window.MedTrackerDB`.
- Добавить первые characterization tests:
  - переключение main/med/workout tabs,
  - open/close ключевых модалок,
  - feature toggles visibility,
  - базовое поведение `apiCall`/`apiCallDirect` при ошибках.

Критерий завершения:
- тесты запускаются локально командой вида `npm test`;
- есть минимальный зеленый regression-набор перед структурными правками.

## Этап 2. Удаление явного дублирования и утилиты
**Цель:** убрать дубли, не меняя внешнее поведение.

Задачи:
- Убрать/упростить fallback `ensureDataStoreAvailable` из `app.js`, оставив единственный источник правды: `data-store.js`.
- Вынести повторяющиеся helper-функции:
  - локальный datetime для `datetime-local`,
  - общую CSV download helper,
  - базовые modal open/close helper.
- Добавить unit-тесты на вынесенные helpers.

Критерий завершения:
- дублирование DataStore устранено;
- unit tests закрывают новые helper-утилиты.

## Этап 3. Декомпозиция modal infrastructure
**Цель:** единый механизм модалок, минимум копипасты.

Задачи:
- Ввести общий `ModalManager` (пока без полного Web Component, либо с легким адаптером).
- Перевести 2-3 самые типовые модалки (BP, Weight, Food) на него.
- Удалить повтор в `show*/close*` где возможно.
- Покрыть DOM-тестами:
  - open/close,
  - overlay behavior,
  - back button/popstate contract.

Критерий завершения:
- модалки работают через единый API;
- behavior совпадает с baseline.

## Этап 4. Tabs abstraction
**Цель:** унифицировать логику переключения вкладок.

Задачи:
- Вынести generic tab-controller (`activateTab`, `bindTabGroup`).
- Перевести main tabs + med/workout subtabs.
- Постепенно убрать inline `onclick` для табов.
- Добавить tests на события переключения и вызов loader-функций.

Критерий завершения:
- 3 разрозненных switch-функции сведены к общему механизму.

## Этап 5. Первый набор Web Components
**Цель:** закрепить компонентный подход без ломки всего UI.

Задачи:
- Реализовать `mt-modal` и `mt-setting-toggle`.
- Интегрировать в Settings + 1-2 модалки.
- Обеспечить обратную совместимость (временные адаптеры к текущим global handlers).
- Покрыть компоненты DOM-тестами (атрибуты, события, re-render).

Критерий завершения:
- компоненты используются в production-части разметки;
- уменьшено количество inline handlers в затронутых секциях.

## Этап 6. Безопасный рендер и снижение innerHTML
**Цель:** повысить надежность и предсказуемость UI-рендера.

Задачи:
- Для критичных секций заменить шаблонные string-concat на:
  - `createElement`/`append`, либо
  - безопасный template helper.
- Приоритет: sections с пользовательскими текстами и частыми правками.
- Добавить тесты на рендер edge-cases (empty/null/special chars).

Критерий завершения:
- заметно сокращено число `innerHTML` в hotspot-секциях;
- отсутствуют регрессии по отображению.

## Этап 7. Финализация и cleanup
**Цель:** закрепить структуру и упростить дальнейшую поддержку.

Задачи:
- Обновить dev-документацию фронтенда (`docs/frontend-architecture.md`).
- Удалить устаревшие адаптеры/unused helpers.
- Проверить размер/производительность и загрузку.
- Финальный smoke + regression прогон.

Критерий завершения:
- понятная структура,
- тесты покрывают критический контур,
- техдолг в hotspot-областях заметно снижен.

## 6. Риски и как их снижать
1. **Сломать Telegram-specific UX** (BackButton/popstate/alerts)
   - mitigation: обязательные regression tests + ручной smoke в Telegram WebApp.
2. **Сломать offline/sync semantics**
   - mitigation: не трогать sync-логику в ранних этапах; только интерфейсы вокруг.
3. **Накопить переходный «двойной» слой**
   - mitigation: у каждого временного адаптера ставить удаление в конкретном следующем этапе.
4. **Тесты станут хрупкими из-за DOM-деталей**
   - mitigation: фокус на behavior/event assertions, а не на пиксельные детали.

## 7. Минимальный regression-набор сценариев
1. Открытие приложения и initial tab.
2. Переключение main tabs.
3. Переключение meds/workouts subtabs.
4. Открытие/закрытие модалок: BP, Weight, Food, Med.
5. Сохранение BP/Weight (mock API success/fail).
6. Feature toggles в Settings и реакция видимости вкладок.
7. Push confirm modal open/confirm/snooze close.
8. Поведение back gesture/popstate при открытых модалках.
9. Offline-путь GET/POST через `apiCall` (ошибка сети/мок).
10. Data refresh trigger при `requestTabRefresh`.

## 8. Что делаем сразу после этого документа
Следующая сессия: **Этап 6 (оставшиеся hotspot-рендеры)**.
План на ближайший шаг:
1. Продолжить перевод `workout.js` hotspot-функций со string-template на DOM APIs малыми атомарными коммитами.
2. Для каждого hotspot-коммита: прогон целевых тестов + полный `pnpm test`.
3. Начать поэтапное удаление inline handlers из `index.html` в затронутых секциях.

---

## Примечание для следующего агента
- Тестовый baseline уже есть; не ломать его и не пропускать полный regression run перед push.
- Все изменения делать малыми PR-кусочками, проверяя regression-набор после каждого шага.
- Приоритет на сохранение поведения, а не на «идеальную» архитектуру за один проход.
