// ==========================================
// GLOBAL STATE
// ==========================================

let incidents = [];
let rawIncidents = [];
let duplicateCount = 0;
let reportConfidence = new Map();
let affectedAreas = [];
const AREA_DISTANCE_KM = 1;
let areaLayers = new Map();
let selectedAreaId = null;

let markers = new Map();


// ==========================================
// MAP
// ==========================================

const map = L.map("map", {
    zoomControl: true
}).setView(
    [34.056, -118.239],
    14
);

map.createPane("areaGridPane");
map.getPane("areaGridPane").style.zIndex = 390;

// Real OpenStreetMap tiles
L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
        maxZoom: 19,
        attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }
).addTo(map);


// ==========================================
// HELPERS
// ==========================================

function severityClass(severity) {
    const value = getFiniteNumber(severity);
    const { min, max } = getSeverityRange();
    if (value === null) return "low";
    const normalized = max > min ? (value - min) / (max - min) : 0;
    if (normalized >= 0.8) {
        return "critical";
    }

    if (normalized >= 0.6) {
        return "high";
    }

    if (normalized >= 0.3) {
        return "medium";
    }

    return "low";
}

function getSeverityRange() {
    const values = incidents.map(item => getFiniteNumber(item.severity)).filter(value => value !== null);
    return { min: values.length ? Math.min(...values) : 0, max: values.length ? Math.max(...values) : 0 };
}

