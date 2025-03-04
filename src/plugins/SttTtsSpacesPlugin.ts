// src/plugins/SttTtsPlugin.ts

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
  type State,
  composeRandomUser,
  generateShouldRespond,
} from '@elizaos/core';
import type {
  Space,
  JanusClient,
  AudioDataWithUser,
} from '@flooz-link/agent-twitter-client';
import type { ClientBase } from '../base';
import {
  twitterVoiceHandlerTemplate,
  twitterShouldRespondTemplate,
} from './templates';
import { isEmpty } from '../utils';
import { PassThrough } from 'stream';

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
}

const VOLUME_WINDOW_SIZE = 100;
const SPEAKING_THRESHOLD = 0.05;

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

  private voiceId = '21m00Tcm4TlvDq8ikWAM';
  private elevenLabsModel = 'eleven_monolingual_v1';
  private chatContext: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }> = [];

  /**
   * Map of user IDs to promises representing ongoing processing operations
   * Used to prevent duplicate processing for the same user while allowing
   * concurrent processing for different users
   */
  private processingLocks: Map<string, Promise<void>> = new Map();
  private transcriptionService: ITranscriptionService;

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

  onAttach(_space: Space) {
    elizaLogger.log('[SttTtsPlugin] onAttach => space was attached');
  }

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

    this.volumeBuffers = new Map<string, number[]>();
    this.processingLocks = new Map<string, Promise<void>>();
  }

  /**
   * Called whenever we receive PCM from a speaker
   */
  onAudioData(data: AudioDataWithUser): void {
    if (this.isProcessingAudio) {
      return;
    }
    let maxVal = 0;
    for (let i = 0; i < data.samples.length; i++) {
      const val = Math.abs(data.samples[i]);
      if (val > maxVal) maxVal = val;
    }
    if (maxVal < this.silenceThreshold) {
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
      // check interruption
      let volumeBuffer = this.volumeBuffers.get(data.userId);
      if (!volumeBuffer) {
        volumeBuffer = [];
        this.volumeBuffers.set(data.userId, volumeBuffer);
      }
      const samples = new Int16Array(
        data.samples.buffer,
        data.samples.byteOffset,
        data.samples.length / 2,
      );
      const maxAmplitude = Math.max(...samples.map(Math.abs)) / 32768;
      volumeBuffer.push(maxAmplitude);

      if (volumeBuffer.length > VOLUME_WINDOW_SIZE) {
        volumeBuffer.shift();
      }
      const avgVolume =
        volumeBuffer.reduce((sum, v) => sum + v, 0) / VOLUME_WINDOW_SIZE;

      if (avgVolume > SPEAKING_THRESHOLD) {
        volumeBuffer.length = 0;
        if (this.ttsAbortController) {
          this.ttsAbortController.abort();
          this.isSpeaking = false;
          elizaLogger.log('[SttTtsPlugin] TTS playback interrupted');
        }
      }
    }
  }

  /**
   * Add audio chunk for a user
   */
  public addAudioChunk(userId: string, chunk: Int16Array): void {
    if (!this.pcmBuffers.has(userId)) {
      this.pcmBuffers.set(userId, []);
    }
    this.pcmBuffers.get(userId)?.push(chunk);
  }

  // /src/sttTtsPlugin.ts
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

    return buffer;
  }

  private writeString(view: DataView, offset: number, text: string) {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  }

  /**
   * On speaker silence => flush STT => GPT => TTS => push to Janus
   */
  private async processAudio(userId: string): Promise<void> {
    // Use non-blocking lock pattern with a Map of promises
    if (!this.processingLocks) {
      this.processingLocks = new Map<string, Promise<void>>();
    }

    // If already processing for this user, wait for it to complete
    if (this.processingLocks.has(userId)) {
      await this.processingLocks.get(userId);
      return;
    }

    // Create a deferred promise to track completion
    let resolveLock!: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });

    // Set the lock
    this.processingLocks.set(userId, lockPromise);

    try {
      const start = Date.now();
      elizaLogger.log(
        '[SttTtsPlugin] Starting audio processing for user:',
        userId,
      );

      // Get chunks and clear only this user's buffer (more efficient)
      const chunks = this.pcmBuffers.get(userId) || [];
      this.pcmBuffers.delete(userId); // Only delete this user's buffer instead of clearing all

      if (!chunks.length) {
        elizaLogger.warn('[SttTtsPlugin] No audio chunks for user =>', userId);
        return;
      }

      elizaLogger.log(
        `[SttTtsPlugin] Processing audio for user=${userId}, chunks=${chunks.length}`,
      );

      // ---- Start parallel operations ----

      // 1. Start merging audio buffer (CPU-bound operation)
      const mergeBufferPromise = this.mergeAudioChunks(chunks);

      // 2. Do any non-dependent work here while CPU is busy with buffer merging
      // For example, prepare any context needed for processing or clean up old resources
      this.volumeBuffers.delete(userId);

      // 3. Wait for buffer merging to complete and continue with dependent operations
      const merged = await mergeBufferPromise;
      console.log(`PCM merging took: ${Date.now() - start} ms`);

      // 4. Start audio optimization (CPU-bound) and WAV conversion (potentially I/O bound) in parallel
      const optimizedPcmPromise = Promise.resolve().then(() => {
        // Run in next tick to allow other operations to proceed
        return this.maybeDownsampleAudio(merged, 48000, 16000);
      });

      // 5. Do any non-dependent work here while waiting
      // Perhaps prepare for TTS or update UI states

      // 6. Wait for optimization to complete
      const optimizedPcm = await optimizedPcmPromise;
      console.log(`Audio optimization took: ${Date.now() - start} ms`);

      // 7. Start WAV conversion
      const wavBufferPromise = this.convertPcmToWavInMemory(
        optimizedPcm,
        optimizedPcm === merged ? 48000 : 16000,
      );

      // 8. Do any non-dependent work here while waiting for WAV conversion

      // 9. Wait for WAV conversion
      const wavBuffer = await wavBufferPromise;
      console.log(`Convert Wav took: ${Date.now() - start} ms`);

      // 10. Start transcription (I/O and CPU intensive)
      const transcriptionPromise =
        this.transcriptionService.transcribe(wavBuffer);

      // 11. Do any non-dependent work here while transcription runs
      // This is where we could prepare TTS or update UI

      // 12. Wait for transcription
      const sttText = await transcriptionPromise;
      console.log(`Transcription took: ${Date.now() - start} ms`);

      elizaLogger.log(`[SttTtsPlugin] Transcription result: "${sttText}"`);

      if (!sttText?.trim()) {
        elizaLogger.warn(
          '[SttTtsPlugin] No speech recognized for user =>',
          userId,
        );
        return;
      }

      elizaLogger.log(
        `[SttTtsPlugin] STT => user=${userId}, text="${sttText}"`,
      );

      // 13. Start getting the response while doing other preparations
      const replyPromise = this.handleUserMessage(sttText, userId);

      // 14. Prepare for TTS while waiting for the response
      const ttsPreparationPromise = this.prepareTTS?.() || Promise.resolve();

      // 15. Wait for both the reply and TTS preparation (if implemented)
      const [replyText] = await Promise.all([
        replyPromise,
        ttsPreparationPromise,
      ]);

      if (!replyText?.trim()) {
        elizaLogger.warn('[SttTtsPlugin] No replyText for user =>', userId);
        return;
      }

      elizaLogger.log(`[SttTtsPlugin] user=${userId}, reply="${replyText}"`);

      // 16. Speak the reply
      await this.speakText(replyText);
    } catch (error) {
      elizaLogger.error('[SttTtsPlugin] processAudio error =>', error);
    } finally {
      // Release the lock
      this.processingLocks.delete(userId);
      resolveLock();
    }
  }

  /**
   * Helper method to merge audio chunks in a non-blocking way
   * This allows other operations to continue while CPU-intensive merging happens
   */
  private async mergeAudioChunks(chunks: Int16Array[]): Promise<Int16Array> {
    return new Promise<Int16Array>((resolve) => {
      // Use setImmediate to allow other operations to proceed
      setImmediate(() => {
        const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
        const merged = new Int16Array(totalLen);
        let offset = 0;
        for (const c of chunks) {
          merged.set(c, offset);
          offset += c.length;
        }
        resolve(merged);
      });
    });
  }

  /**
   * Optional TTS preparation method - implement if needed
   * This could pre-warm TTS systems or prepare audio output devices
   */
  private async prepareTTS(): Promise<void> {
    // Implementation depends on your TTS system
    // This is a placeholder for potential TTS preparation tasks that could run in parallel
    return Promise.resolve();
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

    // Simple downsampling by picking every Nth sample
    // For production use, consider a proper resampling algorithm with anti-aliasing
    for (let i = 0; i < newLength; i++) {
      const sourceIndex = Math.floor(i * ratio);
      result[i] = audio[sourceIndex];
    }

    return result;
  }

  // private async processAudio(userId: string): Promise<void> {
  //   if (this.isProcessingAudio) {
  //     return;
  //   }
  //   this.isProcessingAudio = true;
  //   try {
  //     const start = Date.now();
  //     elizaLogger.log(
  //       '[SttTtsPlugin] Starting audio processing for user:',
  //       userId,
  //     );
  //     const chunks = this.pcmBuffers.get(userId) || [];
  //     this.pcmBuffers.clear();

  //     if (!chunks.length) {
  //       elizaLogger.warn('[SttTtsPlugin] No audio chunks for user =>', userId);
  //       return;
  //     }
  //     elizaLogger.log(
  //       `[SttTtsPlugin] Flushing STT buffer for user=${userId}, chunks=${chunks.length}`,
  //     );
  //     console.log(`PCM took: ${Date.now() - start} ms`);

  //     const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
  //     const merged = new Int16Array(totalLen);
  //     let offset = 0;
  //     for (const c of chunks) {
  //       merged.set(c, offset);
  //       offset += c.length;
  //     }

  //     // Convert PCM to WAV for STT
  //     const wavBuffer = await this.convertPcmToWavInMemory(merged, 48000);
  //     console.log(`Convert Wav took: ${Date.now() - start} ms`);

  //     // Whisper STT
  //     const sttText = await this.transcriptionService.transcribe(wavBuffer);

  //     console.log(`Transcription took: ${Date.now() - start} ms`);

  //     elizaLogger.log(`[SttTtsPlugin] Transcription result: "${sttText}"`);

  //     if (isEmpty(sttText?.trim())) {
  //       elizaLogger.warn(
  //         '[SttTtsPlugin] No speech recognized for user =>',
  //         userId,
  //       );
  //       return;
  //     }
  //     elizaLogger.log(
  //       `[SttTtsPlugin] STT => user=${userId}, text="${sttText}"`,
  //     );

  //     // Get response
  //     const replyText = await this.handleUserMessage(sttText, userId);
  //     if (isEmpty(replyText?.trim())) {
  //       elizaLogger.warn('[SttTtsPlugin] No replyText for user =>', userId);
  //       return;
  //     }
  //     elizaLogger.log(`[SttTtsPlugin] user=${userId}, reply="${replyText}"`);
  //     this.isProcessingAudio = false;
  //     this.volumeBuffers.clear();
  //     // Use the standard speak method with queue
  //     await this.speakText(replyText);
  //   } catch (error) {
  //     elizaLogger.error('[SttTtsPlugin] processAudio error =>', error);
  //   } finally {
  //     this.isProcessingAudio = false;
  //   }
  // }

  /**
   * Public method to queue a TTS request
   */
  public async speakText(text: string): Promise<void> {
    this.ttsQueue.push(text);
    if (!this.isSpeaking) {
      this.isSpeaking = true;
      const start = Date.now();
      this.processTtsQueue()
        .catch((err) => {
          elizaLogger.error('[SttTtsPlugin] processTtsQueue error =>', err);
        })
        .then((res) => {
          console.log(`Voice took ${Date.now() - start}`);
          return res;
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

  /**
   * Stop any ongoing TTS playback
   */
  public stopSpeaking(): void {
    if (this.ttsAbortController) {
      this.ttsAbortController.abort();
    }
    this.ttsQueue = [];
  }

  /**
   * Process TTS text and stream directly to Janus with minimal latency
   * @param text Text to convert to speech
   * @param signal Abort controller signal
   */
  private async streamTtsToJanus(
    text: string,
    signal: AbortSignal,
  ): Promise<void> {
    // Set chunk size for streaming - CORRECTED to 480 samples (10ms at 48kHz)
    const SAMPLE_RATE = 48000;
    const PCM_CHUNK_SAMPLES = 480; // FIXED: Janus expects exactly 480 samples per frame
    const PCM_CHUNK_BYTES = PCM_CHUNK_SAMPLES * 2; // 2 bytes per sample for Int16

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

    // Start the ElevenLabs API call with streaming response
    const elevenLabsPromise = this.elevenLabsTtsStreaming(
      text,
      mp3Stream,
      signal,
    );

    // Buffer for accumulating audio chunks for streaming
    let pcmBuffer = Buffer.alloc(0);

    // Process FFmpeg output in chunks and stream to Janus
    const processingPromise = new Promise<void>((resolve, reject) => {
      ffmpeg.stdout.on('data', async (chunk: Buffer) => {
        try {
          if (signal.aborted) {
            return; // Stop processing if aborted
          }

          // Append new chunk to our buffer
          pcmBuffer = Buffer.concat([pcmBuffer, chunk]);

          // Process complete chunks
          while (pcmBuffer.length >= PCM_CHUNK_BYTES) {
            // Extract a complete chunk
            const chunkToSend = pcmBuffer.slice(0, PCM_CHUNK_BYTES);
            pcmBuffer = pcmBuffer.slice(PCM_CHUNK_BYTES);

            // Convert buffer to Int16Array for Janus
            const samples = new Int16Array(
              chunkToSend.buffer,
              chunkToSend.byteOffset,
              chunkToSend.byteLength / 2,
            );

            // Stream this chunk to Janus - confirm it has exactly 480 samples
            if (samples.length === PCM_CHUNK_SAMPLES) {
              await this.streamChunkToJanus(samples, SAMPLE_RATE);
            } else {
              console.warn(
                `[SttTtsPlugin] Invalid chunk size: ${samples.length}, expected ${PCM_CHUNK_SAMPLES}`,
              );
            }

            // Allow other events to process
            await new Promise((resolve) => setImmediate(resolve));

            // Check for abort between chunks
            if (signal.aborted) {
              console.log('[SttTtsPlugin] TTS streaming interrupted');
              break;
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

      ffmpeg.on('close', async (code) => {
        try {
          if (code !== 0 && !signal.aborted) {
            reject(
              new Error(`ffmpeg streaming process exited with code ${code}`),
            );
            return;
          }

          // Process any remaining audio in the buffer
          if (pcmBuffer.length > 0 && !signal.aborted) {
            // Handle partial frame if needed
            if (pcmBuffer.length < PCM_CHUNK_BYTES) {
              // Option 1: Pad with silence to get a full frame
              const paddedBuffer = Buffer.alloc(PCM_CHUNK_BYTES);
              pcmBuffer.copy(paddedBuffer);

              const samples = new Int16Array(
                paddedBuffer.buffer,
                paddedBuffer.byteOffset,
                PCM_CHUNK_SAMPLES,
              );

              await this.streamChunkToJanus(samples, SAMPLE_RATE);
            } else {
              // Handle complete frames in the remaining buffer
              while (pcmBuffer.length >= PCM_CHUNK_BYTES) {
                const chunkToSend = pcmBuffer.slice(0, PCM_CHUNK_BYTES);
                pcmBuffer = pcmBuffer.slice(PCM_CHUNK_BYTES);

                const samples = new Int16Array(
                  chunkToSend.buffer,
                  chunkToSend.byteOffset,
                  PCM_CHUNK_SAMPLES,
                );

                await this.streamChunkToJanus(samples, SAMPLE_RATE);
              }
            }
          }

          resolve();
        } catch (error) {
          reject(error);
        }
      });

      // Handle errors from FFmpeg
      ffmpeg.on('error', (err) => {
        reject(new Error(`FFmpeg process error: ${err.message}`));
      });
    });

    // Wait for both the ElevenLabs download and processing to complete
    await Promise.all([elevenLabsPromise, processingPromise]);
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

          // Log the buffer size to verify
          console.log(
            `[SttTtsPlugin] Sending audio frame: ${bufferView.length} samples, ${bufferView.buffer.byteLength} bytes`,
          );

          // Send the properly sized buffer to Janus
          this.janus?.pushLocalAudio(bufferView, sampleRate);
        } else {
          // The buffer is already the right size
          console.log(
            `[SttTtsPlugin] Sending audio frame: ${samples.length} samples, ${samples.buffer.byteLength} bytes`,
          );
          this.janus?.pushLocalAudio(samples, sampleRate);
        }

        resolve();
      } catch (error) {
        console.error('[SttTtsPlugin] Error sending audio to Janus:', error);
        reject(error);
      }
    });
  }

  // /**
  //  * Stream a single chunk of audio to Janus
  //  * This method should be adapted to match your Janus implementation
  //  */
  // private async streamChunkToJanus(
  //   samples: Int16Array,
  //   sampleRate: number,
  // ): Promise<void> {
  //   // Make sure we're sending exactly the frame size Janus expects
  //   if (samples.length !== 480) {
  //     console.warn(
  //       `[SttTtsPlugin] Invalid frame size: ${samples.length}, expected 480`,
  //     );
  //   }

  //   return new Promise<void>((resolve) => {
  //     // Send the audio chunk to Janus
  //     this.janus?.pushLocalAudio(samples, sampleRate);
  //     resolve();
  //   });
  // }
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
   * Process the TTS queue with optimized parallelism
   */
  // private async processTtsQueue(): Promise<void> {
  //   while (this.ttsQueue.length > 0) {
  //     const text = this.ttsQueue.shift();
  //     if (!text) continue;

  //     this.ttsAbortController = new AbortController();
  //     const { signal } = this.ttsAbortController;

  //     try {
  //       const ttsAudio = await this.elevenLabsTts(text);
  //       const pcm = await this.convertMp3ToPcm(ttsAudio, 48000);
  //       if (signal.aborted) {
  //         elizaLogger.log('[SttTtsPlugin] TTS interrupted before streaming');
  //         return;
  //       }
  //       await this.streamToJanus(pcm, 48000);
  //       if (signal.aborted) {
  //         elizaLogger.log('[SttTtsPlugin] TTS interrupted after streaming');
  //         return;
  //       }
  //     } catch (err) {
  //       elizaLogger.error('[SttTtsPlugin] TTS streaming error =>', err);
  //     } finally {
  //       // Clean up the AbortController
  //       this.ttsAbortController = null;
  //     }
  //   }
  //   this.isSpeaking = false;
  // }

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

    return reply;
  }

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

  private async _shouldRespond(
    message: string,
    state: State,
  ): Promise<boolean> {
    const lowerMessage = message.toLowerCase();
    const characterName = this.runtime.character.name.toLowerCase();

    if (lowerMessage.includes(characterName)) {
      return true;
    }

    // If none of the above conditions are met, use the generateText to decide
    const shouldRespondContext = composeContext({
      state,
      template:
        this.runtime.character.templates?.twitterShouldRespondTemplate ||
        this.runtime.character.templates?.shouldRespondTemplate ||
        composeRandomUser(twitterShouldRespondTemplate, 2),
    });

    const response = await generateShouldRespond({
      runtime: this.runtime,
      context: shouldRespondContext,
      modelClass: ModelClass.SMALL,
    });

    if (response === 'RESPOND') {
      return true;
    }

    if (response === 'IGNORE' || response === 'STOP') {
      return false;
    }

    elizaLogger.error('Invalid response from response generateText:', response);
    return false;
  }

  /**
   * ElevenLabs TTS => returns MP3 Buffer
   */
  private async elevenLabsTts(text: string): Promise<Buffer> {
    if (!this.elevenLabsApiKey) {
      throw new Error('[SttTtsPlugin] No ElevenLabs API key');
    }
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': this.elevenLabsApiKey,
      },
      body: JSON.stringify({
        text,
        model_id: this.elevenLabsModel,
        voice_settings: { stability: 0.4, similarity_boost: 0.8 },
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(
        `[SttTtsPlugin] ElevenLabs TTS error => ${resp.status} ${errText}`,
      );
    }
    const arrayBuf = await resp.arrayBuffer();
    return Buffer.from(arrayBuf);
  }

  /**
   * Convert MP3 => PCM via ffmpeg with optimizations
   */
  // private convertMp3ToPcm(
  //   mp3Buf: Buffer,
  //   outRate: number,
  // ): Promise<Int16Array> {
  //   return new Promise((resolve, reject) => {
  //     // Optimize ffmpeg parameters for speed
  //     const ff = spawn('ffmpeg', [
  //       // Input buffer settings
  //       '-i',
  //       'pipe:0',

  //       // Performance optimizations
  //       '-threads',
  //       '4', // Use multiple threads (adjust based on your CPU)
  //       '-loglevel',
  //       'error', // Reduce logging overhead
  //       '-nostdin', // Don't wait for console input

  //       // Optimization flags
  //       '-fflags',
  //       '+nobuffer', // Reduce buffering
  //       '-flags',
  //       '+low_delay', // Prioritize low delay processing
  //       '-probesize',
  //       '32', // Use minimal probing (we know it's an MP3)
  //       '-analyzeduration',
  //       '0', // Skip lengthy analysis

  //       // Output format settings (unchanged but grouped)
  //       '-f',
  //       's16le', // Output format
  //       '-ar',
  //       outRate.toString(), // Sample rate
  //       '-ac',
  //       '1', // Mono audio
  //       'pipe:1', // Output to stdout
  //     ]);

  //     // Pre-allocate larger chunks to reduce Buffer.concat operations
  //     const chunks: Buffer[] = [];
  //     let totalLength = 0;

  //     ff.stdout.on('data', (chunk: Buffer) => {
  //       chunks.push(chunk);
  //       totalLength += chunk.length;
  //     });

  //     ff.stderr.on('data', (data) => {
  //       // Only log actual errors
  //       if (data.toString().includes('Error')) {
  //         console.error('[FFmpeg Error]', data.toString().trim());
  //       }
  //     });

  //     ff.on('close', (code) => {
  //       if (code !== 0) {
  //         reject(new Error(`ffmpeg error code=${code}`));
  //         return;
  //       }

  //       // Efficient buffer concatenation
  //       const raw = Buffer.concat(chunks, totalLength);

  //       // Directly create the Int16Array from buffer
  //       // This avoids an extra copy operation
  //       const samples = new Int16Array(
  //         raw.buffer,
  //         raw.byteOffset,
  //         raw.byteLength / 2,
  //       );

  //       resolve(samples);
  //     });

  //     // Write the input buffer and end the stream in one operation
  //     ff.stdin.end(mp3Buf);
  //   });
  // }

  /**
   * Push PCM back to Janus in small frames
   * We'll do 10ms @48k => 480 samples per frame (not 960)
   */
  // private async streamToJanus(
  //   samples: Int16Array,
  //   sampleRate: number,
  // ): Promise<void> {
  //   // FIXED: Use 480 samples per frame as required by Janus
  //   const FRAME_SIZE = 480; // 10ms frames @ 48kHz

  //   for (
  //     let offset = 0;
  //     offset + FRAME_SIZE <= samples.length;
  //     offset += FRAME_SIZE
  //   ) {
  //     if (this.ttsAbortController?.signal.aborted) {
  //       elizaLogger.log('[SttTtsPlugin] streamToJanus interrupted');
  //       return;
  //     }
  //     const frame = new Int16Array(FRAME_SIZE);
  //     frame.set(samples.subarray(offset, offset + FRAME_SIZE));
  //     this.janus?.pushLocalAudio(frame, sampleRate, 1);

  //     // Short pause so we don't overload
  //     await new Promise((r) => setTimeout(r, 10));
  //   }
  // }

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

  cleanup(): void {
    elizaLogger.log('[SttTtsPlugin] cleanup => releasing resources');
    this.pcmBuffers.clear();
    this.userSpeakingTimer = null;
    this.ttsQueue = [];
    this.isSpeaking = false;
    this.volumeBuffers.clear();
  }
}
