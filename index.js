const WebSocket = require('ws');
const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const Groq = require('groq-sdk');
require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT) || 8080,
  httpPort: parseInt(process.env.HTTP_PORT) || 8079,
  useHttps: process.env.USE_HTTPS === 'true' || false,
  deepgram: {
    apiKey: process.env.DEEPGRAM_API_KEY,
    ttsVoice: process.env.TTS_VOICE || 'aura-asteria-en'
  },
  groq: {
    apiKey: process.env.GROQ_API_KEY,
    model: process.env.GROQ_MODEL || 'llama3-8b-8192'
  },
  mock: {
    deepgram: process.env.MOCK_DEEPGRAM === 'true',
    llm: process.env.MOCK_LLM === 'true'
  },
  audio: {
    sampleRate: 48000, // Match browser AudioContext
    channels: 1,
    bitsPerSample: 16,
    enableFormatConversion: true,
    maxAudioChunkSize: 8192,
    audioBufferTimeout: 500
  },
  connection: {
    maxRetries: 3,
    retryDelay: 1000,
    healthCheckInterval: 30000,
    connectionTimeout: 10000
  }
};

class GroqStreamingClient {
  constructor() {
    this.apiKey = config.groq.apiKey;
    this.model = config.groq.model;
    this.mockMode = config.mock.llm || !this.apiKey;
    this.systemPrompt = "You are a helpful, friendly, and concise AI assistant. Keep responses brief and conversational. If the user is still speaking (indicated by 'partial' context), acknowledge briefly or wait for more. If they've finished ('complete' context), provide a full, helpful response. Avoid markdown, just plain text.";

    if (this.mockMode) {
      console.log('Groq LLM MOCK MODE ENABLED');
    } else if (this.apiKey) {
      this.client = new Groq({ apiKey: this.apiKey });
      console.log(`Groq LLM LIVE MODE - using model: ${this.model}`);
    } else {
      console.log('Groq LLM DISABLED - no API key');
    }

    this.fallbackResponses = [
      "I understand. How else can I help?",
      "Thanks for that. What else would you like to know?",
      "Got it. Is there anything specific you'd like assistance with?",
      "I'm here to help. What's your next question?",
      "That's helpful context. How can I assist you further?"
    ];
    this.fallbackIndex = 0;
  }

