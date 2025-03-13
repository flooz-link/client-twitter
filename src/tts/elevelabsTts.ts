import { spawn } from 'child_process';
import { PassThrough } from 'stream';
import { elizaLogger } from '@elizaos/core';
import { BaseTTSService, TTSServiceConfig } from './baseTts';

/**
 * ElevenLabs-specific configuration
 */
export interface ElevenLabsConfig extends TTSServiceConfig {
  apiKey: string; // Required for ElevenLabs
  voiceId?: string;
  model?: string;
  stability?: number;
  similarityBoost?: number;
  optimizeStreamingLatency?: number;
}

/**
 * ElevenLabs implementation of the TTS service
 */
export class ElevenLabsTTSService extends BaseTTSService {
  private elevenLabsApiKey: string;
  private voiceId: string = '21m00Tcm4TlvDq8ikWAM'; // Default voice ID
  private model: string = 'eleven_monolingual_v1'; // Default model
  private stability: number = 0.5;
  private similarityBoost: number = 0.75;
  private optimizeStreamingLatency: number = 3;
  private sampleRate: number = 48000;
  private channels: number = 1;

  constructor(config: ElevenLabsConfig) {
    super(config);

    // Required configuration
    if (!config.apiKey) {
      throw new Error('ElevenLabs API key is required');
    }
    this.elevenLabsApiKey = config.apiKey;

    // Optional configuration with defaults
    if (config.voiceId) {
      this.voiceId = config.voiceId;
    }
    if (config.model) {
      this.model = config.model;
    }
    if (config.stability !== undefined) {
      this.stability = config.stability;
    }
    if (config.similarityBoost !== undefined) {
      this.similarityBoost = config.similarityBoost;
    }
    if (config.optimizeStreamingLatency !== undefined) {
      this.optimizeStreamingLatency = config.optimizeStreamingLatency;
    }
    if (config.sampleRate) {
      this.sampleRate = config.sampleRate;
    }
    if (config.channels) {
      this.channels = config.channels;
    }
  }

  /**
   * Initialize the ElevenLabs TTS service
   */
  async init(): Promise<void> {
    // ElevenLabs doesn't require initialization beyond what's in the constructor
    elizaLogger.log('[ElevenLabsTTSService] Initialized');
    return Promise.resolve();
  }

