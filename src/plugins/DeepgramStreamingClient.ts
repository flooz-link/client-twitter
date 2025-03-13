import {
  elizaLogger,
  stringToUuid,
  composeContext,
  getEmbeddingZeroVector,
  type IAgentRuntime,
  type Memory,
  type Plugin,
  State,
} from '@elizaos/core';
import type {
  Space,
  JanusClient,
  AudioDataWithUser,
} from '@flooz-link/agent-twitter-client';
import type { ClientBase, TwitterProfile } from '../base';
import { twitterSpaceTemplate } from './templates';
import { isEmpty, isNotEmpty } from '../utils';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { ActiveStreamManager } from './activeStreamManager';
import { ChatInteraction, ShortTermMemory } from './sortTermMemory';
import {
  BaseTranscriptionService,
  TranscriptData,
  TranscriptionEvents,
} from '../transcription/baseTranscription';
import { TranscriptionMonitor } from '../transcription/transcriptionDeltaMonitor';
import { BaseTTSService, TTSEvents } from '../tts/baseTts';
import { ElevenLabsConfig, ElevenLabsTTSService } from '../tts/elevelabsTts';
import {
  BaseLLMService,
  LLMEvents,
  LLMChatMessage,
} from '../llm/baseLLMService';
import { GrokLLMService, GrokLLMConfig } from '../llm/grokLLMService';

