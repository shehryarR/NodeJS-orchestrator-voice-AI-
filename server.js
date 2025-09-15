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
    useHttps: process.env.USE_HTTPS === 'true' || true,
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
    chunkDuration: 2000,
    silenceThreshold: 1000,
    maxChunkBuffer: 10,
    // VAD Configuration
    vad: {
        voiceThreshold: 0.004,           // RMS energy threshold for voice detection
        peakThreshold: 0.002,            // Peak amplitude threshold
        minSilentChunksForResponse: 3,   // Chunks of silence needed to trigger response
        voiceActivityBufferSize: 10      // Number of recent chunks to track
    }
};

class DeepgramStreamingASR {
    constructor() {
        this.apiKey = config.deepgram.apiKey;
        this.client = this.apiKey ? createClient(this.apiKey) : null;
        this.activeConnections = new Map();
        this.currentModel = config.deepgram.currentModel;
        
        console.log(`Deepgram ASR initialized with streaming model: ${this.currentModel}`);
    }

    createStreamingConnection(callSid, onTranscript, onError) {
        if (!this.client) {
            console.log(`[${callSid}] ASR: No API key, using mock connection`);
            return null;
        }

        try {
            console.log(`[${callSid}] Creating Deepgram streaming connection with model: ${this.currentModel}`);
            
            const connectionOptions = {
                model: this.currentModel,
                language: config.deepgram.language,
                encoding: 'linear16',
                sample_rate: 16000,
                channels: 1,
                smart_format: true,
                interim_results: true,
                utterance_end_ms: 1000,
                vad_events: true,
                endpointing: 300
            };

            const connection = this.client.listen.live(connectionOptions);
            let connectionEstablished = false;
            let connectionTimeout;

            connectionTimeout = setTimeout(() => {
                if (!connectionEstablished) {
                    console.error(`[${callSid}] Connection timeout - failed to establish in 10 seconds`);
                    connection.finish();
                }
            }, 10000);

            connection.on('open', () => {
                connectionEstablished = true;
                clearTimeout(connectionTimeout);
                console.log(`[${callSid}] Deepgram streaming connection opened successfully`);
            });

            connection.on('transcript', (data) => {
                try {
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
                } catch (error) {
                    console.error(`[${callSid}] Error processing transcript:`, error);
                }
            });

            connection.on('error', (error) => {
                console.error(`[${callSid}] Deepgram streaming error:`, error.message || 'Unknown error');
                clearTimeout(connectionTimeout);
                
                if (!connectionEstablished) {
                    setTimeout(() => onError(error), 1000);
                }
            });

            connection.on('close', (event) => {
                console.log(`[${callSid}] Deepgram streaming connection closed`);
                clearTimeout(connectionTimeout);
                this.activeConnections.delete(callSid);
            });

            connection.on('metadata', (data) => {
                console.log(`[${callSid}] Deepgram metadata:`, data);
            });

            this.activeConnections.set(callSid, connection);
            return connection;

        } catch (error) {
            console.error(`[${callSid}] Failed to create Deepgram streaming connection:`, error);
            return null;
        }
    }

    sendAudio(callSid, audioBuffer) {
        const connection = this.activeConnections.get(callSid);
        if (!connection) {
            return false;
        }

        try {
            const readyState = connection.getReadyState();
            if (readyState === 1) {
                connection.send(audioBuffer);
                return true;
            } else {
                console.warn(`[${callSid}] Connection not ready (state: ${readyState})`);
                return false;
            }
        } catch (error) {
            console.error(`[${callSid}] Error sending audio to Deepgram:`, error);
            return false;
        }
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
        this.systemPrompt = `You are an AI assistant in a live voice conversation. You're receiving chunks of speech in real-time.
IMPORTANT BEHAVIOR:
- Keep responses EXTREMELY SHORT (1-2 sentences max)
- Be conversational and natural for speech
- Respond based on the cumulative context but focus on the latest input
- If input seems incomplete, ask for clarification briefly
- NO technical jargon or complex explanations
- SOUND natural when converted to speech
- NO markdown, lists, or written-style formatting
This is real-time conversation - be concise, helpful, and conversational.`;
    }