  /**
   * Convert text to speech and stream to audio output
   */
  async streamTTS(
    text: string,
    streamId: string,
    signal: AbortSignal,
  ): Promise<void> {
    // Add natural pauses at punctuation to make speech sound more natural
    const textWithPauses = text
      .replace(/\.\s+/g, '. <break time="5ms"/> ')
      .replace(/,\s+/g, ', <break time="2ms"/> ')
      .replace(/\?\s+/g, '? <break time="5ms"/> ')
      .replace(/!\s+/g, '! <break time="5ms"/> ')
      .replace(/;\s+/g, '; <break time="5ms"/> ')
      .replace(/:\s+/g, ': <break time="5ms"/> ');

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
      elizaLogger.log(`[ElevenLabsTTSService] Stream ${streamId} aborted`);
    });

    // Setup FFmpeg to convert mp3 stream to raw PCM
    const ffmpeg = spawn('ffmpeg', [
      '-i',
      'pipe:0',
      '-f',
      's16le',
      '-acodec',
      'pcm_s16le',
      '-ar',
      this.sampleRate.toString(),
      '-ac',
      this.channels.toString(),
      'pipe:1',
    ]);

    ffmpeg.on('error', (err) => {
      console.error('[ElevenLabsTTSService] FFMPEG process error:', err);
      elizaLogger.error('[ElevenLabsTTSService] FFMPEG process error:', err);
      isInterrupted = true;
    });

    const audioBuffer: Int16Array[] = [];
    const processingPromise = new Promise<void>((resolve, reject) => {
      let pcmBuffer = Buffer.alloc(0);
      const bufferStats = {
        totalChunks: 0,
        totalBytes: 0,
        emptyChunks: 0,
      };

      ffmpeg.stdout.on('data', (chunk: Buffer) => {
        if (isInterrupted || signal.aborted) return;

        bufferStats.totalChunks++;
        bufferStats.totalBytes += chunk.length;

        if (chunk.length === 0) {
          bufferStats.emptyChunks++;
          console.warn(
            '[ElevenLabsTTSService] Received empty chunk from FFmpeg',
          );
          return;
        }

        pcmBuffer = Buffer.concat([pcmBuffer, chunk]);
        const FRAME_SIZE = 480; // Standard frame size for 10ms at 48kHz
        const frameCount = Math.floor(pcmBuffer.length / (FRAME_SIZE * 2)); // 2 bytes per sample (16-bit)

        if (frameCount > 0) {
          try {
            for (let i = 0; i < frameCount; i++) {
              // Check for valid slice parameters
              const startOffset = i * FRAME_SIZE * 2 + pcmBuffer.byteOffset;
              const endOffset = (i + 1) * FRAME_SIZE * 2 + pcmBuffer.byteOffset;

              if (
                startOffset >= pcmBuffer.buffer.byteLength ||
                endOffset > pcmBuffer.buffer.byteLength
              ) {
                console.error(
                  `[ElevenLabsTTSService] Invalid buffer slice: start=${startOffset}, end=${endOffset}, bufferLength=${pcmBuffer.buffer.byteLength}`,
                );
                continue;
              }

              const frame = new Int16Array(
                pcmBuffer.buffer.slice(startOffset, endOffset),
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
                console.error(
                  '[ElevenLabsTTSService] Invalid audio data detected in frame',
                );
                continue;
              }

              const frameCopy = new Int16Array(FRAME_SIZE);
              frameCopy.set(frame);
              audioBuffer.push(frameCopy);
            }

            pcmBuffer = pcmBuffer.slice(frameCount * FRAME_SIZE * 2);
          } catch (err) {
            console.error(
              '[ElevenLabsTTSService] Error processing audio frames:',
              err,
            );
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
        elizaLogger.error('[ElevenLabsTTSService] FFMPEG stdout error:', err);
        reject(err);
      });
    });

    // Call ElevenLabs API
    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/stream?optimize_streaming_latency=${this.optimizeStreamingLatency}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'xi-api-key': this.elevenLabsApiKey,
          },
          body: JSON.stringify({
            text: textWithPauses,
            model_id: this.model,
            voice_settings: {
              stability: this.stability,
              similarity_boost: this.similarityBoost,
            },
          }),
        },
      );

      if (!response.ok || !response.body) {
        throw new Error(
          `ElevenLabs API error: ${response.status} ${response.statusText}`,
        );
      }

      const reader = response.body.getReader();
      const readStream = async () => {
        try {
          while (true) {
            if (isInterrupted || signal.aborted) {
              break;
            }
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            if (value) {
              ffmpeg.stdin.write(value);
            }
          }
        } catch (err) {
          elizaLogger.error(
            '[ElevenLabsTTSService] Error reading from ElevenLabs stream:',
            err,
          );
        } finally {
          ffmpeg.stdin.end();
        }
      };

      readStream();

      await Promise.race([
        processingPromise.catch((err) => {
          console.error('[ElevenLabsTTSService] Processing error:', err);
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

      // Play the audio frames at the correct rate
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

        const idealPlaybackTime = startTime + frameIndex * 10; // 10ms per frame
        const currentTime = Date.now();

        if (currentTime < idealPlaybackTime) {
          await new Promise((r) =>
            setTimeout(r, idealPlaybackTime - currentTime),
          );
        } else if (currentTime > idealPlaybackTime + 100) {
          // We're behind by more than 100ms, skip frames to catch up
          const framesToSkip = Math.floor(
            (currentTime - idealPlaybackTime) / 10,
          );
          if (framesToSkip > 0) {
            elizaLogger.log(
              `[ElevenLabsTTSService] Skipping ${framesToSkip} frames to catch up`,
            );
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
            this.emitAudioFrame(properSizedFrame, this.sampleRate, streamId);
          } else {
            this.emitAudioFrame(frame, this.sampleRate, streamId);
          }
        }
        frameIndex++;
      }

      if (signal.aborted || isInterrupted) {
        elizaLogger.log(
          `[ElevenLabsTTSService] Audio streaming was interrupted before completion for stream ${streamId}`,
        );
      } else {
        elizaLogger.log(
          `[ElevenLabsTTSService] Audio streaming completed successfully for stream ${streamId}`,
        );
      }
    } catch (error) {
      elizaLogger.error(
        `[ElevenLabsTTSService] Error during TTS streaming for stream ${streamId}:`,
        error,
      );
      throw error;
    }
  }
}
