import { EventEmitter } from 'events';
import type { Plugin } from '@elizaos/core';

// Create necessary types if not already imported
interface SpeakerInfo {
  userId: string;
  sessionUUID: string;
}

interface SpaceConfig {
  authToken: string;
  // Other config properties as needed
}

interface BroadcastCreated {
  success: boolean;
  // Other properties as needed
}

// Create a mock Space class that implements the required interface
export class MockSpace extends EventEmitter {
  // Make private properties public in our mock for easier testing
  public janusClient: any;
  public chatClient: any = null;
  public authToken: string = 'mock-auth-token';
  public broadcastInfo: any = { id: 'mock-broadcast' };
  public isInitialized: boolean = true;
  public plugins: Plugin[] = [];
  public speakers: SpeakerInfo[] = [];
  private debug: boolean = true;

  constructor(mockJanusClient: any) {
    super();

    // Store the mock Janus client
    this.janusClient = mockJanusClient;

    console.log('MockSpace: Initialized with mock Janus client');
  }

  // Public methods from the Space class
  use(plugin: Plugin, config?: Record<string, any>): this {
    this.plugins.push(plugin);
    console.log(`MockSpace: Plugin ${plugin.name || 'unnamed'} registered`);
    return this;
  }

  async initialize(config: SpaceConfig): Promise<BroadcastCreated> {
    this.authToken = config.authToken;
    this.isInitialized = true;
    console.log('MockSpace: initialize called');
    return { success: true };
  }

  reactWithEmoji(emoji: string): void {
    console.log(`MockSpace: reactWithEmoji called with: ${emoji}`);
  }

  async approveSpeaker(userId: string, sessionUUID: string): Promise<void> {
    this.speakers.push({ userId, sessionUUID });
    console.log(`MockSpace: approveSpeaker called for user: ${userId}`);
  }

  async removeSpeaker(userId: string): Promise<void> {
    this.speakers = this.speakers.filter((s) => s.userId !== userId);
    console.log(`MockSpace: removeSpeaker called for user: ${userId}`);
  }

  pushAudio(samples: Int16Array, sampleRate: number): void {
    if (this.janusClient) {
      this.janusClient.pushLocalAudio(samples, sampleRate);
      console.log(
        `MockSpace: pushAudio called with ${samples.length} samples at ${sampleRate}Hz`,
      );
    }
  }

  async finalizeSpace(): Promise<void> {
    console.log('MockSpace: finalizeSpace called');
  }

  getSpeakers(): SpeakerInfo[] {
    return this.speakers;
  }

  async muteHost(): Promise<void> {
    console.log('MockSpace: muteHost called');
  }

  async unmuteHost(): Promise<void> {
    console.log('MockSpace: unmuteHost called');
  }

  async muteSpeaker(userId: string): Promise<void> {
    console.log(`MockSpace: muteSpeaker called for user: ${userId}`);
  }

  async unmuteSpeaker(userId: string): Promise<void> {
    console.log(`MockSpace: unmuteSpeaker called for user: ${userId}`);
  }

  async stop(): Promise<void> {
    await this.finalizeSpace();
    console.log('MockSpace: stop called');
  }

  // Private methods (made public for mocking)
  setupChatEvents(): void {
    console.log('MockSpace: setupChatEvents called');
  }

  async callApproveEndpoint(
    userId: string,
    sessionUUID: string,
  ): Promise<void> {
    console.log(`MockSpace: callApproveEndpoint for user: ${userId}`);
  }

  async callRemoveEndpoint(userId: string): Promise<void> {
    console.log(`MockSpace: callRemoveEndpoint for user: ${userId}`);
  }

  handleAudioData(data: any): void {
    // Forward to plugins if needed
    this.plugins.forEach((plugin) => {
      if ('onAudioData' in plugin) {
        (plugin as any).onAudioData(data);
      }
    });
    console.log(
      `MockSpace: handleAudioData called with ${data.samples?.length || 0} samples`,
    );
  }

  async endAudiospace(): Promise<void> {
    console.log('MockSpace: endAudiospace called');
  }
}