    async generateStreamingResponse(conversationHistory, latestChunk, callSid) {
        const startTime = Date.now();
        
        if (!this.apiKey) {
            console.log(`[${callSid}] LLM: No API key, using echo (0ms)`);
            return `I hear: "${latestChunk}"`;
        }

        const messages = [
            {
                parts: [{ text: this.systemPrompt }],
                role: "user"
            },
            {
                parts: [{ text: "I understand. I'll keep responses very short and conversational for live voice chat." }],
                role: "model"
            }
        ];

        conversationHistory.forEach(item => {
            messages.push({
                parts: [{ text: `User said: "${item.text}"` }],
                role: "user"
            });
            if (item.response) {
                messages.push({
                    parts: [{ text: item.response }],
                    role: "model"
                });
            }
        });

        messages.push({
            parts: [{ text: `User just said: "${latestChunk}". Respond naturally and briefly.` }],
            role: "user"
        });

        return new Promise((resolve) => {
            const postData = JSON.stringify({
                contents: messages
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
                        console.log(`[${callSid}] LLM: "${cleanedResponse}" (${duration}ms)`);
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

            req.setTimeout(8000, () => {
                req.destroy();
                resolve("Sorry, that took too long to process.");
            });

            req.write(postData);
            req.end();
        });
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
                    stability: 0.7,
                    similarity_boost: 0.8,
                    style: 0.2,
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

            req.setTimeout(12000, () => {
                req.destroy();
                resolve({ text, audioBuffer: null });
            });

            req.write(postData);
            req.end();
        });
    }
}

class ChunkedStreamingSession {
    constructor(callSid, gemini, deepgram, tts, ws) {
        this.callSid = callSid;
        this.gemini = gemini;
        this.deepgram = deepgram;
        this.tts = tts;
        this.ws = ws;

        // Audio chunk management
        this.audioChunks = [];
        this.currentChunk = {
            audio: [],
            startTime: Date.now(),
            id: uuidv4(),
            hasVoice: false
        };

        // Voice Activity Detection
        this.voiceActivityBuffer = [];
        this.consecutiveSilentChunks = 0;
        this.minSilentChunksForResponse = config.vad.minSilentChunksForResponse;
        this.voiceThreshold = config.vad.voiceThreshold;
        this.peakThreshold = config.vad.peakThreshold;
        this.voiceActivityBufferSize = config.vad.voiceActivityBufferSize;

        // Conversation state
        this.conversationHistory = [];
        this.pendingTranscripts = new Map();
        this.isAISpeaking = false;
        this.lastSpeechTime = Date.now();
        this.silenceTimer = null;

        // Processing state
        this.processingQueue = [];
        this.isProcessingResponse = false;
        this.hasRecentSpeech = false;

        // Connection state
        this.deepgramReady = false;
        this.pendingAudioChunks = [];
        this.connectionAttempts = 0;
        this.maxConnectionAttempts = 3;

        // Metrics
        this.chunkCount = 0;
        this.voiceChunkCount = 0;
        this.silentChunkCount = 0;

        this.setupDeepgramConnection();
        this.startChunkTimer();
        
        console.log(`[${callSid}] ChunkedStreamingSession initialized with continuous VAD processing`);
        console.log(`[${callSid}] VAD Config - Voice Threshold: ${this.voiceThreshold}, Peak Threshold: ${this.peakThreshold}, Silent Chunks for Response: ${this.minSilentChunksForResponse}`);
    }