function getFiniteNumber(value) {
    if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && value.trim() === "")) {
        return null;
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function isValidLocation(report) {
    const lat = getFiniteNumber(report?.latitude), lon = getFiniteNumber(report?.longitude);
    return lat !== null && lon !== null && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function calculateDistanceKm(a, b) {
    const radians = degrees => degrees * Math.PI / 180;
    const lat1 = radians(getFiniteNumber(a.latitude)), lat2 = radians(getFiniteNumber(b.latitude));
    const dLat = lat2 - lat1, dLon = radians(getFiniteNumber(b.longitude) - getFiniteNumber(a.longitude));
    const h = Math.min(1, Math.max(0, Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2));
    return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function deriveReportConfidence(rows) {
    const byId = new Map();
    rows.forEach(report => {
        if (!report || report.id == null || String(report.id).trim() === "") return;
        const key = String(report.id).trim();
        if (!byId.has(key)) byId.set(key, []);
        byId.get(key).push(report);
    });
    duplicateCount = [...byId.values()].reduce((sum, copies) => sum + Math.max(0, copies.length - 1), 0);
    incidents = [...byId.values()].map(copies => copies[copies.length - 1]);
    reportConfidence = new Map(incidents.map(report => {
        const copies = byId.get(String(report.id).trim()) || [];
        const reporter = String(report.reporterId ?? "").trim();
        const independent = new Set(incidents.filter(other => String(other.id).trim() !== String(report.id).trim() && other.type === report.type && isValidLocation(other) && isValidLocation(report) && calculateDistanceKm(report, other) <= AREA_DISTANCE_KM)
            .map(other => String(other.reporterId ?? "").trim()).filter(id => id && id !== reporter));
        const hasCorroboration = Boolean(reporter && independent.size);
        const score = Math.max(0, Math.min(100, 20 + (reporter ? 25 : 0) + (hasCorroboration ? 35 : 0) - (copies.length > 1 ? 25 : 0)));
        const status = copies.length > 1 ? "Potential duplicate" : independent.size && reporter ? "Verified" : "Pending";
        return [report.id, { score, status, independent: independent.size }];
    }));
}

function deriveAffectedAreas() {
    if (!window.AreaAggregation) {
        throw new Error("Area aggregation module did not load");
    }
    const result = window.AreaAggregation.aggregateReportsByGrid(
        incidents,
        severity => severityClass(severity)
    );
    affectedAreas = result.areas;
    if (selectedAreaId && !affectedAreas.some(area => area.id === selectedAreaId)) {
        selectedAreaId = null;
    }
}


function typeColor(type) {

    switch (type) {

        case "MEDICAL":
            return "#ff4d61";

        case "FOOD":
            return "#ff9f43";

        case "WATER":
            return "#35baf6";

        default:
            return "#ffffff";
    }
}


function formatDate(timestamp) {

    if (!timestamp) {
        return "Unknown";
    }

    const date = new Date(timestamp);

    return date.toLocaleString(
        [],
        {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit"
        }
    );
}


function formatCoordinates(latitude, longitude) {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return "Unknown";
    }
    return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
}


// ==========================================
// LOAD DATABASE
// ==========================================
async function loadIncidents() {
    try {
        const response = await fetch("http://localhost:3000/api/incidents");


        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();

        console.log("Database response:", data);

        rawIncidents = Array.isArray(data.requests) ? data.requests : [];
        deriveReportConfidence(rawIncidents);
        deriveAffectedAreas();
        updateStatusFilter();

        updateDashboard();

        document.getElementById("lastSync").textContent =
            new Date().toLocaleTimeString();

    } catch (error) {
        console.error("Failed to load incidents:", error);

        document.getElementById("lastSync").textContent =
            "OFFLINE";
    }
}

function updateStatusFilter() {
    const filter = document.getElementById("statusFilter");
    const selected = filter.value;
    const statusOptions = new Map();
    incidents.forEach(report => {
        const label = String(report.status || "Unknown").trim() || "Unknown";
        if (!statusOptions.has(label.toUpperCase())) statusOptions.set(label.toUpperCase(), label);
    });
    const statuses = [...statusOptions.entries()].sort((a, b) => a[1].localeCompare(b[1]));
    filter.replaceChildren(new Option("All statuses", "ALL"));
    statuses.forEach(([value, label]) => filter.add(new Option(label, value)));
    filter.value = statusOptions.has(selected) ? selected : "ALL";
}


// ==========================================
// FILTERING
// ==========================================

function getFilteredIncidents() {

    const enabledTypes =
        [...document.querySelectorAll(".type-filter:checked")]
            .map(input => input.value);


    const enabledSeverity =
        [...document.querySelectorAll(".severity-check:checked")]
            .map(input => input.value);


    const status =
        document.getElementById("statusFilter").value;


    return incidents.filter(incident => {

        const typeAllowed =
            enabledTypes.includes(incident.type);

        const severityAllowed =
            enabledSeverity.includes(
                severityClass(getFiniteNumber(incident.severity))
            );

        const statusAllowed =
            status === "ALL" ||
            (String(incident.status || "Unknown").trim() || "Unknown").toUpperCase() === status;

        return (
            typeAllowed &&
            severityAllowed &&
            statusAllowed
        );
    });
}


// ==========================================
// DASHBOARD UPDATE
// ==========================================

function updateDashboard() {

    deriveReportConfidence(rawIncidents);
    deriveAffectedAreas();

    updateCounts();

    updateMap();

    updateIncidentList();
    renderAreaDetails(affectedAreas.find(area => area.id === selectedAreaId));

    updateAnalytics();
    updateDecisionTables();
}


// ==========================================
// COUNTS
// ==========================================

function updateCounts() {

    const total =
        incidents.length;

    const critical = [...reportConfidence.values()].filter(item => item.status === "Pending").length;

    const high = duplicateCount;

    const medical =
        incidents.filter(
            i => i.type === "MEDICAL"
        ).length;

    const food =
        incidents.filter(
            i => i.type === "FOOD"
        ).length;

    const water =
        incidents.filter(
            i => i.type === "WATER"
        ).length;


    document.getElementById("totalIncidents")
        .textContent = total;

    document.getElementById("criticalIncidents")
        .textContent = critical;

    document.getElementById("highIncidents")
        .textContent = high;

    document.getElementById("medicalTotal").textContent = affectedAreas.length;


    document.getElementById("medicalCount")
        .textContent = medical;

    document.getElementById("foodCount")
        .textContent = food;

    document.getElementById("waterCount")
        .textContent = water;
}


// ==========================================
// MAP MARKERS
// ==========================================

function createMarker(incident) {

    const severity =
        getFiniteNumber(incident.severity);

    const className =
        severityClass(severity);


    const icon =
        L.divIcon({
            className: "",

            html:
                `<div class="incident-marker marker-${className}"></div>`,

            iconSize: [18, 18],

            iconAnchor: [9, 9],

            popupAnchor: [0, -9]
        });


    const marker =
        L.marker(
            [
                getFiniteNumber(incident.latitude),
                getFiniteNumber(incident.longitude)
            ],
            {
                icon
            }
        );


    marker.bindPopup(`
        <div class="popup-type"
             style="color:${typeColor(incident.type)}">

            ${incident.type}

        </div>

        <div class="popup-row">
            <span>Severity</span>
            <strong>${severity !== null ? severity : "Unknown"}</strong>
        </div>

        <div class="popup-row">
            <span>Status</span>
            <strong>${incident.status}</strong>
        </div>

        <div class="popup-row">
            <span>Reported</span>
            <strong>${formatDate(incident.timestamp)}</strong>
        </div>

        <div class="popup-row">
            <span>Reporter</span>
            <strong>${incident.reporterId || "Unknown"}</strong>
        </div>
    `);


    marker.on("click", () => {
        const area = affectedAreas.find(candidate => candidate.reports.some(report => String(report.id) === String(incident.id)));
        if (area) selectArea(area.id);
        openIncident(incident);
    });


    return marker;
}


function updateMap() {

    const filtered =
        getFilteredIncidents();

    renderAreaGrid();

    // Remove old markers
    markers.forEach(marker => {

        map.removeLayer(marker);

    });

    markers.clear();


    // Add current markers
    filtered.forEach(incident => {

        if (!isValidLocation(incident)) {
            return;
        }


        const marker =
            createMarker(incident);


        marker.addTo(map);

        markers.set(
            incident.id,
            marker
        );

    });
}

function getAreaColor(level) {
    return {
        critical: "#ef4444",
        high: "#f97316",
        medium: "#facc15",
        low: "#22c55e",
        unknown: "#64748b"
    }[level] || "#64748b";
}

function buildAreaTooltip(area) {
    const typeBreakdown = Object.entries(area.typeCounts)
        .map(([type, count]) => `<span>${escapeHtml(type)}: <strong>${count}</strong></span>`)
        .join("");
    const statusBreakdown = Object.entries(area.statusCounts)
        .map(([status, count]) => `<span>${escapeHtml(status)}: <strong>${count}</strong></span>`)
        .join("");
    const lastUpdate = area.lastReportUpdate === null ? "Unknown" : formatDate(area.lastReportUpdate);
    const maximumSeverity = area.maximumSeverity === null ? "Unknown" : escapeHtml(area.maximumSeverity);
    const centerLatitude = area.bounds.centerLatitude;
    const centerLongitude = (area.bounds.west + area.bounds.east) / 2;
    return `<div class="area-map-tooltip">
        <strong class="area-tooltip-title">Grid area ${area.id}</strong>
        <span>${centerLatitude.toFixed(4)}, ${centerLongitude.toFixed(4)} · 1 km × 1 km cell</span>
        <span class="area-tooltip-severity"><i style="background:${getAreaColor(area.severityLevel)}"></i>${escapeHtml(area.severityLevel.toUpperCase())} severity · max supplied value ${maximumSeverity}</span>
        <span>${area.totalRequests} unique request${area.totalRequests === 1 ? "" : "s"} · ${area.highSeverityCount} high-severity</span>
        <span class="area-tooltip-heading">REQUEST TYPES</span><div class="area-tooltip-breakdown">${typeBreakdown || "<span>None</span>"}</div>
        <span class="area-tooltip-heading">REQUEST STATUS</span><div class="area-tooltip-breakdown">${statusBreakdown || "<span>None</span>"}</div>
        <span class="area-tooltip-updated">Last report update: ${escapeHtml(lastUpdate)}</span>
    </div>`;
}

function buildAreaPopup(area) {
    return buildAreaTooltip(area);
}

function selectArea(areaId) {
    selectedAreaId = areaId;
    const area = affectedAreas.find(candidate => candidate.id === areaId);
    renderAreaDetails(area);
    document.querySelectorAll(".area-table-row").forEach(row => {
        row.classList.toggle("selected-area-row", row.dataset.areaId === areaId);
    });
    areaLayers.forEach((layer, id) => layer.setStyle({
        weight: id === areaId ? 3 : 2,
        fillOpacity: id === areaId ? 0.4 : 0.22
    }));
}

function renderAreaDetails(area) {
    const details = document.getElementById("areaDetails");
    if (!area) {
        details.innerHTML = '<div class="empty-state">Select a map cell or report to see its area statistics.</div>';
        return;
    }
    const typeSummary = Object.entries(area.typeCounts)
        .map(([type, count]) => `<span><strong>${count}</strong> ${escapeHtml(type)}</span>`).join("");
    const statusSummary = Object.entries(area.statusCounts)
        .map(([status, count]) => `<span><strong>${count}</strong> ${escapeHtml(status)}</span>`).join("");
    const reports = area.reports.map(report =>
        `<tr><td>${escapeHtml(report.id)}</td><td>${escapeHtml(report.type || "Unknown")}</td><td>${escapeHtml(report.status || "Unknown")}</td><td>${escapeHtml(report.severity ?? "Unknown")}</td></tr>`
    ).join("");
    const update = area.lastReportUpdate === null ? "Unknown" : formatDate(area.lastReportUpdate);
    details.innerHTML = `<div class="area-detail-summary">
        <div><span>AREA</span><strong>Grid ${area.id}</strong><small>${area.bounds.centerLatitude.toFixed(4)}, ${((area.bounds.west + area.bounds.east) / 2).toFixed(4)} · 1 km × 1 km</small></div>
        <div><span>SEVERITY</span><strong class="area-detail-severity ${area.severityLevel}">${escapeHtml(area.severityLevel.toUpperCase())}</strong><small>Maximum supplied value: ${escapeHtml(area.maximumSeverity ?? "Unknown")}</small></div>
        <div><span>UNIQUE REQUESTS</span><strong>${area.totalRequests}</strong><small>${area.highSeverityCount} high-severity request(s)</small></div>
        <div><span>LAST REPORT UPDATE</span><strong>${escapeHtml(update)}</strong></div>
    </div>
    <div class="area-detail-breakdowns"><div><h4>Request types</h4><div class="area-detail-tags">${typeSummary || "<span>None</span>"}</div></div><div><h4>Request statuses</h4><div class="area-detail-tags">${statusSummary || "<span>None</span>"}</div></div></div>
    <div class="table-wrap"><table class="operations-table"><thead><tr><th>Request ID</th><th>Type</th><th>Status</th><th>Supplied severity</th></tr></thead><tbody>${reports}</tbody></table></div>`;
}

function renderAreaGrid() {
    areaLayers.forEach(layer => map.removeLayer(layer));
    areaLayers.clear();
    affectedAreas.forEach(area => {
        const color = getAreaColor(area.severityLevel);
        const bounds = [[area.bounds.south, area.bounds.west], [area.bounds.north, area.bounds.east]];
        const layer = L.rectangle(bounds, {
            pane: "areaGridPane",
            color,
            fillColor: color,
            weight: 2,
            fillOpacity: selectedAreaId === area.id ? 0.4 : 0.22
        }).addTo(map);
        layer.bindTooltip(buildAreaTooltip(area), {
            sticky: true,
            direction: "top",
            opacity: 0.98,
            className: "area-leaflet-tooltip"
        });
        layer.bindPopup(buildAreaPopup(area), { maxWidth: 360 });
        layer.on({
            mouseover: () => layer.setStyle({ weight: 4, fillOpacity: 0.42 }),
            mouseout: () => layer.setStyle({
                weight: selectedAreaId === area.id ? 3 : 2,
                fillOpacity: selectedAreaId === area.id ? 0.4 : 0.22
            }),
            click: () => selectArea(area.id)
        });
        areaLayers.set(area.id, layer);
    });
}


// ==========================================
// FIT MAP
// ==========================================

function fitMap() {

    const filtered =
        getFilteredIncidents();


    if (!filtered.length) {
        return;
    }


    const coordinates =
        filtered
            .filter(isValidLocation)
            .map(
                incident => [
                    getFiniteNumber(incident.latitude),
                    getFiniteNumber(incident.longitude)
                ]
            );


    if (!coordinates.length) {
        return;
    }


    map.fitBounds(
        coordinates,
        {
            padding: [40, 40],
            maxZoom: 16
        }
    );
}


// ==========================================
// INCIDENT LIST
// ==========================================

function updateIncidentList() {

    const list =
        document.getElementById(
            "incidentList"
        );


    const filtered =
        getFilteredIncidents();


    const sort =
        document.getElementById(
            "sortSelect"
        ).value;


    let sorted =
        [...filtered];


    if (sort === "severity") {

        sorted.sort(
            (a, b) =>
                Number(b.severity) -
                Number(a.severity)
        );

    } else if (sort === "newest") {

        sorted.sort(
            (a, b) =>
                Number(b.timestamp) -
                Number(a.timestamp)
        );

    } else {

        sorted.sort(
            (a, b) =>
                Number(a.timestamp) -
                Number(b.timestamp)
        );
    }


    document.getElementById("visibleCount")
        .textContent =
        `${sorted.length} incident${sorted.length === 1 ? "" : "s"}`;


    if (!sorted.length) {

        list.innerHTML = `
            <div class="empty-state">
                No incidents match the current filters.
            </div>
        `;

        return;
    }


    list.innerHTML =
        sorted.map(incident => {

            const severity =
                getFiniteNumber(incident.severity);

            const className =
                severityClass(severity);


            return `
                <div
                    class="incident"
                    data-id="${incident.id}"
                >

                    <div class="incident-severity ${className}">
                        ${severity !== null ? severity : "Unknown"}
                    </div>

                    <div class="incident-main">

                        <strong
                            style="color:${typeColor(incident.type)}"
                        >
                            ${incident.type}
                        </strong>

                        <span>
                            ${formatDate(incident.timestamp)}
                            ·
                            ${formatCoordinates(
                                getFiniteNumber(incident.latitude),
                                getFiniteNumber(incident.longitude)
                            )}
                        </span>

                    </div>

                    <div class="incident-status">
                        <span>${incident.status || "Unknown"}</span><span class="verification-badge ${reportConfidence.get(incident.id)?.status === "Verified" ? "verified" : reportConfidence.get(incident.id)?.status === "Potential duplicate" ? "duplicate" : "pending"}">${reportConfidence.get(incident.id)?.status || "Pending"} · ${reportConfidence.get(incident.id)?.score ?? 20}%</span>
                    </div>

                </div>
            `;

        }).join("");


    list.querySelectorAll(".incident")
        .forEach(element => {

            element.addEventListener(
                "click",
                () => {

                    const incident =
                        incidents.find(
                            item =>
                                item.id ===
                                element.dataset.id
                        );

                    if (incident) {
                        const area = affectedAreas.find(candidate =>
                            candidate.reports.some(report => String(report.id) === String(incident.id)));
                        if (area) selectArea(area.id);
                        openIncident(incident);
                    }

                }
            );

        });
}


// ==========================================
// ANALYTICS
// ==========================================

function updateAnalytics() {

    const total =
        incidents.length || 1;


    const medical =
        incidents.filter(
            i => i.type === "MEDICAL"
        ).length;

    const food =
        incidents.filter(
            i => i.type === "FOOD"
        ).length;

    const water =
        incidents.filter(
            i => i.type === "WATER"
        ).length;


    setBar(
        "medicalBar",
        "medicalPercentage",
        medical,
        total
    );

    setBar(
        "foodBar",
        "foodPercentage",
        food,
        total
    );

    setBar(
        "waterBar",
        "waterPercentage",
        water,
        total
    );


    updatePriorityAlert();
    updateNewCharts();
}

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function updateDecisionTables() {
    const areaList = document.getElementById("areaList");
    const summary = document.getElementById("verificationSummary");
    if (!areaList || !summary) return;
    const counts = [...reportConfidence.values()].reduce((result, report) => { result[report.status] = (result[report.status] || 0) + 1; return result; }, {});
    summary.innerHTML = `<span><strong>${counts.Verified || 0}</strong> Verified</span><span><strong>${counts.Pending || 0}</strong> Pending</span><span><strong>${counts["Potential duplicate"] || 0}</strong> Potential duplicates</span><span><strong>${duplicateCount}</strong> Duplicate rows</span>`;
    if (!affectedAreas.length) {
        areaList.innerHTML = '<div class="empty-state">No reports with valid coordinates are available for 1 km grid aggregation.</div>';
    } else {
        areaList.innerHTML = `<table class="operations-table"><thead><tr><th>Grid area</th><th>Unique requests</th><th>Emergency type mix</th><th>Request status</th><th>Severity</th></tr></thead><tbody>${affectedAreas.map(area => `<tr class="area-table-row ${["high", "critical"].includes(area.severityLevel) ? "priority-row" : ""} ${selectedAreaId === area.id ? "selected-area-row" : ""}" data-area-id="${escapeHtml(area.id)}"><td><strong>Grid ${escapeHtml(area.id)}</strong><small>${area.bounds.centerLatitude.toFixed(4)}, ${((area.bounds.west + area.bounds.east) / 2).toFixed(4)} · 1 km × 1 km</small></td><td>${area.totalRequests}</td><td>${area.types.map(type => `${escapeHtml(type)} (${area.typeCounts[type]})`).join(", ") || "—"}</td><td>${Object.entries(area.statusCounts).map(([status, count]) => `${escapeHtml(status)} (${count})`).join(", ")}</td><td><span class="severity-pill ${area.severityLevel}">${escapeHtml(area.severityLevel.toUpperCase())} · max ${escapeHtml(area.maximumSeverity ?? "Unknown")} · ${area.highSeverityCount} high</span></td></tr>`).join("")}</tbody></table>`;
        areaList.querySelectorAll("[data-area-id]").forEach(row => {
            row.addEventListener("click", () => selectArea(row.dataset.areaId));
        });
    }
    const visible = getFilteredIncidents();
    const values = visible.map(item => getFiniteNumber(item.severity)).filter(value => value !== null);
    const severityContainer = document.getElementById("severityDistribution");
    if (!values.length) severityContainer.innerHTML = '<div class="empty-state">No severity values available.</div>';
    else {
        const min = Math.min(...values), max = Math.max(...values);
        const frequency = new Map();
        values.forEach(value => frequency.set(value, (frequency.get(value) || 0) + 1));
        const maximum = Math.max(...frequency.values(), 1);
        severityContainer.innerHTML = [...frequency.entries()].sort((a, b) => a[0] - b[0]).map(([value, count]) => `<div class="severity-column"><div class="bar"><div class="fill" style="height:${(count / maximum) * 100}%"></div></div><span>${value}</span></div>`).join("");
        severityContainer.title = `Supplied values range from ${min} to ${max}`;
    }
}


function setBar(
    barId,
    percentageId,
    count,
    total
) {

    const percentage =
        Math.round(
            (count / total) * 100
        );


    document.getElementById(barId)
        .style.width =
        `${percentage}%`;


    document.getElementById(percentageId)
        .textContent =
        `${percentage}%`;
}


// ==========================================
// SEVERITY CHART
// ==========================================

let incidentsOverTimeChart = null;
let requestStatusChart = null;

function updateNewCharts() {
    const statusCanvas = document.getElementById("requestStatusChart");

    if (!statusCanvas || typeof Chart === "undefined") {
        return;
    }

    const statusCounts = incidents.reduce((counts, incident) => {
        const status = String(incident.status || "Unknown").trim() || "Unknown";
        counts[status] = (counts[status] || 0) + 1;
        return counts;
    }, {});

    if (requestStatusChart) {
        requestStatusChart.destroy();
    }

    requestStatusChart = new Chart(statusCanvas, {
        type: "doughnut",
        data: {
            labels: Object.keys(statusCounts).length ? Object.keys(statusCounts) : ["No data"],
            datasets: [{
                data: Object.keys(statusCounts).length ? Object.values(statusCounts) : [0],
                backgroundColor: ["#64748b", "#f59e0b", "#10b981", "#0284c7", "#e11d48"]
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true
        }
    });
}

// ==========================================
// PRIORITY ALERT
// ==========================================

function updatePriorityAlert() {

    const critical = affectedAreas.filter(area => ["high", "critical"].includes(area.severityLevel));


    const alert =
        document.getElementById(
            "priorityAlert"
        );

    const text =
        document.getElementById(
            "priorityText"
        );


    if (!critical.length) {

        alert.style.background =
            "rgba(54,211,153,.05)";

        alert.style.borderColor =
            "rgba(54,211,153,.15)";

        text.textContent =
            "No high-priority areas detected.";

        return;
    }


    alert.style.background =
        "rgba(255,59,77,.07)";

    alert.style.borderColor =
        "rgba(255,59,77,.15)";


    text.textContent =
        `${critical.length} high-priority area${critical.length === 1 ? "" : "s"} require attention.`;
}


// ==========================================
// INCIDENT DETAILS
// ==========================================

function openIncident(incident) {

    const modal =
        document.getElementById(
            "incidentModal"
        );

    const content =
        document.getElementById(
            "modalContent"
        );


    const severity =
        getFiniteNumber(incident.severity);

    const className =
        severityClass(severity);


    content.innerHTML = `

        <div class="detail-header">

            <div
                class="detail-type"
                style="color:${typeColor(incident.type)}"
            >
                ${incident.type}
            </div>

            <div
                class="detail-severity ${className}"
                style="
                    color:${typeColor(incident.type)};
                    background:${typeColor(incident.type)}18;
                "
            >
                SUPPLIED SEVERITY ${Number.isFinite(severity) ? severity : "Unknown"}
            </div>

        </div>


        <div class="detail-grid">

            <div class="detail-field">

                <label>INCIDENT ID</label>

                <strong>
                    ${incident.id}
                </strong>

            </div>


            <div class="detail-field">

                <label>STATUS</label>

                <strong>
                    ${incident.status}
                </strong>

            </div>


            <div class="detail-field">

                <label>REPORTER</label>

                <strong>
                    ${incident.reporterId || "Unknown"}
                </strong>

            </div>


            <div class="detail-field">

                <label>REPORTED</label>

                <strong>
                    ${formatDate(incident.timestamp)}
                </strong>

            </div>


            <div class="detail-field">

                <label>LATITUDE</label>

                <strong>
                    ${getFiniteNumber(incident.latitude)?.toFixed(7) ?? "Unknown"}
                </strong>

            </div>


            <div class="detail-field">

                <label>LONGITUDE</label>

                <strong>
                    ${getFiniteNumber(incident.longitude)?.toFixed(7) ?? "Unknown"}
                </strong>

            </div>


            <div class="detail-field">

                <label>SERVER RECEIVED</label>

                <strong>
                    ${incident.serverReceivedAt
                        ? formatDate(
                            new Date(
                                incident.serverReceivedAt
                            ).getTime()
                          )
                        : "Unknown"}
                </strong>

            </div>


            <div class="detail-field">

                <label>PRIORITY</label>

                <strong
                    style="color:${typeColor(
                        incident.type
                    )}"
                >
                    ${reportConfidence.get(incident.id)?.status || "Pending"} · ${reportConfidence.get(incident.id)?.score ?? 20}% confidence
                </strong>

            </div>

        </div>
    `;


    modal.classList.remove("hidden");


    // Focus map on incident
    if (isValidLocation(incident)) {

        map.flyTo(
            [
                getFiniteNumber(incident.latitude),
                getFiniteNumber(incident.longitude)
            ],
            17,
            {
                duration: 0.8
            }
        );


        const marker =
            markers.get(incident.id);


        if (marker) {
            marker.openPopup();
        }
    }
}


// ==========================================
// MODAL EVENTS
// ==========================================

document
    .getElementById("closeModal")
    .addEventListener(
        "click",
        () => {

            document
                .getElementById("incidentModal")
                .classList.add("hidden");

        }
    );


document
    .getElementById("incidentModal")
    .addEventListener(
        "click",
        event => {

            if (
                event.target.id ===
                "incidentModal"
            ) {

                event.currentTarget
                    .classList
                    .add("hidden");

            }

        }
    );


// ==========================================
// FILTER EVENTS
// ==========================================

document
    .querySelectorAll(".type-filter")
    .forEach(input => {

        input.addEventListener(
            "change",
            updateDashboard
        );

    });


document
    .querySelectorAll(".severity-check")
    .forEach(input => {

        input.addEventListener(
            "change",
            updateDashboard
        );

    });


document
    .getElementById("statusFilter")
    .addEventListener(
        "change",
        updateDashboard
    );


document
    .getElementById("sortSelect")
    .addEventListener(
        "change",
        updateIncidentList
    );


document
    .getElementById("refreshButton")
    .addEventListener(
        "click",
        loadIncidents
    );


document
    .getElementById("fitMap")
    .addEventListener(
        "click",
        fitMap
    );


// ==========================================
// CLOCK
// ==========================================

function updateClock() {

    document.getElementById("currentTime")
        .textContent =
        new Date().toLocaleString(
            [],
            {
                weekday: "short",
                month: "short",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit"
            }
        );
}


setInterval(
    updateClock,
    1000
);

updateClock();


// ==========================================
// AUTO REFRESH
// ==========================================

// Pull latest database every 10 seconds
setInterval(
    loadIncidents,
    10000
);


// ==========================================
// INITIAL LOAD
// ==========================================

loadIncidents();
