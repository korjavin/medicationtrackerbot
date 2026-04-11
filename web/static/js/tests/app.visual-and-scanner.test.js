import { beforeEach, describe, expect, it, vi } from 'vitest';
import { allowConsoleNoise } from './helpers/setup.js';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function setElementSize(element, width, height) {
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: height });
}

function isoDaysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

function buildHealthOverviewPayload() {
  return {
    sleep_stats_7d: [
      {
        date: '2026-02-20',
        deep_mins: 80,
        awake_mins: 20,
        light_mins: 220,
        rem_mins: 70,
        total_mins: 390,
        heart_rate_avg: 58
      }
    ],
    average_sleep_hours_7d: 6.5,
    average_sleep_hours_30d: 6.9,
    step_stats_7d: [{ day: '2026-02-20', steps: 9200 }],
    average_steps_7d: 9200,
    average_steps_30d: 8800,
    heart_rate_history_7d: [{ timestamp: Date.now(), min: 58, max: 84, avg: 70 }],
    average_heart_rate_7d: 70,
    average_heart_rate_30d: 72,
    spo2_history_7d: [{ timestamp: Date.now(), min: 95, max: 99, avg: 97 }],
    average_spo2_7d: 97,
    average_spo2_30d: 96,
    stress_history_7d: [{ timestamp: Date.now(), min: 20, max: 65, avg: 40 }],
    average_stress_7d: 40,
    average_stress_30d: 44
  };
}

