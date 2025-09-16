const WebSocket = require('ws');
const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@deepgram/sdk');
require('dotenv').config();

const config = {
    port: parseInt(process.env.PORT) || 8080,
    httpPort: parseInt(process.env.HTTP_PORT) || 8079,
    useHttps: process.env.USE_HTTPS === 'true' || false,
    sslKeyPath: process.env.SSL_KEY_PATH || './ssl/private-key.pem',
    sslCertPath: process.env.SSL_CERT_PATH || './ssl/certificate.pem',
    deepgram: {
        apiKey: process.env.DEEPGRAM_API_KEY,
        streamingModels: ['nova-2', 'base', 'enhanced'],
        prerecordedModels: ['general', 'nova-2', 'base'],
        currentModel: 'nova-2',
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
    },
    mock: {
        deepgram: process.env.MOCK_DEEPGRAM === 'true',
        llm: process.env.MOCK_LLM === 'true'
    },
    audio: {
        sampleRate: 16000,
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

// Enhanced Audio format converter
class AudioFormatConverter {
    static webmToPcm(webmBuffer) {
        try {
            if (webmBuffer.length === 0) return Buffer.alloc(0);
            
            // Check if this is actually raw PCM data (from WAV)
            if (webmBuffer.length > 44 && webmBuffer.toString('ascii', 0, 4) === 'RIFF') {
                console.log('Processing WAV format audio');
                return webmBuffer.slice(44); // Skip WAV header
            }
            
            // For WebM/Opus or other formats, pass through as-is
            console.log(`Processing audio buffer: ${webmBuffer.length} bytes`);
            return webmBuffer;
            
        } catch (error) {
            console.warn('Audio conversion failed, using original buffer:', error);
            return webmBuffer;
        }
    }

    static normalizeAudioLevel(buffer, targetRMS = 0.05) {
        if (buffer.length === 0) return buffer;
        
        try {
            // Only normalize if we have PCM data (even number of bytes)
            if (buffer.length % 2 !== 0) {
                return buffer;
            }
            
            const samples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
            let sum = 0;
            
            for (let i = 0; i < samples.length; i++) {
                const sample = samples[i] / 32768;
                sum += sample * sample;
            }
            
            const currentRMS = Math.sqrt(sum / samples.length);
            if (currentRMS === 0) return buffer;
            
            const gain = Math.min(targetRMS / currentRMS, 3.0);
            
            for (let i = 0; i < samples.length; i++) {
                samples[i] = Math.max(-32768, Math.min(32767, samples[i] * gain));
            }
            
            return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
        } catch (error) {
            console.warn('Audio normalization failed:', error);
            return buffer;
        }
    }
}

class DeepgramStreamingASR {
    constructor() {
        this.apiKey = config.deepgram.apiKey;
        this.client = this.apiKey && !config.mock.deepgram ? createClient(this.apiKey) : null;
        this.activeConnections = new Map();
        this.currentModel = config.deepgram.currentModel;
        this.mockMode = config.mock.deepgram || !this.apiKey;
        
        console.log(`Deepgram ASR initialized with streaming model: ${this.currentModel}`);
        if (this.mockMode) {
            console.log('🎭 Deepgram MOCK MODE ENABLED - using hardcoded responses');
        } else {
            console.log('✅ Deepgram LIVE MODE - using real API');
        }
        
        if (!this.apiKey && !config.mock.deepgram) {
            console.warn('WARNING: No Deepgram API key found - auto-enabling mock mode');
        }
    }

    createStreamingConnection(callSid, onTranscript, onError) {
        if (this.mockMode) {
            console.log(`[${callSid}] ASR: Mock mode enabled, creating mock connection`);
            return this.createMockConnection(callSid, onTranscript, onError);
        }

        try {
            console.log(`[${callSid}] Creating Deepgram streaming connection`);
            
            const connectionOptions = {
                model: this.currentModel,
                language: config.deepgram.language,
                encoding: 'linear16',
                sample_rate: 16000,
                channels: 1,
                smart_format: true,
                interim_results: true,
                utterance_end_ms: 300,
                vad_events: true,
                endpointing: 100,
                no_delay: true,
                punctuate: true,
                profanity_filter: false
            };

            const connection = this.client.listen.live(connectionOptions);
            let connectionEstablished = false;

            const connectionTimeout = setTimeout(() => {
                if (!connectionEstablished) {
                    console.error(`[${callSid}] Deepgram connection timeout - falling back to mock mode`);
                    connection.finish();
                    const mockConnection = this.createMockConnection(callSid, onTranscript, onError);
                    this.activeConnections.set(callSid, mockConnection);
                }
            }, config.connection.connectionTimeout);

            connection.on('open', () => {
                connectionEstablished = true;
                clearTimeout(connectionTimeout);
                console.log(`[${callSid}] Deepgram streaming connection opened`);
            });

            connection.on('transcript', (data) => {
                try {
                    if (data.channel?.alternatives?.[0]?.transcript) {
                        const transcript = data.channel.alternatives[0].transcript.trim();
                        if (transcript) {
                            console.log(`[${callSid}] Deepgram transcript: "${transcript}"`);
                            
                            onTranscript({
                                text: transcript,
                                confidence: data.channel.alternatives[0].confidence || 0,
                                is_final: data.is_final || false,
                                speech_final: data.speech_final || false,
                                model: this.currentModel,
                                source: 'deepgram',
                                timestamp: Date.now()
                            });
                        }
                    }
                } catch (error) {
                    console.error(`[${callSid}] Error processing transcript:`, error);
                }
            });

            connection.on('error', (error) => {
                console.error(`[${callSid}] Deepgram streaming error:`, error.message || error);
                clearTimeout(connectionTimeout);
                
                if (!connectionEstablished) {
                    console.log(`[${callSid}] Switching to mock mode due to connection error`);
                    const mockConnection = this.createMockConnection(callSid, onTranscript, onError);
                    this.activeConnections.set(callSid, mockConnection);
                }
            });

            connection.on('close', (event) => {
                console.log(`[${callSid}] Deepgram connection closed`);
                clearTimeout(connectionTimeout);
                this.activeConnections.delete(callSid);
            });

            this.activeConnections.set(callSid, connection);
            return connection;

        } catch (error) {
            console.error(`[${callSid}] Failed to create Deepgram connection:`, error);
            return this.createMockConnection(callSid, onTranscript, onError);
        }
    }

    createMockConnection(callSid, onTranscript, onError) {
        console.log(`[${callSid}] Creating mock transcription connection`);
        
        const mockConnection = {
            readyState: 1,
            audioChunkCount: 0,
            lastTranscriptTime: 0,
            send: (audioBuffer) => {
                mockConnection.audioChunkCount++;
                
                // Generate mock transcript every 15-25 chunks to simulate realistic speech
                const shouldTranscribe = mockConnection.audioChunkCount >= 15 && 
                                       mockConnection.audioChunkCount % (15 + Math.floor(Math.random() * 10)) === 0 &&
                                       audioBuffer.length > 500;
                
                if (shouldTranscribe) {
                    const mockTexts = [
                        "Hello there, how are you doing today?",
                        "I have a question about artificial intelligence.",
                        "Can you help me understand how this works?",
                        "What do you think about the weather?",
                        "I'm testing the voice recognition system.",
                        "This is a sample message for testing.",
                        "How does machine learning actually work?",
                        "Could you explain that in more detail?",
                        "I'm curious about your capabilities.",
                        "What can you tell me about technology?"
                    ];
                    
                    const randomText = mockTexts[Math.floor(Math.random() * mockTexts.length)];
                    
                    console.log(`[${callSid}] Mock transcript generated: "${randomText}"`);
                    
                    setTimeout(() => {
                        onTranscript({
                            text: randomText,
                            confidence: 0.85 + Math.random() * 0.1,
                            is_final: true,
                            speech_final: true,
                            model: 'mock',
                            source: 'mock',
                            timestamp: Date.now()
                        });
                    }, 200 + Math.random() * 300);
                    
                    mockConnection.audioChunkCount = 0;
                }
                return true;
            },
            finish: () => {
                console.log(`[${callSid}] Mock connection finished`);
            },
            getReadyState: () => 1,
            on: () => {}
        };
        
        // IMPORTANT: Store the mock connection so sendAudio can find it
        this.activeConnections.set(callSid, mockConnection);
        
        return mockConnection;
    }

    sendAudio(callSid, audioBuffer) {
        const connection = this.activeConnections.get(callSid);
        if (!connection) {
            console.warn(`[${callSid}] No connection found for audio`);
            return false;
        }

        try {
            const readyState = connection.getReadyState();
            
            if (readyState === 1) {
                let processedBuffer = audioBuffer;
                if (config.audio.enableFormatConversion) {
                    processedBuffer = AudioFormatConverter.webmToPcm(audioBuffer);
                    processedBuffer = AudioFormatConverter.normalizeAudioLevel(processedBuffer);
                }
                
                connection.send(processedBuffer);
                return true;
            } else {
                console.warn(`[${callSid}] Connection not ready (state: ${readyState})`);
                return false;
            }
        } catch (error) {
            console.error(`[${callSid}] Error sending audio:`, error);
            return false;
        }
    }

    closeStreamingConnection(callSid) {
        const connection = this.activeConnections.get(callSid);
        if (connection && connection.finish) {
            try {
                connection.finish();
            } catch (error) {
                console.error(`[${callSid}] Error closing connection:`, error);
            }
        }
        this.activeConnections.delete(callSid);
    }

    cleanup() {
        for (const [callSid, connection] of this.activeConnections) {
            try {
                if (connection.finish) connection.finish();
            } catch (error) {}
        }
        this.activeConnections.clear();
    }
}

class GeminiStreamingClient {
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
        this.systemPrompt = `You are an AI assistant in a live voice conversation. Keep responses VERY SHORT (1-2 sentences max).
Be conversational, natural, and helpful. No markdown, lists, or complex formatting.
This is real-time speech - be concise and sound natural when spoken aloud.

IMPORTANT: You will receive transcripts in real-time as the user speaks. Respond appropriately:
- If you receive partial transcripts, acknowledge briefly and wait for more
- When you receive a complete thought or question, provide a full but concise response
- Be patient and conversational throughout the process`;
        
        this.mockMode = config.mock.llm || !this.apiKey;
        this.fallbackResponses = [
            "I understand. What else would you like to know?",
            "That's interesting. Can you tell me more?",
            "I see what you mean. How can I help with that?",
            "Got it. What's your next question?",
            "That makes sense. What else is on your mind?"
        ];
        this.fallbackIndex = 0;

        if (this.mockMode) {
            console.log('🎭 Gemini MOCK MODE ENABLED - using hardcoded responses');
        } else {
            console.log('✅ Gemini LIVE MODE - using real API');
        }
    }

    async generateStreamingResponse(conversationHistory, currentTranscript, isComplete, callSid) {
        const startTime = Date.now();
        
        if (this.mockMode) {
            console.log(`[${callSid}] LLM: Mock mode enabled, using hardcoded response`);
            return this.getMockResponse(currentTranscript, isComplete);
        }
        
        if (!this.apiKey) {
            console.log(`[${callSid}] LLM: No API key, using fallback response`);
            return this.getFallbackResponse(currentTranscript);
        }

        const messages = [
            { parts: [{ text: this.systemPrompt }], role: "user" },
            { parts: [{ text: "I understand. I'll keep responses very short and conversational." }], role: "model" }
        ];

        conversationHistory.slice(-4).forEach(item => {
            if (item.userText) {
                messages.push({ parts: [{ text: `User: "${item.userText}"` }], role: "user" });
                if (item.response) {
                    messages.push({ parts: [{ text: item.response }], role: "model" });
                }
            }
        });

        const contextMessage = isComplete 
            ? `User just finished saying: "${currentTranscript}". Provide a complete but brief response.`
            : `User is speaking, partial transcript so far: "${currentTranscript}". This is ongoing - more is coming. Acknowledge briefly if appropriate, or wait for more.`;
            
        messages.push({
            parts: [{ text: contextMessage }],
            role: "user"
        });

        return new Promise((resolve) => {
            const postData = JSON.stringify({
                contents: messages,
                generationConfig: {
                    maxOutputTokens: isComplete ? 150 : 50,
                    temperature: 0.7,
                    topP: 0.8
                }
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
                            console.log(`[${callSid}] LLM: Error ${res.statusCode}, using fallback`);
                            resolve(this.getFallbackResponse(currentTranscript));
                            return;
                        }
                        const response = JSON.parse(data);
                        const text = response.candidates?.[0]?.content?.parts?.[0]?.text;
                        const responseText = text || this.getFallbackResponse(currentTranscript);
                        const cleanedResponse = responseText
                            .replace(/\*\*/g, '')
                            .replace(/\*/g, '')
                            .replace(/`/g, '')
                            .replace(/#{1,6}\s/g, '')
                            .replace(/\n+/g, ' ')
                            .trim();
                        console.log(`[${callSid}] LLM: "${cleanedResponse}" (${duration}ms, complete: ${isComplete})`);
                        resolve(cleanedResponse);
                    } catch (error) {
                        console.log(`[${callSid}] LLM: Parse error, using fallback`);
                        resolve(this.getFallbackResponse(currentTranscript));
                    }
                });
            });

            req.on('error', () => {
                console.log(`[${callSid}] LLM: Connection error, using fallback`);
                resolve(this.getFallbackResponse(currentTranscript));
            });

            req.setTimeout(8000, () => {
                req.destroy();
                resolve(this.getFallbackResponse(currentTranscript));
            });

            req.write(postData);
            req.end();
        });
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
                    response = "I can't check the current weather, but I hope it's nice where you are!";
                } else if (lowerInput.includes('artificial intelligence') || lowerInput.includes('ai') || lowerInput.includes('machine learning')) {
                    response = "AI is a fascinating field! I'm happy to discuss it with you.";
                } else if (lowerInput.includes('question') || lowerInput.includes('help')) {
                    response = "Sure! I'd be happy to help answer your question.";
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

class ElevenLabsTTS {
    constructor() {
        this.apiKey = config.elevenlabs.apiKey;
        this.baseUrl = config.elevenlabs.baseUrl;
        this.voiceId = config.elevenlabs.voiceId;
        this.model = config.elevenlabs.model;
    }

    async generateSpeech(text, callSid) {
        const startTime = Date.now();
        
        if (!this.apiKey) {
            console.log(`[${callSid}] TTS: No API key, text only`);
            return { text, audioBuffer: null };
        }

        const cleanText = text.replace(/[*_`#]/g, '').trim();
        if (!cleanText) {
            return { text, audioBuffer: null };
        }

        return new Promise((resolve) => {
            const postData = JSON.stringify({
                text: cleanText,
                model_id: this.model,
                voice_settings: {
                    stability: 0.7,
                    similarity_boost: 0.8,
                    style: 0.2,
                    use_speaker_boost: true
                },
                output_format: "mp3_44100_128"
            });

            const options = {
                hostname: this.baseUrl,
                path: `/v1/text-to-speech/${this.voiceId}/stream`,
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
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => {
                    const duration = Date.now() - startTime;
                    if (res.statusCode === 200) {
                        const audioBuffer = Buffer.concat(chunks);
                        console.log(`[${callSid}] TTS: Success ${audioBuffer.length} bytes (${duration}ms)`);
                        resolve({ text, audioBuffer, format: 'mp3', voiceId: this.voiceId });
                    } else {
                        console.log(`[${callSid}] TTS: Error ${res.statusCode}`);
                        resolve({ text, audioBuffer: null });
                    }
                });
            });

            req.on('error', (error) => {
                console.log(`[${callSid}] TTS: Error`, error.message);
                resolve({ text, audioBuffer: null });
            });

            req.setTimeout(12000, () => {
                req.destroy();
                resolve({ text, audioBuffer: null });
            });

            req.write(postData);
            req.end();
        });
    }
}

class PushToTalkSession {
    constructor(callSid, gemini, deepgram, tts, ws) {
        this.callSid = callSid;
        this.gemini = gemini;
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
        
        this.sessionStats = {
            audioChunksReceived: 0,
            transcriptsReceived: 0,
            responsesGenerated: 0
        };

        console.log(`[${callSid}] Push-to-talk session initialized`);
    }

    async startRecording() {
        if (this.isRecording) {
            console.log(`[${this.callSid}] Already recording, ignoring start request`);
            return;
        }

        this.handleInterrupt();

        this.isRecording = true;
        this.currentTranscripts = [];
        this.accumulatedTranscript = '';
        
        console.log(`[${this.callSid}] 🔴 Recording started`);

        this.setupDeepgramConnection();

        this.sendToClient({
            type: 'recording_started',
            timestamp: Date.now()
        });
    }

    stopRecording() {
        if (!this.isRecording) {
            return;
        }

        this.isRecording = false;
        console.log(`[${this.callSid}] ⏹️ Recording stopped`);

        if (this.deepgramConnection) {
            this.deepgram.closeStreamingConnection(this.callSid);
            this.deepgramConnection = null;
        }

        if (this.accumulatedTranscript.trim()) {
            this.generateFinalResponse();
        }

        this.sendToClient({
            type: 'recording_stopped',
            timestamp: Date.now(),
            finalTranscript: this.accumulatedTranscript
        });
    }

    setupDeepgramConnection() {
        this.deepgramConnection = this.deepgram.createStreamingConnection(
            this.callSid,
            (transcript) => this.handleTranscript(transcript),
            (error) => {
                console.error(`[${this.callSid}] Deepgram error:`, error.message);
                
                this.sendToClient({
                    type: 'transcription_error',
                    error: `Transcription error: ${error.message}`,
                    timestamp: Date.now()
                });
                
                console.log(`[${this.callSid}] Switching to mock transcription mode`);
                this.deepgramFailed = true;
            }
        );
        
        setTimeout(() => {
            if (this.deepgramConnection && !this.deepgramFailed) {
                console.log(`[${this.callSid}] Deepgram connection setup complete`);
            }
        }, 1000);
    }

    addAudioData(audioBuffer) {
        if (!this.isRecording) {
            return;
        }

        this.sessionStats.audioChunksReceived++;
        
        if (this.deepgramConnection && !this.deepgramFailed) {
            const success = this.deepgram.sendAudio(this.callSid, audioBuffer);
            if (!success) {
                console.warn(`[${this.callSid}] Failed to send audio to Deepgram`);
            }
        }

        this.sendToClient({
            type: 'audio_chunk_processed',
            chunkSize: audioBuffer.length,
            timestamp: Date.now()
        });
    }

    async handleTranscript(transcript) {
        if (!transcript.text || !transcript.text.trim()) return;

        this.sessionStats.transcriptsReceived++;
        console.log(`[${this.callSid}] 📝 Transcript: "${transcript.text}" (final: ${transcript.is_final})`);

        this.sendToClient({
            type: 'transcript',
            text: transcript.text,
            is_final: transcript.is_final,
            confidence: transcript.confidence,
            timestamp: Date.now()
        });

        if (transcript.is_final) {
            this.currentTranscripts.push(transcript.text);
            this.accumulatedTranscript = this.currentTranscripts.join(' ');
        }

        if (this.isRecording && transcript.text.trim()) {
            await this.sendToLLMStreaming(transcript.text, transcript.is_final);
        }
    }

    async sendToLLMStreaming(transcriptText, isComplete) {
        try {
            const response = await this.gemini.generateStreamingResponse(
                this.conversationHistory,
                transcriptText,
                isComplete,
                this.callSid
            );

            if (!isComplete && response.length < 50) {
                this.sendToClient({
                    type: 'llm_acknowledgment',
                    text: response,
                    isPartial: true,
                    timestamp: Date.now()
                });
            }
        } catch (error) {
            console.error(`[${this.callSid}] Error in streaming LLM call:`, error);
        }
    }

    async generateFinalResponse() {
        if (this.isProcessing || !this.accumulatedTranscript.trim()) {
            return;
        }

        this.isProcessing = true;
        this.sessionStats.responsesGenerated++;

        console.log(`[${this.callSid}] 🤖 Generating final response for: "${this.accumulatedTranscript}"`);

        this.sendToClient({
            type: 'processing_started',
            userText: this.accumulatedTranscript,
            timestamp: Date.now()
        });

        try {
            const response = await this.gemini.generateStreamingResponse(
                this.conversationHistory,
                this.accumulatedTranscript,
                true,
                this.callSid
            );

            console.log(`[${this.callSid}] ✅ Final response: "${response}"`);

            const ttsResult = await this.tts.generateSpeech(response, this.callSid);

            this.conversationHistory.push({
                userText: this.accumulatedTranscript,
                response: response,
                timestamp: Date.now()
            });

            if (this.conversationHistory.length > 8) {
                this.conversationHistory = this.conversationHistory.slice(-6);
            }

            this.sendToClient({
                type: 'ai_response',
                text: response,
                userText: this.accumulatedTranscript,
                hasAudio: !!ttsResult.audioBuffer,
                audioData: ttsResult.audioBuffer ? ttsResult.audioBuffer.toString('base64') : null,
                audioFormat: ttsResult.format || 'mp3',
                timestamp: Date.now()
            });

            if (ttsResult.audioBuffer) {
                this.isPlayingAudio = true;
                const wordCount = response.split(' ').length;
                const estimatedDuration = Math.max(wordCount * 600, 2000);
                
                setTimeout(() => {
                    this.isPlayingAudio = false;
                    console.log(`[${this.callSid}] 🔇 Audio playback finished`);
                }, estimatedDuration);
            }

        } catch (error) {
            console.error(`[${this.callSid}] Error generating final response:`, error);
            
            const fallbackResponse = "I understand. How else can I help you?";
            this.sendToClient({
                type: 'ai_response',
                text: fallbackResponse,
                userText: this.accumulatedTranscript,
                hasAudio: false,
                timestamp: Date.now(),
                isFallback: true
            });
        } finally {
            this.isProcessing = false;
        }
    }

    handleInterrupt() {
        console.log(`[${this.callSid}] 🛑 Interrupt detected - stopping all processing`);
        
        this.isProcessing = false;
        this.isPlayingAudio = false;
        this.currentTranscripts = [];
        this.accumulatedTranscript = '';
        
        this.sendToClient({
            type: 'interrupt',
            timestamp: Date.now()
        });
    }

    sendToClient(message) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify(message));
            } catch (error) {
                console.error(`[${this.callSid}] Error sending to client:`, error);
            }
        }
    }

    getSessionStats() {
        return {
            callSid: this.callSid,
            isRecording: this.isRecording,
            isProcessing: this.isProcessing,
            isPlayingAudio: this.isPlayingAudio,
            conversationLength: this.conversationHistory.length,
            currentTranscriptLength: this.accumulatedTranscript.length,
            ...this.sessionStats
        };
    }

    cleanup() {
        if (this.deepgramConnection) {
            this.deepgram.closeStreamingConnection(this.callSid);
        }
        
        const stats = this.getSessionStats();
        console.log(`[${this.callSid}] Session cleanup:`, JSON.stringify(stats, null, 2));
    }
}

