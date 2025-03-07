import { spawn } from 'child_process';
import {
  elizaLogger,
  stringToUuid,
  composeContext,
  getEmbeddingZeroVector,
  ModelClass,
  type IAgentRuntime,
  type Memory,
  type Plugin,
} from '@elizaos/core';
import type {
  Space,
  JanusClient,
  AudioDataWithUser,
} from '@flooz-link/agent-twitter-client';
import type { ClientBase, TwitterProfile } from '../base';
import { twitterSpaceTemplate } from './templates';
import { isEmpty, isNotEmpty } from '../utils';
import { PassThrough } from 'stream';
import { EventEmitter } from 'events';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { createClient, Deepgram, DeepgramClient, LiveTranscriptionEvents } from '@deepgram/sdk';

interface PluginConfig {
  runtime: IAgentRuntime;
  client: ClientBase;
  spaceId: string;
  elevenLabsApiKey?: string;
  voiceId?: string;
  elevenLabsModel?: string;
  chatContext?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  grokApiKey?: string;
  grokBaseUrl?: string;
  deepgramApiKey: string; // Required for Deepgram
}

type TranscriptData = {
  channel: {
    alternatives: Array<{
      transcript: string;
    }>;
  };
  is_final: boolean;
};

/**
 * Speech-to-text (Deepgram) + conversation + TTS (ElevenLabs)
 */
export class SttTtsPlugin implements Plugin {
  name = 'SttTtsPlugin';
  description = 'Speech-to-text (Deepgram) + conversation + TTS (ElevenLabs)';
  private runtime: IAgentRuntime;
  private client: ClientBase;
  private spaceId: string;
  private space?: Space;
  private janus?: JanusClient;
  private elevenLabsApiKey?: string;
  private grokApiKey?: string;
  private grokBaseUrl = 'https://api.x.ai/v1';
  private voiceId = '21m00Tcm4TlvDq8ikWAM';
  private elevenLabsModel = 'eleven_monolingual_v1';
  private chatContext: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  private ttsQueue: string[] = [];
  private isSpeaking = false;
  private isProcessingAudio = false;
  private ttsAbortController: AbortController | null = null;
  private currentStreamId: string | null = null;
  private activeStreams = new Set<string>();
  private eventEmitter = new EventEmitter();
  private openai: OpenAI;
  private deepgram: DeepgramClient;
  private socket: any; // Deepgram WebSocket
  private lastSpeaker: string | null = null;
  private interruptionThreshold = 3000; // Energy threshold for detecting speech (configurable)
  private consecutiveFramesForInterruption = 5; // Number of consecutive frames to confirm interruption (e.g., 5 frames of 10ms each)
  private interruptionCounter = 0; // Counter for consecutive high-energy frames
  private keepAlive: NodeJS.Timeout | null = null;
  deepgramApiKey: any;
  private botProfile: TwitterProfile;

  // Added for transcript buffering
  private transcriptBuffer: Map<string, string> = new Map();
  private processingTimeout: Map<string, NodeJS.Timeout> = new Map();
  private timeoutDuration = 200; // ms to wait before processing if no utterance end
  private inactivityTimer: Map<string, NodeJS.Timeout> = new Map();
  private lastTranscriptionTime: Map<string, number> = new Map();

  // Smart text buffering for TTS
  private textBuffer = '';
  private textBufferTimeout: NodeJS.Timeout | null = null;
  private readonly MIN_TTS_BUFFER_SIZE = 20; // Minimum characters before sending to TTS
  private readonly MAX_TTS_BUFFER_SIZE = 150; // Maximum buffer size to prevent too long chunks
  private readonly TTS_BUFFER_TIMEOUT = 500; // ms to wait before flushing buffer if no natural breaks

  // Debouncing mechanism
  private pendingMessages: Map<string, string> = new Map(); // userId -> latestMessage

  /**
   * Transcription service interface
   */
  private transcriptionService = {
    transcribe: async (audioBuffer: ArrayBuffer): Promise<string> => {
      try {
        // Convert the audio to a Uint8Array for sending to Deepgram
        const audioData = new Uint8Array(audioBuffer);
        
        if (!audioData || audioData.length === 0) {
          throw new Error('Empty audio data provided for transcription');
        }
        
        console.log(`[SttTtsPlugin] Transcribing audio: ${audioData.length} bytes`);
        
        // Return empty string if socket is not ready
        if (!this.socket || this.socket.getReadyState() !== 1) {
          console.error('[SttTtsPlugin] Deepgram socket not ready for transcription');
          return '';
        }
        
        // Send the audio data to Deepgram for transcription
        this.socket.send(audioData);
        
        // Wait for transcription result - we'll use a promise that resolves when utterance is complete
        return new Promise<string>((resolve) => {
          let transcriptionResult = '';
          
          // Setup timeout to handle case where no transcription comes back
          const timeout = setTimeout(() => {
            console.warn('[SttTtsPlugin] Transcription timed out, returning empty result');
            cleanup();
            resolve('');
          }, 10000); // 10 second timeout
          
          // Function to clean up event listeners
          const cleanup = () => {
            this.eventEmitter.removeListener('transcription-complete', handleTranscriptionComplete);
            clearTimeout(timeout);
          };
          
          // Handler for transcription completion
          const handleTranscriptionComplete = (userId: string, transcript: string) => {
            if (transcript && transcript.length > 0) {
              transcriptionResult = transcript;
              cleanup();
              resolve(transcriptionResult);
            }
          };
          
          // Listen for transcription completion event
          this.eventEmitter.once('transcription-complete', handleTranscriptionComplete);
        });
      } catch (error) {
        console.error('[SttTtsPlugin] Transcription error:', error);
        // Create a custom error that can be detected in the calling code
        const transcriptionError = new Error(`Failed to transcribe audio: ${error.message}`);
        transcriptionError.name = 'TranscriptionError';
        throw transcriptionError;
      }
    }
  };

