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
    models: ['nova-2', 'general', 'base'],
    currentModel: process.env.DEEPGRAM_MODEL || 'nova-2',
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
    voiceId: 'pNInz6obpgDQGcFmaJgB',
    model: 'eleven_monolingual_v1'
  }
};

class DeepgramStreamingASR {
  constructor() {
    this.apiKey = config.deepgram.apiKey;
    this.client = this.apiKey ? createClient(this.apiKey) : null;
    this.activeConnections = new Map();
    this.currentModel = config.deepgram.currentModel;
  }

  createStreamingConnection(callSid, onTranscript, onError) {
    if (!this.client) {
      console.log(`[${callSid}] ASR: No API key, using mock connection`);
      return null;
    }

    try {
      const connection = this.client.listen.live({
        model: this.currentModel,
        language: config.deepgram.language,
        encoding: 'linear16',
        sample_rate: 16000,
        channels: 1,
        smart_format: true,
        interim_results: true,
        utterance_end_ms: 2000,
        vad_events: true,
        endpointing: 300
      });

      connection.on('open', () => {
        console.log(`[${callSid}] Deepgram connection opened`);
      });

      connection.on('transcript', (data) => {
        if (data.channel?.alternatives?.[0]?.transcript) {
          const transcript = data.channel.alternatives[0].transcript.trim();
          if (transcript) {
            onTranscript({
              text: transcript,
              confidence: data.channel.alternatives[0].confidence || 0,
              is_final: data.is_final || false,
              speech_final: data.speech_final || false,
              model: this.currentModel
            });
          }
        }
      });

      connection.on('utterance_end', (data) => {
        console.log(`[${callSid}] Utterance ended`);
        onTranscript({
          text: '',
          is_final: true,
          speech_final: true,
          utterance_end: true,
          confidence: 1.0
        });
      });

      connection.on('speech_started', () => {
        console.log(`[${callSid}] Speech started detected`);
        onTranscript({
          speech_started: true,
          is_final: false
        });
      });

      connection.on('error', (error) => {
        console.error(`[${callSid}] Deepgram error:`, error);
        onError(error);
      });

      connection.on('close', () => {
        console.log(`[${callSid}] Deepgram connection closed`);
        this.activeConnections.delete(callSid);
      });

      this.activeConnections.set(callSid, connection);
      return connection;
    } catch (error) {
      console.error(`[${callSid}] Failed to create Deepgram connection:`, error);
      return null;
    }
  }

  sendAudio(callSid, audioBuffer) {
    const connection = this.activeConnections.get(callSid);
    if (connection && connection.getReadyState() === 1) {
      connection.send(audioBuffer);
      return true;
    }
    return false;
  }