    setupDeepgramConnection() {
        this.connectionAttempts++;
        
        if (this.connectionAttempts > this.maxConnectionAttempts) {
            console.error(`[${this.callSid}] Max connection attempts reached. Continuing without Deepgram.`);
            return;
        }

        console.log(`[${this.callSid}] Setting up Deepgram connection (attempt ${this.connectionAttempts}/${this.maxConnectionAttempts})`);

        this.deepgramConnection = this.deepgram.createStreamingConnection(
            this.callSid,
            (transcript) => this.handleTranscript(transcript),
            (error) => {
                console.error(`[${this.callSid}] Deepgram error:`, error.message || 'Unknown error');
                
                if (this.connectionAttempts < this.maxConnectionAttempts) {
                    console.log(`[${this.callSid}] Will retry connection in 5 seconds...`);
                    setTimeout(() => {
                        this.setupDeepgramConnection();
                    }, 5000);
                } else {
                    console.error(`[${this.callSid}] Giving up on Deepgram connection`);
                }
            }
        );

        if (this.deepgramConnection) {
            this.deepgramConnection.on('open', () => {
                this.deepgramReady = true;
                this.connectionAttempts = 0;
                console.log(`[${this.callSid}] Deepgram ready - processing ${this.pendingAudioChunks.length} pending chunks`);
                
                this.pendingAudioChunks.forEach(chunk => {
                    this.deepgram.sendAudio(this.callSid, chunk);
                });
                this.pendingAudioChunks = [];
            });

            this.deepgramConnection.on('close', () => {
                this.deepgramReady = false;
                console.log(`[${this.callSid}] Deepgram connection closed`);
            });
        }
    }

    startChunkTimer() {
        this.chunkInterval = setInterval(() => {
            this.processCurrentChunk();
        }, config.chunkDuration);
    }

