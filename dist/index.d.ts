import { Client, Plugin } from '@elizaos/core';
import { Space, AudioDataWithUser } from '@flooz-link/agent-twitter-client';

type TwitterClient = Client & {
    joinSpace(twitterManager: any, spaceId: string): Promise<void>;
};

declare const TwitterClientInterface: TwitterClient;

/**
 * Speech-to-text (Deepgram) + conversation + TTS (ElevenLabs)
 */
declare class SttTtsPlugin implements Plugin {
    name: string;
    description: string;
    private runtime;
    private client;
    private spaceId;
    private space?;
    private janus?;
    private isProcessingAudio;
    private activeStreamManager;
    private shortTermMemory;
    private eventEmitter;
    private lastSpeaker;
    private interruptionThreshold;
    private consecutiveFramesForInterruption;
    private interruptionCounter;
    private transcriptionService;
    private ttsService;
    private llmService;
    private botProfile;
    private transcriptionaBufferDuration;
    private transcriptionMonitor;
    init(params: {
        space: Space;
        pluginConfig?: Record<string, any>;
    }): void;
    private initializeTts;
    private initializeTranscription;
    private initializeLLM;
    /**
     * Handle actions detected in the LLM output
     */
    private handleLLMAction;
    /**
     * Calculate the energy of an audio frame
     */
    private calculateEnergy;
    /**
     * Called whenever we receive PCM from a speaker
     */
    onAudioData(data: AudioDataWithUser): void;
    /**
     * Process the buffered transcription for a user
     */
    private processBufferedTranscription;
    /**
     * Stop the bot's speech when interrupted
     */
    private stopSpeaking;
    /**
     * Process final transcription for response
     */
    private processTranscription;
    /**
     * Abort any ongoing TTS and streaming processes
     */
    private abortPreviousStreams;
    /**
     * Should Ignore - Determines if a message should be ignored
     */
    private shouldIgnore;
    /**
     * Public method to queue a TTS request for on-demand speaking
     * This is useful for sending audio messages programmatically
     * instead of in response to transcription
     */
    speakText(text: string): Promise<void>;
    /**
     * Clear the chat context
     */
    clearChatContext(): void;
    /**
     * Cleanup resources
     */
    cleanup(): void;
}

export { SttTtsPlugin, type TwitterClient, TwitterClientInterface, TwitterClientInterface as default };
