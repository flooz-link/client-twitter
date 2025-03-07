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
          this.socket.send(data.samples.buffer);
        }
      } catch (error) {
        console.error("Error sending audio to Deepgram:", error);
      }
    }
  }

  private calculateEnergy(samples: Int16Array): number {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += Math.abs(samples[i]);
    }
    return sum / samples.length;
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
        elizaLogger.log('[SttTtsPlugin] Already processing audio, skipping');
        return;
      }

      this.isProcessingAudio = true;

      // Abort any previous streams
      this.abortPreviousStreams();

      const streamId = uuidv4();
      this.currentStreamId = streamId;
      this.activeStreams.add(streamId);

      // Set up event listeners for handling the streaming response
      // These need to be set up BEFORE we start the streaming process
      console.log('[SttTtsPlugin] Setting up event listeners for stream ID:', streamId);
      
      // Handle each text chunk as it comes in
      this.eventEmitter.on('stream-chunk', (chunk: string, chunkStreamId?: string) => {
        // Ignore chunks from other streams
        if (chunkStreamId !== streamId) {
          console.log('[SttTtsPlugin] Ignoring chunk from different stream', chunkStreamId);
          return;
        }
        
        console.log(`[SttTtsPlugin] Processing stream chunk: "${chunk}"`);
        // Add the text to the TTS queue for processing
        this.speakText(chunk);
      });
      
      // Clean up when the stream ends
      this.eventEmitter.once('stream-end', (endStreamId?: string) => {
        // Only clean up if this is our stream
        if (endStreamId !== streamId) {
          console.log('[SttTtsPlugin] Ignoring stream-end from different stream', endStreamId);
          return;
        }
        
        console.log('[SttTtsPlugin] Stream ended, removing listeners');
        // Clean up the listeners when we're done
        this.eventEmitter.removeAllListeners('stream-chunk');
        this.eventEmitter.removeAllListeners('stream-end');
      });

      // Handle the transcription with streaming response
      await this.handleUserMessageStreaming(transcript, userId);
    } catch (error) {
      elizaLogger.error('[SttTtsPlugin] processTranscription error:', error);
    } finally {
      this.isProcessingAudio = false;
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
    elizaLogger.log(`[SttTtsPlugin] Streaming text to Janus: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);

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

    console.log('[SttTtsPlugin] Starting FFmpeg process for audio conversion');
    
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
          console.log(`[SttTtsPlugin] Processing ${frameCount} audio frames (${pcmBuffer.length} bytes)`);
          
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
          text,
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

      if (!potentialActionMarker && content.includes('action')) {
        potentialActionMarker = true;
        bufferedText += content;
        continue;
      }

      if (potentialActionMarker) {
        bufferedText += content;
        if (bufferedText.includes('actionIs:')) {
          const actionMatch = /actionIs:([A-Z_]+)/.exec(bufferedText);
          if (actionMatch) {
            detectedAction = actionMatch[1];
            const textBeforeAction = bufferedText.split('actionIs:')[0].trim();
            if (textBeforeAction) {
              console.log('[SttTtsPlugin] Emitting stream-chunk with action text:', textBeforeAction);
              this.eventEmitter.emit('stream-chunk', textBeforeAction, streamId);
            }
            bufferedText = '';
            potentialActionMarker = false;
          }
        } else if (bufferedText.length > 100) {
          console.log('[SttTtsPlugin] Emitting stream-chunk with buffered text:', bufferedText);
          this.eventEmitter.emit('stream-chunk', bufferedText, streamId);
          bufferedText = '';
          potentialActionMarker = false;
        }
        continue;
      }

      console.log('[SttTtsPlugin] Emitting stream-chunk with regular content:', content);
      this.eventEmitter.emit('stream-chunk', content, streamId);
    }

    if (bufferedText) {
      if (bufferedText.includes('actionIs:')) {
        const textBeforeAction = bufferedText.split('actionIs:')[0].trim();
        if (textBeforeAction) {
          console.log('[SttTtsPlugin] Emitting final stream-chunk with action text:', textBeforeAction);
          this.eventEmitter.emit('stream-chunk', textBeforeAction, streamId);
        }
        const actionMatch = /actionIs:([A-Z_]+)/.exec(bufferedText);
        if (actionMatch) {
          detectedAction = actionMatch[1];
          elizaLogger.log(`[SttTtsPlugin] Final detected action: ${detectedAction}`);
        }
      } else {
        console.log('[SttTtsPlugin] Emitting final stream-chunk with remaining buffered text:', bufferedText);
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
}