class LiveCallGateway {
    constructor() {
        this.sessions = new Map();
        this.gemini = new GeminiStreamingClient();
        this.deepgram = new DeepgramStreamingASR();
        this.tts = new ElevenLabsTTS();
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
            const uptime = Date.now() - this.serverStats.startTime;
            res.json({
                status: 'healthy',
                uptime: uptime,
                activeSessions: this.sessions.size,
                serverStats: this.serverStats,
                timestamp: new Date().toISOString(),
                mode: 'push-to-talk'
            });
        });

        this.httpServer = http.createServer(app);
        this.wss = new WebSocket.Server({ 
            server: this.httpServer,
            perMessageDeflate: false
        });

        this.httpServer.listen(config.port, () => {
            console.log(`🚀 Push-to-Talk Voice Server running on port ${config.port}`);
            console.log(`Access: http://localhost:${config.port}`);
        });

        this.wss.on('connection', this.handleConnection.bind(this));
        console.log(`\n🎙️ Push-to-Talk Voice Chat Server Ready`);
        console.log(` ElevenLabs TTS: ${config.elevenlabs.apiKey ? '✅ Enabled' : '⚠️  Text-only mode'}`);
        console.log(` Deepgram ASR: ${config.mock.deepgram ? '🎭 Mock Mode' : (config.deepgram.apiKey ? '✅ Live Mode' : '⚠️  Mock fallback')}`);
        console.log(` Gemini LLM: ${config.mock.llm ? '🎭 Mock Mode' : (config.gemini.apiKey ? '✅ Live Mode' : '⚠️  Fallback responses')}`);
        if (config.mock.deepgram || config.mock.llm) {
            console.log(`\n🎭 MOCK MODES ACTIVE - Set MOCK_DEEPGRAM=false and MOCK_LLM=false in .env to use real APIs`);
        }
    }

    handleConnection(ws, req) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const callSid = url.searchParams.get('callSid') || uuidv4();
        ws.callSid = callSid;

        this.serverStats.totalSessions++;
        this.serverStats.activeSessions++;

        console.log(`[${callSid}] New push-to-talk connection - Total: ${this.serverStats.totalSessions}`);

        const session = new PushToTalkSession(
            callSid,
            this.gemini,
            this.deepgram,
            this.tts,
            ws
        );

        this.sessions.set(callSid, session);

        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data);
                
                switch (message.type) {
                    case 'start_recording':
                        session.startRecording();
                        break;
                        
                    case 'stop_recording':
                        session.stopRecording();
                        break;
                        
                    case 'audio_chunk':
                        if (message.audioData) {
                            const audioBuffer = Buffer.from(message.audioData, 'base64');
                            session.addAudioData(audioBuffer);
                            this.serverStats.totalAudioChunks++;
                        }
                        break;
                        
                    case 'ping':
                        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
                        break;
                        
                    default:
                        console.log(`[${callSid}] Unknown message type: ${message.type}`);
                }
            } catch (error) {
                console.error(`[${callSid}] Message parsing error:`, error);
            }
        });

        ws.on('close', () => {
            console.log(`[${callSid}] Connection closed`);
            session.cleanup();
            this.sessions.delete(callSid);
            this.serverStats.activeSessions--;
        });

        ws.on('error', (error) => {
            console.error(`[${callSid}] WebSocket error:`, error);
            session.cleanup();
            this.sessions.delete(callSid);
            this.serverStats.activeSessions--;
        });

        ws.send(JSON.stringify({
            type: 'ready',
            callSid: callSid,
            timestamp: Date.now(),
            serverVersion: '3.0.0-push-to-talk',
            mode: 'push-to-talk'
        }));
    }

    async stop() {
        console.log('Shutting down push-to-talk server...');
        
        this.deepgram.cleanup();

        if (this.wss) {
            this.wss.clients.forEach(client => client.close());
            await new Promise(resolve => this.wss.close(resolve));
        }

        if (this.httpServer) {
            await new Promise(resolve => this.httpServer.close(resolve));
        }

        for (const [callSid, session] of this.sessions) {
            session.cleanup();
        }
        this.sessions.clear();
        
        console.log('Push-to-talk server shutdown complete');
    }
}

const gateway = new LiveCallGateway();

const shutdown = () => {
    console.log('Received shutdown signal...');
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
    console.error('Failed to start push-to-talk server:', error);
    process.exit(1);
});