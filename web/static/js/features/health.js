(function () {
    function renderHealthOverviewContent(content, data) {
        content.replaceChildren();

        const renderVitalGroup = (id, title, history, color, min, max, stat7d, stat30d, unit) => {
            if (history && history.length > 0) {
                const wrapper = document.createElement('div');
                wrapper.className = 'health-chart-wrapper';
                const h3 = document.createElement('h3');
                h3.textContent = title;
                const chartContainer = document.createElement('div');
                chartContainer.id = id + 'ChartContainer';
                chartContainer.className = 'health-chart-container';
                const statDiv = document.createElement('div');
                statDiv.className = 'health-chart-stat';
                statDiv.textContent = `${stat7d} ${unit} (7d avg) | ${stat30d} ${unit} (30d avg)`;
                wrapper.appendChild(h3);
                wrapper.appendChild(chartContainer);
                wrapper.appendChild(statDiv);
                content.appendChild(wrapper);
                setTimeout(() => renderVitalsLineChart(id + 'ChartContainer', history, color, min, max), 0);
            }
        };

        if (data.sleep_stats_7d && data.sleep_stats_7d.length > 0) {
            const wrapper = document.createElement('div');
            wrapper.className = 'health-chart-wrapper';
            const h3 = document.createElement('h3');
            h3.textContent = 'Sleep';
            const chartContainer = document.createElement('div');
            chartContainer.id = 'sleepChartContainer';
            chartContainer.className = 'health-chart-container-tall';
            const legend = document.createElement('div');
            legend.className = 'health-chart-legend';

            const createLegendItem = (color, text, isLine = false) => {
                const item = document.createElement('div');
                item.className = 'health-legend-item';
                const badge = document.createElement('span');
                badge.className = isLine ? 'health-legend-badge-line' : 'health-legend-badge';
                badge.style.background = color;
                item.appendChild(badge);
                item.appendChild(document.createTextNode(text));
                return item;
            };

            legend.appendChild(createLegendItem('#5a2d9c', 'Deep'));
            legend.appendChild(createLegendItem('#2481cc', 'Light'));
            legend.appendChild(createLegendItem('#c161d9', 'REM'));
            legend.appendChild(createLegendItem('#e5b220', 'Awake'));
            legend.appendChild(createLegendItem('#ff3b30', 'HR', true));

            const statDiv = document.createElement('div');
            statDiv.className = 'health-chart-stat-spaced';
            statDiv.textContent = `${data.average_sleep_hours_7d.toFixed(1)} hrs (7d avg) | ${data.average_sleep_hours_30d.toFixed(1)} hrs (30d avg)`;

            wrapper.appendChild(h3);
            wrapper.appendChild(chartContainer);
            wrapper.appendChild(legend);
            wrapper.appendChild(statDiv);
            content.appendChild(wrapper);
            setTimeout(() => renderSleepChart(data.sleep_stats_7d), 0);
        }

        if (data.step_stats_7d && data.step_stats_7d.length > 0) {
            const wrapper = document.createElement('div');
            wrapper.className = 'health-chart-wrapper';
            const h3 = document.createElement('h3');
            h3.textContent = 'Steps';
            const chartContainer = document.createElement('div');
            chartContainer.id = 'stepsChartContainer';
            chartContainer.className = 'health-chart-container-tall';
            const statDiv = document.createElement('div');
            statDiv.className = 'health-chart-stat-spaced';
            statDiv.textContent = `${data.average_steps_7d.toLocaleString()} steps (7d avg) | ${data.average_steps_30d.toLocaleString()} steps (30d avg)`;
            wrapper.appendChild(h3);
            wrapper.appendChild(chartContainer);
            wrapper.appendChild(statDiv);
            content.appendChild(wrapper);
            setTimeout(() => renderStepsChart(data.step_stats_7d), 0);
        }

        renderVitalGroup('heartRate', 'Heart Rate', data.heart_rate_history_7d, '#ff3b30', 40, 160, data.average_heart_rate_7d, data.average_heart_rate_30d, 'bpm');
        renderVitalGroup('spo2', 'SpO2', data.spo2_history_7d, '#32ade6', 85, 100, data.average_spo2_7d, data.average_spo2_30d, '%');
        renderVitalGroup('stress', 'Stress Level', data.stress_history_7d, '#ff9500', 0, 100, data.average_stress_7d, data.average_stress_30d, '/ 100');

        const disclaimer = document.createElement('p');
        disclaimer.className = 'chart-disclaimer';
        disclaimer.textContent = 'This data is gathered from your synced .nxk backups.';
        content.appendChild(disclaimer);
    }

    function renderHealthOverviewError(content) {
        const errP = document.createElement('p');
        errP.className = 'text-danger';
        errP.textContent = 'Failed to load health metrics';
        content.replaceChildren(errP);
        content.classList.remove('hidden');
    }

    async function loadHealthOverview() {
        const content = document.getElementById('health-overview-content');
        const loading = document.getElementById('health-overview-loading');
        if (!content || !loading) return;
        loading.style.display = 'block';

        if (window.DataStore) {
            await window.DataStore.loadSWR({
                key: 'health_overview',
                tags: ['health'],
                fetcher: async () => await window.apiCall('/api/health/overview', 'GET'),
                allowNullFresh: true,
                onCached: async (cached) => {
                    if (!cached) return;
                    renderHealthOverviewContent(content, cached);
                    loading.style.display = 'none';
                    content.classList.remove('hidden');
                },
                onFresh: async (fresh, cached) => {
                    loading.style.display = 'none';
                    if (!fresh) {
                        if (!cached) renderHealthOverviewError(content);
                        return;
                    }
                    renderHealthOverviewContent(content, fresh);
                    content.classList.remove('hidden');
                },
                onError: async (e, cached) => {
                    console.error('Failed to load health overview:', e);
                    loading.style.display = 'none';
                    if (!cached) renderHealthOverviewError(content);
                }
            });
        }
    }

    function renderVitalsLineChart(containerId, data, color, yMin, yMax) {
        const container = document.getElementById(containerId);
        if (!container || !data || data.length === 0) return;
        const totalWidth = container.clientWidth;
        const leftPadding = 35, rightPadding = 10, topPadding = 20, bottomPadding = 30;
        const chartWidth = totalWidth - leftPadding - rightPadding;
        const chartHeight = container.clientHeight - topPadding - bottomPadding;
        if (chartWidth <= 0 || chartHeight <= 0) return;
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("width", "100%"); svg.setAttribute("height", "100%");
        svg.setAttribute("viewBox", `0 0 ${totalWidth} ${container.clientHeight}`);
        svg.classList.add('svg-chart');
        const minTime = data[0].timestamp, maxTime = data[data.length - 1].timestamp;
        const timeRange = Math.max(maxTime - minTime, 1), valRange = Math.max(yMax - yMin, 1);
        const ySteps = 4;
        for (let i = 0; i <= ySteps; i++) {
            const val = Math.round(yMin + (i / ySteps) * valRange);
            const y = topPadding + chartHeight - (i / ySteps) * chartHeight;
            const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
            text.setAttribute("x", leftPadding - 8); text.setAttribute("y", y + 4);
            text.setAttribute("text-anchor", "end"); text.setAttribute("fill", "var(--hint-color)");
            text.setAttribute("font-size", "10px"); text.textContent = val;
            svg.appendChild(text);
            const gridLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
            gridLine.setAttribute("x1", leftPadding); gridLine.setAttribute("y1", y);
            gridLine.setAttribute("x2", leftPadding + chartWidth); gridLine.setAttribute("y2", y);
            gridLine.setAttribute("stroke", "var(--hint-color)");
            gridLine.setAttribute("stroke-opacity", i === 0 ? "0.6" : "0.2");
            svg.appendChild(gridLine);
        }
        const getX = (ts) => leftPadding + ((ts - minTime) / timeRange) * chartWidth;
        const getY = (val) => {
            const clamped = Math.max(yMin, Math.min(yMax, val));
            return topPadding + chartHeight - ((clamped - yMin) / valRange) * chartHeight;
        };
        const svgNs = "http://www.w3.org/2000/svg";
        const gradId = 'grad-vitals-' + containerId.replace(/[^a-zA-Z0-9]/g, '');
        window.ChartUtils.createGradient(svgNs, svg, gradId, color, 0.25);
        const areaPath = document.createElementNS(svgNs, "path");
        let dArea = "";
        data.forEach((pt, i) => { const cx = getX(pt.timestamp), cy = getY(pt.max); dArea += (i === 0 ? `M ${cx},${cy}` : ` L ${cx},${cy}`); });
        for (let i = data.length - 1; i >= 0; i--) { const cx = getX(data[i].timestamp), cy = getY(data[i].min); dArea += ` L ${cx},${cy}`; }
        dArea += " Z";
        areaPath.setAttribute("d", dArea); areaPath.setAttribute("fill", `url(#${gradId})`);
        svg.appendChild(areaPath);
        let currentPath = "", paths = [], lastTs = null;
        data.forEach((pt, i) => {
            const cx = getX(pt.timestamp), cy = getY(pt.avg);
            if (lastTs !== null && (pt.timestamp - lastTs) > 3 * 3600 * 1000) { paths.push(currentPath); currentPath = `M ${cx},${cy}`; }
            else { currentPath += (currentPath === "" ? `M ${cx},${cy}` : ` L ${cx},${cy}`); }
            lastTs = pt.timestamp;
        });
        if (currentPath !== "") paths.push(currentPath);
        paths.forEach(p => {
            const pathObj = document.createElementNS("http://www.w3.org/2000/svg", "path");
            pathObj.setAttribute("d", p); pathObj.setAttribute("fill", "none"); pathObj.setAttribute("stroke", color);
            pathObj.setAttribute("stroke-width", "2"); pathObj.setAttribute("stroke-linecap", "round"); pathObj.setAttribute("stroke-linejoin", "round");
            svg.appendChild(pathObj);
        });
        const labelCount = 4;
        for (let i = 0; i <= labelCount; i++) {
            const ts = minTime + (timeRange * (i / labelCount)), dt = new Date(ts), txt = `${dt.getMonth() + 1}/${dt.getDate()}`;
            const x = getX(ts), y = topPadding + chartHeight + 15;
            const xLbl = document.createElementNS("http://www.w3.org/2000/svg", "text");
            xLbl.setAttribute("x", x); xLbl.setAttribute("y", y); xLbl.setAttribute("text-anchor", "middle");
            xLbl.setAttribute("fill", "var(--hint-color)"); xLbl.setAttribute("font-size", "10px"); xLbl.textContent = txt;
            svg.appendChild(xLbl);
        }
        container.appendChild(svg);
    }

    function renderSleepChart(stats) {
        const container = document.getElementById('sleepChartContainer');
        if (!container) return;
        const totalWidth = container.clientWidth;
        const leftPadding = 35, rightPadding = 20, topPadding = 20, bottomPadding = 30;
        const chartWidth = totalWidth - leftPadding - rightPadding;
        const chartHeight = container.clientHeight - topPadding - bottomPadding;
        if (chartWidth <= 0 || chartHeight <= 0) return;
        const maxMins = Math.max(...stats.map(d => d.total_mins || 0), 1);
        const hrValues = stats.map(d => d.heart_rate_avg || 0).filter(v => v > 0);
        const minHR = hrValues.length ? Math.min(...hrValues) - 5 : 40;
        const maxHR = hrValues.length ? Math.max(...hrValues) + 5 : 100;
        const hrRange = Math.max(maxHR - minHR, 1);
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("width", "100%"); svg.setAttribute("height", "100%");
        svg.setAttribute("viewBox", `0 0 ${totalWidth} ${container.clientHeight}`);
        svg.classList.add('svg-chart');
        const barWidth = Math.min((chartWidth / stats.length) * 0.8, 40);
        const spacing = (chartWidth - (barWidth * stats.length)) / (stats.length || 1);
        const colors = { deep: '#5a2d9c', light: '#2481cc', rem: '#c161d9', awake: '#e5b220' };
        const yAxisLabels = [1, 3, 5, 8, 10];
        yAxisLabels.forEach(h => {
            const mins = h * 60; if (mins > maxMins + 60) return;
            const y = topPadding + chartHeight - (mins / maxMins) * chartHeight;
            const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
            text.setAttribute("x", leftPadding - 8); text.setAttribute("y", y + 4);
            text.setAttribute("text-anchor", "end"); text.setAttribute("fill", "var(--hint-color)");
            text.setAttribute("font-size", "10px"); text.textContent = h + "h";
            svg.appendChild(text);
            const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
            line.setAttribute("x1", leftPadding); line.setAttribute("y1", y); line.setAttribute("x2", leftPadding - 3); line.setAttribute("y2", y);
            line.setAttribute("stroke", "var(--hint-color)"); svg.appendChild(line);
            const gridLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
            gridLine.setAttribute("x1", leftPadding); gridLine.setAttribute("y1", y); gridLine.setAttribute("x2", leftPadding + chartWidth); gridLine.setAttribute("y2", y);
            gridLine.setAttribute("stroke", "var(--hint-color)"); gridLine.setAttribute("stroke-opacity", "0.2"); svg.appendChild(gridLine);
        });
        const daysMap = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        let hrPoints = [];
        stats.forEach((dayStat, i) => {
            const xCenter = leftPadding + (spacing / 2) + (i * (barWidth + spacing)) + barWidth / 2;
            const xLeft = xCenter - barWidth / 2;
            let currentY = topPadding + chartHeight;
            const drawSegment = (mins, color) => {
                if (!mins) return;
                const h = (mins / maxMins) * chartHeight;
                const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
                rect.setAttribute("x", xLeft); rect.setAttribute("y", currentY - h); rect.setAttribute("width", barWidth); rect.setAttribute("height", h);
                rect.setAttribute("fill", color); svg.appendChild(rect); currentY -= h;
            };
            drawSegment(dayStat.deep_mins, colors.deep); drawSegment(dayStat.awake_mins, colors.awake); drawSegment(dayStat.light_mins, colors.light); drawSegment(dayStat.rem_mins, colors.rem);
            if (dayStat.total_mins > 0) {
                const hrs = Math.floor(dayStat.total_mins / 60), ms = dayStat.total_mins % 60;
                const lbl = document.createElementNS("http://www.w3.org/2000/svg", "text");
                lbl.setAttribute("x", xCenter); lbl.setAttribute("y", currentY - 5); lbl.setAttribute("text-anchor", "middle");
                lbl.setAttribute("fill", "var(--text-color)"); lbl.setAttribute("font-size", "11px"); lbl.textContent = `${hrs}:${ms.toString().padStart(2, '0')}`;
                svg.appendChild(lbl);
            }
            const dateObj = new Date(dayStat.date + 'T12:00:00'); let dayName = daysMap[dateObj.getDay()]; if (i === stats.length - 1) dayName = "Today";
            const xLbl = document.createElementNS("http://www.w3.org/2000/svg", "text");
            xLbl.setAttribute("x", xCenter); xLbl.setAttribute("y", topPadding + chartHeight + 15); xLbl.setAttribute("text-anchor", "middle");
            xLbl.setAttribute("fill", "var(--hint-color)"); xLbl.setAttribute("font-size", "11px"); xLbl.textContent = dayName; svg.appendChild(xLbl);
            if (dayStat.heart_rate_avg > 0) {
                const yHR = topPadding + chartHeight - ((dayStat.heart_rate_avg - minHR) / hrRange) * chartHeight;
                hrPoints.push({ x: xCenter, y: yHR, val: dayStat.heart_rate_avg });
            }
        });
        if (hrPoints.length > 1) {
            const pathLine = document.createElementNS("http://www.w3.org/2000/svg", "path");
            const pathData = hrPoints.map((p, i) => (i === 0 ? `M ${p.x},${p.y}` : `L ${p.x},${p.y}`)).join(" ");
            pathLine.setAttribute("d", pathData); pathLine.setAttribute("fill", "none"); pathLine.setAttribute("stroke", "#ff3b30"); pathLine.setAttribute("stroke-width", "2");
            svg.appendChild(pathLine);
        }
        hrPoints.forEach(p => {
            const cOut = document.createElementNS("http://www.w3.org/2000/svg", "circle"); cOut.setAttribute("cx", p.x); cOut.setAttribute("cy", p.y); cOut.setAttribute("r", "4"); cOut.setAttribute("fill", "var(--bg-color)"); svg.appendChild(cOut);
            const cIn = document.createElementNS("http://www.w3.org/2000/svg", "circle"); cIn.setAttribute("cx", p.x); cIn.setAttribute("cy", p.y); cIn.setAttribute("r", "2"); cIn.setAttribute("fill", "#ff3b30"); svg.appendChild(cIn);
            const bg = document.createElementNS("http://www.w3.org/2000/svg", "text"); bg.setAttribute("x", p.x); bg.setAttribute("y", p.y - 8); bg.setAttribute("text-anchor", "middle"); bg.setAttribute("stroke", "var(--bg-color)"); bg.setAttribute("stroke-width", "3"); bg.setAttribute("font-size", "10px"); bg.setAttribute("font-weight", "bold"); bg.textContent = p.val; svg.appendChild(bg);
            const lbl = document.createElementNS("http://www.w3.org/2000/svg", "text"); lbl.setAttribute("x", p.x); lbl.setAttribute("y", p.y - 8); lbl.setAttribute("text-anchor", "middle"); lbl.setAttribute("fill", "#ff3b30"); lbl.setAttribute("font-size", "10px"); lbl.setAttribute("font-weight", "bold"); lbl.textContent = p.val; svg.appendChild(lbl);
        });
        container.appendChild(svg);
    }

    function renderStepsChart(stats) {
        const container = document.getElementById('stepsChartContainer');
        if (!container) return;
        const totalWidth = container.clientWidth;
        const leftPadding = 35, rightPadding = 20, topPadding = 20, bottomPadding = 30;
        const chartWidth = totalWidth - leftPadding - rightPadding;
        const chartHeight = container.clientHeight - topPadding - bottomPadding;
        if (chartWidth <= 0 || chartHeight <= 0) return;
        const maxSteps = Math.max(...stats.map(d => d.steps || 0), 1000);
        const yMax = maxSteps * 1.1;
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("width", "100%"); svg.setAttribute("height", "100%");
        svg.setAttribute("viewBox", `0 0 ${totalWidth} ${container.clientHeight}`);
        svg.classList.add('svg-chart');
        const barWidth = Math.min((chartWidth / stats.length) * 0.8, 40);
        const spacing = (chartWidth - (barWidth * stats.length)) / (stats.length || 1);
        const stepColor = '#34c759';
        const ySteps = 4;
        for (let i = 0; i <= ySteps; i++) {
            const val = Math.round((i / ySteps) * yMax);
            const y = topPadding + chartHeight - (i / ySteps) * chartHeight;
            let valStr = val >= 1000 ? Math.round(val / 1000) + 'k' : val.toString();
            const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
            text.setAttribute("x", leftPadding - 8); text.setAttribute("y", y + 4); text.setAttribute("text-anchor", "end");
            text.setAttribute("fill", "var(--hint-color)"); text.setAttribute("font-size", "10px"); text.textContent = valStr;
            svg.appendChild(text);
            const gridLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
            gridLine.setAttribute("x1", leftPadding); gridLine.setAttribute("y1", y); gridLine.setAttribute("x2", leftPadding + chartWidth); gridLine.setAttribute("y2", y);
            gridLine.setAttribute("stroke", "var(--hint-color)"); gridLine.setAttribute("stroke-opacity", i === 0 ? "0.6" : "0.2");
            svg.appendChild(gridLine);
        }
        const daysMap = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        stats.forEach((dayStat, i) => {
            const xCenter = leftPadding + (spacing / 2) + (i * (barWidth + spacing)) + barWidth / 2;
            const xLeft = xCenter - barWidth / 2;
            const h = Math.max((dayStat.steps / yMax) * chartHeight, 2);
            const yTop = topPadding + chartHeight - h;
            const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
            rect.setAttribute("x", xLeft); rect.setAttribute("y", yTop); rect.setAttribute("width", barWidth); rect.setAttribute("height", h);
            rect.setAttribute("fill", stepColor); rect.setAttribute("rx", "3"); svg.appendChild(rect);
            if (dayStat.steps > 0) {
                const stepLbl = document.createElementNS("http://www.w3.org/2000/svg", "text");
                let textY = (h > 40) ? yTop + 8 : yTop - 4;
                let textFill = (h > 40) ? "#ffffff" : "var(--text-color)";
                let textAnchor = (h > 40) ? "end" : "start";
                stepLbl.setAttribute("x", xCenter + 3); stepLbl.setAttribute("y", textY);
                stepLbl.setAttribute("text-anchor", textAnchor); stepLbl.setAttribute("fill", textFill);
                stepLbl.setAttribute("font-size", "11px"); stepLbl.setAttribute("font-weight", "500");
                stepLbl.setAttribute("transform", `rotate(-90 ${xCenter + 3} ${textY})`);
                stepLbl.textContent = dayStat.steps.toLocaleString(); svg.appendChild(stepLbl);
            }
            const dateObj = new Date(dayStat.day + 'T12:00:00'); let dayName = daysMap[dateObj.getDay()]; if (i === stats.length - 1) dayName = "Today";
            const xLbl = document.createElementNS("http://www.w3.org/2000/svg", "text");
            xLbl.setAttribute("x", xCenter); xLbl.setAttribute("y", topPadding + chartHeight + 15); xLbl.setAttribute("text-anchor", "middle");
            xLbl.setAttribute("fill", "var(--hint-color)"); xLbl.setAttribute("font-size", "11px"); xLbl.textContent = dayName; svg.appendChild(xLbl);
        });
        container.appendChild(svg);
    }
})();