  async generateStreamingResponse(conversationHistory, currentTranscript, isComplete, callSid, onToken, onComplete) {
    const startTime = Date.now();
    console.log(`[${callSid}] LLM: Generating response (complete: ${isComplete}) for: "${currentTranscript}"`);

    if (this.mockMode) {
      console.log(`[${callSid}] LLM: Mock mode enabled, using hardcoded response`);
      const mockResponse = await this.getMockResponse(currentTranscript, isComplete);
      const words = mockResponse.split(' ');
      let accumulated = '';
      for (const word of words) {
        accumulated += word + ' ';
        onToken(word + ' ');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      onComplete();
      const latency = Date.now() - startTime;
      return { text: mockResponse, latency };
    }

    if (!this.client) {
      throw new Error('Groq client not initialized');
    }

    const messages = [{ role: "system", content: this.systemPrompt }];
    conversationHistory.slice(-4).forEach(item => {
      if (item.userText) {
        messages.push({ role: "user", content: item.userText });
        if (item.response) {
          messages.push({ role: "assistant", content: item.response });
        }
      }
    });

    const contextMessage = isComplete ?
      `User just finished saying: "${currentTranscript}". Provide a complete but brief response.` :
      `User is speaking, partial transcript so far: "${currentTranscript}". This is ongoing - more is coming. Acknowledge briefly if appropriate, or wait for more.`;
    messages.push({ role: "user", content: contextMessage });

    try {
      const stream = await this.client.chat.completions.create({
        messages: messages,
        model: this.model,
        stream: true,
        max_tokens: isComplete ? 150 : 50,
        temperature: 0.7,
        top_p: 0.8
      });

      let fullResponse = '';
      for await (const chunk of stream) {
        const token = chunk.choices[0]?.delta?.content || '';
        fullResponse += token;
        onToken(token);
      }
      onComplete();
      const latency = Date.now() - startTime;
      console.log(`[${callSid}] LLM: Stream completed (${latency}ms, complete: ${isComplete})`);
      return { text: fullResponse.trim(), latency };
    } catch (error) {
      console.error(`[${callSid}] LLM: Streaming error:`, error.message || error);
      const fallbackResponse = this.getFallbackResponse(currentTranscript);
      const words = fallbackResponse.split(' ');
      let accumulated = '';
      for (const word of words) {
        accumulated += word + ' ';
        onToken(word + ' ');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      onComplete();
      const latency = Date.now() - startTime;
      return { text: fallbackResponse, latency };
    }
  }

  getMockResponse(input, isComplete) {
    const delay = 500 + Math.random() * 1000;
    return new Promise(resolve => {
      setTimeout(() => {
        const lowerInput = input.toLowerCase();
        let response;
        if (lowerInput.includes('hello') || lowerInput.includes('hi')) {
          response = "Hello! Great to meet you. How can I help you today?";
        } else if (lowerInput.includes('how are you')) {
          response = "I'm doing well, thank you for asking! How are you doing?";
        } else if (lowerInput.includes('weather')) {
          response = "I don't have real-time weather data, but I hope it's nice where you are!";
        } else if (lowerInput.includes('test')) {
          response = "This test is working great! The voice system seems to be functioning well.";
        } else if (lowerInput.includes('explain') || lowerInput.includes('how does') || lowerInput.includes('what')) {
          response = "That's a great question! Let me think about the best way to explain that.";
        } else if (lowerInput.includes('thank')) {
          response = "You're very welcome! Happy to help anytime.";
        } else if (lowerInput.includes('bye') || lowerInput.includes('goodbye')) {
          response = "Goodbye! It was great talking with you today.";
        } else if (!isComplete) {
          const acks = ["I'm listening...", "Go on...", "Mm-hmm...", "I see..."];
          response = acks[Math.floor(Math.random() * acks.length)];
        } else {
          const defaults = [
            "That's interesting! Tell me more about that.",
            "I understand what you're saying. What else would you like to discuss?",
            "Thanks for sharing that with me. How can I help further?",
            "I hear you. What's your next question?",
            "That makes sense. What else is on your mind?"
          ];
          response = defaults[Math.floor(Math.random() * defaults.length)];
        }
        resolve(response);
      }, delay);
    });
  }

  getFallbackResponse(input) {
    const lowerInput = input.toLowerCase();
    if (lowerInput.includes('hello') || lowerInput.includes('hi')) {
      return "Hello! How can I help you today?";
    } else if (lowerInput.includes('how are you')) {
      return "I'm doing well, thank you for asking!";
    } else if (lowerInput.includes('thank')) {
      return "You're welcome!";
    } else if (lowerInput.includes('bye') || lowerInput.includes('goodbye')) {
      return "Goodbye! Have a great day!";
    } else {
      const response = this.fallbackResponses[this.fallbackIndex % this.fallbackResponses.length];
      this.fallbackIndex++;
      return response;
    }
  }
}

class DeepgramTTSClient {
  constructor() {
    this.apiKey = config.deepgram.apiKey;
    this.voice = config.deepgram.ttsVoice;
    this.mockMode = config.mock.deepgram || !this.apiKey;

    if (this.mockMode) {
      console.log('Deepgram TTS MOCK MODE ENABLED - returning text only');
    } else if (this.apiKey) {
      console.log(`Deepgram TTS LIVE MODE - using voice: ${this.voice}`);
    } else {
      console.log('Deepgram TTS DISABLED - no API key');
    }
    if (!this.apiKey && !config.mock.deepgram) {
      console.warn('WARNING: No Deepgram API key found for TTS - will use mock mode');
    }
  }

  async generateSpeech(text, callSid) {
    const startTime = Date.now();
    console.log(`[${callSid}] TTS: Generating speech for: "${text}"`);

    if (this.mockMode || !this.apiKey) {
      console.log(`[${callSid}] TTS: Mock mode - returning empty buffer`);
      const latency = Date.now() - startTime;
      return { text, audioBuffer: Buffer.alloc(0), format: 'mock', voiceId: 'mock', latency };
    }

    try {
      const cleanText = text.replace(/[^\w\s.,!?;:'"-]/gi, '').trim();
      if (!cleanText) {
        throw new Error('Empty or invalid text for TTS');
      }

      const response = await fetch('https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=mulaw&sample_rate=8000&container=none', {
        method: 'POST',
        headers: {
          'Authorization': `Token ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ text: cleanText })
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = Buffer.from(arrayBuffer);
      const latency = Date.now() - startTime;
      console.log(`[${callSid}] TTS: Success ${audioBuffer.length} bytes (${latency}ms)`);
      return { text, audioBuffer, format: 'mulaw', voiceId: this.voice, latency };
    } catch (error) {
      console.error(`[${callSid}] TTS: Error`, error.message);
      const latency = Date.now() - startTime;
      return { text, audioBuffer: null, latency };
    }
  }
}

class DeepgramStreamingASR {
  constructor() {
    this.apiKey = config.deepgram.apiKey;
    this.mockMode = config.mock.deepgram || !this.apiKey;
    this.audioQueues = {};
    this.mockConnections = {};
    this.connectionStates = {};

    if (this.mockMode) {
      console.log('Deepgram ASR MOCK MODE ENABLED');
    } else if (this.apiKey) {
      this.client = createClient(this.apiKey);
      console.log('Deepgram ASR LIVE MODE');
    } else {
      console.log('Deepgram ASR DISABLED - no API key');
    }
  }

  async createStreamingConnection(callSid, onTranscript) {
    console.log(`[${callSid}] Creating Deepgram streaming connection`);

    if (this.mockMode || !this.apiKey) {
      console.log(`[${callSid}] Using mock Deepgram connection`);
      const mockConnection = new EventEmitter();
      mockConnection.readyState = 1;
      mockConnection.audioChunkCount = 0;
      mockConnection.send = (audioBuffer) => {
        mockConnection.audioChunkCount++;
        console.log(`[${callSid}] Mock: Received audio chunk ${mockConnection.audioChunkCount} (${audioBuffer.length} bytes)`);
        
        const shouldTranscribe = mockConnection.audioChunkCount >= 3 &&
          mockConnection.audioChunkCount % (2 + Math.floor(Math.random() * 3)) === 0;
          
        if (shouldTranscribe) {
          const mockTexts = [
            "Hello there how are you doing today",
            "I have a question about artificial intelligence",
            "Can you help me understand how this works",
            "What do you think about the weather",
            "I'm testing the voice recognition system",
            "This is working perfectly now",
            "Could you please explain that concept",
            "Thank you for your help with this"
          ];
          
          const mockText = mockTexts[Math.floor(Math.random() * mockTexts.length)];
          const isFinal = Math.random() > 0.4;
          
          console.log(`[${callSid}] Mock transcript: "${mockText}" (final: ${isFinal})`);
          
          setTimeout(() => {
            onTranscript({ 
              text: mockText, 
              is_final: isFinal, 
              confidence: 0.95 
            });
          }, 100 + Math.random() * 200);
        }
      };
      
      mockConnection.finish = () => {
        mockConnection.emit('close');
      };
      
      this.mockConnections[callSid] = mockConnection;
      this.connectionStates[callSid] = 'CONNECTING';
      
      setTimeout(() => {
        mockConnection.emit('open');
        this.connectionStates[callSid] = 'OPEN';
        console.log(`[${callSid}] Mock connection ready`);
      }, 100);
      
      return mockConnection;
    }

    if (!this.client) {
      throw new Error('Deepgram client not initialized');
    }

    this.connectionStates[callSid] = 'CONNECTING';

    // Updated connection options to match working example - linear16 PCM
    const connectionOptions = {
      model: "nova-2",
      encoding: "linear16", // Raw PCM (Float32 → Int16)
      sample_rate: 48000,   // Match browser AudioContext sample rate
      channels: 1,
      interim_results: true,
      punctuate: true,
      smart_format: true,
      utterance_end_ms: 1000,
      vad_events: true
    };

    console.log(`[${callSid}] Deepgram connection options:`, JSON.stringify(connectionOptions, null, 2));

    try {
      const deepgram = this.client.listen.live(connectionOptions);

      deepgram.on(LiveTranscriptionEvents.Open, () => {
        console.log(`[${callSid}] Deepgram connection opened successfully`);
        this.connectionStates[callSid] = 'OPEN';
        this.processAudioQueue(callSid, deepgram);
      });

      deepgram.on(LiveTranscriptionEvents.Close, () => {
        console.log(`[${callSid}] Deepgram live connection closed`);
        this.connectionStates[callSid] = 'CLOSED';
        if (this.audioQueues[callSid]) {
          console.log(`[${callSid}] Clearing audio queue on close`);
          delete this.audioQueues[callSid];
        }
        delete this.connectionStates[callSid];
      });

      deepgram.on(LiveTranscriptionEvents.Error, (error) => {
        console.error(`[${callSid}] Deepgram connection error:`, error.message || error);
        this.connectionStates[callSid] = 'ERROR';
        if (this.audioQueues[callSid]) {
          delete this.audioQueues[callSid];
        }
      });

      deepgram.on(LiveTranscriptionEvents.Transcript, (data) => {
        try {
          console.log(`[${callSid}] Raw Deepgram response:`, JSON.stringify(data, null, 2));
          
          const result = data.channel?.alternatives?.[0];
          if (result) {
            const transcriptText = result.transcript.trim();
            if (transcriptText || result.words?.length > 0) {
              console.log(`[${callSid}] Transcript: "${transcriptText}" (final: ${data.is_final}, confidence: ${result.confidence})`);
              onTranscript({
                text: transcriptText,
                is_final: data.is_final || false,
                confidence: result.confidence || 0
              });
            }
          }
        } catch (parseError) {
          console.error(`[${callSid}] Error processing Deepgram transcript:`, parseError);
        }
      });

      deepgram.on(LiveTranscriptionEvents.Metadata, (data) => {
        console.log(`[${callSid}] Deepgram metadata:`, data);
      });

      deepgram.on(LiveTranscriptionEvents.UtteranceEnd, (data) => {
        console.log(`[${callSid}] Utterance ended:`, data);
      });

      return deepgram;
    } catch (error) {
      console.error(`[${callSid}] Error creating Deepgram connection:`, error);
      this.connectionStates[callSid] = 'ERROR';
      return null;
    }
  }

  sendAudio(callSid, audioBuffer, connection) {
    try {
      if (!connection) {
        console.warn(`[${callSid}] No connection object provided to sendAudio`);
        return false;
      }

      const connectionState = this.connectionStates[callSid];
      
      if (Math.random() < 0.1) {
        console.log(`[${callSid}] Sending audio: ${audioBuffer.length} bytes (state: ${connectionState}), first 16 bytes: ${Array.from(audioBuffer.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
      }
      
      if (connectionState === 'OPEN') {
        connection.send(audioBuffer);
        return true;
      } else if (connectionState === 'CONNECTING') {
        console.warn(`[${callSid}] Connection not ready (CONNECTING), queuing audio`);
        if (!this.audioQueues[callSid]) {
          this.audioQueues[callSid] = [];
        }
        this.audioQueues[callSid].push(audioBuffer);
        return true;
      } else {
        console.warn(`[${callSid}] Connection state is ${connectionState}, dropping audio`);
        return false;
      }
    } catch (error) {
      console.error(`[${callSid}] Error sending audio:`, error.message || error);
      return false;
    }
  }

  processAudioQueue(callSid, connection) {
    const queue = this.audioQueues[callSid];
    if (!queue || queue.length === 0) return;

    console.log(`[${callSid}] Processing audio queue (${queue.length} chunks)`);
    
    while (queue.length > 0 && this.connectionStates[callSid] === 'OPEN') {
      const chunk = queue.shift();
      try {
        connection.send(chunk);
      } catch (sendError) {
        console.error(`[${callSid}] Error sending queued audio:`, sendError.message || sendError);
        queue.unshift(chunk);
        break;
      }
    }
    
    if (queue.length === 0) {
      delete this.audioQueues[callSid];
    }
  }

  cleanup() {
    Object.keys(this.mockConnections).forEach(callSid => {
      try {
        this.mockConnections[callSid].finish();
      } catch (e) {
        console.error(`Error closing mock connection for ${callSid}:`, e);
      }
    });
    this.mockConnections = {};
    this.audioQueues = {};
    this.connectionStates = {};
  }
}

class PushToTalkSession {
  constructor(callSid, groq, deepgram, tts, ws) {
    this.callSid = callSid;
    this.groq = groq;
    this.deepgram = deepgram;
    this.tts = tts;
    this.ws = ws;
    this.isRecording = false;
    this.isProcessing = false;
    this.isPlayingAudio = false;
    this.conversationHistory = [];
    this.currentTranscripts = [];
    this.accumulatedTranscript = '';
    this.deepgramConnection = null;
    this.deepgramFailed = false;
    this.deepgramReady = false;
    this.sessionStats = {
      startTime: Date.now(),
      audioChunksReceived: 0,
      transcriptsReceived: 0,
      llmResponses: 0,
      ttsGenerations: 0,
      audioChunksSent: 0,
      totalAudioDuration: 0,
      currentTurn: {
        startTime: null,
        endTime: null,
        audioDuration: 0,
        asrLatency: 0,
        llmLatency: 0,
        ttsLatency: 0
      }
    };
    this.currentTurn = this.sessionStats.currentTurn;
    console.log(`[${this.callSid}] Push-to-talk session initialized`);
    this.setupDeepgramConnection();
  }

  sendToClient(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  handleInterrupt() {
    console.log(`[${this.callSid}] Interrupt detected - stopping all processing`);
    this.isRecording = false;
    this.isProcessing = false;
    this.currentTranscripts = [];
    this.accumulatedTranscript = '';
    this.sendToClient({ type: 'interrupted' });
  }

  async setupDeepgramConnection() {
    if (this.deepgramConnection) {
      console.warn(`[${this.callSid}] Deepgram connection already exists, closing before reconnecting`);
      try {
        this.deepgramConnection.finish();
      } catch (e) {
        console.error(`[${this.callSid}] Error closing existing Deepgram connection:`, e);
      }
      this.deepgramConnection = null;
    }

    this.deepgramFailed = false;
    this.deepgramReady = false;

    try {
      const connection = await this.deepgram.createStreamingConnection(
        this.callSid,
        (transcript) => this.handleTranscript(transcript)
      );

      if (connection) {
        this.deepgramConnection = connection;

        connection.on(LiveTranscriptionEvents.Open, () => {
          console.log(`[${this.callSid}] Deepgram streaming connection ready (Session listener)`);
          this.deepgramReady = true;
        });

        connection.on(LiveTranscriptionEvents.Close, () => {
          console.log(`[${this.callSid}] Deepgram connection not ready (Session listener)`);
          this.deepgramReady = false;
          this.deepgramConnection = null;
        });

        connection.on(LiveTranscriptionEvents.Error, (error) => {
          console.error(`[${this.callSid}] Deepgram connection failed (Session listener):`, error?.message || error);
          this.deepgramReady = false;
          this.deepgramFailed = true;
          this.deepgramConnection = null;
        });

      } else {
        console.error(`[${this.callSid}] Failed to create Deepgram connection`);
        this.deepgramFailed = true;
      }
    } catch (error) {
      console.error(`[${this.callSid}] Error setting up Deepgram connection:`, error);
      this.deepgramFailed = true;
    }
  }

  startPlayback() {
    this.isPlayingAudio = true;
    this.sendToClient({ type: 'playback_started' });
  }

  async generateTTSForResponse(responseText) {
    try {
      this.conversationHistory.push({
        userText: this.accumulatedTranscript,
        response: responseText,
        timestamp: Date.now()
      });
      if (this.conversationHistory.length > 8) {
        this.conversationHistory = this.conversationHistory.slice(-6);
      }

      const ttsResult = await this.tts.generateSpeech(responseText, this.callSid);
      this.currentTurn.ttsLatency = ttsResult.latency;
      this.sessionStats.ttsGenerations++;

      if (ttsResult.audioBuffer && ttsResult.audioBuffer.length > 0) {
        this.sendToClient({
          type: 'audio_response',
          audio: ttsResult.audioBuffer.toString('base64'),
          format: ttsResult.format,
          voiceId: ttsResult.voiceId
        });
      } else {
        console.log(`[${this.callSid}] TTS: No audio generated, sending text only`);
        this.sendToClient({
          type: 'text_response',
          text: responseText
        });
      }
    } catch (error) {
      console.error(`[${this.callSid}] TTS generation error:`, error);
      this.sendToClient({
        type: 'text_response',
        text: responseText
      });
    } finally {
      this.isProcessing = false;
    }
  }

  addMessageToHistory(userText, response) {
    this.conversationHistory.push({ userText, response, timestamp: Date.now() });
    if (this.conversationHistory.length > 8) {
      this.conversationHistory = this.conversationHistory.slice(-6);
    }
  }

  async generateFinalResponse() {
    if (this.isProcessing || !this.accumulatedTranscript.trim()) return;
    this.isProcessing = true;

    console.log(`[${this.callSid}] Generating final response for: "${this.accumulatedTranscript}"`);
    this.sendToClient({
      type: 'processing_started',
      userText: this.accumulatedTranscript,
      timestamp: Date.now()
    });

    try {
      let fullResponseText = '';
      const onToken = (token) => {
        fullResponseText += token;
        this.sendToClient({
          type: 'llm_token',
          text: token,
          isPartial: false,
          timestamp: Date.now()
        });
      };
      const onComplete = () => {
        this.sendToClient({ type: 'llm_stream_complete', timestamp: Date.now() });
      };

      const result = await this.groq.generateStreamingResponse(
        this.conversationHistory,
        this.accumulatedTranscript,
        true,
        this.callSid,
        onToken,
        onComplete
      );

      this.currentTurn.llmLatency = result.latency;
      this.sessionStats.llmResponses++;
      await this.generateTTSForResponse(result.text.trim());

    } catch (error) {
      console.error(`[${this.callSid}] Error generating final response stream:`, error);
      this.isProcessing = false;
      this.sendToClient({
        type: 'llm_error',
        error: `Final LLM Error: ${error.message}`,
        timestamp: Date.now()
      });

      const fallbackResponse = "I understand. How else can I help you?";
      this.sendToClient({
        type: 'llm_token',
        text: fallbackResponse,
        isPartial: false,
        timestamp: Date.now()
      });
      this.sendToClient({ type: 'llm_stream_complete', timestamp: Date.now() });
      await this.generateTTSForResponse(fallbackResponse);
    }
  }

  startRecording() {
    if (this.isRecording) return;

    console.log(`[${this.callSid}] Recording started`);
    this.isRecording = true;
    this.currentTranscripts = [];
    this.accumulatedTranscript = '';
    this.currentTurn.startTime = Date.now();
    this.currentTurn.audioDuration = 0;
    this.currentTurn.asrLatency = 0;
    this.currentTurn.llmLatency = 0;
    this.currentTurn.ttsLatency = 0;

    this.sendToClient({ type: 'recording_started' });
  }

  stopRecording() {
    if (!this.isRecording) return;

    console.log(`[${this.callSid}] Recording stopped`);
    this.isRecording = false;
    this.currentTurn.endTime = Date.now();

    this.sendToClient({ type: 'recording_stopped' });

    if (this.accumulatedTranscript.trim()) {
      this.generateFinalResponse();
    } else {
      console.log(`[${this.callSid}] No transcript to process after recording stopped`);
    }
  }

  // FIXED: Convert Float32Array buffer to Int16Array for Deepgram
  addAudioData(audioBuffer) {
    if (!audioBuffer || audioBuffer.length === 0) return;

    console.log(`[${this.callSid}] Received raw PCM audio data: ${audioBuffer.length} bytes`);
    this.sessionStats.audioChunksReceived++;

    // Convert Float32Array buffer to Int16Array (linear16) for Deepgram
    try {
      const float32Array = new Float32Array(audioBuffer.buffer);
      const int16Array = new Int16Array(float32Array.length);
      
      for (let i = 0; i < float32Array.length; i++) {
        // Clamp and scale from [-1.0, 1.0] → [-32768, 32767]
        let sample = float32Array[i];
        sample = Math.max(-1, Math.min(1, sample)); // clamp
        int16Array[i] = sample * 0x7FFF; // scale to 16-bit
      }
      
      // Send converted Int16Array buffer to Deepgram
      if (this.deepgramReady && this.deepgramConnection && !this.deepgramFailed) {
        const success = this.deepgram.sendAudio(this.callSid, int16Array.buffer, this.deepgramConnection);
        if (success) {
          this.sessionStats.audioChunksSent++;
        } else {
          console.warn(`[${this.callSid}] Failed to send audio chunk to Deepgram`);
        }
      } else if (this.deepgramConnection && !this.deepgramFailed) {
        console.warn(`[${this.callSid}] Deepgram connection exists but not ready, queuing audio`);
        const success = this.deepgram.sendAudio(this.callSid, int16Array.buffer, this.deepgramConnection);
        if (success) {
          this.sessionStats.audioChunksSent++;
        }
      } else if (this.deepgramFailed) {
        console.warn(`[${this.callSid}] Deepgram failed, dropping audio chunk`);
      } else {
        console.warn(`[${this.callSid}] No Deepgram connection available, dropping audio chunk`);
      }
    } catch (error) {
      console.error(`[${this.callSid}] Error converting audio data:`, error);
    }
  }

  handleTranscript(transcript) {
    console.log(`[${this.callSid}] Processing transcript: "${transcript.text}" (final: ${transcript.is_final})`);
    
    this.sessionStats.transcriptsReceived++;
    
    // Send transcript to client immediately for display
    this.sendToClient({
      type: 'transcript_received',
      text: transcript.text,
      is_final: transcript.is_final,
      confidence: transcript.confidence
    });
    
    if (this.isRecording && transcript.text.trim()) {
      if (transcript.is_final) {
        this.currentTranscripts.push(transcript.text);
        this.accumulatedTranscript = this.currentTranscripts.join(' ');
        console.log(`[${this.callSid}] Accumulated transcript: "${this.accumulatedTranscript}"`);
      }
      
      // Always send to streaming LLM for real-time responses
      this.sendToLLMStreaming(transcript.text, transcript.is_final);
    }
  }

  async sendToLLMStreaming(transcriptText, isComplete) {
    try {
      let fullResponseText = '';
      const onToken = (token) => {
        fullResponseText += token;
        this.sendToClient({
          type: 'llm_token',
          text: token,
          isPartial: !isComplete,
          timestamp: Date.now()
        });
      };
      const onComplete = () => {
        this.sendToClient({ type: 'llm_stream_complete', timestamp: Date.now() });
      };

      const result = await this.groq.generateStreamingResponse(
        this.conversationHistory,
        transcriptText,
        isComplete,
        this.callSid,
        onToken,
        onComplete
      );

      this.currentTurn.llmLatency = result.latency;

    } catch (error) {
      console.error(`[${this.callSid}] LLM Streaming Error:`, error.message || error);
      this.sendToClient({
        type: 'llm_error',
        error: `Streaming LLM Error: ${error.message}`,
        timestamp: Date.now()
      });
    }
  }

  cleanup() {
    console.log(`[${this.callSid}] Cleaning up PushToTalkSession`);
    if (this.deepgramConnection) {
       try {
         console.log(`[${this.callSid}] Finishing Deepgram connection during cleanup`);
         this.deepgramConnection.finish();
       } catch (e) {
         console.error(`[${this.callSid}] Error finishing Deepgram connection during cleanup:`, e);
       }
       this.deepgramConnection = null;
       this.deepgramReady = false;
    }

    const endTime = Date.now();
    const sessionDuration = endTime - this.sessionStats.startTime;
    const stats = {
      sessionId: this.callSid,
      duration: `${(sessionDuration / 1000).toFixed(2)}s`,
      audioChunks: this.sessionStats.audioChunksReceived,
      transcripts: this.sessionStats.transcriptsReceived,
      llmResponses: this.sessionStats.llmResponses,
      ttsGenerations: this.sessionStats.ttsGenerations,
      audioChunksSent: this.sessionStats.audioChunksSent,
      totalAudioDuration: `${(this.sessionStats.totalAudioDuration / 1000).toFixed(2)}s`
    };
    console.log(`[${this.callSid}] Session cleanup stats:`, JSON.stringify(stats, null, 2));
  }
}

class LiveCallGateway {
  constructor() {
    this.sessions = new Map();
    this.groq = new GroqStreamingClient();
    this.deepgram = new DeepgramStreamingASR();
    this.tts = new DeepgramTTSClient();
    this.serverStats = {
      startTime: Date.now(),
      totalSessions: 0,
      activeSessions: 0,
      totalAudioChunks: 0,
      totalTranscripts: 0,
      totalResponses: 0
    };
  }

  async start() {
    const app = express();
    app.use(express.static('public'));
    app.get('/health', (req, res) => {
      res.json({ status: 'OK', timestamp: new Date().toISOString() });
    });

    const server = config.useHttps ?
      https.createServer({
        key: fs.readFileSync('server.key'),
        cert: fs.readFileSync('server.cert')
      }, app) :
      http.createServer(app);

    const wss = new WebSocket.Server({ server });

    wss.on('connection', (ws, req) => {
      const callSid = `call_${uuidv4().substring(0, 8)}`;
      console.log(`[${callSid}] New push-to-talk connection - Total: ${this.sessions.size + 1}`);

      const session = new PushToTalkSession(callSid, this.groq, this.deepgram, this.tts, ws);
      this.sessions.set(callSid, session);
      this.serverStats.totalSessions++;
      this.serverStats.activeSessions = this.sessions.size;

      ws.send(JSON.stringify({ type: 'ready', callSid }));

      ws.on('message', async (message) => {
        try {
          if (message instanceof Buffer) {
            // Raw Float32Array audio data from browser - send to session for conversion
            this.serverStats.totalAudioChunks++;
            session.addAudioData(message);
          } else {
            const data = JSON.parse(message);
            switch (data.type) {
              case 'start_recording':
                session.startRecording();
                break;
              case 'stop_recording':
                session.stopRecording();
                break;
              case 'interrupt':
                session.handleInterrupt();
                break;
              default:
                console.warn(`[${callSid}] Unknown message type:`, data.type);
            }
          }
        } catch (error) {
          console.error(`[${callSid}] Error processing message:`, error);
          session.sendToClient({ type: 'error', error: 'Message processing error' });
        }
      });

      ws.on('close', () => {
        console.log(`[${callSid}] Client disconnected`);
        session.cleanup();
        this.sessions.delete(callSid);
        this.serverStats.activeSessions = this.sessions.size;
      });

      ws.on('error', (error) => {
        console.error(`[${callSid}] WebSocket error:`, error);
      });
    });

    const port = config.port;
    server.listen(port, () => {
      console.log(`Push-to-Talk Voice Server running on port ${port}`);
      console.log(`Access: ${config.useHttps ? 'https' : 'http'}://localhost:${port}`);
    });

    const httpPort = config.httpPort;
    if (httpPort !== port) {
      const redirectApp = express();
      redirectApp.use((req, res) => {
        res.redirect(301, `https://localhost:${port}${req.originalUrl}`);
      });
      http.createServer(redirectApp).listen(httpPort, () => {
        console.log(`HTTP redirect server running on port ${httpPort}`);
      });
    }

    const shutdown = () => {
      console.log('\nShutting down server...');
      this.deepgram.cleanup();
      this.sessions.forEach(session => session.cleanup());
      this.sessions.clear();
      wss.close(() => console.log('WebSocket server closed'));
      server.close(() => console.log('HTTP server closed'));
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }
}

const gateway = new LiveCallGateway();
gateway.start().catch(console.error);