// ==========================================
// GLOBAL STATE
// ==========================================

let incidents = [];

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

    if (severity >= 9) {
        return "critical";
    }

    if (severity >= 7) {
        return "high";
    }

    if (severity >= 4) {
        return "medium";
    }

    return "low";
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

        incidents = Array.isArray(data.requests)
            ? data.requests
            : [];

        updateDashboard();

        document.getElementById("lastSync").textContent =
            new Date().toLocaleTimeString();

    } catch (error) {
        console.error("Failed to load incidents:", error);

        document.getElementById("lastSync").textContent =
            "OFFLINE";
    }
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
                severityClass(Number(incident.severity))
            );

        const statusAllowed =
            status === "ALL" ||
            incident.status === status;

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

    updateCounts();

    updateMap();

    updateIncidentList();

    updateAnalytics();
}


// ==========================================
// COUNTS
// ==========================================

function updateCounts() {

    const total =
        incidents.length;

    const critical =
        incidents.filter(
            i => Number(i.severity) >= 9
        ).length;

    const high =
        incidents.filter(
            i =>
                Number(i.severity) >= 7 &&
                Number(i.severity) <= 8
        ).length;

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

    document.getElementById("medicalTotal")
        .textContent = medical;


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
        Number(incident.severity);

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
                Number(incident.latitude),
                Number(incident.longitude)
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
            <strong>${severity}/10</strong>
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
        openIncident(incident);
    });


    return marker;
}


function updateMap() {

    const filtered =
        getFilteredIncidents();


    // Remove old markers
    markers.forEach(marker => {

        map.removeLayer(marker);

    });

    markers.clear();


    // Add current markers
    filtered.forEach(incident => {

        if (
            typeof incident.latitude !== "number" ||
            typeof incident.longitude !== "number"
        ) {
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
            .filter(
                incident =>
                    Number.isFinite(
                        Number(incident.latitude)
                    ) &&
                    Number.isFinite(
                        Number(incident.longitude)
                    )
            )
            .map(
                incident => [
                    Number(incident.latitude),
                    Number(incident.longitude)
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
                Number(incident.severity);

            const className =
                severityClass(severity);


            return `
                <div
                    class="incident"
                    data-id="${incident.id}"
                >

                    <div class="incident-severity ${className}">
                        ${severity}
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
                                Number(incident.latitude),
                                Number(incident.longitude)
                            )}
                        </span>

                    </div>

                    <div class="incident-status">
                        ${incident.status}
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


    updateSeverityChart();

    updatePriorityAlert();
    updateNewCharts();
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
    const timeCanvas = document.getElementById("incidentsOverTimeChart");
    const statusCanvas = document.getElementById("requestStatusChart");

    if (!timeCanvas || !statusCanvas || typeof Chart === "undefined") {
        return;
    }

    // Group incidents by date
    const dailyCounts = {};

    incidents.forEach((incident) => {
        const rawDate =
            incident.timestamp ||
            incident.createdAt ||
            incident.serverReceivedAt;

        if (!rawDate) return;

        const date = new Date(rawDate);

        if (isNaN(date.getTime())) return;

        const day = date.toLocaleDateString();
        dailyCounts[day] = (dailyCounts[day] || 0) + 1;
    });

    const sortedDays = Object.keys(dailyCounts).sort(
        (a, b) => new Date(a) - new Date(b)
    );

    const timeLabels = sortedDays.length ? sortedDays : ["No data"];
    const timeValues = sortedDays.map((day) => dailyCounts[day]);

    if (incidentsOverTimeChart) {
        incidentsOverTimeChart.destroy();
    }

    incidentsOverTimeChart = new Chart(timeCanvas, {
        type: "line",
        data: {
            labels: timeLabels,
            datasets: [{
                label: "Incidents",
                data: timeValues.length ? timeValues : [0],
                borderColor: "#008080",
                backgroundColor: "rgba(0, 128, 128, 0.15)",
                fill: true,
                tension: 0.3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: { precision: 0 }
                }
            }
        }
    });

    // Count incidents by status
    const statusCounts = {
        Created: 0,
        Acknowledged: 0,
        Resolved: 0
    };

    incidents.forEach((incident) => {
        const status = String(incident.status || "Created").toLowerCase();

        if (status === "acknowledged") {
            statusCounts.Acknowledged++;
        } else if (status === "resolved" || status === "closed") {
            statusCounts.Resolved++;
        } else {
            statusCounts.Created++;
        }
    });

    if (requestStatusChart) {
        requestStatusChart.destroy();
    }

    requestStatusChart = new Chart(statusCanvas, {
        type: "doughnut",
        data: {
            labels: Object.keys(statusCounts),
            datasets: [{
                data: Object.values(statusCounts),
                backgroundColor: ["#64748b", "#f59e0b", "#10b981"]
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true
        }
    });
}

function updateSeverityChart() {

    const container =
        document.getElementById(
            "severityDistribution"
        );


    const levels = [
        { label: "1", min: 1, max: 1 },
        { label: "2", min: 2, max: 2 },
        { label: "3", min: 3, max: 3 },
        { label: "4", min: 4, max: 5 },
        { label: "6", min: 6, max: 6 },
        { label: "7", min: 7, max: 8 },
        { label: "9", min: 9, max: 10 }
    ];


    const values =
        levels.map(level => {

            return incidents.filter(
                incident => {

                    const severity =
                        Number(
                            incident.severity
                        );

                    return (
                        severity >= level.min &&
                        severity <= level.max
                    );
                }
            ).length;

        });


    const max =
        Math.max(...values, 1);


    container.innerHTML =
        levels.map(
            (level, index) => {

                const count =
                    values[index];

                const height =
                    (count / max) * 100;


                return `
                    <div class="severity-column">

                        <div class="bar">
                            <div
                                class="fill"
                                style="height:${height}%"
                            ></div>
                        </div>

                        <span>
                            ${level.label}
                        </span>

                    </div>
                `;

            }
        ).join("");
}


// ==========================================
// PRIORITY ALERT
// ==========================================

function updatePriorityAlert() {

    const critical =
        incidents.filter(
            incident =>
                Number(incident.severity) >= 9
        );


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
            "No critical incidents detected.";

        return;
    }


    alert.style.background =
        "rgba(255,59,77,.07)";

    alert.style.borderColor =
        "rgba(255,59,77,.15)";


    const medicalCritical =
        critical.filter(
            i => i.type === "MEDICAL"
        ).length;


    text.textContent =
        `${critical.length} critical incident${
            critical.length === 1 ? "" : "s"
        } require priority attention${
            medicalCritical
                ? `, including ${medicalCritical} critical medical request${
                    medicalCritical === 1 ? "" : "s"
                  }`
                : ""
        }.`;
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
        Number(incident.severity);

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
                SEVERITY ${severity}/10
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
                    ${Number(incident.latitude).toFixed(7)}
                </strong>

            </div>


            <div class="detail-field">

                <label>LONGITUDE</label>

                <strong>
                    ${Number(incident.longitude).toFixed(7)}
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
                    ${severity >= 9
                        ? "CRITICAL"
                        : severity >= 7
                            ? "HIGH"
                            : severity >= 4
                                ? "MEDIUM"
                                : "LOW"}
                </strong>

            </div>

        </div>
    `;


    modal.classList.remove("hidden");


    // Focus map on incident
    if (
        Number.isFinite(
            Number(incident.latitude)
        ) &&
        Number.isFinite(
            Number(incident.longitude)
        )
    ) {

        map.flyTo(
            [
                Number(incident.latitude),
                Number(incident.longitude)
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