    addAudioData(audioBuffer) {
        if (this.isAISpeaking) {
            this.handleUserInterrupt();
        }

        this.currentChunk.audio.push(audioBuffer);
        this.lastSpeechTime = Date.now();

        if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
            this.silenceTimer = null;
        }
    }

    // MODIFIED: Always process chunks, even empty ones
    processCurrentChunk() {
        const combinedAudio = this.currentChunk.audio.length > 0 
            ? Buffer.concat(this.currentChunk.audio) 
            : Buffer.alloc(0);
        
        const chunkId = this.currentChunk.id;
        const hasVoice = this.detectVoiceActivity(combinedAudio);
        
        this.chunkCount++;
        if (hasVoice) {
            this.voiceChunkCount++;
        } else {
            this.silentChunkCount++;
        }

        console.log(`[${this.callSid}] Processing chunk ${this.chunkCount} (${combinedAudio.length} bytes, voice: ${hasVoice}, voice_chunks: ${this.voiceChunkCount}, silent_chunks: ${this.silentChunkCount})`);

        // Always send to Deepgram if we have audio data (even if no voice detected locally)
        if (this.deepgramReady && this.deepgramConnection && combinedAudio.length > 0) {
            this.deepgram.sendAudio(this.callSid, combinedAudio);
        } else if (combinedAudio.length > 0) {
            console.log(`[${this.callSid}] Deepgram not ready, queuing audio chunk`);
            if (this.pendingAudioChunks.length < 10) {
                this.pendingAudioChunks.push(combinedAudio);
            }
        }

        // Update voice activity tracking
        this.updateVoiceActivity(hasVoice);

        // Store chunk info for debugging
        this.pendingTranscripts.set(chunkId, {
            id: chunkId,
            audio: combinedAudio,
            transcripts: [],
            startTime: this.currentChunk.startTime,
            processed: false,
            hasVoice: hasVoice
        });

        // Reset current chunk
        this.currentChunk = {
            audio: [],
            startTime: Date.now(),
            id: uuidv4(),
            hasVoice: false
        };

        this.sendToClient({
            type: 'chunk_processing',
            chunkId: chunkId,
            timestamp: Date.now(),
            hasVoice: hasVoice,
            consecutiveSilent: this.consecutiveSilentChunks,
            chunkCount: this.chunkCount,
            voiceChunkCount: this.voiceChunkCount,
            silentChunkCount: this.silentChunkCount
        });

        // Check if we should trigger response generation
        this.checkForResponseTrigger();
    }

    // NEW: Voice Activity Detection using audio energy
    detectVoiceActivity(audioBuffer) {
        if (audioBuffer.length === 0) return false;

        const samples = new Int16Array(audioBuffer);
        let energy = 0;
        let peak = 0;

        for (let i = 0; i < samples.length; i++) {
            const sample = samples[i] / 32768.0;
            energy += sample * sample;
            peak = Math.max(peak, Math.abs(sample));
        }

        const rmsEnergy = Math.sqrt(energy / samples.length);
        
        // DEBUGGING: Log actual values to see what we're getting
        console.log(`[${this.callSid}] Audio Analysis - RMS: ${rmsEnergy.toFixed(6)}, Peak: ${peak.toFixed(6)}, Samples: ${samples.length}`);
        
        const hasVoice = rmsEnergy > this.voiceThreshold && peak > this.peakThreshold;
        
        if (hasVoice) {
            console.log(`[${this.callSid}] ✅ Voice detected - RMS: ${rmsEnergy.toFixed(4)}, Peak: ${peak.toFixed(4)}`);
        } else {
            // Show why voice wasn't detected
            const rmsCheck = rmsEnergy > this.voiceThreshold;
            const peakCheck = peak > this.peakThreshold;
            console.log(`[${this.callSid}] ❌ No voice - RMS check: ${rmsCheck} (${rmsEnergy.toFixed(6)} > ${this.voiceThreshold}), Peak check: ${peakCheck} (${peak.toFixed(6)} > ${this.peakThreshold})`);
        }

        return hasVoice;
    }

    // NEW: Update voice activity state and silence tracking
    updateVoiceActivity(hasVoice) {
        this.voiceActivityBuffer.push(hasVoice);
        
        // Keep only recent activity
        if (this.voiceActivityBuffer.length > this.voiceActivityBufferSize) {
            this.voiceActivityBuffer.shift();
        }

        if (hasVoice) {
            this.consecutiveSilentChunks = 0;
            this.lastSpeechTime = Date.now();
            this.hasRecentSpeech = true;
            console.log(`[${this.callSid}] Voice activity detected - resetting silence counter`);
        } else {
            this.consecutiveSilentChunks++;
        }

        console.log(`[${this.callSid}] Voice activity - Current: ${hasVoice}, Consecutive silent: ${this.consecutiveSilentChunks}/${this.minSilentChunksForResponse}, Recent speech: ${this.hasRecentSpeech}`);
    }

    // NEW: Check if we should trigger response generation
    checkForResponseTrigger() {
        // Only trigger if:
        // 1. We have recent speech to process
        // 2. We've had enough consecutive silent chunks
        // 3. We're not already processing a response
        // 4. AI is not currently speaking
        // 5. We have something in the processing queue
        if (this.hasRecentSpeech && 
            this.consecutiveSilentChunks >= this.minSilentChunksForResponse && 
            !this.isProcessingResponse && 
            !this.isAISpeaking &&
            this.processingQueue.length > 0) {
            
            console.log(`[${this.callSid}] 🚀 TRIGGERING RESPONSE GENERATION - ${this.consecutiveSilentChunks} silent chunks after speech, queue length: ${this.processingQueue.length}`);
            this.triggerResponseGeneration();
            this.hasRecentSpeech = false; // Reset flag
        } else {
            // Log why we're not triggering
            const reasons = [];
            if (!this.hasRecentSpeech) reasons.push('no recent speech');
            if (this.consecutiveSilentChunks < this.minSilentChunksForResponse) reasons.push(`insufficient silence (${this.consecutiveSilentChunks}/${this.minSilentChunksForResponse})`);
            if (this.isProcessingResponse) reasons.push('already processing');
            if (this.isAISpeaking) reasons.push('AI speaking');
            if (this.processingQueue.length === 0) reasons.push('empty queue');
            
            if (reasons.length > 0 && this.consecutiveSilentChunks > 0) {
                console.log(`[${this.callSid}] Not triggering response: ${reasons.join(', ')}`);
            }
        }
    }

    handleTranscript(transcript) {
        if (!transcript.text || !transcript.text.trim()) return;

        console.log(`[${this.callSid}] 📝 Transcript: "${transcript.text}" (final: ${transcript.is_final}, confidence: ${transcript.confidence})`);

        // Update last speech time when we get any transcript (interim or final)
        this.lastSpeechTime = Date.now();
        this.hasRecentSpeech = true;

        this.sendToClient({
            type: 'transcript',
            text: transcript.text,
            is_final: transcript.is_final,
            confidence: transcript.confidence,
            timestamp: Date.now()
        });

        // Only add final transcripts to conversation buffer
        if (transcript.is_final) {
            this.addToConversationBuffer(transcript.text);
            // Reset consecutive silent chunks when we get final transcript
            this.consecutiveSilentChunks = 0;
            console.log(`[${this.callSid}] Final transcript received - reset silence counter`);
        }
    }

    addToConversationBuffer(text) {
        this.processingQueue.push({
            text: text.trim(),
            timestamp: Date.now()
        });
        console.log(`[${this.callSid}] 📋 Added to conversation buffer: "${text}" (queue length: ${this.processingQueue.length})`);
    }

    async triggerResponseGeneration() {
        if (this.isProcessingResponse || this.processingQueue.length === 0) {
            return;
        }

        this.isProcessingResponse = true;
        const combinedText = this.processingQueue.map(item => item.text).join(' ');
        this.processingQueue = [];

        console.log(`[${this.callSid}] 🤖 Generating AI response for: "${combinedText}"`);

        try {
            const response = await this.gemini.generateStreamingResponse(
                this.conversationHistory,
                combinedText,
                this.callSid
            );

            console.log(`[${this.callSid}] ✅ AI response generated: "${response}"`);

            this.conversationHistory.push({
                text: combinedText,
                response: response,
                timestamp: Date.now()
            });

            if (this.conversationHistory.length > 10) {
                this.conversationHistory = this.conversationHistory.slice(-8);
            }

            const ttsResult = await this.tts.generateSpeech(response, this.callSid);

            this.sendToClient({
                type: 'ai_response',
                text: response,
                userText: combinedText,
                hasAudio: !!ttsResult.audioBuffer,
                audioData: ttsResult.audioBuffer ? ttsResult.audioBuffer.toString('base64') : null,
                audioFormat: ttsResult.format,
                timestamp: Date.now()
            });

            this.isAISpeaking = true;
            const estimatedDuration = Math.max(response.length * 80, 2000);
            setTimeout(() => {
                this.isAISpeaking = false;
                console.log(`[${this.callSid}] 🔇 AI finished speaking`);
            }, estimatedDuration);

        } catch (error) {
            console.error(`[${this.callSid}] ❌ Error generating response:`, error);
            this.sendToClient({
                type: 'error',
                error: 'Failed to generate response',
                timestamp: Date.now()
            });
        } finally {
            this.isProcessingResponse = false;
        }
    }

    handleUserInterrupt() {
        console.log(`[${this.callSid}] 🛑 User interrupt detected - stopping AI response`);
        this.isAISpeaking = false;
        this.hasRecentSpeech = true; // Mark that we have new speech
        this.consecutiveSilentChunks = 0; // Reset silence counter
        this.sendToClient({
            type: 'interrupt',
            timestamp: Date.now()
        });
    }

    sendToClient(message) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        }
    }

    cleanup() {
        if (this.chunkInterval) {
            clearInterval(this.chunkInterval);
        }
        if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
        }
        if (this.deepgramConnection) {
            this.deepgram.closeStreamingConnection(this.callSid);
        }
        console.log(`[${this.callSid}] ChunkedStreamingSession cleanup complete - Processed ${this.chunkCount} chunks (${this.voiceChunkCount} voice, ${this.silentChunkCount} silent)`);
    }
}

