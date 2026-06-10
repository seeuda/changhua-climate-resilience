// ==========================================================================
// Application State & Initialization
// ==========================================================================
let map;
let townGeoJsonData = null;
let daycarePointsData = null;
let originalTownGeoJson = null;
let originalDaycarePoints = null;

let townLayer = null;
let daycareLayer = null;
let riskChart = null;

let activeTheme = 'flood'; // 'flood' or 'temp'
let activeScenario = 'current'; // 'current', 'gwl15', 'gwl20', 'gwl40'
let activeFloodMode = 'ncdr'; // 'ncdr' or 'wra'
let selectedTown = null; // Filter daycare list

let wraGeoJson350 = null;
let wraGeoJson650 = null;
let wraLayer = null;
let daycareIntersectResults = {}; // daycare name -> depth_type

// Risk Color Map (corresponds to CSS variables)
const riskColors = {
    1: '#10b981', // Emerald Green (Low)
    2: '#84cc16', // Lime Green
    3: '#eab308', // Amber Yellow (Medium)
    4: '#f97316', // Orange
    5: '#ef4444'  // Soft Red (High)
};

// WRA Flood Depth Colors
const wraColors = {
    2: '#93c5fd', // 0.3 - 0.5m: Light Blue
    3: '#3b82f6', // 0.5 - 1.0m: Blue
    4: '#f97316', // 1.0 - 2.0m: Orange
    5: '#ef4444', // 2.0 - 3.0m: Red
    6: '#a855f7'  // > 3.0m: Purple
};

// Case Type Colors for Daycare markers
const caseColors = {
    '混合型': '#60a5fa',  // Blue
    '失智型': '#fb7185',  // Rose
    '失能型': '#34d399',  // Emerald
    '未知': '#94a3b8'    // Slate
};

// Document Ready
document.addEventListener('DOMContentLoaded', () => {
    initMap();
    setupUIControls();
    loadData();
});

// ==========================================================================
// Map Setup & Base Layers
// ==========================================================================
function initMap() {
    // Initialize map centered on Changhua County
    map = L.map('map', {
        zoomControl: false, // Custom position instead
        attributionControl: false
    }).setView([23.97, 120.46], 10.5);

    // Create custom panes for proper layering
    map.createPane('towns');
    map.getPane('towns').style.zIndex = 300;

    map.createPane('labels');
    map.getPane('labels').style.zIndex = 350;
    map.getPane('labels').style.pointerEvents = 'none'; // Ensure click-through for labels layer

    // Dark Map Base Tile Layer (No labels)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
        maxZoom: 20,
        subdomains: 'abcd'
    }).addTo(map);

    // Dark Map Labels Overlay (Drawn on labels pane)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
        maxZoom: 20,
        subdomains: 'abcd',
        pane: 'labels'
    }).addTo(map);

    // Zoom control at bottom right
    L.control.zoom({
        position: 'bottomleft'
    }).addTo(map);

    // Add Legend Control
    addLegend();
}

// ==========================================================================
// Data Fetching & Parsing
// ==========================================================================
function loadData() {
    // Fetch pre-calibrated geojson files directly (clean baseline data with correct temperature fields)
    Promise.all([
        fetch(`changhua_towns.json?t=${new Date().getTime()}`).then(res => res.json()),
        fetch(`daycare_points.json?t=${new Date().getTime()}`).then(res => res.json())
    ]).then(([towns, daycares]) => {
        originalTownGeoJson = towns;
        originalDaycarePoints = daycares;
        
        // Apply calibration based on initial slider values (default 0)
        applyCalibration();
    }).catch(err => {
        console.error('Error loading GIS data:', err);
    });
}

// ==========================================================================
// Coordinate Calibration & Dynamic Shift & Scale
// ==========================================================================
let activeWraData = null;

