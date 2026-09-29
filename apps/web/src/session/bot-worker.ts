import { BotHost, serveBotHost } from '@cp2p/bots';

// One dedicated worker per bot host: it runs every bot that host plays, keyed by seat. It receives
// only bot views (public state plus the bot seat's own private state), checked on arrival.
serveBotHost(self, new BotHost());
