import { elizaLogger } from '@elizaos/core';
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import { EventEmitter } from 'events';

/**
 * Options for the Deepgram streaming client
 */
export interface DeepgramStreamingOptions {
  apiKey: string;
  language?: string;
  model?: string;
  punctuate?: boolean;
  interim_results?: boolean;
  endpointing?: string;
  vad_events?: boolean;
  smart_format?: boolean;
}

/**
 * Client for streaming audio to Deepgram for real-time transcription
 */
export class DeepgramStreamingClient extends EventEmitter {
  private deepgramClient: any;
  private connection: any; // Deepgram live transcription connection
  private options: DeepgramStreamingOptions;
  private isConnected: boolean = false;
  private reconnectAttempts: number = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private keepAliveInterval: NodeJS.Timeout | null = null;

  /**
   * Create a new Deepgram streaming client
   * 
   * @param options Configuration options for Deepgram
   */
  constructor(options: DeepgramStreamingOptions) {
    super();
    this.options = {
      language: 'en',
      model: 'nova-2',
      punctuate: true,
      interim_results: true,
      endpointing: 'enhanced',
      vad_events: true,
      smart_format: true,
      ...options
    };
    
    this.deepgramClient = createClient(this.options.apiKey);
  }

  /**
   * Connect to Deepgram streaming API
   */
  public connect(): void {
    if (this.isConnected) {
      return;
    }

    try {
      // Create live transcription connection
      const deepgram = this.deepgramClient.listen.live({
        language: this.options.language,
        model: this.options.model,
        punctuate: this.options.punctuate,
        interim_results: this.options.interim_results,
        endpointing: this.options.endpointing,
        vad_events: this.options.vad_events,
        smart_format: this.options.smart_format,
      });

      // Setup keepalive to prevent connection timeouts
      if (this.keepAliveInterval) {
        clearInterval(this.keepAliveInterval);
      }
      
      this.keepAliveInterval = setInterval(() => {
        elizaLogger.debug('[DeepgramStreamingClient] Sending keepalive');
        deepgram.keepAlive();
      }, 10 * 1000); // Every 10 seconds

      // Set up event handlers
      deepgram.addListener(LiveTranscriptionEvents.Open, () => {
        elizaLogger.info('[DeepgramStreamingClient] Connection established');
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.emit('connected');
      });

      deepgram.addListener(LiveTranscriptionEvents.Close, () => {
        elizaLogger.info('[DeepgramStreamingClient] Connection closed');
        this.isConnected = false;
        if (this.keepAliveInterval) {
          clearInterval(this.keepAliveInterval);
          this.keepAliveInterval = null;
        }
        this.emit('disconnected');
        this.attemptReconnect();
      });

      deepgram.addListener(LiveTranscriptionEvents.Error, (error: any) => {
        elizaLogger.error('[DeepgramStreamingClient] Error:', error);
        this.emit('error', error);
      });


      deepgram.addListener(LiveTranscriptionEvents.Transcript, (data: any) => {
        elizaLogger.debug('[DeepgramStreamingClient] Transcript received');
        
        // Forward the full transcription data
        this.emit('transcription', data);
        
        // Process the transcript to detect sentences
        if (data && data.is_final && 
            data.channel && 
            data.channel.alternatives && 
            data.channel.alternatives.length > 0) {
          
          const transcript = data.channel.alternatives[0].transcript.trim();
          
          // Only emit if there's actual content
          if (transcript) {
            this.emit('sentence', transcript);
          }
        }
      });

      deepgram.addListener(LiveTranscriptionEvents.Metadata, (data: any) => {
        elizaLogger.debug('[DeepgramStreamingClient] Metadata received');
        this.emit('metadata', data);
        
        // Check for speech final events
        if (data && data.speech_final) {
          this.emit('speech_final');
        }
      });

      this.connection = deepgram;
    } catch (error) {
      elizaLogger.error('[DeepgramStreamingClient] Connection error:', error);
      this.emit('error', error);
      this.attemptReconnect();
    }
  }

  /**
   * Send audio data to Deepgram
   * 
   * @param audioChunk Audio data as Buffer, ArrayBuffer, Int16Array or Float32Array
   */
  public sendAudio(audioChunk: Buffer | ArrayBuffer | Int16Array | Float32Array): void {
    if (!this.isConnected || !this.connection) {
      elizaLogger.warn('[DeepgramStreamingClient] Cannot send audio: not connected');
      return;
    }

    try {
      // Handle different types of audio input
      let audioData: ArrayBuffer;
      
      if (audioChunk instanceof Float32Array) {
        // Convert Float32Array to Int16Array for Deepgram
        const int16Data = new Int16Array(audioChunk.length);
        for (let i = 0; i < audioChunk.length; i++) {
          // Convert normalized float (-1.0 to 1.0) to Int16 range (-32768 to 32767)
          int16Data[i] = Math.max(-32768, Math.min(32767, Math.round(audioChunk[i] * 32767)));
        }
        audioData = int16Data.buffer;
      } else if (audioChunk instanceof Int16Array) {
        audioData = audioChunk.buffer;
      } else if (audioChunk instanceof Buffer) {
        audioData = audioChunk.buffer.slice(
          audioChunk.byteOffset,
          audioChunk.byteOffset + audioChunk.byteLength
        );
      } else {
        // It's already an ArrayBuffer
        audioData = audioChunk;
      }
      
      // Check connection state before sending
      if (this.connection.getReadyState() === 1) { // OPEN
        this.connection.send(audioData);
      } else if (this.connection.getReadyState() >= 2) { // CLOSING or CLOSED
        elizaLogger.warn('[DeepgramStreamingClient] Connection closing/closed, reconnecting');
        this.disconnect();
        this.connection.removeAllListeners();
        this.connect();
      } else {
        elizaLogger.warn('[DeepgramStreamingClient] Connection not ready');
      }
    } catch (error) {
      elizaLogger.error('[DeepgramStreamingClient] Error sending audio:', error);
      this.emit('error', error);
    }
  }

  /**
   * Check if the connection is ready to receive audio
   */
  public isReady(): boolean {
    return this.isConnected && this.connection && this.connection.getReadyState() === 1;
  }

  /**
   * Close the connection to Deepgram
   */
  public disconnect(): void {
    if (this.connection) {
      try {
        if (this.keepAliveInterval) {
          clearInterval(this.keepAliveInterval);
          this.keepAliveInterval = null;
        }
        
        this.connection.finish();
        this.isConnected = false;
        elizaLogger.info('[DeepgramStreamingClient] Connection closed');
      } catch (error) {
        elizaLogger.error('[DeepgramStreamingClient] Error closing connection:', error);
      }
    }
  }

  /**
   * Attempt to reconnect to Deepgram
   */
  private attemptReconnect(): void {
    if (this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
      this.reconnectAttempts++;
      const delay = Math.pow(2, this.reconnectAttempts) * 1000; // Exponential backoff
      
      elizaLogger.info(`[DeepgramStreamingClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
      
      setTimeout(() => {
        if (!this.isConnected) {
          this.connect();
        }
      }, delay);
    } else {
      elizaLogger.error(`[DeepgramStreamingClient] Failed to reconnect after ${this.MAX_RECONNECT_ATTEMPTS} attempts`);
      this.emit('reconnect_failed');
    }
  }
}
