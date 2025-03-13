import { WebSocket } from 'ws';

export interface JanusClient {
  pushLocalAudio(frame: Int16Array, sampleRate: number): void;
}

export class MockJanusClient implements JanusClient {
  private clients: Set<WebSocket> = new Set();
  private testToneGenerator: NodeJS.Timeout | null = null;
  private debugStts = false;

  constructor(debugStts: boolean = false) {
    console.log('MockJanusClient: Initialized');
    this.debugStts = debugStts;
  }

  // Add a WebSocket client to receive audio
  addClient(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on('close', () => {
      this.clients.delete(ws);
      console.log('MockJanusClient: Client disconnected');
    });
    console.log('MockJanusClient: Client added');
    if (this.debugStts) {
      this.startTestToneGenerator();
    }
  }

  // Useful to debug the client.js audio capabilities and make sure
  //   there are no issues with STT from elevenlabs
  startTestToneGenerator(): void {
    if (this.testToneGenerator) return; // Already running

    console.log('Starting test tone generator');

    // Generate a test tone every 500ms
    this.testToneGenerator = setInterval(() => {
      // Create a 440Hz sine wave for 100ms (4800 samples at 48kHz)
      const sampleRate = 48000;
      const duration = 0.1; // 100ms
      const frequency = 440; // A4 note
      const amplitude = 16000; // About half of Int16 max (32767)

      const samples = Math.floor(sampleRate * duration);
      const frame = new Int16Array(samples);

      // Fill with sine wave
      for (let i = 0; i < samples; i++) {
        frame[i] = Math.round(
          amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate),
        );
      }

      console.log(
        `Generated test tone: ${samples} samples, first value: ${frame[0]}`,
      );

      // Send to all clients
      this.pushLocalAudio(frame, sampleRate);
    }, 500);
  }

  stopTestToneGenerator(): void {
    if (this.testToneGenerator) {
      clearInterval(this.testToneGenerator);
      this.testToneGenerator = null;
      console.log('Stopped test tone generator');
    }
  }

  // Method called by SttTtsPlugin to push audio to listeners
  pushLocalAudio(frame: Int16Array, sampleRate: number): void {
    if (this.clients.size === 0) {
      return;
    }

    try {
      // Create metadata
      const metadata = {
        type: 'audio_data',
        sampleRate: sampleRate,
        bitsPerSample: 16,
        channels: 1,
        frameSize: frame.length,
      };

      // CRITICAL CHANGE: Create a DataView to handle endianness explicitly
      const arrayBuffer = new ArrayBuffer(frame.length * 2);
      const dataView = new DataView(arrayBuffer);

      // Write each sample with explicit little-endian byte order
      for (let i = 0; i < frame.length; i++) {
        dataView.setInt16(i * 2, frame[i], true); // true = little-endian
      }

      // Create a buffer from this correctly-ordered data
      const buffer = Buffer.from(arrayBuffer);

      // Send to clients
      for (const client of this.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(metadata));
          client.send(buffer);
        }
      }
    } catch (error) {
      console.error('Error in pushLocalAudio:', error);
    }
  }
}