function applyCalibration() {
    if (!originalTownGeoJson || !originalDaycarePoints) return;

    const lonShift = parseFloat(document.getElementById('slider-lon-shift').value);
    const latShift = parseFloat(document.getElementById('slider-lat-shift').value);
    const scaleFactor = parseFloat(document.getElementById('slider-scale').value);

    // Update UI value displays
    document.getElementById('val-lon-shift').innerText = (lonShift >= 0 ? '+' : '') + lonShift.toFixed(5);
    document.getElementById('val-lat-shift').innerText = (latShift >= 0 ? '+' : '') + latShift.toFixed(5);
    document.getElementById('val-scale').innerText = scaleFactor.toFixed(5);

    // Deep copy original data
    townGeoJsonData = JSON.parse(JSON.stringify(originalTownGeoJson));
    daycarePointsData = JSON.parse(JSON.stringify(originalDaycarePoints));

    // Define approximate centroid of Changhua for scaling origin
    const originLon = 120.45;
    const originLat = 23.95;

    // Shift and Scale coordinates function
    function transformCoords(coords, dx, dy, scale) {
        if (typeof coords[0] === 'number') {
            // Apply scale relative to origin, then apply shift
            coords[0] = originLon + (coords[0] - originLon) * scale + dx;
            coords[1] = originLat + (coords[1] - originLat) * scale + dy;
        } else {
            coords.forEach(c => transformCoords(c, dx, dy, scale));
        }
    }

    // Apply transformation to all shapes
    townGeoJsonData.features.forEach(f => {
        if (f.geometry && f.geometry.coordinates) {
            transformCoords(f.geometry.coordinates, lonShift, latShift, scaleFactor);
        }
    });

    // Transform WRA GeoJSON if active and loaded
    activeWraData = null;
    if (activeTheme === 'flood' && activeFloodMode === 'wra') {
        const originalWra = activeScenario === 'gwl20' ? wraGeoJson650 : wraGeoJson350;
        if (originalWra) {
            activeWraData = JSON.parse(JSON.stringify(originalWra));
            activeWraData.features.forEach(f => {
                if (f.geometry && f.geometry.coordinates) {
                    transformCoords(f.geometry.coordinates, lonShift, latShift, scaleFactor);
                }
            });
        }
    }

    // Re-render layers and statistics
    updateLayers();
    updateStatsAndChart();
    populateDaycareList();
}

// ==========================================================================
// Risk Field Helper
// ==========================================================================
function getActiveRiskField() {
    if (activeTheme === 'flood') {
        // Flood supports current and gwl15 (which maps to flood_risk_future)
        return activeScenario === 'current' ? 'flood_risk_current' : 'flood_risk_future';
    } else {
        // Temp supports current, gwl15, gwl20, and gwl40
        if (activeScenario === 'current') return 'temp_risk_current';
        if (activeScenario === 'gwl15') return 'temp_risk_gwl15';
        if (activeScenario === 'gwl20') return 'temp_risk_gwl20';
        if (activeScenario === 'gwl40') return 'temp_risk_gwl40';
        return 'temp_risk_current';
    }
}

function getActiveHazardField() {
    if (activeTheme === 'flood') {
        return activeScenario === 'current' ? 'flood_hazard_current' : 'flood_hazard_future';
    } else {
        if (activeScenario === 'current') return 'temp_hazard_current';
        if (activeScenario === 'gwl15') return 'temp_hazard_gwl15';
        if (activeScenario === 'gwl20') return 'temp_hazard_gwl20';
        if (activeScenario === 'gwl40') return 'temp_hazard_gwl40';
        return 'temp_hazard_current';
    }
}

function getActiveVulnerabilityField() {
    return activeTheme === 'flood' ? 'flood_vulnerability' : 'temp_vulnerability';
}

// ==========================================================================
// Layer Rendering & Styling
// ==========================================================================
// ==========================================================================
// Spatial Point-in-Polygon Check for Daycares
// ==========================================================================
function isPointInMultiPolygon(x, y, coordinates) {
    for (let poly of coordinates) {
        let exterior = poly[0];
        // BBox optimization
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let pt of exterior) {
            if (pt[0] < minX) minX = pt[0];
            if (pt[0] > maxX) maxX = pt[0];
            if (pt[1] < minY) minY = pt[1];
            if (pt[1] > maxY) maxY = pt[1];
        }
        if (x < minX || x > maxX || y < minY || y > maxY) {
            continue;
        }
        // Ray casting
        let inside = false;
        let n = exterior.length;
        let p1x = exterior[0][0], p1y = exterior[0][1];
        for (let i = 0; i <= n; i++) {
            let p2 = exterior[i % n];
            let p2x = p2[0], p2y = p2[1];
            if (y > Math.min(p1y, p2y)) {
                if (y <= Math.max(p1y, p2y)) {
                    if (x <= Math.max(p1x, p2x)) {
                        if (p1y !== p2y) {
                            var xinters = (y - p1y) * (p2x - p1x) / (p2y - p1y) + p1x;
                        }
                        if (p1x === p2x || x <= xinters) {
                            inside = !inside;
                        }
                    }
                }
            }
            p1x = p2x;
            p1y = p2y;
        }
        if (inside) {
            let inHole = false;
            for (let j = 1; j < poly.length; j++) {
                let hole = poly[j];
                let hInside = false;
                let hn = hole.length;
                let hp1x = hole[0][0], hp1y = hole[0][1];
                for (let k = 0; k <= hn; k++) {
                    let hp2 = hole[k % hn];
                    let hp2x = hp2[0], hp2y = hp2[1];
                    if (y > Math.min(hp1y, hp2y)) {
                        if (y <= Math.max(hp1y, hp2y)) {
                            if (x <= Math.max(hp1x, hp2x)) {
                                if (hp1y !== hp2y) {
                                    var hxinters = (y - hp1y) * (hp2x - hp1x) / (hp2y - hp1y) + hp1x;
                                }
                                if (hp1x === hp2x || x <= hxinters) {
                                    hInside = !hInside;
                                }
                            }
                        }
                    }
                    hp1x = hp2x;
                    hp1y = hp2y;
                }
                if (hInside) {
                    inHole = true;
                    break;
                }
            }
            if (!inHole) return true;
        }
    }
    return false;
}

