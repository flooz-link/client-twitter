import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

/**
 * Events emitted by TTS services
 */
export enum TTSEvents {
  SPEAKING_START = 'speaking-start',
  SPEAKING_END = 'speaking-end',
  SPEAKING_ERROR = 'speaking-error',
  SPEAKING_INTERRUPTED = 'speaking-interrupted',
  AUDIO_DATA = 'audio-data',
}

/**
 * Configuration options for TTS services
 */
export interface TTSServiceConfig {
  // Common configuration properties
  apiKey?: string;
  voiceId?: string;
  model?: string;
  baseUrl?: string;
  // Stream related settings
  bufferSize?: number;
  minTextBufferSize?: number;
  maxTextBufferSize?: number;
  bufferTimeout?: number;
  // Audio settings
  sampleRate?: number;
  channels?: number;
}

/**
 * Queue item for TTS processing
 */
interface TTSQueueItem {
  text: string;
  streamId: string;
}

/**
 * Base interface for Text-to-Speech services
 */
export abstract class BaseTTSService {
  protected eventEmitter: EventEmitter;
  protected config: TTSServiceConfig;
  protected isSpeaking: boolean = false;
  protected ttsQueue: TTSQueueItem[] = [];

  // Map to track abort controllers by stream ID
  protected streamControllers: Map<string, AbortController> = new Map();

  // Active stream ID tracking
  protected activeStreamId: string | null = null;

  // Smart text buffering
  protected ttsTextBuffer: string = '';
  protected ttsStreamIdBuffer: string | null = null;
  protected ttsTextBufferTimeout: NodeJS.Timeout | null = null;
  protected readonly MIN_TTS_BUFFER_SIZE: number;
  protected readonly MAX_TTS_BUFFER_SIZE: number;
  protected readonly TTS_BUFFER_TIMEOUT: number;

  constructor(config: TTSServiceConfig) {
    this.eventEmitter = new EventEmitter();
    this.config = config;

    // Set default values or use provided configs
    this.MIN_TTS_BUFFER_SIZE = config.minTextBufferSize || 20;
    this.MAX_TTS_BUFFER_SIZE = config.maxTextBufferSize || 150;
    this.TTS_BUFFER_TIMEOUT = config.bufferTimeout || 200;
  }

  /**
   * Initialize the TTS service
   */
  abstract init(): Promise<void>;

  /**
   * Convert text to speech and play it
   */
  abstract streamTTS(
    text: string,
    streamId: string,
    signal: AbortSignal,
  ): Promise<void>;

  /**
   * Register a new stream and create its abort controller
   */
  public registerStream(streamId: string): AbortController {
    // If we already have a controller for this stream, abort it first
    this.abortStream(streamId);

    // Create a new controller
    const controller = new AbortController();
    this.streamControllers.set(streamId, controller);
    return controller;
  }

  /**
   * Check if a stream is active
   */
  public isStreamActive(streamId: string): boolean {
    return (
      this.streamControllers.has(streamId) &&
      !this.streamControllers.get(streamId)?.signal.aborted
    );
  }

  /**
   * Abort a specific stream
   */
  public abortStream(streamId: string): boolean {
    const controller = this.streamControllers.get(streamId);
    if (controller) {
      if (!controller.signal.aborted) {
        controller.abort();
        console.log(`[BaseTTSService] Aborting stream: ${streamId}`);
        this.eventEmitter.emit(TTSEvents.SPEAKING_INTERRUPTED, streamId);
      }
      this.streamControllers.delete(streamId);

      // If this was the active stream, clear it
      if (this.activeStreamId === streamId) {
        this.activeStreamId = null;
      }

      // Also remove any queue items for this stream
      this.ttsQueue = this.ttsQueue.filter(
        (item) => item.streamId !== streamId,
      );

      // Clear buffer if it belongs to this stream
      if (this.ttsStreamIdBuffer === streamId) {
        this.clearBuffer();
      }

      return true;
    }
    return false;
  }

  /**
   * Abort all streams except the specified one
   */
  public abortAllExcept(streamId: string): void {
    const streamsToAbort = [...this.streamControllers.keys()].filter(
      (id) => id !== streamId,
    );

    for (const id of streamsToAbort) {
      this.abortStream(id);
    }

    // Set the non-aborted stream as active
    if (this.streamControllers.has(streamId)) {
      this.activeStreamId = streamId;
    }
  }

  /**
   * Abort all streams
   */
  public abortAllStreams(): void {
    const streamIds = [...this.streamControllers.keys()];
    for (const id of streamIds) {
      this.abortStream(id);
    }

    // Clear the active stream
    this.activeStreamId = null;

    // Clear the queue
    this.ttsQueue = [];

    // Clear any buffer
    this.clearBuffer();

    // Reset speaking state
    this.isSpeaking = false;
  }

  protected emitAudioFrame(
    frame: Int16Array,
    sampleRate: number,
    streamId: string,
  ): void {
    this.eventEmitter.emit(TTSEvents.AUDIO_DATA, frame, sampleRate, streamId);
  }

  /**
   * Public method to queue text for speaking with stream awareness
   */
  public async speakText(text: string, streamId?: string): Promise<void> {
    if (!text || text.trim().length === 0) return;

    const actualStreamId = streamId || uuidv4();

    // Make sure we have a controller for this stream
    if (!this.streamControllers.has(actualStreamId)) {
      this.registerStream(actualStreamId);
    }

    console.log(
      `[BaseTTSService] Queuing text for stream ${actualStreamId}: "${text.substring(0, 30)}${text.length > 30 ? '...' : ''}"`,
    );

    this.ttsQueue.push({ text, streamId: actualStreamId });

    if (!this.isSpeaking) {
      await this.processTtsQueue();
    }
  }