  closeStreamingConnection(callSid) {
    const connection = this.activeConnections.get(callSid);
    if (connection) {
      try {
        connection.finish();
      } catch (error) {
        console.error(`[${callSid}] Error closing connection:`, error);
      }
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
    
    this.systemPrompt = `You are an AI assistant in a live voice conversation. Keep responses:
- VERY SHORT (1-2 sentences max)
- CONVERSATIONAL and natural for speech
- CLEAR and easy to understand when spoken
- NO technical jargon or complex explanations
- RESPOND as if talking to someone face-to-face
- BE HELPFUL but extremely brief
- NO markdown, lists, or written-style formatting
- SOUND natural when converted to speech

This is real-time conversation - be concise and conversational.`;
  }

  async generateContent(prompt, callSid) {
    const startTime = Date.now();
    
    if (!this.apiKey) {
      console.log(`[${callSid}] LLM: No API key, using echo (0ms)`);
      return `I hear you saying: "${prompt}"`;
    }

    return new Promise((resolve) => {
      const postData = JSON.stringify({
        contents: [
          { 
            parts: [{ text: this.systemPrompt }],
            role: "user" 
          },
          { 
            parts: [{ text: "I understand. I'll keep responses very short and conversational for live voice chat." }],
            role: "model" 
          },
          { 
            parts: [{ text: prompt }],
            role: "user" 
          }
        ]
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
              resolve(`Sorry, I'm having trouble right now.`);
              return;
            }
            const response = JSON.parse(data);
            const text = response.candidates?.[0]?.content?.parts?.[0]?.text;
            const responseText = text || "I didn't catch that.";
            
            const cleanedResponse = responseText
              .replace(/\*\*/g, '')
              .replace(/\*/g, '')
              .replace(/`/g, '')
              .replace(/#{1,6}\s/g, '')
              .trim();
            
            console.log(`[${callSid}] LLM: Success "${cleanedResponse.slice(0, 50)}..." (${duration}ms)`);
            resolve(cleanedResponse);
          } catch (error) {
            console.log(`[${callSid}] LLM: Parse error (${duration}ms)`);
            resolve("Sorry, I had trouble understanding.");
          }
        });
      });

      req.on('error', () => {
        const duration = Date.now() - startTime;
        console.log(`[${callSid}] LLM: Connection error (${duration}ms)`);
        resolve("I'm having connection issues.");
      });

      req.setTimeout(10000, () => {
        req.destroy();
        resolve("Sorry, that took too long to process.");
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
          stability: 0.6,
          similarity_boost: 0.7,
          style: 0.1,
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
            resolve({ text, audioBuffer: null });
          }
        });
      });

      req.on('error', (error) => {
        const duration = Date.now() - startTime;
        console.log(`[${callSid}] TTS: Request error (${duration}ms)`, error.message);
        resolve({ text, audioBuffer: null });
      });

      req.setTimeout(15000, () => {
        req.destroy();
        resolve({ text, audioBuffer: null });
      });

      req.write(postData);
      req.end();
    });
  }
}

class LiveCallGateway {
  constructor() {
    this.eventBus = new EventEmitter();
    this.eventBus.setMaxListeners(1000);
    this.sessions = new Map();
    this.gemini = new GeminiClient();
    this.deepgram = new DeepgramStreamingASR();
    this.tts = new EvenLabsTTS();
    
    this.setupEventHandlers();
  }

  setupEventHandlers() {
    this.eventBus.on('transcript', this.handleTranscript.bind(this));
    this.eventBus.on('generate_response', this.generateResponse.bind(this));
    this.eventBus.on('interrupt', this.handleInterrupt.bind(this));
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

    console.log(`Live Call Server running on port ${config.port}`);
    console.log(`EvenLabs TTS: ${config.elevenlabs.apiKey ? 'Enabled' : 'Disabled'}`);
    console.log(`Deepgram ASR: ${config.deepgram.apiKey ? 'Enabled' : 'Disabled'}`);
    console.log(`Gemini LLM: ${config.gemini.apiKey ? 'Enabled' : 'Disabled'}`);
  }

  handleConnection(ws, req) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const callSid = url.searchParams.get('callSid') || uuidv4();
    
    ws.callSid = callSid;
    ws.isAlive = true;
    
    const session = {
      ws,
      callSid,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      isProcessing: false,
      isPlayingResponse: false,
      currentTranscript: '',
      pendingTranscript: '',
      transcriptBuffer: [],
      deepgramConnection: null,
      lastSpeechTime: 0,
      silenceTimer: null
    };
    
    this.sessions.set(callSid, session);
    console.log(`[${callSid}] New live call connection`);
    
    // Create Deepgram streaming connection
    session.deepgramConnection = this.deepgram.createStreamingConnection(
      callSid,
      (transcript) => this.eventBus.emit('transcript', { callSid, transcript }),
      (error) => console.error(`[${callSid}] Deepgram error:`, error)
    );
    
    ws.on('pong', () => ws.isAlive = true);
    
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        session.lastActivity = Date.now();
        
        if (message.type === 'audio_stream') {
          this.handleAudioStream(callSid, message.audioData);
        } else if (message.type === 'speech_started') {
          this.handleSpeechStarted(callSid);
        } else if (message.type === 'speech_ended') {
          this.handleSpeechEnded(callSid);
        }
      } catch (error) {
        console.error(`[${callSid}] Message parsing error:`, error);
      }
    });
    
    ws.on('close', () => {
      console.log(`[${callSid}] Live call connection closed`);
      this.cleanupSession(callSid);
    });
    
    ws.on('error', (error) => {
      console.error(`[${callSid}] WebSocket error:`, error);
      this.cleanupSession(callSid);
    });

    // Send ready signal
    ws.send(JSON.stringify({
      type: 'ready',
      callSid: callSid,
      timestamp: Date.now()
    }));
  }

  handleAudioStream(callSid, audioData) {
    const session = this.sessions.get(callSid);
    if (!session) return;

    // If AI is currently speaking, this is an interrupt
    if (session.isPlayingResponse) {
      this.eventBus.emit('interrupt', { callSid });
      return;
    }

    // Send audio to Deepgram
    if (session.deepgramConnection) {
      const audioBuffer = Buffer.from(audioData, 'base64');
      this.deepgram.sendAudio(callSid, audioBuffer);
    }
  }

  handleSpeechStarted(callSid) {
    const session = this.sessions.get(callSid);
    if (!session) return;

    console.log(`[${callSid}] Speech started detected`);
    
    // If AI is speaking, interrupt it
    if (session.isPlayingResponse) {
      this.eventBus.emit('interrupt', { callSid });
    }

    // Clear any pending silence timer
    if (session.silenceTimer) {
      clearTimeout(session.silenceTimer);
      session.silenceTimer = null;
    }

    session.lastSpeechTime = Date.now();
  }

  handleSpeechEnded(callSid) {
    const session = this.sessions.get(callSid);
    if (!session) return;

    console.log(`[${callSid}] Speech ended detected`);

    // Start silence detection timer
    if (session.silenceTimer) {
      clearTimeout(session.silenceTimer);
    }

    session.silenceTimer = setTimeout(() => {
      this.handleSilenceDetected(callSid);
    }, 1500); // Wait 1.5 seconds of silence before processing
  }

  handleSilenceDetected(callSid) {
    const session = this.sessions.get(callSid);
    if (!session || session.isProcessing || session.isPlayingResponse) return;

    console.log(`[${callSid}] Silence detected, processing transcript`);

    if (session.pendingTranscript.trim()) {
      this.eventBus.emit('generate_response', {
        callSid,
        text: session.pendingTranscript.trim()
      });
      session.pendingTranscript = '';
    }
  }

  handleTranscript({ callSid, transcript }) {
    const session = this.sessions.get(callSid);
    if (!session) return;

    if (transcript.speech_started) {
      this.handleSpeechStarted(callSid);
      return;
    }

    if (transcript.utterance_end || transcript.speech_final) {
      this.handleSpeechEnded(callSid);
      return;
    }

    if (transcript.text && transcript.text.trim()) {
      console.log(`[${callSid}] Transcript: "${transcript.text}" (final: ${transcript.is_final})`);
      
      if (transcript.is_final) {
        session.pendingTranscript += ' ' + transcript.text;
        session.pendingTranscript = session.pendingTranscript.trim();
      }

      // Send interim transcript to client
      if (session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify({
          type: 'transcript',
          text: transcript.text,
          is_final: transcript.is_final,
          confidence: transcript.confidence,
          timestamp: Date.now()
        }));
      }
    }
  }

  async generateResponse({ callSid, text }) {
    const session = this.sessions.get(callSid);
    if (!session || session.isProcessing) return;

    session.isProcessing = true;
    const startTime = Date.now();

    try {
      console.log(`[${callSid}] Generating response for: "${text}"`);

      // Generate AI response
      const response = await this.gemini.generateContent(text, callSid);
      
      // Generate TTS audio
      const ttsResult = await this.tts.generateSpeech(response, callSid);
      
      const totalTime = Date.now() - startTime;
      console.log(`[${callSid}] Response generated in ${totalTime}ms`);

      if (session.ws.readyState === WebSocket.OPEN) {
        const responseData = {
          type: 'ai_response',
          text: response,
          userText: text,
          timestamp: Date.now(),
          processingTime: totalTime,
          hasAudio: !!ttsResult.audioBuffer
        };

        if (ttsResult.audioBuffer) {
          responseData.audioData = ttsResult.audioBuffer.toString('base64');
          responseData.audioFormat = ttsResult.format;
        }

        session.ws.send(JSON.stringify(responseData));
        session.isPlayingResponse = true;

        // Auto-stop playing response after estimated duration
        const estimatedDuration = response.length * 100; // Rough estimate: 100ms per character
        setTimeout(() => {
          session.isPlayingResponse = false;
        }, Math.max(estimatedDuration, 3000)); // Minimum 3 seconds
      }

    } catch (error) {
      console.error(`[${callSid}] Error generating response:`, error);
      
      if (session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify({
          type: 'error',
          error: 'Failed to generate response',
          timestamp: Date.now()
        }));
      }
    } finally {
      session.isProcessing = false;
    }
  }

  handleInterrupt({ callSid }) {
    const session = this.sessions.get(callSid);
    if (!session) return;

    console.log(`[${callSid}] Interrupt detected - stopping AI response`);
    
    session.isPlayingResponse = false;
    
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({
        type: 'interrupt',
        timestamp: Date.now()
      }));
    }
  }

  cleanupSession(callSid) {
    const session = this.sessions.get(callSid);
    if (session) {
      if (session.silenceTimer) {
        clearTimeout(session.silenceTimer);
      }
      this.deepgram.closeStreamingConnection(callSid);
      this.sessions.delete(callSid);
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
    
    // Cleanup all sessions
    for (const [callSid] of this.sessions) {
      this.cleanupSession(callSid);
    }
    
    this.eventBus.removeAllListeners();
  }
}

const gateway = new LiveCallGateway();

const shutdown = () => {
  console.log('Shutting down live call server...');
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