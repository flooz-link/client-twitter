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
  private timeoutDuration = 2000; // ms to wait before processing if no utterance end
  private inactivityTimer: Map<string, NodeJS.Timeout> = new Map();
  private inactivityDuration = 500; // ms of inactivity before flushing buffer
  private lastTranscriptionTime: Map<string, number> = new Map();

  // Smart text buffering for TTS
  private textBuffer = '';
  private textBufferTimeout: NodeJS.Timeout | null = null;
  private readonly MIN_TTS_BUFFER_SIZE = 20; // Minimum characters before sending to TTS
  private readonly MAX_TTS_BUFFER_SIZE = 150; // Maximum buffer size to prevent too long chunks
  private readonly TTS_BUFFER_TIMEOUT = 500; // ms to wait before flushing buffer if no natural breaks

  // Audio processing system
  private audioDataBuffer: Int16Array[] = [];
  private isProcessingAudioData = false;
  private readonly AUDIO_PROCESSING_INTERVAL = 100; // ms between audio processing checks
  private audioProcessingTimer: NodeJS.Timeout | null = null;

  // Audio buffer for processing speech
  private audioBuffer: Int16Array[] = [];

  // Debouncing mechanism
  private isProcessingMessage = false;
  private processingDebounceTimeout: NodeJS.Timeout | null = null;
  private pendingMessages: Map<string, string> = new Map(); // userId -> latestMessage
  private readonly MESSAGE_DEBOUNCE_TIME = 1000; // 1 second debounce time

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
    // number of channels
    const numChannels = 1;
    // byte rate = (sampleRate * numChannels * bitsPerSample/8)
    const byteRate = sampleRate * numChannels * 2;
    const blockAlign = numChannels * 2;
    // data chunk size = pcmData.length * (bitsPerSample/8)
    const dataSize = pcmData.length * 2;

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

    // Initialize audio processing system
    this.initAudioProcessing();
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
        this.socket.keepAlive();
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
        // const silentBuffer = new Int16Array(960).fill(0);
        // this.socket.send(silentBuffer.buffer);

        console.log("deepgram: sent initial silent buffer to test connection");
      });
    } catch (error) {
      console.error("Error initializing Deepgram:", error);
      throw error;
    }
  }

  /**
   * Initialize the audio processing system
   */
  private initAudioProcessing(): void {
    // Clear any existing timer
    if (this.audioProcessingTimer) {
      clearInterval(this.audioProcessingTimer);
    }
    
    // Start a periodic timer to process buffered audio data
    this.audioProcessingTimer = setInterval(() => {
      this.processAudioDataBuffer();
    }, this.AUDIO_PROCESSING_INTERVAL);
    
    console.log('[SttTtsPlugin] Audio processing system initialized');
  }

  /**
   * Process the audio data buffer
   */
  private async processAudioDataBuffer(): Promise<void> {
    // Don't process if already processing or no data
    if (this.isProcessingAudioData || this.audioDataBuffer.length === 0) {
      return;
    }
    
    try {
      this.isProcessingAudioData = true;
      
      // Get all frames from the buffer
      const frames = [...this.audioDataBuffer];
      this.audioDataBuffer = [];
      
      // Skip if no frames
      if (frames.length === 0) {
        return;
      }
      
      // Calculate total length
      const totalLength = frames.reduce((acc, frame) => acc + frame.length, 0);
      
      // Create a combined buffer for smoother audio
      const combinedBuffer = new Int16Array(totalLength);
      let offset = 0;
      
      // Copy frames with crossfade between adjacent frames to reduce clicks/pops
      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        
        // Simple copy for now, could implement crossfade for smoother transitions
        combinedBuffer.set(frame, offset);
        offset += frame.length;
      }
      
      // Send to Deepgram for transcription
      // The socket expects a full buffer not frames
      if (this.socket && this.socket.getReadyState() === 1) {
        this.socket.send(combinedBuffer.buffer);
      }
      
      // Now send to Janus directly, ensuring we split into 480-sample frames
      if (this.janus) {
        const JANUS_FRAME_SIZE = 480; // Janus requires exactly 480 samples per frame
        
        // Process buffer in chunks of exactly 480 samples
        for (let i = 0; i < combinedBuffer.length; i += JANUS_FRAME_SIZE) {
          // Check if we have enough samples for a full frame
          if (i + JANUS_FRAME_SIZE <= combinedBuffer.length) {
            // Important: Create a NEW Int16Array with exactly 480 samples
            // This ensures the underlying buffer is exactly the right size
            // Using subarray() would maintain a reference to the full buffer
            const frameData = combinedBuffer.subarray(i, i + JANUS_FRAME_SIZE);
            const frame = new Int16Array(frameData); // Copy to new buffer with exact size
            
            try {
              this.janus.pushLocalAudio(frame, 48000);
            } catch (err) {
              console.error('[SttTtsPlugin] Error pushing audio frame to Janus:', err);
            }
          } else {
            // Handle the remainder (partial frame) by padding with silence
            const remainingSamples = combinedBuffer.length - i;
            if (remainingSamples > 0) {
              // Create a frame with exactly 480 samples, filled with silence (zeros)
              const paddedFrame = new Int16Array(JANUS_FRAME_SIZE);
              // Copy the remaining samples
              paddedFrame.set(combinedBuffer.subarray(i));
              // Rest is already zeros (silence)
              
              try {
                console.log(`[SttTtsPlugin] Pushing final padded frame to Janus: ${paddedFrame.length} samples, byteLength: ${paddedFrame.buffer.byteLength}`);
                await this.janus.pushLocalAudio(paddedFrame, 48000);
              } catch (err) {
                console.error('[SttTtsPlugin] Error pushing final padded frame to Janus:', err);
              }
            }
          }
        }
      }
    } catch (err) {
      console.error('[SttTtsPlugin] Error processing audio data buffer:', err);
    } finally {
      this.isProcessingAudioData = false;
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
        if (this.botProfile.id !== data.userId) {

          // Check if buffer is empty or contains no voice
          const energy = this.calculateEnergy(data.samples);
          const isSilent = energy < 50; // Adjust this threshold based on your audio environment

          if (data.samples.length === 0 || isSilent) {
            return;
          }

          // Since the audio data is already in Int16Array format, send it directly
          // No need for conversion from Float32Array
          this.audioDataBuffer.push(data.samples);
        }
      } catch (error) {
        console.error("Error sending audio to Deepgram:", error);
      }
    }
  }

  /**
   * Handle transcriptions from Deepgram
   */
  private handleTranscription(transcript: string, isFinal: boolean, userId: string): void {
    elizaLogger.log(`[SttTtsPlugin] Transcription (${isFinal ? 'final' : 'interim'}): ${transcript} for user ${userId}`);

    // Update last transcription time
    this.lastTranscriptionTime.set(userId, Date.now());

    // If the bot is speaking and any transcription is received, stop it
    if (this.isSpeaking && isEmpty(transcript?.trim())) {
      this.stopSpeaking();
    }

    // Get the current buffer for this user or initialize an empty one
    const currentBuffer = this.transcriptBuffer.get(userId) || '';
    
    // For non-empty transcripts, update the buffer
    if (isNotEmpty(transcript?.trim())) {
      // Update the buffer with the new transcript
      // For interim results, replace the buffer
      // For final results or significant changes, append to buffer
      if (!isFinal && (currentBuffer.includes(transcript) || transcript.includes(currentBuffer))) {
        // This is likely an incremental update, so replace the buffer
        this.transcriptBuffer.set(userId, transcript);
      } else if (transcript !== currentBuffer) {
        // This is new content or a final result, so append with space if needed
        const separator = currentBuffer && !currentBuffer.endsWith(' ') && !transcript.startsWith(' ') ? ' ' : '';
        this.transcriptBuffer.set(userId, currentBuffer + separator + transcript);
      }

      // Clear any existing timeouts for this user
      this.clearUserTimeouts(userId);

      // If final, process immediately
      if (isFinal) {
        this.processBufferedTranscription(userId);
      } else {
        // Otherwise set a timeout to process if no utterance end is received
        const timeout = setTimeout(() => {
          elizaLogger.log(`[SttTtsPlugin] Processing transcript due to timeout: ${this.transcriptBuffer.get(userId)}`);
          this.processBufferedTranscription(userId);
        }, this.timeoutDuration);
        
        this.processingTimeout.set(userId, timeout);
        
        // Set inactivity timer to flush buffer after a period of no new transcripts
        const inactivityTimeout = setTimeout(() => {
          const lastTime = this.lastTranscriptionTime.get(userId) || 0;
          const elapsed = Date.now() - lastTime;
          
          if (elapsed >= this.inactivityDuration && this.transcriptBuffer.has(userId)) {
            elizaLogger.log(`[SttTtsPlugin] Processing transcript due to inactivity (${elapsed}ms): ${this.transcriptBuffer.get(userId)}`);
            this.processBufferedTranscription(userId);
          }
        }, this.inactivityDuration);
        
        this.inactivityTimer.set(userId, inactivityTimeout);
      }
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
      elizaLogger.log(`[SttTtsPlugin] Processing buffered transcription: ${bufferedTranscript}`);
      this.processTranscription(userId, bufferedTranscript).catch((err) =>
        elizaLogger.error('[SttTtsPlugin] processTranscription error:', err)
      );
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
      if (this.isProcessingAudio) {
        console.log('[SttTtsPlugin] Already processing audio, queueing this request');
        this.pendingMessages.set(userId, transcript);
        return;
      }
      
      this.isProcessingAudio = true;
      
      // Generate a unique stream ID for this response
      const streamId = uuidv4();
      this.currentStreamId = streamId;
      this.activeStreams.add(streamId);
      
      // Set up the abort controller for this stream
      if (this.ttsAbortController) {
        this.ttsAbortController.abort();
      }
      this.ttsAbortController = new AbortController();
      
      // Listen for chunks of the streamed response
      this.eventEmitter.on('stream-chunk', (chunk: string, chunkStreamId: string) => {
        // Only process chunks for our current stream
        if (chunkStreamId !== streamId) {
          console.log('[SttTtsPlugin] Ignoring chunk from different stream', chunkStreamId);
          return;
        }
        
        this.bufferTextForTTS(chunk, streamId);
      });
      
      // Clean up when the stream ends
      this.eventEmitter.once('stream-end', (endStreamId?: string) => {
        // Only clean up if this is our stream
        if (endStreamId !== streamId) {
          console.log('[SttTtsPlugin] Ignoring stream-end from different stream', endStreamId);
          return;
        }
        
        console.log('[SttTtsPlugin] Stream ended, flushing any remaining buffered text');
        
        // Flush any remaining text in the buffer
        if (this.textBuffer.length > 0) {
          console.log(`[SttTtsPlugin] Flushing final text buffer: "${this.textBuffer}"`);
          this.speakText(this.textBuffer);
          this.textBuffer = '';
        }
        
        // Clear any pending timeout
        if (this.textBufferTimeout) {
          clearTimeout(this.textBufferTimeout);
          this.textBufferTimeout = null;
        }
        
        console.log('[SttTtsPlugin] Removing event listeners');
        // Clean up the listeners when we're done
        this.eventEmitter.removeAllListeners('stream-chunk');
        this.eventEmitter.removeAllListeners('stream-end');
        
        // Check for pending messages
        setTimeout(() => {
          this.isProcessingAudio = false;
          this.processNextPendingMessage();
        }, 500);
      });

      // Handle the transcription with streaming response
      this.debouncedHandleUserMessageStreaming(transcript, userId);
    } catch (error) {
      elizaLogger.error('[SttTtsPlugin] processTranscription error:', error);
      this.isProcessingAudio = false;
    }
  }
  
  /**
   * Process the next pending message if any
   */
  private processNextPendingMessage(): void {
    if (this.pendingMessages.size > 0) {
      const entries = Array.from(this.pendingMessages.entries());
      const [userId, transcript] = entries[entries.length - 1]; // Take the most recent message
      this.pendingMessages.clear(); // Clear all pending messages
      
      console.log(`[SttTtsPlugin] Processing pending message for user ${userId}: "${transcript.substring(0, 50)}${transcript.length > 50 ? '...' : ''}"`);
      
      // Process the most recent pending message
      this.processTranscription(userId, transcript).catch(error => {
        elizaLogger.error('[SttTtsPlugin] Error processing pending message:', error);
      });
    }
  }
  
  /**
   * Debounced version of handleUserMessageStreaming to prevent multiple calls
   */
  private debouncedHandleUserMessageStreaming(userText: string, userId: string): void {
    if (this.processingDebounceTimeout) {
      clearTimeout(this.processingDebounceTimeout);
    }
    
    // Store the latest message from this user
    this.pendingMessages.set(userId, userText);
    
    // Set a timeout to handle the message
    this.processingDebounceTimeout = setTimeout(async () => {
      if (this.isProcessingMessage) {
        // Already processing, will be picked up by processNextPendingMessage later
        return;
      }
      
      this.isProcessingMessage = true;
      const latestMessage = this.pendingMessages.get(userId);
      
      if (latestMessage) {
        // Remove this message from pending
        this.pendingMessages.delete(userId);
        
        try {
          await this.handleUserMessageStreaming(latestMessage, userId);
        } catch (error) {
          elizaLogger.error('[SttTtsPlugin] Error in debouncedHandleUserMessageStreaming:', error);
        } finally {
          this.isProcessingMessage = false;
          // Check if we have more messages to process
          if (this.pendingMessages.size > 0) {
            this.processNextPendingMessage();
          }
        }
      } else {
        this.isProcessingMessage = false;
      }
    }, this.MESSAGE_DEBOUNCE_TIME);
  }

  /**
   * Handle User Message with streaming support
   */
  private async handleUserMessageStreaming(userText: string, userId: string): Promise<void> {
    const streamId = this.currentStreamId;
    if (!streamId || !this.activeStreams.has(streamId)) {
      elizaLogger.error('[SttTtsPlugin] No current stream ID found or stream is no longer active');
      return;
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
            elizaLogger.log(`[SttTtsPlugin] Detected action in chunk: ${detectedAction}`);
          }
          
          // Skip the rest of this chunk processing
          continue;
        }
      }
      
      // Check if we're in the process of identifying an action marker
      if (!potentialActionMarker && (content.includes('action') || content.includes('```'))) {
        potentialActionMarker = true;
        bufferedText += content;
        continue;
      }

      if (potentialActionMarker) {
        bufferedText += content;
        if (bufferedText.includes('actionIs:') || bufferedText.includes('```actionIs:')) {
          // Extract the parts before and after the action marker
          const parts = bufferedText.split(/(\`\`\`actionIs:|actionIs:)/);
          if (parts.length > 1) {
            const textBeforeAction = parts[0].trim();
            if (textBeforeAction) {
              console.log('[SttTtsPlugin] Emitting buffered text before action:', textBeforeAction);
              this.eventEmitter.emit('stream-chunk', textBeforeAction, streamId);
            }
            
            // Extract the action name
            const actionMatch = /actionIs:([A-Z_]+)/.exec(bufferedText);
            if (actionMatch) {
              detectedAction = actionMatch[1];
              elizaLogger.log(`[SttTtsPlugin] Detected action in buffer: ${detectedAction}`);
            }
          }
          bufferedText = '';
          potentialActionMarker = false;
        } else if (bufferedText.length > 100) {
          // If buffer gets too big without finding an action, just emit it
          console.log('[SttTtsPlugin] Emitting large buffered text (no action found):', bufferedText);
          this.eventEmitter.emit('stream-chunk', bufferedText, streamId);
          bufferedText = '';
          potentialActionMarker = false;
        }
        continue;
      }

      // Regular content, just emit it
      console.log('[SttTtsPlugin] Emitting regular chunk content:', content);
      this.eventEmitter.emit('stream-chunk', content, streamId);
    }

    // Process any remaining buffered text, being careful with action markers
    if (bufferedText) {
      if (bufferedText.includes('actionIs:') || bufferedText.includes('```actionIs:')) {
        // Extract only the text before the marker
        const parts = bufferedText.split(/(\`\`\`actionIs:|actionIs:)/);
        const textBeforeAction = parts[0].trim();
        if (textBeforeAction) {
          console.log('[SttTtsPlugin] Emitting final text before action:', textBeforeAction);
          this.eventEmitter.emit('stream-chunk', textBeforeAction, streamId);
        }
        
        // Extract the action
        const actionMatch = /actionIs:([A-Z_]+)/.exec(bufferedText);
        if (actionMatch) {
          detectedAction = actionMatch[1];
          elizaLogger.log(`[SttTtsPlugin] Final detected action: ${detectedAction}`);
        }
      } else {
        // No action marker, emit the whole buffer
        console.log('[SttTtsPlugin] Emitting final buffered text:', bufferedText);
        this.eventEmitter.emit('stream-chunk', bufferedText, streamId);
      }
    }

    if (detectedAction) {
      elizaLogger.log(`[SttTtsPlugin] Response contained action: ${detectedAction}`);
    }

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

  /**
   * Process audio from a user
   */
  public async processAudio(userId: string, audioData: Int16Array): Promise<void> {
    try {
      // Don't process audio if already processing
      if (this.isProcessingAudio) {
        elizaLogger.debug('[SttTtsPlugin] Already processing audio, skipping');
        return;
      }

      try {
        this.isProcessingAudio = true;

        // Abort any previous streams before starting a new one
        this.abortPreviousStreams();

        // Create a new stream ID and add it to active streams
        const streamId = uuidv4();
        this.currentStreamId = streamId;
        this.activeStreams.add(streamId);

        // Create an abort controller for this stream
        const signal = this.ttsAbortController?.signal;
        if (!signal || signal.aborted) {
          elizaLogger.log('[SttTtsPlugin] Abort signal already aborted, skipping processing');
          return;
        }

        // Initialize variables for TTS and streaming
        let wavBuffer: ArrayBuffer | null = null;
        let sttText = '';
        let merged: Int16Array | null = null;
        let optimizedPcm: Int16Array | null = null;

        // Store the audio buffer for processing
        this.audioBuffer = [...(this.audioBuffer || []), audioData];

        // Create a promise to merge the audio buffers
        const mergeBufferPromise = new Promise<Int16Array>((resolve, reject) => {
          try {
            // Combine all audio chunks into a single buffer for better processing
            let totalLength = 0;
            for (const buffer of this.audioBuffer) {
              totalLength += buffer.length;
            }

            const mergedBuffer = new Int16Array(totalLength);
            let offset = 0;

            for (const buffer of this.audioBuffer) {
              mergedBuffer.set(buffer, offset);
              offset += buffer.length;
            }

            // Clear the buffer after merging
            this.audioBuffer = [];

            resolve(mergedBuffer);
          } catch (error) {
            reject(error);
          }
        });

        // Process the merged audio buffer
        merged = await mergeBufferPromise;

        // Optimize audio for transcription by downsampling if needed
        optimizedPcm = this.maybeDownsampleAudio(merged, 48000, 16000);

        // Convert to WAV format for the transcription service
        wavBuffer = await this.convertPcmToWavInMemory(optimizedPcm, optimizedPcm === merged ? 48000 : 16000);
        sttText = await this.transcriptionService.transcribe(wavBuffer);

        // Setup variables for text handling
        let ttsBuffer = '';
        let accumulatedText = '';

        // Enable smart text buffering for TTS to avoid choppy speech
        const manageTtsBuffer = () => {
          if (ttsBuffer.length < this.MIN_TTS_BUFFER_SIZE) {
            return; // Not enough text yet
          }

          // Check for natural break points
          const hasStrongPunctuation = /[.!?](\s|$)/.test(ttsBuffer);
          const hasMediumPunctuation = /[;:](\s|$)/.test(ttsBuffer);
          const hasWeakPunctuation = /[,](\s|$)/.test(ttsBuffer);

          if (
            // Strong punctuation (end of sentence) and enough characters
            (hasStrongPunctuation && ttsBuffer.length >= 10) ||
            // Medium punctuation and enough characters
            (hasMediumPunctuation && ttsBuffer.length >= 15) ||
            // Weak punctuation and enough characters
            (hasWeakPunctuation && ttsBuffer.length >= this.MIN_TTS_BUFFER_SIZE) ||
            // Buffer getting too large
            ttsBuffer.length >= this.MAX_TTS_BUFFER_SIZE
          ) {
            processTtsChunk();
          }
        };

        // Process a chunk of text for TTS
        const processTtsChunk = () => {
          if (ttsBuffer.length === 0) return;
          
          const textToProcess = ttsBuffer;
          ttsBuffer = '';
          
          // Send to TTS and ignore if aborted
          if (!signal.aborted) {
            this.speakText(textToProcess);
          }
        };

        // Set up stream event listeners
        this.eventEmitter.on('stream-chunk', (chunk: string, chunkStreamId?: string) => {
          // Ignore chunks from other streams
          if (chunkStreamId !== streamId || signal.aborted) {
            elizaLogger.debug(`[SttTtsPlugin] Ignoring stream-chunk from outdated stream`);
            return;
          }
          
          if (typeof chunk !== 'string' || isEmpty(chunk)) {
            return;
          }

          // Add to accumulated text for logging
          accumulatedText += chunk;

          // Add to TTS buffer
          ttsBuffer += chunk;

          // Manage the buffer - this will decide when to process
          manageTtsBuffer();
        });

        // Clean up when stream ends
        this.eventEmitter.once('stream-end', (endStreamId?: string) => {
          // Ignore end events if this stream is no longer active
          if (!endStreamId || !this.activeStreams.has(endStreamId) || signal.aborted) {
            elizaLogger.debug(`[SttTtsPlugin] Ignoring stream-end from outdated stream`);
            return;
          }
          
          // Remove this stream from active streams
          this.activeStreams.delete(endStreamId);
          
          // Process any remaining text in the buffer
          if (ttsBuffer.length > 0 && !signal.aborted) {
            processTtsChunk();
          }

          elizaLogger.log('[SttTtsPlugin] Stream ended for user:', userId);
          elizaLogger.log(
            `[SttTtsPlugin] user=${userId}, complete reply="${accumulatedText}"`,
          );

          // Remove all stream listeners to prevent memory leaks
          this.eventEmitter.removeAllListeners('stream-chunk');
          this.eventEmitter.removeAllListeners('stream-start');
          this.eventEmitter.removeAllListeners('stream-end');
        });

        // Start the streaming response from Grok
        await this.handleUserMessageStreaming(sttText, userId);
      } catch (error) {
        // Handle both transcription errors and general errors
        if (
          error.name === 'TranscriptionError' ||
          error.message?.includes('transcription')
        ) {
          elizaLogger.error(`[SttTtsPlugin] Transcription error: ${error}`, {
            userId,
            audioBufferSize: wavBuffer?.byteLength || 0,
            sampleRate: optimizedPcm === merged ? 48000 : 16000,
            error,
          });
        } else {
          elizaLogger.error('[SttTtsPlugin] processAudio error =>', error);
        }
      } finally {
        // Reset the processing flag
        this.isProcessingAudio = false;
      }
    } catch (error) {
      elizaLogger.error('[SttTtsPlugin] processAudio error =>', error);
    }
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
   * Smart text buffering for TTS
   * This buffers text until we have a natural break point or enough characters
   */
  private bufferTextForTTS(text: string, streamId: string): void {
    // Append new text to buffer
    this.textBuffer += text;
    
    // Clear any existing timeout
    if (this.textBufferTimeout) {
      clearTimeout(this.textBufferTimeout);
      this.textBufferTimeout = null;
    }
    
    // Function to flush the buffer to TTS
    const flushBuffer = () => {
      if (this.textBuffer.length > 0) {
        console.log(`[SttTtsPlugin] Flushing text buffer to TTS: "${this.textBuffer.substring(0, 50)}${this.textBuffer.length > 50 ? '...' : ''}"`);
        this.speakText(this.textBuffer);
        this.textBuffer = '';
      }
    };
    
    // Determine if we have a natural break point
    const hasStrongPunctuation = /[.!?](\s|$)/.test(this.textBuffer);
    const hasMediumPunctuation = /[;:](\s|$)/.test(this.textBuffer);
    const hasWeakPunctuation = /[,](\s|$)/.test(this.textBuffer);
    
    // Decision logic for when to flush the buffer
    if (
      // Strong punctuation (end of sentence) and enough characters
      (hasStrongPunctuation && this.textBuffer.length >= 10) ||
      // Medium punctuation and enough characters
      (hasMediumPunctuation && this.textBuffer.length >= 15) ||
      // Weak punctuation and enough characters
      (hasWeakPunctuation && this.textBuffer.length >= this.MIN_TTS_BUFFER_SIZE) ||
      // Buffer getting too large
      this.textBuffer.length >= this.MAX_TTS_BUFFER_SIZE
    ) {
      flushBuffer();
    } else {
      // Set a timeout to flush the buffer if no more text arrives
      this.textBufferTimeout = setTimeout(() => {
        console.log('[SttTtsPlugin] Buffer timeout reached, flushing buffer');
        flushBuffer();
      }, this.TTS_BUFFER_TIMEOUT);
    }
  }
}