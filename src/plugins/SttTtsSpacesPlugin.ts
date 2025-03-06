import { spawn } from 'child_process';
import {
  type ITranscriptionService,
  elizaLogger,
  stringToUuid,
  composeContext,
  getEmbeddingZeroVector,
  generateMessageResponse,
  ModelClass,
  type Content,
  type IAgentRuntime,
  type Memory,
  type Plugin,
} from '@elizaos/core';
import type {
  Space,
  JanusClient,
  AudioDataWithUser,
} from '@flooz-link/agent-twitter-client';
import type { ClientBase } from '../base';
import {
  twitterSpaceTemplate,
  twitterVoiceHandlerTemplate,
} from './templates';
import { isEmpty } from '../utils';
import { PassThrough } from 'stream';
import { EventEmitter } from 'events';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';

// No Web Audio API polyfill needed, using native Node.js capabilities

interface PluginConfig {
  runtime: IAgentRuntime;
  client: ClientBase;
  spaceId: string;
  elevenLabsApiKey?: string; // for TTS
  sttLanguage?: string; // e.g. "en" for Whisper
  silenceThreshold?: number; // amplitude threshold for ignoring silence
  silenceDetectionWindow?: number; // time to detect silence
  voiceId?: string; // specify which ElevenLabs voice to use
  elevenLabsModel?: string; // e.g. "eleven_monolingual_v1"
  chatContext?: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
  transcriptionService: ITranscriptionService;
  grokApiKey?: string; // API key for Grok
  grokBaseUrl?: string; // Base URL for Grok API
}

const VOLUME_WINDOW_SIZE = 100;

/**
 * MVP plugin for speech-to-text (OpenAI) + conversation + TTS (ElevenLabs)
 * Approach:
 *   - Collect each speaker's unmuted PCM in a memory buffer (only if above silence threshold)
 *   - On speaker mute -> flush STT -> GPT -> TTS -> push to Janus
 */