  /**
   * Downsample audio if needed for better transcription
   * Most transcription services work best with 16kHz audio
   */
  private maybeDownsampleAudio(
    audio: Int16Array,
    originalSampleRate: number,
    targetSampleRate: number,
  ): Int16Array {
    // If already at target rate or downsampling not needed, return original
    if (originalSampleRate <= targetSampleRate) {
      return audio;
    }

    // Calculate the ratio for downsampling
    const ratio = originalSampleRate / targetSampleRate;
    const newLength = Math.floor(audio.length / ratio);
    const result = new Int16Array(newLength);

    // Enhanced downsampling with linear interpolation for better quality
    // This preserves more of the audio information compared to simple picking
    for (let i = 0; i < newLength; i++) {
      const exactPos = i * ratio;
      const lowIndex = Math.floor(exactPos);
      const highIndex = Math.min(lowIndex + 1, audio.length - 1);
      const fraction = exactPos - lowIndex;

      // Linear interpolation between adjacent samples
      result[i] = Math.round(
        (1 - fraction) * audio[lowIndex] + fraction * audio[highIndex],
      );
    }

    elizaLogger.debug(
      `[SttTtsPlugin] Downsampled audio from ${originalSampleRate}Hz to ${targetSampleRate}Hz, ` +
        `original length: ${audio.length}, new length: ${newLength}`,
    );

    return this.normalizeAudioLevels(result);
  }

  /**
   * Normalize audio levels to improve speech recognition
   * This helps ensure the audio is in an optimal range for the transcription service
   */
  private normalizeAudioLevels(audio: Int16Array): Int16Array {
    // Find the maximum amplitude in the audio
    let maxAmplitude = 0;
    for (let i = 0; i < audio.length; i++) {
      const absValue = Math.abs(audio[i]);
      if (absValue > maxAmplitude) {
        maxAmplitude = absValue;
      }
    }

    // Default gain factor (no change)
    let gainFactor = 1.0;

    // If the audio is too quiet, amplify it
    if (maxAmplitude < 10000) { // Less than ~30% of max Int16 value
      gainFactor = Math.min(3.0, 10000 / Math.max(1, maxAmplitude));
      elizaLogger.debug(
        `[SttTtsPlugin] Amplifying quiet audio by factor of ${gainFactor.toFixed(2)}`,
      );

      for (let i = 0; i < audio.length; i++) {
        // Apply gain and clamp to Int16 range
        audio[i] = Math.max(
          -32768,
          Math.min(32767, Math.round(audio[i] * gainFactor)),
        );
      }
    }

    elizaLogger.debug(
      `[SttTtsPlugin] Normalized audio levels, max amplitude: ${maxAmplitude}, ` +
        `scale factor: ${gainFactor.toFixed(2)}`,
    );

    return audio;
  }

  /**
   * Convert PCM audio to WAV format in memory
   * This creates a proper WAV file structure that the transcription service can process
   */
  private async convertPcmToWavInMemory(
    pcmData: Int16Array,
    sampleRate: number,
  ): Promise<ArrayBuffer> {
    try {
      // number of channels
      const numChannels = 1;
      // byte rate = (sampleRate * numChannels * bitsPerSample/8)
      const byteRate = sampleRate * numChannels * 2;
      const blockAlign = numChannels * 2;
      // data chunk size = pcmData.length * (bitsPerSample/8)
      const dataSize = pcmData.length * 2;

      // Validate input data
      if (!pcmData || pcmData.length === 0) {
        throw new Error('Empty PCM data provided for WAV conversion');
      }

      // WAV header is 44 bytes
      const buffer = new ArrayBuffer(44 + dataSize);
      const view = new DataView(buffer);

      // RIFF chunk descriptor
      this.writeString(view, 0, 'RIFF');
      view.setUint32(4, 36 + dataSize, true); // file size - 8
      this.writeString(view, 8, 'WAVE');

      // fmt sub-chunk
      this.writeString(view, 12, 'fmt ');
      view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
      view.setUint16(20, 1, true); // AudioFormat (1 = PCM)
      view.setUint16(22, numChannels, true); // NumChannels
      view.setUint32(24, sampleRate, true); // SampleRate
      view.setUint32(28, byteRate, true); // ByteRate
      view.setUint16(32, blockAlign, true); // BlockAlign
      view.setUint16(34, 16, true); // BitsPerSample (16)

      // data sub-chunk
      this.writeString(view, 36, 'data');
      view.setUint32(40, dataSize, true);

      // Write PCM samples
      let offset = 44;
      for (let i = 0; i < pcmData.length; i++, offset += 2) {
        view.setInt16(offset, pcmData[i], true);
      }

      // Log WAV buffer details for debugging
      elizaLogger.debug(
        `[SttTtsPlugin] Created WAV buffer: size=${buffer.byteLength} bytes, ` +
          `sample rate=${sampleRate}Hz, channels=${numChannels}, ` +
          `samples=${pcmData.length}, duration=${(pcmData.length / sampleRate).toFixed(2)}s`,
      );

      return buffer;
    } catch (error) {
      elizaLogger.error(`[SttTtsPlugin] Error converting PCM to WAV: ${error.message}`);
      throw new Error(`Failed to convert PCM to WAV: ${error.message}`);
    }
  }

