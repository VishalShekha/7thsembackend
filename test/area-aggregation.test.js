const test = require("node:test");
const assert = require("node:assert/strict");
const { aggregateReportsByGrid, getGridBounds, getGridCoordinates } = require("../public/area-aggregation");

const classifySeverity = value => value >= 9 ? "critical" :
    value >= 7 ? "high" : value >= 4 ? "medium" : "low";

test("groups nearby reports into the same 1 km grid cell and aggregates unique request stats", () => {
    const result = aggregateReportsByGrid([
        { id: "water-1", type: "WATER", latitude: 34.05, longitude: -118.24, timestamp: 1700000000000, status: "CREATED", severity: 3 },
        { id: "water-1", type: "WATER", latitude: 34.05, longitude: -118.24, serverReceivedAt: "2026-01-01T00:00:00Z", status: "RESOLVED", severity: 3 },
        { id: "medical-1", type: "MEDICAL", latitude: 34.0505, longitude: -118.2395, timestamp: 1700000001000, status: "IN_PROGRESS", severity: 10 }
    ], classifySeverity);

    assert.equal(result.uniqueReportCount, 2);
    assert.equal(result.duplicateCount, 1);
    assert.equal(result.invalidRecordCount, 0);
    assert.equal(result.invalidLocationCount, 0);
    assert.equal(result.areas.length, 1);

    const area = result.areas[0];
    assert.equal(area.totalRequests, 2);
    assert.deepEqual(area.typeCounts, { WATER: 1, MEDICAL: 1 });
    assert.deepEqual(area.statusCounts, { RESOLVED: 1, IN_PROGRESS: 1 });
    assert.equal(area.maximumSeverity, 10);
    assert.equal(area.highSeverityCount, 1);
    assert.equal(area.severityLevel, "critical");
    assert.equal(area.lastReportUpdate, Date.parse("2026-01-01T00:00:00Z"));
    assert.ok(area.bounds.north > area.bounds.south);
    assert.ok(area.bounds.east > area.bounds.west);
});

test("returns distinct adjacent grid cells at their 1 km latitude and longitude boundaries", () => {
    const first = getGridCoordinates(34.05, -118.24);
    const bounds = getGridBounds(first.latitudeIndex, first.longitudeIndex);
    const second = getGridCoordinates(bounds.north + 0.00001, -118.24);
    const third = getGridCoordinates(34.05, bounds.east + 0.00001);

    assert.notEqual(first.latitudeIndex, second.latitudeIndex);
    assert.notEqual(first.longitudeIndex, third.longitudeIndex);
    assert.ok(Math.abs((bounds.north - bounds.south) * 111320 - 1000) < 1e-6);
    assert.ok(Math.abs((bounds.east - bounds.west) * 111320 *
        Math.cos(bounds.centerLatitude * Math.PI / 180) - 1000) < 1e-6);
});

test("promotes an area when multiple requests have high supplied severity", () => {
    const result = aggregateReportsByGrid([
        { id: "high-1", latitude: 34.05, longitude: -118.24, severity: 8 },
        { id: "high-2", latitude: 34.0505, longitude: -118.2395, severity: 7 }
    ], classifySeverity);

    assert.equal(result.areas[0].maximumSeverity, 8);
    assert.equal(result.areas[0].highSeverityCount, 2);
    assert.equal(result.areas[0].severityLevel, "critical");
});

test("safely excludes invalid locations and invalid records", () => {
    const result = aggregateReportsByGrid([
        { id: "missing-coordinate", latitude: null, longitude: "", severity: 5 },
        { id: "invalid-coordinate", latitude: 91, longitude: 200, severity: 3 },
        { type: "FOOD", latitude: 34.05, longitude: -118.24 }
    ], classifySeverity);

    assert.equal(result.uniqueReportCount, 2);
    assert.equal(result.invalidRecordCount, 1);
    assert.equal(result.invalidLocationCount, 2);
    assert.equal(result.areas.length, 0);
});