function computeIntersections() {
    daycareIntersectResults = {};
    if (activeTheme === 'flood' && activeFloodMode === 'wra' && activeWraData && daycarePointsData) {
        daycarePointsData.features.forEach(dc => {
            const coords = dc.geometry.coordinates;
            const x = coords[0];
            const y = coords[1];
            for (let feat of activeWraData.features) {
                if (isPointInMultiPolygon(x, y, feat.geometry.coordinates)) {
                    daycareIntersectResults[dc.properties.name] = feat.properties.depth_type;
                    break;
                }
            }
        });
    }
}

// ==========================================================================
// Layer Rendering & Styling
// ==========================================================================
function updateLayers() {
    if (!townGeoJsonData) return;

    // 1. Remove existing layers
    if (townLayer) map.removeLayer(townLayer);
    if (daycareLayer) map.removeLayer(daycareLayer);
    if (wraLayer) map.removeLayer(wraLayer);

    // Compute spatial intersections first
    computeIntersections();

    // 2. Renders WRA Layer if active
    if (activeTheme === 'flood' && activeFloodMode === 'wra' && activeWraData) {
        wraLayer = L.geoJSON(activeWraData, {
            style: (feature) => {
                const gridCode = feature.properties.grid_code || 2;
                return {
                    fillColor: wraColors[gridCode] || '#93c5fd',
                    fillOpacity: 0.65,
                    color: 'rgba(255,255,255,0.1)',
                    weight: 0.8
                };
            },
            onEachFeature: (feature, layer) => {
                const depth = feature.properties.depth_type || '';
                layer.bindPopup(`<div class="popup-container" style="padding: 4px;"><h4 style="margin: 0 0 4px 0; color: #60a5fa;"><i class="fa-solid fa-water"></i> 水利署淹水潛勢</h4>淹水深度：<strong>${depth} 公尺</strong></div>`);
            }
        }).addTo(map);
    }

    const riskField = getActiveRiskField();
    const isWraMode = (activeTheme === 'flood' && activeFloodMode === 'wra');

    // 3. Add Town Polygons
    townLayer = L.geoJSON(townGeoJsonData, {
        pane: 'towns',
        style: (feature) => {
            if (isWraMode) {
                // Transparent fill with visible boundaries in WRA mode
                return {
                    fillColor: 'transparent',
                    fillOpacity: 0,
                    color: 'rgba(255,255,255,0.3)',
                    weight: 1.5,
                    dashArray: '3, 4',
                    className: 'town-boundary'
                };
            } else {
                const riskVal = feature.properties[riskField] || 1;
                return {
                    fillColor: riskColors[riskVal] || '#cccccc',
                    fillOpacity: 0.7,
                    color: 'rgba(255,255,255,0.15)',
                    weight: 1.5,
                    className: 'town-boundary'
                };
            }
        },
        onEachFeature: onEachTownFeature
    }).addTo(map);

    // 4. Add Daycare Point Markers
    daycareLayer = L.geoJSON(daycarePointsData, {
        pointToLayer: (feature, latlng) => {
            const name = feature.properties.name;
            const caseType = feature.properties.case_type || '未知';
            const markerColor = caseColors[caseType] || '#94a3b8';
            
            const isFlooded = daycareIntersectResults[name];
            
            // If daycare is in WRA flooded zone, style it with red alert border and larger radius
            return L.circleMarker(latlng, {
                radius: isFlooded ? 8 : 6,
                fillColor: markerColor,
                fillOpacity: 0.9,
                color: isFlooded ? '#ef4444' : '#ffffff',
                weight: isFlooded ? 3 : 1.5,
                className: isFlooded ? 'daycare-marker warning-pulse' : 'daycare-marker'
            });
        },
        onEachFeature: onEachDaycareFeature
    }).addTo(map);
}

// Interactive events for town polygons
function onEachTownFeature(feature, layer) {
    layer.on({
        mouseover: highlightFeature,
        mouseout: resetHighlight,
        click: selectTownFeature
    });
}

function highlightFeature(e) {
    const layer = e.target;
    layer.setStyle({
        weight: 3,
        color: '#ffffff',
        fillOpacity: (activeTheme === 'flood' && activeFloodMode === 'wra') ? 0.05 : 0.8
    });
    
    // Update Map Info Widget
    updateInfoWidget(layer.feature.properties);
}

function resetHighlight(e) {
    townLayer.resetStyle(e.target);
    clearInfoWidget();
}

