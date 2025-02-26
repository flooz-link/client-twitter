import * as _elizaos_core from '@elizaos/core';
import { Client } from '@elizaos/core';

declare const TwitterClientInterface: Client;

declare const twitterPlugin: {
    name: string;
    description: string;
    clients: _elizaos_core.Client[];
};

export { TwitterClientInterface, twitterPlugin as default };
