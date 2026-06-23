const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Fallback to index.html for SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Active public tunnel URL (if any)
let activeTunnelUrl = null;

// Store active rooms and participants
const rooms = {};

let cachedIceServers = null;
let lastFetchTime = 0;

async function getMeteredIceServers() {
  const now = Date.now();
  if (cachedIceServers && (now - lastFetchTime < 30 * 60 * 1000)) {
    return cachedIceServers;
  }

  try {
    console.log("[TURN] Fetching dynamic TURN credentials from Metered.ca...");
    const url = "https://klipra.metered.live/api/v1/turn/credential?secretKey=E4SMJBEDeygdSIw99xUeDdVtVX9pEvyZaIi-uiAVloe06Hsd";
    
    let data;
    if (typeof fetch === 'function') {
      const response = await fetch(url, { method: 'POST' });
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      data = await response.json();
    } else {
      const https = require('https');
      data = await new Promise((resolve, reject) => {
        const req = https.request(url, { method: 'POST' }, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
            } else {
              reject(new Error(`HTTP status ${res.statusCode}`));
            }
          });
        });
        req.on('error', reject);
        req.end();
      });
    }

    if (data && data.username && data.password) {
      console.log("[TURN] Structuring iceServers with fetched credentials.");
      cachedIceServers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:relay.metered.ca:80' },
        { urls: 'stun:stun.relay.metered.ca:80' },
        { urls: 'turn:relay.metered.ca:80', username: data.username, credential: data.password },
        { urls: 'turn:relay.metered.ca:443', username: data.username, credential: data.password },
        { urls: 'turn:relay.metered.ca:443?transport=tcp', username: data.username, credential: data.password },
        { urls: 'turns:relay.metered.ca:443?transport=tcp', username: data.username, credential: data.password },
        { urls: 'stun:openrelay.metered.ca:80' },
        { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
      ];
      lastFetchTime = now;
      console.log("[TURN] Successfully structured and cached TURN credentials.");
      return cachedIceServers;
    } else {
      throw new Error("Invalid credential format returned by Metered API");
    }
  } catch (err) {
    console.error("[TURN] Failed to fetch TURN credentials:", err.message || err);
    return [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:openrelay.metered.ca:80' },
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
    ];
  }
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  if (activeTunnelUrl) {
    socket.emit('tunnel-url', activeTunnelUrl);
  }

  socket.on('join-room', async ({ roomId, username, isHost }) => {
    socket.join(roomId);
    socket.roomId = roomId;
    socket.username = username;
    socket.isHost = isHost;

    if (!rooms[roomId]) {
      rooms[roomId] = { host: null, guest: null, users: {} };
    }

    rooms[roomId].users[socket.id] = { username, isHost };

    if (isHost) {
      rooms[roomId].host = socket.id;
      console.log(`Host ${username} (${socket.id}) joined room: ${roomId}`);
    } else {
      rooms[roomId].guest = socket.id;
      console.log(`Guest ${username} (${socket.id}) joined room: ${roomId}`);
    }

    socket.to(roomId).emit('user-joined', {
      id: socket.id,
      username,
      isHost
    });

    const dynamicIceServers = await getMeteredIceServers();

    socket.emit('room-state', {
      users: rooms[roomId].users,
      hostId: rooms[roomId].host,
      guestId: rooms[roomId].guest,
      customIceServers: dynamicIceServers
    });
  });

  socket.on('webrtc-offer', ({ offer, targetId }) => {
    io.to(targetId).emit('webrtc-offer', {
      offer,
      senderId: socket.id
    });
  });

  socket.on('webrtc-answer', ({ answer, targetId }) => {
    io.to(targetId).emit('webrtc-answer', {
      answer,
      senderId: socket.id
    });
  });

  socket.on('webrtc-candidate', ({ candidate, targetId }) => {
    io.to(targetId).emit('webrtc-candidate', {
      candidate,
      senderId: socket.id
    });
  });

  socket.on('start-recording', () => {
    if (socket.roomId) {
      console.log(`Recording started in room: ${socket.roomId}`);
      socket.to(socket.roomId).emit('start-recording');
    }
  });

  socket.on('stop-recording', () => {
    if (socket.roomId) {
      console.log(`Recording stopped in room: ${socket.roomId}`);
      socket.to(socket.roomId).emit('stop-recording');
    }
  });

  socket.on('recording-status-update', (status) => {
    if (socket.roomId && rooms[socket.roomId]) {
      const hostId = rooms[socket.roomId].host;
      if (hostId && hostId !== socket.id) {
        io.to(hostId).emit('guest-recording-status', status);
      }
    }
  });

  socket.on('screen-share-started', ({ senderName }) => {
    if (socket.roomId) {
      socket.to(socket.roomId).emit('screen-share-started', { senderName });
    }
  });

  socket.on('screen-share-stopped', () => {
    if (socket.roomId) {
      socket.to(socket.roomId).emit('screen-share-stopped');
    }
  });

  socket.on('layout-changed', ({ layout }) => {
    if (socket.roomId) {
      socket.to(socket.roomId).emit('layout-changed', { layout });
    }
  });

  socket.on('draw-stroke', ({ x0, y0, x1, y1, color }) => {
    if (socket.roomId) {
      socket.to(socket.roomId).emit('draw-stroke', { x0, y0, x1, y1, color });
    }
  });

  socket.on('draw-text', ({ x, y, text, color }) => {
    if (socket.roomId) {
      socket.to(socket.roomId).emit('draw-text', { x, y, text, color });
    }
  });

  socket.on('clear-drawings', () => {
    if (socket.roomId) {
      socket.to(socket.roomId).emit('clear-drawings');
    }
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      delete rooms[roomId].users[socket.id];

      if (rooms[roomId].host === socket.id) {
        rooms[roomId].host = null;
      }
      if (rooms[roomId].guest === socket.id) {
        rooms[roomId].guest = null;
      }

      socket.to(roomId).emit('user-left', {
        id: socket.id,
        username: socket.username,
        isHost: socket.isHost
      });

      if (Object.keys(rooms[roomId].users).length === 0) {
        delete rooms[roomId];
        console.log(`Room cleaned up: ${roomId}`);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Klipra Podcast Studio server running on http://localhost:${PORT}`);
  
  try {
    async function startTunnel() {
      console.log(`[Tunnel] Starting Cloudflare tunnel pointing to port ${PORT}...`);
      try {
        const { startTunnel: startCloudflareTunnel } = await import('untun');
        const tunnel = await startCloudflareTunnel({
          port: PORT,
          hostname: '127.0.0.1',
          acceptCloudflareNotice: true
        });

        const tunnelUrl = await tunnel.getURL();

        console.log('\n======================================================');
        console.log(`🚀 Klipra Podcast Studio is live on Cloudflare Tunnel!`);
        console.log(`👉 Guest invite URL: ${tunnelUrl}`);
        console.log('======================================================\n');

        activeTunnelUrl = tunnelUrl;
        io.emit('tunnel-url', activeTunnelUrl);

      } catch (err) {
        console.error(`[Tunnel Connection Failed]:`, err.message || err);
        setTimeout(startTunnel, 10000);
      }
    }

    setTimeout(startTunnel, 3000);
  } catch (e) {
    console.log('[Tunnel] untun package not found, skipping tunnel setup.');
  }
});