function selectTownFeature(e) {
    const layer = e.target;
    const townName = layer.feature.properties.town_name;
    
    if (selectedTown === townName) {
        selectedTown = null; // Toggle off
        document.getElementById('town-selected-name').innerText = '(全縣)';
    } else {
        selectedTown = townName;
        document.getElementById('town-selected-name').innerText = `(${townName})`;
    }
    
    // Zoom/Pan slightly
    map.panTo(e.latlng);
    
    populateDaycareList();

    // Auto-expand mobile drawer if collapsed when selecting a town
    const container = document.querySelector('.app-container');
    const toggleIcon = document.getElementById('mobile-toggle-icon');
    if (window.innerWidth <= 768 && container && container.classList.contains('sidebar-collapsed')) {
        container.classList.remove('sidebar-collapsed');
        if (toggleIcon) {
            toggleIcon.className = 'fa-solid fa-chevron-down';
        }
    }
}

// Popup configuration for daycare markers
function onEachDaycareFeature(feature, layer) {
    const props = feature.properties;
    
    let warningHtml = '';
    const warningDepth = daycareIntersectResults[props.name];
    if (activeTheme === 'flood' && activeFloodMode === 'wra' && warningDepth) {
        warningHtml = `
            <div class="popup-row" style="background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 4px; padding: 4px 8px; margin-top: 4px; margin-bottom: 8px;">
                <span class="popup-label" style="color: #ef4444; font-weight: bold;"><i class="fa-solid fa-triangle-exclamation"></i> 淹水警戒</span>
                <span class="popup-val" style="color: #ef4444; font-weight: bold;">${warningDepth} 公尺</span>
            </div>
        `;
    }

    const content = `
        <div class="popup-container">
            <h3 class="popup-title"><i class="fa-solid fa-house-chimney-medical"></i> ${props.name}</h3>
            ${warningHtml}
            <div class="popup-row">
                <span class="popup-label">服務地區</span>
                <span class="popup-val">${props.town}</span>
            </div>
            <div class="popup-row">
                <span class="popup-label">個案類型</span>
                <span class="popup-val">${props.case_type}</span>
            </div>
            <div class="popup-row">
                <span class="popup-label">服務類型</span>
                <span class="popup-val">${props.service_type}</span>
            </div>
            <div class="popup-row">
                <span class="popup-label">聯絡電話</span>
                <span class="popup-val">${props.phone}</span>
            </div>
            <div class="popup-row">
                <span class="popup-label">機構地址</span>
                <span class="popup-val">${props.address}</span>
            </div>
        </div>
    `;
    layer.bindPopup(content, { maxWidth: 300 });
}

// ==========================================================================
// Dashboard Widgets & Stats Updater
// ==========================================================================
// ==========================================================================
// Dashboard Widgets & Stats Updater
// ==========================================================================
function updateStatsAndChart() {
    if (!townGeoJsonData || !daycarePointsData) return;

    // Dynamically update the legend content
    updateLegendUI();

    if (activeTheme === 'flood' && activeFloodMode === 'wra') {
        // WRA Inundation mode
        let totalFlooded = 0;
        const depthDistribution = { 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
        
        daycarePointsData.features.forEach(feat => {
            const name = feat.properties.name;
            const depth = daycareIntersectResults[name];
            if (depth) {
                totalFlooded++;
                let code = 2;
                if (depth === '0.3-0.5') code = 2;
                else if (depth === '0.5-1') code = 3;
                else if (depth === '1-2') code = 4;
                else if (depth === '2-3') code = 5;
                else if (depth === '>3') code = 6;
                depthDistribution[code]++;
            }
        });

        document.getElementById('val-high-risk').innerText = totalFlooded;
        
        const highRiskCard = document.querySelector('.high-risk-centers');
        if (totalFlooded > 0) {
            highRiskCard.classList.add('warning-active');
            highRiskCard.querySelector('.stat-value').style.color = '#ef4444';
        } else {
            highRiskCard.classList.remove('warning-active');
            highRiskCard.querySelector('.stat-value').style.color = '';
        }

        renderChartWRA(depthDistribution);

    } else {
        // Standard NCDR Mode (Flood risk / High Temp risk)
        const riskField = getActiveRiskField();
        
        const townRisks = {};
        townGeoJsonData.features.forEach(feat => {
            const name = feat.properties.town_name;
            townRisks[name] = feat.properties[riskField] || 1;
        });

        let totalHighRisk = 0;
        const riskDistribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

        daycarePointsData.features.forEach(feat => {
            const town = feat.properties.town;
            const riskVal = townRisks[town] || 1;
            
            riskDistribution[riskVal]++;
            if (riskVal >= 4) {
                totalHighRisk++;
            }
        });

        document.getElementById('val-high-risk').innerText = totalHighRisk;
        
        const highRiskCard = document.querySelector('.high-risk-centers');
        if (totalHighRisk > 0) {
            highRiskCard.classList.add('warning-active');
            highRiskCard.querySelector('.stat-value').style.color = '#ef4444';
        } else {
            highRiskCard.classList.remove('warning-active');
            highRiskCard.querySelector('.stat-value').style.color = '';
        }

        renderChart(riskDistribution);
    }
}

function renderChart(distributionData) {
    const ctx = document.getElementById('riskChart').getContext('2d');
    
    const chartLabels = ['低風險 (1)', '中低風 (2)', '中風險 (3)', '中高風 (4)', '高風險 (5)'];
    const chartData = [
        distributionData[1],
        distributionData[2],
        distributionData[3],
        distributionData[4],
        distributionData[5]
    ];

    if (riskChart) {
        riskChart.data.labels = chartLabels;
        riskChart.data.datasets[0].label = '機構數量';
        riskChart.data.datasets[0].data = chartData;
        riskChart.data.datasets[0].backgroundColor = [
            riskColors[1],
            riskColors[2],
            riskColors[3],
            riskColors[4],
            riskColors[5]
        ];
        riskChart.update();
    } else {
        riskChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: chartLabels,
                datasets: [{
                    label: '機構數量',
                    data: chartData,
                    backgroundColor: [
                        riskColors[1],
                        riskColors[2],
                        riskColors[3],
                        riskColors[4],
                        riskColors[5]
                    ],
                    borderRadius: 4,
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: { color: '#94a3b8', font: { size: 9 } }
                    },
                    y: {
                        grid: { color: 'rgba(255,255,255,0.05)' },
                        ticks: { color: '#94a3b8', font: { size: 9 }, stepSize: 5 }
                    }
                }
            }
        });
    }
}

