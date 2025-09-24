import WebSocket from 'ws';
import fs from 'fs';
import { decode } from 'wav-decoder';

const ws = new WebSocket('ws://localhost:8080');

function sendFloat32Chunk(ws, float32Array) {
    const byteBuffer = Buffer.from(float32Array.buffer);
    const lengthBuf = Buffer.alloc(4);
    lengthBuf.writeUInt32LE(byteBuffer.length, 0);
    ws.send(Buffer.concat([lengthBuf, byteBuffer]));
}

ws.on('open', async () => {
    console.log('Connected to server');

    const buffer = fs.readFileSync('audio/moshi_speech_20250923_232801.wav');
    const decoded = await decode(buffer);

    const chunkSize = 48000; // 1 second @48kHz
    for (let i = 0; i < decoded.channelData[0].length; i += chunkSize) {
        const chunk = decoded.channelData[0].slice(i, i + chunkSize);
        sendFloat32Chunk(ws, new Float32Array(chunk));
    }
});

ws.on('message', (msg) => {
    console.log('Partial transcription:', msg.toString());
});
