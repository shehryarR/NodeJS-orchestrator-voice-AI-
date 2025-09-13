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
  },
  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY,
    baseUrl: 'api.elevenlabs.io',
    voiceId: 'pNInz6obpgDQGcFmaJgB', // Default voice (Adam), you can change this
    model: 'eleven_monolingual_v1'
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
    const startTime = Date.now();
    
    if (!this.client) {
      console.log(`[${callSid}] ASR: No API key, using fallback (0ms)`);
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
          const duration = Date.now() - startTime;
          console.log(`[${callSid}] ASR: Empty transcript (${duration}ms)`);
          return { text: "", confidence: 0, model: model };
        }

        const confidence = response.result?.results?.channels?.[0]?.alternatives?.[0]?.confidence || 0;
        
        if (this.currentModel !== model) {
          this.currentModel = model;
        }
        
        const duration = Date.now() - startTime;
        console.log(`[${callSid}] ASR: Success "${transcript.slice(0, 50)}..." (${duration}ms, conf: ${Math.round(confidence * 100)}%)`);
        
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
    
    const duration = Date.now() - startTime;
    console.log(`[${callSid}] ASR: Failed all models (${duration}ms)`);
    
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
    const startTime = Date.now();
    
    if (!this.apiKey) {
      console.log(`[${callSid}] LLM: No API key, using echo (0ms)`);
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
          const duration = Date.now() - startTime;
          try {
            if (res.statusCode !== 200) {
              console.log(`[${callSid}] LLM: Error ${res.statusCode} (${duration}ms)`);
              resolve(`Processing error (${res.statusCode}). Please try again.`);
              return;
            }
            const response = JSON.parse(data);
            const text = response.candidates?.[0]?.content?.parts?.[0]?.text;
            const responseText = text || "I couldn't generate a response.";
            console.log(`[${callSid}] LLM: Success "${responseText.slice(0, 50)}..." (${duration}ms)`);
            resolve(responseText);
          } catch (error) {
            console.log(`[${callSid}] LLM: Parse error (${duration}ms)`);
            resolve("I encountered an error processing your request.");
          }
        });
      });

      req.on('error', () => {
        const duration = Date.now() - startTime;
        console.log(`[${callSid}] LLM: Connection error (${duration}ms)`);
        resolve("Connection error. Please try again.");
      });
      req.write(postData);
      req.end();
    });
  }
}

class EvenLabsTTS {
  constructor() {
    this.apiKey = config.elevenlabs.apiKey;
    this.baseUrl = config.elevenlabs.baseUrl;
    this.voiceId = config.elevenlabs.voiceId;
    this.model = config.elevenlabs.model;
  }