function renderChartWRA(distribution) {
    const chartLabels = ['0.3-0.5m', '0.5-1m', '1-2m', '2-3m', '>3m'];
    const chartData = [
        distribution[2],
        distribution[3],
        distribution[4],
        distribution[5],
        distribution[6]
    ];

    if (riskChart) {
        riskChart.data.labels = chartLabels;
        riskChart.data.datasets[0].label = '警戒機構';
        riskChart.data.datasets[0].data = chartData;
        riskChart.data.datasets[0].backgroundColor = [
            wraColors[2],
            wraColors[3],
            wraColors[4],
            wraColors[5],
            wraColors[6]
        ];
        riskChart.update();
    }
}

// Info Widget (Hover detail overlay)
function updateInfoWidget(props) {
    const infoDiv = document.getElementById('info-content');
    
    // Count daycares in this town
    const daycareCount = daycarePointsData ? daycarePointsData.features.filter(f => f.properties.town === props.town_name).length : 0;
    
    if (activeTheme === 'flood' && activeFloodMode === 'wra') {
        let floodedCount = 0;
        if (daycarePointsData) {
            daycarePointsData.features.forEach(f => {
                if (f.properties.town === props.town_name && daycareIntersectResults[f.properties.name]) {
                    floodedCount++;
                }
            });
        }
        infoDiv.innerHTML = `
            <div class="hover-town-title">${props.town_name}</div>
            <div class="hover-stat-row">
                <span class="hover-stat-label">轄區內日照機構數</span>
                <span class="hover-stat-val" style="color: var(--secondary); font-weight: 700;">${daycareCount} 家</span>
            </div>
            <div class="hover-stat-row" style="margin-top: 8px; border-top: 1px dashed rgba(239,68,68,0.3); padding-top: 8px;">
                <span class="hover-stat-label" style="color: #ef4444; font-weight: bold;">淹水警戒機構數</span>
                <span class="hover-stat-val risk-badge badge-5">${floodedCount} 家</span>
            </div>
        `;
    } else {
        const riskVal = props[getActiveRiskField()] || 1;
        const hazVal = props[getActiveHazardField()] || 1;
        const vulVal = props[getActiveVulnerabilityField()] || 1;
        
        infoDiv.innerHTML = `
            <div class="hover-town-title">${props.town_name}</div>
            <div class="hover-stat-row">
                <span class="hover-stat-label">危害度等級 (Hazard)</span>
                <span class="hover-stat-val risk-badge badge-${hazVal}">Level ${hazVal}</span>
            </div>
            <div class="hover-stat-row">
                <span class="hover-stat-label">脆弱度等級 (Vulnerability)</span>
                <span class="hover-stat-val risk-badge badge-${vulVal}">Level ${vulVal}</span>
            </div>
            <div class="hover-stat-row">
                <span class="hover-stat-label">綜合風險等級 (Risk)</span>
                <span class="hover-stat-val risk-badge badge-${riskVal}">Level ${riskVal}</span>
            </div>
            <div class="hover-stat-row" style="margin-top: 8px; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 8px;">
                <span class="hover-stat-label">轄區內日照機構數</span>
                <span class="hover-stat-val" style="color: var(--secondary); font-weight: 700;">${daycareCount} 家</span>
            </div>
        `;
    }
}

