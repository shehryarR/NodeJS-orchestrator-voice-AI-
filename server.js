const WebSocket = require('ws');
const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const express = require('express');
const https = require('https');
const { createClient } = require('@deepgram/sdk');
require('dotenv').config();

const config = {
  port: process.env.PORT || 8080,
  deepgram: {
    apiKey: process.env.DEEPGRAM_API_KEY,
    models: ['general', 'base'],
    currentModel: process.env.DEEPGRAM_MODEL || 'general',
    language: 'en-US'
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
    baseUrl: 'generativelanguage.googleapis.com',
    endpoint: '/v1beta/models/gemini-2.0-flash:generateContent'
  }
};

class DeepgramASR {
  constructor() {
    this.apiKey = config.deepgram.apiKey;
    this.client = this.apiKey ? createClient(this.apiKey) : null;
    this.activeConnections = new Map();
    this.currentModel = config.deepgram.currentModel;
    this.modelFallbacks = config.deepgram.models;
  }

  async transcribeAudio(audioBuffer, callSid) {
    if (!this.client) {
      return { text: "Hello, how can I help you today?" };
    }

    const modelsToTry = [this.currentModel, ...this.modelFallbacks.filter(m => m !== this.currentModel)];

    for (const model of modelsToTry) {
      try {
        const response = await this.client.listen.prerecorded.transcribeFile(audioBuffer, {
          model: model,
          language: config.deepgram.language,
          smart_format: true,
          punctuate: true,
          mimetype: 'audio/webm',
          alternatives: 1,
          channels: 1
        });

        const transcript = response.result?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
        
        if (!transcript?.trim()) {
          return { text: "", confidence: 0, model: model };
        }

        const confidence = response.result?.results?.channels?.[0]?.alternatives?.[0]?.confidence || 0;
        
        if (this.currentModel !== model) {
          this.currentModel = model;
        }
        
        return { 
          text: transcript.trim(), 
          confidence: confidence,
          model: model,
          words: response.result?.results?.channels?.[0]?.alternatives?.[0]?.words || []
        };
      } catch (error) {
        if (error.message?.includes('INSUFFICIENT_PERMISSIONS') || error.status === 403) {
          continue;
        }
        continue;
      }
    }
    
    return { 
      text: "", 
      error: "Speech recognition failed",
      confidence: 0,
      attemptedModels: modelsToTry
    };
  }

  createStreamingConnection(callSid, onTranscript, onError) {
    if (!this.client) return null;

    try {
      const connection = this.client.listen.live({
        model: this.currentModel,
        language: config.deepgram.language,
        encoding: 'linear16',
        sample_rate: 16000,
        channels: 1,
        smart_format: true,
        interim_results: false,
        utterance_end_ms: 1000
      });

      connection.on('transcript', (data) => {
        const transcript = data.channel?.alternatives?.[0]?.transcript;
        if (transcript?.trim()) {
          onTranscript({
            text: transcript.trim(),
            confidence: data.channel?.alternatives?.[0]?.confidence || 0,
            is_final: data.is_final || false,
            model: this.currentModel
          });
        }
      });

      connection.on('error', onError);
      connection.on('close', () => this.activeConnections.delete(callSid));

      this.activeConnections.set(callSid, connection);
      return connection;
    } catch (error) {
      return null;
    }
  }

  closeStreamingConnection(callSid) {
    const connection = this.activeConnections.get(callSid);
    if (connection) {
      connection.finish();
      this.activeConnections.delete(callSid);
    }
  }

  cleanup() {
    for (const [callSid, connection] of this.activeConnections) {
      try {
        connection.finish();
      } catch (error) {}
    }
    this.activeConnections.clear();
  }
}

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

class TwilioWebSocketGateway {
  constructor() {
    this.eventBus = new EventEmitter();
    this.eventBus.setMaxListeners(1000);
    this.sessions = new Map();
    this.processing = new Set();
    this.gemini = new GeminiClient();
    this.deepgram = new DeepgramASR();
    
    this.setupEventHandlers();
  }

  setupEventHandlers() {
    this.eventBus.on('audio', this.processAudio.bind(this));
    this.eventBus.on('llm', this.processLLM.bind(this));
    this.eventBus.on('tts', this.processTTS.bind(this));
  }

