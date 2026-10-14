(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    } else {
        root.AreaAggregation = api;
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    const METERS_PER_LATITUDE_DEGREE = 111320;
    const GRID_SIZE_METERS = 1000;

    function finiteNumber(value) {
        if ((typeof value !== "number" && typeof value !== "string") ||
            (typeof value === "string" && value.trim() === "")) return null;
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }

    function getValidCoordinates(report) {
        const latitude = finiteNumber(report && report.latitude);
        const longitude = finiteNumber(report && report.longitude);
        if (latitude === null || longitude === null ||
            latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
        return { latitude, longitude };
    }

    function getGridBounds(latitudeIndex, longitudeIndex) {
        const latitudeStep = GRID_SIZE_METERS / METERS_PER_LATITUDE_DEGREE;
        const south = latitudeIndex * latitudeStep;
        const north = south + latitudeStep;
        const centerLatitude = (south + north) / 2;
        const longitudeStep = GRID_SIZE_METERS /
            (METERS_PER_LATITUDE_DEGREE * Math.max(Math.cos(centerLatitude * Math.PI / 180), 1e-6));
        const west = longitudeIndex * longitudeStep;
        const east = west + longitudeStep;
        return { south, west, north, east, centerLatitude, longitudeStep };
    }

    function getGridCoordinates(latitude, longitude) {
        const latitudeIndex = Math.floor(latitude / (GRID_SIZE_METERS / METERS_PER_LATITUDE_DEGREE));
        const bounds = getGridBounds(latitudeIndex, 0);
        const longitudeIndex = Math.floor(longitude / bounds.longitudeStep);
        return {
            latitudeIndex,
            longitudeIndex,
            bounds: getGridBounds(latitudeIndex, longitudeIndex)
        };
    }

    function deduplicateReports(rows) {
        const unique = new Map();
        let invalidRecordCount = 0;
        const source = Array.isArray(rows) ? rows : [];
        source.forEach(report => {
            if (!report || report.id == null || String(report.id).trim() === "") {
                invalidRecordCount++;
                return;
            }
            unique.set(String(report.id).trim(), report);
        });
        return {
            reports: [...unique.values()],
            duplicateCount: Math.max(0, source.length - unique.size - invalidRecordCount),
            invalidRecordCount
        };
    }

    function getReportUpdate(report) {
        const values = [report.timestamp, report.serverReceivedAt]
            .map(value => value == null || value === "" ? NaN : new Date(value).getTime())
            .filter(Number.isFinite);
        return values.length ? Math.max(...values) : null;
    }

    function aggregateReportsByGrid(rows, classifySeverity) {
        const { reports, duplicateCount, invalidRecordCount } = deduplicateReports(rows);
        const areas = new Map();
        let invalidLocationCount = 0;

        reports.forEach(report => {
            const coordinates = getValidCoordinates(report);
            if (!coordinates) {
                invalidLocationCount++;
                return;
            }
            const grid = getGridCoordinates(coordinates.latitude, coordinates.longitude);
            const id = `${grid.latitudeIndex}:${grid.longitudeIndex}`;
            if (!areas.has(id)) {
                areas.set(id, {
                    id,
                    gridRow: grid.latitudeIndex,
                    gridColumn: grid.longitudeIndex,
                    bounds: grid.bounds,
                    reports: [],
                    typeCounts: {},
                    statusCounts: {},
                    maximumSeverity: null,
                    highSeverityCount: 0,
                    lastReportUpdate: null,
                    severityLevel: "unknown"
                });
            }
            const area = areas.get(id);
            area.reports.push(report);
            const type = String(report.type || "Unknown").trim() || "Unknown";
            const status = String(report.status || "Unknown").trim() || "Unknown";
            area.typeCounts[type] = (area.typeCounts[type] || 0) + 1;
            area.statusCounts[status] = (area.statusCounts[status] || 0) + 1;

            const severity = finiteNumber(report.severity);
            if (severity !== null) {
                area.maximumSeverity = area.maximumSeverity === null ?
                    severity : Math.max(area.maximumSeverity, severity);
                if (classifySeverity && ["high", "critical"].includes(classifySeverity(severity))) {
                    area.highSeverityCount++;
                }
            }
            const update = getReportUpdate(report);
            if (update !== null) {
                area.lastReportUpdate = area.lastReportUpdate === null ?
                    update : Math.max(area.lastReportUpdate, update);
            }
        });

        const severityOrder = ["low", "medium", "high", "critical"];
        const areaList = [...areas.values()];
        areaList.forEach(area => {
            const maximumLevel = area.maximumSeverity === null || !classifySeverity ?
                "unknown" : classifySeverity(area.maximumSeverity);
            const currentRank = severityOrder.indexOf(maximumLevel);
            const adjustedRank = currentRank >= 0 && area.highSeverityCount >= 2 ?
                Math.min(severityOrder.length - 1, currentRank + 1) : currentRank;
            area.severityLevel = adjustedRank >= 0 ? severityOrder[adjustedRank] : "unknown";
            area.totalRequests = area.reports.length;
            area.types = Object.keys(area.typeCounts);
        });
        areaList.sort((a, b) =>
            severityOrder.indexOf(b.severityLevel) - severityOrder.indexOf(a.severityLevel) ||
            b.highSeverityCount - a.highSeverityCount ||
            b.totalRequests - a.totalRequests
        );
        return { areas: areaList, uniqueReportCount: reports.length, duplicateCount, invalidRecordCount, invalidLocationCount };
    }

    return { aggregateReportsByGrid, deduplicateReports, getGridBounds, getGridCoordinates };
});