function clearInfoWidget() {
    const infoDiv = document.getElementById('info-content');
    infoDiv.innerHTML = `<p class="placeholder">懸停於行政區上以載入氣候風險指標...</p>`;
}

// Populate the daycare list inside the sidebar
function populateDaycareList() {
    const container = document.getElementById('daycare-list-container');
    container.innerHTML = '';

    if (!daycarePointsData) return;

    let filtered = daycarePointsData.features;
    if (selectedTown) {
        filtered = daycarePointsData.features.filter(feat => feat.properties.town === selectedTown);
    }

    if (filtered.length === 0) {
        container.innerHTML = `<p class="list-placeholder">本區尚無設置日間照顧服務機構</p>`;
        return;
    }

    filtered.forEach(feat => {
        const props = feat.properties;
        
        let warningTag = '';
        const isFlooded = daycareIntersectResults[props.name];
        if (activeTheme === 'flood' && activeFloodMode === 'wra' && isFlooded) {
            warningTag = `<span class="item-tag tag-warning" style="background:#ef4444; color:white;"><i class="fa-solid fa-triangle-exclamation"></i> 淹水警戒: ${isFlooded}m</span>`;
        }
        
        const card = document.createElement('div');
        card.className = 'daycare-item-card';
        
        card.innerHTML = `
            <div class="daycare-item-title">${props.name}</div>
            <div class="daycare-item-tags">
                <span class="item-tag tag-case">${props.case_type}</span>
                <span class="item-tag tag-service">${props.service_type}</span>
                ${warningTag}
            </div>
            <div class="daycare-item-detail">
                <i class="fa-solid fa-phone"></i> <span>${props.phone || '無'}</span>
            </div>
            <div class="daycare-item-detail">
                <i class="fa-solid fa-map-location-dot"></i> <span>${props.address}</span>
            </div>
        `;
        
        // Click item zoom to marker and open popup
        card.addEventListener('click', () => {
            const coords = feat.geometry.coordinates;
            map.setView([coords[1], coords[0]], 14);
            
            daycareLayer.eachLayer(layer => {
                if (layer.feature.properties.id === props.id) {
                    layer.openPopup();
                }
            });
        });
        
        container.appendChild(card);
    });
}

// ==========================================================================
// Lazy Loader for WRA Flood GeoJSON
// ==========================================================================
function loadWraData(scenarioId, callback) {
    const file = scenarioId === 'gwl20' ? 'wra_flood_650mm_24h.json' : 'wra_flood_350mm_24h.json';
    
    if (scenarioId === 'gwl20' && wraGeoJson650) {
        callback(wraGeoJson650);
        return;
    }
    if (scenarioId !== 'gwl20' && wraGeoJson350) {
        callback(wraGeoJson350);
        return;
    }
    
    const indicator = document.getElementById('active-scenario-indicator');
    const originalText = indicator.innerText;
    indicator.innerText = `載入水利署精細潛勢圖中...請稍候...`;
    
    fetch(`${file}?t=${new Date().getTime()}`)
        .then(res => res.json())
        .then(geojson => {
            if (scenarioId === 'gwl20') {
                wraGeoJson650 = geojson;
            } else {
                wraGeoJson350 = geojson;
            }
            indicator.innerText = originalText;
            callback(geojson);
        })
        .catch(err => {
            console.error('Error loading WRA GeoJSON:', err);
            indicator.innerText = `載入圖資失敗`;
        });
}

// ==========================================================================
// UI Event Handlers
// ==========================================================================
// ==========================================================================
// Dynamic Timeline Generator
// ==========================================================================
function renderTimelineUI() {
    const selector = document.getElementById('scenario-selector');
    if (!selector) return;

    let html = '<div class="timeline-track"></div>';
    
    if (activeTheme === 'flood') {
        if (activeFloodMode === 'wra') {
            const steps = [
                { id: 'gwl15', label: '350mm / 24HR 暴雨', left: '0%' },
                { id: 'gwl20', label: '650mm / 24HR 極端降雨', left: '100%' }
            ];
            steps.forEach(step => {
                const isActive = activeScenario === step.id ? 'active' : '';
                html += `
                    <div class="timeline-step ${isActive}" data-scenario="${step.id}" style="left: ${step.left};">
                        <span class="step-dot"></span>
                        <span class="step-label">${step.label}</span>
                    </div>
                `;
            });
        } else {
            const steps = [
                { id: 'current', label: '現況基準 (Baseline)', left: '0%' },
                { id: 'gwl15', label: '世紀末升溫 1.5°C 情境', left: '100%' }
            ];
            steps.forEach(step => {
                const isActive = activeScenario === step.id ? 'active' : '';
                html += `
                    <div class="timeline-step ${isActive}" data-scenario="${step.id}" style="left: ${step.left};">
                        <span class="step-dot"></span>
                        <span class="step-label">${step.label}</span>
                    </div>
                `;
            });
        }
    } else {
        const steps = [
            { id: 'current', label: '現況基準 (Baseline)', left: '0%' },
            { id: 'gwl15', label: '升溫 1.5°C', left: '33.33%' },
            { id: 'gwl20', label: '升溫 2.0°C', left: '66.67%' },
            { id: 'gwl40', label: '升溫 4.0°C', left: '100%' }
        ];
        steps.forEach(step => {
            const isActive = activeScenario === step.id ? 'active' : '';
            html += `
                <div class="timeline-step ${isActive}" data-scenario="${step.id}" style="left: ${step.left};">
                    <span class="step-dot"></span>
                    <span class="step-label">${step.label}</span>
                </div>
            `;
        });
    }

    selector.innerHTML = html;
}

