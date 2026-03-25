const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// Keep-alive interval to prevent idle disconnections
const KEEPALIVE_INTERVAL = 25000;

// CORS headers
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'Twilio Live Listen WebSocket Server v2.0' });
});

app.get('/health', (req, res) => {
    const sessionInfo = {};
    for (const [sid, session] of Object.entries(sessions)) {
          sessionInfo[sid] = {
                  hasTwilioStream: !!session.twilioWs,
                  browserClients: session.browserClients.size,
                  tracks: Object.keys(session.trackBuffers || {})
          };
    }
    res.json({ status: 'healthy', activeSessions: Object.keys(sessions).length, sessions: sessionInfo });
});

// Store active listening sessions: callSid -> { twilioWs, browserClients: Set, trackBuffers }
const sessions = {};

// WebSocket server on the same HTTP server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

         if (path === '/twilio-stream') {
               handleTwilioStream(ws);
         } else if (path === '/listen') {
               const callSid = url.searchParams.get('callSid');
               handleBrowserClient(ws, callSid);
         } else {
               ws.close(1008, 'Unknown path');
         }
});

function handleTwilioStream(ws) {
    let callSid = null;
    let streamSid = null;
    let sequenceNumbers = { inbound: 0, outbound: 0 };

  console.log('[Twilio] New stream connection');

  // Set up keepalive ping
  const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
                ws.ping();
        }
  }, KEEPALIVE_INTERVAL);

  ws.on('message', (data) => {
        try {
                const msg = JSON.parse(data);

          if (msg.event === 'start') {
                    streamSid = msg.start.streamSid;
                    callSid = msg.start.customParameters?.callSid || msg.start.callSid;

                  console.log('[Twilio] Stream started for call:', callSid, 'stream:', streamSid);
                    console.log('[Twilio] Media format:', JSON.stringify(msg.start.mediaFormat));
                    console.log('[Twilio] Tracks:', msg.start.tracks);

                  if (!sessions[callSid]) {
                              sessions[callSid] = {
                                            twilioWs: ws,
                                            browserClients: new Set(),
                                            streamSid: streamSid,
                                            startTime: Date.now(),
                                            trackBuffers: {}
                              };
                  } else {
                              sessions[callSid].twilioWs = ws;
                              sessions[callSid].streamSid = streamSid;
                  }

                  // Notify connected browser clients that stream is active
                  sessions[callSid].browserClients.forEach((client) => {
                              if (client.readyState === WebSocket.OPEN) {
                                            client.send(JSON.stringify({ event: 'streamStarted', callSid, streamSid }));
                              }
                  });

          } else if (msg.event === 'media') {
                    if (callSid && sessions[callSid]) {
                                const track = msg.media.track || 'inbound';
                                const payload = msg.media.payload;
                                const timestamp = msg.media.timestamp;
                                const chunk = msg.media.chunk;

                      // Track sequence for ordering
                      sequenceNumbers[track] = (sequenceNumbers[track] || 0) + 1;

                      // Forward audio to all browser clients listening to this call
                      // Send with full metadata for proper reconstruction on client side
                      const audioData = JSON.stringify({
                                    event: 'media',
                                    media: {
                                                    payload: payload,
                                                    track: track,
                                                    timestamp: timestamp,
                                                    chunk: chunk,
                                                    seq: sequenceNumbers[track]
                                    }
                      });

                      sessions[callSid].browserClients.forEach((client) => {
                                    if (client.readyState === WebSocket.OPEN) {
                                                    try {
                                                                      client.send(audioData);
                                                    } catch (e) {
                                                                      console.error('[Twilio] Error sending to browser client:', e.message);
                                                    }
                                    }
                      });
                    }

          } else if (msg.event === 'mark') {
                    // Forward mark events for synchronization
                  if (callSid && sessions[callSid]) {
                              const markData = JSON.stringify({
                                            event: 'mark',
                                            mark: msg.mark
                              });
                              sessions[callSid].browserClients.forEach((client) => {
                                            if (client.readyState === WebSocket.OPEN) {
                                                            client.send(markData);
                                            }
                              });
                  }

          } else if (msg.event === 'stop') {
                    console.log('[Twilio] Stream stopped for call:', callSid);
                    cleanupSession(callSid, 'streamEnded');
          }
        } catch (e) {
                console.error('[Twilio] Error parsing message:', e.message);
        }
  });

  ws.on('close', (code, reason) => {
        console.log(`[Twilio] Stream disconnected for call: ${callSid} (code: ${code})`);
        clearInterval(pingInterval);
        cleanupSession(callSid, 'streamDisconnected');
  });

  ws.on('error', (err) => {
        console.error('[Twilio] WebSocket error:', err.message);
        clearInterval(pingInterval);
  });

  ws.on('pong', () => {
        // Connection is alive
  });
}

function handleBrowserClient(ws, callSid) {
    console.log('[Browser] Client connected for call:', callSid);

  if (!callSid) {
        ws.send(JSON.stringify({ event: 'error', message: 'Missing callSid' }));
        ws.close();
        return;
  }

  // Set up keepalive ping for browser client
  const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
                ws.ping();
        }
  }, KEEPALIVE_INTERVAL);

  // Register this browser client
  if (!sessions[callSid]) {
        sessions[callSid] = {
                twilioWs: null,
                browserClients: new Set(),
                streamSid: null,
                startTime: Date.now(),
                trackBuffers: {}
        };
  }

  sessions[callSid].browserClients.add(ws);

  // Send connection confirmation with session info
  ws.send(JSON.stringify({
        event: 'connected',
        callSid,
        hasActiveStream: !!sessions[callSid].twilioWs,
        streamSid: sessions[callSid].streamSid
  }));

  ws.on('close', () => {
        console.log('[Browser] Client disconnected for call:', callSid);
        clearInterval(pingInterval);
        if (sessions[callSid]) {
                sessions[callSid].browserClients.delete(ws);
                if (sessions[callSid].browserClients.size === 0 && !sessions[callSid].twilioWs) {
                          delete sessions[callSid];
                }
        }
  });

  ws.on('error', (err) => {
        console.error('[Browser] WebSocket error:', err.message);
        clearInterval(pingInterval);
  });

  ws.on('pong', () => {
        // Connection is alive
  });
}

function cleanupSession(callSid, reason) {
    if (callSid && sessions[callSid]) {
          // Notify browser clients
      sessions[callSid].browserClients.forEach((client) => {
              if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ event: reason, callSid }));
              }
      });

      // Only delete if no browser clients remain
      if (sessions[callSid].browserClients.size === 0) {
              delete sessions[callSid];
      } else {
              sessions[callSid].twilioWs = null;
              sessions[callSid].streamSid = null;
      }
    }
}

// Self-ping to prevent Render free tier spin-down
// This will be useful even after upgrading to starter plan for reliability
if (process.env.RENDER_EXTERNAL_URL) {
    setInterval(() => {
          http.get(`${process.env.RENDER_EXTERNAL_URL}/health`, (res) => {
                  // Keep alive
          }).on('error', () => {});
    }, 14 * 60 * 1000); // Every 14 minutes
}

server.listen(PORT, () => {
    console.log(`WebSocket relay server v2.0 running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
});