describe('app.js charts, scanner and visualization helpers', () => {
  beforeEach(() => {
    allowConsoleNoise();
  });

  it('scanner helpers sanitize/route decoded values and handle detector fallbacks', () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      let ctorCalls = 0;
      window.BarcodeDetector = class BarcodeDetectorMock {
        constructor(options) {
          ctorCalls += 1;
          if (options && options.formats) {
            throw new Error('formats unsupported');
          }
        }
      };

      const detector = window.createFoodBarcodeDetector();
      expect(detector).toBeTruthy();
      expect(ctorCalls).toBe(2);
      expect(window.createFoodBarcodeDetector()).toBe(detector);

      const barcodeChangeSpy = vi.fn();
      const closeScannerSpy = vi.fn();
      window.onFoodBarcodeChange = barcodeChangeSpy;
      window.closeFoodScannerModal = closeScannerSpy;

      expect(window.sanitizeScannedValue(' \u200B12-34-56 ')).toEqual({ text: '12-34-56', numeric: '' });
      expect(window.sanitizeScannedValue('ean: 1234567890123')).toEqual({ text: 'ean: 1234567890123', numeric: '1234567890123' });
      expect(window.sanitizeScannedValue('abc')).toEqual({ text: 'abc', numeric: '' });

      document.getElementById('food-barcode').value = '';
      expect(window.handleDecodedValue('ean: 1234567890123')).toBe(true);
      expect(document.getElementById('food-barcode').value).toBe('1234567890123');
      expect(barcodeChangeSpy).toHaveBeenCalledTimes(1);
      expect(closeScannerSpy).toHaveBeenCalledTimes(1);

      const alertSpy = vi.fn();
      window.Telegram.WebApp.showAlert = alertSpy;
      document.getElementById('food-name').value = '';
      window.handleDecodedValue('hello from qr');
      expect(document.getElementById('food-name').value).toBe('hello from qr');
      expect(alertSpy).toHaveBeenCalledWith('Scanned QR text was added to Food Name.');
    } finally {
      cleanup();
    }
  });

  it('scanner start/stop and modal open/close cover secure-context and capability branches', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const status = document.getElementById('food-scanner-status');
      const modal = document.getElementById('food-scanner-modal');
      const video = document.getElementById('food-scanner-video');

      Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
      await window.startFoodScanner();
      expect(status.innerText).toContain('HTTPS');

      Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
      Object.defineProperty(window.navigator, 'mediaDevices', { configurable: true, value: undefined });
      await window.startFoodScanner();
      expect(status.innerText).toContain('unavailable');

      Object.defineProperty(window.navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: vi.fn() }
      });
      window.BarcodeDetector = undefined;
      await window.startFoodScanner();
      expect(status.innerText).toContain('Live scan is unavailable');

      window.BarcodeDetector = function BarcodeDetectorMock() {};
      window.navigator.mediaDevices.getUserMedia = vi.fn().mockRejectedValue(new Error('denied'));
      await window.startFoodScanner();
      expect(status.innerText).toContain('Camera access denied');

      const trackStopSpy = vi.fn();
      video.pause = vi.fn();
      video.play = vi.fn().mockResolvedValue(undefined);
      video.srcObject = { getTracks: () => [{ stop: trackStopSpy }] };
      window.stopFoodScanner();
      expect(video.pause).toHaveBeenCalled();

      const startSpy = vi.spyOn(window, 'startFoodScanner').mockImplementation(() => {});
      const stopSpy = vi.spyOn(window, 'stopFoodScanner').mockImplementation(() => {});
      window.openFoodScannerModal();
      expect(modal.classList.contains('hidden')).toBe(false);
      expect(startSpy).toHaveBeenCalledTimes(1);
      window.closeFoodScannerModal();
      expect(modal.classList.contains('hidden')).toBe(true);
      expect(stopSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('renders BP and weight visualizations with realistic data', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const bpChart = document.getElementById('bpChart');
      const weightChart = document.getElementById('weightChart');
      const vitals = document.createElement('div');
      const sleep = document.createElement('div');
      const steps = document.createElement('div');
      vitals.id = 'heartRateChart';
      sleep.id = 'sleepChartContainer';
      steps.id = 'stepsChartContainer';
      document.body.appendChild(vitals);
      document.body.appendChild(sleep);
      document.body.appendChild(steps);

      setElementSize(bpChart, 360, 240);
      setElementSize(weightChart, 360, 240);
      setElementSize(vitals, 360, 220);
      setElementSize(sleep, 360, 240);
      setElementSize(steps, 360, 240);

      window.renderBPChart([], {});
      expect(bpChart.textContent).toContain('No data available');

      const readings = [
        { id: 1, measured_at: isoDaysAgo(2), systolic: 118, diastolic: 76, pulse: 60 },
        { id: 2, measured_at: isoDaysAgo(1), systolic: 128, diastolic: 84, pulse: 64, isLocal: true, localId: 55 },
        { id: 3, measured_at: isoDaysAgo(0), systolic: 145, diastolic: 95, pulse: 72 }
      ];
      window.renderBPChart(readings, { systolic_target: 130, diastolic_target: 85 });
      expect(bpChart.querySelector('svg')).toBeTruthy();
      expect(bpChart.querySelectorAll('circle').length).toBeGreaterThan(2);

      // BP chart uses spline paths (not line segments) for systolic and diastolic
      const chartPaths = bpChart.querySelectorAll('path.chart-line');
      expect(chartPaths.length).toBeGreaterThanOrEqual(2); // systolic + diastolic (+ optional pulse)
      // Verify no <line> segments for data series (only grid/average lines remain)
      const dataLines = Array.from(bpChart.querySelectorAll('line')).filter(
        l => !l.classList.contains('chart-grid') && !l.classList.contains('bp-chart-avg-line')
      );
      expect(dataLines.length).toBe(0);

      window.renderBPAverages({
        stats_14: { days: 12, systolic: 123, diastolic: 79 },
        stats_30: { days: 28, systolic: 126, diastolic: 81 }
      });
      expect(document.getElementById('bp-averages').innerHTML).toContain('14d');
      expect(document.querySelectorAll('#bp-averages .bp-avg-item')).toHaveLength(2);

      window.renderBPAverages(null);
      expect(document.getElementById('bp-averages').children).toHaveLength(0);

      window.renderBPReadings(readings);
      const bpListHtml = document.getElementById('bp-list').innerHTML;
      expect(bpListHtml).toContain('Today');
      expect(bpListHtml).toContain('Yesterday');
      expect(bpListHtml).toContain('Pending');

      window.MedTrackerDB = {
        BPStore: {
          getPending: vi.fn().mockResolvedValue([
            { localId: 99, measured_at: isoDaysAgo(0), systolic: 111, diastolic: 70, pulse: 55 }
          ])
        }
      };
      await window._renderBPData(readings, {}, { stats_14: { days: 7, systolic: 120, diastolic: 80 } });
      expect(document.getElementById('bp-list').innerHTML).toContain('Pending');

      const logs = [
        { measured_at: isoDaysAgo(10), weight: 83.4, weight_trend: 83.0 },
        { measured_at: isoDaysAgo(7), weight: 82.6, weight_trend: 82.5 },
        { measured_at: isoDaysAgo(3), weight: 81.4, weight_trend: 81.8 },
        { measured_at: isoDaysAgo(0), weight: 80.9, weight_trend: 81.2 }
      ];
      const now = new Date();
      const goalData = {
        goal: 75,
        goal_date: new Date(now.getTime() + 20 * 24 * 60 * 60 * 1000).toISOString(),
        highest_weight: 85,
        highest_date: new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000).toISOString()
      };

      window.renderWeightChart(logs, goalData);
      expect(weightChart.querySelector('svg')).toBeTruthy();
      expect(document.getElementById('weight-stats').innerHTML).toContain('Trend:');
      expect(document.querySelectorAll('#weight-stats .weight-stat-item').length).toBeGreaterThan(2);

      window.renderWeightStats({
        trendWeight: 80.5,
        weeklyRate: undefined,
        forecastDate: null
      });
      expect(document.getElementById('weight-stats').textContent).toContain('Forecast: Unknown');

      const tsBase = Date.now() - (24 * 60 * 60 * 1000);
      window.renderVitalsLineChart('heartRateChart', [
        { timestamp: tsBase, min: 58, max: 84, avg: 71 },
        { timestamp: tsBase + (2 * 60 * 60 * 1000), min: 60, max: 86, avg: 73 },
        { timestamp: tsBase + (8 * 60 * 60 * 1000), min: 59, max: 82, avg: 70 }
      ], '#ff3b30', 40, 160);
      expect(vitals.querySelector('svg')).toBeTruthy();

      window.renderSleepChart([
        {
          date: '2026-02-01',
          deep_mins: 90,
          awake_mins: 20,
          light_mins: 200,
          rem_mins: 80,
          total_mins: 390,
          heart_rate_avg: 58
        },
        {
          date: '2026-02-02',
          deep_mins: 70,
          awake_mins: 30,
          light_mins: 220,
          rem_mins: 70,
          total_mins: 390,
          heart_rate_avg: 62
        }
      ]);
      expect(sleep.querySelector('svg')).toBeTruthy();

      window.renderStepsChart([
        { day: '2026-02-01', steps: 8400 },
        { day: '2026-02-02', steps: 11200 }
      ]);
      expect(steps.querySelector('svg')).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  it('math and trend helpers return stable outputs for edge and normal cases', () => {
    const { window, cleanup } = loadFrontendEnv();

    try {
      expect(window.ChartUtils.catmullRomSpline([[10, 20]])).toBe('M 10,20');
      expect(window.ChartUtils.catmullRomSpline([[10, 20], [30, 40]])).toBe('M 10,20 L 30,40');
      expect(window.ChartUtils.catmullRomSpline([[0, 0], [10, 10], [20, 5]])).toContain('L');

      expect(window.linearRegression([{ x: 0, y: 100 }, { x: 2, y: 96 }])).toEqual({
        slope: -2,
        intercept: 100
      });
      expect(window.linearRegression([{ x: 0, y: 1 }])).toBeNull();

      expect(window.ChartUtils.calculateYAxisTicks(72, 98)).toEqual([75, 80, 85, 90, 95]);
      expect(window.ChartUtils.calculateYAxisTicks(72, 180).length).toBeGreaterThan(4);

      expect(window.calculateWeightStats([], { goal: 70 })).toBeNull();

      const stats = window.calculateWeightStats([
        { measured_at: isoDaysAgo(0), weight: 82, weight_trend: 81.8 },
        { measured_at: isoDaysAgo(7), weight: 83 },
        { measured_at: isoDaysAgo(14), weight: 84 }
      ], { goal: 76 });

      expect(stats.currentWeight).toBe(82);
      expect(stats.goalWeight).toBe(76);
      expect(stats.deltaFromGoal).toBe(6);
      expect(typeof stats.weeklyRate).toBe('number');
    } finally {
      cleanup();
    }
  });

  it('loadHealthOverview renders error and chart sections from fetched data', async () => {
    vi.useFakeTimers();
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const payload = buildHealthOverviewPayload();

      const loadSWRSpy = vi
        .fn()
        .mockImplementationOnce(async ({ onFresh }) => {
          await onFresh(null, null);
          return { cached: null, fresh: null };
        })
        .mockImplementationOnce(async ({ onFresh }) => {
          await onFresh(payload, null);
          return { cached: null, fresh: payload };
        });

      window.DataStore.loadSWR = loadSWRSpy;
      const vitalsSpy = vi.spyOn(window, 'renderVitalsLineChart').mockImplementation(() => {});
      const sleepSpy = vi.spyOn(window, 'renderSleepChart').mockImplementation(() => {});
      const stepsSpy = vi.spyOn(window, 'renderStepsChart').mockImplementation(() => {});

      await window.loadHealthOverview();
      expect(document.getElementById('health-overview-content').innerHTML).toContain('Failed to load health metrics');

      await window.loadHealthOverview();
      await vi.runAllTimersAsync();

      const html = document.getElementById('health-overview-content').innerHTML;
      expect(html).toContain('Sleep');
      expect(html).toContain('Steps');
      expect(html).toContain('Heart Rate');
      expect(html).toContain('SpO2');
      expect(html).toContain('Stress Level');
      expect(vitalsSpy).toHaveBeenCalledTimes(3);
      expect(sleepSpy).toHaveBeenCalledTimes(1);
      expect(stepsSpy).toHaveBeenCalledTimes(1);
      expect(loadSWRSpy).toHaveBeenCalledWith(expect.objectContaining({
        key: 'health_overview',
        tags: ['health'],
        allowNullFresh: true,
        fetcher: expect.any(Function)
      }));
    } finally {
      vi.useRealTimers();
      cleanup();
    }
  });

  it('loadHealthOverview renders cached data before fresh request resolves', async () => {
    vi.useFakeTimers();
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const cachedPayload = buildHealthOverviewPayload();
      const freshPayload = {
        ...buildHealthOverviewPayload(),
        average_steps_7d: 10000,
        step_stats_7d: [{ day: '2026-02-20', steps: 10000 }]
      };

      let resolveFresh;
      const freshPromise = new Promise((resolve) => {
        resolveFresh = () => resolve(freshPayload);
      });

      window.DataStore.getCached = vi.fn().mockResolvedValue(cachedPayload);
      window.DataStore.fetchFresh = vi.fn().mockImplementation(() => freshPromise);

      const loadPromise = window.loadHealthOverview();
      await Promise.resolve();
      await vi.runAllTimersAsync();

      const htmlBeforeFresh = document.getElementById('health-overview-content').innerHTML;
      expect(htmlBeforeFresh).toContain('Sleep');
      expect(htmlBeforeFresh).toContain('9,200 steps (7d avg)');
      expect(document.getElementById('health-overview-loading').style.display).toBe('none');

      resolveFresh();
      await loadPromise;
      await vi.runAllTimersAsync();

      const htmlAfterFresh = document.getElementById('health-overview-content').innerHTML;
      expect(htmlAfterFresh).toContain('10,000 steps (7d avg)');
      expect(window.DataStore.fetchFresh).toHaveBeenCalledWith(
        'health_overview',
        expect.any(Function),
        ['health']
      );
    } finally {
      vi.useRealTimers();
      cleanup();
    }
  });
});