function setupUIControls() {
    renderTimelineUI();

    // 1. Theme Switcher
    const themeButtons = document.querySelectorAll('#theme-selector .toggle-btn');
    themeButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            const targetBtn = e.currentTarget;
            themeButtons.forEach(b => b.classList.remove('active'));
            targetBtn.classList.add('active');
            
            activeTheme = targetBtn.dataset.theme;
            
            // Show/Hide WRA mode group
            const modeGroup = document.getElementById('flood-mode-group');
            if (modeGroup) {
                modeGroup.style.display = activeTheme === 'flood' ? 'block' : 'none';
            }
            
            // Safety scenario shift
            if (activeTheme === 'flood') {
                if (activeFloodMode === 'wra') {
                    if (activeScenario !== 'gwl15' && activeScenario !== 'gwl20') {
                        activeScenario = 'gwl15';
                    }
                } else {
                    if (activeScenario !== 'current' && activeScenario !== 'gwl15') {
                        activeScenario = 'current';
                    }
                }
            }
            
            if (activeTheme === 'flood' && activeFloodMode === 'wra') {
                loadWraData(activeScenario, () => {
                    renderTimelineUI();
                    updateHeaderIndicator();
                    applyCalibration();
                });
            } else {
                renderTimelineUI();
                updateHeaderIndicator();
                applyCalibration();
            }
        });
    });

    // 2. Flood Mode Selector
    const modeButtons = document.querySelectorAll('#flood-mode-selector .toggle-btn');
    modeButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            const targetBtn = e.currentTarget;
            modeButtons.forEach(b => b.classList.remove('active'));
            targetBtn.classList.add('active');
            
            activeFloodMode = targetBtn.dataset.mode;
            
            if (activeFloodMode === 'wra') {
                if (activeScenario !== 'gwl15' && activeScenario !== 'gwl20') {
                    activeScenario = 'gwl15';
                }
                loadWraData(activeScenario, () => {
                    renderTimelineUI();
                    updateHeaderIndicator();
                    applyCalibration();
                });
            } else {
                if (activeScenario !== 'current' && activeScenario !== 'gwl15') {
                    activeScenario = 'current';
                }
                renderTimelineUI();
                updateHeaderIndicator();
                applyCalibration();
            }
        });
    });

    // 3. Timeline Step Switcher via Event Delegation
    const selector = document.getElementById('scenario-selector');
    if (selector) {
        selector.addEventListener('click', (e) => {
            const stepElement = e.target.closest('.timeline-step');
            if (stepElement) {
                activeScenario = stepElement.dataset.scenario;
                
                if (activeTheme === 'flood' && activeFloodMode === 'wra') {
                    loadWraData(activeScenario, () => {
                        renderTimelineUI();
                        updateHeaderIndicator();
                        applyCalibration();
                    });
                } else {
                    renderTimelineUI();
                    updateHeaderIndicator();
                    applyCalibration();
                }
            }
        });
    }

    // 4. Calibration Sliders
    const lonSlider = document.getElementById('slider-lon-shift');
    const latSlider = document.getElementById('slider-lat-shift');
    const scaleSlider = document.getElementById('slider-scale');
    
    lonSlider.addEventListener('input', applyCalibration);
    latSlider.addEventListener('input', applyCalibration);
    scaleSlider.addEventListener('input', applyCalibration);

    // 5. Mobile Sidebar Drawer Toggle
    const brand = document.querySelector('.brand');
    const container = document.querySelector('.app-container');
    const toggleIcon = document.getElementById('mobile-toggle-icon');

    if (brand && container) {
        brand.addEventListener('click', () => {
            if (window.innerWidth <= 768) {
                container.classList.toggle('sidebar-collapsed');
                if (toggleIcon) {
                    if (container.classList.contains('sidebar-collapsed')) {
                        toggleIcon.className = 'fa-solid fa-chevron-up';
                    } else {
                        toggleIcon.className = 'fa-solid fa-chevron-down';
                    }
                }
            }
        });
    }
}

