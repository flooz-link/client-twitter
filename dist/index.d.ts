import { ActionTimelineType, IAgentRuntime, IImageDescriptionService, Memory, State, UUID, Client } from '@elizaos/core';
import { Scraper, Tweet, SearchMode, QueryTweetsResponse, SpaceConfig } from 'agent-twitter-client';
import { EventEmitter } from 'events';
import { z } from 'zod';

/**
 * This schema defines all required/optional environment settings,
 * including new fields like TWITTER_SPACES_ENABLE.
 */
declare const twitterEnvSchema: z.ZodObject<{
    TWITTER_DRY_RUN: z.ZodBoolean;
    TWITTER_USERNAME: z.ZodString;
    TWITTER_PASSWORD: z.ZodString;
    TWITTER_EMAIL: z.ZodString;
    MAX_TWEET_LENGTH: z.ZodDefault<z.ZodNumber>;
    TWITTER_SEARCH_ENABLE: z.ZodDefault<z.ZodBoolean>;
    TWITTER_2FA_SECRET: z.ZodString;
    TWITTER_RETRY_LIMIT: z.ZodNumber;
    TWITTER_POLL_INTERVAL: z.ZodNumber;
    TWITTER_TARGET_USERS: z.ZodDefault<z.ZodArray<z.ZodEffects<z.ZodString, string, string>, "many">>;
    ENABLE_TWITTER_POST_GENERATION: z.ZodBoolean;
    POST_INTERVAL_MIN: z.ZodNumber;
    POST_INTERVAL_MAX: z.ZodNumber;
    ENABLE_ACTION_PROCESSING: z.ZodBoolean;
    ACTION_INTERVAL: z.ZodNumber;
    POST_IMMEDIATELY: z.ZodBoolean;
    TWITTER_SPACES_ENABLE: z.ZodDefault<z.ZodBoolean>;
    MAX_ACTIONS_PROCESSING: z.ZodNumber;
    ACTION_TIMELINE_TYPE: z.ZodDefault<z.ZodNativeEnum<typeof ActionTimelineType>>;
}, "strip", z.ZodTypeAny, {
    TWITTER_DRY_RUN?: boolean;
    TWITTER_USERNAME?: string;
    TWITTER_PASSWORD?: string;
    TWITTER_EMAIL?: string;
    MAX_TWEET_LENGTH?: number;
    TWITTER_SEARCH_ENABLE?: boolean;
    TWITTER_2FA_SECRET?: string;
    TWITTER_RETRY_LIMIT?: number;
    TWITTER_POLL_INTERVAL?: number;
    TWITTER_TARGET_USERS?: string[];
    ENABLE_TWITTER_POST_GENERATION?: boolean;
    POST_INTERVAL_MIN?: number;
    POST_INTERVAL_MAX?: number;
    ENABLE_ACTION_PROCESSING?: boolean;
    ACTION_INTERVAL?: number;
    POST_IMMEDIATELY?: boolean;
    TWITTER_SPACES_ENABLE?: boolean;
    MAX_ACTIONS_PROCESSING?: number;
    ACTION_TIMELINE_TYPE?: ActionTimelineType;
}, {
    TWITTER_DRY_RUN?: boolean;
    TWITTER_USERNAME?: string;
    TWITTER_PASSWORD?: string;
    TWITTER_EMAIL?: string;
    MAX_TWEET_LENGTH?: number;
    TWITTER_SEARCH_ENABLE?: boolean;
    TWITTER_2FA_SECRET?: string;
    TWITTER_RETRY_LIMIT?: number;
    TWITTER_POLL_INTERVAL?: number;
    TWITTER_TARGET_USERS?: string[];
    ENABLE_TWITTER_POST_GENERATION?: boolean;
    POST_INTERVAL_MIN?: number;
    POST_INTERVAL_MAX?: number;
    ENABLE_ACTION_PROCESSING?: boolean;
    ACTION_INTERVAL?: number;
    POST_IMMEDIATELY?: boolean;
    TWITTER_SPACES_ENABLE?: boolean;
    MAX_ACTIONS_PROCESSING?: number;
    ACTION_TIMELINE_TYPE?: ActionTimelineType;
}>;
type TwitterConfig = z.infer<typeof twitterEnvSchema>;