export class SttTtsPlugin implements Plugin {
  name = 'SttTtsPlugin';
  description = 'Speech-to-text (OpenAI) + conversation + TTS (ElevenLabs)';
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
  private chatContext: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }> = [];

  /**
   * userId => arrayOfChunks (PCM Int16)
   */
  private pcmBuffers = new Map<string, Int16Array[]>();

  /**
   * For ignoring near-silence frames (if amplitude < threshold)
   */
  private silenceThreshold = 30; // Lowered from 50 to be more sensitive to quieter speech

  /**
   * Time to wait before detecting silence, defaults to 1 second, i.e. if no one speaks for 1 second then agent checks if it should respond
   */
  private silenceDetectionThreshold = 1000;

  // TTS queue for sequentially speaking
  private ttsQueue: string[] = [];
  private isSpeaking = false;
  private isProcessingAudio = false;

  private userSpeakingTimer: NodeJS.Timeout | null = null;
  private volumeBuffers: Map<string, number[]>;
  private ttsAbortController: AbortController | null = null;
  private currentStreamId: string | null = null;
  private activeStreams = new Set<string>();

  private eventEmitter = new EventEmitter();
  private openai: OpenAI;
  private transcriptionService: ITranscriptionService;

  private interruptAnalysisBuffer = new Int16Array(1024);
  private interruptBufferIndex = 0;
  private lastInterruptCheck = 0;

  private audioBuffer: Int16Array[] = [];
  private streamingInterval: NodeJS.Timeout | null = null;

  // Transcription buffer system to handle pauses in speech
  private transcriptionBuffers: Map<string, {
    text: string;
    timestamp: number;
  }> = new Map();
  private transcriptionBufferTimeout = 5000; // 5 seconds buffer window

  init(params: { space: Space; pluginConfig?: Record<string, any> }): void {
    elizaLogger.log(
      '[SttTtsPlugin] init => Space fully ready. Subscribing to events.',
    );

    this.space = params.space;
    this.janus = (this.space as any)?.janusClient as JanusClient | undefined;

    const config = params.pluginConfig as PluginConfig;
    this.runtime = config?.runtime;
    this.client = config?.client;
    this.spaceId = config?.spaceId;
    this.elevenLabsApiKey = config?.elevenLabsApiKey;
    this.transcriptionService = config.transcriptionService;
    if (typeof config?.silenceThreshold === 'number') {
      this.silenceThreshold = config.silenceThreshold;
    }
    if (typeof config?.silenceDetectionWindow === 'number') {
      this.silenceDetectionThreshold = config.silenceDetectionWindow;
    }
    if (typeof config?.silenceThreshold)
      if (config?.voiceId) {
        this.voiceId = config.voiceId;
      }
    if (config?.elevenLabsModel) {
      this.elevenLabsModel = config.elevenLabsModel;
    }
    if (config?.chatContext) {
      this.chatContext = config.chatContext;
    }
    this.grokApiKey =
      config?.grokApiKey ?? this.runtime.getSetting('GROK_API_KEY');
    this.grokBaseUrl =
      config?.grokBaseUrl ??
      this.runtime.getSetting('GROK_BASE_URL') ??
      'https://api.x.ai/v1';

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

    this.volumeBuffers = new Map<string, number[]>();
  }

  /**
   * Public method to queue a TTS request
   */
  public async speakText(text: string): Promise<void> {
    this.ttsQueue.push(text);
    if (!this.isSpeaking) {
      this.isSpeaking = true;
      this.processTtsQueue()
        .catch((err) => {
          elizaLogger.error('[SttTtsPlugin] processTtsQueue error =>', err);
        })
        .then((res) => {
          return res;
        });
    }
  }

  /**
   * Called whenever we receive PCM from a speaker
   */
  onAudioData(data: AudioDataWithUser): void {
    // Debug the incoming audio data
    elizaLogger.debug(
      `[SttTtsPlugin] Received audio data for user=${data.userId}, ` +
      `samples length=${data.samples.length}`
    );

    // CRITICAL FIX: Don't skip audio chunks when processing audio
    // This was causing the race condition where chunks were being lost
    // We'll still log it but continue processing
    if (this.isProcessingAudio) {
      elizaLogger.debug('[SttTtsPlugin] Currently processing audio, but still collecting this chunk');
      // Don't return here - continue to process this chunk
    }

    // Calculate the maximum amplitude in this audio chunk
    let maxVal = 0;
    let sumVal = 0;
    for (let i = 0; i < data.samples.length; i++) {
      const val = Math.abs(data.samples[i]);
      sumVal += val;
      if (val > maxVal) maxVal = val;
    }
    const avgVal = sumVal / data.samples.length;

    // Initialize or get the volume buffer for this user
    let volumeBuffer = this.volumeBuffers.get(data.userId);
    if (!volumeBuffer) {
      volumeBuffer = [];
      this.volumeBuffers.set(data.userId, volumeBuffer);
    }

    // Add the current max amplitude to the volume buffer
    volumeBuffer.push(maxVal);

    // Keep the buffer at a reasonable size
    if (volumeBuffer.length > VOLUME_WINDOW_SIZE) {
      volumeBuffer.shift();
    }

    // Calculate average and standard deviation to detect voice vs. noise
    const avgVolume =
      volumeBuffer.reduce((sum, val) => sum + val, 0) / volumeBuffer.length;

    // Calculate standard deviation
    const variance =
      volumeBuffer.reduce((sum, val) => sum + Math.pow(val - avgVolume, 2), 0) /
      volumeBuffer.length;
    const stdDev = Math.sqrt(variance);

    // More permissive voice detection - lower standard deviation threshold
    // Voice typically has higher variance than background noise
    const stdDevThreshold = 30; // Further lowered from 50 to be more sensitive
    
    // Multiple conditions to detect voice - any of these could indicate speech
    const isLikelyVoice = 
      stdDev > stdDevThreshold || 
      avgVolume > this.silenceThreshold * 1.2 ||
      maxVal > this.silenceThreshold * 2;

    // Add debug logging to help diagnose audio detection issues
    if (maxVal > 0) {
      elizaLogger.debug(
        `[SttTtsPlugin] Audio metrics: maxVal=${maxVal}, avgVal=${avgVal.toFixed(2)}, ` +
        `avgVolume=${avgVolume.toFixed(2)}, stdDev=${stdDev.toFixed(2)}, ` +
        `threshold=${this.silenceThreshold}, isLikelyVoice=${isLikelyVoice}`
      );
    }

    // ALWAYS collect audio data if it's not completely silent
    // This ensures we don't miss any speech, even if it's quiet
    if (maxVal < 10) { // Only reject completely silent frames
      elizaLogger.debug('[SttTtsPlugin] Completely silent frame, skipping');
      return;
    }

    if (this.userSpeakingTimer) {
      clearTimeout(this.userSpeakingTimer);
    }

    let arr = this.pcmBuffers.get(data.userId);
    if (!arr) {
      arr = [];
      this.pcmBuffers.set(data.userId, arr);
    }
    arr.push(data.samples);

    // Log when we add audio to the buffer
    elizaLogger.debug(
      `[SttTtsPlugin] Added audio chunk for user=${data.userId}, ` +
      `buffer now has ${arr.length} chunks`
    );

    if (!this.isSpeaking) {
      this.userSpeakingTimer = setTimeout(() => {
        // Only process if we have enough audio data (prevents processing very short noises)
        const chunks = this.pcmBuffers.get(data.userId) || [];
        const totalAudioLength = chunks.reduce(
          (sum, chunk) => sum + chunk.length,
          0,
        );

        // Require at least 0.25 seconds of audio (12000 samples at 48kHz) to process
        // Reduced from 0.5 seconds to be more responsive
        const minSamplesToProcess = 48000 * 0.25;

        if (totalAudioLength < minSamplesToProcess) {
          elizaLogger.log(
            '[SttTtsPlugin] Audio too short, skipping processing for user =>',
            data.userId,
            `(${totalAudioLength} samples, need ${minSamplesToProcess})`,
          );
          return;
        }

        elizaLogger.log(
          '[SttTtsPlugin] start processing audio for user =>',
          data.userId,
          `(${totalAudioLength} samples)`,
        );
        this.userSpeakingTimer = null;
        this.processAudio(data.userId).catch((err) =>
          elizaLogger.error('[SttTtsPlugin] handleSilence error =>', err),
        );
      }, this.silenceDetectionThreshold);
    } else {
      // Check for interruption - but only if it's likely to be real speech
      // Apply the same voice detection logic we use for initial processing

      // Get normalized amplitude for this chunk (0-1 scale)
      const samples = new Int16Array(
        data.samples.buffer,
        data.samples.byteOffset,
        data.samples.length / 4,
      );

      // Fill analysis buffer
      samples.forEach((sample) => {
        this.interruptAnalysisBuffer[this.interruptBufferIndex++] = sample;
        if (this.interruptBufferIndex >= this.interruptAnalysisBuffer.length) {
          this.interruptBufferIndex = 0;
          if (
            this.enhancedAnalyzeForInterruption(this.interruptAnalysisBuffer)
          ) {
            this.ttsAbortController?.abort();
            this.isSpeaking = false;
            elizaLogger.log('[SttTtsPlugin] Fast interruption detected');
          }
        }
      });
    }
  }

  /**
   * Process the TTS queue with streaming optimizations
   */
  private async processTtsQueue(): Promise<void> {
    try {
      while (this.ttsQueue.length > 0) {
        const text = this.ttsQueue.shift();
        if (!text) continue;

        // Create a new abort controller for this specific TTS task
        this.ttsAbortController = new AbortController();
        const { signal } = this.ttsAbortController;

        const startTime = Date.now();

        try {
          // Use the new streaming pipeline instead of the sequential approach
          await this.streamTtsToJanus(text, signal);

          console.log(
            `[SttTtsPlugin] Total TTS streaming took: ${Date.now() - startTime}ms`,
          );

          // Check for abort after streaming
          if (signal.aborted) {
            console.log('[SttTtsPlugin] TTS streaming was interrupted');
            return;
          }
        } catch (err) {
          console.error('[SttTtsPlugin] TTS streaming error =>', err);
        } finally {
          // Clean up the AbortController
          this.ttsAbortController = null;
        }
      }
    } catch (error) {
      console.error('[SttTtsPlugin] Queue processing error =>', error);
    } finally {
      this.isSpeaking = false;
    }
  }

  private async streamTtsToJanus(
    text: string,
    signal: AbortSignal,
  ): Promise<void> {
    elizaLogger.log(`[SttTtsPlugin] Streaming text to Janus: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);

    if (!this.janus) {
      elizaLogger.error('[SttTtsPlugin] No Janus client available for streaming TTS');
      return;
    }

    // Create a readable stream for the MP3 data
    const mp3Stream = new PassThrough();

    // Flag to track when processing is complete
    let processingComplete = false;

    // Flag to track if the stream has been interrupted
    let isInterrupted = false;

    // Check for abort signal immediately
    if (signal.aborted) {
      mp3Stream.end();
      return;
    }

    // Monitor abort signal
    signal.addEventListener('abort', () => {
      isInterrupted = true;
      mp3Stream.end();
    });

    // Start streaming request to ElevenLabs
    elizaLogger.log('[SttTtsPlugin] Starting ElevenLabs streaming request');
    
    // Create a buffer to hold audio frames for playback
    const audioBuffer: Int16Array[] = [];

    // Use FFMPEG to convert MP3 to PCM
    const ffmpeg = spawn('ffmpeg', [
      '-i',
      'pipe:0',
      '-f',
      's16le',
      '-acodec',
      'pcm_s16le',
      '-ar',
      '48000',
      '-ac',
      '1',
      'pipe:1',
    ]);

    // Handle FFMPEG process errors
    ffmpeg.on('error', (err) => {
      elizaLogger.error('[SttTtsPlugin] FFMPEG process error:', err);
      isInterrupted = true;
    });

    // Process the PCM data from FFMPEG
    const processingPromise = new Promise<void>((resolve, reject) => {
      let pcmBuffer = Buffer.alloc(0);

      ffmpeg.stdout.on('data', (chunk: Buffer) => {
        try {
          if (isInterrupted || signal.aborted) return;
          
          // Append new chunk to our buffer
          pcmBuffer = Buffer.concat([pcmBuffer, chunk]);

          // Process complete frames (480 samples = 10ms at 48kHz)
          const FRAME_SIZE = 480;
          const frameCount = Math.floor(pcmBuffer.length / (FRAME_SIZE * 2)); // 2 bytes per sample
          
          // Optimize for low latency by processing frames as soon as we have a small batch
          if (frameCount > 0) {
            for (let i = 0; i < frameCount; i++) {
              // Convert to Int16Array and store in audio buffer
              const frame = new Int16Array(
                pcmBuffer.buffer.slice(
                  i * FRAME_SIZE * 2 + pcmBuffer.byteOffset,
                  (i + 1) * FRAME_SIZE * 2 + pcmBuffer.byteOffset,
                ),
              );

              // Create a copy to avoid buffer reference issues
              const frameCopy = new Int16Array(FRAME_SIZE);
              frameCopy.set(frame);
              audioBuffer.push(frameCopy);
            }
            
            // Remove processed frames from buffer
            pcmBuffer = pcmBuffer.slice(frameCount * FRAME_SIZE * 2);
          }
        } catch (error) {
          reject(error);
        }
      });

      ffmpeg.stdout.on('end', () => {
        processingComplete = true;
        
        // Process any remaining data
        if (pcmBuffer.length > 0) {
          const remainingFrames = Math.floor(pcmBuffer.length / 2); // 2 bytes per sample
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

    // Start the streaming request to ElevenLabs
    try {
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

      // Stream the response to the ffmpeg process
      const reader = response.body.getReader();
      
      // Speed up the initial buffer filling by reading faster
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

      // Wait for initial processing or interruption - reduced wait time for faster start
      await Promise.race([
        processingPromise.catch((err) => {
          elizaLogger.error('[SttTtsPlugin] Processing error:', err);
        }),
        // Also wait for a minimum buffer to build up before starting playback
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

      // Stream the audio frames with proper timing
      let frameIndex = 0;
      const startTime = Date.now();

      while (
        (frameIndex < audioBuffer.length || !processingComplete) &&
        !isInterrupted && !signal.aborted
      ) {
        // If we've played all available frames but processing isn't complete, wait for more
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
                setTimeout(waitForMoreFrames, 10); // Check more frequently
              }
            };
            waitForMoreFrames();
          });

          if (frameIndex >= audioBuffer.length || signal.aborted || isInterrupted) {
            break;
          }
        }

        // Calculate the ideal playback time for this frame
        const idealPlaybackTime = startTime + frameIndex * 10; // 10ms per frame
        const currentTime = Date.now();

        // Adjust timing if we're behind or ahead
        if (currentTime < idealPlaybackTime) {
          // We're ahead of schedule, wait until the right time
          await new Promise((r) =>
            setTimeout(r, idealPlaybackTime - currentTime),
          );
        } else if (currentTime > idealPlaybackTime + 100) {
          // We're significantly behind, skip frames to catch up
          const framesToSkip = Math.floor(
            (currentTime - idealPlaybackTime) / 10,
          );
          if (framesToSkip > 0) {
            elizaLogger.log(
              `[SttTtsPlugin] Skipping ${framesToSkip} frames to catch up`,
            );
            frameIndex += framesToSkip;
            continue;
          }
        }

        // Send audio frame to Janus if we have one
        if (frameIndex < audioBuffer.length) {
          try {
            const frame = audioBuffer[frameIndex];
            
            if (!isInterrupted && !signal.aborted) {
              // Use the enhanced interrupt detection
              if (this.enhancedAnalyzeForInterruption(frame)) {
                elizaLogger.log('[SttTtsPlugin] User interrupt detected during TTS playback');
                isInterrupted = true;
                break;
              }
              
              // Send the frame to Janus - ensure proper frame size (480 samples)
              const EXPECTED_SAMPLES = 480;
              
              // Check if we need to resize the frame
              if (frame.length !== EXPECTED_SAMPLES) {
                // Create a new buffer with exactly the right size
                const properSizedFrame = new Int16Array(EXPECTED_SAMPLES);
                
                // Copy data from original samples, being careful not to overflow
                const copyLength = Math.min(frame.length, EXPECTED_SAMPLES);
                properSizedFrame.set(frame.subarray(0, copyLength));
                
                // Send properly sized frame
                this.janus.pushLocalAudio(properSizedFrame, 48000);
              } else {
                // Frame already has correct size
                this.janus.pushLocalAudio(frame, 48000);
              }
            } else {
              break;
            }
          } catch (error) {
            elizaLogger.error('[SttTtsPlugin] Error sending audio frame:', error);
          }
        }
        frameIndex++;
      }

      // If interrupted, log it
      if (signal.aborted || isInterrupted) {
        elizaLogger.log('[SttTtsPlugin] Audio streaming was interrupted before completion');
      } else {
        elizaLogger.log('[SttTtsPlugin] Audio streaming completed successfully');
      }
    } catch (error) {
      elizaLogger.error('[SttTtsPlugin] Error streaming TTS to Janus:', error);
    }
  }

  /**
   * On speaker silence => flush STT => GPT => TTS => push to Janus
   */
  private async processAudio(userId: string): Promise<void> {
    try {
      // Prevent concurrent processing
      if (this.isProcessingAudio) {
        elizaLogger.log(
          '[SttTtsPlugin] Already processing audio, skipping this request',
        );
        return;
      }

      this.isProcessingAudio = true;

      // Abort any previous streams before starting a new one
      this.abortPreviousStreams();

      // Get the signal from the current abort controller
      const signal = this.ttsAbortController!.signal;

      // Create a unique ID for this stream session
      const streamId = uuidv4();
      this.currentStreamId = streamId;
      this.activeStreams.add(streamId);

      elizaLogger.log(`[SttTtsPlugin] Starting new stream with ID: ${streamId}`);

      // CRITICAL FIX: Make a copy of the chunks before clearing the buffer
      // This prevents race conditions where new audio data might be added while we're processing
      const userPcmBuffers = this.pcmBuffers.get(userId) || [];
      const chunks = [...userPcmBuffers]; // Create a copy of the array
      
      // Only clear the buffer AFTER we've made a copy
      this.pcmBuffers.delete(userId);

      if (!chunks.length) {
        elizaLogger.warn('[SttTtsPlugin] No audio chunks for user =>', userId);
        this.isProcessingAudio = false; // Reset flag on early return
        return;
      }

      // Validate that we have actual audio data in the chunks
      const totalSamples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      elizaLogger.log(
        `[SttTtsPlugin] Processing audio for user=${userId}, chunks=${chunks.length}, total samples=${totalSamples}`,
      );

      if (totalSamples === 0) {
        elizaLogger.warn('[SttTtsPlugin] Empty audio chunks for user =>', userId);
        this.isProcessingAudio = false; // Reset flag on early return
        return;
      }

      // ---- Optimize parallel operations ----

      // 1. Start merging audio buffer (CPU-bound operation)
      const mergeBufferPromise = this.mergeAudioChunks(chunks);

      // 2. Do any non-dependent work here while CPU is busy with buffer merging
      // Clean up resources for this user
      this.volumeBuffers.delete(userId);

      // 3. Wait for buffer merging to complete
      const merged = await mergeBufferPromise;

      // Validate merged audio data
      if (!merged || merged.length === 0) {
        elizaLogger.error('[SttTtsPlugin] Failed to merge audio chunks for user =>', userId);
        this.isProcessingAudio = false; // Reset flag on error
        return;
      }

      // Log audio properties before processing
      elizaLogger.debug(
        `[SttTtsPlugin] Merged audio buffer: length=${merged.length} samples, ` +
          `estimated duration=${(merged.length / 48000).toFixed(2)}s`,
      );

      // 4. Apply noise reduction to improve speech recognition
      const noiselessPcm = this.applyNoiseReduction(merged, 300);

      // 5. Optimize audio (downsample if needed)
      const optimizedPcm = this.maybeDownsampleAudio(noiselessPcm, 48000, 16000);

      // 6. Convert to WAV format - declare outside try block so it's accessible in catch
      let wavBuffer: ArrayBuffer;
      let sttText: string;

      try {
        // Convert to WAV format
        const sampleRate = optimizedPcm === merged ? 48000 : 16000;
        wavBuffer = await this.convertPcmToWavInMemory(
          optimizedPcm,
          sampleRate,
        );

        // Validate WAV buffer
        if (!wavBuffer || wavBuffer.byteLength <= 44) {
          // 44 is the size of the WAV header without any audio data
          elizaLogger.error(
            `[SttTtsPlugin] Invalid WAV buffer generated for user ${userId}: ` +
            `size=${wavBuffer ? wavBuffer.byteLength : 'undefined'} bytes`
          );
          this.isProcessingAudio = false; // Reset flag on error
          return;
        }

        elizaLogger.debug(
          `[SttTtsPlugin] Sending WAV buffer to transcription service: ` +
          `size=${wavBuffer.byteLength} bytes, sample rate=${sampleRate}Hz`
        );

        const start = Date.now();

        // 7. Transcribe audio
        sttText = await this.transcriptionService.transcribe(wavBuffer);

        console.log(`Transcription took: ${Date.now() - start} ms`);
        elizaLogger.log(`[SttTtsPlugin] Transcription result: "${sttText}"`);

        if (isEmpty(sttText?.trim())) {
          elizaLogger.warn(
            `[SttTtsPlugin] No speech recognized for user => ${userId}, ` +
              `audio buffer size: ${wavBuffer.byteLength} bytes, ` +
              `transcription time: ${Date.now() - start}ms`,
          );
          this.isProcessingAudio = false; // Reset flag on early return
          return;
        }

        elizaLogger.log(
          `[SttTtsPlugin] STT => user=${userId}, text="${sttText}"`,
        );

        // Check if we have a previous transcription buffer for this user
        const now = Date.now();
        const prevBuffer = this.transcriptionBuffers.get(userId);
        
        // If we have a previous buffer that's still within our time window, append to it
        if (prevBuffer && (now - prevBuffer.timestamp) < this.transcriptionBufferTimeout) {
          // Append the new transcription to the existing buffer
          sttText = prevBuffer.text + " " + sttText;
          elizaLogger.log(
            `[SttTtsPlugin] Appended to transcription buffer for user=${userId}, combined text="${sttText}"`,
          );
        }
        
        // Update the transcription buffer with the current (possibly combined) text
        this.transcriptionBuffers.set(userId, {
          text: sttText,
          timestamp: now
        });

        // 8. Set up direct streaming pipeline from Grok to ElevenLabs to Janus
        // Use the abort controller that was created in abortPreviousStreams

        // Track accumulated text for logging
        let accumulatedText = '';
        let ttsBuffer = '';

        // Minimum characters needed for natural speech synthesis
        const minTtsChunkSize = 20;

        // Flag to track if TTS is currently processing
        let isTtsProcessing = false;

        // Helper function to determine if text forms a natural break point
        const isNaturalBreakPoint = (text: string): boolean => {
          // Enhanced natural break detection with more specific patterns
          return (
            /[.!?](\s|$)/.test(text) || // Strong sentence endings
            (/[;:](\s|$)/.test(text) && text.length > 40) || // Medium pauses with sufficient context
            (/[,](\s|$)/.test(text) && text.length > 80) // Commas only with substantial context
          );
        };

        let progressiveTimeout: NodeJS.Timeout | null = null;
        const minCharactersForProgressive = 10;
        const progressiveDelay = 200; // ms

        const processTtsChunk = async () => {
          if (isTtsProcessing || ttsBuffer.length === 0) return;

          isTtsProcessing = true;

          try {
            // Extract the current buffer content and reset it
            const textToProcess = ttsBuffer;
            ttsBuffer = '';

            // Add natural pauses at punctuation to make speech sound more natural
            // Further reduced pause durations to improve latency
            const textWithPauses = textToProcess
              .replace(/\.\s+/g, '. <break time="30ms"/> ')
              .replace(/,\s+/g, ', <break time="5ms"/> ');

            elizaLogger.log(`[SttTtsPlugin] Processing TTS chunk: "${textWithPauses.substring(0, 50)}${textWithPauses.length > 50 ? '...' : ''}"`);

            // Stream to TTS and Janus
            await this.streamTtsToJanus(textWithPauses, signal);

            // Check if we have more text waiting to be processed
            if (ttsBuffer.length > 0 && !signal.aborted) {
              // Schedule the next chunk with a small delay to prevent audio overlap
              setTimeout(() => {
                processTtsChunk();
              }, 50);
            }
          } catch (error) {
            elizaLogger.error('[SttTtsPlugin] Error processing TTS chunk:', error);
          } finally {
            isTtsProcessing = false;
          }
        };

        // Buffer management function - decides when to process text
        const manageTtsBuffer = () => {
          // Don't process if already processing or if aborted
          if (isTtsProcessing || signal.aborted) return;

          // Process if we have enough text or hit a natural break point
          if (ttsBuffer.length >= minTtsChunkSize || isNaturalBreakPoint(ttsBuffer)) {
            // Clear any pending timeouts
            if (progressiveTimeout !== null) {
              clearTimeout(progressiveTimeout);
              progressiveTimeout = null;
            }

            // Process the chunk
            processTtsChunk();
          } else if (ttsBuffer.length >= minCharactersForProgressive && progressiveTimeout === null) {
            // Set a timeout to process smaller chunks after a delay
            progressiveTimeout = setTimeout(() => {
              progressiveTimeout = null;
              if (ttsBuffer.length > 0 && !isTtsProcessing) {
                processTtsChunk();
              }
            }, progressiveDelay);
          }
        };

        // Set up event listeners for the streaming response
        this.eventEmitter.once('stream-start', (startStreamId?: string) => {
          // Only process if this is the current stream and it's still active
          if (startStreamId && (!this.activeStreams.has(startStreamId) || signal.aborted)) {
            elizaLogger.debug(`[SttTtsPlugin] Ignoring stream-start from outdated stream`);
            return;
          }
          elizaLogger.log('[SttTtsPlugin] Stream started for user:', userId);
        });

        // Handle each chunk as it comes in from Grok
        this.eventEmitter.on('stream-chunk', (chunk: string, chunkStreamId?: string) => {
          // Ignore chunks if this stream is no longer active or has been aborted
          if (!chunkStreamId || !this.activeStreams.has(chunkStreamId) || signal.aborted) {
            elizaLogger.debug(`[SttTtsPlugin] Ignoring chunk from outdated stream`);
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
   * Abort any ongoing TTS and streaming processes
   * This should be called before starting a new stream
   */
  private abortPreviousStreams(): void {
    // Abort any ongoing TTS process
    if (this.ttsAbortController) {
      elizaLogger.log('[SttTtsPlugin] Aborting previous TTS stream');
      this.ttsAbortController.abort();
    }
    
    // Create a new abort controller for the next stream
    this.ttsAbortController = new AbortController();
    
    // Clear audio buffer to stop any ongoing audio processing
    this.audioBuffer = [];
    
    // Mark all active streams as inactive
    this.activeStreams.clear();
    this.currentStreamId = null;
    
    // Clear all event listeners
    this.eventEmitter.removeAllListeners();
    
    // Clear any timers
    if (this.userSpeakingTimer) {
      clearTimeout(this.userSpeakingTimer);
      this.userSpeakingTimer = null;
    }
    
    if (this.streamingInterval) {
      clearInterval(this.streamingInterval);
      this.streamingInterval = null;
    }
    
    // Clear buffers
    this.pcmBuffers.clear();
    this.volumeBuffers.clear();
    this.audioBuffer = [];
    
    elizaLogger.log('[SttTtsPlugin] Cleanup complete');
  }


  /**
   * Downsample audio if needed for Whisper
   * Whisper works best with 16kHz audio
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
  
    // Target amplitude (about 50-70% of max Int16 value for headroom)
    const targetAmplitude = 22000; // ~67% of max Int16 value
  
    // Calculate gain factor to reach target amplitude
    let gainFactor = 1.0;
    if (maxAmplitude > 0) {
      gainFactor = targetAmplitude / maxAmplitude;
    }
  
    // Apply normalization only if needed
    if (Math.abs(gainFactor - 1.0) > 0.1) { // Only normalize if gain change is significant
      elizaLogger.debug(
        `[SttTtsPlugin] Normalizing audio by factor of ${gainFactor.toFixed(2)}, max amplitude: ${maxAmplitude}`,
      );
  
      // Create a new array to avoid modifying the original
      const normalizedAudio = new Int16Array(audio.length);
      for (let i = 0; i < audio.length; i++) {
        // Apply gain and clamp to Int16 range
        normalizedAudio[i] = Math.max(
          -32768,
          Math.min(32767, Math.round(audio[i] * gainFactor)),
        );
      }
      return normalizedAudio;
    }
  
    return audio;
  }

  
  /**
   * Apply noise reduction to improve speech recognition
   * This implements a simple noise gate with smoothing to reduce background noise
   */
  private applyNoiseReduction(audio: Int16Array, threshold = 300): Int16Array {
    // Create a copy to avoid modifying the original
    const result = new Int16Array(audio.length);
    
    // Simple exponential moving average for smoothing
    let smoothedEnergy = 0;
    const smoothingFactor = 0.2; // Lower = more smoothing
    
    // Process each sample
    for (let i = 0; i < audio.length; i++) {
      // Calculate instantaneous energy (absolute value)
      const energy = Math.abs(audio[i]);
      
      // Update smoothed energy estimate
      smoothedEnergy = smoothingFactor * energy + (1 - smoothingFactor) * smoothedEnergy;
      
      // Apply soft noise gate
      if (smoothedEnergy > threshold) {
        // Calculate attenuation factor (soft knee)
        const attenuationFactor = Math.min(1.0, (smoothedEnergy - threshold) / threshold);
        
        // Apply the attenuation
        result[i] = Math.round(audio[i] * attenuationFactor);
      } else {
        // Below threshold - attenuate significantly but not completely
        // This prevents unnatural "holes" in the audio
        result[i] = Math.round(audio[i] * 0.1);
      }
    }
    
    elizaLogger.debug(
      `[SttTtsPlugin] Applied noise reduction with threshold ${threshold}`
    );
    
    return result;
  }

  /**
   * Convert to WAV format
   */
  private async convertPcmToWavInMemory(
    pcmData: Int16Array,
    sampleRate: number,
  ): Promise<ArrayBuffer> {
    // Ensure we have valid audio data
    if (!pcmData || pcmData.length === 0) {
      elizaLogger.error('[SttTtsPlugin] Error: Empty PCM data provided to WAV converter');
      // Return a minimal valid WAV file with silence to avoid crashes
      const emptyBuffer = new ArrayBuffer(44 + 32); // Header + minimal data
      const emptyView = new DataView(emptyBuffer);
      this.writeString(emptyView, 0, 'RIFF');
      emptyView.setUint32(4, 36 + 32, true);
      this.writeString(emptyView, 8, 'WAVE');
      this.writeString(emptyView, 12, 'fmt ');
      emptyView.setUint32(16, 16, true);
      emptyView.setUint16(20, 1, true);
      emptyView.setUint16(22, 1, true); // 1 channel
      emptyView.setUint32(24, sampleRate, true);
      emptyView.setUint32(28, sampleRate * 2, true);
      emptyView.setUint16(32, 2, true);
      emptyView.setUint16(34, 16, true);
      this.writeString(emptyView, 36, 'data');
      emptyView.setUint32(40, 32, true);
      return emptyBuffer;
    }

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

    // Verify the WAV buffer is correctly formatted
    const isValidWav = 
      buffer.byteLength >= 44 && 
      String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)) === 'RIFF' &&
      String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11)) === 'WAVE';

    if (!isValidWav) {
      elizaLogger.error('[SttTtsPlugin] Error: Generated invalid WAV format');
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

  /**
   * Handle User Message with streaming support
   */
  private async handleUserMessageStreaming(
    userText: string,
    userId: string, // This is the raw Twitter user ID like 'tw-1865462035586142208'
  ): Promise<void> {
    // Use the current stream ID
    const streamId = this.currentStreamId;
    
    if (!streamId || !this.activeStreams.has(streamId)) {
      elizaLogger.error('[SttTtsPlugin] No current stream ID found or stream is no longer active');
      return;
    }
    
    elizaLogger.log(`[SttTtsPlugin] Handling user message with stream ID: ${streamId}`);

    // Extract the numeric ID part
    const numericId = userId.replace('tw-', '');
    const roomId = stringToUuid(`twitter_generate_room-${this.spaceId}`);

    // Create consistent UUID for the user
    const userUuid = stringToUuid(`twitter-user-${numericId}`);

    // Ensure the user exists in the accounts table
    // Ensure room exists and user is in it

    await Promise.all([
      this.runtime.ensureUserExists(
        userUuid,
        userId, // Use full Twitter ID as username
        `Twitter User ${numericId}`,
        'twitter',
      ),
      this.runtime.ensureRoomExists(roomId),
      this.runtime.ensureParticipantInRoom(userUuid, roomId),
    ]);

    const memory = {
      id: stringToUuid(`${roomId}-voice-message-${Date.now()}`),
      agentId: this.runtime.agentId,
      content: {
        text: userText,
        source: 'twitter',
      },
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
      // this.runtime.messageManager.createMemory(memory).catch(error => {
      //   elizaLogger.warn(`Error when creating memories for twitter spaces ${error} ignoring`);
      //   return;
      // }),
    ]);

    // state = await this.runtime.updateRecentMessageState(state).catch(error => {
    //   elizaLogger.warn(`Error when updating recent message state from spaces ${error} ignoring`);
    //   return state;
    // });
    const shouldIgnore = await this._shouldIgnore(memory);

    if (shouldIgnore) {
      return;
    }

    // Compose context using the template
    const context = composeContext({
      state,
      template:
      twitterSpaceTemplate,
    });

    // Log character information for debugging
    elizaLogger.log('[SttTtsPlugin] Character info:', {
      name: this.runtime.character.name,
      system: this.runtime.character.system,
    });

    // Create a system message that includes the full context
    const systemMessage = {
      role: 'system' as const,
      content: context,
    };

    const userMessage = {
      role: 'user' as const,
      content: userText,
    };

    const messages = [...this.chatContext, systemMessage, userMessage];

    const start = Date.now();
    
    // Check if the stream is still active before making the API call
    if (!this.activeStreams.has(streamId) || this.ttsAbortController?.signal.aborted) {
      elizaLogger.log('[SttTtsPlugin] Stream was aborted before API call, cancelling');
      this.eventEmitter.emit('stream-end', streamId);
      return;
    }
    
    // Make streaming request to Grok
    const stream = await this.openai.chat.completions.create({
      model: 'grok-2-latest',
      messages: messages,
      stream: true,
    });

    let fullResponse = '';
    let bufferedText = '';
    let potentialActionMarker = false;
    let detectedAction = '';
    
    elizaLogger.log('[SttTtsPlugin] Starting Grok streaming response processing');

    // Process each chunk as it arrives
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (!content) continue;

      fullResponse += content;

      // Check if we should start buffering (seeing "action" word)
      if (!potentialActionMarker && content.includes('action')) {
        potentialActionMarker = true;
        bufferedText += content;
        continue;
      }

      // If we're buffering, check for actionIs: pattern
      if (potentialActionMarker) {
        bufferedText += content;
        
        // If we find the complete actionIs: pattern
        if (bufferedText.includes('actionIs:')) {
          const actionMatch = /actionIs:([A-Z_]+)/.exec(bufferedText);
          if (actionMatch) {
            detectedAction = actionMatch[1];
            elizaLogger.log(`[SttTtsPlugin] Detected action: ${detectedAction}`);
            
            // Emit only the text part before actionIs:
            const textBeforeAction = bufferedText.split('actionIs:')[0].trim();
            if (textBeforeAction) {
              this.eventEmitter.emit('stream-chunk', textBeforeAction, streamId);
            }
            
            // Clear buffer since we've handled it
            bufferedText = '';
            potentialActionMarker = false;
          }
        } else if (bufferedText.length > 100) {
          // If buffer gets too large without finding actionIs:, 
          // it's probably not an action marker - emit it
          this.eventEmitter.emit('stream-chunk', bufferedText, streamId);
          bufferedText = '';
          potentialActionMarker = false;
        }
        continue;
      }

      // Regular text processing - emit directly
      this.eventEmitter.emit('stream-chunk', content, streamId);
    }

    // Process any remaining buffered text at the end
    if (bufferedText) {
      // Check if it contains an action marker
      if (bufferedText.includes('actionIs:')) {
        const textBeforeAction = bufferedText.split('actionIs:')[0].trim();
        if (textBeforeAction) {
          this.eventEmitter.emit('stream-chunk', textBeforeAction, streamId);
        }
        
        // Extract action if any
        const actionMatch = /actionIs:([A-Z_]+)/.exec(bufferedText);
        if (actionMatch) {
          detectedAction = actionMatch[1];
          elizaLogger.log(`[SttTtsPlugin] Final detected action: ${detectedAction}`);
        }
      } else {
        // No action marker, emit the entire buffer
        this.eventEmitter.emit('stream-chunk', bufferedText, streamId);
      }
    }

    console.log(`Time took for completing LLM ${Date.now() - start}`);
    
    // Log the detected action if any
    if (detectedAction) {
      elizaLogger.log(`[SttTtsPlugin] Response contained action: ${detectedAction}`);
      // Here you could trigger the appropriate action based on detectedAction
      // For example: if (detectedAction === 'SEARCH_WEB') { /* trigger web search */ }
    }
    
    // Signal stream end
    this.eventEmitter.emit('stream-end', streamId);
  }


  /**
   * Should Ignore
   */
  private async _shouldIgnore(message: Memory): Promise<boolean> {
    elizaLogger.debug('message.content: ', message.content);
    // if the message is 3 characters or less, ignore it
    const messageStr = message?.content?.text;
    const messageLen = messageStr?.length ?? 0;
    if (messageLen < 3) {
      return true;
    }

    const loseInterestWords = [
      // telling the bot to stop talking
      'shut up',
      'stop',
      'dont talk',
      'silence',
      'stop talking',
      'be quiet',
      'hush',
      'stfu',
      'stupid bot',
      'dumb bot',

      // offensive words
      'fuck',
      'shit',
      'damn',
      'suck',
      'dick',
      'cock',
      'sex',
      'sexy',
    ];
    if (
      messageLen < 50 &&
      loseInterestWords.some((word) =>
        messageStr?.toLowerCase()?.includes(word),
      )
    ) {
      return true;
    }

    const ignoreWords = ['k', 'ok', 'bye', 'lol', 'nm', 'uh'];
    if (
      messageStr?.length < 8 &&
      ignoreWords.some((word) => messageStr?.toLowerCase()?.includes(word))
    ) {
      return true;
    }

    return false;
  }



  /**
   * Enhanced analysis for detecting user interruptions in audio
   * Uses a more sophisticated algorithm to detect speech onset
   */
  private enhancedAnalyzeForInterruption(buffer: Int16Array): boolean {
    // Skip analysis if we're not speaking (no need to detect interruptions)
    if (!this.isSpeaking) {
      return false;
    }

    // Energy threshold for detecting speech
    const ENERGY_THRESHOLD = 10000;

    // Number of consecutive frames that must exceed the threshold
    const CONSECUTIVE_FRAMES_THRESHOLD = 5;

    // Frame size for analysis (in samples)
    const FRAME_SIZE = 160; // 10ms at 16kHz

    // Calculate energy for each frame
    let consecutiveHighEnergyFrames = 0;

    for (let i = 0; i < buffer.length - FRAME_SIZE; i += FRAME_SIZE) {
      let frameEnergy = 0;

      // Calculate energy for this frame
      for (let j = 0; j < FRAME_SIZE; j++) {
        frameEnergy += Math.abs(buffer[i + j]);
      }

      // Average energy for the frame
      frameEnergy = frameEnergy / FRAME_SIZE;

      if (frameEnergy > ENERGY_THRESHOLD) {
        consecutiveHighEnergyFrames++;

        // If we've detected enough consecutive high-energy frames, consider it an interruption
        if (consecutiveHighEnergyFrames >= CONSECUTIVE_FRAMES_THRESHOLD) {
          elizaLogger.debug(
            `[SttTtsPlugin] Interruption detected: energy=${frameEnergy}, ` +
              `consecutive frames=${consecutiveHighEnergyFrames}`,
          );
          return true;
        }
      } else {
        // Reset counter if we encounter a low-energy frame
        consecutiveHighEnergyFrames = 0;
      }
    }

    return false;
  }

  cleanup(): void {
    // Abort any ongoing TTS processes
    if (this.ttsAbortController) {
      this.ttsAbortController.abort();
      this.ttsAbortController = null;
    }
    
    // Clear all active streams
    this.activeStreams.clear();
    this.currentStreamId = null;
    
    // Clear all event listeners
    this.eventEmitter.removeAllListeners();
    
    // Clear any timers
    if (this.userSpeakingTimer) {
      clearTimeout(this.userSpeakingTimer);
      this.userSpeakingTimer = null;
    }
    
    if (this.streamingInterval) {
      clearInterval(this.streamingInterval);
      this.streamingInterval = null;
    }
    
    // Clear buffers
    this.pcmBuffers.clear();
    this.volumeBuffers.clear();
    this.audioBuffer = [];
    this.transcriptionBuffers.clear();
    
    elizaLogger.log('[SttTtsPlugin] Cleanup complete');
  }

  private async mergeAudioChunks(chunks: Int16Array[]): Promise<Int16Array> {
    // Calculate total length of all chunks
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);

    // Simple concatenation of chunks - no need for browser APIs
    const result = new Int16Array(totalLength);
    let offset = 0;

    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    // Check if audio is too quiet and needs amplification
    let maxAmplitude = 0;
    for (let i = 0; i < result.length; i++) {
      const absValue = Math.abs(result[i]);
      if (absValue > maxAmplitude) {
        maxAmplitude = absValue;
      }
    }
  
    elizaLogger.debug(
      `[SttTtsPlugin] Merged ${chunks.length} audio chunks, total samples: ${totalLength}, ` +
        `max amplitude: ${maxAmplitude}`,
    );

    // If the audio is very quiet, amplify it more aggressively
    if (maxAmplitude < 5000) {
      // Less than ~15% of max Int16 value
      const gainFactor = Math.min(5.0, 15000 / Math.max(1, maxAmplitude));
      elizaLogger.debug(
        `[SttTtsPlugin] Amplifying quiet audio by factor of ${gainFactor.toFixed(2)}`,
      );

      for (let i = 0; i < result.length; i++) {
        // Apply gain and clamp to Int16 range
        result[i] = Math.max(
          -32768,
          Math.min(32767, Math.round(result[i] * gainFactor)),
        );
      }
    }

    // Validate the audio data
    if (result.length === 0 || maxAmplitude === 0) {
      elizaLogger.warn('[SttTtsPlugin] Warning: Audio data is empty or silent');
    }

    return result;
  }
}
