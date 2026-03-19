const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// CORS headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Twilio Live Listen WebSocket Server' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', activeSessions: Object.keys(sessions).length });
});

// Store active listening sessions: callSid -> { twilioWs, browserClients: Set }
const sessions = {};

// WebSocket server on the same HTTP server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (path === '/twilio-stream') {
    // Twilio Media Stream connection
    handleTwilioStream(ws);
  } else if (path === '/listen') {
    // Browser client wants to listen
    const callSid = url.searchParams.get('callSid');
    handleBrowserClient(ws, callSid);
  } else {
    ws.close(1008, 'Unknown path');
  }
});

function handleTwilioStream(ws) {
  let callSid = null;
  let streamSid = null;

  console.log('[Twilio] New stream connection');

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.event === 'start') {
        streamSid = msg.start.streamSid;
        callSid = msg.start.customParameters?.callSid || msg.start.callSid;
        console.log('[Twilio] Stream started for call:', callSid, 'stream:', streamSid);

        if (!sessions[callSid]) {
          sessions[callSid] = { twilioWs: ws, browserClients: new Set() };
        } else {
          sessions[callSid].twilioWs = ws;
        }
      } else if (msg.event === 'media') {
        // Forward audio to all browser clients listening to this call
        if (callSid && sessions[callSid]) {
          const audioData = JSON.stringify({
            event: 'media',
            media: {
              payload: msg.media.payload,
              track: msg.media.track
            }
          });
          sessions[callSid].browserClients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(audioData);
            }
          });
        }
      } else if (msg.event === 'stop') {
        console.log('[Twilio] Stream stopped for call:', callSid);
        if (callSid && sessions[callSid]) {
          // Notify browser clients
          sessions[callSid].browserClients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ event: 'streamEnded' }));
            }
          });
          delete sessions[callSid];
        }
      }
    } catch (e) {
      console.error('[Twilio] Error parsing message:', e.message);
    }
  });

  ws.on('close', () => {
    console.log('[Twilio] Stream disconnected for call:', callSid);
    if (callSid && sessions[callSid]) {
      sessions[callSid].browserClients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ event: 'streamEnded' }));
        }
      });
      delete sessions[callSid];
    }
  });

  ws.on('error', (err) => {
    console.error('[Twilio] WebSocket error:', err.message);
  });
}

function handleBrowserClient(ws, callSid) {
  console.log('[Browser] Client connected for call:', callSid);

  if (!callSid) {
    ws.send(JSON.stringify({ event: 'error', message: 'Missing callSid' }));
    ws.close();
    return;
  }

  // Register this browser client
  if (!sessions[callSid]) {
    sessions[callSid] = { twilioWs: null, browserClients: new Set() };
  }
  sessions[callSid].browserClients.add(ws);

  ws.send(JSON.stringify({ event: 'connected', callSid }));

  ws.on('close', () => {
    console.log('[Browser] Client disconnected for call:', callSid);
    if (sessions[callSid]) {
      sessions[callSid].browserClients.delete(ws);
      if (sessions[callSid].browserClients.size === 0 && !sessions[callSid].twilioWs) {
        delete sessions[callSid];
      }
    }
  });

  ws.on('error', (err) => {
    console.error('[Browser] WebSocket error:', err.message);
  });
}

server.listen(PORT, () => {
  console.log(`WebSocket relay server running on port ${PORT}`);
});
