import { TwitterClientInterface } from './client';

export { TwitterClientInterface };

const twitterPlugin = {
  name: 'twitter',
  description: 'Twitter client',
  clients: [TwitterClientInterface],
};
export default twitterPlugin;