// Utility functions
function isPortAvailable(port) {
    return new Promise((resolve) => {
        const server = require('net').createServer();
        server.listen(port, () => {
            server.close(() => resolve(true));
        });
        server.on('error', () => resolve(false));
    });
}

async function findAvailablePort(startPort, maxAttempts = 10) {
    for (let i = 0; i < maxAttempts; i++) {
        const port = startPort + i;
        if (await isPortAvailable(port)) {
            return port;
        }
    }
    throw new Error(`No available ports found starting from ${startPort}`);
}

class LiveCallGateway {
    constructor() {
        this.eventBus = new EventEmitter();
        this.eventBus.setMaxListeners(1000);
        this.sessions = new Map();
        this.gemini = new GeminiStreamingClient();
        this.deepgram = new DeepgramStreamingASR();
        this.tts = new ElevenLabsTTS();
        this.httpServer = null;
        this.httpsServer = null;
    }

    checkSSLCertificates() {
        try {
            if (!fs.existsSync(config.sslKeyPath)) {
                console.error(`SSL private key not found at: ${config.sslKeyPath}`);
                return false;
            }
            if (fs.statSync(config.sslKeyPath).size === 0) {
                console.error(`SSL private key file is empty: ${config.sslKeyPath}`);
                return false;
            }
            if (!fs.existsSync(config.sslCertPath)) {
                console.error(`SSL certificate not found at: ${config.sslCertPath}`);
                return false;
            }
            if (fs.statSync(config.sslCertPath).size === 0) {
                console.error(`SSL certificate file is empty: ${config.sslCertPath}`);
                return false;
            }
            return true;
        } catch (error) {
            console.error('Error checking SSL certificates:', error);
            return false;
        }
    }