type TwitterProfile = {
    id: string;
    username: string;
    screenName: string;
    bio: string;
    nicknames: string[];
};
declare class RequestQueue {
    private queue;
    private processing;
    add<T>(request: () => Promise<T>): Promise<T>;
    private processQueue;
    private exponentialBackoff;
    private randomDelay;
}
declare class ClientBase extends EventEmitter {
    static _twitterClients: {
        [accountIdentifier: string]: Scraper;
    };
    twitterClient: Scraper;
    runtime: IAgentRuntime;
    twitterConfig: TwitterConfig;
    directions: string;
    lastCheckedTweetId: bigint | null;
    imageDescriptionService: IImageDescriptionService;
    temperature: number;
    requestQueue: RequestQueue;
    profile: TwitterProfile | null;
    cacheTweet(tweet: Tweet): Promise<void>;
    getCachedTweet(tweetId: string): Promise<Tweet | undefined>;
    getTweet(tweetId: string): Promise<Tweet>;
    callback: (self: ClientBase) => any;
    onReady(): void;
    /**
     * Parse the raw tweet data into a standardized Tweet object.
     */
    private parseTweet;
    constructor(runtime: IAgentRuntime, twitterConfig: TwitterConfig);
    init(): Promise<void>;
    fetchOwnPosts(count: number): Promise<Tweet[]>;
    /**
     * Fetch timeline for twitter account, optionally only from followed accounts
     */
    fetchHomeTimeline(count: number, following?: boolean): Promise<Tweet[]>;
    fetchTimelineForActions(count: number): Promise<Tweet[]>;
    fetchSearchTweets(query: string, maxTweets: number, searchMode: SearchMode, cursor?: string): Promise<QueryTweetsResponse>;
    private populateTimeline;
    setCookiesFromArray(cookiesArray: any[]): Promise<void>;
    saveRequestMessage(message: Memory, state: State): Promise<void>;
    loadLatestCheckedTweetId(): Promise<void>;
    cacheLatestCheckedTweetId(): Promise<void>;
    getCachedTimeline(): Promise<Tweet[] | undefined>;
    cacheTimeline(timeline: Tweet[]): Promise<void>;
    cacheMentions(mentions: Tweet[]): Promise<void>;
    getCachedCookies(username: string): Promise<any[]>;
    cacheCookies(username: string, cookies: any[]): Promise<void>;
    fetchProfile(username: string): Promise<TwitterProfile>;
}

declare class TwitterInteractionClient {
    client: ClientBase;
    runtime: IAgentRuntime;
    private isDryRun;
    constructor(client: ClientBase, runtime: IAgentRuntime);
    start(): Promise<void>;
    handleTwitterInteractions(): Promise<void>;
    private handleTweet;
    buildConversationThread(tweet: Tweet, maxReplies?: number): Promise<Tweet[]>;
}

type MediaData = {
    data: Buffer;
    mediaType: string;
};

