import { Client, TwitterSpaceDecisionOptions } from '@elizaos/core';

export type MediaData = {
  data: Buffer;
  mediaType: string;
};

export type TwitterClient = Client & {
  joinSpace(twitterManager: any, spaceId: string): Promise<void>;
};

export interface BusinessHourDefinition {
  openingHour: number;
  closingHour: number;
  timezone: string;
}

export interface FloozTwitterSpaceDecisionOptions
  extends TwitterSpaceDecisionOptions {
  speakerApprovalWaitTime?: number;
  businessHourDefinition?: BusinessHourDefinition;
  silenceDetectionWindow?: number;
}
