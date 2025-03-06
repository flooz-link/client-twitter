import { spawn } from 'child_process';
import {
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
import { EventEmitter } from 'events';
import OpenAI from 'openai';
import {
  DeepgramStreamingClient,
  DeepgramStreamingOptions,
} from '../services/DeepgramStreamingClient';

interface PluginConfig {
  runtime: IAgentRuntime;
  client: ClientBase;
  spaceId: string;
  elevenLabsApiKey?: string;
  sttLanguage?: string;
  silenceThreshold?: number;
  silenceDetectionWindow?: number;
  voiceId?: string;
  elevenLabsModel?: string;
  chatContext?: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
  deepgramApiKey: string;
  grokApiKey?: string;
  grokBaseUrl?: string;
}

export class AdaptedSttTtsPlugin implements Plugin {
  name = 'AdaptedSttTtsPlugin';
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
  private chatContext: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }> = [];

  private pcmBuffers = new Map<string, Float32Array[]>();
  private silenceThreshold = 50;
  private silenceDetectionThreshold = 1000;

  private ttsQueue: string[] = [];
  private isSpeaking = false;
  private isProcessingAudio = false;

  private userSpeakingTimer: NodeJS.Timeout | null = null;
  private volumeBuffers: Map<string, number[]>;
  private ttsAbortController: AbortController | null = null;

  private eventEmitter = new EventEmitter();
  private openai: OpenAI;
  private deepgramClient: DeepgramStreamingClient;

  private audioQueue: string[] = [];
  private isStreamingToJanus = false;

  constructor(config: PluginConfig) {
    this.runtime = config.runtime;
    this.client = config.client;
    this.spaceId = config.spaceId;
    this.elevenLabsApiKey = config.elevenLabsApiKey;

    if (typeof config.silenceThreshold === 'number') {
      this.silenceThreshold = config.silenceThreshold;
    }
    if (typeof config.silenceDetectionWindow === 'number') {
      this.silenceDetectionThreshold = config.silenceDetectionWindow;
    }
    if (config.voiceId) {
      this.voiceId = config.voiceId;
    }
    if (config.elevenLabsModel) {
      this.elevenLabsModel = config.elevenLabsModel;
    }
    if (config.chatContext) {
      this.chatContext = config.chatContext;
    }
    this.grokApiKey =
      config.grokApiKey ?? this.runtime.getSetting('GROK_API_KEY');
    this.grokBaseUrl =
      config.grokBaseUrl ??
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

    const deepgramOptions: DeepgramStreamingOptions = {
      apiKey: config.deepgramApiKey,
      language: config.sttLanguage || 'en',
      model: 'nova-2',
      punctuate: true,
      interim_results: true,
      endpointing: 'enhanced',
      vad_events: true,
      smart_format: true,
    };
    this.deepgramClient = new DeepgramStreamingClient(deepgramOptions);

    this.deepgramClient.on('connected', () => {
      elizaLogger.info('[AdaptedSttTtsPlugin] Deepgram connected');
    });

    this.deepgramClient.on('disconnected', () => {
      elizaLogger.info('[AdaptedSttTtsPlugin] Deepgram disconnected');
    });

    this.deepgramClient.on('error', (error) => {
      elizaLogger.error('[AdaptedSttTtsPlugin] Deepgram error:', error);
    });

    this.deepgramClient.on('sentence', (sentence) => {
      elizaLogger.info('[AdaptedSttTtsPlugin] Sentence detected:', sentence);
      this.handleSentence(sentence);
    });
  }

  init(params: { space: Space; pluginConfig?: Record<string, any> }): void {
    elizaLogger.log(
      '[AdaptedSttTtsPlugin] init => Space fully ready. Subscribing to events.',
    );

    this.space = params.space;
    this.janus = (this.space as any)?.janusClient as JanusClient | undefined;

    this.deepgramClient.connect();
  }

  onAudioData(data: AudioDataWithUser): void {
    const audioBuffer = new Float32Array(data.audioData);
    if (this.analyzeForInterruption(audioBuffer)) {
      this.deepgramClient.sendAudio(audioBuffer);
    }
  }

  private analyzeForInterruption(audio: Float32Array): boolean {
    const audioLength = audio.length;
    if (audioLength < 512) return false;

    let zeroCrossings = 0;
    for (let i = 1; i < audioLength; i++) {
      if (
        (audio[i] >= 0 && audio[i - 1] < 0) ||
        (audio[i] < 0 && audio[i - 1] >= 0)
      ) {
        zeroCrossings++;
      }
    }
    const zcr = zeroCrossings / audio.length;

    let sumSquares = 0;
    for (let i = 0; i < audioLength; i++) {
      sumSquares += audio[i] * audio[i];
    }
    const rms = Math.sqrt(sumSquares / audioLength);

    return zcr > 0.05 && zcr < 0.15 && rms > 0.07;
  }

  private async processAudioQueue() {
    if (this.isStreamingToJanus || this.audioQueue.length === 0) return;
    this.isStreamingToJanus = true;
    const sentence = this.audioQueue.shift();
    if (sentence) {
      await this.streamToJanus(sentence);
    }
    this.isStreamingToJanus = false;
    if (this.audioQueue.length > 0) {
      setTimeout(() => this.processAudioQueue(), 1000); // Add delay between streams
    }
  }

  private async streamToJanus(sentence: string) {
    elizaLogger.info('[AdaptedSttTtsPlugin] Streaming to Janus:', sentence);
    // Simulate streaming delay
    return new Promise((resolve) => setTimeout(resolve, 2000));
  }

  private handleSentence(sentence: string) {
    this.audioQueue.push(sentence);
    this.processAudioQueue();
  }
}