  /**
   * Process the TTS queue with stream awareness
   */
  protected async processTtsQueue(): Promise<void> {
    try {
      this.isSpeaking = true;

      while (this.ttsQueue.length > 0) {
        const item = this.ttsQueue.shift();
        if (!item) continue;

        const { text, streamId } = item;

        // Skip if the stream was aborted
        if (!this.isStreamActive(streamId)) {
          console.log(`[BaseTTSService] Skipping aborted stream ${streamId}`);
          continue;
        }

        // Set as active stream
        this.activeStreamId = streamId;

        // Make sure we have a controller
        if (!this.streamControllers.has(streamId)) {
          this.registerStream(streamId);
        }

        const controller = this.streamControllers.get(streamId)!;

        // Emit event before starting speech
        this.eventEmitter.emit(TTSEvents.SPEAKING_START, streamId);

        // Stream the TTS
        await this.streamTTS(text, streamId, controller.signal);

        // If the stream wasn't aborted, emit completion event
        if (!controller.signal.aborted) {
          this.eventEmitter.emit(TTSEvents.SPEAKING_END, streamId);
        }

        // Remove the controller if done
        if (
          this.ttsQueue.findIndex((item) => item.streamId === streamId) === -1
        ) {
          this.streamControllers.delete(streamId);
        }

        // Check if we should continue processing
        if (controller.signal.aborted) {
          console.log(
            `[BaseTTSService] Stream ${streamId} was aborted, skipping remaining items`,
          );
          break;
        }
      }
    } catch (error) {
      console.error('[BaseTTSService] Queue processing error =>', error);
      this.eventEmitter.emit(
        TTSEvents.SPEAKING_ERROR,
        error,
        this.activeStreamId,
      );
    } finally {
      this.isSpeaking = this.ttsQueue.length > 0;

      // Process next items if any
      if (this.isSpeaking) {
        this.processTtsQueue().catch((err) => {
          console.error(
            '[BaseTTSService] Error in continued queue processing:',
            err,
          );
        });
      }
    }
  }

  /**
   * Stop the current speech
   */
  public stopSpeaking(): void {
    this.abortAllStreams();
    console.log('[BaseTTSService] All speech stopped');
  }

  /**
   * Buffer text for TTS with smart chunking at natural breaks
   */
  public bufferTextForTTS(text: string, streamId?: string): void {
    if (!text || text.trim().length === 0) {
      return;
    }

    const actualStreamId = streamId || this.ttsStreamIdBuffer || uuidv4();

    // If buffer was for a different stream, flush it first
    if (
      this.ttsStreamIdBuffer &&
      this.ttsStreamIdBuffer !== actualStreamId &&
      this.ttsTextBuffer
    ) {
      this.flushBuffer();
    }

    // Update the stream ID
    this.ttsStreamIdBuffer = actualStreamId;

    // Append the new text to our buffer
    this.ttsTextBuffer += text;

    // Clear any existing timeout
    if (this.ttsTextBufferTimeout) {
      clearTimeout(this.ttsTextBufferTimeout);
    }

    // Check if there's a natural break or if we've reached the max buffer size
    const hasNaturalBreak =
      /[.!?]\s*$/.test(this.ttsTextBuffer) || // Ends with punctuation
      /\n\s*$/.test(this.ttsTextBuffer) || // Ends with newline
      /[:;]\s*$/.test(this.ttsTextBuffer); // Ends with colon or semicolon

    if (
      hasNaturalBreak ||
      this.ttsTextBuffer.length >= this.MAX_TTS_BUFFER_SIZE
    ) {
      // Flush immediately if we have a natural break or reached max size
      this.flushBuffer();
    } else if (this.ttsTextBuffer.length >= this.MIN_TTS_BUFFER_SIZE) {
      // If we have enough characters but no natural break,
      // set a timeout to flush soon if no more text arrives
      this.ttsTextBufferTimeout = setTimeout(() => {
        this.flushBuffer();
      }, this.TTS_BUFFER_TIMEOUT);
    }
  }

  /**
   * Flush the text buffer to TTS
   */
  protected flushBuffer(): void {
    if (!this.ttsTextBuffer || !this.ttsStreamIdBuffer) {
      return;
    }

    // Send the buffered text to TTS queue
    const textToSpeak = this.ttsTextBuffer;
    const streamId = this.ttsStreamIdBuffer;

    // Clear the buffer
    this.clearBuffer();

    console.log(
      `[BaseTTSService] Flushing buffer to TTS for stream ${streamId}: "${textToSpeak.substring(0, 30)}${textToSpeak.length > 30 ? '...' : ''}"`,
    );

    this.speakText(textToSpeak, streamId).catch((err) => {
      console.error('[BaseTTSService] Error speaking text:', err);
    });
  }

  /**
   * Clear the buffer and cancel any pending timeout
   */
  protected clearBuffer(): void {
    this.ttsTextBuffer = '';
    this.ttsStreamIdBuffer = null;

    if (this.ttsTextBufferTimeout) {
      clearTimeout(this.ttsTextBufferTimeout);
      this.ttsTextBufferTimeout = null;
    }
  }

  /**
   * Subscribe to events
   */
  public on(event: TTSEvents, listener: (...args: any[]) => void): void {
    this.eventEmitter.on(event, listener);
  }

  /**
   * Unsubscribe from events
   */
  public off(event: TTSEvents, listener: (...args: any[]) => void): void {
    this.eventEmitter.off(event, listener);
  }

  /**
   * Clean up resources
   */
  public cleanup(): void {
    this.abortAllStreams();
    this.eventEmitter.removeAllListeners();
    this.clearBuffer();
  }
}
