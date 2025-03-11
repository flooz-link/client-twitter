/**
 * Deepgram WebSocket Transcription Server Example
 *
 * This server receives audio from clients via WebSockets,
 * sends it to Deepgram for real-time transcription,
 * and returns the transcription results back to the client.
 */

import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import {
  createClient,
  LiveTranscriptionEvents,
  LiveClient,
} from '@deepgram/sdk';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { AddressInfo } from 'net';
import { SttTtsPlugin } from '../src/plugins/DeepgramStreamingClient.js';

// Get the directory name of the current module (ES modules don't have __dirname)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from .env file in the examples directory
dotenv.config({ path: join(__dirname, '.env') });

// Check for required API key
if (!process.env.DEEPGRAM_API_KEY) {
  console.error('Error: DEEPGRAM_API_KEY environment variable is required');
  console.error(`Looked for .env file at: ${join(__dirname, '.env')}`);
  process.exit(1);
}

// Initialize Express app and HTTP server
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Create Deepgram client
const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);
let keepAlive: NodeJS.Timeout | undefined;

// Create mocks for SttTtsPlugin dependencies
// Mock IAgentRuntime
const mockRuntime = {
  getSetting: (key: string) => {
    if (key === 'DEEPGRAM_API_KEY') return process.env.DEEPGRAM_API_KEY;
    if (key === 'GROK_API_KEY') return 'mock-grok-api-key';
    if (key === 'GROK_BASE_URL') return 'https://api.x.ai/v1';
    return null;
  },
  // Add other required methods as needed
  log: console.log,
  error: console.error,
};

// Mock ClientBase
const mockClient = {
  // Add required methods and properties
};

// Mock Space
const mockSpace = {
  // Add required methods and properties
  janusClient: {
    // Mock Janus client methods
    sendAudio: (_audioData: any) => {
      console.log('Mock Janus: Sending audio data');
    },
  },
};

// Generate a random spaceId
const mockSpaceId = 'space-' + Math.random().toString(36).substring(2, 15);

// Initialize SttTtsPlugin with mocks
const sttTtsPlugin = new SttTtsPlugin();
sttTtsPlugin.init({
  space: mockSpace as any,
  pluginConfig: {
    runtime: mockRuntime,
    client: mockClient,
    spaceId: mockSpaceId,
    deepgramApiKey: process.env.DEEPGRAM_API_KEY,
    grokApiKey: process.env.GROK_API_KEY,
    grokBaseUrl: 'https://api.x.ai/v1',
  },
});

/**
 * Sets up a Deepgram live transcription connection
 * @param ws WebSocket connection to the client
 * @returns Configured Deepgram live transcription client
 */
const setupDeepgram = (ws: WebSocket): LiveClient => {
  // Initialize Deepgram with desired options
  const deepgram = deepgramClient.listen.live({
    language: 'en',
    punctuate: true,
    smart_format: true,
    model: 'nova',
  });

  // Setup keepalive to maintain the connection
  if (keepAlive) clearInterval(keepAlive);
  keepAlive = setInterval(() => {
    console.log('deepgram: keepalive');
    deepgram.keepAlive();
  }, 10 * 1000);

  // Set up event listeners for Deepgram connection
  deepgram.addListener(LiveTranscriptionEvents.Open, async () => {
    console.log('deepgram: connected');

    // Handle transcription events
    deepgram.addListener(LiveTranscriptionEvents.Transcript, (data) => {
      console.log('deepgram: packet received');

      // Check if there's a transcript with speech
      if (data.channel?.alternatives?.[0]?.transcript) {
        const transcript = data.channel.alternatives[0].transcript;
        console.log(`deepgram: transcript="${transcript}"`);

        // Send the transcript back to the client
        ws.send(JSON.stringify({ transcript }));
      }
    });

    // Handle connection close
    deepgram.addListener(LiveTranscriptionEvents.Close, () => {
      console.log('deepgram: disconnected');
      if (keepAlive) clearInterval(keepAlive);
    });

    // Handle errors
    deepgram.addListener('warning', (warning) => {
      console.log(`deepgram: warning - ${warning}`);
    });

    deepgram.addListener(LiveTranscriptionEvents.Error, (error) => {
      console.error(`deepgram: error - ${error}`);
    });

    // Notify the client that we're ready to receive audio
    ws.send(JSON.stringify({ status: 'ready' }));
  });

  return deepgram;
};

// Handle WebSocket connections
wss.on('connection', (ws: WebSocket) => {
  console.log('socket: client connected');
  let deepgram = setupDeepgram(ws);

  // Handle messages from client (audio data)
  ws.on('message', (message) => {
    console.log('socket: client data received');

    if (deepgram.getReadyState() === 1 /* OPEN */) {
      console.log('socket: data sent to deepgram');
      // Convert the message to a format Deepgram can accept
      let socketData: any;

      if (Buffer.isBuffer(message)) {
        socketData = message;
      } else if (message instanceof ArrayBuffer) {
        socketData = Buffer.from(new Uint8Array(message));
      } else if (ArrayBuffer.isView(message)) {
        socketData = Buffer.from(message.buffer);
      } else if (Array.isArray(message)) {
        // Handle array of buffers case
        const totalLength = message.reduce((acc, buf) => acc + buf.length, 0);
        socketData = Buffer.concat(message, totalLength);
      } else {
        console.error('socket: unsupported message type', typeof message);
        return;
      }

      // Use type assertion to bypass TypeScript's type checking
      deepgram.send(socketData as any);
    } else if (deepgram.getReadyState() >= 2 /* 2 = CLOSING, 3 = CLOSED */) {
      console.log("socket: data couldn't be sent to deepgram");
      console.log('socket: retrying connection to deepgram');
      /* Attempt to reopen the Deepgram connection */
      deepgram.finish();
      deepgram.removeAllListeners();
      deepgram = setupDeepgram(ws);
    } else {
      console.log("socket: data couldn't be sent to deepgram");
    }
  });

  // Handle WebSocket close
  ws.on('close', () => {
    console.log('socket: client disconnected');
    if (deepgram) {
      deepgram.finish();
      deepgram.removeAllListeners();
    }
    if (keepAlive) clearInterval(keepAlive);
  });
});

// Serve static files from the public directory
app.use(express.static(join(__dirname, 'public')));

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  const address = server.address() as AddressInfo;
  console.log(`Server listening on port ${address.port}`);
});