    async start() {
        const app = express();

        app.use((req, res, next) => {
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Frame-Options', 'DENY');
            res.setHeader('X-XSS-Protection', '1; mode=block');
            if (config.useHttps) {
                res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
            }
            next();
        });

        app.use(express.static('public'));

        app.get('/health', (req, res) => {
            res.json({
                status: 'healthy',
                activeSessions: this.sessions.size,
                protocol: config.useHttps ? 'https' : 'http',
                timestamp: new Date().toISOString(),
                services: {
                    deepgram: !!config.deepgram.apiKey,
                    gemini: !!config.gemini.apiKey,
                    elevenlabs: !!config.elevenlabs.apiKey
                },
                config: {
                    chunkDuration: config.chunkDuration,
                    silenceThreshold: config.silenceThreshold,
                    deepgramModel: config.deepgram.currentModel,
                    vad: config.vad
                }
            });
        });

        try {
            const mainPort = await findAvailablePort(config.port);
            config.port = mainPort;
            if (config.useHttps) {
                const httpRedirectPort = await findAvailablePort(config.httpPort);
                config.httpPort = httpRedirectPort;
            }
        } catch (error) {
            console.error('Failed to find available ports:', error);
            process.exit(1);
        }

        if (config.useHttps && this.checkSSLCertificates()) {
            try {
                const sslOptions = {
                    key: fs.readFileSync(config.sslKeyPath),
                    cert: fs.readFileSync(config.sslCertPath)
                };
                this.httpsServer = https.createServer(sslOptions, app);
                this.wss = new WebSocket.Server({ server: this.httpsServer });
                this.httpsServer.listen(config.port, () => {
                    console.log(`HTTPS Live Call Server with Continuous VAD running on port ${config.port}`);
                    console.log(`Access your app at: https://localhost:${config.port}`);
                });

                const httpApp = express();
                httpApp.use((req, res) => {
                    const httpsUrl = `https://${req.get('host').replace(/:\d+$/, '')}:${config.port}${req.url}`;
                    res.redirect(301, httpsUrl);
                });
                this.httpServer = http.createServer(httpApp);
                this.httpServer.listen(config.httpPort, () => {
                    console.log(`HTTP redirect server running on port ${config.httpPort} -> HTTPS:${config.port}`);
                });
            } catch (error) {
                console.error('Failed to start HTTPS server:', error);
                console.log('Falling back to HTTP server...');
                config.useHttps = false;
            }
        }

        if (!config.useHttps || !this.httpsServer) {
            this.httpServer = http.createServer(app);
            this.wss = new WebSocket.Server({ server: this.httpServer });
            this.httpServer.listen(config.port, () => {
                console.log(`HTTP Live Call Server with Continuous VAD running on port ${config.port}`);
                console.log(`Access your app at: http://localhost:${config.port}`);
                console.log(`Note: Microphone access may be limited over HTTP. Use HTTPS for best experience.`);
            });
        }

        this.wss.on('connection', this.handleConnection.bind(this));

        this.heartbeatInterval = setInterval(() => {
            this.wss.clients.forEach(ws => {
                if (!ws.isAlive) return ws.terminate();
                ws.isAlive = false;
                ws.ping();
            });
        }, 30000);

        console.log(`\nContinuous VAD Configuration:`);
        console.log(` Chunk Duration: ${config.chunkDuration}ms`);
        console.log(` Voice Threshold: ${config.vad.voiceThreshold}`);
        console.log(` Peak Threshold: ${config.vad.peakThreshold}`);
        console.log(` Silent Chunks for Response: ${config.vad.minSilentChunksForResponse}`);
        console.log(` Voice Activity Buffer Size: ${config.vad.voiceActivityBufferSize}`);
        console.log(`\nService Status:`);
        console.log(` ElevenLabs TTS: ${config.elevenlabs.apiKey ? 'Enabled' : 'Disabled'}`);
        console.log(` Deepgram ASR: ${config.deepgram.apiKey ? 'Enabled' : 'Disabled'}`);
        console.log(` Gemini LLM: ${config.gemini.apiKey ? 'Enabled' : 'Disabled'}`);
        console.log(` Deepgram Model: ${config.deepgram.currentModel}`);
    }