  /**
   * Helper method to write a string to a DataView at a specific offset
   */
  private writeString(view: DataView, offset: number, string: string): void {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  init(params: { space: Space; pluginConfig?: Record<string, any> }): void {
    elizaLogger.log('[SttTtsPlugin] init => Space fully ready. Subscribing to events.');

    this.space = params.space;
    this.botProfile = params.pluginConfig?.user;
    this.janus = (this.space as any)?.janusClient as JanusClient | undefined;

    const config = params.pluginConfig as PluginConfig;
    this.runtime = config?.runtime;
    this.client = config?.client;
    this.spaceId = config?.spaceId;
    this.elevenLabsApiKey = config?.elevenLabsApiKey;
    if (config?.voiceId) {
      this.voiceId = config.voiceId;
    }
    if (config?.elevenLabsModel) {
      this.elevenLabsModel = config.elevenLabsModel;
    }
    if (config?.chatContext) {
      this.chatContext = config.chatContext;
    }
    this.grokApiKey = config?.grokApiKey ?? this.runtime.getSetting('GROK_API_KEY');
    this.grokBaseUrl = config?.grokBaseUrl ?? this.runtime.getSetting('GROK_BASE_URL') ?? 'https://api.x.ai/v1';

    if (isEmpty(this.grokApiKey)) {
      throw new Error('Grok API key is required');
    }
    if (isEmpty(this.grokBaseUrl)) {
      throw new Error('Grok base URL is required');
    }

    this.openai = new OpenAI({
      apiKey: this.grokApiKey,
      baseURL: this.grokBaseUrl,
    });

    // Initialize Deepgram
    this.initializeDeepgram();
  }

  private initializeDeepgram(): void {
    try {
      // Initialize Deepgram
      this.deepgramApiKey = this.runtime.getSetting('DEEPGRAM_API_KEY');
      console.log("Initializing Deepgram with API key:", this.deepgramApiKey);
      this.deepgram = createClient(this.deepgramApiKey);

      // Configure Deepgram with proper audio settings
      // Note: Make sure these settings match your audio format from Janus
      this.socket = this.deepgram.listen.live({
        language: "en",
        punctuate: true,
        smart_format: false,
        filler_words: true,
        unknown_words: true,
        model: "nova-3",
        encoding: "linear16", // PCM 16-bit
        sample_rate: 48000, // Adjust to match your Janus audio configuration
        channels: 1, // Mono audio
        interim_results: true,
        utterance_end_ms: 1000,
        vad_events: true,
        endpointing: 300, // Time in milliseconds of silence to wait for before finalizing speech
      });

      console.log("Deepgram socket created");

      if (this.keepAlive) clearInterval(this.keepAlive);
      this.keepAlive = setInterval(() => {
        if (this.socket && this.socket.getReadyState() === 1) { // Only send keepalive if socket is open
          this.socket.keepAlive();
        }
      }, 10 * 1000);

      // Setup event listeners outside of the Open event to ensure they're registered
      // before any messages arrive
      this.socket.addListener(LiveTranscriptionEvents.Transcript, (data: TranscriptData) => {
        console.log(`deepgram: transcript received isFinal: ${data.is_final} transcript: ${data.channel?.alternatives?.[0]?.transcript}`);
        if (data && this.lastSpeaker) {
          this.handleTranscription(data?.channel?.alternatives?.[0]?.transcript, data.is_final, this.lastSpeaker);
        }
      });

      this.socket.addListener(LiveTranscriptionEvents.UtteranceEnd, (data: TranscriptData) => {
        console.log(`deepgram: utterance end received isFinal: ${data.is_final} transcript: ${data.channel?.alternatives?.[0]?.transcript} data: ${JSON.stringify(data)}`);
        if (data && this.lastSpeaker) {
          // Even if transcript is undefined in the utterance end event,
          // we still want to process what's in the buffer
          const hasBuffer = this.transcriptBuffer.has(this.lastSpeaker) && 
                            isNotEmpty(this.transcriptBuffer.get(this.lastSpeaker)?.trim());
          
          if (hasBuffer) {
            elizaLogger.log(`[SttTtsPlugin] Processing due to utterance end: ${this.transcriptBuffer.get(this.lastSpeaker)}`);
            this.processBufferedTranscription(this.lastSpeaker);
          }
        }
      });

      this.socket.addListener(LiveTranscriptionEvents.Close, async (test) => {
        console.log("deepgram: disconnected", test);
        if (this.keepAlive) {
          clearInterval(this.keepAlive);
          this.keepAlive = null;
        }
        this.socket.finish();
        
        // Attempt to reconnect after a delay
        setTimeout(() => {
          console.log("deepgram: attempting to reconnect");
          this.initializeDeepgram();
        }, 5000);
      });

      this.socket.addListener(LiveTranscriptionEvents.Error, async (error: any) => {
        console.log("deepgram: error received");
        console.error(error);
      });

      this.socket.addListener(LiveTranscriptionEvents.Unhandled, async (warning: any) => {
        console.log("deepgram: unhandled received");
        console.warn(warning);
      });

      this.socket.addListener(LiveTranscriptionEvents.Metadata, (data: any) => {
        console.log("deepgram: metadata received", JSON.stringify(data));
        this.eventEmitter.emit('metadata', data);
      });

      // The Open event should be the last listener added
      this.socket.addListener(LiveTranscriptionEvents.Open, async () => {
        console.log("deepgram: connected successfully");

        // Send a silent audio buffer to test the connection
        const silentBuffer = new Int16Array(960).fill(0);
        this.socket.send(silentBuffer.buffer);

        console.log("deepgram: sent initial silent buffer to test connection");
      });
    } catch (error) {
      console.error("Error initializing Deepgram:", error);
      throw error;
    }
  }

  /**
   * Calculate the energy of an audio frame
   */
  private calculateEnergy(samples: Int16Array): number {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += Math.abs(samples[i]);
    }
    return sum / samples.length;
  }

