import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { BaseTTSService } from '../tts/baseTts';

/**
 * Types of events emitted by the LLM service
 */
export enum LLMEvents {
  // Core processing events
  PROCESSING_START = 'processing-start',
  PROCESSING_END = 'processing-end',
  PROCESSING_ERROR = 'processing-error',

  // Content events
  CONTENT_CHUNK = 'content-chunk',
  CONTENT_COMPLETE = 'content-complete',

  // Action events (for handling special instructions)
  ACTION_DETECTED = 'action-detected',

  // Stream management
  STREAM_ABORTED = 'stream-aborted',
}

/**
 * Interface for stream metadata
 */
export interface LLMStreamData {
  id: string;
  active: boolean;
  startedAt: number;
  userId: string;
  message: string;
  responseText?: string;
}

/**
 * Interface for chat message structure
 */
export interface LLMChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  name?: string;
}

/**
 * Interface for LLM service configuration
 */
export interface BaseLLMConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

/**
 * Base class for LLM services
 * This follows similar patterns to BaseTranscriptionService and BaseTTSService
 */
export abstract class BaseLLMService extends EventEmitter {
  protected config: BaseLLMConfig;
  protected ttsService?: BaseTTSService;
  private streamManager?: any; // Using any type for flexibility with different manager implementations

  /**
   * Constructor for BaseLLMService
   * @param config Configuration for the LLM service
   * @param streamManager Optional external stream manager
   */
  constructor(config: BaseLLMConfig, streamManager?: any) {
    super();
    this.config = config;
    this.streamManager = streamManager;
  }

  /**
   * Set the stream manager after initialization
   * @param streamManager The stream manager to use
   */
  public setStreamManager(streamManager: any): void {
    this.streamManager = streamManager;
  }

  /**
   * Initialize the LLM service
   * This should be implemented by derived classes
   */
  public abstract initialize(): Promise<void>;

  /**
   * Process a user message and stream the response
   * This should be implemented by derived classes
   * @param userMessage The message from the user
   * @param userId The ID of the user
   * @param chatHistory Previous chat messages (optional)
   * @param streamId Optional ID for the stream, will be generated if not provided
   * @returns The ID of the stream that was created
   */
  public abstract processMessage(
    userMessage: string,
    userId: string,
    chatHistory?: LLMChatMessage[],
    streamId?: string,
  ): Promise<string>;

  /**
   * Register a TTS service to use for speaking responses
   * @param ttsService The TTS service to use
   */
  public setTTSService(ttsService: BaseTTSService): void {
    this.ttsService = ttsService;
  }

  /**
   * Register a new stream
   * @param streamData Stream metadata or partial data
   * @returns The ID of the registered stream
   */
  public registerStream(
    streamData: Partial<LLMStreamData> & { id: string },
  ): string {
    const streamId = streamData.id || uuidv4();

    if (
      this.streamManager &&
      typeof this.streamManager.register === 'function'
    ) {
      // Use the external stream manager if available
      this.streamManager.register({
        id: streamId,
        active: true,
        startedAt: Date.now(),
        userId: streamData.userId || 'unknown',
        message: streamData.message || '',
        ...streamData,
      });
    }

    return streamId;
  }

  /**
   * Check if a stream is active
   * @param streamId The ID of the stream to check
   * @returns True if the stream is active, false otherwise
   */
  public isStreamActive(streamId: string): boolean {
    if (
      this.streamManager &&
      typeof this.streamManager.isActive === 'function'
    ) {
      return this.streamManager.isActive(streamId);
    }

    // Fallback if no stream manager is available
    return true;
  }

  /**
   * Get a stream by ID
   * @param streamId The ID of the stream to get
   * @returns The stream data if found, undefined otherwise
   */
  public getStream(streamId: string): any | undefined {
    if (this.streamManager && typeof this.streamManager.get === 'function') {
      return this.streamManager.get(streamId);
    }
    return undefined;
  }

  /**
   * Abort a specific stream
   * @param streamId The ID of the stream to abort
   */
  public abortStream(streamId: string): void {
    if (this.streamManager && typeof this.streamManager.abort === 'function') {
      this.streamManager.abort(streamId);
    }

    this.emit(LLMEvents.STREAM_ABORTED, streamId);
  }

  /**
   * Abort all streams except the specified one
   * @param exceptStreamId The ID of the stream to keep active
   */
  public abortAllExcept(exceptStreamId: string): void {
    if (
      this.streamManager &&
      typeof this.streamManager.abortOthers === 'function'
    ) {
      this.streamManager.abortOthers(exceptStreamId);
    }

    this.emit(LLMEvents.STREAM_ABORTED, exceptStreamId);
  }

  /**
   * Send text to the TTS service for speaking
   * @param text The text to speak
   * @param streamId The ID of the stream
   */
  protected sendTextToTTS(text: string, streamId: string): void {
    if (this.ttsService && text.trim() && this.isStreamActive(streamId)) {
      this.ttsService.bufferTextForTTS(text, streamId);
    }
  }

  /**
   * Handle a content chunk from the LLM
   * @param text The text chunk
   * @param streamId The ID of the stream
   */
  protected handleContentChunk(text: string, streamId: string): void {
    if (!this.isStreamActive(streamId)) return;

    // Update the stream's response text
    const stream = this.getStream(streamId);
    if (
      stream &&
      this.streamManager &&
      typeof this.streamManager.updateResponseText === 'function'
    ) {
      // Use a method on the stream manager to update the response text
      this.streamManager.updateResponseText(streamId, text);
    }

    // Emit the content chunk event
    this.emit(LLMEvents.CONTENT_CHUNK, text, streamId);

    // Send to TTS if available
    this.sendTextToTTS(text, streamId);
  }

  /**
   * Extract any actions from the LLM response
   * @param text The text to check for actions
   * @param streamId The ID of the stream
   * @returns The action name if found, null otherwise
   */
  protected extractAction(text: string, streamId: string): string | null {
    // Check for action markers like "actionIs:ACTION_NAME"
    const actionMatch = /actionIs:([A-Z_]+)/.exec(text);
    if (actionMatch) {
      const actionName = actionMatch[1];
      this.emit(LLMEvents.ACTION_DETECTED, actionName, streamId);
      return actionName;
    }
    return null;
  }

  /**
   * Clean up resources
   */
  public cleanup(): void {
    // We don't need to clean up the stream manager here
    // as it's managed by the SttTtsPlugin

    // Remove all event listeners
    this.removeAllListeners();
  }
}
