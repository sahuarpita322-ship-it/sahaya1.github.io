// npm install ws express cors
const WebSocket = require("ws");
const express = require("express");
const cors = require("cors");
const path = require("path");
const os = require("os");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Get local IP address for same WiFi access
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const PORT = process.env.PORT || 3000;
const LOCAL_IP = getLocalIP();

// Serve static files
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/share", (req, res) => {
  res.sendFile(path.join(__dirname, "share.html"));
});

app.get("/track", (req, res) => {
  res.sendFile(path.join(__dirname, "track.html"));
});

app.get("/driver", (req, res) => {
  res.sendFile(path.join(__dirname, "driver.html"));
});

app.get("/user", (req, res) => {
  res.sendFile(path.join(__dirname, "user.html"));
});

// WebSocket server
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log("=".repeat(50));
  console.log("🚀 Location Tracking Server Running");
  console.log("=".repeat(50));
  console.log(`📱 Local:   http://localhost:${PORT}`);
  console.log(`🌐 Network: http://${LOCAL_IP}:${PORT}`);
  console.log(`🔌 WebSocket: ws://${LOCAL_IP}:${PORT}`);
  console.log("=".repeat(50));
});

const wss = new WebSocket.Server({ server });

// Store active users: { userId: { lat, lng, ws, lastUpdate } }
const activeUsers = new Map();

// Store WebSocket connections for trackers
const trackers = new Set();

// Store WebSocket connections for drivers
const drivers = new Set();

// Store pending requests: { requestId: { type, userId, lat, lng, timestamp } }
const pendingRequests = new Map();