  /**
   * Called whenever we receive PCM from a speaker
   */
  public onAudioData(data: AudioDataWithUser): void {
    if (this.isSpeaking) {
      const energy = this.calculateEnergy(data.samples);
      if (energy > this.interruptionThreshold) {
        this.interruptionCounter++;
        if (this.interruptionCounter >= this.consecutiveFramesForInterruption) {
          this.stopSpeaking();
          this.interruptionCounter = 0;
        }
      } else {
        this.interruptionCounter = 0;
      }
    }

    // Update the last speaker
    this.lastSpeaker = data.userId;

    // Make sure socket is ready before sending data
    if (this.socket && this.socket.getReadyState() === 1) { // WebSocket.OPEN
      try {
        // Skip bot's audio to prevent feedback loops
        if (this.botProfile.id === data.userId) {
          return;
        }

        // Check if buffer is empty or contains no voice
        const energy = this.calculateEnergy(data.samples);
        const isSilent = energy < 50; // Adjust this threshold based on your audio environment

        if (data.samples.length === 0 || isSilent) {
          return;
        }

        // Create a copy of the audio samples to avoid modifying the original data
        const audioSamples = new Int16Array(data.samples);
        
        // Normalize audio levels for better recognition
        const normalizedSamples = this.normalizeAudioLevels(audioSamples);
        
        // Ensure we're sending the buffer correctly
        const audioBuffer = normalizedSamples.buffer;
        
        // Stream audio data directly to Deepgram
        elizaLogger.debug(`[SttTtsPlugin] Streaming audio data to Deepgram: ${normalizedSamples.length} samples, energy: ${energy}`);
        this.socket.send(audioBuffer);
      } catch (error) {
        console.error("Error sending audio to Deepgram:", error);
      }
    }
  }

  /**
   * Handle transcriptions from Deepgram
   */
  private handleTranscription(transcript: string, isFinal: boolean, userId: string): void {
    if (isEmpty(transcript) || isEmpty(userId)) {
      elizaLogger.warn('[SttTtsPlugin] Empty transcript or userId, skipping');
      return;
    }

    // Store the time of this transcription
    this.lastTranscriptionTime.set(userId, Date.now());
    
    // Update the transcript buffer - buffer the transcribed text instead of calling the LLM
    this.transcriptBuffer.set(userId, transcript);
    
    elizaLogger.log(`[SttTtsPlugin] Received transcript (${isFinal ? 'final' : 'interim'}): "${transcript}" for user: ${userId}`);
    
    // Clear any existing timeout for this user
    if (this.processingTimeout.has(userId)) {
      clearTimeout(this.processingTimeout.get(userId));
    }
    
    // If this is a final transcript, process it immediately
    if (isFinal) {
      elizaLogger.log(`[SttTtsPlugin] Processing final transcript for user: ${userId}`);
      this.processBufferedTranscription(userId);
    } else {
      // Set a timeout to process if we don't receive any more transcripts soon
      // Use a more aggressive 200ms timeout instead of 500ms
      this.processingTimeout.set(
        userId,
        setTimeout(() => {
          const lastTime = this.lastTranscriptionTime.get(userId) || 0;
          const elapsed = Date.now() - lastTime;
          
          // If no new transcripts in the last 200ms, process what we have
          if (elapsed >= this.timeoutDuration) {
            elizaLogger.log(`[SttTtsPlugin] Processing transcript due to timeout (${elapsed}ms) for user: ${userId}`);
            this.processBufferedTranscription(userId);
          }
        }, this.timeoutDuration) // 200ms timeout (more aggressive)
      );
    }
  }

  /**
   * Process the buffered transcription for a user
   */
  private processBufferedTranscription(userId: string): void {
    const bufferedTranscript = this.transcriptBuffer.get(userId);
    
    // Clear the buffer and all timeouts for this user
    this.transcriptBuffer.delete(userId);
    this.clearUserTimeouts(userId);
    this.lastTranscriptionTime.delete(userId);
    
    // Process if there's content in the buffer
    if (isNotEmpty(bufferedTranscript?.trim())) {
      elizaLogger.log(`[SttTtsPlugin] Processing buffered transcription: "${bufferedTranscript}"`);
      this.processTranscription(userId, bufferedTranscript).catch((err) =>
        elizaLogger.error('[SttTtsPlugin] processTranscription error:', err)
      );
    }
  }

  /**
   * Clear all timeouts for a user
   */
  private clearUserTimeouts(userId: string): void {
    // Clear processing timeout
    if (this.processingTimeout.has(userId)) {
      clearTimeout(this.processingTimeout.get(userId));
      this.processingTimeout.delete(userId);
    }
    
    // Clear inactivity timeout
    if (this.inactivityTimer.has(userId)) {
      clearTimeout(this.inactivityTimer.get(userId));
      this.inactivityTimer.delete(userId);
    }
  }

  /**
   * Stop the bot's speech when interrupted
   */
  private stopSpeaking(): void {
    if (this.ttsAbortController) {
      this.ttsAbortController.abort();
      this.ttsAbortController = null;
    }
    this.isSpeaking = false;
    this.ttsQueue = []; // Clear the queue
    elizaLogger.log('[SttTtsPlugin] Bot speech interrupted by user');
  }

