import { Client } from '@elizaos/core';

type TwitterClient = Client & {
    joinSpace(twitterManager: any, spaceId: string): Promise<void>;
};

declare const TwitterClientInterface: TwitterClient;

export { type TwitterClient, TwitterClientInterface, TwitterClientInterface as default };
