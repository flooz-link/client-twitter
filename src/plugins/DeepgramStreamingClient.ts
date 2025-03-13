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
import OpenAI from 'openai';
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
  private grokApiKey?: string;
  private grokBaseUrl = 'https://api.x.ai/v1';

  private isProcessingAudio = false;
  private latestActiveStreamId: string | null = null;
  private activeStreamManager = new ActiveStreamManager();
  private shortTermMemory = new ShortTermMemory();
  private eventEmitter = new EventEmitter();
  private openai: OpenAI;
  private lastSpeaker: string | null = null;

  private interruptionThreshold = 3000; // Energy threshold for detecting speech (configurable)
  private consecutiveFramesForInterruption = 5; // Number of consecutive frames to confirm interruption (e.g., 5 frames of 10ms each)
  private interruptionCounter = 0; // Counter for consecutive high-energy frames

  private transcriptionService: BaseTranscriptionService;
  private ttsService: BaseTTSService;

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

    if (config?.transcriptionService) {
      this.transcriptionService = config?.transcriptionService;
    }

    this.runtime = config?.runtime;
    this.client = config?.client;
    this.spaceId = config?.spaceId;

    // Initialize the TTS service
    if (config?.ttsService) {
      this.ttsService = config.ttsService;
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

    // Initialize services
    this.initializeTranscription();
    this.initializeTts();
  }

  private initializeTts(): void {
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

  private initializeTranscription(): void {
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

      // Create named handler functions for this specific stream
      const handleChunkForStream = (text: string, chunkStreamId: string) => {
        // Only process chunks for the current stream
        if (this.activeStreamManager.isActive(streamId)) {
          this.bufferTextForTTS(text, streamId, userId);
        } else {
          console.log(
            `[SttTtsPlugin] Ignoring chunk from different stream. Expected: ${streamId}, Got: ${chunkStreamId}`,
          );
        }
      };

      const handleStreamEnd = (endStreamId?: string) => {
        // Only clean up if this is our stream
        if (!endStreamId || !this.activeStreamManager.isActive(endStreamId)) {
          console.log(
            `[SttTtsPlugin] Ignoring stream-end from outdated stream`,
          );
          return;
        }

        console.log(`[SttTtsPlugin] Stream ended for user: ${userId}`);

        // Only remove listeners specific to this stream
        this.eventEmitter.removeListener('stream-chunk', handleChunkForStream);
        this.eventEmitter.removeListener('stream-end', handleStreamEnd);
      };

      // Attach event listeners for this stream
      this.eventEmitter.on('stream-chunk', handleChunkForStream);
      this.eventEmitter.once('stream-end', handleStreamEnd);

      // Start the streaming response from Grok
      await this.handleUserMessageStreaming(transcript, userId, streamId);
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
        elizaLogger.error(
          '[SttTtsPlugin] processTranscription error =>',
          error,
        );
      }
    } finally {
      // Reset the processing flag
      this.isProcessingAudio = false;
    }
  }

  /**
   * Handle User Message with streaming support
   */
  private async handleUserMessageStreaming(
    userText: string,
    userId: string,
    streamId: string,
  ): Promise<void> {
    // Create a new stream ID if one doesn't exist
    if (!this.latestActiveStreamId) {
      elizaLogger.log(
        `[SttTtsPlugin] Creating new stream ID: ${streamId} as none exists`,
      );
      this.latestActiveStreamId = streamId;
      const foundStream = this.activeStreamManager.get(streamId);

      if (!foundStream) {
        this.activeStreamManager.register({
          id: streamId,
          active: true,
          startedAt: Date.now(),
          userId: userId,
          message: userText,
        });
      }
    }

    // Check again here as we add the new stream above
    const foundStream = this.activeStreamManager.get(streamId);

    elizaLogger.log(
      `[SttTtsPlugin] Handling user message with stream ID: ${streamId}`,
    );

    const numericId = userId.replace('tw-', '');
    const roomId = stringToUuid(`twitter_generate_room-${this.spaceId}`);
    const userUuid = stringToUuid(`twitter-user-${numericId}`);

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
      this.runtime
        .ensureUserExists(
          userUuid,
          userId,
          `Twitter User ${numericId}`,
          'twitter',
        )
        .catch((error) => {
          console.warn(`Error when ensureUserExists, error: ${error} ignoring`);
          return;
        }),
      this.runtime.ensureRoomExists(roomId).catch((error) => {
        console.warn(`Error when ensureRoomExists, error: ${error} ignoring`);
        return;
      }),
      this.runtime.ensureParticipantInRoom(userUuid, roomId).catch((error) => {
        console.warn(
          `Error when ensureParticipantInRoom, error: ${error} ignoring`,
        );
        return;
      }),
    ]);

    const shouldIgnore = await this._shouldIgnore(memory);
    if (shouldIgnore) {
      return;
    }
    const previousMessages = this.activeStreamManager?.findAllByUserId(userId);

    const context = composeContext({
      state,
      template: (options: { state: State }): string => {
        const template = twitterSpaceTemplate(options.state, previousMessages);
        return template;
      },
    });

    const systemMessage: ChatInteraction = {
      role: 'system' as const,
      content: context,
      startedAt: Date.now(),
      userId: this.runtime.agentId ?? this.botProfile?.id,
    };
    const userMessage: ChatInteraction = {
      role: 'user' as const,
      content: userText,
      startedAt: Date.now(),
      userId: userId,
    };
    const messages = [
      ...this.shortTermMemory?.getChatContext(),
      systemMessage,
      userMessage,
    ];

    if (
      !(foundStream?.active ?? false) ||
      !this.ttsService.isStreamActive(streamId)
    ) {
      elizaLogger.log(
        '[SttTtsPlugin] Stream was aborted before API call, cancelling',
      );
      this.eventEmitter.emit('stream-end', streamId);
      return;
    }

    try {
      const stream = await this.openai.chat.completions.create({
        model: 'grok-2-latest',
        messages,
        stream: true,
      });

      let fullResponse = '';
      let bufferedText = '';
      let potentialActionMarker = false;
      let detectedAction = '';

      // Set up a timer to ensure we emit text at regular intervals for a more natural speech pattern
      let lastEmitTime = Date.now();
      const minTimeBetweenEmits = 150; // ms - adjust for desired natural pacing
      const maxBufferTime = 500; // ms - maximum time to hold text before emitting

      for await (const chunk of stream) {
        const foundStream = this.activeStreamManager.get(streamId);

        if (
          foundStream?.active === false ||
          !this.ttsService.isStreamActive(streamId)
        ) {
          console.log(
            '[SttTtsPlugin] Stream was aborted during processing, cancelling',
          );
          break;
        }

        const content = chunk.choices[0]?.delta?.content || '';

        if (!content) {
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
              console.log(
                '[SttTtsPlugin] Emitting chunk with text before action:',
                textBeforeAction,
              );
              this.eventEmitter.emit(
                'stream-chunk',
                textBeforeAction,
                streamId,
              );
            }

            // Extract the action name
            const actionMatch = /actionIs:([A-Z_]+)/.exec(content);
            if (actionMatch) {
              detectedAction = actionMatch[1];
              console.log(`[SttTtsPlugin] Detected action: ${detectedAction}`);
              await this.runtime.processActions(
                memory,
                [memory],
                state,
                async (newMessages) => {
                  if (newMessages) {
                    console.log(
                      `[SttTtsPlugin] Emitting chunk with action response: ${newMessages}`,
                    );
                  }
                  return [memory];
                },
              );
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
              console.log(
                '[SttTtsPlugin] Emitting chunk with text after action:',
                parts[1].trim(),
              );
              this.eventEmitter.emit('stream-chunk', parts[1].trim(), streamId);
              lastEmitTime = Date.now();
            }
          }
          // Skip content that's part of an action block
          continue;
        }

        // Normal text content - buffer it and emit when appropriate
        bufferedText += content;

        // Determine if we should emit based on natural breaks or timing
        const hasNaturalBreak =
          /[.!?]\s*$/.test(bufferedText) || // Ends with punctuation
          /\n\s*$/.test(bufferedText) || // Ends with newline
          /[:;]\s*$/.test(bufferedText); // Ends with colon or semicolon

        const currentTime = Date.now();
        const timeSinceLastEmit = currentTime - lastEmitTime;
        const shouldEmitBasedOnTime = timeSinceLastEmit >= maxBufferTime;
        const hasEnoughText = bufferedText.length >= 15; // Minimum characters to emit

        // Emit text if we have a natural break point or if enough time has passed
        if ((hasNaturalBreak && hasEnoughText) || shouldEmitBasedOnTime) {
          // If we're emitting too quickly, add a small delay for more natural pacing
          if (timeSinceLastEmit < minTimeBetweenEmits) {
            await new Promise((resolve) =>
              setTimeout(resolve, minTimeBetweenEmits - timeSinceLastEmit),
            );
          }

          this.eventEmitter.emit('stream-chunk', bufferedText, streamId);
          bufferedText = '';
          lastEmitTime = Date.now();
        }
      }

      // Emit any remaining buffered text
      if (bufferedText.trim()) {
        console.log(
          '[SttTtsPlugin] Emitting final buffered text:',
          bufferedText,
        );
        this.eventEmitter.emit('stream-chunk', bufferedText, streamId);
      }

      // Add the complete message to our conversation history
      this.shortTermMemory.addMessage('user', userText, userId);
      this.shortTermMemory.addMessage(
        'assistant',
        fullResponse,
        this.runtime.agentId ?? this.botProfile?.id,
      );

      // Signal that the stream has ended
      this.eventEmitter.emit('stream-end', streamId);
    } catch (error) {
      elizaLogger.error(
        `[SttTtsPlugin] Error processing stream: ${error.message}`,
        error,
      );
      // Ensure we clean up even if there's an error
      this.eventEmitter.emit('stream-end', streamId);
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

    this.activeStreamManager.abortOthers(streamId);
    this.latestActiveStreamId = streamId;

    // Don't remove all listeners as it could affect other parts of the system
    // Instead, we'll manage listeners for specific streams in their respective handlers
    elizaLogger.log('[SttTtsPlugin] Previous streams aborted');
  }

  /**
   * Buffer text for TTS and delegate to the TTS service
   */
  private bufferTextForTTS(
    text: string,
    streamId: string,
    userId: string,
  ): void {
    if (isEmpty(text)) {
      return;
    }

    const foundStream = this.activeStreamManager.get(streamId);
    // Enhanced stream ID handling
    if (foundStream?.active === false) {
      return;
    }

    // Try to recover by creating a new stream ID if needed
    if (!this.latestActiveStreamId) {
      elizaLogger.warn(
        '[SttTtsPlugin] No current stream ID found, creating a new one',
      );
      const newStreamId = uuidv4();
      this.latestActiveStreamId = newStreamId;
      this.activeStreamManager.register({
        id: newStreamId,
        active: true,
        startedAt: Date.now(),
        userId: userId,
        message: text,
      });

      // Register with the TTS service
      this.ttsService.registerStream(newStreamId);

      // Continue with the new stream ID
      streamId = newStreamId;
    } else if (!this.activeStreamManager.has(streamId)) {
      elizaLogger.warn(
        `[SttTtsPlugin] Stream ID ${streamId} is no longer active, attempting to re-use current stream ID`,
      );
      // Use the current stream ID instead if it exists
      if (this.activeStreamManager.has(this.latestActiveStreamId)) {
        streamId = this.latestActiveStreamId;
      } else {
        // If current stream ID is also inactive, create a new one
        elizaLogger.warn(
          `[SttTtsPlugin] Current stream ID ${this.latestActiveStreamId} is also inactive, creating a new one`,
        );
        const newStreamId = uuidv4();
        this.latestActiveStreamId = newStreamId;
        this.activeStreamManager.register({
          id: newStreamId,
          active: true,
          startedAt: Date.now(),
          userId: userId,
          message: text,
        });

        // Register with the TTS service
        this.ttsService.registerStream(newStreamId);

        streamId = newStreamId;
      }
    }

    // Delegate text buffering to the TTS service
    if (this.ttsService) {
      this.ttsService.bufferTextForTTS(text, streamId);
    }
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
   * Should Ignore
   */
  private async _shouldIgnore(message: Memory): Promise<boolean> {
    const messageStr = message?.content?.text;
    const messageLen = messageStr?.length ?? 0;
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

    this.transcriptionMonitor.cleanup();
    this.activeStreamManager.cleanup();
    this.latestActiveStreamId = null;
    this.eventEmitter.removeAllListeners();
    elizaLogger.log('[SttTtsPlugin] Cleanup complete');
  }
}