interface PluginConfig {
  runtime: IAgentRuntime;
  client: ClientBase;
  spaceId: string;
  elevenLabsApiKey?: string;
  voiceId?: string;
  elevenLabsModel?: string;
  chatContext?: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
  transcriptionService?: BaseTranscriptionService;
  ttsService?: BaseTTSService;
  llmService?: BaseLLMService;
  grokApiKey?: string;
  grokBaseUrl?: string;
  deepgramApiKey: string; // Required for Deepgram
}

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

  private isProcessingAudio = false;
  private latestActiveStreamId: string | null = null;
  private activeStreamManager = new ActiveStreamManager();
  private shortTermMemory = new ShortTermMemory();
  private eventEmitter = new EventEmitter();
  private lastSpeaker: string | null = null;

  private interruptionThreshold = 3000; // Energy threshold for detecting speech (configurable)
  private consecutiveFramesForInterruption = 5; // Number of consecutive frames to confirm interruption
  private interruptionCounter = 0; // Counter for consecutive high-energy frames

  private transcriptionService: BaseTranscriptionService;
  private ttsService: BaseTTSService;
  private llmService: BaseLLMService;

  private botProfile: TwitterProfile;

  private transcriptionaBufferDuration = 500; // ms to buffer transcribed text before processing

  private transcriptionMonitor: TranscriptionMonitor;

  init(params: { space: Space; pluginConfig?: Record<string, any> }): void {
    elizaLogger.log(
      '[SttTtsPlugin] init => Space fully ready. Subscribing to events.',
    );

    this.space = params.space;
    this.botProfile = params.pluginConfig?.user;
    this.janus = (this.space as any)?.janusClient as JanusClient | undefined;

    const config = params.pluginConfig as PluginConfig;

    this.runtime = config?.runtime;
    this.client = config?.client;
    this.spaceId = config?.spaceId;

    // Initialize services
    this.initializeTranscription(config);
    this.initializeTts(config);
    this.initializeLLM(config);

    // Connect the LLM service to the TTS service
    this.llmService.setTTSService(this.ttsService);
  }

  private initializeTts(config: PluginConfig): void {
    // Initialize the TTS service
    if (config?.ttsService) {
      this.ttsService = config.ttsService;

      // Set the shared stream manager if the TTS service supports it
      if (
        this.ttsService &&
        typeof (this.ttsService as any).setStreamManager === 'function'
      ) {
        (this.ttsService as any).setStreamManager(this.activeStreamManager);
      }
    } else {
      // If no TTS service is provided, create an ElevenLabs TTS service
      if (isEmpty(config?.elevenLabsApiKey)) {
        throw new Error('ElevenLabs API key is required');
      }

      // Create the ElevenLabs TTS service with appropriate configuration
      const ttsConfig: ElevenLabsConfig = {
        apiKey: config.elevenLabsApiKey,
        voiceId: config?.voiceId || '21m00Tcm4TlvDq8ikWAM',
        model: config?.elevenLabsModel || 'eleven_monolingual_v1',
        stability: 0.5,
        similarityBoost: 0.75,
        optimizeStreamingLatency: 3,
        sampleRate: 48000,
        channels: 1,
      };

      this.ttsService = new ElevenLabsTTSService(ttsConfig);

      // Set the shared stream manager if the TTS service supports it
      if (
        this.ttsService &&
        typeof (this.ttsService as any).setStreamManager === 'function'
      ) {
        (this.ttsService as any).setStreamManager(this.activeStreamManager);
      }
    }

    // Initialize the TTS service
    this.ttsService.init().catch((err) => {
      elizaLogger.error(
        '[SttTtsPlugin] Failed to initialize TTS service:',
        err,
      );
    });

    // Setup TTS service event listeners
    this.ttsService.on(TTSEvents.SPEAKING_START, (streamId) => {
      elizaLogger.log(
        `[SttTtsPlugin] TTS speech started for stream ${streamId}`,
      );
    });

    this.ttsService.on(TTSEvents.SPEAKING_END, (streamId) => {
      elizaLogger.log(`[SttTtsPlugin] TTS speech ended for stream ${streamId}`);
    });

    this.ttsService.on(TTSEvents.SPEAKING_ERROR, (error, streamId) => {
      elizaLogger.error(
        `[SttTtsPlugin] TTS speech error for stream ${streamId}:`,
        error,
      );
    });

    this.ttsService.on(TTSEvents.SPEAKING_INTERRUPTED, (streamId) => {
      elizaLogger.log(
        `[SttTtsPlugin] TTS speech interrupted for stream ${streamId}`,
      );
    });

    this.ttsService.on(
      TTSEvents.AUDIO_DATA,
      (frame: Int16Array, sampleRate: number, _streamId: string) => {
        if (this.janus) {
          this.janus.pushLocalAudio(frame, sampleRate);
        }
      },
    );
  }

  private initializeTranscription(config: PluginConfig): void {
    if (config?.transcriptionService) {
      this.transcriptionService = config?.transcriptionService;
    }

    this.transcriptionMonitor = new TranscriptionMonitor(
      (userId: string, transcript: string) => {
        this.processBufferedTranscription(userId, transcript);
      },
      {
        bufferDuration: this.transcriptionaBufferDuration,
        checkInterval: 500,
        speechQuietPeriod: 800,
        autoStart: true,
      },
    );

    this.transcriptionService.initialize();

    try {
      // Setup event listeners outside of the Open event to ensure they're registered
      // before any messages arrive
      this.transcriptionService.on(
        TranscriptionEvents.TRANSCRIPT,
        (data: TranscriptData) => {
          const transcript =
            data.transcript ??
            data?.raw?.channel?.alternatives?.[0]?.transcript;

          if (isEmpty(transcript)) {
            return;
          }

          if (data && this.lastSpeaker) {
            this.transcriptionMonitor.addTranscription(
              this.lastSpeaker,
              transcript,
              data.isFinal ?? data?.raw?.speech_final,
            );
          }
        },
      );

      this.transcriptionService.on(
        TranscriptionEvents.DISCONNECTED,
        async (test) => {
          console.log('transcription: disconnected', test);
        },
      );

      this.transcriptionService.on(TranscriptionEvents.ERROR, (error: any) => {
        console.log(`transcription: error received ${error}`);
      });

      this.transcriptionService.on(
        TranscriptionEvents.WARNING,
        (warning: any) => {
          console.log(`transcription: warning received ${warning}`);
        },
      );

      this.transcriptionService.on(TranscriptionEvents.CONNECTED, async () => {
        console.log('deepgram: connected successfully');
      });
    } catch (error) {
      console.error('Error initializing Deepgram:', error);
      throw error;
    }
  }

  private initializeLLM(config: PluginConfig): void {
    // Use provided LLM service or create a new Grok service
    if (config?.llmService) {
      this.llmService = config.llmService;

      // Set the shared stream manager
      if (typeof this.llmService.setStreamManager === 'function') {
        this.llmService.setStreamManager(this.activeStreamManager);
      }
    } else {
      // Check for required Grok API key
      const grokApiKey =
        config?.grokApiKey ?? this.runtime.getSetting('GROK_API_KEY');
      const grokBaseUrl =
        config?.grokBaseUrl ??
        this.runtime.getSetting('GROK_BASE_URL') ??
        'https://api.x.ai/v1';

      if (isEmpty(grokApiKey)) {
        throw new Error('Grok API key is required');
      }

      // Create the Grok LLM service with the shared stream manager
      const llmConfig: GrokLLMConfig = {
        apiKey: grokApiKey,
        baseUrl: grokBaseUrl,
        model: 'grok-2-latest',
      };

      this.llmService = new GrokLLMService(llmConfig, this.activeStreamManager);
    }

    // Initialize the LLM service
    this.llmService.initialize().catch((err) => {
      elizaLogger.error(
        '[SttTtsPlugin] Failed to initialize LLM service:',
        err,
      );
    });

    // Set up LLM service event listeners
    this.llmService.on(LLMEvents.PROCESSING_START, (streamId, userId) => {
      elizaLogger.log(
        `[SttTtsPlugin] LLM processing started for stream ${streamId}, user ${userId}`,
      );
    });

    this.llmService.on(LLMEvents.PROCESSING_END, (streamId) => {
      elizaLogger.log(
        `[SttTtsPlugin] LLM processing ended for stream ${streamId}`,
      );
    });

    this.llmService.on(LLMEvents.PROCESSING_ERROR, (error, streamId) => {
      elizaLogger.error(
        `[SttTtsPlugin] LLM processing error for stream ${streamId}:`,
        error,
      );
    });

    this.llmService.on(LLMEvents.ACTION_DETECTED, (actionName, streamId) => {
      elizaLogger.log(
        `[SttTtsPlugin] LLM action detected in stream ${streamId}: ${actionName}`,
      );
      // Handle the action if needed
      this.handleLLMAction(actionName, streamId);
    });

    this.llmService.on(LLMEvents.CONTENT_COMPLETE, (fullContent, streamId) => {
      // Store the complete response in short-term memory
      const stream = this.activeStreamManager.get(streamId);
      if (stream) {
        this.shortTermMemory.addMessage(
          'assistant',
          fullContent,
          this.runtime.agentId ?? this.botProfile?.id,
        );
      }
    });
  }

  /**
   * Handle actions detected in the LLM output
   */
  private async handleLLMAction(
    actionName: string,
    streamId: string,
  ): Promise<void> {
    // Get the stream data
    const stream = this.activeStreamManager.get(streamId);
    if (!stream) return;

    // This would be expanded based on your specific action handling requirements
    const numericId = stream.userId.replace('tw-', '');
    const roomId = stringToUuid(`twitter_generate_room-${this.spaceId}`);
    const userUuid = stringToUuid(`twitter-user-${numericId}`);

    const memory = {
      id: stringToUuid(`${roomId}-voice-message-${Date.now()}`),
      agentId: this.runtime.agentId,
      content: { text: stream.message, source: 'twitter' },
      userId: userUuid,
      roomId,
      embedding: getEmbeddingZeroVector(),
      createdAt: Date.now(),
    };

    // Example of processing an action
    await this.runtime.processActions(
      memory,
      [memory],
      await this.runtime.composeState(
        {
          agentId: this.runtime.agentId,
          content: { text: stream.message, source: 'twitter' },
          userId: userUuid,
          roomId,
        },
        {
          twitterUserName: this.client.profile.username,
          agentName: this.runtime.character.name,
        },
      ),
      async (newMessages) => {
        if (newMessages) {
          elizaLogger.log(
            `[SttTtsPlugin] Action produced new messages: ${newMessages}`,
          );
        }
        return [memory];
      },
    );
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
    // Check if the bot is speaking and detect potential interruptions
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

    if (data.userId === this.botProfile?.id) {
      console.log('[SttTtsPlugin] Received audio data from bot, skipping');
      return;
    }

    // Update the last speaker
    this.lastSpeaker = data.userId;

    try {
      // Skip bot's audio to prevent feedback loops
      if (this.botProfile.id === data.userId) {
        return;
      }

      // Create a copy of the audio samples to avoid modifying the original data
      const audioSamples = new Int16Array(data.samples);

      if (energy > this.interruptionThreshold) {
        this.transcriptionMonitor.trackUserAudioActivity(data.userId);
      }

      this.transcriptionService.sendAudio(audioSamples);
    } catch (error) {
      console.error('Error sending audio to Deepgram:', error);
    }
  }

  /**
   * Process the buffered transcription for a user
   */
  private processBufferedTranscription(
    userId: string,
    transcript: string,
  ): void {
    const bufferedTranscript = transcript;

    // Process if there's content in the buffer
    if (isNotEmpty(bufferedTranscript?.trim())) {
      console.log(
        `[SttTtsPlugin] Processing buffered transcription: "${bufferedTranscript}"`,
      );
      this.processTranscription(userId, bufferedTranscript).catch((err) =>
        elizaLogger.error('[SttTtsPlugin] processTranscription error:', err),
      );
    }
  }

  /**
   * Stop the bot's speech when interrupted
   */
  private stopSpeaking(): void {
    if (this.ttsService) {
      this.ttsService.stopSpeaking();
    }
    elizaLogger.log('[SttTtsPlugin] Bot speech interrupted by user');
  }

  /**
   * Process final transcription for response
   */
  private async processTranscription(
    userId: string,
    transcript: string,
  ): Promise<void> {
    try {
      // If we're already processing, just queue this request and return
      if (this.isProcessingAudio) {
        console.log(
          '[SttTtsPlugin] Already processing audio, queueing this request',
        );
        return;
      }

      const transcriptLen = transcript?.trim()?.length ?? 0;
      // Check if the transcript is too short to be meaningful
      if (transcriptLen < 5) {
        console.log(
          '[SttTtsPlugin] Transcript too short, ignoring:',
          transcript,
        );
        return;
      }

      this.isProcessingAudio = true;

      // Generate a unique stream ID for this response
      const streamId = uuidv4();
      this.latestActiveStreamId = streamId;

      // Register with the active stream manager
      this.activeStreamManager.register({
        id: streamId,
        active: true,
        startedAt: Date.now(),
        userId: userId,
        message: transcript,
      });

      // Register the stream with the TTS service
      this.ttsService.registerStream(streamId);

      // Abort any previous streams
      this.abortPreviousStreams(streamId);

      // Check if we should ignore this message
      const shouldIgnore = await this.shouldIgnore(transcript);
      if (shouldIgnore) {
        this.isProcessingAudio = false;
        return;
      }

      // Prepare the chat context
      const previousMessages =
        this.activeStreamManager?.findAllByUserId(userId);

      // Get the Twitter space context
      const numericId = userId.replace('tw-', '');
      const roomId = stringToUuid(`twitter_generate_room-${this.spaceId}`);
      const userUuid = stringToUuid(`twitter-user-${numericId}`);

      const state = await this.runtime.composeState(
        {
          agentId: this.runtime.agentId,
          content: { text: transcript, source: 'twitter' },
          userId: userUuid,
          roomId,
        },
        {
          twitterUserName: this.client.profile.username,
          agentName: this.runtime.character.name,
        },
      );

      const context = composeContext({
        state,
        template: (options: { state: State }): string => {
          const template = twitterSpaceTemplate(
            options.state,
            previousMessages,
          );
          return template;
        },
      });

      // Add the user message to short-term memory
      this.shortTermMemory.addMessage('user', transcript, userId);

      // Prepare the chat history for the LLM
      const chatHistory: LLMChatMessage[] = [
        {
          role: 'system',
          content: context,
        },
        ...this.shortTermMemory.getChatContext().map((msg) => ({
          role: msg.role as 'system' | 'user' | 'assistant',
          content: msg.content,
        })),
      ];

      // Process the message through the LLM service
      await this.llmService.processMessage(
        transcript,
        userId,
        chatHistory,
        streamId,
      );
    } catch (error) {
      elizaLogger.error('[SttTtsPlugin] processTranscription error =>', error);
    } finally {
      // Reset the processing flag
      this.isProcessingAudio = false;
    }
  }

  /**
   * Abort any ongoing TTS and streaming processes
   */
  private abortPreviousStreams(streamId: string): void {
    // Let the TTS service handle aborting all other streams
    if (this.ttsService) {
      this.ttsService.abortAllExcept(streamId);
    }

    // Let the LLM service handle aborting its streams
    if (this.llmService) {
      this.llmService.abortAllExcept(streamId);
    }

    this.activeStreamManager.abortOthers(streamId);
    this.latestActiveStreamId = streamId;

    elizaLogger.log('[SttTtsPlugin] Previous streams aborted');
  }

  /**
   * Should Ignore - Determines if a message should be ignored
   */
  private async shouldIgnore(messageText: string): Promise<boolean> {
    const messageLen = messageText?.length ?? 0;
    if (messageLen < 3) {
      return true;
    }

    const loseInterestWords = [
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
        messageText?.toLowerCase()?.includes(word),
      )
    ) {
      return true;
    }

    const ignoreWords = ['k', 'ok', 'bye', 'lol', 'nm', 'uh'];
    if (
      messageText?.length < 8 &&
      ignoreWords.some((word) => messageText?.toLowerCase()?.includes(word))
    ) {
      return true;
    }

    return false;
  }

  /**
   * Public method to queue a TTS request for on-demand speaking
   * This is useful for sending audio messages programmatically
   * instead of in response to transcription
   */
  public async speakText(text: string): Promise<void> {
    if (isEmpty(text)) {
      return;
    }

    // Create a unique stream ID for this on-demand message
    const streamId = uuidv4();

    // Register the stream with both managers
    this.activeStreamManager.register({
      id: streamId,
      active: true,
      startedAt: Date.now(),
      userId: 'on-demand',
      message: text,
    });

    this.ttsService.registerStream(streamId);

    // Abort previous streams to ensure this one takes priority
    this.abortPreviousStreams(streamId);

    // Send the text to the TTS service
    elizaLogger.log(
      `[SttTtsPlugin] Speaking on-demand text with stream ${streamId}: "${text.substring(0, 30)}${text.length > 30 ? '...' : ''}"`,
    );
    await this.ttsService.speakText(text, streamId);
  }

  /**
   * Clear the chat context
   */
  public clearChatContext() {
    this.shortTermMemory?.clearChatContext();
    console.log('[SttTtsPlugin] clearChatContext => done');
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    this.transcriptionService.stop();
    this.clearChatContext();

    // Stop any ongoing speech and clean up TTS resources
    if (this.ttsService) {
      this.ttsService.cleanup();
    }

    // Clean up LLM resources
    if (this.llmService) {
      this.llmService.cleanup();
    }

    this.transcriptionMonitor.cleanup();
    this.activeStreamManager.cleanup();
    this.latestActiveStreamId = null;
    this.eventEmitter.removeAllListeners();
    elizaLogger.log('[SttTtsPlugin] Cleanup complete');
  }
}
