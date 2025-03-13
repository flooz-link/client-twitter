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
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { AddressInfo } from 'net';
import {
  createClient,
  LiveTranscriptionEvents,
  SOCKET_STATES,
} from '@deepgram/sdk';
import { SttTtsPlugin } from '../src/plugins/DeepgramStreamingClient.js';
import { MockSpace } from './mock-space.js';
import { MockJanusClient } from './mock-janus-client.js';
import { DeepgramStreamingTranscriptionService } from '../src/transcription/deepgramDefaultTranscription.js';
import { ElevenLabsTTSService } from '../src/tts/elevelabsTts.js';

// Get the directory name of the current module (ES modules don't have __dirname)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from .env file
dotenv.config();

// Create Express app
const app = express();

// Serve static files from the public directory
app.use(express.static(join(__dirname, 'public')));

// Create HTTP server
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const SHOULD_DEBUG_TRANSCRIPTION = false;

// Initialize Deepgram
const deepgramApiKey = process.env.DEEPGRAM_API_KEY || '';
console.log(
  'Initializing Deepgram with API key:',
  deepgramApiKey ? 'API key found' : 'No API key found',
);

const mockedRuntime = {
  agentId: 'mock-agent',
  character: {
    name: 'test',
  },
  getSetting: (key: string) => {
    if (key === 'DEEPGRAM_API_KEY') return deepgramApiKey;
    if (key === 'GROK_API_KEY') return process.env.GROK_API_KEY || '';
    if (key === 'GROK_BASE_URL')
      return process.env.GROK_BASE_URL || 'https://api.x.ai/v1';
    return '';
  },
  composeState: async () => ({
    /* mock state */
  }),
  ensureUserExists: async () => ({}),
  ensureRoomExists: async () => ({}),
  ensureParticipantInRoom: async () => ({}),
  processActions: async () => ({}),
};

// Create our mock Janus client set to true if you have issues with audio
// in those cases you will hear a beeping noise
const mockJanusClient = new MockJanusClient(false);

// Then create our mock Space with this Janus client
const mockSpace = new MockSpace(mockJanusClient);

// Create and initialize the SttTtsPlugin
const sttTtsPlugin = new SttTtsPlugin();

const transcriptionService = new DeepgramStreamingTranscriptionService({
  apiKey: deepgramApiKey,
  model: 'nova-3',
  sample_rate: 48000,
  language: 'en',
  channels: 1,
  encoding: 'linear16',
  vadEvents: true,
  interimResults: true,
  endpointing: 200,
});

const ttsService = new ElevenLabsTTSService({
  apiKey: process.env.ELEVEN_LABS_API_KEY || '',
});
// Register the plugin with the mock Space
mockSpace.use(sttTtsPlugin as any);

// Initialize the plugin properly
sttTtsPlugin.init({
  space: mockSpace as any, // Type assertion might be needed if there are incompatibilities
  pluginConfig: {
    runtime: mockedRuntime,
    transcriptionService: transcriptionService,
    ttsService: ttsService,
    client: { profile: { username: 'user', id: 'mock-user-id' } },
    spaceId: 'mock-space-id',
    deepgramApiKey,
    user: { id: 'bot-id', username: 'bot' },
  },
});

/**
 * Process audio data to make it suitable
 * for Deepgram's encoding requirement
 */
async function processAudioData(
  data: Buffer | ArrayBuffer,
): Promise<Uint8Array> {
  try {
    // Convert Buffer to Uint8Array if needed
    const audioData = Buffer.isBuffer(data)
      ? new Uint8Array(data)
      : new Uint8Array(data);

    // Check for WebM header (starts with 0x1A 0x45 0xDF 0xA3)
    const isWebM =
      audioData.length > 4 &&
      audioData[0] === 0x1a &&
      audioData[1] === 0x45 &&
      audioData[2] === 0xdf &&
      audioData[3] === 0xa3;

    if (isWebM) {
      console.log('WebM format detected - skipping unsupported format');
      return new Uint8Array(0); // Return empty array to skip
    }

    // For content-type with audio/l16, treat as raw int16 PCM data
    if (audioData.length > 0) {
      return audioData;
    }

    return audioData;
  } catch (error) {
    console.error('Error processing audio data:', error);
    return new Uint8Array(data);
  }
}

