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
let activeScenario = 'current'; // 'current' or 'future'
let selectedTown = null; // Filter daycare list

// Risk Color Map (corresponds to CSS variables)
const riskColors = {
    1: '#10b981', // Emerald Green (Low)
    2: '#84cc16', // Lime Green
    3: '#eab308', // Amber Yellow (Medium)
    4: '#f97316', // Orange
    5: '#ef4444'  // Soft Red (High)
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
        return activeScenario === 'current' ? 'flood_risk_current' : 'flood_risk_future';
    } else {
        return activeScenario === 'current' ? 'temp_risk_current' : 'temp_risk_future';
    }
}

function getActiveHazardField() {
    if (activeTheme === 'flood') {
        return activeScenario === 'current' ? 'flood_hazard_current' : 'flood_hazard_future';
    } else {
        return activeScenario === 'current' ? 'temp_hazard_current' : 'temp_hazard_future';
    }
}

function getActiveVulnerabilityField() {
    return activeTheme === 'flood' ? 'flood_vulnerability' : 'temp_vulnerability';
}

// ==========================================================================
// Layer Rendering & Styling
// ==========================================================================
function updateLayers() {
    if (!townGeoJsonData) return;

    // 1. Remove existing layers
    if (townLayer) map.removeLayer(townLayer);
    if (daycareLayer) map.removeLayer(daycareLayer);

    const riskField = getActiveRiskField();

    // 2. Add Town Polygons
    townLayer = L.geoJSON(townGeoJsonData, {
        pane: 'towns',
        style: (feature) => {
            const riskVal = feature.properties[riskField] || 1;
            return {
                fillColor: riskColors[riskVal] || '#cccccc',
                fillOpacity: 0.7,
                color: 'rgba(255,255,255,0.15)',
                weight: 1.5,
                className: 'town-boundary'
            };
        },
        onEachFeature: onEachTownFeature
    }).addTo(map);

    // 3. Add Daycare Point Markers
    daycareLayer = L.geoJSON(daycarePointsData, {
        pointToLayer: (feature, latlng) => {
            const caseType = feature.properties.case_type || '未知';
            const markerColor = caseColors[caseType] || '#94a3b8';
            
            // Create circular marker representing daycare
            return L.circleMarker(latlng, {
                radius: 6,
                fillColor: markerColor,
                fillOpacity: 0.9,
                color: '#ffffff',
                weight: 1.5,
                className: 'daycare-marker'
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
        fillOpacity: 0.8
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
    const content = `
        <div class="popup-container">
            <h3 class="popup-title"><i class="fa-solid fa-house-chimney-medical"></i> ${props.name}</h3>
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
function updateStatsAndChart() {
    if (!townGeoJsonData || !daycarePointsData) return;

    const riskField = getActiveRiskField();
    const hazardField = getActiveHazardField();
    const vulnField = getActiveVulnerabilityField();

    // Map each town to its risk level
    const townRisks = {};
    townGeoJsonData.features.forEach(feat => {
        const name = feat.properties.town_name;
        townRisks[name] = feat.properties[riskField] || 1;
    });

    // 1. Calculate how many daycare centers are in high-risk zones (Risk >= 4)
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

    // Update numbers on Dashboard
    document.getElementById('val-high-risk').innerText = totalHighRisk;
    
    // Toggle warning class if high risk centers > 0
    const highRiskCard = document.querySelector('.high-risk-centers');
    if (totalHighRisk > 0) {
        highRiskCard.classList.add('warning-active');
        highRiskCard.querySelector('.stat-value').style.color = '#ef4444';
    } else {
        highRiskCard.classList.remove('warning-active');
        highRiskCard.querySelector('.stat-value').style.color = '';
    }

    // 2. Render/Update Chart.js bar chart
    renderChart(riskDistribution);
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
        // Update data
        riskChart.data.datasets[0].data = chartData;
        riskChart.update();
    } else {
        // Create new chart
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

// Info Widget (Hover detail overlay)
function updateInfoWidget(props) {
    const infoDiv = document.getElementById('info-content');
    
    const riskVal = props[getActiveRiskField()] || 1;
    const hazVal = props[getActiveHazardField()] || 1;
    const vulVal = props[getActiveVulnerabilityField()] || 1;
    
    // Count daycares in this town
    const daycareCount = daycarePointsData ? daycarePointsData.features.filter(f => f.properties.town === props.town_name).length : 0;

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
        
        const card = document.createElement('div');
        card.className = 'daycare-item-card';
        
        card.innerHTML = `
            <div class="daycare-item-title">${props.name}</div>
            <div class="daycare-item-tags">
                <span class="item-tag tag-case">${props.case_type}</span>
                <span class="item-tag tag-service">${props.service_type}</span>
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
            // Leaflet uses [lat, lon], GeoJSON uses [lon, lat]
            map.setView([coords[1], coords[0]], 14);
            
            // Find marker in layer to open popup
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
// UI Event Handlers
// ==========================================================================
function setupUIControls() {
    // 1. Theme (Flooding vs Temperature) Switcher
    const themeButtons = document.querySelectorAll('#theme-selector .toggle-btn');
    themeButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            const targetBtn = e.currentTarget;
            themeButtons.forEach(b => b.classList.remove('active'));
            targetBtn.classList.add('active');
            
            activeTheme = targetBtn.dataset.theme;
            
            updateHeaderIndicator();
            updateLayers();
            updateStatsAndChart();
            populateDaycareList();
        });
    });

    // 2. Timeline Step Switcher
    const timelineSteps = document.querySelectorAll('#scenario-selector .timeline-step');
    timelineSteps.forEach(step => {
        step.addEventListener('click', (e) => {
            const targetStep = e.currentTarget;
            timelineSteps.forEach(s => s.classList.remove('active'));
            targetStep.classList.add('active');
            
            activeScenario = targetStep.dataset.scenario;
            
            updateHeaderIndicator();
            updateLayers();
            updateStatsAndChart();
            populateDaycareList();
        });
    });

    // 3. Calibration Sliders Listener
    const lonSlider = document.getElementById('slider-lon-shift');
    const latSlider = document.getElementById('slider-lat-shift');
    const scaleSlider = document.getElementById('slider-scale');
    
    lonSlider.addEventListener('input', applyCalibration);
    latSlider.addEventListener('input', applyCalibration);
    scaleSlider.addEventListener('input', applyCalibration);

    // 4. Mobile Sidebar Drawer Toggle
    const brand = document.querySelector('.brand');
    const container = document.querySelector('.app-container');
    const toggleIcon = document.getElementById('mobile-toggle-icon');

    if (brand && container) {
        brand.addEventListener('click', () => {
            if (window.innerWidth <= 768) {
                container.classList.toggle('sidebar-collapsed');
                
                // Update icon based on state
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
    
    const themeName = activeTheme === 'flood' ? '淹水風險等級' : '高溫風險等級';
    const scenarioName = activeScenario === 'current' ? '現況基準' : '升溫 1.5°C 情境推估';
    
    indicator.innerText = `${themeName}套疊 - ${scenarioName}`;
}

// ==========================================================================
// Legend Widget Addition
// ==========================================================================
function addLegend() {
    const legend = L.control({ position: 'bottomright' });

    legend.onAdd = function (map) {
        const div = L.DomUtil.create('div', 'map-legend');
        div.innerHTML = `
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
        return div;
    };

    legend.addTo(map);
}
