import OpenAI from 'openai';
import { elizaLogger } from '@elizaos/core';
import {
  BaseLLMService,
  BaseLLMConfig,
  LLMEvents,
  LLMChatMessage,
} from './baseLLMService';

/**
 * Grok implementation of the LLM service
 */
export class GrokLLMService extends BaseLLMService {
  private openai: OpenAI;

  /**
   * Constructor for GrokLLMService
   * @param config Configuration for the Grok service
   * @param streamManager Optional external stream manager
   */
  constructor(config: BaseLLMConfig, streamManager?: any) {
    super(
      {
        ...config,
        model: config.model || 'grok-2-latest',
        baseUrl: config.baseUrl || 'https://api.x.ai/v1',
      },
      streamManager,
    );
  }

  /**
   * Initialize the Grok service
   */
  public async initialize(): Promise<void> {
    try {
      this.openai = new OpenAI({
        apiKey: this.config.apiKey,
        baseURL: this.config.baseUrl,
      });

      elizaLogger.log('[GrokLLMService] Initialized successfully');
    } catch (error) {
      elizaLogger.error('[GrokLLMService] Initialization error:', error);
      throw error;
    }
  }

  /**
   * Process a user message through Grok and stream the response
   * @param userMessage The message from the user
   * @param userId The ID of the user
   * @param chatHistory Previous chat messages (optional)
   * @param streamId Optional ID for the stream, will be generated if not provided
   * @returns The ID of the stream that was created
   */
  public async processMessage(
    userMessage: string,
    userId: string,
    chatHistory: LLMChatMessage[] = [],
    streamId?: string,
  ): Promise<string> {
    // Validate the input
    if (!userMessage?.trim()) {
      throw new Error('User message is required');
    }

    // Generate or use provided stream ID
    const messageStreamId =
      streamId ||
      this.registerStream({
        id: streamId || crypto.randomUUID(),
        userId,
        message: userMessage,
      });

    // Emit the processing start event
    this.emit(LLMEvents.PROCESSING_START, messageStreamId, userId);

    try {
      // Create the messages array for the API call
      const messages = [
        // Add system message if configured
        ...(this.config.systemPrompt
          ? [
              {
                role: 'system' as const,
                content: this.config.systemPrompt,
              },
            ]
          : []),

        // Add chat history
        ...chatHistory,

        // Add the current user message
        {
          role: 'user' as const,
          content: userMessage,
        },
      ];

      // Create the stream
      const stream = await this.openai.chat.completions.create({
        model: this.config.model as string,
        messages,
        stream: true,
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
      });

      let fullResponse = '';
      let bufferedText = '';
      let potentialActionMarker = false;

      // Set up timing for natural speech pacing
      let lastEmitTime = Date.now();
      const minTimeBetweenEmits = 150; // ms
      const maxBufferTime = 500; // ms

      // Process the stream chunks
      for await (const chunk of stream) {
        // Check if the stream has been aborted
        if (!this.isStreamActive(messageStreamId)) {
          elizaLogger.log(
            '[GrokLLMService] Stream was aborted during processing, cancelling',
          );
          break;
        }

        const content = chunk.choices[0]?.delta?.content || '';
        if (!content) continue;

        fullResponse += content;

        // Check for action markers
        if (content.includes('actionIs:') || content.includes('```actionIs:')) {
          // If we find an action marker, extract only the text before it
          const parts = content.split(/(\`\`\`actionIs:|actionIs:)/);
          if (parts.length > 1) {
            // Send only the text before the marker to the handler
            const textBeforeAction = parts[0].trim();
            if (textBeforeAction) {
              this.handleContentChunk(textBeforeAction, messageStreamId);
            }

            // Extract and emit the action
            const actionName = this.extractAction(content, messageStreamId);
            if (actionName) {
              elizaLogger.log(
                `[GrokLLMService] Detected action: ${actionName}`,
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
              this.handleContentChunk(parts[1].trim(), messageStreamId);
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

          this.handleContentChunk(bufferedText, messageStreamId);
          bufferedText = '';
          lastEmitTime = Date.now();
        }
      }

      // Emit any remaining buffered text
      if (bufferedText.trim()) {
        this.handleContentChunk(bufferedText, messageStreamId);
      }

      // Emit the content complete event with the full response
      this.emit(LLMEvents.CONTENT_COMPLETE, fullResponse, messageStreamId);

      // Emit the processing end event
      this.emit(LLMEvents.PROCESSING_END, messageStreamId);

      return messageStreamId;
    } catch (error) {
      elizaLogger.error('[GrokLLMService] Error processing message:', error);
      this.emit(LLMEvents.PROCESSING_ERROR, error, messageStreamId);
      throw error;
    }
  }
}