wss.on("connection", (ws, req) => {
  const clientIP = req.socket.remoteAddress;
  console.log(`[SERVER] New WebSocket connection from ${clientIP}`);

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      console.log(`[SERVER] Received message type: ${data.type}`);
      
      // Location update from share.html
      if (data.type === "location") {
        const userId = data.id;
        const userData = {
          lat: data.lat,
          lng: data.lng,
          ws: ws,
          lastUpdate: Date.now()
        };

        // Store or update user
        activeUsers.set(userId, userData);
        console.log(`[SERVER] 📍 Location update from ${userId}: ${data.lat.toFixed(6)}, ${data.lng.toFixed(6)}`);
        console.log(`[SERVER] Active users: ${activeUsers.size}, Trackers: ${trackers.size}, Drivers: ${drivers.size}`);

        // Broadcast to all trackers
        const broadcastData = {
          type: "location",
          id: userId,
          lat: data.lat,
          lng: data.lng,
          timestamp: Date.now()
        };

        let trackerCount = 0;
        trackers.forEach((tracker) => {
          if (tracker.readyState === WebSocket.OPEN) {
            tracker.send(JSON.stringify(broadcastData));
            trackerCount++;
          }
        });

        // Broadcast to all drivers
        let driverCount = 0;
        drivers.forEach((driver) => {
          if (driver.readyState === WebSocket.OPEN) {
            driver.send(JSON.stringify(broadcastData));
            driverCount++;
          }
        });
        
        console.log(`[SERVER] 📤 Broadcasted to ${trackerCount} tracker(s) and ${driverCount} driver(s)`);
      }

      // Tracker registration
      if (data.type === "tracker") {
        trackers.add(ws);
        console.log(`[SERVER] 📊 Tracker registered. Total trackers: ${trackers.size}`);

        // Send all active users to new tracker
        const allUsers = Array.from(activeUsers.entries()).map(([id, data]) => ({
          type: "location",
          id: id,
          lat: data.lat,
          lng: data.lng,
          timestamp: data.lastUpdate
        }));

        if (allUsers.length > 0) {
          console.log(`[SERVER] 📤 Sending ${allUsers.length} active user(s) to new tracker`);
          ws.send(JSON.stringify({
            type: "allUsers",
            users: allUsers
          }));
        } else {
          console.log(`[SERVER] No active users to send`);
        }
      }

      // Driver registration
      if (data.type === "driver") {
        drivers.add(ws);
        console.log(`[SERVER] 🚑 Driver registered. Total drivers: ${drivers.size}`);

        // Send all active users to new driver
        const allUsers = Array.from(activeUsers.entries()).map(([id, data]) => ({
          type: "location",
          id: id,
          lat: data.lat,
          lng: data.lng,
          timestamp: data.lastUpdate
        }));

        if (allUsers.length > 0) {
          console.log(`[SERVER] 📤 Sending ${allUsers.length} active user(s) to new driver`);
          ws.send(JSON.stringify({
            type: "allUsers",
            users: allUsers
          }));
        }
      }

      // Emergency request from user.html
      if (data.type === "emergency") {
        console.log(`[SERVER] 🚨 Emergency request: ${data.lat}, ${data.lng}`);
        // Use provided requestId or create one
        const reqId = data.requestId || `emergency_${Date.now()}`;
        const emergencyData = {
          type: "emergency",
          requestId: reqId,
          lat: data.lat,
          lng: data.lng,
          timestamp: Date.now()
        };

        // Store requester socket so we can notify later
        pendingRequests.set(reqId, { ...emergencyData, requesterWs: ws });

        let driverCount = 0;
        drivers.forEach((driver) => {
          if (driver.readyState === WebSocket.OPEN) {
            driver.send(JSON.stringify(emergencyData));
            driverCount++;
          }
        });

        console.log(`[SERVER] 📤 Emergency broadcasted to ${driverCount} driver(s)`);
      }

      // Share request from share.html
      if (data.type === "shareRequest") {
        // Accept optional requestId from client, otherwise generate
        const requestId = data.requestId || `${data.userId}_${Date.now()}`;
        const requestData = {
          type: "shareRequest",
          requestId: requestId,
          userId: data.userId,
          lat: data.lat,
          lng: data.lng,
          timestamp: Date.now()
        };

        // Store requester socket so we can reply to accept/reject even if user hasn't sent 'location' yet
        pendingRequests.set(requestId, { ...requestData, requesterWs: ws });

        // Also ensure the activeUsers map has this user so drivers/trackers know about them
        if (data.userId) {
          activeUsers.set(data.userId, { lat: data.lat, lng: data.lng, ws: ws, lastUpdate: Date.now() });
        }

        console.log(`[SERVER] 📤 Share request from ${data.userId} broadcasted to drivers`);

        let driverCount = 0;
        drivers.forEach((driver) => {
          if (driver.readyState === WebSocket.OPEN) {
            driver.send(JSON.stringify(requestData));
            driverCount++;
          }
        });

        console.log(`[SERVER] 📤 Share request broadcasted to ${driverCount} driver(s)`);
      }

      // Accept request from driver
      if (data.type === "acceptRequest") {
        const request = pendingRequests.get(data.requestId);
        if (request) {
          // Notify the requester (use stored requesterWs if available)
          if (request.requesterWs && request.requesterWs.readyState === WebSocket.OPEN) {
            request.requesterWs.send(JSON.stringify({
              type: "requestAccepted",
              requestId: data.requestId,
              driverId: data.driverId
            }));
          } else if (request.userId) {
            const userData = activeUsers.get(request.userId);
            if (userData && userData.ws && userData.ws.readyState === WebSocket.OPEN) {
              userData.ws.send(JSON.stringify({
                type: "requestAccepted",
                requestId: data.requestId,
                driverId: data.driverId
              }));
            }
          }

          // Notify trackers to start tracking
          const trackingData = {
            type: "startTracking",
            userId: request.userId,
            driverId: data.driverId,
            lat: request.lat,
            lng: request.lng
          };

          trackers.forEach((tracker) => {
            if (tracker.readyState === WebSocket.OPEN) {
              tracker.send(JSON.stringify(trackingData));
            }
          });

          pendingRequests.delete(data.requestId);
          console.log(`[SERVER] ✅ Request ${data.requestId} accepted by driver ${data.driverId}`);
        }
      }

      // Reject request from driver
      if (data.type === "rejectRequest") {
        const request = pendingRequests.get(data.requestId);
        if (request) {
          // Notify the requester (use stored requesterWs if available)
          if (request.requesterWs && request.requesterWs.readyState === WebSocket.OPEN) {
            request.requesterWs.send(JSON.stringify({
              type: "requestRejected",
              requestId: data.requestId
            }));
          } else if (request.userId) {
            const userData = activeUsers.get(request.userId);
            if (userData && userData.ws && userData.ws.readyState === WebSocket.OPEN) {
              userData.ws.send(JSON.stringify({
                type: "requestRejected",
                requestId: data.requestId
              }));
            }
          }

          pendingRequests.delete(data.requestId);
          console.log(`[SERVER] ❌ Request ${data.requestId} rejected`);
        }
      }

      // Location update from driver
      if (data.type === "locationUpdate") {
        console.log(`[SERVER] 🚑 Driver location update: ${data.driverId || 'driver'} ${data.lat}, ${data.lng}`);
        
        const locationData = {
          type: "locationUpdate",
          driverId: data.driverId || 'driver',
          lat: data.lat,
          lng: data.lng,
          timestamp: Date.now()
        };

        // Broadcast to all trackers (so track.html receives driver positions)
        let trackerCount = 0;
        trackers.forEach((tracker) => {
          if (tracker.readyState === WebSocket.OPEN) {
            tracker.send(JSON.stringify(locationData));
            trackerCount++;
          }
        });

        // Broadcast to all users (for user.html)
        let userCount = 0;
        activeUsers.forEach((userData, userId) => {
          if (userData.ws.readyState === WebSocket.OPEN) {
            userData.ws.send(JSON.stringify(locationData));
            userCount++;
          }
        });
        
        console.log(`[SERVER] 📤 Driver location broadcasted to ${userCount} user(s) and ${trackerCount} tracker(s)`);
      }

    } catch (err) {
      console.error("[SERVER] Error processing message:", err);
    }
  });

  ws.on("close", () => {
    console.log(`[SERVER] WebSocket connection closed`);

    // Remove user if they were sharing location
    for (const [userId, userData] of activeUsers.entries()) {
      if (userData.ws === ws) {
        activeUsers.delete(userId);
        console.log(`[SERVER] 👋 User disconnected: ${userId}`);

        // Notify trackers and drivers
        const disconnectData = {
          type: "disconnect",
          id: userId
        };

        trackers.forEach((tracker) => {
          if (tracker.readyState === WebSocket.OPEN) {
            tracker.send(JSON.stringify(disconnectData));
          }
        });

        drivers.forEach((driver) => {
          if (driver.readyState === WebSocket.OPEN) {
            driver.send(JSON.stringify(disconnectData));
          }
        });
        
        break;
      }
    }

    // Remove tracker
    if (trackers.has(ws)) {
      trackers.delete(ws);
      console.log(`[SERVER] 📊 Tracker removed. Remaining trackers: ${trackers.size}`);
    }

    // Remove driver
    if (drivers.has(ws)) {
      drivers.delete(ws);
      console.log(`[SERVER] 🚑 Driver removed. Remaining drivers: ${drivers.size}`);
    }
  });

  ws.on("error", (error) => {
    console.error("[SERVER] WebSocket error:", error);
  });
});

// Cleanup inactive users (disconnected without proper close)
setInterval(() => {
  const now = Date.now();
  const timeout = 10000; // 10 seconds

  for (const [userId, userData] of activeUsers.entries()) {
    if (now - userData.lastUpdate > timeout) {
      activeUsers.delete(userId);
      console.log(`[SERVER] ⏱️  User timeout: ${userId}`);

      const disconnectData = {
        type: "disconnect",
        id: userId
      };

      trackers.forEach((tracker) => {
        if (tracker.readyState === WebSocket.OPEN) {
          tracker.send(JSON.stringify(disconnectData));
        }
      });

      drivers.forEach((driver) => {
        if (driver.readyState === WebSocket.OPEN) {
          driver.send(JSON.stringify(disconnectData));
        }
      });
    }
  }
}, 5000); // Check every 5 seconds
