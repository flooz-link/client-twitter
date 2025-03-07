import {
  elizaLogger,
  type IAgentRuntime,
  generateText,
  ModelClass,
  ServiceType,
  type ITranscriptionService,
} from '@elizaos/core';
import type { ClientBase } from './base';
import {
  type Scraper,
  Space,
  // @ts-ignore
  type SpaceConfig,
  RecordToDiskPlugin,
  IdleMonitorPlugin,
  // @ts-ignore
  type SpeakerRequest,
} from '@flooz-link/agent-twitter-client';
import { SttTtsPlugin } from './plugins/SttTtsSpacesPlugin.ts';
import { SpaceParticipant } from '@flooz-link/agent-twitter-client';
import { isEmpty, isNotEmpty } from './utils.ts';
import { FloozTwitterSpaceDecisionOptions } from './types.ts';

interface CurrentSpeakerState {
  userId: string;
  sessionUUID: string;
  username: string;
  startTime: number;
}

/**
 * Generate short filler text via GPT
 */
async function generateFiller(
  runtime: IAgentRuntime,
  fillerType: string,
): Promise<string> {
  try {
    const context = `
    # INSTRUCTIONS:
  You are generating a short filler message for a Twitter Space. The filler type is "${fillerType}".
  Keep it brief, friendly, and relevant. No more than two sentences.
  Only return the text, no additional formatting.

  ---`;
    const output = await generateText({
      runtime,
      context,
      modelClass: ModelClass.SMALL,
    });
    return output.trim();
  } catch (err) {
    elizaLogger.error('[generateFiller] Error generating filler:', err);
    return '';
  }
}

/**
 * Speak a filler message if STT/TTS plugin is available. Sleep a bit after TTS to avoid cutoff.
 */
async function speakFiller(
  runtime: IAgentRuntime,
  sttTtsPlugin: SttTtsPlugin | undefined,
  fillerType: string,
  sleepAfterMs = 3000,
): Promise<void> {
  if (!sttTtsPlugin) return;
  const text = await generateFiller(runtime, fillerType);
  if (!text) return;

  elizaLogger.log(`[Space] Filler (${fillerType}) => ${text}`);
  await sttTtsPlugin.speakText(text);

  if (sleepAfterMs > 0) {
    await new Promise((res) => setTimeout(res, sleepAfterMs));
  }
}

/**
 * Generate topic suggestions via GPT if no topics are configured
 */
async function generateTopicsIfEmpty(
  runtime: IAgentRuntime,
): Promise<string[]> {
  try {
    const context = `# INSTRUCTIONS:
Please generate 5 short topic ideas for a Twitter Space about technology or random interesting subjects.
Return them as a comma-separated list, no additional formatting or numbering.

Example:
"AI Advances, Futuristic Gadgets, Space Exploration, Quantum Computing, Digital Ethics"
---
`;
    const response = await generateText({
      runtime,
      context,
      modelClass: ModelClass.SMALL,
    });
    const topics = response
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    return topics.length ? topics : ['Random Tech Chat', 'AI Thoughts'];
  } catch (err) {
    elizaLogger.error('[generateTopicsIfEmpty] GPT error =>', err);
    return ['Random Tech Chat', 'AI Thoughts'];
  }
}

/**
 * Main class: manage a Twitter Space with N speakers max, speaker queue, filler messages, etc.
 */
export class TwitterSpaceClient {
  private runtime: IAgentRuntime;
  private client: ClientBase;
  private scraper: Scraper;
  private isSpaceRunning = false;
  private currentSpace?: Space;
  private spaceId?: string;
  private startedAt?: number;
  private checkInterval?: NodeJS.Timeout;
  private lastSpaceEndedAt?: number;
  private sttTtsPlugin?: SttTtsPlugin;

  /**
   * We now store an array of active speakers, not just 1
   */
  private activeSpeakers: CurrentSpeakerState[] = [];
  private speakerQueue: SpeakerRequest[] = [];

  private decisionOptions: FloozTwitterSpaceDecisionOptions;

