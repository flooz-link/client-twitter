import { Client, IAgentRuntime } from '@elizaos/core';
import { TwitterClientInterface as TwitterClientImpl } from './client';

// Define the interface
export interface TwitterClient extends Client {
  start(runtime: IAgentRuntime): Promise<any>;
}

// Export the implementation with the correct type
export const TwitterClientInterface: TwitterClient = TwitterClientImpl;

const twitterPlugin = {
  name: 'twitter',
  description: 'Twitter client',
  clients: [TwitterClientInterface] as TwitterClient[],
};

export default twitterPlugin;
