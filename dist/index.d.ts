import { Client, IAgentRuntime } from '@elizaos/core';

interface TwitterClient extends Client {
    start(runtime: IAgentRuntime): Promise<any>;
}
declare const TwitterClientInterface: TwitterClient;
declare const twitterPlugin: {
    name: string;
    description: string;
    clients: TwitterClient[];
};

export { type TwitterClient, TwitterClientInterface, twitterPlugin as default };