  /**
   * Process final transcription for response
   */
  private async processTranscription(userId: string, transcript: string): Promise<void> {
    try {
      // If we're already processing, just queue this request and return
      if (this.isProcessingAudio) {
        console.log('[SttTtsPlugin] Already processing audio, queueing this request');
        
        // Replace any existing message from this user with the newer one
        this.pendingMessages.set(userId, transcript);
        return;
      }
      
      const transcriptLen = transcript?.trim()?.length ?? 0
      // Check if the transcript is too short to be meaningful
      if (transcriptLen< 5) {
        console.log('[SttTtsPlugin] Transcript too short, ignoring:', transcript);
        return;
      }
      
      this.isProcessingAudio = true;
      
      // Generate a unique stream ID for this response
      const streamId = uuidv4();
      this.currentStreamId = streamId;
      this.activeStreams.add(streamId);
      
      elizaLogger.log(`[SttTtsPlugin] Starting stream with ID: ${streamId} for transcript: ${transcript}`);
      
      // Abort any previous streams
      this.abortPreviousStreams();
      
      // Reset the text buffer
      this.textBuffer = '';
      
      // Create named handler functions for this specific stream
      const handleChunkForStream = (text: string, chunkStreamId: string) => {
        // Only process chunks for the current stream
        if (chunkStreamId === streamId) {
          this.bufferTextForTTS(text, streamId);
        } else {
          elizaLogger.debug(`[SttTtsPlugin] Ignoring chunk from different stream. Expected: ${streamId}, Got: ${chunkStreamId}`);
        }
      };
      
      const handleStreamEnd = (endStreamId?: string) => {
        // Only clean up if this is our stream
        if (!endStreamId || !this.activeStreams.has(endStreamId)) {
          elizaLogger.debug(`[SttTtsPlugin] Ignoring stream-end from outdated stream`);
          return;
        }
        
        console.log('[SttTtsPlugin] Stream ended for user:', userId);
        elizaLogger.log(
          `[SttTtsPlugin] user=${userId}, complete reply="${this.textBuffer}"`,
        );

        // Only remove listeners specific to this stream
        this.eventEmitter.removeListener('stream-chunk', handleChunkForStream);
        this.eventEmitter.removeListener('stream-end', handleStreamEnd);
      };
      
      // Attach event listeners for this stream
      this.eventEmitter.on('stream-chunk', handleChunkForStream);
      this.eventEmitter.once('stream-end', handleStreamEnd);

      // Start the streaming response from Grok
      await this.handleUserMessageStreaming(transcript, userId);
    } catch (error) {
      // Handle both transcription errors and general errors
      if (
        error.name === 'TranscriptionError' ||
        error.message?.includes('transcription')
      ) {
        elizaLogger.error(`[SttTtsPlugin] Transcription error: ${error}`, {
          userId,
          audioBufferSize: 0,
          sampleRate: 0,
          error,
        });
      } else {
        elizaLogger.error('[SttTtsPlugin] processTranscription error =>', error);
      }
    } finally {
      // Reset the processing flag
      this.isProcessingAudio = false;
    }
  }
  
