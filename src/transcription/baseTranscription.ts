import { EventEmitter } from 'events';

// Define transcription events that any provider can emit
export enum TranscriptionEvents {
  TRANSCRIPT = 'transcript',
  CONNECTED = 'connected',
  DISCONNECTED = 'disconnected',
  ERROR = 'error',
  WARNING = 'warning',
}

// Define the transcript data structure
export interface TranscriptData {
  transcript: string;
  isFinal: boolean;
  raw?: any;
  // Add any other properties needed
}

// Base transcription service interface
export interface TranscriptionService {
  initialize(): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendAudio(audioBuffer: ArrayBuffer): void;
  on(event: string, listener: (...args: any[]) => void): void;
  off(event: string, listener: (...args: any[]) => void): void;
}

// Base class for all transcription services
export abstract class BaseTranscriptionService
  extends EventEmitter
  implements TranscriptionService
{
  protected isInitialized: boolean = false;
  protected keepAliveInterval: NodeJS.Timeout | null = null;
  protected keepAliveIntervalMs: number = 5000;

  constructor(protected config: any) {
    super();
  }

  public abstract initialize(): void;
  public abstract start(): Promise<void>;
  public abstract stop(): Promise<void>;
  public abstract sendAudio(audioBuffer: ArrayBuffer): void;

  protected startKeepAlive(callback: () => void): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
    }

    this.keepAliveInterval = setInterval(callback, this.keepAliveIntervalMs);
  }

  protected stopKeepAlive(): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  protected emitTranscript(
    transcript: string,
    isFinal: boolean,
    raw?: any,
  ): void {
    this.emit(TranscriptionEvents.TRANSCRIPT, {
      transcript,
      isFinal,
      raw,
    });
  }
}

// Deepgram implementation
export interface DeepgramConfig {
  apiKey: string;
  language?: string;
  punctuate?: boolean;
  smartFormat?: boolean;
  fillerWords?: boolean;
  unknownWords?: boolean;
  model?: string;
  encoding?: string;
  sampleRate?: number;
  channels?: number;
  interimResults?: boolean;
  vadEvents?: boolean;
  endpointing?: number;
}
