const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

const app = express();

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "database.json");

app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, "public")));


// ============================================
// DATABASE HELPERS
// ============================================

function readDatabase() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, "[]");
    }

    const data = fs.readFileSync(DB_FILE, "utf8");

    return JSON.parse(data);
  } catch (error) {
    console.error("Database read error:", error);

    return [];
  }
}

function writeDatabase(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ============================================
// HOME PAGE
// ============================================

app.get("/", (req, res) => {
  const requests = readDatabase();

  res.json({
    success: true,
    totalRequests: requests.length,
    requests,
  });
});

// ============================================
// SYNC FROM MOBILE APP
// ============================================

app.post("/api/sync", (req, res) => {
  try {
    const incomingRequests = req.body;

    // Retrofit sends a List<EmergencyRequest>
    if (!Array.isArray(incomingRequests)) {
      return res.status(400).json({
        success: false,
        error: "Expected an array of emergency requests",
      });
    }

    const database = readDatabase();

    // Add every incoming request
    incomingRequests.forEach((request) => {
      database.push({
        ...request,

        serverReceivedAt: new Date().toISOString(),
      });
    });

    // Save to JSON file
    writeDatabase(database);

    console.log(`Received ${incomingRequests.length} request(s)`);

    res.status(200).json({
      success: true,
      received: incomingRequests.length,
      totalRequests: database.length,
    });
  } catch (error) {
    console.error("Sync error:", error);

    res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
});

app.get("/api/incidents", (req, res) => {
    const requests = readDatabase();

    res.json({
        success: true,
        totalRequests: requests.length,
        requests
    });
});


// ============================================
// CLEAR DATABASE - TESTING ONLY
// ============================================

app.delete("/api/clear", (req, res) => {
  writeDatabase([]);

  res.json({
    success: true,
    message: "Database cleared",
  });
});

// ============================================
// 404
// ============================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Endpoint not found",
  });
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