  /**
   * Handle User Message with streaming support
   */
  private async handleUserMessageStreaming(userText: string, userId: string): Promise<void> {
    // Create a new stream ID if one doesn't exist
    if (!this.currentStreamId) {
      const newStreamId = uuidv4();
      elizaLogger.log(`[SttTtsPlugin] Creating new stream ID: ${newStreamId} as none exists`);
      this.currentStreamId = newStreamId;
      this.activeStreams.add(newStreamId);
    }
    
    const streamId = this.currentStreamId;
    
    // Double-check the stream is active
    if (!this.activeStreams.has(streamId)) {
      elizaLogger.warn(`[SttTtsPlugin] Stream ${streamId} not found in active streams, adding it`);
      this.activeStreams.add(streamId);
    }

    elizaLogger.log(`[SttTtsPlugin] Handling user message with stream ID: ${streamId}`);

    const numericId = userId.replace('tw-', '');
    const roomId = stringToUuid(`twitter_generate_room-${this.spaceId}`);
    const userUuid = stringToUuid(`twitter-user-${numericId}`);

    await Promise.all([
      this.runtime.ensureUserExists(
        userUuid,
        userId,
        `Twitter User ${numericId}`,
        'twitter',
      ),
      this.runtime.ensureRoomExists(roomId),
      this.runtime.ensureParticipantInRoom(userUuid, roomId),
    ]).catch((error) => {
      elizaLogger.warn(`Error when handling streaming for spaces error ${error} ignoring`);
      return;
    });

    const memory = {
      id: stringToUuid(`${roomId}-voice-message-${Date.now()}`),
      agentId: this.runtime.agentId,
      content: { text: userText, source: 'twitter' },
      userId: userUuid,
      roomId,
      embedding: getEmbeddingZeroVector(),
      createdAt: Date.now(),
    };

    const [state] = await Promise.all([
      this.runtime.composeState(
        {
          agentId: this.runtime.agentId,
          content: { text: userText, source: 'twitter' },
          userId: userUuid,
          roomId,
        },
        {
          twitterUserName: this.client.profile.username,
          agentName: this.runtime.character.name,
        },
      ),
      Promise.resolve(),
    ]);

    const shouldIgnore = await this._shouldIgnore(memory);
    if (shouldIgnore) {
      return;
    }

    const context = composeContext({
      state,
      template: twitterSpaceTemplate,
    });

    const systemMessage = { role: 'system' as const, content: context };
    const userMessage = { role: 'user' as const, content: userText };
    const messages = [...this.chatContext, systemMessage, userMessage];

    if (!this.activeStreams.has(streamId) || this.ttsAbortController?.signal.aborted) {
      elizaLogger.log('[SttTtsPlugin] Stream was aborted before API call, cancelling');
      this.eventEmitter.emit('stream-end', streamId);
      return;
    }

    const stream = await this.openai.chat.completions.create({
      model: 'grok-2-latest',
      messages,
      stream: true,
    });

    let fullResponse = '';
    let bufferedText = '';
    let potentialActionMarker = false;
    let detectedAction = '';

    console.log('[SttTtsPlugin] Starting to process OpenAI stream chunks');

    for await (const chunk of stream) {
      console.log('[SttTtsPlugin] Received chunk:', JSON.stringify(chunk));
      
      const content = chunk.choices[0]?.delta?.content || '';
      console.log('[SttTtsPlugin] Extracted content:', content);
      
      if (!content) {
        console.log('[SttTtsPlugin] Empty content, skipping chunk');
        continue;
      }

      fullResponse += content;

      // Check if this chunk contains or starts an action marker
      if (content.includes('actionIs:') || content.includes('```actionIs:')) {
        // If we find the action marker, extract only the text before it
        const parts = content.split(/(\`\`\`actionIs:|actionIs:)/);
        if (parts.length > 1) {
          // Send only the text before the marker to TTS
          const textBeforeAction = parts[0].trim();
          if (textBeforeAction) {
            console.log('[SttTtsPlugin] Emitting chunk with text before action:', textBeforeAction);
            this.eventEmitter.emit('stream-chunk', textBeforeAction, streamId);
          }
          
          // Extract the action name
          const actionMatch = /actionIs:([A-Z_]+)/.exec(content);
          if (actionMatch) {
            detectedAction = actionMatch[1];
            elizaLogger.log(`[SttTtsPlugin] Detected action: ${detectedAction}`);
          }
          
          potentialActionMarker = true;
          continue;
        }
      }
      
      // Handle potential action continuation
      if (potentialActionMarker) {
        // Check if we're still in an action block
        if (content.includes('```')) {
          potentialActionMarker = false;
          
          // Extract any text after the action block
          const parts = content.split(/\`\`\`/);
          if (parts.length > 1 && parts[1].trim()) {
            console.log('[SttTtsPlugin] Emitting chunk with text after action:', parts[1].trim());
            this.eventEmitter.emit('stream-chunk', parts[1].trim(), streamId);
          }
        }
        // Skip content that's part of an action block
        continue;
      }
      
      // Normal text content - buffer it and emit when appropriate
      bufferedText += content;
      
      // If we have accumulated enough text or hit natural break points, emit it
      const hasNaturalBreak = /[.!?]\s*$/.test(bufferedText) || // Ends with punctuation
                           /\n\s*$/.test(bufferedText);       // Ends with newline
      
      if (hasNaturalBreak || bufferedText.length > 20) {
        console.log('[SttTtsPlugin] Emitting chunk with buffered text:', bufferedText);
        this.eventEmitter.emit('stream-chunk', bufferedText, streamId);
        bufferedText = '';
      }
    }
    
    // Emit any remaining buffered text
    if (bufferedText.trim()) {
      console.log('[SttTtsPlugin] Emitting final buffered text:', bufferedText);
      this.eventEmitter.emit('stream-chunk', bufferedText, streamId);
    }
    
    // Add the complete message to our conversation history
    this.addMessage('user', userText);
    this.addMessage('assistant', fullResponse);
    
    // Signal that the stream has ended
    this.eventEmitter.emit('stream-end', streamId);
  }

  /**
   * Abort any ongoing TTS and streaming processes
   */
  private abortPreviousStreams(): void {
    if (this.ttsAbortController) {
      elizaLogger.log('[SttTtsPlugin] Aborting previous TTS stream');
      this.ttsAbortController.abort();
    }
    this.ttsAbortController = new AbortController();
    this.activeStreams.clear();
    this.currentStreamId = null;
    this.eventEmitter.removeAllListeners();
    elizaLogger.log('[SttTtsPlugin] Cleanup complete');
  }

  /**
   * Smart text buffering for TTS
   * This buffers text until we have a natural break point or enough characters
   */
  private bufferTextForTTS(text: string, streamId: string): void {
    // Enhanced stream ID handling
    if (!this.currentStreamId || !this.activeStreams.has(streamId)) {
      // Try to recover by creating a new stream ID if needed
      if (!this.currentStreamId) {
        elizaLogger.warn('[SttTtsPlugin] No current stream ID found, creating a new one');
        const newStreamId = uuidv4();
        this.currentStreamId = newStreamId;
        this.activeStreams.add(newStreamId);
        // Continue with the new stream ID
        streamId = newStreamId;
      } else if (!this.activeStreams.has(streamId)) {
        elizaLogger.warn(`[SttTtsPlugin] Stream ID ${streamId} is no longer active, attempting to re-use current stream ID`);
        // Use the current stream ID instead if it exists
        if (this.activeStreams.has(this.currentStreamId)) {
          streamId = this.currentStreamId;
        } else {
          // If current stream ID is also inactive, create a new one
          elizaLogger.warn(`[SttTtsPlugin] Current stream ID ${this.currentStreamId} is also inactive, creating a new one`);
          const newStreamId = uuidv4();
          this.currentStreamId = newStreamId;
          this.activeStreams.add(newStreamId);
          streamId = newStreamId;
        }
      }
    }

    if (!text) {
      return;
    }
    
    // Append the new text to our buffer
    this.textBuffer += text;
    
    // Clear any existing timeout
    if (this.textBufferTimeout) {
      clearTimeout(this.textBufferTimeout);
    }
    
    // Check if there's a natural break or if we've reached the max buffer size
    const hasNaturalBreak = /[.!?]\s*$/.test(this.textBuffer) || // Ends with punctuation
                           /\n\s*$/.test(this.textBuffer);       // Ends with newline
    
    if (
      hasNaturalBreak ||
      this.textBuffer.length >= this.MAX_TTS_BUFFER_SIZE
    ) {
      // Flush immediately if we have a natural break or reached max size
      this.flushBuffer();
    } else if (this.textBuffer.length >= this.MIN_TTS_BUFFER_SIZE) {
      // If we have enough characters but no natural break,
      // set a timeout to flush soon if no more text arrives
      this.textBufferTimeout = setTimeout(() => {
        this.flushBuffer();
      }, this.TTS_BUFFER_TIMEOUT);
    }
  }

  /**
   * Flush the text buffer to TTS
   */
  private flushBuffer(): void {
    if (!this.textBuffer) {
      return;
    }
    
    // Check if we have a valid current stream ID
    if (!this.currentStreamId) {
      elizaLogger.warn('[SttTtsPlugin] No current stream ID for TTS, creating a new one');
      this.currentStreamId = uuidv4();
      this.activeStreams.add(this.currentStreamId);
    }
    
    // Ensure the current stream ID is in active streams
    if (!this.activeStreams.has(this.currentStreamId)) {
      elizaLogger.warn(`[SttTtsPlugin] Current stream ID ${this.currentStreamId} is not active, adding it`);
      this.activeStreams.add(this.currentStreamId);
    }
    
    // Send the buffered text to TTS queue
    const textToSpeak = this.textBuffer;
    this.textBuffer = ''; // Clear the buffer
    
    elizaLogger.log(`[SttTtsPlugin] Flushing buffer to TTS: "${textToSpeak}"`);
    
    this.speakText(textToSpeak).catch((err) => {
      elizaLogger.error('[SttTtsPlugin] Error speaking text:', err);
    });
  }

  /**
   * Public method to queue a TTS request
   */
  public async speakText(text: string): Promise<void> {
    console.log(`[SttTtsPlugin] Adding text to TTS queue: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
    this.ttsQueue.push(text);
    if (!this.isSpeaking) {
      this.isSpeaking = true;
      try {
        await this.processTtsQueue();
      } catch (err) {
        console.error('[SttTtsPlugin] processTtsQueue error =>', err);
        elizaLogger.error('[SttTtsPlugin] processTtsQueue error =>', err);
        // Reset the speaking state to allow future processing attempts
        this.isSpeaking = false;
      }
    }
  }

  /**
   * Process the TTS queue
   */
  private async processTtsQueue(): Promise<void> {
    try {
      while (this.ttsQueue.length > 0) {
        const text = this.ttsQueue.shift();
        if (!text) continue;

        this.ttsAbortController = new AbortController();
        const { signal } = this.ttsAbortController;

        await this.streamTtsToJanus(text, signal);

        if (signal.aborted) {
          elizaLogger.log('[SttTtsPlugin] TTS streaming was interrupted');
          return;
        }
      }
    } catch (error) {
      elizaLogger.error('[SttTtsPlugin] Queue processing error =>', error);
    } finally {
      this.isSpeaking = false;
    }
  }

  /**
   * Stream TTS to Janus
   */
  private async streamTtsToJanus(text: string, signal: AbortSignal): Promise<void> {
    // Add natural pauses at punctuation to make speech sound more natural
    const textWithPauses = text
      .replace(/\.\s+/g, '. <break time="10ms"/> ')
      .replace(/,\s+/g, ', <break time="5ms"/> ')
      .replace(/\?\s+/g, '? <break time="10ms"/> ')
      .replace(/!\s+/g, '! <break time="10ms"/> ')
      .replace(/;\s+/g, '; <break time="10ms"/> ')
      .replace(/:\s+/g, ': <break time="5ms"/> ');
    

    if (!this.janus) {
      elizaLogger.error('[SttTtsPlugin] No Janus client available for streaming TTS');
      return;
    }

    const mp3Stream = new PassThrough();
    let processingComplete = false;
    let isInterrupted = false;

    if (signal.aborted) {
      mp3Stream.end();
      return;
    }

    signal.addEventListener('abort', () => {
      isInterrupted = true;
      mp3Stream.end();
    });

    const ffmpeg = spawn('ffmpeg', [
      '-i', 'pipe:0',
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      '-ar', '48000',
      '-ac', '1',
      'pipe:1',
    ]);

    ffmpeg.on('error', (err) => {
      console.error('[SttTtsPlugin] FFMPEG process error:', err);
      elizaLogger.error('[SttTtsPlugin] FFMPEG process error:', err);
      isInterrupted = true;
    });

    const audioBuffer: Int16Array[] = [];
    const processingPromise = new Promise<void>((resolve, reject) => {
      let pcmBuffer = Buffer.alloc(0);
      let bufferStats = {
        totalChunks: 0,
        totalBytes: 0,
        emptyChunks: 0
      };

      ffmpeg.stdout.on('data', (chunk: Buffer) => {
        if (isInterrupted || signal.aborted) return;

        bufferStats.totalChunks++;
        bufferStats.totalBytes += chunk.length;
        
        if (chunk.length === 0) {
          bufferStats.emptyChunks++;
          console.warn('[SttTtsPlugin] Received empty chunk from FFmpeg');
          return;
        }

        pcmBuffer = Buffer.concat([pcmBuffer, chunk]);
        const FRAME_SIZE = 480;
        const frameCount = Math.floor(pcmBuffer.length / (FRAME_SIZE * 2));

        if (frameCount > 0) {
          try {
            for (let i = 0; i < frameCount; i++) {
              // Check for valid slice parameters
              const startOffset = i * FRAME_SIZE * 2 + pcmBuffer.byteOffset;
              const endOffset = (i + 1) * FRAME_SIZE * 2 + pcmBuffer.byteOffset;
              
              if (startOffset >= pcmBuffer.buffer.byteLength || endOffset > pcmBuffer.buffer.byteLength) {
                console.error(`[SttTtsPlugin] Invalid buffer slice: start=${startOffset}, end=${endOffset}, bufferLength=${pcmBuffer.buffer.byteLength}`);
                continue;
              }
              
              const frame = new Int16Array(
                pcmBuffer.buffer.slice(
                  startOffset,
                  endOffset,
                ),
              );
              
              // Check for invalid audio data
              let invalidData = false;
              for (let j = 0; j < 5 && j < frame.length; j++) {
                if (isNaN(frame[j]) || !isFinite(frame[j])) {
                  invalidData = true;
                  break;
                }
              }
              
              if (invalidData) {
                console.error('[SttTtsPlugin] Invalid audio data detected in frame');
                continue;
              }
              
              const frameCopy = new Int16Array(FRAME_SIZE);
              frameCopy.set(frame);
              audioBuffer.push(frameCopy);
            }
            
            pcmBuffer = pcmBuffer.slice(frameCount * FRAME_SIZE * 2);
          } catch (err) {
            console.error('[SttTtsPlugin] Error processing audio frames:', err);
          }
        }
      });
      
      ffmpeg.stdout.on('end', () => {
        processingComplete = true;
        if (pcmBuffer.length > 0) {
          const remainingFrames = Math.floor(pcmBuffer.length / 2);
          if (remainingFrames > 0) {
            const frame = new Int16Array(remainingFrames);
            for (let i = 0; i < remainingFrames; i++) {
              frame[i] = pcmBuffer.readInt16LE(i * 2);
            }
            audioBuffer.push(frame);
          }
        }
        resolve();
      });

      ffmpeg.stdout.on('error', (err) => {
        elizaLogger.error('[SttTtsPlugin] FFMPEG stdout error:', err);
        reject(err);
      });
    });

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/stream?optimize_streaming_latency=3`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': this.elevenLabsApiKey || '',
        },
        body: JSON.stringify({
          text: textWithPauses,
          model_id: this.elevenLabsModel,
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      },
    );

    if (!response.ok || !response.body) {
      throw new Error(`ElevenLabs API error: ${response.status} ${response.statusText}`);
    }

    const reader = response.body.getReader();
    const readStream = async () => {
      try {
        while (true) {
          if (isInterrupted || signal.aborted) break;
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            ffmpeg.stdin.write(value);
          }
        }
      } catch (err) {
        elizaLogger.error('[SttTtsPlugin] Error reading from ElevenLabs stream:', err);
      } finally {
        ffmpeg.stdin.end();
      }
    };

    readStream();

    await Promise.race([
      processingPromise.catch((err) => {
        elizaLogger.error('[SttTtsPlugin] Processing error:', err);
      }),
      new Promise<void>((resolve) => {
        const checkBuffer = () => {
          if (audioBuffer.length > 3 || signal.aborted || isInterrupted) {
            resolve();
          } else {
            setTimeout(checkBuffer, 10);
          }
        };
        checkBuffer();
      }),
    ]);

    let frameIndex = 0;
    const startTime = Date.now();

    while (
      (frameIndex < audioBuffer.length || !processingComplete) &&
      !isInterrupted &&
      !signal.aborted
    ) {
      if (frameIndex >= audioBuffer.length && !processingComplete) {
        await new Promise<void>((resolve) => {
          const waitForMoreFrames = () => {
            if (
              frameIndex < audioBuffer.length ||
              processingComplete ||
              isInterrupted ||
              signal.aborted
            ) {
              resolve();
            } else {
              setTimeout(waitForMoreFrames, 10);
            }
          };
          waitForMoreFrames();
        });
      }

      const idealPlaybackTime = startTime + frameIndex * 10;
      const currentTime = Date.now();

      if (currentTime < idealPlaybackTime) {
        await new Promise((r) => setTimeout(r, idealPlaybackTime - currentTime));
      } else if (currentTime > idealPlaybackTime + 100) {
        const framesToSkip = Math.floor((currentTime - idealPlaybackTime) / 10);
        if (framesToSkip > 0) {
          elizaLogger.log(`[SttTtsPlugin] Skipping ${framesToSkip} frames to catch up`);
          frameIndex += framesToSkip;
          continue;
        }
      }

      if (frameIndex < audioBuffer.length) {
        const frame = audioBuffer[frameIndex];
        const EXPECTED_SAMPLES = 480;
        if (frame.length !== EXPECTED_SAMPLES) {
          const properSizedFrame = new Int16Array(EXPECTED_SAMPLES);
          const copyLength = Math.min(frame.length, EXPECTED_SAMPLES);
          properSizedFrame.set(frame.subarray(0, copyLength));
          this.janus.pushLocalAudio(properSizedFrame, 48000);
        } else {
          this.janus.pushLocalAudio(frame, 48000);
        }
      }
      frameIndex++;
    }

    if (signal.aborted || isInterrupted) {
      elizaLogger.log('[SttTtsPlugin] Audio streaming was interrupted before completion');
    } else {
      elizaLogger.log('[SttTtsPlugin] Audio streaming completed successfully');
    }
  }


  /**
   * Should Ignore
   */
  private async _shouldIgnore(message: Memory): Promise<boolean> {
    const messageStr = message?.content?.text;
    const messageLen = messageStr?.length ?? 0;
    if (messageLen < 3) {
      return true;
    }

    const loseInterestWords = [
      'shut up', 'stop', 'dont talk', 'silence', 'stop talking', 'be quiet', 'hush', 'stfu',
      'stupid bot', 'dumb bot', 'fuck', 'shit', 'damn', 'suck', 'dick', 'cock', 'sex', 'sexy',
    ];
    if (messageLen < 50 && loseInterestWords.some((word) => messageStr?.toLowerCase()?.includes(word))) {
      return true;
    }

    const ignoreWords = ['k', 'ok', 'bye', 'lol', 'nm', 'uh'];
    if (messageStr?.length < 8 && ignoreWords.some((word) => messageStr?.toLowerCase()?.includes(word))) {
      return true;
    }

    return false;
  }

  /**
   * Add a message to the chat context
   */
  public addMessage(role: 'system' | 'user' | 'assistant', content: string) {
    this.chatContext.push({ role, content });
    elizaLogger.log(`[SttTtsPlugin] addMessage => role=${role}, content=${content}`);
  }

  /**
   * Clear the chat context
   */
  public clearChatContext() {
    this.chatContext = [];
    elizaLogger.log('[SttTtsPlugin] clearChatContext => done');
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.close();
      elizaLogger.log('[SttTtsPlugin] Deepgram WebSocket closed');
    }
    if (this.ttsAbortController) {
      this.ttsAbortController.abort();
      this.ttsAbortController = null;
    }
    this.activeStreams.clear();
    this.currentStreamId = null;
    this.eventEmitter.removeAllListeners();
    elizaLogger.log('[SttTtsPlugin] Cleanup complete');
  }
}