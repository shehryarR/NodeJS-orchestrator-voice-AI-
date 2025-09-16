const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const path = require('path');
const { createClient } = require('@deepgram/sdk');
require('dotenv').config();

const PORT = process.env.PORT || 8081;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

if (!DEEPGRAM_API_KEY) {
  throw new Error('Missing DEEPGRAM_API_KEY in .env');
}

const client = createClient(DEEPGRAM_API_KEY);

class TTSSession {
  constructor(ws, sessionId) {
    this.ws = ws;
    this.sessionId = sessionId;
  }

  sendToClient(message) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  sendAudioToClient(audioBuffer) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(audioBuffer);
    }
  }

  async synthesizeText(text, options = {}) {
    const startTime = Date.now();
    const textLength = text.length;
    
    try {
      console.log(`[${this.sessionId}] 🎤 Starting synthesis for ${textLength} characters: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
      
      const requestOptions = {
        model: options.model || "aura-asteria-en",
        encoding: "linear16",
        container: "none",
        sample_rate: 48000,
        ...options
      };

      // Send status update
      this.sendToClient({ 
        type: 'tts_status', 
        status: 'synthesizing',
        text: text,
        startTime: startTime
      });

      const apiStartTime = Date.now();
      console.log(`[${this.sessionId}] 📡 Sending request to Deepgram API...`);
      
      const response = await client.speak.request(
        { text },
        requestOptions
      );

      const apiResponseTime = Date.now() - apiStartTime;
      console.log(`[${this.sessionId}] ⚡ API response received in ${apiResponseTime}ms`);

      // Get the audio buffer
      const streamStartTime = Date.now();
      console.log(`[${this.sessionId}] 📥 Starting audio stream download...`);
      
      const audioBuffer = await response.getStream();
      if (!audioBuffer) {
        throw new Error('No audio data received');
      }

      // Convert stream to buffer
      const chunks = [];
      let totalBytes = 0;
      for await (const chunk of audioBuffer) {
        chunks.push(chunk);
        totalBytes += chunk.length;
      }
      const fullBuffer = Buffer.concat(chunks);
      
      const streamDownloadTime = Date.now() - streamStartTime;
      const totalTime = Date.now() - startTime;
      const audioDuration = fullBuffer.length / (48000 * 2); // 48kHz, 16-bit = 2 bytes per sample
      
      console.log(`[${this.sessionId}] ✅ Synthesis complete!`);
      console.log(`[${this.sessionId}] 📊 Performance Stats:`);
      console.log(`[${this.sessionId}]    Text length: ${textLength} characters`);
      console.log(`[${this.sessionId}]    Audio size: ${fullBuffer.length} bytes (${(fullBuffer.length / 1024).toFixed(1)} KB)`);
      console.log(`[${this.sessionId}]    Audio duration: ${audioDuration.toFixed(2)} seconds`);
      console.log(`[${this.sessionId}]    API response time: ${apiResponseTime}ms`);
      console.log(`[${this.sessionId}]    Stream download time: ${streamDownloadTime}ms`);
      console.log(`[${this.sessionId}]    Total latency: ${totalTime}ms`);
      console.log(`[${this.sessionId}]    Characters per second: ${(textLength / (totalTime / 1000)).toFixed(1)}`);
      console.log(`[${this.sessionId}]    Real-time factor: ${(audioDuration / (totalTime / 1000)).toFixed(2)}x`);

      // Send completion status with timing info
      this.sendToClient({ 
        type: 'tts_status', 
        status: 'completed',
        audioSize: fullBuffer.length,
        timings: {
          totalTime,
          apiResponseTime,
          streamDownloadTime,
          audioDuration: Math.round(audioDuration * 1000) / 1000,
          charactersPerSecond: Math.round((textLength / (totalTime / 1000)) * 10) / 10,
          realTimeFactor: Math.round((audioDuration / (totalTime / 1000)) * 100) / 100
        }
      });

      // Send audio data
      const sendStartTime = Date.now();
      this.sendAudioToClient(fullBuffer);
      const sendTime = Date.now() - sendStartTime;
      
      console.log(`[${this.sessionId}] 📤 Audio sent to client in ${sendTime}ms`);

    } catch (error) {
      const errorTime = Date.now() - startTime;
      console.error(`[${this.sessionId}] ❌ TTS Error after ${errorTime}ms:`, error);
      this.sendToClient({ 
        type: 'tts_error', 
        error: error.message || 'Synthesis failed',
        timings: {
          totalTime: errorTime
        }
      });
    }
  }

  handleTextMessage(data) {
    try {
      const message = JSON.parse(data);
      
      if (message.type === 'synthesize' && message.text) {
        this.synthesizeText(message.text, message.options);
      } else if (message.type === 'ping') {
        this.sendToClient({ type: 'pong' });
      }
    } catch (error) {
      console.error(`[${this.sessionId}] Message parsing error:`, error);
      this.sendToClient({ type: 'tts_error', error: 'Invalid message format' });
    }
  }
}

// Express + WebSocket Server
const app = express();

// Serve tts-test.html as root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'tts-test.html'));
});

// Serve static files (CSS, JS, images, etc.)
app.use(express.static('public', { index: false }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  const sessionId = `tts_sess_${Date.now()}`;
  const connectionTime = new Date().toISOString();
  console.log(`[${sessionId}] 🔌 Client connected at ${connectionTime}`);

  const session = new TTSSession(ws, sessionId);

  // Send welcome message
  session.sendToClient({ type: 'tts_status', status: 'connected' });

  ws.on('message', (message) => {
    const messageTime = Date.now();
    console.log(`[${sessionId}] 📨 Received message at ${new Date(messageTime).toISOString()}`);
    
    if (typeof message === 'string' || Buffer.isBuffer(message)) {
      // Handle text messages (JSON commands)
      session.handleTextMessage(message.toString());
    }
  });

  ws.on('close', () => {
    const disconnectionTime = new Date().toISOString();
    console.log(`[${sessionId}] 🔌 Client disconnected at ${disconnectionTime}`);
  });

  ws.on('error', (err) => {
    console.error(`[${sessionId}] ❌ WS Error:`, err);
  });
});

server.listen(PORT, () => {
  console.log(`✅ TTS Test Server running at http://localhost:${PORT}`);
  console.log(`🗣️ Type text → get AI-generated speech from Deepgram`);
});