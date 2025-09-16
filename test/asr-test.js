
const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const path = require('path');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
require('dotenv').config();

const PORT = process.env.PORT || 8080;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

if (!DEEPGRAM_API_KEY) {
  throw new Error('Missing DEEPGRAM_API_KEY in .env');
}

const client = createClient(DEEPGRAM_API_KEY);

class ASRSession {
  constructor(ws, sessionId) {
    this.ws = ws;
    this.sessionId = sessionId;
    this.connection = null;
    this.setupDeepgram();
  }

  sendToClient(message) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  async setupDeepgram() {
    try {
      const connection = client.listen.live({
        model: "nova-2",
        encoding: "linear16",
        sample_rate: 48000,
        channels: 1,
        interim_results: true,
        punctuate: true,
        smart_format: true,
        utterance_end_ms: 1000,
        vad_events: true
      });

      this.connection = connection;

      connection.on(LiveTranscriptionEvents.Open, () => {
        console.log(`[${this.sessionId}] Deepgram connected`);
        this.sendToClient({ type: 'asr_status', status: 'connected' });
      });

      connection.on(LiveTranscriptionEvents.Transcript, (data) => {
        const transcript = data.channel?.alternatives?.[0]?.transcript?.trim();
        if (transcript) {
          this.sendToClient({
            type: 'transcript',
            text: transcript,
            is_final: data.is_final || false
          });
        }
      });

      connection.on(LiveTranscriptionEvents.Close, () => {
        console.log(`[${this.sessionId}] Deepgram closed`);
      });

      connection.on(LiveTranscriptionEvents.Error, (err) => {
        console.error(`[${this.sessionId}] Deepgram error:`, err);
        this.sendToClient({ type: 'asr_error', error: err.message });
      });

    } catch (error) {
      console.error(`[${this.sessionId}] Failed to setup Deepgram:`, error);
      this.sendToClient({ type: 'asr_error', error: 'Setup failed' });
    }
  }

  handleAudioChunk(buffer) {
    if (!this.connection) return;

    // Convert Float32Array → Int16Array for Deepgram linear16
    try {
      let processBuffer = buffer;
      const remainder = buffer.length % 4;
      if (remainder !== 0) {
        const padded = Buffer.alloc(buffer.length + (4 - remainder));
        buffer.copy(padded);
        processBuffer = padded;
      }

      const float32 = new Float32Array(processBuffer.buffer, processBuffer.byteOffset, processBuffer.length / 4);
      const int16 = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        int16[i] = Math.max(-32768, Math.min(32767, float32[i] * 32767));
      }

      const pcmBuffer = Buffer.from(int16.buffer);
      this.connection.send(pcmBuffer);

    } catch (err) {
      console.error(`[${this.sessionId}] Audio conversion error:`, err);
    }
  }

  cleanup() {
    if (this.connection) {
      this.connection.finish();
      this.connection = null;
    }
  }
}

// Express + WebSocket Server
const app = express();

// Serve asr-test.html as root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'asr-test.html'));
});

// Serve static files (CSS, JS, images, etc.)
app.use(express.static('public', { index: false }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  const sessionId = `sess_${Date.now()}`;
  console.log(`[${sessionId}] Client connected`);

  const session = new ASRSession(ws, sessionId);

  ws.on('message', (message) => {
    if (message instanceof Buffer) {
      session.handleAudioChunk(message);
    }
  });

  ws.on('close', () => {
    console.log(`[${sessionId}] Client disconnected`);
    session.cleanup();
  });

  ws.on('error', (err) => {
    console.error(`[${sessionId}] WS Error:`, err);
  });
});

server.listen(PORT, () => {
  console.log(`✅ ASR Test Server running at http://localhost:${PORT}`);
  console.log(`🎤 Speak into mic → see real-time transcripts from Deepgram`);
});