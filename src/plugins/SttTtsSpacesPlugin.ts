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
  private silenceThreshold = 50;

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

  private eventEmitter = new EventEmitter();
  private openai: OpenAI;
  private transcriptionService: ITranscriptionService;

  private interruptAnalysisBuffer = new Int16Array(1024);
  private interruptBufferIndex = 0;
  private lastInterruptCheck = 0;

  private audioBuffer: Int16Array[] = [];
  private streamingInterval: NodeJS.Timeout | null = null;

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
    if (this.isProcessingAudio) {
      return;
    }

    // Calculate the maximum amplitude in this audio chunk
    let maxVal = 0;
    for (let i = 0; i < data.samples.length; i++) {
      const val = Math.abs(data.samples[i]);
      if (val > maxVal) maxVal = val;
    }

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

    // Voice typically has higher variance than background noise
    const isLikelyVoice = stdDev > 100 && avgVolume > this.silenceThreshold;

    // Skip processing if below threshold or likely not voice
    if (maxVal < this.silenceThreshold || !isLikelyVoice) {
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

    if (!this.isSpeaking) {
      this.userSpeakingTimer = setTimeout(() => {
        // Only process if we have enough audio data (prevents processing very short noises)
        const chunks = this.pcmBuffers.get(data.userId) || [];
        const totalAudioLength = chunks.reduce(
          (sum, chunk) => sum + chunk.length,
          0,
        );

        // Require at least 0.5 seconds of audio (24000 samples at 48kHz) to process
        const minSamplesToProcess = 48000 * 0.5;

        if (totalAudioLength < minSamplesToProcess) {
          elizaLogger.log(
            '[SttTtsPlugin] Audio too short, skipping processing for user =>',
            data.userId,
            `(${totalAudioLength} samples)`,
          );
          return;
        }

        elizaLogger.log(
          '[SttTtsPlugin] start processing audio for user =>',
          data.userId,
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
    const SAMPLE_RATE = 48000;
    const FRAME_SIZE = 480; // 10ms at 48kHz
    const FRAME_DURATION_MS = 10; // Actual playback duration of each frame

    // Create a PassThrough stream for the MP3 data
    const mp3Stream = new PassThrough();

    // Set up FFmpeg process for streaming conversion
    const ffmpeg = spawn('ffmpeg', [
      // Input stream settings
      '-i',
      'pipe:0',
      '-f',
      'mp3',

      // Performance flags
      '-threads',
      '4',
      '-loglevel',
      'error',
      '-nostdin',
      '-fflags',
      '+nobuffer',
      '-flags',
      '+low_delay',
      '-probesize',
      '32',
      '-analyzeduration',
      '0',

      // Output settings - PCM audio
      '-f',
      's16le',
      '-ar',
      SAMPLE_RATE.toString(),
      '-ac',
      '1',
      'pipe:1',
    ]);

    // Connect MP3 stream to FFmpeg input
    mp3Stream.pipe(ffmpeg.stdin);

    // Create a buffer to store audio frames
    const audioBuffer: Int16Array[] = [];

    // Flag to track if processing is complete
    let processingComplete = false;

    // Flag to track if the stream has been interrupted
    let isInterrupted = false;

    // Check for abort signal immediately
    if (signal.aborted) {
      mp3Stream.end();
      return;
    }

    // Set up abort listener to handle interruptions
    const abortListener = () => {
      isInterrupted = true;
      elizaLogger.log('[SttTtsPlugin] TTS streaming interrupted - cleaning up resources');

      // End the mp3Stream to stop data flow to FFmpeg
      mp3Stream.end();

      // Kill the FFmpeg process if it's still running
      if (ffmpeg && !ffmpeg.killed) {
        ffmpeg.kill('SIGTERM');
      }

      // Clear the audio buffer to prevent further processing
      audioBuffer.length = 0;
      processingComplete = true;
    };

    // Add abort listener
    signal.addEventListener('abort', abortListener);

    // Start the ElevenLabs API call with streaming response
    const elevenLabsPromise = this.elevenLabsTtsStreaming(
      text,
      mp3Stream,
      signal,
    );

    // Process FFmpeg output and store in buffer
    const processingPromise = new Promise<void>((resolve, reject) => {
      let pcmBuffer = Buffer.alloc(0);

      ffmpeg.stdout.on('data', (chunk: Buffer) => {
        try {
          if (isInterrupted || signal.aborted) return;

          // Append new chunk to our buffer
          pcmBuffer = Buffer.concat([pcmBuffer, chunk]);

          // Process complete frames
          while (pcmBuffer.length >= FRAME_SIZE * 2) {
            // 2 bytes per sample
            // Extract a complete frame
            const frameBuffer = pcmBuffer.slice(0, FRAME_SIZE * 2);
            pcmBuffer = pcmBuffer.slice(FRAME_SIZE * 2);

            // Convert to Int16Array and store in audio buffer
            const frame = new Int16Array(
              frameBuffer.buffer,
              frameBuffer.byteOffset,
              FRAME_SIZE,
            );

            // Create a copy of the frame to avoid shared buffer issues
            const frameCopy = new Int16Array(FRAME_SIZE);
            frameCopy.set(frame);

            // Add to our ordered buffer queue only if not interrupted
            if (!isInterrupted && !signal.aborted) {
              audioBuffer.push(frameCopy);
            }
          }
        } catch (error) {
          reject(error);
        }
      });

      ffmpeg.stderr.on('data', (data) => {
        if (data.toString().includes('Error')) {
          console.error('[FFmpeg Streaming Error]', data.toString().trim());
        }
      });

      ffmpeg.on('close', (code) => {
        try {
          if (code !== 0 && !signal.aborted && !isInterrupted) {
            reject(
              new Error(`ffmpeg streaming process exited with code ${code}`),
            );
            return;
          }

          // Process any remaining audio in the buffer
          if (pcmBuffer.length > 0 && !signal.aborted && !isInterrupted) {
            // Create a proper sized frame for any remaining data
            const frameBuffer = Buffer.alloc(FRAME_SIZE * 2);
            pcmBuffer.copy(
              frameBuffer,
              0,
              0,
              Math.min(pcmBuffer.length, FRAME_SIZE * 2),
            );

            const frame = new Int16Array(FRAME_SIZE);

            // Copy from the buffer view to our frame
            const srcView = new Int16Array(
              frameBuffer.buffer,
              frameBuffer.byteOffset,
              FRAME_SIZE,
            );

            frame.set(srcView);
            audioBuffer.push(frame);
          }

          processingComplete = true;
          resolve();
        } catch (error) {
          reject(error);
        }
      });

      ffmpeg.on('error', (err) => {
        reject(new Error(`FFmpeg process error: ${err.message}`));
      });
    });

    try {
      // Wait for audio processing to complete (or at least start building the buffer)
      await Promise.race([
        processingPromise.catch((err) => {
          elizaLogger.error('[SttTtsPlugin] Processing error:', err);
        }),
        // Also wait for a minimum buffer to build up before starting playback
        new Promise<void>((resolve) => {
          const checkBuffer = () => {
            if (audioBuffer.length > 10 || signal.aborted || isInterrupted) {
              resolve();
            } else {
              setTimeout(checkBuffer, 50);
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
        !signal.aborted &&
        !isInterrupted
      ) {
        // If we've played all available frames but processing isn't complete, wait for more
        if (frameIndex >= audioBuffer.length && !processingComplete) {
          await new Promise<void>((resolve) => {
            const waitForMoreFrames = () => {
              if (
                frameIndex < audioBuffer.length ||
                processingComplete ||
                signal.aborted ||
                isInterrupted
              ) {
                resolve();
              } else {
                setTimeout(waitForMoreFrames, 20);
              }
            };
            waitForMoreFrames();
          });

          // If we're still out of frames after waiting, exit the loop
          if (frameIndex >= audioBuffer.length || signal.aborted || isInterrupted) {
            break;
          }
        }

        // Calculate the ideal playback time for this frame
        const idealPlaybackTime = startTime + frameIndex * FRAME_DURATION_MS;
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
            (currentTime - idealPlaybackTime) / FRAME_DURATION_MS,
          );
          if (framesToSkip > 0) {
            elizaLogger.log(
              `[SttTtsPlugin] Skipping ${framesToSkip} frames to catch up`,
            );
            frameIndex += framesToSkip;
            continue;
          }
        }

        // Check for interruption before sending each frame
        if (signal.aborted || isInterrupted) {
          elizaLogger.log('[SttTtsPlugin] Streaming interrupted during frame playback');
          break;
        }

        // Get the next frame
        const frame = audioBuffer[frameIndex];

        // Send to Janus
        try {
          await this.streamChunkToJanus(frame, SAMPLE_RATE);
        } catch (error) {
          elizaLogger.error(
            '[SttTtsPlugin] Error sending frame to Janus:',
            error,
          );
        }

        frameIndex++;
      }

      // If interrupted, log it
      if (signal.aborted || isInterrupted) {
        elizaLogger.log('[SttTtsPlugin] Audio streaming was interrupted before completion');
      } else if (!isInterrupted) {
        // Wait for any remaining processing to complete only if not interrupted
        await processingPromise;
        await elevenLabsPromise;

        elizaLogger.log(
          `[SttTtsPlugin] Audio streaming completed: ${audioBuffer.length} frames played`,
        );
      }
    } catch (error) {
      if (signal.aborted || isInterrupted) {
        elizaLogger.log('[SttTtsPlugin] Audio streaming aborted');
      } else {
        elizaLogger.error('[SttTtsPlugin] Audio streaming error:', error);
      }

      // Make sure to end the stream on error
      mp3Stream.end();
      throw error;
    } finally {
      // Clean up event listeners
      signal.removeEventListener('abort', abortListener);

      // Ensure FFmpeg process is terminated
      if (ffmpeg && !ffmpeg.killed) {
        ffmpeg.kill('SIGTERM');
      }
    }
  }

  /**
   * Modified ElevenLabs TTS function that streams the response to a writable stream
   * instead of waiting for the full response
   */
  private async elevenLabsTtsStreaming(
    text: string,
    outputStream: NodeJS.WritableStream,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      if (!this.elevenLabsApiKey) {
        throw new Error('[SttTtsPlugin] No ElevenLabs API key');
      }

      // Set up ElevenLabs API request
      const apiKey = this.elevenLabsApiKey;
      const voiceId = this.voiceId;

      // Use the streaming endpoint
      const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;

      elizaLogger.log(
        `[SttTtsPlugin] Starting ElevenLabs streaming TTS request`,
      );

      // Make the API request
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Accept: 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': apiKey,
        },
        body: JSON.stringify({
          text,
          model_id: this.elevenLabsModel,
          voice_settings: {
            stability: 0.4,
            similarity_boost: 0.8,
          },
        }),
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `ElevenLabs API error: ${response.status} ${response.statusText} - ${errorText}`,
        );
      }

      if (!response.body) {
        throw new Error('Response body is null');
      }

      elizaLogger.log(
        `[SttTtsPlugin] ElevenLabs response received, streaming to FFmpeg`,
      );

      // Stream the response directly to our output stream
      const reader = response.body.getReader();

      let done = false;
      let bytesReceived = 0;

      while (!done && !signal.aborted) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;

        if (value && !signal.aborted) {
          bytesReceived += value.length;

          // Write chunk to our stream
          outputStream.write(Buffer.from(value));

          // Log progress periodically
          if (bytesReceived % 10000 < 1000) {
            elizaLogger.log(
              `[SttTtsPlugin] Streaming TTS: ${bytesReceived} bytes received`,
            );
          }
        }
      }

      // End the stream when done
      outputStream.end();
      elizaLogger.log(
        `[SttTtsPlugin] ElevenLabs streaming completed: ${bytesReceived} total bytes`,
      );
    } catch (error) {
      if (error.name === 'AbortError') {
        elizaLogger.log('[SttTtsPlugin] ElevenLabs request aborted');
      } else {
        elizaLogger.error('[SttTtsPlugin] ElevenLabs streaming error:', error);
      }

      // Make sure to end the stream on error
      outputStream.end();
      throw error;
    }
  }

  /**
   * On speaker silence => flush STT => GPT => TTS => push to Janus
   */
  private async processAudio(userId: string): Promise<void> {
    try {
      if (this.isProcessingAudio) {
        elizaLogger.log('[SttTtsPlugin] Interrupting previous audio processing');
        
        // If we're already processing audio, abort the previous TTS
        if (this.ttsAbortController) {
          this.ttsAbortController.abort();
          this.ttsAbortController = null;
        }
        
        // Remove all existing event listeners to prevent old events from being processed
        this.eventEmitter.removeAllListeners('stream-chunk');
        this.eventEmitter.removeAllListeners('stream-start');
        this.eventEmitter.removeAllListeners('stream-end');
        
        // Wait a moment for cleanup to complete
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Set the global processing flag
      this.isProcessingAudio = true;

      // Get chunks and clear only this user's buffer
      const chunks = this.pcmBuffers.get(userId) || [];
      this.pcmBuffers.delete(userId);

      if (!chunks.length) {
        elizaLogger.warn('[SttTtsPlugin] No audio chunks for user =>', userId);
        return;
      }

      elizaLogger.log(
        `[SttTtsPlugin] Processing audio for user=${userId}, chunks=${chunks.length}`,
      );

      // ---- Optimize parallel operations ----

      // 1. Start merging audio buffer (CPU-bound operation)
      const mergeBufferPromise = this.mergeAudioChunks(chunks);

      // 2. Do any non-dependent work here while CPU is busy with buffer merging
      // Clean up resources for this user
      this.volumeBuffers.delete(userId);

      // 3. Wait for buffer merging to complete
      const merged = await mergeBufferPromise;

      // Log audio properties before processing
      elizaLogger.debug(
        `[SttTtsPlugin] Merged audio buffer: length=${merged.length} samples, ` +
          `estimated duration=${(merged.length / 48000).toFixed(2)}s`,
      );

      // 4. Optimize audio (downsample if needed)
      const optimizedPcm = this.maybeDownsampleAudio(merged, 48000, 16000);

      // 5. Convert to WAV format - declare outside try block so it's accessible in catch
      let wavBuffer: ArrayBuffer;
      let sttText: string;

      try {
        // Convert to WAV format
        wavBuffer = await this.convertPcmToWavInMemory(
          optimizedPcm,
          optimizedPcm === merged ? 48000 : 16000,
        );

        const start = Date.now();

        // 6. Transcribe audio
        sttText = await this.transcriptionService.transcribe(wavBuffer);

        console.log(`Transcription took: ${Date.now() - start} ms`);
        elizaLogger.log(`[SttTtsPlugin] Transcription result: "${sttText}"`);

        if (isEmpty(sttText?.trim())) {
          elizaLogger.warn(
            `[SttTtsPlugin] No speech recognized for user => ${userId}, ` +
              `audio buffer size: ${wavBuffer.byteLength} bytes, ` +
              `transcription time: ${Date.now() - start}ms`,
          );
          return;
        }

        elizaLogger.log(
          `[SttTtsPlugin] STT => user=${userId}, text="${sttText}"`,
        );

        // 7. Set up direct streaming pipeline from Grok to ElevenLabs to Janus
        // Create a TTS abort controller for this session
        this.ttsAbortController = new AbortController();
        const signal = this.ttsAbortController.signal;

        // Create a unique ID for this stream session
        const streamId = uuidv4();
        this.currentStreamId = streamId;

        elizaLogger.log(`[SttTtsPlugin] Starting new stream with ID: ${streamId}`);

        // Track accumulated text for logging
        let accumulatedText = '';

        // Buffer for accumulating text until we have enough for natural TTS
        let ttsBuffer = '';

        // Minimum characters needed for natural speech synthesis
        const minTtsChunkSize = 30;

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
        const minCharactersForProgressive = 15;
        const progressiveDelay = 400; // ms

        const processTtsChunk = async () => {
          if (isTtsProcessing || ttsBuffer.length === 0) return;

          isTtsProcessing = true;

          try {
            // Extract the current buffer content and reset it
            const textToProcess = ttsBuffer;
            ttsBuffer = '';

            // Add natural pauses at punctuation to make speech sound more natural
            const textWithPauses = textToProcess
              .replace(/\.\s+/g, '. <break time="500ms"/> ')
              .replace(/\?\s+/g, '? <break time="500ms"/> ')
              .replace(/!\s+/g, '! <break time="500ms"/> ')
              .replace(/:\s+/g, ': <break time="300ms"/> ')
              .replace(/;\s+/g, '; <break time="300ms"/> ')
              .replace(/,\s+/g, ', <break time="200ms"/> ');

            elizaLogger.log(`[SttTtsPlugin] Processing TTS chunk: "${textWithPauses.substring(0, 50)}${textWithPauses.length > 50 ? '...' : ''}"`);

            // Stream to TTS and Janus
            await this.streamTtsToJanus(textWithPauses, signal);

            // Check if we have more text waiting to be processed
            if (ttsBuffer.length > 0 && !signal.aborted) {
              // Schedule the next chunk with a small delay to prevent audio overlap
              setTimeout(() => {
                processTtsChunk();
              }, 100);
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
          // Only process if this is the current stream
          if (startStreamId && startStreamId !== streamId) {
            elizaLogger.debug(`[SttTtsPlugin] Ignoring stream-start from outdated stream`);
            return;
          }
          elizaLogger.log('[SttTtsPlugin] Stream started for user:', userId);
        });

        // Handle each chunk as it comes in from Grok
        this.eventEmitter.on('stream-chunk', (chunk: string, chunkStreamId?: string) => {
          // Ignore chunks if this stream is no longer current
          if (streamId !== this.currentStreamId) {
            elizaLogger.debug(`[SttTtsPlugin] Ignoring chunk from outdated stream`);
            return;
          }
          
          // Ignore chunks from different streams
          if (chunkStreamId && chunkStreamId !== streamId) {
            elizaLogger.debug(`[SttTtsPlugin] Ignoring chunk from different stream ID`);
            return;
          }

          if (typeof chunk !== 'string' || isEmpty(chunk) || signal.aborted) {
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
          // Ignore end events if this stream is no longer current
          if (streamId !== this.currentStreamId) {
            elizaLogger.debug(`[SttTtsPlugin] Ignoring stream-end from outdated stream`);
            return;
          }
          
          // Ignore end events from different streams
          if (endStreamId && endStreamId !== streamId) {
            elizaLogger.debug(`[SttTtsPlugin] Ignoring stream-end from different stream ID`);
            return;
          }

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
        // Clean up the TTS abort controller
        if (this.ttsAbortController) {
          this.ttsAbortController = null;
        }

        // Release the global processing flag
        this.isProcessingAudio = false;
      }
    } catch (error) {
      elizaLogger.error('[SttTtsPlugin] processAudio error =>', error);
    }
  }

  /**
   * Stream a single chunk of audio to Janus
   * Fixed to ensure exact byte length requirement is met
   */
  private async streamChunkToJanus(
    samples: Int16Array,
    sampleRate: number,
  ): Promise<void> {
    // Janus expects exactly 480 samples (960 bytes)
    const EXPECTED_SAMPLES = 480;
    const EXPECTED_BYTES = EXPECTED_SAMPLES * 2; // 960 bytes

    return new Promise<void>((resolve, reject) => {
      try {
        // Check if we need to create a properly sized buffer
        if (
          samples.length !== EXPECTED_SAMPLES ||
          samples.buffer.byteLength !== EXPECTED_BYTES
        ) {
          // Create a new buffer with exactly the right size
          const properSizedSamples = new Int16Array(EXPECTED_SAMPLES);

          // Copy data from original samples, being careful not to overflow
          const copySamples = Math.min(samples.length, EXPECTED_SAMPLES);
          for (let i = 0; i < copySamples; i++) {
            properSizedSamples[i] = samples[i];
          }

          // Create a buffer view that's EXACTLY 960 bytes (480 samples)
          // This is crucial - we need the buffer to be exactly 960 bytes
          const bufferView = new Int16Array(
            properSizedSamples.buffer,
            0,
            EXPECTED_SAMPLES,
          );

          // Send the properly sized buffer to Janus
          this.janus?.pushLocalAudio(bufferView, sampleRate);
        } else {
          // The buffer is already the right size
          this.janus?.pushLocalAudio(samples, sampleRate);
        }

        resolve();
      } catch (error) {
        console.error('[SttTtsPlugin] Error sending audio to Janus:', error);
        reject(error);
      }
    });
  }

  /**
   * Helper method to convert audio chunk to Int16Array format required by Janus
   */
  private convertAudioChunkToInt16(audioChunk: any): Int16Array {
    // If already Int16Array, return as is
    if (audioChunk instanceof Int16Array) {
      return audioChunk;
    }

    // If it's a Float32Array (common format from Web Audio API)
    if (audioChunk instanceof Float32Array) {
      const int16Chunk = new Int16Array(audioChunk.length);
      for (let i = 0; i < audioChunk.length; i++) {
        // Convert from float [-1.0, 1.0] to int16 [-32768, 32767]
        int16Chunk[i] = Math.max(
          -32768,
          Math.min(32767, Math.round(audioChunk[i] * 32767)),
        );
      }
      return int16Chunk;
    }

    // If it's an ArrayBuffer or other binary format
    if (audioChunk instanceof ArrayBuffer || ArrayBuffer.isView(audioChunk)) {
      // Assume it's PCM data that needs to be converted to Int16Array
      // This may need adjustment based on the actual format from your TTS service
      return new Int16Array(
        audioChunk instanceof ArrayBuffer ? audioChunk : audioChunk.buffer,
      );
    }

    // Fallback for unknown formats - return empty array
    elizaLogger.warn(
      '[SttTtsPlugin] Unknown audio chunk format, returning empty array',
    );
    return new Int16Array(0);
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

    // Default gain factor (no change)
    let gainFactor = 1.0;

    // If the audio is already loud enough, return it as is
    if (maxAmplitude > 10000) {
      // Less than ~15% of max Int16 value
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
   * Convert to WAV format
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

  /**
   * Handle User Message
   */
  private async handleUserMessage(
    userText: string,
    userId: string, // This is the raw Twitter user ID like 'tw-1865462035586142208'
  ): Promise<string> {
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

    let start = Date.now();

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

    let [state] = await Promise.all([
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
      this.runtime.messageManager.createMemory(memory),
    ]);
    console.log(
      `Compose state and create memory took ${Date.now() - start} ms`,
    );

    start = Date.now();
    state = await this.runtime.updateRecentMessageState(state);
    console.log(`Recent messages state update took ${Date.now() - start} ms`);

    const shouldIgnore = await this._shouldIgnore(memory);

    if (shouldIgnore) {
      return '';
    }

    // const shouldRespond = await this._shouldRespond(userText, state);

    // console.log(`should Respond took ${Date.now() - start} ms`);

    // if (!shouldRespond) {
    //   return '';
    // }

    start = Date.now();
    const context = composeContext({
      state,
      template:
        this.runtime.character.templates?.twitterVoiceHandlerTemplate ||
        this.runtime.character.templates?.messageHandlerTemplate ||
        twitterVoiceHandlerTemplate,
    });

    const responseContent = await this._generateResponse(memory, context);

    console.log(`Generating Response took ${Date.now() - start} ms`);

    const responseMemory: Memory = {
      id: stringToUuid(`${memory.id}-voice-response-${Date.now()}`),
      agentId: this.runtime.agentId,
      userId: this.runtime.agentId,
      content: {
        ...responseContent,
        user: this.runtime.character.name,
        inReplyTo: memory.id,
      },
      roomId,
      embedding: getEmbeddingZeroVector(),
    };

    const reply = responseMemory.content.text?.trim();
    if (reply) {
      await this.runtime.messageManager.createMemory(responseMemory);
    }

    this.eventEmitter.emit('response', reply);

    return reply;
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
    
    if (!streamId) {
      elizaLogger.error('[SttTtsPlugin] No current stream ID found');
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
    ]).catch((error) => {
      elizaLogger.warn(
        `Error when handling streaming for spaces error ${error} ignoring`,
      );
      return;
    });

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

    // Progressive timeout mechanism
    const progressiveTimeout: NodeJS.Timeout | null = null;
    const minCharactersForProgressive = 15;
    const progressiveDelay = 400; // ms

    // Signal stream start
    this.eventEmitter.emit('stream-start', streamId);

    const start = Date.now();
    // Make streaming request to Grok
    const stream = await this.openai.chat.completions.create({
      model: 'grok-2-latest',
      messages: messages,
      stream: true,
    });

    let fullResponse = '';
    let jsonBuffer = '';
    let isJsonResponse = false;
    let textValue = '';

    // Process each chunk as it arrives
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (!content) continue;

      fullResponse += content;

      // Check early chunks for JSON indicators
      if (!isJsonResponse && jsonBuffer.length < 30) {
        jsonBuffer += content;
        if (
          jsonBuffer.includes('```json') ||
          jsonBuffer.includes('```\njson') ||
          jsonBuffer.includes('```') ||
          jsonBuffer.includes('{')
        ) {
          isJsonResponse = true;
        }
      }

      // If it's not JSON, emit directly
      if (!isJsonResponse) {
        this.eventEmitter.emit('stream-chunk', content, streamId);
        continue;
      }

      // It's JSON, continue buffering
      jsonBuffer += content;

      // Try to extract the text field value
      try {
        // Look for "text": pattern
        const textMatch = /"text":\s*"([^"]*)/.exec(jsonBuffer);

        if (textMatch) {
          // We found the text field
          const capturedText = textMatch[1];

          // If we have more text than before, emit the difference
          if (capturedText.length > textValue.length) {
            const newText = capturedText.substring(textValue.length);
            this.eventEmitter.emit('stream-chunk', newText, streamId);
            textValue = capturedText;
          }
        }

        // Also check for a complete JSON object and parse it
        if (
          jsonBuffer.includes('}') &&
          (jsonBuffer.includes('```') || jsonBuffer.endsWith('}'))
        ) {
          // Try to extract the complete JSON
          let jsonStr = jsonBuffer;

          // Clean up markdown code block syntax if present
          if (jsonStr.includes('```json')) {
            jsonStr = jsonStr.replace(/```json\s*/, '').replace(/\s*```$/, '');
          } else if (jsonStr.includes('```')) {
            jsonStr = jsonStr.replace(/```\s*/, '').replace(/\s*```$/, '');
          }

          // Find the first { and last }
          const firstBrace = jsonStr.indexOf('{');
          const lastBrace = jsonStr.lastIndexOf('}');

          if (firstBrace >= 0 && lastBrace > firstBrace) {
            const jsonObject = jsonStr.substring(firstBrace, lastBrace + 1);

            try {
              const parsed = JSON.parse(jsonObject);

              // If we have a text field, emit any new content
              if (parsed.text && parsed.text.length > textValue.length) {
                const newText = parsed.text.substring(textValue.length);
                this.eventEmitter.emit('stream-chunk', newText, streamId);
                textValue = parsed.text;
              }
            } catch (e) {
              // Incomplete or invalid JSON, continue buffering
            }
          }
        }
      } catch (e) {
        // Error in regex or parsing, continue buffering
      }
    }

    // If we never found a text field but have JSON, try one last time to parse it
    if (isJsonResponse && jsonBuffer && !textValue) {
      try {
        // Clean up markdown code block syntax if present
        let jsonStr = jsonBuffer;
        if (jsonStr.includes('```json')) {
          jsonStr = jsonStr.replace(/```json\s*/, '').replace(/\s*```$/, '');
        } else if (jsonStr.includes('```')) {
          jsonStr = jsonStr.replace(/```\s*/, '').replace(/\s*```$/, '');
        }

        // Find the first { and last }
        const firstBrace = jsonStr.indexOf('{');
        const lastBrace = jsonStr.lastIndexOf('}');

        if (firstBrace >= 0 && lastBrace > firstBrace) {
          const jsonObject = jsonStr.substring(firstBrace, lastBrace + 1);
          const parsed = JSON.parse(jsonObject);

          if (parsed.text) {
            console.log(`Time took for emitting ${Date.now() - start}`);
            this.eventEmitter.emit('stream-chunk', parsed.text, streamId);
          } else {
            // No text field found, emit the whole buffer as fallback
            this.eventEmitter.emit('stream-chunk', jsonBuffer, streamId);
          }
        } else {
          // No valid JSON found, emit the whole buffer as fallback
          this.eventEmitter.emit('stream-chunk', jsonBuffer, streamId);
        }
      } catch (e) {
        console.log(`Time took for emitting ${Date.now() - start}`);
        // Parsing failed, emit the whole buffer as fallback
        this.eventEmitter.emit('stream-chunk', jsonBuffer, streamId);
      }
    }

    console.log(`Time took for completing LLM ${Date.now() - start}`);
    // Signal stream end
    this.eventEmitter.emit('stream-end', streamId);

    // Save the complete response to memory
    // if (fullResponse.trim()) {
    //   const responseMemory: Memory = {
    //     id: stringToUuid(`${memory.id}-voice-response-${Date.now()}`),
    //     agentId: this.runtime.agentId,
    //     userId: this.runtime.agentId,
    //     content: {
    //       text: fullResponse,
    //       source: 'twitter',
    //       user: this.runtime.character.name,
    //       inReplyTo: memory.id
    //     },
    //     roomId,
    //     embedding: getEmbeddingZeroVector()
    //   };

    //   await this.runtime.messageManager.createMemory(responseMemory).catch(error => {
    //     elizaLogger.warn(`Error when creating memory after response on spaces ${error} ignoring`)
    //     return;
    //   });
    // }
  }

  /**
   * Generate Response
   */
  private async _generateResponse(
    message: Memory,
    context: string,
  ): Promise<Content> {
    const { userId, roomId } = message;

    const response = await generateMessageResponse({
      runtime: this.runtime,
      context,
      modelClass: ModelClass.SMALL,
    });

    response.source = 'discord';

    if (!response) {
      elizaLogger.error(
        '[SttTtsPlugin] No response from generateMessageResponse',
      );
      return;
    }

    await this.runtime.databaseAdapter.log({
      body: { message, context, response },
      userId: userId,
      roomId,
      type: 'response',
    });

    return response;
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
   * Add a message (system, user or assistant) to the chat context.
   * E.g. to store conversation history or inject a persona.
   */
  public addMessage(role: 'system' | 'user' | 'assistant', content: string) {
    this.chatContext.push({ role, content });
    elizaLogger.log(
      `[SttTtsPlugin] addMessage => role=${role}, content=${content}`,
    );
  }

  /**
   * Clear the chat context if needed.
   */
  public clearChatContext() {
    this.chatContext = [];
    elizaLogger.log('[SttTtsPlugin] clearChatContext => done');
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
    elizaLogger.log('[SttTtsPlugin] cleanup => releasing resources');
    this.pcmBuffers.clear();
    this.userSpeakingTimer = null;
    this.ttsQueue = [];
    this.isSpeaking = false;
    this.volumeBuffers.clear();
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

    // If the audio is very quiet, amplify it
    if (maxAmplitude < 5000) {
      // Less than ~15% of max Int16 value
      const gainFactor = Math.min(3.0, 10000 / Math.max(1, maxAmplitude));
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

    return result;
  }
}
