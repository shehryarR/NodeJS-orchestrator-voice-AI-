const WebSocket = require('ws');
const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@deepgram/sdk');
require('dotenv').config();

// Enhanced configuration with FREE TIER Deepgram models and Audio Dumping
const config = {
  port: process.env.PORT || 8080,
  audio: {
    dumpEnabled: process.env.DUMP_AUDIO === 'true',
    dumpDir: process.env.AUDIO_DUMP_DIR || './audio_dumps',
    cleanupAfterHours: parseInt(process.env.AUDIO_CLEANUP_HOURS) || 24
  },
  deepgram: {
    apiKey: process.env.DEEPGRAM_API_KEY,
    // FREE TIER MODELS ONLY (Community plan compatible)
    models: ['general', 'base'], // These work on free tier
    currentModel: process.env.DEEPGRAM_MODEL || 'general', // Start with general (best free model)
    language: 'en-US',
    encoding: 'webm',
    sample_rate: 48000,
    channels: 1
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
    baseUrl: 'generativelanguage.googleapis.com',
    endpoint: '/v1beta/models/gemini-2.0-flash:generateContent'
  }
};

// Enhanced logger
class Logger {
  static log(level, component, callSid, message, data) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level}] [${component}] [${callSid || 'GLOBAL'}] ${message}`, data ? JSON.stringify(data) : '');
  }
  
  static info(component, callSid, message, data) { this.log('INFO', component, callSid, message, data); }
  static error(component, callSid, message, error) { this.log('ERROR', component, callSid, message, error?.message || error); }
  static debug(component, callSid, message, data) { this.log('DEBUG', component, callSid, message, data); }
  static warn(component, callSid, message, data) { this.log('WARN', component, callSid, message, data); }
}

// Audio dumper utility class
class AudioDumper {
  constructor() {
    this.enabled = config.audio.dumpEnabled;
    this.dumpDir = path.resolve(config.audio.dumpDir);
    
    if (this.enabled) {
      this.ensureDirectory();
      Logger.info('AUDIO_DUMPER', null, 'Audio dumping enabled', { dumpDir: this.dumpDir });
      
      // Schedule cleanup
      this.scheduleCleanup();
    } else {
      Logger.info('AUDIO_DUMPER', null, 'Audio dumping disabled');
    }
  }

  ensureDirectory() {
    try {
      if (!fs.existsSync(this.dumpDir)) {
        fs.mkdirSync(this.dumpDir, { recursive: true });
        Logger.info('AUDIO_DUMPER', null, 'Created dump directory', { dumpDir: this.dumpDir });
      }
    } catch (error) {
      Logger.error('AUDIO_DUMPER', null, 'Failed to create dump directory', error);
      this.enabled = false;
    }
  }

  dumpAudio(audioBuffer, callSid, metadata = {}) {
    if (!this.enabled) {
      return null;
    }

    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const extension = this.getFileExtension(metadata.mimeType);
      const filename = `${callSid}_${timestamp}_${metadata.requestId || 'unknown'}${extension}`;
      const filepath = path.join(this.dumpDir, filename);
      
      fs.writeFileSync(filepath, audioBuffer);
      
      // Write metadata file
      const metadataPath = filepath + '.json';
      fs.writeFileSync(metadataPath, JSON.stringify({
        callSid,
        timestamp: new Date().toISOString(),
        bufferSize: audioBuffer.length,
        ...metadata
      }, null, 2));
      
      return filepath;
    } catch (error) {
      Logger.error('AUDIO_DUMPER', callSid, 'Failed to dump audio', error);
      return null;
    }
  }

  getFileExtension(mimeType) {
    const extensions = {
      'audio/webm': '.webm',
      'audio/ogg': '.ogg', 
      'audio/wav': '.wav',
      'audio/mp3': '.mp3',
      'audio/mpeg': '.mp3'
    };
    return extensions[mimeType] || '.bin';
  }

  scheduleCleanup() {
    // Run cleanup every hour
    setInterval(() => {
      this.cleanup();
    }, 60 * 60 * 1000);
  }

  cleanup(olderThanMs = config.audio.cleanupAfterHours * 60 * 60 * 1000) {
    if (!this.enabled) return;

    try {
      const files = fs.readdirSync(this.dumpDir);
      const now = Date.now();
      let cleaned = 0;
      
      files.forEach(file => {
        const filepath = path.join(this.dumpDir, file);
        const stats = fs.statSync(filepath);
        
        if (now - stats.mtime.getTime() > olderThanMs) {
          fs.unlinkSync(filepath);
          cleaned++;
        }
      });
      
      if (cleaned > 0) {
        Logger.info('AUDIO_DUMPER', null, `Cleaned up ${cleaned} old audio files`);
      }
    } catch (error) {
      Logger.error('AUDIO_DUMPER', null, 'Cleanup failed', error);
    }
  }
}

// FREE TIER COMPATIBLE Deepgram ASR client
class DeepgramASR {
  constructor() {
    this.apiKey = config.deepgram.apiKey;
    this.client = null;
    this.activeConnections = new Map();
    this.currentModel = config.deepgram.currentModel;
    this.modelFallbacks = config.deepgram.models;
    
    if (this.apiKey) {
      this.client = createClient(this.apiKey);
      Logger.info('DEEPGRAM', null, 'Deepgram client initialized (FREE TIER)', { 
        currentModel: this.currentModel,
        fallbacks: this.modelFallbacks,
        plan: 'Community/Free'
      });
    } else {
      Logger.error('DEEPGRAM', null, 'API key not configured - using mock ASR');
    }
  }

  // Fixed transcribeAudio method in DeepgramASR class
  async transcribeAudio(audioBuffer, callSid) {
    if (!this.client) {
      // Mock ASR fallback
      Logger.info('DEEPGRAM', callSid, 'Using mock ASR (no API key)');
      return { text: "Hello, how can I help you today?" };
    }

    // Try current model first, then fallback models
    const modelsToTry = [this.currentModel, ...this.modelFallbacks.filter(m => m !== this.currentModel)];

    for (const model of modelsToTry) {
      try {
        Logger.info('DEEPGRAM', callSid, `Attempting transcription with FREE TIER model: ${model}`, { 
          bufferSize: audioBuffer.length
        });

        const response = await this.client.listen.prerecorded.transcribeFile(
          audioBuffer,
          {
            model: model,
            language: config.deepgram.language,
            smart_format: true,
            punctuate: true,
            mimetype: 'audio/webm',
            alternatives: 1,
            interim_results: false,
            channels: 1
          }
        );

        Logger.debug('DEEPGRAM', callSid, `${model} response`, response);

        // Fixed: Access the response correctly
        const transcript = response.result?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
        
        if (!transcript || transcript.trim().length === 0) {
          Logger.info('DEEPGRAM', callSid, `No speech detected with ${model}`);
          return { text: "", confidence: 0, model: model };
        }

        // Fixed: Get confidence from correct path
        const confidence = response.result?.results?.channels?.[0]?.alternatives?.[0]?.confidence || 0;
        
        // Success! Update current model for future requests
        if (this.currentModel !== model) {
          Logger.info('DEEPGRAM', callSid, `Model ${model} worked! Switching default model`, {
            oldModel: this.currentModel,
            newModel: model
          });
          this.currentModel = model;
        }
        
        Logger.info('DEEPGRAM', callSid, 'Transcription completed successfully', { 
          model: model,
          text: transcript,
          confidence: confidence,
          // Fixed: Access words from correct path
          words: response.result?.results?.channels?.[0]?.alternatives?.[0]?.words?.length || 0,
          plan: 'FREE_TIER'
        });

        return { 
          text: transcript.trim(), 
          confidence: confidence,
          model: model,
          // Fixed: Return words from correct path
          words: response.result?.results?.channels?.[0]?.alternatives?.[0]?.words || []
        };

      } catch (error) {
        Logger.error('DEEPGRAM', callSid, `Transcription error with model ${model}`, {
          error: error.message,
          status: error.status,
          modelTried: model
        });

        // If this is a permissions error, try the next model
        if (error.message?.includes('INSUFFICIENT_PERMISSIONS') || 
            error.message?.includes('access to the requested model') ||
            error.status === 403) {
          Logger.warn('DEEPGRAM', callSid, `Model ${model} not accessible (likely requires paid plan), trying next fallback`);
          continue;
        }

        // If it's a different error, also try next model but log it
        Logger.warn('DEEPGRAM', callSid, `Non-permission error with ${model}, trying fallback`, error.message);
        continue;
      }
    }

    // If we get here, all models failed
    Logger.error('DEEPGRAM', callSid, 'All FREE TIER models failed', { 
      attemptedModels: modelsToTry,
      suggestion: 'Check your API key or consider upgrading to paid plan'
    });
    
    return { 
      text: "", 
      error: "Speech recognition failed with all available models. Please check your Deepgram API key and plan.",
      confidence: 0,
      attemptedModels: modelsToTry
    };
  }

  // Real-time streaming transcription with FREE TIER settings
  createStreamingConnection(callSid, onTranscript, onError) {
    if (!this.client) {
      Logger.error('DEEPGRAM', callSid, 'Cannot create streaming connection without API key');
      return null;
    }

    try {
      const connection = this.client.listen.live({
        model: this.currentModel, // Use the working free tier model
        language: config.deepgram.language,
        encoding: 'linear16',
        sample_rate: 16000,
        channels: 1,
        smart_format: true,
        interim_results: false,
        utterance_end_ms: 1000
        // REMOVED PAID FEATURES:
        // vad_events: true  // Requires paid plan
      });

      connection.on('open', () => {
        Logger.info('DEEPGRAM', callSid, 'Streaming connection opened (FREE TIER)', { 
          model: this.currentModel 
        });
      });

      connection.on('transcript', (data) => {
        const transcript = data.channel?.alternatives?.[0]?.transcript;
        if (transcript && transcript.trim().length > 0) {
          Logger.info('DEEPGRAM', callSid, 'Streaming transcript', { 
            text: transcript,
            model: this.currentModel 
          });
          onTranscript({
            text: transcript.trim(),
            confidence: data.channel?.alternatives?.[0]?.confidence || 0,
            is_final: data.is_final || false,
            model: this.currentModel
          });
        }
      });

      connection.on('error', (error) => {
        Logger.error('DEEPGRAM', callSid, 'Streaming error', error);
        onError(error);
      });

      connection.on('close', () => {
        Logger.info('DEEPGRAM', callSid, 'Streaming connection closed');
        this.activeConnections.delete(callSid);
      });

      this.activeConnections.set(callSid, connection);
      return connection;

    } catch (error) {
      Logger.error('DEEPGRAM', callSid, 'Failed to create streaming connection', error);
      return null;
    }
  }

  closeStreamingConnection(callSid) {
    const connection = this.activeConnections.get(callSid);
    if (connection) {
      connection.finish();
      this.activeConnections.delete(callSid);
      Logger.info('DEEPGRAM', callSid, 'Streaming connection closed');
    }
  }

  cleanup() {
    // Close all active streaming connections
    for (const [callSid, connection] of this.activeConnections) {
      try {
        connection.finish();
        Logger.info('DEEPGRAM', callSid, 'Connection closed during cleanup');
      } catch (error) {
        Logger.error('DEEPGRAM', callSid, 'Error closing connection during cleanup', error);
      }
    }
    this.activeConnections.clear();
  }
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
    
    Logger.info('GEMINI', null, 'Gemini client initialized', { 
      configured: !!this.apiKey 
    });
  }

  async generateContent(prompt, callSid) {
    if (!this.apiKey) {
      Logger.info('GEMINI', callSid, 'Using echo mode (no API key)');
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
              Logger.error('GEMINI', callSid, 'API error', { statusCode: res.statusCode, data });
              resolve(`Processing error (${res.statusCode}). Please try again.`);
              return;
            }
            const response = JSON.parse(data);
            const text = response.candidates?.[0]?.content?.parts?.[0]?.text;
            resolve(text || "I couldn't generate a response.");
          } catch (error) {
            Logger.error('GEMINI', callSid, 'Response parse error', error);
            resolve("I encountered an error processing your request.");
          }
        });
      });

      req.on('error', (error) => {
        Logger.error('GEMINI', callSid, 'Request error', error);
        resolve("Connection error. Please try again.");
      });
      
      req.write(postData);
      req.end();
    });
  }
}

// Enhanced gateway class with FREE TIER Deepgram integration
class TwilioWebSocketGateway {
  constructor() {
    this.eventBus = new EventEmitter();
    this.eventBus.setMaxListeners(1000);
    this.sessions = new Map();
    this.processing = new Set();
    this.gemini = new GeminiClient();
    this.deepgram = new DeepgramASR();
    this.audioDumper = new AudioDumper();
    
    this.handleConnection = this.handleConnection.bind(this);
    this.processAudio = this.processAudio.bind(this);
    this.processLLM = this.processLLM.bind(this);
    this.processTTS = this.processTTS.bind(this);
    
    this.setupEventHandlers();
  }

  setupEventHandlers() {
    this.eventBus.on('audio', this.processAudio);
    this.eventBus.on('llm', this.processLLM);
    this.eventBus.on('tts', this.processTTS);
  }

  async start() {
    Logger.info('GATEWAY', null, 'Starting server with FREE TIER configuration', { 
      port: config.port, 
      deepgramConfigured: !!config.deepgram.apiKey,
      deepgramModel: config.deepgram.currentModel,
      deepgramPlan: 'Community/Free',
      geminiConfigured: !!config.gemini.apiKey,
      audioDumpEnabled: config.audio.dumpEnabled
    });
    
    const app = express();
    app.use(express.static('public'));
    
    // Health check endpoint
    app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        deepgram: {
          configured: !!config.deepgram.apiKey,
          model: config.deepgram.currentModel,
          plan: 'Community/Free',
          availableModels: config.deepgram.models
        },
        gemini: !!config.gemini.apiKey,
        activeSessions: this.sessions.size,
        audioDump: config.audio.dumpEnabled
      });
    });
    
    // Debug endpoint for audio dumps
    if (config.audio.dumpEnabled) {
      app.get('/debug/audio-dumps', (req, res) => {
        try {
          const files = fs.readdirSync(config.audio.dumpDir)
            .filter(file => !file.endsWith('.json'))
            .map(file => {
              const filepath = path.join(config.audio.dumpDir, file);
              const stats = fs.statSync(filepath);
              return {
                filename: file,
                size: stats.size,
                created: stats.mtime,
                downloadUrl: `/debug/download-audio/${file}`
              };
            })
            .sort((a, b) => new Date(b.created) - new Date(a.created));
          
          res.json({ 
            files,
            message: 'Audio files captured for debugging transcription issues'
          });
        } catch (error) {
          res.status(500).json({ error: error.message });
        }
      });

      app.get('/debug/download-audio/:filename', (req, res) => {
        const filename = req.params.filename;
        const filepath = path.join(config.audio.dumpDir, filename);
        
        if (fs.existsSync(filepath)) {
          res.download(filepath);
        } else {
          res.status(404).json({ error: 'File not found' });
        }
      });
    }
    
    const server = app.listen(config.port, () => {
      Logger.info('GATEWAY', null, `Server running on port ${config.port} - Ready for FREE TIER Deepgram transcription`);
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
    this.sessions.set(callSid, { 
      ws, 
      createdAt: Date.now(),
      requestCount: 0,
      lastActivity: Date.now()
    });
    
    Logger.info('WEBSOCKET', callSid, 'Connected', { total: this.sessions.size });
    
    // Event handlers
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
      } catch (error) {
        Logger.error('WEBSOCKET', callSid, 'Parse error', error);
      }
    });
    
    ws.on('close', () => {
      Logger.info('WEBSOCKET', callSid, 'Disconnected');
      this.sessions.delete(callSid);
      this.processing.delete(callSid);
      this.deepgram.closeStreamingConnection(callSid);
    });
    
    ws.on('error', (error) => {
      Logger.error('WEBSOCKET', callSid, 'Error', error);
      this.sessions.delete(callSid);
      this.processing.delete(callSid);
      this.deepgram.closeStreamingConnection(callSid);
    });
  }

  // Enhanced audio processing with FREE TIER Deepgram ASR and audio dumping
  async processAudio({ callSid, audio, requestId }) {
    Logger.info('ASR', callSid, 'Processing audio with Deepgram FREE TIER');
    
    try {
      // Convert base64 audio to buffer
      const audioBuffer = Buffer.from(audio, 'base64');
      Logger.debug('ASR', callSid, 'Audio buffer created', { 
        size: audioBuffer.length,
        firstBytes: Array.from(audioBuffer.slice(0, 20)).map(b => b.toString(16).padStart(2, '0')).join(' ')
      });
      
      // Check if buffer has actual audio data
      if (audioBuffer.length < 1000) {
        Logger.error('ASR', callSid, 'Audio buffer too small', { size: audioBuffer.length });
        this.processing.delete(callSid);
        return;
      }
      
      // Log buffer info for debugging
      const isWebM = audioBuffer.slice(0, 4).toString('hex') === '1a45dfa3';
      const isOgg = audioBuffer.slice(0, 4).toString() === 'OggS';
      const isWav = audioBuffer.slice(0, 4).toString() === 'RIFF';
      
      Logger.info('ASR', callSid, 'Audio format detection', {
        isWebM, isOgg, isWav,
        header: audioBuffer.slice(0, 20).toString('hex')
      });
      
      // DUMP AUDIO TO FILE BEFORE PROCESSING (for debugging)
      const dumpPath = this.audioDumper.dumpAudio(audioBuffer, callSid, {
        mimeType: isWebM ? 'audio/webm' : isOgg ? 'audio/ogg' : isWav ? 'audio/wav' : 'unknown',
        requestId: requestId,
        timestamp: new Date().toISOString(),
        plan: 'FREE_TIER'
      });
      
      if (dumpPath) {
        Logger.info('ASR', callSid, 'Audio successfully dumped for inspection', { 
          dumpPath,
          size: audioBuffer.length,
          canInspect: `Audio saved for debugging: ${dumpPath}`
        });
      }
      
      // Transcribe with FREE TIER Deepgram
      const transcription = await this.deepgram.transcribeAudio(audioBuffer, callSid);
      
      if (transcription.error) {
        // Handle transcription errors gracefully
        Logger.error('ASR', callSid, 'FREE TIER transcription failed', transcription.error);
        this.processing.delete(callSid);
        
        // Send error response back to client
        const session = this.sessions.get(callSid);
        if (session && session.ws.readyState === WebSocket.OPEN) {
          session.ws.send(JSON.stringify({
            type: 'error',
            error: `Transcription failed: ${transcription.error}`,
            requestId,
            plan: 'FREE_TIER',
            suggestion: 'Make sure you have a valid Deepgram API key',
            debug: {
              audioSize: audioBuffer.length,
              dumpPath: dumpPath,
              attemptedModels: transcription.attemptedModels
            }
          }));
        }
        return;
      }
      
      if (!transcription.text || transcription.text.trim().length === 0) {
        Logger.info('ASR', callSid, 'No speech detected with FREE TIER model');
        this.processing.delete(callSid);
        
        // Send "no speech" response
        const session = this.sessions.get(callSid);
        if (session && session.ws.readyState === WebSocket.OPEN) {
          session.ws.send(JSON.stringify({
            type: 'audio',
            audio: {
              text: "I didn't detect any speech in that audio. Please try speaking more clearly.",
              timestamp: Date.now(),
              requestId,
              confidence: 0,
              metadata: {
                audioSize: audioBuffer.length,
                detectedFormat: isWebM ? 'WebM' : isOgg ? 'OGG' : isWav ? 'WAV' : 'Unknown',
                dumpPath: dumpPath,
                model: transcription.model,
                plan: 'FREE_TIER'
              }
            }
          }));
        }
        return;
      }
      
      Logger.info('ASR', callSid, 'FREE TIER transcription successful!', { 
        text: transcription.text,
        confidence: transcription.confidence,
        model: transcription.model,
        dumpPath: dumpPath
      });
      
      // Send to LLM for processing
      this.eventBus.emit('llm', { 
        callSid, 
        text: transcription.text, 
        requestId,
        confidence: transcription.confidence,
        model: transcription.model
      });
      
    } catch (error) {
      Logger.error('ASR', callSid, 'Audio processing error', error);
      this.processing.delete(callSid);
      
      // Send generic error response
      const session = this.sessions.get(callSid);
      if (session && session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify({
          type: 'error',
          error: 'Audio processing failed. Please try again.',
          requestId,
          plan: 'FREE_TIER'
        }));
      }
    }
  }

  // Enhanced LLM processing
  async processLLM({ callSid, text, requestId, confidence, model }) {
    Logger.info('LLM', callSid, 'Processing text', { 
      text, 
      confidence,
      transcriptionModel: model
    });
    
    try {
      // Add confidence context to prompt if available
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
      Logger.error('LLM', callSid, 'Error', error);
      this.eventBus.emit('tts', { 
        callSid, 
        text: 'I apologize, but I encountered an error processing your request. Please try again.', 
        requestId 
      });
    }
  }

  // Enhanced TTS processing and response
  async processTTS({ callSid, text, requestId, originalText, confidence, model }) {
    const session = this.sessions.get(callSid);
    if (!session || session.ws.readyState !== WebSocket.OPEN) {
      this.processing.delete(callSid);
      return;
    }

    Logger.info('TTS', callSid, 'Sending response', { 
      responseLength: text.length,
      originalText: originalText 
    });
    
    // Enhanced response format with metadata
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
          plan: 'FREE_TIER',
          processingTime: Date.now() - parseInt(requestId.split('-')[1])
        }
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
    
    // Clean up Deepgram connections
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

// Create and start
const gateway = new TwilioWebSocketGateway();

// Graceful shutdown
const shutdown = () => {
  Logger.info('GATEWAY', null, 'Shutdown signal received');
  gateway.stop().then(() => process.exit(0));
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  Logger.error('GATEWAY', null, 'Uncaught exception', error);
  shutdown();
});

process.on('unhandledRejection', (reason, promise) => {
  Logger.error('GATEWAY', null, 'Unhandled rejection', { reason, promise });
});

// Start server
gateway.start().catch((error) => {
  Logger.error('GATEWAY', null, 'Failed to start server', error);
  process.exit(1);
});