// This is super useful if you have to debug issues related to audio input and transcription
const setupDeepgramForEncoding = () => {
  if (SHOULD_DEBUG_TRANSCRIPTION === false) {
    return;
  }
  // Create a new Deepgram client
  const dgClient = createClient(deepgramApiKey);

  // Create a live transcription connection with more sensitive settings
  // Use only officially supported parameters
  const deepgramLive = dgClient.listen.live({
    language: 'en',
    punctuate: true,
    smart_format: true,
    model: 'nova-3',
    encoding: 'linear16', // Always use linear16
    sample_rate: 48000,
    channels: 1,
    interim_results: true,
    utterance_end_ms: 2000,
    endpointing: 400,
  });

  setInterval(() => {
    if (deepgramLive?.getReadyState() === SOCKET_STATES.open) {
      deepgramLive.send(new Uint8Array(0));
    }
  }, 5000);

  // Set up keepalive interval to prevent connection timeouts
  setInterval(() => {
    if (deepgramLive?.getReadyState() === SOCKET_STATES.open) {
      console.log('deepgram: keepalive');
    }
  }, 5000);

  // Track utterance boundaries for state reset

  // Add event listeners to the Deepgram client
  deepgramLive.addListener(LiveTranscriptionEvents.Open, () => {
    console.log('deepgram: connected successfully');
    // Send connection status to client
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(
          JSON.stringify({ status: 'connected', ready: true }, null, 2),
        );
      }
    });
  });

  deepgramLive.addListener(LiveTranscriptionEvents.Error, (error) => {
    console.error(`deepgram: error: ${error.reason()}`);
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(
          JSON.stringify(
            {
              type: 'error',
              message: error instanceof Error ? error.message : String(error),
            },
            null,
            2,
          ),
        );
      }
    });
  });

  deepgramLive.addListener(LiveTranscriptionEvents.Close, (event) => {
    console.log(`deepgram: disconnected ${event}`);
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ status: 'disconnected' }, null, 2));
      }
    });
  });

  deepgramLive.addListener(LiveTranscriptionEvents.Transcript, (data) => {
    const transcript = data.channel?.alternatives?.[0]?.transcript || '';
    const is_final = data.is_final === true;

    // Log detailed information about the transcript for debugging
    console.log(
      '[DEBUG] Deepgram transcript event received:',
      JSON.stringify(
        {
          transcript,
          is_final,
          channel_alternatives: data.channel?.alternatives?.map((alt) => ({
            transcript_length: alt.transcript?.length || 0,
            transcript: alt.transcript,
          })),
        },
        null,
        2,
      ),
    );

    if (transcript && transcript.length > 0) {
      // Send all alternatives to client to improve accuracy
      const alternatives =
        data.channel?.alternatives
          ?.map((alt) => alt.transcript)
          .filter(Boolean) || [];

      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(
            JSON.stringify(
              {
                type: 'transcript',
                transcript,
                alternatives,
                is_final,
              },
              null,
              2,
            ),
          );
        }
      });
    } else {
      console.log(
        '[WARNING] Empty transcript received from Deepgram',
        JSON.stringify(data, null, 2),
      );
    }
  });

  return deepgramLive;
};

// Handle WebSocket connections
wss.on('connection', (ws: WebSocket) => {
  console.log('socket: client connected');

  // Register this client to receive TTS audio from the plugin
  mockJanusClient.addClient(ws); // This line is essential!

  // Initial setup with linear16 encoding
  let deepgramLive = setupDeepgramForEncoding();

  // Handle messages from the client
  ws.on('message', async (message: WebSocket.Data) => {
    try {
      // Process the audio data
      const processedData = await processAudioData(message as Buffer);

      if (SHOULD_DEBUG_TRANSCRIPTION === false) {
        const pcmData = new Int16Array(processedData.buffer);

        // Route the audio to the SttTtsPlugin
        sttTtsPlugin.onAudioData({
          userId: 'user-1', // Use a consistent user ID
          samples: pcmData,
          sampleRate: 48000,
          bitsPerSample: 16,
          channelCount: 1,
          numberOfFrames: pcmData.length,
        });
      } else {
        if (
          !deepgramLive ||
          deepgramLive.getReadyState() !== SOCKET_STATES.open
        ) {
          console.log(
            'socket: Deepgram connection is not open, reconnecting...',
          );
          deepgramLive = setupDeepgramForEncoding(); // Always use linear16
          return;
        }

        // Ensure processed data is valid before sending
        if (processedData && processedData.length > 0) {
          console.log(
            `Sending ${processedData.length} bytes to Deepgram with encoding: linear16`,
          );
          deepgramLive.send(processedData);
        } else {
          console.log(
            `Processed data is empty or invalid, not sending to Deepgram.`,
          );
        }
      }
    } catch (error) {
      console.error('Error handling message:', error);
    }
  });

  // Handle client disconnection
  ws.on('close', () => {
    console.log('socket: client disconnected');

    // Close the Deepgram connection when the client disconnects
    if (deepgramLive) {
      try {
        deepgramLive.finish();
      } catch (error) {
        console.error('Error closing Deepgram connection:', error);
      }
    }
  });
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  const address = server.address() as AddressInfo;
  console.log(`http://localhost:${address.port}`);
});