  async generateSpeech(text, callSid) {
    const startTime = Date.now();
    
    if (!this.apiKey) {
      console.log(`[${callSid}] TTS: No API key, text only (0ms)`);
      return { text, audioBuffer: null };
    }

    // Clean the text for better TTS
    const cleanText = text.replace(/[*_`#]/g, '').trim();
    if (!cleanText) {
      const duration = Date.now() - startTime;
      console.log(`[${callSid}] TTS: Empty text (${duration}ms)`);
      return { text, audioBuffer: null };
    }

    return new Promise((resolve) => {
      const postData = JSON.stringify({
        text: cleanText,
        model_id: this.model,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.5,
          style: 0.0,
          use_speaker_boost: true
        }
      });

      const options = {
        hostname: this.baseUrl,
        path: `/v1/text-to-speech/${this.voiceId}`,
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': this.apiKey,
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = https.request(options, (res) => {
        const chunks = [];
        
        res.on('data', (chunk) => {
          chunks.push(chunk);
        });

        res.on('end', () => {
          const duration = Date.now() - startTime;
          if (res.statusCode === 200) {
            const audioBuffer = Buffer.concat(chunks);
            console.log(`[${callSid}] TTS: Success ${audioBuffer.length} bytes (${duration}ms)`);
            resolve({
              text,
              audioBuffer,
              format: 'mp3',
              voiceId: this.voiceId
            });
          } else {
            console.log(`[${callSid}] TTS: Error ${res.statusCode} (${duration}ms)`);
            let errorData = '';
            chunks.forEach(chunk => errorData += chunk.toString());
            console.error('TTS Error details:', errorData);
            resolve({ text, audioBuffer: null });
          }
        });
      });

      req.on('error', (error) => {
        const duration = Date.now() - startTime;
        console.log(`[${callSid}] TTS: Request error (${duration}ms)`, error.message);
        resolve({ text, audioBuffer: null });
      });

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
    this.tts = new EvenLabsTTS();
    
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

    console.log(`Server running on port ${config.port}`);
    console.log(`EvenLabs TTS: ${config.elevenlabs.apiKey ? 'Enabled' : 'Disabled'}`);
    console.log(`Deepgram ASR: ${config.deepgram.apiKey ? 'Enabled' : 'Disabled'}`);
    console.log(`Gemini LLM: ${config.gemini.apiKey ? 'Enabled' : 'Disabled'}`);
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
    
    console.log(`[${callSid}] New WebSocket connection`);
    
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
          console.log(`[${callSid}] Starting audio processing (${Buffer.from(message.audio, 'base64').length} bytes)`);
          this.eventBus.emit('audio', { callSid, audio: message.audio, requestId });
        }
      } catch (error) {
        console.error(`[${callSid}] Message parsing error:`, error);
      }
    });
    
    ws.on('close', () => {
      console.log(`[${callSid}] WebSocket closed`);
      this.sessions.delete(callSid);
      this.processing.delete(callSid);
      this.deepgram.closeStreamingConnection(callSid);
    });
    
    ws.on('error', (error) => {
      console.error(`[${callSid}] WebSocket error:`, error);
      this.sessions.delete(callSid);
      this.processing.delete(callSid);
      this.deepgram.closeStreamingConnection(callSid);
    });
  }

  async processAudio({ callSid, audio, requestId }) {
    const pipelineStart = Date.now();
    
    try {
      const audioBuffer = Buffer.from(audio, 'base64');
      
      if (audioBuffer.length < 1000) {
        console.log(`[${callSid}] Audio too short: ${audioBuffer.length} bytes`);
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
        model: transcription.model,
        pipelineStart
      });
      
    } catch (error) {
      console.error(`[${callSid}] Audio processing error:`, error);
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

  async processLLM({ callSid, text, requestId, confidence, model, pipelineStart }) {
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
        model,
        pipelineStart
      });
    } catch (error) {
      console.error(`[${callSid}] LLM processing error:`, error);
      this.eventBus.emit('tts', { 
        callSid, 
        text: 'I apologize, but I encountered an error processing your request. Please try again.', 
        requestId,
        pipelineStart
      });
    }
  }

  async processTTS({ callSid, text, requestId, originalText, confidence, model, pipelineStart }) {
    const session = this.sessions.get(callSid);
    if (!session || session.ws.readyState !== WebSocket.OPEN) {
      this.processing.delete(callSid);
      return;
    }

    try {
      // Generate TTS audio
      const ttsResult = await this.tts.generateSpeech(text, callSid);
      
      const totalDuration = Date.now() - (pipelineStart || Date.now());
      console.log(`[${callSid}] Pipeline complete: ${totalDuration}ms total`);
      
      const response = {
        type: 'audio',
        audio: {
          text: text,
          timestamp: Date.now(),
          requestId,
          metadata: {
            originalTranscript: originalText,
            transcriptionConfidence: confidence,
            transcriptionModel: model,
            ttsGenerated: !!ttsResult.audioBuffer,
            voiceId: ttsResult.voiceId,
            audioFormat: ttsResult.format,
            totalProcessingTime: totalDuration
          }
        }
      };

      // Add audio data if TTS was successful
      if (ttsResult.audioBuffer) {
        response.audio.audioData = ttsResult.audioBuffer.toString('base64');
        response.audio.audioFormat = ttsResult.format || 'mp3';
      }
      
      session.ws.send(JSON.stringify(response));
      this.processing.delete(callSid);
      
    } catch (error) {
      console.error(`[${callSid}] TTS processing error:`, error);
      
      // Send fallback response without audio
      const totalDuration = Date.now() - (pipelineStart || Date.now());
      const fallbackResponse = {
        type: 'audio',
        audio: {
          text: text,
          timestamp: Date.now(),
          requestId,
          metadata: {
            originalTranscript: originalText,
            transcriptionConfidence: confidence,
            transcriptionModel: model,
            ttsGenerated: false,
            error: 'TTS generation failed',
            totalProcessingTime: totalDuration
          }
        }
      };
      
      session.ws.send(JSON.stringify(fallbackResponse));
      this.processing.delete(callSid);
    }
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
  console.log('Shutting down server...');
  gateway.stop().then(() => process.exit(0));
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  shutdown();
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
  shutdown();
});

gateway.start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});