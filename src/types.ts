import { Client } from '@elizaos/core';

export type MediaData = {
  data: Buffer;
  mediaType: string;
};

export type TwitterClient = Client & {
  joinSpace(twitterManager: any, spaceId: string): Promise<void>;
};