declare class TwitterPostClient {
    client: ClientBase;
    runtime: IAgentRuntime;
    twitterUsername: string;
    private isProcessing;
    private lastProcessTime;
    private stopProcessingActions;
    private isDryRun;
    private discordClientForApproval;
    private approvalRequired;
    private discordApprovalChannelId;
    private approvalCheckInterval;
    constructor(client: ClientBase, runtime: IAgentRuntime);
    private setupDiscordClient;
    start(): Promise<void>;
    private runPendingTweetCheckLoop;
    createTweetObject(tweetResult: any, client: any, twitterUsername: string): Tweet;
    processAndCacheTweet(runtime: IAgentRuntime, client: ClientBase, tweet: Tweet, roomId: UUID, rawTweetContent: string): Promise<void>;
    handleNoteTweet(client: ClientBase, content: string, tweetId?: string, mediaData?: MediaData[]): Promise<any>;
    sendStandardTweet(client: ClientBase, content: string, tweetId?: string, mediaData?: MediaData[]): Promise<any>;
    postTweet(runtime: IAgentRuntime, client: ClientBase, tweetTextForPosting: string, roomId: UUID, rawTweetContent: string, twitterUsername: string, mediaData?: MediaData[]): Promise<void>;
    /**
     * Generates and posts a new tweet. If isDryRun is true, only logs what would have been posted.
     */
    generateNewTweet(): Promise<void>;
    private generateTweetContent;
    /**
     * Processes tweet actions (likes, retweets, quotes, replies). If isDryRun is true,
     * only simulates and logs actions without making API calls.
     */
    private processTweetActions;
    /**
     * Processes a list of timelines by executing the corresponding tweet actions.
     * Each timeline includes the tweet, action response, tweet state, and room context.
     * Results are returned for tracking completed actions.
     *
     * @param timelines - Array of objects containing tweet details, action responses, and state information.
     * @returns A promise that resolves to an array of results with details of executed actions.
     */
    private processTimelineActions;
    /**
     * Handles text-only replies to tweets. If isDryRun is true, only logs what would
     * have been replied without making API calls.
     */
    private handleTextOnlyReply;
    stop(): Promise<void>;
    private sendForApproval;
    private checkApprovalStatus;
    private cleanupPendingTweet;
    private handlePendingTweet;
}

declare class TwitterSearchClient {
    client: ClientBase;
    runtime: IAgentRuntime;
    twitterUsername: string;
    private respondedTweets;
    constructor(client: ClientBase, runtime: IAgentRuntime);
    start(): Promise<void>;
    private engageWithSearchTermsLoop;
    private engageWithSearchTerms;
}

/**
 * Main class: manage a Twitter Space with N speakers max, speaker queue, filler messages, etc.
 */
declare class TwitterSpaceClient {
    private runtime;
    private client;
    private scraper;
    private isSpaceRunning;
    private currentSpace?;
    private spaceId?;
    private startedAt?;
    private checkInterval?;
    private lastSpaceEndedAt?;
    private sttTtsPlugin?;
    /**
     * We now store an array of active speakers, not just 1
     */
    private activeSpeakers;
    private speakerQueue;
    private decisionOptions;
    constructor(client: ClientBase, runtime: IAgentRuntime);
    joinSpace(spaceId: string): Promise<void>;
    /**
     * Check if bot is in a Space, and update spaceId if found
     */
    private checkBotInSpace;
    /**
     * Periodic check to launch or manage space
     */
    startPeriodicSpaceCheck(): Promise<void>;
    stopPeriodicCheck(): void;
    private shouldLaunchSpace;
    private generateSpaceConfig;
    startSpace(config: SpaceConfig): Promise<void>;
    /**
     * Periodic management: check durations, remove extras, maybe accept new from queue
     */
    private manageCurrentSpace;
    /**
     * If we have available slots, accept new speakers from the queue
     */
    private acceptSpeakersFromQueueIfNeeded;
    private handleSpeakerRequest;
    private acceptSpeaker;
    private removeSpeaker;
    /**
     * If more than maxSpeakers are found, remove extras
     * Also update activeSpeakers array
     */
    private kickExtraSpeakers;
    stopSpace(): Promise<void>;
}

type TwitterClient = Client & {
    joinSpace(twitterManager: TwitterManager, spaceId: string): Promise<void>;
};
/**
 * A manager that orchestrates all specialized Twitter logic:
 * - client: base operations (login, timeline caching, etc.)
 * - post: autonomous posting logic
 * - search: searching tweets / replying logic
 * - interaction: handling mentions, replies
 * - space: launching and managing Twitter Spaces (optional)
 */
declare class TwitterManager {
    client: ClientBase;
    post: TwitterPostClient;
    search: TwitterSearchClient;
    interaction: TwitterInteractionClient;
    space?: TwitterSpaceClient;
    constructor(runtime: IAgentRuntime, twitterConfig: TwitterConfig);
    stop(): Promise<void>;
}
declare const TwitterClientInterface: TwitterClient;

export { type TwitterClient, TwitterClientInterface, TwitterClientInterface as default };