  async start() {
    const app = express();
    app.use(express.static('public'));
    
    app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        activeSessions: this.sessions.size
      });
    });
    
    const server = app.listen(config.port);
    this.wss = new WebSocket.Server({ server });
    this.wss.on('connection', this.handleConnection.bind(this));
    
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
    
    this.sessions.set(callSid, { 
      ws, 
      createdAt: Date.now(),
      requestCount: 0,
      lastActivity: Date.now()
    });
    
    ws.on('pong', () => ws.isAlive = true);
    
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        if (message.type === 'audio' && !this.processing.has(callSid)) {
          const session = this.sessions.get(callSid);
          if (session) {
            session.lastActivity = Date.now();
            session.requestCount++;
          }
          
          const requestId = `${callSid}-${Date.now()}`;
          this.processing.add(callSid);
          this.eventBus.emit('audio', { callSid, audio: message.audio, requestId });
        }
      } catch (error) {}
    });
    
    ws.on('close', () => {
      this.sessions.delete(callSid);
      this.processing.delete(callSid);
      this.deepgram.closeStreamingConnection(callSid);
    });
    
    ws.on('error', () => {
      this.sessions.delete(callSid);
      this.processing.delete(callSid);
      this.deepgram.closeStreamingConnection(callSid);
    });
  }

  async processAudio({ callSid, audio, requestId }) {
    try {
      const audioBuffer = Buffer.from(audio, 'base64');
      
      if (audioBuffer.length < 1000) {
        this.processing.delete(callSid);
        return;
      }
      
      const transcription = await this.deepgram.transcribeAudio(audioBuffer, callSid);
      
      if (transcription.error) {
        this.processing.delete(callSid);
        const session = this.sessions.get(callSid);
        if (session && session.ws.readyState === WebSocket.OPEN) {
          session.ws.send(JSON.stringify({
            type: 'error',
            error: `Transcription failed: ${transcription.error}`,
            requestId
          }));
        }
        return;
      }
      
      if (!transcription.text?.trim()) {
        this.processing.delete(callSid);
        const session = this.sessions.get(callSid);
        if (session && session.ws.readyState === WebSocket.OPEN) {
          session.ws.send(JSON.stringify({
            type: 'audio',
            audio: {
              text: "I didn't detect any speech in that audio. Please try speaking more clearly.",
              timestamp: Date.now(),
              requestId,
              confidence: 0
            }
          }));
        }
        return;
      }
      
      this.eventBus.emit('llm', { 
        callSid, 
        text: transcription.text, 
        requestId,
        confidence: transcription.confidence,
        model: transcription.model
      });
      
    } catch (error) {
      this.processing.delete(callSid);
      const session = this.sessions.get(callSid);
      if (session && session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify({
          type: 'error',
          error: 'Audio processing failed. Please try again.',
          requestId
        }));
      }
    }
  }

  async processLLM({ callSid, text, requestId, confidence, model }) {
    try {
      let enhancedText = text;
      if (confidence !== undefined && confidence < 0.8) {
        enhancedText = `[Note: Speech recognition confidence was ${Math.round(confidence * 100)}%] ${text}`;
      }
      
      const response = await this.gemini.generateContent(enhancedText, callSid);
      this.eventBus.emit('tts', { 
        callSid, 
        text: response, 
        requestId,
        originalText: text,
        confidence,
        model
      });
    } catch (error) {
      this.eventBus.emit('tts', { 
        callSid, 
        text: 'I apologize, but I encountered an error processing your request. Please try again.', 
        requestId 
      });
    }
  }

  async processTTS({ callSid, text, requestId, originalText, confidence, model }) {
    const session = this.sessions.get(callSid);
    if (!session || session.ws.readyState !== WebSocket.OPEN) {
      this.processing.delete(callSid);
      return;
    }

    const response = {
      type: 'audio',
      audio: {
        text: text,
        timestamp: Date.now(),
        requestId,
        metadata: {
          originalTranscript: originalText,
          transcriptionConfidence: confidence,
          transcriptionModel: model
        }
      }
    };
    
    session.ws.send(JSON.stringify(response));
    this.processing.delete(callSid);
  }

  async stop() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    this.deepgram.cleanup();
    
    if (this.wss) {
      this.wss.clients.forEach(client => client.close());
      await new Promise(resolve => this.wss.close(resolve));
    }
    
    this.sessions.clear();
    this.processing.clear();
    this.eventBus.removeAllListeners();
  }
}

const gateway = new TwilioWebSocketGateway();

const shutdown = () => {
  gateway.stop().then(() => process.exit(0));
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', shutdown);
process.on('unhandledRejection', shutdown);

gateway.start().catch(() => process.exit(1));