// Update Title Overlay Text
function updateHeaderIndicator() {
    const indicator = document.getElementById('active-scenario-indicator');
    
    const themeName = activeTheme === 'flood' 
        ? (activeFloodMode === 'wra' ? '水利署淹水潛勢圖' : '淹水風險等級') 
        : '高溫風險等級';
        
    let scenarioName = '現況基準';
    if (activeTheme === 'flood' && activeFloodMode === 'wra') {
        scenarioName = activeScenario === 'gwl20' ? '650mm / 24HR 極端降雨' : '350mm / 24HR 暴雨模擬';
    } else {
        if (activeScenario === 'gwl15') {
            scenarioName = '升溫 1.5°C 情境推估';
        } else if (activeScenario === 'gwl20') {
            scenarioName = '升溫 2.0°C 情境推估';
        } else if (activeScenario === 'gwl40') {
            scenarioName = '升溫 4.0°C 情境推估';
        } else if (activeScenario === 'future') {
            scenarioName = '升溫 1.5°C 情境推估';
        }
    }
    
    indicator.innerText = `${themeName}套疊 - ${scenarioName}`;
}

// Dynamic Legend UI Widget
function updateLegendUI() {
    const legendDiv = document.getElementById('map-legend-widget');
    if (!legendDiv) return;
    
    if (activeTheme === 'flood' && activeFloodMode === 'wra') {
        legendDiv.innerHTML = `
            <div class="legend-title">水利署預估淹水深度</div>
            <div class="legend-scale">
                <div class="legend-item"><span class="legend-color-box" style="background:${wraColors[2]}"></span> <span>0.3 - 0.5 公尺</span></div>
                <div class="legend-item"><span class="legend-color-box" style="background:${wraColors[3]}"></span> <span>0.5 - 1.0 公尺</span></div>
                <div class="legend-item"><span class="legend-color-box" style="background:${wraColors[4]}"></span> <span>1.0 - 2.0 公尺</span></div>
                <div class="legend-item"><span class="legend-color-box" style="background:${wraColors[5]}"></span> <span>2.0 - 3.0 公尺</span></div>
                <div class="legend-item"><span class="legend-color-box" style="background:${wraColors[6]}"></span> <span>大於 3.0 公尺</span></div>
            </div>
            <div class="legend-title" style="margin-top: 10px; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 8px;">日照機構類型</div>
            <div class="legend-scale">
                <div class="legend-item"><span class="legend-color-box" style="background:${caseColors['混合型']}; border-radius:50%"></span> <span>混合型機構</span></div>
                <div class="legend-item"><span class="legend-color-box" style="background:${caseColors['失智型']}; border-radius:50%"></span> <span>失智型特約機構</span></div>
                <div class="legend-item"><span class="legend-color-box" style="background:${caseColors['失能型']}; border-radius:50%"></span> <span>失能型特約機構</span></div>
            </div>
        `;
    } else {
        legendDiv.innerHTML = `
            <div class="legend-title">綜合風險指標等級</div>
            <div class="legend-scale">
                <div class="legend-item"><span class="legend-color-box" style="background:${riskColors[1]}"></span> <span>極低風險 (Level 1)</span></div>
                <div class="legend-item"><span class="legend-color-box" style="background:${riskColors[2]}"></span> <span>低風險 (Level 2)</span></div>
                <div class="legend-item"><span class="legend-color-box" style="background:${riskColors[3]}"></span> <span>中等風險 (Level 3)</span></div>
                <div class="legend-item"><span class="legend-color-box" style="background:${riskColors[4]}"></span> <span>高風險 (Level 4)</span></div>
                <div class="legend-item"><span class="legend-color-box" style="background:${riskColors[5]}"></span> <span>極高風險 (Level 5)</span></div>
            </div>
            <div class="legend-title" style="margin-top: 10px; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 8px;">日照機構類型</div>
            <div class="legend-scale">
                <div class="legend-item"><span class="legend-color-box" style="background:${caseColors['混合型']}; border-radius:50%"></span> <span>混合型機構</span></div>
                <div class="legend-item"><span class="legend-color-box" style="background:${caseColors['失智型']}; border-radius:50%"></span> <span>失智型特約機構</span></div>
                <div class="legend-item"><span class="legend-color-box" style="background:${caseColors['失能型']}; border-radius:50%"></span> <span>失能型特約機構</span></div>
            </div>
        `;
    }
}

// Legend Widget Initialization
function addLegend() {
    const legend = L.control({ position: 'bottomright' });
    legend.onAdd = function (map) {
        const div = L.DomUtil.create('div', 'map-legend');
        div.id = 'map-legend-widget';
        return div;
    };
    legend.addTo(map);
}
