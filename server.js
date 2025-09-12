const WebSocket = require('ws');
const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const express = require('express');
const https = require('https');
require('dotenv').config();

// Streamlined configuration
const config = {
  port: process.env.PORT || 8080,
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
    baseUrl: 'generativelanguage.googleapis.com',
    endpoint: '/v1beta/models/gemini-2.0-flash:generateContent'
  }
};

// Simplified logger
class Logger {
  static log(level, component, callSid, message, data) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level}] [${component}] [${callSid || 'GLOBAL'}] ${message}`, data ? JSON.stringify(data) : '');
  }
  
  static info(component, callSid, message, data) { this.log('INFO', component, callSid, message, data); }
  static error(component, callSid, message, error) { this.log('ERROR', component, callSid, message, error?.message || error); }
}

// Optimized Gemini client
class GeminiClient {
  constructor() {
    this.apiKey = config.gemini.apiKey;
    this.options = {
      hostname: config.gemini.baseUrl,
      path: config.gemini.endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-goog-api-key': this.apiKey
      }
    };
  }

  async generateContent(prompt, callSid) {
    if (!this.apiKey) {
      return `Echo: "${prompt}"`;
    }

    return new Promise((resolve) => {
      const postData = JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      });

      const req = https.request({
        ...this.options,
        headers: {
          ...this.options.headers,
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              resolve(`Processing error (${res.statusCode}). Please try again.`);
              return;
            }
            const response = JSON.parse(data);
            const text = response.candidates?.[0]?.content?.parts?.[0]?.text;
            resolve(text || "I couldn't generate a response.");
          } catch (error) {
            resolve("I encountered an error processing your request.");
          }
        });
      });

      req.on('error', () => resolve("Connection error. Please try again."));
      req.write(postData);
      req.end();
    });
  }
}

// Main gateway class
class TwilioWebSocketGateway {
  constructor() {
    this.eventBus = new EventEmitter();
    this.eventBus.setMaxListeners(1000); // Increase for multiple sessions
    this.sessions = new Map();
    this.processing = new Set(); // Track active processing
    this.gemini = new GeminiClient();
    
    // Bind methods for better performance
    this.handleConnection = this.handleConnection.bind(this);
    this.processAudio = this.processAudio.bind(this);
    this.processLLM = this.processLLM.bind(this);
    this.processTTS = this.processTTS.bind(this);
    
    // Setup event handlers once
    this.setupEventHandlers();
  }

  setupEventHandlers() {
    this.eventBus.on('audio', this.processAudio);
    this.eventBus.on('llm', this.processLLM);
    this.eventBus.on('tts', this.processTTS);
  }

  async start() {
    Logger.info('GATEWAY', null, 'Starting server', { 
      port: config.port, 
      geminiConfigured: !!config.gemini.apiKey 
    });
    
    const app = express();
    app.use(express.static('public'));
    
    const server = app.listen(config.port, () => {
      Logger.info('GATEWAY', null, `Server running on port ${config.port}`);
    });
    
    this.wss = new WebSocket.Server({ server });
    this.wss.on('connection', this.handleConnection);
    
    // Optimized heartbeat
    this.heartbeatInterval = setInterval(() => {
      this.wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);
  }

  handleConnection(ws, req) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const callSid = url.searchParams.get('callSid') || uuidv4();
    
    ws.callSid = callSid;
    ws.isAlive = true;
    
    // Create session
    this.sessions.set(callSid, { ws, createdAt: Date.now() });
    Logger.info('WEBSOCKET', callSid, 'Connected', { total: this.sessions.size });
    
    // Event handlers
    ws.on('pong', () => ws.isAlive = true);
    
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        if (message.type === 'audio' && !this.processing.has(callSid)) {
          const requestId = `${callSid}-${Date.now()}`;
          this.processing.add(callSid);
          this.eventBus.emit('audio', { callSid, audio: message.audio, requestId });
        }
      } catch (error) {
        Logger.error('WEBSOCKET', callSid, 'Parse error', error);
      }
    });
    
    ws.on('close', () => {
      Logger.info('WEBSOCKET', callSid, 'Disconnected');
      this.sessions.delete(callSid);
      this.processing.delete(callSid);
    });
    
    ws.on('error', (error) => {
      Logger.error('WEBSOCKET', callSid, 'Error', error);
      this.sessions.delete(callSid);
      this.processing.delete(callSid);
    });
  }

  // Optimized audio processing (mock ASR)
  async processAudio({ callSid, audio, requestId }) {
    Logger.info('ASR', callSid, 'Processing audio');
    
    // Simulate ASR with immediate response
    setTimeout(() => {
      const text = "Hello, how can I help you today?";
      this.eventBus.emit('llm', { callSid, text, requestId });
    }, 100); // Reduced delay
  }

  // LLM processing
  async processLLM({ callSid, text, requestId }) {
    Logger.info('LLM', callSid, 'Processing text', { text });
    
    try {
      const response = await this.gemini.generateContent(text, callSid);
      this.eventBus.emit('tts', { callSid, text: response, requestId });
    } catch (error) {
      Logger.error('LLM', callSid, 'Error', error);
      this.eventBus.emit('tts', { 
        callSid, 
        text: 'I apologize, but I encountered an error. Please try again.', 
        requestId 
      });
    }
  }

  // TTS processing and response
  async processTTS({ callSid, text, requestId }) {
    const session = this.sessions.get(callSid);
    if (!session || session.ws.readyState !== WebSocket.OPEN) {
      this.processing.delete(callSid);
      return;
    }

    Logger.info('TTS', callSid, 'Sending response');
    
    // Match the expected client format
    const response = {
      type: 'audio',
      audio: {
        text: text,
        timestamp: Date.now(),
        requestId
      }
    };
    
    session.ws.send(JSON.stringify(response));
    this.processing.delete(callSid);
  }

  async stop() {
    Logger.info('GATEWAY', null, 'Shutting down');
    
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    if (this.wss) {
      this.wss.clients.forEach(client => client.close());
      await new Promise(resolve => this.wss.close(resolve));
    }
    
    this.sessions.clear();
    this.processing.clear();
    this.eventBus.removeAllListeners();
  }
}

// Create and start
const gateway = new TwilioWebSocketGateway();

// Graceful shutdown
const shutdown = () => {
  Logger.info('GATEWAY', null, 'Shutdown signal received');
  gateway.stop().then(() => process.exit(0));
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start server
gateway.start().catch(console.error);