  constructor(client: ClientBase, runtime: IAgentRuntime) {
    this.client = client;
    this.scraper = client.twitterClient;
    this.runtime = runtime;

    const charSpaces: FloozTwitterSpaceDecisionOptions =
      runtime.character.twitterSpaces || {};
    this.decisionOptions = {
      maxSpeakers: charSpaces.maxSpeakers ?? 1,
      topics: charSpaces.topics ?? [],
      typicalDurationMinutes: charSpaces.typicalDurationMinutes ?? 30,
      idleKickTimeoutMs: charSpaces.idleKickTimeoutMs ?? 5 * 60_000,
      minIntervalBetweenSpacesMinutes:
        charSpaces.minIntervalBetweenSpacesMinutes ?? 60,
      businessHoursOnly: charSpaces.businessHoursOnly ?? false,
      randomChance: charSpaces.randomChance ?? 0.3,
      enableIdleMonitor: charSpaces.enableIdleMonitor !== false,
      enableSttTts: charSpaces.enableSttTts !== false,
      enableRecording: charSpaces.enableRecording !== false,
      voiceId:
        charSpaces.voiceId ||
        runtime.character.settings.voice.model ||
        'Xb7hH8MSUJpSbSDYk0k2',
      sttLanguage: charSpaces.sttLanguage || 'en',
      speakerMaxDurationMs: charSpaces.speakerMaxDurationMs ?? 4 * 60_000,
      silenceThreshold: charSpaces.silenceThreshold,
      silenceDetectionWindow: charSpaces.silenceDetectionWindow,
    };
  }

  async joinSpace(spaceId: string) {
    this.spaceId = spaceId;
    this.isSpaceRunning = true;
    elizaLogger.log('[Space] Joining a new Twitter Space...');

    try {
      // this.currentSpace = new Space(this.scraper);
      this.startedAt = Date.now();

      // Reset states
      this.activeSpeakers = [];
      this.speakerQueue = [];

      // Retrieve keys
      const elevenLabsKey =
        this.runtime.getSetting('ELEVENLABS_XI_API_KEY') || '';

      const participant = new SpaceParticipant(this.scraper, {
        spaceId: this.spaceId,
        debug: false,
      });

      // 3) Join the Space in listener mode
      await participant.joinAsListener();
      console.log('[TestParticipant] HLS URL =>', participant.getHlsUrl());

      // 4) Request the speaker role => returns { sessionUUID }
      const { sessionUUID } = await participant.requestSpeaker();
      console.log('[TestParticipant] Requested speaker =>', sessionUUID);

      // 5) Wait for host acceptance with a maximum wait time (e.g., 15 seconds).
      try {
        try {
          await this.waitForApproval(
            participant,
            sessionUUID,
            isNotEmpty(this.decisionOptions?.speakerApprovalWaitTime)
              ? this.decisionOptions.speakerApprovalWaitTime
              : 15000,
          );
        } catch (error) {
          elizaLogger.warn(`Speaker request was not approved, error ${error}`);
          await participant.cancelSpeakerRequest();
          throw error;
        }

        // Plugins
        if (this.decisionOptions.enableRecording) {
          elizaLogger.log('[Space] Using RecordToDiskPlugin');
          const recordToDisk = new RecordToDiskPlugin();
          recordToDisk.init({
            space: participant,
          });
          participant.use(recordToDisk);
        }

        if (this.decisionOptions.enableSttTts) {
          elizaLogger.log('[Space] Using SttTtsPlugin');
          const sttTts = new SttTtsPlugin();
          sttTts.init({
            space: participant as unknown as Space,
            pluginConfig: {
              runtime: this.runtime,
              client: this.client,
              spaceId: this.spaceId,
              elevenLabsApiKey: elevenLabsKey,
              voiceId: this.decisionOptions.voiceId,
              sttLanguage: this.decisionOptions.sttLanguage,
              transcriptionService:
                this.client.runtime.getService<ITranscriptionService>(
                  ServiceType.TRANSCRIPTION,
                ),
              silenceThreshold: this.decisionOptions.silenceThreshold,
              silenceDetectionWindow:
                this.decisionOptions?.silenceDetectionWindow ?? 400,
            },
          });
          this.sttTtsPlugin = sttTts;
          participant.use(sttTts, {
            runtime: this.runtime,
            client: this.client,
            spaceId: this.spaceId,
            elevenLabsApiKey: elevenLabsKey,
            voiceId: this.decisionOptions.voiceId,
            sttLanguage: this.decisionOptions.sttLanguage,
            transcriptionService: this.client.runtime.getService(
              ServiceType.TRANSCRIPTION,
            ),
            silenceThreshold: this.decisionOptions.silenceThreshold,
          });
        }

        if (this.decisionOptions.enableIdleMonitor) {
          elizaLogger.log('[Space] Using IdleMonitorPlugin');
          participant.use(
            new IdleMonitorPlugin(
              this.decisionOptions.idleKickTimeoutMs ?? 60_000,
              10_000,
            ),
          );
        }

        this.isSpaceRunning = true;
        // await this.scraper.sendTweet(
        //   broadcastInfo.share_url.replace('broadcasts', 'spaces'),
        // );

        // const spaceUrl = broadcastInfo.share_url.replace(
        //   'broadcasts',
        //   'spaces',
        // );
        // elizaLogger.log(`[Space] Space started => ${spaceUrl}`);

        // Greet
        await speakFiller(this.client.runtime, this.sttTtsPlugin, 'WELCOME');

        // Events

        participant.on('idleTimeout', async (info) => {
          elizaLogger.log(
            `[Space] idleTimeout => no audio for ${info.idleMs} ms.`,
          );
          await speakFiller(
            this.client.runtime,
            this.sttTtsPlugin,
            'IDLE_ENDING',
          );
          await this.stopSpace();
        });

        participant.on('error', (error) => {
          elizaLogger.error(`Error on client connection ${error}`);
        });

        process.on('SIGINT', async () => {
          elizaLogger.log('[Space] SIGINT => stopping space');
          await speakFiller(this.client.runtime, this.sttTtsPlugin, 'CLOSING');
          await this.stopSpace();
          process.exit(0);
        });
      } catch (error) {
        elizaLogger.error('[Space] Error launching Space =>', error);
        this.isSpaceRunning = false;
        throw error;
      }
    } catch (error) {
      throw error;
    }
  }

