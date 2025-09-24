import WebSocket, { WebSocketServer } from 'ws';
import { spawn } from 'child_process';
import dotenv from 'dotenv';

dotenv.config();

const PORT = Number(process.env.STT_PORT) || 8080;
const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (ws) => {
    console.log('Client connected');

    const py = spawn('python', ['stt_engine.py'], { stdio: ['pipe', 'pipe', 'inherit'] });

    py.stdout.on('data', (data) => {
        if (ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(data.toString());
            } catch (err) {
                console.error('WebSocket send failed:', err);
            }
        }
    });

    ws.on('message', (message) => {
        if (!py.killed) {
            py.stdin.write(message);
        }
    });

    ws.on('close', () => {
        if (!py.killed) {
            py.stdin.end();
            py.kill('SIGINT');
        }
        console.log('Client disconnected');
    });

    py.on('error', (err) => console.error('Python process error:', err));
    ws.on('error', (err) => console.error('WebSocket error:', err));
});

console.log(`WebSocket server running on ws://localhost:${PORT}`);