    handleConnection(ws, req) {
        const url = new URL(req.url, `${config.useHttps ? 'https' : 'http'}://${req.headers.host}`);
        const callSid = url.searchParams.get('callSid') || uuidv4();
        ws.callSid = callSid;
        ws.isAlive = true;

        console.log(`[${callSid}] New continuous VAD streaming connection (${config.useHttps ? 'HTTPS' : 'HTTP'})`);

        // Create chunked streaming session with VAD
        const session = new ChunkedStreamingSession(
            callSid,
            this.gemini,
            this.deepgram,
            this.tts,
            ws
        );

        this.sessions.set(callSid, session);

        ws.on('pong', () => ws.isAlive = true);

        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data);
                if (message.type === 'audio_chunk') {
                    // Convert base64 audio data to buffer and add to session
                    const audioBuffer = Buffer.from(message.audioData, 'base64');
                    session.addAudioData(audioBuffer);
                }
            } catch (error) {
                console.error(`[${callSid}] Message parsing error:`, error);
            }
        });

        ws.on('close', () => {
            console.log(`[${callSid}] Continuous VAD streaming connection closed`);
            session.cleanup();
            this.sessions.delete(callSid);
        });

        ws.on('error', (error) => {
            console.error(`[${callSid}] WebSocket error:`, error);
            session.cleanup();
            this.sessions.delete(callSid);
        });

        // Send ready signal with VAD configuration
        ws.send(JSON.stringify({
            type: 'ready',
            callSid: callSid,
            chunkDuration: config.chunkDuration,
            silenceThreshold: config.silenceThreshold,
            vadConfig: config.vad,
            timestamp: Date.now(),
            secure: config.useHttps
        }));
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

        if (this.httpsServer) {
            await new Promise(resolve => this.httpsServer.close(resolve));
        }

        if (this.httpServer) {
            await new Promise(resolve => this.httpServer.close(resolve));
        }

        // Cleanup all sessions
        for (const [callSid, session] of this.sessions) {
            session.cleanup();
        }
        this.sessions.clear();
        this.eventBus.removeAllListeners();
    }
}

// Initialize and start the server
const gateway = new LiveCallGateway();

const shutdown = () => {
    console.log('Shutting down continuous VAD streaming server...');
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