  /**
   * waitForApproval waits until "newSpeakerAccepted" matches our sessionUUID,
   * then calls becomeSpeaker() or rejects after a given timeout.
   */
  private async waitForApproval(
    participant: SpaceParticipant,
    sessionUUID: string,
    timeoutMs = 10000,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let resolved = false;

      const handler = async (evt: { sessionUUID: string }) => {
        if (evt.sessionUUID === sessionUUID) {
          resolved = true;
          participant.off('newSpeakerAccepted', handler);
          try {
            await participant.becomeSpeaker();
            console.log('[TestParticipant] Successfully became speaker!');
            resolve();
          } catch (err) {
            reject(err);
          }
        }
      };

      // Listen to "newSpeakerAccepted" from participant
      participant.on('newSpeakerAccepted', handler);

      // Timeout to reject if not approved in time
      setTimeout(() => {
        if (!resolved) {
          participant.off('newSpeakerAccepted', handler);
          reject(
            new Error(
              `[TestParticipant] Timed out waiting for speaker approval after ${timeoutMs}ms.`,
            ),
          );
        }
      }, timeoutMs);
    });
  }

  /**
   * Periodic check to launch or manage space
   */
  public async startPeriodicSpaceCheck() {
    elizaLogger.log('[Space] Starting periodic check routine...');

    // For instance:
    const intervalMsWhenIdle = 5 * 60_000; // 5 minutes if no Space is running
    const intervalMsWhenRunning = 5_000; // 5 seconds if a Space IS running

    const routine = async () => {
      try {
        if (!this.isSpaceRunning) {
          const launch = await this.shouldLaunchSpace();
          if (launch) {
            const config = await this.generateSpaceConfig();
            await this.startSpace(config);
          }
          // Plan next iteration with a slower pace
          this.checkInterval = setTimeout(
            routine,
            this.isSpaceRunning ? intervalMsWhenRunning : intervalMsWhenIdle,
          );
        } else {
          // Space is running => manage it more frequently
          await this.manageCurrentSpace();
          // Plan next iteration with a faster pace
          this.checkInterval = setTimeout(routine, intervalMsWhenRunning);
        }
      } catch (error) {
        elizaLogger.error('[Space] Error in routine =>', error);
        // In case of error, still schedule next iteration
        this.checkInterval = setTimeout(routine, intervalMsWhenIdle);
      }
    };

    routine();
  }

  stopPeriodicCheck() {
    if (this.checkInterval) {
      clearTimeout(this.checkInterval);
      this.checkInterval = undefined;
    }
  }

  private async shouldLaunchSpace(): Promise<boolean> {
    // Random chance
    const r = Math.random();
    if (r > (this.decisionOptions.randomChance ?? 0.3)) {
      elizaLogger.log('[Space] Random check => skip launching');
      return false;
    }
    // Business hours
    if (this.decisionOptions.businessHoursOnly) {
      const hour = new Date().getUTCHours();
      if (hour < 9 || hour >= 17) {
        elizaLogger.log('[Space] Out of business hours => skip');
        return false;
      }
    }
    // Interval
    const now = Date.now();
    if (this.lastSpaceEndedAt) {
      const minIntervalMs =
        (this.decisionOptions.minIntervalBetweenSpacesMinutes ?? 60) * 60_000;
      if (now - this.lastSpaceEndedAt < minIntervalMs) {
        elizaLogger.log('[Space] Too soon since last space => skip');
        return false;
      }
    }

    elizaLogger.log('[Space] Deciding to launch a new Space...');
    return true;
  }

  private async generateSpaceConfig(): Promise<SpaceConfig> {
    const topicsLen = this.decisionOptions?.topics?.length ?? 0;
    if (topicsLen === 0) {
      const newTopics = await generateTopicsIfEmpty(this.client?.runtime);
      this.decisionOptions.topics = newTopics;
    }

    let chosenTopic = 'Random Tech Chat';
    if (topicsLen > 0) {
      chosenTopic =
        this.decisionOptions.topics[Math.floor(Math.random() * topicsLen)];
    }

    return {
      mode: 'INTERACTIVE',
      title: chosenTopic,
      description: `Discussion about ${chosenTopic}`,
      languages: ['en'],
    };
  }

  public async startSpace(config: SpaceConfig) {
    elizaLogger.log('[Space] Starting a new Twitter Space...');

    try {
      this.currentSpace = new Space(this.scraper);
      this.isSpaceRunning = false;
      this.spaceId = undefined;
      this.startedAt = Date.now();

      // Reset states
      this.activeSpeakers = [];
      this.speakerQueue = [];

      // Retrieve keys
      const elevenLabsKey =
        this.runtime.getSetting('ELEVENLABS_XI_API_KEY') || '';

      const broadcastInfo = await this.currentSpace.initialize(config);
      this.spaceId = broadcastInfo.room_id;
      // Plugins
      if (this.decisionOptions.enableRecording) {
        elizaLogger.log('[Space] Using RecordToDiskPlugin');
        this.currentSpace.use(new RecordToDiskPlugin());
      }

      if (this.decisionOptions.enableSttTts) {
        elizaLogger.log('[Space] Using SttTtsPlugin');
        const sttTts = new SttTtsPlugin();
        this.sttTtsPlugin = sttTts;
        this.currentSpace.use(sttTts, {
          runtime: this.runtime,
          client: this.client,
          spaceId: this.spaceId,
          elevenLabsApiKey: elevenLabsKey,
          voiceId: this.decisionOptions.voiceId,
          sttLanguage: this.decisionOptions.sttLanguage,
          transcriptionService:
            this.client.runtime.getService<ITranscriptionService>(
              ServiceType.TRANSCRIPTION,
            ),
        });
      }

      if (this.decisionOptions.enableIdleMonitor) {
        elizaLogger.log('[Space] Using IdleMonitorPlugin');
        this.currentSpace.use(
          new IdleMonitorPlugin(
            this.decisionOptions.idleKickTimeoutMs ?? 60_000,
            10_000,
          ),
        );
      }

      this.isSpaceRunning = true;
      await this.scraper.sendTweet(
        broadcastInfo.share_url.replace('broadcasts', 'spaces'),
      );

      const spaceUrl = broadcastInfo.share_url.replace('broadcasts', 'spaces');
      elizaLogger.log(`[Space] Space started => ${spaceUrl}`);

      // Greet
      await speakFiller(this.client.runtime, this.sttTtsPlugin, 'WELCOME');

      // Events
      this.currentSpace.on('occupancyUpdate', (update) => {
        elizaLogger.log(
          `[Space] Occupancy => ${update.occupancy} participant(s).`,
        );
      });

      this.currentSpace.on('speakerRequest', async (req: SpeakerRequest) => {
        elizaLogger.log(
          `[Space] Speaker request from @${req.username} (${req.userId}).`,
        );
        await this.handleSpeakerRequest(req);
      });

      this.currentSpace.on('idleTimeout', async (info) => {
        elizaLogger.log(
          `[Space] idleTimeout => no audio for ${info.idleMs} ms.`,
        );
        await speakFiller(
          this.client.runtime,
          this.sttTtsPlugin,
          'IDLE_ENDING',
        );
        await this.stopSpace();
      });

      process.on('SIGINT', async () => {
        elizaLogger.log('[Space] SIGINT => stopping space');
        await speakFiller(this.client.runtime, this.sttTtsPlugin, 'CLOSING');
        await this.stopSpace();
        process.exit(0);
      });
    } catch (error) {
      elizaLogger.error('[Space] Error launching Space =>', error);
      this.isSpaceRunning = false;
      throw error;
    }
  }

  /**
   * Periodic management: check durations, remove extras, maybe accept new from queue
   */
  private async manageCurrentSpace() {
    if (!this.spaceId || !this.currentSpace) {
      return;
    }
    try {
      const audioSpace = await this.scraper.getAudioSpaceById(this.spaceId);
      const { participants } = audioSpace;
      const numSpeakers = participants.speakers?.length || 0;
      const totalListeners = participants.listeners?.length || 0;

      const activeSpeakerLen = this?.activeSpeakers?.length ?? 0;
      if (activeSpeakerLen === 0) {
        elizaLogger.log(
          `No active speakers to manage, hence nothing to manage, returning`,
        );
        return;
      }
      // 1) Remove any speaker who exceeded speakerMaxDurationMs
      const maxDur = this.decisionOptions?.speakerMaxDurationMs ?? 240_000;
      const now = Date.now();

      for (let i = this.activeSpeakers.length - 1; i >= 0; i--) {
        const speaker = this.activeSpeakers[i];
        const elapsed = now - (speaker?.startTime ?? now);
        if (elapsed > maxDur) {
          elizaLogger.log(
            `[Space] Speaker @${speaker?.username} exceeded max duration => removing`,
          );
          if (isNotEmpty(speaker?.userId)) {
            await this.removeSpeaker(speaker?.userId);
            this.activeSpeakers.splice(i, 1);
            // Possibly speak a short "SPEAKER_LEFT" filler
            await speakFiller(
              this.client.runtime,
              this.sttTtsPlugin,
              'SPEAKER_LEFT',
            );
          }
        }
      }

      // 2) If we have capacity for new speakers from the queue, accept them
      await this.acceptSpeakersFromQueueIfNeeded();

      // 3) If somehow more than maxSpeakers are active, remove the extras
      if (numSpeakers > (this.decisionOptions.maxSpeakers ?? 1)) {
        elizaLogger.log('[Space] More than maxSpeakers => removing extras...');
        await this.kickExtraSpeakers(participants.speakers);
      }

      // 4) Possibly stop the space if empty or time exceeded
      const elapsedMinutes = (now - (this.startedAt || 0)) / 60000;
      if (
        elapsedMinutes > (this.decisionOptions.typicalDurationMinutes ?? 30) ||
        (numSpeakers === 0 && totalListeners === 0 && elapsedMinutes > 5)
      ) {
        elizaLogger.log('[Space] Condition met => stopping the Space...');
        await speakFiller(
          this.client.runtime,
          this.sttTtsPlugin,
          'CLOSING',
          4000,
        );
        await this.stopSpace();
      }
    } catch (error) {
      elizaLogger.error('[Space] Error in manageCurrentSpace =>', error);
    }
  }

  /**
   * If we have available slots, accept new speakers from the queue
   */
  private async acceptSpeakersFromQueueIfNeeded() {
    // while queue not empty and activeSpeakers < maxSpeakers, accept next
    const maxNumberOfSpeakersConfigured =
      this?.decisionOptions?.maxSpeakers ?? 1;
    const speakerQueueLen = this.speakerQueue?.length ?? 0;
    const activeSpeakerLen = this.activeSpeakers?.length ?? 0;
    while (
      speakerQueueLen > 0 &&
      activeSpeakerLen < maxNumberOfSpeakersConfigured
    ) {
      const nextReq = this.speakerQueue.shift();
      if (nextReq) {
        await speakFiller(this.client.runtime, this.sttTtsPlugin, 'PRE_ACCEPT');
        await this.acceptSpeaker(nextReq);
      }
    }
  }

  private async handleSpeakerRequest(req: SpeakerRequest) {
    if (isEmpty(this.spaceId) || isEmpty(this.currentSpace)) {
      return;
    }

    const audioSpace = await this.scraper.getAudioSpaceById(this.spaceId);
    const janusSpeakers = audioSpace?.participants?.speakers || [];

    const maxSpeakersConfiguredLen = this.decisionOptions?.maxSpeakers ?? 1;
    // If we haven't reached maxSpeakers, accept immediately
    if (janusSpeakers.length < maxSpeakersConfiguredLen) {
      elizaLogger.log(`[Space] Accepting speaker @${req.username} now`);
      await speakFiller(this.client.runtime, this.sttTtsPlugin, 'PRE_ACCEPT');
      await this.acceptSpeaker(req);
    } else {
      elizaLogger.log(`[Space] Adding speaker @${req.username} to the queue`);
      this.speakerQueue.push(req);
    }
  }

  private async acceptSpeaker(req: SpeakerRequest) {
    if (isEmpty(this.currentSpace)) {
      return;
    }
    try {
      await this.currentSpace?.approveSpeaker(req.userId, req.sessionUUID);
      this.activeSpeakers.push({
        userId: req.userId,
        sessionUUID: req.sessionUUID,
        username: req.username,
        startTime: Date.now(),
      });
      elizaLogger.log(`[Space] Speaker @${req.username} is now live`);
    } catch (err) {
      elizaLogger.error(
        `[Space] Error approving speaker @${req.username}:`,
        err,
      );
    }
  }

  private async removeSpeaker(userId?: string) {
    if (isEmpty(this.currentSpace)) {
      return;
    }
    if (isEmpty(userId)) {
      return;
    }
    try {
      await this.currentSpace.removeSpeaker(userId);
      elizaLogger.log(`[Space] Removed speaker userId=${userId}`);
    } catch (error) {
      elizaLogger.error(
        `[Space] Error removing speaker userId=${userId} =>`,
        error,
      );
    }
  }

  /**
   * If more than maxSpeakers are found, remove extras
   * Also update activeSpeakers array
   */
  private async kickExtraSpeakers(speakers: any[]) {
    if (isEmpty(this.currentSpace)) {
      return;
    }
    const speakersLen = speakers?.length ?? 0;
    if (speakersLen === 0) {
      return;
    }
    const ms = this.decisionOptions?.maxSpeakers ?? 1;

    // sort by who joined first if needed, or just slice
    const extras = speakers?.slice(ms) ?? [];
    for (const sp of extras) {
      elizaLogger.log(`[Space] Removing extra speaker => userId=${sp.user_id}`);
      await this.removeSpeaker(sp.user_id);

      // remove from activeSpeakers array
      const idx = this.activeSpeakers.findIndex((s) => s.userId === sp.user_id);
      if (idx !== -1) {
        this.activeSpeakers.splice(idx, 1);
      }
    }
  }

  public async stopSpace() {
    if (isEmpty(this.currentSpace) || isEmpty(this.isSpaceRunning)) {
      return;
    }
    try {
      elizaLogger.log('[Space] Stopping the current Space...');
      await this.currentSpace?.stop();
    } catch (err) {
      elizaLogger.error('[Space] Error stopping Space =>', err);
    } finally {
      this.isSpaceRunning = false;
      this.spaceId = undefined;
      this.currentSpace = undefined;
      this.startedAt = undefined;
      this.lastSpaceEndedAt = Date.now();
      this.activeSpeakers = [];
      this.speakerQueue = [];
    }
  }
}
